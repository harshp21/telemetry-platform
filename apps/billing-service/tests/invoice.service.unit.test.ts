import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceStatus } from "@prisma/client";
import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import { InvoiceService } from "../src/services/invoice.service";
import type { InvoiceRepository } from "../src/repositories/invoice.repository";
import type { InvoiceRepositoryFactory } from "../src/services/billing.service";
import type { InvoiceListQuery } from "../src/validators/invoice-list.validator";
import { BILLING_INVOICE_LIST } from "../src/constants";

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
