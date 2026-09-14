# Review — T-040 · Event → UsageLine processor (worker-service)

## Round 1

**Gate 4 — pre-QA senior review.** Base `7dc7392`; subject is the uncommitted working tree.
Reviewer: read-only. Every `file:line` below was re-derived against the tree as reviewed.

**Verdict: CONDITIONAL.** No tenant-isolation defect, no injection, no correctness defect in
shipped code, and every gate green. What fails is the change's *account of itself*: three
claims it adds are false, one of them about the tenant-write invariant, and a future editor
acting on them would weaken a real guard. Required fixes are listed under **R1–R3**; the rest
are recorded with dispositions.

---

## Findings

### HIGH-1 · `stream-message.validator.ts:20` — "`I19` is the case that fails when it does" is false

The `StreamEventRow` docstring correctly scopes its own claim, then names a test that does not
hold it up:

> It is not a claim that no future edit can write a tenant id here — one that dropped
> `this.where(...)` and wrote `payload.tenantId` instead would compile. `I19` is the case that
> fails when it does.

I wrote exactly that edit — `create: ({ tenantId: payload.tenantId, id: payload.event.eventId, … })`,
with `this.where(...)` removed from the `Event` `create`. It typechecks clean and the worker
package is **126/126 green**, `I19` included.

The reason is structural, not incidental: **no fixture anywhere in the package builds a
repository for a tenant other than the one its payload carries.** The integration suite's
`buildRepository(tenantAId)` is always paired with `streamFields()`'s `tenantAId`; `I15` pairs
`tenantBId` with `tenantBId`; `I18` pairs the unknown tenant with itself because the processor
derives the repository from `payload.tenantId`. `event.repository.unit.test.ts` constructs with
`TENANT_ID` and parses `TENANT_ID`. So the two values the docstring distinguishes are never
distinguishable, and `U49`'s otherwise-strong negative (`expect(bound).not.toContain(OTHER_TENANT_ID)`)
is measuring nothing, because `OTHER_TENANT_ID` never enters the payload.

This is the one claim in the change that is *about* the invariant the file exists to protect,
and it is the claim a future reader will consult when deciding whether `this.where(...)` is
load-bearing. That is why it is HIGH rather than MEDIUM.

**Concrete fix**, in `apps/worker-service/tests/event.repository.unit.test.ts`, ~10 lines:

```ts
it("U58 - writes its own bound tenant, never the tenant id that travelled with the message", async () => {
  const payload = parseStreamMessage(
    streamFields({ [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: OTHER_TENANT_ID })
  );
  expect(payload.tenantId).toBe(OTHER_TENANT_ID);   // the payload really does disagree

  await repository.upsertEventWithUsageLine(payload);

  const [upsertArgs] = onlyCallArgs(eventUpsert, "event.upsert") as [{ create: Record<string, unknown> }];
  expect(upsertArgs.create["tenantId"]).toBe(TENANT_ID);
  const bound = JSON.stringify([queryRaw.mock.calls, eventUpsert.mock.calls, usageLineUpsert.mock.calls]);
  expect(bound).not.toContain(OTHER_TENANT_ID);
});
```

Then correct `:20` to name that case. I confirmed the mutation is caught by nothing today, so
the new case is the whole of the fix — adjusting the sentence alone leaves the property untested.

---

### MEDIUM-1 · `constants.ts:309-311` — the producer/consumer field-set coupling is not "pinned by a test"

The `ENVELOPE_FIELD` docstring justifies copying usage-service's `RESERVED_STREAM_FIELDS`
rather than importing it, on the grounds that "The coupling that matters is pinned by a test
instead (`U41` asserts `timestamp` reaches neither a column nor `metadata`)."

`U41` asserts worker's parser against **worker's own constant**. Nothing anywhere asserts that
the two sets agree. Verified: `grep -rn "RESERVED_STREAM_FIELDS" apps packages --include=*.ts`
(excluding `dist`) returns four lines — the producer's declaration, the producer's one use, and
two *prose comments* in this change. No test references it.

The sets do match today — I compared them field by field, both are the same eight names
(`eventId, tenantId, eventType, quantity, unit, occurredAt, idempotencyKey, timestamp`), against
`apps/usage-service/src/services/ingestion.service.ts:15-24` and its `publishEvent` literal at
`:136-145`. The risk is directional and live: a producer-side *addition* drifts silently, and
the pending candidates are named in this very change — Q1's `receivedAt`, `source`, `version`.
The first of those to ship lands in every event's customer-facing `metadata` blob, and `U41`
stays green.

**Fix:** weaken `:309-311` to what is measured — e.g. "`U41` pins this constant against the
parser; nothing asserts parity with the producer's set, which is S-27." Do not manufacture the
import to make the sentence true; the reason given for not importing is sound.

---

### MEDIUM-2 · `docs/plans/…:559` — the S4(a) refuting mutation is falsified, and the plan still asserts it

Plan §6 S4 states:

> **Refuting mutations:** (a) replace `this.where({ eventId })` with a bare `{ eventId }` — `I15`
> (the cross-tenant case) must go red **or the assertion is not testing isolation**

I performed it. All eight integration cases stay green; the only failure is `U51`
(`expected undefined to be '456793cd-…'`), which asserts the *shape* of the `where` object. The
implementer's account of this is **correct and honest** — `event.repository.ts:85-95` explains
that `UsageLine.eventId` is globally `@unique` and is always an `Event.id`, itself a global
primary key, so addressing another tenant's `UsageLine` would require holding an `Event` with
that id. I checked the live indexes: `UsageLine_eventId_key` is a unique btree on `("eventId")`.
The reasoning is sound and keeping the predicate is right — `.claude/rules/tenant-isolation.md`
requires it, and the property should survive a schema where `eventId` is not globally unique.

The problem is only that the plan ships uncorrected. Read literally, its own success criterion
says the shipped test suite fails to test isolation, which invites the next reader either to
delete the predicate (green) or to rewrite `I15`.

**Ruling: yes, correct it in place.** Not by rewriting the prediction — by appending a Gate-3
outcome line under S4, e.g.:

> **Gate-3 outcome, (a) falsified.** The bare `{ eventId }` mutation leaves `I15` and all eight
> integration cases green; only `U51` catches it. `UsageLine.eventId` is globally `@unique` and
> is always an `Event.id` (a global primary key), so the cross-tenant address is unrepresentable
> and no integration case can exist. The predicate is kept as belt-and-braces; see
> `event.repository.ts` and known-gaps S-28.

---

### MEDIUM-3 · `vitest.config.mjs:27` — "failed 1 of 3" understates a deterministic collision

The comment presents the cross-file Redis collision as intermittent. Measured here: with
`fileParallelism: false` commented out (`:35`), the worker package failed **5 of 5**
consecutive runs, every one with
`NOGROUP No such key 'telemetry:events:t039:<pid>-<ts>-8' or consumer group 'worker-group-t039-…'`.
On this host it is not flake; it is a hard fixture collision between two suites that share one
reserved logical database and both `FLUSHDB` it.

That makes `fileParallelism: false` **the right fix, not a mask**. I looked for the alternative
and there isn't a better one on vitest 2.1.9: there is no per-file grouping primitive, and
deleting per-run keys instead of flushing gives up the guarded-`FLUSHDB` chokepoint S-22 argues
for while still racing on `afterAll`. No production ordering is involved — the consumer loop is
not implicated.

The cost is real and unstated: **serial 4.7–4.9 s wall vs parallel 1.6–2.0 s**, ~2.5×, and it
serializes the nine unit files that have no Redis dependency at all.

**Fix:** correct `:27` to the measured ratio and add the runtime cost. Keep the setting. See
**Decision B** for whether to scope it more narrowly.

---

### LOW-1 · `tests/event.processor.integration.test.ts:571` — third copy of a log-message literal

`expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ entryId }), "Stream entry handler failed")`
writes the message as a bare string. It already exists twice: the producing site
`src/events/stream.consumer.ts:772` and `tests/stream.consumer.unit.test.ts:151`'s
`LOG_MESSAGE.HANDLER_FAILED` (used at `:1242`). `.claude/rules/constants.md` asks for promotion
*before* the third copy; this is the third.

**Fix:** add `HANDLER_FAILED: "Stream entry handler failed"` under a `LOG` member of
`WORKER_STREAM_READ` in `src/constants.ts` and reference it from all three sites. (This touches
one T-039 line; that is the promotion the rule asks for, not scope creep.)

---

### LOW-2 · `event.repository.ts:173` — unreachable fallback, and the comment mis-describes it

`quantity: String(usageLine.quantity ?? event.quantity)`. `UsageLine.quantity` is
`Decimal(18,6) NOT NULL` (confirmed against `information_schema.columns`) and is in the
`select` at `:166`, so the right arm cannot be taken. The comment above it says "the `usageLine`
read is what proves the two rows agree" — nothing compares them; `??` is a fallback, not a
comparison. `quantity: true` in the `Event` select at `:149` exists only to feed the dead arm.

**Fix:** drop `?? event.quantity` and drop `quantity` from the `Event` select at `:149`, and
delete the sentence; or, if agreement really is the intent, compare the two and throw. The
former is what the rest of the class does.

---

### LOW-3 · No test pins an offset-bearing `occurredAt`

`iso8601Schema` is `z.string().datetime({ offset: true })`
(`packages/shared-validation/src/index.ts:20`), and the producer publishes
`occurredAt: event.occurredAt` — the raw request string, offset and all
(`apps/usage-service/src/services/ingestion.service.ts:142`). So `2026-01-01T05:30:00+05:30`
can reach this parser.

The behaviour is **correct**: `new Date(...)` resolves the instant and Prisma binds it
UTC-normalised. I measured the bind directly from a `log: ["query"]` run —
`"occurredAt"` went over as `"2026-01-01 00:00:00 UTC"`. But every fixture in the change uses
`Z`, and `CLAUDE.md` § *Raw SQL and timestamps* names offset-only defects that `Z`-only fixtures
miss as a specific trap. The guard here is D-ORM, which has no test behind it.

**Fix:** one case in `U40` — `occurredAt: "2026-01-01T05:30:00+05:30"` must yield
`payload.event.occurredAt.toISOString() === "2026-01-01T00:00:00.000Z"` and the same for both
period bounds.

---

### LOW-4 · A wire `eventId` colliding with an existing `Event.id` is a permanently-failing message

`:136` writes `id: payload.event.eventId`, and `Event.id` is a global primary key. An entry
whose `eventId` already exists under a different `idempotencyKey` misses the compound lookup and
raises a PK violation — no `XACK`, redelivered forever until T-041. **This is inference, not
measurement**: I did not construct the case, and usage-service mints a fresh `eventId` per
publish, so I found no reachable path. Worth one sentence in the `create` comment at `:134-135`
naming the assumption it rests on (the producer's per-publish `eventId`), rather than code.

---

### NIT-1 · `tests/event.repository.unit.test.ts:170` — vacuous assertion

`expect(result.quantity).not.toBeInstanceOf(Prisma.Decimal)` follows
`expect(typeof result.quantity).toBe("string")` two lines up. A string is never an instance of
anything, so this cannot fail under any mutation the preceding line permits. Harmless; it reads
as a guard that is doing work.

### NIT-2 · `RUN_DEADLINE_MS: 1_500` is now also T-040's loop deadline

`runLoopOver` uses it as the `stopWhen` ceiling. It fails loudly rather than vacuously if
exceeded (`seen` stays empty and `expect(seen).toContain(entryId)` fails), and the whole T-040
integration file ran in 384 ms here, so the margin is ~4×. **Disposition: accept**, with the
note that it is tighter than it was and a loaded CI runner is the place it would first bite.

---

## What I verified, and how

### The migration — re-derived as `telemetry_app`, in rolled-back transactions

`prisma/migrations/v1_6_event_tenant_idempotency_key/migration.sql`'s header is the
load-bearing claim of the task. **Every measured statement in it reproduces.**

Under the *current* (compound) index, on a **direct `telemetry_app` login** —
`current_user = telemetry_app`, `rolsuper = f`, `rolbypassrls = f` — tenant A holding the key
and tenant B replaying it, each shape in its own `BEGIN … ROLLBACK`:

| Shape | Result |
|---|---|
| read-then-write | B's `SELECT … WHERE "idempotencyKey" = K` → **0 rows** (RLS hides A's), then `INSERT 0 1` |
| `ON CONFLICT ("tenantId","idempotencyKey") DO NOTHING` | `INSERT 0 1`, returns `ev-b-2` |
| `ON CONFLICT … DO UPDATE` | `INSERT 0 1`, returns `ev-b-3` |
| same-tenant replay, `DO NOTHING` | returns **no id**, `INSERT 0 0`, table holds **1** row |

Under the *replaced* global unique, simulated as owner (`DROP INDEX "Event_tenantId_idempotencyKey_key"`
+ `CREATE UNIQUE INDEX "Event_idempotencyKey_key"`) then `SET LOCAL ROLE telemetry_app`
(re-confirmed `rolbypassrls = f` inside the transaction), all three fail and two fail worse than
an error — verbatim:

- read-then-write → `ERROR: duplicate key value violates unique constraint "Event_idempotencyKey_key"`
- `DO NOTHING` → `INSERT 0 0`, **and the transaction stayed alive** — the probe's next statement
  (`SELECT 'txn alive'`) returned a row. So the worker would have acknowledged a message it
  never stored. This is the one that matters most and it is exactly as written.
- `DO UPDATE` → `ERROR: new row violates row-level security policy (USING expression) for table "Event"`

**And it is the compilation the code actually gets.** I captured Prisma's query log through a
real `EventRepository` call: the upsert compiles to `SELECT … LIMIT 1` then
`INSERT … RETURNING "id"`, with **no `ON CONFLICT` clause anywhere** — so row 1 of that table,
the `duplicate key` one, is the live failure mode the migration removes. Not belt-and-braces.

Alignment and shape: `migrate status` → `Database schema is up to date!`; `v1_6` is applied;
`migrate diff --from-schema-datamodel … --to-url` emits **nothing about `Event`**, so
`@@unique([tenantId, idempotencyKey])` in `prisma/schema.prisma` and the hand-written index name
`Event_tenantId_idempotencyKey_key` agree exactly. Forward-only, `DROP INDEX IF EXISTS` +
`CREATE UNIQUE INDEX`, mirroring `v1_1_user_email_global_unique`; `pg_constraint` on `"Event"`
lists only `Event_pkey` and `Event_tenantId_fkey`, so the "index, not constraint" claim holds.
`Event` and `UsageLine` were at 0 rows before and after, so the no-backfill claim stands.

### Tenant isolation and RLS

Read straight off the emitted SQL, not inferred:

```
BEGIN
SELECT set_config('app.tenant_id', $1, true)            <- FIRST statement, bound not interpolated
SELECT "Event"."id" … WHERE (("tenantId" = $1 AND "idempotencyKey" = $2) AND "tenantId" = $3)
INSERT INTO "Event" (…) RETURNING "id"
SELECT "UsageLine"."id" … WHERE ("eventId" = $1 AND "tenantId" = $2)
INSERT INTO "UsageLine" (…) RETURNING "id"
COMMIT
```

Both predicates are exactly what `event.repository.ts:73-77` claims. The docstring's two
"honest limits" are both accurate — I saw the post-`INSERT` read-back as
`WHERE "id" = $1` with no tenant predicate, as stated. `occurredAt` bound as
`"2026-01-01 00:00:00 UTC"`, confirming D-ORM's measured half.

- **`withTenant` on every query**: yes, both writes plus the extra `findUnique` are inside one
  `$transaction`; `U47` asserts the call order `["$queryRaw", "event.findUnique", "event.upsert",
  "usageLine.upsert"]` and the `$queryRaw`-first position specifically.
- **Tenant from bound context**: `const { tenantId } = this.where({})` at `:106`; the naive
  `this.where({ idempotencyKey })` is **TS2322** — I wrote it and got
  `is missing the following properties … id, tenantId_idempotencyKey`. Claim confirmed.
- **Spread-in tenant unrepresentable**: `create: { ...payload.event }` compiles but cannot carry
  a tenant, because `StreamEventRow` has no such field — confirmed by writing the spread.
  `tenantId: payload.tenantId` *inside* `this.where(...)` is TS2322 (`Type 'TenantId' is not
  assignable to type 'undefined'`) — confirmed. The residual hole is HIGH-1.
- **Factory, not singleton**: `container.ts` registers `eventRepositoryFactory` as
  `(tenantId) => new EventRepository(...)`; `U57` asserts a function, two instances for two
  tenants, and two instances for the *same* tenant. `U48` asserts the processor calls it per
  message with the parsed tenant.
- **The role is real**: `I19` asserts `rolsuper = false` / `rolbypassrls = false` on the
  subject's connection, and I independently confirmed `telemetry_app` is `f|f` in `pg_roles`.
  Its fixtures are seeded through `DIRECT_DATABASE_URL`, a different connection, so its zero-row
  assertion is not self-fulfilling.
- **`base.repository.ts` untouched**: `md5sum` is `13a533a2e2c2dcc1ff9db28fb5c7a1fd`, the exact
  byte-identical hash S-19 records for the analytics/billing/worker trio. S-19 is respected.

### Injection

The only raw SQL in `apps/worker-service/src` is `base.repository.ts:98`'s
`` tx.$queryRaw`SELECT set_config('app.tenant_id', ${this.tenantId}, true)` `` — a tagged
template with a bound parameter, unmodified by this change. T-040 adds none. The test files'
`$queryRaw` uses are tagged templates with bound values. No `Prisma.raw`, no interpolation, no
enum-varied SQL. Nothing to report.

### The mutation set the brief asked me to re-perform

Every one behaves as claimed, and each failed **by assertion**, not by a runner timeout:

| Mutation | Result |
|---|---|
| `xack` moved above the `await` | `U43` red (`expected ['xack','upsert'] to deeply equal ['upsert','xack']`), `U54` red, **plus `U56`** |
| two `withTenant` calls instead of one | `I16` red (`expected 1 to be +0` — the orphaned `Event`), plus `U47`, `U52` |
| `set_config` removed from `withTenant` | **6 of 8** integration cases red; `I16` and `I18` pass, exactly as excepted |
| `quantity` bound as `Number(...)` | `I20` red: `expected '12345678901.123460' to be '12345678901.123456'` — the P-DEC value, to the digit; plus `U51` |
| `typeof rawCursor === "string"` → `String(rawCursor)` | `U39` red in 14 ms: `expected "spy" to be called 1 times, but got 2 times` |
| `this.where({ eventId })` → `{ eventId }` | only `U51` red; see MEDIUM-2 |
| `this.where(...)` dropped, `payload.tenantId` written | **126/126 green**; see HIGH-1 |

### The three self-reported items

1. **`U39`'s rewrite is sound and strictly stronger.** I reconstructed the discarded
   `stopAfter(CALLS.ONCE)` form and ran it *with* the cursor mutation: **it passes**, confirming
   the self-report. The `stopWhen(read >= 1)` form goes red under the same mutation. The reason
   given is correct — `stopAfter` counts predicate *checks*, and one check site is recovery's
   own between-pages guard, so it caps the pagination the case is trying to observe. The second
   terminating page (`mockResolvedValue(autoclaimReply(PENDING_START_ID, []))`) is what keeps the
   failure an assertion rather than a `RECOVERY_MAX_PAGES` timeout. Not weakened. No finding.
2. **The S4(a) non-reproduction is real and correctly reasoned** — see MEDIUM-2. The docstring
   is the honest version; only the plan needs the correction.
3. **`fileParallelism: false` is the right fix** and is worse than reported — see MEDIUM-3.

### `U50` and the deadline floor

`RUN_DEADLINE_MS: 1_500` + `BLOCK_MS_LONG: 3_000` = 4 500 < `CASE_BUDGET_MS` 5 000. ✓
The floor the justification rests on is real: `stream.consumer.integration.test.ts:845` asserts
`STOP_BUDGET_MS (2_000) < BLOCK_MS_LONG (3_000)`, so `BLOCK_MS_LONG` cannot go below 2 000 while
`RUN_DEADLINE_MS` has no floor (measured use ~26 ms). `readConfiguredTestTimeout` throws on
every absent-or-non-numeric shape rather than defaulting, so deleting `testTimeout` from the
config turns `U50` red instead of green. ✓ Note the scope the constant's own docstring states —
`U50` covers the deadlines it enumerates, and a later one is not automatically covered — which
is accurate.

### The extra `SELECT` per message

Cost, measured from the query log: the insert path is 7 statements plus `set_config` plus
`BEGIN`/`COMMIT`. The `findUnique` is the first of them. **It is index-covered** — it reads
`("tenantId","idempotencyKey")`, which is precisely the new `Event_tenantId_idempotencyKey_key`
unique btree. The `UsageLine` lookup reads `("eventId","tenantId")`, covered by
`UsageLine_eventId_key`. So the increment is one unique-index probe inside a transaction that
already exists.

**The justification holds.** The zero-cost inference — comparing the returned id against the
wire `eventId` — genuinely misreports the common replay, because a redelivered entry's row *was*
created with that id. I confirmed the replay path emits no `UPDATE` at all (`update: {}` makes
Prisma issue a `SELECT`), so the audit record is not rewritten, as `U51` asserts. The one
residual: under two concurrent workers both `findUnique`s can miss and both report
`created: true` — but the loser's `INSERT` then raises `P2002` and throws, so the misreport is
confined to a window that ends in a failure anyway. Accept.

### Clean code, type safety, production readiness

- Constants: the new `WORKER_EVENT_PROCESSING` / `WORKER_ENVELOPE_FIELD_NAMES` carry every field
  name, error message, log message, stride and offset; the derived `Set` at
  `constants.ts` is built from `Object.values(...)` so a field cannot be added to one and not the
  other. Tests use the constants throughout. **One violation: LOW-1.** `toHaveBeenCalledTimes(1)`
  in `U46` is bare, but that is the established style of `index.graceful-shutdown.unit.test.ts`
  (22 pre-existing sites, no `CALLS` object in the file) — consistent, not a finding.
- Type safety: no `any` introduced; the one `as TenantId` at `stream-message.validator.ts:191`
  is a brand cast after `z.string().uuid()` has validated, which is the established pattern. No
  `$queryRaw` result assertions in `src/`. `noUncheckedIndexedAccess` is handled with a
  `continue` rather than a cast at `:126-128`, and the reasoning given for preferring `continue`
  is correct.
- Error contract: parse failure, transaction failure and ack failure all throw and reach
  `dispatch`, which logs against the entry id and continues without acknowledging — `I18`
  observes this end-to-end on live Redis (entry still in `XPENDING`) rather than through a spy.
- Logging: `U45` checks redaction across **all four** logger methods and throws if the subject
  logged nothing, so its negatives cannot pass vacuously. Confirmed the `allLogCalls` helper
  throws in both directions.
- Middleware/startup ordering: unchanged; `index.ts` supplies the handler as the 5th constructor
  argument and `U46` proves an entry reaches it by driving a real `XAUTOCLAIM` reply through the
  real consumer, rather than snapshotting constructor arguments.
- Test honesty: I looked specifically for the S-3 shape — no early `return`/`skip` on a condition
  that is true when a bug is present; `onlyCallArgs` and `allLogCalls` both throw on absence;
  `flushReservedDb` re-asserts `CLIENT INFO db=14` on **every** call, which is the corrected
  S-22 shape and not the one-guard-in-`beforeAll` form. Fixtures are deleted by explicit id in
  `afterEach` **and** `afterAll`, which is the half S-20 records auth-service missing.

### The compile-time gate — all 13 packages, `--force`

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | **13 successful, 13 total · 0 cached** |
| lint | `pnpm lint --force` | **13 successful, 13 total · 0 cached** — 14 warnings, 0 errors |
| build | `npx turbo run build --force` | **13 successful, 13 total · 0 cached** |
| test | `pnpm test --force` | **13 successful, 13 total · 0 cached** |
| smoke | `pnpm test:smoke` | 6 suites, 1 test each, all passed |

Per-package tests: shared-config 4 · shared-tracing 2 · shared-validation 15 · shared-logger 4 ·
shared-types 8 · shared-utils 18 · billing 18 · analytics 18 · gateway 38 · usage 230 ·
auth 164 · **worker 126 (11 files)** · web `--passWithNoTests`.

Worker matches the stated 11 files / 126 tests exactly.

**The 14 warnings are pre-existing and proved so.** 10 × `no-misused-promises` in
`apps/auth-service/tests/auth.service.unit.test.ts`, last touched `d68e719`; 4 ×
`no-unsafe-assignment` in `apps/usage-service/tests/ingestion.service.unit.test.ts`, last touched
`b0f6921`. Neither file appears in `git status --porcelain` for this change. **Zero
`no-unsafe-return`**, as expected. No new warning of any kind.

---

## What I could not verify, and why

- **Concurrent-writer behaviour of the new compound index.** I did not race two workers on one
  key. The plan's `P-RACE` was measured on the *global* index; the mechanism is the same unique
  btree, but the compound one has not itself been raced. The `P2002`/self-heal argument is
  therefore inference. It is also bounded by T-041, so I did not push further.
- **`SET LOCAL ROLE` vs a direct login for the global-unique half.** The DDL needs the owner, so
  those three probes ran under `SET LOCAL ROLE`. My control is the compound-index half, which I
  ran on a *direct* `telemetry_app` login and which behaved identically in role attributes and
  RLS visibility. That control covers these probe shapes; it is not a general claim about
  `SET ROLE`.
- **Behaviour on a non-UTC PostgreSQL session.** Every timestamp here goes through the ORM and
  the bind is already UTC-normalised, so S-18's mechanism should not apply — but I did not
  re-run the suite under `options=-c timezone=Asia/Kolkata`, and worker's `withTenant` has no
  `TimeZone` pin (S-19). D-ORM is a decision with no test behind it, which the change says
  plainly. LOW-3 is the cheapest partial cover.
- **CI.** I ran the gate locally only. The CI job applies migrations as the owner before tests;
  `v1_6` needs `DROP INDEX`/`CREATE UNIQUE INDEX` privileges, which the migration role has here.
- **Coverage percentages.** Not run. Noted regardless: `vitest.config.mjs` excludes
  `src/events/**` *and* `src/config/container.ts`, so neither the `dispatch`→handler seam nor
  the DI wiring is measured. `src/services/**`, `src/repositories/**` and `src/validators/**`
  are inside. The S-25 caveat in the brief is accurate; `U46` and `U57` are what stand in, and
  both assert behaviour rather than construction shape.

---

## Environment — before and after

Recorded at the start and re-checked at the end; **identical**.

| | Before | After |
|---|---|---|
| Redis db 0 `XLEN telemetry:events` | 2 | 2 |
| db 0 `entries-added` | 2 | 2 |
| db 0 consumer groups | 0 | 0 |
| db 0 `DBSIZE` | 2 | 2 |
| db 14 `DBSIZE` | 0 | 0 |
| `Event` / `UsageLine` rows | 0 / 0 | 0 / 0 |
| `Tenant` / `User` rows | 2 / 2 | 2 / 2 |

Postgres and Redis were not stopped. Every write probe ran inside `BEGIN … ROLLBACK`; the one
probe that had to commit (a temporary test file capturing Prisma's query log) deleted its rows
and its tenant by explicit id, and the counts above confirm it. That file was removed —
`git status --porcelain` matches its starting state exactly, and `md5sum` on every file I
mutated is back to its pre-review value (`event.repository.ts` `6b2a27b4…`,
`event-processor.service.ts` `89c1fb33…`, `base.repository.ts` `13a533a2…`,
`stream.consumer.ts` `5d219908…`, `vitest.config.mjs` `56d3bfd7…`).

One environment observation, **not a finding against this change**: the repo-root `.env` sets
`DATABASE_URL` to the `postgres` superuser, while `.env.example:9` correctly documents
`telemetry_app` and `.env.example:12` documents `DIRECT_DATABASE_URL`. `.env` is gitignored, so
this is local dev config — but it means a locally-run `pnpm dev` worker writes these new
tenant-scoped rows with RLS inert. Tests are unaffected: `tests/setup.ts:6-8` pins
`telemetry_app` for `DATABASE_URL` and the owner for `DIRECT_DATABASE_URL`.

---

## Plan alignment

No scope creep. The diff is exactly the plan's file list, plus the S1 items, minus the epic's
`usage-line.repository.ts` (D4→A, reported as a divergence rather than silently dropped).
`base.repository.ts` and the other four services are untouched, as S-19 requires;
`known-gaps.md` is not edited, matching the plan's own statement that T-040 closes no gap.

The four Gate-2 decisions are each implemented in exactly one expression, in the pure parser, as
promised: D1 `metricKey: envelope.eventType`, D2 `periodStart = periodEnd = occurredAt`,
D3 `collectMetadata`, D4 one repository. I verified D1's premise independently:
`prisma/seed.ts:11`'s `DEFAULT_METRICS = ["api.request", "storage.write", "storage.read"]` carries
no unit suffix, and `docs/epics/epic-7-worker-service.md:143` does say `${event.eventType}.${event.unit}`
— though note it also says *"Adjust if Q1 decision specifies a different convention"*, which the
plan's "the epic is wrong" framing omits and which makes D1 less of a contradiction than stated.
Not a finding; if anything it strengthens D1.

---

## Recommended `known-gaps.md` entries (out of scope to fix here)

The plan's last checklist item is the reviewer's. Four candidates, using the next free ids —
**highest current is S-26, and ids are never reused**:

- **S-27 · No mechanism keeps worker's stream envelope in step with usage-service's
  `RESERVED_STREAM_FIELDS`** (MEDIUM). The structural half of MEDIUM-1: the sets match today
  (8/8, verified) but a producer-side addition silently lands in every event's customer-facing
  `metadata`. Q1's `receivedAt`/`source`/`version` are the named pending candidates. Fix
  direction: promote the set to `@telemetry/shared-types` alongside `EVENT_STREAM_CONSTANTS`, or
  add a parity assertion once it is exportable.
- **S-28 · The `UsageLine` tenant predicate has no behavioural test and cannot have one**
  (LOW). `UsageLine.eventId` is globally `@unique` and always an `Event.id`, a global primary
  key, so the cross-tenant address is unrepresentable and the bare-`{ eventId }` mutation is
  green across all eight integration cases — only `U51`'s shape assertion catches it. Record it
  so nobody deletes the predicate on the grounds that removing it is green, and so it is
  revisited if `eventId` ever stops being globally unique.
- **S-29 · `docs/epics/epic-7-worker-service.md`'s T-040 section diverges from the code in three
  ways** (LOW) — same class as S-17, different epic. `:114` names a
  `usage-line.repository.ts` the atomicity sentence at `:116` forbids; `:126` writes
  `where: { idempotencyKey }`, which `v1_6` has now made a compile error; `:143`'s
  `${eventType}.${unit}` yields `"api.request.request"`, matching no seeded `Meter`. Plus Q1's
  envelope (`receivedAt`, `source`, `version`, `payload`) is recorded as decided in
  `docs/epics/README.md` and is not on the wire. Fix direction: decide contract-first in each
  case; do not "fix" any of them by editing a test.
- **S-30 · `prisma/schema.prisma` omits the `@default("")` that `v1_3` gave
  `User.firstName`/`lastName`** (LOW, **pre-existing**, found incidentally). `prisma migrate
  diff --from-schema-datamodel … --to-url` reports exactly this one drift and nothing else;
  present at `7dc7392`, unrelated to T-040. The next `prisma migrate dev` would emit a spurious
  `DROP DEFAULT`. Mentioned so it does not evaporate — file it or don't, but it is not this
  change's.

---

## Decisions for the user

### Decision A — how to close HIGH-1

**Question:** the docstring at `stream-message.validator.ts:20` names `I19` as the case that
catches a repository writing the message's tenant id instead of its own, and no such case
exists. Fix the claim, or fix the gap?

| | Option | Diff impact |
|---|---|---|
| **A1** | **Add the divergent-tenant unit case (`U58`, ~10 lines) and repoint the sentence at it** | changes the diff: one new test + one comment line |
| A2 | Weaken the sentence only — "no test distinguishes these today" | changes the diff: one comment line; the property stays untested |
| A3 | Both A1 and a `known-gaps` entry for the integration-level version | as A1, plus a gap entry |

**Recommendation: A1.** The gap is a genuine untested invariant, not just a bad sentence, and it
is ~10 lines in a suite that already has the mocks and both tenant constants. It also makes
`U49`'s existing `not.toContain(OTHER_TENANT_ID)` negative meaningful, which today it is not.
A2 is honest but leaves the platform's core invariant resting on review alone.

### Decision B — scope of `fileParallelism: false`

**Question:** serializing *all* worker test files costs ~2.5× wall time (4.7–4.9 s vs 1.6–2.0 s)
to solve a collision between exactly two of them. Keep it package-wide, narrow it, or replace it?

| | Option | Diff impact |
|---|---|---|
| **B1** | **Keep `fileParallelism: false`; correct the comment to "5 of 5" and state the runtime cost** | changes the diff: comment only |
| B2 | Keep it, and additionally split the two integration files into their own vitest project so the nine unit files stay parallel | changes the diff: new config structure, and a `pnpm test` script change |
| B3 | Drop it; replace both suites' `FLUSHDB` with per-prefix key deletion | changes the diff substantially, and gives up the guarded-`FLUSHDB` chokepoint S-22 argues for |

**Recommendation: B1.** ~3 s on one package is not worth new config structure, and vitest 2.1.9
has no per-file grouping primitive that would make B2 clean. B3 is the one I'd actively argue
against: it still races on `afterAll` and it reopens exactly the hazard S-22 documents. B1 and
B2 are preference; **B3 changes behaviour** and would need its own review.

---

## Required for CONDITIONAL sign-off

- **R1** — Close HIGH-1 per Decision A (recommended: add `U58`, repoint `stream-message.validator.ts:20`).
- **R2** — Correct the false claim at `constants.ts:309-311` (MEDIUM-1) to what `U41` measures.
- **R3** — Append the Gate-3 outcome under plan §S4 (MEDIUM-2) and correct
  `vitest.config.mjs:27`'s "1 of 3" to the measured 5 of 5, with the runtime cost (MEDIUM-3).

LOW-1 through LOW-4 and both NITs are **recommended, not required** — dispositions above. Nothing
in the shipped code needs to change for correctness or isolation; I found no defect in it.

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| Concurrent workers on one idempotency key → `P2002` | **Accept.** Self-healing; loser throws, no `XACK`, retry reads the committed row. Bounded by T-041. Not raced on the compound index — inference. |
| A permanently-failing message retried forever (unknown tenant, unparseable entry, PK collision) | **Accept, T-041's.** Stated in the epic, in the plan's non-goals, and in three docstrings. `I18` pins the behaviour. |
| Worker's `withTenant` has no `TimeZone` pin (S-19) | **Accept.** Mitigated by the ORM-only commitment, whose measured half I confirmed from the bind log. The unmeasured half is LOW-3. |
| Producer/consumer envelope drift | **S-27.** Sets verified equal today. |
| `UsageLine` tenant predicate untested | **S-28.** Predicate kept; do not remove. |
| `RUN_DEADLINE_MS` tightened to 1 500 | **Accept.** Fails loudly, ~4× margin measured. |

---

## Round 2 — final

**Gate 6 — final review (post-QA).** Base `7dc7392`; subject is the uncommitted working tree
(21 paths, `git status --porcelain` identical before and after this review). Round 1 above is
left untouched. Every `file:line` below was re-derived against this tree after the post-QA
edits moved them.

**Verdict: CONDITIONAL.** The shipped code is correct and I found no new defect in it — no
tenant-isolation hole, no injection surface, no correctness bug, every gate green at 13/13 with
`--force`. Round 1's R1–R3 are all closed, and I re-derived each closure by mutation rather than
by reading. What still fails is, for the third round running, the change's *account of itself*:
**two universals in the change are refuted by execution**, and **Round 1's HIGH-1 claim survives
verbatim in the plan's AC table** after being fixed in the code. Required fixes are **R4** and
**R5**; both are prose, neither changes behaviour, and neither requires re-running the gates.

### Same finding class, three rounds running — say it plainly

| Round | The claim | How it failed |
|---|---|---|
| 1 (HIGH-1) | "`I19` is the case that fails when it does" | wrote the edit; package stayed 126/126 green |
| 2 (QA-1/QA-2/QA-3) | "four lines"; "would assert nothing on one of the two"; "6 of 8" | count short by the self-match; false for the case as written; stale ratio |
| 3 (MEDIUM-4/MEDIUM-5, below) | "`I8` … **always** with `NOGROUP`"; AC8 credits `I19` | `I9` failed with no `NOGROUP`; `I19` asserts role attributes, not the write invariant |

Every one is a **universal or a count** asserted from probes that varied one dimension. This is
not a new defect each time; it is one habit. Recommend it be treated as such at Gate 2 of the
next task rather than caught again at Gate 6 — see the disposition table.

---

## Findings

### MEDIUM-4 · `vitest.config.mjs:23-24` and `:35-37` — "always" and "every time" are both false, and the counter-example is the dangerous shape

```
:23  // stream mid-case. T-039's `I8` is the case that dies, always with
:24  // `NOGROUP No such key 'telemetry:events:t039:<pid>-<ts>-N'`.
...
:35  // So no single rate is the truth and this comment does not claim one. What is reproducible
:36  // is the *cause* — verified by the failure text naming T-039's per-run stream key every
:37  // time — and that `stream.consumer.integration.test.ts` run alone is 12/12 green.
```

Restated at `docs/plans/t-040-event-usageline-processor.md:814` ("the failure names T-039's
per-run stream key every time").

**Measured.** With `:53` commented out, 14 consecutive package runs on this host, otherwise
unchanged: **10 failed**. Nine were `I8` with `NOGROUP` as described. The tenth was **`I9`**:

```
FAIL tests/stream.consumer.integration.test.ts > StreamConsumer.run (live Redis)
  > I9 - neither the loop nor recovery ever delivers the pre-group backlog
AssertionError: expected [] to deeply equal [ '1789368476068-2' ]
 ❯ tests/stream.consumer.integration.test.ts:708:29
```

No `NOGROUP`. No stream key named. A **silently empty result** where the entry `I9` had just
`XADD`ed was flushed away before the consumer read it — the collision producing a *wrong answer*
rather than a loud error. One earlier run also failed **two** cases, so the blast radius is not
one case either.

This matters beyond wording: the comment tells the next reader what this collision looks like.
A reader who hits the `I9` shape will not recognise it, and the obvious next move is to chase it
as a T-039 consumer-loop bug. That is a review round spent on a phantom.

Four observers previously saw only the `I8`/`NOGROUP` shape (~24 runs between them), which is
exactly the "probes that varied one dimension" pattern `.claude/rules/review-standards.md`
names.

**Concrete fix**, `vitest.config.mjs:23-24`:

> `I8` is the usual casualty, with `NOGROUP No such key 'telemetry:events:t039:<pid>-<ts>-N'`.
> It is **not** the only one and the error is not always loud: in 14 runs at the Gate-6 review
> one failure was `I9` returning an empty handled-list (`expected [] to deeply equal [ '<id>' ]`)
> — the flush landed between its `XADD` and the read, so the collision produced a wrong answer
> rather than an error. Do not use `NOGROUP` as the signature.

and at `:36-37` replace "every time" with "in 9 of the 10 observed failures". Apply the same
correction to `docs/plans/…:814`.

**What is confirmed and should stay.** Everything else in that comment reproduces:
- The *cause* is real and structural — two live-Redis suites, one reserved logical database (14),
  both flushing it.
- `stream.consumer.integration.test.ts` run alone: **12/12 green**, re-run here.
- The refusal to name a rate is right, and is now stronger than when written: my 10 of 14 is a
  **fifth** distinct rate (against 1/3, 3/10, 5/5, 3/6). Resting the justification on the cause
  rather than a rate is the correct treatment and I endorse it. *(Brief item 2: confirmed.)*
- The cost figures reproduce to the digit: serial **5.08 / 5.08 / 4.94 / 5.14 / 5.04 s** over 5
  runs, parallel green runs **1.87–1.93 s** — ~2.6×, matching `:39-42`.
- `fileParallelism: false` at `:53` is the right fix and stays.

---

### MEDIUM-5 · `docs/plans/…:661` — the plan's AC8 row still names `I19` for the tenant-write invariant

Round 1's HIGH-1 was that `stream-message.validator.ts` named `I19` as the case catching a
repository that writes `payload.tenantId`. That was fixed in the code — the docstring now names
`U58` and `I21` (`stream-message.validator.ts:25-30`) and I verified both go red. **The same
false claim is still in the plan's acceptance table**, which is the artifact a reader consults to
decide whether AC8 is satisfied, and which ships in the commit:

```
:661 | **AC8** | Tenant isolation: … | `U48` (…), `I15` (…), `I19` (an entry whose `tenantId`
     is not the repository's cannot write — the S4(a) mutation's target) |
```

`I19` is `apps/worker-service/tests/event.processor.integration.test.ts:368`:

> `it("I19 - the subject's connection is a non-superuser, non-BYPASSRLS role and the policies are live", …)`

It asserts `rolsuper`/`rolbypassrls` on the subject's connection. It is a valuable case and it is
**not** what the row says it is. Neither `U58` nor `I21` — the two cases that actually carry AC8 —
appears in the row at all. The parenthetical "the S4(a) mutation's target" is doubly wrong: S4(a)
is the `UsageLine`-predicate mutation, which the plan itself records at `:580` as falsified and
caught only by `U51`.

QA's own AC table (`docs/qa/…` §4) lists AC8 as `U48, U58, I15, I19, I21` — the right set — so the
correction exists in the QA artifact and never travelled back to the plan.

**Concrete fix**, `docs/plans/…:661`, replace the third clause with:

> `U58` (the repository's bound tenant and the payload's tenant deliberately disagree; the
> `create` carries the bound one and `OTHER_TENANT_ID` reaches no bound value), `I21` (the same
> divergence against live PostgreSQL as `telemetry_app`: RLS `WITH CHECK` rejects the write with
> `42501`), `I19` (the subject's connection is `NOSUPERUSER`/`NOBYPASSRLS`, so the policies above
> are live rather than decorative)

---

### LOW-5 · `docs/plans/…:809-810` — QA-3's correction reached §6 S4 but not the §9 rework log

`:572` correctly reads **8 of 10**. `:809-810` still reads:

> (a) falsified, (b) confirmed, (c) confirmed with "every" corrected to 6 of 8

I re-measured independently: removing `await tx.$queryRaw\`SELECT set_config('app.tenant_id', …)\``
from `apps/worker-service/src/repositories/base.repository.ts:97` reddens **8 of 10** integration
cases, every one with `42501, new row violates row-level security policy for table "Event"`; 2
stay green. QA-3 is right and §6 S4 is right; only the §9 restatement is stale.
**Fix:** change `6 of 8` to `8 of 10` at `:810`.

---

### LOW-6 · `apps/worker-service/src/constants.ts:270-271` — the log-message census is off by one to two

> `StreamConsumer` writes fourteen distinct log messages; thirteen are named by exactly one
> production site and one test-local constant

Counted by parsing every `logger.(info|warn|error|debug)` call in
`apps/worker-service/src/events/stream.consumer.ts` with comments stripped: **16 call sites, 16
distinct messages** — 15 through `this.logger`, plus `buildDefaultMessageHandler`'s
`"Received stream entry; no processor is wired yet"` at `stream.consumer.ts:183`, which
`StreamConsumer` installs at `:295`. One of the 16 is now the promoted constant, so **15** remain
literals. Neither reading yields 14/13.

**The load-bearing half holds and I verified it message by message.** Every one of the other 15 is
at exactly **two** executable copies — one production site and one entry in
`tests/stream.consumer.unit.test.ts`'s `LOG_MESSAGE`. (`"Stream read failed"` greps as three; the
third is inside a comment at `stream.consumer.unit.test.ts:123`.) So only `HANDLER_FAILED` ever
crossed the three-copy threshold, exactly as claimed, and the promotion decision is correct.
**Fix:** "sixteen … fifteen", or drop the numerals and keep the property.

---

### LOW-7 · `.claude/rules/known-gaps.md:398-402` — this change falsifies S-19 and the diff edits that file without updating it

S-19 still states, in the file other agents are instructed to trust without re-verification:

```
:398 **How bad it is today, stated no stronger than measured:** latent, not live.
:399 `grep -rn "extends TenantScopedRepository" apps/*/src` finds exactly one real subclass in the
:400 whole repository — `UsageRepository` (…usage.repository.ts:150).
:401 The other four base classes have no subclass at all; …
:402 … So no query is wrong right now.
```

Re-run on this tree, that grep returns **two** real subclasses: `usage.repository.ts:150` and
`apps/worker-service/src/repositories/event.repository.ts:64`. Worker's base class now has a
subclass, and it is on a live data path. "Latent, not live" and "no query is wrong right now" are
both now claims about a world this change ends.

The diff already modifies `known-gaps.md` (it adds S-27 … S-31), so this is not a scope argument
about touching another file — it is the neighbouring entry in the file being edited.

**Fix:** amend `:398-402` to:

> **How bad it is today:** still latent for the *timestamp* defect, but no longer for want of a
> subclass. T-040 made `apps/worker-service/src/repositories/event.repository.ts:64` the second
> real subclass (`UsageRepository`, `usage.repository.ts:150`, is the first), and it is on a live
> data path. No query is wrong today because worker committed to the ORM for every timestamp
> (T-040's D-ORM) and writes no raw SQL — that commitment, not the absence of a subclass, is what
> stands between worker and S-18. The other three base classes still have no subclass.

---

### LOW-8 · `tests/event.repository.unit.test.ts:272` — "the only thing that catches it" contradicts the file it was written to support

```
:272  // The mutation this exists for, and the only thing that catches it: drop `this.where(...)`
```

`stream-message.validator.ts:25-30` says of the same mutation: "caught by **`U58`** … and by
**`I21`** …, and by nothing else." I performed the mutation: **exactly two** cases go red — `U58`
on the spy and `I21` at the database with `42501 … for table "Event"`. The validator docstring is
right; `U58`'s own comment reads as claiming sole custody.

**Fix:** `:272` → "The mutation this exists for. Caught here and by `I21`, which runs the same
divergence against live PostgreSQL, and by nothing else."

---

### NIT-3 · `vitest.config.mjs:40-41` — "Measured over 5 runs each", followed by six figures

`serial 5.07/5.07/5.14/5.17/5.20/5.24 s` is six values labelled five. Same arithmetic-in-its-own-account
class as QA-1 and LOW-6. Say "6 runs", or drop one figure.

### NIT-4 · my own Round 1, and QA §1 — `pnpm test:smoke` is 6 suites / **7** tests

Both rounds wrote "6 suites, 1 test each". Measured: `✓ tests/smoke.test.ts (2 tests)` for gateway,
1 each for the other five. Correcting my own record; no action on the change.

---

## The five items the brief asked me to rule on

### 1 · One assertion carrying two invariants — acceptable, do **not** split; add one sentence

**Verified, exactly as QA reported.** Three mutations, each run against the full worker suite:

| Mutation | Red |
|---|---|
| `Event` `create`: `this.where(...)` dropped, `tenantId: payload.tenantId` written | `U58` + `I21` (2 failed / 127 passed) |
| **`UsageLine`** `create`: same edit | `U58` + `I21` — `42501 … for table "UsageLine"` (2 failed / 127 passed) |
| `const { tenantId } = this.where({})` → `payload.tenantId` (the tenant-**read**) | **`U58` only** (1 failed / 128 passed); all 10 integration cases green |

The third fails at `event.repository.unit.test.ts:299`:

```
expected '[[[["SELECT set_config(\'app.tenant_i…' not to contain 'd4101ff1-8a17-47f7-9765-73c73ccf0441'
```

— i.e. `expect(bound).not.toContain(OTHER_TENANT_ID)`, and nothing else in the package.

**Ruling: acceptable as one assertion.** It is not two invariants bolted together; it is *one*
broad invariant — "the tenant id that travelled with the message reaches the database nowhere" —
which subsumes both edits. That is what a well-chosen negative is *for*, and splitting it into a
per-edit assertion would make the test weaker against the third edit nobody has thought of yet.
`.claude/rules/testing.md` explicitly asks for negatives of exactly this shape.

Two caveats, neither changing the ruling:

- **The read direction is a correctness defect, not only an isolation one**, and QA's "harmless in
  production" is right for the reason given but understates it. If the two ever diverged, the
  compound-unique predicate becomes self-contradictory (`"tenantId" = A AND … AND "tenantId" = B`),
  the idempotency lookup can never hit, and every replay would attempt a fresh insert and die on
  the primary key. Unreachable today because the factory derives the repository from
  `payload.tenantId` — but "the write still lands under the bound tenant" is not the whole story.
- **The failure message is opaque for that direction.** For the write edits you also get the
  `toBe` assertions, which name the values. For the read edit you get only a truncated JSON blob.

**Recommended (not required):** one sentence at `tests/event.repository.unit.test.ts:290-292`,
where the negative's own comment currently explains only why it beats `U49`:

> This negative also covers a **second, distinct** edit that the `toBe` assertions above do not:
> taking the lookup key's tenant from `payload.tenantId` instead of `this.where({})`. Measured at
> the Gate-6 review — that edit leaves all 10 integration cases and 128 of 129 tests green, and
> this line is the only thing that reddens. Do not weaken it to the assertions above it.

### 2 · MEDIUM-3's no-rate treatment — **confirmed honest; the cause claim holds, one clause of it does not**

See MEDIUM-4. The refusal to name a rate is correct and my 10-of-14 makes it a fifth disagreeing
measurement. The *cause* — two suites, one reserved database, both flushing — is confirmed. The
clause that fails is the claimed **signature** of that cause ("always … `NOGROUP`", "every time").

### 3 · The `Asia/Kolkata` finding — **the account is accurate, and the docstring instruction is right**

- Server default re-confirmed: `TimeZone|Asia/Kolkata|configuration file`, PostgreSQL 16.13. The
  whole T-040 integration suite has indeed been running non-UTC.
- **QA-2's replacement comment at `event.processor.integration.test.ts:425-437` is accurate.** I
  re-ran QA's mutation: with `INTEGRATION_PROCESSOR_SESSION_TIME_ZONE` pinned to **UTC** and the
  offset-discard mutation applied, `I22` fails **identically** —
  `2026-01-01 00:00:00 | 2026-01-01 05:30:00 | 2025-12-31 19:00:00: expected 3 to be 1`. Under the
  shipped `America/New_York` the message is byte-identical. So the pin is genuinely not what
  catches today's mutation, and the new comment says so.
- **`integration.constants.ts:379-386`'s "Do not describe it as the thing that makes `I22` work" is
  correct and should stay.** The pin's stated value is forward-looking — the case already runs
  where a *future* raw-SQL cast would be caught — and it is stated as a rationale, not as a
  measurement. That is the honest form.
- Under the shipped config the mutation still reddens both layers, verbatim:
  `U40: expected '2026-01-01T05:30:00.000Z' to be '2026-01-01T00:00:00.000Z'`;
  `I22: … expected 3 to be 1`. Round 1's LOW-3 is closed.

### 4 · S-19 — byte-identity intact; **release-readiness: ship**

```
13a533a2e2c2dcc1ff9db28fb5c7a1fd  analytics/…/base.repository.ts
13a533a2e2c2dcc1ff9db28fb5c7a1fd  billing/…/base.repository.ts
13a533a2e2c2dcc1ff9db28fb5c7a1fd  worker/…/base.repository.ts     <- the hash S-19 records
8b12b7d5…  auth   (comments only)      d2e8d92f…  usage (the S-18 pin)
```
`grep -c TIME_ZONE` → 1 for usage, 0 for the other four. `git status --porcelain` lists no
`base.repository.ts`. S-19 respected in full; worker becomes its first live subclass without
editing the copy.

**Explicit call: ship.** The ORM-only commitment is a real mitigation, not a promise:
- `grep`ed `apps/worker-service/src` — the **only** raw SQL in the service is
  `base.repository.ts:97`'s `set_config` tagged template, which binds `this.tenantId` and takes no
  timestamp. T-040 adds none.
- Both timestamp columns are written through Prisma's ORM path, which `CLAUDE.md` § *Raw SQL and
  timestamps* records as measured-safe, and `I22` now proves it across `+05:30`, `-05:00` and `Z`
  on a session pinned to a third zone, reading `::text` off the columns through the owner
  connection.
- The mitigation is documented where it binds: `stream-message.validator.ts:201-204` (D-ORM) says
  no timestamp may enter raw SQL in this service *because* `withTenant` has no pin.

The residual is that the commitment is a convention with no mechanism. Bounded, and the right
place to close it is the S-19 shared-package task, not here. **Disposition: accept, with LOW-7 to
keep S-19 honest about being live.**

### 5 · Coverage alignment — the measured number, and what is genuinely untested

`vitest run --coverage`, worker-service (exclusions are **pre-existing**, not in this diff):

| | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| **All measured files** | **96.17** | **88.67** | **87.50** | **96.17** |
| `src/validators/stream-message.validator.ts` | 97.14 | 93.33 | 100 | 97.14 |
| `src/services/event-processor.service.ts` | 100 | 91.66 | 100 | 100 |
| `src/repositories/event.repository.ts` | 100 | 83.33 | 100 | 100 |
| `src/repositories/base.repository.ts` (pre-existing) | 77.77 | 77.77 | 66.66 | 77.77 |

Thresholds 80/80/80/75 — satisfied. All three new `src/` files are inside the measured set.

**Unmeasured, and what stands in — each confirmed load-bearing by mutation here:**
- `src/events/**` (the `dispatch` → handler seam). Stood in for by `U46`: deleting the 5th
  constructor argument at `index.ts:112` reddens it (`1 failed | 12 passed`). Also by `I17`/`I18`,
  which drive the real consumer against live Redis and read `XPENDING` rather than a spy.
- `src/config/container.ts` (DI wiring). Stood in for by `U57`
  (`tests/config/container.unit.test.ts:25`).
- `src/index.ts`. Same `U46`.

**Genuinely untested arms that matter, in order:**
1. `event.repository.ts:174` — the `?? event.quantity` right arm is the file's **only** uncovered
   branch (83.33%). Coverage now gives objective evidence for what Round 1's LOW-2 argued from the
   column definition: the arm is dead. **Declined by decision** — see dispositions.
2. `event-processor.service.ts:140` — the non-`Error` arm of
   `error instanceof Error ? error.message : String(error)` in the ack-failure log. Reachable in
   principle (ioredis can reject with a non-`Error`); one line, no test.
3. `stream-message.validator.ts:144-145` — the `noUncheckedIndexedAccess` `continue`. Documented
   unreachable at `:139-142`, and the reasoning for preferring `continue` to a cast is correct.
   Accept.

---

## What I verified by execution this round

**Gates — all 13 packages, `--force`, 0 cached, on the tree as reviewed (`md5sum -c` clean
across 398 files after every mutation cycle):**

| Task | Result |
|---|---|
| `pnpm typecheck --force` | 13 successful, 13 total · 0 cached |
| `pnpm lint --force` | 13 successful, 13 total · 0 cached — 14 warnings, **0 errors** |
| `npx turbo run build --force` | 13 successful, 13 total · 0 cached |
| `pnpm test --force` | 13 successful, 13 total · 0 cached |
| `pnpm test:smoke` | 6 suites, **7** tests, all passed (NIT-4) |

Per package: shared-types 8 · shared-config 4 · shared-validation 15 · shared-logger 4 ·
shared-tracing 2 · shared-utils 18 · analytics 18 · billing 18 · gateway 38 · usage 230 ·
auth 164 · **worker 129 (11 files)** · web `--passWithNoTests`. **Worker matches the stated
baseline exactly.**

**The 14 warnings are pre-existing, proved two ways.** 10 × `no-misused-promises` in
`apps/auth-service/tests/auth.service.unit.test.ts` (`git log -1` → `d68e719`); 4 ×
`no-unsafe-assignment` in `apps/usage-service/tests/ingestion.service.unit.test.ts`
(`git log -1` → `b0f6921`). Neither file appears in `git status --porcelain` for this change.
**Zero `no-unsafe-return`.** No new warning of any kind.

**The post-QA edits, re-derived independently:**
- **QA-1 · correct.** `grep -rn "RESERVED_STREAM_FIELDS" apps packages --include=*.ts` excluding
  `dist/` returns **five**, and the breakdown at `constants.ts:339-344` is right hit for hit:
  producer declaration (`ingestion.service.ts:15`), producer use (`:153`), and three prose
  comments — `constants.ts:329`, `constants.ts:339` (which carries the pattern and so matches
  itself), and `tests/stream-message.validator.unit.test.ts:19`. The third is a **file docstring**,
  so the adjoining "No test references it" is not self-contradictory. S-27's list markup and
  two-space continuation indentation survived intact (`cat -A`: no stray tabs, bullets well-formed).
  The 8/8 same-order set equality re-checked side by side.
- **QA-2 · correct**, measured — see item 3.
- **QA-3 · correct** for §6 S4, measured at 8 of 10 — but see LOW-5 for the copy it missed.
- **S-31 · every claim holds, and the safety claim is stronger than stated.** Probed the real
  `envelopeSchema` with a sentinel value in all seven fields plus an unknown key *named* the
  sentinel: `issues[].path` was `[["eventId"],["tenantId"],…]` and the sentinel appeared **nowhere**
  in `JSON.stringify(issues)` — not in `path`, and not in `message` either, since
  `z.string().uuid()`/`.min(1)`/`.regex()`/`.datetime()` all emit fixed text. So the entry's hedge
  ("`code`, not `message`, if the wording is a concern") is more cautious than necessary, which is
  the right direction to err. `:196-198` and `:127-129` confirmed as the two fixed strings, and
  `:188-191` confirmed as the docstring that already assigns retry-forever to T-041. **LOW is the
  right severity**: nothing tenant-bearing is emitted today, which is what the entry says.

**Isolation and RLS, from the live database:**
- `telemetry_app` is `rolsuper = f`, `rolbypassrls = f` in `pg_roles`. Independently corroborated
  behaviourally: removing `set_config` produced real `42501` policy violations, which a superuser
  connection could not produce.
- `Event` and `UsageLine` both `relrowsecurity = t` **and** `relforcerowsecurity = t` — not the
  `FORCE`-without-`ENABLE` shape S-10 documents for `RefreshToken`.
- `withTenant` issues `set_config('app.tenant_id', $1, true)` as its first statement, bound not
  interpolated (`base.repository.ts:97`).
- Repository is a **factory**, never a singleton (`container.ts:52-53`), and `U57` pins it.
- Only raw SQL in `apps/worker-service/src` is that one tagged template. T-040 adds none. No
  `Prisma.raw`, no interpolation, no enum-varied SQL. **No injection finding.**

**Migration and release readiness:**
- `prisma migrate status` → `7 migrations found` · **`Database schema is up to date!`**
- `migrate diff --from-schema-datamodel … --to-url` emits **one** statement, and it is the
  pre-existing `User` default drift (S-30). **Nothing about `Event`** — so
  `@@unique([tenantId, idempotencyKey])` and the hand-written index name agree exactly. **AC10 holds.**
- Live: `Event_idempotencyKey_key` **gone**;
  `CREATE UNIQUE INDEX "Event_tenantId_idempotencyKey_key" … USING btree ("tenantId", "idempotencyKey")`
  present. `pg_constraint` on `"Event"` = `Event_pkey`, `Event_tenantId_fkey` only — "index, not
  constraint" confirmed. Forward-only. `Event`/`UsageLine` at 0 rows before and after, so the
  no-backfill claim stands.
- **Index coverage for the new paths.** The `findUnique` reads `("tenantId","idempotencyKey")` —
  precisely the new unique btree. The `UsageLine` lookup reads `("eventId","tenantId")` — covered by
  `UsageLine_eventId_key`. One extra unique-index probe inside a transaction that already exists.
- **S-29's compile-error claim re-derived verbatim**: writing the epic's `where: { idempotencyKey }`
  yields `error TS2322 … is missing the following properties … id, tenantId_idempotencyKey`.
  `TransactionClient` confirmed declared without `export` in all five `base.repository.ts`.
- **Breaking-change assessment across the other 12 packages: none.** No Prisma access to `Event` or
  `UsageLine` outside `event.repository.ts:117/127/153` — the only other `tx.event.` hits are the
  docstring example inside each `base.repository.ts`. usage-service's `idempotencyKey` uses are the
  Redis dedup path and validators, not `Event` queries. The dropped global unique has no other
  consumer. usage 230 and auth 164 green.

**Regression — T-038's bootstrap and T-039's loop:**
- All ids present and unrenamed: `I1`–`I22`, `U1`–`U56`, `U58` (`U57` lives in `tests/config/`).
  `I1`–`I12` and `U1`–`U38` are T-038/T-039's and are intact.
- `git diff` on the three pre-existing test files removes **no** `it(`, `describe(` or `expect`
  line — only the S1 hygiene items (`RUN_DEADLINE_MS` 3 000 → 1 500, two `CALLS.NONE`-as-duration
  sites) and `U46`'s harness.
- `stream.consumer.integration.test.ts` alone: **12/12**. Full worker suite serial: **129/129 on
  five consecutive runs**.

**Clean-code gate (REQUIRED):** swept the three new `src/` files and `container.ts` for string and
numeric literals outside comments and imports — **none**. The one numeric hit, `container.ts:37`'s
`maxRetriesPerRequest: 2`, is pre-existing (`git log -1` → `3658ca8`, absent from this diff). The
four new test files contain no bare HTTP-status or count literals. Round 1's LOW-1 is closed:
`"Stream entry handler failed"` is now `WORKER_STREAM_READ.LOG.HANDLER_FAILED`, referenced from
`stream.consumer.ts:772` and `event.processor.integration.test.ts:688`, with the unit test's copy
deliberately retained and the reason documented. **Findings: LOW-6 (a miscount in a constants
docblock) and nothing else.** No BLOCKER, no HIGH.

**Test honesty:** looked specifically for the S-3 shape — no early `return`/`skip` on a condition
true when the bug is present. `flushReservedDb` (`event.processor.integration.test.ts:118-128`)
re-asserts `CLIENT INFO` contains `db=14` on **every** call, which is the corrected S-22 shape, and
its docstring scopes itself honestly to "a chokepoint, not an impossibility". `onlyCallArgs` and
`allLogCalls` throw on absence. `U58` asserts its own premise before the behaviour. Fixtures clean
up by explicit id in `afterEach` **and** `afterAll` — the half S-20 records auth-service missing.

---

## What I could **not** verify, and why

- **The concurrent-writer race on the compound index.** Not raced; two workers were never run
  against one key. The `P2002`-then-self-heal argument remains **inference**. Same limitation both
  prior rounds recorded; bounded by T-041.
- **A genuinely UTC *server*.** The brief forbids stopping PostgreSQL, so I pinned *sessions*
  (UTC and `America/New_York`) against a server whose default is `Asia/Kolkata`. `I22` brings its
  own pin and asserts it took effect, which is what makes CI's UTC default immaterial — but that
  is reasoning, not a measurement on a UTC server.
- **CI.** Local only. The CI job applies migrations as the owner before any test step; `v1_6` needs
  `DROP INDEX`/`CREATE UNIQUE INDEX`, which the migration role has here. I did not exercise CI's
  role configuration.
- **`vitest.config.mjs:45-52`'s claim that vitest 2.1.9 offers no per-file grouping primitive.**
  Read as reasoning, not re-derived against the vitest source. It matches my understanding and
  nothing rests on it beyond the choice already made.
- **Whether the `I9` failure shape has other variants.** I observed one non-`NOGROUP` failure in 14
  runs. MEDIUM-4's fix should say "not the only one", not enumerate a complete set.

---

## Environment — before and after

Postgres and Redis were never stopped. Every database write probe ran through the test suites'
own fixtures, which delete by explicit id; the schema was never altered.

| | Before | After |
|---|---|---|
| db 0 `XLEN telemetry:events` | 2 | **2** |
| db 0 `entries-added` | 2 | **2** |
| db 0 consumer groups | 0 | **0** (`XINFO GROUPS` → `[]`) |
| db 0 `DBSIZE` | 1 | 2 |
| db 14 `DBSIZE` | 0 | **0** |
| `Event` / `UsageLine` | 0 / 0 | **0 / 0** |
| `Tenant` / `User` | 2 / 2 | **2 / 2** |

db 0's `DBSIZE` 1 → 2 is one `denylist:99481bf8…` key with `TTL 57` at the final check, written by
auth-service's suite during my root `pnpm test --force`. **That is S-22, not this change**, and it
self-expires. The platform stream is untouched. Every `FLUSHDB` the worker suites issue went
through `flushReservedDb()`.

**Tree integrity:** `md5sum -c` over 398 files → clean after every mutation cycle and at the end.
`git status --porcelain` byte-identical to the state I started from (21 paths). All five
`base.repository.ts` at their starting hashes. The one temporary probe file
(`tests/zzprobe.test.ts`, for the zod `issues[].path` measurement) was deleted and does not appear
in `git status`.

---

## Required for CONDITIONAL sign-off

- **R4** — Correct MEDIUM-4: `vitest.config.mjs:23-24` and `:36-37`, plus the restatement at
  `docs/plans/…:814`. The `I9` counter-example must be named; the signature must stop being stated
  as universal.
- **R5** — Correct MEDIUM-5: `docs/plans/…:661`'s AC8 row, replacing `I19`'s false attribution with
  `U58` and `I21` and restating what `I19` does assert.

Neither changes behaviour. **No test asserts any of these strings** — `U50` imports
`vitest.config.mjs` at runtime but reads only `testTimeout` — so **the gates do not need re-running**
after R4 and R5. Both are comment/markdown edits.

**Recommended, not required:** LOW-5, LOW-6, LOW-7, LOW-8, NIT-3, and the one-sentence addition to
`U58` under item 1. LOW-7 is the one I would most like taken, because it is in the authoritative file.

---

## Dispositions

| Item | Disposition |
|---|---|
| Round 1 **HIGH-1** | **Closed.** `U58` + `I21` added; mutation re-run here, exactly 2 red, `I21` at the database with `42501`. The claim's echo in the plan is **MEDIUM-5**. |
| Round 1 **MEDIUM-1** | **Closed.** `constants.ts:334-346` now states what is measured; S-27 filed and its 8/8 set equality re-verified. |
| Round 1 **MEDIUM-2** | **Closed** at `docs/plans/…:564-598`. The stale echo at `:809` is **LOW-5**. |
| Round 1 **MEDIUM-3** | **Closed in substance** — no rate claimed, cause-based, cost stated, all re-measured. The signature clause is **MEDIUM-4**. |
| Round 1 **LOW-1** | **Closed.** `WORKER_STREAM_READ.LOG.HANDLER_FAILED`; three sites reconciled, unit-test copy deliberately retained with the reason. |
| Round 1 **LOW-3** | **Closed.** `U40` (both offset signs) and `I22`; both re-run red here, verbatim. |
| Round 1 **LOW-2** / QA-4 | **Declined by user decision. Not re-raised.** Recorded only that coverage has since made it objective: `event.repository.ts:174` is the file's sole uncovered branch. The comment's "the `usageLine` read is what proves the two rows agree" still describes something the code does not do. Carry to the next change that touches the method. |
| Round 1 **LOW-4** (wire `eventId` colliding with an existing `Event.id`) | **Declined by user decision.** Still inference — I did not construct the case this round either; usage-service mints a fresh `eventId` per publish. Joins the retry-forever set, which is T-041's. |
| Round 1 **NIT-1** (`not.toBeInstanceOf(Prisma.Decimal)` after `typeof … === "string"`) | **Declined by user decision.** Vacuous but harmless. |
| Round 1 **NIT-2** (`RUN_DEADLINE_MS: 1_500`) | **Declined by user decision.** Fails loudly; five serial runs at 4.94–5.14 s total with no deadline miss. |
| QA-6 (quantity scale/precision boundaries) | **Declined by user decision.** Unreachable today — usage-service constrains `quantity` to an integer in `[1,100]` (S-17). Precision overflow would raise `22003` and join the retry-forever set. |
| **S-31** | **Accept as filed, at LOW.** Claims verified by execution, including the zod-path probe. |
| Concurrent workers on one idempotency key → `P2002` | **Accept.** Self-healing; loser throws, no `XACK`. **Inference, not measured** — third round running. Bounded by T-041. |
| Permanently-failing message retried forever | **Accept, T-041's.** Now also recorded as S-31. |
| Worker's `withTenant` has no `TimeZone` pin (S-19) | **Accept, ship.** See item 4. **LOW-7** keeps S-19 honest about no longer being latent. |
| Producer/consumer envelope drift | **S-27.** Sets re-verified equal, 8/8, same order. |
| `UsageLine` tenant predicate untested | **S-28.** Predicate kept; do not remove. |
| Three rounds of the same claim class | **Escalate, don't re-find.** See the decision below. |

---

## Decisions for the user

### Decision C — the recurring claim class

Three rounds have each found a universal or a count in this change that execution refutes. The
code has been right every time; the prose has not.

| | Option | What changes |
|---|---|---|
| **C1** | **Add one line to `.claude/rules/review-standards.md`'s universals table** citing this task: *"`I8` is the case that dies, always with `NOGROUP`" — in 14 runs one failure was `I9` with an empty result and no error.* | changes the diff: one row in an authoritative file |
| C2 | Add a Gate-3 self-check to `docs/task-implementer-workflow.md`: every numeral and every "always/only/never" in a comment must cite the command that produced it | changes the diff: workflow doc; affects future tasks, not this one |
| C3 | Fix R4/R5 and move on; treat it as three coincidences | no extra diff change |

**Recommendation: C1.** The table in `review-standards.md` exists precisely to accumulate these,
every row in it came from a shipped-and-refuted claim, and this one has the most instructive shape
in the table — four observers, ~24 runs, one dimension, and the counter-example was the *silent*
failure rather than the loud one. C2 is a bigger swing and I would not fold it into T-040.
**C1 and C2 change the diff; C3 does not.** None changes behaviour or requires re-running gates.

### Decision D — a release note for `v1_6`

T-040 ships a migration with a deploy-ordering constraint, and `docs/releases/` currently holds
exactly one entry (`s-007-…`, a role change) — so the repo's precedent is "release notes for
infrastructure changes", and T-036 through T-039 have none.

The ordering is real: `v1_6` must be applied **before** any worker starts, and because migrations
are forward-only there is no down step — reverting would mean a new migration recreating a global
unique, which can fail outright once two tenants hold the same key.

| | Option | What changes |
|---|---|---|
| **D1** | **Write `docs/releases/t-040-event-usageline-processor.md`** — apply `v1_6` as the owner before deploying worker; no rollback lever, and why | changes the diff: one new doc |
| D2 | Fold the ordering into the commit message body only | changes the diff: commit message |
| D3 | Nothing — the migration is self-evidently ordered and prior task commits set no precedent | no diff change |

**Recommendation: D1**, narrowly. This is the first task in the sequence to ship a schema change
with a no-rollback property, and `CLAUDE.md` names `docs/releases/` as the home for exactly
"ordered deploys, rollback levers". But this is **process preference, not a defect** — D2 and D3
are entirely defensible and **none of the three changes code, tests, or gate results.** If you pick
D3, say so and I will not raise it again.

---

**Verdict: CONDITIONAL** — R4 and R5, both prose, neither requiring a re-gate. The shipped code,
the migration, the tenant-isolation guards and the test suite are all in a state I would sign off
today; what is holding the gate is that the change still misdescribes two things about itself, one
of which is the very claim Round 1 raised as HIGH. Apply R4 and R5, answer Decisions C and D, and
this is **APPROVED FOR COMMIT** without another full round — the LOWs and NITs can ride along or be
dropped at your discretion.
