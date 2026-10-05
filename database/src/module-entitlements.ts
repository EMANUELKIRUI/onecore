import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import {
  compareSemanticVersions,
  moduleManifestSchema,
  resolveModuleAccess,
  type ModuleAccessFailure,
  type ModuleLifecycle,
  type OrganizationModuleStatus,
} from "@onecore/core-domain";
import type { OrganizationTransaction } from "./tenant-context.js";
import {
  moduleDependencies,
  moduleVersions,
  modules,
  organizationModules,
  planModules,
  plans,
  subscriptionItems,
  subscriptions,
} from "../schema/index.js";

export interface OrganizationModuleCandidate {
  name: string;
  lifecycle: ModuleLifecycle;
  isAvailable: boolean;
  version: string;
  entitlementStatus: OrganizationModuleStatus | null;
  planAllowsModule: boolean;
  dependencies: {
    moduleName: string;
    minimumVersion: string | null;
  }[];
}

export type OrganizationModuleAccess =
  { allowed: true } | { allowed: false; reason: ModuleAccessFailure };

export function resolveOrganizationModuleAccess(
  candidates: readonly OrganizationModuleCandidate[],
): Map<string, OrganizationModuleAccess> {
  const byName = new Map(
    candidates.map((candidate) => [candidate.name, candidate]),
  );
  const results = new Map<string, OrganizationModuleAccess>();
  const visiting = new Set<string>();

  function resolve(name: string): OrganizationModuleAccess {
    const cached = results.get(name);
    if (cached) return cached;
    const candidate = byName.get(name);
    if (!candidate) {
      return { allowed: false, reason: "MODULE_NOT_FOUND" };
    }
    if (visiting.has(name)) {
      return { allowed: false, reason: "DEPENDENCY_NOT_SATISFIED" };
    }
    visiting.add(name);
    const dependenciesEnabled = candidate.dependencies.every((dependency) => {
      const required = byName.get(dependency.moduleName);
      return (
        required !== undefined &&
        (!dependency.minimumVersion ||
          compareSemanticVersions(
            required.version,
            dependency.minimumVersion,
          ) >= 0) &&
        resolve(dependency.moduleName).allowed
      );
    });
    visiting.delete(name);
    const result = resolveModuleAccess({
      registered: true,
      lifecycle: candidate.lifecycle,
      isAvailable: candidate.isAvailable,
      entitlementStatus: candidate.entitlementStatus,
      planAllowsModule: candidate.planAllowsModule,
      dependenciesEnabled,
    });
    results.set(name, result);
    return result;
  }

  for (const candidate of candidates) resolve(candidate.name);
  return results;
}

export function resolveOrganizationModuleActivationAccess(
  candidates: readonly OrganizationModuleCandidate[],
  moduleName: string,
): OrganizationModuleAccess {
  const byName = new Map(
    candidates.map((candidate) => [candidate.name, candidate]),
  );
  const candidate = byName.get(moduleName);
  if (!candidate) return { allowed: false, reason: "MODULE_NOT_FOUND" };
  if (candidate.lifecycle !== "AVAILABLE" || !candidate.isAvailable) {
    return { allowed: false, reason: "MODULE_UNAVAILABLE" };
  }
  if (!candidate.planAllowsModule) {
    return { allowed: false, reason: "SUBSCRIPTION_NOT_ALLOWED" };
  }
  const access = resolveOrganizationModuleAccess(candidates);
  return candidate.dependencies.every(
    (dependency) => access.get(dependency.moduleName)?.allowed === true,
  )
    ? { allowed: true }
    : { allowed: false, reason: "DEPENDENCY_NOT_SATISFIED" };
}

async function loadOrganizationModuleCandidates(
  transaction: OrganizationTransaction,
  organizationId: string,
  now = new Date(),
): Promise<OrganizationModuleCandidate[]> {
  const moduleRows = await transaction
    .select({
      id: modules.id,
      name: modules.key,
      lifecycle: modules.lifecycle,
      isAvailable: modules.isAvailable,
    })
    .from(modules);
  const organizationModuleRows = await transaction
    .select({
      moduleId: organizationModules.moduleId,
      status: organizationModules.status,
    })
    .from(organizationModules)
    .where(eq(organizationModules.organizationId, organizationId));
  const activeSubscriptionRows = await transaction
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.organizationId, organizationId),
        or(
          and(
            eq(subscriptions.status, "ACTIVE"),
            or(
              isNull(subscriptions.startsAt),
              lte(subscriptions.startsAt, now),
            ),
            or(isNull(subscriptions.endsAt), gt(subscriptions.endsAt, now)),
          ),
          and(
            eq(subscriptions.status, "GRACE_PERIOD"),
            or(
              isNull(subscriptions.startsAt),
              lte(subscriptions.startsAt, now),
            ),
            gt(subscriptions.gracePeriodEndsAt, now),
          ),
        ),
      ),
    );
  const activeSubscriptionIds = activeSubscriptionRows.map(({ id }) => id);
  const itemRows = activeSubscriptionIds.length
    ? await transaction
        .select({
          planId: subscriptionItems.planId,
          moduleId: subscriptionItems.moduleId,
        })
        .from(subscriptionItems)
        .where(
          and(
            eq(subscriptionItems.organizationId, organizationId),
            inArray(subscriptionItems.subscriptionId, activeSubscriptionIds),
          ),
        )
    : [];
  const directModuleIds = itemRows
    .map(({ moduleId }) => moduleId)
    .filter((moduleId): moduleId is string => moduleId !== null);
  const planIds = [
    ...new Set(
      itemRows
        .map(({ planId }) => planId)
        .filter((planId): planId is string => planId !== null),
    ),
  ];
  const planModuleRows = planIds.length
    ? await transaction
        .select({ moduleId: planModules.moduleId })
        .from(planModules)
        .innerJoin(plans, eq(planModules.planId, plans.id))
        .where(
          and(
            inArray(planModules.planId, planIds),
            eq(plans.isAvailable, true),
          ),
        )
    : [];
  const planAllowedModuleIds = new Set([
    ...directModuleIds,
    ...planModuleRows.map(({ moduleId }) => moduleId),
  ]);
  const versionRows = await transaction
    .select({
      moduleId: moduleVersions.moduleId,
      version: moduleVersions.version,
      status: moduleVersions.status,
      manifest: moduleVersions.manifest,
    })
    .from(moduleVersions)
    .orderBy(desc(moduleVersions.createdAt));
  const latestVersionRows = new Map<string, (typeof versionRows)[number]>();
  for (const version of versionRows) {
    if (!latestVersionRows.has(version.moduleId)) {
      latestVersionRows.set(version.moduleId, version);
    }
  }
  const manifestsByModule = new Map<
    string,
    ReturnType<typeof moduleManifestSchema.parse>
  >();
  for (const module of moduleRows) {
    const version = latestVersionRows.get(module.id);
    if (!version) {
      throw new Error(`Registered module has no version: ${module.name}`);
    }
    const manifest = moduleManifestSchema.parse(version.manifest);
    if (
      manifest.name !== module.name ||
      manifest.version !== version.version ||
      manifest.lifecycle !== module.lifecycle ||
      version.status !== module.lifecycle ||
      module.isAvailable !== (module.lifecycle === "AVAILABLE")
    ) {
      throw new Error(`Stored module manifest is inconsistent: ${module.name}`);
    }
    manifestsByModule.set(module.id, manifest);
  }
  const dependencyRows = await transaction
    .select({
      moduleId: moduleDependencies.moduleId,
      dependencyModuleId: moduleDependencies.dependencyModuleId,
      minimumVersion: moduleDependencies.minimumVersion,
    })
    .from(moduleDependencies);
  const moduleNameById = new Map(moduleRows.map(({ id, name }) => [id, name]));
  const dependenciesByModule = new Map<
    string,
    { moduleName: string; minimumVersion: string | null }[]
  >();
  for (const dependency of dependencyRows) {
    const moduleName = moduleNameById.get(dependency.dependencyModuleId);
    if (!moduleName) continue;
    const dependencies = dependenciesByModule.get(dependency.moduleId) ?? [];
    dependencies.push({
      moduleName,
      minimumVersion: dependency.minimumVersion,
    });
    dependenciesByModule.set(dependency.moduleId, dependencies);
  }
  for (const module of moduleRows) {
    const manifest = manifestsByModule.get(module.id);
    if (!manifest)
      throw new Error(`Module manifest not loaded: ${module.name}`);
    const declaredDependencies = manifest.dependencies
      .map(({ moduleName, minimumVersion }) => ({
        moduleName,
        minimumVersion: minimumVersion ?? null,
      }))
      .sort((left, right) => left.moduleName.localeCompare(right.moduleName));
    const persistedDependencies = (
      dependenciesByModule.get(module.id) ?? []
    ).sort((left, right) => left.moduleName.localeCompare(right.moduleName));
    if (
      JSON.stringify(declaredDependencies) !==
      JSON.stringify(persistedDependencies)
    ) {
      throw new Error(
        `Stored module dependencies are inconsistent: ${module.name}`,
      );
    }
  }
  const organizationStatusByModule = new Map(
    organizationModuleRows.map(({ moduleId, status }) => [moduleId, status]),
  );
  return moduleRows.map((module) => {
    const version = latestVersionRows.get(module.id);
    if (!version) throw new Error(`Module version not loaded: ${module.name}`);
    return {
      name: module.name,
      lifecycle: module.lifecycle,
      isAvailable: module.isAvailable,
      version: version.version,
      entitlementStatus: organizationStatusByModule.get(module.id) ?? null,
      planAllowsModule: planAllowedModuleIds.has(module.id),
      dependencies: dependenciesByModule.get(module.id) ?? [],
    };
  });
}

export async function loadOrganizationModuleAccess(
  transaction: OrganizationTransaction,
  organizationId: string,
  now = new Date(),
): Promise<Map<string, OrganizationModuleAccess>> {
  return resolveOrganizationModuleAccess(
    await loadOrganizationModuleCandidates(transaction, organizationId, now),
  );
}

export async function loadOrganizationModuleActivationAccess(
  transaction: OrganizationTransaction,
  organizationId: string,
  moduleName: string,
  now = new Date(),
): Promise<OrganizationModuleAccess> {
  return resolveOrganizationModuleActivationAccess(
    await loadOrganizationModuleCandidates(transaction, organizationId, now),
    moduleName,
  );
}
