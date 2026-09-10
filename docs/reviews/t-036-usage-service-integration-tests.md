# Senior Reviewer — Gate 4 (pre-QA): T-036 Usage Service Integration Tests

Base `3588bf1`, nothing committed. Reviewed tree:

```
 M .claude/rules/known-gaps.md
 M docs/plans/t-036-usage-service-integration-tests.md
?? apps/usage-service/tests/usage.integration.test.ts        (1187 lines, 30 cases)
?? apps/usage-service/tests/integration.constants.ts         (217 lines)
?? apps/usage-service/tests/integration.fixtures.ts          (236 lines)
```

`git diff --stat apps packages prisma docker .github turbo.json` → empty. No production code changed,
as the plan promised.

**Verdict: CONDITIONAL.** Four MEDIUM findings, all of them claims the change *makes* being stronger
than what it *tests*. No test is vacuous, no assertion is wrong, no case short-circuits, the gate is
13/13 green on four tasks with `--force`, and the suite kills every one of the 14 production mutants I
applied that it should kill. The conditions are comment/scope corrections plus one robustness change;
none of them require rewriting a case.

---

## Findings

### MEDIUM-1 · The suite presents D1/D2 as tenant-isolation evidence but never asserts its own DB role, and falls back to the **owner** connection

`apps/usage-service/tests/usage.integration.test.ts:405`

```ts
baseDatabaseUrl = process.env.DATABASE_URL ?? INTEGRATION_ADMIN_DATABASE_URL_FALLBACK;
```

`INTEGRATION_ADMIN_DATABASE_URL_FALLBACK` is `postgresql://postgres:postgres@…`
(`integration.constants.ts:18`) — the owner, `rolsuper = t`, `rolbypassrls = t` (verified against
`pg_roles`). If `DATABASE_URL` is ever unset, every app this suite builds connects as a superuser, RLS
goes inert, and **D1/D2 still pass**, because the application-layer `WHERE "tenantId" = $1` predicate
carries them on its own. That is precisely the S-2/S-3 failure mode `.claude/rules/tenant-isolation.md`
warns about ("Treating a passing RLS test as proof while connected as a superuser").

It does not fire today — `tests/setup.ts:5-6` sets `DATABASE_URL` to `telemetry_app`, and I confirmed
the pinned URL preserves that role: `psql "…telemetry_app…?options=-c%20timezone%3DAsia%2FKolkata"` →
`telemetry_app | Asia/Kolkata`. But both sibling integration suites assert the role rather than assuming
it (`rls.enforcement.integration.test.ts:74-76,158-163`; `usage.timezone.integration.test.ts:43`
"A docstring is not a check"), and this one does not:
`grep -n "current_user\|rolsuper\|pg_roles" apps/usage-service/tests/usage.integration.test.ts` → no match.

**Fix (either, prefer both):**
1. `usage.integration.test.ts:405` — drop the owner fallback. Throw if `DATABASE_URL` is unset, or add
   an `INTEGRATION_APP_DATABASE_URL_FALLBACK` constant holding
   `postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry` and use that.
2. Add one case in the isolation `describe` mirroring `rls.enforcement.integration.test.ts:154-165`:
   read `rolsuper`/`rolbypassrls` for `current_user` through `getPinnedApp(PRIMARY_SESSION_TIME_ZONE).prisma`
   and assert both `false`.

Related, same area: `integration.constants.ts:21` labels the **Redis** URL constant
`/** Runtime (least-privilege) connection default, matching tests/setup.ts. */`. That docblock belongs
to a database URL that does not exist in this file; as written it reads as if a least-privilege DB
fallback were present.

---

### MEDIUM-2 · "an implementation that dropped the tenant predicate would return the other tenant's row" — measured false

`apps/usage-service/tests/usage.integration.test.ts:1128-1132` (and the same claim in the plan, §18 D note)

I removed the application-layer predicate — `buildFilters` rewritten to
`WHERE ${tenantId} IS NOT NULL AND "periodStart" >= …` (`usage.repository.ts:187`), so the bound
parameter is still consumed but no longer filters — and re-ran the suite:

```
M9-no-tenant-predicate:  Test Files 1 passed (1)   Tests 30 passed (30)
```

RLS catches it. D1/D2 prove the **composite** (`predicate ∨ RLS`), which is real and worth having, but
they cannot distinguish which layer is doing the work, and the comment asserts that they can. This is a
comment sitting on the platform's core security invariant, so a future editor who deletes the predicate
"because the test would catch it" gets no signal.

**Fix:** `usage.integration.test.ts:1128-1132` — restate as: *"both tenants' rows are in the table at
the moment of the request, so this proves the composite of the repository's bound predicate and the RLS
policy. It does not isolate which of the two is enforcing — measured: removing the `WHERE "tenantId"`
predicate leaves all 30 cases green, because `telemetry_app` is `NOBYPASSRLS`. The DB layer alone is
`rls.enforcement.integration.test.ts`."* Same correction to plan §18's "Note for the reviewer".

---

### MEDIUM-3 · C3 claims to prove "never a Decimal"; a leaked `Prisma.Decimal` passes all 30 cases

`apps/usage-service/tests/usage.integration.test.ts:344-347` and the case title at `:1073`

The helper docblock says:

> a `Prisma.Decimal` cannot survive `JSON.stringify` as an object … **What a leaked Decimal or number
> actually looks like on the wire is an unquoted value, which is what this rejects.**

The second half is false for `Decimal`. `decimal.js` defines `toJSON`, so:

```
node: JSON.stringify({ totalQuantity: new Prisma.Decimal("999999999999.999999") })
   -> {"totalQuantity":"999999999999.999999"}      // quoted string
```

Mutating `toQuantityString` at `usage.repository.ts:141` to pass the `Prisma.Decimal` straight through
(`value as unknown as string`):

```
M16-leak-decimal: usage.integration.test.ts       30 passed (30)
                  usage.timezone.integration.test.ts  1 failed  (:432, not.toBeInstanceOf)
```

So the invariant CLAUDE.md names — "never let a `Prisma.Decimal` reach a JSON response" — is asserted
only by the *repository-level* suite, which checks the value before serialization. T-036 catches a
leaked **number** (`Number(value)` → 14 failures via the raw-body regex, confirmed) but not a leaked
Decimal.

**Fix:** rename the case at `:1073` to something it can support (e.g. *"C3 returns every totalQuantity
as an exact decimal string, with no float rendering"*), and correct `:344-347` to say the raw-body regex
rejects an **unquoted** value — i.e. a `number` or `null` — while a `Prisma.Decimal` serializes as a
quoted string and is indistinguishable here; cite `usage.timezone.integration.test.ts:470-473` as the
assertion that covers it.

---

### MEDIUM-4 · "non-UTC, so a session-dependent bound shows up" is contradicted by the file's own measured table

`apps/usage-service/tests/usage.integration.test.ts:137`

```ts
/** The zone every case except B8 runs on: non-UTC, so a session-dependent bound shows up. */
```

Measured, all on the `Asia/Kolkata`-pinned app:

| mutation | usage.integration.test.ts |
|---|---|
| `utcTimestampBound` → bound JS `Date` (the pre-S-18 shape) | 30/30 **pass** |
| drop `withTenant`'s UTC `TimeZone` pin (`base.repository.ts:111`) | 30/30 **pass** |
| both together | 29/30 — only B8's `Asia/Kolkata` leg fails |

A session-dependent bound does *not* show up in the non-B8 cases under any of those three mutants. The
correct statement is already 770 lines further down, at `:904-916`, where the implementer records the
measured table honestly. Line 137 is the pre-measurement version that survived round 2.

**Fix:** `usage.integration.test.ts:137` — replace with *"The zone every case except B8 runs on.
Non-UTC by choice so the connection differs from CI's server default; note `withTenant` re-pins the
session to UTC transaction-locally, so this pin is only observable when that pin is absent — see the
measured table on B8."*

---

### LOW-1 · Stale `file:line` in a new comment

`apps/usage-service/tests/usage.integration.test.ts:342` cites `usage.repository.ts:72` for
`String(value)`. Line 72 is `  }` (the close of the `week` fragment); `toQuantityString` /`String(value)`
is at `usage.repository.ts:141`. S-18 moved it. **Fix:** `:72` → `:141`.

The other seven `file:line` references in the new files all check out: `src/app.ts:27`
(`registerUsageInternalAuthMiddleware`, first `onRequest` after the error handler),
`usage-events.route.test.ts:121`, `events.controller.unit.test.ts:151/249/283`,
`events.controller.ts:144` (`const skew = Math.abs(delta);`), `ingestion.service.ts:114-116`.

Plan §15.3/§17/§18 still carry the pre-S-18 anchors (`usage.repository.ts:72`, `:82`, `:111`, `:116`,
`base.repository.ts:92-110`, `set_config` at `:98`). Those sections are explicitly dated to `3374cf9`,
so they are historical rather than wrong — but §24 does not say so. One line in §24 noting that §13-23's
anchors predate S-18 would prevent the next agent re-deriving them.

### LOW-2 · `known-gaps.md` S-17 miscounts its own grep

`.claude/rules/known-gaps.md` (S-17, `generateIdempotencyKey` paragraph) says the grep
"returns seven lines: the declaration, two stale … declarations, and four call sites". Actual:

```
$ grep -rn "generateIdempotencyKey" apps packages --include=*.ts | wc -l
8
```

The omitted line is the import at `packages/shared-utils/tests/unit.test.ts:9`. The load-bearing claim
("no production caller anywhere") is **correct** — I verified all eight lines. But `.claude/rules/` is
designated authoritative and this is a verification artefact another agent will re-run. **Fix:** "seven"
→ "eight lines: the declaration, two stale `dist` declarations, one import and four call sites".

Everything else in S-16/S-17 verified line-by-line: `env.ts:19` (`INGEST_BATCH_MAX`),
`events.validator.ts:6,7-8,29,43`, `epic-6:51,62,67,73,74`, `shared-validation/src/index.ts:7,115,120,125`
(and `MAX_EVENT_SIZE_BYTES` genuinely has no `export`), `app.ts:19` = `Fastify({ logger: true })`,
fastify@5.10.0 `config-validator.js:6,31,1265` all showing `1048576`, `schema.prisma:71,89`,
`events.controller.ts:54-57,76-79`, `shared-utils/src/index.ts:13-21,120-128`,
`dist/src/index.d.ts:3` (the spurious fourth `source: string` parameter),
`grep -rn "UsageEventsBatchSchema\|MAX_EVENT_SIZE" apps/usage-service/src` → no match,
`grep -rn "bodyLimit\|10240\|10 \* 1024" apps/usage-service/src` → no match. The S-16 self-correction
("the overclaim 'unbounded' is itself a finding") is right and is the right way to write these.

### LOW-3 · DRY: `"request"` defined twice across the two new files

`apps/usage-service/tests/integration.fixtures.ts:16` `const SEED_EVENT_UNIT = "request";` duplicates
`INTEGRATION_FIXTURE.EVENT_UNIT: "request"` (`integration.constants.ts:79`).
`.claude/rules/constants.md` names this exact shape ("a definition duplicated between `constants.ts` …
and a repository is a finding"). **Fix:** import `INTEGRATION_FIXTURE.EVENT_UNIT` in the fixtures module
and delete `SEED_EVENT_UNIT`.

### LOW-4 · Two dead constants

`INTEGRATION_FIXTURE.SOURCE_ID` (`integration.constants.ts:80`) and
`INTEGRATION_QUANTITIES.EXPECTED_TWO` (`:147`) have no reference in either consuming file. A9 uses
`INGESTION_CONSTANTS.UNKNOWN_SOURCE_ID` instead, deliberately. **Fix:** delete both.

### LOW-5 · `afterAll` restores `DATABASE_URL` but not `REDIS_URL` / `REDIS_STREAM_NAME`

`usage.integration.test.ts:398-402` sets both Redis variables; `:437` restores only `DATABASE_URL`.
Harmless today — vitest 2.1.9's default pool is `forks` with `isolate: true`, and no config in this repo
overrides `pool` (`grep -rn "pool:" apps/*/vitest.config.mjs packages/*/vitest.config.*` → no match) — so
each file gets its own child process. It becomes a cross-file leak the day someone sets `pool: "threads"`.
**Fix:** restore all three in `afterAll`, or state in a comment why only one needs restoring.

### LOW-6 · Plan §11 checklist contradicts itself on how many `known-gaps.md` entries were authorised

`docs/plans/t-036-usage-service-integration-tests.md` §11 contains both
"S-16/S-17 re-verified …; **S-19 and S-20 filed**" and, two lines later,
"(only two `known-gaps.md` entries were authorised this round)". Four were added.

The provenance is fine — I found both S-19 and S-20 recommended verbatim by the S-18 reviewer
(`docs/reviews/s-018-usage-summary-range-timezone.md`, "Recommended for `.claude/rules/known-gaps.md`") —
but the plan is the audit trail for edits to authoritative config and it should not disagree with itself.
**Fix:** update the parenthetical to record the round-2 authorisation.

### LOW-7 · S-19 drops two items the S-18 reviewer asked to capture

The S-18 review's recommendation for this entry also named:

- auth-service's resolvers (`user.repository.ts:247,261`) run **outside** tenant context, so rolling the
  `TimeZone` pin to all five copies would still not cover them;
- `"app.tenant_id"` is defined in seven places, and `.claude/rules/constants.md` asks for promotion
  before the third copy.

Neither appears in S-19 or anywhere else in the diff. **Recommend:** add the first as a sentence in
S-19's "how bad it is today", and the second as its own LOW entry (or a line in S-19) so it does not
evaporate.

I verified S-19's own claims and they are exact: `md5sum` → analytics/billing/worker identical
(`13a533a2e2c2dcc1ff9db28fb5c7a1fd`), 111/118/124 line counts as stated, auth differs from the three
in comments only (comment-stripped `diff` is empty), `grep -c TIME_ZONE` → `1` usage / `0` the other
four, and `grep -rn "extends TenantScopedRepository" apps/*/src` finds exactly one real subclass at
`usage.repository.ts:150`. "Latent, not live" holds: the other four services' only `$queryRaw` is the
`set_config` call itself, and auth-service's three raw queries are the two resolvers plus `set_config` —
no timestamp predicate anywhere outside usage-service.

### NIT · `t036-` prefix is a literal in four places

`integration.fixtures.ts:109,115,125` and `usage.integration.test.ts:280`. One `T036_ID_PREFIX` constant
in `integration.constants.ts` would cover all four.

---

## Adjudication: `usage.timezone.integration.test.ts:429-431`

The comment under review:

> Buckets are midnight UTC and bucketEnd is bucketStart + one day, whatever the session zone. **This is
> the guard against "fixing" the column with `AT TIME ZONE` instead of the bound parameter**, which
> would shift every boundary by the server offset.

I established the following by execution rather than reading either party's account.

**1. The SQL semantics — the user's measurement is correct, both halves.** `psql`, inside
`BEGIN … ROLLBACK`, `pg_typeof(col AT TIME ZONE 'UTC')` → `timestamp with time zone`:

| session zone | `date_trunc('day', ts)` | `date_trunc('day', ts AT TIME ZONE 'UTC')` |
|---|---|---|
| `Asia/Kolkata` | `2026-01-01 00:00:00` | `2026-01-01 00:00:00+05:30` (= `2025-12-31T18:30Z`) |
| `UTC` | `2026-01-01 00:00:00` | `2026-01-01 00:00:00+00` |
| `America/New_York` | — | `2025-12-31 00:00:00-05` |

So on the **projection** side the column fix does shift bucket labels by the session offset —
`2025-12-31` under `America/New_York`, exactly as measured. On the **predicate** side,
`col AT TIME ZONE 'UTC' >= <timestamptz>` returns `true` under both `Asia/Kolkata` and `UTC` where the
naive comparison disagrees (`false` / `true`): it is a correct, zone-independent alternative with nothing
to guard against.

**2. What the test actually catches — the implementer's measurement is also correct.** Applying
`AT TIME ZONE 'UTC'` to `"periodStart"` in all six `GRANULARITY_SQL` fragments:

```
M1-attz-column:  Test Files 2 passed (2)   Tests 47 passed (47)
```

Both suites, fully green. The reason is that the guard the comment describes is disarmed by the *other*
half of S-18: `withTenant` issues `set_config('TimeZone','UTC', true)` (`base.repository.ts:111`) and
`summaryFor` goes through `UsageRepository`, so the session inside the transaction is UTC and the column
cast is a no-op.

**3. Which assertion is the guard, when there is one.** With the column cast *and* the pin removed:

```
M2: usage.timezone.integration.test.ts  17 tests | 2 failed
      × pins TimeZone to UTC inside withTenant …            (:409 — kills the pin removal, not the cast)
      × leaves bucket boundaries … across session time zones (:466)
          → "session time zone Asia/Kolkata: expected {…} to deeply equal {…}"
    usage.integration.test.ts               30 tests | 6 failed  (B1,B4,B5,B6,B7,B9)
```

The failure inside the annotated test is at **`:466`** — the cross-zone equality loop
`expect(other.summary).toEqual(reference.summary)` — not at the `expect(reference.summary.rows).toEqual([…])`
block the comment sits directly above. `reference` is the first entry of `Object.values(SESSION_TIME_ZONE)`,
which is `UTC`, and under UTC the column cast is invisible. So the bucket-*value* assertion the comment
annotates never guards against this, in either mutant.

**Ruling.** The comment is right about the SQL and wrong about the test. It is misattached (the guard, if
any, is the cross-zone loop three lines below, not the literal-value block above it) and unqualified (the
guard only exists when the `withTenant` pin is absent, and that pin shipped in the same commit — so on
the committed tree the column mistake is caught by **neither** suite). The implementer's mutation was not
mis-aimed; it produced the correct result. The user's semantics analysis is correct but describes a
session state that no longer occurs inside `withTenant`. Both parties are right about different things
and neither composed them.

Consequence worth recording: `usage.repository.ts:52-56`'s "Fix the bound, never the column" is carried
entirely by code review, not by any test — the same honest position the file already takes about
`utcTimestampBound` ("carried by review, not by the type system").

**Disposition: S-18 follow-up, not a T-036 blocker.** T-036's own B8 comment (`:904-916`) records the
measured table and does not repeat the overstatement, which is the right call. Suggested reword for
`usage.timezone.integration.test.ts:429-431`, moved onto the cross-zone loop at `:464`:

> Every session zone must produce the identical summary. This is what would catch a "fix" applied to the
> column (`DATE_TRUNC('day', "periodStart" AT TIME ZONE 'UTC')`) rather than to the bound — but only if
> `withTenant`'s UTC pin were also absent. Measured: with both S-18 guards present the column cast is a
> no-op and all 17 cases pass; with the pin removed as well, this assertion fails on `Asia/Kolkata`.

### A second S-18 observation, same class

`usage.timezone.integration.test.ts` is the named regression suite for S-18, and it does **not** fail on
the S-18 defect alone:

```
M5-date-bound  (utcTimestampBound -> a bound JS Date, i.e. the exact pre-S-18 shape):
    usage.integration.test.ts 30/30 pass, usage.timezone.integration.test.ts 17/17 pass
```

Only the conjunction with the pin removal is killed (M7 → 8 of 17 fail). S-18 shipped two independent
sufficient guards, so this is structural rather than a defect in the test — but the file's docstring
("Each case below pins its own zone on its own connection …, so it fails on the unfixed code on **any**
server") reads as a claim that it isolates the bound fix, and it does not. Out of scope here.
**Recommend `.claude/rules/known-gaps.md`** gets a short entry, or the S-18 docstring is corrected in the
same follow-up as the ruling above.

---

## Compile-time gate — run with `--force`, actual output

All four run at the reviewed tree, from repo root. `Cached: 0 cached, 13 total` on every one:

| Task | Result |
|---|---|
| `pnpm test --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` · 20.3 s |
| `pnpm lint --force` | `Tasks: 13 successful, 13 total` · `0 cached` · 0 errors, 14 warnings |
| `pnpm typecheck --force` | `Tasks: 13 successful, 13 total` · `0 cached` · 20.6 s |
| `pnpm build --force` | `Tasks: 13 successful, 13 total` · `0 cached` · 21.1 s |

Per package (13 = 7 apps + 6 shared packages; `packages/sdk` has no `package.json` and is not a
workspace member):

| Package | Files | Tests |
|---|---|---|
| `@telemetry/usage-service` | 19 | **229** |
| `@telemetry/auth-service` | 15 | 164 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/worker-service` | 4 | 19 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/billing-service` | 4 | 18 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-types` | 1 | 7 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/web` | 0 | `--passWithNoTests` |

Reproduces the implementer's report exactly: usage-service 19 files / 229 tests, auth-service 164/164,
no exclusions. The 30-case delta follows arithmetically (19 − 18 files, 229 − 199 tests) since nothing
else in the tree changed. Separately: `usage.timezone.integration.test.ts` 17/17 and
`rls.enforcement.integration.test.ts` 7/7, both untouched.

**Lint warnings — pre-existing, proven, not assumed.** 14 warnings, 0 errors, in exactly two files:

```
apps/usage-service/tests/ingestion.service.unit.test.ts   4  no-unsafe-assignment  (339,340,543,544)
apps/auth-service/tests/auth.service.unit.test.ts        10  no-misused-promises
```

```
$ git log -1 --format='%h %s' -- apps/usage-service/tests/ingestion.service.unit.test.ts
b0f6921 fix(security): close tenant-isolation gaps S-1 through S-4
$ git log -1 --format='%h %s' -- apps/auth-service/tests/auth.service.unit.test.ts
d68e719 test(services): expand coverage for singleton, container, and shutdown flows
$ git status --porcelain <both files>
(empty)
```

Neither file is in this change. **Zero new warnings introduced** — the three new files, which *are*
linted and typechecked (`apps/usage-service/tsconfig.json` includes `tests/**/*.ts`; the flat eslint
config covers `**/*.ts`), produce none.

---

## Test honesty — what I checked and how

Fourteen mutants applied to `apps/usage-service/src/**`, each reverted immediately; final `md5sum`
of all six touched source files matches the pre-experiment backups bit-for-bit, and
`git diff --stat apps packages prisma` is empty.

| # | Mutation | Killed by |
|---|---|---|
| M3 | `"periodStart" >=` → `>` | B8 **both** legs (+10 S-18 cases) |
| M4 | `"periodStart" <` → `<=` | B8 **both** legs |
| M5 | `utcTimestampBound` → bound JS `Date` | **nothing** (30/30, 17/17 pass) |
| M6 | drop `withTenant` UTC pin | **nothing** (30/30 pass) |
| M7 | M5 + M6 | B8 `Asia/Kolkata` leg only (1 of 30) |
| M1 | `AT TIME ZONE 'UTC'` on the column | **nothing** (47/47 pass) |
| M2 | M1 + M6 | B1,B4,B5,B6,B7,B9 (+2 S-18) |
| M8 | `DATE_TRUNC('day')` → `('hour')` | B1,B4,B5,B9,C1,C2 |
| M13 | `total` counts raw lines, not grouped rows | B1, B9 |
| M9 | remove the app-layer `tenantId` predicate | **nothing** (30/30) → MEDIUM-2 |
| M10 | `String(value)` → `Number(value)` | 14 cases, via `expectQuantitiesAreExactStrings` |
| M16 | leak the `Prisma.Decimal` unconverted | **nothing** in T-036 → MEDIUM-3 |
| M11 | drop the tenant segment from the dedup key (S-1) | A9, A10 |
| M15 | `isNew` always true | A2, A9 |
| M14 | publisher never `XADD`s | A1, A2, A9 |
| M17 | validator `.max(BATCH_SIZE_MAX - 1)` | A4 |
| M18 | `pageSize` clamped instead of rejected | B10 |

Every mutation the implementer's §24 table reports, I reproduced with the same outcome, including the
two counter-intuitive ones (M5, M6) — the table is honest, and it is honest *about the surprise*, which
is the part that matters.

**B8 and the zone pin — is the two-zone pinning real?** Yes, and the preflight is what makes it real.
I mutated the *test* helper `pinSessionTimeZone` to emit the bare `?timezone=<z>` query parameter
instead of `options=-c timezone=<z>`:

```
MT1-bare-timezone-param:  30 tests | 1 failed
    × B8 preflight: the app's connection reports session time zone UTC
```

Exactly one case fails, and it is a preflight — both B8 legs pass under the collapse, because with both
S-18 guards intact the session zone does not change the answer. So the preflight is not decoration: it
is the *only* thing standing between "two zones" and "one zone twice", and the file's claim that it takes
**both** preflight cases (roles swap on CI, whose server zone is UTC) is correct. Independently
corroborated: `psql "…?timezone=UTC"` → `invalid URI query parameter: "timezone"`, while
`?options=-c%20timezone%3DUTC` → `telemetry_app | UTC`.

I also verified the stronger claim at `usage.integration.test.ts:150-158`, that an unknown zone is a
connect-time `FATAL` rather than a silent fallback — and verified it **through Prisma**, not only through
`psql`, since the comment's own evidence is libpq-based and Prisma demonstrably differs on the bare form:

```
Prisma 6.19.3, datasourceUrl with options=-c timezone=…
  UTC          -> [{"u":"telemetry_app","tz":"UTC"}]
  Asia/Kolkata -> [{"u":"telemetry_app","tz":"Asia/Kolkata"}]
  Not/AZone    -> ERROR (Invalid `prisma.$queryRaw()` invocation)
psql:  ?options=-c%20timezone%3DNot%2FAZone  -> FATAL: invalid value for parameter "TimeZone": "Not/AZone"
       PGOPTIONS="-c timezone=Not/AZone"     -> same FATAL
```

The claim holds in the client that actually matters. Good.

**The zone-pinned app registry** (`buildZonePinnedApp` / `getPinnedApp` / `pinSessionTimeZone`,
`usage.integration.test.ts:160-216`) — sound, and the seam it works around is real:
`src/lib/prisma.ts:5-9` memoises one client on `globalThis` when `NODE_ENV !== "production"`, and
`src/config/container.ts:6,59` imports that binding directly rather than accepting a client. Judged on
the three risks you named:

- *Leaks state between cases?* No. Both apps are built in `beforeAll`, before any case runs; each closes
  over the module graph it was built with; `appsByTimeZone` is keyed by zone and cleared in `afterAll`;
  the statically-imported constants are frozen string/number objects compared by value, and no identity
  comparison crosses the boundary (I checked — there is no `toBe` against an imported object anywhere in
  the file).
- *Passes for the wrong reason?* Guarded by the preflight, as above. The one residual is MEDIUM-1: the
  registry inherits whatever `DATABASE_URL` is, including the owner fallback.
- *Resource hygiene?* `afterAll` closes both apps and disconnects both clients. `lazyConnect: true`
  (`container.ts:40`) is real, so the UTC app's Redis client never connects — verified in the container,
  and consistent with the ingest cases only ever using the primary app.

**Fixture seeding and route auth** — both correct.
- Everything in `integration.fixtures.ts` runs on `DIRECT_DATABASE_URL` (`:63-66`), i.e. the owner.
  I re-derived the reason rather than trusting the docstring: as `telemetry_app`, inside
  `BEGIN … ROLLBACK`, an unscoped `INSERT INTO "Tenant"` raises `new row violates row-level security
  policy` while `DELETE FROM "Tenant"` reports `DELETE 0`. `pg_roles` confirms `telemetry_app` is
  `rolsuper = f, rolbypassrls = f` and `postgres` is `t/t`.
- `assertRunStateEmpty` (`:166-175`) throws rather than passing vacuously, and it *can* detect its own
  reset failing: it counts after the delete and raises with a message naming the exact misconfiguration.
  It is vacuous only on the very first `beforeEach`, which is unavoidable and harmless.
- Every route case carries `X-Internal-Secret`. There are exactly two `.inject(` sites in the file
  (`:286`, `:309`), both routed through `tenantHeaders` → `internalHeaders`
  (`USAGE_SERVICE_HEADERS.INTERNAL_SECRET`). No case tests 401 by accident.

**Structural checks.** No `.skip`, no `.only`, no `.todo`, no `expect.fail`, no early `return` anywhere
in the three new files. Every locator helper throws when what it seeks is absent (`getPinnedApp:209`,
`getFixtures:233`, `getRedis:242`, `readSessionTimeZone:225`, `assertSchemaReady:82`). No mock is
asserted against its own return value — the suite has no mocks at all beyond `vi.resetModules()`.

**Parallel-suite interaction.** Low risk, and the disjointness claim holds. All three usage-service
integration suites derive per-run identifiers from `randomUUID()` and delete only by explicit id:
`usage.integration.test.ts:126-128`, `usage.timezone.integration.test.ts:217-218`,
`rls.enforcement.integration.test.ts:52,145-147`. auth-service's suites are scoped to `User`/`Tenant`
rows matched by a per-run e-mail domain and to ids they created. Redis: T-036 is alone on logical DB 15
(`redis-cli info keyspace` → `db0`, `db6` only) and uses a per-run stream name; it never `FLUSHALL`s.
Vitest gives each file its own child process under the default `forks` pool, so the env overrides in
`beforeAll` cannot cross files (see LOW-5 for the conditional). The narrowly-scoped reset can still
detect its own failure — that is what `assertRunStateEmpty` is — and scoping it narrowly is the right
trade, because a global "no foreign rows" check would flake against `rls.enforcement`'s legitimately
concurrent rows.

**Accommodations from round 1 — all gone.** `grep -rn "readEffectiveRangeBounds\|EffectiveRangeBounds"
apps packages --include=*.ts` → no match. The `RANGE_FROM`/`RANGE_TO` docblock
(`integration.constants.ts:102-123`) now states the margin as separation of concerns and explicitly
records that absorbing the S-18 shift is no longer its purpose. No scaffolding survives inertly. The one
line that *is* a survivor from the pre-measurement round is MEDIUM-4.

**Epic alignment.** All seven epic cases are covered at the epic's named path
(`apps/usage-service/tests/usage.integration.test.ts`), and the three deliberate epic-vs-code divergences
are asserted **against the code** with an inline comment naming the gap — A5/A6/A7 for S-5 (`:524`,
`:539`, `:552`), A8 for the symmetric window (`:565-569`), A3/A4 against the imported
`INGESTION_CONSTANTS.BATCH_SIZE_MAX` rather than the epic's `INGEST_BATCH_MAX` (S-6), and
`expectBadRequest` asserting the real `{code, message}` envelope rather than the epic's `{code, issues}`
/ `{code, max}`. No epic prose is silently encoded anywhere.

---

## What I could not verify, and why

- **The round-1 and round-2 red-first runs** (§24: "27 todo, 0 assertions" → "20 failed, 7 passed" →
  "10 failed, 17 passed"). Historical; the working tree is post-fix and nothing in it records those
  runs. My 14 mutants substitute for the *purpose* of the red-first record — they demonstrate the
  assertions can fail — but they are not the same evidence.
- **§24's round-1 claim** that "every one of the 26 production-facing cases has at least one killing
  mutant". I killed 17 distinct cases across 14 mutants and did not enumerate one per case. Cases I did
  not individually kill: A7 (malformed `occurredAt`), B2, B3, C3, D3, and the two B8 preflights — of
  which D3 and the preflights are harness assertions with no `src/` subject, exactly as §24 says of D3.
  Note also that the round-1 sentence is stale for round 2 (27 cases → 30) and is not restated there.
- **CI behaviour.** Everything here ran against the local PostgreSQL 16.13 (`Asia/Kolkata`) and local
  Redis. The claim that CI's `postgres:16-alpine` defaults to `UTC`, and therefore that the two B8 legs
  swap discriminating roles there, is reasoning from the S-18 review's measurement, not something I
  re-measured — I have no CI runner here.
- **`pnpm format:check`** — excluded per S-12, per the plan. Not run.
- **Long-run flake.** Three consecutive full-gate runs plus 15 scoped runs of the suite, all
  deterministic. That is not a soak test.

## Environment left as found

`Tenant=2`, `User=2`, `RefreshToken=0`, `Event=0`, `UsageLine=0` — the same two pre-existing
auth-service orphans (`owner-…@auth-integration-2b860f1d-….test` created `2026-09-09 07:42`,
`owner-…@auth-integration-a90cd587-….test` created `2026-09-09 08:02`), untouched. This independently
corroborates S-20's "observed, not inferred" paragraph: two runs, two distinct suite uuids, permanent by
construction. It also corroborates the *other* half — five full `pnpm test` runs today added nothing,
which is what S-20 predicts for a green complete run whose last case registers no user
(`auth.integration.test.ts:748`, verified to be the last `it(` in the file).

One nuance S-20 does not close and a reader may trip on: the mechanism it describes explains why residue
*persists*, not how the two orphans were *created*, since a green complete run leaks nothing. Worth one
sentence ("the two observed orphans came from partial/aborted runs; a green complete run leaks nothing
only because of case ordering"). I verified the "cleanup succeeds" half directly: `resetAuthState`
(`:123-134`) runs on `getAdmin()`, which is `DIRECT_DATABASE_URL` (`:180-181`), so the leak is structural
and not a silently-failing reset — and `auth.integration.test.ts:317-324` already asserts the reset works.
All six S-20 line references verified exact.

Redis: db15 empty. db0 holds `telemetry:events` and two `denylist:*` keys with TTLs — auth-service logout
artefacts, not T-036, which never touches db0.

---

## Conditions for `APPROVED FOR COMMIT`

1. MEDIUM-1 — remove the owner fallback at `usage.integration.test.ts:405`, and add the
   `rolsuper`/`rolbypassrls` assertion. Fix the mislabelled docblock at `integration.constants.ts:21`.
2. MEDIUM-2 — correct the tenant-predicate claim at `usage.integration.test.ts:1131` and in plan §18.
3. MEDIUM-3 — correct `usage.integration.test.ts:344-347` and the C3 case title at `:1073`.
4. MEDIUM-4 — correct `usage.integration.test.ts:137`.
5. LOW-1 — `usage.repository.ts:72` → `:141`.
6. LOW-2 — `known-gaps.md` S-17: "seven lines" → "eight lines".

LOW-3 through LOW-7 and the NIT are recommended, not blocking. Re-run `pnpm test --force` after the
edits (they touch test files) and confirm 229/229.

## Recommended for `.claude/rules/known-gaps.md` — out of scope to fix here

- **The S-18 regression suite does not isolate the S-18 bound fix.** Reverting `utcTimestampBound` to a
  bound JS `Date` leaves `usage.timezone.integration.test.ts` 17/17 green; only the conjunction with the
  `withTenant` pin removal fails. The file's docstring claims it "fails on the unfixed code on any
  server". Pair this with the `:429-431` reword.
- **`"app.tenant_id"` is defined in seven places** (two service constants modules, two test files, four
  hard-coded literals), which `.claude/rules/constants.md` asks to be promoted before the third copy.
  Recommended by the S-18 reviewer and not captured anywhere in this diff.
- **auth-service's resolvers run outside tenant context** (`user.repository.ts:247,261`), so the S-19
  fix direction ("roll the pin to all five") would not cover them. Belongs in S-19.

---

**Verdict: CONDITIONAL.**

---
---

# Round 2 — verification of the round-1 discharges

Scope: the rework only. Base `3588bf1`, nothing committed. I did not re-audit what round 1 passed
(the mutation table, fixtures-on-`DIRECT_DATABASE_URL`, `X-Internal-Secret` coverage, throwing
locators, three-suite disjointness) except where a round-3 edit moved it.

**All six blocking conditions are discharged, and each was re-established by execution rather
than by reading the implementer's account.** Two new items below, both LOW/NIT, one of them
pre-existing. No production code is touched.

---

## Findings

### LOW-8 (new) · The corrected Decimal docblock cites two assertions that the leak mutant never reaches

`apps/usage-service/tests/usage.integration.test.ts:402-403`

> The assertion that covers a leaked Decimal is the repository-level one, before
> serialization: `usage.repository.unit.test.ts:398` and
> `usage.timezone.integration.test.ts:473`, both `not.toBeInstanceOf(Prisma.Decimal)`.

The load-bearing half is **true and verified** — those two *files* do catch a leaked Decimal.
But the two cited *lines* are not what catches it. Re-applying the leak
(`toQuantityString` → `value as unknown as string`, `usage.repository.ts:141`) and running all
three suites in one pass:

```
❯ tests/usage.repository.unit.test.ts      (23 tests | 2 failed)   at :396:39 and :410:17
❯ tests/usage.timezone.integration.test.ts (17 tests | 1 failed)   at :432:36
  tests/usage.integration.test.ts          31 passed
  Test Files  2 failed | 1 passed (3)   Tests  3 failed | 68 passed (71)
```

In both files the `not.toBeInstanceOf` line sits *after* an earlier assertion in the same `it`
that fails first — `expect(typeof row?.totalQuantity).toBe("string")` at
`usage.repository.unit.test.ts:396`, and the whole-array `expect(reference.summary.rows).toEqual([…])`
at `usage.timezone.integration.test.ts:432`, whose `it` block (`:417-475`) also contains `:473`.
Neither `:398` nor `:473` is evaluated under the mutant; delete either line and the leak is still
caught.

**Fix (non-blocking):** `usage.integration.test.ts:402-403` — cite the tests rather than the
lines, or cite the lines that actually fire: *"…covered by
`usage.repository.unit.test.ts` ('normalizes Decimal totalQuantity into a plain string', which
fails at `:396`) and `usage.timezone.integration.test.ts:432`; the explicit
`not.toBeInstanceOf(Prisma.Decimal)` at `:398`/`:473` is a belt-and-braces line that the earlier
assertion in the same case pre-empts."*

Note this is **the same class as round 1's four MEDIUMs** — the change asserting something about
itself that execution does not fully support. See *Loop discipline* at the end.

### NIT (pre-existing root) · "five non-auth services" is four, and the authoritative file it cites is where the four became five

`apps/usage-service/tests/usage.integration.test.ts:1242` and
`apps/usage-service/tests/integration.constants.ts:45-46` both say `telemetry_app` is the role
"this platform's five non-auth services actually run as", citing
`.claude/rules/tenant-isolation.md`.

The citation is **faithful** — `.claude/rules/tenant-isolation.md:59` names them:
`gateway, usage, worker, billing, analytics at runtime`. The count in that table is what is
wrong. Measured:

```
$ grep -l DATABASE_URL apps/*/src/config/env.ts
apps/{auth,analytics,billing,usage,worker}-service/src/config/env.ts     (5)
$ ls apps/*/src/lib/prisma.ts
apps/{auth,analytics,billing,usage,worker}-service/src/lib/prisma.ts     (5)
$ grep -rn "DATABASE_URL\|prisma\|Prisma" apps/gateway/src --include=*.ts
(no output)
```

gateway holds no database connection at all, so the roster is **four** non-auth services
(`analytics`, `billing`, `usage`, `worker`) plus auth on `telemetry_auth_app`.
`.claude/rules/tenant-isolation.md` is designated authoritative and this is the kind of line an
agent reads instead of re-deriving — but it predates this change (`git log -1` → `3588bf1`,
`git status --porcelain .claude/rules/tenant-isolation.md` → empty), so it is **not counted
against T-036**. Out of scope here; see the recommendations at the end.

---

## Discharges — verified, one by one

### MEDIUM-1 · discharged, both non-vacuity legs reproduced verbatim

`usage.integration.test.ts:468` now reads `?? INTEGRATION_APP_DATABASE_URL_FALLBACK`, which is
`postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry`
(`integration.constants.ts:36`) — byte-identical to `apps/auth-service/tests/database-urls.ts`
`SHARED_APP`, to `tests/setup.ts:5-6` and to `.github/workflows/ci.yml:15` (all three read and
compared). `INTEGRATION_ADMIN_DATABASE_URL_FALLBACK` now appears only at its declaration
(`:23`), in the sibling docblock (`:21`), and in `integration.fixtures.ts:4,65` — the suite file
no longer references it. The misplaced docblock is moved: `:27` now heads the app DB URL, and
`:52` reads `/** Redis connection default, matching tests/setup.ts:9. */`.

**Leg 1 — owner role.** `DATABASE_URL=postgresql://postgres:postgres@… vitest run tests/usage.integration.test.ts`:

```
× Tenant isolation … > D0 connects the app under test as telemetry_app: NOSUPERUSER, NOBYPASSRLS
AssertionError: role postgres is a superuser; RLS cannot enforce: expected true to be false
 Test Files  1 failed (1)      Tests  1 failed | 30 passed (31)
```

**The reported consequence is confirmed:** exactly one case notices. D1 and D2 are inside the
30 that pass with RLS switched off — which is precisely why round 1 called the missing assertion
a MEDIUM, and precisely what D0 now closes.

**Leg 2 — a different least-privilege role.**
`DATABASE_URL=postgresql://telemetry_auth_app:… vitest run … -t "D0"`:

```
AssertionError: expected 'telemetry_auth_app' to be 'telemetry_app'
 Test Files  1 failed (1)      Tests  1 failed | 30 skipped (31)
```

Both legs are needed and the implementer's stated reason holds: `pg_roles` shows
`telemetry_auth_app | f | f`, so the owner run cannot exercise the name assertion (`rolsuper`
fails first) and only a second restricted role can. `readConnectedRole`
(`usage.integration.test.ts:260-272`) throws on a missing row, so the case cannot pass vacuously,
and it reads through `getPinnedApp(...).prisma` — the app's own client, not a second connection.

Sibling-suite line refs cited by D0, all verified exact:
`rls.enforcement.integration.test.ts:156-165`, `usage.timezone.integration.test.ts:324-330`,
`apps/auth-service/tests/rls.integration.test.ts:132-139` (the `beforeAll` name check, the
S-3-replacement shape), `tests/setup.ts:5-6`, `.github/workflows/ci.yml:15`.

### MEDIUM-2 · discharged, and I re-measured the number in the comment

`usage.integration.test.ts:1207-1218` now states the composite explicitly, names
`usage.repository.unit.test.ts:202-207` for the predicate alone and
`rls.enforcement.integration.test.ts` for RLS alone, and closes with *"Do not delete the
predicate on the grounds that this case would catch it — it would not."* Both citations check
out: `:205` and `:207` are the two `toContain('"tenantId" = $1')` assertions.

Re-measured rather than accepted — `buildFilters` (`usage.repository.ts:187`) rewritten to
`WHERE ${tenantId} IS NOT NULL AND "periodStart" >= …`:

```
 Test Files  1 passed (1)      Tests  31 passed (31)
```

Matches the comment's "leaves all 31 cases here green" exactly. Plan §18 carries the same
correction (`docs/plans/…:1110-1117`).

### MEDIUM-3 · discharged; see LOW-8 for the one residue

C3's title at `usage.integration.test.ts:1151` is now *"C3 returns every totalQuantity as an
exact decimal string, with no float rendering"* — the "never a Decimal" half is gone. The
docblock at `:380-404` says the regex rejects an **unquoted** value and that a `Prisma.Decimal`
is indistinguishable here. Re-measured at Prisma 6.19.3, all four forms the comment claims:

```
bare    "999999999999.999999"
field   {"totalQuantity":"999999999999.999999"}
nested  {"data":{"items":[{"totalQuantity":"999999999999.999999"}]}}
toJSON  function
UNQUOTED_QUANTITY vs nested Decimal -> false     (not rejected)
UNQUOTED_QUANTITY vs number 1.5     -> true      (rejected)
```

Suite level, leak applied: `usage.integration.test.ts` **31 passed**,
`usage.repository.unit.test.ts` 2 failed, `usage.timezone.integration.test.ts` 1 failed —
the plan's §25 table verbatim.

### MEDIUM-4 · discharged; all three mutants re-run here at 31 cases, not carried over

`usage.integration.test.ts:145-155` now says non-UTC *by choice*, records that `withTenant`
re-pins to UTC transaction-locally (`base.repository.ts:111` — verified, that is the
`TIME_ZONE`/`TIME_ZONE_UTC` `set_config`), and points at B8's table. My own runs:

| mutant | result |
|---|---|
| `utcTimestampBound` → `Prisma.sql`${new Date(isoInstant)}`` | `Tests 31 passed (31)` |
| delete the `TimeZone` pin at `base.repository.ts:111` | `Tests 31 passed (31)` |
| both together | `Tests 1 failed \| 30 passed (31)` — `× B8 … under session time zone Asia/Kolkata` |

Identical to the three rows the comment states. The measurement was genuinely redone at 31, not
re-labelled from round 2's 30.

### LOWs and the NIT · all discharged

| # | Verification |
|---|---|
| LOW-1 | `usage.integration.test.ts:383` cites `usage.repository.ts:141` — `toQuantityString`/`String(value)` is at exactly `:141`. §24 gains the dating paragraph; its four "current positions" are exact: `this.where({})` `:180`, range predicate `:187`, tenant `set_config` `base.repository.ts:110`, UTC pin `:111`. |
| LOW-2 | S-17 now reads "eight lines … the declaration, two stale `dist` declarations, one import and four call sites". `grep -rn "generateIdempotencyKey" apps packages --include=*.ts` → 8, and the breakdown matches line for line. |
| LOW-3 | `SEED_EVENT_UNIT` gone; `integration.fixtures.ts:121` uses `INTEGRATION_FIXTURE.EVENT_UNIT`. |
| LOW-4 | `INTEGRATION_FIXTURE.SOURCE_ID` and `INTEGRATION_QUANTITIES.EXPECTED_TWO` gone. I re-ran the dead-constant sweep over every export and every nested key in `integration.constants.ts`: the only "unreferenced" hit is `INTEGRATION_SESSION_TIME_ZONE.UTC`, consumed via `Object.values(...)` at `:477`, so not dead. |
| LOW-5 | `afterAll:509-524` restores all three, `delete`-ing `REDIS_URL`/`REDIS_STREAM_NAME` when previously unset, with the `pool: "forks"` reasoning inline. (`DATABASE_URL` is restored by assignment rather than `delete`; correct, since `tests/setup.ts:5` guarantees it is set and the local is typed `string`. Not a finding.) |
| LOW-6 | §11 now reads "**Four** entries in total across the two rounds: S-16 and S-17 authorised in round 1, S-19 and S-20 in round 2". Self-consistent. |
| LOW-7 | S-19 gains both items. Refs exact: `user.repository.ts:246-251` and `:258-266` are the two resolver bodies, both plain `this.db.$queryRaw` outside any transaction; the file's only `set_config` is `:235`, inside `withTenantContext` (`grep -n "set_config" apps/auth-service/src/repositories/user.repository.ts` → `:208` comment, `:235` code). |
| NIT | `INTEGRATION_ID_PREFIX = "t036-"` at `integration.constants.ts:109`, used at `integration.fixtures.ts:110,116,128` and `usage.integration.test.ts:324`. `grep -rn "t036" apps/usage-service/tests` finds no surviving literal. |

---

## Adjudication 1 — the `"app.tenant_id"` count: the implementer is right, round 1 was wrong

**Six, confirmed independently.** `grep -rn "app\.tenant_id" apps/*/src --include=*.ts` returns 24
lines; stripping comments and docblock prose leaves exactly six executable occurrences:

| # | Location | Form |
|---|---|---|
| 1 | `apps/usage-service/src/constants.ts:74` | named constant (`DATABASE_SESSION_SETTINGS.TENANT_ID`) |
| 2 | `apps/auth-service/src/constants.ts:69` | named constant (`AUTH_DATABASE.TENANT_CONTEXT_SETTING`) |
| 3 | `apps/analytics-service/src/repositories/base.repository.ts:98` | literal in `set_config` |
| 4 | `apps/billing-service/src/repositories/base.repository.ts:98` | literal in `set_config` |
| 5 | `apps/worker-service/src/repositories/base.repository.ts:98` | literal in `set_config` |
| 6 | `apps/auth-service/src/repositories/base.repository.ts:105` | literal in `set_config` |

usage-service's own `base.repository.ts:110` uses the constant, which is why it is not a seventh.
The reason a naive search under-reports is confirmed too: `grep -rn '"app.tenant_id"' apps packages
--include=*.ts | grep -v /dist/` → **2**, because the four literals are single-quoted inside a
template string.

I also tested S-19's accompanying **universal**, since that is the kind of claim that is usually
where the error is: *"No test passes the bare literal to `set_config`/`current_setting`."*
`grep -rn "set_config\|current_setting" apps/*/tests --include=*.ts` returns 22 lines; every one
that reaches the database passes `AUTH_DATABASE.TENANT_CONTEXT_SETTING` or
`DATABASE_SESSION_SETTINGS.TENANT_ID`/`.TIME_ZONE`, and the nine bare-literal occurrences are four
comments, four `it(...)` titles and the one assertion message at
`apps/auth-service/tests/user.repository.unit.test.ts:116` — exactly the breakdown S-19 states.

**Round 1's "seven places" is withdrawn.** S-19 as written is correct; nothing further to do.

## Adjudication 2 — the two off-by-one `file:line` refs: confirmed, round 1 was wrong

- `rls.enforcement.integration.test.ts` — the role case is `it("connects at runtime as a
  NOSUPERUSER, NOBYPASSRLS role", …)` spanning **156-165**. Line 154 is the `});` closing the
  preceding `afterAll`. Round 1's `154-165` was two lines early.
- `usage.timezone.integration.test.ts` — the role case spans **324-330**. Round 1 cited `:43`,
  which is the docstring sentence "A docstring is not a check", not the case.

The rework's D0 comment (`usage.integration.test.ts:1227-1228`) uses the corrected `156-165` and
`324-330`. Both verified by reading the surrounding lines.

## Adjudication 3 — the two S-18 follow-ups in plan §25

**Both are correctly scoped as S-18 follow-ups, not T-036 blockers.** They concern
`apps/usage-service/tests/usage.timezone.integration.test.ts`, which is committed at `3588bf1`,
is untouched by this change (`git status --porcelain` → not listed) and 17/17 green.

On item 2 I did not take the plan's word. Re-applying the pre-S-18 bound shape alone:

```
$ # utcTimestampBound -> Prisma.sql`${new Date(isoInstant)}`
$ vitest run tests/usage.timezone.integration.test.ts
 Test Files  1 passed (1)      Tests  17 passed (17)
```

On this `Asia/Kolkata` host, the named S-18 regression suite does **not** fail on the S-18 defect
alone, while its own docstring (`:31-32`) says each case "fails on the unfixed code on **any**
server". That is a false universal in a regression suite's self-description, and it is exactly
the class of claim another agent will trust. **It deserves a `known-gaps.md` id** — see below.

Item 1 (the misattached `:429-431` comment) is the smaller, same-file instance and should be
folded into the same entry rather than given its own id. I re-derived its structure: `:429-431`
sits directly above the literal-value `toEqual` at `:432`, and the cross-zone equality loop that
round 1 identified as the real guard is at `:466` — both inside the single `it` at `:417-475`.

---

## Compile-time gate — re-run with `--force`, actual output

Repo root, at the reviewed tree. `Cached: 0 cached, 13 total` on all four:

| Task | Result |
|---|---|
| `pnpm test --force` | `Tasks: 13 successful, 13 total` · `0 cached` · 13.9 s · exit 0 |
| `pnpm lint --force` | `Tasks: 13 successful, 13 total` · `0 cached` · 0 errors, 14 warnings · exit 0 |
| `pnpm typecheck --force` | `Tasks: 13 successful, 13 total` · `0 cached` · exit 0 |
| `pnpm build --force` | `Tasks: 13 successful, 13 total` · `0 cached` · exit 0 |

| Package | Files | Tests |
|---|---|---|
| `@telemetry/usage-service` | 19 | **230** |
| `@telemetry/auth-service` | 15 | 164 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/worker-service` | 4 | 19 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/billing-service` | 4 | 18 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-types` | 1 | 7 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/web` | 0 | `--passWithNoTests` |

**The 230 accounting is confirmed, not accepted.** File count is unchanged at 19; round 1
measured 229; a scoped `vitest run tests/usage.integration.test.ts` reports `Tests 31 passed (31)`
against round 1's 30. 229 + 1 = 230, and the one added case is D0 — the only `it(` added in the
round-3 diff. `usage.timezone.integration.test.ts` 17/17 and `rls.enforcement.integration.test.ts`
7/7, both untouched.

**Lint warnings — 14, pre-existing, proven.** Same two files as round 1, neither in this change:

```
apps/usage-service/tests/ingestion.service.unit.test.ts   4  no-unsafe-assignment  (339,340,543,544)
apps/auth-service/tests/auth.service.unit.test.ts        10  no-misused-promises

$ git log -1 --format='%h %s' -- apps/usage-service/tests/ingestion.service.unit.test.ts
b0f6921 fix(security): close tenant-isolation gaps S-1 through S-4
$ git log -1 --format='%h %s' -- apps/auth-service/tests/auth.service.unit.test.ts
d68e719 test(services): expand coverage for singleton, container, and shutdown flows
$ git status --porcelain <both files>
(empty)
```

Zero new warnings. The three new files are linted and typechecked and produce none.

**No production code.** `git diff --stat apps/usage-service/src packages prisma` → empty, both
before and after my mutation experiments. Working tree is
`.claude/rules/known-gaps.md`, `docs/plans/t-036-…md` (modified) plus the three new test files and
this review (untracked) — nothing else. After the six mutants I applied and reverted,
`md5sum -c` against byte-level backups of `usage.repository.ts` and `base.repository.ts` → `OK`,
and `git diff --stat apps packages prisma docker .github turbo.json` → empty.

---

## What I could not verify, and why

- **CI behaviour.** Everything ran against local PostgreSQL 16.13 (server session
  `Asia/Kolkata`) and local Redis. The claim that CI's `postgres:16-alpine` is `UTC`, and hence
  that the two B8 legs swap discriminating roles there, is still reasoning, not measurement — I
  have no runner. Unchanged from round 1.
- **The red-first record** (§24's three historical runs). Historical; substituted for, not
  reproduced, by mutation.
- **The implementer's round-3 statement that `INTEGRATION_ADMIN_DATABASE_URL_FALLBACK` is
  "referenced only by `integration.fixtures.ts`"** — verified by grep across `apps/` and
  `packages/`, but a grep cannot prove nothing outside the workspace imports it. Immaterial.
- **`pnpm format:check`** — excluded per S-12, per the plan. Not run.
- **Long-run flake.** Two full `--force` gate runs plus nine scoped runs of the suite (six of
  them under mutants), all deterministic. Not a soak test.

## Environment left as found

Before and after, through the owner connection:

```
Tenant=2  User=2  RefreshToken=0  Event=0  UsageLine=0
d4101ff1-8a17-47f7-9765-73c73ccf0441   2026-09-09 07:42:19
456793cd-6625-44f6-af63-142a86019e1a   2026-09-09 08:02:51
```

The same two pre-existing auth-service orphans S-20 describes, untouched. Redis logical DB 15 is
empty (`redis-cli -n 15 dbsize` → 0); db0/db6 hold unrelated keys this suite never addresses.
My two failing-by-design D0 runs left no residue — the suite's `afterAll` reset ran in both.

## Loop discipline

LOW-8 **is** the same class as round 1's four MEDIUMs: the change making a claim about itself
that execution does not fully support. That pattern has now recurred across S-7, S-18, round 1
and round 2 of this task, and the honest read is that it is a property of how this codebase's
prose is written, not of any one implementer.

It does not warrant a third round. The difference in kind matters: round 1's items were
*substantive* — a security precondition asserted nowhere, three comments whose central assertion
was measurably false. LOW-8 is a *line-number attribution inside a statement whose substance is
correct*, and the correction is one sentence in a comment. Everything the reviewer asked to be
proven in round 3 was proven, and re-proven here independently.

**Recommendation to the user rather than another gate cycle:** take LOW-8 as a one-line comment
edit at commit time (or waive it), and treat the recurrence itself as the signal — a standing
instruction that a `file:line` cited as "the assertion that covers X" must be the line that
actually fails when X is broken, not merely a line that mentions X, would close this class
permanently. That is a `.claude/rules/` change, not a T-036 change.

## Recommended for `.claude/rules/known-gaps.md` — out of scope to fix here

1. **The S-18 regression suite does not isolate the S-18 bound fix, and says it does.**
   `apps/usage-service/tests/usage.timezone.integration.test.ts:31-32` claims each case "fails on
   the unfixed code on **any** server". Measured here: reverting `utcTimestampBound` alone leaves
   it 17/17 green; only the conjunction with the `withTenant` pin removal fails. Fold in the
   misattached `:429-431` comment (the real guard, when one exists, is the cross-zone loop at
   `:466`, and on the committed tree the column mistake is caught by neither suite). Needs its own
   id — the authorisation for this task was spent on S-16/S-17/S-19/S-20 and this is a committed
   file.
2. **`.claude/rules/tenant-isolation.md:59` lists `gateway` as a `DATABASE_URL` consumer.**
   gateway has no database connection (`grep -rn "DATABASE_URL\|prisma\|Prisma" apps/gateway/src`
   → no output; no `apps/gateway/src/lib/prisma.ts`; no `DATABASE_URL` in its env schema). The
   roster is four non-auth services, not five. A false roster in a designated-authoritative file
   is HIGH by the standing rule; it is pre-existing (`git log -1` → `3588bf1`, tree clean), so it
   is not charged to T-036, but it should not evaporate — and two new T-036 comments now repeat
   the count downstream of it.

---

**Round 2 verdict: APPROVED FOR COMMIT.**

The four MEDIUM conditions, all seven LOWs and the NIT are discharged, and each discharge was
re-established by running the experiment rather than by reading the record. The two disagreements
are adjudicated in the implementer's favour on the `"app.tenant_id"` count (six, confirmed) and on
both `file:line` corrections. Gate is 13/13 × 4 tasks, 0 cached, 230/230 in usage-service with the
+1 accounted to D0, 14 lint warnings all proven pre-existing, and
`git diff --stat apps/usage-service/src packages prisma` empty. LOW-8 and the NIT are
non-blocking; the two `known-gaps.md` recommendations are for a separate task.
