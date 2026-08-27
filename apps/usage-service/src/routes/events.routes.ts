import type { FastifyInstance } from "fastify";
import type { EventsController } from "../controllers/events.controller";
import { USAGE_SERVICE_ROUTES } from "../constants";

/**
 * Register event ingestion routes.
 *
 * @param app - Fastify app instance
 * @param controller - EventsController instance
 */
export const registerEventsRoutes = (
	app: FastifyInstance,
	controller: EventsController
): void => {
	app.post(USAGE_SERVICE_ROUTES.USAGE_EVENTS, async (request, reply) => {
		return controller.handle(request, reply);
	});
};
