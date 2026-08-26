import type Redis from "ioredis";
import type { Logger } from "pino";
import type { TelemetryEventEnvelope } from "@telemetry/shared-validation";
import type { ServiceEnv } from "../config/env";
import { STREAM_CONSTANTS } from "../constants";

/**
 * StreamPublisher: Publishes events to Redis Streams for downstream consumption.
 *
 * Implements real-time event streaming by writing deduplicated events to Redis Streams.
 * Uses XADD with MAXLEN to maintain a fixed-size retention window (default 100k entries).
 *
 * Error handling: Fail-closed. On any Redis error, log and throw.
 * Caller is responsible for retry logic, circuit breaking, and dead-lettering.
 */
export class StreamPublisher {
  private readonly streamName: string;
  private readonly maxLen: number;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    env: ServiceEnv
  ) {
    // Use values from parsed environment (T-030 schema ensures defaults are set)
    this.streamName =
      env.REDIS_STREAM_NAME || STREAM_CONSTANTS.DEFAULT_STREAM_NAME;
    this.maxLen = env.STREAM_MAX_LEN || STREAM_CONSTANTS.DEFAULT_MAX_LEN;
  }

  /**
   * Publishes a single event to the Redis Stream.
   *
   * Uses XADD with MAXLEN ~ (approximate trimming) to maintain retention window.
   * Logs published events at info level for observability.
   *
   * @param event - The telemetry event to publish
   * @returns Redis stream entry ID (e.g., "1234567890-0")
   * @throws Error if Redis operation fails (fail-closed)
   */
  async publish(event: TelemetryEventEnvelope): Promise<string> {
    try {
      // Serialize event to field-value pairs for XADD
      // XADD stream_name MAXLEN ~ max_len * field1 value1 field2 value2 ...
      const result = await this.redis.xadd(
        this.streamName,
        "MAXLEN",
        "~",
        this.maxLen,
        "*", // Auto-generate timestamp
        "eventId",
        event.eventId,
        "tenantId",
        event.tenantId,
        "eventType",
        event.eventType,
        "occurredAt",
        event.occurredAt,
        "receivedAt",
        event.receivedAt,
        "source",
        event.source,
        "idempotencyKey",
        event.idempotencyKey,
        "version",
        String(event.version),
        "payload",
        JSON.stringify(event.payload)
      );

      // XADD should always return a stream ID string, but TypeScript types it as string | null
      const streamId = result ?? "unknown";

      // Log successful publish at info level
      this.logger.info(
        {
          streamId,
          streamName: this.streamName,
          tenantId: event.tenantId,
          eventType: event.eventType,
          eventId: event.eventId
        },
        "Published event to stream"
      );

      return streamId;
    } catch (error) {
      // Fail-closed: On any error, log and throw for caller to handle
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          streamName: this.streamName,
          eventId: event.eventId,
          tenantId: event.tenantId,
          error: errorMessage
        },
        "Failed to publish event to stream"
      );
      throw error;
    }
  }
}
