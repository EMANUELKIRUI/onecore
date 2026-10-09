import { ApiError } from "../../../packages/ui/src/api-client.js";

const applicationStatuses = new Set([
  "PENDING",
  "UNDER_REVIEW",
  "APPROVED",
  "PAYMENT_PENDING",
  "ACTIVE",
  "SUSPENDED",
  "EXPIRED",
  "REJECTED",
  "CANCELLED",
]);

export function parseApplicationResponse(response) {
  const application = response?.application;
  if (
    typeof application?.reference !== "string" ||
    !application.reference ||
    typeof application.organizationName !== "string" ||
    !application.organizationName ||
    typeof application.status !== "string" ||
    !applicationStatuses.has(application.status) ||
    typeof application.submittedAt !== "string" ||
    Number.isNaN(Date.parse(application.submittedAt))
  ) {
    throw new ApiError(
      201,
      "INVALID_RESPONSE",
      "The service returned an unexpected application response.",
    );
  }
  return application;
}
