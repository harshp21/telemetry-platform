import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import Fastify, { type FastifyInstance } from "fastify";
import { buildGatewayApp } from "../src/app";
import {
  GATEWAY_PROXY_PREFIXES,
  GATEWAY_RESPONSES,
  GATEWAY_ROUTES,
  GATEWAY_SERVICE_NAME
} from "../src/constants";

const PROXY_ENV_KEYS = [
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

const TEST_PROXY_ENV: Record<(typeof PROXY_ENV_KEYS)[number], string> = {
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

const createAccessToken = async (
  tenantId = "tenant-1",
  userId = "user-1",
  role = "ADMIN"
): Promise<string> => {
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    throw new Error("JWT_SECRET must be defined in tests");
  }

  return new SignJWT({ tenantId, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(jwtSecret));
};

describe("gateway", () => {
  let app: FastifyInstance;
  let previousProxyEnv: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>>;

  const applyEnvAndRebuildApp = async (
    overrides: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>> = {}
  ): Promise<void> => {
    for (const key of PROXY_ENV_KEYS) {
      process.env[key] = overrides[key] ?? TEST_PROXY_ENV[key];
    }

    if (app) {
      await app.close();
    }

    app = buildGatewayApp();
  };

  beforeEach(async () => {
    previousProxyEnv = {};

    for (const key of PROXY_ENV_KEYS) {
      previousProxyEnv[key] = process.env[key];
    }

    await applyEnvAndRebuildApp();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }

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

  it("allows public auth routes without bearer token", async () => {
    const response = await app.inject({ method: "POST", url: `${GATEWAY_PROXY_PREFIXES.AUTH}/login` });

    expect(response.statusCode).not.toBe(401);
  });

  it("rejects protected routes when authorization header is missing", async () => {
    const response = await app.inject({ method: "GET", url: `${GATEWAY_PROXY_PREFIXES.USAGE}/_probe` });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "TOKEN_MISSING" });
  });

  it("rejects protected routes when bearer token is malformed", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${GATEWAY_PROXY_PREFIXES.USAGE}/_probe`,
      headers: {
        authorization: "Bearer malformed-token"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("forwards protected routes when bearer token is valid", async () => {
    const accessToken = await createAccessToken();

    const response = await app.inject({
      method: "GET",
      url: `${GATEWAY_PROXY_PREFIXES.USAGE}/_probe`,
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).not.toBe(401);
  });

  it("injects verified auth headers for protected upstream requests", async () => {
    const previousUsageUrl = process.env.USAGE_SERVICE_URL;
    const upstream = Fastify({ logger: false });

    upstream.get("/v1/usage/echo-headers", async (request) => {
      return {
        tenantId: request.headers["x-tenant-id"],
        userId: request.headers["x-user-id"],
        role: request.headers["x-user-role"]
      };
    });

    await upstream.listen({ port: 0, host: "127.0.0.1" });

    const upstreamAddress = upstream.server.address();

    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Unable to resolve upstream listening address");
    }

    process.env.USAGE_SERVICE_URL = `http://127.0.0.1:${upstreamAddress.port}`;
    process.env.RATE_LIMIT_MAX = "100000";
    process.env.INGESTION_RATE_LIMIT_MAX = "100000";

    await app.close();
    app = buildGatewayApp();

    try {
      const accessToken = await createAccessToken("tenant-header-test", "user-header-test", "ADMIN");
      const response = await app.inject({
        method: "GET",
        url: `${GATEWAY_PROXY_PREFIXES.USAGE}/echo-headers`,
        headers: {
          authorization: `Bearer ${accessToken}`
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        tenantId: "tenant-header-test",
        userId: "user-header-test",
        role: "ADMIN"
      });
    } finally {
      await upstream.close();

      if (previousUsageUrl === undefined) {
        delete process.env.USAGE_SERVICE_URL;
      } else {
        process.env.USAGE_SERVICE_URL = previousUsageUrl;
      }
    }
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
