# Review — S-18 · Usage-summary range predicate resolves through the DB session timezone

**Gate 4 (Senior Reviewer, pre-QA) · base `3374cf9` · nothing committed · reviewer wrote no
code and applied no fix.**

**Verdict: CONDITIONAL** — the production fix is correct and I verified it by execution in
every input form and session zone I could construct. Three findings must be addressed before
commit (M-1, M-2, M-3); all three are claims the change makes *about itself*, not defects in
the predicate.

Scope reviewed: `apps/usage-service/src/repositories/usage.repository.ts`,
`apps/usage-service/src/repositories/base.repository.ts`,
`apps/usage-service/src/constants.ts`, `apps/usage-service/tests/usage.repository.unit.test.ts`,
`apps/usage-service/tests/usage.timezone.integration.test.ts` (new), `CLAUDE.md`,
`.claude/rules/tenant-isolation.md`, `docs/development-setup.md`,
`docs/plans/s-018-usage-summary-range-timezone.md`.

Out of scope and **not** counted against S-18: `tests/usage.integration.test.ts`,
`tests/integration.constants.ts`, `tests/integration.fixtures.ts`,
`.claude/rules/known-gaps.md`, `docs/plans/t-036-usage-service-integration-tests.md` (T-036,
paused at Gate 3). I confirmed S-18 left all five untouched: the S-18 diff of
`known-gaps.md` and of T-036's plan contains zero occurrences of `S-18`/`timezone`/`TimeZone`,
and `git status --porcelain` is byte-identical before and after this review.

---

## Findings

### BLOCKER — none

No tenant-isolation defect, no injection surface, no correctness defect in the shipped
predicate. Details under *What I verified*.

---

### MEDIUM

#### M-1 · `usage.repository.ts:105-106` — the "unrepresentable" claim is false as written, and I refuted it by execution

```
 * Keeping both in one function is the point: a caller cannot obtain the cast without the
 * normalization, so the half-fixed predicate is not expressible at this call site.
```

The first clause is false. `UTC_NAIVE_TIMESTAMP_CAST` is **exported**
(`usage.repository.ts:80`), so any module can compose the half-fixed shape. I built it:

```
Prisma.sql`WHERE "periodStart" >= ${input.from}${UTC_NAIVE_TIMESTAMP_CAST}`
  →  text:   WHERE "periodStart" >= $1::timestamp(3)
     values: ["2026-01-01T05:30:00.000+05:30"]
```

and ran it against seeded rows as `telemetry_app`. It is wrong **in all four session zones,
including UTC** — it returns `["at-to","interior","ms-before-to"]` instead of
`["at-from","interior","ms-before-to"]`, i.e. the exact offset-dependent bug §5.1 of the plan
was written to prevent, now reachable through the very symbol the comment says makes it
unreachable. The second clause ("at this call site") is true, which is why this is MEDIUM and
not HIGH: `buildFilters` itself is safe. But the next person to edit this file will read the
first clause and believe a guarantee that does not exist.

**Concrete fix (also resolves M-2 and the §6 deviation).** Follow the pattern the repo already
has for SQL text in a constants module — `apps/auth-service/src/constants.ts:70`
(`RESOLVE_TENANT_BY_EMAIL_FN: "public.auth_resolve_tenant_by_email"`) consumed as
`Prisma.raw(...)` at `apps/auth-service/src/repositories/user.repository.ts:15`:

1. In `apps/usage-service/src/constants.ts`, add a plain string beside
   `DATABASE_SESSION_SETTINGS`, e.g.
   `export const DATABASE_SQL = { UTC_NAIVE_TIMESTAMP_CAST: "::timestamp(3)" } as const;`
   No `@prisma/client` import, so the stated rationale for the deviation is preserved.
2. In `usage.repository.ts`, keep the fragment **module-private**:
   `const UTC_NAIVE_TIMESTAMP_CAST = Prisma.raw(DATABASE_SQL.UTC_NAIVE_TIMESTAMP_CAST);`
   and delete the `export`.
3. Delete the false clause, or reword to what is true: *"`utcTimestampBound` is the only
   in-module path to the cast; the fragment is not exported, so the half-fixed shape cannot be
   composed from outside."*

**Disposition: required before commit.** It is a one-word change (`export`) plus a reworded
sentence, and it converts a false universal into a true one.

---

#### M-2 · `usage.repository.unit.test.ts:213-215` — the cast assertion is self-referential; mutation testing shows it is blind to the failure mode its own title names

The test is titled *"binds both range bounds as UTC-naive timestamps, not as timestamptz
Dates"* and asserts:

```ts
expect(sql.text).toContain(`"periodStart" >= $2${UTC_NAIVE_TIMESTAMP_CAST.text}`);
```

Both sides derive from the production constant, so they move together. I mutated the fragment
and re-ran the assertion set:

| `UTC_NAIVE_TIMESTAMP_CAST` | new unit assertions |
|---|---|
| `::timestamp(3)` (as landed) | PASS |
| `::timestamptz` | **PASS** |
| `::timestamp` | PASS |
| `::timestamp(0)` | **PASS** |

`::timestamptz` reintroduces S-18 exactly (`'2026-01-01T00:00:00.000Z'::timestamptz` renders
`2026-01-01 05:30:00` naive on an `Asia/Kolkata` session — measured), and `::timestamp(0)`
rounds `2026-01-31T23:59:59.999Z` up to `2026-02-01 00:00:00` (measured), which flips the
`ms-before-to` boundary row out of the window. Both mutants are caught by
`usage.timezone.integration.test.ts`, so the suite as a whole is not blind — but the unit
test's stated job is precisely the thing it cannot detect, and the file comment at `:206-212`
claims otherwise.

**Concrete fix.** Assert against the *expected* text, once, and cross-check the fragment:

```ts
const EXPECTED_TIMESTAMP_CAST = DATABASE_SQL.UTC_NAIVE_TIMESTAMP_CAST; // "::timestamp(3)"
expect(UTC_NAIVE_TIMESTAMP_CAST_TEXT).toBe(EXPECTED_TIMESTAMP_CAST);   // pins the target type
expect(sql.text).toContain(`"periodStart" >= $2${EXPECTED_TIMESTAMP_CAST}`);
```

With M-1's fix the constant lives in `constants.ts`, so this satisfies
`.claude/rules/constants.md` without the circularity. **Disposition: required before commit.**

---

#### M-3 · `CLAUDE.md:212-213` and `usage.repository.ts:107-108` — the quoted `42883` message has its operands reversed

Both files assert, verbatim:

```
42883 operator does not exist: text >= timestamp without time zone
```

The substance is verified true — omitting the cast *does* fail loudly — but the message never
takes that form for this predicate, because the column is the left operand. Measured, twice:

```
psql (VERBOSITY verbose):
  ERROR:  42883: operator does not exist: timestamp without time zone >= text
Prisma $queryRaw `... WHERE "periodStart" >= ${iso}` :
  P2010 / meta.code "42883" / "operator does not exist: timestamp without time zone >= text"
```

`CLAUDE.md` is designated authoritative and other agents are told to trust it without
re-verification; an agent grepping logs or CI output for the quoted string will not find it and
may conclude the bullet is unreliable. I am scoring this MEDIUM rather than HIGH because the
load-bearing claim ("fails loudly, so it is the safe mistake") is verified correct and only the
operand order in the quotation is wrong.

**Concrete fix.** In `CLAUDE.md:213` and `usage.repository.ts:108`, replace the quoted string
with `42883 operator does not exist: timestamp without time zone >= text` (and, in `CLAUDE.md`,
optionally note that Prisma surfaces it as `P2010` with `meta.code = "42883"`).
**Disposition: required before commit** — it is a two-line docs correction.

---

### LOW

#### L-1 · `usage.timezone.integration.test.ts:40` — docstring claims a role the file never asserts

```
 *   DATABASE_URL        -> telemetry_app (NOSUPERUSER/NOBYPASSRLS) — asserts through this
```

The file has no `pg_roles`/`current_user` check. The sibling suite does
(`rls.enforcement.integration.test.ts:74-76`, asserted at `:158-163`), and it is the reason
that suite is admissible evidence at all. The claim happens to be **true in this run** — I
established it two ways: no ambient `DATABASE_URL` exists, so `tests/setup.ts:5-6` supplies
`telemetry_app`; and `rls.enforcement.integration.test.ts` passed 7/7, which asserts
`rolsuper = false` and `rolbypassrls = false` for `current_user` on that same URL. My own probe
on the same URL reported `role=telemetry_app (rolsuper/rolbypassrls = false/false)`.

This is LOW rather than MEDIUM because the role is not load-bearing for a timezone conclusion —
the test would be equally valid as a superuser. But the docstring states it as a property of
the test.

**Fix:** add the four-line role assertion from `rls.enforcement.integration.test.ts:74-76` to
`beforeAll`, or soften the docstring to "runs through the runtime role".

#### L-2 · `rls.enforcement.integration.test.ts:24` — `APP_TENANT_ID_SETTING` is now a duplicate, and `"app.tenant_id"` has a third definition

`DATABASE_SESSION_SETTINGS.TENANT_ID` (`constants.ts:74`) now exists, and
`AUTH_DATABASE.TENANT_CONTEXT_SETTING` (`apps/auth-service/src/constants.ts:69`) already did.
`.claude/rules/constants.md`: *"before adding a third copy of a literal, promote it."* S-18
reduced literals inside usage-service but added the second service-level definition; with the
test literal that is three, plus four hard-coded copies in
`{worker,billing,analytics,auth}-service/src/repositories/base.repository.ts:98/105`.

**Fix (in scope, cheap):** point `rls.enforcement.integration.test.ts:24` at
`DATABASE_SESSION_SETTINGS.TENANT_ID`. **Fix (out of scope):** promote the setting name to a
shared package — see *Recommended for `known-gaps.md`*.

#### L-3 · `usage.timezone.integration.test.ts:47,185-193` — `ADMIN_URL_FALLBACK` and `requireEnv` are copied verbatim from `rls.enforcement.integration.test.ts:27,41-49`

Same connection-string literal in three places counting `tests/setup.ts:8`. The plan's D-1
accepted *one* duplicated seeding helper as the price of not depending on T-036's fixtures;
duplicating the env helper against an already-committed file was not part of that trade. Also
note `requireEnv("DIRECT_DATABASE_URL", ADMIN_URL_FALLBACK)` can never throw, which makes the
helper's name misleading at that call site (and the fallback is dead, since `tests/setup.ts:8`
already sets the var).

**Fix:** extract `requireEnv` and the URL defaults into `tests/integration.env.ts` and have
both suites import it — coordinating with T-036, which is adding `integration.fixtures.ts` in
the same directory.

#### L-4 · `CLAUDE.md:203-206` — an inference the plan explicitly hedged is restated as fact

Plan §3.3: *"the mechanism is an inference from the logged parameter form and should be read as
such."* `CLAUDE.md` drops the hedge: *"The engine knows the column type from the schema;
`$queryRaw` does not."*

The **behaviour** is verified — I ran `where: { periodStart: { gte, lt } }` under `UTC`,
`Asia/Kolkata`, `America/New_York` and `Asia/Kathmandu`, inside and outside `$transaction`, and
got `{r2,r3,r4,r5}` in all eight combinations; the query log shows
`"periodStart" >= $2` with params `["…","2026-01-01 00:00:00 UTC","2026-02-01 00:00:00 UTC"]`.
So the actionable guidance ("prefer the ORM for date ranges") is sound. Only the causal
explanation is unverified.

**Fix:** one word — *"the engine appears to know the column type from the schema (inferred from
the logged parameter form; the behaviour is measured, the mechanism is not)"*.

#### L-5 · `.claude/rules/tenant-isolation.md:19-20` — the new rationale sentence does not describe the actual invariant

> *"The tenant statement stays first: a caller without RLS context must not cause anything else
> to run."*

Inside `withTenant` there is no such caller — the wrapper always sets tenant context, and the
zone pin is not a data statement, so running it first would not in fact expose anything. The
real invariant is the one the file already states elsewhere: no statement that **touches a
tenant-scoped table** may precede the RLS context. The current wording will read as false to
anyone who checks it.

I **agree with the decision to edit this file at all**, notwithstanding plan §6 saying it would
not be touched: the layer-4 bullet described the exact statement `withTenant` issues, and after
this change that description was incomplete for usage-service. A rule file that is silently out
of date is worse than the scope cost of a three-line edit, and the edit is confined to the
bullet the change invalidated. The factual content of the new wording is otherwise **accurate**:
I verified only usage-service has the pin (`grep` shows `worker`, `billing`, `analytics` and
`auth` still issue the single `set_config('app.tenant_id', …, true)`), and that the tenant
statement is first (`base.repository.ts:110` precedes `:111`, and
`usage.repository.unit.test.ts:170` asserts `findIndex(isSetConfigCall) === 0`).

**Fix:** replace the clause with *"no statement against a tenant-scoped table may precede the
RLS context, and the pin must not displace it."*

#### L-6 · `base.repository.ts:110-111` — one extra round trip per tenant-scoped transaction

Every `withTenant` now issues two `SELECT set_config(...)` statements instead of one. Small and
almost certainly irrelevant (~0.1-0.2 ms locally, against an interactive transaction that
already pays `BEGIN`/`COMMIT`), but it is on the hot path of the summary endpoint and it was
not measured in the plan. Collapsing to `SELECT set_config($1,$2,true), set_config($3,$4,true)`
would remove it, at the cost of making the "tenant statement first" contract implicit rather
than textual — which is why I am **not** recommending the change, only recording the cost.
**Disposition: accept.**

#### L-7 · `usage.repository.ts:110-111` — `utcTimestampBound` throws `RangeError`, before the transaction, on an unparsable instant

`new Date("nonsense").toISOString()` throws `RangeError: Invalid time value`, and
`buildFilters` runs at `usage.repository.ts:130` — *outside* `withTenant`, so the
`transaction_error` logging in `base.repository.ts` never sees it. Unreachable through HTTP: I
confirmed `iso8601Schema` (`z.string().datetime({ offset: true })`) rejects `2026-01-01T00:00:00`
(no offset), `2026-02-30T00:00:00Z` and `2026-13-01T00:00:00Z`, so every accepted value parses.
Previously an unparsable value produced an Invalid Date bind and a database-side error instead.
Both end as a 500; no error-contract regression. No test covers it.
**Disposition: accept as unreachable; worth one line in the doc comment.**

#### L-8 · `constants.ts:73-77` — `DATABASE_SESSION_SETTINGS` mixes setting *names* with a setting *value*

`TENANT_ID` and `TIME_ZONE` are GUC names; `TIME_ZONE_UTC` is a value. A reader looking for
"the settings we write" gets three entries for two settings. Cosmetic.
**Fix:** `DATABASE_SESSION_SETTINGS = { TENANT_ID, TIME_ZONE }` and
`DATABASE_SESSION_VALUES = { TIME_ZONE_UTC }`, or nest. **Disposition: reviewer's preference,
not required.**

---

### NIT

- **N-1 · `docs/plans/…s-018….md` §11** — *"There is **no** `apps/usage-service/vitest.config.ts`"*.
  There is an `apps/usage-service/vitest.config.mjs` (last touched in `97a4603`, unmodified
  here). Its `include: ["tests/**/*.test.ts"]` has no integration exclusion, so the plan's
  **conclusion** — integration tests run inside `pnpm test` and in CI's `Unit Tests` step — is
  correct; only the premise as stated is not. Worth fixing so the next reader does not conclude
  the package is config-less.
- **N-2 · `usage.timezone.integration.test.ts:108`** — `slice(0, "2026-01-01".length)` uses a
  sample date as a length. `ISO_DATE_LENGTH = 10` (or
  `.toISOString().split("T")[0]`) reads better.
- **N-3 · `usage.repository.unit.test.ts:183`** — `indexOf(zoneCall as never)`. `as never` is
  an unchecked cast to silence the signature; `queryRaw.mock.calls.indexOf(zoneCall as
  unknown[])` or comparing indices computed by `findIndex` avoids it.
- **N-4 · `CLAUDE.md:225`** — the bolded *"CI cannot catch any of this"* is qualified correctly
  by the next sentence, but taken alone it is now untrue: `usage.timezone.integration.test.ts`
  pins its own non-UTC sessions and runs in CI's `Unit Tests` step, which is exactly how CI
  *will* catch it. Suggest *"CI's ambient session cannot expose this."*
- **N-5** — no test exercises a non-integral, non-half-hour offset input. `+05:30` covers the
  class and I verified independently that `+05:45` normalizes correctly in JS
  (`2026-01-01T00:00:00.000+05:45` → `2025-12-31T18:15:00.000Z`) and that a `+05:45` session
  zone (`Asia/Kathmandu`) is fixed by the change. No action needed.
- **N-6** — the new suite's tenant ids are not UUIDs (`s18-tz-<uuid>`), matching
  `rls.enforcement.integration.test.ts`'s `rls-a-<uuid>`. Consistent with precedent and
  irrelevant below the middleware. No action.

---

## Assessment of the three stated deviations from the approved plan

1. **Cast fragment in `usage.repository.ts:80`, not `constants.ts` (plan §6).** Rationale
   accepted on its merits: `constants.ts` is imported by `app.ts`, both controllers, both route
   modules, all three middleware and the validator (15 import sites), and adding
   `import { Prisma } from "@prisma/client"` there would pull the client into all of them. I
   confirmed the tracing-ordering rule is *not* implicated — `index.ts` imports only
   `startup.constants` and defers `./app` behind a dynamic import after `initTracing` — so this
   is a layering argument, not a startup one, and it is still a good one. **However**, the repo
   already has the strictly better form: SQL text as a plain string in `constants.ts`, wrapped
   in `Prisma.raw` at the repository (`auth-service/src/constants.ts:70` →
   `user.repository.ts:15`). That satisfies §6 *and* the rationale *and* fixes M-1 and M-2.
   **Verdict: deviation justified, but superseded — take the `Prisma.raw(constant)` form.**
2. **`app.tenant_id` promoted into `DATABASE_SESSION_SETTINGS`, both setting names now bound
   parameters, statement text is `SELECT set_config($1, $2, true)`.** Verified nothing depended
   on the old literal text: the only consumers of the string `app.tenant_id` are RLS policy
   bodies in `prisma/migrations/v1_0…/migration.sql:172-183` (unaffected — they read
   `current_setting`), the four other services' own hard-coded copies, and test-local constants.
   No test parses the repository's statement text; `usage.repository.unit.test.ts:166,178` now
   assert the **bound values**, which is stronger. I verified at runtime as `telemetry_app` that
   `SELECT set_config($1,$2,true)` sets the GUC and that RLS still fires (5 seeded rows visible
   with context, `rolsuper=f rolbypassrls=f`), and that `TimeZone` is a `context = user` GUC so
   no privilege is required. **Verdict: accepted, and an improvement.** Residual: L-2's
   duplicate at `rls.enforcement.integration.test.ts:24`.
3. **Editing `.claude/rules/tenant-isolation.md` although §6 said not to.** **I agree with the
   decision** — see L-5 for the reasoning and for the one wording correction the new text needs.
   The factual content is accurate; the rationale clause is not.

---

## What I verified — by execution

### Compile-time gate, `--force` on all four tasks

| Task | Result |
|---|---|
| `pnpm typecheck --force` | **13 successful, 13 total**, `0 cached` |
| `pnpm build --force` | **13 successful, 13 total**, `0 cached` |
| `pnpm lint --force` | **13 successful, 13 total**, `0 cached`; 0 errors, 14 warnings (all pre-existing, proven below) |
| `pnpm test --force` | `11 successful, 13 total`; `Failed: @telemetry/usage-service#test`. Turbo cancelled `@telemetry/auth-service#test` mid-run, so I re-ran it standalone |

Per-package test status (13/13 accounted for; `@telemetry/web` runs
`vitest run --passWithNoTests`):

| Package | Files | Tests |
|---|---|---|
| `@telemetry/gateway` | 8 | 38 passed |
| `@telemetry/auth-service` | 15 | 164 passed |
| `@telemetry/usage-service` | 19 | **1 failed / 224 passed (225)** — see attribution |
| `@telemetry/usage-service` *(T-036 file excluded)* | 18 | **198 passed** |
| `@telemetry/worker-service` | 4 | 19 passed |
| `@telemetry/billing-service` | 4 | 18 passed |
| `@telemetry/analytics-service` | 4 | 18 passed |
| `@telemetry/web` | — | passed (no tests) |
| `@telemetry/shared-config` | 1 | 4 passed |
| `@telemetry/shared-logger` | 1 | 4 passed |
| `@telemetry/shared-tracing` | 1 | 2 passed |
| `@telemetry/shared-types` | 1 | 7 passed |
| `@telemetry/shared-utils` | 1 | 18 passed |
| `@telemetry/shared-validation` | 1 | 15 passed |

Task-scoped: `usage.repository.unit.test.ts` 23/23; `usage.timezone.integration.test.ts`
16/16; `rls.enforcement.integration.test.ts` **7/7** (the regression surface most at risk —
unchanged and still green).

**Lint warnings are pre-existing, proven.** All 14 are in two files:
`apps/usage-service/tests/ingestion.service.unit.test.ts` (4 ×
`no-unsafe-assignment`) and `apps/auth-service/tests/auth.service.unit.test.ts` (10 ×
`no-misused-promises`). `git status --porcelain <file>` is empty for both and
`git log -1 <file>` is `b0f6921`, i.e. two commits before base `3374cf9`. Zero lint problems in
any S-18 file.

**`prettier --check` not run as a gate (S-12), but I bounded it.** All five S-18 files fail
prettier — and so do untouched peers (`src/controllers/usage.controller.ts`,
`tests/rls.enforcement.integration.test.ts`), and so do the four modified files *as they exist
at `3374cf9`* (I extracted them with `git show 3374cf9:<path>` and checked those copies).
Pre-existing, not a regression; the new file matches its neighbours' 2-space style, and
`base.repository.ts` stayed tab-indented as the surrounding file is.

### The red `pnpm test` — attribution re-derived independently

Exactly one failure, `tests/usage.integration.test.ts` → *"B8 applies a half-open range"*:

```
- Expected            + Received
  "boundary.at-lower-bound",
- "boundary.below-upper-bound",
+ "boundary.below-lower-bound",
```

That file is untracked T-036 work. I confirmed the mechanism rather than accepting it:
`integration.fixtures.ts:198-199` renders
`Prisma.sql\`SELECT (${new Date(from)}::timestamp)::text …\`` — a bound JS `Date` (hence
`timestamptz`) cast to `timestamp`, which is *the defect itself*, re-derived. On this
`Asia/Kolkata` session it returns the +05:30-shifted bound (`2026-01-01 05:30:00`; I measured
`'2026-01-01T00:00:00.000Z'::timestamptz::timestamp` → `2026-01-01 05:30:00`), B8 seeds its four
probe rows relative to that, and then requests the true UTC window — so `below-lower-bound`
(shifted bound − 1 ms) now falls *inside* `[from, to)` and `below-upper-bound` falls outside.
The failure is a consequence of the fixture helper, not of S-18's production change. Excluding
that one file: **18 files / 198 tests passing**, matching the figure I was given.

`readEffectiveRangeBounds` is therefore a *second* live instance of the defect class, sitting in
a test helper. Out of scope here; §9 items 1-4 of the S-18 plan already prescribe the fix and
assign it to T-036.

### The fix is correct in every input form and every session zone (item 1 of the brief)

Seeded five boundary rows through the owner connection, queried as `telemetry_app`
(`rolsuper=f, rolbypassrls=f`, 5 rows visible under RLS with tenant context set), inside a
`$transaction` mirroring `withTenant`. Intended answer:
`["at-from","interior","ms-before-to"]`.

| Session `TimeZone` | shipped (`Date` bind) | **as landed** (`Z` input) | **as landed** (`+05:30` input) | half-fixed (raw `+05:30` + cast) |
|---|---|---|---|---|
| `UTC` | correct | correct | correct | **wrong** |
| `Asia/Kolkata` (+05:30) | **wrong** (`at-to` in, `at-from` out) | correct | correct | **wrong** |
| `America/New_York` (−05:00) | **wrong** (`ms-before-from` in, `ms-before-to` out) | correct | correct | **wrong** |
| `Asia/Kathmandu` (+05:45) | **wrong** | correct | correct | **wrong** |

So: the landed fix is invariant across all four zones **and** across `Z` / offset-bearing
input; the half-fixed shape the implementer claims is unrepresentable is both representable
(M-1) and wrong everywhere, including UTC. Supporting single-value measurements, session
`Asia/Kolkata`:

```
'…T00:00:00.000Z'::timestamp(3)      → 2026-01-01 00:00:00
'…T00:00:00.000+05:30'::timestamp(3) → 2026-01-01 00:00:00   ← offset discarded
'…T00:00:00.000-08:00'::timestamp(3) → 2026-01-01 00:00:00   ← offset discarded
'…T00:00:00.000+05:45'::timestamp(3) → 2026-01-01 00:00:00   ← offset discarded
'…T00:00:00.000Z'::timestamptz::timestamp(3) → 2026-01-01 05:30:00
```

Through Prisma 6.19.3: `pg_typeof(${new Date(...)})` → `timestamp with time zone`;
`pg_typeof(${isoString})` → `text`; `pg_typeof(${isoString}::timestamp(3))` →
`timestamp without time zone`. Rendered predicate as landed:
`… "periodStart" >= $2::timestamp(3) AND "periodStart" < $3::timestamp(3) …` with
`values = [tenantId, "2026-01-01T00:00:00.000Z", "2026-01-08T00:00:00.000Z"]` — both bounds are
strings, neither is a `Date`, and both the count query and the page query embed the same
`filters` fragment (`usage.repository.ts:132,136`).

### The `withTenant` pin (item 2)

- **Ordering preserved.** `base.repository.ts:110` (tenant) precedes `:111` (zone).
  `usage.repository.unit.test.ts:170` asserts `findIndex(isSetConfigCall) === 0`, i.e. nothing
  at all precedes the tenant statement, and `:166-167` assert its bound name and value.
- **Transaction-local, no leak — stronger than the test asserts.** I forced a single physical
  connection (`connection_limit=1`) so the follow-up query provably reuses the transaction's
  backend, and confirmed `pg_backend_pid()` identical throughout:
  `baseline tz=Asia/Kolkata` → `inside tx tz=UTC` → `after COMMIT tz=Asia/Kolkata` → *(second
  transaction, forced rollback)* → `after ROLLBACK tz=Asia/Kolkata, app.tenant_id=''`. Both
  settings revert on both paths. (The test's own non-leak assertion at
  `usage.timezone.integration.test.ts:385` reads through the same `PrismaClient` but not
  necessarily the same physical connection, so it is suggestive rather than conclusive; the
  underlying guarantee is `is_local = true` and I confirmed it directly.)
- **RLS context still applies.** `rls.enforcement.integration.test.ts` 7/7 green;
  independently, with `set_config($1,$2,true)` as the tenant statement, `telemetry_app` saw
  exactly the 5 seeded rows and `current_setting('app.tenant_id')` read back the tenant id
  inside the transaction. Live catalog: `telemetry_app` → `rolsuper=f, rolbypassrls=f`;
  `UsageLine` → `relrowsecurity=t, relforcerowsecurity=t`, 1 policy.
- **No new privilege or injection surface.** `TimeZone` is `context = user, vartype = string`
  in `pg_settings`, so no elevation is involved; both setting names are frozen module constants
  and every value is a bound parameter.

### The changed assertion (item 4)

`usage.repository.unit.test.ts:114` at base asserted
`expect(rowsSql.values[1]).toEqual(new Date(FROM))` — it pinned the defect and had to change.
The replacement is **strictly stronger**, not weakened. I rendered the pre-fix predicate and
ran the *new* assertion set against it: 6 of 7 assertions fail (text lacks both casts;
`values[1]`/`values[2]` are not the ISO strings; `values[1]` is a `Date`; the offset-bearing
and `Z` bounds are not `toBe`-identical). These are pure SQL-text/bound-value assertions with
no database involved, so they are red on unfixed code **on any server, including a UTC
session** — which is exactly what the old assertion could not achieve. The surviving
pre-existing test at `:198-201` still passes because `toContain('"periodStart" >= $2')` is a
substring of `>= $2::timestamp(3)`.

### The mock refactor (item 5)

Behaviour-preserving. `isSetConfigCall` dispatches on `String(args[0])`: for a tagged-template
call `args[0]` is the `TemplateStringsArray`, and `String([...])` joins to
`"SELECT set_config(,, ,, true)"` — contains both `set_config` and `", true)"`; for the two
aggregate calls `args[0]` is a `Prisma.Sql`, and `String(sql)` is `"[object Object]"` (measured),
so misclassification is not possible. The default result set went from `[[], [{total:0}], []]`
to `aggregateResults(0, [])` = `[[{total:0}], []]`, which is the same two aggregate answers with
the `set_config` slot removed. Both locator helpers **throw** when the call is absent
(`setConfigAt`, `aggregateSqlAt`) and the dispatcher throws on result exhaustion, so nothing
passes vacuously. Every pre-existing test in the file still passes for the same reason as
before — the only pre-existing test whose *meaning* changed is the one at `:162`, which gained
the two stronger bound-value assertions. Caveat recorded as M-2.

### Red-first honesty (item 6)

- **3 unit reds** — reproduced by construction: T1 and T2 fail on the pre-fix predicate shape
  (above), and the new zone-pin test fails through `setConfigAt`'s
  `Expected a set_config statement at index 1` throw, since pre-fix `withTenant` issues one
  `set_config`. Matches §16 verbatim.
- **8 of 16 integration cases red, UTC legs green** — the split is real. The file has exactly
  16 cases (1 fixture + 3 zone-pin-vacuity + 3×3 behavioural `it.each` + 1 cross-zone + 1
  `withTenant` pin + 1 no-regression). From the measured table above, the shipped predicate is
  correct under `UTC` and wrong under both `Asia/Kolkata` and `America/New_York`, so the three
  `it.each` groups contribute 6 reds and 3 greens; the cross-zone case and the `withTenant`
  pin case add 2 more reds → **8 red / 8 green**, and the named reds in §16 are exactly those
  8. The UTC-green half is the whole justification for pinning a session per case, and it
  holds.
- **T6 green before and after** — established by reasoning, not execution (I could not run the
  pre-fix code without modifying the tree): `WIDE_RANGE` is `2025-12-01Z`→`2026-03-01Z` while
  the fixture instants span `2025-12-31T23:59:59.999Z`→`2026-02-01T00:00:00Z`, margins far
  larger than any tested offset, so no row can cross either edge under a ±5:45 shift. Labelled
  as reasoning.
- **T7 index coverage** — reproduced independently: 50 000 rows, `ANALYZE`,
  `enable_seqscan=off`, session `Asia/Kolkata`, parameterized cast →
  `Bitmap Index Scan on ip_scoped_idx` with
  `Index Cond: ((tenantId = …) AND (periodStart >= (…)::timestamp(3) …) AND (periodStart < …))`,
  and the query returned `1440` = exactly one day of minute-spaced rows, so the bounds are right
  as well as indexed.

### Claims the change adds (item 7) — re-derived

| Claim | Where | Result |
|---|---|---|
| All 20 application timestamp columns are `timestamp(3) without time zone`; the only `timestamptz` columns are `_prisma_migrations`' | `CLAUDE.md:214-216`, `constants.ts:68`, `base.repository.ts:58` | **TRUE.** `information_schema.columns` over `table_schema='public'`: 20 `timestamp without time zone` (all `datetime_precision=3`) + 3 `timestamp with time zone`, all three in `_prisma_migrations`. Table/column list matches the plan's exactly |
| A bound JS `Date` is `timestamptz`; a bound ISO string is `text`; the cast string is `timestamp without time zone` | `CLAUDE.md:196-201`, `usage.repository.ts:85-88` | **TRUE**, measured through Prisma 6.19.3 |
| Four-zone row sets `{r2,r3,r4,r5}` / `{r4,r5,r6}` / `{r1,r2,r3,r4}` / `{r4,r5,r6}` | `CLAUDE.md:200-203` | **TRUE**, reproduced exactly with a prepared statement over the plan's six-row fixture |
| Prisma's ORM path is UTC-stable across four zones, inside and outside `$transaction` | `CLAUDE.md:203-206` | **Behaviour TRUE** (8/8 combinations returned `{r2,r3,r4,r5}`). **Mechanism unverified** — see L-4 |
| text → `timestamp` cast discards an offset rather than converting it | `CLAUDE.md:206-212`, `usage.repository.ts:98-102` | **TRUE** for `Z`, `+05:30`, `-08:00` and `+05:45` |
| Offsets are legal input (`iso8601Schema` = `z.string().datetime({ offset: true })`) | `CLAUDE.md:209`, `usage.repository.ts:96` | **TRUE.** Read `packages/shared-validation/src/index.ts:20`; ran the schema — accepts `Z`/`+05:30`/`+05:45`/`-08:00`, rejects naive, `2026-02-30T…Z` and `2026-13-01T…Z` |
| Omitting the cast fails loudly with `42883` | `CLAUDE.md:212-213`, `usage.repository.ts:107-108` | **Substance TRUE** (`42883`, surfaced by Prisma as `P2010`). **Quoted message wrong** — M-3 |
| Equality fails worse than a range: right row / **no row** / **wrong row** | `CLAUDE.md:217-221` | **TRUE.** `WHERE "periodStart" = $1` with a bound `Date`: `UTC` → `{2}`, `Asia/Kolkata` → `{}` (NULL), `America/New_York` → `{1}`. The keys named are real: `Invoice @@unique([tenantId, periodStart, periodEnd])` and `Meter`'s `activeFrom` |
| The output side is safe: `DATE_TRUNC` over a naive column is zone-invariant; `AT TIME ZONE 'UTC'` on the **column** produces `timestamptz` and shifts boundaries, on the **parameter** it is correct | `CLAUDE.md:221-225`, `usage.repository.ts:48-56`, `usage.repository.unit.test.ts:303-314` | **TRUE.** `DATE_TRUNC('day',"periodStart")` → `2026-01-01 00:00:00` under both `Asia/Kolkata` and `UTC`; `pg_typeof(col AT TIME ZONE 'UTC')` → `timestamp with time zone` and its `DATE_TRUNC` renders `2026-01-01 00:00:00+05:30`; `pg_typeof(tstz AT TIME ZONE 'UTC')` → `timestamp without time zone` → `2026-01-01 00:00:00` |
| `postgres:16-alpine` defaults `TimeZone` to `UTC`, source `configuration file`, so CI cannot see the defect | `CLAUDE.md:225-229`, `base.repository.ts:60`, `docs/development-setup.md` | **TRUE.** `docker exec postgres-db psql -Atc "show timezone"` → `UTC`, `source = configuration file`, `PostgreSQL 16.14 … musl`. `docker/docker-compose.yml:22` and `.github/workflows/ci.yml:41` both use that image, and neither sets `TZ`/`PGTZ`. See N-4 on the bolded universal |
| `options=-c timezone=…` works; a bare `?timezone=…` is accepted and silently ignored | `CLAUDE.md:229-230`, `docs/development-setup.md`, `usage.timezone.integration.test.ts:34-37,196-197` | **TRUE.** Same URL, four spellings: baseline → `Asia/Kolkata`; `options=-c timezone=UTC` (in the `URLSearchParams` encoding the test actually produces, `options=-c+timezone%3DUTC`) → `UTC`; `?timezone=UTC` → `Asia/Kolkata`; `?TimeZone=UTC` → `Asia/Kolkata`. No error in either negative case |
| usage-service pins the zone; the other four `TenantScopedRepository` copies do not | `CLAUDE.md:232-235`, `.claude/rules/tenant-isolation.md:18-19` | **TRUE.** `worker/billing/analytics/auth`-service `base.repository.ts:98`/`:105` still issue the single literal `set_config('app.tenant_id', …, true)` |
| Host `postgresql.conf` is `Asia/Kolkata`, taken from `initdb` | `docs/development-setup.md` | **TRUE** for this host: `pg_settings` → `TimeZone = Asia/Kolkata`, `source = configuration file`, `sourcefile = /etc/postgresql/16/main/postgresql.conf`, `boot_val = GMT`. PostgreSQL 16.13 on `127.0.0.1:5432`; the `postgres:16-alpine` container publishes no host port, so the suites do reach the host instance (plan §3.1 confirmed) |
| Only `usage.repository.ts` had a production timestamp comparison | plan §4.1 | **TRUE** at base. My own sweep of `$queryRaw`/`$executeRaw`/`Prisma.raw` across `apps/*/src`, `packages/*/src`, `prisma/*.ts` finds only `set_config` statements, auth-service's two `text`-keyed resolvers, and usage-service's two aggregates. The only other timestamp comparison anywhere is `auth.service.ts:127` (`expiresAt.getTime() <= Date.now()`), which is JavaScript-side on a value Prisma returns as a UTC-interpreted `Date` — unaffected by the session zone, which supports `docs/development-setup.md`'s "nothing is broken by a non-UTC session today" |

### CI wiring

`.github/workflows/ci.yml` applies migrations (line ~78) and checks migration status *before*
`Lint` → `Type Check` → `Unit Tests` (`pnpm test`), so the new integration file will find a
migrated database and a `telemetry_app` role. Job-level `DATABASE_URL`/`DIRECT_DATABASE_URL` do
not reach turbo tasks (documented at `ci.yml:24-29`), so `tests/setup.ts:5-8` supplies both, and
its values match the CI service container. `Verify RLS Is Enforcing` still runs
`rls.enforcement.integration.test.ts` outside turbo. No skip guard exists in either integration
file, so a missing database hard-fails rather than passing vacuously — the correct shape, and
the same one as `apps/auth-service/tests/rls.integration.test.ts`'s `beforeAll` throw.

### Database state

Every write probe of mine ran inside `BEGIN … ROLLBACK` or against `ON COMMIT DROP` temp tables,
except two Prisma probes that seeded a uniquely-named tenant plus 5-6 `Event`/`UsageLine` rows
through the owner connection and deleted them in a `finally` block; both reported
`usageLine=0 tenant=0` afterwards. Post-review: `UsageLine = 0`, `Event = 0`,
`pg_db_role_setting = 0`, no `s18*`/`rev*` database or role, `show timezone` still
`Asia/Kolkata`, `postgresql.conf` untouched. Probes run: `pg_settings`,
`information_schema.columns`, `pg_roles`, `pg_class`, `pg_policy`, the six-row range/equality
prepared statements, the `ALTER`-free cast/`AT TIME ZONE` direction tests, the 50 000-row
`EXPLAIN`, and five Node/Prisma scripts (bind types, rendered SQL, multi-zone predicate
comparison, connection-pin spellings, ORM invariance).

**One residue I must declare.** Running the required root gate (`pnpm test --force`) caused
`apps/auth-service`'s integration suite to leave one `Tenant` + one `User` behind
(`owner-…@auth-integration-….test`). One identical pair from a *prior* run already existed at
`3374cf9` (created 07:42 UTC, before this review began), so this is the suite's normal
behaviour, not something S-18 introduced. I attempted to delete the pair my own run created
and the action was **denied by the permission system**; I did not work around it. Current state:
2 `Tenant`, 2 `User`, 0 of everything else. Neither pair can affect S-18's tests, which key on
freshly generated `s18-tz-<uuid>` ids.

---

## What I could not verify, and why

- **Production blast radius.** Production's `postgresql.conf` `TimeZone` and any
  `pg_db_role_setting` override are outside this environment. `pg_db_role_setting` is 0 rows
  *here*. R-10 stands open.
- **`ALTER ROLE … SET TimeZone` overrides `ALTER DATABASE … SET TimeZone`.** This claim is
  repeated in `docs/development-setup.md` and plan §3.7. I did **not** re-verify it: it requires
  creating a role and a database and opening a *new* session (the effect is not observable
  inside a rolled-back transaction), and I judged that outside a read-only review. Unverified
  by me; verified by the plan's own record.
- **Behaviour behind a real connection pool.** PgBouncer is referenced only in
  `docs/epics/epic-3-shared-service-infra.md` and is not running here. I closed the part that
  matters most — no GUC leak on a reused physical backend (`connection_limit=1`,
  identical `pg_backend_pid()`) — but a transaction-pooling proxy that multiplexes statements
  across backends is untested.
- **Index behaviour at production row counts.** 50 000 rows on a temp table with a matching
  index; not production cardinality or statistics. R-9 stands.
- **Pre-fix behaviour of the landed test files, executed as such.** I could not run the new
  suites against pre-fix source without modifying the working tree, which is outside my
  mandate. Instead I reconstructed the pre-fix predicate and ran it (a) through the new unit
  assertions and (b) against seeded rows in four session zones. That establishes the same
  discrimination, but the reds in §16 are re-derived rather than re-executed in situ.
- **T6's pre-fix greenness** — reasoning from the window margins, not execution (see above).
- **`pnpm format:check`** — deliberately not run as a gate (S-12: it has never passed). I
  bounded it instead by comparing the S-18 files against untouched peers and against their own
  base-commit versions.

---

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| M-1's exported fragment lets the offset-dependent bug back in from another module | **Fix before commit.** One `export` keyword; measured to be exploitable |
| M-2's unit assertion is blind to a `::timestamptz`/`::timestamp(0)` mutation | **Fix before commit.** Integration coverage does catch both mutants, so this is a test-quality gap, not an exposure |
| M-3's misquoted error message in an authoritative file | **Fix before commit.** Two lines |
| Four-way divergence: `TenantScopedRepository` is byte-identical in worker/billing/analytics and near-identical in auth, and only usage-service now has the pin | **Accept for this commit** (plan D-2, and it is the same split S-8-out-of-S-4 and S-10-out-of-S-7 already established). Recommend a `known-gaps.md` entry — see below |
| `readEffectiveRangeBounds` (`integration.fixtures.ts:198`) is a second instance of the defect class, in a test helper | **Out of scope** (T-036's untracked file). Plan §9 items 1-4 already assign it. Do not let it land asserting the shifted bound |
| `INTEGRATION_BOUNDARY_PROBE`/`RANGE_FROM` rationale text in `integration.constants.ts:65-81` asserts the defect as a property of the system and is now false | **Out of scope** (T-036). Plan §9 item 4 covers it |
| One extra round trip per tenant-scoped transaction | Accept (L-6) |
| `RangeError` on an unparsable instant, raised outside `withTenant`'s handler | Accept — unreachable through the validated HTTP path (L-7) |
| `pnpm test` remains red on this tree until T-036 resumes | **Accept, but it blocks Gate 7 mechanically.** CI's `Unit Tests` step runs `pnpm test`; if S-18 is committed while T-036's files are untracked they will not be in the commit, so CI will be green on the committed tree. Confirm the commit contents deliberately exclude the three T-036 test files, or land §9 first |

## Recommended for `.claude/rules/known-gaps.md` (out of scope to fix here)

The brief asks explicitly, so, on the merits: **yes, the `TenantScopedRepository` duplication
belongs in `known-gaps.md`** once T-036 releases the file. It now satisfies the bar that S-8 and
S-10 set — a divergence created deliberately by a scoped fix, invisible from any single file,
and one that a future reader will mistake for drift. Suggested content: five copies of
`withTenant` exist (`usage`, `worker`, `billing`, `analytics` at
`src/repositories/base.repository.ts:98`, plus `auth-service` at `:105`); as of S-18 only
usage-service pins the session `TimeZone`, so a raw date predicate written in any of the other
four inherits the S-18 defect with no local sign of it; and auth-service's resolvers
(`user.repository.ts:247,261`) run *outside* tenant context, so the pin would not cover them
even if copied. Fix direction: either roll the pin to all five, or take plan D-3 (connection-level
`options=-c timezone=UTC` with a `.refine` in each `EnvSchema` so a missed site fails closed —
a bare `?timezone=` is silently ignored, which I re-measured).

Two smaller items also worth capturing there, both pre-existing rather than S-18's:

- `"app.tenant_id"` is defined in seven places (two service constants modules, two test files,
  four hard-coded copies) and `.claude/rules/constants.md` asks for promotion to a shared
  package before the third copy.
- `apps/auth-service`'s integration suite leaves a `Tenant`/`User` pair behind on every run, so
  the database accumulates test data across gate runs (observed twice, once from a pre-review
  run). It also contradicts nothing, but it makes "the database was left as found" harder to
  assert for every future reviewer.

---

## Verdict

**CONDITIONAL** — approve for commit once **M-1**, **M-2** and **M-3** are addressed. No
re-run of QA is needed for any of the three: M-1 and M-3 are comment/doc edits plus removing one
`export`, and M-2 is a strengthened assertion in a suite I have already run. The production
change itself — `utcTimestampBound` at `usage.repository.ts:110-111` and the transaction-local
zone pin at `base.repository.ts:110-111` — is correct, is proven correct in both offset
directions, at a non-integral offset, for `Z` and offset-bearing input, under a
`NOSUPERUSER NOBYPASSRLS` role, with RLS enforcing, with the tenant statement still first, with
no GUC leak past commit or rollback, and with the `(tenantId, periodStart, periodEnd)` index
retained.

---

# Round 2

**Gate 4 round 2 (Senior Reviewer, pre-QA) · base `3374cf9` · nothing committed · this
reviewer wrote no code, wrote no part of round 1, and applied no fix.**

Scope: **only** the response to round 1's `CONDITIONAL` (M-1, M-2, M-3, L-1, L-2, L-4, L-5),
the deviations recorded in the plan's *Gate 3 rework* record, and a check that nothing else
regressed. The underlying defect and fix were re-proved in round 1 across four session zones
for both `Z` and offset-bearing input; I did not re-derive that, as instructed.

Out of scope and untouched, confirmed by `git status --porcelain` being byte-identical to the
list I was given before and after this review: `tests/usage.integration.test.ts`,
`tests/integration.constants.ts`, `tests/integration.fixtures.ts`,
`.claude/rules/known-gaps.md`, `docs/plans/t-036-*.md`.

---

## Findings

### M-1 · **partially resolved** — the mechanical exposure is closed; the restated claim is
### still one notch stronger than what execution supports

`apps/usage-service/src/repositories/usage.repository.ts:117-119` (and the same wording at
`:86-88`, and in `docs/plans/s-018-usage-summary-range-timezone.md:1156-1157`):

> the cast fragment is not exported, so the half-fixed shape cannot be composed from outside
> this module

**What is now true, verified four ways.** The fragment is genuinely unreachable as a *symbol*:

| Route | Result |
|---|---|
| `import` from source | `tsc --noEmit` on an isolated repro of the same shape → `error TS2459: Module '"./a"' declares 'PRIVATE_CAST' locally, but it is not exported.` The plan's `TS2459` parenthetical is the right code |
| re-export barrel | `apps/usage-service/src/repositories/index.ts` exports `TenantScopedRepository`, `UsageRepository` and three types — nothing else |
| built `.d.ts` | after `pnpm build --force`, `dist/src/repositories/usage.repository.d.ts` declares only the class and the three interfaces; `grep UTC_NAIVE dist/.../usage.repository.d.ts` → no match |
| built `.js` | `dist/src/repositories/usage.repository.js:50` is a bare `const`, no `export`, no `exports.` assignment |

**What is still false.** The claim is about the *shape*, not the symbol, and the shape needs
no symbol at all. Executed (`Prisma` 6.19.3, no usage-service import of any kind):

```
Prisma.sql`WHERE "periodStart" >= ${rawFrom}::timestamp(3)`
  → text:   WHERE "periodStart" >= $1::timestamp(3)
     values: ["2026-01-01T05:30:00.000+05:30"]
```

byte-identical SQL text to the in-module path. And via the *new* public constant, using the
`Prisma.raw(<frozen constant>)` pattern this repo sanctions (`DATABASE_SQL` is exported from
`src/constants.ts:96` and from `dist/src/constants.d.ts:85`):

```
Prisma.sql`WHERE "periodStart" >= ${rawFrom}${Prisma.raw(DATABASE_SQL.UTC_NAIVE_TIMESTAMP_CAST)}`
  → WHERE "periodStart" >= $1::timestamp(3)   values ["2026-01-01T05:30:00.000+05:30"]
```

Rendered against the live server (session `Asia/Kolkata`), the two bounds differ as round 1
measured: half-fixed → `2026-01-01 05:30:00`, correct → `2026-01-01 00:00:00`. The
offset-discard is zone-independent, so this shape is wrong in **every** zone including UTC,
and the `TimeZone` pin in `withTenant` does not mask it.

So the export removal raised the cost of the mistake from *one `import`* to *typing eight
characters*, which is worth having, but "cannot be composed from outside this module" is not
what the compiler enforces. What it enforces is that the **fragment is not importable**.

**Concrete fix — `usage.repository.ts:117-119`, replace:**

> the cast fragment is not exported, so the half-fixed shape cannot be composed from outside
> this module, and inside it `utcTimestampBound` is the only path to the cast

**with:**

> the cast fragment is not importable outside this module — that much is compiler-enforced
> (`TS2459`) — and `utcTimestampBound` is the only in-module path to it. The half-fixed
> *shape* is still writable anywhere, here or in another file, because the cast is only SQL
> text: `${iso}::timestamp(3)` needs no import. The rule "every timestamp bound goes through
> `utcTimestampBound`" is carried by review, not by the type system.

Apply the same narrowing at `:86-88` and at plan `:1156-1157`.

**Disposition — and an explicit loop-discipline note.** This is the **same class** as round
1's M-1: the change asserting a containment guarantee about itself that execution does not
support. It is materially weaker than round 1's version (the measured, importable trap is
gone; what remains is one clause in a code comment, and the same paragraph already concedes
that the in-module invariant "lives in this file's reviewability, not in the type system").
Per `/ship`'s loop discipline I am **not** recommending a third implementer→reviewer cycle.
This is a two-clause docs edit with the replacement text supplied verbatim; it needs no
re-QA and no re-review. **The user should adjudicate:** apply the sentence above, or accept
the current wording knowingly, then commit.

### M-2 · **resolved** — circularity gone, and I re-ran the mutants myself

`tests/usage.repository.unit.test.ts:70,72` are hard literals (`"::timestamp(3)"`,
`"::timestamptz"`); the file imports `DATABASE_SESSION_SETTINGS`, `USAGE_SUMMARY_CONSTANTS`
and `USAGE_SUMMARY_GRANULARITY` and **not** `DATABASE_SQL` — `grep -n "DATABASE_SQL"` on the
test file returns nothing, so the expectation can no longer move with the production
constant.

I mutated `src/constants.ts:97` and ran `vitest run tests/usage.repository.unit.test.ts` for
each value, then restored the file and verified `sha256sum -c` (`src/constants.ts: OK`):

| `UTC_NAIVE_TIMESTAMP_CAST` | round 1 (derived assertion) | **round 2 (literal assertion)** |
|---|---|---|
| `::timestamp(3)` | PASS | 23 passed |
| `::timestamptz` | PASS | **1 failed \| 22 passed** |
| `::timestamp(0)` | PASS | **1 failed \| 22 passed** |
| `::timestamp` | PASS | **1 failed \| 22 passed** |

Each red is the test whose title names the failure mode ("binds both range bounds as
UTC-naive timestamps, not as timestamptz Dates"), with
`expected '…' to contain '"periodStart" >= $2::timestamp(3)'`. The implementer's "all three
now red" is confirmed by my own execution; the "all three passed the derived form" half rests
on round 1's measurement and the plan's, not mine.

**On `.claude/rules/constants.md`: the literal is the right call here.** That rule targets a
value restated in several places and drifting apart; this assertion's subject *is* the wire
format, so importing the constant makes the test assert `X === X`. The precedent already in
the repo is the same: `usage.repository.unit.test.ts` asserts `'"tenantId" = $1'` and
`not.toContain("AT TIME ZONE")` as literals too. The declaration comment at `:57-69` states
the exemption and its reason explicitly, which is what the rule asks of an exception. Also
correct that the value's *rationale* moved into `src/constants.ts:85-95` — I verified the two
measurements quoted there: `'2026-01-31T23:59:59.999Z'::timestamp(0)` → `2026-02-01 00:00:00`
and the window predicate flips (`< '2026-02-01'` is `f` at `(0)`, `t` at `(3)`).

### M-3 · **resolved**, and the new qualification is TRUE — verified in six forms

Both documents now state the operand-order rule rather than quoting one direction
(`CLAUDE.md:210-217`, `usage.repository.ts:124-133`). Measured against the live server, twice
per direction:

```
psql   '…'::timestamp(3) >= '…'::text          → 42883 operator does not exist: timestamp without time zone >= text
psql   '…'::text <= '…'::timestamp(3)          → 42883 operator does not exist: text <= timestamp without time zone
psql   PREPARE p1(text) AS … "periodStart" >= $1  → 42883 … timestamp without time zone >= text
psql   PREPARE p2(text) AS … $1 <= "periodStart"  → 42883 … text <= timestamp without time zone
Prisma $queryRaw `… WHERE "periodStart" >= ${iso}` → P2010 meta.code "42883" "operator does not exist: timestamp without time zone >= text"
Prisma $queryRaw `… WHERE ${iso} <= "periodStart"` → P2010 meta.code "42883" "operator does not exist: text <= timestamp without time zone"
```

The Prisma legs ran against the real `"UsageLine"."periodStart"` column, not a scalar, so the
quoted message is the one this codebase's own predicate produces.

**The new load-bearing qualification checks out, including its stated mechanism.** I attacked
it the way it could have been wrong — the claim is that the *bind type*, not the missing cast,
is what makes the mistake loud:

```
SELECT pg_typeof('2026-01-01T00:00:00.000Z')                                  → unknown
SELECT '2026-01-01T00:00:00.000Z' >= '2026-01-01 00:00:00'::timestamp(3)      → t     (no error)
PREPARE p3 AS SELECT * FROM "UsageLine" WHERE "periodStart" >= '2026-01-01T00:00:00.000Z'  → PREPARE (no error)
$queryRawUnsafe(`… WHERE "periodStart" >= '2026-01-01T00:00:00.000Z'`)        → NO ERROR
SELECT '2026-01-01T05:30:00.000+05:30' >= '2026-01-01 05:30:00'::timestamp(3) → t     (offset discarded, silently)
```

So an in-text literal is `unknown`-typed, coerces, and — worse than the docs say — coerces by
*discarding* the offset, i.e. it is a third silent-wrong-answer path. The qualification is
correct and correctly scoped ("true for this codebase's `$queryRaw` path, not as a general
statement about PostgreSQL").

### LOWs taken — all four verified

- **L-1 · resolved and proven non-vacuous by my own run.**
  `tests/usage.timezone.integration.test.ts:322-330` asserts `rolsuper`/`rolbypassrls` for
  `current_user`, read in `beforeAll` through a `DATABASE_URL`-derived client, with
  `expect(appRole).toBeDefined()` first so a missing row fails rather than passing vacuously.
  Reproduced the implementer's falsification independently:
  `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/telemetry vitest run
  tests/usage.timezone.integration.test.ts` →
  `× asserts through the runtime role … AssertionError: role postgres is a superuser: expected
  true to be false`, `Tests 1 failed | 16 passed (17)`. Under the normal role: 17/17. The
  docstring at `:40-46` now states the claim *and* that it is checked, which is the shape
  `rls.enforcement.integration.test.ts` set.
- **L-2 · resolved.** `tests/rls.enforcement.integration.test.ts` imports
  `DATABASE_SESSION_SETTINGS.TENANT_ID` at 4 call sites, local `APP_TENANT_ID_SETTING` gone.
  **7/7 passing** in my `--force` run.
- **L-4 · resolved, and the scope extension (rework deviation 1) was right.** `CLAUDE.md:196`
  now labels the mechanism "**inference, not measurement**" with "do not restate the mechanism
  as fact", and `usage.repository.ts:105-108` carries the same hedge ("Why it differs is
  inferred, not measured … Either way the *behaviour* is established"). Extending L-4 to the
  repository comment was correct, not scope creep: had only `CLAUDE.md` been hedged, the
  unhedged generalisation would have survived in the source file, which is exactly the
  "false claim in a comment next to security-relevant code" case, and the two would have
  contradicted each other. Both now say only what round 1 measured (8/8 zone × transaction
  combinations returning `{r2,r3,r4,r5}`).
- **L-5 · resolved and accurate.** `.claude/rules/tenant-isolation.md:17-22` now reads "no
  statement against a tenant-scoped table may precede the RLS context, and a later addition
  inside `withTenant` must not displace it." That *is* the real invariant, and it is the one
  the code and tests enforce: `base.repository.ts:110` precedes `:111`;
  `usage.repository.unit.test.ts:186` asserts `findIndex(isSetConfigCall) === 0`, i.e. nothing
  whatsoever precedes the tenant statement; and the integration case at `:401-403` asserts
  `current_setting('app.tenant_id')` is the bound tenant inside the pinned transaction. The
  added scope sentence ("In usage-service only … a correctness layer, not an isolation one")
  is also true: `grep set_config apps/*/src/repositories/base.repository.ts` shows the pin
  only at `apps/usage-service/.../base.repository.ts:111`; the other four still issue the
  single literal `set_config('app.tenant_id', …, true)`.

### New in round 2

#### LOW · R2-1 · `docs/plans/s-018-usage-summary-range-timezone.md:1281,1285` — the rework's lint record undercounts the workspace warnings

The plan records `pnpm lint --force → 13 successful … 4 warnings` and "The 4 lint warnings are
all `no-unsafe-assignment` in `apps/usage-service/tests/ingestion.service.unit.test.ts`". My
`--force` run: **0 errors, 14 warnings** — those 4, plus **10** `no-misused-promises` in
`apps/auth-service/tests/auth.service.unit.test.ts:61,86,117,144,179,204,231,262,297,323`,
which is the same total round 1 reported. Nothing is counted against the change: both files
are untouched (`git status --porcelain` empty for each; `git log -1` → `b0f6921` and
`d68e719`, both before base `3374cf9`). But the plan travels with the commit as the gate
record, and as written it says the workspace has 4 warnings when it has 14.
**Fix:** `docs/plans/…:1281` → `13 successful, 13 total (0 cached), 14 warnings`, and `:1285`
→ "4 in `usage-service/tests/ingestion.service.unit.test.ts` + 10 in
`auth-service/tests/auth.service.unit.test.ts`, both files pre-existing and untouched".
**Disposition: fix with the commit; not a code issue.**

#### NIT · R2-2 · plan `:1046` still contains the reversed `42883` quotation

Slice 0's original record keeps `42883 operator does not exist: text >= timestamp without time
zone`. The rework section corrects it 150 lines later and says so, and preserving a round's
own record rather than editing it in place is the right policy (this review does the same).
But a `grep 42883` over the plan surfaces the wrong string first. **Fix:** one inline marker
at `:1046` — "(operands reversed; corrected in the rework record below)".

#### NIT · R2-3 · `base.repository.ts:23` and `.claude/rules/tenant-isolation.md:17` still quote the literal statement form

Both describe `set_config('app.tenant_id', tenantId)` while usage-service now issues
`SELECT set_config($1, $2, true)` with both the name and the value bound. Semantically
accurate, and still literally accurate for the other four services. Cosmetic; recorded so the
next reader is not surprised by the rendered text. **Disposition: accept.**

### Carried, unchanged, and correctly left per the brief

L-3 (duplicated `requireEnv`/`ADMIN_URL_FALLBACK`, wants a shared `tests/integration.env.ts`
coordinated with T-036), L-6 (extra round trip per `withTenant`), L-7 (`RangeError` outside
`withTenant`, unreachable through the validated HTTP path), L-8
(`DATABASE_SESSION_SETTINGS` mixes GUC names with a value), and N-1 through N-6 — including
N-4's bolded "CI cannot catch any of this", which is still qualified only by the following
sentence. All were explicitly left by the brief. Round 1's `known-gaps.md` recommendation
(five diverging `withTenant` copies; `"app.tenant_id"` defined in seven places; auth-service's
integration residue) stands unchanged — nothing in this round adds to or subtracts from it,
and `known-gaps.md` was correctly not opened.

---

## Deviations in the rework — assessed

1. **Hedging the ORM mechanism in `usage.repository.ts` as well as `CLAUDE.md`.** Justified —
   see L-4 above. The narrower alternative would have left a false claim in source.
2. **A third mutant (`::timestamp`).** Justified and reproduced red by me. It closes the one
   row of round 1's blindness table the brief did not name.
3. **`DATABASE_SQL`'s doc block records the precision rationale.** Justified: the value's
   correctness is exactly what M-2 showed was undocumented and untested, and I verified both
   measurements it quotes. The block is long but it is the first place a reader will look
   before changing `(3)`.
4. **`rls.enforcement.integration.test.ts` edited although §6 excluded it** — authorised by
   the rework brief (L-2), 4 mechanical call sites, suite still 7/7.

Round 1's three original deviations are unchanged in substance, and its objection to the first
is now moot: the cast text lives in `src/constants.ts` as a plain string with no
`@prisma/client` in that import graph, so §6 is satisfied *and* the stated layering rationale
is preserved. `DATABASE_SESSION_SETTINGS` (deviation 2) still works end to end — RLS 7/7 and
the timezone suite reads both GUCs back inside the transaction. Deviation 3's wording is now
corrected (L-5).

---

## Compile-time gate — re-run with `--force`, actual output

| Task | Result |
|---|---|
| `pnpm typecheck --force` | **13 successful, 13 total**, `0 cached` |
| `pnpm build --force` | **13 successful, 13 total**, `0 cached` |
| `pnpm lint --force` | **13 successful, 13 total**, `0 cached` — **0 errors, 14 warnings**, all pre-existing (proven above) |
| `pnpm test --force --continue` | **12 successful, 13 total**; `Failed: @telemetry/usage-service#test` |

Per-package tests, all 13 accounted for (`@telemetry/web` runs `vitest run --passWithNoTests`
and its task succeeded):

| Package | Files | Tests |
|---|---|---|
| `@telemetry/gateway` | 8 | 38 passed |
| `@telemetry/auth-service` | 15 | 164 passed |
| `@telemetry/usage-service` | 19 | **1 failed / 225 passed (226)** |
| `@telemetry/usage-service` *(T-036 file excluded)* | **18** | **199 passed** |
| `@telemetry/worker-service` | 4 | 19 passed |
| `@telemetry/billing-service` | 4 | 18 passed |
| `@telemetry/analytics-service` | 4 | 18 passed |
| `@telemetry/web` | — | passed (no tests) |
| `@telemetry/shared-config` | 1 | 4 passed |
| `@telemetry/shared-logger` | 1 | 4 passed |
| `@telemetry/shared-tracing` | 1 | 2 passed |
| `@telemetry/shared-types` | 1 | 7 passed |
| `@telemetry/shared-utils` | 1 | 18 passed |
| `@telemetry/shared-validation` | 1 | 15 passed |

**The one red is the expected one.** `tests/usage.integration.test.ts` → *"B8 applies a
half-open range"*, T-036's untracked file, mechanism already re-derived in round 1
(`integration.fixtures.ts`'s `readEffectiveRangeBounds` reproduces the defect). Excluding that
one file: `Test Files 18 passed (18)`, `Tests 199 passed (199)`.

**The 199 accounting is confirmed by execution, not accepted:** `usage.repository.unit.test.ts`
**23** (unchanged from round 1), `rls.enforcement.integration.test.ts` **7**,
`usage.timezone.integration.test.ts` **17** — 16 in round 1 plus exactly the L-1 role case,
which I also saw fail on its own when pointed at the owner role. 198 + 1 = 199.

**Observed and not attributable to S-18:** `@telemetry/auth-service:test` logs one
`ConnectorError … code: "42501", message: "permission denied for table Event"` and then
passes 164/164. No auth-service file is modified by this change (`git status --porcelain`),
so this is that suite's own pre-existing output.

---

## What I verified — by execution, this round

- The fragment is unreachable as a symbol from source (`TS2459` reproduced), through the
  `repositories/index.ts` barrel, through the rebuilt `.d.ts`, and in the emitted `.js`.
- The half-fixed shape is still composable from outside with **zero** usage-service imports,
  and via the newly exported `DATABASE_SQL` constant; both render byte-identical SQL text to
  the in-module path, and the bound resolves to `2026-01-01 05:30:00` instead of
  `2026-01-01 00:00:00`.
- Three cast mutants, each red on the literal assertion, with the tree restored and
  `sha256sum -c` verified.
- `42883` operand order in six forms (four `psql`, two Prisma-on-the-real-column), plus the
  `P2010`/`meta.code` surfacing.
- The unquoted-literal qualification: `pg_typeof('…')` → `unknown`; no error inline, in
  `PREPARE`, or through `$queryRawUnsafe`; and the offset silently discarded.
- `::timestamp(0)` rounds `2026-01-31T23:59:59.999Z` to `2026-02-01 00:00:00` and flips the
  exclusive upper bound.
- `DATE_TRUNC('day'|'week', <naive>)` identical under `UTC`, `Asia/Kolkata`,
  `America/New_York` and `Asia/Kathmandu`; `column AT TIME ZONE 'UTC'` → `timestamp with time
  zone` rendering `2026-01-01 00:00:00+05:30` on this session. Both the repository comment's
  "four session zones" and the unit test's direction comment hold.
- The zone pin exists only in usage-service; the other four `base.repository.ts` copies are
  unchanged.
- L-1's falsification, L-2's 7/7, and the full four-task `--force` gate above.
- `"UsageLine"` still has `periodStart`/`periodEnd`/`processedAt` as `timestamp without time
  zone`, `datetime_precision = 3`, so `::timestamp(3)` still matches the column.

## What I could not verify, and why

- **Round 1's own pre-fix measurements** (the four-zone behavioural table, the eight red
  integration cases, `pg_typeof` of a bound `Date`, the 20-column sweep, the index plan). Out
  of scope for this round by instruction, and I did not re-derive them; where I relied on them
  above I said so.
- **That the derived (round 1) assertion passed all three mutants.** I measured only the
  post-fix direction. The pre-fix direction is round 1's measurement and the plan's.
- **The round-1 text of the files that changed twice.** Nothing is committed and there is one
  working tree, so I cannot diff round 1's revision against round 2's; for the repository doc
  block's previously-unhedged ORM sentence (rework deviation 1) I am relying on the
  implementer's account plus round 1's quotation of the adjacent lines. Labelled as such.
- **`ALTER ROLE … SET TimeZone` overriding `ALTER DATABASE … SET TimeZone`**
  (`docs/development-setup.md`). Unchanged this round; still needs a new role, a new database
  and a fresh session, which a read-only review should not create. `pg_db_role_setting` is 0
  rows here.
- **Production `TimeZone`, pooled/PgBouncer behaviour, production-cardinality index
  behaviour.** Unchanged from round 1; R-9 and R-10 stand.
- **`pnpm format:check`** — deliberately not a gate (S-12); the plan's claim that all six
  touched files were already prettier-dirty at `HEAD` matches round 1's independent bounding,
  and I did not re-run it.

## Database state left behind

Every probe of mine was read-only or `SET`-in-session; the only write path was the L-1
falsification run, which is the suite's own `beforeAll`/`afterAll` fixture and cleans up.
Final state, measured: `TimeZone = Asia/Kolkata`, **2 `Tenant` / 2 `User` / 0 `RefreshToken` /
0 `Event` / 0 `UsageLine` / 0 `Invoice`**, `pg_db_role_setting = 0`, no `s18%` tenant, no
prepared statements. Identical to the state I was handed — this round's root gate added no
residue, unlike round 1's. Tenant ids left: `d4101ff1-…`, `456793cd-…` (auth-service residue,
deliberately left).

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| The containment claim in two code comments and the plan is still stronger than what the compiler enforces | **User's call** — apply the supplied replacement sentence, or accept knowingly. Docs-only; no re-QA, no third review round (M-1 above) |
| The half-fixed shape remains writable anywhere in the service, silently wrong in every zone, and the `withTenant` pin does not mask it | **Accept for this commit** — it was equally true before S-18 and the fix narrows the blast radius. Already covered by round 1's `known-gaps.md` recommendation (raw date predicates in the other four `withTenant` copies); if the user wants it captured, this is the sentence to add |
| Plan's lint record says 4 warnings, the workspace has 14 | **Fix with the commit** (R2-1) |
| `pnpm test` red on T-036's untracked B8 | **Unchanged from round 1.** The commit must exclude the three T-036 test files, or §9 lands first; CI runs `pnpm test`, and on the committed tree that file will not exist |
| R2-2, R2-3 | Accept / cosmetic |

## Verdict — Round 2

**CONDITIONAL.** M-2, M-3, L-1, L-2, L-4 and L-5 are resolved and I re-derived each by
execution; the compile-time gate is 13/13 on all four tasks with the single expected T-036
red; no new unestablished claim entered `CLAUDE.md`, `.claude/rules/tenant-isolation.md`,
`docs/development-setup.md` or the code comments — every load-bearing claim added this round
(operand order, the unquoted-literal caveat, the precision rationale, the invariant rewrite,
the pin's exclusivity) I checked myself and each holds.

The single condition is **M-1's residual wording**, and it is the same class as round 1's
finding, so per `/ship`'s loop discipline it goes to the **user**, not back to Gate 3: apply
the replacement sentence supplied above (two code comments and one plan line, no code change,
no re-QA), or record acceptance of the current wording. With either, plus R2-1's one-line
correction to the plan's lint record, this is **APPROVED FOR COMMIT** — the production change
itself needs nothing further.
