import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";
import type Redis from "ioredis";
import { DeduplicationService } from "../src/services/deduplication.service";
import { DEDUP_CONSTANTS, STREAM_CONSTANTS } from "../src/constants";

// Tenant ids are UUIDs at the boundary (Tenant.id is `String @default(uuid())`, and
// tenant-context.middleware now rejects anything else), so the fixtures are UUIDs too.
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

/** Raw, caller-supplied key components — never a pre-built Redis key. */
const RAW_KEY = "api.request:source1:1000";

/**
 * The namespaced key the service is contracted to write.
 * `dedupKeyLiteral` below pins the same format with no constant indirection,
 * so a wrong-but-consistent change to KEY_PREFIX cannot pass unnoticed.
 */
const namespacedKey = (tenantId: string, rawKey: string): string =>
  `${DEDUP_CONSTANTS.KEY_PREFIX}${tenantId}:${rawKey}`;

describe("DeduplicationService", () => {
  let mockRedis: { set: ReturnType<typeof vi.fn> };
  let mockLogger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
  let service: DeduplicationService;

  /**
   * Returns the Redis key used by the nth `set` call.
   * Throws when that call was never made, so a missing call fails loudly
   * instead of passing vacuously.
   */
  const keyOfSetCall = (index: number): string => {
    const call = mockRedis.set.mock.calls[index];
    if (!call) {
      throw new Error(
        `Expected a redis.set call at index ${index}, but only ${mockRedis.set.mock.calls.length} were made`
      );
    }
    return call[0] as string;
  };

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

  describe("key namespacing (S-1)", () => {
    it("should produce different Redis keys for the same client key from different tenants", async () => {
      // Arrange: the exact attack — two tenants submit an identical idempotencyKey
      const clientKey = "abc";
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce("OK");

      // Act
      const resultA = await service.isNew(TENANT_A, clientKey);
      const resultB = await service.isNew(TENANT_B, clientKey);

      // Assert: tenant B is NOT suppressed by tenant A's key
      expect(resultA).toBe(true);
      expect(resultB).toBe(true);

      const keyA = keyOfSetCall(0);
      const keyB = keyOfSetCall(1);
      expect(keyA).not.toBe(keyB);
      expect(keyA).toBe(namespacedKey(TENANT_A, clientKey));
      expect(keyB).toBe(namespacedKey(TENANT_B, clientKey));

      // Negative assertion: neither tenant's id appears in the other's key
      expect(keyA).not.toContain(TENANT_B);
      expect(keyB).not.toContain(TENANT_A);

      // Negative assertion: the raw client key is never a key on its own
      expect(keyA).not.toBe(clientKey);
      expect(keyB).not.toBe(clientKey);
    });

    it("should prefix every Redis key with DEDUP_CONSTANTS.KEY_PREFIX", async () => {
      // Arrange: a client-supplied key and a derived-fallback shaped key
      const rawKeys = ["abc", RAW_KEY, "", "dedup:already-prefixed"];
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue("OK");

      // Act
      for (const rawKey of rawKeys) {
        await service.isNew(TENANT_A, rawKey);
      }

      // Assert
      expect(mockRedis.set).toHaveBeenCalledTimes(rawKeys.length);
      rawKeys.forEach((_rawKey, index) => {
        expect(keyOfSetCall(index).startsWith(DEDUP_CONSTANTS.KEY_PREFIX)).toBe(
          true
        );
      });
    });

    it("should not let a client key collide with the platform stream keyspace", async () => {
      // Arrange: client sends the stream name itself as its idempotency key
      const hostileKey = STREAM_CONSTANTS.DEFAULT_STREAM_NAME;
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce("OK");

      // Act
      await service.isNew(TENANT_A, hostileKey);

      // Assert: the stream key is never the key written
      const writtenKey = keyOfSetCall(0);
      expect(writtenKey).not.toBe(STREAM_CONSTANTS.DEFAULT_STREAM_NAME);
      expect(writtenKey.startsWith(DEDUP_CONSTANTS.KEY_PREFIX)).toBe(true);
      expect(writtenKey).toBe(namespacedKey(TENANT_A, hostileKey));
    });

    it("should namespace a derived-fallback key and keep it tenant-scoped", async () => {
      // Arrange: the shape IngestionService derives when no client key is sent
      const derivedKey = "api.request:source-1:2026-01-01T00:00:00.000Z";
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce("OK");

      // Act
      await service.isNew(TENANT_A, derivedKey);
      await service.isNew(TENANT_B, derivedKey);

      // Assert
      expect(keyOfSetCall(0)).toBe(namespacedKey(TENANT_A, derivedKey));
      expect(keyOfSetCall(1)).toBe(namespacedKey(TENANT_B, derivedKey));
      expect(keyOfSetCall(0)).not.toBe(keyOfSetCall(1));
    });

    it("should build the key as <prefix><tenantId>:<rawKey> (format pinned literally)", async () => {
      // Arrange: no constant indirection — the literal wire format is asserted
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce("OK");

      // Act
      await service.isNew("11111111-1111-4111-8111-111111111111", "api.request:source1:1000");

      // Assert
      expect(keyOfSetCall(0)).toBe(
        "dedup:11111111-1111-4111-8111-111111111111:api.request:source1:1000"
      );
    });
  });

  describe("isNew", () => {
    it("should return true for a new event (first occurrence)", async () => {
      // Arrange
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce("OK");

      // Act
      const result = await service.isNew(TENANT_A, RAW_KEY);

      // Assert
      expect(result).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        namespacedKey(TENANT_A, RAW_KEY),
        "1",
        "EX",
        DEDUP_CONSTANTS.KEY_TTL_SECONDS,
        "NX"
      );
    });

    it("should return false for a duplicate event (same key, second call)", async () => {
      // Arrange
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      // Act
      const result = await service.isNew(TENANT_A, RAW_KEY);

      // Assert
      expect(result).toBe(false);
      expect(mockRedis.set).toHaveBeenCalledWith(
        namespacedKey(TENANT_A, RAW_KEY),
        "1",
        "EX",
        DEDUP_CONSTANTS.KEY_TTL_SECONDS,
        "NX"
      );
    });

    it("should return true for a different tenant (different key)", async () => {
      // Arrange
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce("OK");

      // Act
      const result1 = await service.isNew(TENANT_A, RAW_KEY);
      const result2 = await service.isNew(TENANT_B, RAW_KEY);

      // Assert
      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(keyOfSetCall(0)).toBe(namespacedKey(TENANT_A, RAW_KEY));
      expect(keyOfSetCall(1)).toBe(namespacedKey(TENANT_B, RAW_KEY));
    });

    it("should return true for a different event type (different key)", async () => {
      // Arrange
      const rawKey1 = "api.request:source1:1000";
      const rawKey2 = "billing.invoice:source1:1000";
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce("OK");

      // Act
      const result1 = await service.isNew(TENANT_A, rawKey1);
      const result2 = await service.isNew(TENANT_A, rawKey2);

      // Assert
      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(keyOfSetCall(0)).toBe(namespacedKey(TENANT_A, rawKey1));
      expect(keyOfSetCall(1)).toBe(namespacedKey(TENANT_A, rawKey2));
    });

    it("should return true for a different source ID (different key)", async () => {
      // Arrange
      const rawKey1 = "api.request:source1:1000";
      const rawKey2 = "api.request:source2:1000";
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce("OK");

      // Act
      const result1 = await service.isNew(TENANT_A, rawKey1);
      const result2 = await service.isNew(TENANT_A, rawKey2);

      // Assert
      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(keyOfSetCall(0)).toBe(namespacedKey(TENANT_A, rawKey1));
      expect(keyOfSetCall(1)).toBe(namespacedKey(TENANT_A, rawKey2));
    });

    it("should return true for a different timestamp (different key)", async () => {
      // Arrange
      const rawKey1 = "api.request:source1:1000";
      const rawKey2 = "api.request:source1:2000";
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK")
        .mockResolvedValueOnce("OK");

      // Act
      const result1 = await service.isNew(TENANT_A, rawKey1);
      const result2 = await service.isNew(TENANT_A, rawKey2);

      // Assert
      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(keyOfSetCall(0)).toBe(namespacedKey(TENANT_A, rawKey1));
      expect(keyOfSetCall(1)).toBe(namespacedKey(TENANT_A, rawKey2));
    });

    it("should return true on Redis connection error (ECONNREFUSED) - fail-open", async () => {
      // Arrange
      const error = new Error("ECONNREFUSED");
      (mockRedis.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

      // Act
      const result = await service.isNew(TENANT_A, RAW_KEY);

      // Assert
      expect(result).toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "ECONNREFUSED",
          key: namespacedKey(TENANT_A, RAW_KEY),
          service: "deduplication"
        }),
        expect.stringContaining("Redis deduplication check failed")
      );
    });

    it("should return true on Redis timeout - fail-open", async () => {
      // Arrange
      const error = new Error("Operation timeout");
      (mockRedis.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

      // Act
      const result = await service.isNew(TENANT_A, RAW_KEY);

      // Assert
      expect(result).toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Operation timeout",
          key: namespacedKey(TENANT_A, RAW_KEY),
          service: "deduplication"
        }),
        expect.stringContaining("Redis deduplication check failed")
      );
    });

    it("should use 24-hour TTL (86400 seconds) for Redis keys", async () => {
      // Arrange
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce("OK");

      // Act
      await service.isNew(TENANT_A, RAW_KEY);

      // Assert: the constant is applied, and the constant is exactly 24 hours
      expect(DEDUP_CONSTANTS.KEY_TTL_SECONDS).toBe(86400);
      expect(mockRedis.set).toHaveBeenCalledWith(
        namespacedKey(TENANT_A, RAW_KEY),
        "1",
        "EX",
        DEDUP_CONSTANTS.KEY_TTL_SECONDS,
        "NX"
      );
    });

    it("should handle concurrent calls to the same key with atomic Redis operation", async () => {
      // Arrange
      (mockRedis.set as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce("OK") // First call succeeds
        .mockResolvedValueOnce(null); // Second concurrent call gets duplicate

      // Act
      const result1 = await service.isNew(TENANT_A, RAW_KEY);
      const result2 = await service.isNew(TENANT_A, RAW_KEY);

      // Assert
      expect(result1).toBe(true);
      expect(result2).toBe(false);
      expect(mockRedis.set).toHaveBeenCalledTimes(2);
      expect(keyOfSetCall(0)).toBe(keyOfSetCall(1));
    });

    it("should treat an unexpected Redis response as a new event", async () => {
      // Arrange
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        "UNEXPECTED"
      );

      // Act
      const result = await service.isNew(TENANT_A, RAW_KEY);

      // Assert
      expect(result).toBe(true);
    });
  });
});
