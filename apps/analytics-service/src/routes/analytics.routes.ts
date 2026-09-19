import type { FastifyInstance } from "fastify";
import type { AnalyticsController } from "../controllers/analytics.controller";
import { ANALYTICS_ROUTES } from "../constants";

/**
 * Registers the tenant-facing analytics routes.
 *
 * **This must be called with the encapsulated instance from the `app.register` callback in
 * `src/app.ts`, never with the root app.** That scope is what carries the internal-auth guard
 * and the tenant-context hook, and until T-051 it held no routes at all -- which was S-9, now
 * retired; the record is `docs/plans/t-051-analytics-metrics-rollup.md`.
 *
 * Measured at fastify 5.10.0 / Node v22.22.2 against the real app factory, **one probe route per
 * placement**: a sibling scope, a prefixed sibling scope and the root instance are all reachable
 * with neither hook running, and a bare probe handler there answers **`200` to a caller with no
 * credentials, and runs**. So the wrong placement is not a `404` anybody notices.
 *
 * **What the *real* route does in those placements is different, and the difference is the
 * controller rather than the placement.** With this function called on an unguarded instance, an
 * uncredentialed request carrying a valid querystring answers `500 {"code":"INTERNAL_ERROR"}`
 * with the service called **0** times, because `AnalyticsController` refuses on the
 * `request.tenantId` no hook set; with **no** querystring it answers `400 VALIDATION_ERROR`,
 * naming the required parameters to that unauthenticated caller. So do not read
 * "misplaced => 500" as unconditional, and do not compress this to "the consequence is the
 * same": *a misplaced route is reachable and unauthenticated either way, and whether anything
 * runs depends on whether the handler has its own tenant guard.* What is identical is the first
 * layer -- neither hook runs, at any of the three placements.
 *
 * **Both layers are load-bearing and each has its own case.** `AM20` in
 * `tests/metrics.route.test.ts` goes red when this registration moves out (on its status
 * assertion, `expected 500 to be 401` -- not on `not.toHaveBeenCalled()`, which passes there
 * because the controller already stopped it). `AM22c` guards the controller layer, and it is not
 * decorative: deleting that tenant guard and re-running the same unguarded composition was
 * measured to give `200`, `serviceCalled=1`, `tenantArg=undefined` and the service's payload in
 * the response body. Do not remove either on the evidence that the other held.
 *
 * @param app - the **scoped** Fastify instance carrying the guard hooks
 * @param controller - AnalyticsController instance
 */
export const registerAnalyticsRoutes = (
  app: FastifyInstance,
  controller: AnalyticsController
): void => {
  app.get(ANALYTICS_ROUTES.METRICS, async (request, reply) => {
    return controller.handle(request, reply);
  });
};
