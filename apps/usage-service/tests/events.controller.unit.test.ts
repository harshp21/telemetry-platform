import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";
import type { FastifyRequest, FastifyReply } from "fastify";
import { EventsController as EventsControllerClass } from "../src/controllers/events.controller";
import type { IngestionService } from "../src/services/ingestion.service";
import { AppError } from "../src/errors";

describe("EventsController", () => {
	let mockIngestionService: Partial<IngestionService>;
	let mockLogger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
	let controller: EventsControllerClass;

	beforeEach(() => {
		mockIngestionService = {
			ingestEvents: vi.fn()
		};
		mockLogger = {
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
			info: vi.fn()
		};
		controller = new EventsControllerClass(
			mockIngestionService as IngestionService,
			mockLogger as unknown as Logger
		);
	});

	describe("handle", () => {
		it("should return 202 Accepted for single new event", async () => {
			// Arrange
			(
				mockIngestionService.ingestEvents as ReturnType<typeof vi.fn>
			).mockResolvedValueOnce({
				accepted: 1,
				duplicate: 0,
				rejected: 0
			});

			const tenantId = "00000000-0000-4000-8000-000000000001";
			const now = new Date().toISOString();
			const request = {
				tenantId,
				body: {
					events: [
						{
							eventType: "api.request",
							quantity: 1,
							unit: "request",
							occurredAt: now,
							metadata: {}
						}
					]
				}
			} as unknown as FastifyRequest;

			const response = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis()
			} as unknown as FastifyReply;

			// Act
			await controller.handle(request, response);

			// Assert
			expect(response.status).toHaveBeenCalledWith(202);
			expect(response.send).toHaveBeenCalledWith({
				data: { accepted: 1, duplicate: 0, rejected: 0 }
			});
			expect(mockIngestionService.ingestEvents).toHaveBeenCalledWith(
				tenantId,
				expect.any(Array)
			);
		});

		it("should return 202 with mixed counts for batch with new/duplicate/rejected events", async () => {
			// Arrange
			(
				mockIngestionService.ingestEvents as ReturnType<typeof vi.fn>
			).mockResolvedValueOnce({
				accepted: 5,
				duplicate: 3,
				rejected: 2
			});

			const tenantId = "tenant-1";
			const now = new Date().toISOString();
			const events = Array(10)
				.fill(null)
				.map((_, i) => ({
					eventType: "api.request",
					quantity: i % 2 === 0 ? 1 : 50,
					unit: "request",
					occurredAt: now,
					idempotencyKey: `key-${i}`
				}));

			const request = {
				tenantId,
				body: { events }
			} as unknown as FastifyRequest;

			const response = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis()
			} as unknown as FastifyReply;

			// Act
			await controller.handle(request, response);

			// Assert
			expect(response.status).toHaveBeenCalledWith(202);
			expect(response.send).toHaveBeenCalledWith({
				data: { accepted: 5, duplicate: 3, rejected: 2 }
			});
		});

		it("should return 400 VALIDATION_ERROR for malformed eventType", async () => {
			// Arrange
			const tenantId = "tenant-1";
			const request = {
				tenantId,
				body: {
					events: [
						{
							eventType: null as unknown as string,
							quantity: 1,
							unit: "request",
							occurredAt: new Date().toISOString(),
							idempotencyKey: "key-1"
						}
					]
				}
			} as unknown as FastifyRequest;

			const response = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis()
			} as unknown as FastifyReply;

			// Act
			await controller.handle(request, response);

			// Assert
			expect(response.status).toHaveBeenCalledWith(400);
			expect(response.send).toHaveBeenCalledWith(
				expect.objectContaining({ code: "VALIDATION_ERROR" })
			);
		});

		it("should return 400 BATCH_TOO_LARGE for >100 events", async () => {
			// Arrange
			const tenantId = "tenant-1";
			const now = new Date().toISOString();
			const largeEvents = Array(101)
				.fill(null)
				.map((_, i) => ({
					eventType: "api.request",
					quantity: 1,
					unit: "request",
					occurredAt: now,
					idempotencyKey: `key-${i}`
				}));

			const request = {
				tenantId,
				body: { events: largeEvents }
			} as unknown as FastifyRequest;

			const response = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis()
			} as unknown as FastifyReply;

			// Act
			await controller.handle(request, response);

			// Assert
			expect(response.status).toHaveBeenCalledWith(400);
			expect(response.send).toHaveBeenCalledWith(
				expect.objectContaining({ code: "BATCH_TOO_LARGE" })
			);
		});

		it("should return 400 VALIDATION_ERROR for empty events array", async () => {
			// Arrange
			const tenantId = "tenant-1";
			const request = {
				tenantId,
				body: { events: [] }
			} as unknown as FastifyRequest;

			const response = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis()
			} as unknown as FastifyReply;

			// Act
			await controller.handle(request, response);

			// Assert
			expect(response.status).toHaveBeenCalledWith(400);
			expect(response.send).toHaveBeenCalledWith(
				expect.objectContaining({ code: "VALIDATION_ERROR" })
			);
		});

		it("should return 400 for quantity out of range (0 or 101)", async () => {
			// Arrange
			const tenantId = "tenant-1";
			const now = new Date().toISOString();
			const request = {
				tenantId,
				body: {
					events: [
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
					]
				}
			} as unknown as FastifyRequest;

			const response = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis()
			} as unknown as FastifyReply;

			// Act
			await controller.handle(request, response);

			// Assert
			expect(response.status).toHaveBeenCalledWith(400);
			expect(response.send).toHaveBeenCalledWith(
				expect.objectContaining({ code: "VALIDATION_ERROR" })
			);
		});

		it("should return 400 FUTURE_CLOCK_SKEW for occurredAt > now + 5min", async () => {
			// Arrange
			const tenantId = "tenant-1";
			const futureTime = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10min
			const request = {
				tenantId,
				body: {
					events: [
						{
							eventType: "api.request",
							quantity: 1,
							unit: "request",
							occurredAt: futureTime,
							idempotencyKey: "key-1"
						}
					]
				}
			} as unknown as FastifyRequest;

			const response = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis()
			} as unknown as FastifyReply;

			// Act
			await controller.handle(request, response);

			// Assert
			expect(response.status).toHaveBeenCalledWith(400);
			expect(response.send).toHaveBeenCalledWith(
				expect.objectContaining({ code: "FUTURE_CLOCK_SKEW" })
			);
		});

		it("should return 400 FUTURE_CLOCK_SKEW for occurredAt < now - 5min", async () => {
			// Arrange
			const tenantId = "tenant-1";
			const pastTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
			const request = {
				tenantId,
				body: {
					events: [
						{
							eventType: "api.request",
							quantity: 1,
							unit: "request",
							occurredAt: pastTime,
							idempotencyKey: "key-1"
						}
					]
				}
			} as unknown as FastifyRequest;

			const response = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis()
			} as unknown as FastifyReply;

			// Act
			await controller.handle(request, response);

			// Assert
			expect(response.status).toHaveBeenCalledWith(400);
			expect(response.send).toHaveBeenCalledWith(
				expect.objectContaining({ code: "FUTURE_CLOCK_SKEW" })
			);
		});

		it("should return 500 when ingestion service throws error", async () => {
			// Arrange
			(
				mockIngestionService.ingestEvents as ReturnType<typeof vi.fn>
			).mockRejectedValueOnce(new Error("Redis connection failed"));

			const tenantId = "tenant-1";
			const now = new Date().toISOString();
			const request = {
				tenantId,
				body: {
					events: [
						{
							eventType: "api.request",
							quantity: 1,
							unit: "request",
							occurredAt: now,
							idempotencyKey: "key-1"
						}
					]
				}
			} as unknown as FastifyRequest;

			const response = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis()
			} as unknown as FastifyReply;

			// Act
			await controller.handle(request, response);

			// Assert
			expect(response.status).toHaveBeenCalledWith(500);
			expect(response.send).toHaveBeenCalledWith(
				expect.objectContaining({ code: "INTERNAL_ERROR" })
			);
			expect(mockLogger.error).toHaveBeenCalled();
		});

		it("should include error details in error response", async () => {
			// Arrange
			(
				mockIngestionService.ingestEvents as ReturnType<typeof vi.fn>
			).mockRejectedValueOnce(
				new AppError("VALIDATION_ERROR", 400, "Invalid quantity")
			);

			const tenantId = "tenant-1";
			const now = new Date().toISOString();
			const request = {
				tenantId,
				body: {
					events: [
						{
							eventType: "api.request",
							quantity: 50,
							unit: "request",
							occurredAt: now,
							idempotencyKey: "key-1"
						}
					]
				}
			} as unknown as FastifyRequest;

			const response = {
				status: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis()
			} as unknown as FastifyReply;

			// Act
			await controller.handle(request, response);

			// Assert
			expect(response.status).toHaveBeenCalledWith(400);
			expect(response.send).toHaveBeenCalledWith(
				expect.objectContaining({
					code: "VALIDATION_ERROR",
					message: "Invalid quantity"
				})
			);
		});
	});
});
