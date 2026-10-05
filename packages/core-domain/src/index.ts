import { z } from "zod";

export const deploymentTypes = [
  "SAAS",
  "CUSTOM",
  "DEDICATED",
  "ENTERPRISE",
] as const;
export const deploymentTypeSchema = z.enum(deploymentTypes);
export type DeploymentType = z.infer<typeof deploymentTypeSchema>;

export const organizationStatuses = [
  "PENDING",
  "UNDER_REVIEW",
  "APPROVED",
  "PAYMENT_PENDING",
  "ACTIVE",
  "SUSPENDED",
  "EXPIRED",
  "REJECTED",
  "CANCELLED",
] as const;
export const organizationStatusSchema = z.enum(organizationStatuses);
export type OrganizationStatus = z.infer<typeof organizationStatusSchema>;

const organizationStatusTransitions: Record<
  OrganizationStatus,
  readonly OrganizationStatus[]
> = {
  PENDING: ["UNDER_REVIEW", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["PAYMENT_PENDING", "ACTIVE", "CANCELLED"],
  PAYMENT_PENDING: ["ACTIVE", "EXPIRED", "CANCELLED"],
  ACTIVE: ["SUSPENDED", "EXPIRED", "CANCELLED"],
  SUSPENDED: ["ACTIVE", "EXPIRED", "CANCELLED"],
  EXPIRED: ["ACTIVE", "CANCELLED"],
  REJECTED: ["CANCELLED"],
  CANCELLED: [],
};

export function canTransitionOrganizationStatus(
  from: OrganizationStatus,
  to: OrganizationStatus,
): boolean {
  return organizationStatusTransitions[from].includes(to);
}

export const branchStatuses = [
  "ACTIVE",
  "INACTIVE",
  "SUSPENDED",
  "CLOSED",
] as const;
export const branchStatusSchema = z.enum(branchStatuses);
export type BranchStatus = z.infer<typeof branchStatusSchema>;

export const membershipBranchAccessModes = ["ASSIGNED", "ALL"] as const;
export const membershipBranchAccessModeSchema = z.enum(
  membershipBranchAccessModes,
);
export type MembershipBranchAccessMode = z.infer<
  typeof membershipBranchAccessModeSchema
>;

export const membershipStatuses = [
  "INVITED",
  "ACTIVE",
  "SUSPENDED",
  "REMOVED",
] as const;
export const membershipStatusSchema = z.enum(membershipStatuses);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const userAccountStatuses = [
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "LOCKED",
  "DISABLED",
] as const;
export const userAccountStatusSchema = z.enum(userAccountStatuses);
export type UserAccountStatus = z.infer<typeof userAccountStatusSchema>;

const userAccountStatusTransitions: Record<
  UserAccountStatus,
  readonly UserAccountStatus[]
> = {
  PENDING: ["ACTIVE", "DISABLED"],
  ACTIVE: ["SUSPENDED", "LOCKED", "DISABLED"],
  SUSPENDED: ["ACTIVE", "DISABLED"],
  LOCKED: ["ACTIVE", "DISABLED"],
  DISABLED: [],
};

export function canTransitionUserAccountStatus(
  from: UserAccountStatus,
  to: UserAccountStatus,
): boolean {
  return userAccountStatusTransitions[from].includes(to);
}

export const dataScopeTypes = [
  "ORGANIZATION",
  "BRANCH",
  "DEPARTMENT",
  "SELF",
  "OWN",
  "ASSIGNED",
  "CUSTOM",
] as const;
export const dataScopeTypeSchema = z.enum(dataScopeTypes);
export type DataScopeType = z.infer<typeof dataScopeTypeSchema>;

export const roleStatuses = ["ACTIVE", "INACTIVE"] as const;
export const roleStatusSchema = z.enum(roleStatuses);
export type RoleStatus = z.infer<typeof roleStatusSchema>;

export const permissionStatuses = ["ACTIVE", "INACTIVE"] as const;
export const permissionStatusSchema = z.enum(permissionStatuses);
export type PermissionStatus = z.infer<typeof permissionStatusSchema>;

const permissionSegmentSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9_-]*$/);

export const permissionDefinitionSchema = z
  .object({
    module: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/),
    resource: permissionSegmentSchema,
    action: permissionSegmentSchema,
  })
  .transform((permission) => ({
    ...permission,
    key: `${permission.module}.${permission.resource}.${permission.action}`,
  }))
  .refine((permission) => permission.key.length <= 150, {
    message: "Canonical permission key must not exceed 150 characters",
    path: ["module"],
  });

export type PermissionDefinition = z.infer<typeof permissionDefinitionSchema>;

export function createPermissionKey(
  module: string,
  resource: string,
  action: string,
): string {
  return permissionDefinitionSchema.parse({ module, resource, action }).key;
}

export const permissionCatalog = [
  {
    module: "core.organization",
    resource: "organization",
    action: "read",
    description: "Read the current organization profile.",
  },
  {
    module: "core.organization",
    resource: "organization",
    action: "update",
    description: "Update organization profile settings.",
  },
  {
    module: "core.organization",
    resource: "user",
    action: "read",
    description: "Read organization memberships.",
  },
  {
    module: "core.organization",
    resource: "user",
    action: "create",
    description: "Create organization memberships.",
  },
  {
    module: "core.organization",
    resource: "user",
    action: "update",
    description: "Update organization memberships.",
  },
  {
    module: "core.organization",
    resource: "settings",
    action: "read",
    description: "Read organization settings.",
  },
  {
    module: "core.organization",
    resource: "settings",
    action: "update",
    description: "Update organization settings.",
  },
  {
    module: "core.rbac",
    resource: "organization_owner",
    action: "manage",
    description:
      "Reserved capability maintained only by trusted organization provisioning.",
  },
  {
    module: "core.rbac",
    resource: "role",
    action: "read",
    description: "Read organization roles.",
  },
  {
    module: "core.rbac",
    resource: "role",
    action: "create",
    description: "Create organization roles.",
  },
  {
    module: "core.rbac",
    resource: "role",
    action: "update",
    description: "Update organization roles.",
  },
  {
    module: "core.rbac",
    resource: "role",
    action: "disable",
    description: "Disable organization roles.",
  },
  {
    module: "core.rbac",
    resource: "permission",
    action: "read",
    description: "Read the active permission catalog.",
  },
  {
    module: "core.rbac",
    resource: "role_permission",
    action: "assign",
    description: "Grant permissions to organization roles.",
  },
  {
    module: "core.rbac",
    resource: "role_permission",
    action: "revoke",
    description: "Revoke permissions from organization roles.",
  },
  {
    module: "core.rbac",
    resource: "membership_role",
    action: "assign",
    description: "Assign organization roles to memberships.",
  },
  {
    module: "core.rbac",
    resource: "membership_role",
    action: "remove",
    description: "Remove organization roles from memberships.",
  },
  {
    module: "core.modules",
    resource: "module",
    action: "read",
    description: "Read registered modules and organization availability.",
  },
  {
    module: "core.modules",
    resource: "entitlement",
    action: "read",
    description: "Read organization module entitlements.",
  },
  {
    module: "core.modules",
    resource: "entitlement",
    action: "request",
    description: "Request an available module for the organization.",
  },
  {
    module: "core.modules",
    resource: "entitlement",
    action: "manage",
    description: "Enable or disable organization module entitlements.",
  },
  ...(
    [
      ["sales", "sale", "create"],
      ["sales", "sale", "read"],
      ["sales", "sale", "update"],
      ["sales", "sale", "delete"],
      ["inventory", "product", "create"],
      ["inventory", "product", "read"],
      ["inventory", "product", "update"],
      ["inventory", "product", "delete"],
      ["inventory", "stock", "adjust"],
      ["customers", "customer", "create"],
      ["customers", "customer", "read"],
      ["reports", "sales", "read"],
    ] as const
  ).map(([module, resource, action]) => ({
    module,
    resource,
    action,
    description: `${action} ${resource} records in the ${module} module.`,
  })),
].map((definition) => ({
  ...permissionDefinitionSchema.parse(definition),
  description: definition.description,
}));

export const roleAdministrationPermissionKeys = [
  "core.rbac.role.read",
  "core.rbac.role.create",
  "core.rbac.role.update",
  "core.rbac.role.disable",
  "core.rbac.permission.read",
  "core.rbac.role_permission.assign",
  "core.rbac.role_permission.revoke",
  "core.rbac.membership_role.assign",
  "core.rbac.membership_role.remove",
  "core.modules.module.read",
  "core.modules.entitlement.read",
  "core.modules.entitlement.request",
  "core.modules.entitlement.manage",
] as const;

export const moduleAdministrationPermissionKeys = [
  "core.modules.module.read",
  "core.modules.entitlement.read",
  "core.modules.entitlement.request",
  "core.modules.entitlement.manage",
] as const;

export const organizationOwnerPermissionKey =
  "core.rbac.organization_owner.manage";

export const defaultOrganizationRoleTemplates = [
  { name: "Organization Owner", permissionKeys: null },
  {
    name: "Organization Admin",
    permissionKeys: roleAdministrationPermissionKeys,
  },
  {
    name: "Manager",
    permissionKeys: [
      "core.organization.organization.read",
      "core.organization.user.read",
      "core.organization.settings.read",
    ],
  },
  {
    name: "Staff",
    permissionKeys: ["core.organization.organization.read"],
  },
  {
    name: "Viewer",
    permissionKeys: [
      "core.organization.organization.read",
      "core.organization.settings.read",
    ],
  },
] as const;

export const organizationModuleStatuses = [
  "REQUESTED",
  "PENDING",
  "APPROVED",
  "AVAILABLE",
  "ENABLED",
  "DISABLED",
  "SUSPENDED",
  "EXPIRED",
] as const;
export const organizationModuleStatusSchema = z.enum(
  organizationModuleStatuses,
);
export type OrganizationModuleStatus = z.infer<
  typeof organizationModuleStatusSchema
>;

export const moduleLifecycles = [
  "DEVELOPMENT",
  "INTERNAL_TESTING",
  "QA",
  "SECURITY_REVIEW",
  "STAGING",
  "UAT",
  "SUPERADMIN_REVIEW",
  "APPROVED",
  "AVAILABLE",
  "DEPRECATED",
  "RETIRED",
] as const;
export const moduleLifecycleSchema = z.enum(moduleLifecycles);
export type ModuleLifecycle = z.infer<typeof moduleLifecycleSchema>;

const moduleSemanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const moduleManifestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/),
    version: z.string().regex(moduleSemanticVersionPattern),
    displayName: z.string().trim().min(1).max(150),
    description: z.string().trim().max(2_000).optional(),
    dependencies: z
      .array(
        z
          .object({
            moduleName: z
              .string()
              .min(1)
              .max(100)
              .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/),
            minimumVersion: z
              .string()
              .regex(moduleSemanticVersionPattern)
              .optional(),
          })
          .strict(),
      )
      .default([])
      .refine(
        (dependencies) =>
          new Set(dependencies.map(({ moduleName }) => moduleName)).size ===
          dependencies.length,
        "Module dependencies must be unique",
      ),
    permissions: z.array(z.string().min(1).max(150)).default([]),
    features: z
      .array(
        z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z][a-z0-9_-]*$/),
      )
      .default([]),
    lifecycle: moduleLifecycleSchema,
    configuration: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.dependencies.some(
        ({ moduleName }) => moduleName === manifest.name,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["dependencies"],
        message: "A module cannot depend on itself",
      });
    }
    const permissionKeys = manifest.permissions;
    if (new Set(permissionKeys).size !== permissionKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "Manifest permissions must be unique",
      });
    }
    for (const [index, key] of permissionKeys.entries()) {
      const segments = key.split(".");
      const action = segments.pop();
      const resource = segments.pop();
      const module = segments.join(".");
      if (
        !permissionDefinitionSchema.safeParse({ module, resource, action })
          .success
      ) {
        context.addIssue({
          code: "custom",
          path: ["permissions", index],
          message: "Manifest permissions must use canonical permission keys",
        });
      }
    }
    const featureKeys = manifest.features;
    if (new Set(featureKeys).size !== featureKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["features"],
        message: "Manifest features must be unique",
      });
    }
  });

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

const moduleLifecycleTransitions: Record<
  ModuleLifecycle,
  readonly ModuleLifecycle[]
> = {
  DEVELOPMENT: ["INTERNAL_TESTING"],
  INTERNAL_TESTING: ["QA"],
  QA: ["SECURITY_REVIEW"],
  SECURITY_REVIEW: ["STAGING"],
  STAGING: ["UAT"],
  UAT: ["SUPERADMIN_REVIEW"],
  SUPERADMIN_REVIEW: ["APPROVED"],
  APPROVED: ["AVAILABLE"],
  AVAILABLE: ["DEPRECATED"],
  DEPRECATED: ["AVAILABLE", "RETIRED"],
  RETIRED: [],
};

export function canTransitionModuleLifecycle(
  from: ModuleLifecycle,
  to: ModuleLifecycle,
): boolean {
  return moduleLifecycleTransitions[from].includes(to);
}

export interface ModuleDependencyNode {
  name: string;
  version: string;
  lifecycle: ModuleLifecycle;
  dependencies: readonly ModuleManifest["dependencies"][number][];
}

export function compareSemanticVersions(left: string, right: string): number {
  const leftMatch = moduleSemanticVersionPattern.exec(left);
  const rightMatch = moduleSemanticVersionPattern.exec(right);
  if (!leftMatch || !rightMatch)
    throw new TypeError("Invalid semantic version");
  for (let index = 1; index <= 3; index += 1) {
    const leftPart = BigInt(leftMatch[index] ?? "0");
    const rightPart = BigInt(rightMatch[index] ?? "0");
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  const leftPrerelease = leftMatch[4]?.split(".") ?? [];
  const rightPrerelease = rightMatch[4]?.split(".") ?? [];
  if (leftPrerelease.length === 0 || rightPrerelease.length === 0) {
    return leftPrerelease.length === rightPrerelease.length
      ? 0
      : leftPrerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPrerelease[index];
    const rightPart = rightPrerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftPart);
      const rightNumber = BigInt(rightPart);
      return leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function resolveModuleActivationOrder(
  modules: readonly ModuleDependencyNode[],
  requestedModule: string,
): string[] {
  const byName = new Map(modules.map((module) => [module.name, module]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(name: string): void {
    const module = byName.get(name);
    if (!module) throw new Error(`MODULE_NOT_FOUND:${name}`);
    if (visiting.has(name)) throw new Error(`DEPENDENCY_CYCLE:${name}`);
    if (visited.has(name)) return;
    if (module.lifecycle !== "AVAILABLE") {
      throw new Error(`MODULE_UNAVAILABLE:${name}`);
    }
    visiting.add(name);
    for (const dependency of [...module.dependencies].sort((a, b) =>
      a.moduleName.localeCompare(b.moduleName),
    )) {
      const required = byName.get(dependency.moduleName);
      if (!required)
        throw new Error(`MODULE_NOT_FOUND:${dependency.moduleName}`);
      if (
        dependency.minimumVersion &&
        compareSemanticVersions(required.version, dependency.minimumVersion) < 0
      ) {
        throw new Error(
          `DEPENDENCY_VERSION_UNSATISFIED:${dependency.moduleName}`,
        );
      }
      visit(dependency.moduleName);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  }

  visit(requestedModule);
  return order;
}

export function validateModuleDependencyGraph(
  modules: readonly ModuleDependencyNode[],
): void {
  const names = new Set(modules.map(({ name }) => name));
  if (names.size !== modules.length) {
    throw new Error("DUPLICATE_MODULE_NAME");
  }
  const byName = new Map(modules.map((module) => [module.name, module]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(name: string): void {
    if (!byName.has(name)) throw new Error(`MODULE_NOT_FOUND:${name}`);
    if (visiting.has(name)) throw new Error(`DEPENDENCY_CYCLE:${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    const module = byName.get(name);
    if (!module) throw new Error(`MODULE_NOT_FOUND:${name}`);
    for (const dependency of module.dependencies) {
      visit(dependency.moduleName);
    }
    visiting.delete(name);
    visited.add(name);
  }
  for (const module of modules) {
    visit(module.name);
  }
}

export type ModuleAccessFailure =
  | "MODULE_NOT_FOUND"
  | "MODULE_UNAVAILABLE"
  | "NOT_ENTITLED"
  | "MODULE_DISABLED"
  | "DEPENDENCY_NOT_SATISFIED"
  | "SUBSCRIPTION_NOT_ALLOWED";

export interface ModuleAccessInput {
  registered: boolean;
  lifecycle: ModuleLifecycle | null;
  isAvailable: boolean;
  entitlementStatus: OrganizationModuleStatus | null;
  planAllowsModule: boolean;
  dependenciesEnabled: boolean;
}

export function resolveModuleAccess(
  input: ModuleAccessInput,
): { allowed: true } | { allowed: false; reason: ModuleAccessFailure } {
  if (!input.registered || input.lifecycle === null) {
    return { allowed: false, reason: "MODULE_NOT_FOUND" };
  }
  if (!input.isAvailable || input.lifecycle !== "AVAILABLE") {
    return { allowed: false, reason: "MODULE_UNAVAILABLE" };
  }
  if (!input.planAllowsModule) {
    return { allowed: false, reason: "SUBSCRIPTION_NOT_ALLOWED" };
  }
  if (
    input.entitlementStatus === null ||
    input.entitlementStatus === "REQUESTED" ||
    input.entitlementStatus === "PENDING"
  ) {
    return { allowed: false, reason: "NOT_ENTITLED" };
  }
  if (input.entitlementStatus !== "ENABLED") {
    return { allowed: false, reason: "MODULE_DISABLED" };
  }
  if (!input.dependenciesEnabled) {
    return { allowed: false, reason: "DEPENDENCY_NOT_SATISFIED" };
  }
  return { allowed: true };
}

export const entitlementSources = ["SUBSCRIPTION", "MANUAL", "CUSTOM"] as const;
export const entitlementSourceSchema = z.enum(entitlementSources);
export type EntitlementSource = z.infer<typeof entitlementSourceSchema>;

export const featureFlagScopes = [
  "GLOBAL",
  "ENVIRONMENT",
  "MODULE",
  "ORGANIZATION",
  "USER",
] as const;
export const featureFlagScopeSchema = z.enum(featureFlagScopes);
export type FeatureFlagScope = z.infer<typeof featureFlagScopeSchema>;

export const billingIntervals = [
  "MONTHLY",
  "ANNUAL",
  "CUSTOM",
  "ENTERPRISE",
] as const;
export const billingIntervalSchema = z.enum(billingIntervals);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

export const subscriptionStatuses = [
  "PENDING",
  "ACTIVE",
  "GRACE_PERIOD",
  "SUSPENDED",
  "EXPIRED",
  "CANCELLED",
] as const;
export const subscriptionStatusSchema = z.enum(subscriptionStatuses);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const customFieldTypes = [
  "TEXT",
  "NUMBER",
  "BOOLEAN",
  "DATE",
  "DATETIME",
  "CURRENCY",
  "SELECT",
  "MULTI_SELECT",
  "REFERENCE",
] as const;
export const customFieldTypeSchema = z.enum(customFieldTypes);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

export const workflowStatuses = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export const workflowStatusSchema = z.enum(workflowStatuses);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

export const workflowVersionStatuses = [
  "DRAFT",
  "PUBLISHED",
  "RETIRED",
] as const;
export const workflowVersionStatusSchema = z.enum(workflowVersionStatuses);
export type WorkflowVersionStatus = z.infer<typeof workflowVersionStatusSchema>;

export const customDomainVerificationStatuses = [
  "PENDING",
  "VERIFIED",
  "FAILED",
] as const;
export const customDomainVerificationStatusSchema = z.enum(
  customDomainVerificationStatuses,
);
export type CustomDomainVerificationStatus = z.infer<
  typeof customDomainVerificationStatusSchema
>;

export const sslStatuses = ["PENDING", "ACTIVE", "FAILED", "EXPIRED"] as const;
export const sslStatusSchema = z.enum(sslStatuses);
export type SslStatus = z.infer<typeof sslStatusSchema>;

export const customDevelopmentStatuses = [
  "REQUESTED",
  "REVIEWED",
  "SCOPED",
  "QUOTED",
  "CLIENT_APPROVED",
  "DESIGNED",
  "DEVELOPED",
  "TESTED",
  "STAGED",
  "CLIENT_UAT",
  "APPROVED",
  "DEPLOYED",
  "ENABLED",
] as const;
export const customDevelopmentStatusSchema = z.enum(customDevelopmentStatuses);
export type CustomDevelopmentStatus = z.infer<
  typeof customDevelopmentStatusSchema
>;

export const auditResults = ["SUCCESS", "FAILURE"] as const;
export const auditResultSchema = z.enum(auditResults);
export type AuditResult = z.infer<typeof auditResultSchema>;

export const outboxStatuses = ["PENDING", "PUBLISHED", "FAILED"] as const;
export const outboxStatusSchema = z.enum(outboxStatuses);
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

export const customFieldValueSchemas = {
  TEXT: z.string(),
  NUMBER: z.number().finite(),
  BOOLEAN: z.boolean(),
  DATE: z.iso.date(),
  DATETIME: z.iso.datetime(),
  CURRENCY: z.object({
    amount: z.string().regex(/^-?\d+(\.\d{1,6})?$/),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
  }),
  SELECT: z.string().min(1),
  MULTI_SELECT: z.array(z.string().min(1)).min(1),
  REFERENCE: z.object({ resource: z.string().min(1), id: z.uuid() }),
} satisfies Record<CustomFieldType, z.ZodType>;

export function parseCustomFieldValue(
  type: CustomFieldType,
  value: unknown,
): unknown {
  return customFieldValueSchemas[type].parse(value);
}
