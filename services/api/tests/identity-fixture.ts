import type {
  AuthenticationAuditEvent,
  IdentityBranch,
  IdentityMembership,
  IdentityMfaCredential,
  IdentityRepository,
  IdentitySession,
  IdentityUser,
} from "@onecore/database";

export class MemoryIdentityRepository implements IdentityRepository {
  readonly users = new Map<string, IdentityUser>();
  readonly sessions = new Map<string, IdentitySession>();
  readonly memberships = new Map<string, IdentityMembership[]>();
  readonly events: AuthenticationAuditEvent[] = [];
  private readonly organizationBranches = new Map<string, IdentityBranch[]>();
  private readonly branchAssignments = new Map<string, Set<string>>();
  private readonly inactiveBranches = new Set<string>();
  private readonly inactiveOrganizations = new Set<string>();
  private readonly inactiveMemberships = new Set<string>();
  private readonly mfaCredentials = new Map<string, IdentityMfaCredential>();
  private readonly platformRoles = new Map<string, Set<string>>();
  private readonly organizationRoles = new Map<string, Set<string>>();
  private readonly ownerSetupTokens = new Map<
    string,
    {
      userId: string;
      organizationId: string;
      expiresAt: Date;
      consumed: boolean;
      revoked: boolean;
    }
  >();

  addUser(user: IdentityUser): void {
    this.users.set(user.email, structuredClone(user));
  }

  addMembership(
    userId: string,
    membership: Omit<IdentityMembership, "membershipId" | "branchAccessMode"> &
      Partial<Pick<IdentityMembership, "membershipId" | "branchAccessMode">>,
    options: { active?: boolean; organizationActive?: boolean } = {},
  ): void {
    const created: IdentityMembership = {
      ...membership,
      membershipId: membership.membershipId ?? crypto.randomUUID(),
      branchAccessMode: membership.branchAccessMode ?? "ASSIGNED",
    };
    this.memberships.set(userId, [
      ...(this.memberships.get(userId) ?? []),
      created,
    ]);
    const membershipKey = `${userId}:${created.organizationId}`;
    if (options.active === false) this.inactiveMemberships.add(membershipKey);
    if (options.organizationActive === false) {
      this.inactiveOrganizations.add(created.organizationId);
    }
  }

  addBranchAccess(
    userId: string,
    organizationId: string,
    branch: IdentityBranch,
    active = true,
  ): void {
    this.addOrganizationBranch(organizationId, branch, active);
    const key = `${userId}:${organizationId}`;
    const assignments = this.branchAssignments.get(key) ?? new Set<string>();
    assignments.add(branch.branchId);
    this.branchAssignments.set(key, assignments);
  }

  addOrganizationBranch(
    organizationId: string,
    branch: IdentityBranch,
    active = true,
  ): void {
    this.organizationBranches.set(organizationId, [
      ...(this.organizationBranches.get(organizationId) ?? []),
      structuredClone(branch),
    ]);
    if (!active) this.inactiveBranches.add(branch.branchId);
  }

  removeBranchAccess(
    userId: string,
    organizationId: string,
    branchId: string,
  ): void {
    const key = `${userId}:${organizationId}`;
    this.branchAssignments.get(key)?.delete(branchId);
  }

  deactivateMembership(userId: string, organizationId: string): void {
    this.inactiveMemberships.add(`${userId}:${organizationId}`);
  }

  suspendOrganization(organizationId: string): void {
    this.inactiveOrganizations.add(organizationId);
  }

  addOrganizationRole(
    userId: string,
    organizationId: string,
    roleName: string,
  ): void {
    const key = `${userId}:${organizationId}`;
    const roles = this.organizationRoles.get(key) ?? new Set<string>();
    roles.add(roleName);
    this.organizationRoles.set(key, roles);
  }

  addPlatformRole(userId: string, roleName: string): void {
    const roles = this.platformRoles.get(userId) ?? new Set<string>();
    roles.add(roleName);
    this.platformRoles.set(userId, roles);
  }

  async issueOwnerCredentialSetup(
    organizationId: string,
    actorUserId: string,
    tokenHash: string,
    expiresAt: Date,
    event: AuthenticationAuditEvent,
  ) {
    if (!this.platformRoles.get(actorUserId)?.has("SUPERADMIN")) {
      return undefined;
    }
    const ownerMembership = [...this.organizationRoles.entries()].find(
      ([key, roles]) =>
        key.endsWith(`:${organizationId}`) && roles.has("Organization Owner"),
    );
    if (!ownerMembership) return undefined;
    const userId = ownerMembership[0].slice(0, -organizationId.length - 1);
    const user = await this.findUserById(userId);
    if (!user || user.status !== "PENDING" || user.passwordHash) {
      return undefined;
    }
    for (const token of this.ownerSetupTokens.values()) {
      if (
        token.userId === userId &&
        token.organizationId === organizationId &&
        !token.consumed
      ) {
        token.revoked = true;
      }
    }
    this.ownerSetupTokens.set(tokenHash, {
      userId,
      organizationId,
      expiresAt,
      consumed: false,
      revoked: false,
    });
    this.events.push(structuredClone(event));
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    };
  }

  async completeOwnerCredentialSetup(
    tokenHash: string,
    passwordHash: string,
    event: AuthenticationAuditEvent,
  ): Promise<boolean> {
    const token = this.ownerSetupTokens.get(tokenHash);
    if (
      !token ||
      token.consumed ||
      token.revoked ||
      token.expiresAt <= event.occurredAt
    ) {
      return false;
    }
    const user = await this.findUserById(token.userId);
    if (!user || user.status !== "PENDING" || user.passwordHash) return false;
    token.consumed = true;
    user.passwordHash = passwordHash;
    user.status = "ACTIVE";
    this.users.set(user.email, user);
    this.inactiveMemberships.delete(`${user.id}:${token.organizationId}`);
    for (const candidate of this.ownerSetupTokens.values()) {
      if (candidate.userId === user.id && !candidate.consumed) {
        candidate.revoked = true;
      }
    }
    this.events.push(structuredClone(event));
    return true;
  }

  async userRequiresMfa(userId: string): Promise<boolean> {
    if (
      this.platformRoles.get(userId)?.has("SUPERADMIN") ||
      this.platformRoles.get(userId)?.has("SUPPORT")
    ) {
      return true;
    }
    return [...this.organizationRoles.entries()].some(
      ([key, roles]) =>
        key.startsWith(`${userId}:`) &&
        this.memberships
          .get(userId)
          ?.some(
            (membership) =>
              key === `${userId}:${membership.organizationId}` &&
              !this.inactiveMemberships.has(
                `${userId}:${membership.organizationId}`,
              ) &&
              !this.inactiveOrganizations.has(membership.organizationId),
          ) &&
        (roles.has("Organization Owner") || roles.has("Organization Admin")),
    );
  }

  async getMfaCredential(
    userId: string,
  ): Promise<IdentityMfaCredential | null> {
    const credential = this.mfaCredentials.get(userId);
    return credential ? structuredClone(credential) : null;
  }

  async storeMfaSecret(
    userId: string,
    secretEncrypted: string,
    enrollmentExpiresAt: Date,
  ): Promise<void> {
    const existing = this.mfaCredentials.get(userId);
    if (existing?.enabledAt) {
      throw new Error("MFA is already enabled for this user");
    }
    this.mfaCredentials.set(userId, {
      secretEncrypted,
      enabledAt: null,
      enrollmentExpiresAt,
      lastTotpStep: null,
    });
  }

  async completeMfaEnrollment(
    userId: string,
    acceptedTotpStep: number,
    event: AuthenticationAuditEvent,
  ): Promise<boolean> {
    const credential = this.mfaCredentials.get(userId);
    if (
      !credential ||
      credential.enabledAt ||
      credential.enrollmentExpiresAt <= event.occurredAt
    ) {
      return false;
    }
    credential.enabledAt = event.occurredAt;
    credential.lastTotpStep = acceptedTotpStep;
    this.events.push(structuredClone(event));
    return true;
  }

  async consumeMfaTotpStep(
    userId: string,
    acceptedTotpStep: number,
    event: AuthenticationAuditEvent,
  ): Promise<boolean> {
    const credential = this.mfaCredentials.get(userId);
    if (
      !credential?.enabledAt ||
      (credential.lastTotpStep !== null &&
        credential.lastTotpStep >= acceptedTotpStep)
    ) {
      return false;
    }
    credential.lastTotpStep = acceptedTotpStep;
    this.events.push(structuredClone(event));
    return true;
  }

  async findUserByEmail(email: string): Promise<IdentityUser | undefined> {
    const user = this.users.get(email);
    return user ? structuredClone(user) : undefined;
  }

  async findUserById(userId: string): Promise<IdentityUser | undefined> {
    const user = [...this.users.values()].find(
      (candidate) => candidate.id === userId,
    );
    return user ? structuredClone(user) : undefined;
  }

  async activateExpiredLock(
    userId: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<boolean> {
    const user = await this.findUserById(userId);
    if (
      !user ||
      user.status !== "LOCKED" ||
      !user.lockedUntil ||
      user.lockedUntil > now
    ) {
      return false;
    }
    user.status = "ACTIVE";
    user.lockedUntil = null;
    user.failedLoginAttempts = 0;
    user.failedLoginWindowStartedAt = null;
    this.users.set(user.email, user);
    this.events.push({
      action: "AUTH_ACCOUNT_UNLOCKED",
      actorUserId: user.id,
      result: "SUCCESS",
      requestId,
      ipAddress,
      userAgent,
      reason: "automatic_lockout_expired",
      occurredAt: now,
    });
    return true;
  }

  async recordFailedLogin(
    email: string,
    now: Date,
    windowMs: number,
    threshold: number,
    lockMs: number,
    requestId: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<{ userId: string; locked: boolean } | undefined> {
    const user = await this.findUserByEmail(email);
    if (!user || user.status !== "ACTIVE") return undefined;
    if (
      !user.failedLoginWindowStartedAt ||
      now.getTime() - user.failedLoginWindowStartedAt.getTime() > windowMs
    ) {
      user.failedLoginAttempts = 0;
      user.failedLoginWindowStartedAt = now;
    }
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= threshold) {
      user.status = "LOCKED";
      user.lockedUntil = new Date(now.getTime() + lockMs);
    }
    this.users.set(user.email, user);
    this.events.push({
      action: "AUTH_LOGIN_FAILURE",
      actorUserId: user.id,
      result: "FAILURE",
      requestId,
      ipAddress,
      userAgent,
      reason: "invalid_credentials",
      occurredAt: now,
    });
    if (user.status === "LOCKED") {
      this.events.push({
        action: "AUTH_ACCOUNT_LOCKED",
        actorUserId: user.id,
        result: "SUCCESS",
        requestId,
        ipAddress,
        userAgent,
        reason: "failed_login_threshold",
        occurredAt: now,
      });
    }
    return { userId: user.id, locked: user.status === "LOCKED" };
  }

  async createSession(
    session: Omit<IdentitySession, "id" | "lastUsedAt" | "revokedAt">,
    requestId: string,
    now: Date,
    correlationId?: string,
    mfaVerified = false,
  ): Promise<IdentitySession> {
    if (!mfaVerified && (await this.userRequiresMfa(session.userId))) {
      throw new Error(
        "Mandatory MFA was not completed before session creation",
      );
    }
    const created: IdentitySession = {
      ...session,
      id: crypto.randomUUID(),
      mfaVerifiedAt: mfaVerified ? now : null,
      lastUsedAt: now,
      revokedAt: null,
    };
    this.sessions.set(created.secretHash, created);
    const user = await this.findUserById(created.userId);
    if (user) {
      user.lastLoginAt = now;
      user.failedLoginAttempts = 0;
      user.failedLoginWindowStartedAt = null;
      user.lockedUntil = null;
      this.users.set(user.email, user);
    }
    this.events.push(
      {
        action: "AUTH_SESSION_CREATED",
        actorUserId: created.userId,
        organizationId: null,
        result: "SUCCESS",
        requestId,
        ipAddress: created.ipAddress ?? "",
        userAgent: created.userAgent ?? "",
        occurredAt: now,
      },
      {
        action: "AUTH_LOGIN_SUCCESS",
        actorUserId: created.userId,
        organizationId: null,
        result: "SUCCESS",
        requestId,
        ipAddress: created.ipAddress ?? "",
        userAgent: created.userAgent ?? "",
        occurredAt: now,
      },
    );
    return structuredClone(created);
  }

  async findActiveSession(
    secretHash: string,
    now: Date,
  ): Promise<{ session: IdentitySession; user: IdentityUser } | undefined> {
    const session = this.sessions.get(secretHash);
    if (!session || session.revokedAt || session.expiresAt <= now)
      return undefined;
    if (
      (await this.userRequiresMfa(session.userId)) &&
      !session.mfaVerifiedAt
    ) {
      return undefined;
    }
    const user = await this.findUserById(session.userId);
    if (!user || user.status !== "ACTIVE") return undefined;
    return { session: structuredClone(session), user };
  }

  async touchSession(secretHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(secretHash);
    if (session) session.lastUsedAt = now;
  }

  async clearSessionOrganization(
    secretHash: string,
    expectedOrganizationId: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<void> {
    const session = this.sessions.get(secretHash);
    if (session) {
      const organizationId = session.organizationId;
      if (organizationId !== expectedOrganizationId) return;
      session.organizationId = null;
      session.branchId = null;
      if (organizationId) {
        this.events.push({
          action: "AUTH_ORGANIZATION_CONTEXT_CLEARED",
          actorUserId: session.userId,
          resourceId: organizationId,
          result: "SUCCESS",
          requestId,
          ipAddress,
          userAgent,
          reason: "active_membership_or_organization_required",
          occurredAt: now,
        });
      }
    }
  }

  async clearSessionBranch(
    secretHash: string,
    expectedBranchId: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<void> {
    const session = this.sessions.get(secretHash);
    if (session?.branchId === expectedBranchId) {
      const branchId = session.branchId;
      session.branchId = null;
      this.events.push({
        action: "AUTH_BRANCH_CONTEXT_CLEARED",
        actorUserId: session.userId,
        resourceId: branchId,
        result: "SUCCESS",
        requestId,
        ipAddress,
        userAgent,
        reason: "active_branch_access_required",
        occurredAt: now,
      });
    }
  }

  async revokeSession(
    secretHash: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<void> {
    const session = this.sessions.get(secretHash);
    if (!session || session.revokedAt) return;
    session.revokedAt = now;
    await this.recordAuthenticationEvent({
      action: "AUTH_SESSION_REVOKED",
      actorUserId: session.userId,
      result: "SUCCESS",
      requestId,
      ipAddress,
      userAgent,
      occurredAt: now,
    });
    await this.recordAuthenticationEvent({
      action: "AUTH_LOGOUT",
      actorUserId: session.userId,
      result: "SUCCESS",
      requestId,
      ipAddress,
      userAgent,
      occurredAt: now,
    });
  }

  async changePasswordAndRevokeSessions(
    userId: string,
    currentSessionHash: string,
    expectedPasswordHash: string,
    newPasswordHash: string,
    event: AuthenticationAuditEvent,
  ): Promise<boolean> {
    const session = this.sessions.get(currentSessionHash);
    const user = await this.findUserById(userId);
    if (
      !session ||
      session.userId !== userId ||
      session.revokedAt ||
      session.expiresAt <= event.occurredAt ||
      !user ||
      user.status !== "ACTIVE" ||
      user.passwordHash !== expectedPasswordHash
    ) {
      return false;
    }

    user.passwordHash = newPasswordHash;
    user.failedLoginAttempts = 0;
    user.failedLoginWindowStartedAt = null;
    user.lockedUntil = null;
    this.users.set(user.email, user);
    for (const activeSession of this.sessions.values()) {
      if (activeSession.userId === userId && !activeSession.revokedAt) {
        activeSession.revokedAt = event.occurredAt;
      }
    }
    this.events.push(
      {
        ...structuredClone(event),
        action: "AUTH_PASSWORD_CHANGED",
        actorUserId: userId,
        resourceId: session.id,
        result: "SUCCESS",
      },
      {
        ...structuredClone(event),
        action: "AUTH_SESSIONS_REVOKED",
        actorUserId: userId,
        resourceId: session.id,
        reason: "password_changed",
        result: "SUCCESS",
      },
    );
    return true;
  }

  async listActiveMemberships(userId: string): Promise<IdentityMembership[]> {
    return structuredClone(
      (this.memberships.get(userId) ?? []).filter(
        (membership) =>
          !this.inactiveMemberships.has(
            `${userId}:${membership.organizationId}`,
          ) && !this.inactiveOrganizations.has(membership.organizationId),
      ),
    );
  }

  async listAuthorizedBranches(
    userId: string,
    organizationId: string,
  ): Promise<IdentityBranch[]> {
    const membership = (await this.listActiveMemberships(userId)).find(
      (candidate) => candidate.organizationId === organizationId,
    );
    if (!membership) return [];
    const branches = (
      this.organizationBranches.get(organizationId) ?? []
    ).filter((branch) => !this.inactiveBranches.has(branch.branchId));
    if (membership.branchAccessMode === "ALL") {
      return structuredClone(branches);
    }
    const assignments =
      this.branchAssignments.get(`${userId}:${organizationId}`) ?? new Set();
    return structuredClone(
      branches.filter((branch) => assignments.has(branch.branchId)),
    );
  }

  async selectOrganization(
    userId: string,
    secretHash: string,
    organizationId: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<IdentityMembership | undefined> {
    const membership = (this.memberships.get(userId) ?? []).find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        !this.inactiveMemberships.has(`${userId}:${organizationId}`) &&
        !this.inactiveOrganizations.has(organizationId),
    );
    const session = this.sessions.get(secretHash);
    if (
      !membership ||
      !session ||
      session.userId !== userId ||
      session.revokedAt ||
      session.expiresAt <= now
    )
      return undefined;
    session.organizationId = organizationId;
    session.branchId = null;
    await this.recordAuthenticationEvent({
      action: "AUTH_ORGANIZATION_SELECTED",
      actorUserId: userId,
      organizationId,
      result: "SUCCESS",
      requestId,
      ipAddress,
      userAgent,
      occurredAt: now,
    });
    return structuredClone(membership);
  }

  async selectBranch(
    userId: string,
    secretHash: string,
    organizationId: string,
    branchId: string,
    requestId: string,
    ipAddress: string,
    userAgent: string,
    now: Date,
  ): Promise<IdentityBranch | undefined> {
    const membership = (await this.listActiveMemberships(userId)).find(
      (candidate) => candidate.organizationId === organizationId,
    );
    const session = this.sessions.get(secretHash);
    const branch = (this.organizationBranches.get(organizationId) ?? [])
      .filter((candidate) => candidate.branchId === branchId)
      .at(0);
    const assignments =
      this.branchAssignments.get(`${userId}:${organizationId}`) ?? new Set();
    if (
      !membership ||
      !session ||
      session.userId !== userId ||
      session.organizationId !== organizationId ||
      session.revokedAt ||
      session.expiresAt <= now ||
      !branch ||
      this.inactiveBranches.has(branchId) ||
      (membership.branchAccessMode === "ASSIGNED" && !assignments.has(branchId))
    ) {
      return undefined;
    }
    session.branchId = branchId;
    await this.recordAuthenticationEvent({
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
    return structuredClone(branch);
  }

  async recordAuthenticationEvent(
    event: AuthenticationAuditEvent,
  ): Promise<void> {
    this.events.push(structuredClone(event));
  }
}
