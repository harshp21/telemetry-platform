import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { InvoiceRepository } from "../src/repositories/invoice.repository";
import type {
  AbsorbLateUsageInput,
  CreateDraftInvoiceInput
} from "../src/repositories/invoice.repository";
import { InvoiceImmutableError, UsageLinesChangedError } from "../src/errors";
import {
  BILLING_DATABASE,
  BILLING_INVOICE_DETAIL,
  BILLING_INVOICE_LIST,
  BILLING_METERING,
  BILLING_RESPONSES
} from "../src/constants";
import { InvoiceStatus } from "@prisma/client";
import { INTEGRATION_INVOICE_DETAIL } from "./integration.constants";

const TENANT_ID = "11111111-1111-4111-8111-111111111111" as TenantId;
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";

const PERIOD_START = new Date("2026-01-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-02-01T00:00:00.000Z");

const INVOICE_ID = "33333333-3333-4333-8333-333333333333";
const USAGE_LINE_IDS = ["line-a", "line-b"] as const;
/** What the absorbed invoice's total reads after the increment, in the shape the driver hands over. */
const ABSORBED_TOTAL_AMOUNT = "14.500000";
const ABSORBED_DELTA = "2.000000";
const METRIC_API = "api.request";
const METRIC_STORAGE = "storage.gb";
const CURRENCY_USD = "USD";

/** See `meter.repository.unit.test.ts` for why this is a literal rather than an import. */
const TENANT_SETTING_NAME = "app.tenant_id";

const testLogger = () => ({ error: vi.fn(), debug: vi.fn() });

const draftInput = (
  overrides: Partial<CreateDraftInvoiceInput> = {}
): CreateDraftInvoiceInput => ({
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  currency: CURRENCY_USD,
  totalAmount: "12.500000",
  lineItems: [
    { metricKey: METRIC_API, quantity: "1000", unitPrice: "0.01", amount: "10" },
    { metricKey: METRIC_STORAGE, quantity: "5", unitPrice: "0.5", amount: "2.5" }
  ],
  usageLineIds: [...USAGE_LINE_IDS],
  ...overrides
});

interface PrismaMockOptions {
  tenantCount?: number;
  invoiceByPeriod?: { id: string } | null;
  groupByRows?: { metricKey: string; _sum: { quantity: Prisma.Decimal | null } }[];
  unbilledIds?: { id: string }[];
  createResult?: { id: string } | Error;
  /** Count returned by every `updateMany` call. Default: every id in the chunk matched. */
  updatedCount?: number;
  /** Count returned per call, in order -- for asserting the sum across chunks. */
  updatedCounts?: readonly number[];
  /** Raw list rows, spelled the way the driver hands them over: `Prisma.Decimal` and `Date`. */
  listRows?: readonly Record<string, unknown>[];
  listTotal?: number;
  /** What `invoice.findUniqueOrThrow` answers on the absorb path, or an error to raise. */
  invoiceForAbsorb?: { id: string; status: InvoiceStatus } | Error;
  /** The post-increment total the `update` reports, as the driver would: a `Prisma.Decimal`. */
  absorbedTotalAmount?: string;
  /**
   * What `invoice.findFirst` answers on the detail path (T-047), spelled the way the driver
   * hands it over: `Prisma.Decimal` and `Date` throughout, line items nested under the parent.
   */
  detailRow?: Record<string, unknown> | null;
}

/**
 * Prisma double whose `$transaction` runs the callback immediately and lets a rejection
 * escape, which is what a real transaction turns into a rollback.
 *
 * Every model method is a spy, so an assertion about a query inspects the argument tree the
 * repository built rather than a value the mock chose.
 */
const createPrismaMock = (options: PrismaMockOptions = {}) => {
  const queryRaw = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
  const tenantCount = vi.fn(async () => options.tenantCount ?? 1);
  const invoiceFindUnique = vi.fn(async () =>
    options.invoiceByPeriod === undefined ? null : options.invoiceByPeriod
  );
  const usageLineGroupBy = vi.fn(async () => options.groupByRows ?? []);
  const usageLineFindMany = vi.fn(async () => options.unbilledIds ?? []);
  const invoiceCreate = vi.fn(async () => {
    const result = options.createResult ?? { id: INVOICE_ID };
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  const invoiceLineItemCreate = vi.fn(async () => ({ id: "unused" }));
  const invoiceFindUniqueOrThrow = vi.fn(async () => {
    const result = options.invoiceForAbsorb ?? { id: INVOICE_ID, status: InvoiceStatus.DRAFT };
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  const invoiceUpdate = vi.fn(async () => ({
    id: INVOICE_ID,
    totalAmount: new Prisma.Decimal(options.absorbedTotalAmount ?? ABSORBED_TOTAL_AMOUNT)
  }));
  const invoiceFindMany = vi.fn(async () => options.listRows ?? []);
  const invoiceCount = vi.fn(async () => options.listTotal ?? 0);
  const invoiceFindFirst = vi.fn(async () => options.detailRow ?? null);
  /**
   * The three line-item reads that must never be issued (T-047, BU109).
   *
   * They exist on the double purely so that a re-route can be *observed*: a spy that is never
   * wired cannot be asserted `not.toHaveBeenCalled()` in any meaningful way, because a typo in
   * the property name would make the assertion pass against nothing.
   */
  const invoiceLineItemFindMany = vi.fn(async () => []);
  const invoiceLineItemFindUnique = vi.fn(async () => null);
  const invoiceLineItemCount = vi.fn(async () => 0);
  let updateManyCall = 0;
  const usageLineUpdateMany = vi.fn(async (args: { where: { id: { in: string[] } } }) => {
    const index = updateManyCall;
    updateManyCall += 1;
    if (options.updatedCounts !== undefined) {
      return { count: options.updatedCounts[index] ?? 0 };
    }
    // Default: the chunk matched in full, so the happy path holds at any id count.
    return { count: options.updatedCount ?? args.where.id.in.length };
  });

  const tx = {
    $queryRaw: queryRaw,
    tenant: { count: tenantCount },
    invoice: {
      findUnique: invoiceFindUnique,
      findUniqueOrThrow: invoiceFindUniqueOrThrow,
      create: invoiceCreate,
      update: invoiceUpdate,
      findMany: invoiceFindMany,
      count: invoiceCount,
      findFirst: invoiceFindFirst
    },
    invoiceLineItem: {
      create: invoiceLineItemCreate,
      findMany: invoiceLineItemFindMany,
      findUnique: invoiceLineItemFindUnique,
      count: invoiceLineItemCount
    },
    usageLine: {
      groupBy: usageLineGroupBy,
      findMany: usageLineFindMany,
      updateMany: usageLineUpdateMany
    }
  };
  const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  const prisma = { $transaction: transaction } as unknown as PrismaClient;

  return {
    prisma,
    transaction,
    queryRaw,
    tenantCount,
    invoiceFindUnique,
    invoiceFindUniqueOrThrow,
    invoiceCreate,
    invoiceUpdate,
    invoiceFindMany,
    invoiceCount,
    invoiceFindFirst,
    invoiceLineItemCreate,
    invoiceLineItemFindMany,
    invoiceLineItemFindUnique,
    invoiceLineItemCount,
    usageLineGroupBy,
    usageLineFindMany,
    usageLineUpdateMany,
    repository: new InvoiceRepository(prisma, TENANT_ID, testLogger())
  };
};

/** Throws rather than passing vacuously when the query under assertion was never issued. */
const firstArg = (spy: ReturnType<typeof vi.fn>, label: string): Record<string, unknown> => {
  const call = spy.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to have been called`);
  }
  return call[0] as Record<string, unknown>;
};

const uniqueViolation = (): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: BILLING_DATABASE.UNIQUE_VIOLATION_CODE,
    clientVersion: "test",
    // Measured at Gate 1: the real error arrives with `meta.target` null, so the handler
    // cannot discriminate which constraint fired. The double reproduces that rather than
    // handing the code information production does not have.
    meta: { target: null }
  });

const decimalRow = (metricKey: string, quantity: string) => ({
  metricKey,
  _sum: { quantity: new Prisma.Decimal(quantity) }
});

const absorbInput = (
  overrides: Partial<AbsorbLateUsageInput> = {}
): AbsorbLateUsageInput => ({
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  totalAmountDelta: ABSORBED_DELTA,
  lineItems: [{ metricKey: METRIC_API, quantity: "200", unitPrice: "0.01", amount: "2" }],
  usageLineIds: [...USAGE_LINE_IDS],
  ...overrides
});

describe("InvoiceRepository.tenantExists", () => {
  it("BU16 - answers from the tenant-scoped read: present is true, absent is false", async () => {
    await expect(createPrismaMock({ tenantCount: 1 }).repository.tenantExists()).resolves.toBe(true);
    await expect(createPrismaMock({ tenantCount: 0 }).repository.tenantExists()).resolves.toBe(
      false
    );
  });

  it("BU17 - reads inside withTenant and addresses only the bound tenant id", async () => {
    const mock = createPrismaMock();

    await mock.repository.tenantExists();

    expect(mock.transaction).toHaveBeenCalledTimes(1);
    expect(String(mock.queryRaw.mock.calls[0]?.[0])).toContain(TENANT_SETTING_NAME);
    const where = firstArg(mock.tenantCount, "tenant.count").where;
    expect(where).toEqual({ id: TENANT_ID });
    expect(JSON.stringify(where)).not.toContain(OTHER_TENANT_ID);
  });
});

describe("InvoiceRepository.findByPeriod", () => {
  it("BU18 - returns the existing invoice id, and null when the period has none", async () => {
    await expect(
      createPrismaMock({ invoiceByPeriod: { id: INVOICE_ID } }).repository.findByPeriod(
        PERIOD_START,
        PERIOD_END
      )
    ).resolves.toBe(INVOICE_ID);
    await expect(
      createPrismaMock({ invoiceByPeriod: null }).repository.findByPeriod(PERIOD_START, PERIOD_END)
    ).resolves.toBeNull();
  });

  it("BU19 - addresses the compound unique through the ORM with the bound tenant and Date bounds", async () => {
    const mock = createPrismaMock();

    await mock.repository.findByPeriod(PERIOD_START, PERIOD_END);

    // ORM, never `$queryRaw`: a bound JS Date in raw SQL is a `timestamptz` compared against a
    // naive column through the *session* zone, so the same equality finds the row under UTC and
    // misses it under Asia/Kolkata (S-18, measured over four zones at Gate 1). The only raw
    // statement in this path is `withTenant`'s own `set_config`.
    expect(firstArg(mock.invoiceFindUnique, "invoice.findUnique").where).toEqual({
      tenantId_periodStart_periodEnd: {
        tenantId: TENANT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END
      }
    });
    expect(mock.queryRaw.mock.calls).toHaveLength(1);
    expect(String(mock.queryRaw.mock.calls[0]?.[0])).toContain(TENANT_SETTING_NAME);
  });
});

describe("InvoiceRepository.sumUnbilledByMetricKey", () => {
  it("BU20 - returns per-key totals as strings, never a Prisma.Decimal", async () => {
    const mock = createPrismaMock({
      groupByRows: [decimalRow(METRIC_API, "1000.000000"), decimalRow(METRIC_STORAGE, "5.250000")],
      unbilledIds: [{ id: USAGE_LINE_IDS[0] }]
    });

    const result = await mock.repository.sumUnbilledByMetricKey(PERIOD_START, PERIOD_END);

    expect(result.totals).toEqual([
      { metricKey: METRIC_API, totalQuantity: "1000" },
      { metricKey: METRIC_STORAGE, totalQuantity: "5.25" }
    ]);
    for (const total of result.totals) {
      expect(total.totalQuantity).not.toBeInstanceOf(Prisma.Decimal);
      expect(typeof total.totalQuantity).toBe("string");
    }
  });

  it("BU21 - filters on the bound tenant, billed=false and a half-open [start, end) range", async () => {
    const mock = createPrismaMock();

    await mock.repository.sumUnbilledByMetricKey(PERIOD_START, PERIOD_END);

    const expectedWhere = {
      tenantId: TENANT_ID,
      billed: false,
      periodStart: { gte: PERIOD_START, lt: PERIOD_END }
    };
    expect(firstArg(mock.usageLineGroupBy, "usageLine.groupBy").where).toEqual(expectedWhere);
    expect(firstArg(mock.usageLineFindMany, "usageLine.findMany").where).toEqual(expectedWhere);
    expect(JSON.stringify(mock.usageLineGroupBy.mock.calls)).not.toContain(OTHER_TENANT_ID);
  });

  it("BU22 - returns the ids it summed, read over the same predicate in one transaction", async () => {
    const mock = createPrismaMock({
      groupByRows: [decimalRow(METRIC_API, "3.000000")],
      unbilledIds: [{ id: USAGE_LINE_IDS[0] }, { id: USAGE_LINE_IDS[1] }]
    });

    const result = await mock.repository.sumUnbilledByMetricKey(PERIOD_START, PERIOD_END);

    // Capturing the ids is what lets the write mark exactly the rows the pricing saw, rather
    // than re-deriving a set that may have moved in between (D2).
    expect(result.usageLineIds).toEqual([...USAGE_LINE_IDS]);
    expect(mock.transaction).toHaveBeenCalledTimes(1);
    expect(firstArg(mock.usageLineFindMany, "usageLine.findMany").select).toEqual({ id: true });
  });
});

describe("InvoiceRepository.createDraftInvoice", () => {
  it("BU23 - creates a DRAFT invoice with its line items nested, never addressed by a free invoiceId", async () => {
    const mock = createPrismaMock();

    const result = await mock.repository.createDraftInvoice(draftInput());

    const data = firstArg(mock.invoiceCreate, "invoice.create").data as Record<string, unknown>;
    expect(data).toMatchObject({
      tenantId: TENANT_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      status: BILLING_METERING.INVOICE_STATUS_DRAFT,
      totalAmount: "12.500000",
      currency: CURRENCY_USD
    });
    expect(data.lineItems).toEqual({
      create: [
        { metricKey: METRIC_API, quantity: "1000", unitPrice: "0.01", amount: "10" },
        { metricKey: METRIC_STORAGE, quantity: "5", unitPrice: "0.5", amount: "2.5" }
      ]
    });
    // S-10: `InvoiceLineItem` has RLS inert and no `tenantId` column, so the join through
    // `Invoice` is its only tenant control. A standalone create addressing an invoiceId would
    // have no such join.
    expect(mock.invoiceLineItemCreate).not.toHaveBeenCalled();
    expect(result).toEqual({ invoiceId: INVOICE_ID, created: true });
  });

  it("BU24 - marks exactly the summed ids, and only ones still unbilled", async () => {
    const mock = createPrismaMock();

    await mock.repository.createDraftInvoice(draftInput());

    const call = firstArg(mock.usageLineUpdateMany, "usageLine.updateMany");
    expect(call.where).toEqual({
      tenantId: TENANT_ID,
      id: { in: [...USAGE_LINE_IDS] },
      billed: false
    });
    expect(call.data).toEqual({ billed: true });
  });

  it("BU24b - splits the billed update into chunks that partition the id set exactly", async () => {
    // Prisma binds one variable per id and PostgreSQL caps a statement at 32 767, so an
    // unchunked update raises `P2035` above 32 764 ids -- measured, and unrecoverable without a
    // code change because `P2035` is not `P2002`. Exercised at an exact multiple of the chunk
    // and at one past it, because the loop's boundary arithmetic is what a round number hides.
    const chunk = BILLING_METERING.BILLED_UPDATE_CHUNK_SIZE;
    const exactMultipleIds = Array.from({ length: chunk * 2 }, (_, i) => `line-${i}`);
    const oneOverIds = Array.from({ length: chunk * 2 + 1 }, (_, i) => `line-${i}`);

    const exact = createPrismaMock();
    await exact.repository.createDraftInvoice(draftInput({ usageLineIds: exactMultipleIds }));
    const over = createPrismaMock();
    await over.repository.createDraftInvoice(draftInput({ usageLineIds: oneOverIds }));

    expect(exact.usageLineUpdateMany).toHaveBeenCalledTimes(2);
    expect(over.usageLineUpdateMany).toHaveBeenCalledTimes(3);

    // Every id addressed exactly once, in order, with no chunk exceeding the bound.
    const addressed = over.usageLineUpdateMany.mock.calls.flatMap(
      (call) => (call[0] as { where: { id: { in: string[] } } }).where.id.in
    );
    expect(addressed).toEqual(oneOverIds);
    expect(new Set(addressed).size).toBe(oneOverIds.length);
    for (const call of over.usageLineUpdateMany.mock.calls) {
      const size = (call[0] as { where: { id: { in: string[] } } }).where.id.in.length;
      expect(size).toBeLessThanOrEqual(chunk);
      expect(size).toBeGreaterThan(0);
    }
  });

  it("BU25 - writes and updates inside one withTenant transaction carrying the bound tenant", async () => {
    const mock = createPrismaMock();

    await mock.repository.createDraftInvoice(draftInput());

    expect(mock.transaction).toHaveBeenCalledTimes(1);
    expect(mock.queryRaw.mock.calls).toHaveLength(1);
    expect(mock.queryRaw.mock.calls[0]).toContain(TENANT_ID);
    expect(JSON.stringify(mock.invoiceCreate.mock.calls)).not.toContain(OTHER_TENANT_ID);
    expect(JSON.stringify(mock.usageLineUpdateMany.mock.calls)).not.toContain(OTHER_TENANT_ID);
  });

  it("BU26 - does not commit an invoice when the billed count is short", async () => {
    const mock = createPrismaMock({ updatedCount: USAGE_LINE_IDS.length - 1 });

    await expect(mock.repository.createDraftInvoice(draftInput())).rejects.toBeInstanceOf(
      UsageLinesChangedError
    );

    // The throw escapes the `$transaction` callback, which is what a real transaction turns
    // into a rollback of the invoice and its line items. The rollback itself is Prisma and
    // Postgres behaviour and is asserted against a live database in BI10 -- this case pins
    // that the repository raises rather than logs.
    expect(mock.invoiceCreate).toHaveBeenCalledTimes(1);
    await expect(mock.transaction.mock.results[0]?.value).rejects.toBeInstanceOf(
      UsageLinesChangedError
    );
  });

  it("BU27 - reports how many rows it expected and how many it marked", async () => {
    const mock = createPrismaMock({ updatedCount: 0 });

    const error = await mock.repository.createDraftInvoice(draftInput()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UsageLinesChangedError);
    expect((error as UsageLinesChangedError).expected).toBe(USAGE_LINE_IDS.length);
    expect((error as UsageLinesChangedError).actual).toBe(0);
  });

  it("BU27b - sums the counts across chunks before comparing, never per chunk", async () => {
    // What separates the shipped assertion from a per-chunk one. The first chunk matches in
    // full and the second matches nothing: a per-chunk comparison would report expected 1 and
    // marked 0, and would be a different guard from the one BU24 and BU26 pin.
    const chunk = BILLING_METERING.BILLED_UPDATE_CHUNK_SIZE;
    const ids = Array.from({ length: chunk + 1 }, (_, i) => `line-${i}`);
    const mock = createPrismaMock({ updatedCounts: [chunk, 0] });

    const error = await mock.repository
      .createDraftInvoice(draftInput({ usageLineIds: ids }))
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UsageLinesChangedError);
    expect((error as UsageLinesChangedError).expected).toBe(chunk + 1);
    expect((error as UsageLinesChangedError).actual).toBe(chunk);
  });

  it("BU28 - does not swallow a database error that is not a unique violation", async () => {
    const failure = new Prisma.PrismaClientKnownRequestError("numeric field overflow", {
      code: "P2010",
      clientVersion: "test"
    });
    const mock = createPrismaMock({ createResult: failure });

    await expect(mock.repository.createDraftInvoice(draftInput())).rejects.toBe(failure);
    expect(mock.invoiceFindUnique).not.toHaveBeenCalled();
  });

  it("BU29 - a unique violation re-reads by period and returns the existing invoice id", async () => {
    const mock = createPrismaMock({
      createResult: uniqueViolation(),
      invoiceByPeriod: { id: INVOICE_ID }
    });

    // Without this catch `registerGlobalErrorHandler` turns the P2002 into a 409 CONFLICT --
    // a plausible-looking wrong answer rather than a crash, on a path the epic calls idempotent.
    await expect(mock.repository.createDraftInvoice(draftInput())).resolves.toEqual({
      invoiceId: INVOICE_ID,
      created: false
    });
    expect(firstArg(mock.invoiceFindUnique, "invoice.findUnique").where).toEqual({
      tenantId_periodStart_periodEnd: {
        tenantId: TENANT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END
      }
    });
  });

  it("BU30 - re-raises the unique violation when the re-read finds no invoice", async () => {
    const violation = uniqueViolation();
    const mock = createPrismaMock({ createResult: violation, invoiceByPeriod: null });

    // The error object carries no usable `meta.target`, so a P2002 that is not the period
    // constraint must not be reported as an idempotent hit.
    await expect(mock.repository.createDraftInvoice(draftInput())).rejects.toBe(violation);
  });
});

describe("InvoiceRepository.absorbLateUsage", () => {
  it("BU98 - addresses the invoice by the compound unique with the bound tenant, and raises the total with increment", async () => {
    const mock = createPrismaMock();

    const result = await mock.repository.absorbLateUsage(absorbInput());

    const args = firstArg(mock.invoiceUpdate, "invoice.update");
    // The compound unique, never a bare id: the emitted `UPDATE` then carries the tenant in
    // its own `WHERE`, which is the only reason the nested line-item insert below is addressed
    // to an invoice this tenant owns (S-10 -- the line-item table has no RLS of its own).
    expect(args.where).toEqual({
      tenantId_periodStart_periodEnd: {
        tenantId: TENANT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END
      }
    });

    // `increment`, never `set`. A read-modify-write would put a `Decimal(18,6)` value through
    // JavaScript and would also race a concurrent absorber; `increment` compiles to a SQL
    // addition on the column and does neither (D4).
    const data = args.data as Record<string, unknown>;
    expect(data.totalAmount).toEqual({ increment: ABSORBED_DELTA });
    expect(data.totalAmount).not.toHaveProperty("set");
    expect(JSON.stringify(args)).not.toContain(OTHER_TENANT_ID);

    // Both statements inside one transaction whose first statement sets the RLS context.
    expect(mock.transaction).toHaveBeenCalledTimes(1);
    expect(String(mock.queryRaw.mock.calls[0]?.[0])).toContain(TENANT_SETTING_NAME);
    expect(mock.queryRaw.mock.calls[0]).toContain(TENANT_ID);

    // And nothing that reads like a `Prisma.Decimal` leaves the repository (D5).
    expect(result.invoiceId).toBe(INVOICE_ID);
    expect(typeof result.totalAmount).toBe("string");
    expect(result.totalAmount).not.toBeInstanceOf(Prisma.Decimal);
    expect(result.totalAmount).toBe(new Prisma.Decimal(ABSORBED_TOTAL_AMOUNT).toString());
  });

  it("BU99 - appends line items through the nested create on that update, never tx.invoiceLineItem.create", async () => {
    // A **shape** assertion, and stated as what it is: it pins the call the repository builds,
    // not an isolation outcome. The outcome case is BI24, against a live database with two
    // tenants holding invoices for the same period. Both are needed -- `"InvoiceLineItem"` has
    // `relrowsecurity = f` and no policy (S-10), so the nested create is the entire control and
    // a standalone create addressing an `invoiceId` would have no tenant predicate at all.
    const lineItems = [
      { metricKey: METRIC_API, quantity: "200", unitPrice: "0.01", amount: "2" },
      { metricKey: METRIC_STORAGE, quantity: "1", unitPrice: "0.5", amount: "0.5" }
    ];
    const mock = createPrismaMock();

    await mock.repository.absorbLateUsage(absorbInput({ lineItems }));

    const data = firstArg(mock.invoiceUpdate, "invoice.update").data as Record<string, unknown>;
    expect(data.lineItems).toEqual({ create: lineItems });
    expect(mock.invoiceLineItemCreate).not.toHaveBeenCalled();
    // Append, never merge (D2): no read of the existing line items precedes the write.
    expect(mock.invoiceFindMany).not.toHaveBeenCalled();
  });

  it("BU100 - refuses a non-DRAFT invoice with InvoiceImmutableError before any write", async () => {
    const mock = createPrismaMock({
      invoiceForAbsorb: { id: INVOICE_ID, status: InvoiceStatus.FINALIZED }
    });

    const error = await mock.repository
      .absorbLateUsage(absorbInput())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(InvoiceImmutableError);
    expect((error as InvoiceImmutableError).invoiceId).toBe(INVOICE_ID);
    expect((error as InvoiceImmutableError).currentStatus).toBe(InvoiceStatus.FINALIZED);
    expect((error as InvoiceImmutableError).statusCode).toBe(
      BILLING_RESPONSES.HTTP_STATUS_CONFLICT
    );
    expect((error as InvoiceImmutableError).code).toBe(
      BILLING_RESPONSES.CODE_INVOICE_IMMUTABLE
    );
    expect((error as InvoiceImmutableError).message).toContain(InvoiceStatus.FINALIZED);

    // Nothing written, which is the half that matters: the refusal must precede the update and
    // the billed flags, not undo them.
    expect(mock.invoiceUpdate).not.toHaveBeenCalled();
    expect(mock.usageLineUpdateMany).not.toHaveBeenCalled();
    expect(mock.invoiceLineItemCreate).not.toHaveBeenCalled();
  });

  it("BU101 - chunks the billed update and compares the summed count against the whole set", async () => {
    // The same bound and the same assertion as `createDraftInvoice`, because it is literally
    // the same helper (`markUsageLinesBilled`) -- which is why the extraction was its own slice.
    // A per-chunk comparison would report the wrong numbers here exactly as it would there.
    const chunk = BILLING_METERING.BILLED_UPDATE_CHUNK_SIZE;
    const ids = Array.from({ length: chunk + 1 }, (_, i) => `line-${i}`);

    const happy = createPrismaMock();
    await happy.repository.absorbLateUsage(absorbInput({ usageLineIds: ids }));

    expect(happy.usageLineUpdateMany).toHaveBeenCalledTimes(2);
    const addressed = happy.usageLineUpdateMany.mock.calls.flatMap(
      (call) => (call[0] as { where: { id: { in: string[] } } }).where.id.in
    );
    expect(addressed).toEqual(ids);
    expect(firstArg(happy.usageLineUpdateMany, "usageLine.updateMany").where).toMatchObject({
      tenantId: TENANT_ID,
      billed: false
    });

    const short = createPrismaMock({ updatedCounts: [chunk, 0] });
    const error = await short.repository
      .absorbLateUsage(absorbInput({ usageLineIds: ids }))
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UsageLinesChangedError);
    expect((error as UsageLinesChangedError).expected).toBe(chunk + 1);
    expect((error as UsageLinesChangedError).actual).toBe(chunk);
    // The throw escapes the `$transaction` callback, which is what a real transaction turns
    // into a rollback of the increment and the appended line items. This case pins that the
    // repository **raises** rather than logs; the rollback itself is asserted live by `BI27`,
    // which drives a mid-absorb failure against a real transaction and reads the three values
    // back. (An earlier revision of this comment credited `BI23` with the live rollback. It
    // cannot: `BI23` is the `FINALIZED` refusal, which throws *before* any write -- `BU100`
    // asserts exactly that, and there is nothing to roll back on that path.)
    await expect(short.transaction.mock.results[0]?.value).rejects.toBeInstanceOf(
      UsageLinesChangedError
    );
  });
});

/**
 * Raw list fixtures, spelled the way the driver hands a row over: `totalAmount` a
 * `Prisma.Decimal` and the three timestamps `Date`s. The point of the block below is that
 * none of those types survives the repository boundary (D5).
 */
const LIST_PERIOD_START_NEWER = new Date("2026-02-01T00:00:00.000Z");
const LIST_PERIOD_END_NEWER = new Date("2026-03-01T00:00:00.000Z");
const LIST_CREATED_AT = new Date("2026-03-02T09:15:30.123Z");
const LIST_FINALIZED_AT = new Date("2026-03-03T10:00:00.000Z");
const LIST_TOTAL_PRECISE = "1234567.123456";
const LIST_INVOICE_ID_NEWER = "44444444-4444-4444-8444-444444444444";
const LIST_TOTAL_COUNT = 3;
const LIST_PAGE_TWO = 2;
const LIST_PAGE_SIZE_TWO = 2;

const rawListRow = (overrides: Record<string, unknown> = {}) => ({
  id: LIST_INVOICE_ID_NEWER,
  periodStart: LIST_PERIOD_START_NEWER,
  periodEnd: LIST_PERIOD_END_NEWER,
  status: InvoiceStatus.PAID,
  totalAmount: new Prisma.Decimal(LIST_TOTAL_PRECISE),
  currency: CURRENCY_USD,
  createdAt: LIST_CREATED_AT,
  finalizedAt: LIST_FINALIZED_AT,
  ...overrides
});

const defaultListQuery = {
  page: BILLING_INVOICE_LIST.DEFAULT_PAGE,
  pageSize: BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE
} as const;

describe("InvoiceRepository.listInvoices", () => {
  it("BU74 - filters on the bound tenant only, inside withTenant, with no other tenant id anywhere in the query", async () => {
    const mock = createPrismaMock({ listRows: [], listTotal: 0 });

    await mock.repository.listInvoices(defaultListQuery);

    // Layer 4 of `.claude/rules/tenant-isolation.md`: the RLS context is set as the first
    // statement of the transaction the reads run in.
    expect(mock.transaction).toHaveBeenCalledTimes(1);
    expect(String(mock.queryRaw.mock.calls[0]?.[0])).toContain(TENANT_SETTING_NAME);

    // And belt-and-braces: the application predicate carries the tenant too, from the
    // constructor-bound context. `listInvoices` has no `tenantId` parameter, so there is no
    // caller-supplied value it could have come from.
    const findManyArgs = firstArg(mock.invoiceFindMany, "invoice.findMany");
    const countArgs = firstArg(mock.invoiceCount, "invoice.count");
    expect(findManyArgs.where).toEqual({ tenantId: TENANT_ID });
    expect(countArgs.where).toEqual({ tenantId: TENANT_ID });

    // The negative assertion is the load-bearing one: no other tenant's id appears anywhere in
    // either argument tree, not merely "the tenant we expected is present".
    expect(JSON.stringify(findManyArgs)).not.toContain(OTHER_TENANT_ID);
    expect(JSON.stringify(countArgs)).not.toContain(OTHER_TENANT_ID);
  });

  it("BU74b - applies the status filter when given and omits the predicate entirely when not", async () => {
    const filtered = createPrismaMock({ listRows: [], listTotal: 0 });
    await filtered.repository.listInvoices({ ...defaultListQuery, status: InvoiceStatus.FINALIZED });

    const unfiltered = createPrismaMock({ listRows: [], listTotal: 0 });
    await unfiltered.repository.listInvoices(defaultListQuery);

    expect(firstArg(filtered.invoiceFindMany, "invoice.findMany").where).toEqual({
      tenantId: TENANT_ID,
      status: InvoiceStatus.FINALIZED
    });
    // The count must carry the same predicate, or `total` describes a different row set than
    // the page does.
    expect(firstArg(filtered.invoiceCount, "invoice.count").where).toEqual({
      tenantId: TENANT_ID,
      status: InvoiceStatus.FINALIZED
    });

    // Key-level, not `toEqual`: `toEqual` treats `{ tenantId, status: undefined }` as equal to
    // `{ tenantId }`, so it would not notice an explicit `status: undefined` being sent.
    const unfilteredWhere = firstArg(unfiltered.invoiceFindMany, "invoice.findMany").where;
    expect(Object.keys(unfilteredWhere as Record<string, unknown>)).toEqual(["tenantId"]);
  });

  it("BU74c - pages with skip/take and sorts periodStart desc then id desc", async () => {
    const mock = createPrismaMock({ listRows: [], listTotal: LIST_TOTAL_COUNT });

    await mock.repository.listInvoices({
      page: LIST_PAGE_TWO,
      pageSize: LIST_PAGE_SIZE_TWO
    });

    const args = firstArg(mock.invoiceFindMany, "invoice.findMany");
    expect(args.skip).toBe((LIST_PAGE_TWO - 1) * LIST_PAGE_SIZE_TWO);
    expect(args.take).toBe(LIST_PAGE_SIZE_TWO);
    // The `id` tie-break is not cosmetic. `Invoice @@unique([tenantId, periodStart, periodEnd])`
    // leaves `periodStart` non-unique, and offset pagination over a non-total order lets two
    // rows sharing a period swap between pages -- silently skipping one and repeating another.
    //
    // **This assertion is the guard.** It pins the `orderBy` structurally and does not touch the
    // database. The mutation is deleting `{ [SORT_FIELD_ID]: desc }` from `INVOICE_LIST_ORDER_BY`
    // (`invoice.repository.ts`) and running the billing suite; this case has reddened under it in
    // every run in which its own outcome was recorded -- 14 of the 20-run exploratory series,
    // the other six recording only BI16. No gate has seen it survive the mutation.
    //
    // **A behavioural case exists -- BI16 (`tests/billing.integration.test.ts`) -- and its
    // redness is not reproducible. Do not delete it on the strength of a run in which it stayed
    // green.** Under the same mutation on an unchanged tree, four gates measured BI16 four
    // different ways, and one of them observed it flip from green to red between two consecutive
    // runs with nothing touched.
    //
    // The cause is **not established**, and this comment deliberately does not offer one. Row
    // count in `"Invoice"` was proposed and then refuted; planner statistics move on their own;
    // a per-`OFFSET` plan split was observed inside a single database state, which is enough to
    // rule out labelling a whole run with one plan. Those are observations that did not resolve
    // it. See `.claude/rules/known-gaps.md` S-41. T-047 inherits this fixture.
    //
    // Earlier revisions of this comment asserted, in turn, that BI16 observes the consequence,
    // that only this case reddens, that BI16 stayed green, and that the outcome is conditional on
    // the row count. Each was generalised from one state and each was refuted by the next gate.
    expect(args.orderBy).toEqual([
      { [BILLING_INVOICE_LIST.SORT_FIELD_PERIOD_START]: BILLING_INVOICE_LIST.SORT_DIRECTION_DESC },
      { [BILLING_INVOICE_LIST.SORT_FIELD_ID]: BILLING_INVOICE_LIST.SORT_DIRECTION_DESC }
    ]);
    // Count is not paged: `total` is the size of the whole filtered set, not of the page.
    const countArgs = firstArg(mock.invoiceCount, "invoice.count");
    expect(countArgs).not.toHaveProperty("skip");
    expect(countArgs).not.toHaveProperty("take");
  });

  it("BU74d - runs findMany and count inside one transaction so the page and the total describe the same rows", async () => {
    const mock = createPrismaMock({ listRows: [rawListRow()], listTotal: LIST_TOTAL_COUNT });

    const result = await mock.repository.listInvoices(defaultListQuery);

    // One `$transaction`, not two: a page read and a count read in separate transactions can
    // straddle a concurrent insert and report a `total` the page cannot be a window onto.
    expect(mock.transaction).toHaveBeenCalledTimes(1);
    expect(mock.invoiceFindMany).toHaveBeenCalledTimes(1);
    expect(mock.invoiceCount).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(LIST_TOTAL_COUNT);
  });

  it("BU75 - returns strings and ISO dates, never a Prisma.Decimal or a Date, and preserves a null finalizedAt", async () => {
    const mock = createPrismaMock({
      listRows: [rawListRow(), rawListRow({ finalizedAt: null, status: InvoiceStatus.DRAFT })],
      listTotal: 2
    });

    const { items } = await mock.repository.listInvoices(defaultListQuery);
    const [paid, draft] = items;

    // This is the assertion the HTTP layer cannot make. Measured at Gate 1 with no
    // normalisation present at all: `Prisma.Decimal` defines `toJSON`, so the wire body carries
    // `"totalAmount":"1234567.123456"` either way and `typeof` on the parsed value is
    // `"string"`. A route-level test therefore passes whether or not the leak exists, which is
    // why the catching assertion lives here, below the boundary.
    expect(typeof paid?.totalAmount).toBe("string");
    expect(paid?.totalAmount).toBe(LIST_TOTAL_PRECISE);
    expect(paid?.totalAmount).not.toBeInstanceOf(Prisma.Decimal);
    expect(paid?.periodStart).not.toBeInstanceOf(Date);
    expect(paid?.createdAt).not.toBeInstanceOf(Date);

    expect(paid?.periodStart).toBe(LIST_PERIOD_START_NEWER.toISOString());
    expect(paid?.periodEnd).toBe(LIST_PERIOD_END_NEWER.toISOString());
    expect(paid?.createdAt).toBe(LIST_CREATED_AT.toISOString());
    expect(paid?.finalizedAt).toBe(LIST_FINALIZED_AT.toISOString());

    // `null` is preserved rather than coerced to "" -- a DRAFT invoice has not been finalized,
    // and an empty string would claim it had been, at an unparseable instant.
    expect(draft?.finalizedAt).toBeNull();
  });

  it("BU75b - selects exactly the eight InvoiceHeader columns, so no lineItems and no tenantId can be returned", async () => {
    const mock = createPrismaMock({ listRows: [rawListRow()], listTotal: 1 });

    const { items } = await mock.repository.listInvoices(defaultListQuery);
    const args = firstArg(mock.invoiceFindMany, "invoice.findMany");
    const select = args.select as Record<string, unknown>;

    // An explicit `select` rather than a default read: T-047 owns line items, and an
    // `include: { lineItems: true }` added here would leak rows from a table whose RLS is
    // inert (S-10). Absent by construction, not by omission.
    expect(Object.keys(select).sort()).toEqual([
      "createdAt",
      "currency",
      "finalizedAt",
      "id",
      "periodEnd",
      "periodStart",
      "status",
      "totalAmount"
    ]);
    expect(select).not.toHaveProperty("lineItems");
    expect(select).not.toHaveProperty("tenantId");
    expect(args).not.toHaveProperty("include");

    // And the same eight on the way out, so a widened select would have to be deliberate.
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(Object.keys(select).sort());
  });
});

/**
 * T-047 detail fixtures.
 *
 * `DETAIL_*` values are spelled the way the driver hands a row over -- `Prisma.Decimal` and
 * `Date` -- so the normalisation under test has something real to normalise.
 */
const DETAIL_LINE_ITEM_ID_FIRST = "55555555-5555-4555-8555-555555555551";
const DETAIL_LINE_ITEM_ID_SECOND = "55555555-5555-4555-8555-555555555552";
const DETAIL_QUANTITY = "1000.000000";
const DETAIL_UNIT_PRICE = "0.010000";
const DETAIL_AMOUNT = "10.000000";
/** What `String(Prisma.Decimal)` makes of the three above -- trailing zeros dropped (D5). */
const DETAIL_EXPECTED_QUANTITY = "1000";
const DETAIL_EXPECTED_UNIT_PRICE = "0.01";
const DETAIL_EXPECTED_AMOUNT = "10";

const rawLineItemRow = (id: string, metricKey: string) => ({
  id,
  metricKey,
  quantity: new Prisma.Decimal(DETAIL_QUANTITY),
  unitPrice: new Prisma.Decimal(DETAIL_UNIT_PRICE),
  amount: new Prisma.Decimal(DETAIL_AMOUNT)
});

const rawDetailRow = (overrides: Record<string, unknown> = {}) => ({
  ...rawListRow(),
  lineItems: [
    rawLineItemRow(DETAIL_LINE_ITEM_ID_FIRST, METRIC_API),
    rawLineItemRow(DETAIL_LINE_ITEM_ID_SECOND, METRIC_STORAGE)
  ],
  ...overrides
});

describe("InvoiceRepository.findDetailById", () => {
  it("BU107 - the where is exactly { id, tenantId } with the bound tenant, inside withTenant", async () => {
    const mock = createPrismaMock({ detailRow: rawDetailRow() });

    await mock.repository.findDetailById(LIST_INVOICE_ID_NEWER);

    // Layer 4: the RLS context is the first statement of the transaction the read runs in.
    expect(mock.transaction).toHaveBeenCalledTimes(1);
    expect(String(mock.queryRaw.mock.calls[0]?.[0])).toContain(TENANT_SETTING_NAME);

    const args = firstArg(mock.invoiceFindFirst, "invoice.findFirst");
    expect(args.where).toEqual({ id: LIST_INVOICE_ID_NEWER, tenantId: TENANT_ID });
    // The negative is the load-bearing half: no other tenant id anywhere in the argument tree.
    expect(JSON.stringify(args)).not.toContain(OTHER_TENANT_ID);

    // **Read this before deleting the predicate on the evidence that deleting it is green.**
    // It *is* green: `"Invoice"` has RLS enabled with `invoice_tenant_isolation`, so a foreign
    // id answers `null` with or without the `tenantId` term and no behavioural case can tell
    // the difference (S-46, measured at Gate 1 as probes P1a/P1b -- both `null`). This shape
    // assertion is the only thing that catches the deletion, exactly as `BU98` is for
    // `absorbLateUsage`. `.claude/rules/tenant-isolation.md` requires the predicate regardless:
    // belt and braces, neither alone.
  });

  it("BU108 - selects the eight header columns plus lineItems, never tenantId and never via include", async () => {
    const mock = createPrismaMock({ detailRow: rawDetailRow() });

    const detail = await mock.repository.findDetailById(LIST_INVOICE_ID_NEWER);
    const args = firstArg(mock.invoiceFindFirst, "invoice.findFirst");
    const select = args.select as Record<string, unknown>;

    // The one spelling of this list lives in `tests/integration.constants.ts`; it is written out
    // rather than derived from `INVOICE_HEADER_SELECT`, which would compare the production
    // `select` with itself.
    expect(Object.keys(select).sort()).toEqual([
      ...INTEGRATION_INVOICE_DETAIL.DETAIL_RESPONSE_FIELDS
    ]);
    // `tenantId` stays out for the reason `INVOICE_HEADER_SELECT` already gives, and because
    // conforming to the epic's `invoice.tenantId === req.tenantId` check would require putting
    // it back -- reversing a decision T-046 made deliberately (`BU75b`).
    expect(select).not.toHaveProperty("tenantId");
    // `select` on the nested relation, not `include`: `include` returns every column of
    // `"InvoiceLineItem"`, `invoiceId` included, and grows silently when the table does.
    expect(args).not.toHaveProperty("include");

    const lineItemArgs = select.lineItems as Record<string, unknown>;
    const lineItemSelect = lineItemArgs.select as Record<string, unknown>;
    expect(Object.keys(lineItemSelect).sort()).toEqual([
      ...INTEGRATION_INVOICE_DETAIL.LINE_ITEM_FIELDS
    ]);
    // `invoiceId` is the parent's `id` repeated on every row; echoing it invites a client to
    // key on it and is one more identifier on the wire for nothing.
    expect(lineItemSelect).not.toHaveProperty("invoiceId");

    // And the same keys on the way out, so a widened select would have to be deliberate.
    expect(Object.keys(detail ?? {}).sort()).toEqual(Object.keys(select).sort());
    expect(Object.keys(detail?.lineItems[0] ?? {}).sort()).toEqual(Object.keys(lineItemSelect).sort());
  });

  it("BU109 - never touches tx.invoiceLineItem: line items are reached only through the Invoice relation", async () => {
    const mock = createPrismaMock({ detailRow: rawDetailRow() });

    await mock.repository.findDetailById(LIST_INVOICE_ID_NEWER);

    // **This is the case that makes the routing property a test rather than a grep.**
    // Measured at Gate 1 as `telemetry_app` under tenant B's context: a bare
    // `invoiceLineItem.findMany({ where: { invoiceId: <A's invoice> } })` returned tenant A's
    // two line items with their amounts, and an unfiltered `count()` returned every tenant's
    // rows. `"InvoiceLineItem"` has `relrowsecurity = f` and zero policies (S-10), so the
    // database does not stop that read -- the relation is the entire tenant control.
    //
    // Scope, stated as measured: this catches a **code-level** re-route, because the call
    // surface changes. It does not catch a Prisma-level plan change -- see `findDetailById`'s
    // docblock for the four statement counts that would need re-deriving after a major bump.
    expect(mock.invoiceLineItemFindMany).not.toHaveBeenCalled();
    expect(mock.invoiceLineItemFindUnique).not.toHaveBeenCalled();
    expect(mock.invoiceLineItemCount).not.toHaveBeenCalled();
    expect(mock.invoiceLineItemCreate).not.toHaveBeenCalled();
  });

  it("BU110 - orders line items metricKey asc then id asc, from the constants", async () => {
    const mock = createPrismaMock({ detailRow: rawDetailRow() });

    await mock.repository.findDetailById(LIST_INVOICE_ID_NEWER);

    const select = firstArg(mock.invoiceFindFirst, "invoice.findFirst").select as Record<
      string,
      unknown
    >;
    const lineItemArgs = select.lineItems as Record<string, unknown>;

    // Structural, and it does not touch the database -- which is the point. The behavioural
    // sibling is `BI31`, and the tie-break half of that one depends on the order PostgreSQL
    // happens to hold rows in, which S-41 is the standing record of being non-reproducible.
    // This assertion reddens on the mutation whatever the heap is doing.
    expect(lineItemArgs.orderBy).toEqual([
      { [BILLING_INVOICE_DETAIL.SORT_FIELD_METRIC_KEY]: BILLING_INVOICE_DETAIL.SORT_DIRECTION_ASC },
      { [BILLING_INVOICE_DETAIL.SORT_FIELD_ID]: BILLING_INVOICE_DETAIL.SORT_DIRECTION_ASC }
    ]);
  });

  it("BU111 - normalises every Decimal and Date, and answers null for a miss without throwing", async () => {
    const found = createPrismaMock({ detailRow: rawDetailRow() });
    const detail = await found.repository.findDetailById(LIST_INVOICE_ID_NEWER);

    // The header, on `listInvoices`' contract (D6 reuses its two helpers rather than adding a
    // second pair).
    expect(typeof detail?.totalAmount).toBe("string");
    expect(detail?.totalAmount).toBe(LIST_TOTAL_PRECISE);
    expect(detail?.totalAmount).not.toBeInstanceOf(Prisma.Decimal);
    expect(detail?.periodStart).toBe(LIST_PERIOD_START_NEWER.toISOString());
    expect(detail?.createdAt).not.toBeInstanceOf(Date);

    // The line items are the **second** Decimal surface, which the list endpoint never had --
    // three Decimal columns per row rather than one per invoice.
    const [first, second] = detail?.lineItems ?? [];
    for (const item of [first, second]) {
      expect(typeof item?.quantity).toBe("string");
      expect(typeof item?.unitPrice).toBe("string");
      expect(typeof item?.amount).toBe("string");
      expect(item?.quantity).not.toBeInstanceOf(Prisma.Decimal);
      expect(item?.unitPrice).not.toBeInstanceOf(Prisma.Decimal);
      expect(item?.amount).not.toBeInstanceOf(Prisma.Decimal);
    }
    expect(first?.quantity).toBe(DETAIL_EXPECTED_QUANTITY);
    expect(first?.unitPrice).toBe(DETAIL_EXPECTED_UNIT_PRICE);
    expect(first?.amount).toBe(DETAIL_EXPECTED_AMOUNT);
    expect(first?.metricKey).toBe(METRIC_API);
    expect(second?.metricKey).toBe(METRIC_STORAGE);

    // An invoice with no line items is a valid invoice, not a miss: `lineItems` is `[]`.
    const empty = createPrismaMock({ detailRow: rawDetailRow({ lineItems: [] }) });
    await expect(empty.repository.findDetailById(LIST_INVOICE_ID_NEWER)).resolves.toMatchObject({
      lineItems: []
    });

    // A miss is `null` from this layer -- no throw. Mapping `null` to a `404` is the service's
    // job, so the repository stays a data accessor and the status lives in one place.
    const missing = createPrismaMock({ detailRow: null });
    await expect(missing.repository.findDetailById(LIST_INVOICE_ID_NEWER)).resolves.toBeNull();
  });
});
