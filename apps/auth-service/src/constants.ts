export const AUTH_SERVICE_NAME = "auth-service";

export const AUTH_ROUTES = {
  HEALTH: "/health"
} as const;

export const AUTH_RESPONSES = {
  STATUS_OK: "ok"
} as const;

export const AUTH_RUNTIME = {
  DEFAULT_PORT: 3001,
  HOST: "0.0.0.0"
} as const;
