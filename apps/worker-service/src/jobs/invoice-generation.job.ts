import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import { WORKER_INVOICE_JOB } from "../constants";
import type { BillingEnumerationRepository } from "../repositories/billing-enumeration.repository";
import type { BillingClientService } from "../services/billing-client.service";
import { describeError } from "../utils/describe-error";

/**
 * A billing window, in the two key names billing-service's validator requires.
 *
 * The names are load-bearing rather than stylistic: `generateInvoiceRequestSchema` in
 * `apps/billing-service/src/validators/generate-invoice.validator.ts` requires exactly
 * `periodStart` and `periodEnd`, so a helper returning `{ from, to }` would make the epic's
 * `{ tenantId, ...yesterday }` spread produce a `400 VALIDATION_ERROR` from a call site that
 * reads correct. The epic never says what the helper returns; `J5` pins it.
 */
export interface DayRange {
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface InvoiceGenerationJobDeps {
  readonly enumeration: BillingEnumerationRepository;
  readonly billingClient: BillingClientService;
  readonly logger: Logger;
}

/**
 * What one night produced.
 *
 * `failed` is the number a later alert hangs off. Until T-057 adds metrics, a tenant whose call
 * fails every night is visible only in logs and in this counter — stated as a trade rather than
 * hidden, because the job deliberately *succeeds* when a tenant fails (see below).
 */
export interface InvoiceGenerationSummary {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly tenants: number;
  readonly succeeded: number;
  readonly failed: number;
}

/**
 * The previous **UTC** calendar day as a half-open `[periodStart, periodEnd)` interval.
 *
 * Computed with `Date.UTC(getUTCFullYear(), getUTCMonth(), getUTCDate() - N)` and emitted with
 * `toISOString()`. **Never `new Date(y, m, d)`**, which is local midnight and therefore agrees
 * with `Date.UTC` exactly when the process offset is zero. That asymmetry — wrong wherever the
 * runner is not UTC, right where it is — is what would have let the wrong form survive review,
 * and until T-042's Gate-5 rework nothing pinned the runner's zone, so `J1`-`J5` caught it on a
 * developer's machine and passed against it on a UTC one.
 *
 * `vitest.config.mjs` now sets `test.env.TZ = "Asia/Kathmandu"` (+05:45) and `J12` asserts the
 * pin is applied. Measured under it: substituting the local-midnight form reddens
 * `J1`-`J6` — `Tests 6 failed | 6 passed (12)` — identically with `TZ` unset on this UTC+5:30
 * host and with an outer `TZ=UTC`. Before the pin, Gate-5 QA measured the same mutation at
 * `11 passed (11)` under `TZ=UTC` on the 11-case file that predates `J12`.
 *
 * `Date.UTC` normalises a day of `0` or below into the previous month, so the month, leap-year
 * and year rollovers need no special case (`J4`).
 *
 * Half-open, matching the resolver's predicate and billing-service's
 * `sumUnbilledByMetricKey` — `billed: false, periodStart: { gte, lt }`. A closed interval would
 * put midnight's usage on two consecutive invoices, and since `UsageLine.billed` is set once
 * that error would not be self-correcting.
 */
export const getPreviousDayRange = (now: Date): DayRange => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  return {
    periodStart: new Date(
      Date.UTC(year, month, day - WORKER_INVOICE_JOB.PREVIOUS_DAY_OFFSET)
    ).toISOString(),
    periodEnd: new Date(Date.UTC(year, month, day)).toISOString()
  };
};

/**
 * Turns yesterday's unbilled usage into one billing request per tenant.
 *
 * ## The failure contract, which is the whole design
 *
 * - **The enumeration failing rejects the job.** If the tenant list could not be read, the job
 *   does not know whom it skipped, and reporting success would be a lie that costs revenue with
 *   nothing to notice it — `.claude/rules/known-gaps.md` has no entry for "we did not bill
 *   anyone in March" because nothing would produce one. This is the one condition under which a
 *   BullMQ retry is wanted, and it is why `BillingEnumerationRepository` propagates rather than
 *   returning `[]`.
 * - **A single tenant failing does not.** The loop catches per tenant, logs the outcome with the
 *   tenant id, and continues; the job resolves with `failed` set. Retrying the whole job would
 *   re-call every tenant that already succeeded — safe, because billing's endpoint is
 *   idempotent, but noisy, and it would mask a persistently failing tenant behind repeated
 *   whole-job retries. A failed tenant is recovered by the next night's run, which will still
 *   see its usage unbilled.
 *
 * ## Sequential, not `Promise.all`
 *
 * `Promise.all` rejects the whole batch on the first failure, which contradicts the paragraph
 * above, and removes any bound on the concurrent load this job puts on billing-service.
 * Concurrency here would need its own bound and its own decision; `J11` asserts that no second
 * call starts before the first settles, so adding it is a deliberate change rather than a
 * silent one.
 *
 * ## Over-inclusive is harmless, under-inclusive is not
 *
 * A tenant with nothing to bill answers `200 { data: { invoiceId: null } }`. So naming a tenant
 * that turns out to have no billable usage costs one HTTP round trip; *failing* to name one
 * costs the revenue. That asymmetry is what ruled out maintaining a per-day Redis set of tenant
 * ids instead of reading the database (decision D1, option B).
 *
 * @param now Injected rather than read from the clock inside, so `J1`-`J5` can pin the range
 *   maths at chosen instants without faking timers.
 */
export const runInvoiceGenerationJob = async (
  deps: InvoiceGenerationJobDeps,
  now: Date = new Date()
): Promise<InvoiceGenerationSummary> => {
  const { periodStart, periodEnd } = getPreviousDayRange(now);
  deps.logger.info({ periodStart, periodEnd }, WORKER_INVOICE_JOB.LOG.STARTED);

  let tenants: TenantId[];
  try {
    tenants = await deps.enumeration.listTenantsWithUnbilledUsage(periodStart, periodEnd);
  } catch (error) {
    deps.logger.error(
      { periodStart, periodEnd, error: describeError(error) },
      WORKER_INVOICE_JOB.LOG.ENUMERATION_FAILED
    );
    throw error;
  }

  deps.logger.info(
    { periodStart, periodEnd, tenants: tenants.length },
    WORKER_INVOICE_JOB.LOG.ENUMERATED
  );

  let succeeded = 0;
  let failed = 0;
  for (const tenantId of tenants) {
    try {
      const outcome = await deps.billingClient.generateInvoice(tenantId, periodStart, periodEnd);
      succeeded += 1;
      // `created` distinguishes a new draft from an existing invoice or a tenant with nothing
      // billable. The invoice id itself is not logged: it is response-body content, and the
      // same rule that keeps payload fields out of `EventProcessorService`'s logs applies here.
      deps.logger.info(
        { tenantId, periodStart, periodEnd, created: outcome.created },
        WORKER_INVOICE_JOB.LOG.TENANT_SUCCEEDED
      );
    } catch (error) {
      failed += 1;
      deps.logger.error(
        { tenantId, periodStart, periodEnd, error: describeError(error) },
        WORKER_INVOICE_JOB.LOG.TENANT_FAILED
      );
    }
  }

  const summary: InvoiceGenerationSummary = {
    periodStart,
    periodEnd,
    tenants: tenants.length,
    succeeded,
    failed
  };
  deps.logger.info(summary, WORKER_INVOICE_JOB.LOG.COMPLETED);

  return summary;
};
