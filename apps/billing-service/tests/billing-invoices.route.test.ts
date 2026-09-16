import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { InvoiceStatus } from "@prisma/client";
import { buildBillingServiceApp } from "../src/app";
import { env } from "../src/config/env";
import type { InvoiceService } from "../src/services/invoice.service";
import {
  BILLING_HEADERS,
  BILLING_INVOICE_LIST,
  BILLING_RESPONSES,
  BILLING_ROUTES,
  BILLING_SERVICE_NAME
} from "../src/constants";

const TENANT_ID = "0450a5e0-0000-4000-8000-0000000000aa";
const TENANT_ID_NOT_A_UUID = "abc";
const WRONG_SECRET = "not-the-secret";
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_STATUS = "BOGUS";
const CURRENCY_USD = "USD";
const QUERY_KEY_STATUS = "status";
const QUERY_KEY_PAGE_SIZE = "pageSize";
const INVOICE_HEADER_FIELDS = [
  "createdAt",
  "currency",
  "finalizedAt",
  "id",
  "periodEnd",
  "periodStart",
  "status",
  "totalAmount"
] as const;

const invoiceHeader = () => ({
  id: INVOICE_ID,
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-02-01T00:00:00.000Z",
  status: InvoiceStatus.DRAFT,
  totalAmount: "12.5",
  currency: CURRENCY_USD,
  createdAt: "2026-02-02T00:00:00.000Z",
  finalizedAt: null
});

const page = (items: ReturnType<typeof invoiceHeader>[]) => ({
  items,
  total: items.length,
  page: BILLING_INVOICE_LIST.DEFAULT_PAGE,
  pageSize: BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE
});

const authorizedHeaders = (): Record<string, string> => ({
  [BILLING_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET,
  [BILLING_HEADERS.TENANT_ID]: TENANT_ID
});

/**
 * Route-level contract for `GET /v1/billing/invoices`.
 *
 * The service layer is stubbed on the real container, exactly as
 * `internal-billing.route.test.ts` does, so these cases are about wiring -- hook phase and
 * order, scope encapsulation, status mapping and the response envelope -- and not about
 * pagination or isolation, which the repository and integration suites own. The app touches
 * neither Postgres nor Redis: the container's ioredis client is `lazyConnect`, nothing calls
 * `connect()`, and every reachable handler is intercepted before a query.
 */
describe(`GET ${BILLING_ROUTES.INVOICES}`, () => {
  let app: ReturnType<typeof buildBillingServiceApp>;
  let listInvoices: MockInstance<InvoiceService["listInvoices"]>;

  beforeEach(() => {
    app = buildBillingServiceApp();
    listInvoices = vi
      .spyOn(app.container.invoiceService, "listInvoices")
      .mockResolvedValue(page([invoiceHeader()]));
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  const get = (headers: Record<string, string>, query = "") =>
    app.inject({ method: "GET", url: `${BILLING_ROUTES.INVOICES}${query}`, headers });

  it("BU78 - rejects a request with no X-Internal-Secret with 401 and never reaches the service", async () => {
    const response = await get({ [BILLING_HEADERS.TENANT_ID]: TENANT_ID });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
    // The observable form of "the route is inside the guarded scope". Moving
    // `registerBillingRoutes` out of the `app.register` callback makes this a 200.
    expect(listInvoices).not.toHaveBeenCalled();
  });

  it("BU79 - runs internal-auth before tenant context, observed by which code a doubly-invalid request gets", async () => {
    // A request that fails *both* checks. This is the only shape that observes the order:
    // a request failing only the secret check answers 401 UNAUTHORIZED under either hook
    // order, so a status-only assertion -- and even a code assertion on that request -- is
    // vacuous here. Swapping the two `addHook` calls turns this into TENANT_CONTEXT_MISSING,
    // which is tenant context being derived for a caller that has not proved it is the
    // gateway: the ordering `.claude/rules/tenant-isolation.md` § *Forbidden* names.
    const neither = await get({});

    expect(neither.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(neither.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
    expect(neither.json()).not.toMatchObject({
      code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });

    // Same request with a malformed rather than absent tenant, so the swap is caught whichever
    // tenant-context branch the mutation happens to take.
    const badSecretBadTenant = await get({
      [BILLING_HEADERS.INTERNAL_SECRET]: WRONG_SECRET,
      [BILLING_HEADERS.TENANT_ID]: TENANT_ID_NOT_A_UUID
    });

    expect(badSecretBadTenant.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_UNAUTHORIZED
    });

    // And once the caller *has* proved itself, the tenant check still runs -- so the guard is
    // ordered ahead of it, not instead of it.
    const authedBadTenant = await get({
      [BILLING_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET,
      [BILLING_HEADERS.TENANT_ID]: TENANT_ID_NOT_A_UUID
    });

    expect(authedBadTenant.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(authedBadTenant.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_INVALID
    });
    expect(listInvoices).not.toHaveBeenCalled();
  });

  it("BU80 - answers 200 with the PaginatedResult envelope for an authenticated, tenant-scoped request", async () => {
    const response = await get(authorizedHeaders());

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toEqual({ data: page([invoiceHeader()]) });
    // The tenant reaching the service is the one the middleware validated off the header, and
    // the defaults are the validator's, not the controller's.
    expect(listInvoices).toHaveBeenCalledWith(TENANT_ID, {
      page: BILLING_INVOICE_LIST.DEFAULT_PAGE,
      pageSize: BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE
    });
  });

  it("BU81 - forwards the status filter and answers 400 VALIDATION_ERROR for an unknown one", async () => {
    const filtered = await get(
      authorizedHeaders(),
      `?${QUERY_KEY_STATUS}=${InvoiceStatus.FINALIZED}`
    );

    expect(filtered.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(listInvoices).toHaveBeenCalledWith(TENANT_ID, {
      status: InvoiceStatus.FINALIZED,
      page: BILLING_INVOICE_LIST.DEFAULT_PAGE,
      pageSize: BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE
    });

    listInvoices.mockClear();
    const unknown = await get(authorizedHeaders(), `?${QUERY_KEY_STATUS}=${UNKNOWN_STATUS}`);

    // 400 rather than the 500 Prisma would produce: an unknown enum member raises
    // `PrismaClientValidationError`, which the global error handler has no mapping for.
    expect(unknown.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(unknown.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_VALIDATION_ERROR
    });
    expect(listInvoices).not.toHaveBeenCalled();

    // LOW-3: AC3's `pageSize > MAX_PAGE_SIZE` bound was pinned at schema level by BU73 and at
    // no other level -- BI16 only ever sends `pageSize` 1 and 2 -- so nothing asserted that the
    // bound survives the route wiring. It does.
    //
    // **Reject rather than clamp is the plan's choice, not the epic's.**
    // `docs/epics/epic-8-billing-service.md:92` says only `// default 20, max 100` and does not
    // say which. Recorded here so a later reader does not take the behaviour for a requirement.
    listInvoices.mockClear();
    const overMax = await get(
      authorizedHeaders(),
      `?${QUERY_KEY_PAGE_SIZE}=${BILLING_INVOICE_LIST.MAX_PAGE_SIZE + 1}`
    );

    expect(overMax.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(overMax.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_VALIDATION_ERROR
    });
    expect(listInvoices).not.toHaveBeenCalled();
  });

  it("BU82 - response items carry exactly the eight InvoiceHeader fields and no lineItems", async () => {
    const response = await get(authorizedHeaders());
    const body = response.json() as { data: { items: Record<string, unknown>[] } };
    const [item] = body.data.items;

    expect(Object.keys(item ?? {}).sort()).toEqual([...INVOICE_HEADER_FIELDS]);
    expect(item).not.toHaveProperty("lineItems");
    expect(item).not.toHaveProperty("tenantId");
    // Note what this case can and cannot see. An extra field is visible on the wire; a
    // `Prisma.Decimal` is *not*, because it defines `toJSON` and serialises to the same JSON
    // string as the normalised value. `BU75` in `invoice.repository.unit.test.ts` is the case
    // that catches a Decimal leak, and it has to sit below this boundary to do it.
    expect(typeof item?.totalAmount).toBe("string");
  });

  it("BU83 - leaves /health and the internal metering route outside the new hooks", async () => {
    // Both carry neither an X-Tenant-Id nor (for /health) a secret. If the new hooks had been
    // added to the root instance instead of the encapsulated scope, /health would 401.
    const health = await app.inject({ method: "GET", url: BILLING_ROUTES.HEALTH });

    expect(health.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(health.json()).toMatchObject({
      status: BILLING_RESPONSES.STATUS_OK,
      service: BILLING_SERVICE_NAME
    });

    // The internal route still answers on its own guard alone -- a secret and no tenant header.
    // A tenant-context hook leaking into that scope would turn T-045's contract into a 401.
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
