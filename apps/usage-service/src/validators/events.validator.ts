import { z } from "zod";
import { iso8601Schema } from "@telemetry/shared-validation";

export const INGESTION_CONSTANTS = {
	BATCH_SIZE_MIN: 1,
	BATCH_SIZE_MAX: 100,
	QUANTITY_MIN: 1,
	QUANTITY_MAX: 100,
	CLOCK_SKEW_TOLERANCE_SECONDS: 5 * 60, // 5 minutes
	// A client-supplied idempotency key becomes part of a Redis key held for the dedup
	// TTL (24h), so it must be bounded. 200 comfortably fits UUID (36), ULID (26) and
	// SHA-256 hex (64) formats plus a source prefix.
	IDEMPOTENCY_KEY_MIN_LENGTH: 1,
	IDEMPOTENCY_KEY_MAX_LENGTH: 200,
	// Placeholder used when deriving a fallback key for an event with no sourceId.
	UNKNOWN_SOURCE_ID: "unknown",
	ERROR_CODES: {
		VALIDATION_ERROR: "VALIDATION_ERROR",
		BATCH_TOO_LARGE: "BATCH_TOO_LARGE",
		FUTURE_CLOCK_SKEW: "FUTURE_CLOCK_SKEW",
		INTERNAL_ERROR: "INTERNAL_ERROR"
	}
} as const;

// Client-side event payload schema (what clients send, not what server uses internally)
// Server generates: eventId, tenantId, receivedAt, source, version, idempotencyKey (if missing)
export const eventPayloadSchema = z.object({
	eventType: z.string().min(1),
	quantity: z.number().int().min(INGESTION_CONSTANTS.QUANTITY_MIN).max(INGESTION_CONSTANTS.QUANTITY_MAX),
	unit: z.string().min(1),
	occurredAt: iso8601Schema,
	idempotencyKey: z
		.string()
		.min(INGESTION_CONSTANTS.IDEMPOTENCY_KEY_MIN_LENGTH)
		.max(INGESTION_CONSTANTS.IDEMPOTENCY_KEY_MAX_LENGTH)
		.optional(),
	metadata: z.record(z.any()).optional()
});

export type EventPayload = z.infer<typeof eventPayloadSchema>;

// Validate incoming event batch from HTTP (client-sent events)
export const ingestRequestSchema = z.object({
	events: z
		.array(eventPayloadSchema)
		.min(INGESTION_CONSTANTS.BATCH_SIZE_MIN)
		.max(INGESTION_CONSTANTS.BATCH_SIZE_MAX)
});

export type IngestRequest = z.infer<typeof ingestRequestSchema>;
