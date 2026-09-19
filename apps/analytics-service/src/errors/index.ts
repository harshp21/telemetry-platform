import { AppError, ERROR_RESPONSES, ForbiddenError } from "@telemetry/shared-types";
import { ANALYTICS_RESPONSES } from "../constants";

export { AppError, ERROR_RESPONSES, ForbiddenError };

/**
 * `X-Tenant-Id` was absent or blank (S-9).
 *
 * `401` rather than `400`, matching `apps/usage-service/src/errors/index.ts` and
 * `apps/billing-service/src/errors/index.ts`: the header is injected by the gateway from
 * verified JWT context, so its absence means the caller did not arrive through an authenticated
 * path -- not that it sent a malformed request body.
 */
export class TenantContextMissingError extends AppError {
  constructor() {
    super(
      ANALYTICS_RESPONSES.CODE_TENANT_CONTEXT_MISSING,
      ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED,
      ANALYTICS_RESPONSES.MESSAGE_TENANT_CONTEXT_MISSING
    );
  }
}

/**
 * `X-Tenant-Id` was present but is not a UUID (S-9), which includes the comma-joined value a
 * duplicated header arrives as.
 *
 * Distinct from `TenantContextMissingError` on purpose: reusing "header is required" for a
 * header that *was* supplied misdescribes the failure to whoever reads the log. Both are only
 * reachable after the caller has proved it is an internal service, so the extra detail is not
 * exposed to an unauthenticated client.
 */
export class TenantContextInvalidError extends AppError {
  constructor() {
    super(
      ANALYTICS_RESPONSES.CODE_TENANT_CONTEXT_INVALID,
      ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED,
      ANALYTICS_RESPONSES.MESSAGE_TENANT_CONTEXT_INVALID
    );
  }
}
