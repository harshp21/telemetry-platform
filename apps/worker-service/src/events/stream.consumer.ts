import type Redis from "ioredis";
import type { Logger } from "pino";
import type { ServiceEnv } from "../config/env";
import { WORKER_CONSUMER_GROUP_BOOTSTRAP, WORKER_STREAM_READ } from "../constants";

/**
 * What the loop does with one delivered entry.
 *
 * `fields` is the flat `[key, value, key, value, ...]` list the producer writes from
 * `Object.entries(event)` (`apps/usage-service/src/events/stream.publisher.ts`), passed
 * through unchanged: this task does not interpret it.
 *
 * **Acknowledgement lives on the far side of this seam** (decision D2-A). The handler owns
 * `XACK`, and owns it *after* whatever durable write it performs has committed — which is
 * T-040's job. Nothing in this file acknowledges anything, so an entry this loop reads stays
 * in the group's pending list until T-040 lands. That is deliberate: the alternative,
 * acknowledging what nobody stored, is unrecoverable data loss rather than a backlog.
 */
export type StreamMessageHandler = (id: string, fields: string[]) => Promise<void>;

/** One entry, after the reply has been shape-checked. */
interface StreamEntry {
  readonly id: string;
  readonly fields: string[];
}

/**
 * Entries recovered from one reply, plus the number of elements that did not have the shape
 * of an entry.
 *
 * The count is carried rather than discarded so a malformed reply is *visible*: silently
 * returning fewer entries than the server sent would look exactly like an idle stream.
 */
interface ParsedEntries {
  readonly entries: StreamEntry[];
  readonly malformed: number;
}

/** `XAUTOCLAIM`'s reply, which also carries the cursor for the next page. */
interface ParsedClaim extends ParsedEntries {
  readonly nextCursor: string | null;
}

const EMPTY_PARSE: ParsedEntries = { entries: [], malformed: 0 };

/**
 * `Array.isArray` narrows `unknown` to `any[]`, which re-introduces `any` into every
 * subsequent index access and trips `@typescript-eslint/no-unsafe-*`. This narrows to
 * `readonly unknown[]` instead, so the shape checks below stay inside the type system.
 */
const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/**
 * `[id, [field, value, ...]]` -> `StreamEntry`, or `null` if it is not that shape.
 *
 * A non-string field makes the **whole entry** malformed rather than being filtered out: the
 * array is positional key/value pairs, so dropping one element silently re-pairs every
 * key with the following entry's value. Losing one entry loudly beats mis-parsing it quietly,
 * and the entry stays in the pending list either way because nothing acknowledges it.
 */
const parseEntry = (raw: unknown): StreamEntry | null => {
  if (!isUnknownArray(raw)) {
    return null;
  }

  const [id, rawFields] = raw;
  if (typeof id !== "string" || !isUnknownArray(rawFields)) {
    return null;
  }

  const fields: string[] = [];
  for (const field of rawFields) {
    if (typeof field !== "string") {
      return null;
    }

    fields.push(field);
  }

  return { id, fields };
};

/** The `[[id, fields], ...]` list both `XREADGROUP` and `XAUTOCLAIM` nest their entries in. */
const parseEntryList = (raw: unknown): ParsedEntries => {
  if (!isUnknownArray(raw)) {
    return EMPTY_PARSE;
  }

  const entries: StreamEntry[] = [];
  let malformed = 0;
  for (const rawEntry of raw) {
    const entry = parseEntry(rawEntry);
    if (entry === null) {
      malformed += 1;
      continue;
    }

    entries.push(entry);
  }

  return { entries, malformed };
};

/**
 * `XREADGROUP`'s reply -> the entries it delivered.
 *
 * Shape-checking rather than casting, because the declared return type is no help and a cast
 * would be a lie the compiler accepts. `xreadgroup`'s declared type in ioredis 5.11.1 is
 * `Result<unknown[], Context>` — **not** nullable — yet the runtime value on a `BLOCK`
 * timeout is `null`. Both halves were re-measured for T-039: a `BLOCK 300` read with nothing
 * to deliver resolved to `null` after 391 ms, and `tsc --strict` accepted both
 * `const asArray: unknown[] = reply` and `if (reply === null)` without complaint. So the
 * compiler neither forces this guard nor objects to it, and it has to be deliberate.
 *
 * Total over the three reply shapes observed on Redis 7.0.15 — `null`,
 * `[[stream, [[id, fields], ...]]]`, and the non-null empty `[[stream, []]]` — each of which
 * a unit case feeds through (`U12`, `U13`, `U27`). That is the scope of the claim: three
 * shapes were observed, not "no other shape exists". Anything else yields no entries and is
 * counted as malformed, which the caller logs.
 */
const parseReadReply = (reply: unknown): ParsedEntries => {
  if (!isUnknownArray(reply)) {
    return EMPTY_PARSE;
  }

  const entries: StreamEntry[] = [];
  let malformed = 0;
  for (const perStream of reply) {
    if (!isUnknownArray(perStream)) {
      malformed += 1;
      continue;
    }

    const parsed = parseEntryList(perStream[WORKER_STREAM_READ.READ_REPLY_ENTRIES_INDEX]);
    entries.push(...parsed.entries);
    malformed += parsed.malformed;
  }

  return { entries, malformed };
};

/**
 * `XAUTOCLAIM`'s reply -> the claimed entries and the cursor for the next page.
 *
 * The reply has **three** elements on Redis 7.0.15 — `[nextCursor, entries, deletedIds]` —
 * and treating it as two, or as a flat entry list, is the natural bug. Re-measured for
 * T-039: `len=3` on all three pages of a 5-entry scan at `COUNT 2`.
 *
 * The third element is read by nobody here. It reports entries that were trimmed away while
 * still pending, and it is not decoration — an entry deleted mid-flight came back in that
 * slot and was dropped from the pending list. Handed to T-041: a dead-letter design must not
 * assume every pending id still has a payload.
 *
 * A cursor that is not a string yields `null`, which the caller treats as "stop paginating"
 * rather than as "start again from the beginning" — the latter would loop forever.
 */
const parseClaimReply = (reply: unknown): ParsedClaim => {
  if (!isUnknownArray(reply)) {
    return { ...EMPTY_PARSE, nextCursor: null };
  }

  const rawCursor = reply[WORKER_STREAM_READ.CLAIM_REPLY_CURSOR_INDEX];

  return {
    ...parseEntryList(reply[WORKER_STREAM_READ.CLAIM_REPLY_ENTRIES_INDEX]),
    nextCursor: typeof rawCursor === "string" ? rawCursor : null
  };
};

/**
 * The default `StreamMessageHandler`: logs that an entry arrived and does **not** acknowledge
 * it (D2-A), so it is re-delivered once T-040 wires a real processor.
 *
 * Logs the entry **id only**. The field payload carries `tenantId` and customer-shaped event
 * metadata, and this service has no redaction layer, so entry contents never reach a log line
 * in this file.
 */
const buildDefaultMessageHandler =
  (logger: Logger, streamName: string, groupName: string): StreamMessageHandler =>
  (id: string): Promise<void> => {
    logger.info(
      { streamName, groupName, entryId: id },
      "Received stream entry; no processor is wired yet"
    );

    return Promise.resolve();
  };

/** `error.message` for an `Error`, `String(error)` otherwise. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * StreamConsumer: owns worker-service's side of the `telemetry:events` Redis stream.
 *
 * T-038 implements one method -- `ensureConsumerGroup()`, the `XGROUP CREATE` bootstrap.
 * T-039 adds the `XREADGROUP` loop and `XAUTOCLAIM` recovery to this same class.
 *
 * Shape mirrors the producer at `apps/usage-service/src/events/stream.publisher.ts:29-38`:
 * constructor-injected `(redis, logger, env)`, stream identity resolved once in the
 * constructor, `private readonly` fields. The epic's snippet for T-038 is a free function
 * closing over module-scope `redis`/`streamName`/`groupName`; that is not this repository's
 * shape and it makes the bootstrap untestable without module mocking.
 *
 * Error handling: fail-closed, matching the producer's documented stance
 * (`stream.publisher.ts:22`, "On any Redis error, log and throw"). The single exception is
 * the already-exists reply, which is the normal outcome on every restart and on every worker
 * beyond the first.
 */
export class StreamConsumer {
  private readonly streamName: string;
  private readonly groupName: string;
  private readonly consumerName: string;
  private readonly blockMs: number;
  private readonly batchSize: number;
  private readonly handler: StreamMessageHandler;

  /**
   * The connection the loop reads on, while it is reading (D1-B).
   *
   * `null` outside `run()`, so `stop()` before or after a loop is a no-op rather than an
   * error. Owned by `run()`, which opens it and closes it in a `finally`: the container's
   * connection is never parked on a blocking read, and no socket outlives the loop.
   */
  private readConnection: Redis | null = null;

  /**
   * Set by `stop()`. Distinct from the injected predicate, and both are needed.
   *
   * The predicate reports that the *process* is shutting down. This flag reports that *this
   * consumer* was asked to stop and therefore closed its own read connection — which is what
   * makes a `Connection is closed.` rejection a clean shutdown rather than a fault. Keying
   * that classification on the predicate instead would misreport a connection dropped by
   * anything else during shutdown as a normal exit (`U26` and `U28` are the pair that pins
   * the distinction).
   *
   * It also makes `stop()` self-sufficient: a caller that stops the loop without owning the
   * predicate still stops it.
   */
  private stopRequested = false;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    env: ServiceEnv,
    /**
     * Whether the process is shutting down. Read once per loop iteration.
     *
     * Injected, and **required**, rather than imported from `src/index.ts`. Measured: adding
     * `import { shuttingDown } from "../index"` to a throwaway copy of this module and then
     * importing *only* the copy ran `index.ts`'s top level — `initTracing(...)` and
     * `void start()` — building the app and exiting 1 against an unreachable Redis, where the
     * unpatched copy exited 0 having done nothing. So any module or test file that touched
     * the consumer would boot a worker. (The import *cycle* itself was fine in both load
     * orders, and the live binding did propagate a real `SIGTERM`; the boot side effect alone
     * is the reason.)
     *
     * Required rather than defaulted so that no construction site can leave the loop without
     * a stop condition by omission. The cost is that the bootstrap-only call sites — which
     * never call `run()` — must say so explicitly, which is the point.
     */
    private readonly isShuttingDown: () => boolean,
    handler?: StreamMessageHandler
  ) {
    // Read straight from the parsed environment, with no `|| DEFAULT_*` fallback.
    //
    // A deliberate divergence from `stream.publisher.ts:35-36`, which writes
    // `env.REDIS_STREAM_NAME || STREAM_CONSTANTS.DEFAULT_STREAM_NAME`.
    // `src/config/env.ts:41-42` declares both fields `z.string().min(1).default(...)`, so
    // `parseEnv` either throws or yields a non-empty string and a fallback arm here would
    // never be taken on the production path -- `index.ts:74` passes `container.env`, and
    // `container.env` is only ever the output of `parseEnv`.
    //
    // Measured, not assumed. Against the real schemas
    // (`EnvSchema.shape.<field>.safeParse("")`, zod 3.25.76):
    //   worker REDIS_STREAM_NAME    ""  -> THROWS "String must contain at least 1 character(s)"
    //   worker REDIS_CONSUMER_GROUP ""  -> THROWS "String must contain at least 1 character(s)"
    //   usage  REDIS_STREAM_NAME    ""  -> OK, parses to ""
    //
    // So the *producer's* fallback is reachable and this one is not: usage-service's
    // `REDIS_STREAM_NAME` (`apps/usage-service/src/config/env.ts:21`) has no `.min(1)`, and
    // `REDIS_STREAM_NAME=""` therefore reaches `stream.publisher.ts:36`'s right-hand arm.
    // `WORKER_STREAM_CONSTANTS`' docblock says the producer's fallback "never reaches" -- that
    // is true only for an *absent* variable, not an empty one. Filed as S-23.
    //
    // Scope of "would never be taken": on the production path. A unit test constructs
    // `ServiceEnv` by cast rather than through `parseEnv`, so a test could pass `""` and reach
    // a fallback arm -- it would be exercising a value production cannot produce.
    this.streamName = env.REDIS_STREAM_NAME;
    this.groupName = env.REDIS_CONSUMER_GROUP;
    this.consumerName = env.REDIS_CONSUMER_NAME;
    this.blockMs = env.STREAM_BLOCK_MS;
    this.batchSize = env.STREAM_BATCH_SIZE;
    this.handler =
      handler ?? buildDefaultMessageHandler(this.logger, this.streamName, this.groupName);
  }

  /**
   * Registers the consumer group, creating the stream key if it does not exist.
   *
   * Idempotent: a group that already exists is a success, and re-issuing `CREATE` was
   * observed to leave `last-delivered-id` and `pending` unchanged (contrast
   * `XGROUP SETID`, which moved `last-delivered-id` on the same fixture). Issuing this from
   * 8 connections concurrently was observed to yield 1 `OK`, 7 already-exists replies and
   * exactly one group -- so no lock or check-then-create is needed.
   *
   * Public and re-callable rather than a one-shot startup side effect: `DEL` of the stream
   * key was observed to remove the group with it (`XINFO GROUPS` -> `ERR no such key`), and
   * T-039's read loop will need to re-bootstrap on a `NOGROUP` reply.
   *
   * Deliberately returns `void` rather than the reply. ioredis types `xgroup` as
   * `Promise<unknown>`; keying the outcome on "did it throw" avoids narrowing a reply whose
   * shape is not part of the contract.
   *
   * @throws the underlying rejection, unchanged, for anything other than already-exists.
   */
  async ensureConsumerGroup(): Promise<void> {
    try {
      await this.redis.xgroup(
        WORKER_CONSUMER_GROUP_BOOTSTRAP.SUBCOMMAND_CREATE,
        this.streamName,
        this.groupName,
        WORKER_CONSUMER_GROUP_BOOTSTRAP.START_ID_NEW_ENTRIES_ONLY,
        WORKER_CONSUMER_GROUP_BOOTSTRAP.OPTION_MKSTREAM
      );

      this.logger.info(
        {
          streamName: this.streamName,
          groupName: this.groupName,
          startId: WORKER_CONSUMER_GROUP_BOOTSTRAP.START_ID_NEW_ENTRIES_ONLY
        },
        "Created stream consumer group"
      );
    } catch (error) {
      // `startsWith`, not `includes` -- see ALREADY_EXISTS_ERROR_PREFIX for the reply that
      // makes the two disagree and for the scope of that observation. ioredis surfaces this
      // as a `ReplyError` with `code === undefined`, so the message is the only
      // discriminator available.
      if (
        error instanceof Error &&
        error.message.startsWith(WORKER_CONSUMER_GROUP_BOOTSTRAP.ALREADY_EXISTS_ERROR_PREFIX)
      ) {
        this.logger.info(
          { streamName: this.streamName, groupName: this.groupName },
          "Stream consumer group already exists"
        );

        return;
      }

      this.logger.error(
        {
          streamName: this.streamName,
          groupName: this.groupName,
          error: describeError(error)
        },
        "Failed to ensure stream consumer group"
      );
      throw error;
    }
  }

  /**
   * Reads the stream until the process is shutting down or `stop()` is called.
   *
   * **Every failure of the loop is handled here**, and that is why this method is nothing but
   * a `try`/`catch` around `runLoop()`. `index.ts` starts it with `void`, so a rejection
   * would be an unhandled rejection — which Node >= 15 exits the process on, leaving a worker
   * that died with no line saying why.
   *
   * The scope of that claim, and the mutation that establishes it: delete the `catch` below
   * and `U32` (a `duplicate()` that throws) and `U33` (a shutdown predicate that throws) go
   * red, both with `promise rejected ... instead of resolving`. It is **not** a claim that no
   * future edit can make this reject — `this.logger.error` itself throwing would, and so
   * would a statement added outside the `try`. The body being a single call is what leaves no
   * "outside the `try`" inside this method for such a statement to land in.
   *
   * An earlier revision of this docstring said "resolves rather than rejects ... there is no
   * failure mode here that a caller could act on". That was false as written: `duplicate()`
   * and `this.shouldStop()` were both called outside any `try`, and the Round-1 review
   * reproduced both rejections.
   */
  async run(): Promise<void> {
    try {
      await this.runLoop();
    } catch (error) {
      this.logger.error(
        {
          streamName: this.streamName,
          groupName: this.groupName,
          consumerName: this.consumerName,
          error: describeError(error)
        },
        "Stream consumer loop failed"
      );
    }
  }

  /**
   * The loop itself. Everything it can throw is caught by `run()`.
   *
   * Startup order: open a dedicated read connection, reclaim work abandoned by a previous
   * worker, then read batches until told to stop. Every entry — reclaimed or freshly
   * delivered — goes through the same handler, and nothing is acknowledged here.
   *
   * **The shutdown predicate is read once per read iteration**, before the iteration rather
   * than between the entries of a batch, which is T-043's "exits after current batch". A
   * mid-batch check would abandon entries already delivered to this consumer; they would not
   * be lost (nothing is acknowledged) but they would wait out an idle timeout for no reason.
   *
   * The real sequence, stated precisely because an earlier revision glossed it (Round 1,
   * L-7): guard -> `recoverPendingEntries` -> first read -> `do`/`while` condition. Recovery
   * sits *between* the guard and the first read and is unbounded in wall-clock time, so the
   * guard does not gate the first read in the way the old wording implied — it gates
   * *recovery*. A predicate that flips during recovery ends the pagination at the next page
   * boundary, and then one read still happens, because the `do`/`while` tests its condition
   * at the bottom. `U35` asserts that read rather than pretending it does not occur. On the
   * shipped path it costs nothing: `index.ts` calls `stop()`, which has already disconnected
   * the connection, so that read rejects at once and is classified as a shutdown interrupt.
   */
  private async runLoop(): Promise<void> {
    if (this.shouldStop()) {
      this.logger.info(
        { streamName: this.streamName, groupName: this.groupName },
        "Stream consumer loop not started: shutdown already requested"
      );

      return;
    }

    // A connection of its own (D1-B). Measured on a shared connection: an unrelated `PING`
    // issued during a `BLOCK 2000` read came back after 2 080 ms, and `quit()` — which
    // `app.close()` triggers through the `onClose` hook — waited out a `BLOCK 5000` read for
    // 4 813 ms. On a duplicate, the `PING` came back in 0 ms and `disconnect()` ended the
    // read in 205 ms. A duplicate inherits the logical database (`CLIENT INFO` -> `db=14` in
    // the test fixture), so nothing about database selection changes.
    const readConnection = this.redis.duplicate();
    this.readConnection = readConnection;

    try {
      await this.recoverPendingEntries(readConnection);

      do {
        const interrupted = await this.readBatch(readConnection);
        if (interrupted) {
          break;
        }
      } while (!this.shouldStop());
    } finally {
      this.readConnection = null;
      readConnection.disconnect();
      this.logger.info(
        { streamName: this.streamName, groupName: this.groupName },
        "Stream consumer loop stopped"
      );
    }
  }

  /**
   * Asks the loop to stop and ends any read parked on the connection.
   *
   * `disconnect()` rather than `quit()`: `quit()` waits for the in-flight blocking read to
   * return on its own (4 813 ms against a `BLOCK 5000`), while `disconnect()` rejects it
   * immediately (205 ms, `Connection is closed.`). `index.ts` therefore calls this **before**
   * `app.close()`, whose `onClose` hook quits the container's connection.
   *
   * Safe to call before `run()`, after it, and more than once: the flag latches and
   * `readConnection` is `null` outside the loop.
   *
   * `async` with nothing awaited today, deliberately: T-043 owns draining in-flight work on
   * shutdown, and that drain belongs here. Callers already `await` it.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.readConnection?.disconnect();
  }

  /** True once either the process is shutting down or this consumer was told to stop. */
  private shouldStop(): boolean {
    return this.stopRequested || this.isShuttingDown();
  }

  /**
   * One `XREADGROUP`. Returns whether the loop was interrupted by shutdown and should exit.
   *
   * `>` delivers only entries never handed to any consumer in this group, so a worker does
   * not re-read its own pending list here — that is `recoverPendingEntries`' job, and doing
   * both in one place is how a pending entry gets handled twice per iteration.
   */
  private async readBatch(readConnection: Redis): Promise<boolean> {
    try {
      const reply = await readConnection.xreadgroup(
        WORKER_STREAM_READ.SUBCOMMAND_GROUP,
        this.groupName,
        this.consumerName,
        WORKER_STREAM_READ.OPTION_COUNT,
        this.batchSize,
        WORKER_STREAM_READ.OPTION_BLOCK,
        this.blockMs,
        WORKER_STREAM_READ.OPTION_STREAMS,
        this.streamName,
        WORKER_STREAM_READ.NEW_ENTRIES_ONLY
      );

      await this.dispatch(parseReadReply(reply));

      return false;
    } catch (error) {
      if (this.isShutdownInterrupt(error)) {
        this.logger.info(
          {
            streamName: this.streamName,
            groupName: this.groupName,
            consumerName: this.consumerName
          },
          "Stream read interrupted by shutdown"
        );

        return true;
      }

      await this.handleReadFailure(error);

      return false;
    }
  }

  /**
   * Whether a rejection is this consumer's own `stop()` landing on an in-flight read.
   *
   * Keyed on `stopRequested`, **not** on the message alone and not on the shutdown predicate:
   * the same `Connection is closed.` text outside a requested stop is a dropped connection,
   * which is a fault and must be logged and retried rather than quietly ending consumption.
   * `U26` pins the quiet exit and `U28` pins the contrast; without the second, classifying on
   * the text alone would pass.
   */
  private isShutdownInterrupt(error: unknown): boolean {
    return (
      this.stopRequested &&
      error instanceof Error &&
      error.message === WORKER_STREAM_READ.CONNECTION_CLOSED_ERROR_MESSAGE
    );
  }

  /**
   * Classifies a read failure: repairable (`NOGROUP`) or not.
   *
   * A missing group is the one failure the loop can fix by itself, and it is reachable in
   * normal operation — deleting the stream key was observed to take the group with it. The
   * repair is `ensureConsumerGroup()`, which T-038 made public and re-callable for exactly
   * this, and it retries immediately with no backoff. Everything else is logged and paced.
   *
   * A repair that itself fails falls through to the generic branch rather than escaping: an
   * exception out of here ends the loop, and a worker that has silently stopped consuming
   * while still answering `/health` is the failure mode this whole method exists to prevent.
   */
  private async handleReadFailure(error: unknown): Promise<void> {
    if (
      error instanceof Error &&
      error.message.startsWith(WORKER_STREAM_READ.MISSING_GROUP_ERROR_PREFIX)
    ) {
      const reRegistered = await this.reRegisterGroup();
      if (reRegistered) {
        return;
      }
    }

    this.logger.error(
      {
        streamName: this.streamName,
        groupName: this.groupName,
        consumerName: this.consumerName,
        error: describeError(error)
      },
      "Stream read failed"
    );
    await this.backOff();
  }

  /** `ensureConsumerGroup()`, reporting success instead of throwing. It logs its own failure. */
  private async reRegisterGroup(): Promise<boolean> {
    try {
      await this.ensureConsumerGroup();

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Paces a failing loop. Without it, a read against an unreachable server rejected in 153 ms
   * and then 603 ms, i.e. roughly 6 error lines a second.
   *
   * Bounded and unconditional: at worst it adds `ERROR_BACKOFF_MS` to shutdown, because the
   * stop condition is re-checked immediately afterwards. T-041 owns real retry accounting.
   */
  private backOff(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, WORKER_STREAM_READ.ERROR_BACKOFF_MS);
    });
  }

  /**
   * Reclaims entries a previous worker took and never acknowledged, once, at startup.
   *
   * Paginated, which the epic's one-line "re-claim them with `XAUTOCLAIM`" omits: the command
   * returns a cursor, and a single call leaves everything past the first `COUNT` stranded
   * until the next restart. Measured — 5 pending entries at `COUNT 2` needed three rounds
   * (2 + 2 + 1) before the cursor came back `0-0`.
   *
   * The idle threshold is `STREAM_BLOCK_MS x RECOVERY_IDLE_MULTIPLIER`, so an entry a *live*
   * peer is still working on is not stolen from it.
   *
   * **Best effort.** A failure is logged and swallowed: a worker that refuses to start
   * because it could not reclaim old work is strictly worse than one that starts and reclaims
   * on the next restart, and the entries stay in the pending list regardless.
   *
   * Periodic reclaim — as opposed to this startup pass — is not specified by the epic and is
   * not done here, so work abandoned by a worker that dies *while this one is running* waits
   * for the next restart.
   */
  private async recoverPendingEntries(readConnection: Redis): Promise<void> {
    const minIdleMs = this.blockMs * WORKER_STREAM_READ.RECOVERY_IDLE_MULTIPLIER;
    let cursor: string = WORKER_STREAM_READ.PENDING_START_ID;
    let reclaimed = 0;
    let pages = 0;

    try {
      while (pages < WORKER_STREAM_READ.RECOVERY_MAX_PAGES) {
        const reply = await readConnection.xautoclaim(
          this.streamName,
          this.groupName,
          this.consumerName,
          minIdleMs,
          cursor,
          WORKER_STREAM_READ.OPTION_COUNT,
          this.batchSize
        );
        pages += 1;

        const claim = parseClaimReply(reply);
        reclaimed += claim.entries.length;
        await this.dispatch(claim);

        if (
          claim.nextCursor === null ||
          claim.nextCursor === WORKER_STREAM_READ.PENDING_START_ID
        ) {
          return;
        }

        // Re-checked between pages, which it was not before Round 1: `run()`'s own guard is
        // the *only* check a startup recovery used to make, so a shutdown requested during
        // recovery left it paginating to `RECOVERY_MAX_PAGES` — 10 000 entries at the default
        // batch size — after being told to stop. It does not delay shutdown (`index.ts` never
        // awaits `run()`), it is just work nobody asked for. `U36` pins it.
        //
        // Between pages rather than at the top of the loop, deliberately: `run()` checks
        // immediately before calling this, so a check before the first page would be the same
        // check twice, and one page of recovery is bounded work. The guard belongs where it
        // prevents a round trip.
        if (this.shouldStop()) {
          this.logger.info(
            {
              streamName: this.streamName,
              groupName: this.groupName,
              consumerName: this.consumerName,
              reclaimed
            },
            "Stopped reclaiming pending stream entries: shutdown requested"
          );

          return;
        }

        cursor = claim.nextCursor;
      }

      this.logger.warn(
        {
          streamName: this.streamName,
          groupName: this.groupName,
          consumerName: this.consumerName,
          pages
        },
        "Stopped reclaiming pending stream entries at the page limit"
      );
    } catch (error) {
      // Classified exactly as `readBatch` classifies a read failure, and for the same reason:
      // AC8 says a shutdown interrupt ends quietly, at `info`. Before Round 1
      // `isShutdownInterrupt` was consulted in `readBatch` and nowhere else, so the identical
      // `Connection is closed.` rejection produced a quiet `info` when it landed on an
      // `XREADGROUP` and an ERROR when it landed on an in-flight `XAUTOCLAIM` — a false alarm
      // on every deploy that shuts a worker down mid-recovery. `U35` pins the `info`; `U21`
      // still pins that a genuine recovery failure is an ERROR and does not stop the loop.
      if (this.isShutdownInterrupt(error)) {
        this.logger.info(
          {
            streamName: this.streamName,
            groupName: this.groupName,
            consumerName: this.consumerName
          },
          "Pending-entry recovery interrupted by shutdown"
        );
      } else {
        this.logger.error(
          {
            streamName: this.streamName,
            groupName: this.groupName,
            consumerName: this.consumerName,
            error: describeError(error)
          },
          "Failed to reclaim pending stream entries"
        );
      }
    } finally {
      if (reclaimed > 0) {
        this.logger.info(
          {
            streamName: this.streamName,
            groupName: this.groupName,
            consumerName: this.consumerName,
            reclaimed
          },
          "Reclaimed pending stream entries"
        );
      }
    }
  }

  /**
   * Hands every parsed entry to the handler, in the order the server returned them.
   *
   * Sequential, not `Promise.all`: T-040's handler writes to the database, and the ordering
   * the stream guarantees is worth keeping.
   *
   * A handler rejection is logged against its entry and the batch continues. It does not
   * reach the read-failure classifier — a poison entry is not a connection problem, and
   * treating it as one would abandon the rest of the batch and pause the loop for
   * `ERROR_BACKOFF_MS`. Nothing is acknowledged here, so a failed entry stays in the pending
   * list and comes back through `recoverPendingEntries` after the idle threshold; that is the
   * epic's "on failure, leave in PEL", and retry accounting for it is T-041's.
   */
  private async dispatch(parsed: ParsedEntries): Promise<void> {
    if (parsed.malformed > 0) {
      this.logger.warn(
        {
          streamName: this.streamName,
          groupName: this.groupName,
          malformed: parsed.malformed
        },
        "Skipped stream reply elements that were not entries"
      );
    }

    for (const entry of parsed.entries) {
      try {
        await this.handler(entry.id, entry.fields);
      } catch (error) {
        // Entry id only, never the fields: they carry `tenantId` and customer-shaped event
        // metadata, and this service has no redaction layer.
        this.logger.error(
          {
            streamName: this.streamName,
            groupName: this.groupName,
            consumerName: this.consumerName,
            entryId: entry.id,
            error: describeError(error)
          },
          "Stream entry handler failed"
        );
      }
    }
  }
}
