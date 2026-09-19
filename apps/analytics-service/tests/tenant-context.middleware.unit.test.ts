import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { analyticsTenantContextHandler } from "../src/middleware/tenant-context.middleware";
import { ANALYTICS_HEADERS, ANALYTICS_RESPONSES } from "../src/constants";

/**
 * The tenant-context hook in isolation, on a bare Fastify instance carrying only the root error
 * handler (S-9, layer 3 of `.claude/rules/tenant-isolation.md`).
 *
 * Deliberately not the real app and deliberately without the guard:
 * `internal-auth.middleware.unit.test.ts` owns which scope the hooks are in and in what order,
 * and mixing the two would make a failure here ambiguous between "the hook is wrong" and "the
 * wiring is wrong". Mirrors `apps/billing-service/tests/tenant-context.middleware.unit.test.ts`.
 */

const TENANT_ID_VALID = "0450a5e0-0000-4000-8000-0000000000aa";
const TENANT_ID_UPPERCASE = "0450A5E0-0000-4000-8000-0000000000AA";
const TENANT_ID_VALID_SECOND = "0450a5e0-0000-4000-8000-0000000000bb";
const TENANT_ID_NOT_A_UUID = "abc";
const TENANT_ID_WITH_COLON = "tenant:a";
const BLANK = "";
const WHITESPACE = "   ";
const PROBE_ROUTE = "/probe";

describe("analyticsTenantContextHandler", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    app.addHook("onRequest", analyticsTenantContextHandler);
    app.get(PROBE_ROUTE, async (request) => ({ tenantId: request.tenantId }));
  });

  afterEach(async () => {
    await app.close();
  });

  const inject = (headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: PROBE_ROUTE, headers });

  it("AU17 - attaches the validated tenant id to the request, byte-identical to the header", async () => {
    const response = await inject({ [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID_VALID });

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toEqual({ tenantId: TENANT_ID_VALID });
  });

  // AU17b. `tenantIdSchema` is `uuidSchema.transform(v => v as TenantId)` -- a type-level cast
  // with no runtime effect. Pinned because swapping it for a normalising parse would change the
  // string a repository binds and the RLS context receives, and `Tenant.id` is compared
  // byte-for-byte by both. An all-lower-case fixture cannot tell a normalising parse apart.
  it("AU17b - validates without normalising, so an upper-case UUID passes through unchanged", async () => {
    const response = await inject({ [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID_UPPERCASE });

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toEqual({ tenantId: TENANT_ID_UPPERCASE });
  });

  it("AU18/AU19 - rejects a missing, blank or whitespace-only X-Tenant-Id with 401 TENANT_CONTEXT_MISSING", async () => {
    const missing = await inject();
    const blank = await inject({ [ANALYTICS_HEADERS.TENANT_ID]: BLANK });
    const whitespace = await inject({ [ANALYTICS_HEADERS.TENANT_ID]: WHITESPACE });

    for (const response of [missing, blank, whitespace]) {
      expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      expect(response.json()).toMatchObject({
        code: ANALYTICS_RESPONSES.CODE_TENANT_CONTEXT_MISSING,
        message: ANALYTICS_RESPONSES.MESSAGE_TENANT_CONTEXT_MISSING
      });
    }
  });

  it("AU20 - rejects a present but non-UUID X-Tenant-Id with 401 TENANT_CONTEXT_INVALID", async () => {
    const notAUuid = await inject({ [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID_NOT_A_UUID });
    // A tenant id containing `:` is the specific shape `.claude/rules/tenant-isolation.md` names:
    // it would make another service's `<prefix>:<tenantId>:<key>` derivation ambiguous. Non-empty
    // is therefore not good enough, which is what separates this case from AU18/AU19.
    const withColon = await inject({ [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID_WITH_COLON });

    for (const response of [notAUuid, withColon]) {
      expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      expect(response.json()).toMatchObject({
        code: ANALYTICS_RESPONSES.CODE_TENANT_CONTEXT_INVALID,
        message: ANALYTICS_RESPONSES.MESSAGE_TENANT_CONTEXT_INVALID
      });
    }

    // The distinct code is the assertion that matters: both classes answer 401, so a status-only
    // test would pass with one error doing both jobs.
    expect(notAUuid.json()).not.toMatchObject({
      code: ANALYTICS_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });
  });

  // AU21. Header smuggling: a caller that got a second `X-Tenant-Id` past the gateway must not
  // be able to make this hook pick one.
  //
  // What rejects it, measured rather than assumed: at fastify 5.10.0 a duplicated header arrives
  // **joined into a string** -- `app.inject` joins an array as `"<A>,<B>"`, and Node's parser
  // joins real repeated header lines as `"<A>, <B>"`. Both are `typeof === "string"`, so the
  // hook's `typeof header !== "string"` arm is not what refuses them; `tenantIdSchema` is,
  // because neither joined form is a UUID. That is why this is *invalid* and not *missing*. Both
  // separators are asserted, since only one of them is reachable from `app.inject`.
  it("AU21 - rejects a duplicated X-Tenant-Id as invalid, preferring neither value", async () => {
    const injectedJoin = await inject({
      [ANALYTICS_HEADERS.TENANT_ID]: [TENANT_ID_VALID, TENANT_ID_VALID_SECOND]
    } as unknown as Record<string, string>);
    const socketJoin = await inject({
      [ANALYTICS_HEADERS.TENANT_ID]: `${TENANT_ID_VALID}, ${TENANT_ID_VALID_SECOND}`
    });

    for (const response of [injectedJoin, socketJoin]) {
      expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      expect(response.json()).toMatchObject({
        code: ANALYTICS_RESPONSES.CODE_TENANT_CONTEXT_INVALID
      });
      // The load-bearing half. A hook that took the first value would answer 200 with
      // `{ tenantId: <A> }`; one that took the last would answer 200 with `{ tenantId: <B> }`.
      // Asserting the 401 alone would not tell either apart from a rejection.
      const body = JSON.stringify(response.json());
      expect(body).not.toContain(TENANT_ID_VALID);
      expect(body).not.toContain(TENANT_ID_VALID_SECOND);
    }
  });
});
