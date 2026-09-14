import { beforeEach, describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import type { Logger } from "pino";
import type { ServiceEnv } from "../src/config/env";
import type { StreamMessageHandler } from "../src/events/stream.consumer";
import {
  WORKER_DEAD_LETTER,
  WORKER_EVENT_PROCESSING,
  WORKER_STREAM_CONSTANTS
} from "../src/constants";
import { DeadLetterService } from "../src/services/dead-letter.service";

/**
 * Unit suite for T-041's `DeadLetterService` (slice S3).
 *
 * The subject is a **decorator**, not a step inside the consumer or inside the processor. That
 * is decision A, and it is why every case here drives `wrap(inner)(id, fields)` rather than a
 * loop or a repository: retry accounting had to go somewhere that could observe a failure
 * *without* falsifying `StreamConsumer.dispatch`'s "nothing is acknowledged here" contract or
 * `EventProcessorService`'s "anything this method throws propagates to dispatch". A retryable
 * failure is still rethrown, so `dispatch`'s `HANDLER_FAILED` log and `U29`/`I18` keep their
 * meaning; only the *terminal* failure is swallowed, and only after the entry has been
 * recorded and acknowledged.
 *
 * Every Redis command the subject may issue is spied, and a set of commands it must **not**
 * issue is wired to throw (`FORBIDDEN_COMMAND`), so "it touches no repository and no other key"
 * is enforced by the fixture rather than only asserted by `U61`.
 *
 * Ordering matters in one place and is asserted by invocation order there, matching `U7`'s
 * shape: `XADD` -> `XACK` -> `HDEL`. Two independent `toHaveBeenCalled()`s would pass in any
 * order, and the order is the at-least-once guarantee -- a crash between `XADD` and `XACK`
 * leaves a pending entry with an exhausted counter, which the pre-check dead-letters again
 * (a duplicate record, recoverable); `XACK` first would risk an entry acknowledged and never
 * recorded.
 */

/** A real Redis entry id, as `XREADGROUP` returns it. */
const ENTRY_ID = "1789101023800-0";
const OTHER_ENTRY_ID = "1789101023802-0";
/** The id `XADD` returns for the dead-letter record itself. */
const DEAD_LETTER_ENTRY_ID = "1789101099999-0";

/** A real `Tenant.id` shape, and the thing that must never reach a log line. */
const TENANT_ID = "456793cd-6625-44f6-af63-142a86019e1a";
const EVENT_ID = "7c05417c-4e79-461e-97d6-222ecd8fe913";
/** Flattened customer metadata -- also never a log line. */
const SOURCE_ID_FIELD = "sourceId";
const SOURCE_ID_VALUE = "sdk-web";

/**
 * Stream identity and retry budget, every one differing from its shipped default so that a
 * hard-coded default cannot satisfy an assertion.
 *
 * `MAX_RETRY_COUNT` is deliberately **2**, not the default 3: with the default, a subject that
 * ignored the parsed env entirely would pass every threshold case here.
 */
const OVERRIDE = {
  STREAM_NAME: "telemetry:events:t041-unit",
  CONSUMER_GROUP: "worker-group-t041-unit",
  DEAD_LETTER_STREAM: "telemetry:dead-letter:t041-unit",
  MAX_RETRY_COUNT: 2
} as const;

/** Call counts and positions, named so no bare numeral carries meaning in an assertion. */
const CALLS = {
  NONE: 0,
  ONCE: 1,
  TWICE: 2,
  THRICE: 3
} as const;

/** First recorded call. Separate from `CALLS` -- a position is not a count. */
const INDEX_FIRST = 0;

/** `HGET` on an absent field replies `(nil)`, which ioredis surfaces as `null`. */
const HGET_ABSENT = null;

/** What the inner handler rejects with on the paths that need a failure. */
const INNER_FAILURE = 'insert or update on table "Event" violates foreign key constraint';

/** A rejection that is not an `Error`, guarding the `instanceof Error` branch. */
const NON_ERROR_REJECTION = { errno: -104 };
/** `String(NON_ERROR_REJECTION)`, written out rather than computed -- see `U23`'s note. */
const NON_ERROR_REJECTION_AS_STRING = "[object Object]";

/** Message a forbidden command raises, so a stray call fails by name rather than by `undefined`. */
const FORBIDDEN_COMMAND = "DeadLetterService issued a command it has no business issuing";

const streamFields = (overrides: Record<string, string> = {}): string[] =>
  Object.entries({
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID]: EVENT_ID,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: TENANT_ID,
    [SOURCE_ID_FIELD]: SOURCE_ID_VALUE,
    ...overrides
  }).flat();

describe("DeadLetterService", () => {
  let mockRedis: {
    hget: ReturnType<typeof vi.fn>;
    hincrby: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    hdel: ReturnType<typeof vi.fn>;
    xadd: ReturnType<typeof vi.fn>;
    xack: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    hset: ReturnType<typeof vi.fn>;
    xdel: ReturnType<typeof vi.fn>;
    duplicate: ReturnType<typeof vi.fn>;
  };
  let mockLogger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
  /** Every command name the subject issued, in order. */
  let commands: string[];
  /**
   * Replies the fixture will give, as queues rather than vitest's `mockResolvedValue`.
   *
   * That helper **replaces** a `vi.fn`'s implementation, which silently stops the recorder in
   * `beforeEach` from appending to `commands`. `U61` caught exactly that: with the `hincrby`
   * reply stubbed that way the recorded sequence came back missing `hincrby`, which looked like
   * a subject defect and was a fixture defect. A queue keeps the recording implementation and
   * varies only the value; an empty queue falls back to the default reply.
   */
  let hgetReplies: Array<string | null>;
  let hincrbyReplies: number[];
  /** `(id, fields)` the inner handler saw, so "was not processed" is observable. */
  let innerCalls: Array<{ id: string; fields: readonly string[] }>;
  let inner: StreamMessageHandler;

  const env: Partial<ServiceEnv> = {
    REDIS_STREAM_NAME: OVERRIDE.STREAM_NAME,
    REDIS_CONSUMER_GROUP: OVERRIDE.CONSUMER_GROUP,
    DEAD_LETTER_STREAM: OVERRIDE.DEAD_LETTER_STREAM,
    MAX_RETRY_COUNT: OVERRIDE.MAX_RETRY_COUNT
  };

  const buildService = (): DeadLetterService =>
    new DeadLetterService(
      mockRedis as unknown as Redis,
      mockLogger as unknown as Logger,
      env as ServiceEnv
    );

  const buildHandler = (): StreamMessageHandler => buildService().wrap(inner);

  /** The retry hash key the subject builds for itself, never from a caller-supplied value. */
  const retryKey = (): string =>
    `${WORKER_DEAD_LETTER.RETRY_KEY_PREFIX}${OVERRIDE.STREAM_NAME}`;

  /** Throws rather than returning undefined, so a missing call cannot pass vacuously. */
  const nthArgs = (spy: ReturnType<typeof vi.fn>, name: string, index: number): unknown[] => {
    const call = spy.mock.calls[index];
    if (!call) {
      throw new Error(`${name} was never called a ${index + CALLS.ONCE}th time`);
    }

    return call;
  };

  /** The dead-letter record's fields, folded back into a record. Throws if there was no write. */
  const deadLetterRecord = (): Record<string, string> => {
    const args = nthArgs(mockRedis.xadd, "xadd", INDEX_FIRST);
    // `xadd(stream, "*", k, v, k, v, ...)` -- drop the key and the id, then fold.
    const flat = args.slice(CALLS.TWICE) as string[];
    if (flat.length % WORKER_EVENT_PROCESSING.FIELD_PAIR_STRIDE !== CALLS.NONE) {
      throw new Error("the dead-letter XADD had an odd field list");
    }

    const record: Record<string, string> = {};
    for (
      let index = CALLS.NONE;
      index < flat.length;
      index += WORKER_EVENT_PROCESSING.FIELD_PAIR_STRIDE
    ) {
      const key = flat[index];
      const value = flat[index + WORKER_EVENT_PROCESSING.FIELD_VALUE_OFFSET];
      if (key === undefined || value === undefined) {
        throw new Error("the dead-letter XADD had a dangling field");
      }

      record[key] = value;
    }

    return record;
  };

  /**
   * Every argument list passed to every logger method, for the redaction negative.
   *
   * Throws in both directions a vacuous pass could come from -- a missing mock method, and a
   * subject that logged nothing at all. Same shape as `U45`'s helper.
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
    commands = [];
    innerCalls = [];
    hgetReplies = [];
    hincrbyReplies = [];
    const record = <T>(name: string, reply: T, queue?: T[]) =>
      vi.fn((...args: unknown[]): Promise<T> => {
        void args;
        commands.push(name);
        const queued = queue?.shift();

        return Promise.resolve(queued === undefined ? reply : queued);
      });
    const forbid = (name: string) =>
      vi.fn(() => {
        throw new Error(`${FORBIDDEN_COMMAND}: ${name}`);
      });

    mockRedis = {
      hget: record<string | null>("hget", HGET_ABSENT, hgetReplies),
      hincrby: record("hincrby", CALLS.ONCE, hincrbyReplies),
      expire: record("expire", CALLS.ONCE),
      hdel: record("hdel", CALLS.ONCE),
      xadd: record("xadd", DEAD_LETTER_ENTRY_ID as string | null),
      xack: record("xack", CALLS.ONCE),
      // Not part of the contract. Wired to throw so a stray write fails by name here rather
      // than surfacing as a mystery somewhere else.
      del: forbid("del"),
      hset: forbid("hset"),
      xdel: forbid("xdel"),
      duplicate: forbid("duplicate")
    };
    mockLogger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    inner = vi.fn((id: string, fields: string[]): Promise<void> => {
      innerCalls.push({ id, fields });

      return Promise.resolve();
    });
  });

  it("U61 - touches Redis and the inner handler only, on every path", async () => {
    // Success.
    await buildHandler()(ENTRY_ID, streamFields());
    expect(commands).toEqual(["hget"]);
    expect(innerCalls).toHaveLength(CALLS.ONCE);

    // A retryable failure.
    commands = [];
    inner = vi.fn(() => Promise.reject(new Error(INNER_FAILURE)));
    await expect(buildHandler()(ENTRY_ID, streamFields())).rejects.toThrow(INNER_FAILURE);
    expect(commands).toEqual(["hget", "hincrby", "expire"]);

    // The terminal failure.
    commands = [];
    hincrbyReplies.push(OVERRIDE.MAX_RETRY_COUNT);
    await buildHandler()(ENTRY_ID, streamFields());
    expect(commands).toEqual(["hget", "hincrby", "expire", "xadd", "xack", "hdel"]);

    // AC10, the negative: there is no repository, no Prisma client and no second connection in
    // any of that. `duplicate` and the three write commands above are wired to throw, so a
    // stray call would have failed by name; this states the same claim positively.
    expect(mockRedis.duplicate).not.toHaveBeenCalled();
    expect(mockRedis.del).not.toHaveBeenCalled();
    expect(mockRedis.hset).not.toHaveBeenCalled();
    expect(mockRedis.xdel).not.toHaveBeenCalled();
    // The constructor takes no repository factory: three arguments, all infrastructure. A
    // fourth would be the seam through which a Postgres write — and S-18, since worker's
    // `withTenant` has no `TimeZone` pin — could enter this path.
    expect(DeadLetterService.length).toBe(CALLS.THRICE);
  });

  it("U62 - a failure increments the counter, refreshes the key TTL, and rethrows", async () => {
    inner = vi.fn(() => Promise.reject(new Error(INNER_FAILURE)));

    // Rethrown, not swallowed: `dispatch` logs `HANDLER_FAILED` against the entry id and leaves
    // the entry pending. A wrapper that resolved here would make a failed entry look handled.
    await expect(buildHandler()(ENTRY_ID, streamFields())).rejects.toThrow(INNER_FAILURE);

    expect(nthArgs(mockRedis.hincrby, "hincrby", INDEX_FIRST)).toEqual([
      retryKey(),
      ENTRY_ID,
      WORKER_DEAD_LETTER.RETRY_COUNT_INCREMENT
    ]);
    // The key-level TTL, refreshed on every increment. `HEXPIRE` does not exist on the Redis
    // this platform runs (7.0.15 replied `ERR unknown command 'HEXPIRE'`), so there is no
    // per-field expiry — and a field whose entry is trimmed out of the source stream while
    // still pending is never `HDEL`ed by any path, which is what would otherwise leak.
    expect(nthArgs(mockRedis.expire, "expire", INDEX_FIRST)).toEqual([
      retryKey(),
      WORKER_DEAD_LETTER.RETRY_KEY_TTL_SECONDS
    ]);
    // Nothing was recorded and nothing was acknowledged: this is a retry, not an ending.
    expect(mockRedis.xadd).not.toHaveBeenCalled();
    expect(mockRedis.xack).not.toHaveBeenCalled();
    expect(mockRedis.hdel).not.toHaveBeenCalled();
  });

  it("U63 - the MAX_RETRY_COUNT-th failure dead-letters instead of rethrowing", async () => {
    inner = vi.fn(() => Promise.reject(new Error(INNER_FAILURE)));
    const handler = buildHandler();

    // Below the budget: still a retry.
    hincrbyReplies.push(OVERRIDE.MAX_RETRY_COUNT - CALLS.ONCE);
    await expect(handler(ENTRY_ID, streamFields())).rejects.toThrow(INNER_FAILURE);
    expect(mockRedis.xadd).not.toHaveBeenCalled();

    // At the budget: recorded, acknowledged, counter cleared — and **not** rethrown, because
    // rethrowing after acknowledging would report a failure for an entry that is finished.
    hincrbyReplies.push(OVERRIDE.MAX_RETRY_COUNT);
    await expect(handler(ENTRY_ID, streamFields())).resolves.toBeUndefined();
    expect(mockRedis.xadd).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(mockRedis.xack).toHaveBeenCalledTimes(CALLS.ONCE);

    // The threshold came from the parsed env, not from the shipped default. Without this the
    // case would pass for a subject that ignored `env.MAX_RETRY_COUNT` entirely.
    expect(OVERRIDE.MAX_RETRY_COUNT).not.toBe(WORKER_STREAM_CONSTANTS.DEFAULT_MAX_RETRY_COUNT);
    expect(deadLetterRecord()[WORKER_DEAD_LETTER.FIELD.RETRY_COUNT]).toBe(
      String(OVERRIDE.MAX_RETRY_COUNT)
    );
  });

  it("U64 - the dead-letter record carries the original field list and the failure reason", async () => {
    const fields = streamFields();
    inner = vi.fn(() => Promise.reject(new Error(INNER_FAILURE)));
    hincrbyReplies.push(OVERRIDE.MAX_RETRY_COUNT);

    await buildHandler()(ENTRY_ID, fields);

    const args = nthArgs(mockRedis.xadd, "xadd", INDEX_FIRST);
    expect(args[INDEX_FIRST]).toBe(OVERRIDE.DEAD_LETTER_STREAM);
    // Never the stream being read: a dead letter written back to the source is redelivered,
    // fails again, and dead-letters itself forever.
    expect(args[INDEX_FIRST]).not.toBe(OVERRIDE.STREAM_NAME);

    const record = deadLetterRecord();
    expect(record[WORKER_DEAD_LETTER.FIELD.ORIGINAL_ID]).toBe(ENTRY_ID);
    expect(record[WORKER_DEAD_LETTER.FIELD.STREAM_NAME]).toBe(OVERRIDE.STREAM_NAME);
    expect(record[WORKER_DEAD_LETTER.FIELD.GROUP_NAME]).toBe(OVERRIDE.CONSUMER_GROUP);
    expect(record[WORKER_DEAD_LETTER.FIELD.FAILURE_REASON]).toBe(INNER_FAILURE);

    // The **payload**, and this is the load-bearing field. Measured on Redis 7.0.15: five
    // entries were delivered and unacknowledged, one `XADD ... MAXLEN 1` then left `XLEN` at 1
    // while `XPENDING - + 10` still listed all five ids. So a pending id is not a handle on its
    // data, and a record holding only `originalId` becomes unreplayable once the producer's
    // `MAXLEN ~ 100000` has rolled past it.
    expect(JSON.parse(record[WORKER_DEAD_LETTER.FIELD.PAYLOAD] ?? "null")).toEqual(fields);

    // An instant, not a database column. There is no `failedAt` column anywhere and no Postgres
    // write on this path: worker's `withTenant` has no `set_config('TimeZone','UTC')` pin
    // (S-19), so a timestamp bound into raw SQL in this service would inherit S-18 whole.
    const failedAt = record[WORKER_DEAD_LETTER.FIELD.FAILED_AT] ?? "";
    expect(new Date(failedAt).toISOString()).toBe(failedAt);
    expect(mockRedis.xadd).toHaveBeenCalledTimes(CALLS.ONCE);
  });

  it("U65 - XADD precedes XACK, which precedes HDEL", async () => {
    inner = vi.fn(() => Promise.reject(new Error(INNER_FAILURE)));
    hincrbyReplies.push(OVERRIDE.MAX_RETRY_COUNT);

    await buildHandler()(ENTRY_ID, streamFields());

    // Invocation order, not three independent `toHaveBeenCalled()`s, which would pass in any
    // order. `XACK` before `XADD` risks an entry acknowledged and never recorded -- the one
    // ordering in which a dead letter is lost rather than duplicated. `HDEL` before `XACK`
    // would reset the counter and grant the entry a fresh budget.
    const addOrder = mockRedis.xadd.mock.invocationCallOrder[INDEX_FIRST];
    const ackOrder = mockRedis.xack.mock.invocationCallOrder[INDEX_FIRST];
    const delOrder = mockRedis.hdel.mock.invocationCallOrder[INDEX_FIRST];
    expect(addOrder).toBeDefined();
    expect(ackOrder).toBeDefined();
    expect(delOrder).toBeDefined();
    expect(addOrder).toBeLessThan(ackOrder as number);
    expect(ackOrder).toBeLessThan(delOrder as number);

    // The acknowledgement names the source stream and group, not the dead-letter stream.
    expect(nthArgs(mockRedis.xack, "xack", INDEX_FIRST)).toEqual([
      OVERRIDE.STREAM_NAME,
      OVERRIDE.CONSUMER_GROUP,
      ENTRY_ID
    ]);
    expect(nthArgs(mockRedis.hdel, "hdel", INDEX_FIRST)).toEqual([retryKey(), ENTRY_ID]);
  });

  it("U66 - a success clears a counter that exists, and issues no HDEL when there was none", async () => {
    // No counter: the happy path costs exactly one extra round trip, the pre-check `HGET`.
    await buildHandler()(ENTRY_ID, streamFields());
    expect(mockRedis.hdel).not.toHaveBeenCalled();
    expect(commands).toEqual(["hget"]);

    // A counter from an earlier failure: cleared, or it would survive its entry and eventually
    // dead-letter an unrelated redelivery of the same id.
    hgetReplies.push(String(CALLS.ONCE));
    await buildHandler()(OTHER_ENTRY_ID, streamFields());
    expect(nthArgs(mockRedis.hdel, "hdel", INDEX_FIRST)).toEqual([retryKey(), OTHER_ENTRY_ID]);
    // Cleared, not dead-lettered: the entry succeeded.
    expect(mockRedis.xadd).not.toHaveBeenCalled();
    expect(mockRedis.xack).not.toHaveBeenCalled();
  });

  it("U67 - an entry arriving with an exhausted counter is dead-lettered without being processed", async () => {
    hgetReplies.push(String(OVERRIDE.MAX_RETRY_COUNT));

    await expect(buildHandler()(ENTRY_ID, streamFields())).resolves.toBeUndefined();

    // The claim, and the only one that distinguishes a pre-check from a post-check: the inner
    // handler never ran. This is what makes a crash between `HINCRBY` and `XADD` terminal
    // rather than granting a fourth attempt.
    expect(innerCalls).toEqual([]);
    expect(inner).not.toHaveBeenCalled();
    expect(mockRedis.hincrby).not.toHaveBeenCalled();

    expect(mockRedis.xadd).toHaveBeenCalledTimes(CALLS.ONCE);
    const record = deadLetterRecord();
    expect(record[WORKER_DEAD_LETTER.FIELD.RETRY_COUNT]).toBe(String(OVERRIDE.MAX_RETRY_COUNT));
    // No error was in hand on this path, so the reason says what actually happened rather than
    // repeating the last one, which this process never saw.
    expect(record[WORKER_DEAD_LETTER.FIELD.FAILURE_REASON]).toBe(
      WORKER_DEAD_LETTER.REASON_BUDGET_EXHAUSTED
    );
    expect(mockRedis.xack).toHaveBeenCalledTimes(CALLS.ONCE);
  });

  it("U68 - no field value and no tenant id reaches any log line, on any path", async () => {
    // Drive all three paths through one service so the assertion covers every logger call the
    // subject can make, not just the one the terminal path uses.
    await buildHandler()(ENTRY_ID, streamFields());

    inner = vi.fn(() => Promise.reject(new Error(INNER_FAILURE)));
    await expect(buildHandler()(ENTRY_ID, streamFields())).rejects.toThrow(INNER_FAILURE);

    // Two queued replies: this setup covers the terminal path below *and* the non-`Error`
    // path after it, both of which reach the budget.
    hincrbyReplies.push(OVERRIDE.MAX_RETRY_COUNT, OVERRIDE.MAX_RETRY_COUNT);
    await buildHandler()(ENTRY_ID, streamFields());

    // A non-`Error` rejection too, so the `String(error)` arm is covered by the same negative.
    inner = vi.fn(() => Promise.reject(NON_ERROR_REJECTION));
    await buildHandler()(ENTRY_ID, streamFields());

    const serialised = JSON.stringify(allLogCalls());
    expect(serialised).not.toContain(TENANT_ID);
    expect(serialised).not.toContain(SOURCE_ID_VALUE);
    expect(serialised).not.toContain(EVENT_ID);
    expect(serialised).not.toContain(SOURCE_ID_FIELD);

    // Not a vacuous pass: the dead-letter line was written, and it attributes the record to an
    // entry id and to the destination an operator has to read.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: ENTRY_ID,
        streamName: OVERRIDE.STREAM_NAME,
        deadLetterStream: OVERRIDE.DEAD_LETTER_STREAM
      }),
      WORKER_DEAD_LETTER.LOG.DEAD_LETTERED
    );
    // The non-`Error` rejection was stringified rather than dropped.
    expect(deadLetterRecord()[WORKER_DEAD_LETTER.FIELD.FAILURE_REASON]).toBe(INNER_FAILURE);
    const lastAdd = nthArgs(mockRedis.xadd, "xadd", CALLS.ONCE);
    expect(lastAdd).toContain(NON_ERROR_REJECTION_AS_STRING);
  });
});
