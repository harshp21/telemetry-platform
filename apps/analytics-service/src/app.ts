import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { createContainer } from "./config/container";
import {
  ANALYTICS_RESPONSES,
  ANALYTICS_ROUTES,
  ANALYTICS_SERVICE_NAME
} from "./constants";

export const buildAnalyticsServiceApp = (): FastifyInstance => {
  const app = Fastify({ logger: true });
  const container = createContainer(ANALYTICS_SERVICE_NAME);

  registerGlobalErrorHandler(app);

  app.get(ANALYTICS_ROUTES.HEALTH, async () => {
    return {
      status: ANALYTICS_RESPONSES.STATUS_OK,
      service: container.serviceName
    };
  });

  return app;
};
