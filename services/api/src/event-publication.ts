import {
  createDomainEvent,
  type EventType,
  type FeatureFlagType,
} from "@onecore/core-domain";
import {
  recordOutboxEvent,
  type OrganizationTransaction,
  type ResolvedAuthorizationContext,
} from "@onecore/database";

export async function recordConfigurationChangedEvent(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  requestId: string,
  resource: string,
  resourceId: string,
  changedFields: readonly string[],
): Promise<void> {
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType: "CONFIGURATION_CHANGED",
      organizationId: context.organizationId,
      ...(context.branch ? { branchId: context.branch.branchId } : {}),
      actorUserId: context.userId,
      aggregateType: resource,
      aggregateId: resourceId,
      payload: {
        resource,
        resourceId,
        changedFields: [...changedFields],
      },
      metadata: { requestId },
    }),
  );
}

export async function recordFeatureFlagChangedEvent(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  requestId: string,
  flagKey: string,
  valueType: FeatureFlagType,
  scope: "ORGANIZATION" | "BRANCH",
  flagId: string,
): Promise<void> {
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType: "FEATURE_FLAG_CHANGED",
      organizationId: context.organizationId,
      ...(scope === "BRANCH" && context.branch
        ? { branchId: context.branch.branchId }
        : {}),
      actorUserId: context.userId,
      aggregateType: "feature_flag",
      aggregateId: flagId,
      payload: { flagKey, valueType, scope },
      metadata: { requestId },
    }),
  );
}

export async function recordModuleEntitlementEvent(
  transaction: OrganizationTransaction,
  context: ResolvedAuthorizationContext,
  requestId: string,
  moduleKey: string,
  moduleId: string,
  enabled: boolean,
  source: "SUBSCRIPTION" | "MANUAL" | "CUSTOM",
): Promise<void> {
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType: enabled ? "MODULE_ENABLED" : "MODULE_DISABLED",
      organizationId: context.organizationId,
      ...(context.branch ? { branchId: context.branch.branchId } : {}),
      actorUserId: context.userId,
      aggregateType: "module_entitlement",
      aggregateId: moduleId,
      payload: { moduleKey, source },
      metadata: { requestId },
    }),
  );
}

export function eventTypeIsRegistered(eventType: string): eventType is EventType {
  return [
    "ORGANIZATION_CREATED",
    "ORGANIZATION_ACTIVATED",
    "USER_CREATED",
    "USER_INVITED",
    "USER_ROLE_CHANGED",
    "MODULE_ENABLED",
    "MODULE_DISABLED",
    "FEATURE_FLAG_CHANGED",
    "CONFIGURATION_CHANGED",
  ].includes(eventType);
}
