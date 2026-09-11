# Review — T-039 · Stream consumer loop (worker-service)

Base `b558641`. Subject: the uncommitted working tree. Reviewer: Senior Reviewer, read-only.
Nothing in this file was applied to the tree; every mutation cited was reverted and the tree
proved byte-identical afterwards (`md5sum -c` over all 12 touched/adjacent files, plus
`git status --porcelain` matching the review-start snapshot exactly).

## Round 1

**Verdict: CONDITIONAL** — five required fixes (H-1, M-1, M-2, M-3, M-5), two decisions for the
user (§Decisions), and eight lower-severity findings with dispositions. No tenant-isolation or
injection finding: this task opens no database connection, derives no tenant context, and
issues no SQL. The loop's core behaviour is genuinely guarded — ten independent mutations were
re-performed and every one reddened a named case.

---

### BLOCKER

None.

---

### HIGH

#### H-1 · "`run()` resolves rather than rejects" is a false universal, and it is the stated reason the rejection is discarded

`apps/worker-service/src/index.ts:113-114`:

> `run()` resolves rather than rejects -- every read failure is handled inside the loop -- so there
> is no rejection for the discarded promise to swallow.

and `apps/worker-service/src/events/stream.consumer.ts:381-382`:

> Resolves rather than rejects. A read failure is handled inside the loop; there is no failure
> mode here that a caller could act on, and `index.ts` starts this with `void`.

**Refuted by execution, two ways.** A throwaway probe suite constructed a `StreamConsumer` and
asserted `run()` does not reject:

```
× P-A: run() rejects when duplicate() throws        → expected true to be false
× P-B: run() rejects when the injected predicate throws → expected true to be false
```

Both rejection paths are outside `run()`'s `try`: `const readConnection = this.redis.duplicate();`
at `stream.consumer.ts:397` and the `this.shouldStop()` call at `:383`, which invokes the
caller-supplied predicate. `parseReadReply`/`parseClaimReply` are total and `readBatch`,
`recoverPendingEntries` and `dispatch` each catch, so the *read-failure* half of the claim is
true — but the sentence that justifies the `void` is the stronger one, and it is false.

This is not hypothetical: the plan's own §11 checklist records observing it — *"The T-038 mock
also emitted 8 unhandled rejections once `run()` was wired (`duplicate is not a function`) while
still reporting 10 passed"*. The refuting case was in hand and the universal was written anyway,
which is the exact failure mode `.claude/rules/review-standards.md` § *Universals Must Cite Their
Mutation* exists to catch.

Production consequence, stated at the likelihood I can defend: `void streamConsumer.run()` at
`index.ts:120` discards the promise, so any rejection becomes an unhandled rejection, which Node
≥ 15 terminates the process on by default. Today the only live trigger is
`ioredis.duplicate()` throwing, which I did not reproduce against a real client and rate
unlikely. The cost is in front of us, not behind: T-040 replaces the handler argument and will
read this comment as licence not to attach a `.catch()`.

**Fix (either, not both required):**
1. Make the claim true — move `:383`'s `shouldStop()` and `:397`'s `duplicate()` inside a
   `try`/`catch` that logs and returns, so `run()` genuinely cannot reject; or
2. Weaken both comments to what was measured and attach the guard at the call site:
   ```ts
   void streamConsumer.run().catch((error: unknown) => {
     container.logger.error(
       { error: error instanceof Error ? error.message : String(error) },
       "Stream consumer loop crashed"
     );
   });
   ```

Option 1 is preferable — it removes the claim's exposure rather than documenting it — and should
carry a unit case constructing with a throwing `duplicate`.

---

### MEDIUM

#### M-1 · A graceful `stop()` during startup recovery logs at **error** level, contradicting AC8

`apps/worker-service/src/events/stream.consumer.ts:600-609`. `isShutdownInterrupt` is consulted
in `readBatch` (`:475`) and nowhere else, so the same `Connection is closed.` that produces a
quiet `info` line during the read loop produces `logger.error(..., "Failed to reclaim pending
stream entries")` when it lands on an in-flight `XAUTOCLAIM`.

**Verified by probe**, not reasoned: a consumer whose recovery paginates, `stop()`ed between
pages, with the second page rejected `Connection is closed.`:

```
× P-C: shutdown during startup recovery logs at error level
  AssertionError: expected [ [ { streamName: 's', …(3) }, …(1) ] ] to deeply equal []
  +     "Failed to reclaim pending stream entries",
```

AC8 is *"A read interrupted by shutdown ends quietly: no unhandled rejection, no error-level
log"*. It holds for `readBatch` and not for the recovery pass, and no case covers the recovery
path. On a worker restarting with a non-trivial pending list this fires an ERROR on every deploy
— a false alarm in precisely the window T-043 will widen.

Second, smaller half of the same defect: `recoverPendingEntries` never re-checks `shouldStop()`
between pages (`:589-616`), so after a stop is requested recovery keeps paginating up to
`RECOVERY_MAX_PAGES` (10 000 entries at the default batch size). It does not delay shutdown —
`index.ts`'s `shutdown` never awaits `run()` — but the loop keeps working after being told not to.

**Fix:** classify in the recovery `catch` exactly as `readBatch` does, and add a `shouldStop()`
guard at the top of the pagination loop:
```ts
} catch (error) {
  if (this.isShutdownInterrupt(error)) {
    this.logger.info(
      { streamName: this.streamName, groupName: this.groupName, consumerName: this.consumerName },
      "Pending-entry recovery interrupted by shutdown"
    );
  } else {
    this.logger.error(/* existing fields */);
  }
}
```
plus a unit case mirroring `U26` on the recovery path. See §Decisions D-1 for scope.

#### M-2 · `firstReadSettled()` is constant-`false`; `U25`'s assertion on it can never fail

`apps/worker-service/tests/index.graceful-shutdown.unit.test.ts:153`, `:157`, `:239`, and the
assertion at `:378`.

`grep -n readSettled` over the file returns exactly three lines: the initializer
`let readSettled = false;` (`:153`), the only other assignment `readSettled = false;` (`:157` —
inside a `new Promise(() => {…})` executor that never resolves), and the accessor at `:239`. A
variable initialized `false` whose only assignment writes `false` cannot be `true`, so
`expect(context.firstReadSettled()).toBe(false)` at `:378` is a tautology under every possible
implementation.

The cost is the comment at `:149-152`, which presents this flag as the mechanism:

> It also makes "the listener bound while the first read was still outstanding" an observable
> fact (`U25`) rather than a race the test hopes for

The named mechanism does not work. The property *is* actually established, by a different
assertion — `expect(context.appListen).toHaveBeenCalledTimes(1)` — which I confirmed reddens on
the `void` → `await` mutation (10 cases red, U25 among them). So `U25` is not vacuous; the flag
is, and the comment credits the wrong line.

**Fix:** make the flag real or delete it. Real:
```ts
const readXreadgroup = vi.fn(() => {
  const pending = new Promise(() => undefined);
  void pending.then(
    () => { readSettled = true; },
    () => { readSettled = true; }
  );
  return pending;
});
```
and drop `readSettled = false;` from the executor. If it is deleted instead, the comment at
`:149-152` must lose the "observable fact" sentence and credit `appListen`.

#### M-3 · `hasParkedRead()` matches `CLIENT LIST` server-wide, not database 14 — and T-039 itself creates the connection that will defeat it

`apps/worker-service/tests/stream.consumer.integration.test.ts:530-538`. The docstring says
*"Whether any connection on the reserved database is parked on a blocking read"*; the body runs
`CLIENT LIST` and tests `list.includes("cmd=xreadgroup")`. `CLIENT LIST` is **server-wide**.

**Measured.** With a blocking `XREADGROUP` parked on database **13** and nothing parked on
database 14:

```
CLIENT LIST | grep -c 'cmd=xreadgroup'            → 1
CLIENT LIST | grep 'cmd=xreadgroup' | grep -o 'db='→ db=13
CLIENT LIST | grep 'db=14' | grep -c 'cmd=xreadgroup' → 0
```

So the predicate is satisfied by a connection in another logical database. The in-case comment
at `:751-754` — *"Only this suite's connections use database 14, and none of the other cases
reads"* — guards the wrong thing; the exposure was never bounded by database 14.

Why this matters more after T-039 than before: the reviewer's own environment already shows an
unrelated long-lived client on `db=12` (age 71 986 s, `cmd=xgroup|create`). Once this change
ships, a worker dev process parked on `XREADGROUP BLOCK 5000` — the normal steady state — makes
`I12`'s `vi.waitFor(hasParkedRead)` return on the first poll, `stop()` fires before the subject's
own read is parked, and `I12` then passes while measuring nothing about interrupting a live
block. That is not an inverted signal, but it is a case that silently stops testing its subject
under a condition this change makes likely.

**Fix:** require both tokens on the same row.
```ts
return list
  .split("\n")
  .some(
    (line) =>
      line.includes(INTEGRATION_LOOP_COMMANDS.CLIENT_LIST_BLOCKED_READ) &&
      line.includes(`db=${INTEGRATION_REDIS.LOGICAL_DB_INDEX}`)
  );
```
The row format printed above confirms `db=<n>` and `cmd=<x>` share a row, so this discriminates.
Correct the docstring at `:530` and the comment at `:751-754` in the same edit.

#### M-4 · `buildDefaultMessageHandler` — the production path — has no test

`apps/worker-service/src/events/stream.consumer.ts:178-187`. `index.ts:103-108` constructs with
four arguments, so the **default** handler is what a deployed worker runs today.

`grep -rn 'no processor is wired yet\|Received stream entry' apps/worker-service/tests/` → no
match. Every unit case passes `messageHandler` (`:515`); the integration loop cases pass
`options.handler` (`:475`); the six bootstrap-only sites never call `run()`. D2-A — the user's
Gate-2 answer, *"injected handler, default logs and does not acknowledge"* — has its injected
half covered and its default half unexercised.

The code is five lines of logging, so the correctness risk is small. The gap is that the one
behaviour a T-039 deployment exhibits is the one nothing asserts, including the negative that
matters: that the default logs the entry **id only** and never the field payload (the docstring
at `:174-176` claims this, and `U29` asserts it for the *failure* log, not for the default
handler). See §Decisions D-2.

**Fix:** one unit case — construct without a handler, deliver one entry, assert
`logger.info` received `{ streamName, groupName, entryId }` with that message, and assert no
`error` log and that the payload string is absent from every log call.

#### M-5 · Seven inline log-message literals beside an existing `LOG_MESSAGE` object — required constants gate

`apps/worker-service/tests/stream.consumer.unit.test.ts`. The file already defines
`LOG_MESSAGE` at `:118-123` and the T-038 cases use it (`:257`, `:262`, `:277`, `:281`, `:338`,
`:366`). The T-039 cases write the literals inline:

| Line | Literal | Note |
|---|---|---|
| `:709`, `:739`, `:889`, `:962` | `"Stream read failed"` | four copies |
| `:812` | `"Failed to reclaim pending stream entries"` | |
| `:922` | `"Stream entry handler failed"` | |
| `:953` | `"Failed to ensure stream consumer group"` | **verbatim duplicate of `LOG_MESSAGE.BOOTSTRAP_FAILED` at `:122`, in the same file** |

`.claude/rules/constants.md` is explicit that the rule *"Applies to … **and tests**"*, that
"Error codes and error messages" belong in a constants module, and *"before adding a third copy
of a literal, promote it"* — this is the fourth copy of one string and a same-file duplication of
a constant that already exists. It is a required gate, not a preference.

**Fix:** extend `LOG_MESSAGE` at `:118` with `READ_FAILED`, `RECOVERY_FAILED`, `HANDLER_FAILED`
and replace all seven literals, using the existing `LOG_MESSAGE.BOOTSTRAP_FAILED` at `:953`.
Keep them test-local (not imported from `src/`) — that split is correct and the file's own
docblock at `:391-393` explains why.

---

### LOW

#### L-1 · `U29` reddens by a 5 006 ms timeout, not an assertion — and four other cases share the shape

`apps/worker-service/tests/stream.consumer.unit.test.ts:896-897`. The implementer disclosed this;
it is accurate, and the disclosure is honest. Re-performed: removing the per-entry `try`/`catch`
from `dispatch` gives

```
× U29 - a handler rejection is logged against its entry and the batch continues 5006ms
  → Test timed out in 5000ms.
```

`vi.useFakeTimers()` is installed and never advanced, so the mutation's backoff never elapses and
`run()` never resolves. So it *is* a real guard — it fails — but it fails naming nothing, and a
maintainer reading "Test timed out" will suspect the test before the classification.

**Verified fix:** deleting `vi.useFakeTimers()` from `:897` converts it to a clean failure, with
the same mutation in place:

```
× U29 … 1017ms → expected [ '1789101023800-0' ] to deeply equal [ Array(2) ]
```

and the case still passes on the unmutated tree (`1 passed | 26 skipped`). The fake timers were
carrying a second claim — "it did not take the backoff path" — which should be made explicit
rather than implicit in a hang:
```ts
expect(mockLogger.error).not.toHaveBeenCalledWith(expect.anything(), "Stream read failed");
```
(the 1 017 ms elapsed above is the real 1 000 ms backoff, so the mutation does take that path).

Same shape at `U16` (`:667`), `U18` (`:722`), `U28` (`:869`) and `U30` (`:933`): under the
"read on the container connection" mutation, 16 unit cases went red and **five** of them by
5 000 ms timeout rather than assertion. Not required, but the file's own docblock at `:396-399`
oversells it — *"a loop that failed to exit would then hang the suite rather than fail it"* is
offered as the reason no case waits on a wall-clock timer, and five cases hang the suite anyway
under ordinary mutations.

#### L-2 · `INTEGRATION_LOOP_REDIS.ABANDONED_CONSUMER_NAME` is dead config added by this diff

`apps/worker-service/tests/integration.constants.ts:130`, with a docblock at `:125-129` explaining
the role it plays. `grep -rn ABANDONED_CONSUMER_NAME apps/worker-service/tests/` outside the
constants file → no match. `I10` seeds its pending list through `readNewEntryIds`, which reads
`INTEGRATION_REDIS.CONSUMER_NAME` = `"t038-reader"` (`:41`).

`I10` is still materially valid — `"t038-reader"` *is* a different consumer from the subject's
`"t039-worker"`, so recovery genuinely reclaims foreign work, which my `while` → `if` mutation
confirmed (U19 + I10 red). The defects are that the new constant is unread (the S-6 pattern:
declared, validated, never consumed) and that a t039 case seeds under a t038 identity, against
the stated purpose of the new prefix block at `:115-120`.

**Fix:** give `readNewEntryIds` a consumer-name parameter and pass
`INTEGRATION_LOOP_REDIS.ABANDONED_CONSUMER_NAME` from `I10`, or delete the constant. Prefer the
former.

#### L-3 · Three implemented branches with no test, all inside the coverage-excluded path

- The `malformed` warn branch, `stream.consumer.ts:640-650`, and the counting that feeds it
  (`:61-140`). `grep -rn 'Skipped stream reply elements\|malformed' apps/worker-service/tests/` →
  no match. The docstring at `:56-59` makes a specific design claim ("a non-string field makes
  the **whole entry** malformed rather than being filtered out") that nothing exercises.
- The `RECOVERY_MAX_PAGES` page-limit warn, `:618-627`. The constant's docblock
  (`constants.ts:216-225`) calls it a liveness bound; no case reaches it.
- `"Stream consumer loop not started: shutdown already requested"` (`:384-389`) and
  `"Stream consumer loop stopped"` (`:414-418`). The branches are reached (`U14`, every loop
  case) but the log lines are unasserted. Lowest of the three.

Compounding factor: `apps/worker-service/vitest.config.mjs:18` excludes `src/events/**` from
coverage, so the service's 80/75 thresholds cannot notice any of it. The plan flags this in §10
for epic-12 — see §Out of scope.

#### L-4 · Positional reply indices are bare numeric literals

`stream.consumer.ts:134` (`perStream[1]`), `:162` (`reply[0]`), `:165` (`reply[1]`). These are
protocol positions with names — the `XREADGROUP` per-stream entry list, `XAUTOCLAIM`'s cursor and
entry list — and this repository already names a positional `2` as
`INTEGRATION_FIELD_PAIR_STRIDE` (`integration.constants.ts:109`). Consistency argues for
`CLAIM_REPLY_CURSOR_INDEX`, `CLAIM_REPLY_ENTRIES_INDEX`, `READ_REPLY_ENTRIES_INDEX` on
`WORKER_STREAM_READ`. The pure loop counters (`malformed`, `pages`, `reclaimed`) are fine as-is.

#### L-5 · Plan §8's manual check would have irreversibly mutated the live fixture — the deviation was right and §8 should be corrected

The implementer deviated from §8, ran the end-to-end shutdown check against database 14 on a
`t039-manual` stream, and gave the reason. **Confirmed, and the reason is stronger than stated.**
§8 prescribes `pnpm --filter @telemetry/worker-service dev` with the root `.env`'s
`REDIS_URL=redis://localhost:6379` → database **0**, then `XADD telemetry:events '*' …` followed
by `XDEL`. Measured on disposable database 13:

```
XADD ×2 → entries-added 2
XDEL <second id>
after XDEL → entries-added 2, last-generated-id <the deleted id>
```

`entries-added` and `last-generated-id` are monotonic; `XDEL` does not restore them. §8 would
therefore have taken the live fixture from `entries-added 2` to `3` permanently, moved
`last-generated-id`, and created `worker-group` plus a consumer row on the real stream — the
exact fixture T-038's D1 argument and `I9`'s premise rest on. The self-reported first attempt
(killing the `npx` wrapper, "11 ms", worker surviving and rebuilding a db-14 stream through the
`NOGROUP` repair path) is disclosed honestly and correctly discarded.

**Fix:** correct §8's manual-check block to database 14 and a disposable stream name, and record
that the real `telemetry:events` must not be used. Verified unchanged at review end: `XLEN 2`,
`entries-added 2`, `last-generated-id 1788171536033-0`, `XINFO GROUPS` empty.

#### L-6 · The plan's slice-time mutation results were not re-validated against the final tree

Plan §11's S2 entry records the inherited mutation as *"`U23` red, `U22` and U1-U10 green — it
only touches the non-`Error` arm"*. Re-performed on the final tree, `String(error)` → `"unknown"`:

```
× U23 - stringifies a non-Error rejection into the logged error field
× U18 - stringifies a non-Error read rejection and still backs off
Tests  2 failed | 25 passed (27)
```

`U18` did not exist when S2 ran, so the plan line is not false as written — but it is read as
"U23 only", and the true answer on the tree under review is two cases. This is the *stronger*
result, so there is no safety consequence; the finding is that a mutation table recorded per
slice needs one re-run at the end or a note that it is slice-time. Same class as the AC11 row
below.

#### L-7 · `run()`'s docstring glosses the gap between the guard and the first read

`stream.consumer.ts:376-378`: *"The `do`/`while` shape is what keeps it to one read per
iteration: the guard above gates the first, the condition below gates each subsequent one."*
`recoverPendingEntries` sits between the guard (`:383`) and the first read (`:404`), and the
pagination has no bound on wall-clock time. A predicate that flips *during* recovery still gets
one full `STREAM_BLOCK_MS` read afterwards, because the `do`/`while` checks its condition only at
the bottom. In the shipped wiring this is invisible — `index.ts` calls `stop()`, which
disconnects, so the read rejects immediately — but the claim is about the predicate path, and on
the predicate path alone it is wrong by up to `STREAM_BLOCK_MS`.

**Fix:** either re-check `shouldStop()` after recovery returns (one line, and it pairs with
M-1's second half) or say "the guard above gates the first read *unless the predicate flips
during recovery*".

---

### NIT

- **N-1** `stream.consumer.unit.test.ts:926` — `for (const call of mockLogger.error?.mock.calls ?? [])`.
  The `?? []` makes the payload-redaction loop vacuous if the mock were absent. Guarded in
  practice by the `toHaveBeenCalledWith` immediately above, which proves ≥ 1 call, and by
  `beforeEach`. Consider a `mockLogger.error` non-null assertion helper that throws, matching
  `nthReadArgs`' discipline at `:540-547`.
- **N-2** `stream.consumer.ts:384-389` — the early return logs "loop not started" but, unlike the
  `finally` at `:414-418`, emits no paired "stopped" line. Asymmetric, harmless.

---

## Claims re-derived by execution

Each row is something a command established on this revision, not something read and believed.

| Claim (and where it is made) | Result |
|---|---|
| S1: `git log --all` finds none of the five sub-task ids (`known-gaps.md:244-247`) | **True.** `grep -icE "T[- ]?024[CD]\|T[- ]?067[ABC]"` → `0`, grep exit 1 |
| S1: five carriers, `eb3ef10` added t-067c and `4925e4a` modified it | **True**, and it corrects the plan's own reversed ordering. `git log --name-status --diff-filter=AM` → `eb3ef10 A`, `4925e4a M`; the other four each add one plan file |
| S1: `README.md:138` reads `\| **Total** \| **73** \| \|` and its column sums to 73 | **True.** Line 138 exact; 6+5+5+8+5+7+7+6+5+5+6+4+4 = 73 |
| S1: 76 headings / 75 distinct / `T-070` twice; epic-4 8 vs 10, epic-12 4 vs 5, epic-13 4 = 4 | **All true.** `grep -cE '^#+ +T-[0-9]+[A-Z]?'` summed = 76; `sort -u` = 75; `uniq -c` shows `2 T-070`; per-epic counts match |
| S1: "Six distinct hygiene defects" | **True.** Six `- **…**` bullets in the S-15 block |
| Mutation: `String(error)` → `"unknown"` | U23 red **and U18 red** (briefing said U23 only — see L-6) |
| Mutation: acknowledge what was read (D2-B) | `I7`, `I9`, `I10` red. Exactly as claimed |
| Mutation: group start `$` → `0` | `I5`, `I9` red. `I9` is a genuine anti-vacuity case — it also asserts the positive (`handled == [freshId]`), so it reddens in both directions |
| Mutation: `void run()` → `await run()` | **10** shutdown cases red, each ~1 005 ms (`vi.waitFor` budget, not a hang). Exactly as claimed |
| Mutation: loop started after `listen` | `U25` only, 61 ms clean |
| Mutation: `stop()` stops disconnecting | `U31` + `I12` red |
| Mutation: recovery `while` → `if` (single `XAUTOCLAIM`) | `U19` (7 ms, clean) + `I10` red |
| Mutation: NOGROUP repaired but also backed off | `U16` only |
| Mutation: NOGROUP branch removed entirely | `U16`, `U30`, `I11` red |
| Mutation: read on the container connection (`duplicate()` → `this.redis`) | **16** unit cases red including `U24` at 1 003 ms clean. **No OOM** — the implementer's fixture change (throwing `xreadgroup`/`xautoclaim` on the main mock, `:415-424`) does fix the disclosed problem |
| Mutation: per-entry handler catch removed | `U29` red **by 5 006 ms timeout** — disclosure accurate, see L-1 |
| "required predicate surfaced four `TS2554` errors naming every construction site" | **True.** `git grep` at `b558641` finds exactly four `new StreamConsumer(` sites. On the current tree there are six, all passing a real predicate, and dropping the argument from all six yields six `TS2554: Expected 4-5 arguments, but got 3` naming each |
| `constants.ts` is append-only; S-23's `:38-44` untouched | **True.** `--numstat` = `114 0`, single hunk `@@ -153,0 +154,114 @@`, and `:30-50` byte-identical to base |
| The new `WORKER_STREAM_READ` docblock cites the stale "never reaches the fallback" sentence as stale rather than republishing it | **True**, at `constants.ts:161-164`; and `stream.consumer.ts:277-281` states the corrected scope with the measured `safeParse("")` results |
| `entries-added` survives `XDEL` (basis for the §8 deviation) | **True** — see L-5 |
| §7's AC11 row cites `U24`, which §7's own case list assigns to the unit suite | **True.** The row should read `U25`, `U31`; the implementer recorded it as a deviation rather than editing the row, which is the right call for an approved plan — but the row should now be corrected in place with a note, since it is the only place a reader looks for AC11's proof |
| `firstReadSettled()` can be `true` | **False** — see M-2 |
| `hasParkedRead()` is scoped to database 14 | **False** — see M-3 |
| `run()` resolves rather than rejects | **False** — see H-1 |

### The five beyond-plan cases — judged

| Case | Verdict |
|---|---|
| `U27` (third reply shape `[[stream, []]]`) | **Earns its place.** S3's stated hypothesis is totality over three observed shapes and only two were listed. `[[stream, []]]` is truthy, so a `!reply` guard alone misses it. Not creep |
| `U28` (same text, no stop requested, still an error) | **Earns its place, and is load-bearing.** Without it, classifying on the message alone passes `U26`; `isShutdownInterrupt` keys on `stopRequested` precisely because of this, and `U28` is the only case that pins it. The strongest of the five |
| `U29` (per-entry handler catch) | **Earns its place** — the behaviour was ratified at the Gate-3 transition, so the case is required, not an implementer liberty. But it does not fail legibly (L-1) |
| `U30` (failed re-registration does not end the loop) | **Earns its place.** §6 S5 requires the behaviour and §7 listed no case; my mutation confirms `U30` is one of only three cases that notice the branch |
| `U31` (`stop()` before `app.close()`) | **Earns its place.** §6 S6 requires the ordering and nothing asserted it; it is the sole detector of the "close first" mutation, which the measurements price at ~4.8 s per deploy |

No scope creep found. All five are inside T-039's stated scope and each is the unique detector of
at least one mutation.

---

## Compile-time gate — all 13 packages, `--force`, 0 cached

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | **13 successful / 13 total, 0 cached**, exit 0 |
| lint | `pnpm lint --force` | **13 successful / 13 total, 0 cached**, exit 0, 14 warnings (all pre-existing) |
| build | `npx turbo run build --force` | **13 successful / 13 total, 0 cached**, exit 0 |
| test | `pnpm test --force` | **13 successful / 13 total, 0 cached**, exit 0 |

Per-package test totals: `worker-service` **7 files / 92 tests** (matches the stated baseline;
re-confirmed green after every mutation was reverted) · `usage-service` 19/230 ·
`auth-service` 15/164 · `gateway` 8/38 · `analytics-service` 4/18 · `billing-service` 4/18 ·
`shared-utils` 1/18 · `shared-validation` 1/15 · `shared-types` 1/8 · `shared-config` 1/4 ·
`shared-logger` 1/4 · `shared-tracing` 1/2 · `web` (task ran, no vitest summary). `sdk` has no
`test` task, which is why turbo reports 13 and not 14.

**Warnings — 14, all pre-existing, proven:**

- 10 × `@typescript-eslint/no-misused-promises` in `apps/auth-service/tests/auth.service.unit.test.ts`.
  `git log -1` → `d68e719` (2026-08-25). Not in `git diff --name-only`.
- 4 × `@typescript-eslint/no-unsafe-assignment` in `apps/usage-service/tests/ingestion.service.unit.test.ts`.
  `git log -1` → `b0f6921` (2026-08-31). Not in `git diff --name-only`.

`worker-service:lint` emits **zero** warnings, and `grep -c no-unsafe-return` over the whole lint
log is **0** — confirming the implementer's report that the two `no-unsafe-return` warnings it
introduced were fixed and none remain.

One pre-existing type-safety item for the record, so it is not miscounted against this change:
`stream.consumer.integration.test.ts:151-165`'s `readNewEntryIds` uses
`as Array<[string, Array<[string, string[]]>]> | null`. Present at `b558641` (`git show
b558641:… | grep -n 'as Array<'` → line 142). T-038's. `I10` newly depends on it, which is worth
knowing but is not a T-039 defect.

---

## Environment discipline

- **Database 0, before:** `DBSIZE 1`, `telemetry:events` `XLEN 2`, `entries-added 2`,
  `last-generated-id 1788171536033-0`, `XINFO GROUPS` **empty**, ids `1787746970722-0` /
  `1788171536033-0`.
- **Database 0, after:** identical on every one of those fields. `DBSIZE` is 2 rather than 1, the
  extra key being a self-expiring `denylist:f6b077aa…` written by **auth-service** during the root
  `pnpm test` — that is **S-22**, reproduced independently here, and not attributable to T-039.
- **Database 14:** `DBSIZE 0` before and after. Every `FLUSHDB` I caused went through the suite's
  `flushReservedDb()` (`:194-202`), which re-asserts `db=14` on each call; I issued none directly.
- **Database 13** was used for two disposable probes (the `CLIENT LIST` scope probe and the
  `entries-added` monotonicity probe) and returned to `DBSIZE 0`; it is reserved by nothing.
- **Postgres and Redis** were left running throughout. The pre-existing worker-service dev
  process (pid 184537) was not touched.
- **Tree:** `md5sum -c` over all 12 relevant files → all OK, byte-identical to review start;
  `git status --porcelain` matches the review-start snapshot exactly (9 modified, 1 untracked
  plan). One throwaway probe suite was created at
  `apps/worker-service/tests/zz-reviewer-probe.test.ts` and deleted; it does not appear in the
  final status.

---

## Decisions for the user

Both change the diff. Neither is preference.

### D-1 · How much of the shutdown-during-recovery gap does T-039 absorb? (M-1)

A graceful `stop()` landing on an in-flight `XAUTOCLAIM` logs at **error** level, which AC8 says
must not happen. Verified by probe.

| Option | What changes |
|---|---|
| **A — fix it here** *(recommended)* | ~10 lines in `recoverPendingEntries`' `catch` reusing the existing `isShutdownInterrupt`, a `shouldStop()` guard at the top of the pagination loop (which also closes L-7), and one new unit case mirroring `U26`. AC8 becomes true of both paths |
| B — defer to T-043 | No code change. T-043 owns shutdown and will touch this method anyway. Costs: a spurious ERROR on every restart that shuts down mid-recovery, and AC8 ships partially satisfied; needs a `known-gaps.md` entry so it does not evaporate |
| C — weaken AC8 instead | Record in the plan that AC8 covers the read loop only. Cheapest, and the least honest of the three: the classifier already exists and is simply not called |

**Recommendation: A.** The mechanism is already written — `isShutdownInterrupt` at `:481-487`
— and not calling it from the one other place a shutdown lands is an omission rather than a
design choice. T-043 is the wrong owner because the defect is in T-039's own recovery pass.

### D-2 · Does the untested default handler get a case now? (M-4)

`buildDefaultMessageHandler` is what a deployed T-039 worker actually runs, and nothing asserts
it — including the negative that it logs the entry id and never the payload.

| Option | What changes |
|---|---|
| **A — one unit case now** *(recommended)* | ~15 lines: construct with four arguments, deliver one entry, assert the `info` fields and message, assert no `error` log, assert the payload string appears in no log call. D2-A fully covered |
| B — accept it, T-040 replaces the handler anyway | No change. Costs: the only behaviour this task exhibits in production is unasserted, and the redaction claim at `:174-176` is unbacked. `src/events/**` is coverage-excluded, so nothing else flags it |

**Recommendation: A.** The redaction half is the reason — `U29` asserts "id only, never the
payload" for the *failure* log, and the same property on the *success* log is the one that fires
on every entry a live worker reads.

---

## Out of scope — recommend adding to `.claude/rules/known-gaps.md`

`apps/worker-service/vitest.config.mjs:18` excludes `src/events/**` from coverage collection, so
`stream.consumer.ts` — after this change the service's largest and most branch-dense file at 694
lines — is outside the service's own 80/75 thresholds. Three of this review's findings (L-3's
`malformed` branch, the `RECOVERY_MAX_PAGES` warn, M-4's default handler) sit inside the excluded
path, which is why nothing mechanical caught them.

The plan records this in §10 "handed forward to epic-12". That is not a durable record: `CLAUDE.md`
states plans mark a task *started*, and nothing may read `docs/plans/` as evidence. It should be a
`known-gaps.md` entry with the next free id, naming the config line, the excluded globs, and the
three specific branches currently unmeasured. Fixing it is out of scope here — removing the
exclusion changes the thresholds' meaning for the whole service and needs its own task.

Also worth carrying into that entry or S-22's: the per-suite logical-database convention is
enforced by `flushReservedDb()` for *writes* but nothing scopes *reads* of server-wide
introspection commands, which is the root of M-3. `CLIENT LIST`, `CLIENT INFO` and `INFO
clients` all cross database boundaries.

---

## What I could not verify, and why

- **`duplicate()` throwing against a real `ioredis` client.** H-1's refutation used an injected
  `duplicate` that throws, which proves `run()` has an uncaught path but not that the real client
  ever takes it. The rejection path is real; its production likelihood is my judgement, stated as
  low, not a measurement.
- **Slice-level histories.** The plan's §11 claims about what was red *at each slice* (S1 touching
  only `known-gaps.md`, the intermediate "8 unhandled rejections", "0 now") cannot be re-derived —
  the intermediate trees do not exist. I re-derived every mutation result against the **final**
  tree instead, which is the revision under review. L-6 is what that comparison turned up.
- **The Appendix A / B probe transcripts** (P1-P17: the 2 080 ms shared-connection `PING`, the
  4 813 ms `quit()`, the 205 ms `disconnect()`, the 153/603 ms rejection latencies, the 391 ms
  `null` timeout). I re-derived the ones the *code* depends on — the three-element `XAUTOCLAIM`
  reply, `>` versus `0` versus `SETID 0`, `NOGROUP` on a deleted key, `Connection is closed.`,
  the `cmd=xreadgroup` row form — through the integration suite passing and through my own
  mutations. The specific millisecond figures quoted in comments are inherited and unverified;
  none of them is load-bearing for a branch, only for the argument that D1-B was the right
  answer, which the user already decided.
- **`I12`'s timing on a loaded CI runner.** `STOP_BUDGET_MS` is 2 000 against a 5 000 ms block,
  which is a deliberately loose bound; I ran it on an unloaded machine only.
- **Redis versions other than 7.0.15.** The `XAUTOCLAIM` three-element reply and the `NOGROUP`
  text are 7.x shapes. CI uses `redis:7-alpine`, so CI and local agree, but nothing here was
  exercised on 6.x or on a managed Redis.
- **The Copilot mirror (`S-14`).** This change touches no agent definition, so S-14's
  apply-to-both-copies rule does not bite. Not otherwise checked.

---

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| `void run()` swallows a rejection and the process dies without a log line | **Required fix, H-1.** Low likelihood today, but the comment is the reason no guard exists |
| Spurious ERROR on shutdown-during-recovery misleads an operator into treating a clean deploy as a fault | **Decision D-1.** Recommend fixing here |
| `I12` silently stops measuring the interrupt once a dev worker runs alongside the suite | **Required fix, M-3.** Verified reachable, and this change makes it likely |
| `U25`'s tautological assertion is later cited as proof of a property it does not test | **Required fix, M-2.** The property is real; the credited line is not |
| The production default handler logs a tenant-bearing payload after some future edit | **Decision D-2.** Recommend a case now. Note the code is currently correct — `buildDefaultMessageHandler` takes only `id` |
| Log-message literals drift out of step with the implementation | **Required fix, M-5.** Required gate under `.claude/rules/constants.md` |
| `U29`/`U16`/`U18`/`U28`/`U30` fail as timeouts, costing 5 s each and naming nothing | **L-1**, recommended not required. Fix verified for `U29` |
| `src/events/**` outside coverage; three untested branches | **Out of scope.** Recommend a `known-gaps.md` entry rather than a silent hand-forward |
| Plan §8's manual check would damage the live fixture if run as written | **L-5**, correct §8 in this commit. The deviation itself was right |
| §7's AC11 row cites the wrong case | **L-6**, correct the row in place with a note; the deviation record alone leaves the wrong citation where readers look |

**Verdict: CONDITIONAL.** Required before commit: **H-1, M-2, M-3, M-5**, plus the answers to
**D-1** and **D-2** and whatever they imply. Recommended in the same pass because they are
cheap and in files already open: **L-1, L-2, L-5, L-6, L-7**. **L-3** and **L-4** are
reviewer-discretion and may be deferred with a note. Nothing here requires the design to change:
the loop, the classification, the recovery pagination, the dedicated connection and the shutdown
ordering are all correct and all genuinely guarded by tests that I made fail.

---

## Round 2

Base still `b558641`; subject the uncommitted working tree, now 7 files / **99** tests in
worker-service (92 at Round 1). Read-only. Every mutation cited below was reverted and the tree
proved byte-identical afterwards (`md5sum -c` over all 11 changed/untracked files, and
`git status --porcelain` diffed against the review-start snapshot — identical).

**Verdict: CONDITIONAL.** Two MEDIUM and four LOW findings, all new, **none of which changes
what the service does at runtime** — they are one test constant, one plan paragraph, and four
comment/citation corrections. Every Round-1 finding is fixed and I re-derived each fix by
execution rather than by reading the diff. All three of the rework's claims *against* Round 1
are confirmed, and one of them corrects Round 1 on a point that matters beyond this task.

Round 1's line numbers are stale throughout; every `file:line` below was re-derived on this
tree.

---

### MEDIUM

#### M-6 · `RUN_DEADLINE_MS` cannot fire — it is 10 000 ms against vitest's 5 000 ms per-case timeout, and its docblock claims the opposite

`apps/worker-service/tests/integration.constants.ts:190`, docblock `:183-189`:

> Every loop case stops on a *condition* (the entries it expected arrived), so this only fires
> when the condition never will. It converts a hang into a legible assertion failure, which is
> the difference between a red suite and a timed-out one.

`RUN_DEADLINE_MS: 10_000`. Vitest's default per-case timeout is 5 000 ms, and nothing overrides
it: `grep -rn "testTimeout\|hookTimeout" apps/worker-service --include=*.mjs --include=*.ts
--include=*.json` (excluding `node_modules`/`dist`) → no match, and `vitest.config.mjs` sets
`include`, `setupFiles` and `coverage` only. So the deadline is unreachable by 5 000 ms and the
docblock states precisely the property it does not have.

**Measured, not reasoned.** With the recovery pagination mutated to a single page
(`while (pages < …)` → `if (pages < …)` at `stream.consumer.ts:641`):

```
× I10 - reclaims a pending list larger than COUNT, paginating past the boundary 5009ms
  → Test timed out in 5000ms.
    If this is a long-running test, pass a timeout value as the last argument or configure it
    globally with "testTimeout".
```

That is the exact failure mode the docblock says it converts away, produced by the mutation the
plan's S4 nominates for `I10` ("the mutation is *delete the `while`*, and `I10` must go red on
it"). It does go red — as a runner timeout naming nothing.

Three call sites are affected, two of which are `vi.waitFor` timeouts rather than the harness
predicate, so the same ceiling applies to them:
`stream.consumer.integration.test.ts:459` (`buildLoopHarness`' deadline),
`:778` (`I11`'s wait for the re-created group) and `:826` (`I12`'s wait for the parked read).

The unit suite got this right in the same round and its docblock states the rule the
integration constant breaks — `stream.consumer.unit.test.ts:526`, `STOP_DEADLINE_MS = 2_000`,
described as *"well inside vitest's 5 000 ms per-case budget so the case's own assertions report
the failure rather than the runner"*. Confirmed by measurement: under the
`duplicate()` → `this.redis` mutation the unit file produced **23** failures, longest 2 005 ms,
and `grep -c "Test timed out"` over the whole run was **0**.

**Fix:** lower the constant below the runner's budget and say so, mirroring the unit suite —
`RUN_DEADLINE_MS: 3_000` at `integration.constants.ts:190`, with the docblock naming the
5 000 ms budget as the reason the value must stay under it. (The alternative — passing an
explicit per-case timeout larger than `RUN_DEADLINE_MS` as `it`'s third argument at all five
harness cases — also works but has to be repeated per case and is easier to forget.) Nothing in
the suite needs 3 s: the whole file runs in ~450 ms and the longest legitimate wait is `I12`'s
read parking, which is milliseconds. `I12` does not use `buildLoopHarness`, so lowering this
below `BLOCK_MS_LONG` is safe.

**This is the same finding *class* as Round 1's L-1** (a case that reddens as a timeout rather
than an assertion). L-1 was raised against the unit file, fixed there, and the same-shaped guard
was then written into the integration file with the inequality the wrong way round. I am
recording it, not opening a third round on the class: the fix is one number.

#### M-7 · The plan justifies the no-`.catch()` decision with a universal that a nine-line test refutes — and the decision has a better reason available

`docs/plans/t-039-stream-consumer-loop.md:832-834`:

> **Deliberately not also `.catch()`-ing at `index.ts`:** with `run()` catching internally that
> branch is unreachable and no test could cover it, and an unreachable guard carrying a claim is
> what Round 1 punished.

`.claude/rules/review-standards.md` § *Universals Must Cite Their Mutation* makes "unreachable"
and "no test could" testable assertions that must name the mutation establishing them. Asking
what would have to be true for this to be false: `run()`'s `catch` calls `this.logger.error`, so
a logger that throws re-rejects `run()`.

**Refuted by execution.** Throwaway probe, constructed with a `duplicate()` that throws *and* a
logger whose `error()` throws:

```
P-R2-A: run() rejected = true
 Test Files  1 passed (1)
```

So the branch is reachable and the test covering it is nine lines. The source already says this
and the plan contradicts it — `apps/worker-service/src/events/stream.consumer.ts:374-376`:

> It is **not** a claim that no future edit can make this reject — `this.logger.error` itself
> throwing would, and so would a statement added outside the `try`.

The code comment is the honest one; the plan's disposition is the overclaim. Same shape as
Round 1's H-1: the refuting case was already written down inside the change, and the universal
was stated anyway.

**The decision itself is sound, and I am not re-opening it** — the user ratified it and the
reasoning holds on the narrower true version. It is in fact stronger than the plan states: a
`.catch()` at `index.ts:139` would log through `container.logger`, which is the *same object*
`run()` passes as `this.logger` (`index.ts:103-108`), so on the one path that makes the branch
reachable the guard would call the thing that just threw. That is a mechanism-level reason to
omit it, not an absence-of-evidence one.

**Fix:** replace "that branch is unreachable and no test could cover it" with what was measured
— e.g. *"`run()` no longer rejects for any failure inside `runLoop()`, which was the whole of
Round 1's H-1; the one residual is `this.logger.error` itself throwing, and a `.catch()` here
would log through that same logger, so it would be inert exactly when it is reachable
(`stream.consumer.ts:374-376`)"*. No code change.

---

### LOW

#### L-8 · "by one microtask turn" is measurably wrong, and wrong differently in production

`apps/worker-service/src/index.ts:133`:

> The first *read* lands after `listen` by one microtask turn -- `void run()` runs synchronously
> only as far as the first `XAUTOCLAIM`

**Measured** with a probe that starts a microtask-counting chain at the point `start()`
synchronously invokes `app.listen(...)` and records the counter when `xreadgroup` is first
called, against the real `StreamConsumer` and an `xautoclaim` that resolves immediately:

```
listen invoked at microtask turn 0; first xreadgroup at turn 3
```

Three turns, not one — `recoverPendingEntries` resumes, `await this.dispatch(claim)` is a second,
`await this.recoverPendingEntries(...)` returning is a third. And that is the *mock*: in
production the first turn is gated on an `XAUTOCLAIM` network round trip, so the real gap is a
round trip, which is the thing the sentence is trying to reassure the reader about and states as
a microtask.

The direction of the claim — read after listen — is right and is what `U25` asserts; only the
quantity is wrong.

**Fix:** drop the quantity at `index.ts:133`: *"The first read lands after `listen`, because
`void run()` runs synchronously only as far as the first `XAUTOCLAIM` and then suspends on that
round trip."* The same wording at
`apps/worker-service/tests/index.graceful-shutdown.unit.test.ts:393` ("still a microtask away")
reads as "not yet" rather than as a count and is fine either way.

#### L-9 · "`connectionName` for every client this suite opens" is false, and contradicts the helper it justifies

`apps/worker-service/tests/integration.constants.ts:37-38`:

> `connectionName` for every client this suite opens, so a `CLIENT LIST` row can be attributed
> to this suite rather than to whatever else is connected to the server.

`grep -n "new RedisClient(" apps/worker-service/tests/stream.consumer.integration.test.ts` →
`:219` (the suite client, with `connectionName`) and **`:356`**, which is `I6`'s
`Array.from({ length: INTEGRATION_CONCURRENCY.BOOTSTRAP_CLIENTS }, () => new
RedisClient(reservedDbUrl))` — eight clients, no options object, no name. So eight of the nine
clients the suite opens are unnamed.

It also contradicts `hasParkedRead`'s own docstring at `:574`, which says the narrower and
*true* thing: *"the only executable `connectionName` in the repository is this suite's own
client"*. Verified: `grep -rn "connectionName" apps packages --include=*.ts | grep -v /dist/`
returns one executable line, `:220`.

No live consequence — `I6`'s clients only ever `XGROUP CREATE`, never park on a read, and are
`quit()`ed inside the case. The cost is the next person reading the docblock as a property of
the suite.

**Fix (prefer the first, it makes the claim true for one option argument):** pass
`{ connectionName: INTEGRATION_REDIS.CLIENT_NAME }` at
`stream.consumer.integration.test.ts:356`, which also makes `I6`'s eight rows attributable in
`CLIENT LIST` — the stated purpose of the constant. Otherwise narrow
`integration.constants.ts:37-38` to "the suite's own client, which `duplicate()` propagates to
the subject's read connection".

#### L-10 · The plan's sequence diagram cites base-tree line numbers that are all stale on the tree being committed

`docs/plans/t-039-stream-consumer-loop.md:53-60`, immediately followed by *"Solid arrows exist
today at the cited `file:line`"*. `.claude/rules/review-standards.md` says diagrams are claims
and each arrow must be checked against the `file:line` it cites. Checked:

| Diagram citation | On the committed tree |
|---|---|
| `index.ts:50, :56` — signal handlers | `:79`, `:85` |
| `index.ts:74` — construct | `:103` |
| `index.ts:78` — start answering `/health` | `:139` |
| `stream.consumer.ts:81` — register reader group | `:319` |

All four resolve correctly against `b558641` and none against the tree under review. `§S6`'s
controlling-path list at `:538` (`index.ts:20-22`, `:33`, `:35-48`, `:74-75`, `:77-78`) and the
references at `:131`, `:190`, `:266`, `:330`, `:779` are the same base-tree numbers.

This is the third instance of the stale-citation class in this one plan; Round 1 found the other
two (AC11's proving case, S1's carrier order) and both were corrected in place. The diagram was
missed.

Related and cheap to fold in: the flowchart at `:496-509` shows the shutdown check at the **top**
of the loop, which is the reading Round 1's L-7 refuted and the rework's `runLoop()` docstring
now corrects. It is honestly labelled *"Every node is proposed; none of it exists"*, so it is a
plan-time artifact rather than a false statement about the code — but it is where the L-7
misconception came from.

**Fix:** one sentence under the diagram — *"Line numbers are as of base `b558641`; this task
moves them"* — or re-point the five citations. Do not re-point without saying which tree they
refer to, or the next task inherits the same problem.

#### L-11 · `CALLS` — a call-count constant — is used as an array index in four places

`apps/worker-service/tests/stream.consumer.unit.test.ts:520-524` declares `CALLS` with the
docblock *"Call counts, named so no bare numeral carries meaning in an assertion."* It is then
used as a positional index at:

- `:881` — `mockRedis.xgroup.mock.calls[CALLS.NONE]`
- `:1131` and `:1246` — `ENTRY.FIRST.fields[CALLS.ONCE]` (the field *value* of a key/value pair)
- `:1349` — `MALFORMED_ENTRY[CALLS.NONE]` (the entry id)
- and as the argument to `nthReadArgs`/`nthClaimArgs`, which take an index

Not a tautology — I checked, and each reads the value it means — but "one call" standing in for
"position 1" is a mechanical substitution that makes the assertion read wrong, which is the
failure mode the M-5 rework was explicitly asked to avoid. `ENTRY.FIRST.fields[CALLS.ONCE]` is
the worst of them: it is the payload the redaction negative searches for, and nothing in the
name says so.

**Fix:** add a sibling `const INDEX = { FIRST: 0, SECOND: 1 } as const` (or
`FIELD_KEY_INDEX`/`FIELD_VALUE_INDEX`, matching `WORKER_STREAM_READ`'s own
`READ_REPLY_ENTRIES_INDEX` naming) and use it at the five index positions. Leave `CALLS` for
`toHaveBeenCalledTimes` and the loop counters, which is what its docblock describes.

---

### NIT

- **N-3** `.claude/rules/known-gaps.md` S-25 §1 lists the coverage excludes "alongside
  `src/**/index.ts`, `src/config/container.ts`, `src/jobs/**`, …" and omits two that are
  actually there — `src/**/*.d.ts` and `src/startup.constants.ts` (`vitest.config.mjs:14`,
  `:16`). Not a false claim ("alongside X, Y" is not exhaustive), but the list is read as one.
- **N-4** The three T-039 lines added to `apps/worker-service/tests/index.graceful-shutdown.unit.test.ts`
  (`:377`, `:378`, `:401`) write a bare `1` in `toHaveBeenCalledTimes`. Consistent with that
  file's ~18 pre-existing instances and with its having no `CALLS` object, so **not** a
  constants-gate finding against this change; noted only so the next reader knows it was
  considered.

---

## The three claims the rework makes against Round 1 — rulings

### 1 · `CLIENT INFO` is **not** server-wide. Round 1 was wrong. — **CONFIRMED**

Round 1's M-3 fix-direction paragraph and its *Out of scope* section grouped `CLIENT INFO` with
`CLIENT LIST` and `INFO clients`: *"`CLIENT LIST`, `CLIENT INFO` and `INFO clients` all cross
database boundaries."* **That sentence is false for `CLIENT INFO` and I am correcting it here
rather than leaving it in the record.** Reproduced independently:

```
redis-cli -n 0 CLIENT INFO  -> db=0
redis-cli -n 3 CLIENT INFO  -> db=3
redis-cli -n 7 CLIENT INFO  -> db=7
redis-cli -n 13 CLIENT INFO -> db=13
redis-cli -n 14 CLIENT INFO -> db=14
```

`CLIENT INFO` describes the **calling** connection. The other two do cross, and I re-measured
both: with a blocking `XREADGROUP` parked on db 13 and nothing parked on 14,
`CLIENT LIST | grep -c 'cmd=xreadgroup'` → `1` on a row carrying `db=13`, and
`redis-cli -n 14 INFO clients` → `blocked_clients:1`.

**This matters beyond T-039**, which is why it gets its own ruling: `flushReservedDb()`
(`stream.consumer.integration.test.ts:203-213`) uses `CLIENT INFO` as a *per-connection* guard,
and that helper is T-038's H1 fix and the pattern S-22's fix direction certifies for
auth-service. Had Round 1's grouping been believed, the correct guard would have been
"corrected" into a broken one. S-25 is written to the narrower true version and says so
explicitly (*"Do not 'fix' that helper on the strength of this entry"*) — right call.

### 2 · The M-3 false positive was not live from pid 184537 — **CONFIRMED, with one precision**

Measured: pid 184537's connection is `id=74 … name= age=80176 idle=80176 flags=N db=12 …
cmd=xgroup|create`. Idle on database 12, last command `XGROUP CREATE`, **not** parked on
`XREADGROUP`. With only it connected, the old `list.includes("cmd=xreadgroup")` body returns
`false`. So the condition was not live and the rework is right to have demonstrated the false
positive with a parked read of its own.

The precision: Round 1's *written* M-3 did not claim it was live. It cited the db=12 client only
as evidence that unrelated long-lived clients exist on this server, and made the false-positive
conditional on a future parked read (*"Once this change ships, a worker dev process parked on
`XREADGROUP BLOCK 5000` …"*). The overclaim is in the briefing's paraphrase of M-3, not in the
review text. Both corrections stand; the review record needed no retraction on this point.

I reproduced the whole chain myself, on db 13, with the suite's own `FLUSHDB` untouched:

```
foreign blocking XREADGROUP parked on db 13, nothing on db 14
  old body  (list.includes("cmd=xreadgroup"))                    -> matches 1 row, db=13
  new body  (name=worker-integration-suite AND cmd=xreadgroup)   -> matches 0 rows
  suite, committed body,  foreign read parked  -> 12 passed (12), 453 ms
  suite, old body restored, foreign read parked -> I12 FAIL at :807, "expected true to be false"
```

The `connectionName` scoping is also better than my suggested `db=14`, and the reason given is
correct: `duplicate()` inherits the name, so the subject's read connection is covered without the
subject knowing the name exists. Verified directly — a client built with
`{ connectionName: "t039-r2-probe" }` on db 14 and its duplicate both reported
`name=t039-r2-probe db=14` from `CLIENT INFO`.

### 3 · `U19` was changed to `stopAfter(CALLS.TWICE)` with no assertion weakened — **CONFIRMED**

`stream.consumer.unit.test.ts:954`. Three measurements, because this is the one place a required
fix could have quietly degraded an existing guard:

1. **The change was forced, not chosen.** With the between-pages guard present, `stopAfter(ONCE)`
   is consumed by the guard after page 1, so recovery stops at one page and
   `expect(xautoclaim).toHaveBeenCalledTimes(TWICE)` fails. The predicate is checked in three
   places now, and the case's docblock at `:565-578` states exactly that.
2. **The case still catches what it caught before.** `while (pages < …)` → `if (pages < …)`:
   `U19` red in 10 ms, alongside `U38` and `I10`. So the cursor/pagination property — the thing
   `U19` owns — is still guarded, and its two whole-argument-vector assertions
   (`nthClaimArgs(NONE)`, `nthClaimArgs(ONCE)`) are unchanged.
3. **It did not absorb `U36`'s job.** Removing only the between-pages guard leaves `U19` green
   (`1 failed | 33 passed`, `U36` alone). The two cases are cleanly separated, which is what the
   comment at `:948-951` claims.

---

## Round-1 findings — each fix re-derived by execution

| Round 1 | Status | Evidence on this tree |
|---|---|---|
| **H-1** `run()` can reject | **Fixed** | `run()` is `try { await this.runLoop(); } catch { … }` at `stream.consumer.ts:384-398`. Mutation — delete the `catch` — `Tests 2 failed \| 32 passed (34)`, exactly `U32` (11 ms) and `U33` (1 ms). Claim reproduced verbatim |
| **M-1 / D-1** shutdown during recovery logs ERROR; no between-pages check | **Fixed, both halves, each with its own detector** | Classification at `:698-716`; guard at `:653-676`. Mutation A (remove the `isShutdownInterrupt` branch) → `U35` **only**. Mutation B (remove the guard) → `U36` **only**. The between-pages placement is correct: the terminal-cursor `return` at `:651` precedes it, so a single-page recovery never reaches it — which is why `U33`'s "throws on its second call" comment is still accurate |
| **M-2** `firstReadSettled()` constant-`false` | **Fixed** | `grep -n readSettled` → no match. `U25` (`index.graceful-shutdown.unit.test.ts:356-402`) replaces it with invocation-order assertions. Mutation (start the loop after `listen`) → `U25` red in **60 ms**, `AssertionError: expected 118 to be less than 116` — i.e. `claimOrder < listenOrder`, exactly as the case's own comment predicts. The trailing `listenOrder < readOrder` pair is labelled *"records a measured order rather than detecting a defect"*; that label is honest — I could construct no mutation that reddens it first — and the honest label is the right disposition for a characterization assertion |
| **M-3** `hasParkedRead()` server-wide | **Fixed** | See ruling 2 above. Body at `:584-597`, docstring `:554-582`, in-case comment `:812-821` |
| **M-4 / D-2** default handler untested | **Fixed** | `U34` at `:1228`. Mutation (add `fields` to the default handler's log object) → `U34` **only**, 14 ms. The redaction negative runs over `allLogCalls()`, which throws both when a logger method is missing **and** when nothing was logged (`:687-703`) — N-1 closed properly, in both vacuity directions |
| **M-5** seven inline log literals | **Fixed** | `LOG_MESSAGE` at `:125-154`, fifteen members each cited by the method that writes it rather than by line number. Each of the seven strings now appears **exactly once** in the file (grep). The deliberately-literal fixtures (observed Redis reply texts, `RECOVERY_IDLE_MULTIPLIER).toBe(2)` at `:982`, `PENDING_START_ID).toBe("0-0")` at `:983`) were correctly left literal, each with the reason inline — none was swept into a constant-against-itself tautology |
| **L-1** five cases redden by 5 000 ms timeout | **Fixed** | Under the `duplicate()` → `this.redis` mutation: **23** cases red, longest **2 005 ms**, `grep -c "Test timed out"` → **0**. Spot-checked messages: `U12` *"expected spy to be called 2 times, but got 0 times"*, `U29` *"expected [] to deeply equal [ Array(2) ]"*. Separately, the `U29`-specific mutation (remove `dispatch`'s per-entry `catch`) now fails in **1 019 ms** by assertion, against Round 1's 5 006 ms timeout. See M-6 for the integration-file half that was missed |
| **L-2** `ABANDONED_CONSUMER_NAME` dead | **Fixed as recommended** | `readNewEntryIds` takes a `consumerName` parameter (`:151-156`); `I10` passes it at `:738` |
| **L-3** three untested branches | **Fixed** | `U37` (malformed), `U38` (page limit), and the two loop log lines asserted in `U14` (`:838-846`, including the negative that the not-started path does **not** emit the stopped line) and `U24` (`:1039-1043`). Both new cases were green on arrival — see *Test honesty* below |
| **L-4** bare positional indices | **Fixed** | `READ_REPLY_ENTRIES_INDEX`/`CLAIM_REPLY_CURSOR_INDEX`/`CLAIM_REPLY_ENTRIES_INDEX` at `constants.ts:200-202`, used at `stream.consumer.ts:134`, `:162`, `:165`. `grep -nE "\[[0-9]+\]"` over the source → **no match**. The third `XAUTOCLAIM` element deliberately left unnamed, with the reason |
| **L-5** plan §8 would damage the live fixture | **Fixed in place, with the reason** | `docs/plans/…:705-748`. The replacement uses db 14, a `t039-manual` stream, `node --import tsx` rather than `dev`, and `DEL`s afterwards. The three irreversible consequences are stated and each is attributed to a measurement |
| **L-6** slice-time mutation table not re-run | **Fixed** | Re-derived: `String(error)` → `"unknown"` gives `× U23` (8 ms) **and** `× U18` (1 ms), `2 failed \| 32 passed`. Both by assertion |
| **L-7** `run()` docstring glosses the guard/first-read gap | **Fixed** | `runLoop()`'s docstring `:411-421` states the real sequence and the residual read, and `U35:1289-1294` asserts that read rather than pretending it does not happen |
| **N-1** `?? []` vacuous redaction loop | **Fixed** | `allLogCalls()` throws in both directions |
| **N-2** asymmetric loop log lines | **Addressed** | `U14` now asserts the asymmetry deliberately rather than leaving it unremarked |

---

## Other claims the change makes — re-derived

| Claim | Result |
|---|---|
| `src/constants.ts` is append-only: `128 0`, single hunk `@@ -153,0 +154,128 @@`, S-23's `:38-44` untouched | **True.** `--numstat` `128 0`; the one hunk header matches exactly; `diff` of lines 30-55 against `b558641` is empty. Base 153 lines → 281 |
| `RECOVERY_MAX_PAGES` "admits 10 000 entries per startup at the default `STREAM_BATCH_SIZE` of 10" (`constants.ts:235`) | **True.** `RECOVERY_MAX_PAGES: 1_000`, `DEFAULT_BATCH_SIZE: 10` (`constants.ts:64`) |
| S-25 §1: `vitest.config.mjs:18` excludes `src/events/**`; thresholds at `:25-30`; `stream.consumer.ts` is 777 lines against 1 541 for all of `src/`, larger than the other 764 combined; "fourteen one-line barrel `index.ts`s" | **All true.** `:18` is the glob; `:25-30` is the `thresholds` block (80/80/80/75); `wc -l` → 777 and 1 541, 1 541−777 = 764; exactly 14 `index.ts` files of 1 line each |
| S-25 §2: `INFO clients` and `CLIENT LIST` cross database boundaries; `CLIENT INFO` does not | **True**, all three re-measured (ruling 1) |
| S-25: `flushReservedDb()` is the only `FLUSHDB` chokepoint in the file | **True.** `grep -rn "flushdb\|FLUSHALL"` over `apps/worker-service/tests` → one executable call, `stream.consumer.integration.test.ts:212`, inside the helper. The helper's own docstring correctly scopes this to "every flush *routed through here*", not to an impossibility |
| S-25 is filed under the next free id and does not overstate its relation to S-22/S-14/S-19 | **True.** Committed `known-gaps.md` at `b558641` ends at S-24; S-25 is next. The S-22 paragraph is *verified* rather than asserted — S-22's own wording is about flushes, and S-25 says so and positions itself as "the read-side half". The S-14/S-19 sentence explicitly downgrades the relation ("**not** the same duplication-and-drift mechanism"), which is the right call |
| S-15 corrections: six defects; grep for the five sub-task ids finds nothing in any commit; five plan carriers with `eb3ef10` **A** then `4925e4a` **M`; README `:138` is `\| **Total** \| **73** \| \|` | **All true.** Six `- **…**` bullets; `git log --all --format="%h %s%n%b" \| grep -icE "T[- ]?024[CD]\|T[- ]?067[ABC]"` → `0`, exit 1; `git log --name-status --diff-filter=AM` per plan file gives `d68e719 A`, `e3d7556 A`, `21c9a9e A`, `f47b7d8 A`, and for t-067c `eb3ef10 A` then `4925e4a M`; line 138 exact |
| S-15's new bullet: 76 headings / 75 distinct / 73 declared; epic-4 8 vs 10, epic-12 4 vs 5, epic-13 4 = 4 | **All true.** Summed `grep -cE '^#+ +T-[0-9]+[A-Z]?'` → 76; `sort -u` → 75; `uniq -c` shows `2 T-070`; the README column sums to 73. The bullet's insistence on stating it as 76/75/73 rather than "73 against 75" is correct and worth keeping |
| Plan AC11's row corrected **in place** to `U25`/`U31`, with a note | **True**, `docs/plans/…:586`, and `:619-620` keeps the deviation record |
| `.env.example`: "It does NOT add to shutdown time" | **True**, and doubly so — `index.ts:113` `await streamConsumer?.stop()` precedes `app.close()` (pinned by `U31` and `I12`), and `run()` is never awaited by the shutdown path at all |
| Producer writes every event property as a flat field, so the payload carries `tenantId` (`docs/plans/…:530`) | **True.** `apps/usage-service/src/events/stream.publisher.ts:63-68` is the `Object.entries(event)` loop. So the redaction discipline in `dispatch` and `buildDefaultMessageHandler` is guarding a real exposure, and `U34`/`U29` pin it |
| Mutation: `void run()` → `await run()` | **10** shutdown cases red, ~1 005 ms each (`vi.waitFor` budget, not a hang). Unchanged from Round 1 |

### Test honesty

- **`U37`/`U38` were green on arrival, and the implementer says so.** That is the right
  disclosure, and it is **adequate here**: both close Round-1 L-3 coverage gaps on behaviour that
  already shipped, so redness-first is impossible by construction and mutation is the only
  available proof. I did not take the implementer's mutations on trust — I performed my own, and
  each reddens the owning case alone: `parseEntry`'s `return null` → `continue` (filter the bad
  field instead of dropping the entry) → `U37` only, 9 ms; delete the page-limit `warn` → `U38`
  only, 10 ms; `pages < RECOVERY_MAX_PAGES` → `pages < Number.MAX_SAFE_INTEGER` → `U38` only,
  **2 009 ms by assertion, not a hang**, because `stopWhen`'s 2 000 ms deadline is inside the
  runner's budget. That last one is the shape M-6 is missing in the integration file.
- **No tautologies found** in the cases added this round. `U34`, `U35`, `U36`, `U37`, `U38`,
  `U32`, `U33` each redden under a mutation that no other case notices, or under one where the
  overlap is explained.
- **No short-circuits found.** No `return`/`skip` guarded on a condition that is true when the
  bug is present; `allLogCalls`, `nthReadArgs` and `nthClaimArgs` all throw rather than pass
  vacuously; `flushReservedDb` throws rather than silently skipping.
- **`U19` is the only pre-existing case whose driver changed**, and it was not weakened
  (ruling 3).

---

## Compile-time gate — all 13 packages, `--force`, 0 cached

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | **13 successful / 13 total, 0 cached**, exit 0 |
| lint | `pnpm lint --force` | **13 successful / 13 total, 0 cached**, exit 0, 14 warnings |
| build | `npx turbo run build --force` | **13 successful / 13 total, 0 cached**, exit 0 |
| test | `pnpm test --force` | **13 successful / 13 total, 0 cached**, exit 0 |

Per-package test totals: `worker-service` **7 files / 99 tests** (Round 1: 7/92) ·
`usage-service` 19/230 · `auth-service` 15/164 · `gateway` 8/38 · `analytics-service` 4/18 ·
`billing-service` 4/18 · `shared-utils` 1/18 · `shared-validation` 1/15 · `shared-types` 1/8 ·
`shared-config` 1/4 · `shared-logger` 1/4 · `shared-tracing` 1/2 · `web` (task ran, no vitest
summary). `sdk` has no `test` task, which is why turbo reports 13 and not 14.

**Warnings — 14, all pre-existing, proven:**

- 10 × `@typescript-eslint/no-misused-promises`, `apps/auth-service/tests/auth.service.unit.test.ts`.
  `git log -1` → `d68e719` (2026-08-25). Absent from `git diff --name-only`.
- 4 × `@typescript-eslint/no-unsafe-assignment`, `apps/usage-service/tests/ingestion.service.unit.test.ts`.
  `git log -1` → `b0f6921` (2026-08-31). Absent from `git diff --name-only`.

`worker-service:lint` emits **zero** warnings. `grep -c no-unsafe-return` over the whole lint log
is **0**, confirming none was reintroduced. The two warning files are the same two, at the same
counts and the same commits, as Round 1 — no drift.

---

## Environment discipline

- **Database 0, before and after:** `telemetry:events` `XLEN 2`, `entries-added 2`,
  `last-generated-id 1788171536033-0`, `XINFO GROUPS` **empty** (1-byte reply), ids
  `1787746970722-0` / `1788171536033-0`. Identical on every field. `DBSIZE` went 1 → 2, the extra
  key a self-expiring `denylist:ddc0217…` (TTL 555 s) written by **auth-service** during the root
  `pnpm test` — **S-22**, reproduced independently again, not attributable to T-039.
- **Database 14:** `DBSIZE 0` before and after. I issued no `FLUSHDB` directly; every flush went
  through the suite's `flushReservedDb()`, which re-asserts `db=14` on each call.
- **Database 13** carried three disposable probes (the `CLIENT LIST`/`CLIENT INFO` scope probes
  and the parked-read false positive). Its clients were killed by `CLIENT KILL ID`, its keys
  removed, `DBSIZE 0` at review end. Reserved by nothing.
- **pid 184537** inspected (`ps`, `CLIENT LIST`) and otherwise untouched; still running.
  Postgres and Redis left running throughout.
- **Tree:** `md5sum -c` over all 11 files → all OK. `git status --porcelain` diffed against the
  review-start snapshot → identical. Three throwaway probe files were created under
  `apps/worker-service/tests/` and deleted; none appears in the final status.
- **Mutations performed and reverted:** 11 — delete `run()`'s `catch`; remove the recovery
  shutdown classification; remove the between-pages guard; recovery `while` → `if`; remove the
  page-limit `warn`; unbound the page limit; `describeError`'s `String(error)` → `"unknown"`;
  `duplicate()` → `this.redis`; remove `dispatch`'s per-entry `catch`; `parseEntry`'s
  `return null` → `continue`; default handler logs `fields`. Plus two on `index.ts` (`void` →
  `await`, loop after `listen`) and one on the integration test (`hasParkedRead`'s old body).

---

## What I could not verify, and why

- **The rework's red-first claims for `U32`, `U33`, `U35`, `U36`.** The intermediate trees do not
  exist, so "red first" is not re-derivable. I verified the equivalent and stronger property on
  the final tree — each case reddens under the mutation that removes the code it guards, and
  under nothing else — but the *sequence* (test written before implementation) is taken on the
  implementer's word, as it was in Round 1.
- **The measured invocation orders `118`/`119`.** Counter values depend on how many mock
  invocations precede them in the file; I reproduced the *relation* (`claimOrder < listenOrder`,
  and its mutation giving `expected 118 to be less than 116`) but the specific pair is not a
  stable quantity and nothing rests on it.
- **`I12` on a loaded CI runner.** `STOP_BUDGET_MS` 2 000 against a 5 000 ms block is loose by
  design; measured on an unloaded machine only. Note that M-6 makes this worse than it looks: if
  a slow runner ever stopped `I12`'s read from parking, the `vi.waitFor` at `:826` would report a
  runner timeout rather than the assertion.
- **Redis versions other than 7.0.15**, and ioredis other than 5.11.1. The `XAUTOCLAIM`
  three-element reply, the `NOGROUP` text, `Connection is closed.`, `CLIENT LIST`'s row format
  and `duplicate()`'s inheritance of `connectionName` were all measured on those two versions
  only. CI's `redis:7-alpine` agrees on the major; nothing here was exercised on 6.x or a managed
  Redis.
- **Production likelihood of `logger.error` throwing** (M-7). I proved the path exists; I did not
  and cannot measure how often a pino logger throws in this deployment. The finding is about the
  universal, not the likelihood.
- **The Appendix A/B millisecond transcripts** (2 080 ms shared-connection `PING`, 4 813 ms
  `quit()`, 205 ms `disconnect()`, 153/603 ms rejection latencies, 391 ms `null`). Inherited from
  the plan and unverified here, as in Round 1; none is load-bearing for a branch, only for
  decisions the user already made.
- **The Copilot mirror (S-14).** This change touches no agent definition, so S-14's
  apply-to-both-copies rule does not bite. Not otherwise checked.

**Corroboration of S-24, worth one line as the briefing asked.** The `.claude/rules/known-gaps.md`
injected into *this* session ends at **S-23**. On disk, S-24 is committed at `b558641` and S-25 is
added by this change. So a review agent was again handed a stale snapshot of a directory
`CLAUDE.md` designates authoritative and instructs agents to trust without re-verification —
S-24 reproducing itself, for at least the third recorded time, and independently of the
implementer's own report of the same thing. Recommend adding this sighting to S-24's list; it is
not this task's to fix and should not be folded into this commit.

---

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| A regression in the recovery pagination reddens `I10` as a 5 s runner timeout naming nothing | **Required fix, M-6.** Measured, one constant |
| A later agent reads the plan's "unreachable and no test could cover it" as licence to treat `run()` as total | **Required fix, M-7.** Text only; the ratified decision stands and gains a better reason |
| A reader trusts "one microtask turn" and assumes the first read is effectively synchronous with `listen` | **L-8.** Text only |
| A future case opens an unnamed client that parks on a read, and `hasParkedRead` silently stops seeing it | **L-9.** Prefer naming the clients at `:356`, which makes the docblock true rather than narrower |
| The plan's diagram sends the next reader to the wrong lines in two files | **L-10.** Third instance of this class in this plan; one sentence fixes it |
| `CALLS.ONCE` as an array index misleads at the one place the redaction negative is expressed | **L-11.** Cheap, and in a file already open |
| A timed-out integration case leaves its consumer loop running; because the read connection inherits `connectionName`, the *next* case's `hasParkedRead()` can see it | **Accepted, not a finding.** Observed only as a cascade under my pagination mutation (`I12` red at 12 ms after `I10` timed out). Nothing leaks on the green tree, and M-6's fix makes the trigger legible. Worth a sentence in the case comment if anyone touches it |
| `run()` still rejects if `this.logger.error` throws | **Accepted, documented at `stream.consumer.ts:374-376`.** A `.catch()` at the call site would log through the same logger and be inert exactly when reachable |
| `src/events/**` outside coverage; the read-side hole in the per-suite database convention | **Filed as S-25**, verified, correctly scoped. Closed as a review concern |

---

## Decision for the user

One, and it is about scope rather than design. Nothing below changes what the service does at
runtime.

### Which Round-2 findings go in before the commit?

| Option | What changes | Cost |
|---|---|---|
| **A — all six** *(recommended)* | M-6 (one constant + its docblock), M-7 (one plan paragraph), L-8, L-9, L-10, L-11 | ~30 minutes, all in files already open. Re-verify with two commands: `pnpm --filter @telemetry/worker-service exec vitest run` (99/99) and the M-6 mutation, which must then name an assertion rather than time out |
| B — the two MEDIUMs only | M-6 and M-7; L-8/L-9/L-10/L-11 deferred with a note in the plan | Leaves four false or misleading statements in files this commit introduces, two of which (L-9, L-10) are the kind the next task inherits |
| C — commit as is; file M-6 as a new known gap | No edits | Records a test-harness defect as a standing gap when the fix is a single number, which is the pattern `known-gaps.md`'s own preamble discourages. Not recommended |

**Recommendation: A.** Every item is text or a constant, none touches `src/` behaviour, and the
whole set is re-verifiable without a full review round — which is the point: **this should not
become a third round.** I am content for Gate 5 (QA) to confirm the six edits rather than
returning here.

---

**Verdict: CONDITIONAL.** Required before commit: **M-6** and **M-7**. Recommended in the same
pass, because they are cheap and in files already open: **L-8, L-9, L-10, L-11**. Every Round-1
finding — H-1, M-1 through M-5, L-1 through L-7, N-1, N-2 — is fixed, and each fix was
re-derived here by a mutation I performed rather than by reading the diff. The design is
unchanged and correct: the loop, the two-layer shutdown classification, the between-pages guard,
the recovery pagination, the dedicated read connection and the `stop()`-before-`close()` ordering
are all guarded by cases I made fail. No tenant-isolation or injection finding: this task opens
no database connection, derives no tenant context and issues no SQL, and the one tenant-bearing
surface it does touch — the stream payload — is kept out of every log line in the file, asserted
positively by `U34` and `U29`.

---

## Round 3 — final

**Gate 6 (Senior Reviewer, post-QA).** Subject: the uncommitted working tree at base `b558641`,
including the four post-QA edits made by the orchestrator (F-3's `BLOCK_MS_LONG`, two stale
numerals, S-26 in `.claude/rules/known-gaps.md` plus three test scope comments, and plan §4's
F-2 note). Line numbers below were re-derived on **this** tree, not carried forward.

**Verdict: CONDITIONAL.** The code is sound and the full gate is green — no production line needs
to change. Every required fix is in `.claude/rules/known-gaps.md` and in test comments, and all
of them are in the post-QA edits rather than in the implementation. Three of the four post-QA
edits stand up; the S-26 entry does not, and it is the one file in this change that other agents
are instructed to trust without re-verification.

### Findings

#### H-2 · S-26's central claim is a false universal — the lines **are** emitted in production at short block values — `.claude/rules/known-gaps.md:742`, `:747-749`, `:751-753`

`known-gaps.md:742` (the heading, "never reach a deployed worker") and `:747-749` ("The exit
therefore wins the race, and neither `"Stream read interrupted by shutdown"` nor
`"Stream consumer loop stopped"` is emitted in production") state a universal. The evidence at
`:751-753` is three real `SIGTERM` runs — all at the **default** `STREAM_BLOCK_MS=5000`. That
varies one dimension, which `.claude/rules/review-standards.md` § *Universals Must Cite Their
Mutation* says is not an establishment.

Refuted by running the case the probes did not: `STREAM_BLOCK_MS` is
`z.coerce.number().int().positive()` (`apps/worker-service/src/config/env.ts:44-48`) — any
positive integer is a legal operator setting. Five real `SIGTERM` runs of
`node --import tsx src/index.ts` against Redis db 14, disposable stream, `STREAM_BLOCK_MS=20`:

```
run1: "Stream consumer loop stopped" = 1      run4: = 1
run2: = 0                                      run5: = 1
run3: = 1
```

Four of five emit it. Control runs at the same command with `STREAM_BLOCK_MS=500` (3 runs) and
`5000` (1 run): **0** occurrences, reproducing what QA measured.

The mechanism, measured from the log timestamps: the whole shutdown handler runs in **3–6 ms**
(`"Shutting down gracefully"` → `"Shutdown complete"`: 3 ms at block 5000, 5 ms at 500, 6 ms at
20), while `disconnect()` takes ~205 ms to reject an in-flight read. So the lines appear exactly
when the parked read returns *by block expiry* inside that few-millisecond window — at block 20
the `"Stream consumer loop stopped"` line lands at **+4 ms**, before `"Shutdown complete"` at
+6 ms. The true statement is about the *relation* between `STREAM_BLOCK_MS` and the residual
shutdown work, not about the lines.

**Fix (docs only).** Re-title S-26 to something like "…are unobservable at the default
`STREAM_BLOCK_MS`", and replace `:747-749` with the measured scope: *"With `STREAM_BLOCK_MS` at
or near its 5 000 ms default the exit wins the race and neither line is emitted (measured, 3
runs at 5 000 ms and 3 at 500 ms). At small block values the parked read expires inside the
3–6 ms the rest of shutdown takes, and `"Stream consumer loop stopped"` **is** emitted —
measured 4 of 5 runs at `STREAM_BLOCK_MS=20`."* Note that
`"Stream read interrupted by shutdown"` was **not** observed in any of the nine runs, and say so
as an observation rather than as an impossibility.

#### H-3 · S-26 names the wrong tests, and the three scope comments landed on cases that do not assert either line — `.claude/rules/known-gaps.md:760-766`; `stream.consumer.unit.test.ts:1062-1068`, `:1278-1284`; `stream.consumer.integration.test.ts:799-805`

`:760-761` reads "three tests — `U26`, `U35` and `I12` — assert those log lines". Checked
against the tree, by reading every assertion in each case and by grep:

| Line S-26 names | Asserted by |
|---|---|
| `"Stream read interrupted by shutdown"` (`stream.consumer.ts:517`) | **nothing.** `grep -rn "Stream read interrupted" apps/worker-service/src apps/worker-service/tests` returns exactly one hit, the source line itself. There is no `LOG_MESSAGE` member for it |
| `"Stream consumer loop stopped"` (`stream.consumer.ts:455`) | `U14` (`stream.consumer.unit.test.ts:861`) and `U24` (`:1057`), via `LOG_MESSAGE.LOOP_STOPPED` — **neither of which carries a scope comment** |

And the three cases that *did* get the comment:

- **`U26`** (`:1061`) asserts `runPromise` resolves, `readConnection.disconnect` was called,
  `mockLogger.error` was **not** called, and `xreadgroup` ran once. It asserts the *absence* of
  an error, never the presence of an info line. So S-26's stated reason for filing — "a reader
  can reasonably take a passing `U26` as evidence that a shut-down worker says so in its logs" —
  is wrong about `U26`.
- **`U35`** (`:1277`) asserts a **third** message, `LOG_MESSAGE.RECOVERY_INTERRUPTED`
  ("Pending-entry recovery interrupted by shutdown", `:1318`), which S-26 does not mention.
- **`I12`** (`stream.consumer.integration.test.ts:798`) asserts elapsed time, the parked-read
  transition and `handled == []`. It makes **no logger assertion at all**, so the comment's
  "this line" (`:801`) has no referent in the case it is attached to.

The finding S-26 is trying to record is real; its remediation is aimed at the wrong five cases.

**Fix (docs/comments only).** Correct `:760-766` to name `U14:861` and `U24:1057` as the cases
that assert `LOOP_STOPPED`; state that `"Stream read interrupted by shutdown"` is asserted
nowhere; and move the scope comment to `U14` and `U24`. Drop it from `I12` entirely (nothing
there to scope) and requalify `U26`'s and `U35`'s to what those cases actually claim — for
`U35`, name `RECOVERY_INTERRUPTED`, which is subject to the same race.

#### H-4 · S-26's fix direction inverts the test it cites, and understates what dropping the `void` does — `.claude/rules/known-gaps.md:772-776`

`:774-775`: *"Do not simply drop the `void` — that would delay `listen` behind the first
`XAUTOCLAIM` round trip and break `U25`, which asserts the loop starts **after** the listener
binds."* Both halves are wrong, and T-043 is the audience.

- `U25` is titled *"reclaims and starts the loop **before** the listener binds, without delaying
  it"* (`index.graceful-shutdown.unit.test.ts:356`) and asserts
  `expect(claimOrder).toBeLessThan(listenOrder)` at `:371`. It asserts the loop starts *before*
  the listener, which is the opposite of what S-26 says.
- Dropping the `void` does not delay `listen` by a round trip — it prevents `listen` from ever
  being reached, because `run()` only returns at shutdown. Measured: I changed
  `src/index.ts:143` to `await streamConsumer.run();` and ran the shutdown suite —
  `Tests 10 failed | 2 passed (12)`, every failure at ~1 007 ms, including `U7`, `U25`, `U31`
  and the four signal cases. `U25`'s own comment at `:374-377` already says this ("if `run()`
  were awaited instead of `void`-ed, `listen` would never be reached … which reddens ten cases
  in this file"). Mutation reverted; `md5sum -c` clean.

**Fix.** Rewrite `:774-775` as: *"Do not simply drop the `void`: `run()` only returns at
shutdown, so awaiting it means `app.listen(...)` is never reached — measured, ten of the twelve
cases in `tests/index.graceful-shutdown.unit.test.ts` go red, including `U25`, which asserts the
opposite order (`claimOrder < listenOrder`, i.e. recovery starts before the listener binds)."*

#### M-8 · AC8's own log line is asserted by no test — `stream.consumer.ts:512-518`

`"Stream read interrupted by shutdown"` is the line AC8 ("a read interrupted by shutdown ends
quietly") is about, and nothing pins its fields or its text. `U26` pins only the negative
(`mockLogger.error` not called), so replacing the whole `info` call with nothing leaves the suite
green. It is also the only loop message with no `LOG_MESSAGE` member in the unit file — which is
how it escaped M-5's sweep and H-3's mis-citation alike.

Coverage confirms the *branch* runs (see the coverage-alignment ruling below); it is the content
that is unasserted.

**Fix.** Add `READ_INTERRUPTED: "Stream read interrupted by shutdown"` to `LOG_MESSAGE`
(`stream.consumer.unit.test.ts:125-154`) and one assertion in `U26`, mirroring `U35:1312-1319`:
`expect(mockLogger.info).toHaveBeenCalledWith({ streamName, groupName, consumerName },
LOG_MESSAGE.READ_INTERRUPTED)`. Two lines.

#### L-12 · `RUN_DEADLINE_MS`' docblock says it sits "below" `BLOCK_MS_LONG`; F-3 made them equal — `tests/integration.constants.ts:222-224`

`:222` reads "`I12` does not use `buildLoopHarness`, so this sitting below `BLOCK_MS_LONG` is
safe." Both constants are now `3_000` (`:178`, `:224`). Harmless in effect — `I12`'s use of
`RUN_DEADLINE_MS` is a `vi.waitFor` on the parked read, which resolves in ~26 ms — but the
sentence is false as written, and it is the sentence a future editor would rely on when changing
either number. **Fix:** "…so this being equal to `BLOCK_MS_LONG` is safe: `I12` uses
`RUN_DEADLINE_MS` only for the `vi.waitFor` that observes the read parking (~26 ms measured),
not as a loop deadline."

#### L-13 · Two more stale `5 000 ms` numerals the F-3 sweep missed — `tests/stream.consumer.integration.test.ts:433` and `:849`

- `:433`, in the suite docblock's list of what only a live server can prove: "that `stop()` does
  not wait out a real **5 000 ms** block." The block is now 3 000. **Fix:** "a real multi-second
  block", or cite `BLOCK_MS_LONG`.
- `:849`, inside `I12`: "`quit()`, which `app.close()` triggers, took 4 813 ms against the same
  5 000 ms read". "the same … read" now points at a block this case does not use. **Fix:** "against
  a 5 000 ms read in the same probe".

The other seventeen `5 000`/`5000` occurrences in `apps/worker-service/src` and `tests` are
correct — they are either `DEFAULT_BLOCK_MS` (`constants.ts:63`), the vitest budget, or quoted
probe measurements against a `BLOCK 5000` fixture. Full sweep run:
`grep -rn "5 000\|5_000\|5000" src tests`.

#### L-14 · "`ensureConsumerGroup` is **not** modified" is false — `docs/plans/t-039-stream-consumer-loop.md:379`, echoed at `docs/qa/t-039-stream-consumer-loop.md:319`

Extracted both versions of the method by brace-matching and diffed them. It changed:

```
-      const errorMessage = error instanceof Error ? error.message : String(error);
       this.logger.error(
-          error: errorMessage
+          error: describeError(error)
```

Behaviour-preserving (`describeError` at `stream.consumer.ts:407-408` is the same expression) and
covered by `U22`/`U23`, so this is a record-accuracy finding, not a risk. Worth correcting
because it is also why the inherited LOW-4 mutation now reddens `U18` as well as `U23`: the
helper is shared with the loop's error paths. **Fix:** plan `:379` → "`ensureConsumerGroup`'s
behaviour is unchanged; its inline `error instanceof Error ? … : String(error)` is replaced by
the shared `describeError` helper, which the loop's error paths also use."

#### L-15 · S-25's line-count itemization is stale, and the margin it rests on is now 6 lines — `.claude/rules/known-gaps.md:660-665`

Re-measured with the command the entry names: `stream.consumer.ts` **777** ✅, but `src/` total
is **1 548**, not 1 541, and the rest of `src/` is **771**, not 764 — `index.ts` is **152**, not
145, having grown by the L-8 correction at Round 2. The load-bearing claim ("larger than every
other source file added together") survives, 777 > 771, but by six lines rather than thirteen;
the next task to touch `index.ts` flips it without anyone editing the sentence. **Fix:** update
the three numbers and state the conclusion as "roughly half of `src/`" rather than as a
comparison that a seven-line edit can invert.

#### L-16 · `stream.consumer.ts:271` cites `index.ts:74`; the construction site is now `:103-108`

The comment text predates this change (`git show b558641:…` has it verbatim), but T-039 is what
moved the target — line 74 is now `container.logger.error({ error, signal }, …)` inside the
shutdown `catch`. This is the fourth stale-citation instance in this task after Round 1's two and
Round 2's L-10. **Fix:** drop the number and cite the call by name ("the sole construction site
in `src/index.ts`, which passes `container.env`"), which is what L-10 concluded for the plan.

#### L-17 · The F-2 note's divergence arithmetic does not match the section it sits in — `docs/plans/t-039-stream-consumer-loop.md:266-267`

The note calls itself "the **fourth** divergence this task found in this one epic entry, after
the missing error handling, the cursor-less `XAUTOCLAIM`, and the unreachable pre-group backlog."
Two problems, both checkable against §4 itself:

- §4's own lead (`:270-272`) says the snippet is "wrong in **four** ways", so this is at least the
  fifth, not the fourth.
- "the unreachable pre-group backlog" is §4 **finding 6**, which is explicitly titled *"Correction
  to an inherited environment claim"* and begins "The briefing for this task says…". It is a
  correction to the task briefing, not an epic divergence. Meanwhile §4's fourth epic item — the
  free-variable `shuttingDown` whose import boots the worker — is not counted.

Everything else in the note is accurate and I verified it: `docs/epics/epic-7-worker-service.md:84`
does read "Read batches from the stream, process each message, acknowledge on success", and
`I7` (`:630-633`), `I9` (`:713-716`) and `I10` (`:761-763`) each assert the pending list by id
through `readPendingIds`, which issues a real `XPENDING` and throws on a non-array reply
(`:544-555`). **Fix:** "the fifth divergence … after the missing error handling, the cursor-less
`XAUTOCLAIM`, the non-null empty reply shape, and the free-variable `shuttingDown`."

#### L-18 · Six parser branches have no test, including one whose behaviour the docstring specifies — `stream.consumer.ts:62`, `:67`, `:85`, `:129`, `:158`, `:166`

See the coverage ruling below for how this was measured. The one worth a case is `:166`
(`nextCursor: typeof rawCursor === "string" ? rawCursor : null`): `parseClaimReply`'s docstring
at `:152-154` makes a behavioural claim about it — *"A cursor that is not a string yields `null`,
which the caller treats as 'stop paginating' rather than as 'start again from the beginning' —
the latter would loop forever"* — and nothing exercises the `null` arm. **Fix:** one unit case
feeding `autoclaimReply` with a non-string cursor and asserting exactly one `xautoclaim` call.
The other five are `isUnknownArray` rejections of shapes never observed on 7.0.15; leaving them
untested is defensible, and I would not hold the commit for them.

#### NIT · `vi.advanceTimersByTimeAsync(CALLS.NONE)` — `stream.consumer.unit.test.ts:887`, `:916`

The category error the plan records as deliberately out of Round 2's scope. `CALLS` is documented
at `:515` as "Call counts"; here it is a millisecond duration. Two sites, one line each. I agree
with the decision not to fold it into the rework, and it should not hold the commit — but it
should not evaporate either: it belongs in the same follow-up as `INDEX`, or as the first line of
whatever next touches this file.

### Rulings on the five questions asked

#### 1 · Is S-26 LOW, and are the tests mis-scoped?

**LOW is right for the gap. The tests are correctly scoped; the fix is not.**

The consequence is observability, not data: nothing is acknowledged (D2-A, proven by `XPENDING`
in three integration cases), the read connection is disconnected before exit, and draining is
T-043's by the approved plan. LOW.

`U26`, `U35` and `I12` are **not** mis-scoped. Each constructs a `StreamConsumer` and calls
`stop()` on it; each asserts something the class genuinely does; none of them claims anything
about `index.ts`. A class-level test that is true of the class is not a dishonest test — and the
relevant honesty bar (`.claude/rules/testing.md`: does it assert behaviour, or echo a mock?) is
met, as QA's four failed attacks on `I12` showed independently.

So this is a finding **against the fix**, as you suspected, not against the code — but in a
different place from the one you were checking. The comments are not merely over-strong: two of
the three are attached to cases that do not assert the lines at all (H-3), and the two cases that
do assert `LOOP_STOPPED` were left unannotated. The substantive correction is H-2's scoping plus
H-3's relocation; no test body changes.

#### 2 · Coverage alignment for the excluded `src/events/**`

**Measured rather than argued.** I ran the worker suite with the S-25 exclusion lifted —
`npx vitest run --coverage --coverage.exclude='src/**/*.d.ts' --coverage.exclude='src/**/index.ts'
--coverage.exclude='src/startup.constants.ts' --coverage.exclude='src/config/container.ts'`
with thresholds zeroed, then deleted the `coverage/` directory (gitignored;
`git status --porcelain` identical before and after):

```
src/events/stream.consumer.ts
  statements 97.03 (360/371) · branches 93.25 (83/89) · functions 100 (21/21) · lines 97.03
src/events (dir)  97.03 / 93.25 / 100
All files         89.37 / 92.38 / 100
```

It would clear the service's own 80/75 thresholds comfortably. **Every error path in the loop is
covered**: the `NOGROUP` repair and its failure, the generic read failure and its backoff, the
non-`Error` rejection, the shutdown-interrupt classification in both `readBatch` and
`recoverPendingEntries`, the per-entry handler rejection, the recovery failure that does not stop
the loop, the page-limit warn, and `run()`'s outer `catch` (`U32`/`U33`).

The uncovered set is exactly six defensive shape checks in the parsers — lines 63-64, 68-69,
86-87, 130-132, 159-160 and the false arm of the ternary at 166, from `lcov.info` — i.e. replies
that are not arrays where an array is expected, plus the non-string cursor. See L-18: five are
fine untested, one has a documented behaviour and no case.

**What the number does not say** is anything about `src/index.ts`, which is excluded by
`src/**/index.ts` and is where H-2 and H-4 both live. That exclusion is broader than S-25
describes and is worth naming when epic-12 picks S-25 up.

#### 3 · Release readiness and the T-038 bootstrap contract

Satisfied, verified independently of QA:

- **Bootstrap contract holds.** `ensureConsumerGroup`'s behaviour is unchanged (L-14 is a
  refactor of the error-description expression, nothing else), and it is now also the `NOGROUP`
  repair path. `I1`–`I6` and `U1`–`U10` pass unchanged inside the 99.
- **No breaking change across the other 12 packages.** `grep -rn "worker-service"
  --include=package.json apps packages` finds no dependent — worker-service is a leaf. The only
  added exports are additive (`WORKER_STREAM_READ`, `StreamMessageHandler`). The one
  contract-narrowing change, `StreamConsumer`'s required 4th constructor parameter, is confined
  to worker-service and is enforced by a green typecheck across 13 packages.
- **Non-worker files touched: `.claude/rules/known-gaps.md` only** (`git diff --name-only`).
- ACs: AC1–AC11 and AC13 are each proven by a case QA reddened by mutation and I did not
  re-derive individually; AC12 (the S-15 docs correction) I re-derived by command — see below.
  **AC8 has the one gap**: its `info` line is unasserted (M-8), and the *production* observability
  of that line is H-2's subject.

#### 4 · Dispositions for the open handoffs

| Item | Disposition |
|---|---|
| **S-26 fix direction** (await `run()` with a bounded timeout before `process.exit(0)`) | **Keep, correct H-4's two errors first.** T-043 owns shutdown draining and this is the same change. Do not let it ship with an inverted `U25` citation |
| **F-2 / epic `:84` "acknowledge on success"** | **Keep as the plan §4 note, plus fix L-17's arithmetic.** Correcting `epic-7-worker-service.md:84` itself is out of scope here and belongs with S-15's backlog reconciliation; do **not** fold an epic edit into this commit |
| **LOW-4's successors** (plan §10 → T-040 handler seam and S-19; T-041 `XAUTOCLAIM`'s third element; T-043 consumer-row persistence; epic-12 the coverage exclusion) | **Durably filed where it matters.** The epic-12 item is S-25, which is in `known-gaps.md`; the other three live only in `docs/plans/§10`, which `CLAUDE.md` says is not a durable record. Not a blocker — T-040 and T-041 will read this plan — but if any of them slips, S-19's precedent says file it |
| **`vi.advanceTimersByTimeAsync(CALLS.NONE)`** | **Agree with deferring; do not silently drop it.** Recorded as this round's NIT so it survives the plan. One line, either now or in the next task to open that file |
| **M-8** (unasserted AC8 log line) | **Recommended in this commit** — two lines, and it is the assertion H-3's correction will make readers look for |

#### 5 · Non-convergence — is the deadline class closed?

**Narrowed, not structurally closed. A fourth instance is possible, and it would be found the
same way: by review.** L-1 (unit cases dying of the runner's 5 000 ms), M-6 (`RUN_DEADLINE_MS`
10 000 > 5 000) and F-3 (`BLOCK_MS_LONG` 5 000 = 5 000) are one class. What they have in common
is not the number but the *absence of a mechanism*: the budget is vitest's default, asserted
nowhere, and each deadline constant is checked against it by a human reading a docblock.

Two residuals remain after F-3:

1. **Nothing pins the budget.** Adding `testTimeout` to `apps/worker-service/vitest.config.mjs`
   would silently invalidate the reasoning in three docblocks
   (`integration.constants.ts:165-177`, `:205-223`, `stream.consumer.unit.test.ts:538-541`) with
   no test going red. The docblocks' own claim that nothing overrides it is currently true — I
   re-ran their grep, and the only hit is the comment stating it.
2. **Nothing bounds the sum.** `I12` awaits `vi.waitFor(..., { timeout: RUN_DEADLINE_MS })` at
   `:839` and then a `stop()` bounded by `BLOCK_MS_LONG` — 3 000 + 3 000 = 6 000 against a 5 000
   budget. It does not bite today (the `waitFor` resolves in ~26 ms, and I measured the regression
   failing at **3 109 ms** by assertion), but the guard is per-`await`, not per-case.

**What would close it structurally**, in ~10 lines and worth doing in T-040 or T-043 rather than
here: declare `testTimeout` explicitly in `vitest.config.mjs`, export it as
`CASE_BUDGET_MS`, import it into `integration.constants.ts`, and add one unit assertion that
`BLOCK_MS_LONG < CASE_BUDGET_MS`, `RUN_DEADLINE_MS < CASE_BUDGET_MS` and
`RUN_DEADLINE_MS + BLOCK_MS_LONG < CASE_BUDGET_MS`. Then the fourth instance is a red test rather
than a review catch, and the budget stops being an implicit dependency on a library default.

### F-3's margin — checked, and it is right

The question was whether 3 000 leaves enough headroom. Measured both directions:

- **Regression path.** `stop()`'s `disconnect()` removed (`stream.consumer.ts:476`):
  `I12` fails at **3 109 ms** with
  `AssertionError: expected 3083 to be less than 2000` at `:851` — the `STOP_BUDGET_MS`
  assertion, exactly as intended, with ~1.9 s of runner headroom. Round 2 measured the same
  regression as `Test timed out in 5000ms`. Mutation reverted; `md5sum -c` over all 36 tracked
  files clean.
- **Passing path.** The whole integration file runs in **451 ms** of test time (12/12), so
  `I12`'s measured elapsed is far inside `STOP_BUDGET_MS: 2_000`. The 205 ms `disconnect()`
  figure is a property of `disconnect()` and not of the block length, which the reworded
  `STOP_BUDGET_MS` docblock (`:180-188`) now says correctly.

The two stale numerals the sweep caught were real; it missed three more (L-12, L-13 ×2).

### Compile-time gate — all 13 packages, `--force`, 0 cached

My own run on this tree, not replayed:

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck --force` | **13 successful, 13 total**, `0 cached`, 9.376s, exit 0 |
| Lint | `pnpm lint --force` | **13 successful, 13 total**, `0 cached`, 26.144s, exit 0 |
| Build | `npx turbo run build --force` | **13 successful, 13 total**, `0 cached`, 20.579s, exit 0 |
| Test | `pnpm test --force` | **13 successful, 13 total**, `0 cached`, 17.51s, exit 0 |
| Smoke | `pnpm test:smoke` | 6 suites, 7 tests, all passed, exit 0 |

Per-package tests, all passing: shared-types 1/8 · shared-logger 1/4 · shared-tracing 1/2 ·
shared-config 1/4 · shared-validation 1/15 · shared-utils 1/18 · billing 4/18 · analytics 4/18 ·
gateway 8/38 · **worker 7 files / 99 tests** · usage 19/230 · auth 15/164 · web (no suite).
Worker matches the stated 7/99 baseline exactly.

**14 lint warnings, 0 errors, and `grep -c "no-unsafe-return"` over the log → 0.** Pre-existence
proven, not asserted:

| Count | Rule | File | `git log -1` | In `git diff --name-only`? |
|---|---|---|---|---|
| 10 | `no-misused-promises` | `apps/auth-service/tests/auth.service.unit.test.ts` | `d68e719` | no |
| 4 | `no-unsafe-assignment` | `apps/usage-service/tests/ingestion.service.unit.test.ts` | `b0f6921` | no |

`git diff --name-only | grep -c "auth.service.unit\|ingestion.service.unit"` → `0`. None of the
14 is attributable to T-039, and none was waved through as pre-existing without that check.

### Claims re-derived by execution this round

| Claim | How | Result |
|---|---|---|
| S-26: the teardown lines never reach production | 9 real `SIGTERM` runs at 3 block values | **Refuted** — H-2 |
| S-26: `U26`/`U35`/`I12` assert those lines | read every assertion; `grep -rn "Stream read interrupted"` | **Refuted** — H-3 |
| S-26: dropping `void` delays `listen`, breaks `U25` | mutated `index.ts:143` to `await` | **Refuted** — 10/12 red, `listen` never reached — H-4 |
| F-3: 3 000 leaves margin both ways | removed `stop()`'s `disconnect()`; ran `I12` | **Confirmed** — 3 109 ms, by assertion |
| Plan §4 F-2: `I7`/`I9`/`I10` pin non-ack via `XPENDING` | read all three cases and `readPendingIds` | **Confirmed** |
| Plan §5: `ensureConsumerGroup` not modified | brace-extracted both versions and diffed | **Refuted** — L-14 |
| S-25: 777 lines, larger than the rest of `src/` combined | `find … | xargs wc -l` | **Conclusion holds**, itemization stale — L-15 |
| S-15: 76 headings / 75 distinct / README 73 | `grep -cE '^#+ +T-[0-9]+[A-Z]?'`, `sort -u`, `sed -n 138p` | **Confirmed**, including the epic-4 8-vs-10 and epic-12 4-vs-5 breakdown |
| `integration.constants.ts`: nothing overrides `testTimeout` | the entry's own grep | **Confirmed** — only the comment matches |
| Worker-service is a leaf | `grep -rn worker-service --include=package.json` | **Confirmed** |
| `src/events/**` coverage, exclusion lifted | `vitest run --coverage` with overrides | 97.03 / 93.25 / 100 — see ruling 2 |
| No skipped, `.only`, or short-circuiting tests | `grep` for `.skip`/`.todo`/`.only`/early `return` | **None** |

### What I could not verify, and why

- **CI's two role-scoped steps** (usage-service RLS, auth-service coverage) — not reproducible
  locally; that is Gate 7's.
- **Redis other than 7.0.15 / ioredis 5.11.1.** The three-element `XAUTOCLAIM` reply, the
  `Connection is closed.` text and the ~205 ms `disconnect()` are observations on this server.
  CI runs `redis:7-alpine`, also 7.x.
- **Multi-replica reclaim** — one consumer name (`worker-1`, D3-A); competing live workers were
  not exercised. Unchanged from QA.
- **`run()` re-entrancy** — I did not execute it either. `index.ts:143` remains the only
  production run site, so it is latent.
- **The precise boundary of H-2's emission window.** I measured block 20 (4/5 emit), 500 (0/3) and
  5 000 (0/1). I did not bisect, and I make no claim about where between 20 and 500 it flips.
  Nine runs, three configurations — stated as measured, which is the whole point of H-2.
- **Whether `"Stream read interrupted by shutdown"` can *ever* reach production.** It appeared in
  none of the nine runs. That is an observation, not an impossibility proof; the refuting case
  would need the read to reject inside the 3–6 ms window, which `disconnect()`'s ~205 ms makes
  unlikely but which I did not try to construct.

### Environment discipline

- **db 0 unchanged.** Before and after the full `--force` gate, the probes and the two mutation
  runs: `telemetry:events` `XLEN 2`, `entries-added 2`, `last-generated-id 1788171536033-0`,
  `max-deleted-entry-id 0-0`, `XINFO GROUPS` empty, both original ids present. `DBSIZE` went
  1 → 2 → 1: one self-expiring `denylist:<jti>` written by auth-service during `pnpm test`, which
  is **S-22**, not this change, and which had expired by the end.
- **db 12 / 13 / 14 all `DBSIZE 0`** at the end. My nine worker probes used db 14 with a
  disposable `r3-probe:events` stream; it was removed by the integration suite's own
  `flushReservedDb()` on the next run, and I confirmed `KEYS *` → empty. Every `FLUSHDB` the suite
  issues still routes through `flushReservedDb()` (the only `flushdb()` call site is `:212`,
  inside it).
- **Zero parked reads** on the server at the end (`CLIENT LIST | grep -c cmd=xreadgroup` → 0).
  **pid 184537** (Thu Sep 10 14:43, pre-T-039 code) untouched and confirmed not parked.
- **Two mutations, both reverted**: `stop()`'s `disconnect()` and `index.ts:143`'s `void` →
  `await`. `md5sum -c` over all 36 tracked source/test/doc files → 0 mismatches;
  `git status --porcelain` byte-identical to the session start (9 modified, 3 untracked). The
  `coverage/` directory the measurement produced was deleted; it is gitignored either way.
  Postgres and Redis left running.

### Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| A future reader trusts S-26's universal and does not instrument a short-block deployment | **Required fix H-2.** Docs only |
| T-043 implements S-26's fix direction against an inverted `U25` and an understated `void` consequence | **Required fix H-4.** The ten-case mutation is the evidence to cite |
| Someone edits `U26` or `I12` believing they assert the teardown lines, or edits `U14`/`U24` without the scope they needed | **Required fix H-3.** Comment relocation, no test-body change |
| AC8's `info` line can be deleted with the suite green | **M-8, recommended in this commit.** Two lines |
| A fourth deadline-vs-budget instance | **Open, handed forward.** The structural close is in ruling 5; it is ~10 lines and belongs in T-040/T-043, not here |
| `parseClaimReply`'s documented non-string-cursor behaviour is untested | **L-18, optional.** One case; the other five defensive branches are fine untested |
| Unacknowledged entries accumulate until T-040 | **Accepted (D2-A), unchanged.** Proven by `XPENDING` in `I7`/`I9`/`I10`; the producer is idle |
| `src/index.ts` is also outside coverage collection | **Recommend adding to S-25** when epic-12 picks it up — the exclusion is `src/**/index.ts`, broader than S-25's text implies, and it covers the file H-2 and H-4 are about |

### Decision for the user

**Which of Round 3's findings go in before the commit?** All are docs, comments or two lines of
test; none changes production code, so none invalidates QA's PASS or the gate results above.

| Option | Scope | Cost |
|---|---|---|
| **A — H-2, H-3, H-4 and M-8** *(recommended)* | The three S-26 corrections plus the one missing AC8 assertion | ~30 min. Re-verify with `pnpm --filter @telemetry/worker-service exec vitest run` (must stay 99→100 tests, all green) |
| B — H-2, H-3, H-4 only | The authoritative-file corrections; M-8 deferred to T-040 | ~20 min, no test file touched |
| C — A plus the six LOWs (L-12 … L-17) | Adds the stale numerals, the plan's two record errors and the `index.ts:74` citation | ~50 min, still no production code |
| D — commit as is, file everything as a follow-up | — | Leaves three false claims in `.claude/rules/`, which is the one file the pipeline tells other agents not to re-verify |

**Recommendation: A.** H-2/H-3/H-4 are the HIGH bar applied to the only authoritative file this
change edits, and M-8 is two lines closing the assertion gap H-3's correction will make readers
look for. **D is the option I would argue against**: the S-26 entry as written would send T-043
at an inverted test citation, and it is cheaper to fix now than to discover from a failing T-043
rework.

**Which options change the diff:** A, B and C all do (all touch tracked files). The difference
between them is scope, not risk. **Preference only:** whether the six LOWs ride along in C or
wait — none of them can cause a defect, and L-12/L-13 will be re-found by the next reviewer who
reads those docblocks.

**Verdict: CONDITIONAL.** Required before commit: **H-2, H-3, H-4**. Recommended in the same
pass: **M-8**. The implementation itself is approved as it stands — 13/13 on all four gates plus
smoke with `--force` and `0 cached`, worker at 7 files / 99 tests, 97% statement coverage on the
loop with the exclusion lifted, every error path exercised, no tenant-isolation or injection
surface, and F-3's margin confirmed by the mutation it was written for.
