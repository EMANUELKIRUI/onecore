import { z } from "zod";
import {
  dispatchOutboxBatch,
  eventDeadLetterReadPermission,
  eventDispatchPermission,
  listEventDeadLetters,
  replayEventDeadLetter,
  type AuthorizationContext,
  type AuthorizationService,
  denyAllAuthorizationService,
} from "@onecore/database";
import type { ApiFastifyInstance } from "./fastify-instance.js";

const organizationPathSchema = z.object({ organizationId: z.uuid() });
const replayPathSchema = organizationPathSchema.extend({
  eventId: z.uuid(),
  handlerName: z.string().min(2).max(150).regex(/^[a-z][a-z0-9_.-]+$/),
});
const dispatchBodySchema = z
  .object({ batchSize: z.number().int().min(1).max(100).optional() })
  .strict();
const deadLetterQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

interface ApiOperationResponse {
  statusCode: number;
  body: unknown;
}

function requestContext(request: {
  auth: {
    userId: string;
    sessionId: string;
    organizationId: string | null;
    membershipId: string | null;
    branchId: string | null;
  } | null;
}): AuthorizationContext | null {
  const authenticated = request.auth;
  if (!authenticated) return null;
  return {
    userId: authenticated.userId,
    sessionId: authenticated.sessionId,
    organizationId: authenticated.organizationId,
    membershipId: authenticated.membershipId,
    branchId: authenticated.branchId,
  };
}

function sendDenied(
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

function sendResponse(
  reply: {
    status: (statusCode: number) => { send: (body: unknown) => unknown };
  },
  result: ApiOperationResponse,
) {
  return reply.status(result.statusCode).send(result.body);
}

function notFound(): ApiOperationResponse {
  return {
    statusCode: 404,
    body: {
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    },
  };
}

export function registerEventRoutes(
  app: ApiFastifyInstance,
  authorization: AuthorizationService = denyAllAuthorizationService,
): void {
  app.post(
    "/organizations/:organizationId/events/dispatch",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const body = dispatchBodySchema.safeParse(request.body ?? {});
      if (!path.success || !body.success) {
        return reply.status(400).send({
          error: { code: "BAD_REQUEST", message: "Invalid event dispatch request." },
        });
      }
      const result = await authorization.withPermission(
        requestContext(request),
        eventDispatchPermission,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return notFound();
          }
          const dispatch = await dispatchOutboxBatch(
            transaction,
            context,
            [],
            body.data.batchSize === undefined
              ? {}
              : { batchSize: body.data.batchSize },
          );
          return { statusCode: 200, body: dispatch };
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.get(
    "/organizations/:organizationId/events/dead-letters",
    async (request, reply) => {
      const path = organizationPathSchema.safeParse(request.params);
      const query = deadLetterQuerySchema.safeParse(request.query);
      if (!path.success || !query.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        eventDeadLetterReadPermission,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return notFound();
          }
          const deadLetters = await listEventDeadLetters(
            transaction,
            context,
            query.data.limit,
          );
          return { statusCode: 200, body: { deadLetters } };
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );

  app.post(
    "/organizations/:organizationId/events/dead-letters/:eventId/:handlerName/replay",
    async (request, reply) => {
      const path = replayPathSchema.safeParse(request.params);
      if (!path.success) return sendResponse(reply, notFound());
      const result = await authorization.withPermission(
        requestContext(request),
        eventDispatchPermission,
        { requestId: request.id },
        async (transaction, context) => {
          if (context.organizationId !== path.data.organizationId) {
            return notFound();
          }
          const replayed = await replayEventDeadLetter(
            transaction,
            context,
            { requestId: request.id },
            path.data.eventId,
            path.data.handlerName,
          );
          if (!replayed) return notFound();
          return { statusCode: 202, body: { replayed: true } };
        },
      );
      if (!result.allowed) return sendDenied(reply, result.statusCode);
      return sendResponse(reply, result.value);
    },
  );
}
