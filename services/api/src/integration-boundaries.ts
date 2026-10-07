import type { SecretStore } from "@onecore/core-domain";

export class IntegrationBackendUnavailableError extends Error {
  constructor(readonly backend: "SECRET_STORE" | "WEBHOOK_TRANSPORT") {
    super(`${backend}_UNAVAILABLE`);
    this.name = "IntegrationBackendUnavailableError";
  }
}

export const unavailableSecretStore: SecretStore = {
  store: async () => {
    throw new IntegrationBackendUnavailableError("SECRET_STORE");
  },
  rotate: async () => {
    throw new IntegrationBackendUnavailableError("SECRET_STORE");
  },
  withSecret: async () => {
    throw new IntegrationBackendUnavailableError("SECRET_STORE");
  },
  delete: async () => {
    throw new IntegrationBackendUnavailableError("SECRET_STORE");
  },
  metadata: async () => {
    throw new IntegrationBackendUnavailableError("SECRET_STORE");
  },
};

export interface OutboundWebhookRequest {
  endpointUrl: string;
  deliveryId: string;
  timestamp: number;
  payload: Uint8Array;
  signature: string;
}

export interface OutboundWebhookResponse {
  statusCode: number;
  responseMetadata: Record<string, string>;
}

export interface OutboundWebhookTransport {
  readonly securityPolicy: "SSRF_SAFE";
  send(input: OutboundWebhookRequest): Promise<OutboundWebhookResponse>;
}

export const failClosedWebhookTransport: OutboundWebhookTransport = {
  securityPolicy: "SSRF_SAFE",
  async send() {
    throw new IntegrationBackendUnavailableError("WEBHOOK_TRANSPORT");
  },
};
