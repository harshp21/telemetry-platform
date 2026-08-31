import type { FastifyRequest } from "fastify";
import { USAGE_SERVICE_ROUTES } from "../constants";

/**
 * Routes reachable without service-to-service auth and without tenant context.
 *
 * There is exactly one definition of this set, shared by the internal-auth hook and the
 * tenant-context hook, so the two can never drift into disagreeing about what is public.
 * Everything not listed here is protected by default -- a route added tomorrow is covered
 * without anyone remembering to cover it.
 */
export const USAGE_SERVICE_PUBLIC_ROUTES: ReadonlySet<string> = new Set<string>([
  USAGE_SERVICE_ROUTES.HEALTH
]);

export const isPublicRoute = (request: FastifyRequest): boolean => {
  return USAGE_SERVICE_PUBLIC_ROUTES.has(request.url);
};
