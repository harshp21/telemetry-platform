import { AppError, ERROR_RESPONSES } from "@telemetry/shared-types";

export { AppError, ERROR_RESPONSES };

export class InternalApiSecretMissingError extends AppError {
	constructor() {
		super(
			ERROR_RESPONSES.CODE_INTERNAL_ERROR,
			500,
			"INTERNAL_API_SECRET must be configured for worker-service"
		);
	}
}
