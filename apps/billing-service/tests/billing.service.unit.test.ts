import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import { BillingService } from "../src/services/billing.service";
import type { MeterRepository } from "../src/repositories/meter.repository";
import type { InvoiceRepository } from "../src/repositories/invoice.repository";
import { InvoiceStatus } from "@prisma/client";
import {
  InvoiceImmutableError,
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

/** A status the platform cannot write today; only a fixture or T-048 can produce one. */
const INVOICE_STATUS_FINALIZED = InvoiceStatus.FINALIZED;

/** A row that arrived after the first read -- the superset case in D6's lost-race arm. */
const LATE_LINE_ID = "line-late";

/** The default harness prices 1000 x 0.01, so an absorption of that set is a delta of 10. */
const ABSORBED_DELTA = "10";
/** What the repository double reports the invoice total to be after the increment. */
const ABSORBED_TOTAL_AMOUNT = "22.5";

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
  absorbedTotalAmount?: string;
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
  const absorbLateUsage = vi.fn(async () => ({
    invoiceId: INVOICE_ID,
    totalAmount: options.absorbedTotalAmount ?? ABSORBED_TOTAL_AMOUNT
  }));
  const findActiveAsOf = vi.fn(async () =>
    options.meters ?? [{ metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_USD }]
  );

  const invoiceRepository = {
    tenantExists,
    findByPeriod,
    sumUnbilledByMetricKey,
    createDraftInvoice,
    absorbLateUsage
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
    createDraftInvoice,
    absorbLateUsage,
    logger
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

/** Throws rather than passing vacuously when the absorb was never issued. */
const absorbInput = (absorbLateUsage: ReturnType<typeof vi.fn>) => {
  const call = absorbLateUsage.mock.calls[0];
  if (!call) {
    throw new Error("Expected absorbLateUsage to have been called");
  }
  return call[0] as {
    periodStart: Date;
    periodEnd: Date;
    totalAmountDelta: string;
    lineItems: { metricKey: string; quantity: string; unitPrice: string; amount: string }[];
    usageLineIds: string[];
  };
};

describe("BillingService.generateInvoice", () => {
  let harness: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    harness = buildHarness();
  });

  it("BU31 - returns the new invoice id marked as created, and not absorbed, on the happy path", async () => {
    // `absorbed` added at S-45: a fresh insert is not an absorption, so the two flags are never
    // both true. `201` still means, and only means, that this call inserted the invoice.
    await expect(harness.service.generateInvoice(request)).resolves.toEqual({
      invoiceId: INVOICE_ID,
      created: true,
      absorbed: false
    });
    expect(harness.absorbLateUsage).not.toHaveBeenCalled();
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

  it("BU35 - an already-invoiced period never reports created, with or without late usage", async () => {
    // **Updated at S-45, deliberately and not weakened.** This case used to assert one result
    // object for the whole "period already invoiced" branch; that branch now has two arms, and
    // the property it was really pinning -- an existing invoice is never reported as a creation,
    // so the controller never answers `201` for one -- is asserted across both of them here.
    // The arms' own behaviour is BU92 (absorbs) and BU93 (no-op).
    const withLateUsage = buildHarness({ existingInvoiceId: INVOICE_ID });
    const withNone = buildHarness({ existingInvoiceId: INVOICE_ID, totals: [], usageLineIds: [] });

    const absorbed = await withLateUsage.service.generateInvoice(request);
    const noop = await withNone.service.generateInvoice(request);

    expect(absorbed.invoiceId).toBe(INVOICE_ID);
    expect(noop.invoiceId).toBe(INVOICE_ID);
    expect(absorbed.created).toBe(false);
    expect(noop.created).toBe(false);
  });

  it("BU36 - an idempotent hit reads usage rather than short-circuiting, and still inserts nothing", async () => {
    // **This case asserted the S-45 defect and is inverted deliberately.** It used to require
    // that an existing invoice short-circuit *before* `sumUnbilledByMetricKey`, on the argument
    // that a second call would otherwise find the lines the first marked billed and answer
    // "no billable usage" for a period that has an invoice.
    //
    // That outcome is still protected -- it is exactly what BU93 asserts -- but the early
    // return also meant no usage arriving after the invoice was ever enumerated again. The
    // negative half of the original assertion survives unweakened: a period that already has an
    // invoice must never insert a second one, because `Invoice @@unique([tenantId, periodStart,
    // periodEnd])` would refuse it anyway.
    const existing = buildHarness({ existingInvoiceId: INVOICE_ID });

    await existing.service.generateInvoice(request);

    expect(existing.sumUnbilledByMetricKey).toHaveBeenCalledWith(PERIOD_START, PERIOD_END);
    expect(existing.createDraftInvoice).not.toHaveBeenCalled();
  });

  it("BU37 - returns a null invoice id and writes nothing when there is no unbilled usage", async () => {
    const empty = buildHarness({ totals: [], usageLineIds: [] });

    await expect(empty.service.generateInvoice(request)).resolves.toEqual({
      invoiceId: null,
      created: false,
      absorbed: false
    });
    expect(empty.findActiveAsOf).not.toHaveBeenCalled();
    expect(empty.createDraftInvoice).not.toHaveBeenCalled();
    expect(empty.absorbLateUsage).not.toHaveBeenCalled();
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

    // `absorbed: true` is new at S-45 and is not a weakening: the loser's own transaction rolled
    // back, so its rows may still be unbilled, and D6 routes that return through the absorb
    // branch rather than answering. BU94 is the case that pins the routing itself.
    await expect(raced.service.generateInvoice(request)).resolves.toEqual({
      invoiceId: INVOICE_ID,
      created: false,
      absorbed: true
    });
  });

  it("BU94 - a lost insert race routes into the absorb branch on a fresh read, not into a return (D6)", async () => {
    // The loser's own transaction rolled back, **including its billed update**, so its rows may
    // still be unbilled while `createDraftInvoice` answers with the winner's invoice id.
    // Returning there would be this task's own defect reached through a different door.
    //
    // The re-read is the load-bearing part: the set priced before the insert is stale, because
    // the winner billed most of it. Absorbing *that* set would fail the count assertion instead
    // of billing what is actually left, so `sumUnbilledByMetricKey` must run a second time and
    // the absorb must carry the second answer.
    const raced = buildHarness({ created: false });
    raced.sumUnbilledByMetricKey.mockResolvedValueOnce({
      totals: [{ metricKey: METRIC_API, totalQuantity: "1000" }],
      usageLineIds: [...USAGE_LINE_IDS]
    });
    raced.sumUnbilledByMetricKey.mockResolvedValueOnce({
      totals: [{ metricKey: METRIC_API, totalQuantity: "50" }],
      usageLineIds: [LATE_LINE_ID]
    });

    const result = await raced.service.generateInvoice(request);

    expect(raced.sumUnbilledByMetricKey).toHaveBeenCalledTimes(2);
    expect(absorbInput(raced.absorbLateUsage).usageLineIds).toEqual([LATE_LINE_ID]);
    expect(absorbInput(raced.absorbLateUsage).usageLineIds).not.toEqual([...USAGE_LINE_IDS]);
    expect(result).toEqual({ invoiceId: INVOICE_ID, created: false, absorbed: true });

    // **Unit coverage only, and S-38 is not closed by it.** S-38 records that the `P2002`
    // re-read has no test against a real connection, and warns that the obvious `Promise.all`
    // case can pass by serialising without ever touching the branch. This case drives the
    // branch through a repository double; it adds a second consumer of that path and no
    // real-connection coverage.
  });

  it("BU94b - a lost race whose rows the winner already billed reports absorbed false and writes nothing", async () => {
    // The *normal* lost race, and the one that must not claim an absorption: both callers read
    // the same set, the winner billed all of it, and the loser's re-read comes back empty.
    const raced = buildHarness({ created: false });
    raced.sumUnbilledByMetricKey.mockResolvedValueOnce({
      totals: [{ metricKey: METRIC_API, totalQuantity: "1000" }],
      usageLineIds: [...USAGE_LINE_IDS]
    });
    raced.sumUnbilledByMetricKey.mockResolvedValueOnce({ totals: [], usageLineIds: [] });

    const result = await raced.service.generateInvoice(request);

    expect(raced.absorbLateUsage).not.toHaveBeenCalled();
    expect(result).toEqual({ invoiceId: INVOICE_ID, created: false, absorbed: false });
  });

  it("BU92 - absorbs late usage into an existing invoice, with the priced lines and the exact id set", async () => {
    // S-45. The shipped ordering returns at `findByPeriod` before `sumUnbilledByMetricKey` ever
    // runs, so usage that lands in a window after that window's invoice was written is never
    // billed by anything: the rows stay `billed = false`, the next night reads a different
    // window, and the job reports success either way.
    const existing = buildHarness({ existingInvoiceId: INVOICE_ID });

    const result = await existing.service.generateInvoice(request);

    const input = absorbInput(existing.absorbLateUsage);
    expect(input.usageLineIds).toEqual([...USAGE_LINE_IDS]);
    expect(input.totalAmountDelta).toBe(ABSORBED_DELTA);
    expect(input.lineItems).toEqual([
      { metricKey: METRIC_API, quantity: "1000", unitPrice: "0.01", amount: ABSORBED_DELTA }
    ]);
    expect(input.periodStart).toEqual(PERIOD_START);
    expect(input.periodEnd).toEqual(PERIOD_END);

    // Never a second invoice for the same period: `Invoice @@unique([tenantId, periodStart,
    // periodEnd])` is a live unique index, so the insert would be a `23505` rather than a
    // supplementary document (plan D1, probe A).
    expect(existing.createDraftInvoice).not.toHaveBeenCalled();
    expect(result).toEqual({ invoiceId: INVOICE_ID, created: false, absorbed: true });
  });

  it("BU95 - no existing invoice still inserts, and reports absorbed false", async () => {
    // The unchanged path, asserted after the restructure moved the reads above the decision:
    // an absorption and an insert are mutually exclusive, and the flags must say so.
    const result = await harness.service.generateInvoice(request);

    expect(harness.createDraftInvoice).toHaveBeenCalledTimes(1);
    expect(harness.absorbLateUsage).not.toHaveBeenCalled();
    expect(result.created).toBe(true);
    expect(result.absorbed).toBe(false);
  });

  it("BU96 - an InvoiceImmutableError from the repository propagates unchanged and is logged with the invoice and its status", async () => {
    // Not swallowed, not remapped: the controller's `AppError` arm carries its own `409` and
    // code to the wire. The log line is the other half of divergence E1 -- the epic puts
    // `invoiceId` and `currentStatus` in the response body, this service puts them where an
    // operator reads them, which is only true if something actually logs them.
    const existing = buildHarness({ existingInvoiceId: INVOICE_ID });
    const refusal = new InvoiceImmutableError(INVOICE_ID, INVOICE_STATUS_FINALIZED);
    existing.absorbLateUsage.mockRejectedValueOnce(refusal);

    const error = await existing.service.generateInvoice(request).catch((err: unknown) => err);

    expect(error).toBe(refusal);
    expect((error as InvoiceImmutableError).statusCode).toBe(
      BILLING_RESPONSES.HTTP_STATUS_CONFLICT
    );
    const warned = existing.logger.warn.mock.calls[0];
    if (!warned) {
      throw new Error("Expected the refusal to have been logged");
    }
    expect(warned[0]).toMatchObject({
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      currentStatus: INVOICE_STATUS_FINALIZED
    });
  });

  it("BU97 - an unmetered metric in the late usage refuses the absorption and writes nothing", async () => {
    // **The refusal that the restructure could most easily have dropped.** D1 says a metricKey
    // with usage and no active meter fails the whole request rather than being skipped; hoisting
    // steps 3-6 above the create/absorb decision is what keeps that true on *both* branches
    // rather than only on the insert one. Duplicating the pipeline per branch is how an
    // unmetered late metric would come to be silently skipped here and refused there.
    const existing = buildHarness({
      existingInvoiceId: INVOICE_ID,
      totals: [
        { metricKey: METRIC_API, totalQuantity: "1000" },
        { metricKey: METRIC_STORAGE, totalQuantity: "5" }
      ],
      meters: [{ metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_USD }]
    });

    const error = await existing.service.generateInvoice(request).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MeterNotFoundError);
    expect((error as MeterNotFoundError).metricKeys).toEqual([METRIC_STORAGE]);
    expect(existing.absorbLateUsage).not.toHaveBeenCalled();
    expect(existing.createDraftInvoice).not.toHaveBeenCalled();
  });

  it("BU93 - an existing invoice with no unbilled usage writes nothing and reports absorbed false", async () => {
    // The no-op path, and the guard on D7: the unbilled query now runs on every re-run, so an
    // empty result must return the *existing* invoice rather than the `invoiceId: null` that
    // "no billable usage" answers when there is no invoice at all.
    const empty = buildHarness({
      existingInvoiceId: INVOICE_ID,
      totals: [],
      usageLineIds: []
    });

    const result = await empty.service.generateInvoice(request);

    expect(empty.absorbLateUsage).not.toHaveBeenCalled();
    expect(empty.createDraftInvoice).not.toHaveBeenCalled();
    expect(empty.findActiveAsOf).not.toHaveBeenCalled();
    expect(result).toEqual({ invoiceId: INVOICE_ID, created: false, absorbed: false });
  });
});
