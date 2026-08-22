import { describe, expect, it } from "vitest";
import {
  dateRangeSchema,
  eventTypeSchema,
  paginationSchema,
  TelemetryEventEnvelopeSchema,
  tenantIdSchema,
  UsageEventsBatchSchema
} from "../src/index";

describe("shared-validation schemas", () => {
  it("coerces pagination query strings", () => {
    const parsed = paginationSchema.parse({ page: "2", pageSize: "25" });

    expect(parsed).toEqual({ page: 2, pageSize: 25 });
  });

  it("rejects date ranges where from is not earlier than to", () => {
    const parsed = dateRangeSchema.safeParse({
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-01T00:00:00Z"
    });

    expect(parsed.success).toBe(false);
  });

  it("validates event type naming convention", () => {
    expect(eventTypeSchema.safeParse("billing.invoice_generated").success).toBe(true);
    expect(eventTypeSchema.safeParse("Bad Event Type").success).toBe(false);
  });

  it("validates tenant IDs as UUID", () => {
    expect(tenantIdSchema.safeParse("0f1b6f57-8a59-4ee6-9293-e1e6df7bf444").success).toBe(true);
    expect(tenantIdSchema.safeParse("tenant_1").success).toBe(false);
  });

  it("accepts a valid telemetry event envelope", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      eventId: "f29f20c2-c0ba-41fc-8e84-b6e11318dbaa",
      tenantId: "0f1b6f57-8a59-4ee6-9293-e1e6df7bf444",
      eventType: "api.request",
      occurredAt: "2026-01-01T00:00:00Z",
      receivedAt: "2026-01-01T00:00:01Z",
      source: "sdk-web",
      idempotencyKey: "idem_1",
      version: 1,
      payload: {
        quantity: 42,
        unit: "request",
        occurredAt: "2026-01-01T00:00:00Z"
      }
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts a valid billing.invoice_generated event envelope", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      eventId: "f29f20c2-c0ba-41fc-8e84-b6e11318dbaa",
      tenantId: "0f1b6f57-8a59-4ee6-9293-e1e6df7bf444",
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
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects known mapped event type with invalid payload shape", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      eventId: "f29f20c2-c0ba-41fc-8e84-b6e11318dbaa",
      tenantId: "0f1b6f57-8a59-4ee6-9293-e1e6df7bf444",
      eventType: "billing.invoice_generated",
      occurredAt: "2026-01-01T00:00:00Z",
      receivedAt: "2026-01-01T00:00:01Z",
      source: "billing-service",
      idempotencyKey: "idem_2",
      version: 1,
      payload: {
        invoiceId: "inv_123",
        amountCents: -1,
        currency: "usd",
        periodStart: "2026-01-01T00:00:00Z",
        periodEnd: "2026-02-01T00:00:00Z"
      }
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects batch payload without events", () => {
    const parsed = UsageEventsBatchSchema.safeParse({ events: [] });

    expect(parsed.success).toBe(false);
  });

  it("rejects event with missing required fields", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      eventId: "f29f20c2-c0ba-41fc-8e84-b6e11318dbaa",
      payload: {}
    });

    expect(parsed.success).toBe(false);
  });
});
