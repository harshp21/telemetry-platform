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

## S-9 · analytics-service's internal-auth guard is wired around **zero routes** — **LOW, open, narrowed**

> **Narrowed, not closed.** The original entry read *"analytics-service has no service-to-service
> auth and no `INTERNAL_API_SECRET`"*. Both halves of that headline are now false, so leaving it
> would ship a knowingly-wrong authoritative file. What is left is the residue below, and
> **T-051 discharges it** by registering its route inside the scope that already exists.

**What now exists** (slice 1 of scope B, `docs/plans/s-009-analytics-internal-auth.md` — note
that `CLAUDE.md` forbids reading `docs/plans/` as a record of completion, which is why the
substance is here):

- `apps/analytics-service/src/config/env.ts` declares `INTERNAL_API_SECRET` as
  `internalApiSecretSchema` **by identity**, not as a local chain, so analytics is the fifth
  derivation of S-8's one rule rather than a fifth strictness. Asserted, not assumed: repointing
  the declaration at a locally written chain with the fragment's *exact* spelling reddens
  `declares INTERNAL_API_SECRET as internalApiSecretSchema itself` in
  `apps/analytics-service/tests/env.schema.unit.test.ts` and nothing else
  (`Tests 1 failed | 18 passed (19)`).
- `src/middleware/internal-auth.middleware.ts` — the same `secretsMatch` from
  `@telemetry/shared-utils` the other three guards use, a non-string header rejected rather than
  normalised, a returned `reply`, and `ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED` rather than
  a literal. **Four properties, three of them guarded.** The first, second and fourth each redden
  exactly one named case when reverted — `AU15`, `AU13`, `AU16` respectively, one failure each,
  re-derived by three separate mutations at Gate 4 and again at the Gate-3 rework.

  **The returned `reply` is guarded by nothing, and no case was added for it**, because there is
  no behavioural difference to guard. Measured at the rework: dropping the `return` leaves the
  package **56/56 green**, and a request with no secret against a composed app answers
  `401 {"code":"UNAUTHORIZED"}` with `handlerRan=0` and the tenant hook never entered — byte-identical
  to the shipped form on all four observations. So the `return` is a statement of intent, which is
  what the middleware's own docblock already says. The only thing that could pin it is a third
  source-text census, and the one that exists is weaker than it reads (see the `AU15` note below),
  so another was judged not worth its maintenance cost. An earlier revision of this bullet said
  "each of those three" against four listed properties; corrected at Gate 4 (LOW-1).
- `src/middleware/tenant-context.middleware.ts` — `tenantIdSchema`, two distinct errors, no
  allowlist.
- `src/app.ts` — an `app.register` scope carrying both hooks as `onRequest`, guard first, with
  `/health` left on the root instance **outside** it.

**`AU15` is weaker than "the comparison is timing-safe", and the limit is measured.** It is a
source-text assertion over one file. A timing oracle inserted *ahead* of `secretsMatch` as
`internalApiSecret.length !== providedSecret.length ||` — which leaks the configured secret's exact
length through response latency — leaves the package **56/56 green** with `AU15` green, typecheck
exit 0 and lint clean. The same oracle in the other operand order **does** redden `AU15`, but only
because that spelling contains the substring `!== internalApiSecret` the assertion forbids: a
source-text coincidence, not a guard. Both orders measured at Gate 4 and re-derived at the rework.
**A second evasion is on record and is worse: S-59.** All three of `AU15`'s assertions hold while
the live comparison is a plain `===` — keep the import, call `secretsMatch("", "")` into an unused
local, and write the decision as `!(providedSecret === internalApiSecret)`, which contains no
forbidden substring. Measured `56/56` green, typecheck exit 0, lint exit 0. That restores the full
byte-prefix short-circuit S-8 removed from billing and worker, where the length oracle leaks only
the length.

Do not read a green `AU15` as evidence that no oracle was added, and do not read *two* recorded
evasions as the complete set — S-59 says why, and S-51 is the same enumerated-spelling shape in
billing-service.

**The residue, and it is the whole reason this id survives: the scope holds no routes, and a
scope with no routes never runs its hooks.** Measured at fastify 5.10.0 / Node v22.22.2, three
forms — an unmatched `GET` and an unmatched `POST` under an unprefixed scope, and a `GET` under a
scope registered with `{ prefix: "/v1/analytics" }`. Every one answered `404` with the hook's own
call log still empty. With one route added inside the scope the hook ran for that route and did
**not** run again for a sibling 404. So the guard is fitted and is currently reached by nothing.

That the seam is *correct* was measured separately, by registering one probe route inside the
production scope and injecting four header combinations against the real
`buildAnalyticsServiceApp()`:

```
/health, no headers                  -> 200 {"status":"ok","service":"analytics-service"}
scoped route, no headers             -> 401 {"code":"UNAUTHORIZED"}
scoped route, secret only            -> 401 {"code":"TENANT_CONTEXT_MISSING", ...}
scoped route, secret + tenant        -> 200
scoped route, wrong secret + tenant  -> 401 {"code":"UNAUTHORIZED"}
```

**What no test in slice 1 establishes:** that a *future* tenant-scoped route is inside that
scope. Nothing behavioural can, while the scope is empty. The nearest guards are `AU22b`, which
asserts the two `addHook` registrations' phase and order by reading `src/app.ts`'s text, and
`AU23`, which asserts `/health` answers `200` with no secret and goes red when that registration
is moved inside the scope (`expected 401 to be 200`).

**Discharged by T-051** — the first `/v1/analytics` endpoint — which must call its route
registration **inside** the existing `app.register` callback in `src/app.ts`. A route registered
outside it is unauthenticated and untenanted, and on this tree nothing would notice. Remove this
entry when that route lands with a case that fails if it is moved out (billing's `BU78` is the
shape: assert the service method was never called).

**The epic will not tell that implementer any of this, and that is the trap.**
`docs/epics/epic-9-analytics-service.md` § *T-051*'s **Files** line names
`controllers/analytics.controller.ts`, `services/analytics.service.ts` and
`repositories/rollup.repository.ts` — **not `src/app.ts`** — and no line in that section says the
route must be registered inside the scope. S-9 added a one-line forward reference under it; the
durable statement is here. Measured rather than warned about, four route placements against one
guarded scope carrying both hooks, fastify 5.10.0 / Node v22.22.2:

```
route inside the guarded scope        GET /v1/analytics/metrics -> 200  hooksRan=["auth","tenant"]
route in a sibling scope              GET /v1/analytics/metrics -> 200  hooksRan=[]
route on the root instance            GET /v1/analytics/metrics -> 200  hooksRan=[]
route in a sibling scope, prefixed    GET /v1/analytics/metrics -> 200  hooksRan=[]
```

So the wrong placement is not a 404 that someone notices — it is a **`200` that works**, at the
right URL, with the guard silently skipped. Three of the four placements ship an unauthenticated,
untenanted endpoint and only one is correct. The fourth row is this rework's addition; the middle
two were measured at Gate 4.

**Two adjacent gaps analytics now inherits, recorded so they are not rediscovered as new:**

- **S-54** — `internalApiSecretSchema` has no *maximum* length, so analytics accepts a secret long
  enough to be rejected downstream as an oversized header. Not fixed here: the ceiling belongs on
  the shared fragment, which is a five-service change.
- **S-19** — `apps/analytics-service/src/repositories/base.repository.ts` has no
  `set_config('TimeZone','UTC',true)` pin and **zero** real subclasses; its single
  `extends TenantScopedRepository` hit is the docstring example. T-051 creates the first subclass
  and inherits S-19 there. This slice creates no repository and does not touch that file.

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
because no status field exists. Six distinct hygiene defects, each verified:

- **An id is declared twice for two different tasks.** `T-070` is
  "Service coverage thresholds and CI gate" in `docs/epics/epic-12-testing.md` and
  "Tenant isolation type-level enforcement" in `docs/epics/epic-13-security.md`. The epic-12
  sense is committed (`f8a3246`); the epic-13 sense is unimplemented — its deliverable
  `scripts/check-tenant-isolation.sh` does not exist and no CI step runs it. `/ship T-070` is
  therefore ambiguous.
- **An id is committed but never declared.** `T-074` (`dba4899`, startup env-file resilience)
  runs past the declared maximum; no epic knows it exists.
- **Sub-task ids invented during delivery and never folded back.** `T-024C`, `T-024D`, `T-067A`,
  `T-067B`, `T-067C` have plan files but no epic declaration — and, corrected here after
  re-measurement during T-039, no *commit* either. The clause used to read "have plans and
  commits"; `git log --all --format="%h %s%n%b" | grep -icE "T[- ]?024[CD]|T[- ]?067[ABC]"`
  returns `0` with grep exiting 1, so none of the five ids appears in any commit subject or
  body in the spellings tried (hyphenated, spaced, run together). What shipped is the *plan
  file*, as payload of a differently-titled commit, and there are **five** carriers:
  `d68e719` (t-024c), `e3d7556` (t-024d), `21c9a9e` (t-067a), `f47b7d8` (t-067b), and
  `eb3ef10` + `4925e4a` (t-067c — added by the first, modified by the second;
  `git show --name-status` reports `A` then `M`). Naming all five matters, because the point of
  the clause is that id-based archaeology fails: `git log --grep` finds these tasks nowhere, and
  only a `docs/plans/` filename does.
- **An id reused by an unrelated artifact.** `docs/plans/t-068-auth-access-ttl-guardrail.md` is
  about the auth access-token TTL guardrail, not epic-12's T-068 (compose smoke tests) — so
  filename-prefix matching reports T-068 planned on the strength of a different task's plan.
- **A decision gate reads unresolved but was settled in practice.** `docs/epics/README.md` lists
  Q5 (refresh token delivery) with no "decided" marker, while `640e53d` and `bdb6bcf` shipped a
  hybrid cookie + CSRF model. Read literally, the router must refuse all of Epic 4 over a gate
  the repo answered long ago.
- **The declared task total does not match the declared tasks.** `docs/epics/README.md:138` reads
  `| **Total** | **73** | |`, and the per-epic column above it sums to 73 — internally
  consistent, so the table cannot be caught out by checking its own arithmetic. The epic files
  declare **76** task headings (`grep -cE '^#+ +T-[0-9]+[A-Z]?' docs/epics/epic-*.md`, summed),
  resolving to **75 distinct ids** because `T-070` is declared twice. The three headings above
  73 are `T-024B` and `T-025A` — epic-4's column says 8 against 10 headings — and the second
  `T-070`: epic-12's column says 4 against 5 headings, while epic-13's 4 matches its headings.
  State it as 76 headings / 75 distinct / 73 declared rather than "73 against 75", which invites
  a reader to hunt for two missing ids when one of the three extra headings is a re-declaration
  of an id already counted.

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

**`packages/shared-validation` has acquired the same shape, and a sweep should cover both.** S-8
moved that package's `rootDir` to `../..`, so `tsc` now emits to
`packages/shared-validation/dist/packages/shared-validation/src/`, and the pre-change emit at
`packages/shared-validation/dist/src/index.js` is simply left behind. Measured:
`grep -c internalApiSecretSchema` returns **0** against the old path and **1** against the new
one, so the stale copy predates the schema it is missing. It is unreachable — all six
`packages/shared-*/package.json` declare `"main": "src/index.ts"` (`grep -H '"main"'`), and
`git check-ignore -v packages/shared-validation/dist/src/index.js` reports `.gitignore:4:dist`,
so a clean checkout has neither copy. Recorded here rather than as a new id because it is a second
instance of the class this aside already names. S-8's plan said a sweep should cover both packages
and, until this sentence, said it **only** in `docs/plans/`, which `CLAUDE.md` forbids reading as
a record; folded in at S-8's Gate-6 rework (review LOW-2).
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

- `analytics` and `worker` are **byte-identical** (`13a533a2e2c2dcc1ff9db28fb5c7a1fd`, 111 lines
  each). **`billing` was a third member of that set until T-048 and is not any more** — it is now
  its own variant, materially longer. **No digest is quoted here on purpose**: re-run
  `md5sum apps/*/src/repositories/base.repository.ts` and `wc -l`, because any recorded value is
  falsified by the next edit to that file — including edits inside the task that records it.
  It moved three times inside T-048 alone: T-048's
  first pass gave `d11a7dc0cacce7a3e07e539e7f3ceb1f` / 174 lines, and the Gate-4 rework added the
  `InvoiceReadMethod` union, the `InvoiceDelegateSurfaceCensus` type-level assertion and the
  corrected claim paragraphs. Re-run the two commands rather than trusting either number.
- **`billing` is a fourth variant, deliberately** (T-048). Its `TransactionClient` is no longer
  the plain `Omit` over `PrismaClient`: it is re-expressed as
  `Omit<FullTransactionClient, "invoice"> & { invoice: Omit<FullTransactionClient["invoice"],
  InvoiceWriteMethod> }`, so the nine write methods are removed from the `invoice` delegate that
  `withTenant` hands its callback, and `FullTransactionClient` is exported so `InvoiceRepository`
  can widen back in exactly one accessor. The reason is S-48's hole — a second writer taking a
  bare `invoiceId` and issuing `tx.invoice.update` passed typecheck, lint and 207/207 — and the
  measured effect is that the naive bypass is now `TS2339`. Since the Gate-4 rework it also holds
  `InvoiceDelegateSurfaceCensus`, a type-level equality between the `invoice` delegate's string
  keys and `InvoiceWriteMethod | InvoiceReadMethod`, which fails `tsc` if a Prisma upgrade changes
  the delegate's member list — 18 members at 6.19.3, nine of them writers. **The other four copies
  were left alone deliberately**, on the same one-task-per-commit ground this entry was filed for: reaching
  into four other services' transaction types inside a billing guard is the move this gap exists
  to describe. T-048 took the **delegate-level** form and not S-48's wholesale `| "invoice"`,
  because that shape gives 11 errors on this file — 7 × `TS2339`, of which **five are legitimate
  reads** and two are the writers. See S-48 for the measurement and for what the narrowing does
  **not** reach.
- `auth` differs from `analytics` and `worker` in comments only — `diff` filtered to non-comment
  lines is empty. It is 118 lines because of a doc paragraph about `UserRepository` not extending
  the class.
- `usage` is the outlier at 124 lines: S-18 added
  `set_config('TimeZone', 'UTC', true)` to its `withTenant`, and moved its two setting names
  onto `DATABASE_SESSION_SETTINGS` constants. `grep -c TIME_ZONE` → `1` for usage-service, `0`
  for the other four, which still inline `'app.tenant_id'` as a literal.

Consequence: the other four services' `withTenant` opens a transaction whose session zone is
whatever the server defaults to. Their columns are the same `timestamp(3) without time zone`, so
the first raw timestamp predicate written in any of them inherits S-18 exactly.

**How bad it is today, stated no stronger than measured — and it has now changed twice.**
`grep -rn "extends TenantScopedRepository" apps/*/src` finds **four** real subclasses across
**three** services, in nine total matches (the other five are the `EventRepository` example
inside each base file's own docstring):

| Subclass | Base copy | `TimeZone` pin | Added by |
|---|---|---|---|
| `apps/usage-service/src/repositories/usage.repository.ts:150` | usage | **yes** | S-18 era |
| `apps/worker-service/src/repositories/event.repository.ts:73` | worker | no | T-040 |
| `apps/billing-service/src/repositories/meter.repository.ts:35` | billing | no | T-045 |
| `apps/billing-service/src/repositories/invoice.repository.ts` — `export class InvoiceRepository` | billing | no | T-045 |

**No row was added by T-048** — it changed billing's base copy, not the set of subclasses.
Every row is re-derived from
`grep -rn "extends TenantScopedRepository" apps/*/src`, filtered to lines beginning
`export class` — the unfiltered grep also returns five docstring examples. Three rows carry a
line number and were confirmed exact at T-048's Gate-4 Round 2. The fourth **deliberately does
not**, and cites `export class InvoiceRepository` instead: that one citation has rotted in six
recorded positions for a declaration nobody moved — `:87` when written, `:92` by the time
T-045's Gate 4 measured it, `:94` shipped, `:333` after T-047's detail read, `:351` after
T-048's Gate-3 rework rewrote the seam docblocks, and `:355` at T-048's Gate-4 Round 2, which
found **all eight** of that file's citations in this file stale by exactly +4 and traced it to a
44-line hunk the same round had added above them (`git diff -U0`, hunk header `@@ -301,0 +307,44
@@`). The +4 was re-derived a second time at the rework that replaced them. Six numbers, one
`export class` nobody moved. `event.repository.ts` went `:64` → `:73` over the same span and was
measured exact at Gate-4 Round 2, so it keeps its line number. Re-run the grep rather than
trusting the column.

**T-042 adds a query that the obvious fix would not reach, and it is in worker-service.**
`apps/worker-service/src/repositories/billing-enumeration.repository.ts` issues a `$queryRaw`
**outside** `withTenant` and outside any transaction, carrying two timestamp bounds — the same
shape this entry already records for auth-service's two pre-authentication resolver calls, now in
a second service. So "roll the `set_config('TimeZone','UTC',true)` pin into all five `withTenant`
implementations" would not cover it either, and that is now true of two services rather than one.
It is **not** a live defect: the bounds cross into SQL as `text` and are cast inside the
resolver's own body, which is session-independent — measured across `UTC` and `Asia/Kolkata` by
`I-TZ1` in `apps/worker-service/tests/billing-enumeration.integration.test.ts`, which pins **both**
arms rather than one. The resolver's parameters being `text` rather than `timestamp(3)` is what
makes that hold, and `R5` in the same suite asserts the catalog signature so a widening goes red.
It does not add a subclass: that class deliberately does not extend `TenantScopedRepository`,
because it binds no tenant.

So three of the four live tenant-scoped data paths run over an unpinned copy, and analytics and
auth still have no subclass at all. **No query is wrong today**, and both T-040 and T-045 shipped
on that basis by committing explicitly to the ORM for every date predicate, which is measured
safe (`CLAUDE.md` § *Raw SQL and timestamps*). T-045 re-measured it on billing's own tables
before relying on it: over four session zones (`UTC`, `Asia/Kolkata`, `America/New_York`,
`Asia/Kathmandu`) an ORM `findUnique` on `Invoice @@unique([tenantId, periodStart, periodEnd])`
found its row in all four, while `$queryRaw` equality with a bound JS `Date` found it in `UTC`
only. The exposure is the *next* raw timestamp predicate written in any of the three unpinned
services. In billing that mutation has been run rather than reasoned about: rewriting
`InvoiceRepository.findByPeriod` as `$queryRaw` with bound `Date`s turns
`apps/billing-service/tests/billing.integration.test.ts` **BI7** red, and — because BI7 pins
`Asia/Kolkata` in its own connection string — it stays green under that same defect when the pin
is changed to `UTC`, which is what makes the case a guard rather than a restatement of this
host's server default.

Until T-040 this paragraph read "latent, not live … exactly one real subclass"; T-040 took it to
two and T-045 to four. That is the whole hazard this entry describes: the fix is in the copy that
happened to have the bug, and the other four disagree with it silently. Each correction landed in
its own task's commit — T-040 at its Gate-6 review (LOW-7), T-045 as slice S7 of
`docs/plans/t-045-internal-metering-endpoint.md`.

One thing the obvious fix would still not reach, recommended by the S-18 reviewer and recorded
here so it is not lost: auth-service's two pre-authentication resolver calls
(`apps/auth-service/src/repositories/user.repository.ts:246-251` and `:258-266`) issue
`this.db.$queryRaw` **outside** `withTenantContext` and outside any transaction — verified by
reading both method bodies; the only `set_config` in that file is at `:235`, inside
`withTenantContext`. A transaction-local `set_config('TimeZone', 'UTC', true)` rolled into all
five `withTenant` implementations would therefore not cover them. They take no timestamp
argument today, so nothing is wrong now; the point is that "roll the pin to all five" is not by
itself a complete answer for auth-service.

**The setting name itself is duplicated the same way, and T-042 made it seven.**
`grep -rn '"app\.tenant_id"' apps packages --include=*.ts | grep -v /dist/` plus
`grep -rn "set_config('app.tenant_id'" apps packages --include=*.ts | grep -v /dist/`, filtered to
executable lines (no comments, no `it(...)` titles), shows `"app.tenant_id"` written in **seven**
places:

- **three named constants** — `apps/usage-service/src/constants.ts:75`
  (`DATABASE_SESSION_SETTINGS.TENANT_ID`), `apps/auth-service/src/constants.ts:69`
  (`AUTH_DATABASE.TENANT_CONTEXT_SETTING`) and, added by T-042,
  `apps/worker-service/src/constants.ts:919` (`WORKER_DATABASE.TENANT_CONTEXT_SETTING`);
- **four hard-coded literals inside `set_config`**, at `analytics`/`worker`
  `base.repository.ts:98`, `billing` `base.repository.ts:249` (it was `:98` with the other two
  until T-048 grew that file's type declarations and docblocks; re-derived at T-048's Gate-3
  Round 2 with `grep -n "set_config" apps/*/src/repositories/base.repository.ts`, which also
  returns docblock prose — filter to the `tx.$queryRaw` line) and `auth`
  `base.repository.ts:105`.

The count was **six** (two named constants) until T-042, whose diff edited this entry without
re-deriving it — S-33's shape again, corrected at that task's Gate-4 review (MEDIUM-7).
usage-service's constant is at `:75`, not the `:74` this paragraph carried.

**So worker-service now holds a constant and a literal for the same setting inside one package**,
which `.claude/rules/constants.md` names explicitly. T-042 decided **not** to point
`apps/worker-service/src/repositories/base.repository.ts:98` at its own new constant, and the
reason is this entry: `md5sum apps/*/src/repositories/base.repository.ts` shows `analytics`
and `worker` still byte-identical (`13a533a2e2c2dcc1ff9db28fb5c7a1fd`), and that identity is the
evidence this entry rests on. **`billing` left that set at T-048** — see the first bullet of
this entry, which carries the command rather than a digest; this
paragraph was written at T-042, when the set had three members, and said so until T-048's Gate-6
review found it (HIGH-1) after the same task had corrected the first bullet and not this one.
Editing either of the two to reference a service-local
constant would create a fifth distinct variant of a five-copy class whose whole gap is drift, from
inside a task told not to open S-19. The constant exists because the *tests* and the enumeration
repository need to name the setting; the literal stays until the shared-package fix moves all
four. Recorded here rather than resolved, which is the trade T-042 made and the place to overrule
it.

No test passes the bare literal to `set_config`/`current_setting` against a real database —
`worker`'s `tests/event.repository.unit.test.ts:46` and `billing`'s
`tests/{invoice,meter}.repository.unit.test.ts:24` declare it as a file-local constant to assert
against a **double**, and the remaining test-file occurrences are comments, `it(...)` titles and
one assertion-failure message at `apps/auth-service/tests/user.repository.unit.test.ts:116`.
`.claude/rules/constants.md` asks for promotion before the third copy, and this is the seventh;
the shared-package fix below should carry the constant with it.

Same drift class as S-14 (`.claude/agents/` vs `.github/agents/`): duplication that was harmless
while the copies matched, and became a correctness question the moment one changed.

**Fix direction:** promote one implementation to a shared package — a `@telemetry/shared-db`
alongside the existing seven shared packages — and delete the five copies. `TenantId` already
comes from `@telemetry/shared-types`, so the dependency direction is established. Do it as its
own task across all five services, not opportunistically inside the next repository change,
because it touches every service's data path at once.

**That task inherits S-48.** Billing's copy could give the platform's one RLS-less table a
type-level guard — a `| "invoiceLineItem"` in `TransactionClient`'s `Omit`, measured at two lines
— and narrowing one copy and not the other four is precisely this entry's subject. S-48 carries
the measurements, the limit (it binds `tx`, not `this.prisma`) and the design note that a shared
base cannot hard-code a per-service model name.

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

**Addendum (T-042 Gate 3) — there is a second leak mechanism, and the fix direction below does
not reach it.** `resetAuthState` (`:123-134`) finds users by e-mail and then derives the tenant
ids **from those users** (`const tenantIds = users.map((user) => user.tenantId)`). A `"Tenant"`
row with **no** `"User"` is therefore uncollectable by that reset under *any* filter — widening
the e-mail predicate to a stable prefix, which is what the fix direction below proposes, does not
help, because there is no user row to match.

Observed rather than reasoned about: after T-042's first full `pnpm test --force`, the
development database held a third `"Tenant"` — `name = 'First Tenant'`, `createdAt`
`2026-09-16 06:28:57Z`, **0 users**. That literal appears in exactly one place on the platform,
`apps/auth-service/tests/auth.integration.test.ts:623`
(`grep -rn "First Tenant" apps packages prisma --include=*.ts`, excluding `dist/`).

**The condition is not established, and is stated as not established.** It did **not** reproduce:
running `tests/auth.integration.test.ts` alone left the count unchanged, and running the whole
auth package (15 files, 166 cases) left it unchanged again. The one run that produced it was the
full 13-package gate, where turbo runs every package's suite concurrently — so a cross-suite
interaction is a *hypothesis*, not a finding. Do not write it up as the mechanism.

What **is** established is the shape: an orphan `"Tenant"` is invisible to this reset by
construction, and the entry above does not say so — its account is that the residue is "whatever
the final test created", and the final test creates nothing. Both statements can be true at once;
this is a second leak, not a correction of the first.

The row was deleted by hand at the end of T-042 (`DELETE 1`) to restore the baseline, which is
itself the evidence that nothing automatic collects it.

**Fix direction:** call `resetAuthState()` from `afterAll` as well as `beforeEach`, and widen the
filter to a **stable** prefix so an earlier run's residue is collectable. **And**, for the
addendum above, give the reset a second pass that collects `"Tenant"` rows by a stable
*tenant-side* marker — the suite's own `tenantName` values are literals it controls, so a
`name: { startsWith: <suite prefix> }` sweep would reach an orphan that the user-side filter
cannot. Changing the fixtures' tenant names to carry such a prefix is part of that fix, not a
precondition someone can assume.

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

---

## S-22 · auth-service's integration tests write to Redis db 0, alongside the real event stream — **LOW, open**

`apps/auth-service/tests/auth.integration.test.ts:34` hard-codes
`REDIS_URL: "redis://localhost:6379"`. No logical database is selected anywhere in
auth-service's config or test setup, so that resolves to **db 0** — the same database holding
`telemetry:events`, the production ingest stream. `TokenDenylistService`
(`src/services/token-denylist.service.ts:40`) then writes `denylist:<jti>` keys there on every
logout test.

Reproduced in isolation: running that one suite took db 0's `DBSIZE` from 2 to 3.

**Nothing is destroyed today.** The keys carry a TTL and self-expire, and no auth-service suite
issues `FLUSHDB`. The hazard is latent: the moment someone adds a `FLUSHDB` to an auth-service
suite — the obvious way to make its fixtures deterministic, and exactly what S-20's fix
direction invites — it wipes the developer's event stream, and on CI it would wipe whatever
else shares that instance.

Other suites already avoid this by convention rather than by mechanism: usage-service reserves
db 15 and `FLUSHDB`s only that (`tests/integration.constants.ts:64`, flushed at
`tests/integration.fixtures.ts:204`), and worker-service reserved db 14 for the same reason in
T-038, re-asserting that `CLIENT INFO` contains `db=14` immediately before **every** `FLUSHDB`
it issues.

An earlier revision of this entry said worker asserted the index once, before its *first*
flush, and that this meant a failed URL override "cannot silently flush the wrong database".
That was false and is corrected here. Vitest runs `afterAll` even when `beforeAll` throws, so
a single pre-flush guard leaves the teardown flushes unguarded. Measured on this repo's vitest
2.1.9: with the guard mutated to an assertion `CLIENT INFO` cannot satisfy, and a sentinel key
seeded into db 14, the suite reported `Test Files 1 failed (1) / Tests 6 skipped (6)` and
`redis-cli -n 14 DBSIZE` still went 1 -> 0. With the same mutation against the
every-flush shape, DBSIZE stayed at 1. Scope of the corrected claim: it holds for flushes
routed through that one helper. Nothing in the type system stops a future bare
`redis.flushdb()` in the same file, so this is a chokepoint, not an impossibility.

Found while verifying T-038's own Redis hygiene. Not fixed there: it edits an unrelated
service's test harness, which is the same reason S-8 was not folded into S-4. (S-8 is closed
and its id retired; the record is `docs/plans/s-008-timing-safe-internal-auth.md`.)

**Fix direction:** give auth-service a reserved logical database as usage-service and
worker-service have — `redis://localhost:6379/13`, say — and route every `FLUSHDB` through a
single helper that re-asserts `CLIENT INFO` contains the reserved index *on each call*, as
`apps/worker-service/tests/stream.consumer.integration.test.ts`'s `flushReservedDb` does. Do
not copy the one-guard-in-`beforeAll` shape: it does not cover `afterEach`/`afterAll`, which
run even when `beforeAll` throws. Pairs naturally with S-20, which has to touch that suite's
fixture lifecycle anyway. Note that a shared Redis instance
with per-suite logical databases is a convention no mechanism enforces; if suites ever run
against a managed Redis without multiple databases, this needs key prefixes instead.

---

## S-23 · usage-service's `REDIS_STREAM_NAME` accepts the empty string; worker-service's does not — **LOW, open**

The producer and the consumer resolve the *same* operator-supplied value through schemas of
different strictness, so `REDIS_STREAM_NAME=""` makes them disagree about which stream the
platform uses.

| Site | Declaration | `safeParse("")` |
|---|---|---|
| `apps/usage-service/src/config/env.ts:21` | `z.string().default(EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM)` | **OK**, parses to `""` |
| `apps/worker-service/src/config/env.ts:41` | `z.string().min(1).default(WORKER_STREAM_CONSTANTS.DEFAULT_STREAM_NAME)` | throws `String must contain at least 1 character(s)` |
| `apps/worker-service/src/config/env.ts:42` (`REDIS_CONSUMER_GROUP`) | `z.string().min(1).default(...)` | throws, same message |

Measured against the real schemas, not a reconstruction, under vitest, zod 3.25.76 — on
usage-service's compiled `dist/src/config/env.js` and on worker-service's `src/config/env.ts`.

**The recipe differs per service since T-041, and this matters if you reproduce it.**
usage-service's `EnvSchema` is a plain `z.object`, so `EnvSchema.shape.<field>.safeParse("")`
works. Worker's is now `z.object({...}).superRefine(...)` — a `ZodEffects`, which has **no
`.shape`** (measured: `"shape" in EnvSchema` -> `false`). For worker use
`EnvSchema.innerType().shape.<field>.safeParse("")`, measured to return the identical
`String must contain at least 1 character(s)`. Nothing this entry asserts changed; only the way
to re-run it did, which is why it is recorded here rather than left for the next reader to hit. The two `REDIS_STREAM_NAME` fields — usage's and worker's, the pair
the divergence is about — were also probed with `undefined`, and both yield the shared default
`telemetry:events`, so the divergence is specific to the *empty* value and not to the absent one.
Worker's `REDIS_CONSUMER_GROUP` is not part of that pair: `undefined` yields its own default,
`worker-group`, and usage-service declares no consumer-group field at all. (An earlier revision
said "both fields", which read against the three-row table above as worker's two — false for the
consumer group. Gate-4 re-review LOW-3.)

Consequence with `REDIS_STREAM_NAME=""` set on both services: usage-service parses `""`, and
`apps/usage-service/src/events/stream.publisher.ts:36`'s
`env.REDIS_STREAM_NAME || STREAM_CONSTANTS.DEFAULT_STREAM_NAME` takes the right-hand arm, so
the producer publishes to `telemetry:events`. worker-service refuses to start. Both fail
safely — nothing is written to a wrong stream and nothing is silently dropped — but they fail
*differently* on one value, which is the producer/consumer divergence
`apps/worker-service/.env.example`'s `REDIS_STREAM_NAME` note exists to prevent.

Second, smaller consequence: `WORKER_STREAM_CONSTANTS`' docblock
(`apps/worker-service/src/constants.ts:41-44`) states that the producer's `||` fallback "never
reaches". That is true for an *absent* variable and false for an empty one. T-038 corrected the
copy of this claim it had introduced in `src/events/stream.consumer.ts`; the T-037 docblock
still carries it, and was left alone deliberately — editing a T-037 comment inside a T-038
commit is the same one-task-per-commit objection that kept S-8 out of S-4. (S-8 is closed and
its id retired; the record is `docs/plans/s-008-timing-safe-internal-auth.md`.)

Found at T-038's Gate-4 review. Not fixed there: adding `.min(1)` changes another service's
startup contract inside a worker-service task, and would need its own schema tests.

**Fix direction:** add `.min(1)` to `apps/usage-service/src/config/env.ts:21` so both sides
reject the same values, extend usage-service's env-schema unit test with the empty-string case,
and then delete the now-dead `|| STREAM_CONSTANTS.DEFAULT_STREAM_NAME` arm at
`stream.publisher.ts:36` rather than leaving an unreachable fallback. Correct
`apps/worker-service/src/constants.ts:41-44` in the same change. Consider promoting the field
to one shared schema fragment in `@telemetry/shared-types` so a third service cannot introduce
a third strictness.

---

## S-24 · Agent sessions have twice been given a **stale snapshot** of `.claude/rules/` — **LOW, open**

`CLAUDE.md` designates this directory authoritative and instructs agents to trust it *without
re-verification*. That instruction is only safe if the copy an agent sees is the copy on disk.
Repeatedly it has not been.

**The count in this entry does not reconcile, and is left as what can be listed rather than
guessed — deliberately not "fixed" at S-9**, which added the bullet below and whose brief was
explicit that this entry should be renumbered once, from the bullets, by whoever establishes the
mechanism. Renumbering it now would make the title agree with a list that is still growing. The title says "twice", an earlier revision of this sentence said "Four times now"
while listing **three** bullets, and T-048's rework added a fourth. Which sighting the missing
fourth was is not recoverable from the text, so the durable claim is: **the bullets below are the
recorded sightings** -- four bullets, five occurrences, because the last one records the same
mismatch seen twice on one task in two different sessions. The numerals in the title and in the
earlier body sentence are not evidence for any other count. Whoever fixes the mechanism should
renumber this once, from the bullets.

**Observed by agents who then went and read the files with `cat` — two reviewers and two
implementers:**

- At T-038's Gate-4 review: the injected `.claude/rules/*` were pre-`1b872b3` — a `testing.md`
  still carrying the integration-exclusion wording that `1b872b3` had already fixed, a
  `known-gaps.md` ending at **S-10**, and a `review-standards.md` with no *Universals Must Cite
  Their Mutation* section. On-disk at the same commit, all three were current.
- At T-038's Gate-6 review, in a different session: the injected `known-gaps.md` ended at
  **S-21**, so it could not see the S-22 correction and the S-23 entry that the very diff under
  review had added.
- At T-042's Gate 3 (implementation, not review — so this is no longer only a reviewer-side
  sighting): the injected `known-gaps.md` ended at **S-40**'s predecessor, **S-39**, while the
  file on disk ran to **S-41** (`grep -n "^## S-" .claude/rules/known-gaps.md`, md5
  `1dc3cede5edcc14683cfc69746733706`). The implementer was about to file a new entry and would
  have numbered it **S-40**, colliding with the existing S-40 — which is precisely the harm the
  "How this bites" paragraph below predicts, reached from the *writing* side rather than the
  reading side. It was avoided only because the working practice below was followed and the file
  was `cat`-ed first. The entry became S-42.
- At T-048's Gate 3 Round 2 (implementation): the injected `known-gaps.md` ended at **S-39**,
  while the file on disk ran to **S-50** — 3 176 lines, md5 `5d389f806dc78d99ebf1a7b263cd656a`,
  `grep -n "^## S-"` putting S-50 at `:3111`. So the injected copy could not see S-46, S-47,
  S-48 or S-50, and the rework's whole subject was **editing S-48 and S-50**. The Gate-4 review
  of the same task, in a different session, reported the identical mismatch. Both were caught by
  `cat`-ing the file first, which is the working practice below and is still the only thing
  catching it.

- **At S-9, both outcomes in one task, hours apart — the first evidence the condition is
  *intermittent*.** This is new information, and it is why the pair is recorded together rather
  than as a fifth bullet about staleness. At S-9's Gate-3 rework the injected copy **matched
  disk**: md5 `4b0b9a3c02844d2e22d301bf0848430a`, 3 907 lines, 48 headings ending at S-56, checked
  by `cat` before the entry was edited. At that task's **Gate 4 Round 2**, in a different session
  on the same working tree, the injected copy was the **Round-1 revision** — 48 headings ending at
  S-56 — while disk was md5 `543fbc3a3ab8f0d0937775b6997abbd9`, 4 079 lines, **50** headings: it
  could not see S-57 and S-58, which the *same task* had written between the two sessions. So the
  injected copy is not reliably stale and not reliably fresh; it was both, for one file, within
  one task. Any fix aimed at "the snapshot is always old" is aimed at the wrong shape.

**What is *not* established:** the mechanism. No session has investigated whether this is
snapshot timing, caching, or something else, and nothing here reproduces it on demand — every
sighting is an after-the-fact observation by an agent who noticed a mismatch, not a controlled
probe. Do not restate the cause as known. The *consequence* is what is measured: an agent can
cite `.claude/rules/` accurately and still be citing a superseded revision.

**Why it is LOW and not higher:** it has caused no wrong verdict so far, because in both cases
the reviewer noticed the mismatch and re-read from disk. It is filed because that recovery
depended on the reviewer being suspicious, which is not a mechanism either.

**How this bites, concretely:** the reviewer that cannot see S-23 also cannot see that the gap
it is about to file already exists, so the same finding gets a second id; and an agent working
from a `known-gaps.md` that stops at S-10 will not know that S-11 through S-21 forbid what it is
about to write. The third sighting adds a sharper one: an agent that **adds** an entry numbers it
from the highest id it can see, so a stale snapshot produces a *duplicate id* — and the ids rule
at the top of this file says ids are never reused, so the duplicate would have to be resolved by
renumbering something, which every citation of it then points at wrongly.

**Working practice until it is fixed:** an agent that is going to *cite* or *edit* a
`.claude/rules/` file should `cat` it first and treat the injected copy as a hint, not as the
text. Reviews that quote these files should say which revision they read, as T-038's Gate-4
review did. Cheap, and it is what caught both sightings.

**Fix direction:** establish the mechanism before attempting a fix — the listed sightings are the
whole evidence base, and a fix aimed at the wrong layer would be unfalsifiable. If it turns out
to be unfixable from inside the repository, say so here and keep the working practice above.

---

## S-25 · worker-service's largest file is outside its own coverage thresholds, and the per-suite Redis database convention does not scope *reads* — **LOW, open**

Two findings from T-039's Round-1 review, filed under one id because they share a cause: a
guard that exists is assumed to cover a case it was never scoped to.

### 1 · `src/events/**` is excluded from coverage collection

> **The `src/jobs/**` half of this is closed by T-042** (decision D4), which put the first
> production code in that directory and removed the glob in the same change rather than
> inheriting the exclusion. Measured after removal, with the new job and queue files in place, by
> `pnpm --filter @telemetry/worker-service exec vitest run --coverage` on the tree that ships
> (234 cases, 17 files): **`98.26 / 93.07 / 94.73 / 98.26`** (statements / branches / functions /
> lines) against thresholds of `80 / 75 / 80 / 80`, with `src/jobs` at **100%** and `src/queues` —
> added by the same task and deliberately **not** excluded — at **`100 / 94.44 / 100 / 100`**. So
> no threshold had to move, which is the boundary D4 set for itself. The list below is the
> pre-T-042 one; `src/jobs/**` is no longer in it.
>
> Note the gate does not read any of this: `pnpm test` is `vitest run` with **no** `--coverage`,
> so the thresholds are enforced by nothing in CI. That is pre-existing and is part of what this
> entry stays open on.
>
> **Two revisions of these figures were wrong, and the second one is the more instructive.** The
> paragraph first carried `97.38 / 92 / 94.73 / 97.38`, wrong in three of its four numbers. The
> rework replaced it with `98.13 / 92.91 / 94.73 / 98.13` and `src/queues` at `98.59 / 93.33` —
> correctly measured, and *immediately* made stale by the same rework's three new queue cases
> (`Q7`–`Q9`), which took the suite from 230 to 233 and `src/queues` from one uncovered line to
> none. The figures above are from the final tree. That is S-33's shape twice inside one entry;
> the lesson is to re-measure **after** the last code change, not when the finding is written.
> The entry's conclusion — no threshold had to move — held under all three sets, which is why
> this was HIGH for being a false figure in an authoritative file rather than for its consequence.
>
> `src/events/**` is untouched and this entry stays open on it.

`apps/worker-service/vitest.config.mjs:129` lists `"src/events/**"` in `coverage.exclude`,
alongside `src/**/*.d.ts`, `src/**/index.ts`, `src/startup.constants.ts`, `src/config/container.ts`,
`src/middleware/**`, `src/models/**`, `src/telemetry/**` and `src/types/**` — plus `src/jobs/**`
until T-042 removed it. The thresholds it guards are at `:145-150`,
`lines/functions/statements: 80` and `branches: 75`.

(**Re-run both greps rather than trusting these two numbers — they have now been wrong three
times, twice inside the commit that wrote them.** They read `:18` and `:25-30` until T-042's Gate-3
rework; those were already stale at `5cb454a`, so not damage T-042 did, but T-042 rewrote the
sentence around them and left the numbers. The Gate-3 rework then re-derived them as `:79` and
`:95-100` — correct when measured — and the *same task's* Gate-5 rework inserted a 50-line
`test.env.TZ` docblock at `:7-56`, moving both by exactly 50 lines, which is the state Gate 6
caught. That is S-33's shape for the fourth time in T-042, landing inside the parenthetical whose
own subject is that failure, and it is the argument for S-33's mechanical checker rather than
another careful pass. The commands, and what they returned on the tree that ships:
`grep -n '"src/events/\*\*"' apps/worker-service/vitest.config.mjs` → `129:        "src/events/**",`;
`grep -n "thresholds" apps/worker-service/vitest.config.mjs` → `145:      thresholds: {`, plus a
comment match at `:138` that is not the block.)

`src/events/stream.consumer.ts` is **777 lines** after T-039 — measured with
`find apps/worker-service/src -name '*.ts' | xargs wc -l`, against 1 541 lines of `src/` in
total. It is larger than every other source file added together (764: `constants.ts` 281,
`index.ts` 145, `base.repository.ts` 111, `app.ts` 70, `config/env.ts` 59, `container.ts` 44,
and 54 across the fourteen one-line barrel `index.ts`s and four small files). It holds the read
loop, the
recovery pagination, the reply parsers and the failure classification, and none of it is
measured by the service's own gate.

Three of T-039's Round-1 findings were branches in that path with no test at all — the
`malformed` warn, the `RECOVERY_MAX_PAGES` bound, and the default message handler that a
deployed worker actually runs. All three now have cases (`U37`, `U38`, `U34`), which is
evidence for the *consequence* of the exclusion rather than a fix for it: they were found by a
reviewer reading the diff, not by a threshold.

**Not fixed in T-039** because removing the exclusion changes what the thresholds mean for the
whole service, needs the other excluded globs decided at the same time, and would put a
coverage-policy change inside a feature commit. Filed rather than left to the plan: `CLAUDE.md`
says a plan marks a task *started* and nothing may read `docs/plans/` as evidence, so §10's
"handed forward to epic-12" is not a durable record.

**Fix direction:** own it in epic-12 alongside `T-070` (the service-coverage-thresholds task —
note `T-070` is declared twice, see S-15). Measure the file first with the exclusion lifted;
decide the thresholds from the number rather than assuming the existing 80/75 transfers.

### 2 · The per-suite logical-database convention scopes writes, not reads

`flushReservedDb()` in `apps/worker-service/tests/stream.consumer.integration.test.ts`
re-asserts `CLIENT INFO` contains `db=14` before **every** `FLUSHDB` (the shape S-22 records).
That guard is real, and it is about writes. Nothing scoped *reads*, and a `CLIENT LIST`-based
predicate in the same file was therefore satisfied by a connection in a different logical
database.

Measured on Redis 7.0.15, with a blocking `XREADGROUP` parked on database **13** and nothing
parked on 14:

```
CLIENT LIST | grep -c 'cmd=xreadgroup'                 -> 1
CLIENT LIST | grep 'cmd=xreadgroup' | grep -o 'db=[0-9]*' -> db=13
CLIENT LIST | grep 'cmd=xreadgroup' | grep -c 'db=14'  -> 0
INFO clients (issued on db 14)                          -> blocked_clients:1
```

So `CLIENT LIST` rows and `INFO clients`' `blocked_clients` counter both cross database
boundaries. `CLIENT LIST` does at least *attribute* each row (`db=<n>` and `cmd=<x>` share a
row, which is what makes a row-scoped predicate possible); `INFO clients` reports a bare
server-wide count with no attribution at all.

**One correction to the review that raised this**, because the entry would otherwise carry it
forward: `CLIENT INFO` is **not** in the same category. It describes the *calling* connection
— `redis-cli -n 7 CLIENT INFO` reports `db=7` and `-n 3` reports `db=3` — which is exactly why
`flushReservedDb()` can use it as a guard. Do not "fix" that helper on the strength of this
entry.

T-039 fixed its own instance by matching on a `connectionName` the suite sets on its client
(`INTEGRATION_REDIS.CLIENT_NAME`), which `duplicate()` inherits — measured: a client built with
`{ connectionName: "t039-probe" }` and its duplicate both reported `name=t039-probe db=14` from
`CLIENT INFO`. The general gap is open: nothing stops the next suite from writing a
server-wide predicate, and the one that existed was introduced by someone who had read S-22
and believed the database reservation covered it.

**Relation to S-22**, verified rather than asserted: S-22 documents the per-suite logical
database convention and the `FLUSHDB` chokepoint, and its own wording is about flushes —
"route every `FLUSHDB` through a single helper that re-asserts `CLIENT INFO`". So S-22 does not
overclaim; the reading that the reservation bounds *everything* a suite observes is the gap.
S-22 also already notes that "a shared Redis instance with per-suite logical databases is a
convention no mechanism enforces". This entry is the read-side half of that sentence.

Same family as S-14 (`.claude/agents/` vs `.github/agents/`) and S-19 (five copies of
`TenantScopedRepository`) only in the loose sense that all three are one-guard-assumed-general;
it is **not** the same duplication-and-drift mechanism — there is one copy of this helper, not
five — and it is recorded here as a weaker relation than those two share with each other.

**Fix direction:** when the next suite needs to observe connection state, give it a named
connection and match on the name; a `db=` match is better than nothing but does not survive two
suites sharing an index. `grep -rln 'CLIENT LIST\|INFO clients' apps/*/tests` returns
only `apps/worker-service/tests/stream.consumer.integration.test.ts` and its
`integration.constants.ts`, so the surface is one suite.

---

## S-26 · worker-service's shutdown teardown log lines raced `process.exit` — **LOW, largely closed by T-043**

> **T-043 (`fc66bd3`+) closed the main path and this entry is kept for the residue.** `stop()` now
> awaits the loop under a bounded `DRAIN_TIMEOUT_MS` before the handler returns, so on a clean
> signalled shutdown **with nothing else in the handler ahead of it** both teardown lines are
> emitted. T-042 put something ahead of it and made that conditional — see the addendum
> immediately below, which is the correction rather than a second finding.
>
> Measured by capturing the logger *inside* the `process.exit` spy — "inside", because
> `process.exit` does not return, so "afterwards" is not a moment a real process has. Three bodies
> of `stop()`, three arrays, **each labelled with the mutation that produces it** (re-measured at
> the Gate-4 rework; an earlier revision of this paragraph attached the three-element array to the
> wrong mutation, which was graded HIGH-1):
>
> | `stop()` body | log at the instant of exit |
> |---|---|
> | shipped | 7 entries; `"Stream read interrupted by shutdown"` **and** `"Stream consumer loop stopped"` both present |
> | drain gate deleted, `deregisterConsumer()` kept | **4**: `["Created stream consumer group","Shutting down gracefully","Deregistered stream consumer","Shutdown complete"]` |
> | reverted to its pre-T-043 body | **3**: `["Created stream consumer group","Shutting down gracefully","Shutdown complete"]` |
>
> Neither teardown line appears under **either** mutation, so the claim holds under both; only the
> attribution was wrong. Asserted on every run by `U86`, not merely observed.
>
> **What remains open, and why the entry is not deleted:** any exit that skips the signal handler
> (an uncaught throw, `SIGKILL`, a container OOM) still races as described below, and so does a
> drain that hits its timeout — that path logs the truncation and exits without the teardown
> lines, by design. The block-length table below therefore still describes the *undrained* path.
> **It was not re-derived at T-043** and needs nine real `SIGTERM` process runs to re-establish
> against the drained code; treat it as inherited-and-unverified for the current tree.
>
> The three scope comments on `U14`, `U24` and `U26` were narrowed in the same change, as this
> entry's fix direction required.

> ---
>
> **Addendum (T-042, answering Gate-5 finding F-3): the sentence above is conditional, and the
> condition is a nightly job in flight.** T-042 inserts `await invoiceQueue?.close()` into the
> shutdown handler **before** `streamConsumer.stop()`. `close()` waits for an in-flight job. While
> it waits, the parked `XREADGROUP` expires by itself after `STREAM_BLOCK_MS`
> (`WORKER_STREAM_CONSTANTS.DEFAULT_BLOCK_MS` = 5 000), the loop sees the shutdown flag and exits
> on its own — so by the time `stop()` runs there is **no read left to interrupt** and
> `"Stream read interrupted by shutdown"` is never written.
>
> Note this is a **different mechanism** from the race the rest of this entry describes: the line
> is not losing to `process.exit`, it is never produced, because the condition it reports did not
> occur. Nothing is lost either way; this is observability, which is why the entry stays LOW.
>
> Re-measured at T-042's Gate-3 rework — real `node --import tsx src/index.ts` on
> `telemetry_worker_app` and Redis **db 14**, a real job enqueued through the shipped
> `InvoiceGenerationQueue`, both tenants' billing calls hanging against a stub that accepts and
> never replies, then a real `SIGTERM`. Two runs of each case:
>
> | case | `Stream read interrupted by shutdown` | `Stream consumer loop stopped` | SIGTERM → exit | exit code |
> |---|---|---|---|---|
> | idle queue, run 1 | `grep -c` → **1** | 1 | 39 ms | 0 |
> | idle queue, run 2 | **1** | 1 | 36 ms | 0 |
> | job in flight, 2 tenants, run 1 | `grep -c` → **0** | 1 | 19 106 ms | 0 |
> | job in flight, 2 tenants, run 2 | **0** | 1 | 19 079 ms | 0 |
> | job in flight, 1 tenant | **0** | 1 | 9 116 ms | 0 |
>
> The in-flight timeline, from the shipped log lines (run 1):
>
> ```
> 09:28:59.296  Invoice generation job started
> 09:29:00.312  Shutting down gracefully              <- SIGTERM
> 09:29:02.942  Stream consumer loop stopped           (the read expired on its own, +2 630 ms)
> 09:29:09.367  Invoice generation failed for tenant   (tenant 1, +10 s from enumeration)
> 09:29:19.370  Invoice generation failed for tenant   (tenant 2, +10 s)
> 09:29:19.370  Invoice generation job completed
> 09:29:19.380  Shutdown complete                      exit 0
> ```
>
> **`U86` is unaffected and must not be "fixed" on the strength of this.** It asserts both lines
> reach `logMessagesAtExit`, and it is green — its `invoiceQueue` double resolves `close()`
> immediately, so the handler never pauses long enough for the parked read to expire. That is a
> correctly scoped unit case about `stop()`; what it cannot see is another `await` placed in front
> of it. The same caveat that already sits on `U14`, `U24` and `U26` now applies to `U86`: a
> passing case is not evidence that a shut-down worker says so in its logs.
>
> **Not fixed, and deliberately.** Making the line appear would mean disconnecting the read before
> the queue close, which reverses T-042's ordering — the scheduler must stop producing work before
> the consumer drains what it holds (`apps/worker-service/src/index.ts`, and `U87` asserts it).
> Trading a correct shutdown order for a log line is not a trade worth making. If the line is ever
> wanted in this case, the change is in `StreamConsumer`, not in the handler's ordering.

`apps/worker-service/src/index.ts` calls `process.exit(0)` at the end of its shutdown handler.
The stream consumer loop is started with `void streamConsumer.run()` — deliberately discarded, so
`/health` is not delayed behind it — and `stop()` interrupts the blocking read rather than
awaiting the loop's own teardown. The two teardown lines,
`"Stream read interrupted by shutdown"` and `"Stream consumer loop stopped"`, are therefore in a
race with the exit, and usually lose it.

**Whether they lose depends on `STREAM_BLOCK_MS`, and this is measured, not reasoned.** Nine real
`SIGTERM` runs of `node --import tsx src/index.ts` against Redis db 14, at three block values:

| `STREAM_BLOCK_MS` | `"Stream consumer loop stopped"` emitted |
|---|---|
| `20` | **4 of 5 runs** |
| `500` | 0 of 3 |
| `5000` (the default) | 0 of 1 |

The mechanism, from the log timestamps: the whole shutdown handler completes in **3–6 ms**, while
`disconnect()` takes **~205 ms** to reject the parked read. The lines appear only when the read
expires inside that window — at block 20 the line lands at **+4 ms**, ahead of
`"Shutdown complete"` at +6 ms. `STREAM_BLOCK_MS` is
`z.coerce.number().int().positive()` (`apps/worker-service/src/config/env.ts:44-48`), so a small
block is a legal configuration, not a contrived one.

**An earlier revision of this entry said the lines are "never emitted in production".** That was a
false universal: it generalised from three runs that all used the default 5 000 ms block, and the
table above refutes it. The corrected claim is conditional, and the condition is a value an
operator sets.

**Nothing is lost, and this is the approved design.** T-039's D2-A handler acknowledges nothing,
so every delivered entry stays in the pending list and is reclaimable by `XAUTOCLAIM` on the next
start; draining in-flight work and `XGROUP DELCONSUMER` on clean shutdown are explicitly T-043's.
Severity is LOW because the consequence is observability, not data — and observability that is
*intermittent by block length* is arguably worse to debug than one that is reliably absent, which
is the reason to write the condition down rather than the conclusion.

**Which tests are involved, stated correctly.** An earlier revision of this entry named `U26`,
`U35` and `I12`, and scope comments were added to all three. That was wrong in both directions:

- `"Stream read interrupted by shutdown"` is asserted by **`U26`** — but only since the Gate-6
  review (M-8) added the assertion. Before that it was asserted by no test at all, and `U26`
  pinned only the *negative* (`logger.error` not called), so deleting the whole `info` call left
  the suite green.
- `"Stream consumer loop stopped"` is asserted by **`U14`** and **`U24`**.
- `U35` asserts a different message entirely (`RECOVERY_INTERRUPTED`), and `I12` makes no logger
  assertion at all.

The scope comments now sit on `U14`, `U24` and `U26` — the cases that actually assert these
lines. Those tests are correctly scoped: they construct `StreamConsumer` and assert what the
class does, which is true. The hazard this entry exists for is a reader taking a passing `U26` or
`U14` as evidence that a shut-down worker *says so in its logs*, which depends on the block
length.

**Fix direction (T-043, not a standalone task):** await the loop with a bounded timeout before
`process.exit(0)`, so teardown either completes or is reported as having been cut short. Do **not**
simply drop the `void`: `await streamConsumer.run()` never returns while the loop is running, so
`listen` is never reached — mutating `index.ts` that way was measured at the Gate-6 review as
`Tests 10 failed | 2 passed (12)` — note that **`(12)` is the suite size as it then stood**;
`tests/index.graceful-shutdown.unit.test.ts` held **14** cases at `fc66bd3` and more after T-043,
so the shape of the failure is the durable part, not the total. (An instance of S-33, inside the
entry that cites it.) (An earlier revision of this entry said that mutation would
"break `U25`, which asserts the loop starts *after* the listener binds". `U25` asserts the
opposite — `claimOrder < listenOrder`, the loop starting *before* the listener binds — and the
failure is far wider than that one case.) When it is fixed, narrow or remove the three scope
comments in the same change. **Discharged by T-043**, which took the bounded-timeout route and
narrowed all three comments.

**One process note, because it is the reason this is filed rather than left in a plan.** The race
was **disclosed by the implementer at Gate 3**, passed through two review rounds without being
raised, and was found independently by QA at Gate 5. Then this entry — written to capture it —
was itself wrong three times over and was corrected at Gate 6. A volunteered caveat in a hand-off
report is not a finding, and a finding written from one configuration is not a general claim.

---

## S-27 · Nothing keeps worker's stream envelope in step with usage-service's `RESERVED_STREAM_FIELDS` — **MEDIUM, open**

The producer decides which stream fields are *envelope* and flattens everything else into
sibling top-level fields; the consumer decides the same thing independently, from its own copy
of the list, and treats everything not on it as customer metadata. The two lists are unrelated
declarations. **When they disagree, the difference is written to a customer-facing column.**

Each claim below with the command that established it.

- **The two sets match today: 8 names, same order.** Compared programmatically rather than by
  eye — a script parsed `RESERVED_STREAM_FIELDS` out of
  `apps/usage-service/src/services/ingestion.service.ts` and `ENVELOPE_FIELD` out of
  `apps/worker-service/src/constants.ts` and diffed them both ways: `only in producer: (none)`,
  `only in consumer: (none)`, `same order: true`. Both are
  `eventId, tenantId, eventType, quantity, unit, occurredAt, idempotencyKey, timestamp`.
- **Nothing asserts it.** `grep -rn "RESERVED_STREAM_FIELDS" apps packages --include=*.ts`
  (excluding `dist/`) returns **five** lines: the producer's declaration, the producer's single
  use, and three *prose comments* — worker's `constants.ts` docblock (two lines: the one naming
  the constant, and the one carrying this grep pattern, which therefore matches itself) and the
  `stream-message.validator.unit.test.ts` docstring. An earlier revision said **four**, short by
  exactly that self-match; corrected at the Gate-5 review (QA-1).
  No test references it. Worker's `U41` pins worker's constant against worker's parser, which is
  a different property: it asserts a field named in `ENVELOPE_FIELD` reaches neither a column nor
  `metadata`, and it stays green whatever the producer's set contains.
- **The exposed direction is a producer-side *addition*, and the exposure is measured rather than
  reasoned about.** Feeding worker's `parseStreamMessage` an otherwise-valid entry carrying the
  three Q1 envelope fields returned
  `metadata = {"receivedAt":"2026-01-01T00:00:01.000Z","source":"sdk-web","version":"1"}`.
  So if the producer starts publishing any of them, they land in `Event.metadata` for every
  event — the blob a customer-facing API would return — with the whole suite green. `receivedAt`,
  `source` and `version` are not hypothetical: `docs/epics/README.md` records Q1 as **decided**
  with them required, and they are simply not on the wire yet (S-29).
- **A producer-side *removal* is the harmless direction**: the field would stop being reserved
  there and start arriving as metadata here, which is the same outcome by intent rather than by
  accident. Not tested; stated as the asymmetry, not as a measurement.

MEDIUM rather than LOW because the failure mode is a data-exposure path rather than a
correctness one, it is silent, and the triggering change lives in a different service from the
one that leaks.

**Why the copy exists, and why the fix is not "just import it".** `RESERVED_STREAM_FIELDS` is a
module-private `const` with no `export` keyword, inside another service's service layer.
Importing across two services' internals would couple worker's parse to usage-service's
implementation detail, which is a real objection and not a rationalisation.

**Fix direction:** promote the set to `@telemetry/shared-types` alongside
`EVENT_STREAM_CONSTANTS`, have both services read it, and delete both copies. If promotion is
deferred, the cheap interim is a test that imports both and asserts set equality — which is only
possible once the producer's side is exported, so exporting it is the first step either way.

---

## S-28 · The `UsageLine` tenant predicate cannot be tested, and removing it is green — **LOW, open**

`EventRepository.upsertEventWithUsageLine` addresses the `UsageLine` through
`this.where({ eventId })`, which the tenant-isolation rule requires. **No behavioural test can
fail when that predicate is removed**, and this is recorded so that nobody deletes it on the
evidence that deleting it is green.

Measured, three times over, at T-040 Gate 3 and again at the Gate-4 review: replacing
`this.where({ eventId })` with a bare `{ eventId }` typechecks clean and leaves **all** of
worker-service's integration cases passing. The only failure is `U51`
(`tests/event.repository.unit.test.ts`), which asserts the *shape* of the `where` object rather
than an isolation outcome.

**The cause is the schema, not the test suite.** `UsageLine.eventId` is globally `@unique`
(`prisma/schema.prisma`, `eventId String @unique`; live index
`CREATE UNIQUE INDEX "UsageLine_eventId_key" ON public."UsageLine" USING btree ("eventId")`), and
the value is always an `Event.id`, itself a global primary key. So reaching another tenant's
`UsageLine` through that key would require this tenant to hold an `Event` with that id, which the
primary key forbids. The cross-tenant address is not merely unreached — it is unrepresentable
under this schema, which is why no integration case exists rather than why one was not written.

Contrast the **`Event`** lookup in the same method, whose predicate *is* load-bearing and *is*
tested: two tenants genuinely do share idempotency keys, which is the whole reason for migration
`v1_6`, and `I15` exercises it.

**Keep the predicate.** `.claude/rules/tenant-isolation.md` requires an explicit `tenantId` on
every tenant-scoped query, and the property should survive a schema in which `eventId` stops
being globally unique — at which point the exploit becomes reachable and this entry becomes a
live gap rather than a dormant one.

**Fix direction:** none available while `eventId` is globally unique. Revisit if `UsageLine.eventId`
ever loses its global `@unique`, or if `UsageLine` gains a second tenant-scoped lookup key that is
*not* derived from a global primary key — write the cross-tenant case then.

---

## S-29 · `docs/epics/epic-7-worker-service.md`'s T-040 section diverges from the shipped code in four ways — **LOW, open**

Same class as S-17, different epic. Filed so that T-041 and T-043 — which are specified in the
same file — are not read as contract without checking the code first. Each line re-derived.

- **`:114` names a file the atomicity requirement at `:116` forbids.** It lists
  `repositories/event.repository.ts`, `repositories/usage-line.repository.ts`; `:116` requires
  "Entire operation runs in a Prisma transaction". On this codebase those conflict:
  `TenantScopedRepository.withTenant` owns the transaction and `TransactionClient` is declared
  without `export` in all five copies of `base.repository.ts`, so two repositories mean either
  two transactions or an edit to `base.repository.ts` in one service alone (S-19). T-040 shipped
  one repository (Gate-2 decision D4).
- **`:126` writes `where: { idempotencyKey: payload.idempotencyKey }`**, which migration `v1_6`
  has made a **compile error**, not merely a bad idea. Verified by writing exactly that form
  into the shipped repository and running `tsc`:
  `error TS2322: Type '{ idempotencyKey: string; }' is not assignable to type
  'EventWhereUniqueInput'`, whose cascaded detail line reads `… is missing the following
  properties from type '{ id: string; tenantId_idempotencyKey: … }': id,
  tenantId_idempotencyKey`. `EventWhereUniqueInput` is now `AtLeast<…, "id" |
  "tenantId_idempotencyKey">`, so the epic's snippet cannot be typed, let alone run.
- **`:143`'s `metricKey` rule yields an unpriceable key.** It says
  `${event.eventType}.${event.unit}` — e.g. `"api.request.requests"`. Against the entries on the
  live stream that produces `"api.request.request"`, matching no `Meter` seeded by
  `prisma/seed.ts` (`DEFAULT_METRICS = ["api.request", "storage.write", "storage.read"]`) or by
  usage-service's integration fixtures. T-040 shipped the bare `eventType` (D1).
  **One qualifier, in the epic's favour, that T-040's plan omitted:** `:143` continues
  *"Adjust if Q1 decision specifies a different convention."* So the epic invites the override
  rather than flatly contradicting the code, and the plan's "the epic is wrong" framing was
  stronger than the text supports. The divergence worth recording is that the adjustment has
  been made and the line still reads as the default.
- **Q1's envelope is recorded as decided and is not on the wire.** `docs/epics/README.md` records
  Q1 with `receivedAt`, `source`, `version` and `payload` required. The producer publishes none
  of them, and does publish `quantity`, `unit` and `timestamp`, which Q1 does not list. See S-27
  for the consequence if that is ever reconciled producer-first.

**Fix direction:** decide contract-first in each case — correct the epic, or change the code and
say so. Do not "fix" any of them by editing a test: T-040's suite pins the shipped behaviour
deliberately, with the reasons inline.

---

## S-30 · `prisma/schema.prisma` omits the `@default("")` that `v1_3` gave `User.firstName`/`lastName` — **LOW, open, pre-existing**

**Not introduced by T-040** — found incidentally during its Gate-4 review and re-measured at the
rework. `git show 7dc7392:prisma/schema.prisma` already declares `firstName String` and
`lastName String` with no `@default`, so the drift predates the change that found it and belongs
to whoever owns `v1_3`.

Measured in both directions with `prisma migrate diff`, which is read-only:

- `--from-schema-datamodel prisma/schema.prisma --to-url <db>` emits exactly one statement —
  `ALTER TABLE "public"."User" ALTER COLUMN "firstName" SET DEFAULT '', ALTER COLUMN "lastName"
  SET DEFAULT '';` — and **nothing else**, which is also the evidence that T-040's `v1_6`
  `Event` index and `prisma/schema.prisma` agree exactly.
- The inverse, `--from-url <db> --to-schema-datamodel prisma/schema.prisma`, emits
  `ALTER TABLE "User" ALTER COLUMN "firstName" DROP DEFAULT, ALTER COLUMN "lastName" DROP
  DEFAULT;` — which is the shape the next `prisma migrate dev` would generate. Stated as the
  measured diff in that direction; `migrate dev` itself was **not** run, because it would write a
  migration.
- Live columns: `information_schema.columns` reports `firstName|''::text|NO` and
  `lastName|''::text|NO`. `prisma/migrations/v1_3_add_user_names/migration.sql` is where the
  defaults came from (`ADD COLUMN … TEXT NOT NULL DEFAULT ''`).

Nothing is broken today: the database has the stricter-looking state, registration always
supplies both fields, and `migrate status` reports the schema up to date.

**Fix direction:** add `@default("")` to both fields in `prisma/schema.prisma` so the model
matches `v1_3`, in a commit that does nothing else — or, if the defaults were only ever a
backfill convenience, drop them in a forward-only migration and leave the schema as is. Decide
which, rather than letting the next `migrate dev` decide by emitting a `DROP DEFAULT` nobody
intended.

---

## S-32 · `docs/epics/epic-7-worker-service.md`'s T-041 section diverges from the shipped code in four ways, plus one unstated cost — **LOW, open**

Sibling of S-29, which records the same class of defect in the **T-040** section of the same
file. Filed separately rather than folded in: S-29's title is literally scoped to that section,
so extending it would make its own title false, and four of the five items below concern a code
snippet S-29 never examined.

Line numbers are against the working tree as of T-041, re-derived with `grep -n` at Gate 3
Round 2.

**The reason this is LOW rather than MEDIUM, and the reason it is still open:** the file now
**self-corrects**. `:184-202` carries "What T-041 shipped differs from the snippet above in five
ways", enumerating every item below with its reason. What is *not* fixed is that the wrong text
remains above it, at `:151` and `:154`, and nothing in between points forward. A reader who
greps for the file path lands on `:151` and never reaches `:184`. That is the residual.

- **`:151` names a file that does not exist, and would sit outside this package's coverage
  thresholds if it did.** It says `apps/worker-service/src/events/dead-letter.handler.ts`;
  `ls apps/worker-service/src/events/` returns `index.ts` and `stream.consumer.ts` only. T-041
  shipped `src/services/dead-letter.service.ts` instead, because
  `apps/worker-service/vitest.config.mjs:79` lists `"src/events/**"` in `coverage.exclude`
  against thresholds of `lines/functions/statements: 80`, `branches: 75`.
- **`:158-172`'s snippet is a free function over module scope.** It closes over `redis`,
  `streamName`, `groupName`, `originalPayload`, `lastError` and `retryCount`, none of which
  exist in this repository's shape — every collaborator here is constructor-injected
  `(redis, logger, env, …)`. `originalPayload` in particular has no referent: the handler seam
  is `(id: string, fields: string[])`, so "the original payload" is the flat field list. The
  same objection is already recorded for T-038's snippet in `ensureConsumerGroup`'s docblock.
- **`:154`'s "Increment a Prometheus counter" has no substrate.**
  `grep -rn "prom-client" --include=package.json .` outside `node_modules` → no match. Deferred
  to T-057 by the Q10 decision, which `:14` and `:174-183` now record.
- **`:154`'s "Clear from PEL so it doesn't block the consumer" is false as stated.** A pending
  entry blocks nothing. Re-measured on Redis 7.0.15 at Gate 3 Round 2, db 14: one entry read
  with `XREADGROUP … >` and left unacknowledged; a second `XREADGROUP … > BLOCK 50` on the same
  group returned an **empty** reply while `XPENDING` still reported 1. So `>` delivers only
  entries never handed to any consumer, and an unacknowledged entry neither blocks nor is
  redelivered by it. What a stuck entry actually costs is a permanent PEL row and a recovery
  page on every pass. The `XACK` in the snippet is right; the reason given for it is not.
  **Do not reproduce this sentence in a comment.**
- **`:156`'s pre-check is an unstated cost, not a divergence.** "Fetch count before processing"
  means one `HGET` per *successful* message, on the happy path, forever. T-041 kept it — it is
  the only thing that catches a crash between the `HINCRBY` and the `XADD`/`XACK`, and it is
  what makes `retryCount >= max` on arrival terminal rather than a fourth attempt — and made the
  matching `HDEL` conditional so the happy path costs exactly one extra command rather than two.
  Recorded as an accepted trade (plan §9 R4), not as something to change.

**Scope of "five ways", stated precisely:** four of these are divergences between the epic and
the shipped code; the fifth (`:156`) is a cost the epic does not mention and the implementation
accepted. The epic's `:184-202` block counts all five together — and that is a *different* five
from this entry's, **in membership and not only in framing**. The epic's block lists five items
and calls them all differences; this entry lists four divergences plus one accepted cost, and the
two sets are not the same five items. So neither number can be used to check the other: matching
totals here are a coincidence of arithmetic, not agreement. (Gate-5 QA finding F-2; the
membership half added at Gate 6.)

**Fix direction:** rewrite `:151` and `:154` in place so the section is correct where a reader
first meets it, and reduce `:184-202` to a short changelog note — or, if the epic files are to
stay a historical record of what was *specified*, add a one-line forward reference immediately
under `:151`. Do not simply delete the correction block: it is currently the only true account
in the file. Pairs naturally with S-29 and with S-15's wider point that the epic files are not a
reliable manifest.

---

## S-33 · Measured claims in comments go wrong inside the commit that changes them — stale counts, and measurements attached to the wrong mutation — **LOW, open**

A comment states a count about the codebase, and the same change that makes it wrong ships it.
Every instance below was caught by a human or agent reading carefully; **none was caught by a
tool**.

**Only rows with a command behind them are listed.** That is deliberate, and it is this entry's
own thesis applied to itself: two earlier drafts carried rows whose truth could not be
mechanically re-derived, and **those were the rows that were wrong** — see the record at the
bottom. A count you cannot re-run is not evidence.

| Claim, and where | Command | Result |
|---|---|---|
| `constants.ts`: `WORKER_STREAM_CONSTANTS`' member count "feeds `env.ts`", with a `grep -c` to check it | `git show <rev>:apps/worker-service/src/config/env.ts \| grep -c 'WORKER_STREAM_CONSTANTS\.'` | **7** at `7ad9375`, `b558641`, `7dc7392` and `c88a933` alike — the claim was *true* until T-041. T-041's `.superRefine` took it to **12**; the task first wrote **11**, so the correction was itself wrong and only a second pass fixed it |
| `constants.ts`: "the workspace's **single** production `xadd` call site" | `grep -rn "\.xadd(" apps packages --include=*.ts` excluding `dist/` and `tests/` | **two** call sites — T-041's own `dead-letter.service.ts` refuted it. The grep returns **three** lines: the third is the comment carrying the pattern, matching itself |
| `constants.ts` + S-27: the `RESERVED_STREAM_FIELDS` grep "returns **four** lines" | `grep -rn "RESERVED_STREAM_FIELDS" apps packages --include=*.ts` | **five** — same self-match |
| S-19: "exactly one real subclass … **latent, not live**" | `grep -rn "extends TenantScopedRepository" apps/*/src` | **two** at T-040, which added worker's `EventRepository` — the first live data path over a base copy without the `TimeZone` pin. **Four** at T-045, which added billing's `MeterRepository` and `InvoiceRepository` over a third unpinned copy. Re-counted in each task rather than trusted; the entry now carries the table rather than a number in prose |
| T-043 `stream.consumer.unit.test.ts`: the `dispatch`-guard mutation "reddens **nine** cases", with the nine listed | apply `if (this.shouldStop()) return;` at the top of `dispatch`'s per-entry loop, then `pnpm --filter @telemetry/worker-service exec vitest run tests/stream.consumer.unit.test.ts` | **eleven** — `Tests 11 failed \| 43 passed (54)`; the list omitted `U37` and `U70`. Caught at T-043's Gate 4 as LOW-2, inside a comment written in this entry's own style |

**A fourth recurrence, S-9, and it is the reason to stop filing these and build the checker.**
Three instances in one task, all in files `CLAUDE.md` designates authoritative, and in every one
the author wrote the refuting evidence into the same entry or the same file:

| Instance | Claim as written | Measured |
|---|---|---|
| S-9 test docblock (Gate 4, MEDIUM-1) | "A false positive is possible; a false negative is not, which is the right way round." | A length oracle ahead of `secretsMatch` leaves the package **56/56 green**, `AU15` green, typecheck exit 0, lint clean. The *same docblock* already said the assertions "would not notice a leaky comparison written some third way" |
| S-58 title (Gate 4 Round 2, MEDIUM-3) | "The **five** `.env.example` files carry **three** different values" | **Six** files (the repo root was missed) and **two** values — and the entry's own body said the rework had removed the third spelling while the title still asserted it |
| S-57 (Gate 4 Round 2, MEDIUM-4) | "a one-character edit to any one of the three declarations would ship green through all 13 packages" | True of **two** of three: analytics 56/56 and billing 231/231 ship green, usage is caught `3 failed \| 235 passed (238)` — by the three bare literals the *same entry* lists as a constants-gate violation |

**What the proposed checker would have caught here, stated precisely rather than optimistically:**
the S-58 rows, because both carry a re-runnable `grep` next to a numeral — a discover-the-files
form would have returned six and the value census two. It would **not** have caught S-57's, because
"would ship green through all 13 packages" has no command in it, only a prediction about a mutation
nobody ran; nor MEDIUM-1's, for the same reason. So the checker reaches the counts and misses the
universals, which is the split the scope note below already describes — now measured on a fourth
task rather than argued.

**Then S-9's Gate 6 found two more, and they change which half to build first.** Both arrived in
the round that wrote the sentence above, which is the cleanest possible demonstration of it:

| Instance | Claim as written | Measured |
|---|---|---|
| S-58's table (Gate 6, LOW-6) | row cites `apps/analytics-service/.env.example:33` | the line is **`:39`** — moved by the six comment lines the *same batch* added above it |
| S-59 (Gate 6, LOW-7) | "**S-48** records exactly that progression — four gates, four previously-unlisted spellings" | `grep -c "four gates"` → **0** in S-48, **2** in S-51. The correct id is **S-51**, which the same entry cites correctly two paragraphs earlier |

**Neither is a count, and neither is reachable by the `grep`-and-compare half.** One is a
`file:line`; one is a finding-id cross-reference. Both are squarely the **second** half of this
entry's own proposal — the citation checker the scope note below calls "the harder and more
valuable target" — and the scope note's argument is now carried by six instances across three
rounds of one task rather than by reasoning.

So the block above is wrong in its emphasis and is corrected here rather than rewritten: it
concluded the checker "reaches the counts and misses the universals", which is true of *those*
three instances and stops being the useful summary once these two are added. The count half
reaches 2 of 6; the citation half reaches 2 of 6; the universals reach neither. **The half nobody
has prioritised is the one with the most instances behind it that a machine could actually
settle** — a `file:line` either resolves to the cited text or does not, and a finding id either
exists and says what the citing text claims or does not. Both are decidable without judgement,
which is more than can be said for a universal.

**This is the point to build it, and a task is being opened.** Four tasks have filed instances and
the checker is still unbuilt; a seventh entry describing the same shape is worth less than the
pass S-33 has specified since T-041. Scope it to **both** halves, and start with the citation
check: `file:line` references and `S-xx` / `T-0xx` / `U`/`I`/`BU`-case ids quoted between
`.claude/rules/`, `docs/plans/`, `docs/reviews/`, `docs/qa/` and source comments. Do not wait for
another instance — the previous revision of this paragraph said "should not wait for a fifth
instance" and two more landed before it was read.

**A second shape, and it is not a count: a measurement attached to the wrong mutation.** S-26's
T-043 note quoted a three-element log array as what "the drain removed" produces. Re-measured by
capturing the logger inside the `process.exit` spy under each mutation in turn: the drain-removed
body yields **four** entries (the deregistration still runs), and the three-element array is what
the **pre-T-043** `stop()` yields. The load-bearing conclusion — neither teardown line reaches the
exit without the drain — is true under both, so nothing downstream was wrong; only the label was.
Graded HIGH at T-043's Gate 4 precisely because `.claude/rules/` is designated authoritative.
The remedy generalises: **a quoted output must name the exact mutation that produced it**, and if
two mutations are in play, run both and quote both. Note this one is *not* catchable by the
mechanical checker below — there is no command in the text to re-run, only a claim about which
edit was in place.

**The sub-pattern worth naming: a comment carrying its own verification command matches itself.**
That is two of the five rows, and it is how a count and its grep disagree by exactly one while
both look right.

**A third shape, added at S-45's Gate-4 review: a `file:line` citation broken by the citing
change's own edit.** S-45 inserted a 13-line forward-reference block into
`docs/epics/epic-8-billing-service.md` and, in the same diff, added four citations of a line that
the insert had moved -- `grep -n "INVOICE_IMMUTABLE" docs/epics/epic-8-billing-service.md` puts
the **Error response** declaration at `:171` where all four said `:158`. The remedy that generalises
is the one applied there: **cite the section heading, not a line inside a file the change is
editing.** The Gate-4 reviewer counted it as that session's sixth instance of this entry's shape;
the count is theirs, not re-derived here.

**Why LOW.** No instance caused wrong behaviour. The cost is reviewer time and the erosion of
`.claude/rules/`' authority — `CLAUDE.md` tells agents to trust these files without
re-verification.

**The record of this entry's own failures, kept because it is the evidence for the shape above.**
Draft 1 claimed row 1 was "refuted by T-040's own diff — eleven": wrong task, wrong number, and
it counted one figure's two movements as two instances, inflating the total to seven. Caught at
Gate 5 of T-041 and graded HIGH. Draft 2 fixed the count and introduced two more errors, both in
rows that had no command: a claim that a superseded text appeared in "no committed revision"
(false repo-wide — `git log -S "fourteen distinct log messages" --all` returns `c88a933`, where
it survives in `docs/reviews/t-040-event-usageline-processor.md`; the true statement is
file-scoped to `src/constants.ts`), and a header asserting every row had been re-derived by
command when two rows had no command to run. Caught at Gate 6. **Both failures were in
prose rows; every command-backed row has survived re-derivation at three gates.** That is why
draft 3 keeps only the latter.

**Fix direction — mechanical, not cultural.** These state the command that establishes them. A
check that extracts `grep -c …` / `grep -rn …` from comments, re-runs them, and compares against
the adjacent numeral would catch all five command-backed rows with no judgement — **provided it accounts for the
self-match**, or it reproduces the off-by-one it exists to catch. Scope it to `apps/*/src/**`
comments carrying a backticked command plus a numeral; run it in CI alongside lint.

**Scope note, added after T-043's Gate 6 measured the checker's reach.** As scoped above it would
have caught **none** of that round's findings, and that is not a small miss: the round's two
MEDIUMs were a *fabricated set of finding-id citations* (S-36 named three `CASE_BUDGET_MS`
precedents, all three real findings about something else, while the correct list sat in
`apps/worker-service/tests/integration.constants.ts:23-25`) and a superseded measurement claim.
Neither carries a re-runnable command, so neither is reachable by a grep-and-compare checker.

**The harder and more valuable target is cross-document citation of finding ids** — `T-0xx`,
`S-xx`, review round labels, and `U`/`I` case ids quoted between `.claude/rules/`, `docs/plans/`,
`docs/reviews/` and source comments. Those *are* mechanically checkable: the id either exists in
the named artifact and says what the citing text claims, or it does not. Whoever builds this should
scope it there as well as at the counts, or it will pass a file that cites three findings and gets
all three wrong.

Do **not** address this by deleting the counts. They are load-bearing: the `xadd` and subclass
counts are evidence for security-relevant claims, and a vaguer comment would be worse than a
stale precise one. The number should stay and become checkable.

---

## S-34 · The consumer-registry leak became unbounded when consumer names became instance-unique — **LOW, open**

A consequence of T-043's decision **D1/B**, not a defect in it, and recorded here so the trade is
visible rather than discovered.

`WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_NAME` (`apps/worker-service/src/constants.ts`) is now
`` `${hostname()}-${process.pid}` `` where it was the fixed literal `"worker-1"`. A **clean**
shutdown deletes its own `XINFO CONSUMERS` row. An **unclean** exit — `SIGKILL`, a container OOM,
an uncaught throw that skips the signal handler, or a drain that hits
`WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS` (which suppresses the deregistration deliberately) — leaves the
row behind, and the next start uses a new pid, so nothing ever collects it.

**Measured on Redis 7.0.15, db 14, at T-043's Gate-4 rework.** Three "restarts", each reading and
acknowledging one entry under a distinct `host-<pid>` name, then exiting without deregistering:

```
XINFO CONSUMERS -> name host-111 pending 0 idle 34
                   name host-222 pending 0 idle 23
                   name host-333 pending 0 idle 10
XPENDING        -> 0                      (nothing is stranded; the entries were acked)
XAUTOCLAIM … reaper 0 0-0   -> rows still present: 3   (a reclaim pass does not reap a row)
sleep 2; XINFO CONSUMERS    -> name host-111 … idle 2067   (idle grows; nothing expires)
XGROUP DELCONSUMER host-111 -> 0          (returns 0 at pending 0 — destroys nothing)
                            -> rows after: 2
```

The same sequence under the **shared** `worker-1` name leaves exactly **one** row after three
restarts, measured on the same fixture. So the leak was bounded at one row for the lifetime of a
deployment and is now one row per unclean exit. **Redis has no TTL on a consumer row**, and the
only thing observed to remove one is an explicit `XGROUP DELCONSUMER`.

**Consequence, stated no stronger than measured.** Nothing is lost and nothing is wrong: every row
above reports `pending 0`, so no entry is stranded, and `XGROUP DELCONSUMER` at `pending 0`
destroys nothing. The costs are that `XINFO CONSUMERS` replies grow, and
`StreamConsumer`'s `parseConsumerReading` walks every row on every shutdown.

**Both have now been measured, and neither is a performance problem.** At **10 000** registry rows
on db 14, `XINFO CONSUMERS` replied in **26 ms** and the parse walk took **2.6 ms** (T-043 Gate-5
QA; re-derived at Gate 6 as 20–28 ms including CLI startup). An earlier revision of this entry said
they had "never been measured at a scale where it matters" — that was true when written and is no
longer. **The entry stays open on the unboundedness, not on a cost**: the growth rate is "one per
unclean exit", zero on a healthy deployment and unbounded only in a crash loop, and **no test
drives a large registry**. The first guaranteed instance is an upgrade — a deployment's existing
`worker-1` row persists at `pending 0` permanently once the instance-unique default lands.

**Why this is the right trade anyway, and not an argument for reverting D1.** The shared name made
the registry bounded *and* made T-043's pending-zero guard unsound: two instances under one name
share one row, so the guard reads one instance's zero while the other holds work, and the delete
then destroys it (probe P11, reproduced at Gate 3 and again at Gate 4). A bounded registry is
cosmetic; that is unrecoverable loss of billing events.

**Fix direction:** a reaper — a periodic or startup sweep of `XINFO CONSUMERS` deleting rows with
`pending 0` and an `idle` above some threshold. That is new production behaviour with its own
failure modes (the threshold must exceed any legitimate idle period, or it deletes a live peer's
row), so it belongs in its own task rather than inside a shutdown change. Note the guard it needs
is the same one T-043 already implements: never delete a row whose `pending` is non-zero.

---

## S-35 · `docs/epics/epic-7-worker-service.md`'s T-043 section diverges from the shipped code in five ways — **LOW, open**

The third sibling of S-29 (T-040 section) and S-32 (T-041 section) in the same file. A **new id**
rather than an extension of either: both of those titles are scoped to their own section, so
folding this in would make one of them false — which is the exact objection S-32 records for not
having been folded into S-29.

All five re-derived against `docs/epics/epic-7-worker-service.md:262-278` (the snippet at :262-274 plus the acceptance criteria) and
`apps/worker-service/src/index.ts`'s shutdown handler:

1. The snippet logs **before** setting the shutdown flag; the code sets first, then logs.
2. `"Worker shutting down"` vs the shipped `"Shutting down gracefully"`.
3. `"Worker shutdown complete"` vs the shipped `"Shutdown complete"`.
4. `await bullWorker.close()` — **no such dependency exists anywhere in the workspace.**
   `grep -rn "bullmq" --include=package.json .` and
   `grep -rn "bullWorker\|bullmq" apps packages --include=*.ts` both return nothing, so the line as
   written would `await undefined.close()`. See the forward obligation below.
5. No `try`/`catch` and no `exit(1)` path; the shipped handler has both.

Plus two structural objections. The snippet omits `streamConsumer.stop()` and `app.close()`
entirely — the two calls that do the actual work — and its **File:** line names only
`src/index.ts`, while T-043 landed almost entirely in `src/events/stream.consumer.ts`. It also
closes over a module-scope `logger`, `prisma` and `redis`, where every collaborator in this
service is constructor-injected or reached through `container`; that is S-32's objection,
recurring.

**Unlike the T-041 section, which self-corrects in place (S-32), the T-043 section had no forward
pointer at all** — a reader landing on the snippet never learned it was wrong. T-043 added a
"What T-043 actually shipped" block immediately after it, so the source is now signposted; this
entry remains open because the snippet itself is still wrong.

**Three sibling entries for one file is itself the finding.** S-29, S-32 and this one all say the
same thing about different sections. The economical fix is one consolidated entry plus one pass
over the epic, but that retires two live ids, which this file's stability rule forbids, and it is a
docs task with its own review. Recorded rather than done.

### Forward obligation on T-042 — `bullWorker.close()`

T-043 deliberately did **not** implement the snippet's `await bullWorker.close()`, because there is
no BullMQ dependency to close. **T-042, which introduces the scheduler, must re-open
`src/index.ts`'s shutdown handler and add it**, ordered before `streamConsumer.stop()` so the
scheduler stops producing work before the consumer drains what it has.

Recorded here **and** in the epic's T-042 section because it previously lived only in
`docs/plans/t-043-worker-graceful-shutdown.md`, and `CLAUDE.md` is explicit that nothing may read
`docs/plans/` as a record. S-15 says the same of the epic files, which is why it is in both.

---

## S-36 · The drain's timeout path has no live-Redis regression guard — **LOW, open**

`StreamConsumer.stop()` races the retained loop promise against `WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS`
(3 000 ms). When the timeout wins, the drain is reported as cut short and **deregistration is
suppressed** — which is the safe direction, because a consumer whose loop is still running may
still hold pending entries, and `XGROUP DELCONSUMER` on a consumer holding pending entries
destroys them (S-34's sibling hazard, measured as probe P1 of T-043).

**The behaviour is correct and was verified live**, at Gate 5 of T-043, against a real worker
under a real `SIGTERM`: the drain timed out at **3001 ms** under real timers and the consumer row
was retained. **What is missing is a test that would catch it regressing.** `U79` covers the
`TIMED_OUT` branch with fake timers, so it pins the *decision* — timed-out ⇒ do not deregister —
but not that a real slow handler actually reaches that branch rather than, say, being cut off by
a connection-level timeout first.

**Why it was not simply written.** A live case needs a handler wedged past 3 000 ms, which adds
~3 s of real wall-clock to the integration suite and pushes against `CASE_BUDGET_MS` — the
per-case budget this package has already tripped over three times: `RUN_DEADLINE_MS` at 10 000
(T-041 Gate-4 Round 2), `BLOCK_MS_LONG` at 5 000 (T-041 Gate-5 QA F-3), and the pair of them
summing to 6 000 in `I12`, which neither per-constant fix looked at (T-043 S1). The canonical
list is `apps/worker-service/tests/integration.constants.ts:23-25` — cite that rather than
re-deriving it. (An earlier revision of this entry named three *different* findings, each real
but about something else entirely; corrected at T-043's Gate-6 review, MEDIUM-1.) Recorded rather than forced, on the S-21 precedent: a guard that exists for a verified
behaviour is worth having, and is worth *knowing you do not have*.

**What would make it worth writing.** Any change to the drain's timing semantics — moving the
timeout, making it configurable, or adding work after the race — because the fake-timer case
cannot tell you whether the real path still reaches the branch. If `CASE_BUDGET_MS` is ever
raised for other reasons, this is the first case to add.

**Do not close this by loosening `U79`.** It asserts the right thing; it simply asserts it
against fake timers. The gap is the absence of a live sibling, not a defect in the unit case.

---

## S-37 · `Tenant.deletedAt` has no writer and no reader, and billing has now made it a contract — **LOW, open**

Filed by T-045's Gate-4 review. Not a defect in anything shipped: it is a policy question that
nothing has answered and that one service now silently answers by omission.

**Measured on this tree**, `grep -rn "deletedAt" apps packages prisma --include=*.ts
--include=*.prisma` excluding `dist/`, returns exactly three lines:

- `prisma/schema.prisma:17` — the column, `DateTime?`.
- `prisma/seed.ts:24` — a `deletedAt: null` in a script that cannot run (S-13).
- `apps/billing-service/src/repositories/invoice.repository.ts` — a docstring in `tenantExists`
  recording the choice below.

So **nothing on the platform ever writes the column**, and nothing reads it. The database has no
opinion either: `pg_policy` on `"Tenant"` gives **four** policies — `tenant_self_select`,
`tenant_self_update`, `tenant_self_delete` and `tenant_self_insert` — all keyed on
`(id = current_setting('app.tenant_id', true))`, and **none** carries a `deletedAt` term. (An
earlier revision of this entry listed three, omitting the INSERT policy; corrected at Gate 5 of
T-045, QA-2, which re-read `pg_policy` and confirmed the INSERT policy has no `deletedAt` term
either, so the conclusion is unchanged.)

**What billing does today.** `InvoiceRepository.tenantExists` counts `"Tenant"` by id with no
`deletedAt` predicate, so a soft-deleted tenant is treated as live and is invoiced normally. That
was a deliberate choice at T-045 and the review ruled it correct: refusing to invoice a
recently-deleted tenant loses revenue for usage already incurred, which is T-045's own D1
argument — refuse rather than quietly lose money — pointed at a different target. Inventing a
billing-time soft-delete policy with no writer, no product decision and no other consumer would
have been exactly the silent resolution `CLAUDE.md` tells agents to refuse.

**Why it is still open.** The moment anything writes `deletedAt` — an account-closure flow in
Epic 4 or Epic 11 is the obvious candidate — billing's behaviour becomes a contract nobody chose,
and it will be discovered by a customer invoice rather than by a test. The cost of deciding it
later is not the code; it is that the first writer will not know billing has an opinion.

**Fix direction:** decide the policy *before* the first writer lands, and record it in
`docs/epics/README.md` as a decision gate rather than only in a repository docstring. If the
answer is "do not invoice a soft-deleted tenant", the change is one predicate
(`where: { id: tenantId, deletedAt: null }`) plus one integration case that seeds `deletedAt` —
measured as the whole diff, not estimated. If the answer is "invoice it anyway", say so in the
epic so the next reader stops re-deriving it. Either way, whoever adds the first writer should be
made to look here.

---

## S-38 · The `P2002` re-read path has no test against a real connection — **LOW, open**

`apps/billing-service/src/repositories/invoice.repository.ts`'s `createDraftInvoice` catches
Prisma's `P2002` on `Invoice @@unique([tenantId, periodStart, periodEnd])` and re-reads to return
the existing `invoiceId`. That catch is the **real** idempotency serializer — the step-2 existence
check is an optimisation, not a guarantee, because it and the insert are not serializable against
a concurrent caller.

**It is covered by unit tests only.** They seed a `P2002` on a repository double, so they pin the
branch and the re-read, but nothing standing drives that path through a real PostgreSQL unique
violation. The gate run confirms it: zero `prisma:error` lines across all 806 tests.

**The behaviour is correct — verified by hand, once.** Gate 5 of T-045 drove genuinely parallel
callers, 4 rounds at 2 and 4 concurrent: always one `201` and the rest `200` with the same invoice
id, 1 invoice, 1 line item, 20/20 lines billed, no `409`, no `500`. That run also confirmed the
`meta.target = null` scoping, with Prisma logging `Unique constraint failed on the (not available)`
as `telemetry_app`. **Nothing stands behind that verification now the session has ended**, which is
what this entry records.

**Why it was recorded rather than written.** The obvious test — `Promise.all` over two
`createDraftInvoice` calls — **can pass vacuously**: if the two callers happen to serialise, one
returns `201`, the other returns `200` from the *existence check* rather than from the `P2002`
catch, and the assertion is satisfied without the path under test ever running. A test that is
green whether or not it exercised its subject is worse than a recorded gap, and this file has
already spent a round on a guard that turned out to be decoration (`BU40b`).

**Fix direction:** a test here has to *prove the overlap*, not assume it — advisory locks, a
`pg_sleep` inside one transaction, or asserting on the Prisma error log rather than on the status
code. Whoever writes it should make the vacuous form fail first: with the `P2002` catch removed,
the case must go red, and if it does not, it is measuring the existence check instead.

**Not a correctness risk today.** Both paths return the same `200 { data: { invoiceId } }`, so a
lost race is already indistinguishable to the caller. What is untested is that it *stays* that way.

**S-45 gave that path a second consumer, and did not close this.** `BillingService` no longer
returns `createDraftInvoice`'s `created: false` to the caller: it re-reads the unbilled set once
and routes into the absorb branch, because the loser's own transaction — including its billed
update — has rolled back, and if it read a *superset* of the winner's set those extra rows would
stay unbilled while the caller got a `200`. That is S-45's own defect reached through a different
door, which is why the arm exists. It ships with **unit coverage only** (`BU94` drives the
routing, `BU94b` the ordinary case where the winner billed everything), which is exactly the
coverage this entry already records as insufficient — a repository double, not a real unique
violation. Whoever writes the real-connection test now has two paths to cover, not one, and the
vacuity trap above applies to both.

---

## S-39 · `x-tenant-id` has a canonical shared constant and two services still hold their own — **LOW, open**

T-046 promoted the header name to `@telemetry/shared-types` as
`TENANT_CONTEXT_HEADERS.TENANT_ID`, because `.claude/rules/constants.md` asks for promotion
*before* a third copy and billing-service would have been the third. Billing derives from the
shared constant and adds no literal of its own. **The two pre-existing copies were deliberately
not rewired:**

```
$ grep -rn '"x-tenant-id"' apps/*/src packages/*/src --include=*.ts | grep -v dist
apps/gateway/src/constants.ts:14:  TENANT_ID: "x-tenant-id",
apps/usage-service/src/constants.ts:16:  TENANT_ID: "x-tenant-id",
packages/shared-types/src/index.ts:87: * `grep -rn "x-tenant-id" apps/auth-service/src --include=*.ts` returns nothing. See
packages/shared-types/src/index.ts:104:	TENANT_ID: "x-tenant-id"
```

**Four lines, three definitions**: `:87` is this entry's own sibling grep inside a docblock,
matching itself — the self-match sub-pattern S-33 names. The executable copies are the other
three. An earlier revision of this block quoted three lines and put the canonical constant at
`:93`; both were falsified after it was written, by T-046's own Gate-6 LOW-2 fix lengthening that
docblock. Re-run the command rather than trusting the fence.

So there are three definitions of one wire-protocol string: one canonical, two legacy. All three
carry the same value today — checked, byte-identical.

**Why they were left.** Rewiring gateway and usage-service inside a billing-service feature task
puts two other services' constants in that task's diff, which is the same one-task-per-commit
objection that kept S-8 out of S-4 and out of T-037 — S-8 is closed and its id retired, and the
record is `docs/plans/s-008-timing-safe-internal-auth.md`. The promotion itself was the part that could
not wait, because the rule's threshold is about the *third* copy and T-046 was it.

**Why it is LOW rather than ignorable.** This is a header name the gateway **writes** and
usage-service **reads** — a producer/consumer pair resolving one wire contract through two
unrelated declarations. Nothing enforces that they agree. The failure mode is not subtle if it
happens (every proxied request loses its tenant context and the downstream guard rejects it), but
nothing would catch a one-character edit to either file before it shipped. Compare S-23, which is
the same shape for `REDIS_STREAM_NAME` between usage-service and worker-service, and S-19, where
the identical `app.tenant_id` duplication reached **six** copies before anyone named it.

**Fix direction:** point `apps/gateway/src/constants.ts:14` and
`apps/usage-service/src/constants.ts:16` at `TENANT_CONTEXT_HEADERS.TENANT_ID` in one change that
does nothing else, and delete the local literals. Value-identical, no behaviour change, and the
full gate re-proves it. Do it as its own task, or fold it into the next change that already owns
one of those two files — not opportunistically inside a third service's feature work.

---

## S-40 · `page` has no upper bound, so a query parameter reaches a `500` — the shape is declared three times across two services — **LOW, open**

Found as F-2 at T-046's Gate-5 QA and re-derived at that task's Gate-3 rework against a running
billing-service. **Not introduced by T-046**: billing mirrors usage-service's existing
declaration, which is what `CLAUDE.md` instruction 5 asks for — and that faithful mirroring is
also the reason fixing it inside T-046 would have left the platform worse, not better (below).

### What is declared

`grep -rn "page: z\." apps packages --include=*.ts`, excluding `dist/` and `tests/`, returns
**three** lines and no others:

| Site | `page` | `pageSize` |
|---|---|---|
| `apps/billing-service/src/validators/invoice-list.validator.ts:31` | `z.coerce.number().int().min(MIN_PAGE).default(DEFAULT_PAGE)` — **no `.max()`** | `.min(MIN_PAGE_SIZE).max(MAX_PAGE_SIZE)` |
| `apps/usage-service/src/validators/usage-summary.validator.ts:34` | the same against `USAGE_SUMMARY_CONSTANTS` — **no `.max()`** | `.min(...).max(...)` |
| `packages/shared-validation/src/index.ts:24` (`paginationSchema`) | `z.coerce.number().int().min(1)` — **no `.max()`** | `.min(1).max(100)` |

`pageSize` is bounded in all three; `page` in none. `grep -rn "MAX_PAGE\b" apps/*/src packages/*/src`
returns no match (exit 1) — the only constant of that family is `MAX_PAGE_SIZE`
(`apps/usage-service/src/constants.ts:61`, `apps/billing-service/src/constants.ts:200`), and both
services' `MIN_PAGE` is `1` (`:59`, `:198`).

The third declaration is inert today: `grep -rn "paginationSchema" apps packages --include=*.ts`
excluding `dist/` returns three lines — the declaration plus an import and a use inside
`packages/shared-validation/tests/unit.test.ts` — so no production code reads it. It is listed
because it is the obvious home for one bounded declaration, not because it is live.

The unbounded value is then multiplied into an offset:
`skip: (query.page - 1) * query.pageSize` in `listInvoices`
(`apps/billing-service/src/repositories/invoice.repository.ts`, located with
`grep -n "skip: (query.page - 1) \* query.pageSize"`). **That citation carries no line number on
purpose.** It read `:388`, then `:806` after T-048's Gate-3 Round 2 re-derived it; the grep
answered `:810` at T-048's Gate-4 Round 2, and at `a87d952` the statement was at `:658`. Four
numbers for one expression nobody moved — and this entry already said "cite it by the `skip:`
expression, not by line" and then cited it by line anyway. Also —
`apps/usage-service/src/repositories/usage.repository.ts:154` —
`const offset = (input.page - 1) * input.pageSize;` — bound into
`LIMIT ${input.pageSize} OFFSET ${offset}` at `:162`.

### What it does, measured against a running billing-service

A real process (`npx tsx src/index.ts`, `PORT=3105`, `DATABASE_URL` as `telemetry_app`,
`REDIS_URL` on db 12), driven with `curl` carrying a valid `X-Internal-Secret` and a valid
`X-Tenant-Id`:

| Request | Response |
|---|---|
| `?page=1` | `200 {"data":{"items":[],"total":0,"page":1,"pageSize":20}}` |
| `?page=1e17` | `200`, with `"page":100000000000000000` echoed back |
| `?page=1e18` | **`500 {"code":"INTERNAL_ERROR","message":"Internal server error"}`** |
| `?page=1e18&pageSize=1` | `200` — `skip` is `1e18 - 1`, still inside `int8` |
| `?page=1e18&pageSize=100` | `500` |
| `?page=9223372036854775807&pageSize=1` | `500` — plain decimal, so it is not an artefact of exponent notation |
| `?page=1e400`, `?page=Infinity` | `400 VALIDATION_ERROR` — `page: Expected integer, received float` |
| `?page=NaN` | `400` — `page: Expected number, received nan` |
| `?page=-1` | `400` — `page: Number must be greater than or equal to 1` |

So there is **no single bad page number**: the threshold is wherever `(page - 1) * pageSize`
leaves the signed 64-bit range, and it moves with `pageSize` — measured in both directions in
rows 4 and 5.

Verbatim from the process log for `?page=1e18`:

```
Unable to fit value 20000000000000000000 into a 64-bit signed integer for field `skip`
```

logged as `"Unexpected error in invoice list controller"` and preceded by
`"Tenant-scoped transaction failed and was rolled back"`. The error *class* was established
separately rather than read off that text: calling `invoice.findMany({ where, skip, take: 20 })`
straight through `@prisma/client` with `skip = 2e19` gives `PrismaClientValidationError`, with
`e instanceof Prisma.PrismaClientValidationError === true`. The `500` is written by the
controller's own non-`AppError` arm (`apps/billing-service/src/controllers/billing.controller.ts:72-74`),
so `registerGlobalErrorHandler` is never reached.

**The message is value-dependent — do not quote it as *the* error.** The numeral is whatever
`(page - 1) * pageSize` evaluated to, so reproduce the fault, not the string. The same probe with
`skip = Infinity` (what a large enough `page` produces once the multiplication overflows) returns
the same class and a different message, `` Argument `skip` is missing. ``, and the service answers
`500` either way.

**T-046's QA report quoted a third text — `Unable to fit value 2e+307 … for field 'skip'` — and
that observation is correct. An earlier revision of this entry said it "did not reproduce here for
any `page` value tried"; the sweep above simply did not try a value that produces it.** The probe
table jumps `1e18` → `9223372036854775807` → `1e400`, skipping the whole `1e19`–`1e307` band in
which QA's value sits. Re-measured at T-046's Gate-3 rework round 3 against a billing-service
process on port 3117 (`telemetry_app` DSN, Redis db 12, valid secret and tenant), `page=1e306`
logs QA's text **verbatim**:

```
?page=1e305 -> 500   Unable to fit value 1.9999999999999997e+306 into a 64-bit signed integer for field `skip`
?page=1e306 -> 500   Unable to fit value 2e+307 into a 64-bit signed integer for field `skip`
?page=1e307 -> 500   Argument `skip` is missing.
?page=1e308 -> 500   Argument `skip` is missing.
```

Measured in four forms, which is also the evidence for the value-dependence above: `?page=1e306`
(default `pageSize`), `?page=1e306&pageSize=20`, `?page=1e307&pageSize=2` and
`?page=2e306&pageSize=10` all log `2e+307`, while `?page=1e306&pageSize=1` logs `1e+306`. So the
numeral tracks the product and not `page`. QA reproduced the fault; the sweep that doubted them
missed the band. (Gate-6 finding MEDIUM-2.)

### It fails closed, and that is measured rather than reassurance

The `500` is 59 bytes — `content-length: 59`, body exactly
`{"code":"INTERNAL_ERROR","message":"Internal server error"}`. No error text, no query, no tenant
id, no stack. The Prisma message quoted above *does* carry the rendered query tree and the tenant
id, and it appears only in the server log. The transaction is opened (`withTenant` issues its
`set_config`) and rolled back; `"Invoice"` was at 0 rows before the probes and 0 after.

It is also unreachable unauthenticated, re-measured on the same process: `?page=1e18` with no
`X-Internal-Secret` is `401 UNAUTHORIZED`, and with the secret but no tenant header is
`401 TENANT_CONTEXT_MISSING`. Both guards run before the validator.

### usage-service: same declaration, different failure

usage-service's HTTP behaviour was **not** driven. What follows is the bind itself, measured
directly through Prisma against the same PostgreSQL:

| Bind | Result |
|---|---|
| ORM `findMany({ skip: 2e19 })` — billing's shape | `PrismaClientValidationError`, "Unable to fit value … `skip`" |
| raw ``Prisma.sql`SELECT 1 … LIMIT ${20} OFFSET ${2e19}` `` — usage's shape | `PrismaClientKnownRequestError` — ``Raw query failed. Code: `22003`. Message: `ERROR: bigint out of range` `` |
| the same raw form with `OFFSET ${1e17}` | succeeds, empty result |

Both error; neither returns wrong rows. (A raw `OFFSET` bind of `Infinity` does **not** error —
it returned the row, i.e. behaved as offset 0 — but `Infinity` never reaches either repository,
because `.int()` rejects it with `400` at the validator, measured above. Recorded so nobody
concludes from the middle row that the raw path always fails loudly.)

### Severity: LOW, with the argument and not just the grade

QA graded it LOW and this rework reaches the same grade independently. It costs a `500` where a
`400` belongs, plus a log line. It requires a caller who already holds the internal secret and a
valid tenant — in production, the gateway with a verified JWT. It discloses nothing, crosses no
tenant boundary, and costs one transaction opened and rolled back, which is no more than a
successful request costs, so it is not a cheap amplification either. What keeps it above a NIT is
that it is a *reachable* `500` on a customer-facing endpoint — it will read as an outage to
whoever watches error rates — and that the same unbounded shape is now declared in three places,
which is how S-19 and S-39 got to seven and three copies respectively (S-19 was six until T-042
added a third named constant).

### Why filed rather than fixed

Fixing only billing gives the platform two strictnesses for one request parameter, which is the
**S-23** shape — that entry opens *"the producer and the consumer resolve the same
operator-supplied value through schemas of different strictness"*. Weaker here than there:
`page` is a per-request client value each service handles independently, not one operator value
two services must agree on, so the consequence is an inconsistent API rather than a
producer/consumer disagreement. Fixing both puts usage-service's constants and validator inside a
billing feature commit, which is the objection **S-8** recorded for not having been folded into
S-4 — *"changing two other services' startup contracts inside a usage-service security fix breaks
the one-task-per-commit rule."* Both entries were re-read on this tree before being cited. S-8 has
since been closed and its id retired, so that quotation is no longer checkable against this file;
it is quoted verbatim in `docs/plans/s-008-timing-safe-internal-auth.md`, which is the record.

### Fix direction

Bound `page` once in `packages/shared-validation`'s `paginationSchema` — it already exists, it has
the same hole, and it has no production consumer to break — then have both services derive from it
and delete their local `page` declarations, adding a `MAX_PAGE` beside each service's existing
`MAX_PAGE_SIZE` if a per-service ceiling is wanted. Own it as its own task across both services.
Choose the bound deliberately rather than by arithmetic alone: any `MAX_PAGE` whose product with
`MAX_PAGE_SIZE` stays inside `2^63` closes the crash, but a far smaller ceiling — a page no honest
client can reach — closes it with room to spare and makes the `400` meaningful. Add a case per
service for the chosen bound; today neither the `400`s above nor the `500` is covered by any test.

---

## S-41 · BI16's redness under the tie-break mutation is not reproducible, and the cause is not established — **LOW, open**

Filed at T-046's Gate-3 rework answering Gate 5's `FAIL`, and rewritten at that task's rework
round 3 answering Gate 6's `CHANGES REQUESTED`. **Nothing user-facing is at risk and no production
code is implicated**: this is a *test-confidence* gap.

This entry is deliberately smaller than the three revisions before it. Each of those explained
*why* BI16 behaves as it does, and each explanation was refuted by the next gate on an unchanged
tree. What follows is only what has survived re-running.

### The instance

`apps/billing-service/tests/billing.integration.test.ts` **BI16** walks a 3-invoice fixture one
page at a time and asserts that three single-row pages yield three distinct ids. Two of the three
rows deliberately share `periodStart`; the `id` tie-break in `INVOICE_LIST_ORDER_BY`
(`apps/billing-service/src/repositories/invoice.repository.ts`) is what makes the order total.

The mutation, throughout: delete `{ [BILLING_INVOICE_LIST.SORT_FIELD_ID]: ... }` from that
constant, then run `pnpm --filter @telemetry/billing-service test`.

### What holds

- **`BU74c` (`apps/billing-service/tests/invoice.repository.unit.test.ts`) reddens under the
  mutation.** It held in every run where its own outcome was recorded — which is not every run:
  this task's 20-run exploratory series recorded BU74c individually in **14** of them, the other
  six recording only BI16. No gate has observed BU74c survive the mutation; that is weaker than
  "every run at every gate", and it is what the record supports.
  It asserts the `orderBy` argument against a Prisma mock and never reaches the database. **It is
  the guard.**
- **BI16 sometimes reddens and sometimes does not, on an unchanged tree and with a byte-identical
  mutation.** It has been characterised **five ways across four gates**: that it observes the
  consequence; that only BU74c reddens; that it stayed green; that it is red 7/7; and that it is
  state-dependent on row count. Four of those five rest on a measurement, in order: green once
  (Gate 3), red 7/7 (Gate 5, QA), a two-state split over 8 instrumented runs (the Gate-3 rework),
  and the **opposite** of that split in both states (Gate 6). Gate 6 also observed BI16 flip from
  green to red between two consecutive runs with nothing touched — no schema change, no fixture
  change, no row inserted or deleted. Gate 6's md5 checks establish that its runs and the rework's
  used the same file contents before and after the mutation.
- **Do not delete or weaken BI16's walk block on the strength of a green run.** That is the
  operative instruction and the reason this entry exists. A green BI16 is **not** evidence that
  the invoice list's tie-break is guarded; BU74c is.

### What is not established

**The cause.** Three things were proposed or observed and none of them resolved it. They are
listed as observations, not as a mechanism:

- **Row count in `"Invoice"` was proposed as the variable and then refuted.** The Gate-3 rework
  recorded 0 unrelated rows ⇒ green and 129 rows belonging to another tenant ⇒ red; Gate 6
  measured the opposite in both states.
- **Planner statistics move on their own.** Gate 6's green→red flip coincided with
  `pg_class.reltuples` for `"Invoice"` changing without anyone asking, i.e. an autoanalyze. That
  it coincided is measured; that it is the cause is not.
- **A per-`OFFSET` plan split was observed inside a single database state.** Gate 6 measured
  `OFFSET 0` getting
  `Limit -> Index Scan Backward using "Invoice_tenantId_periodStart_periodEnd_key"` while
  `OFFSET 1` and `OFFSET 2` got `Limit -> Sort -> Seq Scan`. BI16's walk issues exactly those
  three queries, so one walk can mix both plans and neither plan labels a run. That refuted the
  plan-per-state account the previous revision of this entry gave; it did not supply another.

Two smaller things that also remain unestablished:

- **The plan the suite's own connection actually used.** `auto_explain` is not available on this
  server, let alone loaded — `show shared_preload_libraries` is empty and
  `select count(*) from pg_available_extensions where name='auto_explain'` returns `0` — so every
  plan captured at any gate came from a separate `psql`/Prisma session reproducing the fixture's
  shape, not from the running case.
- **Which database state T-046's QA measured in.** Their report records 7/7 red; their state
  cannot be reconstructed.

### Consequences to act on

- **T-047 inherits this fixture and this repository.** Treat BU74c as the tie-break's guard.
- Do not delete BI16 because it was green. Do not add a comment explaining why it was green.
- If a future task needs BI16 to discriminate deterministically, the lever is the fixture or an
  assertion on the plan — not the assertion on the ids. Nothing in the suite reports which plan
  ran, and until something does, a run's outcome is not attributable.

### Relation to S-21 — weaker than it looks

S-21 is about **two independent guards where either alone is sufficient**, so reverting one defect
leaves its own suite green. This entry is about **one** guard whose redness is not reproducible.
The kinship is only that both are "a guard whose regression evidence is narrower than it reads";
the mechanisms are different and the fixes do not resemble each other. S-21's text was re-read on
this tree before being cited.

### This entry's own limitation

`"Invoice"` was `ANALYZE`d during the Gate-3 rework's probes — explicitly once, and by autovacuum
after 129 rows were inserted and deleted — and **the pre-probe `pg_class` values for the table
were not captured**, so that series' planner state cannot be pinned. Gate 6 confirmed this was the
right thing to have disclosed: it captured that baseline, and `pg_class` did move during its own
series. That does not make the statistics the cause — see above — it makes the missing baseline
the disclosure that mattered. What *was* checked for both series is that row contents were
restored (all five tables at 0, `Tenant` at 2, re-counted).

**Fix direction:** none needed in the code. What would close this is a way for an integration test
to assert the plan it got, at which point BI16's outcome becomes attributable and this entry can
record what the attribution is. Until then, the durable practice is the one every gate here
learned the expensive way: record the outcome, and do not write down the mechanism unless the
refuting case has been run.

---

## S-42 · `docs/epics/epic-7-worker-service.md`'s T-042 section diverges from the shipped code in six ways — **LOW, open**

The **fourth** sibling of S-29 (T-040 section), S-32 (T-041 section) and S-35 (T-043 section) in
the same file. A new id rather than an extension of any of them, for the reason S-32 records
about S-29: each of those titles is scoped to its own section, so folding this in would make one
of them false.

Line numbers below are against the shipped tree, re-derived with `grep -n` at T-042's **Gate-3
rework** — not at Gate 3, where the same claim was made and was false. The section runs from
`:206`.

**Why it was false, because it is this entry's own subject.** The first revision cited `:217`,
`:214-228`, `:226`, `:232` and `:234-248`, which were correct against the epic as it stood
*before* this task edited it. The same diff then inserted a six-line forward-reference block at
`:211-215`, pushing every one of them down — `:217`→`:223`, `:214-228`→`:219-236`, `:226`→`:232`,
`:232`→`:238`, `:234-248`→`:269-283`. The old `:234-248` landed inside the snippet and the
"What T-042 shipped" list, so the sentence saying the inherited-obligation block "is accurate"
pointed at text that is not that block. A citation falsified by the commit that writes it: S-33,
inside the entry family (S-29/S-32/S-35) whose subject is citation accuracy. Caught at Gate 4.

The durable fix is to cite by **anchor text** as well as by line, which is what the numbers below
now do, since the next insertion above them will move them again. The commands, re-runnable:

```
grep -n 'invoice-generation.job.ts'        docs/epics/epic-7-worker-service.md   # -> 208
grep -n 'getTenantsWithUnbilledUsage'      docs/epics/epic-7-worker-service.md   # -> 223 (and 248, the correction block)
awk 'NR>=206 && NR<=285 && /^```/ {print NR}' docs/epics/epic-7-worker-service.md  # -> 219, 236
grep -n 'tenantId, \.\.\.yesterday'        docs/epics/epic-7-worker-service.md   # -> 232
grep -n 'BullMQ handles retries'           docs/epics/epic-7-worker-service.md   # -> 238
grep -n 'Obligation inherited from T-043'  docs/epics/epic-7-worker-service.md   # -> 269
grep -n 'S-15 is why it is in both'        docs/epics/epic-7-worker-service.md   # -> 283
```

1. **`:208` names one file; the task shipped five.** The **File:** line is
   `apps/worker-service/src/jobs/invoice-generation.job.ts` alone. That file exists and holds the
   range maths and the loop, but the task also shipped
   `src/queues/invoice-generation.queue.ts` (the BullMQ topology),
   `src/services/billing-client.service.ts` (the HTTP call),
   `src/repositories/billing-enumeration.repository.ts` (the one caller of the resolver) and
   `prisma/migrations/v1_7_worker_billing_enumerator/migration.sql`. The migration is the largest
   and highest-blast-radius part of the change and the epic does not mention a database change at
   all. Same shape as S-32's `:151`, which named a file that did not exist.
2. **`:223`'s `getTenantsWithUnbilledUsage(yesterday)` cannot be written as the epic implies, and
   this is the load-bearing one.** Measured as `telemetry_app` — the role worker-service connected
   as until this task — with no tenant context:
   `SELECT DISTINCT "tenantId" FROM "UsageLine" WHERE billed = false` returns **0 rows**, and
   `SELECT count(*) FROM "Tenant"` returns **0**, because `current_setting('app.tenant_id', true)`
   is `NULL` when unset and `"tenantId" = NULL` is `NULL` for every row. The epic describes a
   query the platform's own isolation model forbids and mentions no exception. What it actually
   takes is a `SECURITY DEFINER` resolver, a `NOLOGIN` definer role, a targeted `FOR SELECT`
   policy, a fourth application role, and a two-step deploy.
3. **`:219-236`'s snippet is a free function closing over module scope.** `billingServiceUrl` and
   `env` are captured from nowhere; every collaborator in this service is constructor-injected
   `(redis, logger, env, …)`. This is S-32's recurring objection, now in a fourth section, and it
   is the third consecutive section to carry it.
4. **`:232`'s `{ tenantId, ...yesterday }` is only correct if `getPreviousDayRange()` returns
   exactly `periodStart` and `periodEnd`** — the names
   `apps/billing-service/src/validators/generate-invoice.validator.ts` requires. The epic never
   says what the helper returns. A helper returning `{ from, to }` or `{ start, end }` produces a
   `400 VALIDATION_ERROR` from a snippet that reads correct.
5. **`:238`'s "BullMQ handles retries with exponential backoff" is an option, not a default.**
   Retries and backoff are per-job `attempts`/`backoff` settings; without them a failed job is not
   retried at all. Stated as a property of the library when it is a property of the caller's
   configuration.
6. **No timeout, no error-status handling and no `bodyLimit` are mentioned** for a `fetch` into
   another service. `fetch` has no default timeout and the loop is sequential, so one hung
   billing-service would stall every tenant after it indefinitely. T-042 added
   `AbortSignal.timeout(...)`; the epic's snippet ignores the reply entirely, so a `500` from
   billing would be counted as a billed tenant.

**What is *not* wrong, recorded so a later reader does not "fix" it:** the inherited-obligation
block at `:269-283` (`> ### Obligation inherited from T-043`) is accurate, was written by T-043, and T-042 discharged it —
`await bullWorker.close()` is in `apps/worker-service/src/index.ts`'s shutdown handler, before
`streamConsumer.stop()`, asserted by `U87` in `tests/index.graceful-shutdown.unit.test.ts`. Its
claim that `grep -rn "bullmq" --include=package.json .` returned nothing was true when written and
is now false by design, which is the block doing its job rather than rotting.

**Four sibling entries for one file is the finding.** S-29, S-32, S-35 and this one say the same
thing about four different sections of `docs/epics/epic-7-worker-service.md` — which is now every
section from T-040 onward. The economical fix is one consolidated entry plus one pass over the
epic, but that retires three live ids, which this file's stability rule forbids, and it is a docs
task with its own review. Recorded rather than done.

**Fix direction:** decide contract-first in each case — correct the epic, or change the code and
say so. Do **not** "fix" any of them by editing a test: T-042's suites pin the shipped behaviour
deliberately, with the reasons inline. Pairs with S-15's wider point that the epic files are not a
reliable manifest.

---

## S-43 · The worker enumeration resolver converts "read a tenant you can name" into "read every tenant" — the precedent to check before the second one — **LOW, open**

Filed by T-042's Gate-4 review (MEDIUM-1) and re-measured at that task's Gate-3 rework. Not a
defect in anything shipped: the design was reviewed and accepted, and the review could not break
it. What was missing was an accurate statement of *what it widens*, in a place that is read before
the next service asks for the same exception.

**What `v1_7` grants, measured as `telemetry_worker_app` against two tenants seeded through
`DIRECT_DATABASE_URL` and deleted afterwards:**

```
1) no tenant context: SELECT id,"tenantId" FROM "UsageLine"            -> 0 rows
2) SELECT * FROM public.worker_resolve_tenants_with_unbilled_usage(    -> both tenant ids
     '2026-03-01T00:00:00.000Z','2026-04-01T00:00:00.000Z')
3) BEGIN; SELECT set_config('app.tenant_id','<id from step 2>',true);
   SELECT id,"tenantId" FROM "UsageLine"  -> that tenant's row
   SELECT id,"tenantId" FROM "Event"      -> that tenant's row
   UPDATE "UsageLine" SET billed = true WHERE "tenantId"='<that id>'   -> UPDATE 1
   ROLLBACK;
```

**Step 3 is unchanged from `telemetry_app`.** The same three statements as `telemetry_app`, with
the same id, returned the same rows and the same `UPDATE 1` in the same session — while
`telemetry_app` calling the resolver got
`ERROR: permission denied for function worker_resolve_tenants_with_unbilled_usage`. So the
resolver buys exactly step 2, and step 2 is the whole widening: **the ids no longer have to be
known.** "Read or write any tenant whose id you hold" becomes "enumerate every tenant with
unbilled usage, then read or write any of them".

**Why this is worth an id rather than a comment.** The claim that was shipped —
*"the only cross-tenant read it has is the resolver's `SETOF text`"* — is refuted by step 3, and
it was written beside the test that measures the *true* and narrower property: no cross-tenant
read **in a single statement with no tenant context set**. That is `I-E1`, it is a real
measurement, and it is not the same sentence. The corrected wording now lives in
`apps/worker-service/src/repositories/billing-enumeration.repository.ts` (§ *What this exception
widens, and what it does not*), in the release note, and in the `I-E1` comment. This entry exists
so the **next** resolver is measured against the same question rather than against the same
sentence.

**What actually bounds it, unchanged and verified at Gate 4 from the live catalog:** `EXECUTE` is
granted to `telemetry_worker_app` alone and revoked from `PUBLIC`, `telemetry_app` and
`telemetry_auth_app`; no application role is a member of `telemetry_worker_definer` (a 5×5
`pg_has_role` matrix returns `f` everywhere); the definer holds `SELECT` on `"UsageLine"` alone;
the function is `STABLE STRICT` with a pinned `search_path` and returns `SETOF text`.

**Before adding a second cross-tenant resolver, in any service:** say which of the two properties
you are granting — "can read rows for a tenant it names" (already true of every application role)
or "can learn which tenants exist" (this) — and grant the second to a role no other service shares.
Extend `apps/auth-service/tests/rls.integration.test.ts`'s exact-set assertion and the migration's
own catalog loop, both of which already fail on an unexpected `prosecdef` function.

**Fix direction:** none — this is a recorded precedent, not an open defect. Close it if the
platform ever gains a general answer (a tenant-registry service, say) that removes the need for
per-service enumeration exceptions.

---

## S-44 · Two T-042 residuals are recorded only in a release note, which is read once — **LOW, open**

Bundled under one id because they share a cause rather than a subject, on the S-25 precedent:
each is a known, accepted cost that lives only in `docs/releases/t-042-worker-billing-enumerator.md`
or in an `.env.example` comment. `CLAUDE.md` is explicit that `docs/plans/` is not a record, and a
release note is read at deploy time and not again.

### 1 · No index serves the enumeration predicate

The resolver's `WHERE` is `billed = false AND "periodStart" >= $1 AND "periodStart" < $2`, with
**no** `tenantId`. `"UsageLine"`'s two non-unique indexes are `(tenantId, periodStart, periodEnd)`
and `(tenantId, billed)`, so neither has a usable leading column for it.

**Not measured, and stated as not measured.** `"UsageLine"` is empty on every environment this has
run against, so `EXPLAIN` proves nothing about the plan at scale — this is a leading-column
observation. Do **not** add an index on the strength of it: the right shape depends on selectivity
nobody has, and a partial index on `billed = false` is the obvious candidate precisely because it
is the obvious candidate.

**Fix direction:** revisit when `"UsageLine"` holds representative data, measure the nightly call
with `EXPLAIN (ANALYZE, BUFFERS)`, and decide then. The job runs once a day, so a sequential scan
may simply be correct.

### 2 · `BILLING_SERVICE_URL` accepts any scheme

`apps/worker-service/src/config/env.ts` validates it with `z.string().url()`, which — measured
against zod 3.25.76, the version this workspace resolves — delegates to `new URL()` and therefore
accepts `"billing-service:3004"` and `"javascript:alert(1)"` as readily as
`"http://localhost:3004"`, rejecting only a relative or malformed value.

This matches `apps/gateway/src/config/env.ts:17` deliberately, and the match is the right call:
diverging one service's URL strictness from another's is the S-23/S-39 shape this repository has
now recorded twice. The `.env.example` and `env.ts` comments state the behaviour accurately.

**The residual is the purpose gap.** The field is `required` with no default specifically so that
a worker with no billing address fails at *module load* rather than at 02:00 on a path nobody
watches. A scheme that parses but cannot be fetched defers the failure to exactly 02:00, which is
the outcome the design was chosen to avoid.

**Fix direction:** decide it once for the platform, not per service — a shared URL fragment in
`@telemetry/shared-types` that both gateway and worker import, restricting the scheme to
`http:`/`https:`. Pairs with S-23 (one shared schema fragment so a third service cannot introduce
a third strictness). Do not tighten worker alone.

---

## S-45 · Usage landing in a window whose invoice already exists is never billed **by the job**, and the job reports success — **LOW, largely closed by the S-45 change; kept for the residuals**

> **Closed by the billing-service change reviewed in
> `docs/reviews/s-045-late-usage-absorption.md`, and this entry is kept for what that change
> deliberately did not do.** (The plan of the same name is context, not evidence: `CLAUDE.md`
> says a plan marks a task *started*, so it cannot carry "closed by" — review NIT.) Fix direction 1 below
> was taken: `findByPeriod`'s result is now a *branch*, not an early return. When an invoice
> exists for the period and unbilled usage remains, `BillingService` prices it and
> `InvoiceRepository.absorbLateUsage` adds it to that invoice in one transaction — line items
> appended (never merged), `totalAmount` raised by a SQL `{ increment }`, the rows marked
> billed through the same chunked helper `createDraftInvoice` uses. A non-`DRAFT` invoice is
> refused with `409 INVOICE_IMMUTABLE` and nothing is written. The response gains
> `absorbed: boolean` beside `created`, and the line count goes to billing's log line.
>
> **Confirmed red before the fix**, on the tree at `07ed02a`, which is the property this entry
> spent a paragraph demanding: `BI22` failed at `expected false to be true` on the late row's
> `billed`, and — with that assertion temporarily pinned to the defect so execution reached the
> next one — at `expected '12.5' to be '14.5'` on the invoice total. `BI23` failed
> `expected 200 to be 409`. Those are the two named red values this entry asked for, in the two
> places it asked for them.
>
> **Eight residuals, none of them the revenue loss:**
>
> 1. **worker's log line still prints only `created`** (plan D5, user-confirmed at Gate 2). The
>    job's summary does not count absorptions, so *worker's* observability cannot tell a
>    retro-billing from a no-op even though billing's can. worker-service was not touched by
>    this change. T-057 owns metrics.
> 2. **S-38 is not closed** — see its own entry; the lost-race arm now routes into the absorb
>    branch, which gives that path a second consumer and still no real-connection test.
> 3. **S-10 is not closed.** `"InvoiceLineItem"` RLS is still inert, so the application route is
>    still the entire tenant control on the line-item write. `BI9` stays as the marker.
> 4. **The isolation case cannot distinguish the two isolation layers. Minted as S-46** at this
>    change's Gate-4 review, because it is platform-wide rather than billing's. In short:
>    `BI24` stays green when the application tenant predicate is removed, since `"Invoice"` RLS
>    supplies the same answer. What *is* guarded, and by what, is stated in S-46 — briefly, the
>    structural "no `invoiceId` parameter" property is caught by **`BU98`** (the address) and
>    **`BU99`** (the line-item route), both named unit cases and both measured red under the
>    mutation that reintroduces the parameter; an earlier revision of this bullet credited grep
>    and `BU99` alone, having run only the integration suite.
> 5. **A re-run of an already-invoiced period can now answer `422` where it always answered
>    `200`** — an unstated contract change until this bullet, added at Gate 4 (review LOW-3).
>    Before the change, `findByPeriod !== null` returned `200` unconditionally; now the unbilled
>    read and both D1 refusals run first on that branch, so a late row carrying a `metricKey`
>    with no active meter raises `MeterNotFoundError` or `MeterCurrencyConflictError`. It is the
>    intended behaviour — `BU97` pins it, and a loud refusal beats silently skipping usage — but
>    the operational consequence is that worker's nightly job counts that tenant `failed: 1`:
>    `apps/worker-service/src/services/billing-client.service.ts` throws on any status that is
>    not `200`/`201` (re-read at Gate 4, the status check and the throw are there). Also written
>    into `BillingService`'s ordering docblock, which is where the ordering is explained.
>
>    **Two consequences this bullet did not state, added at the Gate-3 rework round 2 that
>    answered Gate-5 QA's G-1 — and one of QA's two is corrected here rather than copied.** Measured
>    against the real billing-service as a real process on `telemetry_app`, driven over HTTP,
>    with fixtures seeded and asserted through `DIRECT_DATABASE_URL`, plus the real
>    `runInvoiceGenerationJob` over the real `BillingEnumerationRepository` (as
>    `telemetry_worker_app`) at pinned `now` values. Fixtures removed afterwards; the five tables
>    back to `0`.
>
>    - **One unpriceable row blocks every other late row in the same window.** An invoice of
>      `10.000000` for `[2026-07-10, 2026-07-11)`, then two late rows inserted into that window —
>      one `unmetered.metric`, and one perfectly priceable `api.request` worth `6.000000`. The
>      call answers `422 METER_NOT_FOUND`, the invoice stays `10.000000` with its one line item,
>      and **both** rows stay `billed = false`. `readAndPrice` prices the whole set or refuses it,
>      so one unpriceable row holds the rest of that window's late usage hostage.
>    - **What an operator sees is one night's failures, and then nothing further.** QA's G-1
>      wrote this as a failure that "recurs every night, permanently"; that is refuted by the job
>      itself. `getPreviousDayRange` makes the window *yesterday*, so the job visits each window
>      exactly once. With the poisoned rows sitting in `[2026-07-10, 2026-07-11)`, runs at
>      `now = 2026-07-12T02:00:00.000Z` and `now = 2026-07-13T02:00:00.000Z` enumerated
>      `{tenants: 0, succeeded: 0, failed: 0}`. The window never moving back into range is *why*
>      the alarm does not repeat, not why it does. A nightly alarm **does** appear when the
>      *cause* persists rather than the row: unmetered rows seeded into `[07-12, 07-13)` and
>      `[07-13, 07-14)` produced `failed: 1` on both of those nights, and `tenants: 0` on the
>      night after. That is one failure per new window, and the already-failed window is still
>      never revisited. Scope of all of this: worker's nightly path, where `now` advances, **and
>      the attempt on which the enumeration succeeds**. A whole-job BullMQ retry re-runs the
>      *same* window — the `run` closure at `apps/worker-service/src/index.ts:267-272` passes
>      no `now`, so each
>      attempt takes its own clock, and `getPreviousDayRange` returned
>      `[2026-07-12, 2026-07-13)` at `2026-07-13T02:00`, `02:01` and `02:03` alike, so a 60 s
>      exponential backoff over `ATTEMPTS` = 3 cannot roll the window off the cron instant.
>      (It *can* roll if two attempts straddle midnight UTC: `23:59:30` and `00:01:30` on the
>      same probe returned different windows. Not reachable from the 02:00 schedule.)
>      **A retry does reach this arm, which an earlier revision of this bullet reasoned it did
>      not.** Measured with a real BullMQ `Queue`/`Worker` on Redis db 14 at the real
>      `WORKER_INVOICE_JOB.ATTEMPTS` = 3 and `BACKOFF_TYPE` = `exponential` (probe delay
>      shortened to 300 ms; the delay changes when the retry lands, not whether it lands),
>      driving the real `runInvoiceGenerationJob` over the real `BillingEnumerationRepository`
>      as `telemetry_worker_app` against a real billing-service on `telemetry_app`, with an
>      enumeration wrapper that throws a fixed number of times and then delegates:
>
>      | enumeration throws | attempt that reached the per-tenant loop | summary lines for the window |
>      |---|---|---|
>      | never | 1 | one — `{tenants: 1, succeeded: 0, failed: 1}` |
>      | once | **2** | one — same window, same figures |
>      | twice | **3** | one — same window, same figures |
>
>      So the `422` can be reported on a *retry* attempt rather than on the first, and the
>      premise behind the old wording — the job only rejects on enumeration failure, which
>      happens before any tenant call — is true and does not imply what it was used to imply.
>      **What the retry does not do is multiply the `failed: 1` line**, and that is a mutation
>      claim rather than an absence of evidence: the attempt that reaches the loop *resolves*
>      the job (a per-tenant failure is counted, not thrown), so there is no further retry.
>      Mutating the closure to reject when `summary.failed > 0` — which the shipped closure at
>      `apps/worker-service/src/index.ts:267-272` does **not** do — produced three
>      `{tenants: 1, succeeded: 0, failed: 1}` lines for one window and a job in state `failed`;
>      every unmutated configuration above produced exactly one. What an operator can see more
>      than once on that night is the separate `"Invoice generation job failed"` line from each
>      enumeration failure — measured at the boundary rather than extrapolated: an enumeration
>      that throws on all three attempts produced **3** of them and left the job in state
>      `failed`, with the per-tenant loop never reached. The `422` itself is announced once per
>      window and then never again.
>      Not probed: a *stalled*-job re-delivery, which BullMQ counts against the same attempt
>      budget and which could re-enter the loop for the same window.
>    - **Nothing clears it automatically, and adding the meter is not by itself enough.** Adding
>      the missing `Meter` and re-calling *that* window by hand returned
>      `200 {"absorbed":true}` and took the invoice `10.000000 -> 19.000000`, billing both late
>      rows (`api.request` 20 @ `10.000000`, `api.request` 12 @ `6.000000`, `unmetered.metric` 3 @
>      `3.000000`). The enumeration takes no view of meters and is window-scoped, so a priceable,
>      unbilled row left in `[07-10, 07-11)` was still `tenants: 0` at
>      `now = 2026-07-12T02:00:00.000Z`, and was billed only by a run pinned back to
>      `now = 2026-07-11T02:00:00.000Z`. Recovery therefore needs the fix **and** an out-of-band
>      call naming the original window. **The operator-facing version of these three bullets now
>      lives in `docs/releases/s-045-late-usage-absorption.md`** (Gate-6 decision D-C), because
>      this file is scoped to Claude Code sessions and the recovery is something a human performs
>      by hand. Note S-44's warning about the reverse arrangement: a note is read at deploy time
>      and not again, so the two are deliberately kept in both places rather than moved.
>
>    None of it is a regression — before this change both rows were equally unbilled, just
>    silently, so no money moves the wrong way and the direction is loud-not-silent, which is D1's
>    own argument. What changes is that the fix's benefit is withheld for that whole window, and
>    the loss is announced once rather than never.
>
> 6. **The absorb path's concurrency safety has no standing guard.** Gate-5 QA drove four
>    genuinely simultaneous `generate` calls at one invoice: exactly one `200 {"absorbed":true}`
>    and three `409 USAGE_LINES_CHANGED … (expected 2, marked 0)`, the invoice
>    `100.000000 -> 110.000000`, one line item summing `10.000000`, both rows billed. No
>    double-billing, no partial write. What produces that is the invoice row lock plus the
>    cross-chunk count assertion, and **no test exercises either under concurrency** —
>    `BU27b` ("sums the counts across chunks before comparing, never per chunk") pins where the
>    count assertion sits, and `BU98` pins `{ increment }`, both as call shapes rather than as
>    outcomes. Recorded rather than written, on the S-21 and S-38 precedent, and S-38's objection
>    applies directly: a naive `Promise.all` case can pass by serialising, so the vacuous form
>    must be made to fail first. **Worth writing when** the locking or the placement of the count
>    assertion changes; the form that would work is an assertion on the *final total*, which is
>    wrong if any absorber double-counts, whatever the interleaving.
> 7. **`{ increment }` is pinned as a Prisma call shape, not as SQL-side arithmetic.** `BU98`
>    asserts `{ increment }` appears in the call. A read-modify-write on a stale read, spelled as
>    `increment`, would still satisfy that, and `BI25`'s exactness cannot separate the two because
>    `Prisma.Decimal` is arbitrary-precision as well. The discriminator is a lost update, and QA
>    ran it: an owner connection held `UPDATE … SET "totalAmount" = "totalAmount" + 100` open under
>    `pg_sleep(3)`, the absorb blocked ~2.1 s on the locked row, and the committed result was
>    `1234667.123459` — the addition evaluated against the post-commit row, where a
>    read-modify-write would have produced `1234567.123459` and silently discarded the `+100`.
>    **Worth writing when** anything replaces `increment` or moves the update out of the
>    transaction. It was recorded instead because it costs ~3 s of real wall clock and a second
>    connection, which is the per-case budget trade S-36 records for the same reason.
> 8. **The `absorbed` flag's no-op/absorb distinction is not asserted end to end at the job
>    layer.** It is asserted at the route — `BU102`
>    (`tests/internal.controller.unit.test.ts`), and `BI3` and `BI8`, which both pin the response
>    envelope's key set including `absorbed` — and it was driven over real HTTP at Gate 5, where
>    the real `BillingClientService` consumed a live
>    `200 {"data":{"invoiceId":"…","absorbed":true}}` and the job reported
>    `succeeded: 1, failed: 0` with `created: false`. The added field is ignored and non-breaking,
>    measured on the wire rather than inferred from the
>    `as GenerateInvoiceResponseBody` cast. **Nothing standing asserts it**, and worker's consumer
>    reads `body?.data?.invoiceId ?? null` through that cast rather than a schema. **Worth writing
>    when** worker starts *reading* `absorbed`; while the consumer ignores it, a test would pin
>    the cast rather than the contract.
>
> Residuals 6-8 are QA's G-2, G-3 and G-4 (`docs/qa/s-045-late-usage-absorption.md` §8), recorded
> on the user's Gate-5 decision to record rather than guard. They are filed **here** rather than
> under S-46 because each is a property of *this* change — the absorb transaction's concurrency,
> its arithmetic, and its response field. S-46's subject is narrower and different: an integration
> test over an RLS-enabled table cannot isolate the application-layer *tenant predicate*, because
> the policy returns the same rows either way. None of these three is about tenant isolation or
> RLS, and filing them there would make that title false — the objection this file already records
> for keeping S-32 out of S-29.
>
> One accepted cost, stated rather than hidden: the unbilled query now runs on **every** re-run
> of an already-billed period (plan D7), so a nightly re-run costs one extra grouped read per
> tenant. `UsageLine` carries `UsageLine_tenantId_periodStart_periodEnd_idx` and
> `UsageLine_tenantId_billed_idx`, so the predicate has index candidates — **which is not a
> claim of index coverage**: the tables are empty on this tree and no `EXPLAIN` at volume was
> run, so the planner's actual choice is unmeasured.
>
> Everything below is the original finding, left as the record of how it was reproduced.

Found by Gate-5 QA of T-042 (F-2) by running the nightly job twice, and **re-reproduced
independently at that task's Gate-3 rework** before being written here. Nothing in the shipped
code is wrong against its own decisions; what is missing is that one of those decisions was taken
in one direction only and nothing records the other.

### The measured reproduction

One tenant, one `api.request` meter at `0.010000`, two unbilled `UsageLine` rows inside
`[2026-09-15, 2026-09-16)` (10 + 2 units). Seeded through `DIRECT_DATABASE_URL`, removed
afterwards. The **real** `@telemetry/billing-service` on port 3004 (`node --import tsx
src/index.ts`, `DATABASE_URL` = `telemetry_app`), driven by the **real**
`runInvoiceGenerationJob` with the real `BillingEnumerationRepository` (as
`telemetry_worker_app`) and the real `BillingClientService`, at a fixed
`now = 2026-09-16T02:00:00.000Z`.

```
run 1   SUMMARY {"periodStart":"2026-09-15T00:00:00.000Z","periodEnd":"2026-09-16T00:00:00.000Z",
                 "tenants":1,"succeeded":1,"failed":0}         per-tenant log: created:true
        Invoice  1 row, totalAmount 0.120000        InvoiceLineItem  1 row, 12.000000 / 0.120000
        UsageLine ...001 billed=t   ...002 billed=t

INSERT INTO "UsageLine" (... '...003', quantity 2, periodStart '2026-09-15 23:59:00', billed false)

run 2   SUMMARY {... "tenants":1,"succeeded":1,"failed":0}      per-tenant log: created:false
        Invoice  still 1 row, totalAmount still 0.120000        InvoiceLineItem still 1 row
        UsageLine ...003 billed=f          <- never priced, never marked

run 3   now = 2026-09-17T02:00:00.000Z, i.e. the next night
        SUMMARY {"periodStart":"2026-09-16T00:00:00.000Z","periodEnd":"2026-09-17T00:00:00.000Z",
                 "tenants":0,"succeeded":0,"failed":0}          <- never enumerated again
```

billing-service's own log carries the mechanism, once:
`grep -c "Invoice already exists for period" billing.log` → **1**, against one
`"Draft invoice generated"` from run 1.

"Never billed **by the job**" is the exact claim, and it is what was measured: the nightly path
has no window that will price the row again. A *manual* call with a different period does bill it,
at the cost recorded under fix direction 2 below. So the row is lost in both directions of the
scheduled path at once: **run 2 cannot bill it** because
`BillingService.generateInvoice` returns at step 2 — `findByPeriod` hits
`Invoice @@unique([tenantId, periodStart, periodEnd])` and returns `{ created: false }` *before*
`sumUnbilledByMetricKey` ever runs (`apps/billing-service/src/services/billing.service.ts`, the
ordering comment at `:38-48`, item 2, and the early return at `:75-82`) — and **run 3 never sees it**,
because the resolver's window has moved past its `periodStart`.

### Why it is reachable, not exotic

`apps/worker-service/src/validators/stream-message.validator.ts:261` sets
`periodStart: occurredAt`, so a `UsageLine`'s window is fixed by the *event's* timestamp and the
row is written whenever the consumer gets to it. Any lag between the two produces this: a stream
backlog, a worker restart, an `XAUTOCLAIM` recovery pass, or a dead-letter replay through
`POST /v1/internal/worker/replay`. The nightly job fires at 02:00 for a day that ended two hours
earlier, so the gap that has to be crossed is two hours of processing lag, not a day.

### The loss is silent, which is the part that matters

Run 2 returned `succeeded: 1, failed: 0` and logged `created: false` — the same line a re-run of
a genuinely complete day produces. Nothing distinguishes them. There is no metric until T-057, so
the job's `failed` counter is the only operator-facing signal and it is `0` in both cases. The row
stays `billed = false` in the database forever, where nothing reads it.

### What the plan decided, stated exactly

`docs/plans/t-042-invoice-generation-job.md` §2, decision **D5**, reasons about this endpoint in
one direction:

> **Re-running a day that is already billed is safe and does not double-invoice.**
> `BillingService.generateInvoice` checks `invoiceRepository.findByPeriod(periodStart,
> periodEnd)` and returns the existing invoice with `created: false` → `200` **before any
> further read**

and closes with

> **BullMQ retries cannot double-invoice** *through this path* […] it rests on billing's early
> return and its unique constraint, both of which are another service's code.

Both sentences are true, and the word "safe" is attached to "does not double-invoice", which is
the direction D5 examined. The other direction — a row that becomes billable *after* the invoice
exists — is not mentioned in D5, in the release note, or in either review. It is the same
mechanism read the other way round.

One universal in the shipped code was requalified in the same change rather than left standing:
`apps/worker-service/src/repositories/billing-enumeration.repository.ts`'s
`listTenantsWithUnbilledUsage` docblock said "an enumeration that is right cannot produce a
`200 { invoiceId: null }` for lack of usage". Literally true — run 2 returned an existing invoice
id, not `null` — and the property a reader takes from it ("enumerated ⇒ billed") is false, which
is the `.claude/rules/review-standards.md` § *Universals Must Cite Their Mutation* shape.

### Severity

**MEDIUM.** It is a revenue-loss path and it is silent, which is precisely the ranking T-045's
decision D1 already made in the other direction:

> an invoice that silently omits a metric is money quietly missing from a document that looks
> complete — and nothing downstream is built to notice. A refusal is money visibly missing from a
> queue, which somebody fixes.

That argument was made about a *metric* omitted from an invoice; this is a *row* omitted from one,
with the same "nothing downstream is built to notice". Not higher than MEDIUM because it needs a
second run against an already-invoiced window to occur at all, the data is not destroyed — the row
sits `billed = false` and can still be priced — and no invoice is ever wrong about what it
contains; it is only incomplete.

### Why it was not fixed at T-042

The fix is **billing-service's** step-2 early return, or a product decision about supplementary
invoices. Changing another service's behaviour inside a worker-service feature task is the
objection S-8 stated in its own words — "changing two other services' startup contracts inside a
usage-service security fix breaks the one-task-per-commit rule" — and which this file cites as
precedent at S-22 ("the same reason S-8 was not folded into S-4"), S-23, S-39 and S-40. S-8 has
since been closed and its id retired, so that quotation is no longer checkable against this file;
it is quoted verbatim in `docs/plans/s-008-timing-safe-internal-auth.md`, which is the record. T-042's
own §3 non-goals already list S-38 (billing's `P2002` re-read) on the same grounds, and note that
T-042 *increases* how often that path is reached without closing it. This is the same shape.

It is also not obviously a defect rather than a policy: re-opening a finalised invoice may be the
wrong answer commercially, and a supplementary invoice may be the right one. Nobody has decided,
and deciding it inside a worker task would be exactly the silent resolution `CLAUDE.md` tells
agents to refuse.

### Fix direction

**Scheduled, not merely open.** At T-042's Gate-6 decision the user chose option A — a
billing-service task opened for this immediately after T-042 commits — so the next task is this
one. That choice sets the *when*, not the *what*: the policy question below is still open and none
of the three directions is pre-selected by it.

Decide the policy first, then pick one of:

1. **Bill the late rows onto the existing invoice.** In `BillingService.generateInvoice`, move the
   `findByPeriod` result from an early *return* to a *branch*: still no second `Invoice` row, but
   run `sumUnbilledByMetricKey` and, if it finds anything, add line items to the existing invoice
   and mark those `UsageLine` rows billed. Needs a decision about a `DRAFT` invoice's totals
   changing after it was first produced, and about what happens once its status is not `DRAFT`.
2. **Supplementary invoice.** Leave the existing invoice alone and create a second one for the
   same period. `Invoice @@unique([tenantId, periodStart, periodEnd])` forbids that directly, so
   it needs a schema change — or a different period. **Measured, because it is what an operator
   would reach for today:** posting the same tenant with a *narrower* window that still contains
   the row (`2026-09-15T23:00:00.000Z` → `2026-09-16T00:00:00.000Z`) returned `201` with a new
   invoice id, billed the row (`billed=t`) and left two overlapping invoices — `0.120000` for
   `[09-15 00:00, 09-16 00:00)` and `0.020000` for `[09-15 23:00, 09-16 00:00)`. So recovery
   exists, it is manual, and it produces overlapping periods no consumer is built to read.
3. **Refuse and surface it.** Have billing answer something other than a plain `200` when an
   invoice exists *and* unbilled rows remain in the period, so the job can count it as a failure
   rather than a success. Smallest change, no schema movement, and it converts a silent loss into
   the "money visibly missing from a queue" T-045's D1 preferred — at the cost of a nightly alarm
   for a condition that may be routine.

**How a test would prove it, and how the obvious one passes vacuously.** The assertion has to be
on the **row**, not on the response: both the broken and the fixed path answer `200` with the same
invoice id, and the job's summary is `succeeded: 1, failed: 0` either way — measured above. So a
case that asserts the status code, the returned `invoiceId`, the summary, or even that the invoice
count stayed at 1, passes against the defect.

The second vacuous form is the fixture order. Run 1 above billed every row that existed when it
ran, so a test that seeds the late row *before* the first call does not exercise the ordering at
all and reports green. The case must be: seed, run, **then** insert, then run again, then assert the
late row's `billed` and the invoice's `totalAmount` both moved. And it must be confirmed red
against the current early return first — on this tree that is `billed=f` and `0.120000`, the two
values measured above.


---

## S-46 · An integration test over an RLS-enabled table cannot isolate the application-layer tenant predicate — RLS silently supplies the same answer — **LOW, open**

**Scope of the title, stated up front.** "Cannot" is measured on `absorbLateUsage` over
`"Invoice"`, with the masking mechanism then probed directly on `"UsageLine"` and `"Event"` as
well. It is *not* measured on the other five RLS-enabled tables; for those it is inference from
the policy shape, and it is labelled as such below.

`.claude/rules/tenant-isolation.md` requires **both** layers on every tenant-scoped query: an
explicit `tenantId` predicate **and** `withTenant`, "belt and braces — neither alone". The two
layers work. What no behavioural test in this repository can do is tell them apart: remove the
application predicate and the RLS policy returns the identical row set, so the suite stays green.
This is the evidentiary consequence of the rule, not an argument against it.

Minted at S-45's Gate-4 review, from billing's `InvoiceRepository.absorbLateUsage`, and scoped
**platform-wide** because the mechanism is the policy, not the method.

### Measured, on billing's absorb path

Each mutation applied to `src/`, **both** suites run, then reverted, and every touched file
re-`md5sum`ed to the value it held **immediately before that mutation**. A pre-versus-post
comparison rather than a recorded digest, deliberately: the *procedure* records no constant, so
there is nothing for a later commit to invalidate. (The paragraph below does record two digests —
that is the evidence for why the procedure changed, not part of the procedure.)

That wording is a fix, not a preference. An earlier revision of this paragraph pinned the
whole-tree form —
`find apps/billing-service/{src,tests} -name '*.ts' | sort | xargs md5sum | md5sum` back to
`b66221646429f79536053b3a13210ee2` — **not re-derivable, because that tree was never
committed** — which was this entry's own tree when it was written at
Gate 4 and was already wrong by Gate 5, because the LOW-1/LOW-2/LOW-3 fixes to
`tests/integration.constants.ts` and `src/constants.ts` landed in between. Filed by QA as **D-1**.
At the Gate-3 rework it was `bd2e4678666dd45ecca842ad6f65a78e`, and at round 3 of that rework —
two documentation-only edits later, a dead test constant deleted and one comment's stale count
re-measured — it is `1abc56428c270909884b3ac1f5170727`. **Neither is re-derivable once this
change is committed with anything else on top of it, and neither is asserted here as a live
invariant**; they are recorded as the history of a constant that moved three times inside one
task. QA ran the command before and after its own mutations and got the same value both times,
and every individual file matched its pre-mutation `md5sum`, so nothing
leaked — the defect was the recorded constant, not a dirty tree. The whole-tree digest is what goes
stale: it moves whenever any `.ts` under `apps/billing-service/{src,tests}` changes, mutation or
not — including a comment, which is what moved it the third time. That is **S-33**'s shape inside the file that records S-33, and S-33's fix direction names
re-runnable commands as the target, so this is that direction applied rather than restated.

Suites named because the first pass ran only the
integration one and drew a general conclusion from it — the defect this entry exists to describe,
committed while describing it.

Counts are against the **shipped** tree, 30 integration cases and 27 in the repository unit file.
The first three rows were also measured before `BI27` existed, at 29 and 27, with one fewer
integration failure in rows 2 and 3; re-measured after it landed rather than carried forward.

| Mutation | `billing.integration.test.ts` | `invoice.repository.unit.test.ts` |
|---|---|---|
| **A · Remove the tenant predicate entirely** — resolve with `findFirst({ where: { periodStart, periodEnd } })`, address the `update` by the id it returned | **30 passed / 0 failed** | 4 failed / 23 passed, but **mechanically** — `tx.invoice.findFirst is not a function`, the Prisma double having no `findFirst`. Not evidence. |
| **B · Reintroduce an `invoiceId` parameter**, write line items via `tx.invoiceLineItem.create({ data: { invoiceId: input.invoiceId, … } })` | 28 passed / 2 failed — `BI25` and `BI27`, both of which call the repository directly and no longer type-match. **`BI24` green** | **`BU99` red** — 1 failed / 26 passed |
| **C · Reintroduce it and address the *invoice* by it** — `findUniqueOrThrow`/`update` on `{ id: input.invoiceId }` | 28 passed / 2 failed (`BI25`, `BI27` again). **`BI24` green** | **`BU98` red** — `AssertionError: expected { id: undefined } to deeply equal { …(1) }`, the expected object being `tenantId_periodStart_periodEnd` |
| **D · Drop the tenant from the *write* only** — read stays on the compound unique, `update` addresses `{ id: existing.id }`. Same Prisma call surface, so the double answers and the unit red is genuine | **30 passed / 0 failed** | **`BU98` red** — `expected { Object (id) } to deeply equal { …(1) }`, 1 failed / 26 passed |

`BI24` is the two-tenant isolation case — two tenants holding invoices for the same period, one
absorbing. It is green under **all four**.

### Why: probed directly as `telemetry_app`

`pg_roles` first, because a passing RLS test proves nothing as a superuser: `telemetry_app` is
`rolsuper = f, rolbypassrls = f`. `pg_class` on `"Invoice"`: `relrowsecurity = t`,
`relforcerowsecurity = t`, one policy `invoice_tenant_isolation` (`polcmd = *`). Two invoices
seeded through `DIRECT_DATABASE_URL` sharing one period, one per tenant, then read back on a
`telemetry_app` connection:

```
ctx = tenant B, predicate on the period only  -> s46-probe-b   (B's row, and only B's)
ctx = tenant B, predicate incl. the tenant    -> s46-probe-b   (identical)
ctx = tenant A, predicate on the period only  -> s46-probe-a   (A's row, and only A's)
no tenant context, predicate on the period    -> (no rows)
ctx = tenant B, naming A's row by primary key -> (no rows)
```

The untenanted predicate and the tenanted one return the same row, under each tenant's context.
So the application predicate is **unobservable** through any query issued inside `withTenant` on
this table. Probe rows deleted by explicit id; `Invoice` back to 0.

**Three tables, not one — because a claim about "RLS-enabled tables" measured on one table is a
claim about one table.** The same probe was repeated on `"UsageLine"` (policy
`usage_line_tenant_isolation`, plus `usageline_worker_definer_read` from `v1_7`) and on `"Event"`,
seeded the same way through `DIRECT_DATABASE_URL`:

```
UsageLine  ctx = B, predicate on metricKey only  -> s46-ul-b   (B's row, and only B's)
UsageLine  ctx = B, predicate incl. the tenant   -> s46-ul-b   (identical)
UsageLine  ctx = A, predicate on metricKey only  -> s46-ul-a
UsageLine  no tenant context                     -> (no rows)
Event      ctx = B, predicate on eventType only  -> s46-ev-b
```

Rows deleted by explicit id afterwards; `Event` and `UsageLine` back to 0. The remaining five
RLS-enabled tables were **not** probed, and the extension to them is inference from the policy
shape — every one of the eight carries a single `current_setting('app.tenant_id')` policy — not
measurement. Say "measured on `Invoice`, `UsageLine` and `Event`" if the distinction matters.

### What *does* catch it, and this is the entry's whole value

The hazard is "**integration cannot isolate it**", not "nothing catches it". Stated as measured:

- **The realistic regressions are caught, by named unit cases.** `BU98` pins the *address*
  (compound unique carrying the bound tenant) and `BU99` pins the *route* (nested `create`, never
  `tx.invoiceLineItem.create`). Both went red above, on the mutations that reintroduce a
  caller-supplied `invoiceId` — which is the shape a real regression takes, because a foreign
  invoice has to be *named* from somewhere.
- **A predicate deletion that keeps the Prisma call surface is caught by `BU98`, and that was
  measured rather than assumed** — mutation D above, where the double answers normally and `BU98`
  fails on its own `where` assertion while the integration suite is 30/0. But it is a *shape*
  assertion, the same category as `U51` in S-28: it pins that the compound unique with the bound
  tenant is what gets sent, which is not the same as observing that sending anything else would
  reach another tenant's row.
- **Mutation A is caught by nothing behavioural.** Its unit reds were a missing double method,
  not an assertion.

So: **keep the predicate.** Do not delete one on the evidence that deleting it is green, and do
not read a green isolation suite as proof that the application layer is doing anything.

### Why this is neither S-10 nor S-28

Both checked by re-reading the entries at Gate 4, not from memory.

- **Not S-10.** S-10 is RLS `FORCE`d but never `ENABLE`d on `"RefreshToken"` — and, it notes,
  `"InvoiceLineItem"` has the same shape — so the policies there are *inert* and the application
  predicate is the **only** control. That is the opposite direction on different tables: this
  entry is about RLS being **enabled** and therefore **masking** the predicate.
  `pg_class.relrowsecurity` over `public`: `t` for `Event`, `ExportAudit`, `Invoice`, `Meter`,
  `MetricRollup`, `Tenant`, `UsageLine`, `User`; `f` for exactly `InvoiceLineItem` and
  `RefreshToken`, which are S-10's two.
- **Not S-28.** Its title is literally scoped to `UsageLine`, and folding a platform-wide entry
  under it would make that title false — the same objection this file records for keeping S-32
  out of S-29. The *causes* also differ: S-28's predicate is untestable because `UsageLine.eventId`
  is globally `@unique`, so the cross-tenant address is unrepresentable **under the schema**; here
  the address is perfectly representable and the policy is what hides its absence. S-28's own
  fix direction ("revisit if `eventId` loses its global `@unique`") does not apply.

Closest relative is **S-21**, whose title is that the S-18 regression suite *does not isolate the
fix it was written for*: two independent guards, either sufficient, so reverting one left that
suite 17/17 green. Same shape — a guard whose removal a suite cannot see — but a different
mechanism and a different suite, so it is a relation, not the same finding.

### Platform-wide, and it grows with each new repository

Eight of the ten application tables have RLS enabled (list above), and
`grep -rn "extends TenantScopedRepository" apps/*/src --include=*.ts`, filtered to lines beginning
`export class`, returns **four** subclasses: `UsageRepository`, `EventRepository`,
`MeterRepository`, `InvoiceRepository`. On the mechanism above, every query any of them issues
inside `withTenant` against one of those eight tables has this property — measured on three of the
eight, inferred for the rest. **Any future tenant-scoped repository test inherits it on the day it
is written**, which is the reason to record it once here rather than per service. Note the
unfiltered grep returns **9** lines and the `export class` filter leaves **4**; the other 5 are
docstring examples inside each copy of `base.repository.ts` (S-19 records the same trap, and the
same counts).

### Severity: LOW, argued

**Nothing is wrong today**, on the evidence available. RLS is genuinely enforcing — the role is
`NOSUPERUSER NOBYPASSRLS`, verified above rather than assumed, which is what
`.claude/rules/tenant-isolation.md` insists on — and on the path this entry was found from, the
predicate is present and the realistic regression shapes *are* caught by unit cases. Note what
that does **not** say: no audit of every tenant-scoped query on the platform was run here, and by
this entry's own argument an integration suite could not have told you if one were missing. So
"every query carries its predicate" is exactly the claim this entry says you cannot get from the
tests; it is not asserted.

The cost is evidentiary: a reviewer or an agent can take a green isolation suite as proof of a
layer it never exercised. Stated precisely, because mutation D refutes the blanket version — a
change that drops a predicate ships green **through the integration suite** (30/0 under mutations
A and D; B and C were 28/2, and both of those failures are direct repository callers failing to
type-match, not isolation outcomes), and whether anything catches it at all depends on whether a
unit *shape* case happens to cover the call it changed. Two do here (`BU98`, `BU99`); a repository
without them would have nothing.

**What would make it MEDIUM** — any of these, and none holds today: a tenant-scoped query issued
**outside** `withTenant` (auth-service's two pre-auth resolvers already do this, per S-19, though
they take no tenant-scoped predicate); a connection pooler that loses the transaction-local
`set_config`; a service connecting as a `BYPASSRLS` or table-owning role; or a new tenant-scoped
table shipped with RLS inert, which is S-10's shape and would leave the unobservable predicate as
the only control. Re-rate it if one lands.

**Fix direction.** There is no behavioural fix — the masking is the design working. What is
available is a **structural** test: assert the emitted SQL or the Prisma call shape carries the
tenant, as `BU98` does, rather than asserting an outcome. Concretely, when a tenant-scoped
repository gets an isolation case, pair it with a shape case, and say in the integration case's
comment that it pins the *outcome* and cannot pin the predicate. A stronger option, if anyone
wants a real behavioural guard: run one test as a role that is exempt from the policy — the
migration owner through `DIRECT_DATABASE_URL` — where the predicate becomes the only control and
its removal is observable. That was **not** built or attempted here; it is a suggestion, and it
would need care not to become a test that exercises a connection production never uses.

---

## S-47 · `docs/epics/epic-8-billing-service.md`'s T-047 section diverges from the shipped code in four ways — **LOW, open**

The billing-service sibling of S-29, S-32, S-35 and S-42, which record the same class of defect
in four *different sections* of `docs/epics/epic-7-worker-service.md`. A **new id** rather than an
extension of any of those: each of their titles is scoped to its own section and its own file, so
folding this in would make one of them false — the exact objection S-32 records for not having
been folded into S-29.

All four re-derived with `grep -n` against the working tree at T-047 Gate 3.

1. **`:115` — "File: `controllers/billing.controller.ts`".** A controller alone cannot deliver
   this. T-047 shipped a repository method, a service method, a param validator, a route
   registration and three constants alongside the controller handler — **3 new files and 13
   changed**, scoped to `apps/billing-service` and derived with
   `git status --porcelain apps/billing-service | grep -c '^??'` → 3 and the same command with
   `grep -c '^ M'` → 13. That count read **12** until Gate 5 caught it
   (`docs/qa/t-047-invoice-detail-endpoint.md`, F-1): this task's own Gate-4 rework added
   `tests/billing.controller.unit.test.ts` and the number was not re-derived afterwards, which is
   an S-33 instance landing inside the very file whose S-33 entry catalogues the pattern.
   Same defect as S-29's first item and S-32's first item.
2. **`:118` — "Fetch `Invoice` by `id` with `lineItems` included" carries no tenant predicate.**
   `.claude/rules/tenant-isolation.md` § *Required* is explicit: "Every tenant-scoped query
   carries an explicit `tenantId` predicate **and** runs inside `withTenant`. Belt and braces —
   neither alone." The shipped `findDetailById` carries it. Note also that "included" names
   Prisma's `include`, which returns every column of `"InvoiceLineItem"` — `invoiceId` today, and
   whatever the table gains later; the shipped code uses a nested `select` and `BU108` asserts
   `include` is absent.
3. **`:119` — "Verify `invoice.tenantId === req.tenantId`" is dead code, and implementing it would
   reverse a decision T-046 made deliberately.** Dead because the foreign row never arrives:
   measured at T-047 Gate 1 and **re-derived independently at Gate 3** as `telemetry_app`
   (`rolsuper=f, rolbypassrls=f`, read from `pg_roles`) under tenant B's context, `findFirst` for
   tenant A's invoice returned `null` **both** with and without the application tenant predicate
   (probes P1a/P1b). `pg_class` on the same connection: `"Invoice"` is `relrowsecurity = t` with
   the single policy `invoice_tenant_isolation`, and `"InvoiceLineItem"` is `relrowsecurity = f`
   with **zero** policies (S-10) — which is why the same bare read against the child table
   returned A's two line items with their amounts. So the
   comparison can only ever see `true`. And it requires **selecting `tenantId`**, which
   `INVOICE_HEADER_SELECT` excludes on purpose and which `BU75b` pins. T-047 filters in the
   `where` instead.
4. **`:122-136` — the response block declares no ordering for `lineItems` and takes no position on
   a repeated `metricKey`.** Not a contradiction; a silence. T-047's D1 (one JSON line per stored
   row) and D2 (`metricKey asc, id asc`) fill it. Worth recording because the silence is load
   bearing: one invoice really can carry two `api.request` lines at different unit prices —
   measured through the shipped repository at Gate 1, `unitPrice` 1 and 5 — since `absorbLateUsage`
   appends a tranche rather than merging it (S-45 D2).

**What the epic gets right**, stated so this entry is not read as "the section is worthless":
`:119`'s parenthetical "do not leak existence" is the correct requirement and the shipped code
meets it more strictly than the line asks — `BI29` asserts the unknown-id and foreign-id responses
are **deep-equal**, not merely both `404`. And the `:122-136` field list is exactly what shipped,
five line-item fields included.

**Five sibling entries for two epic files is itself the finding.** S-29, S-32, S-35, S-42 and this
one all say the same thing about different sections. The economical fix is one consolidated entry
plus one pass over both files, but that would retire four live ids, which this file's stability
rule forbids, and it is a docs task with its own review. Recorded rather than done.

**Fix direction:** correct `:115`, `:118` and `:119` in place, and add the ordering and
repeated-`metricKey` decisions to `:122-136` — or, if the epic files are to stay a historical
record of what was *specified*, add a forward reference under `:115` pointing at
`docs/plans/t-047-invoice-detail-endpoint.md` § 3.4. Do **not** "fix" any of them by editing a
test: T-047's suite pins the shipped behaviour deliberately, with the reasons inline. Pairs with
S-15's wider point that the epic files are not a reliable manifest.

---

## S-48 · The bare-`invoiceId` read is prevented by convention, and a two-line narrowing would make most of it a compile error — **LOW, open**

`"InvoiceLineItem"` has RLS `FORCE`d but never `ENABLE`d and carries no policy (S-10), so the
application layer is its **entire** tenant control. `InvoiceRepository` upholds that by exposing no
method that takes a bare `invoiceId`: line items are reached only as a nested `select` under an
`"Invoice"` the tenant already matched, and `BU109`
(`apps/billing-service/tests/invoice.repository.unit.test.ts`) asserts `tx.invoiceLineItem` is
never touched. That is a **convention plus one test**, not a type.

Measured at T-047's Gate 3 rework, four steps, each a `pnpm --filter @telemetry/billing-service
exec tsc --noEmit -p tsconfig.json` against the shipped tree (billing's `tsconfig.json` includes
`tests/**/*.ts`, so this is the whole package):

| Step | Edit | Result |
|---|---|---|
| A | `await tx.invoiceLineItem.findMany({ where: { invoiceId: id } })` inserted at the top of `findDetailById`'s `withTenant` callback | **compiles clean** — the convention is not mechanical today |
| B | A, plus `\| "invoiceLineItem"` added to `TransactionClient`'s `Omit` (`apps/billing-service/src/repositories/base.repository.ts`, the `type TransactionClient = Omit<PrismaClient, …>` declaration) | `error TS2339: Property 'invoiceLineItem' does not exist on type 'TransactionClient'` **on the step-A call itself**, inside `findDetailById`, **plus** `TS2345` at both `markUsageLinesBilled(tx, …)` call sites |
| C | B, plus the `tx` parameter of `markUsageLinesBilled` (`invoice.repository.ts`; `grep -n "markUsageLinesBilled"` finds the declaration — **no line number, by the entry's own advice**: it read `:407` when this row was written, `:555` after T-048's Gate-3 Round 2, and `:559` at that task's Gate-4 Round 2, three positions for a declaration nobody moved) narrowed to `Omit<Prisma.TransactionClient, "invoiceLineItem">` | both `TS2345` clear; **only** the intended `TS2339` remains |
| D | C with the step-A re-route removed — i.e. the two narrowings alone | typecheck clean, `Tests 207 passed (207)` |

**Cite this one by method and symbol, not by `file(line,col)`.** The `TS2339`'s reported position
is the step-A *mutation's own inserted line*, so it moves with anything above `findDetailById`:
`(733,16)` when this entry was first written, `(740,16)` when Gate 5 re-ran steps A and B
(`docs/qa/t-047-invoice-detail-endpoint.md`, F-2) and again when the Gate-5 rework re-ran them a
third time. What is **measured** is that the drift is below `:626`, because the two `TS2345` sites
were `:467` and `:626` in every run, and step C's parameter has read `:407` at every
measurement (by `grep -n`, not by having run step C each time); that it is
`findDetailById`'s docblock growing by seven lines at the Gate-4 rework is the obvious
explanation and is **inference, not measurement** — the intermediate revision was never committed,
so there is nothing to diff against. Re-derive the three shipped line numbers with
`grep -n "markUsageLinesBilled" apps/billing-service/src/repositories/invoice.repository.ts`
rather than trusting them. Error code, property name and type are the stable part of the citation;
the line is not.

So the complete change is **two lines** and no behaviour change, and it converts the code-level
re-route from a convention into `TS2339`.

**The limit, which matters more than the guarantee and was not stated when this was first
measured.** The narrowing binds `tx` — the `withTenant` callback parameter — and nothing else.
`TenantScopedRepository` holds `protected readonly prisma: PrismaClient`
(`base.repository.ts`), so with **both** narrowings in place,

```ts
await this.prisma.invoiceLineItem.findMany({ where: { invoiceId: id } });
```

inside that same method **compiles clean** — measured as step E, same command, no diagnostic.
That route is the worse of the two: it runs outside the transaction, so no
`set_config('app.tenant_id', …)` has been issued at all, and `"InvoiceLineItem"` has no policy to
fall back on. State the property as "a `tx.invoiceLineItem` re-route becomes `TS2339`", never as
"the bare-`invoiceId` read becomes unrepresentable".

**Why this is filed against S-19 rather than fixed in T-047.**
`apps/billing-service/src/repositories/base.repository.ts` is one of the five copies S-19 records.
Narrowing billing's copy alone adds a fifth way in which the five disagree, inside a read-endpoint
commit — the one-task-per-commit objection S-19 raises about itself. The property should be
decided once, for all five, by whoever unifies them. Recorded as its own id rather than folded
into S-19 for the reason S-32 and S-35 both give: S-19's title is scoped to *duplication and
drift*, and this is a missing type-level guarantee in the class, not an instance of the copies
having diverged.

**One design note for that task, reasoning rather than measurement:** the `Omit` member is
billing-specific, so a shared `@telemetry/shared-db` base cannot hard-code `"invoiceLineItem"`. It
would need the excluded-model set as a type parameter (or each service aliasing its own narrowed
`TransactionClient`), which is a larger decision than the two lines measured above and is exactly
why it belongs in the unification task rather than here.

### T-048 took this proposal — for the `invoice` delegate only, and the entry stays open

**What was taken.** T-048 applied the narrowing to `apps/billing-service/src/repositories/
base.repository.ts`, for the **`invoice`** delegate, in a **delegate-level** form rather than the
wholesale `Omit` this entry proposes:

```ts
export type TransactionClient = Omit<FullTransactionClient, "invoice"> & {
	invoice: Omit<FullTransactionClient["invoice"], InvoiceWriteMethod>;
};
```

**The two-line figure did not transfer, and that is measured, not argued.** Nothing reads
`tx.invoiceLineItem`, which is why a wholesale `| "invoiceLineItem"` works there. `tx.invoice` is
read by five methods. Step A of T-048's Gate-3 progression applied this entry's shape verbatim —
`| "invoice"` added to the `Omit` — and the same command this entry uses
(`pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json`, whole package)
returned **11 errors**: 7 × `TS2339`, of which **five are legitimate reads** (`findUnique :336`,
`findUniqueOrThrow :595`, `findMany :654`, `count :662`, `findFirst :740`, all pre-seam line
numbers) and two are the writers, plus 2 × `TS2345` and 2 × `TS7006`. The delegate-level form
plus the `markUsageLinesBilled` parameter narrowing this entry's step C already describes gives
**exactly 2** errors — the two writers — and **0** once they are rerouted through the seam, with
`Tests 213 passed (213)`.

An earlier revision of this paragraph, inherited from T-048's plan, said "7 × `TS2339` on
legitimate reads". That is an overcount of two: the 7 is the whole `TS2339` set. Corrected here
from the transcript.

**Why the entry stays open.** Three things are unchanged:

- **Step E reproduces for this delegate.** With the full narrowing in place,
  `this.prisma.invoice.update({ where: { id }, data: { … } })` inside a repository method added
  **zero** diagnostics. `this.prisma` is still a full `PrismaClient` and still runs outside the
  transaction with no `set_config('app.tenant_id', …)` issued at all — and that is the route
  `docs/epics/epic-8-billing-service.md` § *T-048*'s own snippet writes. State the property as
  "a `tx.invoice` write outside the seam becomes `TS2339`", never as "the unguarded write becomes
  unrepresentable".
- **The `invoiceLineItem` half is untouched.** `tx.invoiceLineItem` is still reachable and
  `BU109` is still the whole control on it. Steps A–D above stand as written.
- **The other four copies of `base.repository.ts` are untouched**, so this is still a decision
  taken in one service that ought to be taken once for all five. S-19 now records billing as a
  fourth variant with the new digest.

**What stands behind the property now, and what a regex census is worth.** `BU125`
(`apps/billing-service/tests/invoice.repository.unit.test.ts`) asserts that the cast forms it
**enumerates** occur exactly once across `apps/billing-service/src`, inside
`InvoiceRepository.invoiceDelegate`; `BU126` asserts the async-member census, the modifier of
every member, and that no member takes an `invoiceId` or `tenantId` parameter. Both go red under
the deliberate-bypass mutation (a third writer casting `tx` back) against
`tests/invoice.repository.unit.test.ts` alone **and** the whole package suite —
`Tests 2 failed | 211 passed (213)` for the package. The mutation **typechecks clean**, which is
the point: the cast compiles, and the census is what makes it visible.

**State that at the strength it holds: a census catches the forms it enumerates and nothing
else.** T-048's Gate-4 review refuted the first version of this paragraph by execution. `BU125`
then matched one spelling, `as unknown as FullTransactionClient`, and `BU126`'s member pattern
recognised `private` and no other modifier, so this writer —

```ts
protected async probeFinalizeEvasive(id: string): Promise<string> {
	return this.withTenant(async (tx) => {
		const row = await (/* tx.invoice widened to the full delegate type */).update({
			where: { id }, data: { status: "FINALIZED", finalizedAt: new Date() }, select: { id: true }
		});
		return row.id;
	});
}
```

passed typecheck (0 errors), lint (0 findings) and the whole package (**213 passed (213)**), while
writing the exact state the guard exists to forbid. Two independent holes composed: a
*delegate*-level cast needs no `unknown` hop and was unmatched, and a `protected` member landed in
**neither** expected list, so both `toEqual`s passed with it in the file.

Both were widened at Gate 3 Round 2 and the same writer was re-run: red in the single file
(`Tests 2 failed | 35 passed (37)`), red in the package (`Tests 2 failed | 211 passed (213)`), and
red **independently** — `vitest -t BU125` and `vitest -t BU126` each give `1 failed | 36 skipped`,
so neither depends on the other. `BU125` now enumerates four cast targets (`FullTransactionClient`,
`PrismaClient`, `Prisma.<Model>Delegate`, `any`, each with an optional `unknown` hop) and `BU126`
classifies by modifier text with a third list, asserted empty, for anything that is neither
`private` nor plain-public, plus an assertion that no `async` class *property* exists. A fifth cast
spelling, or a member shape neither pattern describes, is still missed. Do not restate this as
"every bypass is caught".

**One of the named-but-unmeasured forms has now been measured, and it walks past both censuses.**
At Gate 4 Round 2 a generic `reinterpret<T>(value: unknown): T` — the "helper that launders the
type" the test docblock already listed — was used inside an *existing* method, so no new class
member appears and no enumerated cast target follows an `as`: **0 diagnostics, 0 lint findings,
`BU125` green, `BU126` green**. What reddened was collateral from the behavioural doubles
(`BU16`/`BU17` with the writer in `tenantExists`, `BU98`/`BU99`/`BU127` in `absorbLateUsage`) —
a double failing on a missing mock, not a guard firing. This **confirms** the hedge rather than
refuting it; it is recorded so the next reviewer need not re-derive it, and so that "a fifth
spelling would be missed" is a measurement and not a disclaimer.

Note `BU125` matches on the casts' text, so **nothing in `src/` may spell those phrases in a
comment** or the census counts the comment (the S-33 self-match); the docblocks describe them
instead of quoting them.

**What no source census can reach: two further routes, both measured at the same review.** Filed
here rather than under a new id, on the reviewer's recommendation, because this entry is already
about exactly this property.

| Route | Measured | What sees it |
|---|---|---|
| The `prisma` **module singleton**, imported from any layer (`src/lib/prisma`, re-exported at `src/config/container.ts:5`, `:23`) | A free `probeServiceLayerFinalize` in `src/services/billing.service.ts` doing `prisma.invoice.update({ where: { id }, data: { status: "FINALIZED", … } })`: **0 diagnostics**, census file **37/37**, package **213/213** | Nothing. It needs no cast and touches no repository |
| `tx.$executeRaw` **inside** `withTenant` | `` tx.$executeRaw`UPDATE "Invoice" SET "status" = 'FINALIZED' WHERE "id" = ${id}` ``: **0 diagnostics** both as a new private method and inserted into `absorbLateUsage`'s existing body | `BU126` only if it arrives as a *new member*. Inside an existing method it is invisible to both censuses — the unit failures that variant produces are `TypeError: tx.$executeRaw is not a function` from the test double, not a guard. **The count depends on where inside the method it goes, so it is stated with its placement**: **7** (`BU98`, `BU99`, `BU100`, `BU101`, `BU123`, `BU124`, `BU127`) as the first statement of the `withTenant` callback, **4** (`BU98`, `BU99`, `BU101`, `BU127`) immediately after the seam call. Both at 0 diagnostics, both with `BU125` and `BU126` green |

`FullTransactionClient`'s `Omit` removes six `$`-methods and leaves **four**, enumerated from the
type itself with `ts.createProgram` + `checker.getPropertiesOfType` rather than read off the
`Omit`: `$executeRaw`, `$executeRawUnsafe`, `$queryRaw`, `$queryRawUnsafe`. The raw route is inside
the transaction, so the RLS context statement has already run, and **the tenant policy does bound
the raw `UPDATE` — executed, not read off the policy text**. Two tenants and two `DRAFT` invoices
seeded through `DIRECT_DATABASE_URL`, then one `psql` session as `telemetry_app` with
`rolsuper = false` and `rolbypassrls = false` read from `pg_roles` **on that connection**, inside a
single `ROLLBACK`ed transaction after `set_config('app.tenant_id', <A>, true)`:

| Raw statement, no application predicate | Rows |
|---|---|
| `UPDATE "Invoice" SET status='FINALIZED' WHERE id = <tenant **B**'s invoice>` | **0** |
| `UPDATE "Invoice" SET status='FINALIZED' WHERE id = <tenant **A**'s own invoice>` | **1** |
| `UPDATE "Invoice" SET currency='XXX'` — no `WHERE` at all | **1**, not 2 |

The second row is what makes the first non-vacuous, and the third is the blanket case. First
measured at T-048's Gate-4 Round 2 and re-derived independently at that task's Gate-3 rework
round 2, both times with the same three figures. So what this route bypasses is **the status
seam**, not tenant isolation: the same statement that RLS refuses across tenants is accepted on
the tenant's own row and takes it straight to `FINALIZED`. Scope: this table, this policy
(`invoice_tenant_isolation`, `FOR ALL`, tenant term only), one session, one role. `InvoiceLineItem`
has no policy at all (S-10) and is a different answer.

**One thing that did become mechanical.** `InvoiceWriteMethod`'s nine names were reasoning when
T-048 shipped them; they are now measured and guarded. The generated `InvoiceDelegate` at
`@prisma/client` 6.19.3 declares **18** string members (compiler API), the nine writers and nine
readers, and `base.repository.ts`'s `InvoiceDelegateSurfaceCensus` is a type-level equality that
fails `pnpm typecheck` if an upgrade adds, removes or renames any of them — mutated in both
directions, `error TS2344: Type 'false' does not satisfy the constraint 'true'` each time. It does
**not** decide whether a new member mutates; it removes the silence. S-49 is the standing entry for
that class of drift.

**Until then:** keep `BU109`, and keep the `findDetailById` docblock's account of the Prisma
suppression. They are the whole control **on the `invoiceLineItem` half**.

---

## S-49 · Nothing mechanically notices a Prisma upgrade that would invalidate the `InvoiceLineItem` statement suppression — **LOW, open**

`InvoiceLineItem` is the one tenant-scoped table on the platform the database does not protect:
`relrowsecurity = f` and **zero** policies (S-10), and no `tenantId` column to write one against.
Re-queried here:

```
$ psql -h localhost -U postgres -d telemetry -Atc "select c.relname, c.relrowsecurity,
    c.relforcerowsecurity, (select count(*) from pg_policy p where p.polrelid=c.oid)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('Invoice','InvoiceLineItem') order by 1;"
Invoice|t|t|1
InvoiceLineItem|f|t|0
```

So the *only* thing keeping `GET /v1/billing/invoices/:id` from returning another tenant's line
items is that `InvoiceRepository.findDetailById` reaches them through the `Invoice` relation, and
that **`@prisma/client` suppresses the child statement when the tenant-filtered parent read
misses**. That is a client behaviour. Nothing re-checks it when the client changes.

### The behaviour, with the command that establishes it

Measured at T-047's Gate-3 rework round 3 — independently of the Gate-1 and Gate-4 derivations, not
copied from them. A node script using the generated client with query logging
(`new PrismaClient({ datasources: { db: { url: <DATABASE_URL> } }, log: [{ emit: "event", level:
"query" }] })` plus `prisma.$on("query", …)`), issuing `findDetailById`'s exact nested select inside
`$transaction` after `SELECT set_config('app.tenant_id', $1, true)`, counting logged statements
containing `"InvoiceLineItem"`:

```
connection: [{"u":"telemetry_app","b":false,"s":false}]     <- current_user, rolbypassrls, rolsuper
R1 A asks for A's invoice       | result=invoice(lineItems=2) | totalStatements=5 | InvoiceLineItem=1
R2 B asks for A's invoice       | result=null                 | totalStatements=4 | InvoiceLineItem=0
R3 B, tenant predicate removed  | result=null                 | totalStatements=4 | InvoiceLineItem=0
R4 A asks for an unknown uuid   | result=null                 | totalStatements=4 | InvoiceLineItem=0
```

**1, 0, 0, 0** — the figures `findDetailById`'s docblock carries. The connection line is part of the
evidence: the read ran as `telemetry_app` with `rolbypassrls = false` and `rolsuper = false`, so
this is RLS as production sees it, per `.claude/rules/tenant-isolation.md`.

The same script, same connection, shows what the suppression is holding back:

```
P-bare  invoiceLineItem.findMany({ invoiceId: <A's invoice> }) as tenant B
        -> [{"metricKey":"api.request","amount":"10"},{"metricKey":"storage.gb","amount":"20"}]
P-count unfiltered as tenant B -> InvoiceLineItem: 3   Invoice: 1
```

The unfiltered count is bounded on the parent and unbounded on the child, on one connection.

**Scope it exactly.** This is a behaviour of **`@prisma/client` 6.19.3 on this schema** — not a
property of the schema, and not something the database enforces. Version re-derived from
`node_modules/@prisma/client/package.json` (`"version": "6.19.3"`) and from
`pnpm-lock.yaml` (`'@prisma/client@6.19.3'`).

### What would invalidate it

1. **A Prisma major bump.** The emitted plan for a nested relation select is not a documented
   contract.
2. **The `relationJoins` preview feature**, which changes the client to emit a real JOIN rather than
   two statements. It is **off**: `prisma/schema.prisma`'s `generator client` block is three lines
   (`generator client {` / `provider = "prisma-client-js"` / `}`) and declares no `previewFeatures`
   (`grep -n "previewFeatures" prisma/schema.prisma` → no match).

**One trigger is quieter than it looks.** `"@prisma/client": "^6.1.0"` is declared in **six**
manifests — `grep -rn '"@prisma/client"' apps/*/package.json packages/*/package.json` returns
analytics, auth, billing, gateway, usage and worker — and the caret resolves to 6.19.3 only in the
lockfile. A within-major client change therefore arrives on a `pnpm update` with **no manifest
edit at all**, so the reviewer of that PR sees a lockfile line and no reason to open a billing
docblock. The major bump and the `previewFeatures` edit are both visible; the lockfile refresh is
not.

### No test would catch the change, and here is the mutation that establishes the distinction

`BU109` (`apps/billing-service/tests/invoice.repository.unit.test.ts`) asserts that
`tx.invoiceLineItem`'s `findMany` / `findUnique` / `count` / `create` are never called. It catches a
**code-level** re-route and does not catch a **client-level** plan change, and the two halves are
established differently:

- **Code-level, measured.** Rewriting `findDetailById` to read the header alone and then issue
  `tx.invoiceLineItem.findMany({ where: { invoiceId: id } })` separately, then
  `pnpm --filter @telemetry/billing-service exec vitest run --reporter=verbose`:
  `Tests 4 failed | 203 passed (207)`, `Test Files 1 failed | 18 passed (19)` — **BU108, BU109,
  BU110, BU111**. Reverted; the file re-checksums identical.
- **Client-level, structural rather than measured.** There is no mutation to run, and that is the
  point: the source does not change when the client's plan does. `invoice.repository.unit.test.ts:3`
  imports `PrismaClient` as `import type`, and `:163` is
  `const prisma = { $transaction: transaction } as unknown as PrismaClient` — a hand-built object.
  So that suite constructs no `@prisma/client` runtime and issues no SQL; there is no emitted
  statement for any assertion in it to observe, whatever the client does.

**Not established:** that enabling `relationJoins` actually reddens anything. Doing so regenerates
the client for all six consumers, which is outside a comment-only round, so it was not run. The
expectation that a `LEFT JOIN LATERAL` names `"InvoiceLineItem"` in the parent's own statement — and
would therefore take the three miss rows from `0` to `1` — is **inference from the feature's
description, not a measurement**. Do not restate it as fact.

### Fix direction

One **integration** test — it must hold a real client against real PostgreSQL, since a double emits
no SQL — pinning the client's major version and all four statement counts together, so an
invalidating upgrade is red rather than silent. Concretely it should assert:

- `InvoiceLineItem`-naming statements are **1** for the own-tenant read **and** `0` for each of
  foreign, unknown and predicate-removed;
- the own-tenant read actually returned its line items (`lineItems.length === 2` against the
  fixture), and the total statement counts `5 / 4 / 4 / 4`;
- `@prisma/client`'s **major** version, read from its `package.json`. Pin the major, not `6.19.3`:
  an exact pin reddens on every patch bump for no semantic reason, which trains people to bump the
  literal.

**How it could pass vacuously, which is the part to get right.** If the query-log capture is never
wired — no `log: [{ emit: "event", level: "query" }]`, or `$on("query")` attached to a different
client instance — every count is `0`, and a test that asserts only the three *miss* rows passes
having measured nothing. Asserting the own-tenant `1` in the same case is what makes an empty log
fail. Likewise, a test that asserts only "foreign equals unknown" passes under any plan including a
JOIN, and a mis-seeded own-tenant fixture degenerates into a fourth miss case unless the returned
line items are asserted too. Write the vacuous form first and confirm it is green, then add the
assertions that make it red — the S-38 discipline.

### Severity

**LOW, argued, with the escalation condition named.** Nothing is wrong today: the four rows have
now been derived at three gates and the last derivation is above. Both *visible* triggers are
deliberate edits, and the docblock at `findDetailById` tells whoever makes them exactly which four
rows to re-measure.

It is not lower than LOW, and is recorded rather than waved off, because the consequence of missing
it is a cross-tenant read on the one table the database does not protect, and because the lockfile
path has no reviewer looking at this docblock at all. It becomes **MEDIUM** the moment either of
these is true: a second production path reads `InvoiceLineItem`, or an upgrade lands without the
four rows being re-derived in that PR. Today there is exactly one such path, and no direct call at
all: `grep -rn "invoiceLineItem\." apps/*/src --include=*.ts` returns **five** lines and **all five
are comments**, every one of them in `invoice.repository.ts` — three in `absorbLateUsage`'s
docblock and two in `findDetailById`'s (attributed by walking each match forward to the next
`async` declaration, not by eye). **The line numbers are gone from this entry on purpose.**
They have been written four times for five comments nobody moved: `:522`/`:537`/`:539`/`:699`/`:725`,
then `:625`/`:640`/`:642`/`:801`/`:827` on the tree that shipped T-048's first pass, then
`:671`/`:686`/`:688`/`:847`/`:873` from T-048's Gate-3 Round 2 — which were already stale by +4
when Gate-4 Round 2 re-ran the grep and got `:675`/`:690`/`:692`/`:851`/`:877`. **Five comments,
two docblocks, and the grep above are the durable part**; run it. Line items are reached
only through the `Invoice` relation — the nested `select` in `findDetailById` and the nested
`create` in `createDraftInvoice` — so `BU109` plus that docblock is the whole control.

Related but distinct, and deliberately a new id rather than an extension: **S-48** is about a
*type-level* guard on a `tx` re-route — a different mechanism and a different failure — and
**S-33** is about stale counts in comments, not about a dependency silently invalidating a measured
behaviour. **S-10** is the reason this matters at all and stays the underlying fix: give
`InvoiceLineItem` a policy and the client's plan stops being load-bearing.

---

## S-50 · The epic's T-048 snippet is "refused by this repository's shape" only in one of its three spellings, and the route it actually writes is one of several nothing guards — **LOW, open**

Same class as S-17, S-29, S-32, S-35 and S-47: a documentation claim that is stronger than the
code supports. Filed by T-048 and **verified at that task's Gate 3**, not carried over from its
plan.

`docs/epics/epic-8-billing-service.md` § *T-048*'s forward-reference block says the snippet's
`findById(id, tenantId)` / `update({ where: { id } })` signatures "are refused by this
repository's shape — no method takes a bare `invoiceId` or a caller-supplied tenant". The
sentence has real content — that *is* the convention, and it is the right convention — but
"refused by the shape" reads as a compiler property, and it is not one.

**Three probes, one dimension varied, each
`pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json` (billing's
`tsconfig.json` includes `tests/**`, so this is the whole package), each reverted:**

| Probe | Spelling | Result |
|---|---|---|
| 1 | `async probeFindById(id: string, tenantId: TenantId)` **declared**, the parameter not fed into `this.where` | **compiles clean, 0 errors** |
| 2 | the same, feeding it: `where: this.where({ id, tenantId })` | `error TS2322: Type 'TenantId' is not assignable to type 'undefined'` |
| 3 | the same, predicate built by hand: `where: { id, tenantId }` | **compiles clean, 0 errors** |

So what refuses the epic's signature is **one compile error at one call site**, produced by
`TenantScopedRepository.where`'s `{ tenantId?: never }` constraint, and it is routed around by
not calling `this.where` — which is exactly what the epic's snippet does. Declaring the parameter
is free. The shape does not refuse it.

**The sharper half: the snippet's write is a route the T-048 narrowing does not reach.** The
snippet ends `return this.prisma.invoice.update({ where: { id }, data })` — not `tx`. T-048
narrowed `TransactionClient` so that a `tx.invoice` write outside the guarded seam is `TS2339`,
and measured (S-48 step E, reproduced for this delegate) that the identical write through
`this.prisma` adds **zero** diagnostics. It also runs outside `withTenant`, so no
`set_config('app.tenant_id', …)` has been issued at all. The epic's own suggested code therefore
takes a route the task's structural guard does not close — which is worth writing down, because
the next reader of that section is the person who will write the finalize flow.

**An earlier revision of this entry, and of the epic block it is about, said "the single route"
and "the one route none of that reaches".** That was a universal, and T-048's Gate-4 review
refuted it with two more, both at 0 diagnostics: the `prisma` module singleton imported from any
layer, and `tx.$executeRaw` inside `withTenant`. Both are recorded in **S-48**'s route table
rather than here, so the count lives in one place; this entry keeps the epic-wording half. Read
that table before writing "the one route" anywhere — the honest form is "one of several, and the
list is the ones that have been probed".

**What did change at T-048, stated at measured strength.** `BU126`
(`apps/billing-service/tests/invoice.repository.unit.test.ts`) parses every `async` member's
parameter list out of `invoice.repository.ts` and fails on a member outside its named census or
on a parameter named `invoiceId` or `tenantId`. Probe 3 above — the spelling that compiles clean
— **reddens it**, measured against `tests/invoice.repository.unit.test.ts` alone
(`Tests 1 failed | 36 passed (37)`) and against the whole package suite
(`Tests 1 failed | 212 passed (213)`). Both of `BU126`'s halves catch it independently: with the
probe added to the census's expected list so the method-name assertion passes, the parameter
assertion still fails with
`probeFindById must not take tenantId: expected '(id: string, tenantId: TenantId)' not to contain 'tenantId'`.
So the convention is now guarded by a **test**, which the planning probe measured it was not
(an eighth method taking a bare `invoiceId` was added pre-T-048 and typecheck, lint and 207/207
stayed green). It is still **not** guarded by the compiler, and this entry is open for that
sentence in the epic rather than for the code.

**Credit where due**, and the reason this is LOW: that block is the epic's own forward reference,
added by S-45 before T-048 planned anything, and it warns the reader *before* the snippet rather
than after — which S-32 records as the fix direction for the T-041 section and which the T-040,
T-042 and T-043 sections do not do. Two of the three things it flags are correct. This entry is
about the third.

**Fix direction:** reword `epic-8-billing-service.md` § *T-048*'s "are refused by this
repository's shape" to what the probes measured — *"violate this repository's convention;
`this.where({ id, tenantId })` is a compile error, but declaring the parameter and building the
predicate by hand is not, and `BU126` is what catches it"* — and add one line noting that the
snippet's `this.prisma` write is outside the seam T-048 built. Do not delete the snippet: the
epic files are a record of what was specified (S-32). Pairs with S-29, S-32, S-35 and S-47, which
are the same defect in the T-040, T-041, T-043 and T-047 sections of the same and neighbouring
files; consolidating all five is a docs task with its own review, and this file's id-stability
rule forbids retiring the live ids to do it.

---

## S-51 · `BU126` censuses member *names*, so the natural response to it going red discharges it — **LOW, open**

`apps/billing-service/tests/invoice.repository.unit.test.ts`'s `BU126` asserts that
`InvoiceRepository`'s async members are exactly the names in `EXPECTED_PUBLIC_ASYNC_METHODS` and
`EXPECTED_PRIVATE_ASYNC_METHODS`, with a third list of unclassified members asserted empty. It is
a real tripwire — T-048's planning probe measured that an eighth method could be added pre-T-048
with typecheck, lint and 207/207 all green — and it notifies that the member set **changed**. It
does not assert the new member is safe.

**Measured at T-048's Gate 5 (QA F-1b):** with an unguarded `finalizeInvoice` present on the
repository and its name appended to `EXPECTED_PUBLIC_ASYNC_METHODS`, the package is
**213/213 with lint clean**. The red that `BU126` produces is
`expected [Array(7)] to deeply equal [Array(8)]`, and the one-line edit that clears it — append
the name — is both the obvious response and the one that discharges the guard. So `BU126` is a
**notification that the member set changed**, not a guard that the member set is guarded.

This is inherent to a name census and was not fixable inside T-048. What T-048 added instead, at
the user's direction, is one comment above `EXPECTED_PUBLIC_ASYNC_METHODS` telling whoever
appends a name what they are discharging, plus this entry.

**Two related measurements, filed here because they are the same "the guard reaches less than it
reads" shape and because S-48 is already long.**

- **The cast census counts `as`-form spellings, not cast targets.** All four
  `FULL_DELEGATE_CAST_PATTERNS` are anchored on `\bas\s+`, so an **angle-bracket type assertion**
  of `tx` through `unknown` to `FullTransactionClient` — the census's own first identifier,
  written verbatim in `src/` — is invisible to every one of them. Measured at T-048's Gate 6 and
  re-run at its Gate-3 Round 4 by inserting the assertion after the seam call in
  `absorbLateUsage` and taking the widened delegate's `updateMany`:
  `pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json` → **0 errors**;
  `pnpm --filter @telemetry/billing-service lint` → **0 findings**;
  `pnpm --filter @telemetry/billing-service exec vitest run tests/invoice.repository.unit.test.ts`
  → **37 passed (37)**, `BU125` and `BU126` both green; while
  `grep -rn "FullTransactionClient>" apps/billing-service/src` finds it. It is the cheapest
  evasion found across four gates, because unlike the delegate cast (Gate 4), `reinterpret<T>`
  (Gate 4 Round 2) and QA's annotation-plus-`as never` (Gate 5, E2) it changes **no** target and
  adds **no** member. Probe reverted from a copy; the tree carries none of it. Whether a sixth
  spelling exists is not established — four gates have each found one the previous had not, which
  is evidence the enumerated list is smaller than the space, not that it is now complete.
- **The `seedInvoices` figure is a census of a literal spelling** (QA F-4). The six `tests/`
  writes of a non-`DRAFT` status that T-048's scoped sentences now cite come from
  `grep -rEn "status: InvoiceStatus\.(FINALIZED|PAID)" apps/billing-service/tests` → **17** lines,
  six of them `seedInvoices` arguments. Extracting `BI23`'s fixture block into a parameterised
  helper — an ordinary refactor — takes 17 to 16 and the six to five while the number of tests
  seeding a non-`DRAFT` status is unchanged. It **under-reports silently**. Note the spelling of
  the command matters: the BRE form with escaped alternation and the `-E` form above both return
  17; an ERE pattern run without `-E` returns **0**.

**Fix direction.** For the member census: assert a *property* of each public member rather than
its name — for example that every public async member's body either reaches `draftInvoiceWriter`
or contains no `invoice` write — which is an AST question rather than a regex one, and belongs
with whichever task builds invoice finalization (it is the first task that will add a member and
meet the red). For the cast census: adding an angle-bracket pattern is one line and is a
test-logic change, deliberately not made at T-048's Gate-3 Round 4, which was text-only; the
probe above is the case that proves it red. For the `seedInvoices` figure: cite the helper and the
call sites by name rather than quoting a count, or count call sites with an AST pass.

**Do not close this by widening the lists.** Every widening so far has been correct and none has
changed the shape: a census over an enumerated set catches the members of that set. The shipped
docblocks say so — *"a regex census catches the forms it enumerates and nothing else"*,
*"a fifth spelling would still be missed"* — and this entry exists so the next person to append a
name to `EXPECTED_PUBLIC_ASYNC_METHODS` reads it before doing so.

---

## S-52 · The invoice seam reads with `findUniqueOrThrow` and writes with `update`, and takes no row lock — **LOW, open, latent**

`InvoiceRepository.draftInvoiceWriter` (`apps/billing-service/src/repositories/invoice.repository.ts`;
`grep -n "private async draftInvoiceWriter" apps/billing-service/src/repositories/invoice.repository.ts`)
reads the invoice with `findUniqueOrThrow` selecting `id` and `status`, refuses unless the status
is `BILLING_METERING.INVOICE_STATUS_DRAFT`, and returns the delegate the caller then writes
through. The read and the write are in one `withTenant` transaction and **nothing locks the row
between them**: `grep -rn "FOR UPDATE\|forUpdate\|isolationLevel" apps/billing-service/src`
returns **no lines**, and the database's `default_transaction_isolation` is **`read committed`**
(`psql -Atc "SHOW default_transaction_isolation"`). So two concurrent callers can each read
`DRAFT` and both proceed.

**Measured, not reasoned about.** One `DRAFT` invoice seeded through `DIRECT_DATABASE_URL` (the
owner), then two `psql` sessions **as `telemetry_app`**, each in a transaction that first issues
`set_config('app.tenant_id', <tenant>, true)` exactly as `withTenant` does. Session A read, wrote
`status = 'FINALIZED'`, slept 3 s and committed; session B started 1 s later:

| | Without `FOR UPDATE` (what ships) | With `FOR UPDATE` on the read |
|---|---|---|
| A's read | `DRAFT` | `DRAFT` |
| B's read | **`DRAFT`** — A's write is uncommitted, so B sees the old row | **blocks, then returns `FINALIZED`** |
| B's write | `UPDATE 1`, applied after A commits | `UPDATE 1` |
| Final row | `FINALIZED`, `totalAmount` 10 → 60 | `FINALIZED`, `totalAmount` 10 → 60 |

The load-bearing cell is B's read. Unlocked, it returns `DRAFT`, so a seam checking that value
proceeds and its write lands on a row that is `FINALIZED` by the time the write executes — B's
`UPDATE` blocks on A's row lock, then applies to the updated row rather than re-checking it.
Locked, the same read under the same timing returns `FINALIZED`, which is the value a seam needs
to refuse. The probe rows were deleted and `Invoice` and `InvoiceLineItem` re-checked at **0**.
Scope: one table, one host, PostgreSQL's `read committed` default, two sessions, this timing —
the `FOR UPDATE` column shows the read *returns* the post-commit value, not that any shipped code
consumes it.

**Why this is latent and not live.** Nothing in `apps/*/src`, `packages/*/src` or `prisma` writes
a non-`DRAFT` status — the standing census
(`grep -rn "FINALIZED\|PAID\|finalizedAt" apps/*/src packages/*/src prisma --include=*.ts
--include=*.prisma --include=*.sql | grep -v dist`, 19 matching lines, **zero assignments**) is
the evidence, and `tests/` reaches the state only through `seedInvoices` on the owner connection.
The only two writers that address an existing invoice are `absorbLateUsage`'s `update` and the
seam itself, and neither can produce the status the interleaving needs. So the second half of the
race has no producer today.

**What would make it live:** the first statement anywhere in `src/` that sets `Invoice.status` to
`FINALIZED` or `PAID` — invoice issuance, which is declared and unbuilt. At that moment
finalization and late-usage absorption race on the same row, and the outcome measured above is a
line item appended to an issued invoice with the guard having passed.

**Sibling of S-38**, which records the same shape on the `P2002` path in the same file: a
concurrency property that is correct by construction today, has no standing test, and whose
obvious test passes vacuously. **S-38's vacuity trap applies verbatim** — a `Promise.all` over two
`absorbLateUsage` calls is green whether or not the two transactions overlapped, because a
serialised pair produces the same observable result. Whoever writes it must prove the overlap
(advisory locks, a `pg_sleep` inside one transaction, or asserting on the block itself) and must
show the case red against the unlocked seam first.

**Not fixed at T-048**, which was a text-only round; adding a lock is production behaviour with
its own deadlock-ordering question and needs its own plan.

**Fix direction:** have the seam take the row lock it already relies on — a
`SELECT … FOR UPDATE` on the invoice before the status check, which on this codebase means
`tx.$queryRaw` with `Prisma.sql` and a bound id (Prisma's fluent API has no `FOR UPDATE`), or an
optimistic `updateMany` whose `where` carries `status: DRAFT` and whose `count` of `0` is the
refusal. The second needs no raw SQL and no lock ordering, and is worth costing first. Decide it
with whichever task builds finalization, not before: a lock added now guards an interleaving
nothing can currently produce.

---

## S-53 · `docs/epics/epic-9-analytics-service.md`'s rollup snippet applies `AT TIME ZONE 'UTC'` to the column, which is the mistake `CLAUDE.md` names — **LOW, open**

Filed by S-8, which found it while checking that its own change touched no timestamp path. Same
class as S-17, S-29, S-32, S-35, S-42, S-47 and S-50 — an epic snippet that diverges from what the
code must do — and recorded here rather than by editing the epic, matching that precedent.

`docs/epics/epic-9-analytics-service.md:61` specifies (it was `:59` when this entry was filed; the Q3 ruling added two lines above it — re-run
`grep -n "AT TIME ZONE" docs/epics/epic-9-analytics-service.md` rather than trusting the
number, and note that grep now returns **two** lines, the snippet and the Q3 pointer at `:15`
that says not to write it):

```sql
DATE_TRUNC('day', period_start AT TIME ZONE 'UTC') AS bucket_start
```

`CLAUDE.md` § *Raw SQL and timestamps* is explicit that `AT TIME ZONE 'UTC'` on a bound
**parameter** is correct, and on the **column** produces a `timestamptz` and shifts every bucket
boundary by the server offset. This snippet writes the column form.

**Verified live on this host's PostgreSQL 16**, through `DIRECT_DATABASE_URL`, session zone set
with `options=-c timezone=…`. No table was touched; the probe evaluates literals. One naive
`timestamp(3)` value, `2026-01-01 03:00:00`, truncated to the day:

| Session `TimeZone` | `DATE_TRUNC('day', col AT TIME ZONE 'UTC')` | `DATE_TRUNC('day', col)` |
|---|---|---|
| `UTC` | `2026-01-01 00:00:00+00` | `2026-01-01 00:00:00` |
| `Asia/Kolkata` | `2026-01-01 00:00:00+05:30` | `2026-01-01 00:00:00` |
| `America/New_York` | **`2025-12-31 00:00:00-05`** | `2026-01-01 00:00:00` |

So under `America/New_York` the snippet's expression buckets that row into the **previous day**,
while the bare column is stable across all three zones tried. Scope of the measurement: three
session zones, one value, this host's PostgreSQL 16. Not measured: other zones, DST boundaries, or
any granularity other than `day`.

**Why this is worth an id rather than a note.** T-051 is the task that builds analytics' rollups,
and this snippet is what it will be built from. A bucket-boundary error of this shape is silent —
every query succeeds, every total is plausible, and the only symptom is that a customer's usage
appears on the wrong day. It is also **not** caught by CI: `postgres:16-alpine` defaults `TimeZone`
to `UTC`, where the two expressions above are identical. That is the same reason S-18's regression
suite has to pin its own non-UTC session.

**Two further defects in the same snippet**, found while verifying it and recorded so T-051 does
not copy them either.

**Every identifier in it is snake_case, and nothing in this database is.** The snippet writes
`metric_key`, `period_start`, `period_end`, `tenant_id` and `FROM usage_lines`. `grep -n "@@map\|@map"
prisma/schema.prisma` returns **nothing**, so Prisma emits the model names and field names
verbatim as quoted identifiers; `information_schema.tables` for `table_schema='public'` lists
`UsageLine`, not `usage_lines`, and the real columns are `metricKey`, `periodStart`, `periodEnd`,
`tenantId` and `billed` (`prisma/schema.prisma`, `model UsageLine`). Unquoted `usage_lines` and
`period_start` would be folded to lower case by PostgreSQL and match nothing, so the snippet
raises rather than returning wrong rows — the loud failure, which is why this half is a
copy-and-fix nuisance rather than a hazard. `bucketStart` is `MetricRollup`'s column, and that
model has no `@@map` either.

**The `$2`/`$3` predicate is S-18 on the other side of the same query.** `periodStart` and
`periodEnd` are naive `timestamp(3)` columns like every other application timestamp on this
platform, so `AND period_start >= $2` with a bound JS `Date` resolves through the session zone.
`CLAUDE.md` § *Raw SQL and timestamps* covers this and analytics-service's
`base.repository.ts` does **not** carry the `set_config('TimeZone','UTC',true)` pin that
usage-service's does (S-19). So a T-051 built from this snippet inherits the hazard twice: once in
the projection, which this entry is about, and once in the predicate.

**Fix direction:** decide contract-first — correct the epic snippet to `DATE_TRUNC('day',
"periodStart")` with the real column names, or, if a different projection is intended, say what it
is and why. Whichever T-051 does, the guard it needs is a test that pins its own non-UTC session,
because a UTC-only fixture asserts nothing here. Do not "fix" this by moving `AT TIME ZONE` to the
bound parameter and leaving the column expression — the bound side is already correct and is not
what this entry is about.

**Disposition under the Q3 ruling — the choice this entry asked for has been made, and it is the
narrower of the two.** Q3 is now recorded **decided: fixed UTC for every tenant**
(`docs/epics/README.md` § *Q3 — UTC aggregation timezone*, and the gates table there). That
settles the contract-first question above in favour of **correcting the epic snippet**, not the
code: the projection is `DATE_TRUNC('<unit>', "periodStart")` on the bare naive column, with no
`AT TIME ZONE` anywhere in it. So the remaining work on this half is a one-line edit to
`docs/epics/epic-9-analytics-service.md:61` (the snippet line; re-derive it, it has already moved once).

**That edit was deliberately not made when the ruling was recorded, and this entry stays open
because of it.** It belongs to **T-051**, the task that builds the rollup, for the reason S-29,
S-32, S-35, S-42, S-47 and S-50 all give: an epic snippet is corrected by the task that
implements it, so the correction and the code that proves it land in one commit. Editing the
snippet from a docs-only change would leave a corrected epic with nothing standing behind it.

Three things in this entry are **not** discharged by the ruling and are still T-051's to handle:
the snake_case identifiers, the `$2`/`$3` bound-parameter half (which is S-18 and is about the
predicate, not the projection), and the requirement that whatever T-051 writes be guarded by a
test pinning its own non-UTC session — a UTC-only fixture asserts nothing here, and
`postgres:16-alpine` defaults to `UTC`.


---

## S-54 · `internalApiSecretSchema` has no maximum length, so an over-long secret starts every service and then fails in traffic — **LOW, open**

Filed by S-8's Gate-5 QA (F-4) and re-measured at that task's Gate-3 rework rather than inherited.
**This is the only `INTERNAL_API_SECRET` failure class QA found that shows up in request traffic
rather than at startup**, which matters because moving every other class to startup is the property
S-8 exists to establish. Stated as what was searched, not as a proof of exhaustiveness: the
evidence is S-8's Gate-5 sweep of 400 random printable-ASCII candidates of length 32-200, every one
accepted by the fragment, every one round-tripping byte-identically through the real proxy with
`round-trip mismatches: 0` and `non-200 statuses: 0`. That sweep's own length band tops out at 200,
so it could not have found this one; what else it could not have found has not been established,
and nobody has run a mutation that would produce a second in-traffic class. It is not a regression — the pre-S-8 `.min(32)` had no ceiling either — and no value
configured in this repository is anywhere near it.

**Where the missing bound is.** `internalApiSecretSchema` in `packages/shared-validation/src/index.ts`
is `.trim().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH).regex(SECRET_PATTERN, …)` — no `.max()`.
All four services derive their `INTERNAL_API_SECRET` field from that one object
(`grep -n 'INTERNAL_API_SECRET:' apps/gateway/src/config/env.ts apps/usage-service/src/config/env.ts apps/worker-service/src/config/env.ts apps/billing-service/src/config/env.ts`
→ four hits, all `internalApiSecretSchema`), so a ceiling added there is inherited by all four and
nowhere else needs editing.

**Measured, this host, Node 22.22.2, fastify 5.10.0, against the real billing guard behind a real
`node:http` client.** Secrets are `"a".repeat(n)`, i.e. printable ASCII, so every one of them is
accepted by the shipped fragment:

```
node http.maxHeaderSize = 16384
len=    32  fragment=ACCEPT  status=200  upstreamSaw=len 32    roundTrips=true
len=  8192  fragment=ACCEPT  status=200  upstreamSaw=len 8192  roundTrips=true
len= 16384  fragment=ACCEPT  status=431  upstreamSaw=NOTHING   roundTrips=false
len= 65536  fragment=ACCEPT  status=431  upstreamSaw=NOTHING   roundTrips=false
```

And the services do start on such a value — driven against the four **real** env modules with
`INTERNAL_API_SECRET` set to `"a".repeat(16384)` (gateway through `loadEnv()`, which is where it
parses):

```
gateway  BOOT  parsedLen=16384
usage    BOOT  parsedLen=16384
worker   BOOT  parsedLen=16384
billing  BOOT  parsedLen=16384
```

So: healthy-looking services, and `431 Request Header Fields Too Large` on every request that
carries the header.

**Two refinements on the QA figure, both from a grid scan rather than a single length.** Each cell
is the client-visible outcome for a secret of that length, with an additional `x-filler` header of
the stated size:

```
filler=    0   32:200  4096:200  8192:200  12288:200  15360:200  16000:200  16384:431  32768:ECONNRESET
filler= 1024   32:200  4096:200  8192:200  12288:200  15360:431  16000:ECONNRESET  16384:431  32768:ECONNRESET
filler= 4096   32:200  4096:200  8192:200  12288:431  15360:ECONNRESET  16000:431  16384:ECONNRESET  32768:431
```

1. **The budget is the whole header block, not this one field.** A 12 288-byte secret returns `200`
   with no other header and `431` alongside a 4 KiB sibling. So no per-field ceiling can be derived
   from `maxHeaderSize` alone; it has to leave headroom for everything else on the request, which on
   a proxied path includes `x-tenant-id`, `x-user-id`, `x-user-role`, tracing headers and whatever
   the client sent.
2. **The failure is not always `431`.** Above the threshold the client sometimes sees the connection
   reset (`ECONNRESET`) with no HTTP response at all. Both mean the upstream never sees the request;
   they are not the same thing to observe. A bisection over this boundary was run first and was
   **not** monotone — `16276 → 200`, and `16277 → 200` after the search had already concluded — so
   do not quote a single exact threshold from this host. The grid is what is claimed.

**What a defensible ceiling would be, and why it is a decision rather than an obvious number.**
Node's default `http.maxHeaderSize` is 16 384 bytes on this host (`node -p "require('node:http').maxHeaderSize"`),
and it is the *total* block budget, so a per-field `.max()` wants to be well under it — something in
the 512–1 024 range covers every credential anyone would actually issue (`openssl rand -base64 48 |
tr -d '\n'`, the release note's generator, produces 64 characters) with room to spare. It is still a
judgement call: the number is not derivable from a measurement, the real ceiling depends on every
hop in front of the service, and picking it wrong turns a working deployment's secret into a
refusal-to-start — which is the *same* operator hazard S-8's own newly-breaking classes carry.

**What it would cost.** The `.max()` is one line in the shared fragment. The test cost is an
accept-at-the-ceiling and a reject-above-it case in **five** suites, because each one asserts the
boundary independently:

```
apps/gateway/tests/env.schema.unit.test.ts
apps/usage-service/tests/env.schema.unit.test.ts
apps/worker-service/tests/env.schema.unit.test.ts
apps/billing-service/tests/env.schema.unit.test.ts
packages/shared-validation/tests/unit.test.ts
```

Plus a new message constant beside `SECRET_PATTERN_MESSAGE` in
`packages/shared-types/src/index.ts`, since the env parser reports only `issues[0]` and a bare zod
maximum-length message would not name the rule.

**Why it was not fixed in S-8.** S-8's scope was convergence — one declaration of what a valid
secret is, replacing two rules across four schemas — and adding a *new* constraint no service had
before is new production behaviour with its own newly-breaking class, inside a change whose whole
argument is that a stricter secret rule needs its operator story written first. The Gate-3 rework
that filed this entry was explicitly text-only. Recorded rather than done, on the S-16 precedent: a
missing guard that a test written from the spec would fail is a separate task, not a side effect.

**Do not close this by raising `maxHeaderSize`.** That moves the threshold and keeps the shape: a
secret with no declared upper bound, failing somewhere in traffic rather than at startup.

---

## S-55 · usage-service's `env.PORT` still defaults to a port nothing in usage-service uses, and the field is dead in all six services with only three saying so — **LOW, open**

T-050 fixed analytics-service's instance of this and deliberately did not touch usage-service's,
on the one-task-per-commit objection S-19 and S-39 both record for their own duplications.
Recorded here rather than in `docs/plans/t-050-analytics-env-schema.md`, because `CLAUDE.md` is
explicit that nothing may read `docs/plans/` as a record — the S-25 precedent.

**Every claim below re-derived on the T-050 tree** (`493e699` plus T-050's uncommitted changes)
with the command beside it. Three findings, related by cause and separated by severity, so the
first is not read as covering the other two.

### 1 · usage-service declares 3000 where its deployment says 3002

`apps/usage-service/src/config/env.ts:8` is
`PORT: z.coerce.number().int().positive().default(3000)`. `git grep -n "3002"` puts 3002 at
**five non-test sites carrying six numbers**, which is the same artifact set analytics had:

```
apps/usage-service/.env.example:6:PORT=3002
docker/docker-compose.yml:92:      PORT: "3002"
docker/docker-compose.yml:95:      - "3002:3002"          <- published *and* container port
docker/docker-compose.yml:187:      USAGE_SERVICE_URL: http://usage-service:3002   (gateway block)
apps/gateway/.env.example:22:USAGE_SERVICE_URL=http://localhost:3002
```

plus two source constants — `apps/usage-service/src/constants.ts:102`
(`USAGE_SERVICE_RUNTIME.DEFAULT_PORT`) and `apps/usage-service/src/startup.constants.ts:3` — and
one test fixture, `apps/usage-service/tests/setup.ts:3`.

**Nothing is misrouted, and that is the point.** `apps/usage-service/src/index.ts:56` binds
`Number(process.env.PORT ?? USAGE_SERVICE_STARTUP.DEFAULT_PORT)`, which is 3002. The parsed
`env.PORT` is read nowhere (finding 3), so the 3000 is a declaration contradicting its own
deployment — the S-6 shape, config that is declared, validated and then ignored — not a
mis-bind. Severity is LOW for exactly that reason, and it would rise the moment anything wired
`env.PORT` into the bind.

**Fix direction:** what T-050 did for analytics. `PORT` defaults from
`USAGE_SERVICE_STARTUP.DEFAULT_PORT`; `USAGE_SERVICE_RUNTIME.DEFAULT_PORT` derives from the same
constant instead of repeating the literal; extend
`apps/usage-service/tests/env.schema.unit.test.ts` with the two cases
`apps/analytics-service/tests/env.schema.unit.test.ts` added — the schema default, and the
deploy-artifact pin through throwing locators. Note usage's suite writes `PORT: "3000"` as a bare
literal in its own fixture at `apps/usage-service/tests/env.schema.unit.test.ts:25`; that literal
is the current wrong default written a second time, and whoever fixes the schema must fix it too
or the fixture will pin the value the schema stopped producing.

### 2 · Four services still write their port as two or three unlinked literals

`grep -n "PORT:" apps/*/src/config/env.ts | grep -v EXPORTER`, `grep -n "DEFAULT_PORT"
apps/*/src/startup.constants.ts` and `grep -rn "DEFAULT_PORT" apps/*/src/constants.ts`, together:

| Service | `config/env.ts` | `constants.ts` | `startup.constants.ts` | Literal sites | Agree? |
|---|---|---|---|---|---|
| analytics | derives (`:21`) | derives (`:20`) | `3005` (`:3`) | **1** | n/a — T-050 |
| billing | derives (`:12`) | derives (`:290`) | `3004` (`:3`) | **1** | n/a — T-044 |
| auth | derives from `AUTH_RUNTIME` (`:11`) | `3001` (`:157`) | `3001` (`:3`) | 2 | yes |
| worker | derives (`:12`) | `3003` (`:44`) | `3003` (`:3`) | 2 | yes |
| gateway | `3100` (`:7`) | `3100` (`:72`) | `3100` (`:3`) | 3 | yes |
| usage | `3000` (`:8`) | `3002` (`:102`) | `3002` (`:3`) | 3 | **no** — finding 1 |

Auth's row is a different shape from the rest and is listed as derived on that basis: its
`env.ts` imports `AUTH_RUNTIME` from `../constants`, so the derivation points at `constants.ts`
rather than at `startup.constants.ts`. T-050 rejected that direction for analytics (plan decision
D4) because it makes `constants.ts` both an upstream of `env.ts` and a downstream of
`startup.constants.ts`; it is recorded as a divergence in *direction*, not as a defect, and auth's
two literals do agree.

These four are DRY findings, not contradictions — **every value in the four rows above agrees
with itself**, checked per row. Only usage's disagrees, and that is finding 1.

### 3 · The parsed `env.PORT` is read nowhere, and half the services do not say so

Two greps over `apps/*/src` and `packages/*/src`, `--include='*.ts'`, `dist/` filtered:

- `grep -rn "env\.PORT\|\.PORT\b"` returns **12** lines: the six
  `const port = Number(process.env.PORT ?? <SERVICE>_STARTUP.DEFAULT_PORT)` binds (analytics,
  auth, billing, usage `:56`; gateway `:55`; worker `:276`) and **six comment lines**, two each in
  analytics', billing's and worker's `config/env.ts`. Those six are the comments *documenting*
  the deadness, so this grep matches its own subject — the self-match sub-pattern S-33 names, and
  the reason the count moved from 10 to 12 inside T-050's own commit. Count the binds, not the
  lines.
- `grep -rnE "\[[[:space:]]*[\"']PORT[\"'][[:space:]]*\]"` returns nothing (exit 1), so the
  dynamic-index spelling is absent too.

**What that establishes and what it does not.** No *statically spelled* read of the parsed value
exists under those two search roots. It does **not** exclude a computed property name, a spread of
the whole `env` object into something that later indexes it, or a read from outside those roots.
Stated as measured rather than as "nothing reads it".

`grep -ci "nothing.*reads the parsed\|no read of the parsed" apps/*/src/config/env.ts` returns
`1` for analytics, billing and worker and `0` for auth, gateway and usage. So three of six
`env.ts` files tell the next reader the field is inert and three leave them to work it out — and
a reader of usage's, where the number is also wrong, has nothing to warn them.

**Two of those three say it too strongly, and both predate T-050.** `git show HEAD:` on each
file at `493e699` shows `apps/billing-service/src/config/env.ts:8` reading "Nothing reads the
parsed `env.PORT`" and `apps/worker-service/src/config/env.ts:9` reading "Nothing in this repo
reads the parsed `env.PORT`" — unqualified universals of exactly the kind the paragraph above
declines to make, and "in this repo" is the stronger of the two because it names a scope wider
than the one that was searched. Only `apps/analytics-service/src/config/env.ts:7`, which T-050
wrote, carries the measured form with its roots. Not fixed here: editing two other services'
source comments inside an analytics env-schema commit is the one-task-per-commit objection this
entry's own fix direction records, and the same one T-050's Gate-4 LOW-1 applied to analytics'
test file. Whoever takes finding 2 and 3's single task should bring all three to the measured
wording rather than copying billing's.

**Fix direction for 2 and 3 together:** one task, not six opportunistic edits. Derive each
service's `PORT` and `<SERVICE>_RUNTIME.DEFAULT_PORT` from its own `startup.constants.ts`,
add the dead-field comment where it is missing, and give each service the deploy-artifact pin.
`startup.constants.ts` must stay import-free in every service — it is the module `index.ts` loads
before `initTracing(...)` (`grep -c "^import" apps/*/src/startup.constants.ts` → `0` for all six)
— so the derivation direction is always *into* `env.ts` and `constants.ts`, never out of them.
Do **not** close any of this by wiring `env.PORT` into an `index.ts`: a static import of the
parsed env there hoists zod and `@telemetry/shared-config` ahead of `initTracing`, which is the
ordering `CLAUDE.md` § *Startup ordering* exists to protect. Measured for that property alone, on
Node v22.22.2 with a four-file ESM fixture (T-050 plan P5): a static import evaluated the heavy
module *before* the tracing call and a dynamic import after it evaluated it *after*. Scope of that
measurement is plain ESM on one Node version, one static and one dynamic import — it says nothing
about tsx, bundlers, or which spans would actually be lost.

---

## S-56 · The platform emits zero spans: every service is ESM and nothing registers OpenTelemetry's ESM module hook — **MEDIUM, open**

`initTracing(...)` runs first in all six service entrypoints, builds a real provider, registers
three instrumentations and returns without error. **No span is ever produced.** Nothing reports a
failure: startup logs are clean, `/health` returns `200`, and the only visible symptom is that
every log line is missing the `traceId` the logger is built to inject.

**All measurements below were taken on this tree at `0aa19c1`** with a temporary probe under
`apps/analytics-service/` (so workspace deps resolved), run with tsx on Node v22.22.2, then
deleted. `@opentelemetry/api` 1.9.1, `@opentelemetry/instrumentation` 0.55.0,
`@opentelemetry/instrumentation-fastify` 0.44.2. The probe set
`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces` so `initTracing` does **not** hit
its `if (!endpoint) return;` early exit, attached a `SimpleSpanProcessor` over an
`InMemorySpanExporter` to the provider `initTracing` had registered, built a real Fastify app
with a `/health` route, `listen`ed on a real port and issued a real `fetch` — and imported
Fastify **dynamically after** `initTracing`, which is the ordering the real entrypoints use
(`apps/analytics-service/src/index.ts` does `await import("./app")` at `:22`, after
`initTracing(...)` at `:18`).

### What was measured

| Probe | Result |
|---|---|
| provider `initTracing` registered | `NodeTracerProvider` — so it did not early-return |
| `GET /health` over a real socket | `200 {"status":"ok"}` |
| **finished spans** | **0**, span names `[]` |
| `trace.getActiveSpan() !== undefined` inside the route handler | **false** |
| a `shared-logger` line emitted inside that handler | `{"level":"info","time":"…","service":"probe-service","msg":"inside route handler"}` |

**Correction to how this was first written up, because the difference matters to anyone grepping
for it.** The symptom was originally described as the logger emitting `traceId: null` /
`spanId: null`. It does not. `createLogger`'s mixin
(`packages/shared-logger/src/index.ts`) is `if (!span) { return {}; }`, so with no active span
the two keys are **absent from the JSON object entirely**, not present-and-null. Measured with
an `in` check, not by eye: `"traceId" in o` → `false`. A log pipeline alerting on
`traceId == null` would match nothing.

### The mixin is not at fault — the isolating mutation

In the **same process**, immediately after the request, the probe started a span by hand and
logged inside its context:

```
shared-logger line inside manual span:
  {"level":"info","time":"…","service":"probe-service",
   "traceId":"3196a2a658b7b8ed7808b822455d84cb","spanId":"7d3ccc2a1fa7fb44",
   "msg":"inside a manually started span"}
SPANS FINISHED after manual span : 1
span names                       : ["manual-probe-span"]
```

So the provider, the processor, the exporter, the context manager and the logger mixin all work.
The missing piece is upstream of all of them: nothing creates a span for the request.

### Root cause — and the first explanation for it was wrong

The explanation this entry was originally going to carry is that
**`@opentelemetry/instrumentation-http` is absent**, and that `instrumentation-fastify` alone
emits nothing because its spans are children of an HTTP span that never exists.

The absence is real. `grep -rn "instrumentation-http" --include=package.json .` outside
`node_modules` returns nothing, `grep -n "instrumentation-http" pnpm-lock.yaml` returns nothing,
and the only OpenTelemetry instrumentation packages in the lockfile are
`@opentelemetry/instrumentation`, `-fastify` and `-ioredis`.

**The causal half is refuted.** Reading
`instrumentation-fastify`'s `_hookPreHandler` shows it calling
`tracer.startSpan(spanName, { attributes })` with no explicit parent, which would produce a root
span rather than nothing. Tested directly: the probe was re-run **with the ESM loader hook
registered and `instrumentation-http` still absent**, and produced

```
SPANS: 1
  name        : request handler - fastify
  parentSpanId: (none -> ROOT span)
  service.name: "probe-service"
  attributes  : {"plugin.name":"fastify","fastify.type":"request_handler","http.route":"/health"}
getActiveSpan() in handler is a span : true
shared-logger line: {… "traceId":"25e0e3391e950b952a315422f0c1a988","spanId":"4895390cf1c85eb6" …}
```

One dimension changed, and the count went 0 → 1. So `instrumentation-fastify` **does** emit on
its own, and the absence of `instrumentation-http` is not what produces the zero.

**What produces the zero is that the module patching does not happen, because this codebase is
ESM.** Measured for the `fastify` module specifically — that is the one whose patching the probe
varied. `ioredis` and Prisma were not separately probed, so read this as "the module the probe
exercised was unpatched", not as a statement about all three instrumentations at once. `@opentelemetry/instrumentation` patches CommonJS through `require-in-the-middle`, which
needs no setup, and ESM through `import-in-the-middle`, which does: Node has to be told to load
`@opentelemetry/instrumentation/hook.mjs` as a loader, either with `--experimental-loader` or
with `module.register(...)`. Every manifest under `apps` and `packages` declares
`"type": "module"` — 13 of 13, checked with a loop over
`ls apps/*/package.json packages/*/package.json` — so every service's imports go through the ESM
path, and a repo-wide sweep for
`experimental-loader`, `hook.mjs`, `import-in-the-middle`, `NODE_OPTIONS` and `module.register`
(excluding `node_modules`, `dist`, `.git` and `pnpm-lock.yaml`) **returns nothing**: not in
`src`, not in a `package.json` script, not in `Dockerfile`, not in `docker-compose.yml`, not in
`.github/workflows/ci.yml`.

This is also why `CLAUDE.md` § *Startup ordering* and T-055's "first executable line" rule, both
of which are correctly implemented, do not help. They protect the *ordering* of patching against
module load. There is no patching to order.

### T-055 is classified done and its acceptance criterion is false

`docs/epics/epic-10-observability.md`'s T-055 acceptance reads *"A request to `/health` produces
a root span with `service.name = "{serviceName}"`"*. The probe produced zero spans.

**State it as the ambiguity it is: the code T-055 names is present, and the behaviour it promises
is absent.** The code is present — `import { initTracing } from "@telemetry/shared-tracing"` is
line 1 and `initTracing(<SERVICE>_STARTUP.SERVICE_NAME)` is line 18 of all six entrypoints
(`grep -n "initTracing" apps/*/src/index.ts` reports `1:` and `18:` for each). Checked across all
six rather than generalised from one: lines 1-18 are the same in every entrypoint — two imports,
a `type EnvLoadError` alias, and the `loadLocalEnv` function binding, none of which runs anything,
and `startup.constants.ts` is side-effect-free. So the "first executable line" rule is genuinely
satisfied. There is no commit naming
T-055 (`git log --all --format="%h %s" | grep -iE "T-?05[5-7]"` → nothing) and no plan file, so
"done" here rests on the code being visibly in place — which is exactly the inference this
finding breaks. Note the two remaining criteria are also unmet: there are no Prisma child spans,
and "no OTel errors in startup logs" is satisfied **vacuously**.

### T-056's acceptance is not reachable by the logger swap alone

T-056 asks that *"Every request log line contains `service`, `traceId`, `spanId`, and `level`"*,
by replacing `Fastify({ logger: true })` with `Fastify({ loggerInstance: createLogger(...) })`.
All six apps still use `Fastify({ logger: true })` (`apps/*/src/app.ts`), so T-056 is not done —
but doing exactly what it says would not satisfy it. Measured by performing precisely that swap
in the probe, with no ESM hook:

```
{"level":"info","time":"…","service":"probe-service","reqId":"req-1","req":{…},"msg":"incoming request"}
    has service: true | has level: true | has traceId: false | has spanId: false
{"level":"info","time":"…","service":"probe-service","reqId":"req-1","res":{"statusCode":200},"msg":"request completed"}
    has service: true | has level: true | has traceId: false | has spanId: false
```

`service` and `level` yes; `traceId` and `spanId` absent on every line. T-056 depends on this
entry, and a reviewer checking T-056's acceptance against two of its four fields would pass it.

### The fix is partly measured and partly inferred — do not conflate the halves

**Measured**, and it needs no install: calling
`module.register("…/@opentelemetry/instrumentation/hook.mjs", pathToFileURL("./"))` in-process
*before* the dynamic imports takes the same probe from `SPANS: 0` to `SPANS: 1`, a **root** span
carrying `service.name`. Run twice in one command, hook off then on, as the only varied
dimension.

**Inferred, and stated as a hypothesis rather than a finding:**

- That adding `@opentelemetry/instrumentation-http` gives the `GET /health` **HTTP server** span
  with `http.method` / `http.status_code` semantics as the root, with the fastify span as its
  child. Installing a package is a write that was out of scope here, so this was **not** run.
  What would establish it: install it, add it to `registerInstrumentations`, re-run the probe
  with the hook registered, and assert two spans with the fastify span's `parentSpanId` equal to
  the HTTP span's `spanId`.
- That registering the hook from inside `initTracing` is safe for all six services. The probe
  covered **one** synthetic app on one Node version under tsx. Not covered: the other five
  entrypoints, a built `dist` run without tsx, the container images, and whether registering an
  ESM loader affects the five vitest suites that import service modules directly. Each of those
  is a place this could behave differently.
- Whether the missing HTTP span alone would satisfy T-055's second criterion (Prisma child
  spans). `PrismaInstrumentation` is registered and was not separately probed.

### Severity — argued, MEDIUM

**MEDIUM, not LOW.** No data is lost, nothing is insecure, and no test is red, which is the case
for LOW. Three things push it up. First, it is **silent**: `initTracing` returns normally, there
is no OTel error, and the `OTEL_EXPORTER_OTLP_ENDPOINT` env var is required by every service's
schema, so the configuration looks healthy and complete. Second, it removes **distributed
tracing across a seven-service platform** — the tool you reach for when a request crosses
gateway → usage → worker → billing, which a log-only view of that path reconstructs poorly if
at all, since nothing correlates the four services' lines. Third, and the reason it is filed rather than left in a report: **a task is
classified done whose acceptance criterion is measurably false, and a second task would be
passed on two of its four fields.** That is the failure mode `CLAUDE.md` warns about when it
says a plan marks a task started, not finished.

**MEDIUM, not HIGH**, because nothing is wrong with any shipped behaviour: no request fails, no
row is mis-written, no tenant boundary is weakened. The cost is entirely observability, and it
is recoverable at any time without a migration or a data fix.

**Fix direction:** own it as a task in Epic 10 that re-opens T-055 rather than as a patch. It
needs, in order: register the ESM hook (decide between `module.register` inside `initTracing` and
a `NODE_OPTIONS`/`--import` flag at the process boundary — the in-process form is measured to
work and keeps the entrypoints honest, the flag form is what the OpenTelemetry docs lead with and
survives a `dist` run); add `@opentelemetry/instrumentation-http` for the root HTTP span; then
re-derive T-055's acceptance by running the probe in this entry against each of the six real
entrypoints rather than a synthetic app. Do T-056 after, not before — its acceptance is
not satisfiable until spans exist, and swapping the logger first would make it look done.

---

## S-57 · The tenant-context vocabulary is three copies in three services, and S-9 made it the third without promoting it — **LOW, open**

Filed by S-9's Gate-4 review (MEDIUM-2) and recorded rather than fixed, on the user's ruling and
on **S-39**'s precedent: promote what the current task owns, record what belongs to other
services.

`.claude/rules/constants.md` is a **required** review gate and says *"before adding a third copy
of a literal, promote it"*. S-9 added the third copy of four literals and did not.

**Measured census.** `grep -rn --include='*.ts' '"<literal>"' apps packages`, `dist/` filtered,
run once per literal — **three `src/` sites each, all executable, and all byte-identical today**:

| Literal | usage | billing | analytics (added by S-9) |
|---|---|---|---|
| `"TENANT_CONTEXT_MISSING"` | `src/constants.ts:27` | `src/constants.ts:83` | `src/constants.ts:44` |
| `"X-Tenant-Id header is required"` | `:28` | `:84` | `:45` |
| `"TENANT_CONTEXT_INVALID"` | `:29` | `:85` | `:46` |
| `"X-Tenant-Id header must be a valid UUID"` | `:30` | `:86` | `:47` |

The `TenantContextMissingError` / `TenantContextInvalidError` classes that consume them are
duplicated the same way — `grep -rln "class TenantContextMissingError" apps/*/src` returns
analytics, billing and usage — but that is three small classes over one vocabulary, and it is the
**vocabulary** that is the wire contract. Promote the strings; the classes can follow or not.

**A fourth occurrence that is not a fourth declaration**, listed because the rule covers tests
too: `apps/usage-service/tests/middleware.tenant-context.unit.test.ts:53`, `:70` and `:86` write
`code: "TENANT_CONTEXT_MISSING"` as a bare literal while that service's own constant is
importable. The other three literals have no test occurrences. So the full count for
`"TENANT_CONTEXT_MISSING"` is **six** lines, three declarations and three test literals; for the
other three it is three lines each.

**The omission was selective, not uniform, and that is the evidence it is worth recording.**
The same file, `apps/analytics-service/src/constants.ts`, derives its **other two** vocabularies
correctly: `ANALYTICS_HEADERS` takes `INTERNAL_SECRET` from `INTERNAL_AUTH_HEADERS` and
`TENANT_ID` from `TENANT_CONTEXT_HEADERS` (`:23-24`), and `ANALYTICS_RESPONSES.CODE_UNAUTHORIZED`
takes its value from `INTERNAL_AUTH_RESPONSES` (`:33`) — all three from
`@telemetry/shared-types`. S-9 created **no** fourth `x-tenant-id` literal, which is what S-39
asks of it. So the rule was applied twice in one file and skipped once, rather than not being
known.

**Failure mode, stated at the strength it holds — and the first version of this paragraph
overstated it.** These four strings are a response contract a client branches on: a caller that
checks `code === "TENANT_CONTEXT_MISSING"` gets the same answer from usage, billing and analytics
**today**, and nothing *designed* enforces that it keeps getting it. No test compares the three,
and the gateway does not inspect the code. This entry originally added that "a one-character edit
to any one of the three declarations would ship green through all 13 packages". **Measured, that
is true of two of the three, not three of three** — the mutation being
`CODE_TENANT_CONTEXT_MISSING: "TENANT_CONTEXT_MISSING"` → `"TENANT_CONTEXT_MISSINX"`, applied to
one service's `constants.ts` at a time and reverted with `md5sum -c`:

| Declaration edited | That package's suite |
|---|---|
| `apps/analytics-service/src/constants.ts:44` | **`Tests 56 passed (56)`** — ships green |
| `apps/billing-service/src/constants.ts:83` | **`Tests 231 passed (231)`** — ships green |
| `apps/usage-service/src/constants.ts:27` | **`Tests 3 failed \| 235 passed (238)`** — caught |

usage-service's three failures are `rejects request with missing X-Tenant-Id header with 401
TENANT_CONTEXT_MISSING`, `rejects request with empty X-Tenant-Id header` and `rejects request with
whitespace-only X-Tenant-Id header`, all in
`apps/usage-service/tests/middleware.tenant-context.unit.test.ts` (scoped:
`Tests 3 failed | 13 passed (16)`).

**And here is the part that matters more than the count.** What catches usage's drift is *exactly*
the three bare literals at `:53`, `:70` and `:86` that this entry lists above as a constants-gate
violation. They assert the literal string against a response built from the constant, so they are
an **accidental partial guard** — the only drift protection the platform has for this vocabulary,
created by breaking the rule this entry is about. Nobody designed it and it covers one service of
three.

So the correct statement is: a one-character edit to analytics' or billing's declaration ships
green; usage's is caught, by a test that should not have been written that way. Still the S-39
shape — a wire string resolved through unrelated declarations — and still latent rather than live,
because no consumer of these codes exists on this tree to break (`apps/web` reads none of them).

**Why promotion was declined here.** Rewiring `apps/usage-service/src/constants.ts:27-30` and
`apps/billing-service/src/constants.ts:83-86` puts two other services' constants in an
analytics-service diff, which is the one-task-per-commit objection this file has now recorded at
S-19, S-22, S-23, S-39, S-40 and S-45. S-39 took the same decision for the same reason and
recorded the copies it could not rewire; this is that entry's sibling for the response vocabulary
rather than the header name.

**Fix direction — and read the ordering warning before starting.** Add
`TENANT_CONTEXT_RESPONSES = { CODE_MISSING, MESSAGE_MISSING, CODE_INVALID, MESSAGE_INVALID }` to
`packages/shared-types/src/index.ts` beside `TENANT_CONTEXT_HEADERS`, point all three services'
`constants.ts` at it, and replace the three bare literals in usage-service's tenant-context test
with the constant.

**Those two halves must land in the same change, in that order.** Replacing usage's three literals
is the obvious tidy-up and it is the one step that makes things *worse on its own*: per the table
above, those literals are the only thing that catches a drifted declaration anywhere on the
platform, and a test asserting the constant against a response built from the same constant
catches nothing. Tidy them first and the platform goes from one-service-guarded to
zero-service-guarded with the whole gate green. After promotion the guard is structural — one
declaration cannot drift from itself — so the literals are genuinely redundant then, and not
before. If the promotion is ever deferred, **leave usage's literals alone** and say why in the
test. One change that does nothing else, value-identical, no
behaviour change, and the full gate re-proves it. Do it as its own task across the three services
— not opportunistically inside a fourth service's feature work, which is how this reached three.
Note the promotion target is **not** hypothetical: `TENANT_CONTEXT_HEADERS` already lives at
`packages/shared-types/src/index.ts:103` and is what the header half of this vocabulary derives
from.

---

## S-58 · The six `.env.example` files carry **two** different `INTERNAL_API_SECRET` values, so a local stack built from them fails service-to-service auth — **LOW, open, pre-existing**

Found by S-9's Gate-4 review (LOW-2) while checking the value that task added. **The split
predates S-9** — gateway/usage and billing/worker already disagreed.

**Both of this entry's original counts were wrong and are corrected here** (S-9 Gate-4 Round 2,
MEDIUM-3). It said *five* files and *three* values. It is **six** files — the repo-root
`.env.example` was missed, and it is the one a developer copies first — and **two** values, because
the third spelling existed only on the Round-1 tree and S-9's own rework removed it by moving
analytics onto gateway's. The entry's body already said the rework had done that while its title
still asserted the pre-fix state: the author wrote the refuting evidence into the same entry, which
is S-33's shape and is now a row there.

**Measured** — `grep -rn "^INTERNAL_API_SECRET=" --include=".env.example" .`, `node_modules`
excluded, with lengths, re-derived at Round 2:

| File | Value | Length |
|---|---|---|
| **`.env.example` — the repo root, untouched by S-9** | `dev-local-internal-secret-at-least-32-chars` | 43 |
| `apps/gateway/.env.example` — **the sender** | `dev-local-internal-secret-at-least-32-chars` | 43 |
| `apps/usage-service/.env.example` | `dev-local-internal-secret-at-least-32-chars` | 43 |
| `apps/analytics-service/.env.example` (added by S-9) | `dev-local-internal-secret-at-least-32-chars` | 43 |
| `apps/billing-service/.env.example` | `dev-local-secret-change-in-production` | 37 |
| `apps/worker-service/.env.example` | `dev-local-secret-change-in-production` | 37 |

**No line numbers in that table, deliberately.** They were there and one of them was already wrong:
the analytics row read `:33` while the line was `:39`, moved by the six comment lines the *same
batch* added above it — a citing change breaking its own citation, inside the entry whose subject
is a census (S-9 Gate 6, LOW-6). The line number also adds nothing here: the table answers "which
files declare this and with what value", and the command above prints the line for anyone who
wants it. This is the rule S-19 reached after six recorded positions rotted for a declaration
nobody moved, S-48 states as "cite by method and symbol, not `file(line,col)`", and S-40 applied by
dropping its `skip:` line — **cite a line only in a file the citing change does not edit, and
prefer an anchor even then.**

`sort | uniq -c` over the six values: **4 × `dev-local-internal-secret-at-least-32-chars`**,
**2 × `dev-local-secret-change-in-production`**. So the split is now 4–2 between two spellings, and
the minority is billing and worker.

**The analytics row is a net addition, not a value change** (QA O-1):
`git show HEAD:apps/analytics-service/.env.example | grep -c INTERNAL_API_SECRET` → **0**. That file
had no such line before S-9, so S-9 added one and picked gateway's value; it did not edit an
existing value. Anything describing it as a value change is wrong.

Every one is a legal secret — both spellings are printable ASCII and over
`INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH`, so every service **starts**. They simply do not
match each other.

**The consequence is measured, not reasoned about.** Driving billing-service's *real*
`buildInternalAuthMiddleware` factory with each value as the configured secret and gateway's
`.env.example` value as the inbound `x-internal-secret`:

```
gateway .env.example value -> a guard holding billing's .env.example value  -> 401 {"code":"UNAUTHORIZED"}
gateway .env.example value -> a guard holding gateway's own value           -> 200
```

So a developer who copies the `.env.example` files verbatim and runs the stack gets `401` on
**every** proxied `/v1/billing` and `/v1/worker` request, with two healthy-looking services and no
startup warning. That half is **live today**, because billing and worker have real routes behind
their guards. The analytics half is not live yet — its guarded scope holds no routes until T-051
(S-9) — which is why S-9 could fix its own line cheaply and why fixing it did not resolve this.

**`docker/docker-compose.yml` is correct and must not be "aligned" to these.** All five blocks
carry `ci-internal-api-secret-with-at-least-32-chars`, verified identical
(`grep -n "INTERNAL_API_SECRET:" docker/docker-compose.yml` → five lines, one value). Compose is a
self-consistent world; the defect is entirely in the `.env.example` set.

**Why it is LOW.** Nothing is insecure — the failure is a refusal, not an acceptance, and it fails
closed in the S-8 sense: mismatched secrets reject rather than authenticate. No deployment uses
these values; they are local-development placeholders, and a real deployment supplies its own. The
cost is a developer's afternoon, and a misleading one, because the symptom (`401 UNAUTHORIZED`
from a service that started cleanly) looks like a code defect rather than a configuration one.

**Why S-9 did not fix it.** Rewiring `apps/billing-service/.env.example` and
`apps/worker-service/.env.example` puts two other services' configuration in an analytics diff —
the one-task-per-commit objection recorded at S-19, S-22, S-23, S-39, S-40, S-45 and S-57. S-9
fixed only the line it added, and pointed its own comment here.

**Fix direction:** pick one value for all **six** `.env.example` files — the repo root included,
which is the row this entry originally missed and the file a developer reads first — and write it
once, in a change that does nothing else. Match **gateway's**, because gateway is the service that sends the header
and two of the five already agree with it. Then consider whether these five files should be
generated from one source at all: nothing checks that they agree, and nothing would have caught
this. A cheap interim guard is a test in `@telemetry/shared-validation` (or any one service's env
suite) that **discovers** the `.env.example` files rather than listing them — a hard-coded list is
how this entry came to omit the repo root — and asserts one distinct `INTERNAL_API_SECRET` value — the throwing-locator shape
`apps/analytics-service/tests/env.schema.unit.test.ts` already uses for the port, which would have
caught this the day the second spelling landed.

---

## S-59 · `AU15` has a second, worse evasion: the guard can compare with `===` while every assertion stays green — **LOW, open**

Found by S-9's Gate-5 QA (F-1) and re-derived at that task's Gate-4 Round-2 rework. It answers
affirmatively the open question that review left — whether a spelling worse than the length oracle
exists — and the answer matters more than the first one did.

`apps/analytics-service/tests/internal-auth.middleware.unit.test.ts`'s `AU15` makes three
source-text assertions about `src/middleware/internal-auth.middleware.ts`: the `secretsMatch`
import is present, the substring `secretsMatch(` is present, and the substring
`!== internalApiSecret` is **absent**. **All three hold while the live comparison is a plain
`===`:**

```ts
const shapeOk = typeof providedSecret === "string" && secretsMatch("", "");

if (
  typeof providedSecret !== "string" ||
  !(providedSecret === internalApiSecret) ||
  !shapeOk
) {
```

`secretsMatch` is still imported and still *called* — on two empty strings, where its result is
constant and load-bearing on nothing. The real decision is `providedSecret === internalApiSecret`.

**Measured**, mutation applied to the shipped file and reverted with `md5sum -c`:

```
pnpm --filter @telemetry/analytics-service typecheck   -> exit 0
pnpm --filter @telemetry/analytics-service lint        -> exit 0, 0 findings
pnpm --filter @telemetry/analytics-service exec vitest run -> Tests 56 passed (56)
AU15's three assertions, evaluated against the mutated source:
  contains `secretsMatch } from "@telemetry/shared-utils"`  -> true
  contains `secretsMatch(`                                  -> true
  contains `!== internalApiSecret`                          -> false   (the assertion requires false)
```

**It is materially worse than the length oracle already recorded in S-9.** That one leaks the
secret's *length*; this one restores the full **byte-prefix short-circuit** that S-8 existed to
remove from billing and worker — response latency reveals how many leading bytes a guess got
right, so the secret is recoverable one byte at a time rather than guessed whole.

**That last sentence is inherited, not measured here, and is labelled because this entry is about a
census claiming more than it establishes** (Gate 6, NIT-5). It is S-8's premise — the reason that
change replaced `!==` with `secretsMatch` in three guards — and no timing measurement of `===`
against this platform's guard has been taken by S-8, S-9 or this entry. `secretsMatch`'s own
docblock is explicit that the constant-time property rests on `crypto.timingSafeEqual`'s contract
rather than on any test here, and that a timing assertion is not reliably measurable in a vitest
process on a shared runner. So: the *reachability* of the `===` form is measured below; its
*exploitability* is inherited reasoning and should be cited as S-8's, not as this entry's.

`===` is also not an exotic spelling: it is what an ordinary refactor or a merge resolution
reaches for, where `internalApiSecret.length !== providedSecret.length` has to be written on
purpose.

**Why a new id and not an extension of S-51.** S-51's title is scoped to billing-service's member
and cast censuses (`BU125`/`BU126`); extending it to an analytics guard assertion would make that
title false — the objection this file records for keeping S-32 out of S-29 and S-35 out of both.
What the two share is the **shape**, and it is S-51's own sentence: *a census over an enumerated
set catches the members of that set*. Read them together.

**Two known evasions is evidence the set is larger than enumerated, not that it is now complete.**
S-9 records the length oracle and its operand-order asymmetry; this entry records the `===` form.
Neither was found by widening the list on principle — each was found by someone trying one more
spelling, and each time the previous list looked sufficient. Do not write "`AU15` now catches every
inline comparison", and do not close this by adding `=== internalApiSecret` to the forbidden list:
that buys the one spelling named here and leaves `Object.is`, a `==`, a `localeCompare`, a helper
that launders the comparison, and the next thing nobody has thought of. **S-51** records exactly
that progression for billing — four gates, four previously-unlisted spellings. (An earlier revision
of this sentence credited it to **S-48**; `grep -c "four gates"` returns **0** in S-48 and **2** in
S-51, and S-48's prose enumerates two. Corrected at Gate 6, LOW-7 — and note this entry cites S-51
correctly two paragraphs above, so it was one idea landing on two different ids.)

**Severity LOW, argued.** Nothing is wrong on the shipped tree: the guard does call `secretsMatch`
on the real operands, verified by reading it, and analytics' guard protects zero routes until
T-051 (S-9). The cost is evidentiary — a reviewer or agent can read a green `AU15` as "the
comparison is timing-safe" when what it establishes is "the file spells `secretsMatch(` somewhere
and does not spell one forbidden substring". It becomes **MEDIUM** the moment T-051 puts a
tenant-scoped route behind that guard *and* someone relies on `AU15` in a review instead of
reading the comparison.

**Fix direction.** A text census cannot be made complete, so stop trying to complete it and change
what is asserted. Two options, neither taken here because both are test-logic changes outside a
text-only round:

- **Assert the call's operands, not the file's substrings** — parse the middleware with the
  TypeScript compiler API and assert that the `if` condition's only comparison is a call to
  `secretsMatch` whose arguments are the two identifiers in scope. That reaches every spelling of
  an inline comparison, including all three now on record, because it asserts a shape rather than
  a string. `apps/billing-service/src/repositories/base.repository.ts`'s
  `InvoiceDelegateSurfaceCensus` is the precedent for a compiler-level assertion in this repo.
- **Or delete `AU15` and say the property is unguarded**, which is honest and is what
  `.claude/rules/testing.md` prefers to a case that cannot fail for the reason it names.

Whichever is chosen, write the two evasions on record as the cases the replacement must go red on,
and confirm both red before trusting it.

---

## S-60 · The scoping command `CLAUDE.md` recommends bypasses turbo's env filtering, so an ambient invalid `INTERNAL_API_SECRET` reddens four of six services — **LOW, open**

Found by S-9's Gate-5 QA (F-2) and re-derived at that task's Gate-4 Round-2 rework. A conflict
between two pieces of this repository's own documentation, not a defect in any service.

`CLAUDE.md` and `.claude/rules/testing.md` both say the same thing, because
`pnpm --filter <pkg> test -- <file>` does not filter: **use `pnpm --filter <pkg> exec vitest run
<file>` to scope a run.** That command runs vitest directly and therefore **inherits the caller's
whole environment**. `pnpm test` runs through turbo, which passes only the variables a task
declares — and `turbo.json:16` declares `INTERNAL_API_SECRET` on the **`dev`** task **only**, not
on `test`. So the two paths disagree about whether an ambient `INTERNAL_API_SECRET` reaches the
module-load `parseEnv`.

**Measured**, same shell, same tree, an ambient 5-character secret against the 32 minimum:

| Command | Result |
|---|---|
| `INTERNAL_API_SECRET=short pnpm test --force --filter @telemetry/analytics-service` | `Tests 56 passed (56)` — turbo strips it |
| `INTERNAL_API_SECRET=short pnpm test --force --filter @telemetry/billing-service` | `Tests 231 passed (231)` — turbo strips it |
| `INTERNAL_API_SECRET=short pnpm --filter @telemetry/analytics-service exec vitest run` | `Test Files 4 failed \| 3 passed (7)` |
| `INTERNAL_API_SECRET=short pnpm --filter @telemetry/billing-service exec vitest run` | `Test Files 8 failed \| 12 passed (20)` |
| `INTERNAL_API_SECRET=short pnpm --filter @telemetry/worker-service exec vitest run` | `Test Files 4 failed \| 14 passed (18)` |
| `INTERNAL_API_SECRET=short pnpm --filter @telemetry/usage-service exec vitest run` | `Test Files 6 failed \| 13 passed (19)` |
| `INTERNAL_API_SECRET=short pnpm --filter @telemetry/gateway exec vitest run` | `Test Files 9 passed (9)` — **immune, structurally** |
| `INTERNAL_API_SECRET=short pnpm --filter @telemetry/auth-service exec vitest run` | `Test Files 15 passed (15)` — **immune, but only to this field** |

**Four of the six services**, and the table now carries all six so the count is derivable from it
— the auth row was missing when this entry was written, which made "four of six" unsupported by
its own evidence (Gate 6, NIT-4). The four that fail parse at module load
(`export const env = parseEnv(EnvSchema, process.env)`), which is the property that makes a
misconfigured service fail at startup instead of in traffic — a deliberate design this entry is
**not** arguing against. The failures are import-time collection failures, not assertion failures:
the suites do not run at all.

**The two immunities are not the same immunity, and the difference matters.**

- **gateway is immune structurally.** Its schema parses lazily inside `loadEnv()` rather than at
  module load, so importing its modules does not parse the environment at all. No ambient value
  for any field reaches it through this path.
- **auth-service is immune only to *this field*.** It parses eagerly like the other four
  (`apps/auth-service/src/config/env.ts:39`), and is untouched here solely because it declares no
  `INTERNAL_API_SECRET` — `grep -c "INTERNAL_API_SECRET" apps/auth-service/src/config/env.ts` →
  **0**, and its `EnvSchema` holds eleven fields, none of them that one. Undeclared keys are
  stripped by `z.object`, so the ambient value is ignored.

  Measured, because "immune to this field" invites the reading "immune": the **same command** with
  an ambient invalid value for a field auth *does* declare reproduces the defect there —
  `JWT_SECRET=short pnpm --filter @telemetry/auth-service exec vitest run` fails with
  `Invalid environment configuration for JWT_SECRET: JWT_SECRET must be at least 32 characters`.
  `JWT_SECRET` is `z.string().min(32, …)` at `apps/auth-service/src/config/env.ts:16`.

So the honest scope is: **five of six services are reachable by this mechanism** and only gateway
is structurally out of reach; **four of six** is the count for `INTERNAL_API_SECRET` specifically,
which is the variable this entry was filed about. Do not generalise the four into "the other two
are safe".

**The trigger on the machine where this was found is a local file, and the entry must not be read
as "everyone's suite is red".** The repo-root `.env` carries a **16-character**
`INTERNAL_API_SECRET`, below the 32 minimum. That file is **gitignored** (`.gitignore:6`) and
untracked, so the value is one developer's, not something the repository ships. Two things were
measured separately and should not be conflated:

- **The mechanism is platform-wide** — it follows from turbo's env filtering versus a direct
  vitest invocation, and it reproduces for any ambient invalid value, as the table above shows.
- **The `.env` file does not by itself reach a vitest process here.** Control, same machine, same
  shell: a plain `pnpm --filter @telemetry/analytics-service exec vitest run` with no ambient
  variable returns `Tests 56 passed (56)`. So vitest did **not** load the root `.env` into
  `process.env`; the value must be exported into the invoking shell (a `set -a` source, `direnv`,
  a CI step, an editor's terminal profile) to bite. What is **not** established is how common that
  is, or whether some other tool on another machine does load it.

**Analytics is the fourth service to inherit this, and it did so by being correct.** S-9 mirrored
billing's and worker's pattern exactly — declare the field from the shared fragment, parse at
module load, supply the test value from `tests/setup.ts` — which is what `CLAUDE.md` instruction 5
asks for. Doing the right thing is what acquires the defect, which is the part worth recording:
there is no local choice a fifth service could make to avoid it short of gateway's lazy parse.

**Severity LOW.** Nothing ships wrong and no production behaviour is implicated — it is entirely a
developer-experience and diagnosis cost. It earns an id rather than a shrug because the failure is
badly misleading: a developer follows the documented scoping command, sees four suites fail to
collect with `Invalid environment configuration for INTERNAL_API_SECRET`, and has no reason to
suspect their own shell rather than the change they are making. The same person running
`pnpm test` sees green, which makes it look intermittent.

**Fix direction — decide it, do not patch one service.** Options, in rough order of cost:

- **Document it where the command is recommended.** One sentence in `CLAUDE.md` and
  `.claude/rules/testing.md`: `exec vitest run` inherits the ambient environment where `pnpm test`
  does not, so unset `INTERNAL_API_SECRET` (and anything else a schema validates) before scoping a
  run. Cheapest, and it puts the warning where the trap is sprung.
- **Have `tests/setup.ts` overwrite rather than default.** Every service uses `??=`, which defers
  to an ambient value on purpose; changing it to `=` would make the suites hermetic and would also
  silently discard a value someone set deliberately. That is a real trade and needs deciding for
  all six services at once, not for whichever one is being edited — the S-19/S-23/S-39 objection.
- **Declare `INTERNAL_API_SECRET` on turbo's `test` task**, which would make the two paths agree by
  making `pnpm test` *also* fail on an ambient invalid value. Note this is the opposite direction
  from the first two and would turn a silent divergence into a loud one for every developer.

Do not close this by adding the variable to some services' `test` env and not others; that
converts one divergence into two.
