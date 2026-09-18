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
  secretsMatch,
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

/**
 * `secretsMatch` -- the one timing-safe comparison the three internal-auth guards share (S-8).
 *
 * **What these cases prove, and what they do not.** They prove *behavioural equivalence*: the
 * digest comparison accepts and rejects exactly what the `!==` it replaced accepted and rejected,
 * across equal, first-byte-different, last-byte-different, prefix, superstring, empty and
 * unequal-length inputs. They prove nothing about timing. A timing assertion over SHA-256 plus
 * `crypto.timingSafeEqual` is not reliably measurable in a vitest process on a shared runner --
 * the measurement noise exceeds the effect -- so a threshold that passed here would be a flake on
 * CI. The constant-time property rests on `crypto.timingSafeEqual`'s documented contract and on
 * the fixed-width-digest argument in this function's docblock, **not** on a green run of this
 * describe block. Do not read it as evidence of one.
 *
 * The unequal-length cases are the ones with teeth beyond equivalence: `timingSafeEqual` throws
 * on buffers of different lengths, so a future edit that dropped the hashing step and compared
 * raw bytes would turn them from `false` into a thrown `RangeError`.
 */
describe("secretsMatch", () => {
  const SECRET = "s-008-shared-internal-secret-at-least-32-chars";

  it("matches two identical secrets", () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    // A separately-constructed equal string, so the case cannot pass on reference identity.
    expect(secretsMatch(`${SECRET}`.slice(0), SECRET)).toBe(true);
  });

  it("rejects a secret differing only in its first character", () => {
    const differingFirst = `Z${SECRET.slice(1)}`;

    expect(differingFirst).toHaveLength(SECRET.length);
    expect(secretsMatch(differingFirst, SECRET)).toBe(false);
  });

  it("rejects a secret differing only in its last character", () => {
    const differingLast = `${SECRET.slice(0, -1)}Z`;

    expect(differingLast).toHaveLength(SECRET.length);
    expect(secretsMatch(differingLast, SECRET)).toBe(false);
  });

  it("rejects a proper prefix of the expected secret without throwing", () => {
    expect(secretsMatch(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(secretsMatch("", SECRET)).toBe(false);
  });

  it("rejects a superstring of the expected secret without throwing", () => {
    expect(secretsMatch(`${SECRET}Z`, SECRET)).toBe(false);
  });

  it("matches two empty strings", () => {
    // Not a supported configuration -- every env schema rejects a blank secret -- but the
    // function must still be total, and this is where a naive length guard would branch.
    expect(secretsMatch("", "")).toBe(true);
  });

  it("compares secrets of different lengths without throwing", () => {
    // `timingSafeEqual` raises on unequal buffer lengths. Hashing both sides first is what makes
    // this a `false` rather than a `RangeError`, and it is also what keeps the length off the
    // early-exit path. A run of one character against a run of a hundred is the widest gap.
    expect(() => secretsMatch("a", "b".repeat(100))).not.toThrow();
    expect(secretsMatch("a", "b".repeat(100))).toBe(false);
  });

  it("compares non-ASCII secrets without throwing", () => {
    // Not reachable through the env schema since S-8 (`internalApiSecretSchema` is
    // printable-ASCII only), but the header side is caller-controlled and is not filtered, so a
    // multi-byte candidate reaches this function. UTF-8 encoding widens the buffer before the
    // digest; the digest is 32 bytes either way.
    expect(secretsMatch("\u00e9\u00e9\u00e9", SECRET)).toBe(false);
    expect(secretsMatch("\u00e9\u00e9\u00e9", "\u00e9\u00e9\u00e9")).toBe(true);
  });
});
