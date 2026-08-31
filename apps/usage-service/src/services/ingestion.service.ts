import type { Logger } from "pino";
import type { DeduplicationService } from "./deduplication.service";
import type { StreamPublisher } from "../events/stream.publisher";
import type { StreamEvent } from "../events/stream.publisher";
import type { EventPayload } from "../validators/events.validator";
import { INGESTION_CONSTANTS } from "../validators/events.validator";
import { randomUUID } from "crypto";

export interface IngestionResult {
	accepted: number;
	duplicate: number;
	rejected: number;
}

const RESERVED_STREAM_FIELDS = new Set([
	"eventId",
	"tenantId",
	"eventType",
	"quantity",
	"unit",
	"occurredAt",
	"idempotencyKey",
	"timestamp"
]);

/**
 * IngestionService: Orchestrates event ingestion with validation, deduplication, and streaming.
 *
 * Per-event flow:
 * 1. Validate payload structure (eventType, quantity, unit, occurredAt required)
 * 2. Validate quantity (1-100)
 * 3. Validate timestamp (within ±5min of server clock)
 * 4. Generate or use provided idempotency key
 * 5. Check deduplication (DeduplicationService)
 * 6. Publish to stream (StreamPublisher) if new
 * 7. Accumulate counts (accepted, duplicate, rejected)
 *
 * Error handling: Validation errors increment rejected counter; service errors are rethrown.
 */
export class IngestionService {
	constructor(
		private readonly deduplication: DeduplicationService,
		private readonly streamPublisher: StreamPublisher,
		private readonly logger: Logger
	) {}

	/**
	 * Ingest a batch of events with validation, deduplication, and streaming.
	 *
	 * @param tenantId - The tenant who submitted the events
	 * @param events - Array of client-sent event payloads
	 * @returns { accepted, duplicate, rejected } counts
	 * @throws Error if deduplication or stream publishing fails (fail-closed)
	 */
	async ingestEvents(
		tenantId: string,
		events: EventPayload[]
	): Promise<IngestionResult> {
		const result: IngestionResult = {
			accepted: 0,
			duplicate: 0,
			rejected: 0
		};

		// Empty batch is valid
		if (events.length === 0) {
			return result;
		}

		const nowSeconds = Math.floor(Date.now() / 1000);

		for (const event of events) {
			try {
				// Step 1: Validate quantity (1-100)
				if (
					event.quantity < INGESTION_CONSTANTS.QUANTITY_MIN ||
					event.quantity > INGESTION_CONSTANTS.QUANTITY_MAX
				) {
					this.logger.error(
						{ quantity: event.quantity, tenantId, eventType: event.eventType },
						"Event quantity out of range"
					);
					result.rejected++;
					continue;
				}

				// Step 2: Validate timestamp (within ±5min of server clock)
				const eventSeconds = Math.floor(
					new Date(event.occurredAt).getTime() / 1000
				);
				const delta = eventSeconds - nowSeconds;
				const skew = Math.abs(delta);
				if (
					skew > INGESTION_CONSTANTS.CLOCK_SKEW_TOLERANCE_SECONDS
				) {
					this.logger.error(
						{
							occurredAt: event.occurredAt,
							delta,
							skew,
							tenantId,
							eventType: event.eventType
						},
						"Event timestamp outside tolerance window"
					);
					result.rejected++;
					continue;
				}

				// Step 3: Use the provided idempotency key, or derive one from the event.
				// This is the RAW key only. DeduplicationService owns the Redis keyspace
				// and adds the `dedup:` prefix and the tenant namespace itself, so the
				// tenant is deliberately absent from the derived shape here.
				const idempotencyKey =
					event.idempotencyKey ||
					`${event.eventType}:${event.metadata?.sourceId || INGESTION_CONSTANTS.UNKNOWN_SOURCE_ID}:${event.occurredAt}`;

				// Step 4: Check deduplication, scoped to this tenant
				const isNew = await this.deduplication.isNew(tenantId, idempotencyKey);
				if (!isNew) {
					result.duplicate++;
					this.logger.debug(
						{
							idempotencyKey,
							eventType: event.eventType,
							tenantId
						},
						"Event is duplicate"
					);
					continue;
				}

				// Step 5: Publish to stream with generated eventId
				const eventId = randomUUID();
				const timestamp = Date.now();
				const publishEvent: StreamEvent = {
					eventId,
					tenantId,
					eventType: event.eventType,
					quantity: String(event.quantity),
					unit: event.unit,
					occurredAt: event.occurredAt,
					idempotencyKey,
					timestamp
				};
				
				// Flatten metadata into the publish event
				if (event.metadata) {
					for (const [key, value] of Object.entries(event.metadata)) {
						if (
							value !== undefined &&
							value !== null &&
							!RESERVED_STREAM_FIELDS.has(key)
						) {
							publishEvent[key] = String(value);
						}
					}
				}

				await this.streamPublisher.publish(publishEvent);

				// Step 6: Count as accepted
				result.accepted++;
				this.logger.debug(
					{
						eventId,
						eventType: event.eventType,
						quantity: event.quantity,
						tenantId
					},
					"Event accepted and published"
				);
			} catch (error) {
				// Fail-closed: service errors are rethrown
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.logger.error(
					{ error: errorMsg, eventType: event.eventType, tenantId },
					"Error processing event"
				);
				throw error;
			}
		}

		return result;
	}
}
