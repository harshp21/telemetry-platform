import { describe, expect, it, vi, beforeEach } from "vitest";
import { createContainer } from "../../src/config/container";

// Mock env data for testing
const mockEnv = {
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
  it("createContainer() returns all required properties (excluding prisma)", () => {
    const container = createContainer("gateway", mockEnv as any);

    expect(container).toBeDefined();
    expect(container.serviceName).toBe("gateway");
    expect(container.env).toBeDefined();
    expect(container.logger).toBeDefined();
    expect(container.redis).toBeDefined();
    // Gateway should NOT have prisma property
    expect((container as any).prisma).toBeUndefined();
  });

  it("createContainer() creates default logger when not provided", () => {
    const container = createContainer("gateway", mockEnv as any);

    expect(container.logger).toBeDefined();
    expect(typeof container.logger.info).toBe("function");
    expect(typeof container.logger.error).toBe("function");
    expect(typeof container.logger.debug).toBe("function");
    expect(typeof container.logger.warn).toBe("function");
  });

  it("createContainer() uses provided logger when given", () => {
    const mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn()
    };
    const container = createContainer("gateway", mockEnv as any, mockLogger as any);

    expect(container.logger).toBe(mockLogger);
  });
});
