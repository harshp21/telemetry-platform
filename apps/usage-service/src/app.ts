import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { env, type ServiceEnv } from "./config/env";
import { createContainer, type AppContainer } from "./config/container";
import {
  registerUsageInternalAuthMiddleware,
  registerUsageTenantContextMiddleware
} from "./middleware";
import { registerEventsRoutes } from "./routes/events.routes";
import { registerUsageRoutes } from "./routes/usage.routes";
import "./types";
import {
  USAGE_SERVICE_NAME,
  USAGE_SERVICE_RESPONSES,
  USAGE_SERVICE_ROUTES
} from "./constants";

export const buildUsageServiceApp = (): FastifyInstance & { container: AppContainer } => {
  const app = Fastify({ logger: true });
  const container = createContainer(USAGE_SERVICE_NAME, env as ServiceEnv);
  app.decorate("container", container);

  registerGlobalErrorHandler(app);
  // Order is the security contract (S-4): Fastify runs onRequest hooks in registration order,
  // so the service-to-service secret is checked before any tenant work happens. A caller that
  // has not proved it is the gateway must not cause tenant context to be derived at all.
  registerUsageInternalAuthMiddleware(app, env.INTERNAL_API_SECRET);
  registerUsageTenantContextMiddleware(app);

  // Add cleanup hook for Redis connection
  app.addHook("onClose", async () => {
    if (container.redis.status === "ready" || container.redis.status === "connecting") {
      await container.redis.quit();
    }
  });

  app.get(USAGE_SERVICE_ROUTES.HEALTH, async () => {
    container.logger.info("Health check called");
    return {
      status: USAGE_SERVICE_RESPONSES.STATUS_OK,
      service: container.serviceName
    };
  });

  // Register events ingestion routes
  registerEventsRoutes(app, container.eventsController);

  // Register usage reporting routes
  registerUsageRoutes(app, container.usageController);

  return app as unknown as FastifyInstance & { container: AppContainer };
};
