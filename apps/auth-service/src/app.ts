import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { env, type ServiceEnv } from "./config/env";
import { createContainer, type AppContainer } from "./config/container";
import { AUTH_RESPONSES, AUTH_ROUTES, AUTH_SERVICE_NAME } from "./constants";
import { registerAuthRoutes } from "./routes";

export const buildAuthServiceApp = (): FastifyInstance & { container: AppContainer } => {
  const app = Fastify({ logger: true });
  const container = createContainer(AUTH_SERVICE_NAME, env as ServiceEnv);
  app.decorate("container", container);

  registerGlobalErrorHandler(app);

  // Add cleanup hook for Redis connection
  app.addHook("onClose", async () => {
    if (container.redis.status === "ready" || container.redis.status === "connecting") {
      await container.redis.quit();
    }
  });

  app.get(AUTH_ROUTES.HEALTH, async () => {
    container.logger.info("Health check called");
    return {
      status: AUTH_RESPONSES.STATUS_OK,
      service: container.serviceName
    };
  });

  app.register(registerAuthRoutes, { prefix: AUTH_ROUTES.V1_AUTH });

  return app as unknown as FastifyInstance & { container: AppContainer };
};
