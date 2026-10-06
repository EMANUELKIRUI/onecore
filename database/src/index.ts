import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

export * from "../schema/index.js";
export {
  withActiveBranchTransaction,
  withActiveOrganizationTransaction,
} from "./tenant-context.js";
export type {
  OrganizationTransaction,
  VerifiedBranch,
  VerifiedOrganizationMembership,
} from "./tenant-context.js";
export {
  createOrganizationRepository,
  type OrganizationRepository,
} from "./organization-repository.js";
export { recordOutboxEvent, type DomainEvent } from "./outbox.js";
export {
  calculateEventRetryDelay,
  createEventHandlerRegistry,
  dispatchAuthorizedOutboxBatch,
  dispatchOutboxBatch,
  EventDispatchError,
  eventDeadLetterReadPermission,
  eventDispatchPermission,
  isRetryableFailure,
  listAuthorizedEventDeadLetters,
  listEventDeadLetters,
  platformAuditEventHandlers,
  replayEventDeadLetter,
  replayAuthorizedEventDeadLetter,
  type EventDeadLetterSummary,
  type EventDispatchOptions,
  type EventDispatchResult,
  type EventHandlerRegistry,
  type EventHandler,
} from "./event-dispatcher.js";
export {
  createIdentityRepository,
  type AuthenticationAuditEvent,
  type IdentityBranch,
  type IdentityMembership,
  type IdentityRepository,
  type IdentitySession,
  type IdentityUser,
} from "./identity-repository.js";
export {
  evaluateFeatureFlag,
  resolveFeatureFlag,
  type FeatureFlagContext,
  type FeatureFlagValue,
  type VerifiedFeatureFlagContext,
} from "./feature-flags.js";
export {
  createAuthorizationService,
  denyAllAuthorizationService,
  writeAuthorizationMutationEvent,
  type AuthorizationContext,
  type AuthorizationDecision,
  type AuthorizationMetadata,
  type AuthorizationResult,
  type AuthorizationService,
  type ActiveAuthorizationContext,
  type PermissionGrant,
  type ResolvedAuthorizationContext,
} from "./authorization.js";
export {
  permissionRequiresBranch,
  resolveEffectivePermissionGrants,
  type PermissionGrantCandidate,
} from "./authorization-policy.js";
export {
  createModuleRegistry,
  moduleVersionSatisfies,
  type ModuleRegistry,
  type ModuleRegistryActor,
  type RegisteredModule,
} from "./module-registry.js";
export {
  loadOrganizationModuleActivationAccess,
  loadOrganizationModuleAccess,
  resolveOrganizationModuleActivationAccess,
  resolveOrganizationModuleAccess,
  type OrganizationModuleAccess,
  type OrganizationModuleCandidate,
} from "./module-entitlements.js";
export {
  createPlatformServices,
  type PlatformServices,
  type SearchResult,
} from "./platform-services.js";
export {
  calculateJobRetryDelay,
  createJobHandlerRegistry,
  createJobService,
  IdempotencyConflictError,
  JobExecutionError,
  type JobClaim,
  type JobHandler,
  type JobHandlerContext,
  type JobHandlerRegistry,
  type JobService,
  type JobWorkerOptions,
} from "./jobs.js";
export {
  createLocalStorageProvider,
  createStorageService,
  type LocalStorageOptions,
  type PlatformStorageObject,
  type StorageProvider,
  type StorageService,
  type StoredObjectRecord,
  type StorageUploadInput,
} from "./storage.js";

export type Database = PostgresJsDatabase;

export function createDatabase(connectionString: string): {
  db: Database;
  close: () => Promise<void>;
} {
  const parsedUrl = new URL(connectionString);
  if (
    parsedUrl.protocol !== "postgres:" &&
    parsedUrl.protocol !== "postgresql:"
  ) {
    throw new TypeError(
      "DATABASE_URL must use the postgres or postgresql protocol",
    );
  }

  const client = postgres(connectionString);
  return {
    db: drizzle({ client }),
    close: () => client.end(),
  };
}
