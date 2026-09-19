import { describe, expect, it } from "vitest";
import { metricsQuerySchema } from "../src/validators/metrics-query.validator";
import { ANALYTICS_GRANULARITY, ANALYTICS_METRICS } from "../src/constants";

/**
 * Query contract for `GET /v1/analytics/metrics` (T-051, slice 1).
 *
 * The granularity parsed here is the **sole key** used to look up a constant `Prisma.Sql`
 * fragment in `RollupRepository`, so what this file really guards is that no string outside
 * the closed enum can ever reach the SQL layer. `AM5` and `AM6` are that guard; the repository
 * suite's fragment census is the other half.
 *
 * Nothing is re-typed: granularities, pagination bounds and the range message all come from
 * `../src/constants` (`.claude/rules/constants.md` applies to tests too).
 */

/** A range every case that is not about the range itself can reuse. */
const VALID_RANGE = {
  from: "2026-03-01T00:00:00.000Z",
  to: "2026-03-04T00:00:00.000Z"
} as const;

const METRIC_KEY = "api.request";

/** `iso8601Schema` is `z.string().datetime({ offset: true })`, so an offset form is legal input. */
const OFFSET_RANGE = {
  from: "2026-03-01T05:30:00.000+05:30",
  to: "2026-03-04T05:30:00.000+05:30"
} as const;

const baseQuery = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...VALID_RANGE,
  granularity: ANALYTICS_GRANULARITY.DAY,
  ...overrides
});

/** Collects the dotted paths zod reported, so a case can name the field it is about. */
const issuePaths = (result: ReturnType<typeof metricsQuerySchema.safeParse>): string[] =>
  result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));

describe("metricsQuerySchema", () => {
  it("AM1 - parses a minimal valid query and applies the pagination defaults", () => {
    const result = metricsQuerySchema.safeParse(baseQuery());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`expected a successful parse, got ${JSON.stringify(issuePaths(result))}`);
    }
    expect(result.data).toEqual({
      from: VALID_RANGE.from,
      to: VALID_RANGE.to,
      granularity: ANALYTICS_GRANULARITY.DAY,
      page: ANALYTICS_METRICS.DEFAULT_PAGE,
      pageSize: ANALYTICS_METRICS.DEFAULT_PAGE_SIZE
    });
    // `metricKey` is absent rather than present-and-undefined: the repository branches on
    // truthiness to decide whether to emit a filter fragment at all.
    expect(result.data).not.toHaveProperty("metricKey");
  });

  it("AM2 - rejects a query with no from", () => {
    const query = baseQuery();
    delete query.from;

    const result = metricsQuerySchema.safeParse(query);

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("from");
  });

  it("AM3 - rejects a query with no to", () => {
    const query = baseQuery();
    delete query.to;

    const result = metricsQuerySchema.safeParse(query);

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("to");
  });

  it("AM4 - rejects from and to that are not ISO-8601 instants", () => {
    // A bare calendar date is the realistic mistake: it is what a dashboard's date picker
    // yields, and `new Date("2026-03-01")` happily parses it in JS. `iso8601Schema` does not.
    for (const notAnInstant of ["2026-03-01", "not-a-date", "", "1772409600"]) {
      const fromResult = metricsQuerySchema.safeParse(baseQuery({ from: notAnInstant }));
      expect(fromResult.success, `from=${notAnInstant} should not parse`).toBe(false);
      expect(issuePaths(fromResult)).toContain("from");

      const toResult = metricsQuerySchema.safeParse(baseQuery({ to: notAnInstant }));
      expect(toResult.success, `to=${notAnInstant} should not parse`).toBe(false);
      expect(issuePaths(toResult)).toContain("to");
    }
  });

  it("AM5 - rejects every granularity outside the closed enum, including the Prisma spelling", () => {
    // `"DAY"` is the spelling of `MetricRollup.granularity`'s Prisma enum. It is rejected on
    // purpose (plan decision D5): accepting both spellings would make this endpoint and
    // usage-service's summary disagree about what a granularity is called. `"month"`,
    // `"minute"` and the injection attempt are the other shapes worth naming -- the last of
    // those is why this enum exists at all, since the parsed value keys a SQL fragment.
    for (const rejected of [
      "DAY",
      "Day",
      "month",
      "minute",
      "year",
      "",
      "day'); DROP TABLE \"UsageLine\"; --"
    ]) {
      const result = metricsQuerySchema.safeParse(baseQuery({ granularity: rejected }));
      expect(result.success, `granularity=${rejected} should not parse`).toBe(false);
      expect(issuePaths(result)).toContain("granularity");
    }
  });

  it("AM6 - rejects a query with no granularity, rather than defaulting one", () => {
    const query = baseQuery();
    delete query.granularity;

    const result = metricsQuerySchema.safeParse(query);

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("granularity");
  });

  it("AM7 - accepts each of the three granularities", () => {
    for (const granularity of Object.values(ANALYTICS_GRANULARITY)) {
      const result = metricsQuerySchema.safeParse(baseQuery({ granularity }));
      expect(result.success, `granularity=${granularity} should parse`).toBe(true);
      if (result.success) {
        expect(result.data.granularity).toBe(granularity);
      }
    }
  });

  it("AM8 - rejects from equal to to, and from after to, with the range message", () => {
    const equal = metricsQuerySchema.safeParse(
      baseQuery({ from: VALID_RANGE.from, to: VALID_RANGE.from })
    );
    expect(equal.success).toBe(false);
    expect(issuePaths(equal)).toContain("to");
    if (!equal.success) {
      expect(equal.error.issues.map((issue) => issue.message)).toContain(
        ANALYTICS_METRICS.MESSAGE_INVALID_RANGE
      );
    }

    const reversed = metricsQuerySchema.safeParse(
      baseQuery({ from: VALID_RANGE.to, to: VALID_RANGE.from })
    );
    expect(reversed.success).toBe(false);
    expect(issuePaths(reversed)).toContain("to");
  });

  it("AM9 - accepts offset-bearing instants and preserves them verbatim", () => {
    // The validator must not normalize: `utcTimestampBound` in the repository is the one place
    // an instant is resolved to UTC, and it needs the value the caller actually sent. A
    // validator that silently rewrote `+05:30` to `Z` would move that responsibility somewhere
    // no docblock describes.
    const result = metricsQuerySchema.safeParse(baseQuery(OFFSET_RANGE));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBe(OFFSET_RANGE.from);
      expect(result.data.to).toBe(OFFSET_RANGE.to);
    }
  });

  it("AM10 - coerces page and pageSize from querystring strings", () => {
    // Fastify hands the querystring through as strings, so a schema that did not coerce would
    // put `"2"` into `(page - 1) * pageSize`.
    const result = metricsQuerySchema.safeParse(baseQuery({ page: "2", pageSize: "50" }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.pageSize).toBe(50);
    }
  });

  it("AM11 - rejects pageSize outside [MIN_PAGE_SIZE, MAX_PAGE_SIZE] rather than clamping it", () => {
    for (const rejected of [
      0,
      -1,
      ANALYTICS_METRICS.MAX_PAGE_SIZE + 1,
      ANALYTICS_METRICS.DEFAULT_PAGE_SIZE + 0.5
    ]) {
      const result = metricsQuerySchema.safeParse(baseQuery({ pageSize: rejected }));
      expect(result.success, `pageSize=${rejected} should not parse`).toBe(false);
      expect(issuePaths(result)).toContain("pageSize");
    }

    for (const accepted of [ANALYTICS_METRICS.MIN_PAGE_SIZE, ANALYTICS_METRICS.MAX_PAGE_SIZE]) {
      const result = metricsQuerySchema.safeParse(baseQuery({ pageSize: accepted }));
      expect(result.success, `pageSize=${accepted} should parse`).toBe(true);
    }
  });

  it("AM12 - bounds page above as well as below, so an offset overflow is a 400 and not a 500", () => {
    // Plan decision D2. S-40 records three declarations of `page` with no `.max()` and a
    // reachable `500`; analytics mirrors usage-service's raw `LIMIT/OFFSET`, where the failure
    // is PostgreSQL's `22003 bigint out of range` surfaced as Prisma `P2010`. Measured as
    // `telemetry_app` at Gate 1: `SELECT 1 LIMIT 20 OFFSET 2e19` raises it, `OFFSET 1e17` does
    // not. The point of this case is that the refusal happens in the validator, before any of
    // that can be reached.
    for (const rejected of [
      ANALYTICS_METRICS.MAX_PAGE + 1,
      1e18,
      Number.MAX_SAFE_INTEGER,
      "1e18"
    ]) {
      const result = metricsQuerySchema.safeParse(baseQuery({ page: rejected }));
      expect(result.success, `page=${String(rejected)} should not parse`).toBe(false);
      expect(issuePaths(result)).toContain("page");
    }

    for (const rejectedBelow of [0, -1, ANALYTICS_METRICS.MIN_PAGE - 1]) {
      const result = metricsQuerySchema.safeParse(baseQuery({ page: rejectedBelow }));
      expect(result.success, `page=${rejectedBelow} should not parse`).toBe(false);
      expect(issuePaths(result)).toContain("page");
    }

    for (const accepted of [ANALYTICS_METRICS.MIN_PAGE, ANALYTICS_METRICS.MAX_PAGE]) {
      const result = metricsQuerySchema.safeParse(baseQuery({ page: accepted }));
      expect(result.success, `page=${accepted} should parse`).toBe(true);
    }
  });

  it("AM12b - accepts an optional non-empty metricKey and rejects an empty one", () => {
    const withKey = metricsQuerySchema.safeParse(baseQuery({ metricKey: METRIC_KEY }));
    expect(withKey.success).toBe(true);
    if (withKey.success) {
      expect(withKey.data.metricKey).toBe(METRIC_KEY);
    }

    // An empty `metricKey` is rejected rather than treated as absent. Treating it as absent
    // would make `?metricKey=` silently mean "every metric", and under plan decision D3 that
    // is the difference between a request that may write the cache and one that may not.
    const empty = metricsQuerySchema.safeParse(baseQuery({ metricKey: "" }));
    expect(empty.success).toBe(false);
    expect(issuePaths(empty)).toContain("metricKey");
  });
});
