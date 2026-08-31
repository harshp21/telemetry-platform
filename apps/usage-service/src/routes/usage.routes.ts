import type { FastifyInstance } from "fastify";
import type { UsageController } from "../controllers/usage.controller";
import { USAGE_SERVICE_ROUTES } from "../constants";

/**
 * Register usage reporting routes.
 *
 * @param app - Fastify app instance
 * @param controller - UsageController instance
 */
export const registerUsageRoutes = (
  app: FastifyInstance,
  controller: UsageController
): void => {
  app.get(USAGE_SERVICE_ROUTES.USAGE_SUMMARY, async (request, reply) => {
    return controller.handle(request, reply);
  });
};
