import {
  cancelSale,
  checkoutSale,
  getSale,
  listSaleCatalogItems,
  listSales,
  recordSaleRefund,
  SalesOperationError,
  type AuthorizationContext,
  type AuthorizationService,
  type ResolvedAuthorizationContext,
} from "@onecore/database";
import {
  saleCancellationInputSchema,
  saleCheckoutInputSchema,
  saleListQuerySchema,
  saleRefundInputSchema,
} from "@onecore/core-domain";
import { z } from "zod";
import type { ApiFastifyInstance } from "./fastify-instance.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() }).strict();
const resourcePathSchema = organizationPathSchema
  .extend({ saleId: z.uuid() })
  .strict();

interface OperationResponse {
  statusCode: number;
  body: unknown;
}

function requestContext(request: {
  auth: AuthorizationContext | null;
}): AuthorizationContext | null {
  return request.auth;
}

function response(statusCode: number, code: string, message: string) {
  return {
    statusCode,
    body: { error: { code, message } },
  };
}

function notFound(): OperationResponse {
  return response(404, "NOT_FOUND", "The requested resource was not found.");
}

function forbidden(): OperationResponse {
  return response(403, "FORBIDDEN", "The request is not authorized.");
}

function invalid(): OperationResponse {
  return response(400, "BAD_REQUEST", "The request could not be processed.");
}

function send(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  result: OperationResponse,
) {
  return reply.status(result.statusCode).send(result.body);
}

function targetMatches(
  organizationId: string,
  context: ResolvedAuthorizationContext,
): boolean {
  return organizationId === context.organizationId;
}

function lineItemView(item: {
  id: string;
  saleId: string;
  catalogItemId: string;
  itemReference: string | null;
  itemName: string;
  itemType: string;
  unit: string;
  quantity: number;
  unitPrice: string;
  lineSubtotal: string;
  createdAt: Date;
}) {
  return {
    id: item.id,
    saleId: item.saleId,
    catalogItemId: item.catalogItemId,
    itemReference: item.itemReference,
    itemName: item.itemName,
    itemType: item.itemType,
    unit: item.unit,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    lineSubtotal: item.lineSubtotal,
    createdAt: item.createdAt,
  };
}

function saleView(sale: {
  id: string;
  organizationId: string;
  branchId: string;
  saleNumber: string;
  customerId: string | null;
  cashierUserId: string;
  currency: string;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: sale.id,
    organizationId: sale.organizationId,
    branchId: sale.branchId,
    saleNumber: sale.saleNumber,
    customerId: sale.customerId,
    cashierUserId: sale.cashierUserId,
    currency: sale.currency,
    subtotal: sale.subtotal,
    discount: sale.discount,
    tax: sale.tax,
    total: sale.total,
    status: sale.status,
    createdAt: sale.createdAt,
    updatedAt: sale.updatedAt,
  };
}

function refundView(refund: {
  id: string;
  organizationId: string;
  branchId: string;
  saleId: string;
  idempotencyKey: string;
  amount: string;
  reason: string;
  recordedByUserId: string;
  createdAt: Date;
}) {
  return {
    id: refund.id,
    organizationId: refund.organizationId,
    branchId: refund.branchId,
    saleId: refund.saleId,
    idempotencyKey: refund.idempotencyKey,
    amount: refund.amount,
    reason: refund.reason,
    recordedByUserId: refund.recordedByUserId,
    createdAt: refund.createdAt,
  };
}

function mapSalesError(error: unknown): OperationResponse {
  if (!(error instanceof SalesOperationError)) {
    throw error;
  }
  switch (error.code) {
    case "IDEMPOTENCY_KEY_REUSED":
      return response(409, "CONFLICT", "The idempotency key was already used.");
    case "BRANCH_REQUIRED":
      return response(400, "BAD_REQUEST", "A valid branch is required.");
    case "PAYMENT_NOT_AUTHORIZED":
      return response(403, "FORBIDDEN", "The request is not authorized.");
    case "CUSTOMER_UNAVAILABLE":
      return notFound();
    case "SALE_NOT_CANCELLABLE":
      return response(400, "INVALID_STATE", "This sale cannot be cancelled.");
    case "SALE_NOT_REFUNDABLE":
      return response(400, "INVALID_STATE", "This sale cannot be refunded.");
    case "REFUND_EXCEEDS_PAID_AMOUNT":
      return response(
        400,
        "INVALID_STATE",
        "The refund exceeds the paid amount.",
      );
    default:
      return response(
        400,
        "BAD_REQUEST",
        "The sale request could not be processed.",
      );
  }
}

export function registerSalesRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService,
): void {
  const salesPath = "/organizations/:organizationId/sales";
  const salePath = `${salesPath}/:saleId`;
  const saleRefundsPath = `${salePath}/refunds`;

  app.get(
    "/organizations/:organizationId/sales/catalog",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const query = request.query as Record<string, unknown>;
      const search = typeof query.search === "string" ? query.search : "";
      if (!path.success) return send(reply, invalid());
      const result = await authorization.withPermission(
        requestContext(request),
        "sales.sale.read",
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const items = await listSaleCatalogItems(
            transaction,
            context,
            search,
          );
          return { statusCode: 200, body: { items: items ?? [] } };
        },
      );
      if (!result.allowed)
        return send(
          reply,
          response(
            result.statusCode,
            result.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
            result.statusCode === 401
              ? "Authentication is required."
              : "The request is not authorized.",
          ),
        );
      return send(reply, result.value);
    },
  );

  app.post(salesPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const body = saleCheckoutInputSchema.safeParse(request.body);
    if (!path.success || !body.success) return send(reply, invalid());
    try {
      const result = await authorization.withPermission(
        requestContext(request),
        "sales.sale.create",
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const checkout = await checkoutSale(
            transaction,
            context,
            body.data,
            request.id,
          );
          return {
            statusCode: 201,
            body: {
              sale: saleView(checkout.sale),
              items: checkout.items.map(lineItemView),
              payment: checkout.payment
                ? {
                    id: checkout.payment.id,
                    saleId: checkout.payment.saleId,
                    paymentMethod: checkout.payment.paymentMethod,
                    amount: checkout.payment.amount,
                    paymentReference: checkout.payment.paymentReference,
                    recordedByUserId: checkout.payment.recordedByUserId,
                    createdAt: checkout.payment.createdAt,
                  }
                : null,
              replayed: checkout.replayed,
            },
          };
        },
      );
      if (!result.allowed)
        return send(
          reply,
          response(
            result.statusCode,
            result.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
            result.statusCode === 401
              ? "Authentication is required."
              : "The request is not authorized.",
          ),
        );
      return send(reply, result.value);
    } catch (error) {
      return send(reply, mapSalesError(error));
    }
  });

  app.get(salesPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const query = saleListQuerySchema.safeParse(request.query);
    if (!path.success || !query.success) return send(reply, invalid());
    const result = await authorization.withPermission(
      requestContext(request),
      "sales.sale.read",
      { requestId: request.id },
      async (transaction, context) => {
        if (!targetMatches(path.data.organizationId, context))
          return notFound();
        const page = await listSales(transaction, context, query.data);
        if (!page) return forbidden();
        return {
          statusCode: 200,
          body: {
            items: page.items.map(saleView),
            total: page.total,
            limit: query.data.limit,
            offset: query.data.offset,
          },
        };
      },
    );
    if (!result.allowed)
      return send(
        reply,
        response(
          result.statusCode,
          result.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
          result.statusCode === 401
            ? "Authentication is required."
            : "The request is not authorized.",
        ),
      );
    return send(reply, result.value);
  });

  app.get(salePath, async (request, reply) => {
    const path = resourcePathSchema.safeParse(request.params);
    if (!path.success) return send(reply, notFound());
    const result = await authorization.withPermission(
      requestContext(request),
      "sales.sale.read",
      { requestId: request.id },
      async (transaction, context) => {
        if (!targetMatches(path.data.organizationId, context))
          return notFound();
        const sale = await getSale(transaction, context, path.data.saleId);
        if (!sale) return notFound();
        return {
          statusCode: 200,
          body: {
            sale: saleView(sale.sale),
            items: sale.items.map(lineItemView),
            payment: sale.payment
              ? {
                  id: sale.payment.id,
                  saleId: sale.payment.saleId,
                  paymentMethod: sale.payment.paymentMethod,
                  amount: sale.payment.amount,
                  paymentReference: sale.payment.paymentReference,
                  recordedByUserId: sale.payment.recordedByUserId,
                  createdAt: sale.payment.createdAt,
                }
              : null,
          },
        };
      },
    );
    if (!result.allowed)
      return send(
        reply,
        response(
          result.statusCode,
          result.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
          result.statusCode === 401
            ? "Authentication is required."
            : "The request is not authorized.",
        ),
      );
    return send(reply, result.value);
  });

  app.post(`${salePath}/cancel`, async (request, reply) => {
    const path = resourcePathSchema.safeParse(request.params);
    const body = saleCancellationInputSchema.safeParse(request.body);
    if (!path.success || !body.success) return send(reply, invalid());
    try {
      const result = await authorization.withPermission(
        requestContext(request),
        "sales.sale.cancel",
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const sale = await cancelSale(
            transaction,
            context,
            path.data.saleId,
            body.data.reason,
            request.id,
          );
          if (!sale) return notFound();
          return { statusCode: 200, body: { sale: saleView(sale) } };
        },
      );
      if (!result.allowed)
        return send(
          reply,
          response(
            result.statusCode,
            result.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
            result.statusCode === 401
              ? "Authentication is required."
              : "The request is not authorized.",
          ),
        );
      return send(reply, result.value);
    } catch (error) {
      return send(reply, mapSalesError(error));
    }
  });

  app.post(saleRefundsPath, async (request, reply) => {
    const path = resourcePathSchema.safeParse(request.params);
    const body = saleRefundInputSchema.safeParse(request.body);
    if (!path.success || !body.success) return send(reply, invalid());
    try {
      const result = await authorization.withPermission(
        requestContext(request),
        "sales.sale.refund",
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const refund = await recordSaleRefund(
            transaction,
            context,
            path.data.saleId,
            body.data,
            request.id,
          );
          if (!refund) return notFound();
          return {
            statusCode: 201,
            body: {
              refund: refundView(refund.refund),
              replayed: refund.replayed,
            },
          };
        },
      );
      if (!result.allowed)
        return send(
          reply,
          response(
            result.statusCode,
            result.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
            result.statusCode === 401
              ? "Authentication is required."
              : "The request is not authorized.",
          ),
        );
      return send(reply, result.value);
    } catch (error) {
      return send(reply, mapSalesError(error));
    }
  });
}
