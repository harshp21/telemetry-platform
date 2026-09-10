import {
  EVENT_STREAM_CONSTANTS,
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

/**
 * PostgreSQL session settings written, transaction-locally, at the start of every
 * tenant-scoped transaction (`TenantScopedRepository.withTenant`).
 *
 * `TIME_ZONE` is pinned because `"UsageLine"."periodStart"` -- and all 20 application
 * timestamp columns -- are `timestamp(3) without time zone`. A `timestamptz` bound compared
 * against a naive column resolves through the SESSION zone, so an unpinned session makes the
 * same query return different rows on different servers (S-18).
 */
export const DATABASE_SESSION_SETTINGS = {
  TENANT_ID: "app.tenant_id",
  TIME_ZONE: "TimeZone",
  TIME_ZONE_UTC: "UTC"
} as const;

/**
 * Fixed SQL text this service splices into raw queries. Plain strings, never
 * `Prisma.Sql` — `constants.ts` is imported by `app.ts`, both controllers, both route
 * modules, all three middleware and the validator, and `@prisma/client` does not belong in
 * that graph. The consuming repository wraps each entry in `Prisma.raw` once, at module
 * scope, and keeps the resulting fragment module-private.
 *
 * The same treatment `apps/auth-service/src/constants.ts` gives its resolver function names
 * (`AUTH_DATABASE.RESOLVE_TENANT_BY_EMAIL_FN`, wrapped at
 * `apps/auth-service/src/repositories/user.repository.ts`).
 *
 * `UTC_NAIVE_TIMESTAMP_CAST` is the cast every timestamp bound in raw SQL must carry.
 * `"UsageLine"."periodStart"` is `timestamp(3) without time zone`; the precision must match
 * the column, because a narrower cast rounds (measured: `'2026-01-31T23:59:59.999Z'` under
 * `::timestamp(0)` becomes `2026-02-01 00:00:00`, which moves a row across an exclusive
 * upper bound), and `::timestamptz` reintroduces S-18 outright.
 */
export const DATABASE_SQL = {
  UTC_NAIVE_TIMESTAMP_CAST: "::timestamp(3)"
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
  // Single-sourced from `@telemetry/shared-types`: a rename there reddens this service's,
  // worker-service's and shared-types' suites together. Re-pinning this line to a literal
  // still diverges silently -- see `EVENT_STREAM_CONSTANTS` there, and worker-service's
  // `WORKER_STREAM_CONSTANTS`.
  DEFAULT_STREAM_NAME: EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM,
  DEFAULT_MAX_LEN: 100_000
} as const;
