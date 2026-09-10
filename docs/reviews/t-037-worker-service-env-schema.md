# Review — T-037 Worker Service Env Schema (Gate 4, pre-QA)

**Verdict**: `CONDITIONAL`
**Base**: `9315493` · **Reviewer**: Senior Reviewer (read-only) · **Date**: 2026-09-10
**Plan**: `docs/plans/t-037-worker-service-env-schema.md`

Diff under review (`.claude/agents/epic-router.md` excluded as pre-existing and unrelated, per
the task brief):

```
 M apps/worker-service/.env.example
 M apps/worker-service/src/app.ts
 M apps/worker-service/src/config/env.ts
 M apps/worker-service/src/constants.ts
?? apps/worker-service/tests/env.schema.unit.test.ts
?? docs/plans/t-037-worker-service-env-schema.md
```

Tenant isolation: **no findings** — this change touches no repository, no query, no middleware
ordering, and no connection string. Injection: **no findings** — no SQL added.

---

## Findings

### HIGH

#### H-1 · `apps/worker-service/src/constants.ts:35-36` — AC1b is anchored to a producer symbol the producer does not use, and the comment asserting otherwise is false

The comment states that `STREAM_CONSTANTS.DEFAULT_STREAM_NAME` "is the name the producer passes
to `XADD`". It is not. `apps/usage-service/src/events/stream.publisher.ts:35-36` resolves:

```ts
this.streamName = env.REDIS_STREAM_NAME || STREAM_CONSTANTS.DEFAULT_STREAM_NAME;
```

and `apps/usage-service/src/config/env.ts:17` is
`REDIS_STREAM_NAME: z.string().default("telemetry:events")` — a **separate literal**, with a
default that always applies. `env.REDIS_STREAM_NAME` is therefore never falsy in practice and
`STREAM_CONSTANTS.DEFAULT_STREAM_NAME` is an unreachable fallback on the producer side.

Verified by mutation, not by reading. I changed `apps/usage-service/src/config/env.ts:17` to
`"telemetry:events-v2"` — the drift scenario the plan names as risk R1 (HIGH) — and ran worker's
suite:

```
=== worker env-schema test with producer's REAL default drifted ===
      Tests  26 passed (26)
```

Worker stays green while the producer would `XADD` to a different stream. The only test that
fires is inside usage-service's own package:

```
× usage service env schema > redis stream configuration > loads REDIS_STREAM_NAME with default 'telemetry:events'
  → expected 'telemetry:events-v2' to be 'telemetry:events'
```

An engineer changing the producer's stream name edits that literal, sees usage-service's own
test go red, updates it — and worker's cross-service link never fires. That is precisely the
silent-no-op the plan's §1 and R1 exist to prevent.

The helper itself is sound (see "What I verified"): it is not vacuous, and both the constant
drift and the export rename go red. It is pointed at the wrong symbol.

**Concrete fix** — make AC1b compare *resolved defaults*, not constants. In
`apps/worker-service/tests/env.schema.unit.test.ts:24-41`, load usage-service's `EnvSchema`
instead of its constants module and parse a minimal env:

```ts
const PRODUCER_ENV_MODULE = "../../usage-service/src/config/env";

const loadProducerStreamName = async (): Promise<string> => {
  const producer = (await import(PRODUCER_ENV_MODULE)) as {
    EnvSchema?: { parse?: (input: unknown) => { REDIS_STREAM_NAME?: unknown } };
  };
  const parsed = producer.EnvSchema?.parse?.(buildBaseEnv());
  const producerStreamName = parsed?.REDIS_STREAM_NAME;

  if (typeof producerStreamName !== "string") {
    throw new Error(/* existing message, naming EnvSchema.REDIS_STREAM_NAME */);
  }

  return producerStreamName;
};
```

`buildBaseEnv()` already supplies every field usage-service's schema requires (`NODE_ENV`,
`DATABASE_URL`, `REDIS_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `INTERNAL_API_SECRET` ≥ 32) — I
confirmed the field lists match. Keep AC1's literal assertion as-is.

Then correct `constants.ts:35-36` to say the producer resolves `env.REDIS_STREAM_NAME`, whose
default is at `apps/usage-service/src/config/env.ts:17`.

If the fix is declined, this must be recorded in `.claude/rules/known-gaps.md` rather than left
in a comment that says the opposite — T-038/T-039 will read that comment.

---

### MEDIUM

#### M-1 · `apps/worker-service/src/constants.ts:41-42` — "this is the second copy" is false; it is the third, and the promotion threshold is met

The comment justifies D4 with: *"There is no shared constant yet: this is the second copy, and
`.claude/rules/constants.md` asks for promotion before the third."*

`grep -rn '"telemetry:events"'`, excluding `node_modules` and `dist`:

```
apps/usage-service/src/constants.ts:111       (pre-existing, src)
apps/usage-service/src/config/env.ts:17       (pre-existing, src)
apps/worker-service/src/constants.ts:49       (this change, src)      <- third src copy
apps/usage-service/tests/stream.publisher.unit.test.ts:35
apps/usage-service/tests/env.schema.unit.test.ts:25
apps/worker-service/tests/env.schema.unit.test.ts:88                  (this change)
.env.example:21
apps/worker-service/.env.example:29                                   (this change)
```

Two copies already existed in `src/` before this change. Worker's is the third, so
`.claude/rules/constants.md`'s "before adding a third copy of a literal, promote it" fires now,
not later. The same miscount appears in the plan at `docs/plans/t-037-worker-service-env-schema.md:135-138`.

**Concrete fix** — correct the comment to "this is the third copy; promotion to a shared
constant is now due (see D4)" and either promote or record the deferral in
`.claude/rules/known-gaps.md`. I am not disputing D4 as a decision (approved at Gate 2, and it
was honoured); I am flagging that the fact it rests on is wrong, so the next reader will
re-derive the wrong conclusion.

#### M-2 · `apps/worker-service/src/app.ts:38-39` — the "reachable only through an explicitly-passed blank option" universal is false

```ts
// Now reachable only through an explicitly-passed blank `internalApiSecret` option: the
// `env.INTERNAL_API_SECRET` path fails earlier, in `parseEnv` at module load.
if (!internalApiSecret.trim()) {
```

`.min(32)` measures raw length; it does not trim. A 32-space `INTERNAL_API_SECRET` parses
successfully and then trims to empty, so `InternalApiSecretMissingError` **is** reachable from
the env path. Verified with a throwaway probe test against the real `EnvSchema` (removed
afterwards):

```
PROBE parse success: true
PROBE trimmed empty: true
```

This is exactly the class the brief calls out: an untested universal ("only …") next to
security-relevant code, established by probes that varied length but not content.

**Concrete fix** — either make the claim true at `apps/worker-service/src/config/env.ts:20`:

```ts
INTERNAL_API_SECRET: z.string().trim().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH),
```

(this diverges from `apps/usage-service/src/config/env.ts:15`, which has the same untrimmed
shape — note it as a follow-up for usage-service rather than silently forking), or reword the
comment to "reachable through an explicitly-passed blank option, or an all-whitespace
`INTERNAL_API_SECRET` that satisfies the length minimum". Add the whitespace case to the AC10
group either way.

#### M-3 · `docs/reviewer-checklist.md:34` — the compliance table is now false for worker-service and was not updated

The row reads:

| worker-service | as billing-service (S-8) | **partly — `process.env` + `.trim()`, no minimum length (S-8)** | no (S-8) |

After this change worker's `EnvSchema` enforces the 32-character minimum at module load, before
`createContainer`. The middle column is false. The file's own text three lines above says
*"keep this table honest; the open items are in `.claude/rules/known-gaps.md`"*, and `CLAUDE.md`
lists this file in the authoritative Standards Reference table.

**Concrete fix** — `docs/reviewer-checklist.md:34`, change the "Fails fast on missing secret"
cell for worker-service to `yes (env schema, T-037)`; leave the guard and timing-safe columns
citing S-8.

#### M-4 · `apps/worker-service/.env.example:30,34,36` — operator-facing prose describes consumer behaviour that does not exist

```
# Consumer group created by the worker on startup. One group per logical consumer fleet.
# How long a single XREADGROUP call blocks waiting for entries, in milliseconds.
# XREADGROUP COUNT - entries claimed per iteration.
```

No worker code issues `XGROUP CREATE` or `XREADGROUP` today — `grep -rn` for the five new vars
across `apps/*/src` and `packages/*/src` returns only their own declarations in
`apps/worker-service/src/config/env.ts:24-37`. I also confirmed live:
`xinfo groups telemetry:events` returns empty. An operator who reads this file today and sets
`REDIS_CONSUMER_GROUP` gets no group and no warning — the operator-visible half of S-6.

**Concrete fix** — add one line under the `## Redis Streams (consumer side)` heading at
`apps/worker-service/.env.example:25`:

```
# Declared by T-037. No code reads these yet -- the consumer lands in T-038 (XGROUP CREATE)
# and T-039 (XREADGROUP). Setting them today has no effect.
```

and switch the three comments to the future tense.

---

### LOW

#### L-1 · `apps/worker-service/src/config/env.ts:21-23` — present tense for unwritten code

"Read by T-038's `XGROUP CREATE` and T-039's `XREADGROUP`" reads as a statement of fact about
existing readers. Grep-verified: nothing reads any of the five. Same fix shape as M-4 — "Will be
read by …". Disposition: accept the deferral (the plan justifies it, and the readers are one and
two tasks away); fix the tense.

#### L-2 · `apps/worker-service/src/config/env.ts:24-26` — the three `.min(1)` guards are untested

I removed `.min(1)` from `REDIS_STREAM_NAME`, `REDIS_CONSUMER_GROUP` and `REDIS_CONSUMER_NAME`
simultaneously and the suite stayed **26/26 green**. This is implemented logic with no test
(`.claude/rules/testing.md`). It matters most for `REDIS_STREAM_NAME`: worker has no `||`
fallback the way `stream.publisher.ts:36` does, so a blank value would reach `XREADGROUP` as an
empty key name in T-039.

**Concrete fix** — add to the `redis stream configuration` describe:

```ts
it("rejects a blank REDIS_STREAM_NAME, consumer group or consumer name", () => {
  expectIssueOn(EnvSchema.safeParse({ ...buildBaseEnv(), REDIS_STREAM_NAME: "" }), "REDIS_STREAM_NAME");
  expectIssueOn(EnvSchema.safeParse({ ...buildBaseEnv(), REDIS_CONSUMER_GROUP: "" }), "REDIS_CONSUMER_GROUP");
  expectIssueOn(EnvSchema.safeParse({ ...buildBaseEnv(), REDIS_CONSUMER_NAME: "" }), "REDIS_CONSUMER_NAME");
});
```

#### L-3 · `apps/worker-service/src/middleware/internal-auth.middleware.ts:10` — literal `401` is now a live constants-gate violation

`.claude/rules/constants.md` applies to middleware and says a literal is a finding "when the
constant is already importable". Before this change it was not importable; `constants.ts:23`
now makes `WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED` available. The change created the
violation it declines to fix, and `constants.ts:20-21` says so explicitly.

Disposition: **accept as deliberate** — the file is S-8's and touching it here would fork the
middleware a third way, which is the S-14/S-19 failure mode the plan cites. But it should be
named in the S-8 fix direction rather than only in a worker code comment. Same shape for
`apps/worker-service/tests/smoke.test.ts:13,30` (literal `200`, pre-existing file, untouched).

#### L-4 · `apps/worker-service/src/constants.ts:22-23` — `401` is now the third service-local status-code definition

`apps/auth-service/src/constants.ts:32` (`UNAUTHORIZED: 401`), usage-service's
`HTTP_STATUS_UNAUTHORIZED`, and now worker's. `grep -rn "HTTP_STATUS" packages/*/src` returns
nothing — there is no shared map. constants.md's third-copy rule fires here too.

Disposition: out of scope for T-037. **Recommend adding to `.claude/rules/known-gaps.md`**: an
`HTTP_STATUS` map belongs in `@telemetry/shared-types` next to `INTERNAL_AUTH_CONSTANTS`.

#### L-5 · `docs/plans/t-037-worker-service-env-schema.md:143-144` — quoted command output does not reproduce

The plan quotes:

```
$ grep -rn "env\.PORT" apps/*/src
(no matches)
```

Run verbatim at the current tree it returns **8** lines (6 at base — every service's
`process.env.PORT ?? …`, which the pattern matches, plus the 2 new comment lines). The
*conclusion* is correct and I verified it independently: every `.PORT` access in the repo is
`process.env.PORT`; no module imports `env` from `config/env` and reads `.PORT`. So the `PORT`
default change is genuinely behaviour-neutral, and the env.ts:9-11 comment stating that is
**true**. Only the quoted evidence is wrong.

**Concrete fix** — replace with a pattern that actually shows it, e.g.
`grep -rn "[^.]\benv\.PORT" apps/*/src` (no matches), and re-quote its real output. The plan
ships in the commit; a fabricated-looking transcript in it undermines the parts that are right.

#### L-6 · `.env.example:21-22` (repo root) — not extended with the four new worker-only vars

The root example documents `REDIS_STREAM_NAME` and `STREAM_MAX_LEN` but not
`REDIS_CONSUMER_GROUP`, `REDIS_CONSUMER_NAME`, `STREAM_BLOCK_MS`, `STREAM_BATCH_SIZE`. Worth
noting for R2: `docker/docker-compose.yml`'s `x-common-app-env` anchor (lines 1-8) does **not**
set `REDIS_STREAM_NAME`, so there is no shared path that keeps producer and consumer in step in
the container stack either. Disposition: low, and arguably correct to keep worker-only vars in
worker's file.

#### L-7 · `apps/worker-service/dist/tests/env.schema.unit.test.js` — emitted output contains a dynamic import that cannot resolve

`apps/worker-service/tsconfig.json:11` includes `tests/**/*.ts` with `rootDir: "."`, so `build`
emits test files into `dist/tests/`. From there `../../usage-service/src/constants` resolves to
`apps/worker-service/dist/usage-service/src/constants`, which does not exist. Nothing executes
it, and emitting tests into `dist` is pre-existing (all four prior test files are there too), so
this is inert — but T-037 is the first file to make it *wrong* rather than merely wasteful.
Disposition: out of scope. **Recommend a known-gaps entry** for a `tsconfig.build.json` that
excludes `tests/**`.

---

### NIT

- **N-1** · `apps/worker-service/tests/env.schema.unit.test.ts:45` duplicates the `DATABASE_URL`
  string literal from `apps/worker-service/tests/setup.ts:6-7`. Harmless (the fixture is
  deliberately self-contained so `safeParse` cases do not depend on ambient env), but a shared
  test constant would remove the copy.
- **N-2** · `apps/worker-service/src/app.ts:21` `createContainer(WORKER_SERVICE_NAME, env as ServiceEnv)`
  is an unchecked cast that now strips the `Readonly` `parseEnv` returns. Pre-existing line,
  unchanged by this diff (`git diff` shows it outside both hunks). Not counted against T-037.
- **N-3** · `apps/worker-service/src/constants.ts:44-45` says `BATCH_SIZE_MAX` mirrors
  usage-service's `INGEST_BATCH_MAX` bound. Accurate (`apps/usage-service/src/config/env.ts:19`
  is `.min(1).max(100)`), but `INGEST_BATCH_MAX` is itself S-6 dead config; the cap usage-service
  actually enforces is `INGESTION_CONSTANTS.BATCH_SIZE_MAX` at
  `apps/usage-service/src/validators/events.validator.ts:6` — same value. Citing the enforced one
  would age better.

---

## Assessment of the four declared deviations

| Deviation | Judgement |
|---|---|
| Third AC8 case (`OTEL_EXPORTER_OTLP_ENDPOINT`) | **Accept.** Purely additive, same shape as the other two, and it was one of the three that passed at slice 2 — correctly labelled a regression guard rather than counted as red. |
| `HTTP_STATUS_OK` / `HTTP_STATUS_UNAUTHORIZED` in `WORKER_RESPONSES` rather than a test-local object | **Accept.** `.claude/rules/constants.md` applies to tests and mirrors `USAGE_SERVICE_RESPONSES`. Consequences are L-3 and L-4, both of which the implementer named. A test-local object would have been the wrong call — it would have created a fourth copy in a file constants.md explicitly governs. |
| Dynamic import in AC1b to keep usage-service out of worker's `rootDir` | **Accept the mechanism, reject the target** — see H-1. The mechanism is sound and I proved it non-vacuous in both failure modes. `tsc -p tsconfig.json` does not resolve non-literal specifiers, so the stated `rootDir` motivation is real, and `build`/`typecheck`/`lint` are all clean. |
| `known-gaps.md` deliberately not edited | **Accept** — this was your instruction, not the implementer's choice, and it is disclosed at plan §10. See "S-8 rewording" below for what must land when it is edited. |

---

## Compile-time gate — run with `--force`, actual output

All four run from repo root with `--force`, so nothing was replayed from turbo cache
(`Cached: 0 cached, 13 total` on every one).

| Task | Result |
|---|---|
| `pnpm typecheck --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` · 12.138s |
| `pnpm lint --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` · 0 errors, **14 warnings, all pre-existing** |
| `pnpm build --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` · 18.412s |
| `pnpm test --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` |

Per-package test counts (12 packages emit a vitest summary; `@telemetry/web` has no suite):

```
shared-tracing      1 file  /   2 tests
shared-types        1 file  /   7 tests
shared-validation   1 file  /  15 tests
shared-config       1 file  /   4 tests
shared-logger       1 file  /   4 tests
shared-utils        1 file  /  18 tests
billing-service     4 files /  18 tests
analytics-service   4 files /  18 tests
worker-service      5 files /  45 tests   <- was 4 / 19; +1 file, +26 tests
gateway             8 files /  38 tests
usage-service      19 files / 230 tests   <- unchanged
auth-service       15 files / 164 tests
```

Worker at 5/45 and usage-service at 19/230 match the expected figures exactly.

### Lint warnings — proven pre-existing

14 warnings, in exactly two files, neither in this diff:

```
apps/auth-service/tests/auth.service.unit.test.ts        10 warnings (no-misused-promises)
apps/usage-service/tests/ingestion.service.unit.test.ts   4 warnings (no-unsafe-assignment)

$ git log -1 --format="%h %ad %s" --date=short -- apps/auth-service/tests/auth.service.unit.test.ts
d68e719 2026-08-25 test(services): expand coverage for singleton, container, and shutdown flows
$ git log -1 --format="%h %ad %s" --date=short -- apps/usage-service/tests/ingestion.service.unit.test.ts
b0f6921 2026-08-31 fix(security): close tenant-isolation gaps S-1 through S-4
```

Both commits predate base `9315493`. `git diff --name-only` and `git ls-files --others
--exclude-standard` confirm neither file is touched. `@telemetry/worker-service:lint` produced
zero output — clean. **No new warnings introduced.**

### `format:check` — the 261 → 263 delta, spot-checked rather than accepted

```
$ pnpm format:check
[warn] Code style issues found in 263 files.
```

The implementer attributed the +2 to the two new files. I verified both halves:

- The two untracked additions are both flagged:
  `apps/worker-service/tests/env.schema.unit.test.ts`,
  `docs/plans/t-037-worker-service-env-schema.md`.
- The three modified `src` files were **already** flagged at `HEAD`. I extracted the `HEAD`
  blobs to a scratch directory and ran prettier on those copies:
  `[warn] head/…/app.ts`, `[warn] head/…/constants.ts`, `[warn] head/…/config/env.ts` —
  `Code style issues found in 3 files.`

So the change adds exactly 2 to the count and reformats nothing. S-12 remains the standing
failure; correctly excluded from the gate and not a T-037 regression.

---

## What I verified by execution

**Test honesty — the AC1b helper is not vacuous.** Three mutations, each reverted, each with the
tree checksum re-confirmed afterwards:

1. Producer constant drift — `apps/usage-service/src/constants.ts:111` → `"telemetry:events-MUTATED"`:
   ```
   × … defaults REDIS_STREAM_NAME to the same stream usage-service's producer constant names
     → expected 'telemetry:events' to be 'telemetry:events-MUTATED'
     Tests  1 failed | 25 passed (26)
   ```
2. Producer export renamed — `STREAM_CONSTANTS` → `STREAM_CONSTANTS_RENAMED`: the guard throws
   rather than passing vacuously:
   ```
   Error: Could not read STREAM_CONSTANTS.DEFAULT_STREAM_NAME from "../../usage-service/src/constants". …
     Tests  1 failed | 25 passed (26)
   ```
3. Consumer drift — `apps/worker-service/src/constants.ts:49` → `"telemetry:events-CONSUMER-DRIFT"`:
   both AC1 and AC1b go red (`Tests  2 failed | 24 passed`).

The helper cannot silently resolve to `undefined`. **But see H-1**: the one mutation that
matters most in production — the producer's *runtime* default at
`apps/usage-service/src/config/env.ts:17` — leaves it 26/26 green.

**Red-first honesty — the 23/3 claim reproduces exactly.** I restored `src/config/env.ts` and
`src/app.ts` to their `HEAD` blobs while leaving `constants.ts` at its post-slice-1 state (the
implementer's slice ordering) and ran the new file:

```
⎯⎯⎯⎯⎯⎯ Failed Tests 23 ⎯⎯⎯⎯⎯⎯⎯
      Tests  23 failed | 3 passed (26)
```

The 3 passing are exactly the AC8 missing-var guards on pre-existing fields, as labelled. They
were correctly reported as regression guards rather than counted as red.

**AC12 is load-bearing — the specific claim reproduces verbatim.** I reverted only the slice-5
edit (`app.ts:27` back to `options.internalApiSecret ?? process.env.INTERNAL_API_SECRET ?? ""`),
leaving the schema change in place, and ran the full worker suite:

```
× worker-service env schema > app.ts reads the parsed secret, not process.env >
  authenticates with the parsed secret after process.env.INTERNAL_API_SECRET is mutated
  → expected 401 to be 200
 Test Files  1 failed | 4 passed (5)
      Tests  1 failed | 44 passed (45)
```

44/1, and the assertion message is the one claimed. The declaration is not S-6-shaped dead
config: it is read, and a test proves the read.

**Five further mutations on the schema, each isolated, each red:**

| Mutation | Test that caught it |
|---|---|
| `STREAM_BATCH_SIZE` without `.int()` | `rejects a fractional STREAM_BATCH_SIZE` |
| `STREAM_BATCH_SIZE` without `.max(...)` | `rejects a STREAM_BATCH_SIZE outside the configured bounds` |
| `PORT` default back to `3000` | `defaults PORT to the port index.ts binds` |
| `INTERNAL_API_SECRET` `.min(32)` → `.min(1)` | `rejects an INTERNAL_API_SECRET one character below the shared minimum` |
| `STREAM_BLOCK_MS` without `.positive()` | `rejects a STREAM_BLOCK_MS of zero or below` |

Each `1 failed | 25 passed`. One mutation was **not** caught — see L-2.

**Claims the change makes.**

| Claim | Location | Verdict |
|---|---|---|
| `XREADGROUP COUNT` accepts values above 100; the 100 ceiling is policy, not protocol | `constants.ts:44-46`, `.env.example:36-37` | **TRUE, executed.** Seeded a scratch stream with 250 entries and ran `XREADGROUP … COUNT 1000` → 250 entries returned. Scratch key deleted. Wording matches the requirement: it says "operational ceiling … NOT a Redis protocol limit". |
| `redis-cli --scan --pattern 'telemetry*'` returns exactly `telemetry:events`; `xinfo groups` returns nothing | `constants.ts:37-39` | **TRUE, re-run.** `telemetry:events`, type `stream`, `xlen 2`, `xinfo groups` empty. |
| Nothing reads the parsed `env.PORT`; the default change is behaviour-neutral | `env.ts:9-11` | **TRUE.** All six services read `process.env.PORT` directly (`*/src/index.ts`); no module imports `env` and reads `.PORT`. (The plan's *quoted evidence* for this is wrong — L-5.) |
| `parseEnv` throws at module load, so the service never reaches `app.listen` | `env.ts:17-19` | **TRUE.** AC11 proves the throw; `src/index.ts:24-27` calls `loadLocalEnv()` *before* `await import("./app")`, so a local `.env` is honoured and the throw lands in the `start().catch` → `process.exit(1)`. |
| The option override still wins and is deliberately not length-checked | `app.ts:25-26` | **TRUE**, and pinned by two tests. Bounded: `buildWorkerServiceApp` is called with no options in production (`src/index.ts:27`); the only override call sites are `tests/smoke.test.ts:18` and the new test. |
| `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` is enforced before the DI container is built | `env.ts:19` | **TRUE.** `env.ts:42` runs at import of `./config/env`, which `app.ts:3` imports statically, before `createContainer` at `app.ts:21`. |
| "Now reachable only through an explicitly-passed blank option" | `app.ts:38-39` | **FALSE** — M-2. |
| "which is the name the producer passes to `XADD`" | `constants.ts:35-36` | **FALSE** — H-1. |
| "this is the second copy" | `constants.ts:41-42` | **FALSE** — M-1. |
| `.env.example`: consumer group "created by the worker on startup" | `.env.example:30` | **FALSE today** — M-4. |
| `.env.example`: "REDIS_STREAM_NAME must match usage-service's REDIS_STREAM_NAME" | `.env.example:26-28` | **TRUE**, and notably the *only* place in the change that names the correct coupling. |

**Blast radius of making `INTERNAL_API_SECRET` required — all four supply points re-measured:**

```
45  ci-internal-api-secret-with-at-least-32-chars   docker/docker-compose.yml:93,112,149,172 · .github/workflows/ci.yml:34
37  dev-local-secret-change-in-production           apps/worker-service/.env.example:23
45  test-internal-api-secret-change-in-production   apps/worker-service/tests/setup.ts:12
43  dev-local-internal-secret-at-least-32-chars     .env.example:18 (root)
11  test-secret                                     apps/worker-service/tests/smoke.test.ts:18 (option override, not env)
```

All env-supplied values clear 32. `docker/docker-compose.yml` and `.github/workflows/ci.yml` are
the only deployment surfaces in the repo (no k8s/helm). No fixture needs a new value — hypothesis
H held.

**Structural / clean-code checks that came back clean:** no `any` in the new code; the dynamic
import is narrowed through an optional-property type, not a cast to `any`; `expectIssueOn` and
`buildEnvWithout` both **throw** rather than passing vacuously (the `if (parsed.success) return`
is unreachable because the preceding `expect` throws first — confirmed empirically by the
mutations above, not just by reading); no `beforeAll`-style cross-test coupling; both AC12 tests
guard against tautology with an explicit `not.toBe` on the value they are distinguishing;
`startup.constants.ts` remains side-effect-free and the tracing-first ordering in `index.ts` is
untouched; the new `constants.ts` → `@telemetry/shared-types` import chain adds nothing heavy
that `env.ts` did not already pull.

---

## What I could not verify, and why

1. **That `STREAM_BLOCK_MS=5000` and `STREAM_BATCH_SIZE=10` are the right operational values.**
   No consumer exists to measure and no throughput data lives in the repo. The plan states this
   honestly at §9; I am repeating it rather than resolving it.
2. **That T-038/T-039 will actually read the five stream vars.** This is the load-bearing claim
   behind rejecting the S-6 comparison, and it is a statement about unwritten code. It cannot be
   verified now — only re-checked at T-039's review. Reasoning, not execution.
3. **Runtime behaviour under Docker Compose.** The stack is not running here — `docker ps` shows
   `postgres-db` with no host mapping, and the Postgres and Redis on `localhost` are host-installed,
   as the plan's §8 correctly records. `docker-compose up` with the new required var was not
   exercised; I verified the value's length statically instead.
4. **That AC12's app-build path touches no socket.** The comment at
   `env.schema.unit.test.ts:395-396` says the container's ioredis client is `lazyConnect`. The
   tests pass without Redis running for them, which is consistent, but I did not read
   `container.ts` to confirm the `lazyConnect` flag — inferred from the passing run.
5. **Nothing database- or RLS-related.** No queries in this change; `pg_roles` was not consulted
   because no connection role, migration, or policy is touched. Stated so the omission is not
   mistaken for a green.

---

## S-8 — does it need rewording once this lands? **Yes.**

The implementer's report is **correct**: item 2 becomes true of billing only. Confirmed:
`apps/worker-service/src/config/env.ts:20` declares the field with
`.min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)`, `env.ts:42` parses at module load, and
`app.ts:3` imports that module statically — so the minimum is enforced before `createContainer`
at `app.ts:21`, not after. `apps/billing-service/src/app.ts:23` and
`apps/billing-service/src/config/env.ts` are unchanged and still match item 2 exactly.

Three edits are needed in `.claude/rules/known-gaps.md` when it is next touched (I did not touch
it, per your instruction):

1. **Item 2** — drop `apps/worker-service/src/app.ts:23` from the sentence; it applies to
   billing-service only.
2. **Worker's line citations are now stale** — `app.ts:23` is now `app.ts:27`, and `app.ts:49`
   (the `preHandler` registration in item 3) is now `app.ts:55`.
   `apps/worker-service/src/middleware/internal-auth.middleware.ts:9` is still correct.
3. **Fix direction** — "move `INTERNAL_API_SECRET` into **both** services' `EnvSchema`" becomes
   billing only; the shared timing-safe helper and the `onRequest` promotion still apply to both.

Items 1 and 3 remain fully open for worker. `.claude/rules/tenant-isolation.md`'s note that
"only usage-service currently has the layer-2 guard in the strong form" stays accurate.

Also flagged above for known-gaps if not fixed here: **L-4** (no shared `HTTP_STATUS` map; third
copy reached) and **L-7** (`tests/**` emitted into `dist`).

---

## Verdict

`CONDITIONAL`

**Required before commit:**

- **H-1** — repoint AC1b at usage-service's `EnvSchema` default (or, if declined, correct
  `constants.ts:35-36` and record the residual gap in `.claude/rules/known-gaps.md`). This is the
  one guarantee T-037 exists to provide, and as written it does not cover the drift path an
  engineer would actually take.
- **M-1** — correct the "second copy" count in `constants.ts:41-42` and in the plan.
- **M-2** — correct or eliminate the "reachable only through" universal at `app.ts:38-39`.
- **M-3** — update `docs/reviewer-checklist.md:34`; the table declares itself honest and is not.

**Recommended in the same commit (cheap, and they close the S-6 comparison cleanly):** M-4, L-1,
L-2, L-5.

**Accepted as-is:** all four declared deviations (with the H-1 caveat on the third), D1's seam
between declaration and enforcement, D2's deferral, and D4's non-promotion as a *decision* —
D4's stated *reason* is what M-1 corrects. `PORT` 3000→3003 is behaviour-neutral and the comment
saying so is true.

**Remaining risks and dispositions:** R2 (stream-name drift between services) is reduced but not
closed by this change, and H-1 is the concrete instance of it — track it. R5 (declaring config
nobody reads) is live for five vars until T-039; disposition: accept, with M-4/L-1's tense fixes
so no operator is misled in the interim. The breaking change for operators running worker with a
sub-32-character `INTERNAL_API_SECRET` is intended and correct, but should be called out in the
commit message body — every supply point in the repo already clears the bar, so nothing here
breaks, but a downstream `.env` might.

CHANGES REQUESTED on H-1/M-1/M-2/M-3 → return to Gate 3.

---

# Round 2

**Verdict**: `CONDITIONAL` (wording-only; see "Loop discipline" below — I recommend the user
resolve these directly rather than opening a third implementer round)
**Base**: `9315493` · nothing committed · **Date**: 2026-09-10
**Reviewer**: Senior Reviewer (read-only). I did not write round 1 and did not write this code.

The change grew: D4 was reversed, so this round covers a **shared-package change touching two
services** (`packages/shared-types`, `apps/usage-service`, `apps/worker-service`) plus two
authoritative-doc edits, not just worker's env schema.

Diff under review (`.claude/agents/epic-router.md` still excluded — I re-checked its diff and it
contains no T-037 content; it must not be swept into this commit):

```
 M .claude/rules/known-gaps.md              M apps/worker-service/src/app.ts
 M apps/usage-service/src/config/env.ts     M apps/worker-service/src/config/env.ts
 M apps/usage-service/src/constants.ts      M apps/worker-service/src/constants.ts
 M apps/worker-service/.env.example         M docs/reviewer-checklist.md
 M packages/shared-types/src/index.ts       M packages/shared-types/tests/unit.test.ts
?? apps/worker-service/tests/env.schema.unit.test.ts
?? docs/plans/t-037-worker-service-env-schema.md
```

**Round 1's four required findings are all fixed, and I mutation-proved each fix rather than
reading it.** H-1: the promotion reaches `apps/usage-service/src/config/env.ts:21`, the value
that actually decides the producer's `XADD` key, and mutating the shared constant now turns
usage-service's `EnvSchema` test red. M-1: one literal left in `apps/*/src` + `packages/*/src`.
M-2: `.trim()` before `.min()`; the whitespace secret is a parse failure and the guard has a
test. M-3: `docs/reviewer-checklist.md:31` is now accurate.

Tenant isolation: **no findings** — no repository, query, middleware ordering, connection string
or migration is touched. `pg_roles` was not consulted, deliberately; stated so the omission is
not read as a green. Injection: **no findings** — no SQL added.

Everything below is a claim the change makes about itself. There is no code defect in round 2.

---

## Findings

### MEDIUM

#### M-5 · "producer and consumer cannot drift in code" / "unrepresentable in code" is false — three locations

- `packages/shared-types/src/index.ts:105-107` — *"Deriving both sides from one constant is what
  makes that disagreement unrepresentable in code"*
- `apps/usage-service/src/constants.ts:112-113` — *"Single-sourced from `@telemetry/shared-types`
  so producer and consumer cannot drift in code"*
- `apps/worker-service/.env.example:31-33` — *"The two defaults are now one constant … so they
  cannot drift in code"*

This is the load-bearing justification for reversing D4, and it is a universal, so I tried to
refute it by execution rather than reading it. **I managed it in two file edits, and the whole
13-package gate stayed green.**

```
# apps/usage-service/src/config/env.ts:21 — replace the shared reference with a literal
- REDIS_STREAM_NAME: z.string().default(EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM),
+ REDIS_STREAM_NAME: z.string().default("telemetry:events-v2"),
# apps/usage-service/tests/env.schema.unit.test.ts:25 — what the engineer does next
- expect(parsed.data.REDIS_STREAM_NAME).toBe("telemetry:events");
+ expect(parsed.data.REDIS_STREAM_NAME).toBe("telemetry:events-v2");
```

```
usage-service   Test Files  19 passed (19)   Tests  230 passed (230)
worker-service  Test Files   5 passed (5)    Tests   49 passed (49)
shared-types    Test Files   1 passed (1)    Tests    8 passed (8)
```

The producer now `XADD`s to `telemetry:events-v2`, worker still defaults to `telemetry:events`,
and nothing fails. The divergence is **narrower and more visible**, not unrepresentable.

What the promotion *does* buy, measured:

| Edit | What fires |
|---|---|
| shared constant → `telemetry:events-MUTATED` | shared-types 1/8 red, usage-service `EnvSchema` test red (`env.schema.unit.test.ts:25`), worker AC1 red — **three packages** |
| shared constant moves, worker re-pinned to the literal | worker AC1b red (AC1 green), shared-types red, `@telemetry/worker-service:lint` → `'EVENT_STREAM_CONSTANTS' is defined but never used` (1 error) |
| producer re-pinned to a literal (above) | **nothing** — but the diff costs a magic string (a `.claude/rules/constants.md` violation), an `@typescript-eslint/no-unused-vars` **error** in `apps/usage-service/src/config/env.ts:2` until the import is deleted, and an edit to usage-service's own literal test |

So the guarantee is "a rename made *at the constant* moves all three sites together and fails
three suites; re-pinning any one site to a literal still diverges, and is caught by review and
lint rather than by a test."

I also tried a third route — divergence inside the publisher rather than in config
(`stream.publisher.ts:36` → `(env.REDIS_STREAM_NAME || …) + "-v2"`). That **is** caught, by
T-036's work, not T-037's: `tests/usage.integration.test.ts` A1/A2/A9 go red (3 failed | 28
passed). Worth knowing which guard is actually load-bearing there.

**Concrete fix** — in all three places, replace "cannot drift in code" / "unrepresentable in
code" with the measured statement, e.g. at `packages/shared-types/src/index.ts:105-107`:

```
 * Deriving all three sites from one constant means a rename made here fails shared-types',
 * usage-service's and worker-service's suites together. It does not make divergence
 * impossible: re-pinning any one site to a literal still diverges silently, and is caught by
 * the constants gate and an unused-import lint error rather than by a test.
```

Disposition: **fix the wording.** This is the same class as round 1's H-1 — a guarantee that
looks structural and is not — and a reader of `shared-types/src/index.ts` who believes
"unrepresentable" will not add a test when they change the producer.

#### M-6 · `apps/worker-service/src/config/env.ts:23-28` — "an untrimmed expectation could not have matched a padded secret on the wire in the first place" is false

The comment reports five probe forms (leading spaces, trailing spaces, both, surrounding tabs,
raw socket vs `fetch`). I reproduced all five and they are **correct** — SP and HTAB are stripped
by the HTTP parser, `app.inject` does not strip. But the probes varied one dimension (how much
SP/HTAB) and the conclusion is a universal about *all* padding. The variation that refutes it is
padding with whitespace that `String.prototype.trim()` removes but HTTP OWS does not.

Executed, against a real `node:http` server:

```
{"case":"surrounding VT (\\v)","status":"HTTP/1.1 400 Bad Request"}      <- supports the claim
{"case":"surrounding FF (\\f)","status":"HTTP/1.1 400 Bad Request"}      <- supports the claim
{"case":"raw latin1 0xA0 padding","status":"HTTP/1.1 200 OK",
 "matchesUntrimmedEnvExpectation":true,"matchesTrimmedExpectation":false}
{"case":"node http.request, U+00A0 padded",
 "matchesUntrimmedEnvExpectation":true,"matchesTrimmedExpectation":false}
```

A `U+00A0`-padded `INTERNAL_API_SECRET` survives the wire byte-identical, including when sent by
Node's own `http.request` — which is what a service-to-service caller uses. So before the trim
an untrimmed expectation **did** match a padded secret on the wire, and after the trim it no
longer does. The trim narrows what the middleware accepts; it does not merely formalise what the
wire already did.

Practically this is negligible and **fail-closed** (mismatch → 401, never a false accept), and
`.trim()` is still the right call — it is what closes M-2. Only the justifying sentence is wrong.

**Concrete fix** — `apps/worker-service/src/config/env.ts:23-28`, scope the claim:

```
// Probed against a real Fastify server on a socket: values padded with spaces or tabs arrive
// stripped (SP and HTAB are the only OWS the HTTP parser removes; VT and FF are rejected as
// 400). Other characters String.trim() removes -- U+00A0 in particular -- survive the wire
// intact, so the trim does narrow what the middleware will accept. Fail-closed either way.
// (`app.inject` does *not* strip; it bypasses the HTTP parser. …)
```

Disposition: **fix the wording.** Same class as round 1's M-2, on the same comment block: a
universal established by probes that varied only one dimension.

---

### LOW

#### L-8 · `.claude/rules/known-gaps.md:44-46` — "both … differ from usage-service's in three ways" is no longer true of worker

Worker now differs in two ways. Item 2's own heading says "billing-service only" two lines later,
so a careful reader is not misled — which is why this is LOW and not HIGH — but the count in the
framing sentence is now wrong in a file other agents are told to trust.

**Fix** — `known-gaps.md:45`: "…differ from `apps/usage-service/src/middleware/internal-auth.middleware.ts`
in three ways (item 2 now applies to billing-service only)".

#### L-9 · `.claude/rules/known-gaps.md:63-64` — the fix direction prescribes for billing the exact hole M-2 just closed in worker

> **Fix direction:** move `INTERNAL_API_SECRET` into billing-service's `EnvSchema` with
> `.min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)` (worker-service already has it) …

Worker has `.trim().min(…)`. Following this fix direction literally gives billing `.min(32)`
alone, under which a 32-space secret parses cleanly — round 1's M-2, reproduced in a second
service, prescribed by the rules file.

**Fix** — `known-gaps.md:63`: `.trim().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)`, matching
what worker actually has.

#### L-10 · the trim fork is real and is recorded nowhere

Round 1's M-2 said to add `.trim()` "note it as a follow-up for usage-service rather than
silently forking". The fork happened and was not recorded:

```
apps/worker-service/src/config/env.ts:30   z.string().trim().min(SECRET_MIN_LENGTH)
apps/usage-service/src/config/env.ts:15    z.string().min(SECRET_MIN_LENGTH)
apps/gateway/src/config/env.ts:14          z.string().min(SECRET_MIN_LENGTH)
```

`grep -n trim .claude/rules/known-gaps.md` returns only the two S-8 lines about worker; nothing
records that two other services keep the untrimmed shape. Concretely, for usage-service: a
32-space `INTERNAL_API_SECRET` parses, `apps/usage-service/src/app.ts:27` passes it straight to
`registerUsageInternalAuthMiddleware` with no blank guard, and the wire strips a 32-space header
to `""` (probed) — so the service starts healthy and 401s every internal call.

**Recommend a `.claude/rules/known-gaps.md` entry** (out of scope to fix here — changing
gateway's and usage-service's startup contracts inside a worker task is the same one-task rule
S-8 itself cites): *"`INTERNAL_API_SECRET` is `.trim()`ed only in worker-service (T-037).
gateway and usage-service measure `.min(32)` on the raw value, so an all-whitespace secret starts
cleanly and then can never match, because the HTTP parser strips SP/HTAB from the inbound
header."*

#### L-11 · L-3 was declined, and has now evaporated

The decline itself is **correct** — the user's authorisation scoped the S-8 edit to three
changes, and adding a fourth item is restructuring an authoritative file outside that scope.
But round 1 asked for the literal `401` to be *named* somewhere, and it now appears only in a
worker code comment (`apps/worker-service/src/constants.ts:24-25`), which is exactly the
"recorded in a comment instead of the gaps file" outcome round 1 rejected for H-1.

Verified live: `apps/worker-service/src/middleware/internal-auth.middleware.ts:10` and
`apps/billing-service/src/middleware/internal-auth.middleware.ts:10` both write literal `401`,
and `WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED` (`constants.ts:27`) is referenced only from
`tests/env.schema.unit.test.ts:466,511` — never from `src/`.

**Recommend** adding one clause to S-8's fix direction when it is next edited: "…and adopt each
service's `HTTP_STATUS_UNAUTHORIZED` constant instead of the literal `401`."

#### L-12 · `docs/plans/t-037-worker-service-env-schema.md:385` — the plan's exclusion list contradicts its own Gate 4 table

Line 385 lists `apps/usage-service/**` under **Deliberately not modified**; lines 366-367 of the
same file list two `apps/usage-service/src` files as changed, and `packages/shared-types/**`
appears in neither list. The plan ships in the commit.

**Fix** — remove `apps/usage-service/**` from the exclusion list and add a line noting the D4
reversal extended scope to `packages/shared-types` and two usage-service `src` files.

---

### NIT

- **N-4** · `apps/usage-service/src/config/env.ts:18-19` — "because this default always applies
  the right-hand fallback is unreachable". Another universal, refuted by
  `REDIS_STREAM_NAME=""`: a present-but-empty value means `.default(...)` does *not* apply, `""`
  is falsy, and `stream.publisher.ts:36` **does** reach `STREAM_CONSTANTS.DEFAULT_STREAM_NAME`.
  Executed — see the symmetry table under judgement call (a). Harmless today, because both
  sides now resolve the same constant. Suggested: "…the fallback is unreachable for any
  non-empty value".
- **N-5** · `apps/worker-service/.env.example` is not parsed by prettier, so it is the one
  modified file absent from `format:check`'s list. Noted only so the 264 arithmetic below reads
  as 10 modified + 3 untracked, not 11 + 3.

---

## The five things you asked me to check

### 1 · Is the divergence unrepresentable, or only harder? — **only harder**

Mutating `EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM` to `"telemetry:events-MUTATED"` turns all
three red, including the one that matters:

```
shared-types    × exposes the usage-events stream key both services resolve to
                  Tests  1 failed | 7 passed (8)
usage-service   × loads REDIS_STREAM_NAME with default 'telemetry:events'   (env.schema.unit.test.ts:25)
                  → expected 'telemetry:events-MUTATED' to be 'telemetry:events'
                  Tests  1 failed | 13 passed (14)
worker-service  × defaults REDIS_STREAM_NAME to 'telemetry:events'          (env.schema.unit.test.ts:63)
                  Tests  1 failed | 29 passed (30)
```

usage-service's is the load-bearing one and it parses `EnvSchema`, so H-1 is genuinely closed.
I then made producer and consumer disagree **without** touching the shared constant — two edits,
whole gate green. See M-5 for the diff, the output, and how visible it was.

### 2 · Is AC1b's residual case real? — **yes, but its value is localization, not detection**

Mutation: shared constant → `telemetry:events-v2`, worker's `constants.ts:60` re-pinned to the
literal `"telemetry:events"`.

```
worker  × defaults REDIS_STREAM_NAME to the shared usage-events stream key   (AC1b)
          Tests  1 failed | 29 passed (30)          <- AC1 green, AC1b red
```

So AC1b is not redundant with AC1: they fail on disjoint mutations. But note the logic — with
`W` = worker's resolved default, `S` = the shared constant, `L` = the literal, shared-types'
own test pins `S == L` and AC1 pins `W == L`, which together imply `W == S`. Under a full
workspace run AC1b therefore never fires alone; in the mutation above shared-types' test is red
too. AC1b's unique contribution is that **worker's own package suite** fails and names worker,
instead of the failure surfacing only in `@telemetry/shared-types`. `@telemetry/worker-service:lint`
also errors in that scenario (`'EVENT_STREAM_CONSTANTS' is defined but never used`).

**Verdict: keep it.** It costs one `safeParse` and it fails in the package that is wrong. The
comment at `tests/env.schema.unit.test.ts:67-72` describing it as catching "worker re-pinned to
the old literal while the shared value moves on" is accurate. I would not add "this is the only
test that catches it" — it isn't.

### 3 · M-2's fix — **correct, and all three parts are mutation-proven**

- Whitespace-only secret is now a parse failure. Removing `.trim()` from
  `apps/worker-service/src/config/env.ts:30`:
  ```
  × rejects an all-whitespace INTERNAL_API_SECRET at the minimum length
  × strips surrounding whitespace from an otherwise valid INTERNAL_API_SECRET
    Tests  2 failed | 28 passed (30)
  ```
- The blank branch at `app.ts:44` is reachable only via the option. `z.string().trim().min(32)`
  cannot yield a value whose `.trim()` is empty (trim is idempotent, and anything trimming to
  `""` has trimmed length 0 < 32), and `??` does not fall back for `""`. The comment at
  `app.ts:38-43` is **true as written**. Neutering the guard to `if (false)` turns
  `rejects a blank internalApiSecret option` red (1 failed | 29 passed) — it is not vacuous.
- The header-padding probe: five forms reproduced and correct; the universal drawn from them is
  not — **M-6**.

### 4 · Did the promotion break anything? — **no**

- 13/13 on all four tasks with `--force`; per-package counts unchanged everywhere except worker.
  usage-service **19 files / 230 tests**, exactly as required. shared-types **8**.
- `packages/shared-types/package.json` has **no `dependencies` and no `devDependencies`**, and
  `grep "^import"` over `packages/shared-types/src/` returns nothing — zero runtime deps, no
  import at all, so no cycle is possible. `main`/`types` point at `src/index.ts`; no build
  artefact to stale.
- The only new export is `EVENT_STREAM_CONSTANTS`. `grep -rn EVENT_STREAM_CONSTANTS apps packages`
  returns 13 lines across exactly 4 files plus the definition — no other consumer picked it up,
  and no pre-existing symbol collides.
- `docker/docker-compose.yml` and `.github/workflows/ci.yml` set `REDIS_STREAM_NAME` **nowhere**,
  so in the container stack both services now fall through to the same shared default. Round 1's
  L-6 observation ("no shared path keeps them in step in the container stack") is closed as a
  side effect.
- Round 1's L-7 is also closed as a side effect: `apps/worker-service/dist/tests/env.schema.unit.test.js:2`
  now imports the package specifier `@telemetry/shared-types`, not a `../../usage-service/...`
  relative path, so the emitted file no longer contains an unresolvable import. The underlying
  waste (tests emitted into `dist`) is unchanged and still worth a known-gaps line.

### 5 · The three declared judgement calls

**(a) Not `.trim()`ing the three stream fields — ACCEPT, and the symmetry claim is true.**
Probed both schemas side by side:

| `REDIS_STREAM_NAME` | worker parses to | usage parses to | producer's effective `XADD` key | agree |
|---|---|---|---|---|
| `" "` | `" "` | `" "` | `" "` | **yes** |
| `"  telemetry:events  "` | `"  telemetry:events  "` | `"  telemetry:events  "` | `"  telemetry:events  "` | **yes** |
| `""` | *parse failure* | `""` | `"telemetry:events"` (fallback) | no |

The reasoning holds: trimming worker alone would make a padded override resolve to different keys
on the two sides — silent, and exactly the failure D4 exists to prevent. The single-space case is
symmetric as claimed. The one asymmetry is `""`, where worker refuses to start while the producer
silently falls back — **fail-loud on the consumer**, so acceptable, but worth one sentence in the
`env.ts:31-37` comment so the next reader knows `.min(1)` is also one-sided.

**(b) Declining L-3 — ACCEPT the decline, reject the disappearance.** See L-11.

**(c) `app.ts:59`, not `:55` — the implementer is right.** `apps/worker-service/src/app.ts:59` is
`internalRoutes.addHook("preHandler", internalAuth);`. Line 55 is blank. Correcting the brief's
citation was the right call.

### 6 · The authorised S-8 edit — each element verified

| Edit | Verdict |
|---|---|
| Item 2 scoped to billing | **True.** `apps/billing-service/src/app.ts:23` is verbatim `options.internalApiSecret ?? process.env.INTERNAL_API_SECRET ?? ""`; `apps/billing-service/src/config/env.ts` has no `INTERNAL_API_SECRET`. Worker's claim re-verified: `env.ts:30` declares it, `env.ts:56` parses at module load, `app.ts:3` imports that module statically, `app.ts:21` builds the container after. |
| Worker citations refreshed to `app.ts:27` / `app.ts:59` | **True**, both exact. |
| Fix direction narrowed | **True for the env-schema clause**, but see **L-9** — it drops the `.trim()`. |
| Items 1 and 3 still open for both services | **True.** `diff` of the two middleware files shows they differ only in the imported constant names; both are `!==` at line 9 and un-`return`ed `reply.status(401).send(...)` at line 10. Billing's `preHandler` registration is untouched. `.claude/rules/tenant-isolation.md`'s "only usage-service currently has the layer-2 guard in the strong form" stays accurate. |
| Framing sentence "both … in three ways" | **Now false for worker** — L-8. |

---

## Claims audit (required gate)

Everything the diff *adds* as prose, re-derived. Twenty-two claims; four are wrong.

| Claim | Location | Verdict |
|---|---|---|
| "One definition, three consumers of it" + the three cited paths | `shared-types/src/index.ts:98-101` | **TRUE.** `grep -rn EVENT_STREAM_CONSTANTS` shows exactly those three `src` sites. |
| "`.claude/rules/constants.md` asks for promotion before the third copy" | `shared-types/src/index.ts:103-104` | **TRUE**, quoted correctly. |
| "for the same reason `INTERNAL_AUTH_CONSTANTS` does — more than one service's env schema resolves it" | `shared-types/src/index.ts:102-103` | **TRUE.** gateway `env.ts:14`, usage `env.ts:15`, worker `env.ts:30`. |
| "Producer and consumer disagreeing is silent: XADD succeeds, XREADGROUP blocks forever, both report healthy" | `shared-types/src/index.ts:105-106` | **Reasoning, not execution.** No consumer exists to run. Consistent with Redis semantics given `XGROUP CREATE … MKSTREAM`; flagged as unverifiable today. |
| "an operator can still create it by setting `REDIS_STREAM_NAME` on one service only" | `shared-types/src/index.ts:108-109` | **TRUE**, and the one hedge in the paragraph. |
| "makes that disagreement unrepresentable in code" (×3 sites) | `shared-types/src/index.ts:107`, `usage-service/src/constants.ts:112-113`, `worker/.env.example:31-33` | **FALSE — M-5.** |
| "This default — not `STREAM_CONSTANTS.DEFAULT_STREAM_NAME` — is the value `StreamPublisher` actually XADDs to" | `usage-service/src/config/env.ts:16-17` | **TRUE.** `stream.publisher.ts:35-36` is exactly as quoted, line numbers correct. |
| "because this default always applies the right-hand fallback is unreachable" | `usage-service/src/config/env.ts:18-19` | **Overreach — N-4** (false for `REDIS_STREAM_NAME=""`, executed). |
| "`DEFAULT_STREAM_NAME` is not a copy: it resolves `EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM`" | `worker/src/constants.ts:38-44` | **TRUE**, and correctly avoids claiming impossibility. |
| "`redis-cli --scan --pattern 'telemetry*'` returned exactly `telemetry:events`; `xinfo groups` returned nothing" | `worker/src/constants.ts:46-49` | **TRUE, re-run live now.** One key, type stream, `xlen 2`, zero groups. |
| "`tests/env.schema.unit.test.ts` still pins the resolved default both against the literal and against the shared constant" | `worker/src/constants.ts:50-51` | **TRUE** — AC1 at `:63`, AC1b at `:79`. |
| "`BATCH_SIZE_MAX` mirrors `INGESTION_CONSTANTS.BATCH_SIZE_MAX`, `events.validator.ts:6`" | `worker/src/constants.ts:53-56` | **TRUE** — `events.validator.ts:6` is `BATCH_SIZE_MAX: 100`, exact line. |
| "`XREADGROUP COUNT` accepts larger values — a policy ceiling, not a protocol limit" | `worker/src/constants.ts:56-57`, `.env.example:42-44` | **TRUE** (executed at round 1 with a 250-entry scratch stream; not re-run, no reason to expect drift). |
| "`middleware/internal-auth.middleware.ts` still writes a literal 401" | `worker/src/constants.ts:24` | **TRUE** — line 10 of that file. |
| "Named to match usage-service's `USAGE_SERVICE_RESPONSES.HTTP_STATUS_*`" | `worker/src/constants.ts:23` | **TRUE** — `usage-service/src/constants.ts:36-41`. |
| "Nothing in this repo reads the parsed `env.PORT`" | `worker/src/config/env.ts:9-11` | **TRUE** — the only `env.PORT` hit outside `process.env.PORT` is that comment itself. |
| "`.trim()` runs before `.min(...)`, so length is measured on the trimmed value" | `worker/src/config/env.ts:20-21` | **TRUE**, mutation-proven. |
| "header values … all arrived stripped … an untrimmed expectation could not have matched a padded secret on the wire in the first place" | `worker/src/config/env.ts:23-26` | **Premise TRUE, conclusion FALSE — M-6.** |
| "`app.inject` does *not* strip; it bypasses the HTTP parser" | `worker/src/config/env.ts:26-28` | **TRUE** — AC12 injects a header and the value is compared byte-for-byte. |
| "Nothing reads these yet; T-038 `XGROUP CREATE`, T-039 `XREADGROUP`" | `worker/src/config/env.ts:31-32`, `.env.example:26-27` | **TRUE for the present tense** (grep: the five vars appear only in their own declarations); the future half is unverifiable. |
| "usage-service's producer does not trim `REDIS_STREAM_NAME` either" | `worker/src/config/env.ts:35` | **TRUE** — `usage-service/src/config/env.ts:21` has no `.trim()`. |
| "The `env.INTERNAL_API_SECRET` path cannot produce a blank value … what reaches here blank is an explicitly-passed option" | `worker/src/app.ts:38-43` | **TRUE** — this is round 1's M-2 corrected, and the correction holds. |
| "Before the trim was added, a 32-space `INTERNAL_API_SECRET` parsed cleanly and arrived here empty" | `worker/src/app.ts:43` | **TRUE**, re-derived. |
| "`tests/smoke.test.ts` builds the app with its own short secret" | `worker/src/app.ts:25-26` | **TRUE** — `smoke.test.ts:18`, `"test-secret"`, 11 chars. |
| "The gateway does not currently proxy to worker-service; … the published 3003 port mapping" | `worker/.env.example:19-20` | **TRUE** — `GATEWAY_PROXY_PREFIXES` has AUTH/USAGE/BILLING/ANALYTICS only; `docker-compose.yml:151` publishes `3003:3003`. |
| "No group exists yet: `xinfo groups telemetry:events` returns empty" | `worker/.env.example:37` | **TRUE**, live. |
| `docs/reviewer-checklist.md:31` worker row: "yes (env schema, T-037)" | | **TRUE**, and the other two cells correctly still cite S-8. |
| S-8 item 2 "worker-service no longer has this" | `known-gaps.md:55-57` | **TRUE.** |
| S-8 "both … differ … in three ways" | `known-gaps.md:44-46` | **Now false for worker — L-8.** |
| Plan: "grep returns exactly one line, `packages/shared-types/src/index.ts`" | plan:338 | **TRUE**, reproduced. |
| Plan AC1b: "proven by mutation (shared → `telemetry:events-v2` + worker re-pinned: AC1b red, AC1 green)" | plan:491 | **TRUE** — I reproduced that exact mutation and got exactly that result. |
| Plan: "Deliberately not modified … `apps/usage-service/**`" | plan:385 | **FALSE — L-12.** |
| Plan: `format:check` 261 at base | plan:543-547 | **TRUE**, see below. |

---

## Compile-time gate — `--force`, actual output

All four from repo root. `Cached: 0 cached, 13 total` on every one, so nothing was replayed.

| Task | Result |
|---|---|
| `pnpm typecheck --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` · 10.813s |
| `pnpm lint --force` | `Tasks: 13 successful, 13 total` · **0 errors, 14 warnings, all pre-existing** · 30.841s |
| `pnpm build --force` | `Tasks: 13 successful, 13 total` · 23.025s |
| `pnpm test --force` | `Tasks: 13 successful, 13 total` · 19.346s |

Per-package test counts (12 emit a vitest summary; `@telemetry/web` has no suite — 13th package):

```
shared-tracing      1 file  /   2      billing-service    4 files /  18
shared-config       1 file  /   4      analytics-service  4 files /  18
shared-logger       1 file  /   4      gateway            8 files /  38
shared-types        1 file  /   8  <-  worker-service     5 files /  49  <- expected 5/49
shared-validation   1 file  /  15      usage-service     19 files / 230  <- unchanged
shared-utils        1 file  /  18      auth-service      15 files / 164
```

worker **5/49**, shared-types **8**, usage-service **19/230** — all three expected figures hit
exactly. Worker's new file alone is 30 tests (was 26 at round 1: +AC13, +AC14, +2 AC10, −0).

### Lint warnings — proven pre-existing

14 warnings, two files, neither in this diff:

```
apps/auth-service/tests/auth.service.unit.test.ts        10  (no-misused-promises)
apps/usage-service/tests/ingestion.service.unit.test.ts   4  (no-unsafe-assignment)

$ git log -1 --format="%h %ad %s" --date=short -- apps/auth-service/tests/auth.service.unit.test.ts
d68e719 2026-08-25 test(services): expand coverage for singleton, container, and shutdown flows
$ git log -1 --format="%h %ad %s" --date=short -- apps/usage-service/tests/ingestion.service.unit.test.ts
b0f6921 2026-08-31 fix(security): close tenant-isolation gaps S-1 through S-4
$ git diff --name-only 9315493 | grep -E "auth.service.unit|ingestion.service.unit"
(no output)
```

Both commits predate base `9315493`; neither file is in the diff. `@telemetry/worker-service:lint`,
`@telemetry/usage-service:lint` (src) and `@telemetry/shared-types:lint` produced no new output.
**No new warnings, no new errors.**

### `format:check` — 261 → 264, spot-checked rather than accepted

```
$ pnpm format:check
[warn] Code style issues found in 264 files.
```

I did not take the implementer's word for the attribution. I extracted the **base blob of every
modified tracked file** with `git show 9315493:<path>` into a scratch tree with the repo's
`.prettierrc` and ran prettier there:

```
[warn] .claude/agents/epic-router.md        [warn] apps/worker-service/src/app.ts
[warn] .claude/rules/known-gaps.md          [warn] apps/worker-service/src/config/env.ts
[warn] apps/usage-service/src/config/env.ts [warn] apps/worker-service/src/constants.ts
[warn] apps/usage-service/src/constants.ts  [warn] docs/reviewer-checklist.md
[warn] packages/shared-types/src/index.ts   [warn] packages/shared-types/tests/unit.test.ts
[warn] Code style issues found in 10 files.
```

All ten were **already** flagged at their `HEAD` blobs. (`apps/worker-service/.env.example` is the
eleventh modified file; prettier does not parse it — N-5.) The three untracked additions
`apps/worker-service/tests/env.schema.unit.test.ts`, `docs/plans/t-037-…md` and
`docs/reviews/t-037-…md` are all in the current flagged list. 261 + 3 = **264**, and the change
reformats nothing. The implementer's account is correct; S-12 remains the standing failure and is
not a T-037 regression.

---

## What I could not verify, and why

1. **That T-038/T-039 will read the five stream vars.** Statement about unwritten code. Grep
   proves nothing reads them *today*; the rest is reasoning and can only be re-checked at T-039.
2. **"XREADGROUP blocks forever on an empty key, and both services report healthy."** No consumer
   exists. Reasoning, consistent with Redis semantics, not executed.
3. **Runtime behaviour under Docker Compose** with the newly-required `INTERNAL_API_SECRET`. The
   stack is not up; I verified statically that every supply point clears 32 characters
   (`docker-compose.yml:149` = 45 chars, `tests/setup.ts:12` = 45, `.env.example:23` = 37,
   root `.env.example:18` = 43) and that `x-common-app-env` sets no `REDIS_STREAM_NAME`.
4. **Nothing database- or RLS-related.** No query, migration, policy or connection role is
   touched, so `pg_roles` was not consulted. Stated so the omission is not mistaken for a green.
5. **Whether U+00A0-padded secrets occur in any real deployment.** M-6 refutes the universal by
   construction; I did not attempt to show the case is reachable in practice, and I doubt it is.

---

## Environment left behind

- **Redis untouched by T-037, as required.** `telemetry:events` still exists, `type stream`,
  `xlen 2`, `xinfo groups` empty. No consumer group was created; no scratch key was left.
  db15 is empty. The only delta in db0 is `denylist:*` — 2 keys before, 1 after, with a different
  hash: those are auth-service logout denylist entries with TTLs, written and expired by the
  **pre-existing** `auth-service` integration suite during my `pnpm test --force`. Nothing in
  T-037 writes them.
- **Working tree restored exactly.** Every mutation was made against a scratch backup and
  reverted; `git diff --stat 9315493` and `git status --porcelain` are byte-identical to the
  state I was handed (11 modified, 3 untracked), and md5 sums of the six files I mutated match
  their pre-mutation values. One throwaway probe test
  (`apps/worker-service/tests/__probe.symmetry.test.ts`) was created and deleted; `git status`
  confirms it is gone.
- Nothing committed, staged, branched or pushed.

---

## Loop discipline — this is the same class as round 1

Round 1's four required findings were: one false structural guarantee (H-1), one false count
(M-1), one false universal next to the secret validator (M-2), one stale authoritative table
(M-3). **All four are properly fixed, and I proved each fix by mutation rather than by reading.**

Round 2's two MEDIUMs are *the same class again*: M-5 is a false structural guarantee about
divergence, in the same paragraph that reversed D4 to provide it; M-6 is a false universal in the
same comment block M-2 was in. That is two rounds on T-037, and per `/ship` I am flagging it
rather than assuming a third round converges — this is the third consecutive task (S-18, T-036,
T-037) where the code is right and the prose over-claims.

**Recommendation: do not open Gate 3 round 3.** Nothing in M-5, M-6, L-8, L-9, L-11 or L-12
changes a line of executable code — they are six comment/doc edits, all with the replacement text
written out above. The cheapest correct path is for you to apply them at commit time, or to
approve the change with them recorded here as the standing correction. What would help more than
another round is a standing instruction that any sentence containing "cannot", "only", "never",
"unreachable" or "unrepresentable" must cite the mutation that was run to establish it — this
would have caught H-1, M-2, M-5, M-6 and N-4.

---

## Verdict

`CONDITIONAL`

**Required before commit** (all wording, no code):

- **M-5** — three sites claim producer/consumer divergence is "unrepresentable in code" /
  "cannot drift in code". Executed refutation: two edits, whole gate green. Replacement text
  supplied.
- **M-6** — `apps/worker-service/src/config/env.ts:23-26` — the "could not have matched a padded
  secret on the wire in the first place" universal is false for U+00A0. Replacement text supplied.
- **L-8** and **L-9** — `.claude/rules/known-gaps.md` is designated authoritative; the "three
  ways" count is now wrong for worker, and the fix direction hands billing the untrimmed `.min()`
  this task just proved insufficient.
- **L-12** — the plan's exclusion list contradicts its own change table.

**Recommended for `.claude/rules/known-gaps.md`** (out of scope to fix in T-037, must not
evaporate): **L-10** the untrimmed `INTERNAL_API_SECRET` in gateway and usage-service ·
**L-11** the literal `401` in worker's and billing's middleware · round 1's **L-4** (no shared
`HTTP_STATUS` map, third copy reached) · round 1's **L-7** (`tests/**` emitted into `dist`).

**Accepted as-is:** the D4 reversal and its placement in `@telemetry/shared-types` · not
trimming the three stream fields (judgement call (a) — the symmetry claim is executed and true)
· declining to restructure S-8 for L-3 (judgement call (b)) · the `app.ts:59` correction
(judgement call (c), verified) · AC1b in its reduced form · the `HTTP_STATUS_*` constants used
only by tests · the five declared-but-unread stream vars until T-039.

**Remaining risks:** R2 (stream-name drift) is materially reduced — a rename at the constant now
fails three packages' suites — but is not eliminated, and M-5 is the measure of exactly how much
is left. R5 (config nobody reads) stays live until T-039, now with honest tense throughout.
The breaking change for operators running worker with a sub-32-character or whitespace-padded
`INTERNAL_API_SECRET` is intended and correct; every supply point in this repo clears it, but it
belongs in the commit message body.

CHANGES REQUESTED on M-5/M-6/L-8/L-9/L-12 — but see **Loop discipline**: these are six wording
edits with the text already written, and I recommend escalating to you for a direct decision
rather than a third Gate 3 round.
