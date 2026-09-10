import { DATABASE_SESSION_SETTINGS, USAGE_SUMMARY_CONSTANTS } from "../src/constants";
import { INGESTION_CONSTANTS } from "../src/validators/events.validator";

/**
 * Test-scoped constants for `usage.integration.test.ts`.
 *
 * Nothing that already exists in `src/` is re-typed here: route paths, header names, HTTP
 * status codes, error codes, granularities and pagination defaults are imported from
 * `../src/constants` and `../src/validators/events.validator` by the suite itself
 * (`.claude/rules/constants.md` applies to tests). What lives here is only the *fixture*
 * vocabulary — instants, quantities, metric keys — plus values derived from service
 * constants so the derivation cannot drift.
 *
 * Flat in `tests/`, matching `apps/auth-service/tests/database-urls.ts`.
 */

/**
 * Owner connection default, matching `tests/setup.ts:8` and
 * `apps/auth-service/tests/database-urls.ts`. **Fixtures only.** This role is `rolsuper` and
 * `rolbypassrls`, so a service pointed at it has no RLS at all — see
 * `INTEGRATION_APP_DATABASE_URL_FALLBACK`.
 */
export const INTEGRATION_ADMIN_DATABASE_URL_FALLBACK =
  "postgresql://postgres:postgres@localhost:5432/telemetry";

/**
 * Runtime (least-privilege) connection default for the service under test, matching
 * `tests/setup.ts:5-6`, `apps/auth-service/tests/database-urls.ts` (`SHARED_APP`) and
 * `.github/workflows/ci.yml:15`.
 *
 * Separate from the owner fallback on purpose. If the service connection ever fell back to
 * the owner, RLS would be inert and the isolation cases would still pass on the repository's
 * application-layer `WHERE "tenantId" = $1` predicate alone — green while proving nothing.
 * `INTEGRATION_DATABASE_ROLE` is what turns that from a comment into an assertion.
 */
export const INTEGRATION_APP_DATABASE_URL_FALLBACK =
  "postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry";

/**
 * The role the service connection must resolve to.
 *
 * Asserted, not assumed — the suite reads `current_user` back out of `pg_roles`. Named
 * rather than only attribute-checked, mirroring
 * `apps/auth-service/tests/rls.integration.test.ts:132-139`: "not merely some restricted
 * role". `telemetry_app` is the role `.claude/rules/tenant-isolation.md` names for the four
 * non-auth services that hold a database client, and it is what both `tests/setup.ts` and CI
 * set `DATABASE_URL` to. (The rule's table listed gateway too; gateway has no Prisma client
 * and never reads `DATABASE_URL` — corrected there in this change.)
 */
export const INTEGRATION_DATABASE_ROLE = {
  APP: "telemetry_app"
} as const;

/** Redis connection default, matching `tests/setup.ts:9`. */
export const INTEGRATION_REDIS_URL_FALLBACK = "redis://localhost:6379";

export const INTEGRATION_REDIS = {
  /**
   * Redis logical database reserved for this suite. Verified empty on the development
   * machine (`redis-cli info keyspace` → `db0`, `db6` only; `redis-cli -n 15 dbsize` → 0)
   * and unused in CI, which starts a fresh `redis:7-alpine`. The suite issues `FLUSHDB`
   * against this index and never `FLUSHALL`.
   */
  LOGICAL_DB_INDEX: 15,
  /** Per-run stream name prefix, so `XADD`s never mix with another consumer's stream. */
  STREAM_NAME_PREFIX: "telemetry:events:test:"
} as const;

/**
 * Database session time zones this suite pins its HTTP connections to.
 *
 * Not ambient. The local PostgreSQL's own session zone is `Asia/Kolkata`
 * (`SHOW TimeZone` -> `Asia/Kolkata`) while CI's `postgres:16-alpine` is `UTC`, so a suite
 * that used whatever the server happened to default to would be a non-UTC test here and a
 * UTC-only test in CI — and under `UTC` the correct half-open range predicate and the
 * session-dependent one that S-18 fixed return the same rows, so the CI leg alone cannot
 * distinguish them.
 *
 * Every case in the suite therefore runs on `AHEAD_OF_UTC`, and the boundary case runs on
 * both. `usage.timezone.integration.test.ts` owns the wider zone matrix at the repository
 * level; this file's job is the composed HTTP stack.
 */
export const INTEGRATION_SESSION_TIME_ZONE = {
  UTC: DATABASE_SESSION_SETTINGS.TIME_ZONE_UTC,
  AHEAD_OF_UTC: "Asia/Kolkata"
} as const;

/**
 * How a session zone is pinned onto a PostgreSQL connection URL.
 *
 * `options=-c timezone=…` is the spelling `usage.timezone.integration.test.ts` measured to
 * work at Prisma 6.19.3. The bare `?timezone=…` query-parameter form is accepted and
 * ignored: substituting it made both of this suite's connections report `Asia/Kolkata`, the
 * server's own zone, rather than the requested one. Scope of that observation — one Prisma
 * version, one PostgreSQL build, two zones; it says the bare form did not take, not why.
 *
 * The suite's "B8 preflight" cases read `current_setting('TimeZone')` back through each
 * connection, so a regression in this spelling fails there instead of silently collapsing
 * both boundary legs onto one zone.
 */
export const INTEGRATION_CONNECTION = {
  OPTIONS_PARAM: "options",
  TIME_ZONE_OPTION_PREFIX: "-c timezone="
} as const;

/**
 * Prefix on every identifier this suite creates — seeded rows and idempotency keys alike — so
 * a stray row is attributable to T-036 at a glance and no sibling suite's `deleteMany` scope
 * can overlap it.
 */
export const INTEGRATION_ID_PREFIX = "t036-";

export const INTEGRATION_FIXTURE = {
  TENANT_NAME_A: "T-036 Tenant A",
  TENANT_NAME_B: "T-036 Tenant B",
  METRIC_KEY_PRIMARY: "api.request",
  METRIC_KEY_SECONDARY: "storage.gb",
  EVENT_TYPE: "api.request",
  EVENT_UNIT: "request"
} as const;

/**
 * Fixed instants. Every one is an exact UTC boundary or the last millisecond before one, so
 * a `DATE_TRUNC` result can be asserted as an exact `…Z` string rather than a range.
 *
 * `2026-01-01` is a Thursday; the ISO week containing it starts Monday `2025-12-29`
 * (verified: `date_trunc('week','2026-01-01T12:00:00'::timestamp(3))` → `2025-12-29 00:00:00`).
 */
export const INTEGRATION_INSTANTS = {
  DAY_1_START: "2026-01-01T00:00:00.000Z",
  DAY_1_HOUR_0_END: "2026-01-01T00:59:59.999Z",
  DAY_1_HOUR_1_START: "2026-01-01T01:00:00.000Z",
  DAY_1_HOUR_2_START: "2026-01-01T02:00:00.000Z",
  DAY_1_NOON: "2026-01-01T12:00:00.000Z",
  DAY_1_END: "2026-01-01T23:59:59.999Z",
  DAY_2_START: "2026-01-02T00:00:00.000Z",
  DAY_3_START: "2026-01-03T00:00:00.000Z",
  WEEK_1_START: "2025-12-29T00:00:00.000Z",
  WEEK_2_START: "2026-01-05T00:00:00.000Z",
  WEEK_3_START: "2026-01-12T00:00:00.000Z",
  /**
   * The default query window: a month of margin on each side of every fixture instant above,
   * so no case except B8 has its result decided by a range edge.
   *
   * This is separation of concerns, not an accommodation. B1-B7 are about `DATE_TRUNC`
   * bucketing, B9 about pagination over grouped rows, C1-C3 about `Decimal(18,6)` crossing
   * the API boundary, D1-D2 about the tenant predicate. Each seeds rows on chosen instants
   * and asserts what comes back grouped; if the window clipped one of those instants the case
   * would fail for a reason it is not testing, and the failure would read as a bucketing or
   * precision bug. B8 is the case that owns the range edge, and it places its own probe rows
   * on the bounds it asks for.
   *
   * Note what this window is *not* doing any more: before S-18, `usage.repository.ts` bound
   * `from`/`to` as `timestamptz` against a `timestamp(3) without time zone` column, so the
   * effective window shifted by the database session's offset (+05:30 here). The margin was
   * wide enough to absorb that shift, which meant these cases passed on a defective
   * repository. They no longer rely on it: the suite pins its connection to
   * `INTEGRATION_SESSION_TIME_ZONE.AHEAD_OF_UTC`, and a re-introduced shift is caught by B8.
   */
  RANGE_FROM: "2025-12-01T00:00:00.000Z",
  /** Exclusive upper bound of the default query window. */
  RANGE_TO: "2026-03-01T00:00:00.000Z",
  /** B8 only: the window whose two bounds the boundary probe rows sit exactly on. */
  BOUNDARY_RANGE_FROM: "2026-01-01T00:00:00.000Z",
  BOUNDARY_RANGE_TO: "2026-01-08T00:00:00.000Z",
  /** A range deliberately holding no seeded rows. */
  EMPTY_RANGE_FROM: "2027-01-01T00:00:00.000Z",
  EMPTY_RANGE_TO: "2027-01-08T00:00:00.000Z",
  INVALID_OCCURRED_AT: "not-a-date"
} as const;

/**
 * Fixture quantities, written at the column's own scale (`Decimal(18,6)`).
 *
 * The `EXPECTED_*` values are what `String(Prisma.Decimal)` renders for the corresponding
 * `SUM(numeric(18,6))`, measured through `PrismaClient.$queryRaw` at Prisma 6.19.3 /
 * PostgreSQL 16.13 under `TZ=Asia/Kolkata`, `TZ=America/New_York` and `TZ=UTC`:
 * decimal.js strips trailing zeros, so `0.100000 + 0.200000` renders `"0.3"` and **not**
 * `"0.300000"` even though `psql` prints the latter.
 */
export const INTEGRATION_QUANTITIES = {
  ONE: "1.000000",
  TWO: "2.000000",
  FOUR: "4.000000",
  EXPECTED_ONE: "1",
  EXPECTED_FOUR: "4",
  EXPECTED_ONE_PLUS_TWO: "3",
  TENANT_A: "11.500000",
  TENANT_B: "22.500000",
  EXPECTED_TENANT_A: "11.5",
  EXPECTED_TENANT_B: "22.5",
  /**
   * The two halves of `999999999999.999999`, the largest value `Decimal(18,6)` can hold.
   * A float64 round-trip cannot reproduce 18 significant digits, so an exact match here
   * proves the value never passed through a JS `number`.
   */
  PRECISION_MAX_PART_A: "999999999999.499999",
  PRECISION_MAX_PART_B: "0.500000",
  EXPECTED_PRECISION_MAX: "999999999999.999999",
  FLOAT_TRAP_PART_A: "0.100000",
  FLOAT_TRAP_PART_B: "0.200000",
  EXPECTED_FLOAT_TRAP: "0.3",
  /** The float64 artefact this suite exists to rule out. */
  FLOAT_TRAP_ARTEFACT: "0.30000000000000004"
} as const;

/** Quantity sent over HTTP. `eventPayloadSchema` accepts integers 1..100 only (E-3). */
export const INTEGRATION_INGEST = {
  QUANTITY: 10,
  BATCH_SIZE: 5,
  /** One above the enforced cap, derived so it cannot drift from the validator. */
  OVERSIZED_BATCH_SIZE: INGESTION_CONSTANTS.BATCH_SIZE_MAX + 1,
  /** One minute beyond the tolerance window, in both directions (A6, A8). */
  SKEW_BEYOND_TOLERANCE_SECONDS: INGESTION_CONSTANTS.CLOCK_SKEW_TOLERANCE_SECONDS + 60,
  /** The epic's stated threshold, which the code rejects at the 5-minute mark (A5 / S-5). */
  SKEW_ONE_DAY_SECONDS: 24 * 60 * 60,
  MILLISECONDS_PER_SECOND: 1000
} as const;

/**
 * B8 only. Four probe rows placed on and around the two requested bounds, each with its own
 * `metricKey` so each becomes its own grouped item and its inclusion can be read straight off
 * the response instead of inferred from a total.
 *
 * The names are the contract: `[from, to)`, so `AT_FROM` and `BEFORE_TO` are in while
 * `BEFORE_FROM` and `AT_TO` are out.
 */
export const INTEGRATION_BOUNDARY_PROBE = {
  METRIC_KEY_AT_FROM: "boundary.at-from",
  METRIC_KEY_BEFORE_FROM: "boundary.before-from",
  METRIC_KEY_AT_TO: "boundary.at-to",
  METRIC_KEY_BEFORE_TO: "boundary.before-to",
  /** One millisecond: `periodStart` is `timestamp(3)`, so a millisecond is representable. */
  STEP_MILLIS: 1
} as const;

export const INTEGRATION_PAGINATION = {
  PAGE_TWO: 2,
  PAGE_SIZE_TWO: 2,
  /** One above the accepted maximum, derived from the validator's own bound (B10). */
  OVERSIZED_PAGE_SIZE: USAGE_SUMMARY_CONSTANTS.MAX_PAGE_SIZE + 1
} as const;

/**
 * Small cardinalities, named so no bare numeral appears in an assertion
 * (`.claude/rules/constants.md` applies to tests). Counts that follow from a batch size or a
 * page size are derived from those constants at the call site instead of being listed here.
 */
export const INTEGRATION_COUNTS = {
  NONE: 0,
  SINGLE: 1,
  PAIR: 2,
  TRIPLE: 3,
  QUAD: 4
} as const;
