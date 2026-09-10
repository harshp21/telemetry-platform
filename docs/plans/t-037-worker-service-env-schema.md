# T-037 — Worker Service Env Schema

**Gate**: 1 (Task Planner) · **Status**: awaiting approval · **Base**: `9315493`
**Epic**: `docs/epics/epic-7-worker-service.md` · **Milestone**: v1-mvp
**Owning file**: `apps/worker-service/src/config/env.ts`

No prior plan for T-037 exists (`ls docs/plans/ | grep -i 037` → no match). This is a new plan,
not an extension or replacement.

---

## 0. Gate scoping — why this task is not blocked on Q10

`docs/epics/README.md:70` lists Epic 7's dependencies as "Epic 3, Epic 6, **Q10**". The epic
file's own header says "**Depends on**: Epic 2, Epic 3, Epic 6 (stream must exist)" and places
Q10 under "Pre-coding decisions required" rather than as a precondition on every task.
`grep -n "Milestone" docs/epics/epic-7-worker-service.md` shows `Milestone: v1` declared on
**T-041** and **T-042** only; T-037–T-040 and T-043 carry no per-task milestone and inherit
v1-mvp.

Q10's live content is max retries, retry delay, and dead-letter destination. Two of those three
already have concrete values in the epic text (`MAX_RETRY_COUNT` default 3,
`DEAD_LETTER_STREAM` default `telemetry:dead-letter`); retry *delay* is the genuinely
unspecified part and no schema field in T-037 expresses it. **T-037 is therefore ungated.**
Q10 must be settled before T-041, which is where a retry delay would first be read.

This matches `.claude/rules/known-gaps.md` S-15: the epic README is not a reliable manifest, and
where it disagrees with the epic file the epic file plus the code wins.

---

## 1. Business context

### Objective

Epic 6 is complete: `POST /v1/usage/events` deduplicates and publishes to a Redis Stream. Nothing
consumes it. T-037 declares the configuration surface that T-038 (consumer group bootstrap),
T-039 (consumer loop) and T-040 (event → `UsageLine` processor) will read, so that the consumer
they build points at the stream the producer actually writes.

Verified, not assumed — the stream exists and has never been consumed:

```
$ redis-cli -h localhost --scan --pattern 'telemetry*'
telemetry:events
$ redis-cli -h localhost xlen telemetry:events
2
$ redis-cli -h localhost xinfo groups telemetry:events
(empty)
```

Two real entries, zero consumer groups. That is the gap Epic 7 closes.

### User impact

Nothing user-visible ships in T-037 — it is configuration only, and no runtime behaviour changes
except worker's startup contract (see §4, Decision D1). The user-visible payoff arrives at T-040,
when ingested events become billable `UsageLine` rows. The impact of getting T-037 *wrong* is
larger than the impact of getting it right: a consumer defaulting to a stream name the producer
does not write is a silent no-op, not an error — worker would block on `XREADGROUP` forever,
report healthy, and drop revenue data on the floor.

---

## 2. Scope and non-goals

### In scope

- `apps/worker-service/src/config/env.ts` — add stream-consumer configuration.
- `apps/worker-service/src/constants.ts` — a `WORKER_STREAM_CONSTANTS` block holding the default
  values, per `.claude/rules/constants.md` ("defaults belong in constants").
- `apps/worker-service/.env.example` — document every new var.
- `apps/worker-service/tests/env.schema.unit.test.ts` — **new file**, modelled on
  `apps/usage-service/tests/env.schema.unit.test.ts`.
- **Conditional on Decision D1 (§4)**: `INTERNAL_API_SECRET` into `EnvSchema`,
  `apps/worker-service/src/app.ts:23` to read it, and a partial-close note on S-8 in
  `.claude/rules/known-gaps.md`.

### Non-goals

- **No consumer code.** No `stream.consumer.ts`, no `XGROUP`, no `XREADGROUP`. T-038/T-039.
- **No repository or processor work.** T-040.
- **No DLQ behaviour.** T-041, and behind Q10.
- **No timing-safe comparison, no `onRequest` promotion.** Those are S-8 items 1 and 3 and they
  are middleware behaviour, not env configuration — see §4 for why the seam is drawn there.
- **No billing-service changes.** S-8 names billing and worker together; T-037 is a worker task.
- **No `base.repository.ts` change.** S-19 records that worker's copy is one of five and did not
  receive S-18's `set_config('TimeZone','UTC',true)` pin. Nothing in T-037 touches it, and
  **T-040 must not assume worker's `withTenant` behaves like usage-service's** — verified:
  `grep -c TIME_ZONE apps/worker-service/src/repositories/base.repository.ts` → `0`.
- **No `prettier --write`.** S-12: `pnpm format:check` fails on 261 files at base (see §6).

---

## 3. Ground truth — the epic's schema line by line

Every row below was established by reading the file named, at `9315493`.

| Epic line | Reality | Verdict |
|---|---|---|
| `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL` | Identical in `apps/worker-service/src/config/env.ts:5-10` | **Correct, no change** |
| `PORT … .default(3003)` | `env.ts:6` currently defaults to **3000** | **Epic is right, code is stale** — but see below |
| `REDIS_STREAM_NAME` default `"telemetry:events"` | Producer writes `telemetry:events` | **Correct — verified three ways** |
| `REDIS_CONSUMER_GROUP` default `"worker-group"` | No existing group; no other reference in the repo | **Free choice, accept** |
| `REDIS_CONSUMER_NAME` default `"worker-1"` | Matches epic's Q9 decision (horizontal-ready, one local instance) | **Accept** |
| `STREAM_BLOCK_MS` default `5_000` | No existing reference | **Accept** |
| `STREAM_BATCH_SIZE` `.min(1).max(100).default(10)` | No existing reference | **Accept, with a caveat below** |
| `MAX_RETRY_COUNT` default `3` | Read only by T-041 | **Defer — see §4 D2** |
| `DEAD_LETTER_STREAM` default `"telemetry:dead-letter"` | Read only by T-041 | **Defer — see §4 D2** |
| `STREAM_MAX_LEN` | **Absent from the epic's worker schema** | **Epic is right to omit it** |
| `INTERNAL_API_SECRET` | **Absent from the epic's worker schema**, but required by the running service | **Epic is wrong — see §4 D1** |

### 3.1 The stream name — the single most consequential line

Three independent confirmations that `telemetry:events` is correct:

1. `apps/usage-service/src/constants.ts:110-113` —
   `STREAM_CONSTANTS.DEFAULT_STREAM_NAME: "telemetry:events"`.
2. `apps/usage-service/src/config/env.ts:17` —
   `REDIS_STREAM_NAME: z.string().default("telemetry:events")`, and
   `apps/usage-service/src/events/stream.publisher.ts:35-36` resolves
   `env.REDIS_STREAM_NAME || STREAM_CONSTANTS.DEFAULT_STREAM_NAME` into `XADD`'s first argument
   at `stream.publisher.ts:55`.
3. **Live**: `redis-cli --scan --pattern 'telemetry*'` returns exactly `telemetry:events`, and
   `redis-cli type telemetry:events` → `stream`. `xrange` shows the producer's field names:
   `eventId, tenantId, eventType, quantity, unit, occurredAt, idempotencyKey, timestamp,
   sourceId`.

The epic is correct here. The observed field list is recorded for T-040's benefit, not T-037's.

One residual coupling worth naming now, because T-037 is where it becomes cheap to fix: if an
operator sets `REDIS_STREAM_NAME` on usage-service and forgets worker, ingestion succeeds and
consumption silently stops.

**Corrected after Gate 4 (M-1).** The count above was wrong in the version of this plan that was
approved. `telemetry:events` appeared **twice in `src/` before this task** —
`apps/usage-service/src/constants.ts:111` and `apps/usage-service/src/config/env.ts:17` — so
worker's is the **third** copy and `.claude/rules/constants.md`'s "before adding a third copy of
a literal, promote it" fires now. The user flipped D4 on that basis; see D4 below for what
landed.

### 3.2 `PORT` — the epic's 3003 is right, and the current 3000 is harmless

```
$ git grep -n "env\.PORT" 9315493 -- apps | wc -l
12
$ git grep -n "env\.PORT" 9315493 -- apps | grep -vc "process\.env\.PORT"
0
$ grep -n "process.env.PORT" apps/worker-service/src/index.ts
59:	const port = Number(process.env.PORT ?? WORKER_SERVICE_STARTUP.DEFAULT_PORT);
```

**Corrected after Gate 4 (L-5).** The approved version of this plan quoted
`grep -rn "env\.PORT" apps/*/src` → `(no matches)`. That command does not produce that output:
the pattern matches `process.env.PORT` too, so it returns 6 lines in `src/` at base (12 across
`apps/` including test setup files). The transcript above is what was actually run. The
*conclusion* is unchanged and holds: every `env.PORT` in the repo at base is `process.env.PORT`,
so no module reads the parsed `env.PORT`.

`apps/worker-service/src/index.ts:59` reads `process.env.PORT` **directly** and falls back to
`WORKER_SERVICE_STARTUP.DEFAULT_PORT` (`startup.constants.ts:3` = `3003`). The parsed
`env.PORT` is never read by any service in the repo — I checked all seven with the grep above.
So `env.ts:6`'s `3000` is inert today, and this is a repo-wide pattern, not a worker defect:
`apps/usage-service/src/config/env.ts:7` and `apps/billing-service/src/config/env.ts:6` also say
`3000` while their startup constants say `3002` and `3004`.

Everything else agrees on 3003: `startup.constants.ts:3`, `constants.ts:22`
(`WORKER_RUNTIME.DEFAULT_PORT`), `.env.example:6`, `docker/docker-compose.yml:148,151`
(`PORT: "3003"`, `"3003:3003"`), and `tests/setup.ts:3`.

**Recommendation**: change it to `3003`. It is a one-token edit that removes a misleading value
and matches the epic. I am *not* extending the fix to usage-service or billing-service — that is
a repo-wide cleanup with its own review. Recorded as a settled decision, not a question.

A related duplicate I am **not** fixing: `WORKER_RUNTIME.DEFAULT_PORT` (`constants.ts:22`) and
`WORKER_SERVICE_STARTUP.DEFAULT_PORT` (`startup.constants.ts:3`) are both `3003`. `WORKER_RUNTIME`
is used only by `tests/smoke.test.ts:10`. Collapsing them touches the tracing-ordering contract
in `CLAUDE.md` ("keep startup constants in a side-effect-free `startup.constants.ts`"), so it
stays out of an env-schema task. Flagged for the reviewer as pre-existing.

### 3.3 `STREAM_MAX_LEN` — correctly absent, and here is why

`MAXLEN` is a **write-side** trim argument. `apps/usage-service/src/events/stream.publisher.ts:54-60`
passes it to `XADD`. A consumer issuing `XREADGROUP` never supplies `MAXLEN`; nothing in the
T-038/T-039/T-040 sketches in the epic references it. Declaring it in worker's schema would
create an env var no worker code reads — **exactly S-6** (`INGEST_BATCH_MAX` is dead config,
still open). The epic omits it and the epic is right. Do not add it.

### 3.4 `STREAM_BATCH_SIZE` — accepted, with the bound stated as observed

The epic's `.min(1).max(100)` mirrors usage-service's `INGEST_BATCH_MAX` bound
(`apps/usage-service/src/config/env.ts:19`). I have **not** established that 100 is a Redis limit
— `XREADGROUP COUNT` accepts far larger values — so the plan will document this as a
*deliberate operational ceiling matching the producer's batch cap*, not as a protocol
constraint. Any comment in the code must say that; asserting "Redis caps COUNT at 100" would be
an untested universal and a reviewer finding.

Note this one is **not** dead config: T-039's `XREADGROUP … COUNT batchSize` reads it. Same for
`STREAM_BLOCK_MS` (`BLOCK blockMs`), `REDIS_CONSUMER_GROUP` and `REDIS_CONSUMER_NAME` (both read
by T-038's `XGROUP CREATE` and T-039's `GROUP`). Declaring the five stream vars now is
consumed-within-the-same-epic, one and two tasks away.

---

## 4. Decisions

### D1 · `INTERNAL_API_SECRET` and S-8 — **RECOMMENDED: include the declaration, exclude the enforcement**

**The situation, verified.** `.claude/rules/known-gaps.md` S-8 is accurate for worker as written:

- `apps/worker-service/src/app.ts:23` —
  `options.internalApiSecret ?? process.env.INTERNAL_API_SECRET ?? ""`, bypassing the schema.
- `apps/worker-service/src/middleware/internal-auth.middleware.ts:9` — `normalizedSecret !== internalApiSecret`,
  not timing-safe, and the `reply.status(401).send(...)` on line 10 is **not returned**.
- `apps/worker-service/src/app.ts:49` — `preHandler`, not `onRequest`.
- `apps/worker-service/src/config/env.ts` has no `INTERNAL_API_SECRET`, so
  `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` (`packages/shared-types/src/index.ts:92-94` = 32)
  is never enforced; the only guard is `.trim()` at `app.ts:34`, which runs *after*
  `createContainer` at `app.ts:21`. A one-character secret starts cleanly.

`apps/billing-service/src/app.ts:23` and `apps/billing-service/src/config/env.ts` are the same
shape — I read both; billing's env schema is byte-comparable to worker's current one.

**Recommendation: option B.** Declare `INTERNAL_API_SECRET` in worker's `EnvSchema` with
`.min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)`, change `app.ts:23` to read `env.INTERNAL_API_SECRET`,
and leave the middleware alone.

**Why the seam is drawn there.** T-037's deliverable is *the declaration of what worker-service
requires from its environment*. `INTERNAL_API_SECRET` **is** required by worker-service today —
`app.ts:34-36` throws `InternalApiSecretMissingError` without it. Omitting it produces a schema
that is knowingly incomplete on the day it ships, and the next task to open `env.ts` has to
reopen the question. The remaining two S-8 items — constant-time comparison, `onRequest` +
returned reply — are *enforcement behaviour in a middleware file*, share a recommended fix
(one shared helper) with billing-service, and belong to an S-8 task spanning both services.
Declaration is config; enforcement is security middleware. T-037 owns the first.

**Why the declaration must drag `app.ts:23` with it.** If `env.ts` declares the var and
`app.ts` keeps reading `process.env`, the declaration is config nothing reads — S-6 again, and
the parent brief flags exactly that trap. So option B is env.ts **and** app.ts:23, or neither.

**Alternatives rejected:**

- **A — schema only, `INTERNAL_API_SECRET` left out entirely.** Rejected: ships a deliberately
  incomplete schema and leaves a var the service hard-requires undeclared. Its only merit is a
  smaller diff.
- **C — full S-8 close for worker (timing-safe + `onRequest` + env schema).** Rejected: breaks
  the one-task-per-commit rule inside an env-schema task, and S-8's own fix direction asks for
  **one shared helper across billing and worker** — doing worker alone here would make a third
  divergent copy of the middleware likely, which is the S-14/S-19 failure mode.
- **D — declare it `.optional()`.** Rejected: an optional secret that `app.ts:34` then rejects at
  runtime is two contradictory contracts, and it does not enforce the 32-char minimum, which is
  the whole point of S-8 item 2.

**Blast radius of B, checked rather than assumed.** Making the var *required* means `parseEnv`
throws at module load for every consumer of `src/config/env`:

| Consumer | Value | Length | Safe? |
|---|---|---|---|
| `apps/worker-service/tests/setup.ts:12` | `test-internal-api-secret-change-in-production` | 45 | yes |
| `docker/docker-compose.yml:149` | `ci-internal-api-secret-with-at-least-32-chars` | 45 | yes |
| `apps/worker-service/.env.example:20` | `dev-local-secret-change-in-production` | 37 | yes |
| `.github/workflows/ci.yml:34` | `ci-internal-api-secret-with-at-least-32-chars` | 45 | yes |

Lengths from `node -e 'console.log("…".length)'`. All four already exceed 32, so **no fixture
needs a new value.**

Two subtleties this creates, both small and both in scope:

1. `apps/worker-service/tests/smoke.test.ts:18` calls
   `buildWorkerServiceApp({ internalApiSecret: "test-secret" })` — 11 characters, below the
   minimum. The **option override must be preserved** so this keeps working; only the
   `process.env` fallback is replaced. If the override were removed the smoke test would need
   rewriting, which is a larger change than T-037 warrants.
2. `InternalApiSecretMissingError` (`apps/worker-service/src/errors/index.ts:5`) becomes
   reachable only via an explicitly-passed empty override, since the env path now fails earlier
   at module load. The guard at `app.ts:34` stays (it still guards the override path); the plan
   adds a comment saying which path it now covers. Deleting the error class is out of scope.

One fact that bounds S-8's worker severity, recorded so nobody over-reads this:
`grep -n "WORKER\|worker" apps/gateway/src/constants.ts apps/gateway/src/config/env.ts` returns
**nothing** — the gateway does not proxy to worker at all, unlike usage/billing/analytics. Worker's
`/v1/internal/worker/replay` is reachable only in-cluster or via the published `3003:3003`
mapping in `docker/docker-compose.yml:151`. That does not make the weak comparison acceptable; it
does mean T-037 is not fixing a live externally-reachable hole, which supports deferring items 1
and 3 rather than cramming them in here.

**If the user prefers option A**, slices 4 and 5 below drop wholesale and nothing else in this
plan changes. The slices are ordered so that is a deletion, not a rewrite.

### D2 · `MAX_RETRY_COUNT` and `DEAD_LETTER_STREAM` — **RECOMMENDED: defer to T-041**

Neither is read by T-038, T-039 or T-040. Declaring them now creates two env vars no code reads
until a `v1`-milestone task that is itself blocked on Q10 — the literal shape of S-6, which is
still open and which the reviewer will recognise. T-041 owns the DLQ file, the Prometheus
counter, and the Q10 answer; it should own the config too, and it can add both vars in one edit
alongside the retry-delay var Q10 will produce.

Rejected alternative — declare them now with the epic's defaults. Its merit is that the schema
then matches the epic verbatim and T-041 touches one fewer file. Rejected because "matches the
epic verbatim" is not a goal in a repo where the epic has been wrong six times (S-5, S-6, S-15,
S-16, S-17, and the `PORT` row in §3 above), and because Q10 may change `MAX_RETRY_COUNT`'s
bounds — declaring `.max(10)` now and revising it in T-041 is worse than declaring it once.

This is a **judgement call, not a verified fact**, and it is the second thing the user should
overrule if they disagree. Cost of being wrong either way: one small edit in T-041.

### D3 · Where the defaults live — **settled**

`.claude/rules/constants.md` requires stream names, timeouts and batch limits to live in a
constants module. usage-service's precedent is `STREAM_CONSTANTS` in
`apps/usage-service/src/constants.ts:110-113`, referenced from `stream.publisher.ts:36-37`. Worker
will mirror it with `WORKER_STREAM_CONSTANTS` in `apps/worker-service/src/constants.ts`, and
`env.ts` will reference those constants in its `.default(...)` calls rather than repeating
literals. Settled by existing convention; no user input needed.

### D4 · Promoting `telemetry:events` to a shared constant — **REVERSED at Gate 4: promote**

Originally settled as "not now" on the false premise that worker's was the second copy (§3.1,
M-1). It is the third, so the promotion threshold in `.claude/rules/constants.md` is met exactly
now, and the user approved flipping this decision.

**What landed.** `EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM` in `@telemetry/shared-types`, next
to `INTERNAL_AUTH_CONSTANTS` and for the same stated reason — more than one service's env schema
resolves it. All three `src/` sites now derive from it:

| Site | Before | After |
|---|---|---|
| `apps/usage-service/src/config/env.ts` | `.default("telemetry:events")` | `.default(EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM)` |
| `apps/usage-service/src/constants.ts` | `DEFAULT_STREAM_NAME: "telemetry:events"` | `DEFAULT_STREAM_NAME: EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM` |
| `apps/worker-service/src/constants.ts` | `DEFAULT_STREAM_NAME: "telemetry:events"` | `DEFAULT_STREAM_NAME: EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM` |

The `env.ts` row is the load-bearing one and the reason a promotion that reached only the two
`constants.ts` files would have fixed nothing: `stream.publisher.ts:35-36` resolves
`env.REDIS_STREAM_NAME || STREAM_CONSTANTS.DEFAULT_STREAM_NAME`, and because that `.default(...)`
always applies, the right-hand fallback is unreachable — the env default *is* the stream the
producer XADDs to.

`grep -rn '"telemetry:events"' apps/*/src packages/*/src` now returns exactly one line,
`packages/shared-types/src/index.ts`. Choice of home: `@telemetry/shared-types` already carries
`INTERNAL_AUTH_HEADERS`, `INTERNAL_AUTH_RESPONSES`, `INTERNAL_AUTH_CONSTANTS` and
`ERROR_RESPONSES`, so cross-service runtime constants are an established convention there; no
other shared package holds any (`shared-config` exports only `parseEnv`). Following the existing
home beat inventing one.

---

## 5. Files to change

### Existing

| File | Change | Conditional on |
|---|---|---|
| `apps/worker-service/src/constants.ts` | add `WORKER_STREAM_CONSTANTS` after `WORKER_RUNTIME` (line 24) | — |
| `apps/worker-service/src/config/env.ts` | 5 stream fields; `PORT` default `3000`→`3003` | — |
| `apps/worker-service/src/config/env.ts` | `INTERNAL_API_SECRET` field | D1 = B |
| `apps/worker-service/src/app.ts:23` | read `env.INTERNAL_API_SECRET`, keep the option override | D1 = B |
| `apps/worker-service/.env.example` | document the 5 new vars; annotate the secret | — |
| `.claude/rules/known-gaps.md` | S-8: mark worker's item 2 closed, items 1 and 3 open | D1 = B |

**Added at Gate 4 rework** (D4 reversed, plus the review's required and accepted findings):

| File | Change | Finding |
|---|---|---|
| `packages/shared-types/src/index.ts` | add `EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM` | D4 / M-1 |
| `packages/shared-types/tests/unit.test.ts` | pin the shared key to the literal `telemetry:events` | D4 |
| `apps/usage-service/src/config/env.ts` | `REDIS_STREAM_NAME` default derives from the shared constant | D4 / H-1 |
| `apps/usage-service/src/constants.ts` | `STREAM_CONSTANTS.DEFAULT_STREAM_NAME` derives from it | D4 |
| `apps/worker-service/src/config/env.ts` | `INTERNAL_API_SECRET` gains `.trim()`; comment tense | M-2 / L-1 |
| `apps/worker-service/src/app.ts` | correct the "reachable only through" comment | M-2 |
| `apps/worker-service/src/constants.ts` | derive the stream name; correct two false comments | H-1 / M-1 / N-3 |
| `apps/worker-service/tests/env.schema.unit.test.ts` | AC1b reduced; AC13, AC14, two AC10 cases | H-1 / L-2 / M-2 |
| `apps/worker-service/.env.example` | future tense; "no code reads these yet" | M-4 / L-1 |
| `docs/reviewer-checklist.md` | worker's "fails fast" cell → `yes (env schema, T-037)` | M-3 |

### New

| File | Purpose |
|---|---|
| `apps/worker-service/tests/env.schema.unit.test.ts` | the whole test surface for this task |

### Deliberately not modified

> **Scope note (D4 reversed at Gate 4).** The user reversed D4 after round 1: `telemetry:events`
> was promoted to `EVENT_STREAM_CONSTANTS` in `packages/shared-types`, so this task now also
> changes `packages/shared-types/src/index.ts` (+ its test) and two `apps/usage-service/src`
> files. usage-service is therefore **not** excluded; only its tests and middleware are.

`apps/worker-service/src/repositories/base.repository.ts` (S-19) ·
`apps/worker-service/src/middleware/internal-auth.middleware.ts` (S-8 items 1/3) ·
`apps/worker-service/src/index.ts` · `apps/worker-service/src/startup.constants.ts` ·
`apps/billing-service/**` · `apps/usage-service/tests/**` and its middleware ·
`docker/docker-compose.yml` ·
`.github/workflows/ci.yml` · `turbo.json` · `.claude/agents/epic-router.md` (uncommitted and
unrelated — leave it alone) · anything reachable by `prettier --write` (S-12).

---

## 6. Implementation slices

### Controlling code path

```
process.env
  └─> apps/worker-service/src/config/env.ts:15   parseEnv(EnvSchema, process.env)   [throws here or nowhere]
        └─> apps/worker-service/src/app.ts:21     createContainer(WORKER_SERVICE_NAME, env)
              └─> apps/worker-service/src/config/container.ts:37-43   AppContainer.env
                    └─> (T-038/T-039) stream consumer reads container.env.REDIS_STREAM_NAME …
```

`parseEnv` (`packages/shared-config/src/index.ts:6-17`) does `safeParse` and throws
`Invalid environment configuration for <field>: <message>` on the **first** issue, then
`Object.freeze`s the result. That single line is the whole enforcement point: everything the
schema declares is enforced at module load, and everything it omits is enforced nowhere.

### Falsifiable local hypothesis

> **H**: worker's env schema is the only gate on worker's configuration, and adding a required
> `INTERNAL_API_SECRET` to it will fail no existing worker test, because every fixture that
> loads `src/config/env` already supplies a value of at least 32 characters.
>
> **Falsified if** `pnpm --filter @telemetry/worker-service test` goes from 19/19 passing
> (baseline measured below) to anything less after slice 4, or if any worker test loads
> `src/config/env` through a path that does not run `tests/setup.ts`.

Baseline measured at `9315493`:

```
$ pnpm --filter @telemetry/worker-service test
 Test Files  4 passed (4)
      Tests  19 passed (19)
$ pnpm --filter @telemetry/worker-service lint       # clean, no output
$ pnpm --filter @telemetry/worker-service typecheck  # clean, no output
```

A secondary hypothesis worth stating because it is the expensive one to get wrong:

> **H2**: worker's consumer, once written, will read the same stream the producer writes.
> **Falsified if** worker's resolved `REDIS_STREAM_NAME` default is ever anything other than
> `telemetry:events` — asserted directly in slice 2's test rather than inferred from the
> constant.

### Slices, smallest safe first

**Slice 1 — constants (no behaviour).** Add `WORKER_STREAM_CONSTANTS` to
`apps/worker-service/src/constants.ts`: `DEFAULT_STREAM_NAME`, `DEFAULT_CONSUMER_GROUP`,
`DEFAULT_CONSUMER_NAME`, `DEFAULT_BLOCK_MS`, `DEFAULT_BATCH_SIZE`, `BATCH_SIZE_MIN`,
`BATCH_SIZE_MAX`. Validate: `typecheck` + `lint`. Nothing should change at runtime.

**Slice 2 — tests first (pseudo-TDD, confirm red).** Create
`apps/worker-service/tests/env.schema.unit.test.ts` with every case in §7, importing
`WORKER_STREAM_CONSTANTS` and `INTERNAL_AUTH_CONSTANTS` rather than repeating literals
(`.claude/rules/constants.md` applies to tests). Run it and **record the failure output
verbatim** — a test that never failed proves nothing (`.claude/rules/testing.md`).

**Slice 3 — the five stream fields + `PORT`.** Extend `EnvSchema` with `REDIS_STREAM_NAME`,
`REDIS_CONSUMER_GROUP`, `REDIS_CONSUMER_NAME`, `STREAM_BLOCK_MS`, `STREAM_BATCH_SIZE`, each
defaulting from `WORKER_STREAM_CONSTANTS`; change `PORT`'s default to
`WORKER_SERVICE_STARTUP.DEFAULT_PORT`'s value. Run the new test file scoped:
`pnpm --filter @telemetry/worker-service exec vitest run tests/env.schema.unit.test.ts`
(note: `-- <file>` does **not** scope — `CLAUDE.md`). Then the full worker suite: expect 19 + new.

**Slice 4 — `INTERNAL_API_SECRET` in the schema** *(D1 = B only)*. Add the field with
`.min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)`, imported from `@telemetry/shared-types`
exactly as `apps/usage-service/src/config/env.ts:2,15` does, with a comment naming S-8. Run the
full worker suite — **this is where H is tested**. If anything beyond the new file fails, stop
and report before touching `app.ts`.

**Slice 5 — `app.ts:23` reads the parsed value** *(D1 = B only)*. Replace
`process.env.INTERNAL_API_SECRET ?? ""` with `env.INTERNAL_API_SECRET`, keeping
`options.internalApiSecret ??` in front so `smoke.test.ts:18`'s 11-char override still works.
Add a comment at `app.ts:34` saying the `.trim()` guard now covers only the override path. Run
the full worker suite.

**Slice 6 — docs.** `.env.example` gets the five stream vars with the same section headings the
file already uses, plus a comment on `INTERNAL_API_SECRET` matching usage-service's
(`apps/usage-service/.env.example:16-18`). Worth noting: usage-service's `.env.example` **never
got its stream vars documented** despite T-030 planning it — `grep -n "STREAM" apps/usage-service/.env.example`
returns nothing. Worker should not repeat that. If D1 = B, update S-8 in
`.claude/rules/known-gaps.md` to record item 2 as closed for worker only, still open for billing,
with items 1 and 3 open for both.

---

## 7. Test plan and acceptance-coverage mapping

One new file, `apps/worker-service/tests/env.schema.unit.test.ts`, structured after
`apps/usage-service/tests/env.schema.unit.test.ts` (a `buildBaseEnv()` helper, `EnvSchema.safeParse`
for field cases, `vi.resetModules()` + dynamic `import()` for module-load cases).

T-037 has no acceptance criteria block in the epic — the epic gives only the schema. The ACs
below are derived from that schema plus the two hypotheses in §6, and each is stated so it can
fail.

| # | Acceptance criterion | Test(s) |
|---|---|---|
| AC1 | `REDIS_STREAM_NAME` defaults to the stream usage-service publishes to | `defaults REDIS_STREAM_NAME to "telemetry:events"` — asserts the literal `"telemetry:events"`, **not** `WORKER_STREAM_CONSTANTS.DEFAULT_STREAM_NAME`, so the test still fails if the constant is edited to disagree with the producer |
| AC1b *(rewritten at Gate 4)* | worker's default is the shared stream key | `defaults REDIS_STREAM_NAME to the shared usage-events stream key` — the original form imported usage-service's constants module through a dynamic specifier and asserted equality. D4's reversal deleted its subject: both sides are now the same constant, so no divergence between them is expressible. What remains detectable, and what the reduced test asserts, is worker re-pinning to a literal while the shared value moves — proven by mutation (shared → `telemetry:events-v2` + worker re-pinned: AC1b red, AC1 green) |
| AC13 *(added at Gate 4, L-2)* | the three `.min(1)` stream guards are enforced | `rejects a blank REDIS_STREAM_NAME, REDIS_CONSUMER_GROUP or REDIS_CONSUMER_NAME` — the reviewer deleted all three `.min(1)`s and the suite stayed green; it now goes red |
| AC14 *(added at Gate 4, M-2)* | `app.ts`'s blank-secret guard is enforced and reachable only via the option | `rejects a blank internalApiSecret option` — the guard had no test at all |
| AC2 | `REDIS_STREAM_NAME` is overridable | `honours a REDIS_STREAM_NAME override` |
| AC3 | `REDIS_CONSUMER_GROUP` / `REDIS_CONSUMER_NAME` default and override | 2 tests, default + override each |
| AC4 | `STREAM_BLOCK_MS` defaults to 5000, coerces from string, rejects ≤ 0 | 3 tests, incl. `"0"` and `"-1"` negative cases |
| AC5 | `STREAM_BATCH_SIZE` defaults to 10, coerces, accepts bounds 1 and 100, rejects 0 and 101 | 3 tests (default+coerce, boundaries, out-of-range) |
| AC6 | `STREAM_BATCH_SIZE` rejects non-integers | `rejects a fractional STREAM_BATCH_SIZE` (`"2.5"`) — `z.coerce.number().int()` |
| AC7 | `PORT` defaults to 3003 | `defaults PORT to the worker startup port` — asserts against `WORKER_SERVICE_STARTUP.DEFAULT_PORT`, which is what makes the two agree rather than coincide |
| AC8 | pre-existing fields still parse and are still required | `rejects an env with no DATABASE_URL`, `… no REDIS_URL` — guards against a careless rewrite of the object |
| AC9 *(D1=B)* | `INTERNAL_API_SECRET` is required | `rejects an env with no INTERNAL_API_SECRET`, asserting `issue.path[0]` |
| AC10 *(D1=B)* | the 32-char minimum is enforced, on the trimmed value | `rejects a secret one char below SECRET_MIN_LENGTH`, `rejects an empty secret`, `accepts exactly SECRET_MIN_LENGTH` — all derived from the constant, no literal 32 — plus, added at Gate 4 for M-2, `rejects an all-whitespace INTERNAL_API_SECRET at the minimum length` and `strips surrounding whitespace from an otherwise valid INTERNAL_API_SECRET` |
| AC11 *(D1=B)* | it fails **fast**, at module load | `fails at module load when INTERNAL_API_SECRET is absent` — `vi.resetModules()`, `delete process.env.INTERNAL_API_SECRET`, `await expect(import("../src/config/env")).rejects.toThrow(/INTERNAL_API_SECRET/)`, with `afterEach` restoring the value |
| AC12 *(D1=B)* | the declaration is load-bearing, not decorative | `app.ts` no longer reads `process.env.INTERNAL_API_SECRET` — the honest form of this is a behavioural test: with `process.env.INTERNAL_API_SECRET` set to a **different** valid 32+ char value after module load, `buildWorkerServiceApp()` still authenticates with the *parsed* one. A grep-the-source assertion would be brittle; see the risk in §9 |

**Test-honesty notes** (`.claude/rules/testing.md`): every case above asserts a parse *outcome*,
not a mock. The negative cases carry the weight — AC10 and AC6 are the ones that would catch a
`z.string()` or a missing `.int()`. AC1 is deliberately written against the literal rather than
the constant so it cannot become tautological.

**Not tested here**: that a consumer reads the stream. That needs `XREADGROUP` and belongs to
T-039's integration coverage. Stated plainly because T-037's tests prove configuration, not
consumption, and no one should read a green T-037 as evidence that Epic 7 works.

---

## 8. Validation commands

### Task-scoped, in order, fail fast

```bash
pnpm --filter @telemetry/worker-service exec vitest run tests/env.schema.unit.test.ts
pnpm --filter @telemetry/worker-service typecheck
pnpm --filter @telemetry/worker-service lint
pnpm --filter @telemetry/worker-service test        # expect 19 baseline + new, 4+1 files
pnpm --filter @telemetry/worker-service build
```

### Cross-service check (cheap, catches the expensive mistake)

```bash
pnpm --filter @telemetry/usage-service test         # must be unchanged — nothing in T-037 touches it
```

### Full gate

```bash
pnpm build && pnpm test && pnpm lint && pnpm typecheck   # all 13 packages
```

### Deliberately excluded from the gate

`pnpm format:check` — **S-12, already failing at base**, measured at `9315493`:

```
$ pnpm format:check
[warn] Code style issues found in 261 files. Run Prettier with --write to fix.
 ELIFECYCLE  Command failed with exit code 1
```

The warning list includes `README.md`, `turbo.json`, and all seven shared packages — files this
task does not touch. It must not be reported as a T-037 regression, and it must not be "fixed" by
a repo-wide `prettier --write`, which would produce a diff dwarfing the task.

### Environment notes for whoever runs this

T-037's tests are pure unit tests over a Zod schema — **no Postgres and no Redis required**. That
said, the parent brief asked for environment claims to be verified rather than inferred, and the
verification turned up something a later Epic 7 task will trip over:

```
$ docker ps --format '{{.Names}}\t{{.Ports}}'
postgres-db     5432/tcp
supertokens-core  0.0.0.0:3567->3567/tcp

$ ss -ltnp | grep -E '5432|6379'
LISTEN 127.0.0.1:6379
LISTEN 127.0.0.1:5432

$ psql -h localhost -U postgres -d telemetry -tAc "select version(), inet_server_port()"
PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1) … |5432
```

The `postgres-db` container shows `5432/tcp` with **no host mapping** — unlike `supertokens-core`,
which shows `0.0.0.0:3567->3567`. The database reachable on `localhost:5432` is therefore a
**host-installed Ubuntu PostgreSQL 16.13**, not the container. Redis on `127.0.0.1:6379` likewise
has no container in `docker ps`. Anyone who reads `docker/docker-compose.yml` and concludes the
services are containerised here will be wrong. The roles do exist on that host server:

```
$ psql … -tAc "select rolname, rolsuper, rolbypassrls from pg_roles where rolname like 'telemetry%'"
telemetry_app|f|f
telemetry_auth_definer|f|f
telemetry_auth_app|f|f
```

`telemetry_app` is `NOSUPERUSER`/`NOBYPASSRLS` as `.claude/rules/tenant-isolation.md` describes.
This matters for T-040, not T-037.

---

## 9. Risks and mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Worker defaults to a stream the producer does not write → silent no-op, revenue data stranded | **HIGH** | *Closed in code at the Gate 4 rework.* Producer default, producer constant and consumer default are one `EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM`; a code-level disagreement is no longer expressible. AC1 pins that constant to the literal, AC1b pins worker's resolved default to the constant |
| R2 | The two `REDIS_STREAM_NAME` defaults drift when an operator overrides one service only | MEDIUM | **Still open, and now the only form R1 can take.** The promotion unifies the *defaults*, not the two env vars: `REDIS_STREAM_NAME` is read per-service, so setting it on usage-service alone still strands the consumer. Documented in `apps/worker-service/.env.example`; no code change can close it short of a single shared var |
| R3 | Required `INTERNAL_API_SECRET` breaks a fixture | LOW | All four supply-points measured at 37–45 chars (§4 D1 table); slice 4 is isolated so a failure is attributable |
| R4 | AC12 is hard to test without asserting on source text | MEDIUM | Write it behaviourally (mutate `process.env` after module load, assert the parsed value still wins). If that proves unstable, **report it and drop AC12** rather than substituting a `readFileSync`+regex test — a grep-the-source test is not a behaviour test and the reviewer will say so |
| R5 | Declaring config nobody reads (S-6 repeat) | MEDIUM | D2 defers `MAX_RETRY_COUNT`/`DEAD_LETTER_STREAM`; §3.3 rejects `STREAM_MAX_LEN`. The five declared vars are all read by T-038/T-039 |
| R6 | S-12 `format:check` reported as a regression | LOW | Baseline captured verbatim in §8; excluded from the gate by name |
| R7 | Scope creep into S-8 items 1/3 or into billing | MEDIUM | Named as non-goals in §2 with the reasoning in D1; slices 4–5 are the only S-8 touchpoints and are separable |
| R8 | T-040 assumes worker's `withTenant` matches usage-service's | MEDIUM (future) | S-19: `grep -c TIME_ZONE apps/worker-service/src/repositories/base.repository.ts` → `0`. Recorded in §2 so T-040's planner sees it |
| R9 | `env.PORT` change looks like a behaviour change | LOW | §3.2 proves with `grep -rn "env\.PORT" apps/*/src` (no matches) that nothing reads it. Reviewer gets this citation up front |

**What I could not verify.** That `STREAM_BLOCK_MS: 5000` and `STREAM_BATCH_SIZE: 10` are the
right operational values — there is no worker throughput data in this repo, and no consumer to
measure. They are the epic's numbers, adopted because they are plausible and cheaply changed by
env var, not because they were validated. The plan says so rather than implying otherwise.

---

## 10. Pending task checklist

- [done] User answers D1 (and optionally overrules D2, D4) — **blocks everything** (D1 = B; D2 defer; D4 not now)
- [done] Slice 1 — `WORKER_STREAM_CONSTANTS` in `constants.ts`
- [done] Slice 2 — `tests/env.schema.unit.test.ts` written, **red confirmed**: 23 failed / 3 passed (the 3 are the AC8 missing-var guards on pre-existing fields)
- [done] Slice 3 — five stream fields + `PORT` default → green
- [done] Slice 4 — `INTERNAL_API_SECRET` in `EnvSchema` *(D1 = B)*; **H held**: 19/19 baseline tests still passed, only AC12 red
- [done] Slice 5 — `app.ts:23` reads the parsed value, override preserved *(D1 = B)*; AC12 green
- [done] Slice 6 — `.env.example` (5 stream vars + secret annotation). **`known-gaps.md` deliberately not edited** — the implementer brief forbids it; the S-8 staleness is reported instead.
- [done] Task-scoped validation, then `pnpm --filter @telemetry/usage-service test`
- [done] Full gate 13/13; `format:check` excluded (S-12) with the baseline cited
- [not done] Stage everything — the implementer brief overrides the plan here: *never* commit, stage, push or branch. Working tree left for the user.
- [done] Gate 4 — Senior Reviewer (pre-QA): `CONDITIONAL`, `docs/reviews/t-037-worker-service-env-schema.md`
- [done] Gate 4 rework — D4 reversed: `EVENT_STREAM_CONSTANTS` promoted, all three `src/` sites derive from it; mutation-proved
- [done] Gate 4 rework — AC1b reduced to the shared-constant pin (its cross-package subject no longer exists)
- [done] Gate 4 rework — M-2: `.trim()` before `.min()`; whitespace secret rejected; `app.ts` comment corrected; AC14 covers the blank-option guard
- [done] Gate 4 rework — M-3: `docs/reviewer-checklist.md` worker row
- [done] Gate 4 rework — S-8 narrowed to billing for item 2; worker citations refreshed to `app.ts:27` / `app.ts:59`
- [done] Gate 4 rework — L-2 (AC13), L-5 (§3.2 transcript), M-4 / L-1 (tense), N-3 (cite the enforced batch cap)
- [done] Gate 4 rework — full gate re-run with `--force`, 13/13
- [ ] Gate 4 — Senior Reviewer, re-review of the rework

---

## 11. Approval gate

**This plan is complete and stops here. No production code and no tests have been written.**

Implementation must not begin until the user approves. Two things need an explicit answer, and
one is load-bearing:

1. **D1 — `INTERNAL_API_SECRET` (required).** My recommendation is **B**: declare it in
   `EnvSchema` and make `app.ts:23` read it, leaving S-8's timing-safe comparison and
   `onRequest` promotion to a dedicated S-8 task covering billing and worker together with one
   shared helper. Choosing **A** instead deletes slices 4 and 5 and changes nothing else.
2. **D2 — `MAX_RETRY_COUNT` / `DEAD_LETTER_STREAM` (overrulable).** My recommendation is to
   **defer to T-041**, to avoid two more S-6-shaped dead vars behind an unanswered Q10. Say the
   word and they go in slice 3 with the epic's defaults.
3. **D4 — promoting `telemetry:events` to a shared constant (overrulable).** My recommendation is
   **not now** — second copy, not third, and it would put a shared package in the blast radius.

Settled without asking, recorded here as decisions rather than questions: `PORT` default
`3000`→`3003` (§3.2, nothing reads `env.PORT`); `STREAM_MAX_LEN` excluded (§3.3, write-side only);
defaults live in `WORKER_STREAM_CONSTANTS` (D3, existing convention); Q10 does not gate T-037
(§0).
