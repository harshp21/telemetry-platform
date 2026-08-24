import { describe, expect, it } from "vitest";
import {
  type BillingInvoiceGeneratedPayload,
  type CanonicalEventPayload,
  type EventId,
  type EventPayload,
  type TypedTelemetryEvent,
  type TypedUsageEventsBatch,
  type TelemetryEventEnvelope,
  AppError,
  ERROR_RESPONSES,
  INTERNAL_AUTH_HEADERS,
  INTERNAL_AUTH_RESPONSES,
  type TenantId
} from "../src";

describe("shared-types", () => {
  it("exposes shared internal auth constants", () => {
    expect(INTERNAL_AUTH_HEADERS.INTERNAL_SECRET).toBe("x-internal-secret");
    expect(INTERNAL_AUTH_RESPONSES.CODE_UNAUTHORIZED).toBe("UNAUTHORIZED");
  });

  it("models application errors with stable code and status", () => {
    const error = new AppError(ERROR_RESPONSES.CODE_CONFLICT, 409, "duplicate record");

    expect(error.code).toBe(ERROR_RESPONSES.CODE_CONFLICT);
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe("duplicate record");
  });

  it("enforces branded IDs through explicit cast", () => {
    // @ts-expect-error raw string must not be assignable without explicit cast
    const invalidTenantId: TenantId = "tenant_1";

    const tenantId = "tenant_1" as TenantId;
    void invalidTenantId;
    expect(tenantId).toBe("tenant_1");
  });

  it("supports flexible event payload contract", () => {
    const payload: EventPayload = {
      quantity: 1,
      unit: "request",
      nested: {
        source: "sdk-web"
      },
      metadata: { source: "sdk-web" }
    };

    expect(payload).toMatchObject({
      quantity: 1,
      unit: "request"
    });
  });

  it("supports canonical typed payload contract", () => {
    const canonicalPayload: CanonicalEventPayload = {
      quantity: 3,
      unit: "request",
      occurredAt: "2026-01-01T00:00:00Z",
      metadata: {
        source: "sdk-web"
      }
    };

    const envelope: TelemetryEventEnvelope<CanonicalEventPayload> = {
      eventId: "f29f20c2-c0ba-41fc-8e84-b6e11318dbaa" as EventId,
      tenantId: "0f1b6f57-8a59-4ee6-9293-e1e6df7bf444" as TenantId,
      eventType: "api.request",
      occurredAt: "2026-01-01T00:00:00Z",
      receivedAt: "2026-01-01T00:00:01Z",
      source: "sdk-web",
      idempotencyKey: "idem_1",
      version: 1,
      payload: canonicalPayload
    };

    expect(envelope.payload.quantity).toBe(3);
    expect(envelope.payload.unit).toBe("request");
  });

  it("maps known event types to strict payload attributes", () => {
    const typedEvent: TypedTelemetryEvent<"api.request"> = {
      eventId: "f29f20c2-c0ba-41fc-8e84-b6e11318dbaa" as EventId,
      tenantId: "0f1b6f57-8a59-4ee6-9293-e1e6df7bf444" as TenantId,
      eventType: "api.request",
      occurredAt: "2026-01-01T00:00:00Z",
      receivedAt: "2026-01-01T00:00:01Z",
      source: "sdk-web",
      idempotencyKey: "idem_1",
      version: 1,
      payload: {
        quantity: 10,
        unit: "request",
        occurredAt: "2026-01-01T00:00:00Z"
      }
    };

    const batch: TypedUsageEventsBatch<"api.request"> = {
      events: [typedEvent]
    };

    expect(batch.events[0]?.payload.quantity).toBe(10);
    expect(batch.events[0]?.eventType).toBe("api.request");
  });

  it("maps billing.invoice_generated to its strict payload", () => {
    const typedEvent: TypedTelemetryEvent<"billing.invoice_generated"> = {
      eventId: "f29f20c2-c0ba-41fc-8e84-b6e11318dbaa" as EventId,
      tenantId: "0f1b6f57-8a59-4ee6-9293-e1e6df7bf444" as TenantId,
      eventType: "billing.invoice_generated",
      occurredAt: "2026-01-01T00:00:00Z",
      receivedAt: "2026-01-01T00:00:01Z",
      source: "billing-service",
      idempotencyKey: "idem_2",
      version: 1,
      payload: {
        invoiceId: "inv_123",
        amountCents: 1500,
        currency: "USD",
        periodStart: "2026-01-01T00:00:00Z",
        periodEnd: "2026-02-01T00:00:00Z"
      }
    };

    const payload: BillingInvoiceGeneratedPayload = typedEvent.payload;

    expect(payload.amountCents).toBe(1500);
    expect(payload.currency).toBe("USD");
  });
});
