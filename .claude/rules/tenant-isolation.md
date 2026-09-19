# Rule — Tenant Isolation

Multi-tenant data separation is the platform's core security invariant. Four layers:

1. **Gateway** strips inbound `x-tenant-id` / `x-user-id` / `x-user-role` / `x-internal-secret`
   and re-injects them from verified JWT context and its own configuration
   (`apps/gateway/src/middleware/guards.middleware.ts`,
   `apps/gateway/src/plugins/proxy.plugin.ts`).
2. **`internal-auth.middleware`** — usage-service, billing-service, worker-service and
   analytics-service each reject any request that does not carry the shared
   `X-Internal-Secret`, before tenant context is derived. `/health` is exempt in all four — by
   allowlist in usage-service, structurally in the other three, whose guards are registered on
   encapsulated `app.register` scopes that `/health` is outside of. **All four guards are
   `onRequest` hooks, and all four compare with the shared `secretsMatch`**
   (`packages/shared-utils`): SHA-256 digests plus `crypto.timingSafeEqual`, never `===` or
   `!==`. Any non-string header value is rejected rather than normalized. Until S-8 closed,
   billing and worker used `!==` at `preHandler`, which both leaked comparison timing and let an
   unauthenticated caller's body be parsed before rejection.

   **analytics-service's guard protects zero routes today**, and that is a measured statement
   rather than a caveat: its scope holds no routes until T-051, and at fastify 5.10.0 a scope
   carrying hooks and no routes never runs them. So the count of four is a count of *guards
   written*, not of services behind one. See S-9.

   The *phase* is part of the contract, not a detail: at `preHandler` fastify has already run the
   content-type parser, so a caller holding no secret could distinguish body shapes from the
   error it got back. Measured against both services' real internal routes before the fix —
   malformed JSON answered `500 INTERNAL_ERROR` naming the body parser while a valid body
   answered `401`. A new guard goes at `onRequest`.

   The secret itself is declared once, as `internalApiSecretSchema` in
   `@telemetry/shared-validation`, and all five services that hold an `INTERNAL_API_SECRET`
   — gateway (the caller) plus those four — derive their env field from that object rather than
   restating the rule. Re-derived at S-9:
   `grep -rn "INTERNAL_API_SECRET:" apps/*/src/config/env.ts` returns five lines, every one of
   them `internalApiSecretSchema`. They restated it until S-8 and two had drifted, which split the platform's
   authentication on a whitespace-padded secret.
3. **`tenant-context.middleware`** validates `X-Tenant-Id` as a **UUID** and attaches tenant
   context per request. Any non-empty string is *not* good enough: `Tenant.id` is
   `String @default(uuid())`, and a tenant id containing `:` would make
   `DeduplicationService`'s `dedup:<tenantId>:<rawKey>` ambiguous.
4. **`TenantScopedRepository`** — `withTenant` opens a transaction and issues
   `set_config('app.tenant_id', …, true)` as its **first** statement; PostgreSQL RLS policies
   read it. In usage-service only, a second statement then pins
   `set_config('TimeZone','UTC',true)` (S-18). The tenant statement stays first because no
   statement against a tenant-scoped table may precede the RLS context, and a later addition
   inside `withTenant` must not displace it. That pin is a correctness layer, not an isolation
   one — see `CLAUDE.md` § *Raw SQL and timestamps*.

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

Two *kinds* of connection string, and they must not be conflated — a least-privilege runtime
role per service, and the owner connection used only by Prisma Migrate:

| Env var | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `telemetry_app` (least privilege) | usage, worker, billing, analytics at runtime (gateway holds no database client) |
| `DATABASE_URL` | `telemetry_auth_app` (least privilege, DML on three tables only) | auth-service at runtime — see below |
| `DIRECT_DATABASE_URL` | admin/owner | Prisma `directUrl` — `migrate deploy`/`status`, and integration fixtures that RLS would otherwise block |

Never point a running service at `DIRECT_DATABASE_URL`. Never run migrations as
`telemetry_app` — it deliberately cannot create roles or own tables.

`apps/usage-service/tests/rls.enforcement.integration.test.ts` is the standing proof: raw
`SELECT * FROM "UsageLine"` with no application predicate returns zero rows without tenant
context and only the scoped tenant's rows with it.

## auth-service's pre-tenant path

**auth-service is the one deliberate deviation from layer 4.** `UserRepository` does not
extend `TenantScopedRepository`: that contract binds `tenantId` as a *constructor* argument,
and auth-service is the one place where the tenant is *discovered* rather than supplied — the
repository is built before any tenant exists. It uses a local `withTenantContext(tenantId, fn)`
helper instead, issuing the same `set_config('app.tenant_id', …, true)` as the first statement
of the transaction. The invariant still holds: the tenant id comes from a `SECURITY DEFINER`
resolver keyed on a credential, from a tenant the repository just generated, or from the
gateway-verified JWT — never from a caller-supplied request field — and it is a branded
`TenantId`, so an arbitrary string does not type-check.

The two resolvers (`prisma/migrations/v1_5_auth_tenant_resolvers`) return the **tenant id
only** — never a password hash. Three properties make them safe, and all three are asserted by
the migration itself and by `apps/auth-service/tests/rls.integration.test.ts`:

1. **Owner:** `telemetry_auth_definer` — `NOLOGIN NOSUPERUSER NOBYPASSRLS`, holding `SELECT` on
   exactly two tables. `FORCE ROW LEVEL SECURITY` on `"User"` removes the *owner's* exemption,
   so a definer with no way past the policies returns `NULL` **silently** — which is the failure
   S-7 described, reproduced from inside its own fix. (S-7 is fixed and its id retired; the record
   is `docs/plans/s-007-auth-service-restricted-role.md`.) The way past is two targeted policies,
   `user_auth_definer_read` and `refreshtoken_auth_definer_read`, both `FOR SELECT` and both
   scoped `TO telemetry_auth_definer`.
2. **Not `BYPASSRLS`.** That is a *role attribute*: it applies to every table the role can ever
   reach, so its blast radius would be bounded only by the convention that nobody adds another
   `GRANT`. A policy is bounded by mechanism. It also keeps the migration appliable on managed
   PostgreSQL, where `CREATE ROLE … BYPASSRLS` is not available to the migration role.
3. **`EXECUTE` is granted to `telemetry_auth_app` alone**, and revoked from `PUBLIC` *and* from
   `telemetry_app`. `telemetry_app` is shared by the other five services; granting it there
   would hand gateway, usage, worker, billing and analytics an e-mail → tenant oracle that
   reads straight past the `"User"` policy. That is why auth-service has a role of its own.

Those policies are reachable through role **membership**, not through login, so what keeps them
unreachable from the two application roles is that neither is a member of the definer — and the
migration asserts that directly, with `pg_has_role`, for both roles. It has to be asserted
directly: for `telemetry_auth_app` the `EXECUTE` checks cannot notice, because that role holds
`EXECUTE` legitimately. A member of the definer reads **every** tenant's `"User"` rows with no
tenant context, since the policy is `USING (true)`. Never grant the definer to an application
role, and never weaken that guard.

`telemetry_auth_app` also holds **less** than `telemetry_app`, not the same: DML on `"Tenant"`,
`"User"` and `"RefreshToken"` only, with no `ALTER DEFAULT PRIVILEGES`, so a new table has to be
granted deliberately. A copy of `telemetry_app`'s blanket grant would have included
`"InvoiceLineItem"`, where RLS is inert — cross-tenant writes for a service that never touches it.

**Adding another `SECURITY DEFINER` function?** Read S-11 first. `PUBLIC` gets `EXECUTE` on every
new function; `v1_5` sets a **database-scoped** default privilege that removes it for functions
created by the migration role — note that the same statement written `IN SCHEMA "public"` does
nothing at all, which is the trap S-11 documents. Revoke explicitly anyway, grant to
`telemetry_auth_app` rather than `telemetry_app`, and extend the standing test in
`apps/auth-service/tests/rls.integration.test.ts`, which is what catches a missing revoke.

## Known gaps

Read `.claude/rules/known-gaps.md` (S-5, S-6, S-9, S-10, S-11) before relying on any of
these layers.
Note that **analytics-service's guard is wired around zero routes** (S-9, narrowed): it now
carries the strong form described above and an `INTERNAL_API_SECRET` derived from the shared
fragment, but the `app.register` scope holding both hooks has no route in it until T-051, and a
scope with no routes never runs its hooks. T-051 must register its route **inside** that
callback. The other three services carry the strong form and real routes behind it since S-8,
whose id is retired; the record is `docs/plans/s-008-timing-safe-internal-auth.md`.
Do not treat a passing RLS test as evidence unless it runs as a `NOSUPERUSER NOBYPASSRLS`
role — and unless its fixtures were seeded through a *different* connection, or the test is
asserting against data it could not have created.
