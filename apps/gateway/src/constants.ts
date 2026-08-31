import { INTERNAL_AUTH_HEADERS } from "@telemetry/shared-types";

export const GATEWAY_SERVICE_NAME = "gateway";

/**
 * Headers the gateway owns end to end.
 *
 * Everything in `SPOOFABLE` is stripped from the inbound request and re-set by the gateway from
 * its own verified state, so an upstream service can trust them. `x-internal-secret` belongs in
 * that set for the same reason the identity headers do: usage-service treats it as proof the
 * request came through the gateway, so it must never be accepted from outside.
 */
export const GATEWAY_HEADERS = {
  TENANT_ID: "x-tenant-id",
  USER_ID: "x-user-id",
  USER_ROLE: "x-user-role",
  REQUEST_ID: "x-request-id",
  INTERNAL_SECRET: INTERNAL_AUTH_HEADERS.INTERNAL_SECRET
} as const;

export const GATEWAY_SPOOFABLE_HEADERS = [
  GATEWAY_HEADERS.TENANT_ID,
  GATEWAY_HEADERS.USER_ID,
  GATEWAY_HEADERS.USER_ROLE,
  GATEWAY_HEADERS.INTERNAL_SECRET
] as const;

export const GATEWAY_ROUTES = {
  HEALTH: "/health",
  V1_HEALTH: "/v1/health"
} as const;

export const GATEWAY_PROXY_PREFIXES = {
  AUTH: "/v1/auth",
  USAGE: "/v1/usage",
  BILLING: "/v1/billing",
  ANALYTICS: "/v1/analytics"
} as const;

export const GATEWAY_USAGE_ROUTES = {
  EVENTS: `${GATEWAY_PROXY_PREFIXES.USAGE}/events`
} as const;

export const GATEWAY_AUTH_ROUTES = {
  REGISTER: `${GATEWAY_PROXY_PREFIXES.AUTH}/register`,
  LOGIN: `${GATEWAY_PROXY_PREFIXES.AUTH}/login`,
  REFRESH: `${GATEWAY_PROXY_PREFIXES.AUTH}/refresh`
} as const;

export const GATEWAY_PUBLIC_ROUTES = [
  { method: "GET", path: GATEWAY_ROUTES.HEALTH },
  { method: "GET", path: GATEWAY_ROUTES.V1_HEALTH },
  { method: "POST", path: GATEWAY_AUTH_ROUTES.REGISTER },
  { method: "POST", path: GATEWAY_AUTH_ROUTES.LOGIN },
  { method: "POST", path: GATEWAY_AUTH_ROUTES.REFRESH }
] as const;

export const GATEWAY_RESPONSES = {
  STATUS_OK: "ok",
  VERSION_V1: "v1",
  CODE_RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  CODE_PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  CODE_UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE"
} as const;

export const GATEWAY_GUARDS = {
  MAX_CONTENT_LENGTH_BYTES: 1048576,
  JSON_CONTENT_TYPE: "application/json"
} as const;

export const GATEWAY_RUNTIME = {
  DEFAULT_PORT: 3100,
  HOST: "0.0.0.0"
} as const;
