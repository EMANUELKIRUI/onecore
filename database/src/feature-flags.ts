import {
  parseFeatureFlagValue,
  type FeatureFlagScope,
  type FeatureFlagType,
} from "@onecore/core-domain";

export interface FeatureFlagContext {
  organizationId: string;
  environment?: string;
  moduleId?: string;
  branchId?: string;
  userId?: string;
}

export interface VerifiedFeatureFlagContext extends FeatureFlagContext {
  authenticated: boolean;
  organizationActive: boolean;
  membershipActive: boolean;
  moduleEntitlements: ReadonlyMap<string, boolean>;
  platformAuthorized?: boolean;
}

export interface FeatureFlagDefinition {
  key: string;
  valueType: FeatureFlagType;
  defaultValue: unknown;
  isSecuritySensitive: boolean;
}

export interface FeatureFlagValue {
  scope: FeatureFlagScope;
  enabled: boolean;
  value?: unknown;
  environment: string | null;
  moduleId: string | null;
  organizationId: string | null;
  branchId?: string | null;
  userId: string | null;
}

export function evaluateFeatureFlag(
  defaultEnabled: boolean,
  assignments: readonly FeatureFlagValue[],
  context: FeatureFlagContext,
): boolean {
  const matchingScopes: readonly FeatureFlagScope[] = [
    "USER",
    "BRANCH",
    "ORGANIZATION",
    "MODULE",
    "ENVIRONMENT",
    "PLATFORM",
    "GLOBAL",
    "SYSTEM",
  ];

  for (const scope of matchingScopes) {
    const assignment = assignments.find((candidate) => {
      if (candidate.scope !== scope) return false;
      switch (scope) {
        case "USER":
          return (
            candidate.organizationId === context.organizationId &&
            context.userId !== undefined &&
            candidate.userId === context.userId
          );
        case "ORGANIZATION":
          return candidate.organizationId === context.organizationId;
        case "BRANCH":
          return (
            candidate.organizationId === context.organizationId &&
            context.branchId !== undefined &&
            candidate.branchId === context.branchId
          );
        case "MODULE":
          return (
            context.moduleId !== undefined &&
            candidate.moduleId === context.moduleId
          );
        case "ENVIRONMENT":
          return (
            context.environment !== undefined &&
            candidate.environment === context.environment
          );
        case "GLOBAL":
        case "PLATFORM":
        case "SYSTEM":
          return true;
      }
    });
    if (assignment) return assignment.enabled;
  }

  return defaultEnabled;
}

export function resolveFeatureFlag(
  definition: FeatureFlagDefinition,
  assignments: readonly FeatureFlagValue[],
  context: VerifiedFeatureFlagContext | null,
): unknown {
  const failClosedValue =
    definition.valueType === "BOOLEAN"
      ? false
      : definition.valueType === "STRING"
        ? ""
        : definition.valueType === "NUMBER"
          ? 0
          : null;
  if (
    !context ||
    !context.authenticated ||
    !context.organizationId ||
    !context.organizationActive ||
    !context.membershipActive
  ) {
    return failClosedValue;
  }

  if (
    context.moduleId !== undefined &&
    context.moduleEntitlements.get(context.moduleId) !== true
  ) {
    return failClosedValue;
  }

  let defaultValue: unknown;
  try {
    defaultValue = parseFeatureFlagValue(
      definition.valueType,
      definition.defaultValue,
    );
  } catch {
    defaultValue = failClosedValue;
  }

  const matchingScopes: readonly FeatureFlagScope[] =
    definition.isSecuritySensitive
      ? ["SYSTEM", "PLATFORM", "GLOBAL"]
      : [
          "USER",
          "BRANCH",
          "ORGANIZATION",
          "MODULE",
          "ENVIRONMENT",
          "PLATFORM",
          "GLOBAL",
          "SYSTEM",
        ];

  for (const scope of matchingScopes) {
    if (definition.isSecuritySensitive && context.platformAuthorized !== true) {
      return failClosedValue;
    }
    const assignment = assignments.find((candidate) => {
      if (candidate.scope !== scope) return false;
      switch (scope) {
        case "USER":
          return (
            candidate.organizationId === context.organizationId &&
            context.userId !== undefined &&
            candidate.userId === context.userId
          );
        case "BRANCH":
          return (
            candidate.organizationId === context.organizationId &&
            context.branchId !== undefined &&
            candidate.branchId === context.branchId
          );
        case "ORGANIZATION":
          return candidate.organizationId === context.organizationId;
        case "MODULE":
          return (
            context.moduleId !== undefined &&
            candidate.moduleId === context.moduleId &&
            context.moduleEntitlements.get(context.moduleId) === true
          );
        case "ENVIRONMENT":
          return (
            context.environment !== undefined &&
            candidate.environment === context.environment
          );
        case "PLATFORM":
        case "GLOBAL":
        case "SYSTEM":
          return true;
      }
    });
    if (!assignment) continue;
    try {
      return parseFeatureFlagValue(
        definition.valueType,
        assignment.value === undefined || assignment.value === null
          ? assignment.enabled
          : assignment.value,
      );
    } catch {
      return failClosedValue;
    }
  }

  return defaultValue;
}
