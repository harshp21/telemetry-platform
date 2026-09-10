# T-038 — Senior Reviewer, Gate 6 (final, post-QA)

**Verdict: CONDITIONAL** — five prose corrections required before commit (§2, LOW-1/2/3). No
production-code change is required. None of the required edits re-opens a gate: all five are in
files already in the diff, and none is read by `lint`, `typecheck`, `build` or `test`.

**Base:** `45679c6`, nothing committed. Tracked diffstat at start and at end of this review:
`5 files changed, 341 insertions(+), 15 deletions(-)`. All ten task files `md5sum -c` OK after
every mutation.

---

## 1. Findings

Ranked. Nothing at BLOCKER or HIGH. The production code is correct, all four gates are green on
this revision with `--force`, and the three tests added by the Gate-5 loop-back are non-vacuous —
each proved red by a mutation I ran myself, output below.

---

### LOW-1 · Two `file:line` citations added by this batch point at the wrong line

Both were written or edited in the Gate-5 loop-back, and both are the kind of citation the next
person follows rather than re-derives.

**(a) `docs/plans/t-038-consumer-group-bootstrap.md:413`** — the F1 correction says the
`"$"` → `"0"` mutation "reddens it at `:271`".

Measured on this revision. `sed -i '132s/"\$"/"0"/' apps/worker-service/src/constants.ts`, then
`pnpm --filter @telemetry/worker-service exec vitest run tests/stream.consumer.integration.test.ts`:

```
 ❯ tests/stream.consumer.integration.test.ts:279:27
AssertionError: expected [ Array(2) ] to not include '1789033940252-0'
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

`:279`, not `:271`. The loop-back hoisted `reservedDbUrl` to module level and added its docblock
(`tests/stream.consumer.integration.test.ts:52-57`, plus the assignment at `:184`), which pushed
I5 down. QA's figure was correct when QA measured it; the same commit that made it stale is the
one that restated it.

**Fix:** `docs/plans/t-038-consumer-group-bootstrap.md:413` — `` `:271` `` → `` `:279` ``.

**(b) `apps/worker-service/tests/stream.consumer.unit.test.ts:191`** — "`\"$\"` itself is guarded
only by `I5` (`tests/stream.consumer.integration.test.ts:275`), which pins the literal".

`:275` is `const delivered = await readNewEntryIds(streamName, groupName, INTEGRATION_COUNTS.PAIR);`.
The line that pins the literal is `:283`:
`expect(WORKER_CONSUMER_GROUP_BOOTSTRAP.START_ID_NEW_ENTRIES_ONLY).toBe("$");`.

**Fix:** `apps/worker-service/tests/stream.consumer.unit.test.ts:191` — `:275` → `:283`.

---

### LOW-2 · A measurement transcript in `.claude/rules/known-gaps.md` no longer reproduces — the suite grew from 5 tests to 6

`.claude/rules/known-gaps.md:515` (S-22), and the same figure at
`apps/worker-service/tests/stream.consumer.integration.test.ts:158` and
`docs/plans/t-038-consumer-group-bootstrap.md:669`, record the db=14 guard mutation as
`Test Files 1 failed (1) / Tests 5 skipped (5)`.

I re-ran it. `redis-cli -n 14 SET t038-sentinel 1`, then
`sed -i '176s/INTEGRATION_REDIS.LOGICAL_DB_INDEX/9999/'` on the integration suite:

```
 Test Files  1 failed (1)
      Tests  6 skipped (6)
db14 DBSIZE after: 1
```

`I6` took the suite from 5 cases to 6 in the same loop-back that left the numeral at 5.

**The load-bearing part of S-22 is fine and I re-derived it**, which is why this is LOW rather
than HIGH: the sentinel key **survived** (`DBSIZE` 1 → 1) under the every-flush guard, so the
corrected claim — that `flushReservedDb()` re-asserts the index on each call and that a single
`beforeAll` guard would not have — holds exactly as written. `grep -n "flushdb"` on the file
returns one executable occurrence, `:178`, inside that helper; the chokepoint claim at `:163-165`
is accurate and correctly scoped ("a future bare `redis.flushdb()` … would not be").

Held to the HIGH bar because `.claude/rules/` is designated authoritative and other agents are
told to trust it. Graded LOW because what is stale is a transcript numeral, not a mechanism, and
an agent who re-runs the mutation gets a *stronger* result than recorded, not a weaker one.

**Fix:** three sites — `.claude/rules/known-gaps.md:515`,
`apps/worker-service/tests/stream.consumer.integration.test.ts:158`,
`docs/plans/t-038-consumer-group-bootstrap.md:669` — either update `5 skipped (5)` to
`6 skipped (6)` or, better, write it as "every case in the file skipped (5 at the time of
measurement, 6 since `I6`)" so the next case added does not make it stale again.

---

### LOW-3 · The F1 correction in the plan quotes a unit-suite total that is now wrong

`docs/plans/t-038-consumer-group-bootstrap.md:409` — "Measured at Gate 5 (QA finding F1) by
editing `src/constants.ts:132` from `"$"` to `"0"` — `Test Files 1 passed (1) / Tests 6 passed
(6)`."

The unit suite is **8** tests since the same loop-back added U9 and U10. Re-measured under that
exact mutation:

```
 ✓ tests/stream.consumer.unit.test.ts (8 tests) 18ms
 Test Files  1 failed | 6 passed (7)
      Tests  1 failed | 64 passed (65)
```

**The conclusion the note draws is correct and I confirmed it package-wide**, which the brief
asked for specifically: the sole red case under the `"$"` → `"0"` mutation, across all seven
worker-service test files, is **`I5`**. Nothing in the unit suite moves, and the U9/U10 `startId`
assertion does not move either — because it compares against
`WORKER_CONSUMER_GROUP_BOOTSTRAP.START_ID_NEW_ENTRIES_ONLY`, so both sides shift together, exactly
as the note and the suite comment say. **The true red set is not wider than the correction
claims.**

**Fix:** `docs/plans/t-038-consumer-group-bootstrap.md:409` — `Tests 6 passed (6)` →
`Tests 8 passed (8)` (unit suite), and optionally add the package-wide figure
`Tests 1 failed | 64 passed (65)`, sole red `I5`.

---

### LOW-4 · The error path's log fields are unguarded — the F2 shape, left half-closed

`apps/worker-service/src/events/stream.consumer.ts:114-122`. The loop-back closed F2 for the two
`logger.info` paths. The `logger.error` path was never in F2's scope (QA's F2 heading is "The
success-path info log is entirely unguarded"), so **no claim in the diff is false here** — this
is a new finding, not a broken correction.

Mutation M-F, run by me. `sed -i '114s/String(error)/"unknown"/'`:

```
 Test Files  7 passed (7)
      Tests  65 passed (65)
```

`error instanceof Error ? error.message : String(error)` is implemented logic whose output nothing
asserts. `U3` (`tests/stream.consumer.unit.test.ts:148`) and `U4` (`:156`) assert only
`expect(mockLogger.error).toHaveBeenCalled()` — call-existence, field- and message-agnostic — and
`U4` exists precisely to exercise the non-`Error` branch that `String(error)` serves.

Mitigating, and why I am not making this a required fix: the operator does not depend on this log
line. On the fail-closed path the rejection also reaches `src/index.ts:81-83`
(`console.error(error); process.exit(1)`), which QA observed end to end, so the diagnostic is
never lost. This is regression protection for a log field, not a missing signal.

**Fix, if taken:** in `U4`, replace `expect(mockLogger.error).toHaveBeenCalled()` with
`expect(mockLogger.error).toHaveBeenCalledWith({ streamName: …, groupName: …, error: NON_ERROR_REJECTION }, LOG_MESSAGE.FAILED)`
— which needs a third `LOG_MESSAGE` member for `"Failed to ensure stream consumer group"`. See
decision **D-1**.

---

### NIT-1 · An "only" in `src/` that is true of `src/` and false of the package

`apps/worker-service/src/constants.ts:79` — "These four feed no env field at all and are
referenced only by `src/events/stream.consumer.ts`".

`grep -rn "WORKER_CONSUMER_GROUP_BOOTSTRAP" src tests --include=*.ts | cut -d: -f1 | sort | uniq -c`:

```
      1 src/constants.ts                             (the declaration)
      6 src/events/stream.consumer.ts
      2 tests/stream.consumer.integration.test.ts
      8 tests/stream.consumer.unit.test.ts
```

True as stated for `src/`; false read literally. `.claude/rules/review-standards.md`
§ *Universals Must Cite Their Mutation* asks for the weaker true form.

**Fix:** "…and their only `src/` consumer is `src/events/stream.consumer.ts`".

---

### NIT-2 · The AC table was not extended for the three new tests

`docs/plans/t-038-consumer-group-bootstrap.md:443-453` still maps AC1-AC9 to U1-U7 and I1-I5.
`U9`, `U10` and `I6` appear only in the Gate-5 checklist. That matters most for `I6`: swallowing
`BUSYGROUP` rather than locking is this task's central design decision, and after the loop-back it
finally has a guard — but the acceptance table still has no row for it, so a future reader
reconciling ACs against tests will not find it.

**Fix:** add `AC10 · Concurrent bootstrap from N independent connections all succeed and leave
exactly one group → I6`, and extend AC1/AC2's "Proving test(s)" cells with U9/U10.

---

### Judgement call you asked me to rule on — the `LOG_MESSAGE` test fixture

`apps/worker-service/tests/stream.consumer.unit.test.ts:65-79` names the two log messages in a
test-local `LOG_MESSAGE` object rather than promoting them to `src/constants.ts`, with a comment
saying not to promote them inside a test-only change.

**Ruling: acceptable as shipped. Not a finding, and I recommend against filing a follow-up.**
Measured rather than judged by taste:

- `grep -rn 'logger\.\(info\|error\|warn\|debug\)(' apps/*/src --include=*.ts` — **every** log
  message in all seven apps is an inline string literal at the call site. There is no
  log-message constants module anywhere in the repository.
- `grep -rn "LOG_MESSAGE\|LOG_MESSAGES" apps packages --include=*.ts` (excluding `dist`,
  `node_modules`) returns **only** this new test file.
- `.claude/rules/constants.md`'s "must live in a constants module" list names *error codes and
  error messages*. A pino log message is neither an error code nor an API error body; the error
  codes and messages this service does return live in `WORKER_RESPONSES` /
  `INTERNAL_AUTH_RESPONSES` already.

Promoting them would be the first instance of a new platform-wide pattern, introduced inside a
test-only change, against CLAUDE.md #5 ("mirror the neighbouring service's naming … rather than
introducing new patterns"). The fixture also earns its keep: because it duplicates the literal
rather than importing the implementation's own constant, the assertion is falsifiable — mutation
M-E (rewording the message in `src/`) reddens U9, which an imported constant could not do.

If the platform ever wants log-message constants, that is a repo-wide task with its own review,
not a T-038 follow-up. No `known-gaps.md` entry.

---

## 2. Required fixes (the CONDITIONAL)

Prose only. No code, no tests, no gate re-run.

| # | File:line | Change |
|---|---|---|
| 1 | `docs/plans/t-038-consumer-group-bootstrap.md:413` | `` `:271` `` → `` `:279` `` |
| 2 | `apps/worker-service/tests/stream.consumer.unit.test.ts:191` | `…integration.test.ts:275` → `…integration.test.ts:283` |
| 3 | `.claude/rules/known-gaps.md:515` | `Tests 5 skipped (5)` → `Tests 6 skipped (6)`, or the version-proof phrasing in LOW-2 |
| 4 | `apps/worker-service/tests/stream.consumer.integration.test.ts:158` | same figure, same change |
| 5 | `docs/plans/t-038-consumer-group-bootstrap.md:669` | `-> \`Tests 5 skipped\`` → `6 skipped` |

NIT-1 (`src/constants.ts:79`) and NIT-2 (the AC table) are recommended, not required.

---

## 3. What I verified, by execution

### 3.1 Compile-time gate — `--force`, 0 cached, all 13 packages

The workspace has exactly 13 members (`pnpm ls -r --depth -1`): 6 apps with tests + `web` +
6 shared packages. `packages/sdk` is an empty directory with no `package.json` and is not a
workspace member — that is where CLAUDE.md's "7 shared packages" and turbo's 13 reconcile.

| Command | Result |
|---|---|
| `pnpm typecheck --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` · 9.259s |
| `pnpm lint --force` | `Tasks: 13 successful, 13 total` · `0 cached` · 24.654s · **14 warnings, 0 errors** |
| `npx turbo run build --force` | `Tasks: 13 successful, 13 total` · `0 cached` · 16.569s |
| `pnpm test --force` | `Tasks: 13 successful, 13 total` · `0 cached` |
| `pnpm test:smoke` | 6 services, 7 tests, all pass |

Per-package test totals from the `--force` run:

| Package | Files | Tests |
|---|---|---|
| `@telemetry/analytics-service` | 4 | 18 passed |
| `@telemetry/auth-service` | 15 | 164 passed |
| `@telemetry/billing-service` | 4 | 18 passed |
| `@telemetry/gateway` | 8 | 38 passed |
| `@telemetry/usage-service` | 19 | 230 passed |
| `@telemetry/worker-service` | **7** | **65 passed** |
| `@telemetry/web` | — | `--passWithNoTests` |
| `@telemetry/shared-config` | 1 | 4 passed |
| `@telemetry/shared-logger` | 1 | 4 passed |
| `@telemetry/shared-tracing` | 1 | 2 passed |
| `@telemetry/shared-types` | 1 | 8 passed |
| `@telemetry/shared-utils` | 1 | 18 passed |
| `@telemetry/shared-validation` | 1 | 15 passed |

Worker matches the stated baseline: 7 files / 65 tests.

`pnpm test:smoke`: gateway 2, auth 1, usage 1, billing 1, analytics 1, worker 1 — all pass. The
worker smoke test builds the Fastify app directly and never enters `src/index.ts`, so the
fail-closed startup change does not reach it; that is why D2-C was rejected and it holds.

### 3.2 Lint warnings — all 14 pre-existing, proven

| Count | File | Rule | `git log -1` |
|---|---|---|---|
| 10 | `apps/auth-service/tests/auth.service.unit.test.ts` | `@typescript-eslint/no-misused-promises` (`:61`, `:86`, `:117`, `:144`, `:179`, `:204`, `:231`, `:262`, `:297`, `:323`) | `d68e719` 2026-08-25 |
| 4 | `apps/usage-service/tests/ingestion.service.unit.test.ts` | `@typescript-eslint/no-unsafe-assignment` (`:339`, `:340`, `:543`, `:544`) | `b0f6921` 2026-08-31 |

Neither file appears in `git diff --name-only` or `git status --porcelain`. **Zero new warnings**;
the five files the change modifies and the four it adds all lint clean.

### 3.3 `pnpm format:check` — S-12, and F4's mechanism and arithmetic both confirmed

```
$ pnpm format:check | grep -c '^\[warn\]'
273
$ pnpm format:check | grep '^\[warn\]' | tail -1
[warn] Code style issues found in 272 files. Run Prettier with --write to fix.
$ pnpm format:check | grep '^\[warn\]' | grep -v 'Code style issues found' | wc -l
272
```

**F4's mechanism is exactly right**: prettier's trailing summary is itself a `[warn]` line, so
`grep -c '^\[warn\]'` is always one higher than the file count, and prettier's own summary
independently agrees at 272.

Arithmetic, checked file by file against the warn list:

- 7 new prettier-visible task files: `stream.consumer.ts`, `integration.constants.ts`,
  `stream.consumer.integration.test.ts`, `stream.consumer.unit.test.ts`, and the plan + two
  review `.md`s.
- `apps/worker-service/.env.example` is **not** in the warn list (prettier does not parse it), so
  it contributes 0 — which is why the count is 7 and not 8 for the task files.
- The four modified prettier-visible files contribute 0: each was **already unformatted at HEAD**,
  proved individually with `git show HEAD:<file> | npx prettier --check --stdin-filepath <file>` —
  `known-gaps.md`, `src/constants.ts`, `src/index.ts`, `tests/index.graceful-shutdown.unit.test.ts`
  all fail at HEAD.
- `docs/qa/t-038-consumer-group-bootstrap.md` adds the eighth.

264 + 7 + 1 = **272 files / 273 warn lines**, which is what the plan's re-measured line says. My
own review file will make it 273 files. Not a regression; S-12.

### 3.4 The three new tests are non-vacuous — six mutations, verbatim output

Every mutation reverted immediately and `md5sum -c` re-run against a pre-mutation manifest.

**M-A — delete the entire success-path `logger.info` block** (`stream.consumer.ts:89-96`), i.e.
QA's M8, the mutation that used to leave 21/21 green:

```
   × StreamConsumer.ensureConsumerGroup > U9 - logs the created message with the stream, group and start id
     → expected "spy" to be called 1 times, but got 0 times
 ❯ tests/stream.consumer.unit.test.ts:205:29
      Tests  1 failed | 64 passed (65)
```

**M-B — drop *only* the `startId` field, keeping the call** (`:93`). This is the one that decides
whether the field assertion is independently live or merely carried by the call-count line at
`:205`:

```
   × U9 …
     → expected "spy" to be called with arguments: [ { …(3) }, …(1) ]
    Object {
-     "startId": "$",
    },
 ❯ tests/stream.consumer.unit.test.ts:206:29
      Tests  1 failed | 7 passed (8)
```

Red on `:206`, the `toHaveBeenCalledWith` line, with `:205` still passing. **The field assertion
is exercised in its own right.** The implementer's claim is exact.

**M-C — make the already-exists branch log the created message** (`:108`):

```
   × U10 - logs the already-exists message with the stream and group, and no start id
     → expected "spy" to be called with arguments: [ { …(2) }, …(1) ]
 ❯ tests/stream.consumer.unit.test.ts:230:29
      Tests  1 failed | 7 passed (8)
```

`U10` red, `U2` green — F2's point reproduced directly, as claimed.

**M-E — reword the created message** (`"Created stream consumer group"` → `"Consumer group
created"`): `U9` red at `:206`, `Tests 1 failed | 7 passed (8)`. Confirms the "message reworded"
half of the scope statement.

**M-D — delete the already-exists `return` path** (`stream.consumer.ts:102-112`), run across the
**whole package**, which is the corrected red set I was asked to check:

```
   × U2  → promise rejected "Error: BUSYGROUP Consumer Group name alre…" instead of resolving
   × U10 → BUSYGROUP Consumer Group name already exists
   × I2  → promise rejected "ReplyError: BUSYGROUP …" instead of resolving
   × I3  → BUSYGROUP Consumer Group name already exists
   × I6  → expected [ …(7) ] to deeply equal []
 Test Files  2 failed | 5 passed (7)
      Tests  5 failed | 60 passed (65)
```

**Exactly `U2`, `U10`, `I2`, `I3`, `I6` and exactly `5 failed | 60 passed (65)`.** The
implementer's self-correction (from the integration file's set `I2`/`I3` to the package's set) is
verified. And the rejection reasons are 7 × `ReplyError: BUSYGROUP Consumer Group name already
exists` — counted with `grep -c`, matching the plan's Appendix A P16 and QA's probe: 1 winner,
7 losing racers.

**M-F — the residual (LOW-4):** `String(error)` → `"unknown"` at `:114` leaves
`Test Files 7 passed (7) / Tests 65 passed (65)`.

### 3.5 The two scope claims — both honest, and neither too weak

**(a) `U9`'s `startId` catches a code change but not a constant-value change.** Confirmed in both
directions. Code change (M-B: field dropped) → `U9` red. Constant-value change (`"$"` → `"0"` at
`src/constants.ts:132`) → unit suite `8 passed (8)`, package `1 failed | 64 passed (65)`, sole red
`I5`. The claim is exactly as strong as the evidence, in both directions, and **`I5` really is the
only guard on the start position across all seven worker test files** — the brief's central
question, answered package-wide rather than per-file.

**(b) `I6` guards the losing racer's outcome, not the interleaving.** I tested the refuting case
rather than accepting the reasoning. I rewrote `I6`'s `Promise.allSettled(clients.map(…))` into a
**fully serialized** `for` loop, one `ensureConsumerGroup()` awaited at a time:

- on the committed implementation: `✓ … Tests 1 passed | 5 skipped (6)` — green, so `I6` genuinely
  does **not** detect concurrency;
- with M-D applied on top: `× I6 → expected [ …(7) ] to deeply equal []` — red, so it reddens
  under the same mutation either way.

Both halves of the implementer's stated scope reproduce. The comment at
`tests/stream.consumer.integration.test.ts:293-301` is precisely calibrated: not overclaimed, and
not so weak that it undersells what `I6` does prove. Both edits reverted; `md5sum -c` OK.

### 3.6 Other claims the diff makes, re-derived

- **`.claude/rules/known-gaps.md` S-23 table** — executed, not read. Against
  `apps/usage-service/dist/src/config/env.js`: `REDIS_STREAM_NAME.safeParse("")` → `OK ""`;
  `safeParse(undefined)` → `OK "telemetry:events"`. Worker's `.min(1)` on both fields read from
  `src/config/env.ts:41-42` and exercised by the green
  `tests/env.schema.unit.test.ts:268-281`. `"REDIS_CONSUMER_GROUP" in usage.EnvSchema.shape` →
  **false**, so the LOW-3 correction ("usage-service declares no consumer-group field at all") is
  right, and `WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_GROUP` is `"worker-group"`
  (`src/constants.ts:61`), so the antecedent fix is right too. The `constants.ts:41-44` citation
  for the "never reaches" docblock lands on exactly those four lines.
- **`src/constants.ts` LOW-2 rework** — `grep -c 'WORKER_STREAM_CONSTANTS\.' src/config/env.ts` →
  **7**, and `grep -o … | sort | uniq -c` shows one hit per member with the object having exactly
  7 members. Five are `.default(...)`, two are the `.min()`/`.max()` bounds at `env.ts:52-53`. The
  corrected distinction holds.
- **`.env.example` and `src/constants.ts` D1 justification** — re-run against the live database
  with `PGPASSWORD` from `.env`: `select count(*) from "Tenant" where id='1111…'` → **0**;
  `select count(*) from "Tenant"` → **2**;
  `Event_tenantId_fkey | FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT`.
  The FK exists and the parent row does not, which is the reason the operator-facing note gives.
- **`src/index.ts:27-29`** — "`stream.consumer.ts` pulls in `./constants`, which pulls in
  `@telemetry/shared-types`": `src/constants.ts:1-5` imports `EVENT_STREAM_CONSTANTS`,
  `INTERNAL_AUTH_HEADERS`, `INTERNAL_AUTH_RESPONSES` from `@telemetry/shared-types`. Correct, and
  the dynamic import is the right call given the `initTracing` ordering rule.
- **`src/index.ts:74`** cited in `stream.consumer.ts:38` — line 74 is indeed
  `new StreamConsumer(container.redis, container.logger, container.env)`. QA's F7 citations
  (`:41-43`, `:50`, `:56`, `:75`) all land correctly too.
- **The unit suite's "ten casts" count** (`tests/stream.consumer.unit.test.ts:26-33`) —
  `grep -o` on `apps/usage-service/tests/stream.publisher.unit.test.ts`: 13 total
  `ReturnType<typeof vi.fn>`, 10 × `(mockRedis.xadd as …)`, 1 × `(mockLogger.info as …)` at
  `:149`, 2 annotations at `:8-9`. Exact.
- **The graceful-shutdown harness docblock's determinism claim** (`:36-50`) — the strongest
  universal in the earlier batch ("no larger number fixes it"). I restored the old
  microtask-drain helper at **20 turns**: `Test Files 1 failed (1) / Tests 9 failed | 1 passed
  (10)`. Reproduces exactly. Reverted.

### 3.7 Redis hygiene

| | Before this review | After |
|---|---|---|
| `db0 DBSIZE` | 1 | 3 |
| `XLEN telemetry:events` | **2** | **2** |
| entry ids | `1787746970722-0`, `1788171536033-0` | **identical** |
| `XINFO GROUPS telemetry:events` | `(empty array)` | **`(empty array)`** |
| `db12/13/14/15 DBSIZE` | 0 / 0 / 0 / 0 | **0 / 0 / 0 / 0** |

**The real stream is untouched** — same length, same two ids, still zero consumer groups. The db-0
`DBSIZE` delta is two TTL'd `denylist:<jti>` keys written by auth-service's logout tests during my
`pnpm test --force` run (`TTL` 858 s and 834 s at the time of reading). That is **S-22 / QA F5**
reproducing, pre-existing, not T-038's. My own sentinel key in db 14 was deleted; db 14 ends at 0.

Neither Postgres nor Redis was stopped or restarted at any point.

### 3.8 Tree integrity

`md5sum -c` against a ten-file manifest taken before the first mutation: all **OK** after every
mutation and again at the end. `git diff --stat` returns
`5 files changed, 341 insertions(+), 15 deletions(-)`. `git status --porcelain` unchanged from the
start of the review.

---

## 4. Final-Review-only items

### 4.1 Test coverage alignment

- **No orphaned code.** `grep -rn "StreamConsumer" apps/worker-service/src` finds exactly one
  production construction site, `src/index.ts:74`. Nothing is exported and unused; there is no
  container registration to leave dangling. The class is not a `TenantScopedRepository` subclass
  and issues no SQL, so S-19 is untouched as the plan promised.
- **No untested implemented logic, with one exception** — the `String(error)` coercion at `:114`
  (LOW-4). Everything else is mutation-proved: the `xgroup` argument vector (U1, and M-D/M-B on
  the others), the already-exists swallow (M-D → 5 cases), the `startsWith`-over-`includes` choice
  (U5, which asserts its own premise at `:164-169` so it cannot pass vacuously), the non-`Error`
  branch (U4), fail-closed startup (U8), and bootstrap-before-listen ordering (U7, via
  `invocationCallOrder`).
- **Error paths tested:** rethrow on `WRONGTYPE` (U3), rethrow on a non-`Error` rejection (U4),
  rethrow on a `NOGROUP` message that *contains* `BUSYGROUP` (U5), and process exit 1 with the
  listener never bound (U8). The one untested error-path detail is the log's field content.
- **Helpers throw rather than pass vacuously:** `xgroupArgs()`
  (`tests/stream.consumer.unit.test.ts:93-101`) and `readOnlyGroup()`
  (`tests/stream.consumer.integration.test.ts:115-125`) both throw when the thing they look for is
  absent, and `readOnlyGroup` additionally asserts exactly one group — which is what stops `I6`'s
  `expect(rejections).toEqual([])` from being satisfiable by eight no-ops.
- **No short-circuiting.** No `return`, `skip`, `it.skipIf` or conditional early exit in any of the
  three new tests. `I6`'s `finally` closes clients but does not swallow assertion failures.
- **No mock-echo assertions.** `U9`/`U10` assert what the subject passed to the logger, not what a
  stub returned. `I6` asserts Redis' own state through a second read.

### 4.2 Release readiness

- **ACs.** AC1-AC9 (`docs/plans/…:443-453`) are 100% satisfied. QA proved each by mutation; I
  re-proved AC1/AC2/AC3 (M-D), AC7 (`"$"` → `"0"`, sole red `I5`), and AC4's non-`Error` half
  (M-F's neighbourhood). The concurrency guarantee now has a guard (`I6`) but no AC row — NIT-2.
- **No regressions in the other 12 packages.** All 12 unchanged packages pass under `--force`
  with 0 cached, at the same totals. `grep -rn "@telemetry/worker-service" apps packages
  --include=package.json` returns only worker-service's own `name` field: **no package depends on
  worker-service**, so there is no API surface to break.
- **Breaking change, and it is real but contained.** worker-service can no longer start without a
  reachable Redis (D3-A, fail-closed). Scope, checked rather than assumed: nothing in
  `.github/workflows/ci.yml` starts the worker *process* (`grep -rn "worker" ci.yml` → no match);
  `pnpm test:smoke` and `test:smoke:compose` both build the Fastify app directly and pass;
  `docker/docker-compose.yml:152-156` already declares
  `depends_on: redis: { condition: service_healthy }` for `worker-service`, so the compose path is
  ordered correctly. The affected case is a developer running `pnpm --filter …worker-service dev`
  with no Redis. It is documented in `.env.example` and in plan R3. **It must appear in the commit
  message**, as R3 requires.
- **Rollback lever:** revert the commit, or `redis-cli XGROUP DESTROY telemetry:events
  worker-group` to undo a bootstrap, which `.env.example` now states where an operator will read it.

### 4.3 Priority-order sweep

1. **Tenant isolation** — not applicable and correctly kept so. The change issues no SQL, touches
   no repository, opens no transaction, and reads no tenant id. `grep -rn "extends
   TenantScopedRepository" apps/*/src` is unchanged; S-19 untouched, as the plan's non-goals
   promised. The Redis key namespace is not tenant-derived here: `XGROUP CREATE` names a stream and
   a group from parsed env, never from a caller value, so the
   `.claude/rules/tenant-isolation.md` "a service owns its own Redis keyspace" rule has nothing to
   bind to.
2. **Injection** — no raw SQL. The `xgroup` call passes five discrete arguments through ioredis'
   protocol encoder; nothing is string-concatenated, and the two operator-supplied values
   (`REDIS_STREAM_NAME`, `REDIS_CONSUMER_GROUP`) are separate arguments, not interpolated tokens.
3. **Correctness** — the `startsWith`-over-`includes` choice is right and its scope is stated no
   stronger than measured. Ordering (bootstrap before `listen`) is asserted by call order, and the
   plan records the move-the-call mutation. No boundary, precision or pagination surface.
4. **Clean code gate** — see below.
5. **Type safety** — no `any`, no `@ts-ignore`, no `@ts-expect-error`, no `eslint-disable` in any
   of the four new files or the modified test (grepped; the only hits are the English word "any" in
   prose). Three `as unknown as` / `as ServiceEnv` casts per test file, all mirroring
   `apps/usage-service/tests/stream.publisher.unit.test.ts`. `I6`'s rejection filter uses a proper
   `outcome is PromiseRejectedResult` predicate rather than a cast. `ensureConsumerGroup` returns
   `void` instead of narrowing ioredis' `Promise<unknown>` — correct, and the docblock says why.
6. **Production readiness** — fail-closed with a ~160 ms bound rather than a hang; signal handlers
   registered before the bootstrap so SIGTERM mid-round-trip is handled (QA measured it); both
   outcome branches logged with structured fields; no index or query surface.
7. **Test honesty** — §4.1.
8. **Plan alignment** — no scope creep. The loop-back added tests only; production files are
   byte-identical to the pre-QA revision (`src/events/stream.consumer.ts`,
   `src/constants.ts`, `src/index.ts` all `md5sum`-stable across the review). The declared
   non-goals (S-8, S-19, `format:check`, `REDIS_CONSUMER_NAME`, dead-letter) are all still
   untouched — verified by `git status`, which lists no file outside the declared set.

### 4.4 Clean code gate — required, with dispositions

| Item | Grade | Disposition |
|---|---|---|
| Magic strings in production code | none | `WORKER_CONSUMER_GROUP_BOOTSTRAP` covers all four `XGROUP` tokens; `stream.consumer.ts` contains no bare protocol literal. **Pass** |
| Magic numbers in production code | none | The module has no numeric literal at all. **Pass** |
| Magic numbers in the new tests | none | `INTEGRATION_CONCURRENCY.BOOTSTRAP_CLIENTS: 8` rather than an inline `8`; `INTEGRATION_COUNTS` / `INTEGRATION_KEY_EXISTS` / `INTEGRATION_FIELD_PAIR_STRIDE` cover the rest; `db=${INTEGRATION_REDIS.LOGICAL_DB_INDEX}` in both guard sites. **Pass** |
| Deliberate literals in tests | NIT, accepted | The Redis reply texts, `"$"` at `integration.test.ts:283`, and `LOG_MESSAGE` are literal *on purpose* — importing the constant the implementation reads would make each assertion tautological, and M-E/M-B prove the literals are load-bearing. Each carries a comment saying so. **Correct, not a violation** |
| Log messages not in `constants.ts` | NIT | Ruled acceptable above, on repo-wide precedent measured by grep. **No action** |
| DRY across constants / validator / repository | none | `WORKER_CONSUMER_GROUP_BOOTSTRAP` is a sibling of `WORKER_STREAM_CONSTANTS`, not a duplicate; the LOW-2 rework now states the distinguishing line correctly (7 members feed `env.ts`, these 4 feed none) and I verified the count. **Pass** |
| Error codes / messages in a constants module | n/a | This path returns no HTTP error and defines no error code; it rethrows the underlying rejection unchanged. **Pass** |
| `"only" ` claim in `src/constants.ts:79` | NIT-1 | Weaken to `src/`. Recommended, not required |
| Duplicated `redis://localhost:6379` (13 occurrences, 6 packages) | LOW, pre-existing | Decided at the Gate-4 re-review (D-C): file nothing. I concur — it predates this task and `INTEGRATION_REDIS_URL_FALLBACK` at least names it locally. **Carried forward unchanged** |

---

## 5. Open QA findings — explicit dispositions

**F5 · S-22 reproduced.** Reproduced again in my own gate run: db 0 went `DBSIZE` 1 → 3, two TTL'd
`denylist:*` keys. **Disposition: not T-038's, already filed as S-22 by this very change, no
further action.** Correctly diagnosed by QA.

**F6 · No case for a reply exactly `"BUSYGROUP"`.** **Disposition: accept, do not fix, do not
file.** I agree with QA and will state the residual QA did not: `startsWith` swallows not only a
bare `BUSYGROUP` but any reply *beginning* with it, e.g. a hypothetical `BUSYGROUPX`. Redis 7.0.15
emits exactly one `BUSYGROUP` form, and the looser sibling predicate is already refuted by U5.
A test for an input the server does not produce pins a fixture, not a behaviour. If T-039/T-041
start issuing other `XGROUP` subcommands against an operator-supplied group name — which is the
scenario `ALREADY_EXISTS_ERROR_PREFIX`'s docblock already flags — the right move there is an exact
match on the full reply, not a test here.

**F7 · SIGTERM during bootstrap untested.** **Disposition: accept for T-038; hand to T-039, do not
open a `known-gaps.md` id.** The ordering is real and correct — handlers at `src/index.ts:50`/`:56`
precede the bootstrap at `:75`, which I read directly — and QA measured the full shutdown sequence
running with `appListen: 0`. T-039 adds a long-running `XREADGROUP` loop between bootstrap and
shutdown and must own the shutdown-during-Redis-work contract regardless, so an id filed now would
be closed by the next task. I did **not** construct a real-process version of the double-exit
race either; I accept QA's bounding argument (`src/index.ts:41-43` has no `await` between
`disconnect()` and `process.exit(0)`) as sound reasoning, and record it as reasoning rather than
measurement. See **D-2**.

---

## 6. What I could **not** verify, and why

- **Redis other than 7.0.15 standalone.** One host instance is available
  (`redis-server 127.0.0.1:6379`). Nothing here is scoped to a cluster, a managed provider that
  restricts `XGROUP`, or Redis 6.x. Every semantic claim I confirmed is scoped to 7.0.15 via
  ioredis 5.11.1.
- **The CI run of the new integration suite.** I cannot execute the GitHub Actions job. I verified
  only that `apps/worker-service/tests/setup.ts` defaults `REDIS_URL` as a literal (surviving
  turbo's strict env mode) and that CI provisions `redis:7-alpine` on a fresh instance where db 14
  is necessarily empty. Whether db 14 stays uncontended in CI is a convention, not a mechanism —
  S-22's closing sentence.
- **An actual db-14/db-15 collision under parallel turbo scheduling.** Not constructed. The
  reservation avoids a hazard that neither the plan, QA nor I have observed.
- **The real-process SIGTERM-mid-bootstrap double-exit race** (F7) — see above. Neither QA nor I
  constructed it; neither of us has refuted it either, and I am not claiming it is impossible.
- **`pnpm test:smoke:compose`.** The compose stack is down and its `redis` service publishes no
  host port; starting it would have risked the running host services the brief told me not to
  disturb. `pnpm test:smoke` (the host variant) was run and passes.
- **The 264-file `format:check` baseline at `45679c6` as a single number.** I did not check out
  the base revision. I verified it the other way, which is stronger for this purpose: 272 measured
  now, 8 new prettier-visible files enumerated by name, and each of the 4 modified prettier-visible
  files proved already-unformatted at HEAD via `git show HEAD:<f> | prettier --check
  --stdin-filepath`.

---

## 7. Remaining risks and dispositions

| Risk | Severity | Disposition |
|---|---|---|
| worker-service no longer starts without Redis | MEDIUM, intended | D3-A, documented in `.env.example` and plan R3, compose `depends_on` already correct. **Must be named in the commit message.** Accepted |
| `I5` is the sole guard on the start position | MEDIUM, accepted | Now stated explicitly in the plan *and* in `tests/stream.consumer.unit.test.ts:185-192`, and I verified it package-wide. The standing hazard is someone deleting `I5` believing unit coverage exists; the comment is the mitigation. Accepted |
| Error-path log fields unguarded (LOW-4) | LOW | See **D-1**. Behaviour is correct; the operator signal is duplicated on `stderr` via `index.ts:81-83` |
| Reserved-logical-db convention has no mechanism | LOW, pre-existing | Recorded in S-22's closing sentence. Re-file only if CI moves to a managed Redis without multiple databases. No new id (Gate-4 re-review D-C) |
| S-22 keeps writing to db 0 on every `pnpm test` | LOW, pre-existing | Filed as S-22 by this change. Pairs with S-20. Not T-038's |
| The `.claude/rules/` snapshot injected into agent sessions is stale (plan §4) | MEDIUM, process | Independently confirmed again this session: the injected `known-gaps.md` ends at S-21 while the file on disk carries S-22 and S-23 — i.e. the entries **this diff adds** are invisible to the injected copy. The plan's practical rule ("`cat` a rule file before citing it, and say that you did") is right and I followed it. **Recommend this be added to `.claude/rules/known-gaps.md` as a new id** — it is out of scope to fix here, it has now misled a planner and two implementers on this task alone, and it is not recorded anywhere durable |

**One out-of-scope gap I recommend filing** (per the review rules, so it does not evaporate): the
stale-rules-snapshot problem in the row above. It is a tooling defect, not a code defect, and it
belongs next to S-14 (`.claude/agents/` vs `.github/agents/` drift), which is the same class —
two copies of an authority, one of which is read.

---

## 8. Decisions for you

Two. Neither blocks the required fixes in §2, which I recommend regardless.

### D-1 · The error-path log's fields have no test (LOW-4). Fix now, or carry it?

**One sentence:** `String(error)` at `stream.consumer.ts:114` can be replaced by a constant with
all 65 tests still green — the same gap QA raised as F2 for the info paths, on the path F2 did not
cover.

| Option | What changes | Gate impact |
|---|---|---|
| **A · Carry it; T-039 rewrites this class** *(recommended)* | Nothing in the diff. Noted in T-039's plan as a coverage item to fold into its suite | None — commit after §2 |
| B · Fold in one test now | ~6 lines in `U4`: `toHaveBeenCalledWith` on the error log, plus a third `LOG_MESSAGE` member | Loops back to Gate 3 → Gate 4 for a test-only change |
| C · File it in `.claude/rules/known-gaps.md` | One entry, new id | None — commit after §2 |

**Recommendation: A.** The behaviour is correct and the operator does not depend on this log line —
the same rejection reaches `stderr` through `src/index.ts:81-83`, which QA observed end to end, so
nothing is lost if the field regresses. Against that, this task's own record is that each
loop-back has introduced fresh imprecision: the last one closed F2 and F3 correctly and left three
stale numerals behind it (LOW-1/2/3). T-039 will rewrite `ensureConsumerGroup`'s neighbourhood to
add `XREADGROUP` and `XAUTOCLAIM`, and is the natural place for it. C is defensible if you want a
durable record, but `known-gaps.md` is for cross-task gaps and this is one task's own thin spot.

**Diff impact:** B changes the diff and re-opens two gates. A and C do not change any code; C adds
a `.claude/rules/` entry. A and C are preference; B is the only one that changes the shipped tests.

### D-2 · Should the stale-rules-snapshot problem get a `known-gaps.md` id?

**One sentence:** the `.claude/rules/*` content injected into agent sessions is a stale snapshot —
confirmed again this session, where the injected `known-gaps.md` stops at S-21 and cannot see the
S-22/S-23 entries this very diff adds — and nothing records that anywhere durable.

| Option | What changes |
|---|---|
| **A · File it as a new id in `.claude/rules/known-gaps.md`** *(recommended)* | One entry, ~10 lines, next to S-14. In this commit or a docs-only one |
| B · File it, but as its own docs commit after T-038 | Same entry, T-038's diff unchanged, one-task-per-commit preserved strictly |
| C · Leave it in the plan's §4 correction box only | Nothing. It stays discoverable only by someone reading this task's plan |

**Recommendation: A**, folded into this commit — the diff already edits `known-gaps.md` for S-22
and S-23, so the file is in scope, and the entry costs nothing to review. **B** if you read the
one-task-per-commit rule strictly enough that a third unrelated gap entry offends it; that is the
same objection that kept S-8 out of S-4, and it is a reasonable line to hold. **C** is the option
I would argue against: this defect has already produced a false finding in the plan, a withdrawn
gap filing, and a reviewer round, and it will do it again to T-039.

**Diff impact:** A adds ~10 lines to a file already in the diff. B and C leave T-038's diff exactly
as it is. All three are documentation; none touches code or tests.

---

## 9. Verdict

**CONDITIONAL.**

Apply the five prose corrections in §2 — two wrong `file:line` citations and three stale test-count
numerals, one of which lives in `.claude/rules/known-gaps.md`. They are prose in files already in
the diff, they touch no code or test logic, and they do not re-open any gate, so a re-run of the
compile-time gate is not required after them.

With those applied, and D-1/D-2 answered, this is ready to commit. The production code is correct
and unchanged since the pre-QA revision; all four gates pass with `--force` and 0 cached across all
13 packages; the 14 lint warnings are proven pre-existing at `d68e719` and `b0f6921`; the three
tests the loop-back added are non-vacuous under six mutations I ran and reverted; and both scope
claims the implementer chose to state narrowly are exactly as narrow as the evidence, verified in
both directions.

The pattern this review was asked to guard against — a correction trusted without re-execution —
did not recur in substance. The `U1`/`I5` correction, the `format:check` mechanism, and the
five-case red set are all true as written, and I re-derived each by running it. What the last
loop-back did leave behind is the arithmetic of its own transcripts: three figures measured
against a 5-test integration suite and a 6-test unit suite, restated after the same change grew
them to 6 and 8. That is a milder version of the same failure and it is what the CONDITIONAL is
for.
