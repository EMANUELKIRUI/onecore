import { describe, expect, it } from "vitest";
import {
  customFieldTypes,
  canTransitionOrganizationStatus,
  canTransitionUserAccountStatus,
  branchStatusSchema,
  membershipBranchAccessModeSchema,
  deploymentTypeSchema,
  createPermissionKey,
  permissionDefinitionSchema,
  canTransitionModuleLifecycle,
  compareSemanticVersions,
  moduleManifestSchema,
  resolveModuleAccess,
  resolveModuleActivationOrder,
  validateModuleDependencyGraph,
  organizationStatusSchema,
  parseCustomFieldValue,
  resolveConfigurationCapabilities,
  createDomainEvent,
  eventRegistry,
  parseDomainEvent,
  enqueueJobSchema,
  notificationInputSchema,
  searchRequestSchema,
  storageUploadMetadataSchema,
  defaultOrganizationRoleTemplates,
  organizationSelfServicePermissionKeys,
  permissionCatalog,
  customerCreateInputSchema,
  customerUpdateInputSchema,
  catalogPriceInputSchema,
  businessProfilePatchSchema,
  catalogItemCreateInputSchema,
  catalogItemUpdateInputSchema,
  catalogListQuerySchema,
  workflowTriggerEventTypes,
} from "../src/index.js";

describe("platform domain values", () => {
  it("validates customer and catalog input without monetary float coercion", () => {
    expect(
      customerCreateInputSchema.parse({
        name: "  Acme Ltd ",
        customerType: "BUSINESS",
        email: " SALES@ACME.EXAMPLE ",
        reference: "ac-1",
      }),
    ).toMatchObject({
      name: "Acme Ltd",
      email: "sales@acme.example",
      reference: "AC-1",
      status: "ACTIVE",
    });
    expect(() =>
      customerCreateInputSchema.parse({
        name: " ",
        customerType: "PERSON",
      }),
    ).toThrow();
    expect(() => customerUpdateInputSchema.parse({})).toThrow();
    expect(
      catalogItemCreateInputSchema.parse({
        name: " Consulting ",
        type: "SERVICE",
        unit: "hour",
        price: "0.100001",
        currency: "KES",
      }),
    ).toMatchObject({ name: "Consulting", price: "0.100001" });
    expect(catalogPriceInputSchema.parse("0")).toBe("0");
    expect(catalogPriceInputSchema.parse("999999999999.999999")).toBe(
      "999999999999.999999",
    );
    for (const price of [
      "",
      "-1",
      "1e3",
      "1.1234567",
      "01.00",
      "1000000000000",
    ]) {
      expect(() => catalogPriceInputSchema.parse(price)).toThrow();
      expect(() =>
        catalogItemCreateInputSchema.parse({
          name: "Item",
          type: "PRODUCT",
          unit: "each",
          price,
          currency: "KES",
        }),
      ).toThrow();
    }
    expect(
      catalogItemCreateInputSchema.parse({
        name: "Item",
        type: "PRODUCT",
        unit: "each",
        price: "12.50",
        currency: "KES",
      }).price,
    ).toBe("12.50");
    expect(() =>
      catalogItemUpdateInputSchema.parse({ currency: "BAD" }),
    ).toThrow();
    expect(catalogListQuerySchema.parse({ limit: "25" }).limit).toBe(25);
    expect(() => catalogListQuerySchema.parse({ offset: "-1" })).toThrow();
  });

  it("validates typed business contact and address profile updates", () => {
    expect(
      businessProfilePatchSchema.parse({
        contactEmail: " SALES@ACME.EXAMPLE ",
        contactPhone: "+254700000000",
        website: "https://acme.example",
        countryCode: "KE",
        region: " Nairobi ",
        city: " Nairobi ",
        address: " Central Nairobi ",
      }),
    ).toEqual({
      contactEmail: "sales@acme.example",
      contactPhone: "+254700000000",
      website: "https://acme.example",
      countryCode: "KE",
      region: "Nairobi",
      city: "Nairobi",
      address: "Central Nairobi",
    });
    expect(() => businessProfilePatchSchema.parse({})).toThrow();
    for (const patch of [
      { contactEmail: "not-an-email" },
      { contactPhone: " " },
      { website: "not-a-url" },
      { countryCode: "KEN" },
      { region: " " },
      { city: " " },
      { address: " " },
      { ownerEmail: "private@example.test" },
    ]) {
      expect(() => businessProfilePatchSchema.parse(patch)).toThrow();
    }
  });

  it("keeps Business Manager mutation events outside the workflow trigger allowlist", () => {
    expect(workflowTriggerEventTypes).not.toContain("CUSTOMER_CREATED");
    expect(workflowTriggerEventTypes).not.toContain("CATALOG_ITEM_CREATED");
  });

  it("defines self-only notification permissions without granting notification creation", () => {
    const catalogKeys = new Set(permissionCatalog.map(({ key }) => key));
    for (const key of organizationSelfServicePermissionKeys) {
      expect(catalogKeys.has(key)).toBe(true);
    }
    for (const roleName of [
      "Organization Admin",
      "Manager",
      "Staff",
      "Viewer",
    ]) {
      const role = defaultOrganizationRoleTemplates.find(
        ({ name }) => name === roleName,
      );
      expect(role?.permissionKeys).toEqual(
        expect.arrayContaining([...organizationSelfServicePermissionKeys]),
      );
      expect(role?.permissionKeys).not.toContain(
        "core.organization.notification_inbox.manage",
      );
    }
  });

  it("registers the required versioned platform event contracts", () => {
    expect(Object.keys(eventRegistry).sort()).toEqual(
      [
        "CATALOG_ITEM_CREATED",
        "CATALOG_ITEM_UPDATED",
        "CATALOG_ITEM_DELETED",
        "ORGANIZATION_CREATED",
        "ORGANIZATION_ACTIVATED",
        "ORGANIZATION_APPLICATION_SUBMITTED",
        "ORGANIZATION_STATUS_CHANGED",
        "USER_CREATED",
        "USER_INVITED",
        "USER_ROLE_CHANGED",
        "MODULE_ENABLED",
        "MODULE_DISABLED",
        "CONFIGURATION_CHANGED",
        "CUSTOMER_CREATED",
        "CUSTOMER_UPDATED",
        "CUSTOMER_DELETED",
        "FEATURE_FLAG_CHANGED",
        "JOB_ENQUEUED",
        "JOB_COMPLETED",
        "JOB_FAILED",
        "NOTIFICATION_CREATED",
        "COMMUNICATION_QUEUED",
        "STORAGE_OBJECT_CREATED",
        "STORAGE_OBJECT_DELETED",
        "SEARCH_DOCUMENT_INDEXED",
        "SEARCH_DOCUMENT_DELETED",
      ].sort(),
    );
    expect(
      Object.values(eventRegistry).every(
        ({ version, compatibilityPolicy }) =>
          version === 1 && compatibilityPolicy === "ADDITIVE_ONLY",
      ),
    ).toBe(true);
  });

  it("validates bounded platform-service inputs and excludes secret keys", () => {
    expect(
      enqueueJobSchema.safeParse({
        jobType: "reports.rebuild",
        payload: { reportId: "daily" },
      }).success,
    ).toBe(true);
    expect(
      enqueueJobSchema.safeParse({
        jobType: "reports.rebuild",
        payload: { nested: { access_token: "must-not-persist" } },
      }).success,
    ).toBe(false);
    expect(
      enqueueJobSchema.safeParse({
        jobType: "reports.rebuild",
        payload: { value: "x".repeat(70_000) },
      }).success,
    ).toBe(false);

    expect(
      notificationInputSchema.safeParse({
        recipientUserId: "11111111-1111-4111-8111-111111111111",
        notificationType: "system.notice",
        title: "Notice",
        body: "This is an in-app notice.",
      }).success,
    ).toBe(true);
    expect(
      storageUploadMetadataSchema.safeParse({
        originalFilename: "../private.txt",
        mimeType: "text/plain",
        byteSize: 12,
      }).success,
    ).toBe(false);
    expect(
      searchRequestSchema.safeParse({
        indexName: "documents",
        query: "quarterly report",
        limit: 101,
      }).success,
    ).toBe(false);
  });

  it("creates and validates versioned tenant event envelopes", () => {
    const event = createDomainEvent({
      eventType: "CONFIGURATION_CHANGED",
      organizationId: "11111111-1111-4111-8111-111111111111",
      branchId: "33333333-3333-4333-8333-333333333333",
      actorUserId: "22222222-2222-4222-8222-222222222222",
      correlationId: "44444444-4444-4444-8444-444444444444",
      causationId: "55555555-5555-4555-8555-555555555555",
      aggregateType: "organization_configuration",
      aggregateId: "11111111-1111-4111-8111-111111111111",
      payload: {
        resource: "organization_settings",
        resourceId: "11111111-1111-4111-8111-111111111111",
        changedFields: ["timezone"],
      },
      metadata: { source: "api-test" },
    });

    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.branchId).toBe("33333333-3333-4333-8333-333333333333");
    expect(event.correlationId).toBe("44444444-4444-4444-8444-444444444444");
    expect(event.causationId).toBe("55555555-5555-4555-8555-555555555555");
    expect(event.eventVersion).toBe(1);
    expect(parseDomainEvent(event)).toEqual(event);
    expect(() =>
      createDomainEvent({
        eventType: "CONFIGURATION_CHANGED",
        organizationId: "11111111-1111-4111-8111-111111111111",
        aggregateType: "organization_configuration",
        aggregateId: "11111111-1111-4111-8111-111111111111",
        payload: {
          resource: "organization_settings",
          resourceId: "11111111-1111-4111-8111-111111111111",
          changedFields: [],
          arbitrarySql: "DROP TABLE organizations",
        } as never,
      }),
    ).toThrow();
    expect(() => parseDomainEvent({ ...event, eventVersion: 99 })).toThrow(
      /Unsupported/,
    );
    expect(() =>
      parseDomainEvent({ ...event, metadata: { script: "execute()" } }),
    ).toThrow(/inert/);
    expect(() =>
      parseDomainEvent({ ...event, metadata: { access_token: "sensitive" } }),
    ).toThrow(/inert/);
    expect(() =>
      parseDomainEvent({
        ...event,
        payload: { ...event.payload, password: "sensitive" },
      }),
    ).toThrow();
    expect(() =>
      parseDomainEvent({
        ...event,
        metadata: { note: "x".repeat(65_537) },
      }),
    ).toThrow(/maximum size/);
  });

  it("resolves configuration capabilities consistently for deployment types", () => {
    for (const deploymentType of [
      "SAAS",
      "CUSTOM",
      "DEDICATED",
      "ENTERPRISE",
    ] as const) {
      const capabilities = resolveConfigurationCapabilities(deploymentType);
      expect(capabilities).toEqual({
        deploymentType,
        organizationSettings: true,
        featureFlags: true,
        branchOverrides: true,
        customFields: true,
        workflowMetadata: true,
        notificationPreferences: true,
        integrationMetadata: true,
        customDomains: true,
        externalProviderExecution: false,
        workflowExecution: true,
      });
    }
  });

  it("restricts deployment type and organization lifecycle to platform values", () => {
    expect(deploymentTypeSchema.parse("SAAS")).toBe("SAAS");
    expect(deploymentTypeSchema.parse("DEDICATED")).toBe("DEDICATED");
    expect(() => deploymentTypeSchema.parse("CUSTOMER_FORK")).toThrow();

    for (const status of [
      "PENDING",
      "UNDER_REVIEW",
      "APPROVED",
      "PAYMENT_PENDING",
      "ACTIVE",
      "SUSPENDED",
      "EXPIRED",
      "REJECTED",
      "CANCELLED",
    ]) {
      expect(organizationStatusSchema.parse(status)).toBe(status);
    }
  });

  it("parses all supported custom field value types", () => {
    const values: Record<(typeof customFieldTypes)[number], unknown> = {
      TEXT: "Room preference",
      NUMBER: 12.5,
      BOOLEAN: true,
      DATE: "2026-10-05",
      DATETIME: "2026-10-05T15:00:00Z",
      CURRENCY: { amount: "1250.50", currencyCode: "KES" },
      SELECT: "standard",
      MULTI_SELECT: ["small", "blue"],
      REFERENCE: {
        resource: "customer",
        id: "f279c1aa-53b3-45f1-8cc5-552d4102e7ce",
      },
    };

    for (const fieldType of customFieldTypes) {
      expect(parseCustomFieldValue(fieldType, values[fieldType])).toEqual(
        values[fieldType],
      );
    }
    expect(() => parseCustomFieldValue("NUMBER", Number.NaN)).toThrow();
    expect(() =>
      parseCustomFieldValue("CURRENCY", {
        amount: "12.1234567",
        currencyCode: "KES",
      }),
    ).toThrow();
  });

  it("allows only defined account lifecycle transitions", () => {
    expect(canTransitionUserAccountStatus("PENDING", "ACTIVE")).toBe(true);
    expect(canTransitionUserAccountStatus("ACTIVE", "LOCKED")).toBe(true);
    expect(canTransitionUserAccountStatus("LOCKED", "ACTIVE")).toBe(true);
    expect(canTransitionUserAccountStatus("DISABLED", "ACTIVE")).toBe(false);
    expect(canTransitionUserAccountStatus("PENDING", "SUSPENDED")).toBe(false);
  });

  it("enforces organization transitions and typed branch access values", () => {
    expect(canTransitionOrganizationStatus("PENDING", "UNDER_REVIEW")).toBe(
      true,
    );
    expect(canTransitionOrganizationStatus("ACTIVE", "SUSPENDED")).toBe(true);
    expect(canTransitionOrganizationStatus("SUSPENDED", "ACTIVE")).toBe(true);
    expect(canTransitionOrganizationStatus("REJECTED", "ACTIVE")).toBe(false);
    expect(canTransitionOrganizationStatus("CANCELLED", "ACTIVE")).toBe(false);
    expect(branchStatusSchema.parse("CLOSED")).toBe("CLOSED");
    expect(membershipBranchAccessModeSchema.parse("ASSIGNED")).toBe("ASSIGNED");
    expect(membershipBranchAccessModeSchema.parse("ALL")).toBe("ALL");
  });

  it("builds deterministic permission keys from validated module resources and actions", () => {
    expect(createPermissionKey("sales", "sale", "create")).toBe(
      "sales.sale.create",
    );
    expect(createPermissionKey("core.organization", "settings", "update")).toBe(
      "core.organization.settings.update",
    );
    expect(
      permissionDefinitionSchema.parse({
        module: "inventory",
        resource: "stock-item",
        action: "adjust",
      }).key,
    ).toBe("inventory.stock-item.adjust");
    expect(() => createPermissionKey("Sales", "sale", "create")).toThrow();
    expect(() => createPermissionKey("sales", "sale.create", "read")).toThrow();
    expect(() => createPermissionKey("sales", "sale", "read all")).toThrow();
  });

  it("validates manifests, canonical permissions, and semantic versions", () => {
    const manifest = moduleManifestSchema.parse({
      name: "core.reporting",
      version: "1.2.3",
      displayName: "Reporting",
      dependencies: [
        { moduleName: "core.organization", minimumVersion: "1.0.0" },
      ],
      permissions: ["core.reporting.report.read"],
      features: ["scheduled"],
      lifecycle: "DEVELOPMENT",
    });
    expect(manifest.name).toBe("core.reporting");
    expect(() =>
      moduleManifestSchema.parse({
        ...manifest,
        version: "1.2",
      }),
    ).toThrow();
    expect(() =>
      moduleManifestSchema.parse({
        ...manifest,
        permissions: ["not canonical"],
      }),
    ).toThrow();
    expect(compareSemanticVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareSemanticVersions("1.2.0-beta.2", "1.2.0")).toBe(-1);
    expect(
      compareSemanticVersions(
        "999999999999999999999.0.0",
        "999999999999999999998.0.0",
      ),
    ).toBe(1);
  });

  it("allows only sequential module lifecycle transitions", () => {
    expect(
      canTransitionModuleLifecycle("DEVELOPMENT", "INTERNAL_TESTING"),
    ).toBe(true);
    expect(canTransitionModuleLifecycle("DEVELOPMENT", "AVAILABLE")).toBe(
      false,
    );
    expect(canTransitionModuleLifecycle("DEPRECATED", "RETIRED")).toBe(true);
    expect(canTransitionModuleLifecycle("RETIRED", "AVAILABLE")).toBe(false);
  });

  it("resolves dependencies deterministically and rejects missing, cyclic, or old dependencies", () => {
    const modules = [
      {
        name: "core.foundation",
        version: "2.0.0",
        lifecycle: "AVAILABLE" as const,
        dependencies: [],
      },
      {
        name: "core.analytics",
        version: "1.0.0",
        lifecycle: "AVAILABLE" as const,
        dependencies: [
          { moduleName: "core.foundation", minimumVersion: "1.5.0" },
        ],
      },
    ];
    expect(resolveModuleActivationOrder(modules, "core.analytics")).toEqual([
      "core.foundation",
      "core.analytics",
    ]);
    expect(() =>
      resolveModuleActivationOrder(
        [{ ...modules[1]!, dependencies: [{ moduleName: "missing.module" }] }],
        "core.analytics",
      ),
    ).toThrow("MODULE_NOT_FOUND");
    expect(() =>
      validateModuleDependencyGraph([
        {
          ...modules[0]!,
          dependencies: [{ moduleName: "core.analytics" }],
        },
        modules[1]!,
      ]),
    ).toThrow("DEPENDENCY_CYCLE");
    expect(() =>
      resolveModuleActivationOrder(
        [
          modules[0]!,
          {
            ...modules[1]!,
            dependencies: [
              { moduleName: "core.foundation", minimumVersion: "3.0.0" },
            ],
          },
        ],
        "core.analytics",
      ),
    ).toThrow("DEPENDENCY_VERSION_UNSATISFIED");
  });

  it("fails closed for unregistered, unavailable, disabled, unentitled, or dependency-broken modules", () => {
    const eligible = {
      registered: true,
      lifecycle: "AVAILABLE" as const,
      isAvailable: true,
      entitlementStatus: "ENABLED" as const,
      planAllowsModule: true,
      dependenciesEnabled: true,
    };
    expect(resolveModuleAccess(eligible)).toEqual({ allowed: true });
    expect(resolveModuleAccess({ ...eligible, lifecycle: "QA" })).toEqual({
      allowed: false,
      reason: "MODULE_UNAVAILABLE",
    });
    expect(
      resolveModuleAccess({ ...eligible, entitlementStatus: "DISABLED" }),
    ).toEqual({
      allowed: false,
      reason: "MODULE_DISABLED",
    });
    expect(
      resolveModuleAccess({ ...eligible, entitlementStatus: null }),
    ).toEqual({
      allowed: false,
      reason: "NOT_ENTITLED",
    });
    expect(
      resolveModuleAccess({ ...eligible, planAllowsModule: false }),
    ).toEqual({
      allowed: false,
      reason: "SUBSCRIPTION_NOT_ALLOWED",
    });
    expect(
      resolveModuleAccess({ ...eligible, dependenciesEnabled: false }),
    ).toEqual({
      allowed: false,
      reason: "DEPENDENCY_NOT_SATISFIED",
    });
  });
});
