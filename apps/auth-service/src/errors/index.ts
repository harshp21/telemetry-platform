import { AppError, ERROR_RESPONSES, ForbiddenError } from "@telemetry/shared-types";
import { AUTH_HTTP_STATUS, AUTH_MESSAGES, AUTH_RESPONSES } from "../constants";

export { AppError, ERROR_RESPONSES, ForbiddenError };

export class EmailAlreadyExistsError extends AppError {
	constructor() {
		super(
			AUTH_RESPONSES.CODE_EMAIL_ALREADY_EXISTS,
			AUTH_HTTP_STATUS.CONFLICT,
			AUTH_MESSAGES.REGISTRATION_FAILED
		);
	}
}
