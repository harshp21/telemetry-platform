import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildUsageServiceApp } from "../src/app";
import {
  USAGE_SERVICE_HEADERS,
  USAGE_SERVICE_RESPONSES,
  USAGE_SERVICE_ROUTES
} from "../src/constants";

const TENANT_ID_A = "11111111-1111-4111-8111-111111111111";
const TENANT_ID_B = "22222222-2222-4222-8222-222222222222";
const EVENT_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe(`POST ${USAGE_SERVICE_ROUTES.USAGE_EVENTS}`, () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildUsageServiceApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("accepts a valid event batch", async () => {
    const response = await app.inject({
      method: "POST",
      url: USAGE_SERVICE_ROUTES.USAGE_EVENTS,
      payload: {
        events: [
          {
            eventId: EVENT_ID_A,
            tenantId: TENANT_ID_A,
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
          }
        ]
      },
      headers: {
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_A
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: USAGE_SERVICE_RESPONSES.STATUS_ACCEPTED,
      acceptedCount: 1,
      version: USAGE_SERVICE_RESPONSES.VERSION_V1
    });
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
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR
    });
  });

  it("rejects tenant mismatch", async () => {
    const response = await app.inject({
      method: "POST",
      url: USAGE_SERVICE_ROUTES.USAGE_EVENTS,
      payload: {
        events: [
          {
            eventId: EVENT_ID_B,
            tenantId: TENANT_ID_B,
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
          }
        ]
      },
      headers: {
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_A
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_TENANT_MISMATCH
    });
  });

  it("normalizes unexpected internal errors", async () => {
    app.get("/boom", async () => {
      throw new Error("boom");
    });

    const response = await app.inject({
      method: "GET",
      url: "/boom"
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "boom"
    });
  });
});
