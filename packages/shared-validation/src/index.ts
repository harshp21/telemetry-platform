import { z } from "zod";

export const packageName = "@telemetry/shared-validation";
export const packageDescription = "Shared Zod schemas and validators";

type Brand<T, B extends string> = T & { readonly __brand: B };
type EventId = Brand<string, "EventId">;
type TenantId = Brand<string, "TenantId">;
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
	[key: string]: JsonValue;
}
type EventPayload = JsonObject;

export const uuidSchema = z.string().uuid();
export const iso8601Schema = z.string().datetime({ offset: true });
export const eventIdSchema = uuidSchema.transform((value) => value as EventId);

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
	(value) => value as TenantId
);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(jsonValueSchema),
		z.record(jsonValueSchema)
	])
);

export const telemetryPayloadSchema: z.ZodType<EventPayload> = z.record(jsonValueSchema);

export const eventTypeSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9_.]+$/);

const knownEventTypes = ["api.request", "billing.invoice_generated"] as const;

export const apiRequestPayloadSchema = z.object({
	quantity: z.number().finite(),
	unit: z.string().min(1),
	occurredAt: iso8601Schema,
	idempotencyKey: z.string().min(1).optional(),
	metadata: z.record(jsonValueSchema).optional()
});

export const billingInvoiceGeneratedPayloadSchema = z.object({
	invoiceId: z.string().min(1),
	amountCents: z.number().int().nonnegative(),
	currency: z.string().regex(/^[A-Z]{3}$/),
	periodStart: iso8601Schema,
	periodEnd: iso8601Schema,
	lineItems: z.array(z.record(jsonValueSchema)).optional()
});

const baseEnvelopeSchema = z.object({
	eventId: eventIdSchema,
	tenantId: tenantIdSchema,
	eventType: eventTypeSchema,
	occurredAt: iso8601Schema,
	receivedAt: iso8601Schema,
	source: z.string().min(1),
	idempotencyKey: z.string().min(1),
	version: z.number().int().positive()
});

const knownApiRequestEventSchema = baseEnvelopeSchema.extend({
	eventType: z.literal("api.request"),
	payload: apiRequestPayloadSchema
});

const knownBillingInvoiceGeneratedEventSchema = baseEnvelopeSchema.extend({
	eventType: z.literal("billing.invoice_generated"),
	payload: billingInvoiceGeneratedPayloadSchema
});

const genericEventSchema = baseEnvelopeSchema.extend({
	eventType: eventTypeSchema.refine(
		(value) => !knownEventTypes.includes(value as (typeof knownEventTypes)[number]),
		{ message: "eventType must be explicitly mapped to use strict payload schema" }
	),
	payload: telemetryPayloadSchema
});

export const TelemetryEventEnvelopeSchema = z.union([
	knownApiRequestEventSchema,
	knownBillingInvoiceGeneratedEventSchema,
	genericEventSchema
]);

export const UsageEventsBatchSchema = z.object({
	events: z.array(TelemetryEventEnvelopeSchema).min(1).max(1000)
});

export type TelemetryEventEnvelope = z.infer<typeof TelemetryEventEnvelopeSchema>;
export type UsageEventsBatch = z.infer<typeof UsageEventsBatchSchema>;
