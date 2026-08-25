import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { env, type ServiceEnv } from "./config/env";
import { createContainer, type AppContainer } from "./config/container";
import {
  ANALYTICS_RESPONSES,
  ANALYTICS_ROUTES,
  ANALYTICS_SERVICE_NAME
} from "./constants";

export const buildAnalyticsServiceApp = (): FastifyInstance & { container: AppContainer } => {
  const app = Fastify({ logger: true });
  const container = createContainer(ANALYTICS_SERVICE_NAME, env as ServiceEnv);
  app.decorate("container", container);

  registerGlobalErrorHandler(app);

  // Add cleanup hook for Redis connection
  app.addHook("onClose", async () => {
    if (container.redis.status === "ready" || container.redis.status === "connecting") {
      await container.redis.quit();
    }
  });

  app.get(ANALYTICS_ROUTES.HEALTH, async () => {
    container.logger.info("Health check called");
    return {
      status: ANALYTICS_RESPONSES.STATUS_OK,
      service: container.serviceName
    };
  });

  return app as unknown as FastifyInstance & { container: AppContainer };
};
