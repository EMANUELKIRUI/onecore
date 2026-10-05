export interface HealthResponse {
  status: "ok";
}

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "INTERNAL_SERVER_ERROR"
  | "NOT_FOUND"
  | "TOO_MANY_REQUESTS"
  | "UNAUTHORIZED";

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}
