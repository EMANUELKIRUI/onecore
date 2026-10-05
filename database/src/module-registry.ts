import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  canTransitionModuleLifecycle,
  compareSemanticVersions,
  moduleManifestSchema,
  resolveModuleActivationOrder,
  validateModuleDependencyGraph,
  type ModuleDependencyNode,
  type ModuleLifecycle,
  type ModuleManifest,
} from "@onecore/core-domain";
import type { Database } from "./index.js";
import type { OrganizationTransaction } from "./tenant-context.js";
import {
  auditLogs,
  features,
  moduleDependencies,
  modulePermissions,
  moduleVersions,
  modules,
  permissions,
  platformUserRoles,
  sessions,
  users,
} from "../schema/index.js";
import { withAuthenticatedUserTransaction } from "./tenant-context.js";

export interface ModuleRegistryActor {
  userId: string;
  sessionId: string;
}

export interface RegisteredModule {
  key: string;
  name: string;
  description: string | null;
  lifecycle: ModuleLifecycle;
  isAvailable: boolean;
  version: string;
  manifest: ModuleManifest;
}

export interface ModuleRegistry {
  list(): Promise<RegisteredModule[]>;
  get(moduleName: string): Promise<RegisteredModule | undefined>;
  register(
    manifest: unknown,
    actor: ModuleRegistryActor,
    requestId: string,
  ): Promise<RegisteredModule>;
  transitionLifecycle(
    moduleName: string,
    lifecycle: ModuleLifecycle,
    actor: ModuleRegistryActor,
    requestId: string,
  ): Promise<RegisteredModule>;
}

interface ModuleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  lifecycle: ModuleLifecycle;
  isAvailable: boolean;
}

async function loadDependencyNodes(
  transaction: OrganizationTransaction,
): Promise<{
  nodes: ModuleDependencyNode[];
  rows: ModuleRow[];
  latestVersions: Map<string, typeof moduleVersions.$inferSelect>;
}> {
  const rows = await transaction
    .select({
      id: modules.id,
      key: modules.key,
      name: modules.name,
      description: modules.description,
      lifecycle: modules.lifecycle,
      isAvailable: modules.isAvailable,
    })
    .from(modules);
  const versions = await transaction
    .select()
    .from(moduleVersions)
    .orderBy(desc(moduleVersions.createdAt));
  const latestVersions = new Map<string, (typeof versions)[number]>();
  for (const version of versions) {
    if (!latestVersions.has(version.moduleId)) {
      latestVersions.set(version.moduleId, version);
    }
  }
  const dependencies = await transaction
    .select({
      moduleId: moduleDependencies.moduleId,
      dependencyModuleId: moduleDependencies.dependencyModuleId,
      minimumVersion: moduleDependencies.minimumVersion,
    })
    .from(moduleDependencies);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const nodes: ModuleDependencyNode[] = rows.map((row) => {
    const version = latestVersions.get(row.id);
    if (!version)
      throw new Error(`Registered module has no version: ${row.key}`);
    const manifest = moduleManifestSchema.parse(version.manifest);
    if (manifest.name !== row.key || manifest.version !== version.version) {
      throw new Error(`Stored module manifest is inconsistent: ${row.key}`);
    }
    if (manifest.lifecycle !== row.lifecycle) {
      throw new Error(`Stored module lifecycle is inconsistent: ${row.key}`);
    }
    const dependencyRows = dependencies.filter(
      (dependency) => dependency.moduleId === row.id,
    );
    return {
      name: row.key,
      version: version.version,
      lifecycle: row.lifecycle,
      dependencies: dependencyRows.map((dependency) => {
        const dependencyModule = byId.get(dependency.dependencyModuleId);
        if (!dependencyModule) {
          throw new Error(`Missing module dependency for ${row.key}`);
        }
        return {
          moduleName: dependencyModule.key,
          ...(dependency.minimumVersion
            ? { minimumVersion: dependency.minimumVersion }
            : {}),
        };
      }),
    };
  });
  return { nodes, rows, latestVersions };
}

export function createModuleRegistry(database: Database): ModuleRegistry {
  async function verifyPlatformActor(
    transaction: OrganizationTransaction,
    actor: ModuleRegistryActor,
  ): Promise<void> {
    const [validSession] = await transaction
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, actor.sessionId),
          eq(sessions.userId, actor.userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
          eq(users.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!validSession) throw new Error("MODULE_REGISTRY_UNAUTHORIZED");
    const [platformRole] = await transaction
      .select({ role: platformUserRoles.role })
      .from(platformUserRoles)
      .where(
        and(
          eq(platformUserRoles.userId, actor.userId),
          eq(platformUserRoles.role, "SUPERADMIN"),
        ),
      )
      .limit(1);
    if (!platformRole) throw new Error("MODULE_REGISTRY_UNAUTHORIZED");
  }

  async function auditPlatformEvent(
    transaction: OrganizationTransaction,
    actor: ModuleRegistryActor,
    requestId: string,
    action: "MODULE_REGISTERED" | "MODULE_LIFECYCLE_CHANGED",
    moduleName: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await transaction.insert(auditLogs).values({
      organizationId: null,
      actorUserId: actor.userId,
      action,
      resource: "module_registry",
      resourceId: moduleName,
      result: "SUCCESS",
      requestMetadata: { requestId, ...details },
    });
  }

  async function readModule(
    key: string,
    transaction: OrganizationTransaction | Database = database,
  ): Promise<RegisteredModule | undefined> {
    const [row] = await transaction
      .select({
        id: modules.id,
        key: modules.key,
        name: modules.name,
        description: modules.description,
        lifecycle: modules.lifecycle,
        isAvailable: modules.isAvailable,
      })
      .from(modules)
      .where(eq(modules.key, key))
      .limit(1);
    if (!row) return undefined;
    const [version] = await transaction
      .select()
      .from(moduleVersions)
      .where(eq(moduleVersions.moduleId, row.id))
      .orderBy(desc(moduleVersions.createdAt))
      .limit(1);
    if (!version) throw new Error(`Registered module has no version: ${key}`);
    const manifest = moduleManifestSchema.parse(version.manifest);
    if (
      manifest.name !== row.key ||
      manifest.version !== version.version ||
      manifest.lifecycle !== row.lifecycle
    ) {
      throw new Error(`Stored module manifest is inconsistent: ${row.key}`);
    }
    return {
      ...row,
      version: version.version,
      manifest,
    };
  }

  return {
    async list() {
      const rows = await database
        .select({
          id: modules.id,
          key: modules.key,
          name: modules.name,
          description: modules.description,
          lifecycle: modules.lifecycle,
          isAvailable: modules.isAvailable,
        })
        .from(modules)
        .orderBy(modules.key);
      const versions = await database
        .select()
        .from(moduleVersions)
        .orderBy(desc(moduleVersions.createdAt));
      const latestVersions = new Map<string, (typeof versions)[number]>();
      for (const version of versions) {
        if (!latestVersions.has(version.moduleId)) {
          latestVersions.set(version.moduleId, version);
        }
      }
      return rows.map((row) => {
        const version = latestVersions.get(row.id);
        if (!version)
          throw new Error(`Registered module has no version: ${row.key}`);
        const manifest = moduleManifestSchema.parse(version.manifest);
        if (
          manifest.name !== row.key ||
          manifest.version !== version.version ||
          manifest.lifecycle !== row.lifecycle
        ) {
          throw new Error(`Stored module manifest is inconsistent: ${row.key}`);
        }
        return {
          key: row.key,
          name: row.name,
          description: row.description,
          lifecycle: row.lifecycle,
          isAvailable: row.isAvailable,
          version: version.version,
          manifest,
        };
      });
    },
    async get(moduleName) {
      return readModule(moduleName);
    },
    async register(manifestInput, actor, requestId) {
      const manifest = moduleManifestSchema.parse(manifestInput);
      if (manifest.lifecycle !== "DEVELOPMENT") {
        throw new Error("MODULE_REGISTRATION_MUST_START_IN_DEVELOPMENT");
      }
      if (
        manifest.permissions.some(
          (permission) =>
            !permission.startsWith(`${manifest.name}.`) ||
            permission.split(".").slice(0, -2).join(".") !== manifest.name,
        )
      ) {
        throw new Error("MODULE_MANIFEST_PERMISSION_MODULE_MISMATCH");
      }
      return withAuthenticatedUserTransaction(
        database,
        actor.userId,
        async (transaction) => {
          await verifyPlatformActor(transaction, actor);
          const [duplicate] = await transaction
            .select({ id: modules.id })
            .from(modules)
            .where(eq(modules.key, manifest.name))
            .limit(1);
          if (duplicate) throw new Error("MODULE_ALREADY_REGISTERED");

          const permissionRows = manifest.permissions.length
            ? await transaction
                .select({ id: permissions.id, key: permissions.key })
                .from(permissions)
                .where(inArray(permissions.key, manifest.permissions))
            : [];
          if (permissionRows.length !== manifest.permissions.length) {
            throw new Error("MODULE_MANIFEST_PERMISSION_UNKNOWN");
          }
          const { nodes } = await loadDependencyNodes(transaction);
          for (const dependency of manifest.dependencies) {
            if (!nodes.some((node) => node.name === dependency.moduleName)) {
              throw new Error(
                `MODULE_DEPENDENCY_NOT_FOUND:${dependency.moduleName}`,
              );
            }
          }
          validateModuleDependencyGraph([
            ...nodes,
            {
              name: manifest.name,
              version: manifest.version,
              lifecycle: "DEVELOPMENT",
              dependencies: manifest.dependencies,
            },
          ]);
          const [module] = await transaction
            .insert(modules)
            .values({
              key: manifest.name,
              name: manifest.displayName,
              description: manifest.description ?? null,
              lifecycle: "DEVELOPMENT",
              isAvailable: false,
            })
            .returning();
          if (!module) throw new Error("MODULE_REGISTRATION_FAILED");
          await transaction.insert(moduleVersions).values({
            moduleId: module.id,
            version: manifest.version,
            status: manifest.lifecycle,
            manifest,
          });
          for (const dependency of manifest.dependencies) {
            const dependencyModule = nodes.find(
              (node) => node.name === dependency.moduleName,
            );
            const dependencyRow = dependencyModule
              ? await transaction
                  .select({ id: modules.id })
                  .from(modules)
                  .where(eq(modules.key, dependency.moduleName))
                  .limit(1)
              : [];
            if (!dependencyRow[0]) {
              throw new Error(
                `MODULE_DEPENDENCY_NOT_FOUND:${dependency.moduleName}`,
              );
            }
            await transaction.insert(moduleDependencies).values({
              moduleId: module.id,
              dependencyModuleId: dependencyRow[0].id,
              minimumVersion: dependency.minimumVersion ?? null,
            });
          }
          for (const permission of permissionRows) {
            await transaction.insert(modulePermissions).values({
              moduleId: module.id,
              permissionId: permission.id,
            });
          }
          for (const featureKey of manifest.features) {
            await transaction
              .insert(features)
              .values({
                moduleId: module.id,
                key: featureKey,
                name: featureKey,
              })
              .onConflictDoNothing();
          }
          await auditPlatformEvent(
            transaction,
            actor,
            requestId,
            "MODULE_REGISTERED",
            module.key,
            { version: manifest.version, lifecycle: manifest.lifecycle },
          );
          return {
            ...module,
            version: manifest.version,
            manifest,
          };
        },
      );
    },
    async transitionLifecycle(moduleName, lifecycle, actor, requestId) {
      return withAuthenticatedUserTransaction(
        database,
        actor.userId,
        async (transaction) => {
          await verifyPlatformActor(transaction, actor);
          const { nodes, rows, latestVersions } =
            await loadDependencyNodes(transaction);
          const currentNode = nodes.find((node) => node.name === moduleName);
          const currentRow = rows.find((row) => row.key === moduleName);
          if (!currentNode || !currentRow) {
            throw new Error("MODULE_NOT_FOUND");
          }
          if (!canTransitionModuleLifecycle(currentNode.lifecycle, lifecycle)) {
            throw new Error("INVALID_MODULE_LIFECYCLE_TRANSITION");
          }
          const nextNode = { ...currentNode, lifecycle };
          const nextNodes = nodes.map((node) =>
            node.name === moduleName ? nextNode : node,
          );
          validateModuleDependencyGraph(nextNodes);
          if (lifecycle === "AVAILABLE") {
            resolveModuleActivationOrder(nextNodes, moduleName);
            for (const permissionKey of (
              latestVersions.get(currentRow.id)?.manifest as ModuleManifest
            ).permissions) {
              const [permission] = await transaction
                .select({ id: permissions.id })
                .from(permissions)
                .where(eq(permissions.key, permissionKey))
                .limit(1);
              if (!permission) {
                throw new Error("MODULE_MANIFEST_PERMISSION_UNKNOWN");
              }
            }
          }
          const [updated] = await transaction
            .update(modules)
            .set({
              lifecycle,
              isAvailable: lifecycle === "AVAILABLE",
              updatedAt: new Date(),
            })
            .where(eq(modules.id, currentRow.id))
            .returning();
          if (!updated) throw new Error("MODULE_LIFECYCLE_UPDATE_FAILED");
          const version = latestVersions.get(currentRow.id);
          if (!version) throw new Error("MODULE_VERSION_NOT_FOUND");
          const manifest = moduleManifestSchema.parse(version.manifest);
          const updatedManifest = { ...manifest, lifecycle };
          await transaction
            .update(moduleVersions)
            .set({ status: lifecycle, manifest: updatedManifest })
            .where(eq(moduleVersions.id, version.id));
          await auditPlatformEvent(
            transaction,
            actor,
            requestId,
            "MODULE_LIFECYCLE_CHANGED",
            moduleName,
            {
              from: currentNode.lifecycle,
              to: lifecycle,
              version: version.version,
            },
          );
          return {
            ...updated,
            version: version.version,
            manifest: updatedManifest,
          };
        },
      );
    },
  };
}

export function moduleVersionSatisfies(
  actual: string,
  minimum: string | null,
): boolean {
  return minimum === null || compareSemanticVersions(actual, minimum) >= 0;
}
