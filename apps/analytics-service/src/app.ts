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
import { registerAnalyticsRoutes } from "./routes/analytics.routes";
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

  // The tenant-facing scope. **T-051 put the first route inside it, which is what discharges
  // S-9** -- until then it carried both hooks and no routes, and a scope with no routes never
  // runs its hooks, so the protection was not weak, it was absent. That was measured at S-9 in
  // three forms (an unmatched `GET` and an unmatched `POST` under an unprefixed scope, and a
  // `GET` under a scope registered with `{ prefix: "/v1/analytics" }`), each answering `404`
  // with the hook's own call log still empty, and adding one route inside made the hook run for
  // that route and still not for a sibling 404.
  //
  // The standing hazard is now the placement of the *next* route rather than the absence of
  // this one. Re-measured at T-051 against this real factory, one probe route per placement,
  // injected with no headers at all: a sibling unprefixed scope, a sibling scope registered
  // with the `/v1/analytics` prefix, and the root instance **all answered `200`** -- the same
  // status an authorised caller gets from the correct placement. So a route registered outside
  // this callback is an unauthenticated, untenanted tenant-scoped endpoint on the network, and
  // it looks healthy. Add new routes inside this callback, and give each one a case that
  // asserts the service method was never called (`AM20`), not one that asserts a status code.
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
  // orders share, and `AU22b` pins these two registrations by their text. `AU22b`'s source-text
  // form was chosen when the scope held no routes and nothing behavioural could observe these
  // registrations; since T-051 something can -- `AM23` in `tests/metrics.route.test.ts` observes
  // the order through the real route, by the code a doubly-invalid request receives. Both are
  // kept: `AM23` is the behavioural guard and `AU22b` still catches a reordering that happens to
  // leave the observable codes unchanged.
  //
  // The secret is the parsed value, not `process.env`: the schema parses at module load, so a
  // missing, short, all-whitespace or non-ASCII secret has already thrown before this function
  // can run. There is no unvalidated `options` override (plan decision D3), so no path here can
  // deliver a blank secret to the guard and analytics has no blank-secret guard to reach.
  app.register(async (analyticsApi) => {
    analyticsApi.addHook("onRequest", buildInternalAuthMiddleware(env.INTERNAL_API_SECRET));
    analyticsApi.addHook("onRequest", analyticsTenantContextHandler);

    // **T-051, and the line S-9 was left open for.** Registered inside this callback, so both
    // hooks above cover it. Moving this call outside the callback does not produce a `404`
    // somebody notices: measured against this real factory at fastify 5.10.0 / Node v22.22.2,
    // a sibling scope, a prefixed sibling scope and the root instance all answer `200` to a
    // caller with **no credentials at all** -- so the wrong placement is a working endpoint, not
    // a `404` anybody notices. `AM20` in `tests/metrics.route.test.ts` is what goes red.
    //
    // One thing measured at T-051 that the probe above does not show, because the probe used a
    // bare handler rather than this controller: with `registerAnalyticsRoutes` moved to the root
    // instance, an uncredentialed request to the **real** route answers
    // `500 {"code":"INTERNAL_ERROR"}` and the service is called 0 times. `AnalyticsController`
    // refuses on the absent `request.tenantId`, which no hook set. That is a second layer and
    // it is why no data escapes today; it is not a reason to relax this one.
    registerAnalyticsRoutes(analyticsApi, container.analyticsController);
  });

  return app as unknown as FastifyInstance & { container: AppContainer };
};
