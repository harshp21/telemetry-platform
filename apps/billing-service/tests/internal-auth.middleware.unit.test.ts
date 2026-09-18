import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBillingServiceApp } from "../src/app";
import { buildInternalAuthMiddleware } from "../src/middleware/internal-auth.middleware";
import { env } from "../src/config/env";
import { BILLING_HEADERS, BILLING_RESPONSES, BILLING_ROUTES } from "../src/constants";

/**
 * billing-service's service-to-service auth guard (S-8).
 *
 * **This file is new.** billing-service had no guard suite: the guard was exercised incidentally
 * by `internal-billing.route.test.ts` and `billing-invoices.route.test.ts`, both of which assert
 * with `toMatchObject` -- a *subset* match, which cannot see a body gaining a field.
 *
 * Three defects are under test here, and all three were in this guard when the file was written:
 *
 * 1. the comparison was `normalizedSecret !== internalApiSecret` -- an ordinary string compare,
 *    which short-circuits at the first differing byte and leaks how many leading bytes a guess
 *    got right through response latency;
 * 2. a duplicated `X-Internal-Secret` was resolved with `Array.isArray(p) ? p[0] : p`, taking the
 *    first value where usage-service rejects any non-string outright;
 * 3. the status was the literal `401` rather than `BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED`,
 *    which that constant was added for.
 *
 * billing registers the **same** guard factory in two scopes -- the internal one and the
 * tenant-facing one -- so every case here covers both call sites' comparison. The two scopes'
 * *phase* is a separate question, covered by `internal-billing.route.test.ts` and
 * `billing-invoices.route.test.ts`.
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
 * nothing calls `connect()`, and every reachable handler here is rejected before a query.
 */

const OTHER_VALID_SECRET = "s-008-billing-wrong-secret-at-least-32-chars";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Source-text assertions on the middleware, used by the two shape cases at the end.
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
 * character touched -- turns `BU135` red and nothing else (`Tests 1 failed | 11 passed (12)`, this file,
 * `@telemetry/billing-service`). The file was restored from a copy afterwards and `md5sum -c` passed.
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

describe("billing-service internal-auth guard", () => {
  let app: ReturnType<typeof buildBillingServiceApp>;

  beforeEach(() => {
    app = buildBillingServiceApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const generate = async (headers: Record<string, string | string[]>) =>
    app.inject({ method: "POST", url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE, headers });

  it("BU127 - lets a request carrying the correct X-Internal-Secret past the guard", async () => {
    const response = await generate({ [BILLING_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET });

    // Past the guard, then rejected by the controller's own body validation. `not.toBe(401)` is
    // what states the subject: a future handler change cannot make this case pass on a rejection.
    expect(response.statusCode).not.toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(response.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_VALIDATION_ERROR });
  });

  it("BU128 - rejects a request with no X-Internal-Secret", async () => {
    const response = await generate({});

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toEqual({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
  });

  it("BU129 - rejects a wrong X-Internal-Secret", async () => {
    const response = await generate({ [BILLING_HEADERS.INTERNAL_SECRET]: OTHER_VALID_SECRET });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toEqual({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
  });

  // The inputs a byte-at-a-time attack walks through. Their verdicts are identical under `!==`
  // and under the digest comparison -- that is the point, and it is why this case alone is not
  // evidence for the fix. It is the equivalence half: the new comparison must not have changed
  // any answer.
  it("BU130 - rejects a prefix, a superstring and a single-byte variant of the correct secret", async () => {
    const correct = env.INTERNAL_API_SECRET;
    const variants = [
      correct.slice(0, -1),
      `${correct}x`,
      `X${correct.slice(1)}`,
      `${correct.slice(0, -1)}X`,
      ""
    ];

    for (const candidate of variants) {
      const response = await generate({ [BILLING_HEADERS.INTERNAL_SECRET]: candidate });

      expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
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
  it("BU131 - rejects a duplicated X-Internal-Secret even when one value is correct", async () => {
    const response = await generate({
      [BILLING_HEADERS.INTERNAL_SECRET]: [env.INTERNAL_API_SECRET, OTHER_VALID_SECRET]
    });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toEqual({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
  });

  // The case that **does** reach the non-string branch, because no transport will: it calls the
  // guard directly with an array whose first element is the correct secret. Under the previous
  // `Array.isArray(provided) ? provided[0] : provided` this authenticated -- the reply was never
  // touched and the request would have proceeded to the handler. Now any non-string is rejected
  // as smuggling, matching usage-service.
  //
  // The reply double records rather than returns: the assertion is the guard's decision, not a
  // stub's value. It throws on an unexpected call shape rather than silently accepting one.
  it("BU137 - rejects a non-string X-Internal-Secret at the guard, without picking an element", async () => {
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
      { headers: { [BILLING_HEADERS.INTERNAL_SECRET]: [env.INTERNAL_API_SECRET, OTHER_VALID_SECRET] } } as never,
      reply as never
    );

    expect(sent).toEqual([
      {
        status: BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED,
        body: { code: BILLING_RESPONSES.CODE_UNAUTHORIZED }
      }
    ]);
  });

  // The control for the case above: the same direct invocation with the correct secret as a
  // plain string must *not* reject. Without it, a guard that rejected everything would satisfy
  // BU137 and BU128-BU132 alike.
  it("BU138 - leaves the reply untouched when the secret is correct", async () => {
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
      { headers: { [BILLING_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET } } as never,
      reply as never
    );

    expect(sent).toEqual([]);
  });

  // Full-body equality, not `toMatchObject`. A subset match would let a response-contract change
  // -- adding a `message`, say -- pass green, which is the assertion shape that made "share the
  // whole guard factory across three services" look free when it was not: billing answers
  // `{code}` and usage-service answers `{code, message}`, and every existing billing assertion
  // would have accepted the change.
  it("BU132 - answers a missing and a wrong secret with a byte-identical body", async () => {
    const missing = await generate({});
    const wrong = await generate({ [BILLING_HEADERS.INTERNAL_SECRET]: OTHER_VALID_SECRET });

    expect(missing.statusCode).toBe(wrong.statusCode);
    expect(missing.body).toBe(wrong.body);
    expect(JSON.parse(missing.body)).toEqual({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
  });

  // The same guard factory is registered in the tenant-facing scope too, so the comparison fix
  // reaches two customer-visible routes as well as the internal one. Asserted on the list route
  // with a valid tenant header present, so the only thing that can be rejecting it is the secret.
  it("BU133 - applies the same rejection to the tenant-facing scope", async () => {
    const missing = await app.inject({
      method: "GET",
      url: BILLING_ROUTES.INVOICES,
      headers: { [BILLING_HEADERS.TENANT_ID]: TENANT_ID }
    });
    const wrong = await app.inject({
      method: "GET",
      url: BILLING_ROUTES.INVOICES,
      headers: {
        [BILLING_HEADERS.INTERNAL_SECRET]: OTHER_VALID_SECRET,
        [BILLING_HEADERS.TENANT_ID]: TENANT_ID
      }
    });

    expect(missing.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(wrong.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(missing.body).toBe(wrong.body);
    expect(JSON.parse(missing.body)).toEqual({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
  });

  it("BU134 - leaves /health reachable with no secret", async () => {
    const response = await app.inject({ method: "GET", url: BILLING_ROUTES.HEALTH });

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toMatchObject({ status: BILLING_RESPONSES.STATUS_OK });
  });

  it("BU135 - routes the comparison through the shared timing-safe helper, not an inline compare", () => {
    const source = readMiddlewareSource();

    expect(source).toContain('secretsMatch } from "@telemetry/shared-utils"');
    expect(source).toContain("secretsMatch(");
    // The exact expression this guard shipped with. Behaviour cannot distinguish its return from
    // the digest comparison's, so nothing else in this file notices if it comes back.
    expect(source).not.toContain("!== internalApiSecret");
  });

  it("BU136 - writes the unauthorized status as a constant, not a literal", () => {
    const source = readMiddlewareSource();

    expect(source).toContain("BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED");
    expect(source).not.toContain("reply.status(401)");
  });
});
