import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  platformUserRoles,
  supportRootAdministrators,
  users,
} from "../schema/index.js";
import type { Database } from "./index.js";
import type { OrganizationTransaction } from "./tenant-context.js";

export const INITIAL_ROOT_SUPERADMIN_EMAIL = "emanuelkirui1@gmail.com";

const initialSuperadminInputSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
    displayName: z.string().trim().min(1).max(200),
    passwordHash: z
      .string()
      .regex(
        /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/,
      )
      .max(512),
    expectedDatabase: z.string().trim().min(1).max(63),
  })
  .strict();

export class InitialSuperadminProvisioningError extends Error {
  constructor(
    readonly code:
      | "MIGRATOR_ROLE_REQUIRED"
      | "DATABASE_TARGET_MISMATCH"
      | "ROOT_EMAIL_MISMATCH"
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
  if (data.email !== INITIAL_ROOT_SUPERADMIN_EMAIL) {
    throw new InitialSuperadminProvisioningError("ROOT_EMAIL_MISMATCH");
  }

  return database.transaction(async (transaction) => {
    const connectionResult = (await transaction.execute(
      sql`select current_user as role, current_database() as database`,
    )) as unknown as
      | Array<{ role: string; database: string }>
      | { rows: Array<{ role: string; database: string }> };
    const connectionIdentity = Array.isArray(connectionResult)
      ? connectionResult[0]
      : connectionResult.rows[0];
    const currentRole = connectionIdentity?.role;
    if (currentRole !== "onecore_migrator") {
      throw new InitialSuperadminProvisioningError("MIGRATOR_ROLE_REQUIRED");
    }
    if (connectionIdentity?.database !== data.expectedDatabase) {
      throw new InitialSuperadminProvisioningError("DATABASE_TARGET_MISMATCH");
    }

    await transaction.execute(sql`select pg_advisory_xact_lock(731947, 1)`);
    await transaction.execute(
      sql`select set_config('app.current_login_email', ${data.email}, true)`,
    );

    const superadmins = await transaction
      .select({ userId: platformUserRoles.userId })
      .from(platformUserRoles)
      .where(eq(platformUserRoles.role, "SUPERADMIN"));
    const rootAdministrators = await transaction
      .select({ userId: supportRootAdministrators.userId })
      .from(supportRootAdministrators);
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
        superadmins.length === 1 &&
        rootAdministrators.length === 1 &&
        rootAdministrators[0]?.userId === existingUser.id &&
        existingUser.status === "ACTIVE" &&
        existingUser.passwordHash?.startsWith("$argon2id$")
      ) {
        return { status: "ALREADY_PROVISIONED", userId: existingUser.id };
      }
      throw new InitialSuperadminProvisioningError(
        "INITIAL_SUPERADMIN_ALREADY_EXISTS",
      );
    }

    if (superadmins.length > 0 || rootAdministrators.length > 0) {
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
    await writeInitialSuperadminAudit(transaction, user.id);

    return { status: "CREATED", userId: user.id };
  });
}

async function writeInitialSuperadminAudit(
  transaction: OrganizationTransaction,
  userId: string,
): Promise<void> {
  await transaction.insert(auditLogs).values({
    actorUserId: null,
    organizationId: null,
    action: "platform.superadmin.initial_provisioned",
    resource: "authentication",
    resourceId: userId,
    requestMetadata: { source: "operator_bootstrap" },
    result: "SUCCESS",
  });
}
