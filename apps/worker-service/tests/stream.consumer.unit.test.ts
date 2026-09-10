import { beforeEach, describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import type { Logger } from "pino";
import type { ServiceEnv } from "../src/config/env";
import {
  WORKER_CONSUMER_GROUP_BOOTSTRAP,
  WORKER_STREAM_CONSTANTS
} from "../src/constants";
import { StreamConsumer } from "../src/events/stream.consumer";

/**
 * Unit suite for T-038's consumer-group bootstrap.
 *
 * Mock shape follows `apps/usage-service/tests/stream.publisher.unit.test.ts:25-42`: a plain
 * `vi.fn()`-per-method object cast to `Redis`, a `vi.fn()`-per-method logger, and a
 * `Partial<ServiceEnv>`. The `ioredis` module itself is not mocked.
 *
 * One deliberate departure from that file: the client mock is typed as
 * `{ xgroup: ReturnType<typeof vi.fn> }` rather than `Record<string, ReturnType<typeof vi.fn>>`.
 * Under this package's `noUncheckedIndexedAccess`, the `Record` form makes every access
 * `possibly undefined`, which is why the neighbour re-casts at each call site
 * (`(mockRedis.xadd as ReturnType<typeof vi.fn>)`). Naming the one method the subject calls
 * removes **ten** such casts and makes a typo in the method name a compile error instead of
 * a silently-never-called spy.
 *
 * Counted, not estimated -- `grep -o` on
 * `apps/usage-service/tests/stream.publisher.unit.test.ts`: 13 occurrences of
 * `ReturnType<typeof vi.fn>`, of which 2 are type annotations (lines 8-9) and 11 are
 * call-site casts; 10 of those 11 are `(mockRedis.xadd as ...)` and are what this shape
 * removes. The eleventh is `(mockLogger.info as ...)` at line 149, which this file does
 * *not* remove -- the logger mock keeps the neighbour's
 * `Partial<Record<keyof Logger, ...>>` type. An earlier revision of this comment said
 * "seven".
 *
 * Every literal that already exists in `src/` is imported rather than re-typed
 * (`.claude/rules/constants.md` applies to tests). What is written out here is only fixture
 * vocabulary and the *observed* Redis reply texts -- those are deliberately literal, because
 * their exact wording is the thing under test and importing them from the constant that
 * matches them would make the assertions tautological.
 */

/** Reply text observed from `XGROUP CREATE` against an existing group on Redis 7.0.15. */
const BUSYGROUP_REPLY = "BUSYGROUP Consumer Group name already exists";

/** Reply text observed from `XGROUP CREATE` against a key holding a non-stream value. */
const WRONGTYPE_REPLY = "WRONGTYPE Operation against a key holding the wrong kind of value";

/**
 * Reply text observed from `XGROUP CREATECONSUMER probe:b BUSYGROUP c1`, i.e. a real reply
 * from this Redis in which the group name happens to be the literal `BUSYGROUP`. This is the
 * case that separates `startsWith` from the epic's `includes`.
 */
const NOGROUP_REPLY_NAMING_BUSYGROUP =
  "NOGROUP No such consumer group 'BUSYGROUP' for key name 'probe:b'";

/** A rejection that is not an `Error`, guarding the `err instanceof Error` branch. */
const NON_ERROR_REJECTION = "connection reset";

/** Non-default overrides for U6, so a hard-coded default cannot satisfy the assertion. */
const OVERRIDE = {
  STREAM_NAME: "telemetry:events:t038-unit-override",
  CONSUMER_GROUP: "worker-group-t038-unit-override"
} as const;

/**
 * The two messages the subject logs, as written at
 * `src/events/stream.consumer.ts:95` and `:108`.
 *
 * Deliberately literal, like the reply texts above, and for a different reason: these strings
 * are inline arguments in `src/`, not exported constants, so there is nothing for a test to
 * import. `.claude/rules/constants.md`'s applies-to-tests clause asks tests to import a
 * constant that already exists rather than re-type it; where none exists, naming the literal
 * once here is the closest available shape. Do not "fix" this by promoting them to
 * `src/constants.ts` as part of a test-only change.
 */
const LOG_MESSAGE = {
  CREATED: "Created stream consumer group",
  ALREADY_EXISTS: "Stream consumer group already exists"
} as const;

describe("StreamConsumer.ensureConsumerGroup", () => {
  let mockRedis: { xgroup: ReturnType<typeof vi.fn> };
  let mockLogger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
  let mockEnv: Partial<ServiceEnv>;

  const buildConsumer = (env: Partial<ServiceEnv> = mockEnv): StreamConsumer =>
    new StreamConsumer(
      mockRedis as unknown as Redis,
      mockLogger as unknown as Logger,
      env as ServiceEnv
    );

  /** Throws rather than returning undefined, so a missing call cannot pass vacuously. */
  const xgroupArgs = (): unknown[] => {
    const call = mockRedis.xgroup.mock.calls[0];
    if (!call) {
      throw new Error("xgroup was never called");
    }

    return call;
  };

  beforeEach(() => {
    mockRedis = { xgroup: vi.fn() };
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn()
    };
    mockEnv = {
      REDIS_STREAM_NAME: WORKER_STREAM_CONSTANTS.DEFAULT_STREAM_NAME,
      REDIS_CONSUMER_GROUP: WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_GROUP
    };
  });

  it("U1 - issues XGROUP CREATE <stream> <group> $ MKSTREAM and resolves", async () => {
    mockRedis.xgroup.mockResolvedValueOnce("OK");

    await expect(buildConsumer().ensureConsumerGroup()).resolves.toBeUndefined();

    expect(xgroupArgs()).toEqual([
      WORKER_CONSUMER_GROUP_BOOTSTRAP.SUBCOMMAND_CREATE,
      WORKER_STREAM_CONSTANTS.DEFAULT_STREAM_NAME,
      WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_GROUP,
      WORKER_CONSUMER_GROUP_BOOTSTRAP.START_ID_NEW_ENTRIES_ONLY,
      WORKER_CONSUMER_GROUP_BOOTSTRAP.OPTION_MKSTREAM
    ]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("U2 - resolves when the group already exists, without logging an error", async () => {
    mockRedis.xgroup.mockRejectedValueOnce(new Error(BUSYGROUP_REPLY));

    await expect(buildConsumer().ensureConsumerGroup()).resolves.toBeUndefined();

    expect(mockRedis.xgroup).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalled();
  });

  it("U3 - rethrows a non-BUSYGROUP reply error", async () => {
    const replyError = new Error(WRONGTYPE_REPLY);
    mockRedis.xgroup.mockRejectedValueOnce(replyError);

    await expect(buildConsumer().ensureConsumerGroup()).rejects.toBe(replyError);

    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("U4 - rejects when the client rejects with a non-Error value", async () => {
    mockRedis.xgroup.mockRejectedValueOnce(NON_ERROR_REJECTION);

    await expect(buildConsumer().ensureConsumerGroup()).rejects.toBe(NON_ERROR_REJECTION);

    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("U5 - rethrows NOGROUP even though its message contains BUSYGROUP", async () => {
    const replyError = new Error(NOGROUP_REPLY_NAMING_BUSYGROUP);
    // The premise of the case, asserted rather than assumed: this really is a message on
    // which `includes` and `startsWith` disagree. If it stopped being so, the case would
    // pass while testing nothing.
    expect(
      replyError.message.includes(WORKER_CONSUMER_GROUP_BOOTSTRAP.ALREADY_EXISTS_ERROR_PREFIX)
    ).toBe(true);
    expect(
      replyError.message.startsWith(WORKER_CONSUMER_GROUP_BOOTSTRAP.ALREADY_EXISTS_ERROR_PREFIX)
    ).toBe(false);
    mockRedis.xgroup.mockRejectedValueOnce(replyError);

    await expect(buildConsumer().ensureConsumerGroup()).rejects.toBe(replyError);
  });

  /**
   * U9/U10 close QA finding F2. Before them, deleting the whole success-path
   * `logger.info(...)` block from `src/events/stream.consumer.ts` left the entire suite green
   * (QA mutation M8: 21/21 passing), and `U2`'s `expect(mockLogger.info).toHaveBeenCalled()`
   * could not tell the created message from the already-exists one.
   *
   * `U2` is left exactly as it was rather than strengthened in place: it asserts the *resolve*
   * contract for the already-exists path, which is a different claim from what that path logs.
   * U10 asserts the log. Neither weakens the other.
   *
   * **What these two catch, stated no stronger than that (QA finding F1).** `startId` is
   * asserted against `WORKER_CONSUMER_GROUP_BOOTSTRAP.START_ID_NEW_ENTRIES_ONLY`, the same
   * constant the implementation reads, so both sides of the assertion move together. These
   * cases therefore catch a **code** change -- the field being dropped, renamed, given a
   * different expression, or the message being reworded -- and **not** a change to the
   * constant's *value*. `"$"` itself is guarded only by `I5`
   * (`tests/stream.consumer.integration.test.ts:283`), which pins the literal, and by I5's
   * delivery assertions. Do not read U9 as coverage of the start position.
   *
   * Both use the non-default `OVERRIDE` names for the same reason `U6` does: asserting the
   * defaults here could be satisfied by an implementation that logged a hard-coded literal.
   */
  it("U9 - logs the created message with the stream, group and start id", async () => {
    mockRedis.xgroup.mockResolvedValueOnce("OK");

    await buildConsumer({
      REDIS_STREAM_NAME: OVERRIDE.STREAM_NAME,
      REDIS_CONSUMER_GROUP: OVERRIDE.CONSUMER_GROUP
    }).ensureConsumerGroup();

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        startId: WORKER_CONSUMER_GROUP_BOOTSTRAP.START_ID_NEW_ENTRIES_ONLY
      },
      LOG_MESSAGE.CREATED
    );
    // Negative half: the created path must not claim the group was already there.
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      LOG_MESSAGE.ALREADY_EXISTS
    );
  });

  it("U10 - logs the already-exists message with the stream and group, and no start id", async () => {
    mockRedis.xgroup.mockRejectedValueOnce(new Error(BUSYGROUP_REPLY));

    await buildConsumer({
      REDIS_STREAM_NAME: OVERRIDE.STREAM_NAME,
      REDIS_CONSUMER_GROUP: OVERRIDE.CONSUMER_GROUP
    }).ensureConsumerGroup();

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { streamName: OVERRIDE.STREAM_NAME, groupName: OVERRIDE.CONSUMER_GROUP },
      LOG_MESSAGE.ALREADY_EXISTS
    );
    // Negative half, and the half M8 needed: the two paths must be distinguishable. A
    // success-path message logged here would mean the suite could not tell them apart.
    expect(mockLogger.info).not.toHaveBeenCalledWith(expect.anything(), LOG_MESSAGE.CREATED);
  });

  it("U6 - takes the stream and group names from the parsed env, not from the defaults", async () => {
    mockRedis.xgroup.mockResolvedValueOnce("OK");

    await buildConsumer({
      REDIS_STREAM_NAME: OVERRIDE.STREAM_NAME,
      REDIS_CONSUMER_GROUP: OVERRIDE.CONSUMER_GROUP
    }).ensureConsumerGroup();

    const args = xgroupArgs();
    expect(args).toContain(OVERRIDE.STREAM_NAME);
    expect(args).toContain(OVERRIDE.CONSUMER_GROUP);
    // Negative half: a hard-coded literal would leave the defaults in the vector.
    expect(args).not.toContain(WORKER_STREAM_CONSTANTS.DEFAULT_STREAM_NAME);
    expect(args).not.toContain(WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_GROUP);
  });
});
