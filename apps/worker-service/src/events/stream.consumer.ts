import type Redis from "ioredis";
import type { Logger } from "pino";
import type { ServiceEnv } from "../config/env";
import { WORKER_CONSUMER_GROUP_BOOTSTRAP } from "../constants";

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

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    env: ServiceEnv
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

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          streamName: this.streamName,
          groupName: this.groupName,
          error: errorMessage
        },
        "Failed to ensure stream consumer group"
      );
      throw error;
    }
  }
}
