import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import type { Logger } from "pino";
import type { ServiceEnv } from "../src/config/env";
import {
  WORKER_CONSUMER_GROUP_BOOTSTRAP,
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
  DEFAULT_HANDLER_RECEIVED: "Received stream entry; no processor is wired yet"
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

describe("StreamConsumer.run", () => {
  let mockRedis: {
    xgroup: ReturnType<typeof vi.fn>;
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
    readConnection = {
      xreadgroup: vi.fn().mockResolvedValue(null),
      xautoclaim: vi.fn().mockResolvedValue(autoclaimReply(WORKER_STREAM_READ.PENDING_START_ID, [])),
      // Present so that "nothing acknowledges anything" (D2-A) is an assertion rather than
      // an absence — `U34` checks it against the *default* handler, which is what a deployed
      // T-039 worker runs. Without the spy, an implementation that acknowledged would fail
      // with "xack is not a function" instead of naming the contract it broke.
      xack: vi.fn(),
      disconnect: vi.fn()
    };
    mockRedis = {
      xgroup: vi.fn().mockResolvedValue("OK"),
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
    // Scope (Gate 5 F-1, corrected at Gate 6 H-2/H-3): this asserts what `StreamConsumer`
    // does -- the class in isolation -- and that is all it asserts. It is **not** evidence
    // that this line reaches a deployed worker's output. `index.ts` discards `run()` and then
    // calls `process.exit(0)`; the whole shutdown handler completes in 3-6 ms while
    // `disconnect()` takes ~205 ms to reject the parked read, so the teardown lines are in a
    // race with the exit. Measured over nine real SIGTERM runs: emitted in 4 of 5 runs at
    // `STREAM_BLOCK_MS=20`, in 0 of 3 at 500 and 0 of 1 at the 5000 default. Approved design
    // -- draining is T-043's, and nothing is lost because nothing is acknowledged. See S-26.
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
    // Scope (Gate 5 F-1, corrected at Gate 6 H-2/H-3): this asserts what `StreamConsumer`
    // does -- the class in isolation -- and that is all it asserts. It is **not** evidence
    // that this line reaches a deployed worker's output. `index.ts` discards `run()` and then
    // calls `process.exit(0)`; the whole shutdown handler completes in 3-6 ms while
    // `disconnect()` takes ~205 ms to reject the parked read, so the teardown lines are in a
    // race with the exit. Measured over nine real SIGTERM runs: emitted in 4 of 5 runs at
    // `STREAM_BLOCK_MS=20`, in 0 of 3 at 500 and 0 of 1 at the 5000 default. Approved design
    // -- draining is T-043's, and nothing is lost because nothing is acknowledged. See S-26.
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
    // Scope (Gate 5 F-1, corrected at Gate 6 H-2/H-3): this asserts what `StreamConsumer`
    // does -- the class in isolation -- and that is all it asserts. It is **not** evidence
    // that this line reaches a deployed worker's output. `index.ts` discards `run()` and then
    // calls `process.exit(0)`; the whole shutdown handler completes in 3-6 ms while
    // `disconnect()` takes ~205 ms to reject the parked read, so the teardown lines are in a
    // race with the exit. Measured over nine real SIGTERM runs: emitted in 4 of 5 runs at
    // `STREAM_BLOCK_MS=20`, in 0 of 3 at 500 and 0 of 1 at the 5000 default. Approved design
    // -- draining is T-043's, and nothing is lost because nothing is acknowledged. See S-26.
    let rejectRead: ((reason: unknown) => void) | undefined;
    readConnection.xreadgroup.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        })
    );
    // The predicate never flips. Termination therefore has to come from `stop()` alone, which
    // is what makes `stop()` self-sufficient rather than a hint to a flag someone else set.
    const consumer = buildLoopConsumer(() => false);
    const runPromise = consumer.run();
    await vi.waitFor(() => {
      if (!rejectRead) {
        throw new Error("the read was never issued");
      }
    });

    await consumer.stop();
    // What `disconnect()` does to a read parked on the connection, measured: the in-flight
    // call rejected after 205 ms with `Error: Connection is closed.`
    rejectRead?.(new Error(CONNECTION_CLOSED_REJECTION));
    await expect(runPromise).resolves.toBeUndefined();

    expect(readConnection.disconnect).toHaveBeenCalled();

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
    let rejectClaim: ((reason: unknown) => void) | undefined;
    readConnection.xautoclaim.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectClaim = reject;
        })
    );
    // The predicate never flips, so the quiet exit has to come from `stop()` alone — the same
    // shape as `U26`, on the path `U26` does not reach.
    const consumer = buildLoopConsumer(() => false);
    const runPromise = consumer.run();
    await vi.waitFor(() => {
      if (!rejectClaim) {
        throw new Error("the reclaim was never issued");
      }
    });

    await consumer.stop();
    rejectClaim?.(new Error(CONNECTION_CLOSED_REJECTION));
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
  });
});
