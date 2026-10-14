import { fileURLToPath } from "node:url";
import { Algorithm, hash as hashPassword } from "@node-rs/argon2";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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

function bootstrapInput(email = "initial-admin@example.test") {
  return {
    email,
    displayName: "Initial Platform Administrator",
    passwordHash,
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
});

afterAll(async () => {
  await client.close();
});

describe("initial platform Superadmin provisioning", () => {
  it("refuses to adopt an existing non-Superadmin identity", async () => {
    const input = bootstrapInput("existing-user@example.test");
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
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$other$hash",
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
      email: "initial-admin@example.test",
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
    await database
      .delete(schema.supportRootAdministrators)
      .where(
        sql`${schema.supportRootAdministrators.userId} = ${created.userId}`,
      );
    await expect(
      provisionInitialSuperadmin(migratorDatabase, bootstrapInput()),
    ).resolves.toMatchObject({
      status: "ALREADY_PROVISIONED",
      userId: created.userId,
    });
    expect(
      await database
        .select()
        .from(schema.supportRootAdministrators)
        .where(
          sql`${schema.supportRootAdministrators.userId} = ${created.userId}`,
        ),
    ).toHaveLength(1);
  });

  it("refuses to create an additional Superadmin after one exists", async () => {
    await expect(
      provisionInitialSuperadmin(
        migratorDatabase,
        bootstrapInput("another-admin@example.test"),
      ),
    ).rejects.toMatchObject({
      code: "INITIAL_SUPERADMIN_ALREADY_EXISTS",
    });
  });

  it("refuses provisioning through the runtime API role", async () => {
    await expect(
      provisionInitialSuperadmin(runtimeDatabase, bootstrapInput()),
    ).rejects.toMatchObject({ code: "MIGRATOR_ROLE_REQUIRED" });
  });
});
