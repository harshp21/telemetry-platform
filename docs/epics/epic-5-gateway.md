# Epic 5 — Gateway

**Milestone**: v1-mvp
**Depends on**: Epic 3 (shared infra), Epic 4 (JWT plugin pattern)
**Blocks**: All client-facing traffic routing

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q7 — API versioning | Confirm `/v1/` prefix on all proxied routes |
| Q5 — Refresh token | Cookie forwarding config depends on this |

---

## T-025 · Gateway env schema

**File**: `apps/gateway/src/config/env.ts`

**Story**: Replace the current generic `EnvSchema` (which incorrectly includes `DATABASE_URL`) with a gateway-specific schema. Gateway has no database — remove that field.

```ts
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3100),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  JWT_SECRET: z.string().min(32),
  AUTH_SERVICE_URL: z.string().url(),
  USAGE_SERVICE_URL: z.string().url(),
  BILLING_SERVICE_URL: z.string().url(),
  ANALYTICS_SERVICE_URL: z.string().url(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  INGESTION_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
});
```

---

## T-026 · HTTP proxy routes

**File**: `apps/gateway/src/plugins/proxy.plugin.ts`

**Story**: Register `@fastify/http-proxy` for each upstream service. The gateway is the single entry point — internal service URLs are never exposed to clients.

**Route table**:
```
/v1/auth/*       → AUTH_SERVICE_URL
/v1/usage/*      → USAGE_SERVICE_URL
/v1/billing/*    → BILLING_SERVICE_URL
/v1/analytics/*  → ANALYTICS_SERVICE_URL
```

**Implementation notes**:
- Forward `X-Request-Id` header (generate if absent) for tracing correlation
- Strip any client-supplied `X-Tenant-Id` or `X-User-Id` headers — gateway injects verified versions only
- Do not forward `Authorization` header to internal services — use injected headers instead
- Set `replyOptions.rewriteRequestHeaders` to inject `X-Tenant-Id` and `X-User-Id` after JWT verification

---

## T-027 · JWT authentication hook

**File**: `apps/gateway/src/middleware/auth.middleware.ts`

**Story**: Verify the access token at the gateway before proxying. This is a signature-only check (no Redis denylist — that's auth-service's responsibility at logout). Injects verified tenant and user headers for upstream services.

**Logic**:
1. Skip auth for: `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/refresh`, `GET /health`
2. Extract `Authorization: Bearer <token>`
3. Verify signature using `jose` `jwtVerify` with `JWT_SECRET`
4. Inject into upstream request headers: `X-Tenant-Id: {tenantId}`, `X-User-Id: {userId}`, `X-User-Role: {role}`
5. Return `401` before proxying if verification fails

**Error responses**:
```ts
401 { code: 'TOKEN_MISSING' | 'TOKEN_INVALID' | 'TOKEN_EXPIRED' }
```

---

## T-028 · Rate limiting plugin

**File**: `apps/gateway/src/plugins/rate-limit.plugin.ts`

**Story**: Protect the platform from burst traffic. Two tiers: a tight limit on the ingestion path, a looser limit on everything else. Keyed by `X-Tenant-Id` (post-auth) so limits are per-tenant, not per-IP.

**Configuration**:
```ts
// General routes: RATE_LIMIT_MAX req per RATE_LIMIT_WINDOW_MS
// Ingestion path (/v1/usage/events): INGESTION_RATE_LIMIT_MAX per window
```

**Install**: `@fastify/rate-limit` with Redis store (`ioredis` client from container).

**Response on limit exceeded**:
```ts
429 {
  code: 'RATE_LIMIT_EXCEEDED',
  retryAfter: number,     // seconds
  limit: number,
  current: number
}
```
Include `Retry-After` header (seconds).

---

## T-029 · Request guard middleware

**File**: `apps/gateway/src/middleware/guards.middleware.ts`

**Story**: Defensive middleware applied globally before any routing. Prevents malformed or abusive requests from reaching upstream services.

**Guards**:
1. **Body size cap**: Reject requests with `Content-Length > 1_048_576` (1 MB) — `413 { code: 'PAYLOAD_TOO_LARGE' }`
2. **Content-Type enforcement**: POST/PUT/PATCH routes must have `Content-Type: application/json` — `415 { code: 'UNSUPPORTED_MEDIA_TYPE' }`
3. **Header stripping**: Remove `X-Tenant-Id`, `X-User-Id`, `X-User-Role` from incoming client requests before JWT hook runs
4. **Request ID injection**: If `X-Request-Id` is absent, generate `crypto.randomUUID()` and add it — ensures all downstream logs are correlated

**Acceptance**:
- Client cannot spoof `X-Tenant-Id` — gateway always overwrites it from the verified JWT
- Requests without `Content-Type: application/json` on write routes receive `415` before hitting any upstream
