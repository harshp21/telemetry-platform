# Senior Review — T-051 · `GET /v1/analytics/metrics`

## Round 1

**Gate 4 (pre-QA).** Read-only. `main` is `dc2c268`; T-051 is uncommitted, **24 tree entries**,
identical before and after this review. Ten mutations, each applied to one file, run, and
restored from a scratchpad copy — `md5sum -c` clean on all seven distinct files. Nothing
committed, staged or branched; no `checkout --`/`restore`/`stash`.

`.claude/rules/*` `cat`-ed from disk (S-24): `known-gaps.md` md5
`b6824a7feccbaf1a7dd7325875c4fd8d`, 4 318 lines, **51** `## S-` headings, S-9 and S-53 absent,
S-61 at `:4241`.

---

## Findings

### MEDIUM-1 · Three now-false "zero routes" statements survive, one in security-relevant production code and one in an authoritative rules file — and both cite a retired id

T-051 discharges S-9 by putting a route inside the guarded scope. Four files were updated to say
so. Three sites were not, and `git status` shows **none of them is in this diff**, which is why
they were missed: the change falsifies them without touching them.

**1 · `apps/analytics-service/src/middleware/internal-auth.middleware.ts:14-20`** — the guard's
own docblock still reads:

> **This guard currently protects zero routes, and that is measured rather than assumed.** The
> scope `src/app.ts` adds it to holds no routes until T-051 … So the wiring is in place for
> T-051 to register inside, and **until it does, nothing reaches this function in production**.
> `.claude/rules/known-gaps.md` S-9 is the durable record.

Every clause is now false. `GET /v1/analytics/metrics` is registered inside that scope
(`src/app.ts:92`), the guard is on the serving path for real tenant data, and **S-9 no longer
exists in `known-gaps.md`** (51 headings, S-9 absent). `git status --porcelain` on this file is
empty — T-051 did not open it.

**2 · `.claude/rules/known-gaps.md:3992-3994`**, inside **S-58**:

> The analytics half is not live yet — its guarded scope holds no routes until T-051 (S-9) —
> which is why S-9 could fix its own line cheaply and why fixing it did not resolve this.

Doubly false, and the second half was already wrong before T-051. The scope now holds a route;
and analytics' `.env.example` value is `dev-local-internal-secret-at-least-32-chars`, **the same
value gateway's carries** (re-derived over all six declaring files), so analytics never
contributed a mismatch to S-58 at all. A false claim in a file `CLAUDE.md` designates
authoritative is **HIGH by default**; graded MEDIUM here because the sentence is an aside in an
entry whose substance (billing/worker vs gateway) is correct and unaffected.

**3 · `apps/analytics-service/tests/internal-auth.middleware.unit.test.ts:53`, `:364`, `:400`** —
"nothing behavioural can notice that while the production scope holds no routes", given as the
justification for `AU22b`'s and `AU23`'s source-text assertions. Behavioural observation **is**
now possible: `AM23` in `tests/metrics.route.test.ts` observes hook order through the real route,
by the code a doubly-invalid request receives.

**What makes this look like oversight rather than policy:** **S-59 *was* correctly updated** for
T-051 landing (`known-gaps.md:4105-4110`, "T-051 has landed, so the first conjunct is now
satisfied"). One entry was chased down and three sites were not.

**Fix:**
- `internal-auth.middleware.ts:14-20` — replace with: *"This guard protects
  `GET /v1/analytics/metrics`, registered inside the `app.register` scope in `src/app.ts` by
  T-051. It protected **zero** routes until then — a scope carrying hooks and no routes never runs
  them — which was S-9, now retired; the record is
  `docs/plans/t-051-analytics-metrics-rollup.md`."*
- `known-gaps.md:3992-3994` — replace the analytics sentence with: *"analytics carries gateway's
  value, so it contributes no mismatch; the split is billing's and worker's."*
- `internal-auth.middleware.unit.test.ts:53/:364/:400` — requalify to *"nothing in **this file**
  can observe it; `AM23` in `tests/metrics.route.test.ts` does, through T-051's route."*

**Disposition:** must fix before QA. Text-only.

---

### MEDIUM-2 · Two controller error paths have no test, and one is the second security layer three docblocks rely on

`apps/analytics-service/src/controllers/analytics.controller.ts` is the least-covered file in
the package — **75.51 % statements / 72.72 % branches** — and the coverage report names exactly
which lines:

```
  ...controller.ts |   75.51 |    72.72 |     100 |   75.51 | 66-74,81-83
```

- **`:66-74`** — the absent-tenant guard: `logger.error(...)` plus `500 INTERNAL_ERROR`.
- **`:81-83`** — the `AppError` branch: `response.status(error.statusCode).send({ code, message })`.

`grep -rn "AppError" apps/analytics-service/tests/*.ts` returns **nothing**, and so does a grep
for any case reaching the absent-tenant path. Neither is exercised by a standing test.

**`:66-74` is not an ordinary uncovered branch — it is the layer this change's own safety
argument rests on.** It is cited as the reason a misplaced route is harmless in **three**
places: `src/app.ts:88-93`, `src/routes/analytics.routes.ts:19-22`, and `AM20`'s inline comment
at `tests/metrics.route.test.ts:102-108` ("Delete it — or widen the controller to tolerate a
missing tenant — and this assertion becomes the only thing between a misplaced route and an
unauthenticated read of one customer's data"). A layer described that way with no test is the
shape `.claude/rules/review-standards.md`'s final checklist forbids — *"no untested logic; all
error paths tested"* — and `.claude/rules/testing.md` asks for *"at least one negative path for
every auth/validation branch"*.

`:81-83` is smaller but is the only path on which analytics sends an error **`message`** from a
caught error; `AM22b` pins the *non*-`AppError` path's bare-`{code}` body, so the `AppError`
contract is unasserted in both directions.

**Fix — two cases in `tests/metrics.route.test.ts`, no production change:**
- `AM22c` — build the app, call `controller.handle` with a request whose `tenantId` is absent
  (or register the route on a bare instance with no tenant hook), and assert
  `500 { code: "INTERNAL_ERROR" }` **and** `expect(getMetricsRollup).not.toHaveBeenCalled()`.
  That converts the three docblocks' claim from prose into a guard.
- `AM22d` — stub the service to throw an `AppError` and assert the status and code come from the
  error and that a `message` **is** present, distinguishing it from `AM22b`.

**Disposition:** must fix before QA.

---

### MEDIUM-3 · `AI12`'s comment attributes the under-report to a mutation that does not produce it, and the assertions that would observe it are unreachable

`apps/analytics-service/tests/analytics.integration.test.ts:526-531`:

> Remove the `metricKey === undefined` condition from `AnalyticsService` and this sequence
> becomes: the filtered request caches only `api.request`'s single bucket; the unfiltered request
> then counts one cached bucket against one expected bucket, decides the range is complete, and
> serves `api.request` alone — silently omitting `storage.write`.

Measured, three mutations, each reverted:

| Mutation | AI12 fails at | Value |
|---|---|---|
| **service guard only** (the one the comment names) | `:543` `expect(await cachedRowsFor(tenantId)).toHaveLength(0)` | *"expected […(2)] to have a length of +0 but got **2**"* |
| **both layers** (service guard + `cacheRange` pass-through) | `:543`, the same line | *"…but got **1**"* |
| **both layers, `:543` pinned so execution continues** | `:548` | *"expected `[ 'api.request' ]` to deeply equal `[ 'api.request', 'storage.write' ]`"* |

Two things follow.

**The named mutation does not produce the described consequence.** `cacheIfSound` calls
`repository.cacheRange(range)` and `range` is `{ from, to, granularity }` — it carries no
`metricKey`. So removing the service condition alone writes the **unfiltered** range: both
metrics are cached (measured: 2 rows), and the following unfiltered request is served
*correctly*. Nothing under-reports. The under-report needs the repository's field-by-field
rebuild widened as well.

**The assertions that would observe the under-report never execute.** `:543` throws first under
every mutation that could set it up, so `:548-555` only ever run on the green path, where they
assert the correct answer. They are not a guard for the under-report they are annotated as.

**The guard is not decoration** — AI12 goes red under both mutations, on a real property ("a
filtered request wrote the cache") — and **the hole is real**: row 3 above is the silent
`storage.write` drop, measured. Only the *attribution* is wrong. This is S-33's second shape, "a
measurement attached to the wrong mutation".

**Note the accurate account already exists on the tree.** `docs/epics/README.md` § *Q3a* states
it correctly — *"Measured with both layers of that guard removed: the unfiltered request returned
`['api.request']` where the truth is `['api.request', 'storage.write']`"*. The test comment is
the one that is wrong.

**Fix:** `tests/analytics.integration.test.ts:526-531` — replace "Remove the
`metricKey === undefined` condition from `AnalyticsService`" with *"Remove **both** layers — the
`metricKey === undefined` condition in `AnalyticsService` **and** `cacheRange`'s field-by-field
rebuild — and …"*, and add: *"Under either mutation this case fails at the
`toHaveLength(0)` assertion below, so the two assertions after it never execute; they pin the
correct answer on the green path rather than observing the under-report. The measured
under-report is in `docs/epics/README.md` § Q3a."* If a case that *does* observe it is wanted,
it must assert the unfiltered result **before** asserting the cache is empty.

**Disposition:** must fix before QA. Comment-only.

---

### LOW-1 · D10 is recorded everywhere except the plan, and it was latent in the plan's own formula

`grep -c "D10" docs/plans/t-051-analytics-metrics-rollup.md` → **0**. The plan declares D0-A,
D0-B and D1–D9. D10 is documented in `src/services/analytics.service.ts:43-48`,
`src/repositories/rollup.repository.ts` (`describeRangeCoverage`'s docblock),
`docs/epics/README.md` § *Q3a* and S-61 — but not in the artifact the commit carries as the
decision record.

**Process ruling, as asked.** This was a legitimate mid-implementation resolution, **not** a
question Gate 1 was obliged to stop for. `CLAUDE.md` requires a planning question be asked when
*"different readings of an ambiguity would produce materially different plans"*; D10 changes no
file, no contract, no risk disposition — it adds two guard conditions and two cases. It is a
corollary of D0-A (completeness) asked about the range's **edges** rather than its interior.

**But it was latent in the plan's own mechanism**, which is the fair criticism: the plan defines
`expectedBuckets` with `generate_series(DATE_TRUNC(unit, from), …)`, and that `DATE_TRUNC`
silently normalises an unaligned lower bound. Asking "what does this count when `from` is not a
boundary?" at Gate 1 would have surfaced D10 without any new information.

**Is the guard complete, or does it refuse aligned requests it should admit?** Probed directly
against PostgreSQL with the shipped predicate:

```
day  aligned              -> aligned=true      day  unaligned from -> false
hour aligned              -> aligned=true      hour half-past     -> false
week ISO Monday           -> aligned=true      week Sunday-start  -> false
day  ms precision (.001)  -> false
```

and an **offset-bearing spelling of a boundary** is correctly admitted, because
`utcTimestampBound` resolves the instant in JS first
(`new Date("2026-03-01T05:30:00+05:30").toISOString()` → `2026-03-01T00:00:00.000Z`). **No
genuinely aligned request is refused.** The one refusal that may surprise a caller is a
Sunday-start week, which is correct given PostgreSQL's ISO weeks and is worth one sentence
somewhere a caller reads.

Its two quoted quantities check out against the shipped fixture: `PRIMARY_DAY_1` `10.500000` +
`PRIMARY_DAY_1_EXTRA` `2.000000` = **`12.500000`** for the `2026-03-01` bucket, of which an
unaligned `[06:00, …)` request sees **`2.000000`**.

**Fix:** add D10 to the plan's decision list as a Gate-3 addition with its measurement, and
annotate the `expectedBuckets` formula in the plan as where the question was latent. Consider one
line in the epic's T-051 section noting that `week` means ISO Monday for alignment purposes.

---

### LOW-2 · `readCachedPage`'s docblock quotes two numbers that cannot be re-derived from anything on the tree

`src/repositories/rollup.repository.ts`, `readCachedPage`'s docblock:

> measured at Gate 3 for `[2026-03-01T06:00, 2026-03-04)`, where the `UsageLine` tier returns
> **one row worth `5.250000`** and a truncated-bound cache read returns **three worth
> `22.750000`**.

Against `AI13`'s shipped fixture (`10.500000` at `DAY_1_EARLY`, `2.000000` at
`DAY_1_AFTER_SIX`, `5.250000` at `DAY_3_NOON`) that range yields **two** grouped rows on the
`UsageLine` tier (`2.000000` and `5.250000`) and **two** cached rows under a truncated bound
(`12.500000` and `5.250000`, summing `17.750000`). Neither quoted figure is reconstructible; the
Gate-3 probe evidently used a different fixture that is not on the tree. (`22.750000` is
`10.5 + 7.0 + 5.25`, which appears in the suite only as the *week* total's arithmetic.)

**LOW rather than higher because the conclusion is guarded:** truncating the cache read's lower
bound reddens **`AM16f` alone** — measured, `Tests 1 failed | 143 passed (144)`.

**Fix:** either restate the numbers against `AI13`'s fixture, or drop them and cite `AM16f`
plus the alignment measurement that *is* reconstructible.

---

### LOW-3 · The plan's coverage-threshold figure is wrong in its last position

The plan records coverage *"against `80 / 75 / 80 / 75`"* in `statements / branches / functions /
lines` order. `apps/analytics-service/vitest.config.mjs:25-30` (unmodified by T-051) declares
`lines: 80, functions: 80, statements: 80, branches: 75`, i.e. **`80 / 75 / 80 / 80`**. The
measured coverage is exact — `92.59 / 85.29 / 92 / 92.59`, re-derived — and clears either set, so
nothing is at risk; the figure is simply mis-transcribed.

**Fix:** `docs/plans/t-051-analytics-metrics-rollup.md`, the coverage checklist line — `80 / 75 /
80 / 80`.

---

### NIT-1 · S-61's `AI2` citation overstates what `AI2` asserts

S-61: *"re-measured at Gate 3 as the standing test `AI2` …: a three-day range with usage on two
of the days gives `expectedBuckets = 3` against `cachedBuckets = 2`"*. `AI2` seeds exactly that
fixture and its own comment names S-61 — but it asserts the **response items**, not the two
counts. No standing test asserts `3` against `2` against a live database;
`expectedBuckets`/`cachedBuckets` appear in the suite only against a **double**
(`tests/analytics.service.unit.test.ts:122`, `EXPECTED_BUCKETS - 1`). **Fix:** *"whose fixture
shape is pinned by the standing test `AI2`; the counts themselves were measured at Gate 1 and are
pinned only against a double by `AM19`."*

### NIT-2 · The misplaced-route `500` is conditional on a valid querystring

Validation precedes the tenant check (`analytics.controller.ts:53-62` before `:64-74`), so a
misplaced route answers `400 VALIDATION_ERROR` — with the message naming the required parameters
(`"from: Required; to: …"`) — to an **unauthenticated** caller who sends no query. Measured at all
three wrong placements. No tenant data escapes (service called 0 times in every case), but the
response is discriminating: it confirms the endpoint exists and names its contract. Worth one
clause where the `500` is asserted, so nobody reads "misplaced ⇒ 500" as unconditional.

---

## The reconciliation you asked for — stated in the words the measurement supports

Both results are true, **of different objects**, and the security consequences are **not**
identical. Measured this round against one composition per placement, injected with **no headers
at all**, using the real guard, the real tenant hook, the real controller and the real
`registerAnalyticsRoutes`:

```
===== PROBE ROUTE (bare handler) =====
  inside            valid query  -> 401  calls=0   {"code":"UNAUTHORIZED"}
  sibling           valid query  -> 200  calls=1   {"probe":true}
  sibling-prefixed  valid query  -> 200  calls=1   {"probe":true}
  root              valid query  -> 200  calls=1   {"probe":true}

===== REAL ROUTE (through AnalyticsController) =====
  inside            valid query  -> 401  calls=0   {"code":"UNAUTHORIZED"}
  sibling           valid query  -> 500  calls=0   {"code":"INTERNAL_ERROR"}
  sibling-prefixed  valid query  -> 500  calls=0   {"code":"INTERNAL_ERROR"}
  root              valid query  -> 500  calls=0   {"code":"INTERNAL_ERROR"}
  (any placement)   no query     -> 400  calls=0   {"code":"VALIDATION_ERROR","message":"from: Required; to: …"}
```

**My S-9 measurement is not refuted; it is confirmed and bounded.** A bare handler outside the
scope answers `200` **and runs**. The real route outside the scope answers `500` (or `400`) and
**does not run** — because `AnalyticsController` refuses on the absent `request.tenantId`, a
second layer the probe route did not have.

So the accurate sentence is: **a misplaced route is reachable and unauthenticated in both cases;
whether anything happens depends on whether the handler has its own tenant guard. The probe
route's handler ran; the controller's did not.** Do not compress this to "the security
consequence is identical" — for the probe route a handler executed for an unauthenticated
caller, and for the real route none did. What *is* identical is the first-layer failure: the
guard and the tenant hook never run in either case, at any of the three placements.

**My measurement extends the implementer's in one direction**: they measured the real-route `500`
at the **root instance** only (`analytics.routes.ts:16-17`); it also holds for a sibling scope and
a prefixed sibling scope. The three sites that carry the `200` sentence are correctly qualified in
`src/app.ts` ("one probe route per placement") but **not** in `analytics.routes.ts:11-13` or
`tests/metrics.route.test.ts:21-23`, where a reader meets "measured against the real app factory
… all answer `200`" in a file about the real route. Recommend adding "one **probe** route per
placement" to both.

---

## The nine mutation claims — every one re-derived

Each applied to `src/`, run, reverted, `md5sum -c` verified.

| # | Mutation | Claimed | Measured |
|---|---|---|---|
| T-M1 | `registerAnalyticsRoutes` moved to the root instance | `AM20` red on the status assertion | **`AM20` red, `→ expected 500 to be 401`** ✓ (plus AM20b/AM21/AM21b/AM23/AM23b) |
| T-M2 | `utcTimestampBound` → bound JS `Date` | `AI8` red under three non-UTC zones, **green under UTC** | **Exactly.** `AI8` red under `Asia/Kolkata`, `America/New_York`, `Asia/Kathmandu`; the `UTC` variant is absent from the failure list. Same split for `AI8b`, `AI8c` ✓ |
| T-M3 | `AT TIME ZONE 'UTC'` on the column | `AI7`/`AM13` red | **`AM13` red; `AI7` red under the same three zones, green under UTC** ✓ |
| T-M4 | D3 service-side condition removed | `AM17`, `AI12` | **exactly `AM17` + `AI12`**, `2 failed | 142 passed` ✓ (but see MEDIUM-3 for *why* AI12 fails) |
| T-M5 | D3 type layer — `cacheRange` pass-through | `AM17d`, and the type alone is insufficient | **typecheck exit 0** under the mutation, `AM17d` red alone ✓ — the type does *not* catch it; the second layer is what holds |
| T-M6 | `cachedBuckets === expected` → `> 0` | `AM19`, `AI6` | **`AM19` + `AI6`** among 7 failures; scoped to the two files S-61 names, `AI6` fails **`expected [ '424242' ] to deeply equal [ '10.5', '3' ]`** — verbatim ✓ |
| T-M7 | D10 removed (both directions) | `AM19d`, `AI13` | **exactly `AM19d` + `AI13`**, `2 failed | 142 passed` ✓ |
| T-M8 | `AND billed = true` restored | `AI4b` red | `AI4b` red (30 failures total — the claim does not assert exclusivity) ✓ |
| T-M9 | tenant predicate removed from **both** filter builders (S-46) | 3 unit shape cases red, both integration suites 38/38 green | **exactly:** `AM16`, `AM16e`, `AM17a` red; `Test Files 2 passed (2) / Tests 38 passed (38)` ✓ |
| T-M10 | cache read's lower bound truncated | `AM16f` | **`AM16f` alone**, `1 failed | 143 passed` ✓ |

**On the D3 hole:** verified **real**, not decoration — row T-M4 fails a named case under the
single-layer mutation, and under both layers with `:543` pinned the unfiltered request returns
`['api.request']` against the true `['api.request', 'storage.write']`. The silent drop happens.
The defect in the *account* is MEDIUM-3.

**On the S-21 property:** confirmed, and it is scoped to the four zones the suite pins (`UTC`,
`Asia/Kolkata`, `America/New_York`, `Asia/Kathmandu`). Worth recording that this host's
PostgreSQL default `TimeZone` is **`Asia/Kolkata`**, not UTC — so the non-pinned integration
suite reddened too under T-M2. On CI (`postgres:16-alpine`, default `UTC`) it would not, and
`AI8`'s own `options=-c timezone=…` pinning is the only thing that makes the case portable. That
is exactly what S-21 asks for and analytics is the first service on this platform to have it,
because it has **one** guard rather than usage-service's two (`grep -c TimeZone` → usage 2,
analytics/auth/billing/worker 0).

---

## The retirements, the new entry, and the rest

**S-9 genuinely discharged.** `registerAnalyticsRoutes(analyticsApi, container.analyticsController)`
is inside the `app.register` callback (`src/app.ts:92`), and T-M1 shows the suite notices if it
moves. `tenant-isolation.md`'s three now-false claims are rewritten, and its S-46 paragraph
reproduces my own measurement exactly. The residue is MEDIUM-1's three sites.

**S-53's residue is genuinely discharged.** The corrected snippet is a bare
`DATE_TRUNC('day', "periodStart")` on the naive column; identifiers are real quoted PascalCase
(`"UsageLine"`, `"metricKey"`, `"periodStart"`, `"tenantId"`, `"quantity"`); the bound half is
`$2::timestamp(3)` / `$3::timestamp(3)`; the window is half-open on `"periodStart"` (the original's
`period_end <= $3` was a fourth defect, correctly identified); `billed = true` is gone. All five
divergences are enumerated under it rather than silently overwritten, per S-32's precedent. **All
three live citations rewritten** — `docs/epics/README.md` Q3 bullet, `docs/epics/README.md` Q3
"Implemented by", and the `epic-9` placement blockquote. A repo-wide grep finds no other live
S-53 citation outside this task's own files. **No part of S-53's stated residue survives; it stays
retired.**

**S-61** is honest and correctly bounded: it labels the `hour`-granularity consequence as
*"Not measured, and stated as reasoning"*, which is the right strength. Its `AI9` sentinel claim
and its quoted `AI6` failure message both reproduce. NIT-1 is its only defect.

**S-19's table re-derived, not incremented:** `grep -rn "extends TenantScopedRepository"
apps/*/src` returns **10** lines, of which **5** are `export class` — `RollupRepository:242`
(analytics), `MeterRepository:35` and `InvoiceRepository:367` (billing), `UsageRepository:150`
(usage), `EventRepository:73` (worker) — **five subclasses across four services** ✓. The other
five are the docstring example in each base copy. `base.repository.ts` digests: analytics and
worker both `13a533a2e2c2dcc1ff9db28fb5c7a1fd`, 111 lines each — **byte-identical**, D7 honoured.

**D2's ceiling closes by sweep, not only by argument.** Both `page` and `pageSize` carry hard
`.max()`, so the reachable offset space is exactly `[1..10 000] × [1..100]`. Swept 140
combinations through the real schema: 16 accepted, 124 rejected, worst reachable offset
**999 900** — safe in `int64` and a safe JS integer, 9.2 × 10¹² below 2⁶³. The corners behave:
`page=10001` → `REJECT page: Number must be less than or equal to 10000`; `pageSize=101` →
`REJECT pageSize: …less than or equal to 100`. **No `pageSize`-aware overflow is reachable below
`MAX_PAGE`**, because `pageSize` is bounded by the same schema. The argument does close it.

**The D3 type-level guard is insufficient on its own, as claimed** — T-M5 typechecks clean with
`cacheRange` passing `input` straight through, and `AM17d` is what fails. The docblock at
`MetricsCacheInput` says so in the right words (*"this makes the **typed call** a compile error.
It does not make a partial write unrepresentable"*) and `cacheRange`'s comment says the type
"alone was not enough". Neither overclaims.

**Constants / S-57: clean.** No fourth copy of anything. `CODE_VALIDATION_ERROR` and
`CODE_INTERNAL_ERROR` derive from `ERROR_RESPONSES` in `@telemetry/shared-types` (`:206`, `:208`),
verified; the only `"INTERNAL_ERROR"` strings in analytics `src/` are inside comments. The
tenant-context vocabulary is still exactly three copies — S-57 unchanged. `MESSAGE_INTERNAL_ERROR`
was deliberately not created, which avoids a third copy of `"Internal server error"`; the `500`
body is `{ code }` only. Route path, granularity values, page bounds, SQL cast and the
`MAX_CACHED_ROWS` ceiling are all constants. The residual literals in the five new source files
are log discriminators (`"cache"`, `"usage"`, `"metric-filtered"`, `"range-not-bucket-aligned"`),
one internal invariant `Error` message and a zod `path: ["to"]` — none in the categories
`.claude/rules/constants.md` enumerates, and matching neighbouring services.

**Tenant isolation and injection.** Every statement runs inside `withTenant` **and** carries an
explicit `tenantId` from `this.where({})`; no query input type has a `tenantId` field; the
repository is a factory in the container, never a singleton (`AM19g`). Granularity varies SQL
only through a frozen `Record` of constant `Prisma.Sql` fragments — zero interpolation, so an
unvalidated string cannot contribute SQL text. The single `Prisma.raw` is a module-level constant
built from `ANALYTICS_DATABASE_SQL`, never from input. Every timestamp bound goes through
`utcTimestampBound`. `cacheRange`'s `INSERT … SELECT` binds the tenant from `this.where({})` and
relies on `"MetricRollup"`'s `WITH CHECK`, with `AI15` standing behind it. `totalQuantity` is
normalised to a string in the repository, so no `Prisma.Decimal` reaches JSON.

**Plan alignment.** Four deviations are declared in the checklist (the `AM20` `500`-not-`200`
result, S-53's additional retirement, the S-19 re-derivation, the D0-A/Q3a record). **One
undeclared:** D10 (LOW-1). I found no others — the file set matches §5, D1/D2/D3 and the option-A
fallback are implemented as approved, and D7's "do not touch `base.repository.ts`" is honoured
byte-for-byte.

**Compile-time gate, `--force`, 13 packages, `Cached: 0` on all four:**

```
lint       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total
typecheck  Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   20.891s
build      Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   22.935s
test       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total
```

**1 154 tests, 0 failures.** analytics **144/144, 13 files** (56 → 144, +88). Lint **0 errors,
exactly 14 warnings** — 10 in `apps/auth-service/tests/auth.service.unit.test.ts` (`git log -1`
→ `d68e719`, 2026-08-25) and 4 in `apps/usage-service/tests/ingestion.service.unit.test.ts`
(`b0f6921`, 2026-08-31); `git status --porcelain` on both apps is empty. **No analytics file
appears in any lint, typecheck or build output.** Coverage `92.59 / 85.29 / 92 / 92.59`
re-derived exactly.

---

## What I could not verify, and why

1. **`readCachedPage`'s `5.250000` / `22.750000`** — the fixture that produced them is not on the
   tree (LOW-2). The conclusion is guarded by `AM16f`, which I did verify.
2. **S-61's "close to permanent at `hour` granularity"** — the entry itself declines to claim it
   as measured, and I did not run a production-shaped dataset either.
3. **Behaviour on a UTC-defaulted server.** This host's PostgreSQL defaults to `Asia/Kolkata`, so
   the non-pinned integration suite is exercised on a non-UTC server here and would not be on CI.
   `AI7`/`AI8` pin their own sessions and are portable; the rest of the integration suite's
   portability is inferred, not measured.
4. **Real-process / real-gateway behaviour.** Everything here ran through `app.inject` or direct
   repository calls against the real database. No analytics-service process was started and no
   request crossed a socket.
5. **Concurrency on `cacheRange`.** The `ON CONFLICT DO UPDATE` is single-statement and therefore
   atomic per statement, but no concurrent-writer case exists or was run (S-38's family).
6. **`MAX_CACHED_ROWS` at scale.** The 10 000 bound is asserted by `AM19e`/`AM19f` against a
   double; no range large enough to trip it was run against the database.

---

## Verdict

# CHANGES REQUESTED

This is strong work and none of the findings is a defect in the shipped **behaviour**. The SQL is
the best on the platform — one frozen fragment map, zero interpolation, every bound normalised in
JS and cast naive, no `AT TIME ZONE` anywhere, the `billed` filter correctly dropped per D1, and
`Decimal` stringified in exactly one layer. Tenant isolation carries both layers on every
statement. All ten mutation claims re-derived, including the two that are more than pass/fail:
the **S-21 isolation property is real** — `AI8` is red under three non-UTC zones and green under
`UTC` with the defect present, which no suite on this platform has achieved before — and the
**D3 hole is real**, measured as `['api.request']` where the truth is
`['api.request', 'storage.write']`. D2's ceiling closes by sweep. S-9's and S-53's residues are
genuinely discharged and the epic snippet is correct in all five respects.

Three MEDIUMs block QA:

- **MEDIUM-1** — three now-false "zero routes" statements, one in security-relevant production
  code and one in `.claude/rules/known-gaps.md`, both citing a retired id. Text-only.
- **MEDIUM-2** — the controller's two error paths (`:66-74`, `:81-83`) have **no test**, and
  `:66-74` is the second security layer three docblocks lean on. Two cases, no production change.
- **MEDIUM-3** — `AI12`'s comment names a mutation that does not produce the consequence it
  describes, and the assertions that would observe it are unreachable. Comment-only; the correct
  account already exists in `docs/epics/README.md` § Q3a.

Plus LOW-1 (D10 absent from the plan, with a process ruling that resolving it at Gate 3 was
reasonable but that it was latent in the plan's own `expectedBuckets` formula), LOW-2, LOW-3 and
two NITs.

**Re-review will be quick:** only MEDIUM-2 adds executable code, and it adds tests rather than
production logic. A scoped
`pnpm --filter @telemetry/analytics-service exec vitest run` plus a re-read of the seven edited
passages is sufficient — noting S-60, that command needs a clean shell.

---

## Round 2

Round 1 is untouched: `head -490 <this file> | md5sum` = `dc383721cc1cfe1f7eed4f6543bc476f`,
identical to the whole-file md5 taken before this section was appended.

Three mutations this round, each on one file, restored (`md5sum -c` clean). Tree **27 entries**
before and after. `known-gaps.md` `cat`-ed from disk — md5 `0c3e9255517b6bebc73b19cd33a658f0`,
51 headings.

---

## Round 1 findings — six of eight fully discharged, two partially

| # | Status |
|---|---|
| MEDIUM-1 | **Partially.** Six sites fixed, correctly and in past tense. **Two survive** — MEDIUM-4 below. And the sweep left two dangling *entry* citations — MEDIUM-5 below. |
| MEDIUM-2 | **Discharged.** `AM22c`/`AM22d`/`AM22e`; controller coverage `75.51/72.72 → 100/90`. All three red alone, verbatim reproduced. |
| MEDIUM-3 | **Discharged**, and the replacement does not under-claim. |
| LOW-1 | **Discharged**, and better than asked: the plan now carries D10 in §2.3 *and* a callout at `:69` naming the `expectedBuckets` formula as where it was latent, with the one-sentence Gate-1 question. |
| LOW-2 | **Discharged.** New table reconstructible from `AI13`'s fixture; the old figures recorded as un-derivable. |
| LOW-3 | **Discharged** — `80 / 75 / 80 / 80`, config re-read and quoted. |
| NIT-1 | **Discharged** — "the *fixture shape* is pinned by the standing test `AI2`". |
| NIT-2 | **Discharged** — `AM22d` is its standing case. |

---

## New findings

### MEDIUM-4 · Two present-tense "no routes" statements survived the sweep, in the file the sweep edited — and one now contradicts a docblock the same round rewrote

I ran my own sweep independently of both lists and widened the spellings (`zero routes`,
`no routes`, `holds no route`, `no route in it`, `routeless`, `empty scope`, `scope is empty`,
`inert scope`, `reached by nothing`, `nothing reaches`, `protects zero`, `guard is fitted`,
`until T-051`, `carries no route`) across `*.md`, `*.ts`, `*.mjs`, `*.json`, `*.yml`. It returned
every site both of us had, plus everything already fixed — and **two that are still present tense
and still false**, both in `apps/analytics-service/tests/internal-auth.middleware.unit.test.ts`,
a file this round **did** modify:

**1 · `:53-56`**, the `PROBE_ROUTE` docblock:

```
 * The stand-in for T-051's route. It exists only inside these suites' own scope; production's
 * scope is empty, which is the whole subject of the docblock above.
```

Production's scope holds `GET /v1/analytics/metrics`. It is not empty. And the second clause is
now wrong twice over: the docblock above was rewritten this round to past tense
(`:13-21`, *"When these cases were written, production's guarded `app.register` scope held **no
routes**"*), so "the whole subject of the docblock above" is no longer that.

**2 · `:309-310`**, the guarded-scope-composition `describe`:

```
  // Production's registration order and phases, reproduced here because production's own scope
  // holds no route to drive. `AU22b` is what ties this composition back to `src/app.ts`.
```

False, and **directly contradicted by the same file's new docblock at `:33-36`**, which says the
file composes its own app *"which it did originally because there was no production route to
drive, and **still does because the guard's own properties are what these cases are about**"*.
The rewritten docblock gives the correct reason; this inline comment still gives the superseded
one.

**Why this is not a re-litigation of MEDIUM-1.** MEDIUM-1 named three sites; the implementer was
asked to grep the claim instead and found three more, which is the right method and found real
hits. What failed is the step after the grep: **my sweep returns `:55` and `:310` too.** The text
was in the result set and was classified as acceptable. So the gap is classification, not
coverage — which matters for the tie-break below.

**Fix:**
- `:54-55` → *"The stand-in for a production route. When these cases were written production's
  scope held none; T-051 added `GET /v1/analytics/metrics` inside it, and
  `tests/metrics.route.test.ts` drives that. These suites keep their own probe because the
  guard's own properties are what they are about."*
- `:309-310` → *"Production's registration order and phases, reproduced here because the guard's
  own properties are what this file is about; since T-051 a production route exists and `AM23`
  in `tests/metrics.route.test.ts` observes the same ordering behaviourally."*

**Disposition:** carried to Gate 6 — see § *Convergence*. Text-only.

### MEDIUM-5 · Two dangling citations of the deleted S-9 **entry**, in `known-gaps.md`, seventy lines after the same file says not to

You asked me to confirm no dangling entry citation survives anywhere. Two do, both inside
**S-59**, both present tense:

- **`:4076`** — *"It is materially worse than the length oracle **already recorded in S-9**."*
- **`:4101`** — *"**S-9 records** the length oracle and its operand-order asymmetry; **this entry**
  records the `===` form."*

The parallel construction at `:4101` (`S-9 records … this entry records …`) makes the referent an
entry, not the task. `known-gaps.md` has **no S-9 heading** — `grep -c "^## S-9 "` → 0 — and the
file says so twice in its own voice, once at **`:4006`**, written *this round* as part of the
S-58 fix:

> **S-9 is retired** … and `known-gaps.md` carries no S-9 entry, **so do not cite one**.

So the length-oracle measurement, which S-59's own fix direction names as one of the two cases a
replacement must go red on, is now recoverable only from `docs/reviews/s-009-…` — and S-59 points
at a heading that does not exist. A false citation in a file `CLAUDE.md` designates authoritative
is **HIGH by default**; graded MEDIUM because the measurement itself is intact elsewhere and
S-59's substance is unaffected.

The rest of the `S-9` / `S-53` corpus is clean: every other live hit refers to **S-9 the task**
(the slice, `docs/plans/s-009-…`), which is legitimate, or sits in `docs/reviews/`,
`docs/plans/`, `docs/qa/` as a historical record correct when written — those must not be edited,
by the same principle that keeps Round 1 above untouched.

**Fix:** `.claude/rules/known-gaps.md` S-59 `:4076` and `:4101` — replace "S-9" with the artifact
that holds it: *"already recorded in `docs/reviews/s-009-analytics-internal-auth.md` (Round 1,
MEDIUM-1)"* and *"`docs/reviews/s-009-analytics-internal-auth.md` records the length oracle and
its operand-order asymmetry"*.

**Disposition:** carried to Gate 6. Two-word edits.

### NIT-3 · `AM22c`'s quoted body is not reproducible from "this exact composition"

`tests/metrics.route.test.ts:287-293` says re-running *"this exact composition"* under the
guard-deleted mutation gave

```
body={"data":{"items":[{"metricKey":"CUSTOMER-DATA",...}],"total":1,...}}
```

`AM22c`'s composition mounts `app.container.analyticsController`, whose `getMetricsRollup` is
spied with `PAGE`, whose `metricKey` is **`"api.request"`** (`:68`). `grep -rn "CUSTOMER-DATA"`
finds the string only in that comment and in a stale `dist/` copy — so it came from a separate
probe stub, as `5.250000`/`22.750000` did at LOW-2. **The three load-bearing values are
reproducible and I reproduced them** (below), so this is a NIT: the rhetorical label is what does
not re-derive. **Fix:** quote `"api.request"`, or say "a stub labelled to make the point".

---

## Convergence — same class, second consecutive round, and I am not opening a third

MEDIUM-4 and MEDIUM-5 are **the same class** as Round 1's MEDIUM-1 and MEDIUM-3, and as the six
instances that cost S-9 three rounds: a claim or citation stated more strongly than what holds.
Per your instruction I am **not** opening a third round on it; the two fixes are carried to
Gate 6 and the verdict below is not CHANGES REQUESTED.

**What this round adds that the record did not have, and it sharpens S-33's open question.** The
two findings fail in *different* places and only one is mechanically catchable:

- **MEDIUM-5 is mechanical.** "Does `S-9` exist as a `## S-` heading in `known-gaps.md`?" is a
  one-line check with no judgement in it. S-33's scope note already names cross-document
  citation of finding ids as "the harder and more valuable target"; this is the third instance
  across two tasks (S-9 Gate 6's LOW-7 misattributed S-48/S-51; these two dangle entirely).
- **MEDIUM-4 is not.** The grep worked — **my sweep returned both sites** — and the implementer's
  sweep would have too. What failed is deciding whether a returned line is past tense, a
  disclaimer, or a live false claim. No `grep`-and-compare pass decides that, and S-33's table
  currently splits the world into "counts" (catchable) and "universals" (not); **this is a third
  category: a claim whose text is trivially found and whose truth is a tense judgement.**

**So the tie-break is:** build S-33's **id-resolution** checker, which closes MEDIUM-5's class
outright and is already owed; and accept that MEDIUM-4's class is closed only by the discipline
of rewriting a stale sentence rather than classifying it as tolerable. Recommend S-33 gain one
line recording that a claim-grep found the sites and the classification step is where it failed —
that is new information and it argues for scoping the checker at ids first, where judgement is
not required.

---

## Verification detail

### 1 · The sweep, run independently and widened

Fourteen spellings across four file types. Every hit outside `docs/{reviews,plans,qa}/` classified
by reading it:

| Site | Reads as |
|---|---|
| `src/app.ts:45`, `:71` | past tense, correct — `:71` is this round's fix and names `AM23` as the behavioural successor |
| `src/middleware/internal-auth.middleware.ts:14-24` | rewritten; now opens *"This guard protects `GET /v1/analytics/metrics`"*, records the old state in past tense, and adds *"`known-gaps.md` no longer carries an S-9 entry, so do not cite one"* |
| `src/routes/analytics.routes.ts:10` | past tense, correct |
| `tests/metrics.route.test.ts:22` | past tense, correct |
| `tests/internal-auth.middleware.unit.test.ts:15-16`, `:428` | past tense, correct |
| **`tests/internal-auth.middleware.unit.test.ts:55`, `:310`** | **present tense, false — MEDIUM-4** |
| `.claude/rules/tenant-isolation.md:22-24`, `:164` | past tense, correct |
| `known-gaps.md:4002`, `:4118`, `:4127` | past tense / explicit correction, correct |
| `docs/reviews/t-050-…:497`, `docs/plans/t-050-…:702`, `docs/plans/s-004-…`, `docs/qa/…` | historical records, correct when written — must not be edited |

### 2 · `AM22c`'s security measurement — re-derived, and it holds

Deleted the `if (!tenantId)` branch from `analytics.controller.ts`, mounted the real
`registerAnalyticsRoutes` and the real controller on a bare Fastify instance with **neither**
hook, and injected with **no headers**:

```
status=200  serviceCalled=1  tenantArg=undefined
body={"data":{"items":[{"metricKey":"CUSTOMER-DATA","bucketStart":"2026-03-01T00:00:00.000Z",…
```

Scoped suite under the same mutation: **`Tests 1 failed | 11 passed (12)`**, `AM22c` alone,
`→ expected 200 to be 500`. Verbatim as claimed.

**This settles a question Round 1 left open.** Three docblocks called the controller's tenant
guard a *second layer*; Round 1 could say only that it was untested. It is now measured to be the
**only** thing between a misplaced registration and a `200` carrying the service's payload to a
caller who sent no credentials, with `tenantArg` `undefined`. The claim now written into `AM22c`
is load-bearing and correct, and the reasoning about `undefined` (a repository built with it binds
`set_config('app.tenant_id', NULL)`, and `"tenantId" = NULL` is `NULL` for every row under RLS —
silently empty, not an error) matches what I measured at T-042's precedent in `known-gaps.md`.

**The other two new cases, each red alone:**

| Case | Mutation | Result |
|---|---|---|
| `AM22d` | tenant check moved **before** validation | `Tests 1 failed \| 11 passed (12)`, `→ expected 500 to be 400` |
| `AM22e` | `AppError` branch deleted | `Tests 1 failed \| 11 passed (12)`, `→ expected 500 to be 403` |

`AM22d` **does** cover NIT-2: it injects `ANALYTICS_ROUTES.METRICS` with **no querystring** at all
against the escaped composition and asserts `400 VALIDATION_ERROR` plus
`expect(getMetricsRollup).not.toHaveBeenCalled()`. `AM22e` asserts status and code from the
error's **own fields** rather than literals, and pins the presence of `message` as the
discriminator against `AM22b` — so the two cases cannot both pass under a single body contract.

Coverage moved as claimed: `analytics.controller.ts` **75.51/72.72 → 100/90**, the one remaining
uncovered line being `:87`, the `error instanceof Error ? … : String(error)` ternary's non-`Error`
arm. Package **92.59/85.29/92/92.59 → 95.37/88.05/92/95.37**, re-derived.

### 3 · MEDIUM-3's replacement — true, and it does not under-claim

`AI12`'s new comment (`:526-552`) reproduces **all three** of my Round-1 mutation rows exactly —
service-condition-only → 2 cached rows, both layers → 1 cached row, both layers with the
`toHaveLength(0)` assertion pinned → `['api.request']` against `['api.request','storage.write']` —
and states plainly that *"the two assertions after the cache-count check never execute under
either mutation"*. Verified against my own Round-1 measurements, which produced those same
values.

**It does not under-claim.** The risk in a correction like this is retreating to "this case
guards nothing"; it does the opposite, naming the property it *does* guard ("a filtered request
wrote the cache") and asserting that property is *"real and sufficient"* and *"red under both
mutations"* — both true, measured. It also carries the recipe for a case that would observe the
under-report (assert the unfiltered result **before** the cache-empty check) and points at
`docs/epics/README.md` § Q3a for the measurement. The only thing I would add is that `:541`'s
first assertion also guards the filter itself, which the sentence does not mention — too small to
grade.

### 4 · The two self-corrections

**S-58** (`known-gaps.md:4001-4008`) — correct, and more careful than my finding was. I wrote that
both clauses were now false; the entry distinguishes them: *"the first became false at T-051 …
the second was **already** false when it was written, because analytics never had a 'half' here
at all — its value has always matched gateway's."* Re-derived: gateway, usage, analytics and the
repo root all carry `dev-local-internal-secret-at-least-32-chars`; billing and worker carry
`dev-local-secret-change-in-production`. The correction is right and the attribution
(*"found this sentence by grepping the *claim* rather than a list of files"*) is accurate.

**LOW-2** (`rollup.repository.ts`, `readCachedPage`) — the new table is stated against `AI13`'s
own fixture and is **fully reconstructible**:

| | `2026-03-01` bucket | `2026-03-03` bucket |
|---|---|---|
| `UsageLine` tier (correct) | `2.000000` | `5.250000` |
| cache read with a truncated lower bound | `12.500000` | `5.250000` |

Checked against the suite's constants: `DAY_1_EARLY` `2026-03-01T03:00` / `10.500000`,
`DAY_1_AFTER_SIX` `2026-03-01T08:00` / `2.000000`, `DAY_3_NOON` `2026-03-03T12:00` / `5.250000`.
Over `[2026-03-01T06:00, 2026-03-04)` that is exactly my Round-1 reconstruction, including the
`17.750000` total. The docblock records the old `5.250000`/`22.750000` as coming from a Gate-3
probe fixture *"not on the tree and cannot be re-derived from it"*, and cites `AM16f` with
`Tests 1 failed | 143 passed (144)` **qualified "at the time it was taken"** — correct care, since
the suite is now 147.

### 5 · The reconciliation, all four sites

Every site now carries **"one probe route per placement"**: `src/app.ts:53`,
`src/routes/analytics.routes.ts:13`, `tests/metrics.route.test.ts:25`,
`.claude/rules/tenant-isolation.md:29`. The looser unqualified form is gone.

`metrics.route.test.ts`'s **file** docblock — the site Round 1 flagged as keeping the uncorrected
claim after only `AM20`'s inline comment was fixed — now carries both results and my exact
formulation: *"The real route in those placements answers `500` — or `400` for a request with no
querystring — and does **not** run … That is a second layer the probe handler did not have.
**Identical in the first layer, different in what follows.**"* It also self-corrects the `AM20`
attribution in its own voice (*"an earlier revision of this docblock claimed it failed on
`expect(getMetricsRollup).not.toHaveBeenCalled()` instead, which is measurably wrong on this
tree"*) while keeping that assertion and saying why.

### 6 · LOW-1, LOW-3, NIT-1 and the gate

**LOW-1** — `grep -c "D10"` on the plan → **3**. D10 is a full decision in §2.3, and `:69` adds a
callout under the `expectedBuckets` formula: *"This formula is where D10 was latent, and this plan
did not notice … The question that would have surfaced it at Gate 1 is one sentence: what does
this count when `from` is not a boundary?"* That is the fix plus the process ruling, in the plan's
own voice.

**LOW-3** — `:460` now reads `80 / 75 / 80 / 80`, quotes the config
(`lines: 80, functions: 80, statements: 80, branches: 75`) and records the mis-transcription.

**NIT-1** — S-61 now separates the fixture shape (pinned by `AI2`) from the counts.

**Compile-time gate, `--force`, 13 packages, `Cached: 0` on all four:**

```
lint       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total
typecheck  Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   23.043s
build      Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   22.946s
test       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total
```

**1 157 tests, 0 failures**; analytics **147/147, 13 files** (144 → 147). Lint **0 errors, exactly
14 warnings** — `apps/auth-service/tests/auth.service.unit.test.ts` (`d68e719`, 2026-08-25) and
`apps/usage-service/tests/ingestion.service.unit.test.ts` (`b0f6921`, 2026-08-31);
`git status --porcelain` on both apps empty. No analytics file in any lint, typecheck or build
output.

### 7 · Environment

Postgres before **and** after: `Tenant 2 | User 2`, and `Event`, `UsageLine`, `MetricRollup`,
`Meter`, `Invoice`, `InvoiceLineItem`, `RefreshToken`, `ExportAudit` all **0**. Nothing seeded;
`v1_7` untouched; no role changed. Redis db 0 went 2 → 3, the delta a self-expiring `denylist:`
key written by auth-service's suite during the mandated `pnpm test --force` (S-22); probes used
db 12. No `FLUSHDB`. `format:check` not run (S-12).

---

## What I could not verify this round, and why

1. **`AM22c`'s `CUSTOMER-DATA` body** as produced by that case's own composition — NIT-3. The
   three load-bearing values were reproduced; the label was not.
2. **Whether a seventh/eighth stale-claim spelling exists.** My sweep used fourteen patterns; it
   found two the implementer's did not, which is evidence the space is not exhausted rather than
   that it now is.
3. Carried forward unchanged from Round 1: S-61's `hour`-granularity inference; behaviour on a
   UTC-defaulted server (this host defaults to `Asia/Kolkata`); any real-process or socket path;
   `cacheRange` under concurrency; `MAX_CACHED_ROWS` at scale.

---

## Verdict

# APPROVED FOR QA

**with four text corrections carried to Gate 6**, none of which touches executable code.

Round 1's substantive finding is closed by measurement, not by assertion: the controller's tenant
guard now has three cases, the branch coverage went `72.72 → 90`, and the guard is **measured** to
be the only thing standing between a misplaced registration and `status=200 serviceCalled=1
tenantArg=undefined` with a payload on the wire. That converts three docblocks' prose into a
guard and is the most valuable thing this round produced. MEDIUM-3's replacement is accurate in
all three mutation rows and does not retreat; LOW-2's new table is reconstructible from the
shipped fixture; the reconciliation is correct and identically worded in all four places, with the
file docblock's own `AM20` misattribution self-corrected; LOW-1 landed with the process ruling
attached. The gate is genuinely green — 13/13, `Cached: 0`, 1 157 tests, 14 pre-existing warnings
with commits behind them.

The two new MEDIUMs are a stale tense in two test comments and two dangling id citations in one
`known-gaps.md` entry. Neither touches behaviour, the suite, tenant isolation or anything QA
exercises. Sending this back for a third rework round on the class that already cost S-9 three
rounds is the loop, not the remedy — so, per the convergence instruction, they are named and
carried.

**Must land before commit (Gate 6 re-checks):**
1. `apps/analytics-service/tests/internal-auth.middleware.unit.test.ts:54-55` — present-tense
   "production's scope is empty" (**MEDIUM-4**).
2. `apps/analytics-service/tests/internal-auth.middleware.unit.test.ts:309-310` — "holds no route
   to drive", contradicted by the same file's `:33-36` (**MEDIUM-4**).
3. `.claude/rules/known-gaps.md` S-59 `:4076` and `:4101` — cite
   `docs/reviews/s-009-analytics-internal-auth.md`, not the deleted S-9 entry (**MEDIUM-5**).
4. `apps/analytics-service/tests/metrics.route.test.ts:292` — quote `"api.request"` or label the
   stub (**NIT-3**).

**Recommended, out of scope here:** one line in **S-33** recording that this round's claim-grep
*returned* both stale sites and the **classification** step is where it failed — a third category
beside "counts" and "universals", and the argument for scoping the owed checker at **id
resolution** first, where no judgement is required.

---

## Round 3 — Gate 6, final review

Rounds 1 and 2 are untouched: `head -859 <this file> | md5sum` = `3d8e155565b9d4cfb50cdf9be1d70bff`,
identical to the whole-file md5 taken before this section was appended.

One mutation this round, restored (`md5sum -c` clean). One live database probe, seeded through
`DIRECT_DATABASE_URL` and torn down — tables back to baseline. Tree **28 entries** before and
after. Nothing committed, staged or branched.

`known-gaps.md` `cat`-ed from disk: md5 `51ce3be25ff63963777f53937a03d391`, **52** headings, S-61
at `:4261`, S-62 at `:4364`, `grep -c "^## S-9 "` → **0**.

---

## Findings

### MEDIUM-6 · The plan's sequence diagram and its prose still assert, in the present tense, that no route exists inside the guarded scope — and cite the deleted S-9 entry

`docs/plans/t-051-analytics-metrics-rollup.md`:

```
:41   Note over C,R: every arrow dashed — no route exists inside this scope today (S-9)
:44   **Every arrow is dashed** because no route exists inside that scope, so nothing currently
      traverses them — that absence is exactly what S-9 records and what T-051 discharges.
```

Three things are wrong and they are not the same thing.

1. **The prose is present tense and false.** "no route exists inside that scope", "nothing
   currently traverses them". `registerAnalyticsRoutes(analyticsApi, …)` is inside that callback
   at `src/app.ts:92`, and `AM20`/`AM23` traverse both hooks on every run.
2. **The diagram is a claim, and it is the wrong one.** `.claude/rules/review-standards.md`
   § *Universals Must Cite Their Mutation* is explicit — *"Diagrams are claims too … check that
   anything not yet built is labelled proposed rather than drawn as fact. A picture is read faster
   and trusted harder than the paragraph it replaced."* Every arrow in this `sequenceDiagram` is
   dashed **on the stated ground** that nothing traverses the scope. That ground is now false, so
   the picture asserts something the code contradicts — and, unlike the `flowchart` immediately
   below it, this one is **not** labelled *Proposed* (the flowchart is, correctly).
3. **`S-9 records` is a dangling entry citation** — MEDIUM-5's class, in a different file.
   `known-gaps.md` has no S-9 heading and now says so in its own voice three times, including at
   `:4006`: *"`known-gaps.md` carries no S-9 entry, **so do not cite one**."*

**The ruling you asked for: is a plan a historical record that may keep its original tense, or a
live document that must be corrected?**

`CLAUDE.md` makes the plan a **Gate-1 artifact** — *"A plan marks a task started, not finished —
Gate 1 writes it before any code exists, so nothing may read `docs/plans/` as evidence of
completion."* On that reading the tense at `:41`/`:44` was true when written and could stand, the
way Round 1 above stands.

**Two things defeat that here.**

- **This file is being maintained, not preserved.** The same batch edited it in four places for
  accuracy: D10 added to §2.3, the Gate-4 callout at `:69`, R4's mitigation clause corrected at
  `:481-486`, and `MAX_CACHED_BUCKETS` reconciled at `:444`. A document corrected in four places
  in one round cannot claim snapshot immunity in a fifth.
- **The repository already has the pattern for exactly this**, and it was used 25 lines later.
  `:69` is a blockquote in the plan's own voice — *"**This formula is where D10 was latent, and
  this plan did not notice** (Gate-4 LOW-1)"* — which preserves the original text *and* records
  what later measurement showed. That is the right shape, and it was available at `:41`/`:44`.

And the S-9 citation is **not a tense question at all**: no tense makes a deleted entry citable.

**Fix — keep the Gate-1 text, annotate it, re-point the citation:**
- `:41`, the Mermaid note → `every arrow dashed at Gate 1 — no route existed inside this scope then`.
- Immediately after `:44`, a blockquote in the `:69` shape: *"**Superseded at Gate 6.** T-051
  registered `GET /v1/analytics/metrics` inside this scope (`src/app.ts:92`), so the arrows are no
  longer dashed in fact; `AM20` and `AM23` traverse both hooks. The absence recorded here was the
  residue of the S-9 slice, whose `known-gaps.md` id is retired — the record is
  `docs/reviews/s-009-analytics-internal-auth.md` and this plan."*
- `:44`, `that absence is exactly what S-9 records` → `…what the S-9 slice recorded`.

**Disposition:** required before commit. Text-only, one file.

### LOW-4 · The `event.repository.ts` line correction reached one of the two sites that carry it

`update: {}` is at `apps/worker-service/src/repositories/event.repository.ts:175` — verified,
`:174` is the closing `}),`.

- `docs/plans/t-051-analytics-metrics-rollup.md:443` (R4's row) now cites **`:175`** ✓ — the fix.
- `docs/plans/t-051-analytics-metrics-rollup.md:87` still cites **`:174`** — the same claim
  (*"the aggregated columns are never rewritten after insert — worker's `UsageLine` upsert has
  `update: {}`"*), in the same file, with the same stale number.

Same shape as MEDIUM-4: the correction found one instance of a repeated claim. **Fix:** `:87` →
`:175`.

**Disposition:** required before commit. One number.

---

## Convergence — third instance of the class, and I am not opening a fourth round

MEDIUM-6 and LOW-4 are **the same class** as Rounds 1 and 2: a claim stated more strongly than it
holds, and a citation that does not resolve. That is three consecutive rounds on this task, on top
of six across S-9. Per your instruction I am **not** opening a fourth round; both fixes are named
above and the verdict is CONDITIONAL rather than CHANGES REQUESTED, which is a terminal state at
this gate rather than a new rework cycle.

**Carrying Round 2's refinement forward, and sharpening it.** Round 2 concluded that *ids are
machine-decidable and classification is not*. This round splits cleanly along that line and adds a
second machine-decidable category:

| This round's defect | Machine-decidable? | The check |
|---|---|---|
| `S-9 records` at plan `:44` | **yes** | does `## S-9` exist as a heading in `known-gaps.md`? No. |
| `event.repository.ts:174` at plan `:87` | **yes** | does that file's line 174 contain the quoted construct? No — it is at `:175`. |
| "no route exists … nothing currently traverses" | no | tense and truth against a tree state |
| every arrow dashed in the `sequenceDiagram` | no | a picture's claim against the code |

So **two of this round's four defect-halves are decidable with no judgement**, and they are two
*different* checks: **id resolution** (Round 2's recommendation) and **`path:line` resolution**
(new this round). The latter is the cheaper and higher-yield of the two — this task alone has
produced four stale `file:line` citations across three rounds, and S-33's own table already
records six more from T-045/T-047/T-048.

**What would break the tie:** S-33's owed checker, scoped to resolve **both** `S-nn` ids against
`known-gaps.md` headings **and** `path:line` citations against the file's content at that line.
Neither needs judgement, both are a few lines, and between them they would have caught MEDIUM-5,
LOW-4 and half of MEDIUM-6 mechanically. The tense-and-diagram half is not reachable by any
checker and is closed only by the discipline of rewriting a superseded sentence rather than
classifying it as tolerable — which is what the `:69` callout does correctly and `:41`/`:44` do
not.

---

## Verification detail

### 1 · "No production code moved" — re-derived, and it holds more strongly than claimed

I did not use the rework's fingerprint. I used **my own Round-1 snapshots**, taken before either
rework, and compared them comment-stripped against the current tree:

```
IDENTICAL (executable lines)  src/repositories/rollup.repository.ts
IDENTICAL (executable lines)  src/services/analytics.service.ts
IDENTICAL (executable lines)  src/app.ts
IDENTICAL (executable lines)  src/constants.ts
IDENTICAL (executable lines)  src/controllers/analytics.controller.ts
IDENTICAL (executable lines)  src/validators/metrics-query.validator.ts
```

Only two of the six differ by raw md5 — `rollup.repository.ts` (this round) and `app.ts`
(Round 2) — and **both differences are comments only**. So the claim holds for this round, and
the stronger statement also holds: **across both rework rounds, not one executable line of any of
these six files changed.**

Two files I held no Round-1 snapshot of, checked another way:
`src/middleware/internal-auth.middleware.ts` is **executable-identical to `HEAD`** (comment-only,
confirming Round 2's fix there was text too), and `src/routes/analytics.routes.ts`'s entire
executable body is ten lines, unchanged from what Round 1 read. Current `src/` fingerprint
`53e1656705449589c9af6e8c5ef2fd26`.

**So this re-review is a re-read for everything except S-62, which is new prose and which I drove
against the database.**

### 2 · MEDIUM-4's fixes, and the classification method

Both sites are correctly rewritten and neither hedges:

- `:53-60` — *"It was originally the stand-in for T-051's route, because production's guarded
  scope was then empty. **It is not a stand-in any more:** T-051 registered
  `GET /v1/analytics/metrics` inside that scope, and `tests/metrics.route.test.ts` drives it."*
  The dangling *"which is the whole subject of the docblock above"* clause — which pointed at a
  docblock the same agent had rewritten the previous round — is gone.
- `:310-316` — *"This composition was originally the only way to exercise them at all, because
  production's scope **then** held no route; since T-051 it does, and `AM23` in
  `tests/metrics.route.test.ts` observes the same ordering through"* the real route. That resolves
  the contradiction Round 2 raised with the same file's `:33-36`, by naming `AM23` exactly as
  asked.

**Re-running my own widened sweep on that file** returns three hits, all past tense and all true:
`:15-16`, `:315`, `:437`. The method generalises: enumerate every hit and classify each, rather
than fix the ones a reviewer named — which is what found the two I had and, at `:87` of the plan,
is what was *not* done (LOW-4).

### 3 · MEDIUM-5 — the re-pointed citations resolve, checked line by line

`known-gaps.md` S-59 now cites `docs/reviews/s-009-analytics-internal-auth.md` at `:4077` and
`:4105`. The four referenced lines say what is claimed:

| Cited | Content |
|---|---|
| `:35` | `internalApiSecret.length !== providedSecret.length \|\|   // <- length oracle` |
| `:49` | *"operand order catches it; the other does not."* |
| `:476` | *"it proves the file *spells* `secretsMatch` and does not spell one reverted operand order"* |
| `:913` | `### 1 · MEDIUM-1's replacement text — both operand orders re-derived, and the new sentence judged` |

A citation fixed by pointing somewhere else wrong would have been the same defect moved; it is
not. And the two surviving `S-9` mentions in `known-gaps.md` (`:4079`, `:4107`) are **explicit
corrections** saying no such entry exists.

### 4 · S-62 — re-derived against the live database, independently of QA and of the rework

Real `AnalyticsService` over the real `RollupRepository` against the real PostgreSQL as
**`telemetry_app`**, which I confirmed on that connection is `rolsuper = f, rolbypassrls = f`, so
RLS was genuinely enforcing. Fixtures seeded through `DIRECT_DATABASE_URL` and deleted in a
`finally`; all tables re-checked at baseline afterwards.

```
req1 (fallback)      -> 2026-04-01=17  2026-04-02=4     cached rows: 2
req2 (from cache)    -> 2026-04-01=17  2026-04-02=4
  ... 100 units land in 2026-04-01, a bucket that is already cached ...
TRUE day-1 total     -> 117
req3 (after arrival) -> 2026-04-01=17  2026-04-02=4
req4 (again)         -> 2026-04-01=17  2026-04-02=4
describeRangeCoverage-> {"expectedBuckets":2,"cachedBuckets":2,"bucketAligned":true}
```

**Verbatim.** Equal counts, the check validates, `117` is served as `17`, and two further requests
do not heal it. The entry's framing — *"a count can detect a bucket that is missing; it can never
detect a bucket that is present and wrong"* — is exactly what this shows, and the direction is
under-reporting, which S-61 itself calls "the dangerous one".

**Its three supporting claims, each re-derived rather than read:**

| Claim | Command | Result |
|---|---|---|
| `computedAt` written, never read | `grep -rn "computedAt" apps/analytics-service/src --include=*.ts` | **exactly one line**, `rollup.repository.ts:442`, inside the `INSERT … ON CONFLICT DO UPDATE` ✓ |
| no TTL, no invalidation | `grep -rniE "ttl\|invalidat\|deleteMany\|expire" apps/analytics-service/src --include=*.ts` | **nothing, exit 1** ✓ |
| no other `MetricRollup` writer | `grep -rn "MetricRollup" apps/*/src packages/*/src --include=*.ts` minus analytics | **nothing, exit 1** ✓ |

**The S-61/S-62 table is accurate in both directions.** I checked each of the five rows against
what I measured: S-61's idle-bucket case (Round 1: `expectedBuckets 3` vs `cachedBuckets 2`,
falls back forever, every answer correct) and S-62's populated-bucket case (above: `2` vs `2`,
validates, serves a silently low number). The fix shapes are genuinely different — a completeness
marker answers "was this computed?", a freshness signal answers "is it still right?" — which is
the sentence the entry closes on and it is the correct distinction. **Reciprocal pointers are in
place both ways**: S-61 at its `:87-88` (*"Read this with S-62, which is the same check failing
the other way"*) and S-62's whole *How this differs from S-61* section, which correctly invokes
the id-stability rule as the reason not to merge them.

**The fix direction is honest about the TTL.** It leads with *"a TTL is a decision, not the
obvious answer"*, states that **neither** the staleness window nor the recompute rate is derivable
from anything on this tree because `"UsageLine"` is empty on every environment and no lag
distribution exists, warns that a TTL short enough to matter may recompute more often than the
cache saves, and ends by calling the bound *"a product decision about how wrong a dashboard may
be"*. It offers two exact alternatives (a watermark; write-time invalidation) and names the
coupling objection against the second with the right precedents. That is a fix direction that
refuses to pre-empt a decision, which is what `CLAUDE.md` asks for.

**The forward obligation is real and correctly targeted.** Q11 is recorded as three dashboard
pages with Analytics backed by "nothing yet", and T-063 is named as the first consumer that would
be misled. The instruction — do not build a trend line or anything reconciled against an invoice
on this endpoint until this closes — is the right one.

**Severity: MEDIUM is right.** It is a wrong number, silently, for the right tenant — no tenant
boundary is crossed, the fallback tier is always correct, and nothing bills from this endpoint.
Not LOW, because it is silent, persistent, and in the under-reporting direction.

### 5 · R4's correction and the two references it found

**R4's correction is sound.** The original mitigation read *"the completeness check will usually
already be falling back"*; the entry and the plan both now state the opposite, and the opposite is
what I measured — the check falls back only on a **missing** bucket, never on a changed one, so
it does not mitigate staleness in any range the cache can serve. **R4's severity under D1-A is
stated as standing** (`:481-486`): D1 reduced frequency without removing the mechanism, *"a
correction to the mitigation, not to the decision"*, with S-62 named as the durable record and
`CLAUDE.md`'s plans-are-not-a-record rule given as the reason. Correct on every count.

`MAX_CACHED_BUCKETS` now survives only as **deliberate** references to the superseded name — plan
`:444` (*"shipped under that name rather than this row's original `MAX_CACHED_BUCKETS` — a
declared deviation"*) and `src/constants.ts:131`. Neither is a dangling citation; the constant
that exists is `MAX_CACHED_ROWS: 10_000`. ✓ The `event.repository.ts` half is LOW-4.

### 6 · S-62's `Tests 7 failed | 21 passed (28)` — re-measured, not carried

The figure was first taken when the suite was 144. Re-applied
`cachedBuckets === expectedBuckets` → `> 0` on the current tree and ran the two files the entry
names:

```
 Test Files  2 failed (2)
      Tests  7 failed | 21 passed (28)
```

Identical. The figure survived the growth legitimately — the three new cases landed in
`metrics.route.test.ts`, which is neither of the two files, so 13 + 15 = 28 is unchanged.
Re-measuring rather than carrying forward was the right instinct and the right answer.

### 7 · Final-review checklist

**Coverage alignment.** `analytics.controller.ts` **100 / 90**, the single uncovered line `:87`
being the `error instanceof Error ? … : String(error)` ternary's non-`Error` arm — a formatting
branch, not an error path. `routes`, `validators`, `services` at 100 % statements. Package
**95.37 / 88.05 / 92 / 95.37** against thresholds `80 / 75 / 80 / 80`. **Every error path in the
production code now has a test**: validation (`AM22`), absent tenant (`AM22c`), `AppError`
(`AM22e`), unexpected error (`AM22b`), cache-write failure (`AM19i`), and the repository's
one-row invariant is the only uncovered defensive throw.

**No orphaned code.** Every new export has a consumer or a test; the barrel re-exports match the
convention Round 1 established across billing and worker.

**Acceptance criteria.** AC1–AC12, all marked satisfied in QA's table and consistent with the
plan's §7 mapping and with what I drove directly in Rounds 1–3.

**Regression across the other 12 packages: none, structurally.** `git status --porcelain` shows
**zero** changes under `packages/` and **zero** in any app other than analytics. The full gate
confirms it: the other twelve packages' test counts are unchanged from Round 1.

**Breaking-change assessment: none.** No exported signature outside analytics changed. The only
contract additions are a new route and two new response codes, both additive.

**Compile-time gate, `--force`, 13 packages, `Cached: 0` on all four:**

```
lint       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total
typecheck  Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   22.121s
build      Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total   23.086s
test       Tasks: 13 successful, 13 total   Cached: 0 cached, 13 total
```

**1 157 tests, 0 failures**; analytics **147/147, 13 files**. Lint **0 errors, exactly 14
warnings** — `apps/auth-service/tests/auth.service.unit.test.ts` (`git log -1` → `d68e719`,
2026-08-25) and `apps/usage-service/tests/ingestion.service.unit.test.ts` (`b0f6921`,
2026-08-31); `git status --porcelain` on both apps empty. No analytics file in any output.

### 8 · Commit readiness

**One coherent atomic commit.** 28 entries: five new source files, six new test files, nine
modified `src/` files, one modified test file, the plan, three review rounds, the QA report, both
epic files, `.claude/rules/tenant-isolation.md`, and `.claude/rules/known-gaps.md` with S-9 and
S-53 removed and S-61 and S-62 added. `.claude/rules/git-commit.md` requires the plan and review
in the same commit; the QA report follows the same precedent.

**Nothing belongs elsewhere.** S-61 and S-62 are findings *of this task* about the cache this task
built — the S-39/S-57 convention puts those in the discovering commit. The S-9 and S-53
retirements are this task's own discharge of two entries it was assigned. The epic and
`docs/epics/README.md` edits are S-53's contracted correction and Q3a's record.

**Nothing forbidden is present.** No `.env`, no secrets beyond documented placeholders;
`apps/analytics-service/coverage/` and `dist/` are both gitignored
(`.gitignore:5` and `:4`, confirmed with `git check-ignore -v`) and neither appears in
`git status`. `git diff --cached --name-only` is empty — nothing is staged, so the commit author
must stage deliberately.

**Commit-message note:** the *Tests* line should read `91 added. analytics-service 147/147
passing; build/test/lint/typecheck 13/13 packages`, and the gate line should record **three**
review rounds with the final verdict, not a single approval.

### 9 · Environment

Postgres before **and** after: `Tenant 2 | User 2`, and `Event`, `UsageLine`, `MetricRollup`,
`Meter`, `Invoice`, `InvoiceLineItem`, `RefreshToken`, `ExportAudit` all **0** — re-checked after
the S-62 probe's teardown and again at the end. `v1_7` untouched, no role changed, seeding only
through `DIRECT_DATABASE_URL`. Redis db 0 went 2 → 3, the delta a self-expiring `denylist:` key
from auth-service's suite during the mandated `pnpm test --force` (S-22); my probes used db 12 and
I issued no write to db 0 and no `FLUSHDB`. `format:check` not run (S-12).

---

## What I could not verify, and why

1. **`docs/plans/`'s `:41` diagram as rendered.** I read the Mermaid source and judged the claim
   its arrow styles make; I did not render it.
2. **S-62 over real HTTP against a real process**, which is how QA took it. I drove the real
   service and repository in-process against the real database; the HTTP layer is inferred to be
   transparent here, and Round 1 measured that layer separately.
3. **Whether a fourth stale-claim site exists.** My sweeps this round covered the file MEDIUM-4
   named and the `S-9`/`S-53` corpus; the plan's `:41`/`:44` and `:87` were found by widening to
   `docs/plans/`, which suggests the space is still not exhausted.
4. Carried forward unchanged: S-61's `hour`-granularity inference; behaviour on a UTC-defaulted
   server (this host defaults to `Asia/Kolkata`); `cacheRange` under concurrency;
   `MAX_CACHED_ROWS` at scale; the real lag distribution S-62's TTL decision needs.

---

## Verdict

# CONDITIONAL

Two text corrections in **one file** are required before commit. Nothing else is outstanding, and
nothing behavioural is in doubt.

The change itself is ready. "No production code moved" is not only true for this round but for
both rework rounds — I proved it from my own pre-rework snapshots, comment-stripped, across six
files. MEDIUM-4 and MEDIUM-5 are properly fixed, and MEDIUM-5's replacement citations were checked
line by line rather than assumed. **S-62 is the strongest artifact this task produced**: I
re-derived its core transcript verbatim against the live database as a `NOSUPERUSER NOBYPASSRLS`
role — `{"expectedBuckets":2,"cachedBuckets":2,"bucketAligned":true}` while `117` is served as
`17`, twice, without healing — and all three of its supporting censuses. Its severity, its
separation from S-61, its reciprocal pointers and its refusal to present a TTL as the answer are
all right. R4's correction is sound and its severity is correctly stated as standing. The gate is
green — 13/13, `Cached: 0`, 1 157 tests, controller coverage `72.72 → 90` on branches, 14
pre-existing warnings with commits behind them — and the commit set is coherent and hygienic.

**Required before commit:**
1. `docs/plans/t-051-analytics-metrics-rollup.md:41` and `:44` — the `sequenceDiagram` note and
   the prose beneath it assert in the present tense that no route exists inside the guarded scope,
   and cite the deleted **S-9 entry**. Keep the Gate-1 text, add the `:69`-shaped superseded
   blockquote, and re-point the citation to the S-9 *slice* (**MEDIUM-6**).
2. `docs/plans/t-051-analytics-metrics-rollup.md:87` — `event.repository.ts:174` → `:175`, the
   second site of a claim corrected at `:443` only (**LOW-4**).

**Recommended, out of scope here:** S-33's owed checker should resolve **both** `S-nn` ids against
`known-gaps.md` headings **and** `path:line` citations against file content — two judgement-free
checks that between them would have caught MEDIUM-5, LOW-4 and half of MEDIUM-6. This round is the
evidence for the second, which Round 2 did not have.

**Re-check is a re-read of two lines**, not a re-run: neither fix touches executable code, and the
`src/` fingerprint above is the baseline to compare against.
