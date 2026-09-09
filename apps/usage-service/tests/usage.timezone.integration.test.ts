import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { UsageRepository } from "../src/repositories/usage.repository";
import type { UsageSummaryAggregate } from "../src/repositories/usage.repository";
import { TenantScopedRepository } from "../src/repositories/base.repository";
import {
  DATABASE_SESSION_SETTINGS,
  USAGE_SUMMARY_CONSTANTS,
  USAGE_SUMMARY_GRANULARITY
} from "../src/constants";

/**
 * Proves that `GET /v1/usage/summary`'s range predicate means `[from, to)` in **UTC** on
 * any server — the acceptance criterion for S-18.
 *
 * ## Why every case pins its own session time zone
 *
 * `"UsageLine"."periodStart"` is `timestamp(3) without time zone`. Prisma binds a JS `Date`
 * in `$queryRaw` as `timestamptz` (measured: `SELECT pg_typeof(${new Date(...)})` →
 * `timestamp with time zone`), and comparing those two resolves through the database
 * SESSION zone. Measured on this host with the six-row probe in
 * `docs/plans/s-018-usage-summary-range-timezone.md` §3.2: the same window returned
 * `{r2,r3,r4,r5}` under `UTC`, `{r4,r5,r6}` under `Asia/Kolkata` and `{r1,r2,r3,r4}` under
 * `America/New_York`.
 *
 * CI's PostgreSQL (`postgres:16-alpine`, `.github/workflows/ci.yml`) defaults `TimeZone` to
 * `UTC`, where the broken and the correct predicate are indistinguishable. A behavioural
 * test that used the ambient session would therefore assert nothing in CI. Each case below
 * pins its own zone on its own connection via `options=-c timezone=…`, so it fails on the
 * unfixed code on **any** server.
 *
 * Note the negative control recorded in the plan (§3.7): a bare `?timezone=UTC` query
 * parameter is silently ignored by the driver. The `options=-c` spelling is load-bearing;
 * `readSessionTimeZone` asserts the pin actually took, so a spelling regression fails loudly
 * instead of making every case vacuous.
 *
 * Requires a live Postgres with migrations applied:
 *   DATABASE_URL        -> telemetry_app (NOSUPERUSER/NOBYPASSRLS) — asserts through this
 *   DIRECT_DATABASE_URL -> admin/owner — seeds the fixtures, which RLS would otherwise block
 *
 * The role claim above is asserted, not assumed — see the `current_user` case below, which
 * mirrors `rls.enforcement.integration.test.ts`. A docstring is not a check. The zone
 * conclusions here would in fact hold as any role, but the file states the role as a property
 * of itself, so it has to prove it.
 *
 * Deliberately does NOT skip when the environment is wrong: a guard that fires exactly when
 * the bug is present is the S-3 anti-pattern.
 */

const ADMIN_URL_FALLBACK = "postgresql://postgres:postgres@localhost:5432/telemetry";

/** Session zones under test: UTC control plus one offset in each direction. */
const SESSION_TIME_ZONE = {
  UTC: DATABASE_SESSION_SETTINGS.TIME_ZONE_UTC,
  AHEAD_OF_UTC: "Asia/Kolkata",
  BEHIND_UTC: "America/New_York"
} as const;

/** The requested window. Half-open: `from` inclusive, `to` exclusive. */
const RANGE = {
  FROM: "2026-01-01T00:00:00.000Z",
  TO: "2026-02-01T00:00:00.000Z"
} as const;

/**
 * The same two instants written with a `+05:30` offset rather than `Z`. `iso8601Schema` is
 * `z.string().datetime({ offset: true })`, so these are legal request values, and
 * PostgreSQL's text -> timestamp cast DISCARDS an offset instead of converting it
 * (measured: `'2026-01-01T00:00:00.000+05:30'::timestamp(3)` -> `2026-01-01 00:00:00`).
 */
const RANGE_WITH_OFFSET = {
  FROM: "2026-01-01T05:30:00.000+05:30",
  TO: "2026-02-01T05:30:00.000+05:30"
} as const;

/**
 * A window with more than a day of margin on both sides, so every fixture row is inside it
 * under every session zone — before and after the fix. Used by the no-regression case, whose
 * job is to fail if a "fix" touches the output side (`DATE_TRUNC` over the column) instead of
 * the bound parameter.
 */
const WIDE_RANGE = {
  FROM: "2025-12-01T00:00:00.000Z",
  TO: "2026-03-01T00:00:00.000Z"
} as const;

/** `timestamp(3)` resolves milliseconds, so 1 ms is the smallest representable step. */
const BOUNDARY_STEP_MILLIS = 1;

const METRIC_KEY = {
  MS_BEFORE_FROM: "s18.ms-before-from",
  AT_FROM: "s18.at-from",
  INTERIOR: "s18.interior",
  MS_BEFORE_TO: "s18.ms-before-to",
  AT_TO: "s18.at-to"
} as const;

const INTERIOR_INSTANTS = ["2026-01-15T10:00:00.000Z", "2026-01-15T11:00:00.000Z"] as const;
const INTERIOR_QUANTITIES = ["1.500000", "2.250000"] as const;
/** SUM of INTERIOR_QUANTITIES, normalized out of Decimal(18,6). */
const EXPECTED_INTERIOR_QUANTITY = "3.75";
const SINGLE_ROW_QUANTITY = "1.000000";
const EXPECTED_SINGLE_ROW_QUANTITY = "1";

const DAY_MILLIS = 24 * 60 * 60 * 1000;

const shiftIso = (instant: string, millis: number): string =>
  new Date(new Date(instant).getTime() + millis).toISOString();

const startOfUtcDay = (instant: string): string =>
  `${new Date(instant).toISOString().slice(0, "2026-01-01".length)}T00:00:00.000Z`;

interface FixtureRow {
  readonly metricKey: string;
  readonly instant: string;
  readonly quantity: string;
}

interface RoleAttributes {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
}

const FIXTURE_ROWS: readonly FixtureRow[] = [
  {
    metricKey: METRIC_KEY.MS_BEFORE_FROM,
    instant: shiftIso(RANGE.FROM, -BOUNDARY_STEP_MILLIS),
    quantity: SINGLE_ROW_QUANTITY
  },
  { metricKey: METRIC_KEY.AT_FROM, instant: RANGE.FROM, quantity: SINGLE_ROW_QUANTITY },
  {
    metricKey: METRIC_KEY.INTERIOR,
    instant: INTERIOR_INSTANTS[0],
    quantity: INTERIOR_QUANTITIES[0]
  },
  {
    metricKey: METRIC_KEY.INTERIOR,
    instant: INTERIOR_INSTANTS[1],
    quantity: INTERIOR_QUANTITIES[1]
  },
  {
    metricKey: METRIC_KEY.MS_BEFORE_TO,
    instant: shiftIso(RANGE.TO, -BOUNDARY_STEP_MILLIS),
    quantity: SINGLE_ROW_QUANTITY
  },
  { metricKey: METRIC_KEY.AT_TO, instant: RANGE.TO, quantity: SINGLE_ROW_QUANTITY }
];

/** `from` is inclusive and `to` is exclusive, so exactly these three metric keys qualify. */
const METRIC_KEYS_IN_RANGE = [
  METRIC_KEY.AT_FROM,
  METRIC_KEY.INTERIOR,
  METRIC_KEY.MS_BEFORE_TO
].sort();

const METRIC_KEYS_OUT_OF_RANGE = [METRIC_KEY.MS_BEFORE_FROM, METRIC_KEY.AT_TO];

const NO_OP_LOGGER = {
  error: () => undefined,
  debug: () => undefined
};

interface SessionState {
  readonly timeZone: string;
  readonly tenantId: string;
}

interface SessionStateRow {
  readonly timeZone: string;
  readonly tenantId: string;
}

/**
 * Reads the session state that `withTenant` establishes. `withTenant` is `protected`, so a
 * test-local subclass is the only way to observe it without weakening its visibility.
 */
class SessionProbeRepository extends TenantScopedRepository {
  async readSessionState(): Promise<SessionState> {
    return this.withTenant(async (tx) => {
      const rows = await tx.$queryRaw<SessionStateRow[]>`
        SELECT current_setting(${DATABASE_SESSION_SETTINGS.TIME_ZONE}) AS "timeZone",
               current_setting(${DATABASE_SESSION_SETTINGS.TENANT_ID}) AS "tenantId"
      `;
      const state = rows[0];
      if (!state) {
        throw new Error("Expected one row of session state from inside withTenant");
      }
      return state;
    });
  }
}

const requireEnv = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;

  if (!value) {
    throw new Error(`${name} must be set for the usage-summary timezone integration test`);
  }

  return value;
};

/**
 * Appends the session-zone pin to a connection URL. `options=-c timezone=…` is the spelling
 * measured to work at Prisma 6.19.3; a bare `?timezone=…` is accepted and ignored.
 */
const withSessionTimeZone = (url: string, timeZone: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c timezone=${timeZone}`);
  return parsed.toString();
};

describe("Usage summary range predicate is resolved in UTC (integration)", () => {
  const suiteId = randomUUID();
  const tenantId = `s18-tz-${suiteId}`;
  const scopedTenantId = tenantId as TenantId;

  let admin: PrismaClient;
  let appRole: RoleAttributes | undefined;
  const clientsByTimeZone = new Map<string, PrismaClient>();

  const eventId = (row: FixtureRow): string => `s18-ev-${row.metricKey}-${row.instant}-${suiteId}`;

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
      SELECT current_setting(${DATABASE_SESSION_SETTINGS.TIME_ZONE}) AS "timeZone"
    `;
    const observed = rows[0]?.timeZone;
    if (!observed) {
      throw new Error(`Could not read the session time zone for ${timeZone}`);
    }
    return observed;
  };

  const summaryFor = async (
    timeZone: string,
    range: { readonly FROM: string; readonly TO: string }
  ): Promise<UsageSummaryAggregate> => {
    const repository = new UsageRepository(clientFor(timeZone), scopedTenantId, NO_OP_LOGGER);
    return repository.aggregateSummary({
      from: range.FROM,
      to: range.TO,
      granularity: USAGE_SUMMARY_GRANULARITY.DAY,
      page: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE,
      pageSize: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE_SIZE
    });
  };

  const metricKeysFor = async (
    timeZone: string,
    range: { readonly FROM: string; readonly TO: string }
  ): Promise<string[]> => {
    const summary = await summaryFor(timeZone, range);
    return summary.rows.map((row) => row.metricKey).sort();
  };

  beforeAll(async () => {
    admin = new PrismaClient({
      datasourceUrl: requireEnv("DIRECT_DATABASE_URL", ADMIN_URL_FALLBACK)
    });

    // Read through one of the zone-pinned clients: they are all built from DATABASE_URL, so
    // whichever one answers, it is the runtime role this suite asserts through.
    const roles = await clientFor(SESSION_TIME_ZONE.UTC).$queryRaw<RoleAttributes[]>`
      SELECT r.rolname, r.rolsuper, r.rolbypassrls
      FROM pg_roles r
      WHERE r.rolname = current_user
    `;
    appRole = roles[0];

    await admin.tenant.create({ data: { id: tenantId, name: `S-18 timezone probe ${suiteId}` } });
    await admin.event.createMany({
      data: FIXTURE_ROWS.map((row) => ({
        id: eventId(row),
        tenantId,
        idempotencyKey: eventId(row),
        eventType: row.metricKey,
        quantity: row.quantity,
        unit: "request",
        occurredAt: new Date(row.instant)
      }))
    });
    await admin.usageLine.createMany({
      data: FIXTURE_ROWS.map((row) => ({
        id: `s18-ul-${eventId(row)}`,
        tenantId,
        eventId: eventId(row),
        metricKey: row.metricKey,
        quantity: row.quantity,
        periodStart: new Date(row.instant),
        periodEnd: new Date(row.instant)
      }))
    });
  });

  afterAll(async () => {
    if (admin) {
      await admin.usageLine.deleteMany({ where: { tenantId } });
      await admin.event.deleteMany({ where: { tenantId } });
      await admin.tenant.deleteMany({ where: { id: tenantId } });
      await admin.$disconnect();
    }

    for (const client of clientsByTimeZone.values()) {
      await client.$disconnect();
    }
  });

  it("asserts through the runtime role, which is NOSUPERUSER and NOBYPASSRLS", () => {
    // The docstring above states this as a property of the suite, so it is checked rather
    // than trusted. Same assertion as rls.enforcement.integration.test.ts.
    expect(appRole, "DATABASE_URL did not resolve to a known role").toBeDefined();
    expect(appRole?.rolsuper, `role ${appRole?.rolname} is a superuser`).toBe(false);
    expect(appRole?.rolbypassrls, `role ${appRole?.rolname} holds BYPASSRLS`).toBe(false);
  });

  it("seeded every boundary row through the admin role (fixture is not vacuous)", async () => {
    const rows = await admin.usageLine.findMany({
      where: { tenantId },
      select: { metricKey: true, periodStart: true }
    });

    expect(rows).toHaveLength(FIXTURE_ROWS.length);
    // The stored instants are exactly what was written: only the read predicate was ever
    // shifted, so the fixture cannot be blamed for a range failure.
    expect(rows.map((row) => row.periodStart.toISOString()).sort()).toEqual(
      FIXTURE_ROWS.map((row) => row.instant).sort()
    );
  });

  it.each(Object.values(SESSION_TIME_ZONE))(
    "pins the connection session time zone to %s, so the case is not vacuous",
    async (timeZone) => {
      expect(await readSessionTimeZone(timeZone)).toBe(timeZone);
    }
  );

  it.each(Object.values(SESSION_TIME_ZONE))(
    "returns exactly the rows in [from, to) under session time zone %s",
    async (timeZone) => {
      expect(await metricKeysFor(timeZone, RANGE)).toEqual(METRIC_KEYS_IN_RANGE);
    }
  );

  it.each(Object.values(SESSION_TIME_ZONE))(
    "includes the row exactly at from and excludes the row exactly at to under %s",
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
    "returns the identical window for an offset-bearing from/to under %s",
    async (timeZone) => {
      const zulu = await metricKeysFor(timeZone, RANGE);
      const offset = await metricKeysFor(timeZone, RANGE_WITH_OFFSET);

      expect(offset).toEqual(zulu);
      expect(offset).toEqual(METRIC_KEYS_IN_RANGE);
    }
  );

  it("returns the same window under every session time zone", async () => {
    const perZone = await Promise.all(
      Object.values(SESSION_TIME_ZONE).map(async (timeZone) => ({
        timeZone,
        metricKeys: await metricKeysFor(timeZone, RANGE)
      }))
    );

    for (const observed of perZone) {
      expect(observed.metricKeys, `session time zone ${observed.timeZone}`).toEqual(
        METRIC_KEYS_IN_RANGE
      );
    }
  });

  it("pins TimeZone to UTC inside withTenant without leaking past the transaction", async () => {
    const timeZone = SESSION_TIME_ZONE.AHEAD_OF_UTC;
    const repository = new SessionProbeRepository(
      clientFor(timeZone),
      scopedTenantId,
      NO_OP_LOGGER
    );

    const insideTransaction = await repository.readSessionState();

    expect(insideTransaction.timeZone).toBe(DATABASE_SESSION_SETTINGS.TIME_ZONE_UTC);
    // The zone pin must not displace the RLS context that has to be established first.
    expect(insideTransaction.tenantId).toBe(tenantId);
    // `is_local = true`, so the connection's own default survives — otherwise one request's
    // session setting would follow the pooled connection into the next.
    expect(await readSessionTimeZone(timeZone)).toBe(timeZone);
  });

  it("leaves bucket boundaries, quantities and totals unchanged across session time zones", async () => {
    const [reference, ...others] = await Promise.all(
      Object.values(SESSION_TIME_ZONE).map(async (timeZone) => ({
        timeZone,
        summary: await summaryFor(timeZone, WIDE_RANGE)
      }))
    );

    if (!reference) {
      throw new Error("Expected at least one session time zone to compare");
    }

    // Buckets are midnight UTC and bucketEnd is bucketStart + one day, whatever the session
    // zone. This is the guard against "fixing" the column with `AT TIME ZONE` instead of the
    // bound parameter, which would shift every boundary by the server offset.
    expect(reference.summary.rows).toEqual([
      {
        metricKey: METRIC_KEY.MS_BEFORE_FROM,
        bucketStart: startOfUtcDay(shiftIso(RANGE.FROM, -BOUNDARY_STEP_MILLIS)),
        bucketEnd: shiftIso(startOfUtcDay(shiftIso(RANGE.FROM, -BOUNDARY_STEP_MILLIS)), DAY_MILLIS),
        totalQuantity: EXPECTED_SINGLE_ROW_QUANTITY
      },
      {
        metricKey: METRIC_KEY.AT_FROM,
        bucketStart: startOfUtcDay(RANGE.FROM),
        bucketEnd: shiftIso(startOfUtcDay(RANGE.FROM), DAY_MILLIS),
        totalQuantity: EXPECTED_SINGLE_ROW_QUANTITY
      },
      {
        metricKey: METRIC_KEY.INTERIOR,
        bucketStart: startOfUtcDay(INTERIOR_INSTANTS[0]),
        bucketEnd: shiftIso(startOfUtcDay(INTERIOR_INSTANTS[0]), DAY_MILLIS),
        totalQuantity: EXPECTED_INTERIOR_QUANTITY
      },
      {
        metricKey: METRIC_KEY.MS_BEFORE_TO,
        bucketStart: startOfUtcDay(shiftIso(RANGE.TO, -BOUNDARY_STEP_MILLIS)),
        bucketEnd: shiftIso(startOfUtcDay(shiftIso(RANGE.TO, -BOUNDARY_STEP_MILLIS)), DAY_MILLIS),
        totalQuantity: EXPECTED_SINGLE_ROW_QUANTITY
      },
      {
        metricKey: METRIC_KEY.AT_TO,
        bucketStart: startOfUtcDay(RANGE.TO),
        bucketEnd: shiftIso(startOfUtcDay(RANGE.TO), DAY_MILLIS),
        totalQuantity: EXPECTED_SINGLE_ROW_QUANTITY
      }
    ]);

    for (const other of others) {
      expect(other.summary, `session time zone ${other.timeZone}`).toEqual(reference.summary);
    }

    // Decimal(18,6) exceeds IEEE-754 safe precision, so quantities must never cross this
    // boundary as Prisma.Decimal.
    for (const row of reference.summary.rows) {
      expect(typeof row.totalQuantity).toBe("string");
      expect(row.totalQuantity).not.toBeInstanceOf(Prisma.Decimal);
    }
  });
});
