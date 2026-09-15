# Review — T-043 · Worker graceful shutdown

Base `fc66bd3`. Subject: the uncommitted working tree (10 modified files + the untracked
`docs/plans/t-043-worker-graceful-shutdown.md`). Every `file:line` below was re-derived against
that tree with `grep -n` / `sed -n`; every mutation below was applied, run, and reverted, and
the tree was proved byte-identical afterwards by `md5sum -c`.

## Round 1

**Verdict: CONDITIONAL** — one HIGH and three MEDIUM to fix; the engineering is sound and the
Gate-3 disclosure is accurate. Details under *Required before commit*.

---

## Findings

### HIGH-1 · The quoted measurement in `known-gaps.md` S-26 is wrong for the mutation it names — and the same wrong array is repeated in three code comments

`.claude/rules/known-gaps.md:766-767` states:

> *with the drain removed, the log captured inside the `process.exit` spy held
> `["Created stream consumer group","Shutting down gracefully","Shutdown complete"]` — neither
> teardown line*

Repeated verbatim at `apps/worker-service/tests/stream.consumer.unit.test.ts:1219-1220`,
`:1438-1439` and `:1486-1487`.

**Measured, both ways, by inserting a `console.error(JSON.stringify(logMessagesAtExit))` into the
`process.exit` spy in `tests/index.graceful-shutdown.unit.test.ts` and running `U86`:**

| `stop()` body | `logMessagesAtExit` |
|---|---|
| unmutated (drain present) | `["Created stream consumer group","Shutting down gracefully","Reclaimed pending stream entries","Stream read interrupted by shutdown","Stream consumer loop stopped","Deregistered stream consumer","Shutdown complete"]` |
| **drain removed** (`await this.drain()` gate deleted, `deregisterConsumer()` kept) | `["Created stream consumer group","Shutting down gracefully","Deregistered stream consumer","Shutdown complete"]` — **4 entries** |
| `stop()` reverted to its pre-T-043 body | `["Created stream consumer group","Shutting down gracefully","Shutdown complete"]` — the quoted 3 |

So the quoted array is what the **pre-T-043 `stop()`** produces, not what "the drain removed"
produces. The load-bearing conclusion — *neither teardown line reaches the exit without the
drain* — **is true under both mutations**, which I verified; only the mutation's label is wrong.

Graded HIGH because `.claude/rules/` is designated authoritative and other agents are told to
trust it without re-verification, and the sentence presents itself as a measurement. The remedy
is one line, not a re-think.

**Fix.** At `.claude/rules/known-gaps.md:766`, change *"with the drain removed"* to *"with
`stop()` reverted to its pre-T-043 body"*; or keep the wording and change the array to the
four-entry form above. Apply the identical correction to the three comment copies at
`stream.consumer.unit.test.ts:1219`, `:1438`, `:1487` — they must stay byte-identical (verified
identical today: three blocks at `:1208-1232`, `:1427-1451`, `:1475-1499`, `diff`-clean, three
`S-26` mentions each).

### MEDIUM-1 · An implemented error branch has no test, and the test constant written for it is never used

`apps/worker-service/src/events/stream.consumer.ts:869` — an **unclassified**
`XGROUP DELCONSUMER` rejection logs `logger.error(fields, "Failed to deregister stream
consumer")`. No case reaches it.

`grep -rn "Failed to deregister" apps/worker-service --include=*.ts` returns exactly two lines:
the source above and `tests/stream.consumer.unit.test.ts:198`, where
`LOG_MESSAGE.DEREGISTER_FAILED` is declared. Assertion sites for every sibling constant exist
(`:2109`, `:2188`, `:2210`, `:2241`, `:2265`, `:2300`, `:2378`); `DEREGISTER_FAILED` has none.
An unused constant that names a branch is evidence the case was planned and dropped.

`.claude/rules/testing.md` requires a negative path per branch; `review-standards.md` requires
"all error paths tested". This is the one branch deciding whether a real Redis fault during
shutdown surfaces at ERROR rather than being silently downgraded.

**Fix.** Add `U90` beside `U82`: `mockRedis.xinfo` resolves `consumerInfoRow(OVERRIDE.CONSUMER_NAME,
CONSUMER_PENDING.NONE)`, `mockRedis.xgroup.mockRejectedValue(new Error(TRANSIENT_READ_FAILURE))`,
then assert `await expect(consumer.stop()).resolves.toBeUndefined()` and
`expect(mockLogger.error).toHaveBeenCalledWith({…}, LOG_MESSAGE.DEREGISTER_FAILED)`.

### MEDIUM-2 · `.env.example` ships the shared name as its commented example

`apps/worker-service/.env.example:77` is `#REDIS_CONSUMER_NAME=worker-1`.

The seventeen lines immediately above it (`:59-76`) correctly describe `worker-1` as the value
whose failure mode is permanent, silent, unrecoverable loss of billing events. An operator doing
the standard `cp .env.example .env` and uncommenting gets exactly that hole on the second
replica. This is strictly better than the base (`REDIS_CONSUMER_NAME=worker-1`, uncommented), so
it is not a regression — but the example value still contradicts its own paragraph.

**Fix.** `apps/worker-service/.env.example:77` → `#REDIS_CONSUMER_NAME=<unique-per-instance,
e.g. worker-$(hostname)-$$>`, or drop the value and leave `#REDIS_CONSUMER_NAME=`.

### MEDIUM-3 · Instance-unique names make the registry leak unbounded, where it was bounded at one row — out of scope to fix here

Slice 3 changes `WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_NAME` (`constants.ts:111`) from a
fixed `"worker-1"` to `` `${hostname()}-${process.pid}` ``. A **clean** shutdown now deletes its
own row. An **unclean** exit — SIGKILL, OOM, a timed-out drain, an exit that skips the handler —
leaves a row behind, and the next start uses a new pid, so nothing ever collects it.

Measured: a consumer row persists indefinitely at `pending 0` and is removed only by an explicit
`XGROUP DELCONSUMER` (my re-run of P12 on db 14: `worker-aaa` survived at `pending 0` until
deleted; P8's `dead` row likewise survives `XAUTOCLAIM`). Redis has no TTL on consumer rows.

Before this change the leak was **one** row for the lifetime of the deployment. After it, a
crash-looping worker adds one row per restart, and `parseConsumerReading`
(`stream.consumer.ts:246-289`) walks all of them on every shutdown. Nothing is lost and nothing
is wrong today; the growth is unbounded in the crash-loop case.

Fixing it needs a reaper (a periodic sweep of `XINFO CONSUMERS` deleting rows with
`pending 0` and a large `idle`) — new production behaviour, its own task.

**Recommend adding to `.claude/rules/known-gaps.md`** as the next free id, with the measurement
above and the fix direction, rather than letting it evaporate.

### LOW-1 · The U26/U35 fixture correction downgrades a named assertion failure to a bare runner timeout

`tests/stream.consumer.unit.test.ts:1102-1106` — `readConnection.disconnect` now rejects every
parked read. That is the right model (it matches P14, and the old no-op fake let `U26`/`U35`
reject a parked read *after* `stop()` returned, which the real client cannot do).

**But it changes the failure mode of the mutation those cases exist to catch.** With
`this.readConnection?.disconnect()` deleted from `stop()`
(`stream.consumer.ts:680`), measured on the current tree:

```
× U26 - stop() ends an in-flight read quietly … 5006ms → Test timed out in 5000ms.
× U35 - stop() during startup recovery ends quietly … 5002ms → Test timed out in 5000ms.
```

Both still go red, so coverage is intact — but neither names anything. This is precisely the
defect this file already records for itself at `:1274` ("*mutation failed it by a 5 000 ms
timeout rather than by an assertion (Round 1, L-1)*") and that `U50`/`CASE_BUDGET_MS` exist to
prevent.

Whether the base tree would have failed the same mutation *by assertion* is **not verified** —
reconstructing the base fixture in the working tree was blocked, and I did not force it.

**Fix.** In `U26` (`:1522`) and `U35` (`:1741`), move
`expect(readConnection.disconnect).toHaveBeenCalled()` to immediately after
`await consumer.stop()` and before `await expect(runPromise).resolves…`. With the drain
returning `TIMED_OUT` at 3 000 ms, the assertion then reports inside the 5 000 ms budget.

### LOW-2 · `U83`'s mutation collateral count is wrong: measured 11, not 9

`tests/stream.consumer.unit.test.ts:2312-2315` claims the `if (this.shouldStop()) return;`
mutation at the top of `dispatch`'s per-entry loop "reddens nine cases", listing `U13`, `U15`,
`U19`, `U20`, `U21`, `U29`, `U34`, `U36` (+ `U83`).

Applied that exact mutation to `stream.consumer.ts:1237-1239` and ran the file, twice: **11
failed**. The list omits **`U37`** (`expected [] to deeply equal [ { id: '1789101023800-0', …(1) } ]`)
and **`U70`** (`expected [ { id: … } ] to have a length of 2 but got 1`). `U83`'s own reported
failure matches the comment verbatim (`expected [ '1789101023800-0' ] to deeply equal [
'1789101023800-0', …(2) ]`), so the mutation is the same one — only the count is wrong. This is
S-33's pattern inside a comment written to defend against it.

**Fix.** `:2312` → "*it reddens eleven cases*"; add `U37` and `U70` to the list at `:2314-2315`.

### LOW-3 · Two comment claims about which deadline `U50` and `I30` use are false

- `tests/integration.constants.ts:313` — "*`U50` asserts **this** plus `DRAIN_TIMEOUT_MS` stays
  under `CASE_BUDGET_MS`*", where *this* is `ENTER_DEADLINE_MS` (`:314`, `1_000`). `U50`
  (`tests/stream.consumer.unit.test.ts:2471`) asserts
  `INTEGRATION_LOOP.RUN_DEADLINE_MS + WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS`, i.e. `1_500 + 3_000`.
- `tests/stream.consumer.unit.test.ts:2468` — "*`I30` … waits up to `RUN_DEADLINE_MS` for the
  handler to be entered*". `I30` (`tests/stream.consumer.integration.test.ts:1225`) passes
  `timeout: INTEGRATION_SHUTDOWN.ENTER_DEADLINE_MS`.

Numerically harmless — `1_000 < 1_500`, so the asserted bound is the stronger one and covers
`I30`'s real budget of `1_000 + 3_000`. Both sentences are nonetheless false about what the
code does.

**Fix.** `integration.constants.ts:313` → "*`U50` asserts `RUN_DEADLINE_MS` plus
`DRAIN_TIMEOUT_MS`, which is the stronger bound since `ENTER_DEADLINE_MS` is smaller*".
`stream.consumer.unit.test.ts:2468` → `ENTER_DEADLINE_MS`.

### LOW-4 · "Shutdown duration is bounded by `DRAIN_TIMEOUT_MS`" is not true

`apps/worker-service/src/index.ts:76-77`. After the drain, `stop()` issues `XINFO CONSUMERS`
(`stream.consumer.ts:765-771`) and possibly `XGROUP DELCONSUMER` (`:853-859`) — two round trips
with no timeout of their own. The container client sets `maxRetriesPerRequest: 2`
(`src/config/container.ts:62`), which bounds the *unreachable-Redis* case (the constant docblock
at `constants.ts:396` records 153 ms then 603 ms), but no `commandTimeout` is set, so a
reachable-but-slow server is unbounded.

**Fix.** `index.ts:76` → "*bounded by `WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS` plus the two
deregistration round trips, which are bounded only by the client's `maxRetriesPerRequest: 2`*".
(Adding a `commandTimeout` would be a container change and is out of scope here.)

### LOW-5 · `env.schema.unit.test.ts:25` names a constant that does not exist

The docblock says sourcing the separator from
`WORKER_STREAM_CONSTANTS.CONSUMER_NAME_SEGMENT_SEPARATOR` would be tautological. There is no
such member: the separator is a module-local `const CONSUMER_NAME_SEGMENT_SEPARATOR = "-"` at
`apps/worker-service/src/constants.ts:18`, not exported (`grep -n "export const
CONSUMER_NAME_SEGMENT_SEPARATOR"` → no match), so the test *could not* have imported it. The
reasoning is right; the identifier is wrong.

**Fix.** `:25` → "*the module-local `CONSUMER_NAME_SEGMENT_SEPARATOR` in `src/constants.ts`
(which is not exported, so this file could not source it anyway)*".

### LOW-6 · The plan records three of the five deviations, and R6 is silently violated

`docs/plans/t-043-worker-graceful-shutdown.md:527` — "*Three deviations from the plan*". Five
were made. The two missing from the committed record:

- **R6** (`:458`) says "*`grep -c "S-26"` on the file must stay at 3*". Measured now: **9**
  (`grep -c "S-26" apps/worker-service/tests/stream.consumer.unit.test.ts`). The reasoning
  (3 per copy × 3 copies) is sound and I verified the property R6 actually protects — the three
  blocks are byte-identical, with 3 mentions each. But the plan is the durable record and it
  still asserts 3.
- `DRAIN_TIMEOUT_MS = 3_000` and its `ERROR_BACKOFF_MS` floor. Justified in the constant's
  docblock (`constants.ts:479-498`) and pinned from both sides by `U74` (`:2229`) and `U50`
  (`:2467`); not recorded in the plan.

**Fix.** Update §11's Gate-3 outcome to five deviations, and restate R6 as "the three blocks
must stay byte-identical" rather than as a mention count.

### NIT
- `stream.consumer.ts:771` is 123 characters, against a file that wraps everything else at ~100.
  Wrap the `logDeregistrationFailure(...)` argument list.
- `constants.ts:531-539` — the *"Field names inside one `XINFO CONSUMERS` row"* docblock is
  immediately followed by a second docblock, so it attaches to `NO_PENDING_ENTRIES` (`:541`)
  rather than to the `CONSUMER_INFO_FIELD_*` members (`:542-545`) it describes. Move it below
  `NO_PENDING_ENTRIES`.
- Case order in `tests/stream.consumer.unit.test.ts` is non-monotonic: `U87` (`:2245`), `U89`
  (`:2273`) sit before `U83` (`:2304`), `U88` (`:2342`), `U84` (`:2384`).
- `U89` (`:2286`) writes a bare `13` for `idle` where `OBSERVED_CONSUMER_IDLE_MS = 13` is
  declared in the same file (`:705`); `index.graceful-shutdown.unit.test.ts:79` writes a bare
  `0` for the macrotask delay where the sibling file names it `NEXT_MACROTASK_MS` (`:790`).
  Constants rule applies to tests.
- `.env.example:80-84`'s "*It does NOT add to shutdown time … 205 ms*" paragraph is still true
  but was not given the drain clause that the equivalent `index.ts:72-77` paragraph received.
- Plan's AC citations are off: it cites the epic's AC1/AC2 as `:253`/`:254`; those are the
  snippet's closing lines. The ACs are `docs/epics/epic-7-worker-service.md:257` and `:258`.

---

## Rulings requested by the coordinator

### The five deviations

1. **`loopPromise` not cleared in a `finally` — APPROVED.** Clearing it collapses "never ran"
   into "ran and finished". Verified by mutation: making `drain()` return `COMPLETED` instead of
   `NOT_STARTED` when `loopPromise === null` reddens `U75` alone
   (`expected "spy" to not be called at all, but actually been called 1 times`). The retained
   settled promise holds nothing. The docblock at `stream.consumer.ts:349-372` states it
   accurately.
2. **Absent registry row skips the delete — APPROVED, and it is the better call.** Identical end
   state (`DELCONSUMER` on an unknown name returns `0`, re-measured), one fewer round trip, and
   it closes the R4 window where a peer creates the row between read and delete. `U88`'s own
   recorded mutation reproduces exactly: returning `{ kind: FOUND, pending: 0 }` where
   `parseConsumerReading` returns `ABSENT` gives
   `expected [ [ 'DELCONSUMER', …(3) ] ] to have a length of +0 but got 1`.
3. **`DEFAULT_CONSUMER_NAME` a computed constant, not a builder — APPROVED.**
   `grep -c 'WORKER_STREAM_CONSTANTS\.' apps/worker-service/src/config/env.ts` → **12**, so the
   counted taxonomy at `constants.ts:128-145` stays true and `src/config/env.ts` is textually
   unchanged (`git status` confirms it is not in the diff). `hostname()` and `process.pid` are
   fixed per process, so a lazy default would compute the same value.
4. **`DRAIN_TIMEOUT_MS = 3_000` — APPROVED.** The floor argument holds: a bound at or below
   `ERROR_BACKOFF_MS` (1 000) would time out on every shutdown landing in a failing loop's pause,
   and a timed-out drain suppresses the deregistration. Both sides are asserted, not narrated
   (`U74:2229`, `U50:2467` and `:2471`). Record it in the plan (LOW-6).
5. **R6's `grep -c "S-26"` 3 → 9 — APPROVED on the merits, but the record is wrong.** The
   property R6 protects is drift, and drift is absent: the three blocks are byte-identical with
   three mentions each. Update the plan (LOW-6).

### F1 — where the epic's T-043 divergences get filed

All five re-derived against `docs/epics/epic-7-worker-service.md:242-254` and
`apps/worker-service/src/index.ts:58-105`, and all five hold:

1. `:246` logs before `:247` sets the flag; `index.ts:59-60` sets, then logs.
2. `"Worker shutting down"` (`:246`) vs `"Shutting down gracefully"` (`index.ts:60`).
3. `"Worker shutdown complete"` (`:251`) vs `"Shutdown complete"` (`index.ts:100`).
4. `await bullWorker.close()` (`:248`) — `grep -rn "bullmq" --include=package.json .` and
   `grep -rn "bullWorker\|bullmq" apps packages --include=*.ts` both return nothing.
5. No `try`/`catch`, no `exit(1)`; `index.ts:61` / `:102-104` have both.

Plus: the snippet omits `streamConsumer.stop()` and `app.close()`, and its **File:** line
(`:238`) names only `src/index.ts` while the work lands in `src/events/stream.consumer.ts`.
Unlike the T-041 section (which self-corrects at `:184-202`, per S-32), the T-043 section has no
forward pointer at all — a reader lands on `:242` and never learns it is wrong.

**This is a decision, and it is yours** — the plan argued it both ways and declined to file.

| Option | What changes | Effect |
|---|---|---|
| **A · New id `S-34`** *(my recommendation)* | Adds a `known-gaps.md` entry for the T-043 section, mirroring S-29 (T-040) and S-32 (T-041) | Consistent with the existing precedent; S-29's and S-32's titles are section-scoped, so neither can absorb it without becoming false. Keeps ids stable and citable |
| B · Extend `S-32` | Edits S-32's body and title | Makes S-32's own title ("*T-041 section*") false — the exact objection S-32 records for not folding into S-29 |
| C · Consolidate S-29 + S-32 + T-043 into one entry | Rewrites two existing entries | Cleanest to read, but retires two live ids, which `known-gaps.md`'s stability rule forbids; and it is a docs task with its own review |
| D · File nothing; add a "what T-043 shipped differs" block to the epic at `:255` | Edits `docs/epics/epic-7-worker-service.md` only | Fixes the reader's actual problem at source; but S-32 records that this half-measure is what left T-041's residual open |

**Recommended: A, plus the epic block from D in the same change.** A changes the diff (one
`known-gaps.md` entry); D changes the diff (one epic block); B and C change the diff and rewrite
existing entries. Choosing B or C rather than A is a preference about entry granularity, not
about the finding.

### `bullWorker.close()` as a forward obligation — **not durably recorded**

`grep -rn "bullWorker\|bullmq"` over `.md`/`.ts`/`.json` outside `node_modules` finds it only in
`docs/plans/t-043-worker-graceful-shutdown.md:136-139`, `docs/plans/t-039-stream-consumer-loop.md:217`,
`README.md` (architecture prose), and the epic's own T-042/T-043 sections. It is **not** in
`.claude/rules/known-gaps.md` and **not** stated as an obligation in epic-7's T-042 section
(`:206-234`).

`CLAUDE.md` is explicit that "*nothing may read `docs/plans/` as evidence of completion*", and
S-15 records that the epic files are not a reliable manifest. So the obligation currently lives
only in a file the pipeline is told not to treat as a record. **Recommend** one line in
`docs/epics/epic-7-worker-service.md` under T-042 — "*must re-open `index.ts`'s shutdown handler
to add `await bullWorker.close()` before `streamConsumer.stop()`; T-043 deliberately did not*" —
folded into whichever F1 option is chosen.

---

## The two things you asked me to attack

### 1 · The fixture corrections — no assertion was weakened; one failure *message* was

Verified mechanically: `git diff -U0` over `stream.consumer.unit.test.ts`,
`index.graceful-shutdown.unit.test.ts` and `stream.consumer.integration.test.ts`, filtered to
removed lines containing `expect|toHaveBeen|toEqual|toBe(`, returns **nothing**. Not one
assertion was deleted or re-pointed in those three files.

The one assertion that *was* replaced is in `env.schema.unit.test.ts`, and it is a
strengthening, honestly disclosed at `:145-150`: the old
`toBe(WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_NAME)` compared the parsed default against the
very constant the schema's `.default(...)` reads, so it held whatever that constant said —
including `"worker-1"`. The replacement derives `${hostname()}-${process.pid}` from `node:os`
independently of `src/`, and `U85` (`:204`) adds three named claims with a stated assertion order
and the mutation that forced it.

The residual objection is LOW-1 above: the corrected `disconnect` fake turns the
"`stop()` no longer disconnects" mutation from a named assertion into
`Test timed out in 5000ms`. Coverage intact, diagnosis degraded.

### 2 · The third reply shape, and that the fix is a sibling rather than a widening

**Third shape confirmed.** Re-measured through `redis-cli -n 14` and through ioredis 5.11.1 on
Redis 7.0.15 — all four of the constant's docblock rows (`constants.ts:559-563`) reproduce
exactly, as `ReplyError` with `code === undefined` and `instanceof Error === true`:

```
XINFO CONSUMERS,    key gone   -> ERR no such key
XINFO CONSUMERS,    group gone -> NOGROUP No such consumer group '<g>' for key name '<k>'
XGROUP DELCONSUMER, group gone -> NOGROUP No such consumer group '<g>' for key name '<k>'
XGROUP DELCONSUMER, key gone   -> ERR The XGROUP subcommand requires the key to exist. …
```

`"ERR no such key"` shares a prefix with neither of the other two texts. The three-member list at
`constants.ts:571-575` covers all four situations.

**Sibling, not a widening — confirmed structurally.** `WORKER_STREAM_READ.MISSING_GROUP_ERROR_PREFIX`
is still `"NOGROUP"` at `constants.ts:417`, and the read loop's classifier
`handleReadFailure` (`stream.consumer.ts:987-991`) still matches on it alone. The only line in
the whole `stream.consumer.ts` diff that mentions that constant is a new **docstring**
(`git diff -U0 … | grep -E "^[+-].*MISSING_GROUP_ERROR_PREFIX"` → one `+` line, `:750`). The read
loop's failure classification is untouched.

**And the sibling is load-bearing.** Mutation M7 — replace `GROUP_GONE_ERROR_PREFIXES` with
`[WORKER_STREAM_READ.MISSING_GROUP_ERROR_PREFIX]` in `logDeregistrationFailure`:

```
× U81 - the missing-key XGROUP reply is classified the same way … → expected "spy" to be called with arguments
× U87 - the ERR no such key reply to XINFO CONSUMERS is classified as gone … → expected "spy" to be called with arguments
Tests  2 failed | 51 passed (53)
```

---

## What I verified by execution

**P1 reproduced exactly** on db 14 — the premise the whole task rests on:

```
XREADGROUP -> 2 delivered   XINFO CONSUMERS -> name c1 pending 2
XGROUP DELCONSUMER -> 2     XPENDING -> 0     XINFO CONSUMERS -> []
XAUTOCLAIM … 0 0-0 -> 0-0 (empty)   XREADGROUP … > -> []   XLEN -> 2
```

**P11 / P12 reproduced exactly.** Shared name: A read `pending 0`, B took an entry under the same
name, A's `DELCONSUMER` returned `1` and the entry became unreachable (`XAUTOCLAIM 0-0` empty,
`XLEN` 2). Distinct names: deleting `worker-aaa` returned `0` and left `worker-bbb`'s
`pending 1` untouched. **Both halves of D1 are required; the guard alone is not safe.**

**M3 — the guard, red by the data.** `if (false && reading.pending !== …)` at
`stream.consumer.ts:839`:

```
× I29 … → expected [] to deeply equal [ '1789394056701-0' ]     (the XAUTOCLAIM reachability probe)
× U78 … (unit)
```

The red is the *reachability* assertion, not a call count — exactly as the plan required.

**Gate-3 redness disclosure — accurate.** Reverting `stop()` to its pre-T-043 body and running
the three touched suites:

```
12 unit cases red in stream.consumer.unit.test.ts:
  U73 U74 U76 U77 U78 U80 U81 U82 U87 U88 U89 U84
U86 red; I28 and I30 red.
Not red: U75, U79, U83.
Tests  15 failed | 70 passed (85)
```

That is **exactly** the plan's claim — "12 unit cases confirmed red", "`U86` and `I28`/`I30`
confirmed red", and precisely the three disclosed non-red cases. Honest.

**The three substitute mutations are adequate.** I re-performed each:

| Case | Mutation I applied | Result |
|---|---|---|
| `U75` | `drain()` returns `COMPLETED` instead of `NOT_STARTED` when `loopPromise === null` | `U75` alone red |
| `U79` | `stop()` calls `deregisterConsumer()` regardless of drain outcome | `U79` red (and `U75`) |
| `U83` | `if (this.shouldStop()) return;` at the top of `dispatch`'s per-entry loop | `U83` red by batch contents — but 11 cases red, not the 9 claimed (LOW-2) |

Additional mutations run: M1 (`drain()` gate deleted) → `U73 U74 U75 U79 U84 U86` red, 6/68;
M8 (`ABSENT` → `FOUND pending 0`) → `U88` red with the verbatim message its comment records;
M0 (pre-T-043 `stop()`) as above; and the disconnect-removal mutation for LOW-1.

**Compile-time gate — all 13 packages, `--force`, `0 cached` on every task.**

| Task | Result |
|---|---|
| `npx turbo run typecheck --force` | 13 successful / 13, 0 cached, 9.8 s, exit 0 |
| `npx turbo run lint --force` | 13 successful / 13, 0 cached, exit 0 — **14 warnings, 0 errors** |
| `npx turbo run build --force` | 13 successful / 13, 0 cached, 19.6 s, exit 0 |
| `npx turbo run test --force` | 13 successful / 13, 0 cached, 15.2 s, exit 0 |
| `pnpm test:smoke` | 6 suites, 7 tests, exit 0 |

Per-package tests: analytics 18, auth 164, billing 18, gateway 38, shared-config 4,
shared-logger 4, shared-tracing 2, shared-types 8, shared-utils 18, shared-validation 15,
usage 230, **worker 178 (12 files)**, web `--passWithNoTests`.

**Worker baseline arithmetic checks out:** 157 → 178 = 21 new cases, and exactly 21 new ids exist
(`U73`–`U89` = 17, `I28`–`I31` = 4).

**All 14 lint warnings are pre-existing, proven:**

- `apps/auth-service/tests/auth.service.unit.test.ts` — 10 × `no-misused-promises`;
  `git log -1` → `d68e719`.
- `apps/usage-service/tests/ingestion.service.unit.test.ts` — 4 × `no-unsafe-assignment`;
  `git log -1` → `b0f6921`.
- Neither file appears in `git status --porcelain`.
- `grep -c "no-unsafe-return"` over the lint log → **0**.
- worker-service lint: clean, no output.

**Other re-derivations:** `grep -c 'WORKER_STREAM_CONSTANTS\.' src/config/env.ts` → 12 (taxonomy
intact). `index.graceful-shutdown.unit.test.ts` held **14** `it(` at `fc66bd3` and **15** now,
matching both the `index.ts:78-80` and the `known-gaps.md:836-838` corrections of S-26's stale
`(12)`. The three S-26 comment blocks are byte-identical. `MISSING_GROUP_ERROR_PREFIX` and
`handleReadFailure` unchanged.

**Environment left as found:** `redis-cli -n 14 DBSIZE` → 0, no `probe:rev43:*` keys;
db 0 `XLEN telemetry:events` → 2, zero groups, never written to (its `DBSIZE` moved 3 → 4 during
the gate from auth-service's TTL'd `denylist:*` keys — S-22, pre-existing, not this change).
Every mutated file restored and `md5sum -c` clean against the pre-review snapshot;
`git status --porcelain` matches its starting state exactly.

---

## What I could not verify, and why

- **Whether the base tree failed the "`stop()` no longer disconnects" mutation by a named
  assertion** (LOW-1's counterfactual). Reconstructing the `fc66bd3` fixture required overwriting
  uncommitted test files in the working tree; the action was blocked and I did not force it. The
  *current* behaviour (a 5 000 ms runner timeout) is measured.
- **S-26's inherited tables** — the "3–6 ms whole handler" figure and the block-length table
  (4 of 5 at `STREAM_BLOCK_MS=20`, 0 of 3 at 500, 0 of 1 at 5000). They need nine real SIGTERM
  process runs. The diff correctly labels them inherited-and-unverified in all four places
  (`known-gaps.md:770-773`, and the three comment copies), so the honesty here is adequate — I am
  recording that I did not re-derive them either.
- **`quit()` / `disconnect()` timings** (`index.ts:64-70`: 204 ms and 4 883 ms). Not re-measured;
  a full re-derivation needs a live blocking-read harness. The T-043 numbers are consistent with
  the tree's prior 205 ms / 4 813 ms, and nothing in the change depends on the exact figures.
- **Multi-host hostname collision.** Correctly *not* claimed anywhere: `constants.ts:104-106`,
  `env.schema.unit.test.ts:33-36` and `.env.example:59-76` all scope the property to "unique per
  process on a host". I verified the claim is scoped, not that collisions occur.
- **Behaviour under a real SIGTERM in a container** — no deployment manifests exist in this repo
  (`ls docker-compose*.yml k8s/ deploy/` → nothing), which is also D2's stated reason for the
  drain timeout being a constant. The `DRAIN_TIMEOUT_MS`-vs-grace-period question (plan R3)
  remains untested by construction.
- **Concurrent `stop()` calls.** I reasoned (not measured) that `deregisterAttempted`
  (`stream.consumer.ts:382`) is checked and set synchronously at the top of `deregisterConsumer`
  before any `await`, so two overlapping `stop()` calls cannot both reach `XGROUP DELCONSUMER` on
  a single-threaded loop. `U76` covers the sequential case only.

---

## Remaining risks and dispositions

| # | Risk | Disposition |
|---|---|---|
| 1 | `XGROUP DELCONSUMER` destroys pending entries | **Closed in code**, proved by M3 at the data level (`I29`) and by P1/P11/P12 at the server level. Both halves of D1 shipped |
| 2 | Consumer-registry rows accumulate across unclean restarts | **Open.** MEDIUM-3 — recommend a new `known-gaps.md` id; a reaper is its own task |
| 3 | An operator pins one `REDIS_CONSUMER_NAME` across replicas (plan R4) | **Accepted, cannot be closed in code** — Redis has no conditional delete. Mitigated by the default and `.env.example`; MEDIUM-2 removes the example that invites it |
| 4 | Unclassified deregistration failure logged at ERROR, untested | **Open.** MEDIUM-1 |
| 5 | Shutdown blocks on a slow-but-reachable Redis after the drain | **Accepted, LOW.** `maxRetriesPerRequest: 2` bounds the unreachable case; document it (LOW-4) rather than adding a `commandTimeout` here |
| 6 | S-26 residue: exits that skip the handler, and a timed-out drain | **Correctly kept open** in the retitled entry. Nothing lost in either — nothing is acknowledged before commit |
| 7 | `bullWorker.close()` obligation evaporates when T-042 lands | **Open.** Recorded only in `docs/plans/` today; see the ruling above |
| 8 | S-25: 100 % of this diff is outside coverage collection | **Confirmed as stated** — `src/events/**` and `src/**/index.ts` are excluded, so named cases are the entire signal. This review treated them as such |

---

## Required before commit

1. **HIGH-1** — correct the quoted array (or the mutation's label) at
   `.claude/rules/known-gaps.md:766-767` and, identically, at
   `apps/worker-service/tests/stream.consumer.unit.test.ts:1219-1220`, `:1438-1439`, `:1486-1487`.
2. **MEDIUM-1** — add the `U90` case for `stream.consumer.ts:869`, or delete the unused
   `LOG_MESSAGE.DEREGISTER_FAILED` and state in the review why that branch is untested.
3. **MEDIUM-2** — change `.env.example:77` so the commented example is not `worker-1`.
4. **LOW-2 / LOW-3 / LOW-5** — the three false comment claims, each a one-line edit.
5. **Answer the F1 decision** (options A–D above) and apply the chosen filing, together with the
   `bullWorker.close()` line under T-042.
6. **MEDIUM-3** — agree the new `known-gaps.md` id for the registry-growth gap, or record why not.

LOW-1, LOW-4, LOW-6 and the NITs are recommended but not blocking.

**Verdict: CONDITIONAL.** → Gate 5 (QA) once items 1–4 land; items 5–6 are docs and may be
carried into the same commit.

---

## Round 2

**Verdict: APPROVED FOR COMMIT.** Every Round 1 required item landed and was re-measured here
independently — including all three `stop()` bodies, both `U90` mutations and the three
`.env.example` rows. Four new findings, all LOW/NIT, all one-line edits, **none blocking**; see
*Same finding class, twice* for why they do not warrant a third round.

Base is still `fc66bd3`; nothing committed or staged. Worker is **12 files / 179 tests**
(was 178; the addition is `U90`) — counted from the forced run, not from the hand-off. Every
`file:line` below was re-derived against the current tree; every mutation was applied, run and
reverted, and the tree proved byte-identical afterwards by `md5sum -c` (13/13 `OK`) with
`git status --porcelain` matching its starting state.

---

### Round 1 items — re-verified, not accepted

#### HIGH-1 — **resolved.** All three `stop()` bodies re-measured, not two

Re-instrumented the `process.exit` spy in `tests/index.graceful-shutdown.unit.test.ts:392` with a
`console.error(JSON.stringify(logMessagesAtExit))` and ran `U86` against each body in turn. This
is the finding that was mislabelled once, so all three were run rather than the two asked for:

| `stop()` body | `logMessagesAtExit` measured now |
|---|---|
| shipped | `["Created stream consumer group","Shutting down gracefully","Reclaimed pending stream entries","Stream read interrupted by shutdown","Stream consumer loop stopped","Deregistered stream consumer","Shutdown complete"]` — **7**, both teardown lines present |
| drain gate deleted (`stream.consumer.ts:682-684` removed), `deregisterConsumer()` kept | `["Created stream consumer group","Shutting down gracefully","Deregistered stream consumer","Shutdown complete"]` — **4** |
| reverted to its pre-T-043 body (`git show fc66bd3:…:510-513`) | `["Created stream consumer group","Shutting down gracefully","Shutdown complete"]` — **3** |

All three match `.claude/rules/known-gaps.md:773-777` **verbatim**, including element order. The
load-bearing conclusion — neither teardown line reaches the exit under either mutation — holds
under both, as it did before; the attribution is now correct.

The three scope comments are `diff`-clean against each other: `stream.consumer.unit.test.ts:1208-1246`,
`:1442-1480`, `:1505-1543`, byte-identical, 3 × `S-26` each (9 in the file, which is R6's restated
form). The correction is carried identically in all three.

#### MEDIUM-1 / `U90` — **resolved.** Both mutations re-performed, both exact

The case is at `stream.consumer.unit.test.ts:2507`; the branch it reaches is
`stream.consumer.ts:871` (`logDeregistrationFailure(error, "Failed to deregister stream consumer")`).

- **Delete the `catch` around `XGROUP DELCONSUMER`** (`stream.consumer.ts:856-873`) →
  `Tests 3 failed | 51 passed (54)`, red: `U80`, `U81`, `U90`. `U90`'s message is
  `AssertionError: promise rejected "Error: Reached the max retries per reques…" instead of resolving`
  — the comment's quoted form. The collateral is stated at `:2525-2527` rather than omitted, and
  the count is right.
- **`const gone = error instanceof Error`** in `logDeregistrationFailure`
  (`stream.consumer.ts:898-902`) → `Tests 2 failed | 52 passed (54)`, red: `U82` and `U90` only.
  `U80`, `U81`, `U87` stayed green, exactly as `:2529-2532` claims. This is the half that pins the
  ERROR level, and no sibling case catches it.

`LOG_MESSAGE.DEREGISTER_FAILED` is now asserted. The Round 1 objection is fully discharged.

#### MEDIUM-2 — **resolved, and the implementer's self-refutation is confirmed**

The shipped fix is an empty value at `.env.example:93` (`#REDIS_CONSUMER_NAME=`). Probed against
the real `EnvSchema` (`src/config/env.ts:43`, zod 3.25.76) — all three recorded rows at
`.env.example:86-88` reproduce exactly:

```
""                                                -> REJECTED ["String must contain at least 1 character(s)"]
"worker-1"                                        -> ACCEPTED "worker-1"
"<unique-per-instance, e.g. worker-$HOSTNAME-$$>" -> ACCEPTED verbatim
```

The third row is the implementer's refutation of its own first fix, and it holds: the placeholder
parses through untouched, so two replicas pasting it would share it. Dropping the example value
was the right call and is strictly stronger than the Round 1 suggestion.

`parseEnv` really does throw, not merely `safeParse`-fail:
`Invalid environment configuration for REDIS_CONSUMER_NAME: String must contain at least 1 character(s)`.

**And I checked the one step the rows do not cover** — whether an operator uncommenting the line
actually produces `""` rather than an absent key, which is what the "mechanism rather than a
convention" claim rests on. `process.loadEnvFile()` (the loader at `src/index.ts:7-9`) on a file
containing `REDIS_CONSUMER_NAME=` yields `typeof "string"`, value `""`, `"REDIS_CONSUMER_NAME" in
process.env === true`. So zod's `.default()` does **not** apply and `.min(1)` rejects. The claim
holds end to end.

#### LOW-1 — **resolved.** `expected "spy" to be called at least once`, at ~3 s

Deleting `this.readConnection?.disconnect()` from `stop()` (`stream.consumer.ts:680`) now gives:

```
× U26 - stop() ends an in-flight read quietly … 3070ms → expected "spy" to be called at least once  (:1576)
× U35 - stop() during startup recovery ends quietly … 3004ms → expected "spy" to be called at least once  (:1797)
```

Named assertions, inside the 5 000 ms budget, where Round 1 measured `Test timed out in 5000ms`.

#### LOW-2 — **resolved, and the false universal was found by the implementer, not by me**

The T-043 block banner at `stream.consumer.unit.test.ts:2008-2030` no longer claims "every case
below was confirmed red". Reverting `stop()` to its pre-T-043 body and running the file:

```
Tests  13 failed | 41 passed (54)
red:     U73 U74 U76 U77 U78 U80 U81 U82 U84 U87 U88 U89 U90
not red: U75 U79 U83
```

Exactly the two lists at `:2016-2017`, and 13 + 3 = the 16 cases in the block. Both quoted failure
messages re-derived verbatim:

- `U73` → `AssertionError: expected [ 'stop' ] to deeply equal []`
- `U77` → `Error: xinfo was never called` (thrown by the `xinfoArgs` helper at `:978` — a helper
  that throws on absence rather than passing vacuously, which is the shape `.claude/rules/testing.md`
  asks for)

The separate `U83` collateral count is also fixed. Applying `if (this.shouldStop()) return;` at
`stream.consumer.ts:1244` (top of `dispatch`'s per-entry loop) gives
`Tests 11 failed | 43 passed (54)` and exactly the eleven listed at `:2324-2325` — `U13 U15 U19
U20 U21 U29 U34 U36 U37 U70 U83`. The run line quoted in the comment and in S-33's table row
matches character for character.

#### LOW-3, LOW-4, LOW-5, LOW-6 — **all resolved**

- **LOW-3.** `integration.constants.ts:314-316` now says `U50` asserts `RUN_DEADLINE_MS` plus
  `DRAIN_TIMEOUT_MS` and is the stronger bound; `stream.consumer.unit.test.ts:2606-2612` now names
  `ENTER_DEADLINE_MS` as `I30`'s deadline. Confirmed against the code: `U50`'s assertion is at
  `:2613`, and `I30` passes `timeout: INTEGRATION_SHUTDOWN.ENTER_DEADLINE_MS`
  (`stream.consumer.integration.test.ts:1225`).
- **LOW-4 — confirmed true and sufficient.** `index.ts:80-88` now says "bounded by
  `DRAIN_TIMEOUT_MS` **plus two unbounded round trips**". Verified: `maxRetriesPerRequest: 2` at
  `src/config/container.ts:62`, and `grep -rn "commandTimeout" apps/worker-service/src` returns
  only the two occurrences inside that very comment — there is no `commandTimeout` set anywhere.
  The two trips are `XINFO CONSUMERS` (`stream.consumer.ts:767`) and `XGROUP DELCONSUMER`
  (`:857`), both on `this.redis`, the container client the option applies to. "Two" is an upper
  bound — a timed-out drain makes it zero and an `ABSENT` reading makes it one — which is the
  correct direction for a bound. Accurate and sufficient.
- **LOW-5.** `env.schema.unit.test.ts:26-28` now names the module-local
  `CONSUMER_NAME_SEGMENT_SEPARATOR`. Confirmed: `src/constants.ts:18`, a bare `const`, no
  `export`; used at `:111`.
- **LOW-6.** `docs/plans/…:534` now reads "**Five** deviations"; R6 is restated at `:458` and
  `:554-557` as byte-identity rather than a mention count.

#### NITs — 1, 2, 3, 4 and 5 taken

No line in `stream.consumer.ts` now exceeds 110 characters. The `CONSUMER_INFO_FIELD_*` docblock
now sits below `NO_PENDING_ENTRIES` (`constants.ts:533`, fields at `:542-545`).
`OBSERVED_CONSUMER_IDLE_MS` is used at `stream.consumer.unit.test.ts:2488` and
`NEXT_MACROTASK_MS` at `index.graceful-shutdown.unit.test.ts:95,100`, so the bare `13` and `0` are
gone. `.env.example:96` carries the drain clause. The T-043 block is now id-monotonic
(`U82 U83 U84 U87 U88 U89 U90`); the four remaining non-monotonic points in the file
(`U6` after `U10`, `U11` after `U23`, `U13` after `U27`, `U50` last) are **pre-existing** — the
same four appear in `git show fc66bd3:…` — and `U50` trailing is deliberate, it is the
deadline-collector case.

#### `U85`'s new assertion-ordering claim — re-performed, both mutations exact

Not a Round 1 item, but it is a new mutation claim in the rework, so I ran it.
`env.schema.unit.test.ts:195-202` claims a specific reporting assertion under each of two
mutations to `constants.ts:111`:

- `DEFAULT_CONSUMER_NAME: "worker-1"` → `AssertionError: expected 'worker-1' not to be 'worker-1'`
  at `:219` — the **first** assertion, which is the point of the reorder.
- `DEFAULT_CONSUMER_NAME: hostname()` → `AssertionError: expected 'linuxconfig' to contain '2013090'`
  — i.e. `toContain(String(process.pid))`, matching the comment's `'<pid>'` placeholder form
  (correctly written as a placeholder, since the pid varies per run).

---

### The two new gap entries

#### S-34 — mechanism re-measured on db 14, and the entry does **not** overclaim

Re-ran the sequence myself against Redis 7.0.15, db 14, `CLIENT INFO` showing `db=14`, using
targeted `DEL` of my own probe keys rather than `FLUSHDB`:

```
three "restarts" under host-111 / host-222 / host-333, each acking its entry
  XPENDING total                -> 0
  XINFO CONSUMERS               -> 3 rows, all pending=0
  XAUTOCLAIM … reaper 0 0-0     -> rows still 3            (a reclaim pass reaps nothing)
  idle host-111                 -> 16443 then 18457 after sleep 2   (grows; no TTL)
  XGROUP DELCONSUMER host-111   -> 0                       (destroys nothing at pending 0)
                                -> rows 2
same sequence under the shared name worker-1 -> exactly 1 row
```

Every claim at `.claude/rules/known-gaps.md:1168-1181` reproduces, including the shared-name
comparison and the `DELCONSUMER → 0` return.

**On the question you asked me to rule on — the entry does not imply a performance finding it did
not take.** `:1183-1189` says the costs are that replies grow and `parseConsumerReading` walks
every row, then states plainly: "Neither has been measured at a scale where it matters — **no test
drives a large registry**". It grades itself LOW and ties the growth rate to "one per unclean
exit, zero on a healthy deployment". That is the honest form, and it is the form
`review-standards.md` asks for when the refuting case is expensive to construct. No correction
needed.

The D1 connection at `:1191-1196` is also sound and I re-verified its premise at Round 1 (probes
P11/P12): a shared name makes the pending-zero guard unsound, which is unrecoverable event loss,
against a cosmetic registry. Not grounds to revert.

#### S-35 and the two epic placements — both verified, both durable

All five divergences re-derived against the current tree, and all five hold:

1. Snippet logs at `docs/epics/epic-7-worker-service.md:262` then sets the flag at `:263`;
   `src/index.ts:59` sets, `:60` logs.
2. `"Worker shutting down"` (`:262`) vs `"Shutting down gracefully"` (`index.ts:60`).
3. `"Worker shutdown complete"` (`:267`) vs `"Shutdown complete"` (`index.ts:110`).
4. `await bullWorker.close()` (`:264`) — `grep -rn "bullmq" --include=package.json .` and
   `grep -rn "bullWorker\|bullmq" apps packages --include=*.ts` both return **nothing**, re-run
   here. The line would `await undefined.close()`.
5. Snippet has no `try`/`catch` and no `exit(1)`; `index.ts:61` opens the `try` and `:112-115`
   carry `catch` + `process.exit(1)`.

**Placement 1 — the "What T-043 actually shipped" block** is at `docs/epics/epic-7-worker-service.md:276-308`,
i.e. after the acceptance criteria at `:272-274`, as specified. This matches the existing
precedent: T-041's own correction also follows its snippet (`:184` onward).

**Placement 2 — the `bullWorker.close()` forward obligation** is at `:236-248`, inside the T-042
section (heading `:206`, next heading `:252`), and states the ordering "**before**
`streamConsumer.stop()`". It is now recorded in **two** durable places — the epic and
`known-gaps.md` S-35 `:1247-1258` — where Round 1 found it only in `docs/plans/`, which `CLAUDE.md`
forbids reading as a record. The obligation is durable. Round 1's finding is discharged.

#### S-33's new shape — the generalisation is sound, and it belongs in S-33

**Sound.** The second shape at `.claude/rules/known-gaps.md:1109-1119` — a measurement attached to
the wrong mutation — is not merely compatible with S-33, it is confirming evidence for S-33's own
central thesis. The entry already records at `:1136-1138` that "both failures were in prose rows;
every command-backed row has survived re-derivation at three gates". HIGH-1 is a third prose
failure, with no command in the text to re-run. It generalises correctly, and the stated remedy —
a quoted output must name the exact mutation that produced it, and if two mutations are in play,
run both and quote both — is the right one; the rework applies it in the S-26 table and in all
three comment copies.

**Belongs in S-33, not a new id.** A separate entry would split one mechanism (an unverifiable
claim in a comment, believed and wrong) across two ids. `known-gaps.md` already carries three
sibling entries for one epic file (S-29 / S-32 / S-35) and S-35 itself names that fragmentation as
the finding; a fourth fragmentation would repeat the thing the file complains about.

**The "not catchable by the mechanical checker" caveat at `:1117-1119` is true as stated.** The
checker described at `:1146-1150` extracts and re-runs backticked `grep` commands; S-26's arrays
carry no command, only a claim about which edit was in place. I checked that the caveat is scoped
to re-running commands and does not over-generalise to "unverifiable" — it is not; the shape is
verifiable, just not by that checker. Correctly narrow.

See **R2-3** below for the one consequence the rework did not follow through on.

---

### New findings

#### R2-1 · LOW · S-35's own line citation went stale inside the commit that added the shift

`.claude/rules/known-gaps.md:1215-1216` — "All five re-derived against
`docs/epics/epic-7-worker-service.md:242-254`".

That range no longer contains the snippet. Re-derived: `:242-248` is the **T-042 forward-obligation
block this same change added**, `:250` is a `---`, `:252-254` is the T-043 heading and its
**File:** line. The snippet S-35 is about is at `:258-270` and its acceptance criteria at
`:272-274`. Inserting 14 lines at `:236` pushed everything down by ~16.

Graded LOW, not HIGH, and the distinction matters: all five substantive claims are **true** — I
re-derived each above. Only the pointer is wrong, and the `## T-043` heading is ten lines below
the cited range, so a reader recovers immediately. It is nonetheless a stale citation in the file
`CLAUDE.md` designates authoritative, and it is S-33's exact pattern occurring two entries below
S-33, in the same commit.

**Fix.** `.claude/rules/known-gaps.md:1215-1216` → `docs/epics/epic-7-worker-service.md:258-274`.

#### R2-2 · LOW · the plan's AC1/AC2 citations went stale by the same 16 lines

`docs/plans/t-043-worker-graceful-shutdown.md:341` cites AC1 as epic `:257` and `:342` cites AC2 as
epic `:258`. Those were correct when Round 1 asked for them (Round 1 NIT: "the ACs are `:257` and
`:258`"). The T-042 block then moved them. Measured now: `sed -n '257p;258p'` returns a blank line
and the snippet's opening ```` ```ts ```` fence; the ACs are at `:273` and `:274`.

**Fix.** `docs/plans/…:341` → epic `:273`; `:342` → epic `:274`.

Note both R2-1 and R2-2 have the same root cause, and the durable fix is the one S-33 already
proposes — not a third manual pass over the numbers.

#### R2-3 · LOW · S-33's title no longer covers what S-33 now documents

`.claude/rules/known-gaps.md:1092` — "**Counts in comments go stale inside the commit that changes
them**".

The second shape added at `:1109` is neither a count nor stale: the S-26 array was wrong the
moment it was written, and it is a quoted measurement, not a numeral. The entry body is right and
the placement is right (see above), but an agent grepping this file for the wrong-mutation shape
will not find it under that title — which is the specific failure mode `CLAUDE.md` creates by
telling agents to trust these files without re-verification.

**Fix.** `:1092` → "**S-33 · Claims in comments are wrong in ways no tool checks — stale counts,
and measurements attached to the wrong mutation — LOW, open**", or any wording that puts the
second shape in the title.

#### R2-4 · NIT · "Read this before the snippet, not after" sits after the snippet

`docs/epics/epic-7-worker-service.md:278`. The instruction is sound but the block is at `:276`,
below the snippet at `:258-270`. A reader going top-down still meets the snippet first — which is
the precise hazard S-35 `:1238-1241` says the block exists to remove.

Placement matches T-041's precedent, so this is a NIT rather than a finding, and moving it would
make the two sections inconsistent. **Fix (optional):** either move the block above the snippet in
both sections, or reword `:278` to "The snippet above is wrong in five ways; this block is the
correction."

---

### Same finding class, twice — and why this is not a third round

Round 1's HIGH-1, LOW-2, LOW-3, LOW-5 and the plan-citation NIT were all one class: **a claim or
citation in a comment, plan or authoritative rule file that is inaccurate about the code it
describes.** R2-1, R2-2 and R2-3 are the same class again, now at LOW and NIT rather than HIGH.

I am recording that explicitly rather than opening a third round on it. The substance is
converging — every Round 1 item is discharged and independently re-measured, the two mislabelled
measurements are now correct, and the remaining three are line numbers and an entry title. A third
review pass would find the fourth instance of the same thing, which is evidence that the fix is
mechanical, not procedural: **S-33's proposed CI checker (`:1146-1150`) is the actual remedy**, and
it is already filed with a scope and a self-match caveat. Recommend it be picked up as its own
task rather than being re-litigated per commit.

One thing worth naming as a positive, because it is the opposite failure mode: the implementer
refuted **two** of its own claims by testing them this round — the `.env.example` placeholder
(measured to parse verbatim, so the first fix was withdrawn) and the T-043 banner's "every case
below was confirmed red" (false, replaced with explicit red / not-red lists). Both were found by
the implementer, not by this review. That is the behaviour the standards ask for.

---

### Compile-time gate — all 13 packages, `--force`, `0 cached` on every task

| Task | Result |
|---|---|
| `npx turbo run typecheck --force` | **13 successful / 13**, 0 cached, 9.599 s, exit 0 |
| `npx turbo run lint --force` | **13 successful / 13**, 0 cached, 26.338 s, exit 0 — **14 warnings, 0 errors** |
| `npx turbo run build --force` | **13 successful / 13**, 0 cached, 15.752 s, exit 0 |
| `npx turbo run test --force` | **13 successful / 13**, 0 cached, 18.180 s, exit 0 |
| `pnpm test:smoke` | 6 suites, all `Test Files 1 passed`, exit 0 |

Per-package tests: analytics 18, auth 164, billing 18, gateway 38, shared-config 4, shared-logger 4,
shared-tracing 2, shared-types 8, shared-utils 18, shared-validation 15, usage 230,
**worker 179 (12 files)**, web `--passWithNoTests`. Worker 178 → 179 is `U90` and nothing else.

**All 14 lint warnings are pre-existing, proven — and there are zero `no-unsafe-return`:**

- `apps/auth-service/tests/auth.service.unit.test.ts` — 10 × `no-misused-promises`;
  `git log -1` → **`d68e719`** (2026-08-25).
- `apps/usage-service/tests/ingestion.service.unit.test.ts` — 4 × `no-unsafe-assignment`;
  `git log -1` → **`b0f6921`** (2026-08-31).
- Neither file appears in `git status --porcelain`, so neither is in this diff.
- `grep -c "no-unsafe-return"` over the full lint log → **0**.
- worker-service lint: clean, no output.

(The raw log greps to 16 `warning` matches; two are the `✖ N problems` summary lines. The
individual count is 14, enumerated above.)

---

### Environment left as found

- **db 0 untouched.** `XLEN telemetry:events` → **2**, `entries-added` → **2**, stream `groups`
  field → **0** (`XINFO GROUPS` returns an empty reply — the bare newline, confirmed by `od -c`).
  Never written to. `DBSIZE` moved 3 → 4 during the gate, from one additional `denylist:*` key;
  all three such keys carry TTLs (218 s, 8 s, 851 s) and self-expire — **S-22, pre-existing, not
  this change**.
- **db 14 ends `DBSIZE 0`.** My S-34 probes used targeted `DEL` of `probe:s34:*` keys, not
  `FLUSHDB`; `CLIENT INFO` was checked to contain `db=14` before writing. No `FLUSHDB` was issued
  by me at all.
- **Postgres:** `Event` → 0 rows, `UsageLine` → 0 rows.
- **Tree byte-identical.** `md5sum -c` over all 13 changed files → 13 × `OK`; `git status
  --porcelain` matches its starting state exactly. Files mutated and restored during this round:
  `src/events/stream.consumer.ts` (five separate mutations), `src/constants.ts` (two),
  `tests/index.graceful-shutdown.unit.test.ts` (one instrumentation). One scratch test file was
  created under `apps/worker-service/tests/` for the env probe and deleted.

---

### What I could not verify, and why

- **S-26's inherited block-length table and the "3–6 ms whole handler" figure.** Not re-derived by
  me either — they need nine real `SIGTERM` runs of `node --import tsx src/index.ts` against a live
  Redis, and no such harness exists in this repo. See the ruling below.
- **S-34's cost at scale.** The mechanism is measured (by the implementer and again by me); the
  consequence of a large registry on `XINFO CONSUMERS` latency or on `parseConsumerReading` is
  not, by anyone. See the ruling below.
- **`quit()` / `disconnect()` timings** (`index.ts:64-70`: 204 ms and 4 883 ms). Not re-measured
  this round; unchanged from Round 1's position. Nothing in the change depends on the exact
  figures.
- **Multi-host `hostname()` collision.** Correctly *not* claimed anywhere — `constants.ts:104-106`,
  `env.schema.unit.test.ts:31-34` and `.env.example:59-76` all scope the property to "unique per
  process on a host". I verified the claim is scoped, not that collisions occur.
- **Behaviour under a real SIGTERM in a container.** No deployment manifests exist in this repo, so
  the `DRAIN_TIMEOUT_MS`-vs-grace-period question (plan R3) remains untestable here by
  construction.
- **Concurrent `stop()` calls.** Still reasoned, not measured: `deregisterAttempted`
  (`stream.consumer.ts:382`) is read and set synchronously before any `await` in
  `deregisterConsumer` (`:754-758`), so two overlapping `stop()`s cannot both reach
  `XGROUP DELCONSUMER` on a single-threaded loop. `U76` covers the sequential case only. **Labelled
  as inference, not execution.**

---

### The two rulings you asked for

#### 1 · S-26's inherited tables — **acceptable as marked. Do not re-derive or remove before commit.**

Four reasons, in order of weight:

1. **They are not load-bearing for anything T-043 claims.** The T-043 conclusion is the three-body
   log measurement, and I re-derived all three independently of the block-length table. The
   comments say so at `stream.consumer.unit.test.ts:1244-1246`: "none of them is load-bearing for
   the claim above".
2. **They were true measurements of the pre-T-043 code, and T-043 does not invalidate them** — it
   narrows their scope to the *undrained* residual path, which is precisely why S-26 stays open.
   Deleting them would remove the only evidence about the path the entry now exists for.
3. **The labelling is consistent and complete.** "inherited and were not re-derived here" /
   "inherited-and-unverified for the current tree" appears in exactly four places —
   `known-gaps.md:784-786` and the three byte-identical comment blocks. I counted them; there is no
   unlabelled copy.
4. **`review-standards.md` prescribes exactly this.** "If the refuting case is expensive to
   construct, say the claim is unverified rather than asserting it." Nine real SIGTERM process runs
   against a live Redis is that case.

**Condition attached, non-blocking:** the label is now the load-bearing part. If anyone edits those
numbers, the label must move with them or be discharged by a real re-run.

#### 2 · S-34's cost at scale — **acceptable as filed. Do not block on it.**

The entry measures the mechanism and explicitly declines the consequence, naming the gap in its own
text (`:1187-1189`). That is the correct shape: asserting "the registry degrades `XINFO CONSUMERS`"
without a benchmark would be the S-33 failure this same commit is correcting. Measuring it would
mean building a registry-growth benchmark inside a graceful-shutdown task, and the fix it would
inform — a reaper — is already scoped to its own task at `:1198-1202`. Accept as filed, at LOW.

---

### Remaining risks and dispositions

| # | Risk | Disposition |
|---|---|---|
| 1 | `XGROUP DELCONSUMER` destroys pending entries | **Closed in code.** Both halves of D1 shipped; re-proved at Round 1 by M3/`I29` and by probes P1/P11/P12 |
| 2 | Consumer-registry rows accumulate across unclean restarts | **Filed as S-34**, mechanism re-measured here. Reaper is its own task |
| 3 | An operator pins one `REDIS_CONSUMER_NAME` across replicas | **Mitigated as far as code can.** Default is instance-unique; `.env.example` now ships an empty value that fails startup. Residual is an operator deliberately setting a shared literal |
| 4 | Unclassified deregistration failure logged at ERROR, untested | **Closed.** `U90`, both mutations re-performed |
| 5 | Shutdown blocks on a slow-but-reachable Redis after the drain | **Accepted, LOW, now documented accurately** at `index.ts:80-88`. A `commandTimeout` is a container change |
| 6 | S-26 residue: exits skipping the handler, and a timed-out drain | **Correctly kept open.** Nothing is acknowledged, so nothing is lost in either |
| 7 | `bullWorker.close()` obligation evaporates when T-042 lands | **Closed.** Now in the epic's T-042 section and in S-35 |
| 8 | S-25: this diff is outside coverage collection | **Unchanged.** Named cases are the entire signal; this review treated them as such |
| 9 | Stale line citations in authoritative files | **Open, LOW** — R2-1, R2-2. Durable fix is S-33's checker, not another manual pass |

---

### Verdict

**APPROVED FOR COMMIT.**

R2-1, R2-2, R2-3 and R2-4 are recommended one-line edits and are **not blocking**; fold them into
the same commit if convenient. No re-review is required for them, and no third round should be
opened on this finding class — see *Same finding class, twice*.

Recommend, separately from this task: pick up **S-33's mechanical checker** as its own task. Two
review rounds have now spent most of their findings on claim and citation accuracy, and the entry
that describes the problem already contains a scoped, implementable fix.

---

## Round 3 — final

**Verdict: CONDITIONAL.** Two MEDIUM edits required, both in
`.claude/rules/known-gaps.md`, both two-line corrections of statements that are false as
written. Everything else below is recommended. Nothing loops back to Gate 3: no production
line, no test and no assertion needs to change, and the engineering is confirmed sound for the
third time.

Base is still `fc66bd3`; nothing committed or staged. Worker is **12 files / 179 tests**,
counted from my own forced run. Every `file:line` below was re-derived against the current
tree — the QA-1/QA-2 edits moved them again. Every claim marked *measured* was produced by a
command I ran in this round; claims resting on reasoning are labelled as such.

---

### Findings

#### MEDIUM-1 · S-36's three `CASE_BUDGET_MS` precedents are all miscited, and each pointer resolves to a real finding about something else

`.claude/rules/known-gaps.md:1275` — "the per-case budget this package has already tripped over
three times (**T-039 L-1, T-041 M-6, T-041 F-3**)".

The count is right; all three attributions are wrong. Re-derived by reading each cited document:

| Cited | What is actually there | The instance it should have cited |
|---|---|---|
| T-039 **L-1** | `docs/reviews/t-039-stream-consumer-loop.md:251` — `U29` reddens by a 5 006 ms timeout. A *cousin* (a case failing illegibly), not a deadline constant above the budget | T-039 **M-6** — `docs/reviews/t-039-stream-consumer-loop.md:632`, `RUN_DEADLINE_MS: 10_000` against a 5 000 ms per-case timeout |
| **T-041** M-6 | `docs/reviews/t-041-retry-tracking-dead-letter.md:176` — the `DEAD_LETTER_STREAM === REDIS_STREAM_NAME` collision guard. Unrelated | T-039 **F-3** — `docs/qa/t-039-stream-consumer-loop.md:279`, `BLOCK_MS_LONG` at 5 000 = the budget |
| **T-041** F-3 | `docs/qa/t-041-retry-tracking-dead-letter.md:375` — `readRetryCount`'s NaN guard coverage. Unrelated | **T-040/S1** — the `RUN_DEADLINE_MS + BLOCK_MS_LONG = 6 000` sum in `I12`; see `docs/reviews/t-040-event-usageline-processor.md:340` |

The correct list is tabulated **inside this same package, by this same change's neighbour**:
`apps/worker-service/tests/integration.constants.ts:23-25` reads *"`RUN_DEADLINE_MS` at 10 000
(Gate-4 Round 2), `BLOCK_MS_LONG` at 5 000 (Gate-5 QA F-3), and the pair of them summing to
6 000 in `I12`"* — all three from the T-039/T-040 trail, none from T-041.

**Why this is MEDIUM and not the LOW that Round 2 gave R2-1.** R2-1 was a line range 16 lines
off, with the `## T-043` heading visible from the cited range — self-recovering. These three
pointers land on *real findings with the right-looking ids about different subjects*, in a file
`CLAUDE.md` designates authoritative and instructs other agents to trust without
re-verification. A reader who follows them finds text and stops, having confirmed nothing.

**Fix.** `.claude/rules/known-gaps.md:1275` → `(T-039 M-6, T-039 F-3, T-040/S1 — tabulated at
`apps/worker-service/tests/integration.constants.ts:23-25`)`.

#### MEDIUM-2 · S-34 says the registry cost has never been measured; it was measured at Gate 5 of this very task — **supersedes Round 2's ruling on S-34**

`.claude/rules/known-gaps.md:1189-1191` — "The costs are that `XINFO CONSUMERS` replies grow,
and `StreamConsumer`'s `parseConsumerReading` walks every row on every shutdown. **Neither has
been measured at a scale where it matters** — no test drives a large registry".

The second clause is still true. The first is now false. QA measured both at 10 000 registry
rows (`docs/qa/t-043-worker-graceful-shutdown.md` §10): `XINFO CONSUMERS` **26 ms**,
`parseConsumerReading`'s worst-case walk **2.6 ms**, and recommended annotating S-34 with them
"so the question is closed rather than left open". The annotation was not applied.

**Re-derived independently this round**, because I am citing it as fact: 10 000 consumers
created on db 14 with `XGROUP CREATECONSUMER` via `redis-cli --pipe` (`errors: 0, replies:
10000`; `XINFO CONSUMERS … | grep -c '^name'` → `10000`), then five timed reads —
**28 / 27 / 22 / 20 / 28 ms**, each *including* `redis-cli` process startup, so the command
itself is under QA's 26 ms. Probe key deleted; db 14 back to `DBSIZE 0`.

**This supersedes Round 2's ruling** (*"S-34's cost at scale — acceptable as filed. Do not
block on it."*). That ruling was correct when it was made: nobody had measured it, and
`review-standards.md` prescribes saying so rather than asserting. Gate 5 then measured it. An
entry that says "not measured" about a thing measured in the gate the same commit just passed
is the S-33 shape, one entry above S-33's own successor.

**Fix.** `.claude/rules/known-gaps.md:1189-1191` → keep "no test drives a large registry", and
replace "Neither has been measured at a scale where it matters" with the two figures and their
source, e.g. *"Measured at Gate 5 of T-043 and re-derived at Gate 6: at 10 000 rows
`XINFO CONSUMERS` costs ~26 ms and the parser's worst-case walk ~2.6 ms — negligible at a scale
far beyond what an unclean-exit leak reaches outside a crash loop. What is still unmeasured is
the consequence over real time; no test drives a large registry."*

#### LOW-1 · The QA-1 rewrite still contradicts its own measurement, two sentences later, in all three copies

QA-1 was right and the correction is a real improvement — the false universal *"would time out
every time"* is gone from all three sites, and the refuting measurement is now disclosed at each.
What survives is the summary clause around it.

All three still say a bound **at or below** `ERROR_BACKOFF_MS` makes the timeout
"liable"/"common", and then state that **at** equality it essentially never times out:

- `apps/worker-service/src/constants.ts:482-484` ("A bound at or below that makes a shutdown
  during a *failing* loop **liable to** time out") against `:489-494` ("at a bound *equal* to
  `ERROR_BACKOFF_MS` it essentially never times out … a bound at or below the backoff makes the
  timeout **common** rather than impossible").
- `apps/worker-service/tests/stream.consumer.unit.test.ts:2103-2110`, same two clauses.
- `docs/plans/t-043-worker-graceful-shutdown.md:548-556`, same two clauses.

**QA's measurement re-derived independently**, as the coordinator asked — my own harness, not
QA's: `StreamConsumer` driven with an always-rejecting `xreadgroup` so the loop sits in
`backOff()`, `WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS` varied at runtime (the object is `as const`,
not `Object.freeze`d, so no tracked file was touched), stop issued at four offsets into the
1 000 ms pause, real timers:

```
bound=3000 offset=20/120/400/800  -> stop took 961/861/580/180 ms, timedOut=false ×4
bound=1000 offset=20/120/400/800  -> stop took 959/860/581/181 ms, timedOut=false ×4
bound=500  offset=20/120/400      -> stop took 501/501/500 ms,     timedOut=TRUE  ×3
bound=500  offset=800             -> stop took 180 ms,             timedOut=false
```

QA-1 reproduces exactly, including "3 of 4 at 500 ms". The mechanism is `bound < (backoff −
offset)`, so at equality the window is **zero-width** and the timeout count is 0/4, not
"common". The summary clause is therefore still wrong at the "at" endpoint it explicitly
includes.

**Not blocking**, and deliberately graded below the two MEDIUMs: the refuting measurement sits
in the same paragraph at every site, so no reader is left holding the false belief — they are
left holding a paragraph that disagrees with itself. And the **test pins the right inequality
already**: `stream.consumer.unit.test.ts:2111` is `toBeGreaterThan(ERROR_BACKOFF_MS)`, strict,
which is exactly the honest form. Only the prose is affected.

**Fix, identically in all three (they are currently consistent — keep them so).** Replace the
"at or below" framing with what was measured: *"A bound **below** `ERROR_BACKOFF_MS` times out
whenever the stop lands in the first `(backoff − bound)` ms of a failing loop's pause — 3 of 4
sampled offsets at 500 ms. At equality the margin is zero-width rather than negative, so it
does not time out but leaves nothing for anything the loop does after the pause resolves.
3 000 clears the pause entirely at every offset sampled."*

#### LOW-2 · The drain's rejection arm is implemented, documented, and pinned by no test — and it is cheaper to close than S-36

`apps/worker-service/src/events/stream.consumer.ts:709-712`. The docstring at `:692-694` makes
an explicit behavioural claim — *"A **rejected** loop counts as completed: it has finished,
which is the only question this method asks."* Nothing tests it.

**Measured, not inferred.** Mutation: the `onRejected` arm at `:711`,
`() => DRAIN_OUTCOME.COMPLETED` → `() => DRAIN_OUTCOME.TIMED_OUT`. Full worker suite:
**`Test Files 12 passed (12)` · `Tests 179 passed (179)`** — not one case red. Mutation
reverted; `md5sum -c` → `OK`.

The branch is reachable: `run()` retains the raw `runLoop()` promise (`:538-539`) and catches
only its own `await`, so `this.loopPromise` is a genuinely rejected promise when `runLoop`
rejects — e.g. `this.redis.duplicate()` throwing, which sits outside `runLoop`'s `try`.

The mutated direction is fail-closed (a rejecting loop would simply skip deregistration), so
this is a coverage-alignment finding rather than a defect — which is why it is LOW.

**And it is the cheap one.** I built the case to make sure the recommendation is concrete:
a consumer whose `duplicate()` throws resolves `stop()` in **0 ms** and still issues
`["DELCONSUMER", stream, group, name]`, with no drain warning — no fake timers, no wall clock,
no live Redis. Recommended as `U91` alongside `U75`, or folded into S-36's scope if the
coordinator would rather not widen the diff. Contrast S-36's live case at 4 000–4 500 ms; see
the ruling below.

#### LOW-3 · The plan's header and gate checklist are stale by two gates

- `docs/plans/t-043-worker-graceful-shutdown.md:4` — "**Gate:** 1 (Task Planner) · **Status:**
  awaiting approval", while §12 (`:759`) records Gate-2 approval on 2026-09-14 and §11 records
  Gate-3 and the Gate-4 rework complete. Unlike §12's approval text, the header is not marked
  as historical.
- `:521` "Gate 4 · Round 2 (scoped re-review)" and `:522` "Gate 5 · QA · Gate 6 · final review
  …" are both **unticked**, though Round 2 returned `APPROVED FOR COMMIT` and QA returned
  `PASS`.

`CLAUDE.md` forbids reading `docs/plans/` as evidence of completion, which caps the harm — but
this plan is going into the commit, and its own front matter says the task is awaiting
approval to start.

**Fix.** `:4` → "**Gate:** 6 (Senior Reviewer, final) · **Status:** Gates 1–5 complete"; tick
`:521` with Round 2's verdict; add a Gate-5 row carrying QA's `PASS` and QA-1..QA-3 with their
dispositions.

#### NIT-1 · S-34 states the shared-name residual at P11's width; `deleteConsumerIfIdle` states it at QA's narrower one

`.claude/rules/known-gaps.md:1196-1199` says a shared name "made T-043's pending-zero guard
unsound: two instances under one name share one row, so the guard reads one instance's zero
while the other holds work, and the delete then destroys it". That is an accurate description
of probe P11, and P11 is a raw-command sequence.

QA drove the **shipped class** and corrected it downward: the naive ordering (peer reads before
our `XINFO`) is *caught* — `QA shared-name loss occurred: false` — and loss requires the peer's
read to land between `XINFO CONSUMERS` and `XGROUP DELCONSUMER`, a two-round-trip window.

`stream.consumer.ts:804-806` already states it at that width ("a peer can create the row and
take an entry **between the read and the delete**"), so the two sites now disagree in precision.
Plan R4 (`docs/plans/…:456`) has the same looseness. **Fix:** add QA's measured narrowing to
S-34 — it strengthens the entry, since the guard turns out to help more than S-34 credits.

#### NIT-2 · QA-2's rewrite carries two figures for one interval, and left an orphaned line

`apps/worker-service/tests/stream.consumer.unit.test.ts:1088-1096`. The site now says the read
rejected "at **t = 204 ms measured from the read**, i.e. **~4 ms** after the disconnect" and
then cites Gate 5's direct measurement of the same interval as **0-2 ms**. The ~4 ms is
arithmetic — 204 minus the *nominal* 200 ms `setTimeout`, which is when the disconnect was
scheduled, not when it was issued — so it is the weaker of the two numbers for the same thing.
QA-2's substance is fixed and the fixture is correctly left alone; keep only the measured
interval.

Also cosmetic, same block: the edit left `"… that would model an interval nothing measured. A"`
as a line ending in a one-word orphan, with the sentence resuming on the next comment line.

#### NIT-3 · S-36 and S-26 describe the same code path and do not reference each other

S-26 (`.claude/rules/known-gaps.md:780-784`) keeps itself open partly for "a drain that hits its
timeout — that path logs the truncation and exits without the teardown lines, by design". S-36
is about that same path lacking a live regression guard. Neither cross-references the other.
One `see also` each, so a reader arriving at either has the whole picture.

---

### The rulings the coordinator asked for

#### 1 · Is S-36 the right disposition, or should the live case be written? — **S-36 is right. Do not write it here.**

Four reasons, strongest first, with the `CASE_BUDGET_MS` history re-derived rather than taken
from S-36's (miscited — MEDIUM-1) summary of it:

1. **The live case would carry the thinnest margin in the file, and its failure mode is the
   illegible one.** Re-derived: `CASE_BUDGET_MS` is 5 000
   (`tests/integration.constants.ts:34`), `RUN_DEADLINE_MS` 1 500 (`:265`), `ENTER_DEADLINE_MS`
   1 000 (`:321`), `DRAIN_TIMEOUT_MS` 3 000 (`src/constants.ts:506`). A hung-handler case
   spends an entry-arrival wait **plus** the full 3 000 ms bound: 4 000 ms at
   `ENTER_DEADLINE_MS`, 4 500 at `RUN_DEADLINE_MS` — which is precisely the sum `U50` pins at
   `stream.consumer.unit.test.ts:2621`. If that margin is ever lost, the case reports
   `Test timed out in 5000ms`, naming nothing.
2. **That is the defect this package has fixed three times**, and all three were the same
   arithmetic: `RUN_DEADLINE_MS` 10 000 > 5 000 (T-039 M-6), `BLOCK_MS_LONG` 5 000 = 5 000
   (T-039 F-3), and the 6 000 `I12` sum that neither per-constant fix looked at (T-040/S1).
   Adding a 4 500 ms case as the last act before a commit, on a machine whose loaded behaviour
   nobody has measured — QA explicitly lists `I30`'s timing under CI load as unverified — is
   the shape that produced all three.
3. **It is not covering a defect.** QA verified the behaviour live, on a real worker under a
   real `SIGTERM`: the drain bounded at **3001 ms** under real timers, the row retained, the
   entry still pending and still reachable. What is missing is a *regression* guard, which is a
   smaller claim than the one needed to widen a change that has now cleared three reviews.
   S-21 is the precedent this repo already chose for exactly this shape.
4. **S-36 names the right trigger and forbids the wrong fix** — "any change to the drain's
   timing semantics", "if `CASE_BUDGET_MS` is ever raised, this is the first case to add", and
   "do not close this by loosening `U79`". I checked `U79` against that instruction: it plants
   a row reporting `pending 0` (`stream.consumer.unit.test.ts:2217-2220`), so the suppression
   it observes **must** come from the timeout rather than from the count, and it asserts
   `xinfo` was **not called at all** (`:2236`). It asserts the right thing. The instruction is
   sound.

**One correction to S-36's own framing**, separate from MEDIUM-1: it says the live case "pushes
against `CASE_BUDGET_MS`" qualitatively, where QA said it was "affordable". Both are defensible
because neither states the number. It is 4 000–4 500 against 5 000 — affordable *and* the
tightest in the file. Worth stating numerically in the entry so the next reader does not have
to re-derive it, as I just did.

**If the coordinator wants one more test in this task, LOW-2 is the one to take, not S-36's.**
It costs 0 ms of wall clock, needs no live Redis, and closes a branch that is currently
documented and unpinned — measured above.

#### 2 · Release readiness — nine ACs, regressions, breaking change

**All nine ACs hold.** I re-derived AC9 structurally myself rather than accepting QA's:
`git diff fc66bd3 -- apps/worker-service/src/index.ts` adds **zero** and removes **zero**
non-comment lines, and `void streamConsumer.run()` sits unchanged at `index.ts:197`. The other
eight are covered by named cases that QA mutation-tested and Round 2 re-measured; I re-verified
the two that carry the data-loss property (`I29` at
`stream.consumer.integration.test.ts:1133`, which asserts **reachability** before `XPENDING`
and orders its assertions weakest-last, and `U79`) and the two universals in the guard's
docstrings (below).

**Regression surface across the other 12 packages: nil, re-verified.** `git diff --name-only
fc66bd3` touches `apps/worker-service/**`, `docs/**` and `.claude/rules/known-gaps.md` only —
no `packages/**` file. The full forced gate is green on all 13 (table below).

**Breaking change: the default `REDIS_CONSUMER_NAME` moves from `worker-1` to
`<hostname>-<pid>`. What an operator upgrading a running deployment gets — measured on db 14,
not reasoned:**

```
pre-upgrade instance reads 2 entries as worker-1, exits without acking
  XINFO CONSUMERS          -> name worker-1 pending 2 idle 6

new instance boots as linuxconfig-99999
  XREADGROUP GROUP g1 linuxconfig-99999 … >   -> (empty)      <- '>' never redelivers
  XAUTOCLAIM … linuxconfig-99999 0 0-0        -> both entries returned
  XINFO CONSUMERS          -> name linuxconfig-99999 pending 2 idle 6
                              name worker-1        pending 0 idle 29
  XPENDING                 -> 2 … linuxconfig-99999 2
```

So, precisely:

- **No data loss, and nothing needs an operator action.** The old `worker-1` PEL is recovered
  by the new instance's `XAUTOCLAIM` pass, which reclaims from *any* name over the idle
  threshold. The threshold at shipped defaults is `STREAM_BLOCK_MS × RECOVERY_IDLE_MULTIPLIER`
  = **10 000 ms** (`stream.consumer.ts:1079`), and T-041's cadence makes this ongoing rather
  than startup-only — so the cost is up to ~10 s plus one block of redelivery latency, once,
  for whatever the old instance held at the moment it stopped.
- **The old `worker-1` row is permanent.** Nothing reaps it: `deleteConsumerIfIdle` only ever
  passes `this.consumerName` (`stream.consumer.ts:858-863`), and Redis has no TTL on a consumer
  row. Every upgrade therefore leaves exactly one orphan — the first instance of S-34's leak,
  guaranteed rather than contingent on an unclean exit. It is cosmetic (`pending 0`, nothing
  stranded) and an operator can remove it with
  `XGROUP DELCONSUMER telemetry:events worker-group worker-1`.
- **It does not affect the new instance's guard.** The guard reads its own name only, and
  `U77` plants a live peer row holding work precisely so a guard reading "the first row" or a
  group-wide total would fail there.
- **An operator who has pinned `REDIS_CONSUMER_NAME=worker-1` explicitly is unaffected by the
  default change** — and is still in plan-R4's residual, now narrowed to the two-round-trip
  window (NIT-1).
- **One startup-contract change worth a line in the deploy notes:** `.env.example:93` now ships
  `#REDIS_CONSUMER_NAME=` with an empty value, and `z.string().min(1)` rejects `""` at module
  load. An operator who copies `.env.example` and uncomments that line now gets a **refusal to
  start** where the old file gave them a silently shared `worker-1`. That is the right
  direction and Round 2 verified it end to end through `process.loadEnvFile()`, but it is
  operator-visible.

**Release-note call:** `docs/releases/` holds two entries, both for changes with an ordered
deploy step (a migration, a role swap). T-043 has neither, so the existing precedent does not
require one. The upgrade behaviour above is worth recording, and **S-34 is its natural home** —
two sentences there rather than a new artifact. Recommended, not required.

#### 3 · Coverage alignment — what is untested that matters, beyond S-36

The diff is 100 % outside coverage collection (`src/events/**` and `src/**/index.ts` excluded;
S-25), so named cases are the whole signal, and I treated them as such. Walking every branch
the diff adds against the case list:

| Branch | Pinned by |
|---|---|
| `drain()` null loop → `NOT_STARTED` | `U75` (QA mutation 3 reddens it) |
| `drain()` fulfilled → `COMPLETED` | `U73`, `U84`, `I30` |
| **`drain()` rejected → `COMPLETED`** | **nothing — LOW-2, measured** |
| `drain()` timeout → `TIMED_OUT` + WARN | `U74`; suppression by `U79`; **no live sibling — S-36** |
| `deregisterAttempted` re-entry | `U76` |
| `XINFO` throws | `U82` |
| `UNREADABLE` (pending not a number) | `U89` |
| `ABSENT` | `U88` |
| `pending !== 0` | `U78`, `I29` |
| delete succeeds | `U77`, `I28`, `I30` |
| delete throws, classified gone | `U80`, `U81`, `U87` |
| delete throws, unclassified → ERROR | `U90` |
| instance-unique default | `U85` + the rewritten T-037 pair |
| AC1 mid-batch | `U83` (QA's isolating mutation 5 reddens exactly 3, `U83` the only one whose subject it is) |

**Two gaps, and only one matters.** LOW-2 is the real one. The other is
`parseConsumerReading`'s two structural `UNREADABLE` exits — reply not an array (`:244`), row
not an array (`:249`) — which no case reaches by name; I did not raise them, because every
`parseConsumerReading` exit except `FOUND(0)` declines the delete, so a mutation *between* them
changes no observable behaviour and the outcome `U89` pins is the same one. Stated as reasoning,
not measurement: I did not mutate those two.

Nothing else in the diff is implemented-and-untested. No error path added by this change lacks
a case.

#### 4 · Dispositions

| Item | Disposition |
|---|---|
| **S-34** | **Accept as filed, with MEDIUM-2 corrected before commit.** The mechanism reproduced at Round 2 and at QA; the leak is real, bounded-to-unbounded is the honest characterisation, and D1/B is the right trade — a cosmetic registry against unrecoverable billing-event loss. Two edits: the measured cost figures (MEDIUM-2, required) and QA's narrowing of the shared-name residual (NIT-1, recommended). Reaper stays its own task. |
| **S-35** | **Accept as filed.** All five divergences re-derived at Round 2 and re-confirmed at QA; `bullWorker` still exists nowhere in the workspace. Both durable placements verified by me this round against re-derived line numbers: the pointer sits at `epic-7-worker-service.md:258-260`, **above** the snippet at `:262-274`; the correction block at `:280`+, after the ACs at `:277-278`. R2-1's stale range is fixed — `known-gaps.md:1215` now reads `:262-278`, which is exact. **R2-4 is discharged**: the "read this before" instruction is now a pointer above the snippet, not only a note below it. |
| **S-36** | **Accept as filed, with MEDIUM-1 corrected before commit.** Right disposition (ruling 1), right trigger, right prohibition on loosening `U79`. Two edits: the three miscited precedents (required) and the numeric margin, 4 000–4 500 against 5 000 (recommended). |
| **S-26 residual** | **Correctly kept open, and correctly narrowed.** The three scope comments remain byte-identical — re-derived: `stream.consumer.unit.test.ts:1208-1246`, `:1442-1480`, `:1505-1543`, `diff`-clean, 3 × `S-26` each (9 in file), which is R6's restated form. The inherited-and-unverified label on the block-length table is still attached and still honest. **Interaction with S-36:** the two describe the same timed-out path from opposite sides and do not cross-reference (NIT-3). **Interaction with S-34:** S-34 already names a timed-out drain as one of the four unclean exits that leak a row, so the drain's timeout is now cited by three entries — consistent in all three, which I checked. |
| **S-33** | **Open, and its scope should be widened before anyone builds it.** See ruling 5. |
| **S-25** | **Unchanged.** 100 % of this diff is outside coverage collection; no percentage moved and none should be read as evidence. Named cases were the whole signal at all three rounds. |
| **Round 1 items** | All discharged at Round 2 and none regressed: I re-confirmed `U90` exists at `:2515`, `U26`/`U35`'s ordering assertions, `.env.example:93`'s empty value, and the plan's "Five deviations". |
| **Round 2 items** | **R2-1 fixed** (`known-gaps.md:1215` → `:262-278`, exact). **R2-2 fixed** (plan `:341`/`:342` → epic `:277`/`:278`; re-derived `sed -n '277p;278p'` = the two AC lines). **R2-3 fixed** (S-33's title at `:1092` now carries "and measurements attached to the wrong mutation"). **R2-4 discharged** by the pointer at `:258-260`. |
| **QA-1 / QA-2 / QA-3** | QA-1's substance **verified by my own re-derivation** and applied at all three sites; residual wording at LOW-1. QA-2 applied correctly, fixture untouched as it should be; residual at NIT-2. QA-3 taken as option B (S-36) — ruled correct. |

#### 5 · Three rounds, one class — converging in severity, not in incidence

**Severity is converging.** Round 1: one HIGH, three MEDIUM, six LOW. Round 2: four, all
LOW/NIT. Round 3: two MEDIUM, three LOW, three NIT — and **both MEDIUMs are in text that did
not exist at Round 2**. No Round 1 or Round 2 finding has regressed; every one I re-checked is
discharged. On the substance, the change has been stable across two rounds and a QA gate.

**Incidence is not converging, and the shape of that is worth naming precisely.** Each editing
pass that fixes a claim introduces roughly one new claim defect *in the text it just wrote*:
Round 1's HIGH-1 fix was clean, but the same rework's S-35 citation went stale inside it (R2-1);
QA-1's fix introduced an internally self-contradicting paragraph (LOW-1); S-36's authoring
introduced three miscitations (MEDIUM-1); QA's own recommendation went unapplied and turned a
true sentence false (MEDIUM-2). The generator is prose that cites things, and it produces at a
rate proportional to prose edited. **A fourth round would find a fifth instance**, and I am not
opening one, per Round 2's reasoning and the coordinator's instruction.

**But S-33's checker as currently scoped would have caught none of this round's findings, and
that should be recorded before someone builds it.** S-33 (`known-gaps.md:1146-1150`) describes
extracting and re-running backticked `grep` commands. MEDIUM-1 is a cross-document citation of
a *finding id* in another task's review — no command to re-run. MEDIUM-2 is a claim about
whether a measurement exists anywhere. LOW-1 is a paragraph disagreeing with itself. LOW-3 is a
front-matter status field. The checker is still the right direction and the right next task —
it would have caught R2-1, R2-2 and this round's line-number work — but **its scope note should
be widened to cross-document id citations** (`T-0NN <id>` resolving to a heading in
`docs/reviews/` or `docs/qa/`), which is mechanically checkable and is the single highest-yield
addition. Recommend that be added to S-33 when it is picked up; it is a scope note, not work
for this task.

---

### Compile-time gate — all 13 packages, `--force`, `0 cached` on every task

| Task | Result |
|---|---|
| `npx turbo run typecheck --force` | **13 successful / 13**, 0 cached, 10.691 s, exit 0 |
| `npx turbo run lint --force` | **13 successful / 13**, 0 cached, 31.076 s, exit 0 — **14 warnings, 0 errors** |
| `npx turbo run build --force` | **13 successful / 13**, 0 cached, 22.02 s, exit 0 |
| `npx turbo run test --force` | **13 successful / 13**, 0 cached, 22.166 s, exit 0 |
| `pnpm test:smoke` | 6 suites, every one `Test Files 1 passed (1)`, exit 0 |

Per-package tests, from the forced run: analytics 18, auth 164, billing 18, gateway 38,
shared-config 4, shared-logger 4, shared-tracing 2, shared-types 8, shared-utils 18,
shared-validation 15, usage 230, **worker 179 (12 files)**, web `--passWithNoTests`. Worker's
per-file split is unchanged from QA's: `stream.consumer.unit` 54, `stream.consumer.integration`
17, `event.processor.integration` 14, `index.graceful-shutdown.unit` 15, `env.schema.unit` 40,
and the seven smaller files.

**The 14 warnings are pre-existing — proven, not asserted, and re-proven this round:**

- `apps/auth-service/tests/auth.service.unit.test.ts` — 10 × `no-misused-promises`;
  `git log -1` → **`d68e719`** (2026-08-25).
- `apps/usage-service/tests/ingestion.service.unit.test.ts` — 4 × `no-unsafe-assignment`;
  `git log -1` → **`b0f6921`** (2026-08-31).
- `git diff --name-only fc66bd3 | grep -E "auth.service.unit|ingestion.service.unit"` → no
  match. Neither file is in this diff.
- `grep -c "no-unsafe-return"` over the full lint log → **0**, as expected.
- worker-service lints clean, zero warnings.

The stderr noise inside worker's run (`Reached the max retries per request limit`, `EACCES`,
`load failure`) is the expected output of deliberately-failing negative cases (`U8`, T-074's
env-file resilience) and is pre-existing.

---

### What I verified by execution this round

- **Full forced gate + smoke**, above. Nothing replayed: `0 cached` on all four tasks.
- **QA-1 re-derived from scratch** with my own harness — 12 measurements across three bounds and
  four offsets, table under LOW-1. QA's numbers reproduce, including "3 of 4 at 500 ms" and
  "essentially never at equality".
- **The drain's rejection arm is untested** — mutation at `stream.consumer.ts:711`, full suite
  179/179 green, then reverted and `md5sum -c` → `OK`.
- **The rejection arm's real behaviour** — a consumer whose `duplicate()` throws: `stop()`
  returns in 0 ms and still issues `["DELCONSUMER", …]`, no drain warning. This is what makes
  LOW-2's recommended case concrete.
- **The upgrade path**, on db 14 with `redis-cli`: `worker-1` orphan PEL recovered by the new
  name's `XAUTOCLAIM`, `>` returns nothing, the `worker-1` row persists at `pending 0`.
  Transcript under ruling 2.
- **S-34's cost at 10 000 rows** — 10 000 consumers created, `XINFO CONSUMERS` timed five times
  at 20–28 ms including CLI startup. Corroborates QA's 26 ms.
- **MEDIUM-1's three miscitations** — each cited document read at the cited id.
- **R2-1 / R2-2 / R2-3 / R2-4** — all four re-derived against current line numbers.
- **AC9 structurally** — `index.ts` adds and removes zero non-comment lines; `void
  streamConsumer.run()` at `:197`.
- **Startup ordering intact** — `index.ts` statically imports only `@telemetry/shared-tracing`
  and `./startup.constants` before `initTracing(...)` at `:18`; `constants.ts` (which now
  imports `node:os`) is reached through the dynamic imports at `:40` and `:44`.
- **Two universals in the new docstrings, both hold.** "The **only** site in this file that
  issues `XGROUP DELCONSUMER`" — `grep` over `apps/worker-service/src` finds exactly one
  executable use, `stream.consumer.ts:859`; every other match is a comment. And "the type is
  not exported … `TS2459` if one tried" — I tried: a scratch module importing `ConsumerReading`
  produced `error TS2459: Module '"./events/stream.consumer.js"' declares 'ConsumerReading'
  locally, but it is not exported.` Exactly the cited code. Probe deleted.
- **Clean-code gate.** Every non-comment line the diff adds to `src/` is a named constant or an
  import — no bare literal reaches the new code. `"NOGROUP"` appears **once** as an executable
  string in the whole service (`constants.ts:417`); `GROUP_GONE_ERROR_PREFIXES` references that
  constant rather than copying it. `CONSUMER_NAME_SEGMENT_SEPARATOR` is module-local.
  **No finding.**
- **Tenant isolation and injection: no surface.** The diff adds **zero** database calls
  (`git diff fc66bd3 -- apps/worker-service/src | grep '^+' | grep -iE 'prisma|\$queryRaw|findMany'`
  → empty), so no tenant predicate, no `withTenant`, no raw SQL is in scope. The Redis commands
  it adds take ioredis argument lists, not concatenated strings, and every value in them
  (`streamName`, `groupName`, `consumerName`) is env-derived, never caller-supplied. I still
  confirmed the runtime role rather than assuming: `select current_user, rolsuper,
  rolbypassrls` → `telemetry_app|f|f`.

### What I could **not** verify, and why

- **That the only changes since QA are the described comment edits.** Nothing is committed or
  staged, so there is no QA-time revision to diff against. What I can say: the aggregate moved
  from QA's recorded `2588 insertions` to `2634` (+46, consistent with S-36's ~28 lines plus
  the four wording sites), the test count is unchanged at 179, and I read each named site. That
  is corroboration, not a diff — stated as such.
- **S-36's live case, by construction.** Ruling 1 is the argument for not building it; I did
  not build it, so I have not measured what it would actually cost on this machine under load.
- **S-26's inherited block-length table, the "3-6 ms whole handler" figure, and `U25`'s "three
  turns, not one".** Unchanged from Round 2's position: nine real `SIGTERM` runs and a
  microtask trace, no harness exists, none load-bearing for this diff. Still correctly labelled
  inherited-and-unverified at all four sites.
- **Multi-host hostname collision.** Cannot be falsified from one machine. I re-confirmed the
  claim is *scoped* to "unique per process on a host" everywhere it appears, which is the
  verifiable part.
- **Behaviour under an orchestrator's grace period (plan R3).** No deployment manifests exist
  in this repository, so `DRAIN_TIMEOUT_MS` against a real `terminationGracePeriodSeconds` is
  untestable here.
- **Concurrent `stop()` calls.** Still reasoning, not execution, as at Round 2:
  `deregisterAttempted` is read and set synchronously before any `await`, so two overlapping
  `stop()`s cannot both reach the delete on a single-threaded loop. `U76` covers the sequential
  case only.
- **`parseConsumerReading`'s two structural `UNREADABLE` exits.** Not mutated — see ruling 3
  for why I judged the mutation uninformative rather than skipped it.

---

### Environment left as found

- **db 0 never written to.** `XLEN telemetry:events` → **2**, `entries-added` → **2**,
  `XINFO GROUPS` → empty (1 byte, the bare newline). `DBSIZE` is 3: the stream plus two
  `denylist:*` keys carrying TTLs of 740 s and 680 s, written by auth-service's suite during
  the forced `test` run — **S-22, pre-existing, self-expiring, not this change**.
- **db 14 ends `DBSIZE 0`**, `KEYS '*'` empty. Both probe keys (`probe:r3:upgrade`,
  `probe:r3:scale`) removed with targeted `DEL`; **I issued no `FLUSHDB` at all**.
- **Postgres:** `Event` → 0 rows, `UsageLine` → 0 rows.
- **Tree byte-identical.** One production mutation (`stream.consumer.ts:711`), reverted and
  confirmed by `md5sum -c` → `OK`. Three scratch files created and deleted
  (`tests/zz-r3-qa1-probe.test.ts`, `tests/zz-r3-reject-probe.test.ts`,
  `src/zz-r3-ts-probe.ts`). `git status --porcelain` matches its starting state exactly: 11
  modified, 3 untracked, and `git diff --stat fc66bd3` still reports
  `11 files changed, 2634 insertions(+), 75 deletions(-)`. The QA-1 harness varied
  `DRAIN_TIMEOUT_MS` on the runtime object rather than in the file, so `src/constants.ts` was
  never edited.
- **The stray worker from an earlier session (pids 184521/184537, db 12) was left running**, as
  instructed. It is on db 12; every measurement above is on db 14 or db 0, so it cannot have
  influenced one.

---

### Remaining risks and dispositions

| # | Risk | Disposition |
|---|---|---|
| 1 | `XGROUP DELCONSUMER` destroys pending entries | **Closed in code.** Guard + instance-unique name; both halves necessary, both present. Re-proved at three gates by mutation and live `SIGTERM` |
| 2 | An operator pins one `REDIS_CONSUMER_NAME` across replicas | **Mitigated as far as code can.** Residual is the two-round-trip window (QA-measured); `.env.example` now fails startup rather than shipping the shared literal. NIT-1 asks S-34 to state the narrower width |
| 3 | Registry rows accumulate, one per unclean exit, plus one guaranteed on upgrade | **S-34**, LOW. Reaper is its own task. MEDIUM-2 + NIT-1 + the upgrade note are the edits |
| 4 | The `TIMED_OUT` path has no live regression guard | **S-36**, LOW, ruled correct. MEDIUM-1 is the required edit |
| 5 | The drain's rejection arm is untested | **New, LOW-2.** Fail-closed direction, so not a defect; cheapest case in the file if the coordinator wants it closed now |
| 6 | S-26 residue — exits that skip the handler, and a timed-out drain | **Correctly open.** Nothing is acknowledged on either path, so nothing is lost |
| 7 | Claim/citation accuracy in authoritative files | **Open, and the only reason this round is CONDITIONAL.** Two required edits; durable fix is S-33's checker with a widened scope (ruling 5) |
| 8 | S-25: the whole diff is outside coverage collection | **Unchanged.** Named cases are the signal; ruling 3 walks every branch against them |

---

### Required before commit

Two edits, both in `.claude/rules/known-gaps.md`, both two lines, neither touching code or
tests:

1. **MEDIUM-1** — `:1275`: replace `(T-039 L-1, T-041 M-6, T-041 F-3)` with
   `(T-039 M-6, T-039 F-3, T-040/S1 — tabulated at
   `apps/worker-service/tests/integration.constants.ts:23-25`)`.
2. **MEDIUM-2** — `:1189-1191`: replace "Neither has been measured at a scale where it matters"
   with QA's two figures (26 ms / 2.6 ms at 10 000 rows, re-derived at Gate 6), keeping "no test
   drives a large registry" and the unmeasured-over-real-time caveat.

Recommended in the same commit, none blocking: **LOW-1** (the three "at or below" clauses),
**LOW-3** (the plan's header and two checklist rows), **NIT-1**, **NIT-2**, **NIT-3**, and the
upgrade paragraph in S-34.

**LOW-2 is a decision, not a required fix** — see below.

---

### Decision for the user — LOW-2, the untested rejection arm

> **The drain treats a rejected loop as completed. That is documented, correct, and pinned by
> no test — mutating it leaves 179/179 green. Close it now, or record it?**

| | Option | What changes | Diff? |
|---|---|---|---|
| **A** *(recommended)* | **Add `U91`** — a consumer whose `redis.duplicate()` throws; assert `stop()` still issues `DELCONSUMER` and logs no drain timeout | One unit case, **0 ms** of wall clock, no live Redis, no fake timers. Closes the branch while the context is fresh | **Yes** — one test file |
| **B** | **Fold it into S-36**, which already covers the drain's other untested path | One paragraph in `known-gaps.md`. Both drain gaps then live under one id and one trigger | **Yes** — `known-gaps.md` only |
| **C** | **Leave it** | Nothing. An implemented, documented branch stays unpinned and uncited | No |

**I recommend A.** It is the cheapest test in this package — measured, not estimated — and
unlike S-36's case it carries no `CASE_BUDGET_MS` exposure at all, which was the entire reason
S-36 was recorded rather than written. B is defensible and consistent with how QA-3 was
handled; it is the right choice if the coordinator's priority is that nothing further enters a
diff that has cleared three reviews. **C is not recommended** — it leaves a claim in a
docstring with nothing behind it, which is the class all three rounds have been spent on.

**A and B both change the diff; C does not. None of the three changes production behaviour.**

---

### Verdict

**CONDITIONAL.**

The engineering is sound and I am not asking for another look at it: the guard, the drain, the
identity change and their tests have now survived two review rounds, a QA gate with live
`SIGTERM` verification of both guard branches, and this round's independent mutations. The
condition is the two false statements in `.claude/rules/known-gaps.md` — the one file
`CLAUDE.md` tells other agents to trust without re-verification — and both are two-line edits
that need no re-review. Apply them, take the recommended edits if convenient, answer the LOW-2
decision, and commit.

Do **not** open a fourth review round on claim accuracy. The substance converged two rounds
ago; what has not converged is the rate at which editing prose introduces new prose defects,
and the remedy for that is S-33's checker with the widened scope in ruling 5 — as its own task,
not another manual pass.
