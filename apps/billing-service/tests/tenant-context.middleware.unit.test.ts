import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { billingTenantContextHandler } from "../src/middleware/tenant-context.middleware";
import { BILLING_HEADERS, BILLING_RESPONSES } from "../src/constants";

const TENANT_ID_VALID = "0450a5e0-0000-4000-8000-0000000000aa";
const TENANT_ID_UPPERCASE = "0450A5E0-0000-4000-8000-0000000000AA";
const TENANT_ID_NOT_A_UUID = "abc";
const TENANT_ID_WITH_COLON = "tenant:a";
const TENANT_ID_VALID_SECOND = "0450a5e0-0000-4000-8000-0000000000bb";
const BLANK = "";
const WHITESPACE = "   ";
const PROBE_ROUTE = "/probe";

/**
 * The hook in isolation, on a bare Fastify instance carrying only the root error handler.
 *
 * Deliberately not the real app: `billing-invoices.route.test.ts` owns the question of which
 * scope the hook is registered in and in what order, and mixing the two would make a failure
 * here ambiguous between "the hook is wrong" and "the wiring is wrong".
 */
describe("billingTenantContextHandler", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    app.addHook("onRequest", billingTenantContextHandler);
    app.get(PROBE_ROUTE, async (request) => ({ tenantId: request.tenantId }));
  });

  afterEach(async () => {
    await app.close();
  });

  const inject = (headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: PROBE_ROUTE, headers });

  it("BU77 - attaches the validated tenant id to the request, byte-identical to the header", async () => {
    const response = await inject({ [BILLING_HEADERS.TENANT_ID]: TENANT_ID_VALID });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toEqual({ tenantId: TENANT_ID_VALID });
  });

  it("BU77c - validates without normalising, so an upper-case UUID reaches the repository unchanged", async () => {
    // `tenantIdSchema` is `uuidSchema.transform(v => v as TenantId)` -- a type-level cast with
    // no runtime effect. Pinned because swapping it for a normalising parse would change the
    // string the repository binds and the RLS context receives, and `Tenant.id` is compared
    // byte-for-byte by both.
    const response = await inject({ [BILLING_HEADERS.TENANT_ID]: TENANT_ID_UPPERCASE });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toEqual({ tenantId: TENANT_ID_UPPERCASE });
  });

  it("BU77a - rejects a missing, blank or whitespace-only X-Tenant-Id with 401 TENANT_CONTEXT_MISSING", async () => {
    const missing = await inject();
    const blank = await inject({ [BILLING_HEADERS.TENANT_ID]: BLANK });
    const whitespace = await inject({ [BILLING_HEADERS.TENANT_ID]: WHITESPACE });

    for (const response of [missing, blank, whitespace]) {
      expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      expect(response.json()).toMatchObject({
        code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_MISSING,
        message: BILLING_RESPONSES.MESSAGE_TENANT_CONTEXT_MISSING
      });
    }
  });

  it("BU77b - rejects a present but non-UUID X-Tenant-Id with 401 TENANT_CONTEXT_INVALID", async () => {
    const notAUuid = await inject({ [BILLING_HEADERS.TENANT_ID]: TENANT_ID_NOT_A_UUID });
    // A tenant id containing `:` is the specific shape `.claude/rules/tenant-isolation.md`
    // names: it would make another service's `<prefix>:<tenantId>:<key>` derivation ambiguous.
    // Non-empty is therefore not good enough, which is what separates this case from BU77a.
    const withColon = await inject({ [BILLING_HEADERS.TENANT_ID]: TENANT_ID_WITH_COLON });

    for (const response of [notAUuid, withColon]) {
      expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      expect(response.json()).toMatchObject({
        code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_INVALID,
        message: BILLING_RESPONSES.MESSAGE_TENANT_CONTEXT_INVALID
      });
    }

    // The distinct code is the assertion that matters: both cases are 401, so a status-only
    // test would pass with one error class doing both jobs.
    expect(notAUuid.json()).not.toMatchObject({
      code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });
  });

  it("BU77d - rejects a duplicated X-Tenant-Id with 401 TENANT_CONTEXT_INVALID, preferring neither value", async () => {
    // Header smuggling: a caller that got a second `X-Tenant-Id` past the gateway must not be
    // able to make this hook pick one. Added at T-046's Gate 3 rework (review LOW-2).
    //
    // **The mechanism is not the one the docblock used to name.** Re-measured here at
    // fastify 5.10.0 / Node 22.22.2, four forms, all returning `typeof header === "string"` and
    // never an array:
    //
    //   app.inject, array value    -> "<A>,<B>"     (joined, no space)
    //   app.inject, pre-joined     -> "<A>,<B>"
    //   real socket, 2 header lines-> "<A>, <B>"    (joined by Node's parser, comma + space)
    //   real socket, 3 header lines-> "<A>, <B>, <A>"
    //
    // So the hook's `typeof header !== "string"` arm is not what rejects this -- that arm is
    // reached by an *absent* header (`undefined`), which is BU77a's missing case. What rejects
    // a duplicate is `tenantIdSchema`, because neither joined form is a UUID. The outcome is
    // safe either way; the recorded reason was wrong and is corrected in the middleware
    // docblock. Both separators are asserted below, since the transport decides which one
    // appears and only one of them is reachable from `app.inject`.
    const injectedJoin = await inject({
      [BILLING_HEADERS.TENANT_ID]: [TENANT_ID_VALID, TENANT_ID_VALID_SECOND]
    } as unknown as Record<string, string>);
    const socketJoin = await inject({
      [BILLING_HEADERS.TENANT_ID]: `${TENANT_ID_VALID}, ${TENANT_ID_VALID_SECOND}`
    });

    for (const response of [injectedJoin, socketJoin]) {
      expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      expect(response.json()).toMatchObject({
        code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_INVALID
      });
      // The load-bearing half. A hook that took the first value would answer 200 with
      // `{ tenantId: <A> }`; one that took the last would answer 200 with `{ tenantId: <B> }`.
      // Asserting the 401 alone would not tell those apart from a rejection.
      const body = JSON.stringify(response.json());
      expect(body).not.toContain(TENANT_ID_VALID);
      expect(body).not.toContain(TENANT_ID_VALID_SECOND);
    }
  });
});
