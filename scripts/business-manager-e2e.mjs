import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import process from "node:process";
import { Algorithm, hash as hashPassword } from "@node-rs/argon2";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chromium, expect } from "playwright/test";
import { moduleManifestSchema } from "@onecore/core-domain";
import { generateTotpCode } from "../services/api/dist/identity-security.js";
import {
  branches,
  createDatabase,
  businessSettings,
  inventoryReservations,
  membershipBranches,
  membershipRoles,
  modulePermissions,
  moduleVersions,
  modules,
  organizationMemberships,
  organizationModules,
  ownerCredentialSetupTokens,
  organizations,
  permissions,
  planModules,
  platformUserRoles,
  supportRequests,
  supportRootAdministrators,
  plans,
  rolePermissions,
  roles,
  sales,
  sessions,
  subscriptionItems,
  subscriptions,
  users,
} from "@onecore/database";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const containerName = `onecore-business-e2e-${randomUUID().slice(0, 8)}`;
const databasePassword = "onecore_e2e_only";
const appPassword = "onecore_app_test";
const migratorPassword = "onecore_migrator_test";
const workerPassword = "onecore_worker_test";
const mfaEncryptionKey = randomBytes(32).toString("base64url");
const testPassword = "Synthetic-E2E-Password-2026";
const organizationName = "Isolated E2E Organization";
const ownerEmail = "e2e-owner@onecore.test";
const memberEmail = "e2e-member@onecore.test";
const viewerEmail = "e2e-viewer@onecore.test";
const foreignEmail = "e2e-foreign@onecore.test";
const platformAdminEmail = "e2e-platform-admin@onecore.test";
const supportUserEmail = "e2e-support@onecore.test";
const applicationOwnerEmail = "e2e-new-owner@onecore.test";
const e2eMfaSecrets = new Map();
const branchPermissionKeys = [
  "core.organization.branch.read",
  "core.organization.branch.create",
  "core.organization.branch.update",
  "core.organization.membership_branch.read",
  "core.organization.membership_branch.assign",
  "core.organization.membership_branch.remove",
];
const expectedMigrationNames = [
  "20261010020000_branch_administration_contract",
  "20261010030000_membership_branch_assignment_contract",
  "20261010040000_branch_permission_backfill_repair",
  "20261010140000_session_revoked_at_insert_grant",
  "20261012092151_orange_proudstar",
  "20261012092652_safe_iron_lad",
  "20261012110014_owner_credential_setup",
  "20261014222000_support_workspace",
];
const ownerPermissionKeys = [
  ...branchPermissionKeys,
  "core.business_manager.customer.create",
  "core.business_manager.customer.read",
  "core.business_manager.customer.update",
  "core.business_manager.customer.delete",
  "core.business_manager.catalog.create",
  "core.business_manager.catalog.read",
  "core.business_manager.catalog.update",
  "core.business_manager.catalog.delete",
  "core.rbac.role.read",
  "core.rbac.membership_role.assign",
  "core.rbac.membership_role.remove",
  "core.organization.organization.read",
  "core.organization.user.read",
  "core.organization.settings.read",
  "core.organization.settings.update",
  "core.modules.module.read",
  "core.modules.entitlement.read",
  "core.sales.sale.create",
  "core.sales.sale.read",
  "core.sales.sale.cancel",
  "core.inventory.stock.read",
  "core.inventory.stock.adjust",
  "core.inventory.stock.reserve",
  "core.inventory.stock.release",
];
const viewerPermissionKeys = [
  "core.organization.user.read",
  "core.organization.settings.read",
  "core.organization.branch.read",
  "core.organization.membership_branch.read",
  "core.modules.module.read",
  "core.modules.entitlement.read",
  "core.business_manager.customer.read",
  "core.business_manager.catalog.read",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return (result.stdout ?? "").trim();
}

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local test port");
  }
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return address.port;
}

async function waitForContainer(containerId) {
  await waitFor(() => {
    const state = run("docker", [
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      containerId,
    ]);
    if (state === "healthy") return true;
    if (state === "unhealthy")
      throw new Error("PostgreSQL container is unhealthy");
    return false;
  }, "disposable PostgreSQL readiness");
}

function resultRows(result) {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

async function createFixture(database) {
  const [organization] = await database
    .insert(organizations)
    .values({
      name: organizationName,
      slug: "isolated-business-e2e",
      industry: "TEST",
      status: "ACTIVE",
    })
    .returning();
  const [foreignOrganization] = await database
    .insert(organizations)
    .values({
      name: "Isolated Foreign E2E Organization",
      slug: "isolated-business-e2e-foreign",
      industry: "TEST",
      status: "ACTIVE",
    })
    .returning();
  if (!organization || !foreignOrganization) {
    throw new Error("Synthetic organizations were not created");
  }

  const userPasswordHash = await hashPassword(testPassword, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
  const createdUsers = await database
    .insert(users)
    .values([
      {
        email: ownerEmail,
        displayName: "E2E Organization Owner",
        passwordHash: userPasswordHash,
      },
      {
        email: memberEmail,
        displayName: "E2E Branch Member",
        passwordHash: userPasswordHash,
      },
      {
        email: viewerEmail,
        displayName: "E2E Read Only User",
        passwordHash: userPasswordHash,
      },
      {
        email: foreignEmail,
        displayName: "E2E Foreign User",
        passwordHash: userPasswordHash,
      },
      {
        email: platformAdminEmail,
        displayName: "E2E Platform Reviewer",
        passwordHash: userPasswordHash,
      },
      {
        email: supportUserEmail,
        displayName: "E2E Assigned Support",
        passwordHash: userPasswordHash,
      },
    ])
    .returning();
  const owner = createdUsers.find((user) => user.email === ownerEmail);
  const member = createdUsers.find((user) => user.email === memberEmail);
  const viewer = createdUsers.find((user) => user.email === viewerEmail);
  const foreign = createdUsers.find((user) => user.email === foreignEmail);
  const platformAdmin = createdUsers.find(
    (user) => user.email === platformAdminEmail,
  );
  const supportUser = createdUsers.find(
    (user) => user.email === supportUserEmail,
  );
  if (
    !owner ||
    !member ||
    !viewer ||
    !foreign ||
    !platformAdmin ||
    !supportUser
  ) {
    throw new Error("Synthetic users were not created");
  }
  await database.insert(platformUserRoles).values({
    userId: platformAdmin.id,
    role: "SUPERADMIN",
  });
  await database.insert(supportRootAdministrators).values({
    userId: platformAdmin.id,
  });
  const [foreignSupportRequest] = await database
    .insert(supportRequests)
    .values({
      organizationId: foreignOrganization.id,
      createdByUserId: foreign.id,
      subject: "Foreign organization support request",
    })
    .returning();
  if (!foreignSupportRequest) {
    throw new Error("Foreign support request fixture was not created");
  }

  const memberships = await database
    .insert(organizationMemberships)
    .values([
      {
        organizationId: organization.id,
        userId: owner.id,
        status: "ACTIVE",
        branchAccessMode: "ALL",
      },
      {
        organizationId: organization.id,
        userId: member.id,
        status: "ACTIVE",
        branchAccessMode: "ASSIGNED",
      },
      {
        organizationId: organization.id,
        userId: viewer.id,
        status: "ACTIVE",
        branchAccessMode: "ALL",
      },
      {
        organizationId: foreignOrganization.id,
        userId: foreign.id,
        status: "ACTIVE",
        branchAccessMode: "ASSIGNED",
      },
    ])
    .returning();
  const ownerMembership = memberships.find(
    (membership) => membership.userId === owner.id,
  );
  const memberMembership = memberships.find(
    (membership) => membership.userId === member.id,
  );
  const viewerMembership = memberships.find(
    (membership) => membership.userId === viewer.id,
  );
  if (!ownerMembership || !memberMembership || !viewerMembership) {
    throw new Error("Synthetic organization memberships were not created");
  }
  const [checkoutBranch] = await database
    .insert(branches)
    .values({
      organizationId: organization.id,
      name: "E2E Checkout Branch",
      code: "E2E-SALES",
    })
    .returning();
  if (!checkoutBranch)
    throw new Error("Checkout branch fixture was not created");

  const allModuleRows = await database.select().from(modules);
  const coreModuleRows = await database
    .insert(modules)
    .values([
      {
        key: "core.organization",
        name: "Organization Administration",
        lifecycle: "AVAILABLE",
        isAvailable: true,
      },
      {
        key: "core.modules",
        name: "Module Registry and Entitlements",
        lifecycle: "AVAILABLE",
        isAvailable: true,
      },
      {
        key: "core.rbac",
        name: "Role-Based Access Control",
        lifecycle: "AVAILABLE",
        isAvailable: true,
      },
    ])
    .onConflictDoUpdate({
      target: modules.key,
      set: { lifecycle: "AVAILABLE", isAvailable: true },
    })
    .returning();
  const moduleByKey = new Map(
    [...allModuleRows, ...coreModuleRows].map((module) => [module.key, module]),
  );
  const requiredModuleKeys = [
    "core.organization",
    "core.modules",
    "core.rbac",
    "core.business_manager",
    "core.sales",
    "core.inventory",
  ];
  for (const key of requiredModuleKeys) {
    if (!moduleByKey.has(key)) {
      throw new Error(`Required module was not registered: ${key}`);
    }
  }

  const modulePermissionRows = await database
    .select()
    .from(permissions)
    .where(
      inArray(permissions.moduleKey, [
        "core.organization",
        "core.modules",
        "core.rbac",
        "core.business_manager",
        "core.sales",
        "core.inventory",
      ]),
    );
  for (const key of [...ownerPermissionKeys, ...viewerPermissionKeys]) {
    if (!modulePermissionRows.some((permission) => permission.key === key)) {
      throw new Error(
        `Required permission is missing from the catalog: ${key}`,
      );
    }
  }
  for (const moduleKey of ["core.organization", "core.modules", "core.rbac"]) {
    const module = moduleByKey.get(moduleKey);
    if (!module) throw new Error(`Module not found: ${moduleKey}`);
    const selectedPermissions = modulePermissionRows.filter(
      (permission) => permission.moduleKey === moduleKey,
    );
    const manifest = moduleManifestSchema.parse({
      name: moduleKey,
      version: "1.0.0",
      displayName: module.name,
      dependencies: [],
      permissions: selectedPermissions.map((permission) => permission.key),
      features: [],
      lifecycle: "AVAILABLE",
    });
    await database
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
    await database
      .insert(modulePermissions)
      .values(
        selectedPermissions.map((permission) => ({
          moduleId: module.id,
          permissionId: permission.id,
        })),
      )
      .onConflictDoNothing();
  }

  const [plan] = await database
    .insert(plans)
    .values({
      key: "isolated-business-e2e-plan",
      name: "Isolated Business E2E",
      billingInterval: "MONTHLY",
      currencyCode: "KES",
      amount: "0.000000",
      isAvailable: true,
    })
    .returning();
  if (!plan) throw new Error("Synthetic plan was not created");
  await database.insert(planModules).values(
    requiredModuleKeys.map((key) => {
      const module = moduleByKey.get(key);
      if (!module) throw new Error(`Module not found: ${key}`);
      return { planId: plan.id, moduleId: module.id };
    }),
  );
  await database.insert(organizationModules).values(
    requiredModuleKeys.map((key) => {
      const module = moduleByKey.get(key);
      if (!module) throw new Error(`Module not found: ${key}`);
      return {
        organizationId: organization.id,
        moduleId: module.id,
        status: "ENABLED",
        source: "MANUAL",
        enabledAt: new Date(),
      };
    }),
  );
  const [subscription] = await database
    .insert(subscriptions)
    .values({
      organizationId: organization.id,
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60 * 60_000),
    })
    .returning();
  if (!subscription) throw new Error("Synthetic subscription was not created");
  await database.insert(subscriptionItems).values({
    organizationId: organization.id,
    subscriptionId: subscription.id,
    planId: plan.id,
    amount: "0.000000",
    currencyCode: "KES",
  });

  const [ownerRole] = await database
    .insert(roles)
    .values({
      organizationId: organization.id,
      name: "Organization Owner",
      description: "Synthetic E2E owner role",
      status: "ACTIVE",
      isSystem: true,
    })
    .returning();
  const [viewerRole] = await database
    .insert(roles)
    .values({
      organizationId: organization.id,
      name: "E2E Read Only",
      status: "ACTIVE",
      isSystem: false,
    })
    .returning();
  const [managerRole] = await database
    .insert(roles)
    .values({
      organizationId: organization.id,
      name: "E2E Member",
      status: "ACTIVE",
      isSystem: false,
    })
    .returning();
  if (!ownerRole || !viewerRole || !managerRole) {
    throw new Error("Synthetic roles were not created");
  }

  const selectedRolePermissions = modulePermissionRows.filter((permission) =>
    ownerPermissionKeys.includes(permission.key),
  );
  const viewerRolePermissions = selectedRolePermissions.filter((permission) =>
    viewerPermissionKeys.includes(permission.key),
  );
  await database.insert(rolePermissions).values([
    ...selectedRolePermissions.map((permission) => ({
      organizationId: organization.id,
      roleId: ownerRole.id,
      permissionId: permission.id,
      scopeType: "ORGANIZATION",
      scope: {},
    })),
    ...viewerRolePermissions.map((permission) => ({
      organizationId: organization.id,
      roleId: viewerRole.id,
      permissionId: permission.id,
      scopeType: "ORGANIZATION",
      scope: {},
    })),
    ...selectedRolePermissions
      .filter((permission) =>
        [
          "core.organization.user.read",
          "core.organization.membership_branch.read",
        ].includes(permission.key),
      )
      .map((permission) => ({
        organizationId: organization.id,
        roleId: managerRole.id,
        permissionId: permission.id,
        scopeType: "ORGANIZATION",
        scope: {},
      })),
  ]);
  await database.insert(membershipRoles).values([
    {
      organizationId: organization.id,
      membershipId: ownerMembership.id,
      roleId: ownerRole.id,
    },
    {
      organizationId: organization.id,
      membershipId: memberMembership.id,
      roleId: managerRole.id,
    },
    {
      organizationId: organization.id,
      membershipId: viewerMembership.id,
      roleId: viewerRole.id,
    },
  ]);
  await database.insert(businessSettings).values({
    organizationId: organization.id,
  });

  const [foreignBranch] = await database
    .insert(branches)
    .values({
      organizationId: foreignOrganization.id,
      name: "Foreign Tenant Branch",
      code: "FOREIGN",
    })
    .returning();
  if (!foreignBranch) throw new Error("Foreign branch fixture was not created");

  return {
    organizationId: organization.id,
    foreignOrganizationId: foreignOrganization.id,
    supportUserId: supportUser.id,
    foreignSupportRequestId: foreignSupportRequest.id,
    checkoutBranchId: checkoutBranch.id,
    ownerMembershipId: ownerMembership.id,
    memberMembershipId: memberMembership.id,
    foreignBranchId: foreignBranch.id,
  };
}

function createFrontendServer(apiPort) {
  const frontendRoot = resolve(root, "apps/business");
  const registrationRoot = resolve(root, "apps/marketing/register");
  const superadminRoot = resolve(root, "apps/superadmin");
  const supportRoot = resolve(root, "apps/support");
  const uiModuleRoot = resolve(root, "packages/ui/src");
  const uiModules = new Map(
    ["api-client.js", "elements.js", "localization.js", "mfa-login.js"].map(
      (fileName) => [
        `/packages/ui/src/${fileName}`,
        resolve(uiModuleRoot, fileName),
      ],
    ),
  );
  const appModules = new Map(
    ["pos.js", "inventory.js"].map((fileName) => [
      `/${fileName}`,
      resolve(frontendRoot, fileName),
    ]),
  );
  const auxiliaryFiles = new Map([
    [
      "/register/",
      [resolve(registrationRoot, "index.html"), "text/html; charset=utf-8"],
    ],
    [
      "/register/index.html",
      [resolve(registrationRoot, "index.html"), "text/html; charset=utf-8"],
    ],
    [
      "/register/registration.js",
      [
        resolve(registrationRoot, "registration.js"),
        "text/javascript; charset=utf-8",
      ],
    ],
    [
      "/register/application-response.js",
      [
        resolve(registrationRoot, "application-response.js"),
        "text/javascript; charset=utf-8",
      ],
    ],
    [
      "/superadmin/",
      [resolve(superadminRoot, "index.html"), "text/html; charset=utf-8"],
    ],
    [
      "/superadmin/index.html",
      [resolve(superadminRoot, "index.html"), "text/html; charset=utf-8"],
    ],
    [
      "/superadmin/app.js",
      [resolve(superadminRoot, "app.js"), "text/javascript; charset=utf-8"],
    ],
    [
      "/support/",
      [resolve(supportRoot, "index.html"), "text/html; charset=utf-8"],
    ],
    [
      "/support/index.html",
      [resolve(supportRoot, "index.html"), "text/html; charset=utf-8"],
    ],
    [
      "/support/app.js",
      [resolve(supportRoot, "app.js"), "text/javascript; charset=utf-8"],
    ],
    [
      "/setup.html",
      [resolve(frontendRoot, "setup.html"), "text/html; charset=utf-8"],
    ],
    [
      "/setup.js",
      [resolve(frontendRoot, "setup.js"), "text/javascript; charset=utf-8"],
    ],
  ]);
  const stylesheetPath = resolve(root, "packages/ui/styles.css");
  const frontend = createServer(async (request, response) => {
    const requestPath = request.url ?? "/";
    if (requestPath.startsWith("/api/")) {
      const proxiedRequest = httpRequest({
        hostname: "127.0.0.1",
        port: apiPort,
        path: requestPath.slice(4),
        method: request.method,
        headers: request.headers,
      });
      proxiedRequest.on("error", (error) => {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(`API proxy failed: ${error.message}`);
      });
      proxiedRequest.on("response", (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      });
      request.pipe(proxiedRequest);
      return;
    }

    if (requestPath === "/" || requestPath === "/index.html") {
      const html = await readFile(resolve(frontendRoot, "index.html"), "utf8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        html.replace(
          'name="onecore-api-base" content=""',
          'name="onecore-api-base" content="/api"',
        ),
      );
      return;
    }
    const auxiliaryFile = auxiliaryFiles.get(requestPath);
    if (auxiliaryFile) {
      const [filePath, contentType] = auxiliaryFile;
      let body = await readFile(filePath, "utf8");
      if (contentType.startsWith("text/html")) {
        body = body.replace(
          'name="onecore-api-base" content=""',
          'name="onecore-api-base" content="/api"',
        );
      }
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
      return;
    }
    if (requestPath === "/app.js") {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(await readFile(resolve(frontendRoot, "app.js")));
      return;
    }
    const modulePath =
      appModules.get(requestPath) ?? uiModules.get(requestPath);
    if (modulePath) {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(await readFile(modulePath));
      return;
    }
    if (requestPath === "/packages/ui/styles.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end(await readFile(stylesheetPath));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  });
  return frontend;
}

function loginSelectors(page) {
  return {
    email: page.getByLabel("Email address"),
    password: page.locator("#login-password"),
    submit: page.getByRole("button", { name: /Sign in/ }),
  };
}

async function completeMfaLogin(page, loginResponse, accountEmail) {
  assert.equal(
    loginResponse.status(),
    403,
    `privileged login should require MFA; received HTTP ${loginResponse.status()}`,
  );
  const loginBody = await loginResponse.json();
  assert.equal(loginBody.mfa?.required, true);
  assert.equal(loginBody.mfa?.method, "totp");
  assert.ok(
    ["enrollment_required", "challenge_required"].includes(
      loginBody.mfa?.status,
    ),
  );
  const enrollment = loginBody.mfa.status === "enrollment_required";
  const codeField = page.getByLabel("Authenticator code");
  await expect(codeField).toBeVisible();

  if (enrollment) {
    const provisioningUri = await page
      .locator('a[href^="otpauth://totp/"]')
      .getAttribute("href");
    assert.ok(provisioningUri?.startsWith("otpauth://totp/"));
    const secret = new URL(provisioningUri).searchParams.get("secret");
    assert.ok(secret);
    e2eMfaSecrets.set(accountEmail, secret);
    await codeField.fill(generateTotpCode(secret));
  } else {
    const secret = e2eMfaSecrets.get(accountEmail);
    assert.ok(
      secret,
      `No E2E authenticator secret is available for ${accountEmail}`,
    );
    await codeField.fill(generateTotpCode(secret));
  }

  const verificationPath = enrollment
    ? "/api/auth/mfa/enroll"
    : "/api/auth/mfa/challenge";
  const verificationResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(verificationPath) &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", {
      name: enrollment ? "Verify and finish setup" : "Verify and sign in",
    })
    .click();
  const response = await verificationResponse;
  assert.equal(
    response.status(),
    200,
    `MFA verification failed with HTTP ${response.status()}`,
  );
  return response;
}

async function login(page, email, webOrigin, branchId) {
  const selectors = loginSelectors(page);
  await selectors.email.fill(email);
  await selectors.password.fill(testPassword);
  const loginResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/login") &&
      response.request().method() === "POST",
  );
  await selectors.submit.click();
  let response = await loginResponse;
  if (response.status() === 403) {
    response = await completeMfaLogin(page, response, email);
  }
  const sanitizedResponse = await response
    .json()
    .then((body) =>
      JSON.stringify({
        error: body?.error
          ? {
              code: body.error.code,
              message: body.error.message,
            }
          : undefined,
      }),
    )
    .catch(() => "<non-JSON response>");
  assert.equal(
    response.status(),
    200,
    `valid sign-in failed with HTTP ${response.status()}; sanitized response: ${sanitizedResponse}; API output: ${apiOutput}; PostgreSQL output: ${execFileSync("docker", ["logs", containerId], { encoding: "utf8" }).slice(-4_000)}`,
  );
  await expect(page.locator("#app-view")).toBeVisible();
  await page.locator("#organization-select").selectOption({
    label: organizationName,
  });
  await expect(page.locator("#sidebar-organization")).toHaveText(
    organizationName,
  );
  if (branchId) {
    await page.locator("#branch-select").selectOption(branchId);
    await expect(page.locator("#sidebar-branch")).toHaveText(
      "E2E Checkout Branch",
    );
  }
  assert.equal(new URL(page.url()).origin, webOrigin);
}

async function verifyMigrationEvidence(adminDatabase) {
  const ledger = await adminDatabase.execute(
    sql`
      SELECT id, name, hash, created_at
      FROM drizzle.__drizzle_migrations
      WHERE name IN (${sql.join(
        expectedMigrationNames.map((name) => sql`${name}`),
        sql`, `,
      )})
      ORDER BY name
    `,
  );
  const ledgerRows = resultRows(ledger);
  assert.deepEqual(
    ledgerRows.map((row) => row.name),
    expectedMigrationNames,
    "the intended test migrations were recorded exactly once",
  );
  const security = await adminDatabase.execute(
    sql`
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner,
        c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('roles', 'role_permissions', 'branches', 'membership_branches', 'sessions', 'owner_credential_setup_tokens')
      ORDER BY c.relname
    `,
  );
  const securityRows = resultRows(security);
  assert.equal(securityRows.length, 6);
  assert.ok(
    securityRows.every(
      (row) =>
        row.owner === "onecore_migrator" && row.rls_enabled && row.rls_forced,
    ),
  );
  const policies = await adminDatabase.execute(
    sql`
      SELECT count(*)::int AS total
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('roles', 'role_permissions', 'branches', 'membership_branches', 'owner_credential_setup_tokens')
    `,
  );
  const policyRows = resultRows(policies);
  assert.ok(policyRows[0]?.total > 0, "tenant policies exist");
  const roleFlags = await adminDatabase.execute(
    sql`
      SELECT count(*)::int AS total
      FROM pg_roles
      WHERE rolname IN ('onecore_app', 'onecore_migrator', 'onecore_worker')
        AND NOT rolsuper AND NOT rolbypassrls
    `,
  );
  const roleFlagRows = resultRows(roleFlags);
  assert.equal(roleFlagRows[0]?.total, 3);
  const sessionPrivileges = await adminDatabase.execute(
    sql`
      SELECT has_table_privilege('onecore_app', 'sessions', 'SELECT')
        AS can_read_sessions,
        has_table_privilege('onecore_app', 'sessions', 'INSERT')
        AS can_insert_all_session_columns,
        has_column_privilege('onecore_app', 'sessions', 'id', 'INSERT')
        AS can_insert_generated_session_id,
        has_column_privilege('onecore_app', 'sessions', 'secret_hash', 'INSERT')
        AS can_insert_session_hash,
        has_column_privilege('onecore_app', 'sessions', 'revoked_at', 'INSERT')
        AS can_insert_revocation_default
    `,
  );
  const sessionPrivilegeRows = resultRows(sessionPrivileges);
  assert.deepEqual(sessionPrivilegeRows[0], {
    can_read_sessions: true,
    can_insert_all_session_columns: false,
    can_insert_generated_session_id: true,
    can_insert_session_hash: true,
    can_insert_revocation_default: true,
  });
  await adminDatabase.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL ROLE onecore_app`);
    await transaction.execute(
      sql`
        INSERT INTO rate_limit_buckets
          (key_hash, organization_id, branch_id, hit_count, expires_at)
        VALUES (
          '0000000000000000000000000000000000000000000000000000000000000000',
          NULL,
          NULL,
          1,
          now() + interval '1 minute'
        )
        ON CONFLICT (key_hash) DO UPDATE
        SET hit_count = rate_limit_buckets.hit_count + 1
      `,
    );
    await transaction.execute(
      sql`
        INSERT INTO rate_limit_buckets
          (key_hash, organization_id, branch_id, hit_count, expires_at)
        VALUES (
          '0000000000000000000000000000000000000000000000000000000000000000',
          NULL,
          NULL,
          1,
          now() + interval '1 minute'
        )
        ON CONFLICT (key_hash) DO UPDATE
        SET hit_count = rate_limit_buckets.hit_count + 1
      `,
    );
    await transaction.execute(
      sql`
        DELETE FROM rate_limit_buckets
        WHERE key_hash = '0000000000000000000000000000000000000000000000000000000000000000'
      `,
    );
  });
  globalThis.console.info(
    "PASS: disposable PostgreSQL migration ledger, forced RLS, ownership, non-bypass roles, session privileges, and runtime limiter access verified",
  );
  globalThis.console.info(
    `DISPOSABLE-TEST-ONLY migration ledger evidence: ${ledgerRows.map((row) => `${row.name} hash=${row.hash} created_at=${row.created_at}`).join("; ")}`,
  );
}

let containerId;
let adminConnection;
let adminRootConnection;
let apiProcess;
let apiOutput = "";
let browser;
let frontend;
let screenshotDirectory;
let emailCaptureDirectory;
let emailCapturePath;

try {
  if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL) {
    throw new Error(
      "E2E runner refuses production mode or an inherited DATABASE_URL",
    );
  }

  screenshotDirectory = await mkdtemp(
    resolve(tmpdir(), "onecore-business-e2e-screenshots-"),
  );
  emailCaptureDirectory = await mkdtemp(
    resolve(tmpdir(), "onecore-owner-setup-e2e-"),
  );
  emailCapturePath = join(emailCaptureDirectory, "provider-messages.jsonl");

  const repositoryChanges = run("git", ["status", "--porcelain"]);
  if (!repositoryChanges) {
    globalThis.console.info(
      "Starting isolated Business Manager browser verification",
    );
  }

  containerId = execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--health-cmd",
      "pg_isready -U postgres",
      "--health-interval",
      "2s",
      "--health-timeout",
      "2s",
      "--health-retries",
      "30",
      "-e",
      `POSTGRES_PASSWORD=${databasePassword}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:18.6",
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
  await waitForContainer(containerId);
  const mappedPort = Number.parseInt(
    run("docker", ["port", containerId, "5432/tcp"]).split(":").at(-1) ?? "",
    10,
  );
  if (!Number.isInteger(mappedPort)) {
    throw new Error("Could not resolve the disposable PostgreSQL port");
  }

  const adminBase = `postgres://postgres:${databasePassword}@127.0.0.1:${mappedPort}`;
  const adminRoot = createDatabase(`${adminBase}/postgres`, {
    maxConnections: 1,
  });
  adminRootConnection = adminRoot;
  await waitFor(async () => {
    try {
      await adminRoot.db.execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }, "disposable PostgreSQL connection");
  await adminRoot.db.execute(
    sql.raw(
      `CREATE ROLE onecore_migrator LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${migratorPassword}'`,
    ),
  );
  await adminRoot.db.execute(
    sql.raw("ALTER ROLE onecore_migrator SET search_path TO public"),
  );
  await adminRoot.db.execute(
    sql.raw(
      `CREATE ROLE onecore_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${appPassword}'`,
    ),
  );
  await adminRoot.db.execute(
    sql.raw(
      `CREATE ROLE onecore_worker NOLOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${workerPassword}'`,
    ),
  );
  await adminRoot.db.execute(sql.raw("CREATE DATABASE onecore_e2e"));
  await adminRoot.close();
  adminRootConnection = undefined;

  const adminUrl = `${adminBase}/onecore_e2e`;
  const admin = createDatabase(adminUrl, { maxConnections: 1 });
  adminConnection = admin;
  await admin.db.execute(
    sql.raw(
      "GRANT CONNECT, CREATE ON DATABASE onecore_e2e TO onecore_migrator",
    ),
  );
  await admin.db.execute(
    sql.raw("GRANT USAGE, CREATE ON SCHEMA public TO onecore_migrator"),
  );
  await admin.db.execute(
    sql.raw("GRANT USAGE ON SCHEMA public TO onecore_app"),
  );

  const migratorUrl = `postgres://onecore_migrator:${migratorPassword}@127.0.0.1:${mappedPort}/onecore_e2e`;
  run("npm", ["run", "db:migrate"], {
    env: {
      ...process.env,
      MIGRATOR_DATABASE_URL: migratorUrl,
      NODE_ENV: "test",
      ONECORE_MIGRATION_ENVIRONMENT: "test",
      ONECORE_MIGRATION_EXPECTED_HOST: "127.0.0.1",
      ONECORE_MIGRATION_EXPECTED_PORT: String(mappedPort),
      ONECORE_MIGRATION_EXPECTED_DATABASE: "onecore_e2e",
      ONECORE_MIGRATION_REVIEWED_UNTRACKED:
        "20261014150000_initial_superadmin_bootstrap,20261014222000_support_workspace",
    },
    stdio: "inherit",
  });

  const fixture = await createFixture(admin.db);
  await verifyMigrationEvidence(admin.db);

  const apiPort = await freePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webPort = await freePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  frontend = createFrontendServer(apiPort);
  await new Promise((resolvePromise, reject) => {
    frontend.once("error", reject);
    frontend.listen(webPort, "127.0.0.1", resolvePromise);
  });

  apiProcess = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(resolve(root, "scripts/mock-resend-provider.mjs")).href,
      "services/api/dist/server.js",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(apiPort),
        LOG_LEVEL: "error",
        DATABASE_URL: `postgres://onecore_app:${appPassword}@127.0.0.1:${mappedPort}/onecore_e2e`,
        AUTH_ALLOWED_ORIGINS: webOrigin,
        BUSINESS_APP_ORIGIN: "https://business.example.test",
        AUTH_LOGIN_RATE_LIMIT_MAX: "20",
        MFA_ENCRYPTION_KEY: mfaEncryptionKey,
        RESEND_API_KEY: "re_onecore_e2e_mock_only",
        RESEND_FROM_EMAIL: "no-reply@onecore.test",
        ONECORE_E2E_EMAIL_CAPTURE_PATH: emailCapturePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  apiProcess.stdout.on("data", (chunk) => {
    apiOutput = `${apiOutput}${chunk}`.slice(-8_000);
  });
  apiProcess.stderr.on("data", (chunk) => {
    apiOutput = `${apiOutput}${chunk}`.slice(-8_000);
  });
  await waitFor(async () => {
    if (apiProcess.exitCode !== null) {
      throw new Error(`API exited during startup: ${apiOutput}`);
    }
    try {
      const response = await globalThis.fetch(`${apiOrigin}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, "isolated real API startup");

  const health = await globalThis.fetch(`${apiOrigin}/ready`);
  assert.equal(health.status, 200, "API readiness confirms PostgreSQL access");
  globalThis.console.info(
    "PASS: isolated API started with onecore_app against disposable PostgreSQL",
  );

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(webOrigin);
  await expect(page.locator("#auth-view")).toBeVisible();
  globalThis.console.info(
    "PASS: unauthenticated browser is shown the real sign-in view",
  );

  const registrationPage = await context.newPage();
  let submittedApplication;
  registrationPage.on("request", (request) => {
    if (
      request.url().endsWith("/api/public/organization-applications") &&
      request.method() === "POST"
    ) {
      submittedApplication = request.postDataJSON();
    }
  });
  await registrationPage.goto(`${webOrigin}/register/`);
  await expect(
    registrationPage.getByRole("heading", {
      name: "Request a Business Account",
    }),
  ).toBeVisible();
  await registrationPage.getByRole("button", { name: "Continue" }).click();
  await expect(registrationPage.locator("#registration-message")).toBeVisible();
  await expect(
    registrationPage.getByRole("heading", { name: "Business information" }),
  ).toBeVisible();
  await registrationPage
    .getByLabel("Organization name")
    .fill("E2E Registration Applicant Ltd.");
  await registrationPage
    .getByLabel("Organization reference")
    .fill("e2e-registration-applicant");
  await registrationPage.getByLabel("Industry").fill("Retail");
  await registrationPage
    .getByLabel("Business email")
    .fill("e2e-registration-business@onecore.test");
  await registrationPage.getByLabel("Business phone").fill("+254700000099");
  await registrationPage.getByLabel("Country code (e.g. KE)").fill("KE");
  await registrationPage.getByLabel("County / region").fill("Nairobi");
  await registrationPage.getByLabel("Town / city").fill("Nairobi");
  await registrationPage.getByLabel("Business address").fill("E2E Road 1");
  await registrationPage.getByRole("button", { name: "Continue" }).click();
  await registrationPage
    .getByLabel("Owner / administrator name")
    .fill("E2E Application Owner");
  await registrationPage.getByLabel("Owner email").fill(applicationOwnerEmail);
  await registrationPage.getByRole("button", { name: "Continue" }).click();
  const requestedBusinessManager = registrationPage.locator(
    'input[name="requestedModules"][value="core.business_manager"]',
  );
  await expect(requestedBusinessManager).toBeVisible();
  await requestedBusinessManager.check();
  await registrationPage.getByRole("button", { name: "Continue" }).click();
  const registrationResponsePromise = registrationPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/public/organization-applications") &&
      response.request().method() === "POST",
  );
  await registrationPage
    .getByRole("button", { name: "Submit Application" })
    .click();
  const registrationResponse = await registrationResponsePromise;
  const registrationResult = await registrationResponse.json();
  assert.equal(
    registrationResponse.status(),
    201,
    JSON.stringify(registrationResult),
  );
  assert.equal(registrationResult.application.status, "PENDING");
  assert.equal(
    Object.hasOwn(registrationResult.application, "ownerUserId"),
    false,
  );
  await expect(registrationPage.getByText("Status: PENDING")).toBeVisible();
  await expect(registrationPage.locator("body")).toContainText(
    "does not create an owner login",
  );
  assert.ok(submittedApplication);
  const duplicateRegistration = await registrationPage.evaluate(
    async (application) => {
      const response = await globalThis.fetch(
        "/api/public/organization-applications",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(application),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    submittedApplication,
  );
  assert.equal(duplicateRegistration.status, 409);
  assert.equal(duplicateRegistration.body.error.code, "CONFLICT");
  globalThis.console.info(
    "PASS: browser registration validates required fields, persists a pending request without owner credentials, and rejects duplicate submissions",
  );

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const adminLifecycleRequests = [];
  adminPage.on("dialog", async (dialog) => {
    globalThis.console.info(`E2E Superadmin confirmation: ${dialog.message()}`);
    await dialog.accept();
  });
  adminPage.on("pageerror", (error) => {
    globalThis.console.error(`E2E Superadmin page error: ${error.message}`);
  });
  adminPage.on("request", (request) => {
    if (request.url().includes("/platform/organization-applications")) {
      adminLifecycleRequests.push({
        method: request.method(),
        url: request.url(),
      });
    }
  });
  adminPage.on("response", (response) => {
    if (response.url().includes("/platform/organization-applications")) {
      globalThis.console.info(
        `E2E platform review response ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
      );
    }
  });
  await adminPage.goto(`${webOrigin}/superadmin/`);
  await adminPage.getByLabel("Email address").fill(platformAdminEmail);
  await adminPage.locator("#login-password").fill(testPassword);
  const adminLoginResponse = adminPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/login") &&
      response.request().method() === "POST",
  );
  await adminPage
    .getByRole("button", { name: "Sign in to administration" })
    .click();
  await completeMfaLogin(
    adminPage,
    await adminLoginResponse,
    platformAdminEmail,
  );
  await expect(adminPage.locator("#app-view")).toBeVisible();
  await adminPage.locator('[data-admin-view="requests"]').click();
  await adminPage
    .getByRole("button", {
      name: "Review E2E Registration Applicant Ltd.",
    })
    .click();
  await expect(
    adminPage.getByRole("button", { name: "Begin review" }),
  ).toBeVisible();
  const reviewResponsePromise = adminPage.waitForResponse(
    (response) =>
      response.url().includes("/platform/organization-applications/") &&
      response.url().endsWith("/status") &&
      response.request().method() === "POST",
  );
  await adminPage.getByRole("button", { name: "Begin review" }).click();
  assert.equal((await reviewResponsePromise).status(), 200);
  await expect(
    adminPage.locator("#request-detail").getByRole("button", {
      name: "Approve",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    adminPage.locator('[aria-labelledby="review-boundary-title"]'),
  ).toContainText(
    "Approving an application records the review decision. It does not activate an organization.",
  );
  const approveButton = adminPage
    .locator("#request-detail")
    .getByRole("button", { name: "Approve", exact: true });
  globalThis.console.info(
    `E2E Approve button enabled=${await approveButton.isEnabled()} lifecycleRequests=${adminLifecycleRequests.length}`,
  );
  const approvalResponsePromise = adminPage.waitForResponse(
    (response) =>
      response.url().includes("/platform/organization-applications/") &&
      response.url().endsWith("/status") &&
      response.request().method() === "POST",
  );
  await approveButton.click();
  const approvalResponse = await approvalResponsePromise;
  assert.equal(approvalResponse.status(), 200);
  assert.equal((await approvalResponse.json()).application.status, "APPROVED");
  await expect(adminPage.locator("#request-detail")).toContainText(
    "core.business_manager",
  );
  const applicationOrganization = await admin.db
    .select({ id: organizations.id, status: organizations.status })
    .from(organizations)
    .where(eq(organizations.slug, "e2e-registration-applicant"))
    .limit(1);
  assert.equal(applicationOrganization[0]?.status, "APPROVED");
  const applicationOwner = await admin.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, applicationOwnerEmail))
    .limit(1);
  assert.deepEqual(applicationOwner, []);
  globalThis.console.info(
    "PASS: Superadmin review and approval persist APPROVED without activation or owner-account provisioning",
  );
  await expect(
    adminPage.getByRole("button", {
      name: "Activate & provision Owner",
      exact: true,
    }),
  ).toBeVisible();
  const provisionResponsePromise = adminPage.waitForResponse(
    (response) =>
      response.url().includes("/platform/organization-applications/") &&
      response.url().endsWith("/provision") &&
      response.request().method() === "POST",
  );
  const ownerInvitationResponsePromise = adminPage.waitForResponse(
    (response) =>
      response.url().endsWith("/owner-invitation") &&
      response.request().method() === "POST",
  );
  await adminPage
    .getByRole("button", {
      name: "Activate & provision Owner",
      exact: true,
    })
    .click();
  const provisionResponse = await provisionResponsePromise;
  const ownerInvitationResponse = await ownerInvitationResponsePromise;
  assert.equal(provisionResponse.status(), 200);
  assert.equal(ownerInvitationResponse.status(), 202);
  assert.equal(
    (await ownerInvitationResponse.json()).invitation.status,
    "QUEUED",
  );
  const provisionResult = await provisionResponse.json();
  assert.equal(provisionResult.application.status, "ACTIVE");
  assert.equal(provisionResult.owner.accountStatus, "PENDING");
  assert.equal(provisionResult.owner.membershipStatus, "INVITED");
  assert.equal(provisionResult.owner.credentialSetup, "PENDING_INVITATION");
  const activatedApplication = await admin.db
    .select({ id: organizations.id, status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, applicationOrganization[0].id))
    .limit(1);
  assert.deepEqual(activatedApplication, [
    { id: applicationOrganization[0].id, status: "ACTIVE" },
  ]);
  const provisionedOwner = await admin.db
    .select({
      id: users.id,
      status: users.status,
      passwordHash: users.passwordHash,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.email, applicationOwnerEmail))
    .limit(1);
  assert.equal(provisionedOwner.length, 1);
  assert.equal(provisionedOwner[0].status, "PENDING");
  assert.equal(provisionedOwner[0].passwordHash, null);
  assert.equal(provisionedOwner[0].emailVerifiedAt, null);
  const provisionedMembership = await admin.db
    .select({
      id: organizationMemberships.id,
      status: organizationMemberships.status,
    })
    .from(organizationMemberships)
    .where(
      eq(organizationMemberships.organizationId, applicationOrganization[0].id),
    );
  assert.equal(provisionedMembership.length, 1);
  assert.equal(provisionedMembership[0].status, "INVITED");
  const assignedOwnerRole = await admin.db
    .select({ name: roles.name })
    .from(membershipRoles)
    .innerJoin(
      roles,
      and(
        eq(roles.organizationId, membershipRoles.organizationId),
        eq(roles.id, membershipRoles.roleId),
      ),
    )
    .where(eq(membershipRoles.membershipId, provisionedMembership[0].id));
  assert.deepEqual(assignedOwnerRole, [{ name: "Organization Owner" }]);
  const provisionedEntitlements = await admin.db
    .select({
      key: modules.key,
      status: organizationModules.status,
    })
    .from(organizationModules)
    .innerJoin(modules, eq(modules.id, organizationModules.moduleId))
    .where(
      eq(organizationModules.organizationId, applicationOrganization[0].id),
    );
  assert.deepEqual(provisionedEntitlements, [
    { key: "core.business_manager", status: "ENABLED" },
  ]);
  const provisionedBranches = await admin.db
    .select({ id: branches.id, name: branches.name, code: branches.code })
    .from(branches)
    .where(eq(branches.organizationId, applicationOrganization[0].id));
  assert.equal(provisionedBranches.length, 1);
  assert.deepEqual(
    { name: provisionedBranches[0].name, code: provisionedBranches[0].code },
    { name: "Main", code: "MAIN" },
  );
  const initialOwnerBranchAccess = await admin.db
    .select({ branchId: membershipBranches.branchId })
    .from(membershipBranches)
    .where(eq(membershipBranches.membershipId, provisionedMembership[0].id));
  assert.deepEqual(initialOwnerBranchAccess, [
    { branchId: provisionedBranches[0].id },
  ]);
  const retryProvision = await adminPage.evaluate(async (reference) => {
    const response = await globalThis.fetch(
      `/api/platform/organization-applications/${encodeURIComponent(reference)}/provision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    return { status: response.status, body: await response.json() };
  }, applicationOrganization[0].id);
  assert.equal(retryProvision.status, 200);
  assert.equal(
    retryProvision.body.owner.membershipId,
    provisionResult.owner.membershipId,
  );
  const emailPayload = JSON.parse(
    (await readFile(emailCapturePath, "utf8")).trim().split("\n").at(-1),
  );
  assert.equal(emailPayload.to[0], applicationOwnerEmail);
  const setupToken = emailPayload.text.match(
    /https:\/\/business\.example\.test\/setup\.html#token=([A-Za-z0-9_-]{43})/,
  )?.[1];
  assert.ok(setupToken, "mock provider captured an Owner setup link");
  const ownerSessions = await admin.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, provisionedOwner[0].id));
  assert.deepEqual(ownerSessions, []);
  const ownerPage = await context.newPage();
  await ownerPage.goto(webOrigin);
  const ownerLogin = await ownerPage.evaluate(async (email) => {
    const response = await globalThis.fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "synthetic-password-not-set-for-invited-owner",
      }),
    });
    return { status: response.status, body: await response.json() };
  }, applicationOwnerEmail);
  assert.equal(ownerLogin.status, 401);
  assert.equal(
    ownerLogin.body.error.message,
    "Email or password is incorrect.",
  );
  await ownerPage.goto(`${webOrigin}/setup.html#token=${setupToken}`);
  await expect(
    ownerPage.getByRole("heading", { name: "Choose your password" }),
  ).toBeVisible();
  assert.equal(new URL(ownerPage.url()).hash, "");
  await ownerPage.getByLabel("New password").fill(testPassword);
  await ownerPage.getByLabel("Confirm password").fill(testPassword);
  const setupResponsePromise = ownerPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/owner-credential-setup") &&
      response.request().method() === "POST",
  );
  await ownerPage.getByRole("button", { name: "Set password" }).click();
  const setupResponse = await setupResponsePromise;
  const setupResponseBody = await setupResponse.json();
  assert.equal(
    setupResponse.status(),
    200,
    `${JSON.stringify(setupResponseBody)}\n${apiOutput}`,
  );
  assert.equal(setupResponseBody.nextStep, "SIGN_IN_AND_ENROLL_MFA");
  assert.equal(setupResponse.headers()["set-cookie"], undefined);
  const rawTokenReuse = await ownerPage.evaluate(
    async ({ token, password }) => {
      const response = await globalThis.fetch(
        "/api/auth/owner-credential-setup",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, password }),
        },
      );
      return response.status;
    },
    { token: setupToken, password: testPassword },
  );
  assert.equal(rawTokenReuse, 400);
  const setupTokenRows = await admin.db
    .select({
      tokenHash: ownerCredentialSetupTokens.tokenHash,
      consumedAt: ownerCredentialSetupTokens.consumedAt,
      revokedAt: ownerCredentialSetupTokens.revokedAt,
    })
    .from(ownerCredentialSetupTokens)
    .where(eq(ownerCredentialSetupTokens.userId, provisionedOwner[0].id));
  assert.equal(setupTokenRows.length, 1);
  assert.equal(
    setupTokenRows[0].tokenHash,
    createHash("sha256").update(setupToken).digest("hex"),
  );
  assert.ok(setupTokenRows[0].consumedAt);
  const activatedOwner = await admin.db
    .select({
      status: users.status,
      passwordHash: users.passwordHash,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, provisionedOwner[0].id))
    .limit(1);
  assert.equal(activatedOwner[0].status, "ACTIVE");
  assert.ok(activatedOwner[0].passwordHash);
  assert.ok(activatedOwner[0].emailVerifiedAt);
  const acceptedMembership = await admin.db
    .select({ status: organizationMemberships.status })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.id, provisionedMembership[0].id));
  assert.deepEqual(acceptedMembership, [{ status: "ACTIVE" }]);
  await ownerPage.goto(webOrigin);
  const ownerLoginResponse = ownerPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/login") &&
      response.request().method() === "POST",
  );
  await ownerPage.getByLabel("Email address").fill(applicationOwnerEmail);
  await ownerPage.locator("#login-password").fill(testPassword);
  await ownerPage.getByRole("button", { name: "Sign in to OneCore" }).click();
  await completeMfaLogin(
    ownerPage,
    await ownerLoginResponse,
    applicationOwnerEmail,
  );
  await expect(ownerPage.locator("#app-view")).toBeVisible();
  await ownerPage.locator("#organization-select").selectOption({
    label: "E2E Registration Applicant Ltd.",
  });
  await expect(ownerPage.locator("#sidebar-organization")).toHaveText(
    "E2E Registration Applicant Ltd.",
  );
  const branchSelectionResponse = ownerPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/branch") &&
      response.request().method() === "POST",
  );
  await ownerPage.locator("#branch-select").selectOption({
    value: provisionResult.branch.id,
  });
  assert.equal((await branchSelectionResponse).status(), 200);
  const selectedOwnerBranch = await ownerPage.evaluate(async () => {
    const response = await globalThis.fetch("/api/auth/session");
    return response.json();
  });
  assert.equal(selectedOwnerBranch.branch.branchId, provisionResult.branch.id);
  assert.ok(
    selectedOwnerBranch.availableBranches.some(
      (branch) => branch.branchId === provisionResult.branch.id,
    ),
  );
  const ownerSessionAssurance = await admin.db
    .select({
      organizationId: sessions.organizationId,
      mfaVerifiedAt: sessions.mfaVerifiedAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, provisionedOwner[0].id));
  assert.equal(ownerSessionAssurance.length, 1);
  assert.equal(
    ownerSessionAssurance[0].organizationId,
    applicationOrganization[0].id,
  );
  assert.ok(ownerSessionAssurance[0].mfaVerifiedAt);
  const crossTenantResponse = await ownerPage.evaluate(
    async (organizationId) => {
      const response = await globalThis.fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/business/customers`,
      );
      return response.status;
    },
    fixture.organizationId,
  );
  assert.equal(crossTenantResponse, 403);
  await ownerPage.goto(`${webOrigin}/support/`);
  const supportSubject = "E2E authenticated support request";
  await expect(ownerPage.locator("#request-create-form")).toBeVisible();
  await ownerPage.getByLabel("Subject").fill(supportSubject);
  await ownerPage
    .getByLabel("Describe the issue")
    .fill("Synthetic support issue for the disposable database test.");
  const supportCreateResponse = ownerPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/support/requests") &&
      response.request().method() === "POST",
  );
  await ownerPage.getByRole("button", { name: "Submit request" }).click();
  const supportCreate = await supportCreateResponse;
  assert.equal(supportCreate.status(), 201);
  const createdSupportRequest = await supportCreate.json();
  const supportRequestId = createdSupportRequest.request.id;
  assert.equal(
    createdSupportRequest.request.organizationId,
    applicationOrganization[0].id,
  );
  const foreignSupportStatus = await ownerPage.evaluate(async (requestId) => {
    const response = await globalThis.fetch(
      `/api/support/requests/${encodeURIComponent(requestId)}`,
    );
    return response.status;
  }, fixture.foreignSupportRequestId);
  assert.equal(foreignSupportStatus, 404);

  const rootSupportSetup = await adminPage.evaluate(
    async ({ organizationId, supportUserId, requestId }) => {
      const request = (path, body, method = "POST") =>
        globalThis.fetch(`/api${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const staff = await request("/platform/support/staff", {
        userId: supportUserId,
      });
      const grant = await request(
        `/platform/support/organizations/${encodeURIComponent(organizationId)}/grants`,
        {
          supportUserId,
          reason: "Synthetic browser test access",
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
      );
      const assignment = await request(
        `/platform/support/requests/${encodeURIComponent(requestId)}/assignment`,
        { supportUserId },
      );
      return {
        staff: staff.status,
        grant: grant.status,
        assignment: assignment.status,
      };
    },
    {
      organizationId: applicationOrganization[0].id,
      supportUserId: fixture.supportUserId,
      requestId: supportRequestId,
    },
  );
  assert.deepEqual(rootSupportSetup, {
    staff: 204,
    grant: 201,
    assignment: 200,
  });

  const supportStaffContext = await browser.newContext();
  const supportStaffPage = await supportStaffContext.newPage();
  await supportStaffPage.goto(`${webOrigin}/support/`);
  await supportStaffPage.locator("#support-email").fill(supportUserEmail);
  await supportStaffPage.locator("#support-password").fill(testPassword);
  const supportStaffLoginResponse = supportStaffPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/login") &&
      response.request().method() === "POST",
  );
  await supportStaffPage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await completeMfaLogin(
    supportStaffPage,
    await supportStaffLoginResponse,
    supportUserEmail,
  );
  await expect(supportStaffPage.locator("#request-list")).toContainText(
    supportSubject,
  );
  await expect(
    supportStaffPage.getByRole("button", {
      name: /E2E authenticated support request/,
    }),
  ).toBeVisible();
  await supportStaffPage
    .getByRole("button", { name: /E2E authenticated support request/ })
    .click();
  await expect(
    supportStaffPage.locator("#request-detail-content"),
  ).toContainText("Synthetic support issue");
  const internalNoteText =
    "E2E staff-only note must not be visible to the customer.";
  await supportStaffPage
    .locator("#request-detail-content textarea")
    .nth(1)
    .fill(internalNoteText);
  const noteResponse = supportStaffPage.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/api/support/requests/${supportRequestId}/notes`) &&
      response.request().method() === "POST",
  );
  await supportStaffPage
    .locator("#request-detail-content form")
    .nth(1)
    .getByRole("button", { name: "Send" })
    .click();
  assert.equal((await noteResponse).status(), 201);
  await expect(
    supportStaffPage.locator("#request-detail-content"),
  ).toContainText(internalNoteText);
  const statusUpdateResponse = supportStaffPage.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/support/requests/${supportRequestId}`) &&
      response.request().method() === "PATCH",
  );
  await supportStaffPage
    .locator("#request-detail-content select")
    .nth(0)
    .selectOption("IN_PROGRESS");
  await supportStaffPage
    .getByRole("button", { name: "Update request" })
    .click();
  assert.equal((await statusUpdateResponse).status(), 200);

  await ownerPage.reload();
  await expect(ownerPage.locator("#request-list")).toContainText(
    supportSubject,
  );
  await ownerPage
    .getByRole("button", { name: /E2E authenticated support request/ })
    .click();
  await expect(ownerPage.locator("#request-detail-content")).toContainText(
    "IN PROGRESS",
  );
  await expect(ownerPage.locator("#request-detail-content")).not.toContainText(
    internalNoteText,
  );
  globalThis.console.info(
    "PASS: Support customer creation, tenant isolation, Root staff/grant/assignment controls, mandatory staff MFA, status changes, and customer-hidden internal notes verified in browser",
  );
  await supportStaffContext.close();

  globalThis.console.info(
    "PASS: first Owner uses a mocked invitation email, single-use setup activates the account, mandatory MFA precedes session issuance, and sign-in selects only the new tenant",
  );
  const ownerLogoutStatus = await ownerPage.evaluate(async () => {
    const response = await globalThis.fetch("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return response.status;
  });
  assert.equal(ownerLogoutStatus, 204);
  await ownerPage.close();
  await expect(adminPage.locator("#requests-message")).toContainText(
    "The email provider accepted the Owner setup invitation",
  );
  globalThis.console.info(
    "PASS: Superadmin provisioning atomically activates the approved organization and requested module, creates one invited Owner, safely replays, and denies login without credential setup",
  );
  await adminContext.close();

  const loginFields = loginSelectors(page);
  await loginFields.email.fill(ownerEmail);
  await loginFields.password.fill("incorrect synthetic password");
  const invalidLoginResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/login") &&
      response.request().method() === "POST",
  );
  await loginFields.submit.click();
  const invalidLoginStatus = (await invalidLoginResponse).status();
  assert.equal(
    invalidLoginStatus,
    401,
    `invalid login should return 401; API output: ${apiOutput}; PostgreSQL output: ${execFileSync("docker", ["logs", containerId], { encoding: "utf8" }).slice(-4_000)}`,
  );
  await expect(page.locator("#auth-message")).toContainText(
    "Email or password is incorrect.",
  );
  globalThis.console.info(
    "PASS: invalid sign-in displays the authentication error state",
  );

  await login(page, ownerEmail, webOrigin, fixture.checkoutBranchId);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: resolve(screenshotDirectory, "business-overview-1440x900.png"),
    fullPage: true,
  });
  globalThis.console.info(
    "PASS: synthetic owner signs in and selects the authorized organization",
  );

  await page.locator("#settings-nav").click();
  await page.getByLabel("Country code").fill("KE");
  await page.getByLabel("Currency code").fill("KES");
  await page.getByLabel("IANA time zone").fill("Africa/Nairobi");
  await page.getByLabel("Legal name").fill("E2E Registered Business Ltd.");
  await page
    .getByRole("button", { name: "Save organization settings" })
    .click();
  await expect(page.getByText("Organization settings saved.")).toBeVisible();
  await page.reload();
  await page.locator("#settings-nav").click();
  await expect(page.getByLabel("Country code")).toHaveValue("KE");
  await expect(page.getByLabel("Currency code")).toHaveValue("KES");
  await expect(page.getByLabel("IANA time zone")).toHaveValue("Africa/Nairobi");
  await expect(page.getByLabel("Legal name")).toHaveValue(
    "E2E Registered Business Ltd.",
  );
  globalThis.console.info(
    "PASS: organization settings update persists after a full browser reload",
  );

  await page.locator("#customers-nav").click();
  await page.getByRole("button", { name: "Create customer" }).click();
  await page.getByLabel("Name", { exact: true }).fill("E2E Browser Customer");
  await page.getByLabel("Customer type").selectOption("BUSINESS");
  await page
    .getByLabel("Email", { exact: true })
    .fill("customer-e2e@onecore.test");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Record created.")).toBeVisible();
  await expect(
    page.getByRole("row", { name: /E2E Browser Customer/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit E2E Browser Customer" }).click();
  await page.getByLabel("Name", { exact: true }).fill("E2E Updated Customer");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Record updated.")).toBeVisible();
  await page.reload();
  await page.locator("#customers-nav").click();
  const customerRow = page.getByRole("row", {
    name: /E2E Updated Customer/,
  });
  await expect(customerRow).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await customerRow.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByText("Record deactivated.")).toBeVisible();
  await page.reload();
  await page.locator("#customers-nav").click();
  await expect(
    page.getByRole("row", { name: /E2E Updated Customer.*INACTIVE/ }),
  ).toBeVisible();
  globalThis.console.info(
    "PASS: customer create, update, and deactivate persist after reload",
  );

  await page.locator("#products-nav").click();
  await page.getByRole("button", { name: "Create catalog item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("E2E Browser Product");
  await page.getByLabel("Type").selectOption("PRODUCT");
  await page.getByLabel("Unit").fill("hour");
  await page.getByLabel("Price (decimal)").fill("12.500001");
  await page.getByLabel("Currency (ISO 4217)").fill("KES");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Record created.")).toBeVisible();
  await expect(
    page.getByRole("row", { name: /E2E Browser Product/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit E2E Browser Product" }).click();
  await page.getByLabel("Price (decimal)").fill("17.250000");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Record updated.")).toBeVisible();
  await page.reload();
  await page.locator("#products-nav").click();
  const catalogRow = page.getByRole("row", {
    name: /E2E Browser Product/,
  });
  await expect(catalogRow).toBeVisible();
  await expect(catalogRow).toContainText("17.250000 KES");
  const catalogItemId = await page.evaluate(
    async ({ organizationId, itemName }) => {
      const response = await globalThis.fetch(
        `/api/organizations/${organizationId}/business/catalog?status=ACTIVE&limit=20`,
      );
      const result = await response.json();
      return result.items.find((item) => item.name === itemName)?.id;
    },
    {
      organizationId: fixture.organizationId,
      itemName: "E2E Browser Product",
    },
  );
  assert.equal(typeof catalogItemId, "string");
  await expect(page.locator("#inventory-nav")).toBeVisible();
  await page.locator("#inventory-nav").click();
  await page.getByLabel("Product", { exact: true }).selectOption(catalogItemId);
  await page.getByLabel("Movement type").selectOption("RECEIPT");
  await page.getByLabel("Quantity change").fill("5");
  await page.getByRole("button", { name: "Record movement" }).click();
  await expect(
    page.getByText(/Stock received\. Available quantity: 5/),
  ).toBeVisible();
  const inventoryRow = page.getByRole("row", {
    name: /E2E Browser Product/,
  });
  await expect(inventoryRow).toContainText("5");
  await expect(inventoryRow).toContainText("In stock");
  await page.reload();
  await expect(page.locator("#inventory-nav")).toBeVisible();
  await page.locator("#inventory-nav").click();
  await expect(
    page.getByRole("row", { name: /E2E Browser Product/ }),
  ).toContainText("5");
  await expect(
    page.getByText(/Low-stock thresholds, category\/supplier fields/),
  ).toBeVisible();
  await page
    .getByLabel("Filter inventory by stock status")
    .selectOption("OUT_OF_STOCK");
  await expect(
    page.getByText("No products on this page match the selected stock status."),
  ).toBeVisible();
  await page.getByLabel("Filter inventory by stock status").selectOption("ALL");
  await expect(inventoryRow).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "inventory-desktop-1440x900.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.locator("#app-sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(page.locator("#app-sidebar")).toBeHidden();
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.window.innerWidth,
    ),
    true,
    "Inventory layout should not overflow the page at 320px",
  );
  await page.screenshot({
    path: resolve(screenshotDirectory, "inventory-mobile-320x700.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  globalThis.console.info(
    "PASS: inventory reads persisted branch stock, filters current-page status, and renders without page overflow at 1440px and 320px",
  );

  await page.locator("#pos-nav").click();
  await page.getByLabel("Search catalog").fill("E2E Browser Product");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const posProduct = page
    .locator(".oc-pos-product")
    .filter({ hasText: "E2E Browser Product" });
  await expect(posProduct).toContainText("17.250000 KES");
  await posProduct.getByRole("button", { name: "Add to draft" }).click();
  const draftCart = page.locator(".oc-pos-cart");
  const quantity = draftCart.getByLabel("Quantity");
  await quantity.fill("3");
  await quantity.press("Tab");
  await expect(draftCart).toContainText("Line estimate: 51.75 KES");
  await expect(draftCart).toContainText("Catalog subtotal estimate: 51.75 KES");
  await draftCart.getByLabel("Quantity").fill("0");
  await draftCart.getByLabel("Quantity").press("Tab");
  await expect(draftCart.getByLabel("Quantity")).toHaveValue("3");
  await expect(page.locator("[data-toast-region]")).toContainText(
    "whole-number quantity greater than zero",
  );
  await page.screenshot({
    path: resolve(screenshotDirectory, "pos-desktop-1280x900.png"),
    fullPage: true,
  });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(draftCart).toBeVisible();
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.window.innerWidth,
      ),
      true,
      `POS layout should not overflow at ${viewport.width}px`,
    );
    await page.screenshot({
      path: resolve(
        screenshotDirectory,
        `pos-${viewport.width}x${viewport.height}.png`,
      ),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  const changedServerPrice = await page.evaluate(
    async ({ organizationId, catalogItemId }) => {
      const response = await globalThis.fetch(
        `/api/organizations/${organizationId}/business/catalog/${catalogItemId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ price: "19.250001" }),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { organizationId: fixture.organizationId, catalogItemId },
  );
  assert.equal(
    changedServerPrice.status,
    200,
    JSON.stringify(changedServerPrice.body),
  );

  const checkoutAttempts = [];
  let firstCheckoutSaleId;
  await page.route(
    `**/api/organizations/${fixture.organizationId}/sales`,
    async (route) => {
      const request = route.request();
      const payload = request.postDataJSON();
      const attempt = {
        key: request.headers()["idempotency-key"],
        payload,
      };
      checkoutAttempts.push(attempt);
      assert.equal(request.method(), "POST");
      assert.deepEqual(payload, {
        lines: [{ catalogItemId, quantity: 3 }],
      });
      assert.equal(typeof attempt.key, "string");
      assert.ok(attempt.key.length > 0);
      if (checkoutAttempts.length === 1) {
        const upstream = await route.fetch();
        assert.equal(upstream.status(), 201);
        const firstResponse = await upstream.json();
        firstCheckoutSaleId = firstResponse.sale.id;
        await route.abort("failed");
        return;
      }
      assert.equal(attempt.key, checkoutAttempts[0].key);
      assert.deepEqual(attempt.payload, checkoutAttempts[0].payload);
      await route.continue();
    },
  );
  const checkoutButton = draftCart.getByRole("button", {
    name: "Create unpaid sale",
  });
  await expect(checkoutButton).toBeEnabled();
  await checkoutButton.click();
  await expect(draftCart).toContainText(
    "The sale could not be confirmed because of a connection or server error.",
  );
  await expect(draftCart.getByLabel("Quantity")).toHaveValue("3");
  const retryButton = draftCart.getByRole("button", {
    name: "Retry same checkout",
  });
  await expect(retryButton).toBeEnabled();
  const checkoutResponsePromise = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/organizations/${fixture.organizationId}/sales`) &&
      response.request().method() === "POST",
  );
  await retryButton.click();
  const checkoutResponse = await checkoutResponsePromise;
  assert.equal(checkoutResponse.status(), 201);
  const checkoutResult = await checkoutResponse.json();
  assert.equal(checkoutResult.sale.id, firstCheckoutSaleId);
  assert.equal(checkoutResult.sale.status, "OPEN");
  assert.equal(checkoutResult.sale.currency, "KES");
  assert.equal(checkoutResult.sale.subtotal, "57.750003");
  assert.equal(checkoutResult.sale.total, "57.750003");
  assert.equal(checkoutResult.sale.lines[0].unitPrice, "19.250001");
  assert.equal(checkoutResult.sale.lines[0].lineTotal, "57.750003");
  assert.equal(checkoutResult.sale.lines[0].quantity, 3);
  assert.equal(checkoutAttempts.length, 2);
  await expect(draftCart).toContainText("Unpaid — OPEN");
  await expect(draftCart).toContainText(`Sale ID: ${firstCheckoutSaleId}`);
  await expect(draftCart).toContainText("Server total: 57.750003 KES");
  await expect(draftCart).toContainText("No items in your draft cart yet.");
  assert.equal(
    await page.evaluate(() =>
      globalThis.sessionStorage.getItem("onecore.sales.pending-checkout"),
    ),
    null,
  );
  await page.unroute(`**/api/organizations/${fixture.organizationId}/sales`);

  const insufficientStock = await page.evaluate(
    async ({ organizationId, catalogItemId }) => {
      const response = await globalThis.fetch(
        `/api/organizations/${organizationId}/sales`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "e2e-insufficient-stock-1",
          },
          body: JSON.stringify({
            lines: [{ catalogItemId, quantity: 3 }],
          }),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { organizationId: fixture.organizationId, catalogItemId },
  );
  assert.equal(insufficientStock.status, 409);
  assert.equal(insufficientStock.body.error.code, "INSUFFICIENT_STOCK");
  const forgedBranch = await page.evaluate(
    async ({ organizationId, catalogItemId, branchId }) => {
      const response = await globalThis.fetch(
        `/api/organizations/${organizationId}/sales`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "e2e-forged-branch-1",
          },
          body: JSON.stringify({
            branchId,
            lines: [{ catalogItemId, quantity: 1 }],
          }),
        },
      );
      return response.status;
    },
    {
      organizationId: fixture.organizationId,
      catalogItemId,
      branchId: fixture.foreignBranchId,
    },
  );
  assert.equal(forgedBranch, 400);
  const foreignTenantSale = await page.evaluate(
    async ({ organizationId, catalogItemId }) => {
      const response = await globalThis.fetch(
        `/api/organizations/${organizationId}/sales`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "e2e-foreign-tenant-sale-1",
          },
          body: JSON.stringify({
            lines: [{ catalogItemId, quantity: 1 }],
          }),
        },
      );
      return response.status;
    },
    {
      organizationId: fixture.foreignOrganizationId,
      catalogItemId,
    },
  );
  assert.equal(foreignTenantSale, 404);
  const persistedSales = await admin.db.execute(sql`
    SELECT count(*)::int AS count
    FROM sales
    WHERE organization_id = ${fixture.organizationId}
  `);
  assert.equal(resultRows(persistedSales)[0]?.count, 1);
  const persistedStock = await admin.db.execute(sql`
    SELECT on_hand, reserved
    FROM inventory_stock_balances
    WHERE organization_id = ${fixture.organizationId}
      AND branch_id = ${fixture.checkoutBranchId}
      AND catalog_item_id = ${catalogItemId}
  `);
  assert.deepEqual(resultRows(persistedStock)[0], { on_hand: 5, reserved: 3 });
  await expect(page.locator("#sales-nav")).toBeVisible();
  await page.locator("#sales-nav").click();
  const salesRow = page.getByRole("row", {
    name: new RegExp(firstCheckoutSaleId),
  });
  await expect(salesRow).toContainText("OPEN");
  await expect(salesRow).toContainText("57.750003 KES");
  await salesRow
    .getByRole("button", { name: `View sale ${firstCheckoutSaleId}` })
    .click();
  await expect(page.locator("#boundary-content")).toContainText(
    "This sale is unpaid. Payment completion and receipt issuance are not supported",
  );
  await expect(page.locator("#boundary-content")).toContainText(
    "E2E Browser Product",
  );
  await expect(
    page.getByRole("button", { name: "Cancel unpaid sale" }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  const cancellationResponsePromise = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(
          `/api/organizations/${fixture.organizationId}/sales/${firstCheckoutSaleId}/cancel`,
        ) && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Cancel unpaid sale" }).click();
  const cancellationResponse = await cancellationResponsePromise;
  assert.equal(cancellationResponse.status(), 200);
  assert.equal((await cancellationResponse.json()).sale.status, "CANCELLED");
  await expect(page.locator("#boundary-content")).toContainText(
    "This sale is cancelled. No payment or receipt state is inferred.",
  );
  await expect(page.locator("#boundary-content")).toContainText(
    "Unpaid sale cancelled. Any stock reservation was released.",
  );
  const cancelledSaleRows = await admin.db
    .select({ status: sales.status })
    .from(sales)
    .where(eq(sales.id, firstCheckoutSaleId));
  assert.deepEqual(cancelledSaleRows, [{ status: "CANCELLED" }]);
  const releasedReservationRows = await admin.db
    .select({ status: inventoryReservations.status })
    .from(inventoryReservations)
    .where(eq(inventoryReservations.saleId, firstCheckoutSaleId));
  assert.deepEqual(releasedReservationRows, [{ status: "RELEASED" }]);
  const stockAfterCancellation = await admin.db.execute(sql`
    SELECT on_hand, reserved
    FROM inventory_stock_balances
    WHERE organization_id = ${fixture.organizationId}
      AND branch_id = ${fixture.checkoutBranchId}
      AND catalog_item_id = ${catalogItemId}
  `);
  assert.deepEqual(resultRows(stockAfterCancellation)[0], {
    on_hand: 5,
    reserved: 0,
  });
  globalThis.console.info(
    "PASS: owner cancels an unpaid sale through the UI; the fresh read shows CANCELLED and disposable PostgreSQL confirms reservation release",
  );
  for (const [navigationId, title] of [
    ["finance-nav", "Finance"],
    ["hr-nav", "Human resources"],
    ["payroll-nav", "Payroll"],
  ]) {
    await page.locator(`#${navigationId}`).click();
    await expect(page.locator("#boundary-title")).toHaveText(title);
    await expect(page.locator("#boundary-content")).toContainText(
      "Unavailable in this workspace",
    );
  }
  await page.locator("#companies-nav").click();
  await expect(page.locator("#boundary-title")).toHaveText("CRM companies");
  await expect(page.locator("#boundary-content")).toContainText(
    "A distinct company CRM model and API are not available",
  );
  await page
    .getByRole("link", { name: "Open supported customer records" })
    .click();
  await expect(page.locator("#boundary-title")).toHaveText("Customers");
  globalThis.console.info(
    "PASS: inventory and unpaid Sales history use persisted APIs; unsupported Finance, CRM Companies, HR, and Payroll routes are explicit and Companies links to supported customer records",
  );

  const viewerContext = await browser.newContext();
  const viewerPosPage = await viewerContext.newPage();
  await viewerPosPage.goto(webOrigin);
  await login(viewerPosPage, viewerEmail, webOrigin, fixture.checkoutBranchId);
  await viewerPosPage.locator("#pos-nav").click();
  await viewerPosPage.getByLabel("Search catalog").fill("E2E Browser Product");
  await viewerPosPage
    .getByRole("button", { name: "Search", exact: true })
    .click();
  const viewerProduct = viewerPosPage
    .locator(".oc-pos-product")
    .filter({ hasText: "E2E Browser Product" });
  await expect(
    viewerProduct.getByRole("button", { name: "Add to draft" }),
  ).toBeVisible();
  await viewerProduct.getByRole("button", { name: "Add to draft" }).click();
  const viewerCart = viewerPosPage.locator(".oc-pos-cart");
  await viewerCart.getByRole("button", { name: "Create unpaid sale" }).click();
  await expect(viewerCart).toContainText(
    "You are not authorized to create a sale for this organization and branch.",
  );
  await expect(viewerCart.getByLabel("Quantity")).toHaveValue("1");
  await expect(viewerCart).not.toContainText("Unpaid — OPEN");
  await viewerContext.close();
  globalThis.console.info(
    "PASS: read-only browser user is denied sale creation without losing the cart or seeing success",
  );

  globalThis.console.info(
    "PASS: responsive viewport checks completed at 1440x900, 1280x800, 768x1024, 390x844, and 320x700",
  );
  await page.locator("#products-nav").click();
  page.once("dialog", (dialog) => dialog.accept());
  await catalogRow.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByText("Record deactivated.")).toBeVisible();
  await page.reload();
  await page.locator("#products-nav").click();
  await expect(
    page.getByRole("row", { name: /E2E Browser Product.*INACTIVE/ }),
  ).toBeVisible();
  globalThis.console.info(
    "PASS: catalog create, update, and deactivate persist after reload",
  );

  await page.locator("#organization-nav").click();
  const profileEmail = page.getByLabel("Business contact email");
  await expect(profileEmail).toBeVisible();
  await profileEmail.fill("updated-e2e@onecore.test");
  await page.getByRole("button", { name: "Save business profile" }).click();
  await expect(
    page.getByText("Business contact and address saved."),
  ).toBeVisible();
  await page.reload();
  await page.locator("#organization-nav").click();
  await expect(page.getByLabel("Business contact email")).toHaveValue(
    "updated-e2e@onecore.test",
  );
  globalThis.console.info(
    "PASS: profile update persists after a full browser reload",
  );

  await page.locator("#branches-nav").click();
  const branchName = page.locator("#branch-new-name");
  await expect(branchName).toBeVisible();
  await branchName.fill("Browser E2E Branch");
  await page.locator("#branch-new-code").fill("E2E-001");
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText("Branch created.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Browser E2E Branch" }),
  ).toBeVisible();
  await page.reload();
  await page.locator("#branches-nav").click();
  await expect(
    page.getByRole("heading", { name: "Browser E2E Branch" }),
  ).toBeVisible();
  globalThis.console.info(
    "PASS: branch creation persists after a full browser reload",
  );

  await page.locator("#members-nav").click();
  const memberRow = page.getByRole("row", { name: /E2E Branch Member/ });
  await expect(memberRow).toBeVisible();
  await page.route(
    "**/api/organizations/*/members/*/branches",
    async (route) => {
      await delay(200);
      await route.continue();
    },
  );
  await memberRow
    .getByRole("button", { name: "Manage branch access" })
    .click()
    .catch(async () => {
      await memberRow.getByText("Manage branch access").click();
    });
  await expect(page.getByText("Loading branch assignments…")).toBeVisible();
  await expect(
    page.getByText("No branches are explicitly assigned."),
  ).toBeVisible();
  const branchSelect = page.getByLabel("Available active branches");
  await branchSelect.selectOption({ label: "Browser E2E Branch (E2E-001)" });
  await page.getByRole("button", { name: "Assign branch" }).click();
  await expect(page.getByText("Branch assignments updated.")).toBeVisible();
  await expect(
    page
      .locator("#boundary-content")
      .getByText("Browser E2E Branch", { exact: true }),
  ).toBeVisible();
  globalThis.console.info(
    "PASS: member branch panel displays loading, empty, and confirmed-success states",
  );

  await page.reload();
  await page.locator("#members-nav").click();
  const refreshedMemberRow = page.getByRole("row", {
    name: /E2E Branch Member/,
  });
  await refreshedMemberRow.getByText("Manage branch access").click();
  await expect(
    refreshedMemberRow.getByText("Browser E2E Branch"),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await refreshedMemberRow
    .getByRole("button", { name: "Remove assignment" })
    .click();
  await expect(page.getByText("Branch assignments updated.")).toBeVisible();
  await expect(
    refreshedMemberRow.getByText("No branches are explicitly assigned."),
  ).toBeVisible();
  await page.reload();
  await page.locator("#members-nav").click();
  const removedMemberRow = page.getByRole("row", {
    name: /E2E Branch Member/,
  });
  await removedMemberRow.getByText("Manage branch access").click();
  await expect(
    removedMemberRow.getByText("No branches are explicitly assigned."),
  ).toBeVisible();
  globalThis.console.info(
    "PASS: branch assignment and removal persist after reload",
  );

  await removedMemberRow.getByText("Manage roles").click();
  const availableRoles = removedMemberRow.getByLabel("Available roles");
  await availableRoles.selectOption({ label: "E2E Read Only" });
  await removedMemberRow.getByRole("button", { name: "Assign role" }).click();
  await expect(page.getByText("Member roles updated.")).toBeVisible();
  await expect(
    removedMemberRow
      .locator(".oc-pagination__controls")
      .filter({ hasText: "E2E Read Only" }),
  ).toBeVisible();
  await page.reload();
  await page.locator("#members-nav").click();
  const roleMemberRow = page.getByRole("row", {
    name: /E2E Branch Member/,
  });
  await roleMemberRow.getByText("Manage roles").click();
  const assignedReadOnlyRole = roleMemberRow
    .locator(".oc-pagination__controls")
    .filter({ hasText: "E2E Read Only" });
  await expect(assignedReadOnlyRole).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await assignedReadOnlyRole.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Member roles updated.")).toBeVisible();
  await page.reload();
  await page.locator("#members-nav").click();
  const verifiedRoleMemberRow = page.getByRole("row", {
    name: /E2E Branch Member/,
  });
  await verifiedRoleMemberRow.getByText("Manage roles").click();
  await expect(
    verifiedRoleMemberRow
      .locator(".oc-pagination__controls")
      .filter({ hasText: "E2E Read Only" }),
  ).toHaveCount(0);
  globalThis.console.info(
    "PASS: member role assignment and removal persist after reload",
  );

  const ownerFailures = await page.evaluate(
    async ({
      organizationId,
      ownerMembershipId,
      memberMembershipId,
      branchId,
      foreignBranchId,
      foreignOrganizationId,
    }) => {
      const post = (path, body) =>
        globalThis.fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const base = `/api/organizations/${organizationId}/members`;
      const [self, foreignOrg, invalidBranch, foreignBranch] =
        await Promise.all([
          post(`${base}/${ownerMembershipId}/branches`, {
            branchIds: [branchId],
          }),
          globalThis.fetch(
            `/api/organizations/${foreignOrganizationId}/branches`,
          ),
          post(`${base}/${memberMembershipId}/branches`, {
            branchIds: ["00000000-0000-4000-8000-000000000099"],
          }),
          post(`${base}/${memberMembershipId}/branches`, {
            branchIds: [foreignBranchId],
          }),
        ]);
      return {
        self: self.status,
        foreignOrg: foreignOrg.status,
        invalidBranch: invalidBranch.status,
        foreignBranch: foreignBranch.status,
      };
    },
    {
      organizationId: fixture.organizationId,
      ownerMembershipId: fixture.ownerMembershipId,
      memberMembershipId: fixture.memberMembershipId,
      branchId: await page.evaluate(async (organizationId) => {
        const response = await globalThis.fetch(
          `/api/organizations/${organizationId}/branches?limit=20&offset=0`,
        );
        const result = await response.json();
        return result.branches.find((branch) => branch.code === "E2E-001")?.id;
      }, fixture.organizationId),
      foreignBranchId: fixture.foreignBranchId,
      foreignOrganizationId: fixture.foreignOrganizationId,
    },
  );
  assert.equal(ownerFailures.self, 403, "self-targeted assignment is rejected");
  assert.equal(
    ownerFailures.foreignOrg,
    404,
    "foreign organization access is hidden",
  );
  assert.equal(
    ownerFailures.invalidBranch,
    404,
    "invalid branch reference is rejected",
  );
  assert.equal(
    ownerFailures.foreignBranch,
    404,
    "cross-tenant branch is rejected",
  );
  globalThis.console.info(
    "PASS: self-target, cross-organization, invalid, and foreign-tenant mutations are rejected",
  );

  await page.locator("#sign-out").click();
  await expect(page.locator("#auth-view")).toBeVisible();
  const viewerPage = await context.newPage();
  await viewerPage.goto(webOrigin);
  await login(viewerPage, viewerEmail, webOrigin);
  const viewerMemberRead = await viewerPage.evaluate(async (organizationId) => {
    const response = await globalThis.fetch(
      `/api/organizations/${organizationId}/members?limit=1`,
    );
    const body = await response.json().catch(() => ({}));
    return {
      status: response.status,
      error: body?.error
        ? { code: body.error.code, message: body.error.message }
        : undefined,
    };
  }, fixture.organizationId);
  assert.equal(
    viewerMemberRead.status,
    200,
    `read-only member list should be authorized: ${JSON.stringify(viewerMemberRead)}`,
  );
  await viewerPage.locator("#members-nav").click();
  const viewerMemberRow = viewerPage.getByRole("row", {
    name: /E2E Branch Member/,
  });
  await viewerMemberRow.getByText("Manage branch access").click();
  await expect(
    viewerMemberRow.getByRole("button", { name: "Assign branch" }),
  ).toHaveCount(0);
  const unauthorizedStatus = await viewerPage.evaluate(
    async ({ organizationId, memberMembershipId, branchId }) => {
      const response = await globalThis.fetch(
        `/api/organizations/${organizationId}/members/${memberMembershipId}/branches`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ branchIds: [branchId] }),
        },
      );
      return response.status;
    },
    {
      organizationId: fixture.organizationId,
      memberMembershipId: fixture.memberMembershipId,
      branchId: await page.evaluate(async (organizationId) => {
        const response = await globalThis.fetch(
          `/api/organizations/${organizationId}/branches?limit=20&offset=0`,
        );
        const result = await response.json();
        return result.branches.find((branch) => branch.code === "E2E-001")?.id;
      }, fixture.organizationId),
    },
  );
  assert.equal(unauthorizedStatus, 403);
  await expect(viewerPage.getByText("Branch assignments updated.")).toHaveCount(
    0,
  );
  globalThis.console.info(
    "PASS: read-only user has no assignment control and API denies mutation",
  );
  await viewerPage.locator("#customers-nav").click();
  const viewerCustomerRow = viewerPage.getByRole("row", {
    name: /E2E Updated Customer/,
  });
  await expect(viewerCustomerRow).toBeVisible();
  await expect(
    viewerPage.getByRole("button", { name: "Create customer" }),
  ).toHaveCount(0);
  await expect(
    viewerCustomerRow.getByRole("button", {
      name: "Edit E2E Updated Customer",
    }),
  ).toHaveCount(0);
  await expect(
    viewerCustomerRow.getByRole("button", { name: "Deactivate" }),
  ).toHaveCount(0);
  await viewerPage.locator("#products-nav").click();
  const viewerCatalogRow = viewerPage.getByRole("row", {
    name: /E2E Browser Product/,
  });
  await expect(viewerCatalogRow).toBeVisible();
  await expect(
    viewerPage.getByRole("button", { name: "Create catalog item" }),
  ).toHaveCount(0);
  await expect(
    viewerCatalogRow.getByRole("button", {
      name: "Edit E2E Browser Service",
    }),
  ).toHaveCount(0);
  await expect(
    viewerCatalogRow.getByRole("button", { name: "Deactivate" }),
  ).toHaveCount(0);
  await viewerPage.locator("#settings-nav").click();
  await expect(
    viewerPage.getByText(
      "You can view organization settings but do not have permission to update them.",
    ),
  ).toBeVisible();
  await expect(
    viewerPage.getByRole("button", { name: "Save organization settings" }),
  ).toHaveCount(0);
  await viewerPage.locator("#organization-nav").click();
  await expect(
    viewerPage.getByText(
      "You can view this business profile but do not have permission to update it.",
    ),
  ).toBeVisible();
  await expect(
    viewerPage.getByRole("button", { name: "Save business profile" }),
  ).toHaveCount(0);
  globalThis.console.info(
    "PASS: read-only Business Manager views hide resource, profile, and settings mutations",
  );

  const profileData = await admin.db
    .select({ contactEmail: businessSettings.contactEmail })
    .from(businessSettings)
    .where(eq(businessSettings.organizationId, fixture.organizationId))
    .limit(1);
  assert.equal(profileData[0]?.contactEmail, "updated-e2e@onecore.test");
  const persistedAssignments = await admin.db.execute(
    sql`
      SELECT count(*)::int AS total
      FROM membership_branches
      WHERE organization_id = ${fixture.organizationId}
        AND membership_id = ${fixture.memberMembershipId}
    `,
  );
  assert.equal(resultRows(persistedAssignments)[0]?.total, 0);
  globalThis.console.info(
    "PASS: test-only PostgreSQL confirms profile persisted and assignment removal persisted",
  );
  globalThis.console.info(
    "PASS: all E2E identities/data and credentials were synthetic and confined to the disposable container",
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  if (apiProcess && apiProcess.exitCode === null) {
    apiProcess.kill("SIGTERM");
    await new Promise((resolvePromise) =>
      apiProcess.once("exit", resolvePromise),
    );
  }
  if (frontend?.listening) {
    await new Promise((resolvePromise, reject) => {
      frontend.close((error) => (error ? reject(error) : resolvePromise()));
    });
  }
  if (adminConnection) await adminConnection.close().catch(() => {});
  if (adminRootConnection) await adminRootConnection.close().catch(() => {});
  if (containerId) {
    try {
      execFileSync("docker", ["stop", containerId], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {
      execFileSync("docker", ["rm", "--force", containerId], {
        cwd: root,
        stdio: "ignore",
      });
    }
  }
  if (screenshotDirectory) {
    await rm(screenshotDirectory, { recursive: true, force: true });
  }
  if (emailCaptureDirectory) {
    await rm(emailCaptureDirectory, { recursive: true, force: true });
  }
}
