import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z
    .string()
    .min(1)
    .optional()
    .refine(
      (value) =>
        value === undefined ||
        value.startsWith("postgres://") ||
        value.startsWith("postgresql://"),
      "DATABASE_URL must use PostgreSQL",
    ),
  AUTH_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .refine(
      (origins) =>
        origins.every((origin) => {
          try {
            return new URL(origin).origin === origin;
          } catch {
            return false;
          }
        }),
      "AUTH_ALLOWED_ORIGINS must contain comma-separated origins",
    ),
  AUTH_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(86_400)
    .default(43_200),
  AUTH_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100).default(5),
  AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(60_000),
});

export type RuntimeConfig = z.infer<typeof environmentSchema>;

export class ConfigurationError extends Error {
  constructor(readonly invalidKeys: readonly string[]) {
    super(`Invalid environment configuration: ${invalidKeys.join(", ")}`);
    this.name = "ConfigurationError";
  }
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const invalidKeys = [
      ...new Set(
        result.error.issues.flatMap((issue) =>
          typeof issue.path[0] === "string" ? [issue.path[0]] : [],
        ),
      ),
    ];
    throw new ConfigurationError(
      invalidKeys.length > 0 ? invalidKeys : ["environment"],
    );
  }

  return result.data;
}
