import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { RollupRepository } from "../src/repositories/rollup.repository";
import type { MetricsPage } from "../src/repositories/rollup.repository";
import { ANALYTICS_GRANULARITY, ANALYTICS_METRICS } from "../src/constants";

/**
 * Both halves of the UTC contract for `GET /v1/analytics/metrics`, on a live database.
 *
 * `AI7` is the **projection** side: a bucket boundary must be the same instant on any server.
 * `AI8` is the **predicate** side: the `[from, to)` window must select the same rows on any
 * server. They are different defects with different fixes and the file pins them separately,
 * because conflating them is how the output side gets "fixed" by moving `AT TIME ZONE` onto the
 * column -- which is the epic's own snippet and is exactly backwards.
 *
 * ## Why these cases are worth more here than the equivalents in usage-service
 *
 * **S-21** records that usage-service's S-18 regression suite does not isolate the fix it was
 * written for: that service ships *two* independent guards -- the bound normalization-and-cast
 * **and** a `set_config('TimeZone','UTC',true)` pinned inside its own `withTenant` -- and either
 * alone is sufficient, so reverting the bound leaves that suite 17/17 green.
 *
 * analytics has **one** guard. Plan decision D7 deliberately leaves
 * `src/repositories/base.repository.ts` byte-identical to worker-service's, with no session pin
 * (S-19's whole subject is that those five copies drift, and adding a fifth variant from inside
 * a feature task is what that entry asks not to be done). So the bound cast is the only thing
 * standing between this endpoint and S-18, and `AI8` is a case that must go red when it alone
 * is reverted. That is the property S-21 asks for and could not get from usage-service.
 *
 * ## Why every case pins its own session zone
 *
 * CI's `postgres:16-alpine` defaults `TimeZone` to `UTC`, which is precisely the value at which
 * the correct and the defective forms agree -- measured at Gate 1 across four zones, where only
 * `America/New_York` separated them. A case that used the ambient session would therefore
 * assert nothing in CI. The `options=-c timezone=...` spelling is load-bearing: a bare
 * `?timezone=...` query parameter is accepted by the driver and silently ignored, so `AI7a`
 * reads the pin back before anything depends on it.
 *
 * Requires a live Postgres:
 *   DATABASE_URL        -> telemetry_app (NOSUPERUSER / NOBYPASSRLS) -- asserts through this
 *   DIRECT_DATABASE_URL -> admin/owner -- seeds fixtures RLS would otherwise block
 */

const ADMIN_URL_FALLBACK = "postgresql://postgres:postgres@localhost:5432/telemetry";

/** UTC control, plus one offset in each direction and one that is not a whole hour. */
const SESSION_TIME_ZONE = {
  UTC: "UTC",
  AHEAD_OF_UTC: "Asia/Kolkata",
  BEHIND_UTC: "America/New_York",
  FRACTIONAL_OFFSET: "Asia/Kathmandu"
} as const;

const CONNECTION_OPTIONS_PARAM = "options";
const TIME_ZONE_OPTION_PREFIX = "-c timezone=";

const METRIC_KEY = {
  /** Sits at 03:00 UTC on 1 March: inside `America/New_York`'s previous calendar day. */
  EARLY_MORNING: "t051.tz.early-morning",
  /** Sits at 20:00 UTC on 2 March: inside `Asia/Kolkata`'s next calendar day. */
  LATE_EVENING: "t051.tz.late-evening",
  /** Range boundary probes. */
  MS_BEFORE_FROM: "t051.tz.ms-before-from",
  AT_FROM: "t051.tz.at-from",
  MS_BEFORE_TO: "t051.tz.ms-before-to",
  AT_TO: "t051.tz.at-to"
} as const;

const RANGE = {
  FROM: "2026-03-01T00:00:00.000Z",
  TO: "2026-03-04T00:00:00.000Z"
} as const;

/** The same two instants written with `+05:30` rather than `Z`; `iso8601Schema` admits both. */
const RANGE_WITH_OFFSET = {
  FROM: "2026-03-01T05:30:00.000+05:30",
  TO: "2026-03-04T05:30:00.000+05:30"
} as const;

const INSTANT = {
  EARLY_MORNING: "2026-03-01T03:00:00.000Z",
  LATE_EVENING: "2026-03-02T20:00:00.000Z"
} as const;

/**
 * The UTC day buckets those two instants belong to.
 *
 * Under the epic's `DATE_TRUNC('day', "periodStart" AT TIME ZONE 'UTC')` the first becomes
 * `2026-02-28` on an `America/New_York` server -- measured at Gate 1 on the real `"UsageLine"`
 * table across four session zones.
 */
const EXPECTED_BUCKET = {
  EARLY_MORNING: "2026-03-01T00:00:00.000Z",
  LATE_EVENING: "2026-03-02T00:00:00.000Z"
} as const;

/** `timestamp(3)` resolves milliseconds, so 1 ms is the smallest representable step. */
const BOUNDARY_STEP_MILLIS = 1;

const QUANTITY = "1.000000";
const QUANTITY_RENDERED = "1";
const EVENT_UNIT = "request";

const shiftIso = (instant: string, millis: number): string =>
  new Date(new Date(instant).getTime() + millis).toISOString();

interface FixtureRow {
  readonly metricKey: string;
  readonly instant: string;
}

const BUCKET_ROWS: readonly FixtureRow[] = [
  { metricKey: METRIC_KEY.EARLY_MORNING, instant: INSTANT.EARLY_MORNING },
  { metricKey: METRIC_KEY.LATE_EVENING, instant: INSTANT.LATE_EVENING }
];

const BOUNDARY_ROWS: readonly FixtureRow[] = [
  { metricKey: METRIC_KEY.MS_BEFORE_FROM, instant: shiftIso(RANGE.FROM, -BOUNDARY_STEP_MILLIS) },
  { metricKey: METRIC_KEY.AT_FROM, instant: RANGE.FROM },
  { metricKey: METRIC_KEY.MS_BEFORE_TO, instant: shiftIso(RANGE.TO, -BOUNDARY_STEP_MILLIS) },
  { metricKey: METRIC_KEY.AT_TO, instant: RANGE.TO }
];

const FIXTURE_ROWS: readonly FixtureRow[] = [...BUCKET_ROWS, ...BOUNDARY_ROWS];

/** `from` inclusive, `to` exclusive, so exactly these four metric keys qualify. */
const METRIC_KEYS_IN_RANGE = [
  METRIC_KEY.EARLY_MORNING,
  METRIC_KEY.LATE_EVENING,
  METRIC_KEY.AT_FROM,
  METRIC_KEY.MS_BEFORE_TO
].sort();

const METRIC_KEYS_OUT_OF_RANGE = [METRIC_KEY.MS_BEFORE_FROM, METRIC_KEY.AT_TO];

const NO_OP_LOGGER = {
  error: () => undefined,
  debug: () => undefined
};

interface RoleAttributes {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
}

const requireEnv = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`${name} must be set for the analytics timezone integration test`);
  }
  return value;
};

const withSessionTimeZone = (url: string, timeZone: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set(CONNECTION_OPTIONS_PARAM, `${TIME_ZONE_OPTION_PREFIX}${timeZone}`);
  return parsed.toString();
};

describe("Analytics metric buckets and range are resolved in UTC (integration)", () => {
  const suiteId = randomUUID();
  const tenantId = `t051-tz-${suiteId}` as TenantId;

  let admin: PrismaClient;
  let appRole: RoleAttributes | undefined;
  const clientsByTimeZone = new Map<string, PrismaClient>();

  const eventId = (row: FixtureRow): string => `${tenantId}-ev-${row.metricKey}`;

  const clientFor = (timeZone: string): PrismaClient => {
    const existing = clientsByTimeZone.get(timeZone);
    if (existing) {
      return existing;
    }
    const client = new PrismaClient({
      datasourceUrl: withSessionTimeZone(requireEnv("DATABASE_URL"), timeZone)
    });
    clientsByTimeZone.set(timeZone, client);
    return client;
  };

  const readSessionTimeZone = async (timeZone: string): Promise<string> => {
    const rows = await clientFor(timeZone).$queryRaw<{ timeZone: string }[]>`
      SELECT current_setting('TimeZone') AS "timeZone"
    `;
    const observed = rows[0]?.timeZone;
    if (!observed) {
      throw new Error(`Could not read the session time zone for ${timeZone}`);
    }
    return observed;
  };

  /**
   * Reads straight through the repository rather than the service, so the cache tier is never
   * involved: this file is about the `UsageLine` aggregation's SQL, and a cached answer would
   * make a later case pass on a value the first case computed.
   */
  const aggregateFor = async (
    timeZone: string,
    range: { readonly FROM: string; readonly TO: string }
  ): Promise<MetricsPage> => {
    const repository = new RollupRepository(clientFor(timeZone), tenantId, NO_OP_LOGGER);
    return repository.aggregateFromUsage({
      from: range.FROM,
      to: range.TO,
      granularity: ANALYTICS_GRANULARITY.DAY,
      page: ANALYTICS_METRICS.DEFAULT_PAGE,
      pageSize: ANALYTICS_METRICS.DEFAULT_PAGE_SIZE
    });
  };

  const metricKeysFor = async (
    timeZone: string,
    range: { readonly FROM: string; readonly TO: string }
  ): Promise<string[]> => (await aggregateFor(timeZone, range)).rows.map((row) => row.metricKey).sort();

  const bucketFor = async (timeZone: string, metricKey: string): Promise<string> => {
    const page = await aggregateFor(timeZone, RANGE);
    const match = page.rows.find((row) => row.metricKey === metricKey);
    if (!match) {
      throw new Error(`No row for ${metricKey} under session time zone ${timeZone}`);
    }
    return match.bucketStart;
  };

  beforeAll(async () => {
    admin = new PrismaClient({
      datasourceUrl: requireEnv("DIRECT_DATABASE_URL", ADMIN_URL_FALLBACK)
    });

    const roles = await clientFor(SESSION_TIME_ZONE.UTC).$queryRaw<RoleAttributes[]>`
      SELECT r.rolname, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user
    `;
    appRole = roles[0];

    await admin.tenant.create({ data: { id: tenantId, name: `T-051 timezone probe ${suiteId}` } });
    await admin.event.createMany({
      data: FIXTURE_ROWS.map((row) => ({
        id: eventId(row),
        tenantId,
        idempotencyKey: eventId(row),
        eventType: row.metricKey,
        quantity: QUANTITY,
        unit: EVENT_UNIT,
        occurredAt: new Date(row.instant)
      }))
    });
    await admin.usageLine.createMany({
      data: FIXTURE_ROWS.map((row) => ({
        id: `${tenantId}-ul-${row.metricKey}`,
        tenantId,
        eventId: eventId(row),
        metricKey: row.metricKey,
        quantity: QUANTITY,
        periodStart: new Date(row.instant),
        periodEnd: new Date(row.instant)
      }))
    });
  });

  afterAll(async () => {
    if (admin) {
      await admin.metricRollup.deleteMany({ where: { tenantId } });
      await admin.usageLine.deleteMany({ where: { tenantId } });
      await admin.event.deleteMany({ where: { tenantId } });
      await admin.tenant.deleteMany({ where: { id: tenantId } });
      await admin.$disconnect();
    }
    for (const client of clientsByTimeZone.values()) {
      await client.$disconnect();
    }
  });

  it("AI7z - asserts through a NOSUPERUSER, NOBYPASSRLS role", () => {
    expect(appRole, "DATABASE_URL did not resolve to a known role").toBeDefined();
    expect(appRole?.rolsuper, `role ${appRole?.rolname} is a superuser`).toBe(false);
    expect(appRole?.rolbypassrls, `role ${appRole?.rolname} holds BYPASSRLS`).toBe(false);
  });

  it.each(Object.values(SESSION_TIME_ZONE))(
    "AI7a - pins the connection session time zone to %s, so the cases below are not vacuous",
    async (timeZone) => {
      expect(await readSessionTimeZone(timeZone)).toBe(timeZone);
    }
  );

  it("AI7b - seeded every fixture instant verbatim through the admin role", async () => {
    // The stored instants are exactly what was written, so a bucketing or range failure below
    // cannot be blamed on the fixture.
    const rows = await admin.usageLine.findMany({
      where: { tenantId },
      select: { metricKey: true, periodStart: true }
    });

    expect(rows).toHaveLength(FIXTURE_ROWS.length);
    expect(rows.map((row) => row.periodStart.toISOString()).sort()).toEqual(
      FIXTURE_ROWS.map((row) => row.instant).sort()
    );
  });

  it.each(Object.values(SESSION_TIME_ZONE))(
    "AI7 - buckets a 03:00 UTC row to its own UTC day under session time zone %s",
    async (timeZone) => {
      // **The projection guard (S-53 / Q3).** `2026-03-01T03:00Z` is `2026-02-28 22:00` in
      // `America/New_York`, so the epic's `AT TIME ZONE 'UTC'` on the column reports it as the
      // 28th there -- reproduced at Gate 1 on the real table. The bare `DATE_TRUNC` this
      // repository emits must give `2026-03-01` in every zone.
      expect(await bucketFor(timeZone, METRIC_KEY.EARLY_MORNING)).toBe(
        EXPECTED_BUCKET.EARLY_MORNING
      );
      // The mirror case, so the guard covers a shift in the other direction too: a 20:00 UTC
      // row is already the next calendar day in `Asia/Kolkata` and `Asia/Kathmandu`.
      expect(await bucketFor(timeZone, METRIC_KEY.LATE_EVENING)).toBe(EXPECTED_BUCKET.LATE_EVENING);
    }
  );

  it("AI7c - derives bucketEnd from bucketStart identically in every zone", async () => {
    const perZone = await Promise.all(
      Object.values(SESSION_TIME_ZONE).map(async (timeZone) => ({
        timeZone,
        rows: (await aggregateFor(timeZone, RANGE)).rows
      }))
    );

    const reference = perZone[0]?.rows;
    expect(reference).toBeDefined();
    for (const observed of perZone) {
      expect(observed.rows, `session time zone ${observed.timeZone}`).toEqual(reference);
    }
    // Non-vacuous: the reference itself is the right answer, not merely a consistent one.
    expect(reference?.map((row) => row.metricKey).sort()).toEqual(METRIC_KEYS_IN_RANGE);
    expect(reference?.every((row) => row.totalQuantity === QUANTITY_RENDERED)).toBe(true);
  });

  it.each(Object.values(SESSION_TIME_ZONE))(
    "AI8 - selects exactly the rows in [from, to) under session time zone %s",
    async (timeZone) => {
      // **The predicate guard (S-18), and the case that must go red when `utcTimestampBound`
      // alone is reverted to a bound JS `Date`.** analytics has no
      // `set_config('TimeZone','UTC',true)` in its `withTenant` (plan decision D7), so unlike
      // usage-service there is no second guard to mask the defect -- which is the isolation
      // S-21 records as missing there.
      expect(await metricKeysFor(timeZone, RANGE)).toEqual(METRIC_KEYS_IN_RANGE);
    }
  );

  it.each(Object.values(SESSION_TIME_ZONE))(
    "AI8b - includes the row exactly at from and excludes the row exactly at to under %s",
    async (timeZone) => {
      const metricKeys = await metricKeysFor(timeZone, RANGE);

      expect(metricKeys).toContain(METRIC_KEY.AT_FROM);
      expect(metricKeys).toContain(METRIC_KEY.MS_BEFORE_TO);
      for (const excluded of METRIC_KEYS_OUT_OF_RANGE) {
        expect(metricKeys).not.toContain(excluded);
      }
    }
  );

  it.each(Object.values(SESSION_TIME_ZONE))(
    "AI8c - returns the identical window for offset-bearing bounds under %s",
    async (timeZone) => {
      // The half a `Z`-only fixture cannot catch. PostgreSQL's text -> timestamp cast DISCARDS
      // an offset rather than converting it, so casting the raw request string would trade a
      // session-dependent bug for an offset-dependent one. `utcTimestampBound` resolves the
      // instant in JavaScript first, which is why these two ranges are the same window.
      const zulu = await metricKeysFor(timeZone, RANGE);
      const offset = await metricKeysFor(timeZone, RANGE_WITH_OFFSET);

      expect(offset).toEqual(zulu);
      expect(offset).toEqual(METRIC_KEYS_IN_RANGE);
    }
  );
});
