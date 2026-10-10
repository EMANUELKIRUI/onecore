import {
  inventoryAdjustmentInputSchema,
  inventoryStockQuerySchema,
  idempotencyKeySchema,
} from "@onecore/core-domain";
import type { RuntimeConfig } from "@onecore/config";
import {
  adjustBranchStock,
  listBranchStock,
  type AuthorizationContext,
  type AuthorizationService,
} from "@onecore/database";
import { z } from "zod";
import { validateMutationOrigin } from "./authentication.js";
import type { ApiFastifyInstance } from "./fastify-instance.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() }).strict();
const inventoryReadPermissions = [
  "core.inventory.stock.read",
  "core.business_manager.catalog.read",
] as const;
const inventoryAdjustPermission = "core.inventory.stock.adjust";

function requestContext(request: { auth: AuthorizationContext | null }) {
  return request.auth;
}

function response(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } };
}

function send(
  reply: { status: (statusCode: number) => { send: (body: unknown) => unknown } },
  result: { statusCode: number; body: unknown },
) {
  return reply.status(result.statusCode).send(result.body);
}

function denied(reply: Parameters<typeof send>[0], statusCode: 401 | 403) {
  return send(
    reply,
    response(
      statusCode,
      statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
      statusCode === 401
        ? "Authentication is required."
        : "The request is not authorized.",
    ),
  );
}

export function registerInventoryRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService,
  config: RuntimeConfig,
): void {
  const stockPath = "/organizations/:organizationId/inventory/stock";

  app.get(stockPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const query = inventoryStockQuerySchema.safeParse(request.query);
    if (!path.success || !query.success) {
      return send(reply, response(400, "BAD_REQUEST", "Invalid stock query."));
    }
    const result = await authorization.withAllPermissions(
      requestContext(request),
      inventoryReadPermissions,
      { requestId: request.id },
      async (transaction, context) => {
        if (path.data.organizationId !== context.organizationId) {
          return response(404, "NOT_FOUND", "The requested resource was not found.");
        }
        if (!context.branchId) {
          return response(403, "FORBIDDEN", "An authorized active branch is required.");
        }
        const items = await listBranchStock(transaction, context, query.data);
        if (!items) return response(403, "FORBIDDEN", "The request is not authorized.");
        return { statusCode: 200, body: { items, branchId: context.branchId } };
      },
    );
    if (!result.allowed) return denied(reply, result.statusCode);
    return send(reply, result.value);
  });

  app.post(stockPath, async (request, reply) => {
    if (!validateMutationOrigin(request, reply, config)) return;
    const path = organizationPathSchema.safeParse(request.params);
    const input = inventoryAdjustmentInputSchema.safeParse(request.body);
    const key = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
    if (!path.success || !input.success || !key.success) {
      return send(reply, response(400, "BAD_REQUEST", "Invalid stock movement request."));
    }
    const result = await authorization.withPermission(
      requestContext(request),
      inventoryAdjustPermission,
      { requestId: request.id },
      async (transaction, context) => {
        if (path.data.organizationId !== context.organizationId) {
          return response(404, "NOT_FOUND", "The requested resource was not found.");
        }
        if (!context.branchId) {
          return response(403, "FORBIDDEN", "An authorized active branch is required.");
        }
        const adjustment = await adjustBranchStock(
          transaction,
          context,
          input.data,
          key.data,
          request.id,
        );
        switch (adjustment.outcome) {
          case "FORBIDDEN":
            return response(403, "FORBIDDEN", "The request is not authorized.");
          case "CATALOG_ITEM_UNAVAILABLE":
            return response(404, "NOT_FOUND", "The requested resource was not found.");
          case "INSUFFICIENT_STOCK":
            return response(409, "INSUFFICIENT_STOCK", "Stock cannot be reduced below active reservations.");
          case "IDEMPOTENCY_CONFLICT":
            return response(409, "CONFLICT", "The idempotency key was used for a different stock movement.");
          case "CREATED":
          case "EXISTING":
            return {
              statusCode: adjustment.outcome === "CREATED" ? 201 : 200,
              body: { movementId: adjustment.movementId, stock: adjustment.stock },
            };
        }
      },
    );
    if (!result.allowed) return denied(reply, result.statusCode);
    return send(reply, result.value);
  });
}
