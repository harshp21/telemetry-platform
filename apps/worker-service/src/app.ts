import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
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
  const container = createContainer(WORKER_SERVICE_NAME);
  const internalApiSecret = options.internalApiSecret ?? process.env.INTERNAL_API_SECRET ?? "";

  registerGlobalErrorHandler(app);

  if (!internalApiSecret.trim()) {
    throw new InternalApiSecretMissingError();
  }

  app.get(WORKER_ROUTES.HEALTH, async () => {
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
