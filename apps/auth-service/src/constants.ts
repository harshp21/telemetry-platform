export const AUTH_SERVICE_NAME = "auth-service";

export const AUTH_ROUTES = {
  HEALTH: "/health",
  V1_AUTH: "/v1/auth",
  REGISTER: "/register"
} as const;

export const AUTH_RESPONSES = {
  STATUS_OK: "ok",
  CODE_EMAIL_ALREADY_EXISTS: "EMAIL_ALREADY_EXISTS"
} as const;

export const AUTH_RUNTIME = {
  DEFAULT_PORT: 3001,
  HOST: "0.0.0.0"
} as const;
