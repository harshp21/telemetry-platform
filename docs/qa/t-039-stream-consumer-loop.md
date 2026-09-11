# QA — T-039 · Stream Consumer Loop

**Gate**: 5 (QA Tester) · **Date**: 2026-09-11 · **Base**: `b558641` · **Subject**: uncommitted working tree
**Plan**: `docs/plans/t-039-stream-consumer-loop.md` · **Review**: `docs/reviews/t-039-stream-consumer-loop.md`
(Round 1 CONDITIONAL, Round 2 CONDITIONAL; Round 2's six items applied by the orchestrator, verified here)

## Verdict: **PASS**

No blocking defects. All 13 packages green on a forced run; every acceptance criterion is
proven by a case I confirmed goes red when the behaviour is broken. Two non-blocking findings
(one MEDIUM observability, one LOW spec divergence) and three coverage gaps are recorded
below, none of them a reason to hold the commit.

---

## 1. Full gates — my own run, `--force`

Every command run by me on the working tree, not replayed from the implementer's cache.
`Cached: 0 cached, 13 total` on all four.

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck --force` | **13 successful, 13 total**, 0 cached, 9.682s, exit 0 |
| Lint | `pnpm lint --force` | **13 successful, 13 total**, 0 cached, 26.123s, exit 0 |
| Build | `npx turbo run build --force` | **13 successful, 13 total**, 0 cached, 19.378s, exit 0 |
| Test | `pnpm test --force` | **13 successful, 13 total**, 0 cached, exit 0 |
| Smoke | `pnpm test:smoke` | 6 suites, all passed, exit 0 |

`pnpm build -- --force` was not used — as the brief notes, it does not forward the flag.

**Per-package test totals** (all passing): analytics 4/18 · auth 15/164 · billing 4/18 ·
gateway 8/38 · shared-config 1/4 · shared-logger 1/4 · shared-tracing 1/2 · shared-types 1/8 ·
shared-utils 1/18 · shared-validation 1/15 · usage 19/230 · **worker 7 files / 99 tests** ·
(web has no test suite). Worker matches the stated baseline exactly.

### Lint warnings — 14, all proven pre-existing

Counted 14 warning lines, 0 errors, and `grep -c "no-unsafe-return"` over the lint log → **0**.

| Count | Rule | File | `git log -1` |
|---|---|---|---|
| 10 | `@typescript-eslint/no-misused-promises` | `apps/auth-service/tests/auth.service.unit.test.ts` | `d68e719` |
| 4 | `@typescript-eslint/no-unsafe-assignment` | `apps/usage-service/tests/ingestion.service.unit.test.ts` | `b0f6921` |

`git diff --name-only` contains **neither** file. Both predate this change; none is attributable
to T-039.

### Two stderr traces in the worker run are not failures

`pnpm test` prints an `Error: load failure` (code `EACCES`) and a `MaxRetriesPerRequestError`
under `tests/index.graceful-shutdown.unit.test.ts`. Both are the error objects deliberately
thrown by two *passing* negative-path cases (`loadEnvFile throws non-ENOENT`, and T-038's `U8`
fail-closed case). No unhandled rejections — the 8 the plan records at Gate 3 are gone.

---

## 2. Acceptance criteria — AC1 to AC13

I did not take the coverage mapping on trust. For each criterion below I broke the
implementation and confirmed the nominated case went red, then reverted. **12 mutations**, every
one reverted, tree proven byte-identical afterwards (§7).

| AC | Criterion | Proving case(s) | My mutation | Result |
|---|---|---|---|---|
| AC1 | Read uses parsed env, not defaults | `U11` | `BLOCK` bound to a literal `5000` instead of `this.blockMs` | **U11 red** ✅ |
| AC2 | `null` reply is a normal timeout | `U12`, `U27`, `I8` | (covered incidentally — U12/U27 red under the AC4 mutation) | ✅ |
| AC3 | Every entry reaches the handler once, in stream order | `U13`, `I7` | `for (const entry of [...entries].reverse())` | **U13, U29, I7, I10 red** ✅ |
| AC4 | Loop exits on the predicate, once per iteration | `U14`, `U15` | deleted the pre-loop `shouldStop()` guard | **10 cases red**, incl. U14/U15 ✅ |
| AC5 | Recovery paginates to completion at `blockMs × 2` | `U19`, `U20`, `I10` | recovery `while` → `if` (`stream.consumer.ts:631`) | **U19, U38, I10 red** ✅ |
| AC6 | `NOGROUP` re-registers and the loop continues | `U16`, `I11` | `reRegisterGroup()` call replaced with `false` | **U16, U30, I11 red** ✅ |
| AC7 | Other failures log 4 fields then pause `ERROR_BACKOFF_MS` | `U17`, `U18` | removed `await this.backOff()` | **U17 red** ✅ |
| AC8 | Shutdown-interrupted read ends quietly | `U26`, `U28`, `I12` | `stop()` no longer disconnects | **I12 red** ✅ (see F-1) |
| AC9 | No literals in the loop | reviewer gate | scanned `src/events/stream.consumer.ts:210-777` excluding comments | only loop counters (`0`/`1`) ✅ |
| AC10 | Bootstrap error log fields asserted (LOW-4) | `U22`, `U23` | the inherited `String(error)` → `"unknown"` | **U23 and U18 red** ✅ |
| AC11 | bootstrap → recovery → loop → listen | `U25`, `U31` | moved `void run()` after `app.listen(...)` | **U25 red** (`expected 118 to be less than 116`) ✅ |
| AC12 | S-15 docs correction | inspection | re-derived all claims by command | ✅ (§4) |
| AC13 | Pre-group backlog stays unreachable | `I9` | (red under the D2-B acknowledgement mutation — so it asserts pending state, not just handler silence) | ✅ |

**AC10 is the inherited finding and it is genuinely closed.** At `b558641` the plan measured
this mutation leaving the suite 65/65 green. On this tree it reddens two cases, `U23` **and**
`U18` — matching the plan's corrected S2 line rather than its original "U23 only".

**No tautological tests found among the ACs.** Every case I mutated failed on an assertion
about behaviour, not on a stub's own return value.

---

## 3. The D2-A contract — the one with data consequences

Verified two ways, because a handler-only assertion cannot prove it.

**Mutation (option D2-B, the data-loss alternative):** added
`await this.readConnection?.xack(this.streamName, this.groupName, entry.id);` after a successful
handler call in `dispatch()`.

```
FAIL  tests/stream.consumer.integration.test.ts > ... > I7 - delivers entries to the handler and leaves them pending
  AssertionError: expected [] to deeply equal [ Array(2) ]
FAIL  ... I9 - neither the loop nor recovery ever delivers the pre-group backlog
FAIL  ... I10 - reclaims a pending list larger than COUNT, paginating past the boundary
FAIL  tests/stream.consumer.unit.test.ts > ... > U34 - the default handler ... acknowledges nothing
Tests  4 failed | 42 passed (46)
```

`expected [] to deeply equal [Array(2)]` is the **`XPENDING`** assertion failing, not the
handler assertion — `readPendingIds` (`stream.consumer.integration.test.ts:531-556`) issues a
real `XPENDING` and *throws* on a non-array reply or a non-string id rather than passing
vacuously. Three integration cases plus one unit negative guard the contract. Confirmed against
a live server in §6: an entry published to a running worker was dispatched and **remained
pending**.

Nothing published between T-039 and T-040 is lost.

---

## 4. Independent verification of the six post-Round-2 items

The brief asked me to verify these rather than take the orchestrator's word.

| Item | Claim | My finding |
|---|---|---|
| **M-6** | `RUN_DEADLINE_MS` `10_000` → `3_000`; deadline can now fire | **Confirmed, re-measured.** `integration.constants.ts:207` is `3_000`. `apps/worker-service/vitest.config.mjs` sets no `testTimeout`/`hookTimeout`, and `grep -rn "testTimeout\|hookTimeout"` over the package finds only a comment — so vitest's 5 000 ms default stands and 3 000 < 5 000. Under the nominated mutation I measured `I10` failing at **3028 ms** with `AssertionError: expected [ Array(2) ] to deeply equal [ '1789114709262-0', …(4) ]` — an assertion, not `Test timed out in 5000ms`. Matches the claimed 3026 ms |
| **M-7** | Plan's no-`.catch()` reasoning rewritten | **Text is true.** `run()` (`stream.consumer.ts:384-398`) is a `try` around `runLoop()` whose `catch` body's only statement is `this.logger.error(...)`, outside any inner `try` — so a throwing logger *does* make `run()` reject, and the plan no longer claims unreachability. The replacement reason (a `.catch()` at `index.ts` would log through the same `container.logger` that threw) is accurate for the code as written. `index.ts:114-128` states the same and explicitly warns against reading it as "nothing here can ever reject" |
| **L-8** | "by one microtask turn" corrected to no quantity | **Confirmed.** `src/index.ts:137-142` names the correction, gives the measured three turns as context, and states the count *understates rather than bounds* the gap. No quantity is asserted as a bound |
| **L-9** | `I6`'s eight bootstrap clients now named | **Confirmed.** Both `new RedisClient(...)` sites pass `connectionName` — `:219` (suite client) and `:362` (the `I6` factory). `INTEGRATION_REDIS`' docblock claim is now true |
| **L-10** | Citations recorded as base-`b558641` | **Confirmed** in plan §1's note and §S6 |
| **L-11** | `INDEX` replaces `CALLS` at index positions | **Confirmed.** `INDEX` exists at `stream.consumer.unit.test.ts:529-536`; `grep -n "\[CALLS\."` returns **no matches** — `CALLS` keeps only counting uses |

---

## 5. Test honesty — independently sampled

### `U37` / `U38` — green on arrival, and **not** vacuous

Both were added at the rework for behaviour that already existed, justified by mutation rather
than red-first. I did not re-run the mutations they were justified with; I used **stronger**
ones.

- **`U37`** — instead of the nominated "remove the warn", I mutated the *design claim itself*:
  `parseEntry` changed from `return null` to `continue` on a non-string field, i.e. keep the
  entry and drop the bad field. That is the subtle bug the docstring warns about (it re-pairs
  every following key with the wrong value). **`U37` red** — `expected "spy" to be called with
  arguments: [ { …(3) }, …(1) ]`. The case defends the real invariant, not just the log line.
- **`U38`** — it is reddened by the AC5 pagination mutation (`while` → `if`) *as well as* by its
  own nominated one, so it detects a genuine correctness defect independently of the page bound.

**Judgement: acceptable.** Pseudo-TDD's "confirm red" exists so a test is known to be capable of
failing. These two establish that by mutation instead of by ordering, and both survive a mutation
harsher than the one they were signed off with. One NIT: `U38` asserts
`toHaveBeenCalledTimes(WORKER_STREAM_READ.RECOVERY_MAX_PAGES)` — both sides move together, so a
change to the constant's *value* is invisible. That is the right trade (the value is a tuning
decision) but it means `U38` catches a code change, not a value change. The file's own "F1 trap"
note already articulates this distinction.

### `U25`'s ordering pair — labelled as recording, and correctly so

The case is **not** vacuous overall: I moved `void streamConsumer.run()` to after
`app.listen(...)` and `U25` went red on `expect(claimOrder).toBeLessThan(listenOrder)` —
`expected 118 to be less than 116`. AC11 is genuinely proven.

The final pair (`listenOrder < readOrder`) is honestly labelled: the comment states that of the
two available mutations, each reddens an *earlier* assertion first, so the pair records a
measured order rather than detecting a defect. I agree, and the wording is properly scoped
("of the two mutations available here") rather than claiming no mutation could reach it. This
replaced the `firstReadSettled()` flag deleted for M-2, which was constant-`false`. Good
outcome.

### `I12` / `hasParkedRead()` — I tried to make it measure nothing, and could not

Four attacks, all defeated:

1. **Neuter the helper to always `false`** → the `vi.waitFor` expecting `true` fails.
2. **Neuter it to always `true`** → `expect(await hasParkedRead()).toBe(false)` at
   `stream.consumer.integration.test.ts:820` fails. The helper is guarded on **both** sides;
   the false→true transition cannot be faked in either direction.
3. **Restore the pre-M-3 server-wide body** (`list.includes("cmd=xreadgroup")`) with a foreign
   blocking `XREADGROUP` parked on **db 13** → `I12` fails,
   `expected true to be false // Object.is equality`. The M-3 fix is load-bearing, reproduced
   independently.
4. **Positive control** — with that same foreign read still parked and the *shipped*
   `connectionName`-scoped body, the file passes **12/12**. The scoping works adversarially.

I also broke the subject rather than the helper: `stop()` with its `disconnect()` removed →
**`I12` red**. See F-1 for a caveat on *how* it goes red.

### Helpers throw rather than pass vacuously

`readPendingIds` throws on a non-array reply and on a non-string id; `flushReservedDb` throws if
the client was never constructed and asserts `db=14` via `CLIENT INFO` on **every** call. Both
meet `.claude/rules/testing.md`'s bar.

---

## 6. Functional smoke — the service does run, and I ran it

Against real Redis 7.0.15 on **logical database 14**, disposable stream `qa-t039:events`,
`PORT=4299`, `STREAM_BLOCK_MS=5000`. Never db 0.

| Observation | Result |
|---|---|
| Group bootstrap | `XINFO GROUPS` → `qa-t039-group`, `last-delivered-id 0-0` |
| Parked read on its own connection | `CLIENT LIST` row carrying `db=14 cmd=xreadgroup` |
| `/health` | `{"status":"ok","service":"worker-service"}` |
| Entry published mid-run | reached the **default** handler: `"Received stream entry; no processor is wired yet"`, with `"entryId":"1789115291333-0"` |
| **D2-A against a live server** | `XPENDING` → `1` pending, id `1789115291333-0`, consumer `qa-t039-worker` — **not acknowledged** |
| **Payload redaction** | field value `secret-payload-value` appears in **0** log lines across the whole run |
| `SIGTERM` → process exit | **26 ms** against a 5 000 ms block (repeats: 51 ms, 26 ms) |
| warn/error-level lines | **0** across all three runs — AC8 end-to-end |

D1-B's central claim (shutdown does not wait out `STREAM_BLOCK_MS`) holds in production, not
only in the harness.

---

## 7. Defects and findings

### F-1 · MEDIUM (non-blocking) — the shutdown path's two `info` lines are unobservable in production, and three tests assert them

**Measured, three consecutive runs, deterministic.** On a real `SIGTERM`, neither
`"Stream read interrupted by shutdown"` (`stream.consumer.ts:517`) nor
`"Stream consumer loop stopped"` (`stream.consumer.ts:455`) is ever emitted. Full set of
distinct messages from a complete smoke run:

```
"Created stream consumer group"  "Server listening at ..."  "Health check called"
"incoming request"  "request completed"  "Received stream entry; no processor is wired yet"
"Shutting down gracefully"  "Shutdown complete"
```

`grep -c "Stream consumer loop stopped"` → **0**; `grep -c "interrupted by shutdown"` → **0**,
on each of three runs (26 ms / 51 ms / 26 ms shutdowns).

**Mechanism** (read from `src/index.ts:58-77`): `shutdown()` awaits `streamConsumer.stop()` —
which only sets the flag and calls `disconnect()`, and deliberately does not await `run()` —
then `app.close()`, `$disconnect()`, `redis.disconnect()`, then `process.exit(0)`. The `run()`
promise is discarded at `index.ts:143`, so its rejection-classification `info` and its `finally`
log lose the race to `process.exit(0)` every time.

**Why this is not a blocker.** Nothing is lost: under D2-A nothing is acknowledged, the read
connection *is* disconnected before exit, and the plan explicitly hands "draining in-flight work
on shutdown" to **T-043**, stating that this task "deliberately does not await the loop's current
message on shutdown". The behaviour is the approved design.

**What is new, and what both review rounds missed.** The *consequence* is not recorded anywhere:
`U26`, `U35` and `I12` all assert these two log lines, and they can only do so because nothing in
a test harness calls `process.exit`. An operator debugging a deploy cannot confirm from the log
that the loop stopped cleanly — the very AC8 property those cases certify is invisible where it
matters. This will matter more once T-040 gives the handler database writes.

**Recommendation:** record in `.claude/rules/known-gaps.md` as a new id, with the fix direction
belonging to T-043 (await `run()` with a bounded timeout before `process.exit(0)`, which makes
both lines observable and is the same change the drain needs). Not this task's to fix.

### F-2 · LOW — the epic's T-039 story says "acknowledge on success"; the shipped task acknowledges nothing, and the divergence is recorded nowhere

`docs/epics/epic-7-worker-service.md:84` reads: *"Read batches from the stream, process each
message, **acknowledge on success**. On failure, leave in PEL …"*. T-039 as shipped acknowledges
nothing at all — decision **D2-A**, answered by the user at Gate 2.

This is the **safe** direction and it is internally consistent with the epic's *own* T-040 entry
(*"`XACK` only after the transaction commits"*), so the epic contradicts itself across two
adjacent sections rather than the code being wrong. But:

```
grep -n "acknowledge on success" docs/plans/t-039-*.md docs/reviews/t-039-*.md .claude/rules/known-gaps.md
→ NOT RECORDED ANYWHERE
```

The plan frames D2 as a decision without noting that the chosen option contradicts the epic's
T-039 story sentence. Per `CLAUDE.md` ("epic specs are sometimes wrong — report spec-vs-code
divergence as a spec finding"), this belongs on the record. It joins the three divergences Gate 1
already found (no error handling in the snippet; `XAUTOCLAIM` cursor omitted; `if (!results)
continue` missing the non-null `[[stream, []]]` shape, which `U27` covers).

**Recommendation:** add to S-17's family in `.claude/rules/known-gaps.md`, or correct
epic-7's T-039 story to "hand each message to the processor; acknowledgement is T-040's". Docs
only — **no diff change**.

### F-3 · LOW — `I12`'s intended assertion is unreachable for the defect it guards

`BLOCK_MS_LONG` is `5_000` and vitest's per-case default is also `5_000`. When I removed
`stop()`'s `disconnect()` — the exact regression `I12` exists for — the case failed with
`Test timed out in 5000ms.`, **not** with the `expect(elapsed).toBeLessThan(STOP_BUDGET_MS)`
assertion. The full-block-wait regression always races the runner's timeout and loses.

The case still goes red, so this is a diagnostic-quality issue, not a coverage hole: the
`STOP_BUDGET_MS` bound only fires for *partial* slowness (2 000 ms < elapsed, total under
5 000 ms). It is the same class of problem M-6 just fixed for `RUN_DEADLINE_MS`, one file over,
and it was not caught because M-6's audit looked at `RUN_DEADLINE_MS` alone.

**Recommendation:** not a commit blocker. If touched later, either lower `BLOCK_MS_LONG` or give
`I12` an explicit per-case timeout above it, so the failure names the budget rather than the
runner.

---

## 8. Coverage gaps (none blocking)

1. **`run()` re-entrancy is untested and unguarded.** `runLoop()` assigns `this.readConnection`
   (`:439`) and nulls it in `finally` (`:451`). A second concurrent `run()` would overwrite the
   first's registration, so `stop()` would disconnect only the second and the first's `finally`
   would then clobber the null. *Stated from source; I did not execute it.* No caller does this —
   `index.ts:143` is the only production construction-and-run site — so it is latent, not live.
2. **No multi-consumer / competing-worker case.** Nothing exercises two consumers on one group,
   which is where `XAUTOCLAIM`'s idle threshold actually earns its keep. Out of scope
   (single instance today, D3-A keeps `worker-1`), but worth naming before T-043.
3. **`src/events/**` is excluded from coverage collection** — `vitest.config.mjs:18`. The 777-line
   file this task grows most is outside worker-service's own 80/75 thresholds. Already filed as
   **S-25** by this change; I confirmed the exclusion and the line count independently
   (`wc -l` → 777).

---

## 9. Regression risk and breaking-change assessment

**T-038's bootstrap still behaves** — this was the specific concern, since T-039 rewrote
`run()`/`stop()` around it. `I1`–`I6` and `U1`–`U10` all pass unchanged, including `I3`
(a repeat bootstrap moves neither cursor nor pending list) and `U7`/`U8` (bootstrap-before-listen,
fail-closed on unreachable Redis). `ensureConsumerGroup` is unmodified — it is now *also* called
from the `NOGROUP` repair path, and `U16`/`U30`/`I11` cover both outcomes of that reuse.

**Across the other 12 packages: no breaking change.**

- `grep -rn "worker-service" --include=package.json apps packages` (excluding worker's own) →
  **no package depends on worker-service**. It is a leaf.
- The only exports added are additive: `WORKER_STREAM_READ` (new const) and
  `StreamMessageHandler` (new type). Nothing removed, nothing re-typed.
- `StreamConsumer`'s constructor did gain a **required** 4th parameter (`isShuttingDown`). All
  seven construction sites are inside worker-service and all are updated — typecheck 13/13
  confirms.
- Non-worker files touched: `.claude/rules/known-gaps.md` only (docs).
- All 12 other packages' suites pass at their existing totals, and they pass for the right
  reason: none of them shares code with the changed path.

---

## 10. `known-gaps.md` claims — re-derived, since a false claim in `.claude/rules/` is HIGH

Every load-bearing assertion the S-15 edit adds, checked by command:

| Claim | My check | Result |
|---|---|---|
| None of the five ids appears in any commit message | `git log --all --format="%h %s%n%b" \| grep -icE "T[- ]?024[CD]\|T[- ]?067[ABC]"` | `0`, grep exit 1 ✅ |
| Five carriers | per-file `git log --diff-filter=AM` | `d68e719`, `e3d7556`, `21c9a9e`, `f47b7d8`, `eb3ef10`+`4925e4a` ✅ |
| t-067c order: added by `eb3ef10`, modified by `4925e4a` | `git log --name-status --diff-filter=AM` | `eb3ef10 A`, `4925e4a M` ✅ |
| 76 headings / 75 distinct / `T-070` twice | `grep -cE '^#+ +T-[0-9]+[A-Z]?'` summed; `sort -u` | 76 / 75 / 2 ✅ |
| `docs/epics/README.md:138` totals 73 | `sed -n '138p'` | `\| **Total** \| **73** \| \|` ✅ |
| `stream.consumer.ts` is 777 lines (S-25) | `wc -l` | 777 ✅ |

All correct. No false claims introduced.

---

## 11. Redis hygiene

**db 0 `telemetry:events` is byte-for-byte unchanged across the entire QA session**, including
a full `pnpm test --force`:

| Field | Before | After |
|---|---|---|
| `XLEN` | 2 | **2** |
| `entries-added` | 2 | **2** |
| `last-generated-id` | `1788171536033-0` | **`1788171536033-0`** |
| `max-deleted-entry-id` | `0-0` | **`0-0`** |
| `XINFO GROUPS` | empty | **empty** |

db 0 `DBSIZE` went 1 → 2. The single added key is
`denylist:b8664f055ad27288d75aae14f9f0f48b`, `TTL 885` — **auth-service reproducing S-22**, one
self-expiring key per `pnpm test` run, exactly as the brief predicted. Not attributable to T-039.

**db 12 `DBSIZE 0` · db 13 `DBSIZE 0` · db 14 `DBSIZE 0`** at the end. I used db 13 for one
adversarial probe (a foreign parked `XREADGROUP` for the M-3 test) and db 14 for the functional
smoke; both fixtures were deleted by hand and both databases returned to 0. Zero parked reads
remain on the server.

**Every `FLUSHDB` the suite issues routes through `flushReservedDb()`**, which re-asserts
`CLIENT INFO` contains `db=14` on each call — I confirmed there is no bare `flushdb()` elsewhere
in the integration file.

Postgres and Redis were left running. The pre-existing worker dev process **pid 184537** (started
Thu Sep 10 14:43, pre-T-039 code) was not touched, and I independently confirm the brief's
characterisation: while my foreign probe was parked, `CLIENT LIST | grep -c cmd=xreadgroup`
returned exactly **1** — my own row — so pid 184537 is **not** parked on `XREADGROUP`.

---

## 12. What I could not validate, and why

- **CI behaviour.** I ran the gates locally only. `.github/workflows/ci.yml`'s two extra
  role-scoped steps (usage-service RLS, auth-service coverage) were not exercised — that is the
  Gate 7 CI validation step's job, not reproducible from here.
- **Redis versions other than 7.0.15.** The three-element `XAUTOCLAIM` reply and the
  `Connection is closed.` message text are protocol/library observations made on 7.0.15 with
  ioredis 5.11.1. CI uses `redis:7-alpine` (also 7.x). Not verified on 6.x or on managed Redis.
- **Multi-replica behaviour.** One worker, one consumer name (`worker-1`, D3-A). Reclaim across
  genuinely competing live workers was not exercised — see coverage gap 2.
- **`run()` re-entrancy** — reasoned from source, not executed (coverage gap 1). I state it as
  unmeasured rather than asserting the failure mode.
- **Coverage percentages for the loop.** `src/events/**` is excluded from collection, so no
  coverage number exists for the file this task grows most (S-25). I did not remove the exclusion
  to get one — that would change the thresholds' basis mid-QA.

---

## 13. Release-readiness call

**Ready to proceed to Gate 6.**

The one contract with irreversible consequences — D2-A, messages reach the handler and are not
acknowledged — is proven by mutation at both the unit and integration levels via `XPENDING`, and
confirmed against a live server. Tenant isolation is not in scope for this task: the loop derives
no tenant context, opens no database connection and no repository, and logs entry ids only — the
payload's absence from the log is asserted across *every* logger method (`U34`) and confirmed
empirically (0 occurrences of a seeded secret value in a full smoke run).

F-1 should be filed in `.claude/rules/known-gaps.md` before commit, and F-2 either filed or fixed
in epic-7 — both are docs-only and neither changes the diff.

---

## Appendix — mutations applied, and proof the tree is unchanged

Twelve mutations, each reverted immediately after measurement:

1. recovery `while` → `if` (`:631`) — M-6 re-verification
2. `xack` added after successful dispatch — D2-B / D2-A contract
3. `void run()` moved after `app.listen(...)` — AC11
4. `parseEntry` `return null` → `continue` on a non-string field — U37 design claim
5. `stop()`'s `disconnect()` removed — AC8 / I12
6. `hasParkedRead()` restored to the pre-M-3 server-wide body — M-3
7. (+ a foreign blocking `XREADGROUP` parked on db 13 as the adversarial condition)
8. `await this.backOff()` removed — AC7
9. `reRegisterGroup()` → `false` — AC6
10. dispatch loop reversed — AC3
11. `BLOCK` bound to literal `5000` — AC1
12. `String(error)` → `"unknown"` — AC10 / LOW-4
13. pre-loop `shouldStop()` guard deleted — AC4

**Final state, verified:**

```
md5sum -c tree.md5   →  ALL FILES BYTE-IDENTICAL   (all 11 changed/new files)
git status --porcelain → the same 9 modified + 2 untracked files as at QA start
pnpm --filter @telemetry/worker-service test → Test Files 7 passed (7) / Tests 99 passed (99)
redis-cli -n 14 DBSIZE → 0
```

No fix was applied. The only file this gate wrote is this report.
