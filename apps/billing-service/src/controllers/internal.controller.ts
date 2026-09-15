import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { AppError } from "../errors";
import type { BillingService } from "../services/billing.service";
import { generateInvoiceRequestSchema } from "../validators/generate-invoice.validator";
import { BILLING_RESPONSES } from "../constants";

/**
 * HTTP handler for `POST /v1/internal/billing/generate`.
 *
 * Thin by design, mirroring `apps/usage-service/src/controllers/usage.controller.ts`:
 *
 * 1. validate the body -- `400 VALIDATION_ERROR` with the issues joined into `message`;
 * 2. delegate to `BillingService`;
 * 3. one envelope on every success path, `{ data: { invoiceId } }`, with `201` when this call
 *    created the invoice and `200` when it did not (an existing invoice, or no billable usage
 *    at all, which reads `invoiceId: null`);
 * 4. `AppError` keeps its own status and code; anything else is a `500` whose body says nothing
 *    about the failure.
 *
 * The caller has already proved it is an internal service: the guard is an `app.register`-scoped
 * `preHandler` in `app.ts` and runs before this handler. Measured at Gate 1 on fastify 5.10.0
 * with that exact shape -- a wrong secret gives `401` with the handler not running, though the
 * body is parsed before the rejection (S-8 item 3, left open by decision).
 */
export class InternalController {
  constructor(
    private readonly billingService: BillingService,
    private readonly logger: Logger
  ) {}

  async generate(request: FastifyRequest, response: FastifyReply): Promise<void> {
    try {
      const validationResult = generateInvoiceRequestSchema.safeParse(request.body);
      if (!validationResult.success) {
        response.status(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST).send({
          code: BILLING_RESPONSES.CODE_VALIDATION_ERROR,
          message: validationResult.error.errors
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        });
        return;
      }

      const result = await this.billingService.generateInvoice(validationResult.data);

      response
        .status(
          result.created
            ? BILLING_RESPONSES.HTTP_STATUS_CREATED
            : BILLING_RESPONSES.HTTP_STATUS_OK
        )
        .send({ data: { invoiceId: result.invoiceId } });
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
        "Unexpected error in internal billing generate controller"
      );

      response.status(BILLING_RESPONSES.HTTP_STATUS_INTERNAL_ERROR).send({
        code: BILLING_RESPONSES.CODE_INTERNAL_ERROR,
        message: BILLING_RESPONSES.MESSAGE_INTERNAL_ERROR
      });
    }
  }
}
