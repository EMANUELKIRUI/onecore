export class ApiError extends Error {
  constructor(status, code, message, mfa) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.mfa = mfa;
  }
}

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function createApiClient(basePath = "", fetchImplementation = fetch) {
  if (
    basePath &&
    (!basePath.startsWith("/") ||
      basePath.startsWith("//") ||
      basePath.includes("\\") ||
      containsControlCharacter(basePath))
  ) {
    throw new TypeError("API base path must be a same-origin absolute path");
  }
  const normalizedBasePath = basePath.replace(/\/+$/, "");

  return {
    async request(
      path,
      { method = "GET", body, signal, headers = {}, expectedStatus } = {},
    ) {
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        path.includes("\\") ||
        containsControlCharacter(path)
      ) {
        throw new TypeError("API path must be same-origin and absolute");
      }
      let response;
      try {
        response = await fetchImplementation(`${normalizedBasePath}${path}`, {
          method,
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "AbortError"
        ) {
          throw error;
        }
        throw new ApiError(
          0,
          "NETWORK_ERROR",
          "The service could not be reached. Check your connection and try again.",
        );
      }

      if (expectedStatus !== undefined && response.status !== expectedStatus) {
        if (response.ok) {
          throw new ApiError(
            response.status,
            "UNEXPECTED_STATUS",
            "The service returned an unexpected response.",
          );
        }
      }
      if (response.status === 204) return null;
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new ApiError(
          response.status,
          "INVALID_RESPONSE",
          "The service returned an unexpected response.",
        );
      }
      if (!response.ok) {
        const error = payload?.error;
        const mfa = payload?.mfa;
        const mfaRequirement =
          error?.code === "MFA_REQUIRED" &&
          mfa?.required === true &&
          mfa?.method === "totp" &&
          ["enrollment_required", "challenge_required"].includes(mfa?.status)
            ? {
                required: true,
                method: "totp",
                status: mfa.status,
              }
            : undefined;
        throw new ApiError(
          response.status,
          typeof error?.code === "string" ? error.code : "REQUEST_FAILED",
          typeof error?.message === "string"
            ? error.message
            : "The request could not be completed.",
          mfaRequirement,
        );
      }
      return payload;
    },
  };
}
