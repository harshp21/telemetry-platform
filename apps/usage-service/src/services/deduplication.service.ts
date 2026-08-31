import type Redis from "ioredis";
import type { Logger } from "pino";
import { DEDUP_CONSTANTS } from "../constants";

/**
 * DeduplicationService: Prevents duplicate event processing using Redis SET with TTL.
 *
 * Implements idempotent event ingestion by storing idempotency keys in Redis
 * with a 24-hour TTL. Uses Redis SET NX (only set if not exists) for atomic operations.
 *
 * Keyspace ownership: this service builds every Redis key itself, from a tenant id and
 * a raw key, as `<KEY_PREFIX><tenantId>:<rawKey>`. Callers pass components, never a
 * pre-built key, so a caller-supplied idempotency key can neither cross a tenant
 * boundary nor become a top-level key in the platform keyspace. See
 * `.claude/rules/tenant-isolation.md`.
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
   * Builds the namespaced Redis key for a deduplication entry.
   *
   * The single construction site for the dedup keyspace. The tenant segment is what
   * keeps one tenant's idempotency key from suppressing another's event; the prefix is
   * what keeps it out of the platform keyspace (e.g. the `telemetry:events` stream).
   *
   * @param tenantId - The authenticated tenant the event belongs to
   * @param idempotencyKey - Raw key: client-supplied or derived by the caller
   * @returns The fully namespaced Redis key
   */
  private buildKey(tenantId: string, idempotencyKey: string): string {
    return `${DEDUP_CONSTANTS.KEY_PREFIX}${tenantId}:${idempotencyKey}`;
  }

  /**
   * Determines if an event is new (never seen before) or a duplicate.
   *
   * Deduplication is scoped to the tenant: the same `idempotencyKey` submitted by two
   * different tenants is two distinct events.
   *
   * @param tenantId - The authenticated tenant the event belongs to
   * @param idempotencyKey - Raw key (client-supplied or caller-derived), WITHOUT prefix
   *                         or tenant namespace — this service adds both
   * @returns true if new event (SET succeeded), false if duplicate (SET failed), true if Redis error (fail-open)
   */
  async isNew(tenantId: string, idempotencyKey: string): Promise<boolean> {
    const key = this.buildKey(tenantId, idempotencyKey);

    try {
      // Redis SET NX: Set key only if it does not exist
      // Returns "OK" if SET succeeded (new event), null if key already exists (duplicate)
      const result = await this.redis.set(key, "1", "EX", this.ttlSeconds, "NX");

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
          key,
          service: "deduplication"
        },
        "Redis deduplication check failed; treating as new event (fail-open)"
      );
      return true;
    }
  }
}
