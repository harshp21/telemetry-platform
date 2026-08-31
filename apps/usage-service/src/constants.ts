import {
  INTERNAL_AUTH_HEADERS,
  INTERNAL_AUTH_RESPONSES
} from "@telemetry/shared-types";

export const USAGE_SERVICE_NAME = "usage-service";

export const USAGE_SERVICE_ROUTES = {
  HEALTH: "/health",
  USAGE_EVENTS: "/v1/usage/events",
  USAGE_SUMMARY: "/v1/usage/summary"
} as const;

export const USAGE_SERVICE_HEADERS = {
  TENANT_ID: "x-tenant-id",
  INTERNAL_SECRET: INTERNAL_AUTH_HEADERS.INTERNAL_SECRET
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
  CODE_TENANT_CONTEXT_INVALID: "TENANT_CONTEXT_INVALID",
  MESSAGE_TENANT_CONTEXT_INVALID: "X-Tenant-Id header must be a valid UUID",
  CODE_UNAUTHORIZED: INTERNAL_AUTH_RESPONSES.CODE_UNAUTHORIZED,
  MESSAGE_UNAUTHORIZED: INTERNAL_AUTH_RESPONSES.MESSAGE_UNAUTHORIZED,
  CODE_INTERNAL_ERROR: "INTERNAL_ERROR",
  MESSAGE_INTERNAL_ERROR: "Internal server error",
  MESSAGE_TENANT_CONTEXT_REQUIRED: "Missing tenantId from context",
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_ACCEPTED: 202,
  HTTP_STATUS_BAD_REQUEST: 400,
  HTTP_STATUS_FORBIDDEN: 403,
  HTTP_STATUS_UNAUTHORIZED: 401,
  HTTP_STATUS_INTERNAL_ERROR: 500
} as const;

/**
 * Supported usage-summary bucket granularities.
 *
 * These values are the ONLY keys accepted by the repository's fixed SQL fragment
 * map, which is what keeps `DATE_TRUNC` free of caller-supplied strings.
 */
export const USAGE_SUMMARY_GRANULARITY = {
  HOUR: "hour",
  DAY: "day",
  WEEK: "week"
} as const;

export const USAGE_SUMMARY_CONSTANTS = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MIN_PAGE: 1,
  MIN_PAGE_SIZE: 1,
  MAX_PAGE_SIZE: 100,
  MESSAGE_INVALID_RANGE: "from must be earlier than to"
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
