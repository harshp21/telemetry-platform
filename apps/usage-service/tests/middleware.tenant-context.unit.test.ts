/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { registerUsageTenantContextMiddleware } from "../src/middleware/tenant-context.middleware";
import { USAGE_SERVICE_HEADERS, USAGE_SERVICE_RESPONSES } from "../src/constants";

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

  // M-2 (docs/reviews/s-001-dedup-key-namespacing.md): S-1 builds Redis dedup keys as
  // `dedup:<tenantId>:<idempotencyKey>`, which is only unambiguous while a tenant id cannot
  // contain ":". These cases are what makes that true.
  describe("UUID validation (M-2)", () => {
    const rejected = [
      ["a plain identifier", "tenant-1"],
      ["a value containing a colon", "a:b"],
      ["a value that would forge a dedup key segment", "11111111-1111-4111-8111-111111111111:x"],
      ["a UUID with surrounding whitespace", ` ${TENANT_ID_VALID} `],
      ["a truncated UUID", TENANT_ID_VALID.slice(0, -1)],
      ["a UUID with a non-hex character", "1111111g-1111-4111-8111-111111111111"]
    ] as const;

    for (const [label, value] of rejected) {
      it(`rejects ${label} with 401 TENANT_CONTEXT_INVALID`, async () => {
        const response = await app.inject({
          method: "GET",
          url: "/test",
          headers: {
            [USAGE_SERVICE_HEADERS.TENANT_ID]: value
          }
        });

        expect(response.statusCode).toBe(
          USAGE_SERVICE_RESPONSES.HTTP_STATUS_UNAUTHORIZED
        );
        expect(response.json()).toMatchObject({
          code: USAGE_SERVICE_RESPONSES.CODE_TENANT_CONTEXT_INVALID,
          message: USAGE_SERVICE_RESPONSES.MESSAGE_TENANT_CONTEXT_INVALID
        });
      });
    }

    it("accepts the uuid() default shape Prisma generates for Tenant.id", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/test",
        headers: {
          [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_VALID
        }
      });

      expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_OK);
      expect(response.json()).toMatchObject({ tenantId: TENANT_ID_VALID });
    });

    it("accepts the non-v4 UUID used by prisma/seed.ts so the dev fixture keeps working", async () => {
      const seededTenantId = "11111111-1111-1111-1111-111111111111";

      const response = await app.inject({
        method: "GET",
        url: "/test",
        headers: {
          [USAGE_SERVICE_HEADERS.TENANT_ID]: seededTenantId
        }
      });

      expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_OK);
      expect(response.json()).toMatchObject({ tenantId: seededTenantId });
    });

    it("does not attach a rejected tenant id to the request", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/test",
        headers: {
          [USAGE_SERVICE_HEADERS.TENANT_ID]: "a:b"
        }
      });

      expect(response.json()).not.toMatchObject({ tenantId: "a:b" });
    });
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
