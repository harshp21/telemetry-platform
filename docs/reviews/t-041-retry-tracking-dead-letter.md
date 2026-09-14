# Review — T-041 · Retry tracking + dead-letter handler

Base `c88a933` (T-040). Subject: the uncommitted working tree (19 modified, 4 untracked).
Read-only review; every mutation below was reverted and the tree proven byte-identical.

---

## Round 1

**Verdict: CHANGES REQUESTED** — one HIGH and five MEDIUM findings, all documentation/claim
or test-harness defects. No blocker in the shipped behaviour: the retry policy, the dead-letter
write, the ordering guarantee and the reclaim cadence are correct, and I reproduced the
implementer's mutation set rather than taking it on report. The required fixes are listed at
the end.

---

### Findings

#### HIGH

**H-1 · `.claude/rules/known-gaps.md:988-1018` — S-31 is fully closed by this change and was not removed.**

S-31 is titled "A malformed stream message is undiagnosable, **and retries forever**". Both
halves are now fixed:

- diagnosis — `src/validators/stream-message.validator.ts:234-236` appends
  `describeIssues(parsed.error.issues)`, verified red under mutation (see *What I verified*);
- retries-forever — the wrapper is wired into production at
  `src/config/container.ts:101` and `src/index.ts:122`, so a malformed entry is dead-lettered
  and `XACK`ed after `MAX_RETRY_COUNT` failures.

`known-gaps.md`'s own header says "Update this file when an item is fixed (remove it)", and
`.claude/rules/` is designated authoritative — another agent is instructed to trust it without
re-verification. Leaving S-31 open makes an authoritative file assert a live hole that no
longer exists; the next agent in this area will either re-implement it or write around a
protection it believes is absent.

**Fix:** delete lines 988–1018 of `.claude/rules/known-gaps.md` in this commit. The id is
retired, never reused; the record is `docs/plans/t-041-retry-tracking-dead-letter.md` and this
file. Note S-31's own text says "T-041 will stop the infinite retry, but a dead-lettered
message with no diagnosis is still undiagnosable" — T-041 did both, so there is no residual to
re-file.

---

#### MEDIUM

**M-2 · The db-0 escape fix is incidental, not structural — and I reproduced the escape.**

`apps/worker-service/tests/config/container.unit.test.ts:67-76` stubs six Redis commands. That
is exactly the set `DeadLetterService` issues today, enumerated by hand. Nothing mechanically
prevents the seventh.

Measured, three ways:

1. As shipped, the case issues **zero** Redis commands — `redis-cli MONITOR` over the whole
   run recorded only the `OK` handshake line.
2. The apparent connection-count deltas are ambient: a control run of
   `tests/config/prisma.singleton.unit.test.ts` and a bare 4-second idle window each showed the
   same `total_connections_received` delta of 1.
3. **With one stub removed** (`hincrby`, the exact command that escaped during implementation)
   the case issues a real command. Run against db 13 so db 0 stayed clean, `MONITOR` recorded:

   ```
   [13 127.0.0.1:51480] "select" "13"
   [13 127.0.0.1:51480] "hincrby" "retries:telemetry:events" "1789101023800-0" "1"
   ```

   and `redis-cli -n 13 KEYS '*'` afterwards returned `retries:telemetry:events`. (Key deleted;
   db 13 back to `DBSIZE 0`.)

The database that command lands on is decided by `apps/worker-service/tests/setup.ts:9`:
`process.env.REDIS_URL ??= "redis://localhost:6379"` — **no logical database index, therefore
db 0**, the live event stream's database. `createContainer` (`src/config/container.ts:60-64`)
builds a real `lazyConnect` ioredis client against it.

Two further reasons the protection does not generalise:

- `vi.spyOn` patches one *instance*. Each `createContainer` call returns a fresh client, so the
  stubs cover exactly the one test that installed them. Any future case in this file that
  builds a container and drives `container.messageHandler` starts unstubbed.
- `afterEach` is `vi.clearAllMocks()` (`:26-28`), not `restoreAllMocks()`, so this is not even
  a per-file guarantee of a clean slate — it is per-instance by accident of construction.

This is S-22's hazard class with a write path attached, and worker-service's reserved-database
convention (`tests/integration.constants.ts:55`, `LOGICAL_DB_INDEX: 14`, every `FLUSHDB`
through `flushReservedDb`) covers only the *integration* suites. `createContainer` is outside
it.

**Fix (structural, one line):** `apps/worker-service/tests/setup.ts:9` →
`process.env.REDIS_URL ??= "redis://localhost:6379/14";`. The integration suites already
override `REDIS_URL` with their own reserved-db URL (`tests/event.processor.integration.test.ts:226-227`),
so nothing there changes; what changes is that an unstubbed command from a *unit* test lands in
the reserved database rather than on the developer's event stream. Keep the enumerated stubs as
well — they are what makes the case assert composition — but they stop being the only thing
standing between this suite and db 0.

**M-3 · `src/constants.ts:290-292` — the `RECOVERY_MAX_PAGES` docblock was falsified by S5 and not corrected.**

Current text:

> "At the default `STREAM_BATCH_SIZE` of 10 it admits 10 000 entries **per startup**, and a
> truncated scan is logged at warn level and **retried on the next restart** — the same
> best-effort stance the rest of recovery takes."

Both italicised claims were true of a startup-only `recoverPendingEntries` and are false now.
`runLoop` calls it again every `blockMs × RECOVERY_IDLE_MULTIPLIER`
(`src/events/stream.consumer.ts:474-478`), so the bound is per *pass*, not per startup, and a
truncated scan is retried every ~10 s at the shipped defaults rather than on the next restart.

This has an operational consequence, not only a wording one. The truncation `warn`
(`src/events/stream.consumer.ts:725-733`, "Stopped reclaiming pending stream entries at the
page limit") and the recovery `error` (`:752-760`, "Failed to reclaim pending stream entries")
now repeat once per cadence window for as long as the condition holds, instead of once per
process start. A PEL above 10 000 entries, or a Redis fault that only affects `XAUTOCLAIM`,
becomes a steady log stream. Reasoned from the code paths, not measured under load.

**Fix:** rewrite `:290-292` to say "10 000 entries **per recovery pass**", "retried on the
**next cadence pass** (`blockMs × RECOVERY_IDLE_MULTIPLIER`)", and add the log-repetition
consequence in one sentence so it is a decision rather than a surprise.

**M-4 · `src/events/stream.consumer.ts:704-707` — the fourth stranded claim, in the file the plan swept.**

The plan's F1 named three sites and S5 corrected all three (verified below). This is a fourth,
in the same method, and it was missed:

> "Between pages rather than at the top of the loop, deliberately: `run()` checks **immediately
> before calling this**, so a check before the first page would be the same check twice, and one
> page of recovery is bounded work."

True of the startup call site (`:462`, which follows `runLoop`'s guard). False of the cadence
call site (`:476`): the most recent `shouldStop()` there is the previous iteration's
`while (!this.shouldStop())` at `:479`, separated by a full `readBatch` that blocks for up to
`STREAM_BLOCK_MS`. The stated justification for the guard's placement no longer holds for one
of the two callers, which is precisely the defect class F1 exists about.

The behavioural exposure is small and I want to be exact about it rather than overstate it:
`isShutdownInterrupt` (`:569-575`) is keyed on `stopRequested`, not on `isShuttingDown()`, and
`src/index.ts:59-67` sets `shuttingDown = true` and then `await streamConsumer?.stop()` with
only a synchronous log between them — so in practice `stop()` disconnects the read connection,
`readBatch` returns `interrupted`, and the loop breaks before the cadence check. The
consequence is at most one unnecessary `XAUTOCLAIM` page in a narrow window, and the
between-pages guard catches it after that page.

**Fix:** correct the comment — state that the check is now *not* immediately preceded by a
`run()` guard on the cadence path, and that the between-pages guard is therefore the first
check that pass makes. Optionally add `if (this.shouldStop()) { return; }` at the top of
`recoverPendingEntries` and delete the "same check twice" argument, which is the cheaper way to
make the comment true again.

**M-5 · `src/constants.ts:551-553` — a universal the diff refutes with its own code.**

> "…what makes entry ids server-assigned here is that the workspace's **single production
> `xadd` call site** — `apps/usage-service/src/events/stream.publisher.ts` — passes `"*"`."

`grep -rn "\.xadd(" apps packages --include=*.ts`, excluding `dist/` and `tests/`, returns
**two** production call sites as of this tree:

```
apps/worker-service/src/services/dead-letter.service.ts:192
apps/usage-service/src/events/stream.publisher.ts:70
```

The second one is this change's own. The *substance* of the claim survives — the argument is
about ids on the **source** stream, whose only producer is still the publisher, and the new
call site also passes `*` via `WORKER_DEAD_LETTER.ENTRY_AUTO_ID` — but the sentence as written
is false, in a docblock shipped alongside the code that falsifies it. This is the exact
"the only place" shape `.claude/rules/review-standards.md` § *Universals Must Cite Their
Mutation* lists.

**Fix:** "…the only production `xadd` **onto the source stream** — `stream.publisher.ts:70` —
passes `"*"`; this service's own `xadd` (`dead-letter.service.ts:192`) writes to a different
stream and also passes `"*"`."

**M-6 · `DEAD_LETTER_STREAM === REDIS_STREAM_NAME` is a documented "must not" with no mechanism.**

Three places assert it and none enforces it:

- `src/constants.ts:91-93` — "deliberately **not** derived from `DEFAULT_STREAM_NAME`: a dead
  letter written back onto the source stream would be redelivered, fail again, and dead-letter
  itself forever."
- `.env.example:97-99` — "Must NOT be `REDIS_STREAM_NAME`".
- `tests/env.schema.unit.test.ts:378-381` — asserts the inequality, but only between the two
  **defaults**.

`grep -n "superRefine\|refine" src/config/env.ts` → no match. An operator setting both to the
same value parses cleanly and starts. The failure mode is self-amplifying rather than merely
wrong: each dead-lettered entry writes a new entry onto the stream the worker reads, that entry
fails to parse (its fields are `originalId`/`streamName`/…, not an envelope), and after three
failures it dead-letters itself — one new entry per three failures, forever. Reasoned from the
code paths, **not measured**; I did not run a live loop with the two names equal.

Note this is the same strictness argument the change makes well elsewhere: `.min(1)` on
`DEAD_LETTER_STREAM` was added specifically because S-23 records usage-service lacking it, and
the refuting mutation was run. The cross-field invariant got the documentation but not the
guard.

**Fix:** add to `src/config/env.ts`:

```ts
.superRefine((env, ctx) => {
  if (env.DEAD_LETTER_STREAM === env.REDIS_STREAM_NAME) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DEAD_LETTER_STREAM"],
      message: WORKER_STREAM_CONSTANTS.DEAD_LETTER_STREAM_COLLISION });
  }
})
```

with the message as a new `WORKER_STREAM_CONSTANTS` member, plus one env-schema case, and run
the refuting mutation (delete the refinement → the new case red).

---

#### LOW

**L-1 · `docs/plans/t-041-retry-tracking-dead-letter.md:564` — AC6's proof column overclaims `U71`.**

AC6 is "A failed entry is retried inside one `run()`, with no restart", proven by
"`U70`, `U71`; `I23`". Measured: with the cadence block deleted from
`src/events/stream.consumer.ts:474-478`, `U70` and `I23` go red by assertion
(`expected 1 to be greater than or equal to 2`) and **`U71` stays green**. `U71` reddens only
under the over-correction (`if (true || …)`), which I also ran.

The implementer's disclosure is honest and I would not reshape the case — it guards a real
over-correction and its title says so ("does **not** reclaim on every iteration"). What needs
fixing is the AC map, which presents a test that is green on the unfixed code as evidence for
the fix. **Fix:** move `U71` out of AC6's proof cell into its own row, e.g. "AC6b · the cadence
is the idle threshold, not the read — `U71` (green before the fix; reddens under an
unconditional reclaim)".

**L-2 · `src/events/stream.consumer.ts:646` and `:654` — two more claims the cadence weakened.**

`:646` "a single call leaves everything past the first `COUNT` stranded **until the next
restart**" and `:654` "…one that starts and reclaims **on the next restart**". Both now read
"until the next cadence pass". These understate rather than overstate, so they are LOW, but
they sit in the same docstring S5 rewrote and should have moved with it.

**L-3 · `src/services/event-processor.service.ts:140` — the remaining inline `describeError`.**

`describeError` was promoted to `src/utils/describe-error.ts` and is imported by
`stream.consumer.ts:5` and `dead-letter.service.ts:6`. One inline ternary remains. The
promotion note (`src/utils/describe-error.ts:9-12`) states this deliberately, on the grounds
that the plan lists `event-processor.service.ts` as unmodified. I accept that under
one-task-per-commit — `.claude/rules/constants.md` asks for promotion "before the third copy"
and there are two — but it is the S-19 drift shape starting again. **Disposition:** accept for
this commit; fold it in with the next worker-service change and say so in that plan.

**L-4 · Two new barrels export things nothing imports.**

`src/services/index.ts` and `src/utils/index.ts` now re-export `DeadLetterService`,
`EventProcessorService`, `EventRepositoryFactory` and `describeError`. Every real importer uses
the direct path (`grep -rn 'from "../services"' src/ tests/` → no match; same for `../utils`).
Harmless, but they are a second declaration of the module surface that nothing keeps in step.
**Disposition:** accept, or delete the barrels; do not add a third.

**L-5 · F2–F6 should be filed as a new `known-gaps.md` entry — ruling: yes, as S-32.**

I agree with the plan and the implementer, and the reasons hold on inspection:

- S-29's title is literally scoped — "`docs/epics/epic-7-worker-service.md`'s **T-040 section**
  diverges from the shipped code in four ways". Extending it with T-041's section would make
  its own title false, and ids are cited from reviews and commit messages.
- Four of the five (F3–F6) concern the code snippet at `epic-7-worker-service.md:159-172`,
  which S-29 never examined.

One qualification that reduces the entry's weight and should be written into it: the change
*already* corrects the record in place. `docs/epics/epic-7-worker-service.md:180-195` now
carries "What T-041 shipped differs from the snippet above in five ways", enumerating all of
F2–F6 with reasons. But the original wrong lines are still above it — `:151`
(`src/events/dead-letter.handler.ts`, a path that does not exist) and `:154` ("Increment a
Prometheus counter. Clear from PEL so it doesn't block the consumer"), the second of which is
false as stated and the plan's F5 says so. A reader who greps for the file path lands on `:151`
and never reaches `:180`.

**Fix:** add S-32 recording F2–F6, and say in it that the epic file carries the correction at
`:180-195` while the original claims remain at `:151` and `:154`.

**L-6 · The dead-letter stream is a permanent, untrimmed store of customer payloads.**

`WORKER_DEAD_LETTER.FIELD.PAYLOAD` is `JSON.stringify(fields)` — the whole original field list,
including `tenantId` and all flattened customer metadata
(`src/services/dead-letter.service.ts:201-202`). There is no `MAXLEN` and no `EXPIRE` on
`DEAD_LETTER_STREAM`, deliberately (plan R5, `src/constants.ts:96-99`). R5 frames the cost as
unbounded *growth*; the other half is unbounded *retention* — the source stream trims at
`~100 000`, so today a customer payload ages out of Redis, and a dead-lettered one never does.
The design rationale (decision C, replayability) is sound and I am not asking for it to change.
**Disposition:** record it explicitly — in R5 and in `.env.example:96-108`, which is the
operator-facing text — so the retention property is a decision rather than a side effect. A
retention lever belongs with T-057's replay/alerting work, not here.

**L-7 · `tests/event.processor.integration.test.ts:569` constructs an env value the schema rejects.**

`DEAD_LETTER_STREAM: deadLetterStream ?? ""` reaches `DeadLetterService` through
`as ServiceEnv`, bypassing the `.min(1)` this task just added. It is unreachable in practice —
the empty case is only taken when `deadLetterStream` is `undefined`, and then no
`DeadLetterService` is constructed (`:592-598`) — but it writes down a value the shipped
contract forbids, three lines from the test that proves it forbidden. **Fix:** hoist the
branch, e.g. build the `env` object with `...(deadLetterStream === undefined ? {} : { DEAD_LETTER_STREAM: deadLetterStream })`,
so no rejected value is ever written.

---

#### NIT

**N-1 · The dead-letter record folder is written twice.** `deadLetterRecord`
(`tests/dead-letter.service.unit.test.ts:159-183`) and `readDeadLetterRecords`
(`tests/event.processor.integration.test.ts:739-770`) are the same key/value fold with
different numeric discipline — the unit copy uses `CALLS.NONE`/`FIELD_VALUE_OFFSET`, the
integration copy uses a bare `0` at `:749`. Both throw on a bad shape, which is the part that
matters. Promote to a shared test helper if a third appears.

---

### What I verified, and how

**Compile-time gate, all with `--force`, all 13 packages.**

| Task | Result |
|---|---|
| `pnpm typecheck --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` |
| `pnpm lint --force` | `13 successful` · 0 errors, **14 warnings** (10 auth-service, 4 usage-service), 0 in worker-service, 0 `no-unsafe-return` |
| `npx turbo run build --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached` |
| `pnpm test --force` | `13 successful` — shared-tracing 2, shared-config 4, shared-types 8, shared-logger 4, shared-validation 15, shared-utils 18, analytics 18, gateway 38, billing 18, usage 230, auth 164, **worker 155 (12 files)**, web (no test output, task successful) |
| `pnpm test:smoke` | 6 suites, 7 tests, all passing |

**The 14 warnings are pre-existing, proven.** Both carrying files are untouched by this change:
`git status --porcelain apps/auth-service apps/usage-service` → empty.
`git log -1 -- apps/auth-service/tests/auth.service.unit.test.ts` → `d68e719` (2026-08-25);
`git log -1 -- apps/usage-service/tests/ingestion.service.unit.test.ts` → `b0f6921` (2026-08-31).
Zero warnings were introduced.

**Test arithmetic, re-derived rather than taken from the plan.** Counting `it(` per file at
`c88a933` and at HEAD: base 129 across 11 files, now 155 across 12. Deltas: dead-letter +8,
env.schema +7, processor-integration +4, consumer-unit +2, validator +2, container +1,
shutdown +1, consumer-integration +1 = **26**. The plan's 18 (13 `U` ids + 5 `I` ids) plus the
8 id-less cases (7 env, 1 container) it did not count. `129 + 26 = 155`. The plan's §10 already
records the discrepancy and its cause.

**F1's three sites — all corrected, none stranded, and the new text is true of the code.**

- `stream.consumer.ts:636-642` — the "once, at startup" docstring now says "at startup, and
  then on a cadence", and names the change explicitly.
- `grep -n "is not done here" src/events/stream.consumer.ts` → **no match**; the
  "periodic reclaim … is not done here" paragraph is gone, replaced by `:656-665`.
- `stream.consumer.ts:785-798` — `dispatch`'s "comes back through `recoverPendingEntries` after
  the idle threshold" is retained and annotated as having been false when written. That is now
  true: `runLoop:474-478` issues the second pass. A fourth site was missed — see M-4.

**The reclaim cadence, read against the code.** `runLoop` (`:457-480`): `recoveryCadenceMs =
blockMs × RECOVERY_IDLE_MULTIPLIER`, computed once; startup pass; `lastRecoveryAt` seeded from
the startup pass, a `let` local per `run()`; cadence check placed after the `interrupted` break
and before the `while` predicate. The docstring's sequence claim at `:426-431` —
"guard → `recoverPendingEntries` → first read → cadence check → `do`/`while` condition" —
matches the code line for line. `min-idle` and the cadence are the same expression, so `U70`'s
`nthClaimArgs(SECOND)[3] === RECOVERY_CADENCE_MS` is a real coupling assertion.

**Mutations re-performed — 11 of them, each reverted.** All failures are by **assertion**, not
by timeout.

| Mutation | Result |
|---|---|
| delete the cadence block (`stream.consumer.ts:474-478`) | `U70` red, `I23` red (`expected 1 to be >= 2`); **`U71` green** — confirms the L-1 disclosure |
| same, against the processor suite | `I26` red (`expected 1 to be >= 3`), `I27` red (`expected [] to have length 1`) — by assertion, not `Test timed out` |
| `if (true \|\| …)` — reclaim every iteration | `U71` red, plus `U70`, `U19`, `U24`, `U36`, `U38`, `U39` |
| append `JSON.stringify(record)` to the parse message | `U60` red, `I27` red, `U59` red |
| `envelopeSchema` → `.strict()` | **`U60` green**, `U40`/`U41` red — see the F9 ruling below |
| move the pre-check below `inner` | `U67` red, **and only `U67`** |
| `count >= max` → `count > max` | `U63` red (+ `U61`, `U64`, `U65`, `U68`) |
| swap `XADD`/`XACK` | `U65` red (+ `U61`) |
| drop the `payload` field from the `XADD` | `U64` red, **and only `U64`** |
| delete the conditional `HDEL` | `U66` red, **and only `U66`** |
| delete the rethrow | `U62` red (+ `U61`, `U63`, `U68`) |
| revert `index.ts:122` to `container.eventProcessor.buildHandler()` | `U69` red **and** `U46` red |
| drop `.min(1)` from `DEAD_LETTER_STREAM` | "rejects a blank DEAD_LETTER_STREAM" red, and only that |
| remove the `hincrby` stub from the container case | the case escapes to a real connection — see M-2 |

The set is real. Every nominated case went red, and the four that redden *only* their nominated
case (`U64`, `U66`, `U67`, and the env case) are the ones carrying the most specific claims.

**F9 — the implementer's contradiction of the plan is correct, and the restated scope is
right.** The plan said `.strict()` falsifies `U60`. It does not: I made the real
`envelopeSchema` (`stream-message.validator.ts:113`) strict and `U60` stayed green. The
protection is the projection in `describeIssues` (`:128-139`), which reads `issue.code` and
`issue.path` only — an `unrecognized_keys` issue has an empty `path` and its key lives in
`keys`/`message`, neither of which is read.

The restated scope at `src/constants.ts:504-506` — "the scope of that is this flat seven-field
schema, whose paths are all declared names. A nested or record-valued schema could put a
customer key in a `path`, and this rule would not cover it" — is **not too narrow**. I tested
the refuting case directly on the installed zod:

```
z.record(z.string().min(5)).safeParse({ "CUSTOMER-CHOSEN-KEY": "ab" })
  -> [{"code":"too_small","path":["CUSTOMER-CHOSEN-KEY"]}]
z.object({ metadata: z.record(z.string().min(5)) }).safeParse({ metadata: { "CUSTOMER-KEY-2": "ab" } })
  -> [{"code":"too_small","path":["metadata","CUSTOMER-KEY-2"]}]
```

So a customer key does reach `path` under exactly the schema shapes the restatement names, and
under no other shape I could construct. The claim is stated at the strength it was measured.

**Decisions A–E as shipped.**

- **A** — the policy is a decorator (`dead-letter.service.ts:102-130`) composed in
  `container.ts:96-101`. `StreamConsumer.dispatch` still acknowledges nothing;
  `EventProcessorService` is unmodified (`git status` confirms). A retryable failure rethrows
  (`:123`), so `HANDLER_FAILED`, `U29` and `I18` keep their meaning — `U29`/`I18` are green in
  the 155. Only the terminal case resolves, and only after `XADD` → `XACK` → `HDEL`.
- **B** — `src/services/dead-letter.service.ts`, inside coverage. Confirmed:
  `vitest.config.mjs` excludes `src/events/**`, not `src/services/**`.
- **C** — re-ran F7's eviction probe on db 14 in substance: the corollary that matters is
  already pinned by `U64` (payload present) and `I26` (`JSON.parse(payload)` equals the
  original field list), both of which I watched go red/green under mutation. The `MAXLEN`
  measurement itself I did **not** re-run — see *What I could not verify*.
- **D** — key-level `EXPIRE` on `retries:<streamName>` (`:164`), asserted by `U62` (exact args)
  and `I24` (`TTL > 0` against live Redis).
- **E** — Q10 marked decided in `docs/epics/README.md:17` (gate table) and `:32-52` (a new
  decision note), and in `docs/epics/epic-7-worker-service.md:14` and `:174`. `grep -rn "Q10"
  docs/epics/` returns five hits and every one is either marked decided or a dependency
  reference (`README.md:93`). AC9 satisfied.

**`U46`/`I10` — neither was weakened.**

- `I10` (`stream.consumer.integration.test.ts:800-826`): the exact-array assertion became
  `slice(0, INTEGRATION_LOOP.ABANDONED_ENTRY_COUNT)` **plus** a set-equality assertion. The
  pagination claim — five ids in stream order out of one recovery pass — is intact at full
  strength, and the "nothing else ever reached the handler" half is retained as the set check.
  The only property surrendered is "no duplicates", which is exactly what the cadence makes
  false. The constant is used rather than a literal `5`. Correct edit, correctly annotated.
- `U46`/`U69` (`index.graceful-shutdown.unit.test.ts:468-518`): the `index.ts` revert mutation
  reddens **both**, so the wiring is doubly guarded, not traded. `U69`'s negatives
  (`processorHandler` not called, `buildHandler` not called) are strictly stronger than the
  positive `U46` used to carry, because `wrappedMessageHandler` is a separate spy that does not
  delegate — had it delegated, the revert would have left both green, and the case comment says
  so.

**No repository, no Prisma, no migration, no dependency.** `git status --porcelain -- prisma
package.json '**/package.json' pnpm-lock.yaml` → empty. `grep -n "prisma\|Repository"
src/services/dead-letter.service.ts` → only docstring mentions. `failedAt` is
`new Date().toISOString()` written as a Redis field (`:205-206`); there is no `failedAt` column
and no raw SQL on any path this change adds, so S-18-via-S-19 is not reachable here. `U61`
additionally pins `DeadLetterService.length === 3` (three infrastructure arguments, no
repository factory) and wires `del`/`hset`/`xdel`/`duplicate` to throw.

**Tenant isolation.** The retry key is `RETRY_KEY_PREFIX + streamName`, built by the writing
service from its own prefix plus parsed configuration (`:85`), never from a caller value; the
hash *field* is the Redis entry id, which is server-assigned. No tenant segment, and I agree
that is correct rather than an omission: entry ids are unique per physical stream entry, so two
tenants cannot collide, and the counter has no suppression semantics. `U68` pins that no field
value, no `tenantId` and no metadata key reaches any logger method, with a helper that throws
both when a logger method is missing and when nothing was logged at all.

**Injection.** No SQL added. The only dynamic Redis arguments are the stream/group/key names
from parsed env and the server-assigned entry id; all field names are constants
(`WORKER_DEAD_LETTER.FIELD`).

**Datastore state — recorded before and after.**

| | Before | After |
|---|---|---|
| db 0 `XLEN telemetry:events` | 2 | 2 |
| db 0 `entries-added` | 2 | 2 |
| db 0 consumer groups | 0 | 0 |
| db 0 `EXISTS telemetry:dead-letter` | 0 | 0 |
| db 0 `KEYS retries:*` | none | none |
| db 14 `DBSIZE` | 0 | 0 |
| db 13 `DBSIZE` | 0 | 0 |
| `Event` / `UsageLine` | 0 / 0 | 0 / 0 |

db 0 `DBSIZE` moved 3 → 2 → 3 → 2 during the session; the movement is entirely TTL'd
`denylist:*` keys from auth-service's suite expiring and being rewritten (S-22, pre-existing).
`telemetry:events` and its metadata were never touched.

**Tree restored.** `(git diff; git ls-files --others --exclude-standard | sort | xargs md5sum)
| md5sum` → `4faa3b9871b6369962333de2a9931aeb`, identical before the first mutation and after
the last. `git status --porcelain` diffs clean against the snapshot taken at the start.

**§10-vs-§7 ruling (`U68`).** §7's AC table is right: `U68` is a `DeadLetterService` logging
test and physically lives at `tests/dead-letter.service.unit.test.ts:429`, i.e. in S3's suite.
§10's S4 line already records the resolution parenthetically ("`U68` belongs to S3 per §7's AC
table"). **No action** — the inconsistency the orchestrator flagged is already annotated in the
shipped plan.

---

### What I could not verify, and why

- **F7's `MAXLEN`-eviction probe was not re-run.** Reproducing it needs writes to a live stream
  and I judged the risk/benefit poor when `U64` and `I26` already pin the property it justifies
  (the record carries the payload) and both go red when the payload field is dropped. The
  probe's conclusion is therefore **inherited from the plan**, not independently measured here.
- **M-6's self-amplifying loop is reasoned, not measured.** I did not run a worker with
  `DEAD_LETTER_STREAM === REDIS_STREAM_NAME`. What I verified is only that no guard exists.
- **M-3's log-repetition consequence is reasoned from the code paths**, not observed under a
  PEL above 10 000 entries.
- **R2's double-increment (two workers failing the same entry each incrementing its counter)
  remains unmeasured**, as the plan and the `recoverPendingEntries` docstring both say. No test
  here runs two live workers, and I did not construct one.
- **Peer-stealing at steady state is now a real behaviour change** and nothing tests it. With
  the cadence, any entry idle for `blockMs × RECOVERY_IDLE_MULTIPLIER` (10 s at defaults) is
  reclaimable by a peer — including one a live worker is still processing, if a single entry
  takes longer than 10 s. Q9 is "one instance locally, horizontal-ready", so this is latent
  today. The docstring at `:659-665` states it honestly.
- **`prom-client`'s absence** I took from the plan's F4 rather than re-grepping; it is not
  load-bearing for anything this change does.

---

### Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| The dead-letter stream is unwatched until T-057 (plan R5) | **Accepted**, stated in `.env.example`, the constant docblock and the epic. Add the retention half (L-6). |
| Retry spacing is coupled to the `XAUTOCLAIM` idle threshold with no test (plan R7) | **Accepted.** Documented in `WORKER_STREAM_READ.RECOVERY_IDLE_MULTIPLIER`'s docblock and in `.env.example`; `U70` pins that the cadence equals the `min-idle` argument, so the two cannot drift *from each other*. That is the strongest assertion available without a wall-clock pin, and it is correctly described as such. |
| Peer-stealing becomes steady-state | **Accepted**, single-instance today; idempotent at the database (`I14`, inherited). Revisit when Epic 7 goes multi-instance. |
| Three attempts over ~20–30 s will not survive a multi-minute outage (plan R1) | **Accepted and stated**; the DLQ is the backstop and replay is T-057's. |
| `RECOVERY_MAX_PAGES` truncation now warns on a cadence | **Fix the docblock (M-3)**; the behaviour itself is acceptable. |

**Recommended `known-gaps.md` edits in this commit:** remove S-31 (H-1); add **S-32** for
F2–F6 (L-5). Ids are never reused; the next free id after S-31 is S-32.

---

### Required for `APPROVED FOR COMMIT`

1. **H-1** — remove S-31 from `.claude/rules/known-gaps.md:988-1018`.
2. **M-2** — pin `REDIS_URL` to the reserved logical database in
   `apps/worker-service/tests/setup.ts:9`.
3. **M-3** — correct `src/constants.ts:290-292`.
4. **M-4** — correct `src/events/stream.consumer.ts:704-707`.
5. **M-5** — correct `src/constants.ts:551-553`.
6. **M-6** — add the `DEAD_LETTER_STREAM !== REDIS_STREAM_NAME` refinement, one env case, and
   run the refuting mutation. *(If this is deferred rather than done, it must be filed as a
   gaps entry rather than left in three comments — see the decision below.)*
7. **L-1** — correct AC6's proof column in the plan.
8. **L-5** — add S-32.

L-2, L-3, L-4, L-6, L-7 and N-1 are **advisory**; none blocks the commit.

---

### Decision for the user

**Should M-6 (the `DEAD_LETTER_STREAM === REDIS_STREAM_NAME` collision) be guarded in this
commit, or deferred?**

| Option | What changes |
|---|---|
| **A · Guard it here** (recommended) | `src/config/env.ts` gains a `.superRefine`, `WORKER_STREAM_CONSTANTS` gains a message constant, `tests/env.schema.unit.test.ts` gains one case, and the refuting mutation is run. **Changes the diff.** ~20 lines, entirely inside this task's own two new env fields. |
| **B · Defer to a new gaps entry** | No code change. `known-gaps.md` gains an entry saying the invariant is documented in three places and enforced nowhere. **Does not change the diff**, but ships a "must not" with no mechanism, which is the shape `.claude/rules/review-standards.md` § *Universals* exists to catch. |
| **C · Weaken the documentation instead** | Reword `constants.ts:91-93` and `.env.example:97-99` from "must not" to "if you set these equal, the worker will loop". **Changes the diff**, cheapest, and honest — but it documents a foot-gun rather than removing it. |

**Recommendation: A.** The field is new in this commit, the guard belongs beside the `.min(1)`
this task already added to the same field for the same class of reason (S-23), and deferring it
means the first person to hit it does so in production. B is defensible only if the objection is
strictly one-task-per-commit scope — but the field is *this* task's, so that objection does not
really apply here.

Everything else in this review is either a required correction with an obvious fix or advisory;
no other item needs the user to choose.

**CHANGES REQUESTED → Gate 3** for items 1–8, then re-review as `## Round 2` appended to this
file.

---

## Round 2

**Verdict: CONDITIONAL** — all eight Round 1 required fixes are verified done, by execution, not
by report. The rework's central claim (M-2) is correct and I re-performed the reproduction
myself. Three new LOW findings and three NITs remain, every one a documentation correction of
one or two lines; none touches behaviour, none needs the gate re-run. Two of the three LOWs were
*created by the rework itself*, which is the same finding class Round 1 raised — see
*A repeated class, and what to do instead of a third round* at the end.

Base is still `c88a933`; nothing committed or staged. Worker is **12 files / 156 tests**.
Every `file:line` below was re-derived against the current tree.

---

### Round 1 items — disposition, each re-verified

| Item | Status | How I established it |
|---|---|---|
| **H-1** S-31 removal | **Done** | `grep -rn "S-31" .claude/rules/known-gaps.md` → no match. Removal is what that file's own preamble prescribes ("Update this file when an item is fixed (remove it)"; "A missing id means 'fixed', not 'never existed'"), and the record exists in the plan and this review. Id retired, not reused — the next entry is S-32. |
| **M-2** `setup.ts` db-14 pin | **Done, and it works** | Reproduction re-performed. See below. |
| **M-3** `RECOVERY_MAX_PAGES` | **Done** | `src/constants.ts:307-323`. "per recovery pass", "next cadence pass", the log-repetition consequence written in and explicitly marked "Reasoned from the two call sites and the log statements, **not observed under a PEL that large**". Arithmetic checked: `DEFAULT_BATCH_SIZE: 10` (`:64`) × `RECOVERY_MAX_PAGES: 1_000` (`:325`) = 10 000. Both log strings exist verbatim at `src/events/stream.consumer.ts:754` and `:781`; both call sites at `:462` and `:476`. |
| **M-4** fourth F1 site | **Done; declined guard accepted** | `src/events/stream.consumer.ts:702-729`. See the trade ruling below. |
| **M-5** `xadd` universal | **Done** | `src/constants.ts:592-606`. Re-counted independently: `grep -rn "\.xadd(" apps packages --include=*.ts` excluding `dist/` and `tests/` → exactly two, `apps/usage-service/src/events/stream.publisher.ts:70` and `apps/worker-service/src/services/dead-letter.service.ts:192`. Both verified to pass `"*"`: the publisher's is the fifth element of `streamArgs` (`stream.publisher.ts:55-59`), the dead-letter's is `WORKER_DEAD_LETTER.ENTRY_AUTO_ID`, which is `"*"` at `src/constants.ts:644`. The restatement is scoped to the *source* stream and survives. |
| **M-6** collision guard | **Done (option A)** | See the mutation results below. |
| **L-1** `U71` / AC6b | **Done** | `docs/plans/t-041-retry-tracking-dead-letter.md:564-565`. AC6 now names `U70`; `I23` only and states the measurement; AC6b carries `U71` described as "green before the fix *and* after it". |
| **L-5** S-32 filed | **Done** | `.claude/rules/known-gaps.md:988-1043`. Content verified below. |
| **L-2 / L-6 / L-7** applied | **Done** | L-2: `grep -n "next restart"` now returns only the three sites that say it *used to* be the next restart (`stream.consumer.ts:646`, `:656`, `constants.ts:312`). L-6: retention half recorded in plan R5 (`:633`), `.env.example:101-111` and `src/constants.ts:96-99`; the `MAXLEN ~ 100000` figure checked against `apps/usage-service/src/config/env.ts:22` (`STREAM_MAX_LEN` default `100_000`). L-7: `tests/event.processor.integration.test.ts:577` is now the conditional spread — no rejected value is constructed. |
| **L-3 / L-4 / N-1** declined | **Rulings stand** | L-3: `git status --porcelain apps/worker-service/src/services/event-processor.service.ts` → empty, so the file really is unmodified, and the inline ternary at `:140` is the second copy, not the third. My Round 1 acceptance holds unchanged. L-4: `grep -rn 'from "../services"\|from "../utils"' src tests` → no match, confirming nothing imports the barrels; harmless, accept, do not add a third. N-1: two folders confirmed (`tests/dead-letter.service.unit.test.ts:159`, `tests/event.processor.integration.test.ts:746`); NIT, promote on a third. |

---

### M-2 — re-performed, and it holds

This was the finding of Round 1 and the claim that the hazard is now mechanical rather than
remembered. I did not take it on report.

**The reproduction, re-run against the fixed tree.** I removed the `hincrby` stub from
`tests/config/container.unit.test.ts:70-72`, ran that one file with no `REDIS_URL` override,
and watched db 0 under `redis-cli MONITOR` for the whole run:

```
1789379383.719612 [14 127.0.0.1:48922] "select" "14"
1789379383.722674 [14 127.0.0.1:48922] "hincrby" "retries:telemetry:events" "1789101023800-0" "1"
```

`redis-cli -n 14 HGETALL retries:telemetry:events` → `1789101023800-0  1`, the exact value the
rework claimed. Against db 0 the monitor recorded **nothing** but my own inspection commands;
`KEYS retries:*` empty, `EXISTS telemetry:dead-letter` → 0, `XLEN telemetry:events` → 2. Key
deleted, db 14 back to `DBSIZE 0`, mutation reverted and the file's md5 matched its pre-review
value.

**Is the pin sufficient? I checked for other Redis reach points, and it is — with one caveat
I then closed.** `grep -rn "new Redis(\|RedisClient(" src tests` finds three constructions:
`src/config/container.ts:61` (from `env.REDIS_URL`, now db 14), and the two integration suites,
which independently force `redisUrl.pathname = "/14"`
(`tests/event.processor.integration.test.ts:224-225`, `tests/stream.consumer.integration.test.ts:219-220`).
`INTEGRATION_REDIS_URL_FALLBACK` (`tests/integration.constants.ts:15`) is a bare
`redis://localhost:6379`, but the pathname is overwritten on the next line in both suites, so it
can never select db 0. No other path reaches a server.

**The caveat, and why it does not bite.** `setup.ts:31` uses `??=`, so an ambient `REDIS_URL`
would defeat it — and `.github/workflows/ci.yml:31` sets exactly that, `redis://localhost:6379`,
at job level. The CI file *claims* turbo's strict env mode filters it. I tested that rather than
believing it, in two ways. `npx turbo run test --filter=@telemetry/worker-service --dry=json`
reports `envMode: strict` with `"env": []` and `"passthrough": null` for the worker test task.
Then the live probe: with the `hincrby` stub still removed and `REDIS_URL=redis://localhost:6379/9`
exported, `npx turbo run test --filter=@telemetry/worker-service --force` left **db 9 empty** and
put the key in **db 14**. The override was filtered; the pin governs on CI too.

**Verdict on M-2: fully resolved**, and the claim in `setup.ts:9-30` is accurate in every part I
could test, including the `clearAllMocks`-not-`restoreAllMocks` detail
(`tests/config/container.unit.test.ts:26-27`).

---

### M-4 — the declined top-of-method guard: trade accepted

The comment at `src/events/stream.consumer.ts:702-729` now states the old justification, says it
is true of the startup call site and **false of the cadence one**, and records the decline with
its reason. Both load-bearing facts check out:

- `stopAfter` really does count predicate *checks*, not reads —
  `tests/stream.consumer.unit.test.ts:707-716` increments on every invocation, and the helper's
  own docblock at `:695-700` says so. Every one of its ~20 call sites goes through `.run()`, and
  a top-of-method guard would fire on the startup pass in all of them, so "shifts every case that
  uses it" is right.
- The bounded exposure is right: `src/index.ts:158` is `void streamConsumer.run()` — never
  awaited — and `:59`/`:67` set the flag then `await stop()` with only a synchronous log between.

One page of `XAUTOCLAIM` in a narrow window, against a suite-wide re-baselining of a harness that
three prior incidents in this package were caused by. **Accepting the decline.** The comment now
describes the code, which was the required half.

---

### M-6 — implemented, placed correctly, and non-vacuous in both directions

Placement ruling: **object-level `.superRefine` is right, and is the only option.** A zod
per-field refinement receives that field's value and nothing else, so a cross-field invariant
cannot live on either field. It also runs after defaults are applied, which is what lets it catch
the collision an operator is most likely to create — an explicit `DEAD_LETTER_STREAM` against the
*default* `REDIS_STREAM_NAME`. The `path: ["DEAD_LETTER_STREAM"]` choice is right too: that is the
field an operator is free to move.

**Red-first, re-derived.** I deleted the refinement (`src/config/env.ts:78-96`, leaving the object
terminated at `:77`) and ran the env suite:

```
× worker-service env schema > dead-letter configuration > rejects a DEAD_LETTER_STREAM equal to REDIS_STREAM_NAME
  → expected true to be false
Tests  1 failed | 37 passed (38)
```

One case red, and only that case. The "confirmed red before the refinement existed" ordering claim
is a TDD-sequence assertion I cannot verify retroactively; what I can and did verify is that the
case reddens when the refinement is removed, which is the property that matters.

**The anti-vacuity half — verified, and it is real.** Two mutations:

- *Unconditional* (`if (true)`): the module fails to load, because `parseEnv(EnvSchema, process.env)`
  runs at import. Error: `Invalid environment configuration for DEAD_LETTER_STREAM: DEAD_LETTER_STREAM must differ from REDIS_STREAM_NAME…`. Loud, but it kills collection before any assertion runs — so this
  mutation does not exercise the anti-vacuity assertion. It does independently confirm the
  "startup, not runtime" claim at `src/config/env.ts:84-87`, including that `path` produces the
  right field name in the operator-facing error.
- *Over-broad but loadable* (`startsWith` instead of `===`): reddens **exactly**
  `tests/env.schema.unit.test.ts:471`, the `expect(distinct.success).toBe(true)` anti-vacuity
  assertion — `1 failed | 37 passed`.

So the case is non-vacuous in both directions: absent refinement → `expectIssueOn` red; over-broad
refinement → `:471` red. The env case at `:425-472` covers all four claimed things (explicit
collision, collision against the default, message identity via the constant, anti-vacuity pair).
**M-6 fully resolved.**

---

### L-5 / S-32 — content, severity and caveat verified

Every citation re-derived against the current tree, and the load-bearing measurement re-run
independently rather than inherited:

- `epic-7-worker-service.md:151` does name `src/events/dead-letter.handler.ts`;
  `ls apps/worker-service/src/events/` returns `index.ts` and `stream.consumer.ts` only. ✓
- `vitest.config.mjs:79` is `"src/events/**"` inside `coverage.exclude`; thresholds at `:87-90`
  are `lines/functions/statements: 80`, `branches: 75`. ✓
- `:154` carries both "Increment a Prometheus counter" and "Clear from PEL…". ✓
  `grep -rn "prom-client" --include=package.json .` outside `node_modules` → no match. ✓
- `:156` is the pre-check line, `:158-172` the snippet. ✓
- **The `>`-does-not-redeliver claim, re-measured by me on db 14, Redis 7.0.15.** One entry read
  with `XREADGROUP … >` and left unacked; a second `XREADGROUP … > BLOCK 50` returned empty — to a
  *different* consumer **and** to the same one — while `XPENDING` still reported 1. Control:
  `XREADGROUP … 0` did return the entry, so the probe is not vacuous. The claim holds, and I
  checked the variation (same consumer) that would have refuted a one-dimension probe. Stream
  deleted; db 14 back to 0.
- **The caveat about the epic self-correcting below the wrong claims is correct, and the line
  range is right.** The correction block runs `:184-202` (starts "What T-041 shipped differs…",
  ends "…unreplayable"), which is *below* `:151` and `:154`. Note this supersedes Round 1: I cited
  that block as `:180-195` and was wrong. The rework re-derived it and is right; I am recording
  the correction against my own text rather than theirs.

**Severity: LOW is right.** The file self-corrects, nothing is a live security or correctness
hole, and the residual is genuinely just that a reader who greps the file path lands above the
correction.

---

### New findings

#### LOW

**R2-1 · `src/constants.ts:126-131` — the self-recount paragraph was falsified by M-6, in the same round, and is now off by one.**

The docblock enumerates `WORKER_STREAM_CONSTANTS`' members as "seven as a `.default(...)` … and
four as the `.min()`/`.max()` bounds", then pins the total:

> `grep -c 'WORKER_STREAM_CONSTANTS\.' src/config/env.ts` -> 11, one per member.

Measured: the command returns **12**. The twelfth reference is `src/config/env.ts:93`,
`message: WORKER_STREAM_CONSTANTS.DEAD_LETTER_STREAM_COLLISION` — added by M-6 this round. The
object now has 12 members (counted by parsing the declaration), so "one per member" still holds;
the *number* does not, and the 7-defaults-plus-4-bounds taxonomy has no slot for a `.superRefine`
message, which is neither.

What makes this worth writing down rather than waving through is `:133-135`, two lines below:

> "The count in this paragraph said **seven** until T-041 … is the kind of figure that goes stale
> silently — it is re-counted with the command above whenever a member is added, rather than
> adjusted by eye."

A member was added in this round and the command was not re-run. The paragraph documents the
exact failure it then committed.

**Fix:** `src/constants.ts:126-131` → "…seven as a `.default(...)` (…), four as the
`.min()`/`.max()` bounds (…), and one as the cross-field `.superRefine` message
(`DEAD_LETTER_STREAM_COLLISION`). Re-counted at T-041 Round 2:
`grep -c 'WORKER_STREAM_CONSTANTS\.' src/config/env.ts` → **12**, one per member."

**R2-2 · `src/events/stream.consumer.ts:271-275` and `.claude/rules/known-gaps.md:580` — M-6 makes the cited measurement recipe unusable on worker's schema.**

Both places record how the S-23 divergence was measured:
`EnvSchema.shape.<field>.safeParse("")`. Adding `.superRefine` turns worker's `EnvSchema` from a
`ZodObject` into a `ZodEffects`. Measured directly, by importing the real module under vitest:

```
constructor: ZodEffects
typeName:    ZodEffects
has .shape:  false
shape.REDIS_STREAM_NAME: UNDEFINED
```

The *results* both places state are still true — worker's `REDIS_STREAM_NAME` and
`REDIS_CONSUMER_GROUP` still reject `""`, pinned by `tests/env.schema.unit.test.ts:270-278`, which
go through `EnvSchema.safeParse` on the whole object and pass. What is now false is the
**reproduction method**, for worker only; it still works on usage-service's schema, which has no
refinement.

I am calling this **LOW, not HIGH**, deliberately, and want the reasoning on the record: the
review standards make a false claim in `.claude/rules/` HIGH, but nothing S-23 *asserts* is false.
The divergence table, the values, the zod version and the conclusion all still hold. Only the
one-line "here is how to re-derive it" clause no longer runs against one of the two schemas. An
agent following it would get `undefined` and, at worst, waste a few minutes — not reach a wrong
conclusion about the platform.

**Fix:** `src/events/stream.consumer.ts:272` → note that worker's `EnvSchema` is a `ZodEffects`
since T-041's collision refinement, so the per-field form is `EnvSchema.safeParse({ …base, REDIS_STREAM_NAME: "" })`
(or `EnvSchema._def.schema.shape.<field>`). Same one-clause caveat at `.claude/rules/known-gaps.md:580`.
See the decision below on whether the known-gaps half belongs in this commit.

**R2-3 · `.env.example:97-99` — the operator-facing file still states the invariant as advice, after it became a mechanism.**

Round 1 named three places asserting "must not" with nothing enforcing it.
`src/constants.ts:105-115` now documents the mechanism and points back at the other two. But
`.env.example` — the file an operator actually reads — still says only:

> `# Redis stream an entry is copied to once its retry budget is spent. Must NOT be`
> `# REDIS_STREAM_NAME: a dead letter written back onto the source stream is redelivered, fails`
> `# again, and dead-letters itself forever.`

It received the L-6 retention edit at `:101-111` but not the M-6 enforcement note. An operator
reads this as a warning to be careful, not as "the service will refuse to start" — which is a
materially different thing to know, and the better news of the two.

**Fix:** append to `.env.example:99`: "The schema enforces this: `parseEnv` rejects the
configuration at startup, so a worker with these two equal never reaches `app.listen`."

#### NIT

**R2-4 · `src/config/env.ts:92` — `path: ["DEAD_LETTER_STREAM"]` is an unchecked literal.**
Renaming the field would be a type error at `:89` (`parsed.DEAD_LETTER_STREAM`) but *not* here, so
the issue would silently start naming a field that no longer exists. Consider
`path: ["DEAD_LETTER_STREAM" satisfies keyof z.infer<typeof BaseEnvSchema>]`, or accept it — one
line, and the test at `tests/env.schema.unit.test.ts:434` pins the current name.

**R2-5 · Two S-31 references still read in the present tense.**
The rework reworded `src/services/dead-letter.service.ts:222` and `src/constants.ts:538` to say
"retired", and `src/constants.ts:516-521` explains the removal well. Not reworded:
`tests/event.processor.integration.test.ts:967` ("the reason the S-31 entry **is** LOW rather than
MEDIUM") and `:988` ("What the S-31 rule governs"). Neither asserts the gap is open, so no live
citation survives in the sense H-1 asked about — but both describe a deleted entry as present.
One word each ("the retired S-31 entry").

**R2-6 · `.claude/rules/known-gaps.md:988` — S-32's title overclaims relative to its own body.**
Title: "diverges from the shipped code in **five** ways". Body: "four of these are divergences
between the epic and the shipped code; the fifth (`:156`) is a cost the epic does not mention and
the implementation accepted." The qualification is exactly right and was the honest call; the
title should match it. **Fix:** "…diverges from the shipped code in four ways, plus one unstated
cost".

---

### A repeated class, and what to do instead of a third round

Round 1 raised M-3, M-4 and M-5 — three comments falsified by the commit that shipped them.
Round 2 raises R2-1 and R2-2, which are the same class, and R2-1 was created by the Round 1 fix
for M-6 while R2-2 was created by the same fix landing in a file whose comment describes it.

I am not opening a third round on this. The class is not carelessness — every instance has been
found, and the author's own instinct (writing "re-counted with the command above whenever a member
is added") is right. The instance rate is what a manual discipline produces. **Recommendation:**
this belongs in `.claude/rules/known-gaps.md` as its own entry, out of scope to fix here — a
standing check that counts-in-comments (`grep -c … -> N`, "two call sites", "the only X") are
re-run at the end of a change rather than when the claim is written. A one-line CI script over a
tagged comment form would catch R2-1 mechanically. Do not let it evaporate into a sixth round of
the same finding.

---

### Compile-time gate — all `--force`, all 13 packages

| Task | Result |
|---|---|
| `pnpm typecheck --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` |
| `pnpm lint --force` | `13 successful` · **0 errors, 14 warnings** (10 auth-service, 4 usage-service), 0 in worker-service, 0 `no-unsafe-return` |
| `npx turbo run build --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached` |
| `pnpm test --force` | `13 successful` — shared-tracing 2, shared-config 4, shared-types 8, shared-logger 4, shared-validation 15, shared-utils 18, analytics 18, gateway 38, billing 18, usage 230, auth 164, **worker 156 (12 files)**, web `--passWithNoTests` |
| `pnpm test:smoke` | 6 suites, 7 tests, all passing |

**The 14 warnings are pre-existing, proven three ways.**
`git status --porcelain apps/auth-service apps/usage-service` → empty, so neither package is
touched by this diff. eslint names `apps/auth-service/tests/auth.service.unit.test.ts` (10 ×
`no-misused-promises`) and `apps/usage-service/tests/ingestion.service.unit.test.ts` (4 ×
`no-unsafe-assignment`). `git log -1` on those files → `d68e719` (2026-08-25) and `b0f6921`
(2026-08-31). **Zero warnings introduced**, and worker-service is clean.

Worker's test count moved 155 → **156**, the single addition being M-6's env case, as stated.

---

### Regression sweep — sampled, nothing softened

Both files that M-4 and M-5 edited (`stream.consumer.ts`, `constants.ts`) were re-checked by
mutation, against the full 156:

| Mutation | Result | Claimed |
|---|---|---|
| delete the cadence block (`stream.consumer.ts:475-478`) | `U70`, `I23`, `I26`, `I27` red **by assertion** (`expected 1 to be >= 2`, `>= 3`, `expected [] to have length 1`) — `4 failed \| 152 passed` | `4 failed \| 152 passed` ✓ |
| move `XACK` before `XADD` (`dead-letter.service.ts:192-210`) | `U65` and `U61` red — `2 failed \| 154 passed` | `U65` + `U61` ✓ |

Both match the rework's report exactly. The comment edits did not weaken the assertions they sit
beside.

---

### What I verified, and what I could not

**Verified by execution this round:** the M-2 reproduction and its `MONITOR` trace; turbo's
strict-env filtering, by dry-run *and* by live probe with a decoy db; the M-6 deletion mutation
and the over-broad `startsWith` mutation; the `parseEnv` module-load throw and its field name;
S-32's `>`-non-redelivery on live Redis 7.0.15 with a non-vacuous control and both consumer
variations; the `xadd` re-count and both sites' `"*"`; `EnvSchema`'s `ZodEffects` type and absent
`.shape`; the `WORKER_STREAM_CONSTANTS` reference count and member count; the four
`WORKER_CONSUMER_GROUP_BOOTSTRAP` members being referenced only by `stream.consumer.ts`;
`stopAfter`'s check-counting semantics; `prom-client`'s absence; the epic's `:151`/`:154`/`:184-202`
line ranges; `STREAM_MAX_LEN` default `100_000`; the two regression mutations; the full gate.

**Could not verify, and why:**

- **M-6's "confirmed red *before* the refinement existed"** — a TDD-ordering claim about the
  past. I verified the equivalent present-tense property (removing the refinement reddens exactly
  that case), which is what carries the weight.
- **The self-amplifying dead-letter loop** is still reasoned, not measured. Nobody has run a
  worker with the two names equal — and now nobody can, which is the point of the fix.
- **M-3's log-repetition consequence** remains reasoned from the call sites, not observed under a
  PEL above 10 000 entries. The docblock says so itself.
- **R2's double-increment** (two workers each incrementing one entry's counter) — unchanged from
  Round 1; no test runs two live workers.
- **Peer-stealing at steady state** — unchanged; latent at Q9's single instance.
- **F7's `MAXLEN`-eviction probe** — still inherited from the plan, for the Round 1 reason
  (`U64` and `I26` pin the property it justifies).
- **The handoff's "1018 → 985 lines"** for the S-31 removal is actually **1018 → 987**
  (reconstructed by deleting the block from `git show HEAD:` and by subtracting S-32's 56 lines
  from the current 1043). Not a finding against the diff — the figure appears in no shipped
  artifact, only in the handoff summary.

---

### Datastore state — recorded before and after

| | Before | After |
|---|---|---|
| db 0 `XLEN telemetry:events` | 2 | 2 |
| db 0 `entries-added` | 2 | 2 |
| db 0 consumer groups | 0 | 0 |
| db 0 `EXISTS telemetry:dead-letter` | 0 | 0 |
| db 0 `KEYS retries:*` | none | none |
| db 14 `DBSIZE` | 0 | 0 |
| db 9 / db 13 `DBSIZE` | 0 | 0 |
| `Event` / `UsageLine` | 0 / 0 | 0 / 0 |

db 0 `DBSIZE` moved 2 → 3: one additional TTL'd `denylist:*` key written by auth-service's suite
during `pnpm test --force`. That is S-22, pre-existing and out of scope. `telemetry:events` and its
metadata were never touched, and Postgres and Redis were left running throughout.

**Tree restored.** `md5sum` over all 26 changed/untracked paths is byte-identical to the snapshot
taken before the first mutation, checked twice — after the mutation set and again after the full
gate — and `git status --porcelain` is unchanged.

---

### Required for `APPROVED FOR COMMIT`

Three one-line documentation corrections. None changes behaviour; none requires the gate to be
re-run beyond a `lint`/`typecheck` on the touched files.

1. **R2-1** — `src/constants.ts:126-131`: 11 → **12**, and give the `.superRefine` message its own
   clause in the taxonomy.
2. **R2-3** — `.env.example:99`: state that the schema now rejects the collision at startup.
3. **R2-2** — `src/events/stream.consumer.ts:272`: caveat the `EnvSchema.shape` recipe for
   worker's now-`ZodEffects` schema. *(The `known-gaps.md:580` half is the subject of the decision
   below.)*

R2-4, R2-5 and R2-6 are **NITs** — apply them if the file is open anyway, but none blocks.

---

### Decision for the user

**Should the `.claude/rules/known-gaps.md:580` half of R2-2 be corrected in this commit?**

S-23 is not this task's entry, but this task's change is what made one clause in it unusable.

| Option | What changes | Diff? |
|---|---|---|
| **A · Correct it here** (recommended) | One clause added to `.claude/rules/known-gaps.md:580` noting worker's schema is a `ZodEffects` since T-041, so the per-field recipe now needs `EnvSchema.safeParse` on the whole object. The commit already edits this file (S-31 out, S-32 in), so there is no new-file argument. | Yes — one line |
| **B · Leave it; fix only the code comment** | `known-gaps.md` keeps a recipe that no longer runs against one of the two schemas it names. Nothing false is asserted, but the next agent re-deriving S-23 hits a dead end and may conclude the entry is stale. | No |
| **C · Correct it and fold R2-1/R2-3 in as one "claims refresh"** | Same as A plus the other two required fixes, done as a single pass with the counts re-run by command rather than by eye — which is also the habit the repeated-class note above asks for. | Yes — three lines |

**Recommendation: C.** It costs the same review round as A, closes all three required items
together, and the count in R2-1 is exactly the kind of figure that should be re-derived by
running the command rather than edited by hand. A is the minimum defensible; B is the only option
that leaves an authoritative file carrying instructions that do not work, which is the thing
`.claude/rules/` is least able to afford.

This is the only item needing the user's answer. Everything else is either a required correction
with the exact text given, or a NIT.

---

## Round 3 — final

**Verdict: CONDITIONAL.** The code is release-ready and I would ship it on behaviour alone:
all four gates pass on my own `--force` run, the ten acceptance criteria are unchanged and
still proven, nothing outside worker-service is touched, and F-3's central measurement — the
one the rework rests on — reproduces exactly on a matrix wider than the one that produced it.
What blocks `APPROVED FOR COMMIT` is the same thing that blocked Gate 5: **`.claude/rules/known-gaps.md`
still carries false statements, and they are inside S-33, the entry filed to stop precisely
this.** QA's F-1 was fixed; two *different* untrue clauses in the same entry are not, and one of
them is the identical defect — a universal about re-derivability that one command refutes.

Base `c88a933`, nothing staged or committed, 27 working-tree paths. Worker **12 files /
156 tests**. Every `file:line` below re-derived against the tree as it stands now; where a
Round 1 or Round 2 citation has moved, I say so rather than repeating it.

### Where Round 3 supersedes my earlier rounds

| Earlier | Corrected |
|---|---|
| Round 2, M-2: "`grep -rn "new Redis(\|RedisClient("` finds **three** constructions" | **Five.** QA is right and my count was low. `tests/event.processor.integration.test.ts:580` and `tests/stream.consumer.integration.test.ts:365` were missed; both take `reservedDbUrl`, so the conclusion is unchanged — see §3 |
| Round 1 `:161`/`:173`, Round 2 M-5, and `src/constants.ts:603`: the dead-letter `xadd` is at `dead-letter.service.ts:192` | **`:216`.** The F-3 docstring rewrite added 24 lines above it. My review text is a historical record and stays; the copy in shipped source is finding **R3-6** |
| Round 1 L-5 cited the epic's correction block as `:180-195` | `:184-202` (already corrected in Round 2; restated here because R3-7 cites it) |

---

### Findings

#### HIGH

**R3-1 · `.claude/rules/known-gaps.md:1071` — S-33 row 4's "`git log -S` finds it in **no committed revision**" is false, and one command refutes it.**

The row qualifies itself with a claim about re-derivability:

> …this was caught *within* T-040 and corrected before commit, so `git log -S` finds it in
> **no committed revision**.

Run unscoped, it does:

```
$ git log -S "fourteen distinct log messages" --oneline --all
c88a933 feat(worker-service): implement T-040 event to UsageLine processor

$ git grep -n "fourteen distinct log messages" c88a933
c88a933:docs/reviews/t-040-event-usageline-processor.md:731:
  > `StreamConsumer` writes fourteen distinct log messages; thirteen are named by exactly one
```

The prior text is committed — quoted verbatim in T-040's own review — so it is both findable
and *verifiable*, which is the opposite of what the row says. What is true is the file-scoped
form: `git log -S "fourteen" -- apps/worker-service/src/constants.ts` returns nothing, i.e. no
committed revision of the **comment** carried it.

This is HIGH by the flat rule in `.claude/rules/review-standards.md` ("a false claim in
`CLAUDE.md` or `.claude/rules/` is HIGH"), the same rule QA applied to F-1. Its practical cost
is low; its specific cost is that it is a universal about evidence, inside the evidence table of
the entry about unverified claims, refuted by the command it names. QA asserted the same thing
(`docs/qa/…:336`, `:480`) — both of us are corrected by running it without a pathspec.

**Fix** (`:1071`), one clause: "…so no committed revision of *that comment* carries it
(`git log -S "fourteen" -- apps/worker-service/src/constants.ts` → empty); the prior wording
survives only as a quotation at `docs/reviews/t-040-event-usageline-processor.md:731`."

While correcting the row: I re-derived its replacement figure and it holds —
`grep -nE "logger\.(info|warn|error|debug)" src/events/stream.consumer.ts` returns **17** lines,
of which `:378` is a comment mentioning `this.logger.error`, so **16 calls**, identical at
`c88a933` and in the worktree (T-041 added no log call to that file).

**R3-2 · `.claude/rules/known-gaps.md:1063-1064` — the table header is still a false universal, which is the half of QA's F-1 that did not get fixed.**

> **Instances. Each row below was re-derived by running its own command at the revisions named —
> including the two rows an earlier draft of this entry got wrong.**

Row 6 (`:1073`) is "S-32's title: 'diverges in **five** ways' | its own body". It states no
command and names no revision, and the state it describes exists nowhere: S-32's title was
corrected to "four ways, plus one unstated cost" at Round 2 (R2-6) and S-32 is uncommitted, so
neither the tree nor `git` can produce it. Row 5 (`:1072`) likewise states no command — one
exists and I ran it (`grep -rn "extends TenantScopedRepository" apps/*/src` → two real
subclasses, `apps/usage-service/src/repositories/usage.repository.ts:150` and
`apps/worker-service/src/repositories/event.repository.ts:64`), but the header claims the rows
carry their own, and two of six do not.

QA raised exactly this ("The header universal is false", F-1 bullet 2). The rewrite dropped the
inflated count and merged the rows but kept the universal.

**Fix** (`:1063-1064`): "Instances. Four of the six state a command, and each of those was
re-derived by running it at the revisions named. Rows 5 and 6 are prose comparisons: row 5 is
re-derivable (`grep -rn "extends TenantScopedRepository" apps/*/src`), row 6 describes a
pre-commit state of an uncommitted entry and is not."

#### MEDIUM

**R3-3 · `apps/worker-service/src/services/dead-letter.service.ts:157-161` — the corrected docstring's "neither grants unlimited retries" is a non-sequitur, and measurement points the other way.**

> Both clauses were false: the two values grant identically at any legal budget, and **neither
> grants unlimited retries** -- the failure path is driven by `HINCRBY`'s return, and `HINCRBY`
> against a corrupt field **errors** rather than counting.

The first clause is right and I confirmed it (§F-3 below). The second does not follow from the
reason given: `HINCRBY` erroring is exactly what stops the budget from ever being reached.
Measured on the shipped tree, through `wrap()`, `MAX_RETRY_COUNT` 3, stored value
`"abc"`, `inner` throwing:

```
max=3 stored="abc" failing=true inner=1 outcome=threw:ERR hash value is not an integer cmds=hget,hincrby
```

No `xadd`, no `xack`: the entry is **never** dead-lettered, is re-offered on every reclaim pass,
and `inner` runs each time. And on live Redis 7.0.15, `HSET k f abc; HINCRBY k f 1` →
`ERR hash value is not an integer`, so the corrupt value persists rather than being overwritten.
The only bound is that `EXPIRE` (`:188`) sits *after* the throwing `HINCRBY` (`:183`), so the TTL
is not refreshed and the hash self-expires at `RETRY_KEY_TTL_SECONDS: 86_400` from the last
successful increment — a mechanism the sentence does not mention.

**Fix** (`:159-161`): "…and neither grants *silently* unlimited retries: below any legal budget
both values let `inner` run, and the failure path then reaches `HINCRBY`, which **errors** on a
corrupt field rather than counting — so the entry is never dead-lettered and is re-offered on
every reclaim pass, loudly, until the `retries:` key expires at its existing TTL (`EXPIRE` is not
reached on that path)."

#### LOW

**R3-4 · `dead-letter.service.ts:139-140` — "`priorCount` is used only at …" omits a third use site.**

The docstring enumerates two comparisons. There are three uses: `:105` (`>=`), `:106`
(`deadLetter(id, fields, REASON_BUDGET_EXHAUSTED, priorCount)` — the value is written into the
dead-letter record as `retryCount`) and `:126` (`>`). The conclusion survives, because `:106` is
dominated by `:105` and `NaN >= n` is false for every `n`; the plan states this correctly
(`docs/plans/…:719-721`, "a third … reachable only through the first") and the docstring is the
weaker of the two. **Fix:** adopt the plan's wording — "two comparison sites, plus a third
(`:106`) reachable only through the first".

**R3-5 · `apps/worker-service/src/constants.ts:124-131` — Round 2's R2-1 was applied by half: the count is right, the taxonomy still sums to eleven.**

The docblock reads "every one of that object's members feeds `src/config/env.ts`'s schema --
**seven** as a `.default(...)` (…) and **four** as the `.min()`/`.max()` bounds (…)" and then
"`grep -c 'WORKER_STREAM_CONSTANTS\.' src/config/env.ts` -> **12**, one per member". 7 + 4 = 11.
Measured: the object has 12 members and `env.ts` has 12 references, one per member, the twelfth
being `DEAD_LETTER_STREAM_COLLISION` at `src/config/env.ts:96`. R2-1's required fix named the
missing clause explicitly ("and one as the cross-field `.superRefine` message"); the paragraph at
`:133-136` explains the twelfth reference two lines later, so nothing is false — the exhaustive
enumeration is simply one short of its own total. **Fix:** add the third clause as R2-1 specified.

**R3-6 · `apps/worker-service/src/constants.ts:603` — stale `file:line`, moved by the F-3 docstring rewrite.**

The `xadd` inventory cites `apps/worker-service/src/services/dead-letter.service.ts:192`; the
call is at **`:216`** (`grep -n "\.xadd(" src/services/dead-letter.service.ts`). It was `:192`
when QA measured it; the docstring rewrite added 24 lines above it. This is the only stale
source-code citation of that file in the tree — `grep -rn "dead-letter\.service\.ts:[0-9]"`
over `*.ts` and `*.md` outside `docs/reviews|qa|plans` returns that one line. **Fix:** `:192` →
`:216`.

**R3-7 · `.claude/rules/known-gaps.md:1043-1046` — QA's F-2 is half-applied: S-32 still says the epic's block "counts all five together", and the two fives differ in *membership*, not only in classification.**

Read against the epic (`docs/epics/epic-7-worker-service.md:184-202`, re-derived):

| | S-32's five | The epic's five |
|---|---|---|
| 1-4 | file path · free function · Prometheus · PEL claim | file path · class vs free function · Prometheus · PEL claim |
| 5 | **the `:156` pre-check cost** | **the record carries `groupName` and the full field list** |

The epic never mentions the pre-check cost — S-32's own bullet says so ("an unstated cost") —
so "counts all five together" contradicts the entry's own body, and the added qualification
describes the difference as one of framing when it is one of contents. **Fix** (`:1043-1044`):
"The epic's `:184-202` block also lists five, but not the same five: its fifth is the record's
`groupName` and field list, where this entry's is the `:156` pre-check cost the epic never
mentions."

**R3-8 · `docs/plans/t-041-retry-tracking-dead-letter.md:698-736` — the plan's Gate-5 section now misdescribes the tree it ships with.**

`:700` marks F-3 "**[blocked, awaiting a decision]** … so this is reported rather than actioned",
and `:731` says the docstring "**currently** says a corrupt counter 'would silently grant
unlimited retries…'". Decision A was taken and the docstring was rewritten; `:157-161` now
records the old text as an earlier revision. The section also records no disposition for QA's
F-1 or F-2, both of which were applied (`grep -n "S-33\|S-32" docs/plans/…` → one hit, L-5).
The plan is part of this commit, so it ships an account of the change that is false about the
change. **Fix:** re-mark F-3 `[done — decision A]`, change "currently says" to "said until Gate-5
Round 3", and add one line each for F-1 (S-33 rewritten) and F-2 (S-32 clause).

**R3-9 · Nothing pins `MAX_RETRY_COUNT_MIN`, the single invariant the F-3 docstring says makes the guard inert — and that is the writable test the three declined options missed.**

`dead-letter.service.ts:152-153` says "Only `MAX_RETRY_COUNT_MIN: 1` keeps that unreachable". I
verified the "only" (the divergence needs `maxRetryCount === 0`; `.int()`, `.max()` and the
default are all irrelevant to it) — and then mutated the floor:

```
src/constants.ts:86   MAX_RETRY_COUNT_MIN: 1  ->  0
$ pnpm --filter @telemetry/worker-service exec vitest run
  Test Files  12 passed (12)      Tests  156 passed (156)
```

Green. Every test reference to that constant is *relative* to it
(`tests/env.schema.unit.test.ts:319` uses it as a bound, `:345` uses `MIN - 1`), so lowering the
floor silently turns the NaN branch load-bearing with no test anywhere. **Fix:** one line in the
env suite, e.g. `expect(WORKER_STREAM_CONSTANTS.MAX_RETRY_COUNT_MIN).toBeGreaterThanOrEqual(1)`
with a comment pointing at `readRetryCount`'s docstring. See the decision at the end — this
changes the diff (worker 156 → 157).

#### NIT

**R3-10 · `.claude/rules/known-gaps.md:1075-1077` — the new self-match sub-pattern is sound for the two rows it cites, and under-specified as a rule.** Both halves check out: `grep -rn "\.xadd(" apps packages --include=*.ts` (excluding `dist/`, `tests/`) returns 3 lines for 2 call sites, and the `RESERVED_STREAM_FIELDS` grep returns 5 for the docblock's stated 5. But the offset is *not* generally one — it equals the number of prose lines in scope carrying the pattern, and `src/constants.ts:422` **and** `:432` both match, which is why that docblock has to name three prose comments. And there is no self-match at all when the command's path scope excludes the commenting file, which is row 1's case (`grep -c … src/config/env.ts`, written in `constants.ts`). Worth one clause in the fix direction at `:1093-1096`, since the proposed CI check has to compute the offset rather than subtract one.

**R3-11 · `src/constants.ts:598` (QA F-5) — the `xadd` re-count command self-matches and is not annotated**, where the `RESERVED_STREAM_FIELDS` docblock at `:432` annotates its own. No count is asserted, so nothing is false. One `| grep -v constants.ts`, or one sentence. Open.

**R3-12 · A failing `XADD` inside `deadLetter` is still untested** (QA F-4). `:204-207` claims the entry stays pending with its counter intact; no case drives it. Follows from the absent `try`, but the claim is two steps downstream. Open.

**R3-13 · Three bare "S-31" labels remain**, beyond the two Round 2 (R2-5) named and the rework fixed: `tests/stream-message.validator.unit.test.ts:73` and `:400`, and `tests/integration.constants.ts:434`. All are labels on a test, none asserts the gap is open, and `grep -rn "S-31" .claude/rules/known-gaps.md` is empty, so H-1 is still satisfied. Open.

---

### The five questions I was asked to rule on

**1 · Is the rewritten S-33 true, and worth keeping?** Four of six rows re-derive clean; two of
them plus the header do not.

| Row | Re-derivation | Verdict |
|---|---|---|
| 1 (`WORKER_STREAM_CONSTANTS` count) | `git show <rev>:…/env.ts \| grep -c` → **7** at `7ad9375`, `b558641`, `7dc7392`, `c88a933`; worktree **12**; `git show --stat c88a933 -- …/env.ts` empty (T-040 never touched it); `git log --oneline -- …/env.ts` → last touched at `7ad9375` | **True.** One imprecision: "T-041's `.superRefine` took it to 12" — the `.superRefine` took it from **11** to 12; the other four came from the two new fields. Reconcilable with the next clause, but loose |
| 2 (single `xadd` site) | 2 production sites (`stream.publisher.ts:70`, `dead-letter.service.ts:216`), grep returns 3 lines incl. the self-match | **True** |
| 3 (`RESERVED_STREAM_FIELDS` four→five) | grep returns 5: producer decl `ingestion.service.ts:15`, producer use `:153`, `constants.ts:422`, `constants.ts:432`, `stream-message.validator.unit.test.ts:19` | **True** |
| 4 (fourteen log messages) | 16 calls confirmed; the `git log -S` clause **refuted** | **False — R3-1** |
| 5 (S-19 subclasses) | 2 real subclasses; S-19 records the correction at `:413` | **True** (no command stated) |
| 6 (S-32 title) | not re-derivable from tree or git | **Unverifiable — R3-2** |

**Worth keeping: yes, and I would keep it even after two bad drafts** — the class it records is
real and this review is its third consecutive instance. What is not worth keeping in its current
form is the six-row evidence table: it is the part that has been wrong every time, and the
entry's argument does not need six rows. See the decision below.

**2 · Release readiness.** Measured, not reasoned:

- **An operator with an existing `.env` who sets neither new variable boots unchanged.** Driving
  the real module: `env … npx tsx -e "import('./src/config/env.ts')"` with only the pre-existing
  variables set → `OK max= 3 dl= telemetry:dead-letter src= telemetry:events`.
- **The one fail-closed case is a collision.** Same harness with
  `REDIS_STREAM_NAME=telemetry:events DEAD_LETTER_STREAM=telemetry:events` →
  `THROWN: Invalid environment configuration for DEAD_LETTER_STREAM: DEAD_LETTER_STREAM must
  differ from REDIS_STREAM_NAME: …`. It names the right field and it happens at module load, so
  the process never listens. An operator reaches it only by explicitly setting
  `REDIS_STREAM_NAME=telemetry:dead-letter` or `DEAD_LETTER_STREAM=telemetry:events`; the two
  defaults differ, and `grep -rn "REDIS_STREAM_NAME" docker-compose*.yml .github/workflows/*.yml`
  → no match.
- **No cross-package surface.** `grep -rn "worker-service" --include=package.json .` outside
  `node_modules` returns only the root `test:smoke` scripts; nothing depends on the package.
  `git status --porcelain package.json prisma pnpm-lock.yaml` → empty. All 12 other packages
  green on an uncached run.
- **Two new runtime effects an operator should be told about once:** a `retries:<stream>` hash
  with a 24 h TTL, and `telemetry:dead-letter`, which has no `MAXLEN` and holds the full original
  field list — `tenantId` and customer metadata — indefinitely. Both are documented in
  `apps/worker-service/.env.example:83-121`, which is the right place; `docs/releases/` currently
  holds notes only for a migration and a role change, so I am **not** requiring one. If one is
  written, the two lines are the fail-closed collision and the unbounded retention.

**3 · The db-0 containment.** Five constructions, not three, and the pin covers all five:

| Site | URL | Effective db |
|---|---|---|
| `src/config/container.ts:61` | `env.REDIS_URL` | 14, via `tests/setup.ts:31` |
| `tests/event.processor.integration.test.ts:227`, `:580` | `reservedDbUrl` | 14 — `redisUrl.pathname = "/14"` at `:224-226` |
| `tests/stream.consumer.integration.test.ts:222`, `:365` | `reservedDbUrl` | 14 — same, `:219-221` |

`setupFiles: ["tests/setup.ts"]` (`vitest.config.mjs:5`) applies to every file the package runs,
including `tests/smoke.test.ts`, so the smoke path is pinned too. **One path I checked that no
earlier round did:** the repo root `.env` contains `REDIS_URL=redis://localhost:6379` — **db 0** —
and `src/index.ts:7-15` loads it with `process.loadEnvFile()`. It cannot win: Node's env-file
loader does not overwrite an already-set variable (measured on node v22.22.2 —
`FOO=from_shell node -e "process.loadEnvFile()"` → `FOO=from_shell`, `BAR=from_file`), and
`setupFiles` runs before the test module graph. Nothing else in `src` or `tests` constructs a
client or names a `redis://` URL that reaches a server.

**The residual, unchanged and accepted:** `setup.ts:31` is `??=`, so an *exported* `REDIS_URL`
defeats it on a direct `pnpm --filter … exec vitest run` — the scoping command `CLAUDE.md` and
`.claude/rules/testing.md` both recommend, which does not go through turbo's strict-env filter.
Integration suites are immune (they overwrite the pathname); a unit test with an unstubbed
command is not. **One-line hardening, not required here:** make the pin unconditional the way the
suites do — parse `process.env.REDIS_URL` and force `pathname = "/14"` rather than defaulting it.

**4 · Coverage alignment.** `vitest run --coverage`, this tree: **10 files measured**, all above
threshold.

```
All files      97.37 % stmts · 90.24 % branch · 91.66 % funcs · 97.37 % lines
               (533 statements, 82 branches, 24 functions)
thresholds     lines/functions/statements 80, branches 75
dead-letter.service.ts   100 stmts · 95.23 branch   uncovered line 171
```

Line **171 is the NaN guard** — v8 names the exact branch QA's F-3 is about, so the gap is
measured, not merely argued. Unmeasured by exclusion: `src/events/**` (the loop, the cadence,
`dispatch`), `src/config/container.ts` (the wiring seam) and the `index.ts` barrels. **The seam
is untested only in the coverage sense** — `tests/config/container.unit.test.ts` (8 cases) pins
that `container.messageHandler` is the wrapped handler, and `I23`/`I26`/`I27` drive decorator →
loop → live Redis end to end; the cadence-deletion mutation reddens all three by assertion.
What is genuinely untested and matters: **R3-9** (the floor) and **R3-12** (a failing `XADD`).
`stream-message.validator.ts:174-175` is uncovered but pre-existing and documented as
unreachable-by-construction (`git diff -U0 c88a933` shows no hunk there).

**5 · F-3 — was declining to write a test right?** **Yes for the three options considered, no as
a general statement**, and the measurement itself reproduces exactly.

I re-ran the inertness probe on a wider matrix than the implementer's — `{"abc", "", "2", null,
"-5"} × {inner resolves, inner throws} × MAX_RETRY_COUNT {3, 1, 0}`, driving the real `wrap()`
through a recording fake, then mutating `:171` to `return parsed;` and re-running:

```
$ diff probe-with-guard.txt probe-no-guard.txt
22,25c22,25
< max=0 stored="abc" failing=false inner=0 outcome=resolved cmds=hget,xadd,xack,hdel
< max=0 stored="abc" failing=true  inner=0 outcome=resolved cmds=hget,xadd,xack,hdel
< max=0 stored=""    failing=false inner=0 outcome=resolved cmds=hget,xadd,xack,hdel
< max=0 stored=""    failing=true  inner=0 outcome=resolved cmds=hget,xadd,xack,hdel
---
> max=0 stored="abc" failing=false inner=1 outcome=resolved cmds=hget
> max=0 stored="abc" failing=true  inner=1 outcome=threw:ERR hash value is not an integer cmds=hget,hincrby
> max=0 stored=""    failing=false inner=1 outcome=resolved cmds=hget
> max=0 stored=""    failing=true  inner=1 outcome=threw:ERR hash value is not an integer cmds=hget,hincrby
```

Twenty-six of thirty rows identical; the four that differ are all `MAX_RETRY_COUNT: 0`, exactly
as claimed, and `tests/env.schema.unit.test.ts:341-355` pins that the schema rejects it. So the
guard is inert at every admissible configuration, no public-seam test can distinguish the two,
and all three declined options were correctly declined — a green-either-way case is a coverage
tick, a cast to a private method asserts an implementation value, and `MAX_RETRY_COUNT: 0`
through `as ServiceEnv` rebuilds the L-7 anti-pattern this task removed.

**What the three options missed is a fourth**, which is R3-9: assert the floor itself. The
docstring correctly identifies `MAX_RETRY_COUNT_MIN: 1` as the *only* thing keeping the branch
unreachable; nothing asserts it, and I reddened nothing by setting it to 0. That is a behaviour-
adjacent invariant, one line, and it makes the docstring's universal citable per
`.claude/rules/review-standards.md` § *Universals Must Cite Their Mutation*.

---

### Compile-time gate — `--force`, all 13 packages, my own run

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` · 9.6 s |
| lint | `pnpm lint --force` | `13 successful` · `0 cached` · **0 errors, 14 warnings** |
| build | `npx turbo run build --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached` · 16.6 s |
| test | `pnpm test --force` | `13 successful` · `Cached: 0 cached, 13 total` · 18.3 s |
| smoke | `pnpm test:smoke` | 6 suites, 7 tests (gateway 2, auth/usage/billing/analytics/worker 1 each) |

Per package: shared-tracing 2 · shared-config 4 · shared-logger 4 · shared-types 8 ·
shared-validation 15 · shared-utils 18 · analytics 18 (4 files) · gateway 38 (8) · billing 18 (4) ·
usage 230 (19) · auth 164 (15) · **worker 156 (12)** · web `--passWithNoTests`.

**The 14 warnings are pre-existing, proven:** eslint names
`apps/auth-service/tests/auth.service.unit.test.ts` (10 × `no-misused-promises`) and
`apps/usage-service/tests/ingestion.service.unit.test.ts` (4 × `no-unsafe-assignment`);
`git log -1` → **`d68e719`** (2026-08-25) and **`b0f6921`** (2026-08-31);
`git status --porcelain apps/auth-service apps/usage-service` → **empty**, so neither package is
in this diff. `grep -c "no-unsafe-return"` over the lint log → **0**. worker-service emits no
findings block. Matches the stated expectation exactly; **zero introduced**.

**Clean-code gate:** the added source carries no magic literals — every literal in
`dead-letter.service.ts` outside comments is a `WORKER_DEAD_LETTER.*` reference (checked by
stripping comments and grepping for quoted strings and bare numerals: no hits);
`src/utils/describe-error.ts` is two lines with none; the only string literal in the new `env.ts`
code is the zod issue `path`, which R2-4 already made `satisfies`-checked. The new unit test
carries no bare numeric assertions. **Pass.**

---

### Datastore state — before and after, Postgres and Redis left running

| | Before | After | Required |
|---|---|---|---|
| db 0 `DBSIZE` | 2 | 3 | — |
| db 0 `XLEN telemetry:events` | 2 | **2** | 2 ✓ |
| db 0 `entries-added` | 2 | **2** | 2 ✓ |
| db 0 consumer groups | 0 | **0** | 0 ✓ |
| db 0 `EXISTS telemetry:dead-letter` | 0 | **0** | absent ✓ |
| db 0 `KEYS retries:*` | none | **none** | absent ✓ |
| db 14 `DBSIZE` | 0 | **0** | 0 ✓ |
| `Event` / `UsageLine` | 0 / 0 | **0 / 0** | 0 / 0 ✓ |

db 0 grew by one `denylist:*` key written by auth-service's suite during `pnpm test --force`
(TTLs 876 s and 46 s at the final check) — **S-22**, pre-existing and out of scope, self-expiring.
My only writes to Redis were `HSET/HINCRBY/DEL zzprobe` in **db 14**, deleted immediately
(`DBSIZE` 0 after).

**Tree restored, proven byte-identical.** Two mutations (`dead-letter.service.ts:171` →
`return parsed;`, `constants.ts:86` → `MAX_RETRY_COUNT_MIN: 0`) and one temporary probe file
(`tests/zz-probe.dl.test.ts`, deleted). After restoration: `md5sum -c` over all 27 paths → **0
mismatches**; `git diff | sha256sum` →
`d41fdcb2df5aef4f2723fb4a9a1778c77aef81eec54914cdba61fa47d01de021`, identical to the snapshot
taken before the first mutation; `git status --porcelain` → 27 entries, unchanged; `git stash
list` empty. Nothing staged, nothing committed. (`apps/worker-service/coverage/` was regenerated
by my coverage run; it is gitignored, `.gitignore:5`.)

---

### What I verified, and what I could not

**Verified by execution this round:** the four gates with `--force` plus smoke, all 13 packages,
0 cached; the 14 warnings' provenance; all six S-33 rows, each by its own command or by the
nearest command that exists; the `WORKER_STREAM_CONSTANTS` member count (12) against `env.ts`'s
reference count (12), one per member; the 16 log calls at both `c88a933` and the worktree; the
`git log -S` refutation of row 4, including the exact quoting file and line; S-32's five against
the epic's five, read side by side; the NaN-guard inertness on a 30-row matrix and its single
divergence at `MAX_RETRY_COUNT: 0`; `HINCRBY` on a corrupt field against live Redis 7.0.15; the
`MAX_RETRY_COUNT_MIN` floor by mutation (156/156 green at 0); the collision refinement and the
defaults path by importing the real env module under `tsx`; coverage (10 files, uncovered line
171); all five Redis constructions and the `reservedDbUrl` pathname overwrite; `process.loadEnvFile()`
precedence on node v22.22.2; worker's leaf status and the unchanged `package.json`/`prisma`/lockfile;
the `.xadd` and `RESERVED_STREAM_FIELDS` self-matches; every `file:line` cited above.

**Could not verify, and why:**

- **S-33's "None was caught by a tool."** No way to falsify retrospectively; no lint or type rule
  in this repo inspects comment contents. Recorded as plausible and unverified, not as confirmed.
- **The pre-rewrite S-33 draft and the moment the count "first wrote 11".** Uncommitted history.
  I verified the consistent traces instead — Round 2's R2-1 and the docblock's own record at
  `src/constants.ts:133-136`.
- **Two concurrent workers double-incrementing one counter** (plan R2). Unchanged from Rounds 1
  and 2; no harness exists and building one is its own task.
- **`MAXLEN` eviction of a pending entry's payload** (decision C's justification). Still inherited
  from the plan's probe; `U64` and `I26` pin the property it justifies.
- **A real deployment boot.** I exercised module load through `tsx` in both directions, which is
  stronger than the previous rounds' evidence, but no worker process was started against a real
  Redis with the collision set.
- **`pnpm format:check`.** Not run — S-12, cannot pass on any revision, not in CI.
- **Whether row 6's refuted text ever existed as written.** S-32 is uncommitted; I take Round 2's
  R2-6 record at its word, which is exactly why R3-2 asks the header to stop claiming otherwise.

---

### Three rounds, one finding class — and what to do instead of a fourth

Round 1 raised M-3, M-4, M-5. Round 2 raised R2-1 and R2-2. Round 3 raises R3-1 through R3-8.
Every one is the same defect: **a claim written by this change, falsified by this change.** Two
of this round's are corrections of corrections — R3-5 is R2-1 applied by half, R3-7 is QA's F-2
applied by half, and R3-1/R3-2 are inside the entry filed to record the class.

I am not asking for a fourth round on this. The instance rate is what a manual discipline
produces, and each round's marginal yield is now three or four sentences of Markdown against a
full gate re-run. **Recommendation:** apply the corrections below as one mechanical pass with
each command re-run at the end rather than when the sentence is written, then ship. If a
further instance turns up afterwards, file it as an S-33 instance — that is what the entry is
for — rather than opening Round 4. The durable fix is the CI check S-33's own fix direction
describes, which is out of scope here and should stay filed.

**Out of scope, recommend adding to `.claude/rules/known-gaps.md`** (as an amendment to S-33
rather than a new id, since it is the same class):
- the self-match offset is not always one (R3-10) — the proposed checker must compute it;
- `file:line` citations inside comments go stale on any edit above the target (R3-6 moved 24
  lines in one docstring rewrite), and no tool checks them either.

---

### Required for `APPROVED FOR COMMIT`

Documentation only; no behaviour changes; no gate re-run needed beyond
`pnpm --filter @telemetry/worker-service lint typecheck` for the two comment edits.

1. **R3-1** — `.claude/rules/known-gaps.md:1071`: scope the `git log -S` clause to the file, and
   cite `docs/reviews/t-040-event-usageline-processor.md:731` as where the prior text survives.
2. **R3-2** — `.claude/rules/known-gaps.md:1063-1064`: weaken the header to what is true of all
   six rows.
3. **R3-3** — `apps/worker-service/src/services/dead-letter.service.ts:159-161`: correct
   "neither grants unlimited retries" to the measured behaviour (never dead-lettered, re-offered
   every pass, bounded only by the unrefreshed key TTL).
4. **R3-7** — `.claude/rules/known-gaps.md:1043-1044`: state that the two fives differ in
   membership, naming each fifth item.
5. **R3-8** — `docs/plans/t-041-retry-tracking-dead-letter.md:700` and `:731`: mark F-3 done under
   decision A, drop "currently says", and record the F-1/F-2 dispositions.

**Strongly recommended, one line each:** R3-5 (the missing `.superRefine` clause — this is R2-1
finished), R3-6 (`:192` → `:216`), R3-4 (the third `priorCount` site).

**R3-9** changes the diff and is the subject of a decision below. R3-10 through R3-13 are NITs:
apply them if the file is open, none blocks.

---

### Decisions for the user

**Decision 1 — What shape should S-33 ship in, given that it has now been wrong in three
successive drafts and is the entry about being wrong?**

| Option | What changes | Diff? |
|---|---|---|
| **A · Correct the two clauses in place** | R3-1 and R3-2 applied as written above; the six-row table stays. Minimum to clear the HIGH. | Yes — ~3 lines |
| **B · Correct, then reduce the table to its two command-backed exemplars** (recommended) | A, plus rows 4, 5 and 6 collapse into one sentence ("the class also covers prose claims and titles; those instances are recorded in the reviews"), leaving rows 1-3, which each state a command that re-runs clean today. The entry keeps its argument and sheds the surface that keeps going stale. | Yes — ~10 lines, 3 rows removed |
| **C · Keep the table, add a re-derivation date stamp per row** | A, plus each row carries the date and revision its command was last re-run, so a future reader knows what is stale rather than trusting it. More honest, more to maintain. | Yes — ~8 lines |
| **D · Ship as-is** | S-33 goes into an authoritative file with a false universal about evidence and a false command result, inside the entry arguing such rows must be re-measured. | No |

**Recommendation: B.** The rows that have been wrong are the ones with no command behind them;
the rows with commands have survived every re-derivation, including mine. B is the only option
that removes the failure mode rather than patching the current instance of it. A is the minimum
I will sign off. D leaves a HIGH finding in `.claude/rules/`, which is the one thing that file
cannot afford. **A, B and C all change the diff (Markdown only); D changes nothing.**

**Decision 2 — Should the `MAX_RETRY_COUNT_MIN` floor get a test (R3-9)?**

| Option | What changes | Diff? |
|---|---|---|
| **A · Add the one-line assertion** (recommended) | `tests/env.schema.unit.test.ts` gains `expect(WORKER_STREAM_CONSTANTS.MAX_RETRY_COUNT_MIN).toBeGreaterThanOrEqual(1)` with a comment citing `readRetryCount`. Worker goes 156 → 157 tests; the docstring's "only … keeps that unreachable" then cites a test that reddens when the floor moves. | Yes — 1 test |
| **B · Decline, and weaken the docstring instead** | `dead-letter.service.ts:152-153` gains "nothing asserts this floor; lowering it silently makes this branch load-bearing". Honest, cheaper, leaves the hole. | Yes — 1 comment line |
| **C · Decline both** | The guard stays inert, untested, and justified by an unpinned invariant. | No |

**Recommendation: A.** It is the one test in this area that is neither tautological nor
schema-violating, it costs a line, and it converts a universal in a docstring into a guarded
one — which is exactly what `review-standards.md` § *Universals Must Cite Their Mutation* asks
for. **A and B change the diff; C does not.** A requires re-running the worker suite only.

---

### Dispositions — everything still open, stated rather than re-found

| Item | Round | Disposition |
|---|---|---|
| **L-3** inline `describeError` in `event-processor.service.ts:140` | R1 | **Accepted, unchanged.** Still two copies, not three (`git status --porcelain …/event-processor.service.ts` → empty). Fold into the next worker-service change and say so in that plan. |
| **L-4** two barrels nothing imports | R1 | **Accepted, unchanged.** `grep -rn 'from "../services"\|from "../utils"' src tests` → no match. Do not add a third. |
| **N-1** record-folding helper written twice | R1 | **Accepted.** Promote on a third. |
| **R2-2** `EnvSchema.shape` recipe vs `ZodEffects` | R2 | **Done** — QA confirmed both halves by importing the real modules; `.claude/rules/known-gaps.md` S-23 and `stream.consumer.ts` both carry the caveat. |
| **R2-4** `path` literal | R2 | **Done** — `satisfies keyof typeof parsed` at `src/config/env.ts:96`; QA reddened it with TS1360. |
| **R2-5** present-tense S-31 references | R2 | **Partly done** — the two named sites reworded; three labels remain (**R3-13**, NIT). |
| **R2-6 / F-2** S-32's title and its "five" | R2/QA | **Half-applied — R3-7 above.** |
| **F-1** S-33 row 1 | QA | **Done and verified.** Row 1 re-derives clean at four revisions; the T-040 misattribution is gone. Two *different* clauses in the same entry are not — R3-1, R3-2. |
| **F-3** NaN guard | QA | **Resolved as a docstring correction (decision A), and the measurement reproduces.** One clause still wrong (R3-3), one enumeration short (R3-4), and the floor it depends on is unpinned (R3-9). |
| **F-4** untested `XADD` failure | QA | **Open, NIT (R3-12).** Not required. |
| **F-5** `xadd` command self-match | QA | **Open, NIT (R3-11).** Not required. |
| Unbounded dead-letter retention of customer payloads | R1 L-6 | **Accepted and documented** at `.env.example:102-121`; retention lever belongs with T-057. No release note required, one recommended if any is written. |
| `setup.ts` `??=` defeatable by an exported `REDIS_URL` on a direct `vitest` run | R2 M-2 | **Accepted residual.** Hardening named in §3; integration suites are immune. |
| Concurrent double-increment; `MAX_RETRY_COUNT`/`STREAM_BLOCK_MS` coupling | plan R2/R7 | **Accepted, correctly disclosed, still unmeasured.** |
| S-19, S-22, S-12, S-25 | standing | Untouched and unaffected by this change. |

---

**Verdict: CONDITIONAL.** Apply required fixes 1-5 (and, preferably, R3-4/R3-5/R3-6 in the same
pass), answer the two decisions, and this is ready. No behavioural finding stands against the
code, and nothing here needs the gate re-run beyond a package-scoped `lint`/`typecheck` — plus
the worker suite if Decision 2 goes to A.
