export const AUTH_SERVICE_NAME = "auth-service";

export const AUTH_ROUTES = {
  HEALTH: "/health",
  V1_AUTH: "/v1/auth",
  REGISTER: "/register",
  LOGIN: "/login",
  REFRESH: "/refresh",
  LOGOUT: "/logout"
} as const;

export const AUTH_RESPONSES = {
  STATUS_OK: "ok",
  CODE_EMAIL_ALREADY_EXISTS: "EMAIL_ALREADY_EXISTS",
  CODE_INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  CODE_REFRESH_TOKEN_INVALID: "REFRESH_TOKEN_INVALID",
  CODE_UNAUTHORIZED: "UNAUTHORIZED",
  CODE_TOKEN_MISSING: "TOKEN_MISSING",
  CODE_TOKEN_INVALID: "TOKEN_INVALID",
  CODE_TOKEN_EXPIRED: "TOKEN_EXPIRED",
  CODE_TOKEN_REVOKED: "TOKEN_REVOKED"
} as const;

export const AUTH_HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  UNAUTHORIZED: 401,
  CONFLICT: 409
} as const;

export const AUTH_VALIDATION = {
  PASSWORD_MIN_LENGTH: 8,
  BCRYPT_MIN_ROUNDS: 10,
  BCRYPT_MAX_ROUNDS: 14,
  BCRYPT_DEFAULT_ROUNDS: 12
} as const;

export const AUTH_MESSAGES = {
  REGISTRATION_FAILED: "Registration failed",
  INVALID_CREDENTIALS: "Invalid credentials",
  INVALID_REFRESH_TOKEN: "Invalid refresh token",
  UNAUTHORIZED: "Unauthorized",
  TOKEN_MISSING: "Token missing or malformed",
  TOKEN_INVALID: "Token invalid",
  TOKEN_EXPIRED: "Token expired",
  TOKEN_REVOKED: "Token revoked"
} as const;

export const AUTH_SECURITY = {
  // Known bcrypt hash used to equalize compare path when user is not found.
  DUMMY_PASSWORD_HASH: "$2a$12$KIX6xK7A4f8QfU.giM01QOOmy2P8xRa4L95tdV4QvVYc0QjM7zGx2"
} as const;

export const AUTH_TOKENS = {
  ACCESS_TTL_SECONDS_DEFAULT: 900,
  REFRESH_TTL_SECONDS_DEFAULT: 604800
} as const;

export const AUTH_RUNTIME = {
  DEFAULT_PORT: 3001,
  HOST: "0.0.0.0"
} as const;
