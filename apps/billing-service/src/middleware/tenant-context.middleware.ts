import type { FastifyReply, FastifyRequest } from "fastify";
import { tenantIdSchema } from "@telemetry/shared-validation";
import { BILLING_HEADERS } from "../constants";
import { TenantContextInvalidError, TenantContextMissingError } from "../errors";

/**
 * `onRequest` hook that reads `X-Tenant-Id`, validates it as a UUID and binds it to the
 * request. Mirrors `apps/usage-service/src/middleware/tenant-context.middleware.ts`.
 *
 * **`onRequest`, not `preHandler` -- a choice, with one forced consequence.** The phase itself
 * is not dictated: it mirrors usage-service's hook, and `app.ts` records that both-`preHandler`
 * (guard first) and guard-`onRequest`/tenant-`preHandler` also order correctly, so three of the
 * pairings are sound. What *is* forced, **given this hook is `onRequest`**, is that billing's
 * internal-auth guard must be `onRequest` too in this scope, and must be registered ahead of
 * this hook -- `preHandler` is the phase billing's *internal* route scope still uses
 * (`app.ts:61`), and the guard is the same function in both. At fastify 5.10.0 an `onRequest`
 * hook runs before a `preHandler` one *whatever order they are registered in* -- measured in
 * both registration orders, run order `["tenant","auth"]` both times, and re-derived
 * independently at the Gate 6 review. Leaving the guard as a `preHandler` would therefore
 * derive tenant context before the caller had proved it is the gateway, which
 * `.claude/rules/tenant-isolation.md` § *Forbidden* names explicitly. So `app.ts` registers
 * the guard as `onRequest` too, ahead of this one, and `BU79` asserts the resulting order by
 * the *code* each hook returns rather than by a status both orders share.
 *
 * An earlier revision of this headline said the phase was "forced rather than chosen", which
 * `app.ts` -- rewritten in the same change for the first round's LOW-1 -- contradicted. Both
 * texts now state the condition rather than the universal (review LOW-1, second round).
 *
 * **No public-route allowlist.** usage-service needs one because its hooks are global. This
 * hook is added inside an encapsulated `app.register` scope, so `/health` and the internal
 * metering route are structurally outside it -- there is no list to forget to update. `BU83`
 * is the case that notices if that stops being true.
 *
 * The header must be a UUID, not merely non-empty: `Tenant.id` is `String @default(uuid())`,
 * and a tenant id containing `:` would make a `<prefix>:<tenantId>:<key>` derivation
 * ambiguous elsewhere on the platform.
 *
 * Validated, never normalised -- `tenantIdSchema` is `uuidSchema.transform(v => v as TenantId)`,
 * a type-level cast with no runtime effect, so what reaches `request.tenantId` is
 * byte-identical to what the gateway sent (`BU77`).
 *
 * **A duplicated header is rejected as *invalid*, not as *missing*.** Re-measured at the Gate 3
 * rework (fastify 5.10.0 / Node 22.22.2), four forms: `app.inject` with an array value and with
 * a pre-joined string both yield `"<a>,<b>"`, and two and three real `X-Tenant-Id` header lines
 * over a socket yield `"<a>, <b>"` and `"<a>, <b>, <a>"`. Every one is `typeof === "string"`,
 * never an array. So the `typeof header !== "string"` arm below is reached by an *absent*
 * header, not by a duplicated one; the joined value is refused by `tenantIdSchema` because it
 * is not a UUID. Either way no value is preferred over the other, which is the property that
 * matters -- `BU77d` is the case. An earlier revision of this docblock said the missing-error
 * covers a value that is "not a single string value", which described a branch duplicates do
 * not take (review LOW-2). Scope of the measurement: this header, these four forms, this
 * fastify and Node version; `set-cookie` is the documented array-valued exception and was not
 * probed.
 *
 * @throws TenantContextMissingError - header absent or blank
 * @throws TenantContextInvalidError - header present but not a UUID, which includes the
 *   comma-joined value a duplicated header arrives as
 */
export const billingTenantContextHandler = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  const header = request.headers[BILLING_HEADERS.TENANT_ID];

  if (typeof header !== "string" || header.trim() === "") {
    throw new TenantContextMissingError();
  }

  const parsed = tenantIdSchema.safeParse(header);
  if (!parsed.success) {
    throw new TenantContextInvalidError();
  }

  request.tenantId = parsed.data;
};
