# Senior Reviewer — Gate 4 (pre-QA) — T-038 Consumer Group Bootstrap

**Base**: `45679c6` · nothing committed · working tree byte-identical before and after this review
(`sha256sum -c` on the three files I mutated for experiments; `git status --porcelain` unchanged).

**Verdict: CONDITIONAL** — 1 HIGH, 2 MEDIUM. No BLOCKER. The shipped code path is correct and I
could not break it; every required fix is to a **claim** the change adds, plus one unguarded
`flushdb()` in the new integration harness.

---

## Findings

### HIGH

**H1 · The "cannot silently flush the wrong database" guard is only half a guard — and the claim
appears in an authoritative rules file.**

`apps/worker-service/tests/stream.consumer.integration.test.ts:131-136`
> `// Guard, not decoration: if the URL override ever failed to take, this would flush the`
> `// developer's real keyspace. Asserting the index first makes that unrepresentable rather`
> `// than merely unlikely.`

`.claude/rules/known-gaps.md` S-22 (§ "Other suites already avoid this…")
> `worker-service reserved db 14 … asserting CLIENT INFO contains db=14 *before* its first flush`
> `so a failed URL override cannot silently flush the wrong database.`

Both are false. The mutation that establishes it: make the `beforeAll` assertion fail, and observe
that the flush still happens. Vitest 2.1.9 runs `afterAll` **even when `beforeAll` throws**. I ran
this as a standalone suite on the repo's own vitest binary:

```
beforeAll:  expect("db=0").toContain("db=14")   ->  FAIL
stdout:     AFTER_ALL RAN -- would FLUSHDB here
 Test Files  1 failed (1)
      Tests  1 skipped (1)
```

So on a bad `REDIS_URL` override the sequence is: guard fires → the `beforeAll` flush at `:137` is
skipped → tests skipped → **`afterAll` at `:144-147` runs `await redis.flushdb()` against whatever
database the client actually connected to.** The guard prevents the first flush and not the last
one. `afterEach` is safe only incidentally (no test bodies run).

Second, smaller defect in the same block: if `new RedisClient(...)` at `:130` threw, `redis` is
`undefined` and `afterAll` throws `TypeError` rather than reporting the real cause.

**Fix (`apps/worker-service/tests/stream.consumer.integration.test.ts:127-147`)** — guard *every*
flush, not the first. Concretely, replace the three bare `redis.flushdb()` calls with one helper
that re-establishes the invariant each time:

```ts
const flushReservedDb = async (): Promise<void> => {
  if (!redis) {
    throw new Error("Redis client was never constructed");
  }
  expect(await redis.call("CLIENT", "INFO")).toContain(
    `db=${INTEGRATION_REDIS.LOGICAL_DB_INDEX}`
  );
  await redis.flushdb();
};
```

`beforeAll`, `afterEach` and `afterAll` all call it. `CLIENT INFO` is a local, O(1) command; three
extra round-trips per suite is not a cost worth reasoning about. Then the comment at `:131-133` and
S-22's sentence become true as written.

*Severity rationale:* the code defect alone is MEDIUM (test-only, needs a misconfigured
`REDIS_URL` to bite). It is HIGH because the same universal is asserted in
`.claude/rules/known-gaps.md`, which `CLAUDE.md` designates authoritative and instructs other
agents to trust without re-verification — and S-22's stated **fix direction** is "copy worker's
pre-flush `CLIENT INFO` assertion", i.e. it propagates the half-guard into auth-service next.

---

### MEDIUM

**M2 · `stream.consumer.ts:38-39` republishes a false claim about the producer's fallback.**

```
apps/worker-service/src/events/stream.consumer.ts:38-40
 * `WORKER_STREAM_CONSTANTS`' own doc comment already records that the producer's equivalent
 * fallback is never reached. Duplicating an unreachable branch here would add a line no test
 * can cover and a second place a default could drift.
```

The producer's fallback **is** reachable. `apps/usage-service/src/config/env.ts:21` declares
`REDIS_STREAM_NAME: z.string().default(EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM)` — **no
`.min(1)`**, unlike worker's `:41`. So `REDIS_STREAM_NAME=""` parses successfully to `""`, and
`stream.publisher.ts:35-36`'s `env.REDIS_STREAM_NAME || STREAM_CONSTANTS.DEFAULT_STREAM_NAME` takes
the right-hand arm. Measured against the two real schema shapes:

```
usage(no .min(1))  ""   -> {"REDIS_STREAM_NAME":""}      `env.X || DEFAULT` -> "FALLBACK_CONSTANT"
worker(.min(1))    ""   -> THROWS: String must contain at least 1 character(s)
```

**The decision T-038 made is still right.** Worker's own `.min(1).default(…)` on *both*
`REDIS_STREAM_NAME` (`env.ts:41`) and `REDIS_CONSUMER_GROUP` (`env.ts:42`) does make a local
fallback arm unreachable — I verified both fields, and `container.env` is typed `ServiceEnv`
(= `z.infer<…>`, i.e. `string`, not `string | undefined`), so it holds at the type level too.
Only the supporting cross-reference is wrong.

The root claim is **pre-existing** — `apps/worker-service/src/constants.ts:41-44`, landed by T-037
in `7ad9375`; `git diff 45679c6 -- apps/worker-service/src/constants.ts` shows this diff appends
only the new object and does not touch that docblock. But the new file repeats it, so it is in
scope for this gate.

**Fix (`apps/worker-service/src/events/stream.consumer.ts:38-40`)** — drop the cross-reference and
state what is actually measured:

```
 * `src/config/env.ts:41-42` declares both fields `z.string().min(1).default(...)`, so `parseEnv`
 * either throws or yields a non-empty string and a fallback arm here would be dead code.
 * (Note this is *not* true of the producer: usage-service's `REDIS_STREAM_NAME` has no `.min(1)`,
 * so `REDIS_STREAM_NAME=""` does reach `stream.publisher.ts:36`'s `||` arm.)
```

See Decision **D-B** below for how far to chase the root.

---

**M3 · The flakiness narrative in the replaced harness is not reproducible; the failure is
deterministic.**

`apps/worker-service/tests/index.graceful-shutdown.unit.test.ts:33-45`
> `with the old helper this suite failed **non-deterministically** — a different subset of cases`
> `reported buildApp called 0 times on each run … Raising the count of turns was tried first and`
> `left the same suite flaky (6 failures on one run, a different 6 on the next), which is why this`
> `waits on a condition instead of on a number.`

I restored the old two-microtask semantics against the current `src/index.ts` and ran it five
times. Result every time:

```
Tests  9 failed | 1 passed (10)
```

— the *same* nine, run after run. I then raised the turn count to 5, 10 and 20 (three runs each):
`9 failed | 1 passed` in all nine runs. That is the expected behaviour, not flakiness: a dynamic
import's first evaluation completes on a **macrotask** turn, and a chain of `await Promise.resolve()`
never yields to the macrotask queue, so no number of microtask turns can ever be enough. The one
case that passes is `loadEnvFile throws non-ENOENT`, which rejects before the first dynamic import.

**The replacement is correct and I verified it is not weakened** (see "What I verified" below); only
the write-up is wrong, and it is wrong in the direction that makes the fix look like luck rather
than reasoning.

**Fix (`apps/worker-service/tests/index.graceful-shutdown.unit.test.ts:33-45`)** — replace the
"non-deterministically / a different 6 each run" sentences with the measured mechanism:

```
 * The old helper awaited two already-resolved promises. `start()` now suspends on two dynamic
 * imports, whose first evaluation completes on a *macrotask* turn — so a chain of
 * `await Promise.resolve()` can never reach it, at any length. Measured against this revision:
 * 2, 5, 10 and 20 microtask turns all give the same deterministic `9 failed | 1 passed`.
 * Hence a condition, not a count.
```

---

### LOW

**L1 · "a mock cannot distinguish the two" is refuted by the mock.**
`docs/plans/t-038-consumer-group-bootstrap.md` §7 AC3 ("integration only — a mock cannot show
this") and §9 R5 ("it is an integration test precisely because a mock cannot distinguish the two"),
echoed at `apps/worker-service/tests/stream.consumer.integration.test.ts:22-24`.

I performed the SETID mutation (added `xgroup("SETID", stream, group, "$")` to the already-exists
branch of `stream.consumer.ts`). It reddens **I3 and U2**:

```
I3  AssertionError: expected '1789025434241-1' to be '1789025434241-0'
U2  AssertionError: expected "spy" to be called 1 times, but got 2 times
```

The implementer's Gate-3 note ("I3 alone red") is likewise off by one — in the safe direction.
I3 is still the right test and the only one that proves the *cursor* is untouched. Disposition:
correct the plan's two "a mock cannot" sentences; no code change.

**L2 · `ON DELETE RESTRICT` is not why the backlog cannot be stored.**
`apps/worker-service/.env.example:47-48`, `apps/worker-service/src/constants.ts:89-91`, plan §2 D1.
The `ON DELETE` action governs deletion of the *parent* `Tenant` row; it has nothing to do with
whether a child `Event` insert succeeds. The insert fails because the FK exists at all. The
conclusion is correct — I proved the insert fails, in a rolled-back transaction:

```
ERROR:  insert or update on table "Event" violates foreign key constraint "Event_tenantId_fkey"
DETAIL:  Key (tenantId)=(11111111-1111-4111-8111-111111111111) is not present in table "Tenant".
```

Fix: say "`Event.tenantId` has a foreign key to `Tenant(id)` and that tenant does not exist, so
T-040's insert is rejected (`foreign_key_violation`)". Drop `ON DELETE RESTRICT` from the argument
in all three places. Operator-facing copy (`.env.example`) matters most.

**L3 · `MKSTREAM` turns a mistyped `REDIS_STREAM_NAME` into a silently-created empty stream.**
`apps/worker-service/src/events/stream.consumer.ts:71`. Before T-038 the worker issued no Redis
command at startup at all; with `MKSTREAM` a typo now produces `OK`, a new empty key, a group on
it, and a healthy `/health` — exactly the "block on XREADGROUP forever and still report healthy"
failure `.env.example:32-33` warns about, now reachable without the producer ever having existed.
`MKSTREAM` is nonetheless required (a fresh environment has no stream). Disposition: accept for
T-038; recommend T-039 log a warning when it bootstraps a group on a key whose `XLEN` is 0 *and*
`entries-added` is 0. Worth carrying into T-039's plan rather than `known-gaps.md`.

**L4 · `vi.waitFor` runs on its 1000 ms default.**
`apps/worker-service/tests/index.graceful-shutdown.unit.test.ts:47-62`. Current headroom is ~12×
(809 ms for the whole 10-test file locally), but the thing being waited on is a real vite-node
dynamic import, which is the slowest thing in the file on a cold CI worker. Cheap insurance:
`vi.waitFor(fn, { timeout: 5_000, interval: 10 })`, with the timeout from a named constant.

**L5 · `redis://localhost:6379` gets another copy.**
`apps/worker-service/tests/integration.constants.ts:15` duplicates
`apps/usage-service/tests/integration.constants.ts:55`, and both duplicate their services'
`tests/setup.ts:9`. `.claude/rules/constants.md`: *"before adding a third copy of a literal,
promote it."* This is well past three. Deliberately mirrors the neighbour, so accept for T-038,
but it should be promoted to `@telemetry/shared-types` (or a test-only shared module) in a
dedicated change. Recommend a `known-gaps.md` entry if nobody owns it.

**L6 · `StreamConsumer` is constructed in `index.ts`, not the DI container.**
`apps/worker-service/src/index.ts:74`. `CLAUDE.md` says wiring lives in `app.ts` / the container
and `index.ts` stays a thin entrypoint. The plan's D2-C correctly rejected an `onReady` hook (it
would make `tests/smoke.test.ts:19`'s `app.listen({ port: 0 })` need a live Redis — I confirmed
`pnpm test:smoke` is 6/6 green, and that `ensureConsumerGroup` has exactly one production call
site, in `index.ts`), but "not `onReady`" does not imply "not in the container". Registering
`streamConsumer` in `config/container.ts` and calling
`container.streamConsumer.ensureConsumerGroup()` keeps both invariants. Disposition: defer to
T-039, which needs the object to hold loop state anyway. Not a T-038 change.

**L7 · The SIGTERM-during-bootstrap claim is reasoning, not a test.**
`apps/worker-service/src/index.ts:64-65`: *"Placed after the signal handlers so a SIGTERM arriving
during the Redis round-trip is still handled."* True by reading (handlers register at `:50-61`,
bootstrap at `:75`), and I did not construct the race. No test covers it. Optional: a case that
resolves `xgroup` only after `signalHandlers.SIGTERM?.()` has fired, asserting `exitCodes`
contains `0` and `appListen` was never called.

**L8 · Two-field object literal cast to `ServiceEnv`.**
`apps/worker-service/tests/stream.consumer.integration.test.ts:54-57` casts
`{ REDIS_STREAM_NAME, REDIS_CONSUMER_GROUP } as ServiceEnv`. Correct today because the constructor
reads exactly those two, but if `StreamConsumer` starts reading a third field in T-039 this
silently yields `undefined` at runtime with no compile error. Prefer the unit suite's
`Partial<ServiceEnv>` + a single documented cast in one helper, or narrow the constructor's
parameter to `Pick<ServiceEnv, "REDIS_STREAM_NAME" | "REDIS_CONSUMER_GROUP">` — which would also
make the dependency explicit in `src/`.

---

### NIT

- **N1** `tests/stream.consumer.unit.test.ts:23` — "removes seven casts". The neighbour
  `apps/usage-service/tests/stream.publisher.unit.test.ts` contains 11 occurrences of
  `as ReturnType<typeof vi.fn>`, one of which (line 8) is a type annotation → **10** call-site
  casts, not 7.
- **N2** `tests/integration.constants.ts:25-27` — "`apps/usage-service/tests/integration.constants.ts:64`
  reserves 15 and issues `FLUSHDB` against it". Line 64 does reserve 15; the `FLUSHDB` is issued at
  `apps/usage-service/tests/integration.fixtures.ts:204`. Cite both.
- **N3** Plan §4 correction box — "The text was corrected in `3374cf9`". It was corrected in
  **`1b872b3`** (`git log -- .claude/rules/testing.md` → `1b872b3`, `a3877ad`; `3374cf9` did not
  touch the file, it merely postdates the fix). The *substance* of the correction is right: see
  "Adjudications" below.
- **N4** `tests/integration.constants.ts:83` — `INTEGRATION_COUNTS.PAIR` is used as a field-pair
  *stride*, not a count. The neighbour names this `FIELD_PAIR_STRIDE`
  (`apps/usage-service/tests/integration.fixtures.ts:186`). Prefer that name for the stride use.

---

## Adjudications

**The planner-vs-implementer disagreement over `.claude/rules/testing.md` (plan §4).** The
implementer is right and the withdrawal was correct. `.claude/rules/testing.md:24-38` at `45679c6`
reads *"and they run inside `pnpm test`"* and *"Do not describe these suites as excluded or
opt-in."* The planner's §4 attributed the opposite text to it. Only the commit attribution in the
correction box is wrong (N3). No gap should be filed.

> Environment note for whoever reads this next: the `.claude/rules/*` and `known-gaps.md` contents
> injected into *my* session context were a **stale snapshot** (pre-`1b872b3` `testing.md`, a
> `known-gaps.md` ending at S-10, a `review-standards.md` without the universals gate). Every
> statement in this review is from the files on disk at `45679c6`, read with `cat`. If another
> agent cites the injected copy, it may be citing the wrong revision.

**Decisions D1-D4 were honoured.**

| Decision | Honoured | Evidence |
|---|---|---|
| D1 `$` | yes | `constants.ts:96` `START_ID_NEW_ENTRIES_ONLY: "$"`, passed as arg 4 at `stream.consumer.ts:70`; pinned by I5 `:229` and asserted by absence of the backlog id at `:225` |
| D2 wire it in `start()` before `listen` | yes | `index.ts:74-78`; ordering proved red by mutation (below), not by two independent call checks |
| D3 fail closed | yes | `stream.consumer.ts:108` rethrows; `index.ts:81-84` exits 1; U8 asserts `appListen` never called |
| D4 `startsWith` | yes | `stream.consumer.ts:89`; U5 asserts its own premise before asserting behaviour |

No scope creep. `env.ts`, `container.ts`, `app.ts`, `internal-auth.middleware.ts` (S-8),
`base.repository.ts` (S-19) and `vitest.config.mjs` are all untouched, as the plan promised.

---

## What I verified, by running it

**Mutation 1 — ordering (re-performed).** Moved `await streamConsumer.ensureConsumerGroup()` in
`src/index.ts` to after `await app.listen(...)`:

```
× U7 - bootstraps the consumer group before the HTTP listener binds
  → expected 82 to be less than 81
× U8 - fails closed and never binds the listener when Redis is unreachable
  → expected "spy" to not be called at all, but actually been called 1 times
Tests  2 failed | 8 passed (10)
```

Exactly the reported message, to the digit. Reverted; hash restored.

**Mutation 2 — SETID (re-performed).** See L1. I3 red as reported; U2 also red.

**Mutation 3 — is the new harness vacuous?** The negative cases assert
`expect(buildApp).not.toHaveBeenCalled()`. I moved `loadLocalEnv()` in `start()` to *after*
`buildWorkerServiceApp()` so `buildApp` **is** called on that path:

```
× fails startup when loadEnvFile throws non-ENOENT
  → expected "spy" to not be called at all, but actually been called 1 times
Tests  1 failed | 9 passed (10)
```

The negative assertion is live, not short-circuited. (A first attempt that moved `loadLocalEnv()`
only past the `import("./app")` line left all 10 green — correctly, since `buildApp` still was not
called. Recording the false start so the result is not over-read.)

**Stability.** `tests/index.graceful-shutdown.unit.test.ts` run **15** consecutive times:
`10 passed (10)` every run, 0 failures. (The implementer claimed five; fifteen agrees.)

**Redis semantics — re-derived independently, not read from Appendix A.** One script, ioredis
5.11.1 against host Redis 7.0.15, logical db 12 (flushed before and after):

| Claim, and where it is asserted | Result |
|---|---|
| `constants.ts:83-86` no `MKSTREAM` → `ERR …requires the key to exist`, `EXISTS`→0 | reproduced |
| `constants.ts:86-87` with `MKSTREAM` → `OK`, `EXISTS` 1 / `TYPE` stream / `XLEN` 0 | reproduced |
| `constants.ts:95` `$` on a `MKSTREAM`-created key → `last-delivered-id 0-0` | reproduced |
| `constants.ts:92-94` `$` skips a 2-entry backlog (`XREADGROUP >` → nil), `0` replays both | reproduced |
| `stream.consumer.ts:49-51` repeat `CREATE` leaves cursor+pending; `SETID` moves the cursor | reproduced (`…884-0` → `…884-1`) |
| `stream.consumer.ts:51-52` 8 concurrent `CREATE`s → 1 `OK`, 7 `BUSYGROUP`, exactly 1 group | reproduced exactly |
| `stream.consumer.ts:54-56` `DEL` removes the group (`XINFO GROUPS` → `ERR no such key`) | reproduced |
| `stream.consumer.ts:84-85` ioredis `ReplyError`, `code === undefined`, `instanceof Error` | reproduced |
| plan P13 `XTRIM MAXLEN 0` leaves the group intact | reproduced |
| `.env.example:52` `XGROUP DESTROY` undoes a bootstrap | reproduced |
| `.env.example:33-34` / `index.ts:71-73` unreachable Redis → `MaxRetriesPerRequestError` in ~160 ms | reproduced: 159/154/155 ms, message byte-identical to the test constant at `:19-21` |
| `container.ts:22-26` `lazyConnect` needs no explicit `connect()` | reproduced (`wait` → `connecting` → `ready`) |

**The D4 universal, attacked rather than accepted.** `constants.ts:112-121` claims that across
`XGROUP CREATE` error replies `startsWith("BUSYGROUP")` and `includes("BUSYGROUP")` never disagree,
and cites `CREATECONSUMER` as the falsifying case from a *different* subcommand. I tried to falsify
the `CREATE` half with seven shapes the plan did not run — including a key literally **named**
`BUSYGROUP`, a group literally named `BUSYGROUP`, a `WRONGTYPE` on a `BUSYGROUP`-named key, and a
bad `ENTRIESREAD`:

```
C1 CREATE on string key            "WRONGTYPE …"                              startsWith=false includes=false
C2 CREATE bad id, group=BUSYGROUP  "ERR Invalid stream ID …"                  startsWith=false includes=false
C3 CREATE missing key, grp=BUSY…   "ERR …requires the key to exist. …"        startsWith=false includes=false
C4 CREATE key named BUSYGROUP      "ERR …requires the key to exist. …"        startsWith=false includes=false
C5 CREATE string key BUSYGROUP     "WRONGTYPE …"                              startsWith=false includes=false
C7 CREATE ENTRIESREAD zz           "ERR value is not an integer …"            startsWith=false includes=false
C8 duplicate, group named BUSYGROUP "BUSYGROUP Consumer Group name already exists"  startsWith=TRUE includes=TRUE
C6 CREATECONSUMER … BUSYGROUP c1   "NOGROUP … 'BUSYGROUP' for key 'probe:b'"  startsWith=false includes=TRUE
```

**The claim survives, and it is scoped honestly** ("no `XGROUP CREATE` reply is known *here* to
make them disagree", plus a named falsifying case from another subcommand). This is the shape
`.claude/rules/review-standards.md:42-73` asks for. Noted as the one universal in this diff that I
tried hardest to break and could not.

**S-22, every factual claim.**

| Claim | Verified |
|---|---|
| `auth.integration.test.ts:34` hard-codes `REDIS_URL: "redis://localhost:6379"` | yes — that exact line |
| No logical database is selected anywhere in auth-service | yes — grep across `apps/auth-service`: no `/N` path on any Redis URL (`.env.example:30`, `src/config/container.ts:22`, `tests/setup.ts:13`, `tests/token.service.unit.test.ts:10`, `tests/env.schema.unit.test.ts:10`, `tests/auth.integration.test.ts:34`), no `db:` client option, no `.select(` |
| `token-denylist.service.ts:40` writes `denylist:<jti>` | yes — line 40 exactly |
| Running that one suite raises db 0's `DBSIZE` by one | yes — 4 → 5, one new `denylist:*` key, suite 17/17 green |
| The keys carry a TTL and self-expire | yes — `redis-cli TTL` → 314 s / 533 s; `INFO keyspace` shows `expires=` matching |
| No auth-service suite issues `FLUSHDB` | yes — grep for `flushdb`/`flushall` across `apps/auth-service` returns nothing |
| usage-service reserves db 15 and flushes only that | yes (see N2 for the line cite) |
| worker's `CLIENT INFO` guard "cannot silently flush the wrong database" | **NO — see H1** |

S-22's absolute numbers ("2 to 3") differ from mine ("4 to 5") because the denylist keys expire;
the +1 delta is what matters and it reproduces. Severity **LOW** is right — nothing is destroyed
today.

**db 0 final state, as requested.**

```
XLEN telemetry:events        -> 2
XRANGE ids                   -> 1787746970722-0, 1788171536033-0
XINFO GROUPS telemetry:events-> (empty)
```

Unchanged. `DBSIZE` is 5 rather than 3 **because of me**: reproducing S-22 required running
`auth.integration.test.ts` once, which added one TTL'd `denylist:*` key. All four extras expire
within ~15 minutes; no key I created is permanent, and the stream is byte-for-byte as I received
it. Reserved test databases 12/13/14/15 all end at `DBSIZE 0`.

**Clean-code gate.** No magic strings or numbers in the new production code — the five Redis
literals the epic spells inline (`"CREATE"`, `"MKSTREAM"`, `"$"`, `"BUSYGROUP"`, plus the two env
reads) all resolve through constants. Tests import from `src/constants.ts` rather than re-typing,
per `.claude/rules/constants.md`'s "applies to tests" clause; the *deliberately* literal strings
(`BUSYGROUP_REPLY`, `WRONGTYPE_REPLY`, `NOGROUP_REPLY_NAMING_BUSYGROUP` at
`stream.consumer.unit.test.ts:34-45`) are correct to be literal — importing them from the constant
they are meant to test would make the assertions tautological, and the file says so.

**On the `WORKER_CONSUMER_GROUP_BOOTSTRAP` sibling (check #4).** Judged against
`.claude/rules/constants.md`: **no finding.** The rule requires constants to live in `constants.ts`
or a service-local constants module; both objects do. It requires no duplication across
`constants.ts` / validator / repository; there is none. It says nothing about one object versus
two. The stated reason — `WORKER_STREAM_CONSTANTS`' members are each a `.default(…)` in
`env.ts:41-54` and operator-overridable, while these are protocol tokens and a policy choice that
no env var may set — is true of every member of both objects, which I checked one by one. It also
happens to be the shape that keeps `env.ts`'s import surface honest. (For the record the new object
has **four** members, not five; the brief's "five" matches the plan's count of *inline literals in
the epic snippet*, which included the two env reads.)

**Compile-time gate, `--force`, all 13 packages.**

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | **13 successful / 13**, 0 cached, 10.3 s, 0 errors |
| lint | `pnpm lint --force` | **13 successful / 13**, 0 cached, 27.6 s, **0 errors, 14 warnings** |
| build | `npx turbo run build --force` | **13 successful / 13**, 0 cached, 18.0 s |
| test | `pnpm test --force` | **13 successful / 13**, 0 cached |

Per-package tests: analytics 4/18 · auth 15/164 · billing 4/18 · gateway 8/38 · shared-config 1/4 ·
shared-logger 1/4 · shared-tracing 1/2 · shared-types 1/8 · shared-utils 1/18 · shared-validation
1/15 · usage 19/230 · web `--passWithNoTests` · **worker 7 files / 62 tests**. Matches the expected
worker 7/62 (baseline 5/49) and usage 19/230 unchanged. `pnpm test:smoke` — 6/6 suites green.

`pnpm build -- --force` does not forward the flag (confirmed: `13 cached … FULL TURBO` in 73 ms);
`npx turbo run build --force` does.

**Lint warnings — 14, not 10, and all pre-existing. Proved:**

| File | Warnings | `git log -1` | In this diff? |
|---|---|---|---|
| `apps/auth-service/tests/auth.service.unit.test.ts` | 10 `no-misused-promises` | `d68e719` (2026-08-25) | no |
| `apps/usage-service/tests/ingestion.service.unit.test.ts` | 4 `no-unsafe-assignment` | `b0f6921` (2026-08-31) | no |

`git status --porcelain` lists neither. The brief's "10, all in `auth.service.unit.test.ts`"
understates the baseline by the 4 usage-service ones; both sets are pre-existing and **neither is
counted against this change**. `pnpm --filter @telemetry/worker-service lint` is silent — the
change introduces zero warnings.

**`format:check` 265 → 270 — spot-checked, not accepted.** I extracted the `HEAD` versions of the
four modified prettier-visible files into a scratch tree with the repo's `.prettierrc`/
`.prettierignore` and ran prettier against them:

```
[warn] apps/worker-service/src/constants.ts
[warn] apps/worker-service/src/index.ts
[warn] apps/worker-service/tests/index.graceful-shutdown.unit.test.ts
[warn] .claude/rules/known-gaps.md
```

All four already failed at `HEAD`, so they contribute 0 to the delta. The +5 is exactly the five
new prettier-visible files (`stream.consumer.ts`, `stream.consumer.unit.test.ts`,
`stream.consumer.integration.test.ts`, `integration.constants.ts`, the plan `.md`).
`.env.example` has no parser and is not counted. Consistent with **S-12**; not scored against this
change.

**Test honesty.** No tautologies, no vacuous helpers, no short-circuits found:
- `xgroupArgs()` (`unit:69-76`) and `readOnlyGroup()` (`integration:92-101`) both **throw** when
  the thing they look for is absent — the S-3 shape, correctly applied.
- U5 (`unit:139-144`) asserts its **own premise** (`includes` true *and* `startsWith` false) before
  asserting behaviour, so it cannot pass while testing nothing. This is the best test in the diff.
- I5 (`integration:225`) leads with the **negative** assertion (`not.toContain(backlogId)`), then
  `toEqual([freshId])`, then pins the constant. A group created at `0` fails all three.
- U6 asserts the defaults are **absent** from the argument vector, so a hard-coded literal cannot
  pass.
- `readNewEntryIds` returning `[]` on a nil reply is not a silent pass: both call sites assert a
  non-empty result.
- No test asserts a mock's own return value.

Untested surface, all minor: the info-log *fields* (`startId`, stream/group) are never asserted,
only that `logger.info` was called (U2); no case for a message that is exactly `"BUSYGROUP"`; no
SIGTERM-during-bootstrap case (L7). None of these are error paths left uncovered — U3 and U4 cover
both rethrow branches, including the non-`Error` rejection.

**Tenant isolation / injection.** Not applicable and not weakened. T-038 issues no SQL, touches no
repository, and builds no tenant-keyed Redis key; the stream and group names come from operator
config (`env.REDIS_STREAM_NAME`, `env.REDIS_CONSUMER_GROUP`), never from a request. Every argument
to `xgroup` is a separate ioredis argument, not concatenated text. `Event`'s RLS is untouched
(`relrowsecurity = t`, `relforcerowsecurity = t`, policy `event_tenant_isolation` intact —
re-read from `\d "Event"`).

---

## What I could NOT verify, and why

1. **The worker actually failing to start against a down Redis, end to end.** I verified the
   fail-closed *path* (U8 with a rejecting stub) and the *rejection* (`MaxRetriesPerRequestError`
   in ~155 ms with the container's exact options), but I did not stop the developer's Redis to run
   `pnpm --filter @telemetry/worker-service dev` — that would have taken down the database other
   suites in this session needed. Composition of the two is reasoning, not execution.
2. **That `pnpm test:smoke` still passes with Redis down.** Redis was up throughout. The claim
   rests on reading: `ensureConsumerGroup` has exactly one production call site
   (`src/index.ts:75`), and `tests/smoke.test.ts` imports `buildWorkerServiceApp` from `src/app.ts`,
   which never loads `index.ts`. D2-C's rejection is sound, but "smoke needs no Redis" is
   grep-verified, not executed.
3. **CI behaviour.** `.github/workflows/ci.yml:55-58` publishes `redis:7-alpine` on 6379 and
   `apps/worker-service/tests/setup.ts:9` hard-codes the URL past turbo's strict env mode, so db 14
   will exist and be empty. Read, not run.
4. **Anything outside Redis 7.0.15 standalone / ioredis 5.11.1.** Cluster mode, Redis 6.x, and
   managed providers that restrict `XGROUP` or expose fewer than 16 logical databases are all
   unverified — and a provider with a single database would make the db-14 reservation (and
   usage-service's db-15 one) silently collide with production keys. Same scope limit the plan
   states.
5. **The concurrency hazard behind reserving db 14 over db 15.** `turbo.json` sets no
   `--concurrency` (confirmed), so the two packages' test tasks *can* overlap, but I did not force
   an overlap to observe a collision. The plan says the same. Reserving 14 is cheap either way.

---

## Decisions for you

These are shaped as choices because the orchestrator will prompt with them.

### D-A · How to close H1 (the unguarded `afterAll` flush)?

**Question:** the pre-flush `db=14` guard protects the first flush but not `afterAll`'s. Fix it
here, or record it?

| Option | What changes |
|---|---|
| **A · Guard every flush** *(recommended)* | ~8 lines in `stream.consumer.integration.test.ts:127-147`, plus one sentence each in that file's comment and in S-22. Diff changes. |
| B · Keep one guard, weaken both claims to what is true | 2 comment edits, no code. Diff changes (prose only). Residual: a bad override still flushes the wrong db once, at teardown. |
| C · File it as a new gap and ship as-is | `known-gaps.md` gains an item. Diff changes (prose only). Leaves a false universal in an authoritative file until someone picks it up — the thing `.claude/rules/review-standards.md:42-73` exists to prevent. |

**Recommend A.** The fix is smaller than the paragraph describing it, and S-22 tells the *next*
implementer to copy this pattern into auth-service — so the half-guard propagates if it is not
fixed now. B is defensible if you want T-038's diff frozen; C is not, because it leaves
`.claude/rules/` asserting something false.

### D-B · How far to chase M2 (the producer-fallback claim)?

**Question:** the new comment repeats a false claim whose root is T-037's `constants.ts:43`, and
the underlying asymmetry is that usage-service's `REDIS_STREAM_NAME` has no `.min(1)`.

| Option | What changes |
|---|---|
| **A · Fix the new comment only** *(recommended)* | `stream.consumer.ts:38-40`. Diff changes. Leaves `constants.ts:43` false — but it is pre-existing and provably not this task's. |
| B · Fix both comments | A, plus `constants.ts:41-44`. Diff changes. Touches a T-037 docblock inside a T-038 commit. |
| C · A + add `.min(1)` to `apps/usage-service/src/config/env.ts:21` | Changes another service's startup contract inside a worker-service task — the exact reason S-8 was not folded into S-4. Diff changes materially; needs its own tests. |

**Recommend A, plus a `known-gaps.md` entry for the usage-service `.min(1)` asymmetry** so it does
not evaporate: today `REDIS_STREAM_NAME=""` makes the producer publish to `telemetry:events` while
the consumer refuses to start. Both fail safely, but they fail *differently* on the same value,
which is the divergence `.env.example:38-42` warns about.

---

## Recommended `known-gaps.md` additions (out of scope to fix here)

1. **usage-service's `REDIS_STREAM_NAME` accepts the empty string** while worker's does not
   (`apps/usage-service/src/config/env.ts:21` vs `apps/worker-service/src/config/env.ts:41`) —
   producer and consumer resolve the same env value differently. LOW. See D-B.
2. **`redis://localhost:6379` is now duplicated across at least five files** and should be promoted
   to a shared constant before a sixth (L5). LOW.
3. **The per-suite logical-database convention (db 14, db 15, and db 0 by omission) is enforced by
   nothing** and breaks entirely on a managed Redis with one database. S-22 already says this in
   its last sentence; consider promoting it to its own item so it is findable when someone moves CI
   to a hosted Redis. LOW.

---

## On the two-reader plan structure (you asked)

**It helped, materially, in two specific ways.** Part 1's decision tables — each with a
"what changes per answer" row — let me check *honoured vs. not* in about ten minutes instead of
reverse-engineering intent from the diff; that table is now the "Adjudications" section above
almost verbatim. And Appendix A gave me exact commands rather than conclusions, which is the only
reason I could re-derive twelve Redis claims in one script instead of inventing my own probes and
arguing about whether they were equivalent. §8's recorded baselines (5 files/49 tests, 265 format
warnings) turned the delta arithmetic into something checkable rather than assertable — I did not
have to trust "no regression", I could subtract.

The Gate-3 correction box in §4 is the best thing in the document. It made a planner/implementer
disagreement auditable, and I settled it with two commands. Keep it. Make it cite the commit it
verified against, and re-run the verification when writing it (N3).

**Where it hindered.** 914 lines, and the D1 rationale is written out four times — plan §2 D1,
plan §4's ground-truth table, `constants.ts:88-91`, and `.env.example:45-49`. That is the
structural cost of writing for two audiences: a single wrong premise propagates to every copy, and
L2 is exactly that — `ON DELETE RESTRICT` is wrong in all four places, so the fix is four edits
instead of one. Suggestion: let Part 1 make the *decision* and **link** to Part 2 / the appendix
for the evidence, rather than restating it in analyst prose and again in engineer prose. One
canonical statement of each premise, cited from everywhere else.

**Diagrams: checked, and they pass.** Every arrow in the `sequenceDiagram` and the `flowchart`
carries either a `file:line` or a probe id, dashed arrows are labelled *proposed*, and the two
citations I spot-checked are right (`stream.publisher.ts:70` is the `xadd`; `app.ts:17` is
`buildWorkerServiceApp`; `index.ts:24`/`:60` were `start()`/`app.listen` at the base revision).
This is what `.claude/rules/review-standards.md:65-68` asks for and it is the first plan I have
reviewed that does it.

---

**Verdict: CONDITIONAL.** Required before commit: **H1** (D-A), **M2** (D-B), **M3**. Recommended:
L1, L2, N1-N4. L3-L8 are dispositions to accept or defer, not blockers. Re-review needed only on
the changed lines — the gate is green at 13/13 and the mutation evidence above holds for the code
path, which is unaffected by any required fix.
