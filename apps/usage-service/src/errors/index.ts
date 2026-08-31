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

/**
 * The `X-Tenant-Id` header was present but is not a UUID.
 *
 * Distinct from `TenantContextMissingError` on purpose: reusing "header is required" for a
 * header that *was* supplied would misdescribe the failure to whoever is reading the logs.
 * Both are only reachable after the caller has already proved it is the gateway, so the extra
 * detail is not exposed to an unauthenticated client.
 */
export class TenantContextInvalidError extends AppError {
	constructor() {
		super(
			USAGE_SERVICE_RESPONSES.CODE_TENANT_CONTEXT_INVALID,
			USAGE_SERVICE_RESPONSES.HTTP_STATUS_UNAUTHORIZED,
			USAGE_SERVICE_RESPONSES.MESSAGE_TENANT_CONTEXT_INVALID
		);
	}
}

/**
 * The caller did not prove it is an internal service (S-4).
 *
 * Deliberately identical for a missing and for a mismatched secret -- see D-3 in
 * `docs/plans/s-004-internal-service-auth.md`.
 */
export class InternalAuthRequiredError extends AppError {
	constructor() {
		super(
			USAGE_SERVICE_RESPONSES.CODE_UNAUTHORIZED,
			USAGE_SERVICE_RESPONSES.HTTP_STATUS_UNAUTHORIZED,
			USAGE_SERVICE_RESPONSES.MESSAGE_UNAUTHORIZED
		);
	}
}
