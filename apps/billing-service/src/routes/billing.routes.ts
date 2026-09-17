import type { FastifyInstance } from "fastify";
import type { BillingController } from "../controllers/billing.controller";
import { BILLING_ROUTES } from "../constants";

/**
 * Registers the tenant-facing billing routes.
 *
 * `scope` is the encapsulated `app.register` context carrying the internal-auth and
 * tenant-context `onRequest` hooks, not the root instance. Registering these on the root
 * instead would put both reads on the network with neither guard -- the scoping *is* the
 * security contract here, exactly as it is in `internal.routes.ts`.
 *
 * **What that exposure is, measured rather than feared.** This sentence previously said the
 * unscoped form would be "an unauthenticated, untenanted read of every invoice on the
 * network". It would not, and the overclaim is T-046's rather than T-047's -- `git show
 * HEAD:apps/billing-service/src/routes/billing.routes.ts` carries it verbatim. Both handlers
 * guard on `request.tenantId` before calling the service (`billing.controller.ts`, the
 * `if (!tenantId)` block in each). Measured at the Gate 3 rework by re-registering the detail
 * route as `app.get(...)` on the root instance and injecting a request carrying **no**
 * headers, with `invoiceService.getInvoice` stubbed to return an invoice: the response was
 * `400 {"code":"VALIDATION_ERROR","message":"Missing tenantId from context"}` and the stub was
 * never called. The exposure is unauthenticated *reachability*, not an invoice on the wire.
 *
 * **What notices if the scoping moves.** For the collection route,
 * `billing-invoices.route.test.ts` BU78. For the detail route T-047 added,
 * `billing-invoice-detail.route.test.ts` **BU115**, with BU116, BU117 and BU119. Measured at
 * the Gate 3 rework under the same re-registration, `--reporter=verbose`: that file gives
 * `Tests 4 failed | 2 passed (6)` -- BU115, BU116, BU117, BU119 red, BU118 and BU120 green --
 * and the package gives `Tests 9 failed | 198 passed (207)` across 2 files, adding BI28, BI29,
 * BI30, BI31 and BI33.
 *
 * **`BU120` is not one of them.** An earlier revision of this docblock cited it as a detail-route
 * guard; it stays **green** under exactly the mutation above, because it observes one app's hook
 * topology rather than this route's registration site. Its own comment
 * (`billing-invoice-detail.route.test.ts`) says not to cite it here.
 */
export const registerBillingRoutes = (
  scope: FastifyInstance,
  controller: BillingController
): void => {
  scope.get(BILLING_ROUTES.INVOICES, async (request, reply) => {
    return controller.listInvoices(request, reply);
  });

  // `BILLING_ROUTES.INVOICE_DETAIL` derives both the collection path and the `:id` param name
  // from single constants, so the spelling Fastify binds and the key
  // `invoiceDetailParamsSchema` parses cannot drift apart.
  scope.get(BILLING_ROUTES.INVOICE_DETAIL, async (request, reply) => {
    return controller.getInvoice(request, reply);
  });
};
