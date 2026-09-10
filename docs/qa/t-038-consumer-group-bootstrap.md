# QA — T-038 Consumer Group Bootstrap

**Gate**: 5 (QA Tester) · **Verdict**: **PASS**
**Revision tested**: uncommitted working tree over `45679c6` (nothing committed, nothing staged)
**Environment**: host Redis 7.0.15 on `127.0.0.1:6379`; host PostgreSQL 16.13 on `127.0.0.1:5432`;
node 22.22.2; vitest 2.1.9; ioredis 5.11.1; zod 3.25.76
**Conduct**: read-only on production code. Every mutation listed below was reverted and the
working tree verified byte-identical afterwards (`md5sum -c`, `git diff --stat` back to
`5 files changed, 341 insertions(+), 15 deletions(-)`). No commit, no stage, no branch.

PASS is a release-readiness call, not a claim that nothing was found. Four LOW findings and one
NIT are below; none of them changes behaviour and none is a defect in shipped code. **The one
that should be fixed before commit is F1 — a false claim in the plan, which is a committed
artifact.**

---

## 1. Full gates — my own run, `--force`, nothing replayed from cache

Every command below reports `Cached: 0 cached, 13 total`, so none of it is the implementer's
cached output.

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck --force` | **13 successful, 13 total · 0 cached** · exit 0 · 9.5 s |
| Lint | `pnpm lint --force` | **13 successful, 13 total · 0 cached** · exit 0 · 26.7 s |
| Build | `npx turbo run build --force` | **13 successful, 13 total · 0 cached** · exit 0 · 20.1 s |
| Test | `pnpm test --force` | **13 successful, 13 total · 0 cached** · exit 0 · 12.7 s |
| Smoke | `pnpm test:smoke` | 6 services, 7 tests, all passed · exit 0 |

### Per-package test status — all 13

| Package | Test files | Tests |
|---|---|---|
| `@telemetry/analytics-service` | 4 passed | 18 passed |
| `@telemetry/auth-service` | 15 passed | 164 passed |
| `@telemetry/billing-service` | 4 passed | 18 passed |
| `@telemetry/gateway` | 8 passed | 38 passed |
| `@telemetry/shared-config` | 1 passed | 4 passed |
| `@telemetry/shared-logger` | 1 passed | 4 passed |
| `@telemetry/shared-tracing` | 1 passed | 2 passed |
| `@telemetry/shared-types` | 1 passed | 8 passed |
| `@telemetry/shared-utils` | 1 passed | 18 passed |
| `@telemetry/shared-validation` | 1 passed | 15 passed |
| `@telemetry/usage-service` | 19 passed | 230 passed |
| `@telemetry/web` | `No test files found, exiting with code 0` | — |
| **`@telemetry/worker-service`** | **7 passed** | **62 passed** |

`worker-service` 7 files / 62 tests independently confirms the handoff claim. Baseline at
`45679c6` was 5 files / 49 tests, so +2 files / +13 tests = U1-U6 (6) + I1-I5 (5) + U7, U8 (2).

Narrow worker gate re-run after all mutation work, on the restored tree: `typecheck` clean,
`lint` silent (no output), `test` 7 files / 62 tests.

### Lint warnings — all 14 pre-existing, proven

0 errors. 14 warnings, none in a file this change touches:

- `apps/auth-service/tests/auth.service.unit.test.ts` — 10 × `no-misused-promises`.
  `git log -1` → `d68e719 2026-08-25`.
- `apps/usage-service/tests/ingestion.service.unit.test.ts` — 4 × `no-unsafe-assignment`.
  `git log -1` → `b0f6921 2026-08-31`.

Neither file appears in `git diff --name-only`. **No new warning is introduced by T-038.**

### `pnpm format:check` — S-12, measured both ends

Do not read this as a gate; there is no format step in `.github/workflows/ci.yml`.

| | Files with style issues |
|---|---|
| Baseline at `45679c6` (clean detached worktree, removed afterwards) | **264** |
| Working tree now | **271** |

Delta accounted for exactly, by set difference of the two `[warn]` lists — 7 files added, 0
removed, and all 7 are **new** files:

```
apps/worker-service/src/events/stream.consumer.ts
apps/worker-service/tests/integration.constants.ts
apps/worker-service/tests/stream.consumer.integration.test.ts
apps/worker-service/tests/stream.consumer.unit.test.ts
docs/plans/t-038-consumer-group-bootstrap.md
docs/reviews/t-038-consumer-group-bootstrap.md
docs/reviews/t-038-consumer-group-bootstrap-rereview.md
```

All four *modified* tracked files (`known-gaps.md`, `src/constants.ts`, `src/index.ts`,
`tests/index.graceful-shutdown.unit.test.ts`) were already in the baseline list, so none of them
newly broke formatting. `.env.example` is not checked by prettier at all. See **F4** for the
discrepancy with the plan's recorded numbers.

---

## 2. Acceptance criteria

Walked against plan §7 **and** the epic story at `docs/epics/epic-7-worker-service.md:61`
("Create the consumer group on startup. If the group already exists (`BUSYGROUP` error), ignore
and continue"). Where I was unsure a test would fail if the behaviour broke, I mutated the
implementation, ran the suite, and reverted. Mutation ids are mine (`M1`-`M11`); baseline for
all of them is the three suites together at **21 passed (21)**.

| AC | Statement | Verdict | Evidence — the mutation and what went red |
|---|---|---|---|
| **AC1** | Bootstrap creates the group where none exists | **MET** | `M3` (drop `MKSTREAM` arg) → U1, I1, I2, I3, I4 red (5 failed). `M10` (`SUBCOMMAND_CREATE` value `CREATE`→`SETID`) → I1-I5 red. Live: I1 asserts the name back out of `XINFO GROUPS`. |
| **AC2** | Where the group exists, bootstrap succeeds and does nothing | **MET** | `M11` (`ALREADY_EXISTS_ERROR_PREFIX` → `NEVERMATCH`) → U2, U5, I2, I3 red. I2 is live and sequential. See **F3** on the concurrent shape. |
| **AC3** | Repeat bootstrap moves neither cursor nor pending list | **MET** | I3 is live and non-vacuous: `readOnlyGroup` throws on a missing group, and `M3`/`M9`/`M10`/`M11` each redden it. |
| **AC4** | Any other reply propagates (D3-A fail-closed) | **MET** | `M4` (delete `throw error`) → U3, U4, U5, **U8** red (4 failed). `M5` (drop the `error instanceof Error` guard) → U4 red. Also proven end to end — §4(b). |
| **AC5** | Already-exists is a prefix match, not a substring match | **MET** | `M2` (`startsWith` → `includes`) → **U5 red, and only U5**. U5's own premise assertions (`:148-153`) are live: `M11` reddens them with `expected false to be true`. |
| **AC6** | The stream key is created if absent (`MKSTREAM`) | **MET** | `M9` (`OPTION_MKSTREAM` value `MKSTREAM`→`NOSTREAM`) → I1-I5 red with `ERR unknown subcommand or wrong number of arguments for 'CREATE'`. I4 asserts `EXISTS`→1, `TYPE`→`stream`, `XLEN`→0. |
| **AC7** | The group starts at `$` (D1-A) | **MET, but by one test only** | `M1` (`START_ID_NEW_ENTRIES_ONLY` `"$"`→`"0"`) → **I5 red at `:271`** (`expected [ Array(2) ] to not include '1789031676657-0'`). **U1 passed 6/6 under the same mutation.** The AC holds; the plan's account of *which* test holds it does not. See **F1**. |
| **AC8** | Names come from parsed env, not literals | **MET** | `M7` (hard-code both to the defaults) → U6 red (`expected [ 'CREATE', 'telemetry:events', …(3) ] to include 'telemetry:events:t038-unit-override'`) **plus I1-I5 red** (6 failed). Also proven end to end: a live worker started with `REDIS_STREAM_NAME=telemetry:events:qa-t038` created a group on exactly that key. |
| **AC9** | Bootstrap runs before the HTTP listener binds | **MET** | `M6` (move the call after `app.listen`) → U7 red with `expected 82 to be less than 81` — byte-identical to the number the plan's Gate-3 checklist records — and U8 red. Also proven end to end: the `Created stream consumer group` log line precedes `Server listening at …` in a real process. |

### The epic's own two callouts

Both correct against the code, and both now measured by me rather than taken from the plan:

- **`MKSTREAM` creates the key** — I4, plus `M9`. Live worker on a fresh key: `XLEN` 0,
  `TYPE stream`, `last-delivered-id 0-0`.
- **`$` = only messages published after creation** — I5, plus `M1`.

### The epic's one divergence from the code, reported as a spec finding

`epic-7-worker-service.md:68` writes `err.message.includes("BUSYGROUP")`. The implementation uses
`startsWith`. **The code is right and the epic is looser than it should be** — this is D4, already
decided, and `M2` shows the difference is a live test distinction rather than a style preference.
Recording it here as a divergence *about the epic*, per the brief. No code change wanted.

---

## 3. Coverage gaps — the reviewer's list confirmed, refuted, and extended

The reviewer listed three. Verdicts:

| Reviewer's gap | Verdict | Detail |
|---|---|---|
| Info-log **fields** (`startId`, stream, group) never asserted — only that `logger.info` was called | **CONFIRMED, and understated** | `M8` deleted the entire success-path `logger.info(...)` block. **All 21 tests still passed.** So it is not just the fields: the success-path log *call* is unasserted too. Separately, U2's `expect(mockLogger.info).toHaveBeenCalled()` (`:123`) is message-agnostic — logging `"Created stream consumer group"` on the already-exists path would still satisfy it. See **F2**. |
| No case for a message exactly equal to `"BUSYGROUP"` | **CONFIRMED, and it is noise** | `startsWith("BUSYGROUP")` on the bare string is `true`, so it would be swallowed as already-exists. No `XGROUP` reply on Redis 7.0.15 is a bare `"BUSYGROUP"`; every observed reply is `BUSYGROUP Consumer Group name already exists`. Untested boundary, unreachable input. **F6**, do not fix. |
| No SIGTERM-during-bootstrap case (their L7) | **CONFIRMED as untested; behaviour verified correct by me** | I constructed it (throwaway probe, deleted). Handlers *are* registered before the bootstrap (`src/index.ts:50` / `:56` vs `:75`), so the shutdown runs fully: `app.close` 1, `prisma.$disconnect` 1, `redis.disconnect` 1, `exit(0)`, `app.listen` **never called**. See **F7** for the one subtlety and why it is not a production hazard. |

### Gaps the reviewer missed

- **No concurrent-bootstrap test (F3).** Swallowing `BUSYGROUP` instead of taking a lock is the
  central design decision, and its justification is multi-replica startup. Nothing in the
  committed suite exercises more than one caller. I built the case as a throwaway probe (8
  independent ioredis connections, `Promise.allSettled`, scratch logical db 12): **8/8 fulfilled,
  0 rejected, exactly 1 group**. So the behaviour is right — what is missing is the regression
  guard, not the correctness.
- **No live `WRONGTYPE` case.** U3 covers it with a mocked rejection; no integration case points
  the bootstrap at a key holding a non-stream value. Low value — the mocked case already pins the
  fail-closed branch, and `M4` proves it live.
- **Boundary/empty values are covered elsewhere and are fine.** `REDIS_STREAM_NAME=""` and
  `REDIS_CONSUMER_GROUP=""` both throw at `parseEnv` (measured, §5), so the consumer's
  no-fallback constructor cannot receive an empty name on the production path.

### Which gaps matter

Only **F3** would I call worth a test. **F2** is worth one line in an existing test. **F6** is
noise. **F7** is optional.

---

## 4. Regression risk across the other 12 packages

**Blast radius is one package.** `worker-service` is a leaf: nothing declares
`@telemetry/worker-service` as a dependency, and `StreamConsumer` /
`WORKER_CONSUMER_GROUP_BOOTSTRAP` / `stream.consumer` have **zero** references outside
`apps/worker-service/` (excluding `dist/`). No shared package is modified —
`git diff --name-only | grep '^packages/'` is empty. No SQL, no Prisma, no tenant-scoped path, no
`base.repository.ts` (S-19 correctly left alone). The `xgroup` arguments go through ioredis' RESP
encoding, so the operator-supplied group name carries no injection surface.

All 12 other packages were green in the same `--force` run (§1). Not green *for the wrong reason*:
`M3`, `M7`, `M9`, `M10`, `M11` each reddened between 1 and 6 cases, so the suites are live rather
than short-circuiting.

### The two claims the reviewer could not execute — both now executed

I did **not** stop the developer's Redis or PostgreSQL. Both stayed up throughout (`redis-cli PING`
→ `PONG` re-checked after each run). Unreachability was simulated with a **scoped env override to
port 6390**, verified to have no listener (`ss -ltn | grep 6390` → nothing;
`redis-cli -p 6390 PING` → `Connection refused`).

**(a) `pnpm test:smoke` still passes with Redis down — CONFIRMED by execution.**

```
REDIS_URL=redis://localhost:6390 pnpm test:smoke
  gateway 2 passed · auth 1 · usage 1 · billing 1 · analytics 1 · worker 1
  EXIT=0
```

All 6 services, 7 tests, exit 0. This is the measurement that vindicates D2-C: the bootstrap is
wired into `src/index.ts`, not into an `app.ts` `onReady` hook, so `buildWorkerServiceApp()` +
`app.listen({ port: 0 })` still needs no queue. `container.ts:22-26`'s `lazyConnect: true` means
building the app issues no command. The smoke suite was **not** converted into an infrastructure
test.

**(b) The worker genuinely fails to start against a down Redis, end to end — CONFIRMED by
execution.**

The real entrypoint is `tsx src/index.ts` (root `Dockerfile:20`), not `node dist/`. Run with
`REDIS_URL=redis://localhost:6390`, `PORT=3903`:

```
{"level":"error",...,"error":"connect ECONNREFUSED 127.0.0.1:6390","msg":"Redis connection error"}   x3
{"level":"error",...,"streamName":"telemetry:events","groupName":"worker-group",
 "error":"Reached the max retries per request limit (which is 2). Refer to \"maxRetriesPerRequest\" option for details.",
 "msg":"Failed to ensure stream consumer group"}
MaxRetriesPerRequestError: Reached the max retries per request limit (which is 2). ...
    at Socket.<anonymous> (.../ioredis/built/redis/event_handler.js:207:37)

exit code: 1   elapsed: 1261 ms
listener on 3903: (none - never bound)
```

Exit **1**, port **never bound**, via the deliberate `void start().catch((error) => { console.error(error); process.exit(1); })`
at `src/index.ts:81-84` — not an unhandled rejection. D3-A holds in a real process. The
`MaxRetriesPerRequestError` shape and the ~160 ms Redis-side latency both match what the plan
recorded; the 1261 ms total is tsx + tracing startup on top.

**Positive control, so (b) is not just "it never starts".** Same command against a reachable Redis
on scratch logical db **12** with scratch stream/group names — deliberately *not* db 0, and not
14/15 which belong to suites:

```
{"level":"info",...,"streamName":"telemetry:events:qa-t038","groupName":"worker-group-qa-t038",
 "startId":"$","msg":"Created stream consumer group"}
{"level":30,...,"msg":"Server listening at http://127.0.0.1:3903"}
GET /health -> {"status":"ok","service":"worker-service"}

redis-cli -n 12 XINFO GROUPS telemetry:events:qa-t038
  name worker-group-qa-t038 · consumers 0 · pending 0 · last-delivered-id 0-0 · lag 0
redis-cli -n 12 XLEN -> 0 · TYPE -> stream
```

Three things this proves that no mock does:

1. **AC9 in a real process** — the bootstrap log line precedes `Server listening`.
2. **AC8 end to end** — the operator-supplied names reached Redis.
3. **The untested info-log fields are actually correct** — `streamName`, `groupName` and
   `startId: "$"` are all present and right. F2 is a missing *guard*, not a latent bug.

db 12 was `FLUSHDB`-ed afterwards (guarded: `CLIENT INFO` → `db=12` first) and verified `DBSIZE 0`.

### Startup-contract change is satisfied everywhere it runs

The worker now requires a reachable Redis to start (plan R3). Checked, not assumed:

- `docker/docker-compose.yml` — `redis` has a `redis-cli ping` healthcheck, and `worker-service`
  declares `depends_on: redis: condition: service_healthy`, with `REDIS_URL: redis://redis:6379`
  from `x-common-app-env`.
- `.github/workflows/ci.yml:55-58` — `redis:7-alpine` as a service with health options; `pnpm test`
  is at `:108`, after it.
- `test:smoke:compose` (`ci.yml:119`) runs after `docker compose up -d --build --wait` at `:116`.
  A failed bootstrap now means the worker exits, its `/health` healthcheck never passes, and
  `--wait` fails the step loudly. Correct fail-closed ordering.
- `pnpm dev` for a developer with no Redis will now fail for worker-service. Intended (D3-A),
  documented in `.env.example`, and it belongs in the commit message.

### One observation, pre-existing and not T-038's

`node dist/src/index.js` cannot run: `ERR_MODULE_NOT_FOUND … dist/src/startup.constants` —
`tsc` emits extensionless ESM specifiers. Pre-existing for every service; the repo starts services
with `tsx`. Not a finding against this change, recorded so the next person does not re-derive it.

---

## 5. Test honesty

Sampled all four suites independently against `.claude/rules/testing.md`.

**Good, and verified rather than read:**

- `xgroupArgs()` (`stream.consumer.unit.test.ts:78-85`) **throws** `"xgroup was never called"` on a
  missing call. `readOnlyGroup()` (`integration:109-118`) throws `"no consumer group on <stream>"`.
  Neither can pass vacuously — the rule's explicit requirement.
- U5's premise assertions (`:148-153`) look like they test `String.prototype`, but they are a
  live non-vacuity guard: `M11` reddens them with `expected false to be true`. Legitimate.
- I5's negative assertion `expect(delivered).not.toContain(backlogId)` is the one that fires under
  `M1`, at `:271` — the *behavioural* line, ahead of the literal pin at `:275`. Weight is in the
  right place.
- U6 has both halves: the overrides must be present **and** the defaults absent. `M7` reddens it.
- U7 uses `mock.invocationCallOrder`, not two independent `toHaveBeenCalled()`s, and `M6` reddens
  it with the exact number the plan records.
- The `waitForStartupToSettle` rewrite is **not** a weakened assertion. Its stated falsifying
  mutation (move `loadLocalEnv()` after `buildWorkerServiceApp()`) is the right test of that, and
  the negative case survives independently: under `M6`, U8's
  `expect(context.appListen).not.toHaveBeenCalled()` went red with `expected "spy" to not be called
  at all, but actually been called 1 times`. A wait that had swallowed the negative path could not
  produce that.
- The integration suite **fails loudly** without Redis rather than skipping into a false green:
  `REDIS_URL=redis://localhost:6390` → `Test Files 1 failed (1) / Tests 5 skipped (5)`, exit
  non-zero. The 5 cases report as "skipped" (vitest's `beforeAll`-failure shape) but the **file**
  fails, which is what reddens the gate.

**The one real tautology, and it is bounded:**

U1's argument-vector assertion (`:106-112`) compares against the *same constants* the
implementation sends, so it cannot detect a change to any constant's **value** — only to the
call's shape. I checked whether that leaves a hole by mutating each constant's value in turn:

| Constant value mutated | Caught by |
|---|---|
| `SUBCOMMAND_CREATE` `CREATE`→`SETID` (`M10`) | I1-I5 |
| `OPTION_MKSTREAM` `MKSTREAM`→`NOSTREAM` (`M9`) | I1-I5 |
| `ALREADY_EXISTS_ERROR_PREFIX` `BUSYGROUP`→`NEVERMATCH` (`M11`) | U2, U5, I2, I3 |
| `START_ID_NEW_ENTRIES_ONLY` `$`→`0` (`M1`) | **I5 only** |

So every constant is guarded — by the live-Redis suite in every case, never by U1. That is
acceptable (`.claude/rules/constants.md` requires tests to import constants rather than re-type
them, and the integration suite is the compensating control). What is **not** acceptable is the
plan asserting the opposite; that is **F1**.

**Weak but not tautological:** U2's `expect(mockLogger.info).toHaveBeenCalled()` — see **F2**.

**Redis-hygiene helper is genuinely load-bearing, re-verified independently.** I mutated *only*
the guard's expected string (to `db=QA-CANNOT-MATCH-14`), leaving the connection on db 14, and
seeded a sentinel key:

```
db14 DBSIZE before = 1
  Test Files  1 failed (1)
        Tests  5 skipped (5)
db14 DBSIZE after  = 1     <-- sentinel survived; the guard blocked every flush
```

This reproduces the implementer's H1 claim from scratch, including the `afterAll`-runs-anyway
behaviour that made the single-`beforeAll`-guard shape unsafe. Restored and re-verified green
(5/5); sentinel deleted.

---

## 6. Redis hygiene — db 0 untouched

Recorded around a **full `pnpm test --force`** run.

| | Before | After |
|---|---|---|
| `XLEN telemetry:events` | **2** | **2** |
| entry ids | `1787746970722-0`, `1788171536033-0` | `1787746970722-0`, `1788171536033-0` — **identical** |
| `XINFO GROUPS telemetry:events` | *(empty)* | *(empty)* — **still 0 groups** |
| db 0 `DBSIZE` | 1 | **2** (see below) |
| db 12 / 13 / 14 / 15 `DBSIZE` | 0 / 0 / 0 / 0 | **0 / 0 / 0 / 0** |

**T-038's suite does not touch db 0.** The stream, its two entries, and the zero-group state that
D1's whole argument rests on are byte-identical after a full run. Reserved dbs 12-15 all end
empty — including after the mutation runs, where I1-I5 were failing, because `flushReservedDb` is
called from `afterEach` and `afterAll` and not only on the happy path.

**The one db 0 change is not T-038's — it is S-22, reproduced.** db 0 gained
`denylist:ef894b3a003048e59bbe66d0358add3c`, a TTL'd key (`expires=1, avg_ttl=899693`) written by
auth-service's `TokenDenylistService` during its logout tests, exactly as
`.claude/rules/known-gaps.md` S-22 describes. Recorded as independent confirmation of S-22 at this
revision, and as the contrast that makes T-038's reservation of db 14 the right pattern. **F5.**

---

## 7. Findings

### F1 · The plan's Slice-4 correction makes a false claim about U1 — **LOW, fix before commit**

`docs/plans/t-038-consumer-group-bootstrap.md`, §6 Slice 4 (and repeated at §11's LOW-1 entry):

> **Not beyond a mock:** the *start position argument*. `U1`
> (`tests/stream.consumer.unit.test.ts:101`) asserts the whole `xgroup` vector by exact
> equality, `START_ID_NEW_ENTRIES_ONLY` included, so replacing `CREATE` with `SETID` **or
> changing the start id** reddens it.

**Measured false.** Mutation `M1`, `apps/worker-service/src/constants.ts:132`:

```
-  START_ID_NEW_ENTRIES_ONLY: "$",
+  START_ID_NEW_ENTRIES_ONLY: "0",

$ npx vitest run tests/stream.consumer.unit.test.ts
 ✓ tests/stream.consumer.unit.test.ts (6 tests) 11ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

U1 is green because it asserts the vector *against the same constant*, so both sides move
together. The only case that catches it is I5:

```
 FAIL  tests/stream.consumer.integration.test.ts > I5 - the group starts at $ ...
AssertionError: expected [ Array(2) ] to not include '1789031676657-0'
 ❯ tests/stream.consumer.integration.test.ts:271:27
```

The "replacing `CREATE` with `SETID`" half of the sentence *is* true (`M10` — though it is caught
by I1-I5, not by U1 either; U1 stays green there too, for the same reason). AC7 is properly
covered, so nothing about the shipped code changes.

Why this is worth raising rather than waving through: `.claude/rules/review-standards.md`
§ *Universals Must Cite Their Mutation* exists for exactly this shape, and this is the **second**
false claim in this one sentence's history — the original said "three things a mock cannot", L1
refuted it, LOW-1 rewrote it, and the rewrite is also wrong. The plan is committed alongside the
code, and the next person deciding whether I5 can be deleted will read it.

**Concrete change:** in §6 Slice 4, replace "so replacing `CREATE` with `SETID` or changing the
start id reddens it" with what was measured — U1 asserts the vector *shape* (a missing or extra
argument reddens it, `M3`), and asserts it against the constants themselves, so **no** change to a
constant's *value* reddens U1; `START_ID_NEW_ENTRIES_ONLY` is guarded by I5 alone, at `:271`.
Mirror the correction in §11's LOW-1 entry.

### F2 · The success-path info log is entirely unguarded — **LOW, coverage**

Mutation `M8`: deleted the whole `this.logger.info({ streamName, groupName, startId }, "Created
stream consumer group")` block at `apps/worker-service/src/events/stream.consumer.ts:89-96`.

```
 Test Files  3 passed (3)
       Tests  21 passed (21)
```

The reviewer reported the *fields* as unasserted; it is broader than that — the call itself is.
Compounding it, U2 (`tests/stream.consumer.unit.test.ts:123`) asserts only
`expect(mockLogger.info).toHaveBeenCalled()`, so the created-path and already-exists-path messages
are indistinguishable to the suite.

This is observability, not correctness, and I verified by running a real worker that the fields are
actually right (§4). **Cheapest fix, if wanted:** extend U1 with one
`expect(mockLogger.info).toHaveBeenCalledWith({ streamName: …, groupName: …, startId: WORKER_CONSUMER_GROUP_BOOTSTRAP.START_ID_NEW_ENTRIES_ONLY }, "Created stream consumer group")`
and give U2 the corresponding already-exists message. Note this would *not* close F1 —
`startId` there would again be the constant, not `"$"`.

### F3 · No concurrent-bootstrap test — **LOW, coverage, the gap the reviewer missed**

The design decision T-038 rests on is "swallow `BUSYGROUP` instead of locking", justified by
multi-replica startup (plan §2 D2, probe P16). I2 exercises two *sequential* calls on one client.
Nothing exercises concurrency.

I built the case as a throwaway probe — 8 independent ioredis connections, `Promise.allSettled`,
scratch logical db 12 (guarded `CLIENT INFO` → `db=12`; deleted and verified `DBSIZE 0` after):

```
PROBE fulfilled: 8 of 8
PROBE rejected: []
PROBE group count: 1
```

So the behaviour is correct on Redis 7.0.15. The gap is regression protection, not a defect. It is
the AC whose failure mode is worst (every replica in a fleet crash-looping at startup) and whose
committed test is thinnest.

### F4 · The plan's `format:check` numbers are both off by one — **NIT**

Plan §11 records "265 → 270, delta attributed to the 5 new files". Measured: **264 → 271 files**,
delta **7**, all new files (§1). Two causes, both benign: 265 is the `[warn]` *line* count
(264 files + the `Code style issues found in …` summary line), and the Gate-3 measurement predated
`docs/reviews/t-038-consumer-group-bootstrap-rereview.md`, so it saw 6 new files rather than 7.
The plan's *conclusion* — the whole delta is new files, no modified file newly broke formatting,
S-12 — is correct, and I re-derived it by set difference. Fix the two numerals or state them as
`[warn]` lines; do not reformat anything.

### F5 · S-22 reproduced at this revision — **informational, not T-038's**

A full `pnpm test` run took db 0's `DBSIZE` from 1 to 2, adding a TTL'd
`denylist:<jti>` key from auth-service's logout tests. Exactly S-22. No action inside T-038;
recorded because the brief asked, and because it is the contrast that justifies db 14.

### F6 · No case for a message exactly `"BUSYGROUP"` — **LOW, noise, do not fix**

`startsWith` on the bare string is `true`, so such a reply would be swallowed as already-exists.
Redis 7.0.15 emits no such reply — every observed form is
`BUSYGROUP Consumer Group name already exists`. An untested boundary on an unreachable input.

### F7 · SIGTERM during bootstrap is untested; behaviour is correct — **LOW, optional**

Constructed with a hanging `xgroup` mock (throwaway probe, deleted). With the bootstrap genuinely
in flight and `app.listen` not yet called:

```
PROBE after SIGTERM mid-bootstrap: exitCodes = [0] | appClose: 1 | prismaDisconnect: 1
                                  | redisDisconnect: 1 | appListen: 0
```

Correct: handlers are registered at `src/index.ts:50`/`:56`, before the bootstrap at `:75`, so the
full shutdown sequence runs and the listener never binds.

The one subtlety, stated as measured and then bounded. Releasing the in-flight `xgroup` as a
rejection afterwards produced `exitCodes = [0, 1]` — the bootstrap's rethrow reaching
`start().catch` and calling `process.exit(1)` a second time. **That is an artifact of the probe
mocking `process.exit` into a no-op, and it is unreachable in production**: `src/index.ts:41-43` is
`container.redis.disconnect(); container.logger.info("Shutdown complete"); process.exit(0);` with
no `await` between them, so `process.exit(0)` runs in the same synchronous turn as the disconnect
and no rejection callback can be scheduled first. I did not construct a real-process version of
this race, and I am not claiming one exists.

A test would pin the ordering contract cheaply, but nothing is wrong today.

---

## 8. What I exercised, and what I could not

**Exercised:** all four gates with `--force` and 0 cached across 13 packages; `pnpm test:smoke`;
11 mutations of production code with revert and byte-integrity verification; two throwaway probe
suites (SIGTERM-during-bootstrap, 8-way concurrency), both deleted; a real worker process against
both an unreachable and a reachable Redis, including `/health`; the `db=14` guard mutation with a
sentinel; the integration suite against an unreachable Redis; independent `safeParse` probes of
both services' real env schemas; `format:check` at `45679c6` and at the working tree with a set
difference; the compose and CI wiring for the new startup dependency; db 0 / 12 / 13 / 14 / 15
snapshots before and after a full test run.

**Could not exercise, and why:**

- **`pnpm test:smoke:compose`.** The `docker/docker-compose.yml` stack is down and its `redis`
  service publishes no host port. Bringing it up would build 7 images and bind host ports 3000-3005,
  which is outside a QA gate's remit on a developer machine. I verified the wiring by reading it
  instead (healthchecks, `depends_on: service_healthy`, `REDIS_URL`, step order in `ci.yml`) and
  say so explicitly rather than calling it tested. **CI runs it at `ci.yml:119`.**
- **Redis other than 7.0.15 standalone via ioredis 5.11.1.** No cluster, no managed provider, no
  Redis 6.x. Every Redis semantic claim in this report is scoped to that one configuration — the
  same scope the plan declares.
- **A real-process double-exit race for F7.** See F7; I state it as not constructed.
- **Graceful shutdown of the live worker.** My `kill -TERM` went to the `npx` wrapper rather than
  the node child, so it exited 143 without the shutdown log lines. Not re-run: the path is
  unchanged by T-038 and is covered by the shutdown suite. Recorded so the 143 is not mistaken for
  evidence either way.
- **Redis 7.0.15's `$` semantics under a connection pooler or a proxy.** Out of scope, and no
  pooler exists in this repo.

---

## 9. Release-readiness call

**PASS.** Ship-ready.

- All four gates green across 13 packages on a forced, uncached run; smoke green.
- All nine acceptance criteria met, each proven by a test I watched go red under a deliberate
  mutation of the implementation.
- Both claims the pre-QA reviewer could only reason about are now confirmed by execution, and the
  fail-closed contract holds in a real process rather than only against mocks.
- Blast radius is one leaf package; no shared package, no SQL, no tenant-scoped path. The new
  startup dependency is satisfied in compose and in CI, and fails loudly rather than silently
  where it is not.
- db 0 is provably untouched by a full test run, and the reserved-db guard is load-bearing —
  re-verified from scratch.

No finding is a defect in shipped code. **F1 is a false claim in a committed artifact and should be
corrected before the commit**; it is a two-sentence edit to `docs/plans/`, touches no code, and
does not warrant a Gate-3 loop. **F4** is two numerals in the same file. **F2**, **F3**, **F6**,
**F7** are coverage, and the decision below is which of them to act on.

Recommended for `.claude/rules/known-gaps.md`: **nothing new.** F2/F3/F7 are this task's own test
coverage, not platform gaps, and are better fixed or accepted here than filed. F5 is already S-22.
F6 is not worth an id.

---

## 10. Decisions for the user

### D-QA1 · What to do about F1 and F4 (the plan's false/imprecise claims)?

**One sentence:** the plan claims U1 catches a start-id change (it does not — measured) and records
`format:check` as 265→270 (measured 264→271 files); do we correct the plan before committing?

| Option | What changes |
|---|---|
| **A · Correct both in `docs/plans/` now** *(recommended)* | Two prose edits: §6 Slice 4 + §11 LOW-1 restated to what was measured, and §11's format numerals fixed. **No code, no tests.** Then commit. |
| B · Correct F1 only, leave F4 | One prose edit. F4 is a numeral in a S-12 note nothing reads. |
| C · Commit as-is, file both as follow-ups | Diff unchanged. The plan ships asserting something a `sed` one-liner refutes. |

**Recommendation: A.** F1 is precisely the failure mode `.claude/rules/review-standards.md`
§ *Universals Must Cite Their Mutation* was written for, and it has already survived two correction
rounds — L1 refuted the original, LOW-1 rewrote it, and the rewrite is also false. The cost is two
sentences; the cost of C is that the next person who reads it may delete I5, which is the *only*
guard on AC7.

**Diff impact:** A and B change `docs/plans/t-038-consumer-group-bootstrap.md` only. C changes
nothing. None of the three touches production code, so none re-opens the gates.

### D-QA2 · Do the coverage gaps get tests now, or are they accepted?

**One sentence:** F2 (success-path log entirely unguarded) and F3 (no concurrent-bootstrap test)
are real gaps in T-038's own coverage — add tests now, or accept them?

| Option | What changes | Gate impact |
|---|---|---|
| **A · Add both** *(recommended)* | ~2 assertions on U1/U2 for F2, and one integration case for F3 (I built a working version; `Promise.allSettled` over N clients, assert all fulfilled + exactly 1 group). Test files only; **no production code**. | Loops back to Gate 3, then Gate 4 re-review of test-only changes |
| B · Add F3 only | One integration case. F2 stays a known thin spot. | Same, smaller |
| C · Add F2 only | Two assertions in the existing unit suite. | Smallest loop |
| D · Accept both, commit as-is | Nothing. Behaviour for both is verified correct by my probes, and both are recorded above. | None — commit now |

**Recommendation: A, but B if you want one.** F3 is the higher value of the two: swallowing
`BUSYGROUP` rather than locking is the task's central decision, its justification is
multi-replica startup, and no committed test has more than one caller. Its failure mode — every
replica in a fleet crash-looping at startup — is the worst in the task. F2 is cheap enough to fold
in alongside.

**The honest case for D:** I verified both behaviours correct by execution (8/8 fulfilled / 1 group;
correct log fields from a live worker), the code is right, and neither is a *defect*. If T-039 is
about to rewrite this class to add `XREADGROUP` and `XAUTOCLAIM`, adding tests to it now may be
work you would rather spend on T-039's suite.

**Diff impact:** A, B and C add test files only and re-open Gates 3-4 for test-only review.
D changes the diff not at all. This is a genuine judgement call about regression appetite, not a
correctness question — I am not hiding a defect behind it.
