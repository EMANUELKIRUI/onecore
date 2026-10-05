CREATE TYPE "permission_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "role_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
ALTER TYPE "data_scope_type" ADD VALUE 'OWN' BEFORE 'CUSTOM';--> statement-breakpoint
ALTER TYPE "data_scope_type" ADD VALUE 'ASSIGNED' BEFORE 'CUSTOM';--> statement-breakpoint
ALTER TABLE "permissions" ADD COLUMN "resource_key" varchar(50);--> statement-breakpoint
ALTER TABLE "permissions" ADD COLUMN "action_key" varchar(50);--> statement-breakpoint
ALTER TABLE "permissions" ADD COLUMN "status" "permission_status" DEFAULT 'ACTIVE'::"permission_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "permissions" ADD COLUMN "is_system" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "scope_type" "data_scope_type" DEFAULT 'ORGANIZATION'::"data_scope_type" NOT NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD COLUMN "scope" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "status" "role_status" DEFAULT 'ACTIVE'::"role_status" NOT NULL;--> statement-breakpoint
UPDATE "permissions" SET "module_key" = coalesce("module_key", 'core');--> statement-breakpoint
UPDATE "permissions" SET
  "resource_key" = split_part(
    CASE WHEN substring("key" FROM 1 FOR char_length("module_key") + 1) = "module_key" || '.'
      THEN substring("key" FROM char_length("module_key") + 2)
      ELSE "key"
    END,
    '.',
    1
  ),
  "action_key" = reverse(split_part(reverse(
    CASE WHEN substring("key" FROM 1 FOR char_length("module_key") + 1) = "module_key" || '.'
      THEN substring("key" FROM char_length("module_key") + 2)
      ELSE "key"
    END
  ), '.', 1));--> statement-breakpoint
UPDATE "permissions" SET "key" = "module_key" || '.' || "resource_key" || '.' || "action_key";--> statement-breakpoint
ALTER TABLE "permissions" ALTER COLUMN "module_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "permissions" ALTER COLUMN "resource_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "permissions" ALTER COLUMN "action_key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_module_resource_action_unique" ON "permissions" ("module_key","resource_key","action_key");--> statement-breakpoint
CREATE INDEX "permissions_module_status_idx" ON "permissions" ("module_key","status");--> statement-breakpoint
CREATE INDEX "roles_organization_status_idx" ON "roles" ("organization_id","status");--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_key_canonical" CHECK ("key" = "module_key" || '.' || "resource_key" || '.' || "action_key" AND "module_key" ~ '^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$' AND "resource_key" ~ '^[a-z][a-z0-9_-]*$' AND "action_key" ~ '^[a-z][a-z0-9_-]*$');--> statement-breakpoint
INSERT INTO "permissions" ("key", "module_key", "resource_key", "action_key", "description", "status", "is_system") VALUES
('core.organization.organization.read', 'core.organization', 'organization', 'read', 'Read the current organization profile.', 'ACTIVE', true),
('core.organization.organization.update', 'core.organization', 'organization', 'update', 'Update organization profile settings.', 'ACTIVE', true),
('core.organization.user.read', 'core.organization', 'user', 'read', 'Read organization memberships.', 'ACTIVE', true),
('core.organization.user.create', 'core.organization', 'user', 'create', 'Create organization memberships.', 'ACTIVE', true),
('core.organization.user.update', 'core.organization', 'user', 'update', 'Update organization memberships.', 'ACTIVE', true),
('core.organization.settings.read', 'core.organization', 'settings', 'read', 'Read organization settings.', 'ACTIVE', true),
('core.organization.settings.update', 'core.organization', 'settings', 'update', 'Update organization settings.', 'ACTIVE', true),
('core.rbac.organization_owner.manage', 'core.rbac', 'organization_owner', 'manage', 'Reserved capability maintained only by trusted organization provisioning.', 'ACTIVE', true),
('core.rbac.role.read', 'core.rbac', 'role', 'read', 'Read organization roles.', 'ACTIVE', true),
('core.rbac.role.create', 'core.rbac', 'role', 'create', 'Create organization roles.', 'ACTIVE', true),
('core.rbac.role.update', 'core.rbac', 'role', 'update', 'Update organization roles.', 'ACTIVE', true),
('core.rbac.role.disable', 'core.rbac', 'role', 'disable', 'Disable organization roles.', 'ACTIVE', true),
('core.rbac.permission.read', 'core.rbac', 'permission', 'read', 'Read the active permission catalog.', 'ACTIVE', true),
('core.rbac.role_permission.assign', 'core.rbac', 'role_permission', 'assign', 'Grant permissions to organization roles.', 'ACTIVE', true),
('core.rbac.role_permission.revoke', 'core.rbac', 'role_permission', 'revoke', 'Revoke permissions from organization roles.', 'ACTIVE', true),
('core.rbac.membership_role.assign', 'core.rbac', 'membership_role', 'assign', 'Assign organization roles to memberships.', 'ACTIVE', true),
('core.rbac.membership_role.remove', 'core.rbac', 'membership_role', 'remove', 'Remove organization roles from memberships.', 'ACTIVE', true),
('sales.sale.create', 'sales', 'sale', 'create', 'create sale records in the sales module.', 'ACTIVE', true),
('sales.sale.read', 'sales', 'sale', 'read', 'read sale records in the sales module.', 'ACTIVE', true),
('sales.sale.update', 'sales', 'sale', 'update', 'update sale records in the sales module.', 'ACTIVE', true),
('sales.sale.delete', 'sales', 'sale', 'delete', 'delete sale records in the sales module.', 'ACTIVE', true),
('inventory.product.create', 'inventory', 'product', 'create', 'create product records in the inventory module.', 'ACTIVE', true),
('inventory.product.read', 'inventory', 'product', 'read', 'read product records in the inventory module.', 'ACTIVE', true),
('inventory.product.update', 'inventory', 'product', 'update', 'update product records in the inventory module.', 'ACTIVE', true),
('inventory.product.delete', 'inventory', 'product', 'delete', 'delete product records in the inventory module.', 'ACTIVE', true),
('inventory.stock.adjust', 'inventory', 'stock', 'adjust', 'adjust stock records in the inventory module.', 'ACTIVE', true),
('customers.customer.create', 'customers', 'customer', 'create', 'create customer records in the customers module.', 'ACTIVE', true),
('customers.customer.read', 'customers', 'customer', 'read', 'read customer records in the customers module.', 'ACTIVE', true),
('reports.sales.read', 'reports', 'sales', 'read', 'read sales records in the reports module.', 'ACTIVE', true)
ON CONFLICT ("module_key", "resource_key", "action_key") DO NOTHING;