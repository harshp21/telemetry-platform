export const GATEWAY_SERVICE_NAME = "gateway";

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
