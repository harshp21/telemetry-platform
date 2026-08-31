import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";
import { IngestionService } from "../src/services/ingestion.service";
import type { DeduplicationService } from "../src/services/deduplication.service";
import type { StreamPublisher } from "../src/events/stream.publisher";
import type { EventPayload } from "../src/validators/events.validator";
import { DEDUP_CONSTANTS } from "../src/constants";

describe("IngestionService", () => {
	let mockDeduplication: Partial<DeduplicationService>;
	let mockStreamPublisher: Partial<StreamPublisher>;
	let mockLogger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
	let service: IngestionService;

	beforeEach(() => {
		mockDeduplication = {
			isNew: vi.fn()
		};
		mockStreamPublisher = {
			publish: vi.fn()
		};
		mockLogger = {
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
			info: vi.fn()
		};
		service = new IngestionService(
			mockDeduplication as DeduplicationService,
			mockStreamPublisher as StreamPublisher,
			mockLogger as unknown as Logger
		);
	});

	describe("ingestEvents", () => {
		it("should return { accepted: 1, duplicate: 0, rejected: 0 } for single new event", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				"stream-id-1"
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-1",
					metadata: { sourceId: "source-1" }
				}
			];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 1, duplicate: 0, rejected: 0 });
			expect(mockDeduplication.isNew).toHaveBeenCalled();
			expect(mockStreamPublisher.publish).toHaveBeenCalled();
		});

		it("should return { duplicate: 1 } when event already exists", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 1,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-1"
				}
			];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 0, duplicate: 1, rejected: 0 });
			expect(mockStreamPublisher.publish).not.toHaveBeenCalled();
		});

		it("should return { rejected: 1 } for quantity out of range (0)", async () => {
			// Arrange
			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 0,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-1"
				}
			];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 0, duplicate: 0, rejected: 1 });
			expect(mockDeduplication.isNew).not.toHaveBeenCalled();
			expect(mockStreamPublisher.publish).not.toHaveBeenCalled();
			expect(mockLogger.error).toHaveBeenCalled();
		});

		it("should return { rejected: 2 } for quantity out of range", async () => {
			// Arrange
			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 0,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-1"
				},
				{
					eventType: "api.request",
					quantity: 101,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-2"
				}
			];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 0, duplicate: 0, rejected: 2 });
			expect(mockDeduplication.isNew).not.toHaveBeenCalled();
		});

		it("should return { rejected: 1 } for occurredAt > now + 5min", async () => {
			// Arrange
			const tenantId = "11111111-1111-4111-8111-111111111111";
			const futureTime = new Date(Date.now() + 600_000).toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: futureTime,
					idempotencyKey: "key-1"
				}
			];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 0, duplicate: 0, rejected: 1 });
			expect(mockDeduplication.isNew).not.toHaveBeenCalled();
		});

		it("should return { rejected: 1 } for occurredAt < now - 5min", async () => {
			// Arrange
			const tenantId = "11111111-1111-4111-8111-111111111111";
			const pastTime = new Date(Date.now() - 600_000).toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: pastTime,
					idempotencyKey: "key-1"
				}
			];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 0, duplicate: 0, rejected: 1 });
			expect(mockDeduplication.isNew).not.toHaveBeenCalled();
			expect(mockStreamPublisher.publish).not.toHaveBeenCalled();
		});

		it("should accept event with occurredAt within ±5min tolerance", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				"stream-id-1"
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const withinTime = new Date(Date.now() + 299_000).toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: withinTime,
					idempotencyKey: "key-1"
				}
			];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 1, duplicate: 0, rejected: 0 });
			expect(mockDeduplication.isNew).toHaveBeenCalled();
		});

		it("should accept event with occurredAt within -5min tolerance", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				"stream-id-1"
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const withinPastTime = new Date(Date.now() - 299_000).toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: withinPastTime,
					idempotencyKey: "key-1"
				}
			];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 1, duplicate: 0, rejected: 0 });
			expect(mockDeduplication.isNew).toHaveBeenCalled();
		});

		it("should generate idempotency key when missing", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				"stream-id-1"
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					metadata: { sourceId: "source-1" }
				}
			];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 1, duplicate: 0, rejected: 0 });
			// The tenant is passed as its own argument; DeduplicationService owns
			// the namespace, so the derived key must NOT repeat the tenant segment.
			expect(mockDeduplication.isNew).toHaveBeenCalledWith(
				tenantId,
				expect.stringContaining("api.request:source-1:")
			);

			const derivedKey = (mockDeduplication.isNew as ReturnType<typeof vi.fn>)
				.mock.calls[0]![1] as string;
			expect(derivedKey).not.toContain(tenantId);
			expect(derivedKey).not.toContain(DEDUP_CONSTANTS.KEY_PREFIX);
		});

		it("should use provided idempotency key", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				"stream-id-1"
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const providedKey = "custom-key-1";
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: providedKey
				}
			];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 1, duplicate: 0, rejected: 0 });
			// Raw key plus tenant, never a pre-built Redis key.
			expect(mockDeduplication.isNew).toHaveBeenCalledWith(tenantId, providedKey);
		});

		it("should publish event with correct structure", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				"stream-id-1"
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "billing.invoice_generated",
					quantity: 10,
					unit: "invoice",
					occurredAt: now,
					idempotencyKey: "key-1",
					metadata: { invoiceId: "inv-123" }
				}
			];

			// Act
			await service.ingestEvents(tenantId, events);

			// Assert
			expect(mockStreamPublisher.publish).toHaveBeenCalledWith(
				expect.objectContaining({
					tenantId,
					eventType: "billing.invoice_generated",
					quantity: "10",
					unit: "invoice",
					occurredAt: now,
					idempotencyKey: "key-1",
					timestamp: expect.any(Number),
					eventId: expect.any(String),
					invoiceId: "inv-123"
				})
			);
		});

		it("should rethrow error from deduplication service", async () => {
			// Arrange
			const dedupError = new Error("Redis connection failed");
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockRejectedValueOnce(dedupError);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-1"
				}
			];

			// Act & Assert
			await expect(service.ingestEvents(tenantId, events)).rejects.toThrow(
				"Redis connection failed"
			);
			expect(mockLogger.error).toHaveBeenCalled();
		});

		it("should rethrow error from stream publisher", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

			const publishError = new Error("Stream write failed");
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				publishError
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-1"
				}
			];

			// Act & Assert
			await expect(service.ingestEvents(tenantId, events)).rejects.toThrow(
				"Stream write failed"
			);
			expect(mockLogger.error).toHaveBeenCalled();
		});

		it("should return correct counts for mixed batch", async () => {
			// Arrange
			const isNewResponses = [true, false, true, false, true];
			for (const response of isNewResponses) {
				(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
					response
				);
			}

			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValue(
				"stream-id"
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-1"
				},
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-2"
				},
				{
					eventType: "api.request",
					quantity: 10,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-3"
				},
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-4"
				},
				{
					eventType: "api.request",
					quantity: 7,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-5"
				}
			];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 3, duplicate: 2, rejected: 0 });
		});

		it("should return { accepted: 0, duplicate: 0, rejected: 0 } for empty batch", async () => {
			// Arrange
			const tenantId = "11111111-1111-4111-8111-111111111111";
			const events: EventPayload[] = [];

			// Act
			const result = await service.ingestEvents(tenantId, events);

			// Assert
			expect(result).toEqual({ accepted: 0, duplicate: 0, rejected: 0 });
			expect(mockDeduplication.isNew).not.toHaveBeenCalled();
			expect(mockStreamPublisher.publish).not.toHaveBeenCalled();
		});

		it("should log debug message for each duplicate event", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce(false)
				.mockResolvedValueOnce(false);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-1"
				},
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-2"
				}
			];

			// Act
			await service.ingestEvents(tenantId, events);

			// Assert
			expect(mockLogger.debug).toHaveBeenCalledTimes(2);
		});

		it("should flatten metadata into publish event", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				"stream-id-1"
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-1",
					metadata: {
						sourceId: "source-1",
						userId: "user-123",
						requestPath: "/api/users"
					}
				}
			];

			// Act
			await service.ingestEvents(tenantId, events);

			// Assert
			expect(mockStreamPublisher.publish).toHaveBeenCalledWith(
				expect.objectContaining({
					tenantId,
					eventType: "api.request",
					quantity: "5",
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-1",
					sourceId: "source-1",
					userId: "user-123",
					requestPath: "/api/users",
					timestamp: expect.any(Number),
					eventId: expect.any(String)
				})
			);
		});

		it("should not allow metadata to overwrite reserved stream fields", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				"stream-id-1"
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const now = new Date().toISOString();
			const events: EventPayload[] = [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: "key-1",
					metadata: {
						tenantId: "spoofed-tenant",
						eventType: "spoofed.event",
						eventId: "spoofed-event-id",
						idempotencyKey: "spoofed-key",
						timestamp: "0",
						custom: "ok"
					}
				}
			];

			// Act
			await service.ingestEvents(tenantId, events);

			// Assert
			expect(mockStreamPublisher.publish).toHaveBeenCalledWith(
				expect.objectContaining({
					tenantId,
					eventType: "api.request",
					idempotencyKey: "key-1",
					custom: "ok"
				})
			);

			const publishedEvent = (
				mockStreamPublisher.publish as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as Record<string, string | number | undefined>;
			expect(publishedEvent.tenantId).toBe(tenantId);
			expect(publishedEvent.eventType).toBe("api.request");
			expect(publishedEvent.idempotencyKey).toBe("key-1");
			expect(publishedEvent.eventId).not.toBe("spoofed-event-id");
			expect(publishedEvent.timestamp).not.toBe("0");
		});
	});

	describe("dedup key handoff (S-1)", () => {
		it("should hand the same client key to different tenants as distinct (tenantId, key) pairs", async () => {
			// Arrange: the attack shape — two tenants submit an identical idempotencyKey
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValue(true);
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValue(
				"stream-id"
			);

			const clientKey = "abc";
			const now = new Date().toISOString();
			const event: EventPayload = {
				eventType: "api.request",
				quantity: 1,
				unit: "request",
				occurredAt: now,
				idempotencyKey: clientKey
			};

			// Act
			await service.ingestEvents("tenant-a", [event]);
			await service.ingestEvents("tenant-b", [event]);

			// Assert: the tenant travels separately, so the two calls cannot alias
			const calls = (mockDeduplication.isNew as ReturnType<typeof vi.fn>).mock
				.calls;
			expect(calls).toHaveLength(2);
			expect(calls[0]).toEqual(["tenant-a", clientKey]);
			expect(calls[1]).toEqual(["tenant-b", clientKey]);
			expect(calls[0]![0]).not.toBe(calls[1]![0]);
		});

		it("should not pre-namespace the client key before calling the deduplication service", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				"stream-id-1"
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const clientKey = "custom-key-1";
			const now = new Date().toISOString();

			// Act
			await service.ingestEvents(tenantId, [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: clientKey
				}
			]);

			// Assert: IngestionService passes components; it does not build Redis keys
			const passedKey = (mockDeduplication.isNew as ReturnType<typeof vi.fn>).mock
				.calls[0]![1] as string;
			expect(passedKey).toBe(clientKey);
			expect(passedKey).not.toContain(DEDUP_CONSTANTS.KEY_PREFIX);
			expect(passedKey).not.toContain(tenantId);
		});

		it("should publish the raw idempotency key, not the Redis key shape", async () => {
			// Arrange
			(mockDeduplication.isNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(mockStreamPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				"stream-id-1"
			);

			const tenantId = "11111111-1111-4111-8111-111111111111";
			const clientKey = "custom-key-1";
			const now = new Date().toISOString();

			// Act
			await service.ingestEvents(tenantId, [
				{
					eventType: "api.request",
					quantity: 5,
					unit: "request",
					occurredAt: now,
					idempotencyKey: clientKey
				}
			]);

			// Assert: Redis storage layout must not leak into the stream contract
			const publishedEvent = (
				mockStreamPublisher.publish as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as Record<string, string | number | undefined>;
			expect(publishedEvent.idempotencyKey).toBe(clientKey);
			expect(String(publishedEvent.idempotencyKey)).not.toContain(
				DEDUP_CONSTANTS.KEY_PREFIX
			);
			expect(publishedEvent.tenantId).toBe(tenantId);
		});
	});
});

