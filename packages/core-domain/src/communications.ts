import { z } from "zod";

export const communicationChannels = [
  "EMAIL",
  "SMS",
  "WHATSAPP",
  "IN_APP",
] as const;
export const communicationChannelSchema = z.enum(communicationChannels);
export type CommunicationChannel = z.infer<
  typeof communicationChannelSchema
>;

export const communicationStatuses = [
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "FAILED",
  "RETRYING",
  "DEAD_LETTER",
  "CANCELLED",
] as const;
export const communicationStatusSchema = z.enum(communicationStatuses);
export type CommunicationStatus = z.infer<typeof communicationStatusSchema>;

export const communicationAttemptStatuses = [
  "SENDING",
  "SENT",
  "DELIVERED",
  "RETRYING",
  "FAILED",
  "DEAD_LETTER",
] as const;
export const communicationAttemptStatusSchema = z.enum(
  communicationAttemptStatuses,
);
export type CommunicationAttemptStatus = z.infer<
  typeof communicationAttemptStatusSchema
>;

export const communicationTemplateStatuses = [
  "DRAFT",
  "PUBLISHED",
  "RETIRED",
] as const;
export const communicationTemplateStatusSchema = z.enum(
  communicationTemplateStatuses,
);
export type CommunicationTemplateStatus = z.infer<
  typeof communicationTemplateStatusSchema
>;

const messageMetadataSchema = z
  .record(z.string(), z.json())
  .refine(
    (metadata) =>
      new TextEncoder().encode(JSON.stringify(metadata)).byteLength <= 8_192,
  )
  .refine(
    (metadata) =>
      !/(password|secret|token|api[_-]?key|credential|private[_-]?key|authorization)/i.test(
        JSON.stringify(metadata),
      ),
  );

const sensitiveVariableSegment =
  /(?:password|secret|token|api[_-]?key|credential|private[_-]?key|authorization|cookie|headers?|sql|query|command|script|code|exec|evaluate)/i;

export const templateVariableNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/)
  .refine(
    (name) => !name.split(".").some((segment) => sensitiveVariableSegment.test(segment)),
    "Sensitive variables are not permitted",
  );

export const templateVariablesSchema = z
  .record(
    templateVariableNameSchema,
    z.union([z.string().max(4_096), z.number().finite(), z.boolean()]),
  )
  .refine((variables) => Object.keys(variables).length <= 100)
  .refine(
    (variables) =>
      new TextEncoder().encode(JSON.stringify(variables)).byteLength <= 16_384,
    "Template variables exceed the maximum size",
  );
export type TemplateVariables = z.infer<typeof templateVariablesSchema>;

export const queueCommunicationInputSchema = z
  .object({
    channel: z.enum(["EMAIL", "SMS", "WHATSAPP"]),
    recipientUserId: z.uuid(),
    category: z.string().trim().min(1).max(100).regex(/^[A-Z][A-Z0-9_.-]*$/),
    templateKey: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9_.-]*$/),
    locale: z.string().trim().min(2).max(35).optional(),
    variables: templateVariablesSchema.default({}),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    sourceEventId: z.uuid().optional(),
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
    priority: z.number().int().min(0).max(100).default(0),
    metadata: messageMetadataSchema.default({}),
  })
  .strict();
export type QueueCommunicationInput = z.infer<
  typeof queueCommunicationInputSchema
>;

export const communicationTemplateInputSchema = z
  .object({
    key: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9_.-]*$/),
    channel: communicationChannelSchema,
    locale: z.string().trim().min(2).max(35),
    subject: z.string().trim().max(250).optional(),
    body: z.string().min(1).max(16_384),
    variables: z.array(templateVariableNameSchema).max(100),
  })
  .strict()
  .superRefine((template, context) => {
    if (template.channel === "EMAIL" && !template.subject) {
      context.addIssue({
        code: "custom",
        path: ["subject"],
        message: "Email templates require a subject",
      });
    }
    if (template.channel !== "EMAIL" && template.subject !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["subject"],
        message: "Only email templates may declare a subject",
      });
    }
    const placeholders = [template.body, template.subject ?? ""].flatMap(
      (content) => [...content.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(
        (match) => match[1] ?? "",
      ),
    );
    if (/[{}]/.test(template.body.replace(/{{\s*[^{}]+?\s*}}/g, ""))) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "Template contains an invalid expression",
      });
    }
    if (
      template.subject &&
      /[{}]/.test(template.subject.replace(/{{\s*[^{}]+?\s*}}/g, ""))
    ) {
      context.addIssue({
        code: "custom",
        path: ["subject"],
        message: "Template contains an invalid expression",
      });
    }
    const allowed = new Set(template.variables);
    for (const placeholder of placeholders) {
      if (!templateVariableNameSchema.safeParse(placeholder).success) {
        context.addIssue({
          code: "custom",
          path: ["body"],
          message: "Template contains an invalid variable name",
        });
      } else if (!allowed.has(placeholder)) {
        context.addIssue({
          code: "custom",
          path: ["variables"],
          message: "Template references an undeclared variable",
        });
      }
    }
    if (new Set(template.variables).size !== template.variables.length) {
      context.addIssue({
        code: "custom",
        path: ["variables"],
        message: "Template variables must be unique",
      });
    }
    try {
      if (Intl.getCanonicalLocales(template.locale).length !== 1) {
        throw new RangeError();
      }
    } catch {
      context.addIssue({
        code: "custom",
        path: ["locale"],
        message: "Template locale must be a valid BCP 47 locale",
      });
    }
  });
export type CommunicationTemplateInput = z.infer<
  typeof communicationTemplateInputSchema
>;

export interface RenderedCommunicationContent {
  subject: string | null;
  body: string;
}

export class CommunicationTemplateError extends Error {
  constructor(readonly code: "TEMPLATE_VARIABLE_MISSING" | "TEMPLATE_INVALID") {
    super(code);
    this.name = "CommunicationTemplateError";
  }
}

function renderText(
  content: string,
  declaredVariables: readonly string[],
  variables: TemplateVariables,
): string {
  const declared = new Set(declaredVariables);
  return content.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, name: string) => {
    if (!declared.has(name)) {
      throw new CommunicationTemplateError("TEMPLATE_INVALID");
    }
    if (!Object.hasOwn(variables, name)) {
      throw new CommunicationTemplateError("TEMPLATE_VARIABLE_MISSING");
    }
    return String(variables[name]);
  });
}

export function renderCommunicationTemplate(
  template: CommunicationTemplateInput,
  inputVariables: unknown,
): RenderedCommunicationContent {
  const parsedTemplate = communicationTemplateInputSchema.safeParse(template);
  const parsedVariables = templateVariablesSchema.safeParse(inputVariables);
  if (!parsedTemplate.success || !parsedVariables.success) {
    throw new CommunicationTemplateError("TEMPLATE_INVALID");
  }
  return {
    subject: parsedTemplate.data.subject
      ? renderText(
          parsedTemplate.data.subject,
          parsedTemplate.data.variables,
          parsedVariables.data,
        )
      : null,
    body: renderText(
      parsedTemplate.data.body,
      parsedTemplate.data.variables,
      parsedVariables.data,
    ),
  };
}

export function communicationLocaleFallbackChain(
  requestedLocale: string,
  organizationLocale: string,
  platformLocale = "en",
): string[] {
  function canonicalize(locale: string): string {
    try {
      const [canonical] = Intl.getCanonicalLocales(locale);
      if (!canonical) throw new RangeError();
      return canonical;
    } catch {
      throw new TypeError("Invalid communication locale");
    }
  }

  const requested = canonicalize(requestedLocale);
  const organization = canonicalize(organizationLocale);
  const platform = canonicalize(platformLocale);
  return [
    ...new Set([
      requested,
      requested.split("-")[0] ?? requested,
      organization,
      organization.split("-")[0] ?? organization,
      platform,
    ]),
  ];
}

export function selectCommunicationTemplateLocale(
  availableLocales: readonly string[],
  requestedLocale: string,
  organizationLocale: string,
  platformLocale = "en",
): string | undefined {
  const available = new Set(availableLocales.map((locale) =>
    Intl.getCanonicalLocales(locale)[0],
  ));
  return communicationLocaleFallbackChain(
    requestedLocale,
    organizationLocale,
    platformLocale,
  ).find((locale) => available.has(locale));
}

export function resolveCommunicationPreference(input: {
  platformDefault: boolean;
  organizationDefault?: boolean;
  userOverride?: boolean;
}): boolean {
  return (
    input.userOverride ?? input.organizationDefault ?? input.platformDefault
  );
}

export type CommunicationProviderFailureClass =
  | "RETRYABLE"
  | "PERMANENT"
  | "RATE_LIMITED";

export const communicationProviderResultSchema = z
  .object({
    outcome: z.enum([
      "SENT",
      "DELIVERED",
      "RETRYABLE_FAILURE",
      "PERMANENT_FAILURE",
      "RATE_LIMITED",
    ]),
    providerMessageId: z.string().trim().min(1).max(200).optional(),
    failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).optional(),
    retryAfterSeconds: z.number().int().min(0).max(86_400).optional(),
  })
  .strict();
export type CommunicationProviderResult = z.infer<
  typeof communicationProviderResultSchema
>;

export interface CommunicationProviderInput {
  channel: Exclude<CommunicationChannel, "IN_APP">;
  deliveryId: string;
  idempotencyKey: string;
  recipient: { userId: string; address: string };
  subject: string | null;
  body: string;
  configuration: Record<string, unknown>;
}

export interface CommunicationProvider {
  readonly providerKey: string;
  readonly channel: Exclude<CommunicationChannel, "IN_APP">;
  validateConfiguration(configuration: unknown): boolean;
  send(
    input: CommunicationProviderInput,
    credential: Uint8Array,
  ): Promise<CommunicationProviderResult>;
}