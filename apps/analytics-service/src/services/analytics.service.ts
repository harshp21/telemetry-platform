import type { Logger } from "pino";
import type { PaginatedResult, TenantId } from "@telemetry/shared-types";
import type { MetricsRollupRow, RollupRepository } from "../repositories/rollup.repository";
import type { MetricsQuery } from "../validators/metrics-query.validator";
import { ANALYTICS_METRICS } from "../constants";

export type MetricsRollupItem = MetricsRollupRow;

/**
 * Builds a repository bound to a single tenant.
 *
 * Tenant-scoped repositories are per-request **by construction** -- `tenantId` is a constructor
 * argument -- so the container injects a factory and never a singleton. A singleton would pin
 * one tenant process-wide (`.claude/rules/tenant-isolation.md` § *Required*). `AM19g` is the
 * case that observes the factory being called with the request's own tenant.
 */
export type RollupRepositoryFactory = (tenantId: TenantId) => RollupRepository;

/**
 * Orchestrates the two-tier read behind `GET /v1/analytics/metrics`.
 *
 * ## The decision, and the three rules that shape it
 *
 * Serve pre-computed totals out of `"MetricRollup"` when they are known to be complete for this
 * exact request; otherwise aggregate the whole range from `"UsageLine"` and, where it is sound
 * to do so, populate the cache for next time.
 *
 * **D0-A -- an absent bucket discards the cache, it does not top it up.** `expectedBuckets` is
 * the count of calendar buckets spanning `[from, to)`; `cachedBuckets` is how many distinct
 * `bucketStart` values are cached for this tenant, granularity, range and metric. Anything less
 * than equality means the whole range is re-derived. Merging a partial cache with a partial
 * aggregation would mean two code paths could disagree about one bucket, and the cheaper of
 * them is the one that cannot be checked.
 *
 * **D3 -- a `metricKey`-filtered request never writes the cache.** This is what makes the count
 * above sound rather than merely plausible. `COUNT(DISTINCT "bucketStart")` cannot see the
 * metric dimension, so a cache written by a request filtered to metric A would make a later
 * *unfiltered* request count a full set of buckets, declare the range complete, and serve A's
 * rows alone -- under-reporting metric B with nothing red anywhere. A filtered request may
 * still *read* the cache: its coverage count carries the same filter, so it only validates when
 * that metric's own buckets are all present, which is conservative and never wrong.
 *
 * **D10 -- an unaligned range never touches the cache in either direction.** If a bound falls
 * inside a bucket, part of that bucket is outside the request. Reading the cache then reports
 * usage the caller excluded; writing it stores a partial total that every later aligned reader
 * would trust. Measured at Gate 3 on a real fixture: the `2026-03-01` `api.request` bucket's
 * true total is `12.500000`, and a request starting at `06:00` would have cached `2.000000`
 * for it.
 *
 * ## What is knowingly given up
 *
 * A bucket with genuinely zero usage produces no rollup row, so under D0-A **any range
 * containing an idle bucket can never validate** and falls back forever. Measured: a three-day
 * range with usage on two of the days gives `expectedBuckets=3` against `cachedBuckets=2`. At
 * `hour` granularity that is close to permanent. This is correctness-first and is accepted
 * rather than worked around -- closing it properly needs a completeness marker on the table,
 * i.e. a migration, which is not this task. Filed as **S-61** in `.claude/rules/known-gaps.md`.
 *
 * Repository failures propagate unchanged and are normalized by the controller. A failed cache
 * *write* is the one exception: it is logged and swallowed, because the answer the caller gets
 * was already computed correctly and an optimisation must not fail the request (`AM19i`).
 */
export class AnalyticsService {
  constructor(
    private readonly createRollupRepository: RollupRepositoryFactory,
    private readonly logger: Logger
  ) {}

  async getMetricsRollup(
    tenantId: TenantId,
    query: MetricsQuery
  ): Promise<PaginatedResult<MetricsRollupItem>> {
    const repository = this.createRollupRepository(tenantId);
    const range = { from: query.from, to: query.to, granularity: query.granularity };
    const page = { ...range, metricKey: query.metricKey, page: query.page, pageSize: query.pageSize };

    const coverage = await repository.describeRangeCoverage({ ...range, metricKey: query.metricKey });
    const cacheUsable =
      coverage.bucketAligned && coverage.cachedBuckets === coverage.expectedBuckets;

    if (cacheUsable) {
      const cached = await repository.readCachedPage(page);
      this.logger.debug(
        { tenantId, granularity: query.granularity, servedFrom: "cache", total: cached.total },
        "Metrics rollup served from cache"
      );
      return this.paginate(cached, query);
    }

    const aggregated = await repository.aggregateFromUsage(page);
    await this.cacheIfSound(repository, range, query, coverage.bucketAligned, aggregated.total);

    this.logger.debug(
      {
        tenantId,
        granularity: query.granularity,
        servedFrom: "usage",
        expectedBuckets: coverage.expectedBuckets,
        cachedBuckets: coverage.cachedBuckets,
        bucketAligned: coverage.bucketAligned,
        total: aggregated.total
      },
      "Metrics rollup aggregated from usage"
    );

    return this.paginate(aggregated, query);
  }

  /**
   * Writes the fallback result into `"MetricRollup"` when, and only when, all three of D3, D10
   * and the write-amplification ceiling permit it.
   *
   * Each refusal is logged rather than silent: a cache that never fills looks exactly like a
   * cache that is broken, and the difference is the whole of whether anyone investigates.
   */
  private async cacheIfSound(
    repository: RollupRepository,
    range: { from: string; to: string; granularity: MetricsQuery["granularity"] },
    query: MetricsQuery,
    bucketAligned: boolean,
    groupedRowCount: number
  ): Promise<void> {
    // D3. Remove this condition and `AM17` goes red, and `AI12` measures the under-report it
    // lets through.
    if (query.metricKey !== undefined) {
      this.logger.debug(
        { granularity: query.granularity, reason: "metric-filtered" },
        "Metrics rollup cache write skipped"
      );
      return;
    }

    // D10.
    if (!bucketAligned) {
      this.logger.debug(
        { granularity: query.granularity, reason: "range-not-bucket-aligned" },
        "Metrics rollup cache write skipped"
      );
      return;
    }

    // Risk R5: one request's write amplification is bounded even though the range is not. The
    // read has already been answered correctly above; only the write is declined.
    if (groupedRowCount > ANALYTICS_METRICS.MAX_CACHED_ROWS) {
      this.logger.warn(
        {
          granularity: query.granularity,
          groupedRowCount,
          limit: ANALYTICS_METRICS.MAX_CACHED_ROWS
        },
        "Metrics rollup cache write declined: range exceeds the cached-row ceiling"
      );
      return;
    }

    try {
      const written = await repository.cacheRange(range);
      this.logger.debug(
        { granularity: query.granularity, written },
        "Metrics rollup cache populated"
      );
    } catch (error) {
      // The caller's answer is already correct; the cache is an optimisation. Failing the
      // request here would turn a degraded optimisation into an outage.
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Metrics rollup cache write failed; serving the aggregated result"
      );
    }
  }

  /**
   * Wraps rows in the shared pagination envelope. The validator has already applied the
   * defaults, so this only echoes the effective page back to the caller.
   */
  private paginate(
    result: { rows: MetricsRollupItem[]; total: number },
    query: MetricsQuery
  ): PaginatedResult<MetricsRollupItem> {
    return {
      items: result.rows,
      total: result.total,
      page: query.page,
      pageSize: query.pageSize
    };
  }
}
