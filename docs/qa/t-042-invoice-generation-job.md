# QA — T-042 · BullMQ daily invoice-generation job (worker-service)

**Gate 5, independent QA. Verdict: FAIL.**

Narrow FAIL, and it is worth stating what it is *not* first. **Nothing in the shipped production
code is wrong.** I attacked the privilege boundary from `telemetry_worker_app` and could not
break it; I ran the nightly job end to end four times against a real billing-service and a real
BullMQ worker on live Postgres and Redis, and it did the right thing in every scenario including
the failure ones; the full gate is green on all 13 packages with `--force`; and every claim the
rework added that I could re-derive, re-derived exactly.

The FAIL is two findings, one of which is a **regression guard that does not guard on the host
that runs CI** (F-1), and one of which is a **silent revenue-loss path nobody has written down**
that only shows up when the job is actually run twice (F-2). Both were found by executing rather
than by reading, which is what this gate is for.

Reviewed tree: working tree on `main` at base `5cb454a`, T-042 uncommitted, nothing staged.
`git status --porcelain` → 37 entries at start and at end (the 36 the Gate-4 review counted, plus
the review file itself). Nothing committed, staged or branched.

Per S-24's working practice, the `.claude/rules/` revisions I cite are the ones on disk, read with
`cat`/`sed`, not the injected copies: `known-gaps.md` running S-5 → S-44.

---

## 1 · Full gate — all 13 packages, `--force`

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | **13 successful, 13 total · 0 cached** |
| lint | `pnpm lint --force` | **13 successful, 13 total · 0 cached** · 0 errors, **14 warnings** |
| build | `npx turbo run build --force` | **13 successful, 13 total · 0 cached** |
| test | `pnpm test --force` | **13 successful, 13 total · 0 cached** |
| smoke | `pnpm test:smoke` | 6 services, 7 cases, all pass |

`pnpm build -- --force` does not forward the flag; `npx turbo run build --force` was used, as
instructed.

**Per-package test totals, not a headline.** Twelve packages report; `@telemetry/web` runs
`vitest run --passWithNoTests`, contributes 0 and prints no summary line.

```
shared-tracing      2      analytics-service  18
shared-types        8      gateway            38
shared-config       4      usage-service     230
shared-logger       4      billing-service   162
shared-validation  15      auth-service      166
shared-utils       18      worker-service    233
web                 0
                          total             898   (0 failures, 96 files)
```

898 matches the figure handed over. worker 233 and auth 166 both confirmed.

**Lint warnings are pre-existing, proven.** 10 × `@typescript-eslint/no-misused-promises` in
`apps/auth-service/tests/auth.service.unit.test.ts` (`git log -1` → `d68e719`, 2026-08-25) and
4 × `@typescript-eslint/no-unsafe-assignment` in
`apps/usage-service/tests/ingestion.service.unit.test.ts` (`git log -1` → `b0f6921`, 2026-08-31).
Neither file appears in `git status --porcelain`, so neither is modified or untracked by this
change. **`grep -c no-unsafe-return` on the lint log → 0.** Nothing new introduced.

---

## 2 · Defects

### F-1 · MEDIUM — AC2's day-boundary guard is inert on a UTC host, i.e. on CI

`apps/worker-service/src/jobs/invoice-generation.job.ts:62-73` ·
`apps/worker-service/tests/invoice-generation.job.unit.test.ts:149` ·
`apps/worker-service/vitest.config.mjs` (no `test.env.TZ`) ·
`apps/worker-service/tests/setup.ts` (no `TZ`)

**Reproduction.** Replace the `Date.UTC(...)` form with the local-midnight form the docblock
warns against — `new Date(year, month, day - PREVIOUS_DAY_OFFSET)` and
`new Date(year, month, day)` — then run the job suite twice:

```
$ pnpm --filter @telemetry/worker-service exec vitest run tests/invoice-generation.job.unit.test.ts
  Tests  6 failed | 5 passed (11)     # J1 J2 J3 J4 J5 J6, on this host (Asia/Calcutta, −330)

$ TZ=UTC pnpm --filter @telemetry/worker-service exec vitest run tests/invoice-generation.job.unit.test.ts
  Tests  11 passed (11)               # green
```

Nothing in `vitest.config.mjs` or `tests/setup.ts` pins `TZ`, so the second run is what CI
executes. The defect that lands on the wrong invoice — the epic's own second-worst failure, and
the one the plan calls "not self-correcting" because `UsageLine.billed` is set once — ships green
through the gate and only misbehaves once deployed to a non-UTC host.

**Why this is a finding and not a nit.** This is exactly the S-21 shape, and the task solved it
for the SQL half and not the JavaScript half. `I-TZ1` pins **both** of its connections and asserts
against a literal expected set, and I re-performed its mutation record and confirmed it (§4). The
same standard, stated by the task's own plan at S5 — *"if it does not go red, the case is
decoration and must be rewritten before it ships"* — applied to `J5` says `J5` is decoration on
the host that gates the repository. The test comment at `:158-165` is admirably honest about this
("on CI, which runs UTC, the two implementations compute the same value and no assertion can tell
them apart"), but honesty is not a guard, and the limitation is recorded only in a test comment —
not in `.claude/rules/known-gaps.md`, which is where this repository keeps durable records.

The fix is small and has precedent in this very diff. See the decision in §7.

### F-2 · MEDIUM — usage that arrives after its day is invoiced is never billed, and the job reports success

`apps/worker-service/src/jobs/invoice-generation.job.ts:136-154` (the per-tenant loop) ·
`apps/worker-service/src/repositories/billing-enumeration.repository.ts:114-121` (the docblock
that discusses this contract) · `docs/plans/…:242-249` (D5) ·
`docs/releases/t-042-worker-billing-enumerator.md` (operational notes)

**Reproduction, run end to end against the real billing-service.** Two tenants with unbilled
`UsageLine` rows in `[2026-09-15, 2026-09-16)`; run the job; then insert **one more** unbilled
`UsageLine` for tenant A in the *same* window (late-arriving usage — the stream is asynchronous
and the job fires at 02:00 for a day that ended two hours earlier); run the job again.

```
run 1:  tenants:2 succeeded:2 failed:0   created:true,true
        Invoice count 2 · tenant A total 0.120000 (12 units × 0.01)
        qa-ul-a1 billed=t   qa-ul-a2 billed=t

insert qa-ul-a3 (2 units, periodStart 2026-09-15, billed=false)

run 2:  tenants:1 succeeded:1 failed:0   created:false
        Invoice count 2  (correct — no double invoice)
        qa-ul-a3 billed=f   tenant A total still 0.120000
```

The late row is **never billed**. Billing's step-2 early return fires before
`sumUnbilledByMetricKey`, so the new row is not priced and not marked; the next night's window no
longer contains it, so it is never enumerated again either. The job logs `succeeded: 1` and
returns `failed: 0`. This is the plan's §1 failure #1 — *"usage is metered, never invoiced, and
the revenue is simply never billed. Nothing raises an alarm"* — at row granularity rather than
tenant granularity, reached through the very mechanism D5 relies on for idempotency.

**What is and is not claimed.** The double-invoice defence works exactly as documented; I verified
it. The gap is that D5 reasons only about the double-invoice direction and calls the early return
"safe", the release note's operational notes do not mention it, and the review did not reach it
because nothing ran the job twice against a real billing-service. The shipped docblock claim at
`billing-enumeration.repository.ts:121` — *"an enumeration that is right cannot produce a
`200 { invoiceId: null }` for lack of usage"* — is literally true (the re-run returns an existing
invoice id, not `null`), and it is the sentence a reader will take as "enumerated ⇒ billed", which
is false. A universal worth requalifying under `.claude/rules/review-standards.md` § *Universals
Must Cite Their Mutation*.

The fix is not worker-service's to make — it is billing's ordering, or a product decision about
supplementary invoices — so what this gate asks for is the **record**, not the code. See §7.

### F-3 · LOW — S-26's teardown-line claim no longer holds when a job is in flight, and T-042 is what changed it

`.claude/rules/known-gaps.md:987` (S-26) · `apps/worker-service/src/index.ts:70`, `:94`, `:145`

S-26 states that since T-043, "on a clean signalled shutdown both teardown lines are emitted",
naming `"Stream read interrupted by shutdown"` and `"Stream consumer loop stopped"`, and the entry
says its block-length table "was not re-derived at T-043". T-042 inserts `await
invoiceQueue?.close()` *before* `streamConsumer.stop()`, so whenever that close outlives one
`STREAM_BLOCK_MS`, the parked read expires by itself and there is no read left to interrupt.

**Measured, two real `SIGTERM`s against a real `node --import tsx src/index.ts` on Redis db 14:**

| Run | `Stream read interrupted by shutdown` | `Stream consumer loop stopped` | wall clock |
|---|---|---|---|
| idle queue | **present** | present | 208 ms |
| nightly job in flight | **absent** (`grep -c` → `0`) | present | 17 073 ms |

Nothing is lost and nothing is wrong — this is observability only, which is why it is LOW. It is
filed because `.claude/rules/` is designated authoritative and is now narrower than it reads, and
because S-26 explicitly flags its own un-re-derived half as the thing the next change should
check. This change is that change.

---

## 3 · Priority 1 — attacking the privilege boundary

Everything below was run as `telemetry_worker_app` with its own credential and nothing else.
`current_user` confirmed `telemetry_worker_app`, `rolsuper = f`, `rolbypassrls = f`,
`rolcreatedb = f`, `rolcreaterole = f`.

**Table reach — I could not get past the two tables.**

```
Tenant, User, RefreshToken, Invoice, InvoiceLineItem, Meter,
MetricRollup, ExportAudit, _prisma_migrations   -> ERROR: permission denied for table <t>
Event, UsageLine                                 -> 0   (RLS, no tenant context)
DELETE FROM "UsageLine" WHERE false              -> ERROR: permission denied for table UsageLine
DELETE FROM "Event"     WHERE false              -> ERROR: permission denied for table Event
TRUNCATE "Event"                                 -> ERROR: permission denied for table Event
```

No `DELETE`, matching the release note. `pg_class` holds no `relkind='S'`, so there are no
sequences to reach.

**Escalation — every route refused.**

```
SET ROLE telemetry_worker_definer / telemetry_app / postgres / telemetry_auth_definer
  -> ERROR: permission denied to set role "<r>"   (all four)
CREATE TABLE public.zz / CREATE FUNCTION public.zz_evil() … SECURITY DEFINER
  -> ERROR: permission denied for schema public   (so no definer chaining, and no
                                                   CREATE OR REPLACE of the resolver)
CREATE SCHEMA zz_qa        -> ERROR: permission denied for database telemetry
pg_read_file('/etc/passwd')-> ERROR: permission denied for function pg_read_file
current_setting('data_directory') -> ERROR: permission denied to examine "data_directory"
COPY (SELECT 1) TO '/tmp/zz'      -> ERROR: permission denied to COPY to a file
CREATE TEMP TABLE                 -> allowed (PUBLIC's default TEMP on the database; harmless)
```

**Function reach — exactly one.** `has_function_privilege(current_user, …, 'EXECUTE')` over every
function in `public`: `worker_resolve_tenants_with_unbilled_usage` → `t`, both auth resolvers →
`f`, and calling either gives `ERROR: permission denied for function auth_resolve_tenant_by_*`.
The symmetric negative also holds: `telemetry_app` **and** `telemetry_auth_app` both get
`ERROR: permission denied for function worker_resolve_tenants_with_unbilled_usage`.

**Making the resolver return more — I could not.**

- **Injection through the `text` parameters is dead.** `'2026-01-01'' or true --'` and
  `'x'';drop table "Event";--'` both raise
  `ERROR: invalid input syntax for type timestamp: "…"` from inside the function body
  (`CONTEXT: SQL function "worker_resolve_tenants_with_unbilled_usage" statement 1`), with the
  `"Event"` table still present afterwards. The cast is the parser, so the parameter never
  becomes SQL text.
- **`search_path` capture fails.** Under `SET search_path TO pg_temp,public` with a `pg_temp`
  table literally named `"UsageLine"` seeded with a sentinel `'CAPTURED'` row, the resolver
  returned **0 rows** — the body is schema-qualified `public."UsageLine"` and the function pins
  `search_path = pg_catalog, pg_temp`.
- **`NULL` short-circuits.** `STRICT`, so either bound `NULL` → 0 rows, no table access.
- **`SETOF text` is all there is.** No quantity, no `UsageLine` id, no period, no other tenant's
  row: the output is `DISTINCT ul."tenantId"` and nothing else.
- **Observation, not a defect:** the resolver accepts an unbounded window — `('-infinity',
  'infinity')` and `('epoch','now')` both return the full set. So the capability granted is
  "enumerate every tenant that has unbilled usage", not "…within a day". S-43 states it that way
  and is accurate; noting it so nobody later reads the day window as a bound.

**The accepted, documented fact — both halves confirmed independently.** Seeded through
`DIRECT_DATABASE_URL`, removed afterwards:

| Statement | `telemetry_worker_app` | `telemetry_app` |
|---|---|---|
| `SELECT … FROM "UsageLine"`, no tenant context | 0 rows | 0 rows |
| resolver call | both tenant ids | **permission denied for function** |
| `set_config('app.tenant_id', <id>, true)` then `SELECT "UsageLine"` | that tenant's 3 rows | that tenant's 3 rows |
| … then `SELECT count(*) FROM "Event"` | 3 | 3 |
| … then `UPDATE "UsageLine" SET billed = true WHERE "tenantId" = <id>` | `UPDATE 1` (×3, rolled back) | `UPDATE 1` (×3, rolled back) |
| `set_config` to a **tenant id that does not exist**, then `SELECT` | 0 rows | — |

So the read/write capability is unchanged from `telemetry_app` and the resolver adds exactly one
thing: the ids no longer have to be known. **The code and docs do not overclaim** — the corrected
wording in `billing-enumeration.repository.ts:70-92`, in the release note's *"What that widens"*
section and in S-43 all match what I measured, including the `permission denied` asymmetry. I
found no surviving instance of the refuted "the only cross-tenant read it has" universal.

---

## 4 · Priority 3 — the timezone hazard

**Day boundary under five session zones**, pinned with `options=-c timezone=…` and each pin
confirmed with `show timezone` before use (a bare `?timezone=` is accepted and silently ignored).
Seeded rows deliberately straddle the boundary: two tenants inside `[09-15, 09-16)`, one row
**exactly at** `2026-09-16 00:00:00`, one already-`billed` row in the previous day.

| session `TimeZone` | `[09-14,09-15)` | `[09-15,09-16)` | `[09-16,09-17)` |
|---|---|---|---|
| `UTC` | (none) | A, B | B |
| `Asia/Kolkata` | (none) | A, B | B |
| `America/New_York` | (none) | A, B | B |
| `Asia/Kathmandu` (+05:45) | (none) | A, B | B |
| `Pacific/Kiritimati` (+14) | — | A, B | — |

Identical in every zone, the half-open exclusion of the `09-16 00:00:00` row holds, and the
already-billed row is absent. Four zones is more than the three asked for.

**`I-TZ1` re-performed, and it is a genuine guard.** Mutation **M4** — `CREATE OR REPLACE` of the
shipped function with `::timestamptz` in place of `::timestamp(3)`, body otherwise identical:

```
M4, host session (Asia/Kolkata):  Tests  4 failed | 10 passed (14)   -> R1, R2, R11, I-TZ1
M4, DATABASE_URL pinned UTC:      Tests  1 failed | 13 passed (14)   -> I-TZ1 alone
```

Exactly the totals and the case lists the suite's docstring records. So on a UTC CI server `R1`,
`R2` and `R11` all pass under the defect they otherwise catch, and `I-TZ1` is the only thing
standing — it is not decoration and it is not the S-21 shape. **This is what F-1 says is missing
on the JavaScript side.**

**`M1` also re-performed** (parameters redeclared `timestamp(3)`, body casts removed):
`Tests 8 failed | 6 passed (14)` — `R1`–`R5`, `R11`, `R12`, `I-TZ1`, exactly the eight named.

Catalog restored after each mutation and verified byte-identical:
`md5(pg_get_functiondef || proacl || owner)` = `80df483aaaef1200a4f86885961b1859`, the digest the
suite's docstring quotes. `proacl` back to
`{telemetry_worker_definer=X/telemetry_worker_definer,telemetry_worker_app=X/telemetry_worker_definer}`.
(Note for anyone repeating M1: `DROP FUNCTION` discards the owner and the ACL, so restoring
`pg_get_functiondef` alone leaves a different digest — the `ALTER … OWNER TO`, the three `REVOKE`s
and the `GRANT` must be replayed too. I did, and re-verified.)

**`RepeatOptions.tz` — the schedule resolves to 02:00 UTC, measured from the real registered
scheduler**, not from a library reading. After booting the real worker on this host (process zone
`Asia/Calcutta`, offset −330), BullMQ had materialised:

```
telemetry:bull:invoice-generation:repeat:daily-invoice-generation:1789610400000
  -> 2026-09-17T02:00:00.000Z   (local: Thu Sep 17 2026 07:30:00 GMT+0530)
```

Counterfactual on a throwaway queue, same host, same pattern:

```
{ pattern: "0 2 * * *", tz: "UTC" }  ->  2026-09-17T02:00:00.000Z
{ pattern: "0 2 * * *" }             ->  2026-09-16T20:30:00.000Z
```

The constant is set, `Q1` asserts it, and dropping it reddens `Q1` alone (§6).

---

## 5 · Priority 2 — running the job for real

**What I stood up:** the **real** `@telemetry/billing-service` (`node --import tsx src/index.ts`,
port 3004, `DATABASE_URL` = `telemetry_app`, `REDIS_URL` = db 15), plus a **recording stub** on
port 3099 for the timeout and `invoiceId: null` cases where I needed to control the reply. The
worker side was driven through the **real** `InvoiceGenerationQueue` — its shipped `Worker`,
prefix, connection and `defaultJobOptions` — on Redis **db 14**, with a second `Queue` handle used
only to enqueue a job immediately instead of waiting for 02:00. So the untested seam the Gate-4
review named (BullMQ processor → job → HTTP, as one piece) is now exercised.

| Scenario | Result |
|---|---|
| Two tenants, unbilled usage in the previous-day window | `tenants:2 succeeded:2 failed:0`; **one** `POST /v1/internal/billing/generate` per tenant; two `DRAFT` invoices; totals `0.120000` (12 × 0.01) and `0.060000` (3 × 0.02); the four in-window `UsageLine` rows flipped to `billed = true` |
| Day boundary in the live path | the row at `periodStart = 2026-09-16 00:00:00` was **not** billed by a `[09-15, 09-16)` run |
| **Re-run of an already-billed day** | `created:false`, **Invoice count stayed at 2** — no double invoice, and the job said so honestly. **But see F-2**: a late-arriving row in that window is never billed and is reported as success |
| **One tenant fails** | tenant B's meter removed → billing answered `422 METER_NOT_FOUND`; log line `billing-service rejected the invoice request: 422: METER_NOT_FOUND`; tenant A still processed; summary `tenants:2 succeeded:1 failed:1`; the BullMQ job **completed** rather than retrying, which is D5's stated contract |
| `200 { data: { invoiceId: null } }` | treated as success with `created:false`, exactly as `GenerateInvoiceOutcome` documents |
| **`AbortSignal.timeout(10_000)`** | first tenant's call hung; it aborted with `billing-service request failed: The operation was aborted due to timeout`, was counted `failed`, and **the loop continued** — the second tenant was called and succeeded. Whole job wall clock **10 s** |

**Request shape on the wire**, read off the stub rather than from a mock:

```
POST /v1/internal/billing/generate
x-internal-secret: <env.INTERNAL_API_SECRET>
content-type: application/json
{"tenantId":"456793cd-…","periodStart":"2026-09-15T00:00:00.000Z","periodEnd":"2026-09-16T00:00:00.000Z"}
```

Exactly the three keys `generateInvoiceRequestSchema` requires, both bounds UTC-normalised ISO
strings. No response body reaches any log line; failures carry status and billing's `code` only.

**The timeout's real bound is 10 s × tenants, sequentially.** Worth stating with a number because
it is the same wait S-35's unbounded `bullWorker.close()` inherits — see §8.

---

## 6 · Priority 4 — verifying the rework's own claims

Every item below was re-derived by execution. **All of them check out.**

**S-25's coverage figures (third revision).** `pnpm --filter @telemetry/worker-service exec vitest
run --coverage`, run twice, deterministic:

```
Tests 233 passed (233), 17 files
All files   |  98.26 |  93.07 |  94.73 |  98.26
 src/jobs   |    100 |    100 |    100 |    100
 src/queues |    100 |  94.44 |    100 |    100
```

Byte-for-byte the figures in the S-25 addendum. Thresholds at `vitest.config.mjs:95-100` are
`lines/functions/statements 80, branches 75`, and `"src/events/**"` is at `:79` — both citations
correct. **The "no threshold is enforced" claim is also true:** worker's `"test": "vitest run"`
(no `--coverage`), and `grep -n coverage .github/workflows/ci.yml` returns exactly one step,
`pnpm --filter @telemetry/auth-service test:coverage` at `:113`. Nothing in CI reads worker's
thresholds.

**S-42's citations.** All seven re-runnable commands re-run against the shipped epic:
`:208` (**File:** line), `:223` and `:248` (`getTenantsWithUnbilledUsage`), `219`/`236` (the fence
lines), `:232` (`tenantId, ...yesterday`), `:238` ("BullMQ handles retries"), `:269` and `:283`
(the inherited-obligation block). Every number matches. HIGH-2 is properly discharged, and the
anchor-text form means the next insertion can be re-derived rather than re-guessed.

**The rollback lever — I ran all three forms.** On db 14 (the production index is 0; the key names
are identical), against the shipped queue name, prefix and scheduler id, with the `CLIENT INFO`
`db=14` guard asserted before any destructive command:

```
DEL …:repeat  (the documented-and-broken form)
  delayed zset STILL holds repeat:daily-invoice-generation:1789610400000
  scheduler-definition hash EXISTS -> 1 ; job hash EXISTS -> 1
  getJobSchedulers() -> []        <- it looks like it worked

documented 4-command redis-cli sequence (ZRANGE, DEL ×2, ZREM, DEL)
  getJobSchedulers() -> []   getDelayed() -> []

queue.removeJobScheduler("daily-invoice-generation") -> true
  getJobSchedulers() -> []   getDelayed() -> []
```

And the behavioural half, with the cron substituted to `* * * * * *` and a real `Worker` attached
for four seconds — reproducing the release note's table independently:

| lever | jobs that ran in 4 s | delayed after | schedulers after |
|---|---|---|---|
| none (control) | **4** | 1 | 1 |
| `DEL …:repeat` only | **1** | 0 | 0 |
| `removeJobScheduler` | **0** | 0 | 0 |

An operator following the corrected note under pressure gets the outcome it promises. The
superseded form does let one more run fire while reporting an empty scheduler list, exactly as
documented.

**`rediss://` → TLS — good enough, and I can say more than `Q7` does.** `buildQueueConnection`
maps the scheme correctly and matches ioredis field for field:

```
redis://u:p@cache.internal:6380/3  -> {host, port:6380, db:3, username, password}
rediss://…                         -> {host, port:6380, db:3, username, password, tls:{}}
ioredis' own parse of the same     -> {host, port:6380, db:3, tls:true}
```

The `tls: {}` vs `tls: true` equivalence was *read* from ioredis source at Gate 3; I **ran** it.
Against the plain local Redis, `tls: {}` and `tls: true` fail identically (a `TLSSocket`
`connect ETIMEDOUT` → `Connection is closed`), while the no-`tls` client `PING`s `PONG`. So both
truthy values genuinely open a TLS socket and the option is not inert — which is the half that
would have been a silent bug. **Still unverified:** that a real TLS Redis accepts the handshake;
no TLS server was available here either. My call: **yes, that is good enough to ship**, because
the failure mode it removes (plaintext password on the wire against a `rediss://` URL) is closed
by the option taking effect, and the residual is ioredis' contract rather than this code's.

**S-43 and S-44.** Held to the authoritative-file bar. S-43's three-step measurement I reproduced
line for line, including the `telemetry_app` comparison and the `permission denied for function`
asymmetry (§3); its bounding claims (grant scoping, non-membership, `SELECT` on `"UsageLine"`
alone, `STABLE STRICT`, pinned `search_path`, `SETOF text`) all re-derive from the live catalog.
S-44's item 1 is correctly labelled a leading-column observation on an empty table — `"UsageLine"`
is empty, so I did not measure a plan either, and saying so is right. S-44's item 2 is an accurate
statement of `z.string().url()`. **No overclaim found in either.**

**S-19's count.** Re-derived: three named constants
(`usage-service/src/constants.ts:75`, `auth-service/src/constants.ts:69`,
`worker-service/src/constants.ts:919`) plus four executable `set_config` literals
(`analytics`/`billing`/`worker` `base.repository.ts:98`, `auth` `base.repository.ts:105`) — **seven**,
as the entry now says.

**The declined fix — the refusal is right, and I am ruling it correct.**

```
$ md5sum apps/*/src/repositories/base.repository.ts
13a533a2e2c2dcc1ff9db28fb5c7a1fd  analytics   13a533a2e2c2dcc1ff9db28fb5c7a1fd  billing
13a533a2e2c2dcc1ff9db28fb5c7a1fd  worker      8b12b7d596af50a038f5a79c1361b8a5  auth
d2e8d92fd494fb779f4dea7238273b4a  usage
```

Three files are byte-identical. Pointing worker's `:98` at `WORKER_DATABASE.TENANT_CONTEXT_SETTING`
would turn a three-way identity into a two-way one and create a fourth distinct variant of the
five-copy class S-19 exists to describe — from inside a task whose non-goals explicitly exclude
S-19. The DRY objection is real and is now **recorded in S-19 itself** rather than resolved
silently, which is the right disposition for a gap whose whole subject is that the copies must be
changed together. **Refusal upheld.**

**Other re-runnable claims in the diff.** Both docblock review checks produce exactly what they
say: `grep -rn 'worker_resolve' apps/worker-service/src | grep -vE ':[0-9]+: *\*'` → **one** line
(`constants.ts:932`); the `GENERATE_PATH` grep → **two** filtered lines
(`worker/constants.ts:992`, `billing/constants.ts:15`) and **four** unfiltered. `B8` reads billing's
constants off disk and **throws** with a named message when the pattern is absent, so it cannot
pass vacuously.

---

## 7 · Are the acceptance criteria proven? — mutation results

I mutated the implementation for each AC and confirmed the named case goes red, then restored and
verified by `md5sum`.

| AC | Guarded by | Mutation | Result |
|---|---|---|---|
| AC1 · daily at 02:00 **UTC** | `Q1` | drop `tz` from `upsertJobScheduler` | `1 failed \| 8 passed (9)` — **Q1** |
| AC2 · previous **UTC** day, `[00:00, 00:00)` | `J1`–`J5` | `Date.UTC(…)` → `new Date(y,m,d−1)` | `6 failed \| 5 passed (11)` here — **but `11 passed (11)` under `TZ=UTC`. F-1.** |
| AC3 · finds every tenant with unbilled usage | `R1`–`R4`, `I-E1`, plus live run | M1 / M4 on the catalog | `8 failed` / `4 failed`; `I-TZ1` alone under a UTC pin |
| AC4 · one call per tenant with the internal secret | `B1`–`B4`, `B8` | delete the `x-internal-secret` header | `1 failed \| 9 passed (10)` — **B2** |
| AC5 · one tenant's failure does not block the others | `J7`, `J8` | rethrow from the per-tenant `catch` | `3 failed \| 8 passed (11)` — **J7, J8, J9** |
| AC6 · each tenant's result logged separately | `J9` | same mutation | red, as above |
| AC7 · reachable by worker's role and nothing else | `R5`–`R9`, `I-E1` | adversarial probes as the role (§3) | boundary held under every probe |
| AC8 · BullMQ worker closes **before** the stream consumer | `U87` | move `invoiceQueue?.close()` below `stop()` | `1 failed \| 16 passed (17)` — **U87** |
| — retry/retention config | `Q8` | delete `attempts`/`backoff` | `1 failed \| 8 passed (9)` — **Q8** |
| — the only operator-facing failure signal | `Q9` | delete the `JOB_FAILED` log call | `1 failed \| 8 passed (9)` — **Q9** |

**No tautological tests found.** Every case I mutated asserted behaviour, not its own double. The
one AC whose guard does not hold on the gating host is AC2, and that is F-1.

---

## 8 · S-35's obligation, measured with a job in flight

The rework explicitly did not measure the in-flight case. I did — a real
`node --import tsx src/index.ts` on `telemetry_worker_app` and Redis db 14, a real job enqueued,
both tenants' billing calls hanging against a stub, then a real `SIGTERM`:

```
08:19:48.762  Invoice generation job started
08:19:51.798  Shutting down gracefully              <- SIGTERM
08:19:55.486  Stream consumer loop stopped           (the loop's own predicate, not stop())
08:19:58.830  Invoice generation failed for tenant   (tenant 1, +10 s)
08:20:08.831  Invoice generation failed for tenant   (tenant 2, +10 s)
08:20:08.831  Invoice generation job completed
08:20:08.837  Shutdown complete                      exit 0
total: 17 073 ms
```

**The ordering holds and the in-flight job is not truncated** — `invoiceQueue.close()` waited for
the whole nightly run, both per-tenant outcomes were logged, the summary was emitted, and the
process exited 0. The idle case, for comparison, exits in **208 ms**.

So the accepted-unbounded decision behaves as reasoned, and now has a number behind it: the wait
is `TIMEOUT_MS × remaining tenants` in the worst case, **10 s per tenant**. At 2 tenants that is
17 s; a deployment with a 30 s termination grace period and more than two slow tenants gets
`SIGKILL`ed mid-run. The release note's operational note already tells an operator to check this
against their grace period and their tenant count, which is the right disclosure — it simply has
never been measured, and now it has. Not a defect; recorded so the next person does not re-derive
it. F-3 is the one thing this run changed that a rules file still describes differently.

---

## 9 · Compose and CI

- `docker/postgres/init/01-app-role.sql:114-130` creates `telemetry_worker_app` with password
  `telemetry_worker_app_local_dev`; `docker/docker-compose.yml:157` uses the identical
  credential; both string-match. `BILLING_SERVICE_URL: http://billing-service:3004` is set on
  worker's compose block and matches gateway's value.
- The compose comment states plainly that the resolver and the tables do **not** exist in that
  stack, that nothing there runs migrations, and that worker's database paths including the
  nightly job are non-functional in compose — and that `test:smoke:compose` only hits `/health`,
  which touches no database. That is accurate and is the honest form of the disclosure.
- CI: `prisma migrate deploy` runs at `:93`, before `pnpm test` at `:122`, so `v1_7` creates the
  role before any suite needs it. `apps/worker-service/tests/setup.ts` defaults `DATABASE_URL` to
  `telemetry_worker_app`, which is what makes `pnpm test` exercise the real role under turbo's
  strict env mode. The `WORKER_DATABASE_URL` that no step read was removed and the reason recorded
  in the comment block — correct (it was the S-6 shape).
- **Not verified:** I did not start the compose stack. The init script only runs against an empty
  data directory and starting it was outside what I was asked to disturb. As the SQL header itself
  says, the smoke suites could not catch a mistake there either.

---

## 10 · Regression risk across the other 12 packages

- **auth-service** is the only other package this change edits functionally. Its exact-set
  `prosecdef` assertion had to grow to three names, and did; the suite is 166/166 and the two
  added cases include the symmetric negative (`telemetry_worker_app` cannot execute either auth
  resolver), which I confirmed independently from the live catalog. The three definer functions'
  ACLs are each scoped to their own definer plus one app role — no cross-grant.
- **billing-service** is edited only in `tests/env.schema.unit.test.ts` (the compose-consumer
  exhaustiveness guard restored at LOW-3); 162/162. At runtime billing is a *callee* here and its
  contract is unchanged — I ran the real service against the real caller and got the documented
  `201`/`200`/`422` shapes.
- **usage-service, gateway, analytics-service and the seven shared packages** are untouched by the
  diff and all green (230 / 38 / 18 / 51). The `v1_7` migration is additive — a new role, a new
  `NOLOGIN` definer, one policy scoped to that definer, one function — and `telemetry_app`'s
  privileges are unchanged, which I re-confirmed by running the same read/write statements as
  `telemetry_app` and getting the same results as before.
- **`pnpm-lock.yaml`** gains `bullmq@6.3.6`; no other package resolves it, and all 13 build
  from clean under `--force`.

**Residual risk I would carry into the release:** F-2's under-billing path, and the interaction in
§8 between an unbounded queue close and a deployment's termination grace period.

---

## 11 · What I could not validate, and why

- **The compose stack** — not started (see §9). Verified by string-matching the credential across
  three files and by reading, not by running.
- **A real TLS Redis handshake** — no TLS server available. I established that the `tls` option
  takes effect and that `{}` and `true` behave identically, which is strictly more than `Q7`
  asserts, but not that a TLS server accepts the connection.
- **The migration's idempotent re-application** — I was told not to roll back `v1_7`, and
  re-running the file by hand on an already-migrated database was outside that instruction's
  safety margin. The migration's self-checks are read, not re-executed. (Its *checksum* mismatch
  after the post-apply comment edit is the known accepted state and is not reported as a defect.)
- **The index question** — `"UsageLine"` is empty on this host, so `EXPLAIN` proves nothing about
  the enumeration's cost at scale. S-44 item 1 says exactly this and I can add nothing to it.
- **S-20's orphan-`Tenant` hypothesis** — did not reproduce. `Tenant` was **2** before and after a
  full `pnpm test --force` across 13 packages, a `pnpm test:smoke`, a worker `--coverage` run,
  four end-to-end job runs and every probe above. That is a third non-reproduction, not a
  refutation.
- **A 02:00 firing in real time** — I drove the processor path by enqueueing directly and verified
  the *materialised* delayed job's timestamp is `2026-09-17T02:00:00.000Z`. Nobody waited until
  02:00.

---

## 12 · Environment left as found

- **PostgreSQL:** `Tenant` **2**, `User` 2, and `RefreshToken`, `Event`, `UsageLine`, `Invoice`,
  `InvoiceLineItem`, `Meter`, `MetricRollup`, `ExportAudit` all **0**. Re-counted at the end. **No
  orphan `Tenant` appeared at any point.** Every fixture was seeded through `DIRECT_DATABASE_URL`;
  no running service was ever pointed at it.
- **Roles:** all five present and unchanged (`telemetry_app`, `telemetry_auth_app`,
  `telemetry_auth_definer`, `telemetry_worker_app`, `telemetry_worker_definer`). `v1_7` not rolled
  back, neither new role dropped.
- **`SECURITY DEFINER` functions:** three, with the ACLs quoted in §3 — the resolver restored to
  digest `80df483aaaef1200a4f86885961b1859` after both mutations.
- **Redis:** db 14 flushed under a `CLIENT INFO` → `db=14` guard asserted immediately before the
  `FLUSHDB`; db 15 at 0. **db 0 was never written to by me** — it holds `telemetry:events` and one
  TTL'd `denylist:*` key written by auth-service during the mandated `pnpm test` run, which is
  S-22 and unavoidable. Reported rather than rounded to green.
- **Working tree:** the four source files I mutated restored and verified by `md5sum -c`; all six
  temporary driver scripts removed from the package (`git status --porcelain` finds no `qa-*`).
  37 entries at start and at end, nothing staged, `HEAD` still `5cb454a` on `main`. Nothing
  committed, staged or branched.
- **Services started and stopped:** one real billing-service (port 3004) and two recording stubs
  (port 3099), all terminated. PostgreSQL and Redis left running and untouched.

---

## 13 · Decisions for the user

Two, and only the first changes the diff.

### D-QA-1 · How should AC2's day boundary be guarded on a UTC CI server? (F-1)

The code is correct; the test that would catch it regressing passes under `TZ=UTC`.

| Option | What changes in the diff |
|---|---|
| **A · Pin a non-UTC `TZ` for the job unit suite (recommended)** | Add `test: { env: { TZ: "Asia/Kolkata" } }` (or an equivalent per-file pin) to `apps/worker-service/vitest.config.mjs`, and a sentence on `J5` saying the pin is what makes it a guard. Two lines plus a comment. It is the direct analogue of what `I-TZ1` already does for the database connection, so it introduces no new pattern. Risk: the pin applies to every case in the file, so any other case that silently assumes UTC would surface — which is information, not a cost. |
| **B · Assert both zones, as `I-TZ1` does** | Add a `J5b` that computes the range in a child process under `TZ=UTC` **and** under a non-UTC `TZ` and asserts the two agree. Strictly the closest match to `I-TZ1`'s two-pinned-arms shape and immune to the runner's ambient zone, at the cost of spawning a process in a unit suite. |
| **C · Accept and record** | No code change. A `known-gaps.md` entry saying AC2's guard is host-dependent, on the S-21 precedent ("a guard that exists for a verified behaviour is worth knowing you do not have"). Cheapest, and it leaves the epic's second-worst failure mode ungated on the machine that gates the repo. |

**Recommendation: A.** It is the smallest change that makes the case assert what its name claims,
and the repository has already paid a review round for exactly this lesson on the SQL side. **A
and B change the diff; C does not.**

### D-QA-2 · Where should the late-arriving-usage gap be recorded? (F-2)

Nothing here proposes changing billing-service inside a worker-service task — that is the
one-task-per-commit objection this repo has honoured four times.

| Option | What changes in the diff |
|---|---|
| **A · New `known-gaps.md` id (recommended)** | One entry: usage that lands in a window after that window's invoice exists is never billed, the job reports success, and the reproduction above. Plus one sentence in the release note's operational notes and a requalification of the "cannot produce a `200 { invoiceId: null }`" universal at `billing-enumeration.repository.ts:121`. Documentation only. |
| **B · Fold it into S-38** | S-38 is already about billing's invoice-creation path having no live test. Cheaper, but S-38's title is scoped to the `P2002` re-read, so folding would make that title false — the exact objection S-32 records for not folding into S-29. |
| **C · Fix it now** | Change billing's ordering so an existing invoice does not short-circuit newly-unbilled rows, or add supplementary invoices. Real product decision, another service, its own task. Out of scope here. |

**Recommendation: A.** The behaviour may well be the right product answer; what is not acceptable
is that it is written down nowhere and that the only person who found it had to run the job twice.
**C changes the diff; A and B are documentation.**

---

## 14 · Release-readiness call

**FAIL — back to Gate 3**, for a short, bounded list:

1. **F-1** — close or record AC2's host-dependent guard (D-QA-1).
2. **F-2** — record the late-arriving-usage path and requalify the universal at
   `billing-enumeration.repository.ts:121` (D-QA-2).
3. **F-3** — narrow S-26's "both teardown lines are emitted" to what is now true, citing the
   in-flight measurement in §8.

None of the three changes production behaviour, and none of them casts doubt on the design. The
privilege boundary is the strongest thing in this change: it is bounded by mechanism, I attacked
it from the granted credential along every route I could construct, and it did not move. The
resolver is injection-proof and zone-independent across five session zones. The job does the right
thing end to end, isolates failures, times out, and does not double-invoice. The rollback lever
works. The rework's claims are, without exception, accurate.

What it is not yet is *guarded against the two things that would hurt most* — a day boundary that
regresses invisibly on CI, and revenue that is metered, enumerated, reported as succeeded, and
never billed.
