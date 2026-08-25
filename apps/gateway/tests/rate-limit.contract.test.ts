import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { registerGatewayRateLimit } from "../src/plugins/rate-limit.plugin";
import { GATEWAY_PUBLIC_ROUTES, GATEWAY_RESPONSES, GATEWAY_USAGE_ROUTES } from "../src/constants";

const quitMock = vi.fn();

vi.mock("ioredis", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      quit: quitMock
    }))
  };
});

type CapturedRegistration = {
  options: {
    global: boolean;
    hook: string;
    skipOnError: boolean;
    redis: unknown;
    keyGenerator: (request: FastifyRequest) => string | number;
    allowList: (request: FastifyRequest) => boolean;
    max: (request: FastifyRequest) => number;
    timeWindow: number;
    addHeaders: {
      "retry-after": boolean;
    };
    errorResponseBuilder: (
      _request: FastifyRequest,
      _context: { after: string | number; max: number }
    ) => { code: string; retryAfter: number; limit: number; current: number };
  };
};

type GatewayRateLimitAppMock = {
  addHook: (hookName: string, hook: () => Promise<void>) => void;
  register: (_plugin: unknown, options: CapturedRegistration["options"]) => void;
};

const createRequest = (method: string, url: string, tenantId?: string): FastifyRequest => {
  return {
    method,
    url,
    ip: "127.0.0.1",
    authContext: tenantId ? { tenantId } : undefined
  } as FastifyRequest;
};

describe("gateway rate limit contract", () => {
  beforeEach(() => {
    quitMock.mockClear();
  });

  it("registers the expected 429 contract and route tiers", () => {
    let capturedOptions: CapturedRegistration["options"] | undefined;
    const addHook = vi.fn();
    const app = {
      addHook,
      register: (_plugin: unknown, options: CapturedRegistration["options"]): void => {
        capturedOptions = options;
      }
    } satisfies GatewayRateLimitAppMock;

    registerGatewayRateLimit(app as unknown as FastifyInstance, {
      redisUrl: "redis://127.0.0.1:6379",
      nodeEnv: "test",
      rateLimitMax: 1000,
      rateLimitWindowMs: 1000,
      ingestionRateLimitMax: 5000
    });

    expect(capturedOptions).toBeDefined();
    const options = capturedOptions;

    if (!options) {
      throw new Error("rate limit options were not captured");
    }

    expect(options.global).toBe(true);
    expect(options.hook).toBe("onRequest");
    expect(options.skipOnError).toBe(true);
    expect(options.redis).toBeUndefined();
    expect(options.timeWindow).toBe(1000);
    expect(options.addHeaders).toEqual({ "retry-after": true });

    const publicRoute = createRequest("POST", GATEWAY_PUBLIC_ROUTES[3].path);
    const tenantRequest = createRequest("GET", `${GATEWAY_USAGE_ROUTES.EVENTS}?cursor=1`, "tenant-123");
    const ipFallbackRequest = createRequest("GET", "/v1/usage/probe");

    expect(options.allowList(publicRoute)).toBe(true);
    expect(options.allowList(tenantRequest)).toBe(false);
    expect(options.keyGenerator(tenantRequest)).toBe("tenant-123");
    expect(options.keyGenerator(ipFallbackRequest)).toBe("ip:127.0.0.1");
    expect(options.max(tenantRequest)).toBe(5000);
    expect(options.max(ipFallbackRequest)).toBe(1000);

    const response = options.errorResponseBuilder(tenantRequest, { after: "2500", max: 1000 });
    expect(response).toEqual({
      code: GATEWAY_RESPONSES.CODE_RATE_LIMIT_EXCEEDED,
      retryAfter: 3,
      limit: 1000,
      current: 1001
    });
  });

  it("creates and closes a redis client in production mode", async () => {
    const addHook = vi.fn();
    const register = vi.fn();
    const app = { addHook, register } satisfies GatewayRateLimitAppMock;

    registerGatewayRateLimit(app as unknown as FastifyInstance, {
      redisUrl: "redis://redis.example.internal:6379",
      nodeEnv: "production",
      rateLimitMax: 1000,
      rateLimitWindowMs: 1000,
      ingestionRateLimitMax: 5000
    });

    expect(register).toHaveBeenCalledTimes(1);
    const [, options] = register.mock.calls[0] as [unknown, { redis: { quit: () => Promise<void> } }];
    expect(options.redis).toBeDefined();

    const closeHook = addHook.mock.calls.find(([hookName]) => hookName === "onClose")?.[1] as
      | (() => Promise<void>)
      | undefined;

    expect(closeHook).toBeDefined();

    await closeHook?.();
    expect(quitMock).toHaveBeenCalledTimes(1);
  });
});