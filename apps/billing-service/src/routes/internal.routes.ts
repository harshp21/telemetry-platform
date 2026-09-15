import type { FastifyInstance } from "fastify";
import type { InternalController } from "../controllers/internal.controller";
import { BILLING_ROUTES } from "../constants";

/**
 * Registers the internal metering routes.
 *
 * `scope` is the encapsulated `app.register` context that carries the internal-auth
 * `preHandler`, not the root instance. Registering these routes on the root instead would put
 * an unauthenticated invoice generator on the network -- the scoping is the security contract,
 * and `internal-billing.route.test.ts` BU61 is what notices if it moves.
 */
export const registerInternalBillingRoutes = (
  scope: FastifyInstance,
  controller: InternalController
): void => {
  scope.post(BILLING_ROUTES.INTERNAL_BILLING_GENERATE, async (request, reply) => {
    return controller.generate(request, reply);
  });
};
