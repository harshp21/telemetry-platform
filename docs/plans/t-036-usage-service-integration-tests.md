# T-036 Implementation Plan: Usage Service Integration Tests

Plan file path: docs/plans/t-036-usage-service-integration-tests.md

Task spec: [docs/epics/epic-6-usage-service.md](../epics/epic-6-usage-service.md) lines 186-199
Target file: `apps/usage-service/tests/usage.integration.test.ts`
Milestone: v1

---

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
- [pending] **User approval of this plan** ← blocking gate
- [pending] Slice 0 — verify Prisma client generation
- [pending] Slice 1 — test constants module
- [pending] Slice 2 — DB harness (bootstrap, FK-safe reset, seeds, probe role)
- [pending] Slice 3 — Redis harness
- [pending] Slice 4 — suite skeleton; confirm every case FAILS before assertions
- [pending] Slice 5 — ingestion cases A1-A11
- [pending] Slice 6 — summary cases B1-B12
- [pending] Slice 7 — Decimal precision cases C1-C3
- [pending] Slice 8 — tenant isolation cases D1-D6
- [pending] Slice 9 — query-plan diagnostic E1-E2 (optional)
- [pending] Slice 10 — vitest config split, scripts, turbo task, CI step, compose, `.env.example`
- [pending] Slice 11 — task-scoped validation, then full gate
- [pending] File follow-ups F-1 … F-5
- [pending] Hand off to Senior Reviewer (pre-QA)

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
