import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { env, type ServiceEnv } from "./config/env";
import { createContainer, type AppContainer } from "./config/container";
import { BILLING_RESPONSES, BILLING_ROUTES, BILLING_SERVICE_NAME } from "./constants";
import { InternalApiSecretMissingError } from "./errors";
import { buildInternalAuthMiddleware } from "./middleware/internal-auth.middleware";
import { registerInternalBillingRoutes } from "./routes/internal.routes";

interface BuildBillingServiceAppOptions {
  internalApiSecret?: string;
}

export const buildBillingServiceApp = (
  options: BuildBillingServiceAppOptions = {}
): FastifyInstance & { container: AppContainer } => {
  const app = Fastify({ logger: true });
  const container = createContainer(BILLING_SERVICE_NAME, env as ServiceEnv);
  app.decorate("container", container);
  // The validated value, not `process.env` (T-044). The schema parses at module load, so a
  // missing, short or all-whitespace secret has already thrown before this function can run.
  // The `options` arm is deliberately kept and deliberately unvalidated: `tests/smoke.test.ts`
  // passes an 11-character secret, and it is the one remaining path by which a secret shorter
  // than `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` can reach the middleware. It is not
  // operator-reachable -- `src/index.ts` calls `buildBillingServiceApp()` with no arguments.
  const internalApiSecret = options.internalApiSecret ?? env.INTERNAL_API_SECRET;

  registerGlobalErrorHandler(app);

  // Add cleanup hook for Redis connection
  app.addHook("onClose", async () => {
    if (container.redis.status === "ready" || container.redis.status === "connecting") {
      await container.redis.quit();
    }
  });

  // Reachable through the `options` arm above. The env arm cannot produce a blank value now
  // that the schema trims before measuring, but this is not claimed to be dead code: `??` does
  // not fall back for `""`, so an explicit empty or whitespace option lands here. Pinned by
  // `tests/env.schema.unit.test.ts` ("rejects a blank internalApiSecret option").
  if (!internalApiSecret.trim()) {
    throw new InternalApiSecretMissingError();
  }

  app.get(BILLING_ROUTES.HEALTH, async () => {
    container.logger.info("Health check called");
    return {
      status: BILLING_RESPONSES.STATUS_OK,
      service: container.serviceName
    };
  });

  app.register(async (internalRoutes) => {
    const internalAuth = buildInternalAuthMiddleware(internalApiSecret);

    internalRoutes.addHook("preHandler", internalAuth);

    // Registered inside this `app.register` callback, so the guard above covers it. Moving
    // the call outside the callback is what would put an unauthenticated invoice generator on
    // the network; `tests/internal-billing.route.test.ts` BU61 goes red when it does.
    registerInternalBillingRoutes(internalRoutes, container.internalController);
  });

  return app as unknown as FastifyInstance & { container: AppContainer };
};
