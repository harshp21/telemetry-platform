import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { UsageRepository } from "../src/repositories/usage.repository";
import type { UsageSummaryQueryInput } from "../src/repositories/usage.repository";
import {
  DATABASE_SESSION_SETTINGS,
  USAGE_SUMMARY_CONSTANTS,
  USAGE_SUMMARY_GRANULARITY
} from "../src/constants";

const TENANT_ID = "11111111-1111-4111-8111-111111111111" as TenantId;
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";

const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-01-08T00:00:00.000Z";
// The same two instants written with a non-Z offset. `iso8601Schema` is
// `z.string().datetime({ offset: true })`, so these are legal request values.
const FROM_WITH_OFFSET = "2026-01-01T05:30:00.000+05:30";
const TO_WITH_OFFSET = "2026-01-08T05:30:00.000+05:30";

/** Position of each bound parameter in the range predicate's `values` array. */
const BOUND_INDEX = {
  TENANT_ID: 0,
  FROM: 1,
  TO: 2
} as const;

/** Order of the `set_config` statements `withTenant` issues before any aggregate query. */
const SET_CONFIG_INDEX = {
  TENANT_ID: 0,
  TIME_ZONE: 1
} as const;

/** Order of the aggregate queries `aggregateSummary` issues inside the transaction. */
const AGGREGATE_INDEX = {
  COUNT: 0,
  PAGE: 1
} as const;

/**
 * Argument positions inside a tagged-template `$queryRaw` call: the template strings, then
 * `set_config`'s bound setting name and setting value.
 */
const TEMPLATE_ARG = {
  STRINGS: 0,
  SETTING_NAME: 1,
  SETTING_VALUE: 2
} as const;

const SET_CONFIG_FUNCTION = "set_config";
/** `is_local = true` — the setting must not outlive the transaction on a pooled connection. */
const TRANSACTION_LOCAL_ARGUMENT = ", true)";

/**
 * Hard literals, deliberately NOT imported from `src/constants`, and the one place in this
 * file where `.claude/rules/constants.md` is answered rather than followed.
 *
 * That rule exists to stop one magic value being restated in several places and drifting
 * apart. Here the subject of the assertion IS the exact wire format, so the literal is the
 * specification: deriving it from the code under test makes the expectation move with the
 * production constant and the test blind to the very mutations it names. Measured — both of
 * these pass the derived form and fail this one: `::timestamptz` reintroduces S-18 (a
 * `timestamptz` bound resolves through the session zone; `'2026-01-01T00:00:00.000Z'`
 * renders `2026-01-01 05:30:00` naive under `Asia/Kolkata`) and `::timestamp(0)` rounds
 * `2026-01-31T23:59:59.999Z` up to `2026-02-01 00:00:00`, moving a row across an exclusive
 * upper bound.
 */
const EXPECTED_TIMESTAMP_CAST = "::timestamp(3)";
/** The S-18 defect itself: a cast that puts the session zone back into the comparison. */
const FORBIDDEN_TIMESTAMPTZ_CAST = "::timestamptz";

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

const isSetConfigCall = (call: unknown[]): boolean =>
  String(call[TEMPLATE_ARG.STRINGS]).includes(SET_CONFIG_FUNCTION);

/**
 * Builds a Prisma double whose `$transaction` immediately runs the callback with a
 * transaction client.
 *
 * `$queryRaw` answers the session `set_config` statements that
 * TenantScopedRepository.withTenant issues with an empty result, and serves
 * `aggregateResults` to the aggregate queries in `AGGREGATE_INDEX` order. Dispatching on
 * the statement rather than on a call index keeps every assertion in this file independent
 * of how many session settings `withTenant` writes -- otherwise adding one `set_config`
 * silently re-points every result and each test fails for a reason it is not about.
 */
const createPrismaMock = (aggregateResults: unknown[]) => {
  const pending = [...aggregateResults];
  const queryRaw = vi.fn(async (...args: unknown[]) => {
    if (isSetConfigCall(args)) {
      return [];
    }
    if (pending.length === 0) {
      throw new Error("Aggregate query issued with no mocked result remaining");
    }
    return pending.shift();
  });
  const tx = { $queryRaw: queryRaw };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx))
  } as unknown as PrismaClient;

  return { prisma, queryRaw };
};

const setConfigAt = (queryRaw: ReturnType<typeof vi.fn>, index: number): unknown[] => {
  const call = queryRaw.mock.calls.filter(isSetConfigCall)[index];
  if (!call) {
    throw new Error(`Expected a set_config statement at index ${index}`);
  }
  return call;
};

const aggregateSqlAt = (queryRaw: ReturnType<typeof vi.fn>, index: number): Prisma.Sql => {
  const call = queryRaw.mock.calls.filter((entry) => !isSetConfigCall(entry))[index];
  if (!call) {
    throw new Error(`Expected an aggregate $queryRaw call at index ${index}`);
  }
  return call[0] as Prisma.Sql;
};

const aggregateResults = (total: number, rows: unknown[]): unknown[] => [[{ total }], rows];

const runAggregate = async (
  input: UsageSummaryQueryInput,
  results: unknown[] = aggregateResults(0, [])
) => {
  const { prisma, queryRaw } = createPrismaMock(results);
  const repository = new UsageRepository(prisma, TENANT_ID, testLogger());
  const result = await repository.aggregateSummary(input);
  return {
    prisma,
    queryRaw,
    result,
    countSql: aggregateSqlAt(queryRaw, AGGREGATE_INDEX.COUNT),
    rowsSql: aggregateSqlAt(queryRaw, AGGREGATE_INDEX.PAGE)
  };
};

describe("UsageRepository.aggregateSummary", () => {
  it("runs the aggregation inside the tenant-scoped transaction wrapper", async () => {
    const { prisma } = await runAggregate(baseInput);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("sets app.tenant_id before issuing any aggregate query", async () => {
    const { queryRaw } = await runAggregate(baseInput);

    const setConfigCall = setConfigAt(queryRaw, SET_CONFIG_INDEX.TENANT_ID);
    expect(setConfigCall[TEMPLATE_ARG.SETTING_NAME]).toBe(DATABASE_SESSION_SETTINGS.TENANT_ID);
    expect(setConfigCall[TEMPLATE_ARG.SETTING_VALUE]).toBe(TENANT_ID);
    expect(String(setConfigCall[TEMPLATE_ARG.STRINGS])).toContain(TRANSACTION_LOCAL_ARGUMENT);
    // The tenant statement is the FIRST statement of the transaction: nothing may run
    // before RLS context exists, and the S-18 zone pin must not displace it.
    expect(queryRaw.mock.calls.findIndex(isSetConfigCall)).toBe(SET_CONFIG_INDEX.TENANT_ID);
  });

  it("pins the session time zone to UTC after setting the tenant id, before any aggregate query", async () => {
    const { queryRaw } = await runAggregate(baseInput);

    const zoneCall = setConfigAt(queryRaw, SET_CONFIG_INDEX.TIME_ZONE);
    expect(zoneCall[TEMPLATE_ARG.SETTING_NAME]).toBe(DATABASE_SESSION_SETTINGS.TIME_ZONE);
    expect(zoneCall[TEMPLATE_ARG.SETTING_VALUE]).toBe(DATABASE_SESSION_SETTINGS.TIME_ZONE_UTC);
    expect(String(zoneCall[TEMPLATE_ARG.STRINGS])).toContain(TRANSACTION_LOCAL_ARGUMENT);
    // Both session statements precede every aggregate query.
    const firstAggregateCall = queryRaw.mock.calls.findIndex((call) => !isSetConfigCall(call));
    const zoneCallPosition = queryRaw.mock.calls.indexOf(zoneCall as never);
    expect(zoneCallPosition).toBeLessThan(firstAggregateCall);
  });

  it("applies an explicit tenantId filter to the count query and the page query", async () => {
    const { countSql, rowsSql } = await runAggregate(baseInput);

    expect(countSql.text).toContain('"tenantId" = $1');
    expect(countSql.values[BOUND_INDEX.TENANT_ID]).toBe(TENANT_ID);
    expect(rowsSql.text).toContain('"tenantId" = $1');
    expect(rowsSql.values[BOUND_INDEX.TENANT_ID]).toBe(TENANT_ID);
    expect(countSql.values).not.toContain(OTHER_TENANT_ID);
    expect(rowsSql.values).not.toContain(OTHER_TENANT_ID);
  });

  it("uses an inclusive from boundary and an exclusive to boundary", async () => {
    const { rowsSql } = await runAggregate(baseInput);

    expect(rowsSql.text).toContain('"periodStart" >= $2');
    expect(rowsSql.text).toContain('"periodStart" < $3');
  });

  it("binds both range bounds as UTC-naive timestamps, not as timestamptz Dates", async () => {
    const { countSql, rowsSql } = await runAggregate(baseInput);

    // A bound JS Date arrives as `timestamp with time zone`, and comparing that to
    // `"periodStart"` (`timestamp(3) without time zone`) resolves through the database
    // SESSION time zone -- so the same request returns different rows on different
    // servers (S-18). The bound value must therefore be a UTC-normalized ISO string
    // cast to a naive timestamp, and never a Date.
    //
    // The cast text is a hard literal (see EXPECTED_TIMESTAMP_CAST) so that changing the
    // production constant fails here instead of following it.
    for (const sql of [countSql, rowsSql]) {
      expect(sql.text).toContain(`"periodStart" >= $2${EXPECTED_TIMESTAMP_CAST}`);
      expect(sql.text).toContain(`"periodStart" < $3${EXPECTED_TIMESTAMP_CAST}`);
      // A naive-timestamp cast is not enough on its own: `::timestamptz` would also satisfy
      // "is cast", while putting the session zone straight back into the comparison.
      expect(sql.text).not.toContain(FORBIDDEN_TIMESTAMPTZ_CAST);
      expect(sql.values[BOUND_INDEX.FROM]).toBe(FROM);
      expect(sql.values[BOUND_INDEX.TO]).toBe(TO);
      expect(sql.values[BOUND_INDEX.FROM]).not.toBeInstanceOf(Date);
      expect(sql.values[BOUND_INDEX.TO]).not.toBeInstanceOf(Date);
    }
  });

  it("normalizes an offset-bearing bound to the identical value as its Z equivalent", async () => {
    const zulu = await runAggregate(baseInput);
    const offset = await runAggregate({
      ...baseInput,
      from: FROM_WITH_OFFSET,
      to: TO_WITH_OFFSET
    });

    // PostgreSQL's text -> timestamp cast DISCARDS an offset instead of converting it
    // ('2026-01-01T00:00:00+05:30'::timestamp(3) is 2026-01-01 00:00:00), so casting the
    // raw request string would trade a session-dependent bug for an offset-dependent one.
    // The normalization has to happen in JS, before the value reaches SQL.
    expect(offset.rowsSql.values[BOUND_INDEX.FROM]).toBe(zulu.rowsSql.values[BOUND_INDEX.FROM]);
    expect(offset.rowsSql.values[BOUND_INDEX.TO]).toBe(zulu.rowsSql.values[BOUND_INDEX.TO]);
    expect(offset.rowsSql.values[BOUND_INDEX.FROM]).toBe(FROM);
    expect(offset.rowsSql.values[BOUND_INDEX.TO]).toBe(TO);
    expect(offset.rowsSql.values).not.toContain(FROM_WITH_OFFSET);
    expect(offset.rowsSql.values).not.toContain(TO_WITH_OFFSET);
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
    // DATE_TRUNC alone yields UTC bucket boundaries. Measured across four session zones:
    // DATE_TRUNC('day', "periodStart") returns the same instant under each.
    //
    // The direction matters. `AT TIME ZONE 'UTC'` applied to the COLUMN would turn a naive
    // timestamp into a timestamptz and shift every day/week boundary by the server offset
    // -- verified: DATE_TRUNC('day','2026-01-01 03:00:00'::timestamp(3) AT TIME ZONE 'UTC')
    // renders as 2026-01-01 00:00:00+05:30 on an Asia/Kolkata session. Applied to a bound
    // PARAMETER it is correct and equivalent to the `::timestamp(3)` cast this repository
    // uses. So this assertion forbids converting the column, not normalizing the bound.
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
    const { countSql, result } = await runAggregate(
      baseInput,
      aggregateResults(3, [
        rawRow("api.request", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "10")
      ])
    );

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
    const { result } = await runAggregate(
      baseInput,
      aggregateResults(1, [
        rawRow("api.request", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "12.500000")
      ])
    );

    const [row] = result.rows;
    expect(row).toBeDefined();
    expect(typeof row?.totalQuantity).toBe("string");
    expect(row?.totalQuantity).toBe("12.5");
    expect(row?.totalQuantity).not.toBeInstanceOf(Prisma.Decimal);
  });

  it("normalizes bucket boundaries into UTC ISO-8601 strings", async () => {
    const { result } = await runAggregate(
      baseInput,
      aggregateResults(1, [
        rawRow("api.request", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "1")
      ])
    );

    const [row] = result.rows;
    expect(row).toEqual({
      metricKey: "api.request",
      bucketStart: "2026-01-01T00:00:00.000Z",
      bucketEnd: "2026-01-02T00:00:00.000Z",
      totalQuantity: "1"
    });
  });

  it("returns zero rows and zero total for a range with no data", async () => {
    const { result } = await runAggregate(baseInput, aggregateResults(0, []));

    expect(result).toEqual({ rows: [], total: 0 });
  });

  it("propagates database errors to the caller", async () => {
    const queryRaw = vi.fn().mockRejectedValue(new Error("aggregate failed"));
    // Rejects on the very first statement, so this covers set_config failures too.
    const tx = { $queryRaw: queryRaw };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx))
    } as unknown as PrismaClient;
    const repository = new UsageRepository(prisma, TENANT_ID, testLogger());

    await expect(repository.aggregateSummary(baseInput)).rejects.toThrow("aggregate failed");
  });
});
