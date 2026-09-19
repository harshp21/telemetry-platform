import {
  ERROR_RESPONSES,
  INTERNAL_AUTH_HEADERS,
  INTERNAL_AUTH_RESPONSES,
  TENANT_CONTEXT_HEADERS
} from "@telemetry/shared-types";
import { ANALYTICS_SERVICE_STARTUP } from "./startup.constants";

export const ANALYTICS_SERVICE_NAME = "analytics-service";

export const ANALYTICS_ROUTES = {
  HEALTH: "/health",
  /**
   * T-051. Registered **inside** the `app.register` callback in `src/app.ts`, which is what puts
   * it behind the internal-auth guard and the tenant-context hook (S-9).
   *
   * Service-local rather than shared: `grep -n "ROUTES\|/v1/" packages/shared-types/src/index.ts`
   * returns nothing, so there is no shared route vocabulary to derive from, and creating one is
   * not this task's call. Mirrors `USAGE_SERVICE_ROUTES` and `BILLING_ROUTES`.
   */
  METRICS: "/v1/analytics/metrics"
} as const;

/**
 * The two request headers analytics reads, both **derived** from `@telemetry/shared-types` and
 * neither re-typed here (S-9, mirroring `apps/billing-service/src/constants.ts`).
 *
 * `x-tenant-id` in particular: S-39 records that gateway's and usage-service's own constants
 * files still hold the literal, so there are three definitions of that wire string on the tree
 * and analytics deliberately does not become a fourth. Rewiring those two is S-39's own task.
 */
export const ANALYTICS_HEADERS = {
  INTERNAL_SECRET: INTERNAL_AUTH_HEADERS.INTERNAL_SECRET,
  TENANT_ID: TENANT_CONTEXT_HEADERS.TENANT_ID
} as const;

export const ANALYTICS_RESPONSES = {
  STATUS_OK: "ok",
  // The guard's rejection body is `{ code }` with no message, matching billing-service and
  // worker-service rather than usage-service's `{ code, message }` (plan decision D2). An
  // identical response for a *missing* and for a *wrong* secret does not tell an unauthenticated
  // caller whether it guessed the header name.
  CODE_UNAUTHORIZED: INTERNAL_AUTH_RESPONSES.CODE_UNAUTHORIZED,
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_UNAUTHORIZED: 401,
  // Tenant-context vocabulary, matching usage-service's and billing-service's codes, messages
  // and `401` status verbatim. Two codes rather than one: a header that was supplied but
  // malformed is a different diagnosis from one that was never sent, and whoever reads the log
  // needs to tell them apart. Both are only reachable after the caller has proved it is the
  // gateway, so neither leaks anything to an unauthenticated client.
  //
  // These carry a `message`, unlike the guard above, because they travel as `AppError`
  // subclasses through `registerGlobalErrorHandler`, which emits `{ code, message }`.
  CODE_TENANT_CONTEXT_MISSING: "TENANT_CONTEXT_MISSING",
  MESSAGE_TENANT_CONTEXT_MISSING: "X-Tenant-Id header is required",
  CODE_TENANT_CONTEXT_INVALID: "TENANT_CONTEXT_INVALID",
  MESSAGE_TENANT_CONTEXT_INVALID: "X-Tenant-Id header must be a valid UUID",
  // T-051 (plan decision D8). **Both codes are derived, not re-typed** -- `ERROR_RESPONSES`
  // in `@telemetry/shared-types` already declares them, so analytics adds no copy of either
  // string. `.claude/rules/constants.md` asks for promotion before a third copy; these were
  // checked against shared-types first and found already promoted.
  CODE_VALIDATION_ERROR: ERROR_RESPONSES.CODE_VALIDATION_ERROR,
  CODE_INTERNAL_ERROR: ERROR_RESPONSES.CODE_INTERNAL_ERROR,
  // **No `MESSAGE_INTERNAL_ERROR`, deliberately.** usage-service and billing-service each
  // declare `"Internal server error"`, so analytics would have been the third copy of a literal
  // the constants rule says to promote before that point -- and promoting it would put
  // `packages/shared-types` and two other services in an analytics feature diff. Analytics
  // avoids the copy entirely instead: the 500 body is `{ code }` with no message, which is the
  // stance this same object already documents for the guard's 401 above, and it leaks strictly
  // less than a message would. The controller's 400 body does carry a message, but that message
  // is computed from the zod issues rather than being a literal.
  HTTP_STATUS_BAD_REQUEST: 400,
  HTTP_STATUS_INTERNAL_ERROR: 500
} as const;

/**
 * Query values for the `granularity` parameter of `GET /v1/analytics/metrics` (T-051).
 *
 * Lowercase, matching `USAGE_SUMMARY_GRANULARITY` in
 * `apps/usage-service/src/constants.ts` exactly. The uppercase spelling (`HOUR`/`DAY`/`WEEK`) is
 * the **Prisma enum** on `MetricRollup.granularity`, not a wire value; accepting it here would
 * make two endpoints over the same rows disagree about what a granularity is called
 * (plan decision D5). `RollupRepository` owns the one map from this vocabulary to that one.
 */
export const ANALYTICS_GRANULARITY = {
  HOUR: "hour",
  DAY: "day",
  WEEK: "week"
} as const;

export const ANALYTICS_METRICS = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MIN_PAGE: 1,
  MIN_PAGE_SIZE: 1,
  MAX_PAGE_SIZE: 100,
  /**
   * Upper bound on `page` -- plan decision D2, and the one place analytics diverges from the
   * three declarations S-40 records.
   *
   * S-40's subject is that `page` has no `.max()` in usage-service, billing-service or
   * `paginationSchema`, so `(page - 1) * pageSize` can leave the signed 64-bit range and the
   * request answers `500` instead of `400`. analytics mirrors usage-service's **raw**
   * `LIMIT/OFFSET` bind rather than billing's ORM `skip`, so the failure class here is
   * PostgreSQL's `22003 bigint out of range` -- reproduced as `telemetry_app` at Gate 1
   * (`SELECT 1 LIMIT 20 OFFSET 2e19` -> `ERROR:  bigint out of range`, while `OFFSET 1e17`
   * succeeds) and surfaced by Prisma as `P2010`.
   *
   * **Why 10 000 and not the largest arithmetically safe value.** S-40 warns that any ceiling
   * whose product with `MAX_PAGE_SIZE` stays inside 2^63 closes the crash, but that a far
   * smaller one closes it with room to spare and makes the `400` mean something. The largest
   * offset this permits is `(10000 - 1) * 100 = 999900`, about 9.2e12 times below 2^63. To
   * reach the last page a tenant needs ~1 000 000 grouped `(metricKey, bucket)` rows in one
   * range -- at `hour` granularity that is 114 years of continuous usage for a single metric,
   * or 11 years for ten metrics. So no honest client reaches it and the refusal is a real
   * signal rather than an arithmetic formality.
   *
   * Scoped to analytics on purpose: promoting a bound into `paginationSchema` and rewiring the
   * other two services is S-40's own task, not this one.
   */
  MAX_PAGE: 10_000,
  MESSAGE_INVALID_RANGE: "from must be earlier than to",
  /**
   * Ceiling on how many rows one fallback may write into `MetricRollup` (risk R5).
   *
   * The **read** is never declined -- only the cache write is, and the service logs that it
   * declined. An unbounded `[from, to)` is accepted here exactly as usage-service and
   * billing-service accept one; what is bounded is the write amplification a single request can
   * cause.
   *
   * Named `MAX_CACHED_ROWS` and not the plan's `MAX_CACHED_BUCKETS`, because what it bounds is
   * the number of upserted rows -- one per `(metricKey, bucketStart)` pair -- which exceeds the
   * bucket count by the tenant's metric cardinality. Calling it "buckets" would overstate the
   * range it admits. For scale: one year of `hour` buckets is 8760 (measured with
   * `generate_series` at Gate 1), so this admits a year of hourly data for a single metric.
   */
  MAX_CACHED_ROWS: 10_000
} as const;

/**
 * SQL text fragments used by `RollupRepository`, none of which ever derives from caller input.
 *
 * `UTC_NAIVE_TIMESTAMP_CAST` mirrors `apps/usage-service/src/constants.ts`'s `DATABASE_SQL`.
 * Every application timestamp column on this platform is `timestamp(3) without time zone`, and
 * a bound JS `Date` crosses `$queryRaw` as `timestamptz`, so a bound must be normalized in JS
 * and cast naive or the comparison resolves through the database session zone (S-18,
 * `CLAUDE.md` § *Raw SQL and timestamps*). See `utcTimestampBound` for why both halves matter.
 */
export const ANALYTICS_DATABASE_SQL = {
  UTC_NAIVE_TIMESTAMP_CAST: "::timestamp(3)"
} as const;

export const ANALYTICS_RUNTIME = {
  // Derived rather than repeated (T-050). `src/index.ts` binds
  // `ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT`, and this module's copy is read by
  // `tests/smoke.test.ts:10` in `SMOKE_TARGET=external` mode -- two writers of one number is
  // how `src/config/env.ts` came to declare a third value that disagreed with both. `HOST` is
  // left duplicated against `startup.constants.ts:4` on billing's T-044 precedent: the two
  // agree, and it is not the divergence this task is about.
  DEFAULT_PORT: ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT,
  HOST: "0.0.0.0"
} as const;
