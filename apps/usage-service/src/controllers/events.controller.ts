import type { FastifyRequest, FastifyReply } from "fastify";
import type { Logger } from "pino";
import type { IngestionResult, IngestionService } from "../services/ingestion.service";
import { AppError as AppErrorClass, TenantMismatchError as TenantMismatchErrorClass } from "../errors";
import { ingestRequestSchema, INGESTION_CONSTANTS } from "../validators/events.validator";
import { USAGE_SERVICE_RESPONSES } from "../constants";

/**
 * EventsController: HTTP handler for POST /v1/usage/events
 *
 * Flow:
 * 1. Validate request body (batch size 1-100, full TelemetryEventEnvelope objects)
 * 2. Extract tenantId from request.tenantId (set by T-034 middleware)
 * 3. Validate tenant in events matches header tenant
 * 4. Validate timestamps for clock skew
 * 5. Call IngestionService.ingestEvents(tenantId, events)
 * 6. Return 202 Accepted with { data: { accepted, duplicate, rejected } }
 * 7. Error handling: ValidationError → 400, BATCH_TOO_LARGE → 400, FUTURE_CLOCK_SKEW → 400, TenantMismatchError → 403, other → 500
 */
export class EventsController {
	constructor(
		private readonly ingestionService: IngestionService,
		private readonly logger: Logger
	) {}

	/**
	 * Handle POST /v1/usage/events
	 *
	 * @param request - Fastify request with tenantId from T-034 middleware
	 * @param response - Fastify reply
	 */
	async handle(request: FastifyRequest, response: FastifyReply): Promise<void> {
		try {
			// Step 1: Validate request body structure and batch size
			const validationResult = ingestRequestSchema.safeParse(request.body);
			if (!validationResult.success) {
				const errors = validationResult.error.errors;
				const errorMsg = errors
					.map((e) => `${e.path.join(".")}: ${e.message}`)
					.join("; ");

				// Determine error code from structured issues (avoid brittle message matching)
				let errorCode: typeof INGESTION_CONSTANTS.ERROR_CODES.VALIDATION_ERROR | typeof INGESTION_CONSTANTS.ERROR_CODES.BATCH_TOO_LARGE = INGESTION_CONSTANTS.ERROR_CODES.VALIDATION_ERROR;
				const hasBatchTooLargeIssue = errors.some(
					(issue) =>
						issue.code === "too_big" &&
						issue.path.length === 1 &&
						issue.path[0] === "events"
				);
				if (hasBatchTooLargeIssue) {
					errorCode = INGESTION_CONSTANTS.ERROR_CODES.BATCH_TOO_LARGE;
				}

				response.status(400).send({
					code: errorCode,
					message: errorMsg
				});
				return;
			}

			const events = validationResult.data.events;

			// Step 2: Extract tenantId from request (set by T-034 middleware)
			const tenantId = request.tenantId as string;
			if (!tenantId) {
				response.status(400).send({
					code: INGESTION_CONSTANTS.ERROR_CODES.VALIDATION_ERROR,
					message: "Missing tenantId from context"
				});
				return;
			}

			// Step 3: Validate timestamps for clock skew at request level
			const clockSkewError = this.validateClockSkew(events);
			if (clockSkewError) {
				response.status(400).send({
					code: INGESTION_CONSTANTS.ERROR_CODES.FUTURE_CLOCK_SKEW,
					message: clockSkewError
				});
				return;
			}

			// Step 4: Call service
			const result: IngestionResult = await this.ingestionService.ingestEvents(
				tenantId,
				events
			);

			// Step 5: Return 202 Accepted
			response.status(USAGE_SERVICE_RESPONSES.HTTP_STATUS_ACCEPTED).send({
				data: result
			});
		} catch (error) {
			// Error handling
			if (error instanceof TenantMismatchErrorClass) {
				response.status(error.statusCode).send({
					code: error.code,
					message: error.message
				});
				return;
			}

			if (error instanceof AppErrorClass) {
				// AppError has statusCode property
				response.status(error.statusCode).send({
					code: error.code,
					message: error.message
				});
				return;
			}

			// Log unexpected errors
			this.logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					path: request.url
				},
				"Unexpected error in events controller"
			);

			response.status(500).send({
				code: INGESTION_CONSTANTS.ERROR_CODES.INTERNAL_ERROR,
				message: "Internal server error"
			});
		}
	}

	/**
	 * Validate timestamps for clock skew (±5 min)
	 * Returns error message if any event timestamp is outside ±5 minute tolerance
	 */
	private validateClockSkew(
		events: Array<{ occurredAt: string }>
	): string | null {
		const nowSeconds = Math.floor(Date.now() / 1000);
		const toleranceSeconds = INGESTION_CONSTANTS.CLOCK_SKEW_TOLERANCE_SECONDS;

		for (const event of events) {
			try {
				const eventSeconds = Math.floor(
					new Date(event.occurredAt).getTime() / 1000
				);
				const delta = eventSeconds - nowSeconds;
                const skew = Math.abs(delta);

				if (skew > toleranceSeconds) {
					return `Event timestamp skew ${delta}s exceeds tolerance ${toleranceSeconds}s`;
				}
			} catch {
				return "Invalid ISO8601 timestamp format";
			}
		}

		return null;
	}
}
