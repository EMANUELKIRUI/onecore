import { and, eq, exists, gt, isNull, lte, lt, sql } from "drizzle-orm";
import {
  auditLogs,
  branches,
  membershipBranches,
  organizations,
  organizationMemberships,
  sessions,
  users,
  type Database,
} from "./index.js";
import {
  withActiveBranchTransaction,
  withActiveOrganizationTransaction,
  withAuthenticatedUserTransaction,
  withLoginTransaction,
  withSessionTransaction,
  type OrganizationTransaction,
} from "./tenant-context.js";
import { z } from "zod";

export interface IdentityUser {
  id: string;
  email: string;
  displayName: string;
  status: (typeof users.$inferSelect)["status"];
  passwordHash: string | null;
  failedLoginAttempts: number;
  failedLoginWindowStartedAt: Date | null;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
}

export interface IdentitySession {
  id: string;
  secretHash: string;
  userId: string;
  organizationId: string | null;
  branchId: string | null;
  expiresAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface IdentityMembership {
  membershipId: string;
  organizationId: string;
  name: string;
  slug: string;
  branchAccessMode: (typeof organizationMemberships.$inferSelect)["branchAccessMode"];
}

export interface IdentityBranch {
  branchId: string;
  name: string;
  code: string;
}

export interface AuthenticationAuditEvent {
  action: string;
  actorUserId?: string | null;
  organizationId?: string | null;
  resourceId?: string;
  result: "SUCCESS" | "FAILURE";
  requestId: string;
  reason?: string;
  ipAddress: string;
  userAgent: string;
  occurredAt: Date;
}

export interface IdentityRepository {
  findUserByEmail(email: string): Promise<IdentityUser | undefined>;
  findUserById(userId: string): Promise<IdentityUser | undefined>;
  activateExpiredLock(
    userId: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<boolean>;
  recordFailedLogin(
    email: string,
    now: Date,
    windowMs: number,
    threshold: number,
    lockMs: number,
    requestId: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<{ userId: string; locked: boolean } | undefined>;
  createSession(
    session: Omit<IdentitySession, "id" | "lastUsedAt" | "revokedAt">,
    requestId: string,
    now: Date,
  ): Promise<IdentitySession>;
  findActiveSession(
    secretHash: string,
    now: Date,
  ): Promise<{ session: IdentitySession; user: IdentityUser } | undefined>;
  touchSession(secretHash: string, now: Date): Promise<void>;
  clearSessionOrganization(
    secretHash: string,
    expectedOrganizationId: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<void>;
  clearSessionBranch(
    secretHash: string,
    expectedBranchId: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<void>;
  revokeSession(
    secretHash: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<void>;
  listActiveMemberships(userId: string): Promise<IdentityMembership[]>;
  listAuthorizedBranches(
    userId: string,
    organizationId: string,
  ): Promise<IdentityBranch[]>;
  selectOrganization(
    userId: string,
    secretHash: string,
    organizationId: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<IdentityMembership | undefined>;
  selectBranch(
    userId: string,
    secretHash: string,
    organizationId: string,
    branchId: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<IdentityBranch | undefined>;
  recordAuthenticationEvent(event: AuthenticationAuditEvent): Promise<void>;
}

function toIdentityUser(user: typeof users.$inferSelect): IdentityUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    passwordHash: user.passwordHash,
    failedLoginAttempts: user.failedLoginAttempts,
    failedLoginWindowStartedAt: user.failedLoginWindowStartedAt,
    lockedUntil: user.lockedUntil,
    lastLoginAt: user.lastLoginAt,
  };
}

function toIdentitySession(
  session: typeof sessions.$inferSelect,
): IdentitySession {
  return {
    id: session.id,
    secretHash: session.secretHash,
    userId: session.userId,
    organizationId: session.organizationId,
    branchId: session.branchId,
    expiresAt: session.expiresAt,
    lastUsedAt: session.lastUsedAt,
    revokedAt: session.revokedAt,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
  };
}

function writeAuthenticationEvent(
  transaction: OrganizationTransaction,
  event: AuthenticationAuditEvent,
) {
  return transaction.insert(auditLogs).values({
    organizationId: event.organizationId ?? null,
    actorUserId: event.actorUserId ?? null,
    action: event.action,
    resource: "authentication",
    resourceId: event.resourceId ?? event.actorUserId ?? "unknown",
    occurredAt: event.occurredAt,
    requestMetadata: {
      requestId: event.requestId,
      reason: event.reason ?? null,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
    },
    result: event.result,
  });
}

export function createIdentityRepository(
  database: Database,
): IdentityRepository {
  return {
    async findUserByEmail(email) {
      const user = await withLoginTransaction(database, email, (transaction) =>
        transaction
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = ${email}`)
          .limit(1)
          .then(([found]) => found),
      );
      return user ? toIdentityUser(user) : undefined;
    },
    async findUserById(userId) {
      const user = await withAuthenticatedUserTransaction(
        database,
        userId,
        async (transaction) => {
          const [found] = await transaction
            .select()
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          return found;
        },
      );
      return user ? toIdentityUser(user) : undefined;
    },
    async activateExpiredLock(userId, requestId, ipAddress, userAgent, now) {
      return withAuthenticatedUserTransaction(
        database,
        userId,
        async (transaction) => {
          const [user] = await transaction
            .update(users)
            .set({
              status: "ACTIVE",
              failedLoginAttempts: 0,
              failedLoginWindowStartedAt: null,
              lockedUntil: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(users.id, userId),
                eq(users.status, "LOCKED"),
                lte(users.lockedUntil, now),
              ),
            )
            .returning({ id: users.id });
          if (user) {
            await writeAuthenticationEvent(transaction, {
              action: "AUTH_ACCOUNT_UNLOCKED",
              actorUserId: user.id,
              result: "SUCCESS",
              requestId,
              ipAddress,
              userAgent,
              occurredAt: now,
              reason: "automatic_lockout_expired",
            });
          }
          return user !== undefined;
        },
      );
    },
    async recordFailedLogin(
      email,
      now,
      windowMs,
      threshold,
      lockMs,
      requestId,
      ipAddress,
      userAgent,
    ) {
      const windowStart = new Date(now.getTime() - windowMs);
      const shouldReset = sql`
        ${users.failedLoginWindowStartedAt} IS NULL
        OR ${users.failedLoginWindowStartedAt} <= ${windowStart}
      `;
      const incremented = sql<number>`
        CASE WHEN ${shouldReset} THEN 1 ELSE ${users.failedLoginAttempts} + 1 END
      `;
      const failedLogin = await withLoginTransaction(
        database,
        email,
        async (transaction) => {
          const [user] = await transaction
            .update(users)
            .set({
              failedLoginAttempts: incremented,
              failedLoginWindowStartedAt: sql`
              CASE WHEN ${shouldReset} THEN ${now} ELSE ${users.failedLoginWindowStartedAt} END
            `,
              status: sql`
              CASE WHEN ${incremented} >= ${threshold}
                THEN 'LOCKED'::user_account_status
                ELSE ${users.status}
              END
            `,
              lockedUntil: sql`
              CASE WHEN ${incremented} >= ${threshold}
                THEN ${now} + (${lockMs} * interval '1 millisecond')
                ELSE ${users.lockedUntil}
              END
            `,
              updatedAt: now,
            })
            .where(
              and(
                sql`lower(${users.email}) = ${email}`,
                eq(users.status, "ACTIVE"),
              ),
            )
            .returning({ id: users.id, status: users.status });
          if (!user) return undefined;
          await writeAuthenticationEvent(transaction, {
            action: "AUTH_LOGIN_FAILURE",
            actorUserId: user.id,
            result: "FAILURE",
            requestId,
            ipAddress,
            userAgent,
            occurredAt: now,
            reason: "invalid_credentials",
          });
          if (user.status === "LOCKED") {
            await writeAuthenticationEvent(transaction, {
              action: "AUTH_ACCOUNT_LOCKED",
              actorUserId: user.id,
              result: "SUCCESS",
              requestId,
              ipAddress,
              userAgent,
              occurredAt: now,
              reason: "failed_login_threshold",
            });
          }
          return { userId: user.id, locked: user.status === "LOCKED" };
        },
      );
      return failedLogin;
    },
    async createSession(session, requestId, now) {
      return withAuthenticatedUserTransaction(
        database,
        session.userId,
        async (transaction) => {
          const [updatedUser] = await transaction
            .update(users)
            .set({
              failedLoginAttempts: 0,
              failedLoginWindowStartedAt: null,
              lockedUntil: null,
              lastLoginAt: now,
              updatedAt: now,
            })
            .where(
              and(eq(users.id, session.userId), eq(users.status, "ACTIVE")),
            )
            .returning({ id: users.id });
          if (!updatedUser) throw new Error("Active user changed during login");
          const [created] = await transaction
            .insert(sessions)
            .values({
              secretHash: session.secretHash,
              userId: session.userId,
              organizationId: session.organizationId,
              branchId: session.branchId,
              expiresAt: session.expiresAt,
              ipAddress: session.ipAddress,
              userAgent: session.userAgent,
              createdAt: now,
              lastUsedAt: now,
            })
            .returning();
          if (!created) throw new Error("Session insert did not return a row");
          await writeAuthenticationEvent(transaction, {
            action: "AUTH_SESSION_CREATED",
            actorUserId: session.userId,
            organizationId: session.organizationId,
            result: "SUCCESS",
            requestId,
            ipAddress: session.ipAddress ?? "",
            userAgent: session.userAgent ?? "",
            occurredAt: now,
          });
          await writeAuthenticationEvent(transaction, {
            action: "AUTH_LOGIN_SUCCESS",
            actorUserId: session.userId,
            result: "SUCCESS",
            requestId,
            ipAddress: session.ipAddress ?? "",
            userAgent: session.userAgent ?? "",
            occurredAt: now,
          });
          return toIdentitySession(created);
        },
      );
    },
    async findActiveSession(secretHash, now) {
      return withSessionTransaction(
        database,
        secretHash,
        async (transaction) => {
          const [session] = await transaction
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.secretHash, secretHash),
                isNull(sessions.revokedAt),
                gt(sessions.expiresAt, now),
              ),
            )
            .limit(1);
          if (!session) return undefined;
          await transaction.execute(
            sql`select set_config('app.current_user_id', ${session.userId}, true)`,
          );
          const [user] = await transaction
            .select()
            .from(users)
            .where(
              and(eq(users.id, session.userId), eq(users.status, "ACTIVE")),
            )
            .limit(1);
          return user
            ? {
                session: toIdentitySession(session),
                user: toIdentityUser(user),
              }
            : undefined;
        },
      );
    },
    async touchSession(secretHash, now) {
      await withSessionTransaction(database, secretHash, (transaction) =>
        transaction
          .update(sessions)
          .set({ lastUsedAt: now })
          .where(
            and(
              eq(sessions.secretHash, secretHash),
              isNull(sessions.revokedAt),
              lt(sessions.lastUsedAt, new Date(now.getTime() - 5 * 60_000)),
            ),
          )
          .then(() => undefined),
      );
    },
    async clearSessionOrganization(
      secretHash,
      expectedOrganizationId,
      requestId,
      ipAddress,
      userAgent,
      now,
    ) {
      await withSessionTransaction(
        database,
        secretHash,
        async (transaction) => {
          const [cleared] = await transaction
            .update(sessions)
            .set({ organizationId: null, branchId: null })
            .where(
              and(
                eq(sessions.secretHash, secretHash),
                eq(sessions.organizationId, expectedOrganizationId),
                isNull(sessions.revokedAt),
                gt(sessions.expiresAt, now),
              ),
            )
            .returning({ userId: sessions.userId });
          if (!cleared) return;
          await writeAuthenticationEvent(transaction, {
            action: "AUTH_ORGANIZATION_CONTEXT_CLEARED",
            actorUserId: cleared.userId,
            resourceId: expectedOrganizationId,
            result: "SUCCESS",
            requestId,
            ipAddress,
            userAgent,
            reason: "active_membership_or_organization_required",
            occurredAt: now,
          });
        },
      );
    },
    async clearSessionBranch(
      secretHash,
      expectedBranchId,
      requestId,
      ipAddress,
      userAgent,
      now,
    ) {
      await withSessionTransaction(
        database,
        secretHash,
        async (transaction) => {
          const [cleared] = await transaction
            .update(sessions)
            .set({ branchId: null })
            .where(
              and(
                eq(sessions.secretHash, secretHash),
                eq(sessions.branchId, expectedBranchId),
                isNull(sessions.revokedAt),
                gt(sessions.expiresAt, now),
              ),
            )
            .returning({ userId: sessions.userId });
          if (!cleared) return;
          await writeAuthenticationEvent(transaction, {
            action: "AUTH_BRANCH_CONTEXT_CLEARED",
            actorUserId: cleared.userId,
            resourceId: expectedBranchId,
            result: "SUCCESS",
            requestId,
            ipAddress,
            userAgent,
            reason: "active_branch_access_required",
            occurredAt: now,
          });
        },
      );
    },
    async revokeSession(secretHash, requestId, ipAddress, userAgent, now) {
      const session = await withSessionTransaction(
        database,
        secretHash,
        async (transaction) => {
          const [revoked] = await transaction
            .update(sessions)
            .set({ revokedAt: now })
            .where(
              and(
                eq(sessions.secretHash, secretHash),
                isNull(sessions.revokedAt),
              ),
            )
            .returning({ userId: sessions.userId });
          if (!revoked) return undefined;
          await writeAuthenticationEvent(transaction, {
            action: "AUTH_SESSION_REVOKED",
            actorUserId: revoked.userId,
            result: "SUCCESS",
            requestId,
            ipAddress,
            userAgent,
            occurredAt: now,
          });
          await writeAuthenticationEvent(transaction, {
            action: "AUTH_LOGOUT",
            actorUserId: revoked.userId,
            result: "SUCCESS",
            requestId,
            ipAddress,
            userAgent,
            occurredAt: now,
          });
          return revoked;
        },
      );
      if (!session) return;
    },
    async listActiveMemberships(userId) {
      return withAuthenticatedUserTransaction(
        database,
        userId,
        async (transaction) =>
          transaction
            .select({
              membershipId: organizationMemberships.id,
              organizationId: organizationMemberships.organizationId,
              name: organizations.name,
              slug: organizations.slug,
              branchAccessMode: organizationMemberships.branchAccessMode,
            })
            .from(organizationMemberships)
            .innerJoin(
              organizations,
              eq(organizationMemberships.organizationId, organizations.id),
            )
            .where(
              and(
                eq(organizationMemberships.userId, userId),
                eq(organizationMemberships.status, "ACTIVE"),
                eq(organizations.status, "ACTIVE"),
              ),
            ),
      );
    },
    async listAuthorizedBranches(userId, organizationId) {
      const branchesForMembership = await withActiveOrganizationTransaction(
        database,
        userId,
        organizationId,
        async (transaction, membership) => {
          const conditions = [
            eq(branches.organizationId, organizationId),
            eq(branches.status, "ACTIVE"),
          ];
          if (membership.branchAccessMode !== "ALL") {
            conditions.push(
              exists(
                transaction
                  .select({ one: sql`1` })
                  .from(membershipBranches)
                  .where(
                    and(
                      eq(membershipBranches.organizationId, organizationId),
                      eq(
                        membershipBranches.membershipId,
                        membership.membershipId,
                      ),
                      eq(membershipBranches.branchId, branches.id),
                    ),
                  ),
              ),
            );
          }
          return transaction
            .select({
              branchId: branches.id,
              name: branches.name,
              code: branches.code,
            })
            .from(branches)
            .where(and(...conditions));
        },
      );
      return branchesForMembership ?? [];
    },
    async selectOrganization(
      userId,
      secretHash,
      organizationId,
      requestId,
      ipAddress,
      userAgent,
      now,
    ) {
      return withActiveOrganizationTransaction(
        database,
        userId,
        organizationId,
        async (transaction, verifiedMembership) => {
          const [organization] = await transaction
            .select({
              name: organizations.name,
              slug: organizations.slug,
            })
            .from(organizations)
            .where(eq(organizations.id, organizationId))
            .limit(1);
          if (!organization) return undefined;
          const trustedSecretHash = z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .parse(secretHash);
          await transaction.execute(
            sql`select set_config('app.current_session_hash', ${trustedSecretHash}, true)`,
          );
          const [updated] = await transaction
            .update(sessions)
            .set({ organizationId, branchId: null })
            .where(
              and(
                eq(sessions.secretHash, trustedSecretHash),
                eq(sessions.userId, userId),
                isNull(sessions.revokedAt),
                gt(sessions.expiresAt, now),
              ),
            )
            .returning({ id: sessions.id });
          if (!updated) return undefined;
          await writeAuthenticationEvent(transaction, {
            action: "AUTH_ORGANIZATION_SELECTED",
            actorUserId: userId,
            organizationId,
            result: "SUCCESS",
            requestId,
            ipAddress,
            userAgent,
            occurredAt: now,
          });
          return {
            ...verifiedMembership,
            ...organization,
          };
        },
      );
    },
    async selectBranch(
      userId,
      secretHash,
      organizationId,
      branchId,
      requestId,
      ipAddress,
      userAgent,
      now,
    ) {
      return withActiveBranchTransaction(
        database,
        userId,
        organizationId,
        branchId,
        async (transaction, _membership, branch) => {
          const trustedSecretHash = z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .parse(secretHash);
          await transaction.execute(
            sql`select set_config('app.current_session_hash', ${trustedSecretHash}, true)`,
          );
          const [updated] = await transaction
            .update(sessions)
            .set({ branchId })
            .where(
              and(
                eq(sessions.secretHash, trustedSecretHash),
                eq(sessions.userId, userId),
                eq(sessions.organizationId, organizationId),
                isNull(sessions.revokedAt),
                gt(sessions.expiresAt, now),
              ),
            )
            .returning({ id: sessions.id });
          if (!updated) return undefined;
          await writeAuthenticationEvent(transaction, {
            action: "AUTH_BRANCH_SELECTED",
            actorUserId: userId,
            organizationId,
            resourceId: branchId,
            result: "SUCCESS",
            requestId,
            ipAddress,
            userAgent,
            occurredAt: now,
          });
          return branch;
        },
      );
    },
    async recordAuthenticationEvent(event) {
      await database.transaction((transaction) =>
        writeAuthenticationEvent(transaction, event),
      );
    },
  };
}
