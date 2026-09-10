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

`apps/usage-service/src/config/env.ts:19` defines and validates `INGEST_BATCH_MAX`; no
production code reads it. The enforced cap is a hard-coded `BATCH_SIZE_MAX: 100` in
`events.validator.ts:6`. Operators setting the env var get no effect and no warning.

---

## S-8 · billing / worker internal-auth guards are weaker than usage-service's — **MEDIUM, open**

Found while fixing S-4, and deliberately not folded into it: changing two other services'
startup contracts inside a usage-service security fix breaks the one-task-per-commit rule.

`apps/billing-service/src/middleware/internal-auth.middleware.ts:9` and
`apps/worker-service/src/middleware/internal-auth.middleware.ts:9` are the same file, and both
differ from `apps/usage-service/src/middleware/internal-auth.middleware.ts` in three ways
(item 2 now applies to **billing-service only** — worker's env schema enforces the minimum at
module load, so worker differs in two):

1. **`!==`, not a timing-safe comparison.** String comparison short-circuits at the first
   differing byte, so response latency leaks how many leading bytes a guess got right. See the
   `secretsMatch` helper in usage-service for the SHA-256 + `timingSafeEqual` form.
2. **The secret bypasses the env schema — billing-service only.**
   `apps/billing-service/src/app.ts:23` reads `process.env.INTERNAL_API_SECRET ?? ""` directly, so
   `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` is not enforced and a 1-character secret starts
   cleanly. The `.trim()` check it does run happens *after* the DI container is built.
   worker-service no longer has this: T-037 declared `INTERNAL_API_SECRET` in its `EnvSchema`
   with `.trim().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)`, parsed at module load, and
   `apps/worker-service/src/app.ts:27` reads the parsed value.
3. **`preHandler`, not `onRequest`, and `reply.send(...)` is not returned.** (worker's
   registration is now at `apps/worker-service/src/app.ts:59`.) An unauthenticated
   caller still gets its body parsed and validated before rejection, and the un-`return`ed
   `reply.status(401).send(...)` inside an async hook relies on Fastify's `reply.sent` check
   rather than stating the short-circuit.

**Fix direction:** move `INTERNAL_API_SECRET` into billing-service's `EnvSchema` with
`.trim().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)` — the `.trim()` matters and is not
decoration: `.min()` alone accepts an all-whitespace secret of the right length, which is the
hole T-037 closed in worker-service. Note usage-service still carries the untrimmed
`.min()` form and should be aligned in the same change, so all three end up identical.

Then promote the guard to `onRequest` in both, share one timing-safe comparison helper rather
than keeping three copies of the middleware, and adopt each service's
`HTTP_STATUS_UNAUTHORIZED` constant instead of the literal `401` at
`internal-auth.middleware.ts:10` — worker-service defines the constant but its middleware still
writes the literal.

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

---

## S-14 · `.claude/agents/` and `.github/agents/` are two divergent copies of one pipeline — **LOW, open**

The same five agents are defined twice: `.claude/agents/*.md` for Claude Code and
`.github/agents/*.agent.md` for Copilot, plus `.github/instructions/` carries an 88-line
`copilot-instructions.md`, a 263-line `enterprise-delivery-flow.instructions.md` and
`agent-stage-tracking.instructions.md` with no Claude counterpart.

They have already drifted, structurally rather than just in wording. `epic-router` existed
**only** on the Copilot side until this change ported it — which is why `CLAUDE.md` described an
eight-stage pipeline whose first stage had no agent. The dangling `known-gaps.md` S-2 citation in
`senior-reviewer.md` survived for the same reason: a fix applied to one copy does not reach the
other. `enterprise-delivery` differs substantially in length and content between the two, and the
`.github/instructions/` files have no Claude counterpart at all.

Left open rather than fixed: unifying two agent sets consumed by two different tools is its own
task, and the Copilot side cannot be exercised from here to confirm a rewrite is faithful.

**Fix direction:** make `.claude/agents/` authoritative and generate or thin the `.github/` set
from it, or drop the Copilot set if nobody drives this repo through Copilot. Until then, a change
to any agent definition should be applied to both copies in the same commit, and the reviewer
should check that it was.

---

## S-15 · The epic files are not a reliable task manifest — **LOW, open**

Found by the first real run of `.claude/agents/epic-router.md`, which has to derive task state
because no status field exists. Five distinct hygiene defects, each verified:

- **An id is declared twice for two different tasks.** `T-070` is
  "Service coverage thresholds and CI gate" in `docs/epics/epic-12-testing.md` and
  "Tenant isolation type-level enforcement" in `docs/epics/epic-13-security.md`. The epic-12
  sense is committed (`f8a3246`); the epic-13 sense is unimplemented — its deliverable
  `scripts/check-tenant-isolation.sh` does not exist and no CI step runs it. `/ship T-070` is
  therefore ambiguous.
- **An id is committed but never declared.** `T-074` (`dba4899`, startup env-file resilience)
  runs past the declared maximum; no epic knows it exists.
- **Sub-task ids invented during delivery and never folded back.** `T-024C`, `T-024D`, `T-067A`,
  `T-067B`, `T-067C` have plans and commits but no epic declaration.
- **An id reused by an unrelated artifact.** `docs/plans/t-068-auth-access-ttl-guardrail.md` is
  about the auth access-token TTL guardrail, not epic-12's T-068 (compose smoke tests) — so
  filename-prefix matching reports T-068 planned on the strength of a different task's plan.
- **A decision gate reads unresolved but was settled in practice.** `docs/epics/README.md` lists
  Q5 (refresh token delivery) with no "decided" marker, while `640e53d` and `bdb6bcf` shipped a
  hybrid cookie + CSRF model. Read literally, the router must refuse all of Epic 4 over a gate
  the repo answered long ago.

Suffixed ids are a related trap for tooling rather than a doc defect: `T-024B` and `T-025A`
exist, so any id matcher must be `T-[0-9]+[A-Z]?`. The bare pattern truncates `T-025A` to
`T-025` and reports `T-025` — which is **not** committed — as done.

Left open rather than fixed: reconciling the backlog is a docs task with its own review, and
guessing which `T-070` was meant, or marking Q5 decided on the router's inference, would be
exactly the kind of silent resolution the router is built to refuse.

**Fix direction:** renumber the epic-13 `T-070`, declare `T-074` and the sub-task ids, rename the
`t-068-*` plan, and mark Q5 decided with its resolution — then keep `docs/epics/README.md` the
single authority it claims to be. Until then, treat router output as evidence-with-ambiguities,
not as a manifest.

---

## S-16 · The specified 10 KB per-event payload cap is enforced nowhere — **MEDIUM, open**

`docs/epics/epic-6-usage-service.md:62` requires that "serialized `metadata` + envelope for each
event must stay within 10 KB — `400` if exceeded". usage-service implements no such check.

Observed:

- `grep -rn "bodyLimit\|10240\|10 \* 1024" apps/usage-service/src` → no match.
- The cap exists, in a package usage-service does not import: `MAX_EVENT_SIZE_BYTES = 10 * 1024`
  at `packages/shared-validation/src/index.ts:7`, applied by `UsageEventsBatchSchema` (`:115`)
  in a `superRefine` (`:120`) whose per-event size check is at `:125`.
  `grep -rn "UsageEventsBatchSchema\|MAX_EVENT_SIZE" apps/usage-service/src` → no match; the
  service validates with its own `ingestRequestSchema`
  (`src/validators/events.validator.ts:43`), which has no size rule.
- `apps/usage-service/src/app.ts:19` is `Fastify({ logger: true })` — no options — so the only
  ceiling is Fastify's default `bodyLimit`. At the installed fastify@5.10.0 that default is
  **1 048 576 bytes**, stated three times in
  `node_modules/.pnpm/fastify@5.10.0/node_modules/fastify/lib/config-validator.js`
  (`{"bodyLimit":{"type":"integer","default":1048576}}` at :6, `data.bodyLimit = 1048576` at :31,
  and `defaultInitOptions` at :1265).

So the endpoint is **not** unbounded — it is bounded at 1 MiB *per request*, against an intended
10 KB *per event*, and a 100-event batch may carry ~10 KB each within that 1 MiB. The gap is the
missing per-event rule and the absent `400`, not an absent limit. State it that way; the
overclaim ("unbounded") is itself a finding.

Unlike S-5 and S-6 this is a *missing* guard rather than a mislabelled one, so a test written
from the epic's wording **fails** rather than passing vacuously. T-036 therefore does not cover
it: adding the check would be new production behaviour inside a test task.

**Fix direction:** enforce per-event size in `ingestRequestSchema`, return the documented `400`,
and set an explicit `bodyLimit` on the Fastify instance so the request-level ceiling is a
decision rather than a default. Reuse the existing number rather than adding a copy — but note
it is **not** importable today: `MAX_EVENT_SIZE_BYTES` is a module-private `const` at
`packages/shared-validation/src/index.ts:7` with no `export` keyword (`grep -n "export.*MAX_EVENT_SIZE_BYTES"`
→ no match), so the first step is exporting it from `@telemetry/shared-validation`.

---

## S-17 · Three more epic-vs-code divergences in the ingestion contract — **LOW, open**

Found while writing T-036's integration suite. Each is a documentation/contract mismatch rather
than a live hole, and the suite asserts the shipped behaviour in every case.

**`quantity` is far narrower than both the epic and the column.**
`docs/epics/epic-6-usage-service.md:51` promises "positive, up to 6 decimal places".
`apps/usage-service/src/validators/events.validator.ts:29` is
`z.number().int().min(INGESTION_CONSTANTS.QUANTITY_MIN).max(INGESTION_CONSTANTS.QUANTITY_MAX)`
with `QUANTITY_MIN: 1, QUANTITY_MAX: 100` (`:7-8`) — integers only, and capped at 100 — while
`Event.quantity` and `UsageLine.quantity` are `Decimal(18,6)` (`prisma/schema.prisma:71` and
`:89`).
`quantity: 0.5` and `quantity: 101` are both rejected today. This is why T-036 seeds fractional
quantities through the owner connection: the HTTP path cannot express the values the
`Decimal(18,6)` precision cases need.

**Ingest error bodies omit the fields the epic documents.**
`docs/epics/epic-6-usage-service.md:73` specifies
`400 { code: 'VALIDATION_ERROR', issues: [...] }` and `:74`
`400 { code: 'BATCH_TOO_LARGE', max: number }`.
`apps/usage-service/src/controllers/events.controller.ts:54-57` and `:76-79` send
`{ code, message }` with `message` a joined string — no `max`, no `issues`.
`registerGlobalErrorHandler` *does* emit `issues`
(`packages/shared-utils/src/index.ts:120-128`), but the controller `safeParse`s and never throws
the `ZodError`, so that path is unreachable from here.

**`generateIdempotencyKey` is specified and dead.**
`docs/epics/epic-6-usage-service.md:67` names
`generateIdempotencyKey(tenantId, eventType, occurredAt)`. It exists — a SHA-256 helper at
`packages/shared-utils/src/index.ts:13-21` — and `grep -rn "generateIdempotencyKey" apps packages
--include=*.ts` returns eight lines: the declaration, two stale `packages/shared-utils/dist/**/*.d.ts`
declarations, one import and four call sites, the import and all four call sites inside
`packages/shared-utils/tests/unit.test.ts`.
No production caller anywhere. (Aside, not part of this gap: the two `dist` declarations
disagree with each other and with the source — `dist/src/index.d.ts:3` declares a fourth
`source: string` parameter that `src/index.ts` does not have.)
`apps/usage-service/src/services/ingestion.service.ts:114-116` derives a plaintext
`<eventType>:<sourceId ?? "unknown">:<occurredAt>` instead. Note the derived key omits the tenant
**deliberately** — `DeduplicationService` owns that segment since S-1 — so a fix must not
reintroduce the tenant here.

**Fix direction:** decide contract-first in each case (widen the validator to match the column,
or narrow the epic; add `max`/`issues` to the ingest error bodies, or correct the epic; adopt the
helper, or delete it). Do not "fix" any of them by editing a test — T-036 pins current behaviour
on purpose, with inline comments naming this gap.

---

## S-19 · `TenantScopedRepository` is five copies, and S-18's fix reached only one — **MEDIUM, open**

`apps/{analytics,auth,billing,usage,worker}-service/src/repositories/base.repository.ts` are five
separate files implementing the same class. Recommended independently by the S-18 reviewer, and
filed here rather than folded into S-18 because changing four other services' transaction
behaviour inside a usage-service correctness fix breaks the one-task-per-commit rule.

Observed with `md5sum` and `diff`:

- `analytics`, `billing` and `worker` are **byte-identical** (`13a533a2e2c2dcc1ff9db28fb5c7a1fd`,
  111 lines each).
- `auth` differs from those three in comments only — `diff` filtered to non-comment lines is
  empty. It is 118 lines because of a doc paragraph about `UserRepository` not extending the
  class.
- `usage` is the outlier at 124 lines: S-18 added
  `set_config('TimeZone', 'UTC', true)` to its `withTenant`, and moved its two setting names
  onto `DATABASE_SESSION_SETTINGS` constants. `grep -c TIME_ZONE` → `1` for usage-service, `0`
  for the other four, which still inline `'app.tenant_id'` as a literal.

Consequence: the other four services' `withTenant` opens a transaction whose session zone is
whatever the server defaults to. Their columns are the same `timestamp(3) without time zone`, so
the first raw timestamp predicate written in any of them inherits S-18 exactly.

**How bad it is today, stated no stronger than measured:** latent, not live.
`grep -rn "extends TenantScopedRepository" apps/*/src` finds exactly one real subclass in the
whole repository — `UsageRepository` (`apps/usage-service/src/repositories/usage.repository.ts:150`).
The other four base classes have no subclass at all; the only other matches are the `EventRepository`
example inside each file's own docstring. So no query is wrong right now. What is wrong is that
the fix is in the copy that happened to have the bug, and four copies will silently disagree
with it.

One thing the obvious fix would still not reach, recommended by the S-18 reviewer and recorded
here so it is not lost: auth-service's two pre-authentication resolver calls
(`apps/auth-service/src/repositories/user.repository.ts:246-251` and `:258-266`) issue
`this.db.$queryRaw` **outside** `withTenantContext` and outside any transaction — verified by
reading both method bodies; the only `set_config` in that file is at `:235`, inside
`withTenantContext`. A transaction-local `set_config('TimeZone', 'UTC', true)` rolled into all
five `withTenant` implementations would therefore not cover them. They take no timestamp
argument today, so nothing is wrong now; the point is that "roll the pin to all five" is not by
itself a complete answer for auth-service.

**The setting name itself is duplicated the same way.** `grep -rn "app\.tenant_id" apps --include=*.ts`
(excluding `dist/`, comments and test titles) shows `"app.tenant_id"` written as an executable
string in **six** places: two named constants —
`apps/usage-service/src/constants.ts:74` (`DATABASE_SESSION_SETTINGS.TENANT_ID`) and
`apps/auth-service/src/constants.ts:69` (`AUTH_DATABASE.TENANT_CONTEXT_SETTING`) — and four
hard-coded literals inside `set_config`, at `analytics`/`billing`/`worker`
`base.repository.ts:98` and `auth` `base.repository.ts:105`. No test passes the bare literal to
`set_config`/`current_setting` — every test that names the setting to the database imports one
of the two constants (checked: the remaining test-file occurrences are comments, `it(...)`
titles, and one assertion-failure message at
`apps/auth-service/tests/user.repository.unit.test.ts:116`).
`.claude/rules/constants.md` asks for promotion before the third copy,
and this is the sixth; the shared-package fix below should carry the constant with it.

Same drift class as S-14 (`.claude/agents/` vs `.github/agents/`): duplication that was harmless
while the copies matched, and became a correctness question the moment one changed.

**Fix direction:** promote one implementation to a shared package — a `@telemetry/shared-db`
alongside the existing seven shared packages — and delete the five copies. `TenantId` already
comes from `@telemetry/shared-types`, so the dependency direction is established. Do it as its
own task across all five services, not opportunistically inside the next repository change,
because it touches every service's data path at once.

---

## S-20 · auth-service's integration fixtures leak permanently, and the reset cannot see it — **MEDIUM, open**

`apps/auth-service/tests/auth.integration.test.ts` cleans up in `beforeEach` only:

- `beforeEach` → `resetAuthState()` (`:188-190`).
- `afterAll` (`:192-208`) closes the app and disconnects Prisma, the admin client and the global
  Redis handle. **No data cleanup.** So whatever the final test created stays.
- `resetAuthState` (`:123-134`) finds its rows by `email: { endsWith: SUITE_EMAIL_DOMAIN }`, and
  `SUITE_EMAIL_DOMAIN` is `@auth-integration-${randomUUID()}.test` (`:27-28`) — regenerated
  every run. A run's filter therefore **cannot** match a previous run's rows, by construction.

Both halves are needed for the leak: `beforeEach`-only cleanup leaves the last test's rows, and a
run-unique filter means no later run ever collects them. Residue is permanent and monotonic.

**Observed, not inferred.** The development database currently holds exactly two `Tenant` and two
`User` rows and no `RefreshToken`. Both users' emails carry `@auth-integration-<uuid>.test`
domains, and the two uuids **differ** — `…-2b860f1d-…` and `…-a90cd587-…`. That is two prior runs
each leaving one orphan behind, which is the mechanism above, measured rather than reasoned about.

A fully-passing run happens to leak nothing only by accident of ordering: the file's last test is
`"rejects missing required field with 400"` (`:748`), a negative case that registers no user.
Append one positive test after it, shard the file, or run a subset with `-t`, and every run leaks.

**Fix direction:** call `resetAuthState()` from `afterAll` as well as `beforeEach`, and widen the
filter to a **stable** prefix so an earlier run's residue is collectable.

That second half is a trade-off, not a straight win, and needs deciding rather than reverting:
the run-unique domain exists so that parallel vitest workers cannot delete each other's rows —
`apps/auth-service/tests/rls.integration.test.ts` seeds its own users and tenants and deletes them
by explicit id (`:179-183`), and a broad `endsWith` filter in the other file could race it. A
stable prefix plus a per-run *infix* (e.g. `@auth-integration.test` matched for collection,
`<runId>.auth-integration.test` written per run) keeps both properties. Decide it explicitly.

---

## S-21 · The S-18 regression suite does not isolate the fix it was written for — **LOW, open**

`apps/usage-service/tests/usage.timezone.integration.test.ts` was added by S-18 to prove the
usage-summary range filter resolves in UTC on any server. Its docstring at `:31-32` says it
"fails on the unfixed code on **any** server". It does not.

S-18 shipped **two independent guards** — the `utcTimestampBound` normalization-plus-cast in
`usage.repository.ts`, and the transaction-local `set_config('TimeZone','UTC',true)` in
usage-service's `withTenant` — and either alone is sufficient. Verified independently three
times (T-036 Gate 3, and both T-036 review rounds): reverting `utcTimestampBound` to a bound
JS `Date`, which is the exact S-18 defect, leaves that suite **17/17 green**. Only removing
both guards fails, and then the failure is `B8 … Asia/Kolkata` in T-036's suite.

Consequence: a future change that removes the bound normalization while leaving the session pin
in place ships green, and the platform is then one connection-pooler or one raw query outside
`withTenant` away from the original defect returning silently.

Related, same file: the comment at `:429-431` claims its bucket assertions guard against
"fixing" the column with `AT TIME ZONE` instead of the bound parameter. Measured: with the pin
present that mutation passes 47/47, and with the pin also removed the failure lands at `:466`
(the cross-zone equality loop), not the block the comment annotates. On the committed tree the
column mistake is caught by neither suite. The projection-side danger the comment describes is
real — `DATE_TRUNC('day', "periodStart" AT TIME ZONE 'UTC')` yields `2025-12-31` under
`America/New_York` — but that is not what those assertions test.

**Fix direction:** give each guard a case that fails when *it alone* is reverted — the bound
one needs a session pinned non-UTC *and* the `withTenant` pin bypassed, which is why it was
missed. Then correct the docstring and reattach or requalify the `:429-431` comment.
