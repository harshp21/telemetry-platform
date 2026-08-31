import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InternalAuthRequiredError } from "../errors";
import { USAGE_SERVICE_HEADERS } from "../constants";
import { isPublicRoute } from "./public-routes";

/**
 * Constant-time equality for two secrets of unknown length.
 *
 * `===` on strings short-circuits at the first differing byte, so response latency leaks how
 * many leading bytes a guess got right -- enough to recover a secret byte by byte from a
 * network-reachable endpoint.
 *
 * `crypto.timingSafeEqual` fixes that but *throws* on unequal buffer lengths, and guarding it
 * with a length check reintroduces an early-exit oracle for the secret's length. Hashing both
 * sides to a fixed-width SHA-256 digest first removes the precondition without branching on the
 * secret: both digests are always 32 bytes, so the comparison never throws and takes the same
 * time regardless of the candidate's length or content. SHA-256's collision resistance makes
 * digest equality equivalent to string equality here.
 */
const secretsMatch = (provided: string, expected: string): boolean => {
  const digest = (value: string): Buffer =>
    createHash("sha256").update(value, "utf8").digest();

  return timingSafeEqual(digest(provided), digest(expected));
};

/**
 * Fastify `onRequest` hook enforcing service-to-service auth (S-4).
 *
 * Rejects with `401 UNAUTHORIZED` unless the request carries the shared `X-Internal-Secret`.
 * `/health` and anything else in `USAGE_SERVICE_PUBLIC_ROUTES` is exempt.
 *
 * Registered before the tenant-context hook so an unauthenticated caller never causes tenant
 * context to be derived, logged, or traced.
 *
 * @param expectedSecret - The configured `INTERNAL_API_SECRET`. Validated non-empty and at least
 *   `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` long by the env schema at module load.
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
