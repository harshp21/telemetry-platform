import { AppError, ERROR_RESPONSES } from "@telemetry/shared-types";
import { BILLING_RESPONSES } from "../constants";

export { AppError, ERROR_RESPONSES };

export class InternalApiSecretMissingError extends AppError {
  constructor() {
    super(
      ERROR_RESPONSES.CODE_INTERNAL_ERROR,
      BILLING_RESPONSES.HTTP_STATUS_INTERNAL_ERROR,
      "INTERNAL_API_SECRET must be configured for billing-service"
    );
  }
}

/**
 * `X-Tenant-Id` was absent, blank or not a single string value (T-046).
 *
 * `401` rather than `400`, matching `apps/usage-service/src/errors/index.ts`: the header is
 * injected by the gateway from verified JWT context, so its absence means the caller did not
 * arrive through an authenticated path -- not that it sent a malformed request body.
 */
export class TenantContextMissingError extends AppError {
  constructor() {
    super(
      BILLING_RESPONSES.CODE_TENANT_CONTEXT_MISSING,
      BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED,
      BILLING_RESPONSES.MESSAGE_TENANT_CONTEXT_MISSING
    );
  }
}

/**
 * `X-Tenant-Id` was present but is not a UUID (T-046).
 *
 * Distinct from `TenantContextMissingError` on purpose: reusing "header is required" for a
 * header that *was* supplied misdescribes the failure to whoever reads the log. Both are only
 * reachable after the caller has proved it is an internal service, so the extra detail is not
 * exposed to an unauthenticated client.
 */
export class TenantContextInvalidError extends AppError {
  constructor() {
    super(
      BILLING_RESPONSES.CODE_TENANT_CONTEXT_INVALID,
      BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED,
      BILLING_RESPONSES.MESSAGE_TENANT_CONTEXT_INVALID
    );
  }
}

/**
 * Step 1 of the metering logic: the body named a tenant that does not exist.
 *
 * "Does not exist" is measured through the tenant-scoped read itself, so an absent tenant and
 * a tenant the RLS policy hides are the same answer here. That is deliberate: this endpoint is
 * internal-only, and the alternative would be a cross-tenant existence oracle.
 */
export class TenantNotFoundError extends AppError {
  constructor() {
    super(
      BILLING_RESPONSES.CODE_TENANT_NOT_FOUND,
      BILLING_RESPONSES.HTTP_STATUS_NOT_FOUND,
      BILLING_RESPONSES.MESSAGE_TENANT_NOT_FOUND
    );
  }
}

/**
 * D1: at least one `metricKey` with unbilled usage in the period has no active `Meter`.
 *
 * The offending keys are named in the message because the operator's next action is to create
 * those meters, and an unnamed refusal makes them go looking. No invoice is created and no
 * `UsageLine` is marked billed on this path.
 */
export class MeterNotFoundError extends AppError {
  constructor(public readonly metricKeys: readonly string[]) {
    super(
      BILLING_RESPONSES.CODE_METER_NOT_FOUND,
      BILLING_RESPONSES.HTTP_STATUS_UNPROCESSABLE_ENTITY,
      `${BILLING_RESPONSES.MESSAGE_METER_NOT_FOUND}: ${[...metricKeys].join(", ")}`
    );
  }
}

/** D1's currency sibling: the matched meters disagree and `Invoice.currency` is one column. */
export class MeterCurrencyConflictError extends AppError {
  constructor(public readonly currencies: readonly string[]) {
    super(
      BILLING_RESPONSES.CODE_METER_CURRENCY_CONFLICT,
      BILLING_RESPONSES.HTTP_STATUS_UNPROCESSABLE_ENTITY,
      `${BILLING_RESPONSES.MESSAGE_METER_CURRENCY_CONFLICT}: ${[...currencies].join(", ")}`
    );
  }
}

/**
 * The billed `updateMany` matched fewer rows than were priced (D2).
 *
 * Thrown from inside `withTenant`, so Prisma rolls the invoice and its line items back with it.
 * A concurrent writer is *detected* here rather than serialised against -- one long transaction
 * would have blocked and then proceeded, telling nobody.
 *
 * `409`, not `500`: the condition is a lost race caused by another client, it is retryable, and
 * the server handled it correctly by rolling back. A `500` would page an operator for a benign
 * scheduler collision. `409` is already this repository's code for "a concurrent writer got
 * there first" -- `registerGlobalErrorHandler` maps `P2002` to it -- so this is consistent
 * rather than novel. T-046's caller can branch on it.
 */
export class UsageLinesChangedError extends AppError {
  constructor(
    public readonly expected: number,
    public readonly actual: number
  ) {
    super(
      BILLING_RESPONSES.CODE_USAGE_LINES_CHANGED,
      BILLING_RESPONSES.HTTP_STATUS_CONFLICT,
      `${BILLING_RESPONSES.MESSAGE_USAGE_LINES_CHANGED} (expected ${expected}, marked ${actual})`
    );
  }
}

/**
 * S-45 D1: generate found an invoice for the period, late usage to absorb into it, and a
 * status other than `DRAFT`.
 *
 * `409`, matching `UsageLinesChangedError`: the request was well-formed, the server wrote
 * nothing, and the condition is about the state of a resource rather than about the caller's
 * input. The refusal is the safe direction -- the alternative is mutating a document that has
 * been issued, and the usage stays `billed = false` and absorbable if the status ever moves
 * back or a supplementary process claims it.
 *
 * **No writer in `src/` or `prisma/` produces the state this refuses.** A grep for `FINALIZED`,
 * `PAID` and `finalizedAt` across every service's `src/` and `prisma/` returns declarations,
 * reads, DDL and comments only. Within that scope `createDraftInvoice` writes
 * `BILLING_METERING.INVOICE_STATUS_DRAFT` and no other statement sets `Invoice.status`.
 * **`tests/` is outside that scope and does set it**, six times -- all through
 * `integration.fixtures.ts`'s `seedInvoices`, on the owner connection. An earlier revision of
 * this sentence ended "and is the only statement that sets `Invoice.status` at all", which
 * those six refute (T-048 Gate 4 Round 2, MEDIUM-3): the grep never read `tests/`, so the
 * evidence only ever supported the scoped claim.
 *
 * Re-derived over the whole match set rather than carried forward as a numeral, and re-run
 * **after** the last edit to any file the grep reads -- the two previous derivations were each
 * invalidated by the sentence that recorded them: **19** matching lines, **10** of them comments
 * and **9** declarations, reads and DDL. **Zero assignments** -- no statement in that scope
 * writes the status column or its timestamp. That is the durable half, and the only figure
 * unchanged across all three derivations. On `a87d952` the grep returned **14**.
 *
 * **The added-and-removed split that used to follow that figure is gone deliberately.** It
 * reproduced under no consistent rule: per-file deltas between the two revisions give 5 added
 * and 0 removed, `comm` over the two normalised match sets gives 7 and 2, and the shipped
 * sentence said 6 and 1 -- this file had three matching lines on `a87d952` and has three now,
 * two of them reworded in place, and each arithmetic charges a reword differently. All three
 * reach 19, which is why four derivations passed it (T-048 Gate 5 F-2, upheld at Gate 6 LOW-1).
 * Gate 3 measured 17 matching lines and 8 comments; Gate 4 Round 2 measured 19 and 10 -- both
 * correct when written, both stale inside the same task, which is the self-match S-33 is about.
 * The plan's appendix A.6 recorded 12 and that figure does not reproduce.
 *
 * So `BI23` (`FINALIZED`) and `BI34` (`PAID`), both seeding through the owner connection, plus
 * the `BU123`/`BU124` doubles, are what stands behind this branch -- and **none of them proves
 * production behaviour**: they prove what the repository does when handed a state no
 * production path currently produces. T-048 did not change that; it made the refusal a
 * shared seam rather than a check in one method. Stated as what the grep shows about today's
 * writers, **not** as a claim the status is unrepresentable: the fixtures reach it, which is
 * exactly how `BI23` works.
 *
 * `invoiceId` and `currentStatus` are retained as fields and read by `BillingService`'s log
 * line. They are deliberately **not** in the response body: the epic declares
 * `{ code, invoiceId, currentStatus }` (`epic-8` § *T-048*, heading `:140`) and every error
 * this service emits is
 * `{ code, message }`, so the status is named in the message and both values go where an
 * operator reads them (plan divergence E1).
 */
export class InvoiceImmutableError extends AppError {
  constructor(
    public readonly invoiceId: string,
    public readonly currentStatus: string
  ) {
    super(
      BILLING_RESPONSES.CODE_INVOICE_IMMUTABLE,
      BILLING_RESPONSES.HTTP_STATUS_CONFLICT,
      `${BILLING_RESPONSES.MESSAGE_INVOICE_IMMUTABLE} (status ${currentStatus})`
    );
  }
}

/**
 * T-047 D3: the requested invoice is not the bound tenant's, or does not exist.
 *
 * **One error for both, deliberately.** `InvoiceRepository.findDetailById` answers `null` in
 * either case and cannot tell them apart -- the read carries the tenant predicate and runs
 * under an RLS context, so a foreign row is not returned and not counted. Distinguishing them
 * would require a second, unscoped read, which is exactly the cross-tenant existence oracle
 * the epic's own wording asks to avoid (`docs/epics/epic-8-billing-service.md:119`, "do not
 * leak existence"). `BI29` pins it by asserting the unknown-id and foreign-id responses are
 * deep-equal.
 *
 * `404` rather than `403`: a `403` would confirm the resource exists.
 */
export class InvoiceNotFoundError extends AppError {
  constructor() {
    super(
      BILLING_RESPONSES.CODE_INVOICE_NOT_FOUND,
      BILLING_RESPONSES.HTTP_STATUS_NOT_FOUND,
      BILLING_RESPONSES.MESSAGE_INVOICE_NOT_FOUND
    );
  }
}
