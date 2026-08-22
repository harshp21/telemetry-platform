import { AppError, ERROR_RESPONSES } from "@telemetry/shared-types";

export { AppError, ERROR_RESPONSES };

export class TenantMismatchError extends AppError {
	constructor() {
		super(
			"TENANT_MISMATCH",
			403,
			"Event tenantId does not match authenticated tenant context"
		);
	}
}
