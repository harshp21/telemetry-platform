# Epic 4 — Auth Service

**Milestone**: v1-mvp
**Depends on**: Epic 1, Epic 2, Epic 3
**Blocks**: Epic 5 (gateway JWT hook), Epic 11 (frontend auth)

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q5 — Refresh token delivery | HttpOnly cookie or response body JSON? Affects login response contract and gateway config |

---

## T-017 · Auth service env schema

**File**: `apps/auth-service/src/config/env.ts`

**Story**: Extend the existing generic `EnvSchema` with auth-specific variables.

```ts
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),
});
```

---

## T-018 · Register — `POST /v1/auth/register`

**Files**: `controllers/auth.controller.ts`, `services/auth.service.ts`, `repositories/user.repository.ts`

**Request body**:
```ts
{ email: string; password: string; tenantName: string }
```

**Logic**:
1. Validate body with Zod (`password` min 8 chars, valid email format)
2. Check `User` uniqueness by email — `409` if exists
3. Open Prisma transaction: create `Tenant` → create `User` with `bcrypt.hash(password, BCRYPT_ROUNDS)`
4. Return `201 { data: { userId, tenantId } }`

**Error responses**:
- `400` — Zod validation failure
- `409 { code: 'EMAIL_ALREADY_EXISTS' }` — duplicate email

**Security**: Never return the password hash. Use generic error message that doesn't confirm email existence before registration.

---

## T-019 · Login — `POST /v1/auth/login`

**Files**: `controllers/auth.controller.ts`, `services/auth.service.ts`, `services/token.service.ts`

**Request body**:
```ts
{ email: string; password: string }
```

**Logic**:
1. Find `User` by email — if not found, still run `bcrypt.compare` against a dummy hash (timing attack prevention)
2. `bcrypt.compare(password, user.passwordHash)` — `401` on mismatch
3. Generate access token: `jose` `SignJWT` with payload `{ sub: userId, tenantId, role, jti: crypto.randomUUID() }`, signed HS256, TTL from `JWT_ACCESS_TTL_SECONDS`
4. Generate refresh token: `crypto.randomBytes(32).toString('hex')`, store SHA-256 hash in `RefreshToken` table with `expiresAt`
5. Return per Q5 decision:
   - **Cookie**: Set `HttpOnly; Secure; SameSite=Strict` cookie for refresh token, return `{ data: { accessToken, expiresIn } }`
   - **Body**: Return `{ data: { accessToken, refreshToken, expiresIn } }`

**Error responses**:
- `401 { code: 'INVALID_CREDENTIALS' }` — same message for "not found" and "wrong password"

---

## T-020 · Token refresh — `POST /v1/auth/refresh`

**Files**: `controllers/auth.controller.ts`, `services/token.service.ts`, `repositories/refresh-token.repository.ts`

**Request**: Refresh token from body or cookie (per Q5 decision)

**Logic**:
1. SHA-256 hash the incoming refresh token
2. Look up `RefreshToken` by `tokenHash` — `401` if not found
3. Check `expiresAt > now` — `401` if expired
4. Check `revokedAt IS NULL` — `401` if already revoked
5. Prisma transaction: set `revokedAt` on old token → create new `RefreshToken` → issue new access token
6. Return same shape as login

**Error responses**:
- `401 { code: 'REFRESH_TOKEN_INVALID' }` — covers all failure cases (no enumeration)

---

## T-021 · Logout — `POST /v1/auth/logout`

**Files**: `controllers/auth.controller.ts`, `services/auth.service.ts`

**Auth**: Requires valid access token (JWT middleware from T-022)

**Logic**:
1. Extract `jti` from verified token
2. `SET denylist:{jti} 1 EX {remainingTtl}` in Redis — blocks reuse until natural expiry
3. Set `revokedAt` on all active `RefreshToken` records for this `userId`
4. Return `204 No Content`

**Cookie variant**: Also clear the refresh token cookie with an expired `Set-Cookie` header.

---

## T-022 · JWT verification Fastify plugin

**File**: `apps/auth-service/src/plugins/jwt.plugin.ts`

**Story**: A `preHandler` hook that verifies the `Authorization: Bearer <token>` header and attaches the verified user to the request. Registered per-route, not globally — `/health`, `/v1/auth/register`, `/v1/auth/login`, `/v1/auth/refresh` remain public.

**Logic**:
1. Extract `Authorization` header — `401` if missing or malformed
2. Verify signature with `jose` `jwtVerify` using `JWT_SECRET` — `401` on failure
3. Check `denylist:{jti}` in Redis — `401 { code: 'TOKEN_REVOKED' }` if found
4. Attach to request: `req.user = { userId, tenantId, role }`

**Type augmentation**:
```ts
declare module "fastify" {
  interface FastifyRequest {
    user: { userId: UserId; tenantId: TenantId; role: Role };
  }
}
```

**Error responses**:
```ts
401 { code: 'TOKEN_MISSING' | 'TOKEN_INVALID' | 'TOKEN_EXPIRED' | 'TOKEN_REVOKED' }
```

---

## T-023 · Route registration

**File**: `apps/auth-service/src/routes/index.ts`

**Story**: Register all auth routes on the Fastify instance with the `/v1/auth` prefix. Apply JWT plugin only to protected routes.

```ts
app.register(async (router) => {
  router.post("/register", registerHandler);
  router.post("/login", loginHandler);
  router.post("/refresh", refreshHandler);
  router.post("/logout", { preHandler: [jwtPlugin] }, logoutHandler);
}, { prefix: "/v1/auth" });
```

---

## T-024 · Auth service integration tests

**File**: `apps/auth-service/tests/auth.integration.test.ts`

**Story**: Test the complete auth lifecycle against a real test database. Reset DB state between test suites.

**Test cases**:
- Register → `201` with `userId` and `tenantId`
- Register duplicate email → `409`
- Login with correct credentials → returns valid `accessToken`
- Login with wrong password → `401` (same timing as not-found)
- Refresh with valid token → new `accessToken` issued, old refresh token revoked
- Refresh with revoked token → `401`
- Logout → access token rejected on subsequent authenticated request
- JWT plugin rejects expired token → `401 TOKEN_EXPIRED`
- JWT plugin rejects denylisted JTI → `401 TOKEN_REVOKED`

**Setup**: Use Docker Compose test database. Truncate `User`, `Tenant`, `RefreshToken` tables in `beforeEach`.

---

## T-025A · Browser refresh-cookie + CSRF hardening

**Plan**: `docs/plans/t-025a-auth-cookie-refresh-flow.md`

**Story**: Harden browser session handling by moving refresh-token transport to HttpOnly cookie while preserving Bearer access-token verification.

**Scope highlights**:
- Login sets refresh token cookie with secure attributes.
- Refresh rotates token via cookie flow.
- Logout clears refresh cookie while retaining denylist + refresh-token revocation.
- Add CSRF protection checks for cookie-authenticated session mutation endpoints.

**Validation**:
- `pnpm --filter @telemetry/auth-service test`
- `pnpm --filter @telemetry/auth-service lint`
- `pnpm --filter @telemetry/auth-service typecheck`
