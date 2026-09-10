import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import RedisClient from "ioredis";
import type Redis from "ioredis";
import type { Logger } from "pino";
import type { ServiceEnv } from "../src/config/env";
import { WORKER_CONSUMER_GROUP_BOOTSTRAP } from "../src/constants";
import { StreamConsumer } from "../src/events/stream.consumer";
import {
  INTEGRATION_CONCURRENCY,
  INTEGRATION_COUNTS,
  INTEGRATION_FIELD_PAIR_STRIDE,
  INTEGRATION_FIXTURE,
  INTEGRATION_KEY_EXISTS,
  INTEGRATION_KEY_TYPE_STREAM,
  INTEGRATION_REDIS,
  INTEGRATION_REDIS_COMMANDS,
  INTEGRATION_REDIS_URL_FALLBACK,
  INTEGRATION_XINFO_FIELDS
} from "./integration.constants";

/**
 * Live-Redis suite for T-038's consumer-group bootstrap.
 *
 * Proves what a mocked client cannot: that the group genuinely appears in `XINFO GROUPS`,
 * that a repeat bootstrap leaves the group's cursor and pending list untouched, and that the
 * group is created at `$` so a pre-existing backlog is not delivered. These are facts about
 * Redis' response to a command, not about the argument vector, and only a live server has
 * them.
 *
 * A narrower claim than an earlier revision made. That revision said a mock "cannot
 * distinguish `CREATE` from `SETID`"; measured, it can, in both mutation shapes tried:
 *
 *   add `xgroup("SETID", ...)` to the already-exists branch
 *     -> unit U2 red ("expected \"spy\" to be called 1 times, but got 2 times")
 *     -> integration I3 red (last-delivered-id '...804-0' -> '...804-1')
 *   replace `CREATE ... MKSTREAM` with `SETID`
 *     -> unit U1 red (argument-vector assertion)
 *     -> integration I1-I5 all red
 *
 * So the unit suite catches the *call*; I3 is still the only case that measures the
 * *effect* — that re-issuing `CREATE` really does leave `last-delivered-id` and `pending`
 * where they were. That is the part no mock can assert without restating Redis' semantics
 * back to itself.
 *
 * Runs on logical database 14 — see `INTEGRATION_REDIS.LOGICAL_DB_INDEX` for why not 0 and
 * why not 15. It connects its own client rather than building the Fastify app, so nothing
 * here can touch the connection the rest of the suite uses.
 */

const RUN_ID = `${process.pid}-${Date.now()}`;
let redis: Redis;
/**
 * The connection string, pinned to the reserved logical database, that every client in this
 * file is opened from. Built once in `beforeAll` so `I6`'s additional connections cannot
 * resolve a different index than the one `flushReservedDb()` guards.
 */
let reservedDbUrl = "";
let caseIndex = INTEGRATION_COUNTS.NONE;

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  warn: () => undefined
} as unknown as Logger;

/** A stream key and group name unique to one case, so cases cannot interfere. */
const nextFixtureNames = (): { streamName: string; groupName: string } => {
  caseIndex += INTEGRATION_COUNTS.SINGLE;

  return {
    streamName: `${INTEGRATION_REDIS.STREAM_NAME_PREFIX}${RUN_ID}-${caseIndex}`,
    groupName: `${INTEGRATION_REDIS.CONSUMER_GROUP_PREFIX}${RUN_ID}-${caseIndex}`
  };
};

const buildConsumer = (streamName: string, groupName: string): StreamConsumer =>
  new StreamConsumer(redis, silentLogger, {
    REDIS_STREAM_NAME: streamName,
    REDIS_CONSUMER_GROUP: groupName
  } as ServiceEnv);

const addEntry = async (streamName: string, value: string): Promise<string> => {
  const id = await redis.xadd(
    streamName,
    INTEGRATION_REDIS_COMMANDS.XADD_AUTO_ID,
    INTEGRATION_FIXTURE.FIELD_NAME,
    value
  );
  if (id === null) {
    throw new Error(`XADD returned null for ${streamName}`);
  }

  return id;
};

/** `XINFO GROUPS` replies as one flat field/value array per group; reshape to records. */
const readGroups = async (streamName: string): Promise<Array<Record<string, unknown>>> => {
  const reply = (await redis.xinfo(
    INTEGRATION_REDIS_COMMANDS.XINFO_GROUPS,
    streamName
  )) as unknown[];

  return reply.map((group) => {
    const flat = group as unknown[];
    const record: Record<string, unknown> = {};
    for (let index = 0; index < flat.length; index += INTEGRATION_FIELD_PAIR_STRIDE) {
      record[String(flat[index])] = flat[index + INTEGRATION_COUNTS.SINGLE];
    }

    return record;
  });
};

/** Throws rather than returning undefined, so a missing group cannot pass vacuously. */
const readOnlyGroup = async (streamName: string): Promise<Record<string, unknown>> => {
  const groups = await readGroups(streamName);
  expect(groups).toHaveLength(INTEGRATION_COUNTS.SINGLE);
  const only = groups[INTEGRATION_COUNTS.NONE];
  if (!only) {
    throw new Error(`no consumer group on ${streamName}`);
  }

  return only;
};

/** Entry ids `XREADGROUP ... >` delivers, flattened out of the stream/entry nesting. */
const readNewEntryIds = async (
  streamName: string,
  groupName: string,
  count: number
): Promise<string[]> => {
  const reply = (await redis.xreadgroup(
    INTEGRATION_REDIS_COMMANDS.XREADGROUP_GROUP,
    groupName,
    INTEGRATION_REDIS.CONSUMER_NAME,
    INTEGRATION_REDIS_COMMANDS.XREADGROUP_COUNT,
    count,
    INTEGRATION_REDIS_COMMANDS.XREADGROUP_STREAMS,
    streamName,
    INTEGRATION_REDIS_COMMANDS.XREADGROUP_NEW_ENTRIES
  )) as Array<[string, Array<[string, string[]]>]> | null;

  if (reply === null) {
    return [];
  }

  return reply.flatMap(([, entries]) => entries.map(([id]) => id));
};

/**
 * The only place this suite issues `FLUSHDB`, and it re-establishes the reserved-index
 * invariant on every call rather than once.
 *
 * A single pre-flush assertion in `beforeAll` is **not** enough, and the mutation that shows
 * it: replace the expected string with one `CLIENT INFO` cannot contain, seed a sentinel key
 * into db 14, and run the suite. Observed on this repo's vitest 2.1.9 —
 * `Test Files 1 failed (1) / Tests 6 skipped (6)`, and `redis-cli -n 14 DBSIZE` still went
 * 1 -> 0. Vitest runs `afterAll` even when `beforeAll` throws, so the guarded flush was
 * skipped and the unguarded teardown flush ran anyway. With this helper the same mutation
 * leaves the sentinel in place.
 *
 * Scope of that claim, stated as measured: every flush *routed through here* is guarded. A
 * future bare `redis.flushdb()` elsewhere in the file would not be — nothing in the type
 * system prevents one, so this is a single chokepoint, not an impossibility proof.
 *
 * The `!redis` branch is a runtime backstop, not dead code: if `new RedisClient(...)` throws,
 * `redis` is never assigned and the teardown hooks still run. Without it they fail with a
 * `TypeError` that hides the real cause.
 */
const flushReservedDb = async (): Promise<void> => {
  if (!redis) {
    throw new Error("Redis client was never constructed; refusing to FLUSHDB");
  }
  expect(await redis.call("CLIENT", "INFO")).toContain(
    `db=${INTEGRATION_REDIS.LOGICAL_DB_INDEX}`
  );
  await redis.flushdb();
};

beforeAll(async () => {
  const redisUrl = new URL(process.env.REDIS_URL ?? INTEGRATION_REDIS_URL_FALLBACK);
  redisUrl.pathname = `/${INTEGRATION_REDIS.LOGICAL_DB_INDEX}`;
  reservedDbUrl = redisUrl.toString();
  redis = new RedisClient(reservedDbUrl);
  await flushReservedDb();
});

afterEach(async () => {
  await flushReservedDb();
});

afterAll(async () => {
  // `quit()` in `finally` so a guard failure is still reported *and* the socket still closes.
  // Without it, the throw skips teardown and leaves a connection open on the failure path.
  try {
    await flushReservedDb();
  } finally {
    await redis?.quit();
  }
});

describe("StreamConsumer.ensureConsumerGroup (live Redis)", () => {
  it("I1 - creates the group on a stream that has none", async () => {
    const { streamName, groupName } = nextFixtureNames();

    await buildConsumer(streamName, groupName).ensureConsumerGroup();

    const group = await readOnlyGroup(streamName);
    expect(group[INTEGRATION_XINFO_FIELDS.NAME]).toBe(groupName);
  });

  it("I2 - is idempotent: a second bootstrap resolves and leaves one group", async () => {
    const { streamName, groupName } = nextFixtureNames();
    const consumer = buildConsumer(streamName, groupName);

    await consumer.ensureConsumerGroup();
    await expect(consumer.ensureConsumerGroup()).resolves.toBeUndefined();

    const group = await readOnlyGroup(streamName);
    expect(group[INTEGRATION_XINFO_FIELDS.NAME]).toBe(groupName);
  });

  it("I3 - a repeat bootstrap moves neither the cursor nor the pending list", async () => {
    const { streamName, groupName } = nextFixtureNames();
    const consumer = buildConsumer(streamName, groupName);
    await consumer.ensureConsumerGroup();

    await addEntry(streamName, INTEGRATION_FIXTURE.VALUE_FIRST);
    await addEntry(streamName, INTEGRATION_FIXTURE.VALUE_SECOND);
    const delivered = await readNewEntryIds(
      streamName,
      groupName,
      INTEGRATION_COUNTS.SINGLE
    );
    expect(delivered).toHaveLength(INTEGRATION_COUNTS.SINGLE);

    const before = await readOnlyGroup(streamName);
    expect(before[INTEGRATION_XINFO_FIELDS.PENDING]).toBe(INTEGRATION_COUNTS.SINGLE);

    await consumer.ensureConsumerGroup();

    const after = await readOnlyGroup(streamName);
    // The `SETID` guard. Re-issuing CREATE was observed to leave both fields untouched;
    // swapping CREATE for `XGROUP SETID ... $` moved `last-delivered-id` on this fixture.
    expect(after[INTEGRATION_XINFO_FIELDS.LAST_DELIVERED_ID]).toBe(
      before[INTEGRATION_XINFO_FIELDS.LAST_DELIVERED_ID]
    );
    expect(after[INTEGRATION_XINFO_FIELDS.PENDING]).toBe(
      before[INTEGRATION_XINFO_FIELDS.PENDING]
    );
  });

  it("I4 - MKSTREAM creates the stream key when it does not exist", async () => {
    const { streamName, groupName } = nextFixtureNames();
    expect(await redis.exists(streamName)).toBe(INTEGRATION_KEY_EXISTS.ABSENT);

    await buildConsumer(streamName, groupName).ensureConsumerGroup();

    expect(await redis.exists(streamName)).toBe(INTEGRATION_KEY_EXISTS.PRESENT);
    expect(await redis.type(streamName)).toBe(INTEGRATION_KEY_TYPE_STREAM);
    expect(await redis.xlen(streamName)).toBe(INTEGRATION_COUNTS.NONE);
  });

  it("I5 - the group starts at $, so a pre-bootstrap backlog is never delivered", async () => {
    const { streamName, groupName } = nextFixtureNames();
    const backlogId = await addEntry(
      streamName,
      INTEGRATION_FIXTURE.VALUE_BEFORE_BOOTSTRAP
    );

    await buildConsumer(streamName, groupName).ensureConsumerGroup();

    const freshId = await addEntry(streamName, INTEGRATION_FIXTURE.VALUE_AFTER_BOOTSTRAP);
    const delivered = await readNewEntryIds(streamName, groupName, INTEGRATION_COUNTS.PAIR);

    // Negative assertion carries the weight: the backlog id must be *absent*, not merely
    // outnumbered. Asserting only `toContain(freshId)` would pass under a group created at 0.
    expect(delivered).not.toContain(backlogId);
    expect(delivered).toEqual([freshId]);
    // Pins the constant this behaviour depends on, so a change to `START_ID_NEW_ENTRIES_ONLY`
    // fails here with a legible reason rather than only through the delivery assertion.
    expect(WORKER_CONSUMER_GROUP_BOOTSTRAP.START_ID_NEW_ENTRIES_ONLY).toBe("$");
  });

  /**
   * I6 closes QA finding F3, which both review passes missed.
   *
   * Swallowing the already-exists reply instead of taking a lock is this task's central
   * design decision, and its justification is multi-replica startup -- yet before this case
   * nothing exercised more than one caller. `I2` calls twice on one connection, sequentially.
   *
   * **What it proves, and what it does not.** It proves that N independent connections may
   * each run the bootstrap without any of them failing, and that they leave exactly one
   * group: the shape a fleet of replicas starting together produces, and the shape a lock
   * would otherwise be needed for. Removing the already-exists swallow makes it red (see the
   * mutation below). It does **not** prove anything about the *interleaving* Redis chose --
   * the calls are dispatched in one tick, but a fully serialized execution would still leave
   * 1 `OK` and N-1 already-exists replies, so the case would be red under that mutation
   * either way. That is the honest scope: the guard is on the losing racer's outcome, not on
   * the concurrency itself.
   *
   * Mutation that establishes redness, measured rather than asserted: delete the
   * `error.message.startsWith(ALREADY_EXISTS_ERROR_PREFIX)` branch's `return` path from
   * `src/events/stream.consumer.ts` so every reply rethrows.
   *
   * Hygiene: these clients only ever `XGROUP CREATE`. Every `FLUSHDB` in this file stays on
   * the suite's own client, through `flushReservedDb()`.
   */
  it("I6 - concurrent bootstraps from independent connections all resolve, leaving one group", async () => {
    const { streamName, groupName } = nextFixtureNames();
    const clients: Redis[] = Array.from(
      { length: INTEGRATION_CONCURRENCY.BOOTSTRAP_CLIENTS },
      () => new RedisClient(reservedDbUrl)
    );

    try {
      // Each additional connection writes to the reserved index, so each is checked against
      // it. This is a write-side sanity check on the URL, not a flush guard -- no client here
      // issues `FLUSHDB`.
      for (const client of clients) {
        expect(await client.call("CLIENT", "INFO")).toContain(
          `db=${INTEGRATION_REDIS.LOGICAL_DB_INDEX}`
        );
      }

      const outcomes = await Promise.allSettled(
        clients.map((client) =>
          new StreamConsumer(client, silentLogger, {
            REDIS_STREAM_NAME: streamName,
            REDIS_CONSUMER_GROUP: groupName
          } as ServiceEnv).ensureConsumerGroup()
        )
      );

      // Mapped to reasons rather than counted, so a failure names the reply that caused it
      // instead of reporting `expected 1 to be 8`.
      const rejections = outcomes
        .filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
        )
        .map((outcome) => String(outcome.reason));
      expect(rejections).toEqual([]);
      expect(outcomes).toHaveLength(INTEGRATION_CONCURRENCY.BOOTSTRAP_CLIENTS);

      // `readOnlyGroup` asserts the count is exactly one and throws if there is none, so a
      // deleted or duplicated group cannot pass here vacuously.
      const group = await readOnlyGroup(streamName);
      expect(group[INTEGRATION_XINFO_FIELDS.NAME]).toBe(groupName);
    } finally {
      // `allSettled`, so one failed close still closes the rest and the socket count returns
      // to what it was.
      await Promise.allSettled(clients.map((client) => client.quit()));
    }
  });
});
