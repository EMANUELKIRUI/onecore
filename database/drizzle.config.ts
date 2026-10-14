import { defineConfig } from "drizzle-kit";

if (process.argv.includes("migrate")) {
  throw new Error(
    "Run `npm run db:migrate` so the migration target is verified before applying SQL",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema/**/*.ts",
  out: "./migrations",
  ...(process.env.DATABASE_URL
    ? { dbCredentials: { url: process.env.DATABASE_URL } }
    : {}),
  strict: true,
  verbose: true,
});
