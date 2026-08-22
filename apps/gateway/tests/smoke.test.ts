import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildGatewayApp } from "../src/app";
import {
  GATEWAY_RESPONSES,
  GATEWAY_ROUTES,
  GATEWAY_SERVICE_NAME
} from "../src/constants";

describe("gateway", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildGatewayApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns healthy status", async () => {
    const response = await app.inject({ method: "GET", url: GATEWAY_ROUTES.HEALTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: GATEWAY_RESPONSES.STATUS_OK,
      service: GATEWAY_SERVICE_NAME
    });
  });

  it("returns versioned health status for v1 route", async () => {
    const response = await app.inject({ method: "GET", url: GATEWAY_ROUTES.V1_HEALTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: GATEWAY_RESPONSES.STATUS_OK,
      service: GATEWAY_SERVICE_NAME,
      version: GATEWAY_RESPONSES.VERSION_V1
    });
  });
});
