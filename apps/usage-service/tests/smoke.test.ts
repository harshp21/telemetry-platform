import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildUsageServiceApp } from "../src/app";
import {
  USAGE_SERVICE_NAME,
  USAGE_SERVICE_RESPONSES,
  USAGE_SERVICE_ROUTES
} from "../src/constants";

describe("usage-service health", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildUsageServiceApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns healthy status", async () => {
    const response = await app.inject({ method: "GET", url: USAGE_SERVICE_ROUTES.HEALTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: USAGE_SERVICE_RESPONSES.STATUS_OK,
      service: USAGE_SERVICE_NAME
    });
  });
});
