import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  auditResults,
  branchStatuses,
  billingIntervals,
  customDevelopmentStatuses,
  customDomainVerificationStatuses,
  customFieldTypes,
  dataScopeTypes,
  deploymentTypes,
  entitlementSources,
  featureFlagTypes,
  customFieldStatuses,
  membershipStatuses,
  membershipBranchAccessModes,
  moduleLifecycles,
  organizationModuleStatuses,
  organizationStatuses,
  outboxStatuses,
  inventoryMovementTypes,
  inventoryReservationStatuses,
  saleStatuses,
  type EventDeliveryStatus,
  type EventFailureKind,
  type EventProcessingStatus,
  type WorkflowActionStatus,
  type WorkflowExecutionStatus,
  type WebhookAttemptStatus,
  type WebhookDeliveryStatus,
  type WebhookSubscriptionStatus,
  communicationChannels,
  type CommunicationAttemptStatus,
  type CommunicationStatus,
  type CommunicationTemplateStatus,
  permissionStatuses,
  roleStatuses,
  sslStatuses,
  subscriptionStatuses,
  userAccountStatuses,
  workflowStatuses,
  workflowVersionStatuses,
  type FeatureFlagScope,
  jobStatuses,
  notificationChannels,
  notificationDeliveryStatuses,
  storedObjectProviders,
  storedObjectStatuses,
} from "@onecore/core-domain";
import { sql } from "drizzle-orm";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const jsonObject = (name: string) =>
  jsonb(name).$type<Record<string, unknown>>().notNull().default({});

export const organizationStatus = pgEnum(
  "organization_status",
  organizationStatuses,
);
export const deploymentType = pgEnum("deployment_type", deploymentTypes);
export const membershipStatus = pgEnum("membership_status", membershipStatuses);
export const branchStatus = pgEnum("branch_status", branchStatuses);
export const membershipBranchAccessMode = pgEnum(
  "membership_branch_access_mode",
  membershipBranchAccessModes,
);
export const userAccountStatus = pgEnum(
  "user_account_status",
  userAccountStatuses,
);
export const dataScopeType = pgEnum("data_scope_type", dataScopeTypes);
export const roleStatus = pgEnum("role_status", roleStatuses);
export const permissionStatus = pgEnum("permission_status", permissionStatuses);
export const moduleLifecycle = pgEnum("module_lifecycle", moduleLifecycles);
export const organizationModuleStatus = pgEnum(
  "organization_module_status",
  organizationModuleStatuses,
);
export const entitlementSource = pgEnum(
  "entitlement_source",
  entitlementSources,
);
export const featureFlagScope = pgEnum("feature_flag_scope", [
  "GLOBAL",
  "ENVIRONMENT",
  "MODULE",
  "ORGANIZATION",
  "USER",
]);
export const featureFlagType = pgEnum("feature_flag_type", featureFlagTypes);
export const customFieldStatus = pgEnum(
  "custom_field_status",
  customFieldStatuses,
);
export const billingInterval = pgEnum("billing_interval", billingIntervals);
export const subscriptionStatus = pgEnum(
  "subscription_status",
  subscriptionStatuses,
);
export const customFieldType = pgEnum("custom_field_type", customFieldTypes);
export const workflowStatus = pgEnum("workflow_status", workflowStatuses);
export const workflowVersionStatus = pgEnum(
  "workflow_version_status",
  workflowVersionStatuses,
);
export const customDomainVerificationStatus = pgEnum(
  "custom_domain_verification_status",
  customDomainVerificationStatuses,
);
export const sslStatus = pgEnum("ssl_status", sslStatuses);
export const customDevelopmentStatus = pgEnum(
  "custom_development_status",
  customDevelopmentStatuses,
);
export const auditResult = pgEnum("audit_result", auditResults);
export const outboxStatus = pgEnum("outbox_status", outboxStatuses);
export const saleStatus = pgEnum("sale_lifecycle_status", saleStatuses);
export const inventoryMovementType = pgEnum(
  "inventory_movement_type",
  inventoryMovementTypes,
);
export const inventoryReservationStatus = pgEnum(
  "inventory_reservation_status",
  inventoryReservationStatuses,
);
export const jobStatus = pgEnum("job_status", jobStatuses);
export const notificationChannel = pgEnum(
  "notification_channel",
  notificationChannels,
);
export const notificationDeliveryStatus = pgEnum(
  "notification_delivery_status",
  notificationDeliveryStatuses,
);
export const communicationChannel = pgEnum(
  "communication_channel",
  communicationChannels,
);
export const storedObjectProvider = pgEnum(
  "stored_object_provider",
  storedObjectProviders,
);
export const storedObjectStatus = pgEnum(
  "stored_object_status",
  storedObjectStatuses,
);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull().unique(),
    industry: varchar("industry", { length: 100 }).notNull(),
    status: organizationStatus("status").notNull().default("PENDING"),
    deploymentType: deploymentType("deployment_type").notNull().default("SAAS"),
    profile: jsonObject("profile"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("organizations_status_idx").on(table.status)],
);

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    status: branchStatus("status").notNull().default("ACTIVE"),
    address: jsonObject("address"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("branches_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("branches_organization_code_unique").on(
      table.organizationId,
      table.code,
    ),
    index("branches_organization_idx").on(table.organizationId),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    branchId: uuid("branch_id"),
    reference: varchar("reference", { length: 100 }),
    name: varchar("name", { length: 200 }).notNull(),
    customerType: varchar("customer_type", { length: 20 }).notNull(),
    phone: varchar("phone", { length: 50 }),
    email: varchar("email", { length: 320 }),
    status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("customers_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("customers_org_reference_unique")
      .on(table.organizationId, sql`lower(${table.reference})`)
      .where(sql`${table.reference} IS NOT NULL`),
    foreignKey({
      name: "customers_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "customers_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("restrict"),
    index("customers_org_status_updated_idx").on(
      table.organizationId,
      table.status,
      table.updatedAt,
    ),
    index("customers_org_branch_status_idx").on(
      table.organizationId,
      table.branchId,
      table.status,
    ),
    index("customers_org_name_idx").on(table.organizationId, table.name),
    check(
      "customers_type_check",
      sql`${table.customerType} IN ('INDIVIDUAL', 'BUSINESS')`,
    ),
    check(
      "customers_status_check",
      sql`${table.status} IN ('ACTIVE', 'INACTIVE')`,
    ),
    check("customers_name_nonempty", sql`length(btrim(${table.name})) > 0`),
    check(
      "customers_reference_normalized",
      sql`${table.reference} IS NULL OR ${table.reference} = upper(${table.reference})`,
    ),
    check(
      "customers_email_valid",
      sql`${table.email} IS NULL OR ${table.email} ~* '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'`,
    ),
    check(
      "customers_notes_length",
      sql`${table.notes} IS NULL OR char_length(${table.notes}) <= 2000`,
    ),
  ],
);

export const catalogItems = pgTable(
  "catalog_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    branchId: uuid("branch_id"),
    reference: varchar("reference", { length: 100 }),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    type: varchar("type", { length: 20 }).notNull(),
    unit: varchar("unit", { length: 50 }).notNull(),
    price: numeric("price", { precision: 18, scale: 6 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("catalog_items_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("catalog_items_org_reference_unique")
      .on(table.organizationId, sql`lower(${table.reference})`)
      .where(sql`${table.reference} IS NOT NULL`),
    foreignKey({
      name: "catalog_items_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "catalog_items_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("restrict"),
    index("catalog_items_org_status_updated_idx").on(
      table.organizationId,
      table.status,
      table.updatedAt,
    ),
    index("catalog_items_org_branch_status_idx").on(
      table.organizationId,
      table.branchId,
      table.status,
    ),
    index("catalog_items_org_name_idx").on(table.organizationId, table.name),
    check(
      "catalog_items_type_check",
      sql`${table.type} IN ('PRODUCT', 'SERVICE')`,
    ),
    check(
      "catalog_items_status_check",
      sql`${table.status} IN ('ACTIVE', 'INACTIVE')`,
    ),
    check("catalog_items_price_nonnegative", sql`${table.price} >= 0`),
    check(
      "catalog_items_currency_format",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check("catalog_items_name_nonempty", sql`length(btrim(${table.name})) > 0`),
    check("catalog_items_unit_nonempty", sql`length(btrim(${table.unit})) > 0`),
    check(
      "catalog_items_reference_normalized",
      sql`${table.reference} IS NULL OR ${table.reference} = upper(${table.reference})`,
    ),
    check(
      "catalog_items_description_length",
      sql`${table.description} IS NULL OR char_length(${table.description}) <= 2000`,
    ),
  ],
);

export const sales = pgTable(
  "sales",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    status: saleStatus("status").notNull().default("OPEN"),
    currency: varchar("currency", { length: 3 }).notNull(),
    subtotal: numeric("subtotal", { precision: 26, scale: 6 }).notNull(),
    total: numeric("total", { precision: 26, scale: 6 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("sales_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("sales_org_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "sales_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sales_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("restrict"),
    index("sales_org_branch_created_idx").on(
      table.organizationId,
      table.branchId,
      table.createdAt,
      table.id,
    ),
    check("sales_currency_format", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("sales_subtotal_nonnegative", sql`${table.subtotal} >= 0`),
    check("sales_total_matches_subtotal", sql`${table.total} = ${table.subtotal}`),
    check(
      "sales_cancellation_state_consistent",
      sql`(${table.status} = 'OPEN' AND ${table.cancelledAt} IS NULL AND ${table.cancelledByUserId} IS NULL) OR (${table.status} = 'CANCELLED' AND ${table.cancelledAt} IS NOT NULL AND ${table.cancelledByUserId} IS NOT NULL)`,
    ),
    check(
      "sales_idempotency_key_format",
      sql`${table.idempotencyKey} ~ '^[!-~]{1,200}$'`,
    ),
    check(
      "sales_request_hash_format",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const saleLines = pgTable(
  "sale_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    catalogItemId: uuid("catalog_item_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    itemName: varchar("item_name", { length: 200 }).notNull(),
    description: text("description"),
    reference: varchar("reference", { length: 100 }),
    unit: varchar("unit", { length: 50 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 6 }).notNull(),
    quantity: integer("quantity").notNull(),
    lineTotal: numeric("line_total", { precision: 26, scale: 6 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("sale_lines_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("sale_lines_org_sale_line_number_unique").on(
      table.organizationId,
      table.saleId,
      table.lineNumber,
    ),
    unique("sale_lines_org_sale_catalog_item_unique").on(
      table.organizationId,
      table.saleId,
      table.catalogItemId,
    ),
    foreignKey({
      name: "sale_lines_sale_fk",
      columns: [table.organizationId, table.saleId],
      foreignColumns: [sales.organizationId, sales.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sale_lines_catalog_item_fk",
      columns: [table.organizationId, table.catalogItemId],
      foreignColumns: [catalogItems.organizationId, catalogItems.id],
    }).onDelete("restrict"),
    check(
      "sale_lines_line_number_range",
      sql`${table.lineNumber} BETWEEN 1 AND 100`,
    ),
    check("sale_lines_price_nonnegative", sql`${table.unitPrice} >= 0`),
    check(
      "sale_lines_quantity_positive",
      sql`${table.quantity} BETWEEN 1 AND 1000000`,
    ),
    check("sale_lines_total_nonnegative", sql`${table.lineTotal} >= 0`),
    check(
      "sale_lines_total_matches_quantity",
      sql`${table.lineTotal} = ${table.unitPrice} * ${table.quantity}`,
    ),
  ],
);

export const inventoryStockBalances = pgTable(
  "inventory_stock_balances",
  {
    organizationId: uuid("organization_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    catalogItemId: uuid("catalog_item_id").notNull(),
    onHand: integer("on_hand").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "inventory_stock_balances_pk",
      columns: [table.organizationId, table.branchId, table.catalogItemId],
    }),
    foreignKey({
      name: "inventory_stock_balances_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_stock_balances_catalog_item_fk",
      columns: [table.organizationId, table.catalogItemId],
      foreignColumns: [catalogItems.organizationId, catalogItems.id],
    }).onDelete("restrict"),
    check("inventory_stock_on_hand_nonnegative", sql`${table.onHand} >= 0`),
    check("inventory_stock_reserved_nonnegative", sql`${table.reserved} >= 0`),
    check(
      "inventory_stock_reserved_within_on_hand",
      sql`${table.reserved} <= ${table.onHand}`,
    ),
    index("inventory_stock_branch_item_idx").on(
      table.organizationId,
      table.branchId,
      table.catalogItemId,
    ),
  ],
);

export const inventoryReservations = pgTable(
  "inventory_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    catalogItemId: uuid("catalog_item_id").notNull(),
    quantity: integer("quantity").notNull(),
    status: inventoryReservationStatus("status").notNull().default("ACTIVE"),
    createdAt: createdAt(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedByUserId: uuid("released_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
  },
  (table) => [
    unique("inventory_reservations_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("inventory_reservations_sale_item_unique").on(
      table.organizationId,
      table.saleId,
      table.catalogItemId,
    ),
    foreignKey({
      name: "inventory_reservations_sale_fk",
      columns: [table.organizationId, table.saleId],
      foreignColumns: [sales.organizationId, sales.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_reservations_sale_line_fk",
      columns: [table.organizationId, table.saleId, table.catalogItemId],
      foreignColumns: [saleLines.organizationId, saleLines.saleId, saleLines.catalogItemId],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_reservations_stock_balance_fk",
      columns: [table.organizationId, table.branchId, table.catalogItemId],
      foreignColumns: [
        inventoryStockBalances.organizationId,
        inventoryStockBalances.branchId,
        inventoryStockBalances.catalogItemId,
      ],
    }).onDelete("restrict"),
    check(
      "inventory_reservations_quantity_positive",
      sql`${table.quantity} BETWEEN 1 AND 1000000`,
    ),
    check(
      "inventory_reservations_release_state_consistent",
      sql`(${table.status} = 'ACTIVE' AND ${table.releasedAt} IS NULL AND ${table.releasedByUserId} IS NULL) OR (${table.status} = 'RELEASED' AND ${table.releasedAt} IS NOT NULL AND ${table.releasedByUserId} IS NOT NULL)`,
    ),
    index("inventory_reservations_branch_status_idx").on(
      table.organizationId,
      table.branchId,
      table.status,
    ),
  ],
);

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    catalogItemId: uuid("catalog_item_id").notNull(),
    saleId: uuid("sale_id"),
    reservationId: uuid("reservation_id"),
    movementType: inventoryMovementType("movement_type").notNull(),
    deltaOnHand: integer("delta_on_hand").notNull(),
    deltaReserved: integer("delta_reserved").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("inventory_movements_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("inventory_movements_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "inventory_movements_stock_balance_fk",
      columns: [table.organizationId, table.branchId, table.catalogItemId],
      foreignColumns: [
        inventoryStockBalances.organizationId,
        inventoryStockBalances.branchId,
        inventoryStockBalances.catalogItemId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_movements_sale_fk",
      columns: [table.organizationId, table.saleId],
      foreignColumns: [sales.organizationId, sales.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_movements_reservation_fk",
      columns: [table.organizationId, table.reservationId],
      foreignColumns: [inventoryReservations.organizationId, inventoryReservations.id],
    }).onDelete("restrict"),
    check(
      "inventory_movements_effect_matches_type",
      sql`(${table.movementType} = 'RECEIPT' AND ${table.deltaOnHand} > 0 AND ${table.deltaReserved} = 0 AND ${table.saleId} IS NULL AND ${table.reservationId} IS NULL) OR (${table.movementType} = 'ADJUSTMENT' AND ${table.deltaOnHand} <> 0 AND ${table.deltaReserved} = 0 AND ${table.saleId} IS NULL AND ${table.reservationId} IS NULL) OR (${table.movementType} = 'RESERVATION' AND ${table.deltaOnHand} = 0 AND ${table.deltaReserved} > 0 AND ${table.saleId} IS NOT NULL AND ${table.reservationId} IS NOT NULL) OR (${table.movementType} = 'RESERVATION_RELEASE' AND ${table.deltaOnHand} = 0 AND ${table.deltaReserved} < 0 AND ${table.saleId} IS NOT NULL AND ${table.reservationId} IS NOT NULL)`,
    ),
    check(
      "inventory_movements_idempotency_key_format",
      sql`${table.idempotencyKey} ~ '^[!-~]{1,200}$'`,
    ),
    check(
      "inventory_movements_request_hash_format",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    index("inventory_movements_branch_created_idx").on(
      table.organizationId,
      table.branchId,
      table.createdAt,
    ),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull().unique(),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    status: userAccountStatus("status").notNull().default("ACTIVE"),
    passwordHash: text("password_hash"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    failedLoginWindowStartedAt: timestamp("failed_login_window_started_at", {
      withTimezone: true,
    }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("users_status_idx").on(table.status),
    uniqueIndex("users_email_lower_unique").on(sql`lower(${table.email})`),
    check(
      "users_failed_login_attempts_nonnegative",
      sql`${table.failedLoginAttempts} >= 0`,
    ),
    check(
      "users_email_normalized",
      sql`${table.email} = lower(${table.email})`,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    secretHash: varchar("secret_hash", { length: 64 }).notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    branchId: uuid("branch_id"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: varchar("user_agent", { length: 512 }),
  },
  (table) => [
    foreignKey({
      name: "sessions_organization_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "sessions_organization_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("restrict"),
    index("sessions_user_expiry_idx").on(table.userId, table.expiresAt),
    index("sessions_expiry_idx").on(table.expiresAt),
    check(
      "sessions_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "sessions_branch_requires_organization",
      sql`${table.branchId} IS NULL OR ${table.organizationId} IS NOT NULL`,
    ),
  ],
);

export const platformRole = pgEnum("platform_role", [
  "SUPERADMIN",
  "SUPPORT",
  "SECURITY",
  "OPERATIONS",
  "ENGINEERING",
]);

export const platformUserRoles = pgTable(
  "platform_user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: platformRole("role").notNull(),
    grantedAt: createdAt(),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    primaryKey({
      name: "platform_user_roles_pk",
      columns: [table.userId, table.role],
    }),
  ],
);

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: membershipStatus("status").notNull().default("INVITED"),
    branchAccessMode: membershipBranchAccessMode("branch_access_mode")
      .notNull()
      .default("ASSIGNED"),
    locale: varchar("locale", { length: 35 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("organization_memberships_org_user_unique").on(
      table.organizationId,
      table.userId,
    ),
    unique("organization_memberships_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("organization_memberships_user_idx").on(table.userId),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    status: roleStatus("status").notNull().default("ACTIVE"),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("roles_organization_name_unique").on(
      table.organizationId,
      table.name,
    ),
    unique("roles_organization_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("roles_organization_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 150 }).notNull().unique(),
    moduleKey: varchar("module_key", { length: 100 }).notNull(),
    resourceKey: varchar("resource_key", { length: 50 }).notNull(),
    actionKey: varchar("action_key", { length: 50 }).notNull(),
    description: text("description").notNull(),
    status: permissionStatus("status").notNull().default("ACTIVE"),
    isSystem: boolean("is_system").notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("permissions_module_resource_action_unique").on(
      table.moduleKey,
      table.resourceKey,
      table.actionKey,
    ),
    index("permissions_module_status_idx").on(table.moduleKey, table.status),
    check(
      "permissions_key_canonical",
      sql`${table.key} = ${table.moduleKey} || '.' || ${table.resourceKey} || '.' || ${table.actionKey} AND ${table.moduleKey} ~ '^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)*$' AND ${table.resourceKey} ~ '^[a-z][a-z0-9_-]*$' AND ${table.actionKey} ~ '^[a-z][a-z0-9_-]*$'`,
    ),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull(),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    scopeType: dataScopeType("scope_type").notNull().default("ORGANIZATION"),
    scope: jsonObject("scope"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "role_permissions_pk",
      columns: [table.organizationId, table.roleId, table.permissionId],
    }),
    foreignKey({
      name: "role_permissions_role_fk",
      columns: [table.organizationId, table.roleId],
      foreignColumns: [roles.organizationId, roles.id],
    }).onDelete("cascade"),
  ],
);

export const membershipRoles = pgTable(
  "membership_roles",
  {
    organizationId: uuid("organization_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    roleId: uuid("role_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "membership_roles_pk",
      columns: [table.organizationId, table.membershipId, table.roleId],
    }),
    foreignKey({
      name: "membership_roles_membership_fk",
      columns: [table.organizationId, table.membershipId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "membership_roles_role_fk",
      columns: [table.organizationId, table.roleId],
      foreignColumns: [roles.organizationId, roles.id],
    }).onDelete("cascade"),
  ],
);

export const membershipBranches = pgTable(
  "membership_branches",
  {
    organizationId: uuid("organization_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "membership_branches_pk",
      columns: [table.organizationId, table.membershipId, table.branchId],
    }),
    foreignKey({
      name: "membership_branches_membership_fk",
      columns: [table.organizationId, table.membershipId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "membership_branches_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("cascade"),
  ],
);

export const membershipDataScopes = pgTable(
  "membership_data_scopes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    scopeType: dataScopeType("scope_type").notNull(),
    scope: jsonObject("scope"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "membership_data_scopes_membership_fk",
      columns: [table.organizationId, table.membershipId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.id,
      ],
    }).onDelete("cascade"),
    index("membership_data_scopes_member_idx").on(
      table.organizationId,
      table.membershipId,
    ),
  ],
);

export const modules = pgTable(
  "modules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 100 }).notNull().unique(),
    name: varchar("name", { length: 150 }).notNull(),
    description: text("description"),
    lifecycle: moduleLifecycle("lifecycle").notNull().default("DEVELOPMENT"),
    isAvailable: boolean("is_available").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("modules_lifecycle_available_idx").on(
      table.lifecycle,
      table.isAvailable,
    ),
  ],
);

export const moduleVersions = pgTable(
  "module_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    moduleId: uuid("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
    version: varchar("version", { length: 50 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("AVAILABLE"),
    manifest: jsonObject("manifest"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("module_versions_module_version_unique").on(
      table.moduleId,
      table.version,
    ),
  ],
);

export const moduleDependencies = pgTable(
  "module_dependencies",
  {
    moduleId: uuid("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
    dependencyModuleId: uuid("dependency_module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
    minimumVersion: varchar("minimum_version", { length: 50 }),
  },
  (table) => [
    primaryKey({
      name: "module_dependencies_pk",
      columns: [table.moduleId, table.dependencyModuleId],
    }),
    index("module_dependencies_dependency_idx").on(table.dependencyModuleId),
    check(
      "module_dependencies_no_self_reference",
      sql`${table.moduleId} <> ${table.dependencyModuleId}`,
    ),
  ],
);

export const features = pgTable(
  "features",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    moduleId: uuid("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 100 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    description: text("description"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("features_module_key_unique").on(table.moduleId, table.key),
  ],
);

export const modulePermissions = pgTable(
  "module_permissions",
  {
    moduleId: uuid("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({
      name: "module_permissions_pk",
      columns: [table.moduleId, table.permissionId],
    }),
    index("module_permissions_permission_idx").on(table.permissionId),
  ],
);

export const organizationModules = pgTable(
  "organization_modules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    moduleId: uuid("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "restrict" }),
    status: organizationModuleStatus("status").notNull().default("AVAILABLE"),
    source: entitlementSource("source").notNull().default("MANUAL"),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("organization_modules_org_module_unique").on(
      table.organizationId,
      table.moduleId,
    ),
    unique("organization_modules_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("organization_modules_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const organizationFeatures = pgTable(
  "organization_features",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    source: entitlementSource("source").notNull().default("MANUAL"),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "organization_features_pk",
      columns: [table.organizationId, table.featureId],
    }),
  ],
);

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 120 }).notNull().unique(),
    description: text("description").notNull(),
    defaultEnabled: boolean("default_enabled").notNull().default(false),
    valueType: featureFlagType("value_type").notNull().default("BOOLEAN"),
    defaultValue: jsonb("default_value")
      .$type<unknown>()
      .notNull()
      .default(sql`'false'::jsonb`),
    isSecuritySensitive: boolean("is_security_sensitive")
      .notNull()
      .default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "feature_flags_default_value_type_check",
      sql`(${table.valueType} = 'BOOLEAN' and jsonb_typeof(${table.defaultValue}) = 'boolean')
        or (${table.valueType} = 'STRING' and jsonb_typeof(${table.defaultValue}) = 'string')
        or (${table.valueType} = 'NUMBER' and jsonb_typeof(${table.defaultValue}) = 'number')
        or ${table.valueType} = 'JSON'`,
    ),
    check(
      "feature_flags_security_boolean_check",
      sql`not ${table.isSecuritySensitive} or (${table.valueType} = 'BOOLEAN' and ${table.defaultValue} = 'false'::jsonb)`,
    ),
  ],
);

export const featureFlagAssignments = pgTable(
  "feature_flag_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    flagId: uuid("flag_id")
      .notNull()
      .references(() => featureFlags.id, { onDelete: "cascade" }),
    scope: featureFlagScope("scope").notNull(),
    scopeKey: varchar("scope_key", { length: 20 })
      .$type<FeatureFlagScope>()
      .notNull()
      .default("ORGANIZATION"),
    environment: varchar("environment", { length: 30 }),
    moduleId: uuid("module_id").references(() => modules.id, {
      onDelete: "cascade",
    }),
    branchId: uuid("branch_id"),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
    value: jsonb("value").$type<unknown>(),
    createdAt: createdAt(),
  },
  (table) => [
    index("feature_flag_assignments_lookup_idx").on(
      table.flagId,
      table.scopeKey,
      table.organizationId,
      table.branchId,
      table.userId,
    ),
    unique("feature_flag_assignments_scope_unique")
      .on(
        table.flagId,
        table.scopeKey,
        table.environment,
        table.moduleId,
        table.organizationId,
        table.branchId,
        table.userId,
      )
      .nullsNotDistinct(),
    check(
      "feature_flag_assignments_scope_check",
      sql`(${table.scope} = 'GLOBAL' and ${table.environment} is null and ${table.moduleId} is null and ${table.organizationId} is null and ${table.userId} is null)
        or (${table.scope} = 'ENVIRONMENT' and ${table.environment} is not null and ${table.moduleId} is null and ${table.organizationId} is null and ${table.userId} is null)
        or (${table.scope} = 'MODULE' and ${table.environment} is null and ${table.moduleId} is not null and ${table.organizationId} is null and ${table.userId} is null)
        or (${table.scope} = 'ORGANIZATION' and ${table.environment} is null and ${table.moduleId} is null and ${table.organizationId} is not null and ${table.userId} is null)
        or (${table.scope} = 'USER' and ${table.environment} is null and ${table.moduleId} is null and ${table.organizationId} is not null and ${table.userId} is not null)`,
    ),
    check(
      "feature_flag_assignments_scope_key_check",
      sql`(${table.scopeKey} in ('SYSTEM', 'PLATFORM', 'GLOBAL') and ${table.environment} is null and ${table.moduleId} is null and ${table.organizationId} is null and ${table.branchId} is null and ${table.userId} is null)
        or (${table.scopeKey} = 'ENVIRONMENT' and ${table.environment} is not null and ${table.moduleId} is null and ${table.organizationId} is null and ${table.branchId} is null and ${table.userId} is null)
        or (${table.scopeKey} = 'MODULE' and ${table.environment} is null and ${table.moduleId} is not null and ${table.organizationId} is null and ${table.branchId} is null and ${table.userId} is null)
        or (${table.scopeKey} = 'ORGANIZATION' and ${table.environment} is null and ${table.moduleId} is null and ${table.organizationId} is not null and ${table.branchId} is null and ${table.userId} is null)
        or (${table.scopeKey} = 'BRANCH' and ${table.environment} is null and ${table.moduleId} is null and ${table.organizationId} is not null and ${table.branchId} is not null and ${table.userId} is null)
        or (${table.scopeKey} = 'USER' and ${table.environment} is null and ${table.moduleId} is null and ${table.organizationId} is not null and ${table.branchId} is null and ${table.userId} is not null)`,
    ),
    foreignKey({
      name: "feature_flag_assignments_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "feature_flag_assignments_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("cascade"),
  ],
);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 100 }).notNull().unique(),
    name: varchar("name", { length: 150 }).notNull(),
    billingInterval: billingInterval("billing_interval").notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    isAvailable: boolean("is_available").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("plans_available_idx").on(table.isAvailable)],
);

export const planModules = pgTable(
  "plan_modules",
  {
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    moduleId: uuid("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({
      name: "plan_modules_pk",
      columns: [table.planId, table.moduleId],
    }),
    index("plan_modules_module_idx").on(table.moduleId),
  ],
);

export const planFeatures = pgTable(
  "plan_features",
  {
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({
      name: "plan_features_pk",
      columns: [table.planId, table.featureId],
    }),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: subscriptionStatus("status").notNull().default("PENDING"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    gracePeriodEndsAt: timestamp("grace_period_ends_at", {
      withTimezone: true,
    }),
    customQuoteReference: varchar("custom_quote_reference", { length: 100 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("subscriptions_org_id_id_unique").on(table.organizationId, table.id),
    index("subscriptions_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const subscriptionItems = pgTable(
  "subscription_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    planId: uuid("plan_id").references(() => plans.id, {
      onDelete: "restrict",
    }),
    moduleId: uuid("module_id").references(() => modules.id, {
      onDelete: "restrict",
    }),
    featureId: uuid("feature_id").references(() => features.id, {
      onDelete: "restrict",
    }),
    quantity: integer("quantity").notNull().default(1),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "subscription_items_subscription_fk",
      columns: [table.organizationId, table.subscriptionId],
      foreignColumns: [subscriptions.organizationId, subscriptions.id],
    }).onDelete("cascade"),
    index("subscription_items_subscription_idx").on(
      table.organizationId,
      table.subscriptionId,
    ),
  ],
);

export const subscriptionHistory = pgTable(
  "subscription_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    changeType: varchar("change_type", { length: 50 }).notNull(),
    details: jsonObject("details"),
    occurredAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "subscription_history_subscription_fk",
      columns: [table.organizationId, table.subscriptionId],
      foreignColumns: [subscriptions.organizationId, subscriptions.id],
    }).onDelete("cascade"),
    index("subscription_history_org_time_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
  ],
);

export const organizationEntitlements = pgTable(
  "organization_entitlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entitlementKey: varchar("entitlement_key", { length: 120 }).notNull(),
    source: entitlementSource("source").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("organization_entitlements_org_key_unique").on(
      table.organizationId,
      table.entitlementKey,
    ),
  ],
);

export const organizationConfigurations = pgTable(
  "organization_configurations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 100 }).notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("organization_configurations_org_key_unique").on(
      table.organizationId,
      table.key,
    ),
  ],
);

export const organizationSettings = pgTable("organization_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  countryCode: varchar("country_code", { length: 2 }).notNull(),
  currencyCode: varchar("currency_code", { length: 3 }).notNull(),
  timezone: varchar("timezone", { length: 100 }).notNull(),
  locale: varchar("locale", { length: 20 }).notNull().default("en"),
  address: jsonObject("address"),
  taxInformation: jsonObject("tax_information"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const businessSettings = pgTable(
  "business_settings",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    legalName: varchar("legal_name", { length: 200 }),
    registrationNumber: varchar("registration_number", { length: 100 }),
    taxNumber: varchar("tax_number", { length: 100 }),
    contactEmail: varchar("contact_email", { length: 320 }),
    contactPhone: varchar("contact_phone", { length: 50 }),
    website: varchar("website", { length: 2048 }),
    addressCountryCode: varchar("address_country_code", { length: 2 }),
    addressRegion: varchar("address_region", { length: 100 }),
    addressCity: varchar("address_city", { length: 100 }),
    address: varchar("address", { length: 300 }),
    paymentMethods: jsonb("payment_methods")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "business_settings_address_country_code_format",
      sql`${table.addressCountryCode} is null or ${table.addressCountryCode} ~ '^[A-Z]{2}$'`,
    ),
    check(
      "business_settings_contact_phone_nonempty",
      sql`${table.contactPhone} is null or length(btrim(${table.contactPhone})) > 0`,
    ),
    check(
      "business_settings_address_region_nonempty",
      sql`${table.addressRegion} is null or length(btrim(${table.addressRegion})) > 0`,
    ),
    check(
      "business_settings_address_city_nonempty",
      sql`${table.addressCity} is null or length(btrim(${table.addressCity})) > 0`,
    ),
    check(
      "business_settings_address_nonempty",
      sql`${table.address} is null or length(btrim(${table.address})) > 0`,
    ),
  ],
);

export const organizationBranding = pgTable("organization_branding", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  logoUrl: text("logo_url"),
  faviconUrl: text("favicon_url"),
  primaryColor: varchar("primary_color", { length: 7 }),
  secondaryColor: varchar("secondary_color", { length: 7 }),
  invoiceTemplate: varchar("invoice_template", { length: 100 }),
  receiptTemplate: varchar("receipt_template", { length: 100 }),
  emailBranding: jsonObject("email_branding"),
  smsSender: varchar("sms_sender", { length: 20 }),
  updatedAt: updatedAt(),
});

export const organizationStorage = pgTable("organization_storage", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 80 }).notNull(),
  storageReference: varchar("storage_reference", { length: 500 }).notNull(),
  region: varchar("region", { length: 100 }),
  quotaBytes: numeric("quota_bytes", { precision: 20, scale: 0 }),
  updatedAt: updatedAt(),
});

export const numberingConfigurations = pgTable(
  "numbering_configurations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentType: varchar("document_type", { length: 80 }).notNull(),
    prefix: varchar("prefix", { length: 30 }).notNull().default(""),
    nextNumber: integer("next_number").notNull().default(1),
    padding: integer("padding").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("numbering_configurations_org_type_unique").on(
      table.organizationId,
      table.documentType,
    ),
  ],
);

export const taxConfigurations = pgTable(
  "tax_configurations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 80 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    rate: numeric("rate", { precision: 12, scale: 8 }).notNull(),
    isInclusive: boolean("is_inclusive").notNull().default(false),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("tax_configurations_org_key_unique").on(
      table.organizationId,
      table.key,
    ),
  ],
);

export const notificationConfigurations = pgTable(
  "notification_configurations",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    preferences: jsonObject("preferences"),
    updatedAt: updatedAt(),
  },
);

export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityType: varchar("entity_type", { length: 100 }).notNull(),
    key: varchar("key", { length: 100 }).notNull(),
    label: varchar("label", { length: 150 }).notNull(),
    fieldType: customFieldType("field_type").notNull(),
    isRequired: boolean("is_required").notNull().default(false),
    defaultValue: jsonb("default_value").$type<unknown>(),
    options: jsonb("options").$type<unknown[]>().notNull().default([]),
    validation: jsonObject("validation"),
    isVisible: boolean("is_visible").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    status: customFieldStatus("status").notNull().default("ACTIVE"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("custom_field_definitions_org_entity_key_unique").on(
      table.organizationId,
      table.entityType,
      table.key,
    ),
    unique("custom_field_definitions_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("custom_field_definitions_org_entity_idx").on(
      table.organizationId,
      table.entityType,
    ),
    check(
      "custom_field_definitions_sort_order_nonnegative",
      sql`${table.sortOrder} >= 0`,
    ),
  ],
);

export const customFieldValues = pgTable(
  "custom_field_values",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    definitionId: uuid("definition_id").notNull(),
    resourceType: varchar("resource_type", { length: 100 }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "custom_field_values_definition_fk",
      columns: [table.organizationId, table.definitionId],
      foreignColumns: [
        customFieldDefinitions.organizationId,
        customFieldDefinitions.id,
      ],
    }).onDelete("cascade"),
    unique("custom_field_values_org_entity_field_unique").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
      table.definitionId,
    ),
    index("custom_field_values_resource_idx").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: varchar("event_type", { length: 150 }).notNull(),
    aggregateType: varchar("aggregate_type", { length: 100 })
      .notNull()
      .default("legacy"),
    aggregateId: uuid("aggregate_id").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    branchId: uuid("branch_id"),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    causationId: uuid("causation_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonObject("payload"),
    metadata: jsonObject("metadata"),
    version: integer("version").notNull().default(1),
    status: outboxStatus("status").notNull().default("PENDING"),
    deliveryStatus: varchar("delivery_status", { length: 20 })
      .$type<EventDeliveryStatus>()
      .notNull()
      .default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: varchar("last_error", { length: 2_000 }),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
    }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("outbox_events_org_id_unique").on(table.organizationId, table.id),
    index("outbox_events_pending_idx").on(
      table.organizationId,
      table.deliveryStatus,
      table.nextAttemptAt,
      table.createdAt,
    ),
    index("outbox_events_aggregate_idx").on(
      table.organizationId,
      table.aggregateId,
      table.occurredAt,
    ),
    index("outbox_events_org_idx").on(table.organizationId, table.occurredAt),
    index("outbox_events_type_idx").on(
      table.organizationId,
      table.eventType,
      table.createdAt,
    ),
    check("outbox_events_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check(
      "outbox_events_delivery_status_check",
      sql`${table.deliveryStatus} in ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTERED')`,
    ),
    foreignKey({
      name: "outbox_events_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("restrict"),
  ],
);

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 100 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    status: workflowStatus("status").notNull().default("DRAFT"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("workflow_definitions_org_key_unique").on(
      table.organizationId,
      table.key,
    ),
    unique("workflow_definitions_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
  ],
);

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    workflowId: uuid("workflow_id").notNull(),
    version: integer("version").notNull(),
    status: workflowVersionStatus("status").notNull().default("DRAFT"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "workflow_versions_workflow_fk",
      columns: [table.organizationId, table.workflowId],
      foreignColumns: [
        workflowDefinitions.organizationId,
        workflowDefinitions.id,
      ],
    }).onDelete("cascade"),
    unique("workflow_versions_org_workflow_version_unique").on(
      table.organizationId,
      table.workflowId,
      table.version,
    ),
    unique("workflow_versions_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("workflow_versions_activation_idx").on(
      table.organizationId,
      table.workflowId,
      table.status,
    ),
    uniqueIndex("workflow_versions_single_published_idx")
      .on(table.organizationId, table.workflowId)
      .where(sql`${table.status} = 'PUBLISHED'`),
  ],
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    workflowVersionId: uuid("workflow_version_id").notNull(),
    key: varchar("key", { length: 100 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    position: integer("position").notNull(),
    configuration: jsonObject("configuration"),
  },
  (table) => [
    foreignKey({
      name: "workflow_steps_version_fk",
      columns: [table.organizationId, table.workflowVersionId],
      foreignColumns: [workflowVersions.organizationId, workflowVersions.id],
    }).onDelete("cascade"),
    unique("workflow_steps_version_key_unique").on(
      table.organizationId,
      table.workflowVersionId,
      table.key,
    ),
    unique("workflow_steps_org_version_id_unique").on(
      table.organizationId,
      table.workflowVersionId,
      table.id,
    ),
    unique("workflow_steps_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
  ],
);

export const workflowTransitions = pgTable(
  "workflow_transitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    workflowVersionId: uuid("workflow_version_id").notNull(),
    fromStepId: uuid("from_step_id").notNull(),
    toStepId: uuid("to_step_id").notNull(),
    condition: jsonObject("condition"),
  },
  (table) => [
    foreignKey({
      name: "workflow_transitions_from_step_fk",
      columns: [
        table.organizationId,
        table.workflowVersionId,
        table.fromStepId,
      ],
      foreignColumns: [
        workflowSteps.organizationId,
        workflowSteps.workflowVersionId,
        workflowSteps.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "workflow_transitions_to_step_fk",
      columns: [table.organizationId, table.workflowVersionId, table.toStepId],
      foreignColumns: [
        workflowSteps.organizationId,
        workflowSteps.workflowVersionId,
        workflowSteps.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "workflow_transitions_version_fk",
      columns: [table.organizationId, table.workflowVersionId],
      foreignColumns: [workflowVersions.organizationId, workflowVersions.id],
    }).onDelete("cascade"),
  ],
);

export const workflowTriggers = pgTable(
  "workflow_triggers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    workflowVersionId: uuid("workflow_version_id").notNull(),
    triggerType: varchar("trigger_type", { length: 80 }).notNull(),
    configuration: jsonObject("configuration"),
  },
  (table) => [
    foreignKey({
      name: "workflow_triggers_version_fk",
      columns: [table.organizationId, table.workflowVersionId],
      foreignColumns: [workflowVersions.organizationId, workflowVersions.id],
    }).onDelete("cascade"),
  ],
);

export const workflowActions = pgTable(
  "workflow_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    workflowStepId: uuid("workflow_step_id").notNull(),
    actionType: varchar("action_type", { length: 80 }).notNull(),
    configuration: jsonObject("configuration"),
    position: integer("position").notNull().default(0),
  },
  (table) => [
    foreignKey({
      name: "workflow_actions_step_fk",
      columns: [table.organizationId, table.workflowStepId],
      foreignColumns: [workflowSteps.organizationId, workflowSteps.id],
    }).onDelete("cascade"),
    unique("workflow_actions_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
  ],
);

export const workflowConditions = pgTable(
  "workflow_conditions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    workflowStepId: uuid("workflow_step_id").notNull(),
    expression: jsonObject("expression"),
  },
  (table) => [
    foreignKey({
      name: "workflow_conditions_step_fk",
      columns: [table.organizationId, table.workflowStepId],
      foreignColumns: [workflowSteps.organizationId, workflowSteps.id],
    }).onDelete("cascade"),
  ],
);

export const workflowExecutions = pgTable(
  "workflow_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workflowVersionId: uuid("workflow_version_id").notNull(),
    sourceEventId: uuid("source_event_id"),
    branchId: uuid("branch_id"),
    status: varchar("status", { length: 30 })
      .$type<WorkflowExecutionStatus>()
      .notNull()
      .default("PENDING"),
    resourceType: varchar("resource_type", { length: 100 }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    context: jsonObject("context"),
    failureCode: varchar("failure_code", { length: 100 }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("workflow_executions_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      name: "workflow_executions_version_fk",
      columns: [table.organizationId, table.workflowVersionId],
      foreignColumns: [workflowVersions.organizationId, workflowVersions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "workflow_executions_source_event_fk",
      columns: [table.organizationId, table.sourceEventId],
      foreignColumns: [outboxEvents.organizationId, outboxEvents.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "workflow_executions_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("restrict"),
    uniqueIndex("workflow_executions_event_version_unique")
      .on(table.organizationId, table.workflowVersionId, table.sourceEventId)
      .where(sql`${table.sourceEventId} is not null`),
    index("workflow_executions_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("workflow_executions_org_branch_started_idx").on(
      table.organizationId,
      table.branchId,
      table.startedAt,
    ),
    check(
      "workflow_executions_status_check",
      sql`${table.status} in ('PENDING', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'SKIPPED')`,
    ),
    check(
      "workflow_executions_failure_code_check",
      sql`${table.failureCode} is null or ${table.failureCode} ~ '^[A-Z0-9_]{1,100}$'`,
    ),
  ],
);

export const workflowExecutionActions = pgTable(
  "workflow_execution_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    executionId: uuid("execution_id").notNull(),
    workflowActionId: uuid("workflow_action_id").notNull(),
    status: varchar("status", { length: 20 })
      .$type<WorkflowActionStatus>()
      .notNull()
      .default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureCode: varchar("failure_code", { length: 100 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "workflow_execution_actions_execution_fk",
      columns: [table.organizationId, table.executionId],
      foreignColumns: [
        workflowExecutions.organizationId,
        workflowExecutions.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "workflow_execution_actions_action_fk",
      columns: [table.organizationId, table.workflowActionId],
      foreignColumns: [workflowActions.organizationId, workflowActions.id],
    }).onDelete("restrict"),
    unique("workflow_execution_actions_action_unique").on(
      table.organizationId,
      table.executionId,
      table.workflowActionId,
    ),
    index("workflow_execution_actions_org_status_idx").on(
      table.organizationId,
      table.executionId,
      table.status,
    ),
    check(
      "workflow_execution_actions_status_check",
      sql`${table.status} in ('PENDING', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'SKIPPED')`,
    ),
    check(
      "workflow_execution_actions_attempts_check",
      sql`${table.attempts} between 0 and 20`,
    ),
    check(
      "workflow_execution_actions_failure_code_check",
      sql`${table.failureCode} is null or ${table.failureCode} ~ '^[A-Z0-9_]{1,100}$'`,
    ),
  ],
);

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 100 }).notNull(),
    provider: varchar("provider", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    configuration: jsonObject("configuration"),
    secretReference: varchar("secret_reference", { length: 500 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("integrations_org_key_unique").on(table.organizationId, table.key),
    unique("integrations_org_id_id_unique").on(table.organizationId, table.id),
  ],
);

export const customDomains = pgTable(
  "custom_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: varchar("domain", { length: 253 }).notNull().unique(),
    domainType: varchar("domain_type", { length: 20 }).notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    verificationStatus: customDomainVerificationStatus("verification_status")
      .notNull()
      .default("PENDING"),
    sslStatus: sslStatus("ssl_status").notNull().default("PENDING"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("custom_domains_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("custom_domains_org_primary_idx").on(
      table.organizationId,
      table.isPrimary,
    ),
    check(
      "custom_domains_type_check",
      sql`${table.domainType} in ('DOMAIN', 'SUBDOMAIN')`,
    ),
    uniqueIndex("custom_domains_single_primary_idx")
      .on(table.organizationId)
      .where(sql`${table.isPrimary} = true`),
  ],
);

export const extensions = pgTable("extensions", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 150 }).notNull(),
  publisher: varchar("publisher", { length: 150 }).notNull(),
  isAvailable: boolean("is_available").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const extensionVersions = pgTable(
  "extension_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    extensionId: uuid("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    version: varchar("version", { length: 50 }).notNull(),
    manifest: jsonObject("manifest"),
    status: varchar("status", { length: 20 }).notNull().default("AVAILABLE"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("extension_versions_extension_version_unique").on(
      table.extensionId,
      table.version,
    ),
  ],
);

export const extensionDependencies = pgTable(
  "extension_dependencies",
  {
    extensionId: uuid("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    dependencyExtensionId: uuid("dependency_extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    minimumVersion: varchar("minimum_version", { length: 50 }),
  },
  (table) => [
    primaryKey({
      name: "extension_dependencies_pk",
      columns: [table.extensionId, table.dependencyExtensionId],
    }),
  ],
);

export const extensionPermissions = pgTable(
  "extension_permissions",
  {
    extensionId: uuid("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({
      name: "extension_permissions_pk",
      columns: [table.extensionId, table.permissionId],
    }),
  ],
);

export const extensionConfigurations = pgTable(
  "extension_configurations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    extensionId: uuid("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "restrict" }),
    configuration: jsonObject("configuration"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("extension_configurations_org_extension_unique").on(
      table.organizationId,
      table.extensionId,
    ),
  ],
);

export const extensionDeployments = pgTable(
  "extension_deployments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    extensionVersionId: uuid("extension_version_id")
      .notNull()
      .references(() => extensionVersions.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("extension_deployments_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const customDevelopmentRequests = pgTable(
  "custom_development_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requesterUserId: uuid("requester_user_id").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description").notNull(),
    priority: varchar("priority", { length: 20 }).notNull().default("NORMAL"),
    status: customDevelopmentStatus("status").notNull().default("REQUESTED"),
    estimatedCost: numeric("estimated_cost", { precision: 20, scale: 6 }),
    approvedCost: numeric("approved_cost", { precision: 20, scale: 6 }),
    currencyCode: varchar("currency_code", { length: 3 }),
    assignedTeam: varchar("assigned_team", { length: 150 }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "custom_development_requests_requester_membership_fk",
      columns: [table.organizationId, table.requesterUserId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    }).onDelete("restrict"),
    unique("custom_development_requests_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
    index("custom_development_requests_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const customDevelopmentRequirements = pgTable(
  "custom_development_requirements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    requestId: uuid("request_id").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    details: text("details").notNull(),
    priority: varchar("priority", { length: 20 }).notNull().default("NORMAL"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "custom_development_requirements_request_fk",
      columns: [table.organizationId, table.requestId],
      foreignColumns: [
        customDevelopmentRequests.organizationId,
        customDevelopmentRequests.id,
      ],
    }).onDelete("cascade"),
  ],
);

export const customDevelopmentQuotes = pgTable(
  "custom_development_quotes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    requestId: uuid("request_id").notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    validUntil: date("valid_until"),
    details: jsonObject("details"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "custom_development_quotes_request_fk",
      columns: [table.organizationId, table.requestId],
      foreignColumns: [
        customDevelopmentRequests.organizationId,
        customDevelopmentRequests.id,
      ],
    }).onDelete("cascade"),
    unique("custom_development_quotes_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
  ],
);

export const customDevelopmentApprovals = pgTable(
  "custom_development_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    requestId: uuid("request_id").notNull(),
    quoteId: uuid("quote_id"),
    approverUserId: uuid("approver_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decision: varchar("decision", { length: 30 }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    notes: text("notes"),
  },
  (table) => [
    foreignKey({
      name: "custom_development_approvals_request_fk",
      columns: [table.organizationId, table.requestId],
      foreignColumns: [
        customDevelopmentRequests.organizationId,
        customDevelopmentRequests.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "custom_development_approvals_quote_fk",
      columns: [table.organizationId, table.quoteId],
      foreignColumns: [
        customDevelopmentQuotes.organizationId,
        customDevelopmentQuotes.id,
      ],
    }).onDelete("restrict"),
  ],
);

export const customDevelopmentProjects = pgTable(
  "custom_development_projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    requestId: uuid("request_id").notNull(),
    projectKey: varchar("project_key", { length: 100 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("PLANNED"),
    assignedTeam: varchar("assigned_team", { length: 150 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "custom_development_projects_request_fk",
      columns: [table.organizationId, table.requestId],
      foreignColumns: [
        customDevelopmentRequests.organizationId,
        customDevelopmentRequests.id,
      ],
    }).onDelete("cascade"),
    unique("custom_development_projects_org_key_unique").on(
      table.organizationId,
      table.projectKey,
    ),
    unique("custom_development_projects_org_id_id_unique").on(
      table.organizationId,
      table.id,
    ),
  ],
);

export const customDevelopmentReleases = pgTable(
  "custom_development_releases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    version: varchar("version", { length: 50 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("PLANNED"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (table) => [
    foreignKey({
      name: "custom_development_releases_project_fk",
      columns: [table.organizationId, table.projectId],
      foreignColumns: [
        customDevelopmentProjects.organizationId,
        customDevelopmentProjects.id,
      ],
    }).onDelete("cascade"),
    unique("custom_development_releases_project_version_unique").on(
      table.organizationId,
      table.projectId,
      table.version,
    ),
  ],
);

export const customDevelopmentHistory = pgTable(
  "custom_development_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    requestId: uuid("request_id").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    fromStatus: customDevelopmentStatus("from_status"),
    toStatus: customDevelopmentStatus("to_status").notNull(),
    occurredAt: createdAt(),
    details: jsonObject("details"),
  },
  (table) => [
    foreignKey({
      name: "custom_development_history_request_fk",
      columns: [table.organizationId, table.requestId],
      foreignColumns: [
        customDevelopmentRequests.organizationId,
        customDevelopmentRequests.id,
      ],
    }).onDelete("cascade"),
    index("custom_development_history_org_time_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    action: varchar("action", { length: 150 }).notNull(),
    resource: varchar("resource", { length: 150 }).notNull(),
    resourceId: varchar("resource_id", { length: 200 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    requestMetadata: jsonObject("request_metadata"),
    beforeState: jsonb("before_state").$type<unknown>(),
    afterState: jsonb("after_state").$type<unknown>(),
    result: auditResult("result").notNull(),
  },
  (table) => [
    index("audit_logs_org_time_idx").on(table.organizationId, table.occurredAt),
    index("audit_logs_auth_time_idx")
      .on(table.occurredAt)
      .where(sql`${table.resource} = 'authentication'`),
    index("audit_logs_org_resource_idx").on(
      table.organizationId,
      table.resource,
      table.resourceId,
    ),
  ],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    keyHash: varchar("key_hash", { length: 64 }).primaryKey(),
    organizationId: uuid("organization_id"),
    branchId: uuid("branch_id"),
    hitCount: integer("hit_count").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("rate_limit_buckets_expiry_idx").on(table.expiresAt),
    check(
      "rate_limit_buckets_hash_check",
      sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("rate_limit_buckets_hits_check", sql`${table.hitCount} > 0`),
  ],
);

export const eventProcessingRecords = pgTable(
  "event_processing_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    eventId: uuid("event_id").notNull(),
    eventType: varchar("event_type", { length: 150 }).notNull(),
    handlerName: varchar("handler_name", { length: 150 }).notNull(),
    eventVersion: integer("event_version").notNull(),
    status: varchar("status", { length: 20 })
      .$type<EventProcessingStatus>()
      .notNull()
      .default("PROCESSING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    failureKind: varchar("failure_kind", {
      length: 40,
    }).$type<EventFailureKind>(),
    lastError: varchar("last_error", { length: 2_000 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "event_processing_records_outbox_fk",
      columns: [table.organizationId, table.eventId],
      foreignColumns: [outboxEvents.organizationId, outboxEvents.id],
    }).onDelete("restrict"),
    unique("event_processing_records_event_handler_unique").on(
      table.eventId,
      table.handlerName,
    ),
    index("event_processing_records_org_status_idx").on(
      table.organizationId,
      table.status,
      table.nextAttemptAt,
    ),
    check(
      "event_processing_records_attempts_nonnegative",
      sql`${table.attempts} >= 0`,
    ),
    check(
      "event_processing_records_status_check",
      sql`${table.status} in ('PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTERED')`,
    ),
  ],
);

export const eventDeadLetters = pgTable(
  "event_dead_letters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    eventId: uuid("event_id").notNull(),
    eventType: varchar("event_type", { length: 150 }).notNull(),
    handlerName: varchar("handler_name", { length: 150 }).notNull(),
    failureKind: varchar("failure_kind", { length: 40 })
      .$type<EventFailureKind>()
      .notNull(),
    failureReason: varchar("failure_reason", { length: 2_000 }).notNull(),
    attempts: integer("attempts").notNull(),
    deadLetteredAt: timestamp("dead_lettered_at", {
      withTimezone: true,
    }).notNull(),
    replayedAt: timestamp("replayed_at", { withTimezone: true }),
    replayCount: integer("replay_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "event_dead_letters_outbox_fk",
      columns: [table.organizationId, table.eventId],
      foreignColumns: [outboxEvents.organizationId, outboxEvents.id],
    }).onDelete("restrict"),
    unique("event_dead_letters_event_handler_unique").on(
      table.eventId,
      table.handlerName,
    ),
    index("event_dead_letters_org_time_idx").on(
      table.organizationId,
      table.deadLetteredAt,
    ),
    check(
      "event_dead_letters_attempts_nonnegative",
      sql`${table.attempts} >= 0 and ${table.replayCount} >= 0`,
    ),
  ],
);

export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id").notNull(),
    endpointUrl: varchar("endpoint_url", { length: 2_048 }).notNull(),
    description: varchar("description", { length: 256 }),
    eventTypes: jsonb("event_types").$type<string[]>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<WebhookSubscriptionStatus>()
      .notNull()
      .default("DISABLED"),
    signingSecretReference: varchar("signing_secret_reference", {
      length: 500,
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("webhook_subscriptions_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      name: "webhook_subscriptions_integration_fk",
      columns: [table.organizationId, table.integrationId],
      foreignColumns: [integrations.organizationId, integrations.id],
    }).onDelete("cascade"),
    index("webhook_subscriptions_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    check(
      "webhook_subscriptions_event_types_check",
      sql`jsonb_typeof(${table.eventTypes}) = 'array' and jsonb_array_length(${table.eventTypes}) between 1 and 100`,
    ),
    check(
      "webhook_subscriptions_endpoint_https_check",
      sql`${table.endpointUrl} like 'https://%'`,
    ),
    check(
      "webhook_subscriptions_status_check",
      sql`${table.status} in ('ACTIVE', 'DISABLED')`,
    ),
    check(
      "webhook_subscriptions_active_secret_check",
      sql`${table.status} <> 'ACTIVE' or ${table.signingSecretReference} is not null`,
    ),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subscriptionId: uuid("subscription_id").notNull(),
    eventId: uuid("event_id").notNull(),
    eventType: varchar("event_type", { length: 150 }).notNull(),
    status: varchar("status", { length: 20 })
      .$type<WebhookDeliveryStatus>()
      .notNull()
      .default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastHttpStatus: integer("last_http_status"),
    lastFailureCode: varchar("last_failure_code", { length: 80 }),
    responseMetadata: jsonb("response_metadata")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("webhook_deliveries_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("webhook_deliveries_event_subscription_unique").on(
      table.eventId,
      table.subscriptionId,
    ),
    foreignKey({
      name: "webhook_deliveries_subscription_fk",
      columns: [table.organizationId, table.subscriptionId],
      foreignColumns: [
        webhookSubscriptions.organizationId,
        webhookSubscriptions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "webhook_deliveries_outbox_fk",
      columns: [table.organizationId, table.eventId],
      foreignColumns: [outboxEvents.organizationId, outboxEvents.id],
    }).onDelete("restrict"),
    index("webhook_deliveries_org_status_retry_idx").on(
      table.organizationId,
      table.status,
      table.nextAttemptAt,
    ),
    check(
      "webhook_deliveries_status_check",
      sql`${table.status} in ('PENDING', 'PROCESSING', 'RETRYING', 'DELIVERED', 'DEAD_LETTERED', 'CANCELLED')`,
    ),
    check(
      "webhook_deliveries_attempts_check",
      sql`${table.attemptCount} >= 0 and ${table.maxAttempts} between 1 and 20`,
    ),
    check(
      "webhook_deliveries_response_metadata_size_check",
      sql`octet_length(${table.responseMetadata}::text) <= 4096`,
    ),
  ],
);

export const webhookDeliveryAttempts = pgTable(
  "webhook_delivery_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    deliveryId: uuid("delivery_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: varchar("status", { length: 20 })
      .$type<WebhookAttemptStatus>()
      .notNull(),
    httpStatus: integer("http_status"),
    failureCode: varchar("failure_code", { length: 80 }),
    responseMetadata: jsonb("response_metadata")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "webhook_delivery_attempts_delivery_fk",
      columns: [table.organizationId, table.deliveryId],
      foreignColumns: [webhookDeliveries.organizationId, webhookDeliveries.id],
    }).onDelete("restrict"),
    unique("webhook_delivery_attempts_delivery_number_unique").on(
      table.deliveryId,
      table.attemptNumber,
    ),
    index("webhook_delivery_attempts_org_delivery_idx").on(
      table.organizationId,
      table.deliveryId,
    ),
    check(
      "webhook_delivery_attempts_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
    check(
      "webhook_delivery_attempts_status_check",
      sql`${table.status} in ('IN_PROGRESS', 'CANCELLED', 'DELIVERED', 'RETRYING', 'FAILED', 'DEAD_LETTERED')`,
    ),
    check(
      "webhook_delivery_attempts_response_metadata_size_check",
      sql`octet_length(${table.responseMetadata}::text) <= 4096`,
    ),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id"),
    createdByUserId: uuid("created_by_user_id"),
    jobType: varchar("job_type", { length: 100 }).notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),
    status: jobStatus("status").notNull().default("QUEUED"),
    priority: integer("priority").notNull().default(0),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: varchar("lease_owner", { length: 150 }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 100 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("jobs_org_id_unique").on(table.organizationId, table.id),
    uniqueIndex("jobs_idempotency_unique")
      .on(table.organizationId, table.jobType, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("jobs_claim_idx").on(
      table.organizationId,
      table.status,
      table.nextAttemptAt,
      table.priority,
      table.createdAt,
    ),
    index("jobs_lease_idx").on(
      table.organizationId,
      table.status,
      table.leaseExpiresAt,
    ),
    check(
      "jobs_attempt_limits_check",
      sql`${table.attempts} >= 0 and ${table.maxAttempts} between 1 and 20 and ${table.attempts} <= ${table.maxAttempts}`,
    ),
    check("jobs_priority_check", sql`${table.priority} between 0 and 100`),
    check(
      "jobs_payload_size_check",
      sql`octet_length(${table.payload}::text) <= 65536`,
    ),
    check(
      "jobs_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "jobs_lease_state_check",
      sql`(${table.status} = 'RUNNING' and ${table.leaseOwner} is not null and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null)
        or (${table.status} <> 'RUNNING' and ${table.leaseOwner} is null and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null)`,
    ),
    foreignKey({
      name: "jobs_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "jobs_creator_membership_fk",
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    }).onDelete("restrict"),
  ],
);

export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    jobId: uuid("job_id").notNull(),
    attempt: integer("attempt").notNull(),
    workerId: varchar("worker_id", { length: 150 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    outcome: varchar("outcome", { length: 20 }).notNull().default("RUNNING"),
    errorCode: varchar("error_code", { length: 100 }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "job_attempts_job_fk",
      columns: [table.organizationId, table.jobId],
      foreignColumns: [jobs.organizationId, jobs.id],
    }).onDelete("cascade"),
    unique("job_attempts_job_attempt_unique").on(
      table.organizationId,
      table.jobId,
      table.attempt,
    ),
    index("job_attempts_org_job_idx").on(
      table.organizationId,
      table.jobId,
      table.attempt,
    ),
    check(
      "job_attempts_outcome_check",
      sql`${table.outcome} in ('RUNNING', 'SUCCEEDED', 'RETRY_WAIT', 'FAILED', 'ABANDONED')`,
    ),
    check("job_attempts_attempt_positive", sql`${table.attempt} > 0`),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id"),
    recipientUserId: uuid("recipient_user_id").notNull(),
    createdByUserId: uuid("created_by_user_id"),
    notificationType: varchar("notification_type", { length: 100 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body").notNull(),
    metadata: jsonObject("metadata"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("notifications_org_id_unique").on(table.organizationId, table.id),
    foreignKey({
      name: "notifications_recipient_membership_fk",
      columns: [table.organizationId, table.recipientUserId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "notifications_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "notifications_creator_membership_fk",
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    }).onDelete("restrict"),
    index("notifications_recipient_read_idx").on(
      table.organizationId,
      table.recipientUserId,
      table.readAt,
      table.createdAt,
    ),
    check(
      "notifications_body_size_check",
      sql`octet_length(${table.body}) <= 16384 and octet_length(${table.metadata}::text) <= 16384`,
    ),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    notificationId: uuid("notification_id").notNull(),
    channel: notificationChannel("channel").notNull(),
    status: notificationDeliveryStatus("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 100 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "notification_deliveries_notification_fk",
      columns: [table.organizationId, table.notificationId],
      foreignColumns: [notifications.organizationId, notifications.id],
    }).onDelete("cascade"),
    unique("notification_deliveries_channel_unique").on(
      table.organizationId,
      table.notificationId,
      table.channel,
    ),
    index("notification_deliveries_queue_idx").on(
      table.organizationId,
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
    check(
      "notification_deliveries_attempts_nonnegative",
      sql`${table.attempts} >= 0`,
    ),
  ],
);

export const communicationProviderConfigs = pgTable(
  "communication_provider_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id").notNull(),
    channel: communicationChannel("channel").notNull(),
    providerKey: varchar("provider_key", { length: 80 }).notNull(),
    status: varchar("status", { length: 20 })
      .$type<"ACTIVE" | "DISABLED">()
      .notNull()
      .default("DISABLED"),
    configuration: jsonObject("configuration"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("communication_provider_configs_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("communication_provider_configs_integration_unique").on(
      table.organizationId,
      table.integrationId,
    ),
    foreignKey({
      name: "communication_provider_configs_integration_fk",
      columns: [table.organizationId, table.integrationId],
      foreignColumns: [integrations.organizationId, integrations.id],
    }).onDelete("restrict"),
    index("communication_provider_configs_org_channel_idx").on(
      table.organizationId,
      table.channel,
      table.status,
    ),
    check(
      "communication_provider_configs_status_check",
      sql`${table.status} in ('ACTIVE', 'DISABLED')`,
    ),
    check(
      "communication_provider_configs_configuration_size_check",
      sql`octet_length(${table.configuration}::text) <= 16384`,
    ),
  ],
);

export const communicationTemplates = pgTable(
  "communication_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 100 }).notNull(),
    channel: communicationChannel("channel").notNull(),
    status: varchar("status", { length: 20 })
      .$type<"ACTIVE" | "INACTIVE">()
      .notNull()
      .default("ACTIVE"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("communication_templates_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("communication_templates_org_channel_key_unique").on(
      table.organizationId,
      table.channel,
      table.key,
    ),
    index("communication_templates_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const communicationTemplateVersions = pgTable(
  "communication_template_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    templateId: uuid("template_id").notNull(),
    version: integer("version").notNull(),
    locale: varchar("locale", { length: 35 }).notNull(),
    subject: varchar("subject", { length: 250 }),
    body: text("body").notNull(),
    variables: jsonb("variables").$type<string[]>().notNull().default([]),
    status: varchar("status", { length: 20 })
      .$type<CommunicationTemplateStatus>()
      .notNull()
      .default("DRAFT"),
    createdAt: createdAt(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "communication_template_versions_template_fk",
      columns: [table.organizationId, table.templateId],
      foreignColumns: [
        communicationTemplates.organizationId,
        communicationTemplates.id,
      ],
    }).onDelete("cascade"),
    unique("communication_template_versions_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("communication_template_versions_template_version_locale_unique").on(
      table.organizationId,
      table.templateId,
      table.version,
      table.locale,
    ),
    uniqueIndex("communication_template_versions_one_published_locale_idx")
      .on(table.organizationId, table.templateId, table.locale)
      .where(sql`${table.status} = 'PUBLISHED'`),
    index("communication_template_versions_org_locale_status_idx").on(
      table.organizationId,
      table.locale,
      table.status,
    ),
    check(
      "communication_template_versions_version_check",
      sql`${table.version} > 0`,
    ),
    check(
      "communication_template_versions_body_size_check",
      sql`octet_length(${table.body}) <= 16384 and octet_length(coalesce(${table.subject}, '')) <= 1000 and octet_length(${table.variables}::text) <= 8192`,
    ),
  ],
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    channel: communicationChannel("channel").notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    enabled: boolean("enabled").notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "notification_preferences_user_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    }).onDelete("cascade"),
    uniqueIndex("notification_preferences_org_default_unique")
      .on(table.organizationId, table.channel, table.category)
      .where(sql`${table.userId} is null`),
    uniqueIndex("notification_preferences_user_unique")
      .on(table.organizationId, table.userId, table.channel, table.category)
      .where(sql`${table.userId} is not null`),
    index("notification_preferences_user_channel_idx").on(
      table.organizationId,
      table.userId,
      table.channel,
    ),
  ],
);

export const communicationMessages = pgTable(
  "communication_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    recipientUserId: uuid("recipient_user_id").notNull(),
    channel: communicationChannel("channel").notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    templateVersionId: uuid("template_version_id"),
    subject: varchar("subject", { length: 250 }),
    renderedContent: text("rendered_content").notNull(),
    contentHashSha256: varchar("content_hash_sha256", { length: 64 }).notNull(),
    metadata: jsonObject("metadata"),
    status: varchar("status", { length: 20 })
      .$type<CommunicationStatus>()
      .notNull()
      .default("QUEUED"),
    priority: integer("priority").notNull().default(0),
    correlationId: uuid("correlation_id").notNull(),
    sourceEventId: uuid("source_event_id"),
    idempotencyKey: varchar("idempotency_key", { length: 200 }),
    createdByUserId: uuid("created_by_user_id"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("communication_messages_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("communication_messages_idempotency_unique")
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    foreignKey({
      name: "communication_messages_recipient_membership_fk",
      columns: [table.organizationId, table.recipientUserId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "communication_messages_template_version_fk",
      columns: [table.organizationId, table.templateVersionId],
      foreignColumns: [
        communicationTemplateVersions.organizationId,
        communicationTemplateVersions.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "communication_messages_source_event_fk",
      columns: [table.organizationId, table.sourceEventId],
      foreignColumns: [outboxEvents.organizationId, outboxEvents.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "communication_messages_creator_membership_fk",
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    }).onDelete("restrict"),
    index("communication_messages_org_status_schedule_idx").on(
      table.organizationId,
      table.status,
      table.scheduledAt,
    ),
    index("communication_messages_recipient_created_idx").on(
      table.organizationId,
      table.recipientUserId,
      table.createdAt,
    ),
    check(
      "communication_messages_status_check",
      sql`${table.status} in ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'RETRYING', 'DEAD_LETTER', 'CANCELLED')`,
    ),
    check(
      "communication_messages_content_size_check",
      sql`octet_length(${table.renderedContent}) <= 16384 and octet_length(coalesce(${table.subject}, '')) <= 1000 and octet_length(${table.metadata}::text) <= 16384`,
    ),
    check(
      "communication_messages_priority_check",
      sql`${table.priority} between 0 and 100`,
    ),
    check(
      "communication_messages_content_hash_check",
      sql`${table.contentHashSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const communicationDeliveries = pgTable(
  "communication_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(),
    providerConfigId: uuid("provider_config_id"),
    status: varchar("status", { length: 20 })
      .$type<CommunicationStatus>()
      .notNull()
      .default("QUEUED"),
    providerMessageId: varchar("provider_message_id", { length: 200 }),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastFailureClass: varchar("last_failure_class", { length: 30 }),
    lastFailureCode: varchar("last_failure_code", { length: 80 }),
    retryAfterSeconds: integer("retry_after_seconds"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("communication_deliveries_org_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("communication_deliveries_message_unique").on(
      table.organizationId,
      table.messageId,
    ),
    foreignKey({
      name: "communication_deliveries_message_fk",
      columns: [table.organizationId, table.messageId],
      foreignColumns: [
        communicationMessages.organizationId,
        communicationMessages.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "communication_deliveries_provider_config_fk",
      columns: [table.organizationId, table.providerConfigId],
      foreignColumns: [
        communicationProviderConfigs.organizationId,
        communicationProviderConfigs.id,
      ],
    }).onDelete("restrict"),
    index("communication_deliveries_queue_idx").on(
      table.organizationId,
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
    check(
      "communication_deliveries_status_check",
      sql`${table.status} in ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'RETRYING', 'DEAD_LETTER', 'CANCELLED')`,
    ),
    check(
      "communication_deliveries_attempts_check",
      sql`${table.attemptCount} >= 0 and ${table.maxAttempts} between 1 and 20`,
    ),
    check(
      "communication_deliveries_retry_after_check",
      sql`${table.retryAfterSeconds} is null or ${table.retryAfterSeconds} between 0 and 86400`,
    ),
  ],
);

export const communicationDeliveryAttempts = pgTable(
  "communication_delivery_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    deliveryId: uuid("delivery_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: varchar("status", { length: 20 })
      .$type<CommunicationAttemptStatus>()
      .notNull(),
    providerMessageId: varchar("provider_message_id", { length: 200 }),
    failureClass: varchar("failure_class", { length: 30 }),
    failureCode: varchar("failure_code", { length: 80 }),
    retryAfterSeconds: integer("retry_after_seconds"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "communication_delivery_attempts_delivery_fk",
      columns: [table.organizationId, table.deliveryId],
      foreignColumns: [
        communicationDeliveries.organizationId,
        communicationDeliveries.id,
      ],
    }).onDelete("cascade"),
    unique("communication_delivery_attempts_number_unique").on(
      table.organizationId,
      table.deliveryId,
      table.attemptNumber,
    ),
    index("communication_delivery_attempts_org_delivery_idx").on(
      table.organizationId,
      table.deliveryId,
    ),
    check(
      "communication_delivery_attempts_status_check",
      sql`${table.status} in ('SENDING', 'SENT', 'DELIVERED', 'RETRYING', 'FAILED', 'DEAD_LETTER')`,
    ),
    check(
      "communication_delivery_attempts_number_check",
      sql`${table.attemptNumber} > 0`,
    ),
    check(
      "communication_delivery_attempts_retry_after_check",
      sql`${table.retryAfterSeconds} is null or ${table.retryAfterSeconds} between 0 and 86400`,
    ),
  ],
);

export const storedObjects = pgTable(
  "stored_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id"),
    createdByUserId: uuid("created_by_user_id"),
    originalFilename: varchar("original_filename", { length: 255 }).notNull(),
    storageKey: varchar("storage_key", { length: 100 }).notNull(),
    mimeType: varchar("mime_type", { length: 127 }).notNull(),
    byteSize: integer("byte_size").notNull(),
    checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
    provider: storedObjectProvider("provider").notNull(),
    status: storedObjectStatus("status").notNull().default("ACTIVE"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("stored_objects_org_id_unique").on(table.organizationId, table.id),
    unique("stored_objects_key_unique").on(
      table.organizationId,
      table.storageKey,
    ),
    foreignKey({
      name: "stored_objects_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "stored_objects_creator_membership_fk",
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    }).onDelete("restrict"),
    index("stored_objects_org_status_idx").on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    check(
      "stored_objects_size_check",
      sql`${table.byteSize} between 1 and 10485760`,
    ),
    check(
      "stored_objects_checksum_check",
      sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const searchDocuments = pgTable(
  "search_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id"),
    indexName: varchar("index_name", { length: 100 }).notNull(),
    documentId: varchar("document_id", { length: 200 }).notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    body: text("body").notNull(),
    metadata: jsonObject("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("search_documents_org_id_unique").on(table.organizationId, table.id),
    unique("search_documents_identity_unique").on(
      table.organizationId,
      table.indexName,
      table.documentId,
    ),
    foreignKey({
      name: "search_documents_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branches.organizationId, branches.id],
    }).onDelete("restrict"),
    index("search_documents_owner_idx").on(
      table.organizationId,
      table.indexName,
      table.documentId,
    ),
    index("search_documents_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${table.title}, '') || ' ' || coalesce(${table.body}, ''))`,
    ),
    check(
      "search_documents_size_check",
      sql`octet_length(${table.body}) <= 65536 and octet_length(${table.metadata}::text) <= 16384`,
    ),
  ],
);
