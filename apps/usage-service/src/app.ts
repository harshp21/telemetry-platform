import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { UsageEventsBatchSchema } from "@telemetry/shared-validation";
import { env, type ServiceEnv } from "./config/env";
import { createContainer, type AppContainer } from "./config/container";
import { TenantMismatchError } from "./errors";
import {
  USAGE_SERVICE_HEADERS,
  USAGE_SERVICE_NAME,
  USAGE_SERVICE_RESPONSES,
  USAGE_SERVICE_ROUTES
} from "./constants";

const normalizeHeader = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
};

export const buildUsageServiceApp = (): FastifyInstance & { container: AppContainer } => {
  const app = Fastify({ logger: true });
  const container = createContainer(USAGE_SERVICE_NAME, env as ServiceEnv);
  app.decorate("container", container);

  registerGlobalErrorHandler(app);

  // Add cleanup hook for Redis connection
  app.addHook("onClose", async () => {
    if (container.redis.status === "ready" || container.redis.status === "connecting") {
      await container.redis.quit();
    }
  });

  app.get(USAGE_SERVICE_ROUTES.HEALTH, async () => {
    container.logger.info("Health check called");
    return {
      status: USAGE_SERVICE_RESPONSES.STATUS_OK,
      service: container.serviceName
    };
  });

  app.post(USAGE_SERVICE_ROUTES.USAGE_EVENTS, async (request, reply) => {
    const parsed = UsageEventsBatchSchema.parse(request.body);

    const tenantHeader = normalizeHeader(request.headers[USAGE_SERVICE_HEADERS.TENANT_ID]);

    if (tenantHeader && parsed.events.some((event) => event.tenantId !== tenantHeader)) {
      throw new TenantMismatchError();
    }

    return reply.status(202).send({
      status: USAGE_SERVICE_RESPONSES.STATUS_ACCEPTED,
      acceptedCount: parsed.events.length,
      version: USAGE_SERVICE_RESPONSES.VERSION_V1
    });
  });

  return app as unknown as FastifyInstance & { container: AppContainer };
};
