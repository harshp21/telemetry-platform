import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";
import type Redis from "ioredis";
import { DeduplicationService } from "../src/services/deduplication.service";

describe("DeduplicationService", () => {
  let mockRedis: { set: ReturnType<typeof vi.fn> };
  let mockLogger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
  let service: DeduplicationService;

  beforeEach(() => {
    mockRedis = {
      set: vi.fn()
    };
    mockLogger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn()
    };
    service = new DeduplicationService(
      mockRedis as unknown as Redis,
      mockLogger as unknown as Logger
    );
  });

  describe("isNew", () => {
    it("should return true for a new event (first occurrence)", async () => {
      // Arrange
      const idempotencyKey = "dedup:tenant1:api.request:source1:1000";
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce("OK");

      // Act
      const result = await service.isNew(idempotencyKey);

      // Assert
      expect(result).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        idempotencyKey,
        "1",
        "EX",
        86400,
        "NX"
      );
    });

    it("should return false for a duplicate event (same key, second call)", async () => {
      // Arrange
      const idempotencyKey = "dedup:tenant1:api.request:source1:1000";
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      // Act
      const result = await service.isNew(idempotencyKey);

      // Assert
      expect(result).toBe(false);
      expect(mockRedis.set).toHaveBeenCalledWith(
        idempotencyKey,
        "1",
        "EX",
        86400,
        "NX"
      );
    });

    it("should return true for a different tenant (different key)", async () => {
      // Arrange
      const key1 = "dedup:tenant1:api.request:source1:1000";
      const key2 = "dedup:tenant2:api.request:source1:1000";
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce("OK");

      // Act
      const result1 = await service.isNew(key1);
      const result2 = await service.isNew(key2);

      // Assert
      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });

    it("should return true for a different event type (different key)", async () => {
      // Arrange
      const key1 = "dedup:tenant1:api.request:source1:1000";
      const key2 = "dedup:tenant1:billing.invoice:source1:1000";
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce("OK");

      // Act
      const result1 = await service.isNew(key1);
      const result2 = await service.isNew(key2);

      // Assert
      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });

    it("should return true for a different source ID (different key)", async () => {
      // Arrange
      const key1 = "dedup:tenant1:api.request:source1:1000";
      const key2 = "dedup:tenant1:api.request:source2:1000";
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce("OK");

      // Act
      const result1 = await service.isNew(key1);
      const result2 = await service.isNew(key2);

      // Assert
      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });

    it("should return true for a different timestamp (different key)", async () => {
      // Arrange
      const key1 = "dedup:tenant1:api.request:source1:1000";
      const key2 = "dedup:tenant1:api.request:source1:2000";
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce("OK");

      // Act
      const result1 = await service.isNew(key1);
      const result2 = await service.isNew(key2);

      // Assert
      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });

    it("should return true on Redis connection error (ECONNREFUSED) - fail-open", async () => {
      // Arrange
      const idempotencyKey = "dedup:tenant1:api.request:source1:1000";
      const error = new Error("ECONNREFUSED");
      (mockRedis.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

      // Act
      const result = await service.isNew(idempotencyKey);

      // Assert
      expect(result).toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "ECONNREFUSED",
          key: idempotencyKey,
          service: "deduplication"
        }),
        expect.stringContaining("Redis deduplication check failed")
      );
    });

    it("should return true on Redis timeout - fail-open", async () => {
      // Arrange
      const idempotencyKey = "dedup:tenant1:api.request:source1:1000";
      const error = new Error("Operation timeout");
      (mockRedis.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

      // Act
      const result = await service.isNew(idempotencyKey);

      // Assert
      expect(result).toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Operation timeout",
          key: idempotencyKey,
          service: "deduplication"
        }),
        expect.stringContaining("Redis deduplication check failed")
      );
    });

    it("should use 24-hour TTL (86400 seconds) for Redis keys", async () => {
      // Arrange
      const idempotencyKey = "dedup:tenant1:api.request:source1:1000";
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce("OK");

      // Act
      await service.isNew(idempotencyKey);

      // Assert
      expect(mockRedis.set).toHaveBeenCalledWith(
        idempotencyKey,
        "1",
        "EX",
        86400, // Verify TTL is exactly 24 hours
        "NX"
      );
    });

    it("should handle concurrent calls to the same key with atomic Redis operation", async () => {
      // Arrange
      const idempotencyKey = "dedup:tenant1:api.request:source1:1000";
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK") // First call succeeds
        .mockResolvedValueOnce(null); // Second concurrent call gets duplicate

      // Act
      const result1 = await service.isNew(idempotencyKey);
      const result2 = await service.isNew(idempotencyKey);

      // Assert
      expect(result1).toBe(true);
      expect(result2).toBe(false);
      expect(mockRedis.set).toHaveBeenCalledTimes(2);
    });
  });
});
