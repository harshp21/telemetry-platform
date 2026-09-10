import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  DATABASE_SESSION_SETTINGS,
  DEDUP_CONSTANTS,
  USAGE_SERVICE_HEADERS,
  USAGE_SERVICE_RESPONSES,
  USAGE_SERVICE_ROUTES,
  USAGE_SUMMARY_CONSTANTS,
  USAGE_SUMMARY_GRANULARITY
} from "../src/constants";
import { INGESTION_CONSTANTS } from "../src/validators/events.validator";
import {
  INTEGRATION_APP_DATABASE_URL_FALLBACK,
  INTEGRATION_BOUNDARY_PROBE,
  INTEGRATION_CONNECTION,
  INTEGRATION_COUNTS,
  INTEGRATION_DATABASE_ROLE,
  INTEGRATION_FIXTURE,
  INTEGRATION_ID_PREFIX,
  INTEGRATION_INGEST,
  INTEGRATION_INSTANTS,
  INTEGRATION_PAGINATION,
  INTEGRATION_QUANTITIES,
  INTEGRATION_REDIS,
  INTEGRATION_REDIS_URL_FALLBACK,
  INTEGRATION_SESSION_TIME_ZONE
} from "./integration.constants";
import {
  IntegrationRedis,
  UsageFixtures,
  type UsageLineSpec
} from "./integration.fixtures";

/**
 * T-036 — usage-service end-to-end against real infrastructure.
 *
 * What only a live Postgres and a live Redis can prove, and therefore what this suite is
 * scoped to (plan §16.1):
 *
 *  - deduplication actually deduplicates (`SET NX EX`, not a stubbed return value);
 *  - published events actually land on the stream (`XADD`, read back with `XRANGE`);
 *  - summary aggregation over real rows: bucket boundaries, `metricKey` filter, empty range,
 *    `>= from AND < to` inclusivity, pagination over *grouped* rows;
 *  - `Decimal(18,6)` crosses the API boundary exactly;
 *  - cross-tenant isolation through HTTP **with both tenants' rows present**.
 *
 * Two connections, and they must not be conflated:
 *   DATABASE_URL        -> telemetry_app (NOSUPERUSER, NOBYPASSRLS) — the service under test
 *   DIRECT_DATABASE_URL -> owner        — fixtures only
 * As `telemetry_app` an unscoped `INSERT` into "Tenant" raises
 * (`new row violates row-level security policy`), but an unscoped `DELETE`/`UPDATE`/`SELECT`
 * silently affects **zero** rows. A reset issued on the service connection would therefore
 * stop resetting and report success, so every fixture write, read-back and reset below goes
 * through the owner client. D3 is the assertion that keeps that honest.
 *
 * Relationship to `rls.enforcement.integration.test.ts`: no overlap and no edits. That file
 * owns the database layer — raw unscoped `SELECT`, cross-tenant `INSERT`/`UPDATE` — and is
 * cited by `.claude/rules/tenant-isolation.md` and `.github/workflows/ci.yml`. This file owns
 * the layer above it: HTTP -> controller -> service -> repository -> real SQL, which nothing
 * covered before.
 *
 * Every request carries `X-Internal-Secret`: `registerUsageInternalAuthMiddleware` is the
 * first `onRequest` hook (`src/app.ts:27`) and only `/health` is exempt, so a case that omits
 * it asserts `401` by accident rather than testing anything. The 401 paths themselves are
 * covered by `usage-events.route.test.ts`.
 *
 * ## The app's database session time zone is pinned, not ambient
 *
 * `"UsageLine"."periodStart"` is `timestamp(3) without time zone`, so a timestamp bound
 * compared against it can resolve through the database SESSION zone (S-18). The local
 * PostgreSQL session is `Asia/Kolkata` and CI's `postgres:16-alpine` is `UTC`, and under
 * `UTC` a session-dependent range predicate and a UTC-correct one return the same rows — so
 * an ambient-zone suite would assert nothing about that in CI. Every case here therefore runs
 * against an app whose connection is pinned to
 * `INTEGRATION_SESSION_TIME_ZONE.AHEAD_OF_UTC`, and B8 runs against both zones.
 *
 * `usage.timezone.integration.test.ts` owns the exhaustive zone matrix at the repository
 * level (three zones, offset-bearing bounds, the `withTenant` UTC pin, bucket stability).
 * This file does not repeat any of that; it covers the one layer that file cannot reach —
 * query string -> controller -> service -> repository -> SQL, composed.
 */

const RUN_ID = randomUUID();

interface IngestEventPayload {
  eventType: string;
  quantity: number;
  unit: string;
  occurredAt: string;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

interface IngestResponseBody {
  data: {
    accepted: number;
    duplicate: number;
    rejected: number;
  };
}

interface SummaryItem {
  metricKey: string;
  bucketStart: string;
  bucketEnd: string;
  totalQuantity: string;
}

interface SummaryResponseBody {
  data: {
    items: SummaryItem[];
    total: number;
    page: number;
    pageSize: number;
  };
}

interface ErrorResponseBody {
  code: string;
  message: string;
}

/** Same three columns the two sibling RLS suites read, for the same reason. */
interface RoleAttributes {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
}

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const tenantAId = randomUUID();
const tenantBId = randomUUID();
const runTenantIds = [tenantAId, tenantBId] as const;

/** One built usage-service instance plus the client whose session zone it is pinned to. */
interface ZonePinnedApp {
  readonly timeZone: string;
  readonly app: FastifyInstance;
  readonly prisma: PrismaClient;
}

/**
 * The zone every case except B8 runs on.
 *
 * Non-UTC by choice, so the suite's connection differs from CI's server default rather than
 * matching it. It is **not** true that a session-dependent bound shows up in these cases
 * because of the pin: `withTenant` re-pins the session to UTC transaction-locally
 * (`base.repository.ts:111`), so the pin is only observable when that pin is absent. Measured
 * against this file at 31 cases, and recorded again in the table inside B8: reverting
 * `utcTimestampBound` to a bound JS `Date` alone leaves 31/31 passing, dropping the
 * `withTenant` pin alone leaves 31/31 passing, and only the conjunction fails — one case, B8's
 * `Asia/Kolkata` leg.
 */
const PRIMARY_SESSION_TIME_ZONE = INTEGRATION_SESSION_TIME_ZONE.AHEAD_OF_UTC;

const appsByTimeZone = new Map<string, ZonePinnedApp>();
let fixtures: UsageFixtures | undefined;
let redis: IntegrationRedis | undefined;
let internalSecret = "";
let streamName = "";
let baseDatabaseUrl = "";
let baseRedisUrl: string | undefined;
let baseRedisStreamName: string | undefined;

/**
 * Pins a session zone onto a connection URL. Spelling rationale on
 * `INTEGRATION_CONNECTION`; the "B8 preflight" cases read the result back.
 *
 * A zone the server does not know is a connection-time `FATAL`, not a silent fallback —
 * measured in two forms against this PostgreSQL, `?options=-c%20timezone%3DNot/AZone` in the
 * URL and `PGOPTIONS="-c timezone=Not/AZone"`, both refused with
 * `FATAL: invalid value for parameter "TimeZone": "Not/AZone"`. So if a CI image lacked the
 * zone data for `AHEAD_OF_UTC`, this suite would fail at connect rather than quietly running
 * every case on the server default. (`Asia/Kolkata` is in `pg_timezone_names` here, and
 * `usage.timezone.integration.test.ts` already uses the same zone through the same mechanism
 * in CI.)
 */
const pinSessionTimeZone = (url: string, timeZone: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set(
    INTEGRATION_CONNECTION.OPTIONS_PARAM,
    `${INTEGRATION_CONNECTION.TIME_ZONE_OPTION_PREFIX}${timeZone}`
  );

  return parsed.toString();
};

/**
 * Builds a usage-service app whose Prisma connection carries `timeZone` as its session zone.
 *
 * The module-registry reset is what makes a *second* zone possible in one process, and it is
 * the whole reason this helper is not two lines. `src/lib/prisma.ts` builds one
 * `PrismaClient` at module load, reading `DATABASE_URL` at that moment, and memoises it on
 * `globalThis.prisma` whenever `NODE_ENV !== "production"` — which under vitest it is not.
 * `src/config/container.ts` imports that binding directly rather than taking a client as an
 * argument, so the only seam for a differently-configured connection is the module graph
 * itself: clear the memo, clear the registry, set the URL, re-import.
 *
 * Already-built apps keep the module instances they closed over, so the primary app is
 * unaffected by a later build. The constants this file imports statically are plain frozen
 * objects of strings and numbers, so a fresh copy inside the re-imported graph compares equal
 * by value — no identity comparison crosses that line.
 */
const buildZonePinnedApp = async (timeZone: string): Promise<ZonePinnedApp> => {
  vi.resetModules();
  delete (globalThis as { prisma?: PrismaClient }).prisma;
  process.env.DATABASE_URL = pinSessionTimeZone(baseDatabaseUrl, timeZone);

  const { env } = await import("../src/config/env");
  internalSecret = env.INTERNAL_API_SECRET;

  const { buildUsageServiceApp } = await import("../src/app");
  const { prisma } = await import("../src/lib/prisma");

  const app = buildUsageServiceApp();
  await app.ready();

  const built: ZonePinnedApp = { timeZone, app, prisma };
  appsByTimeZone.set(timeZone, built);

  return built;
};

const getPinnedApp = (timeZone: string): ZonePinnedApp => {
  const built = appsByTimeZone.get(timeZone);

  if (!built) {
    throw new Error(`usage-service app for session time zone ${timeZone} was not built`);
  }

  return built;
};

const getApp = (): FastifyInstance => getPinnedApp(PRIMARY_SESSION_TIME_ZONE).app;

/** The zone the database actually reports for a pinned connection, outside `withTenant`. */
const readSessionTimeZone = async (timeZone: string): Promise<string> => {
  const rows = await getPinnedApp(timeZone).prisma.$queryRaw<{ timeZone: string }[]>`
    SELECT current_setting(${DATABASE_SESSION_SETTINGS.TIME_ZONE}) AS "timeZone"
  `;
  const observed = rows[0]?.timeZone;

  if (!observed) {
    throw new Error(`Could not read the session time zone for ${timeZone}`);
  }

  return observed;
};

/**
 * The role the app under test is actually connected as, read through the app's own client.
 *
 * Throws rather than returning undefined: a missing row would otherwise make the assertions
 * in "D0" vacuous, which is the exact failure mode the case exists to rule out.
 */
const readConnectedRole = async (timeZone: string): Promise<RoleAttributes> => {
  const rows = await getPinnedApp(timeZone).prisma.$queryRaw<RoleAttributes[]>`
    SELECT r.rolname, r.rolsuper, r.rolbypassrls
    FROM pg_roles r
    WHERE r.rolname = current_user
  `;
  const role = rows[0];

  if (!role) {
    throw new Error(`DATABASE_URL did not resolve to a known role for session zone ${timeZone}`);
  }

  return role;
};

const getFixtures = (): UsageFixtures => {
  if (!fixtures) {
    throw new Error("fixtures were not initialised");
  }

  return fixtures;
};

const getRedis = (): IntegrationRedis => {
  if (!redis) {
    throw new Error("redis harness was not initialised");
  }

  return redis;
};

const internalHeaders = (
  extra: Record<string, string> = {}
): Record<string, string> => ({
  [USAGE_SERVICE_HEADERS.INTERNAL_SECRET]: internalSecret,
  ...extra
});

const tenantHeaders = (tenantId: string): Record<string, string> =>
  internalHeaders({ [USAGE_SERVICE_HEADERS.TENANT_ID]: tenantId });

const parseJson = <T>(response: InjectResponse): T => JSON.parse(response.body) as T;

/** An instant `offsetSeconds` away from the server's own clock, for the skew cases. */
const relativeInstant = (offsetSeconds: number): string =>
  new Date(
    Date.now() + offsetSeconds * INTEGRATION_INGEST.MILLISECONDS_PER_SECOND
  ).toISOString();

const buildEvent = (overrides: Partial<IngestEventPayload> = {}): IngestEventPayload => ({
  eventType: INTEGRATION_FIXTURE.EVENT_TYPE,
  quantity: INTEGRATION_INGEST.QUANTITY,
  unit: INTEGRATION_FIXTURE.EVENT_UNIT,
  occurredAt: relativeInstant(0),
  ...overrides
});

/** A fixed instant offset by whole milliseconds. `periodStart` is `timestamp(3)`, so 1 ms is
 * the smallest step the column can distinguish. */
const shiftIso = (instant: string, millis: number): string =>
  new Date(Date.parse(instant) + millis).toISOString();

/** Keys are per-run so the 24h dedup TTL cannot make the suite pass once and fail all day. */
const idempotencyKey = (suffix: string): string =>
  `${INTEGRATION_ID_PREFIX}${RUN_ID}-${suffix}`;

const ingest = async (
  tenantId: string,
  events: IngestEventPayload[]
): Promise<InjectResponse> =>
  getApp().inject({
    method: "POST",
    url: USAGE_SERVICE_ROUTES.USAGE_EVENTS,
    payload: { events },
    headers: tenantHeaders(tenantId)
  });

const summaryUrl = (params: Record<string, string> = {}): string => {
  const search = new URLSearchParams({
    from: INTEGRATION_INSTANTS.RANGE_FROM,
    to: INTEGRATION_INSTANTS.RANGE_TO,
    granularity: USAGE_SUMMARY_GRANULARITY.DAY,
    ...params
  });

  return `${USAGE_SERVICE_ROUTES.USAGE_SUMMARY}?${search.toString()}`;
};

const requestSummaryVia = async (
  app: FastifyInstance,
  tenantId: string,
  params: Record<string, string> = {}
): Promise<InjectResponse> =>
  app.inject({
    method: "GET",
    url: summaryUrl(params),
    headers: tenantHeaders(tenantId)
  });

const requestSummary = async (
  tenantId: string,
  params: Record<string, string> = {}
): Promise<InjectResponse> => requestSummaryVia(getApp(), tenantId, params);

const line = (
  tenantId: string,
  metricKey: string,
  quantity: string,
  periodStart: string
): UsageLineSpec => ({
  tenantId,
  tenantName:
    tenantId === tenantAId
      ? INTEGRATION_FIXTURE.TENANT_NAME_A
      : INTEGRATION_FIXTURE.TENANT_NAME_B,
  metricKey,
  quantity,
  periodStart
});

/** Matches a `totalQuantity` whose JSON value is not a quoted string. */
const UNQUOTED_QUANTITY = /"totalQuantity":\s*[^"]/;

/**
 * Applied to every summary response the suite reads rather than to one of them.
 *
 * `usage.repository.ts:141` (`toQuantityString`, `String(value)`) is the only thing between a
 * `Prisma.Decimal` and the JSON body, and the assertion has to be made on the **raw** body:
 * `instanceof Prisma.Decimal` against a *parsed* body is vacuously false whatever the service
 * did, because nothing survives `JSON.parse` as a class instance.
 *
 * What this rejects is precisely an **unquoted** `totalQuantity` — a JS `number` or `null`.
 * Confirmed by mutating `String(value)` to `Number(value)`: 14 cases fail here.
 *
 * What it does **not** reject is a leaked `Prisma.Decimal`. `decimal.js` defines `toJSON`, so
 * a Decimal serializes as a *quoted* string and is indistinguishable on the wire from the
 * converted value. Measured four ways at Prisma 6.19.3 —
 * `JSON.stringify({ totalQuantity: new Prisma.Decimal("999999999999.999999") })` →
 * `{"totalQuantity":"999999999999.999999"}`, the same bare, the same nested inside the real
 * `{data:{items:[…]}}` envelope, and `Decimal.prototype.toJSON` present as a function — and
 * confirmed at suite level: passing the `Prisma.Decimal` straight through leaves all 31 cases
 * here green. The assertion that covers a leaked Decimal is the repository-level one, before
 * serialization: `usage.repository.unit.test.ts:396` and
 * `usage.timezone.integration.test.ts:432`, both `not.toBeInstanceOf(Prisma.Decimal)`.
 */
const expectQuantitiesAreExactStrings = (
  response: InjectResponse,
  items: readonly SummaryItem[]
): void => {
  expect(response.body).not.toMatch(UNQUOTED_QUANTITY);

  for (const item of items) {
    expect(typeof item.totalQuantity).toBe("string");
    expect(item.totalQuantity).not.toMatch(/[eE]/);
  }
};

const bucketStarts = (items: readonly SummaryItem[]): string[] =>
  items.map((item) => item.bucketStart);

const okSummary = (response: InjectResponse): SummaryResponseBody["data"] => {
  expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_OK);
  const body = parseJson<SummaryResponseBody>(response);
  expectQuantitiesAreExactStrings(response, body.data.items);

  return body.data;
};

const acceptedIngest = (response: InjectResponse): IngestResponseBody["data"] => {
  expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_ACCEPTED);

  return parseJson<IngestResponseBody>(response).data;
};

const expectBadRequest = (response: InjectResponse, code: string): ErrorResponseBody => {
  expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST);
  const body = parseJson<ErrorResponseBody>(response);
  expect(body.code).toBe(code);

  return body;
};

beforeAll(async () => {
  // The container reads REDIS_URL and REDIS_STREAM_NAME at module load, so both overrides
  // must land before `../src/app` is imported. Logical DB 15 and a per-run stream name keep
  // this suite's keys out of the shared keyspace (db0/db6 hold unrelated work locally).
  baseRedisUrl = process.env.REDIS_URL;
  baseRedisStreamName = process.env.REDIS_STREAM_NAME;
  const redisUrl = new URL(process.env.REDIS_URL ?? INTEGRATION_REDIS_URL_FALLBACK);
  redisUrl.pathname = `/${INTEGRATION_REDIS.LOGICAL_DB_INDEX}`;
  const isolatedRedisUrl = redisUrl.toString();
  process.env.REDIS_URL = isolatedRedisUrl;
  // Held locally rather than read back from `env`: `parseEnv`'s `ZodType<TOutput>` signature
  // infers TOutput from both the schema's output *and* input positions, so every field with
  // a `.default()` widens to `string | undefined` (`env.REDIS_STREAM_NAME` does;
  // `env.INTERNAL_API_SECRET`, which has no default, does not). Owning the value here also
  // makes A1/A2/A9 real evidence that the container picked the override up: the entries only
  // appear on this stream if it did.
  streamName = `${INTEGRATION_REDIS.STREAM_NAME_PREFIX}${RUN_ID}`;
  process.env.REDIS_STREAM_NAME = streamName;

  // Captured before the first build: `buildZonePinnedApp` overwrites DATABASE_URL, so the
  // unpinned original has to be read once and kept.
  //
  // The fallback is the least-privilege role, never the owner. Pointed at the owner every app
  // this suite builds would be `rolsuper`/`rolbypassrls`, RLS would be inert, and D1/D2 would
  // still pass on the repository's application-layer predicate alone — the S-2/S-3 shape. The
  // "D0" case below is what makes that an assertion rather than a comment.
  baseDatabaseUrl = process.env.DATABASE_URL ?? INTEGRATION_APP_DATABASE_URL_FALLBACK;

  fixtures = new UsageFixtures(RUN_ID);
  await getFixtures().assertSchemaReady();

  // Primary first, so its Redis client is the one the ingest cases talk to; the UTC app is
  // only ever asked for a summary and its (lazyConnect) Redis client never connects.
  await buildZonePinnedApp(PRIMARY_SESSION_TIME_ZONE);
  for (const timeZone of Object.values(INTEGRATION_SESSION_TIME_ZONE)) {
    if (!appsByTimeZone.has(timeZone)) {
      await buildZonePinnedApp(timeZone);
    }
  }

  redis = new IntegrationRedis(isolatedRedisUrl);
});

beforeEach(async () => {
  await getFixtures().resetUsageState(runTenantIds);
  // Fails loudly if the reset did not actually delete — the §15.4 silent-no-op failure mode.
  await getFixtures().assertRunStateEmpty(runTenantIds);
  await getRedis().flushIsolatedDb();
});

afterAll(async () => {
  if (fixtures) {
    await fixtures.resetUsageState(runTenantIds).catch(() => undefined);
    await fixtures.disconnect();
  }

  if (redis) {
    await redis.flushIsolatedDb().catch(() => undefined);
    await redis.quit();
  }

  for (const built of appsByTimeZone.values()) {
    await built.app.close();
    await built.prisma.$disconnect();
  }
  appsByTimeZone.clear();

  // All three of the variables `beforeAll` overwrote, not just the one. Vitest 2.1.9's default
  // pool is `forks` with `isolate: true` and no config in this repo overrides `pool`
  // (`grep -rn "pool:" apps/*/vitest.config.mjs packages/*/vitest.config.*` → no match), so
  // today each file has its own process and this restore is unobservable. It stops being
  // unobservable the day someone sets `pool: "threads"`.
  process.env.DATABASE_URL = baseDatabaseUrl;
  if (baseRedisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = baseRedisUrl;
  }
  if (baseRedisStreamName === undefined) {
    delete process.env.REDIS_STREAM_NAME;
  } else {
    process.env.REDIS_STREAM_NAME = baseRedisStreamName;
  }
});

describe.sequential(`POST ${USAGE_SERVICE_ROUTES.USAGE_EVENTS} (integration)`, () => {
  it("A1 accepts five distinct events and publishes all five to the stream", async () => {
    const events = Array.from({ length: INTEGRATION_INGEST.BATCH_SIZE }, (_unused, index) =>
      buildEvent({ idempotencyKey: idempotencyKey(`a1-${index}`) })
    );

    const result = acceptedIngest(await ingest(tenantAId, events));

    expect(result).toEqual({
      accepted: INTEGRATION_INGEST.BATCH_SIZE,
      duplicate: INTEGRATION_COUNTS.NONE,
      rejected: INTEGRATION_COUNTS.NONE
    });

    // The count alone would pass against a stubbed publisher; the keys prove the events landed.
    const entries = await getRedis().readStreamEntries(streamName);
    expect(entries).toHaveLength(INTEGRATION_INGEST.BATCH_SIZE);
    expect(entries.map((entry) => entry.fields.idempotencyKey).sort()).toEqual(
      events.map((event) => event.idempotencyKey).sort()
    );
    expect([...new Set(entries.map((entry) => entry.fields.tenantId))]).toEqual([tenantAId]);
  });

  it("A2 reports a byte-identical replay as duplicate and adds no stream entries", async () => {
    const events = Array.from({ length: INTEGRATION_INGEST.BATCH_SIZE }, (_unused, index) =>
      buildEvent({ idempotencyKey: idempotencyKey(`a2-${index}`) })
    );

    const first = acceptedIngest(await ingest(tenantAId, events));
    expect(first.accepted).toBe(INTEGRATION_INGEST.BATCH_SIZE);

    const replay = acceptedIngest(await ingest(tenantAId, events));

    expect(replay).toEqual({
      accepted: INTEGRATION_COUNTS.NONE,
      duplicate: INTEGRATION_INGEST.BATCH_SIZE,
      rejected: INTEGRATION_COUNTS.NONE
    });

    const entries = await getRedis().readStreamEntries(streamName);
    expect(entries).toHaveLength(INTEGRATION_INGEST.BATCH_SIZE);
  });

  it("A3 rejects a batch above BATCH_SIZE_MAX with BATCH_TOO_LARGE", async () => {
    // Epic-mandated re-assertion. Overlaps `usage-events.route.test.ts:121` and
    // `events.controller.unit.test.ts:151`; retained because the epic names the case and
    // because at HTTP level it also proves the hook order internal-auth -> tenant -> controller.
    const events = Array.from(
      { length: INTEGRATION_INGEST.OVERSIZED_BATCH_SIZE },
      (_unused, index) => buildEvent({ idempotencyKey: idempotencyKey(`a3-${index}`) })
    );

    expectBadRequest(
      await ingest(tenantAId, events),
      INGESTION_CONSTANTS.ERROR_CODES.BATCH_TOO_LARGE
    );

    // The cap is enforced before the service runs, so nothing reaches Redis.
    expect(await getRedis().readStreamEntries(streamName)).toHaveLength(INTEGRATION_COUNTS.NONE);
  });

  it("A4 accepts a batch of exactly BATCH_SIZE_MAX events", async () => {
    const events = Array.from(
      { length: INGESTION_CONSTANTS.BATCH_SIZE_MAX },
      (_unused, index) => buildEvent({ idempotencyKey: idempotencyKey(`a4-${index}`) })
    );

    const result = acceptedIngest(await ingest(tenantAId, events));

    expect(result).toEqual({
      accepted: INGESTION_CONSTANTS.BATCH_SIZE_MAX,
      duplicate: INTEGRATION_COUNTS.NONE,
      rejected: INTEGRATION_COUNTS.NONE
    });
  });

  it("A5 rejects an occurredAt 24 hours in the future with FUTURE_CLOCK_SKEW", async () => {
    // The epic (docs/epics/epic-6-usage-service.md) says 400 VALIDATION_ERROR at a 24h
    // threshold. The code rejects at CLOCK_SKEW_TOLERANCE_SECONDS with FUTURE_CLOCK_SKEW,
    // so a 24h timestamp trips the 5-minute guard. Known gap S-5; asserting the code.
    const response = await ingest(tenantAId, [
      buildEvent({
        occurredAt: relativeInstant(INTEGRATION_INGEST.SKEW_ONE_DAY_SECONDS),
        idempotencyKey: idempotencyKey("a5")
      })
    ]);

    expectBadRequest(response, INGESTION_CONSTANTS.ERROR_CODES.FUTURE_CLOCK_SKEW);
  });

  it("A6 rejects an occurredAt six minutes in the future with FUTURE_CLOCK_SKEW", async () => {
    // Overlaps `events.controller.unit.test.ts:249`; here it pins the real threshold at
    // CLOCK_SKEW_TOLERANCE_SECONDS rather than the epic's 24h.
    const response = await ingest(tenantAId, [
      buildEvent({
        occurredAt: relativeInstant(INTEGRATION_INGEST.SKEW_BEYOND_TOLERANCE_SECONDS),
        idempotencyKey: idempotencyKey("a6")
      })
    ]);

    expectBadRequest(response, INGESTION_CONSTANTS.ERROR_CODES.FUTURE_CLOCK_SKEW);
  });

  it("A7 rejects a malformed occurredAt with VALIDATION_ERROR", async () => {
    // The only path that yields the epic's stated code: `iso8601Schema` rejects the string
    // before the skew guard ever runs.
    const response = await ingest(tenantAId, [
      buildEvent({
        occurredAt: INTEGRATION_INSTANTS.INVALID_OCCURRED_AT,
        idempotencyKey: idempotencyKey("a7")
      })
    ]);

    expectBadRequest(response, INGESTION_CONSTANTS.ERROR_CODES.VALIDATION_ERROR);
  });

  it("A8 rejects an occurredAt six minutes in the past with FUTURE_CLOCK_SKEW", async () => {
    // S-5: `Math.abs` at `events.controller.ts:144` makes the window symmetric, so historical
    // import and retry-after-outage are impossible by construction and the error code
    // misdescribes the case. Overlaps `events.controller.unit.test.ts:283`. Asserting current
    // behaviour deliberately — the behaviour change is a separate task.
    const response = await ingest(tenantAId, [
      buildEvent({
        occurredAt: relativeInstant(-INTEGRATION_INGEST.SKEW_BEYOND_TOLERANCE_SECONDS),
        idempotencyKey: idempotencyKey("a8")
      })
    ]);

    const body = expectBadRequest(
      response,
      INGESTION_CONSTANTS.ERROR_CODES.FUTURE_CLOCK_SKEW
    );
    expect(body.code).not.toBe(INGESTION_CONSTANTS.ERROR_CODES.VALIDATION_ERROR);
  });

  it("A9 collapses five keyless events sharing eventType and occurredAt to one accepted", async () => {
    // Pins the derived-key shape at `ingestion.service.ts:114-116`:
    // `<eventType>:<metadata.sourceId ?? UNKNOWN_SOURCE_ID>:<occurredAt>`, with the tenant
    // deliberately absent because DeduplicationService owns that segment (S-1).
    const occurredAt = relativeInstant(0);
    const events = Array.from({ length: INTEGRATION_INGEST.BATCH_SIZE }, () =>
      buildEvent({ occurredAt })
    );

    const result = acceptedIngest(await ingest(tenantAId, events));

    expect(result).toEqual({
      accepted: INTEGRATION_COUNTS.SINGLE,
      duplicate: INTEGRATION_INGEST.BATCH_SIZE - INTEGRATION_COUNTS.SINGLE,
      rejected: INTEGRATION_COUNTS.NONE
    });

    const derivedRawKey = `${INTEGRATION_FIXTURE.EVENT_TYPE}:${INGESTION_CONSTANTS.UNKNOWN_SOURCE_ID}:${occurredAt}`;
    expect(
      await getRedis().keyExists(
        `${DEDUP_CONSTANTS.KEY_PREFIX}${tenantAId}:${derivedRawKey}`
      )
    ).toBe(true);
    expect(await getRedis().readStreamEntries(streamName)).toHaveLength(
      INTEGRATION_COUNTS.SINGLE
    );
  });

  it("A10 treats one idempotency key from two tenants as two distinct events", async () => {
    // S-1 acceptance, end to end: `DeduplicationService.buildKey` namespaces the key by
    // tenant, so one tenant's client-supplied key cannot suppress another's event.
    const sharedKey = idempotencyKey("a10-shared");

    const first = acceptedIngest(
      await ingest(tenantAId, [buildEvent({ idempotencyKey: sharedKey })])
    );
    const second = acceptedIngest(
      await ingest(tenantBId, [buildEvent({ idempotencyKey: sharedKey })])
    );

    expect(first.accepted).toBe(INTEGRATION_COUNTS.SINGLE);
    expect(first.duplicate).toBe(INTEGRATION_COUNTS.NONE);
    expect(second.accepted).toBe(INTEGRATION_COUNTS.SINGLE);
    expect(second.duplicate).toBe(INTEGRATION_COUNTS.NONE);

    expect(
      await getRedis().keyExists(`${DEDUP_CONSTANTS.KEY_PREFIX}${tenantAId}:${sharedKey}`)
    ).toBe(true);
    expect(
      await getRedis().keyExists(`${DEDUP_CONSTANTS.KEY_PREFIX}${tenantBId}:${sharedKey}`)
    ).toBe(true);
    // The negative half: the caller's raw key never becomes a top-level Redis key.
    expect(await getRedis().keyExists(sharedKey)).toBe(false);
  });
});

describe.sequential(`GET ${USAGE_SERVICE_ROUTES.USAGE_SUMMARY} (integration)`, () => {
  it("B1 returns one bucket per UTC day with per-bucket totals", async () => {
    await getFixtures().seedUsageLines([
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.ONE,
        INTEGRATION_INSTANTS.DAY_1_START
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.TWO,
        INTEGRATION_INSTANTS.DAY_1_NOON
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.FOUR,
        INTEGRATION_INSTANTS.DAY_2_START
      )
    ]);

    const data = okSummary(await requestSummary(tenantAId));

    expect(data.total).toBe(INTEGRATION_COUNTS.PAIR);
    expect(data.items).toEqual([
      {
        metricKey: INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        bucketStart: INTEGRATION_INSTANTS.DAY_1_START,
        bucketEnd: INTEGRATION_INSTANTS.DAY_2_START,
        totalQuantity: INTEGRATION_QUANTITIES.EXPECTED_ONE_PLUS_TWO
      },
      {
        metricKey: INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        bucketStart: INTEGRATION_INSTANTS.DAY_2_START,
        bucketEnd: INTEGRATION_INSTANTS.DAY_3_START,
        totalQuantity: INTEGRATION_QUANTITIES.EXPECTED_FOUR
      }
    ]);
  });

  it("B2 returns only the requested metricKey and counts only its grouped rows", async () => {
    await getFixtures().seedUsageLines([
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.ONE,
        INTEGRATION_INSTANTS.DAY_1_START
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_SECONDARY,
        INTEGRATION_QUANTITIES.TWO,
        INTEGRATION_INSTANTS.DAY_1_START
      )
    ]);

    const data = okSummary(
      await requestSummary(tenantAId, {
        metricKey: INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY
      })
    );

    expect(data.items).toHaveLength(INTEGRATION_COUNTS.SINGLE);
    expect(data.items[0]?.metricKey).toBe(INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY);
    expect(data.items[0]?.totalQuantity).toBe(INTEGRATION_QUANTITIES.EXPECTED_ONE);
    // `total` is grouped rows *after* the filter, not every grouped row in the range.
    expect(data.total).toBe(INTEGRATION_COUNTS.SINGLE);
    expect(
      data.items.some(
        (item) => item.metricKey === INTEGRATION_FIXTURE.METRIC_KEY_SECONDARY
      )
    ).toBe(false);
  });

  it("B3 returns an empty page with pagination defaults for a range with no rows", async () => {
    await getFixtures().seedUsageLines([
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.ONE,
        INTEGRATION_INSTANTS.DAY_1_START
      )
    ]);

    const data = okSummary(
      await requestSummary(tenantAId, {
        from: INTEGRATION_INSTANTS.EMPTY_RANGE_FROM,
        to: INTEGRATION_INSTANTS.EMPTY_RANGE_TO
      })
    );

    expect(data).toEqual({
      items: [],
      total: INTEGRATION_COUNTS.NONE,
      page: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE,
      pageSize: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE_SIZE
    });
  });

  it("B4 groups the first and last instant of a UTC day into one day bucket", async () => {
    await getFixtures().seedUsageLines([
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.ONE,
        INTEGRATION_INSTANTS.DAY_1_START
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.TWO,
        INTEGRATION_INSTANTS.DAY_1_END
      )
    ]);

    const data = okSummary(await requestSummary(tenantAId));

    expect(data.items).toHaveLength(INTEGRATION_COUNTS.SINGLE);
    expect(data.items[0]?.bucketStart).toBe(INTEGRATION_INSTANTS.DAY_1_START);
    expect(data.items[0]?.bucketEnd).toBe(INTEGRATION_INSTANTS.DAY_2_START);
    expect(data.items[0]?.totalQuantity).toBe(INTEGRATION_QUANTITIES.EXPECTED_ONE_PLUS_TWO);
  });

  it("B5 opens a second day bucket at the next midnight UTC", async () => {
    await getFixtures().seedUsageLines([
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.ONE,
        INTEGRATION_INSTANTS.DAY_1_START
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.TWO,
        INTEGRATION_INSTANTS.DAY_1_END
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.FOUR,
        INTEGRATION_INSTANTS.DAY_2_START
      )
    ]);

    const data = okSummary(await requestSummary(tenantAId));

    // The right edge of a bucket is exclusive: one millisecond later opens the next one.
    expect(bucketStarts(data.items)).toEqual([
      INTEGRATION_INSTANTS.DAY_1_START,
      INTEGRATION_INSTANTS.DAY_2_START
    ]);
    expect(data.items[1]?.totalQuantity).toBe(INTEGRATION_QUANTITIES.EXPECTED_FOUR);
  });

  it("B6 buckets weeks from Monday 00:00 UTC", async () => {
    // 2026-01-01 is a Thursday; Postgres `DATE_TRUNC('week', …)` is ISO, so its bucket
    // starts Monday 2025-12-29 — i.e. before the query's own `from`.
    await getFixtures().seedUsageLines([
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.ONE,
        INTEGRATION_INSTANTS.DAY_1_START
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.TWO,
        INTEGRATION_INSTANTS.WEEK_2_START
      )
    ]);

    const data = okSummary(
      await requestSummary(tenantAId, {
        granularity: USAGE_SUMMARY_GRANULARITY.WEEK
      })
    );

    expect(data.total).toBe(INTEGRATION_COUNTS.PAIR);
    expect(bucketStarts(data.items)).toEqual([
      INTEGRATION_INSTANTS.WEEK_1_START,
      INTEGRATION_INSTANTS.WEEK_2_START
    ]);
    expect(data.items[0]?.bucketEnd).toBe(INTEGRATION_INSTANTS.WEEK_2_START);
    expect(data.items[1]?.bucketEnd).toBe(INTEGRATION_INSTANTS.WEEK_3_START);
  });

  it("B7 buckets hours one hour apart", async () => {
    await getFixtures().seedUsageLines([
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.ONE,
        INTEGRATION_INSTANTS.DAY_1_HOUR_0_END
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.TWO,
        INTEGRATION_INSTANTS.DAY_1_HOUR_1_START
      )
    ]);

    const data = okSummary(
      await requestSummary(tenantAId, {
        granularity: USAGE_SUMMARY_GRANULARITY.HOUR
      })
    );

    expect(bucketStarts(data.items)).toEqual([
      INTEGRATION_INSTANTS.DAY_1_START,
      INTEGRATION_INSTANTS.DAY_1_HOUR_1_START
    ]);
    expect(data.items[0]?.bucketEnd).toBe(INTEGRATION_INSTANTS.DAY_1_HOUR_1_START);
    expect(data.items[1]?.bucketEnd).toBe(INTEGRATION_INSTANTS.DAY_1_HOUR_2_START);
  });

  // The boundary cases below are only evidence if the session-zone pin actually took.
  // Measured here by replacing `options=-c timezone=<z>` with the bare `?timezone=<z>` form:
  // both connections then reported `Asia/Kolkata`, this server's own zone, and this UTC case
  // failed with `expected 'Asia/Kolkata' to be 'UTC'`. So the bare form is accepted and
  // ignored, and without the pin a connection inherits the server default.
  //
  // Note that under that mutation the `AHEAD_OF_UTC` case still passed, because this host's
  // server zone happens to equal it — on CI, whose server is `UTC`, the two swap roles. It
  // takes both cases to catch a broken pin on an arbitrary host, which is why this is an
  // `it.each` over the same zones the boundary case uses rather than one spot check.
  it.each(Object.values(INTEGRATION_SESSION_TIME_ZONE))(
    "B8 preflight: the app's connection reports session time zone %s",
    async (timeZone) => {
      expect(await readSessionTimeZone(timeZone)).toBe(timeZone);
    }
  );

  it.each(Object.values(INTEGRATION_SESSION_TIME_ZONE))(
    "B8 applies the range as half-open [from, to) under session time zone %s",
    async (timeZone) => {
      // The contract, stated as four rows: exactly at `from` is IN, one millisecond below
      // `from` is OUT, one millisecond below `to` is IN, exactly at `to` is OUT.
      //
      // Both zones are asserted because the two are not interchangeable. Under `UTC` — CI's
      // own default for `postgres:16-alpine` — a UTC-correct range predicate and the
      // session-dependent one S-18 replaced return the same rows, so the UTC leg is a
      // baseline and cannot fail for this defect. The `AHEAD_OF_UTC` leg is the discriminator:
      // before S-18 the effective window there was shifted by +05:30, which moved every one
      // of these four rows to the wrong side of an edge.
      //
      // Each probe row carries its own `metricKey`, so inclusion is read directly off the
      // response rather than inferred from a total, and the assertion is exhaustive — an
      // extra row, a missing row or a flipped edge all fail.
      //
      // What five mutations of `src/` actually did to this case, measured rather than
      // assumed, because the result was not the expected one:
      //   `>= from` -> `> from`                      both legs FAIL
      //   `< to`    -> `<= to`                       both legs FAIL
      //   `utcTimestampBound` -> a bound JS `Date`   both legs PASS
      //   drop `withTenant`'s UTC `TimeZone` pin      both legs PASS
      //   both of the last two together              Asia/Kolkata FAILS, UTC passes
      // S-18 shipped two independent guards — a naive-cast bound and a transaction-local
      // session pin — and either one alone is sufficient. No behavioural test can therefore
      // kill one while the other stands; this case kills the conjunction. Whether each guard
      // is individually present is a code-level question, and
      // `usage.timezone.integration.test.ts` asserts the pin directly through
      // `SessionProbeRepository`.
      const from = INTEGRATION_INSTANTS.BOUNDARY_RANGE_FROM;
      const to = INTEGRATION_INSTANTS.BOUNDARY_RANGE_TO;
      const step = INTEGRATION_BOUNDARY_PROBE.STEP_MILLIS;

      await getFixtures().seedUsageLines([
        line(
          tenantAId,
          INTEGRATION_BOUNDARY_PROBE.METRIC_KEY_BEFORE_FROM,
          INTEGRATION_QUANTITIES.ONE,
          shiftIso(from, -step)
        ),
        line(
          tenantAId,
          INTEGRATION_BOUNDARY_PROBE.METRIC_KEY_AT_FROM,
          INTEGRATION_QUANTITIES.ONE,
          from
        ),
        line(
          tenantAId,
          INTEGRATION_BOUNDARY_PROBE.METRIC_KEY_BEFORE_TO,
          INTEGRATION_QUANTITIES.ONE,
          shiftIso(to, -step)
        ),
        line(
          tenantAId,
          INTEGRATION_BOUNDARY_PROBE.METRIC_KEY_AT_TO,
          INTEGRATION_QUANTITIES.ONE,
          to
        )
      ]);

      // All four rows are in the table. Without this, a row that silently failed to seed
      // would be indistinguishable from a row the predicate correctly excluded.
      const seeded = await getFixtures().countRows(runTenantIds);
      expect(seeded.usageLines).toBe(INTEGRATION_COUNTS.QUAD);

      const data = okSummary(
        await requestSummaryVia(getPinnedApp(timeZone).app, tenantAId, { from, to })
      );

      expect(data.items.map((item) => item.metricKey).sort()).toEqual(
        [
          INTEGRATION_BOUNDARY_PROBE.METRIC_KEY_AT_FROM,
          INTEGRATION_BOUNDARY_PROBE.METRIC_KEY_BEFORE_TO
        ].sort()
      );
      expect(data.total).toBe(INTEGRATION_COUNTS.PAIR);
    }
  );

  it("B9 paginates over grouped rows, not raw usage lines", async () => {
    await getFixtures().seedUsageLines([
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.ONE,
        INTEGRATION_INSTANTS.DAY_1_START
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.ONE,
        INTEGRATION_INSTANTS.DAY_1_NOON
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.TWO,
        INTEGRATION_INSTANTS.DAY_2_START
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.FOUR,
        INTEGRATION_INSTANTS.DAY_3_START
      )
    ]);

    const data = okSummary(
      await requestSummary(tenantAId, {
        page: String(INTEGRATION_PAGINATION.PAGE_TWO),
        pageSize: String(INTEGRATION_PAGINATION.PAGE_SIZE_TWO)
      })
    );

    expect(data.items).toHaveLength(INTEGRATION_COUNTS.SINGLE);
    expect(data.items[0]?.bucketStart).toBe(INTEGRATION_INSTANTS.DAY_3_START);
    // Four seeded lines, three grouped buckets: `total` counts the latter.
    expect(data.total).toBe(INTEGRATION_COUNTS.TRIPLE);
    expect(data.page).toBe(INTEGRATION_PAGINATION.PAGE_TWO);
    expect(data.pageSize).toBe(INTEGRATION_PAGINATION.PAGE_SIZE_TWO);
  });

  it("B10 rejects a pageSize above MAX_PAGE_SIZE instead of clamping", async () => {
    const response = await requestSummary(tenantAId, {
      pageSize: String(INTEGRATION_PAGINATION.OVERSIZED_PAGE_SIZE)
    });

    expectBadRequest(response, USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR);
  });

  it("B11 rejects a range whose from is not earlier than to", async () => {
    const response = await requestSummary(tenantAId, {
      from: INTEGRATION_INSTANTS.RANGE_TO,
      to: INTEGRATION_INSTANTS.RANGE_FROM
    });

    const body = expectBadRequest(response, USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR);
    expect(body.message).toContain(USAGE_SUMMARY_CONSTANTS.MESSAGE_INVALID_RANGE);
  });
});

describe.sequential("Decimal(18,6) across the usage-summary API boundary (integration)", () => {
  it("C1 returns the exact maximum representable Decimal(18,6) sum as a string", async () => {
    // 999999999999.999999 has 18 significant digits, which no float64 round-trip can hold.
    // An exact match therefore proves the value never became a JS `number`.
    await getFixtures().seedUsageLines([
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.PRECISION_MAX_PART_A,
        INTEGRATION_INSTANTS.DAY_1_START
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.PRECISION_MAX_PART_B,
        INTEGRATION_INSTANTS.DAY_1_NOON
      )
    ]);

    const data = okSummary(await requestSummary(tenantAId));

    expect(data.items).toHaveLength(INTEGRATION_COUNTS.SINGLE);
    expect(data.items[0]?.totalQuantity).toBe(
      INTEGRATION_QUANTITIES.EXPECTED_PRECISION_MAX
    );
  });

  it("C2 returns 0.100000 + 0.200000 with no float artefact", async () => {
    await getFixtures().seedUsageLines([
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.FLOAT_TRAP_PART_A,
        INTEGRATION_INSTANTS.DAY_1_START
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.FLOAT_TRAP_PART_B,
        INTEGRATION_INSTANTS.DAY_1_NOON
      )
    ]);

    const data = okSummary(await requestSummary(tenantAId));
    const totalQuantity = data.items[0]?.totalQuantity;

    // Postgres prints `0.300000`; decimal.js `String()` renders `0.3`. Measured, not assumed.
    expect(totalQuantity).toBe(INTEGRATION_QUANTITIES.EXPECTED_FLOAT_TRAP);
    expect(totalQuantity).not.toBe(INTEGRATION_QUANTITIES.FLOAT_TRAP_ARTEFACT);
    expect(new Prisma.Decimal(totalQuantity ?? "").equals(
      INTEGRATION_QUANTITIES.EXPECTED_FLOAT_TRAP
    )).toBe(true);
  });

  it("C3 returns every totalQuantity as an exact decimal string, with no float rendering", async () => {
    await getFixtures().seedUsageLines([
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.FLOAT_TRAP_PART_A,
        INTEGRATION_INSTANTS.DAY_1_START
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_SECONDARY,
        INTEGRATION_QUANTITIES.PRECISION_MAX_PART_A,
        INTEGRATION_INSTANTS.DAY_1_NOON
      ),
      line(
        tenantAId,
        INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
        INTEGRATION_QUANTITIES.ONE,
        INTEGRATION_INSTANTS.DAY_2_START
      )
    ]);

    const data = okSummary(await requestSummary(tenantAId));

    // `okSummary` already applies the shape assertions to every response the suite reads;
    // this states them once explicitly, and guards against an empty pass by requiring more
    // than one item first.
    expect(data.items.length).toBeGreaterThan(INTEGRATION_COUNTS.SINGLE);
    for (const item of data.items) {
      expect(typeof item.totalQuantity).toBe("string");
      expect(Number.isNaN(Number(item.totalQuantity))).toBe(false);
      // Digit-exact: the string a `Decimal` renders to, not a rounded float rendering.
      expect(new Prisma.Decimal(item.totalQuantity).toString()).toBe(item.totalQuantity);
    }
  });
});

describe.sequential(
  "Tenant isolation through HTTP with both tenants' rows present (integration)",
  () => {
    const seedBothTenants = async (): Promise<void> => {
      await getFixtures().seedUsageLines([
        line(
          tenantAId,
          INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
          INTEGRATION_QUANTITIES.TENANT_A,
          INTEGRATION_INSTANTS.DAY_1_START
        ),
        line(
          tenantBId,
          INTEGRATION_FIXTURE.METRIC_KEY_PRIMARY,
          INTEGRATION_QUANTITIES.TENANT_B,
          INTEGRATION_INSTANTS.DAY_1_START
        )
      ]);

      // What makes D1/D2 non-vacuous: both tenants' rows are in the table, in the same
      // bucket, under the same metric key, at the moment of the request. So a response
      // carrying only one tenant's row is evidence of *something* filtering.
      //
      // What it is not evidence of is *which* layer filtered. D1/D2 prove the composite of
      // the repository's bound `WHERE "tenantId" = $1` predicate and the RLS policy, and they
      // cannot separate the two, because either alone is sufficient. Measured: rewriting
      // `buildFilters` so the bound tenant parameter is still consumed but no longer filters
      // leaves all 31 cases here green — `telemetry_app` is NOBYPASSRLS and the policy carries
      // it. The predicate on its own is asserted at `usage.repository.unit.test.ts:202-207`
      // (`'"tenantId" = $1'` present in both the count and the page SQL); the RLS layer on its
      // own is `rls.enforcement.integration.test.ts`. Do not delete the predicate on the
      // grounds that this case would catch it — it would not.
      const counts = await getFixtures().countRows(runTenantIds);
      expect(counts.usageLines).toBe(INTEGRATION_COUNTS.PAIR);
    };

    it("D0 connects the app under test as telemetry_app: NOSUPERUSER, NOBYPASSRLS", async () => {
      // The precondition for reading D1/D2 as tenant-isolation evidence at all, and the only
      // one of this file's claims about its own environment that was previously unchecked.
      // Both sibling suites assert it (`rls.enforcement.integration.test.ts:156-165`,
      // `usage.timezone.integration.test.ts:324-330`) — a docstring is not a check.
      //
      // Asserted through the app's own client, so it is the connection the HTTP cases use and
      // not a second one built here. Non-vacuity is measured, not argued: pointing
      // DATABASE_URL at the owner leaves D1/D2 green and fails only this case.
      const role = await readConnectedRole(PRIMARY_SESSION_TIME_ZONE);

      expect(role.rolsuper, `role ${role.rolname} is a superuser; RLS cannot enforce`).toBe(
        false
      );
      expect(
        role.rolbypassrls,
        `role ${role.rolname} holds BYPASSRLS; RLS cannot enforce`
      ).toBe(false);
      // Not merely "some restricted role" — the role this platform's four non-auth services
      // actually run as (`.claude/rules/tenant-isolation.md`), the one the RLS policies were
      // written against, and the one `tests/setup.ts:5-6` and `.github/workflows/ci.yml:15`
      // both set. Mirrors `apps/auth-service/tests/rls.integration.test.ts:132-139`.
      expect(role.rolname).toBe(INTEGRATION_DATABASE_ROLE.APP);
    });

    it("D1 returns only tenant A's rows when X-Tenant-Id is tenant A", async () => {
      await seedBothTenants();

      const data = okSummary(await requestSummary(tenantAId));

      expect(data.items).toHaveLength(INTEGRATION_COUNTS.SINGLE);
      expect(data.items[0]?.totalQuantity).toBe(INTEGRATION_QUANTITIES.EXPECTED_TENANT_A);
      expect(data.total).toBe(INTEGRATION_COUNTS.SINGLE);
      expect(
        data.items.some(
          (item) => item.totalQuantity === INTEGRATION_QUANTITIES.EXPECTED_TENANT_B
        )
      ).toBe(false);
    });

    it("D2 returns only tenant B's rows when X-Tenant-Id is tenant B", async () => {
      await seedBothTenants();

      const data = okSummary(await requestSummary(tenantBId));

      expect(data.items).toHaveLength(INTEGRATION_COUNTS.SINGLE);
      expect(data.items[0]?.totalQuantity).toBe(INTEGRATION_QUANTITIES.EXPECTED_TENANT_B);
      expect(data.total).toBe(INTEGRATION_COUNTS.SINGLE);
      expect(
        data.items.some(
          (item) => item.totalQuantity === INTEGRATION_QUANTITIES.EXPECTED_TENANT_A
        )
      ).toBe(false);
    });

    it("D3 resets its own fixtures through the owner connection", async () => {
      // The reset runs on DIRECT_DATABASE_URL because as `telemetry_app` an unscoped DELETE
      // affects zero rows and raises nothing — a reset on the service connection would
      // report success while deleting nothing, and every seeded case after the first would
      // then be asserting against stale rows.
      await seedBothTenants();

      const seeded = await getFixtures().countRows(runTenantIds);
      expect(seeded.usageLines).toBe(INTEGRATION_COUNTS.PAIR);
      expect(seeded.events).toBe(INTEGRATION_COUNTS.PAIR);
      expect(seeded.tenants).toBe(INTEGRATION_COUNTS.PAIR);

      await getFixtures().resetUsageState(runTenantIds);

      expect(await getFixtures().countRows(runTenantIds)).toEqual({
        tenants: INTEGRATION_COUNTS.NONE,
        events: INTEGRATION_COUNTS.NONE,
        usageLines: INTEGRATION_COUNTS.NONE
      });
    });
  }
);
