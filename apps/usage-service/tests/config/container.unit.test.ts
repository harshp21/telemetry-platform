import { describe, expect, it, vi } from "vitest";
import { createContainer } from "../../src/config/container";
import { env } from "../../src/config/env";

describe("AppContainer (usage-service)", () => {
  it("createContainer() returns all required properties", () => {
    const container = createContainer("usage-service", env);

    expect(container).toBeDefined();
    expect(container.serviceName).toBe("usage-service");
    expect(container.env).toBeDefined();
    expect(container.logger).toBeDefined();
    expect(container.prisma).toBeDefined();
    expect(container.redis).toBeDefined();
  });

  it("createContainer() creates default logger when not provided", () => {
    const container = createContainer("usage-service", env);

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
    const container = createContainer("usage-service", env, mockLogger as any);

    expect(container.logger).toBe(mockLogger);
  });
});
