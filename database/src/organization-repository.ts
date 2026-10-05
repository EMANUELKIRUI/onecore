import { and, eq } from "drizzle-orm";
import {
  branches,
  organizations,
  type OrganizationTransaction,
} from "./index.js";

export interface OrganizationRepository {
  findOrganization(): Promise<typeof organizations.$inferSelect | undefined>;
  findBranchById(
    branchId: string,
  ): Promise<typeof branches.$inferSelect | undefined>;
  findBranches(): Promise<(typeof branches.$inferSelect)[]>;
}

export function createOrganizationRepository(
  transaction: OrganizationTransaction,
  organizationId: string,
): OrganizationRepository {
  return {
    async findOrganization() {
      const [organization] = await transaction
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      return organization;
    },
    async findBranchById(branchId) {
      const [branch] = await transaction
        .select()
        .from(branches)
        .where(
          and(
            eq(branches.organizationId, organizationId),
            eq(branches.id, branchId),
          ),
        )
        .limit(1);
      return branch;
    },
    async findBranches() {
      return transaction
        .select()
        .from(branches)
        .where(eq(branches.organizationId, organizationId));
    },
  };
}
