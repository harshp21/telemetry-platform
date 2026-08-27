import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUsageServiceApp } from "../src/app";
import {
  USAGE_SERVICE_HEADERS,
  USAGE_SERVICE_RESPONSES,
  USAGE_SERVICE_ROUTES
} from "../src/constants";

const TENANT_ID_A = "11111111-1111-4111-8111-111111111111";

describe(`POST ${USAGE_SERVICE_ROUTES.USAGE_EVENTS}`, () => {
  let app: ReturnType<typeof buildUsageServiceApp>;

  beforeEach(() => {
    app = buildUsageServiceApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("accepts a valid event batch", async () => {
    vi.spyOn(app.container.deduplication, "isNew").mockResolvedValueOnce(true);
    vi.spyOn(app.container.streamPublisher, "publish").mockResolvedValueOnce(
      "1700000000000-0"
    );

    const now = new Date().toISOString();

    const response = await app.inject({
      method: "POST",
      url: USAGE_SERVICE_ROUTES.USAGE_EVENTS,
      payload: {
        events: [
          {
            eventType: "api.request",
            quantity: 10,
            unit: "request",
            occurredAt: now,
            idempotencyKey: "idem_1",
            metadata: { sourceId: "sdk-web" }
          }
        ]
      },
      headers: {
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_A
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      data: {
        accepted: 1,
        duplicate: 0,
        rejected: 0
      }
    });
    expect(app.container.deduplication.isNew).toHaveBeenCalledTimes(1);
    expect(app.container.streamPublisher.publish).toHaveBeenCalledTimes(1);
  });

  it("returns validation error for malformed payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: USAGE_SERVICE_ROUTES.USAGE_EVENTS,
      payload: {
        events: [
          {
            eventId: "evt_1"
          }
        ]
      },
      headers: {
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_A
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR
    });
  });

  it("returns 401 when tenant header is missing", async () => {
    const now = new Date().toISOString();

    const response = await app.inject({
      method: "POST",
      url: USAGE_SERVICE_ROUTES.USAGE_EVENTS,
      payload: {
        events: [
          {
            eventType: "api.request",
            quantity: 1,
            unit: "request",
            occurredAt: now,
            idempotencyKey: "idem-missing-tenant"
          }
        ]
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });
  });

  it("rejects batch larger than 100 events", async () => {
    const events = Array.from({ length: 101 }, (_, i) => ({
      eventType: "api.request",
      quantity: 1,
      unit: "request",
      occurredAt: "2026-01-01T00:00:00Z",
      idempotencyKey: `idem_${i}`
    }));

    const response = await app.inject({
      method: "POST",
      url: USAGE_SERVICE_ROUTES.USAGE_EVENTS,
      payload: { events },
      headers: {
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_A
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "BATCH_TOO_LARGE"
    });
  });

  it("normalizes unexpected internal errors", async () => {
    app.get("/boom", async () => {
      throw new Error("boom");
    });

    const response = await app.inject({
      method: "GET",
      url: "/boom",
      headers: {
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_A
      }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "boom"
    });
  });
});
