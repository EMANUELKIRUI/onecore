import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  permissionDefinitionSchema,
  type DataScopeType,
} from "@onecore/core-domain";
import {
  auditLogs,
  membershipDataScopes,
  membershipRoles,
  permissions,
  platformUserRoles,
  rolePermissions,
  roles,
  sessions,
  type Database,
  type OrganizationTransaction,
} from "./index.js";
import {
  withActiveBranchTransaction,
  withActiveOrganizationTransaction,
  type VerifiedBranch,
  type VerifiedOrganizationMembership,
} from "./tenant-context.js";
import {
  permissionRequiresBranch,
  resolveEffectivePermissionGrants,
} from "./authorization-policy.js";
import {
  loadOrganizationModuleAccess,
  type OrganizationModuleAccess,
} from "./module-entitlements.js";

const uuidSchema = z.uuid();

export interface AuthorizationContext {
  userId: string;
  sessionId: string;
  organizationId: string | null;
  membershipId: string | null;
  branchId: string | null;
}

export type ActiveAuthorizationContext = AuthorizationContext & {
  organizationId: string;
  membershipId: string;
};

export interface AuthorizationMetadata {
  requestId: string;
  correlationId?: string;
}

export interface PermissionGrant {
  key: string;
  moduleKey: string;
  scopeType: DataScopeType;
  scope: Record<string, unknown>;
}

export interface ResolvedAuthorizationContext extends ActiveAuthorizationContext {
  branch: VerifiedBranch | null;
  branchAccessMode: VerifiedOrganizationMembership["branchAccessMode"];
  roles: { id: string; name: string }[];
  platformRoles: (typeof platformUserRoles.$inferSelect)["role"][];
  permissions: PermissionGrant[];
}

export interface AuthorizationDecision {
  allowed: boolean;
  statusCode: 200 | 401 | 403;
  context?: ResolvedAuthorizationContext;
  dataScopes: DataScopeType[];
}

export type AuthorizationResult<T> =
  | { allowed: true; value: T; context: ResolvedAuthorizationContext }
  | { allowed: false; statusCode: 401 | 403; dataScopes: [] };

export interface AuthorizationService {
  authorize(
    context: AuthorizationContext | null,
    permissionKey: string,
    metadata: AuthorizationMetadata,
  ): Promise<AuthorizationDecision>;
  hasPermission(
    context: AuthorizationContext | null,
    permissionKey: string,
    metadata: AuthorizationMetadata,
  ): Promise<boolean>;
  withPermission<T>(
    context: AuthorizationContext | null,
    permissionKey: string,
    metadata: AuthorizationMetadata,
    operation: (
      transaction: OrganizationTransaction,
      context: ResolvedAuthorizationContext,
    ) => Promise<T>,
  ): Promise<AuthorizationResult<T>>;
  withAllPermissions<T>(
    context: AuthorizationContext | null,
    permissionKeys: readonly string[],
    metadata: AuthorizationMetadata,
    operation: (
      transaction: OrganizationTransaction,
      context: ResolvedAuthorizationContext,
    ) => Promise<T>,
  ): Promise<AuthorizationResult<T>>;
  withAnyPermission<T>(
    context: AuthorizationContext | null,
    permissionKeys: readonly string[],
    metadata: AuthorizationMetadata,
    operation: (
      transaction: OrganizationTransaction,
      context: ResolvedAuthorizationContext,
    ) => Promise<T>,
  ): Promise<AuthorizationResult<T>>;
}

interface ResolvedAccess {
  context: ResolvedAuthorizationContext;
  permissionScopes: Map<string, DataScopeType[]>;
  moduleAccess: Map<string, OrganizationModuleAccess>;
}

function denied(statusCode: 401 | 403): AuthorizationDecision {
  return { allowed: false, statusCode, dataScopes: [] };
}

function permissionData(
  access: ResolvedAccess,
  permissionKey: string,
): DataScopeType[] {
  return access.permissionScopes.get(permissionKey) ?? [];
}

function isCanonicalPermissionKey(key: string): boolean {
  const segments = key.split(".");
  if (segments.length < 3) return false;
  const action = segments.at(-1);
  const resource = segments.at(-2);
  const module = segments.slice(0, -2).join(".");
  return permissionDefinitionSchema.safeParse({ module, resource, action })
    .success;
}

async function writeAuthorizationEvent(
  transaction: OrganizationTransaction,
  context: ActiveAuthorizationContext,
  metadata: AuthorizationMetadata,
  permissionKey: string,
  allowed: boolean,
  reason: string | null,
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId: context.organizationId,
    actorUserId: context.userId,
    action: allowed
      ? "authorization.permission.granted"
      : "authorization.permission.denied",
    resource: "permission",
    resourceId: permissionKey,
    result: allowed ? "SUCCESS" : "FAILURE",
    requestMetadata: {
      requestId: metadata.requestId,
      correlationId: metadata.correlationId ?? null,
      branchId: context.branchId,
      reason,
    },
  });
}

export async function writeAuthorizationMutationEvent(
  transaction: OrganizationTransaction,
  context: ActiveAuthorizationContext,
  metadata: AuthorizationMetadata,
  action: string,
  resource: string,
  resourceId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId: context.organizationId,
    actorUserId: context.userId,
    action,
    resource,
    resourceId,
    result: "SUCCESS",
    requestMetadata: {
      requestId: metadata.requestId,
      correlationId: metadata.correlationId ?? null,
      branchId: context.branchId,
      ...details,
    },
  });
}

export function createAuthorizationService(
  database: Database,
): AuthorizationService {
  async function resolveAccess(
    transaction: OrganizationTransaction,
    membership: VerifiedOrganizationMembership,
    context: ActiveAuthorizationContext,
    branch: VerifiedBranch | null,
  ): Promise<ResolvedAccess> {
    const roleRows = await transaction
      .select({
        id: roles.id,
        name: roles.name,
      })
      .from(membershipRoles)
      .innerJoin(
        roles,
        and(
          eq(membershipRoles.organizationId, roles.organizationId),
          eq(membershipRoles.roleId, roles.id),
        ),
      )
      .where(
        and(
          eq(membershipRoles.organizationId, context.organizationId),
          eq(membershipRoles.membershipId, membership.membershipId),
          eq(roles.status, "ACTIVE"),
        ),
      );

    const grants = await transaction
      .select({
        roleId: roles.id,
        roleStatus: roles.status,
        permissionKey: permissions.key,
        moduleKey: permissions.moduleKey,
        permissionStatus: permissions.status,
        scopeType: rolePermissions.scopeType,
        scope: rolePermissions.scope,
      })
      .from(membershipRoles)
      .innerJoin(
        roles,
        and(
          eq(membershipRoles.organizationId, roles.organizationId),
          eq(membershipRoles.roleId, roles.id),
        ),
      )
      .innerJoin(
        rolePermissions,
        and(
          eq(rolePermissions.organizationId, roles.organizationId),
          eq(rolePermissions.roleId, roles.id),
        ),
      )
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(
        and(
          eq(membershipRoles.organizationId, context.organizationId),
          eq(membershipRoles.membershipId, membership.membershipId),
          eq(roles.status, "ACTIVE"),
        ),
      );

    const memberScopes = await transaction
      .select({ scopeType: membershipDataScopes.scopeType })
      .from(membershipDataScopes)
      .where(
        and(
          eq(membershipDataScopes.organizationId, context.organizationId),
          eq(membershipDataScopes.membershipId, membership.membershipId),
        ),
      );
    const moduleAccess = await loadOrganizationModuleAccess(
      transaction,
      context.organizationId,
    );
    const entitledModules = new Set(
      [...moduleAccess.entries()]
        .filter(([, access]) => access.allowed)
        .map(([moduleName]) => moduleName),
    );
    const membershipScopeTypes = memberScopes.map(({ scopeType }) => scopeType);
    const effectiveGrants = resolveEffectivePermissionGrants(
      grants.map((grant) => ({
        key: grant.permissionKey,
        moduleKey: grant.moduleKey,
        roleStatus: grant.roleStatus,
        permissionStatus: grant.permissionStatus,
        scopeType: grant.scopeType,
        scope: grant.scope,
      })),
      membershipScopeTypes,
      membership.branchAccessMode,
      entitledModules,
    );
    const permissionScopes = new Map<string, DataScopeType[]>();
    for (const grant of effectiveGrants) {
      const existing = permissionScopes.get(grant.key) ?? [];
      permissionScopes.set(grant.key, [
        ...new Set([...existing, grant.scopeType]),
      ]);
    }

    const platformRoleRows = await transaction
      .select({ role: platformUserRoles.role })
      .from(platformUserRoles)
      .where(eq(platformUserRoles.userId, context.userId));

    return {
      context: {
        ...context,
        branch,
        branchAccessMode: membership.branchAccessMode,
        roles: roleRows,
        platformRoles: platformRoleRows.map(({ role }) => role),
        permissions: effectiveGrants,
      },
      permissionScopes,
      moduleAccess,
    };
  }

  async function withinContext<T>(
    context: ActiveAuthorizationContext,
    operation: (
      transaction: OrganizationTransaction,
      membership: VerifiedOrganizationMembership,
      branch: VerifiedBranch | null,
    ) => Promise<T>,
  ): Promise<T | undefined> {
    const userId = uuidSchema.parse(context.userId);
    const organizationId = uuidSchema.parse(context.organizationId);
    const membershipId = uuidSchema.parse(context.membershipId);
    uuidSchema.parse(context.sessionId);

    if (context.branchId) {
      const branchId = uuidSchema.parse(context.branchId);
      return withActiveBranchTransaction(
        database,
        userId,
        organizationId,
        branchId,
        async (transaction, membership, branch) => {
          if (membership.membershipId !== membershipId) return undefined;
          return operation(transaction, membership, branch);
        },
      );
    }

    return withActiveOrganizationTransaction(
      database,
      userId,
      organizationId,
      async (transaction, membership) => {
        if (membership.membershipId !== membershipId) return undefined;
        return operation(transaction, membership, null);
      },
    );
  }

  async function withPermissions<T>(
    context: AuthorizationContext | null,
    permissionKeys: readonly string[],
    metadata: AuthorizationMetadata,
    requireAll: boolean,
    operation: (
      transaction: OrganizationTransaction,
      context: ResolvedAuthorizationContext,
    ) => Promise<T>,
  ): Promise<AuthorizationResult<T>> {
    if (!context) return { allowed: false, statusCode: 401, dataScopes: [] };
    if (!context.organizationId || !context.membershipId) {
      return { allowed: false, statusCode: 403, dataScopes: [] };
    }
    if (permissionKeys.length === 0) {
      return { allowed: false, statusCode: 403, dataScopes: [] };
    }
    if (
      permissionKeys.some(
        (permissionKey) =>
          !isCanonicalPermissionKey(permissionKey) ||
          permissionKey.length > 150,
      )
    ) {
      return { allowed: false, statusCode: 403, dataScopes: [] };
    }
    if (
      !uuidSchema.safeParse(context.userId).success ||
      !uuidSchema.safeParse(context.sessionId).success ||
      !uuidSchema.safeParse(context.organizationId).success ||
      !uuidSchema.safeParse(context.membershipId).success ||
      (context.branchId !== null &&
        !uuidSchema.safeParse(context.branchId).success)
    ) {
      return { allowed: false, statusCode: 403, dataScopes: [] };
    }

    const activeContext: ActiveAuthorizationContext = {
      ...context,
      organizationId: context.organizationId,
      membershipId: context.membershipId,
    };
    const result = await withinContext(
      activeContext,
      async (transaction, membership, branch) => {
        const [session] = await transaction
          .select({
            organizationId: sessions.organizationId,
            branchId: sessions.branchId,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, activeContext.sessionId),
              eq(sessions.userId, activeContext.userId),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, new Date()),
            ),
          )
          .limit(1);
        if (
          !session ||
          session.organizationId !== activeContext.organizationId ||
          session.branchId !== activeContext.branchId
        ) {
          await writeAuthorizationEvent(
            transaction,
            activeContext,
            metadata,
            permissionKeys[0] ?? "unknown",
            false,
            "session_context_invalid",
          );
          return { allowed: false as const };
        }
        const access = await resolveAccess(
          transaction,
          membership,
          activeContext,
          branch,
        );
        const decisions = permissionKeys.map((key) => {
          const scopes = permissionData(access, key);
          return {
            key,
            scopes,
            allowed:
              scopes.length > 0 &&
              (!permissionRequiresBranch(scopes) || branch !== null),
          };
        });
        const allowed = requireAll
          ? decisions.every((decision) => decision.allowed)
          : decisions.some((decision) => decision.allowed);

        for (const decision of decisions) {
          await writeAuthorizationEvent(
            transaction,
            activeContext,
            metadata,
            decision.key,
            decision.allowed,
            decision.allowed ? null : "permission_or_scope_denied",
          );
          const moduleName = decision.key.split(".").slice(0, -2).join(".");
          const moduleDecision = access.moduleAccess.get(moduleName);
          if (!moduleDecision?.allowed) {
            await writeAuthorizationMutationEvent(
              transaction,
              access.context,
              metadata,
              "MODULE_ACCESS_DENIED",
              "module",
              moduleName,
              {
                permission: decision.key,
                reason: moduleDecision?.reason ?? "MODULE_NOT_FOUND",
              },
            );
          } else if (decision.allowed) {
            await writeAuthorizationMutationEvent(
              transaction,
              access.context,
              metadata,
              "MODULE_ACCESS_GRANTED",
              "module",
              moduleName,
              { permission: decision.key },
            );
          }
        }
        if (!allowed) return { allowed: false as const };

        return {
          allowed: true as const,
          value: await operation(transaction, access.context),
          context: access.context,
        };
      },
    );

    if (!result) return { allowed: false, statusCode: 403, dataScopes: [] };
    if (!result.allowed)
      return { allowed: false, statusCode: 403, dataScopes: [] };
    return result;
  }

  async function authorize(
    context: AuthorizationContext | null,
    permissionKey: string,
    metadata: AuthorizationMetadata,
  ): Promise<AuthorizationDecision> {
    const result = await withPermissions(
      context,
      [permissionKey],
      metadata,
      true,
      async (_transaction, resolvedContext) => ({
        context: resolvedContext,
        dataScopes: [
          ...new Set(
            resolvedContext.permissions
              .filter((permission) => permission.key === permissionKey)
              .map(({ scopeType }) => scopeType),
          ),
        ],
      }),
    );
    if (!result.allowed) return denied(result.statusCode);
    return {
      allowed: true,
      statusCode: 200,
      context: result.value.context,
      dataScopes: result.value.dataScopes,
    };
  }

  return {
    authorize,
    async hasPermission(context, permissionKey, metadata) {
      const decision = await authorize(context, permissionKey, metadata);
      return decision.allowed;
    },
    async withPermission(context, permissionKey, metadata, operation) {
      return withPermissions(
        context,
        [permissionKey],
        metadata,
        true,
        operation,
      );
    },
    async withAllPermissions(context, permissionKeys, metadata, operation) {
      return withPermissions(
        context,
        permissionKeys,
        metadata,
        true,
        operation,
      );
    },
    async withAnyPermission(context, permissionKeys, metadata, operation) {
      return withPermissions(
        context,
        permissionKeys,
        metadata,
        false,
        operation,
      );
    },
  };
}

export const denyAllAuthorizationService: AuthorizationService = {
  async authorize(context) {
    return denied(context ? 403 : 401);
  },
  async hasPermission() {
    return false;
  },
  async withPermission(context) {
    return {
      allowed: false,
      statusCode: context ? 403 : 401,
      dataScopes: [],
    };
  },
  async withAllPermissions(context) {
    return {
      allowed: false,
      statusCode: context ? 403 : 401,
      dataScopes: [],
    };
  },
  async withAnyPermission(context) {
    return {
      allowed: false,
      statusCode: context ? 403 : 401,
      dataScopes: [],
    };
  },
};
