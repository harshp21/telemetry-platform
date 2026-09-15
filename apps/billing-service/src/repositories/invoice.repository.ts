import { BILLING_DATABASE, BILLING_METERING } from "../constants";
import { UsageLinesChangedError } from "../errors";
import { TenantScopedRepository } from "./base.repository";

/** One metric's unbilled total for the period, already normalised out of `Prisma.Decimal` (D8). */
export interface UnbilledMetricTotal {
  readonly metricKey: string;
  readonly totalQuantity: string;
}

/**
 * The unbilled usage for a period: the per-metric totals **and** the exact `UsageLine` ids
 * those totals were computed from.
 *
 * Returning the ids is the point. The write marks precisely the rows the pricing saw, instead
 * of re-deriving the set from the range predicate at write time -- a set that may have moved.
 */
export interface UnbilledUsage {
  readonly totals: readonly UnbilledMetricTotal[];
  readonly usageLineIds: readonly string[];
}

export interface DraftInvoiceLineItemInput {
  readonly metricKey: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly amount: string;
}

export interface CreateDraftInvoiceInput {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly currency: string;
  readonly totalAmount: string;
  readonly lineItems: readonly DraftInvoiceLineItemInput[];
  readonly usageLineIds: readonly string[];
}

/**
 * The outcome of a generate attempt.
 *
 * `created` distinguishes the row this call inserted from one a concurrent caller inserted
 * first and this call found on the unique-violation re-read. The controller maps it to `201`
 * versus `200`, so an idempotent hit is never reported as a creation.
 */
export interface DraftInvoiceResult {
  readonly invoiceId: string;
  readonly created: boolean;
}

const isUniqueConstraintError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === "string" && maybeCode === BILLING_DATABASE.UNIQUE_VIOLATION_CODE;
};

const CHUNK_SIZE = BILLING_METERING.BILLED_UPDATE_CHUNK_SIZE;

/** `Decimal(18,6)` exceeds IEEE-754 safe precision, so amounts cross this boundary as strings. */
const toAmountString = (value: unknown): string => String(value ?? 0);

/**
 * Tenant-scoped reads and the one write that invoice generation performs.
 *
 * Three properties hold across every method here, and they are the ones
 * `.claude/rules/tenant-isolation.md` asks for:
 *
 * 1. Every query runs inside `withTenant`, so the RLS policies on `"Tenant"`, `"Invoice"` and
 *    `"UsageLine"` are active.
 * 2. Every predicate carries an explicit tenant, taken from `this.where({})` -- the
 *    constructor-bound context -- and no method has a `tenantId` parameter through which a
 *    caller could supply a different one.
 * 3. **No method here takes a bare `invoiceId`** -- checkable, and checked:
 *    `grep -n "^  async" invoice.repository.ts` lists four signatures and none has one, and
 *    every `invoiceId` in the file is a returned field or a comment. This is a property of the
 *    shape as shipped, not something the type system forbids: nothing stops a later method
 *    adding the parameter, which is why it is written down here. Line items are written through
 *    Prisma's nested `create` on the invoice, and this task reads none. That matters more here
 *    than it would elsewhere: `"InvoiceLineItem"` has `relrowsecurity = f` and no policy (S-10), and no
 *    `tenantId` column to write one against, so the join through `"Invoice"` is its *only*
 *    tenant control. Measured at Gate 1 inside the transaction this code writes in: after
 *    creating an invoice and its line item under tenant A and switching `app.tenant_id`, the
 *    invoice disappeared and the line item did not -- re-measured here by BI9 itself, which
 *    performs exactly that switch against rows this repository wrote. T-045 ships the platform's first rows into
 *    that table; `billing.integration.test.ts` case BI9 pins the gap as it is today so that
 *    closing S-10 turns it red rather than passing unnoticed. T-047 inherits this constraint.
 *
 * Date predicates go through the ORM only -- never `$queryRaw` -- for the reason recorded on
 * `MeterRepository` and in `CLAUDE.md` § *Raw SQL and timestamps*.
 */
export class InvoiceRepository extends TenantScopedRepository {
  /**
   * Whether the bound tenant is visible (step 1).
   *
   * Read through the tenant-scoped connection on purpose: an absent tenant and one the RLS
   * policy hides give the same answer, so this cannot be used as a cross-tenant existence
   * oracle. A soft-deleted tenant (`Tenant.deletedAt`) still counts as existing -- nothing in
   * the platform sets that column today, and inventing a billing-time policy for it is a
   * product decision this task does not make.
   */
  async tenantExists(): Promise<boolean> {
    const { tenantId } = this.where({});

    return this.withTenant(async (tx) => {
      const count = await tx.tenant.count({ where: { id: tenantId } });
      return count > 0;
    });
  }

  /**
   * The invoice already covering this exact period, if any (step 2).
   *
   * `findUnique` on `Invoice @@unique([tenantId, periodStart, periodEnd])`. The compound-unique
   * input needs the tenant spelled out, and it comes from the bound context like every other
   * predicate in this file.
   */
  async findByPeriod(periodStart: Date, periodEnd: Date): Promise<string | null> {
    const { tenantId } = this.where({});

    return this.withTenant(async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { tenantId_periodStart_periodEnd: { tenantId, periodStart, periodEnd } },
        select: { id: true }
      });

      return invoice?.id ?? null;
    });
  }

  /**
   * Unbilled usage in `[periodStart, periodEnd)`, grouped by metric key (steps 3 and 5).
   *
   * Half-open rather than closed, and that is decidable from a fact the epic does not mention:
   * worker writes `periodStart === periodEnd === occurredAt`, so a `UsageLine` period is a
   * point instant. A closed upper bound would let an event at exactly the period end fall into
   * two consecutive invoices, arbitrated only by whichever ran first.
   *
   * The aggregate and the id list run over the same predicate inside one transaction, so the
   * totals and the ids cannot describe different row sets.
   */
  async sumUnbilledByMetricKey(periodStart: Date, periodEnd: Date): Promise<UnbilledUsage> {
    const where = this.where({
      billed: false,
      periodStart: { gte: periodStart, lt: periodEnd }
    });

    return this.withTenant(async (tx) => {
      const grouped = await tx.usageLine.groupBy({
        by: ["metricKey"],
        where,
        _sum: { quantity: true },
        orderBy: { metricKey: "asc" }
      });

      const lines = await tx.usageLine.findMany({ where, select: { id: true } });

      return {
        totals: grouped.map((row) => ({
          metricKey: row.metricKey,
          totalQuantity: toAmountString(row._sum.quantity)
        })),
        usageLineIds: lines.map((line) => line.id)
      };
    });
  }

  /**
   * Writes the draft invoice, its line items and the billed flags in one transaction (step 8).
   *
   * The `updateMany` count assertion is a **detector of a concurrent writer, not a weaker
   * substitute for a longer transaction**. A single transaction spanning the read and the write
   * would serialise against a competing generate -- the second caller blocks, then proceeds,
   * and nobody learns anything. Comparing the marked count against the ids we priced instead
   * *notices*: if another process billed any of them in between, the count is short, the throw
   * escapes `$transaction`, the invoice and its line items roll back with it, and the caller
   * gets a diagnosable failure rather than a quietly different invoice.
   *
   * The existence check in `findByPeriod` runs in a different transaction, so it does not
   * serialise two concurrent identical requests. `Invoice @@unique([tenantId, periodStart,
   * periodEnd])` does, and the loser lands in the catch below.
   */
  async createDraftInvoice(input: CreateDraftInvoiceInput): Promise<DraftInvoiceResult> {
    const expectedCount = input.usageLineIds.length;

    try {
      const invoiceId = await this.withTenant(async (tx) => {
        const invoice = await tx.invoice.create({
          data: {
            ...this.where({}),
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            status: BILLING_METERING.INVOICE_STATUS_DRAFT,
            totalAmount: input.totalAmount,
            currency: input.currency,
            // Nested, so the line items are created against the invoice this statement is
            // inserting and never against an `invoiceId` that arrived from anywhere else.
            lineItems: {
              create: input.lineItems.map((item) => ({
                metricKey: item.metricKey,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                amount: item.amount
              }))
            }
          },
          select: { id: true }
        });

        // Chunked because Prisma expands `id: { in: [...] }` to one bind variable per id and
        // PostgreSQL caps a prepared statement at 32 767 of them -- measured, 32 764 ids pass
        // and 32 765 raise `P2035`. See `BILLING_METERING.BILLED_UPDATE_CHUNK_SIZE` for the
        // full measurement and for why the chunk is 1 000 rather than nearer the ceiling.
        //
        // The count assertion is unchanged in meaning and deliberately so: the counts are
        // summed across every chunk and compared against the **whole** id set, never per chunk.
        // A per-chunk comparison would be a different, weaker guard -- it would still catch a
        // concurrent writer, but it would report the wrong numbers and would stop being the
        // property BU24 and BU26 pin. BU27b is the case that goes red if the sum is dropped.
        let markedCount = 0;
        for (let offset = 0; offset < expectedCount; offset += CHUNK_SIZE) {
          const chunk = input.usageLineIds.slice(offset, offset + CHUNK_SIZE);
          const marked = await tx.usageLine.updateMany({
            where: this.where({ id: { in: [...chunk] }, billed: false }),
            data: { billed: true }
          });
          markedCount += marked.count;
        }

        if (markedCount !== expectedCount) {
          throw new UsageLinesChangedError(expectedCount, markedCount);
        }

        return invoice.id;
      });

      return { invoiceId, created: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      // `meta.target` is `null` on the `telemetry_app` connection this service runs as -- the
      // connection role is the controlling variable, not the constraint count or the Prisma
      // version, and on the owner connection the same violation *does* name the constraint. So
      // an owner-connection observation must not be used to justify a `meta.target` branch
      // here; see `BILLING_METERING`'s sibling note in `constants.ts` for the measurement.
      // Re-reading by period answers the only question that matters: is there now an invoice
      // for this period? If there is not, this was some other unique violation and must not be
      // reported as an idempotent hit.
      const existingInvoiceId = await this.findByPeriod(input.periodStart, input.periodEnd);
      if (existingInvoiceId === null) {
        throw error;
      }

      return { invoiceId: existingInvoiceId, created: false };
    }
  }
}
