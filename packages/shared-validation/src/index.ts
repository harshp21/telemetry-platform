import { z } from "zod";

export const packageName = "@telemetry/shared-validation";
export const packageDescription = "Shared Zod schemas and validators";

export const uuidSchema = z.string().uuid();
export const iso8601Schema = z.string().datetime({ offset: true });

export const paginationSchema = z.object({
	page: z.coerce.number().int().min(1),
	pageSize: z.coerce.number().int().min(1).max(100)
});

export const dateRangeSchema = z
	.object({
		from: iso8601Schema,
		to: iso8601Schema
	})
	.refine(({ from, to }) => new Date(from).getTime() < new Date(to).getTime(), {
		message: "from must be earlier than to",
		path: ["to"]
	});

export const tenantIdSchema = uuidSchema.transform(
	(value) => value as string & { readonly __brand: "TenantId" }
);

export const eventTypeSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9_.]+$/);

export const TelemetryEventEnvelopeSchema = z.object({
	eventId: uuidSchema,
	tenantId: tenantIdSchema,
	eventType: eventTypeSchema,
	occurredAt: iso8601Schema,
	receivedAt: iso8601Schema,
	source: z.string().min(1),
	idempotencyKey: z.string().min(1),
	version: z.number().int().positive(),
	payload: z.record(z.unknown())
});

export const UsageEventsBatchSchema = z.object({
	events: z.array(TelemetryEventEnvelopeSchema).min(1).max(1000)
});

export type TelemetryEventEnvelope = z.infer<typeof TelemetryEventEnvelopeSchema>;
export type UsageEventsBatch = z.infer<typeof UsageEventsBatchSchema>;
