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

## S-3 · `rls.integration.test.ts` encodes the S-2 bug as expected behaviour — **HIGH, open**

`apps/auth-service/tests/rls.integration.test.ts`. S-2 is fixed, so the
`if (isCurrentUserSuperuser) return;` guards at lines 78/96/109 no longer fire for any
service that runs as `telemetry_app` — but the file is now broken in two new ways, both
verified by running it against `telemetry_app`:

1. `beforeAll` seeds through the **same** client it asserts with, so
   `prisma.tenant.create()` (line 30) fails with
   `42501 new row violates row-level security policy for table "Tenant"` and all four tests
   are reported *skipped*. The suite is red and asserts nothing.
2. With the fixture seeded through an admin client instead (probed out of tree), the two
   real isolation assertions at lines 78 and 96 **pass** — RLS genuinely enforces — and the
   third, `without set_config, query sees all rows (no RLS enforcement)` (line 110,
   `expect(events.length).toBeGreaterThanOrEqual(1)`), **fails with `expected 0 to be
   greater than or equal to 1`**. That assertion asserts the vulnerability: under enforcing
   RLS an unscoped query must return **zero** rows.

Left unfixed deliberately: rewriting this file is S-3's own task, not S-2's.
`apps/usage-service/tests/rls.enforcement.integration.test.ts` is the automated proof that
RLS enforces in the meantime.

**Fix direction:** seed fixtures through `DIRECT_DATABASE_URL` (admin), assert through
`DATABASE_URL` (`telemetry_app`), delete the three `isCurrentUserSuperuser` guards, invert
the line-110 assertion to expect zero rows, and **fail** rather than skip if the asserting
role is not `NOSUPERUSER NOBYPASSRLS`.

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

## S-7 · auth-service still connects as the admin role — RLS inert for it — **HIGH, open**

Introduced by the S-2 fix, and scoped out of it deliberately.

Every service except auth-service now connects as `telemetry_app`
(`NOSUPERUSER NOBYPASSRLS`, owns nothing), so RLS enforces. auth-service still connects as
`postgres` in `apps/auth-service/.env.example`, `docker/docker-compose.yml`, and CI's
`AUTH_TEST_DATABASE_URL`, so for auth-service the DB layer is still inert and app-layer
predicates remain the only protection for `"User"` and `"Tenant"`.

Why it could not simply be flipped: `apps/auth-service/src/repositories/user.repository.ts`
does its work **before** a tenant is known, and the v1_0 policies have no way to allow that.
Verified against `telemetry_app`:

- `findUserForLogin` / the duplicate-email check select `"User"` by e-mail with no tenant
  context. `USING ("tenantId" = current_setting('app.tenant_id', true))` evaluates to NULL,
  so **login silently returns "no such user" for every account**.
- `createUserWithTenantIfEmailAvailable` INSERTs a `"Tenant"` before any tenant exists →
  `ERROR: new row violates row-level security policy for table "Tenant"` → **registration
  returns 500**. Reproduced: `AUTH_TEST_DATABASE_URL=<telemetry_app> vitest run
  tests/auth.integration.test.ts` → 9 failed | 6 passed.
- `findRefreshTokenForRotation` joins `"User"`, so refresh breaks the same way.
  (`"RefreshToken"` itself is unaffected: v1_2 `FORCE`s it but v1_0 never `ENABLE`d RLS on
  it, so it has no active policy.)

The fix is **not** a policy that lets any role read every user — that is S-2 by another
route.

**Fix direction:** move the three pre-tenant lookups behind `SECURITY DEFINER` functions
owned by the migration role, each returning only the columns auth needs
(`id`, `tenantId`, `passwordHash`, `role`) for exactly one e-mail or token hash; and wrap
registration in a transaction that generates the tenant id application-side and
`set_config('app.tenant_id', …, true)` before the INSERT. Then flip auth-service's
`DATABASE_URL` to `telemetry_app` and drop the overrides listed above.

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
