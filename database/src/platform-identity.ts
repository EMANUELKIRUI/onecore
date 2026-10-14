import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  platformUserRoles,
  supportRootAdministrators,
  users,
} from "../schema/index.js";
import type { Database } from "./index.js";

const initialSuperadminInputSchema = z
  .object({
    email: z.email().trim().toLowerCase().max(320),
    displayName: z.string().trim().min(1).max(200),
    passwordHash: z.string().startsWith("$argon2id$").max(512),
  })
  .strict();

export class InitialSuperadminProvisioningError extends Error {
  constructor(
    readonly code:
      | "MIGRATOR_ROLE_REQUIRED"
      | "INITIAL_SUPERADMIN_ALREADY_EXISTS"
      | "IDENTITY_ALREADY_EXISTS",
  ) {
    super(code);
    this.name = "InitialSuperadminProvisioningError";
  }
}

export interface InitialSuperadminProvisionResult {
  status: "CREATED" | "ALREADY_PROVISIONED";
  userId: string;
}

export async function provisionInitialSuperadmin(
  database: Database,
  input: unknown,
): Promise<InitialSuperadminProvisionResult> {
  const data = initialSuperadminInputSchema.parse(input);

  return database.transaction(async (transaction) => {
    const connectionResult = (await transaction.execute(
      sql`select current_user as role`,
    )) as unknown as
      Array<{ role: string }> | { rows: Array<{ role: string }> };
    const currentRole = Array.isArray(connectionResult)
      ? connectionResult[0]?.role
      : connectionResult.rows[0]?.role;
    if (currentRole !== "onecore_migrator") {
      throw new InitialSuperadminProvisioningError("MIGRATOR_ROLE_REQUIRED");
    }

    await transaction.execute(sql`select pg_advisory_xact_lock(731947, 1)`);
    await transaction.execute(
      sql`select set_config('app.current_login_email', ${data.email}, true)`,
    );

    const superadmins = await transaction
      .select({ userId: platformUserRoles.userId })
      .from(platformUserRoles)
      .where(eq(platformUserRoles.role, "SUPERADMIN"));
    const [existingUser] = await transaction
      .select({
        id: users.id,
        status: users.status,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.email, data.email))
      .limit(1);

    if (
      existingUser &&
      superadmins.some(({ userId }) => userId === existingUser.id)
    ) {
      if (
        existingUser.status === "ACTIVE" &&
        existingUser.passwordHash?.startsWith("$argon2id$")
      ) {
        await transaction
          .insert(supportRootAdministrators)
          .values({ userId: existingUser.id })
          .onConflictDoNothing();
        return { status: "ALREADY_PROVISIONED", userId: existingUser.id };
      }
      throw new InitialSuperadminProvisioningError(
        "INITIAL_SUPERADMIN_ALREADY_EXISTS",
      );
    }

    if (superadmins.length > 0) {
      throw new InitialSuperadminProvisioningError(
        "INITIAL_SUPERADMIN_ALREADY_EXISTS",
      );
    }
    if (existingUser) {
      throw new InitialSuperadminProvisioningError("IDENTITY_ALREADY_EXISTS");
    }

    const [user] = await transaction
      .insert(users)
      .values({
        email: data.email,
        displayName: data.displayName,
        status: "ACTIVE",
        passwordHash: data.passwordHash,
      })
      .returning({ id: users.id });
    if (!user) throw new Error("Initial Superadmin identity was not created");

    await transaction.insert(platformUserRoles).values({
      userId: user.id,
      role: "SUPERADMIN",
    });
    await transaction.insert(supportRootAdministrators).values({
      userId: user.id,
    });

    return { status: "CREATED", userId: user.id };
  });
}
