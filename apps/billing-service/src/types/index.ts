import type { TenantId } from "@telemetry/shared-types";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The tenant the request is bound to, set by `billingTenantContextHandler`.
     *
     * **Optional, and branded** -- two deliberate divergences from
     * `apps/usage-service/src/types/index.ts`, which declares `tenantId: string`.
     *
     * Optional because billing-service's hooks are scoped rather than global: `/health` and
     * `POST /v1/internal/billing/generate` sit outside the `app.register` block that carries
     * the hook, so for those requests the property genuinely is absent. Declaring it
     * non-optional would make the controller's `if (!tenantId)` guard look decorative when it
     * is the only thing standing between an unscoped request and a repository constructed with
     * `undefined`.
     *
     * Branded because billing's repository factories are `(tenantId: TenantId) => …`
     * (`services/billing.service.ts`), where usage-service's take a plain `string`. Assigning
     * an unbranded `string` to one is a compile error -- confirmed by making the edit: passing
     * `request.headers[...] as string` to `invoiceRepositoryFactory` reports
     * `TS2345: Argument of type 'string' is not assignable to parameter of type 'TenantId'`.
     * That is a checked constraint, not an unrepresentable state: `as TenantId` still compiles,
     * which is why the middleware is the one place that performs the cast, and it performs it
     * through `tenantIdSchema` after a successful UUID parse.
     */
    tenantId?: TenantId;
  }
}

export {};
