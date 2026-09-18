import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { secretsMatch } from "@telemetry/shared-utils";
import { InternalAuthRequiredError } from "../errors";
import { USAGE_SERVICE_HEADERS } from "../constants";
import { isPublicRoute } from "./public-routes";

/**
 * Fastify `onRequest` hook enforcing service-to-service auth (S-4).
 *
 * Rejects with `401 UNAUTHORIZED` unless the request carries the shared `X-Internal-Secret`.
 * `/health` and anything else in `USAGE_SERVICE_PUBLIC_ROUTES` is exempt.
 *
 * Registered before the tenant-context hook so an unauthenticated caller never causes tenant
 * context to be derived, logged, or traced.
 *
 * The comparison is `secretsMatch` from `@telemetry/shared-utils` -- the one timing-safe
 * comparison all three services' guards use since S-8. It lived in this file until then;
 * billing's and worker's guards each wrote `!==`.
 *
 * @param expectedSecret - The configured `INTERNAL_API_SECRET`, as parsed by
 *   `internalApiSecretSchema` at module load: trimmed, at least
 *   `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` characters, printable ASCII only. Stated that way
 *   deliberately. This docblock used to say "validated non-empty and at least ... long", which was
 *   true on its own words and misleading in effect: under the untrimmed `.min()` this service
 *   declared before S-8, a string of 32 spaces satisfied it, and the property a reader takes from
 *   "non-empty" is *not blank*. S-8's own text required whichever task added the trim to reword
 *   this line, so it is reworded here rather than left for the next reader.
 */
export const buildUsageInternalAuthHandler = (expectedSecret: string) => {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (isPublicRoute(request)) {
      return;
    }

    const providedSecret = request.headers[USAGE_SERVICE_HEADERS.INTERNAL_SECRET];

    // A duplicated header arrives as an array. Picking one element would let a caller smuggle a
    // second value past whatever inspected the first, so a non-string is simply rejected.
    if (typeof providedSecret !== "string") {
      throw new InternalAuthRequiredError();
    }

    if (!secretsMatch(providedSecret, expectedSecret)) {
      throw new InternalAuthRequiredError();
    }
  };
};

/**
 * Registers the service-to-service auth guard.
 *
 * MUST be registered before {@link registerUsageTenantContextMiddleware} -- Fastify runs
 * `onRequest` hooks in registration order, and that order is the security contract.
 */
export const registerUsageInternalAuthMiddleware = (
  app: FastifyInstance,
  expectedSecret: string
): void => {
  app.addHook("onRequest", buildUsageInternalAuthHandler(expectedSecret));
};
