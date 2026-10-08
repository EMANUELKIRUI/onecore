import {
  catalogItemCreateInputSchema,
  catalogItemUpdateInputSchema,
  catalogListQuerySchema,
  createDomainEvent,
  customerCreateInputSchema,
  customerListQuerySchema,
  customerUpdateInputSchema,
} from "@onecore/core-domain";
import {
  createCatalogItem,
  createCustomer,
  deleteCatalogItem,
  deleteCustomer,
  getCatalogItem,
  getCustomer,
  listCatalogItems,
  listCustomers,
  recordOutboxEvent,
  updateCatalogItem,
  updateCustomer,
  writeAuthorizationMutationEvent,
  type AuthorizationContext,
  type OrganizationTransaction,
  type ResolvedAuthorizationContext,
} from "@onecore/database";
import { z } from "zod";
import type { ApiFastifyInstance } from "./fastify-instance.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() }).strict();
const resourcePathSchema = organizationPathSchema
  .extend({ resourceId: z.uuid() })
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

function conflict(): OperationResponse {
  return response(
    409,
    "CONFLICT",
    "A record with this reference already exists.",
  );
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

function branchMatches(
  requestedBranchId: string | null | undefined,
  context: ResolvedAuthorizationContext,
): boolean {
  return (
    requestedBranchId === undefined || requestedBranchId === context.branchId
  );
}

function uniqueBusinessReferenceConflict(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 3) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    cause?: unknown;
  };
  const constraint = candidate.constraint ?? candidate.constraint_name;
  if (
    candidate.code === "23505" &&
    (constraint === "customers_org_reference_unique" ||
      constraint === "catalog_items_org_reference_unique")
  ) {
    return true;
  }
  return candidate.cause !== undefined
    ? uniqueBusinessReferenceConflict(candidate.cause, depth + 1)
    : false;
}

function customerView(customer: {
  id: string;
  organizationId: string;
  branchId: string | null;
  reference: string | null;
  name: string;
  customerType: string;
  phone: string | null;
  email: string | null;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: customer.id,
    organizationId: customer.organizationId,
    branchId: customer.branchId,
    reference: customer.reference,
    name: customer.name,
    customerType: customer.customerType,
    phone: customer.phone,
    email: customer.email,
    status: customer.status,
    notes: customer.notes,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
}

function catalogView(item: {
  id: string;
  organizationId: string;
  branchId: string | null;
  reference: string | null;
  name: string;
  description: string | null;
  type: string;
  unit: string;
  price: string;
  currency: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: item.id,
    organizationId: item.organizationId,
    branchId: item.branchId,
    reference: item.reference,
    name: item.name,
    description: item.description,
    type: item.type,
    unit: item.unit,
    price: item.price,
    currency: item.currency,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function recordCustomerMutation(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  requestId: string,
  customerId: string,
  eventType: "CUSTOMER_CREATED" | "CUSTOMER_UPDATED" | "CUSTOMER_DELETED",
  changedFields: string[] = [],
): Promise<void> {
  const payload =
    eventType === "CUSTOMER_UPDATED"
      ? { customerId, changedFields }
      : { customerId };
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType,
      organizationId: context.organizationId,
      ...(context.branch ? { branchId: context.branch.branchId } : {}),
      actorUserId: context.userId,
      aggregateType: "customer",
      aggregateId: customerId,
      payload,
      metadata: { requestId },
    }),
  );
}

async function recordCatalogMutation(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  requestId: string,
  catalogItemId: string,
  eventType:
    "CATALOG_ITEM_CREATED" | "CATALOG_ITEM_UPDATED" | "CATALOG_ITEM_DELETED",
  changedFields: string[] = [],
): Promise<void> {
  const payload =
    eventType === "CATALOG_ITEM_UPDATED"
      ? { catalogItemId, changedFields }
      : { catalogItemId };
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType,
      organizationId: context.organizationId,
      ...(context.branch ? { branchId: context.branch.branchId } : {}),
      actorUserId: context.userId,
      aggregateType: "catalog_item",
      aggregateId: catalogItemId,
      payload,
      metadata: { requestId },
    }),
  );
}

async function auditMutation(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  requestId: string,
  action: string,
  resource: string,
  resourceId: string,
  changedFields: string[],
): Promise<void> {
  await writeAuthorizationMutationEvent(
    transaction,
    context,
    { requestId },
    action,
    resource,
    resourceId,
    { changedFields },
  );
}

export function registerBusinessManagerRoutes(
  app: ApiFastifyInstance,
  authorization: import("@onecore/database").AuthorizationService,
): void {
  const customersPath = "/organizations/:organizationId/business/customers";
  const customerPath = `${customersPath}/:resourceId`;
  const catalogPath = "/organizations/:organizationId/business/catalog";
  const catalogItemPath = `${catalogPath}/:resourceId`;

  app.get(customersPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const query = customerListQuerySchema.safeParse(request.query);
    if (!path.success || !query.success) return send(reply, invalid());
    const result = await authorization.withPermission(
      requestContext(request),
      "core.business_manager.customer.read",
      { requestId: request.id },
      async (transaction, context) => {
        if (!targetMatches(path.data.organizationId, context))
          return notFound();
        if (!branchMatches(query.data.branchId, context)) return forbidden();
        const page = await listCustomers(transaction, context, query.data);
        if (!page) return forbidden();
        return {
          statusCode: 200,
          body: {
            items: page.items.map(customerView),
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

  app.post(customersPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const body = customerCreateInputSchema.safeParse(request.body);
    if (!path.success || !body.success) return send(reply, invalid());
    try {
      const result = await authorization.withPermission(
        requestContext(request),
        "core.business_manager.customer.create",
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          if (!branchMatches(body.data.branchId, context)) return forbidden();
          const customer = await createCustomer(
            transaction,
            context,
            body.data,
          );
          if (!customer) return forbidden();
          const changedFields = Object.keys(body.data);
          await auditMutation(
            transaction,
            context,
            request.id,
            "business_manager.customer.created",
            "customer",
            customer.id,
            changedFields,
          );
          await recordCustomerMutation(
            transaction,
            context,
            request.id,
            customer.id,
            "CUSTOMER_CREATED",
          );
          return {
            statusCode: 201,
            body: { customer: customerView(customer) },
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
      if (uniqueBusinessReferenceConflict(error))
        return send(reply, conflict());
      throw error;
    }
  });

  app.get(customerPath, async (request, reply) => {
    const path = resourcePathSchema.safeParse(request.params);
    if (!path.success) return send(reply, notFound());
    const result = await authorization.withPermission(
      requestContext(request),
      "core.business_manager.customer.read",
      { requestId: request.id },
      async (transaction, context) => {
        if (!targetMatches(path.data.organizationId, context))
          return notFound();
        const customer = await getCustomer(
          transaction,
          context,
          path.data.resourceId,
        );
        return customer
          ? { statusCode: 200, body: { customer: customerView(customer) } }
          : notFound();
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

  app.patch(customerPath, async (request, reply) => {
    const path = resourcePathSchema.safeParse(request.params);
    const body = customerUpdateInputSchema.safeParse(request.body);
    if (!path.success || !body.success) return send(reply, invalid());
    try {
      const result = await authorization.withPermission(
        requestContext(request),
        "core.business_manager.customer.update",
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const customer = await updateCustomer(
            transaction,
            context,
            path.data.resourceId,
            body.data,
          );
          if (!customer) return notFound();
          const changedFields = Object.keys(body.data);
          await auditMutation(
            transaction,
            context,
            request.id,
            "business_manager.customer.updated",
            "customer",
            customer.id,
            changedFields,
          );
          await recordCustomerMutation(
            transaction,
            context,
            request.id,
            customer.id,
            "CUSTOMER_UPDATED",
            changedFields,
          );
          return {
            statusCode: 200,
            body: { customer: customerView(customer) },
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
      if (uniqueBusinessReferenceConflict(error))
        return send(reply, conflict());
      throw error;
    }
  });

  app.delete(customerPath, async (request, reply) => {
    const path = resourcePathSchema.safeParse(request.params);
    if (!path.success) return send(reply, notFound());
    const result = await authorization.withPermission(
      requestContext(request),
      "core.business_manager.customer.delete",
      { requestId: request.id },
      async (transaction, context) => {
        if (!targetMatches(path.data.organizationId, context))
          return notFound();
        const customer = await deleteCustomer(
          transaction,
          context,
          path.data.resourceId,
        );
        if (!customer) return notFound();
        await auditMutation(
          transaction,
          context,
          request.id,
          "business_manager.customer.deactivated",
          "customer",
          customer.id,
          ["status"],
        );
        await recordCustomerMutation(
          transaction,
          context,
          request.id,
          customer.id,
          "CUSTOMER_DELETED",
        );
        return { statusCode: 200, body: { customer: customerView(customer) } };
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

  app.get(catalogPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const query = catalogListQuerySchema.safeParse(request.query);
    if (!path.success || !query.success) return send(reply, invalid());
    const result = await authorization.withPermission(
      requestContext(request),
      "core.business_manager.catalog.read",
      { requestId: request.id },
      async (transaction, context) => {
        if (!targetMatches(path.data.organizationId, context))
          return notFound();
        if (!branchMatches(query.data.branchId, context)) return forbidden();
        const page = await listCatalogItems(transaction, context, query.data);
        if (!page) return forbidden();
        return {
          statusCode: 200,
          body: {
            items: page.items.map(catalogView),
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

  app.post(catalogPath, async (request, reply) => {
    const path = organizationPathSchema.safeParse(request.params);
    const body = catalogItemCreateInputSchema.safeParse(request.body);
    if (!path.success || !body.success) return send(reply, invalid());
    try {
      const result = await authorization.withPermission(
        requestContext(request),
        "core.business_manager.catalog.create",
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          if (!branchMatches(body.data.branchId, context)) return forbidden();
          const item = await createCatalogItem(transaction, context, body.data);
          if (!item) return forbidden();
          const changedFields = Object.keys(body.data);
          await auditMutation(
            transaction,
            context,
            request.id,
            "business_manager.catalog_item.created",
            "catalog_item",
            item.id,
            changedFields,
          );
          await recordCatalogMutation(
            transaction,
            context,
            request.id,
            item.id,
            "CATALOG_ITEM_CREATED",
          );
          return { statusCode: 201, body: { item: catalogView(item) } };
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
      if (uniqueBusinessReferenceConflict(error))
        return send(reply, conflict());
      throw error;
    }
  });

  app.get(catalogItemPath, async (request, reply) => {
    const path = resourcePathSchema.safeParse(request.params);
    if (!path.success) return send(reply, notFound());
    const result = await authorization.withPermission(
      requestContext(request),
      "core.business_manager.catalog.read",
      { requestId: request.id },
      async (transaction, context) => {
        if (!targetMatches(path.data.organizationId, context))
          return notFound();
        const item = await getCatalogItem(
          transaction,
          context,
          path.data.resourceId,
        );
        return item
          ? { statusCode: 200, body: { item: catalogView(item) } }
          : notFound();
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

  app.patch(catalogItemPath, async (request, reply) => {
    const path = resourcePathSchema.safeParse(request.params);
    const body = catalogItemUpdateInputSchema.safeParse(request.body);
    if (!path.success || !body.success) return send(reply, invalid());
    try {
      const result = await authorization.withPermission(
        requestContext(request),
        "core.business_manager.catalog.update",
        { requestId: request.id },
        async (transaction, context) => {
          if (!targetMatches(path.data.organizationId, context))
            return notFound();
          const item = await updateCatalogItem(
            transaction,
            context,
            path.data.resourceId,
            body.data,
          );
          if (!item) return notFound();
          const changedFields = Object.keys(body.data);
          await auditMutation(
            transaction,
            context,
            request.id,
            "business_manager.catalog_item.updated",
            "catalog_item",
            item.id,
            changedFields,
          );
          await recordCatalogMutation(
            transaction,
            context,
            request.id,
            item.id,
            "CATALOG_ITEM_UPDATED",
            changedFields,
          );
          return { statusCode: 200, body: { item: catalogView(item) } };
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
      if (uniqueBusinessReferenceConflict(error))
        return send(reply, conflict());
      throw error;
    }
  });

  app.delete(catalogItemPath, async (request, reply) => {
    const path = resourcePathSchema.safeParse(request.params);
    if (!path.success) return send(reply, notFound());
    const result = await authorization.withPermission(
      requestContext(request),
      "core.business_manager.catalog.delete",
      { requestId: request.id },
      async (transaction, context) => {
        if (!targetMatches(path.data.organizationId, context))
          return notFound();
        const item = await deleteCatalogItem(
          transaction,
          context,
          path.data.resourceId,
        );
        if (!item) return notFound();
        await auditMutation(
          transaction,
          context,
          request.id,
          "business_manager.catalog_item.deactivated",
          "catalog_item",
          item.id,
          ["status"],
        );
        await recordCatalogMutation(
          transaction,
          context,
          request.id,
          item.id,
          "CATALOG_ITEM_DELETED",
        );
        return { statusCode: 200, body: { item: catalogView(item) } };
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
}
