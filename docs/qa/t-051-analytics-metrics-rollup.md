# QA Report — T-051 · `GET /v1/analytics/metrics`

**Gate 5 · Verdict: PASS**

Tree under test: `main` at `dc2c268`, T-051 **uncommitted**, 27 working-tree entries (14 modified,
13 untracked). Tree and `git status` byte-identical to their pre-QA baseline at the end of this
run; database and Redis returned to baseline. See §9.

Nothing was committed, staged or branched. No tracked file was restored with `git checkout --`,
`git restore` or `git stash`; the one mutation was reverted from a `cp` backup and `md5sum -c`
verified.

---

## 1 · Findings

| # | Grade | Subject | Disposition |
|---|---|---|---|
| **F-1** | **MEDIUM** | Cache staleness (risk R4) is recorded **only** in `docs/plans/`, which `CLAUDE.md` forbids reading as a record — and its stated mitigation is measurably false in the one case where the cache works | **Recommend for `known-gaps.md`.** Behaviour itself is a disclosed, user-ruled decision. **Not a blocker.** |
| F-2 | LOW | `totalQuantity` is canonicalised, not scale-preserving: `12.500000` in the column crosses the wire as `"12.5"` | Record only; contract is satisfied. |
| O-1 | observation | S-61's explicitly-unmeasured `hour`-granularity claim now has a measured instance | Offer to S-61. |
| O-2 | observation | First measured cache-hit speedup: **29 ms vs 163 ms** at 9 999 rows | Offer to S-61. |

The four queued text corrections were re-derived and are **correct as logged** — not re-raised:
`tests/internal-auth.middleware.unit.test.ts:55` ("scope is empty") and `:309-310` ("production's
own scope holds no route to drive") are both false now that T-051 registers a route inside the
scope, and are contradicted by `:33-36` in the same file; `known-gaps.md` `:4076` and `:4101`
both cite S-9 while `:4006` in the same entry says "`known-gaps.md` carries no S-9 entry", and
`grep -c "^## S-9 "` returns **0**.

---

### F-1 · MEDIUM — the cache serves stale totals indefinitely, and the only record of that says otherwise

**The behaviour is not a surprise and is not the finding.** `docs/plans/t-051-analytics-metrics-rollup.md:443`
records it as risk **R4** — *"Cache goes stale when usage lands late (stream lag, dead-letter
replay, S-45 absorption)"* — graded **LOW under D1-A**, the option the user ruled. The finding is
two things about the *record*, both of which matter more than they sound.

#### (a) The mitigation sentence is false in exactly the case that matters

R4's grade rests on this clause:

> Under A the aggregated columns are never rewritten […] so only new rows in a past bucket cause
> it, **and the completeness check will usually already be falling back.**

The completeness check counts buckets — `cachedBuckets === expectedBuckets`. It can detect a
**missing** bucket. It can never detect a **changed** one. So it falls back only when the range
contains an idle bucket, which is precisely the case where the cache is useless anyway (S-61).
Whenever the cache genuinely works, the check validates and the staleness is invisible to it.

Measured over real HTTP against a real analytics-service process, two shapes:

**Single-bucket range**

```
seed 10 units on 2026-04-01
req1 -> ["10"]   (fallback, writes cache)
req2 -> ["10"]   (servedFrom: cache)
+7 more units land in that same already-cached day bucket
true total in "UsageLine" = 17.000000
req3 -> ["10"]   (servedFrom: cache)
```

**Two-bucket range, every bucket populated — the case the cache exists for, and the case `AI9` pins**

```
req1 -> ["17","4"]   (fallback, writes cache)
req2 -> ["17","4"]   (servedFrom: cache)
+100 units land in day 1, which is already cached
true day-1 total = 117.000000
req3 -> ["17","4"]   (servedFrom: cache)
req4 -> ["17","4"]   (servedFrom: cache)
```

`117` is reported as `17`. It does not recover: there is no TTL, no invalidation, and no writer
anywhere that touches `"MetricRollup"` outside this endpoint. `computedAt` **is written and never
read** — `grep -n "computedAt" apps/analytics-service/src` finds it only in `cacheRange`'s
`INSERT`/`DO UPDATE`. The only thing that would refresh that bucket is a *different* request whose
range happens to contain an idle bucket, forcing a fallback that rewrites the whole range.

So the direction of the error is **under-reporting**, silently, on a customer-facing endpoint —
the same direction S-61 itself calls "the dangerous one" when rejecting an alternative design.

#### (b) The record is in a file that must not be read as a record

`CLAUDE.md` is explicit that a plan marks a task *started* and that nothing may read
`docs/plans/` as evidence. S-25 and S-44 are both filed for precisely this — an accepted cost
that lives only in a plan or a release note. R4 is **not** in `known-gaps.md`. S-61 is adjacent
but is a different property: it is about the cache being *unreachable*; this is about the cache
being *reachable and wrong*. S-61's only mention of staleness is inside its rejected-alternatives
section, describing a hazard it claims the current design avoids.

Checked, not assumed: `grep -n -i "stale|invalidat|ttl|computedAt"` over
`docs/reviews/t-051-analytics-metrics-rollup.md` returns only matches about *stale comments* and
*stale claims* — the review never examined cache staleness.

#### Why this is not a blocker

The behaviour was disclosed at planning, put on page one of the plan, tied to an explicit user
decision (D1), and the alternative (D1-B) was correctly identified as making it *universal*
rather than exceptional. Every answer the fallback tier gives is correct. No tenant boundary is
crossed. Nothing consumes this endpoint for billing — `GET /v1/billing/invoices/:id` is a
separate path over `Invoice`, and `grep -rn "metricRollup" apps/*/src` outside analytics returns
nothing. The consequence is a dashboard number that is quietly low until the range shape changes.

**Recommended for `known-gaps.md`**: file R4 as its own entry (or as a named section of S-61,
whose title would then need widening — the id-stability rule makes a new id the cleaner option),
carrying the two measured transcripts above, the "`computedAt` is written and never read"
observation, and a correction of the mitigation clause to what was measured: *the completeness
check falls back only on a missing bucket, never on a changed one, so it does not mitigate
staleness in any range the cache can actually serve.*

---

### F-2 · LOW — `totalQuantity` is canonicalised, not scale-preserving

`Decimal(18,6)` values cross the wire as canonical decimal strings, not at the column's scale:

| Stored in `"UsageLine"` / `"MetricRollup"` | On the wire |
|---|---|
| `12.500000` | `"12.5"` |
| `3.250000` | `"3.25"` |
| `1.000000` | `"1"` |
| `999.000000` | `"999"` |
| `999999999999.999999` | `"999999999999.999999"` |

The contract in AC11 — *"`totalQuantity` is a string; no `Prisma.Decimal` in the response"* — is
**fully satisfied**, and the precision property is satisfied in the strongest available form
(§2.5). What is not preserved is the *scale*: a consumer diffing an API value against a column
value, or formatting on string width, sees `"1"` where the database holds `1.000000`. Purely an
observation about the contract's silence on formatting; no defect, no action required beyond
recording it.

---

## 2 · What I exercised that neither review round could — real processes

Every seam measurement at Gates 3 and 4 went through `app.inject` or a composed in-process app.
**T-051 ships a real route inside the guarded scope**, so unlike the S-9 QA no probe route was
needed and none was added.

Fixtures were seeded through `DIRECT_DATABASE_URL` under the two **existing** tenants with
`t051qa-`-prefixed ids, so `Tenant` never moved from 2. Tenant **A** = `d4101ff1-…`, tenant
**B** = `456793cd-…`.

### 2.1 · The ladder, on a real socket, with real tenant-scoped data

| Request | Status | Body |
|---|---|---|
| `/health`, no credentials | `200` | `{"status":"ok","service":"analytics-service"}` |
| `/v1/analytics/metrics`, no headers | `401` | `{"code":"UNAUTHORIZED"}` |
| wrong secret | `401` | `{"code":"UNAUTHORIZED"}` |
| secret only | `401` | `{"code":"TENANT_CONTEXT_MISSING",...}` |
| secret + non-UUID tenant | `401` | `{"code":"TENANT_CONTEXT_INVALID",...}` |
| secret + **tenant A** | `200` | `12.5`, `3.25`, `5.25` — `total: 3` |
| secret + **tenant B** | `200` | `999` — `total: 1` |

The guard ladder is unchanged from S-9 and now sits in front of real tenant-scoped data.

### 2.2 · The two spoofing rows, which now mean something

Real gateway process proxying to the real analytics process, real HS256 JWTs minted per tenant.
At S-9 these rows returned a probe payload with no tenant meaning; here they demonstrate actual
cross-tenant non-leakage.

| Case | Result |
|---|---|
| no JWT | `401 TOKEN_MISSING` |
| JWT(A) | `200` — `['12.5','3.25','5.25']` |
| JWT(B) | `200` — `['999']` |
| **JWT(A) + spoofed WRONG `x-internal-secret`** | `200` — **A's rows**; the gateway overwrote the spoofed secret |
| **JWT(A) + spoofed `x-tenant-id: B`** | `200` — **A's rows**, not B's `999` |
| **JWT(B) + spoofed `x-tenant-id: A`** | `200` — **B's `999`**, not A's rows |
| no JWT + spoofed secret **and** tenant A | `401 TOKEN_MISSING` — never reaches analytics |

Both spoof directions resolve to the **JWT's** tenant. Layer 1 of
`.claude/rules/tenant-isolation.md` holds for this endpoint against real data, measured rather
than inferred.

### 2.3 · `cacheRange` under concurrency — **untested anywhere before this**

S-38's vacuity warning applies, so overlap is **proven**, not assumed: the proof is that N
requests all logged `cachedBuckets` below `expectedBuckets` and all proceeded to write, i.e. each
decided to cache before any other's write had committed.

**Run 1 — 8 simultaneous, `day`, aligned, unfiltered.** `3` of 8 logged `cachedBuckets: 0` and all
3 wrote; the other 5 arrived after a commit and were served from cache. All `200`, all responses
byte-identical, final table 3 rows, **0** duplicates.

**Run 2 — 16 simultaneous, `hour`.** At `hour` granularity over a 72-hour range with 4 populated
buckets the cache can never validate (S-61), so **every** request writes. Result: `16 × 200`,
`16 × servedFrom: usage`, **16** cache writes, all responses byte-identical, 4 rows, 0 duplicates,
zero errors.

**Run 3 — 12 simultaneous, 9 999-row upsert each.** Cache deleted first so all 12 raced:
`12 × 200`, `12 × servedFrom: usage`, **12** concurrent 9 999-row upserts, **0** deadlocks,
**0** `P2002`, **0** cache-write failures, final table exactly `9999` rows, **0** duplicate
`(tenantId, metricKey, granularity, bucketStart)` groups.

**Verdict: no `P2002`, no upsert race, no duplicated rows, no deadlock, at any scale tried.** The
single-statement `INSERT … SELECT … ON CONFLICT DO UPDATE` inside the tenant transaction holds,
and the docblock's claim that "a concurrent writer cannot leave the cache half-populated" is
consistent with every run. The unique index `MetricRollup_tenantId_metricKey_granularity_bucketStart_key`
exists and is what `ON CONFLICT` matches.

*Stated at measured strength*: deadlock-freedom was **observed** across 36 concurrent writers in
three runs, not proven. The plausible mechanism — every writer runs the identical `SELECT … GROUP
BY` and therefore takes row locks in the same order — is **inference, not measurement**. A future
change that makes two writers process the same rows in different orders would not be caught by
anything here.

### 2.4 · `MAX_CACHED_ROWS` at scale — **untested against the database before this**

10 105 `UsageLine` rows seeded across 101 metrics × 100 hourly buckets.

| Grouped rows | `ANALYTICS_METRICS.MAX_CACHED_ROWS` | Read | Cache write | Rows written |
|---|---|---|---|---|
| **9 999** (99-hour window) | 10 000 | `200`, `total: 9999`, 163 ms | populated | **9 999** |
| **10 100** (100-hour window) | 10 000 | `200`, `total: 10100`, **50 ms** | **declined** | **0** |

The boundary is exact and inclusive at the limit. The decline is logged as a `warn` naming both
figures — `"groupedRowCount":10100, "limit":10000, "Metrics rollup cache write declined: range
exceeds the cached-row ceiling"` — and **the read is unaffected**, which is risk R5's stated
intent: only the optimisation is declined, never the answer. Pagination remains coherent above
the ceiling (`total: 10100`, `page: 1`, `pageSize: 20`), and the largest reachable offset
(`(10000-1) × 100`) exceeds it comfortably.

### 2.5 · `Decimal(18,6)` across **and below** the wire

Seeded `999999999999.999999` — 18 significant digits, unrepresentable in IEEE-754
(`node -p '(999999999999.999999).toString()'` → `1000000000000`).

Over real HTTP, raw bytes, **both tiers**:

```
"totalQuantity":"999999999999.999999"        servedFrom: usage
"totalQuantity":"999999999999.999999"        servedFrom: cache
```

Quoted — a JSON string, not a number — and exact. Below the HTTP boundary, driving the real
`AnalyticsService` over the real `RollupRepository` against `telemetry_app` and deep-walking the
returned object:

```
typeof totalQuantity = string    instanceof Prisma.Decimal = false
typeof bucketStart   = string    instanceof Date           = false
non-primitive leaves in the result: NONE
```

No `Prisma.Decimal` and no `Date` reaches the service's return value at all. AC11 is satisfied at
both boundaries.

### 2.6 · `page` over HTTP — **S-40 is closed for analytics**

Every value that produces a reachable `500` in billing and usage-service (S-40) produces a clean
`400` here:

| Query | Result |
|---|---|
| `page=1` | `200` |
| `page=10000` (`MAX_PAGE`) | `200`, `items: []`, `page: 10000` |
| `page=10001` | `400` `page: Number must be less than or equal to 10000` |
| `page=0`, `page=-1` | `400` `… greater than or equal to 1` |
| `page=1.5` | `400` `Expected integer, received float` |
| **`page=1e18`** | **`400`** — S-40's crash value |
| **`page=9223372036854775807`** | **`400`** |
| `page=1e400` | `400` |
| `page=NaN`, `page=abc` | `400` `Expected number, received nan` |
| `pageSize=100` / `101` / `0` | `200` / `400` / `400` |

**No `500` at any value tried.** D2's `MAX_PAGE: 10_000` does on a live service what the
reviewer's 140-combination schema sweep predicted.

### 2.7 · The timezone property on a real server — and on CI's

This host's PostgreSQL defaults to **`Asia/Kolkata`** (`show timezone`), confirming the
reviewer's observation.

**`AI8` is genuinely portable, and its own `options=-c timezone=` is what carries it.** The suite
was run with three different *base* session zones — `withSessionTimeZone` uses
`searchParams.set`, so its per-case pin replaces whatever the base carries:

| Base `DATABASE_URL` session zone | Result |
|---|---|
| ambient (server default `Asia/Kolkata`) | `23 passed (23)` |
| pinned `UTC` — **CI's shape** | `23 passed (23)` |
| pinned `America/New_York` | `23 passed (23)` |

**And the guard is load-bearing on a UTC server too**, which is the property nobody had checked
and the whole subject of S-21. Reverting `utcTimestampBound` to a bound JS `Date` with no cast —
the exact S-18 defect:

| Base session zone | Result under the mutation |
|---|---|
| ambient `Asia/Kolkata` | **`12 failed \| 11 passed (23)`** |
| pinned `UTC` (CI's shape) | **`12 failed \| 11 passed (23)`** |

Identical in both — `AI7`, `AI7c`, `AI8`, `AI8b` and others. So analytics' guard, unlike
usage-service's equivalent (which S-21 records as staying 17/17 green under the same revert
because its session pin masks it), would go red on CI. **D7's decision not to add a session pin
is what makes the guard observable**, and that trade is vindicated by measurement. Mutation
reverted; `md5sum -c` OK.

### 2.8 · The two tiers, and the decisions, over HTTP

- **Both tiers agree byte-for-byte.** Same range, cache deleted then repopulated: the
  `servedFrom: usage` response and the `servedFrom: cache` response are **identical files**
  (`diff` clean). That is D4 — one `interval` fragment for both tiers — end to end.
- **The cache does hit** (S-61's positive case, over HTTP rather than in-process): tenant A with
  usage on all three days, `servedFrom: cache` on the second request.
- **S-61's negative case, live**: tenant B with usage on 1 of 3 days logs
  `expectedBuckets: 3, cachedBuckets: 1` and falls back on **every** request, forever.
- **D3** — a `metricKey`-filtered request answered `200` and wrote **0** rows, logging
  `"reason":"metric-filtered"`.
- **D10** — an unaligned `[06:00, …)` range answered `200` with `['2','3.25','5.25']` and wrote
  **0** rows, logging `"reason":"range-not-bucket-aligned"`. `2` is the correct post-06:00 total;
  `12.5` would have been the whole day. The defect the decision exists to prevent, measured live.

---

## 3 · Acceptance criteria — AC1 to AC12

| AC | Criterion | Status | Behaviour or text? |
|---|---|---|---|
| AC1 | `200` with `{data:{items,total,page,pageSize}}`, item shape | **Satisfied** — §2.1, exact envelope over HTTP | Behavioural (`AM21`, `AI1`) |
| AC2 | UTC buckets for `hour`/`day`/`week`; `bucketEnd = bucketStart + 1 unit` | **Satisfied** — §2.7, 23/23 under three base zones, 12 red under the S-18 mutation | Behavioural (`AI2`,`AI3`,`AI7`,`AI8`). `AM13` asserts the **emitted SQL**, not source text |
| AC3 | `metricKey` filters | **Satisfied** — §2.8 | Behavioural |
| AC4 | Invalid `from`/`to`/`granularity`/`from>=to` → `400` | **Satisfied** — §2.6 plus range/granularity probes | Behavioural |
| AC5 | Pagination honoured; `total` is the grouped-row count | **Satisfied** — `total: 10100` against 10 105 usage rows in §2.4 is the discriminating case | Behavioural |
| AC6 | A complete cache is served without reading `UsageLine` | **Satisfied** — §2.8; `AI9` pins it non-vacuously (sentinel values + deleted usage rows) | Behavioural |
| AC7 | One absent bucket ⇒ whole range from `UsageLine` | **Satisfied** — §2.8 tenant B, `3` vs `1` | Behavioural |
| AC8 | A fallback result is upserted into `MetricRollup` | **Satisfied** — §2.3, §2.4 | Behavioural |
| AC9 | Route inside the guarded scope: no secret ⇒ `401` **and the service never called** | **Satisfied** — §2.1; `src/app.ts` calls `registerAnalyticsRoutes(analyticsApi, …)` **inside** the `app.register` callback, discharging S-9's standing obligation | Behavioural (`AM20`), plus the reviewer's four-placement measurement |
| AC10 | Another tenant's rows are never returned | **Satisfied** — §2.1 and §2.2, both spoof directions | Behavioural, **plus** `AM16`/`AM16e` which assert **bound values** in the emitted SQL (the S-46 shape — see below) |
| AC11 | `totalQuantity` a string; no `Prisma.Decimal` in the response | **Satisfied** — §2.5, at and below the boundary | Behavioural |
| AC12 | `/health` still `200` unauthenticated | **Satisfied** — §2.1 | Behavioural (`AU23`) |

### Coverage honesty

**T-051's own six new test files contain no source-text assertions.** Verified:
`grep -ln "readFileSync\|readSource" apps/analytics-service/tests/*.ts` returns only
`env.schema.unit.test.ts` and `internal-auth.middleware.unit.test.ts`, both S-9-era. The three
source-text cases in analytics remain **`AU15`**, **`AU16`** and **`AU22b`**, all inherited from
S-9 and all flagged as text assertions in that task's QA report. This is a materially stronger
coverage story than S-9's.

Two cases deserve a category of their own, and it is **not** "source text":

- **`AM16` / `AM16e`** assert the **bound values of the emitted SQL** against a Prisma double —
  `statement.values` contains the repository's own tenant and not another's, bound rather than
  interpolated. This is the correct response to **S-46**: `"UsageLine"` and `"MetricRollup"` both
  have RLS enabled with a `current_setting('app.tenant_id')` policy, so no row-set assertion can
  observe the application-layer predicate. It is stronger than a text census because it catches a
  predicate removal regardless of spelling.
- **`AM13`** asserts on `statement.sql` — the **generated** query, not the source file — that no
  `AT TIME ZONE` appears on the column (S-53). Same category.

The honest limit: per S-46, **no behavioural test on this tree can observe the application-layer
tenant predicate**, because RLS supplies the identical answer with or without it. §2.2's spoofing
rows prove *isolation*; they do not prove *which layer* delivers it. `AM16`/`AM16e` are the only
thing that goes red when the predicate is removed. Do not delete one on the evidence that
deleting it is green.

---

## 4 · Full gate, all 13 packages, `--force`

Run twice — once on the tree as received, once on the restored tree after the mutation was
reverted and all fixtures deleted. **Identical both times.**

| Task | Tasks | Cached | Exit |
|---|---|---|---|
| `pnpm build --force` | 13 successful, 13 total | **0 cached, 13 total** | 0 |
| `pnpm typecheck --force` | 13 successful, 13 total | **0 cached, 13 total** | 0 |
| `pnpm lint --force` | 13 successful, 13 total | **0 cached, 13 total** | 0 |
| `pnpm test --force` | 13 successful, 13 total | **0 cached, 13 total** | 0 |

### Per-package tests — **1157 total, 0 failures**

| Package | Tests | | Package | Tests |
|---|---|---|---|---|
| `shared-types` | 8 | | **`analytics-service`** | **147** (13 files) |
| `shared-config` | 4 | | `gateway` | 50 |
| `shared-logger` | 4 | | `usage-service` | 238 |
| `shared-tracing` | 2 | | `auth-service` | 166 |
| `shared-validation` | 30 | | `billing-service` | 231 |
| `shared-utils` | 26 | | `worker-service` | 251 |

The thirteenth package is **`@telemetry/web`** — `vitest run --passWithNoTests`, no test files,
contributing 0 to the 1157 and counted among the 13 successful turbo tasks.

**Coverage (analytics, `--coverage`): `95.37 / 88.05 / 92 / 95.37`** — matches the stated figures
exactly, at 147/147.

### Lint — 14 warnings, 0 errors, all pre-existing and proven

```
@telemetry/auth-service:lint:  ✖ 10 problems (0 errors, 10 warnings)
@telemetry/usage-service:lint: ✖  4 problems (0 errors, 4 warnings)

apps/auth-service/tests/auth.service.unit.test.ts        d68e719  2026-08-25
apps/usage-service/tests/ingestion.service.unit.test.ts  b0f6921  2026-08-31
```

Both files are committed, both predate T-051, and neither is in the 27-entry working set.
`pnpm format:check` was not run (S-12).

---

## 5 · Regression risk across the other 12 packages

```
git status --porcelain packages/                          -> 0 entries
git status --porcelain apps/ | grep -v analytics-service  -> 0 entries
```

No shared package and no other app is touched. The change is confined to
`apps/analytics-service`, two `.claude/rules/` files and two `docs/epics/` files. Every symbol
newly consumed (`PaginatedResult`, `TenantId`, `iso8601Schema`, `Prisma.sql`) is pre-existing.
Combined with 13/13 green on all four tasks with `Cached: 0`, **no breaking change is introduced
in the other 12 packages.**

`prisma/schema.prisma` is **not** modified — `"MetricRollup"` already existed with RLS enabled
and forced, a `FOR ALL` policy carrying `USING` **and** `WITH CHECK`, the required unique index,
and `telemetry_app` already holding `SELECT/INSERT/UPDATE/DELETE`. No migration and no new grant,
confirmed against the live catalog.

---

## 6 · What I could **not** verify, and why

1. **Deadlock-freedom as a property.** Observed across 36 concurrent writers in three runs, not
   proven. The same-lock-order mechanism is inference (§2.3).
2. **A production-shaped `hour`-granularity hit rate.** S-61 explicitly leaves this unmeasured. I
   measured one synthetic instance (§2.3 run 2, O-1), not a real tenant's data.
3. **Whether the stale window ever self-heals under real traffic.** F-1 measured that it does not
   for a fixed range; a workload mixing range shapes would occasionally force a rewrite, and that
   was not modelled.
4. **A genuinely UTC-defaulted PostgreSQL server.** I varied the *session* zone, including to
   `UTC`, which is what the suite itself controls. Changing the server default needs
   `ALTER DATABASE` or a restart; both were out of scope under the hard constraints. The
   session-level result (§2.7) is what CI's connections would see.
5. **The reviewer's ten mutation claims, the four route placements, `AM22c`, D2's 140-combination
   sweep and D10's alignment guard.** Deliberately not re-run — that reprints the review. I
   verified the conclusions they support behaviourally over real sockets instead.
6. **Container / compose behaviour.** The Docker daemon is not running in this environment (same
   as at S-9), and compose would conflict with the native PostgreSQL and Redis on 5432/6379,
   which the constraints forbid stopping.

---

## 7 · Recommended for `.claude/rules/known-gaps.md`

1. **F-1** — cache staleness. File R4 as a durable entry with the two transcripts, the
   `computedAt`-written-never-read observation, and a corrected mitigation clause. This is the
   only recommendation with substance behind it.
2. **O-1** — offer S-61 a measured `hour`-granularity instance: a 72-hour range with 4 populated
   buckets never validated across 16 consecutive requests, each of which performed a full
   aggregation **and** a cache write. S-61 currently marks this bullet "Not measured, and stated
   as reasoning".
3. **O-2** — offer S-61 the first cache-hit figure: at 9 999 grouped rows, **29 ms** served from
   cache against **163 ms** aggregated from `UsageLine` (~5.6×). S-61 argues the optimisation is
   worth preserving; this is the first number behind that.

F-2 is recorded in this report only.

---

## 8 · Environment hygiene

| Table | Before | After |
|---|---|---|
| `Tenant` | **2** | **2** |
| `User` | **2** | **2** |
| `Event` | 0 | 0 |
| `UsageLine` | 0 | 0 |
| `MetricRollup` | 0 | 0 |
| `Meter` | 0 | 0 |
| `Invoice` | 0 | 0 |
| `InvoiceLineItem` | 0 | 0 |
| `RefreshToken` | 0 | 0 |
| `ExportAudit` | 0 | 0 |

Peak fixture volume was **10 106** `Event` and **10 106** `UsageLine` rows plus up to 9 999
`MetricRollup` rows. All seeded through `DIRECT_DATABASE_URL` under the two existing tenants —
**no `Tenant` row was created** — and all deleted by explicit id prefix (`t051qa-%`) and by
`tenantId`: `DELETE 10106`, `DELETE 10106`, then `DELETE 4`/`DELETE 4`/`DELETE 2` for the
staleness fixtures. No running service was ever pointed at `DIRECT_DATABASE_URL`; both probe
processes used the `telemetry_app` runtime DSN. `v1_7` was not rolled back and no role was
dropped.

**Redis.** All probe traffic confined to **db 12**; final `db12=0`, `db13/14/15=0`. db 0 reads
`3` against a baseline of `2`; inspected rather than assumed — the contents are `telemetry:events`
(no TTL, pre-existing) plus two `denylist:<hash>` keys with live TTLs of 326 s and 864 s. That is
the documented **S-22** mechanism: auth-service's suite writes self-expiring denylist keys to db 0
during `pnpm test`, which I ran twice. Nothing was written to or flushed from db 0 by me.

---

## 9 · Restoration ledger

One source file was mutated. The revert was from a `cp` backup taken beforehand and verified with
`md5sum -c`. **No `git checkout --`, `git restore` or `git stash` was used on any tracked file.**

| File | Mutation | Restored | `md5sum -c` |
|---|---|---|---|
| `apps/analytics-service/src/repositories/rollup.repository.ts` | `utcTimestampBound` → bound JS `Date`, no cast (the S-18 defect) | from `rollup.pristine` | **OK** (`69e630ce…`) |

**No probe route was added** — T-051 ships a real one. Two throwaway scripts (`qa-mint.mjs`,
`qa-decimal-probe.mts`) were written into package directories to resolve workspace dependencies
and deleted immediately.

```
find apps/analytics-service apps/gateway -name '*.ts' | xargs md5sum | diff - tree.before.md5
  -> TREE IDENTICAL   (78 files)
git status --porcelain | diff - status.before.txt
  -> GIT STATUS IDENTICAL (27 entries)
```

All spawned processes terminated; no orphan service process remains.

---

## 10 · Release-readiness call

# PASS

**T-051 is release-ready from QA's standpoint**, subject to the four text corrections already
queued for Gate 6, which I re-derived and confirm are correctly stated.

- **The endpoint does what it claims, driven as real processes.** Both tiers agree byte-for-byte;
  the cache demonstrably hits and demonstrably falls back for the documented reason; D3 and D10
  both refuse the cache live with the correct logged reason and the correct `2`-not-`12.5`
  arithmetic; `Decimal(18,6)` survives at 18 significant digits where IEEE-754 would not, at and
  below the HTTP boundary.
- **Two untested paths are now tested and both hold.** `cacheRange` survived 36 concurrent
  writers across three runs — including twelve simultaneous 9 999-row upserts — with zero
  `P2002`, zero deadlocks and zero duplicate rows. `MAX_CACHED_ROWS` is exact at the boundary,
  declines only the write, and leaves the read correct and fast.
- **S-40 is closed for analytics**: every value that crashes billing and usage returns `400`.
- **The timezone guard is portable and load-bearing on CI's server shape**, which is the property
  S-21 exists to worry about and which no previous gate could check. D7's refusal to add a
  session pin is vindicated by measurement rather than argument.
- **S-9's standing obligation is discharged**: the route is registered inside the guarded scope,
  and the two spoofing rows — which at S-9 could only return a probe payload — now show real
  cross-tenant data resolving to the JWT's tenant in both directions.
- **The gate is genuinely green**: 13/13 × 4 with `Cached: 0`, 1157 tests, analytics 147/147 across
  13 files, coverage `95.37/88.05/92/95.37`, 14 warnings all proven pre-existing.
- **T-051's own tests carry no source-text assertions** — a real improvement on S-9, and the two
  structural cases that do exist (`AM16`/`AM16e`, `AM13`) assert emitted SQL, which is the correct
  answer to S-46 rather than a weaker substitute for it.

**FAIL was not warranted.** No acceptance criterion is unmet, no regression is introduced, and the
one MEDIUM is not a defect in shipped behaviour: it is a disclosed, user-ruled trade whose record
sits in a file `CLAUDE.md` forbids treating as a record, carrying one mitigation sentence that my
measurement refutes. The fix is an entry in `known-gaps.md`, not a change to the diff.

**The caveat to carry forward.** Once a range's buckets are all populated, this endpoint will
report a stale total indefinitely, in the under-reporting direction, with nothing logging that it
did so — and the completeness check cannot detect it, because it counts buckets and never compares
values. That is acceptable today because nothing bills from this endpoint. It stops being
acceptable the moment something does, and whoever wires the Analytics dashboard (Q11) should read
F-1 before trusting a number on it.
