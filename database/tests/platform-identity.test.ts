import { fileURLToPath } from "node:url";
import { Algorithm, hash as hashPassword } from "@node-rs/argon2";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  INITIAL_ROOT_SUPERADMIN_EMAIL,
  createIdentityRepository,
  provisionInitialSuperadmin,
  type Database,
  type OrganizationTransaction,
} from "../src/index.js";
import * as schema from "../schema/index.js";
import { applyTestMigrations } from "./migration-fixture.js";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

let client: PGlite;
let database: PgliteDatabase;
let migratorDatabase: Database;
let runtimeDatabase: Database;
let passwordHash: string;
let replacementPasswordHash: string;
let testDatabaseName: string;

function bootstrapInput(email = INITIAL_ROOT_SUPERADMIN_EMAIL) {
  return {
    email,
    displayName: "Initial Platform Administrator",
    passwordHash,
    expectedDatabase: testDatabaseName,
  };
}

beforeAll(async () => {
  passwordHash = await hashPassword("fixture-only-superadmin-password", {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
  replacementPasswordHash = await hashPassword(
    "another-fixture-only-password",
    {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    },
  );
  client = new PGlite();
  database = drizzle({ client });
  await client.exec(`
    CREATE ROLE onecore_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE onecore_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
  `);
  await applyTestMigrations(client, migrationsDirectory);
  await client.exec(`
    GRANT USAGE ON SCHEMA public TO onecore_migrator;
    GRANT SELECT, INSERT ON users, platform_user_roles,
      support_root_administrators TO onecore_migrator;
    GRANT SELECT, INSERT ON audit_logs TO onecore_migrator;
    GRANT SELECT ON organization_memberships TO onecore_migrator;
  `);

  migratorDatabase = {
    transaction: (
      operation: (transaction: OrganizationTransaction) => Promise<unknown>,
    ) =>
      database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE onecore_migrator`);
        return operation(transaction as unknown as OrganizationTransaction);
      }),
  } as unknown as Database;
  runtimeDatabase = {
    transaction: (
      operation: (transaction: OrganizationTransaction) => Promise<unknown>,
    ) =>
      database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
        return operation(transaction as unknown as OrganizationTransaction);
      }),
  } as unknown as Database;
  const result = await client.query<{ database: string }>(
    "select current_database() as database",
  );
  testDatabaseName = result.rows[0]!.database;
});

beforeEach(async () => {
  await database.delete(schema.supportRootAdministrators);
  await database.delete(schema.platformUserRoles);
  await database.delete(schema.users);
});

afterAll(async () => {
  await client.close();
});

describe("initial platform Superadmin provisioning", () => {
  it("normalizes the configured root email and refuses any other address", async () => {
    await expect(
      provisionInitialSuperadmin(
        migratorDatabase,
        bootstrapInput("not-the-root@example.test"),
      ),
    ).rejects.toMatchObject({ code: "ROOT_EMAIL_MISMATCH" });

    await expect(
      provisionInitialSuperadmin(
        migratorDatabase,
        bootstrapInput("  EMANUELKIRUI1@GMAIL.COM "),
      ),
    ).resolves.toMatchObject({ status: "CREATED" });
    expect(
      await database.select({ email: schema.users.email }).from(schema.users),
    ).toEqual([{ email: INITIAL_ROOT_SUPERADMIN_EMAIL }]);
  });

  it("refuses to adopt an existing non-Superadmin identity", async () => {
    const input = bootstrapInput();
    await database.insert(schema.users).values({
      email: input.email,
      displayName: "Existing Account",
      status: "ACTIVE",
    });

    await expect(
      provisionInitialSuperadmin(migratorDatabase, input),
    ).rejects.toMatchObject({ code: "IDENTITY_ALREADY_EXISTS" });
    expect(
      await database
        .select()
        .from(schema.platformUserRoles)
        .where(sql`${schema.platformUserRoles.role} = 'SUPERADMIN'`),
    ).toHaveLength(0);
  });

  it("creates one active global Superadmin and treats repeat execution as a no-op", async () => {
    const created = await provisionInitialSuperadmin(
      migratorDatabase,
      bootstrapInput(),
    );
    const repeated = await provisionInitialSuperadmin(migratorDatabase, {
      ...bootstrapInput(),
      displayName: "Must Not Replace Existing Name",
      passwordHash: replacementPasswordHash,
    });
    const [user] = await database
      .select()
      .from(schema.users)
      .where(sql`${schema.users.id} = ${created.userId}`);
    const role = await database
      .select()
      .from(schema.platformUserRoles)
      .where(sql`${schema.platformUserRoles.userId} = ${created.userId}`);

    expect(created.status).toBe("CREATED");
    expect(repeated).toEqual({
      status: "ALREADY_PROVISIONED",
      userId: created.userId,
    });
    expect(user).toMatchObject({
      email: INITIAL_ROOT_SUPERADMIN_EMAIL,
      displayName: "Initial Platform Administrator",
      status: "ACTIVE",
      passwordHash,
    });
    expect(passwordHash).toMatch(/^\$argon2id\$/);
    expect(role.map(({ role: platformRole }) => platformRole)).toEqual([
      "SUPERADMIN",
    ]);
    expect(
      await createIdentityRepository(
        database as unknown as Database,
      ).userRequiresMfa(created.userId),
    ).toBe(true);
    expect(
      await database
        .select()
        .from(schema.supportRootAdministrators)
        .where(
          sql`${schema.supportRootAdministrators.userId} = ${created.userId}`,
        ),
    ).toHaveLength(1);
    const initialAudit = await database
      .select()
      .from(schema.auditLogs)
      .where(
        sql`${schema.auditLogs.resourceId} = ${created.userId} AND ${schema.auditLogs.action} = 'platform.superadmin.initial_provisioned'`,
      );
    expect(initialAudit).toHaveLength(1);
    expect(initialAudit[0]?.requestMetadata).toEqual({
      source: "operator_bootstrap",
    });
    await database
      .delete(schema.supportRootAdministrators)
      .where(
        sql`${schema.supportRootAdministrators.userId} = ${created.userId}`,
      );
    await expect(
      provisionInitialSuperadmin(migratorDatabase, bootstrapInput()),
    ).rejects.toMatchObject({
      code: "INITIAL_SUPERADMIN_ALREADY_EXISTS",
    });
    expect(
      await database
        .select()
        .from(schema.supportRootAdministrators)
        .where(
          sql`${schema.supportRootAdministrators.userId} = ${created.userId}`,
        ),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(schema.auditLogs)
        .where(
          sql`${schema.auditLogs.resourceId} = ${created.userId} AND ${schema.auditLogs.action} = 'platform.superadmin.initial_provisioned'`,
        ),
    ).toHaveLength(1);
  });

  it("rejects malformed password hashes before creating an identity", async () => {
    await expect(
      provisionInitialSuperadmin(migratorDatabase, {
        ...bootstrapInput(),
        passwordHash: "$argon2id$not-a-real-hash",
      }),
    ).rejects.toThrow();
    expect(
      await database
        .select()
        .from(schema.users)
        .where(sql`${schema.users.email} = ${INITIAL_ROOT_SUPERADMIN_EMAIL}`),
    ).toHaveLength(0);
  });

  it("refuses to create an additional Superadmin after one exists", async () => {
    const [otherUser] = await database
      .insert(schema.users)
      .values({
        email: "another-admin@example.test",
        displayName: "Another Admin",
        status: "ACTIVE",
        passwordHash,
      })
      .returning({ id: schema.users.id });
    await database.insert(schema.platformUserRoles).values({
      userId: otherUser!.id,
      role: "SUPERADMIN",
    });
    await expect(
      provisionInitialSuperadmin(migratorDatabase, bootstrapInput()),
    ).rejects.toMatchObject({
      code: "INITIAL_SUPERADMIN_ALREADY_EXISTS",
    });
  });

  it("refuses provisioning through the runtime API role", async () => {
    await expect(
      provisionInitialSuperadmin(runtimeDatabase, bootstrapInput()),
    ).rejects.toMatchObject({ code: "MIGRATOR_ROLE_REQUIRED" });
  });

  it("refuses provisioning when the connected database differs from the expected target", async () => {
    await expect(
      provisionInitialSuperadmin(migratorDatabase, {
        ...bootstrapInput(),
        expectedDatabase: "another_database",
      }),
    ).rejects.toMatchObject({ code: "DATABASE_TARGET_MISMATCH" });
  });

  it("refuses to confirm the root when another Superadmin or root marker exists", async () => {
    const created = await provisionInitialSuperadmin(
      migratorDatabase,
      bootstrapInput(),
    );
    const [otherUser] = await database
      .insert(schema.users)
      .values({
        email: "another-admin@example.test",
        displayName: "Another Admin",
        status: "ACTIVE",
        passwordHash,
      })
      .returning({ id: schema.users.id });
    await database.insert(schema.platformUserRoles).values({
      userId: otherUser!.id,
      role: "SUPERADMIN",
    });

    await expect(
      provisionInitialSuperadmin(migratorDatabase, bootstrapInput()),
    ).rejects.toMatchObject({
      code: "INITIAL_SUPERADMIN_ALREADY_EXISTS",
    });
    expect(created.status).toBe("CREATED");
  });

  it("rolls back identity and role writes when root-marker creation fails", async () => {
    await client.exec(`
      CREATE FUNCTION reject_root_marker_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'synthetic root marker failure';
      END;
      $$;
      CREATE TRIGGER reject_root_marker_insert
      BEFORE INSERT ON support_root_administrators
      FOR EACH ROW EXECUTE FUNCTION reject_root_marker_insert();
    `);
    try {
      await expect(
        provisionInitialSuperadmin(migratorDatabase, bootstrapInput()),
      ).rejects.toThrow();
    } finally {
      await client.exec(`
        DROP TRIGGER reject_root_marker_insert ON support_root_administrators;
        DROP FUNCTION reject_root_marker_insert();
      `);
    }
    expect(
      await database
        .select()
        .from(schema.users)
        .where(sql`${schema.users.email} = ${INITIAL_ROOT_SUPERADMIN_EMAIL}`),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(schema.platformUserRoles)
        .where(sql`${schema.platformUserRoles.role} = 'SUPERADMIN'`),
    ).toHaveLength(0);
  });
});
