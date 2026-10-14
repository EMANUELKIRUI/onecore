import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  organizations,
  platformUserRoles,
  supportAccessGrants,
  supportMessages,
  supportRequests,
  supportRootAdministrators,
  type OrganizationTransaction,
  type Database,
} from "@onecore/database";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiFastifyInstance } from "./fastify-instance.js";
import {
  requireAuthenticated,
  type AuthenticatedRequestContext,
} from "./authentication.js";

export const supportPermissions = {
  requestList: "platform.support.request.list",
  requestRead: "platform.support.request.read",
  requestCreate: "organization.support.request.create",
  requestAssign: "platform.support.request.assign",
  requestUpdate: "platform.support.request.update",
  requestReply: "support.request.reply",
  internalNote: "platform.support.request.note",
  organizationGrant: "platform.support.organization.grant",
  staffManage: "platform.support.staff.manage",
} as const;
type SupportPermission =
  (typeof supportPermissions)[keyof typeof supportPermissions];

const requestIdSchema = z.object({ requestId: z.uuid() });
const staffIdSchema = z.object({ userId: z.uuid() });
const grantIdSchema = z.object({ grantId: z.uuid() });
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const createRequestSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10_000),
  })
  .strict();
const messageSchema = z
  .object({ body: z.string().trim().min(1).max(10_000) })
  .strict();
const updateRequestSchema = z
  .object({
    status: z
      .enum([
        "OPEN",
        "IN_PROGRESS",
        "WAITING_ON_CUSTOMER",
        "RESOLVED",
        "CLOSED",
      ])
      .optional(),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const grantSchema = z
  .object({
    supportUserId: z.uuid(),
    reason: z.string().trim().min(8).max(500),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const assignSchema = z.object({ supportUserId: z.uuid() }).strict();

function apiError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.status(status).send({ error: { code, message } });
}

export function registerSupportRoutes(
  app: ApiFastifyInstance,
  database: Database,
): void {
  const authenticated = requireAuthenticated();
  const protectedOptions = {
    preHandler: authenticated,
    config: { rateLimit: { max: 120, timeWindow: 60_000 } },
  };

  app.get("/support/requests", protectedOptions, async (request, reply) => {
    const auth = request.auth;
    const query = listQuerySchema.safeParse(request.query);
    if (!auth)
      return apiError(
        reply,
        401,
        "UNAUTHORIZED",
        "Authentication is required.",
      );
    if (!query.success)
      return apiError(
        reply,
        400,
        "BAD_REQUEST",
        "Invalid support request pagination.",
      );
    const staff = await hasSupportPermission(
      database,
      auth.userId,
      supportPermissions.requestList,
    );
    const root = await isRootAdministrator(database, auth.userId);
    if (!auth.organizationId && !staff && !root) {
      return apiError(
        reply,
        403,
        "FORBIDDEN",
        "Support access is not enabled for this account.",
      );
    }
    if ((staff || root) && !auth.mfaVerifiedAt) {
      return apiError(
        reply,
        403,
        "MFA_REQUIRED",
        "Support staff must complete authenticator-app verification.",
      );
    }

    const requests = await database.transaction(async (transaction) => {
      await setActor(transaction, auth.userId, auth.organizationId);
      const rows = await transaction
        .select({
          id: supportRequests.id,
          organizationId: supportRequests.organizationId,
          subject: supportRequests.subject,
          status: supportRequests.status,
          priority: supportRequests.priority,
          assignedSupportUserId: supportRequests.assignedSupportUserId,
          createdAt: supportRequests.createdAt,
          updatedAt: supportRequests.updatedAt,
        })
        .from(supportRequests)
        .orderBy(desc(supportRequests.updatedAt), desc(supportRequests.id))
        .limit(query.data.limit)
        .offset(query.data.page * query.data.limit);
      if (staff || root) {
        for (const row of rows) {
          await setOrganization(transaction, row.organizationId);
          await writeAudit(transaction, {
            actorUserId: auth.userId,
            organizationId: row.organizationId,
            action: "SUPPORT_REQUEST_QUEUE_VIEWED",
            resourceId: row.id,
            requestId: request.id,
          });
        }
      }
      return rows;
    });
    return reply.send({
      requests,
      page: query.data.page,
      nextPage:
        requests.length === query.data.limit ? query.data.page + 1 : null,
    });
  });

  app.post("/support/requests", protectedOptions, async (request, reply) => {
    const auth = request.auth;
    const body = createRequestSchema.safeParse(request.body);
    if (!auth)
      return apiError(
        reply,
        401,
        "UNAUTHORIZED",
        "Authentication is required.",
      );
    if (!auth.organizationId || !auth.membershipId) {
      return apiError(
        reply,
        403,
        "FORBIDDEN",
        "An active organization membership is required.",
      );
    }
    if (
      !(await hasSupportPermission(
        database,
        auth.userId,
        supportPermissions.requestCreate,
        auth,
      ))
    ) {
      return apiError(
        reply,
        403,
        "FORBIDDEN",
        "Support request creation access is required.",
      );
    }
    if (!body.success)
      return apiError(reply, 400, "BAD_REQUEST", "Invalid support request.");

    const result = await database.transaction(async (transaction) => {
      await setActor(transaction, auth.userId, auth.organizationId);
      const [created] = await transaction
        .insert(supportRequests)
        .values({
          organizationId: auth.organizationId!,
          createdByUserId: auth.userId,
          subject: body.data.subject,
        })
        .returning();
      if (!created) throw new Error("Support request creation returned no row");
      await transaction.insert(supportMessages).values({
        organizationId: created.organizationId,
        requestId: created.id,
        authorUserId: auth.userId,
        visibility: "CUSTOMER",
        body: body.data.body,
      });
      await writeAudit(transaction, {
        actorUserId: auth.userId,
        organizationId: created.organizationId,
        action: "SUPPORT_REQUEST_CREATED",
        resourceId: created.id,
        requestId: request.id,
      });
      return created;
    });
    return reply.status(201).send({ request: result });
  });

  app.get(
    "/support/requests/:requestId",
    protectedOptions,
    async (request, reply) => {
      const auth = request.auth;
      const path = requestIdSchema.safeParse(request.params);
      if (!auth)
        return apiError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      if (!path.success)
        return apiError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid support request identifier.",
        );
      const staff = await hasSupportPermission(
        database,
        auth.userId,
        supportPermissions.requestRead,
      );
      const root = await isRootAdministrator(database, auth.userId);
      if (!auth.organizationId && !staff && !root) {
        return apiError(
          reply,
          403,
          "FORBIDDEN",
          "Support access is not enabled for this account.",
        );
      }
      if ((staff || root) && !auth.mfaVerifiedAt) {
        return apiError(
          reply,
          403,
          "MFA_REQUIRED",
          "Support staff must complete authenticator-app verification.",
        );
      }

      const result = await database.transaction(async (transaction) => {
        await setActor(transaction, auth.userId, auth.organizationId);
        const [supportRequest] = await transaction
          .select()
          .from(supportRequests)
          .where(eq(supportRequests.id, path.data.requestId))
          .limit(1);
        if (!supportRequest) {
          await writeDeniedSupportAccessAudit(
            transaction,
            auth.userId,
            path.data.requestId,
            request.id,
          );
          return undefined;
        }
        const [organization] = await transaction
          .select({
            id: organizations.id,
            name: organizations.name,
            slug: organizations.slug,
          })
          .from(organizations)
          .where(eq(organizations.id, supportRequest.organizationId))
          .limit(1);
        const messages = await transaction
          .select({
            id: supportMessages.id,
            authorUserId: supportMessages.authorUserId,
            visibility: supportMessages.visibility,
            body: supportMessages.body,
            createdAt: supportMessages.createdAt,
          })
          .from(supportMessages)
          .where(eq(supportMessages.requestId, path.data.requestId))
          .orderBy(supportMessages.createdAt);
        await setOrganization(transaction, supportRequest.organizationId);
        await writeAudit(transaction, {
          actorUserId: auth.userId,
          organizationId: supportRequest.organizationId,
          action: "SUPPORT_REQUEST_VIEWED",
          resourceId: supportRequest.id,
          requestId: request.id,
        });
        return { request: supportRequest, organization, messages };
      });
      if (!result)
        return apiError(
          reply,
          404,
          "NOT_FOUND",
          "Support request was not found.",
        );
      if (result.request.organizationId !== auth.organizationId && !root) {
        const assigned = result.request.assignedSupportUserId === auth.userId;
        if (
          !assigned ||
          !(await hasActiveGrant(
            database,
            auth.userId,
            result.request.organizationId,
          ))
        ) {
          return apiError(
            reply,
            404,
            "NOT_FOUND",
            "Support request was not found.",
          );
        }
      }
      const supportStaff = await hasSupportPermission(
        database,
        auth.userId,
        supportPermissions.internalNote,
      );
      return reply.send({
        ...result,
        capabilities: {
          reply:
            auth.organizationId === result.request.organizationId ||
            (supportStaff &&
              result.request.assignedSupportUserId === auth.userId &&
              (await hasActiveGrant(
                database,
                auth.userId,
                result.request.organizationId,
              ))),
          internalNote:
            supportStaff &&
            result.request.assignedSupportUserId === auth.userId &&
            (await hasActiveGrant(
              database,
              auth.userId,
              result.request.organizationId,
            )),
          update:
            supportStaff &&
            result.request.assignedSupportUserId === auth.userId,
          assign: root,
        },
      });
    },
  );

  app.post(
    "/support/requests/:requestId/messages",
    protectedOptions,
    async (request, reply) =>
      writeMessage(database, request, reply, "CUSTOMER"),
  );

  app.post(
    "/support/requests/:requestId/notes",
    protectedOptions,
    async (request, reply) =>
      writeMessage(database, request, reply, "INTERNAL"),
  );

  app.patch(
    "/support/requests/:requestId",
    protectedOptions,
    async (request, reply) => {
      const auth = request.auth;
      const path = requestIdSchema.safeParse(request.params);
      const body = updateRequestSchema.safeParse(request.body);
      if (!auth)
        return apiError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      if (!path.success || !body.success)
        return apiError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid support request update.",
        );
      if (
        !(await hasSupportPermission(
          database,
          auth.userId,
          supportPermissions.requestUpdate,
        ))
      ) {
        return apiError(
          reply,
          403,
          "FORBIDDEN",
          "Support request update access is required.",
        );
      }
      if (!auth.mfaVerifiedAt) {
        return apiError(
          reply,
          403,
          "MFA_REQUIRED",
          "Support staff MFA verification is required.",
        );
      }

      const updated = await database.transaction(async (transaction) => {
        await setActor(transaction, auth.userId);
        const [current] = await transaction
          .select()
          .from(supportRequests)
          .where(eq(supportRequests.id, path.data.requestId))
          .limit(1);
        if (!current) return undefined;
        await setOrganization(transaction, current.organizationId);
        const [result] = await transaction
          .update(supportRequests)
          .set({
            ...body.data,
            updatedAt: new Date(),
            ...(body.data.status === "CLOSED" ? { closedAt: new Date() } : {}),
          })
          .where(eq(supportRequests.id, current.id))
          .returning();
        if (!result) return undefined;
        await writeAudit(transaction, {
          actorUserId: auth.userId,
          organizationId: result.organizationId,
          action: "SUPPORT_REQUEST_UPDATED",
          resourceId: result.id,
          requestId: request.id,
        });
        return result;
      });
      if (!updated)
        return apiError(
          reply,
          404,
          "NOT_FOUND",
          "Support request was not found.",
        );
      return reply.send({ request: updated });
    },
  );

  app.post(
    "/platform/support/requests/:requestId/assignment",
    protectedOptions,
    async (request, reply) => {
      const auth = request.auth;
      const path = requestIdSchema.safeParse(request.params);
      const body = assignSchema.safeParse(request.body);
      if (!auth)
        return apiError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      if (!path.success || !body.success)
        return apiError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid support assignment.",
        );
      if (
        !(await hasSupportPermission(
          database,
          auth.userId,
          supportPermissions.requestAssign,
        ))
      ) {
        return apiError(
          reply,
          403,
          "FORBIDDEN",
          "Root administrator access is required.",
        );
      }
      if (!auth.mfaVerifiedAt) {
        return apiError(
          reply,
          403,
          "MFA_REQUIRED",
          "Root administrator MFA verification is required.",
        );
      }

      const assigned = await database.transaction(async (transaction) => {
        await setActor(transaction, auth.userId);
        const [ticket] = await transaction
          .select()
          .from(supportRequests)
          .where(eq(supportRequests.id, path.data.requestId))
          .limit(1);
        if (
          !ticket ||
          !(await hasActiveGrantInTransaction(
            transaction,
            body.data.supportUserId,
            ticket.organizationId,
          ))
        ) {
          return undefined;
        }
        await setOrganization(transaction, ticket.organizationId);
        const [result] = await transaction
          .update(supportRequests)
          .set({
            assignedSupportUserId: body.data.supportUserId,
            updatedAt: new Date(),
          })
          .where(eq(supportRequests.id, ticket.id))
          .returning();
        if (result) {
          await writeAudit(transaction, {
            actorUserId: auth.userId,
            organizationId: ticket.organizationId,
            action: "SUPPORT_REQUEST_ASSIGNED",
            resourceId: ticket.id,
            requestId: request.id,
          });
        }
        return result;
      });
      if (!assigned)
        return apiError(
          reply,
          404,
          "NOT_FOUND",
          "Request or authorized support grant was not found.",
        );
      return reply.send({ request: assigned });
    },
  );

  app.post(
    "/platform/support/staff",
    protectedOptions,
    async (request, reply) => {
      const auth = request.auth;
      const body = staffIdSchema.safeParse(request.body);
      if (!auth)
        return apiError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      if (!body.success)
        return apiError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid support staff identity.",
        );
      if (
        !(await hasSupportPermission(
          database,
          auth.userId,
          supportPermissions.staffManage,
        ))
      ) {
        return apiError(
          reply,
          403,
          "FORBIDDEN",
          "Root administrator access is required.",
        );
      }
      if (!auth.mfaVerifiedAt) {
        return apiError(
          reply,
          403,
          "MFA_REQUIRED",
          "Root administrator MFA verification is required.",
        );
      }
      if (await isRootAdministrator(database, body.data.userId)) {
        return apiError(
          reply,
          409,
          "CONFLICT",
          "A Root administrator cannot be managed as support staff.",
        );
      }
      await database.transaction(async (transaction) => {
        await setActor(transaction, auth.userId);
        await transaction
          .insert(platformUserRoles)
          .values({
            userId: body.data.userId,
            role: "SUPPORT",
            grantedByUserId: auth.userId,
          })
          .onConflictDoNothing();
        await writePlatformAudit(
          transaction,
          auth.userId,
          "SUPPORT_STAFF_ROLE_GRANTED",
          body.data.userId,
          request.id,
        );
      });
      return reply.status(204).send();
    },
  );

  app.delete(
    "/platform/support/staff/:userId",
    protectedOptions,
    async (request, reply) => {
      const auth = request.auth;
      const path = staffIdSchema.safeParse(request.params);
      if (!auth)
        return apiError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      if (!path.success)
        return apiError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid support staff identity.",
        );
      if (
        !(await hasSupportPermission(
          database,
          auth.userId,
          supportPermissions.staffManage,
        ))
      ) {
        return apiError(
          reply,
          403,
          "FORBIDDEN",
          "Root administrator access is required.",
        );
      }
      if (!auth.mfaVerifiedAt) {
        return apiError(
          reply,
          403,
          "MFA_REQUIRED",
          "Root administrator MFA verification is required.",
        );
      }
      if (await isRootAdministrator(database, path.data.userId)) {
        return apiError(
          reply,
          409,
          "CONFLICT",
          "A Root administrator cannot be disabled as support staff.",
        );
      }
      await database.transaction(async (transaction) => {
        await setActor(transaction, auth.userId);
        const assignedRequests = await transaction
          .select({
            id: supportRequests.id,
            organizationId: supportRequests.organizationId,
          })
          .from(supportRequests)
          .where(eq(supportRequests.assignedSupportUserId, path.data.userId));
        for (const assignedRequest of assignedRequests) {
          await setOrganization(transaction, assignedRequest.organizationId);
          await writeAudit(transaction, {
            actorUserId: auth.userId,
            organizationId: assignedRequest.organizationId,
            action: "SUPPORT_REQUEST_UNASSIGNED_STAFF_DISABLED",
            resourceId: assignedRequest.id,
            requestId: request.id,
          });
        }
        await transaction
          .update(supportRequests)
          .set({
            assignedSupportUserId: null,
            updatedAt: new Date(),
          })
          .where(eq(supportRequests.assignedSupportUserId, path.data.userId));
        await transaction
          .update(supportAccessGrants)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(supportAccessGrants.supportUserId, path.data.userId),
              isNull(supportAccessGrants.revokedAt),
            ),
          );
        await transaction
          .delete(platformUserRoles)
          .where(
            and(
              eq(platformUserRoles.userId, path.data.userId),
              eq(platformUserRoles.role, "SUPPORT"),
            ),
          );
        await writePlatformAudit(
          transaction,
          auth.userId,
          "SUPPORT_STAFF_ROLE_REVOKED",
          path.data.userId,
          request.id,
        );
      });
      return reply.status(204).send();
    },
  );

  app.post(
    "/platform/support/organizations/:organizationId/grants",
    protectedOptions,
    async (request, reply) => {
      const auth = request.auth;
      const path = z
        .object({ organizationId: z.uuid() })
        .safeParse(request.params);
      const body = grantSchema.safeParse(request.body);
      if (!auth)
        return apiError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      if (!path.success || !body.success)
        return apiError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid support access grant.",
        );
      if (
        !(await hasSupportPermission(
          database,
          auth.userId,
          supportPermissions.organizationGrant,
        ))
      ) {
        return apiError(
          reply,
          403,
          "FORBIDDEN",
          "Root administrator access is required.",
        );
      }
      if (!auth.mfaVerifiedAt) {
        return apiError(
          reply,
          403,
          "MFA_REQUIRED",
          "Root administrator MFA verification is required.",
        );
      }
      const expiresAt = new Date(body.data.expiresAt);
      const now = new Date();
      if (
        expiresAt <= now ||
        expiresAt.getTime() > now.getTime() + 30 * 24 * 60 * 60_000
      ) {
        return apiError(
          reply,
          400,
          "BAD_REQUEST",
          "Support access must expire within 30 days.",
        );
      }
      const grant = await database.transaction(async (transaction) => {
        await setActor(transaction, auth.userId, path.data.organizationId);
        const [hasSupportRole] = await transaction
          .select({ userId: platformUserRoles.userId })
          .from(platformUserRoles)
          .where(
            and(
              eq(platformUserRoles.userId, body.data.supportUserId),
              eq(platformUserRoles.role, "SUPPORT"),
            ),
          )
          .limit(1);
        if (!hasSupportRole) return undefined;
        const [created] = await transaction
          .insert(supportAccessGrants)
          .values({
            organizationId: path.data.organizationId,
            supportUserId: body.data.supportUserId,
            grantedByUserId: auth.userId,
            reason: body.data.reason,
            expiresAt,
          })
          .returning();
        if (created) {
          await writeAudit(transaction, {
            actorUserId: auth.userId,
            organizationId: created.organizationId,
            action: "SUPPORT_ORGANIZATION_ACCESS_GRANTED",
            resourceId: created.id,
            requestId: request.id,
          });
        }
        return created;
      });
      if (!grant)
        return apiError(
          reply,
          404,
          "NOT_FOUND",
          "Support staff identity was not found.",
        );
      return reply.status(201).send({ grant });
    },
  );

  app.delete(
    "/platform/support/grants/:grantId",
    protectedOptions,
    async (request, reply) => {
      const auth = request.auth;
      const path = grantIdSchema.safeParse(request.params);
      if (!auth)
        return apiError(
          reply,
          401,
          "UNAUTHORIZED",
          "Authentication is required.",
        );
      if (!path.success)
        return apiError(
          reply,
          400,
          "BAD_REQUEST",
          "Invalid support grant identifier.",
        );
      if (
        !(await hasSupportPermission(
          database,
          auth.userId,
          supportPermissions.organizationGrant,
        ))
      ) {
        return apiError(
          reply,
          403,
          "FORBIDDEN",
          "Root administrator access is required.",
        );
      }
      if (!auth.mfaVerifiedAt) {
        return apiError(
          reply,
          403,
          "MFA_REQUIRED",
          "Root administrator MFA verification is required.",
        );
      }
      const revoked = await database.transaction(async (transaction) => {
        await setActor(transaction, auth.userId);
        const [current] = await transaction
          .select()
          .from(supportAccessGrants)
          .where(eq(supportAccessGrants.id, path.data.grantId))
          .limit(1);
        if (!current) return undefined;
        await setOrganization(transaction, current.organizationId);
        const [result] = await transaction
          .update(supportAccessGrants)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(supportAccessGrants.id, current.id),
              isNull(supportAccessGrants.revokedAt),
            ),
          )
          .returning();
        await writeAudit(transaction, {
          actorUserId: auth.userId,
          organizationId: current.organizationId,
          action: "SUPPORT_ORGANIZATION_ACCESS_REVOKED",
          resourceId: current.id,
          requestId: request.id,
        });
        return result ?? current;
      });
      if (!revoked)
        return apiError(
          reply,
          404,
          "NOT_FOUND",
          "Support grant was not found.",
        );
      return reply.status(204).send();
    },
  );
}

async function writeMessage(
  database: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  visibility: "CUSTOMER" | "INTERNAL",
) {
  const auth = request.auth;
  const path = requestIdSchema.safeParse(request.params);
  const body = messageSchema.safeParse(request.body);
  if (!auth)
    return apiError(reply, 401, "UNAUTHORIZED", "Authentication is required.");
  if (!path.success || !body.success)
    return apiError(reply, 400, "BAD_REQUEST", "Invalid support message.");
  if (
    !(await hasSupportPermission(
      database,
      auth.userId,
      visibility === "INTERNAL"
        ? supportPermissions.internalNote
        : supportPermissions.requestReply,
    )) &&
    !(auth.organizationId && auth.membershipId)
  ) {
    return apiError(
      reply,
      403,
      "FORBIDDEN",
      "Support request reply access is required.",
    );
  }
  const supportStaff = await hasSupportPermission(
    database,
    auth.userId,
    supportPermissions.requestReply,
  );
  if (supportStaff && !auth.mfaVerifiedAt) {
    return apiError(
      reply,
      403,
      "MFA_REQUIRED",
      "Support staff MFA verification is required.",
    );
  }
  if (visibility === "INTERNAL" && !supportStaff) {
    return apiError(
      reply,
      403,
      "FORBIDDEN",
      "Support staff access is required.",
    );
  }

  const result = await database.transaction(async (transaction) => {
    await setActor(transaction, auth.userId, auth.organizationId);
    const [ticket] = await transaction
      .select()
      .from(supportRequests)
      .where(eq(supportRequests.id, path.data.requestId))
      .limit(1);
    if (!ticket) return undefined;
    await setOrganization(transaction, ticket.organizationId);
    const [message] = await transaction
      .insert(supportMessages)
      .values({
        organizationId: ticket.organizationId,
        requestId: ticket.id,
        authorUserId: auth.userId,
        visibility,
        body: body.data.body,
      })
      .returning({
        id: supportMessages.id,
        requestId: supportMessages.requestId,
        visibility: supportMessages.visibility,
        body: supportMessages.body,
        createdAt: supportMessages.createdAt,
      });
    if (!message) throw new Error("Support message creation returned no row");
    await transaction
      .update(supportRequests)
      .set({ updatedAt: new Date() })
      .where(eq(supportRequests.id, ticket.id));
    await writeAudit(transaction, {
      actorUserId: auth.userId,
      organizationId: ticket.organizationId,
      action:
        visibility === "INTERNAL"
          ? "SUPPORT_INTERNAL_NOTE_ADDED"
          : "SUPPORT_CUSTOMER_REPLY_ADDED",
      resourceId: ticket.id,
      requestId: request.id,
    });
    return message;
  });
  if (!result)
    return apiError(reply, 404, "NOT_FOUND", "Support request was not found.");
  return reply.status(201).send({ message: result });
}

async function setActor(
  transaction: OrganizationTransaction,
  userId: string,
  organizationId?: string | null,
) {
  await transaction.execute(
    sql`select set_config('app.current_user_id', ${userId}, true)`,
  );
  if (organizationId) await setOrganization(transaction, organizationId);
}

async function setOrganization(
  transaction: OrganizationTransaction,
  organizationId: string,
) {
  await transaction.execute(
    sql`select set_config('app.current_organization_id', ${organizationId}, true)`,
  );
}

async function isSupportStaff(
  database: Database,
  userId: string,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    await setActor(transaction, userId);
    const [role] = await transaction
      .select({ userId: platformUserRoles.userId })
      .from(platformUserRoles)
      .where(
        and(
          eq(platformUserRoles.userId, userId),
          eq(platformUserRoles.role, "SUPPORT"),
        ),
      )
      .limit(1);
    return Boolean(role);
  });
}

async function hasSupportPermission(
  database: Database,
  userId: string,
  permission: SupportPermission,
  context?: Pick<
    AuthenticatedRequestContext,
    "organizationId" | "membershipId"
  >,
): Promise<boolean> {
  if (
    permission === supportPermissions.staffManage ||
    permission === supportPermissions.organizationGrant ||
    permission === supportPermissions.requestAssign
  ) {
    return isRootAdministrator(database, userId);
  }
  if (permission === supportPermissions.requestCreate) {
    return Boolean(context?.organizationId && context.membershipId);
  }
  return isSupportStaff(database, userId);
}

async function isRootAdministrator(
  database: Database,
  userId: string,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    await setActor(transaction, userId);
    const [root] = await transaction
      .select({ userId: supportRootAdministrators.userId })
      .from(supportRootAdministrators)
      .where(eq(supportRootAdministrators.userId, userId))
      .limit(1);
    return Boolean(root);
  });
}

async function hasActiveGrant(
  database: Database,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    await setActor(transaction, userId, organizationId);
    return hasActiveGrantInTransaction(transaction, userId, organizationId);
  });
}

async function hasActiveGrantInTransaction(
  transaction: OrganizationTransaction,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const [grant] = await transaction
    .select({ id: supportAccessGrants.id })
    .from(supportAccessGrants)
    .where(
      and(
        eq(supportAccessGrants.supportUserId, userId),
        eq(supportAccessGrants.organizationId, organizationId),
        isNull(supportAccessGrants.revokedAt),
        gt(supportAccessGrants.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(grant);
}

async function writeAudit(
  transaction: OrganizationTransaction,
  event: {
    actorUserId: string;
    organizationId: string;
    action: string;
    resourceId: string;
    requestId: string;
  },
) {
  await transaction.insert(auditLogs).values({
    organizationId: event.organizationId,
    actorUserId: event.actorUserId,
    action: event.action,
    resource: "support",
    resourceId: event.resourceId,
    requestMetadata: { requestId: event.requestId },
    result: "SUCCESS",
  });
}

async function writePlatformAudit(
  transaction: OrganizationTransaction,
  actorUserId: string,
  action: string,
  resourceId: string,
  requestId: string,
) {
  await transaction.insert(auditLogs).values({
    organizationId: null,
    actorUserId,
    action,
    resource: "authentication",
    resourceId,
    requestMetadata: { requestId },
    result: "SUCCESS",
  });
}

async function writeDeniedSupportAccessAudit(
  transaction: OrganizationTransaction,
  actorUserId: string,
  resourceId: string,
  requestId: string,
) {
  await transaction.insert(auditLogs).values({
    organizationId: null,
    actorUserId,
    action: "SUPPORT_REQUEST_ACCESS_DENIED",
    resource: "authentication",
    resourceId,
    requestMetadata: { requestId },
    result: "FAILURE",
  });
}
