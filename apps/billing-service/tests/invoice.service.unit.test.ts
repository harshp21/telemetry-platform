import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceStatus } from "@prisma/client";
import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import { InvoiceService } from "../src/services/invoice.service";
import { InvoiceNotFoundError } from "../src/errors";
import type { InvoiceRepository } from "../src/repositories/invoice.repository";
import type { InvoiceRepositoryFactory } from "../src/services/billing.service";
import type { InvoiceListQuery } from "../src/validators/invoice-list.validator";
import { BILLING_INVOICE_LIST, BILLING_RESPONSES } from "../src/constants";

const TENANT_ID = "11111111-1111-4111-8111-111111111111" as TenantId;
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222" as TenantId;
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_TWO = 2;
const PAGE_SIZE_FIVE = 5;
const TOTAL_ROWS = 12;
const CURRENCY_USD = "USD";

const defaultQuery: InvoiceListQuery = {
  page: BILLING_INVOICE_LIST.DEFAULT_PAGE,
  pageSize: BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE
};

const header = () => ({
  id: INVOICE_ID,
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-02-01T00:00:00.000Z",
  status: InvoiceStatus.DRAFT,
  totalAmount: "12.5",
  currency: CURRENCY_USD,
  createdAt: "2026-02-02T00:00:00.000Z",
  finalizedAt: null
});

describe("InvoiceService.listInvoices", () => {
  let listInvoices: ReturnType<typeof vi.fn>;
  let createRepository: ReturnType<typeof vi.fn>;
  let service: InvoiceService;

  beforeEach(() => {
    listInvoices = vi.fn().mockResolvedValue({ items: [], total: 0 });
    createRepository = vi.fn(() => ({ listInvoices }) as unknown as InvoiceRepository);
    const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    service = new InvoiceService(
      createRepository as unknown as InvoiceRepositoryFactory,
      logger as unknown as Logger
    );
  });

  it("BU84 - an empty page is items: [] with total: 0, never null and never an error", async () => {
    const result = await service.listInvoices(TENANT_ID, defaultQuery);

    // A tenant with no invoices is a successful empty list, not a 404. The tenant id came from
    // a gateway-verified JWT, so "no rows" carries no information about whether it exists.
    expect(result).toEqual({
      items: [],
      total: 0,
      page: BILLING_INVOICE_LIST.DEFAULT_PAGE,
      pageSize: BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE
    });
  });

  it("BU85 - builds a repository bound to the requesting tenant, once per call", async () => {
    await service.listInvoices(TENANT_ID, defaultQuery);

    expect(createRepository).toHaveBeenCalledTimes(1);
    expect(createRepository).toHaveBeenCalledWith(TENANT_ID);
    // Negative: no other tenant reaches the factory or the repository call.
    expect(JSON.stringify(createRepository.mock.calls)).not.toContain(OTHER_TENANT_ID);
    expect(JSON.stringify(listInvoices.mock.calls)).not.toContain(OTHER_TENANT_ID);
  });

  it("BU86 - passes the validated query through and echoes the effective page and pageSize", async () => {
    listInvoices.mockResolvedValueOnce({ items: [header()], total: TOTAL_ROWS });

    const result = await service.listInvoices(TENANT_ID, {
      status: InvoiceStatus.PAID,
      page: PAGE_TWO,
      pageSize: PAGE_SIZE_FIVE
    });

    // The validator has already applied defaults and bounds, so this layer performs no
    // pagination arithmetic -- it echoes what it was given. A `skip` computed twice, here and
    // in the repository, would page twice as far.
    expect(listInvoices).toHaveBeenCalledWith({
      status: InvoiceStatus.PAID,
      page: PAGE_TWO,
      pageSize: PAGE_SIZE_FIVE
    });
    expect(result).toEqual({
      items: [header()],
      total: TOTAL_ROWS,
      page: PAGE_TWO,
      pageSize: PAGE_SIZE_FIVE
    });
  });

  it("BU87 - propagates a repository failure unchanged for the controller to normalise", async () => {
    const failure = new Error("connection reset");
    listInvoices.mockRejectedValueOnce(failure);

    await expect(service.listInvoices(TENANT_ID, defaultQuery)).rejects.toBe(failure);
  });
});

/** T-047: one invoice, its five-field line items, already normalised out of Decimal and Date. */
const LINE_ITEM_ID = "55555555-5555-4555-8555-555555555551";
const METRIC_API = "api.request";
const LINE_QUANTITY = "1000";
const LINE_UNIT_PRICE = "0.01";
const LINE_AMOUNT = "10";

const detail = () => ({
  ...header(),
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

describe("InvoiceService.getInvoice", () => {
  let findDetailById: ReturnType<typeof vi.fn>;
  let createRepository: ReturnType<typeof vi.fn>;
  let service: InvoiceService;

  beforeEach(() => {
    findDetailById = vi.fn().mockResolvedValue(detail());
    createRepository = vi.fn(() => ({ findDetailById }) as unknown as InvoiceRepository);
    const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    service = new InvoiceService(
      createRepository as unknown as InvoiceRepositoryFactory,
      logger as unknown as Logger
    );
  });

  it("BU112 - builds the repository through the injected factory with the requesting tenant and returns the detail unchanged", async () => {
    const result = await service.getInvoice(TENANT_ID, { id: INVOICE_ID });

    // The factory, not a repository the service constructs itself: `tenantId` is a constructor
    // argument of `TenantScopedRepository`, so a singleton would pin one tenant process-wide
    // (`.claude/rules/tenant-isolation.md`).
    expect(createRepository).toHaveBeenCalledTimes(1);
    expect(createRepository).toHaveBeenCalledWith(TENANT_ID);
    expect(findDetailById).toHaveBeenCalledWith(INVOICE_ID);
    // The repository already normalised everything; this layer adds no shaping of its own, so
    // a field appearing or disappearing here would be a change nobody asked for.
    expect(result).toEqual(detail());

    // Negative: no other tenant reaches the factory or the repository call. The invoice id is
    // caller-supplied and the tenant is not -- that asymmetry is the whole design.
    expect(JSON.stringify(createRepository.mock.calls)).not.toContain(OTHER_TENANT_ID);
    expect(JSON.stringify(findDetailById.mock.calls)).not.toContain(OTHER_TENANT_ID);
  });

  it("BU113 - a null from the repository becomes InvoiceNotFoundError, 404 INVOICE_NOT_FOUND", async () => {
    findDetailById.mockResolvedValueOnce(null);

    await expect(service.getInvoice(TENANT_ID, { id: INVOICE_ID })).rejects.toBeInstanceOf(
      InvoiceNotFoundError
    );

    findDetailById.mockResolvedValueOnce(null);
    const error = await service.getInvoice(TENANT_ID, { id: INVOICE_ID }).catch((e: unknown) => e);

    // D3: the repository cannot distinguish "no such invoice" from "another tenant's invoice"
    // -- its read carries the tenant predicate and runs under an RLS context, so both are
    // `null`. One error for both is therefore not a simplification, it is the only thing the
    // data supports; `BI29` pins that the two responses are byte-identical.
    expect((error as InvoiceNotFoundError).statusCode).toBe(
      BILLING_RESPONSES.HTTP_STATUS_NOT_FOUND
    );
    expect((error as InvoiceNotFoundError).code).toBe(BILLING_RESPONSES.CODE_INVOICE_NOT_FOUND);
    expect((error as InvoiceNotFoundError).message).toBe(
      BILLING_RESPONSES.MESSAGE_INVOICE_NOT_FOUND
    );
  });

  it("BU114 - a repository rejection propagates unchanged for the controller to normalise", async () => {
    const failure = new Error("connection reset");
    findDetailById.mockRejectedValueOnce(failure);

    // Identical, not merely equal: the controller owns the mapping to a status, and a service
    // that wrapped this would turn an infrastructure failure into a `404`.
    await expect(service.getInvoice(TENANT_ID, { id: INVOICE_ID })).rejects.toBe(failure);
  });
});
