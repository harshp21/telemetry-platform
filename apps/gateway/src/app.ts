import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import "./config/fastify";
import { createContainer } from "./config/container";
import { loadEnv, type ServiceEnv } from "./config/env";
import {
  GATEWAY_RESPONSES,
  GATEWAY_ROUTES,
  GATEWAY_SERVICE_NAME
} from "./constants";
import { gatewayJwtAuthPreHandler } from "./middleware/auth.middleware";
import { registerGatewayProxyRoutes } from "./plugins/proxy.plugin";
import { registerGatewayRateLimit } from "./plugins/rate-limit.plugin";

export const buildGatewayApp = (): FastifyInstance => {
  const app = Fastify({ logger: true });
  const config = loadEnv();
  const container = createContainer(GATEWAY_SERVICE_NAME, config as ServiceEnv);
  app.decorate("container", container);

  registerGlobalErrorHandler(app);

  // Add cleanup hook for Redis connection
  app.addHook("onClose", async () => {
    if (container.redis.status === "ready" || container.redis.status === "connecting") {
      await container.redis.quit();
    }
  });
  app.addHook("onRequest", gatewayJwtAuthPreHandler);
  registerGatewayRateLimit(app, {
    redisUrl: config.REDIS_URL,
    nodeEnv: config.NODE_ENV,
    rateLimitMax: config.RATE_LIMIT_MAX,
    rateLimitWindowMs: config.RATE_LIMIT_WINDOW_MS,
    ingestionRateLimitMax: config.INGESTION_RATE_LIMIT_MAX
  });

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
    authServiceUrl: config.AUTH_SERVICE_URL,
    usageServiceUrl: config.USAGE_SERVICE_URL,
    billingServiceUrl: config.BILLING_SERVICE_URL,
    analyticsServiceUrl: config.ANALYTICS_SERVICE_URL
  });

  return app;
};
