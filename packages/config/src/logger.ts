import pino, { type Logger } from "pino";

export function createLogger(service: string, level: string): Logger {
  return pino({
    level,
    base: { service },
    redact: {
      paths: [
        "*.password",
        "*.passwordHash",
        "*.password_hash",
        "*.token",
        "*.secret",
        "*.secretHash",
        "*.secret_hash",
        "*.apiKey",
        "*.accessToken",
        "*.refreshToken",
        "req.body.password",
        "req.headers.authorization",
        "req.headers.cookie",
      ],
      censor: "[REDACTED]",
    },
  });
}
