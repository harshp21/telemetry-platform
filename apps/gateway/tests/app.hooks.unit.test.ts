import { beforeEach, describe, expect, it, vi } from "vitest";

describe("gateway app hook ordering", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("registers request guards before jwt auth hook", async () => {
    const onCloseHook = vi.fn();
    const guardHook = vi.fn();
    const authHook = vi.fn();
    const addHook = vi.fn();
    const register = vi.fn();
    const get = vi.fn();
    const decorate = vi.fn();

    vi.doMock("fastify", () => {
      return {
        default: vi.fn(() => ({
          addHook,
          register,
          get,
          decorate
        }))
      };
    });

    vi.doMock("@telemetry/shared-utils", () => ({
      registerGlobalErrorHandler: vi.fn()
    }));

    vi.doMock("../src/config/env", () => ({
      loadEnv: vi.fn(() => ({
        NODE_ENV: "test",
        PORT: 3100,
        REDIS_URL: "redis://127.0.0.1:6379",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
        LOG_LEVEL: "info",
        JWT_SECRET: "test-jwt-secret-value-with-at-least-32-characters",
        AUTH_SERVICE_URL: "http://auth-service:3000",
        USAGE_SERVICE_URL: "http://usage-service:3001",
        BILLING_SERVICE_URL: "http://billing-service:3002",
        ANALYTICS_SERVICE_URL: "http://analytics-service:3003",
        RATE_LIMIT_MAX: 100,
        RATE_LIMIT_WINDOW_MS: 60000,
        INGESTION_RATE_LIMIT_MAX: 30
      }))
    }));

    vi.doMock("../src/config/container", () => ({
      createContainer: vi.fn(() => ({
        serviceName: "gateway",
        redis: {
          status: "ready",
          quit: onCloseHook
        }
      }))
    }));

    vi.doMock("../src/middleware/guards.middleware", () => ({
      gatewayRequestGuardsPreHandler: guardHook
    }));

    vi.doMock("../src/middleware/auth.middleware", () => ({
      gatewayJwtAuthPreHandler: authHook
    }));

    vi.doMock("../src/plugins/rate-limit.plugin", () => ({
      registerGatewayRateLimit: vi.fn()
    }));

    vi.doMock("../src/plugins/proxy.plugin", () => ({
      registerGatewayProxyRoutes: vi.fn()
    }));

    const { buildGatewayApp } = await import("../src/app");
    buildGatewayApp();

    const onRequestCalls = addHook.mock.calls.filter(([hookName]) => hookName === "onRequest");

    expect(onRequestCalls).toHaveLength(2);
    expect(onRequestCalls[0]?.[1]).toBe(guardHook);
    expect(onRequestCalls[1]?.[1]).toBe(authHook);
  });
});