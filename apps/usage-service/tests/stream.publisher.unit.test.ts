import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";
import type Redis from "ioredis";
import type { ServiceEnv } from "../src/config/env";
import { StreamPublisher } from "../src/events/stream.publisher";
import {
  eventIdSchema,
  tenantIdSchema,
  type TelemetryEventEnvelope
} from "@telemetry/shared-validation";

describe("StreamPublisher", () => {
  let mockRedis: Record<string, ReturnType<typeof vi.fn>>;
  let mockLogger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
  let mockEnv: Partial<ServiceEnv>;
  let publisher: StreamPublisher;

  const eventId = eventIdSchema.parse("550e8400-e29b-41d4-a716-446655440000");
  const tenantId = tenantIdSchema.parse(
    "550e8400-e29b-41d4-a716-446655440001"
  );

  const mockEvent: TelemetryEventEnvelope = {
    eventId,
    tenantId,
    eventType: "api.request",
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    source: "test-source",
    idempotencyKey: "test-key",
    version: 1,
    payload: {
      quantity: 100,
      unit: "requests",
      occurredAt: new Date().toISOString()
    }
  };

  beforeEach(() => {
    mockRedis = {
      xadd: vi.fn()
    };
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn()
    };
    mockEnv = {
      REDIS_STREAM_NAME: "telemetry:events",
      STREAM_MAX_LEN: 100_000
    };
    publisher = new StreamPublisher(
      mockRedis as unknown as Redis,
      mockLogger as unknown as Logger,
      mockEnv as ServiceEnv
    );
  });

  describe("publish", () => {
    it("should return a stream ID string for a single event publish", async () => {
      // Arrange
      const streamId = "1234567890-0";
      (mockRedis.xadd as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        streamId
      );

      // Act
      const result = await publisher.publish(mockEvent);

      // Assert
      expect(result).toBe(streamId);
      expect(mockRedis.xadd).toHaveBeenCalled();
    });

    it("should return unique stream IDs for sequential publishes", async () => {
      // Arrange
      const streamId1 = "1234567890-0";
      const streamId2 = "1234567891-0";
      const streamId3 = "1234567892-0";
      (mockRedis.xadd as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(streamId1)
        .mockResolvedValueOnce(streamId2)
        .mockResolvedValueOnce(streamId3);

      // Act
      const result1 = await publisher.publish(mockEvent);
      const result2 = await publisher.publish(mockEvent);
      const result3 = await publisher.publish(mockEvent);

      // Assert
      expect(result1).toBe(streamId1);
      expect(result2).toBe(streamId2);
      expect(result3).toBe(streamId3);
      expect(new Set([result1, result2, result3]).size).toBe(3);
    });

    it("should enforce MAXLEN to retain last 100,000 entries", async () => {
      // Arrange
      const streamId = "1234567890-0";
      (mockRedis.xadd as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        streamId
      );

      // Act
      await publisher.publish(mockEvent);

      // Assert
      expect(mockRedis.xadd).toHaveBeenCalled();
      const callArgs = (mockRedis.xadd as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(callArgs).toContain("MAXLEN");
      expect(callArgs).toContain("~");
      expect(callArgs).toContain(100000);
    });

    it("should throw error on Redis connection failure (ECONNREFUSED) - fail-closed", async () => {
      // Arrange
      const error = new Error("ECONNREFUSED");
      (mockRedis.xadd as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        error
      );

      // Act & Assert
      await expect(publisher.publish(mockEvent)).rejects.toThrow("ECONNREFUSED");
    });

    it("should throw error on Redis timeout - fail-closed", async () => {
      // Arrange
      const error = new Error("Operation timeout");
      (mockRedis.xadd as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        error
      );

      // Act & Assert
      await expect(publisher.publish(mockEvent)).rejects.toThrow(
        "Operation timeout"
      );
    });

    it("should log event info at info level on successful publish", async () => {
      // Arrange
      const streamId = "1234567890-0";
      (mockRedis.xadd as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        streamId
      );

      // Act
      await publisher.publish(mockEvent);

      // Assert
      expect(mockLogger.info).toHaveBeenCalled();
      const logCall = (mockLogger.info as ReturnType<typeof vi.fn>).mock
        .calls[0];
      if (logCall?.[1]) {
        expect((logCall[1] as string)).toContain("Published event to stream");
      }
    });

    it("should handle concurrent publishes with 5 parallel calls returning unique IDs", async () => {
      // Arrange
      const streamIds = [
        "1234567890-0",
        "1234567891-0",
        "1234567892-0",
        "1234567893-0",
        "1234567894-0"
      ];
      streamIds.forEach((id) => {
        (mockRedis.xadd as ReturnType<typeof vi.fn>).mockResolvedValueOnce(id);
      });

      // Act
      const results = await Promise.all([
        publisher.publish(mockEvent),
        publisher.publish(mockEvent),
        publisher.publish(mockEvent),
        publisher.publish(mockEvent),
        publisher.publish(mockEvent)
      ]);

      // Assert
      expect(results).toEqual(streamIds);
      expect(new Set(results).size).toBe(5); // All unique
    });

    it("should handle large event payload and return stream ID", async () => {
      // Arrange
      const largePayload = {
        quantity: 100,
        unit: "requests",
        occurredAt: new Date().toISOString(),
        metadata: {
          largeData: "x".repeat(500 * 1024) // 500KB of data
        }
      };
      const largeEvent: TelemetryEventEnvelope = {
        ...mockEvent,
        payload: largePayload as unknown as typeof mockEvent.payload
      };
      const streamId = "1234567890-0";
      (mockRedis.xadd as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        streamId
      );

      // Act
      const result = await publisher.publish(largeEvent);

      // Assert
      expect(result).toBe(streamId);
      expect(mockRedis.xadd).toHaveBeenCalled();
    });
  });
});
