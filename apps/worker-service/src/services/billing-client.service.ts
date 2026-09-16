import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import type { ServiceEnv } from "../config/env";
import { WORKER_BILLING_CLIENT } from "../constants";
import { describeError } from "../utils/describe-error";

/**
 * What billing-service said about one tenant's invoice.
 *
 * `created` distinguishes `201` (a draft invoice was written) from `200`, which covers two
 * different things billing treats alike: an invoice already existed for this period, or the
 * tenant had nothing billable (`{ data: { invoiceId: null } }`). Both are successes for this
 * caller. `invoiceId` is `null` in the second case and is carried only so the job's log line can
 * say which invoice a night produced.
 */
export interface GenerateInvoiceOutcome {
  readonly created: boolean;
  readonly invoiceId: string | null;
}

interface GenerateInvoiceResponseBody {
  readonly data?: { readonly invoiceId?: string | null };
  readonly code?: string;
}

/**
 * The HTTP call into `POST /v1/internal/billing/generate`.
 *
 * Constructor-injected `(env, logger)`, mirroring every other collaborator in this service.
 * `docs/epics/epic-7-worker-service.md:214-231` writes this as a free function closing over a
 * module-scope `billingServiceUrl` and `env`; nothing in worker-service is shaped that way, and
 * the same objection is already recorded against the T-041 and T-043 snippets in the same file
 * (S-32, S-35). Reported as a divergence rather than followed.
 *
 * ## Transport
 *
 * Node 22's global `fetch` (`node -v` -> `v22.22.2`), so no HTTP dependency is added. Every
 * request carries `AbortSignal.timeout(WORKER_BILLING_CLIENT.TIMEOUT_MS)`: `fetch` has no
 * default timeout, the nightly loop is sequential, and without a ceiling one unresponsive
 * billing-service stalls every tenant after it for as long as the socket stays open. The epic
 * mentions no timeout and no error-status handling at all.
 *
 * ## Idempotency is billing's, not this service's
 *
 * Re-running a night that is already billed does not double-invoice: `BillingService.
 * generateInvoice` looks the period up by `Invoice @@unique([tenantId, periodStart, periodEnd])`
 * and returns the existing invoice with `created: false` before doing any further read, and the
 * unique constraint is the backstop behind that. Stated as scoped to this path rather than as a
 * universal — it rests entirely on another service's code, and S-38 records that the `P2002`
 * re-read behind it has unit coverage only. This task does not close S-38 and must not be read
 * as having done so; it does make that path reachable more often, since a nightly job plus a
 * BullMQ retry can drive concurrent calls.
 *
 * ## What is not logged
 *
 * Never the response body. The same rule `EventProcessorService` follows about never logging
 * payload fields — a failure line carries the status and billing's `code`, and nothing else.
 */
export class BillingClientService {
  private readonly endpoint: string;

  constructor(
    private readonly env: ServiceEnv,
    private readonly logger: Logger
  ) {
    this.endpoint = `${this.env.BILLING_SERVICE_URL}${WORKER_BILLING_CLIENT.GENERATE_PATH}`;
  }

  /**
   * Asks billing-service to generate the draft invoice for one tenant and one period.
   *
   * The three body keys are exactly what `generateInvoiceRequestSchema` requires. They are not
   * decoration: a helper returning `{ from, to }` would produce a `400 VALIDATION_ERROR` from a
   * call site that reads correct, which is why `getPreviousDayRange` returns these names and
   * `J4` asserts them.
   *
   * @throws when the reply is neither `201` nor `200`, or when the request itself fails or times
   *   out. Both are rejections rather than a falsy return, because the caller counts outcomes
   *   and a silent "no" would be counted as a billed tenant.
   */
  async generateInvoice(
    tenantId: TenantId,
    periodStart: string,
    periodEnd: string
  ): Promise<GenerateInvoiceOutcome> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: WORKER_BILLING_CLIENT.METHOD_POST,
        headers: {
          [WORKER_BILLING_CLIENT.HEADER_CONTENT_TYPE]: WORKER_BILLING_CLIENT.CONTENT_TYPE_JSON,
          [WORKER_BILLING_CLIENT.HEADER_INTERNAL_SECRET]: this.env.INTERNAL_API_SECRET
        },
        body: JSON.stringify({ tenantId, periodStart, periodEnd }),
        signal: AbortSignal.timeout(WORKER_BILLING_CLIENT.TIMEOUT_MS)
      });
    } catch (error) {
      // `cause` preserved: an `AbortSignal.timeout` fires a `TimeoutError` `DOMException` and a
      // DNS or connect failure fires a `TypeError`, and the two need different operator
      // responses. `describeError` renders the message for the log line; the original is kept
      // attached so a future handler can discriminate without re-parsing that string.
      throw new Error(
        `${WORKER_BILLING_CLIENT.ERROR.REQUEST_FAILED}${WORKER_BILLING_CLIENT.ERROR.SEPARATOR}${describeError(error)}`,
        { cause: error }
      );
    }

    const body = await this.readBody(response);
    if (
      response.status !== WORKER_BILLING_CLIENT.HTTP_STATUS_CREATED &&
      response.status !== WORKER_BILLING_CLIENT.HTTP_STATUS_OK
    ) {
      // The status, and billing's own `code` when it sent one. Never the body.
      const detail = body?.code
        ? `${String(response.status)}${WORKER_BILLING_CLIENT.ERROR.SEPARATOR}${body.code}`
        : String(response.status);
      throw new Error(
        `${WORKER_BILLING_CLIENT.ERROR.UNEXPECTED_STATUS}${WORKER_BILLING_CLIENT.ERROR.SEPARATOR}${detail}`
      );
    }

    return {
      created: response.status === WORKER_BILLING_CLIENT.HTTP_STATUS_CREATED,
      invoiceId: body?.data?.invoiceId ?? null
    };
  }

  /**
   * Parses the reply body, tolerating one that is not JSON.
   *
   * A non-JSON error page from a proxy must not turn a `502` into a parse error that loses the
   * status — the status is the part the operator needs.
   */
  private async readBody(response: Response): Promise<GenerateInvoiceResponseBody | null> {
    try {
      return (await response.json()) as GenerateInvoiceResponseBody;
    } catch (error) {
      this.logger.debug(
        { status: response.status, error: describeError(error) },
        WORKER_BILLING_CLIENT.ERROR.REQUEST_FAILED
      );

      return null;
    }
  }
}
