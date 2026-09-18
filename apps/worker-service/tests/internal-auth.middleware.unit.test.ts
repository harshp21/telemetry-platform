import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkerServiceApp } from "../src/app";
import { buildInternalAuthMiddleware } from "../src/middleware/internal-auth.middleware";
import { env } from "../src/config/env";
import { WORKER_HEADERS, WORKER_RESPONSES, WORKER_ROUTES } from "../src/constants";

/**
 * worker-service's service-to-service auth guard (S-8).
 *
 * **This file is new.** worker-service had no guard suite at all: the only cases touching the
 * middleware were in `env.schema.unit.test.ts`, and they were about *which secret* authenticates
 * rather than about how the comparison is made or when it runs.
 *
 * Three defects are under test here, and all three were in this guard when the file was written:
 *
 * 1. the comparison was `normalizedSecret !== internalApiSecret` -- an ordinary string compare,
 *    which short-circuits at the first differing byte and leaks how many leading bytes a guess
 *    got right through response latency;
 * 2. a duplicated `X-Internal-Secret` was resolved with `Array.isArray(p) ? p[0] : p`, taking the
 *    first value where usage-service rejects any non-string outright;
 * 3. the status was the literal `401` rather than `WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED`,
 *    which that constant was added for.
 *
 * **What these cases do not prove.** Nothing here asserts timing, and nothing here should. A
 * timing assertion over SHA-256 plus `crypto.timingSafeEqual` is not reliably measurable in a
 * vitest process on a shared runner -- the noise exceeds the effect, and a threshold that passed
 * on this host would be a flake on CI. A green run of this file is **not** evidence of
 * constant-time behaviour. What it establishes is behavioural equivalence with the `!==` it
 * replaced, and that the guard routes through the shared comparison rather than an inline one.
 * The security property rests on `crypto.timingSafeEqual`'s documented contract and on the
 * fixed-width-digest argument in `secretsMatch`'s own docblock.
 *
 * The app touches neither Postgres nor Redis: the container's ioredis client is `lazyConnect`,
 * nothing calls `connect()`, and `app.inject` needs no socket.
 */

const OTHER_VALID_SECRET = "s-008-worker-wrong-secret-at-least-32-chars";

/**
 * Source-text assertions on the middleware, used by the "routes through the shared comparison"
 * case below.
 *
 * Reading the subject's own source is unusual and is done deliberately, because the property in
 * question is **not observable from behaviour**: `!==` and `secretsMatch` return the same boolean
 * for every input, so the whole accept/reject table below stays green if someone puts the string
 * compare back. The neighbouring precedent for reading a real artifact at test time with a
 * throwing locator is `tests/env.schema.unit.test.ts`, which reads `.env.example` and
 * `docker-compose.yml` the same way.
 *
 * Scope, stated so it is not over-read: this is a text check on one file. It notices the specific
 * regression it names -- an inline `!==` against the configured secret -- and it would not notice
 * a leaky comparison written some third way.
 *
 * **It is also brittle in the other direction, and that is documented rather than fixed.** The
 * assertion matches *text*, over the whole file including its comments, so it can go red on a
 * change that alters no behaviour at all. Measured at the Gate-3 rework rather than reasoned
 * about: the guard's own docblock spells the old expression out, wrapped across two comment
 * lines. Rewrapping just that comment -- joining the two halves onto one line, no executable
 * character touched -- turns `W8` red and nothing else (`Tests 1 failed | 12 passed (13)`, this file,
 * `@telemetry/worker-service`). The file was restored from a copy afterwards and `md5sum -c` passed.
 *
 * So a false **positive** is possible and a false **negative** is not: reflowing a comment
 * fails the build, while an actual return to the string compare cannot slip past. That is the
 * right direction for the failure to point, which is why the case is kept as it is. The
 * alternative -- stripping block comments before asserting, or scoping the match to the text
 * after the factory's declaration -- is a change to what this test *does*, and was out of scope
 * for a text-only rework; it is recorded as an option rather than taken. If this ever fires on
 * an innocent reflow, that is the moment to make it structural, not to delete it.
 */
const MIDDLEWARE_SOURCE_URL = new URL("../src/middleware/internal-auth.middleware.ts", import.meta.url);

const readMiddlewareSource = (): string => {
  const source = readFileSync(MIDDLEWARE_SOURCE_URL, "utf8");

  if (source.trim().length === 0) {
    throw new Error(
      `${MIDDLEWARE_SOURCE_URL.pathname} is empty; the locator is pointing at the wrong file and the assertions below would pass vacuously.`
    );
  }

  return source;
};

describe("worker-service internal-auth guard", () => {
  let app: ReturnType<typeof buildWorkerServiceApp>;

  beforeEach(() => {
    app = buildWorkerServiceApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const replay = async (headers: Record<string, string | string[]>) =>
    app.inject({ method: "POST", url: WORKER_ROUTES.INTERNAL_WORKER_REPLAY, headers });

  it("W1 - allows a request carrying the correct X-Internal-Secret", async () => {
    const response = await replay({ [WORKER_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET });

    expect(response.statusCode).toBe(WORKER_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toEqual({
      status: WORKER_RESPONSES.STATUS_ACCEPTED,
      workflow: WORKER_RESPONSES.WORKFLOW_USAGE_REPLAY
    });
  });

  it("W2 - rejects a request with no X-Internal-Secret", async () => {
    const response = await replay({});

    expect(response.statusCode).toBe(WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toEqual({ code: WORKER_RESPONSES.CODE_UNAUTHORIZED });
  });

  it("W3 - rejects a wrong X-Internal-Secret", async () => {
    const response = await replay({ [WORKER_HEADERS.INTERNAL_SECRET]: OTHER_VALID_SECRET });

    expect(response.statusCode).toBe(WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toEqual({ code: WORKER_RESPONSES.CODE_UNAUTHORIZED });
  });

  // The inputs a byte-at-a-time attack walks through. Their verdicts are identical under `!==`
  // and under the digest comparison -- that is the point, and it is why this case alone is not
  // evidence for the fix. It is the equivalence half: the new comparison must not have changed
  // any answer.
  it("W4 - rejects a prefix, a superstring and a single-byte variant of the correct secret", async () => {
    const correct = env.INTERNAL_API_SECRET;
    const variants = [
      correct.slice(0, -1),
      `${correct}x`,
      `X${correct.slice(1)}`,
      `${correct.slice(0, -1)}X`,
      ""
    ];

    for (const candidate of variants) {
      const response = await replay({ [WORKER_HEADERS.INTERNAL_SECRET]: candidate });

      expect(response.statusCode).toBe(WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    }
  });

  // A duplicated `X-Internal-Secret` must be a `401` in all three guards (AC9).
  //
  // **This case does not reach the `Array.isArray` arm, and it was written believing it did.**
  // Re-measured at fastify 5.10.0 on two transports: a duplicated `x-internal-secret` arrives
  // **joined into a string**, `"good,evil"` via `app.inject` and `"good, evil"` over a raw
  // socket -- different separators, both `typeof "string"`. Passing an array to `inject`'s header
  // API does not reach the arm either; inject joins it before the request is built. So this case
  // was green before the guard changed and stays green after, and it is kept as a *verdict* pin
  // rather than as evidence for the non-string rejection. The case that actually reaches that
  // branch calls the middleware directly, below.
  //
  // Claimed no more strongly than measured: unreachable through HTTP and through `app.inject`,
  // at fastify 5.10.0, for this header. Not "an array is impossible" -- `set-cookie` is the
  // documented array-valued exception and was not probed. Do not write this up as an exploit.
  it("W5 - rejects a duplicated X-Internal-Secret even when one value is correct", async () => {
    const response = await replay({
      [WORKER_HEADERS.INTERNAL_SECRET]: [env.INTERNAL_API_SECRET, OTHER_VALID_SECRET]
    });

    expect(response.statusCode).toBe(WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toEqual({ code: WORKER_RESPONSES.CODE_UNAUTHORIZED });
  });

  // The case that **does** reach the non-string branch, because no transport will: it calls the
  // guard directly with an array whose first element is the correct secret. Under the previous
  // `Array.isArray(provided) ? provided[0] : provided` this authenticated -- the reply was never
  // touched and the request would have proceeded to the handler. Now any non-string is rejected
  // as smuggling, matching usage-service.
  //
  // The reply double records rather than returns: the assertion is the guard's decision, not a
  // stub's value. It throws on an unexpected call shape rather than silently accepting one.
  it("W10 - rejects a non-string X-Internal-Secret at the guard, without picking an element", async () => {
    const sent: Array<{ status: number; body: unknown }> = [];
    let pendingStatus: number | undefined;
    const reply = {
      status(code: number) {
        pendingStatus = code;
        return this;
      },
      send(body: unknown) {
        if (pendingStatus === undefined) {
          throw new Error("send() was called without status(); the guard's reply shape changed.");
        }
        sent.push({ status: pendingStatus, body });
        return this;
      }
    };
    const guard = buildInternalAuthMiddleware(env.INTERNAL_API_SECRET);

    await guard(
      { headers: { [WORKER_HEADERS.INTERNAL_SECRET]: [env.INTERNAL_API_SECRET, OTHER_VALID_SECRET] } } as never,
      reply as never
    );

    expect(sent).toEqual([
      {
        status: WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED,
        body: { code: WORKER_RESPONSES.CODE_UNAUTHORIZED }
      }
    ]);
  });

  // The control for the case above: the same direct invocation with the correct secret as a
  // plain string must *not* reject. Without it, a guard that rejected everything would satisfy
  // W10 and W2-W6 alike.
  it("W11 - leaves the reply untouched when the secret is correct", async () => {
    const sent: unknown[] = [];
    const reply = {
      status() {
        sent.push("status");
        return this;
      },
      send() {
        sent.push("send");
        return this;
      }
    };
    const guard = buildInternalAuthMiddleware(env.INTERNAL_API_SECRET);

    await guard(
      { headers: { [WORKER_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET } } as never,
      reply as never
    );

    expect(sent).toEqual([]);
  });

  // Full-body equality, not `toMatchObject`. A subset match would let a response-contract change
  // -- adding a `message`, say -- pass green, which is the assertion shape that made "share the
  // whole guard factory" look free when it was not.
  it("W6 - answers a missing and a wrong secret with a byte-identical body", async () => {
    const missing = await replay({});
    const wrong = await replay({ [WORKER_HEADERS.INTERNAL_SECRET]: OTHER_VALID_SECRET });

    expect(missing.statusCode).toBe(wrong.statusCode);
    expect(missing.body).toBe(wrong.body);
    // Pinned against an explicit expected shape as well as against each other, so the pair cannot
    // agree on a body that is itself wrong.
    expect(JSON.parse(missing.body)).toEqual({ code: WORKER_RESPONSES.CODE_UNAUTHORIZED });
  });

  it("W7 - leaves /health reachable with no secret", async () => {
    const response = await app.inject({ method: "GET", url: WORKER_ROUTES.HEALTH });

    expect(response.statusCode).toBe(WORKER_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toMatchObject({ status: WORKER_RESPONSES.STATUS_OK });
  });

  it("W8 - routes the comparison through the shared timing-safe helper, not an inline compare", () => {
    const source = readMiddlewareSource();

    expect(source).toContain('secretsMatch } from "@telemetry/shared-utils"');
    expect(source).toContain("secretsMatch(");
    // The exact expression this guard shipped with. Behaviour cannot distinguish its return from
    // the digest comparison's, so nothing else in this file notices if it comes back.
    expect(source).not.toContain("!== internalApiSecret");
  });

  it("W9 - writes the unauthorized status as a constant, not a literal", () => {
    const source = readMiddlewareSource();

    expect(source).toContain("WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED");
    expect(source).not.toContain("reply.status(401)");
  });

  // S-8 / AC5. **The guard runs before the body is parsed, and this is the case that notices if
  // it stops.**
  //
  // The guard was an `app.register`-scoped `preHandler`, which runs *after* fastify's
  // content-type parser. Measured against this real replay route with no credential at all,
  // before the promotion:
  //
  //   no body / valid JSON / text/plain -> 401 {"code":"UNAUTHORIZED"}
  //   malformed JSON                    -> 500 {"code":"INTERNAL_ERROR","message":"Body is not
  //                                            valid JSON but content-type is set to
  //                                            'application/json'"}
  //   body with no content-type         -> 500 {"code":"INTERNAL_ERROR","message":"Unsupported
  //                                            Media Type"}
  //
  // The plan flagged this case as a likely vacuity: the replay route declares no body schema, so
  // there is no `FST_ERR_VALIDATION` for an unauthenticated caller to read, and a matrix built
  // only from valid-versus-schema-invalid bodies would have returned `401` on every row whatever
  // the phase. Measuring first is what found the two rows that *do* discriminate -- they come
  // from the content-type parser rather than from schema validation, and
  // `registerGlobalErrorHandler` turns both into a `500` whose message describes the parser. So
  // the case is real here and needs no fixture route.
  //
  // At `onRequest` all rows collapse to `401`. **Moving the hook back to `preHandler` in
  // `src/app.ts` reddens this case** -- that is what it is for.
  it("W12 - an unauthenticated caller cannot tell body shapes apart", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: WORKER_ROUTES.INTERNAL_WORKER_REPLAY,
      headers: { "content-type": "application/json" },
      payload: "{not json"
    });
    const noContentType = await app.inject({
      method: "POST",
      url: WORKER_ROUTES.INTERNAL_WORKER_REPLAY,
      payload: "anything"
    });
    const valid = await app.inject({
      method: "POST",
      url: WORKER_ROUTES.INTERNAL_WORKER_REPLAY,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ ok: true })
    });

    for (const response of [malformed, noContentType, valid]) {
      expect(response.statusCode).toBe(WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      expect(response.json()).toEqual({ code: WORKER_RESPONSES.CODE_UNAUTHORIZED });
    }

    // The bodies must be byte-identical too, not merely the same status: a difference anywhere in
    // the response is a signal, and the whole point is that the three are indistinguishable.
    expect(malformed.body).toBe(valid.body);
    expect(noContentType.body).toBe(valid.body);
  });

  // The other half of W12, and the reason W12 is not satisfied by a service that simply answers
  // 401 to everything: with a valid credential, malformed JSON must still be diagnosed. The guard
  // moved earlier; it did not swallow the parser.
  it("W13 - an authenticated caller still gets the body parser's diagnosis", async () => {
    const response = await app.inject({
      method: "POST",
      url: WORKER_ROUTES.INTERNAL_WORKER_REPLAY,
      headers: {
        [WORKER_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET,
        "content-type": "application/json"
      },
      payload: "{not json"
    });

    expect(response.statusCode).not.toBe(WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.statusCode).not.toBe(WORKER_RESPONSES.HTTP_STATUS_OK);
  });
});
