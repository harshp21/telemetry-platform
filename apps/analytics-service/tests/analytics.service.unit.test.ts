import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantId } from "@telemetry/shared-types";
import { AnalyticsService } from "../src/services/analytics.service";
import type { RollupRepository } from "../src/repositories/rollup.repository";
import type { MetricsRollupRow } from "../src/repositories/rollup.repository";
import { ANALYTICS_GRANULARITY, ANALYTICS_METRICS } from "../src/constants";
import type { MetricsQuery } from "../src/validators/metrics-query.validator";

/**
 * The two-tier decision (T-051, slices 3 and 4).
 *
 * This layer owns three rules, and each has a case that goes red when the rule is removed:
 *
 * - **D0-A** -- any absent bucket discards the cache and the *whole* range is aggregated from
 *   `UsageLine`. Not topped up: a partial cache is not a partial answer.
 * - **D3** -- a `metricKey`-filtered request never writes the cache. Without this the
 *   completeness count is unsound, because `COUNT(DISTINCT "bucketStart")` is blind to the
 *   metric dimension, so a cache written by a filtered request makes a later *unfiltered*
 *   range look complete while omitting another metric entirely. `AM17` is that guard here;
 *   `AI12` in the integration suite measures the under-report it prevents.
 * - **D10** -- a range whose bounds are not on bucket boundaries never touches the cache at
 *   all, in either direction. Measured at Gate 3: caching `[2026-03-01T06:00, 2026-03-04)`
 *   writes `2.000000` for the `2026-03-01` `api.request` bucket whose true total is
 *   `12.500000`, and reading that bucket back for an unaligned request over-reports by the
 *   part of the bucket the caller excluded.
 */

const TENANT_ID = "11111111-1111-4111-8111-111111111111" as TenantId;
const METRIC_KEY = "api.request";
const OTHER_METRIC_KEY = "storage.write";

const FROM = "2026-03-01T00:00:00.000Z";
const TO = "2026-03-04T00:00:00.000Z";
/** Three day buckets span `[FROM, TO)`; measured with `generate_series` at Gate 1. */
const EXPECTED_BUCKETS = 3;

const row = (metricKey: string, bucketStart: string, totalQuantity: string): MetricsRollupRow => ({
  metricKey,
  bucketStart,
  bucketEnd: TO,
  totalQuantity
});

const CACHED_ROWS = [row(METRIC_KEY, FROM, "10.5")];
const USAGE_ROWS = [row(METRIC_KEY, FROM, "10.5"), row(OTHER_METRIC_KEY, FROM, "7")];

const query = (overrides: Partial<MetricsQuery> = {}): MetricsQuery => ({
  from: FROM,
  to: TO,
  granularity: ANALYTICS_GRANULARITY.DAY,
  page: ANALYTICS_METRICS.DEFAULT_PAGE,
  pageSize: ANALYTICS_METRICS.DEFAULT_PAGE_SIZE,
  ...overrides
});

interface CoverageOverrides {
  readonly expectedBuckets?: number;
  readonly cachedBuckets?: number;
  readonly bucketAligned?: boolean;
}

const createRepositoryDouble = (coverage: CoverageOverrides = {}, usageTotal = USAGE_ROWS.length) => {
  const describeRangeCoverage = vi.fn(async () => ({
    expectedBuckets: coverage.expectedBuckets ?? EXPECTED_BUCKETS,
    cachedBuckets: coverage.cachedBuckets ?? EXPECTED_BUCKETS,
    bucketAligned: coverage.bucketAligned ?? true
  }));
  const readCachedPage = vi.fn(async () => ({ rows: CACHED_ROWS, total: CACHED_ROWS.length }));
  const aggregateFromUsage = vi.fn(async () => ({ rows: USAGE_ROWS, total: usageTotal }));
  const cacheRange = vi.fn(async () => USAGE_ROWS.length);

  const repository = {
    describeRangeCoverage,
    readCachedPage,
    aggregateFromUsage,
    cacheRange
  } as unknown as RollupRepository;

  return { repository, describeRangeCoverage, readCachedPage, aggregateFromUsage, cacheRange };
};

const testLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const build = (double: ReturnType<typeof createRepositoryDouble>) => {
  const logger = testLogger();
  const factory = vi.fn(() => double.repository);
  const service = new AnalyticsService(
    factory as unknown as (tenantId: TenantId) => RollupRepository,
    logger as never
  );
  return { service, factory, logger };
};

describe("AnalyticsService.getMetricsRollup", () => {
  let double: ReturnType<typeof createRepositoryDouble>;

  beforeEach(() => {
    double = createRepositoryDouble();
  });

  it("AM18 - serves a complete, aligned, unfiltered range from the cache without reading UsageLine", async () => {
    const { service } = build(double);

    const result = await service.getMetricsRollup(TENANT_ID, query());

    expect(double.readCachedPage).toHaveBeenCalledTimes(1);
    // The observable form of "served from cache": the fallback aggregation never ran.
    expect(double.aggregateFromUsage).not.toHaveBeenCalled();
    expect(double.cacheRange).not.toHaveBeenCalled();
    expect(result).toEqual({
      items: CACHED_ROWS,
      total: CACHED_ROWS.length,
      page: ANALYTICS_METRICS.DEFAULT_PAGE,
      pageSize: ANALYTICS_METRICS.DEFAULT_PAGE_SIZE
    });
  });

  it("AM19 - discards the whole cache when one bucket is absent, rather than topping it up", async () => {
    // D0-A. `cachedBuckets` one short of `expectedBuckets` is the exact state Gate 1 measured
    // on a real fixture: a three-day range with usage on two of the days gives
    // `expected_day_buckets=3` against `buckets_with_usage=2`.
    double = createRepositoryDouble({ cachedBuckets: EXPECTED_BUCKETS - 1 });
    const { service } = build(double);

    const result = await service.getMetricsRollup(TENANT_ID, query());

    expect(double.readCachedPage).not.toHaveBeenCalled();
    expect(double.aggregateFromUsage).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual(USAGE_ROWS);
  });

  it("AM19b - falls back when the cache holds no bucket at all", async () => {
    double = createRepositoryDouble({ cachedBuckets: 0 });
    const { service } = build(double);

    await service.getMetricsRollup(TENANT_ID, query());

    expect(double.readCachedPage).not.toHaveBeenCalled();
    expect(double.aggregateFromUsage).toHaveBeenCalledTimes(1);
  });

  it("AM19c - serves an empty calendar range from the cache trivially, without a spurious fallback", async () => {
    // `expectedBuckets` can never be 0 for a valid range -- `from < to` is enforced by the
    // validator and any non-empty interval spans at least one bucket. This case pins that the
    // comparison is an equality on counts and not, say, `cachedBuckets > 0`.
    double = createRepositoryDouble({ expectedBuckets: 1, cachedBuckets: 1 });
    const { service } = build(double);

    await service.getMetricsRollup(TENANT_ID, query());

    expect(double.readCachedPage).toHaveBeenCalledTimes(1);
    expect(double.aggregateFromUsage).not.toHaveBeenCalled();
  });

  it("AM17 - never writes the cache for a metricKey-filtered request, even on a fallback", async () => {
    // **Plan decision D3, and the soundness of the whole completeness check rests on it.**
    // Removing the `metricKey === undefined` condition from this branch makes this case red.
    // What it prevents: a filtered fallback caching only metric A's buckets, after which an
    // unfiltered request counts `COUNT(DISTINCT "bucketStart")` = 3, decides the range is
    // complete, and serves A's rows alone -- under-reporting metric B with the suite green.
    double = createRepositoryDouble({ cachedBuckets: EXPECTED_BUCKETS - 1 });
    const { service } = build(double);

    await service.getMetricsRollup(TENANT_ID, query({ metricKey: METRIC_KEY }));

    expect(double.aggregateFromUsage).toHaveBeenCalledTimes(1);
    expect(double.cacheRange).not.toHaveBeenCalled();
  });

  it("AM17b - does write the cache on an unfiltered fallback, so AM17 is not vacuous", async () => {
    // Without this case, `cacheRange` never being called would satisfy AM17 trivially.
    double = createRepositoryDouble({ cachedBuckets: EXPECTED_BUCKETS - 1 });
    const { service } = build(double);

    await service.getMetricsRollup(TENANT_ID, query());

    expect(double.cacheRange).toHaveBeenCalledTimes(1);
    expect(double.cacheRange).toHaveBeenCalledWith({
      from: FROM,
      to: TO,
      granularity: ANALYTICS_GRANULARITY.DAY
    });
  });

  it("AM17c - still lets a filtered request read a complete cache", async () => {
    // D3 restricts the *write*, not the read. The coverage count carries the same `metricKey`
    // filter (`AM17b` in the repository suite), so a filtered read only validates when that
    // metric's own buckets are all present -- conservative, and never wrong.
    const { service } = build(double);

    await service.getMetricsRollup(TENANT_ID, query({ metricKey: METRIC_KEY }));

    expect(double.readCachedPage).toHaveBeenCalledTimes(1);
    expect(double.aggregateFromUsage).not.toHaveBeenCalled();
    expect(double.describeRangeCoverage).toHaveBeenCalledWith(
      expect.objectContaining({ metricKey: METRIC_KEY })
    );
  });

  it("AM19d - never consults or writes the cache for a range that is not bucket-aligned", async () => {
    // Plan addition D10. `bucketAligned=false` means at least one bound falls inside a bucket,
    // so the cached total for that bucket covers usage the caller excluded (reading) or is a
    // partial total that a later aligned request would trust (writing). Measured at Gate 3:
    // true bucket total `12.500000`, value an unaligned write would cache `2.000000`.
    double = createRepositoryDouble({ bucketAligned: false });
    const { service } = build(double);

    const result = await service.getMetricsRollup(TENANT_ID, query());

    expect(double.readCachedPage).not.toHaveBeenCalled();
    expect(double.cacheRange).not.toHaveBeenCalled();
    expect(double.aggregateFromUsage).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual(USAGE_ROWS);
  });

  it("AM19e - declines the cache write above MAX_CACHED_ROWS and still answers the read", async () => {
    // Risk R5. The range itself is not capped -- usage-service and billing-service do not cap
    // theirs either -- but one request's write amplification is.
    double = createRepositoryDouble(
      { cachedBuckets: EXPECTED_BUCKETS - 1 },
      ANALYTICS_METRICS.MAX_CACHED_ROWS + 1
    );
    const { service, logger } = build(double);

    const result = await service.getMetricsRollup(TENANT_ID, query());

    expect(double.cacheRange).not.toHaveBeenCalled();
    expect(result.items).toEqual(USAGE_ROWS);
    expect(result.total).toBe(ANALYTICS_METRICS.MAX_CACHED_ROWS + 1);
    // Declining silently would make an unexplained cache miss indistinguishable from a bug.
    expect(logger.warn).toHaveBeenCalled();
  });

  it("AM19f - caches exactly at the MAX_CACHED_ROWS boundary, so the bound is inclusive", async () => {
    double = createRepositoryDouble(
      { cachedBuckets: EXPECTED_BUCKETS - 1 },
      ANALYTICS_METRICS.MAX_CACHED_ROWS
    );
    const { service } = build(double);

    await service.getMetricsRollup(TENANT_ID, query());

    expect(double.cacheRange).toHaveBeenCalledTimes(1);
  });

  it("AM19g - builds one repository per request, bound to the caller's tenant", async () => {
    // Tenant-scoped repositories are per-request by construction; the container registers a
    // factory rather than a singleton, and a singleton would pin one tenant process-wide.
    const { service, factory } = build(double);

    await service.getMetricsRollup(TENANT_ID, query());

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(TENANT_ID);
  });

  it("AM19h - propagates a repository failure rather than degrading to an empty page", async () => {
    // A cache-read failure answered with `items: []` would look like "no usage" to a
    // dashboard. The controller normalizes; this layer must not swallow.
    const failure = new Error("relation \"MetricRollup\" does not exist");
    double.describeRangeCoverage.mockRejectedValueOnce(failure);
    const { service } = build(double);

    await expect(service.getMetricsRollup(TENANT_ID, query())).rejects.toThrow(failure);
  });

  it("AM19i - does not fail the request when the cache write fails", async () => {
    // The cache is an optimisation. A tenant whose rollup write is refused must still get the
    // correct answer the fallback already computed.
    double = createRepositoryDouble({ cachedBuckets: EXPECTED_BUCKETS - 1 });
    double.cacheRange.mockRejectedValueOnce(new Error("write declined"));
    const { service, logger } = build(double);

    const result = await service.getMetricsRollup(TENANT_ID, query());

    expect(result.items).toEqual(USAGE_ROWS);
    expect(logger.warn).toHaveBeenCalled();
  });
});
