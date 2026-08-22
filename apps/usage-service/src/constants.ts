export const USAGE_SERVICE_NAME = "usage-service";

export const USAGE_SERVICE_ROUTES = {
  HEALTH: "/health",
  USAGE_EVENTS: "/v1/usage/events"
} as const;

export const USAGE_SERVICE_HEADERS = {
  TENANT_ID: "x-tenant-id"
} as const;

export const USAGE_SERVICE_RESPONSES = {
  STATUS_OK: "ok",
  STATUS_ACCEPTED: "accepted",
  VERSION_V1: "v1",
  CODE_VALIDATION_ERROR: "VALIDATION_ERROR",
  CODE_TENANT_MISMATCH: "TENANT_MISMATCH",
  MESSAGE_TENANT_MISMATCH: "Event tenantId does not match authenticated tenant context"
} as const;

export const USAGE_SERVICE_RUNTIME = {
  DEFAULT_PORT: 3002,
  HOST: "0.0.0.0"
} as const;
