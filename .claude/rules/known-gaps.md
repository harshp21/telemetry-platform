# Rule — Known Security & Correctness Gaps

Open issues found during review that are **not yet fixed**. Check this list before working in
the affected area: do not reintroduce these patterns, do not assume the protection they
describe is active, and do not treat a passing test in these areas as evidence without
reading why it passes.

Update this file when an item is fixed (remove it) or when a new gap is accepted rather than
fixed (add it, with the reasoning).

**Ids are stable and are never renumbered or reused.** They are cited from reviews, commit
messages, and `.claude/agents/senior-reviewer.md`, so a gap that is fixed leaves a gap in the
numbering. A missing id means "fixed", not "never existed" — the plan and review under
`docs/plans/` and `docs/reviews/` are the record.

---

## S-5 · Clock-skew window is symmetric — backfill impossible — **MEDIUM, open**

`events.validator.ts:9` sets `CLOCK_SKEW_TOLERANCE_SECONDS: 5 * 60`, and the controller
applies it with `Math.abs`, so events more than 5 minutes **old** are rejected with
`FUTURE_CLOCK_SKEW`. Historical import or replay is impossible by construction, and the error
code misdescribes the past-timestamp case.

Note `docs/epics/epic-6-usage-service.md` describes this as "more than 24h in the future →
`400 VALIDATION_ERROR`", which matches neither the window nor the code. The only 24h constant
in the service is the dedup TTL.

---

## S-6 · `INGEST_BATCH_MAX` is dead config — **LOW, open**

`apps/usage-service/src/config/env.ts:14` defines and validates `INGEST_BATCH_MAX`; no
production code reads it. The enforced cap is a hard-coded `BATCH_SIZE_MAX: 100` in
`events.validator.ts:6`. Operators setting the env var get no effect and no warning.

---

## S-8 · billing / worker internal-auth guards are weaker than usage-service's — **MEDIUM, open**

Found while fixing S-4, and deliberately not folded into it: changing two other services'
startup contracts inside a usage-service security fix breaks the one-task-per-commit rule.

`apps/billing-service/src/middleware/internal-auth.middleware.ts:9` and
`apps/worker-service/src/middleware/internal-auth.middleware.ts:9` are the same file, and both
differ from `apps/usage-service/src/middleware/internal-auth.middleware.ts` in three ways:

1. **`!==`, not a timing-safe comparison.** String comparison short-circuits at the first
   differing byte, so response latency leaks how many leading bytes a guess got right. See the
   `secretsMatch` helper in usage-service for the SHA-256 + `timingSafeEqual` form.
2. **The secret bypasses the env schema.** `apps/billing-service/src/app.ts:23` and
   `apps/worker-service/src/app.ts:23` read `process.env.INTERNAL_API_SECRET ?? ""` directly, so
   `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` is not enforced and a 1-character secret starts
   cleanly. The `.trim()` check they do run happens *after* the DI container is built.
3. **`preHandler`, not `onRequest`, and `reply.send(...)` is not returned.** An unauthenticated
   caller still gets its body parsed and validated before rejection, and the un-`return`ed
   `reply.status(401).send(...)` inside an async hook relies on Fastify's `reply.sent` check
   rather than stating the short-circuit.

**Fix direction:** move `INTERNAL_API_SECRET` into both services' `EnvSchema` with
`.min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)`, promote the guard to `onRequest`, and share
one timing-safe comparison helper rather than keeping three copies of the middleware.

---

## S-9 · analytics-service has no service-to-service auth and no `INTERNAL_API_SECRET` — **LOW, open**

`apps/analytics-service/src/app.ts` registers `/health` and nothing else, and
`apps/analytics-service/src/config/env.ts` has no `INTERNAL_API_SECRET`. There is no tenant data
to reach today, so this is LOW rather than a live hole — but the gateway already proxies
`/v1/analytics` to it (`apps/gateway/src/constants.ts`, `GATEWAY_PROXY_PREFIXES.ANALYTICS`) and
now sends `X-Internal-Secret` on every proxied request. The moment a tenant-scoped route lands
there, it is S-4 again with a different service name.

**Fix direction:** add the guard *before* the first tenant-scoped route, not after — mirror
`apps/usage-service/src/middleware/internal-auth.middleware.ts` and its env-schema entry.

---

## S-10 · `"RefreshToken"` has RLS `FORCE`d but never `ENABLE`d — policies are inert — **MEDIUM, open**

Found while landing S-7, and deliberately not folded into it: that change already flips the
connection role for login and registration, which is the highest-blast-radius path in the
platform.

`prisma/migrations/v1_0_initial_tenant_usage_rls/migration.sql` omits `"RefreshToken"` from its
`ENABLE ROW LEVEL SECURITY` block and writes no policy for it; `v1_2` then `FORCE`s it, which
is a no-op without `ENABLE`. Live `pg_class`: `relrowsecurity = false`,
`relforcerowsecurity = true`, and the only policy is `refreshtoken_auth_definer_read`, which is
scoped to a `NOLOGIN` role and inert while RLS is disabled. Any holder of the `telemetry_app`
or `telemetry_auth_app` credential can therefore read, insert and revoke refresh tokens for
**every** tenant.

`"InvoiceLineItem"` has the same shape. It has no `tenantId` column of its own either; a policy
for it would have to join `"Invoice"`.

Consequence for anyone reading auth-service's tests: the `withTenantContext` wrapper around
every `"RefreshToken"` query cannot currently fail — a version that never set the context would
behave identically. So the application-layer predicate is doing all the work, and
`rotateRefreshToken` / `revokeActiveRefreshTokens` carry one explicitly, through Prisma's
`user: { tenantId }` relation filter (it compiles to a real
`EXISTS (SELECT … FROM "User" WHERE "tenantId" = $n …)`). `storeRefreshToken` is the exception
and cannot be fixed the same way: an INSERT has no `where`. Do not remove those relation
filters on the grounds that the tenant context is set — until this gap closes, they are the
only tenant control those writes have.

For the same reason the logout test asserts revocation by reading the rows back through an
**admin** client rather than trusting the `204`. Keep that shape; without it the assertion is
tautological.

**Fix direction:** add a `tenantId` column to `"RefreshToken"` with a backfill (the better
long-term shape, and it also removes the need for
`auth_resolve_tenant_by_refresh_token_hash`), or write a policy joining `"User"`. Then
`ENABLE ROW LEVEL SECURITY` on both tables. Note that `v1_5` already creates
`refreshtoken_auth_definer_read`, the `FOR SELECT` policy the resolver's owner needs, so
enabling RLS will not break refresh rotation. Every `"RefreshToken"` query is already inside
tenant context, so this is a migration rather than a code change.

---

## S-11 · A `SECURITY DEFINER` function created by a role other than the migration role is `PUBLIC`-executable — **LOW, open**

PostgreSQL grants `EXECUTE` on every new function to `PUBLIC`, and every application role is in
`PUBLIC`. `prisma/migrations/v1_5_auth_tenant_resolvers` closes that with a **database-scoped**
default privilege — `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` — so a
function created by the migration role now comes out `{owner=X/owner}` with neither `PUBLIC` nor
`telemetry_app` able to execute it. Verified on PG 16.13.

**The residual, under-restriction:** `ALTER DEFAULT PRIVILEGES` is recorded *per creating role*. A
function created by any other role — a DBA at a psql prompt, a different migration identity — still
comes out `proacl = NULL` with `PUBLIC` holding `EXECUTE`. That is the open part.

**The residual, over-restriction:** the entry is database-scoped (`defaclnamespace = 0`), so it also
covers every function the migration role creates *anywhere* in the database, including plain
functions and other schemas. `CREATE EXTENSION pgcrypto` as that role yields `crypt`, `armor`,
`dearmor` as `{owner=X/owner}`, which `telemetry_app` cannot execute — so the five services sharing
that role fail with `42501 permission denied for function` until someone grants `EXECUTE`
explicitly. Fails closed, but silently until a query runs. Both directions come from the same
statement, which is why they share an id; see the release note for the operator-facing version.

**The trap, which cost a review round:** adding `IN SCHEMA "public"` makes the statement do
**nothing at all**. A schema-scoped `pg_default_acl` row is *merged with* `acldefault()`, which
contains `=X` for `PUBLIC`, so a schema-scoped revoke can never subtract it — no row is even
created, and a function made afterwards is still world-executable. Only the database-scoped form
replaces the default. Do not "tidy" the statement by scoping it.

**What catches the residual:**
- `migration.sql` section 7 loops every `prosecdef` function in `public` and raises if `PUBLIC` or
  `telemetry_app` can execute it — at apply time.
- `apps/auth-service/tests/rls.integration.test.ts` asserts the same invariant, and the exact set
  of definer functions, on every `pnpm test`.

**When adding one:** `REVOKE ALL ON FUNCTION … FROM PUBLIC` explicitly anyway, grant `EXECUTE` to
`telemetry_auth_app` rather than `telemetry_app`, and extend the standing test's expected list.

---

## S-12 · `pnpm format:check` cannot pass — **LOW, open**

`.prettierrc` sets `tabWidth: 2` with no `useTabs`, against a tab-indented codebase, so
`pnpm format:check` reports style issues in ~250 files — including files untouched for months.
`CLAUDE.md`'s command list therefore advertises a gate that no revision of this repository has
ever satisfied.

There is no format step in `.github/workflows/ci.yml`, so nothing is actually blocked. Left open
rather than fixed because `prettier --write` across 250 files would bury every real diff it
touched.

**Fix direction:** either set `"useTabs": true` in `.prettierrc` and reformat in one commit that
does nothing else, or drop the `format:check` script and its mention in `CLAUDE.md`. Do not
reformat as a side effect of a feature change.

---

## S-13 · `prisma/seed.ts` targets a compound unique the schema does not define — **LOW, open**

`prisma/seed.ts:36` upserts `"User"` by `where: { tenantId_email: { tenantId, email } }`. No such
compound unique exists: `v1_1_user_email_global_unique` made `email` globally unique, and
`prisma/schema.prisma` declares `@@unique` only on `Meter`, `Invoice` and `MetricRollup`. The seed
script therefore cannot run.

Found during the S-7 review rounds and left out of that change deliberately — a seed fix has
nothing to do with the connection role, and `pnpm test` does not run the seed, so nothing is
currently red because of it.

**Fix direction:** change the upsert to `where: { email }`, matching the unique that actually
exists. Check the rest of the file against the current schema at the same time; it has not been
run since `v1_1`.
