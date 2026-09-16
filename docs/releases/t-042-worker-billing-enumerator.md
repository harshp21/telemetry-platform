# Release note — T-042 · worker-service moves onto a restricted database role, and the nightly invoice job

Applies to the change that adds `prisma/migrations/v1_7_worker_billing_enumerator`, flips
worker-service's `DATABASE_URL`, and adds a BullMQ scheduler that asks billing-service to
generate a draft invoice for each tenant with unbilled usage. Plan:
`docs/plans/t-042-invoice-generation-job.md`.

**This is a two-step deploy. The migration and the connection-string change must not ship as one
step, and the migration must be first.** A worker started on `telemetry_worker_app` before
`v1_7` has been applied cannot connect at all — the role does not exist. A worker started on a
role that exists without the grants fails `permission denied` on its first write. The flip must
never precede the grant.

The same structure as S-7's deploy, for the same reason. Read
`docs/releases/s-007-auth-service-restricted-role.md` first if you have not; this note assumes
its vocabulary.

---

## What changed

### 1 · The database

`prisma/migrations/v1_7_worker_billing_enumerator` creates **two roles**, one policy and one
function.

- `telemetry_worker_definer` — `NOLOGIN NOSUPERUSER NOBYPASSRLS`, holding `SELECT` on
  `"UsageLine"` and nothing else. It owns:
  - `public.worker_resolve_tenants_with_unbilled_usage(text, text) RETURNS SETOF text`

  `SECURITY DEFINER`, `STABLE`, `STRICT`, with a pinned `search_path`, returning the **tenant ids
  only** — never a quantity, never a `UsageLine` id, never a period.

  It reads past the `"UsageLine"` tenant policy through one targeted policy the migration also
  creates — `usageline_worker_definer_read`, `FOR SELECT`, scoped `TO telemetry_worker_definer`
  — **not** through the `BYPASSRLS` role attribute, for the reason `v1_5` gives: `BYPASSRLS`
  applies to every table the role could ever reach, and a policy is bounded by mechanism.

- `telemetry_worker_app` — `LOGIN NOSUPERUSER NOBYPASSRLS`, owner of no table. **`EXECUTE` on the
  resolver is granted to this role alone**, and revoked from `PUBLIC`, from `telemetry_app` and
  from `telemetry_auth_app`.

  That is why the role exists. `telemetry_app` is shared by gateway, usage, billing and
  analytics; granting it `EXECUTE` would give all four an enumerate-every-tenant oracle that
  reads straight past the `"UsageLine"` policy.

  Its table privileges are **narrower** than `telemetry_app`'s: `SELECT, INSERT, UPDATE` on
  `"Event"` and `"UsageLine"` only — the two tables worker-service writes — with **no `DELETE`**,
  **no grant on `"Tenant"`**, and no `ALTER DEFAULT PRIVILEGES … GRANT`, so a future table has to
  be granted deliberately.

  **Provisioning consequence:** if you create this role out of band, grant those two tables and
  no more. A wider grant is both converged and rejected — the migration revokes everything
  outside the two and then fails if anything is left, reading `pg_class`/`pg_attribute` rather
  than `information_schema` so the check works for a non-superuser migration role and catches
  column-level grants too.

  **Why no grant on `"Tenant"` despite `Event_tenantId_fkey`.** Measured on PostgreSQL 16.13
  against a throwaway role holding those two tables and nothing else, inside a rolled-back
  transaction: `SELECT count(*) FROM "Tenant"` raised `permission denied for table Tenant`, an
  `INSERT INTO "Event"` referencing a real `"Tenant"` row **succeeded**, and an `INSERT` naming a
  tenant id that does not exist — with `app.tenant_id` set to that same id, so the RLS check
  could not be what rejected it — failed with
  `violates foreign key constraint "Event_tenantId_fkey"`. Referential integrity is enforced in
  both directions without the calling role holding any privilege on the referenced table.

worker-service's runtime `DATABASE_URL` becomes `telemetry_worker_app`. RLS continues to enforce
on `"Event"` and `"UsageLine"` for worker-service exactly as before; what changes is that the
cross-tenant read it needs now exists, and is reachable by this role and nothing else.

**What that widens, stated as measured, because a security note that overstates its own bound is
worse than none.** It is not "worker can now read other tenants' rows". Any holder of
`telemetry_app` could already read *and write* a tenant's rows **given that tenant's id** — that
is what `set_config('app.tenant_id', …)` does, and it is how every service reaches the tenant it
is serving. Probed against two seeded tenants as `telemetry_worker_app`: with no tenant context a
direct `SELECT` on `"UsageLine"` returned **0 rows**; the resolver returned **both** ids; with
`app.tenant_id` set to one of them, `SELECT` on `"UsageLine"` and on `"Event"` returned that
tenant's rows and `UPDATE "UsageLine" SET billed = true WHERE "tenantId" = …` reported `UPDATE 1`
(rolled back). The same three statements as `telemetry_app`, with the same id, returned the same
results — while `telemetry_app` calling the resolver got
`permission denied for function worker_resolve_tenants_with_unbilled_usage`.

So the exception buys exactly one thing: **the tenant ids no longer have to be known.** It turns
"read or write any tenant whose id you hold" into "enumerate every tenant with unbilled usage, and
then do that". That is the widening being accepted, and it is why the `EXECUTE` grant is scoped to
this one role rather than to the `telemetry_app` four other services share. If that grant is ever
widened, this paragraph is the thing to re-read first.

### 2 · The service

- A BullMQ queue, worker and repeatable scheduler, firing `0 2 * * *` with `tz: "UTC"` set
  **explicitly**. Omitted, `cron-parser` evaluates the pattern in the process' local zone.
- Per tenant, one `POST /v1/internal/billing/generate` carrying `X-Internal-Secret`, with a
  10-second `AbortSignal.timeout`.
- A new required environment variable, `BILLING_SERVICE_URL`. **worker-service will not start
  without it** — the env schema throws at module load.
- `await bullWorker.close()` in the shutdown handler, ordered **before**
  `streamConsumer.stop()`. This discharges the forward obligation S-35 recorded against this
  task.

---

## Deploy order

Each step is verifiable before the next. Do not collapse them.

**Step 0 — before anything.** Confirm the migration role can create roles. `CREATE ROLE` needs
`CREATEROLE` or superuser, and `ALTER FUNCTION … OWNER TO` additionally needs the migration role
to be a *member* of `telemetry_worker_definer`. On managed PostgreSQL where that is not
available, provision both roles out of band first and then run step 1 — every block in the
migration is idempotent and converges.

**Step 1 — apply the migration.**

```
pnpm --filter @telemetry/auth-service exec prisma migrate deploy --schema=../../prisma/schema.prisma
pnpm --filter @telemetry/auth-service exec prisma migrate status --schema=../../prisma/schema.prisma
```

The migration verifies itself at apply time and **aborts the transaction** rather than leaving a
half-built exception. It fails if the definer role is not `NOLOGIN NOSUPERUSER NOBYPASSRLS`; if
the function is not `SECURITY DEFINER` or is owned by anyone else; if its signature is not
`(text, text) → SETOF text`; if `PUBLIC` or `telemetry_app` can execute it, or
`telemetry_worker_app` cannot; if the policy is missing, is not `SELECT`-only, or is not scoped
to the definer; if `"UsageLine"` carries any policy beyond the expected two; if **any**
`SECURITY DEFINER` function in `public` is reachable by `PUBLIC` or `telemetry_app`; if any
application role is a *member* of the definer; or if either role holds a table or column
privilege outside its enumerated list.

It then runs a **functional** guard: it seeds a tenant with one unbilled and one already-billed
`UsageLine`, clears `app.tenant_id`, calls the resolver, deletes the rows, and raises unless the
call returned exactly the probe tenant — and unless a window containing none of the rows returned
nothing. That check exists because a definer whose owner cannot see past the policies returns an
**empty set with no error**, which downstream is indistinguishable from "nobody used the product
yesterday". Nobody gets invoiced and nothing raises an alarm.

**Step 2 — verify, before flipping anything.**

```
psql -Atc "select p.oid::regprocedure::text,
                  (select rolname from pg_roles where oid = p.proowner),
                  p.proacl::text
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.prosecdef order by 1"
```

Expect three rows, and for the worker resolver expect
`{telemetry_worker_definer=X/telemetry_worker_definer,telemetry_worker_app=X/telemetry_worker_definer}`
— no `PUBLIC`, no `telemetry_app`.

**Step 3 — flip worker-service's `DATABASE_URL`** to `telemetry_worker_app` and set
`BILLING_SERVICE_URL`. Both are required; the service does not start without the second.

**Step 4 — confirm.** The worker logs `Invoice generation scheduler registered` at startup,
before it binds its listener. The first nightly run logs `Invoice generation job started`, then
`Enumerated tenants with unbilled usage` with a count, then one line per tenant, then
`Invoice generation job completed` with `{ tenants, succeeded, failed }`.

---

## Rollback levers

In increasing order of severity. The first three need no migration.

1. **Stop the nightly job without stopping the worker.** Stream consumption is unaffected: the
   two are separate subsystems that only share a process.

   **The logical database is `0`** — worker-service's `REDIS_URL` selects no database
   (`redis://<host>:6379`), which is db 0, the same one `telemetry:events` lives on. The `14` and
   `15` that appear in this repository's tests are per-suite reservations and are not production.

   **A `DEL` of the `:repeat` key alone is not enough, and this is measured rather than
   reasoned.** BullMQ materialises the *next* occurrence as an ordinary delayed job as soon as the
   scheduler is upserted, and that job is a separate key in a separate zset. Probed against a real
   queue built from the shipped constants on db 14, with the cron pattern changed to `* * * * * *`
   so "the next run" is one second away rather than 02:00, a real `Worker` attached for four
   seconds, and the job counted:

   | Lever applied after `upsertJobScheduler` | delayed jobs after | jobs that ran in 4 s |
   |---|---|---|
   | `DEL …:repeat` (what this note used to say) | **1** | **1** |
   | `queue.removeJobScheduler("daily-invoice-generation")` | 0 | **0** |
   | nothing (control) | 1 | 4 |

   So the old command stops the *re-scheduling* and lets the occurrence that is already on the
   delayed set fire — which with `0 2 * * *` is exactly the next 02:00 UTC, the run the lever
   exists to prevent. `queue.getJobSchedulers()` returns `[]` after it, so it also *looks* like it
   worked.

   Either of these does work. From code, one call:

   ```ts
   await queue.removeJobScheduler("daily-invoice-generation"); // -> true
   ```

   From `redis-cli`, four commands — the third needs the member id the second prints:

   ```
   redis-cli -n 0 ZRANGE telemetry:bull:invoice-generation:delayed 0 -1
   #   -> repeat:daily-invoice-generation:<epoch-millis>
   redis-cli -n 0 DEL telemetry:bull:invoice-generation:repeat \
                      telemetry:bull:invoice-generation:repeat:daily-invoice-generation
   redis-cli -n 0 ZREM telemetry:bull:invoice-generation:delayed \
                      repeat:daily-invoice-generation:<epoch-millis>
   redis-cli -n 0 DEL telemetry:bull:invoice-generation:repeat:daily-invoice-generation:<epoch-millis>
   ```

   Measured on the same fixture: `DEL -> 2`, `ZREM -> 1`, `DEL -> 1`, then `getDelayed()` and
   `getJobSchedulers()` both empty and **0 jobs in 4 s**. A restart re-registers the schedule
   (`registerSchedule()` runs at startup), so this is a lever for a running worker — to stop it
   across a restart, deploy with the scheduler registration disabled, which is the cleaner option
   and needs no Redis surgery at all.

   Scope of the measurement: `bullmq@6.3.6`, Redis 7.0.15, db 14, the shipped queue name, prefix
   and scheduler id, cron pattern substituted as described. Not measured against a queue with a
   job in flight.

2. **Revert `BILLING_SERVICE_URL` to an unreachable address.** The job then enumerates, fails
   every tenant, logs each failure, and returns `failed: N`. Nothing is written and nothing is
   marked billed — billing-service performs the write, not worker.
3. **Revert worker's `DATABASE_URL` to `telemetry_app`.** The service keeps processing the stream
   (its `"Event"`/`"UsageLine"` DML is unchanged), and the nightly job fails with
   `permission denied for function worker_resolve_tenants_with_unbilled_usage` — loudly, on the
   enumeration, which is the path that *rejects* rather than reporting a false success.
4. **Revert the service, keep the migration.** The migration is additive: a new policy scoped to
   a role nothing connects as, a new function nothing else calls, and a new role nothing else
   uses. No existing query plan, privilege or policy changes for any other service.
5. **Remove the exception entirely** (forward-only; there is no down migration):

   ```sql
   DROP FUNCTION IF EXISTS public.worker_resolve_tenants_with_unbilled_usage(text, text);
   DROP POLICY IF EXISTS "usageline_worker_definer_read" ON public."UsageLine";
   -- Only once no worker is connected as it:
   REASSIGN OWNED BY telemetry_worker_definer TO postgres;
   DROP OWNED BY telemetry_worker_definer;
   DROP ROLE IF EXISTS telemetry_worker_definer;
   DROP OWNED BY telemetry_worker_app;
   DROP ROLE IF EXISTS telemetry_worker_app;
   ```

   Doing this **while worker-service is pointed at `telemetry_worker_app` takes the service
   down**, including stream consumption. Do step 3 first.

---

## Operational notes

- **A missed night is not recovered by the job.** The window is always *yesterday*, so a worker
  that was down across a day never bills that day. The data is not lost — the rows stay
  `billed = false` — but nothing picks them up automatically. Recovery is a manual
  `POST /v1/internal/billing/generate` per tenant for the missed window, which is idempotent.
- **A tenant whose call fails every night is visible only in logs** until T-057 adds metrics. The
  signal is the `failed` count in `Invoice generation job completed` and the per-tenant
  `Invoice generation failed for tenant` lines. Watch the count, not just the job's exit status:
  the job deliberately **succeeds** when individual tenants fail, and **fails** only when the
  enumeration itself failed.
- **The job retries its own failure three times, minutes apart — not hours — and logs three lines,
  not one.** `attempts: 3` with `backoff: { type: "exponential", delay: 60 000 }`
  (`WORKER_INVOICE_JOB.ATTEMPTS` / `BACKOFF_TYPE` / `BACKOFF_DELAY_MS`,
  `apps/worker-service/src/constants.ts`). Measured against the installed `bullmq@6.3.6`'s own
  strategy rather than inferred from the name: `Backoffs.builtinStrategies.exponential(60000)`
  returns `60 000` at `attemptsMade = 1` and `120 000` at `2`, so the three attempts land at about
  `T`, `T + 1 min` and `T + 3 min` and the sequence is over in roughly three minutes. Measured on a
  real queue (Redis db 14, `delay` scaled to 50 ms, a processor that always throws):
  `worker.on("failed")` fired **3** times, with `attemptsMade` 1, 2 and 3, and `getFailed()` held 1
  job afterwards — so `Invoice generation job failed` appears once per attempt, and three such lines
  a few minutes apart are **one** failed night, not three. Only a failed *enumeration* is retried:
  a per-tenant failure resolves with a summary and is never retried. `removeOnComplete: 30` /
  `removeOnFail: 90` bound what `getCompleted()` / `getFailed()` will show.
- **Connection count grows.** The process already held the container's Redis client plus the
  stream consumer's private `duplicate()`; BullMQ adds its own — one for the queue and a blocking
  one for the worker. All are closed on the shutdown path. This does not change S-34, which is
  about consumer-registry rows rather than connections.
- **Shutdown takes longer, and the worst case is `10 s x tenants with unbilled usage`.**
  `bullWorker.close()` waits for an in-flight job, which may be mid-HTTP-call, and carries no
  timeout of its own. It runs *before* the stream drain, so the drain's own `DRAIN_TIMEOUT_MS`
  budget is unchanged; total shutdown time grows. The bound that exists is the 10-second
  per-request timeout on each billing call, and those calls are **sequential**. Measured with a
  real `SIGTERM` against a real process whose billing calls hang: **9 116 ms at one tenant**,
  **19 106 / 19 079 ms at two**, against **36-39 ms idle** — the job was never truncated, every
  per-tenant outcome was logged and the exit code was 0. **Set
  `terminationGracePeriodSeconds` above `10 x` your tenant count**; at the Kubernetes default of
  30 that is three tenants. Beyond it the pod is `SIGKILL`ed part way through the run — nothing is
  corrupted (the remaining rows stay `billed = false`), but the night is incomplete and, per the
  first note above, the job will not pick it up again.
- **A side effect of that wait, for anyone reading shutdown logs.** While the queue close waits,
  the parked stream read expires on its own, so `"Stream read interrupted by shutdown"` is **not**
  written on a shutdown with a job in flight — only `"Stream consumer loop stopped"` is. An idle
  shutdown writes both. Nothing is lost; the absent line does not mean the consumer failed to
  stop. Recorded in `.claude/rules/known-gaps.md` S-26's T-042 addendum.
- **Usage that arrives after its day has been invoiced is never billed by the nightly job, and the
  job reports success (S-45).** Billing returns the existing invoice unchanged when one exists for the period,
  *before* it looks for unbilled rows, so a `UsageLine` written into an already-invoiced window
  stays `billed = false` and the next night's window no longer contains it. The job logs
  `succeeded` with `created: false`, which is indistinguishable from an ordinary re-run. Manual
  recovery is a `POST /v1/internal/billing/generate` with a **narrower** window that still
  contains the rows, which produces a second, overlapping invoice. See `.claude/rules/known-gaps.md`
  S-45 for the reproduction and the options.
- **On a database that already ran `v1_7`, the recorded checksum no longer matches the file, and
  that is accepted.** The migration's *comments* were edited after it was applied locally. Measured
  on the development database: recorded `checksum` `cd41991e97f362…`, file `sha256sum`
  `9defe7ddb1e852…`, and both `prisma migrate status` ("Database schema is up to date!") and
  `prisma migrate deploy` ("No pending migrations to apply.") accept it without complaint, with all
  five `telemetry*` roles still present afterwards. **Nothing for an operator to do on a fresh
  target** — the file applies as written, and this is only about a database that recorded an earlier
  revision of the same file. Scope of the measurement: `migrate status` and `migrate deploy` on
  `prisma@6.19.3`; `migrate dev` was **not** run, because it would write a migration, so nothing
  here says how that command treats the same state.
- **No index serves the enumeration.** Both non-unique `"UsageLine"` indexes lead with
  `tenantId`, which this predicate does not have. The cost was **not** measured — the table was
  empty — so this is an observation about the leading columns, not a claim about the plan at
  scale. Revisit when the table has representative data; do not add an index on the strength of
  this note alone.
