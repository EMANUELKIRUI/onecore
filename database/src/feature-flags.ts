import type { FeatureFlagScope } from "@onecore/core-domain";

export interface FeatureFlagContext {
  organizationId: string;
  environment?: string;
  moduleId?: string;
  userId?: string;
}

export interface FeatureFlagValue {
  scope: FeatureFlagScope;
  enabled: boolean;
  environment: string | null;
  moduleId: string | null;
  organizationId: string | null;
  userId: string | null;
}

export function evaluateFeatureFlag(
  defaultEnabled: boolean,
  assignments: readonly FeatureFlagValue[],
  context: FeatureFlagContext,
): boolean {
  const matchingScopes: readonly FeatureFlagScope[] = [
    "USER",
    "ORGANIZATION",
    "MODULE",
    "ENVIRONMENT",
    "GLOBAL",
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
          return true;
      }
    });
    if (assignment) return assignment.enabled;
  }

  return defaultEnabled;
}
