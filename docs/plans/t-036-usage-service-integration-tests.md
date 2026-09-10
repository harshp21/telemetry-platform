# T-036 Implementation Plan: Usage Service Integration Tests

Plan file path: docs/plans/t-036-usage-service-integration-tests.md

Task spec: [docs/epics/epic-6-usage-service.md](../epics/epic-6-usage-service.md) lines 186-199
Target file: `apps/usage-service/tests/usage.integration.test.ts`
Milestone: v1

---

> **REVISION 2 — read this first.** Sections 1-12 below were written at an earlier commit and were
> never approved. The repository has moved: commits `b0f6921` (S-1…S-4) and `1b872b3` (S-7)
> changed the database role model, the dedup keyspace, and added a mandatory
> `X-Internal-Secret` guard on every non-`/health` usage-service route.
>
> **Sections 13-23 are the current plan.** They are a delta, not a rewrite: Sections 1-3, 4.4,
> 4.5, 5 (controlling code paths), 7 and 10 survive re-verification and are carried forward.
> Sections 4.1, 4.3, 4.6, 4.7, 8, 9 and 12 are **superseded** — Section 14 lists each stale claim
> with the evidence that retired it.
>
> **Section 12's approval gate is void. Section 23 is the live gate.**
> Base commit for revision 2: `3374cf9`, clean tree.


## 1) Business Context

### Objective
Prove the usage-service HTTP contracts end-to-end against **real infrastructure** — a migrated
Postgres 16 database and a real Redis instance — rather than against mocks. Every usage-service test
shipped so far (T-030 through T-035) stubs Prisma, stubs Redis, or stubs the service layer. That
means the assertions currently encode what the author *believed* the database and the Redis driver
would do, not what they actually do.

### User impact
- Billing- and reporting-adjacent numbers become trustworthy: `SUM(Decimal(18,6))` is proven to
  cross the API boundary without float rounding, so a tenant's invoiced usage cannot silently drift.
- Bucket boundaries (`DATE_TRUNC`) are proven against a live Postgres instead of asserted against a
  mock's return value, so a "usage per day" chart is proven to mean midnight-UTC days.
- Tenant isolation is proven at the **database** layer, not only the application layer. Today the
  repository's `WHERE "tenantId" = $1` predicate would mask a completely broken RLS policy — the
  T-035 review flagged this as unverifiable without a live DB. T-036 is where it becomes verifiable.
- Deduplication is proven to actually deduplicate. `duplicate: 5` on replay is a property of Redis
  `SET NX EX`; a mocked Redis proves only that the mock was configured to return `null`.

### Why now
T-035 shipped the last v1 usage-service endpoint. Both halves of the service (ingest + summary) now
exist, so an integration suite can exercise the whole surface in one file, as the epic specifies.

---

## 2) Scope And Non-Goals

### In scope
- One new integration suite: `apps/usage-service/tests/usage.integration.test.ts`.
- Integration test harness: an isolated test database, an isolated Redis logical DB, deterministic
  seed/reset helpers, and a restricted (non-`BYPASSRLS`) Postgres role used solely to prove RLS.
- A separate Vitest project/config so integration tests do not slow or destabilise the unit run.
- CI wiring so the suite runs on every push/PR, not just on one laptop.
- The seven epic test cases, plus the ground-truth cases the T-035 review could not verify
  (Decimal precision, `DATE_TRUNC` output, DB-layer RLS).

### Out of scope (explicit non-goals)
- **Any change to `apps/usage-service/src/**`.** T-036 is a test task. Section 8 lists four
  production defects this investigation surfaced; each is documented with a proposed follow-up task
  and is **not** fixed here. Fixing them inside a test task would make the suite validate a moving
  target and would violate the one-slice rule in `.github/copilot-instructions.md`.
- Changing the epic's stated expectations. Section 7 lists three places where the epic's test list
  disagrees with the shipped implementation; the plan tests the **implementation** and escalates the
  discrepancies for a user ruling rather than silently picking a side.
- Migrating `apps/auth-service/tests/*.integration.test.ts` out of the default `pnpm test` glob
  (a pre-existing coupling; see Section 9 risk R-7).
- Load/performance testing. A query-plan check is included but is deliberately scoped and
  honestly caveated (Section 5, slice 9).
- The Epic 7 rollup worker that will eventually populate `UsageLine`.

---

## 3) Files To Change (Expected)

### New files
| Path | Purpose |
| --- | --- |
| `apps/usage-service/tests/usage.integration.test.ts` | The suite itself (the epic's named target file) |
| `apps/usage-service/tests/helpers/integration.constants.ts` | Test-scoped constants — DB/Redis URLs, role name, tenant ids, fixture metric keys. No magic strings in the suite body (reviewer standard). |
| `apps/usage-service/tests/helpers/integration.db.ts` | Migrated-DB bootstrap, FK-safe reset, `Tenant`/`Event`/`UsageLine` seed builders, restricted-role bootstrap |
| `apps/usage-service/tests/helpers/integration.redis.ts` | Isolated Redis logical-DB client, targeted key cleanup |
| `apps/usage-service/vitest.integration.config.mjs` | Integration project: longer timeouts, `fileParallelism: false`, no coverage thresholds |
| `docker/docker-compose.test.yml` | Postgres 16 + Redis 7 with **published** host ports, for contributors who have no native Postgres/Redis |

### Existing files modified
| Path | Change |
| --- | --- |
| `apps/usage-service/vitest.config.mjs` | `exclude: ["tests/**/*.integration.test.ts"]` so the unit run stays hermetic |
| `apps/usage-service/package.json` | add `"test:integration": "vitest run -c vitest.integration.config.mjs"` |
| `turbo.json` | add a `test:integration` task (`cache: false`, `dependsOn: ["^build"]`) |
| `package.json` (root) | add `"test:integration": "turbo run test:integration"` |
| `.github/workflows/ci.yml` | create + migrate the `telemetry_usage_test` database; add a `Usage Integration Tests` step after `Unit Tests` |
| `apps/usage-service/.env.example` | document `USAGE_TEST_DATABASE_URL`, `USAGE_TEST_REDIS_URL`, `USAGE_TEST_DB_ROLE_PASSWORD` |

### Files deliberately NOT modified
`apps/usage-service/src/**`, `prisma/schema.prisma`, `prisma/migrations/**`, `docker/docker-compose.yml`.

---

## 4) Test Infrastructure Decision (the central question)

### 4.1 What the environment actually provides — verified, not assumed

| Fact | Evidence |
| --- | --- |
| A native Postgres 16 listens on `127.0.0.1:5432` with the `telemetry` database migrated (`UsageLine` present, `numeric(18,6)`, `timestamp(3) without time zone`) | `psql -h 127.0.0.1 -U postgres -d telemetry` probe |
| A native Redis answers `PONG` on `127.0.0.1:6379` | `redis-cli ping` |
| The `postgres-db` **container** is from an unrelated workspace: it publishes no host port and holds `multitenant_auth` / `supertokens` / `tenant_management`, not `telemetry` | `docker inspect postgres-db` → `{"5432/tcp":[]}`; `\l` |
| `docker/docker-compose.yml` **has** a `redis: redis:7-alpine` service (ingestion's Redis Streams target) but publishes **no** host ports for either `postgres` or `redis` | `docker/docker-compose.yml` |
| CI already provisions `postgres:16-alpine` on `5432:5432` and `redis:7-alpine` on `6379:6379` as GitHub Actions `services`, and already runs `prisma migrate deploy` before `pnpm test` | `.github/workflows/ci.yml` |
| Integration tests against a live DB are already established precedent in this repo | `apps/auth-service/tests/auth.integration.test.ts`, `apps/auth-service/tests/rls.integration.test.ts` |
| `UsageLine` currently holds **0 rows** and **nothing in the repo writes it** — `grep -rn "UsageLine" apps/ packages/` returns only the two raw-SQL strings in `usage.repository.ts` | verified; the Epic 7 worker does not exist |

### 4.2 Recommendation

**Real Postgres + real Redis, reached over `localhost`, in a dedicated `telemetry_usage_test`
database and a dedicated Redis logical DB (index 15), reset in FK-safe order between tests,
with a second restricted Postgres role used only for the RLS assertions.**

Concretely:
- `USAGE_TEST_DATABASE_URL`, defaulting to `postgresql://postgres:postgres@localhost:5432/telemetry_usage_test`.
- `USAGE_TEST_REDIS_URL`, defaulting to `redis://localhost:6379/15`.
- `REDIS_STREAM_NAME` overridden per run to `telemetry:events:test:<runId>` so stream writes never
  mix with any other consumer.
- Schema created once per run via `prisma migrate deploy` against `USAGE_TEST_DATABASE_URL`
  (a script step, not something the test process shells out to).

### 4.3 Why a *dedicated* database and not the shared `telemetry` one

This is the decision with the sharpest failure mode, so the reasoning is explicit.

`turbo run test` has `"test": { "dependsOn": ["^test"] }`. `@telemetry/auth-service` and
`@telemetry/usage-service` are siblings with no dependency between them, so **turbo runs their test
tasks concurrently**. And `apps/auth-service/tests/auth.integration.test.ts:117-119` resets state
with three **unscoped** deletes:

```ts
await getPrisma().refreshToken.deleteMany();
await getPrisma().user.deleteMany();
await getPrisma().tenant.deleteMany();
```

`tenant.deleteMany()` with no `where` targets every tenant row in the database. Our fixtures are
`Tenant → Event → UsageLine`, a required FK chain (`UsageLine.eventId` is a non-null unique FK to
`Event`; `Event.tenantId` is a non-null FK to `Tenant`). So sharing the `telemetry` database creates
a two-way flake generator: their `beforeEach` deletes our tenants (or, more likely, **fails with a
foreign-key violation and breaks the auth suite**), and our seeds appear and vanish mid-run.

Scoping *our* deletes to our own generated UUIDs — which we will do anyway — does not fix this,
because the destructive statement is in *their* suite, and changing their suite is out of scope.
A dedicated database removes the entire class of interference for the cost of one `createdb` and one
`migrate deploy` in CI.

### 4.4 Alternatives considered and rejected

| Option | Rejected because |
| --- | --- |
| **Testcontainers** | Not a dependency in any `package.json` today. Adds a Docker-daemon requirement to CI, ~10-20s of container startup per run, and a new supply-chain surface — all to re-provide infrastructure that `.github/workflows/ci.yml` already provisions for free via GitHub Actions `services`. Unjustified for a single test file. |
| **Transactional rollback per test** | Structurally impossible here. The code under test opens its *own* transaction: `TenantScopedRepository.withTenant()` (`base.repository.ts:94`) calls `this.prisma.$transaction(...)` and issues `set_config('app.tenant_id', …, true)` with `is_local = true`. Wrapping the suite in an outer transaction changes what "local to the transaction" means, which is precisely the mechanism under test. Separately, the ingestion half writes to Redis, which no SQL rollback can undo. |
| **`TRUNCATE … CASCADE` between tests** | Works, but `CASCADE` across the FK graph is a blunt instrument in a database that other suites might one day share, and it resets sequences we do not own. Row-scoped `deleteMany` in FK-safe order is equally deterministic at fixture scale (tens to low thousands of rows) and fails loudly rather than silently widening. Kept as a documented fallback if reset time becomes a problem. |
| **Sharing the `telemetry` database** | See 4.3. |
| **`FLUSHALL` on Redis** | The compose Redis is shared by six services, and — because of defect D-2 (Section 8) — dedup keys are written **unprefixed** into the root keyspace. `FLUSHALL` on a developer machine could destroy unrelated state. A dedicated logical DB with `FLUSHDB` is bounded and safe. |
| **Mocking Redis and keeping the ingest half unit-level** | Would make the epic's headline case vacuous. `duplicate: 5` is entirely a property of `redis.set(key, "1", "EX", ttl, "NX")` returning `null` on the second call (`deduplication.service.ts:33-49`). Against a mock, that assertion tests the mock's configuration. `StreamPublisher` also fail-closes and throws on a broken connection (`stream.publisher.ts:91-105`), so a fake Redis would turn a `202` into a `500` and hide it. Real Redis, always, in this suite. |

### 4.5 Redis: real, isolated, and cleaned — with a subtlety

Using real Redis introduces one hazard the epic does not mention. Dedup keys carry a **24-hour TTL**
(`DEDUP_CONSTANTS.KEY_TTL_SECONDS = 86400`, `constants.ts:61`). If the suite used fixed idempotency
keys, the *first* run would report `accepted: 5, duplicate: 0` and every re-run within 24 hours would
report `accepted: 0, duplicate: 5` on the *first* batch — a test that passes once and then fails all
day. Two mitigations, both applied:

1. Every fixture idempotency key is prefixed with a per-run `randomUUID()`.
2. `beforeEach` issues `FLUSHDB` against the dedicated logical DB (index 15), which is bounded to
   keys this suite created.

### 4.6 RLS: why the obvious test would prove nothing

`prisma/migrations/v1_0_initial_tenant_usage_rls/migration.sql:179` creates
`usage_line_tenant_isolation` (`USING`/`WITH CHECK` on `"tenantId" = current_setting('app.tenant_id', true)`),
and `v1_2_force_row_level_security/migration.sql:9` adds `FORCE ROW LEVEL SECURITY`. Verified live:
`relrowsecurity = t`, `relforcerowsecurity = t` on `Tenant`, `Event`, and `UsageLine`.

**But the application connects as `postgres`, which is `rolsuper = t` and `rolbypassrls = t`
(verified via `pg_roles`). Superusers and `BYPASSRLS` roles bypass RLS unconditionally.
`FORCE ROW LEVEL SECURITY` does *not* stop them — it only removes the *table owner's* exemption.**
So as the service is configured today, RLS is inert.

Two things follow, and the plan must be precise about both:

**(a) Seeding is easy, and that is not a virtue.** Because the seed connection is a superuser,
`prisma.usageLine.createMany(...)` will insert cross-tenant fixture rows with no `set_config` and no
policy friction. The seed helper will use the privileged client directly and will **document in a
comment** that it works only because the role bypasses RLS — so nobody later mistakes seeding
success for evidence that the policies permit it.

**(b) The defence-in-depth test needs a second connection.** The suite will, in `beforeAll`,
idempotently create a login role that is explicitly `NOSUPERUSER NOBYPASSRLS`:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telemetry_rls_probe') THEN
    CREATE ROLE telemetry_rls_probe LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO telemetry_rls_probe;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO telemetry_rls_probe;
```

then open a second `PrismaClient` pointed at that role and assert, with **no application `WHERE`
clause at all** (raw `SELECT * FROM "UsageLine"`), that:

- inside a transaction with `set_config('app.tenant_id', tenantA, true)` → only tenant A rows,
- inside a transaction with `set_config('app.tenant_id', tenantB, true)` → only tenant B rows,
- with **no** `set_config` → **zero** rows (the policy compares against
  `current_setting('app.tenant_id', true)`, which is `NULL` when unset; `"tenantId" = NULL` is `NULL`,
  not `true`, so every row is filtered).

This is the assertion the app-layer `WHERE "tenantId" = $1` in `usage.repository.ts:116` currently
masks. If role creation fails, the test **fails loudly with a diagnostic message** — it must not
`return` early. Contrast `apps/auth-service/tests/rls.integration.test.ts:79,97,110`, where all three
substantive assertions are short-circuited by `if (isCurrentUserSuperuser) return;`. In CI, where the
connection *is* a superuser, those three tests are silent no-ops and the suite's only surviving
assertion is that `pg_policies` has a row. We must not repeat that pattern.

The restricted role is created by the **test harness**, not by a migration. Introducing a real
least-privilege application role is an infrastructure change with production consequences and belongs
in its own task (follow-up F-1, Section 8).

### 4.7 Vitest configuration and where the suite sits in the gate

`apps/usage-service/vitest.config.mjs` today is `include: ["tests/**/*.test.ts"]` with 80% coverage
thresholds (inert — `"test": "vitest run"` passes no `--coverage`). Recommended split:

- **Default project** (`vitest.config.mjs`): add `exclude: ["tests/**/*.integration.test.ts"]`. Unit
  tests stay fast, parallel, hermetic, and runnable with no Docker and no database.
- **Integration project** (`vitest.integration.config.mjs`): `include: ["tests/**/*.integration.test.ts"]`,
  `fileParallelism: false`, `testTimeout: 30_000`, `hookTimeout: 60_000`, no coverage. The suite body
  additionally uses `describe.sequential` (matching `auth.integration.test.ts:62`) so cases within
  the file cannot interleave against shared rows.
- **A separate `pnpm test:integration` script is warranted**, for three reasons: the suite needs a
  migrated database that `pnpm test` does not currently guarantee; it needs ~30s timeouts that would
  mask hangs in unit tests; and it must run single-threaded, which would halve unit-suite throughput
  if applied globally.
- **It must NOT be silently outside the gate.** `pnpm test:integration` is added to CI as its own
  step *and* to this plan's full-gate command list (Section 6). Keeping it out of `pnpm test` is a
  deliberate ergonomics choice for contributors without infrastructure — not an excuse to skip it.

---

## 5) Step-By-Step Implementation Plan (Smallest Safe Slices)

### Controlling code paths

**Ingest:** `POST /v1/usage/events` → `app.ts:39` `registerEventsRoutes` → `usageTenantContextHandler`
(`tenant-context.middleware.ts:15`, requires `X-Tenant-Id`) → `EventsController.handle`
(`events.controller.ts:32`: Zod batch parse → tenant presence → clock-skew guard → service) →
`IngestionService.ingestEvents` (`ingestion.service.ts:55`: per-event quantity + skew re-check →
idempotency key → `DeduplicationService.isNew` → `StreamPublisher.publish`) → Redis.

**Summary:** `GET /v1/usage/summary` → `usage.routes.ts:15` → same tenant middleware →
`UsageController.handle` (`usage.controller.ts:25`) → `UsageService.getUsageSummary`
(`usage.service.ts:28`) → `usageRepositoryFactory(tenantId)` (`container.ts:58`) →
`UsageRepository.aggregateSummary` (`usage.repository.ts:82`) → `withTenant` transaction →
two `$queryRaw` calls → Postgres.

### Local hypothesis (falsifiable)

> If the usage-service is exercised over HTTP against a migrated Postgres and a real Redis, then
> (i) both endpoints honour their published contracts end-to-end, (ii) `DATE_TRUNC` over
> `timestamp(3) without time zone` yields midnight-UTC day buckets and Monday-start ISO week buckets,
> (iii) `SUM(numeric(18,6))` reaches the JSON response as an exact decimal string with no float
> round-trip, and (iv) the `usage_line_tenant_isolation` policy — not just the repository's `WHERE`
> clause — blocks cross-tenant reads.

**This is falsified if any of the following is observed:**

- **F1 (Decimal)** — Seeded quantities summing to exactly `999999999999.999999` return a
  `totalQuantity` that is not that string (e.g. `"1000000000000"`, `"999999999999.99998"`, or
  anything in exponential notation). That would mean `$queryRaw` decodes `numeric` as a JS float and
  `toQuantityString`'s `String(value)` (`usage.repository.ts:72`) is laundering a lossy value into a
  clean-looking string — a failure mode invisible to every existing unit test, because those feed
  hand-constructed `Prisma.Decimal`s and strings.
- **F2 (Day bucket)** — A row at `2026-01-01T12:00:00.000Z` under `granularity=day` returns a
  `bucketStart` other than `2026-01-01T00:00:00.000Z`. A non-UTC value would mean
  `toIsoString(new Date(value))` (`usage.repository.ts:69`) is re-interpreting a
  `timestamp without time zone` through the process's local timezone.
- **F3 (Week bucket)** — Thursday `2026-01-01` under `granularity=week` returns a `bucketStart` other
  than `2025-12-29T00:00:00.000Z` (Monday). Pre-verified in live Postgres:
  `date_trunc('week','2026-01-01T12:00:00'::timestamp(3))` → `2025-12-29 00:00:00`.
- **F4 (RLS)** — The `NOBYPASSRLS` probe role, with `app.tenant_id` set to tenant A and **no**
  application `WHERE` clause, returns any tenant B row; or, with `app.tenant_id` unset, returns any
  row at all.
- **F5 (Dedup)** — Replaying a byte-identical batch returns `duplicate` other than the batch size.
- **F6 (Cross-tenant HTTP)** — `X-Tenant-Id: A` returns any row belonging to tenant B, or a `total`
  that counts tenant B's grouped rows.

### Slices

**Slice 0 — Prerequisites (no code).**
Confirm `pnpm prisma:generate:auth` has been run so `@prisma/client` exposes the typed
`usageLine` / `event` / `tenant` delegates. Under pnpm both services symlink the *same*
`node_modules/.pnpm/@prisma+client@…` directory, so generating once for auth-service is sufficient —
but `pnpm --filter @telemetry/usage-service test:integration` does **not** trigger the root `pretest`
hook, so generation must be an explicit step in the runbook and in CI. Verify
`node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client` exists before writing a line of
test code. (At the time of planning it did **not** — a clean checkout has no generated client.)

**Slice 1 — Test constants module.**
`tests/helpers/integration.constants.ts`: DB/Redis URL env keys and defaults, probe-role name and
password env key, fixture metric keys (`api.request`, `storage.gb`), fixture tenant-id factory,
the precision-probe quantity `999999999999.999999`, and fixed fixture instants
(`2026-01-01T00:00:00.000Z`, `2026-01-01T12:00:00.000Z`, `2026-01-01T23:59:59.999Z`,
`2026-01-02T00:00:00.000Z`, `2026-01-05T00:00:00.000Z`). Reviewer standards forbid magic strings and
numbers; route paths, header names, status codes, and error codes come from
`apps/usage-service/src/constants.ts` and `src/validators/events.validator.ts`, never re-typed.

**Slice 2 — DB harness.**
`tests/helpers/integration.db.ts`:
- privileged `PrismaClient` bound to `USAGE_TEST_DATABASE_URL`;
- `assertSchemaReady()` — a fail-fast preflight that queries `information_schema` for `UsageLine` and
  raises a message naming the exact `prisma migrate deploy` command if the DB is unmigrated
  (avoids a wall of opaque P2021 errors);
- `resetUsageState(tenantIds)` — deletes in FK-safe order `usageLine → event → tenant`, **always
  scoped by tenant id**, never a bare `deleteMany()`;
- `seedUsageLines(spec[])` — creates the `Tenant`, then one `Event` per line (globally unique
  `idempotencyKey`), then the `UsageLine` with `quantity`, `periodStart`, `periodEnd`, `metricKey`;
- `ensureRlsProbeRole()` — the idempotent `DO $$ … CREATE ROLE … NOSUPERUSER NOBYPASSRLS` + `GRANT`
  block from 4.6, plus a second `PrismaClient` bound to that role.

**Slice 3 — Redis harness.**
`tests/helpers/integration.redis.ts`: ioredis client on `USAGE_TEST_REDIS_URL` (logical DB 15),
`flushIsolatedDb()`, and `readStreamEntries(streamName)` for asserting `XADD` actually landed.

**Slice 4 — Suite skeleton (tests-first, per `docs/task-implementer-workflow.md`).**
`usage.integration.test.ts` with `describe.sequential`, `beforeAll` (env override → dynamic
`import("../src/app")` **after** env is applied, mirroring `auth.integration.test.ts:158-165` →
`assertSchemaReady` → `ensureRlsProbeRole`), `beforeEach` (`resetUsageState` + `flushIsolatedDb`),
`afterAll` (`app.close()`, both Prisma disconnects, Redis quit). All `it` bodies are `expect.fail`
placeholders. **Run it and confirm every case fails** before writing any assertion.

**Slice 5 — Ingest cases.** Epic cases 1-4 plus the corrections in Section 7.

**Slice 6 — Summary cases.** Epic cases 5-7 plus bucket-boundary and inclusivity cases.

**Slice 7 — Decimal precision cases.** F1.

**Slice 8 — Tenant isolation cases.** App layer (F6) and DB layer / RLS probe (F4).

**Slice 9 — Query-plan diagnostic (optional, honestly caveated).**
An `EXPLAIN` assertion over five fixture rows proves nothing — the planner will choose a Seq Scan on
a tiny table regardless of indexing, so such a test would be theatre. To make it meaningful the slice
seeds ~2,000 `UsageLine` rows across two tenants via two `createMany` calls, runs `ANALYZE "UsageLine"`,
then `EXPLAIN (FORMAT JSON)` on the paginated query and asserts the plan reaches `UsageLine` through
the `tenantId, periodStart, periodEnd` index rather than a full scan. It also **records** — without
asserting — that `metricKey` has no supporting index (`schema.prisma` declares only
`@@index([tenantId, periodStart, periodEnd])` and `@@index([tenantId, billed])`), which is the
grouping and filtering column. If this proves flaky across Postgres minor versions or CI row-count
estimates, it is downgraded to a logged diagnostic rather than deleted, and the indexing question
becomes follow-up F-4. This slice is the first thing cut if the suite's runtime becomes a problem.

**Slice 10 — Config, scripts, CI, compose, `.env.example`.** Section 3's modified-files table.

**Slice 11 — Validation.** Section 6, task-scoped first, then full gate.

---

## 6) Test Plan (Explicit Acceptance Coverage Mapping)

Response envelopes below are the **real** ones, read from the controllers — not the epic's shorthand.
Ingest returns `202 { data: { accepted, duplicate, rejected } }` (`events.controller.ts:90-92`);
summary returns `200 { data: { items, total, page, pageSize } }` (`usage.controller.ts:49`).

### A. Ingestion (`POST /v1/usage/events`)

| # | Case | Expected | Epic case | Falsifies |
| --- | --- | --- | --- | --- |
| A1 | Batch of 5 events, each with a **distinct explicit** `idempotencyKey`, `occurredAt = now` | `202`, `data = { accepted: 5, duplicate: 0, rejected: 0 }`; 5 entries present on the run's Redis stream | 1 | — |
| A2 | Replay the byte-identical A1 payload | `202`, `data = { accepted: 0, duplicate: 5, rejected: 0 }`; stream length unchanged at 5 | 2 | F5 |
| A3 | Batch of **101** events | `400`, `code = BATCH_TOO_LARGE` | 3 | — |
| A4 | Batch of exactly 100 events | `202` (boundary is inclusive: `.max(100)`) | — | — |
| A5 | `occurredAt` 24h in the future | `400`, `code = FUTURE_CLOCK_SKEW` — **not** `VALIDATION_ERROR`; see Section 7.2 | 4 (corrected) | — |
| A6 | `occurredAt` 6 minutes in the future | `400`, `code = FUTURE_CLOCK_SKEW` — proves the real threshold is 5 min, not 24h | 4 (corrected) | — |
| A7 | `occurredAt` = `"not-a-date"` | `400`, `code = VALIDATION_ERROR` — the only path that actually yields the epic's stated code | 4 (corrected) | — |
| A8 | `occurredAt` 6 minutes in the **past** | `400`, `code = FUTURE_CLOCK_SKEW` — documents that `Math.abs` makes the window symmetric and backfill impossible (Section 8, D-3) | — | — |
| A9 | Five events sharing `eventType` + `occurredAt` with **no** `idempotencyKey` | `202`, `data = { accepted: 1, duplicate: 4, rejected: 0 }` — pins the derived-key collapse described in Section 7.4 | — | — |
| A10 | Missing `X-Tenant-Id` | `401`, `code = TENANT_CONTEXT_MISSING` (via `registerGlobalErrorHandler`) | — | — |
| A11 | Two tenants send batches with identical `idempotencyKey` values | Both `202 accepted` for the first tenant only; the second is `duplicate` — dedup keys are **not** tenant-namespaced when a client supplies its own key (Section 8, D-2). Asserts current behaviour and pins the defect. | — | — |

### B. Summary (`GET /v1/usage/summary`)

| # | Case | Expected | Epic case | Falsifies |
| --- | --- | --- | --- | --- |
| B1 | Seed 3 lines across 2 days, one `metricKey`, `granularity=day` | 2 items, correct per-bucket `totalQuantity`, `total = 2` | 5 | — |
| B2 | Seed 2 metric keys, query with `metricKey=api.request` | only `api.request` items; `total` counts only its grouped rows | 6 | — |
| B3 | Query a range with no seeded rows | `200`, `data = { items: [], total: 0, page: 1, pageSize: 20 }` | 7 | — |
| B4 | Row at `2026-01-01T00:00:00.000Z` + row at `2026-01-01T23:59:59.999Z`, `granularity=day` | one bucket, `bucketStart = 2026-01-01T00:00:00.000Z`, `bucketEnd = 2026-01-02T00:00:00.000Z` | — | F2 |
| B5 | Add a row at `2026-01-02T00:00:00.000Z` | a **second** bucket — proves the right edge is exclusive | — | F2 |
| B6 | Thu `2026-01-01` + Mon `2026-01-05`, `granularity=week` | two buckets: `2025-12-29T00:00:00.000Z` and `2026-01-05T00:00:00.000Z` (Monday-start, ISO) | — | F3 |
| B7 | `granularity=hour`, rows at `T00:59:59.999Z` and `T01:00:00.000Z` | two buckets, one hour apart | — | F2 |
| B8 | Row exactly at `from`, row exactly at `to` | the `from` row included, the `to` row excluded (`>= from AND < to`, `usage.repository.ts:116`) | — | — |
| B9 | Seed 3 buckets, request `pageSize=2&page=2` | 1 item; `total = 3` (grouped rows, not raw lines); `page`/`pageSize` echoed | — | — |
| B10 | `pageSize=101` | `400 VALIDATION_ERROR` (rejected, not clamped) | — | — |
| B11 | `from >= to` | `400 VALIDATION_ERROR`, message `from must be earlier than to` | — | — |
| B12 | Missing `X-Tenant-Id` | `401 TENANT_CONTEXT_MISSING` | — | — |

### C. Decimal precision (the T-035 review's unverifiable claim)

| # | Case | Expected | Falsifies |
| --- | --- | --- | --- |
| C1 | Two lines in one bucket summing to exactly `999999999999.999999` (the maximum representable `Decimal(18,6)`; a float64 round-trip cannot hold 18 significant digits) | `totalQuantity` is a **string** equal to `"999999999999.999999"` | F1 |
| C2 | Lines of `0.100000` and `0.200000` | `totalQuantity` numerically equals `0.3` and its string form contains no `0.30000000000000004`. Live Postgres pre-verified: `SUM(numeric(18,6))` preserves scale → `0.300000`. To avoid over-fitting to scale formatting, assert exact string **or** `Prisma.Decimal(...).equals(...)`, plus a hard assertion that the value is not in exponential notation. | F1 |
| C3 | Every `totalQuantity` in every response | `typeof === "string"` — no `Prisma.Decimal` instance and no `number` escapes into JSON | F1 |

### D. Tenant isolation

| # | Case | Layer | Expected | Falsifies |
| --- | --- | --- | --- | --- |
| D1 | Seed identical shapes for tenant A and tenant B; `GET` with `X-Tenant-Id: A` | application | only A's rows; `total` counts only A's grouped rows | F6 |
| D2 | Same data; `X-Tenant-Id: B` | application | only B's rows | F6 |
| D3 | Probe role (`NOSUPERUSER NOBYPASSRLS`), `set_config('app.tenant_id', A, true)`, raw `SELECT * FROM "UsageLine"` with **no** `WHERE` | database | only A's rows | F4 |
| D4 | Probe role, `app.tenant_id = B` | database | only B's rows | F4 |
| D5 | Probe role, **no** `set_config` | database | **zero** rows | F4 |
| D6 | `pg_policies` contains `usage_line_tenant_isolation`; `pg_class.relrowsecurity` and `relforcerowsecurity` are both true for `UsageLine` | database | true | — |

D3-D5 are the assertions that make RLS falsifiable. D6 alone — which is all the existing auth RLS
suite effectively asserts in CI — is a metadata check, not an isolation proof.

### E. Query plan (Slice 9, diagnostic)

| # | Case | Expected |
| --- | --- | --- |
| E1 | ~2,000 seeded lines, `ANALYZE`, then `EXPLAIN (FORMAT JSON)` on the paginated query | the plan reaches `UsageLine` via the `tenantId, periodStart, periodEnd` index, not a full sequential scan |
| E2 | Same, recorded not asserted | `metricKey` participates in `GROUP BY` and the optional filter with no supporting index — logged for follow-up F-4 |

### Epic acceptance mapping

| Epic T-036 test case | Covered by | Note |
| --- | --- | --- |
| Ingest 5 → `202 { accepted: 5, duplicate: 0 }` | A1 | envelope corrected to `{ data: { …, rejected: 0 } }`; requires distinct explicit idempotency keys (A9 pins why) |
| Replay → `202 { accepted: 0, duplicate: 5 }` | A2 | needs real Redis (4.5) |
| Exceed `INGEST_BATCH_MAX` → `400 BATCH_TOO_LARGE` | A3, A4 | the enforced limit is the hard-coded `BATCH_SIZE_MAX = 100`; `INGEST_BATCH_MAX` is dead config (Section 8, D-1) |
| `occurredAt` > 24h future → `400 VALIDATION_ERROR` | A5, A6, A7 | **epic is wrong on both threshold and code** (Section 7.2) |
| Summary with seeded `UsageLine` → correct totals per bucket | B1, B4-B8, C1-C3 | |
| Summary with `metricKey` filter | B2 | |
| Summary with no data → `{ items: [], total: 0 }` | B3 | real envelope also carries `page`, `pageSize` |
| *(not in epic — added)* DB-layer RLS isolation | D3-D6 | closes the T-035 review gap |

---

## 7) Ground-Truth Corrections To The Epic's Test List

Read against the shipped code, three of the epic's seven cases are inaccurate and one is
under-specified. Each is escalated rather than silently reinterpreted.

**7.1 — Response envelopes.** The epic writes `202 { accepted: 5, duplicate: 0 }`.
`events.controller.ts:90-92` sends `{ data: result }` where `result` is
`{ accepted, duplicate, rejected }` (`ingestion.service.ts:9-13`). Similarly the epic's
`{ items: [], total: 0 }` is really `{ data: { items: [], total: 0, page: 1, pageSize: 20 } }`
(`usage.controller.ts:49`, `usage.service.ts:54-59`). Shorthand, not a defect — but the assertions
must match the wire format.

**7.2 — The "24h in the future" case is wrong twice.** This is the significant one.
- *Threshold*: the implemented tolerance is `CLOCK_SKEW_TOLERANCE_SECONDS = 5 * 60`
  (`events.validator.ts:9`), applied at `events.controller.ts:146` as `Math.abs(delta) > tolerance`.
  A timestamp 24h ahead trips the guard at the **5-minute** mark. There is no 24-hour rule anywhere
  in the ingestion path. (The only 24-hour constant in the service is the *dedup key TTL*,
  `constants.ts:61` — plausibly the source of the epic's confusion.)
- *Error code*: the guard sends `FUTURE_CLOCK_SKEW` (`events.controller.ts:77`), not
  `VALIDATION_ERROR`. `VALIDATION_ERROR` comes only from the Zod pass, and `occurredAt` is validated
  by `iso8601Schema` = `z.string().datetime({ offset: true })` (`packages/shared-validation/src/index.ts:20`),
  which happily accepts a well-formed far-future timestamp.

  So a request with `occurredAt` 24h ahead returns `400 FUTURE_CLOCK_SKEW`, and the epic's stated
  expectation of `400 VALIDATION_ERROR` **cannot pass** without changing production code.

  **Plan: test the implementation** (A5/A6 assert `FUTURE_CLOCK_SKEW`; A7 covers the genuine
  `VALIDATION_ERROR` path with a malformed timestamp) **and escalate the discrepancy for a user
  ruling.** Changing the code to satisfy the epic's text would be a behaviour change smuggled into a
  test task.

**7.3 — "exceeding `INGEST_BATCH_MAX`" is accidental.** The batch cap actually enforced is
`INGESTION_CONSTANTS.BATCH_SIZE_MAX = 100`, hard-coded in `events.validator.ts:8` and applied at
line 36. `env.INGEST_BATCH_MAX` (`config/env.ts:14`) is read by **no production code** — a
repo-wide grep finds it only in `config/env.ts`, `.env.example`, and its own env-schema unit test.
The epic's phrasing is true only because both values happen to default to 100; setting
`INGEST_BATCH_MAX=5` would change nothing. The test therefore sends 101 events and asserts against
`BATCH_SIZE_MAX`. Tracked as defect D-1.

**7.4 — "the same batch" is under-specified, and the naive reading fails.** For A1 to yield
`accepted: 5`, the five events need five **distinct** idempotency keys. When a client omits
`idempotencyKey`, `ingestion.service.ts:112-113` derives
`` `${tenantId}:${eventType}:${metadata?.sourceId ?? "unknown"}:${occurredAt}` ``. Five events sharing
an `eventType` and an `occurredAt` — the obvious way to write "a batch of 5" — collapse to a single
key and return `accepted: 1, duplicate: 4`. Fixtures must set an explicit distinct `idempotencyKey`
per event (which also makes the A2 replay deterministic). A9 exists to pin the collapse behaviour so
this cannot silently regress.

---

## 8) Production Defects Found (documented, NOT fixed in T-036)

| ID | Severity | Finding | Evidence | Proposed follow-up |
| --- | --- | --- | --- | --- |
| **D-1** | MEDIUM | `INGEST_BATCH_MAX` is dead configuration. Operators can set it and nothing changes; the real cap is a hard-coded literal in the validator. | `config/env.ts:14` vs `validators/events.validator.ts:8,36`; grep shows no production reader | F-2: wire `env.INGEST_BATCH_MAX` into the batch schema (needs a schema factory, since the current schema is a module-level constant) |
| **D-2** | MEDIUM | `DEDUP_CONSTANTS.KEY_PREFIX = "dedup:"` is never applied. `deduplication.service.ts:33` passes the raw `idempotencyKey` to `redis.set`, so caller-controlled strings become top-level Redis keys in a keyspace shared with the event stream. A client-supplied key of `telemetry:events` would collide with `STREAM_CONSTANTS.DEFAULT_STREAM_NAME`. Client-supplied keys are also not tenant-namespaced (tested by A11). | `constants.ts:60`, `deduplication.service.ts:33-39`, `ingestion.service.ts:111-113` | F-3: prefix and tenant-namespace dedup keys |
| **D-3** | LOW/product | The clock-skew window is symmetric (`Math.abs`), so events more than 5 minutes **old** are rejected. Backfill and retry-after-outage are impossible by construction. | `events.controller.ts:144-147`, `ingestion.service.ts:92-95` | product decision; asymmetric window if backfill is required |
| **D-4** | LOW/docs | Two comments assert something false about Postgres: `base.repository.ts:52` ("RLS policies use FORCE RLS to prevent superuser bypass") and `prisma/migrations/v1_2_force_row_level_security/migration.sql:2` ("prevents superusers … from bypassing RLS policies"). `FORCE ROW LEVEL SECURITY` removes only the **table owner's** exemption; `rolsuper` and `rolbypassrls` roles bypass RLS unconditionally. The service connects as `postgres`, verified `rolsuper = t, rolbypassrls = t`. | verified via `pg_roles` | F-1 (below) |

### Follow-ups this plan recommends filing

- **F-1 (HIGH, security)** — The application connects to Postgres as a superuser, so RLS is inert in
  practice. Introduce a least-privilege `telemetry_app` role (`NOSUPERUSER NOBYPASSRLS`) in a
  migration, grant it only the DML it needs, and point `DATABASE_URL` at it in compose and CI. Also
  correct the two comments in D-4. **T-036's RLS tests will pass either way** — they use their own
  probe role — so this must be tracked separately or it will be forgotten.
- **F-2** — D-1. **F-3** — D-2. **F-4** — index support for `metricKey` (Slice 9 / case E2).
- **F-5** — `apps/auth-service/tests/rls.integration.test.ts:79,97,110` short-circuits its three
  substantive assertions when the connection is a superuser, which is always the case in CI. Those
  tests report green while asserting nothing. Rewrite them onto a probe role, as T-036 does.

---

## 9) Risks And Mitigations

| ID | Risk | Mitigation |
| --- | --- | --- |
| R-1 | **Cross-suite destruction.** `auth.integration.test.ts:117-119` issues unscoped `deleteMany()` on `Tenant`/`User`/`RefreshToken`, and turbo runs the auth and usage test tasks concurrently against the same DB. Our `Tenant → Event → UsageLine` FK chain would make their `tenant.deleteMany()` fail with a FK violation, breaking *their* suite. | Dedicated `telemetry_usage_test` database (4.3). Additionally, every delete in our harness is tenant-scoped — never a bare `deleteMany()` — and tenant ids are per-run UUIDs. |
| R-2 | **Dedup TTL makes the suite pass once then fail for 24h.** Fixed idempotency keys survive 24h in Redis. | Per-run `randomUUID()` key prefix **and** `FLUSHDB` on the isolated logical DB (4.5). |
| R-3 | **`FLUSHALL` blast radius.** Because of D-2, dedup keys are unprefixed in the root keyspace shared with five other services. | Never `FLUSHALL`. Dedicated logical DB index 15 via `USAGE_TEST_REDIS_URL`; `FLUSHDB` only. |
| R-4 | **RLS test proves nothing if run as `postgres`.** The obvious implementation would pass vacuously, exactly as the auth suite does today. | Dedicated `NOSUPERUSER NOBYPASSRLS` probe role; assertions use raw SQL with **no** application `WHERE`; role-creation failure **fails the test loudly** rather than skipping (4.6). |
| R-5 | **Unmigrated / missing test database** produces a wall of opaque Prisma errors. | `assertSchemaReady()` preflight in `beforeAll` naming the exact `prisma migrate deploy` command; `docker/docker-compose.test.yml` with published ports for contributors with no native Postgres. |
| R-6 | **Prisma client not generated.** A clean checkout has no `.prisma/client` (verified), and `pnpm --filter … test:integration` does not fire the root `pretest`. `prisma.usageLine` would be `undefined`. | Explicit generate step in the runbook and in CI before the integration step (Slice 0). |
| R-7 | **Timezone-dependent bucket assertions.** `periodStart` is `timestamp(3) without time zone`; if the raw-query decoder ever re-interpreted it in local time, `bucketStart` would shift on a non-UTC machine while passing on a UTC CI runner. | B4/B6 assert exact `…Z` instants. The validation runbook includes one deliberate `TZ=America/New_York` run (Section 10) so timezone independence is proven, not assumed. |
| R-8 | **Scale-formatting brittleness.** `SUM(numeric(18,6))` returns scale 6 (`0.300000`, pre-verified), but asserting the exact string over-fits to a driver formatting detail. | C2 asserts numeric equality *plus* a non-exponential-notation guard, rather than string identity alone. C1 — where any float round-trip is provably lossy — carries the exact-string assertion. |
| R-9 | **Suite runtime creeps** and slows CI. | `fileParallelism: false` applies to the integration project only; Slice 9 (2,000-row query-plan slice) is explicitly the first thing cut. |
| R-10 | **Integration tests drop out of the gate** because they are not in `pnpm test`. | `pnpm test:integration` is added as its own CI step *and* listed in this plan's full-gate commands (Section 10). |
| R-11 | **Test-only role leaks into an environment that matters.** | The probe role is `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, is created only inside `USAGE_TEST_DATABASE_URL`, and is never referenced by production config. |
| R-12 | **Tests pin defective behaviour** (A9, A11 assert current, arguably wrong, semantics). | Each such case carries an inline comment naming the defect ID (D-1/D-2) and the follow-up task, so a future fix updates the test deliberately rather than being blocked by it. |

---

## 10) Validation Commands

### Prerequisites (once per environment)
```
pnpm prisma:generate:auth
createdb -h 127.0.0.1 -U postgres telemetry_usage_test    # or: docker compose -f docker/docker-compose.test.yml up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/telemetry_usage_test \
  pnpm --filter @telemetry/auth-service exec prisma migrate deploy --schema=../../prisma/schema.prisma
```

### Task-scoped first (fail fast)
1. `pnpm --filter @telemetry/usage-service test:integration`
2. `TZ=America/New_York pnpm --filter @telemetry/usage-service test:integration` — proves R-7
3. `pnpm --filter @telemetry/usage-service test` — unit suite must still pass and must **no longer**
   collect the integration file
4. `pnpm --filter @telemetry/usage-service lint`
5. `pnpm --filter @telemetry/usage-service typecheck` — `tsconfig.json` includes `tests/**/*.ts`, so
   the new helpers and suite are type-checked

### Full gate (pre-commit)
1. `pnpm build`
2. `pnpm test`
3. `pnpm test:integration`
4. `pnpm lint`
5. `pnpm typecheck`

Report status for all 13 packages. Distinguish pre-existing failures from ones this diff introduces,
proving the distinction with `git diff --name-only` and `git log -1 <file>`. Note in particular that
`pnpm test` currently requires a live database for `@telemetry/auth-service`, independent of this
task (R-7 / F-5).

---

## 11) Pending Task Checklist

- [done] Read `.claude/agents/enterprise-delivery.md` and `.github/copilot-instructions.md`
- [done] Read the T-036 spec at `docs/epics/epic-6-usage-service.md:186-199`
- [done] Read `docs/plans/t-035-usage-summary-endpoint.md` and `t-031-ingestion-endpoint.md` as templates
- [done] Audit the ingestion path for real response shapes, batch cap, and skew rule
- [done] Audit the T-035 summary path (commit `79ec77c`) for real response shape and SQL
- [done] Determine live infrastructure: compose services, host ports, CI services, migrations
- [done] Verify RLS state, policy names, and role privileges against the live database
- [done] Confirm nothing in the repo writes `UsageLine` (`UsageLine` is empty; grep finds no writer)
- [done] Verify `DATE_TRUNC` week/day/hour output and `SUM(numeric(18,6))` scale in live Postgres
- [done] Choose the DB isolation strategy and record rejected alternatives with reasons
- [done] Design the RLS probe-role approach and the Decimal-precision falsifier
- [done] Write this plan
- [done] **User approval of this plan** ← blocking gate (approved with decisions D-1…D-7, see §24)
- [void] Slice 0 — verify Prisma client generation — superseded by §14.9 (runbook line, not a slice)
- [done] Slice 1 — test constants module → `tests/integration.constants.ts`
- [done] Slice 2 — DB harness (bootstrap, FK-safe reset, seeds) — **probe role dropped**, §14.3/§16.2
- [done] Slice 3 — Redis harness → same file, `tests/integration.fixtures.ts`
- [done] Slice 4 — suite skeleton; every case confirmed failing before assertions (§24)
- [done] Slice 5 — ingestion cases — **A1-A10** per §18, not the old A1-A11 (A11 inverted by S-1)
- [done] Slice 6 — summary cases — **B1-B11** per §18, not the old B1-B12
- [done] Slice 7 — Decimal precision cases C1-C3
- [done] Slice 8 — tenant isolation cases — **D1-D3** per §16.2; old D4-D6 dropped as duplicative
- [void] Slice 9 — query-plan diagnostic E1-E2 — dropped in §17, refiled as F-6
- [void] Slice 10 — vitest config split, scripts, turbo task, CI step, compose, `.env.example` —
  reversed by decision D-2; none of those files are touched
- [done] Slice 11 — task-scoped validation, then full gate (§24)
- [done] **Resumed at `3588bf1` after S-18 landed** (§24, round 2)
- [done] B8 rewritten to assert the real half-open contract, under two pinned session zones
- [done] `readEffectiveRangeBounds` deleted from the fixtures — it re-implemented the defect
- [done] `RANGE_FROM`/`RANGE_TO` rationale rewritten; the workaround it described is gone
- [done] Every other summary/precision/isolation case re-checked against the fixed behaviour
- [done] S-16/S-17 re-verified and their drifted references corrected; S-19 and S-20 filed
- [done] File follow-ups — S-16 and S-17 added to `.claude/rules/known-gaps.md`; S-6's stale line
  reference corrected. F-11/F-12/F-13 and the new range-filter defect are escalated, not filed.
  **Four** entries in total across the two rounds: S-16 and S-17 authorised in round 1, S-19 and
  S-20 in round 2 (both recommended verbatim by the S-18 reviewer). No further entry is
  authorised — the two round-3 S-18 follow-ups below are reported, not filed
- [done] Hand off to Senior Reviewer (pre-QA) — verdict **CONDITIONAL**,
  `docs/reviews/t-036-usage-service-integration-tests.md`
- [done] Round 3 — MEDIUM-1: least-privilege DB fallback + the "D0" connected-role case
- [done] Round 3 — MEDIUM-2/3/4: three comments corrected to what the cases measurably prove
- [done] Round 3 — LOW-1…LOW-7 and the NIT taken; see §25
- [pending] Hand off to Senior Reviewer (pre-QA), round 3

---

## 12) Approval Gate Statement

**No implementation has been performed. No production code, test code, or configuration has been
written, staged, or committed. This plan document is the only artifact produced.**

Implementation must not begin until the user explicitly approves this plan. Two items warrant a
decision before Stage 2 starts:

1. **Section 7.2** — the epic's `occurredAt` test case specifies `400 VALIDATION_ERROR` at a 24-hour
   threshold, but the shipped code returns `400 FUTURE_CLOCK_SKEW` at a 5-minute threshold. This plan
   tests the implementation and escalates. Confirm that is the right call, or authorise a separate
   task to change the behaviour.
2. **Section 4.3 / Slice 10** — the recommended approach adds a second test database and modifies
   `.github/workflows/ci.yml`, `turbo.json`, and the root `package.json`. That is broader than a
   single test file. Confirm this infrastructure work belongs in T-036, or split it into a preceding
   task.

On approval, execution proceeds to Task Implementer under `docs/task-implementer-workflow.md`:
test skeletons → test bodies → **confirm they fail** → harness → assertions → task-scoped validation
→ full gate. Nothing is committed at any point; the working tree is left for the user.

---
---

# REVISION 2 (base commit `3374cf9`)

## 13) Status of this plan: extending, not replacing

**Extending.** Sections 1-12 were written before `b0f6921` and `1b872b3` landed. Re-reading them
against the code at `3374cf9`, the split is roughly two-thirds sound / one-third invalid, and the
sound part is the expensive part — the epic-vs-code corrections, the Decimal falsifier, the dedup
TTL hazard, and the rejected-alternatives analysis all still hold and all still needed a live
database to establish. Re-deriving them into a second 600-line document would produce two
documents that disagree, and the repo's own convention is to append a remediation round rather
than fork the file (`docs/plans/s-007-auth-service-restricted-role.md` §14, §15).

The invalid third is not cosmetic, though, and one item in it is a correctness defect rather than
drift: **the original plan does not mention `X-Internal-Secret` anywhere.** Every route assertion
in its Sections 6 A1-A11, B1-B12 and D1-D2 would have received `401 UNAUTHORIZED` instead of the
status it asserts. Section 14 records that alongside the rest.

## 14) What changed underneath the plan

Each row is a claim made in Sections 1-12, its status at `3374cf9`, and the evidence.

| # | Original claim | Status | Evidence |
|---|---|---|---|
| 14.1 | *(absent)* — no mention of service-to-service auth anywhere in the plan | **DEFECT, not drift** | `apps/usage-service/src/app.ts:27` registers `registerUsageInternalAuthMiddleware` as the **first** `onRequest` hook; `apps/usage-service/src/middleware/public-routes.ts:12-17` exempts only `/health`, by exact `request.url` match. Every A/B/D case as written returns `401`. |
| 14.2 | §4.6: "the application connects as `postgres`, which is `rolsuper = t` and `rolbypassrls = t` … RLS is inert" | **FALSE** | `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'telemetry%'` → `telemetry_app f f`, `telemetry_auth_app f f`, `telemetry_auth_definer f f`. `apps/usage-service/tests/setup.ts:5-6` and `.github/workflows/ci.yml:15` both point `DATABASE_URL` at `telemetry_app`. |
| 14.3 | §4.6(b), §6 D3-D6, R-4, R-11: build a `telemetry_rls_probe` role in the test harness | **UNNECESSARY and duplicative** | `apps/usage-service/tests/rls.enforcement.integration.test.ts` already does all of D3/D4/D5 plus two writes D3-D6 never proposed (cross-tenant `INSERT` rejected, cross-tenant `UPDATE` affects 0 rows) — lines 176-225. It runs on `telemetry_app` and asserts the role's attributes at line 156. |
| 14.4 | §8 F-1: "file a HIGH follow-up — the app connects as a superuser" | **FIXED** — S-2, `prisma/migrations/v1_4_app_role_non_superuser` | `_prisma_migrations` shows `v1_4_app_role_non_superuser` and `v1_5_auth_tenant_resolvers` both `finished_at IS NOT NULL`. |
| 14.5 | §8 D-4: "`base.repository.ts:52` asserts something false about `FORCE ROW LEVEL SECURITY`" | **FIXED** | `apps/usage-service/src/repositories/base.repository.ts:52-54` now says the opposite and names the migration. |
| 14.6 | §8 D-2 + §6 A11: "`KEY_PREFIX` is never applied; client-supplied dedup keys are not tenant-namespaced" | **FIXED** — S-1; **A11's expected result is now inverted** | `apps/usage-service/src/services/deduplication.service.ts:40-42` builds `${KEY_PREFIX}${tenantId}:${idempotencyKey}`; `apps/usage-service/src/services/ingestion.service.ts:114-116` derives `eventType:sourceId:occurredAt` and deliberately omits the tenant. Two tenants sending the same `idempotencyKey` now both get `accepted`. |
| 14.7 | §4.3 + R-1: dedicate a `telemetry_usage_test` database, because `auth.integration.test.ts:117-119` issues three unscoped `deleteMany()` | **premise FALSE; recommendation reversed** | `apps/auth-service/tests/auth.integration.test.ts:125-133` now finds rows by a per-run email domain (`SUITE_EMAIL_DOMAIN`, line 27) and deletes by explicit id. There is no unscoped `deleteMany` left in that file. |
| 14.8 | §4.7 + R-10 + Slice 10: exclude `*.integration.test.ts` from the default vitest config and add a `test:integration` script, turbo task, root script and CI step | **now carries a regression risk it did not carry then** | `apps/usage-service/vitest.config.mjs:5` is `include: ["tests/**/*.test.ts"]` with **no** `exclude`; `grep -rn 'test:integration' package.json apps/*/package.json turbo.json` → no match. Adding the exclusion silently removes `rls.enforcement.integration.test.ts` (S-2/S-4 evidence) from `pnpm test`. |
| 14.9 | R-6: "a clean checkout has no generated Prisma client (verified)" | **stale as stated, hazard still real** | `ls -d node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client` → present (6.19.3). Root `package.json` has a `pretest` hook running `prisma:generate:auth`, and `.github/workflows/ci.yml:84-88` generates explicitly. A `pnpm --filter … test` run still bypasses the root `pretest`. |
| 14.10 | §6 C2 / R-8: "`SUM(numeric(18,6))` preserves scale → `0.300000`; assert exact string **or** Decimal equality" | **true in SQL, FALSE at the API boundary** | `psql` → `0.300000`. But `$queryRaw` decodes it to `Prisma.Decimal`, and `usage.repository.ts:72` is `String(value)`, which decimal.js renders **`"0.3"`**. Probe output in §15.3. An assertion of `"0.300000"` fails. |
| 14.11 | Line anchors throughout §7 and §8 | **drifted** | `config/env.ts:14` → **:19**; `events.validator.ts:8` → **:6**; `constants.ts:60,61` → **:70,:71**; `deduplication.service.ts:33` → **:61**; `base.repository.ts:94` → **:92**. |
| 14.12 | §8 F-5: "`rls.integration.test.ts:79,97,110` short-circuits on superuser" | **FIXED** in auth-service | `grep -n 'isCurrentUserSuperuser' apps/auth-service/tests/rls.integration.test.ts` → no match. |
| 14.13 | Section 12's two open decisions | **still open, restated in §22** | Section 12 item 1 (S-5) is unchanged; item 2 (infrastructure scope) is now a different question because of 14.7 and 14.8. |

### 14.14 What S-7 specifically did *not* break

The brief flagged four S-7 changes as possible invalidators. Checked individually:

- **`telemetry_auth_app` / `telemetry_auth_definer` added** — irrelevant to usage-service, which
  connects as `telemetry_app` (`apps/usage-service/tests/setup.ts:5-6`).
- **`telemetry_auth_app`'s grants narrowed to three tables** (`v1_5` migration lines 230-252) — the
  revoke loop at lines 238-250 names only `telemetry_auth_app`; it does not touch `telemetry_app`.
  Confirmed live: `telemetry_app` still reads and writes `UsageLine` under tenant context (§15.4).
- **`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`** (`v1_5:314`, database-scoped)
  — this covers *functions created afterwards by the migration role*. `set_config` and
  `current_setting` are `pg_catalog` built-ins and are not affected. Verified directly rather than
  reasoned: as `telemetry_app`, `SELECT set_config('app.tenant_id','probe',true)` returns `probe`
  (§15.4). Independently corroborated by `rls.enforcement.integration.test.ts` passing at
  `3374cf9`, which reaches `UsageLine` only through `set_config`.
- **The two `SECURITY DEFINER` resolvers** — `v1_5:324-325` explicitly revokes them from
  `telemetry_app`. usage-service never calls them. No effect.

**One doc discrepancy found while checking this, which T-036 does not fix but a reviewer should
not rely on:** `.claude/rules/tenant-isolation.md` describes `telemetry_auth_definer` as
`NOLOGIN NOSUPERUSER BYPASSRLS`. The migration creates it `NOBYPASSRLS`
(`v1_5:51-57`) and gives it two targeted `USING (true)` read policies instead
(`v1_5:127-147`); live `pg_roles` agrees (`rolbypassrls = f`). Escalated in §22 D-6.

## 15) Re-verified ground truth, with the command that established each item

Everything in this section was run against the working environment at `3374cf9`. Where a claim
generalises, it was exercised in more than one form.

### 15.1 Infrastructure

| Fact | Command | Result |
|---|---|---|
| Native Postgres on `127.0.0.1:5432`, native Redis on `127.0.0.1:6379` | `ss -lntp \| grep -E '5432\|6379'` | both LISTEN |
| Postgres is 16.13; **server timezone is `Asia/Kolkata`, not UTC** | `psql -Atc "SELECT version()"` / `SHOW timezone` | `PostgreSQL 16.13 (Ubuntu …)` / `Asia/Kolkata` |
| All six migrations applied to `telemetry` | `psql -Atc "SELECT migration_name, finished_at IS NOT NULL FROM _prisma_migrations ORDER BY started_at"` | `v1_0`…`v1_5`, all `t` |
| `UsageLine`, `Event`, `Tenant`, `User` are all **empty** | `psql -Atc "SELECT (SELECT count(*) FROM \"UsageLine\"), …"` | `0\|0\|0\|0` |
| `UsageLine.quantity` is `numeric(18,6)`; `periodStart`/`periodEnd` are `timestamp(3) without time zone` | `information_schema.columns` query | as stated |
| Redis has 16 logical DBs; **db15 is empty**, db0 and db6 are in use by unrelated work | `redis-cli info keyspace` / `config get databases` / `-n 15 dbsize` | `db0:keys=1`, `db6:keys=12`, `databases 16`, db15 `0` |
| The `postgres-db` container publishes **no** host port and is not this project's database | `docker ps --format '{{.Names}}\t{{.Ports}}'` | `postgres-db … 5432/tcp` (unmapped) |
| `docker/docker-compose.yml` still publishes no host port for `postgres` or `redis` | read `docker/docker-compose.yml` | neither service block has a `ports:` key |
| CI provisions `postgres:16-alpine` on `5432:5432` and `redis:7-alpine` on `6379:6379`, and applies migrations before tests | `.github/workflows/ci.yml:41-58`, `:78-79` | as stated |
| CI creates **no** second database | `.github/workflows/ci.yml` — no `createdb`, one `POSTGRES_DB: telemetry` | as stated |

### 15.2 Where the integration suites actually sit in the gate

`.claude/rules/testing.md` states that `*.integration.test.ts` files "are excluded from the
default vitest config and run via their own script". **That is not true of this repository at
`3374cf9`**, and the plan must be built on the real behaviour:

- `apps/usage-service/vitest.config.mjs:5` and `apps/auth-service/vitest.config.mjs` are both
  `include: ["tests/**/*.test.ts"]` with no `exclude`.
- No `test:integration` script exists in the root `package.json`, in any app's `package.json`, or
  as a `turbo.json` task.
- Run: `pnpm --filter @telemetry/usage-service test` → **17 test files, 179 tests, all passing,
  1.37 s** — and 17 is the total count of files in `apps/usage-service/tests/`, i.e. it includes
  `rls.enforcement.integration.test.ts`.
- Run: `pnpm test` → **13 successful, 13 total; 10.1 s**. usage-service 179/179,
  auth-service 164/164, gateway 38/38, worker/analytics/billing 18-19 each, six shared packages
  4-18 each. **This is the pre-change baseline for the Gate 7 comparison.**
- One line in that output is a *logged* error from a *passing* auth-service test —
  `PostgresError { code: "42501", message: "permission denied for table Event" }` — which is S-7's
  grant-narrowing negative control. Do not report it as a failure.

So integration tests are already inside `pnpm test`, and they already require live Postgres. CI
additionally runs `rls.enforcement.integration.test.ts` a second time as its own step
(`.github/workflows/ci.yml:110-113`) so that the job-level roles rather than `tests/setup.ts`
defaults are the ones under test.

### 15.3 The Decimal and bucket pipeline, end to end

A read-only probe through the real Prisma client (`PrismaClient.$queryRaw`, no tables touched —
`FROM (VALUES …)`), run under two process timezones against a Postgres whose own timezone is
`Asia/Kolkata`:

```
TZ=Asia/Kolkata            TZ=America/New_York
totalQuantity instanceof Prisma.Decimal = true       true
String(totalQuantity) = 999999999999.999999          999999999999.999999
bucketStart.toISOString() = 2026-01-01T00:00:00.000Z 2026-01-01T00:00:00.000Z
bucketEnd.toISOString()   = 2026-01-02T00:00:00.000Z 2026-01-02T00:00:00.000Z
COUNT(*)::int -> typeof number                       number
String(SUM of 0.100000 + 0.200000) = "0.3"           "0.3"
```

Four consequences for the test plan:

1. **F1 is real and the pipeline is exact.** `SUM(numeric(18,6))` arrives as a `Prisma.Decimal`,
   and `String()` on it yields all 18 significant digits. `999999999999.999999` is therefore a
   genuine falsifier: no float64 round-trip can reproduce it.
2. **`usage.repository.ts:72` (`String(value)`) is the only thing standing between a
   `Prisma.Decimal` and the JSON response**, and it does convert. `CLAUDE.md`'s "never let a
   `Prisma.Decimal` reach a JSON response" is satisfied — and now provable, which it was not
   before (the T-035 unit tests feed hand-built Decimals).
3. **§6 C2 must be rewritten.** `0.1 + 0.2` returns `"0.3"`, not `"0.300000"`. The correct
   assertions are: `typeof === "string"`, no `e`/`E` in the string, and
   `new Prisma.Decimal(value).equals("0.3")`.
4. **F2/F3 are safe to assert as exact `…Z` instants.** Established in two process timezones
   *and* against a non-UTC server, so the independence is observed rather than inferred. Scope
   note: this is one Postgres build (16.13 on Ubuntu) and one Prisma version (6.19.3); it is not a
   statement about `timestamp without time zone` decoding in general.

Bucket boundaries at the SQL level, `psql`:
`date_trunc('day','2026-01-01T12:00:00'::timestamp(3))` → `2026-01-01 00:00:00`;
`date_trunc('week','2026-01-01T12:00:00')` → `2025-12-29 00:00:00` (Monday, ISO);
`date_trunc('week','2026-01-05T00:00:00')` → `2026-01-05 00:00:00`;
`date_trunc('hour','2026-01-01T00:59:59.999')` → `2026-01-01 00:00:00`.

### 15.4 Fixture seeding under live RLS — the exact failure modes

This is the risk that most changes the harness design, so it was probed in three forms as
`telemetry_app` (each inside `BEGIN … ROLLBACK`):

| Form | Statement | Observed |
|---|---|---|
| 1 | `INSERT INTO "Tenant" …` with **no** `app.tenant_id` | `ERROR: new row violates row-level security policy for table "Tenant"` — **fails loudly** |
| 2 | `set_config('app.tenant_id', <id>, true)` then the same `INSERT` | `INSERT 0 1`, and `SELECT count(*) FROM "Tenant"` → `1` (only that tenant) |
| 3 | `DELETE FROM "Tenant"` / `DELETE FROM "UsageLine"` with no context | `DELETE 0` / `DELETE 0` — **silently affects nothing** |

The accurate statement, which differs from the brief's phrasing in a way that matters: as
`telemetry_app`, an unscoped **`INSERT` fails loudly** (the `WITH CHECK` raises), while an
unscoped **`DELETE`/`UPDATE`/`SELECT` silently affects zero rows** (the `USING` clause filters).
The dangerous half is the second: a reset helper written on the service connection would stop
resetting and report success. `apps/auth-service/tests/auth.integration.test.ts:19-22` records the
same lesson in prose.

A cross-tenant seed is additionally *impossible* on the app connection regardless of loudness:
`app.tenant_id` is one value per transaction and `tenant_self_insert`'s `WITH CHECK` is
`id = current_setting('app.tenant_id', true)`, so tenant A and tenant B cannot be created in one
transaction. **Seeding must go through `DIRECT_DATABASE_URL`.**

Also verified: `SELECT set_config('app.tenant_id','probe',true)` as `telemetry_app` returns
`probe` — so S-7's default-privilege change did not take `set_config` away (§14.14).

Policies live, for the three tables T-036 touches
(`pg_policies` where `tablename IN ('Tenant','Event','UsageLine')`):

| Table | Policy | cmd | Predicate |
|---|---|---|---|
| `Tenant` | `tenant_self_select` / `_insert` / `_update` / `_delete` | four separate | `id = current_setting('app.tenant_id', true)` |
| `Event` | `event_tenant_isolation` | ALL | `"tenantId" = current_setting('app.tenant_id', true)` |
| `UsageLine` | `usage_line_tenant_isolation` | ALL | `"tenantId" = current_setting('app.tenant_id', true)` |

`relrowsecurity` and `relforcerowsecurity` are both `t` on all three. `postgres` owns all three
and is `rolsuper = t, rolbypassrls = t` — which is *why* admin seeding works, and why success at
seeding is **not** evidence the policies would permit it (the S-2 lesson).

### 15.5 Schema shape that constrains the seed helper

`prisma/schema.prisma:65-97`. `UsageLine.tenantId` is a **plain `String` with no foreign key**;
`UsageLine.eventId` is `@unique` and FKs to `Event`; `Event.tenantId` FKs to `Tenant`. So:

- Seed order is `Tenant` → `Event` → `UsageLine`; reset order is the reverse.
- One `Event` per `UsageLine` (the `@unique` on `eventId` forbids sharing). The existing RLS suite
  already hit this and documents it at `rls.enforcement.integration.test.ts:57-59`.
- `Event.idempotencyKey` is globally `@unique`, so fixture keys must carry a per-run suffix.
- Indexes on `UsageLine`: `@@index([tenantId, periodStart, periodEnd])` and
  `@@index([tenantId, billed])`. **`metricKey` — the `GROUP BY` and optional-filter column — has
  no index.**

### 15.6 Tenant ids must be UUIDs at the HTTP layer

`apps/usage-service/src/middleware/tenant-context.middleware.ts:41` rejects a non-UUID
`X-Tenant-Id` with `401 TENANT_CONTEXT_INVALID`. The existing RLS suite seeds ids like
`rls-a-<uuid>` (`rls.enforcement.integration.test.ts:53-54`) because it never goes through HTTP;
T-036 does, so its tenant ids must be `randomUUID()` values. `Tenant.id` is a `String` column, so
the database accepts either — the constraint is the middleware, not the schema.

## 16) Revised scope, files, and non-goals

### 16.1 What the suite is *for*, after removing what is already covered

The single most important scoping fact, which the original plan did not check: **four of the
epic's seven cases are already covered by tests that never touch infrastructure**, because they
are rejected in the controller before the service is called.

| Already covered at | Case |
|---|---|
| `apps/usage-service/tests/usage-events.route.test.ts:121` | batch larger than 100 → `400 BATCH_TOO_LARGE` (through the full HTTP stack) |
| `apps/usage-service/tests/events.controller.unit.test.ts:151` | `>100` events → `BATCH_TOO_LARGE` |
| `apps/usage-service/tests/events.controller.unit.test.ts:249` | `occurredAt > now + 5min` → `FUTURE_CLOCK_SKEW` |
| `apps/usage-service/tests/events.controller.unit.test.ts:283` | `occurredAt < now - 5min` → `FUTURE_CLOCK_SKEW` |
| `apps/usage-service/tests/usage-events.route.test.ts:95,165,198,218` | missing tenant header → `401`; missing/wrong internal secret → `401`; `/health` reachable |

So the integration suite should be scoped to **what only real Postgres and real Redis can prove**:

1. Deduplication actually deduplicates (`SET NX EX` on a real Redis — the epic's headline case).
2. Published events actually land on the stream (`XADD`, read back).
3. Summary aggregation over real rows: bucket boundaries, `metricKey` filter, empty range,
   `>= from AND < to` inclusivity, pagination over *grouped* rows.
4. `Decimal(18,6)` crosses the API boundary exactly (F1).
5. Cross-tenant isolation **through HTTP with real rows present** — which the existing RLS suite
   does not cover, because it never issues an HTTP request.

The epic-named cases that duplicate existing coverage are kept, but *thin* and explicitly labelled
as epic-mandated re-assertions — see §18 A3/A5 and decision **D-3** in §22.

### 16.2 Relationship to `rls.enforcement.integration.test.ts` — no overlap, no edits

That file is S-2/S-4 acceptance evidence and is cited from `.claude/rules/tenant-isolation.md` and
from `.github/workflows/ci.yml:110-113` by exact path. T-036 **does not touch it**, does not
duplicate its five DB-layer assertions, and does not rename or move it. The division:

| Layer | Proven by | T-036's role |
|---|---|---|
| Postgres RLS policies on `UsageLine` (unscoped `SELECT`, cross-tenant `INSERT`/`UPDATE`) | `rls.enforcement.integration.test.ts` | none — cited, not repeated |
| HTTP → controller → service → repository → real SQL, and the response envelope | *nothing today* | **this is T-036** |

Consequence: the original plan's Section 6 cases **D3, D4, D5 and D6 are dropped**, and its
Section 4.6(b) probe role is dropped with them.

### 16.3 Files — revision 2

**New:**

| Path | Purpose |
|---|---|
| `apps/usage-service/tests/usage.integration.test.ts` | the suite (the epic's named target file) |
| `apps/usage-service/tests/integration.constants.ts` | test-scoped constants: fixture metric keys, fixed instants, the precision probe quantity, the Redis logical-DB index. Flat in `tests/`, matching `apps/auth-service/tests/database-urls.ts`, rather than a new `tests/helpers/` directory that no package currently has. |
| `apps/usage-service/tests/integration.fixtures.ts` | admin-connection seed/reset for `Tenant`→`Event`→`UsageLine`, and the Redis helpers |

**Modified:**

| Path | Change |
|---|---|
| `apps/usage-service/tests/setup.ts` | add a `DIRECT_DATABASE_URL` note only if the existing default proves insufficient; it is already set at line 8. Likely **no change**. |

**Not modified, deliberately** — and this is a reversal of the original Slice 10:
`apps/usage-service/vitest.config.mjs`, `apps/usage-service/package.json`, `turbo.json`, the root
`package.json`, `.github/workflows/ci.yml`, `docker/docker-compose.yml`, and **anything under
`apps/usage-service/src/`**. Rationale in §17 (slice 0) and decision **D-2** in §22.

### 16.4 Non-goals

- No production-code change. Six epic-vs-code discrepancies are recorded in §21; each is escalated
  for a separate task. Fixing any of them inside a test task would make the suite validate a
  moving target.
- No new database. No new Postgres role. No new CI service.
- No load testing. The original Slice 9 (2,000-row `EXPLAIN` diagnostic) is **dropped** — see §17.
- No Epic 7 rollup worker. Nothing in the repo writes `UsageLine`
  (`grep -rn 'UsageLine' apps/*/src packages/*/src` → only `usage.repository.ts`), which is why the
  suite must seed it.

## 17) Revised implementation slices

### Controlling code paths (re-verified at `3374cf9`; the only change from §5 is the first hook)

**Ingest:** `POST /v1/usage/events` → `app.ts:27` `registerUsageInternalAuthMiddleware`
(`internal-auth.middleware.ts:40-58`; SHA-256 + `timingSafeEqual`, `/health` exempt) → `app.ts:28`
`registerUsageTenantContextMiddleware` (`tenant-context.middleware.ts:26-46`; UUID required) →
`events.routes.ts:33` → `EventsController.handle` (`events.controller.ts:32`: Zod parse → tenant
presence → `validateClockSkew` at `:132-155`) → `IngestionService.ingestEvents`
(`ingestion.service.ts:55`: quantity re-check → skew re-check with `Math.abs` at `:92` → key
derivation at `:114-116` → `DeduplicationService.isNew` → `StreamPublisher.publish`) →
`deduplication.service.ts:61` `SET NX EX` and `stream.publisher.ts:70` `XADD` on real Redis.

**Summary:** `GET /v1/usage/summary` → the same two hooks → `usage.routes.ts:15` →
`UsageController.handle` (`usage.controller.ts:25`) → `UsageService.getUsageSummary`
(`usage.service.ts:28`) → `container.ts:58` `usageRepositoryFactory(tenantId)` →
`UsageRepository.aggregateSummary` (`usage.repository.ts:82`) → `withTenant`
(`base.repository.ts:92-110`, `set_config` at `:98`) → two `$queryRaw` calls at `:88` and `:92` →
Postgres.

### Falsifiable local hypothesis

> Exercised over HTTP against a live Postgres and a live Redis, with fixtures seeded through the
> owner connection, usage-service honours both published contracts; `DATE_TRUNC` over
> `timestamp(3)` yields midnight-UTC day and Monday-start ISO week buckets; `SUM(numeric(18,6))`
> reaches the JSON response as an exact decimal string; and `X-Tenant-Id: A` can observe no row
> belonging to tenant B even though both tenants' rows are present in the same table.

**Falsified if:**

- **F1** — two lines summing to exactly `999999999999.999999` return a `totalQuantity` that is not
  that string, or that is a `number`, or that contains `e`/`E`.
- **F2** — a row at `2026-01-01T12:00:00.000Z` under `granularity=day` returns a `bucketStart`
  other than `2026-01-01T00:00:00.000Z`.
- **F3** — Thursday `2026-01-01` under `granularity=week` returns a `bucketStart` other than
  `2025-12-29T00:00:00.000Z`.
- **F5** — replaying a byte-identical batch returns `duplicate` other than the batch size, or
  the stream length changes on the replay.
- **F6** — a summary request with `X-Tenant-Id: A` returns any tenant-B row, or a `total` that
  counts tenant B's grouped rows.
- **F7 (new)** — the fixture pre-flight finds `UsageLine` rows it did not create, i.e. the reset is
  not doing what it claims. Guards against a suite that tests its own seeding failure (§15.4 form 3).

Note what is deliberately **not** in this list: any assertion that the RLS policy blocks a raw
unscoped read. That is F4 in §5, and it is already
`rls.enforcement.integration.test.ts`'s job (§16.2).

### Slices

**Slice 0 — decide the two infrastructure questions (no code).** §22 **D-1** (shared `telemetry`
database vs a dedicated one) and **D-2** (keep the suite in `pnpm test` vs split it out). Both were
open in Section 12 and both now have different right answers than the original plan assumed. The
recommendation in each case is the **smaller** change: reuse `telemetry`, stay inside `pnpm test`.
Nothing else can be written until these are settled, because they determine whether
`vitest.config.mjs`, `turbo.json`, the root `package.json` and `.github/workflows/ci.yml` are in
scope at all.

**Slice 1 — `tests/integration.constants.ts`.** Fixture metric keys (`api.request`, `storage.gb`),
the fixed instants (`2026-01-01T00:00:00.000Z`, `…T12:00:00.000Z`, `…T23:59:59.999Z`,
`2026-01-02T00:00:00.000Z`, `2026-01-05T00:00:00.000Z`), the precision quantities, the Redis
logical-DB index and stream-name prefix. Route paths, header names, status codes, error codes and
pagination defaults are **imported** from `apps/usage-service/src/constants.ts` and
`src/validators/events.validator.ts` — never re-typed. `.claude/rules/constants.md` applies to
tests.

**Slice 2 — `tests/integration.fixtures.ts`.** Two clients, following
`apps/auth-service/tests/user.repository.integration.test.ts:20` and
`rls.enforcement.integration.test.ts:67-71`:
- `admin` = `new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL ?? … })` — seeds and
  reads back. A comment states that this works only because the role is `rolsuper`/`rolbypassrls`
  and owns the tables, so seeding success is not evidence the policies permit it (§15.4).
- `assertSchemaReady()` — a pre-flight that fails with the exact `prisma migrate deploy` command
  rather than a wall of `P2021`.
- `seedUsageLines(spec[])` — `Tenant` → one `Event` per line → `UsageLine`, per-run-suffixed
  `idempotencyKey` (§15.5).
- `resetUsageState(tenantIds)` — `usageLine` → `event` → `tenant`, **always** `where: { tenantId: { in: … } }`,
  never a bare `deleteMany()`, and always on `admin` (§15.4 form 3).
- `assertNoForeignRows()` — the F7 guard.

**Slice 3 — Redis harness (same file).** An `ioredis` client on the isolated logical DB,
`flushIsolatedDb()`, and `readStreamEntries(streamName)` for the `XADD` assertions. Never
`FLUSHALL`: db0 and db6 of the local Redis hold unrelated workspace keys (§15.1).

**Slice 4 — suite skeleton, red first.** `describe.sequential` (matching
`auth.integration.test.ts:68`); `beforeAll` applies the env overrides — `REDIS_URL` with the
logical-DB suffix and a per-run `REDIS_STREAM_NAME` — **before** `await import("../src/app")`,
because `src/lib/prisma.ts:5` and `container.ts:37` both read their connection strings at module
load; then `assertSchemaReady()`; `beforeEach` = `resetUsageState` + `flushIsolatedDb`;
`afterAll` closes the app and disconnects both clients. Every `it` body is `expect.fail(...)`.
**Run it and record that every case fails** before writing a single assertion
(`.claude/rules/testing.md`).

**Slice 5 — a shared `internalHeaders()` helper.** Mirrors
`usage-summary.route.test.ts:16-21` exactly: `{ [USAGE_SERVICE_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET }`.
Written as its own slice because it is the one thing whose omission makes every other slice assert
`401` (§14.1).

**Slice 6 — ingest cases** (§18 A).
**Slice 7 — summary cases** (§18 B).
**Slice 8 — Decimal precision cases** (§18 C).
**Slice 9 — cross-tenant HTTP isolation** (§18 D).
**Slice 10 — task-scoped validation, then the full gate** (§20).

**Dropped from §5:** the old Slice 0 (Prisma generation — now a pre-flight line in the runbook, §14.9),
the old Slice 8's DB-layer half (§16.2), the old Slice 9 (`EXPLAIN` over 2,000 rows), and the old
Slice 10 (config/CI/compose changes). The `EXPLAIN` slice is dropped rather than deferred: the
original plan already conceded that at fixture scale it "would be theatre", and the version that
would not be theatre seeds 2,000 rows and calls `ANALYZE` — a planner-estimate assertion that is
brittle across Postgres minor versions and is not what the epic asked for. The finding it existed to
surface (`metricKey` has no index, §15.5) is better delivered as the escalation in §21 F-6 than as a
flaky test.

## 18) Revised test plan and acceptance-coverage mapping

Real envelopes, read from the code: ingest `202 { data: { accepted, duplicate, rejected } }`
(`events.controller.ts:90-92`, `ingestion.service.ts:9-13`); summary
`200 { data: { items, total, page, pageSize } }` (`usage.controller.ts:49`, `usage.service.ts:54-59`).
**Every case below carries `X-Internal-Secret` and a UUID `X-Tenant-Id`** unless it is explicitly
testing their absence.

### A. Ingestion — `POST /v1/usage/events`

| # | Case | Expected | Epic | Falsifies |
|---|---|---|---|---|
| A1 | 5 events, five **distinct explicit** `idempotencyKey`s, `occurredAt = now` | `202`, `{ accepted: 5, duplicate: 0, rejected: 0 }`; **5 entries readable on the run's stream** | 1 | — |
| A2 | replay the byte-identical A1 payload | `202`, `{ accepted: 0, duplicate: 5, rejected: 0 }`; **stream length still 5** | 2 | F5 |
| A3 | 101 events | `400`, `code = BATCH_TOO_LARGE` | 3 | — |
| A4 | exactly `INGESTION_CONSTANTS.BATCH_SIZE_MAX` events | `202` (the bound is inclusive, `.max()` at `events.validator.ts:47`) | — | — |
| A5 | `occurredAt` 24 h in the future | `400`, `code = FUTURE_CLOCK_SKEW` — **not** `VALIDATION_ERROR` (§21 E-1) | 4 (corrected) | — |
| A6 | `occurredAt` 6 minutes in the future | `400 FUTURE_CLOCK_SKEW` — pins the real threshold at 5 min | 4 (corrected) | — |
| A7 | `occurredAt = "not-a-date"` | `400 VALIDATION_ERROR` — the only path that yields the epic's stated code | 4 (corrected) | — |
| A8 | `occurredAt` 6 minutes in the **past** | `400 FUTURE_CLOCK_SKEW` — documents S-5: `Math.abs` at `events.controller.ts:144` makes the window symmetric, so backfill is impossible | — | — |
| A9 | 5 events sharing `eventType` + `occurredAt`, **no** `idempotencyKey` | `202`, `{ accepted: 1, duplicate: 4, rejected: 0 }` — pins the derived-key collapse (`ingestion.service.ts:114-116`) | — | — |
| A10 | **two tenants** send batches with **identical** `idempotencyKey` values | **both** `202 accepted` — dedup keys *are* tenant-namespaced (`deduplication.service.ts:40-42`). Also assert the two Redis keys are `dedup:<A>:<k>` and `dedup:<B>:<k>`. **This inverts §6 A11**, which asserted the pre-S-1 behaviour. | — | — |

A3-A8 duplicate existing controller/route coverage (§16.1) and are retained only because the epic
names cases 3 and 4 — see decision **D-3**. A1, A2, A9 and A10 are the cases that require real
Redis and exist nowhere else.

### B. Summary — `GET /v1/usage/summary`

| # | Case | Expected | Epic | Falsifies |
|---|---|---|---|---|
| B1 | 3 lines across 2 days, one metric, `granularity=day` | 2 items, correct per-bucket `totalQuantity`, `total = 2` | 5 | — |
| B2 | 2 metric keys, `metricKey=api.request` | only `api.request`; `total` counts only its grouped rows | 6 | — |
| B3 | range with no rows | `200`, `{ items: [], total: 0, page: 1, pageSize: 20 }` (defaults from `USAGE_SUMMARY_CONSTANTS`) | 7 | — |
| B4 | rows at `T00:00:00.000Z` and `T23:59:59.999Z`, `day` | one bucket; `bucketStart = 2026-01-01T00:00:00.000Z`, `bucketEnd = 2026-01-02T00:00:00.000Z` | — | F2 |
| B5 | add a row at `2026-01-02T00:00:00.000Z` | a **second** bucket — the right edge is exclusive | — | F2 |
| B6 | Thu `2026-01-01` + Mon `2026-01-05`, `week` | two buckets: `2025-12-29T00:00:00.000Z` and `2026-01-05T00:00:00.000Z` | — | F3 |
| B7 | `hour`, rows at `T00:59:59.999Z` and `T01:00:00.000Z` | two buckets one hour apart | — | F2 |
| B8 | a row exactly at `from`, a row exactly at `to` | the `from` row included, the `to` row excluded (`usage.repository.ts:116`) | — | — |
| B9 | 3 buckets, `pageSize=2&page=2` | 1 item; `total = 3` (grouped rows, not raw lines); `page`/`pageSize` echoed | — | — |
| B10 | `pageSize = MAX_PAGE_SIZE + 1` | `400 VALIDATION_ERROR` — rejected, not clamped | — | — |
| B11 | `from >= to` | `400 VALIDATION_ERROR`, message `USAGE_SUMMARY_CONSTANTS.MESSAGE_INVALID_RANGE` | — | — |

### C. Decimal precision

| # | Case | Expected | Falsifies |
|---|---|---|---|
| C1 | two lines in one bucket summing to exactly `999999999999.999999` | `totalQuantity === "999999999999.999999"` | F1 |
| C2 | lines of `0.100000` and `0.200000` | `typeof totalQuantity === "string"`; the string contains no `e`/`E`; `new Prisma.Decimal(totalQuantity).equals("0.3")`. **Do not assert `"0.300000"`** — verified `"0.3"` (§15.3, §14.10). | F1 |
| C3 | every `totalQuantity` in every response | `typeof === "string"`, and `!(value instanceof Prisma.Decimal)` | F1 |

### D. Cross-tenant isolation, through HTTP, with both tenants' rows present

| # | Case | Expected | Falsifies |
|---|---|---|---|
| D0 | *(added round 3)* read `rolname`/`rolsuper`/`rolbypassrls` for `current_user` through the app's own client | `telemetry_app`, `false`, `false` | the owner-fallback failure mode (MEDIUM-1) |
| D1 | identical fixtures for tenant A and B; `GET` with `X-Tenant-Id: A` | only A's rows; `total` counts only A's grouped rows | F6 |
| D2 | same data; `X-Tenant-Id: B` | only B's rows | F6 |
| D3 | pre-flight before each case | no `UsageLine` row outside the run's tenant ids | F7 |

Note for the reviewer on why D1/D2 are not tautological: they pass through `this.where({})`
(`usage.repository.ts:180` at `3588bf1`), so the tenant predicate comes from the repository's own
bound context, and **tenant B's rows exist in the same table at the same time**, so a response
carrying one tenant's row is evidence that something filtered.

Corrected in round 3, because the previous sentence claimed more than the cases deliver: D1/D2
prove the **composite** of the bound predicate and the RLS policy and cannot separate the two,
since either alone suffices. Measured — `buildFilters` rewritten to
`WHERE ${tenantId} IS NOT NULL AND "periodStart" >= …`, so the parameter is still bound but no
longer filters — **31/31 pass**. `telemetry_app` is `NOBYPASSRLS`, so the policy carries it. The
predicate alone is asserted at `usage.repository.unit.test.ts:202-207`; the RLS layer alone is
`rls.enforcement.integration.test.ts`. **D0** (added in round 3) is what keeps the RLS half of
that composite real: it asserts the app's own connection is `telemetry_app`, `NOSUPERUSER`,
`NOBYPASSRLS`.

### Epic acceptance mapping

| Epic T-036 case | Covered by | Note |
|---|---|---|
| Ingest 5 → `202 { accepted: 5, duplicate: 0 }` | **A1** | envelope corrected to `{ data: { …, rejected: 0 } }`; needs distinct explicit keys — A9 pins why |
| Replay → `202 { accepted: 0, duplicate: 5 }` | **A2** | requires real Redis; vacuous against a mock |
| Exceed `INGEST_BATCH_MAX` → `400 BATCH_TOO_LARGE` | **A3, A4** | **epic is wrong**: the enforced cap is `BATCH_SIZE_MAX` at `events.validator.ts:6`; `INGEST_BATCH_MAX` is read by nothing (§21 E-2 / S-6) |
| `occurredAt` > 24 h future → `400 VALIDATION_ERROR` | **A5, A6, A7** | **epic is wrong twice** — threshold and code (§21 E-1 / S-5) |
| Summary with seeded `UsageLine` → correct totals per bucket | **B1, B4-B8, C1-C3** | |
| Summary with `metricKey` filter | **B2** | |
| Summary with no data → `{ items: [], total: 0 }` | **B3** | real envelope also carries `page`, `pageSize` |
| *(not in epic — added)* tenant isolation through HTTP | **D1-D3** | the layer `rls.enforcement.integration.test.ts` does not reach |
| *(not in epic — added)* tenant-namespaced dedup | **A10** | S-1 acceptance, previously unproven end-to-end |

## 19) Revised risks

| ID | Risk | Mitigation |
|---|---|---|
| **R-13** | **Every request 401s** because the internal-auth hook is not satisfied. The single most likely way this suite fails to be written correctly (§14.1). | Slice 5 lands the `internalHeaders()` helper before any assertion, copied from `usage-summary.route.test.ts:16-21`. A1 is written and run first, so the failure surfaces on case one rather than case forty. |
| **R-14** | **Fixtures seeded through the service connection** — cross-tenant seeds are impossible and resets silently no-op (§15.4). | Every write and every reset goes through the `admin` client on `DIRECT_DATABASE_URL`. `assertNoForeignRows()` (F7) makes a broken reset fail rather than pass. |
| R-2 | **Dedup TTL is 24 h** (`constants.ts:71`), so fixed keys make the suite pass once then fail all day. | Per-run `randomUUID()` prefix on every fixture key **and** `flushIsolatedDb()` in `beforeEach`. |
| R-3 | **Redis blast radius.** | Never `FLUSHALL`: db0 and db6 of the local Redis hold unrelated keys (§15.1). Isolated logical DB + `FLUSHDB`, and the app under test is pointed at the same DB via `REDIS_URL` before `import("../src/app")`. |
| **R-15** | **Shared-database interference.** Reusing `telemetry` means the auth suites run concurrently against it under `turbo`. | Their resets are now id- and run-scoped (`auth.integration.test.ts:125-133`, §14.7), ours will be too, `UsageLine`/`Event` are tables they do not touch, and our tenant ids are per-run UUIDs. If interference is nonetheless observed, decision **D-1** provides the dedicated-database fallback — but it is not paid for up front. |
| **R-16** | **Splitting integration tests out of `pnpm test` would drop `rls.enforcement.integration.test.ts` from the default gate** (§14.8). | Recommendation is not to split (**D-2**). If the user chooses to split, the CI step at `.github/workflows/ci.yml:110-113` must be verified still to run that file, and `pnpm test:integration` must be added to the Gate 7 command list — not just to CI. |
| R-5 | **Unmigrated database** → a wall of `P2021`. | `assertSchemaReady()` names the exact `prisma migrate deploy` command. |
| R-6 | **Prisma client not generated** on a `--filter` run, which bypasses the root `pretest`. | Explicit generate line in the §20 runbook. Currently generated (§14.9), so this is a fresh-checkout hazard, not a present one. |
| R-7 | **Timezone-dependent bucket assertions.** | Independence observed, not assumed: two process timezones against a server whose own timezone is `Asia/Kolkata` (§15.3). §20 keeps one deliberate `TZ=America/New_York` run. |
| **R-17** | **Tests pin behaviour that is arguably wrong** (A8 pins S-5; A3/A4 pin a cap that ignores `INGEST_BATCH_MAX`; A9 pins the derived-key collapse). | Each carries an inline comment naming the gap id (S-5 / S-6) and §21's escalation, so a future fix updates the test deliberately instead of being blocked by it. |
| **R-18** | **Suite runtime and flakiness in CI.** Real Redis + real Postgres + `describe.sequential`. | Baseline to beat: `pnpm test` is 10.1 s today (§15.2). Fixtures are tens of rows. The 2,000-row `EXPLAIN` slice is dropped (§17). If a case proves flaky it is fixed or removed, never `skip`ped — a conditional skip is the S-3 anti-pattern. |
| **R-19** | **`pnpm format:check` will flag the new files** — S-12 says that gate cannot pass on any revision of this repo. | Not in the §20 command list. New files are written in the surrounding style; if `format:check` is ever fixed it is fixed in its own commit, per S-12. |

## 20) Revised validation commands

### Pre-flight (once per environment)

```
pnpm prisma:generate:auth
pnpm --filter @telemetry/auth-service exec prisma migrate status --schema=../../prisma/schema.prisma
psql -h 127.0.0.1 -U postgres -d telemetry -Atc 'SELECT count(*) FROM "UsageLine"'
redis-cli -h 127.0.0.1 ping
```

No `createdb` and no new CI service, under the recommended answers to D-1 and D-2.

### Task-scoped, fail fast

```
pnpm --filter @telemetry/usage-service exec vitest run tests/usage.integration.test.ts
TZ=America/New_York pnpm --filter @telemetry/usage-service exec vitest run tests/usage.integration.test.ts   # R-7
pnpm --filter @telemetry/usage-service exec vitest run tests/rls.enforcement.integration.test.ts             # §16.2: still green, untouched
pnpm --filter @telemetry/usage-service test
pnpm --filter @telemetry/usage-service lint
pnpm --filter @telemetry/usage-service typecheck
```

`pnpm --filter <pkg> test -- <file>` does **not** scope to a file; the `exec vitest run <file>`
form above is the one that does (`CLAUDE.md`, `.claude/rules/testing.md`).

### Full gate (Gate 7)

```
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

Report all 13 packages. **The baseline to compare against, measured at `3374cf9` (§15.2):**
`pnpm test` → 13/13 tasks successful, 10.1 s; usage-service 17 files / 179 tests;
auth-service 15 files / 164 tests. The expected delta is usage-service 18 files and
179 + (new count) tests, with every other package byte-identical. The auth-service
`42501 permission denied for table Event` line is a logged error inside a *passing* test and is
not a regression. `pnpm format:check` is excluded — S-12.

## 21) Escalations: where the epic and the code disagree

Six items. Every one is escalated, none is silently reconciled, and no production code changes in
T-036.

| ID | Epic says | Code does | Evidence | Disposition |
|---|---|---|---|---|
| **E-1** | `occurredAt` more than **24 h in the future** → `400 VALIDATION_ERROR` (`epic-6:53`, `:63`, `:195`) | `±5 minutes`, symmetric, → `400 FUTURE_CLOCK_SKEW`; past timestamps rejected too | `events.validator.ts:9`; `events.controller.ts:144,146,77` | **known gap S-5.** Test the code (A5-A8). The epic's assertion cannot pass without a behaviour change. Needs decision **D-4**. |
| **E-2** | batch exceeding **`INGEST_BATCH_MAX`** → `400 BATCH_TOO_LARGE` (`epic-6:61`, `:194`) | cap is the hard-coded `BATCH_SIZE_MAX: 100`; `INGEST_BATCH_MAX` is read by **no** production code | `events.validator.ts:6,47` vs `config/env.ts:19`; `grep -rn INGEST_BATCH_MAX` finds only `env.ts`, `env.schema.unit.test.ts` and docs — and not even `apps/usage-service/.env.example` | **known gap S-6.** A3/A4 assert against the imported `BATCH_SIZE_MAX`, so they cannot silently drift. A test written from the epic's wording would pass while asserting nothing, because both values happen to be 100. |
| **E-3 (new)** | `quantity`: "positive, up to **6 decimal places**" (`epic-6:51`) | `z.number().int().min(1).max(100)` — **integer only, and capped at 100** | `events.validator.ts:7-8,29` | Not previously recorded in `known-gaps.md`. `Event.quantity` is `Decimal(18,6)` in the schema (`prisma/schema.prisma:71`), so the validator is far narrower than the column. `quantity: 0.5` and `quantity: 101` are both rejected today. Escalate as **F-7**; T-036 seeds fractional quantities directly through the admin client (which is how C1/C2 reach `Decimal` values the HTTP path cannot express). |
| **E-4 (new)** | "serialized `metadata` + envelope for each event must stay within **10 KB** — `400` if exceeded" (`epic-6:62`) | **no size check exists** in the ingestion path, and no Fastify `bodyLimit` is configured | `grep -rn 'MAX_EVENT_SIZE_BYTES\|bodyLimit' apps packages` → the constant lives at `packages/shared-validation/src/index.ts:7` and is used only by `UsageEventsBatchSchema` (`:115-133`), which usage-service does not import | Escalate as **F-8**. Unlike E-1/E-2 this is a *missing* guard, so a test written from the epic would **fail**, not pass vacuously. Not added in T-036 — that would be new production behaviour. |
| **E-5 (new)** | error bodies are `400 { code: 'BATCH_TOO_LARGE', max: number }` and `400 { code: 'VALIDATION_ERROR', issues: [...] }` (`epic-6:73-74`) | `{ code, message }` with `message` a joined string; no `max`, no `issues` | `events.controller.ts:54-57`, `:76-79`. (`registerGlobalErrorHandler` *does* emit `issues`, `packages/shared-utils/src/index.ts:120-128`, but the controller `safeParse`s and never throws the `ZodError`.) | Assert the real shape. Escalate the envelope difference as **F-9**. |
| **E-6 (new)** | step 1: "generate `idempotencyKey` via `generateIdempotencyKey(tenantId, eventType, occurredAt)`" (`epic-6:67`) | that helper exists (`packages/shared-utils/src/index.ts:13-22`, SHA-256) and is **unused**; ingestion derives a plaintext `eventType:sourceId:occurredAt` instead | `ingestion.service.ts:114-116`; `grep` shows the helper's only callers are its own unit tests | A9 pins the actual behaviour. Escalate as **F-10**. Note the derived key omits the tenant *deliberately* now — `DeduplicationService` owns that segment (S-1). |

### Follow-ups this revision recommends filing

- **F-6** — `metricKey` is the `GROUP BY` and filter column on `UsageLine` and has no supporting
  index (§15.5). Replaces the dropped `EXPLAIN` slice.
- **F-7** — E-3: `quantity` validator (integer, max 100) contradicts both the epic and the
  `Decimal(18,6)` column.
- **F-8** — E-4: the 10 KB per-event cap is specified, implemented in `shared-validation`, and
  wired to nothing.
- **F-9** — E-5: ingest error envelopes omit `max` / `issues`.
- **F-10** — E-6: `generateIdempotencyKey` is dead code; ingestion derives a plaintext key.
- **F-11 (docs)** — `.claude/rules/testing.md` claims `*.integration.test.ts` files are excluded
  from the default vitest config and run via their own script. Neither is true (§15.2).
- **F-12 (docs)** — `.claude/rules/tenant-isolation.md` describes `telemetry_auth_definer` as
  `BYPASSRLS`; the migration creates it `NOBYPASSRLS` with two targeted policies (§14.14).
- **F-13 (docs)** — `known-gaps.md` S-6 cites `config/env.ts:14` (now `:19`), and S-10 says
  `"RefreshToken"` has "zero policies" — live `pg_policies` shows one
  (`refreshtoken_auth_definer_read`, added by `v1_5:143-146`). S-10's substance is unchanged:
  `relrowsecurity` is still `f`, so the policy is still inert.

**F-1 through F-5 from §8 are closed or withdrawn:** F-1 fixed by S-2 (§14.4), F-3 fixed by S-1
(§14.6), F-5 fixed in auth-service (§14.12). F-2 survives as S-6 (E-2), F-4 as F-6.

## 22) Decisions the user must make before Gate 3

| ID | Decision | Recommendation |
|---|---|---|
| **D-1** | **Dedicated `telemetry_usage_test` database, or reuse `telemetry`?** Section 4.3 argued for a dedicated one on the strength of unscoped `deleteMany()` calls in the auth suite. Those are gone (§14.7). A dedicated database also means a `createdb` + `migrate deploy` in CI, a second `DIRECT_DATABASE_URL`, and a divergence from `tests/setup.ts` that every future suite has to know about. | **Reuse `telemetry`.** Run-scoped UUID tenant ids, tenant-scoped resets, and tables the auth suites do not touch. Keeps `.github/workflows/ci.yml` untouched. Revisit only if interference is actually observed (R-15). |
| **D-2** | **Keep the new suite inside `pnpm test`, or split integration tests into `pnpm test:integration`?** Splitting means a new vitest config, a package script, a `turbo.json` task, a root script and a CI step — and it silently drops the existing `rls.enforcement.integration.test.ts` out of the default gate (§14.8, R-16). Keeping it means `pnpm test` continues to require live Postgres and Redis, which it already does. | **Keep it inside `pnpm test`.** It matches what the repo actually does today (§15.2) and is the smaller change. If contributor ergonomics later justify a split, do it as its own task covering **both** integration suites and both CI steps. |
| **D-3** | **Should A3-A8 be written at all**, given they duplicate `events.controller.unit.test.ts:151,249,283` and `usage-events.route.test.ts:121` and never touch infrastructure (§16.1)? | **Write them, thin.** The epic names cases 3 and 4 explicitly, and at HTTP level they also prove hook ordering (internal-auth → tenant-context → controller) that the unit tests cannot. Each gets a comment naming the test it overlaps, so a reviewer is not misled into thinking they are new evidence. |
| **D-4** | **S-5, the clock-skew window.** The epic asks for a 24-hour *future-only* tolerance; the code rejects anything more than 5 minutes from now in **either** direction, so historical import and retry-after-outage are impossible by construction. T-036 tests the code and escalates. | **Confirm test-the-code**, and file the behaviour change as its own task. Do not change it inside T-036 — that is production behaviour smuggled into a test task, and it would land untested in the very suite meant to verify it. The product question ("is backfill required?") is yours, not the implementer's. |
| **D-5** | **The four new epic discrepancies E-3, E-4, E-5, E-6 (§21).** E-4 in particular is a *missing* guard, not a mislabelled one — a specified 10 KB payload cap that nothing enforces, on a public ingestion endpoint. | **File all four as separate tasks**; T-036 asserts the shipped behaviour and records the divergence. If you want E-4 treated as a live security concern rather than a backlog item, say so and it goes to `known-gaps.md` as a new id before T-036 proceeds. |
| **D-6** | **The three documentation defects F-11, F-12, F-13.** They are one-line edits, but they are edits to `.claude/rules/*`, which is authoritative for every future agent run. | **Fold them into T-036's commit** or split them out — your call. Recommendation: fold F-11 in (it is directly about how this suite is gated and a reviewer will check it), and leave F-12/F-13 to a docs-hygiene task. Note that `.claude/rules/` is configuration; I will not edit it without your explicit instruction. |
| **D-7** | **Where the helper files live.** §3 proposed `tests/helpers/`; no package in this repo has such a directory, and `apps/auth-service/tests/database-urls.ts` sits flat in `tests/`. | **Flat in `tests/`**, matching auth-service. Avoids a new convention for two files. |

## 23) Approval gate statement (revision 2) — supersedes Section 12

**I stopped here for approval. No production code and no test code has been written.** The only
change to the working tree is this document: the revision banner after line 9, and Sections 13-23.
`git status --short` shows one modified file, `docs/plans/t-036-usage-service-integration-tests.md`.
Nothing was staged, committed, branched, or pushed. No file under `apps/`, `packages/`, `prisma/`,
`docker/`, `.github/` or `.claude/` was touched. The read-only probes in Section 15 ran inside
`BEGIN … ROLLBACK` or against `FROM (VALUES …)`; `UsageLine`, `Event`, `Tenant` and `User` are all
still empty, and `pnpm test` is 13/13 as recorded in §15.2.

Implementation must not begin until the user approves. **Seven decisions are open: D-1 through
D-7 in Section 22.** D-1 and D-2 are blocking — they determine whether `vitest.config.mjs`,
`turbo.json`, the root `package.json` and `.github/workflows/ci.yml` are in scope at all, and
Slice 1 cannot start without them. D-3 through D-7 can be answered alongside approval.

On approval, Gate 3 proceeds under `docs/task-implementer-workflow.md`: Slice 1 constants →
Slice 2-3 fixtures → Slice 4 skeleton with `expect.fail` bodies → **record the red run verbatim**
→ Slice 5 `internalHeaders()` → Slices 6-9 assertions → Slice 10 task-scoped validation, then the
full 13-package gate against the §20 baseline. Nothing is committed at any point.

---

## 24) Gate 3 execution record

Base `3374cf9`. Decisions applied as given: **D-1** reuse `telemetry`; **D-2** stay inside
`pnpm test` (`vitest.config.mjs`, `turbo.json`, root `package.json`, `.github/workflows/ci.yml`
untouched); **D-3** write A3-A8 thin, each naming the test it overlaps; **D-4** assert the code,
escalate S-5; **D-5** file, do not fix; **D-7** helpers flat in `tests/`.

**Reading the `file:line` anchors in §13-23.** Those sections were written at `3374cf9`, before
S-18 (`3588bf1`) edited `usage.repository.ts` and `base.repository.ts`. Their anchors —
`usage.repository.ts:72`, `:82`, `:111`, `:116`, `base.repository.ts:92-110`, `set_config` at
`:98` — are historical and no longer resolve; they are not corrected in place because those
sections are a dated record. Current positions: `toQuantityString`/`String(value)` at
`usage.repository.ts:141`, `this.where({})` at `:180`, the range predicate at `:187`,
`set_config('app.tenant_id', …)` at `base.repository.ts:110` and the UTC `TimeZone` pin at
`:111`.

### Files

| Path | State |
|---|---|
| `apps/usage-service/tests/usage.integration.test.ts` | new — 27 cases |
| `apps/usage-service/tests/integration.constants.ts` | new |
| `apps/usage-service/tests/integration.fixtures.ts` | new |
| `.claude/rules/known-gaps.md` | modified — S-16, S-17 added; S-6 line reference corrected |
| `docs/plans/t-036-usage-service-integration-tests.md` | modified — §11 checklist, this section |

Nothing under `apps/usage-service/src/`, `packages/`, `prisma/`, `docker/`, `.github/` or
`turbo.json` was changed. `tests/setup.ts` needed no change (§16.3 predicted this).
`rls.enforcement.integration.test.ts` untouched and still 7/7.

### Red-first record

Three recorded runs, in order:

1. `it.todo` skeleton — 27 todo, 0 assertions.
2. Full assertions, harness stubbed — **20 failed, 7 passed**. The 7 (A4-A8, B10, B11) are
   exactly the cases §16.1 identified as duplicating existing controller/route coverage: they
   reject in the controller and touch no infrastructure, so no harness-absent red state exists
   for them.
3. Harness complete — **10 failed, 17 passed**, all ten from one cause (below), then 27/27 after
   the range-window change.

Because T-036 writes no production code, "confirm red" was additionally discharged by mutation:
27 mutants applied to `apps/usage-service/src/**`, each reverted immediately. Every one of the 26
production-facing cases has at least one killing mutant. D3 has none — its subject is the
fixtures' own reset through the owner connection, not `src/`.

### The defect this suite found

`usage.repository.ts:116` binds `from`/`to` as `timestamp with time zone` (Prisma binds a JS
`Date` that way) while `UsageLine.periodStart` is `timestamp(3) without time zone`, so Postgres
resolves the range comparison through the **database session's** `TimeZone`. On a server whose
session is `Asia/Kolkata` every usage-summary window is shifted +05:30; on a UTC session it is
correct, which is why CI never saw it. Details and evidence in the Gate 3 report; **not** filed in
`known-gaps.md`, which was authorised for two entries only.

Consequence for this suite: the default query window is deliberately wider than every fixture
instant, and B8 asks the database for the bounds it will actually compare against rather than
hard-coding one machine's offset. B8 is therefore not the plan's literal
"row at `from` included, row at `to` excluded" — it asserts the half-open shape at the effective
bounds, and it dies to both `>=`→`>` and `<`→`<=`.

---

### Round 2 — resumed at `3588bf1`, after S-18 landed

Round 1 stopped with B8 red. S-18 (`3588bf1`) fixed the defect round 1 discovered, which made
round 1's accommodations wrong rather than merely unnecessary.

#### What was wrong, and why it was wrong

`usage.integration.test.ts:806` was the only failing test in the repository. B8 derived its
probe instants from `UsageFixtures.readEffectiveRangeBounds`, a helper that asked the database
where the window *would* land — and it asked by binding a JS `Date` cast to `timestamp`
(`integration.fixtures.ts:198`), which is the very shape S-18 removed from
`usage.repository.ts`. So the helper kept reporting a `+05:30` window on a server whose
session is `Asia/Kolkata` while production had moved to UTC, and B8 seeded its probe rows
5½ hours off the bounds it then asked for. Observed failure:

```
- Expected
+ Received
  Array [
    "boundary.at-lower-bound",
-   "boundary.below-upper-bound",
+   "boundary.below-lower-bound",
  ]
```

A test helper that re-implements the defect is worse than one that hard-codes an offset,
because it tracks the bug rather than a machine.

#### B8's new shape

`readEffectiveRangeBounds` and its `EffectiveRangeBounds` interface are **deleted**, not fixed.
B8 was the only caller (`grep -rn readEffectiveRangeBounds apps packages --include=*.ts`), and a
"fixed" version would have been a helper with no caller whose only purpose was to restate a
constant. The contract is now asserted directly against fixed instants: a row exactly at `from`
is in, one millisecond below `from` is out, one millisecond below `to` is in, and a row exactly
at `to` is out.

Two things make it evidence rather than assertion:

1. **It runs under two pinned session zones**, `UTC` and `Asia/Kolkata`, as an `it.each`. Under
   `UTC` — CI's own `postgres:16-alpine` default — the correct predicate and the one S-18
   replaced return the same rows, so a UTC-only case cannot fail for this defect. The pin is
   explicit rather than ambient for the same reason: this host's server session is
   `Asia/Kolkata` and CI's is `UTC`, so an ambient suite tests a different thing in each place.
   Getting a second zone into the HTTP stack needs a second app, because `src/lib/prisma.ts`
   memoises one client on `globalThis` and `src/config/container.ts` imports it directly —
   `buildZonePinnedApp` documents that seam.
2. **Two "B8 preflight" cases read `current_setting('TimeZone')` back** through each app's own
   connection. Replacing `options=-c timezone=<z>` with the bare `?timezone=<z>` form made both
   connections report `Asia/Kolkata` and failed the UTC preflight with
   `expected 'Asia/Kolkata' to be 'UTC'` — so the bare form is accepted and ignored, and the
   preflight is what stops that from silently collapsing both legs onto one zone. Note it takes
   *both* preflight cases: under that mutation the `Asia/Kolkata` case still passed, because
   this host's server zone happens to equal it. On CI the two swap roles.

#### Mutation results, including the one that did not go the expected way

| Mutation to `src/` | B8 UTC | B8 `Asia/Kolkata` |
|---|---|---|
| `"periodStart" >= …` → `>` | FAIL | FAIL |
| `"periodStart" < …` → `<=` | FAIL | FAIL |
| `utcTimestampBound` → a bound JS `Date` (pre-S-18) | pass | **pass** |
| drop `withTenant`'s UTC `TimeZone` pin | pass | **pass** |
| both of the last two together | pass | **FAIL** |

The two middle rows were expected to be kills and are not. S-18 shipped **two independent
guards** — a naive-cast bound in `usage.repository.ts` and a transaction-local session pin in
`base.repository.ts` — and either alone is sufficient, so no behavioural test can kill one while
the other stands. B8 kills the conjunction. Whether each guard is individually present is a
code-level question; `usage.timezone.integration.test.ts` asserts the pin directly through its
`SessionProbeRepository`. B8's inline comment records this table rather than the claim that was
written before it was measured.

#### Re-checking the rest of the suite

Run with **both** S-18 guards removed, the whole 30-case suite reports exactly one failure —
B8's `Asia/Kolkata` leg. No other case's expectation was shaped by the shift; the wide default
window insulated them from it, which is why they passed on defective code and why they assert
the right thing now. The `RANGE_FROM`/`RANGE_TO` comment has been rewritten to say that: the
margin exists so a bucketing, pagination, precision or isolation case is not decided by a range
edge, and it explicitly records that the absorption of the S-18 shift is no longer what it is
for. The window is unchanged — narrowing it would churn 24 cases for no assertion gained.

Non-vacuity of the bucket side was checked separately, because the range mutations do not reach
it: `DATE_TRUNC('day', …)` → `DATE_TRUNC('hour', …)` fails 6 cases (B1, B4, B5, B9, C1, C2).

One finding about the committed S-18 suite, reported rather than filed: applying
`AT TIME ZONE 'UTC'` to the **column** — the wrong fix its own docstring at
`usage.timezone.integration.test.ts:429-431` says that case guards against — leaves all 17 of
its cases and all 30 of this suite's passing. It is only caught when the `withTenant` UTC pin is
*also* removed (then 2 of 17 fail). The comment's claim is conditionally true and overstates what
the test demonstrates.

#### Files, round 2

| Path | Change |
|---|---|
| `apps/usage-service/tests/usage.integration.test.ts` | B8 rewritten as two zone-pinned cases + two preflight cases; zone-pinned app registry; `requestSummaryVia`; `shiftIso` |
| `apps/usage-service/tests/integration.fixtures.ts` | `readEffectiveRangeBounds` and `EffectiveRangeBounds` deleted; unused `Prisma` value import dropped |
| `apps/usage-service/tests/integration.constants.ts` | `INTEGRATION_SESSION_TIME_ZONE`, `INTEGRATION_CONNECTION`, `INTEGRATION_COUNTS.QUAD`; boundary metric keys renamed to the contract; `RANGE_FROM`/`RANGE_TO` rationale rewritten |
| `.claude/rules/known-gaps.md` | S-16/S-17 references corrected after re-verification; **S-19** and **S-20** added |
| `docs/plans/t-036-usage-service-integration-tests.md` | §11 checklist, this record |

Nothing under `apps/usage-service/src/`, `packages/`, `prisma/`, `docker/`, `.github/` or
`turbo.json` changed. All five mutation experiments were reverted and verified with `diff` and
`git diff --stat apps/usage-service/src` (empty).

#### Gate, round 2

`pnpm test --force` — **13/13 tasks, no exclusions, 12.3-17.6 s** across three runs.
usage-service **19 files / 229 tests**; the 18-file / 199-test baseline at `3588bf1` is
unchanged and this suite's 30 are the whole delta. `pnpm build --force`, `pnpm lint --force`
(0 errors, 14 pre-existing warnings in two files neither of which this change touches) and
`pnpm typecheck --force` are 13/13. `usage.timezone.integration.test.ts` 17/17 and
`rls.enforcement.integration.test.ts` 7/7, both untouched.

Database left as found: 2 `Tenant`, 2 `User`, 0 `RefreshToken`, 0 `Event`, 0 `UsageLine`, with
the same two pre-existing tenant ids. Redis logical DB 15 is empty. `pnpm format:check` remains
excluded per S-12.

---

## 25) Gate 3 round 3 — Senior Reviewer CONDITIONAL, conditions discharged

Base `3588bf1`, still nothing committed. Review:
`docs/reviews/t-036-usage-service-integration-tests.md` — verdict **CONDITIONAL**, four MEDIUM
findings (all of them claims the change made about itself), seven LOWs, one NIT. No test was
found broken and no assertion wrong.

### MEDIUM-1 — the service connection could fall back to the owner, and the role was never asserted

Two changes, because the fallback and the missing assertion are separate failures.

1. `integration.constants.ts` gains `INTEGRATION_APP_DATABASE_URL_FALLBACK`
   (`telemetry_app`, matching `tests/setup.ts:5-6` and `.github/workflows/ci.yml:15`) and
   `INTEGRATION_DATABASE_ROLE.APP`. `usage.integration.test.ts` uses the app fallback for the
   **service** connection; `INTEGRATION_ADMIN_DATABASE_URL_FALLBACK` is now referenced only by
   `integration.fixtures.ts`, i.e. fixtures only. The misplaced
   "Runtime (least-privilege) connection default" docblock, which sat on the **Redis** URL, now
   sits on the database URL it describes; the Redis constant says "Redis connection default".
2. A new case **D0**, first in the isolation `describe`, reads `rolname`/`rolsuper`/
   `rolbypassrls` for `current_user` **through the app's own Prisma client** and asserts
   `telemetry_app` / `false` / `false`. `readConnectedRole` throws when `pg_roles` returns no
   row, so the case cannot pass vacuously.

**Non-vacuity, measured in two forms** (a superuser kills the attribute assertions; a *different*
least-privilege role is needed to kill the name assertion, because `rolsuper` fails first):

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/telemetry
  Tests  1 failed | 30 passed (31)
  × D0 … → role postgres is a superuser; RLS cannot enforce: expected true to be false

DATABASE_URL=postgresql://telemetry_auth_app:…@localhost:5432/telemetry   (-t "D0")
  Tests  1 failed | 30 skipped (31)
  × D0 … → expected 'telemetry_auth_app' to be 'telemetry_app'
```

The first run is also the evidence for the reviewer's underlying point: under the owner role
**D1 and D2 pass**. Exactly one case in the file can see that RLS has been switched off, and it
is the one added here.

### MEDIUM-2/3/4 — three comments restated to what the cases prove

Each rewritten claim was measured here, not inherited from the review.

| Finding | The comment now claims | Establishing command / result |
|---|---|---|
| MEDIUM-2 (`seedBothTenants`) | D1/D2 prove the **composite** of the bound predicate and RLS and cannot separate them; the predicate alone is `usage.repository.unit.test.ts:202-207`, RLS alone is `rls.enforcement.integration.test.ts`; do not delete the predicate expecting this case to catch it | `buildFilters` → `WHERE ${tenantId} IS NOT NULL AND …`; `vitest run tests/usage.integration.test.ts` → **31 passed (31)** |
| MEDIUM-3 (`expectQuantitiesAreExactStrings` docblock + C3 title) | the raw-body regex rejects an **unquoted** value — a `number` or `null` — and a `Prisma.Decimal` is indistinguishable here because `decimal.js` defines `toJSON`; the Decimal invariant is covered at `usage.repository.unit.test.ts:398` and `usage.timezone.integration.test.ts:473` | four `JSON.stringify` forms at Prisma 6.19.3 all render a Decimal **quoted**; `toQuantityString` → `value as unknown as string` gives `usage.integration.test.ts` **31 passed**, `usage.repository.unit.test.ts` 2 failed, `usage.timezone.integration.test.ts` 1 failed |
| MEDIUM-4 (`PRIMARY_SESSION_TIME_ZONE`) | non-UTC **by choice**, so the connection differs from CI's default; `withTenant` re-pins to UTC transaction-locally, so this pin is only observable when that pin is absent — pointing at the measured table on B8 | all three mutants re-run at 31 cases rather than carried over from round 2: `utcTimestampBound`→bound `Date` **31/31 pass**; `base.repository.ts:111` pin deleted **31/31 pass**; both together **1 failed \| 30 passed**, the failure being `B8 … under session time zone Asia/Kolkata` |

C3's title changes from "returns every totalQuantity as a string, never a Decimal or a number"
to "returns every totalQuantity as an exact decimal string, with no float rendering" — the
"never a Decimal" half was the part the case cannot support.

### LOWs and the NIT

| # | Change |
|---|---|
| LOW-1 | `usage.repository.ts:72` → `:141` in the helper docblock; §24 gains a paragraph dating §13-23's anchors to `3374cf9` and listing current positions |
| LOW-2 | `known-gaps.md` S-17: "seven lines" → "eight lines … the declaration, two stale `dist` declarations, one import and four call sites". Re-measured: `grep -rn "generateIdempotencyKey" apps packages --include=*.ts \| wc -l` → `8` |
| LOW-3 | `SEED_EVENT_UNIT` deleted; `integration.fixtures.ts` imports `INTEGRATION_FIXTURE.EVENT_UNIT` |
| LOW-4 | `INTEGRATION_FIXTURE.SOURCE_ID` and `INTEGRATION_QUANTITIES.EXPECTED_TWO` deleted (both confirmed unreferenced; every other quantity constant has 1-14 references) |
| LOW-5 | `afterAll` restores `REDIS_URL` and `REDIS_STREAM_NAME` as well as `DATABASE_URL`, deleting rather than blanking them when they were unset, with the `pool: "forks"` reasoning inline |
| LOW-6 | §11 records four authorised `known-gaps.md` entries across two rounds, not two |
| LOW-7 | S-19 gains the auth-service resolver paragraph (`user.repository.ts:246-251`, `:258-266` run outside `withTenantContext`) and the `"app.tenant_id"` duplication paragraph |
| NIT | `INTEGRATION_ID_PREFIX = "t036-"` replaces the literal at all four sites |

### Two S-18 follow-ups — reported, not filed and not fixed

No `known-gaps.md` entry: the authorisation was spent on S-16/S-17/S-19/S-20, and both items are
about `usage.timezone.integration.test.ts`, a **committed** file.

1. **`usage.timezone.integration.test.ts:429-431`'s "guard against fixing the column" comment is
   misattached and unqualified.** The reviewer's adjudication is right and this implementer's
   round-2 mutation was correctly aimed: with `withTenant`'s UTC pin present, `AT TIME ZONE 'UTC'`
   on the column is a no-op and 47/47 pass. Sharper than round 2 recorded — with the pin *also*
   removed, the failure inside that file is at `:466`, the cross-zone equality loop, not the
   literal-value block the comment sits above. On the committed tree the column mistake is caught
   by neither suite.
2. **The S-18 regression suite does not isolate the S-18 bound fix.** Reverting
   `utcTimestampBound` to a bound JS `Date` leaves it 17/17 green; only the conjunction with the
   pin removal fails. Its docstring's "fails on the unfixed code on **any** server" overstates
   that.

### Files, round 3

| Path | Change |
|---|---|
| `apps/usage-service/tests/usage.integration.test.ts` | D0 + `readConnectedRole` + `RoleAttributes`; app-role fallback; three comments corrected; C3 retitled; `afterAll` env restore; `INTEGRATION_ID_PREFIX` |
| `apps/usage-service/tests/integration.constants.ts` | `INTEGRATION_APP_DATABASE_URL_FALLBACK`, `INTEGRATION_DATABASE_ROLE`, `INTEGRATION_ID_PREFIX`; docblocks corrected; two dead constants deleted |
| `apps/usage-service/tests/integration.fixtures.ts` | `SEED_EVENT_UNIT` deleted; prefix constant adopted |
| `.claude/rules/known-gaps.md` | S-17 count; S-19 two paragraphs |
| `docs/plans/t-036-usage-service-integration-tests.md` | §11, §18, §24 anchor note, this section |

`git diff --stat apps/usage-service/src packages prisma` is empty. Both mutation experiments were
reverted from a byte-level backup and verified with `md5sum -c`.
