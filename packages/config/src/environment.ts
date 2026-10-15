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
  BUSINESS_APP_ORIGIN: z
    .string()
    .url()
    .refine(
      (value) =>
        new URL(value).origin === value && new URL(value).protocol === "https:",
      "BUSINESS_APP_ORIGIN must be an HTTPS origin without a path",
    )
    .optional(),
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
  AUTH_MFA_ENFORCEMENT: z.enum(["required", "disabled"]).default("required"),
  MFA_ENCRYPTION_KEY: z.string().min(32).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),
  RESEND_BASE_URL: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === "https:", {
      message: "RESEND_BASE_URL must use HTTPS",
    })
    .optional(),
});

export type RuntimeConfig = z.infer<typeof environmentSchema>;

export class ConfigurationError extends Error {
  constructor(readonly invalidKeys: readonly string[]) {
    super(`Invalid environment configuration: ${invalidKeys.join(", ")}`);
    this.name = "ConfigurationError";
  }
}

function defaultHost(environment: NodeJS.ProcessEnv): string {
  if (environment.HOST !== undefined) return environment.HOST;

  const serverEnvironment =
    environment.PORT !== undefined ||
    environment.NODE_ENV === "staging" ||
    environment.NODE_ENV === "production";
  return serverEnvironment ? "0.0.0.0" : "127.0.0.1";
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const result = environmentSchema.safeParse({
    ...environment,
    HOST: defaultHost(environment),
  });

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

  if (
    result.data.AUTH_MFA_ENFORCEMENT === "disabled" &&
    environment.NODE_ENV !== "development" &&
    environment.NODE_ENV !== "test"
  ) {
    throw new ConfigurationError(["AUTH_MFA_ENFORCEMENT"]);
  }

  return result.data;
}
