import { Prisma } from "@prisma/client";
import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import type { ActiveMeter, MeterRepository } from "../repositories/meter.repository";
import type {
  DraftInvoiceLineItemInput,
  InvoiceRepository,
  UnbilledMetricTotal
} from "../repositories/invoice.repository";
import { MeterCurrencyConflictError, MeterNotFoundError, TenantNotFoundError } from "../errors";
import type { GenerateInvoiceRequest } from "../validators/generate-invoice.validator";

/**
 * Builds a repository bound to a single tenant.
 *
 * Tenant-scoped repositories are per-request by construction -- `tenantId` is a constructor
 * argument -- so the container injects factories, never singletons. A singleton would pin one
 * tenant process-wide (`.claude/rules/tenant-isolation.md`).
 */
export type MeterRepositoryFactory = (tenantId: TenantId) => MeterRepository;
export type InvoiceRepositoryFactory = (tenantId: TenantId) => InvoiceRepository;

/**
 * What the endpoint answers with.
 *
 * `invoiceId: null` is the "no billable usage" case; `created` separates the invoice this call
 * inserted (`201`) from one that already existed (`200`). The two are distinguishable without a
 * `message` field, which is why the epic's `message` in a success body is dropped.
 */
export interface GenerateInvoiceResult {
  readonly invoiceId: string | null;
  readonly created: boolean;
}

/**
 * Invoice generation for `POST /v1/internal/billing/generate`.
 *
 * The order of operations is the contract, not an implementation detail:
 *
 * 1. tenant exists, else `404`;
 * 2. an invoice for this exact period already exists, else continue -- and **return before any
 *    further read**, because a second call would otherwise find the lines the first marked
 *    billed and answer "no billable usage" for a period that has an invoice;
 * 3. unbilled usage in `[periodStart, periodEnd)`, grouped, with its row ids captured;
 * 4. the rate card in force at `periodStart`;
 * 5. **both D1 refusals, before anything is written**;
 * 6. pricing, in `Prisma.Decimal`;
 * 7. one write.
 *
 * Pricing is flat only: `amount = summedQuantity x unitPrice` (Q2, decided in
 * `docs/epics/README.md`). `Meter.tierJson` is not read. Graduated and volume tiering give
 * different totals for the same tier table and the column records neither, so that is a
 * product decision a later task must answer before writing code against it.
 */
export class BillingService {
  constructor(
    private readonly createMeterRepository: MeterRepositoryFactory,
    private readonly createInvoiceRepository: InvoiceRepositoryFactory,
    private readonly logger: Logger
  ) {}

  async generateInvoice(request: GenerateInvoiceRequest): Promise<GenerateInvoiceResult> {
    const { tenantId } = request;
    // Normalised to instants here, once. Both bounds carry an explicit offset (`iso8601Schema`)
    // and every downstream predicate is an ORM one, so the comparison is in UTC on any server.
    const periodStart = new Date(request.periodStart);
    const periodEnd = new Date(request.periodEnd);

    const invoiceRepository = this.createInvoiceRepository(tenantId);

    if (!(await invoiceRepository.tenantExists())) {
      throw new TenantNotFoundError();
    }

    const existingInvoiceId = await invoiceRepository.findByPeriod(periodStart, periodEnd);
    if (existingInvoiceId !== null) {
      this.logger.debug(
        { tenantId, invoiceId: existingInvoiceId },
        "Invoice already exists for period; returning it unchanged"
      );
      return { invoiceId: existingInvoiceId, created: false };
    }

    const unbilled = await invoiceRepository.sumUnbilledByMetricKey(periodStart, periodEnd);

    // The destructure is both the emptiness check and the narrowing: with `firstTotal` defined,
    // the invoice's currency can be read from a meter without a fallback branch that no input
    // can reach.
    const [firstTotal, ...remainingTotals] = unbilled.totals;
    if (firstTotal === undefined) {
      this.logger.debug({ tenantId }, "No billable usage for period");
      return { invoiceId: null, created: false };
    }

    const metricKeys = unbilled.totals.map((total) => total.metricKey);
    const meters = await this.createMeterRepository(tenantId).findActiveAsOf(
      metricKeys,
      periodStart
    );
    const metersByKey = new Map(meters.map((meter) => [meter.metricKey, meter]));

    const missingMetricKeys = metricKeys.filter((metricKey) => !metersByKey.has(metricKey));
    if (missingMetricKeys.length > 0) {
      throw new MeterNotFoundError(missingMetricKeys);
    }

    const currencies = [...new Set(meters.map((meter) => meter.currency))];
    if (currencies.length > 1) {
      // `Invoice.currency` is one column, so there is no correct single answer here. Picking
      // one would be silently wrong; refusing is visibly wrong, and somebody fixes it.
      throw new MeterCurrencyConflictError(currencies);
    }

    const lineItems = [firstTotal, ...remainingTotals].map((total) =>
      this.priceLine(total, metersByKey)
    );
    const totalAmount = lineItems.reduce(
      (running, item) => running.add(item.amount),
      new Prisma.Decimal(0)
    );

    const result = await invoiceRepository.createDraftInvoice({
      periodStart,
      periodEnd,
      // `currencies[0]` is the same value and is already computed, but it types as
      // `string | undefined` under `noUncheckedIndexedAccess`, which would need either a
      // non-null assertion or a branch no input can reach. This is a typing device, **not** a
      // third guard on the meter lookup -- the batch check above already guarantees it resolves.
      currency: this.meterFor(firstTotal.metricKey, metersByKey).currency,
      totalAmount: totalAmount.toString(),
      lineItems,
      usageLineIds: unbilled.usageLineIds
    });

    this.logger.debug(
      { tenantId, invoiceId: result.invoiceId, created: result.created, lines: lineItems.length },
      "Draft invoice generated"
    );

    return result;
  }

  /**
   * Flat pricing in `Prisma.Decimal`, normalised straight back to string.
   *
   * Never `number`: `1234567.123456 x 0.000001` is `1.234567123456` in Decimal and
   * `1.2345671234559998` in IEEE-754, and both columns are `Decimal(18,6)`.
   */
  private priceLine(
    total: UnbilledMetricTotal,
    metersByKey: ReadonlyMap<string, ActiveMeter>
  ): DraftInvoiceLineItemInput {
    const meter = this.meterFor(total.metricKey, metersByKey);
    const amount = new Prisma.Decimal(total.totalQuantity).mul(new Prisma.Decimal(meter.unitPrice));

    return {
      metricKey: total.metricKey,
      quantity: total.totalQuantity,
      unitPrice: meter.unitPrice,
      amount: amount.toString()
    };
  }

  /**
   * Looks a meter up or refuses.
   *
   * A second guard on the same invariant, not a restatement of the batch check above. Measured
   * rather than assumed: deleting the batch check leaves every case in
   * `billing.service.unit.test.ts` green **except BU40b**, because this raise still fires for
   * the first key it cannot resolve. What the batch check adds is naming *every* unpriceable
   * key, which is what BU40b pins -- and what an operator needs, since the next action is to
   * create those meters.
   */
  private meterFor(metricKey: string, metersByKey: ReadonlyMap<string, ActiveMeter>): ActiveMeter {
    const meter = metersByKey.get(metricKey);
    if (meter === undefined) {
      throw new MeterNotFoundError([metricKey]);
    }
    return meter;
  }
}
