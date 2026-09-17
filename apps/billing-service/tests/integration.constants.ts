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

/**
 * Fixture vocabulary for the late-usage absorption cases (S-45, BI22-BI26).
 *
 * The defining property of a "late" row is **when it is seeded**, not what it contains: every
 * case below inserts it *after* the period's invoice already exists, because seeding it first
 * lets the first generate bill it and the ordering under test never runs (plan section 4.1).
 * The instant itself is ordinary -- inside `[PERIOD_START, PERIOD_END)`, exactly like any other
 * usage row. That is the point: worker stamps a `UsageLine` with the event's own instant
 * (`apps/worker-service/src/validators/stream-message.validator.ts`), so processing lag alone
 * puts a row behind a closed window.
 *
 * Amounts are derived from `INTEGRATION_FIXTURE`'s rates rather than restated: the late row is
 * `LATE_QUANTITY_API` at `UNIT_PRICE_API`, and `EXPECTED_TOTAL_AFTER_ABSORB` is
 * `EXPECTED_TOTAL` plus that. They are written out because the assertion must be able to fail
 * -- a test that recomputes the production arithmetic asserts nothing.
 */
export const INTEGRATION_LATE_USAGE = {
  /** Inside the window, and seeded after the invoice for that window exists. */
  INSTANT: "2026-01-25T09:00:00.000Z",
  /**
   * A second late instant, inside the same window, so a case can seed **two** distinct late
   * rows. Used by `BI27`, whose rollback needs one row the transaction marks billed and one
   * the concurrent writer already marked, at instants a reader can tell apart.
   *
   * Its original comment said "for the case that absorbs twice". No such case exists, and none
   * was ever written -- corrected at Gate 4 (review LOW-1) rather than left describing a test a
   * reader would go looking for.
   */
  INSTANT_SECOND: "2026-01-26T09:00:00.000Z",
  LATE_QUANTITY_API: "200.000000",
  /** 12.5 + 2 */
  EXPECTED_TOTAL_AFTER_ABSORB: "14.5",
  /** The two lines the first generate wrote, plus the one the absorption appended (D2). */
  EXPECTED_LINE_ITEMS_AFTER_ABSORB: 3,
  /** Tenant B's own usage in the same window, so BI24 has two invoices to confuse. */
  TENANT_B_QUANTITY_API: "300.000000",
  /** 3 + 2 */
  TENANT_B_EXPECTED_TOTAL_AFTER_ABSORB: "5",
  /**
   * BI23's refusal fixture: an invoice this platform cannot produce.
   *
   * `createDraftInvoice` writes `DRAFT` and is the only statement that sets `Invoice.status`
   * anywhere, so `FINALIZED` has no HTTP spelling and the row must be seeded through the owner
   * connection. Until T-048 ships, that fixture is the only thing standing behind the
   * `INVOICE_IMMUTABLE` branch.
   */
  FINALIZED_TOTAL: "7.000000",
  /**
   * BI25's precision pair, measured at Gate 1 through the real client (plan probe I):
   * `1234567.123456 + 0.000001` persists as `1234567.123457`. The addition happens in
   * PostgreSQL `numeric`, because Prisma's `{ increment }` compiles to
   * `SET "totalAmount" = ("totalAmount" + $1)`.
   *
   * **This pair does not refute a JavaScript addition, and saying it did would be wrong.**
   * Measured here: `String(Number("1234567.123456") + Number("0.000001"))` is
   * `"1234567.123457"` -- the same string. What BI25 pins is that the value survives the
   * absorption exactly at the `Decimal(18,6)` boundary and that no `Prisma.Decimal` leaves the
   * repository; the reason to keep the arithmetic in SQL is that it does not race a concurrent
   * absorber (D4), not that this particular sum drifts. (A value that *does* drift, if a later
   * case wants one: `String(Number("123456789012.123456") + Number("0.000001"))` is
   * `"123456789012.12346"`, six digits short -- which is why `INTEGRATION_INVOICE_LIST` picked
   * that width for its own read round trip.)
   */
  SEED_TOTAL_PRECISE: "1234567.123456",
  EXPECTED_TOTAL_PRECISE_AFTER_ABSORB: "1234567.123457",
  /** `BULK_QUANTITY` (1) x `UNIT_PRICE_PRECISE` (0.000001). */
  EXPECTED_DELTA_PRECISE: "0.000001",
  /**
   * `BI27`'s rollback fixture: **two** late `api.request` rows at `LATE_QUANTITY_API`, so one
   * can be billed by a concurrent writer while the other must be observed rolling back to
   * `billed = false`. 2 x 200 x `UNIT_PRICE_API` (0.01).
   *
   * Written out rather than recomputed, for the reason this block's docblock gives: a test that
   * re-derives the production arithmetic cannot fail.
   */
  ROLLBACK_DELTA: "4",
  /** 2 x `LATE_QUANTITY_API`, the quantity the single appended line item would have carried. */
  ROLLBACK_LINE_QUANTITY: "400.000000"
} as const;
