# Rule — Tenant Isolation

Multi-tenant data separation is the platform's core security invariant. Three layers:

1. **Gateway** strips inbound `x-tenant-id` / `x-user-id` / `x-user-role` and re-injects them
   from verified JWT context (`apps/gateway/src/middleware/guards.middleware.ts`).
2. **`tenant-context.middleware`** attaches tenant context per request.
3. **`TenantScopedRepository`** — `withTenant` opens a transaction and issues
   `set_config('app.tenant_id', …, true)`; PostgreSQL RLS policies read it.

## Required
- Every tenant-scoped query carries an explicit `tenantId` predicate **and** runs inside
  `withTenant`. Belt and braces — neither alone.
- The tenant id derives from the repository's own bound context (`this.where({})`), never from
  a caller-supplied field. Query-input types must not even have a `tenantId` field.
- Tenant-scoped repositories are registered in the DI container as **factories**
  (`(tenantId) => Repo`), never singletons — a singleton pins one tenant process-wide.

## Forbidden
- A query on a tenant-scoped table with no tenant filter.
- Bypassing the middleware, or trusting a client-supplied tenant id.
- Treating a passing RLS test as proof while connected as a superuser.

## Known gaps

RLS is **not currently enforcing** (the app connects as a superuser with `rolbypassrls`), the
tests that would catch this disable themselves, and usage-service has no service-to-service
auth. Client-supplied dedup keys are untenanted and allow cross-tenant event suppression.

Read `.claude/rules/known-gaps.md` (S-1 through S-4) before relying on any of these layers.
Do not treat a passing RLS test as evidence unless it runs as a `NOSUPERUSER NOBYPASSRLS`
role.
