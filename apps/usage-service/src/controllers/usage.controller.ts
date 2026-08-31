import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { UsageService } from "../services/usage.service";
import { AppError } from "../errors";
import { usageSummaryQuerySchema } from "../validators/usage-summary.validator";
import { USAGE_SERVICE_RESPONSES } from "../constants";

/**
 * UsageController: HTTP handler for GET /v1/usage/summary.
 *
 * Flow:
 * 1. Validate the querystring (from/to/granularity/metricKey/page/pageSize).
 * 2. Read tenantId from request.tenantId (set by the tenant context middleware).
 * 3. Delegate to UsageService.
 * 4. Return 200 with { data: PaginatedResult }.
 * 5. Errors: validation -> 400 VALIDATION_ERROR, AppError -> its own status/code,
 *    anything else -> 500 INTERNAL_ERROR.
 */
export class UsageController {
  constructor(
    private readonly usageService: UsageService,
    private readonly logger: Logger
  ) {}

  async handle(request: FastifyRequest, response: FastifyReply): Promise<void> {
    try {
      const validationResult = usageSummaryQuerySchema.safeParse(request.query);
      if (!validationResult.success) {
        response.status(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST).send({
          code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR,
          message: validationResult.error.errors
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        });
        return;
      }

      const tenantId = request.tenantId;
      if (!tenantId) {
        response.status(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST).send({
          code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR,
          message: USAGE_SERVICE_RESPONSES.MESSAGE_TENANT_CONTEXT_REQUIRED
        });
        return;
      }

      const summary = await this.usageService.getUsageSummary(tenantId, validationResult.data);

      response.status(USAGE_SERVICE_RESPONSES.HTTP_STATUS_OK).send({ data: summary });
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
        "Unexpected error in usage summary controller"
      );

      response.status(USAGE_SERVICE_RESPONSES.HTTP_STATUS_INTERNAL_ERROR).send({
        code: USAGE_SERVICE_RESPONSES.CODE_INTERNAL_ERROR,
        message: USAGE_SERVICE_RESPONSES.MESSAGE_INTERNAL_ERROR
      });
    }
  }
}
