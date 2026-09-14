# QA — T-040 · Event → UsageLine processor (worker-service)

**Gate 5.** Base `7dc7392`; subject is the uncommitted working tree. Tester: read-only apart from
this file. Every mutation below was applied, measured, reverted, and the whole tree proved
byte-identical afterwards (`md5sum -c` over 397 source files).

## Verdict: **PASS**

The shipped code has no tenant-isolation defect, no injection surface, no correctness defect, and
no regression across the other 12 packages. Every gate is green at 13/13 with `--force` and 0
cached. The three reworked items (HIGH-1, LOW-1, LOW-3) and all four unverified claims handed to
me reproduce, and two of them reproduce **more strongly** than claimed.

Six findings follow. All are documentation-level — a stale count, an overstated comment, a
declined residual, and two coverage observations. **None blocks the commit.** Two decisions are
put to the user at the end.

---

## 1 · Full gates — my own `--force` run

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | **13 successful, 13 total · 0 cached** |
| lint | `pnpm lint --force` | **13 successful, 13 total · 0 cached** — 14 warnings, 0 errors |
| build | `npx turbo run build --force` | **13 successful, 13 total · 0 cached** |
| test | `pnpm test --force` | **13 successful, 13 total · 0 cached** |
| smoke | `pnpm test:smoke` | 6 suites, 1 test each, all passed |

Per package: shared-tracing 2 · shared-validation 15 · shared-config 4 · shared-types 8 ·
shared-logger 4 · shared-utils 18 · analytics 18 · billing 18 · gateway 38 · usage 230 ·
auth 164 · **worker 129 (11 files)** · web `--passWithNoTests`.

**Worker matches the stated baseline exactly: 11 files / 129 tests.** (The review saw 126; the
rework added `U58`, `I21`, `I22`.)

**The 14 warnings are pre-existing, proved.** 10 × `no-misused-promises` in
`apps/auth-service/tests/auth.service.unit.test.ts`, `git log -1` → `d68e719`; 4 ×
`no-unsafe-assignment` in `apps/usage-service/tests/ingestion.service.unit.test.ts`, `git log -1`
→ `b0f6921`. Neither file appears in `git status --porcelain` for this change. **Zero
`no-unsafe-return`.** No new warning of any kind.

---

## 2 · The mutation set — re-performed independently

Each failed **by assertion or by a database error**, never by a runner timeout.

| Mutation | Result |
|---|---|
| **HIGH-1**: `this.where(...)` dropped from the `Event` `create`, `tenantId: payload.tenantId` written | typechecks **0 errors**; `U58` red, `I21` red |
| **New**: same edit on the **`UsageLine`** `create` | `U58` red, `I21` red — `42501 … for table "UsageLine"` |
| **New**: `const { tenantId } = this.where({})` → `payload.tenantId` (lookup key) | `U58` red **only**; all 10 integration cases green |
| `set_config` removed from `withTenant` | **8 of 10** integration cases red, `42501`; `I16`/`I18` green |
| `quantity` bound as `Number(...)` | `I20` red: `expected '12345678901.123460' to be '12345678901.123456'`; plus `U51` |
| `xack` moved above the `await` | `U43`, `U54`, `U56` red — **and `I18` red** on live Redis |
| `occurredAt` offset discarded | `U40` red, `I22` red (verbatim, below) |
| `WORKER_STREAM_READ.LOG.HANDLER_FAILED` text changed | `U29` red, `I18` **green** — the intended split |
| `metricKey` → `${eventType}.${unit}` (epic form) | `U40` red, `I13` red |
| `index.ts` 5th constructor argument deleted | `U46` red |
| `where: { idempotencyKey }` (the epic's snippet) | **TS2322**, does not compile |

### HIGH-1 — the platform's core invariant

The mutation compiles clean, exactly as the docstring says. `U58` fails on the spy:

```
AssertionError: expected 'd4101ff1-8a17-47f7-9765-73c73ccf0441'
                to be '456793cd-6625-44f6-af63-142a86019e1a'
```

`I21` fails at the database, as `telemetry_app`:

```
PrismaClientUnknownRequestError:
Invalid `tx.event.upsert()` invocation in
  apps/worker-service/src/repositories/event.repository.ts:127:36
Error occurred during query execution:
ConnectorError(... PostgresError { code: "42501",
  message: "new row violates row-level security policy for table \"Event\"", ... })
```

Both claims in the rework hold. `U58` is well-built: it asserts its own premise
(`expect(payload.tenantId).toBe(OTHER_TENANT_ID)`) so a silently-failing override cannot make it
pass, and it says in its own comment that `U49`'s version of the same negative cannot fail.

### Two isolation mutations neither review round performed

I went looking for the edit the reworked tests do *not* cover.

- **The symmetric `UsageLine` write** — `create: { tenantId: payload.tenantId, ... }` on the
  second upsert. Caught by `U58` **and** by `I21`, the latter with
  `42501 … for table "UsageLine"`. So both tenant-write paths are covered on both tables, at
  both the spy and the RLS level. No gap.
- **The tenant-*read* direction** — `const tenantId = payload.tenantId` feeding the compound
  unique. Caught by **`U58`'s whole-transaction JSON negative and nothing else**; all 10
  integration cases stay green. Harmless in production (the factory derives the repository from
  the same value, so the two agree, and when they disagree the contradictory predicate simply
  finds nothing and the write still lands under the bound tenant). Recorded because it means
  `U58`'s `expect(bound).not.toContain(OTHER_TENANT_ID)` is load-bearing for a second, distinct
  edit beyond the one it was written for — do not weaken it to the two `toBe` assertions above it.

---

## 3 · The four claims I was asked to check directly

**Claim 1 — the server is not UTC. CONFIRMED.**

```
$ psql -Atc "select name, setting, source from pg_settings where name='TimeZone'"
TimeZone|Asia/Kolkata|configuration file
```

PostgreSQL 16.13. So the T-040 integration suite has indeed been running against a non-UTC server
default all along. This is a stronger position than the change previously claimed, as stated.

**Claim 2 — `I22`'s pin guard is live. CONFIRMED, verbatim.** Mutating `URL_SUFFIX` to the bare
`?timezone=` form that `CLAUDE.md` records as silently ignored:

```
AssertionError: expected 'Asia/Kolkata' to be 'America/New_York'
```

The fallback lands on the server default, which is why `America/New_York` and not `Asia/Kolkata`
was the necessary choice. The reasoning in `integration.constants.ts:372-378` is correct.

**Claim 3 — the non-claim is accurate, but one comment overstates it.** I applied the
offset-discard mutation with the session pinned to **UTC** instead of `America/New_York`. `I22`
still fails, with the identical message:

```
AssertionError: 2026-01-01 00:00:00 | 2026-01-01 05:30:00 | 2025-12-31 19:00:00:
                expected 3 to be 1
```

So the pin is genuinely **not** what makes `I22` catch today's mutation — the failure comes from
the JavaScript side and reproduces under any session zone. The constants docstring
(`integration.constants.ts:379-386`) states this precisely and does not overstate. The comment at
the test site does — see **QA-2**.

**Claim 4 — the offset path. CONFIRMED.** `U40` runs `+05:30`, `-05:00` and `Z`, asserting both
`toISOString()` equality and `getTime()` equality against the `Z` payload, across
`occurredAt`, `periodStart` and `periodEnd`. `I22` reads `::text` off all three columns through
the owner connection and asserts *agreement between the three stored values* rather than against a
shared literal, so a uniform shift cannot pass. Under the discarded-offset mutation both go red
with the exact strings the plan quoted:

```
U40: expected '2026-01-01T05:30:00.000Z' to be '2026-01-01T00:00:00.000Z'
I22: 2026-01-01 00:00:00 | 2026-01-01 05:30:00 | 2025-12-31 19:00:00: expected 3 to be 1
```

Because D2 makes both period columns the event instant, a mishandled offset would write a wrong
`granularity=hour` bucket. That path is now pinned at both the parser and the column.

---

## 4 · Acceptance criteria AC1–AC12

Walked against plan §7 **and** `docs/epics/epic-7-worker-service.md`. Every AC is proven by at
least one test that I confirmed goes red when the behaviour breaks.

| AC | Proof | Verified by |
|---|---|---|
| AC1 parse / malformed throws | `U40`, `U41`, `U42` | `U42` iterates **each** of the 7 envelope fields individually, not one representative |
| AC2 `Event` idempotent on `(tenantId, idempotencyKey)` | `I13`, `I14` | live; `I14` uses a *fresh* repository per call, as production does |
| AC3 `UsageLine` idempotent on `eventId` | `I13`, `I14` | live |
| AC4 one transaction inside `withTenant` | `I16`, `U47` | `U47` asserts `$queryRaw` is **first**, not merely present |
| AC5 `XACK` only after commit | `U43`, `I17` | mutation red; `I17` observes `XPENDING`, not a spy |
| AC6 failure does not ack | `I18`, `U54` | `I18` red under the `xack`-early mutation on live Redis |
| AC7 `metricKey` = `eventType` (D1) | `U40`, `I13` | epic-form mutation reddens both |
| AC8 tenant isolation | `U48`, `U58`, `I15`, `I19`, `I21` | see §2; `I19` asserts `rolsuper=f`/`rolbypassrls=f` on the subject's own connection |
| AC9 `Decimal(18,6)` end-to-end | `I20`, `U49` | `Number(...)` mutation red to the exact digit |
| AC10 schema/migration aligned, forward-only | `migrate status` + drift diff | §5 |
| AC11 deadlines under the runner budget | `U50` | `1_500 + 3_000 < 5_000` ✓ |
| AC12 non-string `XAUTOCLAIM` cursor | `U39` | ids intact, see §7 |

**On the epic's `metricKey` line.** `docs/epics/epic-7-worker-service.md:143` does end
*"Adjust if Q1 decision specifies a different convention"* — I read it. **S-29 states this
fairly**, explicitly saying the plan's "the epic is wrong" framing "was stronger than the text
supports". That is the right call. Note only that the correction lives in `known-gaps.md` alone:
plan §2's D1 table and `stream-message.validator.ts:58-63` still carry the stronger framing
uncorrected.

---

## 5 · The migration

`prisma/migrations/v1_6_event_tenant_idempotency_key/migration.sql`.

- `prisma migrate status` → **`Database schema is up to date!`**, 7 migrations found, `v1_6`
  applied with `rolled_back_at` null.
- `migrate diff --from-schema-datamodel … --to-url` emits **one** statement, and it is about
  `User` defaults (S-30, pre-existing) — **nothing about `Event`**. So
  `@@unique([tenantId, idempotencyKey])` and the hand-written index name
  `Event_tenantId_idempotencyKey_key` agree exactly. AC10 holds.
- Live state: `Event_idempotencyKey_key` is **gone**;
  `CREATE UNIQUE INDEX "Event_tenantId_idempotencyKey_key" ON public."Event" USING btree ("tenantId", "idempotencyKey")` exists. `pg_constraint` on `"Event"` lists only `Event_pkey` and
  `Event_tenantId_fkey` — confirming F7's "index, not constraint".
- Forward-only, `DROP INDEX IF EXISTS` + `CREATE UNIQUE INDEX`, mirroring `v1_1`.
- `Event` and `UsageLine` were 0 rows before and after, so the no-backfill claim stands.

**The header's measured claims re-derived as `telemetry_app`** — on a *direct* login
(`current_user = telemetry_app`, `rolsuper = f`, `rolbypassrls = f`), each shape in its own
`BEGIN … ROLLBACK`.

Under the **current** compound index, tenant B replaying tenant A's key:

```
 B sees A's row -> 0          (RLS hides it)
 INSERT 0 1                   (succeeds)
```

Under the **replaced** global unique, simulated as owner then `SET LOCAL ROLE telemetry_app`:

```
read-then-write  ERROR:  duplicate key value violates unique constraint "Event_idempotencyKey_key"
DO NOTHING       INSERT 0 0  +  SELECT 'txn alive' -> txn alive     <- would COMMIT
DO UPDATE        ERROR:  new row violates row-level security policy (USING expression) for table "Event"
```

All three reproduce exactly as written, including the one that matters most — the `DO NOTHING`
transaction staying alive, i.e. a worker acknowledging a message it never stored.

**Breaking-change assessment.** `grep` across `apps/*/src`, `packages/*/src` and `prisma/*.ts`
finds **no query against the `Event` table anywhere outside worker-service** — the only `.event.`
Prisma calls are `event.repository.ts:117` and `:127`; every other `idempotencyKey` hit is
usage-service's Redis dedup path, a validator, or a shared type. The dropped global unique has no
other consumer. usage-service (230) and auth-service (164) are green.

---

## 6 · Findings

### QA-1 · LOW · a self-referential grep count is wrong, in an authoritative file

`.claude/rules/known-gaps.md` S-27 and `apps/worker-service/src/constants.ts:339-341` both state
that `grep -rn "RESERVED_STREAM_FIELDS" apps packages --include=*.ts` (excluding `dist/`)
"returns **four** lines", and enumerate them as the producer's declaration, the producer's use,
and two prose comments.

Measured: it returns **five**. The docblock that states the count *contains the grep command
itself*, so it matches its own text (`constants.ts:339` and `:329` are both hits).

The substance is unaffected — all five hits are a declaration, a use, and prose; **no test
references it**, which is the load-bearing half of S-27. Only the count and the enumeration are
wrong. Flagged because `known-gaps.md` is designated authoritative and other agents are
instructed to trust it without re-verification.

**Fix:** say "five lines … and this comment matches its own quoted command", or drop the count and
keep "no test references it".

### QA-2 · LOW · `event.processor.integration.test.ts:425-427` overstates what the pin buys

```
// Its **own** connection, with the session zone pinned rather than inherited. On CI the
// server is UTC, where a correct and a broken timestamp path are indistinguishable; on this
// host the server default is `Asia/Kolkata`. A case that took whichever it was given would
// assert nothing on one of the two.
```

Measured: with the pin set to **UTC** and the discarded-offset mutation applied, `I22` fails
identically (`expected 3 to be 1`, same three stored values). So "a case that took whichever it
was given would assert nothing on one of the two" is **false for this case as written** — under
UTC it asserts exactly what it asserts under `America/New_York`.

The sentence is a true general statement about the S-18 *raw-SQL bound-`Date`* path, placed where
it reads as a claim about the case beside it — which does not exercise that path, because D-ORM
forbids raw timestamps in this service. The careful version already exists 40 lines away in
`integration.constants.ts:379-386` ("the pin is **not** what makes the case catch today's
mutation"), which this very case imports. The two now disagree.

**Fix:** replace the test-site comment with a pointer to the constant's docstring, or restate it
as "the pin is here so this case already runs where a *future* raw-SQL cast would be caught".

### QA-3 · LOW · plan §6 S4's Gate-3 outcome records a stale ratio

The appended Gate-3 outcome says removing `set_config` reddens **"6 of 8"** integration cases.
Measured on the shipped tree: **8 of 10**, all with
`42501, new row violates row-level security policy`. `I16` and `I18` stay green.

The note was written before `I21` and `I22` were added at the rework and was not updated. Its
*reasoning* is exactly right and reproduces — `I16`/`I18` assert zero rows, and `42501` also
produces zero rows — so only the arithmetic is stale. Worth correcting because the same section
is the change's own record of which predictions held.

### QA-4 · LOW · declined residual: an unreachable fallback with a false comment

`apps/worker-service/src/repositories/event.repository.ts:172-174`

```ts
// Normalised here, and only here. `String(...)` over a `Prisma.Decimal` yields the
// column's exact stored value; the `usageLine` read is what proves the two rows agree.
quantity: String(usageLine.quantity ?? event.quantity),
```

This is the reviewer's LOW-2, dispositioned "undone by decision". Confirmed independently:
`information_schema.columns` reports `UsageLine.quantity` as `numeric(18,6)`, `is_nullable = NO`,
and it is in the `select` at `:167`, so the right arm of the `??` cannot be taken. Nothing
compares the two values — `??` is a fallback, not a comparison — so the second half of the
sentence describes something the code does not do, next to the money path.

Non-blocking and already ruled on. Recorded so the disposition is visible at Gate 6 rather than
inherited silently.

### QA-5 · Coverage / operability gap · a permanently-failing message never says why

`stream-message.validator.ts:196-198` discards the `ZodError` and throws a single generic
`WORKER_EVENT_PROCESSING.ERROR.INVALID_MESSAGE`. `dispatch`
(`stream.consumer.ts:764-772`) then logs the entry id and that message — correctly refusing to log
the fields, which carry `tenantId` and customer metadata.

Consequence, combined with the plan's own R6: a message that can never parse is reclaimed and
retried on every restart **indefinitely**, and no log line anywhere says *which field* was wrong.
An operator has the entry id and "Stream message is not a valid usage event".

Zod's `issues[].path` carries field **names** only, not values — `z.string().uuid()` yields
`Invalid uuid` with no echo of the input — so including the paths would be diagnostic without
weakening the redaction rule the file is careful about elsewhere.

Out of scope for T-040 (T-041 owns retry accounting and the dead-letter destination).
**Recommended for `.claude/rules/known-gaps.md`**, or for T-041's plan.

### QA-6 · Coverage gap · the quantity precision boundaries are untested

`QUANTITY_PATTERN` is `/^-?\d+(\.\d+)?$/` — unbounded scale and unbounded integer digits. Two
boundaries follow from the column being `Decimal(18,6)`, and neither has a test:

- **Scale overflow is silent.** A quantity with 7+ decimal places is rounded by PostgreSQL to the
  column scale (plan Appendix A/P-DEC: `1.0000005` → `1.000001`). No error, no test.
- **Precision overflow is a permanently-failing message.** Beyond precision 18 the insert raises
  `22003` (P-DEC), which throws, never acks, and joins the retry-forever set of QA-5.

Nothing reaches either today — usage-service's own validator constrains `quantity` to an integer
in `[1, 100]` (S-17) — and the constant's docstring is explicit and accurate that this boundary
"owns precision, not policy". Recording it as an untested arm rather than a defect.

### NIT · `event.repository.unit.test.ts:170`

`expect(result.quantity).not.toBeInstanceOf(Prisma.Decimal)` two lines after
`expect(typeof result.quantity).toBe("string")`. Still vacuous; accepted at review. No action.

---

## 7 · Regression risk

- **T-038 bootstrap and T-039 loop.** All **50** pre-existing test ids across
  `stream.consumer.unit.test.ts`, `stream.consumer.integration.test.ts` and
  `index.graceful-shutdown.unit.test.ts` are present and unrenamed (`I1`–`I12`, `U1`–`U38`), plus
  `U39`, `U46`, `U50`. The diff on those files removes no assertion — only the S1 hygiene items
  (`CALLS.NONE`-as-duration → a duration constant, `RUN_DEADLINE_MS` 3 000 → 1 500) and `U46`'s
  harness. `stream.consumer.integration.test.ts` alone: **12/12 on three consecutive runs**.
- **The other 12 packages.** Green, and nothing outside worker-service queries `Event` (§5).
- **`base.repository.ts` × 5 — untouched.** `md5sum` after all mutations:
  worker / analytics / billing all `13a533a2e2c2dcc1ff9db28fb5c7a1fd` (the exact hash S-19
  records), auth `8b12b7d5…`, usage `d2e8d92f…`. S-19 respected; worker becomes its first live
  subclass without editing the copy.
- **Injection.** The only raw SQL in `apps/worker-service/src` remains
  `base.repository.ts:98`'s `` tx.$queryRaw`SELECT set_config('app.tenant_id', ${this.tenantId}, true)` `` — a tagged template with a bound parameter, unmodified. T-040 adds none. No
  `Prisma.raw`, no interpolation.
- **`Decimal(18,6)`.** `quantity` is typed `string` from the parser through both `create` blocks;
  the single `String(...)` normalisation at `event.repository.ts:174` is the only layer, and
  `PersistedUsageEvent.quantity` is `string`. No `Number(`/`parseFloat` anywhere near it. No
  `Prisma.Decimal` can escape the repository.
- **S-25.** `src/events/**` and `src/config/container.ts` are coverage-excluded, so the
  `dispatch`→handler seam and the DI wiring are unmeasured by any percentage. `U46` stands in and
  **is** load-bearing: deleting the 5th constructor argument reddens it. Healthy coverage numbers
  were correctly not relied on here.

### `fileParallelism: false` (MEDIUM-3) — honest, not an evasion

The comment claims **no** failure rate and rests on the cause instead. I tested the cause.

- With the setting removed, 6 consecutive package runs: **3 failed**, every failure
  `NOGROUP No such key 'telemetry:events:t039:<pid>-<ts>-N'` — the T-039 per-run stream key, every
  time, exactly as the comment says.
- `stream.consumer.integration.test.ts` alone: **12/12 on three runs**.
- Cost: serial **4.86 / 5.16 / 4.95 s**, parallel green runs **1.85–1.96 s**. ~2.6×, matching the
  stated figures.

My 3-of-6 is a **fourth** distinct rate (against 1/3, 3/10, 5/5). That four observers got four
answers is the strongest possible argument for the comment's refusal to name one. Both claims it
*does* make reproduce. This is the right treatment.

---

## 8 · What I could not validate, and why

- **The concurrent-writer race on the compound index.** Not raced. The `P2002`-then-self-heal
  argument remains inference; the plan's `P-RACE` was measured on the *global* index. Same
  limitation the reviewer recorded, and it is bounded by T-041.
- **CI.** Local only. The CI job applies migrations as the owner before any test step; `v1_6`
  needs `DROP INDEX`/`CREATE UNIQUE INDEX`, which the migration role has here but which I did not
  exercise under CI's role configuration.
- **A genuinely UTC *server*.** I pinned *sessions* to UTC and to `America/New_York`, but this
  host's server default is `Asia/Kolkata` and I did not restart PostgreSQL to change it (the brief
  forbids stopping it). CI's `postgres:16-alpine` defaults to UTC; `I22` brings its own pin, which
  is what makes that difference immaterial.
- **Coverage percentages.** Not run. They would not cover the integration point anyway (S-25).
- **A live end-to-end run through the real `pnpm dev` worker.** Not performed: the repo-root
  `.env` points `DATABASE_URL` at the `postgres` superuser, so a locally-run worker would write
  these rows with RLS inert and prove nothing about isolation. The integration suite's
  `tests/setup.ts` pins `telemetry_app`, which is why the suite is the stronger evidence. (The
  `.env` observation is the reviewer's and is not a finding against this change — `.env` is
  gitignored local config.)
- **Long-run behaviour of the retry-forever path** (QA-5 / plan R6). Deliberately T-041's.

---

## 9 · Environment — before and after

Postgres and Redis were never stopped. Every write probe ran inside `BEGIN … ROLLBACK`; the
integration suite cleans up by explicit id in `afterEach` and `afterAll`.

| | Before | After |
|---|---|---|
| db 0 `XLEN telemetry:events` | 2 | **2** |
| db 0 `entries-added` | 2 | **2** |
| db 0 consumer groups | 0 | **0** |
| db 0 `DBSIZE` | 3 | 2 |
| db 14 `DBSIZE` | 0 | **0** |
| `Event` / `UsageLine` | 0 / 0 | **0 / 0** |
| `Tenant` / `User` | 2 / 2 | **2 / 2** |

`DBSIZE` on db 0 moved 3 → 4 → 2: the extra keys are `denylist:<jti>` written by auth-service's
suite during the root test gate, and they self-expire on their TTL (I watched one at `ttl=1`).
That is **S-22**, not this change, and no key of the platform's was touched. Every `FLUSHDB` the
worker suites issue is routed through `flushReservedDb()`, which re-asserts `CLIENT INFO`
contains `db=14` on **each** call — I read the helper and confirmed it is the per-call form, not
the `beforeAll` form S-22 warns against.

**Tree integrity:** `md5sum -c` over all 397 source files → clean after every mutation cycle.
`git status --porcelain` is identical to the state I started from. All five `base.repository.ts`
untouched.

---

## 10 · Decisions for the user

### Decision A — what happens to the three documentation corrections (QA-1, QA-2, QA-3)

All three are false-or-stale sentences; none changes behaviour. One of them (QA-1) is in
`known-gaps.md`, which other agents are told to trust without re-verification.

| | Option | Diff impact |
|---|---|---|
| **A1** | **Fix all three now, in this commit** — three comment/doc edits, no code | changes the diff: 3 files, comments only |
| A2 | Fix QA-1 only (the authoritative-file one); carry QA-2 and QA-3 to Gate 6 | changes the diff: 1 file |
| A3 | Carry all three as Gate-6 notes; commit as-is | no diff change |

**Recommendation: A1.** They are three sentences, the change has already been through two rounds
specifically about the accuracy of its own claims, and QA-1 sits in the file the next agent is
instructed to believe. A2 and A3 are preference — **none of the three changes behaviour or
requires re-running the gates**, since no test asserts any of these strings.

### Decision B — where QA-5 (an unparseable message never says which field) goes

A permanently-failing message retries forever with no field-level diagnostic. Redacting the values
is correct; the field *names* are safe to log.

| | Option | Diff impact |
|---|---|---|
| **B1** | **File as a new `known-gaps` entry (S-31) and leave the code alone** | changes the diff: one gap entry |
| B2 | Add it to T-041's scope when that plan is written; file nothing now | no diff change |
| B3 | Fix here — log `ZodError.issues[].path` (names only) from the parser | **changes production behaviour and the diff**; needs its own tests and a fresh review round |

**Recommendation: B1.** It is a real operability gap and the platform's convention is to record
rather than silently carry, but it is squarely T-041's territory and the plan's §3 already names
the retry-forever behaviour as a non-goal. **B3 changes the diff and would reopen Gate 4** — I
would not take it inside this task; B1 and B2 are a bookkeeping preference between them.

---

## Release-readiness call

**Ready.** The highest-risk elements — a migration, worker's first `TenantScopedRepository`
subclass, and the service's first tenant-scoped writes — are each backed by a test I confirmed
goes red when the behaviour breaks, and the tenant-write invariant is now guarded twice over, at
the spy level and by RLS `WITH CHECK` on both tables. The migration is aligned, forward-only, and
has no other consumer in the monorepo. The six findings are documentation and coverage
observations; none of them is a reason to hold the commit.

Recommend proceeding to Gate 6 with Decision A and Decision B answered.
