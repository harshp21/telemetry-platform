# Rule — Tenant Isolation

Multi-tenant data separation is the platform's core security invariant. Four layers:

1. **Gateway** strips inbound `x-tenant-id` / `x-user-id` / `x-user-role` / `x-internal-secret`
   and re-injects them from verified JWT context and its own configuration
   (`apps/gateway/src/middleware/guards.middleware.ts`,
   `apps/gateway/src/plugins/proxy.plugin.ts`).
2. **`internal-auth.middleware`** — usage-service rejects any request that does not carry the
   shared `X-Internal-Secret`, before tenant context is derived. `/health` is exempt. The
   comparison is timing-safe (SHA-256 digests + `crypto.timingSafeEqual`), never `===`.
3. **`tenant-context.middleware`** validates `X-Tenant-Id` as a **UUID** and attaches tenant
   context per request. Any non-empty string is *not* good enough: `Tenant.id` is
   `String @default(uuid())`, and a tenant id containing `:` would make
   `DeduplicationService`'s `dedup:<tenantId>:<rawKey>` ambiguous.
4. **`TenantScopedRepository`** — `withTenant` opens a transaction and issues
   `set_config('app.tenant_id', …, true)`; PostgreSQL RLS policies read it.

## Required
- Every tenant-scoped query carries an explicit `tenantId` predicate **and** runs inside
  `withTenant`. Belt and braces — neither alone.
- The tenant id derives from the repository's own bound context (`this.where({})`), never from
  a caller-supplied field. Query-input types must not even have a `tenantId` field.
- Tenant-scoped repositories are registered in the DI container as **factories**
  (`(tenantId) => Repo`), never singletons — a singleton pins one tenant process-wide.
- **A service owns its own Redis keyspace.** The service that writes a key builds it, from a
  tenant id plus raw components — callers pass components, never a pre-built key. See
  `DeduplicationService.buildKey`: `<KEY_PREFIX><tenantId>:<rawKey>`. This makes an
  untenanted key unrepresentable rather than merely absent at the current call site.

## Forbidden
- A query on a tenant-scoped table with no tenant filter.
- Bypassing the middleware, or trusting a client-supplied tenant id.
- Registering the tenant-context hook before the internal-auth hook. Fastify runs `onRequest`
  hooks in registration order, and that order is the security contract: a caller that has not
  proved it is an internal service must not cause tenant context to be derived at all.
- Accepting a tenant id that is not a UUID.
- A Redis key built from a caller-supplied value without the writing service's own prefix
  **and** tenant segment — that is cross-tenant suppression, not just untidy naming.
- Treating a passing RLS test as proof while connected as a superuser.

## The database layer

Services connect as `telemetry_app` — `NOSUPERUSER`, `NOBYPASSRLS`, and the owner of no
table — created by `prisma/migrations/v1_4_app_role_non_superuser`. That, not
`FORCE ROW LEVEL SECURITY`, is what makes the policies enforce: `FORCE` only removes the
*table owner's* exemption and does nothing to a superuser or a `BYPASSRLS` role.

Two connection strings, and they must not be conflated:

| Env var | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `telemetry_app` (least privilege) | every service at runtime |
| `DIRECT_DATABASE_URL` | admin/owner | Prisma `directUrl` — `migrate deploy`/`status`, and integration fixtures that RLS would otherwise block |

Never point a running service at `DIRECT_DATABASE_URL`. Never run migrations as
`telemetry_app` — it deliberately cannot create roles or own tables.

`apps/usage-service/tests/rls.enforcement.integration.test.ts` is the standing proof: raw
`SELECT * FROM "UsageLine"` with no application predicate returns zero rows without tenant
context and only the scoped tenant's rows with it.

## Known gaps

**auth-service is the exception** — it still connects as the admin role, so RLS is inert for
it (S-7). Its pre-authentication queries have no tenant to scope to.

Read `.claude/rules/known-gaps.md` (S-3, S-7, S-8, S-9) before relying on any of these layers.
Note that only usage-service currently has the layer-2 guard in the strong form described above
(S-8, S-9).
Do not treat a passing RLS test as evidence unless it runs as a `NOSUPERUSER NOBYPASSRLS`
role — and unless its fixtures were seeded through a *different* connection, or the test is
asserting against data it could not have created.
