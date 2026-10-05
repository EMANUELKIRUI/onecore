import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm/relations";
import type { PostgresJsTransaction } from "drizzle-orm/postgres-js";
import type { Database } from "./index.js";
import {
  branches,
  membershipBranches,
  organizations,
  organizationMemberships,
  users,
} from "../schema/index.js";

export type OrganizationTransaction = PostgresJsTransaction<EmptyRelations>;

export interface VerifiedOrganizationMembership {
  membershipId: string;
  organizationId: string;
  branchAccessMode: (typeof organizationMemberships.$inferSelect)["branchAccessMode"];
}

export interface VerifiedBranch {
  branchId: string;
  name: string;
  code: string;
}

async function withActiveMembership<T>(
  database: Database,
  userId: string,
  organizationId: string,
  operation: (
    transaction: OrganizationTransaction,
    membership: VerifiedOrganizationMembership,
  ) => Promise<T>,
): Promise<T | undefined> {
  const trustedUserId = z.uuid().parse(userId);
  const requestedOrganizationId = z.uuid().parse(organizationId);

  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('app.current_user_id', ${trustedUserId}, true)`,
    );
    const [candidateMembership] = await transaction
      .select({
        membershipId: organizationMemberships.id,
      })
      .from(organizationMemberships)
      .innerJoin(
        organizations,
        eq(organizationMemberships.organizationId, organizations.id),
      )
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(
        and(
          eq(organizationMemberships.userId, trustedUserId),
          eq(organizationMemberships.organizationId, requestedOrganizationId),
          eq(organizationMemberships.status, "ACTIVE"),
          eq(organizations.status, "ACTIVE"),
          eq(users.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!candidateMembership) return undefined;

    // Establish tenant context before revalidating and locking under forced RLS.
    await transaction.execute(
      sql`select set_config('app.current_organization_id', ${requestedOrganizationId}, true)`,
    );

    const [membership] = await transaction
      .select({
        membershipId: organizationMemberships.id,
        organizationId: organizationMemberships.organizationId,
        branchAccessMode: organizationMemberships.branchAccessMode,
      })
      .from(organizationMemberships)
      .innerJoin(
        organizations,
        eq(organizationMemberships.organizationId, organizations.id),
      )
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(
        and(
          eq(organizationMemberships.userId, trustedUserId),
          eq(organizationMemberships.organizationId, requestedOrganizationId),
          eq(organizationMemberships.status, "ACTIVE"),
          eq(organizations.status, "ACTIVE"),
          eq(users.status, "ACTIVE"),
        ),
      )
      .for("share")
      .limit(1);
    if (!membership) return undefined;
    return operation(transaction, membership);
  });
}

export function withActiveOrganizationTransaction<T>(
  database: Database,
  userId: string,
  organizationId: string,
  operation: (
    transaction: OrganizationTransaction,
    membership: VerifiedOrganizationMembership,
  ) => Promise<T>,
): Promise<T | undefined> {
  return withActiveMembership(database, userId, organizationId, operation);
}

export function withActiveBranchTransaction<T>(
  database: Database,
  userId: string,
  organizationId: string,
  branchId: string,
  operation: (
    transaction: OrganizationTransaction,
    membership: VerifiedOrganizationMembership,
    branch: VerifiedBranch,
  ) => Promise<T>,
): Promise<T | undefined> {
  const requestedBranchId = z.uuid().parse(branchId);
  return withActiveMembership(
    database,
    userId,
    organizationId,
    async (transaction, membership) => {
      const [branch] = await transaction
        .select({
          branchId: branches.id,
          name: branches.name,
          code: branches.code,
        })
        .from(branches)
        .where(
          and(
            eq(branches.id, requestedBranchId),
            eq(branches.organizationId, organizationId),
            eq(branches.status, "ACTIVE"),
          ),
        )
        .for("share")
        .limit(1);
      if (!branch) return undefined;
      if (membership.branchAccessMode !== "ALL") {
        const [assignment] = await transaction
          .select({ branchId: membershipBranches.branchId })
          .from(membershipBranches)
          .where(
            and(
              eq(membershipBranches.organizationId, organizationId),
              eq(membershipBranches.membershipId, membership.membershipId),
              eq(membershipBranches.branchId, requestedBranchId),
            ),
          )
          .for("share")
          .limit(1);
        if (!assignment) return undefined;
      }
      await transaction.execute(
        sql`select set_config('app.current_branch_id', ${requestedBranchId}, true)`,
      );
      return operation(transaction, membership, branch);
    },
  );
}

export async function withLoginTransaction<T>(
  database: Database,
  normalizedEmail: string,
  operation: (transaction: OrganizationTransaction) => Promise<T>,
): Promise<T> {
  if (
    normalizedEmail.length === 0 ||
    normalizedEmail !== normalizedEmail.trim().toLowerCase()
  ) {
    throw new TypeError("Login email must be normalized");
  }

  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('app.current_login_email', ${normalizedEmail}, true)`,
    );
    return operation(transaction);
  });
}

export async function withSessionTransaction<T>(
  database: Database,
  secretHash: string,
  operation: (transaction: OrganizationTransaction) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(secretHash)) {
    throw new TypeError("Session hash must be a SHA-256 hex digest");
  }

  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('app.current_session_hash', ${secretHash}, true)`,
    );
    return operation(transaction);
  });
}

export async function withAuthenticatedUserTransaction<T>(
  database: Database,
  userId: string,
  operation: (transaction: OrganizationTransaction) => Promise<T>,
): Promise<T> {
  const trustedUserId = z.uuid().parse(userId);

  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('app.current_user_id', ${trustedUserId}, true)`,
    );
    return operation(transaction);
  });
}

export async function withOrganizationTransaction<T>(
  database: Database,
  organizationId: string,
  operation: (transaction: OrganizationTransaction) => Promise<T>,
): Promise<T> {
  const trustedOrganizationId = z.uuid().parse(organizationId);

  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('app.current_organization_id', ${trustedOrganizationId}, true)`,
    );
    return operation(transaction);
  });
}
