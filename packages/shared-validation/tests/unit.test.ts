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
  const baseEnvelope = {
    eventId: "f29f20c2-c0ba-41fc-8e84-b6e11318dbaa",
    tenantId: "0f1b6f57-8a59-4ee6-9293-e1e6df7bf444",
    occurredAt: "2026-01-01T00:00:00Z",
    receivedAt: "2026-01-01T00:00:01Z",
    source: "sdk-web",
    idempotencyKey: "idem_1",
    version: 1
  };

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

  it("accepts valid date range when from is earlier than to", () => {
    const parsed = dateRangeSchema.safeParse({
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z"
    });

    expect(parsed.success).toBe(true);
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
      ...baseEnvelope,
      eventType: "api.request",
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
      ...baseEnvelope,
      eventType: "billing.invoice_generated",
      source: "billing-service",
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
      ...baseEnvelope,
      eventType: "billing.invoice_generated",
      source: "billing-service",
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

  it("rejects batch payload over max event count", () => {
    const event = {
      ...baseEnvelope,
      eventType: "unknown.event",
      payload: { key: "value" }
    };

    const parsed = UsageEventsBatchSchema.safeParse({
      events: Array.from({ length: 101 }, () => event)
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects event payload over 10KB", () => {
    const parsed = UsageEventsBatchSchema.safeParse({
      events: [
        {
          ...baseEnvelope,
          eventType: "unknown.event",
          payload: {
            oversized: "x".repeat(11 * 1024)
          }
        }
      ]
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts unknown event type with generic JSON payload", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      eventType: "custom.event",
      payload: {
        nested: {
          count: 2,
          labels: ["a", "b"],
          nullable: null
        }
      }
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects known event type when routed through generic event branch", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      eventType: "api.request",
      payload: {
        nested: true
      }
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects non-finite numbers in generic JSON payload", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      eventType: "custom.event",
      payload: {
        value: Number.POSITIVE_INFINITY
      }
    });

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
