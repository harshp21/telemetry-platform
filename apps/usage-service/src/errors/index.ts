import { AppError, ERROR_RESPONSES } from "@telemetry/shared-types";
import {
	USAGE_SERVICE_RESPONSES
} from "../constants";

export { AppError, ERROR_RESPONSES };

export class TenantMismatchError extends AppError {
	constructor() {
		super(
			USAGE_SERVICE_RESPONSES.CODE_TENANT_MISMATCH,
			USAGE_SERVICE_RESPONSES.HTTP_STATUS_FORBIDDEN,
			USAGE_SERVICE_RESPONSES.MESSAGE_TENANT_MISMATCH
		);
	}
}

export class TenantContextMissingError extends AppError {
	constructor() {
		super(
			USAGE_SERVICE_RESPONSES.CODE_TENANT_CONTEXT_MISSING,
			USAGE_SERVICE_RESPONSES.HTTP_STATUS_UNAUTHORIZED,
			USAGE_SERVICE_RESPONSES.MESSAGE_TENANT_CONTEXT_MISSING
		);
	}
}
