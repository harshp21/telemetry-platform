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

## S-8 · the three internal-auth guards still diverge, and their four secret schemas disagree — **MEDIUM, open**

Found while fixing S-4, and deliberately not folded into it: changing two other services'
startup contracts inside a usage-service security fix breaks the one-task-per-commit rule.

`apps/billing-service/src/middleware/internal-auth.middleware.ts:9` and
`apps/worker-service/src/middleware/internal-auth.middleware.ts:9` are the same file, and both
differ from `apps/usage-service/src/middleware/internal-auth.middleware.ts` in three ways
(items 1 and 3 apply to both; item 2 no longer applies to either — T-037 declared the field for
worker-service and T-044 for billing-service, so what is left of item 2 is **usage-service's and
gateway's**, and it is a different defect from the one originally recorded):

**Counts, because the two differ and the title used to conflate them.** There are **three**
guards — `ls apps/*/src/middleware/internal-auth.middleware.ts` returns billing, usage and worker
— and **four** schemas declaring the secret, `grep -rln "INTERNAL_API_SECRET" apps/*/src/config/env.ts`
adding gateway. Gateway has a schema and no guard because it is the *caller*
(`docs/reviewer-checklist.md:28` says so), which is why item 2 reaches four services and items 1
and 3 reach three. An earlier revision of this title said "the four internal-auth guards";
corrected at T-044's Gate-4 review (M-1).

1. **`!==`, not a timing-safe comparison.** String comparison short-circuits at the first
   differing byte, so response latency leaks how many leading bytes a guess got right. See the
   `secretsMatch` helper in usage-service for the SHA-256 + `timingSafeEqual` form.
2. **~~The secret bypasses the env schema~~ — closed for billing and worker; what remains is
   usage-service's **and gateway's** untrimmed `.min()`.**
   T-037 declared `INTERNAL_API_SECRET` in worker-service's `EnvSchema` with
   `.trim().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)`; T-044 did the same for
   billing-service. Both parse at module load and both read the parsed value in `app.ts`
   (`apps/worker-service/src/app.ts:27`, `apps/billing-service/src/app.ts:26`). Before T-044,
   billing built its app with `process.env.INTERNAL_API_SECRET ?? ""`: reproduced at Gate 3 on
   `961d222` through `app.inject`, `INTERNAL_API_SECRET=short` (5 characters) booted and returned
   `200` on `POST /v1/internal/billing/generate`. On the fixed tree the same 5-character value,
   and 33 spaces, both fail at module load with
   `Invalid environment configuration for INTERNAL_API_SECRET: String must contain at least 32 character(s)`.

   **Still open:** `apps/usage-service/src/config/env.ts:15` and `apps/gateway/src/config/env.ts:14`
   are `.min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)` with no `.trim()`. Measured against
   usage-service's real schema field (`EnvSchema.shape.INTERNAL_API_SECRET.safeParse`, zod
   3.25.76): 32 spaces → `success: true`, parsed length 32; 32 tabs → likewise; a 31-character
   core padded to 35 → `success: true`, parsed length 35; a bare 31-character value → rejected.
   So the *length* minimum is enforced and the *whitespace* hole is not. usage-service also has
   no blank-secret guard in `app.ts` — it passes `env.INTERNAL_API_SECRET` straight to
   `registerUsageInternalAuthMiddleware` (`apps/usage-service/src/app.ts:27`) — where billing and
   worker both throw `InternalApiSecretMissingError` on a blank value. Note the docblock at
   `apps/usage-service/src/middleware/internal-auth.middleware.ts:37-38` says the secret is
   "Validated non-empty and at least `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` long by the env
   schema". Stated precisely: a 32-space string **is** literally non-empty, so the comment is not
   false on its own words — it is misleading, because the property a reader takes from it is
   *not blank*, and that is what an untrimmed `.min()` does not give. It should be reworded by
   whichever task adds the `.trim()`. T-044 left usage-service alone deliberately
   (decision D1-A in `docs/plans/t-044-billing-service-env-schema.md`): reaching into the live
   ingestion service's startup contract from a billing env task is the move this gap twice
   declined.
3. **`preHandler`, not `onRequest`, and `reply.send(...)` is not returned.** (worker's
   registration is now at `apps/worker-service/src/app.ts:59`.) An unauthenticated
   caller still gets its body parsed and validated before rejection, and the un-`return`ed
   `reply.status(401).send(...)` inside an async hook relies on Fastify's `reply.sent` check
   rather than stating the short-circuit. **The cost of this grew at T-045**: measured, a wrong
   secret gives `401` with the route handler never running (`handlerRan = 0`), but
   `bodyParsed = 1` — so an unauthenticated caller's body is now parsed and validated against a
   real schema rather than an empty stub.
4. **billing picks the first value of a duplicated header where usage-service rejects it.**
   `apps/billing-service/src/middleware/internal-auth.middleware.ts:7` does
   `Array.isArray(provided) ? provided[0] : provided`; usage-service (`:50`) treats any
   non-string as smuggling and rejects. **Measured at T-045's Gate 1 before being called a
   hole, and it is not one:** over a real `net`/`http` socket *and* via `app.inject`, a
   duplicated `x-internal-secret` arrives **joined** as `"good-secret, evil"` — type `string`,
   never an array — so the `provided[0]` arm is unreachable through HTTP at fastify 5.10.0, and
   the joined value fails the comparison into a `401`. Scope of that: this header, this version,
   two transports; `set-cookie` is the documented array-valued exception and was **not** probed.
   Listed because it is a real divergence between two guards that should be identical, not
   because it is exploitable. T-045's plan §10 said it should be listed here and it was not —
   caught at that task's Gate-6 review (R2-LOW-3).

**Fix direction:** add `.trim()` before `.min(...)` in usage-service's and gateway's
`EnvSchema`, so all **four secret schemas** declare the field identically. Note that is
*schemas*, not services: gateway has a schema and no guard, so items 1 and 3 reach only the
three services that have `internal-auth.middleware.ts`. An earlier revision said "so all four
services end up identical", which the counts above refute. Order is load-bearing, not decoration, and
the two wrong forms fail differently — measured against billing's real schema at Gate 3 of
T-044 by mutating the declaration and re-running
`apps/billing-service/tests/env.schema.unit.test.ts`:


| Declaration | 32 spaces | 31-char core padded to 35 | Named tests red |
|---|---|---|---|
| `.trim().min(32)` (shipped) | rejected | rejected | none |
| `.min(32)` (usage, gateway today) | accepted, parses to 32 spaces | accepted, parses to 35 | `rejects an all-whitespace …`, `rejects an INTERNAL_API_SECRET that reaches the minimum only by its padding`, `strips surrounding whitespace …` |
| `.min(32).trim()` | accepted, parses to `""` | accepted, parses to 31 | the first two of those three |

Note the third row: `.min(32).trim()` reads like a fix, passes the "strips surrounding
whitespace" case, and still admits a 31-character secret. A suite that only asserts the trimmed
*output* does not distinguish it.

**Addendum — `.trim()` is narrower than it reads, and this applies to worker-service too
(T-044 Gate 5).** `String.prototype.trim` strips the **ECMAScript `WhiteSpace` + `LineTerminator`
set**: every `Zs`, plus TAB/VT/FF/CR/LF, plus U+2028/U+2029, **plus U+FEFF specifically**. It is
*not* "all `Zs`, no `Cf`" — U+FEFF is `Cf` and **is** stripped, while U+00AD (also `Cf`) is not.
Measured across 17 characters against billing's real schema (`z.string().trim().min(32)`, 32
repetitions of each):

| Stripped, so rejected | Not stripped, so **accepted as a 32-character secret** |
|---|---|
| U+0020, U+00A0, U+2000, U+3000 (`Zs`) · U+0009, U+000A, U+000B, U+000C, U+000D · U+2028, U+2029 · **U+FEFF (`Cf`)** | **U+200B, U+2060, U+180E, U+200C, U+00AD** — all `Cf` |

So the guard the `.trim()` adds is "not made of whitespace **as ECMAScript defines it**", not "not
made of invisible characters". An earlier revision of this addendum said `trim()` strips `Zs` and
not `Cf`; that was generalised from a single `Cf` probe (U+200B) without trying the one that
refutes it, and was corrected at T-044's Gate-6 review (H-1) after re-measuring the whole set.

Severity is LOW and it **fails closed**: such a secret is accepted by the schema, but the caller
must then send byte-identical invisible characters in `X-Internal-Secret` for the comparison to
succeed, so the failure mode is a service that refuses every request rather than one that accepts
a weak credential. It is recorded here rather than fixed because the fix belongs with the rest of
this entry: worker-service has the identical `.trim().min(...)` form and the identical gap, so
tightening one service's declaration and not the other would add a fourth strictness to an entry
whose whole subject is that four already disagree. Whoever closes items 1-3 should decide the
normalisation once, for all of them.

Then promote the guard to `onRequest` in both, share one timing-safe comparison helper rather
than keeping three copies of the middleware, and adopt each service's
`HTTP_STATUS_UNAUTHORIZED` constant instead of the literal `401` at
`internal-auth.middleware.ts:10` — worker-service and billing-service both now define
`HTTP_STATUS_OK` / `HTTP_STATUS_UNAUTHORIZED` (`apps/worker-service/src/constants.ts:39-40`,
`apps/billing-service/src/constants.ts:28` and `:31` (T-045 inserted six status constants
between them, so they are no longer contiguous and the old `:25-26` range was wrong twice over),
both added so their env suites could assert
statuses without literals) and both middlewares still write the literal.

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

**How bad it is today, stated no stronger than measured — and it has now changed twice.**
`grep -rn "extends TenantScopedRepository" apps/*/src` finds **four** real subclasses across
**three** services, in nine total matches (the other five are the `EventRepository` example
inside each base file's own docstring):

| Subclass | Base copy | `TimeZone` pin | Added by |
|---|---|---|---|
| `apps/usage-service/src/repositories/usage.repository.ts:150` | usage | **yes** | S-18 era |
| `apps/worker-service/src/repositories/event.repository.ts:64` | worker | no | T-040 |
| `apps/billing-service/src/repositories/meter.repository.ts:35` | billing | no | T-045 |
| `apps/billing-service/src/repositories/invoice.repository.ts:94` | billing | no | T-045 |

Line numbers are as of the T-045 tree and re-derived from
`grep -rn "extends TenantScopedRepository" apps/*/src`, filtered to lines beginning
`export class` — the unfiltered grep also returns five docstring examples. They have already
rotted once: the `invoice.repository.ts` citation was written at `:87`, was `:92` by the time
Gate 4 measured it, and is `:94` on the tree that shipped, because the fix for that review moved
it. Re-run the grep rather than trusting the column.

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
service's test harness, which is the same reason S-8 was not folded into S-4.

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
commit is the same one-task-per-commit objection that kept S-8 out of S-4.

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
Twice now it has not been.

**Observed, both times by a review agent that then went and read the files with `cat`:**

- At T-038's Gate-4 review: the injected `.claude/rules/*` were pre-`1b872b3` — a `testing.md`
  still carrying the integration-exclusion wording that `1b872b3` had already fixed, a
  `known-gaps.md` ending at **S-10**, and a `review-standards.md` with no *Universals Must Cite
  Their Mutation* section. On-disk at the same commit, all three were current.
- At T-038's Gate-6 review, in a different session: the injected `known-gaps.md` ended at
  **S-21**, so it could not see the S-22 correction and the S-23 entry that the very diff under
  review had added.

**What is *not* established:** the mechanism. Neither review investigated whether this is
snapshot timing, caching, or something else, and nothing here reproduces it on demand — both
sightings are after-the-fact observations by agents who noticed a mismatch, not a controlled
probe. Do not restate the cause as known. The *consequence* is what is measured: an agent can
cite `.claude/rules/` accurately and still be citing a superseded revision.

**Why it is LOW and not higher:** it has caused no wrong verdict so far, because in both cases
the reviewer noticed the mismatch and re-read from disk. It is filed because that recovery
depended on the reviewer being suspicious, which is not a mechanism either.

**How this bites, concretely:** the reviewer that cannot see S-23 also cannot see that the gap
it is about to file already exists, so the same finding gets a second id; and an agent working
from a `known-gaps.md` that stops at S-10 will not know that S-11 through S-21 forbid what it is
about to write.

**Working practice until it is fixed:** an agent that is going to *cite* or *edit* a
`.claude/rules/` file should `cat` it first and treat the injected copy as a hint, not as the
text. Reviews that quote these files should say which revision they read, as T-038's Gate-4
review did. Cheap, and it is what caught both sightings.

**Fix direction:** establish the mechanism before attempting a fix — the two sightings are the
whole evidence base, and a fix aimed at the wrong layer would be unfalsifiable. If it turns out
to be unfixable from inside the repository, say so here and keep the working practice above.

---

## S-25 · worker-service's largest file is outside its own coverage thresholds, and the per-suite Redis database convention does not scope *reads* — **LOW, open**

Two findings from T-039's Round-1 review, filed under one id because they share a cause: a
guard that exists is assumed to cover a case it was never scoped to.

### 1 · `src/events/**` is excluded from coverage collection

`apps/worker-service/vitest.config.mjs:18` lists `"src/events/**"` in `coverage.exclude`,
alongside `src/**/index.ts`, `src/config/container.ts`, `src/jobs/**`, `src/middleware/**`,
`src/models/**`, `src/telemetry/**` and `src/types/**`. The thresholds it guards are
`lines/functions/statements: 80` and `branches: 75` (`:25-30`).

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
> signalled shutdown both teardown lines are emitted.
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
