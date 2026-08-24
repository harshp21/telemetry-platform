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

export class InvalidCredentialsError extends AppError {
	constructor() {
		super(
			AUTH_RESPONSES.CODE_INVALID_CREDENTIALS,
			AUTH_HTTP_STATUS.UNAUTHORIZED,
			AUTH_MESSAGES.INVALID_CREDENTIALS
		);
	}
}

export class InvalidRefreshTokenError extends AppError {
	constructor() {
		super(
			AUTH_RESPONSES.CODE_REFRESH_TOKEN_INVALID,
			AUTH_HTTP_STATUS.UNAUTHORIZED,
			AUTH_MESSAGES.INVALID_REFRESH_TOKEN
		);
	}
}

export class UnauthorizedError extends AppError {
	constructor() {
		super(
			AUTH_RESPONSES.CODE_UNAUTHORIZED,
			AUTH_HTTP_STATUS.UNAUTHORIZED,
			AUTH_MESSAGES.UNAUTHORIZED
		);
	}
}

export class MissingOrMalformedTokenError extends AppError {
	constructor() {
		super(
			AUTH_RESPONSES.CODE_TOKEN_MISSING,
			AUTH_HTTP_STATUS.UNAUTHORIZED,
			AUTH_MESSAGES.TOKEN_MISSING
		);
	}
}

export class InvalidTokenError extends AppError {
	constructor() {
		super(
			AUTH_RESPONSES.CODE_TOKEN_INVALID,
			AUTH_HTTP_STATUS.UNAUTHORIZED,
			AUTH_MESSAGES.TOKEN_INVALID
		);
	}
}

export class ExpiredTokenError extends AppError {
	constructor() {
		super(
			AUTH_RESPONSES.CODE_TOKEN_EXPIRED,
			AUTH_HTTP_STATUS.UNAUTHORIZED,
			AUTH_MESSAGES.TOKEN_EXPIRED
		);
	}
}

export class RevokedTokenError extends AppError {
	constructor() {
		super(
			AUTH_RESPONSES.CODE_TOKEN_REVOKED,
			AUTH_HTTP_STATUS.UNAUTHORIZED,
			AUTH_MESSAGES.TOKEN_REVOKED
		);
	}
}
