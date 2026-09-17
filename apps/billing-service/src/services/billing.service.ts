import { Prisma } from "@prisma/client";
import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import type { ActiveMeter, MeterRepository } from "../repositories/meter.repository";
import type {
  DraftInvoiceLineItemInput,
  InvoiceRepository,
  UnbilledMetricTotal
} from "../repositories/invoice.repository";
import {
  InvoiceImmutableError,
  MeterCurrencyConflictError,
  MeterNotFoundError,
  TenantNotFoundError
} from "../errors";
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
 *
 * `absorbed` (S-45) separates a genuine no-op from a call that added late usage to an invoice
 * that already existed. Both are `200` with the same `invoiceId`, so without this flag an
 * operator cannot tell "nothing to do" from "we just retro-billed forty lines onto yesterday's
 * invoice" -- and the *rate* of absorptions is the signal that the ingest pipeline is lagging.
 * `201` still means, and only means, that this call inserted the invoice; an absorption is a
 * `200`. The **count** of absorbed lines goes to billing's log line rather than into the
 * envelope: `created` is a boolean and its sibling should be one, and magnitude belongs where
 * an operator reads it (D5).
 *
 * Additive and non-breaking for the one caller there is: worker's `BillingClientService` casts
 * the body rather than parsing it and reads `body?.data?.invoiceId ?? null`, measured at Gate 1
 * against the real client and the real job with this exact field present (probe H).
 * worker-service is not changed by this task, so *worker's* per-tenant log line still prints
 * only `created` -- accepted and stated rather than worked around.
 */
export interface GenerateInvoiceResult {
  readonly invoiceId: string | null;
  readonly created: boolean;
  readonly absorbed: boolean;
}

/**
 * Steps 3-6 for one period: what is unbilled, priced against the rate card in force.
 *
 * `null` means there is nothing unbilled -- which is a different outcome from "priced to zero"
 * and is why this is a nullable result rather than an empty line list.
 */
interface PricedUsage {
  readonly currency: string;
  readonly totalAmount: string;
  readonly lineItems: readonly DraftInvoiceLineItemInput[];
  readonly usageLineIds: readonly string[];
}

/**
 * Invoice generation for `POST /v1/internal/billing/generate`.
 *
 * The order of operations is the contract, not an implementation detail:
 *
 * 1. tenant exists, else `404`;
 * 2. whether an invoice for this exact period already exists -- a **branch**, not a return;
 * 3. unbilled usage in `[periodStart, periodEnd)`, grouped, with its row ids captured;
 * 4. the rate card in force at `periodStart`;
 * 5. **both D1 refusals, before anything is written**;
 * 6. pricing, in `Prisma.Decimal`;
 * 7. one write -- an insert when there was no invoice, an absorption into that invoice when
 *    there was and unbilled usage remains, and nothing at all when there was and none does.
 *
 * **Step 2 used to return before step 3 ever ran, and that was S-45.** The reason recorded for
 * it was that a second call would otherwise find the lines the first marked billed and answer
 * "no billable usage" for a period that has an invoice. The *outcome* that argument protects is
 * preserved -- an empty unbilled set on an already-invoiced period now returns the existing
 * invoice with `created: false, absorbed: false`, never `invoiceId: null` -- but the reason no
 * longer justifies returning early, because the set is only empty when there is genuinely
 * nothing to bill. What the early return actually cost was every `UsageLine` that arrived after
 * its own window had been invoiced: worker stamps a line with the event's instant, the nightly
 * job runs at 02:00 for a day that ended at midnight, and any row landing in that gap stayed
 * `billed = false` for ever while the job reported success. `BI22` is that case.
 *
 * **The new ordering also changes what a re-run can answer, and that is a contract change to
 * the one caller.** Before S-45, `findByPeriod !== null` returned `200` unconditionally. Now
 * steps 3-5 run first on that branch, so a re-run of an already-invoiced period can throw
 * `MeterNotFoundError` or `MeterCurrencyConflictError` and answer **`422`** where it always
 * answered `200` -- reachable whenever a late row carries a `metricKey` with no active meter.
 * `BU97` pins it deliberately: a loud refusal beats silently skipping usage, which is D1's own
 * argument. The operational consequence is that worker's nightly job counts that tenant
 * `failed: 1`, because `billing-client.service.ts` throws on any status that is not `200`/`201`.
 * Recorded here and in known-gaps S-45 rather than left to be discovered from a job report.
 *
 * The price of the new ordering is one extra grouped read per tenant per re-run of an
 * already-billed period (D7). `UsageLine` carries `UsageLine_tenantId_periodStart_periodEnd_idx`
 * and `UsageLine_tenantId_billed_idx`, so the predicate has index candidates -- **which is not
 * a claim of index coverage**: no `EXPLAIN` at production volume was run and the tables were
 * empty when this was written, so the planner's actual choice here is unmeasured.
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
    const priced = await this.readAndPrice(tenantId, invoiceRepository, periodStart, periodEnd);

    if (existingInvoiceId !== null) {
      return this.absorbOrLeave(
        tenantId,
        invoiceRepository,
        existingInvoiceId,
        priced,
        periodStart,
        periodEnd
      );
    }

    if (priced === null) {
      this.logger.debug({ tenantId }, "No billable usage for period");
      return { invoiceId: null, created: false, absorbed: false };
    }

    const result = await invoiceRepository.createDraftInvoice({
      periodStart,
      periodEnd,
      currency: priced.currency,
      totalAmount: priced.totalAmount,
      lineItems: priced.lineItems,
      usageLineIds: priced.usageLineIds
    });

    if (result.created) {
      this.logger.debug(
        { tenantId, invoiceId: result.invoiceId, lines: priced.lineItems.length },
        "Draft invoice generated"
      );
      return { invoiceId: result.invoiceId, created: true, absorbed: false };
    }

    // **The lost insert race (D6).** A concurrent caller won, so `createDraftInvoice` caught the
    // unique violation, re-read by period and returned its id -- *after* this call's own
    // transaction, including its billed update, had rolled back. Normally the winner billed the
    // same rows, because both callers read the same set. If this one read a **superset** -- a
    // row landed between the two reads -- the extra rows are still unbilled, and returning here
    // would be this task's own defect reached through a different door. So the return routes
    // into the absorb branch instead.
    //
    // One pass, not a loop: the second write is an `update`, which has no unique constraint to
    // violate. The re-read is deliberate -- the set priced above is stale, since the winner has
    // billed most of it, and absorbing it would fail the count assertion rather than bill what
    // is left.
    //
    // **Unit coverage only** (`BU94`). Driving a genuine insert race needs the infrastructure
    // S-38 records as missing, and S-38's own warning is that the obvious `Promise.all` case
    // passes by serialising without ever touching the branch. **S-38 is not closed by this**;
    // it gains a second consumer of that path.
    const remaining = await this.readAndPrice(
      tenantId,
      invoiceRepository,
      periodStart,
      periodEnd
    );
    return this.absorbOrLeave(
      tenantId,
      invoiceRepository,
      result.invoiceId,
      remaining,
      periodStart,
      periodEnd
    );
  }

  /**
   * Steps 3-6: read what is unbilled and price it, or answer `null` when there is none.
   *
   * Hoisted above the create/absorb decision so both branches run the identical reads and the
   * identical D1 refusals. Duplicating them per branch is how an unmetered late metric would
   * come to be silently skipped on one path and refused on the other -- `BU97` exists for that.
   */
  private async readAndPrice(
    tenantId: TenantId,
    invoiceRepository: InvoiceRepository,
    periodStart: Date,
    periodEnd: Date
  ): Promise<PricedUsage | null> {
    const unbilled = await invoiceRepository.sumUnbilledByMetricKey(periodStart, periodEnd);

    // The destructure is both the emptiness check and the narrowing: with `firstTotal` defined,
    // the invoice's currency can be read from a meter without a fallback branch that no input
    // can reach.
    const [firstTotal, ...remainingTotals] = unbilled.totals;
    if (firstTotal === undefined) {
      return null;
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

    return {
      // `currencies[0]` is the same value and is already computed, but it types as
      // `string | undefined` under `noUncheckedIndexedAccess`, which would need either a
      // non-null assertion or a branch no input can reach. This is a typing device, **not** a
      // third guard on the meter lookup -- the batch check above already guarantees it resolves.
      currency: this.meterFor(firstTotal.metricKey, metersByKey).currency,
      totalAmount: totalAmount.toString(),
      lineItems,
      usageLineIds: unbilled.usageLineIds
    };
  }

  /**
   * Step 7 for a period that already has an invoice: absorb the late usage, or leave it alone.
   *
   * **No invoice id is handed to the repository.** `absorbLateUsage` resolves the invoice itself
   * from `tenantId_periodStart_periodEnd` under its own bound tenant, so a foreign invoice
   * cannot be named from here -- which matters because `"InvoiceLineItem"` has `relrowsecurity
   * = f`, no policy and no `tenantId` column (S-10), making the application route the entire
   * tenant control on that write. The `existingInvoiceId` below is used only to answer the
   * caller on the no-op path.
   */
  private async absorbOrLeave(
    tenantId: TenantId,
    invoiceRepository: InvoiceRepository,
    existingInvoiceId: string,
    priced: PricedUsage | null,
    periodStart: Date,
    periodEnd: Date
  ): Promise<GenerateInvoiceResult> {
    if (priced === null) {
      this.logger.debug(
        { tenantId, invoiceId: existingInvoiceId },
        "Invoice already exists for period and no unbilled usage remains; returning it unchanged"
      );
      return { invoiceId: existingInvoiceId, created: false, absorbed: false };
    }

    try {
      const absorbed = await invoiceRepository.absorbLateUsage({
        periodStart,
        periodEnd,
        totalAmountDelta: priced.totalAmount,
        lineItems: priced.lineItems,
        usageLineIds: priced.usageLineIds
      });

      // `info`, not `debug`: this is the operator-facing signal that late usage exists at all,
      // and the count is here rather than in the response envelope (D5).
      this.logger.info(
        {
          tenantId,
          invoiceId: absorbed.invoiceId,
          lines: priced.lineItems.length,
          usageLines: priced.usageLineIds.length,
          delta: priced.totalAmount,
          totalAmount: absorbed.totalAmount
        },
        "Absorbed late usage into an existing invoice"
      );

      return { invoiceId: absorbed.invoiceId, created: false, absorbed: true };
    } catch (error) {
      if (error instanceof InvoiceImmutableError) {
        // The error body is `{ code, message }` like every other error this service emits, so
        // the invoice id and the status the epic puts in the body go here instead, where an
        // operator reads them (divergence E1).
        this.logger.warn(
          {
            tenantId,
            invoiceId: error.invoiceId,
            currentStatus: error.currentStatus,
            lines: priced.lineItems.length
          },
          "Refused to absorb late usage into a non-draft invoice"
        );
      }
      throw error;
    }
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
