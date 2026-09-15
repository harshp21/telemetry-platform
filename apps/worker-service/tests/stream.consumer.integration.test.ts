import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import RedisClient from "ioredis";
import type Redis from "ioredis";
import type { Logger } from "pino";
import type { ServiceEnv } from "../src/config/env";
import {
  WORKER_CONSUMER_GROUP_BOOTSTRAP,
  WORKER_STREAM_CONSTANTS,
  WORKER_STREAM_READ
} from "../src/constants";
import { StreamConsumer, type StreamMessageHandler } from "../src/events/stream.consumer";
import {
  INTEGRATION_CONCURRENCY,
  INTEGRATION_COUNTS,
  INTEGRATION_FIELD_PAIR_STRIDE,
  INTEGRATION_FIXTURE,
  INTEGRATION_KEY_EXISTS,
  INTEGRATION_KEY_TYPE_STREAM,
  INTEGRATION_LOOP,
  INTEGRATION_LOOP_COMMANDS,
  INTEGRATION_LOOP_FIXTURE,
  INTEGRATION_LOOP_REDIS,
  INTEGRATION_DEAD_LETTER,
  INTEGRATION_REDELIVERY_MIN_COUNT,
  INTEGRATION_REDIS,
  INTEGRATION_REDIS_COMMANDS,
  INTEGRATION_REDIS_URL_FALLBACK,
  INTEGRATION_SHUTDOWN,
  INTEGRATION_SHUTDOWN_FIXTURE,
  INTEGRATION_SHUTDOWN_REDIS,
  INTEGRATION_XINFO_FIELDS,
  INTEGRATION_XPENDING_DELIVERY_COUNT_INDEX
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

/**
 * The shutdown predicate for a consumer constructed only to bootstrap.
 *
 * T-039 made the predicate a required fourth constructor argument so that no site can start
 * a loop with no stop condition by omission; `I1`-`I6` never call `run()`, so what they pass
 * is inert, but they have to declare it. `I7`-`I12` build their own consumers with real
 * predicates.
 */
const NEVER_SHUTTING_DOWN = (): boolean => false;

const buildConsumer = (streamName: string, groupName: string): StreamConsumer =>
  new StreamConsumer(
    redis,
    silentLogger,
    {
      REDIS_STREAM_NAME: streamName,
      REDIS_CONSUMER_GROUP: groupName
    } as ServiceEnv,
    NEVER_SHUTTING_DOWN
  );

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

/**
 * Entry ids `XREADGROUP ... >` delivers, flattened out of the stream/entry nesting.
 *
 * The consumer name is a parameter rather than a constant read from inside, because `I10`
 * needs the entries it seeds to be owned by a consumer *other* than the subject — that is
 * what makes recovery the only path to them. It was
 * `INTEGRATION_REDIS.CONSUMER_NAME` unconditionally until Round 1 (L-2), which left
 * `INTEGRATION_LOOP_REDIS.ABANDONED_CONSUMER_NAME` declared and unread.
 */
const readNewEntryIds = async (
  streamName: string,
  groupName: string,
  count: number,
  consumerName: string
): Promise<string[]> => {
  const reply = (await redis.xreadgroup(
    INTEGRATION_REDIS_COMMANDS.XREADGROUP_GROUP,
    groupName,
    consumerName,
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
  expect(
    await redis.call(INTEGRATION_LOOP_COMMANDS.CLIENT, INTEGRATION_LOOP_COMMANDS.CLIENT_INFO)
  ).toContain(
    `${INTEGRATION_LOOP_COMMANDS.CLIENT_DB_FIELD_PREFIX}${INTEGRATION_REDIS.LOGICAL_DB_INDEX}`
  );
  await redis.flushdb();
};

beforeAll(async () => {
  const redisUrl = new URL(process.env.REDIS_URL ?? INTEGRATION_REDIS_URL_FALLBACK);
  redisUrl.pathname = `/${INTEGRATION_REDIS.LOGICAL_DB_INDEX}`;
  reservedDbUrl = redisUrl.toString();
  redis = new RedisClient(reservedDbUrl, {
    connectionName: INTEGRATION_REDIS.CLIENT_NAME
  });
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
      INTEGRATION_COUNTS.SINGLE,
      INTEGRATION_REDIS.CONSUMER_NAME
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
    const delivered = await readNewEntryIds(
      streamName,
      groupName,
      INTEGRATION_COUNTS.PAIR,
      INTEGRATION_REDIS.CONSUMER_NAME
    );

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
      // Named like the suite client, so `INTEGRATION_REDIS`' docblock claim -- a
      // `connectionName` on every client this suite opens -- is true rather than
      // aspirational, and so these eight rows are attributable in `CLIENT LIST`. They only
      // ever `XGROUP CREATE` and are `quit()`ed below, so they never park on a read and
      // `hasParkedRead` cannot see them; the name is for attribution, not for that helper.
      // Gate-4 Round-2 L-9: these were the eight unnamed clients of nine.
      () => new RedisClient(reservedDbUrl, { connectionName: INTEGRATION_REDIS.CLIENT_NAME })
    );

    try {
      // Each additional connection writes to the reserved index, so each is checked against
      // it. This is a write-side sanity check on the URL, not a flush guard -- no client here
      // issues `FLUSHDB`.
      for (const client of clients) {
        expect(
          await client.call(
            INTEGRATION_LOOP_COMMANDS.CLIENT,
            INTEGRATION_LOOP_COMMANDS.CLIENT_INFO
          )
        ).toContain(
          `${INTEGRATION_LOOP_COMMANDS.CLIENT_DB_FIELD_PREFIX}${INTEGRATION_REDIS.LOGICAL_DB_INDEX}`
        );
      }

      const outcomes = await Promise.allSettled(
        clients.map((client) =>
          new StreamConsumer(
            client,
            silentLogger,
            {
              REDIS_STREAM_NAME: streamName,
              REDIS_CONSUMER_GROUP: groupName
            } as ServiceEnv,
            NEVER_SHUTTING_DOWN
          ).ensureConsumerGroup()
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

/**
 * Live-Redis suite for T-039's read loop and startup recovery.
 *
 * A second `describe` rather than cases inside the bootstrap one, mirroring the unit file:
 * different subject, larger harness. Every constraint the bootstrap block works under still
 * applies and is not restated per case — **logical database 14 only**, **every `FLUSHDB`
 * through `flushReservedDb()`**, per-case unique stream and group names, and never db 0,
 * which must still show `XLEN 2` and zero consumer groups when this file finishes.
 *
 * What only a live server can prove, and what these cases are for:
 *
 *   - that an entry the loop reads is **still pending** afterwards (D2-A). A mock can assert
 *     the absence of an `XACK` call; only Redis can say the entry is actually recoverable.
 *   - that `XAUTOCLAIM` really needs its cursor at a `COUNT` boundary.
 *   - that deleting the stream key really produces the `NOGROUP` the loop repairs.
 *   - that the pre-group backlog is unreachable by *both* paths — the case that keeps the
 *     rest from being written against an assumption that does not hold.
 *   - that `stop()` does not wait out a real multi-second block (`BLOCK_MS_LONG`).
 *
 * Every case ends the loop on a **condition** — the entries it expected arrived — with a
 * deadline behind it, so a loop that fails to make progress fails an assertion instead of
 * hanging the suite.
 */

/**
 * `Array.isArray` narrows `unknown` to `any[]`, which makes every later index access `any`
 * and trips `@typescript-eslint/no-unsafe-return`. Narrowing to `readonly unknown[]` keeps
 * the reply shape checks inside the type system — the same guard `stream.consumer.ts` uses
 * on the replies it parses for real.
 */
const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/** A predicate plus the handler whose progress it watches. */
interface LoopHarness {
  readonly handled: string[];
  readonly handler: StreamMessageHandler;
  readonly isShuttingDown: () => boolean;
}

/**
 * Stops the loop once `expected` entries have reached the handler, or once the deadline
 * passes.
 *
 * The deadline is not a timeout dressed up as a stop condition: it exists so that a loop
 * which never receives what the case expects fails on `handled`, naming the ids it did and
 * did not see, rather than running until vitest kills the file.
 */
const buildLoopHarness = (expected: number): LoopHarness => {
  const handled: string[] = [];
  const deadline = Date.now() + INTEGRATION_LOOP.RUN_DEADLINE_MS;

  return {
    handled,
    handler: (id: string): Promise<void> => {
      handled.push(id);

      return Promise.resolve();
    },
    isShuttingDown: (): boolean => handled.length >= expected || Date.now() >= deadline
  };
};

/** A stream key and group name unique to one T-039 case. Shares the counter with `t038`. */
const nextLoopFixtureNames = (): { streamName: string; groupName: string } => {
  caseIndex += INTEGRATION_COUNTS.SINGLE;

  return {
    streamName: `${INTEGRATION_LOOP_REDIS.STREAM_NAME_PREFIX}${RUN_ID}-${caseIndex}`,
    groupName: `${INTEGRATION_LOOP_REDIS.CONSUMER_GROUP_PREFIX}${RUN_ID}-${caseIndex}`
  };
};

interface LoopConsumerOptions {
  readonly streamName: string;
  readonly groupName: string;
  readonly isShuttingDown: () => boolean;
  readonly handler: StreamMessageHandler;
  readonly blockMs?: number;
  readonly batchSize?: number;
  /**
   * The identity the consumer reads and deregisters under (T-043).
   *
   * Optional with the T-039 default, so no existing case changes. The shutdown cases set it
   * explicitly, because T-043 makes the *production* default `<hostname>-<pid>` — which differs
   * per host and per run, and which two cases in one process would share.
   */
  readonly consumerName?: string;
}

/**
 * A consumer wired for the loop cases.
 *
 * Built on the suite's own client, which the consumer then `duplicate()`s for its read. The
 * duplicate inherits the logical database — `CLIENT INFO` on one reported `db=14` — so the
 * reserved-index invariant covers the read connection without the case doing anything.
 */
const buildLoopConsumer = (options: LoopConsumerOptions): StreamConsumer =>
  new StreamConsumer(
    redis,
    silentLogger,
    {
      REDIS_STREAM_NAME: options.streamName,
      REDIS_CONSUMER_GROUP: options.groupName,
      REDIS_CONSUMER_NAME: options.consumerName ?? INTEGRATION_LOOP_REDIS.CONSUMER_NAME,
      STREAM_BLOCK_MS: options.blockMs ?? INTEGRATION_LOOP.BLOCK_MS_SHORT,
      STREAM_BATCH_SIZE: options.batchSize ?? WORKER_STREAM_CONSTANTS.DEFAULT_BATCH_SIZE
    } as ServiceEnv,
    options.isShuttingDown,
    options.handler
  );

/** `XADD` under a named fixture value, returning the id. */
const addLoopEntry = async (streamName: string, value: string): Promise<string> =>
  addEntry(streamName, value);

/**
 * Ids currently in the group's pending list, via the extended
 * `XPENDING <key> <group> - + <count>` form.
 *
 * Throws on a reply it does not recognise rather than returning `[]`: an empty array is the
 * assertion several cases make, so a parse failure that produced one would pass them
 * vacuously.
 */
const readPendingIds = async (
  streamName: string,
  groupName: string,
  count: number
): Promise<string[]> => {
  const reply: unknown = await redis.xpending(
    streamName,
    groupName,
    INTEGRATION_LOOP_COMMANDS.XPENDING_MIN_ID,
    INTEGRATION_LOOP_COMMANDS.XPENDING_MAX_ID,
    count
  );
  if (!isUnknownArray(reply)) {
    throw new Error(`XPENDING returned a non-array reply for ${streamName}`);
  }

  return reply.map((row: unknown) => {
    if (!isUnknownArray(row)) {
      throw new Error(`XPENDING row was not an array for ${streamName}`);
    }

    const id = row[INTEGRATION_COUNTS.NONE];
    if (typeof id !== "string") {
      throw new Error(`XPENDING row was not [id, consumer, idle, deliveries] for ${streamName}`);
    }

    return id;
  });
};

/**
 * Whether one of **this suite's own** connections is parked on a blocking read.
 *
 * `CLIENT LIST` is server-wide: it is not scoped to the reserved logical database, and the
 * previous body — `list.includes("cmd=xreadgroup")` — was therefore satisfied by any parked
 * read anywhere on the server. Measured with a blocking `XREADGROUP` held on database 13 and
 * nothing parked on 14: the old predicate returned `true`, and `CLIENT LIST | grep
 * cmd=xreadgroup` showed a single row carrying `db=13` (Round 1, M-3). A worker-service dev
 * process parked on `XREADGROUP BLOCK 5000` — the steady state this very task ships — is
 * exactly that condition, so `I12` would have satisfied its wait on the first poll and
 * `stop()`ed before its own read was parked, measuring nothing.
 *
 * Demonstrated at suite level, not only at the shell: with that foreign read held on database
 * 13 and the old one-line body restored, `I12` failed in 13 ms on the
 * `expect(await hasParkedRead()).toBe(false)` below (`expected true to be false`); with this
 * body and the same read still parked, the file passed 12/12.
 *
 * The fix requires the connection **name** and the blocked command on the same row. The name
 * is narrower than `db=14`, which is a convention no mechanism enforces (S-22, S-25): the only
 * executable `connectionName` in the repository is this suite's own client
 * (`grep -rn connectionName apps packages --include=*.ts`, discounting comments and `dist/`),
 * and `duplicate()` inherits it — so the read connection the subject opens for itself is
 * covered without the subject knowing the name exists.
 *
 * Scope, stated as measured: this discriminates rows, and the row format was checked —
 * `name=` and `cmd=` appear on the same line, and `CLIENT LIST` separates connections by
 * newline. It is not a claim that no *other* process could ever set the same
 * `connectionName`.
 */
const hasParkedRead = async (): Promise<boolean> => {
  const list = String(
    await redis.call(INTEGRATION_LOOP_COMMANDS.CLIENT, INTEGRATION_LOOP_COMMANDS.CLIENT_LIST)
  );

  return list
    .split(INTEGRATION_LOOP_COMMANDS.CLIENT_LIST_ROW_SEPARATOR)
    .some(
      (row) =>
        row.includes(
          `${INTEGRATION_LOOP_COMMANDS.CLIENT_NAME_FIELD_PREFIX}${INTEGRATION_REDIS.CLIENT_NAME}`
        ) && row.includes(INTEGRATION_LOOP_COMMANDS.CLIENT_LIST_BLOCKED_READ)
    );
};

/** Sleeps, so seeded entries age past the reclaim threshold. */
/**
 * `XPENDING <key> <group> - + <count>`, keeping the **delivery count** column.
 *
 * `readPendingIds` above discards it; `I23` is the one case whose subject is that the count
 * went up, so it needs the whole row. Throws on any reply it does not recognise, for the reason
 * that helper's docstring gives: an empty result is an assertion several cases make, so a parse
 * failure that produced one would pass vacuously.
 */
const readPendingDeliveryCounts = async (
  streamName: string,
  groupName: string,
  count: number
): Promise<Map<string, number>> => {
  const reply: unknown = await redis.xpending(
    streamName,
    groupName,
    INTEGRATION_LOOP_COMMANDS.XPENDING_MIN_ID,
    INTEGRATION_LOOP_COMMANDS.XPENDING_MAX_ID,
    count
  );
  if (!isUnknownArray(reply)) {
    throw new Error(`XPENDING returned a non-array reply for ${streamName}`);
  }

  const counts = new Map<string, number>();
  for (const row of reply) {
    if (!isUnknownArray(row)) {
      throw new Error(`XPENDING row was not an array for ${streamName}`);
    }

    const id = row[INTEGRATION_COUNTS.NONE];
    const delivered = row[INTEGRATION_XPENDING_DELIVERY_COUNT_INDEX];
    if (typeof id !== "string" || typeof delivered !== "number") {
      throw new Error(
        `XPENDING row was not [id, consumer, idle, deliveries] for ${streamName}`
      );
    }

    counts.set(id, delivered);
  }

  return counts;
};

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("StreamConsumer.run (live Redis)", () => {
  it("I7 - delivers entries to the handler and leaves them pending", async () => {
    const { streamName, groupName } = nextLoopFixtureNames();
    const harness = buildLoopHarness(INTEGRATION_COUNTS.PAIR);
    const consumer = buildLoopConsumer({ streamName, groupName, ...harness });
    await consumer.ensureConsumerGroup();
    const firstId = await addLoopEntry(streamName, INTEGRATION_LOOP_FIXTURE.VALUE_DELIVERED);
    const secondId = await addLoopEntry(
      streamName,
      INTEGRATION_LOOP_FIXTURE.VALUE_SECOND_DELIVERED
    );

    await consumer.run();

    expect(harness.handled).toEqual([firstId, secondId]);
    // The half a mock cannot prove (D2-A). Nothing acknowledged them, so Redis still holds
    // them for redelivery — which is what makes it safe to run this loop before T-040 exists.
    // Asserted against the ids, not a count: a pending list of the right size holding the
    // wrong entries would pass a count.
    expect(await readPendingIds(streamName, groupName, INTEGRATION_COUNTS.PAIR)).toEqual([
      firstId,
      secondId
    ]);
  });

  it("I8 - survives a read timeout on an empty stream and keeps consuming afterwards", async () => {
    const { streamName, groupName } = nextLoopFixtureNames();
    let timeouts = INTEGRATION_COUNTS.NONE;
    const idleHandled: string[] = [];
    const idleConsumer = buildLoopConsumer({
      streamName,
      groupName,
      handler: (id: string): Promise<void> => {
        idleHandled.push(id);

        return Promise.resolve();
      },
      // Two full block windows against an empty stream, counted by the predicate itself.
      isShuttingDown: (): boolean => {
        const stop = timeouts >= INTEGRATION_COUNTS.PAIR;
        timeouts += INTEGRATION_COUNTS.SINGLE;

        return stop;
      }
    });
    await idleConsumer.ensureConsumerGroup();

    await expect(idleConsumer.run()).resolves.toBeUndefined();

    expect(idleHandled).toEqual([]);
    expect(await readPendingIds(streamName, groupName, INTEGRATION_COUNTS.PAIR)).toEqual([]);

    // The assertion that makes this more than "it did not throw": a fresh consumer on the
    // same group still gets the next entry. A timeout that had poisoned the group or the
    // cursor would show up here rather than above.
    const harness = buildLoopHarness(INTEGRATION_COUNTS.SINGLE);
    const resumed = buildLoopConsumer({ streamName, groupName, ...harness });
    const deliveredId = await addLoopEntry(
      streamName,
      INTEGRATION_LOOP_FIXTURE.VALUE_AFTER_TIMEOUT
    );

    await resumed.run();

    expect(harness.handled).toEqual([deliveredId]);
  });

  it("I9 - neither the loop nor recovery ever delivers the pre-group backlog", async () => {
    const { streamName, groupName } = nextLoopFixtureNames();
    // Two entries before the group exists, reproducing the shape of the live
    // `telemetry:events`: entries that predate the group and were never delivered to anyone.
    const firstBacklogId = await addLoopEntry(
      streamName,
      INTEGRATION_LOOP_FIXTURE.VALUE_BACKLOG
    );
    const secondBacklogId = await addLoopEntry(
      streamName,
      INTEGRATION_LOOP_FIXTURE.VALUE_BACKLOG
    );
    const harness = buildLoopHarness(INTEGRATION_COUNTS.SINGLE);
    const consumer = buildLoopConsumer({ streamName, groupName, ...harness });
    await consumer.ensureConsumerGroup();
    const freshId = await addLoopEntry(streamName, INTEGRATION_LOOP_FIXTURE.VALUE_AFTER_GROUP);

    // `run()` performs the `XAUTOCLAIM` recovery pass *and* the read, so one call exercises
    // both paths against the same backlog.
    await consumer.run();

    // This case exists because the obvious way to write a recovery test is to expect it to
    // pick the backlog up, and that test passes while asserting nothing. Measured four ways
    // on this shape: `XAUTOCLAIM` from `0-0` returns `["0-0",[],[]]` immediately after group
    // creation and again after the group has history; `XREADGROUP ... STREAMS <s> 0` returns
    // the non-null empty `[[stream,[]]]`; only `XGROUP SETID <s> <g> 0` followed by `>` ever
    // delivers them. Never-delivered entries are not in the pending list, and `XAUTOCLAIM`
    // walks only the pending list.
    expect(harness.handled).not.toContain(firstBacklogId);
    expect(harness.handled).not.toContain(secondBacklogId);
    expect(harness.handled).toEqual([freshId]);

    const pending = await readPendingIds(streamName, groupName, INTEGRATION_COUNTS.PAIR);
    expect(pending).not.toContain(firstBacklogId);
    expect(pending).not.toContain(secondBacklogId);
    expect(pending).toEqual([freshId]);
    // The backlog is still on the stream — unreachable, not consumed or trimmed.
    expect(await redis.xlen(streamName)).toBe(
      INTEGRATION_COUNTS.PAIR + INTEGRATION_COUNTS.SINGLE
    );
  });

  it("I10 - reclaims a pending list larger than COUNT, paginating past the boundary", async () => {
    const { streamName, groupName } = nextLoopFixtureNames();
    const harness = buildLoopHarness(INTEGRATION_LOOP.ABANDONED_ENTRY_COUNT);
    const consumer = buildLoopConsumer({
      streamName,
      groupName,
      ...harness,
      batchSize: INTEGRATION_LOOP.BATCH_SIZE_SMALL
    });
    await consumer.ensureConsumerGroup();

    const abandonedIds: string[] = [];
    for (let index = INTEGRATION_COUNTS.NONE; index < INTEGRATION_LOOP.ABANDONED_ENTRY_COUNT; index += INTEGRATION_COUNTS.SINGLE) {
      abandonedIds.push(
        await addLoopEntry(streamName, INTEGRATION_LOOP_FIXTURE.VALUE_ABANDONED)
      );
    }
    // Delivered to a *different* consumer and never acknowledged: the state a worker that
    // died mid-batch leaves behind. Recovery is the only path to these entries — an ordinary
    // `>` read will not return them, because they have already been delivered.
    const strandedIds = await readNewEntryIds(
      streamName,
      groupName,
      INTEGRATION_LOOP.ABANDONED_ENTRY_COUNT,
      INTEGRATION_LOOP_REDIS.ABANDONED_CONSUMER_NAME
    );
    expect(strandedIds).toEqual(abandonedIds);
    // Age them past `BLOCK_MS_SHORT * RECOVERY_IDLE_MULTIPLIER`, or `XAUTOCLAIM` correctly
    // declines to steal work a live peer may still be doing.
    await settle(INTEGRATION_LOOP.IDLE_SETTLE_MS);

    await consumer.run();

    // 5 entries at `COUNT 2` — three `XAUTOCLAIM` rounds. A single call, which is what the
    // epic's wording implies, reclaims the first two and strands the rest until the next
    // restart. The whole set, in stream order, is the assertion that catches it.
    //
    // **Edited at T-041, deliberately, and not to make a red test pass.** This read
    // `expect(harness.handled).toEqual(abandonedIds)` — five ids, in order, *and nothing else*.
    // The last clause stopped being true: T-041 gives `runLoop` a reclaim cadence, so an entry
    // that is reclaimed and never acknowledged is re-offered roughly every
    // `blockMs x RECOVERY_IDLE_MULTIPLIER`, and this harness's handler is a bare recorder that
    // acknowledges nothing. Observed here: `handled` came back as the five ids followed by the
    // first page's two again, because one read of `BLOCK_MS_SHORT` was enough for the cadence
    // to elapse. That repeat is the new behaviour working, not a defect, and `U70`/`I23` are
    // what assert it on purpose.
    //
    // The pagination claim this case exists for is untouched and is asserted at full strength:
    // all five ids, in stream order, from **one** recovery pass. A single-call recovery would
    // put two ids in that slice and fail exactly as before.
    expect(harness.handled.slice(0, INTEGRATION_LOOP.ABANDONED_ENTRY_COUNT)).toEqual(
      abandonedIds
    );
    // And the half of the old assertion that *is* still true, kept rather than dropped: no id
    // outside the abandoned set ever reached the handler. Without this, the slice above would
    // tolerate an unrelated entry arriving after the fifth.
    expect(new Set(harness.handled)).toEqual(new Set(abandonedIds));
    expect(INTEGRATION_LOOP.ABANDONED_ENTRY_COUNT).toBeGreaterThan(
      INTEGRATION_LOOP.BATCH_SIZE_SMALL
    );
    // Reclaimed, not acknowledged: ownership moved, the entries did not leave the PEL.
    expect(
      await readPendingIds(streamName, groupName, INTEGRATION_LOOP.ABANDONED_ENTRY_COUNT)
    ).toEqual(abandonedIds);
  });

  it("I11 - re-registers the group after the stream key is deleted, and resumes", async () => {
    const { streamName, groupName } = nextLoopFixtureNames();
    const harness = buildLoopHarness(INTEGRATION_COUNTS.SINGLE);
    const consumer = buildLoopConsumer({ streamName, groupName, ...harness });
    await consumer.ensureConsumerGroup();

    const runPromise = consumer.run();
    // Deleting the key takes the group with it — `XINFO GROUPS` then replies
    // `ERR no such key` — and the next read replies `NOGROUP ...`. This is the repairable
    // failure class, reached the way it is actually reached rather than by injecting an error.
    expect(await redis.del(streamName)).toBe(INTEGRATION_KEY_EXISTS.PRESENT);

    // Wait for the loop to notice and rebuild it. `MKSTREAM` re-creates the key too.
    await vi.waitFor(
      async () => {
        const group = await readOnlyGroup(streamName);
        expect(group[INTEGRATION_XINFO_FIELDS.NAME]).toBe(groupName);
      },
      { timeout: INTEGRATION_LOOP.RUN_DEADLINE_MS, interval: INTEGRATION_LOOP.POLL_INTERVAL_MS }
    );

    const resumedId = await addLoopEntry(
      streamName,
      INTEGRATION_LOOP_FIXTURE.VALUE_AFTER_RECREATE
    );
    await runPromise;

    // Consumption resumed on the rebuilt group — the loop did not merely survive the error.
    expect(harness.handled).toEqual([resumedId]);
    expect(WORKER_STREAM_READ.MISSING_GROUP_ERROR_PREFIX).toBe("NOGROUP");
  });

  it("I12 - stop() ends a long blocking read without waiting it out", async () => {
    const { streamName, groupName } = nextLoopFixtureNames();
    const handled: string[] = [];
    const consumer = buildLoopConsumer({
      streamName,
      groupName,
      blockMs: INTEGRATION_LOOP.BLOCK_MS_LONG,
      handler: (id: string): Promise<void> => {
        handled.push(id);

        return Promise.resolve();
      },
      // Never true: termination must come from `stop()` alone, or the case measures the
      // predicate rather than the interrupt.
      isShuttingDown: (): boolean => false
    });
    await consumer.ensureConsumerGroup();

    // Anti-vacuity, and the assertion that would have caught M-3: nothing of this suite's is
    // parked before the subject starts, so the wait below observes a false -> true
    // transition caused by the subject's own read. With the old server-wide predicate this
    // line fails whenever any process anywhere on the server is parked on `XREADGROUP`.
    expect(await hasParkedRead()).toBe(false);

    const runPromise = consumer.run();
    // Waits for the read to actually be parked, rather than sleeping and hoping. A connection
    // blocked on `XREADGROUP` was observed in `CLIENT LIST` as `cmd=xreadgroup`; without this
    // the case could `stop()` before the read was issued and prove nothing about interrupting
    // one. `hasParkedRead` matches on this suite's own `connectionName`, because `CLIENT LIST`
    // is server-wide and the database index does not scope it (M-3).
    await vi.waitFor(
      async () => {
        expect(await hasParkedRead()).toBe(true);
      },
      { timeout: INTEGRATION_LOOP.RUN_DEADLINE_MS, interval: INTEGRATION_LOOP.POLL_INTERVAL_MS }
    );

    const startedAt = Date.now();
    await consumer.stop();
    await runPromise;
    const elapsed = Date.now() - startedAt;

    // The claim is "does not wait the block out", so the bound is a fraction of the block and
    // not a tight bound near the 205 ms a `disconnect()` was measured taking. `quit()`, which
    // `app.close()` triggers, took 4 813 ms against a 5 000 ms read in the same probe — which is why
    // `index.ts` calls `stop()` first.
    expect(elapsed).toBeLessThan(INTEGRATION_LOOP.STOP_BUDGET_MS);
    expect(INTEGRATION_LOOP.STOP_BUDGET_MS).toBeLessThan(INTEGRATION_LOOP.BLOCK_MS_LONG);
    expect(handled).toEqual([]);
  });

  it("I23 - re-offers a failed entry inside one run(), with no restart (T-041)", async () => {
    const { streamName, groupName } = nextLoopFixtureNames();
    const seen: string[] = [];
    const deadline = Date.now() + INTEGRATION_LOOP.RUN_DEADLINE_MS;
    const consumer = buildLoopConsumer({
      streamName,
      groupName,
      // Never acknowledges and always fails -- the state T-040 leaves a poison message in. The
      // rejection reaches `dispatch`, which logs it and continues without acknowledging.
      handler: (id: string): Promise<void> => {
        seen.push(id);

        return Promise.reject(new Error(INTEGRATION_DEAD_LETTER.VALUE_POISON));
      },
      isShuttingDown: (): boolean =>
        seen.length >= INTEGRATION_REDELIVERY_MIN_COUNT || Date.now() >= deadline
    });
    await consumer.ensureConsumerGroup();
    const entryId = await addLoopEntry(streamName, INTEGRATION_DEAD_LETTER.VALUE_RETRIED);

    await consumer.run();

    // **The claim, and the finding it closes.** Until T-041, `recoverPendingEntries` had one
    // call site, before the read loop, and its own docstring said "once, at startup" -- so a
    // failed entry's second delivery required a `run()` to begin, i.e. a restart. `dispatch`'s
    // docstring nonetheless said the entry "comes back through `recoverPendingEntries` after
    // the idle threshold". This case is what makes that sentence true.
    expect(seen.filter((id) => id === entryId).length).toBeGreaterThanOrEqual(
      INTEGRATION_REDELIVERY_MIN_COUNT
    );

    // The mechanism, from the server's own bookkeeping rather than from the handler's count:
    // Redis increments a per-entry delivery counter, and `>` provably does not redeliver
    // (measured on 7.0.15 -- a second `XREADGROUP ... >` returned empty while `XPENDING` still
    // reported the entry). So a count above one can only have come through the pending list.
    const counts = await readPendingDeliveryCounts(
      streamName,
      groupName,
      INTEGRATION_COUNTS.PAIR
    );
    expect(counts.get(entryId)).toBeGreaterThanOrEqual(INTEGRATION_REDELIVERY_MIN_COUNT);

    // Still pending and still on the stream: this loop has no retry policy wrapped around it,
    // so nothing acknowledged the entry and nothing was dropped. The dead-letter half is
    // `I26`'s, in the suite that has a processor.
    expect(await readPendingIds(streamName, groupName, INTEGRATION_COUNTS.PAIR)).toEqual([
      entryId
    ]);
    expect(await redis.xlen(streamName)).toBe(INTEGRATION_COUNTS.SINGLE);
  });
});

/** A stream key and group name unique to one T-043 case. Shares the counter with the others. */
const nextShutdownFixtureNames = (): { streamName: string; groupName: string } => {
  caseIndex += INTEGRATION_COUNTS.SINGLE;

  return {
    streamName: `${INTEGRATION_SHUTDOWN_REDIS.STREAM_NAME_PREFIX}${RUN_ID}-${caseIndex}`,
    groupName: `${INTEGRATION_SHUTDOWN_REDIS.CONSUMER_GROUP_PREFIX}${RUN_ID}-${caseIndex}`
  };
};

/**
 * `XINFO CONSUMERS`, reshaped to `name -> pending`.
 *
 * Issued through the harness's own `INTEGRATION_LOOP_COMMANDS.XINFO_CONSUMERS` spelling rather
 * than through `WORKER_SHUTDOWN.SUBCOMMAND_CONSUMERS`, for the reason that constant's docblock
 * gives: the claim is what the *server* holds after `stop()` ran.
 *
 * Throws on any reply it does not recognise rather than returning an empty map. `I28`'s
 * assertion is that a name is **absent**, so a parse failure that yielded `{}` would pass it
 * vacuously — the exact shape `readPendingIds`' docstring warns about.
 */
const readConsumerPending = async (
  streamName: string,
  groupName: string
): Promise<Map<string, number>> => {
  const reply: unknown = await redis.xinfo(
    INTEGRATION_LOOP_COMMANDS.XINFO_CONSUMERS,
    streamName,
    groupName
  );
  if (!isUnknownArray(reply)) {
    throw new Error(`XINFO CONSUMERS returned a non-array reply for ${streamName}`);
  }

  const pendingByName = new Map<string, number>();
  for (const rawRow of reply) {
    if (!isUnknownArray(rawRow)) {
      throw new Error(`XINFO CONSUMERS row was not an array for ${streamName}`);
    }

    let name: unknown;
    let pending: unknown;
    for (
      let index = INTEGRATION_COUNTS.NONE;
      index + INTEGRATION_COUNTS.SINGLE < rawRow.length;
      index += INTEGRATION_FIELD_PAIR_STRIDE
    ) {
      const key = rawRow[index + INTEGRATION_SHUTDOWN.CONSUMER_INFO_KEY_OFFSET];
      const value = rawRow[index + INTEGRATION_SHUTDOWN.CONSUMER_INFO_VALUE_OFFSET];
      if (key === INTEGRATION_XINFO_FIELDS.NAME) {
        name = value;
      } else if (key === INTEGRATION_XINFO_FIELDS.PENDING) {
        pending = value;
      }
    }

    if (typeof name !== "string" || typeof pending !== "number") {
      throw new Error(`XINFO CONSUMERS row carried no name/pending pair for ${streamName}`);
    }

    pendingByName.set(name, pending);
  }

  return pendingByName;
};

/**
 * Entry ids still reachable through the group, via `XAUTOCLAIM` from the beginning at min-idle 0.
 *
 * **This is the probe that makes `I29` about data rather than about a command.** The P1 loss is
 * invisible to `XPENDING` — it reports 0 either way, because the entries were removed from the
 * pending list — so a case that only checked `XPENDING` would be satisfied by the very
 * destruction it exists to prevent. `XAUTOCLAIM ... 0 0-0` returning the entries is what says
 * they are still *reachable*; after a `DELCONSUMER` on a consumer holding them it returns empty
 * while `XLEN` still counts them (measured, probe P1).
 *
 * Claims the entries to `claimantName`, which is a side effect and is why the caller must use a
 * throwaway identity.
 */
const readReachableEntryIds = async (
  streamName: string,
  groupName: string,
  claimantName: string,
  count: number
): Promise<string[]> => {
  const reply: unknown = await redis.xautoclaim(
    streamName,
    groupName,
    claimantName,
    INTEGRATION_SHUTDOWN.CLAIM_ANY_IDLE_MS,
    WORKER_STREAM_READ.PENDING_START_ID,
    INTEGRATION_LOOP_COMMANDS.XAUTOCLAIM_COUNT,
    count
  );
  if (!isUnknownArray(reply)) {
    throw new Error(`XAUTOCLAIM returned a non-array reply for ${streamName}`);
  }

  const entries = reply[WORKER_STREAM_READ.CLAIM_REPLY_ENTRIES_INDEX];
  if (!isUnknownArray(entries)) {
    throw new Error(`XAUTOCLAIM reply carried no entry list for ${streamName}`);
  }

  return entries.map((entry) => {
    const id = isUnknownArray(entry) ? entry[INTEGRATION_COUNTS.NONE] : undefined;
    if (typeof id !== "string") {
      throw new Error(`XAUTOCLAIM entry was not [id, fields] for ${streamName}`);
    }

    return id;
  });
};

describe("StreamConsumer.stop (live Redis)", () => {
  it("I28 - a clean shutdown at pending 0 removes this consumer's registry row", async () => {
    const { streamName, groupName } = nextShutdownFixtureNames();
    const handled: string[] = [];
    const deadline = Date.now() + INTEGRATION_LOOP.RUN_DEADLINE_MS;
    const consumer = buildLoopConsumer({
      streamName,
      groupName,
      consumerName: INTEGRATION_SHUTDOWN_REDIS.CONSUMER_NAME,
      // Acknowledges, which the other suites' harnesses deliberately do not: this case's premise
      // is a consumer that holds *nothing*, and that is only reachable by acking.
      handler: async (id: string): Promise<void> => {
        await redis.xack(streamName, groupName, id);
        handled.push(id);
      },
      isShuttingDown: (): boolean =>
        handled.length >= INTEGRATION_COUNTS.SINGLE || Date.now() >= deadline
    });
    await consumer.ensureConsumerGroup();
    const entryId = await addLoopEntry(streamName, INTEGRATION_SHUTDOWN_FIXTURE.VALUE_ACKED);

    await consumer.run();

    // Anti-vacuity, and it is not decoration: the row must exist *before* `stop()` for its
    // absence afterwards to mean anything. Measured on 7.0.15 — the row **persists at
    // `pending 0`**, it does not disappear when the last entry is acknowledged, which is the
    // whole reason a deregistration is worth issuing.
    expect(handled).toEqual([entryId]);
    const before = await readConsumerPending(streamName, groupName);
    expect(before.get(INTEGRATION_SHUTDOWN_REDIS.CONSUMER_NAME)).toBe(INTEGRATION_COUNTS.NONE);

    await consumer.stop();

    const after = await readConsumerPending(streamName, groupName);
    expect(after.has(INTEGRATION_SHUTDOWN_REDIS.CONSUMER_NAME)).toBe(false);
    // The group itself is untouched — this deregisters a consumer, not the group. A
    // `XGROUP DESTROY` would also have emptied the registry and would pass the line above.
    expect(await readGroups(streamName)).toHaveLength(INTEGRATION_COUNTS.SINGLE);
    expect(await redis.xlen(streamName)).toBe(INTEGRATION_COUNTS.SINGLE);
  });

  it("I29 - a shutdown with entries still pending leaves the row, the PEL, and the entries reachable", async () => {
    const { streamName, groupName } = nextShutdownFixtureNames();
    const harness = buildLoopHarness(INTEGRATION_COUNTS.SINGLE);
    const consumer = buildLoopConsumer({
      streamName,
      groupName,
      consumerName: INTEGRATION_SHUTDOWN_REDIS.CONSUMER_NAME,
      ...harness
    });
    await consumer.ensureConsumerGroup();
    const entryId = await addLoopEntry(
      streamName,
      INTEGRATION_SHUTDOWN_FIXTURE.VALUE_LEFT_PENDING
    );

    // The harness handler acknowledges nothing, so this is the state a worker is in when it is
    // stopped between delivery and commit — or when a transaction rolled back.
    await consumer.run();

    expect(harness.handled).toEqual([entryId]);
    const before = await readConsumerPending(streamName, groupName);
    expect(before.get(INTEGRATION_SHUTDOWN_REDIS.CONSUMER_NAME)).toBe(
      INTEGRATION_COUNTS.SINGLE
    );

    await consumer.stop();

    // **The case this task exists for, and the one whose red is data rather than a call count.**
    // With the `pending` guard removed, `XGROUP DELCONSUMER` runs here and (measured, probe P1,
    // re-run at Gate 3) returns the count of destroyed entries, `XPENDING` drops to 0, and the
    // entries become unreachable to `XAUTOCLAIM` and `XREADGROUP` alike while `XLEN` still counts
    // them. This is AC2: nothing lost, the entry stays in the PEL.
    // **Every read is taken before any assertion, and the assertions are then ordered weakest
    // last.** Two reasons, both measured. `readReachableEntryIds` issues `XAUTOCLAIM`, which
    // *moves* the pending row to its claimant — so it has to run after the other two reads or it
    // invalidates them. And assertions short-circuit, so whichever runs first is the one that
    // names the failure: with the registry-row assertion first, removing the `pending` guard
    // reported `expected undefined to be 1`, which says a row went missing and says nothing
    // about the entry.
    const after = await readConsumerPending(streamName, groupName);
    const pendingAfter = await readPendingIds(streamName, groupName, INTEGRATION_COUNTS.PAIR);
    const streamLength = await redis.xlen(streamName);
    const reachableAfter = await readReachableEntryIds(
      streamName,
      groupName,
      INTEGRATION_SHUTDOWN_REDIS.PREVIOUS_CONSUMER_NAME,
      INTEGRATION_COUNTS.PAIR
    );

    // Strongest first: the assertion `XPENDING` alone cannot make. A destroyed entry leaves
    // `XPENDING` at 0 — which is *also* what a correctly-acknowledged entry leaves — so only
    // reachability separates the loss from the success.
    expect(reachableAfter).toEqual([entryId]);
    expect(pendingAfter).toEqual([entryId]);
    expect(streamLength).toBe(INTEGRATION_COUNTS.SINGLE);
    // Weakest last: the registration row surviving is the *symptom*, not the property.
    expect(after.get(INTEGRATION_SHUTDOWN_REDIS.CONSUMER_NAME)).toBe(INTEGRATION_COUNTS.SINGLE);
  });

  it("I30 - stop() waits out an in-flight handler, which then acks, and only then deregisters", async () => {
    const { streamName, groupName } = nextShutdownFixtureNames();
    const handled: string[] = [];
    let entered = false;
    const consumer = buildLoopConsumer({
      streamName,
      groupName,
      consumerName: INTEGRATION_SHUTDOWN_REDIS.CONSUMER_NAME,
      blockMs: INTEGRATION_LOOP.BLOCK_MS_LONG,
      handler: async (id: string): Promise<void> => {
        entered = true;
        // Real work, in the shape T-040's processor does it: a delay, then the acknowledgement.
        // `stop()` lands in the middle of this, and probe P16 is why that is survivable —
        // disconnecting the *read* connection does not abort work in flight on the container's.
        await settle(INTEGRATION_SHUTDOWN.HANDLER_WORK_MS);
        await redis.xack(streamName, groupName, id);
        handled.push(id);
      },
      // Never true: the drain must be what ends this, not a predicate the loop would notice.
      isShuttingDown: (): boolean => false
    });
    await consumer.ensureConsumerGroup();
    const entryId = await addLoopEntry(streamName, INTEGRATION_SHUTDOWN_FIXTURE.VALUE_IN_FLIGHT);

    const runPromise = consumer.run();
    // Waits for the handler to be *entered* rather than sleeping and hoping, so the signal
    // genuinely lands mid-flight. Without this the case could stop before delivery and prove
    // nothing about draining.
    await vi.waitFor(
      () => {
        expect(entered).toBe(true);
      },
      {
        timeout: INTEGRATION_SHUTDOWN.ENTER_DEADLINE_MS,
        interval: INTEGRATION_LOOP.POLL_INTERVAL_MS
      }
    );
    expect(handled).toEqual([]);

    await consumer.stop();
    // **Snapshotted between `stop()` and `run()`, and the position is the claim.** Reading
    // `handled` after `await runPromise` would pass against the pre-T-043 `stop()` too: the
    // handler finishes either way, just not before `stop()` resolves. Measured — with the drain
    // removed and the assertion below the `await`, this case failed on the registry row instead
    // and said nothing about draining.
    const handledWhenStopResolved = [...handled];
    await runPromise;

    // The drain's whole claim: by the time `stop()` resolved, the handler had finished and its
    // acknowledgement had landed. Before T-043 `stop()` resolved with `handled` still empty.
    expect(handledWhenStopResolved).toEqual([entryId]);
    expect(handled).toEqual([entryId]);
    expect(await readPendingIds(streamName, groupName, INTEGRATION_COUNTS.PAIR)).toEqual([]);
    // And because the drain completed and the reading was then zero, the row went too — the
    // clean-shutdown end state, reached from a consumer that was busy when it was told to stop.
    const after = await readConsumerPending(streamName, groupName);
    expect(after.has(INTEGRATION_SHUTDOWN_REDIS.CONSUMER_NAME)).toBe(false);
  });

  it("I31 - entries orphaned under a previous pid are reclaimed by the new identity", async () => {
    const { streamName, groupName } = nextShutdownFixtureNames();
    const harness = buildLoopHarness(INTEGRATION_SHUTDOWN.ORPHANED_ENTRY_COUNT);
    const consumer = buildLoopConsumer({
      streamName,
      groupName,
      // A *different* name from the one the entries were delivered to — which is exactly what a
      // restart produces now that the default carries `process.pid`.
      consumerName: INTEGRATION_SHUTDOWN_REDIS.CONSUMER_NAME,
      ...harness
    });
    await consumer.ensureConsumerGroup();

    const orphanedIds: string[] = [];
    for (
      let index = INTEGRATION_COUNTS.NONE;
      index < INTEGRATION_SHUTDOWN.ORPHANED_ENTRY_COUNT;
      index += INTEGRATION_COUNTS.SINGLE
    ) {
      orphanedIds.push(
        await addLoopEntry(streamName, INTEGRATION_SHUTDOWN_FIXTURE.VALUE_ORPHANED)
      );
    }
    // Delivered to the previous identity and never acknowledged: the state a worker that died
    // uncleanly leaves behind, under a name no live process will ever use again.
    expect(
      await readNewEntryIds(
        streamName,
        groupName,
        INTEGRATION_SHUTDOWN.ORPHANED_ENTRY_COUNT,
        INTEGRATION_SHUTDOWN_REDIS.PREVIOUS_CONSUMER_NAME
      )
    ).toEqual(orphanedIds);
    // `>` provably will not return them — measured on 7.0.15, and asserted rather than assumed,
    // because if it did this case would pass without the reclaim path existing at all.
    expect(
      await readNewEntryIds(
        streamName,
        groupName,
        INTEGRATION_SHUTDOWN.ORPHANED_ENTRY_COUNT,
        INTEGRATION_SHUTDOWN_REDIS.CONSUMER_NAME
      )
    ).toEqual([]);
    // Age them past `BLOCK_MS_SHORT x RECOVERY_IDLE_MULTIPLIER`, or `XAUTOCLAIM` correctly
    // declines to steal work a live peer may still be doing.
    await settle(INTEGRATION_LOOP.IDLE_SETTLE_MS);

    await consumer.run();

    // **This is what makes D1/B's accepted trade latency rather than loss.** The pid changes
    // across a restart, so a worker no longer reclaims its own abandoned work *under the same
    // name*; the recovery pass reclaims it under the new one instead. Without this case, a
    // future change to the recovery cadence would silently strand every restarted worker's
    // in-flight entries and nothing would notice.
    expect(harness.handled.slice(0, INTEGRATION_SHUTDOWN.ORPHANED_ENTRY_COUNT)).toEqual(
      orphanedIds
    );
    // Ownership moved to the new identity; the entries did not leave the PEL, because this
    // harness acknowledges nothing.
    const pendingByName = await readConsumerPending(streamName, groupName);
    expect(pendingByName.get(INTEGRATION_SHUTDOWN_REDIS.CONSUMER_NAME)).toBe(
      INTEGRATION_SHUTDOWN.ORPHANED_ENTRY_COUNT
    );
    expect(pendingByName.get(INTEGRATION_SHUTDOWN_REDIS.PREVIOUS_CONSUMER_NAME)).toBe(
      INTEGRATION_COUNTS.NONE
    );
  });
});
