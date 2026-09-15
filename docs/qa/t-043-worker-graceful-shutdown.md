# QA — T-043 · Worker graceful shutdown

**Gate:** 5 (QA Tester) · **Service:** worker-service · **Base:** `fc66bd3` (T-041) ·
**Subject:** the uncommitted working tree · **Date:** 2026-09-15

# Verdict — **PASS**

Release-ready. The guard that this task exists for is sound: I could not construct any path in
which `XGROUP DELCONSUMER` fires while this consumer holds pending entries, other than the
documented plan-R4 residual (an operator pinning the same `REDIS_CONSUMER_NAME` on two
instances), which the instance-unique default closes at the default.

Three findings, none blocking: **two LOW documentation defects** (QA-1, QA-2) and **one coverage
gap** (QA-3) recommended for `.claude/rules/known-gaps.md` if not taken now. All three are
wording or missing-regression-guard; none changes behaviour, weakens a test, or affects the
diff's correctness.

---

## 1 · Full gates — my own `--force` runs, all 13 packages

| Gate | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | **13 successful, 13 total · 0 cached** · exit 0 |
| lint | `pnpm lint --force` | **13 successful, 13 total · 0 cached** · exit 0 · 14 warnings |
| build | `npx turbo run build --force` | **13 successful, 13 total · 0 cached** · exit 0 |
| test | `pnpm test --force` | **13 successful, 13 total · 0 cached** · exit 0 |
| smoke | `pnpm test:smoke` | 6 service suites + shared, all `1 passed (1)` · exit 0 |

`0 cached` on every task, so nothing was replayed from the implementer's or reviewer's cache.

**worker-service: `Test Files 12 passed (12)` · `Tests 179 passed (179)`** — matches the stated
baseline exactly. Per-file: `stream.consumer.unit` 54, `stream.consumer.integration` 17,
`event.processor.integration` 14, `index.graceful-shutdown.unit` 15, `env.schema.unit` 40,
`stream-message.validator.unit` 5, `dead-letter.service.unit` 8, `event.repository.unit` 6,
`event-processor.service.unit` 7, `config/container.unit` 8, `config/prisma.singleton.unit` 4,
`smoke` 1.

Other packages: gateway 8/38, billing 4/18, analytics 4/18, usage 19/230, auth 15/164, shared
packages 2/8/4/4/15/18.

### The 14 warnings are pre-existing — proven, not asserted

```
@telemetry/auth-service:lint:  ✖ 10 problems (0 errors, 10 warnings)
  apps/auth-service/tests/auth.service.unit.test.ts — @typescript-eslint/no-misused-promises
@telemetry/usage-service:lint: ✖ 4 problems (0 errors, 4 warnings)
  apps/usage-service/tests/ingestion.service.unit.test.ts — @typescript-eslint/no-unsafe-assignment
```

- `git log -1 -- apps/auth-service/tests/auth.service.unit.test.ts` → **`d68e719` (2026-08-25)**
- `git log -1 -- apps/usage-service/tests/ingestion.service.unit.test.ts` → **`b0f6921` (2026-08-31)**
- Neither file appears in `git diff --name-only fc66bd3`.

`grep -c "no-unsafe-return"` over the whole lint output → **0**. `worker-service` lints clean
with zero warnings.

---

## 2 · The load-bearing probes, re-derived independently

Redis 7.0.15 / ioredis 5.11.1, logical database **14**, my own harness — not the suite's.

**P1 — `XGROUP DELCONSUMER` destroys pending entries. Reproduced exactly.**

```
P1 XINFO CONSUMERS before: [["name","c1","pending",2,"idle",2]]
P1 typeof pending: number
P1 DELCONSUMER returned: 2
P1 XPENDING after: [0,null,null,null]
P1 XAUTOCLAIM 0 0-0: ["0-0",[],[]]
P1 XREADGROUP > as c2: null
P1 XLEN: 2
```

Two entries, still on the stream, unreachable through the group, permanently, with no error.

**P11 — the shared-name race. Reproduced exactly.**

```
P11 A guard reading: [["name","worker-1","pending",0,"idle",0]]
P11 after B read, XPENDING: [1,"…870-0","…870-0",[["worker-1","1"]]]
P11 A DELCONSUMER returned: 1
P11 XPENDING after: [0,null,null,null]
P11 XAUTOCLAIM 0 0-0: ["0-0",[],[]]    ← B's entry destroyed
```

**P12 — distinct names make the same sequence inert.**

```
P12 DELCONSUMER worker-aaa returned: 0
P12 XPENDING after: [1,"…872-0","…872-0",[["worker-bbb","1"]]]
P12 XAUTOCLAIM reachable: ["0-0",[["…872-0",["v","for-bbb"]]],[]]
```

Also re-derived: **P3** (a consumer that read nothing leaves no row → `false`), **P4**
(`DELCONSUMER` on an unknown name → `0`, no error), and **all four error shapes**, each a
`ReplyError` with `code === undefined`, so the message is indeed the only discriminator:

```
XGROUP DELCONSUMER group-gone -> NOGROUP No such consumer group '…' for key name '…'
XGROUP DELCONSUMER key-gone   -> ERR The XGROUP subcommand requires the key to exist. …
XINFO  CONSUMERS  group-gone  -> NOGROUP No such consumer group '…' for key name '…'
XINFO  CONSUMERS  key-gone    -> ERR no such key
```

The third shape — `ERR no such key`, the one the plan's F2 table lacked — is real, and
`WORKER_SHUTDOWN.GROUP_GONE_ERROR_PREFIXES` covers all three.

**P14 / P15 — the shutdown-ordering figures.** Three runs each, ping-first harness:

| | total elapsed | after the call was issued |
|---|---|---|
| `disconnect()` into a `BLOCK 5000` | 203 / 201 / 201 ms | **2 / 0 / 1 ms** |
| `quit()` into a `BLOCK 5000` | 5005 / 5008 / 5012 ms | **4805 / 4808 / 4811 ms** |

Both confirm the tree's figures and the `stop()`-before-`close()` ordering. See **QA-2** for the
one place the 204 ms is attached to the wrong interval.

> **Disclosure.** My *first* P15 harness — which did not `await ping()` before timing — produced
> an anomalous `43 391 ms`. It did not reproduce under the clean harness above (three runs, all
> ~4 806 ms). I record it because I ran it, not because it stands. The tree's figure is correct.

---

## 3 · Trying to break the guard — the assignment's central question

**No path found**, other than the documented residual.

The guard's soundness rests on one property I confirmed by measurement: **the PEL is the source
of truth and `XINFO CONSUMERS` reads it**, so an entry that is in flight is pending *by
construction*. That closes the whole class of "the handler is still working but the count says
zero". I then attacked each remaining surface:

| Attack | Result |
|---|---|
| Entry delivered after the drain completes | `runLoop` has returned and `readConnection` is disconnected; this process issues no further read under its own name |
| Positional field drift in the reply | Parsed **by key**, not by position — a field inserted ahead of `pending` cannot shift the reading |
| `pending` arrives as a string (RESP3 / future encoding) | `typeof !== "number"` → `UNREADABLE` → declines (`U89`) |
| Unrecognised reply shape | `UNREADABLE` → declines. Unknown is not zero |
| Our name absent from the registry | `ABSENT` → **skips** the delete rather than issuing it |
| `NaN` reaching the comparison | `!== 0` rather than `> 0`, so `NaN` declines. Fails closed on the arithmetic |
| Consumer name colliding with a field key (`"name"`, `"pending"`) | Parses correctly — I checked both |
| `stop()` called twice | `deregisterAttempted` keyed on the **attempt**, not its outcome (`U76`) |
| Drain timed out | `stop()` returns before `deregisterConsumer()`; `XINFO` is not even issued (`U79`, and verified live below) |
| `XINFO` throws | Caught, logged, delete suppressed (`U82`) |

### The residual is real — and narrower than the plan's wording implies

Driving the **shipped `StreamConsumer` class** (not raw commands) with a pinned shared name:

- **Naive ordering — the guard holds.** Peer B reads an entry *before* A's `XINFO`: A reads
  `pending 1`, declines, and B's entry survives (`QA shared-name loss occurred: false`).
- **Forced race — the entry is destroyed.** With B's read injected into the window *between* A's
  `XINFO CONSUMERS` and A's `XGROUP DELCONSUMER`:

  ```
  QA race: XAUTOCLAIM reachability: ["0-0",[],[]]
  QA race: XPENDING: [0,null,null,null] XLEN: 2
  QA race: ENTRY DESTROYED = true
  ```

So the exposure under a pinned shared name is **the two-round-trip window**, not the whole
shutdown — the guard narrows it substantially rather than not helping at all. It cannot be closed
in code (Redis has no conditional delete), and the instance-unique default removes it at the
default. **Both halves are required, confirmed.** Plan R4 and S-34 characterise this correctly;
this is a precision note, not a correction.

---

## 4 · Mutation testing

Every mutation was reverted immediately and the file re-hashed against a pre-QA `md5sum`
baseline.

| # | Mutation | Result |
|---|---|---|
| 1 | `pending !== 0` guard removed | `U78` red; **`I29` red by reachability loss**: `expected [] to deeply equal [ '1789441925668-0' ]` |
| 2 | `stop()` deregisters regardless of drain outcome (`U79` substitute) | `U79` red — `expected "spy" to not be called at all, but actually been called 1 times` |
| 3 | `drain()` returns `COMPLETED` for a null `loopPromise` (`U75` substitute) | `U75` red — same message |
| 4 | `shouldStop()` inside `dispatch`'s per-entry loop (`U83` plan substitute) | **11 red**, exactly the list the review's LOW-2 correction names |
| 5 | **My own tighter mutation** — truncate the rest of the batch once a stop is requested mid-batch | **3 red** (`U13`, `U19`, `U83`) |
| 6 | `DEFAULT_CONSUMER_NAME: "worker-1"` | 2 red — `expected 'worker-1' to be 'linuxconfig-…'`, `expected 'worker-1' not to be 'worker-1'` |
| 7 | `DEFAULT_CONSUMER_NAME: hostname()` (pid dropped) | 2 red — `expected 'linuxconfig' to contain '2219958'` |
| 8 | `const gone = error instanceof Error` (classify every failure benign) | `U82` + `U90` red; `U80`/`U81`/`U87` green — **exactly** as `U90`'s comment discloses |
| 9 | `DRAIN_TIMEOUT_MS: 1_000` | `U74` red — `expected 1000 to be greater than 1000` |

**On the three cases that pass against the unfixed tree — the disclosure is honest and the
substitutes are adequate.** `U75` and `U79` guard behaviour the pre-T-043 `stop()` cannot exhibit
because it never deregisters; mutations 2 and 3 redden each precisely.

`U83` deserved a harder look, because mutation 4 reddens eleven cases and a case that only goes
red alongside ten others is weak evidence that it tests what it claims. So I built mutation 5 — a
mutation that produces *exactly* the AC1 violation and nothing else. It reddens three, and `U83`
is **the only one of the three whose stated subject is mid-batch truncation** (`U13` and `U19`
are incidental). `U83` is a genuine, non-tautological AC1 test. Adequacy confirmed
independently, on stronger evidence than the plan offered.

**`I29` exceeds its specification.** The plan required it to go red "by observing `XPENDING` drop
to 0". It actually asserts **reachability** first (`XAUTOCLAIM` returns the entry), which
separates *destruction* from *legitimate acknowledgement* — both of which drive `XPENDING` to 0.
That is the correct assertion and a stronger one.

---

## 5 · Functional smoke — a real worker process under a real SIGTERM

Live Redis db 14, live Postgres, `node --import tsx src/index.ts`, `kill -TERM` to the node
process itself. **Both branches of the guard:**

**Branch A — the consumer holds a pending entry.**

```
{"level":"info","signal":"SIGTERM","msg":"Shutting down gracefully"}
{"level":"warn","consumerName":"linuxconfig-2245127","pending":1,
 "msg":"Skipped stream consumer deregistration: this consumer still holds pending entries"}
{"level":"info","msg":"Shutdown complete"}
exit=0
  registry after SIGTERM: [name linuxconfig-2245127 pending 1 idle 3045]
  XPENDING after:         [1 …635157-0 …635157-0 linuxconfig-2245127 1]
  entry reachable:        [0-0 …635157-0 eventId qa-1 …]
```

**Branch B — pending 0.**

```
{"level":"info","consumerName":"linuxconfig-2247102","msg":"Deregistered stream consumer"}
{"level":"info","msg":"Shutdown complete"}
exit=0
  registry after SIGTERM: []          ← row removed
  XLEN (entry still on stream): 1
```

**Drain timeout, against real Redis and real timers** (the suite drives this under fake timers
only — see QA-3):

```
QA: stop() took 3001 ms
QA: log lines [["warn","Timed out draining in-flight stream work on shutdown"]]
QA: XINFO CONSUMERS after stop: [["name","qa-consumer","pending",1,"idle",3009]]
QA: XPENDING after stop: [1,"…053851-0","…053851-0",[["qa-consumer","1"]]]
QA: XAUTOCLAIM reachability: ["0-0",[["…053851-0",["v","hang"]]],[]]
```

**The `TIMED_OUT` path genuinely declines deregistration** — asked explicitly, answered by
execution. The row is retained, the entry stays pending and stays reachable, and the bound is
honoured at 3001 ms without fake timers.

The default consumer name in a real process was `linuxconfig-2245127` — `<hostname>-<pid>`. **AC8
confirmed live**, not only through the schema.

---

## 6 · Acceptance criteria — all nine

| AC | Source | Proven by | Verified how |
|---|---|---|---|
| **AC1** batch completes before shutdown | epic `:277` | `U83` | Mutation 5 (my own, isolating) |
| **AC2** nothing lost; entry stays in PEL | epic `:278` | `I18`, `I29` | Mutation 1 → `I29` red by reachability; live branch A |
| **AC3** in-flight work drains before exit | S-26 | `U73`, `U86`, `I30` | Suite green; live branch B |
| **AC4** the drain is bounded | S-26 | `U74` | Mutation 9; **live 3001 ms** |
| **AC5** clean shutdown deregisters | T-039 D3 | `U77`, `I28` | **Live branch B** — row removed |
| **AC6** deregistration never destroys pending entries | P1 | `U78`, `U79`, `U82`, `U88`, `U89`, `I29` | Mutations 1/2/8; **live branch A** |
| **AC7** deregistration failures never block exit | P5, P6 | `U80`, `U81`, `U87`, `U90` | Mutation 8; all four error shapes re-derived |
| **AC8** identity unique per process on a host | D1/B | `U85` + rewritten T-037 pair | Mutations 6/7; **live process name** |
| **AC9** `index.ts:158`'s `void run()` unchanged | S-26 | `U25` | Structural — see below |

**AC9 verified structurally, not taken on trust.** Every added line in `apps/worker-service/src/index.ts`
is a comment (`git diff … | grep "^+" | grep -vE "^\s*//"` → empty), and no `+`/`-` line touches
`streamConsumer.run()`; `void streamConsumer.run()` sits unchanged at `index.ts:197`.

**AC1 and AC2 were satisfied structurally before this change** and needed tests rather than
implementation, as the plan states. I confirmed the mechanism rather than accepting the claim:
the shutdown predicate is the `do`/`while` condition read once per read iteration *after*
`dispatch` has walked the batch, and `stream.consumer.ts` acknowledges nothing.

**Spec-vs-code.** The epic's T-043 snippet is wrong in five ways; I verified each against the
code and they are **spec findings, not code findings** — correctly filed as **S-35**, with a
pointer above the snippet and a "What T-043 actually shipped" block after it. `I18`, cited by
that block for AC2, exists at `apps/worker-service/tests/event.processor.integration.test.ts:692`
and is what it is claimed to be.

---

## 7 · The fixture corrections — the highest-risk part of the diff

The brief asked whether the fakes now match **real** ioredis behaviour, not merely that no
assertion was deleted. **They do.**

The fake at `apps/worker-service/tests/stream.consumer.unit.test.ts:1097-1102` rejects every
parked read **synchronously** when `disconnect()` is called. Measured against the real client,
three runs: the real rejection lands **0–2 ms** after `disconnect()` is issued, with
`Connection is closed.` — a microtask-scale delay, not a perceptible one. A synchronous fake is
therefore a faithful model, and the compression is a determinism gain rather than a fidelity
loss. The rejection *text* matches the production constant
(`WORKER_STREAM_READ.CONNECTION_CLOSED_ERROR_MESSAGE` = `"Connection is closed."`).

One fidelity gap, assessed and **not** a finding: the fake does not model that *subsequent*
commands on a disconnected connection also reject (real client: `REJECTED: Connection is closed.`).
No test depends on the difference, because `stopRequested` latches **before** the disconnect, so
the loop exits at its next predicate check under both behaviours.

The default `xinfo` mock returns `[]` — the reply for a group nobody has read from — so the
pre-T-043 cases that call `stop()` (`U26`, `U35`) find no row and issue no delete. That is the
correct default, and it matches P3.

**Test honesty, sampled beyond the two review rounds.** Helpers meet the repo's bar: `xinfoArgs`
and `delconsumerArgs` **throw** when the call is missing; `delconsumerCalls` is deliberately a
non-throwing filter because *zero is the assertion* in `U78`/`U79`/`U82`/`U87`, with the throwing
sibling alongside; `allLogCalls` throws in both vacuous directions. `U73`, `U84` and `U86` assert
**invocation order** against a shared log rather than two independent `toHaveBeenCalled()`s.
`U77` plants a live peer row holding work, so a guard reading "the first row", "any row" or a
group-wide total fails there rather than shipping.

**The one tautology in the area was found and removed by this change, not left in it.** The
T-037 assertion read `toBe(WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_NAME)` — the very constant
the schema's `.default(...)` is sourced from, so it held whatever that constant said, including
the shared `"worker-1"`. It now compares against a value derived independently from `node:os`
and `process.pid`. I found no case that passes while measuring nothing.

---

## 8 · `DRAIN_TIMEOUT_MS = 3 000`

**Ceiling — correct and asserted.** `U50` pins `DRAIN_TIMEOUT_MS < CASE_BUDGET_MS` (3 000 <
5 000) *and* the two-window sum `RUN_DEADLINE_MS + DRAIN_TIMEOUT_MS < CASE_BUDGET_MS`
(1 500 + 3 000 = 4 500 < 5 000), which is the stronger bound and covers `I30`'s real worst case.

**Floor — the value is right; the argument for it is overstated.** See **QA-1**. Measured, with
the stop arriving at four offsets into a failing loop's `backOff()` pause:

| offset into the 1 000 ms backoff | bound 3 000 (shipped) | bound 500 |
|---|---|---|
| ~20 ms | no timeout, 982 ms | **timed out**, 501 ms |
| ~120 ms | no timeout, 881 ms | **timed out**, 500 ms |
| ~400 ms | no timeout, 600 ms | **timed out**, 501 ms |
| ~800 ms | no timeout, 200 ms | no timeout, 200 ms |

The shipped 3 000 never times out on account of the backoff at any sampled offset. The decision
is sound and `U74` pins the inequality from the floor side.

---

## 9 · Findings

### QA-1 · LOW · A false universal in the `DRAIN_TIMEOUT_MS` floor argument, in three places

**Where:**
- `apps/worker-service/src/constants.ts:483-486`
- `apps/worker-service/tests/stream.consumer.unit.test.ts:2100-2101`
- `docs/plans/t-043-worker-graceful-shutdown.md`, Gate-3 outcome, deviation 4

**The claim:** *"A bound at or below that would make a shutdown during a failing loop time out
**every time**."*

**Measured false in both directions** (table in §8, reproduction below):

- At a bound **equal** to `ERROR_BACKOFF_MS` (1 000) — which "at or below" includes — a stop
  arriving 120 ms into the pause did **not** time out; it completed in 883 ms. The timing-out
  window at equality is ~0 ms wide, so it essentially never times out.
- At a bound **below** it (500), it timed out at offsets 20/120/400 ms but **not** at 800 ms,
  where only 200 ms of backoff remained.

**The real mechanism:** the drain times out only when the *remaining* backoff exceeds the bound,
i.e. when the stop arrives within the first `(backoff − bound)` ms of the pause — a fraction of
shutdowns, not all of them, and zero when the bound equals the backoff.

**Reproduction:** set `DRAIN_TIMEOUT_MS` to 1 000, drive `StreamConsumer` with an always-failing
`xreadgroup` so the loop sits in `backOff()`, wait 120 ms, call `stop()`, and observe no
`"Timed out draining…"` warning and an 883 ms return.

**Disposition:** wording only. The chosen value (3 000) is correct and comfortably clears the
backoff; `U74`'s assertion is correct; no test is weakened and the diff's behaviour is unaffected.
But this is precisely the shape `.claude/rules/review-standards.md` § *Universals Must Cite Their
Mutation* forbids — a general mechanism asserted from probes that varied one dimension — and it
survived two review rounds in three copies (the S-14/S-19 duplication class the plan itself
invokes). Weaken to what was measured, e.g. *"a bound below `ERROR_BACKOFF_MS` times out whenever
the stop lands in the first `(backoff − bound)` ms of a failing loop's pause; 3 000 clears the
pause entirely"* — and change all three copies together.

### QA-2 · LOW · The fixture-fidelity comment attaches its 204 ms to the wrong interval

**Where:** `apps/worker-service/tests/stream.consumer.unit.test.ts:1090-1093` —
*"`disconnect()` issued 200 ms into a `BLOCK 5000` read rejected that read **204 ms later** with
`Connection is closed.`"*

**Measured** (three runs, ioredis 5.11.1 / Redis 7.0.15): total elapsed **201 / 201 / 203 ms**;
after `disconnect()` was issued, **0 / 1 / 2 ms**. So 204 ms is the *total since the read
started*, and the post-disconnect latency is ~1 ms.

**Why it matters at this site specifically, and not at the other two.** This comment is the
justification for a fake that rejects **synchronously**. On the natural reading — "204 ms later
than the disconnect" — the fake looks unfaithful, and the obvious "fix" is to insert a 204 ms
delay, which would be wrong on the measurement and would add ~200 ms to every case that calls
`stop()`. The copies in `src/index.ts:66-69` and `.env.example` carry the *"interrupted 200 ms
in"* clause adjacent to the figure and read correctly.

**Disposition:** reword to *"rejected that read at 204 ms total — ~1 ms after the `disconnect()`
call, which is why a synchronous fake is faithful"*. Documentation only; **the fake itself is
correct and should not change.**

### QA-3 · Coverage gap · the `TIMED_OUT` drain path has no live-Redis case

`U74` and `U79` drive the timeout under **fake timers** only. `I28`–`I31` cover pending-0,
pending-greater-than-0, in-flight-completes and reclaim — none drives a hung handler to the bound
against real Redis. So the *combination* of a real hung handler, a real client, the real 3 000 ms
bound, and the resulting refusal to deregister is unexercised by the suite.

I verified it myself (§5) and it behaves correctly, so this is a **missing regression guard, not
a defect**. It is affordable: 3 000 ms against a 5 000 ms `CASE_BUDGET_MS`, and `U50` already
proves that fits.

**Recommend** either an `I32` in this task, or — if the coordinator prefers not to widen a
change that has cleared two review rounds — an entry in `.claude/rules/known-gaps.md` recording
that the timeout path is fake-timer-only. It pairs naturally with **S-21**, which is the same
shape in usage-service: a guard whose regression test does not isolate it.

---

## 10 · The two entries filed this task, held to the HIGH bar

### S-34 — every measurement reproduces, and it does **not** imply an untaken performance finding

I re-ran the whole sequence on db 14:

```
3 unique-name "restarts" -> 3 rows, all pending 0        (entry acked each time)
XPENDING                 -> [0,null,null,null]           (nothing stranded)
XAUTOCLAIM sweep         -> rows after: 3                (a reclaim does not reap a row)
sleep 2s                 -> idles 2007/2006/2005         (idle grows; no TTL)
DELCONSUMER at pending 0 -> returns 0, rows after: 2     (destroys nothing)
same sequence, shared name "worker-1" -> 1 row
```

All five claims hold, including the shared-name control at exactly one row.

**On the performance question the entry declines to answer.** S-34 says *"Neither has been
measured at a scale where it matters — no test drives a large registry"*, which is honest. I
closed it: at **10 000 registry rows** — orders of magnitude beyond anything an unclean-exit leak
produces outside a crash loop — `XINFO CONSUMERS` costs **26 ms** and
`parseConsumerReading`'s worst-case walk (own row last) costs **2.6 ms**. So **S-34 does not
imply a performance finding that nobody took**; the cost is negligible at implausible scale.
Suggest annotating S-34 with these two numbers so the question is closed rather than left open —
that is an improvement to the entry, not a defect in it.

### S-35 — all five divergences verified against the code

Each of the five re-derived against `docs/epics/epic-7-worker-service.md:262-278` and
`apps/worker-service/src/index.ts`. `bullWorker` genuinely does not exist anywhere in the
workspace. The forward obligation to T-042 is recorded in the epic as well as in S-35, so it is
durable rather than a review-comment aside.

### The four post-Round-2 citation fixes — all resolve

| Fix | Verified |
|---|---|
| Pointer above the epic's T-043 snippet | Sits at `:258-260`, immediately **above** the snippet at `:262` |
| S-35 cites `:262-278` | Snippet `:262-274`, `**Acceptance**:` `:276`, ACs `:277-278` — exact |
| Plan AC1 `:277` / AC2 `:278` | `:277` = *"Current message batch completes before shutdown"*; `:278` = *"No messages are lost…"* — exact |
| S-33's title widened | Now reads *"stale counts, **and measurements attached to the wrong mutation**"* — covers both shapes |

Re-deriving the ranges after the line shift, rather than reusing the reviewer's pre-shift
numbers, was the right call and produced correct results.

---

## 11 · Regression risk

**Breaking-change surface across the other 12 packages: nil.**

- `git diff --name-only fc66bd3` touches only `apps/worker-service/**`, `docs/**` and
  `.claude/rules/known-gaps.md`. **No `packages/**` file is modified.**
- Nothing in the workspace imports `@telemetry/worker-service` (grep over `package.json` and
  `*.ts` outside the service itself → no matches). It is a leaf.
- All 12 other packages green at the `--force` gate, `0 cached`.

**T-038 / T-039 / T-040 / T-041 all still behave**, and green for the right reasons rather than
by short-circuit: `I1`–`I6` (bootstrap), `I7`–`I12` (loop), `event.processor.integration` 14/14
(processor), `dead-letter.service.unit` 8/8 plus `I23` (retry / dead-letter) all pass, and the
suites that share `stop()` — `U26`, `U35`, `I12` — now run against a fixture that *models* the
real disconnect rather than a no-op, which is a strengthening of those neighbours.

**The S-26 comment narrowing did not drift.** The three scope-comment blocks at
`stream.consumer.unit.test.ts` lines 1208-1247, 1442-1481 and 1505-1544 are **byte-identical**
(3 blocks, 1 distinct text), and `grep -c "S-26"` is 9 — matching the plan's restated R6, which
correctly replaced the mention-count proxy with the property it was a proxy for.

The stderr noise in the worker run (`Error: load failure`, `EACCES`, `Reached the max retries per
request limit`) is expected output from deliberately-failing negative cases (T-074 env-file
resilience, `U8` Redis-unreachable) and is pre-existing.

---

## 12 · What I could **not** validate, and why

- **Multi-host hostname collision.** AC8's limit — *"unique per process on a host"* — cannot be
  falsified from one machine. The claim is correctly scoped everywhere it appears; I confirmed
  the scoping rather than the property.
- **Anything under docker-compose or Kubernetes.** Docker Desktop's daemon is down, and the
  repository has no manifests at all (`ls docker-compose*.yml k8s/ deploy/` → all absent), which
  independently confirms decision **D2**'s premise that there is no orchestrator grace period to
  tune against.
- **S-26's inherited-and-unmarked tables** — the "3–6 ms whole handler", "4 of 5 runs at
  `STREAM_BLOCK_MS=20`" and `U25`'s "three turns, not one". The plan marks these
  inherited-and-unverified; they need nine real SIGTERM runs plus a microtask trace, and none is
  load-bearing for this diff. I did not re-derive them and do not treat them as established.
- **S-34's consequence over real time.** I measured the *mechanism* and the cost at 10 000 rows,
  but not an actual crash-looping deployment accumulating rows over days.
- **Behaviour behind a connection pooler, or on a managed Redis without multiple logical
  databases.** Both are noted in `known-gaps.md` (S-21, S-22) as standing platform limits.
- **`I30`'s `HANDLER_WORK_MS: 150` under CI load.** It passed locally with three orders of
  magnitude of headroom to the 3 000 ms bound; I did not run it on a loaded machine.

---

## 13 · Environment — left as found, with three disclosures

**Final state:** `db14 = 0` (worker's reserved database, as required) · `db0 = 1`, having
been 2 mid-session before the TTL'd `denylist:*` key in disclosure 2 expired on its own ·
`XLEN telemetry:events = 2`, `last-generated-id 1788171536033-0` **unchanged**.

**Tree byte-identical to the start:** `git diff --stat fc66bd3` → **11 files changed, 2588
insertions(+), 75 deletions(-)**, exactly as at handoff; `md5sum -c` on all three files I mutated
returns `OK`; the only untracked files are the plan and the review. Every probe test file I
created was removed.

1. **I used `FLUSHDB` on db 14 twice**, where the brief asked to prefer targeted `DEL`. Both
   times I enumerated the database with `KEYS '*'` immediately beforehand and confirmed it held
   only my own `telemetry:events:qa043:*` keys (plus the `retries:` key the handler created), with
   no suite running concurrently. Every other cleanup used targeted `DEL`. Disclosed because it
   departs from the instruction, not because anything was lost.
2. **db 0 gained one key during my `pnpm test --force` run** —
   `denylist:c6d6d2a719524df30db1676189d002da`, a TTL'd string (`ttl=837`). That is **S-22**:
   auth-service's integration suite writes to db 0. Pre-existing, unrelated to T-043, and
   self-expiring. `telemetry:events` was not touched.
3. **A stray worker process from a *previous* QA session is still running and I did not stop it.**
   Pids `184521`/`184537`, started **Thu Sep 10 14:43**, `PORT=3903`,
   `REDIS_STREAM_NAME=telemetry:events:qa-t038`, `REDIS_URL=redis://localhost:6379/12`. It is not
   mine — it predates this session by five days and points at db 12 (currently empty) — so I left
   it alone. It looks like a leak from T-038's QA gate and someone may want to reap it.
   My own smoke run briefly leaked two processes, because the first `kill -TERM` hit the
   `env`/`npx` wrapper rather than node; both were identified by pid and killed, and db 14 was
   cleaned.

---

## 14 · Release-readiness call

**PASS — ship it.**

The change does what it claims, and the claim is the right one. `XGROUP DELCONSUMER` on a
consumer holding pending entries destroys billing events permanently and silently (P1,
reproduced); the shipped guard refuses to issue it unless the drain completed *and* this
consumer's own row reads `pending 0`; and the instance-unique name is what makes that reading
trustworthy rather than shared (P11/P12, reproduced, and the residual reproduced through the
shipped class). Both halves are present and both are necessary. I verified both guard branches
and the timeout branch in a real worker process under a real SIGTERM, which is the strongest
evidence available short of a deployment.

The three findings are documentation wording (QA-1, QA-2) and one affordable missing regression
guard (QA-3). None blocks the commit. **QA-1 is worth fixing before commit** — it is a false
universal in an authoritative constants docblock, duplicated three ways, and the repo's own
review standard singles out exactly that shape; it is a three-line edit. QA-2 is a one-line edit
in the same package. QA-3 is a judgement call for Gate 6 between adding `I32` now and recording
it as a known gap.

Nothing here loops back to Gate 3.

---

## 15 · Decision for the user — QA-3

> **The `TIMED_OUT` drain path is exercised only under fake timers. Add a live-Redis case now, or
> record it as a known gap?**

| | Option | What changes | Diff? |
|---|---|---|---|
| **A** | **Add `I32`** — a hung handler drained to the bound against real Redis, asserting the row is retained, the entry stays pending and stays reachable | One integration case, ~3 s. Closes the gap in this task | **Yes** — one test file |
| **B** *(recommended)* | **Record it in `.claude/rules/known-gaps.md`** and commit as-is | The gap is documented and citable; T-043 ships on the revision that cleared two reviews | **Yes** — `known-gaps.md` only |
| **C** | **Neither** — accept the fake-timer coverage silently | Nothing. The gap exists and is uncited | No |

**I recommend B.** I verified the behaviour is correct, so nothing is broken — what is missing is
a *guard against a future regression*, and that is a smaller claim than the one that justifies
widening a change already through Gate 4 twice. It is also the same shape as **S-21**, which this
repo has already chosen to document rather than fix, so B is the consistent precedent. Option A
is defensible if the coordinator would rather close the gap while the context is fresh; it is
low-risk, since `U50` already proves 3 000 ms fits the case budget.

**A and B both change the diff; C does not.** A changes test code, B changes documentation only.
None of the three changes production behaviour.

*(QA-1 and QA-2 are not offered as choices — both are straightforwardly wrong statements in the
tree and should simply be corrected. Neither affects behaviour.)*
