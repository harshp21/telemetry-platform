import type { FastifyReply, FastifyRequest } from "fastify";
import { secretsMatch } from "@telemetry/shared-utils";
import { ANALYTICS_HEADERS, ANALYTICS_RESPONSES } from "../constants";

/**
 * Fastify `onRequest` hook enforcing service-to-service auth (S-9).
 *
 * Rejects with `401 UNAUTHORIZED` unless the request carries the shared `X-Internal-Secret`,
 * which the gateway attaches unconditionally to every proxied request
 * (`apps/gateway/src/plugins/proxy.plugin.ts`). `/health` is exempt structurally rather than by
 * an allowlist: it is registered on the root instance, outside the `app.register` scope this
 * guard is added to.
 *
 * **This guard currently protects zero routes, and that is measured rather than assumed.** The
 * scope `src/app.ts` adds it to holds no routes until T-051, and at fastify 5.10.0 a scope
 * carrying hooks and no routes never runs them -- three forms probed at Gate 3 (an unmatched
 * `GET` and `POST` under an unprefixed scope, and a `GET` under a scope registered with
 * `{ prefix: "/v1/analytics" }`): every one answered `404` with the hook's call log still empty.
 * So the wiring is in place for T-051 to register inside, and until it does, nothing reaches
 * this function in production. `.claude/rules/known-gaps.md` S-9 is the durable record.
 *
 * **Derived from the other three guards rather than written afresh** -- S-8 made those three one
 * rule, and a fourth spelling would undo it:
 *
 * 1. **The comparison is `secretsMatch`, never `!==`.** String comparison short-circuits at the
 *    first differing byte, so response latency leaks how many leading bytes a guess got right.
 *    No test can tell the two apart by behaviour -- they return the same boolean for every input
 *    -- which is why `tests/internal-auth.middleware.unit.test.ts` (`AU15`) also asserts the
 *    *shape* of this file.
 * 2. **A non-string header value is rejected, not normalised.** `Array.isArray(p) ? p[0] : p`
 *    picks one element and lets a caller smuggle a second value past whatever inspected the
 *    first. Measured at fastify 5.10.0, a duplicated `x-internal-secret` actually arrives
 *    *joined into a string*, so that arm is not reachable through `app.inject` -- this is a
 *    divergence between guards that should be identical, not a demonstrated exploit. `set-cookie`
 *    is the documented array-valued exception and was not probed. `AU13` reaches the branch by
 *    calling this factory directly.
 * 3. **`reply.send(...)` is returned, and the status comes from a constant.** The `return` is a
 *    statement of intent rather than a behaviour change: an un-`return`ed `reply.status().send()`
 *    inside an `onRequest` hook already short-circuits later hooks.
 *
 * **Phase: `onRequest`, and the claim is a conditional.** Given that
 * `analyticsTenantContextHandler` is an `onRequest` hook, this guard must be `onRequest` too and
 * must be registered first -- measured at Gate 3, a `preHandler` guard beside an `onRequest`
 * tenant hook runs `["tenant","auth"]` in *both* registration orders, which derives tenant
 * context before the caller has proved it is the gateway
 * (`.claude/rules/tenant-isolation.md` § *Forbidden*). It is **not** that `onRequest` is the only
 * correct phase: both hooks at `preHandler` with this one first also ordered correctly in the
 * same probe.
 *
 * The response body is deliberately `{code}` with no message, and deliberately identical for a
 * missing and for a wrong secret: telling those apart tells an unauthenticated caller whether it
 * guessed the header name. It matches billing-service and worker-service; usage-service answers
 * `{code, message}` (plan decision D2).
 *
 * @param internalApiSecret - the configured `INTERNAL_API_SECRET`, as parsed by
 *   `internalApiSecretSchema` at module load: trimmed, at least
 *   `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` characters, printable ASCII only. There is no
 *   unvalidated `options` override on `buildAnalyticsServiceApp` (plan decision D3), so on this
 *   tree every production and test caller reaches this factory with a schema-parsed value.
 */
export const buildInternalAuthMiddleware = (internalApiSecret: string) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const providedSecret = request.headers[ANALYTICS_HEADERS.INTERNAL_SECRET];

    if (typeof providedSecret !== "string" || !secretsMatch(providedSecret, internalApiSecret)) {
      return reply
        .status(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED)
        .send({ code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED });
    }
  };
};
