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
 * **No writer in this repository produces the state this refuses.** A grep for `FINALIZED`,
 * `PAID` and `finalizedAt` across every service's `src/` and `prisma/` returns declarations,
 * reads and comments only; `createDraftInvoice` writes `BILLING_METERING.INVOICE_STATUS_DRAFT`
 * and is the only statement that sets `Invoice.status` at all (measured at Gate 1, plan
 * appendix A.6). So until T-048 ships, `BI23` -- which seeds `FINALIZED` through the owner
 * connection -- is the only thing standing behind this branch. Stated as what that grep shows
 * about today's writers, **not** as a claim the status is unrepresentable: the fixtures reach
 * it, which is exactly how `BI23` works.
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
