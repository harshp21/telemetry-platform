import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { createContainer } from "./config/container";
import {
  GATEWAY_RESPONSES,
  GATEWAY_ROUTES,
  GATEWAY_SERVICE_NAME
} from "./constants";
import { gatewayJwtAuthPreHandler } from "./middleware/auth.middleware";
import { registerGatewayProxyRoutes } from "./plugins/proxy.plugin";

const getRequiredEnv = (key: string): string => {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing required gateway environment variable: ${key}`);
  }

  return value;
};

export const buildGatewayApp = (): FastifyInstance => {
  const app = Fastify({ logger: true });
  const container = createContainer(GATEWAY_SERVICE_NAME);

  registerGlobalErrorHandler(app);
  app.addHook("preHandler", gatewayJwtAuthPreHandler);

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

  registerGatewayProxyRoutes(app, {
    authServiceUrl: getRequiredEnv("AUTH_SERVICE_URL"),
    usageServiceUrl: getRequiredEnv("USAGE_SERVICE_URL"),
    billingServiceUrl: getRequiredEnv("BILLING_SERVICE_URL"),
    analyticsServiceUrl: getRequiredEnv("ANALYTICS_SERVICE_URL")
  });

  return app;
};
