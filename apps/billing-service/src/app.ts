import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { env, type ServiceEnv } from "./config/env";
import { createContainer, type AppContainer } from "./config/container";
import { BILLING_RESPONSES, BILLING_ROUTES, BILLING_SERVICE_NAME } from "./constants";
import { InternalApiSecretMissingError } from "./errors";
import { buildInternalAuthMiddleware } from "./middleware/internal-auth.middleware";
import { billingTenantContextHandler } from "./middleware/tenant-context.middleware";
import { registerInternalBillingRoutes } from "./routes/internal.routes";
import { registerBillingRoutes } from "./routes/billing.routes";
// Side-effect import: brings the `FastifyRequest.tenantId` augmentation into the program so
// the controller's read of it type-checks. Types only -- nothing is emitted.
import "./types";

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

    // `onRequest`, not `preHandler` (S-8). `preHandler` runs *after* fastify's content-type
    // parser, so an unauthenticated caller's body was parsed before it was rejected -- and the
    // parser's failure was observable. Measured against this real route with no credential:
    // malformed JSON answered `500 INTERNAL_ERROR` carrying "Body is not valid JSON but
    // content-type is set to 'application/json'", and a body with no content-type answered `500
    // INTERNAL_ERROR` "Unsupported Media Type", while a valid body, a well-formed but
    // schema-invalid one, a `text/plain` body and no body at all all answered `401`. (No
    // `FST_ERR_VALIDATION` row: this route validates in the controller, not through a fastify
    // route schema.) Three distinguishable states for a caller holding no secret -- an earlier
    // revision of this comment said two and omitted the no-content-type row, corrected at the
    // Gate-5 rework (QA F-1) by re-performing the revert here and in worker-service in one run,
    // where the same six shapes answered identically on both. At `onRequest` they collapse to one.
    // `tests/internal-billing.route.test.ts` BU71 is the case that reddens if this moves back.
    //
    // This scope registers **no** tenant-context hook -- it holds this guard and
    // `registerInternalBillingRoutes` only, which is T-045's contract that internal routes derive
    // no tenant context -- so the promotion cannot disturb the hook ordering
    // `.claude/rules/tenant-isolation.md` § *Forbidden* is about. The tenant-facing scope below
    // was already `onRequest` on both hooks and is not re-ordered here; BU79 re-asserts it.
    internalRoutes.addHook("onRequest", internalAuth);

    // Registered inside this `app.register` callback, so the guard above covers it. Moving
    // the call outside the callback is what would put an unauthenticated invoice generator on
    // the network; `tests/internal-billing.route.test.ts` BU61 goes red when it does.
    registerInternalBillingRoutes(internalRoutes, container.internalController);
  });

  // The tenant-facing scope (T-046). Separate from the internal one on purpose: these routes
  // need tenant context and the internal ones must not derive any.
  //
  // **Both hooks are `onRequest`, and that is forced given that the tenant-context hook is
  // `onRequest`** -- which it is because it mirrors usage-service's. It is not the unique
  // correct pairing, and an earlier revision of this comment said "forced rather than
  // stylistic" without the condition (review LOW-1). What is actually forced is the
  // conditional the middleware docblock at `middleware/tenant-context.middleware.ts` states:
  // at fastify 5.10.0 an `onRequest` hook runs before a `preHandler` one *whatever order they
  // are registered in*, so leaving the guard as a `preHandler` here -- the phase the internal
  // scope above still uses -- would derive tenant context *before* the caller proved it is the
  // gateway, in both registration orders. `.claude/rules/tenant-isolation.md` § *Forbidden*
  // names that ordering specifically, and registration order does not fix it.
  //
  // Measured at the Gate 4 review across seven configurations: the forbidden `["tenant","auth"]`
  // order occurs in *both* registration orders whenever the phases are crossed that way, while
  // both-`preHandler` (auth first) and auth-`onRequest`/tenant-`preHandler` also order
  // correctly. So the choice among the three correct pairings is stylistic; only crossing the
  // phases the wrong way is an error.
  //
  // `buildInternalAuthMiddleware` is the same factory the internal scope registers, and since
  // S-8 both registrations are `onRequest`. The observation that made this comment read as it
  // did still holds and was re-measured: an un-`return`ed `reply.status().send()` inside an
  // `onRequest` hook short-circuits later hooks identically to the returned and thrown forms. So
  // the `return` S-8 added to that file is a statement of intent, not a behaviour change -- and
  // the phase promotion in the internal scope above was not about the short-circuit at all, but
  // about the body being parsed before the guard ran.
  //
  // There is no public-route allowlist because there is nothing to exempt: `/health` and the
  // internal scope are structurally outside this callback. BU83 is the case that notices if
  // that stops being true.
  app.register(async (billingApi) => {
    billingApi.addHook("onRequest", buildInternalAuthMiddleware(internalApiSecret));
    billingApi.addHook("onRequest", billingTenantContextHandler);

    registerBillingRoutes(billingApi, container.billingController);
  });

  return app as unknown as FastifyInstance & { container: AppContainer };
};
