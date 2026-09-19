import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { RollupRepository } from "../src/repositories/rollup.repository";
import { AnalyticsService } from "../src/services/analytics.service";
import { ANALYTICS_GRANULARITY, ANALYTICS_METRICS } from "../src/constants";
import type { MetricsQuery } from "../src/validators/metrics-query.validator";

/**
 * `GET /v1/analytics/metrics` against a live PostgreSQL (T-051).
 *
 * Requires:
 *   DATABASE_URL        -> telemetry_app (NOSUPERUSER / NOBYPASSRLS) -- every read and write
 *                          under test goes through this role, so RLS enforces as it does in
 *                          production. Asserted, not assumed: see `AI0`.
 *   DIRECT_DATABASE_URL -> admin/owner -- seeds and tears down fixtures, which RLS would
 *                          otherwise block, and reads rows back independently of the code
 *                          under test.
 *
 * **Every connection is pinned to a non-UTC session zone.** This host's PostgreSQL defaults to
 * `Asia/Kolkata` and CI's `postgres:16-alpine` defaults to `UTC`, so a suite using the ambient
 * zone would be a non-UTC test here and a UTC-only test in CI -- and under `UTC` the correct
 * range predicate and the session-dependent one S-18 describes return identical rows. Pinning
 * makes the case mean the same thing on both. `analytics.timezone.integration.test.ts` owns the
 * wider zone matrix; this file's job is the composed two-tier read.
 *
 * Deliberately does **not** skip when the environment is wrong: a guard that fires exactly when
 * the bug is present would hide it.
 */

const ADMIN_URL_FALLBACK = "postgresql://postgres:postgres@localhost:5432/telemetry";
const SESSION_TIME_ZONE = "Asia/Kolkata";

/** `options=-c timezone=...` is the spelling that takes; a bare `?timezone=` is silently ignored. */
const CONNECTION_OPTIONS_PARAM = "options";
const TIME_ZONE_OPTION_PREFIX = "-c timezone=";

const METRIC_KEY = {
  PRIMARY: "api.request",
  SECONDARY: "storage.write"
} as const;

const EVENT_UNIT = "request";

/** All instants are exact UTC boundaries or interior points of a known day bucket. */
const INSTANT = {
  DAY_1_EARLY: "2026-03-01T03:00:00.000Z",
  DAY_1_LATER: "2026-03-01T03:30:00.000Z",
  DAY_1_AFTER_SIX: "2026-03-01T08:00:00.000Z",
  DAY_2_NOON: "2026-03-02T12:00:00.000Z",
  DAY_3_NOON: "2026-03-03T12:00:00.000Z"
} as const;

const BUCKET = {
  DAY_1: "2026-03-01T00:00:00.000Z",
  DAY_2: "2026-03-02T00:00:00.000Z",
  DAY_3: "2026-03-03T00:00:00.000Z",
  DAY_4: "2026-03-04T00:00:00.000Z",
  HOUR_1_START: "2026-03-01T03:00:00.000Z",
  HOUR_1_END: "2026-03-01T04:00:00.000Z",
  /** `2026-03-01` is a Sunday; the ISO week containing it starts Monday `2026-02-23`. */
  WEEK_START: "2026-02-23T00:00:00.000Z",
  WEEK_END: "2026-03-02T00:00:00.000Z"
} as const;

const RANGE = {
  /** Three day buckets, with `2026-03-02` deliberately empty of usage. */
  THREE_DAYS: { from: BUCKET.DAY_1, to: BUCKET.DAY_4 },
  /** One day bucket, so a complete cache is achievable. */
  ONE_DAY: { from: BUCKET.DAY_1, to: BUCKET.DAY_2 },
  /** Two day buckets, both of which can hold usage. */
  TWO_DAYS: { from: BUCKET.DAY_1, to: BUCKET.DAY_3 },
  /** A week bucket wide enough to contain the whole fixture. */
  ONE_WEEK: { from: BUCKET.WEEK_START, to: BUCKET.WEEK_END },
  /** Bounds that are **not** on a day boundary (plan decision D10). */
  UNALIGNED: { from: "2026-03-01T06:00:00.000Z", to: BUCKET.DAY_4 }
} as const;

/**
 * Quantities at the column's own scale, with the string each one renders as after
 * `SUM(numeric(18,6))` crosses `Prisma.Decimal` and `String()`. decimal.js strips trailing
 * zeros, so `10.500000` renders `"10.5"` and not `"10.500000"` even though `psql` prints the
 * latter. Recorded here rather than derived, because the rendering *is* what the API returns.
 */
const QUANTITY = {
  PRIMARY_DAY_1: "10.500000",
  PRIMARY_DAY_1_RENDERED: "10.5",
  PRIMARY_DAY_3: "5.250000",
  PRIMARY_DAY_3_RENDERED: "5.25",
  SECONDARY_DAY_1: "7.000000",
  SECONDARY_DAY_1_RENDERED: "7",
  PRIMARY_DAY_2: "3.000000",
  PRIMARY_DAY_2_RENDERED: "3",
  PRIMARY_DAY_1_EXTRA: "2.000000",
  PRIMARY_DAY_1_EXTRA_RENDERED: "2",
  /** `10.500000 + 7.000000 + 5.250000 + 2.000000` summed at the week bucket. */
  WEEK_TOTAL_PRIMARY_RENDERED: "12.5",
  OTHER_TENANT: "99.000000",
  OTHER_TENANT_RENDERED: "99",
  /**
   * The two halves of `999999999999.999999`, the largest `Decimal(18,6)` can hold. A float64
   * round trip cannot reproduce 18 significant digits, so an exact match proves the value
   * never passed through a JS `number`.
   */
  PRECISION_PART_A: "999999999999.499999",
  PRECISION_PART_B: "0.500000",
  PRECISION_RENDERED: "999999999999.999999"
} as const;

/**
 * A cache value no aggregation could produce, written straight into `MetricRollup` through the
 * admin connection.
 *
 * This is what makes the cache-tier cases non-vacuous. Asserting that a cached read returns the
 * same numbers as the fallback proves nothing -- a broken cache branch that silently fell back
 * would pass. A sentinel can only appear if the row actually came out of `MetricRollup`.
 */
const CACHE_SENTINEL = {
  VALUE: "424242.000000",
  RENDERED: "424242"
} as const;

const NO_OP_LOGGER = {
  error: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined
};

interface RoleAttributes {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
}

interface FixtureRow {
  readonly metricKey: string;
  readonly instant: string;
  readonly quantity: string;
  /**
   * Written so the suite can seed both states. Plan decision D1 drops the epic's
   * `AND billed = true`, and `AI4b` is the case that would go red if it came back.
   */
  readonly billed?: boolean;
}

const requireEnv = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`${name} must be set for the analytics metrics integration test`);
  }
  return value;
};

const withSessionTimeZone = (url: string, timeZone: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set(CONNECTION_OPTIONS_PARAM, `${TIME_ZONE_OPTION_PREFIX}${timeZone}`);
  return parsed.toString();
};

const query = (overrides: Partial<MetricsQuery> & Pick<MetricsQuery, "from" | "to">): MetricsQuery => ({
  granularity: ANALYTICS_GRANULARITY.DAY,
  page: ANALYTICS_METRICS.DEFAULT_PAGE,
  pageSize: ANALYTICS_METRICS.DEFAULT_PAGE_SIZE,
  ...overrides
});

describe("GET /v1/analytics/metrics over a live database (integration)", () => {
  const suiteId = randomUUID();
  /** Every fixture row this suite creates is attributable to T-051 at a glance. */
  const tenantPrefix = `t051-${suiteId}-`;

  let admin: PrismaClient;
  let appClient: PrismaClient;
  let appRole: RoleAttributes | undefined;

  const tenantIdFor = (label: string): TenantId => `${tenantPrefix}${label}` as TenantId;

  const service = (): AnalyticsService =>
    new AnalyticsService(
      (boundTenantId) => new RollupRepository(appClient, boundTenantId, NO_OP_LOGGER),
      NO_OP_LOGGER as never
    );

  /** Seeds one tenant with the given usage rows, through the owner connection. */
  const seedTenant = async (label: string, rows: readonly FixtureRow[]): Promise<TenantId> => {
    const tenantId = tenantIdFor(label);
    await admin.tenant.create({ data: { id: tenantId, name: `T-051 ${label} ${suiteId}` } });

    const eventId = (row: FixtureRow, index: number): string =>
      `${tenantId}-ev-${index}-${row.metricKey}`;

    await admin.event.createMany({
      data: rows.map((row, index) => ({
        id: eventId(row, index),
        tenantId,
        idempotencyKey: eventId(row, index),
        eventType: row.metricKey,
        quantity: row.quantity,
        unit: EVENT_UNIT,
        occurredAt: new Date(row.instant)
      }))
    });
    await admin.usageLine.createMany({
      data: rows.map((row, index) => ({
        id: `${tenantId}-ul-${index}`,
        tenantId,
        eventId: eventId(row, index),
        metricKey: row.metricKey,
        quantity: row.quantity,
        periodStart: new Date(row.instant),
        periodEnd: new Date(row.instant),
        billed: row.billed ?? false
      }))
    });

    return tenantId;
  };

  /** Reads the cache back through the **admin** connection, never through the code under test. */
  const cachedRowsFor = async (tenantId: TenantId) =>
    admin.metricRollup.findMany({
      where: { tenantId },
      orderBy: [{ bucketStart: "asc" }, { metricKey: "asc" }],
      select: { metricKey: true, granularity: true, bucketStart: true, value: true }
    });

  beforeAll(async () => {
    admin = new PrismaClient({
      datasourceUrl: withSessionTimeZone(
        requireEnv("DIRECT_DATABASE_URL", ADMIN_URL_FALLBACK),
        SESSION_TIME_ZONE
      )
    });
    appClient = new PrismaClient({
      datasourceUrl: withSessionTimeZone(requireEnv("DATABASE_URL"), SESSION_TIME_ZONE)
    });

    const roles = await appClient.$queryRaw<RoleAttributes[]>`
      SELECT r.rolname, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user
    `;
    appRole = roles[0];
  });

  afterAll(async () => {
    if (admin) {
      // Ordered by foreign key: usage lines reference events, events reference tenants.
      await admin.metricRollup.deleteMany({ where: { tenantId: { startsWith: tenantPrefix } } });
      await admin.usageLine.deleteMany({ where: { tenantId: { startsWith: tenantPrefix } } });
      await admin.event.deleteMany({ where: { tenantId: { startsWith: tenantPrefix } } });
      await admin.tenant.deleteMany({ where: { id: { startsWith: tenantPrefix } } });
      await admin.$disconnect();
    }
    if (appClient) {
      await appClient.$disconnect();
    }
  });

  it("AI0 - reads and writes through a NOSUPERUSER, NOBYPASSRLS role on a non-UTC session", async () => {
    // The docstring states both as properties of this suite, so they are checked rather than
    // trusted. A passing RLS assertion as a superuser establishes nothing
    // (`.claude/rules/tenant-isolation.md`), and a UTC session would make the bucketing and
    // range cases agree with the defect they exist to catch.
    expect(appRole, "DATABASE_URL did not resolve to a known role").toBeDefined();
    expect(appRole?.rolsuper, `role ${appRole?.rolname} is a superuser`).toBe(false);
    expect(appRole?.rolbypassrls, `role ${appRole?.rolname} holds BYPASSRLS`).toBe(false);

    const zone = await appClient.$queryRaw<{ timeZone: string }[]>`
      SELECT current_setting('TimeZone') AS "timeZone"
    `;
    expect(zone[0]?.timeZone).toBe(SESSION_TIME_ZONE);
  });

  it("AI1 - returns a paginated envelope whose totalQuantity is a string of full Decimal precision", async () => {
    const tenantId = await seedTenant("ai1", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRECISION_PART_A },
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_LATER, quantity: QUANTITY.PRECISION_PART_B }
    ]);

    const result = await service().getMetricsRollup(tenantId, query(RANGE.ONE_DAY));

    expect(result.page).toBe(ANALYTICS_METRICS.DEFAULT_PAGE);
    expect(result.pageSize).toBe(ANALYTICS_METRICS.DEFAULT_PAGE_SIZE);
    expect(result.total).toBe(1);
    expect(result.items).toEqual([
      {
        metricKey: METRIC_KEY.PRIMARY,
        bucketStart: BUCKET.DAY_1,
        bucketEnd: BUCKET.DAY_2,
        totalQuantity: QUANTITY.PRECISION_RENDERED
      }
    ]);
    // AC11: no `Prisma.Decimal` escapes the repository, and the 18 significant digits survive,
    // which a float64 round trip could not reproduce.
    expect(typeof result.items[0]?.totalQuantity).toBe("string");
    expect(result.items[0]?.totalQuantity).not.toBeInstanceOf(Prisma.Decimal);
    // The whole envelope must survive `JSON.stringify` unchanged -- a `Decimal` would not.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("AI2 - buckets by UTC day and derives bucketEnd as bucketStart plus one day", async () => {
    const tenantId = await seedTenant("ai2", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1 },
      { metricKey: METRIC_KEY.SECONDARY, instant: INSTANT.DAY_1_LATER, quantity: QUANTITY.SECONDARY_DAY_1 },
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_3_NOON, quantity: QUANTITY.PRIMARY_DAY_3 }
    ]);

    const result = await service().getMetricsRollup(tenantId, query(RANGE.THREE_DAYS));

    // Ordered `bucketStart ASC, metricKey ASC`, and `2026-03-02` produces no row because it
    // holds no usage -- which is also why this range's cache can never validate (the gap filed
    // as S-61).
    expect(result.items).toEqual([
      {
        metricKey: METRIC_KEY.PRIMARY,
        bucketStart: BUCKET.DAY_1,
        bucketEnd: BUCKET.DAY_2,
        totalQuantity: QUANTITY.PRIMARY_DAY_1_RENDERED
      },
      {
        metricKey: METRIC_KEY.SECONDARY,
        bucketStart: BUCKET.DAY_1,
        bucketEnd: BUCKET.DAY_2,
        totalQuantity: QUANTITY.SECONDARY_DAY_1_RENDERED
      },
      {
        metricKey: METRIC_KEY.PRIMARY,
        bucketStart: BUCKET.DAY_3,
        bucketEnd: BUCKET.DAY_4,
        totalQuantity: QUANTITY.PRIMARY_DAY_3_RENDERED
      }
    ]);
  });

  it("AI3 - buckets by UTC hour and by ISO week, each with its own derived bucketEnd", async () => {
    const tenantId = await seedTenant("ai3", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1 },
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_AFTER_SIX, quantity: QUANTITY.PRIMARY_DAY_1_EXTRA }
    ]);

    const hourly = await service().getMetricsRollup(
      tenantId,
      query({ ...RANGE.ONE_DAY, granularity: ANALYTICS_GRANULARITY.HOUR })
    );
    expect(hourly.items[0]).toEqual({
      metricKey: METRIC_KEY.PRIMARY,
      bucketStart: BUCKET.HOUR_1_START,
      bucketEnd: BUCKET.HOUR_1_END,
      totalQuantity: QUANTITY.PRIMARY_DAY_1_RENDERED
    });
    expect(hourly.total).toBe(2);

    const weekly = await service().getMetricsRollup(
      tenantId,
      query({ ...RANGE.ONE_WEEK, granularity: ANALYTICS_GRANULARITY.WEEK })
    );
    // `2026-03-01` is a Sunday, so PostgreSQL's ISO week starts Monday `2026-02-23`. Both rows
    // collapse into that one bucket.
    expect(weekly.items).toEqual([
      {
        metricKey: METRIC_KEY.PRIMARY,
        bucketStart: BUCKET.WEEK_START,
        bucketEnd: BUCKET.WEEK_END,
        totalQuantity: QUANTITY.WEEK_TOTAL_PRIMARY_RENDERED
      }
    ]);
  });

  it("AI4 - filters by metricKey", async () => {
    const tenantId = await seedTenant("ai4", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1 },
      { metricKey: METRIC_KEY.SECONDARY, instant: INSTANT.DAY_1_LATER, quantity: QUANTITY.SECONDARY_DAY_1 }
    ]);

    const filtered = await service().getMetricsRollup(
      tenantId,
      query({ ...RANGE.ONE_DAY, metricKey: METRIC_KEY.SECONDARY })
    );

    expect(filtered.total).toBe(1);
    expect(filtered.items.map((item) => item.metricKey)).toEqual([METRIC_KEY.SECONDARY]);
  });

  it("AI4b - reports unbilled usage, because the epic's `AND billed = true` was dropped (D1)", async () => {
    // Plan decision D1, ruled by the user at Gate 2. `billed` is written `false` at ingestion
    // and flipped by the nightly invoice job, so filtering on it would make yesterday's usage
    // invisible for up to ~26 hours and would guarantee every cached bucket goes stale exactly
    // once. Measured at Gate 1: with the filter, a seeded `5.250000` unbilled row vanishes from
    // the result while sitting in the database.
    //
    // This case is the guard. Reintroducing the predicate drops the unbilled row and the
    // expectation below fails on both the item count and the total.
    const tenantId = await seedTenant("ai4b", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1, billed: true },
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_3_NOON, quantity: QUANTITY.PRIMARY_DAY_3, billed: false }
    ]);

    const result = await service().getMetricsRollup(tenantId, query(RANGE.THREE_DAYS));

    expect(result.items.map((item) => item.bucketStart)).toEqual([BUCKET.DAY_1, BUCKET.DAY_3]);
    expect(result.items[1]?.totalQuantity).toBe(QUANTITY.PRIMARY_DAY_3_RENDERED);
  });

  it("AI5 - pages the grouped rows, and reports total as the grouped-row count", async () => {
    const tenantId = await seedTenant("ai5", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1 },
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_LATER, quantity: QUANTITY.PRIMARY_DAY_1_EXTRA },
      { metricKey: METRIC_KEY.SECONDARY, instant: INSTANT.DAY_1_LATER, quantity: QUANTITY.SECONDARY_DAY_1 },
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_3_NOON, quantity: QUANTITY.PRIMARY_DAY_3 }
    ]);

    const firstPage = await service().getMetricsRollup(
      tenantId,
      query({ ...RANGE.THREE_DAYS, page: 1, pageSize: 2 })
    );
    const secondPage = await service().getMetricsRollup(
      tenantId,
      query({ ...RANGE.THREE_DAYS, page: 2, pageSize: 2 })
    );

    // AC5: four usage lines collapse into three grouped rows, and `total` reports the grouped
    // count on **both** pages -- not the number of usage lines, and not the page length.
    expect(firstPage.total).toBe(3);
    expect(secondPage.total).toBe(3);
    expect(firstPage.items).toHaveLength(2);
    expect(secondPage.items).toHaveLength(1);

    const walked = [...firstPage.items, ...secondPage.items];
    expect(walked.map((item) => `${item.bucketStart}|${item.metricKey}`)).toEqual([
      `${BUCKET.DAY_1}|${METRIC_KEY.PRIMARY}`,
      `${BUCKET.DAY_1}|${METRIC_KEY.SECONDARY}`,
      `${BUCKET.DAY_3}|${METRIC_KEY.PRIMARY}`
    ]);
  });

  it("AI10 - upserts the whole range into MetricRollup after an unfiltered fallback", async () => {
    const tenantId = await seedTenant("ai10", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1 },
      { metricKey: METRIC_KEY.SECONDARY, instant: INSTANT.DAY_1_LATER, quantity: QUANTITY.SECONDARY_DAY_1 }
    ]);

    expect(await cachedRowsFor(tenantId)).toHaveLength(0);

    await service().getMetricsRollup(tenantId, query(RANGE.ONE_DAY));

    const cached = await cachedRowsFor(tenantId);
    expect(cached).toHaveLength(2);
    expect(cached.map((entry) => entry.metricKey)).toEqual([
      METRIC_KEY.PRIMARY,
      METRIC_KEY.SECONDARY
    ]);
    expect(cached.every((entry) => entry.granularity === "DAY")).toBe(true);
    expect(cached[0]?.bucketStart.toISOString()).toBe(BUCKET.DAY_1);
    expect(String(cached[0]?.value)).toBe(QUANTITY.PRIMARY_DAY_1_RENDERED);

    // AC8's second half: a re-run upserts rather than duplicating, which the natural key
    // `@@unique([tenantId, metricKey, granularity, bucketStart])` is there to guarantee.
    await service().getMetricsRollup(tenantId, query(RANGE.ONE_DAY));
    expect(await cachedRowsFor(tenantId)).toHaveLength(2);
  });

  it("AI9 - serves a complete cache without reading UsageLine at all", async () => {
    // Non-vacuous in both directions. The cached values are overwritten with a sentinel no
    // aggregation could produce, *and* the underlying usage lines are deleted. So the case can
    // only pass if the answer genuinely came out of `MetricRollup`: a silent fall back to
    // `UsageLine` returns an empty page, and a cache branch that re-derived the numbers returns
    // the real ones rather than the sentinel.
    const tenantId = await seedTenant("ai9", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1 }
    ]);

    await service().getMetricsRollup(tenantId, query(RANGE.ONE_DAY));
    expect(await cachedRowsFor(tenantId)).toHaveLength(1);

    await admin.metricRollup.updateMany({
      where: { tenantId },
      data: { value: CACHE_SENTINEL.VALUE }
    });
    await admin.usageLine.deleteMany({ where: { tenantId } });

    const result = await service().getMetricsRollup(tenantId, query(RANGE.ONE_DAY));

    expect(result.total).toBe(1);
    expect(result.items).toEqual([
      {
        metricKey: METRIC_KEY.PRIMARY,
        bucketStart: BUCKET.DAY_1,
        bucketEnd: BUCKET.DAY_2,
        totalQuantity: CACHE_SENTINEL.RENDERED
      }
    ]);
  });

  it("AI6 - discards the whole cache when one bucket is absent (D0-A)", async () => {
    // **The red-before-green obligation for slice 3.** Both cached buckets are overwritten with
    // the sentinel first, then one row is deleted. A completeness check that accepted a partial
    // cache -- `cachedBuckets > 0`, say -- serves the surviving sentinel; the correct behaviour
    // discards it and re-derives both buckets from `UsageLine`, so no sentinel appears anywhere
    // in the answer.
    const tenantId = await seedTenant("ai6", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1 },
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_2_NOON, quantity: QUANTITY.PRIMARY_DAY_2 }
    ]);

    await service().getMetricsRollup(tenantId, query(RANGE.TWO_DAYS));
    expect(await cachedRowsFor(tenantId)).toHaveLength(2);

    await admin.metricRollup.updateMany({
      where: { tenantId },
      data: { value: CACHE_SENTINEL.VALUE }
    });
    await admin.metricRollup.deleteMany({ where: { tenantId, bucketStart: new Date(BUCKET.DAY_2) } });
    expect(await cachedRowsFor(tenantId)).toHaveLength(1);

    const result = await service().getMetricsRollup(tenantId, query(RANGE.TWO_DAYS));

    expect(result.items.map((item) => item.totalQuantity)).toEqual([
      QUANTITY.PRIMARY_DAY_1_RENDERED,
      QUANTITY.PRIMARY_DAY_2_RENDERED
    ]);
    expect(result.items.map((item) => item.totalQuantity)).not.toContain(CACHE_SENTINEL.RENDERED);
  });

  it("AI12 - a metricKey-filtered request never writes the cache, so a later unfiltered range cannot under-report (D3)", async () => {
    // **The soundness case the whole two-tier design turns on**, with its attribution stated at
    // the strength it was measured (corrected at Gate 4, MEDIUM-3).
    //
    // `COUNT(DISTINCT "bucketStart")` is blind to the metric dimension, so a cache written by a
    // `metricKey`-filtered request could make a later *unfiltered* range look complete while
    // omitting another metric. **Two layers prevent that**, and it takes removing *both* to
    // produce the under-report: the `metricKey === undefined` condition in
    // `AnalyticsService.cacheIfSound`, **and** `cacheRange`'s field-by-field rebuild of its
    // filter input. Removing the service condition alone does **not** under-report, because
    // `cacheIfSound` calls `cacheRange(range)` and `range` is `{ from, to, granularity }` with
    // no `metricKey` -- so the filtered request writes the *whole* range and the next unfiltered
    // request is served correctly.
    //
    // Measured, three mutations, each reverted:
    //
    //   service condition only    -> fails at the toHaveLength(0) assertion below, 2 cached rows
    //   both layers               -> fails at the same assertion, 1 cached row
    //   both layers, that
    //     assertion pinned        -> reaches the assertions after it and gives
    //                                ['api.request'] against ['api.request','storage.write']
    //
    // **So the two assertions after the cache-count check never execute under either mutation.**
    // They pin the correct answer on the green path; they do not observe the under-report. What
    // this case actually guards is the real and sufficient property "a filtered request wrote
    // the cache", which is red under both mutations. The measured under-report itself is
    // recorded in `docs/epics/README.md` § *Q3a*. To make a case that observes it, assert the
    // unfiltered result **before** asserting the cache is empty.
    const tenantId = await seedTenant("ai12", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1 },
      { metricKey: METRIC_KEY.SECONDARY, instant: INSTANT.DAY_1_LATER, quantity: QUANTITY.SECONDARY_DAY_1 }
    ]);

    const filtered = await service().getMetricsRollup(
      tenantId,
      query({ ...RANGE.ONE_DAY, metricKey: METRIC_KEY.PRIMARY })
    );
    expect(filtered.items.map((item) => item.metricKey)).toEqual([METRIC_KEY.PRIMARY]);
    // D3, read directly off the table through the admin connection.
    expect(await cachedRowsFor(tenantId)).toHaveLength(0);

    const unfiltered = await service().getMetricsRollup(tenantId, query(RANGE.ONE_DAY));

    // The consequence D3 exists to prevent: both metrics are present and neither total moved.
    expect(unfiltered.items.map((item) => item.metricKey)).toEqual([
      METRIC_KEY.PRIMARY,
      METRIC_KEY.SECONDARY
    ]);
    expect(unfiltered.items.map((item) => item.totalQuantity)).toEqual([
      QUANTITY.PRIMARY_DAY_1_RENDERED,
      QUANTITY.SECONDARY_DAY_1_RENDERED
    ]);
  });

  it("AI13 - never serves or writes the cache for a range whose bounds are not bucket-aligned (D10)", async () => {
    // Plan addition D10, from a Gate-3 measurement. The `2026-03-01` `api.request` bucket's
    // true total here is `12.500000`; an unaligned request starting at `06:00` sees only
    // `2.000000` of it. Two failures follow if the cache participated: caching that request
    // would write `2.000000` as the bucket's total (poisoning it for every later aligned
    // reader), and reading the cache for it would report the whole `12.500000` the caller
    // excluded.
    const tenantId = await seedTenant("ai13", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1 },
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_AFTER_SIX, quantity: QUANTITY.PRIMARY_DAY_1_EXTRA },
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_3_NOON, quantity: QUANTITY.PRIMARY_DAY_3 }
    ]);

    const unaligned = await service().getMetricsRollup(tenantId, query(RANGE.UNALIGNED));

    // Only the part of the `03-01` bucket at or after `06:00`, plus the `03-03` row.
    expect(unaligned.items).toEqual([
      {
        metricKey: METRIC_KEY.PRIMARY,
        bucketStart: BUCKET.DAY_1,
        bucketEnd: BUCKET.DAY_2,
        totalQuantity: QUANTITY.PRIMARY_DAY_1_EXTRA_RENDERED
      },
      {
        metricKey: METRIC_KEY.PRIMARY,
        bucketStart: BUCKET.DAY_3,
        bucketEnd: BUCKET.DAY_4,
        totalQuantity: QUANTITY.PRIMARY_DAY_3_RENDERED
      }
    ]);
    // Nothing was written, so no later aligned request can read a partial bucket total.
    expect(await cachedRowsFor(tenantId)).toHaveLength(0);
  });

  it("AI14 - the cache tier and the UsageLine tier return byte-identical answers", async () => {
    // D4's real requirement. `bucketEnd` is derived in both tiers from the same frozen
    // granularity map, and `totalQuantity` crosses `Decimal(18,6)` twice on the cache path
    // (aggregate -> column -> read) against once on the fallback path. This is the case that
    // would notice either drifting.
    const tenantId = await seedTenant("ai14", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRECISION_PART_A },
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_LATER, quantity: QUANTITY.PRECISION_PART_B },
      { metricKey: METRIC_KEY.SECONDARY, instant: INSTANT.DAY_1_LATER, quantity: QUANTITY.SECONDARY_DAY_1 }
    ]);

    const fromUsage = await service().getMetricsRollup(tenantId, query(RANGE.ONE_DAY));
    expect(await cachedRowsFor(tenantId)).toHaveLength(2);

    const fromCache = await service().getMetricsRollup(tenantId, query(RANGE.ONE_DAY));

    expect(fromCache).toEqual(fromUsage);
    expect(fromCache.items[0]?.totalQuantity).toBe(QUANTITY.PRECISION_RENDERED);
  });

  it("AI11 - returns no other tenant's rows, from either tier", async () => {
    // **S-46: this case pins the OUTCOME and cannot pin the application-layer predicate.**
    // `"UsageLine"` and `"MetricRollup"` both have RLS enabled with a
    // `current_setting('app.tenant_id')` policy, so the policy returns the identical rows
    // whether or not the repository also writes `WHERE "tenantId" = $1`. S-46 measured exactly
    // that on billing's `absorbLateUsage`: four mutations, the two-tenant integration case
    // green under all four. Deleting the predicate ships green *through this case*. `AM16` in
    // `rollup.repository.unit.test.ts` is the shape assertion that goes red, and it is the
    // only one that does.
    const tenantId = await seedTenant("ai11-self", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1 }
    ]);
    const otherTenantId = await seedTenant("ai11-other", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.OTHER_TENANT }
    ]);

    // Both tenants hold a row in the same bucket for the same metric, so a leak would be
    // visible as a wrong total rather than only as an extra row.
    const fromUsage = await service().getMetricsRollup(tenantId, query(RANGE.ONE_DAY));
    expect(fromUsage.items).toHaveLength(1);
    expect(fromUsage.items[0]?.totalQuantity).toBe(QUANTITY.PRIMARY_DAY_1_RENDERED);
    expect(fromUsage.items[0]?.totalQuantity).not.toBe(QUANTITY.OTHER_TENANT_RENDERED);

    // The cache tier as well: each tenant's fallback wrote its own rows, and neither reads the
    // other's.
    await service().getMetricsRollup(otherTenantId, query(RANGE.ONE_DAY));
    const fromCache = await service().getMetricsRollup(tenantId, query(RANGE.ONE_DAY));
    expect(fromCache.items).toHaveLength(1);
    expect(fromCache.items[0]?.totalQuantity).toBe(QUANTITY.PRIMARY_DAY_1_RENDERED);

    // And the rows really were written under two different tenants, so the case is not passing
    // because the second tenant simply has nothing.
    expect(await cachedRowsFor(otherTenantId)).toHaveLength(1);
    expect(String((await cachedRowsFor(otherTenantId))[0]?.value)).toBe(
      QUANTITY.OTHER_TENANT_RENDERED
    );
  });

  it("AI15 - a cache write for another tenant is refused by RLS", async () => {
    // P5 at Gate 1 measured this directly in `psql`; this is the standing version. The policy
    // on `"MetricRollup"` carries a `WITH CHECK`, so a write naming another tenant raises
    // rather than silently succeeding -- which is the property that makes the cache write safe
    // to issue with the tenant bound from `this.where({})` rather than validated separately.
    const tenantId = await seedTenant("ai15", [
      { metricKey: METRIC_KEY.PRIMARY, instant: INSTANT.DAY_1_EARLY, quantity: QUANTITY.PRIMARY_DAY_1 }
    ]);
    const foreignTenantId = tenantIdFor("ai15-foreign");
    await admin.tenant.create({ data: { id: foreignTenantId, name: `T-051 foreign ${suiteId}` } });

    await expect(
      appClient.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`
          INSERT INTO "MetricRollup" ("id","tenantId","metricKey","granularity","bucketStart","value","computedAt")
          VALUES (gen_random_uuid()::text, ${foreignTenantId}, ${METRIC_KEY.PRIMARY},
                  'DAY'::"Granularity", ${BUCKET.DAY_1}::timestamp(3), 1, NOW())
        `;
      })
    ).rejects.toThrow(/row-level security/i);

    expect(await cachedRowsFor(foreignTenantId)).toHaveLength(0);
  });
});
