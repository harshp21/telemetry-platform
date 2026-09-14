import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import RedisClient from "ioredis";
import type Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import type { ServiceEnv } from "../src/config/env";
import { WORKER_EVENT_PROCESSING, WORKER_STREAM_READ } from "../src/constants";
import { EventRepository } from "../src/repositories/event.repository";
import { EventProcessorService } from "../src/services/event-processor.service";
import { StreamConsumer, type StreamMessageHandler } from "../src/events/stream.consumer";
import { parseStreamMessage } from "../src/validators/stream-message.validator";
import {
  INTEGRATION_LOOP,
  INTEGRATION_LOOP_COMMANDS,
  INTEGRATION_PROCESSOR_COUNTS,
  INTEGRATION_PROCESSOR_EVENT,
  INTEGRATION_PROCESSOR_INDEX_FIRST,
  INTEGRATION_PROCESSOR_PENDING_PAGE_SIZE,
  INTEGRATION_PROCESSOR_QUANTITY,
  INTEGRATION_PROCESSOR_REDIS,
  INTEGRATION_PROCESSOR_SESSION_TIME_ZONE,
  INTEGRATION_REDIS,
  INTEGRATION_REDIS_COMMANDS,
  INTEGRATION_REDIS_URL_FALLBACK
} from "./integration.constants";

/**
 * Live Postgres + Redis suite for T-040 (slices S4-S6).
 *
 * **Two connection roles, and the distinction is the whole point.** Fixtures are seeded and
 * asserted through `DIRECT_DATABASE_URL` (the owner), because RLS blocks `telemetry_app` from
 * inserting `"Tenant"` rows and would hide the cross-tenant rows these cases have to *see*. The
 * subject runs on `DATABASE_URL`, which `tests/setup.ts` points at `telemetry_app` —
 * `NOSUPERUSER`, `NOBYPASSRLS`, owner of no table. `.claude/rules/tenant-isolation.md`: a
 * passing RLS test is not evidence unless it runs as that role and its fixtures were seeded
 * through a different connection. `I19` asserts both halves rather than assuming them, so that
 * every other case's tenant claim is not vacuous.
 *
 * Redis runs on logical database **14**, worker-service's reserved index, and every `FLUSHDB`
 * goes through `flushReservedDb()`, which re-asserts `CLIENT INFO` contains `db=14` **on each
 * call** — the shape `stream.consumer.integration.test.ts` uses and the one S-22 says not to
 * weaken to a single `beforeAll` guard. Database 0 holds the developer's real
 * `telemetry:events` and is never touched.
 *
 * Postgres fixtures are deleted by **explicit id**, in `afterEach` *and* `afterAll`, and never
 * by a broad predicate: the development database holds unrelated `Tenant` and `User` rows, and
 * S-20 is the entry about a suite whose cleanup could not collect what it left.
 */

const ADMIN_URL_FALLBACK = "postgresql://postgres:postgres@localhost:5432/telemetry";

/**
 * The same instant as `INTEGRATION_PROCESSOR_EVENT.OCCURRED_AT_ISO`, written with offsets.
 *
 * `iso8601Schema` is `z.string().datetime({ offset: true })` and the producer forwards the raw
 * request string, so these are legal wire values. Both signs, because a discarded offset and an
 * offset applied backwards are indistinguishable from one sign alone.
 */
const OCCURRED_AT_OFFSET_FORMS = [
  "2026-01-01T05:30:00.000+05:30",
  "2025-12-31T19:00:00.000-05:00"
] as const;

const requireEnv = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`${name} must be set for the T-040 event-processor integration test`);
  }

  return value;
};

interface RoleAttributes {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
}

interface QuantityTextRow {
  readonly quantity: string;
}

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  warn: () => undefined
} as unknown as Logger;

const RUN_ID = `${process.pid}-${Date.now()}`;

let admin: PrismaClient;
let app: PrismaClient;
let redis: Redis;
let reservedDbUrl = "";
let caseIndex = INTEGRATION_PROCESSOR_COUNTS.NONE;

/** Tenant ids created for this run, deleted by explicit id. Real UUIDs — the parser demands it. */
let tenantAId = "";
let tenantBId = "";
/** Every `Event.id` any case caused or seeded, so cleanup is by id and never by predicate. */
let createdEventIds: string[] = [];

/**
 * The only place this suite issues `FLUSHDB`, guarded on every call.
 *
 * Copied in shape, not imported, from `stream.consumer.integration.test.ts`: that helper closes
 * over that file's own client. The property that matters is that the guard runs per call rather
 * than once in `beforeAll` — vitest runs `afterAll` even when `beforeAll` throws, so a single
 * pre-flush assertion leaves the teardown flushes unguarded (measured there: with the guard
 * mutated to something `CLIENT INFO` cannot satisfy, db 14's `DBSIZE` still went 1 -> 0).
 *
 * Scope: every flush routed through here is guarded. A future bare `redis.flushdb()` elsewhere
 * in this file would not be — this is a chokepoint, not an impossibility.
 */
const flushReservedDb = async (): Promise<void> => {
  if (!redis) {
    throw new Error("Redis client was never constructed; refusing to FLUSHDB");
  }
  expect(
    await redis.call(INTEGRATION_LOOP_COMMANDS.CLIENT, INTEGRATION_LOOP_COMMANDS.CLIENT_INFO)
  ).toContain(
    `${INTEGRATION_LOOP_COMMANDS.CLIENT_DB_FIELD_PREFIX}${INTEGRATION_REDIS.LOGICAL_DB_INDEX}`
  );
  await redis.flushdb();
};

/** A stream key and group unique to one case. */
const nextFixtureNames = (): { streamName: string; groupName: string } => {
  caseIndex += INTEGRATION_PROCESSOR_COUNTS.SINGLE;

  return {
    streamName: `${INTEGRATION_PROCESSOR_REDIS.STREAM_NAME_PREFIX}${RUN_ID}-${caseIndex}`,
    groupName: `${INTEGRATION_PROCESSOR_REDIS.CONSUMER_GROUP_PREFIX}${RUN_ID}-${caseIndex}`
  };
};

/** The flat field list the producer publishes, as `XADD`/`dispatch` deliver it. */
const streamFields = (overrides: Record<string, string> = {}): string[] => {
  const eventId = randomUUID();
  createdEventIds.push(eventId);

  return Object.entries({
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID]: eventId,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: tenantAId,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_TYPE]:
      INTEGRATION_PROCESSOR_EVENT.EVENT_TYPE,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY]:
      INTEGRATION_PROCESSOR_QUANTITY.FULL_PRECISION,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.UNIT]: INTEGRATION_PROCESSOR_EVENT.UNIT,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT]:
      INTEGRATION_PROCESSOR_EVENT.OCCURRED_AT_ISO,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.IDEMPOTENCY_KEY]: `t040-${randomUUID()}`,
    [INTEGRATION_PROCESSOR_EVENT.SOURCE_ID_FIELD]:
      INTEGRATION_PROCESSOR_EVENT.SOURCE_ID_VALUE,
    ...overrides
  }).flat();
};

const buildRepository = (tenantId: string): EventRepository =>
  new EventRepository(app, tenantId as TenantId, silentLogger);

/** `quantity::text`, so the column's stored digits are read rather than the ORM's rendering. */
const readEventQuantityText = async (eventId: string): Promise<string | undefined> => {
  const rows = await admin.$queryRaw<QuantityTextRow[]>`
    SELECT "quantity"::text AS "quantity" FROM "Event" WHERE "id" = ${eventId}
  `;

  return rows[INTEGRATION_PROCESSOR_INDEX_FIRST]?.quantity;
};

const readUsageLineQuantityText = async (eventId: string): Promise<string | undefined> => {
  const rows = await admin.$queryRaw<QuantityTextRow[]>`
    SELECT "quantity"::text AS "quantity" FROM "UsageLine" WHERE "eventId" = ${eventId}
  `;

  return rows[INTEGRATION_PROCESSOR_INDEX_FIRST]?.quantity;
};

/** Deletes only what this run created, by id, child rows first. */
const deleteFixtureRows = async (): Promise<void> => {
  if (createdEventIds.length > INTEGRATION_PROCESSOR_COUNTS.NONE) {
    await admin.usageLine.deleteMany({ where: { eventId: { in: createdEventIds } } });
    await admin.event.deleteMany({ where: { id: { in: createdEventIds } } });
  }
};

beforeAll(async () => {
  admin = new PrismaClient({
    datasourceUrl: requireEnv("DIRECT_DATABASE_URL", ADMIN_URL_FALLBACK)
  });
  app = new PrismaClient({ datasourceUrl: requireEnv("DATABASE_URL") });

  const redisUrl = new URL(process.env.REDIS_URL ?? INTEGRATION_REDIS_URL_FALLBACK);
  redisUrl.pathname = `/${INTEGRATION_REDIS.LOGICAL_DB_INDEX}`;
  reservedDbUrl = redisUrl.toString();
  redis = new RedisClient(reservedDbUrl, { connectionName: INTEGRATION_REDIS.CLIENT_NAME });
  await flushReservedDb();

  tenantAId = randomUUID();
  tenantBId = randomUUID();
  await admin.tenant.createMany({
    data: [
      { id: tenantAId, name: "T-040 Probe A" },
      { id: tenantBId, name: "T-040 Probe B" }
    ]
  });
});

beforeEach(() => {
  createdEventIds = [];
});

afterEach(async () => {
  await deleteFixtureRows();
  await flushReservedDb();
});

afterAll(async () => {
  try {
    // `afterAll` as well as `afterEach`, which is the half S-20 records auth-service missing:
    // per-case cleanup alone leaves whatever the last case created.
    await deleteFixtureRows();
    await admin.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await flushReservedDb();
  } finally {
    await redis?.quit();
    await app?.$disconnect();
    await admin?.$disconnect();
  }
});

describe("EventRepository.upsertEventWithUsageLine (live Postgres, as telemetry_app)", () => {
  it("I13 - writes one Event and one UsageLine, with metricKey and both period bounds derived", async () => {
    const fields = streamFields();
    const payload = parseStreamMessage(fields);

    const result = await buildRepository(tenantAId).upsertEventWithUsageLine(payload);

    expect(result.created).toBe(true);

    const event = await admin.event.findUnique({ where: { id: payload.event.eventId } });
    expect(event).not.toBeNull();
    expect(event?.tenantId).toBe(tenantAId);
    expect(event?.eventType).toBe(INTEGRATION_PROCESSOR_EVENT.EVENT_TYPE);
    expect(event?.unit).toBe(INTEGRATION_PROCESSOR_EVENT.UNIT);
    expect(event?.occurredAt.toISOString()).toBe(
      INTEGRATION_PROCESSOR_EVENT.OCCURRED_AT_ISO
    );
    // D3: the flattened metadata field is reconstructed, as a string.
    expect(event?.metadata).toEqual({
      [INTEGRATION_PROCESSOR_EVENT.SOURCE_ID_FIELD]:
        INTEGRATION_PROCESSOR_EVENT.SOURCE_ID_VALUE
    });
    // The producer's own bookkeeping field is absent from the wire here, and either way never
    // lands in a customer-facing metadata blob.
    expect(event?.metadata).not.toHaveProperty(
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.PRODUCER_TIMESTAMP
    );

    const usageLine = await admin.usageLine.findUnique({
      where: { eventId: payload.event.eventId }
    });
    expect(usageLine).not.toBeNull();
    expect(usageLine?.tenantId).toBe(tenantAId);
    // D1 and D2, as stored rather than as returned.
    expect(usageLine?.metricKey).toBe(INTEGRATION_PROCESSOR_EVENT.EVENT_TYPE);
    expect(usageLine?.periodStart.toISOString()).toBe(
      INTEGRATION_PROCESSOR_EVENT.OCCURRED_AT_ISO
    );
    expect(usageLine?.periodEnd.toISOString()).toBe(
      INTEGRATION_PROCESSOR_EVENT.OCCURRED_AT_ISO
    );
    expect(usageLine?.billed).toBe(false);
  });

  it("I14 - a replay of the same entry leaves one Event and one UsageLine, with the same ids", async () => {
    const fields = streamFields();
    const payload = parseStreamMessage(fields);

    const first = await buildRepository(tenantAId).upsertEventWithUsageLine(payload);
    // A *fresh* repository, as production builds one per message — not the same instance twice.
    const second = await buildRepository(tenantAId).upsertEventWithUsageLine(payload);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.eventId).toBe(first.eventId);

    expect(
      await admin.event.count({ where: { tenantId: tenantAId, id: payload.event.eventId } })
    ).toBe(INTEGRATION_PROCESSOR_COUNTS.SINGLE);
    expect(await admin.usageLine.count({ where: { eventId: payload.event.eventId } })).toBe(
      INTEGRATION_PROCESSOR_COUNTS.SINGLE
    );
  });

  it("I15 - two tenants may hold the same idempotency key, and neither repository sees the other's row", async () => {
    // The migration's whole reason. Under the global unique this key was a cross-tenant poison
    // pill: tenant B's insert raised `duplicate key value violates unique constraint
    // "Event_idempotencyKey_key"` against a row RLS would not even let it see.
    const sharedKey = `t040-shared-${randomUUID()}`;
    const fieldsA = streamFields({
      [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.IDEMPOTENCY_KEY]: sharedKey
    });
    const fieldsB = streamFields({
      [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: tenantBId,
      [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.IDEMPOTENCY_KEY]: sharedKey
    });
    const payloadA = parseStreamMessage(fieldsA);
    const payloadB = parseStreamMessage(fieldsB);

    const resultA = await buildRepository(tenantAId).upsertEventWithUsageLine(payloadA);
    const resultB = await buildRepository(tenantBId).upsertEventWithUsageLine(payloadB);

    // Both persisted, as two distinct rows.
    expect(resultA.created).toBe(true);
    expect(resultB.created).toBe(true);
    expect(resultA.eventId).not.toBe(resultB.eventId);
    expect(await admin.event.count({ where: { idempotencyKey: sharedKey } })).toBe(
      INTEGRATION_PROCESSOR_COUNTS.PAIR
    );

    // Neither sees the other. Read through the *app* connection inside each tenant's context,
    // because that is the connection RLS applies to; reading through `admin` would prove only
    // that two rows exist.
    const visibleToA = await app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantAId}, true)`;

      return tx.event.findMany({ where: { idempotencyKey: sharedKey } });
    });
    expect(visibleToA).toHaveLength(INTEGRATION_PROCESSOR_COUNTS.SINGLE);
    expect(visibleToA[INTEGRATION_PROCESSOR_INDEX_FIRST]?.tenantId).toBe(tenantAId);
    // The negative that carries the weight: the other tenant's id appears nowhere in what A can
    // read, even though the row exists and shares A's lookup key.
    expect(JSON.stringify(visibleToA)).not.toContain(tenantBId);
  });

  it("I16 - a failure on the second write rolls back the first: zero rows of both kinds", async () => {
    const fields = streamFields();
    const payload = parseStreamMessage(fields);
    // The `Event` keeps a legal quantity and only the `UsageLine` overflows, so the failure
    // lands *after* the event row has been inserted. Both values equal in the parsed payload
    // would fail on the first write, and "zero rows" would then be evidence of nothing.
    const divergent = {
      ...payload,
      usageLine: {
        ...payload.usageLine,
        quantity: INTEGRATION_PROCESSOR_QUANTITY.OVERFLOWS_COLUMN
      }
    };

    await expect(
      buildRepository(tenantAId).upsertEventWithUsageLine(divergent)
    ).rejects.toThrow();

    // Read through `admin`, i.e. past RLS: "zero rows" has to mean the rows are not there, not
    // that this connection cannot see them.
    expect(await admin.event.count({ where: { id: payload.event.eventId } })).toBe(
      INTEGRATION_PROCESSOR_COUNTS.NONE
    );
    expect(await admin.usageLine.count({ where: { eventId: payload.event.eventId } })).toBe(
      INTEGRATION_PROCESSOR_COUNTS.NONE
    );
  });

  it("I19 - the subject's connection is a non-superuser, non-BYPASSRLS role and the policies are live", async () => {
    // Without this case every other tenant claim in the file is unverified: a superuser or a
    // `BYPASSRLS` role would pass them all while enforcing nothing
    // (`.claude/rules/tenant-isolation.md`).
    const roles = await app.$queryRaw<RoleAttributes[]>`
      SELECT r.rolname, r.rolsuper, r.rolbypassrls
      FROM pg_roles r WHERE r.rolname = current_user
    `;
    expect(roles[INTEGRATION_PROCESSOR_INDEX_FIRST]?.rolsuper).toBe(false);
    expect(roles[INTEGRATION_PROCESSOR_INDEX_FIRST]?.rolbypassrls).toBe(false);

    const payload = parseStreamMessage(streamFields());
    await buildRepository(tenantAId).upsertEventWithUsageLine(payload);

    // An unscoped raw read — no application predicate at all, so only RLS can filter it.
    const withoutContext = await app.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Event"
    `;
    expect(withoutContext).toHaveLength(INTEGRATION_PROCESSOR_COUNTS.NONE);

    const withContext = await app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantAId}, true)`;

      return tx.$queryRaw<Array<{ id: string; tenantId: string }>>`
        SELECT "id", "tenantId" FROM "Event"
      `;
    });
    expect(withContext.map((row) => row.id)).toContain(payload.event.eventId);
    expect(withContext.every((row) => row.tenantId === tenantAId)).toBe(true);
  });

  it("I21 - a payload carrying another tenant's id is stored under the repository's own tenant", async () => {
    // The database-level half of `U58`. Both tenants exist, so `Event_tenantId_fkey` is
    // satisfied either way and the only thing that can distinguish the two outcomes is which
    // tenant id the repository writes.
    const payload = parseStreamMessage(
      streamFields({ [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: tenantBId })
    );
    expect(payload.tenantId).toBe(tenantBId);

    await buildRepository(tenantAId).upsertEventWithUsageLine(payload);

    // Read past RLS, so "stored under A" is a fact about the row rather than about what this
    // connection can see.
    const event = await admin.event.findUnique({ where: { id: payload.event.eventId } });
    expect(event?.tenantId).toBe(tenantAId);
    const usageLine = await admin.usageLine.findUnique({
      where: { eventId: payload.event.eventId }
    });
    expect(usageLine?.tenantId).toBe(tenantAId);
    // And nothing landed under the tenant the message named.
    expect(
      await admin.event.count({ where: { id: payload.event.eventId, tenantId: tenantBId } })
    ).toBe(INTEGRATION_PROCESSOR_COUNTS.NONE);
  });

  it("I22 - an offset-bearing occurredAt reaches both columns as the same instant as the Z form, on a non-UTC session", async () => {
    // Its **own** connection, with the session zone pinned rather than inherited. On CI the
    // server is UTC; on this host the default is `Asia/Kolkata` (`pg_settings`, source
    // `configuration file`). Pinning makes the case run the same way on both.
    //
    // What the pin does **not** do is make this case catch today's mutation. Measured at the
    // Gate-5 review: with the pin set to UTC, the discarded-offset mutation still reddens `I22`
    // identically, because the failure comes from the JavaScript side -- the ORM binds an
    // absolute instant against a naive column, and that is zone-independent. The pin is here so
    // this case already runs under a non-UTC session where a *future* raw-SQL cast would be
    // caught: the S-18 shape worker-service is exposed to for want of a `TimeZone` pin in
    // `withTenant` (S-19). See `INTEGRATION_PROCESSOR_SESSION_TIME_ZONE`'s docstring, which
    // states this precisely; an earlier revision of this comment claimed a case taking whichever
    // zone it was given "would assert nothing on one of the two", which is false for this case
    // and contradicted the constant it imports (QA-2).
    const pinned = new PrismaClient({
      datasourceUrl: `${requireEnv("DATABASE_URL")}${INTEGRATION_PROCESSOR_SESSION_TIME_ZONE.URL_SUFFIX}`
    });

    try {
      // The pin is asserted, not hoped for: `CLAUDE.md` records that a bare `?timezone=` is
      // accepted and silently ignored, so a case whose pin failed would still pass and would
      // still look like evidence.
      const sessionZone = await pinned.$queryRawUnsafe<Array<{ TimeZone: string }>>(
        INTEGRATION_PROCESSOR_SESSION_TIME_ZONE.SHOW_TIMEZONE
      );
      expect(sessionZone[INTEGRATION_PROCESSOR_INDEX_FIRST]?.TimeZone).toBe(
        INTEGRATION_PROCESSOR_SESSION_TIME_ZONE.NON_UTC
      );

      const stored: string[] = [];
      for (const occurredAt of [
        INTEGRATION_PROCESSOR_EVENT.OCCURRED_AT_ISO,
        ...OCCURRED_AT_OFFSET_FORMS
      ]) {
        const payload = parseStreamMessage(
          streamFields({ [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT]: occurredAt })
        );
        await new EventRepository(pinned, tenantAId as TenantId, silentLogger)
          .upsertEventWithUsageLine(payload);

        // `::text` off the column, read through the owner connection, so what is compared is
        // what PostgreSQL stored — not the ORM's rendering of it, which would resolve any
        // difference back to the same `Date` and hide it.
        const rows = await admin.$queryRaw<
          Array<{ occurredAt: string; periodStart: string; periodEnd: string }>
        >`
          SELECT e."occurredAt"::text AS "occurredAt",
                 u."periodStart"::text AS "periodStart",
                 u."periodEnd"::text AS "periodEnd"
          FROM "Event" e JOIN "UsageLine" u ON u."eventId" = e."id"
          WHERE e."id" = ${payload.event.eventId}
        `;
        const row = rows[INTEGRATION_PROCESSOR_INDEX_FIRST];
        expect(row, occurredAt).toBeDefined();
        // D2 makes all three the event instant, so all three have to agree for any one of them
        // to be trustworthy.
        expect(row?.periodStart, occurredAt).toBe(row?.occurredAt);
        expect(row?.periodEnd, occurredAt).toBe(row?.occurredAt);
        stored.push(String(row?.occurredAt));
      }

      // The `Z` form and both offset forms name one instant, so all three columns must hold one
      // value. Compared against each other rather than against a literal: the assertion is
      // *agreement*, and a shared literal would let a uniform shift pass.
      expect(new Set(stored).size, stored.join(" | ")).toBe(
        INTEGRATION_PROCESSOR_COUNTS.SINGLE
      );
    } finally {
      await pinned.$disconnect();
    }
  });

  it("I20 - a Decimal(18,6) quantity survives to both columns exactly, and leaves as a string", async () => {
    const payload = parseStreamMessage(streamFields());

    const result = await buildRepository(tenantAId).upsertEventWithUsageLine(payload);

    // `quantity::text` rather than the ORM's value: the mutation this guards against is binding
    // the quantity as a JS `number`, which stores `12345678901.123460` — a difference the
    // column kept and a `Decimal`-to-`Decimal` comparison in JS could round away.
    expect(await readEventQuantityText(payload.event.eventId)).toBe(
      INTEGRATION_PROCESSOR_QUANTITY.FULL_PRECISION
    );
    expect(await readUsageLineQuantityText(payload.event.eventId)).toBe(
      INTEGRATION_PROCESSOR_QUANTITY.FULL_PRECISION
    );
    // Normalised in exactly one layer: nothing above the repository ever holds a
    // `Prisma.Decimal` (`CLAUDE.md` § Prisma).
    expect(result.quantity).toBe(INTEGRATION_PROCESSOR_QUANTITY.FULL_PRECISION);
    expect(typeof result.quantity).toBe("string");
  });
});

describe("EventProcessorService through the consumer loop (live Postgres + Redis db 14)", () => {
  /**
   * Runs the real `StreamConsumer` with the real processor against a per-case stream, until
   * `expected` entries have been through the handler or the deadline passes.
   *
   * The handler is wrapped only to *count*, and it rethrows, so `dispatch` still sees a failure
   * and still logs it. Swallowing here would make `I18` assert the opposite of its subject.
   */
  const runLoopOver = async (
    streamName: string,
    groupName: string,
    expected: number
  ): Promise<{ seen: string[]; logger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>> }> => {
    const env = {
      REDIS_STREAM_NAME: streamName,
      REDIS_CONSUMER_GROUP: groupName,
      REDIS_CONSUMER_NAME: INTEGRATION_PROCESSOR_REDIS.CONSUMER_NAME,
      STREAM_BLOCK_MS: INTEGRATION_LOOP.BLOCK_MS_SHORT,
      STREAM_BATCH_SIZE: INTEGRATION_LOOP.BATCH_SIZE_SMALL
    } as ServiceEnv;

    const processorRedis = new RedisClient(reservedDbUrl, {
      connectionName: INTEGRATION_REDIS.CLIENT_NAME
    });
    const logger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>> = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn()
    };
    const processor = new EventProcessorService(
      processorRedis,
      logger as unknown as Logger,
      env,
      (tenantId) => new EventRepository(app, tenantId, silentLogger)
    );

    const seen: string[] = [];
    const inner = processor.buildHandler();
    const countingHandler: StreamMessageHandler = async (id, fields) => {
      try {
        await inner(id, fields);
      } finally {
        seen.push(id);
      }
    };

    const deadline = Date.now() + INTEGRATION_LOOP.RUN_DEADLINE_MS;
    const consumer = new StreamConsumer(
      processorRedis,
      logger as unknown as Logger,
      env,
      () => seen.length >= expected || Date.now() >= deadline,
      countingHandler
    );

    try {
      await consumer.ensureConsumerGroup();
      await consumer.run();
    } finally {
      await consumer.stop();
      processorRedis.disconnect();
    }

    return { seen, logger };
  };

  const addEntry = async (streamName: string, fields: string[]): Promise<string> => {
    const id = await redis.xadd(
      streamName,
      INTEGRATION_REDIS_COMMANDS.XADD_AUTO_ID,
      ...(fields as [string, ...string[]])
    );
    if (id === null) {
      throw new Error(`XADD returned null for ${streamName}`);
    }

    return id;
  };

  /** `XPENDING <key> <group> - + <count>` — the extended form, which returns entry ids. */
  const readPendingIds = async (streamName: string, groupName: string): Promise<string[]> => {
    const reply = (await redis.xpending(
      streamName,
      groupName,
      INTEGRATION_LOOP_COMMANDS.XPENDING_MIN_ID,
      INTEGRATION_LOOP_COMMANDS.XPENDING_MAX_ID,
      INTEGRATION_PROCESSOR_PENDING_PAGE_SIZE
    )) as Array<[string, string, number, number]> | null;

    return (reply ?? []).map(([id]) => id);
  };

  it("I17 - a processed entry stops being pending, and both rows are stored", async () => {
    const { streamName, groupName } = nextFixtureNames();
    // The group has to exist before the entry is added, or `$` skips it — the property `I5`
    // pins for T-038.
    await new StreamConsumer(
      redis,
      silentLogger,
      { REDIS_STREAM_NAME: streamName, REDIS_CONSUMER_GROUP: groupName } as ServiceEnv,
      () => false
    ).ensureConsumerGroup();

    const fields = streamFields();
    const payload = parseStreamMessage(fields);
    const entryId = await addEntry(streamName, fields);

    const { seen } = await runLoopOver(
      streamName,
      groupName,
      INTEGRATION_PROCESSOR_COUNTS.SINGLE
    );

    expect(seen).toContain(entryId);
    // The acknowledgement, observed as its effect on the server rather than as a spy call.
    expect(await readPendingIds(streamName, groupName)).toEqual([]);
    expect(await admin.event.count({ where: { id: payload.event.eventId } })).toBe(
      INTEGRATION_PROCESSOR_COUNTS.SINGLE
    );
    expect(await admin.usageLine.count({ where: { eventId: payload.event.eventId } })).toBe(
      INTEGRATION_PROCESSOR_COUNTS.SINGLE
    );
  });

  it("I18 - an entry whose transaction fails is not acknowledged: it stays pending and is logged", async () => {
    const { streamName, groupName } = nextFixtureNames();
    await new StreamConsumer(
      redis,
      silentLogger,
      { REDIS_STREAM_NAME: streamName, REDIS_CONSUMER_GROUP: groupName } as ServiceEnv,
      () => false
    ).ensureConsumerGroup();

    // A syntactically valid UUID with no `Tenant` row behind it. `Event_tenantId_fkey` rejects
    // the insert, so the transaction fails *after* the message parsed cleanly — which is the
    // failure this case needs, rather than a parse rejection.
    const fields = streamFields({
      [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]:
        INTEGRATION_PROCESSOR_EVENT.UNKNOWN_TENANT_ID
    });
    const payload = parseStreamMessage(fields);
    const entryId = await addEntry(streamName, fields);

    const { seen, logger } = await runLoopOver(
      streamName,
      groupName,
      INTEGRATION_PROCESSOR_COUNTS.SINGLE
    );

    expect(seen).toContain(entryId);
    // Still pending — nothing acknowledged it, so it will be redelivered rather than lost.
    // This is the contract T-039's D2-A left open, and the epic's "on failure, leave in PEL".
    expect(await readPendingIds(streamName, groupName)).toEqual([entryId]);
    // And nothing was half-written.
    expect(await admin.event.count({ where: { id: payload.event.eventId } })).toBe(
      INTEGRATION_PROCESSOR_COUNTS.NONE
    );
    expect(await admin.usageLine.count({ where: { eventId: payload.event.eventId } })).toBe(
      INTEGRATION_PROCESSOR_COUNTS.NONE
    );
    // `dispatch` logged it against the entry id, and continued rather than ending the loop.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ entryId }),
      // Imported rather than written out, unlike `stream.consumer.unit.test.ts`'s deliberate
      // literal. The wording is not this case's subject -- `U29` owns that, and pins it against
      // a test-local copy precisely so the assertion is not sourced from the constant the
      // subject writes. Here the message only selects the right log line among several, so
      // sourcing it from the constant costs nothing and removes the third copy the constants
      // rule flagged.
      WORKER_STREAM_READ.LOG.HANDLER_FAILED
    );
  });
});
