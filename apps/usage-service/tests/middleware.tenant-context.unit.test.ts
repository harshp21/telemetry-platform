/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { registerUsageTenantContextMiddleware } from "../src/middleware/tenant-context.middleware";

const TENANT_ID_VALID = "11111111-1111-4111-8111-111111111111";

describe("usageTenantContextMiddleware", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    registerUsageTenantContextMiddleware(app);

    // Add a test route to verify middleware behavior
    app.get("/test", async (request) => {
      return { tenantId: request.tenantId };
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("extracts and attaches X-Tenant-Id header when present", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test",
      headers: {
        "x-tenant-id": TENANT_ID_VALID
      }
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json).toMatchObject({ tenantId: TENANT_ID_VALID });
  });

  it("rejects request with missing X-Tenant-Id header with 401 TENANT_CONTEXT_MISSING", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test",
      headers: {}
    });

    expect(response.statusCode).toBe(401);
    const json = response.json();
    expect(json).toMatchObject({
      code: "TENANT_CONTEXT_MISSING",
      message: expect.any(String)
    });
  });

  it("rejects request with empty X-Tenant-Id header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test",
      headers: {
        "x-tenant-id": ""
      }
    });

    expect(response.statusCode).toBe(401);
    const json = response.json();
    expect(json).toMatchObject({
      code: "TENANT_CONTEXT_MISSING"
    });
  });

  it("rejects request with whitespace-only X-Tenant-Id header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test",
      headers: {
        "x-tenant-id": "   "
      }
    });

    expect(response.statusCode).toBe(401);
    const json = response.json();
    expect(json).toMatchObject({
      code: "TENANT_CONTEXT_MISSING"
    });
  });

  it("preserves existing request properties (method, url, etc.)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test",
      headers: {
        "x-tenant-id": TENANT_ID_VALID
      }
    });

    expect(response.statusCode).toBe(200);
    // Verify the request was processed correctly
    const json = response.json();
    expect(json.tenantId).toBe(TENANT_ID_VALID);
  });

  it("handles header case-insensitivity (X-Tenant-Id)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test",
      headers: {
        "X-Tenant-Id": TENANT_ID_VALID
      }
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json).toMatchObject({ tenantId: TENANT_ID_VALID });
  });

  it("returns typed tenantId on request object with valid header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test",
      headers: {
        "x-tenant-id": TENANT_ID_VALID
      }
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(typeof json.tenantId).toBe("string");
    expect(json.tenantId).toBe(TENANT_ID_VALID);
  });
});
