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

export const GATEWAY_RESPONSES = {
  STATUS_OK: "ok",
  VERSION_V1: "v1"
} as const;

export const GATEWAY_RUNTIME = {
  DEFAULT_PORT: 3100,
  HOST: "0.0.0.0"
} as const;
