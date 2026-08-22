import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { createContainer } from "./config/container";
import {
  GATEWAY_RESPONSES,
  GATEWAY_ROUTES,
  GATEWAY_SERVICE_NAME
} from "./constants";

export const buildGatewayApp = (): FastifyInstance => {
  const app = Fastify({ logger: true });
  const container = createContainer(GATEWAY_SERVICE_NAME);

  registerGlobalErrorHandler(app);

  app.get(GATEWAY_ROUTES.HEALTH, async () => {
    return {
      status: GATEWAY_RESPONSES.STATUS_OK,
      service: container.serviceName
    };
  });

  app.get(GATEWAY_ROUTES.V1_HEALTH, async () => {
    return {
      status: GATEWAY_RESPONSES.STATUS_OK,
      service: container.serviceName,
      version: GATEWAY_RESPONSES.VERSION_V1
    };
  });

  return app;
};
