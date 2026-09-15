import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import type { Logger } from "pino";
import type { ServiceEnv } from "../src/config/env";
import {
  WORKER_CONSUMER_GROUP_BOOTSTRAP,
  WORKER_SHUTDOWN,
  WORKER_STREAM_CONSTANTS,
  WORKER_STREAM_READ
} from "../src/constants";
import { StreamConsumer, type StreamMessageHandler } from "../src/events/stream.consumer";
import { CASE_BUDGET_MS, INTEGRATION_LOOP } from "./integration.constants";

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

/**
 * The shutdown predicate for a consumer that is constructed only to bootstrap.
 *
 * T-039 made the predicate a **required** fourth constructor argument rather than defaulting
 * it, so that no site can start a loop with no stop condition by omission. The cases in this
 * block never call `run()`, so what they pass is inert — but they have to say so, which is
 * the property the required argument buys. The loop block below passes real predicates.
 */
const NEVER_SHUTTING_DOWN = (): boolean => false;

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

/**
 * A non-`Error`, non-*string* rejection, for `U23`.
 *
 * Deliberately not `NON_ERROR_REJECTION`: `String("connection reset")` is the identity, so a
 * string fixture cannot tell `String(error)` apart from `error` and `U23` would pass against an
 * implementation that dropped the conversion entirely. An object's `String(...)` form differs
 * from the object, so the conversion is observable.
 */
const NON_ERROR_OBJECT_REJECTION = { code: 503 };

/**
 * `String(NON_ERROR_OBJECT_REJECTION)`, written out rather than computed in the assertion.
 *
 * Computing it would restate the implementation's own expression on both sides of the
 * `expect`, which is the F1 trap: the two would move together and the case would catch a code
 * change but not a value change. The premise that this really is the conversion — and really
 * is different from the fixture — is asserted inside `U23`.
 */
const NON_ERROR_OBJECT_REJECTION_AS_STRING = "[object Object]";

/**
 * Non-default overrides, so a hard-coded default cannot satisfy an assertion.
 *
 * `U6`/`U9`/`U10`/`U22`/`U23` use the first two. T-039's loop cases use all five: every value
 * the read command carries must be provably taken from the parsed env, which means every one
 * of them must differ from the `WORKER_STREAM_CONSTANTS` default of the same name. The
 * numbers are deliberately small and odd rather than round, so a value that came from
 * somewhere else is visible on sight.
 */
const OVERRIDE = {
  STREAM_NAME: "telemetry:events:t038-unit-override",
  CONSUMER_GROUP: "worker-group-t038-unit-override",
  CONSUMER_NAME: "worker-t039-unit-override",
  BLOCK_MS: 37,
  BATCH_SIZE: 7
} as const;

/**
 * Every log *message* the subject writes, in one place.
 *
 * Deliberately literal, like the reply texts above, and for a different reason: these strings
 * are inline arguments in `src/`, not exported constants, so there is nothing for a test to
 * import. `.claude/rules/constants.md`'s applies-to-tests clause asks tests to import a
 * constant that already exists rather than re-type it; where none exists, naming the literal
 * once here is the closest available shape. Do not "fix" this by promoting them to
 * `src/constants.ts` as part of a test-only change.
 *
 * Members are cited by the method that writes them rather than by line number: the T-039
 * review found two wrong citations in this task's own plan (AC11's proving case, and the order
 * of two commits), and this file's line numbers move every time a case is added.
 *
 * The T-039 members were inline literals in the cases themselves until the Round-1 review
 * (M-5) — four copies of `"Stream read failed"`, and a re-typed duplicate of
 * `BOOTSTRAP_FAILED` in the same file.
 */
const LOG_MESSAGE = {
  /** `ensureConsumerGroup`, success branch. */
  CREATED: "Created stream consumer group",
  /** `ensureConsumerGroup`, already-exists branch. */
  ALREADY_EXISTS: "Stream consumer group already exists",
  /** `ensureConsumerGroup`, error branch — `U22`/`U23`, and the `NOGROUP` repair in `U30`. */
  BOOTSTRAP_FAILED: "Failed to ensure stream consumer group",
  /** `handleReadFailure`, the unclassified branch that backs off. */
  READ_FAILED: "Stream read failed",
  /** `recoverPendingEntries`, error branch. */
  RECOVERY_FAILED: "Failed to reclaim pending stream entries",
  /** `recoverPendingEntries`, the shutdown classification added for M-1. */
  /**
   * `handleReadFailure`, the shutdown-interrupt branch — the line AC8 is actually about.
   * Added at the Gate-6 review (M-8): it was the only loop message with no member here, which
   * is how it escaped M-5's sweep and H-3's mis-citation alike, and nothing asserted its text
   * or its fields.
   */
  READ_INTERRUPTED: "Stream read interrupted by shutdown",
  RECOVERY_INTERRUPTED: "Pending-entry recovery interrupted by shutdown",
  /** `recoverPendingEntries`, the between-pages stop guard added for M-1. */
  RECOVERY_STOPPED: "Stopped reclaiming pending stream entries: shutdown requested",
  /** `recoverPendingEntries`, the `RECOVERY_MAX_PAGES` liveness bound. */
  RECOVERY_PAGE_LIMIT: "Stopped reclaiming pending stream entries at the page limit",
  /**
   * `dispatch`, per-entry handler failure.
   *
   * **Stays a literal even though `WORKER_STREAM_READ.LOG.HANDLER_FAILED` now exists**, and the
   * promotion that added that constant (T-040, LOW-1) deliberately did not touch this line. Like
   * the observed Redis reply texts above, this is the wording *under test*: `U29` asserts that
   * the subject logs exactly this string, and sourcing the expectation from the constant the
   * subject writes would make the assertion hold whatever either of them said. T-040's `I18`
   * does import the constant, because there the message selects a log line rather than being
   * the claim.
   */
  HANDLER_FAILED: "Stream entry handler failed",
  /** `dispatch`, the reply elements that did not have the shape of an entry. */
  MALFORMED_ELEMENTS: "Skipped stream reply elements that were not entries",
  /** `run`'s own `catch` — the H-1 guard that keeps the discarded promise from rejecting. */
  LOOP_FAILED: "Stream consumer loop failed",
  /** `run`, the early return when a stop was already requested. */
  LOOP_NOT_STARTED: "Stream consumer loop not started: shutdown already requested",
  /** `run`'s `finally`. */
  LOOP_STOPPED: "Stream consumer loop stopped",
  /** `buildDefaultMessageHandler` — the handler a four-argument construction gets (D2-A). */
  DEFAULT_HANDLER_RECEIVED: "Received stream entry; no processor is wired yet",
  /** `stop()`'s drain, the bound expiring before the loop settled (T-043). */
  DRAIN_TIMED_OUT: "Timed out draining in-flight stream work on shutdown",
  /** `deregisterConsumer`, the success branch. */
  DEREGISTERED: "Deregistered stream consumer",
  /** `deregisterConsumer`, our row absent — nothing was ever registered under this name. */
  DEREGISTER_NOT_REGISTERED: "Skipped stream consumer deregistration: this consumer is not registered",
  /** `deregisterConsumer`, the guard that keeps P1 from happening. */
  DEREGISTER_SKIPPED_PENDING:
    "Skipped stream consumer deregistration: this consumer still holds pending entries",
  /** `deregisterConsumer`, the `XINFO CONSUMERS` round trip itself failing. */
  DEREGISTER_SKIPPED_UNREADABLE:
    "Skipped stream consumer deregistration: could not read the consumer registry",
  /**
   * `deleteConsumerIfIdle`, a reply that arrived but was not a shape the parser recognises.
   *
   * Separate wording from `DEREGISTER_SKIPPED_UNREADABLE` above, deliberately: they are
   * different facts at different levels (a failed round trip is an ERROR, an unexpected reply
   * shape is a WARN), and one message text appearing at two levels is unreadable in a log.
   */
  DEREGISTER_SKIPPED_UNPARSEABLE:
    "Skipped stream consumer deregistration: unreadable consumer registry reply",
  /** `deregisterConsumer`, the classified "group or key already gone" replies (P5/P6/P6b). */
  DEREGISTER_GROUP_GONE:
    "Stream consumer group or key is already gone; nothing to deregister",
  /** `deregisterConsumer`, anything else. */
  DEREGISTER_FAILED: "Failed to deregister stream consumer"
} as const;

describe("StreamConsumer.ensureConsumerGroup", () => {
  let mockRedis: { xgroup: ReturnType<typeof vi.fn> };
  let mockLogger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
  let mockEnv: Partial<ServiceEnv>;

  const buildConsumer = (env: Partial<ServiceEnv> = mockEnv): StreamConsumer =>
    new StreamConsumer(
      mockRedis as unknown as Redis,
      mockLogger as unknown as Logger,
      env as ServiceEnv,
      NEVER_SHUTTING_DOWN
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

  /**
   * U22/U23 close inherited finding LOW-4 (T-039 slice S2).
   *
   * `U3` and `U4` already assert that the error branch *fires* — `expect(mockLogger.error)
   * .toHaveBeenCalled()` — and that the rejection is rethrown unchanged. Neither looks at what
   * was logged, so the whole field object could be dropped or wrong and both stay green. That
   * was measured at `b558641`: replacing `String(error)` at `src/events/stream.consumer.ts:114`
   * with the literal `"unknown"` left the service suite at 7 files / 65 tests, all passing.
   *
   * `U3`/`U4` are left exactly as they are rather than strengthened in place, for the same
   * reason `U2` was left alone when `U9`/`U10` were added: the rethrow contract and the log
   * contents are different claims, and folding them into one case makes a failure ambiguous.
   *
   * **The F1 trap, and which half of it these cases catch.** `streamName`/`groupName` are
   * asserted against `OVERRIDE`, a test-local fixture the implementation never reads, and the
   * message text and the `error` string are asserted against literals observed from Redis and
   * from `String(...)` — not against anything imported from `src/`. So unlike `U9`, both sides
   * of these assertions are independent of the implementation, and a change to either the code
   * *or* the logged value reddens them. What they do not cover is the *choice* of which fields
   * to log; that is a contract question, not a value question.
   */
  it("U22 - logs stream, group and the error message when the bootstrap fails", async () => {
    mockRedis.xgroup.mockRejectedValueOnce(new Error(WRONGTYPE_REPLY));

    await expect(
      buildConsumer({
        REDIS_STREAM_NAME: OVERRIDE.STREAM_NAME,
        REDIS_CONSUMER_GROUP: OVERRIDE.CONSUMER_GROUP
      }).ensureConsumerGroup()
    ).rejects.toThrow(WRONGTYPE_REPLY);

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        error: WRONGTYPE_REPLY
      },
      LOG_MESSAGE.BOOTSTRAP_FAILED
    );
    // Negative half: a failure must not also report success or already-exists.
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("U23 - stringifies a non-Error rejection into the logged error field", async () => {
    // Premise, asserted rather than assumed (the shape `U5` uses): this fixture is not an
    // `Error`, and its `String(...)` form is genuinely different from the fixture itself. If it
    // ever stopped being so, the case below would pass while testing nothing.
    expect(NON_ERROR_OBJECT_REJECTION).not.toBeInstanceOf(Error);
    expect(String(NON_ERROR_OBJECT_REJECTION)).toBe(NON_ERROR_OBJECT_REJECTION_AS_STRING);
    mockRedis.xgroup.mockRejectedValueOnce(NON_ERROR_OBJECT_REJECTION);

    await expect(
      buildConsumer({
        REDIS_STREAM_NAME: OVERRIDE.STREAM_NAME,
        REDIS_CONSUMER_GROUP: OVERRIDE.CONSUMER_GROUP
      }).ensureConsumerGroup()
    ).rejects.toBe(NON_ERROR_OBJECT_REJECTION);

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        error: NON_ERROR_OBJECT_REJECTION_AS_STRING
      },
      LOG_MESSAGE.BOOTSTRAP_FAILED
    );
  });
});

/**
 * Unit suite for T-039's read loop and startup recovery.
 *
 * A second `describe` rather than new cases inside the bootstrap one: the subject is a
 * different method, and the mock it needs is larger (a main connection *and* the duplicated
 * read connection D1-B introduced). The bootstrap block above is untouched.
 *
 * **Reply texts and shapes are test-local literals taken from measurement, never imported
 * from `src/`.** They were re-measured against Redis 7.0.15 / ioredis 5.11.1 on logical
 * database 14 while implementing this task, not copied from the plan:
 *
 *   BLOCK timeout, nothing to deliver -> `null`            (391 ms against BLOCK 300)
 *   entries available                 -> `[[stream,[[id,[f,v]],...]]]`
 *   own pending list, fully acked     -> `[[stream,[]]]`   (non-null, zero entries)
 *   group or key missing              -> `NOGROUP No such key '<k>' or consumer group '<g>'
 *                                         in XREADGROUP with GROUP option`
 *   `disconnect()` during a block     -> `Error: Connection is closed.` after 205 ms
 *   `XAUTOCLAIM`                      -> `[cursor, entries, deleted]`, 3 elements; 5 pending
 *                                         at `COUNT 2` needed 3 rounds (2+2+1)
 *
 * That is the F1 discipline: where the *value* is the thing under test, the expectation must
 * not be the same expression the implementation evaluates. Where a case does assert a
 * constant against itself, it says so.
 *
 * **Every case that drives the loop terminates it deterministically** — a predicate that
 * flips after a counted number of iterations, or an explicit `stop()`. No case waits on a
 * wall-clock timer to end a loop, because a loop that failed to exit would then hang the
 * suite rather than fail it.
 */

/** Reply observed from `XREADGROUP` against a group that does not exist. */
const NOGROUP_READ_REPLY =
  "NOGROUP No such key 'telemetry:events:t038-unit-override' or consumer group 'worker-group-t038-unit-override' in XREADGROUP with GROUP option";

/** Rejection observed when `disconnect()` is issued against an in-flight blocking read. */
const CONNECTION_CLOSED_REJECTION = "Connection is closed.";

/** A transient read failure that is neither of the two classified cases. */
const TRANSIENT_READ_FAILURE =
  'Reached the max retries per request limit (which is 2). Refer to "maxRetriesPerRequest" option for details.';

/**
 * What the container's own connection does if the loop ever reads on it.
 *
 * The main mock's `xreadgroup`/`xautoclaim` throw rather than returning a value, so D1-B is
 * enforced by the fixture and not only asserted by `U24`'s negative half. Measured reason for
 * doing it this way: with those two as bare `vi.fn()`s, mutating
 * `this.redis.duplicate()` to `this.redis` did not produce a legible failure — `U26`, whose
 * predicate never flips, span on the undefined reply until the vitest worker died of an
 * out-of-memory error and the run reported no test results at all. A fixture that fails fast
 * turns that into an assertion failure in the case that owns the claim.
 */
const MAIN_CONNECTION_READ = "the loop must not read on the container's connection";

/** Rejection a handler raises, for `U29`. */
const HANDLER_FAILURE = "insert failed";

/** A non-`Error` read rejection, for `U18`. */
const NON_ERROR_READ_REJECTION = { errno: -104 };
/** `String(NON_ERROR_READ_REJECTION)`, written out rather than computed — see `U23`. */
const NON_ERROR_READ_REJECTION_AS_STRING = "[object Object]";

/** Entry ids and field vectors, shaped as Redis returned them. */
const ENTRY = {
  FIRST: { id: "1789101023800-0", fields: ["eventId", "t039-unit-first"] },
  SECOND: { id: "1789101023802-0", fields: ["eventId", "t039-unit-second"] },
  RECLAIMED: { id: "1789096545582-0", fields: ["eventId", "t039-unit-reclaimed"] },
  RECLAIMED_SECOND: { id: "1789096545583-0", fields: ["eventId", "t039-unit-reclaimed-2"] }
} as const;

/** A non-terminal `XAUTOCLAIM` cursor, as observed mid-scan on a 5-entry pending list. */
const RECOVERY_NEXT_CURSOR = "1789096545582-2";

/**
 * The `TypeError` observed when `run()` was first wired into the shutdown suite against a
 * container mock that had no `duplicate` method.
 *
 * Kept as a fixture because it is the case that refuted this task's original claim that
 * `run()` "resolves rather than rejects": `duplicate()` was called outside `run()`'s `try`,
 * so the rejection escaped into a `void`-discarded promise. `U32` pins the guard.
 */
const OPEN_READ_CONNECTION_FAILURE = "duplicate is not a function";

/** A shutdown predicate that throws — the second uncaught path the review found (`U33`). */
const PREDICATE_FAILURE = "the shutdown predicate threw";

/**
 * An entry whose field list contains a non-string, for `U37`.
 *
 * The parser treats this as making the **whole entry** malformed rather than filtering the
 * offending element out, because the field array is positional key/value pairs: dropping one
 * element re-pairs every following key with the wrong value. `U37` asserts the entry is
 * dropped loudly rather than mis-parsed quietly, which is the design claim the parser's
 * docstring makes and nothing exercised before Round 1 (L-3).
 */
const MALFORMED_ENTRY = ["1789101023804-0", ["eventId", 42]];

interface FixtureEntry {
  readonly id: string;
  readonly fields: readonly string[];
}

/** `[[stream, [[id, fields], ...]]]` — the shape a read with entries returns. */
const streamReply = (entries: readonly FixtureEntry[]): unknown =>
  [[OVERRIDE.STREAM_NAME, entries.map((entry) => [entry.id, [...entry.fields]])]];

/** `[cursor, entries, deleted]` — `XAUTOCLAIM`'s three-element reply. */
const autoclaimReply = (cursor: string, entries: readonly FixtureEntry[]): unknown => [
  cursor,
  entries.map((entry) => [entry.id, [...entry.fields]]),
  []
];

/** Call counts, named so no bare numeral carries meaning in an assertion. */
const CALLS = {
  NONE: 0,
  ONCE: 1,
  TWICE: 2
} as const;

/**
 * Positional indices. Separate from `CALLS` on purpose: a call *count* standing in for an
 * array *position* reads wrong even when the numeral is right, and the worst case was
 * `ENTRY.FIRST.fields[INDEX.FIELD_VALUE]` — the payload the redaction negative searches for, named
 * as though it were a call count. Mirrors `WORKER_STREAM_READ`'s own `*_INDEX` naming.
 * Gate-4 Round-2 L-11.
 */
const INDEX = {
  /** First element — an entry id in a `[id, fields]` pair, or the first call recorded. */
  FIRST: 0,
  /** Second element — the second call recorded, or the second page of a paginated reclaim. */
  SECOND: 1,
  /** Second element — the *value* of a `[key, value]` field pair. */
  FIELD_VALUE: 1
} as const;

/**
 * Wall-clock ceiling for a `stopWhen` predicate, well inside the runner's per-case budget so
 * the case's own assertions report the failure rather than the runner.
 *
 * `U50` asserts that relationship against `CASE_BUDGET_MS` rather than leaving it to this
 * comment, which is the T-040/S1 half of the inherited deadline-vs-budget item.
 */
const STOP_DEADLINE_MS = 2_000;

/**
 * `0` **milliseconds**, for `vi.advanceTimersByTimeAsync` — drain the microtask queue without
 * moving the clock.
 *
 * A duration, not a call count. Two sites (`U16` and `U17`) previously passed `CALLS.NONE`
 * here: the numeral was right and the meaning was wrong, and a reader checking whether the
 * retry had been paced could not tell the argument was a duration at all. Named separately
 * from `CALLS.NONE` for the same reason `INDEX` is named separately from `CALLS`.
 */
const ADVANCE_NO_TIME_MS = 0;

/**
 * A cursor that is not a string, in `XAUTOCLAIM`'s cursor slot.
 *
 * Not a shape Redis 7.0.15 was observed to produce — the cursor came back a string on all
 * three pages of the 5-entry scan T-039 measured. It is the shape `parseClaimReply`'s
 * `typeof rawCursor === "string"` guard exists for, and `U39` pins what the guard does with
 * it. `null` rather than some other non-string because it is what a truncated or
 * differently-encoded reply would most plausibly yield.
 */
const NON_STRING_CLAIM_CURSOR = null;

/**
 * `vitest.config.mjs`, resolved from this file rather than named as a static import.
 *
 * A variable specifier on purpose: the config is outside this package's `tsconfig.json`
 * `include` (`src/**` and `tests/**` only) and has no declaration, so a literal
 * `import "../vitest.config.mjs"` is a `TS2307`. Resolving it at runtime keeps `U50`'s claim
 * about the *effective* budget rather than about a numeral copied into a constant.
 */
const VITEST_CONFIG_URL = new URL("../vitest.config.mjs", import.meta.url).href;

/**
 * `testTimeout` out of the imported config, or a throw.
 *
 * Throws rather than returning a default in every direction a vacuous pass could come from —
 * no default export, no `test` block, no `testTimeout`, or one that is not a number. Without
 * that, deleting the declaration from `vitest.config.mjs` would leave `U50` asserting
 * `undefined === undefined` and reporting green (`.claude/rules/testing.md`: a helper that
 * locates a thing must throw when it is missing).
 */
const readConfiguredTestTimeout = (configModule: unknown): number => {
  const exported = (configModule as { default?: unknown }).default;
  const testBlock = (exported as { test?: unknown } | undefined)?.test;
  const testTimeout = (testBlock as { testTimeout?: unknown } | undefined)?.testTimeout;
  if (typeof testTimeout !== "number") {
    throw new Error(
      `vitest.config.mjs declares no numeric test.testTimeout (got ${String(testTimeout)})`
    );
  }

  return testTimeout;
};

/**
 * How many `ERROR_BACKOFF_MS` windows `settleWithBackoffs` will advance before giving up.
 *
 * The cases that use it take at most two — one per failing read, with `stopAfter(CALLS.TWICE)`
 * ending the loop — so this is headroom, not a budget. Fake timers, so no wall-clock time is
 * spent on the unused windows.
 */
const MAX_BACKOFF_WINDOWS = 4;

/**
 * The reclaim cadence for the shared `loopEnv`, derived the same way the subject derives it.
 *
 * Not a new constant in `src/`: T-041 reuses `RECOVERY_IDLE_MULTIPLIER` rather than adding a
 * second numeral under a second name. Computing it here from the same two values the subject
 * reads means this suite cannot pin a *different* cadence than the one that ships -- and `U70`
 * asserts elapsed time against it, which is the one thing a value copied by hand could get
 * silently wrong.
 */
const RECOVERY_CADENCE_MS = OVERRIDE.BLOCK_MS * WORKER_STREAM_READ.RECOVERY_IDLE_MULTIPLIER;

/**
 * A deliberately long block interval for `U71`, whose subject is that the cadence does **not**
 * fire on every iteration.
 *
 * `500` makes the cadence 1 000 ms, against a handful of reads that resolve from a mock in
 * microseconds -- a margin of roughly three orders of magnitude. The shared `OVERRIDE.BLOCK_MS`
 * of 37 would give a 74 ms window, which is ample in practice and still close enough to a slow
 * CI tick to be worth not relying on. The resulting cadence stays under `STOP_DEADLINE_MS`, so
 * a subject that reclaimed on every iteration fails by assertion rather than by deadline.
 */
const SLOW_BLOCK_MS = 500;

/** Reads `U71` drives inside one cadence window. More than one, which is the whole claim. */
const READS_INSIDE_ONE_WINDOW = 5;

/**
 * `XINFO CONSUMERS` replies, in the flat `[key, value, key, value, ...]` shape ioredis 5.11.1
 * returned on Redis 7.0.15 — one array per consumer, and `pending` as a **number**, not a
 * string.
 *
 * The field names are written out rather than sourced from
 * `WORKER_SHUTDOWN.CONSUMER_INFO_FIELD_*`, for the reason the reply texts above are literal:
 * this is the *server's* reply, and a fixture that echoed the parser's own constants back at it
 * would keep agreeing with the parser after either changed. Measured at Gate 3 over three states
 * of one group:
 *
 *   nobody has read yet       -> `[]`
 *   c1 holding two entries    -> `[["name","c1","pending",2,"idle",0]]`
 *   c1 after acking both      -> `[["name","c1","pending",0,"idle",1]]`
 */
const consumerInfoRow = (name: string, pending: number): unknown[] => [
  "name",
  name,
  "pending",
  pending,
  "idle",
  OBSERVED_CONSUMER_IDLE_MS
];

/** The `idle` a fixture row carries. Read by nothing in `src/`; present so the row is real. */
const OBSERVED_CONSUMER_IDLE_MS = 13;

/**
 * Pending counts a row may report. Named so no bare numeral decides whether entries are
 * destroyed — `SOME` is the value that must suppress the deregistration (P1).
 */
const CONSUMER_PENDING = {
  NONE: 0,
  SOME: 2
} as const;

/**
 * A *different* consumer's name, present in the registry alongside ours.
 *
 * The anti-vacuity fixture for `U77`: its row reports `CONSUMER_PENDING.SOME`, so a guard that
 * read "the first row", "any row", or a group-wide total rather than **our own row** would
 * decline to deregister and fail that case — and a guard that deleted by position rather than by
 * name would delete a live peer's registration, which is P11 with the roles reversed.
 */
const OTHER_CONSUMER_NAME = "worker-t043-unit-peer";

/**
 * Reply observed from `XGROUP DELCONSUMER` against a group that does not exist (P5).
 *
 * Note the group name appears *inside* the text, which is why the classifier uses `startsWith`
 * and not `includes`.
 */
const NOGROUP_DELCONSUMER_REPLY = `NOGROUP No such consumer group '${OVERRIDE.CONSUMER_GROUP}' for key name '${OVERRIDE.STREAM_NAME}'`;

/**
 * Reply observed from `XGROUP DELCONSUMER` against a stream key that does not exist (P6).
 *
 * **This is the case that fails if the classifier reuses
 * `WORKER_STREAM_READ.MISSING_GROUP_ERROR_PREFIX` alone** — it shares no prefix with the
 * `NOGROUP` reply above. Plan finding F2.
 */
const MISSING_KEY_DELCONSUMER_REPLY =
  "ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.";

/**
 * Reply observed from `XINFO CONSUMERS` against a stream key that does not exist.
 *
 * A **third** shape for the same condition as `MISSING_KEY_DELCONSUMER_REPLY`, reached through a
 * different command, sharing no prefix with either of the other two. Measured at Gate 3; the
 * plan's F2 table listed only the two `XGROUP` shapes. `U87` is the case for it.
 */
const NO_SUCH_KEY_XINFO_REPLY = "ERR no such key";

/**
 * A transient `XINFO CONSUMERS` failure that is none of the classified shapes, for `U82`.
 *
 * Distinct from `TRANSIENT_READ_FAILURE` only in that it is the same text: reused deliberately,
 * because it is the same ioredis failure reaching a different command.
 */
const TRANSIENT_XINFO_FAILURE = TRANSIENT_READ_FAILURE;

/**
 * Invocation-order tokens for `U73` and `U84`.
 *
 * Two independent `toHaveBeenCalled()` checks pass in either order, and order is the entire
 * safety property here: deregistering *before* the drain is exactly P1, because this consumer's
 * own in-flight entries are still pending at that moment. `U7`/`U25`/`U31` use the same shape in
 * this repository for the same reason.
 */
const INVOCATION = {
  HANDLER: "handler",
  STOP: "stop",
  XINFO: "xinfo",
  DELCONSUMER: "delconsumer"
} as const;

/**
 * `0` **milliseconds** for a *real*-timer yield, distinct from `ADVANCE_NO_TIME_MS`.
 *
 * `setTimeout(..., 0)` is a macrotask, so awaiting it drains every pending microtask —  which
 * `await Promise.resolve()` at any repetition count does not (the
 * `waitForStartupToSettle` docblock in `tests/index.graceful-shutdown.unit.test.ts` measures
 * that at 2, 5, 10 and 20 turns). Named separately from `ADVANCE_NO_TIME_MS`, which is a
 * fake-timer *advance*, for the reason `INDEX` is named separately from `CALLS`: the numeral is
 * the same and the meaning is not.
 */
const NEXT_MACROTASK_MS = 0;

/**
 * One millisecond either side of `DRAIN_TIMEOUT_MS`, so `U74` can show the bound is the bound
 * rather than merely an upper limit: the drain is unsettled at `bound - 1` and settled at
 * `bound`.
 */
const TIMER_EPSILON_MS = 1;

/**
 * Position of `min-idle` in the `XAUTOCLAIM` argument vector
 * `[stream, group, consumer, minIdle, cursor, COUNT, batch]`.
 *
 * Named rather than written as a bare `3`, and declared beside the other positions for the
 * reason `INDEX`'s docblock gives. `U19` asserts the whole vector; `U70` needs this one slot,
 * to state that the cadence and the idle filter are the same product.
 */
const CLAIM_ARG_MIN_IDLE_INDEX = 3;

describe("StreamConsumer.run", () => {
  let mockRedis: {
    xgroup: ReturnType<typeof vi.fn>;
    xinfo: ReturnType<typeof vi.fn>;
    xreadgroup: ReturnType<typeof vi.fn>;
    xautoclaim: ReturnType<typeof vi.fn>;
    xack: ReturnType<typeof vi.fn>;
    duplicate: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  let readConnection: {
    xreadgroup: ReturnType<typeof vi.fn>;
    xautoclaim: ReturnType<typeof vi.fn>;
    xack: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  let mockLogger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
  let handled: Array<{ id: string; fields: readonly string[] }>;
  let handler: StreamMessageHandler;
  /**
   * Rejecters for calls a case has parked on the read connection, so the shared `disconnect`
   * mock can end them the way a real `disconnect()` was measured ending an in-flight read.
   *
   * A list rather than one slot: `U35` parks an `XAUTOCLAIM` and `U26` parks an `XREADGROUP`,
   * and `runLoop`'s `finally` disconnects a second time after the loop has broken.
   */
  let parkedRejections: Array<(reason: unknown) => void>;

  /** Every field the read command carries, each differing from its `WORKER_STREAM_CONSTANTS` default. */
  const loopEnv: Partial<ServiceEnv> = {
    REDIS_STREAM_NAME: OVERRIDE.STREAM_NAME,
    REDIS_CONSUMER_GROUP: OVERRIDE.CONSUMER_GROUP,
    REDIS_CONSUMER_NAME: OVERRIDE.CONSUMER_NAME,
    STREAM_BLOCK_MS: OVERRIDE.BLOCK_MS,
    STREAM_BATCH_SIZE: OVERRIDE.BATCH_SIZE
  };

  /**
   * A predicate that reports "keep going" for a counted number of **checks** and then "stop".
   *
   * `stopAfter(n)` permits exactly `n` checks, not `n` reads, and the difference is visible
   * whenever recovery paginates. The subject checks the predicate in three places: once at
   * the top of the loop, once between each pair of recovery pages (added for M-1), and once
   * per read iteration at the bottom of the `do`/`while`. So for a recovery that returns a
   * terminal cursor on its first page — which is every case using the default `xautoclaim`
   * mock — `stopAfter(n)` still permits `n` read iterations; `U19`, whose recovery spans two
   * pages, needs one more.
   *
   * Cases whose subject *is* the between-pages guard (`U36`) or the page limit (`U38`) use a
   * condition on the call counts instead, so that the guard being added did not change what
   * the case means.
   */
  const stopAfter = (iterations: number): (() => boolean) => {
    let checks = CALLS.NONE;

    return () => {
      const stop = checks >= iterations;
      checks += CALLS.ONCE;

      return stop;
    };
  };

  /**
   * A predicate that keeps going until `condition` holds, or until a deadline passes.
   *
   * For the cases whose subject is *where* the predicate is checked rather than how often —
   * a check count would beg the question there. The deadline is not a timeout dressed as a
   * stop condition: it exists so a case whose condition never becomes true fails on its own
   * assertions, naming the calls it did and did not see, instead of running until vitest
   * kills the file. Same shape as the integration suite's `buildLoopHarness`, and it is the
   * L-1 discipline applied to the cases added in this round.
   *
   * Real timers only: under fake timers `Date.now()` is frozen and the deadline never passes.
   */
  const stopWhen = (condition: () => boolean): (() => boolean) => {
    const deadline = Date.now() + STOP_DEADLINE_MS;

    return () => condition() || Date.now() >= deadline;
  };

  /**
   * Drives fake time forward in `ERROR_BACKOFF_MS` steps until `run()` settles.
   *
   * Replaces `await vi.advanceTimersByTimeAsync(ERROR_BACKOFF_MS); await runPromise;`, which
   * asserted the pause correctly on a healthy tree but, under any mutation that made the read
   * fail more than once, left `run()` waiting on a timer nothing would advance. The case then
   * died of vitest's 5 000 ms timeout naming nothing — five cases did exactly that under the
   * "read on the container connection" mutation (Round 1, L-1). This throws a message that
   * says what happened, and the surrounding assertions then report the real difference.
   *
   * Re-exposes a rejection: the inner `then` is only a settled-flag, and the awaited value is
   * `runPromise` itself.
   */
  const settleWithBackoffs = async (runPromise: Promise<void>): Promise<void> => {
    let settled = false;
    void runPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    for (let window = CALLS.NONE; window < MAX_BACKOFF_WINDOWS; window += CALLS.ONCE) {
      await vi.advanceTimersByTimeAsync(WORKER_STREAM_READ.ERROR_BACKOFF_MS);
      if (settled) {
        return runPromise;
      }
    }

    throw new Error(
      `run() did not settle within ${MAX_BACKOFF_WINDOWS} backoff windows of ${WORKER_STREAM_READ.ERROR_BACKOFF_MS} ms`
    );
  };

  const buildLoopConsumer = (
    isShuttingDown: () => boolean,
    messageHandler: StreamMessageHandler | undefined = handler
  ): StreamConsumer =>
    new StreamConsumer(
      mockRedis as unknown as Redis,
      mockLogger as unknown as Logger,
      loopEnv as ServiceEnv,
      isShuttingDown,
      messageHandler
    );

  /** Throws rather than returning undefined, so a missing call cannot pass vacuously. */
  const nthReadArgs = (index: number): unknown[] => {
    const call = readConnection.xreadgroup.mock.calls[index];
    if (!call) {
      throw new Error(`xreadgroup was never called a ${index + CALLS.ONCE}th time`);
    }

    return call;
  };

  /** Throws rather than returning undefined, so a missing call cannot pass vacuously. */
  const nthClaimArgs = (index: number): unknown[] => {
    const call = readConnection.xautoclaim.mock.calls[index];
    if (!call) {
      throw new Error(`xautoclaim was never called a ${index + CALLS.ONCE}th time`);
    }

    return call;
  };

  /**
   * A consumer built with **four** arguments, so it uses its own default handler.
   *
   * `buildLoopConsumer(pred, undefined)` cannot express this: the parameter has a default, so
   * passing `undefined` explicitly still selects the injected fixture handler. This is the
   * construction shape `src/index.ts` uses, i.e. the handler a deployed T-039 worker runs
   * (Round 1, M-4 / decision D-2).
   */
  const buildDefaultHandlerConsumer = (isShuttingDown: () => boolean): StreamConsumer =>
    new StreamConsumer(
      mockRedis as unknown as Redis,
      mockLogger as unknown as Logger,
      loopEnv as ServiceEnv,
      isShuttingDown
    );

  /**
   * `XINFO CONSUMERS`' argument vector. Throws rather than returning undefined, so a case that
   * asserts on it cannot pass against a subject that never read the registry.
   */
  const xinfoArgs = (): unknown[] => {
    const call = mockRedis.xinfo.mock.calls[INDEX.FIRST];
    if (!call) {
      throw new Error("xinfo was never called");
    }

    return call;
  };

  /**
   * Every `XGROUP` call whose subcommand is `DELCONSUMER`.
   *
   * A filter rather than a throwing locator, deliberately and against this repository's usual
   * rule: **zero is the assertion** in `U78`, `U79`, `U82` and `U87`, so a helper that threw on
   * "not found" could not express the case that matters most. `delconsumerArgs` below is the
   * throwing form, for the cases that assert the vector.
   *
   * Filtered by subcommand rather than counting `xgroup` calls, because `ensureConsumerGroup`
   * issues `XGROUP CREATE` on the same spy.
   */
  const delconsumerCalls = (): unknown[][] =>
    mockRedis.xgroup.mock.calls.filter(
      (call) => call[INDEX.FIRST] === WORKER_SHUTDOWN.SUBCOMMAND_DELCONSUMER
    );

  /** The single `DELCONSUMER` vector, or a throw. */
  const delconsumerArgs = (): unknown[] => {
    const call = delconsumerCalls()[INDEX.FIRST];
    if (!call) {
      throw new Error("XGROUP DELCONSUMER was never issued");
    }

    return call;
  };

  /**
   * A handler that blocks until released, and an order log shared with the Redis spies.
   *
   * The order log is what makes `U73` and `U84` non-tautological: two independent
   * `toHaveBeenCalled()` checks pass in either order, and "deregistered **after** the drain" is
   * the whole safety property — the other order is P1 against this consumer's own in-flight
   * entries.
   */
  const buildGatedHandler = (): {
    handler: StreamMessageHandler;
    order: string[];
    entered: () => boolean;
    settled: () => boolean;
    release: () => void;
  } => {
    const order: string[] = [];
    let entered = false;
    let settled = false;
    let release: (() => void) | undefined;

    return {
      order,
      entered: () => entered,
      settled: () => settled,
      release: () => release?.(),
      handler: async (id: string, fields: string[]): Promise<void> => {
        entered = true;
        handled.push({ id, fields });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        settled = true;
        order.push(INVOCATION.HANDLER);
      }
    };
  };

  /** Yields to the macrotask queue, draining every pending microtask. Real timers only. */
  const nextMacrotask = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, NEXT_MACROTASK_MS);
    });

  /**
   * Every argument list passed to every logger method, for the redaction negatives.
   *
   * Throws rather than yielding `[]` in both directions a vacuous pass could come from: a
   * missing mock method, and a subject that logged nothing at all. The earlier form
   * (`mockLogger.error?.mock.calls ?? []`) would have looped over nothing if the mock were
   * absent, which Round 1 flagged as N-1; it also looked only at `error`, so a payload leaked
   * through `info` or `warn` would not have been seen.
   */
  const allLogCalls = (): unknown[][] => {
    const methods = [mockLogger.info, mockLogger.warn, mockLogger.error, mockLogger.debug];
    const calls = methods.flatMap((method) => {
      if (!method) {
        throw new Error("the logger mock is missing a method the redaction check needs");
      }

      return method.mock.calls;
    });
    if (calls.length === CALLS.NONE) {
      throw new Error("the subject wrote no log line at all, so nothing was checked");
    }

    return calls;
  };

  beforeEach(() => {
    parkedRejections = [];
    readConnection = {
      xreadgroup: vi.fn().mockResolvedValue(null),
      xautoclaim: vi.fn().mockResolvedValue(autoclaimReply(WORKER_STREAM_READ.PENDING_START_ID, [])),
      // Present so that "nothing acknowledges anything" (D2-A) is an assertion rather than
      // an absence — `U34` checks it against the *default* handler, which is what a deployed
      // T-039 worker runs. Without the spy, an implementation that acknowledged would fail
      // with "xack is not a function" instead of naming the contract it broke.
      xack: vi.fn(),
      // Models what `disconnect()` was measured doing rather than doing nothing (T-043).
      //
      // **This is a fixture correction the drain forced, and it is a strengthening.** Re-measured
      // at Gate 3 on ioredis 5.11.1 / Redis 7.0.15: `disconnect()` issued 200 ms into a
      // `BLOCK 5000` read rejected that read at **t = 204 ms measured from the read**, i.e.
      // ~4 ms after the disconnect -- not 204 ms after it. Gate 5 measured the post-`disconnect`
      // interval directly at **0-2 ms**, which is what makes a *synchronous* fake faithful
      // (QA-2). Do not "correct" this fixture by adding a 204 ms delay: that would model an
      // interval nothing measured. A
      // `vi.fn()` that did nothing let `U26` and `U35` reject the parked call *after* `stop()`
      // had already returned — an ordering production cannot produce, and one that deadlocks the
      // moment `stop()` waits for the loop. Each case still supplies its own rejection value; a
      // call that has already settled ignores it.
      disconnect: vi.fn(() => {
        for (const reject of parkedRejections) {
          reject(new Error(CONNECTION_CLOSED_REJECTION));
        }
      })
    };
    mockRedis = {
      xgroup: vi.fn().mockResolvedValue("OK"),
      // The shutdown registry read (T-043). Defaults to an **empty** registry, which is the
      // `XINFO CONSUMERS` reply for a group nobody has read from — so the cases that were
      // written before T-043 and call `stop()` (`U26`, `U35`) find no row of their own and issue
      // no `DELCONSUMER`, which is what a consumer that never registered should do.
      xinfo: vi.fn().mockResolvedValue([]),
      xreadgroup: vi.fn(() => {
        throw new Error(MAIN_CONNECTION_READ);
      }),
      xautoclaim: vi.fn(() => {
        throw new Error(MAIN_CONNECTION_READ);
      }),
      xack: vi.fn(),
      duplicate: vi.fn(() => readConnection),
      disconnect: vi.fn()
    };
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn()
    };
    handled = [];
    handler = (id: string, fields: string[]): Promise<void> => {
      handled.push({ id, fields });

      return Promise.resolve();
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("U11 - reads with GROUP/COUNT/BLOCK/STREAMS > from the parsed env, not the defaults", async () => {
    await buildLoopConsumer(stopAfter(CALLS.ONCE)).run();

    expect(nthReadArgs(INDEX.FIRST)).toEqual([
      WORKER_STREAM_READ.SUBCOMMAND_GROUP,
      OVERRIDE.CONSUMER_GROUP,
      OVERRIDE.CONSUMER_NAME,
      WORKER_STREAM_READ.OPTION_COUNT,
      OVERRIDE.BATCH_SIZE,
      WORKER_STREAM_READ.OPTION_BLOCK,
      OVERRIDE.BLOCK_MS,
      WORKER_STREAM_READ.OPTION_STREAMS,
      OVERRIDE.STREAM_NAME,
      WORKER_STREAM_READ.NEW_ENTRIES_ONLY
    ]);

    // Negative half (AC1): a hard-coded default anywhere in the vector would show up here.
    const args = nthReadArgs(INDEX.FIRST);
    expect(args).not.toContain(WORKER_STREAM_CONSTANTS.DEFAULT_STREAM_NAME);
    expect(args).not.toContain(WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_GROUP);
    expect(args).not.toContain(WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_NAME);
    expect(args).not.toContain(WORKER_STREAM_CONSTANTS.DEFAULT_BLOCK_MS);
    expect(args).not.toContain(WORKER_STREAM_CONSTANTS.DEFAULT_BATCH_SIZE);

    // Pins the protocol tokens against the literals ioredis resolves its overload on. The
    // assertion above compares the vector to the same constants the implementation reads, so
    // it catches a code change but not a *value* change; these four lines catch the value
    // change. Same split `U9`'s docblock describes, and the same shape as `I5`'s `$` pin.
    expect(WORKER_STREAM_READ.SUBCOMMAND_GROUP).toBe("GROUP");
    expect(WORKER_STREAM_READ.OPTION_COUNT).toBe("COUNT");
    expect(WORKER_STREAM_READ.OPTION_BLOCK).toBe("BLOCK");
    expect(WORKER_STREAM_READ.OPTION_STREAMS).toBe("STREAMS");
    expect(WORKER_STREAM_READ.NEW_ENTRIES_ONLY).toBe(">");
  });

  it("U12 - treats a null reply as a timeout: no throw, no error log, loop continues", async () => {
    readConnection.xreadgroup.mockResolvedValue(null);

    await expect(buildLoopConsumer(stopAfter(CALLS.TWICE)).run()).resolves.toBeUndefined();

    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.TWICE);
    expect(handled).toEqual([]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("U27 - treats a stream tuple with no entries as a timeout as well", async () => {
    // The third observed reply shape, and the one a `!reply` guard alone does not cover:
    // `[[stream, []]]` is truthy. An implementation that indexed into it without a length
    // check would dispatch `undefined`.
    readConnection.xreadgroup.mockResolvedValue(streamReply([]));

    await expect(buildLoopConsumer(stopAfter(CALLS.TWICE)).run()).resolves.toBeUndefined();

    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.TWICE);
    expect(handled).toEqual([]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("U13 - dispatches every delivered entry to the handler once, in stream order", async () => {
    readConnection.xreadgroup.mockResolvedValueOnce(streamReply([ENTRY.FIRST, ENTRY.SECOND]));

    await buildLoopConsumer(stopAfter(CALLS.ONCE)).run();

    expect(handled).toEqual([
      { id: ENTRY.FIRST.id, fields: [...ENTRY.FIRST.fields] },
      { id: ENTRY.SECOND.id, fields: [...ENTRY.SECOND.fields] }
    ]);
  });

  it("U14 - does not read, recover, or even open a connection when the predicate is already true", async () => {
    // Scope (Gate 5 F-1, corrected at Gate 6 H-2/H-3; **narrowed at T-043**): this asserts what
    // `StreamConsumer` does -- the class in isolation. S-26 recorded that it was therefore *not*
    // evidence the line reaches a shutting-down worker's output, because `index.ts` discarded
    // `run()` and called `process.exit(0)` while `disconnect()` was still ~205 ms from rejecting
    // the parked read.
    //
    // **That clause is now false for the `stop()` path, and measured to be.** `stop()` awaits the
    // retained loop promise, and the loop writes both teardown lines in `runLoop`'s `finally`
    // before resolving, so `src/index.ts`'s existing `await streamConsumer?.stop()` cannot reach
    // `process.exit(0)` first.
    //
    // Measured by snapshotting the logger *inside* the `process.exit` spy (`U86`,
    // `tests/index.graceful-shutdown.unit.test.ts`) -- "inside", because `process.exit` does not
    // return, so "afterwards" is not a moment a real process has. Three bodies of `stop()`, three
    // arrays, **each labelled with the mutation that actually produces it**:
    //
    //   shipped                -> 7 entries; `"Stream read interrupted by shutdown"` and
    //                             `"Stream consumer loop stopped"` both present
    //   drain gate deleted,    -> 4: `["Created stream consumer group","Shutting down gracefully",
    //   deregistration kept        "Deregistered stream consumer","Shutdown complete"]`
    //   `stop()` reverted to   -> 3: `["Created stream consumer group","Shutting down gracefully",
    //   its pre-T-043 body         "Shutdown complete"]`
    //
    // Neither teardown line appears under **either** mutation, which is the load-bearing claim and
    // it survives both. An earlier revision of this comment quoted the three-element array against
    // "with the drain removed": that array is the *pre-T-043* one, and the drain-removed mutation
    // yields four entries because the deregistration still runs. The measurement was right and the
    // attribution was wrong -- caught at Gate 4 as HIGH-1, which is exactly the S-33 failure mode
    // this block is written in the style of.
    //
    // **What is still open, and why S-26 is narrowed rather than closed:** any exit that does not
    // run the `SIGTERM`/`SIGINT` handler -- `SIGKILL`, an orchestrator's grace period expiring
    // mid-drain, a `process.exit` from elsewhere -- still loses the lines, and a drain that hits
    // `WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS` reports the timeout instead of the teardown. Nothing is
    // lost in any of those: nothing is acknowledged, so entries stay reclaimable.
    //
    // S-26's block-length table (4 of 5 runs at `STREAM_BLOCK_MS=20`, 0 of 3 at 500, 0 of 1 at
    // 5000) and its "3-6 ms whole handler" figure are **inherited and were not re-derived here**
    // -- they need nine real SIGTERM process runs, and none of them is load-bearing for the claim
    // above.
    await buildLoopConsumer(() => true).run();

    expect(readConnection.xreadgroup).not.toHaveBeenCalled();
    expect(readConnection.xautoclaim).not.toHaveBeenCalled();
    expect(handled).toEqual([]);
    // No connection is opened at all, so the early return costs no socket.
    expect(mockRedis.duplicate).not.toHaveBeenCalled();
    // The log lines of both loop boundaries, which nothing asserted before Round 1 (L-3):
    // the early return says it did not start, and does *not* claim to have stopped — the
    // "stopped" line belongs to `run()`'s `finally`, which this path never enters.
    expect(mockLogger.info).toHaveBeenCalledWith(
      { streamName: OVERRIDE.STREAM_NAME, groupName: OVERRIDE.CONSUMER_GROUP },
      LOG_MESSAGE.LOOP_NOT_STARTED
    );
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      LOG_MESSAGE.LOOP_STOPPED
    );
  });

  it("U15 - stops after exactly one read when the predicate flips after one batch", async () => {
    readConnection.xreadgroup.mockResolvedValueOnce(streamReply([ENTRY.FIRST]));

    await buildLoopConsumer(stopAfter(CALLS.ONCE)).run();

    // The whole batch is dispatched before the loop re-checks — T-043's "exits after current
    // batch". A mid-batch check would abandon entries already delivered to this consumer.
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(handled).toHaveLength(CALLS.ONCE);
  });

  it("U16 - re-registers the group on NOGROUP and continues without a backoff pause", async () => {
    vi.useFakeTimers();
    readConnection.xreadgroup
      .mockRejectedValueOnce(new Error(NOGROUP_READ_REPLY))
      .mockResolvedValueOnce(null);

    const runPromise = buildLoopConsumer(stopAfter(CALLS.TWICE)).run();
    // Drains microtasks without moving the clock, and then asserts the immediate retry
    // *explicitly*. Previously this case installed fake timers, never advanced them, and let
    // completion stand in for "no pause" — which meant the "repaired but also backed off"
    // mutation failed it by a 5 000 ms timeout rather than by an assertion (Round 1, L-1).
    await vi.advanceTimersByTimeAsync(ADVANCE_NO_TIME_MS);
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.TWICE);
    // The `NOGROUP` repair is the one read failure that is not logged as one: no error line,
    // therefore no backoff, because the backoff only follows that line.
    expect(mockLogger.error).not.toHaveBeenCalled();
    await settleWithBackoffs(runPromise);

    // The bootstrap runs on the *main* connection, which is where `ensureConsumerGroup` has
    // always issued it; only the read moved to the duplicate.
    expect(mockRedis.xgroup).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(mockRedis.xgroup.mock.calls[INDEX.FIRST]).toEqual([
      WORKER_CONSUMER_GROUP_BOOTSTRAP.SUBCOMMAND_CREATE,
      OVERRIDE.STREAM_NAME,
      OVERRIDE.CONSUMER_GROUP,
      WORKER_CONSUMER_GROUP_BOOTSTRAP.START_ID_NEW_ENTRIES_ONLY,
      WORKER_CONSUMER_GROUP_BOOTSTRAP.OPTION_MKSTREAM
    ]);
    expect(WORKER_STREAM_READ.MISSING_GROUP_ERROR_PREFIX).toBe("NOGROUP");
  });

  it("U17 - logs stream, group, consumer and error, then pauses ERROR_BACKOFF_MS before retrying", async () => {
    vi.useFakeTimers();
    readConnection.xreadgroup
      .mockRejectedValueOnce(new Error(TRANSIENT_READ_FAILURE))
      .mockResolvedValueOnce(null);

    const runPromise = buildLoopConsumer(stopAfter(CALLS.TWICE)).run();
    // Drains microtasks without moving the clock: the rejection has been handled and logged,
    // and the retry must still be waiting.
    await vi.advanceTimersByTimeAsync(ADVANCE_NO_TIME_MS);

    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: TRANSIENT_READ_FAILURE
      },
      LOG_MESSAGE.READ_FAILED
    );
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.ONCE);

    await settleWithBackoffs(runPromise);

    // Survives the transient failure (hypothesis A), and only after the pause elapsed.
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.TWICE);
    expect(mockRedis.xgroup).not.toHaveBeenCalled();
  });

  it("U18 - stringifies a non-Error read rejection and still backs off", async () => {
    vi.useFakeTimers();
    expect(String(NON_ERROR_READ_REJECTION)).toBe(NON_ERROR_READ_REJECTION_AS_STRING);
    readConnection.xreadgroup
      .mockRejectedValueOnce(NON_ERROR_READ_REJECTION)
      .mockResolvedValueOnce(null);

    const runPromise = buildLoopConsumer(stopAfter(CALLS.TWICE)).run();
    await settleWithBackoffs(runPromise);

    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: NON_ERROR_READ_REJECTION_AS_STRING
      },
      LOG_MESSAGE.READ_FAILED
    );
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.TWICE);
  });

  it("U19 - reclaims with an idle threshold of blockMs x multiplier, paginating to completion", async () => {
    readConnection.xautoclaim
      .mockResolvedValueOnce(autoclaimReply(RECOVERY_NEXT_CURSOR, [ENTRY.RECLAIMED]))
      .mockResolvedValueOnce(
        autoclaimReply(WORKER_STREAM_READ.PENDING_START_ID, [ENTRY.RECLAIMED_SECOND])
      );

    // Two checks, not one, and the reason is a behaviour change rather than a fudge: the
    // pagination now re-checks the shutdown predicate between pages (M-1), so the second
    // page needs the predicate to still report "keep going" at that point. `U36` is the case
    // that owns the guard; this case owns the cursor, and the assertions below are unchanged.
    await buildLoopConsumer(stopAfter(CALLS.TWICE)).run();

    expect(readConnection.xautoclaim).toHaveBeenCalledTimes(CALLS.TWICE);
    expect(nthClaimArgs(INDEX.FIRST)).toEqual([
      OVERRIDE.STREAM_NAME,
      OVERRIDE.CONSUMER_GROUP,
      OVERRIDE.CONSUMER_NAME,
      OVERRIDE.BLOCK_MS * WORKER_STREAM_READ.RECOVERY_IDLE_MULTIPLIER,
      WORKER_STREAM_READ.PENDING_START_ID,
      WORKER_STREAM_READ.OPTION_COUNT,
      OVERRIDE.BATCH_SIZE
    ]);
    // The second call resumes at the cursor the first returned, and is otherwise identical.
    // Without the cursor, everything past the first page stays stranded until the next
    // restart — the defect the epic's single-call wording produces. Asserted as a whole
    // vector rather than by index, so a shifted argument list cannot slip through.
    expect(nthClaimArgs(INDEX.SECOND)).toEqual([
      OVERRIDE.STREAM_NAME,
      OVERRIDE.CONSUMER_GROUP,
      OVERRIDE.CONSUMER_NAME,
      OVERRIDE.BLOCK_MS * WORKER_STREAM_READ.RECOVERY_IDLE_MULTIPLIER,
      RECOVERY_NEXT_CURSOR,
      WORKER_STREAM_READ.OPTION_COUNT,
      OVERRIDE.BATCH_SIZE
    ]);
    // Negative half: the raw block value must not be the idle threshold.
    expect(nthClaimArgs(INDEX.FIRST)).not.toContain(OVERRIDE.BLOCK_MS);
    // Pins the multiplier's value (the epic's `blockMs * 2`), which the assertion above
    // cannot catch because both its sides read the same constant.
    expect(WORKER_STREAM_READ.RECOVERY_IDLE_MULTIPLIER).toBe(2);
    expect(WORKER_STREAM_READ.PENDING_START_ID).toBe("0-0");
  });

  it("U20 - dispatches reclaimed entries through the same handler as the loop", async () => {
    readConnection.xautoclaim.mockResolvedValueOnce(
      autoclaimReply(WORKER_STREAM_READ.PENDING_START_ID, [ENTRY.RECLAIMED])
    );
    readConnection.xreadgroup.mockResolvedValueOnce(streamReply([ENTRY.FIRST]));

    await buildLoopConsumer(stopAfter(CALLS.ONCE)).run();

    // Recovered first, then the live batch — one handler, one ordering.
    expect(handled).toEqual([
      { id: ENTRY.RECLAIMED.id, fields: [...ENTRY.RECLAIMED.fields] },
      { id: ENTRY.FIRST.id, fields: [...ENTRY.FIRST.fields] }
    ]);
  });

  it("U21 - a recovery failure is logged and does not prevent the loop from starting", async () => {
    readConnection.xautoclaim.mockRejectedValueOnce(new Error(TRANSIENT_READ_FAILURE));
    readConnection.xreadgroup.mockResolvedValueOnce(streamReply([ENTRY.FIRST]));

    await buildLoopConsumer(stopAfter(CALLS.ONCE)).run();

    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: TRANSIENT_READ_FAILURE
      },
      LOG_MESSAGE.RECOVERY_FAILED
    );
    // Best-effort: a worker that refuses to start because it could not reclaim old work is
    // strictly worse than one that starts and reclaims on the next restart.
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(handled).toEqual([{ id: ENTRY.FIRST.id, fields: [...ENTRY.FIRST.fields] }]);
  });

  it("U24 - reads on the duplicated connection and never on the container's", async () => {
    // Scope (Gate 5 F-1, corrected at Gate 6 H-2/H-3; **narrowed at T-043**): this asserts what
    // `StreamConsumer` does -- the class in isolation. S-26 recorded that it was therefore *not*
    // evidence the line reaches a shutting-down worker's output, because `index.ts` discarded
    // `run()` and called `process.exit(0)` while `disconnect()` was still ~205 ms from rejecting
    // the parked read.
    //
    // **That clause is now false for the `stop()` path, and measured to be.** `stop()` awaits the
    // retained loop promise, and the loop writes both teardown lines in `runLoop`'s `finally`
    // before resolving, so `src/index.ts`'s existing `await streamConsumer?.stop()` cannot reach
    // `process.exit(0)` first.
    //
    // Measured by snapshotting the logger *inside* the `process.exit` spy (`U86`,
    // `tests/index.graceful-shutdown.unit.test.ts`) -- "inside", because `process.exit` does not
    // return, so "afterwards" is not a moment a real process has. Three bodies of `stop()`, three
    // arrays, **each labelled with the mutation that actually produces it**:
    //
    //   shipped                -> 7 entries; `"Stream read interrupted by shutdown"` and
    //                             `"Stream consumer loop stopped"` both present
    //   drain gate deleted,    -> 4: `["Created stream consumer group","Shutting down gracefully",
    //   deregistration kept        "Deregistered stream consumer","Shutdown complete"]`
    //   `stop()` reverted to   -> 3: `["Created stream consumer group","Shutting down gracefully",
    //   its pre-T-043 body         "Shutdown complete"]`
    //
    // Neither teardown line appears under **either** mutation, which is the load-bearing claim and
    // it survives both. An earlier revision of this comment quoted the three-element array against
    // "with the drain removed": that array is the *pre-T-043* one, and the drain-removed mutation
    // yields four entries because the deregistration still runs. The measurement was right and the
    // attribution was wrong -- caught at Gate 4 as HIGH-1, which is exactly the S-33 failure mode
    // this block is written in the style of.
    //
    // **What is still open, and why S-26 is narrowed rather than closed:** any exit that does not
    // run the `SIGTERM`/`SIGINT` handler -- `SIGKILL`, an orchestrator's grace period expiring
    // mid-drain, a `process.exit` from elsewhere -- still loses the lines, and a drain that hits
    // `WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS` reports the timeout instead of the teardown. Nothing is
    // lost in any of those: nothing is acknowledged, so entries stay reclaimable.
    //
    // S-26's block-length table (4 of 5 runs at `STREAM_BLOCK_MS=20`, 0 of 3 at 500, 0 of 1 at
    // 5000) and its "3-6 ms whole handler" figure are **inherited and were not re-derived here**
    // -- they need nine real SIGTERM process runs, and none of them is load-bearing for the claim
    // above.
    readConnection.xreadgroup.mockResolvedValueOnce(streamReply([ENTRY.FIRST]));

    await buildLoopConsumer(stopAfter(CALLS.ONCE)).run();

    expect(mockRedis.duplicate).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(readConnection.xautoclaim).toHaveBeenCalledTimes(CALLS.ONCE);
    // Negative half, and the whole point of D1-B: a blocking read parked on the shared
    // connection was measured to delay an unrelated `PING` on it by 2 080 ms.
    expect(mockRedis.xreadgroup).not.toHaveBeenCalled();
    expect(mockRedis.xautoclaim).not.toHaveBeenCalled();
    // The duplicate is the loop's to own, so the loop closes it. Leaving it open would keep a
    // socket per restart of the loop.
    expect(readConnection.disconnect).toHaveBeenCalled();
    expect(mockRedis.disconnect).not.toHaveBeenCalled();
    // The `finally`'s log line, paired with `U14`'s assertion on the not-started line (L-3).
    expect(mockLogger.info).toHaveBeenCalledWith(
      { streamName: OVERRIDE.STREAM_NAME, groupName: OVERRIDE.CONSUMER_GROUP },
      LOG_MESSAGE.LOOP_STOPPED
    );
  });

  it("U26 - stop() ends an in-flight read quietly: no error log, loop terminates", async () => {
    // Scope (Gate 5 F-1, corrected at Gate 6 H-2/H-3; **narrowed at T-043**): this asserts what
    // `StreamConsumer` does -- the class in isolation. S-26 recorded that it was therefore *not*
    // evidence the line reaches a shutting-down worker's output, because `index.ts` discarded
    // `run()` and called `process.exit(0)` while `disconnect()` was still ~205 ms from rejecting
    // the parked read.
    //
    // **That clause is now false for the `stop()` path, and measured to be.** `stop()` awaits the
    // retained loop promise, and the loop writes both teardown lines in `runLoop`'s `finally`
    // before resolving, so `src/index.ts`'s existing `await streamConsumer?.stop()` cannot reach
    // `process.exit(0)` first.
    //
    // Measured by snapshotting the logger *inside* the `process.exit` spy (`U86`,
    // `tests/index.graceful-shutdown.unit.test.ts`) -- "inside", because `process.exit` does not
    // return, so "afterwards" is not a moment a real process has. Three bodies of `stop()`, three
    // arrays, **each labelled with the mutation that actually produces it**:
    //
    //   shipped                -> 7 entries; `"Stream read interrupted by shutdown"` and
    //                             `"Stream consumer loop stopped"` both present
    //   drain gate deleted,    -> 4: `["Created stream consumer group","Shutting down gracefully",
    //   deregistration kept        "Deregistered stream consumer","Shutdown complete"]`
    //   `stop()` reverted to   -> 3: `["Created stream consumer group","Shutting down gracefully",
    //   its pre-T-043 body         "Shutdown complete"]`
    //
    // Neither teardown line appears under **either** mutation, which is the load-bearing claim and
    // it survives both. An earlier revision of this comment quoted the three-element array against
    // "with the drain removed": that array is the *pre-T-043* one, and the drain-removed mutation
    // yields four entries because the deregistration still runs. The measurement was right and the
    // attribution was wrong -- caught at Gate 4 as HIGH-1, which is exactly the S-33 failure mode
    // this block is written in the style of.
    //
    // **What is still open, and why S-26 is narrowed rather than closed:** any exit that does not
    // run the `SIGTERM`/`SIGINT` handler -- `SIGKILL`, an orchestrator's grace period expiring
    // mid-drain, a `process.exit` from elsewhere -- still loses the lines, and a drain that hits
    // `WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS` reports the timeout instead of the teardown. Nothing is
    // lost in any of those: nothing is acknowledged, so entries stay reclaimable.
    //
    // S-26's block-length table (4 of 5 runs at `STREAM_BLOCK_MS=20`, 0 of 3 at 500, 0 of 1 at
    // 5000) and its "3-6 ms whole handler" figure are **inherited and were not re-derived here**
    // -- they need nine real SIGTERM process runs, and none of them is load-bearing for the claim
    // above.
    let readIssued = false;
    readConnection.xreadgroup.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          readIssued = true;
          // What `disconnect()` does to a read parked on the connection, measured: the in-flight
          // call rejects with `Error: Connection is closed.` — re-derived at Gate 3 at 204 ms
          // against a `BLOCK 5000`. Handing the rejecter to the shared `disconnect` mock rather
          // than firing it from the case body is the T-043 correction: `stop()` now awaits the
          // loop, so a rejection issued *after* `stop()` returned is an ordering the real client
          // cannot produce.
          parkedRejections.push(reject);
        })
    );
    // The predicate never flips. Termination therefore has to come from `stop()` alone, which
    // is what makes `stop()` self-sufficient rather than a hint to a flag someone else set.
    const consumer = buildLoopConsumer(() => false);
    const runPromise = consumer.run();
    await vi.waitFor(() => {
      if (!readIssued) {
        throw new Error("the read was never issued");
      }
    });

    await consumer.stop();
    // **Before `await runPromise`, and the position is the point** (Gate-4 LOW-1). The corrected
    // `disconnect` fake ends the parked read, so with `this.readConnection?.disconnect()` deleted
    // from `stop()` the read never rejects and `runPromise` never settles — awaiting it first
    // turned that mutation's failure into a bare `Test timed out in 5000ms`, which names nothing
    // and is the defect `U50`/`CASE_BUDGET_MS` exist to prevent. Asserted here, `stop()` has
    // already returned at the drain's 3 000 ms bound and the mutation reports by name.
    expect(readConnection.disconnect).toHaveBeenCalled();
    await expect(runPromise).resolves.toBeUndefined();

    expect(mockLogger.error).not.toHaveBeenCalled();
    // AC8's own line, pinned by text *and* fields (M-8). Until the Gate-6 review this case
    // asserted only the negative above, so deleting the whole `info` call left the suite
    // green -- "ends quietly" was tested, "and says so" was not.
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME
      },
      LOG_MESSAGE.READ_INTERRUPTED
    );
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.ONCE);
  });

  it("U28 - the same connection-closed rejection is a real error when nothing asked to stop", async () => {
    vi.useFakeTimers();
    readConnection.xreadgroup
      .mockRejectedValueOnce(new Error(CONNECTION_CLOSED_REJECTION))
      .mockResolvedValueOnce(null);

    const runPromise = buildLoopConsumer(stopAfter(CALLS.TWICE)).run();
    await settleWithBackoffs(runPromise);

    // The contrast that keeps `U26` from being vacuous: the quiet exit is conditional on a
    // shutdown having been requested, not on the message text. Without this case, classifying
    // *every* "Connection is closed." as a clean shutdown would pass `U26` and silently
    // convert a dropped connection into a healthy-looking stopped consumer.
    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: CONNECTION_CLOSED_REJECTION
      },
      LOG_MESSAGE.READ_FAILED
    );
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.TWICE);
    // Pins the constant against the text measured from a real `disconnect()` during a read.
    expect(WORKER_STREAM_READ.CONNECTION_CLOSED_ERROR_MESSAGE).toBe(CONNECTION_CLOSED_REJECTION);
  });

  it("U29 - a handler rejection is logged against its entry and the batch continues", async () => {
    readConnection.xreadgroup.mockResolvedValueOnce(streamReply([ENTRY.FIRST, ENTRY.SECOND]));
    const failingHandler: StreamMessageHandler = (id: string, fields: string[]) => {
      handled.push({ id, fields });

      return id === ENTRY.FIRST.id
        ? Promise.reject(new Error(HANDLER_FAILURE))
        : Promise.resolve();
    };

    await buildLoopConsumer(stopAfter(CALLS.ONCE), failingHandler).run();

    // The rest of the batch still runs. A handler failure is not a connection failure: routing
    // it through the read-error classifier would abandon every entry after the first and pause
    // the loop for ERROR_BACKOFF_MS.
    expect(handled.map((entry) => entry.id)).toEqual([ENTRY.FIRST.id, ENTRY.SECOND.id]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        entryId: ENTRY.FIRST.id,
        error: HANDLER_FAILURE
      },
      LOG_MESSAGE.HANDLER_FAILED
    );
    // Negative half: the entry id is logged, the payload never is. These fields carry
    // `tenantId` and customer-shaped metadata and this service has no redaction layer.
    for (const call of allLogCalls()) {
      expect(JSON.stringify(call)).not.toContain(ENTRY.FIRST.fields[INDEX.FIELD_VALUE]);
    }
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.ONCE);
    // "It did not take the backoff path", asserted rather than implied. This case used to
    // carry that claim with fake timers it never advanced, so removing the per-entry `catch`
    // failed it by a 5 000 ms timeout instead of naming the classification (Round 1, L-1).
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      LOG_MESSAGE.READ_FAILED
    );
  });

  it("U30 - a failed re-registration is logged and backed off rather than ending the loop", async () => {
    vi.useFakeTimers();
    readConnection.xreadgroup
      .mockRejectedValueOnce(new Error(NOGROUP_READ_REPLY))
      .mockResolvedValueOnce(null);
    mockRedis.xgroup.mockRejectedValueOnce(new Error(WRONGTYPE_REPLY));

    const runPromise = buildLoopConsumer(stopAfter(CALLS.TWICE)).run();
    await settleWithBackoffs(runPromise);

    // `ensureConsumerGroup` rethrows anything that is not BUSYGROUP, and an exception out of
    // the failure handler would end the loop — leaving a worker that answers /health while
    // consuming nothing, which is the failure this whole branch exists to prevent.
    expect(mockRedis.xgroup).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        error: WRONGTYPE_REPLY
      },
      LOG_MESSAGE.BOOTSTRAP_FAILED
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: NOGROUP_READ_REPLY
      },
      LOG_MESSAGE.READ_FAILED
    );
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.TWICE);
  });

  it("U32 - a failure opening the read connection is logged and run() still resolves", async () => {
    mockRedis.duplicate.mockImplementationOnce(() => {
      throw new Error(OPEN_READ_CONNECTION_FAILURE);
    });

    // The load-bearing half. `index.ts` starts the loop with `void`, so a rejection here is
    // an unhandled rejection, which Node >= 15 exits the process on: the worker would die
    // without a log line naming why. Round 1 refuted the claim that this could not happen.
    await expect(buildLoopConsumer(stopAfter(CALLS.ONCE)).run()).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: OPEN_READ_CONNECTION_FAILURE
      },
      LOG_MESSAGE.LOOP_FAILED
    );
    expect(readConnection.xreadgroup).not.toHaveBeenCalled();
  });

  it("U33 - a throwing shutdown predicate is logged, closes the connection, and run() resolves", async () => {
    let checks = CALLS.NONE;
    // Throws on its *second* call, i.e. from the `do`/`while` condition rather than from the
    // guard at the top. That is the harder path: it runs inside the `try` that owns the read
    // connection, so the case also pins that the `finally` still closes it.
    const throwingPredicate = (): boolean => {
      checks += CALLS.ONCE;
      if (checks > CALLS.ONCE) {
        throw new Error(PREDICATE_FAILURE);
      }

      return false;
    };

    await expect(buildLoopConsumer(throwingPredicate).run()).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: PREDICATE_FAILURE
      },
      LOG_MESSAGE.LOOP_FAILED
    );
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(readConnection.disconnect).toHaveBeenCalled();
  });

  it("U34 - the default handler logs the entry id, never the payload, and acknowledges nothing", async () => {
    readConnection.xreadgroup.mockResolvedValueOnce(streamReply([ENTRY.FIRST]));

    await buildDefaultHandlerConsumer(stopAfter(CALLS.ONCE)).run();

    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        entryId: ENTRY.FIRST.id
      },
      LOG_MESSAGE.DEFAULT_HANDLER_RECEIVED
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
    // The negative that matters, and the one no case covered before Round 1: the field vector
    // carries `tenantId` and customer-shaped event metadata, and this service has no
    // redaction layer. Checked across *every* logger method, not just `error`.
    for (const call of allLogCalls()) {
      expect(JSON.stringify(call)).not.toContain(ENTRY.FIRST.fields[INDEX.FIELD_VALUE]);
    }
    // D2-A's other half: the entry stays in the pending list, because nothing acknowledges
    // it. `I7` proves the same thing against a live Redis by reading `XPENDING` back.
    expect(readConnection.xack).not.toHaveBeenCalled();
    expect(mockRedis.xack).not.toHaveBeenCalled();
  });

  it("U35 - stop() during startup recovery ends quietly: info, not error", async () => {
    let claimIssued = false;
    readConnection.xautoclaim.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          claimIssued = true;
          // Ended by the shared `disconnect` mock rather than from the case body — see `U26`.
          parkedRejections.push(reject);
        })
    );
    // The predicate never flips, so the quiet exit has to come from `stop()` alone — the same
    // shape as `U26`, on the path `U26` does not reach.
    const consumer = buildLoopConsumer(() => false);
    const runPromise = consumer.run();
    await vi.waitFor(() => {
      if (!claimIssued) {
        throw new Error("the reclaim was never issued");
      }
    });

    await consumer.stop();
    // Before `await runPromise`, for the reason `U26` records at the same point (Gate-4 LOW-1):
    // without it, deleting `stop()`'s `disconnect()` fails this case as `Test timed out in
    // 5000ms` instead of naming the call that did not happen.
    expect(readConnection.disconnect).toHaveBeenCalled();
    await expect(runPromise).resolves.toBeUndefined();

    // AC8 is "a read interrupted by shutdown ends quietly: no error-level log". Before this
    // fix `isShutdownInterrupt` was consulted in `readBatch` and nowhere else, so the same
    // `Connection is closed.` that produced a quiet `info` during the read loop produced an
    // ERROR when it landed on an in-flight `XAUTOCLAIM` — a false alarm on every restart
    // that shuts down mid-recovery.
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME
      },
      LOG_MESSAGE.RECOVERY_INTERRUPTED
    );
    // One read still happens after recovery returns: the `do`/`while` checks its condition at
    // the bottom. Asserted rather than glossed, because `run()`'s docstring used to claim the
    // guard above gates the first read (Round 1, L-7). Against a real connection that read
    // rejects immediately — `stop()` has already disconnected it — and is classified by the
    // same `isShutdownInterrupt`.
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.ONCE);
  });

  it("U36 - recovery stops paginating once a stop is requested between pages", async () => {
    readConnection.xautoclaim
      .mockResolvedValueOnce(autoclaimReply(RECOVERY_NEXT_CURSOR, [ENTRY.RECLAIMED]))
      .mockResolvedValueOnce(
        autoclaimReply(WORKER_STREAM_READ.PENDING_START_ID, [ENTRY.RECLAIMED_SECOND])
      );

    // Flips exactly once the first page has been claimed, i.e. between pages. Keyed on the
    // claim count rather than a check count, so the guard being added does not change what
    // "between pages" means for this case.
    await buildLoopConsumer(
      stopWhen(() => readConnection.xautoclaim.mock.calls.length >= CALLS.ONCE)
    ).run();

    // Without the guard, recovery walks to `RECOVERY_MAX_PAGES` or to the terminal cursor
    // after being told to stop — 10 000 entries at the default batch size, all of it work
    // nobody asked for.
    expect(readConnection.xautoclaim).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(handled).toEqual([{ id: ENTRY.RECLAIMED.id, fields: [...ENTRY.RECLAIMED.fields] }]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        reclaimed: CALLS.ONCE
      },
      LOG_MESSAGE.RECOVERY_STOPPED
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("U37 - a reply element that is not an entry is counted, warned, and dropped whole", async () => {
    readConnection.xreadgroup.mockResolvedValueOnce([
      [OVERRIDE.STREAM_NAME, [MALFORMED_ENTRY, [ENTRY.FIRST.id, [...ENTRY.FIRST.fields]]]]
    ]);

    await buildLoopConsumer(stopAfter(CALLS.ONCE)).run();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        malformed: CALLS.ONCE
      },
      LOG_MESSAGE.MALFORMED_ELEMENTS
    );
    // The design claim the parser's docstring makes, and which nothing exercised before
    // Round 1 (L-3): one non-string field makes the **whole entry** malformed. Filtering the
    // bad element out instead would re-pair every following key with the wrong value, and the
    // entry stays in the pending list either way because nothing acknowledges it.
    expect(handled).toEqual([{ id: ENTRY.FIRST.id, fields: [...ENTRY.FIRST.fields] }]);
    expect(handled.map((entry) => entry.id)).not.toContain(MALFORMED_ENTRY[INDEX.FIRST]);
    // Malformed elements are a reply-shape problem, not a read failure: no error, no backoff.
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("U38 - recovery stops at RECOVERY_MAX_PAGES and the loop still starts", async () => {
    // A server that never returns the terminal cursor. The bound is a liveness guarantee, not
    // a capacity decision: without it the worker would paginate forever and never read.
    readConnection.xautoclaim.mockResolvedValue(autoclaimReply(RECOVERY_NEXT_CURSOR, []));

    await buildLoopConsumer(
      stopWhen(() => readConnection.xreadgroup.mock.calls.length >= CALLS.ONCE)
    ).run();

    expect(readConnection.xautoclaim).toHaveBeenCalledTimes(
      WORKER_STREAM_READ.RECOVERY_MAX_PAGES
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        pages: WORKER_STREAM_READ.RECOVERY_MAX_PAGES
      },
      LOG_MESSAGE.RECOVERY_PAGE_LIMIT
    );
    // Truncated recovery is best-effort, like a failed one: the loop starts anyway and the
    // remainder is reclaimed on the next restart.
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.ONCE);
  });
  it("U39 - a non-string XAUTOCLAIM cursor stops pagination rather than restarting it", async () => {
    // The reply the `typeof rawCursor === "string"` guard exists for. The entries on this page
    // are still claimed and dispatched — the cursor governs whether there is a *next* page.
    readConnection.xautoclaim
      .mockResolvedValueOnce([
        NON_STRING_CLAIM_CURSOR,
        [[ENTRY.RECLAIMED.id, [...ENTRY.RECLAIMED.fields]]],
        []
      ])
      // Only reached if the guard is removed. A second page that terminates keeps the mutation
      // failing by assertion rather than by the runner's timeout: without it, a cursor of
      // `String(null)` would be re-sent forever up to `RECOVERY_MAX_PAGES`.
      .mockResolvedValue(autoclaimReply(WORKER_STREAM_READ.PENDING_START_ID, []));

    // A condition on the read count, not `stopAfter`, and this is the whole case. `stopAfter`
    // counts predicate *checks*, and one of the subject's check sites is the between-pages
    // guard inside recovery — so `stopAfter(CALLS.ONCE)` stops the pagination itself, and
    // recovery makes exactly one claim whether the cursor guard is present or not. Measured:
    // with the guard mutated to `String(rawCursor)` this case passed 36/36 under `stopAfter`.
    // Keyed on the read instead, recovery is allowed to paginate as far as it wants to.
    // Same reason `U36` and `U38` use a condition rather than a check count.
    await buildLoopConsumer(
      stopWhen(() => readConnection.xreadgroup.mock.calls.length >= CALLS.ONCE)
    ).run();

    // "Stop paginating", not "start over": a `null` cursor coerced to a string would be sent
    // back as the next scan position, and `0-0` — the only terminal value — would never arrive
    // from a server that keeps replying in the same shape.
    expect(readConnection.xautoclaim).toHaveBeenCalledTimes(CALLS.ONCE);
    // The page that did arrive is not discarded by the guard.
    expect(handled).toEqual([{ id: ENTRY.RECLAIMED.id, fields: [...ENTRY.RECLAIMED.fields] }]);
    // A malformed cursor is not a recovery failure: recovery is best effort and the loop runs.
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("U70 - reclaims again inside one run(), once the cadence interval has elapsed", async () => {
    // The same entry comes back on every reclaim, which is what a permanently-failing entry
    // does: nothing acknowledges it, so it stays in the pending list.
    readConnection.xautoclaim.mockResolvedValue(
      autoclaimReply(WORKER_STREAM_READ.PENDING_START_ID, [ENTRY.RECLAIMED])
    );
    readConnection.xreadgroup.mockResolvedValue(null);

    const startedAt = Date.now();
    // Keyed on the claim count rather than `stopAfter`, for the reason `U39` gives: the
    // predicate is checked in three places, and a check count would decide the outcome of the
    // thing under test.
    await buildLoopConsumer(
      stopWhen(() => readConnection.xautoclaim.mock.calls.length >= CALLS.TWICE)
    ).run();
    const elapsed = Date.now() - startedAt;

    // Before T-041, `recoverPendingEntries` had exactly one call site -- before the `do`/`while`
    // -- so a second delivery of a failed entry required a **restart**. Measured independently:
    // `XREADGROUP ... >` does not redeliver an unacknowledged entry (a second read of the same
    // group returned empty while `XPENDING` still reported 1), so without this cadence the
    // dead-letter path could not fire in a worker that stays up.
    expect(readConnection.xautoclaim.mock.calls.length).toBeGreaterThanOrEqual(CALLS.TWICE);
    // And the entry really was re-offered to the handler -- the claim call on its own would
    // hold for a reclaim that returned nothing.
    expect(handled.filter((entry) => entry.id === ENTRY.RECLAIMED.id)).toHaveLength(
      CALLS.TWICE
    );

    // Not sooner than the interval. This is why `handled` has two and not two hundred: the
    // loop spins on a mock that resolves instantly, so an unconditional reclaim would have
    // claimed thousands of times inside the same window.
    expect(elapsed).toBeGreaterThanOrEqual(RECOVERY_CADENCE_MS);
    // The cadence is derived from the same threshold `XAUTOCLAIM`'s `min-idle` uses, not from a
    // new setting -- reclaiming more often than the idle threshold would find nothing anyway.
    expect(nthClaimArgs(INDEX.SECOND)[CLAIM_ARG_MIN_IDLE_INDEX]).toBe(RECOVERY_CADENCE_MS);
  });

  it("U71 - does not reclaim on every iteration: the cadence is the idle threshold, not the read", async () => {
    readConnection.xreadgroup.mockResolvedValue(null);

    const slowEnv: Partial<ServiceEnv> = { ...loopEnv, STREAM_BLOCK_MS: SLOW_BLOCK_MS };
    const startedAt = Date.now();
    await new StreamConsumer(
      mockRedis as unknown as Redis,
      mockLogger as unknown as Logger,
      slowEnv as ServiceEnv,
      stopWhen(
        () => readConnection.xreadgroup.mock.calls.length >= READS_INSIDE_ONE_WINDOW
      ),
      handler
    ).run();
    const elapsed = Date.now() - startedAt;

    // The premise, asserted rather than assumed: if the fixture took longer than one cadence
    // window, the claim below is about nothing and this line says so instead of passing.
    const cadenceMs = SLOW_BLOCK_MS * WORKER_STREAM_READ.RECOVERY_IDLE_MULTIPLIER;
    expect(elapsed, "the fixture ran longer than one cadence window").toBeLessThan(cadenceMs);

    expect(readConnection.xreadgroup.mock.calls.length).toBeGreaterThanOrEqual(
      READS_INSIDE_ONE_WINDOW
    );
    // Exactly the startup pass. An unconditional reclaim would make peer-stealing the loop's
    // steady state: `XAUTOCLAIM`'s idle filter still guards it, but a worker issuing the
    // command thousands of times a second against a live peer's work is a round trip per
    // iteration for nothing.
    expect(readConnection.xautoclaim).toHaveBeenCalledTimes(CALLS.ONCE);
  });

  // ---------------------------------------------------------------------------------------
  // T-043 — graceful shutdown: the bounded drain (slice 1) and the guarded deregistration
  // (slice 2).
  //
  // `stop()` was `{ this.stopRequested = true; this.readConnection?.disconnect(); }` before this
  // block. Against that body, **thirteen of the sixteen cases here go red** — re-measured at the
  // Gate-4 rework, after `U90` was added and the block was reordered:
  //
  //   red      U73 U74 U76 U77 U78 U80 U81 U82 U84 U87 U88 U89 U90
  //   not red  U75 U79 U83
  //
  // Headline failures, verbatim from that run: `U73` -> `expected [ 'stop' ] to deeply equal []`
  // (the pre-release check, i.e. `stop()` resolved while the handler was still in flight), and
  // `U77` -> `xinfo was never called`.
  //
  // **The three that do not go red are named rather than glossed**, because a block claiming
  // "every case was confirmed red" would be false and this comment said exactly that until the
  // Gate-4 rework. `U83` pins AC1, which was already satisfied before this task; `U75` and `U79`
  // guard behaviour the unfixed code cannot exhibit because it deregisters at all. Each carries
  // its own substitute mutation in its own comment: `U75` -> `drain()` returns `COMPLETED` for a
  // null `loopPromise`; `U79` -> `stop()` deregisters regardless of drain outcome; `U83` -> a
  // `shouldStop()` guard inside `dispatch`'s per-entry loop.
  // ---------------------------------------------------------------------------------------

  it("U73 - stop() does not resolve until an in-flight handler settles", async () => {
    const gate = buildGatedHandler();
    readConnection.xreadgroup.mockResolvedValueOnce(streamReply([ENTRY.FIRST]));
    // The predicate never flips: the drain has to be what ends this, not a stop condition the
    // loop was going to notice anyway.
    const consumer = buildLoopConsumer(() => false, gate.handler);
    const runPromise = consumer.run();
    await vi.waitFor(() => {
      if (!gate.entered()) {
        throw new Error("the handler was never entered");
      }
    });

    const stopPromise = consumer.stop().then(() => {
      gate.order.push(INVOCATION.STOP);
    });
    // A full macrotask turn, so every microtask the subject could schedule has run. Nothing here
    // can settle the handler, so a `stop()` that resolved would do so on its own account.
    await nextMacrotask();
    expect(gate.settled()).toBe(false);
    expect(gate.order).toEqual([]);

    gate.release();
    await stopPromise;
    await runPromise;

    // Order, not two independent "was called" checks: `['stop','handler']` is precisely the
    // pre-T-043 behaviour, and it is what this reported before the drain landed.
    expect(gate.order).toEqual([INVOCATION.HANDLER, INVOCATION.STOP]);
    expect(handled).toEqual([{ id: ENTRY.FIRST.id, fields: [...ENTRY.FIRST.fields] }]);
  });

  it("U74 - stop() resolves at the bound when the handler never settles, and logs the timeout", async () => {
    vi.useFakeTimers();
    const gate = buildGatedHandler();
    readConnection.xreadgroup.mockResolvedValueOnce(streamReply([ENTRY.FIRST]));
    const consumer = buildLoopConsumer(() => false, gate.handler);
    const runPromise = consumer.run();
    await vi.advanceTimersByTimeAsync(ADVANCE_NO_TIME_MS);
    expect(gate.entered()).toBe(true);

    let stopSettled = false;
    const stopPromise = consumer.stop().then(() => {
      stopSettled = true;
    });

    // One millisecond short of the bound: still waiting. Without this half the case would pass
    // against an implementation with no bound at all *and* against one that never waited.
    await vi.advanceTimersByTimeAsync(WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS - TIMER_EPSILON_MS);
    expect(stopSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(TIMER_EPSILON_MS);
    await stopPromise;

    expect(stopSettled).toBe(true);
    // The handler is *still* hanging. "Bounded" means `stop()` gave up on it, not that it ended.
    expect(gate.settled()).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        drainTimeoutMs: WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS
      },
      LOG_MESSAGE.DRAIN_TIMED_OUT
    );

    // The floor `DRAIN_TIMEOUT_MS`'s docblock argues for, asserted rather than left to prose: a
    // bound **below** `ERROR_BACKOFF_MS` makes a shutdown that lands during a failing loop's
    // pause liable to time out, and a timed-out drain suppresses the deregistration (`U79`) —
    // so the guard would stop deregistering exactly when a worker is unhealthy.
    //
    // Not "every time": measured false in both directions at Gate 5 (QA-1). At a bound equal to
    // `ERROR_BACKOFF_MS` it essentially never times out; at 500 ms it timed out at 3 of 4
    // offsets sampled across the pause. Common enough to reject the bound, not universal.
    expect(WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS).toBeGreaterThan(
      WORKER_STREAM_READ.ERROR_BACKOFF_MS
    );

    gate.release();
    await vi.advanceTimersByTimeAsync(ADVANCE_NO_TIME_MS);
    await runPromise;
  });

  it("U75 - stop() before run() resolves and issues no Redis command", async () => {
    const consumer = buildLoopConsumer(() => false);

    await expect(consumer.stop()).resolves.toBeUndefined();

    // Nothing was ever registered, so there is nothing to read and nothing to delete. The
    // negative on `xgroup` is the one that matters: `DELCONSUMER` against a name this process
    // never used is harmless today (measured: returns `0`, no error) but it is a round trip
    // issued on a guess, and under an operator-set shared name (plan R4) the name is not ours.
    expect(mockRedis.xinfo).not.toHaveBeenCalled();
    expect(mockRedis.xgroup).not.toHaveBeenCalled();
    expect(mockRedis.duplicate).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("U76 - stop() twice deregisters at most once", async () => {
    mockRedis.xinfo.mockResolvedValue([
      consumerInfoRow(OVERRIDE.CONSUMER_NAME, CONSUMER_PENDING.NONE)
    ]);
    const consumer = buildLoopConsumer(stopAfter(CALLS.ONCE));
    await consumer.run();

    await consumer.stop();
    await consumer.stop();

    // `index.ts` calls `stop()` once, but nothing stops a second caller — and the second
    // `DELCONSUMER` is not a harmless repeat: between the two calls a *restarted* instance could
    // have taken the same name (an operator-pinned one), and the repeat would then delete a live
    // consumer's registration. At most once, keyed on the attempt rather than on its outcome.
    expect(delconsumerCalls()).toHaveLength(CALLS.ONCE);
    expect(mockRedis.xinfo).toHaveBeenCalledTimes(CALLS.ONCE);
  });

  it("U77 - deregisters this consumer when its own row reports pending 0", async () => {
    mockRedis.xinfo.mockResolvedValue([
      // A live peer, holding work. Present so that a guard reading "the first row", "any row" or
      // a group-wide total fails here rather than shipping.
      consumerInfoRow(OTHER_CONSUMER_NAME, CONSUMER_PENDING.SOME),
      consumerInfoRow(OVERRIDE.CONSUMER_NAME, CONSUMER_PENDING.NONE)
    ]);
    const consumer = buildLoopConsumer(stopAfter(CALLS.ONCE));
    await consumer.run();

    await consumer.stop();

    expect(xinfoArgs()).toEqual([
      WORKER_SHUTDOWN.SUBCOMMAND_CONSUMERS,
      OVERRIDE.STREAM_NAME,
      OVERRIDE.CONSUMER_GROUP
    ]);
    expect(delconsumerArgs()).toEqual([
      WORKER_SHUTDOWN.SUBCOMMAND_DELCONSUMER,
      OVERRIDE.STREAM_NAME,
      OVERRIDE.CONSUMER_GROUP,
      OVERRIDE.CONSUMER_NAME
    ]);
    // The negative that the vector assertion above does not make on its own: the peer's name
    // appears nowhere in what was deleted.
    expect(delconsumerArgs()).not.toContain(OTHER_CONSUMER_NAME);
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME
      },
      LOG_MESSAGE.DEREGISTERED
    );
  });

  it("U78 - does not deregister while its own row still reports pending entries", async () => {
    mockRedis.xinfo.mockResolvedValue([
      consumerInfoRow(OVERRIDE.CONSUMER_NAME, CONSUMER_PENDING.SOME)
    ]);
    const consumer = buildLoopConsumer(stopAfter(CALLS.ONCE));
    await consumer.run();

    await consumer.stop();

    // **The case this whole task exists for.** Measured on Redis 7.0.15 (probe P1, re-run at
    // Gate 3): `XGROUP DELCONSUMER` against a consumer holding two pending entries returned `2`,
    // `XPENDING` dropped to 0, and `XAUTOCLAIM ... 0 0-0` and `XREADGROUP ... >` both came back
    // empty while `XLEN` still reported 2 — the entries unreachable through the group, forever,
    // with no error raised. A lingering registration row is cosmetic; this is unrecoverable.
    expect(delconsumerCalls()).toHaveLength(CALLS.NONE);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        pending: CONSUMER_PENDING.SOME
      },
      LOG_MESSAGE.DEREGISTER_SKIPPED_PENDING
    );
  });

  it("U79 - does not deregister when the drain timed out", async () => {
    vi.useFakeTimers();
    mockRedis.xinfo.mockResolvedValue([
      // Reports zero — i.e. the reading that *would* permit the delete. The suppression must come
      // from the timeout, not from the count, which is why this row says what it says.
      consumerInfoRow(OVERRIDE.CONSUMER_NAME, CONSUMER_PENDING.NONE)
    ]);
    const gate = buildGatedHandler();
    readConnection.xreadgroup.mockResolvedValueOnce(streamReply([ENTRY.FIRST]));
    const consumer = buildLoopConsumer(() => false, gate.handler);
    const runPromise = consumer.run();
    await vi.advanceTimersByTimeAsync(ADVANCE_NO_TIME_MS);

    const stopPromise = consumer.stop();
    await vi.advanceTimersByTimeAsync(WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS);
    await stopPromise;

    // Fail closed. On a timeout we cannot show what this consumer still holds — the handler is
    // mid-flight and its entry is still pending by construction — so the registry reading is not
    // even taken. The lingering row is the *point*: it leaves the abandoned work visible to an
    // operator instead of hiding a hung handler behind a clean-looking shutdown (plan R2).
    expect(mockRedis.xinfo).not.toHaveBeenCalled();
    expect(delconsumerCalls()).toHaveLength(CALLS.NONE);

    gate.release();
    await vi.advanceTimersByTimeAsync(ADVANCE_NO_TIME_MS);
    await runPromise;
  });

  it("U80 - a NOGROUP reply to the deregistration is logged and does not throw out of stop()", async () => {
    mockRedis.xinfo.mockResolvedValue([
      consumerInfoRow(OVERRIDE.CONSUMER_NAME, CONSUMER_PENDING.NONE)
    ]);
    mockRedis.xgroup.mockRejectedValue(new Error(NOGROUP_DELCONSUMER_REPLY));
    const consumer = buildLoopConsumer(stopAfter(CALLS.ONCE));
    await consumer.run();

    await expect(consumer.stop()).resolves.toBeUndefined();

    // `info`, not `error`. A group destroyed before the worker stopped is a normal deploy shape,
    // and paging someone for it is the false alarm `U35`'s `RECOVERY_INTERRUPTED` was written to
    // stop.
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: NOGROUP_DELCONSUMER_REPLY
      },
      LOG_MESSAGE.DEREGISTER_GROUP_GONE
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("U81 - the missing-key XGROUP reply is classified the same way, and it shares no prefix with NOGROUP", async () => {
    mockRedis.xinfo.mockResolvedValue([
      consumerInfoRow(OVERRIDE.CONSUMER_NAME, CONSUMER_PENDING.NONE)
    ]);
    mockRedis.xgroup.mockRejectedValue(new Error(MISSING_KEY_DELCONSUMER_REPLY));
    const consumer = buildLoopConsumer(stopAfter(CALLS.ONCE));
    await consumer.run();

    await expect(consumer.stop()).resolves.toBeUndefined();

    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: MISSING_KEY_DELCONSUMER_REPLY
      },
      LOG_MESSAGE.DEREGISTER_GROUP_GONE
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
    // Plan finding F2, asserted rather than described. `WORKER_STREAM_READ`'s constant is named
    // `MISSING_GROUP_ERROR_PREFIX` and classifies `NOGROUP` only; this reply describes the same
    // condition and shares no prefix with it, so a classifier that reused that one constant
    // reports this shutdown as an unexpected error. Sourcing both sides from `src/` would be
    // tautological, so the *reply* is the literal above and only the constant comes from `src/`.
    expect(MISSING_KEY_DELCONSUMER_REPLY.startsWith(WORKER_STREAM_READ.MISSING_GROUP_ERROR_PREFIX)).toBe(
      false
    );
  });

  it("U82 - an XINFO CONSUMERS failure suppresses the delete and does not throw", async () => {
    mockRedis.xinfo.mockRejectedValue(new Error(TRANSIENT_XINFO_FAILURE));
    const consumer = buildLoopConsumer(stopAfter(CALLS.ONCE));
    await consumer.run();

    await expect(consumer.stop()).resolves.toBeUndefined();

    // No reading, no delete. This is the branch where the asymmetry decides: a lingering
    // registration row costs nothing recoverable, and deleting on a reading we could not take is
    // P1 with the guard removed.
    expect(delconsumerCalls()).toHaveLength(CALLS.NONE);
    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: TRANSIENT_XINFO_FAILURE
      },
      LOG_MESSAGE.DEREGISTER_SKIPPED_UNREADABLE
    );
  });

  it("U83 - a predicate flipping mid-batch still lets every entry in the batch reach the handler", async () => {
    // **AC1, which was already satisfied before this task — so this case pins behaviour rather
    // than driving it, and it did not go red before the implementation.** Stated plainly because
    // a case that never failed proves nothing on its own. The mutation that establishes it, run
    // at Gate 3: add a `if (this.shouldStop()) return;` to the top of `dispatch`'s per-entry
    // loop. This case reports
    // `expected [ '1789101023800-0' ] to deeply equal [ '1789101023800-0', ...(2) ]`.
    //
    // Stated as measured: that mutation is **not** surgical — it reddens **eleven** cases, because
    // `stopAfter(n)` counts predicate *checks* and an extra check per entry shifts every case
    // that uses it. The full set, re-counted at the Gate-4 rework by reading the runner's own
    // failure list rather than by eye: `U13`, `U15`, `U19`, `U20`, `U21`, `U29`, `U34`, `U36`,
    // `U37`, `U70`, `U83` — `Tests 11 failed | 43 passed (54)`. An earlier revision of this
    // comment said nine and omitted `U37` and `U70`; caught at Gate 4 as LOW-2, which is S-33's
    // pattern occurring inside a comment written in S-33's style.
    //
    // What makes this case the one that *names* the defect is that its assertion is the batch's
    // contents rather than a call count.
    readConnection.xreadgroup.mockResolvedValueOnce(
      streamReply([ENTRY.FIRST, ENTRY.SECOND, ENTRY.RECLAIMED])
    );
    let shuttingDown = false;
    const flipOnFirstEntry: StreamMessageHandler = (id: string, fields: string[]) => {
      handled.push({ id, fields });
      // Flips while the batch is still being walked — the condition a mid-batch check would act
      // on. Entries already delivered to this consumer are not *lost* if it did (nothing is
      // acknowledged), but they would sit out an idle timeout for no reason.
      shuttingDown = true;

      return Promise.resolve();
    };

    await buildLoopConsumer(() => shuttingDown, flipOnFirstEntry).run();

    expect(handled.map((entry) => entry.id)).toEqual([
      ENTRY.FIRST.id,
      ENTRY.SECOND.id,
      ENTRY.RECLAIMED.id
    ]);
    // And the loop still exits at the next iteration boundary rather than reading again.
    expect(readConnection.xreadgroup).toHaveBeenCalledTimes(CALLS.ONCE);
  });

  it("U84 - the deregistration is issued after the drain, by invocation order", async () => {
    const gate = buildGatedHandler();
    mockRedis.xinfo.mockImplementation(() => {
      gate.order.push(INVOCATION.XINFO);

      return Promise.resolve([consumerInfoRow(OVERRIDE.CONSUMER_NAME, CONSUMER_PENDING.NONE)]);
    });
    mockRedis.xgroup.mockImplementation((subcommand: unknown) => {
      if (subcommand === WORKER_SHUTDOWN.SUBCOMMAND_DELCONSUMER) {
        gate.order.push(INVOCATION.DELCONSUMER);
      }

      return Promise.resolve(CALLS.ONCE);
    });
    readConnection.xreadgroup.mockResolvedValueOnce(streamReply([ENTRY.FIRST]));
    const consumer = buildLoopConsumer(() => false, gate.handler);
    const runPromise = consumer.run();
    await vi.waitFor(() => {
      if (!gate.entered()) {
        throw new Error("the handler was never entered");
      }
    });

    const stopPromise = consumer.stop();
    await nextMacrotask();
    // Nothing may be read or deleted while our own entry is still in flight: at this instant it
    // is pending, so a registry read here would report `pending 1` at best and a delete would be
    // P1 against our own work at worst.
    expect(gate.order).toEqual([]);

    gate.release();
    await stopPromise;
    await runPromise;

    // Order, not three independent "was called" checks — those pass in any order, and the order
    // is the safety property.
    expect(gate.order).toEqual([
      INVOCATION.HANDLER,
      INVOCATION.XINFO,
      INVOCATION.DELCONSUMER
    ]);
  });

  it("U87 - the ERR no such key reply to XINFO CONSUMERS is classified as gone, not as a fault", async () => {
    mockRedis.xinfo.mockRejectedValue(new Error(NO_SUCH_KEY_XINFO_REPLY));
    const consumer = buildLoopConsumer(stopAfter(CALLS.ONCE));
    await consumer.run();

    await expect(consumer.stop()).resolves.toBeUndefined();

    // A **third** reply shape for "the group or key is gone", measured at Gate 3 and absent from
    // the plan's F2 table, which listed only the two `XGROUP` shapes. `XINFO CONSUMERS` against a
    // deleted stream key replies `ERR no such key` — sharing a prefix with neither `NOGROUP` nor
    // `ERR The XGROUP subcommand requires the key to exist...`. Without this classification every
    // shutdown after a stream deletion logs at ERROR.
    expect(delconsumerCalls()).toHaveLength(CALLS.NONE);
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: NO_SUCH_KEY_XINFO_REPLY
      },
      LOG_MESSAGE.DEREGISTER_GROUP_GONE
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(
      NO_SUCH_KEY_XINFO_REPLY.startsWith(WORKER_STREAM_READ.MISSING_GROUP_ERROR_PREFIX)
    ).toBe(false);
  });

  it("U88 - does not issue a delete when no registry row carries this consumer's name", async () => {
    // `XINFO CONSUMERS` for a group nobody has read from — measured at Gate 3 as `[]`, and the
    // state a worker is in when its loop opened, reclaimed nothing and read nothing.
    mockRedis.xinfo.mockResolvedValue([]);
    const consumer = buildLoopConsumer(stopAfter(CALLS.ONCE));
    await consumer.run();

    await consumer.stop();

    // **Skipping here is a deliberate departure from the plan**, which said to delete on an
    // absent name on the grounds that it is idempotent (measured: `DELCONSUMER` against a name
    // that never existed returns `0` and does not error). It is idempotent, and it is still the
    // wrong default: under an operator-pinned shared `REDIS_CONSUMER_NAME` (plan R4) "absent
    // when I looked" is exactly the P11 race — a peer can create the row and take an entry
    // between the read and the delete, and the delete then destroys it. Identical end state, one
    // fewer round trip, strictly less risk.
    //
    // The mutation that establishes it, run at Gate 3 — and it has to be the mutation that
    // expresses the *plan's* alternative, not merely one that deletes a branch. Make
    // `parseConsumerReading` return `{ kind: FOUND, pending: NO_PENDING_ENTRIES }` where it
    // returns `ABSENT`, i.e. read "no row" as "no pending entries": this case then reports
    // `expected [ [ 'DELCONSUMER', ...(3) ] ] to have a length of +0 but got 1`.
    //
    // Recorded because the first mutation tried was weaker and its write-up was wrong.
    // Commenting out the `ABSENT` branch alone leaves `reading.pending` `undefined` at runtime,
    // `undefined !== 0` takes the pending-entries branch, and **no delete is issued** — so the
    // case failed on the log assertion below rather than on the one above, and "this line is what
    // stops the delete" would have been asserted by a run that did not show it.
    expect(delconsumerCalls()).toHaveLength(CALLS.NONE);
    expect(mockRedis.xinfo).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME
      },
      LOG_MESSAGE.DEREGISTER_NOT_REGISTERED
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("U89 - an XINFO CONSUMERS reply the parser does not recognise is not read as pending 0", async () => {
    // The reply arrives, so the `catch` in `deregisterConsumer` never runs — this is the *parse*
    // branch, and it is the one that decides what "unknown" means. **Unknown is not zero.** A
    // parser that fell back to a zero reading on a shape it did not understand would issue the
    // delete against a consumer whose pending count it had never actually seen, which is P1 with
    // an extra step.
    //
    // The shape is deliberately close to a real row rather than obviously junk: the field names
    // are right and only `pending`'s *type* is wrong, which is what a protocol change (RESP3, a
    // future encoding) would most plausibly produce. Measured at Gate 3 on this Redis through
    // ioredis 5.11.1, `pending` came back a JavaScript `number`; the string here is the shape
    // that is *not* what was measured.
    mockRedis.xinfo.mockResolvedValue([
      [
        "name",
        OVERRIDE.CONSUMER_NAME,
        "pending",
        String(CONSUMER_PENDING.NONE),
        "idle",
        OBSERVED_CONSUMER_IDLE_MS
      ]
    ]);
    const consumer = buildLoopConsumer(stopAfter(CALLS.ONCE));
    await consumer.run();

    await expect(consumer.stop()).resolves.toBeUndefined();

    expect(delconsumerCalls()).toHaveLength(CALLS.NONE);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME
      },
      LOG_MESSAGE.DEREGISTER_SKIPPED_UNPARSEABLE
    );
  });

  it("U90 - an unclassified DELCONSUMER rejection is logged at ERROR and still does not throw", async () => {
    // The branch `U80`/`U81`/`U87` do **not** reach: those three assert the *classified* replies,
    // which are logged at `info` because a group or key that is already gone is a normal deploy
    // shape. This is the other side of that split — a Redis fault during the delete — and it is
    // the one case that decides whether a real failure surfaces at ERROR or is quietly downgraded
    // to the same `info` line as a benign one.
    //
    // Until Gate 4 this branch had no case at all, and `LOG_MESSAGE.DEREGISTER_FAILED` was
    // declared and never asserted — a constant naming a branch nothing reached, which is evidence
    // the case was planned and dropped (Gate-4 MEDIUM-1). `src/events/**` is outside this
    // package's coverage collection (S-25), so no percentage would ever have flagged it.
    //
    // **Two mutations, both run at the Gate-4 rework, because the branch has two halves.**
    //
    //   delete the `catch` around `XGROUP DELCONSUMER` in `deleteConsumerIfIdle`
    //     -> this case reports `promise rejected "Error: Reached the max retries per request
    //        limit (which is 2)..." instead of resolving` — the failure escapes `stop()` and
    //        would take `index.ts`'s shutdown handler into its `catch` and `process.exit(1)`.
    //        Collateral, stated rather than omitted: `U80` and `U81` go red too, with the same
    //        shape, because they share the `catch`. Three red, not one.
    //   `const gone = error instanceof Error` in `logDeregistrationFailure`, i.e. classify
    //   every failure as benign
    //     -> `U90` and `U82` red, on the ERROR assertions; `U80`, `U81`, `U87` stay green,
    //        because downgrading everything to `info` is invisible to the cases that expect
    //        `info`. This is the half that pins the *level*, and it is the mutation the
    //        surrounding `U80`/`U81`/`U87` cannot catch.
    mockRedis.xinfo.mockResolvedValue([
      consumerInfoRow(OVERRIDE.CONSUMER_NAME, CONSUMER_PENDING.NONE)
    ]);
    mockRedis.xgroup.mockRejectedValue(new Error(TRANSIENT_READ_FAILURE));
    const consumer = buildLoopConsumer(stopAfter(CALLS.ONCE));
    await consumer.run();

    // Does not throw: a shutdown path that rejects is a worker that exits non-zero because it
    // could not tidy a registry row.
    await expect(consumer.stop()).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: TRANSIENT_READ_FAILURE
      },
      LOG_MESSAGE.DEREGISTER_FAILED
    );
    // ERROR, *not* the benign classification. Without this negative, a classifier that matched
    // everything would pass the assertion above only if it also still logged at error — which it
    // would not, and this is the line that says so.
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      LOG_MESSAGE.DEREGISTER_GROUP_GONE
    );
    // The delete really was attempted — otherwise this case would pass against an implementation
    // that never issued the command at all.
    expect(delconsumerCalls()).toHaveLength(CALLS.ONCE);
  });

  it("U91 - a loop that rejected is a loop that finished: the drain still deregisters", async () => {
    // **The third arm of the drain, and the only one nothing reached.** `drain()` maps the loop
    // promise through `.then(onFulfilled, onRejected)` and both arms return `COMPLETED`; mutating
    // the **rejected** arm to `TIMED_OUT` left the package 179/179 green (Gate-6 finding).
    //
    // Reaching it needs a `runLoop()` that *rejects*, and `duplicate()` is the cheap way in: it is
    // called **outside** `runLoop`'s `try`, so a throw there rejects the loop promise rather than
    // being swallowed — the same seam `U32` uses, and the reason `U32` exists at all. No wedged
    // handler, no fake timers, no wall-clock cost: `Promise.race` settles on the already-rejected
    // arm in a microtask and the losing timer is cleared.
    //
    // **What this pins is the consequence, not the branch.** A rejected drain classified as
    // `TIMED_OUT` would suppress the deregistration (`U79`'s contract) and emit the abandoned-work
    // WARN — so every worker whose loop died on a bad connection would leak a registry row and
    // report abandoned work it does not have. That is the fail-closed direction, which is why the
    // gap was LOW and not higher: the mutation loses a row, it does not destroy an entry.
    //
    // **The mutation that establishes it**, re-derived at this round against the current tree
    // rather than cited by line: in `drain()`'s `loopPromise.then(onFulfilled, onRejected)`,
    // change the **second** callback (`onRejected`) from `() => DRAIN_OUTCOME.COMPLETED` to
    // `() => DRAIN_OUTCOME.TIMED_OUT`. Changing the **first** callback instead leaves this case
    // green — which is the check that it isolates the arm it names rather than passing on the
    // fulfilment path. Both runs are recorded in the Gate-6 report.
    mockRedis.xinfo.mockResolvedValue([
      consumerInfoRow(OVERRIDE.CONSUMER_NAME, CONSUMER_PENDING.NONE)
    ]);
    mockRedis.duplicate.mockImplementationOnce(() => {
      throw new Error(OPEN_READ_CONNECTION_FAILURE);
    });
    const consumer = buildLoopConsumer(stopAfter(CALLS.ONCE));

    await expect(consumer.run()).resolves.toBeUndefined();
    await expect(consumer.stop()).resolves.toBeUndefined();

    // **Anti-vacuity first: the loop really did reject.** Without these two, the case would pass
    // against a `duplicate()` that never threw — i.e. against the ordinary *fulfilment* path — and
    // the mutation above would be invisible to it. `LOOP_FAILED` is written only by `run()`'s
    // `catch`, so it is evidence of a rejection rather than of a tidy exit.
    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        streamName: OVERRIDE.STREAM_NAME,
        groupName: OVERRIDE.CONSUMER_GROUP,
        consumerName: OVERRIDE.CONSUMER_NAME,
        error: OPEN_READ_CONNECTION_FAILURE
      },
      LOG_MESSAGE.LOOP_FAILED
    );
    expect(readConnection.xreadgroup).not.toHaveBeenCalled();

    // The behaviour under test: a finished-by-rejecting loop is still finished, so the registry is
    // read and this consumer's row is removed. A `TIMED_OUT` classification returns from `stop()`
    // before either round trip.
    expect(delconsumerArgs()).toEqual([
      WORKER_SHUTDOWN.SUBCOMMAND_DELCONSUMER,
      OVERRIDE.STREAM_NAME,
      OVERRIDE.CONSUMER_GROUP,
      OVERRIDE.CONSUMER_NAME
    ]);
    // And it is **not** reported as abandoned work. This half matters on its own: an operator
    // paging on the drain-timeout WARN would be paged by every connection failure.
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      LOG_MESSAGE.DRAIN_TIMED_OUT
    );
  });

  it("U50 - every test deadline, and the one case that spends two of them, sits below the runner budget", async () => {
    // `CASE_BUDGET_MS` is only the truth if the runner actually enforces it, so this reads the
    // effective config rather than trusting the constant to describe it. The specifier is a
    // variable so TypeScript does not try to resolve `vitest.config.mjs`, which is outside this
    // package's `tsconfig.json` `include`.
    const configModule: unknown = await import(VITEST_CONFIG_URL);
    expect(readConfiguredTestTimeout(configModule)).toBe(CASE_BUDGET_MS);

    // Each deadline on its own. A deadline at or above the budget cannot fire: the runner kills
    // the case first and reports `Test timed out in 5000ms`, naming nothing — which is what
    // `RUN_DEADLINE_MS` (10 000) and `BLOCK_MS_LONG` (5 000) each did before they were lowered.
    expect(INTEGRATION_LOOP.RUN_DEADLINE_MS).toBeLessThan(CASE_BUDGET_MS);
    expect(INTEGRATION_LOOP.STOP_BUDGET_MS).toBeLessThan(CASE_BUDGET_MS);
    expect(INTEGRATION_LOOP.BLOCK_MS_LONG).toBeLessThan(CASE_BUDGET_MS);
    expect(STOP_DEADLINE_MS).toBeLessThan(CASE_BUDGET_MS);

    // The condition the two prior per-constant fixes both missed. `I12` is the one case that
    // can spend both: it waits up to `RUN_DEADLINE_MS` for the read to park, and a regressed
    // `stop()` would then wait out `BLOCK_MS_LONG`. Each is individually under budget at
    // 3 000 ms and their sum is 6 000, so the pair would time out where neither alone does.
    expect(INTEGRATION_LOOP.RUN_DEADLINE_MS + INTEGRATION_LOOP.BLOCK_MS_LONG).toBeLessThan(
      CASE_BUDGET_MS
    );

    // T-041's two wall-clock windows, enumerated here for the reason this case's neighbours
    // record: nothing in the type system collects deadlines, so a new one is covered only by
    // being added to this list. `U70` waits out `RECOVERY_CADENCE_MS` and `U71` must finish
    // inside one `SLOW_BLOCK_MS` window; both are bounded above by `stopWhen`'s deadline, so
    // the relationship that matters is each against that rather than against the budget alone.
    expect(RECOVERY_CADENCE_MS).toBeLessThan(STOP_DEADLINE_MS);
    expect(SLOW_BLOCK_MS * WORKER_STREAM_READ.RECOVERY_IDLE_MULTIPLIER).toBeLessThanOrEqual(
      STOP_DEADLINE_MS
    );
    expect(STOP_DEADLINE_MS).toBeLessThan(CASE_BUDGET_MS);

    // T-043's window, added here because this list is the only thing that collects them. A
    // `stop()` whose drain wedges waits `DRAIN_TIMEOUT_MS`, and the live-Redis cases call
    // `stop()`; at or above the budget that regression reports `Test timed out in 5000ms`,
    // naming nothing — the exact defect three prior per-constant fixes each addressed one
    // instance of. `U74` pins the *floor* on the same constant, so it is bounded from both sides.
    expect(WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS).toBeLessThan(CASE_BUDGET_MS);
    // `I30` is T-043's two-window case: it waits up to `INTEGRATION_SHUTDOWN.ENTER_DEADLINE_MS`
    // (1 000) for the handler to be entered and then up to `DRAIN_TIMEOUT_MS` for the drain, which
    // is the `I12` shape this list learned from. The sum asserted below uses `RUN_DEADLINE_MS`
    // (1 500) rather than `ENTER_DEADLINE_MS`, i.e. the **stronger** bound: it covers `I30`'s real
    // budget and would still cover it if `I30` were re-pointed at the larger deadline. An earlier
    // revision of this comment named `RUN_DEADLINE_MS` as the deadline `I30` uses, which it does
    // not (Gate-4 LOW-3).
    expect(INTEGRATION_LOOP.RUN_DEADLINE_MS + WORKER_SHUTDOWN.DRAIN_TIMEOUT_MS).toBeLessThan(
      CASE_BUDGET_MS
    );
  });
});
