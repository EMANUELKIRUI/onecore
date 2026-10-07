import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  createAuthorizationService,
  createJobHandlerRegistry,
  createJobService,
  createStorageService,
  type AuthorizationContext,
  type AuthorizationService,
  type JobHandler,
  calculateJobRetryDelay,
} from "../src/index.js";
import * as schema from "../schema/index.js";
import { applyTestMigrations } from "./migration-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
let client: PGlite;
let database: ReturnType<typeof drizzle>;
let authorization: AuthorizationService;
let root: string;

const handler: JobHandler<{ recordId: string }> = {
  jobType: "reports.refresh",
  owningModule: "core.reports",
  requiredModuleEntitlement: "core.reports",
  payloadSchema: z.object({ recordId: z.uuid() }).strict(),
  execute: async () => undefined,
};

async function bootstrapOrganization() {
  const [organization] = await database
    .insert(schema.organizations)
    .values({
      name: "Phase 9 Storage",
      slug: `phase9-${crypto.randomUUID()}`,
      industry: "TEST",
      status: "ACTIVE",
      deploymentType: "SAAS",
    })
    .returning();
  if (!organization) throw new Error("Organization was not created");

  const [user] = await database
    .insert(schema.users)
    .values({
      email: `storage-${crypto.randomUUID()}@example.test`,
      displayName: "Storage User",
    })
    .returning();
  if (!user) throw new Error("User was not created");

  const [membership] = await database
    .insert(schema.organizationMemberships)
    .values({
      organizationId: organization.id,
      userId: user.id,
      status: "ACTIVE",
      branchAccessMode: "ALL",
    })
    .returning();
  if (!membership) throw new Error("Membership was not created");

  const [role] = await database
    .insert(schema.roles)
    .values({
      organizationId: organization.id,
      name: "Platform Operator",
      status: "ACTIVE",
    })
    .returning();
  if (!role) throw new Error("Role was not created");

  await database.insert(schema.membershipRoles).values({
    organizationId: organization.id,
    membershipId: membership.id,
    roleId: role.id,
  });

  const permissionKeys = [
    "core.organization.jobs.enqueue",
    "core.organization.jobs.manage",
    "core.organization.storage.manage",
    "core.organization.storage.read",
  ];
  const permissionRows = await database
    .select({ id: schema.permissions.id })
    .from(schema.permissions)
    .where(inArray(schema.permissions.key, permissionKeys));
  if (permissionRows.length !== permissionKeys.length) {
    throw new Error("Required permissions were not found");
  }

  await database.insert(schema.rolePermissions).values(
    permissionRows.map(({ id }) => ({
      organizationId: organization.id,
      roleId: role.id,
      permissionId: id,
      scopeType: "ORGANIZATION" as const,
    })),
  );

  const [module] = await database
    .insert(schema.modules)
    .values({
      key: "core.organization",
      name: "core.organization",
      lifecycle: "AVAILABLE",
      isAvailable: true,
    })
    .onConflictDoUpdate({
      target: schema.modules.key,
      set: {
        name: "core.organization",
        lifecycle: "AVAILABLE",
        isAvailable: true,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schema.modules.id });
  if (!module) throw new Error("Organization module was not created");

  await database
    .insert(schema.moduleVersions)
    .values({
      moduleId: module.id,
      version: "1.0.0",
      status: "AVAILABLE",
      manifest: {
        name: "core.organization",
        version: "1.0.0",
        displayName: "Organization Administration",
        lifecycle: "AVAILABLE",
        description: "Organization administration module",
        dependencies: [],
        permissions: [],
        features: [],
      },
    })
    .onConflictDoNothing();

  await database
    .insert(schema.organizationModules)
    .values({
      organizationId: organization.id,
      moduleId: module.id,
      status: "ENABLED",
      source: "MANUAL",
      enabledAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.organizationModules.organizationId,
        schema.organizationModules.moduleId,
      ],
      set: {
        status: "ENABLED",
        source: "MANUAL",
        enabledAt: new Date(),
      },
    });

  const [reportsModule] = await database
    .insert(schema.modules)
    .values({
      key: "core.reports",
      name: "core.reports",
      lifecycle: "AVAILABLE",
      isAvailable: true,
    })
    .onConflictDoUpdate({
      target: schema.modules.key,
      set: {
        name: "core.reports",
        lifecycle: "AVAILABLE",
        isAvailable: true,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schema.modules.id });
  if (!reportsModule) throw new Error("Reports module was not created");

  const [plan] = await database
    .insert(schema.plans)
    .values({
      key: "phase9-foundation",
      name: "Phase 9 Foundation",
      billingInterval: "MONTHLY",
      currencyCode: "KES",
      amount: "0.000000",
      isAvailable: true,
    })
    .onConflictDoUpdate({
      target: schema.plans.key,
      set: {
        name: "Phase 9 Foundation",
        billingInterval: "MONTHLY",
        currencyCode: "KES",
        amount: "0.000000",
        isAvailable: true,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schema.plans.id });
  if (!plan) throw new Error("Foundation plan was not created");

  await database
    .insert(schema.planModules)
    .values([
      { planId: plan.id, moduleId: module.id },
      { planId: plan.id, moduleId: reportsModule.id },
    ])
    .onConflictDoNothing();

  const [subscription] = await database
    .insert(schema.subscriptions)
    .values({
      organizationId: organization.id,
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60_000),
    })
    .returning({ id: schema.subscriptions.id });
  if (!subscription) throw new Error("Subscription was not created");

  await database.insert(schema.subscriptionItems).values({
    organizationId: organization.id,
    subscriptionId: subscription.id,
    planId: plan.id,
    amount: "0.000000",
    currencyCode: "KES",
  });

  await database
    .insert(schema.moduleVersions)
    .values({
      moduleId: reportsModule.id,
      version: "1.0.0",
      status: "AVAILABLE",
      manifest: {
        name: "core.reports",
        version: "1.0.0",
        displayName: "Reports",
        lifecycle: "AVAILABLE",
        description: "Reporting module",
        dependencies: [],
        permissions: [],
        features: [],
      },
    })
    .onConflictDoNothing();

  await database
    .insert(schema.organizationModules)
    .values({
      organizationId: organization.id,
      moduleId: reportsModule.id,
      status: "ENABLED",
      source: "MANUAL",
      enabledAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.organizationModules.organizationId,
        schema.organizationModules.moduleId,
      ],
      set: {
        status: "ENABLED",
        source: "MANUAL",
        enabledAt: new Date(),
      },
    });

  const sessionId = crypto.randomUUID();
  await database.insert(schema.sessions).values({
    id: sessionId,
    userId: user.id,
    organizationId: organization.id,
    secretHash: crypto.randomUUID().replaceAll("-", ""),
    expiresAt: new Date(Date.now() + 60_000),
  });

  return { organization, user, membership, role, sessionId };
}

async function setJobManageScope(
  roleId: string,
  scopeType: "ORGANIZATION" | "BRANCH" | "OWN",
) {
  const [permission] = await database
    .select({ id: schema.permissions.id })
    .from(schema.permissions)
    .where(eq(schema.permissions.key, "core.organization.jobs.manage"))
    .limit(1);
  if (!permission) throw new Error("Job management permission was not found");
  await database
    .update(schema.rolePermissions)
    .set({ scopeType })
    .where(
      and(
        eq(schema.rolePermissions.roleId, roleId),
        eq(schema.rolePermissions.permissionId, permission.id),
      ),
    );
}

async function insertJob(
  organizationId: string,
  branchId: string | null,
  createdByUserId: string,
  status: "QUEUED" | "FAILED" = "QUEUED",
) {
  const [job] = await database
    .insert(schema.jobs)
    .values({
      organizationId,
      branchId,
      createdByUserId,
      jobType: "reports.refresh",
      payload: {},
      requestHash: "a".repeat(64),
      correlationId: crypto.randomUUID(),
      status,
      maxAttempts: 3,
    })
    .returning({ id: schema.jobs.id });
  if (!job) throw new Error("Test job was not created");
  return job.id;
}

beforeAll(async () => {
  client = new PGlite();
  database = drizzle({ client });
  await client.exec(
    `CREATE ROLE onecore_app NOLOGIN NOBYPASSRLS; CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;`,
  );
  await applyTestMigrations(client, migrationsDirectory);
  await client.exec(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO onecore_app;`,
  );
  authorization = createAuthorizationService(database as never);
  root = await mkdtemp(join(tmpdir(), "onecore-storage-"));
}, 30_000);

afterAll(async () => {
  if (client) await client.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("durable job handler contracts", () => {
  it("registers stable typed job handlers and rejects duplicate names", () => {
    const registry = createJobHandlerRegistry([handler]);
    expect(registry.get("reports.refresh")).toBe(handler);
    expect(registry.list()).toEqual([handler]);
    expect(() => createJobHandlerRegistry([handler, { ...handler }])).toThrow(
      /Duplicate job handler/,
    );
    expect(() =>
      createJobHandlerRegistry([{ ...handler, jobType: "execute arbitrary" }]),
    ).toThrow();
  });

  it("uses bounded exponential retry delays", () => {
    expect(calculateJobRetryDelay(1, 1_000, 60_000)).toBe(1_000);
    expect(calculateJobRetryDelay(3, 1_000, 60_000)).toBe(4_000);
    expect(calculateJobRetryDelay(30, 1_000, 60_000)).toBe(60_000);
  });

  it("stores tenant-scoped objects with local bytes and rejects unsafe paths", async () => {
    const { organization, user, membership, sessionId } =
      await bootstrapOrganization();
    const service = createStorageService(database as never, authorization, {
      provider: "LOCAL",
      rootDirectory: root,
    });
    const context: AuthorizationContext = {
      userId: user.id,
      sessionId,
      organizationId: organization.id,
      membershipId: membership.id,
      branchId: null,
    };

    await expect(
      service.upload(
        context,
        { requestId: crypto.randomUUID() },
        {
          originalFilename: "../../outside.txt",
          mimeType: "text/plain",
          content: Buffer.from("hello"),
          byteSize: 5,
        },
      ),
    ).rejects.toThrow(/Invalid filename|path/);

    const uploaded = await service.upload(
      context,
      { requestId: crypto.randomUUID() },
      {
        originalFilename: "report.txt",
        mimeType: "text/plain",
        content: Buffer.from("hello"),
        byteSize: 5,
      },
    );
    expect(uploaded.allowed).toBe(true);
    if (!uploaded.allowed || !uploaded.value) throw new Error("Upload denied");

    const object = await service.get(
      context,
      { requestId: crypto.randomUUID() },
      uploaded.value.id,
    );
    expect(object.allowed).toBe(true);
    if (!object.allowed || !object.value)
      throw new Error("Object not available");
    expect(object.value.content.equals(Buffer.from("hello"))).toBe(true);
    expect(object.value.metadata.checksumSha256).toHaveLength(64);

    expect(
      await service.delete(
        context,
        { requestId: crypto.randomUUID() },
        uploaded.value.id,
      ),
    ).toMatchObject({ allowed: true, value: true });
  });

  it("stores branch-scoped objects within the storage-key column limit", async () => {
    const { organization, user, membership, sessionId } =
      await bootstrapOrganization();
    const [branch] = await database
      .insert(schema.branches)
      .values({
        organizationId: organization.id,
        name: "Storage Branch",
        code: `SB-${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: schema.branches.id });
    if (!branch) throw new Error("Storage branch was not created");
    await database
      .update(schema.sessions)
      .set({ branchId: branch.id })
      .where(eq(schema.sessions.id, sessionId));

    const service = createStorageService(database as never, authorization, {
      provider: "LOCAL",
      rootDirectory: root,
    });
    const context: AuthorizationContext = {
      userId: user.id,
      sessionId,
      organizationId: organization.id,
      membershipId: membership.id,
      branchId: branch.id,
    };
    const content = Buffer.from("branch");
    const uploaded = await service.upload(
      context,
      { requestId: crypto.randomUUID() },
      {
        originalFilename: "branch-report.txt",
        mimeType: "text/plain",
        content,
        byteSize: content.length,
      },
    );
    expect(uploaded.allowed).toBe(true);
    if (!uploaded.allowed || !uploaded.value)
      throw new Error("Branch-scoped upload denied");

    const object = await service.get(
      context,
      { requestId: crypto.randomUUID() },
      uploaded.value.id,
    );
    expect(object.allowed).toBe(true);
    if (!object.allowed || !object.value)
      throw new Error("Branch-scoped object unavailable");
    expect(object.value.metadata.storageKey.length).toBeLessThanOrEqual(100);
    expect(object.value.content.equals(content)).toBe(true);
    await expect(
      service.delete(
        context,
        { requestId: crypto.randomUUID() },
        uploaded.value.id,
      ),
    ).resolves.toMatchObject({ allowed: true, value: true });
  });

  it("authorizes job retry and cancellation through the job service", async () => {
    const { organization, user, membership, sessionId } =
      await bootstrapOrganization();
    const service = createJobService(
      database as never,
      authorization,
      createJobHandlerRegistry([handler]),
    );
    const context: AuthorizationContext = {
      userId: user.id,
      sessionId,
      organizationId: organization.id,
      membershipId: membership.id,
      branchId: null,
    };

    const enqueued = await service.enqueue(
      context,
      { requestId: crypto.randomUUID() },
      {
        jobType: "reports.refresh",
        payload: { recordId: crypto.randomUUID() },
        priority: 1,
        maxAttempts: 1,
      },
    );
    if (!enqueued.allowed || !enqueued.value) {
      throw new Error("Job was not enqueued");
    }
    const jobId = enqueued.value;
    await expect(
      service.retry(context, { requestId: crypto.randomUUID() }, jobId.id),
    ).resolves.toMatchObject({ allowed: true, value: false });
    await expect(
      service.cancel(context, { requestId: crypto.randomUUID() }, jobId.id),
    ).resolves.toMatchObject({ allowed: true, value: true });
  });

  it("applies branch scope to job cancellation and rejects branch overrides", async () => {
    const { organization, user, membership, role, sessionId } =
      await bootstrapOrganization();
    const [branchA] = await database
      .insert(schema.branches)
      .values({
        organizationId: organization.id,
        name: "Branch A",
        code: `A-${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: schema.branches.id });
    const [branchB] = await database
      .insert(schema.branches)
      .values({
        organizationId: organization.id,
        name: "Branch B",
        code: `B-${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: schema.branches.id });
    if (!branchA || !branchB) throw new Error("Branches were not created");

    await setJobManageScope(role.id, "BRANCH");
    await database
      .update(schema.sessions)
      .set({ branchId: branchA.id })
      .where(eq(schema.sessions.id, sessionId));
    const branchAJob = await insertJob(organization.id, branchA.id, user.id);
    const branchBJob = await insertJob(organization.id, branchB.id, user.id);
    const service = createJobService(
      database as never,
      authorization,
      createJobHandlerRegistry([handler]),
    );
    const context: AuthorizationContext = {
      userId: user.id,
      sessionId,
      organizationId: organization.id,
      membershipId: membership.id,
      branchId: branchA.id,
    };

    await expect(
      service.cancel(context, { requestId: crypto.randomUUID() }, branchAJob),
    ).resolves.toMatchObject({ allowed: true, value: true });
    await expect(
      service.cancel(context, { requestId: crypto.randomUUID() }, branchBJob),
    ).resolves.toMatchObject({ allowed: true, value: false });
  });

  it("applies own scope to job cancellation", async () => {
    const { organization, user, membership, role, sessionId } =
      await bootstrapOrganization();
    const [otherUser] = await database
      .insert(schema.users)
      .values({
        email: `other-${crypto.randomUUID()}@example.test`,
        displayName: "Other Job Owner",
      })
      .returning({ id: schema.users.id });
    if (!otherUser) throw new Error("Other user was not created");
    await database.insert(schema.organizationMemberships).values({
      organizationId: organization.id,
      userId: otherUser.id,
      status: "ACTIVE",
      branchAccessMode: "ALL",
    });

    await setJobManageScope(role.id, "OWN");
    const ownedJob = await insertJob(organization.id, null, user.id);
    const otherJob = await insertJob(organization.id, null, otherUser.id);
    const service = createJobService(
      database as never,
      authorization,
      createJobHandlerRegistry([handler]),
    );
    const context: AuthorizationContext = {
      userId: user.id,
      sessionId,
      organizationId: organization.id,
      membershipId: membership.id,
      branchId: null,
    };

    await expect(
      service.cancel(context, { requestId: crypto.randomUUID() }, ownedJob),
    ).resolves.toMatchObject({ allowed: true, value: true });
    await expect(
      service.cancel(context, { requestId: crypto.randomUUID() }, otherJob),
    ).resolves.toMatchObject({ allowed: true, value: false });
  });

  it("does not claim tenant jobs after the organization is suspended", async () => {
    const { organization } = await bootstrapOrganization();
    const service = createJobService(
      database as never,
      authorization,
      createJobHandlerRegistry([handler]),
    );
    await database
      .update(schema.organizations)
      .set({ status: "SUSPENDED" })
      .where(eq(schema.organizations.id, organization.id));

    await expect(
      service.processTenantBatch(
        organization.id,
        null,
        "suspended-tenant-worker",
      ),
    ).resolves.toBeUndefined();
  });
});
