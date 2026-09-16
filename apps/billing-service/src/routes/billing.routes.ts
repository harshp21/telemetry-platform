import type { FastifyInstance } from "fastify";
import type { BillingController } from "../controllers/billing.controller";
import { BILLING_ROUTES } from "../constants";

/**
 * Registers the tenant-facing billing routes.
 *
 * `scope` is the encapsulated `app.register` context carrying the internal-auth and
 * tenant-context `onRequest` hooks, not the root instance. Registering these on the root
 * instead would put an unauthenticated, untenanted read of every invoice on the network --
 * the scoping *is* the security contract here, exactly as it is in `internal.routes.ts`, and
 * `billing-invoices.route.test.ts` BU78 is what notices if it moves.
 */
export const registerBillingRoutes = (
  scope: FastifyInstance,
  controller: BillingController
): void => {
  scope.get(BILLING_ROUTES.INVOICES, async (request, reply) => {
    return controller.listInvoices(request, reply);
  });
};
