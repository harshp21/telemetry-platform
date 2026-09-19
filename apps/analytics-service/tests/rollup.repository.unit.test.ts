import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { RollupRepository } from "../src/repositories/rollup.repository";
import type {
  MetricsCacheInput,
  MetricsPageInput,
  MetricsRangeInput
} from "../src/repositories/rollup.repository";
import { ANALYTICS_GRANULARITY, ANALYTICS_METRICS } from "../src/constants";

/**
 * Shape assertions for `RollupRepository` against a Prisma double (T-051, slice 2).
 *
 * ## Why this file exists at all, and what it can prove that the integration suite cannot
 *
 * **S-46.** `"MetricRollup"` and `"UsageLine"` both have RLS enabled with a
 * `current_setting('app.tenant_id')` policy, so an integration case *cannot* observe the
 * application-layer tenant predicate: the policy returns the identical rows whether or not the
 * repository writes `WHERE "tenantId" = $1`. S-46 measured exactly that on billing's
 * `absorbLateUsage` -- four mutations, the two-tenant integration case green under all four.
 * `AI11` in `analytics.integration.test.ts` therefore pins the *outcome* and says so in its own
 * comment; **`AM16` below is the only thing on this tree that goes red when the tenant
 * predicate is removed**, and it does so by asserting the emitted SQL's bound values rather
 * than any row set.
 *
 * The same argument applies to the bucket expression: under a UTC server the epic's
 * `AT TIME ZONE 'UTC'` form and the correct bare form return identical rows, so `AM13`'s text
 * assertion is a guard the integration suite cannot supply. `analytics.timezone.integration.
 * test.ts` supplies the behavioural half by pinning a non-UTC session.
 */

const TENANT_ID = "11111111-1111-4111-8111-111111111111" as TenantId;
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";

const FROM = "2026-03-01T00:00:00.000Z";
const TO = "2026-03-04T00:00:00.000Z";
/** The same instants with a non-Z offset; `iso8601Schema` admits them, so the repository must. */
const FROM_WITH_OFFSET = "2026-03-01T05:30:00.000+05:30";
const METRIC_KEY = "api.request";

/**
 * Hard literals, deliberately **not** imported from `src/`, mirroring the same decision in
 * `apps/usage-service/tests/usage.repository.unit.test.ts`.
 *
 * `.claude/rules/constants.md` exists to stop one value being restated and drifting. Here the
 * subject of the assertion *is* the exact SQL text, so the literal is the specification:
 * deriving it from the code under test would make the expectation move with the production
 * constant and blind the case to the mutation it names.
 */
const EXPECTED_TIMESTAMP_CAST = "::timestamp(3)";
/** The S-18 defect: a cast that puts the session zone back into the comparison. */
const FORBIDDEN_TIMESTAMPTZ_CAST = "::timestamptz";
/**
 * The epic's defect (S-53). Applied to a naive **column** this yields a `timestamptz` and
 * shifts every bucket boundary by the server offset -- reproduced at Gate 1 on the real table,
 * where a `2026-03-01 03:00` row buckets as `2026-02-28` under `America/New_York`.
 */
const FORBIDDEN_COLUMN_TIME_ZONE_CONVERSION = "AT TIME ZONE";
/** The epic's other defect: identifiers that match nothing in this database. */
const FORBIDDEN_SNAKE_CASE = ["usage_lines", "period_start", "metric_key", "tenant_id"] as const;

/** Expected `DATE_TRUNC` text per granularity, written out rather than generated. */
const EXPECTED_BUCKET_EXPRESSION = {
  [ANALYTICS_GRANULARITY.HOUR]: `DATE_TRUNC('hour', "periodStart")`,
  [ANALYTICS_GRANULARITY.DAY]: `DATE_TRUNC('day', "periodStart")`,
  [ANALYTICS_GRANULARITY.WEEK]: `DATE_TRUNC('week', "periodStart")`
} as const;

const EXPECTED_INTERVAL = {
  [ANALYTICS_GRANULARITY.HOUR]: `INTERVAL '1 hour'`,
  [ANALYTICS_GRANULARITY.DAY]: `INTERVAL '1 day'`,
  [ANALYTICS_GRANULARITY.WEEK]: `INTERVAL '1 week'`
} as const;

/** The Prisma enum spelling of `MetricRollup.granularity`, cast rather than bound. */
const EXPECTED_ROLLUP_ENUM = {
  [ANALYTICS_GRANULARITY.HOUR]: `'HOUR'::"Granularity"`,
  [ANALYTICS_GRANULARITY.DAY]: `'DAY'::"Granularity"`,
  [ANALYTICS_GRANULARITY.WEEK]: `'WEEK'::"Granularity"`
} as const;

const SET_CONFIG_FUNCTION = "set_config";
/** `is_local = true` -- the setting must not outlive the transaction on a pooled connection. */
const TRANSACTION_LOCAL_ARGUMENT = ", true)";

const testLogger = () => ({ error: vi.fn(), debug: vi.fn() });

const pageInput = (overrides: Partial<MetricsPageInput> = {}): MetricsPageInput => ({
  from: FROM,
  to: TO,
  granularity: ANALYTICS_GRANULARITY.DAY,
  page: ANALYTICS_METRICS.DEFAULT_PAGE,
  pageSize: ANALYTICS_METRICS.DEFAULT_PAGE_SIZE,
  ...overrides
});

const rangeInput = (overrides: Partial<MetricsRangeInput> = {}): MetricsRangeInput => ({
  from: FROM,
  to: TO,
  granularity: ANALYTICS_GRANULARITY.DAY,
  ...overrides
});

/** `cacheRange`'s narrower input: the same range with no metric dimension at all (D3). */
const cacheInput = (overrides: Partial<MetricsCacheInput> = {}): MetricsCacheInput => ({
  from: FROM,
  to: TO,
  granularity: ANALYTICS_GRANULARITY.DAY,
  ...overrides
});

const isSetConfigCall = (call: unknown[]): boolean =>
  String(call[0]).includes(SET_CONFIG_FUNCTION);

/**
 * Prisma double whose `$transaction` runs the callback immediately.
 *
 * `$queryRaw` answers `withTenant`'s own `set_config` statement with an empty result and
 * serves `results` to the repository's real statements, in order. Dispatching on the statement
 * text rather than on a call index keeps every assertion independent of how many session
 * settings `withTenant` writes -- otherwise adding one `set_config` silently re-points every
 * result and each case fails for a reason it is not about.
 */
const createPrismaMock = (results: unknown[]) => {
  const pending = [...results];
  const queryRaw = vi.fn(async (...args: unknown[]) => {
    if (isSetConfigCall(args)) {
      return [];
    }
    if (pending.length === 0) {
      throw new Error("A repository statement was issued with no mocked result remaining");
    }
    return pending.shift();
  });
  const executeRaw = vi.fn(async (_statement: Prisma.Sql) => 0);
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx))
  } as unknown as PrismaClient;

  return { prisma, queryRaw, executeRaw };
};

/**
 * Returns the repository's own statements, `set_config` filtered out. **Throws** when the
 * requested statement is absent rather than returning `undefined`, so a case cannot pass
 * vacuously against a repository that stopped issuing it (`.claude/rules/testing.md`).
 */
const statementAt = (queryRaw: ReturnType<typeof vi.fn>, index: number): Prisma.Sql => {
  const calls = queryRaw.mock.calls.filter((entry) => !isSetConfigCall(entry));
  const call = calls[index];
  if (!call) {
    throw new Error(
      `Expected a repository $queryRaw statement at index ${index}; saw ${calls.length}`
    );
  }
  return call[0] as Prisma.Sql;
};

/**
 * Returns the single statement `cacheRange` issued through `$executeRaw`. **Throws** when there
 * is none, so a case cannot pass vacuously against a repository that stopped writing.
 */
const executedStatement = (
  executeRaw: { mock: { calls: readonly (readonly [Prisma.Sql])[] } },
  index = 0
): Prisma.Sql => {
  const call = executeRaw.mock.calls[index];
  if (!call) {
    throw new Error(
      `Expected an $executeRaw statement at index ${index}; saw ${executeRaw.mock.calls.length}`
    );
  }
  return call[0];
};

const everyStatement = (queryRaw: ReturnType<typeof vi.fn>): Prisma.Sql[] =>
  queryRaw.mock.calls
    .filter((entry) => !isSetConfigCall(entry))
    .map((entry) => entry[0] as Prisma.Sql);

const rawUsageRow = (
  metricKey: string,
  bucketStart: string,
  bucketEnd: string,
  totalQuantity: string
) => ({
  metricKey,
  bucketStart: new Date(bucketStart),
  bucketEnd: new Date(bucketEnd),
  totalQuantity: new Prisma.Decimal(totalQuantity)
});

/** `aggregateFromUsage` issues a grouped count, then the page. */
const usageResults = (total: number, rows: unknown[]): unknown[] => [[{ total }], rows];

const runAggregate = async (
  input: MetricsPageInput = pageInput(),
  results: unknown[] = usageResults(0, [])
) => {
  const { prisma, queryRaw } = createPrismaMock(results);
  const repository = new RollupRepository(prisma, TENANT_ID, testLogger());
  const result = await repository.aggregateFromUsage(input);
  return { prisma, queryRaw, result };
};

const runCachedPage = async (
  input: MetricsPageInput = pageInput(),
  results: unknown[] = usageResults(0, [])
) => {
  const { prisma, queryRaw } = createPrismaMock(results);
  const repository = new RollupRepository(prisma, TENANT_ID, testLogger());
  const result = await repository.readCachedPage(input);
  return { prisma, queryRaw, result };
};

describe("RollupRepository.aggregateFromUsage", () => {
  it("AM13 - buckets with a bare DATE_TRUNC on the naive column, never AT TIME ZONE, for every granularity", async () => {
    // Plan decision D0-B / Q3, and the correction of the epic's snippet (S-53). Three things
    // are asserted together because the epic gets all three wrong in one line: the bucket
    // expression, the derived `bucketEnd` interval, and the identifier casing.
    for (const granularity of Object.values(ANALYTICS_GRANULARITY)) {
      const { queryRaw } = await runAggregate(pageInput({ granularity }));

      for (const statement of everyStatement(queryRaw)) {
        expect(
          statement.sql,
          `granularity=${granularity}: AT TIME ZONE on the column is the S-53 defect`
        ).not.toContain(FORBIDDEN_COLUMN_TIME_ZONE_CONVERSION);

        for (const snake of FORBIDDEN_SNAKE_CASE) {
          expect(
            statement.sql,
            `granularity=${granularity}: ${snake} matches no identifier in this database`
          ).not.toContain(snake);
        }
      }

      // The page statement is the one that projects the bucket; the count only groups by it.
      const pageSql = statementAt(queryRaw, 1).sql;
      expect(pageSql).toContain(EXPECTED_BUCKET_EXPRESSION[granularity]);
      // `bucketEnd` is derived, because `MetricRollup` has no such column (plan decision D4)
      // and both tiers must derive it the same way or they disagree by one interval.
      expect(pageSql).toContain(EXPECTED_INTERVAL[granularity]);
    }
  });

  it("AM13b - never binds the granularity as a parameter; it only ever selects a frozen fragment", async () => {
    // The whole reason `granularity` is a closed enum in the validator. If it ever appeared in
    // `values`, a caller-supplied string would be reaching the SQL layer.
    for (const granularity of Object.values(ANALYTICS_GRANULARITY)) {
      const { queryRaw } = await runAggregate(pageInput({ granularity }));

      for (const statement of everyStatement(queryRaw)) {
        expect(statement.values, `granularity=${granularity} was bound as a value`).not.toContain(
          granularity
        );
      }
    }
  });

  it("AM14 - emits the metricKey filter as a bound parameter, and omits it entirely when absent", async () => {
    const filtered = await runAggregate(pageInput({ metricKey: METRIC_KEY }));
    for (const statement of everyStatement(filtered.queryRaw)) {
      expect(statement.values).toContain(METRIC_KEY);
      // Bound, never interpolated -- the value must not appear in the SQL text.
      expect(statement.sql).not.toContain(METRIC_KEY);
    }

    const unfiltered = await runAggregate(pageInput());
    for (const statement of everyStatement(unfiltered.queryRaw)) {
      expect(statement.values).not.toContain(METRIC_KEY);
    }
  });

  it("AM15 - binds pageSize and the derived offset, and counts grouped rows rather than usage lines", async () => {
    const page = 3;
    const pageSize = 25;
    const { queryRaw, result } = await runAggregate(
      pageInput({ page, pageSize }),
      usageResults(7, [rawUsageRow(METRIC_KEY, FROM, TO, "1.5")])
    );

    const pageSql = statementAt(queryRaw, 1);
    expect(pageSql.values).toContain(pageSize);
    expect(pageSql.values).toContain((page - 1) * pageSize);

    // `total` is the grouped-row count the count statement returned, not `rows.length`.
    expect(result.total).toBe(7);
    expect(result.rows).toHaveLength(1);

    // The count statement groups by the same key the page does, or `total` describes a
    // different result set from the one being paged.
    const countSql = statementAt(queryRaw, 0).sql;
    expect(countSql).toContain(EXPECTED_BUCKET_EXPRESSION[ANALYTICS_GRANULARITY.DAY]);
    expect(countSql).not.toContain("LIMIT");
  });

  it("AM16 - carries the repository's own bound tenant on every statement, and no other tenant's id", async () => {
    // **The S-46 case.** This is the only assertion in the task that goes red when the
    // application-layer tenant predicate is removed: an integration case over an RLS-enabled
    // table returns the identical rows either way, so no row-set assertion can see it.
    const { queryRaw } = await runAggregate(pageInput({ metricKey: METRIC_KEY }));
    const statements = everyStatement(queryRaw);

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.values, `statement did not bind the tenant: ${statement.sql}`).toContain(
        TENANT_ID
      );
      expect(statement.values).not.toContain(OTHER_TENANT_ID);
      // Bound, not interpolated: an interpolated tenant id would satisfy a `.sql` check and
      // be an injection surface.
      expect(statement.sql).not.toContain(TENANT_ID);
    }
  });

  it("AM16b - opens the tenant-scoped transaction and sets app.tenant_id transaction-locally first", async () => {
    const { prisma, queryRaw } = await runAggregate();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const setConfigCalls = queryRaw.mock.calls.filter(isSetConfigCall);
    expect(setConfigCalls.length).toBeGreaterThan(0);
    expect(String(setConfigCalls[0]?.[0])).toContain(TRANSACTION_LOCAL_ARGUMENT);
    // It is the first statement on the connection: no query against a tenant-scoped table may
    // precede the RLS context (`.claude/rules/tenant-isolation.md` layer 4).
    expect(isSetConfigCall(queryRaw.mock.calls[0] ?? [])).toBe(true);
  });

  it("AM16c - normalizes both bounds in JS and casts them naive, never binding a JS Date", async () => {
    // S-18, and the half of it a `Z`-only fixture cannot catch. `new Date(iso).toISOString()`
    // resolves the offset in JavaScript; `::timestamp(3)` then makes the comparison UTC-to-UTC.
    // PostgreSQL's text -> timestamp cast DISCARDS an offset rather than converting it, so
    // casting the raw request string would trade a session-dependent bug for an
    // offset-dependent one.
    const { queryRaw } = await runAggregate(pageInput({ from: FROM_WITH_OFFSET }));

    for (const statement of everyStatement(queryRaw)) {
      expect(statement.sql).toContain(EXPECTED_TIMESTAMP_CAST);
      expect(statement.sql).not.toContain(FORBIDDEN_TIMESTAMPTZ_CAST);
      for (const value of statement.values) {
        expect(value, "a JS Date bound into $queryRaw crosses as timestamptz (S-18)").not.toBeInstanceOf(
          Date
        );
      }
      // The offset form was resolved to UTC in JS, so what is bound is the `Z` instant.
      expect(statement.values).toContain(new Date(FROM_WITH_OFFSET).toISOString());
      expect(statement.values).not.toContain(FROM_WITH_OFFSET);
    }
  });

  it("AM16d - returns totalQuantity as a string, never a Prisma.Decimal", async () => {
    // `Decimal(18,6)` exceeds IEEE-754 safe precision and `CLAUDE.md` forbids a
    // `Prisma.Decimal` reaching a JSON response. Normalization happens here and only here.
    const { result } = await runAggregate(
      pageInput(),
      usageResults(1, [rawUsageRow(METRIC_KEY, FROM, TO, "999999999999.999999")])
    );

    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(typeof row?.totalQuantity).toBe("string");
    expect(row?.totalQuantity).not.toBeInstanceOf(Prisma.Decimal);
    expect(row?.totalQuantity).toBe("999999999999.999999");
    expect(row?.bucketStart).toBe(FROM);
    expect(row?.bucketEnd).toBe(TO);
  });
});

describe("RollupRepository.readCachedPage", () => {
  it("AM13c - reads MetricRollup with the granularity as a cast enum literal, never a bound string", async () => {
    for (const granularity of Object.values(ANALYTICS_GRANULARITY)) {
      const { queryRaw } = await runCachedPage(pageInput({ granularity }));

      for (const statement of everyStatement(queryRaw)) {
        expect(statement.sql).toContain(EXPECTED_ROLLUP_ENUM[granularity]);
        expect(statement.sql).toContain(`"MetricRollup"`);
        expect(statement.values).not.toContain(granularity);
      }

      // `bucketEnd` derives from the same frozen map the UsageLine tier uses (D4), so the two
      // tiers cannot report different interval widths for one granularity.
      expect(statementAt(queryRaw, 1).sql).toContain(EXPECTED_INTERVAL[granularity]);
    }
  });

  it("AM16e - carries the bound tenant on every cache statement too", async () => {
    const { queryRaw } = await runCachedPage(pageInput({ metricKey: METRIC_KEY }));
    const statements = everyStatement(queryRaw);

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.values).toContain(TENANT_ID);
      expect(statement.values).not.toContain(OTHER_TENANT_ID);
      expect(statement.sql).not.toContain(TENANT_ID);
    }
  });

  it("AM16f - does not use a truncated lower bound, which would over-report an unaligned range", async () => {
    // Measured at Gate 3 (probe P-A2): for `[2026-03-01T06:00, 2026-03-04)` the `UsageLine`
    // tier returns one row worth `5.250000`, while a cache read whose lower bound had been
    // `DATE_TRUNC`ed returns three rows worth `22.750000` -- the whole `2026-03-01` bucket the
    // caller did not ask for. The service refuses to consult the cache for an unaligned range
    // at all (plan decision D10); this case pins that the repository does not quietly widen
    // the bound as a second line of defence.
    const { queryRaw } = await runCachedPage(pageInput());

    for (const statement of everyStatement(queryRaw)) {
      // The cache read truncates nothing: `"bucketStart"` is already a bucket boundary, and
      // the only correct lower bound is the caller's own `from`. Any `DATE_TRUNC` in this
      // statement would be widening one of them.
      expect(statement.sql).not.toContain("DATE_TRUNC");
      expect(statement.values).toContain(new Date(FROM).toISOString());
      expect(statement.values).toContain(new Date(TO).toISOString());
    }
  });
});

describe("RollupRepository.describeRangeCoverage", () => {
  it("AM17a - counts calendar buckets and cached buckets, and reports bucket alignment", async () => {
    const { prisma, queryRaw } = createPrismaMock([
      [{ expectedBuckets: 3, cachedBuckets: 2, bucketAligned: true }]
    ]);
    const repository = new RollupRepository(prisma, TENANT_ID, testLogger());

    const coverage = await repository.describeRangeCoverage(rangeInput());

    expect(coverage).toEqual({ expectedBuckets: 3, cachedBuckets: 2, bucketAligned: true });

    const sql = statementAt(queryRaw, 0);
    expect(sql.sql).toContain("generate_series");
    expect(sql.sql).toContain("COUNT(DISTINCT");
    expect(sql.values).toContain(TENANT_ID);
    expect(sql.values).not.toContain(OTHER_TENANT_ID);
  });

  it("AM17b - scopes the cached-bucket count by metricKey when the request is filtered", async () => {
    // Without this the count would report buckets in which *another* metric has rows, and a
    // filtered read would be served a cache that is missing its own metric's buckets.
    const { prisma, queryRaw } = createPrismaMock([
      [{ expectedBuckets: 3, cachedBuckets: 3, bucketAligned: true }]
    ]);
    const repository = new RollupRepository(prisma, TENANT_ID, testLogger());

    await repository.describeRangeCoverage(rangeInput({ metricKey: METRIC_KEY }));

    expect(statementAt(queryRaw, 0).values).toContain(METRIC_KEY);
  });
});

describe("RollupRepository.cacheRange", () => {
  it("AM17c - upserts on the natural key, binding only its own tenant", async () => {
    const { prisma, executeRaw } = createPrismaMock([]);
    const repository = new RollupRepository(prisma, TENANT_ID, testLogger());

    await repository.cacheRange(cacheInput());

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const statement = executedStatement(executeRaw);
    expect(statement.sql).toContain("ON CONFLICT");
    expect(statement.sql).toContain(`"MetricRollup"`);
    expect(statement.sql).toContain(EXPECTED_ROLLUP_ENUM[ANALYTICS_GRANULARITY.DAY]);
    expect(statement.values).toContain(TENANT_ID);
    expect(statement.values).not.toContain(OTHER_TENANT_ID);
    // The written bucket expression is the same one the read projects, or the cache would key
    // rows the read can never find.
    expect(statement.sql).toContain(EXPECTED_BUCKET_EXPRESSION[ANALYTICS_GRANULARITY.DAY]);
    expect(statement.sql).not.toContain(FORBIDDEN_COLUMN_TIME_ZONE_CONVERSION);
  });

  it("AM17d - cannot express a metricKey-filtered cache write, and writes every metric in the range", async () => {
    // Plan decision D3, enforced at the **type** rather than only in the service.
    // `cacheRange` takes `MetricsCacheInput`, which has no `metricKey` member, so a filtered
    // write is not expressible at this boundary. The `@ts-expect-error` below is the assertion:
    // it fails `pnpm typecheck` if that line ever stops being an error, i.e. if someone widens
    // the parameter back to `MetricsRangeInput`.
    //
    // State the guarantee at the strength it holds: this makes the *typed* call a compile
    // error. It does not make a filtered write unrepresentable -- a caller could still
    // pre-filter the rows some other way, and the SQL is text. The service-level refusal
    // (`AM17`/`AM18` in `analytics.service.unit.test.ts`) is the other layer.
    const { prisma, executeRaw } = createPrismaMock([]);
    const repository = new RollupRepository(prisma, TENANT_ID, testLogger());

    await repository.cacheRange({
      ...cacheInput(),
      // @ts-expect-error - a filtered cache write is not expressible (plan decision D3)
      metricKey: METRIC_KEY
    });

    const statement = executedStatement(executeRaw);
    expect(statement.values).not.toContain(METRIC_KEY);
    expect(statement.sql).not.toContain(METRIC_KEY);
  });
});
