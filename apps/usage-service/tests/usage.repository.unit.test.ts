import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { UsageRepository } from "../src/repositories/usage.repository";
import type { UsageSummaryQueryInput } from "../src/repositories/usage.repository";
import { USAGE_SUMMARY_CONSTANTS, USAGE_SUMMARY_GRANULARITY } from "../src/constants";

const TENANT_ID = "11111111-1111-4111-8111-111111111111" as TenantId;
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";

const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-01-08T00:00:00.000Z";

const baseInput: UsageSummaryQueryInput = {
  from: FROM,
  to: TO,
  granularity: USAGE_SUMMARY_GRANULARITY.DAY,
  page: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE,
  pageSize: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE_SIZE
};

const testLogger = () => ({ error: vi.fn(), debug: vi.fn() });

interface RawAggregateRow {
  metricKey: string;
  bucketStart: Date;
  bucketEnd: Date;
  totalQuantity: Prisma.Decimal;
}

const rawRow = (
  metricKey: string,
  bucketStart: string,
  bucketEnd: string,
  totalQuantity: string
): RawAggregateRow => ({
  metricKey,
  bucketStart: new Date(bucketStart),
  bucketEnd: new Date(bucketEnd),
  totalQuantity: new Prisma.Decimal(totalQuantity)
});

/**
 * Builds a Prisma double whose `$transaction` immediately runs the callback with a
 * transaction client. `$queryRaw` resolves the supplied results in order:
 * [0] the `set_config` call issued by TenantScopedRepository.withTenant,
 * [1] the grouped-row count query,
 * [2] the paginated aggregate query.
 */
const createPrismaMock = (results: unknown[]) => {
  const queryRaw = vi.fn();
  for (const result of results) {
    queryRaw.mockResolvedValueOnce(result);
  }
  const tx = { $queryRaw: queryRaw };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx))
  } as unknown as PrismaClient;

  return { prisma, queryRaw };
};

const sqlAt = (queryRaw: ReturnType<typeof vi.fn>, index: number): Prisma.Sql => {
  const call = queryRaw.mock.calls[index];
  if (!call) {
    throw new Error(`Expected $queryRaw call at index ${index}`);
  }
  return call[0] as Prisma.Sql;
};

const runAggregate = async (
  input: UsageSummaryQueryInput,
  results: unknown[] = [[], [{ total: 0 }], []]
) => {
  const { prisma, queryRaw } = createPrismaMock(results);
  const repository = new UsageRepository(prisma, TENANT_ID, testLogger());
  const result = await repository.aggregateSummary(input);
  return { prisma, queryRaw, result, countSql: sqlAt(queryRaw, 1), rowsSql: sqlAt(queryRaw, 2) };
};

describe("UsageRepository.aggregateSummary", () => {
  it("runs the aggregation inside the tenant-scoped transaction wrapper", async () => {
    const { prisma } = await runAggregate(baseInput);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("sets app.tenant_id before issuing any aggregate query", async () => {
    const { queryRaw } = await runAggregate(baseInput);

    const setConfigCall = queryRaw.mock.calls[0];
    expect(setConfigCall).toBeDefined();
    expect(String(setConfigCall?.[0])).toContain("set_config");
    expect(setConfigCall?.[1]).toBe(TENANT_ID);
  });

  it("applies an explicit tenantId filter to the count query and the page query", async () => {
    const { countSql, rowsSql } = await runAggregate(baseInput);

    expect(countSql.text).toContain('"tenantId" = $1');
    expect(countSql.values[0]).toBe(TENANT_ID);
    expect(rowsSql.text).toContain('"tenantId" = $1');
    expect(rowsSql.values[0]).toBe(TENANT_ID);
    expect(countSql.values).not.toContain(OTHER_TENANT_ID);
    expect(rowsSql.values).not.toContain(OTHER_TENANT_ID);
  });

  it("uses an inclusive from boundary and an exclusive to boundary", async () => {
    const { rowsSql } = await runAggregate(baseInput);

    expect(rowsSql.text).toContain('"periodStart" >= $2');
    expect(rowsSql.text).toContain('"periodStart" < $3');
    expect(rowsSql.values[1]).toEqual(new Date(FROM));
    expect(rowsSql.values[2]).toEqual(new Date(TO));
  });

  it("omits the metricKey filter when metricKey is not provided", async () => {
    const { countSql, rowsSql } = await runAggregate(baseInput);

    expect(countSql.text).not.toContain('"metricKey" = $');
    expect(rowsSql.text).not.toContain('"metricKey" = $');
  });

  it("applies the optional metricKey filter when provided", async () => {
    const { countSql, rowsSql } = await runAggregate({
      ...baseInput,
      metricKey: "api.request"
    });

    expect(countSql.text).toContain('"metricKey" = $4');
    expect(countSql.values).toContain("api.request");
    expect(rowsSql.text).toContain('"metricKey" = $4');
    expect(rowsSql.values).toContain("api.request");
  });

  it("groups by metricKey and the granularity bucket", async () => {
    const { countSql, rowsSql } = await runAggregate(baseInput);

    expect(rowsSql.text).toContain('GROUP BY "metricKey", DATE_TRUNC(\'day\', "periodStart")');
    expect(countSql.text).toContain('GROUP BY "metricKey", DATE_TRUNC(\'day\', "periodStart")');
  });

  it("maps granularity hour to a fixed DATE_TRUNC hour fragment", async () => {
    const { rowsSql } = await runAggregate({
      ...baseInput,
      granularity: USAGE_SUMMARY_GRANULARITY.HOUR
    });

    expect(rowsSql.text).toContain('DATE_TRUNC(\'hour\', "periodStart")');
  });

  it("maps granularity day to a fixed DATE_TRUNC day fragment", async () => {
    const { rowsSql } = await runAggregate(baseInput);

    expect(rowsSql.text).toContain('DATE_TRUNC(\'day\', "periodStart")');
  });

  it("maps granularity week to a fixed DATE_TRUNC week fragment", async () => {
    const { rowsSql } = await runAggregate({
      ...baseInput,
      granularity: USAGE_SUMMARY_GRANULARITY.WEEK
    });

    expect(rowsSql.text).toContain('DATE_TRUNC(\'week\', "periodStart")');
  });

  it("never interpolates the granularity string as a bound query parameter", async () => {
    for (const granularity of Object.values(USAGE_SUMMARY_GRANULARITY)) {
      const { countSql, rowsSql } = await runAggregate({ ...baseInput, granularity });

      expect(countSql.values).not.toContain(granularity);
      expect(rowsSql.values).not.toContain(granularity);
    }
  });

  it("truncates buckets in UTC without any timezone conversion", async () => {
    const { rowsSql } = await runAggregate(baseInput);

    // periodStart is TIMESTAMP(3) without time zone and is persisted in UTC, so
    // DATE_TRUNC alone yields UTC bucket boundaries. Any AT TIME ZONE conversion
    // would silently shift day/week boundaries per server locale.
    expect(rowsSql.text).not.toContain("AT TIME ZONE");
  });

  it("computes bucketEnd as bucketStart plus one granularity interval", async () => {
    const hour = await runAggregate({
      ...baseInput,
      granularity: USAGE_SUMMARY_GRANULARITY.HOUR
    });
    const day = await runAggregate(baseInput);
    const week = await runAggregate({
      ...baseInput,
      granularity: USAGE_SUMMARY_GRANULARITY.WEEK
    });

    expect(hour.rowsSql.text).toContain("INTERVAL '1 hour'");
    expect(day.rowsSql.text).toContain("INTERVAL '1 day'");
    expect(week.rowsSql.text).toContain("INTERVAL '1 week'");
  });

  it("returns total as the count of grouped rows, not raw event rows", async () => {
    const { countSql, result } = await runAggregate(baseInput, [
      [],
      [{ total: 3 }],
      [rawRow("api.request", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "10")]
    ]);

    expect(countSql.text).toContain("COUNT(*)");
    expect(countSql.text).toContain("GROUP BY");
    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(1);
  });

  it("applies LIMIT and OFFSET derived from page and pageSize", async () => {
    const { rowsSql } = await runAggregate({ ...baseInput, page: 3, pageSize: 25 });

    expect(rowsSql.text).toContain("LIMIT");
    expect(rowsSql.text).toContain("OFFSET");
    expect(rowsSql.values).toContain(25);
    expect(rowsSql.values).toContain(50);
  });

  it("orders rows deterministically by bucket then metricKey", async () => {
    const { rowsSql } = await runAggregate(baseInput);

    expect(rowsSql.text).toContain(
      'ORDER BY DATE_TRUNC(\'day\', "periodStart") ASC, "metricKey" ASC'
    );
  });

  it("normalizes Decimal totalQuantity into a plain string", async () => {
    const { result } = await runAggregate(baseInput, [
      [],
      [{ total: 1 }],
      [rawRow("api.request", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "12.500000")]
    ]);

    const [row] = result.rows;
    expect(row).toBeDefined();
    expect(typeof row?.totalQuantity).toBe("string");
    expect(row?.totalQuantity).toBe("12.5");
    expect(row?.totalQuantity).not.toBeInstanceOf(Prisma.Decimal);
  });

  it("normalizes bucket boundaries into UTC ISO-8601 strings", async () => {
    const { result } = await runAggregate(baseInput, [
      [],
      [{ total: 1 }],
      [rawRow("api.request", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "1")]
    ]);

    const [row] = result.rows;
    expect(row).toEqual({
      metricKey: "api.request",
      bucketStart: "2026-01-01T00:00:00.000Z",
      bucketEnd: "2026-01-02T00:00:00.000Z",
      totalQuantity: "1"
    });
  });

  it("returns zero rows and zero total for a range with no data", async () => {
    const { result } = await runAggregate(baseInput, [[], [{ total: 0 }], []]);

    expect(result).toEqual({ rows: [], total: 0 });
  });

  it("propagates database errors to the caller", async () => {
    const queryRaw = vi.fn().mockRejectedValue(new Error("aggregate failed"));
    const tx = { $queryRaw: queryRaw };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx))
    } as unknown as PrismaClient;
    const repository = new UsageRepository(prisma, TENANT_ID, testLogger());

    await expect(repository.aggregateSummary(baseInput)).rejects.toThrow("aggregate failed");
  });
});
