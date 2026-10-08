import { describe, expect, it } from "vitest";
import {
  communicationLocaleFallbackChain,
  communicationTemplateInputSchema,
  renderCommunicationTemplate,
  resolveCommunicationPreference,
  selectCommunicationTemplateLocale,
  queueCommunicationInputSchema,
} from "../src/communications.js";

const emailTemplate = {
  key: "account.welcome",
  channel: "EMAIL" as const,
  locale: "en-GB",
  subject: "Welcome {{customer.name}}",
  body: "Hello {{customer.name}}, your reference is {{account.reference}}.",
  variables: ["customer.name", "account.reference"],
};

describe("communications domain contracts", () => {
  it("renders only declared scalar variables as inert text", () => {
    expect(
      renderCommunicationTemplate(emailTemplate, {
        "customer.name": "Ari",
        "account.reference": "A-104",
      }),
    ).toEqual({
      subject: "Welcome Ari",
      body: "Hello Ari, your reference is A-104.",
    });
    expect(() =>
      renderCommunicationTemplate(emailTemplate, {
        "customer.name": "Ari",
      }),
    ).toThrow("TEMPLATE_VARIABLE_MISSING");
  });

  it("rejects undeclared, sensitive, executable, and malformed expressions", () => {
    expect(
      communicationTemplateInputSchema.safeParse({
        ...emailTemplate,
        body: "{{customer.name}} {{customer.email}}",
      }).success,
    ).toBe(false);
    expect(
      communicationTemplateInputSchema.safeParse({
        ...emailTemplate,
        variables: [...emailTemplate.variables, "account.token"],
      }).success,
    ).toBe(false);
    expect(
      communicationTemplateInputSchema.safeParse({
        ...emailTemplate,
        variables: [...emailTemplate.variables, "customer.passwordHash"],
      }).success,
    ).toBe(false);
    expect(
      communicationTemplateInputSchema.safeParse({
        ...emailTemplate,
        body: "{{customer.name.toUpperCase()}}",
      }).success,
    ).toBe(false);
    expect(
      communicationTemplateInputSchema.safeParse({
        ...emailTemplate,
        body: "{{customer.name",
      }).success,
    ).toBe(false);
  });

  it("applies regional, language, organization, then platform locale fallback", () => {
    expect(communicationLocaleFallbackChain("fr-CA", "sw-KE")).toEqual([
      "fr-CA",
      "fr",
      "sw-KE",
      "sw",
      "en",
    ]);
    expect(
      selectCommunicationTemplateLocale(["en", "sw", "fr"], "fr-CA", "sw-KE"),
    ).toBe("fr");
    expect(selectCommunicationTemplateLocale(["sw"], "fr-CA", "sw-KE")).toBe(
      "sw",
    );
    expect(selectCommunicationTemplateLocale(["en"], "fr-CA", "sw-KE")).toBe(
      "en",
    );
  });

  it("resolves preferences by user, organization, then platform precedence", () => {
    expect(
      resolveCommunicationPreference({
        platformDefault: false,
        organizationDefault: true,
        userOverride: false,
      }),
    ).toBe(false);
    expect(
      resolveCommunicationPreference({
        platformDefault: false,
        organizationDefault: true,
      }),
    ).toBe(true);
    expect(resolveCommunicationPreference({ platformDefault: false })).toBe(
      false,
    );
  });

  it("rejects secrets in communication metadata and bounds enqueue inputs", () => {
    const valid = {
      channel: "EMAIL",
      recipientUserId: "11111111-1111-4111-8111-111111111111",
      category: "ACCOUNT_NOTICE",
      templateKey: "account.notice",
      variables: { "customer.name": "Ari" },
    };
    expect(queueCommunicationInputSchema.safeParse(valid).success).toBe(true);
    expect(
      queueCommunicationInputSchema.safeParse({
        ...valid,
        metadata: { accessToken: "redacted-test" },
      }).success,
    ).toBe(false);
    expect(
      queueCommunicationInputSchema.safeParse({
        ...valid,
        channel: "PUSH",
      }).success,
    ).toBe(false);
  });
});
