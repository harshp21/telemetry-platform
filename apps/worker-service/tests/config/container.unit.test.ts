import { describe, expect, it, vi, afterEach } from "vitest";
import { createContainer } from "../../src/config/container";
import { env, type ServiceEnv } from "../../src/config/env";
import { createLogger } from "@telemetry/shared-logger";
import type { TenantId } from "@telemetry/shared-types";

describe("AppContainer (worker-service)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("createContainer() returns all required properties", () => {
    const container = createContainer("worker-service", env as ServiceEnv);

    expect(container).toBeDefined();
    expect(container.serviceName).toBe("worker-service");
    expect(container.env).toBeDefined();
    expect(container.logger).toBeDefined();
    expect(container.prisma).toBeDefined();
    expect(container.redis).toBeDefined();
    expect(container.eventRepositoryFactory).toBeDefined();
    expect(container.eventProcessor).toBeDefined();
  });

  it("U57 - registers the event repository as a factory, never as a singleton", () => {
    const container = createContainer("worker-service", env as ServiceEnv);
    const tenantA = "456793cd-6625-44f6-af63-142a86019e1a" as TenantId;
    const tenantB = "d4101ff1-8a17-47f7-9765-73c73ccf0441" as TenantId;

    // A function, not an instance. `.claude/rules/tenant-isolation.md`: `tenantId` is a
    // constructor argument, so a singleton pins one tenant process-wide -- and this worker
    // reads every tenant's events off a single stream.
    expect(typeof container.eventRepositoryFactory).toBe("function");

    const forA = container.eventRepositoryFactory(tenantA);
    const forB = container.eventRepositoryFactory(tenantB);
    expect(forA).not.toBe(forB);
    // Two calls for the *same* tenant are still two instances: the factory holds no cache, so
    // no instance outlives the message it was built for.
    expect(container.eventRepositoryFactory(tenantA)).not.toBe(forA);
  });

  it("createContainer() creates default logger when not provided", () => {
    const container = createContainer("worker-service", env as ServiceEnv);

    expect(container.logger).toBeDefined();
    expect(typeof container.logger.info).toBe("function");
    expect(typeof container.logger.error).toBe("function");
    expect(typeof container.logger.debug).toBe("function");
    expect(typeof container.logger.warn).toBe("function");
  });

  it("createContainer() uses provided logger when given", () => {
    const mockLogger = createLogger("worker-test");
    const container = createContainer("worker-service", env as ServiceEnv, mockLogger);

    expect(container.logger).toBe(mockLogger);
  });

  it("createContainer() attaches error listener to Redis client", () => {
    const container = createContainer("worker-service", env as ServiceEnv);

    // Verify Redis has error listeners (ioredis exposes listener count via _events)
    expect(container.redis.listenerCount("error")).toBeGreaterThan(0);
  });

  it("createContainer() configures Redis with expected connection options", () => {
    const container = createContainer("worker-service", env as ServiceEnv);
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
    const mockLogger = createLogger("worker-test");
    const errorSpy = vi.spyOn(mockLogger, "error").mockImplementation(() => {
      return undefined;
    });
    const container = createContainer("worker-service", env as ServiceEnv, mockLogger);

    container.redis.emit("error", new Error("redis-boom"));

    expect(errorSpy).toHaveBeenCalledWith(
      { error: "redis-boom", service: "worker-service" },
      "Redis connection error"
    );
  });
});

