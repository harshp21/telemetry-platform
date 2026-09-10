# Senior Reviewer — Gate 4 **re-review** — T-038 Consumer Group Bootstrap

**Base**: `45679c6` · nothing committed · first-pass record: `docs/reviews/t-038-consumer-group-bootstrap.md`
(not overwritten).

**Scope**: the lines the Gate-3 rework changed. The code path itself was mutation-tested in the
first pass and is unaffected by any of the applied fixes — re-verified below where the rework
touched a claim about it.

**Working tree unchanged by this review.** I mutated three files for experiments
(`tests/stream.consumer.integration.test.ts`, `tests/index.graceful-shutdown.unit.test.ts`,
`src/events/stream.consumer.ts`) and restored each; `sha256sum -c` OK on all three, and
`git diff --stat` / `git status --porcelain` are identical to session start
(5 files, 323 insertions, 15 deletions; 6 untracked).

**Verdict: APPROVED FOR COMMIT** — all three required fixes (H1, M2, M3) verified by my own
execution, not by reading the rework's account of itself. 0 BLOCKER, 0 HIGH, 0 MEDIUM.
5 LOW / 3 NIT below, none blocking. One decision for the user at the end (it changes only
`.claude/rules/known-gaps.md`).

---

## Required fixes — verified by re-execution

### H1 · closed, and the narrowed claim is true as written

`apps/worker-service/tests/stream.consumer.integration.test.ts:164-172` — `flushReservedDb()`.
`grep -n "flushdb"` on that file returns **exactly one** call site (`:171`, inside the helper);
the three former flush points (`:178` `beforeAll`, `:182` `afterEach`, `:189` `afterAll`) all
route through it. So the docblock's "the only place this suite issues `FLUSHDB`" is true by
count, not by intent.

I ran both halves of the mutation the docblock and S-22 cite, on the committed tree and on a
degraded copy of it, with a sentinel key seeded into db 14 each time:

| Shape | Guard mutated to a string `CLIENT INFO` cannot contain | Result |
|---|---|---|
| **Committed** (every flush guarded) | yes | `Test Files 1 failed (1)` / `Tests 5 skipped (5)`, `redis-cli -n 14 DBSIZE` **1 → 1** |
| **Degraded** (guard in `beforeAll` only; bare `redis.flushdb()` in `afterEach`/`afterAll`) | yes | same output, `DBSIZE` **1 → 0** |

Byte-identical to the reported figures, including `Tests 5 skipped (5)`. The
`afterAll`-runs-when-`beforeAll`-throws hole is closed.

The `!redis` branch is **not** dead code, as the docblock claims. Mutation: `throw` immediately
before `redis = new RedisClient(...)`. Observed both errors reported, the helper's first:

```
Error: REVIEWER: simulated RedisClient constructor failure
Error: Redis client was never constructed; refusing to FLUSHDB
 Test Files  1 failed (1) / Tests  5 skipped (5)
```

Without the branch this is a `TypeError`, exactly as stated.

The scope qualifier — "a single chokepoint, not an impossibility proof" — is the honest form and
I confirmed it *mechanically* rather than accepting it: I reintroduced a bare
`await redis.flushdb()` in `afterEach` and ran `turbo run typecheck lint --filter
@telemetry/worker-service --force` → **14 successful, 0 errors, 0 warnings**. Nothing in the type
system or the lint config rejects a future bare flush. The claim is weakened to what is true.

### H1 prose · `.claude/rules/known-gaps.md` S-22 — corrected paragraph verified

Every measured figure in the corrected paragraph reproduces: vitest **2.1.9** (`npx vitest
--version`), `Test Files 1 failed (1) / Tests 5 skipped (5)`, `DBSIZE 1 -> 0` with the mutation
against the half-guard shape and **staying 1** against the every-flush shape. The fix direction
now prescribes the guarded-every-flush shape and explicitly warns against the
one-guard-in-`beforeAll` shape, which is what the first pass asked for. The closing scope
sentence ("chokepoint, not an impossibility") is honest — see the typecheck/lint probe above.

Supporting cites re-checked: `apps/usage-service/tests/integration.constants.ts:64` is
`LOGICAL_DB_INDEX: 15`; `apps/usage-service/tests/integration.fixtures.ts:204` is
`await this.client.flushdb()`. Both correct (this was N2, also fixed).

*Incidental live confirmation of S-22 itself:* after my own full `turbo run test --force`, db 0
holds `telemetry:events` **plus** `denylist:70cfaf339adbcf2cb2f47b9c8f7624f5` with `TTL 429`.
The gate demonstrated the gap while I was measuring it. `XLEN telemetry:events` → 2,
`XINFO GROUPS` → empty, unchanged.

### M2 · `stream.consumer.ts:32-57` — all three measurements re-derived independently

I did not trust the table. I bundled `apps/worker-service/src/config/env.ts` with the repo's own
esbuild and imported usage-service's compiled `dist/src/config/env.js`, then called
`EnvSchema.shape.<field>.safeParse(...)` directly (zod **3.25.76**, confirmed at
`node_modules/.pnpm/zod@3.25.76`):

```
usage  REDIS_STREAM_NAME    ""        -> OK   data=""
usage  REDIS_STREAM_NAME    undefined -> OK   data="telemetry:events"
worker REDIS_STREAM_NAME    ""        -> FAIL String must contain at least 1 character(s)
worker REDIS_STREAM_NAME    undefined -> OK   data="telemetry:events"
worker REDIS_CONSUMER_GROUP ""        -> FAIL String must contain at least 1 character(s)
worker REDIS_CONSUMER_GROUP undefined -> OK   data="worker-group"
```

The three rows the comment states match to the message text. Line cites check out:
`apps/usage-service/src/config/env.ts:21` is the `REDIS_STREAM_NAME` declaration with no
`.min(1)`; `apps/worker-service/src/config/env.ts:41-42` are the two `.min(1).default(...)`
fields; `apps/usage-service/src/events/stream.publisher.ts:36` is the `||` arm;
`apps/worker-service/src/index.ts:74` is the `new StreamConsumer(..., container.env)` call.

The comment's own scope sentence — "on the production path … a unit test constructs `ServiceEnv`
by cast, so a test could pass `""`" — is correct and is the right qualification.

I also probed the one variation neither the rework nor S-23 states: `"  "` parses **OK on both
sides** (`data="  "`), so a padded override does not diverge. That is what
`apps/worker-service/src/config/env.ts:36-40`'s deliberate non-`.trim()` comment claims, and it
holds.

### M2 spillover · S-23 — verified claim by claim

| S-23 claim | How I checked | Result |
|---|---|---|
| the three schema declarations, verbatim | `sed -n` on both files | exact, at the cited lines |
| `safeParse("")` outcomes | the six probes above | exact |
| `undefined` yields the shared default | same probes | see LOW-3 for a wording snag |
| worker "refuses to start" | imported the bundled module with `REDIS_STREAM_NAME=""` | `Invalid environment configuration for REDIS_STREAM_NAME: String must contain at least 1 character(s)` — throws at module load, so the process cannot come up |
| producer publishes to `telemetry:events` | `stream.publisher.ts:36` `||` arm + `""` parse | holds by construction; not executed against a live producer |
| `constants.ts:41-44` still carries the "never reaches" claim | `sed -n '38,50p'` | true; lines 41-44 are exactly that claim |
| "fail safely but differently" | reasoning over the two measured outcomes | accepted: one side crashes at load, the other writes to the right stream. Nothing writes to a wrong stream. Labelled as reasoning, not execution |
| severity LOW | — | agree |

**Deliberate non-changes confirmed.** `git diff --name-only` lists nothing under
`apps/usage-service`. `apps/worker-service/src/constants.ts`'s diff hunk header is
`@@ -65,3 +65,75 @@` — a pure append, so T-037's docblock at `:41-44` is untouched, and
`git log -1 -- apps/worker-service/src/constants.ts` is `7ad9375` (T-037). Both non-changes hold.

### M3 · determinism claim established

I restored the old fixed-microtask semantics (both wait helpers replaced with N
`await Promise.resolve()`) and ran the file at four turn counts:

```
2 turns  -> Tests 9 failed | 1 passed (10)   x6 runs
5 turns  -> Tests 9 failed | 1 passed (10)   x2 runs
10 turns -> Tests 9 failed | 1 passed (10)   x2 runs
20 turns -> Tests 9 failed | 1 passed (10)   x2 runs
```

12 runs, never anything but `9 failed | 1 passed`. The identity of the nine, with timings
stripped, is **md5-identical across all six runs at 5/10/20 turns**. The one case that passes is
`fails startup when loadEnvFile throws non-ENOENT` — confirmed by its absence from every failure
list, exactly as the comment says. So "deterministic, the same nine, no number of microtask turns
suffices" is established. I ran 12 of the stated 20 runs; the mechanism is settled, the exact
count of 20 is the implementer's figure and I did not reproduce all of it.

The retained note that the earlier revision was wrong is the right thing to keep.

**Non-vacuity mutation re-performed.** Moved `loadLocalEnv()` in `src/index.ts` after
`buildWorkerServiceApp()` in the first pass; the rework's comment records the same result, and
the negative assertions remain live. On the committed tree the file is `10 passed (10)` in 804 ms.

### L1, L2, L3, N1-N4

**L1 — both mutation shapes measured, and both reproduce exactly.** I performed each against the
committed tree:

```
shape 1: xgroup("SETID", …) added to the already-exists branch
  U2 × expected "spy" to be called 1 times, but got 2 times
  I3 × expected '1789030217062-1' to be '1789030217062-0'
  (unit 1 failed | 5 passed · integration 1 failed | 4 passed)

shape 2: CREATE … MKSTREAM replaced with SETID
  U1 × issues XGROUP CREATE <stream> <group> $ MKSTREAM and resolves
  I1 I2 I3 I4 I5 all ×
  (unit 1 failed | 5 passed · integration 5 failed (5))
```

The corrected header at `:29-41`, plan §7 AC3 (`:416`) and §9 R5 (`:559`) all now match what the
mutations do. One surviving copy — see LOW-1.

**L2 — count and new proof both verified.** `grep -rn "ON DELETE RESTRICT"` across
`apps/worker-service` and the two docs now returns only *negations* of the claim
(`src/constants.ts:112` "The FK's *existence* is the reason, not its `ON DELETE RESTRICT`
action") plus the verbatim DDL in Appendix A. The four places are corrected: plan §2 D1
(`:86-93`), `src/constants.ts:105-118`, `.env.example:44-48`, and plan §4 no longer restates the
premise at all. Both proofs re-derived against the live database:

```
-- three temp children of one temp parent, differing only in ON DELETE action
ERROR: … violates foreign key constraint "probe_child_cascade_pid_fkey"
ERROR: … violates foreign key constraint "probe_child_setnull_pid_fkey"
ERROR: … violates foreign key constraint "probe_child_noaction_pid_fkey"

-- the real insert, rolled back
ERROR:  insert or update on table "Event" violates foreign key constraint "Event_tenantId_fkey"
DETAIL:  Key (tenantId)=(11111111-1111-4111-8111-111111111111) is not present in table "Tenant".
```

Constraint names identical to the plan's transcript. Supporting facts also re-checked:
`pg_get_constraintdef` → `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON
DELETE RESTRICT`; `Tenant` holds 2 rows, **0** with that id; `Event` holds 0 rows and still does
(rolled back).

**L3 — added where an operator reads it.** `.env.example:47-57` now carries the MKSTREAM-hides-a-
typo warning with the concrete check (`XLEN` / `XINFO GROUPS` rather than trusting startup).
Accepted as the L3 disposition; the T-039 log-a-warning recommendation still stands and belongs in
T-039's plan.

**N1 — "ten, counted" is right, to the line.** `grep -o` on
`apps/usage-service/tests/stream.publisher.unit.test.ts`: **13** occurrences of
`ReturnType<typeof vi.fn>`; lines 8-9 are the two type annotations; the remaining 11 are call-site
casts; **10** of those are `(mockRedis.xadd as …)` and the 11th is `(mockLogger.info as …)` at
line **149**. Every number and line number in the corrected comment is correct.

**N2** — both lines now cited (`integration.constants.ts:25-27`); verified above.
**N3** — `git log --oneline -- .claude/rules/testing.md` → `1b872b3`, `a3877ad`;
`git show --stat 3374cf9` does not list the file. Attribution corrected correctly.
`.claude/rules/testing.md:37` is "Do not describe these suites as excluded or opt-in."
**N4** — `INTEGRATION_FIELD_PAIR_STRIDE` split out (`integration.constants.ts:88-94`), and the
neighbour it cites is `FIELD_PAIR_STRIDE = 2` at `apps/usage-service/tests/integration.fixtures.ts:186`.
Correct.

### L4 · `vi.waitFor` left on the default — accepted, residual restated

Confirmed from source, not documentation: `node_modules/.pnpm/vitest@2.1.9_@types+node@22.20.1/
node_modules/vitest/dist/chunks/vi.DgezovHB.js:3561` — `{ interval = 50, timeout = 1e3 }`. So the
budget is **1000 ms per `waitFor` call**, not per file, with a 50 ms poll.

Residual, stated as measured: the whole 10-test file runs in **804 ms** (`Duration 1.21s`
including 100 ms transform / 51 ms prepare), i.e. ~80 ms per case, and each case gets its own
1000 ms. The exposure is confined to the *first* `waitFor` in the file on a cold CI worker, where
vite-node must evaluate `src/index.ts`, `src/app.ts` and `src/events/stream.consumer.ts` inside
that one budget. **Failure mode if it ever bites is a timeout error, not a false pass**, which is
why accepting it is defensible. I accept the disposition; if you want it belt-and-braces the fix
is still one line at `tests/index.graceful-shutdown.unit.test.ts:69`:
`vi.waitFor(fn, { timeout: WAITFOR_TIMEOUT_MS, interval: WAITFOR_INTERVAL_MS })` with both from a
named constant.

---

## New findings in the rework

### LOW

**LOW-1 · The refuted "a mock cannot" universal survives in a fourth place the checklist says was
cleared.**
`docs/plans/t-038-consumer-group-bootstrap.md:393`:

> Prove three things a mock cannot: the group genuinely appears in `XINFO GROUPS`; a second call
> is a no-op that leaves the cursor alone; and **the group is created at the position D1 chose.**

The third item is refuted by the rework's *own* new evidence, which I reproduced above: replacing
`CREATE … $ MKSTREAM` with `SETID` reddens **U1**, a unit test, because the position is part of the
argument vector. A mock catches the argument `$`; only I5 catches the *effect*. The plan's §11
checklist says L1 was "corrected in all three places (integration header, §7 AC3, §9 R5)" — true,
and the enumeration is honest, but this fourth copy is the same universal in the same document.
**Fix (`docs/plans/t-038-consumer-group-bootstrap.md:393-395`):** "Prove three things a mock
cannot: the group genuinely appears in `XINFO GROUPS`; a repeat call leaves `last-delivered-id`
and `pending` where they were; and a pre-bootstrap entry is not delivered. (The `$` *argument* is
a unit concern — U1 reddens on the `SETID` mutation.)"

**LOW-2 · `WORKER_STREAM_CONSTANTS` has seven members, not five, and two of them are not env
defaults.**
`apps/worker-service/src/constants.ts:71-73`:

> A sibling of `WORKER_STREAM_CONSTANTS` rather than a member of it: **those five values** are
> *env defaults* (**each** is a `.default(...)` in `src/config/env.ts`, overridable per
> deployment).

Counted: `DEFAULT_STREAM_NAME`, `DEFAULT_CONSUMER_GROUP`, `DEFAULT_CONSUMER_NAME`,
`DEFAULT_BLOCK_MS`, `DEFAULT_BATCH_SIZE`, `BATCH_SIZE_MIN`, `BATCH_SIZE_MAX` — **seven**.
`grep -n "WORKER_STREAM_CONSTANTS\." src/config/env.ts` shows `BATCH_SIZE_MIN` and
`BATCH_SIZE_MAX` are `.min(...)` / `.max(...)` bounds at `:52-53`, not `.default(...)`, and are not
operator-overridable at all — which is the very property the docblock uses to separate the two
objects. The sibling-object *decision* is still right (the first pass judged it against
`.claude/rules/constants.md` and found no violation); only the count and the "each" are wrong.
**Fix (`apps/worker-service/src/constants.ts:71-73`):** "…rather than a member of it: five of that
object's seven members are `.default(...)`s in `src/config/env.ts` and the other two
(`BATCH_SIZE_MIN`/`BATCH_SIZE_MAX`) are the bounds on one of them. All seven are about
operator-supplied configuration. These four are protocol and policy tokens no operator may set."

*Correction to my own first pass:* that review stated "The stated reason … is true of every member
of both objects, which I checked one by one." That was wrong — I did not check `BATCH_SIZE_MIN`
and `BATCH_SIZE_MAX` against `env.ts`. Recorded here rather than quietly fixed.

**LOW-3 · S-23's `undefined` sentence is false under one of its two readings, in an authoritative
file.**
`.claude/rules/known-gaps.md`, S-23:

> Both fields were also probed with `undefined`, which yields the shared default
> `telemetry:events` on both sides.

The table immediately above lists **three** fields. Read as "the two worker fields", the sentence
is false: `REDIS_CONSUMER_GROUP` with `undefined` yields **`worker-group`**, measured above. Read
as "usage's and worker's `REDIS_STREAM_NAME`" — which "on both sides" points at — it is exactly
true. The measurements behind it are all correct; the antecedent is not pinned. Because
`CLAUDE.md` designates this file authoritative and instructs agents to trust it without
re-verification, pin it.
**Fix (`.claude/rules/known-gaps.md`, S-23, the "Measured against the real schemas" paragraph):**
"Both `REDIS_STREAM_NAME` declarations were also probed with `undefined`, which yields the shared
default `telemetry:events` on both sides; `REDIS_CONSUMER_GROUP` with `undefined` yields
`worker-group`. The divergence is specific to the *empty* value, not the absent one."

**LOW-4 · The H1 fix introduces three new inline literals into a test file that has a companion
constants module for exactly this.**
`apps/worker-service/tests/stream.consumer.integration.test.ts:168-170` writes `"CLIENT"`,
`"INFO"` and the `` `db=` `` prefix inline. `.claude/rules/constants.md` "Applies to …
controllers, routes, middleware, entrypoints — **and tests**", and
`tests/integration.constants.ts:44` already exists as "`XINFO`/`XREADGROUP`/`XADD` tokens the
harness issues" — whose docblock at `:7-9` enumerates three command families and is now
incomplete. Small, but this is a *new* literal introduced by the fix, so it is in scope.
**Fix (`apps/worker-service/tests/integration.constants.ts:45-54`):** add
`CLIENT: "CLIENT"`, `CLIENT_INFO: "INFO"` to `INTEGRATION_REDIS_COMMANDS` and
`export const INTEGRATION_CLIENT_INFO_DB_PREFIX = "db=";`, use them at
`stream.consumer.integration.test.ts:168-170`, and add `CLIENT INFO` to the `:7-9` enumeration.

**LOW-5 · `.env.example`'s "five" is now stale in the other direction.**
`apps/worker-service/.env.example:27-29` says "The remaining three are still
declared-but-unread". Verified correct: `grep -rn` over `apps/worker-service/src` finds
`REDIS_CONSUMER_NAME`, `STREAM_BLOCK_MS` and `STREAM_BATCH_SIZE` only in `config/env.ts:43-54`,
and `REDIS_STREAM_NAME`/`REDIS_CONSUMER_GROUP` read at `events/stream.consumer.ts:56-57`. **No
finding on the env file.** The stale "five magic literals" count is in the plan instead —
`docs/plans/t-038-consumer-group-bootstrap.md:262-264` still says the epic's snippet "contains
five magic literals … All five must be named constants", while the shipped object has four and
the two env reads are not literals. First pass noted this; the rework did not touch it.
**Fix (`docs/plans/t-038-consumer-group-bootstrap.md:262-264`):** "four magic literals (`"CREATE"`,
`"MKSTREAM"`, `"$"`, `"BUSYGROUP"`) plus two implicit env reads".

### NIT

- **N-A** `docs/plans/t-038-consumer-group-bootstrap.md:559` (R5) says "see §4's Gate-4
  correction". §4's correction box is about `.claude/rules/testing.md` and says nothing about the
  mock/`SETID` claim; `grep -n "Gate-4 correction"` finds only the two references and no such box.
  Point R5 at §7 AC3, or add the box. `:416`'s "(see Gate-4 correction below)" has the same
  problem in the same direction.
- **N-B** `apps/worker-service/tests/stream.consumer.integration.test.ts:148-153` describes a
  mutation applied to a shape the file **no longer has**, then says "With this helper the same
  mutation leaves the sentinel in place." Both statements are true (I measured both), but the
  reader has to infer that the `1 -> 0` observation is against the pre-fix half-guard shape.
  S-22's version of the same paragraph *is* explicit ("With the same mutation against the
  every-flush shape…"); mirror that wording here.
- **N-C** `docs/plans/t-038-consumer-group-bootstrap.md:402` — "**Slice 5 — docs.**
  `.env.example` lines 37-38. Nothing else." The delivered change touches `.env.example:24-57`
  (L3's warning, the fail-closed note, the FK correction). Update the slice description or mark it
  amended at Gate 3, so the plan is not read as the scope of record.

---

## Compile-time gate — `--force`, all 13 packages

`pnpm build -- --force` does not forward the flag; all four run through `npx turbo run <task>
--force`. **0 cached on every task**, so this is a re-run, not a replay.

| Task | Result | Time |
|---|---|---|
| typecheck | **13 successful / 13**, 0 cached, 0 errors | 23.2 s |
| lint | **13 successful / 13**, 0 cached, **0 errors, 14 warnings** | 32.5 s |
| build | **13 successful / 13**, 0 cached | 23.2 s |
| test | **13 successful / 13**, 0 cached | 18.8 s |

Per-package tests: analytics 4 files/18 · auth 15/164 · billing 4/18 · gateway 8/38 ·
shared-config 1/4 · shared-logger 1/4 · shared-tracing 1/2 · shared-types 1/8 · shared-utils 1/18
· shared-validation 1/15 · usage 19/230 · **worker 7/62** · web `--passWithNoTests` ("No test
files found, exiting with code 0"). Worker matches the expected 7/62 against a 5/49 baseline;
usage 19/230 unchanged.

**Lint warnings — 14, all pre-existing, proved:**

| File | Warnings | `git log -1` | In `git diff --name-only`? |
|---|---|---|---|
| `apps/auth-service/tests/auth.service.unit.test.ts` | 10 `no-misused-promises` | `d68e719` 2026-08-25 | no |
| `apps/usage-service/tests/ingestion.service.unit.test.ts` | 4 `no-unsafe-assignment` | `b0f6921` 2026-08-31 | no |

Neither appears in `git status --porcelain`. `turbo run lint --filter @telemetry/worker-service
--force` is silent — the change introduces **zero** warnings, including with a bare
`redis.flushdb()` spliced in (see H1). Neither set is counted against this change.

`pnpm format:check` unchanged from the first pass's analysis (265 → 270, the +5 being the five new
prettier-visible files; the modified files were proved already-unformatted at `HEAD`). S-12; not
scored.

---

## What I could not verify, and why

1. **The worker failing to start against a down Redis, end to end.** Same limitation as the first
   pass: the fail-closed *path* is covered by U8 and the *rejection shape* was reproduced, but I
   did not stop the developer's Redis, because the full `test --force` gate and the S-22
   reproduction both needed it. Composition of the two remains reasoning.
2. **S-23's producer half, executed.** That `REDIS_STREAM_NAME=""` makes `StreamPublisher` XADD to
   `telemetry:events` follows from the measured `""` parse plus the `||` arm at
   `stream.publisher.ts:36`; I did not boot usage-service with that env to watch an `XADD` land.
   Labelled as reasoning in the table above.
3. **S-22's original "2 to 3" DBSIZE figure.** Not re-run this pass (it writes to db 0 and to the
   dev database). The first pass verified the +1 delta as 4 → 5 and explained the absolute
   difference as TTL expiry. Independent corroboration this pass: db 0 now carries one TTL'd
   `denylist:*` key left by my own gate run.
4. **The full 20 runs behind M3's table.** I ran 12 (six at 2 turns, two each at 5/10/20). The
   determinism and the md5-identical failure set are established; the count of 20 is not
   re-derived.
5. **Anything outside Redis 7.0.15 standalone / ioredis 5.11.1 / vitest 2.1.9 / zod 3.25.76 / PG
   16 on this host.** Cluster mode, Redis 6.x, and managed providers with fewer than 16 logical
   databases remain unverified — and a single-database provider makes the db-14 and db-15
   reservations collide with production keys.
6. **CI behaviour.** `.github/workflows/ci.yml` publishes `redis:7-alpine` on 6379 and
   `apps/worker-service/tests/setup.ts:9` hard-codes the URL past turbo's strict env mode, so db 14
   will exist and be empty. Read, not run.
7. **A db-14 / db-15 concurrency collision.** `turbo.json` still sets no `--concurrency`, so the
   two packages' test tasks *can* overlap; I did not force an overlap.
8. **The first pass's twelve Redis-semantics probes and the D4 `startsWith` universal** were not
   re-derived here — the rework did not touch them. Their record is
   `docs/reviews/t-038-consumer-group-bootstrap.md`. I re-derived only what the rework changed
   (L2's FK proof) plus the two `SETID` mutation shapes, which the rework's new prose asserts.

---

## Decision for you

### D-C · Ship T-038 without the two `known-gaps.md` entries I recommended but that were not filed?

The checklist's one unchecked box. Only S-23 was filed; the other two recommendations were the
`redis://localhost:6379` duplication (L5 in the first pass) and the per-suite logical-database
convention being enforced by nothing.

Sharpened with a count, since the first pass understated it: `grep -rn '"redis://localhost:6379"'
--include=*.ts apps packages` (excluding `dist`) returns **13** occurrences across **6** packages —
`gateway/tests/config/container.unit.test.ts`, and `tests/setup.ts` in all five services that have
one, plus three `env.schema.unit.test.ts`, `auth.integration.test.ts`,
`usage-service/tests/integration.constants.ts` and the one T-038 adds at
`worker-service/tests/integration.constants.ts:15`. The first pass said "at least five files".

| Option | What changes about the work |
|---|---|
| **A · Ship as-is; file nothing more** *(recommended)* | No diff change. Both items are LOW and neither is a live hole: the URL duplication is a constants-hygiene debt, and the logical-database convention is already stated in S-22's closing sentence ("a convention no mechanism enforces … needs key prefixes instead"). |
| B · Ship as-is, and file **one** combined LOW entry (S-24) covering both | `.claude/rules/known-gaps.md` gains ~15 lines. Diff changes (prose only). Buys findability for whoever moves CI to a managed Redis — the case where the db-14/db-15 reservations stop meaning anything. |
| C · File two separate entries (S-24, S-25) | Same, ~30 lines, two ids. Diff changes (prose only). Most faithful to the first pass's wording; also the most `known-gaps.md` churn for two LOW items in one commit. |

**Recommend A.** Shipping T-038 without them is acceptable to me and I am not conditioning the
verdict on it. The reason is that neither item is *lost* by not filing: the URL duplication is
mechanically re-findable with one `grep` and is already flagged in the first-pass review that
ships in this same commit, and the convention hazard is written down in S-22, which this change
adds. Filing S-24 for both (option B) is the better long-run answer if you expect the CI Redis to
move to a managed instance in the next few epics — that is the event that turns the second item
from hygiene into a real defect, and a `known-gaps.md` id is how it gets found then.

All three options are **preference, not correctness** — none changes any code, any test, or any
claim's truth value.

---

## Dispositions carried forward, unchanged

- **L3's follow-up** — T-039 should log a warning when it bootstraps a group on a key with
  `XLEN` 0 *and* `entries-added` 0. Belongs in T-039's plan, not `known-gaps.md`.
- **L6** — `StreamConsumer` constructed in `index.ts:74` rather than the container. Defer to
  T-039, which needs the object to hold loop state.
- **L7** — the SIGTERM-during-bootstrap claim at `src/index.ts:62-64` is still reasoning with no
  test. Optional.
- **L8** — the two-field `as ServiceEnv` cast at `tests/stream.consumer.integration.test.ts:71-75`
  silently yields `undefined` if T-039 reads a third field. Narrowing the constructor to
  `Pick<ServiceEnv, "REDIS_STREAM_NAME" | "REDIS_CONSUMER_GROUP">` is the durable fix and belongs
  with T-039.
- **S-8, S-9, S-19, S-22, S-23** all remain open and untouched by this change.

---

**Verdict: APPROVED FOR COMMIT.**

H1, M2 and M3 are fixed, and each fix's stated mutation reproduces on my own execution rather than
on the rework's report of it. L1, L2, L3 and N1-N4 are corrected, and I re-derived L2's new proof
and N1's count directly. L4 is accepted with the residual named. The five LOW and three NIT items
above are prose-accuracy corrections — none is required before commit; LOW-2 and LOW-3 are the two
worth doing, because LOW-3 is in a file other agents are told to trust and LOW-2 is a miscount I
wrongly cleared in the first pass. D-C is preference and changes no code.
