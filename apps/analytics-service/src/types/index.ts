import type { TenantId } from "@telemetry/shared-types";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The tenant the request is bound to, set by `analyticsTenantContextHandler`.
     *
     * **Optional, and branded** -- the same two divergences from
     * `apps/usage-service/src/types/index.ts` that billing-service made at T-046, for the same
     * reasons.
     *
     * Optional because analytics-service's hooks are scoped rather than global: `/health` sits
     * outside the `app.register` block that carries them, so for those requests the property
     * genuinely is absent. Declaring it non-optional would make a future controller's
     * `if (!tenantId)` guard look decorative when it is the only thing between an unscoped
     * request and a repository constructed with `undefined`.
     *
     * Branded because `TenantId` is a branded string in `@telemetry/shared-types`: assigning an
     * unbranded `string` to a `(tenantId: TenantId) => ...` factory is a compile error. That is
     * a checked constraint rather than an unrepresentable state -- `as TenantId` still compiles
     * -- which is why the middleware is the one place that performs the cast, and it performs it
     * through `tenantIdSchema` after a successful UUID parse.
     *
     * No repository consumes this yet: analytics has **zero** subclasses of
     * `TenantScopedRepository` (S-19 -- its one `grep` hit is the docstring example in
     * `src/repositories/base.repository.ts`). T-051 creates the first, and inherits S-19's
     * missing `TimeZone` pin there.
     */
    tenantId?: TenantId;
  }
}

export {};
