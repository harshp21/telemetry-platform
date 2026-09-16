import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { InvoiceService } from "../services/invoice.service";
import { AppError } from "../errors";
import { invoiceListQuerySchema } from "../validators/invoice-list.validator";
import { BILLING_RESPONSES } from "../constants";

/**
 * HTTP handler for `GET /v1/billing/invoices`.
 *
 * Thin by design, mirroring `apps/usage-service/src/controllers/usage.controller.ts`:
 *
 * 1. Validate the querystring (`status` / `page` / `pageSize`).
 * 2. Read `tenantId` from `request.tenantId`, set by `billingTenantContextHandler`.
 * 3. Delegate to `InvoiceService`.
 * 4. `200 { data: PaginatedResult }`.
 * 5. Errors: validation -> `400 VALIDATION_ERROR`, `AppError` -> its own status and code,
 *    anything else -> `500` with a body that says nothing about the failure.
 */
export class BillingController {
  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly logger: Logger
  ) {}

  async listInvoices(request: FastifyRequest, response: FastifyReply): Promise<void> {
    try {
      const validationResult = invoiceListQuerySchema.safeParse(request.query);
      if (!validationResult.success) {
        response.status(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST).send({
          code: BILLING_RESPONSES.CODE_VALIDATION_ERROR,
          message: validationResult.error.errors
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        });
        return;
      }

      // Type-required rather than decorative: `FastifyRequest.tenantId` is declared optional
      // (`src/types/index.ts`) because the hook that sets it runs only inside the guarded
      // scope. Without this branch a request that somehow reached the handler unscoped would
      // construct a repository bound to `undefined`.
      const tenantId = request.tenantId;
      if (!tenantId) {
        response.status(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST).send({
          code: BILLING_RESPONSES.CODE_VALIDATION_ERROR,
          message: BILLING_RESPONSES.MESSAGE_TENANT_CONTEXT_REQUIRED
        });
        return;
      }

      const invoices = await this.invoiceService.listInvoices(tenantId, validationResult.data);

      response.status(BILLING_RESPONSES.HTTP_STATUS_OK).send({ data: invoices });
    } catch (error) {
      if (error instanceof AppError) {
        response.status(error.statusCode).send({
          code: error.code,
          message: error.message
        });
        return;
      }

      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          path: request.url
        },
        "Unexpected error in invoice list controller"
      );

      response.status(BILLING_RESPONSES.HTTP_STATUS_INTERNAL_ERROR).send({
        code: BILLING_RESPONSES.CODE_INTERNAL_ERROR,
        message: BILLING_RESPONSES.MESSAGE_INTERNAL_ERROR
      });
    }
  }
}
