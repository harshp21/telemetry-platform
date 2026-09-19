import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { AnalyticsService } from "../services/analytics.service";
import { AppError } from "../errors";
import { metricsQuerySchema } from "../validators/metrics-query.validator";
import { ANALYTICS_RESPONSES } from "../constants";

/**
 * HTTP handler for `GET /v1/analytics/metrics`.
 *
 * Thin by contract: validate, read the bound tenant, delegate, normalize errors.
 *
 * 1. Validate the querystring. Invalid -> `400 VALIDATION_ERROR` with the joined zod issues.
 * 2. Read `request.tenantId`, set by `analyticsTenantContextHandler`.
 * 3. Delegate to `AnalyticsService`.
 * 4. `200 { data: PaginatedResult }`.
 * 5. `AppError` -> its own status and code; anything else -> `500 INTERNAL_ERROR`.
 *
 * ## Why this catches instead of letting the global handler answer
 *
 * `registerGlobalErrorHandler` sends `error.message` on any non-`AppError` whenever `NODE_ENV`
 * is not `production` -- which includes every developer machine. The repository issues raw SQL,
 * and a Prisma `P2010` message carries the rendered query tree **and the tenant id**; S-40
 * measured exactly that shape on billing-service. Catching here is what keeps it in the log and
 * out of the response body. `AM22b` asserts the body is the bare code with no `message` key at
 * all.
 *
 * ## Why an absent tenant is a 500 and not a 400
 *
 * This route is registered **inside** the `app.register` scope that carries the tenant-context
 * hook, so a request that reaches this handler has already had `request.tenantId` set or been
 * rejected with `401`. The property is optional in the type because `/health` sits outside that
 * scope, not because this path can see it absent.
 *
 * If it *is* absent, the route has escaped its scope -- a server wiring fault, not a client
 * mistake. usage-service answers `400 VALIDATION_ERROR` here, which is the right call there
 * because its hooks are global with a public-route allowlist, so an allowlisted route genuinely
 * can reach a controller untenanted. Blaming the client for a misconfiguration analytics cannot
 * reach that way would be wrong, and it would need a third copy of
 * `"Missing tenantId from context"` that the constants rule asks to be promoted instead. The
 * guard is kept rather than cast away: a repository constructed with `undefined` would bind
 * `set_config('app.tenant_id', NULL)`, and under RLS `"tenantId" = NULL` is `NULL` for every
 * row -- silently empty results rather than an error.
 */
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly logger: Logger
  ) {}

  async handle(request: FastifyRequest, response: FastifyReply): Promise<void> {
    try {
      const validationResult = metricsQuerySchema.safeParse(request.query);
      if (!validationResult.success) {
        response.status(ANALYTICS_RESPONSES.HTTP_STATUS_BAD_REQUEST).send({
          code: ANALYTICS_RESPONSES.CODE_VALIDATION_ERROR,
          message: validationResult.error.errors
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        });
        return;
      }

      const tenantId = request.tenantId;
      if (!tenantId) {
        this.logger.error(
          { path: request.url },
          "Metrics route reached with no tenant context: it is registered outside the guarded scope"
        );
        response.status(ANALYTICS_RESPONSES.HTTP_STATUS_INTERNAL_ERROR).send({
          code: ANALYTICS_RESPONSES.CODE_INTERNAL_ERROR
        });
        return;
      }

      const rollup = await this.analyticsService.getMetricsRollup(tenantId, validationResult.data);

      response.status(ANALYTICS_RESPONSES.HTTP_STATUS_OK).send({ data: rollup });
    } catch (error) {
      if (error instanceof AppError) {
        response.status(error.statusCode).send({ code: error.code, message: error.message });
        return;
      }

      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          path: request.url
        },
        "Unexpected error in analytics metrics controller"
      );

      response.status(ANALYTICS_RESPONSES.HTTP_STATUS_INTERNAL_ERROR).send({
        code: ANALYTICS_RESPONSES.CODE_INTERNAL_ERROR
      });
    }
  }
}
