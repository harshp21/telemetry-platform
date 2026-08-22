import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildAnalyticsServiceApp } from "../src/app";
import {
  ANALYTICS_RESPONSES,
  ANALYTICS_ROUTES,
  ANALYTICS_SERVICE_NAME
} from "../src/constants";

describe("analytics-service", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildAnalyticsServiceApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns healthy status", async () => {
    const response = await app.inject({ method: "GET", url: ANALYTICS_ROUTES.HEALTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: ANALYTICS_RESPONSES.STATUS_OK,
      service: ANALYTICS_SERVICE_NAME
    });
  });
});
