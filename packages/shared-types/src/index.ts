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

export const INTERNAL_AUTH_RESPONSES = {
	CODE_UNAUTHORIZED: "UNAUTHORIZED"
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
