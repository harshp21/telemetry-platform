import { describe, expect, it, vi, afterEach } from "vitest";
import { createContainer } from "../../src/config/container";
import type { ServiceEnv } from "../../src/config/env";
import { createLogger } from "@telemetry/shared-logger";

// Mock env data for testing
const mockEnv: ServiceEnv = {
  NODE_ENV: "test" as const,
  PORT: 3100,
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "debug",
  JWT_SECRET: "test-secret-" + "x".repeat(32),
  AUTH_SERVICE_URL: "http://auth-service:3000",
  USAGE_SERVICE_URL: "http://usage-service:3001",
  BILLING_SERVICE_URL: "http://billing-service:3002",
  ANALYTICS_SERVICE_URL: "http://analytics-service:3003",
  RATE_LIMIT_MAX: 1000,
  RATE_LIMIT_WINDOW_MS: 1000,
  INGESTION_RATE_LIMIT_MAX: 5000
};

describe("AppContainer (gateway)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("createContainer() returns all required properties (excluding prisma)", () => {
    const container = createContainer("gateway", mockEnv);

    expect(container).toBeDefined();
    expect(container.serviceName).toBe("gateway");
    expect(container.env).toBeDefined();
    expect(container.logger).toBeDefined();
    expect(container.redis).toBeDefined();
    // Gateway should NOT have prisma property
    expect("prisma" in container).toBe(false);
  });

  it("createContainer() creates default logger when not provided", () => {
    const container = createContainer("gateway", mockEnv);

    expect(container.logger).toBeDefined();
    expect(typeof container.logger.info).toBe("function");
    expect(typeof container.logger.error).toBe("function");
    expect(typeof container.logger.debug).toBe("function");
    expect(typeof container.logger.warn).toBe("function");
  });

  it("createContainer() uses provided logger when given", () => {
    const mockLogger = createLogger("gateway-test");
    const container = createContainer("gateway", mockEnv, mockLogger);

    expect(container.logger).toBe(mockLogger);
  });

  it("createContainer() attaches error listener to Redis client", () => {
    const container = createContainer("gateway", mockEnv);

    // Verify Redis has error listeners (ioredis exposes listener count via _events)
    expect(container.redis.listenerCount("error")).toBeGreaterThan(0);
  });
});
