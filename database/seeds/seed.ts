import { and, eq } from "drizzle-orm";
import { Algorithm, hash as hashPassword } from "@node-rs/argon2";
import {
  defaultOrganizationRoleTemplates,
  moduleManifestSchema,
  permissionCatalog,
  roleAdministrationPermissionKeys,
} from "@onecore/core-domain";
import { createDatabase } from "../src/index.js";
import {
  withAuthenticatedUserTransaction,
  withLoginTransaction,
  withOrganizationTransaction,
} from "../src/tenant-context.js";
import {
  businessSettings,
  branches,
  auditLogs,
  featureFlagAssignments,
  featureFlags,
  features,
  membershipRoles,
  modules,
  modulePermissions,
  moduleVersions,
  notificationConfigurations,
  organizationBranding,
  organizationFeatures,
  organizationMemberships,
  organizationModules,
  organizationSettings,
  organizations,
  permissions,
  platformUserRoles,
  planFeatures,
  planModules,
  plans,
  rolePermissions,
  roles,
  subscriptionItems,
  subscriptions,
  users,
} from "../schema/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to seed the development database");
}
if (process.env.NODE_ENV === "production") {
  throw new Error("Development seed data cannot be applied in production");
}
if (process.env.ONECORE_ALLOW_DEMO_SEED !== "YES") {
  throw new Error(
    "Set ONECORE_ALLOW_DEMO_SEED=YES to confirm this is a local development database",
  );
}
const developmentPassword = process.env.ONECORE_DEMO_PASSWORD;
if (developmentPassword && developmentPassword.length < 16) {
  throw new Error("ONECORE_DEMO_PASSWORD must be at least 16 characters");
}
const developmentPasswordHash = developmentPassword
  ? await hashPassword(developmentPassword, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    })
  : undefined;

const { db, close } = createDatabase(databaseUrl);

const demos = [
  {
    name: "Demo Retail Ltd",
    slug: "demo-retail",
    industry: "RETAIL",
    deploymentType: "SAAS" as const,
    branch: { name: "Nairobi Main", code: "NBO-MAIN" },
    email: "owner@demo-retail.example",
    locale: "en",
  },
  {
    name: "Demo Hotel Ltd",
    slug: "demo-hotel",
    industry: "HOSPITALITY",
    deploymentType: "CUSTOM" as const,
    branch: { name: "Mombasa Beach", code: "MBA-BEACH" },
    email: "owner@demo-hotel.example",
    locale: "sw",
  },
  {
    name: "Demo School Ltd",
    slug: "demo-school",
    industry: "EDUCATION",
    deploymentType: "ENTERPRISE" as const,
    branch: { name: "Kisumu Campus", code: "KSM-CAMPUS" },
    email: "owner@demo-school.example",
    locale: "en",
  },
];

const moduleDefinitions = [
  {
    key: "core.organization",
    name: "Organization Administration",
    features: [
      { key: "branding", name: "Organization Branding" },
      { key: "custom-fields", name: "Custom Fields" },
    ],
  },
  {
    key: "core.configuration",
    name: "Platform Configuration",
    features: [{ key: "multi-branch", name: "Multi-branch Configuration" }],
  },
  {
    key: "core.rbac",
    name: "Role-Based Access Control",
    features: [],
  },
  {
    key: "core.modules",
    name: "Module Registry and Entitlements",
    features: [],
  },
  {
    key: "core.business_manager",
    name: "Business Manager",
    features: [],
  },
  {
    key: "sales",
    name: "Sales & POS",
    features: [],
  },
];

try {
  const [platformAdmin] = await withLoginTransaction(
    db,
    "platform-admin@example.test",
    (transaction) =>
      transaction
        .insert(users)
        .values({
          email: "platform-admin@example.test",
          displayName: "Development Platform Superadmin",
          status: "ACTIVE",
          ...(developmentPasswordHash
            ? { passwordHash: developmentPasswordHash }
            : {}),
        })
        .onConflictDoUpdate({
          target: users.email,
          set: {
            displayName: "Development Platform Superadmin",
            ...(developmentPasswordHash
              ? { passwordHash: developmentPasswordHash }
              : {}),
          },
        })
        .returning(),
  );
  const [multiOrganizationUser] = await withLoginTransaction(
    db,
    "multi-organization@example.test",
    (transaction) =>
      transaction
        .insert(users)
        .values({
          email: "multi-organization@example.test",
          displayName: "Development Multi-Organization User",
          status: "ACTIVE",
          ...(developmentPasswordHash
            ? { passwordHash: developmentPasswordHash }
            : {}),
        })
        .onConflictDoUpdate({
          target: users.email,
          set: {
            displayName: "Development Multi-Organization User",
            ...(developmentPasswordHash
              ? { passwordHash: developmentPasswordHash }
              : {}),
          },
        })
        .returning(),
  );
  if (!platformAdmin || !multiOrganizationUser) {
    throw new Error(
      "Development identity seed could not create platform users",
    );
  }
  await withAuthenticatedUserTransaction(
    db,
    platformAdmin.id,
    async (transaction) => {
      await transaction
        .insert(platformUserRoles)
        .values({ userId: platformAdmin.id, role: "SUPERADMIN" })
        .onConflictDoNothing();
    },
  );

  for (const moduleDefinition of moduleDefinitions) {
    await db
      .insert(modules)
      .values({
        key: moduleDefinition.key,
        name: moduleDefinition.name,
        lifecycle: "AVAILABLE",
        isAvailable: true,
      })
      .onConflictDoUpdate({
        target: modules.key,
        set: {
          name: moduleDefinition.name,
          lifecycle: "AVAILABLE",
          isAvailable: true,
          updatedAt: new Date(),
        },
      });
  }

  const allModules = await db.select().from(modules);
  const moduleByKey = new Map(allModules.map((module) => [module.key, module]));
  const featureByKey = new Map<string, typeof features.$inferSelect>();

  for (const moduleDefinition of moduleDefinitions) {
    const module = moduleByKey.get(moduleDefinition.key);
    if (!module) {
      throw new Error(
        `Seed module was not available after insert: ${moduleDefinition.key}`,
      );
    }
    for (const feature of moduleDefinition.features) {
      await db
        .insert(features)
        .values({
          moduleId: module.id,
          key: feature.key,
          name: feature.name,
        })
        .onConflictDoNothing({ target: [features.moduleId, features.key] });
    }
  }

  const allFeatures = await db.select().from(features);
  for (const feature of allFeatures) {
    const parentModule = allModules.find(
      (module) => module.id === feature.moduleId,
    );
    if (parentModule)
      featureByKey.set(`${parentModule.key}:${feature.key}`, feature);
  }

  for (const permission of permissionCatalog) {
    await db
      .insert(permissions)
      .values({
        key: permission.key,
        moduleKey: permission.module,
        resourceKey: permission.resource,
        actionKey: permission.action,
        description: permission.description,
        isSystem: true,
      })
      .onConflictDoUpdate({
        target: [
          permissions.moduleKey,
          permissions.resourceKey,
          permissions.actionKey,
        ],
        set: { description: permission.description },
      });
  }

  for (const moduleDefinition of moduleDefinitions) {
    const module = moduleByKey.get(moduleDefinition.key);
    if (!module) {
      throw new Error(`Seed module was not found: ${moduleDefinition.key}`);
    }
    const manifest = moduleManifestSchema.parse({
      name: moduleDefinition.key,
      version: "1.0.0",
      displayName: moduleDefinition.name,
      dependencies: [],
      permissions: permissionCatalog
        .filter((permission) => permission.module === moduleDefinition.key)
        .map((permission) => permission.key),
      features: moduleDefinition.features.map(({ key }) => key),
      lifecycle: "AVAILABLE",
    });
    await db
      .insert(moduleVersions)
      .values({
        moduleId: module.id,
        version: manifest.version,
        status: manifest.lifecycle,
        manifest,
      })
      .onConflictDoUpdate({
        target: [moduleVersions.moduleId, moduleVersions.version],
        set: { status: manifest.lifecycle, manifest },
      });
    for (const permission of permissionCatalog.filter(
      (candidate) => candidate.module === moduleDefinition.key,
    )) {
      const [catalogPermission] = await db
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.key, permission.key))
        .limit(1);
      if (!catalogPermission) {
        throw new Error(`Seed permission was not found: ${permission.key}`);
      }
      await db
        .insert(modulePermissions)
        .values({
          moduleId: module.id,
          permissionId: catalogPermission.id,
        })
        .onConflictDoNothing();
    }
  }

  await db
    .insert(featureFlags)
    .values([
      {
        key: "ENABLE_ORGANIZATION_BRANDING",
        description: "Allow organization-managed white-label branding.",
      },
      {
        key: "ENABLE_CUSTOM_FIELDS",
        description: "Allow organization-managed custom field definitions.",
      },
    ])
    .onConflictDoNothing({ target: featureFlags.key });
  const flagRows = await db.select().from(featureFlags);

  await db
    .insert(plans)
    .values({
      key: "foundation-monthly",
      name: "Foundation Monthly",
      billingInterval: "MONTHLY",
      currencyCode: "KES",
      amount: "0.000000",
    })
    .onConflictDoNothing({ target: plans.key });

  const [plan] = await db
    .select()
    .from(plans)
    .where(eq(plans.key, "foundation-monthly"));
  if (!plan) throw new Error("Seed plan was not available after insert");

  for (const module of allModules) {
    await db
      .insert(planModules)
      .values({ planId: plan.id, moduleId: module.id })
      .onConflictDoNothing();
  }
  for (const feature of allFeatures) {
    await db
      .insert(planFeatures)
      .values({ planId: plan.id, featureId: feature.id })
      .onConflictDoNothing();
  }

  for (const demo of demos) {
    await db
      .insert(organizations)
      .values({
        name: demo.name,
        slug: demo.slug,
        industry: demo.industry,
        status: "ACTIVE",
        deploymentType: demo.deploymentType,
      })
      .onConflictDoNothing({ target: organizations.slug });

    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, demo.slug));
    if (!organization) {
      throw new Error(
        `Seed organization was not available after insert: ${demo.slug}`,
      );
    }

    const [user] = await withLoginTransaction(db, demo.email, (transaction) =>
      transaction
        .insert(users)
        .values({
          email: demo.email,
          displayName: `${demo.name} Owner`,
          ...(developmentPasswordHash
            ? { passwordHash: developmentPasswordHash }
            : {}),
        })
        .onConflictDoUpdate({
          target: users.email,
          set: {
            displayName: `${demo.name} Owner`,
            ...(developmentPasswordHash
              ? { passwordHash: developmentPasswordHash }
              : {}),
          },
        })
        .returning(),
    );
    if (!user) throw new Error(`Seed user could not be created: ${demo.email}`);

    await withOrganizationTransaction(
      db,
      organization.id,
      async (transaction) => {
        await transaction
          .insert(branches)
          .values({
            organizationId: organization.id,
            name: demo.branch.name,
            code: demo.branch.code,
          })
          .onConflictDoNothing({
            target: [branches.organizationId, branches.code],
          });

        const [membership] = await transaction
          .insert(organizationMemberships)
          .values({
            organizationId: organization.id,
            userId: user.id,
            status: "ACTIVE",
            branchAccessMode: "ALL",
          })
          .onConflictDoUpdate({
            target: [
              organizationMemberships.organizationId,
              organizationMemberships.userId,
            ],
            set: { status: "ACTIVE", branchAccessMode: "ALL" },
          })
          .returning();
        if (!membership)
          throw new Error(`Membership was not created for ${demo.slug}`);

        await transaction
          .insert(organizationMemberships)
          .values({
            organizationId: organization.id,
            userId: multiOrganizationUser.id,
            status: "ACTIVE",
          })
          .onConflictDoNothing({
            target: [
              organizationMemberships.organizationId,
              organizationMemberships.userId,
            ],
          });

        const seededRoles = new Map<string, typeof roles.$inferSelect>();
        for (const template of defaultOrganizationRoleTemplates) {
          const [role] = await transaction
            .insert(roles)
            .values({
              organizationId: organization.id,
              name: template.name,
              description: `System-managed ${template.name} role template.`,
              isSystem: true,
            })
            .onConflictDoUpdate({
              target: [roles.organizationId, roles.name],
              set: {
                description: `System-managed ${template.name} role template.`,
              },
            })
            .returning();
          if (!role)
            throw new Error(
              `Default role was not created for ${demo.slug}: ${template.name}`,
            );
          seededRoles.set(template.name, role);
        }

        const allPermissions = await transaction.select().from(permissions);
        for (const template of defaultOrganizationRoleTemplates) {
          const role = seededRoles.get(template.name);
          if (!role) {
            throw new Error(`Default role is missing: ${template.name}`);
          }
          const permissionKeys =
            template.permissionKeys ?? allPermissions.map(({ key }) => key);
          for (const permissionKey of permissionKeys) {
            const [permission] = await transaction
              .select()
              .from(permissions)
              .where(eq(permissions.key, permissionKey));
            if (!permission)
              throw new Error(
                `Seed permission was not found: ${permissionKey}`,
              );

            const [assignment] = await transaction
              .insert(rolePermissions)
              .values({
                organizationId: organization.id,
                roleId: role.id,
                permissionId: permission.id,
              })
              .onConflictDoNothing()
              .returning({ permissionId: rolePermissions.permissionId });
            if (assignment) {
              await transaction.insert(auditLogs).values({
                organizationId: organization.id,
                action: "role.permission.granted",
                resource: "role_permission",
                resourceId: `${role.id}:${permission.id}`,
                result: "SUCCESS",
                requestMetadata: {
                  source: "trusted_development_seed",
                  permissionKey: permission.key,
                  scopeType: "ORGANIZATION",
                },
              });
            }
          }
        }

        const ownerRole = seededRoles.get("Organization Owner");
        if (!ownerRole) throw new Error("Default owner role is missing");
        const [ownerAssignment] = await transaction
          .insert(membershipRoles)
          .values({
            organizationId: organization.id,
            membershipId: membership.id,
            roleId: ownerRole.id,
          })
          .onConflictDoNothing()
          .returning({ roleId: membershipRoles.roleId });
        if (ownerAssignment) {
          await transaction.insert(auditLogs).values({
            organizationId: organization.id,
            action: "membership.role.assigned",
            resource: "membership_role",
            resourceId: `${membership.id}:${ownerAssignment.roleId}`,
            result: "SUCCESS",
            requestMetadata: {
              source: "trusted_development_seed",
              userId: user.id,
            },
          });
        }

        const adminRole = seededRoles.get("Organization Admin");
        if (!adminRole)
          throw new Error("Default administrator role is missing");
        const adminMembershipPermissions = new Set<string>(
          roleAdministrationPermissionKeys,
        );
        for (const key of [
          "core.organization.organization.read",
          "core.organization.organization.update",
          "core.organization.user.read",
          "core.organization.user.create",
          "core.organization.user.update",
          "core.organization.branch.read",
          "core.organization.branch.create",
          "core.organization.branch.update",
          "core.organization.settings.read",
          "core.organization.settings.update",
          "core.business_manager.customer.read",
          "core.business_manager.customer.create",
          "core.business_manager.customer.update",
          "core.business_manager.customer.delete",
          "core.business_manager.catalog.read",
          "core.business_manager.catalog.create",
          "core.business_manager.catalog.update",
          "core.business_manager.catalog.delete",
        ]) {
          adminMembershipPermissions.add(key);
        }
        for (const key of adminMembershipPermissions) {
          const permission = allPermissions.find((item) => item.key === key);
          if (!permission)
            throw new Error(`Seed permission was not found: ${key}`);
          await transaction
            .insert(rolePermissions)
            .values({
              organizationId: organization.id,
              roleId: adminRole.id,
              permissionId: permission.id,
            })
            .onConflictDoNothing();
        }

        for (const moduleKey of [
          "core.organization",
          "core.rbac",
          "core.modules",
          "core.business_manager",
        ]) {
          const module = moduleByKey.get(moduleKey);
          if (!module)
            throw new Error(`Required core module is missing: ${moduleKey}`);
          await transaction
            .insert(organizationModules)
            .values({
              organizationId: organization.id,
              moduleId: module.id,
              status: "ENABLED",
              source: "MANUAL",
              enabledAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                organizationModules.organizationId,
                organizationModules.moduleId,
              ],
              set: { status: "ENABLED", enabledAt: new Date() },
            });
        }

        for (const featureKey of ["branding", "custom-fields"]) {
          const feature = featureByKey.get(`core.organization:${featureKey}`);
          if (!feature)
            throw new Error(`Seed feature was not found: ${featureKey}`);
          await transaction
            .insert(organizationFeatures)
            .values({
              organizationId: organization.id,
              featureId: feature.id,
              enabled: true,
              source: "MANUAL",
            })
            .onConflictDoUpdate({
              target: [
                organizationFeatures.organizationId,
                organizationFeatures.featureId,
              ],
              set: { enabled: true },
            });
        }

        for (const flag of flagRows) {
          await transaction
            .insert(featureFlagAssignments)
            .values({
              flagId: flag.id,
              scope: "ORGANIZATION",
              scopeKey: "ORGANIZATION",
              organizationId: organization.id,
              enabled: true,
            })
            .onConflictDoNothing();
        }

        await transaction
          .insert(organizationSettings)
          .values({
            organizationId: organization.id,
            countryCode: "KE",
            currencyCode: "KES",
            timezone: "Africa/Nairobi",
            locale: demo.locale,
          })
          .onConflictDoNothing();

        await transaction
          .insert(businessSettings)
          .values({ organizationId: organization.id, legalName: demo.name })
          .onConflictDoNothing();

        await transaction
          .insert(organizationBranding)
          .values({
            organizationId: organization.id,
            primaryColor: "#14532D",
            secondaryColor: "#FACC15",
          })
          .onConflictDoNothing();

        await transaction
          .insert(notificationConfigurations)
          .values({ organizationId: organization.id })
          .onConflictDoNothing();

        const [existingSubscription] = await transaction
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.organizationId, organization.id))
          .limit(1);
        const [subscription] = existingSubscription
          ? [existingSubscription]
          : await transaction
              .insert(subscriptions)
              .values({
                organizationId: organization.id,
                status: "ACTIVE",
              })
              .returning();
        if (!subscription) {
          throw new Error(
            `Seed subscription was not available for ${demo.slug}`,
          );
        }

        const [existingPlanItem] = await transaction
          .select()
          .from(subscriptionItems)
          .where(
            and(
              eq(subscriptionItems.organizationId, organization.id),
              eq(subscriptionItems.subscriptionId, subscription.id),
              eq(subscriptionItems.planId, plan.id),
            ),
          )
          .limit(1);
        if (!existingPlanItem) {
          await transaction.insert(subscriptionItems).values({
            organizationId: organization.id,
            subscriptionId: subscription.id,
            planId: plan.id,
            amount: plan.amount,
            currencyCode: plan.currencyCode,
          });
        }
      },
    );
  }
  if (!developmentPasswordHash) {
    console.info(
      "Development identities were created without credentials. Set ONECORE_DEMO_PASSWORD (16+ characters) before reseeding to enable local login.",
    );
  } else {
    console.info(
      "Development identities have local Argon2id credentials. Do not reuse this password outside development.",
    );
  }
} finally {
  await close();
}
