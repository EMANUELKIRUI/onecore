import { randomUUID } from "node:crypto";
import {
  canTransitionOrganizationStatus,
  createDomainEvent,
  defaultOrganizationRoleTemplates,
  organizationStatusSchema,
} from "@onecore/core-domain";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, OrganizationTransaction } from "./index.js";
import { recordOutboxEvent } from "./outbox.js";
import {
  auditLogs,
  membershipRoles,
  modules,
  moduleDependencies,
  organizationMemberships,
  organizationModules,
  organizations,
  platformUserRoles,
  permissions,
  rolePermissions,
  roles,
  sessions,
  users,
} from "../schema/index.js";
import { withAuthenticatedUserTransaction } from "./tenant-context.js";

const uuidSchema = z.uuid();
const organizationInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  industry: z.string().trim().min(1).max(100),
  deploymentType: z.enum(["SAAS", "CUSTOM", "DEDICATED", "ENTERPRISE"]),
  bootstrapOwner: z.object({
    email: z.email().trim().toLowerCase().max(320),
    displayName: z.string().trim().min(1).max(200).optional(),
    passwordHash: z.string().min(1).optional(),
  }),
});
const organizationApplicationSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    industry: z.string().trim().min(1).max(100),
    deploymentType: z.literal("SAAS"),
    contactEmail: z.email().trim().toLowerCase().max(320),
    contactPhone: z.string().trim().min(1).max(50),
    website: z.url().max(2_048).optional(),
    ownerName: z.string().trim().min(1).max(200),
    ownerEmail: z.email().trim().toLowerCase().max(320),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/),
    region: z.string().trim().min(1).max(100),
    city: z.string().trim().min(1).max(100),
    address: z.string().trim().min(1).max(300),
    requestedModules: z.array(z.string().trim().min(1).max(100)).max(50),
  })
  .strict();
const organizationApplicationProfileSchema = z
  .object({
    application: organizationApplicationSchema
      .omit({
        name: true,
        slug: true,
        industry: true,
        deploymentType: true,
      })
      .strict(),
  })
  .strict();
const userInputSchema = z.object({
  email: z.email().trim().toLowerCase().max(320),
  displayName: z.string().trim().min(1).max(200),
  passwordHash: z.string().min(1),
});
const invitationInputSchema = z.object({
  email: z.email().trim().toLowerCase().max(320),
  displayName: z.string().trim().min(1).max(200),
});
type InvitationInput = z.infer<typeof invitationInputSchema>;
type BootstrapOwnerResult = {
  id: string;
  membershipId: string;
  email: string;
  displayName: string;
  status: LifecycleUser["status"];
};
type InvitationResult = BootstrapOwnerResult;
type LifecycleUser = Pick<
  typeof users.$inferSelect,
  "id" | "email" | "displayName" | "status"
>;

export interface PlatformLifecycleActor {
  userId: string;
  sessionId: string;
}

export interface LifecycleRequestMetadata {
  requestId: string;
  correlationId: string;
}

export class LifecycleMutationError extends Error {
  constructor(
    readonly code:
      | "LIFECYCLE_UNAUTHORIZED"
      | "ORGANIZATION_NOT_FOUND"
      | "ORGANIZATION_NOT_ACTIVE"
      | "INVALID_ORGANIZATION_STATE_TRANSITION"
      | "BOOTSTRAP_OWNER_CREDENTIALS_REQUIRED"
      | "BOOTSTRAP_OWNER_CANNOT_BE_SUPERADMIN"
      | "USER_NOT_ACTIVE"
      | "USER_ALREADY_EXISTS"
      | "MEMBERSHIP_ALREADY_EXISTS"
      | "APPLICATION_ALREADY_EXISTS"
      | "APPLICATION_NOT_APPROVED"
      | "APPLICATION_PROVISIONING_REQUIRED"
      | "APPLICATION_NOT_FOUND"
      | "APPLICATION_PROVISIONING_INCOMPLETE"
      | "APPLICATION_MODULE_UNAVAILABLE"
      | "APPLICATION_MODULE_DEPENDENCY_UNSATISFIED"
      | "APPLICATION_OWNER_CANNOT_BE_SUPERADMIN",
  ) {
    super(code);
    this.name = "LifecycleMutationError";
  }
}

export interface LifecycleMutationService {
  listPublicModules(): Promise<
    Array<{ name: string; displayName: string; description: string | null }>
  >;
  submitOrganizationApplication(
    input: unknown,
    metadata: LifecycleRequestMetadata,
  ): Promise<{ organization: typeof organizations.$inferSelect }>;
  listOrganizationApplications(
    actor: PlatformLifecycleActor,
  ): Promise<Array<typeof organizations.$inferSelect>>;
  transitionOrganizationApplication(
    organizationId: string,
    status: "UNDER_REVIEW" | "APPROVED" | "REJECTED",
    actor: PlatformLifecycleActor,
    metadata: LifecycleRequestMetadata,
  ): Promise<typeof organizations.$inferSelect>;
  createOrganization(
    input: unknown,
    actor: PlatformLifecycleActor,
    metadata: LifecycleRequestMetadata,
  ): Promise<{
    organization: typeof organizations.$inferSelect;
    bootstrapOwner: BootstrapOwnerResult;
  }>;
  activateOrganization(
    organizationId: string,
    actor: PlatformLifecycleActor,
    metadata: LifecycleRequestMetadata,
  ): Promise<typeof organizations.$inferSelect>;
  provisionApprovedOrganizationApplication(
    organizationId: string,
    actor: PlatformLifecycleActor,
    metadata: LifecycleRequestMetadata,
  ): Promise<{
    organization: typeof organizations.$inferSelect;
    owner: {
      id: string;
      membershipId: string;
      email: string;
      displayName: string;
      accountStatus: (typeof users.$inferSelect)["status"];
      membershipStatus: (typeof organizationMemberships.$inferSelect)["status"];
    };
    enabledModules: string[];
  }>;
  createUser(
    transaction: OrganizationTransaction,
    organizationId: string,
    actorUserId: string,
    metadata: LifecycleRequestMetadata,
    input: unknown,
  ): Promise<{
    id: string;
    organizationId: string;
    email: string;
    displayName: string;
  }>;
  inviteUser(
    transaction: OrganizationTransaction,
    organizationId: string,
    actorUserId: string,
    metadata: LifecycleRequestMetadata,
    input: unknown,
  ): Promise<{
    id: string;
    membershipId: string;
    email: string;
    displayName: string;
  }>;
}

async function verifyPlatformActor(
  transaction: OrganizationTransaction,
  actor: PlatformLifecycleActor,
): Promise<void> {
  const userId = uuidSchema.parse(actor.userId);
  const sessionId = uuidSchema.parse(actor.sessionId);
  const [session] = await transaction
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
        eq(users.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (!session) throw new LifecycleMutationError("LIFECYCLE_UNAUTHORIZED");

  const [role] = await transaction
    .select({ role: platformUserRoles.role })
    .from(platformUserRoles)
    .where(
      and(
        eq(platformUserRoles.userId, userId),
        eq(platformUserRoles.role, "SUPERADMIN"),
      ),
    )
    .limit(1);
  if (!role) throw new LifecycleMutationError("LIFECYCLE_UNAUTHORIZED");
}

async function setOrganizationContext(
  transaction: OrganizationTransaction,
  organizationId: string,
): Promise<void> {
  await transaction.execute(
    sql`select set_config('app.current_organization_id', ${organizationId}, true)`,
  );
}

async function writeLifecycleAudit(
  transaction: OrganizationTransaction,
  organizationId: string,
  actorUserId: string,
  metadata: LifecycleRequestMetadata,
  action: string,
  resource: string,
  resourceId: string,
  beforeState: unknown,
  afterState: unknown,
): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId,
    actorUserId,
    action,
    resource,
    resourceId,
    result: "SUCCESS",
    requestMetadata: {
      requestId: metadata.requestId,
      correlationId: metadata.correlationId,
    },
    beforeState,
    afterState,
  });
}

async function createOrganizationRoles(
  transaction: OrganizationTransaction,
  organizationId: string,
  actorUserId: string,
  metadata: LifecycleRequestMetadata,
): Promise<Pick<typeof roles.$inferSelect, "id" | "name">> {
  const activePermissions = await transaction
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions)
    .where(eq(permissions.status, "ACTIVE"));
  const permissionByKey = new Map(
    activePermissions.map((permission) => [permission.key, permission]),
  );
  let ownerRole: Pick<typeof roles.$inferSelect, "id" | "name"> | undefined;

  for (const template of defaultOrganizationRoleTemplates) {
    await transaction.execute(sql`
      insert into roles (organization_id, name, description, is_system)
      values (
        ${organizationId},
        ${template.name},
        ${`System-managed ${template.name} role template.`},
        true
      )
    `);
    const [roleRow] = await transaction
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(
        and(
          eq(roles.organizationId, organizationId),
          eq(roles.name, template.name),
        ),
      )
      .limit(1);
    if (!roleRow)
      throw new Error(`DEFAULT_ROLE_CREATION_FAILED:${template.name}`);
    const role = z.object({ id: uuidSchema, name: z.string() }).parse(roleRow);
    if (template.name === "Organization Owner") {
      ownerRole = { id: role.id, name: role.name };
    }

    const permissionKeys =
      template.permissionKeys ?? activePermissions.map(({ key }) => key);
    for (const permissionKey of permissionKeys) {
      const permission = permissionByKey.get(permissionKey);
      if (!permission) {
        throw new Error(`DEFAULT_ROLE_PERMISSION_NOT_FOUND:${permissionKey}`);
      }
      await transaction.insert(rolePermissions).values({
        organizationId,
        roleId: role.id,
        permissionId: permission.id,
      });
      await writeLifecycleAudit(
        transaction,
        organizationId,
        actorUserId,
        metadata,
        "ROLE_PERMISSION_GRANTED",
        "role_permission",
        `${role.id}:${permission.id}`,
        null,
        {
          roleId: role.id,
          permissionId: permission.id,
          permissionKey,
          scopeType: "ORGANIZATION",
        },
      );
    }
    await writeLifecycleAudit(
      transaction,
      organizationId,
      actorUserId,
      metadata,
      "ROLE_CREATED",
      "role",
      role.id,
      null,
      { name: role.name, isSystem: true },
    );
  }

  if (!ownerRole) throw new Error("DEFAULT_OWNER_ROLE_NOT_FOUND");
  return { id: ownerRole.id, name: ownerRole.name };
}

async function resolveLifecycleUser(
  transaction: OrganizationTransaction,
  input: {
    email: string;
    displayName?: string;
    passwordHash?: string;
    newUserStatus: "ACTIVE" | "PENDING";
  },
): Promise<{ user: LifecycleUser; isNewUser: boolean }> {
  await transaction.execute(
    sql`select set_config('app.current_login_email', ${input.email}, true)`,
  );
  let [user] = await transaction
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      status: users.status,
    })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  let isNewUser = false;
  if (!user) {
    if (!input.displayName) {
      throw new LifecycleMutationError("BOOTSTRAP_OWNER_CREDENTIALS_REQUIRED");
    }
    if (input.newUserStatus === "ACTIVE" && !input.passwordHash) {
      throw new LifecycleMutationError("BOOTSTRAP_OWNER_CREDENTIALS_REQUIRED");
    }
    const candidateUserId = randomUUID();
    await transaction.execute(sql`
      insert into users (id, email, display_name, status, password_hash)
      values (
        ${candidateUserId}, ${input.email}, ${input.displayName},
        ${input.newUserStatus}, ${input.passwordHash ?? null}
      )
      on conflict (email) do nothing
    `);
    const [createdUser] = await transaction
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, candidateUserId))
      .limit(1);
    if (createdUser) {
      user = createdUser;
      isNewUser = true;
    } else {
      [user] = await transaction
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          status: users.status,
        })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
    }
    if (!user) throw new Error("USER_LIFECYCLE_IDENTITY_FAILED");
  }
  return { user, isNewUser };
}

async function createBootstrapOwner(
  transaction: OrganizationTransaction,
  organizationId: string,
  actorUserId: string,
  metadata: LifecycleRequestMetadata,
  data: z.infer<typeof organizationInputSchema>["bootstrapOwner"],
): Promise<InvitationResult> {
  const { user, isNewUser } = await resolveLifecycleUser(transaction, {
    email: data.email,
    newUserStatus: "ACTIVE",
    ...(data.displayName ? { displayName: data.displayName } : {}),
    ...(data.passwordHash ? { passwordHash: data.passwordHash } : {}),
  });
  if (user.status !== "ACTIVE") {
    throw new LifecycleMutationError("USER_NOT_ACTIVE");
  }
  // The platform-role RLS policy exposes assignments only to their user.
  await transaction.execute(
    sql`select set_config('app.current_user_id', ${user.id}, true)`,
  );
  const [platformAdmin] = await transaction
    .select({ userId: platformUserRoles.userId })
    .from(platformUserRoles)
    .where(
      and(
        eq(platformUserRoles.userId, user.id),
        eq(platformUserRoles.role, "SUPERADMIN"),
      ),
    )
    .limit(1);
  await transaction.execute(
    sql`select set_config('app.current_user_id', ${actorUserId}, true)`,
  );
  if (platformAdmin) {
    throw new LifecycleMutationError("BOOTSTRAP_OWNER_CANNOT_BE_SUPERADMIN");
  }

  const [existingMembership] = await transaction
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, user.id),
      ),
    )
    .limit(1);
  if (existingMembership) {
    throw new LifecycleMutationError("MEMBERSHIP_ALREADY_EXISTS");
  }
  const membershipId = randomUUID();
  await transaction.execute(sql`
    insert into organization_memberships (
      id, organization_id, user_id, status, branch_access_mode
    )
    values (${membershipId}, ${organizationId}, ${user.id}, 'ACTIVE', 'ALL')
    on conflict (organization_id, user_id) do nothing
  `);
  const [membership] = await transaction
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.id, membershipId))
    .limit(1);
  if (!membership) {
    throw new LifecycleMutationError("MEMBERSHIP_ALREADY_EXISTS");
  }

  if (isNewUser) {
    await writeLifecycleAudit(
      transaction,
      organizationId,
      actorUserId,
      metadata,
      "USER_CREATED",
      "user",
      user.id,
      null,
      { email: user.email, displayName: user.displayName },
    );
    await recordOutboxEvent(
      transaction,
      createDomainEvent({
        eventType: "USER_CREATED",
        organizationId,
        actorUserId,
        correlationId: metadata.correlationId,
        aggregateType: "user",
        aggregateId: user.id,
        payload: {
          userId: user.id,
          email: user.email,
          displayName: user.displayName,
        },
        metadata: { requestId: metadata.requestId },
      }),
    );
  }
  await writeLifecycleAudit(
    transaction,
    organizationId,
    actorUserId,
    metadata,
    "MEMBERSHIP_CREATED",
    "organization_membership",
    membership.id,
    null,
    { userId: user.id, status: "ACTIVE" },
  );
  return { ...user, membershipId: membership.id };
}

async function persistInvitation(
  transaction: OrganizationTransaction,
  organizationId: string,
  actorUserId: string,
  metadata: LifecycleRequestMetadata,
  data: InvitationInput,
): Promise<BootstrapOwnerResult> {
  const { user, isNewUser } = await resolveLifecycleUser(transaction, {
    ...data,
    newUserStatus: "PENDING",
  });
  const [existingMembership] = await transaction
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, user.id),
      ),
    )
    .limit(1);
  if (existingMembership) {
    throw new LifecycleMutationError("MEMBERSHIP_ALREADY_EXISTS");
  }
  const membershipId = randomUUID();
  await transaction.execute(sql`
    insert into organization_memberships (id, organization_id, user_id, status)
    values (${membershipId}, ${organizationId}, ${user.id}, 'INVITED')
    on conflict (organization_id, user_id) do nothing
  `);
  const [membership] = await transaction
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.id, membershipId))
    .limit(1);
  if (!membership) {
    throw new LifecycleMutationError("MEMBERSHIP_ALREADY_EXISTS");
  }

  if (isNewUser) {
    await writeLifecycleAudit(
      transaction,
      organizationId,
      actorUserId,
      metadata,
      "USER_CREATED",
      "user",
      user.id,
      null,
      { email: user.email, displayName: user.displayName },
    );
    await recordOutboxEvent(
      transaction,
      createDomainEvent({
        eventType: "USER_CREATED",
        organizationId,
        actorUserId,
        correlationId: metadata.correlationId,
        aggregateType: "user",
        aggregateId: user.id,
        payload: {
          userId: user.id,
          email: user.email,
          displayName: user.displayName,
        },
        metadata: { requestId: metadata.requestId },
      }),
    );
  }
  await writeLifecycleAudit(
    transaction,
    organizationId,
    actorUserId,
    metadata,
    "USER_INVITED",
    "organization_membership",
    membership.id,
    null,
    { userId: user.id, status: "INVITED" },
  );
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType: "USER_INVITED",
      organizationId,
      actorUserId,
      correlationId: metadata.correlationId,
      aggregateType: "organization_membership",
      aggregateId: membership.id,
      payload: {
        userId: user.id,
        membershipId: membership.id,
        email: user.email,
      },
      metadata: { requestId: metadata.requestId },
    }),
  );
  return { ...user, membershipId: membership.id };
}

export function createLifecycleMutationService(
  database: Database,
): LifecycleMutationService {
  return {
    async listPublicModules() {
      const available = await database
        .select({
          name: modules.key,
          displayName: modules.name,
          description: modules.description,
        })
        .from(modules)
        .where(
          and(
            eq(modules.lifecycle, "AVAILABLE"),
            eq(modules.isAvailable, true),
          ),
        )
        .orderBy(asc(modules.name));
      return available;
    },

    async submitOrganizationApplication(input, metadata) {
      const data = organizationApplicationSchema.parse(input);
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select set_config('app.organization_application_owner_email', ${data.ownerEmail}, true)`,
        );
        await transaction.execute(
          sql`select set_config('app.organization_application_slug', ${data.slug}, true)`,
        );
        const availableModules = await transaction
          .select({ key: modules.key })
          .from(modules)
          .where(
            and(
              eq(modules.lifecycle, "AVAILABLE"),
              eq(modules.isAvailable, true),
            ),
          );
        const availableModuleKeys = new Set(
          availableModules.map(({ key }) => key),
        );
        if (
          new Set(data.requestedModules).size !==
            data.requestedModules.length ||
          data.requestedModules.some((key) => !availableModuleKeys.has(key))
        ) {
          throw new TypeError("APPLICATION_MODULE_UNAVAILABLE");
        }

        const [existingSlug] = await transaction
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.slug, data.slug))
          .limit(1);
        const [existingApplication] = await transaction
          .select({ id: organizations.id })
          .from(organizations)
          .where(
            and(
              sql`lower(${organizations.profile}->'application'->>'ownerEmail') = ${data.ownerEmail}`,
              inArray(organizations.status, [
                "PENDING",
                "UNDER_REVIEW",
                "APPROVED",
                "PAYMENT_PENDING",
                "ACTIVE",
              ]),
            ),
          )
          .limit(1);
        if (existingSlug || existingApplication) {
          throw new LifecycleMutationError("APPLICATION_ALREADY_EXISTS");
        }

        const organizationId = randomUUID();
        await transaction.execute(
          sql`select set_config('app.current_organization_id', ${organizationId}, true)`,
        );
        await transaction.execute(
          sql`select set_config('app.organization_application_submission', 'true', true)`,
        );
        const profile = {
          application: {
            contactEmail: data.contactEmail,
            contactPhone: data.contactPhone,
            ...(data.website ? { website: data.website } : {}),
            ownerName: data.ownerName,
            ownerEmail: data.ownerEmail,
            countryCode: data.countryCode,
            region: data.region,
            city: data.city,
            address: data.address,
            requestedModules: data.requestedModules,
          },
        };
        const [organization] = await transaction
          .insert(organizations)
          .values({
            id: organizationId,
            name: data.name,
            slug: data.slug,
            industry: data.industry,
            status: "PENDING",
            deploymentType: data.deploymentType,
            profile,
          })
          .returning();
        if (!organization) throw new Error("ORGANIZATION_APPLICATION_FAILED");

        await transaction.insert(auditLogs).values({
          organizationId,
          action: "ORGANIZATION_APPLICATION_SUBMITTED",
          resource: "organization",
          resourceId: organizationId,
          result: "SUCCESS",
          requestMetadata: {
            requestId: metadata.requestId,
            correlationId: metadata.correlationId,
          },
          beforeState: null,
          afterState: {
            status: "PENDING",
            name: data.name,
            industry: data.industry,
            deploymentType: data.deploymentType,
          },
        });
        await recordOutboxEvent(
          transaction,
          createDomainEvent({
            eventType: "ORGANIZATION_APPLICATION_SUBMITTED",
            organizationId,
            correlationId: metadata.correlationId,
            aggregateType: "organization",
            aggregateId: organizationId,
            payload: {
              name: data.name,
              industry: data.industry,
              deploymentType: data.deploymentType,
            },
            metadata: { requestId: metadata.requestId },
          }),
        );
        return { organization };
      });
    },

    async listOrganizationApplications(actor) {
      return withAuthenticatedUserTransaction(
        database,
        actor.userId,
        async (transaction) => {
          await verifyPlatformActor(transaction, actor);
          const applications = await transaction
            .select()
            .from(organizations)
            .where(
              or(
                inArray(organizations.status, [
                  "PENDING",
                  "UNDER_REVIEW",
                  "APPROVED",
                  "REJECTED",
                ]),
                and(
                  eq(organizations.status, "ACTIVE"),
                  sql`${organizations.profile} ? 'application'`,
                ),
              ),
            )
            .orderBy(asc(organizations.createdAt));
          return applications;
        },
      );
    },

    async transitionOrganizationApplication(
      organizationId,
      status,
      actor,
      metadata,
    ) {
      const targetStatus = organizationStatusSchema.parse(status);
      const trustedOrganizationId = uuidSchema.parse(organizationId);
      return withAuthenticatedUserTransaction(
        database,
        actor.userId,
        async (transaction) => {
          await verifyPlatformActor(transaction, actor);
          await setOrganizationContext(transaction, trustedOrganizationId);
          const [organization] = await transaction
            .select()
            .from(organizations)
            .where(eq(organizations.id, trustedOrganizationId))
            .for("update")
            .limit(1);
          if (!organization) {
            throw new LifecycleMutationError("ORGANIZATION_NOT_FOUND");
          }
          if (
            !["PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED"].includes(
              organization.status,
            ) ||
            !canTransitionOrganizationStatus(organization.status, targetStatus)
          ) {
            throw new LifecycleMutationError(
              "INVALID_ORGANIZATION_STATE_TRANSITION",
            );
          }
          const [updated] = await transaction
            .update(organizations)
            .set({ status: targetStatus, updatedAt: new Date() })
            .where(
              and(
                eq(organizations.id, trustedOrganizationId),
                eq(organizations.status, organization.status),
              ),
            )
            .returning();
          if (!updated) {
            throw new LifecycleMutationError(
              "INVALID_ORGANIZATION_STATE_TRANSITION",
            );
          }
          await writeLifecycleAudit(
            transaction,
            trustedOrganizationId,
            actor.userId,
            metadata,
            "ORGANIZATION_APPLICATION_STATUS_CHANGED",
            "organization",
            trustedOrganizationId,
            { status: organization.status },
            { status: targetStatus },
          );
          await recordOutboxEvent(
            transaction,
            createDomainEvent({
              eventType: "ORGANIZATION_STATUS_CHANGED",
              organizationId: trustedOrganizationId,
              actorUserId: actor.userId,
              correlationId: metadata.correlationId,
              aggregateType: "organization",
              aggregateId: trustedOrganizationId,
              payload: {
                previousStatus: organization.status,
                status: targetStatus,
              },
              metadata: { requestId: metadata.requestId },
            }),
          );
          return updated;
        },
      );
    },

    async createOrganization(input, actor, metadata) {
      const data = organizationInputSchema.parse(input);
      return withAuthenticatedUserTransaction(
        database,
        actor.userId,
        async (transaction) => {
          await verifyPlatformActor(transaction, actor);
          const organizationId = randomUUID();
          await setOrganizationContext(transaction, organizationId);
          await transaction.execute(sql`
            insert into organizations (
              id, name, slug, industry, status, deployment_type
            ) values (
              ${organizationId}, ${data.name}, ${data.slug}, ${data.industry},
              'PENDING', ${data.deploymentType}
            )
          `);
          const [organization] = await transaction
            .select()
            .from(organizations)
            .where(eq(organizations.id, organizationId))
            .limit(1);
          if (!organization) {
            throw new Error("ORGANIZATION_CREATION_FAILED");
          }
          await setOrganizationContext(transaction, organization.id);
          const ownerRole = await createOrganizationRoles(
            transaction,
            organization.id,
            actor.userId,
            metadata,
          );
          await writeLifecycleAudit(
            transaction,
            organization.id,
            actor.userId,
            metadata,
            "ORGANIZATION_CREATED",
            "organization",
            organization.id,
            null,
            {
              name: organization.name,
              slug: organization.slug,
              industry: organization.industry,
              status: organization.status,
              deploymentType: organization.deploymentType,
            },
          );
          await recordOutboxEvent(
            transaction,
            createDomainEvent({
              eventType: "ORGANIZATION_CREATED",
              organizationId: organization.id,
              actorUserId: actor.userId,
              correlationId: metadata.correlationId,
              aggregateType: "organization",
              aggregateId: organization.id,
              payload: {
                name: organization.name,
                slug: organization.slug,
                deploymentType: organization.deploymentType,
              },
              metadata: { requestId: metadata.requestId },
            }),
          );
          const bootstrapOwner = await createBootstrapOwner(
            transaction,
            organization.id,
            actor.userId,
            metadata,
            data.bootstrapOwner,
          );
          await transaction.insert(membershipRoles).values({
            organizationId: organization.id,
            membershipId: bootstrapOwner.membershipId,
            roleId: ownerRole.id,
          });
          await writeLifecycleAudit(
            transaction,
            organization.id,
            actor.userId,
            metadata,
            "MEMBERSHIP_ROLE_ASSIGNED",
            "membership_role",
            `${bootstrapOwner.membershipId}:${ownerRole.id}`,
            null,
            {
              membershipId: bootstrapOwner.membershipId,
              roleId: ownerRole.id,
              roleName: ownerRole.name,
            },
          );
          await recordOutboxEvent(
            transaction,
            createDomainEvent({
              eventType: "USER_ROLE_CHANGED",
              organizationId: organization.id,
              actorUserId: actor.userId,
              correlationId: metadata.correlationId,
              aggregateType: "organization_membership",
              aggregateId: bootstrapOwner.membershipId,
              payload: {
                userId: bootstrapOwner.id,
                membershipId: bootstrapOwner.membershipId,
                roleId: ownerRole.id,
                change: "ASSIGNED",
              },
              metadata: { requestId: metadata.requestId },
            }),
          );
          return { organization, bootstrapOwner };
        },
      );
    },

    async activateOrganization(organizationId, actor, metadata) {
      const trustedOrganizationId = uuidSchema.parse(organizationId);
      return withAuthenticatedUserTransaction(
        database,
        actor.userId,
        async (transaction) => {
          await verifyPlatformActor(transaction, actor);
          await setOrganizationContext(transaction, trustedOrganizationId);
          const [organization] = await transaction
            .select()
            .from(organizations)
            .where(eq(organizations.id, trustedOrganizationId))
            .for("update")
            .limit(1);
          if (!organization) {
            throw new LifecycleMutationError("ORGANIZATION_NOT_FOUND");
          }
          if (
            organization.profile &&
            typeof organization.profile === "object" &&
            "application" in organization.profile
          ) {
            throw new LifecycleMutationError(
              "APPLICATION_PROVISIONING_REQUIRED",
            );
          }
          if (!canTransitionOrganizationStatus(organization.status, "ACTIVE")) {
            throw new LifecycleMutationError(
              "INVALID_ORGANIZATION_STATE_TRANSITION",
            );
          }
          const [activated] = await transaction
            .update(organizations)
            .set({ status: "ACTIVE", updatedAt: new Date() })
            .where(
              and(
                eq(organizations.id, trustedOrganizationId),
                eq(organizations.status, organization.status),
              ),
            )
            .returning();
          if (!activated) {
            throw new LifecycleMutationError(
              "INVALID_ORGANIZATION_STATE_TRANSITION",
            );
          }
          await writeLifecycleAudit(
            transaction,
            trustedOrganizationId,
            actor.userId,
            metadata,
            "ORGANIZATION_ACTIVATED",
            "organization",
            trustedOrganizationId,
            { status: organization.status },
            { status: activated.status },
          );
          await recordOutboxEvent(
            transaction,
            createDomainEvent({
              eventType: "ORGANIZATION_ACTIVATED",
              organizationId: trustedOrganizationId,
              actorUserId: actor.userId,
              correlationId: metadata.correlationId,
              aggregateType: "organization",
              aggregateId: trustedOrganizationId,
              payload: {
                previousStatus: organization.status,
                status: "ACTIVE",
              },
              metadata: { requestId: metadata.requestId },
            }),
          );
          return activated;
        },
      );
    },

    async provisionApprovedOrganizationApplication(
      organizationId,
      actor,
      metadata,
    ) {
      const trustedOrganizationId = uuidSchema.parse(organizationId);
      return withAuthenticatedUserTransaction(
        database,
        actor.userId,
        async (transaction) => {
          await verifyPlatformActor(transaction, actor);
          await setOrganizationContext(transaction, trustedOrganizationId);
          const [organization] = await transaction
            .select()
            .from(organizations)
            .where(eq(organizations.id, trustedOrganizationId))
            .for("update")
            .limit(1);
          if (!organization) {
            throw new LifecycleMutationError("ORGANIZATION_NOT_FOUND");
          }
          if (
            !organization.profile ||
            typeof organization.profile !== "object" ||
            !("application" in organization.profile)
          ) {
            throw new LifecycleMutationError("APPLICATION_NOT_FOUND");
          }
          const { application } = organizationApplicationProfileSchema.parse(
            organization.profile,
          );

          if (organization.status === "ACTIVE") {
            await transaction.execute(
              sql`select set_config('app.current_login_email', ${application.ownerEmail}, true)`,
            );
            const [existingOwner] = await transaction
              .select({
                id: users.id,
                email: users.email,
                displayName: users.displayName,
                accountStatus: users.status,
                membershipId: organizationMemberships.id,
                membershipStatus: organizationMemberships.status,
              })
              .from(users)
              .innerJoin(
                organizationMemberships,
                and(
                  eq(organizationMemberships.userId, users.id),
                  eq(
                    organizationMemberships.organizationId,
                    trustedOrganizationId,
                  ),
                ),
              )
              .innerJoin(
                membershipRoles,
                and(
                  eq(membershipRoles.organizationId, trustedOrganizationId),
                  eq(membershipRoles.membershipId, organizationMemberships.id),
                ),
              )
              .innerJoin(
                roles,
                and(
                  eq(roles.organizationId, trustedOrganizationId),
                  eq(roles.id, membershipRoles.roleId),
                  eq(roles.name, "Organization Owner"),
                ),
              )
              .where(eq(users.email, application.ownerEmail))
              .limit(1);
            const enabledModules = await transaction
              .select({ key: modules.key })
              .from(organizationModules)
              .innerJoin(modules, eq(modules.id, organizationModules.moduleId))
              .where(
                and(
                  eq(organizationModules.organizationId, trustedOrganizationId),
                  eq(organizationModules.status, "ENABLED"),
                ),
              );
            const enabledModuleKeys = enabledModules
              .map(({ key }) => key)
              .sort();
            if (
              !existingOwner ||
              application.requestedModules.some(
                (moduleKey) => !enabledModuleKeys.includes(moduleKey),
              )
            ) {
              throw new LifecycleMutationError(
                "APPLICATION_PROVISIONING_INCOMPLETE",
              );
            }
            return {
              organization,
              owner: existingOwner,
              enabledModules: enabledModuleKeys,
            };
          }
          if (organization.status !== "APPROVED") {
            throw new LifecycleMutationError("APPLICATION_NOT_APPROVED");
          }

          const requestedModuleKeys = new Set(application.requestedModules);
          const requestedModules = requestedModuleKeys.size
            ? await transaction
                .select({
                  id: modules.id,
                  key: modules.key,
                  lifecycle: modules.lifecycle,
                  isAvailable: modules.isAvailable,
                })
                .from(modules)
                .where(inArray(modules.key, [...requestedModuleKeys]))
            : [];
          if (
            requestedModules.length !== requestedModuleKeys.size ||
            requestedModules.some(
              (module) =>
                module.lifecycle !== "AVAILABLE" || !module.isAvailable,
            )
          ) {
            throw new LifecycleMutationError("APPLICATION_MODULE_UNAVAILABLE");
          }
          if (requestedModules.length > 0) {
            const requestedModuleIds = requestedModules.map(({ id }) => id);
            const dependencies = await transaction
              .select({
                moduleId: moduleDependencies.moduleId,
                dependencyModuleId: moduleDependencies.dependencyModuleId,
              })
              .from(moduleDependencies)
              .where(inArray(moduleDependencies.moduleId, requestedModuleIds));
            const allDependencies = await transaction
              .select({ id: modules.id, key: modules.key })
              .from(modules)
              .where(
                inArray(
                  modules.id,
                  dependencies.map(
                    ({ dependencyModuleId }) => dependencyModuleId,
                  ),
                ),
              );
            const dependencyKeysById = new Map(
              allDependencies.map(({ id, key }) => [id, key]),
            );
            if (
              dependencies.some(({ dependencyModuleId }) => {
                const dependencyKey =
                  dependencyKeysById.get(dependencyModuleId);
                return (
                  !dependencyKey || !requestedModuleKeys.has(dependencyKey)
                );
              })
            ) {
              throw new LifecycleMutationError(
                "APPLICATION_MODULE_DEPENDENCY_UNSATISFIED",
              );
            }
          }

          await setOrganizationContext(transaction, trustedOrganizationId);
          const ownerRole = await createOrganizationRoles(
            transaction,
            trustedOrganizationId,
            actor.userId,
            metadata,
          );
          const owner = await persistInvitation(
            transaction,
            trustedOrganizationId,
            actor.userId,
            metadata,
            {
              email: application.ownerEmail,
              displayName: application.ownerName,
            },
          );
          await transaction.execute(
            sql`select set_config('app.current_user_id', ${owner.id}, true)`,
          );
          const [platformOwner] = await transaction
            .select({ userId: platformUserRoles.userId })
            .from(platformUserRoles)
            .where(
              and(
                eq(platformUserRoles.userId, owner.id),
                eq(platformUserRoles.role, "SUPERADMIN"),
              ),
            )
            .limit(1);
          await transaction.execute(
            sql`select set_config('app.current_user_id', ${actor.userId}, true)`,
          );
          if (platformOwner) {
            throw new LifecycleMutationError(
              "APPLICATION_OWNER_CANNOT_BE_SUPERADMIN",
            );
          }

          await transaction.insert(membershipRoles).values({
            organizationId: trustedOrganizationId,
            membershipId: owner.membershipId,
            roleId: ownerRole.id,
          });
          await writeLifecycleAudit(
            transaction,
            trustedOrganizationId,
            actor.userId,
            metadata,
            "MEMBERSHIP_ROLE_ASSIGNED",
            "membership_role",
            `${owner.membershipId}:${ownerRole.id}`,
            null,
            {
              membershipId: owner.membershipId,
              roleId: ownerRole.id,
              roleName: ownerRole.name,
            },
          );
          await recordOutboxEvent(
            transaction,
            createDomainEvent({
              eventType: "USER_ROLE_CHANGED",
              organizationId: trustedOrganizationId,
              actorUserId: actor.userId,
              correlationId: metadata.correlationId,
              aggregateType: "membership_role",
              aggregateId: owner.membershipId,
              payload: {
                userId: owner.id,
                membershipId: owner.membershipId,
                roleId: ownerRole.id,
                change: "ASSIGNED",
              },
              metadata: { requestId: metadata.requestId },
            }),
          );

          for (const module of requestedModules) {
            const [enabled] = await transaction
              .insert(organizationModules)
              .values({
                organizationId: trustedOrganizationId,
                moduleId: module.id,
                status: "ENABLED",
                source: "MANUAL",
                enabledAt: new Date(),
              })
              .returning({ id: organizationModules.id });
            if (!enabled) {
              throw new LifecycleMutationError(
                "APPLICATION_PROVISIONING_INCOMPLETE",
              );
            }
            await writeLifecycleAudit(
              transaction,
              trustedOrganizationId,
              actor.userId,
              metadata,
              "MODULE_ENABLED",
              "module_entitlement",
              enabled.id,
              null,
              { moduleKey: module.key, source: "MANUAL" },
            );
            await recordOutboxEvent(
              transaction,
              createDomainEvent({
                eventType: "MODULE_ENABLED",
                organizationId: trustedOrganizationId,
                actorUserId: actor.userId,
                correlationId: metadata.correlationId,
                aggregateType: "module_entitlement",
                aggregateId: enabled.id,
                payload: { moduleKey: module.key, source: "MANUAL" },
                metadata: { requestId: metadata.requestId },
              }),
            );
          }

          const now = new Date();
          const [activated] = await transaction
            .update(organizations)
            .set({ status: "ACTIVE", updatedAt: now })
            .where(
              and(
                eq(organizations.id, trustedOrganizationId),
                eq(organizations.status, "APPROVED"),
              ),
            )
            .returning();
          if (!activated) {
            throw new LifecycleMutationError("APPLICATION_NOT_APPROVED");
          }
          await writeLifecycleAudit(
            transaction,
            trustedOrganizationId,
            actor.userId,
            metadata,
            "ORGANIZATION_ACTIVATED",
            "organization",
            trustedOrganizationId,
            { status: organization.status },
            {
              status: activated.status,
              ownerMembershipId: owner.membershipId,
              enabledModules: application.requestedModules,
            },
          );
          await recordOutboxEvent(
            transaction,
            createDomainEvent({
              eventType: "ORGANIZATION_ACTIVATED",
              organizationId: trustedOrganizationId,
              actorUserId: actor.userId,
              correlationId: metadata.correlationId,
              aggregateType: "organization",
              aggregateId: trustedOrganizationId,
              payload: {
                previousStatus: organization.status,
                status: "ACTIVE",
              },
              metadata: { requestId: metadata.requestId },
            }),
          );

          return {
            organization: activated,
            owner: {
              id: owner.id,
              membershipId: owner.membershipId,
              email: owner.email,
              displayName: owner.displayName,
              accountStatus: owner.status,
              membershipStatus: "INVITED" as const,
            },
            enabledModules: [...requestedModuleKeys].sort(),
          };
        },
      );
    },

    createUser(transaction, organizationId, actorUserId, metadata, input) {
      return createUser(
        transaction,
        organizationId,
        actorUserId,
        metadata,
        input,
      );
    },

    inviteUser(transaction, organizationId, actorUserId, metadata, input) {
      return inviteUser(
        transaction,
        organizationId,
        actorUserId,
        metadata,
        input,
      );
    },
  };
}

export async function createUser(
  transaction: OrganizationTransaction,
  organizationId: string,
  actorUserId: string,
  metadata: LifecycleRequestMetadata,
  input: unknown,
): Promise<{
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
}> {
  const trustedOrganizationId = uuidSchema.parse(organizationId);
  const trustedActorUserId = uuidSchema.parse(actorUserId);
  const data = userInputSchema.parse(input);
  const [organization] = await transaction
    .select({ id: organizations.id, status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, trustedOrganizationId))
    .limit(1);
  if (!organization) {
    throw new LifecycleMutationError("ORGANIZATION_NOT_FOUND");
  }
  if (organization.status !== "ACTIVE") {
    throw new LifecycleMutationError("ORGANIZATION_NOT_ACTIVE");
  }
  await transaction.execute(
    sql`select set_config('app.current_login_email', ${data.email}, true)`,
  );
  const userId = randomUUID();
  await transaction.execute(sql`
    insert into users (id, email, display_name, status, password_hash)
    values (
      ${userId}, ${data.email}, ${data.displayName}, 'ACTIVE',
      ${data.passwordHash}
    )
    on conflict (email) do nothing
  `);
  const [user] = await transaction
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new LifecycleMutationError("USER_ALREADY_EXISTS");
  const membershipId = randomUUID();
  await transaction.execute(sql`
    insert into organization_memberships (id, organization_id, user_id, status)
    values (${membershipId}, ${trustedOrganizationId}, ${user.id}, 'ACTIVE')
    on conflict (organization_id, user_id) do nothing
  `);
  const [membership] = await transaction
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.id, membershipId))
    .limit(1);
  if (!membership) {
    throw new LifecycleMutationError("MEMBERSHIP_ALREADY_EXISTS");
  }
  await writeLifecycleAudit(
    transaction,
    trustedOrganizationId,
    trustedActorUserId,
    metadata,
    "USER_CREATED",
    "user",
    user.id,
    null,
    { email: user.email, displayName: user.displayName },
  );
  await recordOutboxEvent(
    transaction,
    createDomainEvent({
      eventType: "USER_CREATED",
      organizationId: trustedOrganizationId,
      actorUserId: trustedActorUserId,
      correlationId: metadata.correlationId,
      aggregateType: "user",
      aggregateId: user.id,
      payload: {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
      },
      metadata: { requestId: metadata.requestId },
    }),
  );
  return { ...user, organizationId: trustedOrganizationId };
}

export async function inviteUser(
  transaction: OrganizationTransaction,
  organizationId: string,
  actorUserId: string,
  metadata: LifecycleRequestMetadata,
  input: unknown,
): Promise<InvitationResult> {
  const trustedOrganizationId = uuidSchema.parse(organizationId);
  const trustedActorUserId = uuidSchema.parse(actorUserId);
  const data = invitationInputSchema.parse(input);
  const [organization] = await transaction
    .select({ id: organizations.id, status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, trustedOrganizationId))
    .limit(1);
  if (!organization) {
    throw new LifecycleMutationError("ORGANIZATION_NOT_FOUND");
  }
  if (organization.status !== "ACTIVE") {
    throw new LifecycleMutationError("ORGANIZATION_NOT_ACTIVE");
  }
  return persistInvitation(
    transaction,
    trustedOrganizationId,
    trustedActorUserId,
    metadata,
    data,
  );
}
