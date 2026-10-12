import {
  createDomainEvent,
  idempotencyKeySchema,
  saleCreateRequestSchema,
  saleListQuerySchema,
} from "@onecore/core-domain";
import { getRequestContext, type RuntimeConfig } from "@onecore/config";
import {
  createSale,
  cancelSale,
  getSale,
  InsufficientStockError,
  listSales,
  recordOutboxEvent,
  writeAuthorizationMutationEvent,
  type AuthorizationContext,
  type AuthorizationService,
  type ResolvedAuthorizationContext,
} from "@onecore/database";
import { z } from "zod";
import { validateMutationOrigin } from "./authentication.js";
import type { ApiFastifyInstance } from "./fastify-instance.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() }).strict();
const salePathSchema = organizationPathSchema
  .extend({ saleId: z.uuid() })
  .strict();
const createPermission = "core.sales.sale.create";
const readPermission = "core.sales.sale.read";
const cancelPermissions = [
  "core.sales.sale.cancel",
  "core.inventory.stock.release",
] as const;
const createPermissions = [
  createPermission,
  "core.inventory.stock.reserve",
] as const;

interface OperationResponse {
  statusCode: number;
  body: unknown;
}

function requestContext(request: {
  auth: AuthorizationContext | null;
}): AuthorizationContext | null {
  return request.auth;
}

function operationResponse(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } };
}

function send(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  result: OperationResponse,
) {
  return reply.status(result.statusCode).send(result.body);
}

function unauthorized(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  statusCode: 401 | 403,
) {
  return reply.status(statusCode).send({
    error: {
      code: statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
      message:
        statusCode === 401
          ? "Authentication is required."
          : "The request is not authorized.",
    },
  });
}

function notFound(): OperationResponse {
  return operationResponse(
    404,
    "NOT_FOUND",
    "The requested resource was not found.",
  );
}

function invalid(): OperationResponse {
  return operationResponse(
    400,
    "BAD_REQUEST",
    "The request could not be processed.",
  );
}

function conflict(): OperationResponse {
  return operationResponse(
    409,
    "CONFLICT",
    "The idempotency key was already used for a different request.",
  );
}

function saleView(sale: NonNullable<Awaited<ReturnType<typeof getSale>>>) {
  return {
    id: sale.id,
    organizationId: sale.organizationId,
    branchId: sale.branchId,
    status: sale.status,
    currency: sale.currency,
    subtotal: sale.subtotal,
    total: sale.total,
    createdByUserId: sale.createdByUserId,
    createdAt: sale.createdAt,
    lines: sale.lines,
  };
}

async function recordSaleCreated(
  transaction: Parameters<AuthorizationService["withPermission"]>[3] extends (
    transaction: infer T,
    context: ResolvedAuthorizationContext,
  ) => Promise<unknown>
    ? T
    : never,
  context: ResolvedAuthorizationContext,
  requestId: string,
  saleId: string,
  lineCount: number,
): Promise<void> {
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType: "SALE_CREATED",
      organizationId: context.organizationId,
      ...(context.branchId ? { branchId: context.branchId } : {}),
      actorUserId: context.userId,
      correlationId: getRequestContext()?.correlationId ?? requestId,
      aggregateType: "sale",
      aggregateId: saleId,
      payload: { saleId, lineCount },
      metadata: { requestId },
    }),
  );
  await writeAuthorizationMutationEvent(
    transaction,
    context,
    { requestId },
    "SALE_CREATED",
    "sale",
    saleId,
    { lineCount, status: "OPEN" },
  );
}

export function registerSalesRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService,
  config: RuntimeConfig,
): void {
  const salesPath = "/organizations/:organizationId/sales";

  app.post(salesPath, async (request, reply) => {
    if (!validateMutationOrigin(request, reply, config)) return;
    const path = organizationPathSchema.safeParse(request.params);
    const input = saleCreateRequestSchema.safeParse(request.body);
    const key = idempotencyKeySchema.safeParse(
      request.headers["idempotency-key"],
    );
    if (!path.success || !input.success || !key.success) {
      return send(reply, invalid());
    }

    let result;
    try {
      result = await authorization.withAllPermissions(
        requestContext(request),
        createPermissions,
        { requestId: request.id },
        async (transaction, context) => {
          if (path.data.organizationId !== context.organizationId) {
            return notFound();
          }
          if (!context.branchId) {
            return operationResponse(
              403,
              "FORBIDDEN",
              "An authorized active branch is required.",
            );
          }
          const created = await createSale(
            transaction,
            context,
            input.data,
            key.data,
            request.id,
          );
          switch (created.outcome) {
            case "FORBIDDEN":
              return operationResponse(
                403,
                "FORBIDDEN",
                "The request is not authorized.",
              );
            case "CATALOG_ITEM_UNAVAILABLE":
            case "CURRENCY_MISMATCH":
              return invalid();
            case "IDEMPOTENCY_CONFLICT":
              return conflict();
            case "CREATED":
              await recordSaleCreated(
                transaction,
                context,
                request.id,
                created.sale.id,
                created.sale.lines.length,
              );
              return {
                statusCode: 201,
                body: { sale: saleView(created.sale) },
              };
            case "EXISTING":
              return {
                statusCode: 201,
                body: { sale: saleView(created.sale) },
              };
          }
        },
      );
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        return send(
          reply,
          operationResponse(
            409,
            "INSUFFICIENT_STOCK",
            "One or more products do not have enough available stock at this branch.",
          ),
        );
      }
      throw error;
    }
    if (!result.allowed) return unauthorized(reply, result.statusCode);
    return send(reply, result.value);
  });

  app.get(salesPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const query = saleListQuerySchema.safeParse(request.query);
    if (!path.success || !query.success) return send(reply, invalid());
    const result = await authorization.withPermission(
      requestContext(request),
      readPermission,
      { requestId: request.id },
      async (transaction, context) => {
        if (path.data.organizationId !== context.organizationId)
          return notFound();
        if (!context.branchId) {
          return operationResponse(
            403,
            "FORBIDDEN",
            "An authorized active branch is required.",
          );
        }
        const page = await listSales(transaction, context, query.data);
        if (!page)
          return operationResponse(
            403,
            "FORBIDDEN",
            "The request is not authorized.",
          );
        return {
          statusCode: 200,
          body: {
            items: page.items.map((sale) => ({
              id: sale.id,
              organizationId: sale.organizationId,
              branchId: sale.branchId,
              status: sale.status,
              currency: sale.currency,
              subtotal: sale.subtotal,
              total: sale.total,
              createdByUserId: sale.createdByUserId,
              createdAt: sale.createdAt,
            })),
            total: page.total,
            limit: query.data.limit,
            offset: query.data.offset,
          },
        };
      },
    );
    if (!result.allowed) return unauthorized(reply, result.statusCode);
    return send(reply, result.value);
  });

  app.get(`${salesPath}/:saleId`, async (request, reply) => {
    const path = salePathSchema.safeParse(request.params);
    if (!path.success) return send(reply, invalid());
    const result = await authorization.withPermission(
      requestContext(request),
      readPermission,
      { requestId: request.id },
      async (transaction, context) => {
        if (path.data.organizationId !== context.organizationId)
          return notFound();
        if (!context.branchId) {
          return operationResponse(
            403,
            "FORBIDDEN",
            "An authorized active branch is required.",
          );
        }
        const sale = await getSale(transaction, context, path.data.saleId);
        return sale
          ? { statusCode: 200, body: { sale: saleView(sale) } }
          : notFound();
      },
    );
    if (!result.allowed) return unauthorized(reply, result.statusCode);
    return send(reply, result.value);
  });

  app.post(`${salesPath}/:saleId/cancel`, async (request, reply) => {
    if (!validateMutationOrigin(request, reply, config)) return;
    const path = salePathSchema.safeParse(request.params);
    if (!path.success) return send(reply, invalid());
    const result = await authorization.withAllPermissions(
      requestContext(request),
      cancelPermissions,
      { requestId: request.id },
      async (transaction, context) => {
        if (path.data.organizationId !== context.organizationId)
          return notFound();
        if (!context.branchId) {
          return operationResponse(
            403,
            "FORBIDDEN",
            "An authorized active branch is required.",
          );
        }
        const cancelled = await cancelSale(
          transaction,
          context,
          path.data.saleId,
          request.id,
        );
        if (!("sale" in cancelled)) {
          return cancelled.outcome === "FORBIDDEN"
            ? operationResponse(
                403,
                "FORBIDDEN",
                "The request is not authorized.",
              )
            : notFound();
        }
        return {
          statusCode: 200,
          body: {
            sale: saleView(cancelled.sale),
            idempotent: cancelled.outcome === "EXISTING",
          },
        };
      },
    );
    if (!result.allowed) return unauthorized(reply, result.statusCode);
    return send(reply, result.value);
  });
}
