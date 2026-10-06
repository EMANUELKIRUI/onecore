import pino, { type DestinationStream, type Logger } from "pino";

const sensitiveFields = [
  "password",
  "PASSWORD",
  "passwordHash",
  "password_hash",
  "PASSWORD_HASH",
  "passwd",
  "secret",
  "secretHash",
  "secret_hash",
  "session",
  "sessionSecret",
  "session_secret",
  "sessionToken",
  "session_token",
  "SESSION_TOKEN",
  "SESSION_SECRET",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "api-key",
  "x-api-key",
  "set-cookie",
  "credential",
  "clientSecret",
  "client_secret",
  "CLIENT_SECRET",
  "privateKey",
  "private_key",
  "authorization",
  "cookie",
  "cookies",
  "connectionString",
  "connection_string",
  "databasePassword",
  "database_password",
  "databaseUrl",
  "database_url",
  "DATABASE_URL",
  "DB_PASSWORD",
  "AWS_SECRET_ACCESS_KEY",
];

const redactPaths = [
  ...sensitiveFields,
  ...Array.from({ length: 10 }, (_, depth) =>
    sensitiveFields.map((field) =>
      Array(depth + 1)
        .fill("*")
        .concat(field)
        .join("."),
    ),
  ).flat(),
];

export function createLogger(
  service: string,
  level: string,
  destination?: DestinationStream,
  environment = process.env.NODE_ENV ?? "development",
): Logger {
  return pino(
    {
      level,
      base: { service, environment },
      redact: {
        paths: redactPaths,
        censor: "[REDACTED]",
      },
    },
    destination,
  );
}
