import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, ERROR_RESPONSES } from "@telemetry/shared-types";
import { z } from "zod";
import {
  chunkArray,
  formatBytes,
  formatCurrency,
  generateIdempotencyKey,
  registerGlobalErrorHandler,
  retryWithBackoff,
  sleep
} from "../src";

describe("shared-utils", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("generates deterministic idempotency key for same inputs", () => {
    const first = generateIdempotencyKey(
      "tenant_1",
      "api.request",
      "2026-01-01T00:00:00Z"
    );
    const second = generateIdempotencyKey(
      "tenant_1",
      "api.request",
      "2026-01-01T00:00:00Z"
    );

    expect(first).toBe(second);
  });

  it("produces different keys for different tenant inputs", () => {
    const tenantOne = generateIdempotencyKey(
      "tenant_1",
      "api.request",
      "2026-01-01T00:00:00Z"
    );
    const tenantTwo = generateIdempotencyKey(
      "tenant_2",
      "api.request",
      "2026-01-01T00:00:00Z"
    );

    expect(tenantOne).not.toBe(tenantTwo);
  });

  it("chunks arrays with the requested size", () => {
    const chunks = chunkArray([1, 2, 3, 4, 5], 2);

    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("throws for invalid chunk size", () => {
    expect(() => chunkArray([1, 2], 0)).toThrow("size must be a positive integer");
  });

  it("returns empty chunk list for empty input", () => {
    expect(chunkArray([], 5)).toEqual([]);
  });

  it("resolves sleep after requested delay", async () => {
    vi.useFakeTimers();

    const promise = sleep(50);
    await vi.advanceTimersByTimeAsync(50);

    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects sleep for negative delay", async () => {
    await expect(sleep(-1)).rejects.toThrow("ms must be non-negative");
  });

  it("retries with backoff and eventually succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    let attempts = 0;
    const operation = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("transient");
      }

      return "ok";
    });

    const result = await retryWithBackoff(operation, {
      maxAttempts: 3,
      baseDelayMs: 0
    });

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("throws last error when retries are exhausted", async () => {
    const expected = new Error("always fails");
    const operation = vi.fn(async () => {
      throw expected;
    });

    await expect(
      retryWithBackoff(operation, {
        maxAttempts: 2,
        baseDelayMs: 0
      })
    ).rejects.toThrow("always fails");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("validates retry options", async () => {
    await expect(
      retryWithBackoff(async () => "ok", {
        maxAttempts: 0,
        baseDelayMs: 1
      })
    ).rejects.toThrow("maxAttempts must be at least 1");

    await expect(
      retryWithBackoff(async () => "ok", {
        maxAttempts: 1,
        baseDelayMs: -1
      })
    ).rejects.toThrow("baseDelayMs must be non-negative");
  });

  it("formats currency values", () => {
    expect(formatCurrency(1999, "USD")).toBe("$19.99");
  });

  it("formats bytes using binary units", () => {
    expect(formatBytes(1048576)).toBe("1 MB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("rejects negative byte values", () => {
    expect(() => formatBytes(-1)).toThrow("bytes must be non-negative");
  });

  it("normalizes AppError responses through the global handler", async () => {
    const app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    app.get("/forbidden", async () => {
      throw new AppError("TENANT_MISMATCH", 403, "Tenant mismatch");
    });

    const response = await app.inject({ method: "GET", url: "/forbidden" });

    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "TENANT_MISMATCH",
      message: "Tenant mismatch"
    });
  });

  it("normalizes ZodError responses through the global handler", async () => {
    const app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    app.get("/zod", async () => {
      const parsed = z.object({ count: z.number().int().positive() }).safeParse({ count: -1 });
      if (!parsed.success) {
        throw parsed.error;
      }
    });

    const response = await app.inject({ method: "GET", url: "/zod" });

    await app.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: ERROR_RESPONSES.CODE_VALIDATION_ERROR
    });
  });

  it("maps Prisma duplicate-key errors to conflict responses", async () => {
    const app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    app.get("/prisma-conflict", async () => {
      throw Object.assign(new Error("duplicate"), { code: "P2002" });
    });

    const response = await app.inject({ method: "GET", url: "/prisma-conflict" });

    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: ERROR_RESPONSES.CODE_CONFLICT
    });
  });

  it("normalizes unexpected errors through the global handler", async () => {
    const app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    app.get("/boom", async () => {
      throw new Error("boom");
    });

    const response = await app.inject({ method: "GET", url: "/boom" });

    await app.close();

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: ERROR_RESPONSES.CODE_INTERNAL_ERROR,
      message: "boom"
    });
  });

  it("hides internal error message in production mode", async () => {
    process.env.NODE_ENV = "production";

    const app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    app.get("/boom-prod", async () => {
      throw new Error("boom-prod");
    });

    const response = await app.inject({ method: "GET", url: "/boom-prod" });

    await app.close();

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: ERROR_RESPONSES.CODE_INTERNAL_ERROR
    });
  });
});
