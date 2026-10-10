import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, branches, rateLimitBuckets } from "../schema/index.js";
import type { Database, OrganizationTransaction } from "./index.js";
import { withOrganizationTransaction } from "./tenant-context.js";

const organizationIdSchema = z.uuid();
const scopeSchema = z
  .string()
  .min(3)
  .max(100)
  .regex(/^[a-z][a-z0-9_.-]+$/);

export interface RateLimitInput {
  scope: string;
  subject: string;
  organizationId?: string;
  branchId?: string;
  requestId?: string;
  correlationId?: string;
  limit: number;
  windowMs: number;
  now?: Date;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

export interface RateLimiter {
  consume(input: RateLimitInput): Promise<RateLimitDecision>;
}

function rateLimitKey(
  input: RateLimitInput,
  organizationId: string | null,
  branchId: string | null,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([organizationId, branchId, input.scope, input.subject]),
    )
    .digest("hex");
}

function validateInput(input: RateLimitInput): string | null {
  scopeSchema.parse(input.scope);
  z.string().min(1).max(512).parse(input.subject);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new TypeError("Rate limit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1_000) {
    throw new TypeError("Rate limit window must be at least one second");
  }
  if (input.requestId !== undefined) z.uuid().parse(input.requestId);
  if (input.correlationId !== undefined) z.uuid().parse(input.correlationId);
  const organizationId =
    input.organizationId === undefined
      ? null
      : organizationIdSchema.parse(input.organizationId);
  if (input.branchId !== undefined && !organizationId) {
    throw new TypeError("A rate limit branch requires an organization");
  }
  if (input.branchId !== undefined) z.uuid().parse(input.branchId);
  return organizationId;
}

export function createDatabaseRateLimiter(database: Database): RateLimiter {
  let operations = 0;

  async function updateBucket(
    transaction: OrganizationTransaction,
    input: RateLimitInput,
    organizationId: string | null,
    branchId: string | null,
    now: Date,
  ): Promise<RateLimitDecision> {
    const keyHash = rateLimitKey(input, organizationId, branchId);
    const expiresAt = new Date(now.getTime() + input.windowMs);
    const nowIso = now.toISOString();
    const expiresAtIso = expiresAt.toISOString();
    const [bucket] = await transaction
      .insert(rateLimitBuckets)
      .values({
        keyHash,
        organizationId,
        branchId,
        hitCount: 1,
        expiresAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: rateLimitBuckets.keyHash,
        set: {
          organizationId,
          branchId,
          hitCount: sql`
            CASE WHEN ${rateLimitBuckets.expiresAt} <= ${nowIso}::timestamptz
              THEN 1 ELSE ${rateLimitBuckets.hitCount} + 1
            END
          `,
          expiresAt: sql`
            CASE WHEN ${rateLimitBuckets.expiresAt} <= ${nowIso}::timestamptz
              THEN ${expiresAtIso}::timestamptz ELSE ${rateLimitBuckets.expiresAt}
            END
          `,
          updatedAt: now,
        },
      })
      .returning({
        hitCount: rateLimitBuckets.hitCount,
        expiresAt: rateLimitBuckets.expiresAt,
      });

    if (!bucket) throw new Error("Rate limit bucket update returned no row");

    if (!Number.isSafeInteger(bucket.hitCount) || bucket.hitCount < 1) {
      throw new Error("Rate limit bucket returned an invalid count");
    }
    if (bucket.hitCount === input.limit + 1) {
      await transaction.insert(auditLogs).values({
        organizationId,
        action: "security.rate_limit.triggered",
        resource: "authentication",
        resourceId: input.scope,
        occurredAt: now,
        requestMetadata: {
          requestId: input.requestId ?? null,
          correlationId: input.correlationId ?? null,
          reason: "limit_exceeded",
          subjectHash: keyHash,
        },
        result: "FAILURE",
      });
    }

    operations += 1;
    if (operations % 100 === 0) {
      await transaction.execute(sql`
        DELETE FROM "rate_limit_buckets"
        WHERE "key_hash" IN (
          SELECT "key_hash" FROM "rate_limit_buckets"
          WHERE "organization_id" IS NOT DISTINCT FROM ${organizationId}::uuid
            AND "branch_id" IS NOT DISTINCT FROM ${branchId}::uuid
            AND "expires_at" <= ${nowIso}::timestamptz
          ORDER BY "expires_at"
          LIMIT 1000
        )
      `);
    }

    return {
      allowed: bucket.hitCount <= input.limit,
      remaining: Math.max(0, input.limit - bucket.hitCount),
      resetAt: bucket.expiresAt,
    };
  }

  return {
    async consume(input) {
      const organizationId = validateInput(input);
      const now = input.now ?? new Date();
      if (!(now instanceof Date) || Number.isNaN(now.getTime()))
        throw new TypeError("Invalid rate limit time");
      if (Number.isNaN(new Date(now.getTime() + input.windowMs).getTime())) {
        throw new TypeError("Rate limit expiry is outside the supported range");
      }

      if (organizationId) {
        const result = await withOrganizationTransaction(
          database,
          organizationId,
          async (transaction) => {
            const branchId = input.branchId ?? null;
            if (branchId) {
              const [branch] = await transaction
                .select({ id: branches.id })
                .from(branches)
                .where(
                  and(
                    eq(branches.id, branchId),
                    eq(branches.organizationId, organizationId),
                    eq(branches.status, "ACTIVE"),
                  ),
                )
                .limit(1);
              if (!branch) {
                throw new Error("Rate limit branch context is not active");
              }
              await transaction.execute(
                sql`select set_config('app.current_branch_id', ${branchId}, true)`,
              );
            }
            return updateBucket(
              transaction,
              input,
              organizationId,
              branchId,
              now,
            );
          },
        );
        if (!result) {
          throw new Error(
            "Rate limit organization context was not established",
          );
        }
        return result;
      }

      return database.transaction((transaction) =>
        updateBucket(
          transaction as OrganizationTransaction,
          input,
          null,
          null,
          now,
        ),
      );
    },
  };
}
