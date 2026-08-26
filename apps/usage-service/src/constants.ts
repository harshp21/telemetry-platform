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
  MESSAGE_TENANT_MISMATCH: "Event tenantId does not match authenticated tenant context",
  CODE_TENANT_CONTEXT_MISSING: "TENANT_CONTEXT_MISSING",
  MESSAGE_TENANT_CONTEXT_MISSING: "X-Tenant-Id header is required",
  HTTP_STATUS_ACCEPTED: 202,
  HTTP_STATUS_FORBIDDEN: 403,
  HTTP_STATUS_UNAUTHORIZED: 401
} as const;

export const USAGE_SERVICE_RUNTIME = {
  DEFAULT_PORT: 3002,
  HOST: "0.0.0.0"
} as const;

export const DEDUP_CONSTANTS = {
  KEY_PREFIX: "dedup:",
  KEY_TTL_SECONDS: 86400 // 24 hours
} as const;

export const STREAM_CONSTANTS = {
  DEFAULT_STREAM_NAME: "telemetry:events",
  DEFAULT_MAX_LEN: 100_000
} as const;
