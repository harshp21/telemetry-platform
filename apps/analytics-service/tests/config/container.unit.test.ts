import { describe, expect, it, vi, afterEach } from "vitest";
import { createContainer } from "../../src/config/container";
import { env, type ServiceEnv } from "../../src/config/env";
import { createLogger } from "@telemetry/shared-logger";

describe("AppContainer (analytics-service)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("createContainer() returns all required properties", () => {
    const container = createContainer("analytics-service", env as ServiceEnv);

    expect(container).toBeDefined();
    expect(container.serviceName).toBe("analytics-service");
    expect(container.env).toBeDefined();
    expect(container.logger).toBeDefined();
    expect(container.prisma).toBeDefined();
    expect(container.redis).toBeDefined();
  });

  it("createContainer() creates default logger when not provided", () => {
    const container = createContainer("analytics-service", env as ServiceEnv);

    expect(container.logger).toBeDefined();
    expect(typeof container.logger.info).toBe("function");
    expect(typeof container.logger.error).toBe("function");
    expect(typeof container.logger.debug).toBe("function");
    expect(typeof container.logger.warn).toBe("function");
  });

  it("createContainer() uses provided logger when given", () => {
    const mockLogger = createLogger("analytics-test");
    const container = createContainer("analytics-service", env as ServiceEnv, mockLogger);

    expect(container.logger).toBe(mockLogger);
  });

  it("createContainer() attaches error listener to Redis client", () => {
    const container = createContainer("analytics-service", env as ServiceEnv);

    // Verify Redis has error listeners (ioredis exposes listener count via _events)
    expect(container.redis.listenerCount("error")).toBeGreaterThan(0);
  });

  it("createContainer() configures Redis with expected connection options", () => {
    const container = createContainer("analytics-service", env as ServiceEnv);
    const redisOptions = (container.redis as unknown as {
      options: {
        maxRetriesPerRequest: number;
        enableReadyCheck: boolean;
        lazyConnect: boolean;
      };
    }).options;

    expect(redisOptions.maxRetriesPerRequest).toBe(2);
    expect(redisOptions.enableReadyCheck).toBe(true);
    expect(redisOptions.lazyConnect).toBe(true);
  });

  it("createContainer() logs Redis connection errors with service context", () => {
    const mockLogger = createLogger("analytics-test");
    const errorSpy = vi.spyOn(mockLogger, "error").mockImplementation(() => {
      return undefined;
    });
    const container = createContainer(
      "analytics-service",
      env as ServiceEnv,
      mockLogger
    );

    container.redis.emit("error", new Error("redis-boom"));

    expect(errorSpy).toHaveBeenCalledWith(
      { error: "redis-boom", service: "analytics-service" },
      "Redis connection error"
    );
  });
});

