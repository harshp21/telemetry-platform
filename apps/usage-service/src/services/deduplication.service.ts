import type Redis from "ioredis";
import type { Logger } from "pino";
import { DEDUP_CONSTANTS } from "../constants";

/**
 * DeduplicationService: Prevents duplicate event processing using Redis SET with TTL.
 *
 * Implements idempotent event ingestion by storing idempotency keys in Redis
 * with a 24-hour TTL. Uses Redis SET NX (only set if not exists) for atomic operations.
 *
 * Error handling: Fail-open. On any Redis error (connection, timeout, etc.),
 * log the error and return true (treat as new event). This prevents silent
 * data loss from deduplication failures; upstream circuit breakers handle retries.
 */
export class DeduplicationService {
  private readonly ttlSeconds = DEDUP_CONSTANTS.KEY_TTL_SECONDS;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger
  ) {}

  /**
   * Determines if an event is new (never seen before) or a duplicate.
   *
   * @param idempotencyKey - Full key including prefix and components (e.g., "dedup:tenant:type:source:timestamp")
   * @returns true if new event (SET succeeded), false if duplicate (SET failed), true if Redis error (fail-open)
   */
  async isNew(idempotencyKey: string): Promise<boolean> {
    try {
      // Redis SET NX: Set key only if it does not exist
      // Returns "OK" if SET succeeded (new event), null if key already exists (duplicate)
      const result = await this.redis.set(
        idempotencyKey,
        "1",
        "EX",
        this.ttlSeconds,
        "NX"
      );

      // "OK" means the key was set (new event)
      if (result === "OK") {
        return true;
      }

      // null means the key already existed (duplicate)
      if (result === null) {
        return false;
      }

      // Unexpected response; treat as new to be safe
      return true;
    } catch (error) {
      // Fail-open: On any Redis error, log and return true (treat as new)
      // This prevents silent event drops; upstream retry logic handles persistence
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          key: idempotencyKey,
          service: "deduplication"
        },
        "Redis deduplication check failed; treating as new event (fail-open)"
      );
      return true;
    }
  }
}
