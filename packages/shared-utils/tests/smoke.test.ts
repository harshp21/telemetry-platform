import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AppError, ERROR_RESPONSES } from "@telemetry/shared-types";
import { generateIdempotencyKey, registerGlobalErrorHandler } from "../src";

describe("shared-utils", () => {
  it("generates deterministic idempotency key for same inputs", () => {
    const first = generateIdempotencyKey(
      "tenant_1",
      "api.request",
      "2026-01-01T00:00:00Z",
      "sdk-web"
    );
    const second = generateIdempotencyKey(
      "tenant_1",
      "api.request",
      "2026-01-01T00:00:00Z",
      "sdk-web"
    );

    expect(first).toBe(second);
  });

  it("produces different keys for different tenant inputs", () => {
    const tenantOne = generateIdempotencyKey(
      "tenant_1",
      "api.request",
      "2026-01-01T00:00:00Z",
      "sdk-web"
    );
    const tenantTwo = generateIdempotencyKey(
      "tenant_2",
      "api.request",
      "2026-01-01T00:00:00Z",
      "sdk-web"
    );

    expect(tenantOne).not.toBe(tenantTwo);
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
});
