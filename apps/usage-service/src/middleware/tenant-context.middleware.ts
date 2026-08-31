import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { uuidSchema } from "@telemetry/shared-validation";
import { TenantContextInvalidError, TenantContextMissingError } from "../errors";
import { USAGE_SERVICE_HEADERS } from "../constants";
import { isPublicRoute } from "./public-routes";

/**
 * Fastify onRequest hook that extracts and validates the X-Tenant-Id header
 * and attaches the tenant context to the request object.
 *
 * Skips validation for the public routes (health check).
 *
 * The header must be a UUID, not merely non-empty. `Tenant.id` is `String @default(uuid())`
 * (`prisma/schema.prisma`), and downstream code relies on that shape: `DeduplicationService`
 * builds Redis keys as `dedup:<tenantId>:<idempotencyKey>`, which is only unambiguous while a
 * tenant id cannot contain `:`. See M-2 in `docs/reviews/s-001-dedup-key-namespacing.md`.
 *
 * The value is validated, never normalised -- what reaches `request.tenantId` is byte-identical
 * to what the gateway sent.
 *
 * @param request - The Fastify request object
 * @param _reply - The Fastify reply object (unused in this implementation)
 * @throws TenantContextMissingError - If X-Tenant-Id header is missing or empty
 * @throws TenantContextInvalidError - If X-Tenant-Id header is present but not a UUID
 */
export const usageTenantContextHandler = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  // Skip tenant validation for routes that carry no tenant context
  if (isPublicRoute(request)) {
    return;
  }

  const tenantId = request.headers[USAGE_SERVICE_HEADERS.TENANT_ID];

  if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new TenantContextMissingError();
  }

  if (!uuidSchema.safeParse(tenantId).success) {
    throw new TenantContextInvalidError();
  }

  request.tenantId = tenantId;
};

/**
 * Registers the tenant context middleware with the Fastify instance.
 * This middleware must be called before route handlers to ensure tenant context
 * is available throughout the request lifecycle.
 *
 * It must be registered *after* `registerUsageInternalAuthMiddleware`, so that no tenant
 * context is derived for a caller that has not proved it is an internal service.
 *
 * @param app - The Fastify application instance
 */
export const registerUsageTenantContextMiddleware = (
  app: FastifyInstance
): void => {
  app.addHook("onRequest", usageTenantContextHandler);
};
