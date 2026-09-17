import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { InvoiceStatus } from "@prisma/client";
import { buildBillingServiceApp } from "../src/app";
import { env } from "../src/config/env";
import type { InvoiceService } from "../src/services/invoice.service";
import {
  BILLING_HEADERS,
  BILLING_RESPONSES,
  BILLING_ROUTES,
  BILLING_SERVICE_NAME
} from "../src/constants";
import { INTEGRATION_INVOICE_DETAIL } from "./integration.constants";

/**
 * Route-level contract for `GET /v1/billing/invoices/:id` (T-047).
 *
 * The service layer is stubbed on the real container, exactly as `billing-invoices.route.test.ts`
 * does, so these cases are about wiring -- hook phase and order, scope encapsulation, param
 * validation and the response envelope. Isolation and ordering belong to the repository and
 * integration suites. The app touches neither Postgres nor Redis: the container's ioredis client
 * is `lazyConnect`, nothing calls `connect()`, and every reachable handler is intercepted before
 * a query.
 */
const TENANT_ID = "0450a5e0-0000-4000-8000-0000000000aa";
const TENANT_ID_NOT_A_UUID = "abc";
const WRONG_SECRET = "not-the-secret";
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";
const INVOICE_ID_NOT_A_UUID = "not-a-uuid";
const LINE_ITEM_ID = "55555555-5555-4555-8555-555555555551";
const METRIC_API = "api.request";
const CURRENCY_USD = "USD";
const LINE_QUANTITY = "1000";
const LINE_UNIT_PRICE = "0.01";
const LINE_AMOUNT = "10";
// One spelling of each list, in `tests/integration.constants.ts` beside the fixture vocabulary
// -- see `INTEGRATION_INVOICE_DETAIL.LINE_ITEM_FIELDS` for why they are written out rather than
// derived from the production `select`.
const RESPONSE_KEYS = INTEGRATION_INVOICE_DETAIL.DETAIL_RESPONSE_FIELDS;
const LINE_ITEM_KEYS = INTEGRATION_INVOICE_DETAIL.LINE_ITEM_FIELDS;

const invoiceDetail = () => ({
  id: INVOICE_ID,
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-02-01T00:00:00.000Z",
  status: InvoiceStatus.DRAFT,
  totalAmount: "12.5",
  currency: CURRENCY_USD,
  createdAt: "2026-02-02T00:00:00.000Z",
  finalizedAt: null,
  lineItems: [
    {
      id: LINE_ITEM_ID,
      metricKey: METRIC_API,
      quantity: LINE_QUANTITY,
      unitPrice: LINE_UNIT_PRICE,
      amount: LINE_AMOUNT
    }
  ]
});

const authorizedHeaders = (): Record<string, string> => ({
  [BILLING_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET,
  [BILLING_HEADERS.TENANT_ID]: TENANT_ID
});

describe(`GET ${BILLING_ROUTES.INVOICE_DETAIL}`, () => {
  let app: ReturnType<typeof buildBillingServiceApp>;
  let getInvoice: MockInstance<InvoiceService["getInvoice"]>;

  beforeEach(() => {
    app = buildBillingServiceApp();
    getInvoice = vi
      .spyOn(app.container.invoiceService, "getInvoice")
      .mockResolvedValue(invoiceDetail());
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  /** The concrete path, derived from the collection constant rather than re-typed. */
  const detailUrl = (id: string) => `${BILLING_ROUTES.INVOICES}/${id}`;

  const get = (headers: Record<string, string>, id: string = INVOICE_ID) =>
    app.inject({ method: "GET", url: detailUrl(id), headers });

  it("BU115 - rejects a request with no X-Internal-Secret with 401 and never reaches the service", async () => {
    const response = await get({ [BILLING_HEADERS.TENANT_ID]: TENANT_ID });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
    // The observable form of "the route is inside the guarded scope". Measured at the Gate 3
    // rework by performing exactly that mutation -- `scope.get(BILLING_ROUTES.INVOICE_DETAIL,
    // ...)` deleted from `registerBillingRoutes` and re-registered as `app.get(...)` on the root
    // instance -- and running this file: `Tests 4 failed | 2 passed (6)`, BU115 and BU116
    // `expected 400 to be 401`, BU117 `expected 400 to be 200`, BU119
    // `TypeError: Cannot convert undefined or null to object`.
    //
    // So the unscoped route answers **400**, not a 200, and carries no invoice: the response
    // body captured through `app.inject` under that mutation is
    // `{"code":"VALIDATION_ERROR","message":"Missing tenantId from context"}`, because
    // `billing.controller.ts`'s own `if (!tenantId)` guard fires before the service is reached.
    // T-046's Gate 4 made the same correction about its own scope mutation on the list route.
    //
    // The case is therefore sound and the property it guards is "unauthenticated
    // reachability", not "an invoice on the wire" -- which is why this last assertion, not the
    // status one, is what makes it so.
    expect(getInvoice).not.toHaveBeenCalled();
  });

  it("BU116 - runs internal-auth before tenant context, observed by which code a doubly-invalid request gets", async () => {
    // The `BU79` shape. A request failing *only* the secret check answers 401 UNAUTHORIZED
    // under either hook order, so only a doubly-invalid request observes the order.
    const neither = await get({});

    expect(neither.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(neither.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
    expect(neither.json()).not.toMatchObject({
      code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });

    const badSecretBadTenant = await get({
      [BILLING_HEADERS.INTERNAL_SECRET]: WRONG_SECRET,
      [BILLING_HEADERS.TENANT_ID]: TENANT_ID_NOT_A_UUID
    });
    expect(badSecretBadTenant.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_UNAUTHORIZED
    });

    // And once the caller has proved itself, tenant context still runs -- so the guard is
    // ordered ahead of it, not instead of it.
    const authedBadTenant = await get({
      [BILLING_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET,
      [BILLING_HEADERS.TENANT_ID]: TENANT_ID_NOT_A_UUID
    });
    expect(authedBadTenant.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(authedBadTenant.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_INVALID
    });
    expect(getInvoice).not.toHaveBeenCalled();
  });

  it("BU117 - answers 200 { data } and calls the service with the validated tenant and the parsed id", async () => {
    const response = await get(authorizedHeaders());

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toEqual({ data: invoiceDetail() });
    // The tenant is the one the middleware validated off the header; the id is the one the
    // param validator parsed. Neither is read raw off the request by the controller.
    expect(getInvoice).toHaveBeenCalledWith(TENANT_ID, { id: INVOICE_ID });
  });

  it("BU118 - a malformed :id is 400 VALIDATION_ERROR and never reaches the service", async () => {
    const response = await get(authorizedHeaders(), INVOICE_ID_NOT_A_UUID);

    // 400, not 404 (D4): the request is malformed rather than pointed at a missing resource,
    // and a non-UUID cannot be any tenant's invoice id, so refusing it leaks nothing a 404
    // would hide. Rejecting before the service means no repository is constructed either.
    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(response.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_VALIDATION_ERROR
    });
    expect(response.statusCode).not.toBe(BILLING_RESPONSES.HTTP_STATUS_NOT_FOUND);
    expect(getInvoice).not.toHaveBeenCalled();
  });

  it("BU119 - the response carries exactly the eight header fields plus lineItems, each line item five keys", async () => {
    const response = await get(authorizedHeaders());
    const body = response.json() as { data: Record<string, unknown> };

    expect(Object.keys(body.data).sort()).toEqual([...RESPONSE_KEYS]);
    expect(body.data).not.toHaveProperty("tenantId");

    const lineItems = body.data.lineItems as Record<string, unknown>[];
    expect(lineItems).toHaveLength(1);
    for (const item of lineItems) {
      expect(Object.keys(item).sort()).toEqual([...LINE_ITEM_KEYS]);
      // `invoiceId` is the parent's `id` repeated on every row.
      expect(item).not.toHaveProperty("invoiceId");
      expect(typeof item.amount).toBe("string");
    }

    // **This last assertion cannot see a Decimal leak, and that is why BI33 exists.**
    // Measured at Gate 1: `Prisma.Decimal` defines `toJSON`, so the JSON of an un-normalised
    // row and of a normalised one are byte-identical -- `typeof` on the parsed value is
    // `"string"` either way. The catching assertion has to sit below this boundary. `BU75`
    // is T-046's precedent for the same limit on `totalAmount`.
    expect(typeof body.data.totalAmount).toBe("string");
  });

  it("BU120 - leaves /health and the internal metering route outside the new route's hooks", async () => {
    // The `BU83` shape, repeated for this route: if registering the detail route had dragged
    // the hooks onto the root instance, /health would answer 401.
    //
    // **This case is a co-regression with `BU83`, not evidence about the detail route.** Both
    // observe the hook topology of one `buildBillingServiceApp()`, so no mutation can redden
    // one without the other -- the Gate 4 reviewer could not construct one, and neither could
    // this rework. Measured at the Gate 3 rework, the mutation that reddens it (hooks moved to
    // the root instance: `app.addHook(...)` twice plus `registerBillingRoutes(app, ...)`) takes
    // the **whole billing package** to `26 failed | 181 passed (207)` across 6 files -- BU83
    // and BU120 among them, plus BU65-BU69, the env-schema and smoke suites and 14 integration
    // cases. It is **not** "BU120 alone"; an earlier Gate 3 hand-off said so and was wrong.
    //
    // Kept anyway, deliberately: the property is one `app.inject` pair, and each route suite
    // should still assert it after the other suite is split, renamed or retired. Do not cite it
    // as a guard specific to `GET /v1/billing/invoices/:id` -- BU115 is that guard.
    const health = await app.inject({ method: "GET", url: BILLING_ROUTES.HEALTH });

    expect(health.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(health.json()).toMatchObject({
      status: BILLING_RESPONSES.STATUS_OK,
      service: BILLING_SERVICE_NAME
    });

    // The internal route still answers on its own guard alone -- a secret and no tenant header.
    const internal = await app.inject({
      method: "POST",
      url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
      headers: { [BILLING_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET },
      payload: {}
    });

    expect(internal.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(internal.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_VALIDATION_ERROR
    });
  });
});
