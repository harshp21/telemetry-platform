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
