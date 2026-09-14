# QA — T-041 · Retry tracking + dead-letter handler

| | |
|---|---|
| **Gate** | 5 — QA Tester |
| **Task** | T-041 · Retry tracking + dead-letter handler (worker-service) |
| **Base** | `c88a933`, uncommitted working tree, nothing staged |
| **Plan / Review** | `docs/plans/t-041-retry-tracking-dead-letter.md` · `docs/reviews/t-041-retry-tracking-dead-letter.md` (Round 2: CONDITIONAL) |
| **Verdict** | **FAIL** — narrow, documentation-only |

**Every behavioural claim this change makes passes.** Gates are green on my own `--force` run,
all ten acceptance criteria are proven by tests I reddened by mutation, the db-0 containment
holds under a reproduction I performed myself, and both halves of the retired S-31 are genuinely
closed. The block is **one false claim in `.claude/rules/known-gaps.md`** — a file `CLAUDE.md`
designates authoritative and instructs other agents to trust without re-verification, which
`.claude/rules/review-standards.md` rates **HIGH**. It is three lines of Markdown and no code.

If the gate call were mine to weigh on risk alone I would pass this. It is FAIL because the rule
that makes that file trustworthy has no severity band below HIGH, and the false row sits inside
the entry that exists to stop exactly this defect.

---

## 1. Full gates — my own `--force` run, all 13 packages

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` · exit 0 |
| lint | `pnpm lint --force` | `13 successful` · **0 errors, 14 warnings** · exit 0 |
| build | `npx turbo run build --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` · exit 0 |
| test | `pnpm test --force` | `13 successful` · `0 cached` · exit 0 |
| smoke | `pnpm test:smoke` | 6 suites, 7 tests, all passing · exit 0 |

`Cached: 0 cached, 13 total` on every task — this is a re-run, not a replay of the implementer's
results.

**Per-package test totals, verbatim:**

```
shared-tracing     2      analytics-service   18
shared-config      4      gateway             38
shared-logger      4      billing-service     18
shared-types       8      usage-service      230
shared-validation 15      auth-service       164
shared-utils      18      worker-service     156  (12 files)
web                       vitest run --passWithNoTests
```

Worker at **12 files / 156 tests**, matching the stated baseline exactly.

**Smoke, per suite:** gateway 2, auth 1, usage 1, billing 1, analytics 1, worker 1 — 6 suites,
7 tests.

### The 14 warnings are pre-existing — proven, not asserted

- `git status --porcelain apps/auth-service apps/usage-service` → **empty**. Neither package is
  touched by this diff.
- eslint names the two files: `apps/auth-service/tests/auth.service.unit.test.ts`
  (10 × `no-misused-promises`) and `apps/usage-service/tests/ingestion.service.unit.test.ts`
  (4 × `no-unsafe-assignment`).
- `git log -1` on those files → **`d68e719`** (2026-08-25) and **`b0f6921`** (2026-08-31).
- `grep -c "no-unsafe-return"` over the whole lint log → **0**.
- worker-service lint output is clean — no findings block at all.

**Zero warnings introduced.** Matches the expectation in the handoff (10 @ `d68e719`,
4 @ `b0f6921`, zero `no-unsafe-return`).

---

## 2. Acceptance criteria — walked one by one, each red-tested

I did not take the plan's mutation results on report. Every row below was reddened by me, on
this tree, and reverted. Failure text is verbatim.

| AC | Proven by | My mutation | Result |
|---|---|---|---|
| **AC1** env fields parse and reject | 8 env cases | drop `.min(1)` from `DEAD_LETTER_STREAM` | `× rejects a blank DEAD_LETTER_STREAM → expected true to be false` · `1 failed \| 37 passed` |
| **AC1** (collision, M-6) | `rejects a DEAD_LETTER_STREAM equal to REDIS_STREAM_NAME` | delete the `.superRefine` | `× rejects a DEAD_LETTER_STREAM equal to REDIS_STREAM_NAME → expected true to be false` · `1 failed \| 37 passed` |
| **AC2** failure counts, TTLs, rethrows | `U62`, `I24` | — (covered by AC3's `>` mutation and M1) | green; `I24` asserts pending list + counter + `TTL > 0` against live Redis |
| **AC3** `XADD`→`XACK`→`HDEL` order | `U65`, `U61` | swap `XACK` above `XADD` | `× U65 → expected 44 to be less than 43` (+ `U61` command sequence) · `2 failed \| 6 passed` |
| **AC3** threshold | `U63` | `>=` → `>` in the catch | `× U63 → promise rejected … instead of resolving` · `5 failed \| 3 passed` |
| **AC3** record content | `U64` | drop `payload` from the `XADD` | `× U64 → expected null to deeply equal [ 'eventId', …(5) ]` · `1 failed \| 7 passed` |
| **AC4** exhausted counter ⇒ no processing | `U67` | move the pre-check below `inner` | `× U67 → expected [ { id: '1789101023800-0', …(1) } ] to deeply equal []` · `2 failed \| 6 passed` |
| **AC5** conditional `HDEL` | `U66`, `I25` | delete the conditional `HDEL` | `× U66 → hdel was never called a 1th time` · `1 failed \| 7 passed` |
| **AC6** retry inside one `run()` | `U70`, `I23` | delete the cadence block | see §2.1 — `4 failed \| 152 passed`, all by assertion |
| **AC6b** cadence ≠ per iteration | `U71` | unconditional `recoverPendingEntries` in the loop body | `× U71 → expected "spy" to be called 1 times, but got 6 times` |
| **AC7** diagnosis names fields, not values | `U59`, `U60`, `I27` | (a) revert to the bare constant; (b) append `JSON.stringify(record)` | (a) `× U59 → expected … to contain 'invalid_type'`; (b) `× U60 → SENTINEL-EVENT-ID-8f2a: expected … not to contain 'SENTINEL-EVENT-ID-8f2a'` |
| **AC8** nothing tenant-bearing logged | `U68`, `I27` | — | `U68` drives all four paths through one subject, serialises **every** logger call, and its helper throws if the subject logged nothing. Non-vacuous by construction. |
| **AC9** Q10 recorded decided | docs review | — | `docs/epics/README.md` and both mentions in `docs/epics/epic-7-worker-service.md` carry **decided**. Verified by reading. |
| **AC10** no repository / Prisma / new dep | `U61` | — | `DeadLetterService.length === 3`; `duplicate`/`del`/`hset`/`xdel` wired to throw; `git status --porcelain package.json prisma/` empty. Verified. |

### 2.1 The cadence mutation, in full

Deleting the cadence block from `runLoop` (`apps/worker-service/src/events/stream.consumer.ts:481-484`)
and running the whole worker suite:

```
× U70 - reclaims again inside one run(), once the cadence interval has elapsed 2007ms
  → expected 1 to be greater than or equal to 2
× I26 - MAX_RETRY_COUNT failures inside one run() dead-letter the entry, clear the PEL and the counter (T-041) 1594ms
  → expected 1 to be greater than or equal to 3
× I27 - a malformed message's dead-letter reason names the field, never its value (S-31) 1518ms
  → expected [] to have a length of 1 but got +0
× I23 - re-offers a failed entry inside one run(), with no restart (T-041) 1596ms
  → expected 1 to be greater than or equal to 2
 Test Files  3 failed | 9 passed (12)
      Tests  4 failed | 152 passed (156)
```

**Every one fails by assertion. No `Test timed out in 5000ms` anywhere.** This is the specific
thing asked about, and it is structural rather than lucky: `stopWhen` (`tests/stream.consumer.unit.test.ts:730-734`)
ORs its predicate with a wall-clock `STOP_DEADLINE_MS`, and `U50` pins every such deadline below
the runner budget. The loop therefore always terminates and the assertion always runs. The same
shape holds for `I23`/`I26`/`I27` through `RUN_DEADLINE_MS`.

`I24` and `I25` stay green under this mutation, correctly — neither needs a second delivery.

### 2.2 Epic-vs-code, reported as spec findings

All four S-32 divergences plus the unstated cost re-derived against `docs/epics/epic-7-worker-service.md`:
`:151` names `src/events/dead-letter.handler.ts` (`ls apps/worker-service/src/events/` →
`index.ts`, `stream.consumer.ts` only); `:154`'s Prometheus counter has no substrate
(`grep -rn "prom-client" --include=package.json .` outside `node_modules` → no match);
`:154`'s "clear from PEL so it doesn't block the consumer" is false as stated; `:158-172`'s
snippet is a free function over module scope; `:156`'s pre-check is a cost the epic does not
mention. The epic self-corrects at `:184-202`, above which the wrong text remains.
**These are spec findings, not code findings** — the implementation is right and S-32 records
them. One inaccuracy inside S-32 itself: see F-2.

---

## 3. The db-0 containment — re-derived, then pushed further

This was the priority and I did not take any part of it on report.

### 3.1 The structural fix, verified by reproduction

`apps/worker-service/tests/setup.ts:31` is `process.env.REDIS_URL ??= "redis://localhost:6379/14"`.

I reproduced the escape **and** the containment in one probe. I removed the `hincrby` stub from
`tests/config/container.unit.test.ts:70-72` so the command genuinely reaches a real server, and
ran the suite through turbo.

### 3.2 The CI half — turbo strict-env filtering, measured twice

`.github/workflows/ci.yml:31` sets `REDIS_URL: redis://localhost:6379` at job level, and
`setup.ts` uses `??=`, so an ambient value would defeat the pin. It does not.

**Dry run.** `npx turbo run test --filter=@telemetry/worker-service --dry=json`:

```
@telemetry/worker-service#test | envMode= strict | env= [] | passthrough= None
```

**Live probe, with a decoy.** `REDIS_URL=redis://localhost:6379/9 npx turbo run test --filter=@telemetry/worker-service --force`,
with the stub removed:

```
before:  db9 DBSIZE=0   db0 DBSIZE=2   db14 DBSIZE=0
after:   db9 DBSIZE=0   keys=(none)
         db0 DBSIZE=2   retries:*=(none)   EXISTS telemetry:dead-letter=0
         db14 DBSIZE=1  keys=retries:telemetry:events
```

The override was filtered; the key landed in **db 14**; db 0 and the decoy db 9 were untouched.
Both halves hold. Probe key deleted, test file restored, db 14 back to `DBSIZE 0`.

### 3.3 Pushed further — every Redis reach point in the package

Asked to look for a path that reaches Redis *without* the default. `grep -rn "new RedisClient(\|new Redis("`
over `src` and `tests` returns **five** constructions, not the three the review lists:

| Site | URL source | Database |
|---|---|---|
| `src/config/container.ts:61` | `env.REDIS_URL` | db 14 under tests via `setup.ts` |
| `tests/event.processor.integration.test.ts:227` | `reservedDbUrl` | forced `/14` at `:224-226` |
| `tests/event.processor.integration.test.ts:580` | `reservedDbUrl` | same |
| `tests/stream.consumer.integration.test.ts:222` | `reservedDbUrl` | forced `/14` at `:219-221` |
| `tests/stream.consumer.integration.test.ts:365` | `reservedDbUrl` | same (×8 clients) |

The two the review did not enumerate (`event.processor…:580`, `stream.consumer…:365`) both take
`reservedDbUrl`, which is built by `new URL(...)` then `redisUrl.pathname = "/14"` — the pathname
is **overwritten**, so `INTEGRATION_REDIS_URL_FALLBACK`'s bare `redis://localhost:6379`
(`tests/integration.constants.ts:15`) can never select db 0 through any of them. Not a gap; the
review's count was just low.

**Hard-coded `redis://` literals in the package:** four. `.env.example:13` (documentation),
`tests/setup.ts:31` (the pin itself), `tests/setup.ts:10` (a comment),
`tests/env.schema.unit.test.ts:21` (a schema fixture value — `EnvSchema.safeParse` only, never
connected), and `tests/integration.constants.ts:15` (always pathname-overwritten). **Nothing
reaches a server outside the pin.**

**Every `FLUSHDB` goes through a guarded helper** that re-asserts `CLIENT INFO` contains `db=14`
on each call, in both integration suites — the shape S-22's fix direction prescribes, not the
one-guard-in-`beforeAll` shape it warns against.

---

## 4. The three items applied since Round 2 — each re-measured

**R2-1 — the recount.** `grep -c 'WORKER_STREAM_CONSTANTS\.' src/config/env.ts` → **12**.
`src/constants.ts:126-131` now states 12 with the `.superRefine` message given its own clause.
Correct. (But see F-1: the *history* of this number is what S-33 gets wrong.)

**R2-2 — the `ZodEffects` recipe.** Measured by importing both real modules under vitest,
zod 3.25.76:

```
WORKER constructor: ZodEffects          WORKER typeName: ZodEffects
WORKER "shape" in EnvSchema: false      WORKER (EnvSchema).shape: undefined
WORKER innerType().shape.REDIS_STREAM_NAME.safeParse("")    -> THROWS String must contain at least 1 character(s)
WORKER innerType().shape.REDIS_CONSUMER_GROUP.safeParse("") -> THROWS String must contain at least 1 character(s)
WORKER innerType().shape.DEAD_LETTER_STREAM.safeParse("")   -> THROWS String must contain at least 1 character(s)
USAGE  constructor: ZodObject
USAGE  shape.REDIS_STREAM_NAME.safeParse("")                -> OK -> ""
```

**Both halves confirmed.** The replacement recipe works, returns the identical message, and the
per-service split documented at `src/events/stream.consumer.ts:272-282` and
`.claude/rules/known-gaps.md:583-590` is accurate. Nothing S-23 *asserts* changed; the LOW
severity call in Round 2 was right.

**R2-3 — `.env.example`.** `:97-101` now reads "This is enforced, not advisory -- the env schema
rejects the collision at startup (T-041, decision M-6), so a worker configured this way does not
boot." Correct.

**R2-4 — the `satisfies` guard.** Mutated `"DEAD_LETTER_STREAM"` → `"DEAD_LETTER_STREAMS"`:

```
src/config/env.ts(95,38): error TS1360: Type '"DEAD_LETTER_STREAMS"' does not satisfy the
expected type 'requiredKeys<baseObjectOutputType<{ … DEAD_LETTER_STREAM: ZodDefault<…>; }>>'.
```

Clean on revert. **Confirmed** — the guard does what R2-4 asked for.

**R2-5 / R2-6.** Both S-31 references in `tests/event.processor.integration.test.ts` (`:967`,
`:988`) now say "the retired S-31 entry". S-32's title now reads "four ways, plus one unstated
cost" and matches its body. Both applied.

---

## 5. The S-31 closure — both halves, and the negative's scope

**Diagnosis half — closed.** `describeIssues`
(`apps/worker-service/src/validators/stream-message.validator.ts:128-139`) projects each zod
issue to `` `${issue.code}:${issue.path.join(".")}` `` and nothing else. `issue.message` is never
read; `issue.keys` is never read. The odd-length branch (`:154-158`) emits the field-list
**length**, a count. Proven in both directions by my M9/M10 mutations above.

**Retries-forever half — closed.** The dead-letter path is wired (`U69`, mutation-verified in
§2) and fires end to end against live Redis and Postgres (`I26`, `I27`). Under the cadence
mutation `I27` goes `expected [] to have a length of 1` — i.e. without the cadence the malformed
message never terminates, which is the old behaviour, and the suite catches it.

**The "no value reaches the log" negative, and its scope.** The negative is real — `U60` reddens
when a value is appended (`SENTINEL-EVENT-ID-8f2a: expected … not to contain 'SENTINEL-EVENT-ID-8f2a'`),
and `I27` re-asserts it against a live dead-letter record with three sentinels including a
customer-chosen metadata **key**.

The scope is stated correctly and conditionally at `src/constants.ts` (the `ERROR.DETAIL`
docblock):

> "…the safety comes from the projection, not from the schema being non-strict — but the scope
> of that is this flat seven-field schema, whose paths are all declared names. A nested or
> record-valued schema could put a customer key in a `path`, and this rule would not cover it."

That is exactly the falsifying case, named rather than glossed. `envelopeSchema`
(`stream-message.validator.ts:103-113`) is confirmed flat: seven `z.string()` fields, no nesting,
no `z.record`. The claim is scoped to what was measured. **Nothing to raise here.**

---

## 6. Test honesty — sampled independently

I sampled beyond the two review rounds, looking for tests that could pass while measuring nothing.

**What holds up.** The `DeadLetterService` harness records a `commands` array and asserts exact
command *sequences* (`["hget"]`, `["hget","hincrby","expire"]`,
`["hget","hincrby","expire","xadd","xack","hdel"]`) — behaviour, not a mock's return value.
Locator helpers throw rather than returning `undefined`: `nthArgs` gave
`hdel was never called a 1th time` under M3, and `allLogCalls` throws both when a logger method
is missing and when the subject logged nothing at all. `U65` uses `invocationCallOrder`, not
three independent `toHaveBeenCalled()`s. The fixture deliberately avoids `mockResolvedValue`
(which would silently replace the recorder) in favour of reply queues, with the reason written
down. `U63` asserts `OVERRIDE.MAX_RETRY_COUNT !== DEFAULT_MAX_RETRY_COUNT`, so it cannot pass for
a subject that ignores the parsed env. `U71` asserts its own premise
(`elapsed < cadenceMs`, "the fixture ran longer than one cadence window") before making its
claim. `I25` seeds the counter out of band rather than depending on having produced a failure
first. `I26` observes acknowledgement as its effect on the server (`readPendingIds` empty), not
as a spy call.

**The retry pre-check and conditional `HDEL`, specifically asked about.** Both are genuinely
pinned. `U67` asserts `innerCalls` is `[]` *and* `hincrby` was not called — the post-check
mutation reddens it with `expected [ { id: … } ] to deeply equal []`, which is the pre-check
property and nothing weaker. `U66` covers both arms in one case (no counter ⇒ `commands === ["hget"]`;
counter present ⇒ `hdel` called with the right key and field) and reddens on deletion.

**What does not.** One new branch is entirely uncovered — F-3 below.

---

## 7. Findings

### F-1 · `.claude/rules/known-gaps.md` S-33, row 1 is false — **HIGH**

`.claude/rules/known-gaps.md:1066` (S-33's instance table, first row):

> \| `WORKER_STREAM_CONSTANTS` has "seven members feeding `env.ts`" \| T-040's own diff — eleven \|

**Both halves are wrong, and the table header calls each row "verified by re-running the stated
command".** Measured across every commit that touched the file:

```
$ for c in 7ad9375 b558641 7dc7392 c88a933; do
    git show $c:apps/worker-service/src/config/env.ts | grep -c 'WORKER_STREAM_CONSTANTS\.'; done
7ad9375 -> 7    b558641 -> 7    7dc7392 -> 7    c88a933 -> 7
$ git show c88a933:apps/worker-service/src/constants.ts | grep -n "seven\|one per member"
73: * file consumes them: every one of that object's **seven** members feeds
78: * `grep -c 'WORKER_STREAM_CONSTANTS\.' src/config/env.ts` -> 7, one per member.
$ git show --stat c88a933 -- apps/worker-service/src/config/env.ts
(no output — T-040 did not touch env.ts at all)
```

So the "seven" claim was **true at T-040 and at every earlier commit**. The change that falsified
it is **T-041 — this one** — which took it to 11, and then M-6 took it to 12. `eleven` was never
the value at T-040; it was T-041's intermediate value.

Two consequences beyond the row itself:

1. **Rows 1 and 2 are the same claim at two stages.** Row 2 is "the same docblock's `grep -c`
   figure of **11** … refuted by T-041's own `.superRefine` — **12**". Rows 1 and 2 are 7→11 and
   11→12 of one figure, in one file, inside one task. "seven measured instances" counts them as
   two. Six distinct claims is the defensible number.
2. **The header universal is false.** "Instances, all from T-039 through T-041, each verified by
   re-running the stated command." Row 6 (S-19 prose) and row 7 (S-32's title) carry no command.
   Row 5's prior text ("fourteen distinct log messages") appears in **no committed revision** —
   `git show 7dc7392:…/constants.ts` has no such sentence and `c88a933` already reads
   "**sixteen** log calls; fifteen of those messages", against 16 actual `logger.*` calls — so it
   was caught pre-commit and cannot be re-run at all. Three of seven rows are not
   command-verifiable.

**Severity.** `.claude/rules/review-standards.md`: "A false claim in `CLAUDE.md` or
`.claude/rules/` is **HIGH** — those files are designated authoritative and other agents are
instructed to trust them without re-verification." Nothing behavioural depends on it. What
depends on it is the entry's own credibility: S-33 exists to argue that counts in comments go
stale, and its evidence table went stale in the commit that wrote it.

**Rows I did verify as true:** row 2 (12, measured above), row 3 (`grep -rn "\.xadd(" apps packages --include=*.ts`
excluding `dist/` and `tests/` → exactly two production sites, `stream.publisher.ts:70` and
`dead-letter.service.ts:192`, both passing `"*"`), row 4 (the grep returns five lines, one being
the sentence carrying the pattern — self-match confirmed), row 6 (`grep -rn "extends TenantScopedRepository" apps/*/src`
→ two real subclasses, `UsageRepository` and T-040's `EventRepository`), row 7 (S-32's title now
matches its body after R2-6). Row 5 is not falsifiable from git, as above.

**Fix:** correct row 1 to name T-041 as the refuting change with the right before/after
(`7 → 11`), or merge rows 1 and 2 into one row reading `7 → 11 → 12, all within T-041`; and
weaken the header from "each verified by re-running the stated command" to what is true of all
seven.

### F-2 · `.claude/rules/known-gaps.md` S-32 — "the epic's block counts all five together" is false — **LOW**

`.claude/rules/known-gaps.md`, S-32's *Scope of "five ways"* paragraph, closes:

> "The epic's `:184-202` block counts all five together."

They are two different fives with the same cardinality. S-32's items are {file path, free
function, Prometheus, PEL claim, **`:156` pre-check cost**}. The epic's `:184-202` items are
{file path, class vs free function, Prometheus, PEL claim, **the record carries `groupName` and
the full field list**}. The epic never mentions the pre-check cost; S-32 never lists the added
`groupName`. The sentence is precisely the kind of enumeration claim S-33 is about.

**Fix:** "The epic's `:184-202` block also lists five, but not the same five — its fifth is the
record's `groupName` and field list, where this entry's is the pre-check cost."

### F-3 · `readRetryCount`'s NaN guard is covered by no test — **LOW (coverage)**

`apps/worker-service/src/services/dead-letter.service.ts:147`:

```ts
return Number.isNaN(parsed) ? WORKER_DEAD_LETTER.RETRY_COUNT_NONE : parsed;
```

Its docstring (`:135-137`) makes a specific safety claim: "A reply that is not a number is
treated as zero rather than as `NaN`: `NaN >= max` is `false`, so a corrupt counter would
silently grant unlimited retries, where zero grants the normal budget."

**Measured.** Replacing that line with `return parsed;`:

```
 Test Files  12 passed (12)
      Tests  156 passed (156)
```

The guard can be deleted with the entire suite green. A claim of this shape needs the mutation
that establishes it (`.claude/rules/review-standards.md`, *Universals Must Cite Their Mutation*),
and the cost of closing it is one line in the existing harness —
`hgetReplies.push("not-a-number")` plus `expect(innerCalls).toHaveLength(1)`.

Low severity because nothing in the platform writes a non-numeric value into the hash: the only
writer is `HINCRBY` in this same file. It is defensive code for a state no code path produces —
which is exactly why it should be tested rather than trusted.

### F-4 · A failing `XADD` inside `deadLetter` is untested — **NIT**

`dead-letter.service.ts:181-184` asserts what happens when the dead-letter write fails: "a
failure of the `XADD` propagates, which leaves the entry pending and its counter intact, so the
next delivery tries to dead-letter it again." No test drives it. It follows trivially from the
absent `try`, but the claim is about the entry and the counter, two steps downstream. One case
with `xadd` rejecting would pin it.

### F-5 · The `xadd` re-count command self-matches — **NIT**

`src/constants.ts:598` states the command
`grep -rn "\.xadd(" apps packages --include=*.ts` (excluding `dist/` and `tests/`) and lists two
call sites. Re-running it returns **three** lines — the third is `constants.ts:598` itself,
because the comment carries the pattern. The comment claims no line count, so nothing false is
asserted, but this is the identical self-match that S-33's own row 4 records for
`RESERVED_STREAM_FIELDS`. One `| grep -v constants.ts` in the stated command, or a sentence
noting the self-match as `:432` already does for the other one.

---

## 8. Coverage gaps beyond the findings

- **Concurrency is unmeasured, and honestly so.** Two workers each incrementing one entry's
  counter for one logical failure (plan R2) has no test and cannot get one without a two-process
  harness. The plan calls it "reasoned, not measured"; that remains true and is the right label.
- **The `MAX_RETRY_COUNT`/`STREAM_BLOCK_MS` coupling (plan R7) has no test.** After the cadence
  lands, one threshold is both peer-safety margin and retry spacing. Asserting it means pinning a
  wall-clock relationship, which this package has three prior incidents against. Documented in
  two places, guarded nowhere. Correctly disclosed; I would not add a test.
- **Boundary values are well covered.** `MAX_RETRY_COUNT` at both bounds, outside both bounds,
  fractional, coerced-from-string; `DEAD_LETTER_STREAM` default, override, blank, collision
  against an explicit value *and* against the default. `readRetryCount` at `0`, at `max`, and
  `null`; `U63` at `max - 1` and `max`.
- **The empty/absent cases are covered** — `HGET` → `null`, empty hash self-deleting
  (`I25` asserts `EXISTS` → 0), `HDEL` idempotence.

## 9. Regression risk

- **Nothing outside worker-service changed.** `git status --porcelain` lists 26 paths: 19 under
  `apps/worker-service/`, plus `.claude/rules/known-gaps.md`, two `docs/epics/` files, and the
  plan/review/QA artifacts. No `package.json`, no `prisma/`, no other app or package.
- **No package depends on `@telemetry/worker-service`.** `grep -rn "worker-service" --include=package.json .`
  outside `node_modules` returns only the root `test:smoke` scripts and the package's own
  declaration. It is a leaf app. Breaking-change surface across the other 12 packages: **none**.
- **The one contract change is worker-service's startup.** M-6's `.superRefine` makes a worker
  with `DEAD_LETTER_STREAM === REDIS_STREAM_NAME` refuse to boot. No `docker-compose*.yml` and no
  CI workflow sets either variable
  (`grep -rn "REDIS_STREAM_NAME" docker-compose*.yml .github/workflows/*.yml` → no match), and
  the two defaults differ, so no existing deployment is affected. Worth one line in the release
  note as a fail-closed startup change.
- **T-038, T-039, T-040 still behave.** All 156 worker tests green, including `I8`–`I22`. The
  over-correction mutation reddened `U19`, `U24`, `U36`, `U38`, `U39` — T-038/T-039 recovery
  cases that still hold their ground against a change to the loop body, which is evidence they
  are not short-circuiting. `I14` (T-040's idempotent replay) green.
- **`pnpm test --force` was fully uncached** (`0 cached, 13 total`), so no neighbouring suite was
  replayed rather than run.

## 10. What I exercised, and what I could not

**Exercised:** all four gates with `--force` plus smoke; eleven mutations, each reverted and each
verified by hash; the db-0 reproduction with a decoy `REDIS_URL` through turbo; turbo's strict-env
filtering by dry run and by live probe; the `ZodEffects` recipe against both real schemas; the
`satisfies` guard by TS error; four of the seven S-33 rows by re-running their commands; the S-33
row-1 history across four commits; S-32's epic citations; the `xadd` re-count; the
`RESERVED_STREAM_FIELDS` self-match; every Redis construction in the package; `.env.example`'s
arithmetic against `DEFAULT_BLOCK_MS: 5_000` and `RECOVERY_IDLE_MULTIPLIER: 2`; live Postgres and
Redis throughout.

**Could not exercise, and why:**

- **Two concurrent workers.** No harness exists and building one is its own task. R2's
  double-increment stays reasoned.
- **`MAXLEN` eviction under the shipped code path.** Inherited from the plan's P-TRIM probe. I
  did not re-run it; `U64` and `I26` pin the property it justifies (the record carries the field
  list), which is what carries the weight.
- **M-6's "confirmed red *before* the refinement existed".** A claim about the past. I verified
  the present-tense equivalent instead (deleting the refinement reddens exactly that case).
- **S-33 row 5's prior "fourteen distinct log messages" text.** It exists in no committed
  revision, so it cannot be re-derived. Recorded as unverifiable rather than assumed true — see
  F-1.
- **A real deployment boot with the collision set.** The refinement is asserted at the schema and
  by the module-load throw the reviewer measured; I did not start a worker process.
- **`pnpm format:check`** — not run. It cannot pass on any revision of this repository (S-12) and
  is not in CI.

## 11. Datastore state — before and after

| | Before | After | Required |
|---|---|---|---|
| db 0 `DBSIZE` | 1 | 2 | — |
| db 0 `XLEN telemetry:events` | 2 | **2** | 2 ✓ |
| db 0 `entries-added` | 2 | **2** | 2 ✓ |
| db 0 consumer groups | 0 | **0** | 0 ✓ |
| db 0 `EXISTS telemetry:dead-letter` | 0 | **0** | absent ✓ |
| db 0 `KEYS retries:*` | none | **none** | absent ✓ |
| db 14 `DBSIZE` | 0 | **0** | 0 ✓ |
| db 9 / db 13 `DBSIZE` | 0 | 0 | — |
| `Event` / `UsageLine` | 0 / 0 | **0 / 0** | 0 / 0 ✓ |

db 0 `DBSIZE` moved 1 → 2: one `denylist:d97e8204a43baa3fcdbee2878e4821a0` written by
auth-service's suite during `pnpm test --force`, `TTL` 385 s at the time of the final check. That
is **S-22**, pre-existing and out of scope; it expires on its own. `telemetry:events`, its
`entries-added`, its `last-generated-id` and its (empty) group list were never touched. Postgres
and Redis were left running throughout, as instructed.

**Tree restored, proven byte-identical.** `md5sum -c` over all 26 changed/untracked paths: 0
mismatches. `git diff | sha256sum` →
`416eff1010b37d5ee0e05912c7b4d7028a922c4762e69007f79671e20a347b26`, identical to the snapshot
taken before the first mutation. `git status --porcelain` unchanged at 26 entries. Nothing staged,
nothing committed.

---

## 12. Release-readiness call

**FAIL**, on F-1 alone.

Everything that determines whether this code is safe to run is verified: the gates, the ten
acceptance criteria, the ordering guarantee, the pre-check, the db-14 containment on a developer
machine and on CI, both halves of the retired S-31, and the absence of any cross-package impact.
The code is release-ready. I would ship it.

What is not ready is `.claude/rules/known-gaps.md`. F-1 is a false claim in a file the project
designates authoritative and instructs agents to trust without re-verification, and
`review-standards.md` gives that class exactly one severity: HIGH. It is also, specifically, a
false *count with a wrong attribution* inside the entry filed to stop false counts — which is the
one place the repo cannot afford it, because the entry's whole argument is that its evidence was
each re-measured.

The correction is three lines of Markdown, no code, no gate re-run beyond re-reading the file.

**Recommended for `.claude/rules/known-gaps.md`** (out of scope here, as new entries): F-3's
untested NaN branch and F-4's untested `XADD` failure are small enough to fold into T-041's own
rework rather than filed. F-5 is already covered by S-33 row 4's description and needs no new id.

---

## 13. Decision for the user

**How should F-1 be fixed, given that S-33's own subject is the defect F-1 is an instance of?**

| Option | What changes | Diff? |
|---|---|---|
| **A · Correct row 1 in place** | Row 1 becomes `7 → 11, refuted by T-041's own diff`. Rows 1 and 2 stay separate; the header's "each verified by re-running the stated command" stays as written, still false for rows 5–7. | Yes — one line |
| **B · Correct row 1 and weaken the header** (recommended) | A, plus the header changes to "each re-derived; four of the seven state a command that can be re-run, three are prose or pre-commit". F-2's S-32 sentence corrected in the same pass. | Yes — three lines |
| **C · Merge rows 1 and 2 and re-derive every row by command before writing** | B, plus rows 1 and 2 collapse into `7 → 11 → 12, all within T-041`, and the instance count drops from seven to six. This is the habit S-33's own fix direction asks for, applied to S-33. | Yes — ~six lines, one row removed |
| **D · Accept F-1 and pass** | S-33 ships with a row that misnames the change it blames and the number it cites, inside the entry arguing that such rows must be re-measured. | No |

**Recommendation: C.** It costs the same Gate-3 round as B and is the only option that leaves the
entry able to survive the standard it sets. B is the minimum I would sign off. A leaves two of the
three false statements standing. D is the only option that keeps a HIGH finding in an
authoritative file, and it is the one thing `.claude/rules/` is least able to afford.

**A, B and C all change the diff** (`.claude/rules/known-gaps.md` only — no code, no tests, no
gate re-run). **D changes nothing.** F-3 and F-4 are independent of this choice and can be taken
or declined separately; neither blocks.

---

*Gate 5 complete. FAIL loops back to Gate 3. No code was changed; the working tree is byte-identical to the revision tested.*
