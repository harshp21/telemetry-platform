import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { env, type ServiceEnv } from "./config/env";
import { createContainer, type AppContainer } from "./config/container";
import {
  ANALYTICS_RESPONSES,
  ANALYTICS_ROUTES,
  ANALYTICS_SERVICE_NAME
} from "./constants";
import { buildInternalAuthMiddleware } from "./middleware/internal-auth.middleware";
import { analyticsTenantContextHandler } from "./middleware/tenant-context.middleware";
// Side-effect import: brings the `FastifyRequest.tenantId` augmentation into the program so that
// T-051's controller read of it type-checks. Types only -- nothing is emitted.
import "./types";

export const buildAnalyticsServiceApp = (): FastifyInstance & { container: AppContainer } => {
  const app = Fastify({ logger: true });
  const container = createContainer(ANALYTICS_SERVICE_NAME, env as ServiceEnv);
  app.decorate("container", container);

  registerGlobalErrorHandler(app);

  // Add cleanup hook for Redis connection
  app.addHook("onClose", async () => {
    if (container.redis.status === "ready" || container.redis.status === "connecting") {
      await container.redis.quit();
    }
  });

  // Registered on the **root instance**, deliberately outside the guarded scope below, which is
  // what makes the exemption structural rather than an allowlist entry someone has to remember
  // (billing's T-046 shape; usage-service's `public-routes.ts` is the other shape and was not
  // copied). `AU23` is the case that notices if it moves: with this registration inside the
  // scope, `/health` answers `401 {"code":"UNAUTHORIZED"}`.
  app.get(ANALYTICS_ROUTES.HEALTH, async () => {
    container.logger.info("Health check called");
    return {
      status: ANALYTICS_RESPONSES.STATUS_OK,
      service: container.serviceName
    };
  });

  // The tenant-facing scope (S-9). **It holds no routes yet, and is therefore inert** -- stated
  // as a measurement, not as a caveat: at fastify 5.10.0 / Node v22.22.2 a scope carrying hooks
  // and no routes never runs them. Probed at Gate 3 in three forms -- an unmatched `GET` and an
  // unmatched `POST` under an unprefixed scope, and a `GET` under a scope registered with
  // `{ prefix: "/v1/analytics" }` -- each answering `404` with the hook's own call log still
  // empty; adding one route inside made the hook run for that route and still not for a sibling
  // 404. So this is not weak protection, it is none, and it is here so that T-051 adds
  // `registerAnalyticsRoutes(analyticsApi, ...)` *inside* this callback rather than having to
  // compose the security wiring and the route in one task. Registering a route outside it is what
  // would put an unauthenticated tenant-scoped endpoint on the network.
  //
  // **Both hooks are `onRequest`, and that is forced given the tenant hook is.** At fastify
  // 5.10.0 an `onRequest` hook runs before a `preHandler` one whatever order they are registered
  // in -- measured at Gate 3, `["tenant","auth"]` in both registration orders when the phases are
  // crossed -- so a `preHandler` guard here would derive tenant context before the caller proved
  // it is the gateway, which `.claude/rules/tenant-isolation.md` § *Forbidden* names. It is not
  // the only correct pairing: both hooks at `preHandler` with the guard first also ordered
  // correctly in the same probe. What is forced is the conditional, not the phase.
  //
  // `AU22` pins the resulting order by the *code* each hook returns rather than by a status both
  // orders share, and `AU22b` pins these two registrations by their text -- because while the
  // scope holds no routes, nothing behavioural can observe them.
  //
  // The secret is the parsed value, not `process.env`: the schema parses at module load, so a
  // missing, short, all-whitespace or non-ASCII secret has already thrown before this function
  // can run. There is no unvalidated `options` override (plan decision D3), so no path here can
  // deliver a blank secret to the guard and analytics has no blank-secret guard to reach.
  app.register(async (analyticsApi) => {
    analyticsApi.addHook("onRequest", buildInternalAuthMiddleware(env.INTERNAL_API_SECRET));
    analyticsApi.addHook("onRequest", analyticsTenantContextHandler);
  });

  return app as unknown as FastifyInstance & { container: AppContainer };
};
