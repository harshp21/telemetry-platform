# S-18 — Usage-summary range predicate resolves through the DB session timezone

**Gate 1 (Task Planner) · base commit `3374cf9` · plan only, no code written**

**Status: new plan.** No prior plan for S-18 exists (`ls docs/plans/ | grep -i 's-018\|timezone'`
→ no match). It is not an extension of anything. It does, however, *unblock* an existing plan:
`docs/plans/t-036-usage-service-integration-tests.md` is paused at Gate 3 and its case B8 is
written around the defect this plan fixes (§9).

**S-18 is deliberately not added to `.claude/rules/known-gaps.md`.** That file is for gaps that
stay open; per the task brief the user has chosen to fix this one. The record is this plan plus
the review that will sit at `docs/reviews/s-018-usage-summary-range-timezone.md`.

---

## 1. Business context

### Objective

`GET /v1/usage/summary` is the read side of usage metering — the numbers a customer is billed
from. Its date window is currently resolved through the **PostgreSQL server session's
`TimeZone`** rather than UTC, so every requested window is translated by the server's offset.
The objective is to make the window mean exactly what the API contract says it means: a
half-open UTC interval `[from, to)`.

### User impact

A shifted billing window is a wrong invoice, and it is wrong in two directions at once — it
drops rows that belong in the period and admits rows that belong to the next one.

Measured, not argued. Six `UsageLine` rows, a requested window of
`from=2026-01-01T00:00:00.000Z`, `to=2026-02-01T00:00:00.000Z`, and the shipped predicate from
`apps/usage-service/src/repositories/usage.repository.ts:116`:

| Session `TimeZone` | Rows returned | vs. intended `{r2,r3,r4,r5}` |
|---|---|---|
| `UTC` (+00:00) | `{r2,r3,r4,r5}` | correct |
| `Asia/Kolkata` (+05:30) | `{r4,r5,r6}` | drops `r2`,`r3`; **admits `r6`, which sits exactly on the exclusive upper bound and belongs to February** |
| `America/New_York` (−05:00) | `{r1,r2,r3,r4}` | **admits `r1`, which is December**; drops `r5` |

Command that established this: §3.2, probe 2.

Three properties make this worse than a simple off-by-offset:

1. **Reads and writes disagree.** `periodStart` stores the exact UTC clock value it was given
   (verified: a row written as `2026-01-01T00:00:00.000Z` reads back as
   `2026-01-01T00:00:00.000Z` under all three session zones, §3.3). Only the read predicate
   shifts. So the data is right and the report is wrong.
2. **The direction depends on the server.** The same code, the same request, the same data
   returns three different answers on three servers.
3. **CI cannot see it.** `postgres:16-alpine` — the exact image used by
   `.github/workflows/ci.yml:43` and `docker/docker-compose.yml:23` — defaults `TimeZone` to
   `UTC`, where the broken and correct predicates are indistinguishable. This machine's
   PostgreSQL is `Asia/Kolkata`. The defect is latent in CI and live in any deployment whose
   database was `initdb`'d on a non-UTC host (§3.6).

### Why now

`T-036` cannot assert the endpoint's actual contract until this is fixed; its case B8 currently
asks the database what bounds it will use instead of asserting `[from, to)` (§9). And the read
path is the only production consumer of a billing timestamp column that exists today, so the
blast radius is at its smallest it will ever be (§4.3).

---

## 2. Scope and non-goals

### In scope

- The range predicate in `UsageRepository.buildFilters`
  (`apps/usage-service/src/repositories/usage.repository.ts:110-117`).
- A UTC session pin inside usage-service's `withTenant`
  (`apps/usage-service/src/repositories/base.repository.ts:93-99`), so the *next* raw date
  predicate in this service cannot inherit the defect.
- Tests that fail on the shipped code **on a UTC server as well as this one**, which is the
  only kind of test that means anything in CI (§8).
- Correcting the comments that currently document the broken behaviour as if it were intended
  (`usage.repository.ts:43-48`, `usage.repository.unit.test.ts:180-182`).

### Out of scope (explicit non-goals)

- **Migrating any column to `timestamptz`.** Rejected with reasons in §5.2; it is the
  highest-risk option and its failure mode is silent data corruption.
- **The other three services' `withTenant` copies and auth-service's `withTenantContext`.**
  `apps/worker-service/src/repositories/base.repository.ts:98`,
  `apps/billing-service/.../base.repository.ts:98` and
  `apps/analytics-service/.../base.repository.ts:98` are byte-identical to usage-service's, and
  auth-service has its own helper at `apps/auth-service/src/repositories/user.repository.ts:234`.
  None of them has a single date predicate today (§4.1). Rolling the pin into all five inside a
  usage-service defect fix changes four other services' data-access behaviour in one commit —
  the same reasoning that split S-8 out of S-4 and S-10 out of S-7. Offered as decision **D-2**.
- **`DATABASE_URL` connection-string changes and the env-schema guard that would make them
  enforceable.** Analysed in §5.3; it touches ~14 config sites plus deployment config outside
  this repository and changes six services' startup contracts. Offered as decision **D-3**.
- **Per-tenant timezone bucketing.** `Tenant.timezone` exists (`prisma/schema.prisma:15`,
  `String @default("UTC")`), is written by auth-service at
  `apps/auth-service/src/repositories/user.repository.ts:295`, and is **read by no query**
  (`grep -rn timezone apps/*/src packages/*/src` → only those two sites plus the schema and
  seed). S-18 must not quietly become "bucket in tenant-local time". That is a product decision
  and `docs/epics/epic-6-usage-service.md:180` still carries it as an unresolved Q3 placeholder.
- **S-5 (clock-skew window) and S-16 (missing 10 KB per-event cap).** Both are in the same
  service and S-16 is in the same request family, but both are on the **ingest** path
  (`events.validator.ts`, `events.controller.ts`) and neither touches a SQL timestamp
  comparison. No interaction — checked in §10.
- Bucket-boundary semantics (`DATE_TRUNC`), pagination maths, the response envelope, the
  `metricKey` filter. All verified unaffected (§3.3, §3.5).

---

## 3. Ground truth — every claim with the command that established it

Everything below was run against the live PostgreSQL on `127.0.0.1:5432`
(`PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)`), which is what `.env` points at. All
write probes ran inside `BEGIN … ROLLBACK` or against `ON COMMIT DROP` temp tables, except the
one seeded fixture in probe 5, which was deleted and verified gone. Post-probe state is
recorded in §3.8.

### 3.1 The environment is not what a single `docker ps` suggests

    ss -ltnp | grep -E '5432|6379'
    → LISTEN 127.0.0.1:5432 , LISTEN 127.0.0.1:6379
    pg_isready -h localhost -p 5432   → accepting connections

    docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
    → postgres-db  postgres:16-alpine  5432/tcp        (no host mapping)
    docker inspect postgres-db --format '{{json .NetworkSettings.Ports}}'
    → {"5432/tcp":[]}

- The database the tests use is a **host-native** PostgreSQL 16.13, not a container.
- The one running `postgres:16-alpine` container is `postgres-db`, publishes **no** host port,
  and belongs to a different project (`POSTGRES_MULTIPLE_DATABASES=supertokens,multitenant_auth`
  in its `Config.Env`). `docker/docker-compose.yml:22-37` also publishes no port for its
  `postgres` service. Nothing in this repo's compose stack is reachable on `localhost:5432`.
- A plan step that says "bring up compose and run the integration tests against it" would not
  work here. The suites reach the host instance.

### 3.2 The comparison resolves through the session `TimeZone` — three forms

**Form 1 — the reduced case, both directions:**

    psql -h localhost -U postgres -d telemetry -X
    BEGIN; SET LOCAL TimeZone='Asia/Kolkata';
    SELECT pg_typeof('2026-01-01T00:00:00.000Z'::timestamptz) AS bound_type,
           ('2026-01-01 00:00:00'::timestamp(3) >= '2026-01-01T00:00:00.000Z'::timestamptz) AS included,
           ('2026-01-01T00:00:00.000Z'::timestamptz)::timestamp(3)::text AS coerced;
    ROLLBACK;
    → timestamp with time zone | f | 2026-01-01 05:30:00
    -- same query under SET LOCAL TimeZone='UTC'
    → t | 2026-01-01 00:00:00

Reproduces the brief's recorded output exactly.

**Form 2 — real bound parameters against a `periodStart`-shaped column** (the table in §1):

    BEGIN;
    CREATE TEMP TABLE probe (id int, "periodStart" timestamp(3) without time zone) ON COMMIT DROP;
    INSERT INTO probe VALUES (1,'2025-12-31 19:00:00'),(2,'2026-01-01 00:00:00'),
      (3,'2026-01-01 03:00:00'),(4,'2026-01-01 12:00:00'),(5,'2026-01-31 20:00:00'),
      (6,'2026-02-01 00:00:00');
    PREPARE win(timestamptz,timestamptz) AS SELECT array_agg(id ORDER BY id) FROM probe
      WHERE "periodStart" >= $1 AND "periodStart" < $2;
    SET LOCAL TimeZone='UTC';              EXECUTE win('2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z'); → {2,3,4,5}
    SET LOCAL TimeZone='Asia/Kolkata';     …                                                                   → {4,5,6}
    SET LOCAL TimeZone='America/New_York'; …                                                                   → {1,2,3,4}
    ROLLBACK;

**Form 3 — through Prisma, against real `UsageLine` rows** (§3.3).

The shift tracks the sign of the offset. It is a translation of the window, not a widening: the
window keeps its requested width in all three cases.

### 3.3 Through Prisma: the raw path is broken, **the ORM path is not**

This is the single most useful fact in this plan, and it was established by execution, not by
reasoning about what Prisma ought to do.

Probe: a CommonJS script requiring the generated client from
`node_modules/.pnpm/@prisma+client@6.19.3_.../node_modules/@prisma/client`, seeding a `Tenant`,
six `Event`/`UsageLine` pairs at the instants above, running four query shapes, and then throwing
inside `prisma.$transaction` so the whole thing rolls back. Run once per session timezone via
`$executeRawUnsafe("SET LOCAL TimeZone = …")` as the first statement of the transaction.

    node <scratchpad>/probe.cjs

| Session `TimeZone` | `pg_typeof` of a bound JS `Date` | ORM `where:{gte,lt}` | Raw, bound `Date` (shipped) | Raw, `::timestamp(3)` | Raw, `AT TIME ZONE 'UTC'` |
|---|---|---|---|---|---|
| `UTC` | `timestamp with time zone` | `{r2,r3,r4,r5}` OK | `{r2,r3,r4,r5}` OK | OK | OK |
| `Asia/Kolkata` | `timestamp with time zone` | `{r2,r3,r4,r5}` **OK** | `{r4,r5,r6}` **SHIFTED** | OK | OK |
| `America/New_York` | `timestamp with time zone` | `{r2,r3,r4,r5}` **OK** | `{r1,r2,r3,r4}` **SHIFTED** | OK | OK |

Two more results from the same probe, constant across all three zones:

- **The read/output direction is safe.** A naive `timestamp(3)` column selected through
  `$queryRaw` comes back as a JS `Date` whose `toISOString()` is `2026-01-01T00:00:00.000Z` —
  i.e. the naive value is interpreted as UTC — and `DATE_TRUNC('day',"periodStart")` likewise
  returns `2026-01-01T00:00:00.000Z`. So `toIsoString` at `usage.repository.ts:68` and the
  `bucketStart`/`bucketEnd` projection at `:93` are **correct**, and the claim in the comment at
  `usage.repository.ts:43-48` that `DATE_TRUNC` yields UTC boundaries with no `AT TIME ZONE`
  conversion is **correct**. Only the `WHERE` predicate is wrong. This narrows the fix
  considerably.
- **A bound JS `Date` is `timestamp with time zone`; a bound ISO string is `text`.** Both
  measured with `SELECT pg_typeof(${value})::text`.

**Why the ORM path is safe.** Prisma's query log shows the ORM emits the *same* predicate shape —
`"periodStart" >= $2 AND "periodStart" < $3` — but logs its parameters as
`"2026-01-01 00:00:00 UTC"`, and the behaviour is invariant across all three session zones. The
observation is that the engine, which knows from `prisma/schema.prisma` that `periodStart` is a
`DateTime` backed by `timestamp`, does not produce a `timestamptz` comparison; `$queryRaw` has no
such schema knowledge of the target column and binds a JS `Date` as `timestamptz`. I am stating
the behaviour I measured; the mechanism is an inference from the logged parameter form and should
be read as such.

**Consequence for the fix and for every future query:** *use the ORM for date ranges where you
can; where you must use raw SQL, the parameter has to be coerced explicitly.* That sentence is
the durable output of this investigation.

### 3.4 Every application timestamp column is `without time zone` — all 20 of them

    psql -h localhost -U postgres -d telemetry -c "select table_name, column_name, data_type,
      datetime_precision from information_schema.columns where table_schema='public'
      and data_type like 'timestamp%' order by table_name, column_name;"

20 columns across 9 tables, every one `timestamp without time zone`, `datetime_precision = 3`:
`Event.createdAt/occurredAt`, `ExportAudit.exportedAt`,
`Invoice.createdAt/finalizedAt/periodEnd/periodStart`, `Meter.activeFrom/activeTo`,
`MetricRollup.bucketStart/computedAt`, `RefreshToken.createdAt/expiresAt/revokedAt`,
`Tenant.createdAt/deletedAt`, `UsageLine.periodEnd/periodStart/processedAt`, `User.createdAt`.

The only `timestamp with time zone` columns in the database belong to Prisma's own
`_prisma_migrations`. `grep -n '@db\.' prisma/schema.prisma` shows no `@db.Timestamptz` anywhere —
this is Prisma's default PostgreSQL mapping for `DateTime`, not a deliberate choice, and it is
uniform.

### 3.5 The `ALTER … TYPE timestamptz` trap, and the index question

**The migration option's failure mode is silent corruption.** Both forms, same session, same row:

    BEGIN; SET LOCAL TimeZone='Asia/Kolkata';
    -- two temp tables each holding one row: '2026-01-01 00:00:00'
    ALTER TABLE alterprobe  ALTER COLUMN "periodStart" TYPE timestamptz(3);
    ALTER TABLE alterprobe2 ALTER COLUMN "periodStart" TYPE timestamptz(3)
      USING "periodStart" AT TIME ZONE 'UTC';
    SET LOCAL TimeZone='UTC'; SELECT … ;
    → no USING clause        : 2025-12-31 18:30:00+00      ← every row moved by the offset
    → USING AT TIME ZONE UTC : 2026-01-01 00:00:00+00      ← correct
    ROLLBACK;

The bare form is accepted without warning and its result depends on the timezone of whichever
session ran the migration.

**`AT TIME ZONE 'UTC'` is direction-sensitive** — applied to the *column* it is wrong, applied to
the *parameter* it is right:

    SELECT pg_typeof('2026-01-01 03:00:00'::timestamp(3) AT TIME ZONE 'UTC')      → timestamp with time zone
           DATE_TRUNC('day','2026-01-01 03:00:00'::timestamp(3) AT TIME ZONE 'UTC') → 2026-01-01 00:00:00+05:30
           pg_typeof('2026-01-01T00:00:00.000Z'::timestamptz AT TIME ZONE 'UTC')  → timestamp without time zone
           ('2026-01-01T00:00:00.000Z'::timestamptz AT TIME ZONE 'UTC')::text     → 2026-01-01 00:00:00

So the existing warning at `usage.repository.unit.test.ts:180-182` ("any `AT TIME ZONE`
conversion would silently shift day/week boundaries") is **true of the column** and does **not**
conflict with a fix that touches only the bound parameter. The implementer must not read that
comment as forbidding the fix, and the reviewer must not read the fix as violating it.

**No index-coverage change.** `UsageLine` has `@@index([tenantId, periodStart, periodEnd])`
(`prisma/schema.prisma:95`). With 50 000 rows, `ANALYZE`, and `enable_seqscan=off`, all three
predicate shapes use the index — including with a **parameterized** cast rather than a
const-foldable literal:

    PREPARE q(text,text) AS SELECT count(*) FROM p2
      WHERE tid='t' AND "periodStart" >= $1::timestamp(3) AND "periodStart" < $2::timestamp(3);
    EXPLAIN (COSTS OFF) EXECUTE q('2026-01-05T00:00:00.000Z','2026-01-06T00:00:00.000Z');
    → Bitmap Index Scan on "p2_tid_periodStart_idx"
      Index Cond: ((tid = 't') AND ("periodStart" >= (…)::timestamp(3)) AND ("periodStart" < (…)::timestamp(3)))
    EXECUTE q(…) → 1440          -- 24*60: exactly one day, so the bounds are right too

The shipped `timestamptz` form is indexable too. That is precisely why this defect is silent:
the comparison is legal, planned well, and wrong. There is neither a regression nor an
improvement to claim here.

### 3.6 CI runs UTC, so CI cannot catch this

    docker exec postgres-db psql -U postgres -Atc \
      "select version(); show timezone; select source from pg_settings where name='TimeZone';"
    → PostgreSQL 16.14 … on x86_64-pc-linux-musl (Alpine)
      UTC
      configuration file

    psql -h localhost -U postgres -d telemetry -c \
      "select name,setting,boot_val,reset_val,source,sourcefile from pg_settings
       where name in ('TimeZone','log_timezone');"
    → TimeZone | Asia/Kolkata | GMT | Asia/Kolkata | configuration file
                              | /etc/postgresql/16/main/postgresql.conf

Two things follow, and both shape §8:

- The setting's `source` is **`configuration file`**, not a client. libpq sends no `TimeZone`, and
  the brief's observation that the process `TZ` is irrelevant is confirmed: the value comes from
  the server's own `postgresql.conf`, written by `initdb` from the host zone.
- `.github/workflows/ci.yml:43` uses `postgres:16-alpine`, whose config-file default is `UTC`.
  **A behavioural end-to-end test can never fail in CI on the broken code**, because under UTC
  the broken and correct predicates return the same rows. Any regression test that does not
  pin a non-UTC session is, in CI, an assertion about nothing.

### 3.7 What controls the session timezone, tested in four forms plus a negative control

Through the Prisma client at 6.19.3, one client per candidate `DATABASE_URL`:

    node <scratchpad>/probe-url.cjs

    no params (baseline)         TimeZone = Asia/Kolkata   boundary included = false
    options=-c timezone=UTC      TimeZone = UTC            boundary included = true
    options=-c TimeZone=UTC      TimeZone = UTC            boundary included = true
    options unencoded spaces     TimeZone = UTC            boundary included = true
    timezone=UTC  (bare param)   TimeZone = Asia/Kolkata   boundary included = false   ← silently ignored

The negative control matters: a bare `?timezone=UTC` raises no error and does nothing. An
operator could believe they had pinned the connection and be wrong.

    -- transaction-local set_config, the form that matches withTenant's existing statement
    BEGIN;
      SELECT current_setting('TimeZone');                    → Asia/Kolkata
      SELECT set_config('TimeZone','UTC',true);              → UTC
      SELECT current_setting('TimeZone'),
             ('2026-01-01 00:00:00'::timestamp(3) >= '2026-01-01T00:00:00.000Z'::timestamptz);
                                                             → UTC | t
    ROLLBACK;
    SELECT current_setting('TimeZone');                      → Asia/Kolkata   -- no leak

    -- server-side defaults, on a scratch database created and dropped for the purpose
    CREATE DATABASE s18_tz_probe;                            -- inherited: Asia/Kolkata
    ALTER DATABASE s18_tz_probe SET TimeZone='UTC';          -- new session: UTC, boundary included = t
    CREATE ROLE s18_probe_role LOGIN …;
    ALTER ROLE s18_probe_role SET TimeZone='America/New_York';
    -- connecting as that role to that database:                America/New_York

`ALTER ROLE … SET TimeZone` **overrides** `ALTER DATABASE … SET TimeZone`. A role-level default
set by a DBA silently defeats a database-level pin, and neither is visible from this repository.
That is the argument against §5.4.

### 3.8 The database was left as found

    select count(*) from pg_database where datname='s18_tz_probe';   → 0
    select count(*) from pg_roles    where rolname='s18_probe_role'; → 0
    select count(*) from pg_db_role_setting;                         → 0
    select current_setting('TimeZone') from telemetry;               → Asia/Kolkata
    select count(*) from "UsageLine" / "Tenant" / "Event";           → 0 / 0 / 0

All application tables were empty before the probes and are empty after. `postgresql.conf` was
not touched. Probe 5 (§8, strategy validation) seeded one tenant and six `Event`/`UsageLine`
pairs through the owner connection and deleted them in a `finally` block; the counts above are
the confirmation. Scratch database and role dropped (the first `DROP ROLE` failed on a dangling
`CONNECT` grant and needed a `REVOKE` first — recorded because it is the kind of step a cleanup
script forgets).

---

## 4. Is this one call site, or a class?

**One live call site today. A class by construction.** Both halves matter, and they point at
different parts of the fix.

### 4.1 The exhaustive search

    grep -rn '\$queryRaw|\$executeRaw|Prisma\.sql|Prisma\.raw|queryRawUnsafe|executeRawUnsafe' \
      apps packages prisma --include=*.ts | grep -v node_modules
    grep -rn 'periodStart|periodEnd|bucketStart|occurredAt|activeFrom|activeTo|expiresAt' \
      apps/*/src packages/*/src prisma/*.ts
    grep -rn 'gte:|lte:|gt:|lt:|equals:' apps/*/src packages/*/src prisma/*.ts

Production raw SQL in the whole monorepo, by category:

| Site | Shape | Timestamp comparison? |
|---|---|---|
| `apps/usage-service/src/repositories/usage.repository.ts:116` | `"periodStart" >= ${Date} AND < ${Date}` | **YES — the defect** |
| `usage.repository.ts:89,93` | `DATE_TRUNC` projection / `GROUP BY` / `ORDER BY` | no (output side, verified safe §3.3) |
| `base.repository.ts:98` × 4 (usage, worker, billing, analytics — byte-identical) | `set_config('app.tenant_id',…)` | no |
| `apps/auth-service/src/repositories/user.repository.ts:235,248,262` | `set_config`, two `SECURITY DEFINER` resolvers keyed on `text` | no |

- **Zero Prisma ORM date-range filters exist in production source.** The `gte:/lte:/gt:/lt:`
  grep returns three false positives (`const result: IngestionResult`, a comment). So the safe
  path is currently unused as well as safe.
- **worker, billing and analytics have no repositories and no services.**
  `find apps/{worker,billing,analytics}-service/src -name '*.ts'` returns only `index.ts` stubs
  under `repositories/`, `services/`, `jobs/`, `validators/`. They contribute no query.
- **usage-service never writes.** `grep -rn 'usageLine|event\.create' apps/usage-service/src`
  → no match. Ingestion validates, dedupes in Redis and publishes to a Redis stream
  (`src/services/ingestion.service.ts`, `src/events/stream.publisher.ts`). Nothing in production
  writes `UsageLine` yet; the rows the summary reads are seeded by fixtures today and will be
  written by worker-service later. So "reads and writes disagree" is currently a statement about
  the *stored* value's meaning, not about two live code paths — and the writer, when it lands,
  will inherit whichever convention this task establishes.

### 4.2 Why it is nevertheless a class

1. All 20 application timestamp columns are `without time zone` and uniformly so (§3.4). There
   is no column where a bound `Date` is the right thing.
2. A bound JS `Date` in `$queryRaw` is `timestamptz`, always (§3.3). The broken shape is the
   *natural* thing to write, and it is legal, indexable and silent (§3.5).
3. **The equality form fails differently and worse.** Same six rows, `WHERE "periodStart" = $1`
   with `$1 = 2026-01-01T00:00:00.000Z`:

   | Session `TimeZone` | Match |
   |---|---|
   | `UTC` | `{2}` — correct |
   | `Asia/Kolkata` | `{}` — **no match at all** |
   | `America/New_York` | `{1}` — **the wrong row** |

   `Invoice` has `@@unique([tenantId, periodStart, periodEnd])` (`prisma/schema.prisma:128`) and
   `Meter` has `@@unique` on `activeFrom` — these are exactly the keys an invoice-generation
   upsert will use. A raw upsert keyed that way would create a duplicate invoice on a
   positive-offset server and overwrite an unrelated period's invoice on a negative-offset one.
   Nothing does this today; `prisma/seed.ts:59` is the nearest shape and it cannot run at all
   (known gap S-13).
4. The next raw date predicate is already foreseeable: billing's invoice-period query and
   worker's `MetricRollup.bucketStart` write are both named in `docs/epics/epic-7-*` and
   `epic-8-*`.

**Therefore the fix has two jobs**: correct the one live predicate, and make the next one safe.
That is what §5.5 recommends and why it is two slices rather than one.

---

## 5. Which fix, and what it costs

### 5.1 Option 1 — coerce at the call site

    "periodStart" >= ${new Date(input.from).toISOString()}::timestamp(3)

**Correctness: verified.** TZ-invariant across `UTC`, `Asia/Kolkata`, `America/New_York` in both
the psql and the Prisma probes (§3.2, §3.3). Index unaffected, including with a parameterized
cast (§3.5).

**The trap this option contains, and it is not obvious.** Interpolating `input.from` *raw* — the
form the brief floats as `${iso}::timestamp(3)` — is **wrong**, because PostgreSQL's text →
`timestamp` cast **discards** an offset rather than converting it:

    SET LOCAL TimeZone='Asia/Kolkata';
    SELECT '2026-01-01T00:00:00.000Z'::timestamp(3)::text      → 2026-01-01 00:00:00
           '2026-01-01T00:00:00.000+05:30'::timestamp(3)::text → 2026-01-01 00:00:00   ← offset dropped
           '2026-01-01T00:00:00.000-08:00'::timestamp(3)::text → 2026-01-01 00:00:00   ← offset dropped
           '2026-01-01T00:00:00.000Z'::timestamptz::timestamp(3)::text → 2026-01-01 05:30:00

And offsets are **accepted input**. `usage-summary.validator.ts:30-31` uses `iso8601Schema`,
which is `z.string().datetime({ offset: true })`
(`packages/shared-validation/src/index.ts:20`). Verified:

    node -e "…z.string().datetime({offset:true})…"
    "2026-01-01T00:00:00.000Z"      ACCEPTED  → 2026-01-01T00:00:00.000Z
    "2026-01-01T00:00:00+05:30"     ACCEPTED  → 2025-12-31T18:30:00.000Z
    "2026-01-01T00:00:00.000-08:00" ACCEPTED  → 2026-01-01T08:00:00.000Z
    "2026-01-01T00:00:00"           rejected

So `from=2026-01-01T00:00:00+05:30` is a legal request today, and the shipped code handles its
offset **correctly** (`new Date(...)` resolves the instant; the validator's `.refine` at
`usage-summary.validator.ts:46` compares `getTime()`) before the session zone breaks it. A fix
that interpolates the raw string would replace a session-dependent error with an
offset-dependent one — a *different* instance of the same class, and one no test on a
Z-only fixture set would catch.

**The fix must normalize in JavaScript first**: `new Date(input.from).toISOString()`, which
always yields a `Z` form, and only then cast. `AT TIME ZONE 'UTC'` on the bound `Date`
(§3.3, §3.5) is equally correct and equivalent; the ISO-string form is preferred because the
value crossing the wire is then human-readable in a query log, and because it keeps the cast and
the normalization visibly adjacent.

**Cost:** one expression, one file, no migration, no config, no other package affected. **Limit:**
it fixes this predicate and nothing else — point 2 of §4.2 is untouched.

### 5.2 Option 2 — migrate the columns to `timestamptz` · **REJECTED**

What it would actually have to do, for each of the 20 columns in §3.4:

    ALTER TABLE "UsageLine" ALTER COLUMN "periodStart" TYPE timestamptz(3)
      USING "periodStart" AT TIME ZONE 'UTC';

plus `@db.Timestamptz(3)` on 20 `DateTime` fields in `prisma/schema.prisma`, plus a forward-only
migration directory, plus a re-check of every raw query, plus updating `T-036`'s fixtures and
`integration.constants.ts`'s recorded expectations.

Rejected for four reasons, in order of weight:

1. **The failure mode is silent corruption of billing data.** Omit the `USING` clause and every
   row moves by the migration session's offset, with no error (§3.5). The correct statement and
   the catastrophic one differ by one clause, and the catastrophic one is the shorter.
2. **The result depends on where the migration is run from.** `postgresql.conf` on this host is
   `Asia/Kolkata`; CI's is `UTC`. A migration whose outcome varies with the operator's session
   is not a migration this repository should carry, and `CLAUDE.md` requires migrations to run
   through `DIRECT_DATABASE_URL` as the owner — an identity whose session zone nothing in the
   repo controls.
3. **Table rewrites take `ACCESS EXCLUSIVE` and it is forward-only.** Nine tables including
   `Invoice` and `UsageLine`. Locally free — 0 rows in every table (§3.8) — which is exactly the
   trap: this option is indistinguishable from a no-op on this machine and unrecoverable in
   production.
4. **It is not needed to fix the defect**, and it is strictly easier and safer to do *after* a
   UTC pin is in place and proven, when the ORM/raw distinction has been characterised and the
   invariant has tests.

Worth recording for whoever revisits it: because the ORM path already behaves as UTC (§3.3),
migrating to `timestamptz` would change ORM *write* semantics for anything not already sending
UTC-normalized values. That re-check is part of the cost and is not visible from the schema.

### 5.3 Option 3a — pin the session on the connection string

`options=-c timezone=UTC` on `DATABASE_URL` works at Prisma 6.19.3, in three spellings, and
fixes the comparison (§3.7).

**Why it is attractive:** it covers *every* query on the connection, including any future one
outside `withTenant` — which is more than §5.5 achieves.

**Why it is not the recommendation here:**

- **~14 in-repo sites, and unknown deployment config.** `grep -rn DATABASE_URL` (excluding
  `node_modules`, `dist`, `docs/reviews`, `docs/plans`) finds it defined in: `.env.example:9`,
  `apps/{usage,worker,billing,analytics}-service/.env.example:10`,
  `apps/auth-service/.env.example:24`, `docker/docker-compose.yml:5` and `:66`,
  `.github/workflows/ci.yml:15`, `:19`, `:23`,
  `apps/{usage,worker,billing,analytics}-service/tests/setup.ts:5-8`,
  `apps/auth-service/tests/database-urls.ts:11`, and
  `apps/usage-service/tests/integration.constants.ts:18`. Plus whatever sets it in a real
  deployment, which is not in this repository.
- **A missed site fails open and silent** (`?timezone=UTC` bare is ignored without error, §3.7).
- It can be made fail-closed — a `.refine` on `DATABASE_URL` in each `EnvSchema` requiring the
  option, matching the pattern the repo already uses for `INTERNAL_API_SECRET`
  (`apps/usage-service/src/config/env.ts:15`: "required with no default: `parseEnv` throws at
  module load"). That is genuinely the strongest "unrepresentable" story available. But it
  changes the startup contract of **six** services and CI inside a usage-service defect fix,
  which is the thing S-8's own note in `known-gaps.md` says not to do.

Offered as decision **D-3**, with a recommendation to do it as its own task, guard included.

### 5.4 Option 3c — `ALTER DATABASE` / `ALTER ROLE` default · **REJECTED as the primary mechanism**

`ALTER DATABASE telemetry SET TimeZone='UTC'` works for new sessions (§3.7). Rejected because
`ALTER ROLE … SET TimeZone` **overrides** it (measured), neither setting is visible from or
version-controlled in this repository, and nothing in CI or compose would notice its absence.
It is a fine belt-and-braces action for an operator to take — it belongs in the release note as
a recommendation, not in the code as the mechanism.

### 5.5 Recommendation — two layers, in this order

**Layer A (Slice 2): coerce at the call site**, with JS-side `toISOString()` normalization
(§5.1). Makes the predicate say what it means where a reader will look for it, and closes the
offset hazard §5.1 uncovered.

**Layer B (Slice 3): `set_config('TimeZone','UTC',true)` as the second statement of
usage-service's `withTenant`**, immediately after the existing `set_config('app.tenant_id',…)`
at `apps/usage-service/src/repositories/base.repository.ts:98`. Verified: sets the zone, fixes
the comparison, and is transaction-local with **no leak** after `ROLLBACK`/commit (§3.7). No
config, no migration, no deploy coordination, and it applies automatically to every future
tenant-scoped raw query in this service.

**Why both, rather than picking one.** This is the repository's own doctrine, not a hedge.
`.claude/rules/tenant-isolation.md`: *"Every tenant-scoped query carries an explicit `tenantId`
predicate **and** runs inside `withTenant`. Belt and braces — neither alone."* The same
reasoning applies exactly: Layer B alone leaves `usage.repository.ts:116` looking wrong and
being correct only because of a `set_config` in a different file — a line that becomes wrong
again the moment someone copies it outside a `withTenant` callback. Layer A alone leaves §4.2
point 2 open. Neither alone.

**What this recommendation does not claim.** Layer B covers queries *inside* `withTenant`. It
does not cover a query outside it, and in usage-service today there are none — but auth-service's
resolvers do run outside tenant context (`user.repository.ts:247,261`), so if the pin is ever
rolled to auth-service (**D-2**) that limitation must be stated there rather than assumed away.
Only §5.3 covers the whole connection, which is why it is offered as **D-3** rather than
dismissed.

---

## 6. Files to change

### Existing — production

| File | Change |
|---|---|
| `apps/usage-service/src/repositories/usage.repository.ts` | `:116` — coerce both bounds: normalize with `new Date(x).toISOString()` in TS, compare as `::timestamp(3)`. `:43-48` — rewrite the doc comment: keep the (correct) `DATE_TRUNC` statement, add the predicate's new contract and why the parameter is cast. |
| `apps/usage-service/src/repositories/base.repository.ts` | `:98` — add `set_config('TimeZone', …, true)` after the tenant `set_config`, in the same `Prisma.sql`/tagged-template style. `:44-60` — extend the "Security Properties" block with the session-zone invariant. |
| `apps/usage-service/src/constants.ts` | New entries for the two new literals — the SQL timestamp precision used by the cast and the `"UTC"` session-zone value, plus the `TimeZone` setting name. Required by `.claude/rules/constants.md` ("Route paths … TTLs" and "no magic strings … **and tests**"); `APP_TENANT_ID_SETTING` already has this treatment in `apps/usage-service/tests/rls.enforcement.integration.test.ts`, so mirror that naming. |

### Existing — tests

| File | Change |
|---|---|
| `apps/usage-service/tests/usage.repository.unit.test.ts` | Rewrite `:109-115` — it currently asserts `rowsSql.values[1]).toEqual(new Date(FROM))`, i.e. it **pins the defect** at unit level and will fail on any correct fix. Replace with T1/T2 (§8). Correct the comment at `:180-182` per §3.5 so it distinguishes column from parameter. |
| **NEW** `apps/usage-service/tests/usage.timezone.integration.test.ts` | T3–T6 (§8). Self-contained: builds its own `PrismaClient`s and seeds through the owner connection, so it does **not** depend on T-036's uncommitted fixtures. |

### Existing — docs

| File | Change |
|---|---|
| **NEW** `docs/plans/s-018-usage-summary-range-timezone.md` | This file. |
| **NEW** `docs/reviews/s-018-usage-summary-range-timezone.md` | Written by the reviewer at Gate 4/6. |
| `docs/development-setup.md` | Add the session-zone requirement near the two-connection-string table at `:25-36`, including the `ALTER DATABASE` recommendation from §5.4 and the observation that a bare `?timezone=` is ignored. |

### Deliberately NOT modified

- **`.claude/rules/known-gaps.md`** — per the brief. It is also modified in the working tree by
  T-036 (adds S-16, S-17); leave that diff untouched.
- **`.claude/rules/*`** — configuration; not edited without explicit instruction. If the
  "ORM-safe, raw-unsafe" rule from §3.3 should become a standing rule in
  `.claude/rules/tenant-isolation.md` or a new `.claude/rules/` entry, that is decision **D-5**.
- `apps/usage-service/tests/usage.integration.test.ts`, `integration.fixtures.ts`,
  `integration.constants.ts` — T-036's uncommitted work. §9 says what should happen to them and
  **who** should do it, which is not S-18.
- `docs/plans/t-036-usage-service-integration-tests.md` — modified in the working tree; leave it.
- worker/billing/analytics `base.repository.ts`, auth-service's `withTenantContext` — **D-2**.
- All `DATABASE_URL` definitions, `docker/docker-compose.yml`, `.github/workflows/ci.yml` — **D-3**.
- `prisma/schema.prisma` and `prisma/migrations/**` — no migration in this task (§5.2).

---

## 7. Implementation slices, smallest safe first

### Controlling code path

    GET /v1/usage/summary
      → routes/usage.routes.ts
      → onRequest: internal-auth.middleware  (X-Internal-Secret, timing-safe)
      → onRequest: tenant-context.middleware (X-Tenant-Id validated as UUID → request.tenantId)
      → UsageController.handle                          controllers/usage.controller.ts:25
          usageSummaryQuerySchema.safeParse(request.query)   validators/usage-summary.validator.ts:28
            from/to: iso8601Schema = z.string().datetime({ offset: true })   ← offsets legal
      → UsageService.getUsageSummary                    services/usage.service.ts:28
      → usageRepositoryFactory(tenantId)                config/container.ts:61   (factory, not singleton)
      → UsageRepository.aggregateSummary                repositories/usage.repository.ts:80
          withTenant(tx)                                repositories/base.repository.ts:93
            set_config('app.tenant_id', …, true)        base.repository.ts:98    ← Slice 3 adds the zone pin here
            buildFilters(input)                         usage.repository.ts:110
              "periodStart" >= ${new Date(from)} …      usage.repository.ts:116  ← THE DEFECT / Slice 2
            $queryRaw count, then page                  usage.repository.ts:88, 92

Note for the implementer: `config/container.ts:61` passes the **module-level singleton**
`prisma` from `src/lib/prisma.ts`, which constructs `new PrismaClient({log:[…]})` with no
`datasourceUrl` and caches it on `globalThis` when `NODE_ENV !== "production"`. So the app's
connection URL is fixed at first import of `src/lib/prisma.ts` and cannot be re-pointed by a
test afterwards. That is why T3–T6 build their own clients (§8).

### Falsifiable local hypothesis

> **H.** The *only* production timestamp comparison in this monorepo is
> `usage.repository.ts:116`; it is wrong solely because a bound JS `Date` is `timestamptz`
> against a `timestamp` column; and coercing that parameter to UTC-naive is sufficient to make
> `GET /v1/usage/summary` return the same rows for the same request on any server, with no
> change to bucket boundaries, quantities, pagination or index usage.
>
> **H is falsified if any of these holds:**
>
> 1. A production date comparison exists somewhere the §4.1 greps missed — most likely a
>    `MetricRollup`/`Invoice` predicate, or a Prisma ORM `where` clause using a `Date` in a way
>    that turns out **not** to be UTC-stable on a fourth session zone.
> 2. The ORM path is *not* actually safe, and §3.3's three-zone result was an artefact of the
>    interactive-transaction probe rather than of how the engine binds. **Check:** re-run the
>    ORM leg outside `$transaction`, and on a fourth zone with a non-integral offset
>    (`Asia/Kathmandu`, +05:45).
> 3. After Slice 2, `bucketStart`/`bucketEnd` or `totalQuantity` change for any fixture under any
>    session zone — meaning the fix touched the output side, or `DATE_TRUNC` was not
>    zone-independent after all.
> 4. After Slice 3, `current_setting('TimeZone')` inside `withTenant` is not `UTC`, or the
>    setting is observable *outside* the transaction (a leak that would make one request's
>    setting affect the next on a pooled connection).
> 5. Coercing the parameter costs the index — `EXPLAIN` shows a sequential scan where the
>    `(tenantId, periodStart, periodEnd)` index was used before. §3.5 says no, at 50 000 rows
>    with a parameterized cast; if it holds at 50 000 and not at production scale, H is
>    falsified and the fix needs a different shape.
> 6. An offset-bearing `from`/`to` (`+05:30`, `-08:00`) does not produce the identical window to
>    its `Z` equivalent after the fix — §5.1's trap, present and unnoticed.

Falsifications 1 and 2 are cheap and go first; 2 is the one that would most change the plan,
because if the ORM is not safe then §5.5's whole "use the ORM where you can" conclusion goes.

### Slices

**Slice 0 — record the red baseline (no edits).**
Run the existing suites and save the verbatim output. Then re-run §3.3's and §3.7's probes on a
fourth zone with a non-integral offset (`Asia/Kathmandu`, +05:45) and outside `$transaction`, to
attack falsifications 1 and 2 before writing anything. If the ORM leg shifts in either variant,
**stop and return to Gate 1**.

**Slice 1 — tests first, confirmed red (pseudo-TDD, `CLAUDE.md` "Implementation Methodology").**
Write T1–T6 (§8) in full and run them. Expected: T1, T2 red; T3, T4 red on the non-UTC leg;
T5 red; T6 green (it is a no-regression guard and must be green before *and* after). Record the
verbatim failures. **A test that was never red proves nothing** (`.claude/rules/testing.md`).

**Slice 2 — Layer A: the call site.**
Add the constants, coerce both bounds in `buildFilters`, rewrite the `:43-48` comment. Expected:
T1, T2, T3, T4 green; T5 still red; T6 unchanged.
Validate: `pnpm --filter @telemetry/usage-service exec vitest run tests/usage.repository.unit.test.ts`
then the two integration files, then package typecheck + lint.

**Slice 3 — Layer B: the session pin in `withTenant`.**
Add `set_config('TimeZone', …, true)` after the tenant setting in
`apps/usage-service/src/repositories/base.repository.ts:98`, update the class doc block.
Expected: T5 green, everything else unchanged. Explicitly assert the ordering — tenant context
first, then zone — so the security-relevant statement stays the first statement of the
transaction, and confirm no leak outside the transaction (falsification 4).

**Slice 4 — docs.**
`docs/development-setup.md`, and this plan's Gate-3 execution record. No `.claude/rules/` edits.

**Slice 5 — full gate.** §10.

Slices 2 and 3 are independently revertible, which is the point of splitting them: if Layer B
turns out to interact with connection pooling in a way the probes did not reveal, Layer A alone
still fixes the defect.

---

## 8. Test plan and acceptance-coverage mapping

### Acceptance criteria

- **AC-1** `GET /v1/usage/summary` returns exactly the rows whose `periodStart` lies in
  `[from, to)` interpreted as UTC, for any database session `TimeZone`.
- **AC-2** The row exactly at `from` is included; the row exactly at `to` is excluded.
- **AC-3** `from`/`to` carrying a non-`Z` offset produce the identical window to their `Z`
  equivalent.
- **AC-4** `bucketStart`, `bucketEnd`, `totalQuantity`, `total` and pagination are unchanged by
  the fix, under any session `TimeZone`.
- **AC-5** Inside `withTenant`, the session `TimeZone` is `UTC` regardless of the connection's
  default, and the setting does not outlive the transaction.
- **AC-6** The `(tenantId, periodStart, periodEnd)` index is still used by the summary predicate.
- **AC-7** No magic literals introduced; the new SQL/precision/zone values live in `constants.ts`.

### The central test-design constraint

Because CI's PostgreSQL is `UTC` (§3.6), a behavioural test that merely queries the endpoint
would pass on the broken code in CI. Every behavioural case below therefore **pins a deliberately
non-UTC session** on its own connection via `options=-c timezone=…` (§3.7), so it fails on the
shipped code on *any* server. That is what makes it a regression test rather than a description
of this laptop.

**The strategy was validated by execution before being written down.** Probe 5 mirrored
`withTenant` exactly — `$transaction`, then `set_config('app.tenant_id', …, true)` as the first
statement — over a `telemetry_app` connection carrying the URL option, with the six rows seeded
through the owner connection:

    node <scratchpad>/probe-strategy.cjs

    session TimeZone = UTC           (role=telemetry_app, rows visible under RLS=6)
       shipped predicate : ["r2","r3","r4","r5"]   PASS
       fixed   predicate : ["r2","r3","r4","r5"]   PASS
    session TimeZone = Asia/Kolkata  (role=telemetry_app, rows visible under RLS=6)
       shipped predicate : ["r4","r5","r6"]        FAIL
       fixed   predicate : ["r2","r3","r4","r5"]   PASS
    cleanup: usageLine rows left=0, tenant rows left=0

Three things this establishes beyond the diagnosis: the URL option survives into a Prisma
interactive transaction and coexists with `set_config('app.tenant_id')`; RLS is not a confounder
(all six rows visible once tenant context is set, as `telemetry_app`, which
`pg_roles` confirms is `rolsuper=f, rolbypassrls=f`); and the UTC leg passes on the broken code,
which is the whole reason the non-UTC leg has to exist.

### Cases

| ID | Level | Case | Fails on shipped code where? |
|---|---|---|---|
| **T1** | unit, no infra | `buildFilters` binds a UTC-naive value compared as `timestamp`, not a `timestamptz` `Date`. Asserts on `rowsSql.text`/`values` as the file already does. **Replaces** the current `:109-115` assertions, which pin the defect. | **Everywhere, incl. UTC CI** |
| **T2** | unit, no infra | `from: "2026-01-01T05:30:00+05:30"` and `from: "2026-01-01T00:00:00.000Z"` produce byte-identical bound values. Guards §5.1's offset trap. | Everywhere (and on a naive-interpolation "fix") |
| **T3** | integration | Six boundary rows, `[2026-01-01T00:00:00Z, 2026-02-01T00:00:00Z)`, session pinned `Asia/Kolkata` (+05:30) → exactly `{r2,r3,r4,r5}`. | Everywhere |
| **T4** | integration | Same, session pinned `America/New_York` (−05:00) and `UTC`. Both directions, so the assertion is invariance rather than one offset. | New_York leg: everywhere |
| **T5** | integration | Inside `withTenant`, on a connection whose default zone is `Asia/Kolkata`, `current_setting('TimeZone')` is `UTC`; **and** outside the transaction it is still `Asia/Kolkata`. | Everywhere (after Slice 3) |
| **T6** | integration | `bucketStart`/`bucketEnd`/`totalQuantity`/`total` identical under all three pinned zones — the no-regression guard on the output side. Green before and after; its job is to fail if someone "fixes" the column with `AT TIME ZONE`. | n/a — must be green throughout |
| **T7** | manual, recorded | `EXPLAIN` of the post-fix predicate at ~50 000 rows shows the `(tenantId, periodStart, periodEnd)` index in use. Recorded in the Gate-3 record, not asserted in a suite — an `EXPLAIN` assertion is brittle across planner versions, and T-036 dropped its own `EXPLAIN` slice for the same reason. | n/a |

### Mapping

| AC | Proven by |
|---|---|
| AC-1 | T3, T4 (both offset directions + UTC control) |
| AC-2 | T3 (`r2` at `from` present; `r6` at `to` absent — `r6` is the row the shipped code wrongly admits) |
| AC-3 | T2; plus a T4 leg issuing the window as `+05:30` and asserting the same rows |
| AC-4 | T6 |
| AC-5 | T5 |
| AC-6 | T7 (recorded), backed by §3.5 |
| AC-7 | Reviewer gate, `.claude/rules/constants.md` |

### Epic acceptance mapping

`docs/epics/epic-6-usage-service.md:179-182` lists three T-035 acceptance criteria:

| Epic AC | Status | Note |
|---|---|---|
| "Response is always tenant-scoped — no cross-tenant data leakage" | unaffected by S-18 | Standing proof is `tests/rls.enforcement.integration.test.ts`; not touched. |
| "`granularity=day` bucket boundaries are midnight UTC (Q3 decision placeholder)" | **already true, and now provable** | §3.3 measured `DATE_TRUNC` returning `2026-01-01T00:00:00.000Z` under three session zones. T6 pins it. Q3 remains formally open — see **D-4**. |
| "Empty date ranges return `{ items: [], total: 0 }` not an error" | unaffected | Covered by T-036 case B7. |

**Escalation — the epic is silent where it should be loudest.** The T-035 spec
(`epic-6-usage-service.md:160-182`) specifies `from`/`to` only as `// ISO8601` and never states
whether the interval is half-open or which timezone resolves it. The half-open `[from, to)`
contract exists **only** in the code comments at `usage.repository.ts:8-10` and in the
validator's docstring at `usage-summary.validator.ts:22`. So the behaviour S-18 is fixing was
never actually specified, and per `CLAUDE.md` I am planning against the code and escalating
rather than inventing a spec: this is decision **D-4**. No epic constant, status code or
payload shape was found to be wrong for *this* task — the divergences in this endpoint's family
are already recorded as S-5, S-6, S-16 and S-17, and none of them touches the range predicate
(§10).

---

## 9. What T-036's case B8 should become

`apps/usage-service/tests/usage.integration.test.ts:739-813` — case B8 — is named "applies a
half-open range" but does not assert that. Its own comment says so plainly (`:740-749`), and it
compensates by calling `getFixtures().readEffectiveRangeBounds(...)`
(`integration.fixtures.ts:198-208`), asking the database which bounds it will actually compare
against, then seeding rows relative to *those* and asserting only the **shape** `[lower, upper)`.

That was the right call at Gate 3 for a test-only task: the alternative was hard-coding one
machine's offset. It is not the right call once the defect is fixed.

The accommodation is wider than B8. `integration.constants.ts:65-81` documents `RANGE_FROM`
/`RANGE_TO` as *deliberately* wider than every fixture instant — "a window that starts on a
fixture instant therefore drops or admits rows by the session offset, which would make the
bucket, filter, precision and isolation cases fail for a reason none of them is about". So the
whole 24-case suite is shaped around this defect, not only B8.

**Recommended, for whoever resumes T-036 — not part of S-18's diff:**

1. **B8 asserts the contract directly.** Drop `readEffectiveRangeBounds`; use
   `BOUNDARY_RANGE_FROM`/`BOUNDARY_RANGE_TO` as literal UTC bounds and assert four rows: exactly
   at `from` → **in**; 1 ms below `from` → **out**; 1 ms below `to` → **in**; exactly at `to` →
   **out**. `INTEGRATION_BOUNDARY_PROBE.STEP_MILLIS` already exists for this and
   `integration.constants.ts:150` already notes a millisecond is representable in `timestamp(3)`.
   Delete the `:740-749` comment and replace it with a one-line pointer to S-18 and to
   `usage.timezone.integration.test.ts`.
2. **Repurpose rather than delete `readEffectiveRangeBounds`.** Turn it into an assertion — the
   effective bound now *equals* the requested instant — so it keeps its diagnostic value and
   stops being an accommodation. Deleting it outright is also defensible; repurposing is
   preferred because it fails loudly if the pin regresses.
3. **Keep the wide `RANGE_FROM`/`RANGE_TO`,** but rewrite the `:65-78` rationale. A window wider
   than the fixtures is good practice independently of this bug, and narrowing it would churn
   ~20 cases for no gain.
4. **Amend `integration.constants.ts:69-78`,** which asserts the defect as a property of the
   system. After S-18 it is false.

**Sequencing (decision D-1).** S-18's tests must not depend on T-036's uncommitted fixtures, and
T-036's B8 should not be committed asserting a defect that is being fixed in the same week.
Recommended: **S-18 lands first, self-contained** (new integration file builds its own clients
and seeds through the owner connection — validated in probe 5, which did exactly that without
importing anything from T-036). T-036 then resumes at Gate 3 with items 1-4 folded in and gets a
strictly better B8. This costs one temporary duplicate seeding helper, which T-036 can collapse
when it lands.

---

## 10. Interaction with the known gaps

`.claude/rules/known-gaps.md` read in its working-tree state (S-5, S-6, S-8, S-9, S-10, S-11,
S-12, S-13, S-14, S-15, S-16, S-17).

| Gap | Same request path? | Interaction |
|---|---|---|
| **S-5** clock-skew window is symmetric ±5 min | No — **ingest**, `events.validator.ts:9` + `events.controller.ts:141` | None. It gates `occurredAt` on `POST /v1/usage/events` in JS via `Date.getTime()`; no SQL comparison. Worth noting the *shape* is a cousin — a time window that does not mean what its name says — but the mechanism is unrelated and the fix must not be folded in. |
| **S-16** 10 KB per-event cap enforced nowhere | No — ingest validation | None. Touches `ingestRequestSchema`, not the read path. |
| **S-17** `quantity` validator narrower than the column | Indirect | Relevant only as a fixture constraint: the HTTP ingest path cannot express fractional or >100 quantities, which is why T-036 and S-18's probe seed `UsageLine` through the owner connection instead. |
| **S-10** `"RefreshToken"` RLS `FORCE`d but not `ENABLE`d | No | Different table, different service. `UsageLine` RLS **is** enabled and enforcing — probe 5 ran as `telemetry_app` (`rolsuper=f, rolbypassrls=f`) and saw its six rows only with tenant context set. |
| **S-12** `pnpm format:check` cannot pass | Tangential | ~250 files already fail. S-18 must not run `prettier --write`; the new file should match the surrounding 2-space style of `apps/usage-service/**` (note this package is space-indented while `apps/auth-service/**` is tab-indented — do not normalize either). |
| **S-6, S-8, S-9, S-11, S-13, S-14, S-15** | No | No interaction found. |

**One incidental observation, out of scope and unresolved.**
`.claude/rules/tenant-isolation.md` describes `telemetry_auth_definer` as
`NOLOGIN NOSUPERUSER BYPASSRLS`. Live: `select rolname, rolsuper, rolbypassrls from pg_roles
where rolname like 'telemetry%'` → `telemetry_auth_definer|f|f`. T-036's plan already recorded
this as follow-up **F-12** and attributes it to the role being created `NOBYPASSRLS` with
targeted policies instead. Reported because I observed it, not diagnosed; it does not affect
S-18 and I did not investigate the cause.

---

## 11. Validation commands

### Pre-flight (once, and it is not optional)

    ss -ltnp | grep 5432                       # host-native PG, not the compose stack (§3.1)
    psql "$DIRECT_DATABASE_URL" -Atc "show timezone"
    # If this prints UTC, T3/T4/T5 still work — they pin their own session on their own
    # connection — but note in the Gate 3 record that the *server default* was UTC, so the
    # unpinned legs proved nothing locally either.
    psql "$DIRECT_DATABASE_URL" -Atc \
      "select count(*) from information_schema.columns
       where table_name='UsageLine' and column_name='periodStart'
         and data_type='timestamp without time zone'"   # expect 1
    redis-cli -u "$REDIS_URL" ping

### Task-scoped, fail fast

    pnpm --filter @telemetry/usage-service exec vitest run tests/usage.repository.unit.test.ts
    pnpm --filter @telemetry/usage-service exec vitest run tests/usage.timezone.integration.test.ts
    pnpm --filter @telemetry/usage-service typecheck
    pnpm --filter @telemetry/usage-service lint
    pnpm --filter @telemetry/usage-service build

Use `exec vitest run <file>`, never `test -- <file>`: per `CLAUDE.md` and
`.claude/rules/testing.md` the latter does not filter and runs the whole package suite.

### The one that actually proves the fix

    # red before Slice 2, green after — and it fails on a UTC server too, which is the point
    pnpm --filter @telemetry/usage-service exec vitest run \
      tests/usage.timezone.integration.test.ts -t 'Asia/Kolkata'

### Regression surface most at risk

    pnpm --filter @telemetry/usage-service test    # whole package, incl. rls.enforcement

There is **no** `apps/usage-service/vitest.config.ts` and the package script is a bare
`vitest run` (`apps/usage-service/package.json`), so `*.integration.test.ts` files run inside
`pnpm test` — they are **not** excluded, contrary to `.claude/rules/testing.md` ("Integration
tests … are excluded from the default vitest config"). T-036's plan already recorded that as
follow-up **F-11**. Two consequences the implementer must not get wrong: the new integration
file **will** run in CI's `Unit Tests` step, and there is no skip guard
(`grep -n 'skipIf|skip(' apps/usage-service/tests/*.integration.test.ts` → no match), so it
hard-fails without a database rather than passing vacuously. That is the desired behaviour;
do not add a skip.

### Full gate (Gate 7, before commit approval)

    pnpm build && pnpm test && pnpm lint && pnpm typecheck    # 13/13 packages

Report per-package status for all 13. Classify any warning as pre-existing only with
`git diff --name-only` / `git log -1 <file>` evidence. Do **not** run `pnpm format:check`
(S-12: it has never passed).

---

## 12. Risks and mitigations

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R-1 | The fix is written as raw interpolation `${input.from}::timestamp(3)` and silently discards a client's `+05:30` offset — trading a session-dependent bug for an offset-dependent one. | **HIGH** | §5.1 with the measured cast behaviour; **T2** is written specifically to fail on this and is a unit test, so it runs everywhere. |
| R-2 | The regression test only encodes this machine and passes vacuously in CI's UTC. | **HIGH** | Every behavioural case pins its own non-UTC session via `options=-c timezone=…`; strategy validated end-to-end in probe 5 (§8). The bare `?timezone=` form is a known silent no-op (§3.7) — the test must use `options=-c`. |
| R-3 | Layer B's `set_config('TimeZone',…,true)` leaks past the transaction on a pooled connection and one request's zone affects the next. | MED | `is_local = true`; verified no leak after `ROLLBACK` (§3.7). **T5** asserts both halves — `UTC` inside, connection default outside. |
| R-4 | The pin is added *before* `set_config('app.tenant_id',…)`, weakening the security-relevant ordering. | MED | Slice 3 states the order explicitly; `.claude/rules/tenant-isolation.md` makes hook/statement ordering a contract. Reviewer check. |
| R-5 | Someone "fixes" the output side too, adding `AT TIME ZONE` to the column and shifting every bucket boundary. | MED | §3.5 gives the direction test; **T6** fails if bucket boundaries move; the corrected comment at `usage.repository.unit.test.ts:180-182` says which side is which. |
| R-6 | `usage.repository.unit.test.ts:109-115` asserts `values[1] === new Date(FROM)` and will fail — read as a regression rather than as a test that pinned the defect. | MED | Called out in §6 and in the Gate-3 record. It is a *required* change, not collateral. |
| R-7 | T-036's uncommitted work is disturbed. | MED | S-18's integration file is self-contained (probe 5 needed nothing from T-036). §2 lists the three files and the plan as not-to-modify. Verify with `git status --porcelain` before and after. |
| R-8 | Cross-package effect: `apps/usage-service/src/repositories/base.repository.ts` is byte-identical in worker/billing/analytics; editing one creates a silent 3-way divergence. | MED | Deliberate and stated (§2, **D-2**). The Gate-3 record must note the divergence so the next reader does not think it is drift. |
| R-9 | Index regression at production scale even though 50 000 rows was fine. | LOW | §3.5 measured with a parameterized cast; **T7** re-records `EXPLAIN` post-fix. Cannot be verified at production scale from here — stated as a limit, not closed. |
| R-10 | Production `postgresql.conf` zone is unknown, so real-world impact cannot be quantified from here. | LOW | Out of reach. The release note should ask the operator for `SHOW timezone` on the production instance and recommend `ALTER DATABASE … SET TimeZone='UTC'` (§5.4), with the caveat that `ALTER ROLE` overrides it. |
| R-11 | The `Decimal(18,6)` normalization is disturbed. | LOW | `toQuantityString` (`usage.repository.ts:71`) is untouched; **T6** asserts `totalQuantity` unchanged and `.claude/rules/testing.md` requires the negative form — *not* an instance of `Prisma.Decimal`. |

### What cannot be verified without infrastructure I do not have

- Production's `postgresql.conf` `TimeZone`, and therefore the real blast radius (R-10).
- Whether any `pg_db_role_setting` entry exists in production that would override a
  database-level pin (§3.7 showed role beats database; live production `pg_db_role_setting` is
  0 rows *here*).
- Behaviour under a real connection pool (PgBouncer is referenced only in
  `docs/epics/epic-3-shared-service-infra.md:133`, port 6432, and is not running here).
- Index behaviour at production row counts (R-9).

---

## 13. Pending task checklist

- [done] **Gate 2 — approval.** Decisions D-1 … D-5 answered. D-1: S-18 first. D-2: pin
      usage-service only. D-5: yes — the rule landed in `CLAUDE.md` § *Raw SQL and timestamps*.
- [done] Slice 0 — red baseline recorded verbatim; falsifications 1 and 2 attacked. **Neither
      falsified** (§16).
- [done] Slice 1 — T1-T6 written in full and **confirmed red** (§16).
- [done] Slice 2 — Layer A: constants + `buildFilters` coercion + comment. T1-T4 green.
- [done] Slice 3 — Layer B: `withTenant` zone pin, tenant statement still first. T5 green, no leak.
- [done] Slice 4 — `docs/development-setup.md`, `CLAUDE.md`, `.claude/rules/tenant-isolation.md`;
      Gate-3 execution record at §16.
- [done] Task-scoped validation green (§11).
- [done] `git status --porcelain` shows T-036's three test files and its plan **unchanged**.
- [done] Gate 4 — Senior Reviewer (pre-QA) → **CONDITIONAL**,
      `docs/reviews/s-018-usage-summary-range-timezone.md`.
- [done] Gate 3 rework — M-1, M-2, M-3 and L-1, L-2, L-4, L-5 dispositioned; each re-derived by
      execution before being accepted. L-3, L-6, L-7, L-8 and N-1…N-6 left per the brief.
      Full 13-package gate re-run with `--force`. Record appended to §16.
- [ ] Gate 4b — Senior Reviewer re-review of the rework.
- [ ] Gate 5 — QA Tester → `docs/qa/`.
- [ ] Gate 6 — Senior Reviewer (final) → `docs/reviews/s-018-usage-summary-range-timezone.md`.
- [ ] Gate 7 — CI validation, 13/13 packages, per-package status reported.
- [ ] Gate 8 — commit approval. One atomic commit: production + tests + this plan + the review.
      Suggested subject: `fix(usage-service): resolve summary range in UTC, not the DB session zone (S-18)`.
- [ ] Hand back to T-036 with §9 items 1-4.

---

## 14. Decisions the user must make before Gate 3

| ID | Decision | Recommendation |
|---|---|---|
| **D-1** | **Sequencing against T-036.** S-18 changes production code that T-036's uncommitted suite asserts against, and T-036's B8 currently encodes the defect. Land S-18 first (self-contained tests), fold S-18 into T-036's commit, or land T-036 first and rewrite B8 afterwards? | **S-18 first, self-contained.** Probe 5 proved the integration test needs nothing from T-036's fixtures. Folding breaks one-atomic-commit-per-task; landing T-036 first commits a test written around a defect being fixed the same week. Cost: one temporary duplicate seeding helper, which T-036 collapses when it lands. |
| **D-2** | **Roll the `withTenant` UTC pin to the other four services?** `worker/billing/analytics` `base.repository.ts:98` are byte-identical to usage-service's, and auth-service has its own `withTenantContext` (`user.repository.ts:234`). None has a date predicate today. Rolling it now prevents a 3-way divergence; not rolling it keeps the commit atomic. | **Do not roll it in S-18 — file it as a follow-up.** This is precisely the split S-8 (out of S-4) and S-10 (out of S-7) already established: do not change other services' data-access behaviour inside one service's defect fix. Accept the divergence, note it in the Gate-3 record so the next reader does not mistake it for drift. If you would rather take the divergence risk than the blast-radius risk, say so and it becomes Slice 3b. Note also that the pin does **not** cover auth-service's resolvers, which run outside tenant context. |
| **D-3** | **Also pin at the connection layer** — `options=-c timezone=UTC` on `DATABASE_URL`, ideally with a `.refine` in each `EnvSchema` so a service without it refuses to start? It is the only option that covers queries *outside* `withTenant`, and it is the strongest "unrepresentable" story available. | **Yes, but as its own task.** ~14 in-repo sites plus deployment config outside this repo, and it changes six services' startup contracts (§5.3). **Include the env-schema guard when you do it** — without it, a missed site fails open and silent, because a bare `?timezone=UTC` is ignored with no error (§3.7). Separately, ask your DBA for `SHOW timezone` and `select * from pg_db_role_setting` on production. |
| **D-4** | **Specify the contract.** `docs/epics/epic-6-usage-service.md:160-182` never states that the interval is half-open or that it is UTC; that contract lives only in code comments (`usage.repository.ts:8-10`, `usage-summary.validator.ts:22`). Epic AC "bucket boundaries are midnight UTC" is still flagged as a **Q3 placeholder**. | **Amend the epic to state `[from, to)` in UTC, and mark Q3 decided as UTC** — which is what the code already does and what §3.3 measured. Do it as a docs edit, not silently inside S-18. Until then S-18 is fixing behaviour that was never specified, which I am escalating rather than inventing (§8). Note S-15: the epic files are already unreliable as a manifest. |
| **D-5** | **Should "ORM date filters are UTC-safe; raw `$queryRaw` date binds are not" become a standing rule** in `.claude/rules/` (tenant-isolation's "Raw SQL" section, or a new entry)? It is the most reusable thing this investigation produced, and the reason the next occurrence will be avoided rather than found. | **Yes** — but `.claude/rules/` is configuration and I will not edit it without your explicit instruction. Recommend a short "Raw SQL and timestamps" subsection stating the measured facts (§3.3, §3.4) and the required form. Say the word and it becomes Slice 4b. |
| **D-6** | **Migrate the columns to `timestamptz` later, or accept `timestamp`-as-UTC as the convention?** §5.2 rejects the migration for now. | **Accept `timestamp`-as-UTC as the documented convention.** Revisit only after D-3 lands, when the connection is pinned and the invariant has tests; the migration is then much less risky. If you do revisit it, the `USING "col" AT TIME ZONE 'UTC'` clause is mandatory on all 20 columns — the bare form silently moves every row by the migration session's offset (§3.5). |

---

## 15. Approval gate statement

**I stopped here for approval. No production code and no tests were written, and no file in the
repository was modified except this plan.**

Verified before ending: `git status --porcelain` still shows exactly the five entries it showed
at the start — `M .claude/rules/known-gaps.md`,
`M docs/plans/t-036-usage-service-integration-tests.md`, and the three untracked
`apps/usage-service/tests/` files — plus this new plan. The database was probed read-only or
inside `BEGIN … ROLLBACK`, and §3.8 records the confirmation that it was left as found.

**What I am asking approval for:** the two-layer fix in §5.5 — coerce the bound parameter at
`apps/usage-service/src/repositories/usage.repository.ts:116` with JS-side UTC normalization,
and pin the session zone inside usage-service's `withTenant` — proven by T1-T6, whose
behavioural cases pin a non-UTC session so they fail on the shipped code on a UTC server too.

**Blocking decisions: D-1 through D-6 in §14.** D-1 (sequencing against T-036), D-2 (scope of
the `withTenant` pin) and D-5 (whether `.claude/rules/` gains a rule) change the diff. D-3, D-4
and D-6 can be answered as "later, separate task" without blocking Slice 2.

Gate 3 (Task Implementer) must not begin until these are answered.

---

## 16. Gate 3 — execution record

**Base `3374cf9`. Server session `TimeZone` here: `Asia/Kolkata`, so the defect was live
locally** (`psql -Atc "show timezone"`).

### Slice 0 — falsifications 1 and 2 attacked, neither falsified

One probe, four session zones pinned with `options=-c timezone=…`, six seeded `UsageLine`
rows, window `[2026-01-01Z, 2026-02-01Z)`:

    node <scratchpad>/probe-falsify.cjs

| Session `TimeZone` | ORM `where:{gte,lt}` in tx | ORM, **outside** `$transaction` | Raw, bound `Date` (shipped) | Raw, normalized + cast |
|---|---|---|---|---|
| `UTC` | `{r2,r3,r4,r5}` | `{r2,r3,r4,r5}` | `{r2,r3,r4,r5}` | `{r2,r3,r4,r5}` |
| `Asia/Kolkata` (+05:30) | `{r2,r3,r4,r5}` | `{r2,r3,r4,r5}` | **`{r4,r5,r6}`** | `{r2,r3,r4,r5}` |
| `America/New_York` (−05:00) | `{r2,r3,r4,r5}` | `{r2,r3,r4,r5}` | **`{r1,r2,r3,r4}`** | `{r2,r3,r4,r5}` |
| `Asia/Kathmandu` (+05:45) | `{r2,r3,r4,r5}` | `{r2,r3,r4,r5}` | **`{r4,r5,r6}`** | `{r2,r3,r4,r5}` |

So **F-2 does not hold**: the ORM path is UTC-stable on a fourth, non-integral offset and
outside an interactive transaction. §3.3's conclusion survives its strongest available
attack. Cleanup verified: `usageLine left=0 tenant left=0`.

`pg_typeof` re-measured in three forms: bound `Date` → `timestamp with time zone`; bound ISO
string → `text`; bound ISO string + `::timestamp(3)` → `timestamp without time zone`.

One finding **not** in the plan, and it improves the fix's safety story: an *uncast* bound
string does not silently misbehave, it raises `42883`, whose message names the operands in the
order they appear in the SQL — for `"periodStart" >= $1` that is
`operator does not exist: timestamp without time zone >= text`. Forgetting the cast is
therefore the loud mistake; only the `Date` is the silent one. Note the loudness comes from
Prisma binding the value as `text`: an *unquoted* SQL literal is `unknown`-typed, coerces, and
raises nothing.

### Slice 1 — confirmed red, per test, with the reason

Unit (`tests/usage.repository.unit.test.ts`), after adding only inert declarations so the
failures were behavioural rather than import errors:

    × binds both range bounds as UTC-naive timestamps, not as timestamptz Dates
      → expected '…WHERE "tenantId" = $1 AND "periodStart" >= $2 AND "periodStart" < $3…'
        to contain '"periodStart" >= $2::timestamp(3)'
    × normalizes an offset-bearing bound to the identical value as its Z equivalent
      → expected 2026-01-01T00:00:00.000Z to be 2026-01-01T00:00:00.000Z
        Received: serializes to the same string        (both bounds were Date objects)
    × pins the session time zone to UTC after setting the tenant id
      → Error: Expected a set_config statement at index 1

Integration (`tests/usage.timezone.integration.test.ts`) — 8 of 16 red, and the UTC legs
green, which is the point:

    × returns exactly the rows in [from, to) under session time zone Asia/Kolkata
      → -"s18.at-from"  +"s18.at-to"          the row at `from` dropped, the row at `to` admitted
    × returns exactly the rows in [from, to) under session time zone America/New_York
      → -"s18.ms-before-to"  +"s18.ms-before-from"      shifted the other way
    × includes the row exactly at from and excludes the row exactly at to under Asia/Kolkata
    × includes the row exactly at from and excludes the row exactly at to under America/New_York
    × returns the identical window for an offset-bearing from/to under Asia/Kolkata
    × returns the identical window for an offset-bearing from/to under America/New_York
    × returns the same window under every session time zone
    × pins TimeZone to UTC inside withTenant without leaking past the transaction
      → expected 'Asia/Kolkata' to be 'UTC'

The no-regression case (**T6**, wide window) was **green before the fix as well as after**,
as §8 requires of it.

### After Layer A, before Layer B

Every behavioural range case green under all three zones; only the `withTenant` pin red. So
Layer A alone does fix the defect, and the two slices are independently revertible as intended.

### T7 — index coverage, recorded not asserted

50 000 rows, `ANALYZE`, `enable_seqscan=off`, parameterized cast, session `Asia/Kolkata`:

    EXPLAIN (COSTS OFF) EXECUTE fixed('t-1','2026-01-05T00:00:00.000Z','2026-01-06T00:00:00.000Z');
    → Aggregate
        ->  Bitmap Heap Scan on explainprobe
              Recheck Cond: (("tenantId" = 't-1') AND ("periodStart" >= (…)::timestamp(3) without time zone)
                             AND ("periodStart" < (…)::timestamp(3) without time zone))
              ->  Bitmap Index Scan on explainprobe_scoped_idx
    EXECUTE fixed(…) → 288       -- one day at this fixture's spacing, so the bounds are right too

Index retained. R-9 stands: not verifiable at production row counts from here.

### Consequence for T-036, not acted on

`pnpm test` runs T-036's untracked `tests/usage.integration.test.ts`, and its **case B8 now
fails** — `-"boundary.below-upper-bound" +"boundary.below-lower-bound"`. This is the
accommodation §9 predicted, not a regression: B8 seeds its probe rows relative to bounds it
obtains from `readEffectiveRangeBounds`, which *re-derives the defect itself* with its own
bound `Date`, so it still reports the shifted bounds after the fix. Every other T-036 case
passes (224/225), because §9's wide `RANGE_FROM`/`RANGE_TO` makes them offset-insensitive.
Fixed by §9 items 1-4 when T-036 resumes; deliberately not touched here.

---

### Gate 3 rework — Gate 4 `CONDITIONAL` dispositions

Second pass over the same working tree; nothing committed. Every claim below names the command
that produced it, and the three MEDIUMs were each re-derived here before being accepted, rather
than taken from the review.

#### M-1 — cast fragment no longer composable from outside the module · **fixed**

The reviewer's refutation reproduced from first principles rather than replayed. The mechanism
is that a text → `timestamp` cast discards an offset, so the fragment applied to an
un-normalized request string is wrong *in every zone including UTC*:

    psql -c "SET TimeZone='UTC';          SELECT '…+05:30'::timestamp(3), '…Z'::timestamp(3), '…-08:00'::timestamp(3);"
      → 2026-01-01 00:00:00 | 2026-01-01 00:00:00 | 2026-01-01 00:00:00
    psql -c "SET TimeZone='Asia/Kolkata'; SELECT '…+05:30'::timestamp(3), '…Z'::timestamp(3);"
      → 2026-01-01 00:00:00 | 2026-01-01 00:00:00

Three distinct instants, one value, and the same value under a second session zone. So the
`export` did re-open the trap §5.1 exists to close.

Fixed on the precedent the reviewer named (`apps/auth-service/src/constants.ts` →
`user.repository.ts`'s `RESOLVER_FUNCTIONS`): `DATABASE_SQL.UTC_NAIVE_TIMESTAMP_CAST` is a
**plain string** in `apps/usage-service/src/constants.ts` — no `@prisma/client` in that import
graph, which was the accepted rationale for the original deviation — and
`usage.repository.ts` wraps it once, module-privately, with `Prisma.raw`. The `export` is gone.
This satisfies §6 as written.

Enforcement verified, not asserted. A throwaway probe module composing the half-fixed shape
from outside was added and typechecked:

    apps/usage-service/tests/m1-export-probe.ts:
      Prisma.sql`WHERE "periodStart" >= ${from}${UTC_NAIVE_TIMESTAMP_CAST}`
    pnpm exec tsc --noEmit -p tsconfig.json
      → tests/m1-export-probe.ts(2,10): error TS2459: Module
        '"../src/repositories/usage.repository"' declares 'UTC_NAIVE_TIMESTAMP_CAST'
        locally, but it is not exported.

Probe deleted after measuring. `grep -rn UTC_NAIVE_TIMESTAMP_CAST --include='*.ts' apps/
packages/` now returns only the constants entry, the module-private `Prisma.raw` binding, its
single use in `utcTimestampBound`, and two doc-comment mentions. The stale `dist/…d.ts`
declaration is gone after `pnpm build --force`.

**The claim, stated to the strength that was tested.** Not "unrepresentable". What holds is:

> The cast fragment is **not importable** outside this module — that much is compiler-enforced
> (`TS2459`) — and `utcTimestampBound` is the only in-module path to it. The half-fixed
> *shape* is still writable anywhere, here or in another file, because the cast is only SQL
> text: `${iso}::timestamp(3)` needs no import. Removing the `export` raised the cost of that
> mistake from one `import` to typing eight characters; it did not make it unreachable. The
> rule "every timestamp bound goes through `utcTimestampBound`" is carried by review, not by
> the type system.

The old comment claimed the first sentence *and* implied the third away. Both the code comment
and this record now say only what the compiler proves plus what review has to carry.

#### M-2 — circular cast assertion replaced with a literal · **fixed, and the fix is mutation-proven**

The reviewer's blindness result reproduced against the **pre-fix** test before changing it, by
mutating `usage.repository.ts:80`:

| `UTC_NAIVE_TIMESTAMP_CAST` | pre-fix unit test |
|---|---|
| `::timestamp(3)` | 23 passed |
| `::timestamptz` | **23 passed** |
| `::timestamp(0)` | **23 passed** |

`tests/usage.repository.unit.test.ts` now asserts the hard literal
`EXPECTED_TIMESTAMP_CAST = "::timestamp(3)"`, deliberately **not** imported from
`src/constants`, plus a negative `not.toContain("::timestamptz")`. A comment at the declaration
answers `.claude/rules/constants.md` head-on: the rule exists to stop one magic value being
restated and drifting, but this assertion's subject *is* the wire format, so the literal is the
specification and deriving it from the code under test is exactly what blinds the test.

Re-mutated after the fix — all three mutants now red, on the test whose title names the failure
mode:

    MUTANT ::timestamptz   → × binds both range bounds as UTC-naive timestamps, not as timestamptz Dates
                              expected '…"periodStart" >= $2::timestamptz…'  to contain '"periodStart" >= $2::timestamp(3)'
                              Tests  1 failed | 22 passed (23)
    MUTANT ::timestamp(0)  → × same test; received '…>= $2::timestamp(0)…'   Tests  1 failed | 22 passed (23)
    MUTANT ::timestamp     → × same test; received '…>= $2::timestamp…'      Tests  1 failed | 22 passed (23)

Why each mutant matters was measured here, not assumed:

    SET TimeZone='UTC';          SELECT '2026-01-31T23:59:59.999Z'::timestamp(0);  → 2026-02-01 00:00:00
    SET TimeZone='Asia/Kolkata'; SELECT '2026-01-31T23:59:59.999Z'::timestamp(0);  → 2026-02-01 00:00:00
      -- and the window test flips: ::timestamp(0) < '2026-02-01' → f ; ::timestamp(3) < '2026-02-01' → t
    SELECT ('2026-01-01T00:00:00.000Z'::timestamptz)::timestamp(3) under UTC / Asia/Kolkata / America/New_York
      → 2026-01-01 00:00:00 | 2026-01-01 05:30:00 | 2025-12-31 19:00:00     -- S-18 restored exactly

#### M-3 — reversed `42883` operands corrected · **fixed, re-measured in four forms**

Re-run rather than accepted. PostgreSQL names the operands **in the order they appear in the
SQL**, so the operand order is a property of the predicate, not of the error:

    psql, column left:   SELECT 1 FROM "UsageLine" WHERE "periodStart" >= '…'::text;
      ERROR:  42883: operator does not exist: timestamp without time zone >= text
    psql, PREPARE:       PREPARE p1(text) AS SELECT 1 FROM "UsageLine" WHERE "periodStart" >= $1;
      ERROR:  42883: operator does not exist: timestamp without time zone >= text
    psql, bound left:    SELECT 1 FROM "UsageLine" WHERE '…'::text <= "periodStart";
      ERROR:  42883: operator does not exist: text <= timestamp without time zone
    psql, PREPARE:       PREPARE p2(text) AS SELECT 1 FROM "UsageLine" WHERE $1 <= "periodStart";
      ERROR:  42883: operator does not exist: text <= timestamp without time zone

    Prisma $queryRaw, column left:  P2010 meta.code "42883"
      "operator does not exist: timestamp without time zone >= text"
    Prisma $queryRaw, bound left:   P2010 meta.code "42883"
      "operator does not exist: text <= timestamp without time zone"

So the reviewer's measurement is right and Slice 0's original quotation above was wrong: this
repository's predicate puts the column on the left, hence
`timestamp without time zone >= text`. Corrected in `CLAUDE.md` and in
`usage.repository.ts`'s `utcTimestampBound` doc block, both of which now also record the
`P2010` / `meta.code` surfacing and the operand-order rule that explains it.

**A qualification the review did not have, found while re-running the probe.** An *unquoted*
SQL literal does **not** raise `42883` — it is `unknown`-typed and coerces silently:

    SELECT 1 FROM "UsageLine" WHERE "periodStart" >= '2026-01-01T00:00:00.000Z';   → (0 rows), no error

The loudness comes from Prisma binding the value as `text`
(`SELECT pg_typeof(${iso})::text` → `text`), not from the cast being absent. Slice 0's
"omitting the cast fails loudly" is therefore true **for this codebase's `$queryRaw` path**
and not as a general statement about PostgreSQL. Both documents now say so.

#### LOWs taken

- **L-1** — `tests/usage.timezone.integration.test.ts` now *asserts* the role its docstring
  claims, mirroring `rls.enforcement.integration.test.ts`: a `pg_roles`/`current_user` read in
  `beforeAll` through one of the `DATABASE_URL`-derived zone clients, and a case
  *"asserts through the runtime role, which is NOSUPERUSER and NOBYPASSRLS"*. Proven
  non-vacuous by pointing the suite at the owner:

      DATABASE_URL=postgresql://postgres:postgres@localhost:5432/telemetry \
        pnpm --filter @telemetry/usage-service exec vitest run tests/usage.timezone.integration.test.ts
      → × asserts through the runtime role, which is NOSUPERUSER and NOBYPASSRLS
        AssertionError: role postgres is a superuser: expected true to be false
        Tests  1 failed | 16 passed (17)

  The docstring also now records *why* the assertion is there and that the zone conclusions
  would hold as any role — the suite states the role as a property of itself, so it proves it.
- **L-2** — `tests/rls.enforcement.integration.test.ts` drops its local
  `APP_TENANT_ID_SETTING` and imports `DATABASE_SESSION_SETTINGS.TENANT_ID` (4 call sites).
  Authorised by the rework brief despite being outside §6's file list. Still **7/7**.
- **L-4** — `CLAUDE.md`'s ORM bullet no longer states the mechanism as fact. It now reports
  what execution established (UTC-stable across four zones, inside and outside `$transaction`,
  with the logged bound already UTC-normalized) and marks the *why* as inference, with an
  explicit "do not restate the mechanism as fact". The same sentence in
  `usage.repository.ts`'s doc block had the identical unhedged wording and was softened with
  it — reported as a deviation below.
- **L-5** — `.claude/rules/tenant-isolation.md` layer-4 rationale rewritten to the actual
  invariant: *"no statement against a tenant-scoped table may precede the RLS context, and a
  later addition inside `withTenant` must not displace it."* The old clause described a caller
  that does not exist inside `withTenant`.

#### LOWs and NITs left, per the brief

L-3 (duplicated `requireEnv` / `ADMIN_URL_FALLBACK` → wants a shared `tests/integration.env.ts`,
and must coordinate with T-036), L-6 (extra round trip per `withTenant`; accepted by the
reviewer), L-7 (`utcTimestampBound`'s `RangeError` is unreachable through HTTP), L-8
(`DATABASE_SESSION_SETTINGS` mixes GUC names with a value), and N-1 through N-6.

#### Validation — full 13-package gate, `--force`

    pnpm build     --force  → Tasks: 13 successful, 13 total   (0 cached)
    pnpm typecheck --force  → Tasks: 13 successful, 13 total   (0 cached)
    pnpm lint      --force  → Tasks: 13 successful, 13 total   (0 cached), 14 warnings
                              (4 usage-service/tests/ingestion.service.unit.test.ts +
                               10 auth-service/tests/auth.service.unit.test.ts;
                               both files pre-existing and unmodified by this change)
    pnpm test      --force --continue
                            → Tasks: 12 successful, 13 total
                              Failed: @telemetry/usage-service#test

The 4 lint warnings are all `no-unsafe-assignment` in
`apps/usage-service/tests/ingestion.service.unit.test.ts:339,340,543,544` — a file this change
does not touch (`git diff --name-only` empty for it; `git log -1` → `b0f6921`, two commits
back).

`pnpm test` red on **T-036's case B8 only**, and the attribution is proven by exclusion rather
than asserted:

    pnpm --filter @telemetry/usage-service exec vitest run --exclude 'tests/usage.integration.test.ts'
      → Test Files  18 passed (18)
             Tests  199 passed (199)

199, not the 198 the brief predicted, and the difference is accounted for exactly: the L-1 role
case took `usage.timezone.integration.test.ts` from 16 to 17. Whole-suite figure
`1 failed | 225 passed (226)`; the single failure is `usage.integration.test.ts:806` B8,
unchanged in shape from the first Gate 3 pass.

Every other package: gateway 38/38, auth-service 164/164, worker 19/19, billing 18/18,
analytics 18/18, and all six shared packages green.

`pnpm format:check` fails on **260 files repo-wide** and is not in `CLAUDE.md`'s CI gate list.
Pre-existing, and shown to be so for the specific files this change touches: the `HEAD:` version
of each of `apps/usage-service/src/constants.ts`, `usage.repository.ts`,
`rls.enforcement.integration.test.ts`, `usage.repository.unit.test.ts`, `CLAUDE.md` and
`.claude/rules/tenant-isolation.md` was extracted with `git show` and checked — all six were
**already** flagged before S-18 touched them. No file that was clean became dirty.

#### Deviations in this rework

1. **`usage.repository.ts`'s ORM sentence softened alongside `CLAUDE.md`'s (L-4).** The brief
   scoped L-4 to `CLAUDE.md`, but the repository doc block carried the identical unhedged
   sentence — "the engine knows the column type from the schema" — and it was introduced by this
   same change. Hedging one and leaving the other would have left the unverified generalisation
   in the source, which is where a future implementer will read it.
2. **A third mutant (`::timestamp`) was added to the M-2 matrix.** The brief asked for
   `::timestamptz` and `::timestamp(0)`; the review's table also listed bare `::timestamp` as
   passing, so it was included. It is now red too.
3. **`constants.ts`'s new `DATABASE_SQL` doc block records the precision rationale**
   (why `(3)` and not `(0)` or `timestamptz`), with the measurements above. Not requested;
   it is where the next reader will look before changing the value, and M-2 exists because
   that value's correctness was previously undocumented and untested.

#### Constraints honoured

`tests/usage.integration.test.ts`, `tests/integration.constants.ts`,
`tests/integration.fixtures.ts`, `.claude/rules/known-gaps.md` and
`docs/plans/t-036-usage-service-integration-tests.md` were **not** opened for edit in this
rework; `git status --porcelain` shows them exactly as T-036 left them. No commit, no staging,
no branch, no push. `docs/reviews/s-018-usage-summary-range-timezone.md` was read and not
modified.
