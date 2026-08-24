import { describe, expect, it } from "vitest";
import { buildGatewayApp } from "../src/app";
import { GATEWAY_RESPONSES, GATEWAY_ROUTES, GATEWAY_RUNTIME, GATEWAY_SERVICE_NAME } from "../src/constants";

const GATEWAY_SMOKE_ENV_KEYS = [
  "NODE_ENV",
  "JWT_SECRET",
  "REDIS_URL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "AUTH_SERVICE_URL",
  "USAGE_SERVICE_URL",
  "BILLING_SERVICE_URL",
  "ANALYTICS_SERVICE_URL",
  "RATE_LIMIT_MAX",
  "RATE_LIMIT_WINDOW_MS",
  "INGESTION_RATE_LIMIT_MAX"
] as const;

const GATEWAY_SMOKE_ENV: Record<(typeof GATEWAY_SMOKE_ENV_KEYS)[number], string> = {
  NODE_ENV: "test",
  JWT_SECRET: "test-jwt-secret-value-with-at-least-32-characters",
  REDIS_URL: "redis://127.0.0.1:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
  AUTH_SERVICE_URL: "http://127.0.0.1:4101",
  USAGE_SERVICE_URL: "http://127.0.0.1:4102",
  BILLING_SERVICE_URL: "http://127.0.0.1:4103",
  ANALYTICS_SERVICE_URL: "http://127.0.0.1:4104",
  RATE_LIMIT_MAX: "1000",
  RATE_LIMIT_WINDOW_MS: "1000",
  INGESTION_RATE_LIMIT_MAX: "5000"
};

const applyGatewaySmokeEnv = (): Partial<Record<(typeof GATEWAY_SMOKE_ENV_KEYS)[number], string | undefined>> => {
  const previous: Partial<Record<(typeof GATEWAY_SMOKE_ENV_KEYS)[number], string | undefined>> = {};

  for (const key of GATEWAY_SMOKE_ENV_KEYS) {
    previous[key] = process.env[key];
    process.env[key] = GATEWAY_SMOKE_ENV[key];
  }

  return previous;
};

const restoreGatewaySmokeEnv = (
  previous: Partial<Record<(typeof GATEWAY_SMOKE_ENV_KEYS)[number], string | undefined>>
): void => {
  for (const key of GATEWAY_SMOKE_ENV_KEYS) {
    const value = previous[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

describe("gateway smoke", () => {
  it("returns healthy status", async () => {
    const useExternalTarget = process.env.SMOKE_TARGET === "external";

    if (useExternalTarget) {
      const response = await fetch(`http://127.0.0.1:${GATEWAY_RUNTIME.DEFAULT_PORT}${GATEWAY_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: GATEWAY_RESPONSES.STATUS_OK,
        service: GATEWAY_SERVICE_NAME
      });
      return;
    }

    const previousEnv = applyGatewaySmokeEnv();
    const app = buildGatewayApp();
    await app.listen({ port: 0, host: "127.0.0.1" });

    const address = app.server.address();

    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve gateway listening address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${GATEWAY_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: GATEWAY_RESPONSES.STATUS_OK,
        service: GATEWAY_SERVICE_NAME
      });
    } finally {
      await app.close();
      restoreGatewaySmokeEnv(previousEnv);
    }
  });

  it("returns versioned health status for v1 route", async () => {
    const useExternalTarget = process.env.SMOKE_TARGET === "external";

    if (useExternalTarget) {
      const response = await fetch(`http://127.0.0.1:${GATEWAY_RUNTIME.DEFAULT_PORT}${GATEWAY_ROUTES.V1_HEALTH}`);
      const body = (await response.json()) as { status: string; service: string; version: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: GATEWAY_RESPONSES.STATUS_OK,
        service: GATEWAY_SERVICE_NAME,
        version: GATEWAY_RESPONSES.VERSION_V1
      });
      return;
    }

    const previousEnv = applyGatewaySmokeEnv();
    const app = buildGatewayApp();
    await app.listen({ port: 0, host: "127.0.0.1" });

    const address = app.server.address();

    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve gateway listening address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${GATEWAY_ROUTES.V1_HEALTH}`);
      const body = (await response.json()) as { status: string; service: string; version: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: GATEWAY_RESPONSES.STATUS_OK,
        service: GATEWAY_SERVICE_NAME,
        version: GATEWAY_RESPONSES.VERSION_V1
      });
    } finally {
      await app.close();
      restoreGatewaySmokeEnv(previousEnv);
    }
  });
});
