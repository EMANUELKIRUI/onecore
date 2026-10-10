import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

export * from "../schema/index.js";
export {
  withActiveBranchTransaction,
  withActiveOrganizationTransaction,
  withOrganizationTransaction,
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
  createLifecycleMutationService,
  LifecycleMutationError,
  type LifecycleMutationService,
  type LifecycleRequestMetadata,
  type PlatformLifecycleActor,
} from "./lifecycle-mutations.js";
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
  calculateWebhookRetryDelay,
  classifyWebhookHttpStatus,
  platformWebhookEventHandlers,
  webhookEventMatches,
  type WebhookResponseDisposition,
} from "./webhooks.js";
export {
  createCommunicationService,
  type CommunicationService,
  type QueueCommunicationOutcome,
} from "./communications.js";
export {
  createCommunicationDeliveryWorker,
  createCommunicationProviderRegistry,
  emailOnlyRecipientResolver,
  type CommunicationDeliveryWorker,
  type CommunicationProviderRegistry,
  type CommunicationRecipientResolver,
  type CommunicationWorkerOptions,
  type CommunicationWorkerResult,
} from "./communication-worker.js";
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
  resourceScopeAllowsCreate,
  resourceScopePredicate,
  type ResourceScopeColumns,
  type ResourceScopeValues,
} from "./resource-authorization.js";
export {
  createCatalogItem,
  createCustomer,
  deleteCatalogItem,
  deleteCustomer,
  getCatalogItem,
  getCustomer,
  listCatalogItems,
  listCustomers,
  updateCatalogItem,
  updateCustomer,
} from "./business-manager.js";
export {
  createSale,
  cancelSale,
  getSale,
  listSales,
  type CreateSaleOutcome,
  type CancelSaleOutcome,
  type SaleWithLines,
} from "./sales.js";
export {
  adjustBranchStock,
  createSaleReservations,
  listBranchStock,
  releaseSaleReservations,
  InsufficientStockError,
  type InventoryAdjustmentOutcome,
  type SaleStockLine,
  type StockBalance,
} from "./inventory.js";
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
  createInAppNotificationInTransaction,
  type PlatformServices,
  type SearchResult,
} from "./platform-services.js";
export {
  createWorkflowEventHandlers,
  createWorkflowJobHandler,
  validateWorkflowVersionForExecution,
  type WorkflowJobPayload,
} from "./workflows.js";
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
  type JobWorkerOutcome,
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
export {
  createDatabaseRateLimiter,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimitInput,
} from "./rate-limiter.js";
export {
  createServiceTelemetry,
  observeServiceOperation,
} from "./service-telemetry.js";

export type Database = PostgresJsDatabase;

export async function checkDatabaseConnectivity(
  database: Database,
): Promise<void> {
  await database.execute(sql`select 1`);
}

export function createDatabase(
  connectionString: string,
  options: { maxConnections?: number } = {},
): {
  db: Database;
  close: () => Promise<void>;
  closeWithTimeout: (timeoutSeconds: number) => Promise<void>;
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

  if (
    options.maxConnections !== undefined &&
    (!Number.isInteger(options.maxConnections) ||
      options.maxConnections < 1 ||
      options.maxConnections > 100)
  ) {
    throw new RangeError("maxConnections must be an integer between 1 and 100");
  }
  const client = postgres(
    connectionString,
    options.maxConnections ? { max: options.maxConnections } : undefined,
  );
  return {
    db: drizzle({ client }),
    close: () => client.end(),
    closeWithTimeout: (timeoutSeconds) =>
      client.end({ timeout: timeoutSeconds }),
  };
}
