import { and, eq, exists, gt, isNull, lte, lt, sql } from "drizzle-orm";
import {
  auditLogs,
  branches,
  membershipBranches,
  membershipRoles,
  organizations,
  organizationMemberships,
  ownerCredentialSetupTokens,
  platformUserRoles,
  roles,
  sessions,
  users,
  userMfaCredentials,
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
  platformRoles?: string[];
}

export interface IdentityMfaCredential {
  secretEncrypted: string;
  enabledAt: Date | null;
  enrollmentExpiresAt: Date;
  lastTotpStep: number | null;
}

export interface IdentitySession {
  id: string;
  secretHash: string;
  userId: string;
  organizationId: string | null;
  branchId: string | null;
  expiresAt: Date;
  mfaVerifiedAt?: Date | null;
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
  correlationId?: string | undefined;
  reason?: string;
  ipAddress: string;
  userAgent: string;
  occurredAt: Date;
}

export interface IdentityRepository {
  issueOwnerCredentialSetup(
    organizationId: string,
    actorUserId: string,
    tokenHash: string,
    expiresAt: Date,
    event: AuthenticationAuditEvent,
  ): Promise<Pick<IdentityUser, "id" | "email" | "displayName"> | undefined>;
  completeOwnerCredentialSetup(
    tokenHash: string,
    passwordHash: string,
    event: AuthenticationAuditEvent,
  ): Promise<boolean>;
  userRequiresMfa(userId: string): Promise<boolean>;
  getMfaCredential(userId: string): Promise<IdentityMfaCredential | null>;
  storeMfaSecret(
    userId: string,
    secretEncrypted: string,
    enrollmentExpiresAt: Date,
  ): Promise<void>;
  completeMfaEnrollment(
    userId: string,
    acceptedTotpStep: number,
    event: AuthenticationAuditEvent,
  ): Promise<boolean>;
  consumeMfaTotpStep(
    userId: string,
    acceptedTotpStep: number,
    event: AuthenticationAuditEvent,
  ): Promise<boolean>;
  findUserByEmail(email: string): Promise<IdentityUser | undefined>;
  findUserById(userId: string): Promise<IdentityUser | undefined>;
  activateExpiredLock(
    userId: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
    correlationId?: string,
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
    correlationId?: string,
  ): Promise<{ userId: string; locked: boolean } | undefined>;
  createSession(
    session: Omit<IdentitySession, "id" | "lastUsedAt" | "revokedAt">,
    requestId: string,
    now: Date,
    correlationId?: string,
    mfaVerified?: boolean,
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
    correlationId?: string,
  ): Promise<void>;
  changePasswordAndRevokeSessions(
    userId: string,
    currentSessionHash: string,
    expectedPasswordHash: string,
    newPasswordHash: string,
    event: AuthenticationAuditEvent,
  ): Promise<boolean>;
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
    mfaVerifiedAt: session.mfaVerifiedAt,
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
      correlationId: event.correlationId ?? null,
      reason: event.reason ?? null,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
    },
    result: event.result,
  });
}

async function requiresMfaInTransaction(
  transaction: OrganizationTransaction,
  userId: string,
): Promise<boolean> {
  const [platformRole] = await transaction
    .select({ role: platformUserRoles.role })
    .from(platformUserRoles)
    .where(
      and(
        eq(platformUserRoles.userId, userId),
        eq(platformUserRoles.role, "SUPERADMIN"),
      ),
    )
    .limit(1);
  if (platformRole) return true;

  const memberships = await transaction
    .select({
      membershipId: organizationMemberships.id,
      organizationId: organizationMemberships.organizationId,
    })
    .from(organizationMemberships)
    .innerJoin(
      organizations,
      eq(organizations.id, organizationMemberships.organizationId),
    )
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "ACTIVE"),
        eq(organizations.status, "ACTIVE"),
      ),
    );

  for (const membership of memberships) {
    await transaction.execute(
      sql`select set_config('app.current_organization_id', ${membership.organizationId}, true)`,
    );
    const [privilegedRole] = await transaction
      .select({ roleId: membershipRoles.roleId })
      .from(membershipRoles)
      .innerJoin(
        roles,
        and(
          eq(roles.organizationId, membershipRoles.organizationId),
          eq(roles.id, membershipRoles.roleId),
        ),
      )
      .where(
        and(
          eq(membershipRoles.organizationId, membership.organizationId),
          eq(membershipRoles.membershipId, membership.membershipId),
          eq(roles.status, "ACTIVE"),
          eq(roles.isSystem, true),
          sql`${roles.name} IN ('Organization Owner', 'Organization Admin')`,
        ),
      )
      .limit(1);
    if (privilegedRole) return true;
  }
  return false;
}

function toIdentityMfaCredential(
  credential: typeof userMfaCredentials.$inferSelect,
): IdentityMfaCredential {
  return {
    secretEncrypted: credential.secretEncrypted,
    enabledAt: credential.enabledAt,
    enrollmentExpiresAt: credential.enrollmentExpiresAt,
    lastTotpStep: credential.lastTotpStep,
  };
}

export function createIdentityRepository(
  database: Database,
): IdentityRepository {
  return {
    async issueOwnerCredentialSetup(
      organizationId,
      actorUserId,
      tokenHash,
      expiresAt,
      event,
    ) {
      const trustedOrganizationId = z.uuid().parse(organizationId);
      const trustedActorUserId = z.uuid().parse(actorUserId);
      const trustedTokenHash = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(tokenHash);
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select set_config('app.current_user_id', ${trustedActorUserId}, true)`,
        );
        const [superadmin] = await transaction
          .select({ userId: platformUserRoles.userId })
          .from(platformUserRoles)
          .where(
            and(
              eq(platformUserRoles.userId, trustedActorUserId),
              eq(platformUserRoles.role, "SUPERADMIN"),
            ),
          )
          .limit(1);
        if (!superadmin) return undefined;

        await transaction.execute(
          sql`select set_config('app.current_organization_id', ${trustedOrganizationId}, true)`,
        );
        const [ownerMembership] = await transaction
          .select({ userId: organizationMemberships.userId })
          .from(organizationMemberships)
          .innerJoin(
            organizations,
            eq(organizations.id, organizationMemberships.organizationId),
          )
          .innerJoin(
            membershipRoles,
            and(
              eq(
                membershipRoles.organizationId,
                organizationMemberships.organizationId,
              ),
              eq(membershipRoles.membershipId, organizationMemberships.id),
            ),
          )
          .innerJoin(
            roles,
            and(
              eq(roles.organizationId, membershipRoles.organizationId),
              eq(roles.id, membershipRoles.roleId),
            ),
          )
          .where(
            and(
              eq(organizationMemberships.organizationId, trustedOrganizationId),
              eq(organizationMemberships.status, "INVITED"),
              eq(organizations.status, "ACTIVE"),
              sql`${organizations.profile}->'application' IS NOT NULL`,
              eq(roles.name, "Organization Owner"),
              eq(roles.status, "ACTIVE"),
              eq(roles.isSystem, true),
            ),
          )
          .limit(1);
        if (!ownerMembership) return undefined;

        await transaction.execute(
          sql`select set_config('app.current_user_id', ${ownerMembership.userId}, true)`,
        );
        const [owner] = await transaction
          .select({
            id: users.id,
            email: users.email,
            displayName: users.displayName,
          })
          .from(users)
          .where(
            and(
              eq(users.id, ownerMembership.userId),
              eq(users.status, "PENDING"),
              isNull(users.passwordHash),
            ),
          )
          .for("update")
          .limit(1);
        if (!owner) return undefined;

        const [stillInvited] = await transaction
          .select({ membershipId: organizationMemberships.id })
          .from(organizationMemberships)
          .innerJoin(
            membershipRoles,
            and(
              eq(
                membershipRoles.organizationId,
                organizationMemberships.organizationId,
              ),
              eq(membershipRoles.membershipId, organizationMemberships.id),
            ),
          )
          .innerJoin(
            roles,
            and(
              eq(roles.organizationId, membershipRoles.organizationId),
              eq(roles.id, membershipRoles.roleId),
            ),
          )
          .where(
            and(
              eq(organizationMemberships.organizationId, trustedOrganizationId),
              eq(organizationMemberships.userId, owner.id),
              eq(organizationMemberships.status, "INVITED"),
              eq(roles.name, "Organization Owner"),
              eq(roles.status, "ACTIVE"),
              eq(roles.isSystem, true),
            ),
          )
          .limit(1);
        if (!stillInvited) return undefined;

        await transaction
          .update(ownerCredentialSetupTokens)
          .set({ revokedAt: event.occurredAt })
          .where(
            and(
              eq(ownerCredentialSetupTokens.userId, owner.id),
              eq(
                ownerCredentialSetupTokens.organizationId,
                trustedOrganizationId,
              ),
              isNull(ownerCredentialSetupTokens.consumedAt),
              isNull(ownerCredentialSetupTokens.revokedAt),
            ),
          );
        await transaction.insert(ownerCredentialSetupTokens).values({
          userId: owner.id,
          organizationId: trustedOrganizationId,
          tokenHash: trustedTokenHash,
          createdByUserId: trustedActorUserId,
          expiresAt,
        });
        await writeAuthenticationEvent(transaction, {
          ...event,
          action: "AUTH_OWNER_SETUP_INVITATION_ISSUED",
          actorUserId: trustedActorUserId,
          organizationId: trustedOrganizationId,
          resourceId: owner.id,
          result: "SUCCESS",
        });
        return owner;
      });
    },
    async completeOwnerCredentialSetup(tokenHash, passwordHash, event) {
      const trustedTokenHash = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(tokenHash);
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select set_config('app.owner_setup_token_hash', ${trustedTokenHash}, true)`,
        );
        const [candidate] = await transaction
          .select({
            userId: ownerCredentialSetupTokens.userId,
            organizationId: ownerCredentialSetupTokens.organizationId,
          })
          .from(ownerCredentialSetupTokens)
          .where(eq(ownerCredentialSetupTokens.tokenHash, trustedTokenHash))
          .limit(1);
        if (!candidate) return false;

        await transaction.execute(
          sql`select set_config('app.current_user_id', ${candidate.userId}, true)`,
        );
        await transaction.execute(
          sql`select set_config('app.current_organization_id', ${candidate.organizationId}, true)`,
        );
        const [owner] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.id, candidate.userId),
              eq(users.status, "PENDING"),
              isNull(users.passwordHash),
            ),
          )
          .for("update")
          .limit(1);
        if (!owner) return false;

        const [token] = await transaction
          .select({ id: ownerCredentialSetupTokens.id })
          .from(ownerCredentialSetupTokens)
          .where(
            and(
              eq(ownerCredentialSetupTokens.tokenHash, trustedTokenHash),
              eq(ownerCredentialSetupTokens.userId, candidate.userId),
              eq(
                ownerCredentialSetupTokens.organizationId,
                candidate.organizationId,
              ),
              gt(ownerCredentialSetupTokens.expiresAt, event.occurredAt),
              isNull(ownerCredentialSetupTokens.consumedAt),
              isNull(ownerCredentialSetupTokens.revokedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (!token) return false;

        const [ownerMembership] = await transaction
          .select({ membershipId: organizationMemberships.id })
          .from(organizationMemberships)
          .innerJoin(
            organizations,
            eq(organizations.id, organizationMemberships.organizationId),
          )
          .innerJoin(
            membershipRoles,
            and(
              eq(
                membershipRoles.organizationId,
                organizationMemberships.organizationId,
              ),
              eq(membershipRoles.membershipId, organizationMemberships.id),
            ),
          )
          .innerJoin(
            roles,
            and(
              eq(roles.organizationId, membershipRoles.organizationId),
              eq(roles.id, membershipRoles.roleId),
            ),
          )
          .where(
            and(
              eq(
                organizationMemberships.organizationId,
                candidate.organizationId,
              ),
              eq(organizationMemberships.userId, candidate.userId),
              eq(organizationMemberships.status, "INVITED"),
              eq(organizations.status, "ACTIVE"),
              sql`${organizations.profile}->'application' IS NOT NULL`,
              eq(roles.name, "Organization Owner"),
              eq(roles.status, "ACTIVE"),
              eq(roles.isSystem, true),
            ),
          )
          .for("update", { of: organizationMemberships })
          .limit(1);
        if (!ownerMembership) return false;

        const [consumed] = await transaction
          .update(ownerCredentialSetupTokens)
          .set({ consumedAt: event.occurredAt })
          .where(
            and(
              eq(ownerCredentialSetupTokens.id, token.id),
              isNull(ownerCredentialSetupTokens.consumedAt),
              isNull(ownerCredentialSetupTokens.revokedAt),
              gt(ownerCredentialSetupTokens.expiresAt, event.occurredAt),
            ),
          )
          .returning({ id: ownerCredentialSetupTokens.id });
        if (!consumed) return false;

        const [activatedOwner] = await transaction
          .update(users)
          .set({
            passwordHash,
            status: "ACTIVE",
            emailVerifiedAt: event.occurredAt,
            failedLoginAttempts: 0,
            failedLoginWindowStartedAt: null,
            lockedUntil: null,
            updatedAt: event.occurredAt,
          })
          .where(
            and(
              eq(users.id, candidate.userId),
              eq(users.status, "PENDING"),
              isNull(users.passwordHash),
            ),
          )
          .returning({ id: users.id });
        if (!activatedOwner) return false;

        await transaction
          .update(organizationMemberships)
          .set({ status: "ACTIVE", updatedAt: event.occurredAt })
          .where(
            and(
              eq(organizationMemberships.id, ownerMembership.membershipId),
              eq(
                organizationMemberships.organizationId,
                candidate.organizationId,
              ),
              eq(organizationMemberships.userId, candidate.userId),
              eq(organizationMemberships.status, "INVITED"),
            ),
          );
        await transaction
          .update(ownerCredentialSetupTokens)
          .set({ revokedAt: event.occurredAt })
          .where(
            and(
              eq(ownerCredentialSetupTokens.userId, candidate.userId),
              isNull(ownerCredentialSetupTokens.consumedAt),
              isNull(ownerCredentialSetupTokens.revokedAt),
            ),
          );
        await transaction
          .update(sessions)
          .set({ revokedAt: event.occurredAt })
          .where(
            and(
              eq(sessions.userId, candidate.userId),
              isNull(sessions.revokedAt),
            ),
          );
        await writeAuthenticationEvent(transaction, {
          ...event,
          action: "AUTH_OWNER_CREDENTIAL_SETUP_COMPLETED",
          actorUserId: candidate.userId,
          organizationId: candidate.organizationId,
          resourceId: candidate.userId,
          result: "SUCCESS",
        });
        return true;
      });
    },
    async userRequiresMfa(userId) {
      return withAuthenticatedUserTransaction(database, userId, (transaction) =>
        requiresMfaInTransaction(transaction, userId),
      );
    },
    async getMfaCredential(userId) {
      return withAuthenticatedUserTransaction(
        database,
        userId,
        async (transaction) => {
          const [credential] = await transaction
            .select()
            .from(userMfaCredentials)
            .where(eq(userMfaCredentials.userId, userId))
            .limit(1);
          return credential ? toIdentityMfaCredential(credential) : null;
        },
      );
    },
    async storeMfaSecret(userId, secretEncrypted, enrollmentExpiresAt) {
      await withAuthenticatedUserTransaction(
        database,
        userId,
        async (transaction) => {
          const [credential] = await transaction
            .insert(userMfaCredentials)
            .values({
              userId,
              secretEncrypted,
              enrollmentExpiresAt,
              enabledAt: null,
              lastTotpStep: null,
            })
            .onConflictDoUpdate({
              target: userMfaCredentials.userId,
              set: {
                secretEncrypted,
                enrollmentExpiresAt,
                lastTotpStep: null,
                updatedAt: new Date(),
              },
              setWhere: isNull(userMfaCredentials.enabledAt),
            })
            .returning({ userId: userMfaCredentials.userId });
          if (!credential) {
            throw new Error("MFA is already enabled for this user");
          }
        },
      );
    },
    async completeMfaEnrollment(userId, acceptedTotpStep, event) {
      return withAuthenticatedUserTransaction(
        database,
        userId,
        async (transaction) => {
          const [credential] = await transaction
            .update(userMfaCredentials)
            .set({
              enabledAt: event.occurredAt,
              enrollmentExpiresAt: event.occurredAt,
              lastTotpStep: acceptedTotpStep,
              updatedAt: event.occurredAt,
            })
            .where(
              and(
                eq(userMfaCredentials.userId, userId),
                isNull(userMfaCredentials.enabledAt),
                gt(userMfaCredentials.enrollmentExpiresAt, event.occurredAt),
              ),
            )
            .returning({ userId: userMfaCredentials.userId });
          if (!credential) return false;
          await writeAuthenticationEvent(transaction, event);
          return true;
        },
      );
    },
    async consumeMfaTotpStep(userId, acceptedTotpStep, event) {
      return withAuthenticatedUserTransaction(
        database,
        userId,
        async (transaction) => {
          const [credential] = await transaction
            .update(userMfaCredentials)
            .set({
              lastTotpStep: acceptedTotpStep,
              updatedAt: event.occurredAt,
            })
            .where(
              and(
                eq(userMfaCredentials.userId, userId),
                sql`${userMfaCredentials.enabledAt} IS NOT NULL`,
                sql`(${userMfaCredentials.lastTotpStep} IS NULL OR ${userMfaCredentials.lastTotpStep} < ${acceptedTotpStep})`,
              ),
            )
            .returning({ userId: userMfaCredentials.userId });
          if (!credential) return false;
          await writeAuthenticationEvent(transaction, event);
          return true;
        },
      );
    },
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
    async activateExpiredLock(
      userId,
      requestId,
      ipAddress,
      userAgent,
      now,
      correlationId,
    ) {
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
              correlationId,
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
      correlationId,
    ) {
      const windowStart = new Date(now.getTime() - windowMs);
      const windowStartIso = windowStart.toISOString();
      const nowIso = now.toISOString();
      const shouldReset = sql`
        ${users.failedLoginWindowStartedAt} IS NULL
        OR ${users.failedLoginWindowStartedAt} <= ${windowStartIso}::timestamptz
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
              CASE WHEN ${shouldReset} THEN ${nowIso}::timestamptz ELSE ${users.failedLoginWindowStartedAt} END
            `,
              status: sql`
              CASE WHEN ${incremented} >= ${threshold}
                THEN 'LOCKED'::user_account_status
                ELSE ${users.status}
              END
            `,
              lockedUntil: sql`
              CASE WHEN ${incremented} >= ${threshold}
                THEN ${nowIso}::timestamptz + (${lockMs} * interval '1 millisecond')
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
            correlationId,
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
              correlationId,
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
    async createSession(
      session,
      requestId,
      now,
      correlationId,
      mfaVerified = false,
    ) {
      return withAuthenticatedUserTransaction(
        database,
        session.userId,
        async (transaction) => {
          if (
            !mfaVerified &&
            (await requiresMfaInTransaction(transaction, session.userId))
          ) {
            throw new Error(
              "Mandatory MFA was not completed before session creation",
            );
          }
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
              mfaVerifiedAt: mfaVerified ? now : null,
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
            correlationId,
            ipAddress: session.ipAddress ?? "",
            userAgent: session.userAgent ?? "",
            occurredAt: now,
          });
          await writeAuthenticationEvent(transaction, {
            action: "AUTH_LOGIN_SUCCESS",
            actorUserId: session.userId,
            result: "SUCCESS",
            requestId,
            correlationId,
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
          if (
            (await requiresMfaInTransaction(transaction, session.userId)) &&
            !session.mfaVerifiedAt
          ) {
            return undefined;
          }
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
    async revokeSession(
      secretHash,
      requestId,
      ipAddress,
      userAgent,
      now,
      correlationId,
    ) {
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
            correlationId,
            ipAddress,
            userAgent,
            occurredAt: now,
          });
          await writeAuthenticationEvent(transaction, {
            action: "AUTH_LOGOUT",
            actorUserId: revoked.userId,
            result: "SUCCESS",
            requestId,
            correlationId,
            ipAddress,
            userAgent,
            occurredAt: now,
          });
          return revoked;
        },
      );
      if (!session) return;
    },
    async changePasswordAndRevokeSessions(
      userId,
      currentSessionHash,
      expectedPasswordHash,
      newPasswordHash,
      event,
    ) {
      return withSessionTransaction(
        database,
        currentSessionHash,
        async (transaction) => {
          const [session] = await transaction
            .select({ id: sessions.id, userId: sessions.userId })
            .from(sessions)
            .where(
              and(
                eq(sessions.secretHash, currentSessionHash),
                eq(sessions.userId, userId),
                isNull(sessions.revokedAt),
                gt(sessions.expiresAt, event.occurredAt),
              ),
            )
            .for("update")
            .limit(1);
          if (!session) return false;

          await transaction.execute(
            sql`select set_config('app.current_user_id', ${session.userId}, true)`,
          );
          const [updatedUser] = await transaction
            .update(users)
            .set({
              passwordHash: newPasswordHash,
              failedLoginAttempts: 0,
              failedLoginWindowStartedAt: null,
              lockedUntil: null,
              updatedAt: event.occurredAt,
            })
            .where(
              and(
                eq(users.id, session.userId),
                eq(users.status, "ACTIVE"),
                eq(users.passwordHash, expectedPasswordHash),
              ),
            )
            .returning({ id: users.id });
          if (!updatedUser) return false;

          await transaction
            .update(sessions)
            .set({ revokedAt: event.occurredAt })
            .where(
              and(
                eq(sessions.userId, session.userId),
                isNull(sessions.revokedAt),
              ),
            );
          await writeAuthenticationEvent(transaction, {
            ...event,
            action: "AUTH_PASSWORD_CHANGED",
            actorUserId: session.userId,
            resourceId: session.id,
            result: "SUCCESS",
          });
          await writeAuthenticationEvent(transaction, {
            ...event,
            action: "AUTH_SESSIONS_REVOKED",
            actorUserId: session.userId,
            resourceId: session.id,
            reason: "password_changed",
            result: "SUCCESS",
          });
          return true;
        },
      );
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
