export const packageName = "@telemetry/shared-types";
export const packageDescription = "Shared TypeScript types and contracts";

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type TenantId = Brand<string, "TenantId">;
export type UserId = Brand<string, "UserId">;
export type EventId = Brand<string, "EventId">;
export type InvoiceId = Brand<string, "InvoiceId">;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
	[key: string]: JsonValue;
}

export type EventPayload = JsonObject;

export type CanonicalEventPayload = JsonObject & {
	quantity: number;
	unit: string;
	occurredAt: string;
	idempotencyKey?: string;
	metadata?: JsonObject;
};

export type BillingInvoiceGeneratedPayload = JsonObject & {
	invoiceId: string;
	amountCents: number;
	currency: string;
	periodStart: string;
	periodEnd: string;
	lineItems?: JsonObject[];
};

export interface EventPayloadByType {
	"api.request": CanonicalEventPayload;
	"billing.invoice_generated": BillingInvoiceGeneratedPayload;
}

export type KnownEventType = keyof EventPayloadByType;

export type PayloadForEventType<TEventType extends string> =
	TEventType extends keyof EventPayloadByType ? EventPayloadByType[TEventType] : EventPayload;

export interface ApiResponse<T> {
	data: T;
	meta?: JsonObject;
}

export interface PaginatedResult<T> {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
}

export interface PaginationMeta {
	page: number;
	pageSize: number;
	total: number;
}

export interface PaginationParams {
	page: number;
	pageSize: number;
}

export interface DateRangeParams {
	from: string;
	to: string;
}

export const INTERNAL_AUTH_HEADERS = {
	INTERNAL_SECRET: "x-internal-secret"
} as const;

/**
 * The header the gateway re-injects from verified JWT context. For the services that receive
 * their tenant *from the gateway* -- usage-service and billing-service today -- it is the
 * source of tenant identity, and a tenant id from anywhere else in the request is forbidden
 * (`.claude/rules/tenant-isolation.md` § *Forbidden*).
 *
 * **Not every service reads it.** auth-service is the deliberate exception: it *discovers* the
 * tenant from a credential rather than being told it, through the `SECURITY DEFINER` resolvers
 * of `prisma/migrations/v1_5_auth_tenant_resolvers`, and reads no tenant header at all --
 * `grep -rn "x-tenant-id" apps/auth-service/src --include=*.ts` returns nothing. See
 * `.claude/rules/tenant-isolation.md` § *auth-service's pre-tenant path*. An earlier revision
 * of this docblock called this "the only source of tenant identity a downstream service may
 * read", which is a universal auth-service refutes -- and this is a shared package that service
 * imports (review LOW-2).
 *
 * Promoted here rather than copied a third time: it was written as a literal in
 * `apps/gateway/src/constants.ts` and `apps/usage-service/src/constants.ts`, and
 * billing-service's tenant-context middleware (T-046) would have been the third copy.
 * `.claude/rules/constants.md` asks for promotion before that copy. The two existing literals
 * are left alone on purpose -- rewiring them is a two-service edit with no behaviour change,
 * and it does not belong inside a billing-service task.
 *
 * Lower-case because Node lower-cases every inbound header name, so this is the key
 * `request.headers` is actually indexed by, not the wire spelling.
 */
export const TENANT_CONTEXT_HEADERS = {
	TENANT_ID: "x-tenant-id"
} as const;

export const INTERNAL_AUTH_RESPONSES = {
	CODE_UNAUTHORIZED: "UNAUTHORIZED",
	// Deliberately identical for a missing and for a wrong secret: telling the two apart
	// tells an unauthenticated caller whether it even guessed the header name.
	MESSAGE_UNAUTHORIZED: "A valid X-Internal-Secret header is required"
} as const;

/**
 * Shared constraints for service-to-service authentication.
 *
 * `SECRET_MIN_LENGTH` is the minimum accepted length of `INTERNAL_API_SECRET`. It lives here
 * because more than one service's env schema enforces it -- see `.claude/rules/constants.md`
 * ("before adding a third copy of a literal, promote it").
 */
export const INTERNAL_AUTH_CONSTANTS = {
	SECRET_MIN_LENGTH: 32
} as const;

/**
 * The Redis Stream that carries usage events between services.
 *
 * One definition, three consumers of it: usage-service's producer default
 * (`apps/usage-service/src/config/env.ts`), its `STREAM_CONSTANTS.DEFAULT_STREAM_NAME`
 * (`apps/usage-service/src/constants.ts`), and worker-service's consumer default
 * (`apps/worker-service/src/constants.ts`). It lives here for the same reason
 * `INTERNAL_AUTH_CONSTANTS` does -- more than one service's env schema resolves it, and
 * `.claude/rules/constants.md` asks for promotion before the third copy.
 *
 * Producer and consumer disagreeing on this value is silent: `XADD` succeeds, `XREADGROUP`
 * blocks forever on an empty key, and both services report healthy. Deriving all three sites
 * from one constant means a rename here fails shared-types', usage-service's and
 * worker-service's suites together. It does **not** make divergence impossible: re-pinning any
 * one site to a literal still diverges silently, caught by the constants gate and an
 * unused-import lint error rather than by a test. An operator can also diverge them at runtime
 * by setting `REDIS_STREAM_NAME` on one service only.
 */
export const EVENT_STREAM_CONSTANTS = {
	USAGE_EVENTS_STREAM: "telemetry:events"
} as const;

export const ERROR_RESPONSES = {
	CODE_VALIDATION_ERROR: "VALIDATION_ERROR",
	CODE_CONFLICT: "CONFLICT",
	CODE_INTERNAL_ERROR: "INTERNAL_ERROR",
	CODE_FORBIDDEN: "FORBIDDEN"
} as const;

export class AppError extends Error {
	public readonly code: string;
	public readonly statusCode: number;

	constructor(code: string, statusCode: number, message: string) {
		super(message);
		this.name = "AppError";
		this.code = code;
		this.statusCode = statusCode;
	}
}

export class ForbiddenError extends AppError {
	constructor(message = "Access denied") {
		super(ERROR_RESPONSES.CODE_FORBIDDEN, 403, message);
	}
}

export interface TelemetryEventEnvelope<TPayload extends JsonObject = EventPayload> {
	eventId: EventId;
	tenantId: TenantId;
	eventType: string;
	occurredAt: string;
	receivedAt: string;
	source: string;
	idempotencyKey: string;
	version: number;
	payload: TPayload;
}

export type TypedTelemetryEvent<TEventType extends string> = TelemetryEventEnvelope<
	PayloadForEventType<TEventType>
> & {
	eventType: TEventType;
};

export interface UsageEventsBatch<TPayload extends JsonObject = EventPayload> {
	events: TelemetryEventEnvelope<TPayload>[];
}

export interface TypedUsageEventsBatch<TEventType extends string> {
	events: TypedTelemetryEvent<TEventType>[];
}
