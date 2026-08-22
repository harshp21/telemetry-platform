import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildBillingServiceApp } from "../src/app";
import {
  BILLING_HEADERS,
  BILLING_RESPONSES,
  BILLING_ROUTES,
  BILLING_SERVICE_NAME
} from "../src/constants";

describe("billing-service", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildBillingServiceApp({ internalApiSecret: "test-secret" });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns healthy status", async () => {
    const response = await app.inject({ method: "GET", url: BILLING_ROUTES.HEALTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: BILLING_RESPONSES.STATUS_OK,
      service: BILLING_SERVICE_NAME
    });
  });

  it("rejects internal endpoint without secret", async () => {
    const response = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
  });

  it("rejects internal endpoint with wrong secret", async () => {
    const response = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: {
        [BILLING_HEADERS.INTERNAL_SECRET]: "wrong-secret"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
  });

  it("accepts internal endpoint with correct secret", async () => {
    const response = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: {
        [BILLING_HEADERS.INTERNAL_SECRET]: "test-secret"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: BILLING_RESPONSES.STATUS_ACCEPTED,
      workflow: BILLING_RESPONSES.WORKFLOW_BILLING_GENERATION
    });
  });
});
