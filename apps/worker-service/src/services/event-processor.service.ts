import type Redis from "ioredis";
import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import type { ServiceEnv } from "../config/env";
import type { EventRepository } from "../repositories/event.repository";
import type { StreamMessageHandler } from "../events/stream.consumer";
import { WORKER_EVENT_PROCESSING } from "../constants";
import { parseStreamMessage } from "../validators/stream-message.validator";

/**
 * Builds a repository bound to one tenant.
 *
 * A **factory**, never a singleton (`.claude/rules/tenant-isolation.md`): `tenantId` is a
 * constructor argument of `TenantScopedRepository`, so one shared instance would pin a single
 * tenant process-wide — and this worker reads every tenant's events off one stream, so it
 * would be the *first* tenant it happened to see. Mirrors `usageRepositoryFactory` in
 * `apps/usage-service/src/config/container.ts`.
 */
export type EventRepositoryFactory = (tenantId: TenantId) => EventRepository;

/**
 * Turns one stream entry into an `Event` and a `UsageLine`, then acknowledges it.
 *
 * ## The acknowledgement contract
 *
 * `XACK` happens **only after** the repository's transaction has resolved. T-039 built the
 * handler seam for exactly this and acknowledged nothing itself (D2-A); this is where that is
 * settled. The ordering is the whole point rather than a detail:
 *
 * - Acknowledge **before** the commit and a process that dies in between loses the event
 *   permanently — the entry is gone from the pending list and nothing stored it.
 * - Acknowledge **after** and the worst case is a redelivery, which the idempotent upsert on
 *   `(tenantId, idempotencyKey)` absorbs into a no-op.
 *
 * Anything this method throws propagates to `StreamConsumer.dispatch`, which logs it against
 * the entry id and continues the batch **without** acknowledging. So a failure leaves the entry
 * in the group's pending list, which is the epic's stated T-040 behaviour. Retry accounting and
 * a dead-letter destination are T-041's; until then a permanently-failing message — an unknown
 * tenant, say, which `Event_tenantId_fkey` rejects — is reclaimed and retried on every restart,
 * indefinitely.
 *
 * Scope of "only after", stated as what is established rather than as an impossibility: `U43`
 * goes red if the `xack` is moved above the `await`, and `U54` goes red if a throwing
 * transaction still acknowledges. Nothing in the type system stops a future `xack` elsewhere in
 * this service.
 *
 * ## Which connection the acknowledgement goes on
 *
 * The container's client, never the loop's. `StreamConsumer.run()` opens a private
 * `duplicate()` and parks it on a blocking `XREADGROUP` for up to `STREAM_BLOCK_MS`; a command
 * queued behind that read waits it out — an unrelated `PING` issued during a `BLOCK 2000` was
 * measured returning after 2 080 ms. This class is handed the container's connection and never
 * duplicates one.
 *
 * ## What gets logged
 *
 * Entry id and event id. **Never the fields**: they carry `tenantId` and customer-supplied
 * metadata, and this service has no redaction layer. Same rule `buildDefaultMessageHandler`
 * and `dispatch` already follow, and `U45` asserts it across every logger method rather than
 * just the one the happy path uses.
 */
export class EventProcessorService {
  private readonly streamName: string;
  private readonly groupName: string;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    env: ServiceEnv,
    private readonly eventRepositoryFactory: EventRepositoryFactory
  ) {
    // Straight from the parsed environment, with no `|| DEFAULT_*` fallback, for the reason
    // `StreamConsumer`'s constructor gives: both fields are `z.string().min(1).default(...)`,
    // so `parseEnv` either throws or yields a non-empty string. The two must resolve to the
    // same stream and group the loop read from, which is why they come from one `ServiceEnv`
    // rather than being passed in separately.
    this.streamName = env.REDIS_STREAM_NAME;
    this.groupName = env.REDIS_CONSUMER_GROUP;
  }

  /**
   * The `StreamMessageHandler` to hand `StreamConsumer` as its fifth constructor argument.
   *
   * A bound handler rather than a method reference so that `index.ts` passes a value with the
   * right shape and nothing has to remember to `.bind(...)`.
   */
  buildHandler(): StreamMessageHandler {
    return (id: string, fields: string[]): Promise<void> => this.process(id, fields);
  }

  /**
   * Parse, write, acknowledge — in that order, with no step skippable.
   *
   * The parse happens before a repository exists, so an entry that cannot be understood never
   * selects a tenant and never opens a transaction.
   */
  private async process(entryId: string, fields: string[]): Promise<void> {
    // Called directly rather than injected: the parser is a pure function with no
    // configuration, so a seam here would have nothing on the other side of it. Its throw is
    // the contract (see the class docstring), which is why nothing catches it.
    const payload = parseStreamMessage(fields);

    // Per message, from the tenant id the parser validated as a UUID. This is the only thing
    // the message's tenant id is used for — the repository writes its own bound copy.
    const repository = this.eventRepositoryFactory(payload.tenantId);
    const result = await repository.upsertEventWithUsageLine(payload);

    await this.acknowledge(entryId);

    this.logger.info(
      {
        streamName: this.streamName,
        groupName: this.groupName,
        entryId,
        eventId: result.eventId,
        created: result.created
      },
      WORKER_EVENT_PROCESSING.LOG.PROCESSED
    );
  }

  /**
   * `XACK`, logging and rethrowing on failure rather than swallowing it.
   *
   * The write has committed by the time this runs, so a failed acknowledgement is not data
   * loss — the entry stays pending and is redelivered, and the upsert absorbs it. It is still
   * rethrown: reporting a clean success for an entry that is certain to come back would make a
   * redelivery loop invisible, and `dispatch` logging it against the entry id is how it stays
   * attributable.
   */
  private async acknowledge(entryId: string): Promise<void> {
    try {
      await this.redis.xack(this.streamName, this.groupName, entryId);
    } catch (error) {
      this.logger.error(
        {
          streamName: this.streamName,
          groupName: this.groupName,
          entryId,
          error: error instanceof Error ? error.message : String(error)
        },
        WORKER_EVENT_PROCESSING.LOG.ACK_FAILED
      );
      throw error;
    }
  }
}
