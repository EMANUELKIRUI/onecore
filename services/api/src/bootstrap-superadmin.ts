import { Algorithm, hash as hashPassword } from "@node-rs/argon2";
import {
  createDatabase,
  InitialSuperadminProvisioningError,
  provisionInitialSuperadmin,
} from "@onecore/database";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

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

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("A secure interactive terminal is required");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const email = (await ask("Initial Superadmin email: ")).trim().toLowerCase();
  const displayName = (await ask("Display name: ")).trim();
  const confirmation = await ask(
    `Type CREATE to provision or confirm Root administrator access for ${email}: `,
  );
  if (confirmation !== "CREATE") {
    stdout.write("Provisioning cancelled.\n");
    return;
  }

  const password = await askSecret("Password (input hidden): ");
  const confirmationPassword = await askSecret("Confirm password: ");
  if (password.length < 16 || password.length > 1_024) {
    throw new Error("Password must be between 16 and 1024 characters");
  }
  if (password !== confirmationPassword) {
    throw new Error("Passwords did not match");
  }

  const passwordHash = await hashPassword(password, passwordOptions);
  const { db, close } = createDatabase(databaseUrl, { maxConnections: 1 });
  try {
    const result = await provisionInitialSuperadmin(db, {
      email,
      displayName,
      passwordHash,
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

main().catch((error: unknown) => {
  if (error instanceof InitialSuperadminProvisioningError) {
    console.error(`Provisioning refused: ${error.code}`);
  } else {
    console.error(
      "Provisioning failed or was cancelled. No credentials or database details were logged.",
    );
  }
  process.exitCode = 1;
});
