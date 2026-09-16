/**
 * Test-scoped constants for `billing.integration.test.ts`.
 *
 * Nothing that already exists in `src/` is re-typed here: route paths, header names, HTTP
 * status codes, error codes and the invoice status are imported from `../src/constants` by the
 * suite itself (`.claude/rules/constants.md` applies to tests). What lives here is the
 * *fixture* vocabulary -- ids, instants, quantities, prices -- plus the two connection
 * defaults, which mirror `tests/setup.ts`.
 *
 * Flat in `tests/`, matching `apps/usage-service/tests/integration.constants.ts`.
 */

/**
 * Owner connection default, matching `tests/setup.ts`. **Fixtures only.** This role is
 * `rolsuper`/`rolbypassrls`, so a service pointed at it has no RLS at all.
 */
export const INTEGRATION_ADMIN_DATABASE_URL_FALLBACK =
  "postgresql://postgres:postgres@localhost:5432/telemetry";

/**
 * Runtime (least-privilege) connection default for the service under test, matching
 * `tests/setup.ts` and `.github/workflows/ci.yml`.
 *
 * Separate from the owner fallback on purpose: if the service connection fell back to the
 * owner, RLS would be inert and the isolation case would pass on the repository's
 * application-layer predicate alone -- green while proving nothing.
 */
export const INTEGRATION_APP_DATABASE_URL_FALLBACK =
  "postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry";

/** The role the service connection must resolve to, asserted rather than assumed. */
export const INTEGRATION_DATABASE_ROLE = {
  APP: "telemetry_app"
} as const;

/**
 * The session zone BI7 pins on its own connection.
 *
 * Not ambient. This host's PostgreSQL runs `TimeZone = Asia/Kolkata` from its configuration
 * file, while CI's `postgres:16-alpine` defaults to `UTC` -- and under `UTC` a bound JS `Date`
 * and a UTC-normalised bound resolve identically, so a suite that used whatever the server
 * happened to default to would assert nothing in CI. `options=-c timezone=…` is the spelling
 * measured to work at Prisma 6.19.3; a bare `?timezone=…` is accepted and silently ignored.
 */
export const INTEGRATION_SESSION_TIME_ZONE = {
  AHEAD_OF_UTC: "Asia/Kolkata",
  OPTION_PREFIX: "-c timezone="
} as const;

/** Stable, collectable prefix for every row this suite creates (S-20's lesson). */
export const INTEGRATION_ID_PREFIX = "t045-billing-integration-";

/**
 * Tenant ids for the suite.
 *
 * Fixed UUIDs rather than the prefixed string ids used for events, meters and usage lines:
 * `Tenant.id` reaches the endpoint through `tenantIdSchema`, which is `uuidSchema` branded, so
 * a readable non-UUID id is rejected with `400` before any repository is constructed. They are
 * constants rather than `randomUUID()` so an earlier run's residue is collectable by exact id
 * -- S-20 is the worked example of a run-unique filter that can never match a previous run.
 */
export const INTEGRATION_TENANT = {
  A: "0450a5e0-0000-4000-8000-000000000001",
  B: "0450a5e0-0000-4000-8000-000000000002"
} as const;

export const INTEGRATION_FIXTURE = {
  TENANT_NAME: "T-045 billing integration tenant",
  EVENT_UNIT: "count",
  METRIC_API: "api.request",
  METRIC_STORAGE: "storage.gb",
  METRIC_UNMETERED: "unmetered.metric",
  CURRENCY_USD: "USD",
  CURRENCY_EUR: "EUR",
  /** Inside the billing period. */
  PERIOD_START: "2026-01-01T00:00:00.000Z",
  PERIOD_END: "2026-02-01T00:00:00.000Z",
  USAGE_INSTANT_EARLY: "2026-01-05T10:00:00.000Z",
  USAGE_INSTANT_LATE: "2026-01-20T18:30:00.000Z",
  /** Exactly the exclusive upper bound: must fall outside a half-open `[start, end)` window. */
  USAGE_INSTANT_AT_PERIOD_END: "2026-02-01T00:00:00.000Z",
  /** Before the inclusive lower bound. */
  USAGE_INSTANT_BEFORE_PERIOD: "2025-12-31T23:59:59.999Z",
  /** The rate card is in force from before the period and never expires. */
  METER_ACTIVE_FROM: "2025-01-01T00:00:00.000Z",
  /**
   * Rate-card vocabulary for BI13, the meter-selection boundary case.
   *
   * Selection is as of `periodStart` and the window is half-open `[activeFrom, activeTo)`:
   * `activeFrom` is inclusive (`lte`), `activeTo` is exclusive (`gt`). That asymmetry is what
   * lets consecutive rate cards tile with no gap and no overlap — a meter whose `activeTo` is
   * exactly the instant another's `activeFrom` begins has already expired, so exactly one
   * applies at the boundary, by construction rather than by tie-break.
   *
   * Four decoys, each ruled out by a different clause:
   * - superseded: expired exactly at `periodStart` (`activeTo` exclusivity, at the boundary);
   * - future: starts mid-period, after `periodStart` (`activeFrom <= asOf`, as-of not any-time);
   * - expired promo: a *later* `activeFrom` than the correct meter but already ended, so it
   *   would win the `orderBy activeFrom desc` tie-break if the `activeTo` bound were dropped.
   */
  METER_SUPERSEDED_UNIT_PRICE: "0.020000",
  METER_FUTURE_UNIT_PRICE: "0.050000",
  METER_EXPIRED_PROMO_UNIT_PRICE: "0.070000",
  METER_FUTURE_ACTIVE_FROM: "2026-01-15T00:00:00.000Z",
  METER_PROMO_ACTIVE_FROM: "2025-07-01T00:00:00.000Z",
  METER_PROMO_ACTIVE_TO: "2025-12-01T00:00:00.000Z",
  QUANTITY_API: "1000.000000",
  QUANTITY_STORAGE: "5.000000",
  UNIT_PRICE_API: "0.010000",
  UNIT_PRICE_STORAGE: "0.500000",
  /** 1000 x 0.01 + 5 x 0.5 */
  EXPECTED_TOTAL: "12.5",
  EXPECTED_AMOUNT_API: "10",
  EXPECTED_AMOUNT_STORAGE: "2.5",
  /**
   * Bulk fixture size for BI11: one past twice the billed-update chunk, so the update spans
   * three chunks and the last one is partial. Derived from the production constant rather than
   * written as a number, so changing the chunk moves the case with it.
   */
  BULK_UNIT_PRICE: "0.001000",
  BULK_QUANTITY: "1.000000",
  /**
   * One past the measured `P2035` ceiling (32 764 ids pass, 32 765 raise). BI12 drives this many
   * ids straight through `createDraftInvoice`; unchunked it is `P2035`, chunked it reaches the
   * count assertion.
   */
  IDS_ONE_PAST_BIND_CEILING: 32765,
  /** `Decimal(18,6)` precision case: float would give 1.2345671234559998. */
  QUANTITY_PRECISE: "1234567.123456",
  UNIT_PRICE_PRECISE: "0.000001",
  EXPECTED_PRECISE_AMOUNT: "1.234567"
} as const;

/**
 * Fixture vocabulary for the `GET /v1/billing/invoices` cases (T-046, BI14-BI21).
 *
 * Three distinct billing periods in ascending order, so the newest-first sort (D4) is
 * observable rather than accidental, plus a fourth invoice that **shares** `JAN_START` with
 * the first and differs only in its `periodEnd`.
 *
 * That collision is legal -- `Invoice @@unique([tenantId, periodStart, periodEnd])` keys on
 * all three columns -- and it is the whole reason the sort carries an `id` tie-break. With
 * `ORDER BY "periodStart" DESC` alone, PostgreSQL may return the two colliding rows in either
 * order between one `LIMIT/OFFSET` query and the next, which silently skips one row and
 * repeats another across a page boundary. BI16 walks the pages one at a time and asserts the
 * union is exactly the seeded set.
 *
 * `TOTAL_PRECISE` is the `Decimal(18,6)` case, and the value is chosen rather than copied.
 * T-045's `QUANTITY_PRECISE` is `"1234567.123456"`, whose comment about losing precision is
 * about the *multiplication* it feeds, not about a read: measured,
 * `String(Number("1234567.123456"))` is `"1234567.123456"` -- lossless, so that value would
 * make a read round trip prove nothing. `"123456789012.123456"` is 18 significant digits, the
 * full width of `Decimal(18,6)`, and measured `String(Number(...))` gives
 * `"123456789012.12346"` -- six digits short. An implementation that let the value become a
 * JS number therefore cannot return the seeded string.
 */
export const INTEGRATION_INVOICE_LIST = {
  JAN_START: "2026-01-01T00:00:00.000Z",
  JAN_END: "2026-02-01T00:00:00.000Z",
  /** Same `periodStart` as JAN, different `periodEnd` -- the sort tie-break case. */
  JAN_END_ALTERNATE: "2026-02-15T00:00:00.000Z",
  FEB_START: "2026-02-01T00:00:00.000Z",
  FEB_END: "2026-03-01T00:00:00.000Z",
  MAR_START: "2026-03-01T00:00:00.000Z",
  MAR_END: "2026-04-01T00:00:00.000Z",
  FINALIZED_AT: "2026-04-02T12:00:00.000Z",
  TOTAL_JAN: "10.500000",
  TOTAL_JAN_ALTERNATE: "11.500000",
  TOTAL_FEB: "20.250000",
  TOTAL_MAR: "30.000000",
  TOTAL_TENANT_B: "99.000000",
  /** Measured: `String(Number("123456789012.123456"))` -> `"123456789012.12346"`. */
  TOTAL_PRECISE: "123456789012.123456",
  /** What a double round trip degrades `TOTAL_PRECISE` to. Measured, not derived. */
  TOTAL_PRECISE_AFTER_FLOAT_ROUND_TRIP: "123456789012.12346",
  PAGE_SIZE_ONE: 1,
  PAGE_SIZE_TWO: 2,
  SEEDED_COUNT: 3,
  QUERY_KEY_STATUS: "status",
  QUERY_KEY_PAGE: "page",
  QUERY_KEY_PAGE_SIZE: "pageSize",
  TENANT_ID_NOT_A_UUID: "not-a-uuid",
  WRONG_INTERNAL_SECRET: "wrong-internal-secret",
  /** A tenant that exists but owns no invoice: the empty-list case must be 200, not 404. */
  EXPECTED_EMPTY_TOTAL: 0
} as const;
