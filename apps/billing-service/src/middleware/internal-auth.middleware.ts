import type { FastifyReply, FastifyRequest } from "fastify";
import { secretsMatch } from "@telemetry/shared-utils";
import { BILLING_HEADERS, BILLING_RESPONSES } from "../constants";

/**
 * Fastify `onRequest` hook enforcing service-to-service auth.
 *
 * Rejects with `401 UNAUTHORIZED` unless the request carries the shared `X-Internal-Secret`.
 * `/health` is exempt structurally rather than by an allowlist: it is registered on the root
 * instance, outside both `app.register` scopes this guard is added to.
 *
 * **This factory is registered twice** (`src/app.ts`): once on the internal scope carrying
 * `POST /v1/internal/billing/generate`, and once on the tenant-facing scope carrying
 * `GET /v1/billing/invoices` and `GET /v1/billing/invoices/:id`. Two of the three routes behind it
 * are customer-visible, which is why the comparison below is not a theoretical concern.
 *
 * Three things about this file changed at S-8, and each is worth stating because each looked
 * harmless:
 *
 * 1. **The comparison is `secretsMatch`, never `!==`.** It was `normalizedSecret !==
 *    internalApiSecret`. String comparison short-circuits at the first differing byte, so response
 *    latency leaks how many leading bytes a guess got right, and a secret is recoverable one byte
 *    at a time rather than by guessing it whole. The replacement is the same helper usage-service
 *    has used since S-4, now shared from `@telemetry/shared-utils` instead of living in three
 *    copies. Note that no test can tell the two apart by behaviour -- they return the same boolean
 *    for every input -- which is why `tests/internal-auth.middleware.unit.test.ts` also asserts
 *    the *shape* of this file.
 * 2. **A non-string header value is rejected, not normalized.** It was
 *    `Array.isArray(provided) ? provided[0] : provided`, which picks one element and lets a caller
 *    smuggle a second value past whatever inspected the first. Measured at fastify 5.10.0 on two
 *    transports, a duplicated `x-internal-secret` actually arrives **joined into a string** --
 *    `"good, evil"` over a socket, `"good,evil"` via `app.inject` -- so that arm was not reachable
 *    through either, and this is a divergence between guards that should be identical rather than
 *    a demonstrated exploit. `set-cookie` is the documented array-valued exception and was not
 *    probed. Rejecting is what usage-service already did.
 * 3. **`reply.send(...)` is returned, and the status comes from a constant.** The `return` is a
 *    statement of intent rather than a behaviour change: measured in the same run, an
 *    un-`return`ed `reply.status().send()` inside an `onRequest` hook already short-circuits later
 *    hooks, identically to the returned and thrown forms. Saying so rather than claiming a fix.
 *    `BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED` replaces a literal `401`; that constant was added
 *    for this and the middleware kept writing the literal.
 *
 * **Phase.** Both registrations are `onRequest`. The tenant-facing one already was; the internal
 * one was a `preHandler`, which meant fastify parsed the body *before* the guard ran and an
 * unauthenticated caller could tell body shapes apart. Measured by reverting this scope's hook to
 * `preHandler` and injecting six request shapes at this service's real generate route with no
 * credential at all -- **three** distinguishable states:
 *
 *   - `401 UNAUTHORIZED`, empty message: a valid body, a well-formed but schema-invalid body, a
 *     `text/plain` body, and no body at all. Schema-invalid does not leak a `FST_ERR_VALIDATION`
 *     because this route validates in the controller, not through a fastify route schema.
 *   - `500 INTERNAL_ERROR` `"Body is not valid JSON but content-type is set to
 *     'application/json'"`: malformed JSON.
 *   - `500 INTERNAL_ERROR` `"Unsupported Media Type"`: a body with no content-type.
 *
 * Both `500`s come from the content-type parser, which runs before `preHandler`, mapped by
 * `registerGlobalErrorHandler`. At `onRequest` all six shapes collapse to a byte-identical `401`.
 *
 * An earlier revision of this paragraph said **two** states and omitted the no-content-type row --
 * the row worker's sibling docblock already named. Corrected at the Gate-5 rework (QA F-1) by
 * re-performing the revert on billing and worker in one run: the same six shapes answered
 * identically on both services, so the two Phase paragraphs now describe one measurement.
 *
 * The response body is deliberately `{code}` with no message, and deliberately identical for a
 * missing and for a wrong secret: telling those apart tells an unauthenticated caller whether it
 * guessed the header name. It differs from usage-service's `{code, message}`, which is why S-8
 * shared this comparison and not the whole guard -- converging the bodies would have been a
 * wire-contract change to a gateway-forwarded response, and every existing assertion here used
 * `toMatchObject`, which would not have noticed.
 *
 * @param internalApiSecret - The configured `INTERNAL_API_SECRET`, as parsed by
 *   `internalApiSecretSchema` at module load: trimmed, at least
 *   `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` characters, printable ASCII only. `app.ts` also
 *   accepts an explicit unvalidated override, which the smoke suite uses.
 */
export const buildInternalAuthMiddleware = (internalApiSecret: string) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const providedSecret = request.headers[BILLING_HEADERS.INTERNAL_SECRET];

    if (typeof providedSecret !== "string" || !secretsMatch(providedSecret, internalApiSecret)) {
      return reply
        .status(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED)
        .send({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
    }
  };
};
