import { INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
import { z } from "zod";

export const packageName = "@telemetry/shared-validation";
export const packageDescription = "Shared Zod schemas and validators";

const MAX_EVENTS_PER_BATCH = 100;
const MAX_EVENT_SIZE_BYTES = 10 * 1024;

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

/**
 * The single declaration of `INTERNAL_API_SECRET` (S-8).
 *
 * gateway, usage-service, worker-service and billing-service all derive their env field from
 * **this object**, rather than each writing the rule out. They used to write it out, and had
 * drifted into two different rules -- which was not a tidiness problem. Both HTTP clients in this
 * stack strip leading and trailing SP/HTAB from a header value in transit, so with a
 * whitespace-padded secret deployed platform-wide the trimming services matched and the untrimmed
 * ones did not: measured end-to-end over a real socket against the real guard factories,
 * `gateway sends padded -> usage: 401` and `gateway sends padded -> billing: 200`. Ingestion down,
 * billing up, one stray space, and nothing in the logs naming it.
 *
 * **The order of the three checks is load-bearing.** `.trim().min().regex()` and
 * `.trim().regex().min()` agree on every accept/reject verdict and disagree on which message an
 * all-whitespace secret produces. This order was chosen because it preserves every verdict *and*
 * every message the previous declarations produced, adding a new message only for the genuinely
 * new rejection class -- verified across nine inputs against the shipped `.trim().min(...)`.
 * `packages/shared-validation/tests/unit.test.ts` pins the classes so a reordering that keeps the
 * verdicts still reddens.
 *
 * Note this is the *edge* case for whitespace only: `SECRET_PATTERN` includes U+0020, and it is
 * applied after the trim, so internal spaces stay legal. Internal **TAB** is a different matter and
 * this rule rejects it -- see `SECRET_PATTERN`'s own docblock in `@telemetry/shared-types` for the
 * measurement and for why it is excluded deliberately.
 *
 * **"Single declaration" means single declaration of the *rule*, not the only way a secret reaches
 * a guard.** Two entry points bypass this object entirely, and both are deliberate:
 * `buildBillingServiceApp` and `buildWorkerServiceApp` each accept an
 * `options.internalApiSecret` that is used verbatim, checked only for blankness
 * (`apps/billing-service/src/app.ts` and `apps/worker-service/src/app.ts`, the
 * `options.internalApiSecret ?? env.INTERNAL_API_SECRET` line and the `.trim()` guard below it).
 * **Eight** calls pass the option, not the two the smoke suites account for.
 * `grep -rn "buildBillingServiceApp({\|buildWorkerServiceApp({" --include=*.ts apps` returns
 * exactly those eight lines, and it is scoped to `apps`, so this docblock -- which lives under
 * `packages` -- is not itself one of them (the S-33 self-match trap). They are:
 * `apps/billing-service/tests/smoke.test.ts:18` and `apps/worker-service/tests/smoke.test.ts:18`,
 * both passing the 11-character `"test-secret"` which this fragment would refuse;
 * `apps/billing-service/tests/env.schema.unit.test.ts:490` and
 * `apps/worker-service/tests/env.schema.unit.test.ts:898`, which pass an override that builds;
 * and `apps/billing-service/tests/env.schema.unit.test.ts:472` and `:475` plus
 * `apps/worker-service/tests/env.schema.unit.test.ts:881` and `:884`, which pass `"   "` and `""`
 * to drive the blank guard and therefore throw.
 * **Four of the eight construct an app through the bypass**; the other four assert that it throws.
 * An earlier revision of this paragraph said "four callers" while citing a grep that returns
 * eight -- an undercount in the unsafe direction for a paragraph whose purpose is to widen the
 * reader's estimate of the bypass surface. Corrected at the Gate-6 rework (MEDIUM-1).
 * Every caller found is a test. Neither service's `src/index.ts` passes the option --
 * `apps/billing-service/src/index.ts:23` and `apps/worker-service/src/index.ts:52` both call with
 * no arguments -- and usage-service and gateway declare no such parameter at all
 * (`buildUsageServiceApp = ()` and `buildGatewayApp = ()`). That is the reach as measured on this
 * tree, not a claim that no future caller can be non-test. Stated here so that "one declaration"
 * is not read as "every path validates" (QA F-8).
 */
export const internalApiSecretSchema = z
	.string()
	.trim()
	.min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)
	.regex(INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN, INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN_MESSAGE);

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
	events: z
		.array(TelemetryEventEnvelopeSchema)
		.min(1)
		.max(MAX_EVENTS_PER_BATCH)
		.superRefine((events, context) => {
			events.forEach((event, index) => {
				const serialized = JSON.stringify(event);
				const byteLength = new TextEncoder().encode(serialized).length;

				if (byteLength > MAX_EVENT_SIZE_BYTES) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						path: [index],
						message: `event payload exceeds ${MAX_EVENT_SIZE_BYTES} bytes`
					});
				}
			});
		})
});

export type TelemetryEventEnvelope = z.infer<typeof TelemetryEventEnvelopeSchema>;
export type UsageEventsBatch = z.infer<typeof UsageEventsBatchSchema>;
