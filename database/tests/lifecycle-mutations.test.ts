import { fileURLToPath } from "node:url";
import { Algorithm, hash as hashPassword } from "@node-rs/argon2";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAuthorizationService,
  createLifecycleMutationService,
  withActiveOrganizationTransaction,
  type Database,
  type OrganizationTransaction,
  type PlatformLifecycleActor,
} from "../src/index.js";
import { createUser, inviteUser } from "../src/lifecycle-mutations.js";
import * as schema from "../schema/index.js";
import { applyTestMigrations } from "./migration-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

let client: PGlite;
let database: PgliteDatabase;
let applicationDatabase: Database;
let bootstrapPasswordHash: string;
const bootstrapPassword = "bootstrap-owner-test-password";

function metadata(correlationId: string = crypto.randomUUID()) {
  return { requestId: crypto.randomUUID(), correlationId };
}

function organizationInput(slug = `lifecycle-${crypto.randomUUID()}`) {
  return {
    name: "Lifecycle Organization",
    slug,
    industry: "TEST",
    deploymentType: "SAAS" as const,
    bootstrapOwner: {
      email: `owner-${crypto.randomUUID()}@example.test`,
      displayName: "Initial Owner",
      passwordHash: bootstrapPasswordHash,
    },
  };
}

async function createActor(superadmin = true): Promise<PlatformLifecycleActor> {
  const [user] = await database
    .insert(schema.users)
    .values({
      email: `lifecycle-${crypto.randomUUID()}@example.test`,
      displayName: "Lifecycle Actor",
      status: "ACTIVE",
    })
    .returning({ id: schema.users.id });
  if (!user) throw new Error("Lifecycle actor was not created");

  if (superadmin) {
    await database.insert(schema.platformUserRoles).values({
      userId: user.id,
      role: "SUPERADMIN",
    });
  }
  const [session] = await database
    .insert(schema.sessions)
    .values({
      secretHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning({ id: schema.sessions.id });
  if (!session) throw new Error("Lifecycle session was not created");
  return { userId: user.id, sessionId: session.id };
}

async function createOrganization(
  status: (typeof schema.organizations.$inferSelect)["status"] = "ACTIVE",
) {
  const [organization] = await database
    .insert(schema.organizations)
    .values({
      name: `Lifecycle ${crypto.randomUUID()}`,
      slug: `lifecycle-${crypto.randomUUID()}`,
      industry: "TEST",
      deploymentType: "SAAS",
      status,
    })
    .returning();
  if (!organization) throw new Error("Lifecycle organization was not created");
  return organization;
}

async function createApprovedApplication(
  lifecycle = createLifecycleMutationService(applicationDatabase),
  requestedModules: string[] = [],
) {
  const ownerEmail = `application-owner-${crypto.randomUUID()}@example.test`;
  const submitted = await lifecycle.submitOrganizationApplication(
    {
      name: "Application Organization",
      slug: `application-${crypto.randomUUID()}`,
      industry: "Retail",
      deploymentType: "SAAS",
      contactEmail: `contact-${crypto.randomUUID()}@example.test`,
      contactPhone: "+254700000000",
      ownerName: "Application Owner",
      ownerEmail,
      countryCode: "KE",
      region: "Nairobi",
      city: "Nairobi",
      address: "Central Nairobi",
      requestedModules,
    },
    metadata(),
  );
  const actor = await createActor();
  await lifecycle.transitionOrganizationApplication(
    submitted.organization.id,
    "UNDER_REVIEW",
    actor,
    metadata(),
  );
  await lifecycle.transitionOrganizationApplication(
    submitted.organization.id,
    "APPROVED",
    actor,
    metadata(),
  );
  return { actor, organization: submitted.organization, ownerEmail, lifecycle };
}

async function lifecycleRecordCounts() {
  const [
    organizations,
    users,
    memberships,
    branches,
    membershipBranches,
    roles,
    organizationModules,
    rolePermissions,
    membershipRoles,
    auditLogs,
    outboxEvents,
  ] = await Promise.all([
    database.select({ id: schema.organizations.id }).from(schema.organizations),
    database.select({ id: schema.users.id }).from(schema.users),
    database
      .select({ id: schema.organizationMemberships.id })
      .from(schema.organizationMemberships),
    database.select({ id: schema.branches.id }).from(schema.branches),
    database
      .select({ branchId: schema.membershipBranches.branchId })
      .from(schema.membershipBranches),
    database.select({ id: schema.roles.id }).from(schema.roles),
    database
      .select({ id: schema.organizationModules.id })
      .from(schema.organizationModules),
    database
      .select({ roleId: schema.rolePermissions.roleId })
      .from(schema.rolePermissions),
    database
      .select({ membershipId: schema.membershipRoles.membershipId })
      .from(schema.membershipRoles),
    database.select({ id: schema.auditLogs.id }).from(schema.auditLogs),
    database.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents),
  ]);
  return {
    organizations: organizations.length,
    users: users.length,
    memberships: memberships.length,
    branches: branches.length,
    membershipBranches: membershipBranches.length,
    roles: roles.length,
    organizationModules: organizationModules.length,
    rolePermissions: rolePermissions.length,
    membershipRoles: membershipRoles.length,
    auditLogs: auditLogs.length,
    outboxEvents: outboxEvents.length,
  };
}

async function inviteAsTenant<T>(
  organizationId: string,
  userId: string,
  operation: (transaction: OrganizationTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
    await transaction.execute(
      sql`SELECT set_config('app.current_user_id', ${userId}, true)`,
    );
    await transaction.execute(
      sql`SELECT set_config('app.current_organization_id', ${organizationId}, true)`,
    );
    return operation(transaction as unknown as OrganizationTransaction);
  });
}

async function withFailingInsert<T>(
  tableName:
    | "organizations"
    | "users"
    | "organization_memberships"
    | "roles"
    | "role_permissions"
    | "membership_roles"
    | "organization_modules"
    | "audit_logs"
    | "outbox_events",
  operation: () => Promise<T>,
): Promise<T> {
  await client.exec(`
    CREATE FUNCTION lifecycle_test_fail_insert()
    RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'Injected insert failure'; END; $$;
    CREATE TRIGGER lifecycle_test_fail_insert
    BEFORE INSERT ON "${tableName}"
    FOR EACH ROW EXECUTE FUNCTION lifecycle_test_fail_insert();
  `);
  try {
    return await operation();
  } finally {
    await client.exec(`
      DROP TRIGGER lifecycle_test_fail_insert ON "${tableName}";
      DROP FUNCTION lifecycle_test_fail_insert();
    `);
  }
}

async function withFailingUpdate<T>(
  tableName: "organizations",
  operation: () => Promise<T>,
): Promise<T> {
  await client.exec(`
    CREATE FUNCTION lifecycle_test_fail_update()
    RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'Injected update failure'; END; $$;
    CREATE TRIGGER lifecycle_test_fail_update
    BEFORE UPDATE ON "${tableName}"
    FOR EACH ROW EXECUTE FUNCTION lifecycle_test_fail_update();
  `);
  try {
    return await operation();
  } finally {
    await client.exec(`
      DROP TRIGGER lifecycle_test_fail_update ON "${tableName}";
      DROP FUNCTION lifecycle_test_fail_update();
    `);
  }
}

describe("production lifecycle mutations", () => {
  beforeAll(async () => {
    bootstrapPasswordHash = await hashPassword(bootstrapPassword, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });
    client = new PGlite();
    database = drizzle({ client });
    await client.exec(`
      CREATE ROLE onecore_app NOLOGIN NOBYPASSRLS;
      CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
    `);
    await applyTestMigrations(client, migrationsDirectory);
    applicationDatabase = {
      transaction: (
        operation: (transaction: OrganizationTransaction) => Promise<unknown>,
      ) =>
        database.transaction(async (transaction) => {
          await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
          return operation(transaction as unknown as OrganizationTransaction);
        }),
    } as unknown as Database;
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists only available modules in the public catalogue", async () => {
    const prefix = `public-catalogue-${crypto.randomUUID()}`;
    const moduleKeys = {
      available: `${prefix}.available`,
      disabled: `${prefix}.disabled`,
      retired: `${prefix}.retired`,
    };
    try {
      await database.insert(schema.modules).values([
        {
          key: moduleKeys.available,
          name: "Available module",
          description: "Public description",
          lifecycle: "AVAILABLE",
          isAvailable: true,
        },
        {
          key: moduleKeys.disabled,
          name: "Disabled module",
          lifecycle: "AVAILABLE",
          isAvailable: false,
        },
        {
          key: moduleKeys.retired,
          name: "Retired module",
          lifecycle: "RETIRED",
          isAvailable: true,
        },
      ]);
      const lifecycle = createLifecycleMutationService(
        database as unknown as Database,
      );

      const catalogue = await lifecycle.listPublicModules();

      expect(
        catalogue.filter(({ name }) => name === moduleKeys.available),
      ).toEqual([
        {
          name: moduleKeys.available,
          displayName: "Available module",
          description: "Public description",
        },
      ]);
    } finally {
      await database
        .delete(schema.modules)
        .where(inArray(schema.modules.key, Object.values(moduleKeys)));
    }
  });

  it("creates a pending organization with an active bootstrap owner, without adding the superadmin", async () => {
    const actor = await createActor();
    const lifecycle = createLifecycleMutationService(applicationDatabase);
    const input = organizationInput(`created-${crypto.randomUUID()}`);
    const result = await lifecycle.createOrganization(input, actor, metadata());

    expect(result.organization.status).toBe("PENDING");
    expect(bootstrapPasswordHash).toMatch(/^\$argon2id\$/);
    const audit = await database
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.organizationId, result.organization.id),
          eq(schema.auditLogs.resource, "organization"),
        ),
      );
    const events = await database
      .select({
        eventType: schema.outboxEvents.eventType,
        payload: schema.outboxEvents.payload,
      })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.organizationId, result.organization.id));
    expect(audit.map(({ action }) => action)).toEqual(["ORGANIZATION_CREATED"]);
    const lifecycleAudits = await database
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, result.organization.id));
    expect(lifecycleAudits.map(({ action }) => action)).toContain(
      "MEMBERSHIP_CREATED",
    );
    expect(lifecycleAudits.map(({ action }) => action)).toContain(
      "MEMBERSHIP_ROLE_ASSIGNED",
    );
    expect(events.map(({ eventType }) => eventType).sort()).toEqual([
      "ORGANIZATION_CREATED",
      "USER_CREATED",
      "USER_ROLE_CHANGED",
    ]);
    expect(events.map(({ eventType }) => eventType)).not.toContain(
      "USER_INVITED",
    );
    const [membership] = await database
      .select({
        status: schema.organizationMemberships.status,
        userId: schema.organizationMemberships.userId,
        branchAccessMode: schema.organizationMemberships.branchAccessMode,
      })
      .from(schema.organizationMemberships)
      .where(
        eq(
          schema.organizationMemberships.id,
          result.bootstrapOwner.membershipId,
        ),
      );
    expect(membership).toMatchObject({
      status: "ACTIVE",
      userId: result.bootstrapOwner.id,
      branchAccessMode: "ALL",
    });

    const assignedRoles = await database
      .select({ name: schema.roles.name })
      .from(schema.membershipRoles)
      .innerJoin(
        schema.roles,
        and(
          eq(
            schema.membershipRoles.organizationId,
            schema.roles.organizationId,
          ),
          eq(schema.membershipRoles.roleId, schema.roles.id),
        ),
      )
      .where(
        eq(
          schema.membershipRoles.membershipId,
          result.bootstrapOwner.membershipId,
        ),
      );
    expect(assignedRoles).toEqual([{ name: "Organization Owner" }]);
    const [ownerPermission] = await database
      .select({ key: schema.permissions.key })
      .from(schema.membershipRoles)
      .innerJoin(
        schema.rolePermissions,
        and(
          eq(
            schema.membershipRoles.organizationId,
            schema.rolePermissions.organizationId,
          ),
          eq(schema.membershipRoles.roleId, schema.rolePermissions.roleId),
        ),
      )
      .innerJoin(
        schema.permissions,
        eq(schema.rolePermissions.permissionId, schema.permissions.id),
      )
      .where(
        and(
          eq(
            schema.membershipRoles.membershipId,
            result.bootstrapOwner.membershipId,
          ),
          eq(schema.permissions.key, "core.organization.user.create"),
        ),
      );
    expect(ownerPermission).toEqual({
      key: "core.organization.user.create",
    });
    const defaultRoles = await database
      .select({ name: schema.roles.name, isSystem: schema.roles.isSystem })
      .from(schema.roles)
      .where(eq(schema.roles.organizationId, result.organization.id));
    expect(defaultRoles).toHaveLength(5);
    expect(defaultRoles.every(({ isSystem }) => isSystem)).toBe(true);
    const [bootstrapUser] = await database
      .select({
        status: schema.users.status,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.users)
      .where(eq(schema.users.id, result.bootstrapOwner.id));
    expect(bootstrapUser).toEqual({
      status: "ACTIVE",
      passwordHash: bootstrapPasswordHash,
    });
    expect(bootstrapUser?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(bootstrapUser?.passwordHash).not.toBe(bootstrapPassword);
    expect(JSON.stringify(events)).not.toContain(bootstrapPassword);
    expect(JSON.stringify(events)).not.toContain(bootstrapPasswordHash);
    expect(
      await database
        .select({ id: schema.organizationMemberships.id })
        .from(schema.organizationMemberships)
        .where(
          and(
            eq(
              schema.organizationMemberships.organizationId,
              result.organization.id,
            ),
            eq(schema.organizationMemberships.userId, actor.userId),
          ),
        ),
    ).toEqual([]);
    expect(
      await database
        .select({ roleName: schema.roles.name })
        .from(schema.membershipRoles)
        .innerJoin(
          schema.organizationMemberships,
          and(
            eq(
              schema.membershipRoles.organizationId,
              schema.organizationMemberships.organizationId,
            ),
            eq(
              schema.membershipRoles.membershipId,
              schema.organizationMemberships.id,
            ),
          ),
        )
        .innerJoin(
          schema.roles,
          and(
            eq(
              schema.membershipRoles.organizationId,
              schema.roles.organizationId,
            ),
            eq(schema.membershipRoles.roleId, schema.roles.id),
          ),
        )
        .where(
          and(
            eq(
              schema.organizationMemberships.organizationId,
              result.organization.id,
            ),
            eq(schema.organizationMemberships.userId, actor.userId),
          ),
        ),
    ).toEqual([]);

    await expect(
      withActiveOrganizationTransaction(
        applicationDatabase,
        result.bootstrapOwner.id,
        result.organization.id,
        async (_transaction, verifiedMembership) => verifiedMembership,
      ),
    ).resolves.toBeUndefined();
    // Activation requires approval; simulate that independent lifecycle step.
    await database
      .update(schema.organizations)
      .set({ status: "APPROVED" })
      .where(eq(schema.organizations.id, result.organization.id));
    const activated = await createLifecycleMutationService(
      applicationDatabase,
    ).activateOrganization(result.organization.id, actor, metadata());
    expect(activated.status).toBe("ACTIVE");
    await expect(
      withActiveOrganizationTransaction(
        applicationDatabase,
        result.bootstrapOwner.id,
        result.organization.id,
        async (_transaction, verifiedMembership) => verifiedMembership,
      ),
    ).resolves.toMatchObject({
      membershipId: result.bootstrapOwner.membershipId,
      organizationId: result.organization.id,
    });
    const ownerMembershipRoles = await database
      .select({ name: schema.roles.name })
      .from(schema.membershipRoles)
      .innerJoin(
        schema.roles,
        and(
          eq(
            schema.membershipRoles.organizationId,
            schema.roles.organizationId,
          ),
          eq(schema.membershipRoles.roleId, schema.roles.id),
        ),
      )
      .where(
        eq(
          schema.membershipRoles.membershipId,
          result.bootstrapOwner.membershipId,
        ),
      );
    expect(ownerMembershipRoles).toEqual([{ name: "Organization Owner" }]);

    const moduleManifest = {
      name: "core.organization",
      version: "1.0.0",
      displayName: "Organization Administration",
      lifecycle: "AVAILABLE" as const,
      description: "Organization administration module",
      dependencies: [],
      permissions: [],
      features: [],
    };
    const [organizationModule] = await database
      .insert(schema.modules)
      .values({
        key: moduleManifest.name,
        name: moduleManifest.name,
        lifecycle: "AVAILABLE",
        isAvailable: true,
      })
      .onConflictDoUpdate({
        target: schema.modules.key,
        set: { isAvailable: true, lifecycle: "AVAILABLE" },
      })
      .returning({ id: schema.modules.id });
    if (!organizationModule)
      throw new Error("Organization module was not provisioned");
    await database
      .insert(schema.moduleVersions)
      .values({
        moduleId: organizationModule.id,
        version: moduleManifest.version,
        status: "AVAILABLE",
        manifest: moduleManifest,
      })
      .onConflictDoUpdate({
        target: [schema.moduleVersions.moduleId, schema.moduleVersions.version],
        set: { status: "AVAILABLE", manifest: moduleManifest },
      });
    const [plan] = await database
      .insert(schema.plans)
      .values({
        key: "lifecycle-bootstrap-owner",
        name: "Lifecycle Bootstrap Owner",
        billingInterval: "MONTHLY",
        currencyCode: "KES",
        amount: "0.000000",
        isAvailable: true,
      })
      .onConflictDoUpdate({
        target: schema.plans.key,
        set: { isAvailable: true },
      })
      .returning({ id: schema.plans.id });
    if (!plan) throw new Error("Lifecycle test plan was not provisioned");
    await database
      .insert(schema.planModules)
      .values({ planId: plan.id, moduleId: organizationModule.id })
      .onConflictDoNothing();
    await database.insert(schema.organizationModules).values({
      organizationId: result.organization.id,
      moduleId: organizationModule.id,
      status: "ENABLED",
      source: "MANUAL",
      enabledAt: new Date(),
    });
    const [subscription] = await database
      .insert(schema.subscriptions)
      .values({
        organizationId: result.organization.id,
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: schema.subscriptions.id });
    if (!subscription)
      throw new Error("Lifecycle test subscription was not provisioned");
    await database.insert(schema.subscriptionItems).values({
      organizationId: result.organization.id,
      subscriptionId: subscription.id,
      planId: plan.id,
      amount: "0.000000",
      currencyCode: "KES",
    });

    const [ownerSession] = await database
      .insert(schema.sessions)
      .values({
        secretHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
        userId: result.bootstrapOwner.id,
        organizationId: result.organization.id,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: schema.sessions.id });
    if (!ownerSession)
      throw new Error("Bootstrap owner session was not created");
    const authorization = createAuthorizationService(applicationDatabase);
    const ownerOperation = await authorization.withPermission(
      {
        userId: result.bootstrapOwner.id,
        sessionId: ownerSession.id,
        organizationId: result.organization.id,
        membershipId: result.bootstrapOwner.membershipId,
        branchId: null,
      },
      "core.organization.user.create",
      metadata(),
      (transaction, context) =>
        createUser(
          transaction,
          context.organizationId,
          context.userId,
          metadata(),
          {
            email: `created-by-owner-${crypto.randomUUID()}@example.test`,
            displayName: "Created by Bootstrap Owner",
            passwordHash: bootstrapPasswordHash,
          },
        ),
    );
    expect(ownerOperation.allowed).toBe(true);

    const superadminOperation = await authorization.withPermission(
      {
        userId: actor.userId,
        sessionId: actor.sessionId,
        organizationId: result.organization.id,
        membershipId: null,
        branchId: null,
      },
      "core.organization.user.create",
      metadata(),
      async () => "must-not-run",
    );
    expect(superadminOperation).toEqual({
      allowed: false,
      statusCode: 403,
      dataScopes: [],
    });

    const otherTenant = await createOrganization();
    const otherTenantUser = await createActor(false);
    await expect(
      withActiveOrganizationTransaction(
        applicationDatabase,
        otherTenantUser.userId,
        result.organization.id,
        async (_transaction, verifiedMembership) => verifiedMembership,
      ),
    ).resolves.toBeUndefined();
    await expect(
      inviteAsTenant(
        otherTenant.id,
        otherTenantUser.userId,
        async (transaction) =>
          transaction
            .select({ id: schema.organizations.id })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, result.organization.id)),
      ),
    ).resolves.toEqual([]);
  });

  it("submits applications as pending without creating an owner account", async () => {
    const lifecycle = createLifecycleMutationService(applicationDatabase);
    const ownerEmail = `applicant-${crypto.randomUUID()}@example.test`;
    const result = await lifecycle.submitOrganizationApplication(
      {
        name: "Application Trading",
        slug: `application-${crypto.randomUUID()}`,
        industry: "Retail",
        deploymentType: "SAAS",
        contactEmail: `contact-${crypto.randomUUID()}@example.test`,
        contactPhone: "+254700000000",
        ownerName: "Application Owner",
        ownerEmail,
        countryCode: "KE",
        region: "Nairobi",
        city: "Nairobi",
        address: "Central Nairobi",
        requestedModules: ["core.business_manager"],
      },
      metadata(),
    );
    const users = await database
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, ownerEmail));
    const memberships = await database
      .select({ id: schema.organizationMemberships.id })
      .from(schema.organizationMemberships)
      .where(
        eq(
          schema.organizationMemberships.organizationId,
          result.organization.id,
        ),
      );
    const events = await database
      .select({ eventType: schema.outboxEvents.eventType })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.organizationId, result.organization.id));

    expect(result.organization.status).toBe("PENDING");
    expect(result.organization.profile).toMatchObject({
      application: { ownerEmail, requestedModules: ["core.business_manager"] },
    });
    expect(users).toEqual([]);
    expect(memberships).toEqual([]);
    expect(events.map(({ eventType }) => eventType)).toEqual([
      "ORGANIZATION_APPLICATION_SUBMITTED",
    ]);
  });

  it("submits an application without module requests when the catalogue is unavailable", async () => {
    const lifecycle = createLifecycleMutationService(applicationDatabase);
    await client.exec(
      'ALTER TABLE "modules" RENAME TO "lifecycle_test_modules_unavailable"',
    );

    try {
      const result = await lifecycle.submitOrganizationApplication(
        {
          name: "Application Without Modules",
          slug: `application-no-modules-${crypto.randomUUID()}`,
          industry: "Retail",
          deploymentType: "SAAS",
          contactEmail: `contact-${crypto.randomUUID()}@example.test`,
          contactPhone: "+254700000000",
          ownerName: "Application Owner",
          ownerEmail: `applicant-${crypto.randomUUID()}@example.test`,
          countryCode: "KE",
          region: "Nairobi",
          city: "Nairobi",
          address: "Central Nairobi",
          requestedModules: [],
        },
        metadata(),
      );

      expect(result.organization.status).toBe("PENDING");
      expect(result.organization.profile).toMatchObject({
        application: { requestedModules: [] },
      });
    } finally {
      await client.exec(
        'ALTER TABLE "lifecycle_test_modules_unavailable" RENAME TO "modules"',
      );
    }
  });

  it("limits review transitions to superadmins and records the pending review lifecycle", async () => {
    const lifecycle = createLifecycleMutationService(applicationDatabase);
    const ownerEmail = `review-${crypto.randomUUID()}@example.test`;
    const submitted = await lifecycle.submitOrganizationApplication(
      {
        name: "Review Trading",
        slug: `review-${crypto.randomUUID()}`,
        industry: "Retail",
        deploymentType: "SAAS",
        contactEmail: `contact-${crypto.randomUUID()}@example.test`,
        contactPhone: "+254700000000",
        ownerName: "Review Owner",
        ownerEmail,
        countryCode: "KE",
        region: "Nairobi",
        city: "Nairobi",
        address: "Central Nairobi",
        requestedModules: [],
      },
      metadata(),
    );
    await expect(
      lifecycle.submitOrganizationApplication(
        {
          name: "Different Business",
          slug: `different-${crypto.randomUUID()}`,
          industry: "Retail",
          deploymentType: "SAAS",
          contactEmail: `different-${crypto.randomUUID()}@example.test`,
          contactPhone: "+254700000000",
          ownerName: "Review Owner",
          ownerEmail,
          countryCode: "KE",
          region: "Nairobi",
          city: "Nairobi",
          address: "Central Nairobi",
          requestedModules: [],
        },
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "APPLICATION_ALREADY_EXISTS" });

    await expect(
      lifecycle.listOrganizationApplications(await createActor(false)),
    ).rejects.toMatchObject({ code: "LIFECYCLE_UNAUTHORIZED" });
    const actor = await createActor();
    await expect(
      lifecycle.transitionOrganizationApplication(
        submitted.organization.id,
        "APPROVED",
        actor,
        metadata(),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_STATE_TRANSITION",
    });
    const reviewing = await lifecycle.transitionOrganizationApplication(
      submitted.organization.id,
      "UNDER_REVIEW",
      actor,
      metadata(),
    );
    const approved = await lifecycle.transitionOrganizationApplication(
      submitted.organization.id,
      "APPROVED",
      actor,
      metadata(),
    );
    const stillNoOwner = await database
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, ownerEmail));

    expect(reviewing.status).toBe("UNDER_REVIEW");
    expect(approved.status).toBe("APPROVED");
    expect(stillNoOwner).toEqual([]);
  });

  it("provisions an approved application with one invited Owner and its requested modules", async () => {
    const { actor, organization, ownerEmail, lifecycle } =
      await createApprovedApplication(undefined, ["core.business_manager"]);

    await expect(
      lifecycle.activateOrganization(organization.id, actor, metadata()),
    ).rejects.toMatchObject({
      code: "APPLICATION_PROVISIONING_REQUIRED",
    });

    const result = await lifecycle.provisionApprovedOrganizationApplication(
      organization.id,
      actor,
      metadata(),
    );
    expect(result.organization.status).toBe("ACTIVE");
    expect(result.owner).toMatchObject({
      email: ownerEmail,
      displayName: "Application Owner",
      accountStatus: "PENDING",
      membershipStatus: "INVITED",
    });
    expect(result.enabledModules).toEqual(["core.business_manager"]);

    const [owner] = await database
      .select({
        status: schema.users.status,
        passwordHash: schema.users.passwordHash,
        emailVerifiedAt: schema.users.emailVerifiedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, result.owner.id));
    expect(owner).toEqual({
      status: "PENDING",
      passwordHash: null,
      emailVerifiedAt: null,
    });
    const membershipRoles = await database
      .select({ roleName: schema.roles.name })
      .from(schema.membershipRoles)
      .innerJoin(
        schema.roles,
        and(
          eq(
            schema.roles.organizationId,
            schema.membershipRoles.organizationId,
          ),
          eq(schema.roles.id, schema.membershipRoles.roleId),
        ),
      )
      .where(
        eq(schema.membershipRoles.membershipId, result.owner.membershipId),
      );
    expect(membershipRoles).toEqual([{ roleName: "Organization Owner" }]);
    const entitlements = await database
      .select({
        moduleKey: schema.modules.key,
        status: schema.organizationModules.status,
        source: schema.organizationModules.source,
      })
      .from(schema.organizationModules)
      .innerJoin(
        schema.modules,
        eq(schema.modules.id, schema.organizationModules.moduleId),
      )
      .where(eq(schema.organizationModules.organizationId, organization.id));
    expect(entitlements).toEqual([
      {
        moduleKey: "core.business_manager",
        status: "ENABLED",
        source: "MANUAL",
      },
    ]);
    const initialBranches = await database
      .select({
        id: schema.branches.id,
        name: schema.branches.name,
        code: schema.branches.code,
      })
      .from(schema.branches)
      .where(eq(schema.branches.organizationId, organization.id));
    expect(initialBranches).toHaveLength(1);
    expect(initialBranches[0]).toMatchObject({ name: "Main", code: "MAIN" });
    const ownerBranchAssignments = await database
      .select({ branchId: schema.membershipBranches.branchId })
      .from(schema.membershipBranches)
      .where(
        and(
          eq(schema.membershipBranches.organizationId, organization.id),
          eq(schema.membershipBranches.membershipId, result.owner.membershipId),
        ),
      );
    expect(ownerBranchAssignments).toEqual([
      { branchId: initialBranches[0]?.id },
    ]);
    const branchAudits = await database
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.organizationId, organization.id),
          eq(schema.auditLogs.resource, "branch"),
        ),
      );
    expect(branchAudits.map(({ action }) => action)).toContain(
      "BRANCH_CREATED",
    );
    expect(
      await database
        .select({ action: schema.auditLogs.action })
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.organizationId, organization.id),
            eq(schema.auditLogs.resource, "membership_branch"),
          ),
        ),
    ).toEqual([{ action: "MEMBERSHIP_BRANCH_ASSIGNED" }]);
    const branchEvents = await database
      .select({ eventType: schema.outboxEvents.eventType })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.organizationId, organization.id));
    expect(branchEvents.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining(["BRANCH_CREATED", "MEMBERSHIP_BRANCH_ASSIGNED"]),
    );
    await expect(
      withActiveOrganizationTransaction(
        applicationDatabase,
        result.owner.id,
        organization.id,
        async (_transaction, membership) => membership,
      ),
    ).resolves.toBeUndefined();

    const repeated = await lifecycle.provisionApprovedOrganizationApplication(
      organization.id,
      actor,
      metadata(),
    );
    expect(repeated.owner.id).toBe(result.owner.id);
    expect(repeated.owner.membershipId).toBe(result.owner.membershipId);
    expect(
      await database
        .select({ id: schema.branches.id })
        .from(schema.branches)
        .where(eq(schema.branches.organizationId, organization.id)),
    ).toHaveLength(1);
    expect(
      await database
        .select({ branchId: schema.membershipBranches.branchId })
        .from(schema.membershipBranches)
        .where(
          and(
            eq(schema.membershipBranches.organizationId, organization.id),
            eq(
              schema.membershipBranches.membershipId,
              result.owner.membershipId,
            ),
          ),
        ),
    ).toEqual([{ branchId: initialBranches[0]?.id }]);
    expect(
      await database
        .select({ id: schema.organizationMemberships.id })
        .from(schema.organizationMemberships)
        .where(
          eq(schema.organizationMemberships.organizationId, organization.id),
        ),
    ).toHaveLength(1);
    expect(
      await database
        .select({ action: schema.auditLogs.action })
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.organizationId, organization.id),
            eq(schema.auditLogs.action, "ORGANIZATION_ACTIVATED"),
          ),
        ),
    ).toHaveLength(1);
    const unrelatedActiveOrganization = await createOrganization("ACTIVE");
    const listedApplications =
      await lifecycle.listOrganizationApplications(actor);
    expect(listedApplications.some(({ id }) => id === organization.id)).toBe(
      true,
    );
    expect(
      listedApplications.some(
        ({ id }) => id === unrelatedActiveOrganization.id,
      ),
    ).toBe(false);
  });

  it("rejects unapproved applications, non-superadmin actors, and spoofed direct activation", async () => {
    const lifecycle = createLifecycleMutationService(applicationDatabase);
    const ownerEmail = `not-approved-${crypto.randomUUID()}@example.test`;
    const submitted = await lifecycle.submitOrganizationApplication(
      {
        name: "Not Approved",
        slug: `not-approved-${crypto.randomUUID()}`,
        industry: "Retail",
        deploymentType: "SAAS",
        contactEmail: `contact-${crypto.randomUUID()}@example.test`,
        contactPhone: "+254700000000",
        ownerName: "Pending Owner",
        ownerEmail,
        countryCode: "KE",
        region: "Nairobi",
        city: "Nairobi",
        address: "Central Nairobi",
        requestedModules: [],
      },
      metadata(),
    );
    const superadmin = await createActor();
    await expect(
      lifecycle.provisionApprovedOrganizationApplication(
        submitted.organization.id,
        superadmin,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "APPLICATION_NOT_APPROVED" });
    const spoofedActor = {
      ...(await createActor(false)),
      platformRoles: ["SUPERADMIN"],
    };
    await expect(
      lifecycle.provisionApprovedOrganizationApplication(
        submitted.organization.id,
        spoofedActor,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "LIFECYCLE_UNAUTHORIZED" });
    await expect(
      lifecycle.activateOrganization(
        submitted.organization.id,
        superadmin,
        metadata(),
      ),
    ).rejects.toMatchObject({
      code: "APPLICATION_PROVISIONING_REQUIRED",
    });
    expect(
      await database
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, ownerEmail)),
    ).toEqual([]);
  });

  it("serializes concurrent application provisioning retries", async () => {
    const { actor, organization, lifecycle } =
      await createApprovedApplication();
    const results = await Promise.all([
      lifecycle.provisionApprovedOrganizationApplication(
        organization.id,
        actor,
        metadata(),
      ),
      lifecycle.provisionApprovedOrganizationApplication(
        organization.id,
        actor,
        metadata(),
      ),
    ]);
    expect(results[0]?.owner.id).toBe(results[1]?.owner.id);
    expect(results[0]?.owner.membershipId).toBe(results[1]?.owner.membershipId);
    expect(
      await database
        .select({ id: schema.organizationMemberships.id })
        .from(schema.organizationMemberships)
        .where(
          eq(schema.organizationMemberships.organizationId, organization.id),
        ),
    ).toHaveLength(1);
    expect(
      await database
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.organizationId, organization.id)),
    ).toHaveLength(5);
  });

  it("rolls back all application provisioning writes when entitlement persistence fails", async () => {
    const { actor, organization, ownerEmail, lifecycle } =
      await createApprovedApplication(undefined, ["core.business_manager"]);
    const countsBefore = await lifecycleRecordCounts();
    await expect(
      withFailingInsert("organization_modules", () =>
        lifecycle.provisionApprovedOrganizationApplication(
          organization.id,
          actor,
          metadata(),
        ),
      ),
    ).rejects.toThrow();
    expect(await lifecycleRecordCounts()).toEqual(countsBefore);
    expect(
      await database
        .select({ status: schema.organizations.status })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, organization.id)),
    ).toEqual([{ status: "APPROVED" }]);
    expect(
      await database
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, ownerEmail)),
    ).toEqual([]);
  });

  it("resolves an existing active identity as bootstrap owner without changing credentials", async () => {
    const actor = await createActor();
    const email = `existing-owner-${crypto.randomUUID()}@example.test`;
    const originalHash = "argon2id-existing-account";
    const [existingUser] = await database
      .insert(schema.users)
      .values({
        email,
        displayName: "Existing Identity",
        status: "ACTIVE",
        passwordHash: originalHash,
      })
      .returning({ id: schema.users.id });
    if (!existingUser)
      throw new Error("Existing bootstrap user was not created");

    const input = {
      ...organizationInput(),
      bootstrapOwner: { email },
    };
    const result = await createLifecycleMutationService(
      applicationDatabase,
    ).createOrganization(input, actor, metadata());

    expect(result.bootstrapOwner).toMatchObject({
      id: existingUser.id,
      email,
      displayName: "Existing Identity",
    });
    expect(
      await database
        .select({
          status: schema.users.status,
          passwordHash: schema.users.passwordHash,
        })
        .from(schema.users)
        .where(eq(schema.users.id, existingUser.id)),
    ).toEqual([{ status: "ACTIVE", passwordHash: originalHash }]);
    expect(
      await database
        .select({ status: schema.organizationMemberships.status })
        .from(schema.organizationMemberships)
        .where(
          eq(
            schema.organizationMemberships.id,
            result.bootstrapOwner.membershipId,
          ),
        ),
    ).toEqual([{ status: "ACTIVE" }]);
    expect(
      await database
        .select({ roleName: schema.roles.name })
        .from(schema.membershipRoles)
        .innerJoin(
          schema.roles,
          and(
            eq(
              schema.membershipRoles.organizationId,
              schema.roles.organizationId,
            ),
            eq(schema.membershipRoles.roleId, schema.roles.id),
          ),
        )
        .where(
          eq(
            schema.membershipRoles.membershipId,
            result.bootstrapOwner.membershipId,
          ),
        ),
    ).toEqual([{ roleName: "Organization Owner" }]);
    expect(
      (
        await database
          .select({ eventType: schema.outboxEvents.eventType })
          .from(schema.outboxEvents)
          .where(eq(schema.outboxEvents.organizationId, result.organization.id))
      )
        .map(({ eventType }) => eventType)
        .sort(),
    ).toEqual(["ORGANIZATION_CREATED", "USER_ROLE_CHANGED"]);
  });

  it("does not allow a platform superadmin to be the bootstrap tenant owner", async () => {
    const actor = await createActor();
    const [actorUser] = await database
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, actor.userId));
    if (!actorUser) throw new Error("Lifecycle actor was not found");
    const input = {
      ...organizationInput(),
      bootstrapOwner: { email: actorUser.email },
    };
    const countsBefore = await lifecycleRecordCounts();

    await expect(
      createLifecycleMutationService(applicationDatabase).createOrganization(
        input,
        actor,
        metadata(),
      ),
    ).rejects.toMatchObject({
      code: "BOOTSTRAP_OWNER_CANNOT_BE_SUPERADMIN",
    });
    expect(await lifecycleRecordCounts()).toEqual(countsBefore);
  });

  it("detects another superadmin under self-only RLS without granting tenant access", async () => {
    const actor = await createActor();
    const candidate = await createActor();
    const [candidateUser] = await database
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, candidate.userId));
    if (!candidateUser) throw new Error("Candidate superadmin was not found");

    const visibleCandidateRoles = await client.transaction(
      async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        await transaction.query(
          "SELECT set_config('app.current_user_id', $1, true)",
          [actor.userId],
        );
        return transaction.query<{ user_id: string }>(
          "SELECT user_id FROM platform_user_roles WHERE user_id = $1 AND role = 'SUPERADMIN'",
          [candidate.userId],
        );
      },
    );
    expect(visibleCandidateRoles.rows).toEqual([]);

    const tenant = await createOrganization("ACTIVE");
    const countsBefore = await lifecycleRecordCounts();
    const input = {
      ...organizationInput(),
      bootstrapOwner: { email: candidateUser.email },
    };
    await expect(
      createLifecycleMutationService(applicationDatabase).createOrganization(
        input,
        actor,
        metadata(),
      ),
    ).rejects.toMatchObject({
      code: "BOOTSTRAP_OWNER_CANNOT_BE_SUPERADMIN",
    });
    expect(await lifecycleRecordCounts()).toEqual(countsBefore);

    const authorization = createAuthorizationService(applicationDatabase);
    for (const platformActor of [actor, candidate]) {
      expect(
        await database
          .select({ id: schema.organizationMemberships.id })
          .from(schema.organizationMemberships)
          .where(
            and(
              eq(schema.organizationMemberships.organizationId, tenant.id),
              eq(schema.organizationMemberships.userId, platformActor.userId),
            ),
          ),
      ).toEqual([]);
      await expect(
        authorization.withPermission(
          {
            userId: platformActor.userId,
            sessionId: platformActor.sessionId,
            organizationId: tenant.id,
            membershipId: null,
            branchId: null,
          },
          "core.organization.user.create",
          metadata(),
          async () => "must-not-run",
        ),
      ).resolves.toEqual({
        allowed: false,
        statusCode: 403,
        dataScopes: [],
      });
    }
  });

  it("rejects organization creation without a superadmin role", async () => {
    const actor = await createActor(false);
    const lifecycle = createLifecycleMutationService(applicationDatabase);
    const input = organizationInput(`unauthorized-${crypto.randomUUID()}`);

    await expect(
      lifecycle.createOrganization(input, actor, metadata()),
    ).rejects.toMatchObject({ code: "LIFECYCLE_UNAUTHORIZED" });
    expect(
      await database
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, input.slug)),
    ).toEqual([]);
  });

  it("requires an explicit bootstrap owner name", async () => {
    const actor = await createActor();
    const input = {
      ...organizationInput(),
      bootstrapOwner: {
        email: `missing-name-${crypto.randomUUID()}@example.test`,
      },
    };

    await expect(
      createLifecycleMutationService(applicationDatabase).createOrganization(
        input,
        actor,
        metadata(),
      ),
    ).rejects.toMatchObject({
      code: "BOOTSTRAP_OWNER_CREDENTIALS_REQUIRED",
    });
    expect(
      await database
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, input.slug)),
    ).toEqual([]);
    expect(
      await database
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, input.bootstrapOwner.email)),
    ).toEqual([]);
  });

  it("blocks organization inserts under tenant context without a superadmin role", async () => {
    const actor = await createActor(false);
    const organization = await createOrganization();

    await expect(
      client.transaction(async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        await transaction.query(
          "SELECT set_config('app.current_user_id', $1, true)",
          [actor.userId],
        );
        await transaction.query(
          "SELECT set_config('app.current_organization_id', $1, true)",
          [organization.id],
        );
        await transaction.query(
          "INSERT INTO organizations (id, name, slug, industry, status, deployment_type) VALUES ($1, 'Forbidden insert', $2, 'TEST', 'PENDING', 'SAAS')",
          [crypto.randomUUID(), `forbidden-${crypto.randomUUID()}`],
        );
      }),
    ).rejects.toThrow();

    await expect(
      client.transaction(async (transaction) => {
        await transaction.exec("SET LOCAL ROLE onecore_app");
        await transaction.query(
          "SELECT set_config('app.current_user_id', $1, true)",
          [actor.userId],
        );
        await transaction.query(
          "SELECT set_config('app.current_organization_id', $1, true)",
          [organization.id],
        );
        await transaction.query(
          "INSERT INTO roles (organization_id, name, description, is_system) VALUES ($1, 'Organization Owner', 'Untrusted system role', true)",
          [organization.id],
        );
      }),
    ).rejects.toThrow();
  });

  it("activates only valid organization states and atomically records the transition", async () => {
    const actor = await createActor();
    const organization = await createOrganization("APPROVED");
    const lifecycle = createLifecycleMutationService(applicationDatabase);
    const activated = await lifecycle.activateOrganization(
      organization.id,
      actor,
      metadata(),
    );
    expect(activated.status).toBe("ACTIVE");

    const event = await database
      .select({ eventType: schema.outboxEvents.eventType })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.organizationId, organization.id));
    const audit = await database
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.organizationId, organization.id),
          eq(schema.auditLogs.resource, "organization"),
        ),
      );
    expect(event.map(({ eventType }) => eventType)).toEqual([
      "ORGANIZATION_ACTIVATED",
    ]);
    expect(audit.map(({ action }) => action)).toEqual([
      "ORGANIZATION_ACTIVATED",
    ]);
    await expect(
      lifecycle.activateOrganization(organization.id, actor, metadata()),
    ).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_STATE_TRANSITION",
    });

    const pending = await createOrganization("PENDING");
    await expect(
      lifecycle.activateOrganization(pending.id, actor, metadata()),
    ).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_STATE_TRANSITION",
    });
    expect(
      await database
        .select({ eventType: schema.outboxEvents.eventType })
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.organizationId, pending.id)),
    ).toEqual([]);

    await expect(
      lifecycle.activateOrganization(crypto.randomUUID(), actor, metadata()),
    ).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });

    const unauthorizedActor = await createActor(false);
    const approved = await createOrganization("APPROVED");
    await expect(
      lifecycle.activateOrganization(
        approved.id,
        unauthorizedActor,
        metadata(),
      ),
    ).rejects.toMatchObject({ code: "LIFECYCLE_UNAUTHORIZED" });
    expect(
      await database
        .select({ status: schema.organizations.status })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, approved.id)),
    ).toEqual([{ status: "APPROVED" }]);
  });

  it("creates a user with an active organization membership and no secret in audit or event", async () => {
    const actor = await createActor(false);
    const organization = await createOrganization();
    const email = `created-${crypto.randomUUID()}@example.test`;
    const user = await inviteAsTenant(
      organization.id,
      actor.userId,
      (transaction) =>
        createUser(transaction, organization.id, actor.userId, metadata(), {
          email,
          displayName: "Created User",
          passwordHash: "argon2id-secret-hash",
        }),
    );

    expect(user.organizationId).toBe(organization.id);
    const memberships = await database
      .select({ status: schema.organizationMemberships.status })
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.userId, user.id));
    const events = await database
      .select({
        eventType: schema.outboxEvents.eventType,
        payload: schema.outboxEvents.payload,
      })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.organizationId, organization.id));
    expect(memberships).toEqual([{ status: "ACTIVE" }]);
    expect(events.map(({ eventType }) => eventType)).toEqual(["USER_CREATED"]);
    expect(JSON.stringify(events)).not.toContain("argon2id-secret-hash");
    expect(
      await database
        .select({ action: schema.auditLogs.action })
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.organizationId, organization.id),
            eq(schema.auditLogs.resource, "user"),
          ),
        ),
    ).toEqual([{ action: "USER_CREATED" }]);
  });

  it("rejects invalid and cross-tenant user creation without leaving a user behind", async () => {
    const actor = await createActor(false);
    const organization = await createOrganization();
    const otherOrganization = await createOrganization();
    const email = `cross-${crypto.randomUUID()}@example.test`;

    await expect(
      inviteAsTenant(otherOrganization.id, actor.userId, (transaction) =>
        createUser(transaction, organization.id, actor.userId, metadata(), {
          email,
          displayName: "Cross Tenant User",
          passwordHash: "argon2id-secret-hash",
        }),
      ),
    ).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
    await expect(
      inviteAsTenant(organization.id, actor.userId, (transaction) =>
        createUser(transaction, organization.id, actor.userId, metadata(), {
          email: "not-an-email",
          displayName: "Invalid User",
          passwordHash: "argon2id-secret-hash",
        }),
      ),
    ).rejects.toThrow();
    expect(
      await database
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email)),
    ).toEqual([]);
  });

  it("invites a user in the authorized tenant and rejects cross-tenant access", async () => {
    const actor = await createActor(false);
    const organization = await createOrganization();
    const otherOrganization = await createOrganization();
    const email = `invited-${crypto.randomUUID()}@example.test`;
    const invited = await inviteAsTenant(
      organization.id,
      actor.userId,
      (transaction) =>
        inviteUser(transaction, organization.id, actor.userId, metadata(), {
          email,
          displayName: "Invited User",
        }),
    );
    expect(invited.membershipId).toBeTruthy();
    expect(
      await database
        .select({ status: schema.organizationMemberships.status })
        .from(schema.organizationMemberships)
        .where(eq(schema.organizationMemberships.id, invited.membershipId)),
    ).toEqual([{ status: "INVITED" }]);
    expect(
      await database
        .select({
          status: schema.users.status,
          passwordHash: schema.users.passwordHash,
        })
        .from(schema.users)
        .where(eq(schema.users.id, invited.id)),
    ).toEqual([{ status: "PENDING", passwordHash: null }]);
    const events = await database
      .select({
        eventType: schema.outboxEvents.eventType,
        payload: schema.outboxEvents.payload,
      })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.organizationId, organization.id));
    expect(events.map(({ eventType }) => eventType).sort()).toEqual([
      "USER_CREATED",
      "USER_INVITED",
    ]);
    expect(
      events.find(({ eventType }) => eventType === "USER_INVITED"),
    ).toMatchObject({
      payload: {
        userId: invited.id,
        membershipId: invited.membershipId,
        email,
      },
    });

    await expect(
      inviteAsTenant(organization.id, actor.userId, (transaction) =>
        inviteUser(transaction, organization.id, actor.userId, metadata(), {
          email,
          displayName: "Invited User",
        }),
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_ALREADY_EXISTS" });

    await expect(
      inviteAsTenant(otherOrganization.id, actor.userId, (transaction) =>
        inviteUser(transaction, organization.id, actor.userId, metadata(), {
          email: `cross-${crypto.randomUUID()}@example.test`,
          displayName: "Cross Tenant",
        }),
      ),
    ).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
  });

  it("reuses an existing identity without recreating it for an invitation", async () => {
    const actor = await createActor(false);
    const organization = await createOrganization();
    const email = `existing-${crypto.randomUUID()}@example.test`;
    const [existingUser] = await database
      .insert(schema.users)
      .values({ email, displayName: "Existing User", status: "ACTIVE" })
      .returning({ id: schema.users.id });
    if (!existingUser)
      throw new Error("Existing lifecycle user was not created");

    const invitation = await inviteAsTenant(
      organization.id,
      actor.userId,
      (transaction) =>
        inviteUser(transaction, organization.id, actor.userId, metadata(), {
          email,
          displayName: "Existing User",
        }),
    );

    expect(invitation.id).toBe(existingUser.id);
    expect(
      await database
        .select({ status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.id, existingUser.id)),
    ).toEqual([{ status: "ACTIVE" }]);
    expect(
      await database
        .select({ status: schema.organizationMemberships.status })
        .from(schema.organizationMemberships)
        .where(eq(schema.organizationMemberships.id, invitation.membershipId)),
    ).toEqual([{ status: "INVITED" }]);
    expect(
      await database
        .select({ eventType: schema.outboxEvents.eventType })
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.organizationId, organization.id)),
    ).toEqual([{ eventType: "USER_INVITED" }]);
    const audits = await database
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, organization.id));
    expect(audits.map(({ action }) => action).sort()).toEqual([
      "EVENT_CREATED",
      "USER_INVITED",
    ]);
  });

  it("rolls back user state and membership when state, audit, or outbox writes fail", async () => {
    const actor = await createActor(false);
    const organization = await createOrganization();

    for (const tableName of [
      "users",
      "organization_memberships",
      "audit_logs",
      "outbox_events",
    ] as const) {
      const email = `rollback-${crypto.randomUUID()}@example.test`;
      const request = metadata();
      await expect(
        withFailingInsert(tableName, () =>
          inviteAsTenant(organization.id, actor.userId, (transaction) =>
            createUser(transaction, organization.id, actor.userId, request, {
              email,
              displayName: "Rollback User",
              passwordHash: "argon2id-secret-hash",
            }),
          ),
        ),
      ).rejects.toThrow();
      expect(
        await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, email)),
      ).toEqual([]);
      expect(
        await database
          .select({ id: schema.auditLogs.id })
          .from(schema.auditLogs)
          .where(
            sql`${schema.auditLogs.requestMetadata}->>'requestId' = ${request.requestId}`,
          ),
      ).toEqual([]);
      expect(
        await database
          .select({ id: schema.outboxEvents.id })
          .from(schema.outboxEvents)
          .where(
            sql`${schema.outboxEvents.metadata}->>'requestId' = ${request.requestId}`,
          ),
      ).toEqual([]);
      expect(
        await database
          .select({ id: schema.organizationMemberships.id })
          .from(schema.organizationMemberships)
          .innerJoin(
            schema.users,
            eq(schema.organizationMemberships.userId, schema.users.id),
          )
          .where(eq(schema.users.email, email)),
      ).toEqual([]);
    }
  });

  it("rolls back invitation state and membership when state, audit, or outbox writes fail", async () => {
    const actor = await createActor(false);
    const organization = await createOrganization();

    for (const tableName of [
      "users",
      "organization_memberships",
      "audit_logs",
      "outbox_events",
    ] as const) {
      const email = `invite-rollback-${crypto.randomUUID()}@example.test`;
      const request = metadata();
      await expect(
        withFailingInsert(tableName, () =>
          inviteAsTenant(organization.id, actor.userId, (transaction) =>
            inviteUser(transaction, organization.id, actor.userId, request, {
              email,
              displayName: "Rollback Invite",
            }),
          ),
        ),
      ).rejects.toThrow();
      expect(
        await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, email)),
      ).toEqual([]);
      expect(
        await database
          .select({ id: schema.organizationMemberships.id })
          .from(schema.organizationMemberships)
          .innerJoin(
            schema.users,
            eq(schema.organizationMemberships.userId, schema.users.id),
          )
          .where(eq(schema.users.email, email)),
      ).toEqual([]);
      expect(
        await database
          .select({ id: schema.auditLogs.id })
          .from(schema.auditLogs)
          .where(
            sql`${schema.auditLogs.requestMetadata}->>'requestId' = ${request.requestId}`,
          ),
      ).toEqual([]);
      expect(
        await database
          .select({ id: schema.outboxEvents.id })
          .from(schema.outboxEvents)
          .where(
            sql`${schema.outboxEvents.metadata}->>'requestId' = ${request.requestId}`,
          ),
      ).toEqual([]);
    }
  });

  it("rolls back organization activation when state, audit, or outbox writes fail", async () => {
    const actor = await createActor();

    for (const tableName of ["audit_logs", "outbox_events"] as const) {
      const organization = await createOrganization("APPROVED");
      await expect(
        withFailingInsert(tableName, () =>
          createLifecycleMutationService(
            applicationDatabase,
          ).activateOrganization(organization.id, actor, metadata()),
        ),
      ).rejects.toThrow();
      expect(
        await database
          .select({ status: schema.organizations.status })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, organization.id)),
      ).toEqual([{ status: "APPROVED" }]);
      expect(
        await database
          .select({ action: schema.auditLogs.action })
          .from(schema.auditLogs)
          .where(eq(schema.auditLogs.organizationId, organization.id)),
      ).toEqual([]);
      expect(
        await database
          .select({ id: schema.outboxEvents.id })
          .from(schema.outboxEvents)
          .where(eq(schema.outboxEvents.organizationId, organization.id)),
      ).toEqual([]);
    }

    const organization = await createOrganization("APPROVED");
    await expect(
      withFailingUpdate("organizations", () =>
        createLifecycleMutationService(
          applicationDatabase,
        ).activateOrganization(organization.id, actor, metadata()),
      ),
    ).rejects.toThrow();
    expect(
      await database
        .select({ status: schema.organizations.status })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, organization.id)),
    ).toEqual([{ status: "APPROVED" }]);
    expect(
      await database
        .select({ action: schema.auditLogs.action })
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.organizationId, organization.id)),
    ).toEqual([]);
    expect(
      await database
        .select({ id: schema.outboxEvents.id })
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.organizationId, organization.id)),
    ).toEqual([]);
  });

  it("rolls back lifecycle creation on state, audit, and outbox insertion failures", async () => {
    const actor = await createActor();

    for (const tableName of [
      "organizations",
      "roles",
      "role_permissions",
      "users",
      "organization_memberships",
      "membership_roles",
      "audit_logs",
      "outbox_events",
    ] as const) {
      const slug = `rollback-${crypto.randomUUID()}`;
      const request = metadata();
      const input = organizationInput(slug);
      const countsBefore = await lifecycleRecordCounts();
      await expect(
        withFailingInsert(tableName, () =>
          createLifecycleMutationService(
            applicationDatabase,
          ).createOrganization(input, actor, request),
        ),
      ).rejects.toThrow();
      expect(await lifecycleRecordCounts()).toEqual(countsBefore);
      expect(
        await database
          .select({ id: schema.organizations.id })
          .from(schema.organizations)
          .where(eq(schema.organizations.slug, slug)),
      ).toEqual([]);
      expect(
        await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, input.bootstrapOwner.email)),
      ).toEqual([]);
      expect(
        await database
          .select({ id: schema.auditLogs.id })
          .from(schema.auditLogs)
          .where(
            and(
              eq(schema.auditLogs.action, "ORGANIZATION_CREATED"),
              sql`${schema.auditLogs.requestMetadata}->>'requestId' = ${request.requestId}`,
            ),
          ),
      ).toEqual([]);
      expect(
        await database
          .select({ id: schema.outboxEvents.id })
          .from(schema.outboxEvents)
          .where(
            sql`${schema.outboxEvents.metadata}->>'requestId' = ${request.requestId}`,
          ),
      ).toEqual([]);
    }
  });

  it("rolls back organization state and audit when outbox event validation fails", async () => {
    const actor = await createActor();
    const lifecycle = createLifecycleMutationService(applicationDatabase);
    const slug = `rollback-${crypto.randomUUID()}`;

    const request = metadata("not-a-uuid");
    await expect(
      lifecycle.createOrganization(organizationInput(slug), actor, request),
    ).rejects.toThrow();
    expect(
      await database
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, slug)),
    ).toEqual([]);
    expect(
      await database
        .select({ id: schema.auditLogs.id })
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.actorUserId, actor.userId),
            eq(schema.auditLogs.action, "ORGANIZATION_CREATED"),
            sql`${schema.auditLogs.requestMetadata}->>'requestId' = ${request.requestId}`,
          ),
        ),
    ).toEqual([]);
  });

  it("keeps bootstrap fixture organization inserts silent", async () => {
    const fixture = await createOrganization();
    expect(
      await database
        .select({ eventType: schema.outboxEvents.eventType })
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.organizationId, fixture.id)),
    ).toEqual([]);
  });
});
