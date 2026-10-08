import type {
  CommunicationChannel,
  CommunicationProvider,
  CommunicationProviderInput,
  CommunicationProviderResult,
} from "@onecore/core-domain";

export interface TestProviderCall {
  channel: Exclude<CommunicationChannel, "IN_APP">;
  deliveryId: string;
  idempotencyKey: string;
  recipientUserId: string;
}

abstract class DeterministicTestProvider implements CommunicationProvider {
  readonly calls: TestProviderCall[] = [];

  protected constructor(
    readonly channel: Exclude<CommunicationChannel, "IN_APP">,
    readonly providerKey: string,
    private readonly outcomes: CommunicationProviderResult[],
  ) {}

  validateConfiguration(configuration: unknown): boolean {
    return (
      typeof configuration === "object" &&
      configuration !== null &&
      !Array.isArray(configuration)
    );
  }

  async send(
    input: CommunicationProviderInput,
    _credential: Uint8Array,
  ): Promise<CommunicationProviderResult> {
    this.calls.push({
      channel: input.channel,
      deliveryId: input.deliveryId,
      idempotencyKey: input.idempotencyKey,
      recipientUserId: input.recipient.userId,
    });
    return (
      this.outcomes.shift() ?? {
        outcome: "PERMANENT_FAILURE",
        failureCode: "TEST_OUTCOMES_EXHAUSTED",
      }
    );
  }
}

export class TestEmailProvider extends DeterministicTestProvider {
  constructor(outcomes: CommunicationProviderResult[]) {
    super("EMAIL", "test.email", outcomes);
  }
}

export class TestSmsProvider extends DeterministicTestProvider {
  constructor(outcomes: CommunicationProviderResult[]) {
    super("SMS", "test.sms", outcomes);
  }
}

export class TestWhatsAppProvider extends DeterministicTestProvider {
  constructor(outcomes: CommunicationProviderResult[]) {
    super("WHATSAPP", "test.whatsapp", outcomes);
  }
}
