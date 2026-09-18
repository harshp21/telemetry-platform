import type { InvoiceStatus, Prisma } from "@prisma/client";
import {
  BILLING_DATABASE,
  BILLING_INVOICE_DETAIL,
  BILLING_INVOICE_LIST,
  BILLING_METERING
} from "../constants";
import { InvoiceImmutableError, UsageLinesChangedError } from "../errors";
import { TenantScopedRepository } from "./base.repository";
import type { FullTransactionClient, TransactionClient } from "./base.repository";

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
 * What an absorption adds to an invoice that already exists (S-45).
 *
 * **There is no `invoiceId` field, and that is the design rather than an omission.** The
 * invoice is resolved here from `tenantId_periodStart_periodEnd`, with the tenant from
 * `this.where({})` -- so a caller cannot name a foreign invoice, because there is no parameter
 * through which to name one. `"InvoiceLineItem"` has `relrowsecurity = f` and no policy (S-10)
 * and no `tenantId` column, so the application route is the **entire** tenant control on the
 * line-item write; see `absorbLateUsage`'s own docblock for the measurement.
 *
 * `totalAmountDelta` is what the invoice total goes **up by**, not what it becomes: the column
 * is raised by a SQL addition, never read into JavaScript and written back (D4). No `currency`
 * field either -- the invoice already has one, and this method does not overwrite it.
 */
export interface AbsorbLateUsageInput {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly totalAmountDelta: string;
  readonly lineItems: readonly DraftInvoiceLineItemInput[];
  readonly usageLineIds: readonly string[];
}

/**
 * The outcome of an absorption: the invoice that took it, and its total **after** the increment.
 *
 * `totalAmount` is a string, like every other amount that crosses this boundary (D5). It is
 * returned so a caller -- and `BI25` -- can assert the persisted value below the HTTP layer:
 * `Prisma.Decimal` defines `toJSON`, so a leaked Decimal is invisible in a response body and a
 * route-level assertion would pass either way.
 */
export interface AbsorbLateUsageResult {
  readonly invoiceId: string;
  readonly totalAmount: string;
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
/**
 * One priced line of an invoice, as the detail endpoint returns it (T-047).
 *
 * **Three string-valued Decimals**, where `InvoiceHeader` had one. `quantity`, `unitPrice` and
 * `amount` are all `Decimal(18,6)`, which exceeds IEEE-754 safe precision, so each crosses this
 * boundary through `toAmountString` -- the same helper `listInvoices` uses, not a second one.
 *
 * **No `invoiceId`.** It is the parent's `id` repeated on every row: one more identifier on the
 * wire for nothing, and echoing it invites a client to key on it. Absent by construction, via
 * `INVOICE_LINE_ITEM_SELECT`, rather than deleted afterwards.
 */
export interface InvoiceLineItemView {
  readonly id: string;
  readonly metricKey: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly amount: string;
}

/**
 * One invoice with its lines: the eight `InvoiceHeader` fields plus `lineItems` (T-047 D5).
 *
 * `lineItems` may be empty -- an invoice with no lines is a valid invoice, not a miss -- and is
 * ordered `metricKey asc, id asc` (D2). A repeated `metricKey` renders as **separate lines**
 * (D1): `absorbLateUsage` appends a late tranche rather than merging it, and the two tranches
 * may carry different `unitPrice` values, so a merged line would have no correct value for that
 * column. Measured through the shipped repository at Gate 1: two `api.request` lines at
 * `unitPrice` 1 and 5 on one invoice.
 */
export interface InvoiceDetail extends InvoiceHeader {
  readonly lineItems: readonly InvoiceLineItemView[];
}

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

/**
 * The exact five columns of `InvoiceLineItemView` -- deliberately not `invoiceId`.
 *
 * An explicit `select` on the nested relation, never `include`: `include` returns every column
 * the table has, so `invoiceId` would be on the wire today and any column added to
 * `"InvoiceLineItem"` later would join it without anyone deciding to publish it.
 */
const INVOICE_LINE_ITEM_SELECT = {
  id: true,
  metricKey: true,
  quantity: true,
  unitPrice: true,
  amount: true
} as const;

/** `metricKey ASC, id ASC` (T-047 D2). See `BILLING_INVOICE_DETAIL` for why there are two keys. */
const INVOICE_LINE_ITEM_ORDER_BY = [
  { [BILLING_INVOICE_DETAIL.SORT_FIELD_METRIC_KEY]: BILLING_INVOICE_DETAIL.SORT_DIRECTION_ASC },
  { [BILLING_INVOICE_DETAIL.SORT_FIELD_ID]: BILLING_INVOICE_DETAIL.SORT_DIRECTION_ASC }
] as const;

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
 * Tenant-scoped reads and the two writes that invoice generation performs.
 *
 * Four properties hold across every method here. The first three are the ones
 * `.claude/rules/tenant-isolation.md` asks for; the fourth is T-048's:
 *
 * 1. Every query runs inside `withTenant`, so the RLS policies on `"Tenant"`, `"Invoice"` and
 *    `"UsageLine"` are active.
 * 2. Every predicate carries an explicit tenant, taken from `this.where({})` -- the
 *    constructor-bound context -- and no method has a `tenantId` parameter through which a
 *    caller could supply a different one.
 * 3. **No method here takes a bare `invoiceId`, and none takes a tenant.** This used to be a
 *    prose census with a grep beside it, and the planning probe for T-048 measured what that
 *    was worth: an eighth method taking a bare `invoiceId` was added and typecheck, lint and
 *    all 207 tests stayed green, because the claim lived in a comment (S-33). **`BU126` is now
 *    the census**, asserted rather than asserted-about: it parses every `async` member's
 *    parameter list out of this file and fails on a member named outside its list or on a
 *    parameter named `invoiceId` or `tenantId`. Re-derived at T-048 Gate 3:
 *    `grep -cE "^  async"` returns **7** (`tenantExists`, `findByPeriod`,
 *    `sumUnbilledByMetricKey`, `createDraftInvoice`, `absorbLateUsage`, `listInvoices`,
 *    `findDetailById`) and `grep -cE "^  ((private|protected|public|static) )?async"` returns
 *    **9**, the two extra being the private `markUsageLinesBilled` and, since T-048, the private
 *    `draftInvoiceWriter`. None of the nine takes either parameter. Re-run at Gate 3 Round 2:
 *    `^  async` -> 7, `^  (private )?async` -> 9, and the modifier-inclusive form above -> 9, so
 *    nothing is hiding under a modifier the narrower greps miss. That third form is the one to
 *    quote: the narrower one was `BU126`'s pattern until Round 2, and a `protected` member
 *    slipped past it into neither list. Run the greps rather than trusting the numerals;
 *    unlike before, a stale numeral here now also reddens `BU126`. Line items are
 *    written through Prisma's nested `create` on the invoice -- by `createDraftInvoice` and,
 *    since S-45, by `absorbLateUsage`, which are the only two writers on this tree -- and the
 *    one method that *reads* them, `findDetailById` (T-047), reaches them through the nested
 *    `select` on a tenant-filtered `Invoice`, never by `invoiceId`. That
 *    matters more here than it would elsewhere: `"InvoiceLineItem"` has `relrowsecurity = f`
 *    and no policy (S-10), and no `tenantId` column to write one against, so the join through
 *    `"Invoice"` is its *only* tenant control. Measured at Gate 1 inside the transaction this code writes in: after
 *    creating an invoice and its line item under tenant A and switching `app.tenant_id`, the
 *    invoice disappeared and the line item did not -- re-measured here by BI9 itself, which
 *    performs exactly that switch against rows this repository wrote. T-045 ships the platform's first rows into
 *    that table; `billing.integration.test.ts` cases BI9 and BI32 pin the gap as it is today so
 *    that closing S-10 turns them red rather than passing unnoticed, and `BU109` asserts that
 *    the detail read never touches `tx.invoiceLineItem` at all.
 * 4. **Every write to an `Invoice` reaches the delegate through `invoiceDelegate`, and the two
 *    callers that address an invoice which already exists go through `draftInvoiceWriter`,
 *    which refuses when the row named by `key` is not `DRAFT`** (T-048). Stated that way
 *    deliberately: the seam checks a row and returns the *whole* invoice delegate, so what is
 *    bound to `key` is the check, not the capability -- see `draftInvoiceWriter`'s own docblock
 *    for the measurement. `withTenant` hands the callback a `TransactionClient` whose
 *    `invoice` delegate has had its nine write methods removed, so the naive third writer --
 *    `tx.invoice.update({ where: { id }, ... })` -- is a compile error. Measured with
 *    `pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json`, which
 *    covers `tests/**` as well as `src/**`:
 *    `error TS2339: Property 'update' does not exist on type
 *    'Omit<InvoiceDelegate<DefaultArgs, PrismaClientOptions>, InvoiceWriteMethod>'`.
 *
 *    **State that at its measured strength and no further.** The same probe written as a
 *    deliberate cast back to the full client **compiles clean, 0 errors** -- so a bypass is
 *    *made visible in the forms the census enumerates*, not made impossible. What catches the
 *    deliberate form is `BU125`, which asserts that the **`as`-form spellings** of the cast
 *    targets it lists occur exactly once across `apps/billing-service/src`, inside
 *    `invoiceDelegate`. **Spellings, not targets** -- all four patterns are anchored on
 *    `\bas\s+`, so the same target written as an angle-bracket type assertion walks past every
 *    one of them; measured at Gate-3 Round 4 and recorded in the mutation list below.
 *
 *    **Each mutation with the suites it was run against, because an earlier revision of this
 *    paragraph attached one measurement to the wrong edit** (the second shape S-33 records):
 *
 *    - *A third writer that casts `tx` back*, i.e. a new member **plus** a cast: reddens
 *      `BU125` **and** `BU126` -- `Tests 2 failed | 35 passed (37)` against
 *      `tests/invoice.repository.unit.test.ts` alone, `Tests 2 failed | 211 passed (213)`
 *      against the whole package. `BU126`'s redness there comes from the **new member**, not
 *      from the cast.
 *    - *A second cast alone*, with no new member (`void (tx as …).invoice;` inside an existing
 *      method): reddens `BU125` only -- `Tests 1 failed | 36 passed (37)` in the file.
 *    - *The Gate-4 evasive writer*, a `protected` member casting the **delegate** rather than
 *      the client: passed everything at Round 1 (typecheck 0, lint 0, `213 passed (213)`) and
 *      reddens both after Round 2 widened the two patterns --
 *      `Tests 2 failed | 211 passed (213)`, and each case red on its own under `vitest -t`.
 *    - *The angle-bracket assertion* (Gate 6 LOW-3, re-run at Gate-3 Round 4): an
 *      angle-bracket type assertion of `tx` through `unknown` to the exported full-client type,
 *      written after the seam call in `absorbLateUsage`'s `withTenant` callback, taking the widened
 *      delegate's `updateMany`. **0 tsc diagnostics, 0 lint findings, `37 passed (37)` against
 *      `tests/invoice.repository.unit.test.ts`** -- `BU125` and `BU126` both green. It is the
 *      cheapest evasion found so far, because unlike the three above it changes no target and
 *      adds no member: it spells the census's own first identifier verbatim, and the census
 *      still misses it because every pattern is anchored on the `as` keyword. Reverted from a
 *      copy; the tree carries no probe.
 *
 *    `this.prisma.invoice.update(...)` is reached by none of this -- it added zero diagnostics
 *    under the same typecheck -- and it is the *worse* route, because it runs outside the
 *    transaction with no `set_config('app.tenant_id', ...)` issued at all. That is the route the
 *    epic's own T-048 snippet writes. It is **one of several** such routes, not the only one:
 *    the `prisma` module singleton imported from any layer and `tx.$executeRaw` inside
 *    `withTenant` were both measured at 0 diagnostics. S-48 stays open and carries the table.
 *
 *    `createDraftInvoice` is outside the `DRAFT` check by design (D5) and inside the delegate
 *    property: there is no existing row whose status could forbid a create, and the status it
 *    writes is the `DRAFT` constant unconditionally.
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
   * The one place in this service that widens `tx` back to the full transaction client (T-048).
   *
   * `withTenant` hands the callback a `TransactionClient` whose `invoice` delegate has had its
   * nine write methods removed, so `tx.invoice.create` and `tx.invoice.update` do not exist as
   * far as the compiler is concerned. This accessor is how the two legitimate writers get them
   * back, and the cast is deliberately ugly for the same reason it is deliberately singular.
   *
   * `BU125` asserts that the cast forms it enumerates occur **exactly once** across
   * `apps/billing-service/src`, and that the one occurrence is inside this method. A future
   * writer that wants to bypass the seam can still write the same cast in its own body --
   * measured, probe P-G2, it compiles clean -- and `BU125` is what turns *that* form into a red
   * test rather than a silent second doorway.
   *
   * **It is a tripwire over an enumerated set, not a proof, and that distinction was earned by
   * being wrong.** At Gate 4 the census matched one spelling; a writer casting the delegate
   * rather than the client, under a `protected` modifier neither pattern classified, passed
   * typecheck, lint and all 213 tests. The patterns were widened at Round 2 -- four cast
   * targets, every access modifier, plus a third member list asserted empty so nothing falls
   * out of the census silently -- and that writer now reddens both. A fifth spelling would
   * still be missed. See `TransactionClient`'s docblock in `base.repository.ts` for the
   * figures, and S-48 for the routes no source census reaches at all: `this.prisma`, the
   * `prisma` module singleton, and `tx.$executeRaw` inside `withTenant`.
   *
   * **`BU125` matches on the casts' text**, so nothing in `src/` may spell those phrases in a
   * comment -- including this one, which is why they are described rather than quoted. A
   * comment carrying a pattern would be counted as an occurrence and would report a bypass
   * that does not exist (the S-33 self-match).
   */
  private invoiceDelegate(tx: TransactionClient): FullTransactionClient["invoice"] {
    return (tx as unknown as FullTransactionClient).invoice;
  }

  /**
   * The guarded doorway the two writers of an invoice that **already exists** go through
   * (T-048).
   *
   * Reads the addressed invoice's status through the narrowed delegate -- a read, which the
   * narrowing leaves in place -- refuses anything that is not `DRAFT` with
   * `InvoiceImmutableError`, and only then hands back the write delegate. Any throw happens
   * before a single write statement is issued, and inside the caller's transaction, so there
   * is no partial state to observe. `BU123` and `BU127` are the two halves of that: refuses
   * before any write, and does not over-refuse a draft.
   *
   * **The limit, measured rather than reasoned about (Gate-4 review, MEDIUM-1).** What this
   * seam checks is the status of the row named by `key`. What it returns is the **whole**
   * invoice delegate, not a capability scoped to that row, and it does not constrain what the
   * caller does with it afterwards: inserting
   * `await writer.updateMany({ where: {}, data: { status: "FINALIZED" } })` immediately after
   * the seam call in `absorbLateUsage` compiles with **0 diagnostics**
   * (`pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json`, whole
   * package, reverted). So a caller is expected to write through the same `key` it had checked;
   * nothing in the type says so. RLS still bounds the tenant. Nothing bounds the status.
   *
   * Left as a reword rather than a reshape by decision at Gate 3 Round 2: making the seam
   * perform the write (`draftInvoiceUpdate(tx, key, data)`) is the shape that would make the
   * binding true by construction, and it re-opens D5 and eleven existing cases. Both callers
   * are in this file, and `BU126`'s widened census is what puts a tripwire on the next one.
   *
   * **`key` is built inside this repository and is never a caller's** (D4). No method on this
   * class takes a bare `invoiceId` or a caller-supplied tenant -- `BU126` asserts that over
   * the parsed parameter list of every `async` member rather than leaving it to the class
   * docblock's prose, which the planning probe measured as unguarded.
   *
   * **`createDraftInvoice` deliberately does not come through here** (D5). Creation is not
   * mutation: there is no existing row whose status could forbid the write, and the status it
   * writes is the `DRAFT` constant unconditionally. It reaches the delegate through
   * `invoiceDelegate` alone, so the property that holds across the whole class is the narrower
   * true one -- *every* write reaches the delegate through `invoiceDelegate`, and the two
   * writers that address an invoice which already exists obtain that delegate from this guard,
   * having had the row named by `key` checked.
   *
   * **No production path reaches the refusing branch today.** A grep for `FINALIZED`, `PAID`
   * and `finalizedAt` across every service's `src/` and `prisma/` returns declarations, reads,
   * DDL and comments -- **zero assignments** -- so within that scope `createDraftInvoice`'s
   * `DRAFT` is the only status any statement writes. **That scope is the grep's, and it does not
   * read `tests/`**, which does set the status: six times, all through
   * `integration.fixtures.ts`'s `seedInvoices` on the owner connection. Re-derived over the
   * whole match set rather than carried forward as a numeral, and re-run **after** the last edit
   * to any file the grep reads: **19** lines, **10** of them comments and **9** declarations,
   * reads and DDL; **14** on `a87d952`. The added-and-removed split that used to follow is gone:
   * three arithmetics over the same two revisions give 5 added / 0 removed, 7 / 2 and 6 / 1, and
   * all three reach 19, so the split reproduced under no consistent rule (T-048 Gate 5 F-2).
   * Gate 3 measured 17 lines and 8 comments, Gate 4 Round 2 measured 19 and 10 -- both correct
   * when written, both stale inside the same task, because the sentences that
   * record the count are themselves matches. That is the S-33 self-match, one entry further in;
   * "zero assignments" is the half that has survived all three derivations.
   *
   * Every test of this branch therefore seeds its state through the owner connection (`BI23`,
   * `BI34`) or through a double (`BU123`, `BU124`), and **none of them proves production
   * behaviour**: they prove what this repository does when handed a state that no production
   * path currently produces. Said as what the grep shows about today's *writers* -- deliberately not
   * as a claim the status is unreachable, which the fixtures refute.
   */
  private async draftInvoiceWriter(
    tx: TransactionClient,
    key: Prisma.InvoiceWhereUniqueInput
  ): Promise<FullTransactionClient["invoice"]> {
    const existing = await tx.invoice.findUniqueOrThrow({
      where: key,
      select: { id: true, status: true }
    });

    if (existing.status !== BILLING_METERING.INVOICE_STATUS_DRAFT) {
      throw new InvoiceImmutableError(existing.id, existing.status);
    }

    return this.invoiceDelegate(tx);
  }

  /**
   * Marks exactly `usageLineIds` billed, chunked, with one count assertion over the whole set.
   *
   * **Extracted rather than copied** (S-45 slice S3). `createDraftInvoice` and
   * `absorbLateUsage` need the identical bound and the identical assertion, and two copies of
   * a correctness bound is how they drift -- `.claude/rules/constants.md`'s DRY gate applied to
   * logic rather than to literals. The extraction is behaviour-preserving and that is what
   * `BU24`, `BU24b`, `BU26`, `BU27b`, `BI11` and `BI12` are for: all six pin the existing
   * chunking and all six stayed green across it.
   *
   * Chunked because Prisma expands `id: { in: [...] }` to one bind variable per id and
   * PostgreSQL caps a prepared statement at 32 767 of them -- measured, 32 764 ids pass and
   * 32 765 raise `P2035`. See `BILLING_METERING.BILLED_UPDATE_CHUNK_SIZE` for the full
   * measurement and for why the chunk is 1 000 rather than nearer the ceiling.
   *
   * The count assertion is unchanged in meaning and deliberately so: the counts are summed
   * across every chunk and compared against the **whole** id set, never per chunk. A per-chunk
   * comparison would be a different, weaker guard -- it would still catch a concurrent writer,
   * but it would report the wrong numbers and would stop being the property BU24 and BU26 pin.
   * BU27b is the case that goes red if the sum is dropped.
   *
   * The caller must already be inside `withTenant`: the throw is what rolls the caller's
   * invoice write back with it, which is the property BI10 asserts against a live database.
   */
  private async markUsageLinesBilled(
    tx: Omit<Prisma.TransactionClient, "invoice">,
    usageLineIds: readonly string[]
  ): Promise<void> {
    const expectedCount = usageLineIds.length;
    let markedCount = 0;

    for (let offset = 0; offset < expectedCount; offset += CHUNK_SIZE) {
      const chunk = usageLineIds.slice(offset, offset + CHUNK_SIZE);
      const marked = await tx.usageLine.updateMany({
        where: this.where({ id: { in: [...chunk] }, billed: false }),
        data: { billed: true }
      });
      markedCount += marked.count;
    }

    if (markedCount !== expectedCount) {
      throw new UsageLinesChangedError(expectedCount, markedCount);
    }
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
    try {
      const invoiceId = await this.withTenant(async (tx) => {
        const invoice = await this.invoiceDelegate(tx).create({
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

        await this.markUsageLinesBilled(tx, input.usageLineIds);

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
   * Adds late usage to the invoice that already covers this period, in one transaction (S-45).
   *
   * Four steps, in this order, and any throw at any of them rolls back all of it -- no line
   * items, no total change, no billed flags. A partial absorb that marked rows billed without
   * adding their charges would destroy the only record that the money was owed, which is worse
   * than the gap this method closes.
   *
   * 1. resolve the invoice from the compound unique, reading `id` and `status`;
   * 2. refuse anything that is not `DRAFT` -- `InvoiceImmutableError`, before any write;
   * 3. one `update`: `totalAmount: { increment }` **plus** nested `lineItems: { create }`;
   * 4. the chunked billed update, through the same helper `createDraftInvoice` uses.
   *
   * **Tenant isolation, stated exactly as it was measured (S-10, plan probe F).** As
   * `telemetry_app` under another tenant's context, `UPDATE "Invoice" … WHERE id = <foreign>`
   * matched **0 rows** -- RLS holds for step 3's target -- but a `SELECT` on
   * `"InvoiceLineItem"` returned the foreign row and an `INSERT` against the foreign
   * `invoiceId` **succeeded**. `relrowsecurity = f`, zero policies, no `tenantId` column. So
   * **do not read this as "RLS protects the line-item write": it does not.** The controls that
   * do exist are, in order:
   *
   * - this method takes **no `invoiceId` parameter**, so a foreign invoice cannot be named at
   *   the call site. That is a property of the shape as shipped -- checkable by grep, not
   *   enforced by the type system, which is why it is written down;
   * - the invoice is addressed by `tenantId_periodStart_periodEnd` with the tenant from
   *   `this.where({})`, and the emitted `UPDATE` carries that tenant in its own `WHERE`;
   * - the line items are created **only** through the nested `create` on that resolved
   *   invoice, never `tx.invoiceLineItem.create`, so the `invoiceId` Prisma binds is one this
   *   statement just resolved under the tenant predicate.
   *
   * **What guards each of those, measured -- and the measurement was run against *both* suites,
   * because an earlier revision of this paragraph ran only the integration one and concluded
   * from it that nothing guarded the parameter.** Each mutation was applied to `src/`, both
   * suites run, then reverted and the tree re-checksummed:
   *
   * - `BU98` (`tests/invoice.repository.unit.test.ts`) pins the **address**: `invoice.update`'s
   *   `where` is `tenantId_periodStart_periodEnd` carrying the bound tenant. Adding an
   *   `invoiceId` parameter and addressing `findUniqueOrThrow`/`update` by `{ id }` reddens it
   *   -- `AssertionError: expected { id: undefined } to deeply equal { ...(1) }`, unit 1 failed
   *   / 26 passed. Dropping the tenant from the **write** alone (read still on the compound
   *   unique, `update` on `{ id: existing.id }`) reddens it too, and that mutation keeps the
   *   Prisma call surface so the red is a real assertion failure rather than a missing double.
   * - `BU99` pins the **route**: the nested `create`, with `tx.invoiceLineItem.create` never
   *   called. Adding the parameter and writing the line items through
   *   `tx.invoiceLineItem.create({ data: { invoiceId: input.invoiceId, ... } })` reddens it --
   *   unit 1 failed / 26 passed.
   * - `BI24` pins the **outcome** against a live database with two tenants holding invoices for
   *   the same period. It is green under **every** one of those mutations; the integration
   *   failures are only `BI25` and `BI27` (28 passed / 2 failed), which call the repository
   *   directly and so no longer type-match. So the *structural* property is guarded by two named
   *   unit cases, not by grep alone -- but not by any behavioural one.
   *
   * **What no behavioural case catches is the tenant predicate itself.** Removing it from the
   * resolution entirely -- `findFirst({ where: { periodStart, periodEnd } })`, update addressed
   * by the id it found -- is **30 passed / 0 failed** on the integration suite, because the read
   * runs inside `withTenant` and `"Invoice"` RLS is enabled, so an untenanted predicate still
   * sees only the bound tenant's row. Probed directly as `telemetry_app` with two invoices
   * sharing one period: under tenant B's context the untenanted predicate returned exactly B's
   * row, the tenanted one returned the same row, tenant A's context returned exactly A's, and
   * no context at all returned none. That mutation does turn four unit cases red, but
   * **mechanically** -- `tx.invoice.findFirst is not a function`, the Prisma double having no
   * `findFirst` -- so it is not evidence of coverage. Recorded as S-46; keep the predicate
   * regardless, per `.claude/rules/tenant-isolation.md`.
   *
   * **`findUniqueOrThrow` raises `P2025` if the invoice vanished** between the service's
   * `findByPeriod` and this transaction. No production path deletes an invoice: a grep for
   * `invoice.delete` and `invoice.deleteMany` across every service's `src` returns nothing but
   * this sentence, which matches itself -- the S-33 self-match, named here so a future reader
   * re-running it is not misled by the single hit.
   * That is a statement about today's writers, not about reachability -- the integration
   * fixtures delete invoices in teardown, and an unset tenant context would produce the same
   * `null` through RLS. It surfaces as a `500`, which is the right answer for "the world changed
   * underneath a transaction in a way nothing is supposed to do".
   *
   * **Appended, never merged (D2).** Each absorption inserts its own rows; existing line items
   * are neither read nor rewritten. A period whose `api.request` was billed twice therefore
   * carries **two** rows with that key, which is a faithful audit trail of two tranches.
   * **T-047 (`GET /v1/billing/invoices/:id`) inherits that** and must decide whether to render
   * them as two lines or group them for display -- it is the first thing on the platform to
   * return line items at all. Merging was rejected partly because `"InvoiceLineItem"` has a
   * primary-key index and nothing else, not even one on `invoiceId`.
   *
   * **`DRAFT`-only mutation was S-45's decision and T-048 adopted it unchanged (D2).** A
   * non-`DRAFT` invoice refuses the absorption rather than restating an already-issued
   * document, and the usage stays `billed = false` and re-absorbable -- the revenue is
   * deferred, not lost. Overriding that would be a product decision about invoice restatement
   * that nothing in the epics has taken.
   *
   * **What T-048 changed here is the shape, not the answer.** The inline `findUniqueOrThrow`
   * and status check that used to live in this method body moved into `draftInvoiceWriter`,
   * the seam every write to an existing invoice now passes through, and `tx.invoice`'s write
   * methods were removed from the type `withTenant` hands this callback. The reroute is
   * behaviour-preserving: `BI23`, `BU98`, `BU99`, `BU100` and `BU101` were re-read at that
   * task's S3 and all stayed green.
   */
  async absorbLateUsage(input: AbsorbLateUsageInput): Promise<AbsorbLateUsageResult> {
    const { tenantId } = this.where({});
    const periodKey = {
      tenantId_periodStart_periodEnd: {
        tenantId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd
      }
    };

    return this.withTenant(async (tx) => {
      const writer = await this.draftInvoiceWriter(tx, periodKey);

      const invoice = await writer.update({
        where: periodKey,
        data: {
          // A SQL addition on the column -- `SET "totalAmount" = ("totalAmount" + $1)`,
          // measured -- so the arithmetic happens in PostgreSQL `numeric` at the column's own
          // precision and does not race a concurrent absorber. A read-modify-write would put a
          // `Decimal(18,6)` value through JavaScript and lose that.
          totalAmount: { increment: input.totalAmountDelta },
          // Nested, so the line items are created against the invoice this statement resolved
          // under the tenant predicate and never against an `invoiceId` from anywhere else.
          lineItems: {
            create: input.lineItems.map((item) => ({
              metricKey: item.metricKey,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              amount: item.amount
            }))
          }
        },
        select: { id: true, totalAmount: true }
      });

      await this.markUsageLinesBilled(tx, input.usageLineIds);

      return { invoiceId: invoice.id, totalAmount: toAmountString(invoice.totalAmount) };
    });
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

  /**
   * One invoice of the bound tenant, with its line items (T-047).
   *
   * **The signature takes an `id` and no tenant**, matching `listInvoices`: identifiers in,
   * tenant from `this.where({})`. A parameter nobody can supply cannot be supplied wrongly.
   * That is a design choice this file makes, not one the compiler makes for it -- see this
   * class's docblock for the three probes showing what `where<T extends { tenantId?: never }>`
   * does and does not reject.
   *
   * `findFirst`, not `findUnique`. Both work: `findUnique({ where: { id, tenantId } })` is legal
   * at Prisma 6.19.3 (extended `where` unique, GA since 5.0) and compiles to **identical** SQL,
   * `LIMIT`/`OFFSET` included, measured side by side at Gate 1. `findFirst` is chosen because it
   * composes with `this.where({ id })` without depending on that feature.
   *
   * ## Why the nested select is safe, and exactly how far that goes
   *
   * Prisma emits **two** statements for a nested relation select, not a JOIN. The second is
   * `SELECT … FROM "InvoiceLineItem" WHERE "invoiceId" IN (…)` -- the same shape that, issued
   * directly, returns another tenant's line items: measured at Gate 1 as `telemetry_app` under
   * tenant B's context, `invoiceLineItem.findMany({ where: { invoiceId: <A's invoice> } })`
   * returned A's two line items with their amounts, and an unfiltered `count()` returned every
   * tenant's rows. `"InvoiceLineItem"` has `relrowsecurity = f` and **zero** policies (S-10) and
   * no `tenantId` column to write one against, so the database will not stop it.
   *
   * What makes it safe here is that the `IN` list is bound from the tenant-filtered parent read,
   * and that Prisma **skips the second statement entirely** when the parent read matches
   * nothing. Re-derived at Gate 3 against this method, counting statements mentioning
   * `"InvoiceLineItem"` in the query log, one dimension varied at a time:
   *
   * | Context | `where` | Result | `InvoiceLineItem` statements |
   * |---|---|---|---|
   * | A | `{ id: A_INV, tenantId: A }` | the invoice | **1** |
   * | B | `{ id: A_INV, tenantId: B }` | `null` | **0** |
   * | B | `{ id: A_INV }`, predicate removed | `null` | **0** |
   * | A | `{ id: <unknown uuid>, tenantId: A }` | `null` | **0** |
   *
   * **Scope that precisely.** It is a behaviour of `@prisma/client` 6.19.3 on this schema, not
   * a property of the schema and not something the database enforces. A Prisma major bump, or
   * enabling the `relationJoins` preview feature (which rewrites nested reads as
   * `LEFT JOIN LATERAL`), changes the emitted SQL, and this table must be re-measured before
   * such an upgrade lands -- the re-verification is exactly the four rows above. `BU109` catches
   * a **code-level** re-route, because the call surface changes; it cannot catch a Prisma-level
   * plan change, because the call surface would not.
   *
   * `BU109` is also the *only* thing catching the re-route: it is a test, not a type. Measured
   * at the Gate 3 rework -- inserting `tx.invoiceLineItem.findMany({ where: { invoiceId: id } })`
   * here typechecks clean today, and adding `| "invoiceLineItem"` to `TransactionClient`'s
   * `Omit` would make it `TS2339` for two lines' cost. Not done here: that file is one of
   * S-19's five copies. Recorded as **S-48**, with the limit that the narrowing binds `tx` and
   * not `this.prisma`.
   *
   * No date predicate is bound here, so S-19's missing `TimeZone` pin in billing's
   * `base.repository.ts` cannot bite this path. If one is ever added it goes through the ORM --
   * never `$queryRaw` (`CLAUDE.md` § *Raw SQL and timestamps*).
   *
   * `null` for a miss, and for another tenant's invoice: the two are indistinguishable here by
   * construction, which is what makes `InvoiceNotFoundError` one error rather than two.
   */
  async findDetailById(id: string): Promise<InvoiceDetail | null> {
    return this.withTenant(async (tx) => {
      const row = await tx.invoice.findFirst({
        where: this.where({ id }),
        select: {
          ...INVOICE_HEADER_SELECT,
          lineItems: {
            select: INVOICE_LINE_ITEM_SELECT,
            orderBy: [...INVOICE_LINE_ITEM_ORDER_BY]
          }
        }
      });

      if (row === null) {
        return null;
      }

      return {
        id: row.id,
        periodStart: toIsoString(row.periodStart),
        periodEnd: toIsoString(row.periodEnd),
        status: row.status,
        totalAmount: toAmountString(row.totalAmount),
        currency: row.currency,
        createdAt: toIsoString(row.createdAt),
        finalizedAt: row.finalizedAt === null ? null : toIsoString(row.finalizedAt),
        lineItems: row.lineItems.map((item) => ({
          id: item.id,
          metricKey: item.metricKey,
          quantity: toAmountString(item.quantity),
          unitPrice: toAmountString(item.unitPrice),
          amount: toAmountString(item.amount)
        }))
      };
    });
  }
}
