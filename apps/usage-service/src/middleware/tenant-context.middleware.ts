import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { TenantContextMissingError } from "../errors";
import { USAGE_SERVICE_ROUTES, USAGE_SERVICE_HEADERS } from "../constants";

/**
 * Fastify onRequest hook that extracts and validates the X-Tenant-Id header
 * and attaches the tenant context to the request object.
 *
 * Skips validation for health check endpoints.
 *
 * @param request - The Fastify request object
 * @param _reply - The Fastify reply object (unused in this implementation)
 * @throws TenantContextMissingError - If X-Tenant-Id header is missing or empty
 */
export const usageTenantContextHandler = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  // Skip tenant validation for health check route
  if (request.url === USAGE_SERVICE_ROUTES.HEALTH) {
    return;
  }

  const tenantId = request.headers[USAGE_SERVICE_HEADERS.TENANT_ID];

  if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new TenantContextMissingError();
  }

  request.tenantId = tenantId;
};

/**
 * Registers the tenant context middleware with the Fastify instance.
 * This middleware must be called before route handlers to ensure tenant context
 * is available throughout the request lifecycle.
 *
 * @param app - The Fastify application instance
 */
export const registerUsageTenantContextMiddleware = (
  app: FastifyInstance
): void => {
  app.addHook("onRequest", usageTenantContextHandler);
};
