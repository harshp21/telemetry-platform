import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { createContainer } from "./config/container";
import { AUTH_RESPONSES, AUTH_ROUTES, AUTH_SERVICE_NAME } from "./constants";

export const buildAuthServiceApp = (): FastifyInstance => {
  const app = Fastify({ logger: true });
  const container = createContainer(AUTH_SERVICE_NAME);

  registerGlobalErrorHandler(app);

  app.get(AUTH_ROUTES.HEALTH, async () => {
    return {
      status: AUTH_RESPONSES.STATUS_OK,
      service: container.serviceName
    };
  });

  return app;
};
