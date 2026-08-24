import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildGatewayApp } from "../src/app";
import {
  GATEWAY_PROXY_PREFIXES,
  GATEWAY_RESPONSES,
  GATEWAY_ROUTES,
  GATEWAY_SERVICE_NAME
} from "../src/constants";

const PROXY_ENV_KEYS = [
  "AUTH_SERVICE_URL",
  "USAGE_SERVICE_URL",
  "BILLING_SERVICE_URL",
  "ANALYTICS_SERVICE_URL"
] as const;

const TEST_PROXY_ENV: Record<(typeof PROXY_ENV_KEYS)[number], string> = {
  AUTH_SERVICE_URL: "http://127.0.0.1:4101",
  USAGE_SERVICE_URL: "http://127.0.0.1:4102",
  BILLING_SERVICE_URL: "http://127.0.0.1:4103",
  ANALYTICS_SERVICE_URL: "http://127.0.0.1:4104"
};

describe("gateway", () => {
  let app: FastifyInstance;
  let previousProxyEnv: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    previousProxyEnv = {};

    for (const key of PROXY_ENV_KEYS) {
      previousProxyEnv[key] = process.env[key];
      process.env[key] = TEST_PROXY_ENV[key];
    }

    app = buildGatewayApp();
  });

  afterEach(async () => {
    await app.close();

    for (const key of PROXY_ENV_KEYS) {
      const previousValue = previousProxyEnv[key];

      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
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

  it("registers proxy routes for all upstream service prefixes", async () => {
    await app.ready();

    const responses = await Promise.all([
      app.inject({ method: "GET", url: `${GATEWAY_PROXY_PREFIXES.AUTH}/_probe` }),
      app.inject({ method: "GET", url: `${GATEWAY_PROXY_PREFIXES.USAGE}/_probe` }),
      app.inject({ method: "GET", url: `${GATEWAY_PROXY_PREFIXES.BILLING}/_probe` }),
      app.inject({ method: "GET", url: `${GATEWAY_PROXY_PREFIXES.ANALYTICS}/_probe` })
    ]);

    for (const response of responses) {
      expect(response.statusCode).not.toBe(404);
    }
  });
});
