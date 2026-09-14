import type Redis from "ioredis";
import type { Logger } from "pino";
import type { ServiceEnv } from "../config/env";
import type { StreamMessageHandler } from "../events/stream.consumer";
import { WORKER_DEAD_LETTER } from "../constants";
import { describeError } from "../utils/describe-error";

/**
 * Retry accounting for one stream entry, and the ending a permanently-failing one gets.
 *
 * ## Why this is a decorator and not a step inside something else
 *
 * `wrap(inner)` returns a `StreamMessageHandler` with the same shape as the one it is given, so
 * it goes between `StreamConsumer.dispatch` and `EventProcessorService.buildHandler()`'s
 * handler without either of them knowing. That is decision A, and the reason is that both
 * neighbours have documented contracts this task must not falsify:
 *
 * - `dispatch` states that nothing is acknowledged there. Counting inside it would need an
 *   `XACK`, and would have moved the acknowledgement into the file with this package's worst
 *   stale-citation record.
 * - `EventProcessorService.process` states that anything it throws propagates to `dispatch`.
 *   Counting inside it would have made that false for the terminal failure.
 *
 * A **retryable** failure is still rethrown from here, so `dispatch`'s `HANDLER_FAILED` log line
 * keeps its meaning and `U29`/`I18` keep theirs. Only the terminal failure is swallowed, and
 * only after the entry has been recorded in the dead-letter stream and acknowledged -- at which
 * point rethrowing would report a failure for an entry that is finished.
 *
 * ## What "three attempts" costs in wall-clock time
 *
 * Nothing here sleeps, schedules, or backs off. Q10 settled on **no retry delay**, and what
 * spaces the attempts instead is a threshold that already existed:
 * `STREAM_BLOCK_MS x WORKER_STREAM_READ.RECOVERY_IDLE_MULTIPLIER`, the minimum idle time
 * `XAUTOCLAIM` requires before it will take an entry back. After T-041's reclaim cadence that
 * one threshold does double duty -- peer safety *and* retry spacing -- so a change to either
 * constant moves the retry spacing too. Said here and in that constant's own docblock; no test
 * asserts the coupling, because asserting it would mean pinning a wall-clock relationship.
 *
 * ## Which connection
 *
 * The container's, never the loop's `duplicate()`. `StreamConsumer.run()` parks its duplicate
 * on a blocking `XREADGROUP`, and a command queued behind that read waits it out -- an unrelated
 * `PING` during a `BLOCK 2000` was measured returning after 2 080 ms. That figure is
 * **inherited from T-039's probe and was not re-run for T-041**; what T-041 adds is that the
 * pre-check `HGET` runs on every delivered entry, so the happy path would pay it. Same argument
 * `EventProcessorService`'s docstring and `container.ts` already make, and `U61` asserts this
 * class never calls `duplicate()`.
 *
 * ## What this class does **not** touch
 *
 * No repository, no Prisma client, no migration. Every command it issues is Redis: `HGET`,
 * `HINCRBY`, `EXPIRE`, `HDEL`, `XADD`, `XACK`. In particular `failedAt` is a string field inside
 * the Redis dead-letter record and **not** a database column -- worker-service's `withTenant`
 * has no `set_config('TimeZone','UTC',true)` pin (S-19), so a timestamp bound into raw SQL in
 * this service would inherit S-18 whole. `U61` is what holds that: the constructor takes three
 * infrastructure arguments and no repository factory, and the suite's Redis fixture throws on
 * any command outside the six.
 */
export class DeadLetterService {
  private readonly streamName: string;
  private readonly groupName: string;
  private readonly deadLetterStream: string;
  private readonly maxRetryCount: number;
  /**
   * `retries:<streamName>`, built once from this service's own prefix and the parsed env.
   *
   * Never from anything a caller passes: `wrap`'s handler receives an entry id and a field
   * list, and neither reaches the key. The entry id is the hash *field*.
   */
  private readonly retryKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    env: ServiceEnv
  ) {
    // Straight from the parsed environment with no `|| DEFAULT_*` fallback, for the reason
    // `StreamConsumer`'s constructor gives: all four fields are declared with a `.default(...)`
    // and a lower bound, so `parseEnv` either throws or yields a usable value. The stream and
    // group must be the ones the loop read from, which is why they come from one `ServiceEnv`.
    this.streamName = env.REDIS_STREAM_NAME;
    this.groupName = env.REDIS_CONSUMER_GROUP;
    this.deadLetterStream = env.DEAD_LETTER_STREAM;
    this.maxRetryCount = env.MAX_RETRY_COUNT;
    this.retryKey = `${WORKER_DEAD_LETTER.RETRY_KEY_PREFIX}${this.streamName}`;
  }

  /**
   * The handler to hand `StreamConsumer` in place of the processor's own.
   *
   * Pre-check, then delegate, then account for the outcome:
   *
   * 1. `HGET` the entry's counter. At or above the budget, dead-letter it **without** calling
   *    `inner` -- which is what makes a crash between the `HINCRBY` and the `XADD` terminal
   *    rather than granting one more attempt.
   * 2. On success, `HDEL` the counter *only if* the pre-check found one. So the happy path
   *    costs exactly one extra round trip, not two (plan R4, a stated trade rather than a
   *    silent one).
   * 3. On failure, `HINCRBY` and refresh the key TTL. Below the budget, rethrow. At it,
   *    dead-letter and resolve.
   */
  wrap(inner: StreamMessageHandler): StreamMessageHandler {
    return async (id: string, fields: string[]): Promise<void> => {
      const priorCount = await this.readRetryCount(id);
      if (priorCount >= this.maxRetryCount) {
        await this.deadLetter(id, fields, WORKER_DEAD_LETTER.REASON_BUDGET_EXHAUSTED, priorCount);

        return;
      }

      try {
        await inner(id, fields);
      } catch (error) {
        const count = await this.recordFailure(id);
        if (count >= this.maxRetryCount) {
          await this.deadLetter(id, fields, describeError(error), count);

          return;
        }

        // Rethrown on purpose: `dispatch` logs it against the entry id and does not
        // acknowledge, so the entry stays pending and comes back on the next reclaim pass.
        throw error;
      }

      if (priorCount > WORKER_DEAD_LETTER.RETRY_COUNT_NONE) {
        await this.redis.hdel(this.retryKey, id);
      }
    };
  }

  /**
   * The entry's failure count, or zero.
   *
   * `HGET` replies `(nil)` for an absent field, which ioredis surfaces as `null`. A reply that
   * is not a number is coerced to zero rather than left as `NaN`.
   *
   * **That coercion is defence-in-depth, not a live protection, and the distinction was
   * measured.** At every legal configuration it changes nothing observable: `priorCount` is used
   * only at `priorCount >= this.maxRetryCount` and `priorCount > RETRY_COUNT_NONE`, and `NaN`
   * and `0` fail both for every `maxRetryCount >= 1` -- which the schema enforces via
   * `MAX_RETRY_COUNT_MIN: 1`. Driving `wrap()` over a corrupt counter, an empty string and a
   * valid count, with `inner` both succeeding and failing, produced byte-identical command
   * sequences and outcomes with this coercion present and with a bare `return parsed`. So **no
   * behaviour test can distinguish the two**, and none is written: a case that passes either way
   * is a coverage tick, and the alternatives -- reaching this private method by cast, or forcing
   * `MAX_RETRY_COUNT: 0` through `as ServiceEnv` -- assert an implementation value or construct
   * a configuration the schema rejects, which is the shape Gate 4 filed as L-7.
   *
   * **When it becomes load-bearing:** at `maxRetryCount === 0` the two diverge, because
   * `0 >= 0` is true while `NaN >= 0` is false -- measured: with the coercion the entry is
   * dead-lettered on arrival and `inner` never runs; without it the entry is processed. Only
   * `MAX_RETRY_COUNT_MIN: 1` keeps that unreachable. Lowering that floor, or adding a use site
   * that compares differently, makes this line the difference between "never dead-letter" and
   * the intended budget -- which is why it stays.
   *
   * **`U72` is what holds the floor**, and it was added because nothing did: the Gate-6 reviewer
   * set `MAX_RETRY_COUNT_MIN` to `0` and the package stayed 156/156 green, reproduced before the
   * case was written. `U72` asserts a **literal** `MAX_RETRY_COUNT=0` is rejected, because the
   * neighbouring bounds case derives its input as `String(MAX_RETRY_COUNT_MIN - 1)` and
   * therefore moves with the constant -- measured: at `MIN: 0` that input becomes `"-1"` and is
   * still rejected, while `MAX_RETRY_COUNT=0` starts parsing successfully.
   *
   * An earlier revision of this docstring said a corrupt counter "would silently grant unlimited
   * retries, where zero grants the normal budget". Both clauses were false: the two values grant
   * identically at any legal budget. Corrected at the Gate-5 QA round (F-3).
   *
   * **What a corrupt counter actually does, measured at Gate 6 (R3-3), because the replacement
   * sentence was also wrong.** It is not "unlimited retries" and it is not the normal budget.
   * `HINCRBY` against a non-integer field **errors** (`ERR hash value is not an integer`), so the
   * failure path throws before it can dead-letter: observed at `max=3` with a corrupt value,
   * `cmds=[hget,hincrby]`, outcome `threw`. The entry is therefore **never dead-lettered** and is
   * re-offered on every reclaim pass. What ends it is the key's 24 h TTL -- and that TTL is
   * **not refreshed on this path**, because `EXPIRE` is issued after the `HINCRBY` that threw.
   * So the real behaviour is "retried until the key expires, at most ~24 h from the last
   * successful increment", which is bounded but is neither thing this docstring previously
   * claimed. Unreachable in practice: only this service writes the key, and it writes integers.
   */
  private async readRetryCount(entryId: string): Promise<number> {
    const raw = await this.redis.hget(this.retryKey, entryId);
    if (raw === null) {
      return WORKER_DEAD_LETTER.RETRY_COUNT_NONE;
    }

    const parsed = Number.parseInt(raw, WORKER_DEAD_LETTER.RETRY_COUNT_RADIX);

    return Number.isNaN(parsed) ? WORKER_DEAD_LETTER.RETRY_COUNT_NONE : parsed;
  }

  /**
   * One failure: increment, then refresh the key's TTL.
   *
   * The TTL is refreshed on **every** increment rather than set once, so the hash lives as long
   * as failures keep arriving and self-expires after a quiet period. See
   * `WORKER_DEAD_LETTER.RETRY_KEY_TTL_SECONDS` for the orphaned-field measurement that makes it
   * necessary and for why it cannot be per-field on Redis 7.0.15.
   */
  private async recordFailure(entryId: string): Promise<number> {
    const count = await this.redis.hincrby(
      this.retryKey,
      entryId,
      WORKER_DEAD_LETTER.RETRY_COUNT_INCREMENT
    );
    await this.redis.expire(this.retryKey, WORKER_DEAD_LETTER.RETRY_KEY_TTL_SECONDS);

    return count;
  }

  /**
   * Record, acknowledge, forget -- in that order, and the order is the guarantee.
   *
   * A crash between `XADD` and `XACK` leaves the entry pending with an exhausted counter, so
   * the pre-check dead-letters it again: a duplicate record, which is recoverable. `HDEL` first
   * would reset the counter and grant a fresh budget; `XACK` first would risk a dead letter
   * that was acknowledged and never recorded. At-least-once, in the direction that keeps the
   * record. `U65` pins it by invocation order.
   *
   * The record carries the whole original field list because a pending id is not a handle on
   * its data -- see `WORKER_DEAD_LETTER.FIELD` for the `MAXLEN` measurement.
   *
   * Nothing here is wrapped in a `try`: a failure of the `XADD` propagates, which leaves the
   * entry pending and its counter intact, so the next delivery tries to dead-letter it again.
   * That is the right direction to fail in -- the alternative, swallowing it, acknowledges
   * nothing and reports success for an entry nobody recorded.
   */
  private async deadLetter(
    entryId: string,
    fields: string[],
    failureReason: string,
    retryCount: number
  ): Promise<void> {
    await this.redis.xadd(
      this.deadLetterStream,
      WORKER_DEAD_LETTER.ENTRY_AUTO_ID,
      WORKER_DEAD_LETTER.FIELD.ORIGINAL_ID,
      entryId,
      WORKER_DEAD_LETTER.FIELD.STREAM_NAME,
      this.streamName,
      WORKER_DEAD_LETTER.FIELD.GROUP_NAME,
      this.groupName,
      WORKER_DEAD_LETTER.FIELD.PAYLOAD,
      JSON.stringify(fields),
      WORKER_DEAD_LETTER.FIELD.FAILURE_REASON,
      failureReason,
      WORKER_DEAD_LETTER.FIELD.FAILED_AT,
      new Date().toISOString(),
      WORKER_DEAD_LETTER.FIELD.RETRY_COUNT,
      String(retryCount)
    );
    await this.redis.xack(this.streamName, this.groupName, entryId);
    await this.redis.hdel(this.retryKey, entryId);

    // Entry id, stream identity and the count. **Never the fields**: they carry `tenantId` and
    // customer-supplied metadata, and this service has no redaction layer -- the same rule
    // `dispatch` and `EventProcessorService` follow, and `U68` asserts it across every logger
    // method rather than just this one.
    //
    // `failureReason` *is* logged, and the scope of that is worth stating: it is an error
    // message, which is the same exposure `dispatch` already has when it logs
    // `error: describeError(error)` on every retryable failure. What T-041 changes is the
    // parser's contribution to it -- a malformed message now yields zod `code`/`path` pairs and
    // no value at all, which is the half of the retired S-31 gap this service's wrapper
    // completes. A message from elsewhere, a Prisma driver error say, is outside this task's
    // control and is already logged today.
    this.logger.error(
      {
        streamName: this.streamName,
        groupName: this.groupName,
        deadLetterStream: this.deadLetterStream,
        entryId,
        retryCount,
        failureReason
      },
      WORKER_DEAD_LETTER.LOG.DEAD_LETTERED
    );
  }
}
