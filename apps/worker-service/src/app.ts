import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { env, type ServiceEnv } from "./config/env";
import { createContainer } from "./config/container";
import {
  WORKER_RESPONSES,
  WORKER_ROUTES,
  WORKER_SERVICE_NAME
} from "./constants";
import { InternalApiSecretMissingError } from "./errors";
import { buildInternalAuthMiddleware } from "./middleware/internal-auth.middleware";

interface BuildWorkerServiceAppOptions {
  internalApiSecret?: string;
}

export const buildWorkerServiceApp = (
  options: BuildWorkerServiceAppOptions = {}
): FastifyInstance => {
  const app = Fastify({ logger: true });
  const container = createContainer(WORKER_SERVICE_NAME, env as ServiceEnv);
  app.decorate("container", container);
  const internalApiSecret = options.internalApiSecret ?? process.env.INTERNAL_API_SECRET ?? "";

  registerGlobalErrorHandler(app);

  // Add cleanup hook for Redis connection
  app.addHook("onClose", async () => {
    if (container.redis.status === "ready" || container.redis.status === "connecting") {
      await container.redis.quit();
    }
  });

  if (!internalApiSecret.trim()) {
    throw new InternalApiSecretMissingError();
  }

  app.get(WORKER_ROUTES.HEALTH, async () => {
    container.logger.info("Health check called");
    return {
      status: WORKER_RESPONSES.STATUS_OK,
      service: container.serviceName
    };
  });

  app.register(async (internalRoutes) => {
    const internalAuth = buildInternalAuthMiddleware(internalApiSecret);

    internalRoutes.addHook("preHandler", internalAuth);

    internalRoutes.post(WORKER_ROUTES.INTERNAL_WORKER_REPLAY, async () => {
      return {
        status: WORKER_RESPONSES.STATUS_ACCEPTED,
        workflow: WORKER_RESPONSES.WORKFLOW_USAGE_REPLAY
      };
    });
  });

  return app;
};
