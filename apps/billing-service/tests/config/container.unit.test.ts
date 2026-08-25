import { describe, expect, it, vi, afterEach } from "vitest";
import { createContainer } from "../../src/config/container";
import { env, type ServiceEnv } from "../../src/config/env";
import { createLogger } from "@telemetry/shared-logger";

describe("AppContainer (billing-service)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("createContainer() returns all required properties", () => {
    const container = createContainer("billing-service", env as ServiceEnv);

    expect(container).toBeDefined();
    expect(container.serviceName).toBe("billing-service");
    expect(container.env).toBeDefined();
    expect(container.logger).toBeDefined();
    expect(container.prisma).toBeDefined();
    expect(container.redis).toBeDefined();
  });

  it("createContainer() creates default logger when not provided", () => {
    const container = createContainer("billing-service", env as ServiceEnv);

    expect(container.logger).toBeDefined();
    expect(typeof container.logger.info).toBe("function");
    expect(typeof container.logger.error).toBe("function");
    expect(typeof container.logger.debug).toBe("function");
    expect(typeof container.logger.warn).toBe("function");
  });

  it("createContainer() uses provided logger when given", () => {
    const mockLogger = createLogger("billing-test");
    const container = createContainer("billing-service", env as ServiceEnv, mockLogger);

    expect(container.logger).toBe(mockLogger);
  });

  it("createContainer() attaches error listener to Redis client", () => {
    const container = createContainer("billing-service", env as ServiceEnv);

    // Verify Redis has error listeners (ioredis exposes listener count via _events)
    expect(container.redis.listenerCount("error")).toBeGreaterThan(0);
  });
});

