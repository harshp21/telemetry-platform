import type { Role as PrismaRole } from "@prisma/client";

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
  CODE_CSRF_INVALID: "CSRF_TOKEN_INVALID",
  CODE_TOKEN_MISSING: "TOKEN_MISSING",
  CODE_TOKEN_INVALID: "TOKEN_INVALID",
  CODE_TOKEN_EXPIRED: "TOKEN_EXPIRED",
  CODE_TOKEN_REVOKED: "TOKEN_REVOKED"
} as const;

export const AUTH_HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
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
  CSRF_INVALID: "Invalid CSRF token",
  TOKEN_MISSING: "Token missing or malformed",
  TOKEN_INVALID: "Token invalid",
  TOKEN_EXPIRED: "Token expired",
  TOKEN_REVOKED: "Token revoked"
} as const;

export const AUTH_SECURITY = {
  // Known bcrypt hash used to equalize compare path when user is not found.
  DUMMY_PASSWORD_HASH: "$2a$12$KIX6xK7A4f8QfU.giM01QOOmy2P8xRa4L95tdV4QvVYc0QjM7zGx2"
} as const;

// PostgreSQL objects auth-service depends on by name. The two resolver functions are created
// by prisma/migrations/v1_5_auth_tenant_resolvers and are the only way this service can look
// up a tenant *before* one is known (login, the duplicate-email pre-check, refresh rotation).
//
// Three roles, and the distinction is the security boundary: AUTH_APP_ROLE is auth-service's
// own runtime connection and the only role granted EXECUTE on the resolvers; SHARED_APP_ROLE
// is the role the other five services share and must NOT be able to call them; DEFINER_ROLE
// is NOLOGIN and owns them.
export const AUTH_DATABASE = {
  TENANT_CONTEXT_SETTING: "app.tenant_id",
  RESOLVE_TENANT_BY_EMAIL_FN: "public.auth_resolve_tenant_by_email",
  RESOLVE_TENANT_BY_REFRESH_TOKEN_HASH_FN:
    "public.auth_resolve_tenant_by_refresh_token_hash",
  DEFINER_ROLE: "telemetry_auth_definer",
  DEFINER_USER_READ_POLICY: "user_auth_definer_read",
  DEFINER_REFRESH_TOKEN_READ_POLICY: "refreshtoken_auth_definer_read",
  AUTH_APP_ROLE: "telemetry_auth_app",
  SHARED_APP_ROLE: "telemetry_app",
  // Prisma's unique-constraint error code, the backstop for a concurrent registration that
  // wins the race between the duplicate-email pre-check and the insert.
  UNIQUE_VIOLATION_CODE: "P2002",
  // "record required but not found" -- what an `update` whose `where` matches nothing raises,
  // including a refresh-token write whose tenant predicate excludes the row.
  RECORD_NOT_FOUND_CODE: "P2025"
} as const;

// Role assigned to the first user of a new tenant, and the tenant defaults registration
// creates a workspace with.
export const AUTH_ROLES = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MEMBER: "MEMBER"
} as const;

/** The role union, derived so it cannot drift from `AUTH_ROLES`. */
export type AuthRole = (typeof AUTH_ROLES)[keyof typeof AUTH_ROLES];

/**
 * `AUTH_ROLES` restates `enum Role` in `prisma/schema.prisma`, and `jwt.plugin.ts` *rejects* a
 * token whose role is not in it, so the two must not drift. **Both** assignments are needed, and
 * one is not a tidier form of the other:
 *
 * - Schema gains `VIEWER`, `AUTH_ROLES` does not → the first fails (`TS2741`). Without it, the
 *   JWT boundary would reject legitimate tokens for a role the database issues.
 * - `AUTH_ROLES` gains `SUPERADMIN`, the schema does not → the *second* fails (`TS2322`). The
 *   first compiles clean here, because excess-property checking applies only to fresh object
 *   literals and `AuthRole` is derived from `AUTH_ROLES`, so the value type widens with the extra
 *   key. This is the direction that matters more: `jwt.plugin.ts` gates on
 *   `Object.values(AUTH_ROLES)`, so a role added only here is a role the boundary starts
 *   *accepting*.
 *
 * `import type` only: `constants.ts` must stay side-effect-free, because `index.ts` imports
 * startup constants before `initTracing(...)`.
 */
const _roleParityForward: Record<PrismaRole, AuthRole> = AUTH_ROLES;
const _roleParityReverse: Record<AuthRole, PrismaRole> = AUTH_ROLES;
void _roleParityForward;
void _roleParityReverse;

export const AUTH_TENANT_DEFAULTS = {
  PLAN: "FREE",
  TIMEZONE: "UTC"
} as const;

export const AUTH_TOKENS = {
  ACCESS_TTL_SECONDS_DEFAULT: 900,
  ACCESS_TTL_SECONDS_MAX: 900,
  REFRESH_TTL_SECONDS_DEFAULT: 604800
} as const;

export const AUTH_COOKIES = {
  REFRESH_COOKIE_NAME_DEFAULT: "tp_refresh_token",
  CSRF_COOKIE_NAME_DEFAULT: "tp_csrf_token",
  CSRF_HEADER_NAME_DEFAULT: "x-csrf-token",
  COOKIE_PATH_DEFAULT: "/v1/auth",
  SAME_SITE_DEFAULT: "Lax",
  CLEAR_COOKIE_MAX_AGE_SECONDS: 0
} as const;

export const AUTH_RUNTIME = {
  DEFAULT_PORT: 3001,
  HOST: "0.0.0.0"
} as const;
