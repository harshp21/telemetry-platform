import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import { BillingService } from "../src/services/billing.service";
import type { MeterRepository } from "../src/repositories/meter.repository";
import type { InvoiceRepository } from "../src/repositories/invoice.repository";
import {
  MeterCurrencyConflictError,
  MeterNotFoundError,
  TenantNotFoundError
} from "../src/errors";
import { BILLING_RESPONSES } from "../src/constants";

const TENANT_ID = "11111111-1111-4111-8111-111111111111" as TenantId;
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222" as TenantId;
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";

const PERIOD_START_ISO = "2026-01-01T00:00:00.000Z";
const PERIOD_END_ISO = "2026-02-01T00:00:00.000Z";
const PERIOD_START = new Date(PERIOD_START_ISO);
const PERIOD_END = new Date(PERIOD_END_ISO);

const METRIC_API = "api.request";
const METRIC_STORAGE = "storage.gb";
const CURRENCY_USD = "USD";
const CURRENCY_EUR = "EUR";

const USAGE_LINE_IDS = ["line-a", "line-b"] as const;

const request = {
  tenantId: TENANT_ID,
  periodStart: PERIOD_START_ISO,
  periodEnd: PERIOD_END_ISO
} as const;

interface HarnessOptions {
  tenantExists?: boolean;
  existingInvoiceId?: string | null;
  totals?: { metricKey: string; totalQuantity: string }[];
  usageLineIds?: readonly string[];
  meters?: { metricKey: string; unitPrice: string; currency: string }[];
  created?: boolean;
}

const buildHarness = (options: HarnessOptions = {}) => {
  const tenantExists = vi.fn(async () => options.tenantExists ?? true);
  const findByPeriod = vi.fn(async () => options.existingInvoiceId ?? null);
  const sumUnbilledByMetricKey = vi.fn(async () => ({
    totals: options.totals ?? [{ metricKey: METRIC_API, totalQuantity: "1000" }],
    usageLineIds: options.usageLineIds ?? [...USAGE_LINE_IDS]
  }));
  const createDraftInvoice = vi.fn(async () => ({
    invoiceId: INVOICE_ID,
    created: options.created ?? true
  }));
  const findActiveAsOf = vi.fn(async () =>
    options.meters ?? [{ metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_USD }]
  );

  const invoiceRepository = {
    tenantExists,
    findByPeriod,
    sumUnbilledByMetricKey,
    createDraftInvoice
  } as unknown as InvoiceRepository;
  const meterRepository = { findActiveAsOf } as unknown as MeterRepository;

  const createMeterRepository = vi.fn(() => meterRepository);
  const createInvoiceRepository = vi.fn(() => invoiceRepository);
  const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };

  return {
    service: new BillingService(
      createMeterRepository,
      createInvoiceRepository,
      logger as unknown as Logger
    ),
    createMeterRepository,
    createInvoiceRepository,
    tenantExists,
    findByPeriod,
    sumUnbilledByMetricKey,
    findActiveAsOf,
    createDraftInvoice
  };
};

/** Throws rather than passing vacuously when the write was never issued. */
const draftInput = (createDraftInvoice: ReturnType<typeof vi.fn>) => {
  const call = createDraftInvoice.mock.calls[0];
  if (!call) {
    throw new Error("Expected createDraftInvoice to have been called");
  }
  return call[0] as {
    periodStart: Date;
    periodEnd: Date;
    currency: string;
    totalAmount: string;
    lineItems: { metricKey: string; quantity: string; unitPrice: string; amount: string }[];
    usageLineIds: string[];
  };
};

describe("BillingService.generateInvoice", () => {
  let harness: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    harness = buildHarness();
  });

  it("BU31 - returns the new invoice id marked as created on the happy path", async () => {
    await expect(harness.service.generateInvoice(request)).resolves.toEqual({
      invoiceId: INVOICE_ID,
      created: true
    });
  });

  it("BU32 - resolves both repositories from the factories, bound to the request's tenant", async () => {
    await harness.service.generateInvoice(request);

    expect(harness.createInvoiceRepository).toHaveBeenCalledWith(TENANT_ID);
    expect(harness.createMeterRepository).toHaveBeenCalledWith(TENANT_ID);
    expect(harness.createInvoiceRepository).not.toHaveBeenCalledWith(OTHER_TENANT_ID);
  });

  it("BU33 - throws TenantNotFoundError when the tenant is not visible", async () => {
    const absent = buildHarness({ tenantExists: false });

    const error = await absent.service.generateInvoice(request).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TenantNotFoundError);
    expect((error as TenantNotFoundError).statusCode).toBe(
      BILLING_RESPONSES.HTTP_STATUS_NOT_FOUND
    );
    expect((error as TenantNotFoundError).code).toBe(BILLING_RESPONSES.CODE_TENANT_NOT_FOUND);
  });

  it("BU34 - reads no usage, no meters and writes nothing for an unknown tenant", async () => {
    const absent = buildHarness({ tenantExists: false });

    await absent.service.generateInvoice(request).catch(() => undefined);

    expect(absent.findByPeriod).not.toHaveBeenCalled();
    expect(absent.sumUnbilledByMetricKey).not.toHaveBeenCalled();
    expect(absent.findActiveAsOf).not.toHaveBeenCalled();
    expect(absent.createDraftInvoice).not.toHaveBeenCalled();
  });

  it("BU35 - returns the existing invoice id, not marked created, when the period is already invoiced", async () => {
    const existing = buildHarness({ existingInvoiceId: INVOICE_ID });

    await expect(existing.service.generateInvoice(request)).resolves.toEqual({
      invoiceId: INVOICE_ID,
      created: false
    });
  });

  it("BU36 - the idempotent hit short-circuits before any usage or meter read", async () => {
    // Behaviour, not tidiness: without the early return the second call re-reads usage, finds
    // the lines the first call set `billed = true`, and answers `invoiceId: null` for a period
    // that has an invoice.
    const existing = buildHarness({ existingInvoiceId: INVOICE_ID });

    await existing.service.generateInvoice(request);

    expect(existing.sumUnbilledByMetricKey).not.toHaveBeenCalled();
    expect(existing.findActiveAsOf).not.toHaveBeenCalled();
    expect(existing.createDraftInvoice).not.toHaveBeenCalled();
  });

  it("BU37 - returns a null invoice id and writes nothing when there is no unbilled usage", async () => {
    const empty = buildHarness({ totals: [], usageLineIds: [] });

    await expect(empty.service.generateInvoice(request)).resolves.toEqual({
      invoiceId: null,
      created: false
    });
    expect(empty.findActiveAsOf).not.toHaveBeenCalled();
    expect(empty.createDraftInvoice).not.toHaveBeenCalled();
  });

  it("BU38 - looks up meters as of periodStart for exactly the keys that have usage", async () => {
    const twoMetrics = buildHarness({
      totals: [
        { metricKey: METRIC_API, totalQuantity: "1000" },
        { metricKey: METRIC_STORAGE, totalQuantity: "5" }
      ],
      meters: [
        { metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_USD },
        { metricKey: METRIC_STORAGE, unitPrice: "0.5", currency: CURRENCY_USD }
      ]
    });

    await twoMetrics.service.generateInvoice(request);

    expect(twoMetrics.findActiveAsOf).toHaveBeenCalledWith(
      [METRIC_API, METRIC_STORAGE],
      PERIOD_START
    );
  });

  it("BU39 - converts the request's ISO instants to Date bounds for every repository call", async () => {
    await harness.service.generateInvoice(request);

    expect(harness.findByPeriod).toHaveBeenCalledWith(PERIOD_START, PERIOD_END);
    expect(harness.sumUnbilledByMetricKey).toHaveBeenCalledWith(PERIOD_START, PERIOD_END);
    expect(draftInput(harness.createDraftInvoice).periodStart).toEqual(PERIOD_START);
    expect(draftInput(harness.createDraftInvoice).periodEnd).toEqual(PERIOD_END);
  });

  it("BU40 - throws MeterNotFoundError naming every unpriceable metric key", async () => {
    const unpriceable = buildHarness({
      totals: [
        { metricKey: METRIC_API, totalQuantity: "1000" },
        { metricKey: METRIC_STORAGE, totalQuantity: "5" }
      ],
      meters: [{ metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_USD }]
    });

    const error = await unpriceable.service.generateInvoice(request).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MeterNotFoundError);
    expect((error as MeterNotFoundError).metricKeys).toEqual([METRIC_STORAGE]);
    expect((error as MeterNotFoundError).statusCode).toBe(
      BILLING_RESPONSES.HTTP_STATUS_UNPROCESSABLE_ENTITY
    );
    expect((error as MeterNotFoundError).message).toContain(METRIC_STORAGE);
  });

  it("BU40b - names every unpriceable key, not just the first one it prices", async () => {
    // What separates the batch check from `meterFor`'s per-line raise. Measured: removing the
    // batch check alone leaves BU40 and BU41 green, because `meterFor` throws the same error
    // for the first key it cannot resolve -- so without this case the batch check would be
    // decoration. The operator's next action is to create the missing meters, and a refusal
    // that names one of two sends them round the loop twice.
    const unpriceable = buildHarness({
      totals: [
        { metricKey: METRIC_API, totalQuantity: "1000" },
        { metricKey: METRIC_STORAGE, totalQuantity: "5" }
      ],
      meters: []
    });

    const error = await unpriceable.service.generateInvoice(request).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MeterNotFoundError);
    expect((error as MeterNotFoundError).metricKeys).toEqual([METRIC_API, METRIC_STORAGE]);
  });

  it("BU41 - does not call createDraftInvoice when a metric has no meter", async () => {
    // D1: refusal is revenue-safe. An invoice that silently omits a metric is money missing
    // from a document that balances, and no `UsageLine` may be marked billed on this path.
    const unpriceable = buildHarness({
      totals: [{ metricKey: METRIC_STORAGE, totalQuantity: "5" }],
      meters: []
    });

    await unpriceable.service.generateInvoice(request).catch(() => undefined);

    expect(unpriceable.createDraftInvoice).not.toHaveBeenCalled();
  });

  it("BU42 - throws MeterCurrencyConflictError and writes nothing when meters disagree on currency", async () => {
    const conflicting = buildHarness({
      totals: [
        { metricKey: METRIC_API, totalQuantity: "1000" },
        { metricKey: METRIC_STORAGE, totalQuantity: "5" }
      ],
      meters: [
        { metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_USD },
        { metricKey: METRIC_STORAGE, unitPrice: "0.5", currency: CURRENCY_EUR }
      ]
    });

    const error = await conflicting.service.generateInvoice(request).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MeterCurrencyConflictError);
    expect((error as MeterCurrencyConflictError).currencies).toEqual([CURRENCY_USD, CURRENCY_EUR]);
    expect(conflicting.createDraftInvoice).not.toHaveBeenCalled();
  });

  it("BU43 - prices each line as summed quantity x unit price", async () => {
    const twoMetrics = buildHarness({
      totals: [
        { metricKey: METRIC_API, totalQuantity: "1000" },
        { metricKey: METRIC_STORAGE, totalQuantity: "5" }
      ],
      meters: [
        { metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_USD },
        { metricKey: METRIC_STORAGE, unitPrice: "0.5", currency: CURRENCY_USD }
      ]
    });

    await twoMetrics.service.generateInvoice(request);

    expect(draftInput(twoMetrics.createDraftInvoice).lineItems).toEqual([
      { metricKey: METRIC_API, quantity: "1000", unitPrice: "0.01", amount: "10" },
      { metricKey: METRIC_STORAGE, quantity: "5", unitPrice: "0.5", amount: "2.5" }
    ]);
  });

  it("BU44 - totalAmount is the sum of the line amounts", async () => {
    const twoMetrics = buildHarness({
      totals: [
        { metricKey: METRIC_API, totalQuantity: "1000" },
        { metricKey: METRIC_STORAGE, totalQuantity: "5" }
      ],
      meters: [
        { metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_USD },
        { metricKey: METRIC_STORAGE, unitPrice: "0.5", currency: CURRENCY_USD }
      ]
    });

    await twoMetrics.service.generateInvoice(request);

    expect(draftInput(twoMetrics.createDraftInvoice).totalAmount).toBe("12.5");
  });

  it("BU45 - stays exact at Decimal(18,6) precision where IEEE-754 would drift", async () => {
    // `1234567.123456 * 0.000001` is `1.234567123456` in Decimal and
    // `1.2345671234559998` in float. Both columns are `Decimal(18,6)`, so the float answer
    // would be wrong in the sixth place before the column ever rounded it.
    const precise = buildHarness({
      totals: [{ metricKey: METRIC_API, totalQuantity: "1234567.123456" }],
      meters: [{ metricKey: METRIC_API, unitPrice: "0.000001", currency: CURRENCY_USD }]
    });

    await precise.service.generateInvoice(request);

    const input = draftInput(precise.createDraftInvoice);
    expect(input.lineItems[0]?.amount).toBe("1.234567123456");
    expect(input.totalAmount).toBe("1.234567123456");
    expect(Number("1234567.123456") * Number("0.000001")).not.toBe(1.234567123456);
  });

  it("BU46 - writes one line item per metric key, carrying the summed quantity and the meter's price", async () => {
    const twoMetrics = buildHarness({
      totals: [
        { metricKey: METRIC_API, totalQuantity: "1000" },
        { metricKey: METRIC_STORAGE, totalQuantity: "5" }
      ],
      meters: [
        { metricKey: METRIC_STORAGE, unitPrice: "0.5", currency: CURRENCY_USD },
        { metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_USD }
      ]
    });

    await twoMetrics.service.generateInvoice(request);

    const lineItems = draftInput(twoMetrics.createDraftInvoice).lineItems;
    expect(lineItems).toHaveLength(2);
    expect(lineItems.map((item) => item.metricKey)).toEqual([METRIC_API, METRIC_STORAGE]);
  });

  it("BU47 - passes no Prisma.Decimal instance to the repository and returns none", async () => {
    // `JSON.stringify` of a `Prisma.Decimal` silently yields a string, so a leaked Decimal
    // would not look wrong in a response body. The type has to be asserted, not eyeballed.
    const result = await harness.service.generateInvoice(request);

    const input = draftInput(harness.createDraftInvoice);
    expect(input.totalAmount).not.toBeInstanceOf(Prisma.Decimal);
    expect(typeof input.totalAmount).toBe("string");
    for (const item of input.lineItems) {
      expect(item.quantity).not.toBeInstanceOf(Prisma.Decimal);
      expect(item.unitPrice).not.toBeInstanceOf(Prisma.Decimal);
      expect(item.amount).not.toBeInstanceOf(Prisma.Decimal);
      expect(typeof item.amount).toBe("string");
    }
    expect(result.invoiceId).not.toBeInstanceOf(Prisma.Decimal);
  });

  it("BU48 - hands the captured usage line ids to the write unchanged", async () => {
    await harness.service.generateInvoice(request);

    expect(draftInput(harness.createDraftInvoice).usageLineIds).toEqual([...USAGE_LINE_IDS]);
  });

  it("BU49 - sets the invoice currency from the matched meters", async () => {
    const european = buildHarness({
      meters: [{ metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_EUR }]
    });

    await european.service.generateInvoice(request);

    expect(draftInput(european.createDraftInvoice).currency).toBe(CURRENCY_EUR);
  });

  it("BU50 - reports a lost insert race as an existing invoice, not as a creation", async () => {
    const raced = buildHarness({ created: false });

    await expect(raced.service.generateInvoice(request)).resolves.toEqual({
      invoiceId: INVOICE_ID,
      created: false
    });
  });
});
