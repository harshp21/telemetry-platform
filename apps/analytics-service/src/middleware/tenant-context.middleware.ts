import type { FastifyReply, FastifyRequest } from "fastify";
import { tenantIdSchema } from "@telemetry/shared-validation";
import { ANALYTICS_HEADERS } from "../constants";
import { TenantContextInvalidError, TenantContextMissingError } from "../errors";

/**
 * `onRequest` hook that reads `X-Tenant-Id`, validates it as a UUID and binds it to the request
 * (S-9, layer 3 of `.claude/rules/tenant-isolation.md`). Mirrors
 * `apps/billing-service/src/middleware/tenant-context.middleware.ts`.
 *
 * **`onRequest` is a choice with one forced consequence.** The phase itself is not dictated: it
 * mirrors billing's and usage-service's hooks. What *is* forced, **given this hook is
 * `onRequest`**, is that `buildInternalAuthMiddleware` must be `onRequest` too in the same scope
 * and must be registered ahead of it -- at fastify 5.10.0 an `onRequest` hook runs before a
 * `preHandler` one whatever order they are registered in (measured at Gate 3, run order
 * `["tenant","auth"]` in both registration orders), so a `preHandler` guard would derive tenant
 * context before the caller had proved it is the gateway.
 *
 * **No public-route allowlist.** usage-service needs one because its hooks are global. This hook
 * is added inside an encapsulated `app.register` scope, so `/health` is structurally outside it
 * -- there is no list to forget to update. `AU23` is the case that notices if that stops being
 * true.
 *
 * The header must be a UUID, not merely non-empty: `Tenant.id` is `String @default(uuid())`, and
 * a tenant id containing `:` would make a `<prefix>:<tenantId>:<key>` derivation ambiguous
 * elsewhere on the platform.
 *
 * Validated, never normalised -- `tenantIdSchema` is `uuidSchema.transform(v => v as TenantId)`,
 * a type-level cast with no runtime effect, so what reaches `request.tenantId` is byte-identical
 * to what the gateway sent (`AU17`, and `AU17b` with an upper-case fixture).
 *
 * **A duplicated header is rejected as *invalid*, not as *missing*.** Measured at fastify 5.10.0:
 * `app.inject` joins an array value into `"<A>,<B>"` and Node's parser joins repeated header
 * lines into `"<A>, <B>"`. Both are `typeof === "string"`, so the `typeof header !== "string"`
 * arm below is reached by an *absent* header rather than by a duplicated one; the joined value is
 * refused by `tenantIdSchema` because it is not a UUID. Either way no value is preferred over the
 * other, which is the property that matters (`AU21`). Scope: this header, these forms, this
 * fastify and Node version.
 *
 * **No repository consumes `request.tenantId` yet.** analytics has zero subclasses of
 * `TenantScopedRepository`; T-051 creates the first, and inherits S-19's missing `TimeZone` pin
 * on this service's `base.repository.ts` when it does.
 *
 * @throws TenantContextMissingError - header absent or blank
 * @throws TenantContextInvalidError - header present but not a UUID, which includes the
 *   comma-joined value a duplicated header arrives as
 */
export const analyticsTenantContextHandler = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  const header = request.headers[ANALYTICS_HEADERS.TENANT_ID];

  if (typeof header !== "string" || header.trim() === "") {
    throw new TenantContextMissingError();
  }

  const parsed = tenantIdSchema.safeParse(header);
  if (!parsed.success) {
    throw new TenantContextInvalidError();
  }

  request.tenantId = parsed.data;
};
