import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { env, type ServiceEnv } from "./config/env";
import "./config/fastify";
import { createContainer } from "./config/container";
import {
  BILLING_RESPONSES,
  BILLING_ROUTES,
  BILLING_SERVICE_NAME
} from "./constants";
import { InternalApiSecretMissingError } from "./errors";
import { buildInternalAuthMiddleware } from "./middleware/internal-auth.middleware";

interface BuildBillingServiceAppOptions {
  internalApiSecret?: string;
}

export const buildBillingServiceApp = (
  options: BuildBillingServiceAppOptions = {}
): FastifyInstance => {
  const app = Fastify({ logger: true });
  const container = createContainer(BILLING_SERVICE_NAME, env as ServiceEnv);
  app.decorate("container", container);
  const internalApiSecret = options.internalApiSecret ?? process.env.INTERNAL_API_SECRET ?? "";

  registerGlobalErrorHandler(app);

  if (!internalApiSecret.trim()) {
    throw new InternalApiSecretMissingError();
  }

  app.get(BILLING_ROUTES.HEALTH, async () => {
    app.container.logger.info("Health check called");
    return {
      status: BILLING_RESPONSES.STATUS_OK,
      service: container.serviceName
    };
  });

  app.register(async (internalRoutes) => {
    const internalAuth = buildInternalAuthMiddleware(internalApiSecret);

    internalRoutes.addHook("preHandler", internalAuth);

    internalRoutes.post(BILLING_ROUTES.INTERNAL_BILLING_GENERATE, async () => {
      return {
        status: BILLING_RESPONSES.STATUS_ACCEPTED,
        workflow: BILLING_RESPONSES.WORKFLOW_BILLING_GENERATION
      };
    });
  });

  return app;
};
