import { Algorithm, hash as hashPassword } from "@node-rs/argon2";
import {
  createDatabase,
  INITIAL_ROOT_SUPERADMIN_EMAIL,
  InitialSuperadminProvisioningError,
  MigrationTargetError,
  provisionInitialSuperadmin,
  resolveMigrationTarget,
} from "@onecore/database";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const passwordOptions = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("A secure interactive terminal is required");
  }

  return new Promise((resolve, reject) => {
    let secret = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdout.write("\n");
      if (error) reject(error);
      else resolve(secret);
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          secret = secret.slice(0, -1);
        } else if (character >= " ") {
          secret += character;
        }
      }
    };

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

export class InitialSuperadminInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitialSuperadminInputError";
  }
}

export function validateInitialSuperadminPassword(
  password: string,
  confirmation: string,
): void {
  if (password.length < 16 || password.length > 1_024) {
    throw new InitialSuperadminInputError(
      "Password must be between 16 and 1024 characters.",
    );
  }
  if (password !== confirmation) {
    throw new InitialSuperadminInputError("Passwords did not match.");
  }
}

async function readInitialPasswordHash(): Promise<string> {
  const password = await askSecret("Password (input hidden): ");
  const confirmation = await askSecret("Confirm password: ");
  validateInitialSuperadminPassword(password, confirmation);
  return hashPassword(password, passwordOptions);
}

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("A secure interactive terminal is required");
  }
  const target = resolveMigrationTarget(process.env);

  const displayName = (await ask("Display name: ")).trim();
  const confirmation = await ask(
    `Type CREATE ${INITIAL_ROOT_SUPERADMIN_EMAIL} to provision or confirm the initial Root Superadmin: `,
  );
  if (confirmation !== `CREATE ${INITIAL_ROOT_SUPERADMIN_EMAIL}`) {
    stdout.write("Provisioning cancelled.\n");
    return;
  }

  const passwordHash = await readInitialPasswordHash();
  const { db, close } = createDatabase(target.connectionString, {
    maxConnections: 1,
  });
  try {
    const result = await provisionInitialSuperadmin(db, {
      email: INITIAL_ROOT_SUPERADMIN_EMAIL,
      displayName,
      passwordHash,
      expectedDatabase: target.database,
    });
    stdout.write(
      result.status === "CREATED"
        ? "Initial Root Superadmin provisioned. MFA enrollment is required at first sign-in.\n"
        : "Existing initial Superadmin confirmed as Root administrator. Account credentials were unchanged; MFA is required.\n",
    );
  } finally {
    await close();
  }
}

function reportProvisioningError(error: unknown): void {
  if (error instanceof InitialSuperadminProvisioningError) {
    console.error(`Provisioning refused: ${error.code}`);
  } else if (error instanceof MigrationTargetError) {
    console.error(`Provisioning refused: ${error.message}`);
  } else if (error instanceof InitialSuperadminInputError) {
    console.error(`Provisioning refused: ${error.message}`);
  } else {
    console.error(
      "Provisioning failed or was cancelled. No credentials or database details were logged.",
    );
  }
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(reportProvisioningError);
}
