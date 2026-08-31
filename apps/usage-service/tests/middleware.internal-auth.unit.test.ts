import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { registerUsageInternalAuthMiddleware } from "../src/middleware/internal-auth.middleware";
import { registerUsageTenantContextMiddleware } from "../src/middleware/tenant-context.middleware";
import {
  USAGE_SERVICE_HEADERS,
  USAGE_SERVICE_RESPONSES,
  USAGE_SERVICE_ROUTES
} from "../src/constants";

const INTERNAL_SECRET = "s-004-test-internal-secret-at-least-32-chars";
const WRONG_SECRET = "s-004-WRONG-internal-secret-at-least-32-chars";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";

const TEST_ROUTE = "/test";

describe("usageInternalAuthMiddleware", () => {
  let app: FastifyInstance;
  let tenantSeenByHandler: string | undefined;

  beforeEach(() => {
    tenantSeenByHandler = undefined;
    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);

    // Registration order is the contract under test: the secret guard must run before any
    // tenant work happens, so it is registered first (Fastify runs onRequest hooks in order).
    registerUsageInternalAuthMiddleware(app, INTERNAL_SECRET);
    registerUsageTenantContextMiddleware(app);

    app.get(TEST_ROUTE, async (request) => {
      tenantSeenByHandler = request.tenantId;
      return { tenantId: request.tenantId };
    });

    app.get(USAGE_SERVICE_ROUTES.HEALTH, async () => {
      return { status: USAGE_SERVICE_RESPONSES.STATUS_OK };
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows a request carrying the correct X-Internal-Secret", async () => {
    const response = await app.inject({
      method: "GET",
      url: TEST_ROUTE,
      headers: {
        [USAGE_SERVICE_HEADERS.INTERNAL_SECRET]: INTERNAL_SECRET,
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID
      }
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toMatchObject({ tenantId: TENANT_ID });
    expect(tenantSeenByHandler).toBe(TENANT_ID);
  });

  it("rejects a request with no X-Internal-Secret", async () => {
    const response = await app.inject({
      method: "GET",
      url: TEST_ROUTE,
      headers: {
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID
      }
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_UNAUTHORIZED,
      message: USAGE_SERVICE_RESPONSES.MESSAGE_UNAUTHORIZED
    });
  });

  it("rejects a request with a wrong X-Internal-Secret", async () => {
    const response = await app.inject({
      method: "GET",
      url: TEST_ROUTE,
      headers: {
        [USAGE_SERVICE_HEADERS.INTERNAL_SECRET]: WRONG_SECRET,
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID
      }
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_UNAUTHORIZED
    });
  });

  it("rejects a secret that is a prefix of the real one", async () => {
    const response = await app.inject({
      method: "GET",
      url: TEST_ROUTE,
      headers: {
        [USAGE_SERVICE_HEADERS.INTERNAL_SECRET]: INTERNAL_SECRET.slice(0, -1),
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID
      }
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_UNAUTHORIZED
    });
  });

  it("reports the same code and message for a missing and for a wrong secret", async () => {
    const missing = await app.inject({
      method: "GET",
      url: TEST_ROUTE,
      headers: { [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID }
    });
    const wrong = await app.inject({
      method: "GET",
      url: TEST_ROUTE,
      headers: {
        [USAGE_SERVICE_HEADERS.INTERNAL_SECRET]: WRONG_SECRET,
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID
      }
    });

    expect(missing.statusCode).toBe(wrong.statusCode);
    expect(missing.json()).toEqual(wrong.json());
  });

  it("rejects before tenant context is established", async () => {
    // No tenant header at all AND no secret. If the tenant hook ran first this would report
    // TENANT_CONTEXT_MISSING; the secret guard running first is what makes it UNAUTHORIZED.
    const response = await app.inject({
      method: "GET",
      url: TEST_ROUTE,
      headers: {}
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_UNAUTHORIZED
    });
    expect(response.json()).not.toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });
  });

  it("does not attach tenant context when the secret is rejected", async () => {
    const response = await app.inject({
      method: "GET",
      url: TEST_ROUTE,
      headers: {
        [USAGE_SERVICE_HEADERS.INTERNAL_SECRET]: WRONG_SECRET,
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID
      }
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    // The route handler is the only thing that writes this, so an undefined value proves the
    // request never reached tenant-scoped work.
    expect(tenantSeenByHandler).toBeUndefined();
  });

  it("rejects a malformed tenant id with UNAUTHORIZED, not TENANT_CONTEXT_INVALID, when the secret is also wrong", async () => {
    const response = await app.inject({
      method: "GET",
      url: TEST_ROUTE,
      headers: {
        [USAGE_SERVICE_HEADERS.INTERNAL_SECRET]: WRONG_SECRET,
        [USAGE_SERVICE_HEADERS.TENANT_ID]: "not-a-uuid"
      }
    });

    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_UNAUTHORIZED
    });
  });

  it("leaves /health reachable with no secret and no tenant header", async () => {
    const response = await app.inject({
      method: "GET",
      url: USAGE_SERVICE_ROUTES.HEALTH,
      headers: {}
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toMatchObject({
      status: USAGE_SERVICE_RESPONSES.STATUS_OK
    });
  });

  it("rejects a duplicated X-Internal-Secret header", async () => {
    const response = await app.inject({
      method: "GET",
      url: TEST_ROUTE,
      headers: {
        [USAGE_SERVICE_HEADERS.INTERNAL_SECRET]: [INTERNAL_SECRET, WRONG_SECRET],
        [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID
      }
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_UNAUTHORIZED
    });
  });
});
