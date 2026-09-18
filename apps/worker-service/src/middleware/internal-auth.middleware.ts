import type { FastifyReply, FastifyRequest } from "fastify";
import { secretsMatch } from "@telemetry/shared-utils";
import { WORKER_HEADERS, WORKER_RESPONSES } from "../constants";

/**
 * Fastify `onRequest` hook enforcing service-to-service auth.
 *
 * Rejects with `401 UNAUTHORIZED` unless the request carries the shared `X-Internal-Secret`.
 * `/health` is exempt structurally rather than by an allowlist: it is registered on the root
 * instance, outside the `app.register` scope this guard is added to.
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
 *    `WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED` replaces a literal `401`; that constant was added
 *    for this and the middleware kept writing the literal.
 *
 * **Phase.** This is registered as an `onRequest` hook (`src/app.ts`), not a `preHandler`. It was
 * a `preHandler`, which meant fastify parsed the body *before* the guard ran, and an
 * unauthenticated caller could tell body shapes apart. Measured by reverting this scope's hook to
 * `preHandler` and injecting six request shapes at this service's real replay route with no
 * credential at all -- **three** distinguishable states:
 *
 *   - `401 UNAUTHORIZED`, empty message: a valid body, a well-formed but schema-invalid body, a
 *     `text/plain` body, and no body at all.
 *   - `500 INTERNAL_ERROR` `"Body is not valid JSON but content-type is set to
 *     'application/json'"`: malformed JSON.
 *   - `500 INTERNAL_ERROR` `"Unsupported Media Type"`: a body with no content-type.
 *
 * At `onRequest` all six shapes collapse to a byte-identical `401`. The 401 membership was
 * enumerated at the Gate-5 rework, in the same run that corrected billing-service's count from two
 * to three (QA F-1); the same six shapes answered identically on both services, so this paragraph
 * and billing's sibling describe one measurement.
 *
 * @param internalApiSecret - The configured `INTERNAL_API_SECRET`, as parsed by
 *   `internalApiSecretSchema` at module load: trimmed, at least
 *   `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` characters, printable ASCII only. `app.ts` also
 *   accepts an explicit unvalidated override, which the smoke suite uses.
 */
export const buildInternalAuthMiddleware = (internalApiSecret: string) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const providedSecret = request.headers[WORKER_HEADERS.INTERNAL_SECRET];

    if (typeof providedSecret !== "string" || !secretsMatch(providedSecret, internalApiSecret)) {
      return reply
        .status(WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED)
        .send({ code: WORKER_RESPONSES.CODE_UNAUTHORIZED });
    }
  };
};
