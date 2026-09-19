import { Prisma } from "@prisma/client";
import { TenantScopedRepository } from "./base.repository";
import type { AnalyticsGranularity } from "../validators/metrics-query.validator";
import { ANALYTICS_DATABASE_SQL, ANALYTICS_GRANULARITY } from "../constants";

/**
 * A `[from, to)` window at one granularity, with **no metric dimension at all**.
 *
 * `cacheRange` takes this type and not `MetricsRangeInput`, which is plan decision D3 expressed
 * at the type rather than only in the service: a `metricKey`-filtered cache write is not
 * expressible at this boundary. `AM17d` asserts that with a `@ts-expect-error`, so widening the
 * parameter back fails `pnpm typecheck` rather than failing quietly.
 *
 * Say the guarantee at the strength it holds: this makes the *typed call* a compile error. It
 * does not make a partial write unrepresentable -- SQL is text, and a caller could pre-filter
 * the rows some other way. The service-level refusal (`AM17`) is the other layer.
 */
export interface MetricsCacheInput {
  /** Inclusive lower bound, ISO-8601, offset permitted. */
  readonly from: string;
  /** Exclusive upper bound, ISO-8601, offset permitted. */
  readonly to: string;
  readonly granularity: AnalyticsGranularity;
}

export interface MetricsRangeInput extends MetricsCacheInput {
  readonly metricKey?: string;
}

export interface MetricsPageInput extends MetricsRangeInput {
  readonly page: number;
  readonly pageSize: number;
}

export interface MetricsRollupRow {
  readonly metricKey: string;
  readonly bucketStart: string;
  readonly bucketEnd: string;
  /** A string, never a `Prisma.Decimal` -- `Decimal(18,6)` exceeds IEEE-754 safe precision. */
  readonly totalQuantity: string;
}

export interface MetricsPage {
  readonly rows: MetricsRollupRow[];
  /** Number of GROUPED rows in the range, not the number of underlying usage lines. */
  readonly total: number;
}

/**
 * What the service needs to decide whether the cache may be used for this exact request.
 *
 * All three are read in one statement so they describe one snapshot of the range.
 */
export interface RangeCoverage {
  /** Calendar buckets spanning `[from, to)`, from `generate_series` over the same fragments. */
  readonly expectedBuckets: number;
  /** Distinct `bucketStart` values cached for this tenant, granularity, range **and metric**. */
  readonly cachedBuckets: number;
  /** Whether both bounds fall exactly on a bucket boundary (plan decision D10). */
  readonly bucketAligned: boolean;
}

interface RawMetricsRow {
  metricKey: string;
  bucketStart: Date | string;
  bucketEnd: Date | string;
  totalQuantity: Prisma.Decimal | string | number;
}

interface RawGroupedCountRow {
  total: number;
}

interface RawCoverageRow {
  expectedBuckets: number;
  cachedBuckets: number;
  bucketAligned: boolean;
}

/**
 * Fixed SQL fragments, keyed by the validated granularity enum.
 *
 * Every member is a constant template with **zero interpolation**, so a caller-supplied
 * granularity can only ever select a fragment -- it can never contribute SQL text. This is the
 * "enum variation as a key lookup into constant fragments" shape `CLAUDE.md` § *Raw SQL*
 * requires, and it mirrors `GRANULARITY_SQL` in
 * `apps/usage-service/src/repositories/usage.repository.ts`.
 *
 * ## `unit` -- and why there is no `AT TIME ZONE` anywhere in this file
 *
 * `"UsageLine"."periodStart"` and `"MetricRollup"."bucketStart"` are both
 * `timestamp(3) without time zone` and Prisma persists UTC, so a bare `DATE_TRUNC` yields UTC
 * bucket boundaries with no conversion. `docs/epics/epic-9-analytics-service.md`'s snippet
 * writes `DATE_TRUNC('day', period_start AT TIME ZONE 'UTC')` instead, which on a naive column
 * produces a `timestamptz` and shifts every boundary by the **server** offset. Reproduced at
 * planning on the real `"UsageLine"` table across four session zones: a `2026-03-01 03:00` row
 * buckets as `2026-03-01` under `UTC`, `Asia/Kolkata` and `Asia/Kathmandu`, and as
 * **`2026-02-28`** under `America/New_York`. That is S-53, and T-051 owns the one-line
 * correction to the epic.
 *
 * The *output* side is safe; only the range predicate was ever the problem (S-18), and the two
 * must not be confused. `AT TIME ZONE 'UTC'` on a bound **parameter** is correct and equivalent
 * to `utcTimestampBound`'s cast. On the **column** it is the defect. Fix the bound, never the
 * column.
 *
 * ## `interval` -- one declaration for both tiers
 *
 * `MetricRollup` has `bucketStart` and **no `bucketEnd` column** (checked against
 * `prisma/schema.prisma` and `information_schema.columns`), while the response contract needs
 * both. Rather than add a migration, both tiers derive `bucketEnd` from this one fragment --
 * the cache read as `"bucketStart" + interval` and the `UsageLine` aggregation as
 * `DATE_TRUNC(unit, "periodStart") + interval` -- so the two cannot report different widths for
 * one granularity (plan decision D4). `AI14` is the case that would notice if they did.
 *
 * ## `rollupEnum` -- a cast literal, not a bound string
 *
 * `MetricRollup.granularity` is the PostgreSQL enum `"Granularity"`, whose members are
 * uppercase. A bound `text` compared against it raises `operator does not exist`, so the
 * spelling has to cross as SQL. Keeping it in this same frozen map means the query vocabulary
 * (`hour`/`day`/`week`) and the column vocabulary (`HOUR`/`DAY`/`WEEK`) are translated in
 * exactly one place.
 *
 * Week buckets follow PostgreSQL's ISO-8601 semantics and start on Monday 00:00:00 UTC.
 */
const GRANULARITY_SQL: Readonly<
  Record<
    AnalyticsGranularity,
    {
      readonly unit: Prisma.Sql;
      readonly interval: Prisma.Sql;
      readonly rollupEnum: Prisma.Sql;
    }
  >
> = {
  [ANALYTICS_GRANULARITY.HOUR]: {
    unit: Prisma.sql`'hour'`,
    interval: Prisma.sql`INTERVAL '1 hour'`,
    rollupEnum: Prisma.sql`'HOUR'::"Granularity"`
  },
  [ANALYTICS_GRANULARITY.DAY]: {
    unit: Prisma.sql`'day'`,
    interval: Prisma.sql`INTERVAL '1 day'`,
    rollupEnum: Prisma.sql`'DAY'::"Granularity"`
  },
  [ANALYTICS_GRANULARITY.WEEK]: {
    unit: Prisma.sql`'week'`,
    interval: Prisma.sql`INTERVAL '1 week'`,
    rollupEnum: Prisma.sql`'WEEK'::"Granularity"`
  }
};

/**
 * Cast applied to every timestamp bound in this repository's raw SQL.
 *
 * Module-level binding, built once at import from `ANALYTICS_DATABASE_SQL`. It never derives
 * from caller input, which is the one case `Prisma.raw` is permitted for (`CLAUDE.md` §
 * *Raw SQL*).
 *
 * **Deliberately not exported.** The fragment on its own is half of a fix: applied to an
 * un-normalized request string it discards the offset rather than converting it, so it is wrong
 * in every session zone including UTC. Keeping it module-private makes it un-importable
 * (`TS2459`), which raises the cost of that mistake from one `import` to typing the cast out by
 * hand. It does **not** make the half-fixed shape unwritable -- the cast is only SQL text.
 */
const UTC_NAIVE_TIMESTAMP_CAST = Prisma.raw(ANALYTICS_DATABASE_SQL.UTC_NAIVE_TIMESTAMP_CAST);

/**
 * The smallest step `timestamp(3)` arithmetic can express below the exclusive upper bound.
 *
 * Used only to turn the half-open `[from, to)` into the inclusive stop `generate_series` wants.
 * A constant fragment, never derived from input.
 */
const SERIES_STOP_EPSILON = Prisma.sql`INTERVAL '1 microsecond'`;

/**
 * The only shape allowed to compare an instant against a naive timestamp column here.
 *
 * Mirrors `utcTimestampBound` in usage-service, and the reasoning is that docblock's. In short:
 * Prisma binds a JS `Date` in `$queryRaw` as `timestamptz`, and comparing a `timestamptz`
 * against a `timestamp(3) without time zone` column resolves through the database **session**
 * zone, so the same request returns different rows on different servers (S-18).
 *
 * Two steps, both load-bearing:
 *
 * 1. `new Date(iso).toISOString()` resolves the instant **in JavaScript**. `from`/`to` are
 *    validated by `iso8601Schema` (`z.string().datetime({ offset: true })`), so a caller may
 *    legally send `2026-03-01T00:00:00+05:30`. Casting that string directly would be wrong:
 *    PostgreSQL's text -> timestamp cast DISCARDS an offset rather than converting it, which
 *    would trade a session-dependent bug for an offset-dependent one that no `Z`-only fixture
 *    catches.
 * 2. `::timestamp(3)` makes the bound naive, so the comparison is UTC-to-UTC and the session
 *    zone cannot enter it.
 *
 * **analytics has no second guard, and that is deliberate.** usage-service additionally pins
 * `set_config('TimeZone','UTC',true)` inside its own `withTenant`; this service's
 * `base.repository.ts` is left byte-identical to worker-service's (plan decision D7), because
 * S-19's subject is that those five copies drift and adding a fifth variant from inside a
 * feature task is what that entry asks not to be done. The consequence is the one S-21 asks
 * for: reverting this helper to a bound `Date` makes `AI8` in
 * `tests/analytics.timezone.integration.test.ts` go red, where the equivalent revert leaves
 * usage-service's own suite 17/17 green because its session pin masks it.
 *
 * Omitting the cast entirely fails loudly rather than silently, so it is the safe mistake:
 * Prisma binds an ISO string as `text`, and an uncast bound string raises `42883`, surfaced as
 * Prisma `P2010`.
 */
const utcTimestampBound = (isoInstant: string): Prisma.Sql =>
  Prisma.sql`${new Date(isoInstant).toISOString()}${UTC_NAIVE_TIMESTAMP_CAST}`;

const toIsoString = (value: Date | string): string => new Date(value).toISOString();

/**
 * `Decimal(18,6)` exceeds IEEE-754 safe precision, so quantities cross the API as strings.
 * `CLAUDE.md` requires the normalization happen in exactly one layer and that no
 * `Prisma.Decimal` reach a JSON response; this is that layer.
 *
 * **The string is canonical, not scale-preserving, and the response contract is silent on
 * which** (T-051 Gate-5 QA, F-2 — recorded, not a defect). decimal.js strips trailing zeros, so
 * a column holding `12.500000` crosses the wire as `"12.5"`. Measured at
 * `@prisma/client` 6.19.3:
 *
 * | stored | on the wire |
 * |---|---|
 * | `12.500000` | `"12.5"` |
 * | `3.250000` | `"3.25"` |
 * | `1.000000` | `"1"` |
 * | `999.000000` | `"999"` |
 * | `0.000001` | `"0.000001"` |
 * | `999999999999.999999` | `"999999999999.999999"` |
 *
 * Precision is preserved in the strongest available form -- the last row is 18 significant
 * digits, which a float64 round trip could not reproduce, and `AI1` asserts exactly it. What is
 * **not** preserved is the column's *scale*. A consumer diffing an API value against a database
 * value, or formatting on string width, sees `"1"` where the column holds `1.000000`.
 *
 * Do not "fix" this by padding here: both tiers go through this one function, so they agree
 * with each other (`AI14`), and changing it would change a shipped wire format for a
 * presentational property no consumer has asked for. If a caller ever needs fixed scale, that
 * is a response-contract decision, not a repository one.
 */
const toQuantityString = (value: Prisma.Decimal | string | number): string => String(value);

const toRollupRows = (rows: RawMetricsRow[]): MetricsRollupRow[] =>
  rows.map((row) => ({
    metricKey: row.metricKey,
    bucketStart: toIsoString(row.bucketStart),
    bucketEnd: toIsoString(row.bucketEnd),
    totalQuantity: toQuantityString(row.totalQuantity)
  }));

/**
 * Tenant-scoped reads and writes for `GET /v1/analytics/metrics`.
 *
 * **The platform's first analytics repository subclass**, and the first consumer of
 * `request.tenantId` in this service.
 *
 * Every statement runs inside a single `withTenant` transaction -- which issues
 * `set_config('app.tenant_id', ..., true)` as its first statement, activating the PostgreSQL
 * RLS policies -- **and** carries an explicit `tenantId` predicate derived from
 * `this.where({})`, never from a caller-supplied field. `.claude/rules/tenant-isolation.md`
 * requires both: belt and braces, neither alone.
 *
 * **S-46 applies to every one of those predicates.** `"UsageLine"` and `"MetricRollup"` both
 * have RLS enabled with a `current_setting('app.tenant_id')` policy, so no behavioural test can
 * observe the application-layer predicate: the policy returns the identical rows with or
 * without it. `AM16`/`AM16e` in `tests/rollup.repository.unit.test.ts` assert the emitted
 * bound values instead, and they are the only thing on this tree that goes red when a predicate
 * is removed. Do not delete one on the evidence that deleting it is green.
 */
export class RollupRepository extends TenantScopedRepository {
  /**
   * Aggregates the requested window straight from `"UsageLine"` -- the always-correct tier.
   *
   * **No `billed` predicate**, against the epic's snippet, which carries
   * `AND billed = true -- only finalized usage`. Plan decision D1, ruled by the user at Gate 2
   * on a measurement: with the filter, a seeded `5.250000` unbilled row vanishes from the
   * result while sitting in the database, so a dashboard reports "nothing" for a day that had
   * usage. `billed` is written `false` at ingestion and flipped later by the nightly invoice
   * job, so the filter would also make every cached bucket go stale exactly once, by design.
   * "How much did I use" and "how much have I been billed for" are different questions, and
   * `GET /v1/billing/invoices/:id` already answers the second. `AI4b` is the case that goes red
   * if the predicate comes back -- do not "fix" this by adding it.
   */
  async aggregateFromUsage(input: MetricsPageInput): Promise<MetricsPage> {
    const granularity = GRANULARITY_SQL[input.granularity];
    const bucketStart = Prisma.sql`DATE_TRUNC(${granularity.unit}, "periodStart")`;
    const bucketEnd = Prisma.sql`DATE_TRUNC(${granularity.unit}, "periodStart") + ${granularity.interval}`;
    const filters = this.buildUsageFilters(input);
    const offset = (input.page - 1) * input.pageSize;

    return this.withTenant(async (tx) => {
      const countRows = await tx.$queryRaw<RawGroupedCountRow[]>(
        Prisma.sql`SELECT COUNT(*)::int AS "total" FROM (SELECT 1 FROM "UsageLine" ${filters} GROUP BY "metricKey", ${bucketStart}) AS "grouped"`
      );

      const pageRows = await tx.$queryRaw<RawMetricsRow[]>(
        Prisma.sql`SELECT "metricKey" AS "metricKey", ${bucketStart} AS "bucketStart", ${bucketEnd} AS "bucketEnd", SUM("quantity") AS "totalQuantity" FROM "UsageLine" ${filters} GROUP BY "metricKey", ${bucketStart}, ${bucketEnd} ORDER BY ${bucketStart} ASC, "metricKey" ASC LIMIT ${input.pageSize} OFFSET ${offset}`
      );

      return { rows: toRollupRows(pageRows), total: countRows[0]?.total ?? 0 };
    });
  }

  /**
   * Pages the pre-computed totals out of `"MetricRollup"` -- the fast tier.
   *
   * **The lower bound is the caller's own `from`, never a truncated one.** Widening it to
   * `DATE_TRUNC(unit, from)` would make an unaligned request report the whole of its first
   * bucket.
   *
   * Measured against `AI13`'s own fixture, so the figures are reconstructible from the shipped
   * tree -- three `api.request` usage lines at `2026-03-01 03:00` (`10.500000`),
   * `2026-03-01 08:00` (`2.000000`) and `2026-03-03 12:00` (`5.250000`), read back as
   * `telemetry_app` over `[2026-03-01T06:00, 2026-03-04)`:
   *
   * | | `2026-03-01` bucket | `2026-03-03` bucket |
   * |---|---|---|
   * | `UsageLine` tier (correct) | `2.000000` | `5.250000` |
   * | cache read with a truncated lower bound | `12.500000` | `5.250000` |
   *
   * The `2026-03-01` cell is the defect: `12.500000` is the whole day, including the
   * `10.500000` recorded before `06:00` that the caller explicitly excluded. (An earlier
   * revision of this docblock quoted `5.250000` and `22.750000`. Those came from a Gate-3 probe
   * fixture that is not on the tree and cannot be re-derived from it -- Gate-4 LOW-2.)
   *
   * The service refuses to consult the cache for an unaligned range at all
   * (`RangeCoverage.bucketAligned`); not truncating here is the second line of defence.
   * `AM16f` is the guard, and it is the **only** case that reddens under that mutation --
   * measured, `Tests 1 failed | 143 passed (144)` at the time it was taken.
   *
   * No `DATE_TRUNC` appears in this statement for the same reason: `"bucketStart"` is already a
   * bucket boundary, and `bucketEnd` derives from the shared `interval` fragment so that the
   * two tiers agree by construction (D4).
   */
  async readCachedPage(input: MetricsPageInput): Promise<MetricsPage> {
    const granularity = GRANULARITY_SQL[input.granularity];
    const filters = this.buildCacheFilters(input);
    const offset = (input.page - 1) * input.pageSize;

    return this.withTenant(async (tx) => {
      const countRows = await tx.$queryRaw<RawGroupedCountRow[]>(
        Prisma.sql`SELECT COUNT(*)::int AS "total" FROM "MetricRollup" ${filters}`
      );

      const pageRows = await tx.$queryRaw<RawMetricsRow[]>(
        Prisma.sql`SELECT "metricKey" AS "metricKey", "bucketStart" AS "bucketStart", "bucketStart" + ${granularity.interval} AS "bucketEnd", "value" AS "totalQuantity" FROM "MetricRollup" ${filters} ORDER BY "bucketStart" ASC, "metricKey" ASC LIMIT ${input.pageSize} OFFSET ${offset}`
      );

      return { rows: toRollupRows(pageRows), total: countRows[0]?.total ?? 0 };
    });
  }

  /**
   * Describes, in one statement, whether the cache may answer this exact request.
   *
   * `expectedBuckets` counts the calendar buckets spanning `[from, to)` with `generate_series`
   * over the **same** `unit` and `interval` fragments the bucketing uses, so the two cannot
   * disagree about where a boundary is -- which matters most at `week`, where "the bucket
   * containing `from`" is PostgreSQL's ISO Monday rather than anything derivable in JS without
   * restating that rule.
   *
   * `cachedBuckets` is scoped by the request's own `metricKey` when there is one. Without that
   * scoping a filtered read would be validated by buckets in which only *another* metric has
   * rows, and would then be served a cache missing its own.
   *
   * `bucketAligned` is plan decision D10, and it is the only one of the three the plan did not
   * name. An unaligned bound puts part of a bucket outside the request: reading the cache then
   * over-reports that bucket, and writing it stores a partial total that every later aligned
   * reader would trust. Measured at Gate 3 -- true total for the `2026-03-01` `api.request`
   * bucket `12.500000`, value an unaligned `[06:00, ...)` request would cache `2.000000`.
   */
  async describeRangeCoverage(input: MetricsRangeInput): Promise<RangeCoverage> {
    const granularity = GRANULARITY_SQL[input.granularity];
    const from = utcTimestampBound(input.from);
    const to = utcTimestampBound(input.to);
    const filters = this.buildCacheFilters(input);

    return this.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<RawCoverageRow[]>(
        Prisma.sql`SELECT (SELECT COUNT(*)::int FROM generate_series(DATE_TRUNC(${granularity.unit}, ${from}), ${to} - ${SERIES_STOP_EPSILON}, ${granularity.interval})) AS "expectedBuckets", (SELECT COUNT(DISTINCT "bucketStart")::int FROM "MetricRollup" ${filters}) AS "cachedBuckets", (${from} = DATE_TRUNC(${granularity.unit}, ${from}) AND ${to} = DATE_TRUNC(${granularity.unit}, ${to})) AS "bucketAligned"`
      );

      const coverage = rows[0];
      if (!coverage) {
        throw new Error("Expected one row of range coverage from MetricRollup");
      }

      return {
        expectedBuckets: coverage.expectedBuckets,
        cachedBuckets: coverage.cachedBuckets,
        bucketAligned: coverage.bucketAligned
      };
    });
  }

  /**
   * Upserts every `(metricKey, bucket)` total in the range into `"MetricRollup"`.
   *
   * One `INSERT ... SELECT ... ON CONFLICT DO UPDATE`, so the whole range is written in a single
   * statement inside the tenant transaction rather than one round trip per bucket, and a
   * concurrent writer cannot leave the cache half-populated.
   *
   * The bucket expression is byte-identical to `aggregateFromUsage`'s, because a cache keyed on
   * a different boundary is a cache the read can never find.
   *
   * **Takes `MetricsCacheInput`, which has no `metricKey`** (plan decision D3). Writing a
   * filtered result is what makes the completeness count unsound: `COUNT(DISTINCT
   * "bucketStart")` is blind to the metric dimension, so a cache written by a request filtered
   * to metric A would make a later *unfiltered* range look complete while omitting metric B --
   * silent under-reporting. `AI12` measures that consequence and `AM17` guards the service-side
   * refusal.
   *
   * No migration was needed and no new grant: `"MetricRollup"` already has RLS enabled and
   * forced with a `FOR ALL` policy carrying **both** `USING` and `WITH CHECK`, and
   * `telemetry_app` already holds `SELECT, INSERT, UPDATE, DELETE`. Verified at planning, and
   * `AI15` is the standing case: as `telemetry_app` under tenant A's context, an insert naming
   * tenant B raises `new row violates row-level security policy`, as does one with no tenant
   * context at all. That `WITH CHECK` is what makes it safe to bind the tenant from
   * `this.where({})` rather than validating it separately.
   *
   * @returns the number of rows inserted or updated.
   */
  async cacheRange(input: MetricsCacheInput): Promise<number> {
    const granularity = GRANULARITY_SQL[input.granularity];
    const bucketStart = Prisma.sql`DATE_TRUNC(${granularity.unit}, "periodStart")`;
    const { tenantId } = this.where({});
    // Rebuilt field by field rather than passed through. The parameter type already makes a
    // filtered call a compile error, but TypeScript's excess-property check only fires on a
    // fresh object literal, so an extra `metricKey` arriving at runtime -- from a cast, a
    // spread through a wider variable, or a JSON boundary -- would otherwise be honoured by
    // `buildUsageFilters`. Measured at Gate 3: `AM17d` failed exactly that way against the
    // pass-through form, with the `@ts-expect-error` in place and the typecheck clean. Two
    // layers, because the type alone was not enough.
    const filters = this.buildUsageFilters({
      from: input.from,
      to: input.to,
      granularity: input.granularity
    });

    return this.withTenant(async (tx) =>
      tx.$executeRaw(
        Prisma.sql`INSERT INTO "MetricRollup" ("id", "tenantId", "metricKey", "granularity", "bucketStart", "value", "computedAt") SELECT gen_random_uuid()::text, ${tenantId}, "metricKey", ${granularity.rollupEnum}, ${bucketStart}, SUM("quantity"), NOW() FROM "UsageLine" ${filters} GROUP BY "metricKey", ${bucketStart} ON CONFLICT ("tenantId", "metricKey", "granularity", "bucketStart") DO UPDATE SET "value" = EXCLUDED."value", "computedAt" = EXCLUDED."computedAt"`
      )
    );
  }

  /**
   * `WHERE` clause over `"UsageLine"`.
   *
   * The tenant comes from `this.where({})` -- the base helper -- so it can only ever be the
   * repository's own bound tenant and never a caller-supplied value. Both timestamp bounds go
   * through `utcTimestampBound`; a JS `Date` here is a cross-server correctness bug, not a
   * style question.
   */
  private buildUsageFilters(input: MetricsRangeInput): Prisma.Sql {
    const { tenantId } = this.where({});
    const metricKeyFilter = input.metricKey
      ? Prisma.sql`AND "metricKey" = ${input.metricKey}`
      : Prisma.empty;

    return Prisma.sql`WHERE "tenantId" = ${tenantId} AND "periodStart" >= ${utcTimestampBound(input.from)} AND "periodStart" < ${utcTimestampBound(input.to)} ${metricKeyFilter}`;
  }

  /** `WHERE` clause over `"MetricRollup"`. Same tenant derivation and the same bound shape. */
  private buildCacheFilters(input: MetricsRangeInput): Prisma.Sql {
    const granularity = GRANULARITY_SQL[input.granularity];
    const { tenantId } = this.where({});
    const metricKeyFilter = input.metricKey
      ? Prisma.sql`AND "metricKey" = ${input.metricKey}`
      : Prisma.empty;

    return Prisma.sql`WHERE "tenantId" = ${tenantId} AND "granularity" = ${granularity.rollupEnum} AND "bucketStart" >= ${utcTimestampBound(input.from)} AND "bucketStart" < ${utcTimestampBound(input.to)} ${metricKeyFilter}`;
  }
}
