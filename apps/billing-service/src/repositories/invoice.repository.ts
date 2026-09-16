import type { InvoiceStatus } from "@prisma/client";
import { BILLING_DATABASE, BILLING_INVOICE_LIST, BILLING_METERING } from "../constants";
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
 * One invoice as the list endpoint returns it -- the header, never the line items.
 *
 * **Every field is a string** (D5). `Invoice.totalAmount` is `Decimal(18,6)`, which exceeds
 * IEEE-754 safe precision, and the three timestamp columns arrive as `Date`s; both are
 * normalised here so neither a `Prisma.Decimal` nor a `Date` ever leaves this repository.
 *
 * `finalizedAt` keeps its `null`: a DRAFT invoice has not been finalized, and `""` would claim
 * it had been, at an instant nothing can parse.
 *
 * Line items are absent structurally, not by omission -- see `INVOICE_HEADER_SELECT`.
 */
export interface InvoiceHeader {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: InvoiceStatus;
  readonly totalAmount: string;
  readonly currency: string;
  readonly createdAt: string;
  readonly finalizedAt: string | null;
}

/**
 * The list query, **with no `tenantId` field and deliberately so**.
 *
 * The tenant comes from `this.where({})`, i.e. the constructor-bound context, so there is no
 * caller-supplied value it could be taken from. `where<T extends { tenantId?: never }>` on the
 * base class turns the *use* of such a field into a compile error rather than a review catch --
 * see the three probes below for exactly how far that reaches.
 *
 * T-047 and T-048 should inherit this shape -- identifiers in, tenant from context. The epic's
 * declared `findById(id, tenantId)` and `update(id, tenantId, data)` signatures are reported as
 * a divergence rather than followed -- but as a *convention*, not as a type-level impossibility.
 * Measured at T-046 Gate 3 rework, three probes against a temporary subclass of this base class,
 * each one `pnpm --filter @telemetry/billing-service typecheck`:
 *
 * - `async findById(id: string, tenantId: TenantId)` calling `this.where({ id })` and ignoring
 *   the parameter: **compiles, zero errors**. The epic's signature is implementable.
 * - the same method calling `this.where({ id, tenantId })`:
 *   `error TS2322: Type 'TenantId' is not assignable to type 'undefined'.` (TS2322, not the
 *   TS2345 that `src/types/index.ts`'s factory claim cites -- different constraint, different
 *   error.)
 * - the same method building the predicate by hand, `where: { id, tenantId }`, never touching
 *   `this.where`: **compiles, zero errors**.
 *
 * So what `where<T extends { tenantId?: never }>` rejects is feeding a caller-supplied tenant
 * *into `this.where(...)`*. It does not stop the parameter being declared, and it does not stop
 * a hand-built predicate carrying it. The guard is real and it is at that one call site; the
 * reason to keep tenant out of the signature is that a parameter nobody can supply cannot be
 * supplied wrongly, which is a design choice this file makes rather than one the compiler makes
 * for it.
 */
export interface ListInvoicesQuery {
  readonly status?: InvoiceStatus;
  readonly page: number;
  readonly pageSize: number;
}

/** What one page of the list answers with: the window, plus the size of the whole filtered set. */
export interface InvoiceListPage {
  readonly items: readonly InvoiceHeader[];
  readonly total: number;
}

/**
 * The exact eight columns of `InvoiceHeader`.
 *
 * An explicit `select`, not a default read plus a `delete`: `tenantId` is not returned (the
 * caller already knows it and echoing it invites a client to key on it), and `lineItems` is
 * not reachable at all. That last point matters more than tidiness -- `"InvoiceLineItem"` has
 * `relrowsecurity = f` and no policy (S-10) and no `tenantId` column of its own, so an
 * `include` added here would return rows whose only tenant control is the join. T-047 owns
 * that decision and must read S-10 before making it.
 */
const INVOICE_HEADER_SELECT = {
  id: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  totalAmount: true,
  currency: true,
  createdAt: true,
  finalizedAt: true
} as const;

/** `periodStart DESC, id DESC` (D4). See `BILLING_INVOICE_LIST` for why the tie-break exists. */
const INVOICE_LIST_ORDER_BY = [
  { [BILLING_INVOICE_LIST.SORT_FIELD_PERIOD_START]: BILLING_INVOICE_LIST.SORT_DIRECTION_DESC },
  { [BILLING_INVOICE_LIST.SORT_FIELD_ID]: BILLING_INVOICE_LIST.SORT_DIRECTION_DESC }
] as const;

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

/**
 * `Decimal(18,6)` exceeds IEEE-754 safe precision, so amounts cross this boundary as strings.
 *
 * **Not fixed-scale, and deliberately so.** `String` on a `Prisma.Decimal` drops trailing zeros:
 * measured through `@prisma/client` in this package, `String(new Prisma.Decimal("10.500000"))` is
 * `"10.5"` and `String(new Prisma.Decimal("4.000000"))` is `"4"`. No precision is lost and the
 * contract is `string`, so T-046's QA raised it as a NIT and it was deferred rather than changed
 * (see `docs/plans/t-046-invoice-list-endpoint.md`, Gate-5 NIT dispositions). T-047 inherits this
 * helper: if the detail endpoint or a UI needs `"10.500000"`, that is a formatting decision to
 * make once here, for both endpoints, not a second helper.
 */
const toAmountString = (value: unknown): string => String(value ?? 0);

/** Timestamps cross the same boundary as ISO-8601 UTC strings, preserving an absent value. */
const toIsoString = (value: Date): string => value.toISOString();

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
 *    `grep -n "^  async" invoice.repository.ts` lists five signatures and none has one, and
 *    every `invoiceId` in the file is a local binding, a returned field or a comment -- never a
 *    parameter. (Re-run at T-046 Gate 3 rework: `tenantExists`, `findByPeriod`,
 *    `sumUnbilledByMetricKey`, `createDraftInvoice`, `listInvoices`. T-046 added the fifth and
 *    the count said four until this line was corrected -- so re-run it rather than trusting the
 *    numeral, which is the S-33 failure this comment is itself an instance of.) This is a
 *    property of the shape as shipped, not something the type system forbids: nothing stops a
 *    later method adding the parameter, which is why it is written down here. Line items are
 *    written through Prisma's nested `create` on the invoice, and this task reads none. That
 *    matters more here than it would elsewhere: `"InvoiceLineItem"` has `relrowsecurity = f`
 *    and no policy (S-10), and no `tenantId` column to write one against, so the join through
 *    `"Invoice"` is its *only* tenant control. Measured at Gate 1 inside the transaction this code writes in: after
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

  /**
   * One page of the bound tenant's invoice headers (T-046).
   *
   * Both statements run inside a single `withTenant` transaction, so the RLS context is set
   * once and the page and the `total` describe the same row set -- two transactions could
   * straddle a concurrent insert and report a total the page is not a window onto.
   *
   * The `status` predicate is omitted entirely rather than sent as `undefined`, so the query
   * Prisma builds for an unfiltered list has one condition and not two.
   *
   * `Invoice_tenantId_status_idx` on `("tenantId", status)` exists and matches the schema's
   * `@@index([tenantId, status])`. That is **not** a claim of index coverage for this query:
   * `EXPLAIN` on a 4-row table at Gate 1 chose a Seq Scan with a Sort above it, and the
   * `ORDER BY "periodStart"` is not covered by that index in any case, so a sort node is
   * expected. Whether the index is used at production volume is unmeasured.
   */
  async listInvoices(query: ListInvoicesQuery): Promise<InvoiceListPage> {
    const statusFilter: { tenantId?: never; status?: InvoiceStatus } =
      query.status === undefined ? {} : { status: query.status };
    const where = this.where(statusFilter);

    return this.withTenant(async (tx) => {
      const rows = await tx.invoice.findMany({
        where,
        select: INVOICE_HEADER_SELECT,
        orderBy: [...INVOICE_LIST_ORDER_BY],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      });

      const total = await tx.invoice.count({ where });

      return {
        items: rows.map((row) => ({
          id: row.id,
          periodStart: toIsoString(row.periodStart),
          periodEnd: toIsoString(row.periodEnd),
          status: row.status,
          totalAmount: toAmountString(row.totalAmount),
          currency: row.currency,
          createdAt: toIsoString(row.createdAt),
          finalizedAt: row.finalizedAt === null ? null : toIsoString(row.finalizedAt)
        })),
        total
      };
    });
  }
}
