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
  "AVAILABLE",
  "ENABLED",
  "DISABLED",
  "SUSPENDED",
] as const;
export const organizationModuleStatusSchema = z.enum(
  organizationModuleStatuses,
);
export type OrganizationModuleStatus = z.infer<
  typeof organizationModuleStatusSchema
>;

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
