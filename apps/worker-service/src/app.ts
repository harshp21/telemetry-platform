import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { env, type ServiceEnv } from "./config/env";
import { createContainer, type AppContainer } from "./config/container";
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
): FastifyInstance & { container: AppContainer } => {
  const app = Fastify({ logger: true });
  const container = createContainer(WORKER_SERVICE_NAME, env as ServiceEnv);
  app.decorate("container", container);
  // Read the validated value, not `process.env`: `EnvSchema` is what enforces
  // `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH`, and a declaration `app.ts` bypasses would be
  // config nothing reads. The explicit option still wins -- `tests/smoke.test.ts` builds the app
  // with its own short secret, and that override is deliberately not length-checked.
  const internalApiSecret = options.internalApiSecret ?? env.INTERNAL_API_SECRET;

  registerGlobalErrorHandler(app);

  // Add cleanup hook for Redis connection
  app.addHook("onClose", async () => {
    if (container.redis.status === "ready" || container.redis.status === "connecting") {
      await container.redis.quit();
    }
  });

  // The `env.INTERNAL_API_SECRET` path cannot produce a blank value: `EnvSchema` trims before
  // measuring, so a whitespace-only secret is a parse failure at module load
  // (`tests/env.schema.unit.test.ts`, "rejects an all-whitespace INTERNAL_API_SECRET"). What
  // reaches here blank is an explicitly-passed option -- `??` does not fall back for `""` --
  // which is what "rejects a blank internalApiSecret option" in that same file covers. Before
  // the trim was added, a 32-space `INTERNAL_API_SECRET` parsed cleanly and arrived here empty.
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

  return app as unknown as FastifyInstance & { container: AppContainer };
};
