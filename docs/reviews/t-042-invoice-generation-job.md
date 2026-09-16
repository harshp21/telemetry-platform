# Senior Review — T-042 · BullMQ daily invoice-generation job (worker-service)

## Round 1 — Gate 4, pre-QA

**Verdict: CONDITIONAL.** No blocker. The privilege boundary is built correctly and I could not
break it from `telemetry_worker_app`. The required fixes are all *claims* — five of them in files
`CLAUDE.md` designates authoritative or in comments beside the security-relevant code — plus one
release-note rollback lever that does not do what it says, measured, and one untested option set.

Reviewed tree: working tree on `main` at base `5cb454a`, nothing staged or committed; 24 modified
files + 12 untracked paths, unchanged before and after this review (`git status --porcelain` →
36 entries at start and at end).

Per S-24's working practice, the `.claude/rules/` revision I read is the one on disk, `cat`-ed
rather than taken from the injected copy: `known-gaps.md` md5 `42a7603a004cd1237f473ae24f274458`,
35 `## S-` headings, running S-5 → S-42.

---

## Findings

### HIGH-1 · `.claude/rules/known-gaps.md:844` — the S-25 coverage figures are wrong as introduced

The addendum states the post-removal worker coverage as
`97.38 / 92 / 94.73 / 97.38`. Measured twice, deterministically, on this tree:

```
$ pnpm --filter @telemetry/worker-service exec vitest run --coverage
 Tests  230 passed (230)
All files  |   98.13 |    92.91 |   94.73 |   98.13
 src/jobs  |     100 |      100 |     100 |     100
 src/queues|   98.59 |    93.33 |     100 |   98.59
```

`src/jobs` (100%) and `src/queues` (`98.59 / 93.33`) are quoted exactly right; only the
**All files** row is wrong, in three of its four numbers. `.claude/rules/` is designated
authoritative and other agents are told to trust it without re-verification, so this is HIGH by
the rule even though the entry's *conclusion* — "no threshold had to move", 98.13 > 80 and
92.91 > 75 — survives.

**Fix:** `.claude/rules/known-gaps.md:844` → `98.13 / 92.91 / 94.73 / 98.13`, and say the run
that produced it (`vitest run --coverage`, 230 cases), since `pnpm test` is `vitest run` with no
`--coverage` and enforces no threshold at all.

### HIGH-2 · `.claude/rules/known-gaps.md:1880-1918` — every S-42 line citation into the epic is stale, and the entry claims they were re-derived

S-42 says "Line numbers re-derived with `grep -n` at T-042's Gate 3, against the tree that
shipped it." They were not re-derived against the tree that shipped, because the same diff
inserted a 6-line forward-reference block at `docs/epics/epic-7-worker-service.md:211-215` and
shifted everything below it. Re-derived by me with `grep -n`:

| S-42 cites | Actual on disk |
|---|---|
| `:208` **File:** line | `:208` ✓ |
| `:217` `getTenantsWithUnbilledUsage(yesterday)` | **`:223`** |
| `:214-228` the snippet | **`:219-236`** |
| `:226` `{ tenantId, ...yesterday }` | **`:232`** |
| `:232` "BullMQ handles retries…" | **`:238`** |
| `:234-248` the inherited-obligation block | **`:269-283`** |

`:234-248` now lands in the middle of the snippet and the "What T-042 shipped" list, so the
sentence "the inherited-obligation block at `:234-248` is accurate" points at text that is not
the obligation block. This is S-33's own thesis — a measured claim going wrong inside the commit
that changes it — inside the entry family (S-29/S-32/S-35) whose whole subject is citation
accuracy.

**Fix:** re-run `grep -n` against the shipped epic and replace all five numbers; or cite by
anchor text rather than by line, which is what stops this recurring on the next insertion.

### MEDIUM-1 · The "only cross-tenant read" universal is refuted by measurement

`apps/worker-service/tests/billing-enumeration.integration.test.ts:476` —
"so the only cross-tenant read it has is the resolver's `SETOF text`" — and the same framing at
`apps/worker-service/src/repositories/billing-enumeration.repository.ts:36-43` ("The database
grants this service's role nothing else … **This is the mechanism; the rest are weaker**"),
`apps/worker-service/.env.example` and the release note.

`I-E1` measures the right thing and passes for the right reason: as `telemetry_worker_app` with
no tenant context, `SELECT "tenantId" FROM "UsageLine"` returns zero rows. But that is "no
cross-tenant read *in one statement with no tenant context*", not "no cross-tenant read". Run as
`telemetry_worker_app` against two seeded tenants (seeded through `DIRECT_DATABASE_URL`, removed
afterwards):

```
1) SELECT * FROM public.worker_resolve_tenants_with_unbilled_usage('2026-03-01T…','2026-04-01T…')
   -> zz-t042-rev-A
      zz-t042-rev-B
2) BEGIN; SELECT set_config('app.tenant_id','zz-t042-rev-B',true);
   SELECT id,"tenantId" FROM "UsageLine";   -> zz-ul-B|zz-t042-rev-B
   SELECT id,"tenantId" FROM "Event";       -> zz-ev-B|zz-t042-rev-B
3) UPDATE "UsageLine" SET billed = true WHERE "tenantId"='zz-t042-rev-B';  -> UPDATE 1
   ROLLBACK;
```

So the role reads **and writes** any tenant it can name, and the resolver is what makes it able to
name all of them. That is not a defect in the design — the GUC is set by the application on every
service, worker legitimately writes every tenant's `Event`/`UsageLine` off the stream, and this
capability is unchanged from `telemetry_app`. What *did* change is that a tenant id no longer has
to be known: the exception converts "read any tenant whose UUID you already hold" into "read every
tenant". That is the honest statement of the trade and the diff does not make it anywhere.

**Fix:** weaken the claim at `billing-enumeration.integration.test.ts:476` to what `I-E1`
measures — *"the only cross-tenant read it has **in a single statement, with no tenant context
set**"* — and add one sentence to the repository docblock and the release note saying that the
resolver removes the need to know a tenant id, which is the widening being accepted. Recommend a
`known-gaps.md` entry recording it so the next service that asks for a resolver is made to look.

### MEDIUM-2 · `invoice-generation.queue.ts:46` — `buildQueueConnection` silently drops `rediss://` TLS

The container hands `env.REDIS_URL` to ioredis, which parses the whole URL
(`container.ts:78`). `buildQueueConnection` re-implements that parse by hand and keeps only
`host`, `port`, `db`, `username`, `password`. Measured:

```
ioredis   "rediss://user:pass@cache.internal:6380/3"
          -> {host:"cache.internal", port:6380, db:3, tls:true, username:"user", password:<set>}
hand-parsed same URL
          -> {host:"cache.internal", port:"6380", db:"3"}   protocol dropped: "rediss:"
```

Against a TLS-only Redis this fails closed (connect error → `registerSchedule()` rejects →
`start()`'s `.catch` exits non-zero), which is survivable. Against a Redis that accepts both, the
queue connects in plaintext and the password above goes on the wire unencrypted, while the stream
consumer on the same host is using TLS. Nothing in the suite would notice.

**Fix:** `invoice-generation.queue.ts:52-58`, add
`...(parsed.protocol === "rediss:" ? { tls: {} } : {})` and a `Q4` case asserting it — or state
in the docblock that only `redis://` is supported and make the schema reject anything else. Do not
leave the difference from `container.ts` undocumented.

### MEDIUM-3 · `docs/releases/t-042-worker-billing-enumerator.md:148` — rollback lever 1 does not stop the next run

Measured against a real queue built with the shipped constants on Redis db 14:

```
after upsertJobScheduler:
  telemetry:bull:invoice-generation:repeat                                  (zset)
  telemetry:bull:invoice-generation:repeat:daily-invoice-generation         (scheduler def)
  telemetry:bull:invoice-generation:repeat:daily-invoice-generation:1789610400000
  telemetry:bull:invoice-generation:delayed  -> repeat:daily-invoice-generation:1789610400000

$ redis-cli -n 14 DEL telemetry:bull:invoice-generation:repeat    -> 1
after:  delayed zset STILL holds repeat:daily-invoice-generation:1789610400000
        queue.getDelayed() -> [{ name:"generate-daily-invoices", id:"repeat:…:1789610400000" }]
        the scheduler-definition hash is still present
```

The already-materialised delayed job survives the documented `DEL` and will still fire at its
scheduled time, which is precisely what the lever exists to prevent. The lever's own second
option ("deploy with the scheduler registration disabled") is sound.

**Fix:** replace the `DEL` with `queue.removeJobScheduler(WORKER_INVOICE_JOB.SCHEDULER_ID)` (which
removes the zset entry, the definition and the delayed job), or state the three keys that must go
together. Also say which logical database production uses — `<db>` is `0` per D3, and an operator
guessing 14 from the test constants would delete nothing.

### MEDIUM-4 · The BullMQ job options and the only operator-facing failure signal have no test

`invoice-generation.queue.ts:103-111` sets `attempts`, `backoff`, `removeOnComplete`,
`removeOnFail`; `:126-128` registers the `"failed"` handler that logs
`WORKER_INVOICE_JOB.LOG.JOB_FAILED`.

```
$ grep -rn "ATTEMPTS\|BACKOFF\|REMOVE_ON_COMPLETE\|REMOVE_ON_FAIL\|JOB_FAILED" apps/worker-service/tests/
  (no match outside stream.consumer.unit.test.ts's unrelated ERROR_BACKOFF_MS)
$ grep -n "workerOn" apps/worker-service/tests/invoice-generation.queue.unit.test.ts
  42:const workerOn = vi.fn();     54:    on = workerOn;      <- captured, never asserted
```

Coverage agrees: `src/queues/invoice-generation.queue.ts` line **127** is the only uncovered line
in the file. So deleting `attempts`/`backoff` — the exact thing the constants docblock and epic
divergence #5 are about ("retries are an option, not a default") — ships green, and so does
deleting the log line that is the only signal a nightly run failed until T-057.

I did verify the configuration is live, since nothing in the suite does: a scheduler-produced job
inherits `defaultJobOptions` —
`opts: {"attempts":3,"backoff":{"delay":60000,"type":"exponential"},"removeOnFail":90,"removeOnComplete":30,…}`
read off the real delayed job.

**Fix:** extend `Q2`/`Q3` to assert `queueOptions.defaultJobOptions` against the constants, and add
a case that invokes the recorded `workerOn` handler and asserts `logger.error` was called with
`WORKER_INVOICE_JOB.LOG.JOB_FAILED`.

### MEDIUM-5 · `billing-enumeration.repository.ts:50` — the review check states an output the command does not produce

Item 4 of "What actually bounds the exception" says the check is that
`grep -rn 'worker_resolve' apps/worker-service/src` "returns the constant in `constants.ts` and
the fragment above, and nothing else". Run:

```
apps/worker-service/src/constants.ts:932:  UNBILLED_TENANTS_FN: "public.worker_resolve_tenants_with_unbilled_usage",
apps/worker-service/src/repositories/billing-enumeration.repository.ts:50: *    `grep -rn 'worker_resolve' …
apps/worker-service/src/repositories/billing-enumeration.repository.ts:61: * `function public.worker_resolve_tenants_with_unbilled_usage(timestamp with time zone,
```

The "fragment above" (`RESOLVER_FRAGMENT` at `:12`) contains no such text and does not match; the
two lines that do are this docblock matching itself. The sibling file
`event.repository.ts:51-58` names this exact self-match trap in the same diff, so the pattern was
known and missed here. MEDIUM rather than LOW because this is the stated review check that bounds
a deliberate tenant-isolation exception: a reviewer following it literally sees three lines,
none of them "the fragment", and either spends a round or waves it through.

**Fix:** state the expected output as it is — one constant declaration plus this docblock's own two
self-matching lines — or scope the check to exclude comments.

### MEDIUM-6 · `billing-enumeration.integration.test.ts:32-57` — the mutation record is from a 12-case suite; the suite has 14, and M4 reddens a fourth case

The docstring records `M1` as `Tests 6 failed | 6 passed (12)` and `M4` as
`Tests 3 failed | 9 passed (12)` naming `R1`, `R2` and `I-TZ1`. The file holds **14** cases.
I re-performed M4 — `CREATE OR REPLACE` of the shipped function with `::timestamptz` in place of
`::timestamp(3)`, catalog restored afterwards and verified byte-identical by
`md5(pg_get_functiondef || proacl || owner)` = `b1698fe219141deba6c4f5ca9b996376`:

```
Tests  4 failed | 10 passed (14)   -> R1, R2, R11, I-TZ1
```

`R11` (the repository against the live connection) also goes red and is not in the list.

**The load-bearing half of the claim is true and I verified it separately**, because this is the
S-21 failure mode and the task asked for the red rather than the green. Re-running the same
mutation with `DATABASE_URL` pinned to `options=-c timezone=UTC` — i.e. simulating CI's
`postgres:16-alpine`, where `R1` cannot see the defect:

```
Tests  1 failed | 13 passed (14)   -> I-TZ1 alone
```

So `I-TZ1` is a genuine guard on a UTC server, and the rework from the one-armed version was
correct. Only the recorded totals and the failing-case list are stale.

**Fix:** re-run M1 and M4 against the shipped 14-case suite and replace both quoted totals and the
`R1`, `R2`, `I-TZ1` list. If M1 is not re-run, say so rather than carrying a 12-case figure.

### MEDIUM-7 · `.claude/rules/known-gaps.md:554` — S-19's "six places" is now seven, and the same diff edited S-19

The diff adds `WORKER_DATABASE.TENANT_CONTEXT_SETTING: "app.tenant_id"`
(`apps/worker-service/src/constants.ts:919`), a **third** named constant for a setting S-19 counts
at "two named constants … and four hard-coded literals". Re-derived:

```
$ grep -rn '"app\.tenant_id"' apps packages --include=*.ts | grep -v /dist/
apps/worker-service/src/constants.ts:919          <- new
apps/usage-service/src/constants.ts:75
apps/auth-service/src/constants.ts:69
apps/worker-service/tests/event.repository.unit.test.ts:46
apps/billing-service/tests/invoice.repository.unit.test.ts:24
apps/billing-service/tests/meter.repository.unit.test.ts:24
```
plus four `set_config('app.tenant_id', …)` literals, one of them in worker-service's **own**
`src/repositories/base.repository.ts:98`. So worker-service now carries a constant and a literal
for the same setting inside one package — the DRY case `.claude/rules/constants.md` names
explicitly ("a definition duplicated between `constants.ts` … and a repository is a finding"),
and the entry that asks for promotion was edited in this diff without its count being re-derived.

Graded MEDIUM rather than HIGH-1's level because the number was already there and this change made
it stale rather than introducing it, and the entry's conclusion is unchanged.

**Fix:** update S-19's count to seven and name the new site; and either point
`base.repository.ts:98` at `WORKER_DATABASE.TENANT_CONTEXT_SETTING` in this change (one file, one
package, value-identical) or say in the new constant's docblock that the duplication inside this
service is deliberate and belongs to the shared-package task.

### MEDIUM-8 · `apps/worker-service/src/constants.ts:957-962` — the promotion-threshold grep claim is false

The docblock says the quoted grep "returns only `apps/billing-service/src/constants.ts:15`; the
other nine occurrences of the path anywhere in the repo are prose". Run:

```
$ grep -rn '"/v1/internal/billing/generate"' apps packages --include=*.ts | grep -v /dist/
apps/worker-service/src/constants.ts:958      <- this docblock
apps/worker-service/src/constants.ts:960      <- the line carrying the grep, matching itself
apps/worker-service/src/constants.ts:981      <- GENERATE_PATH, this file's own declaration
apps/billing-service/src/constants.ts:15
```

Four lines, not one, and "nine other occurrences" is not derivable from anything: repo-wide
(excluding `node_modules`, `dist`, `.git`) there are **45** occurrences across 30 files; within
`apps packages --include=*.ts` there are 16.

The *substance* is right — there are exactly two executable copies, and the promote-before-the-third
threshold is applied consistently with T-046. Only the evidence sentence is wrong, and `B8`
(reading billing's constants off disk) is a good mechanical substitute for the import.

**Fix:** restate the grep's actual output, or drop the sentence and keep the "two executable
copies, `B8` keeps them in step" claim, which is true.

---

### LOW-1 · `apps/worker-service/src/constants.ts:1075-1077` — the `PREVIOUS_DAY_OFFSET` docblock describes a different constant

"Number of hours in a day, and the number of milliseconds in one" sits above
`PREVIOUS_DAY_OFFSET: 1`, a day offset consumed as `Date.UTC(year, month, day - 1)`. Leftover
text from a shape that was not shipped. **Fix:** "How many UTC days back the window starts."

### LOW-2 · `.github/workflows/ci.yml:30` — `WORKER_DATABASE_URL` is declared and read by no step

`grep -n "WORKER_DATABASE_URL" .github/workflows/ci.yml` returns exactly the one declaration.
`AUTH_DATABASE_URL` is consumed at `:108`; nothing consumes worker's, and the comment at `:38-39`
says "The vars above apply to the steps that bypass turbo: the Prisma steps and the auth coverage
step" — which is true of the other three and not of this one. The role *is* exercised in CI, but
through `tests/setup.ts`, not through this variable. This is the S-6 shape (dead config).
**Fix:** delete it, or add the sentence that it is declarative parity with the other roles and is
deliberately unconsumed.

### LOW-3 · `apps/billing-service/tests/env.schema.unit.test.ts:205-212` — a completeness guard was traded away

The previous file-scoped `extractSoleMatch` over `BILLING_SERVICE_URL` threw the moment a second
copy appeared in `docker-compose.yml` — which is exactly how T-042 discovered it. The replacement
iterates a hand-maintained `COMPOSE_BILLING_CONSUMER_SERVICE_KEYS` of two, so a **third** consumer
added to compose with a wrong port now passes silently. The per-block assertion is strictly better
for the two it names; the exhaustiveness is what was lost.
**Fix:** add
`expect(compose.match(/^ +BILLING_SERVICE_URL:/gm) ?? []).toHaveLength(COMPOSE_BILLING_CONSUMER_SERVICE_KEYS.length)`.

### LOW-4 · `z.string().url()` — the call to match gateway is right, the residual should be recorded

Re-measured against zod 3.25.76, the version the workspace resolves:

```
"billing-service:3004"     OK        "http://localhost:3004"    OK
"javascript:alert(1)"      OK        "https://billing.internal" OK
"not a url" "/v1/internal" ""        REJECTED
```

The `.env.example` and `env.ts` comments state this accurately, and the reasoning for not
diverging from `apps/gateway/src/config/env.ts:17` is the same S-23/S-39 reasoning this repo has
applied twice. I endorse the call. The residual worth writing down is that the field's stated
purpose is to fail at module load rather than at 02:00, and an accepted-but-unusable scheme defers
the failure to exactly 02:00.
**Fix:** none in this change. Recommend a `known-gaps.md` entry (or a line folded into S-39) so the
shared-fragment task inherits it rather than rediscovering it.

### LOW-5 · `.claude/rules/known-gaps.md:851` and `:854` — stale citations in a sentence this diff rewrote

`apps/worker-service/vitest.config.mjs:18` and `(:25-30)`; actual `"src/events/**"` is at `:79` and
the thresholds at `:95-100`. Pre-existing at `5cb454a` — but the diff rewrote that sentence
("lists" → "listed", plus the `src/jobs/**` parenthetical) and could have fixed the numbers in the
same keystroke. Not counted against the change; flagged so it is not carried a fourth time.

### LOW-6 · No index serves the enumeration predicate, and it is recorded only in the release note

`UsageLine`'s two non-unique indexes are `(tenantId, periodStart, periodEnd)` and
`(tenantId, billed)`; the resolver's predicate is `billed = false AND periodStart >= $1 AND
periodStart < $2` with no `tenantId`, so neither has a usable leading column. The plan (R2) and
`docs/releases/…:200-204` both record it honestly as a leading-column observation, not a plan
measurement — the table is empty, so `EXPLAIN` proves nothing. Correct call for this task.
**Fix:** none here. Recommend a `known-gaps.md` entry, because `CLAUDE.md` is explicit that
`docs/plans/` is not a record and a release note is not read again after the deploy.

### LOW-7 · `billing-enumeration.repository.ts:99` — unvalidated brand cast

`rows.map((row) => row.tenantId as TenantId)` asserts the brand on a `$queryRaw` result with no
UUID check, and `.claude/rules/tenant-isolation.md` forbids accepting a tenant id that is not a
UUID. The downstream guard exists — billing's `generateInvoiceRequestSchema` uses `tenantIdSchema`
(`uuidSchema.transform(...)`), so a malformed id returns `400` and is counted as `failed` — so the
exposure is a log line, not a wrong write. Recording it because the cast is the one place the
brand's meaning is asserted rather than earned.

### LOW-8 · `invoice-generation.queue.ts:126` — bare `"failed"` event name

Every other operational string in this file comes from `WORKER_INVOICE_JOB`. The BullMQ event name
is a literal. Same class as the `'USAGE'` at `rls.integration.test.ts:555-556`, which matches the
pre-existing local convention at `:267` and is a NIT rather than a finding.

### NIT-1 · `apps/worker-service/package.json:15` — `bullmq` inserted between `@prisma/client` and the `@telemetry/*` block, breaking the file's ordering.

---

## What I verified, by execution

**Privilege boundary — re-derived from the live catalog, not from the migration text.**

- `pg_proc`: `worker_resolve_tenants_with_unbilled_usage`, owner `telemetry_worker_definer`,
  `prosecdef = t`, args `p_period_start text, p_period_end text`, result `SETOF text`,
  `provolatile = s`, `proisstrict = t`, `proconfig = {search_path=pg_catalog, pg_temp}`,
  `proacl = {telemetry_worker_definer=X/telemetry_worker_definer,telemetry_worker_app=X/telemetry_worker_definer}`
  — **no PUBLIC entry, no `telemetry_app`, no `telemetry_auth_app`**. Exactly the claim.
- `pg_roles`: both new roles `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`;
  the definer `NOLOGIN`, the app role `LOGIN`.
- **Non-membership in both directions, all pairs**: a 5×5 `pg_has_role(..., 'USAGE'/'MEMBER')`
  matrix over every `telemetry*` role returns `f` everywhere, and `pg_auth_members` holds no row
  for any of them. No role can `SET ROLE` to the definer.
- **Table grants**: `aclexplode` over `pg_class` for `telemetry_worker_app` returns exactly
  `Event {SELECT,INSERT,UPDATE}` and `UsageLine {SELECT,INSERT,UPDATE}` — no `DELETE`, no
  `Tenant`, no `_prisma_migrations`, nothing else. Definer holds `r` on `UsageLine` alone.
- **No blanket default grant for the new role**: `pg_default_acl` holds three rows —
  `postgres|0|f|{postgres=X/postgres}` (the v1_5 database-scoped function revoke) and the two
  pre-existing v1_4 schema-scoped grants to `telemetry_app`. Nothing for `telemetry_worker_app`.
- **What it can reach that nobody granted**: no sequences exist in `public` (no `relkind='S'`);
  the only other schemas are `pg_catalog`/`information_schema`/`pg_toast`; `public`'s ACL gives
  PUBLIC `U` but not `C`, so the role cannot create objects; the database ACL's `=Tc` gives PUBLIC
  `TEMP`+`CONNECT`, which is the PostgreSQL default and applies equally to every existing role.
  The one non-obvious reach is MEDIUM-1.
- **Live probe as the role**: `SELECT count(*) FROM "Tenant"` → `permission denied for table
  Tenant`; `"Invoice"` → same; `auth_resolve_tenant_by_email` → `permission denied for function`;
  `SELECT count(*) FROM "UsageLine"` with no context → `0`.
- **The policy**: `usageline_worker_definer_read`, PERMISSIVE, `FOR SELECT`, `roles =
  {telemetry_worker_definer}`, `qual = true`, `with_check` null. **It is the same shape as
  `v1_5`'s `user_auth_definer_read` — `USING (true)` — and what bounds it is the role scoping plus
  the non-membership above, not the predicate.** Say that plainly: a member of the definer reads
  every tenant's `"UsageLine"` with no tenant context and without calling the resolver, which is
  why `R8` and migration section 7 assert membership directly.
- **Making it return more**: the function is not owned by `telemetry_worker_app`, which holds no
  `CREATE` on `public`, so it cannot `CREATE OR REPLACE` it; the body is schema-qualified with a
  pinned `search_path = pg_catalog, pg_temp`, so a caller-controlled `search_path` cannot capture
  `"UsageLine"` or the `timestamp` type name; both parameters arrive as bound values, never as SQL
  text (rendered below). `SETOF text` of `DISTINCT ul."tenantId"` leaves nothing else to read.
  `STRICT` short-circuits a NULL bound before touching the table.
- **S-11 — the judgement call is correct, and I tested the thing that would refute it.** Created a
  throwaway `SECURITY DEFINER` function as the migration role (`postgres`, the same role that ran
  `v1_5`) and read its ACL: `proacl = postgres=X/postgres`,
  `has_function_privilege('public', …) = f`. So v1_5's database-scoped
  `ALTER DEFAULT PRIVILEGES` **does** cover a function created by this migration's role, and not
  repeating it was right. And if a deployment's migration role ever differs, v1_7's explicit
  `REVOKE … FROM PUBLIC / telemetry_app / telemetry_auth_app` plus section 7's catalog loop catch
  it at apply time — so the decision fails safe either way. Function dropped; `public` is back to
  three `prosecdef` functions.

**Timestamps (Priority 2, item 1).** Confirmed, and the suite states it correctly.

- The mechanism, isolated: `CREATE FUNCTION zz(a timestamp(3), b timestamp(3))` then
  `SELECT zz(now(), now())` → `ERROR: function …(timestamp with time zone, timestamp with time
  zone) does not exist` (rolled back). PostgreSQL does not implicitly cast `timestamptz` →
  `timestamp` during **function overload resolution**, which is why the plan's prediction (taken
  from `PREPARE p(timestamptz) AS SELECT $1::timestamp(3)`, where the cast is written and so
  happens) did not transfer. The implementer's correction is right.
- The reverse is also loud: `PREPARE q(text,text) AS SELECT zz($1,$2)` →
  `function …(text, text) does not exist`. So M1's loudness holds by mechanism.
- M3 against the **real** signature through Prisma 6.19.3: `code: P2010`,
  `meta.code: "42883"`,
  `function public.worker_resolve_tenants_with_unbilled_usage(timestamp with time zone, timestamp
  with time zone) does not exist` — verbatim what
  `billing-enumeration.repository.ts:59-63` claims.
- **Rendered SQL and bound values** for the shipped call:
  `SELECT t AS "tenantId" FROM public.worker_resolve_tenants_with_unbilled_usage(?, ?) AS t`
  with `values = ["2026-03-10T00:00:00.000Z","2026-03-11T00:00:00.000Z"]`. `Prisma.raw` is applied
  to the frozen constant only. No injection surface.

**I-TZ1 (Priority 2, item 2).** Re-performed, as MEDIUM-6 records: red under M4 on this host
(4 of 14) and — the case that matters — red **alone** under M4 on a simulated UTC server
(1 of 14). Not decoration. Not the S-21 shape.

**auth-service.** The exact-set assertion is not weakened: I created a fourth `prosecdef` function
in `public` and re-ran the suite —
`AssertionError: expected [ …(4) ] to deeply equal [ …(3) ]`, `Tests 1 failed | 21 passed (22)` —
then dropped it and re-verified the catalog holds three. The retitle is the honest fix: the old
title contained the universal "is the only SECURITY DEFINER function in the schema", which `v1_7`
falsifies. The two added cases are both worth having: the worker-role `EXECUTE` negative closes a
hole the existing loop cannot see (it checks PUBLIC and `telemetry_app` only), and it locates its
rows with a `toEqual` before the `for`, so an empty result set fails loudly.

**BullMQ.** `bullmq@6.3.6` is what worker-service resolves
(`node_modules/.pnpm/bullmq@6.3.6_ioredis@5.11.1`, lockfile `bullmq@6.3.6(ioredis@5.11.1)`); an
unrelated `bullmq@5.81.5` is in the store and in no lockfile entry. All four claims reproduced
against the installed package, on db 14, which returned to `DBSIZE 0`:

| Probe | Result |
|---|---|
| `new Worker(name, fn, {connection: <client with maxRetriesPerRequest: 2>})` | throws `BullMQ: Your redis options maxRetriesPerRequest must be null.` |
| `new Queue(name, {connection: <same client>})` | **no throw** — the narrowed claim is correct |
| `new Queue(name, {connection: <client with ioredis keyPrefix>})` | throws `BullMQ: ioredis does not support ioredis prefixes, use the prefix option instead.` |
| `RepeatOptions.tz` in the published `.d.ts`; `queue-keys.js` default `prefix = 'bull'` | both present |

And the `tz` consequence, measured on the real `cron-parser@5.10.1` that bullmq 6.3.6 pins, with
the process zone `Asia/Calcutta` (offset −330):
`"0 2 * * *"` without `tz` → `2026-03-10T20:30:00.000Z`; with `tz: "UTC"` → `2026-03-10T02:00:00.000Z`.
The constant is set and `Q1` asserts it.

**S-35's obligation and T-043's drain.** `await invoiceQueue?.close()` is at
`src/index.ts:94`, `await streamConsumer?.stop()` at `:145`. I performed the mutation `U87`'s
comment names — moving the close below the stop — and got `Tests 1 failed | 16 passed (17)`, U87
alone, exactly as claimed; `index.ts` restored and md5-verified identical.

Accepting it **unbounded** is the right call on the reasoning given, and I checked the part that
reasoning rests on: because it precedes `stop()`, `DRAIN_TIMEOUT_MS` is untouched, and the wait is
bounded in practice by `AbortSignal.timeout(10_000)` per tenant rather than being open-ended.
Racing it would return while a job holds a BullMQ lock, and BullMQ would redeliver — trading a
bounded wait for duplicate work against an endpoint whose idempotency is *another service's* code.
Correct trade, correctly stated.

I also ran the real thing rather than only the unit suite — a real `node --import tsx src/index.ts`
against `telemetry_worker_app` and Redis db 14, then a real `SIGTERM`:

```
Created stream consumer group
Invoice generation scheduler registered      <- before the listener
Server listening at http://127.0.0.1:3993
Shutting down gracefully
Stream read interrupted by shutdown          <- S-26's two teardown lines, both emitted
Stream consumer loop stopped
Skipped stream consumer deregistration: this consumer is not registered
Shutdown complete
exit code: 0
```

So T-043's drain still behaves with the queue close inserted ahead of it (S-26 unaffected), and
`U88`'s ordering property holds in a real process. db 14 flushed afterwards under a
`CLIENT INFO` → `db=14` check; `DBSIZE 0`.

**Compose and CI.** `docker/postgres/init/01-app-role.sql:112-136` creates
`telemetry_worker_app` with the same name and password compose (`:157`) and CI (`:30`) use —
checked by string, all three agree. The header's reason for not mirroring the table grants (no
tables exist when an init script runs) is the same reason already recorded for `telemetry_auth_app`
and is right. **Not verified: I did not start the compose stack** — the init script only runs on a
fresh volume and `pnpm test:smoke:compose` was out of scope; see below.

**Migration applied state.** `_prisma_migrations` records `v1_7_worker_billing_enumerator`,
`applied_steps_count = 1`, `rolled_back_at` null; `prisma migrate status` → "Database schema is up
to date!" over 8 migrations. Section 7's catalog guard and section 8's functional guard both read
correctly to me — section 8 in particular is the right shape, because a definer that cannot see
past the policies returns an empty set with no error, and the negative half (a window containing
none of the probe rows) is what stops the positive half being satisfied by a resolver that ignores
`billed` or the window.

**`known-gaps.md` — the five moves.**

- **S-25 `jobs` half**: `"src/jobs/**"` is gone from `vitest.config.mjs`, `src/queues/**` was never
  added, `src/jobs` measures 100% and `src/queues` `98.59 / 93.33`. Closed correctly. Numbers
  wrong — HIGH-1.
- **S-19 extended**: the new paragraph is accurate on the substance — the repository does issue a
  `$queryRaw` outside `withTenant` and outside any transaction, it adds no `TenantScopedRepository`
  subclass, and the `text`-parameter design is what keeps it session-independent. Under-counted —
  MEDIUM-7.
- **S-20 extended**: the orphan-`Tenant` mechanism ("a `Tenant` with no `User` is uncollectable by
  `resetAuthState` under *any* e-mail filter") is a structural claim I confirmed by reading
  `resetAuthState`, and the entry **is** labelled a hypothesis in the terms asked for — "The
  condition is not established, and is stated as not established… a *hypothesis*, not a finding.
  Do not write it up as the mechanism." That is the right register. It also did not reproduce for
  me: a full `pnpm test --force` across 13 packages left `Tenant` at exactly 2, both with users,
  neither named `First Tenant`. `grep -rn "First Tenant" apps packages prisma --include=*.ts`
  returns one line, `auth.integration.test.ts:623`, as claimed.
- **S-24 third sighting**: no id collision. HEAD held 34 `## S-` headings ending at S-41; disk
  holds 35 ending at S-42. `diff` of the S-40→S-41 span between HEAD and the working tree is empty
  — both survived intact, and the only change past `:1864` is the S-42 append.
- **S-42 filed**: content is right, citations are not — HIGH-2.

**Release note.** Step ordering is migrate → verify → flip, and the flip cannot precede the grant
because the role does not exist until step 1 (I confirmed the role is created by the migration, not
by anything the service does). Step 2's verification query returns three rows on this database and
the worker row's `proacl` is the literal string the note tells the operator to expect — checked
character for character. Rollback lever 3 verified: as `telemetry_app` the call fails
`ERROR: permission denied for function worker_resolve_tenants_with_unbilled_usage`, loudly, on the
path that rejects rather than reporting false success. Lever 4's "additive" claim matches the
catalog. Lever 1 is MEDIUM-3.

**Compile-time gate — re-run with `--force`, all 13 packages.**

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | **13 successful, 13 total · 0 cached** |
| lint | `pnpm lint --force` | **13 successful, 13 total · 0 cached** · 0 errors, **14 warnings** |
| build | `npx turbo run build --force` | **13 successful, 13 total · 0 cached** |
| test | `pnpm test --force` | **13 successful, 13 total · 0 cached** |
| smoke | `pnpm test:smoke` | 6 services, 1 test each, all pass |

**Root test total, derived rather than accepted: 895.** Twelve packages report a total; the
thirteenth, `@telemetry/web`, runs `vitest run --passWithNoTests` and contributes 0 and no summary
line, which is why a naive read of the log finds twelve.

```
shared-validation 15 · shared-types 8 · shared-config 4 · shared-tracing 2 · shared-logger 4
shared-utils 18 · gateway 38 · analytics-service 18 · usage-service 230 · billing-service 162
auth-service 166 · worker-service 230 · web 0            = 895 across 85 files, 0 failures
```

That matches the per-package figures handed over. Worker 180 → 230 confirmed
(`it(`/`test(` count at HEAD = 180, on disk = 230, and vitest reports 230); auth 166 on this run,
consistent with the +2 in the diff.

**Lint warnings are pre-existing, proven.** 10 × `no-misused-promises` in
`apps/auth-service/tests/auth.service.unit.test.ts` (`git log -1` → `d68e719`, 2026-08-25) and
4 × `no-unsafe-assignment` in `apps/usage-service/tests/ingestion.service.unit.test.ts`
(`git log -1` → `b0f6921`, 2026-08-31). Neither file appears in `git diff --name-only` and neither
is untracked. **Zero `no-unsafe-return`.** Nothing new introduced.

**Environment left as found.** `Tenant` 2, `User` 2, and `RefreshToken`, `Event`, `UsageLine`,
`Invoice`, `InvoiceLineItem`, `Meter`, `MetricRollup` all **0** — re-counted after every probe and
again at the end. No orphan `Tenant` appeared at any point. Both new roles still present; `v1_7`
not rolled back; the resolver's definition + ACL + owner hash back to
`b1698fe219141deba6c4f5ca9b996376` after the M4 mutation. Redis db 14 and db 15 at `DBSIZE 0`;
db 0 holds `telemetry:events` and **one TTL'd `denylist:*` key** written by auth-service during the
mandated gate — that is S-22, unavoidable, and reported rather than rounded to green. Every seed
went through `DIRECT_DATABASE_URL`. `git status --porcelain` is the same 36 entries as at the
start, and every temporary probe file was removed (`find . -name "t042-*"` outside `node_modules`
→ nothing).

---

## What I could **not** verify, and why

- **The compose stack.** `docker/postgres/init/01-app-role.sql` only executes against an empty
  data directory, and starting/rebuilding the stack was outside what I was asked to disturb. The
  new role block is verified by reading and by string-matching the three places the credential
  appears; it is **not** verified by running. The smoke suites hit `/health` only, which touches no
  database, so CI would not catch a mistake here either — the note in the SQL header says exactly
  that and is correct.
- **A real nightly run.** Nothing fired `runInvoiceGenerationJob` end to end against a live
  billing-service; there is no such integration case and I did not start one. The job body is
  covered by `J1`–`J11` against doubles and the enumeration half by `R11`/`R12` against a real
  connection, so the untested seam is the BullMQ processor → job → HTTP path as one piece.
- **`bullWorker.close()` under a real in-flight job.** My live `SIGTERM` ran with the queue idle
  (the next fire is 02:00 UTC), so the unbounded-wait analysis in MEDIUM-adjacent prose is
  reasoning plus the per-request timeout, not a measurement of a shutdown that actually waited.
  This is the same shape as S-36 for the drain, and it would cost the same ~seconds of wall clock
  to write.
- **Index cost at scale.** `UsageLine` is empty; `EXPLAIN` proves nothing. LOW-6 is a
  leading-column observation only, exactly as the release note says.
- **The S-20 orphan-`Tenant` condition.** It did not reproduce for me either. I can confirm the
  *mechanism* (a tenant with no user is uncollectable by that reset) by reading the code; I cannot
  confirm the *trigger*, and neither could the implementer, which is why the entry is written as a
  hypothesis.
- **S-24's third sighting.** An in-session observation about what a different agent was shown. Not
  reproducible from here by construction. I can only confirm the *consequence* it was filed to
  avoid: no id collision, S-40 and S-41 byte-identical.
- **The M1 mutation's recorded totals.** I established M1's loudness by mechanism (a `text` bound
  does not resolve against `timestamp(3)` parameters, `42883`) rather than by re-applying M1 to the
  live function and re-running all 14 cases. MEDIUM-6's fix should re-run it.

---

## Required for APPROVED (all documentation or test, none change behaviour)

1. **HIGH-1** — correct the S-25 coverage figures to `98.13 / 92.91 / 94.73 / 98.13`.
2. **HIGH-2** — re-derive S-42's five stale epic citations.
3. **MEDIUM-1** — weaken "the only cross-tenant read it has" to what `I-E1` measures, and state the
   enumerate-then-name widening once.
4. **MEDIUM-3** — fix rollback lever 1, and name the production logical database.
5. **MEDIUM-4** — assert `defaultJobOptions` and exercise the `"failed"` handler.
6. **MEDIUM-5, MEDIUM-6, MEDIUM-8** — correct the three grep/mutation output claims.
7. **MEDIUM-7** — update S-19's count, and decide `base.repository.ts:98`.

**MEDIUM-2** (TLS) is the one finding with a behavioural choice in it, and it is the decision
below.

---

## Decision for the user

**Should `buildQueueConnection` handle `rediss://`, or should worker-service declare that it does
not support TLS Redis?**

Today the container's ioredis client honours `rediss://` and the BullMQ connection silently does
not, so one process would use TLS for the stream and plaintext for the queue against the same
server — including the password.

| Option | What changes in the diff |
|---|---|
| **A · Map the scheme (recommended)** | Three lines in `invoice-generation.queue.ts:52-58` adding `...(parsed.protocol === "rediss:" ? { tls: {} } : {})`, plus one `Q4` assertion. Smallest change that removes the divergence. |
| **B · Stop hand-parsing** | Pass the `REDIS_URL` string to BullMQ's connection and let ioredis parse it, keeping `db` behaviour. Larger change; `Q4` would have to be rewritten, and D3's "options, not an instance" constraint has to be re-checked against it. |
| **C · Declare it unsupported** | No code change. Add `.startsWith("redis://")` to the env schema so `rediss://` is rejected at module load, plus a docblock sentence. Fails loudly instead of quietly, at the cost of ruling out managed Redis. |
| **D · Record and defer** | No code change. A `known-gaps.md` entry, on the grounds that no deployment uses TLS Redis today. |

**Recommendation: A.** It is three lines, it removes a silent difference between two connections in
one process, and unlike C it does not foreclose managed Redis. D is defensible only if someone can
say the production Redis is plaintext — and if that is said, it should be said in
`known-gaps.md`, not assumed.

**A, B and C change the diff. D does not.**

---

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| `usageline_worker_definer_read` is `USING (true)`; anything that becomes a member of the definer reads every tenant's `UsageLine` | **Accepted, bounded by mechanism.** Non-membership verified live in both directions for all four application roles; asserted by `R8`, by migration section 7, and now by auth-service's suite. Same shape and same bound as `v1_5`. |
| A compromised worker can enumerate tenant ids and then read/write any of them | **Accepted, must be stated** — MEDIUM-1. Unchanged capability from `telemetry_app`; what the resolver adds is that the ids no longer have to be known. |
| No index serves the enumeration | **Accepted for this task**, LOW-6; recommend a `known-gaps.md` entry so it is not carried only by a release note. |
| `S-38` (billing's `P2002` re-read has no live test) is hit more often now — nightly job plus retries | **Accepted and correctly disclaimed** in `billing-client.service.ts:43-52`; this task does not close it and does not claim to. |
| A missed night is never recovered | **Accepted**, documented in the release note's operational notes and in the plan as R3. |
| `S-8` — billing's guard is still `!==` in a `preHandler`, and worker is now a caller | **Out of scope**, correctly left alone; worker's own caller-side schema is already `.trim().min(...)`. |
| Coverage thresholds are not enforced by `pnpm test` (it is `vitest run`, no `--coverage`) | **Pre-existing**, S-25's territory; the `src/jobs/**` lift is still worth having, but nothing in CI reads it. Worth one line in the S-25 fix. |

**CHANGES REQUESTED is not the verdict; CONDITIONAL is.** Nothing here needs a rewrite — the
migration, the resolver, the repository, the job and the queue are all sound, and the two Priority-2
self-reported contradictions both check out. The conditions are corrections to claims, one broken
rollback command, one untested option set, and one decision.

---

## Round 2 — Gate 6, final (post-QA)

**Verdict: CONDITIONAL.** No blocker, no HIGH. Four findings, all of them citation accuracy in
records; none changes behaviour and none is in production code.

Reviewed tree: working tree on `main`, base `5cb454a`, T-042 uncommitted. `git status --porcelain`
→ **38** entries (24 `M`, 14 `??`) at start and at end, `diff`-identical between the two captures.
Nothing committed, staged or branched. (QA's Round-5 note says 37; I measured 38 both times and am
recording what I measured rather than reconciling it — the only file added since is this review, and
it was already untracked when I took the opening capture.)

Per S-24's working practice, the `.claude/rules/` revisions cited below are the ones on disk, read
with `cat`/`sed`. **S-24 fired again for this session**: the injected `known-gaps.md` ended at
**S-39**; the file on disk runs to **S-45** (`grep -n "^## S-" .claude/rules/known-gaps.md`, 38
entries). Third sighting, first one on a *final* review gate. Recommend adding it to S-24's list.

---

## Findings

### MEDIUM-1 · `.claude/rules/known-gaps.md:890` and `:893` — S-25's two line citations are wrong on the tree that ships, inside the paragraph that says they were re-derived

S-25's T-042 block states:

- `:890` — "`apps/worker-service/vitest.config.mjs:79` lists `"src/events/**"` in `coverage.exclude`"
- `:893` — "The thresholds it guards are at `:95-100`"
- `:896-899` — "(Both citations read `:18` and `:25-30` until the Gate-3 rework. … Re-derived with
  `grep -n '"src/events/\*\*"' apps/worker-service/vitest.config.mjs` and
  `grep -n "thresholds" apps/worker-service/vitest.config.mjs`.)"

Re-run now, on the shipped tree:

```
$ grep -n '"src/events/\*\*"' apps/worker-service/vitest.config.mjs
129:        "src/events/**",
$ grep -n 'thresholds' apps/worker-service/vitest.config.mjs
138:        // what these thresholds mean for the whole service and needs the file measured first,
145:      thresholds: {
```

Actual: `:129` and `:145-150`. **The delta is exactly 50 lines in both cases**, which is the size
of the `test.env.TZ` docblock the Gate-5 rework inserted at `:7-56`. So the numbers were correct
when the Gate-3 rework re-derived them and were falsified by the *same task's* later change — the
S-33 shape, fourth instance in T-042, occurring inside the parenthetical whose subject is that
exact failure.

Graded MEDIUM rather than HIGH because the substance is right — the excluded globs, the removal of
`src/jobs/**`, and the threshold values all check out against the file — and the consequence is a
reader jumping to the wrong line. But `.claude/rules/` is designated authoritative and this text
asserts its own re-derivation, so it does not get a pass.

**Fix (`.claude/rules/known-gaps.md:890`, `:893`):** `:79` → `:129`; `:95-100` → `:145-150`. And
adopt S-42's own durable remedy in the same edit — append to the parenthetical at `:899`:
"Re-run both greps rather than trusting these numbers; they have now been wrong three times, twice
inside the commit that wrote them."

**Not counted against this change, proved:** the identical `vitest.config.mjs:79` citation at
`.claude/rules/known-gaps.md:1324` (S-32, T-041's entry) is **pre-existing** —
`git show 5cb454a:.claude/rules/known-gaps.md | grep -n 'vitest.config.mjs:79'` returns `1157`, and
S-32 is not among the entries this diff touched (structural diff of both revisions: `S-19`, `S-20`,
`S-24`, `S-25`, `S-26`, `S-40`, `S-41` changed; `S-42`–`S-45` added; none removed). Worth fixing in
the same pass, but it is not this task's.

### LOW-1 · `.claude/rules/known-gaps.md:868` — S-25 says "233 cases"; the shipped tree has 234

Same paragraph. The coverage figures themselves are **exactly right** — re-measured with
`pnpm --filter @telemetry/worker-service exec vitest run --coverage` on the shipped tree:

```
Test Files  17 passed (17)
     Tests  234 passed (234)
All files          |   98.26 |    93.07 |   94.73 |   98.26
 src/jobs          |     100 |      100 |     100 |     100
 src/queues        |     100 |    94.44 |     100 |     100
```

All four aggregate percentages, `src/jobs` at 100% and `src/queues` at `100 / 94.44 / 100 / 100`
re-derive to the digit. Only the parenthesised case count is stale: it was taken before `J12`
landed. The plan's own F-1 entry says "233 + `J12`" = 234, so the two records disagree by one.

The entry's conclusion — "no threshold had to move" — is unaffected, and the entry already
documents two prior revisions of these figures being wrong. This is the third, in the count rather
than the percentages.

**Fix (`:868`):** "233 cases, 17 files" → "234 cases, 17 files".

### LOW-2 · `docs/plans/t-042-invoice-generation-job.md:948` — the rework checklist still carries the superseded coverage figures with no label

Reads "S-25's coverage figures re-measured (`98.13 / 92.91 / 94.73 / 98.13`, 230 cases)". S-25
itself explicitly labels that set as correctly-measured-then-immediately-stale; the plan does not,
so a reader comparing the two artifacts gets two different "final" numbers with nothing saying
which is which.

**Fix:** append "— superseded by `98.26 / 93.07 / 94.73 / 98.26` at 234 cases once `Q7`–`Q9` and
`J12` landed; see S-25."

### LOW-3 · `docs/plans/t-042-invoice-generation-job.md:245`, `:246`, `:251` — D5's three citations into `billing.service.ts` are each off

Measured with `awk 'NR>=36 && NR<=92'` on `apps/billing-service/src/services/billing.service.ts`:

| D5 cites | Actual |
|---|---|
| `:75-83` the early return | **`:75-82`** (`:83` is blank) |
| `:37-47` the ordering comment | **`:38-48`** (`:37` is ` *`; item 7 is at `:48`) |
| `:87-91` the `invoiceId: null` return | **`:90-92`** |

Low consequence, and the *authoritative* record is right — `known-gaps.md` S-45 carries `:75-82`
and `:38-48` correctly, and those are the ones another agent will read. Recorded because the
plan is committed alongside the change and D5 is the decision S-45 is built on.

### LOW-4 · `docs/plans/t-042-invoice-generation-job.md:693` — AC7's **shipped** column omits the three auth-service cases that shipped

AC7's planned column lists `R5`–`R9`, `A-1`, `A-2`; the shipped column lists `R5`–`R9`, `I-E1`.
The `A-*` cases did ship, in `apps/auth-service/tests/rls.integration.test.ts`: the exact-set
`prosecdef` assertion extended to three names (still `toEqual`, not weakened — verified by reading
the diff), plus two new cases, *"does not let worker-service's role execute either auth resolver"*
and *"does not let either auth role assume worker-service's definer role"*. Since the column's whole
purpose is to be an accurate record of what shipped, leaving them out understates the coverage.

**Fix:** shipped column for AC7 → ``R5``–``R9``, `I-E1`, plus the three `rls.integration.test.ts`
cases (named, since that file uses prose titles rather than ids).

### NIT-1 · `invoice-generation.queue.ts:77` — a non-numeric URL path yields `db: NaN`

Executed against the shipped export:

```
buildQueueConnection("redis://localhost:6379/foo") -> {"host":"localhost","port":6379,"db":null}   // NaN
buildQueueConnection("redis://localhost:6379")     -> {"host":"localhost","port":6379,"db":0}
buildQueueConnection("rediss://u:p@h:6380/3")      -> {"host":"h","port":6380,"db":3,"username":"u","password":"p","tls":{}}
```

`REDIS_URL` is `z.string().min(1)`, so `redis://host:6379/foo` is an accepted configuration. It
fails closed (the `SELECT NaN` is rejected, `registerSchedule()` rejects, `start()` exits non-zero),
so this is a NIT rather than a finding. **Fix if touched:**
`const parsedDb = Number.parseInt(database, URL_NUMBER_RADIX); db: Number.isNaN(parsedDb) ? DEFAULT_REDIS_DB : parsedDb`.

### NIT-2 · the hand-off's "production changes since Round 1" list is short by two

Stated for the record, not against the change — the plan discloses both. Beyond the `rediss://`
mapping and the `TZ` pin, the Gate-3 rework also changed two non-test files: `EVENT_FAILED`
promoted to a constant at `invoice-generation.queue.ts:151` (Round 1 LOW-8), and
`WORKER_DATABASE_URL` deleted from `.github/workflows/ci.yml` (LOW-2).

**I could not establish this by execution.** The Round-1 revision was never committed and no
snapshot of it exists, so there is nothing to `git diff` against; the above is read off the plan's
own rework checklist at `:943-977` and cross-checked against Round 1's finding list. Any claim
about "what changed since Round 1" on this tree is inference, and I am labelling it as such.

---

## Priority 1 — the privilege boundary, re-derived independently on the tested revision

Everything below is from the live catalog and live connections, not from the migration text.

**Roles (`pg_roles`).** Five `telemetry*` roles. `telemetry_worker_app`: `rolsuper=f`,
`rolbypassrls=f`, `rolcanlogin=t`. `telemetry_worker_definer`: `rolsuper=f`, `rolbypassrls=f`,
`rolcanlogin=f`.

**Function ACL.** Three `prosecdef` functions in `public`; the worker resolver's `proacl` is
exactly

```
{telemetry_worker_definer=X/telemetry_worker_definer,telemetry_worker_app=X/telemetry_worker_definer}
```

— no `PUBLIC` entry, no `telemetry_app`, no `telemetry_auth_app`. `has_function_privilege` matrix:
`telemetry_worker_app` → `t`; `telemetry_app`, `telemetry_auth_app`, `telemetry_auth_definer`,
`'public'` → all `f`.

**"The database grants this service's role nothing else"** — the repository docblock's item 1 is a
universal, so I tested the refutation rather than the claim. Enumerated *every* privilege
`telemetry_worker_app` holds, across four catalogs:

```
function (public schema, has_function_privilege) -> worker_resolve_tenants_with_unbilled_usage(text,text)   [one row]
schema  -> public USAGE
table   -> Event {INSERT,SELECT,UPDATE} · UsageLine {INSERT,SELECT,UPDATE}
column  -> (none)
database-> telemetry CONNECT
pg_default_acl for this role -> (none; the two rows present belong to telemetry_app, pre-existing)
information_schema.role_usage_grants -> 0
```

The universal holds exactly. No `DELETE`, no `"Tenant"`, no sequences, no blanket default.

**Negative probes as the role.** `SELECT count(*) FROM "Tenant"` → `permission denied for table
Tenant`. `DELETE FROM "UsageLine" WHERE false` → `permission denied for table UsageLine`.
`telemetry_app` calling the resolver → `permission denied for function
worker_resolve_tenants_with_unbilled_usage`.

**Membership.** 3×2 `pg_has_role` matrix over `{telemetry_app, telemetry_auth_app,
telemetry_worker_app}` × `{telemetry_worker_definer, telemetry_auth_definer}`, both `USAGE` and
`MEMBER` — `f` in all twelve cells.

**Policies.** `"UsageLine"` carries exactly two: `usage_line_tenant_isolation` (`ALL`, `{public}`,
`"tenantId" = current_setting('app.tenant_id', true)`) and `usageline_worker_definer_read`
(`SELECT`, `{telemetry_worker_definer}`, `USING (true)`, no `WITH CHECK`).
`relrowsecurity`/`relforcerowsecurity` both `t` on `"UsageLine"` and `"Event"`.

**The three-step capability probe, re-run against two tenants seeded through the owner connection
and deleted afterwards:**

```
1  worker_app, no tenant context: SELECT id,"tenantId" FROM "UsageLine"     -> 0 rows
2  worker_app: SELECT * FROM public.worker_resolve_tenants_with_unbilled_usage(...) -> BOTH ids
3  worker_app, BEGIN; set_config('app.tenant_id','<id from 2>',true):
     SELECT id FROM "UsageLine" -> that tenant's row
     SELECT id FROM "Event"     -> that tenant's row
     UPDATE "UsageLine" SET billed=true WHERE "tenantId"='<that id>' -> UPDATE 1 ; ROLLBACK
3b telemetry_app, identical statements, same id -> identical rows, identical UPDATE 1
```

**So step 3 is unchanged from `telemetry_app` and the widening is step 2 alone.** That is the
description under review, and it is correct.

**The migration's own `"Tenant"` claim, re-run as `telemetry_worker_app` inside rolled-back
transactions:** `INSERT INTO "Event"` referencing a real `"Tenant"` row succeeded; the same insert
naming a non-existent tenant id, *with `app.tenant_id` set to that same id*, failed with
`violates foreign key constraint "Event_tenantId_fkey"`. Referential integrity is enforced without
the calling role holding any privilege on the referenced table — as written.

**Ruling on the description, in all six places.** Each says the capability is unchanged and the
addition is that ids need not be known; none says anything stronger.

| Where | Verdict |
|---|---|
| `prisma/migrations/v1_7_.../migration.sql:32-42` ("STATE THE WIDENING PRECISELY…") | correct |
| `billing-enumeration.repository.ts:70-92` (§ *What this exception widens*) | correct; item 1 is explicitly scoped to "in a single statement with no tenant context set" |
| `billing-enumeration.integration.test.ts:492-512` (`I-E1`'s comment) | correct; states the qualifier and names the contrasting measurement |
| `docs/releases/t-042-worker-billing-enumerator.md:71-87` | correct |
| `apps/worker-service/.env.example` (`## Database`) | correct — describes the mechanism and the grant scope, does not assert a capability claim at all, and points at the release note |
| `.claude/rules/known-gaps.md` S-43 | correct; the three-step block and the `permission denied` contrast both re-derive |

`R5`–`R10`, `I-E1`, `I-E2` and the two new auth-service cases assert the same set on every
`pnpm test`, and `apps/auth-service/tests/rls.integration.test.ts`'s exact-set `toEqual` was
**extended, not weakened** — it still fails on a fourth definer function.

---

## Priority 2 — the rework's own claims

### The `TZ` pin — all four grounds re-derived

Node `v22.22.2`:

- **Non-UTC:** `TZ=Asia/Kathmandu` → `getTimezoneOffset()` `-345`.
- **DST-free:** offset computed for the 15th of all twelve months of 2026 → `Asia/Kathmandu`
  `{-345}`, a single value; `America/New_York` `{300, 240}`. As claimed.
- **Different from the ambient zone:** `process.env.TZ` unset,
  `Intl.DateTimeFormat().resolvedOptions().timeZone` → `Asia/Calcutta`, offset `-330`. So the pin
  is not a no-op here.
- **Different from both SQL-side session pins:** `tests/integration.constants.ts:488` is
  `America/New_York` (processor suite) and `:649` is `Asia/Kolkata` (enumeration suite).
- The caveat is right too: under the pin, `resolvedOptions().timeZone` reports the alias
  `Asia/Katmandu`, which is why `J12` asserts the offset.

### The `Date.UTC` → `new Date` mutation, under the pin

Replaced both `Date.UTC(...)` calls in `getPreviousDayRange` with the local-midnight form:

```
pnpm --filter @telemetry/worker-service exec vitest run tests/invoice-generation.job.unit.test.ts
  -> Tests  6 failed | 6 passed (12)      # J1-J6

TZ=UTC pnpm --filter @telemetry/worker-service exec vitest run tests/invoice-generation.job.unit.test.ts
  -> Tests  6 failed | 6 passed (12)      # identical
```

**The outer-`TZ=UTC` arm is the whole point and it holds**: `test.env.TZ` wins over the ambient
environment, so the guard is live on a UTC CI runner. Source restored, `md5sum` identical.

### `J12` guards the pin — both mutations re-performed

| Mutation to `vitest.config.mjs` | Result |
|---|---|
| `env: { TZ: … }` block deleted | `J12` fails: `Error: vitest.config.mjs declares no string test.env.TZ (got undefined)` — `Tests 1 failed \| 11 passed (12)`. The helper **throws**, as claimed; it does not compare `undefined` to `undefined`. |
| `TZ: "Not/AZone"` | `J12` fails: `AssertionError: expected +0 not to be +0 // Object.is equality` — `1 failed \| 11 passed (12)`. |

The second confirms the load-bearing part: **Node resolves an unknown zone to offset 0 without
throwing**, so assertions 1 and 2 alone would pass and assertion 3 is what catches it. Note the
other eleven cases stayed green under that mutation, which is consistent — with the zone resolving
to UTC, the *correct* implementation still produces correct output. Config restored, `md5sum`
identical.

### S-45 — reproduced independently, end to end

Real `@telemetry/billing-service` on a spare port as `telemetry_app`; one tenant, one
`api.request` meter at `0.010000`; two unbilled `UsageLine` rows (10 + 2) in
`[2026-09-15, 2026-09-16)`; seeded through `DIRECT_DATABASE_URL`, deleted afterwards.

```
run 1                 HTTP 201  {"data":{"invoiceId":"622aa1e1-…"}}
                      Invoice 1 row, totalAmount 0.120000 · InvoiceLineItem 1 · billed=t 2, billed=f 0
insert late row       periodStart 2026-09-15 23:59, quantity 2, billed=false
run 2 (same window)   HTTP 200  {"data":{"invoiceId":"622aa1e1-…"}}   <- same id
                      Invoice still 1 row, still 0.120000 · line items still 1 · late row billed=f
run 3 (next night)    worker_resolve_tenants_with_unbilled_usage('2026-09-16','2026-09-17') -> 0 tenants
billing log           "Invoice already exists for period" x1 · "Draft invoice generated" x1
```

Every figure in S-45's reproduction block re-derives. So does fix-direction 2's measured recovery
path: posting the narrower window `2026-09-15T23:00:00.000Z → 2026-09-16T00:00:00.000Z` returned
**201**, billed the row, and left two overlapping invoices — `0.120000` for
`[09-15 00:00, 09-16 00:00)` and `0.020000` for `[09-15 23:00, 09-16 00:00)`.

**Mechanism confirmed by reading the code at the cited lines**, and the citations are exact:
`apps/billing-service/src/services/billing.service.ts:75-82` is the `findByPeriod` early return;
`:84` is the first `sumUnbilledByMetricKey` call; the ordering comment is `:38-48` with item 2 at
`:41-43`. Reachability: `apps/worker-service/src/validators/stream-message.validator.ts:261` is
`periodStart: occurredAt` — exact.

**S-8's precedent is named as four entries, and all four check out.** A structural scan of
`known-gaps.md` shows S-22, S-23, S-39 and S-40 each citing S-8's one-task-per-commit objection in
their own words. Naming rather than counting is the right call and the naming is accurate.

**T-045's D1 quote** is verbatim and correctly attributed.

**Ruling on MEDIUM.** Correct. It is a silent revenue-loss path — run 2's `200 / created:false /
succeeded:1 / failed:0` is byte-indistinguishable from an ordinary re-run of a complete day — and
it is reachable by nothing more exotic than two hours of consumer lag. It is not higher because
nothing is destroyed (`billed=false` persists and the row is still priceable), no invoice is wrong
about what it contains, and it needs a second run against an already-invoiced window to occur.

**Ruling on the vacuous-test warning.** Right, and specifically right in both directions. The
response-side assertion is vacuous — I measured the same status, the same invoice id, the same
invoice count and the same summary on both sides of the defect, so a case asserting any of those
passes against it. The fixture-order warning is the sharper of the two: seeding the late row before
run 1 bills it in run 1 and never exercises the ordering. The prescribed shape — seed, run, insert,
run, assert the **row's** `billed` and the invoice's `totalAmount` — is the only one that
discriminates, and `billed=f` / `0.120000` are the two red values, as stated.

### S-26's correction — re-measured with real `SIGTERM`s

Real `node --import tsx src/index.ts` as `telemetry_worker_app` on Redis **db 14**, a hanging HTTP
stub for billing, a real job enqueued through the shipped queue, real `SIGTERM`:

| case | `Stream read interrupted by shutdown` | `Stream consumer loop stopped` | SIGTERM → exit | exit |
|---|---|---|---|---|
| idle, run 1 | **1** | 1 | **35 ms** | 0 |
| idle, run 2 | **1** | 1 | **43 ms** | 0 |
| in flight, 2 tenants | **0** | 1 | **19 072 ms** | 0 |
| in flight, 1 tenant | **0** | 1 | **9 081 ms** | 0 |

Against S-26's 36–39 ms / 19 106 / 19 079 / 9 116. The in-flight timeline reproduces the mechanism
rather than just the outcome:

```
10:08:39.925  Invoice generation job started
10:08:40.955  Shutting down gracefully              <- SIGTERM
10:08:43.630  Stream consumer loop stopped           (+2 675 ms: the parked read expired by itself)
10:08:49.987  Invoice generation failed for tenant   (+10.0 s)
10:08:59.989  Invoice generation failed for tenant   (+10.0 s)
10:08:59.989  Invoice generation job completed
10:08:59.998  Shutdown complete                      exit 0
```

So the correction is right, and right about the *mechanism* being a different one from the race the
rest of S-26 describes: the line is not losing to `process.exit`, it is never produced, because the
read expired on its own while `invoiceQueue.close()` waited. Nothing truncated, every per-tenant
outcome logged, exit 0 in all four runs.

**`U86` is still correctly scoped, not weakened.** Its assertions are unchanged (it still requires
both literals in `logMessagesAtExit`); what the rework added is a scope comment at
`tests/index.graceful-shutdown.unit.test.ts` naming the condition and the `grep -c → 0 vs 1`
measurement. That is the right treatment — the case is true about what `stop()` does, and the
caveat is about another `await` in front of it.

I also re-performed **`U87`**'s own stated mutation, which nothing had: moving
`await invoiceQueue?.close()` below `await streamConsumer?.stop()` in `src/index.ts` gives
`Tests 1 failed | 16 passed (17)` with `U87` the only failure. The ordering assertion is
load-bearing and the claim "leaves the rest of the file green" is exact. `index.ts` restored,
`md5sum` identical.

### The shutdown bound

Stated where the decision lives — `apps/worker-service/src/index.ts`, at the
`await invoiceQueue?.close()` call site, with the worst case `TIMEOUT_MS (10 000) × tenants still
to be called`. My two in-flight runs give 9 081 ms at one tenant and 19 072 ms at two, and the
per-tenant failure lines land 10.00 s apart — the formula, not a curve through two points, as the
comment says. The three-tenant Kubernetes figure is explicitly labelled "arithmetic from the
formula above, not a run anybody made at three" in `index.ts`, and the release note at `:261-272`
carries the same bound with the same numbers and the `terminationGracePeriodSeconds` instruction.
Correctly labelled in both places.

---

## Priority 3 — the three disclosed deviations, and the standing refusal

**1 · Requalifying the "cannot produce a `200 { invoiceId: null }`" universal**
(`billing-enumeration.repository.ts:122-131`) — **endorsed, and it was required rather than
optional.** `.claude/rules/review-standards.md` § *Universals Must Cite Their Mutation* makes a
universal a testable assertion; this one was literally true and invited a false reading
("enumerated ⇒ billed"), which is the precise failure mode that section lists. Leaving it standing
next to the QA finding that refutes the reading would have been worse than the brief's silence
about it. The replacement text names what the method *does* guarantee (the usage exists) and hands
the rest to S-45.

**2 · Adding S-45 and the shutdown bound to the release note** — **endorsed.** The release note is
the operator-facing artifact, and both items are things an operator must act on:
`terminationGracePeriodSeconds`, and "a `succeeded` count is not evidence the day was fully
billed". `CLAUDE.md` says `docs/plans/` is not a record, so the alternative was that neither
reached a reader. Both entries at `:261-285` are accurate against my measurements.

**3 · The plan's AC table gaining a **shipped** column** — **endorsed**, and the right resolution of
the dilemma. The planned `J`-numbering genuinely diverged (7 planned ids against 11 shipped at
Gate 4, 12 with `J12`; re-derived: the file holds `J1`–`J12`). Rewriting the planning-time list to
match would have made the plan a false record of what was planned, and leaving one column would have
made it a false record of what shipped. Keeping both and labelling which is which is correct. See
LOW-4 for the one row that is incomplete.

**4 · The standing refusal to point `base.repository.ts:98` at `WORKER_DATABASE.TENANT_CONTEXT_SETTING`**
— **endorsed, with the cost named.** Re-derived:

```
$ md5sum apps/*/src/repositories/base.repository.ts
13a533a2e2c2dcc1ff9db28fb5c7a1fd  analytics
8b12b7d596af50a038f5a79c1361b8a5  auth
13a533a2e2c2dcc1ff9db28fb5c7a1fd  billing
d2e8d92fd494fb779f4dea7238273b4a  usage
13a533a2e2c2dcc1ff9db28fb5c7a1fd  worker
```

Three still byte-identical. Editing one to reference a service-local constant creates a fifth
variant of the five-copy class S-19 exists to record, from inside a task told not to open S-19.
The cost is real and is disclosed rather than hidden: worker-service now holds a named constant and
a hard-coded literal for the same session setting **inside one package**, which is a stronger form
of duplication than the cross-package one S-19 was originally about — and S-19 says so in those
words. Accepted, disposition: recorded in S-19, to be closed by the `@telemetry/shared-db`
promotion.

The S-40 consequence of that refusal re-derives too: `app.tenant_id` as an executable string is
now in **seven** places (three named constants — `usage-service/src/constants.ts:75`,
`auth-service/src/constants.ts:69`, `worker-service/src/constants.ts:919` — and four literals in
`set_config`), which is what S-40's edited sentence claims and what S-19's corrected table says.

---

## Priority 4 — final-review scope

### Compile-time gate — all 13 packages, `--force`

| Task | Command | Result |
|---|---|---|
| typecheck | `npx turbo run typecheck --force` | **13 successful, 13 total · 0 cached** · 12.3 s |
| lint | `npx turbo run lint --force` | **13 successful, 13 total · 0 cached** · 0 errors, **14 warnings** |
| build | `npx turbo run build --force` | **13 successful, 13 total · 0 cached** · 20.1 s |
| test | `npx turbo run test --force` | **13 successful, 13 total · 0 cached** · 24.8 s |
| smoke | `pnpm test:smoke` | 6 services, 7 cases, all pass |

**Per-package test totals, derived rather than read off a headline.** Twelve packages report;
`@telemetry/web` runs `vitest run --passWithNoTests` and contributes 0 with no summary line.

| Package | Files | Tests |
|---|---|---|
| `@telemetry/worker-service` | 17 | **234** |
| `@telemetry/usage-service` | 19 | 230 |
| `@telemetry/auth-service` | 15 | **166** |
| `@telemetry/billing-service` | 17 | 162 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-types` | 1 | 8 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/web` | 0 | 0 |
| **Root** | 86 | **899** |

`2+8+4+15+4+18+18+38+230+166+162+234 = 899`. Matches the expected worker 234 / auth 166 / root 899.

**The 14 warnings are pre-existing, proved by file rather than asserted.** They land in exactly two
files, neither of which this change touches:

```
apps/auth-service/tests/auth.service.unit.test.ts       10 warnings  @typescript-eslint/no-misused-promises
  git log -1 -> d68e719  2026-08-25
apps/usage-service/tests/ingestion.service.unit.test.ts  4 warnings  @typescript-eslint/no-unsafe-assignment
  git log -1 -> b0f6921  2026-08-31
git diff --name-only | grep -E 'auth.service.unit.test.ts|ingestion.service.unit.test.ts' -> (empty)
```

10 @ `d68e719` + 4 @ `b0f6921` = 14, as expected. **Zero `no-unsafe-return`**, confirmed by
`grep` over the lint log. No new warning anywhere.

### Test coverage alignment

Every path the brief names has a case, and each asserts behaviour rather than a mock's own value:

- **Rollback levers** — lever 1 has no test and does not need one (it is an operator runbook), but I
  **ran** it; see below. Lever 3 is asserted by `R6/R7` and by my live `permission denied`.
- **Per-tenant failure path** — `J7` (three tenants, the second rejects, the first and third are
  still called, helper throws if a call is absent), `J8` (resolves with `failed: 1` on a tenant
  failure, *rejects* when the enumeration fails), `J9` (one line per tenant, response body never
  logged).
- **The 10 s abort** — `B6` asserts the signal is passed; `B5` asserts a transport failure or
  timeout surfaces as a rejection and never as a silent success.
- **The re-run path** — `B4` (`201` and `200` both succeed, anything else throws carrying the
  status); the `created:false` semantics are exercised end to end by my S-45 reproduction.
- **The `rediss://` mapping** — `Q7`, positive and negative.
- **Injection** — `E1` is the model of the shape the testing rule asks for: it asserts both that the
  bounds are in `values` **and** that neither appears in `statement.sql`, with a helper that throws
  when no statement was recorded.
- **Not-vacuous guards** — `Q9` throws if the `failed` listener was never registered; `J12`'s
  `readConfiguredTimeZone` throws in every direction; the enumeration suite's `beforeAll` throws if
  `current_user` is a superuser, holds `BYPASSRLS`, or is not `telemetry_worker_app` by name. That
  is the S-3 replacement shape, correctly applied to a new suite.
- **Fixture hygiene** — that suite's `sweepFixtures()` collects by a **stable** `Tenant.name` prefix
  and runs in `beforeAll` *and* `afterAll`, which is precisely the fix direction S-20's addendum
  prescribes, including the orphan-`Tenant`-with-no-`User` case. The full gate left `Tenant` at 2
  with no orphan; the T-042 fixtures are not the leak S-20 describes.

**Coverage.** `src/jobs/**` removed from `coverage.exclude` and `src/queues/**` never added:
`src/jobs` 100% across all four metrics, `src/queues` `100 / 94.44 / 100 / 100`, aggregate
`98.26 / 93.07 / 94.73 / 98.26` against `80 / 75 / 80 / 80`. No threshold moved, which was D4's own
boundary. **Nothing in CI reads this** — `"test": "vitest run"` with no `--coverage` — which is
pre-existing and S-25's territory, correctly noted there.

**Ruling on `Q7` and the `tls: {}` vs `tls: true` equivalence.** Good enough, and I strengthened the
basis rather than taking it on trust. The docblock cites
`ioredis@5.11.1/built/connectors/StandaloneConnector.js:33-34`
(`if (options.tls) { Object.assign(connectionOptions, options.tls); }`) — exact, I read it. What the
docblock does **not** cite is the line that actually decides the transport, in the same file's
`process.nextTick`: `if (options.tls) { this.stream = tls.connect(connectionOptions) } else {
this.stream = net.createConnection(connectionOptions) }`. That is the stronger evidence and it
settles the question: any truthy `tls` selects TLS, so `{}` and `true` are equivalent for selection
and `{}` is additionally the correct shape for the spread. `Q7` asserts what `buildQueueConnection`
decides; whether a handshake succeeds is ioredis' and is untestable here without a TLS Redis. The
scope comment in the test says exactly that. **Optional improvement, not a condition:** add the
`tls.connect` line to the docblock's citation, since it is the one a sceptic needs.

### Release readiness

**Acceptance criteria** against `docs/epics/epic-7-worker-service.md:206-283`: all satisfied.
Scheduled `0 2 * * *` with `tz: "UTC"` explicit (`Q1`); previous UTC calendar day as a half-open
interval (`J1`–`J5`, `J12`); every tenant with unbilled `UsageLine` in that window (`R1`–`R4`,
`I-TZ1`, `R11`); one `POST /v1/internal/billing/generate` per tenant with the internal secret
(`B1`–`B4`, `B8`); one tenant's failure does not block the others (`J7`, `J8`); each result logged
separately (`J9`). The epic's own six-way divergence block and the forward reference at `:210-215`
are accurate — I re-ran all seven of S-42's anchor commands and every one returns the stated line.

**The ordered deploy, run where it could be run.**

- *Step 2's verification query* returns three rows and the worker resolver's `proacl` is exactly the
  string the note tells an operator to expect. Verified.
- *Rollback lever 1* — **run, both forms, on db 14.** The redis-cli sequence gave `DEL → 2`,
  `ZREM → 1`, `DEL → 1`, after which `getJobSchedulers()` and `getDelayed()` were both `[]`. The
  code form gave `removeJobScheduler("daily-invoice-generation") → true`, both empty. And the note's
  central warning re-derives: after `DEL …:repeat` **alone**, `getJobSchedulers()` returns `[]`
  while `getDelayed()` still holds `repeat:daily-invoice-generation:1789610400000` — which is
  `2026-09-17T02:00:00.000Z`, exactly the run the lever exists to prevent. The lever that used to be
  documented does look like it worked and does not.
- *Lever 2* was exercised incidentally by my in-flight runs: with billing unreachable the job
  enumerated, failed every tenant, logged each failure, and wrote nothing — `Invoice` and
  `InvoiceLineItem` stayed at 0 throughout.
- *Lever 3* — `telemetry_app` calling the resolver raises `permission denied for function
  worker_resolve_tenants_with_unbilled_usage`, loudly and on the path that rejects. Verified.
- *Lever 5* deliberately **not** run, per the standing instruction not to drop either role.

**Breaking-change assessment across the other 12 packages.** The only cross-package edits are
`apps/auth-service/tests/rls.integration.test.ts` (+3 assertions, exact-set extended not weakened),
`apps/auth-service/src/constants.ts` (+ the worker role/function names), and
`apps/billing-service/tests/env.schema.unit.test.ts` (Round 1 LOW-3's restored exhaustiveness
assertion). No production behaviour in any other service changes. `docker/postgres/init/01-app-role.sql`
adds `telemetry_worker_app` with `CONNECT` + `USAGE` only and deliberately mirrors no table grants,
with the reasoning written down; `docker/docker-compose.yml` points worker at the new role and sets
`BILLING_SERVICE_URL`; `.github/workflows/ci.yml` adds `BILLING_SERVICE_URL` and removes the unread
`WORKER_DATABASE_URL`.

**The role flip is safe for every existing worker path**, checked rather than assumed:
`grep -rnoE 'prisma\.[a-zA-Z]+|tx\.[a-zA-Z]+|this\.db\.[a-zA-Z]+' apps/worker-service/src` returns
`event` ×3 and `usageLine` ×1 and nothing else, so no shipped query touches a table
`telemetry_worker_app` cannot reach, and none issues a `DELETE`.

### Whether this ships — yes

It adds a database role, a policy that reads past tenant isolation by design, a new runtime
dependency and a nightly job. Taken one at a time:

- **The role and the policy** are the narrowest form available. The alternative — `BYPASSRLS` on the
  definer — would have been a role *attribute* covering every table the role can ever reach;
  `usageline_worker_definer_read` is one table, `SELECT` only, one role, and unreachable from any
  application role because none is a member. I verified the whole boundary from the live catalog and
  could not find a path around it. The migration re-verifies the same invariants at apply time and
  aborts the transaction rather than leaving a half-built exception, and two packages' suites assert
  the exact `prosecdef` set on every `pnpm test`.
- **The new dependency** (`bullmq@6.3.6`) is confined to one file, constructed from options rather
  than from the shared client so closing the queue cannot disconnect the stream consumer's
  connection, and its retry/retention policy is configured explicitly rather than assumed.
- **The nightly job** fails closed in the direction that matters: it *rejects* when the enumeration
  fails (the case where it does not know whom it skipped) and *resolves with a count* when
  individual tenants fail. Its one silent failure mode is S-45, which is now recorded, measured and
  operator-visible in the release note.

**What an operator must do that the release note does not say.** Two things, both small:

1. **The job's retry policy is not stated anywhere operator-facing.** `attempts: 3` with
   `backoff: exponential, 60 000 ms` means a failed *enumeration* produces up to three
   `Invoice generation job failed` lines about an hour apart, and `removeOnComplete: 30` /
   `removeOnFail: 90` bound what `getFailed()` will show. Recommend one line under § *Operational
   notes*. (Not a condition.)
2. **The applied `v1_7` on the development database no longer matches its file's checksum**, because
   the file was comment-edited after being applied — a known and accepted state. I confirmed it is
   benign rather than assuming so: recorded checksum `cd41991e…`, file `sha256sum` `9defe7dd…`, and
   both `prisma migrate status` ("Database schema is up to date!") and `prisma migrate deploy`
   ("No pending migrations to apply.") accept it without complaint, with both roles still present
   afterwards. Nothing for an operator to do on a fresh target; worth a sentence for anyone
   reproducing locally.

### The `known-gaps.md` entries, held to the authoritative-file bar

**No id collision.** Structural diff of `5cb454a` against the working tree: 34 entries → 38;
`S-42`, `S-43`, `S-44`, `S-45` added; **none removed**; `S-19`, `S-20`, `S-24`, `S-25`, `S-26`,
`S-40`, `S-41` modified.

- **S-40 survived and its one edit is correct.** The change is "six and three" → "seven and three
  (S-19 was six until T-042 added a third named constant)". Re-derived: seven, as above.
- **S-41 survived intact** — the only change is a trailing `---` separator; the body is byte-identical.
- **S-19** — the new paragraph is accurate on every checkable claim: the enumeration `$queryRaw` runs
  outside `withTenant` (read both call sites), the bounds cross as `text` and are cast in the
  resolver body (read the function definition), `md5sum` identity holds for three of five copies,
  the count of seven re-derives, and `usage-service/src/constants.ts:75` corrects the old `:74`.
- **S-20's addendum** is careful in exactly the right place: it states the orphan-`Tenant` mechanism
  as established and the *cause* of the one sighting as a hypothesis that did not reproduce. My own
  full gate produced no orphan either, which is consistent with "not established" and is not
  evidence against it.
- **S-24** — the third sighting is recorded accurately, and it fired a fourth time for me.
- **S-25** — MEDIUM-1 and LOW-1 above.
- **S-26** — re-measured; see Priority 2.
- **S-42** — all seven anchor commands re-run, every one returns the stated line. Round 1's HIGH-2 is
  fully discharged and the anchor-text remedy is the right durable fix.
- **S-43** — re-derived; correct.
- **S-44** — both halves verified. `"UsageLine"`'s two non-unique indexes are
  `(tenantId, periodStart, periodEnd)` and `(tenantId, billed)`, neither with a usable leading column
  for `billed = false AND "periodStart" >= $1 AND "periodStart" < $2`; and `z.string().url()` on zod
  `3.25.76` accepts `"billing-service:3004"` and `"javascript:alert(1)"` while rejecting
  `"not a url"`, `"/v1/internal"` and `""` — exactly as claimed. The "not measured" disclaimer on the
  index half is correct and should stay.
- **S-45** — reproduced; MEDIUM is the right grade; the vacuous-test warning is right.

---

## What I verified, by execution

Live PostgreSQL 16 and Redis 7 host services, neither stopped.

- `pg_roles`, `pg_proc.proacl`, `has_function_privilege` matrix, `pg_policies`, `pg_class` RLS flags,
  `information_schema.role_table_grants`, `pg_default_acl`, `aclexplode` over `pg_class`/`pg_attribute`/
  `pg_namespace`/`pg_database`, and a 3×2 `pg_has_role` matrix.
- Live connections as `telemetry_worker_app` and `telemetry_app`: the three-step capability probe,
  the `"Tenant"` denial, the `DELETE` denial, the resolver denial, and the foreign-key probe in both
  directions inside rolled-back transactions.
- Four real `SIGTERM` runs of the shipped `src/index.ts` on db 14 — two idle, two with a job in
  flight against a hanging billing stub.
- A full end-to-end S-45 reproduction against the real billing-service, including the manual
  recovery path.
- Both rollback-lever-1 forms, plus the "`DEL :repeat` alone is not enough" measurement.
- Four source mutations, each reverted and each proved byte-identical afterwards by `md5sum`:
  local-midnight `getPreviousDayRange` (under the pin and under `TZ=UTC`), `TZ` pin deleted, `TZ` pin
  set to an unknown zone, and `invoiceQueue.close()` moved after `streamConsumer.stop()`.
- Node/ICU offset probes for `Asia/Kathmandu` and `America/New_York` over twelve months, the ambient
  zone, and the `Asia/Katmandu` alias.
- `zod@3.25.76`'s `.url()` against six values; `buildQueueConnection` against three URLs.
- `ioredis@5.11.1`'s `StandaloneConnector` — both the `Object.assign` and the `tls.connect` branch.
- The full gate with `--force`, plus `pnpm test:smoke` and a `--coverage` run of worker-service.
- `git log -1` / `git diff --name-only` for lint-warning provenance; `git show 5cb454a:` for the
  `known-gaps.md` structural diff and for the pre-existing S-32 citation.
- `prisma migrate status` and `prisma migrate deploy` for the checksum question.

**Environment left as found.** `Event` 0, `UsageLine` 0, `Invoice` 0, `InvoiceLineItem` 0, `Meter` 0,
`Tenant` **2** (`Acme Inc` ×2, the two baseline rows — **no orphan**), `User` 2 — re-counted after
every probe. Redis db 0 holds `telemetry:events` (`XLEN 2`) and nothing else; **nothing was written
to db 0**. Databases 13, 14 and 15 are empty. No stray service processes. `git status --porcelain`
identical to its opening capture.

**S-22 sighting, reported rather than rounded to green:** the mandated `pnpm test --force` run put a
TTL'd `denylist:*` key into db 0 (`DBSIZE` 3 → 2 as the two older ones expired, then 1). That is
S-22 behaving exactly as recorded, not a regression, and not this task's.

## What I could **not** verify, and why

- **That the production changes since Round 1 are only the two named.** The Round-1 revision was
  never committed and no snapshot exists, so there is nothing to diff. See NIT-2; the list is read
  off the plan, which is inference, not execution.
- **That a `rediss://` handshake succeeds.** No TLS Redis available. `Q7` and my own probe establish
  that the option is produced; the ioredis source establishes that a truthy `tls` selects
  `tls.connect`. Whether a server accepts it is untested.
- **The enumeration's query plan at scale.** `"UsageLine"` is empty on every environment this has
  run against, so `EXPLAIN` proves nothing. S-44 says so and that disclaimer is correct.
- **Whether the S-20 orphan `Tenant` reproduces.** It did not appear in my gate run either, which is
  consistent with S-20's own "not established".
- **Rollback lever 5.** Deliberately not run — it drops the roles, which the standing instruction
  forbids.
- **Lever 1 against a queue with a job in flight.** The release note scopes its measurement the same
  way; I did not widen it.
- **The Copilot agent set** (S-14). Out of scope and not exercisable from here.

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| `usageline_worker_definer_read` is `USING (true)`; a member of the definer reads every tenant's `"UsageLine"` | **Accepted, bounded by mechanism.** Non-membership verified live in both directions for all three application roles, asserted by `R8`, by migration section 7, and by auth-service's suite. |
| A compromised worker can enumerate tenant ids and then read/write any of them | **Accepted and now accurately stated in all six places** — capability unchanged from `telemetry_app`, the addition is that ids need not be known. Recorded as S-43. |
| **S-45** — usage arriving after its day is invoiced is never billed by the job, silently | **Accepted for this task, recorded as MEDIUM.** The fix is billing-service's early return or a product decision; changing it here breaks one-task-per-commit. Reproduced independently at this gate. Should be scheduled, not left to drift. |
| No index serves the enumeration | **Accepted**, S-44 part 1, with a correct "not measured" disclaimer. |
| `BILLING_SERVICE_URL` accepts any scheme | **Accepted**, S-44 part 2; matching gateway is the right call and diverging one service is the S-23/S-39 shape. |
| Shutdown grows to ~10 s × tenants | **Accepted with the worst case written down**, and re-measured here. Operator action (`terminationGracePeriodSeconds`) is in the release note. |
| `"Stream read interrupted by shutdown"` is absent on an in-flight shutdown | **Accepted**, S-26's T-042 addendum; observability only, and the alternative reverses a correct shutdown order. |
| worker-service holds a constant *and* a literal for `app.tenant_id` inside one package | **Accepted**, recorded in S-19 with the `md5sum` evidence; to be closed by the `@telemetry/shared-db` promotion, not opportunistically. |
| `S-38` (billing's `P2002` re-read has no live test) is reached more often now | **Accepted and correctly disclaimed** in `billing-client.service.ts:43-52`. |
| A missed night is never recovered | **Accepted**, documented in the release note. |
| `S-8` — billing's guard is still `!==` in a `preHandler`, and worker is now a caller | **Out of scope**, correctly left alone; worker's own schema is already `.trim().min(...)`. |
| Coverage thresholds are enforced by nothing in CI | **Pre-existing**, S-25's territory, correctly noted there. |
| S-24 fired a fourth time (this session) | **Recommend** adding the sighting to S-24's list; it is the first on a final review gate. |

---

## Required for `APPROVED FOR COMMIT`

All four are corrections to records. **None changes behaviour, none touches production code, and
none needs the gate re-run** — though the gate should of course be green at commit time.

1. **MEDIUM-1** — `.claude/rules/known-gaps.md:890` `:79` → `:129`; `:893` `:95-100` → `:145-150`;
   add the re-run instruction to the parenthetical at `:899`.
2. **LOW-1** — `.claude/rules/known-gaps.md:868` "233 cases" → "234 cases".
3. **LOW-2** — `docs/plans/t-042-invoice-generation-job.md:948`: label the `98.13 / 92.91 / …`
   figures as superseded.
4. **LOW-4** — `docs/plans/t-042-invoice-generation-job.md:693`: add the three shipped
   `rls.integration.test.ts` cases to AC7's **shipped** column.

LOW-3, NIT-1 and NIT-2 are recorded, not required.

---

## Decision for the user

**Question: S-45 is a silent revenue-loss path that this task correctly declined to fix. When does
it get fixed?**

It is recorded as MEDIUM and open. It needs a policy decision before any code, and the decision is
not worker-service's.

| Option | What changes | Diff impact |
|---|---|---|
| **A · Schedule it now as its own billing-service task** (recommended) | An explicit task before the first production nightly run, choosing one of S-45's three fix directions. Recommended because the failure is silent and the only operator-facing signal — the `failed` count — is `0` in both the healthy and the broken case, so nobody will notice it in production. | **Changes a future diff, not this one.** T-042 commits as reviewed. |
| **B · Refuse-and-surface only** (S-45 direction 3) | billing answers something other than a plain `200` when an invoice exists *and* unbilled rows remain, so the job counts it as a failure. Smallest change, no schema movement, converts silence into a nightly alarm. | A future billing-service diff; possibly a noisy alarm for a routine condition. |
| **C · Leave it open indefinitely** | The entry stands; recovery stays manual and produces overlapping invoices. | No diff. **Accepts that the first occurrence is discovered on a customer invoice.** |

A and B both need billing-service's D1 author; C is the status quo. None of the three changes the
T-042 diff, so this does not gate the commit — it gates what happens after it.

---

**CONDITIONAL, and the conditions are four text edits.** The privilege boundary is the strongest
part of the change and I could not find a way around it from the live catalog or from a live
connection; the two rework claims the brief flagged as unchecked both re-derive to the digit; the
S-45 and S-26 records are accurate, including the parts that say what was *not* established. The
findings are what they have been all task: line citations falsified by the commit that wrote them.
