import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { TenantId } from "@telemetry/shared-types";
import { buildBillingServiceApp } from "../src/app";
import { env } from "../src/config/env";
import { MeterNotFoundError } from "../src/errors";
import type { BillingService } from "../src/services/billing.service";
import {
  BILLING_HEADERS,
  BILLING_RESPONSES,
  BILLING_ROUTES,
  BILLING_SERVICE_NAME
} from "../src/constants";

const TENANT_ID_A = "11111111-1111-4111-8111-111111111111" as TenantId;
const TENANT_ID_B = "22222222-2222-4222-8222-222222222222" as TenantId;
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";
const METRIC_STORAGE = "storage.gb";

const validBody = {
  tenantId: TENANT_ID_A,
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-02-01T00:00:00.000Z"
} as const;

const authorizedHeaders = (): Record<string, string> => ({
  [BILLING_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET
});

/**
 * Route-level contract for `POST /v1/internal/billing/generate`.
 *
 * The service layer is stubbed on the real container, so these cases are about the wiring --
 * guard ordering, route scoping, status mapping and the response envelope -- and not about
 * invoice arithmetic, which `billing.service.unit.test.ts` owns. The app touches neither
 * Postgres nor Redis: the container's ioredis client is `lazyConnect`, nothing calls
 * `connect()`, and every reachable handler here is intercepted before a query.
 */
describe(`POST ${BILLING_ROUTES.INTERNAL_BILLING_GENERATE}`, () => {
  let app: ReturnType<typeof buildBillingServiceApp>;
  let generateInvoice: MockInstance<BillingService["generateInvoice"]>;

  beforeEach(() => {
    app = buildBillingServiceApp();
    generateInvoice = vi
      .spyOn(app.container.billingService, "generateInvoice")
      .mockResolvedValue({ invoiceId: INVOICE_ID, created: true, absorbed: false });
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("BU61 - rejects a request with no X-Internal-Secret with 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      payload: validBody
    });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
  });

  it("BU62 - an unauthenticated request never reaches the billing service", async () => {
    // The observable form of "the handler did not run". The guard is a `preHandler` that does
    // not `return` its `reply.send(...)`, so this is the assertion that the short-circuit is
    // real rather than relying on Fastify's `reply.sent` check by inspection (S-8 item 3).
    await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      payload: validBody
    });

    expect(generateInvoice).not.toHaveBeenCalled();
  });

  it("BU63 - the container exposes repository factories, not shared singletons", async () => {
    const meterA = app.container.meterRepositoryFactory(TENANT_ID_A);
    const meterB = app.container.meterRepositoryFactory(TENANT_ID_B);
    const invoiceA = app.container.invoiceRepositoryFactory(TENANT_ID_A);
    const invoiceB = app.container.invoiceRepositoryFactory(TENANT_ID_B);

    // A singleton would pin one tenant process-wide, because `tenantId` is a constructor
    // argument of `TenantScopedRepository` (`.claude/rules/tenant-isolation.md`).
    expect(meterA).not.toBe(meterB);
    expect(invoiceA).not.toBe(invoiceB);
    expect(app.container.meterRepositoryFactory(TENANT_ID_A)).not.toBe(meterA);
  });

  it("BU64 - rejects a wrong secret with 401 and a body identical to the missing-secret case", async () => {
    const missing = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      payload: validBody
    });
    const wrong = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: { [BILLING_HEADERS.INTERNAL_SECRET]: "not-the-secret" },
      payload: validBody
    });

    expect(wrong.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(wrong.body).toBe(missing.body);
  });

  it("BU65 - answers 201 with the data envelope for an authenticated, valid request", async () => {
    const response = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: authorizedHeaders(),
      payload: validBody
    });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_CREATED);
    expect(response.json()).toEqual({ data: { invoiceId: INVOICE_ID, absorbed: false } });
    expect(generateInvoice).toHaveBeenCalledWith({
      tenantId: TENANT_ID_A,
      periodStart: validBody.periodStart,
      periodEnd: validBody.periodEnd
    });
  });

  it("BU66 - answers 200 for an idempotent hit and for no billable usage", async () => {
    generateInvoice.mockResolvedValueOnce({
      invoiceId: INVOICE_ID,
      created: false,
      absorbed: false
    });
    const idempotent = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: authorizedHeaders(),
      payload: validBody
    });

    generateInvoice.mockResolvedValueOnce({
      invoiceId: null,
      created: false,
      absorbed: false
    });
    const noUsage = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: authorizedHeaders(),
      payload: validBody
    });

    expect(idempotent.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(idempotent.json()).toEqual({ data: { invoiceId: INVOICE_ID, absorbed: false } });
    expect(noUsage.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(noUsage.json()).toEqual({ data: { invoiceId: null, absorbed: false } });
  });

  it("BU67 - answers 400 VALIDATION_ERROR for an authenticated request with an invalid body", async () => {
    const response = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: authorizedHeaders(),
      payload: { ...validBody, periodEnd: validBody.periodStart }
    });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(response.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_VALIDATION_ERROR });
    expect(generateInvoice).not.toHaveBeenCalled();
  });

  it("BU68 - surfaces a 422 METER_NOT_FOUND through the route", async () => {
    generateInvoice.mockRejectedValueOnce(new MeterNotFoundError([METRIC_STORAGE]));

    const response = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: authorizedHeaders(),
      payload: validBody
    });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNPROCESSABLE_ENTITY);
    expect(response.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_METER_NOT_FOUND
    });
  });

  it("BU69 - leaves /health outside the guarded scope", async () => {
    const response = await app.inject({ method: "GET", url: BILLING_ROUTES.HEALTH });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toMatchObject({
      status: BILLING_RESPONSES.STATUS_OK,
      service: BILLING_SERVICE_NAME
    });
  });

  it("BU70 - no longer answers with the T-044 stub's accepted/workflow body", async () => {
    const response = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: authorizedHeaders(),
      payload: validBody
    });

    // The stub returned `{ status: "accepted", workflow: "billing-generation" }` and created
    // nothing. Pinned so the replacement cannot be reverted silently.
    const body = response.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("workflow");
  });

  // S-8 / AC5. **The guard runs before the body is parsed, and this is the case that notices if
  // it stops.**
  //
  // The guard was an `app.register`-scoped `preHandler`, which runs *after* fastify's
  // content-type parser. Measured against this real route with no credential at all, before the
  // promotion:
  //
  //   valid JSON body                -> 401 {"code":"UNAUTHORIZED"}
  //   well-formed, schema-invalid    -> 401 {"code":"UNAUTHORIZED"}
  //   malformed JSON                 -> 500 {"code":"INTERNAL_ERROR","message":"Body is not valid
  //                                         JSON but content-type is set to 'application/json'"}
  //
  // Two notes, because the plan predicted a third row that this route does not have. Body
  // validation here is the controller's `safeParse`, not a fastify route schema, so a
  // schema-invalid body never produces a `FST_ERR_VALIDATION` naming the failing field -- the
  // `preHandler` short-circuits first. What *did* leak was the malformed-JSON row, and it leaked
  // as a `500` rather than the `400 FST_ERR_CTP_INVALID_JSON_BODY` the lifecycle produces
  // unadorned, because `registerGlobalErrorHandler` maps the parser's failure and passes its
  // message through. So an unauthenticated caller could distinguish two states and read the body
  // parser's diagnostic off an endpoint it cannot call.
  //
  // At `onRequest` both rows collapse to `401`. **Moving the hook back to `preHandler` in
  // `src/app.ts` reddens this case** -- that is what it is for.
  it("BU71 - an unauthenticated caller cannot tell body shapes apart", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: { "content-type": "application/json" },
      payload: "{not json"
    });
    const valid = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(validBody)
    });
    const schemaInvalid = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ unrelated: true })
    });

    for (const response of [malformed, valid, schemaInvalid]) {
      expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      expect(response.json()).toEqual({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
    }

    // The bodies must be byte-identical too, not merely the same status: a difference anywhere in
    // the response is a signal, and the whole point is that the three are indistinguishable.
    expect(malformed.body).toBe(valid.body);
    expect(schemaInvalid.body).toBe(valid.body);
  });

  // The other half of BU71, and the reason BU71 is not satisfied by a service that simply
  // answers 401 to everything: with a valid credential, malformed JSON must still be diagnosed.
  // The guard moved earlier; it did not swallow the parser.
  it("BU72 - an authenticated caller still gets the body parser's diagnosis", async () => {
    const response = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: { ...authorizedHeaders(), "content-type": "application/json" },
      payload: "{not json"
    });

    expect(response.statusCode).not.toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(generateInvoice).not.toHaveBeenCalled();
  });
});
