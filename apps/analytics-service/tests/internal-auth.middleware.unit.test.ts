import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerGlobalErrorHandler } from "@telemetry/shared-utils";
import { buildAnalyticsServiceApp } from "../src/app";
import { buildInternalAuthMiddleware } from "../src/middleware/internal-auth.middleware";
import { analyticsTenantContextHandler } from "../src/middleware/tenant-context.middleware";
import { env } from "../src/config/env";
import { ANALYTICS_HEADERS, ANALYTICS_RESPONSES, ANALYTICS_ROUTES } from "../src/constants";

/**
 * analytics-service's service-to-service auth guard (S-9, slice 1 of 2).
 *
 * **The honest limit, stated once here and again in `src/app.ts`.** Production's guarded
 * `app.register` scope holds **no routes** until T-051, and a scope carrying hooks and no routes
 * never runs those hooks. Re-derived at Gate 3 on fastify 5.10.0 / Node v22.22.2, three forms --
 * a `GET` and a `POST` at an unmatched path under an unprefixed scope, and a `GET` under a scope
 * registered with `{ prefix: "/v1/analytics" }`. All three answered `404` with the hook's own
 * call log still empty; with one route added inside the scope the hook ran for that route and
 * did **not** run again for a sibling 404. So every case below except `AU23` composes its own
 * app from the real factories plus a probe route, because there is no production route to drive.
 *
 * What that means for a reader: these cases prove the guard works and that `/health` is outside
 * the scope. They do **not** prove a future tenant-scoped route is inside it -- T-051 owns that,
 * and the narrowed S-9 entry in `.claude/rules/known-gaps.md` is the durable record of it.
 *
 * Nothing here touches Postgres or Redis: `AU23`'s container builds an ioredis client with
 * `lazyConnect` and nothing calls `connect()`; every other case runs on a bare Fastify instance.
 */

/** A second well-formed secret, so "wrong" never means "malformed". */
const OTHER_VALID_SECRET = "s-009-analytics-wrong-secret-at-least-32-chars";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID_NOT_A_UUID = "abc";
/**
 * The stand-in for T-051's route. It exists only inside these suites' own scope; production's
 * scope is empty, which is the whole subject of the docblock above.
 */
const PROBE_ROUTE = "/probe";

const MIDDLEWARE_SOURCE_URL = new URL(
  "../src/middleware/internal-auth.middleware.ts",
  import.meta.url
);
const APP_SOURCE_URL = new URL("../src/app.ts", import.meta.url);

/**
 * Source-text readers for the shape cases.
 *
 * Reading the subject's own source is unusual and is done deliberately, because the properties
 * in question are **not observable from behaviour here**: `!==` and `secretsMatch` return the
 * same boolean for every input, and production's hook registration cannot be observed at all
 * while its scope holds no routes. `apps/billing-service/tests/internal-auth.middleware.unit.test.ts`
 * (`BU135`/`BU136`) is the precedent, and this file's own `env.schema.unit.test.ts` sibling reads
 * `.env.example` and `docker-compose.yml` the same way.
 *
 * Throws on an empty read rather than returning `""`: an assertion set built on a silently empty
 * string would pass vacuously (`.claude/rules/testing.md`).
 *
 * Scope, so it is not over-read: these are text checks on two files. They notice the specific
 * regressions they name and would not notice a leaky comparison written some third way. They are
 * also brittle in the harmless direction -- the match is over the whole file including comments,
 * so a reflow can redden them while behaviour is unchanged.
 *
 * **False negatives are possible, and that is the direction that matters.** Measured at Gate 4 and
 * re-derived here, one mutation at a time and each reverted with `md5sum -c`: inserting a genuine
 * timing oracle -- `internalApiSecret.length !== providedSecret.length ||` ahead of the
 * `secretsMatch` call, which leaks the configured secret's exact length through response latency
 * -- leaves the whole package **56/56 green** with `AU15` green, `typecheck` exit 0 and `lint`
 * clean. Nothing on this tree catches it.
 *
 * **The near-miss is worth knowing, because it makes `AU15` look stronger than it is.** The same
 * oracle written in the *other* operand order (`providedSecret.length !== internalApiSecret.length`)
 * **does** redden `AU15` -- `Tests 1 failed | 55 passed (56)` -- but only because that spelling
 * happens to contain the substring `!== internalApiSecret` that the assertion below forbids. It is
 * a source-text coincidence, not a guard: one operand order is caught and the other is not.
 *
 * **A second evasion, and it is worse — S-59.** Found by Gate-5 QA and re-derived at the Gate-4
 * Round-2 rework. All three of `AU15`'s assertions hold while the live comparison is a plain
 * `===`: keep the import, call `secretsMatch("", "")` into an unused `shapeOk`, and write the real
 * decision as `!(providedSecret === internalApiSecret)`, which contains no forbidden substring.
 * Measured: `typecheck` exit 0, `lint` exit 0 with 0 findings, `Tests 56 passed (56)`. That form
 * restores the full byte-prefix short-circuit S-8 removed from billing and worker -- strictly worse
 * than the length oracle above, and `===` is what an ordinary refactor reaches for.
 *
 * So state what these reach and nothing more: they catch the spellings they enumerate. **Two known
 * evasions is evidence the set is larger than enumerated, not that it is now complete** -- and do
 * not "fix" it by adding `=== internalApiSecret` to the forbidden list, which buys one spelling and
 * leaves `Object.is`, `==`, a `localeCompare` and the next one nobody has thought of. S-59 carries
 * the two options that would actually reach the property (assert the call's operands with the
 * compiler API, or delete the case and say the property is unguarded); S-51 is the same shape in
 * billing-service. These are not evidence that the comparison is timing-safe, and a green run of
 * this file is not evidence that no oracle was added.
 */
const readSource = (url: URL): string => {
  const source = readFileSync(url, "utf8");

  if (source.trim().length === 0) {
    throw new Error(
      `${url.pathname} is empty; the locator points at the wrong file and the assertions built on it would pass vacuously.`
    );
  }

  return source;
};

describe("analytics-service internal-auth guard", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    await app.register(async (analyticsApi) => {
      analyticsApi.addHook("onRequest", buildInternalAuthMiddleware(env.INTERNAL_API_SECRET));
      analyticsApi.get(PROBE_ROUTE, async () => ({ ok: true }));
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const probe = async (headers: Record<string, string | string[]> = {}) =>
    app.inject({ method: "GET", url: PROBE_ROUTE, headers });

  it("AU7 - lets a request carrying the correct X-Internal-Secret past the guard", async () => {
    const response = await probe({ [ANALYTICS_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET });

    // `not.toBe(401)` states the subject: a future change to the probe handler cannot make this
    // case pass on a rejection.
    expect(response.statusCode).not.toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_OK);
  });

  it("AU8 - rejects a request with no X-Internal-Secret", async () => {
    const response = await probe();

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toEqual({ code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED });
  });

  it("AU9 - rejects a wrong X-Internal-Secret", async () => {
    const response = await probe({ [ANALYTICS_HEADERS.INTERNAL_SECRET]: OTHER_VALID_SECRET });

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toEqual({ code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED });
  });

  // AU10/AU11. The inputs a byte-at-a-time attack walks through. Their verdicts are identical
  // under `!==` and under the digest comparison -- that is the point. This is the equivalence
  // half: the shared comparison must not have changed any answer. It is **not** evidence of
  // constant-time behaviour, and a green run of this file must not be read as such; that
  // property rests on `crypto.timingSafeEqual`'s contract and is not measurable in a vitest
  // process on a shared runner.
  it("AU10/AU11 - rejects a prefix, a superstring, a one-byte variant and the empty string", async () => {
    const correct = env.INTERNAL_API_SECRET;
    const variants = [
      correct.slice(0, -1),
      `${correct}x`,
      `X${correct.slice(1)}`,
      `${correct.slice(0, -1)}X`,
      ""
    ];

    for (const candidate of variants) {
      const response = await probe({ [ANALYTICS_HEADERS.INTERNAL_SECRET]: candidate });

      expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      expect(response.json()).toEqual({ code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED });
    }
  });

  // AU12. **This case does not reach the non-string arm**, and it is recorded that way rather
  // than as an exploit. Measured at fastify 5.10.0: a duplicated `x-internal-secret` arrives
  // joined into a *string* -- `app.inject` joins an array before the request is built -- so what
  // rejects it is the comparison, not the type check. Kept as a verdict pin: a caller that got a
  // second header past the gateway must not be able to make the guard pick the good one. Scope:
  // this header, this transport, this fastify version; `set-cookie` is the documented
  // array-valued exception and was not probed.
  it("AU12 - rejects a duplicated X-Internal-Secret even when one value is correct", async () => {
    const response = await probe({
      [ANALYTICS_HEADERS.INTERNAL_SECRET]: [env.INTERNAL_API_SECRET, OTHER_VALID_SECRET]
    });

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toEqual({ code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED });
  });

  // AU13. The case that **does** reach the non-string branch, because no transport will: it
  // calls the guard directly with an array whose first element is the correct secret. Under
  // `Array.isArray(p) ? p[0] : p` -- the form billing and worker carried before S-8 -- this
  // authenticates. The reply double records rather than returns, so the assertion is the guard's
  // decision and not a stub's value, and it throws on an unexpected call shape.
  it("AU13 - rejects a non-string X-Internal-Secret at the guard, without picking an element", async () => {
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
      {
        headers: {
          [ANALYTICS_HEADERS.INTERNAL_SECRET]: [env.INTERNAL_API_SECRET, OTHER_VALID_SECRET]
        }
      } as never,
      reply as never
    );

    expect(sent).toEqual([
      {
        status: ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED,
        body: { code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED }
      }
    ]);
  });

  // The control for AU13: the same direct invocation with the correct secret as a plain string
  // must leave the reply untouched. Without it a guard that rejected everything would satisfy
  // AU8 through AU13 alike.
  it("AU13b - leaves the reply untouched when the secret is correct", async () => {
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
      { headers: { [ANALYTICS_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET } } as never,
      reply as never
    );

    expect(sent).toEqual([]);
  });

  // AU14. Full-body equality, not `toMatchObject`. A subset match would let a response-contract
  // change -- adding a `message`, say -- pass green, and "missing and wrong are indistinguishable"
  // is precisely the property decision D2 chose billing's bare `{code}` for.
  it("AU14 - answers a missing and a wrong secret with a byte-identical body", async () => {
    const missing = await probe();
    const wrong = await probe({ [ANALYTICS_HEADERS.INTERNAL_SECRET]: OTHER_VALID_SECRET });

    expect(missing.statusCode).toBe(wrong.statusCode);
    expect(missing.body).toBe(wrong.body);
    expect(JSON.parse(missing.body)).toEqual({ code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED });
  });

  it("AU15 - routes the comparison through the shared timing-safe helper, not an inline compare", () => {
    const source = readSource(MIDDLEWARE_SOURCE_URL);

    expect(source).toContain('secretsMatch } from "@telemetry/shared-utils"');
    expect(source).toContain("secretsMatch(");
    // The expression billing and worker each shipped before S-8. Behaviour cannot distinguish
    // its return from the digest comparison's, so nothing else in this file notices it.
    expect(source).not.toContain("!== internalApiSecret");
  });

  it("AU16 - writes the unauthorized status as a constant, not a literal", () => {
    const source = readSource(MIDDLEWARE_SOURCE_URL);

    expect(source).toContain("ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED");
    expect(source).not.toContain("reply.status(401)");
  });
});

describe("analytics-service guarded scope composition", () => {
  let app: FastifyInstance;
  let probeHandlerCalls: number;

  // Production's registration order and phases, reproduced here because production's own scope
  // holds no route to drive. `AU22b` is what ties this composition back to `src/app.ts`.
  beforeEach(async () => {
    probeHandlerCalls = 0;
    app = Fastify({ logger: false });
    registerGlobalErrorHandler(app);
    await app.register(async (analyticsApi) => {
      analyticsApi.addHook("onRequest", buildInternalAuthMiddleware(env.INTERNAL_API_SECRET));
      analyticsApi.addHook("onRequest", analyticsTenantContextHandler);
      analyticsApi.get(PROBE_ROUTE, async (request) => {
        probeHandlerCalls += 1;

        return { tenantId: request.tenantId };
      });
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const probe = async (headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: PROBE_ROUTE, headers });

  // AU22. Asserted on the **code** each hook returns, never on a status both share: a request
  // failing only the secret check answers `401 UNAUTHORIZED` under either hook order, so a
  // status-only assertion here would be vacuous (billing's `BU79` reasoning).
  //
  // Confirmed red by the mutation it exists for -- moving the guard to `preHandler` in this
  // block. At fastify 5.10.0 an `onRequest` hook runs before a `preHandler` one *in both
  // registration orders* (measured here at Gate 3: `preHandler` guard + `onRequest` tenant gives
  // `["tenant","auth"]` whichever is added first), so the mutation derives tenant context for a
  // caller that has not proved it is the gateway -- the ordering
  // `.claude/rules/tenant-isolation.md` § *Forbidden* names.
  //
  // The claim is the **conditional**, not a universal: *given* the tenant hook is `onRequest`,
  // the guard must be `onRequest` and registered first. Both hooks at `preHandler` with the
  // guard first also orders correctly (measured: `["auth","tenant"]`), so `onRequest` is not the
  // only correct phase.
  it("AU22 - runs internal-auth before tenant context, observed by which code a doubly-invalid request gets", async () => {
    const neither = await probe();

    expect(neither.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(neither.json()).toMatchObject({ code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED });
    expect(neither.json()).not.toMatchObject({
      code: ANALYTICS_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });

    // The same request with a malformed rather than absent tenant, so the swap is caught
    // whichever tenant-context branch the mutation happens to take.
    const badSecretBadTenant = await probe({
      [ANALYTICS_HEADERS.INTERNAL_SECRET]: OTHER_VALID_SECRET,
      [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID_NOT_A_UUID
    });

    expect(badSecretBadTenant.json()).toMatchObject({
      code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED
    });

    // And once the caller has proved itself, the tenant check still runs -- so the guard is
    // ordered ahead of it, not instead of it.
    const authedBadTenant = await probe({
      [ANALYTICS_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET,
      [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID_NOT_A_UUID
    });

    expect(authedBadTenant.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(authedBadTenant.json()).toMatchObject({
      code: ANALYTICS_RESPONSES.CODE_TENANT_CONTEXT_INVALID
    });
    expect(probeHandlerCalls).toBe(0);
  });

  // AU22b -- **not in the plan's §7 table**, added at Gate 3 to close the gap AU22 cannot.
  // AU22 asserts the ordering of a composition this *test file* builds, so on its own it would
  // stay green if `src/app.ts` registered the two hooks in the other order or at the other
  // phase. Nothing behavioural can notice that while the production scope holds no routes, so
  // this asserts the registration text instead.
  //
  // Scope: it checks that `src/app.ts` adds the guard as an `onRequest` hook, adds the tenant
  // handler as an `onRequest` hook, and writes the guard's registration **earlier in the file**.
  // It does not check that the two sit in the same scope, and it would not survive a rewrite
  // that registered the hooks through a helper. It goes red on the two mutations it is for --
  // swapping the two `addHook` lines, or changing either `"onRequest"` to `"preHandler"`.
  it("AU22b - registers the guard as an onRequest hook ahead of the tenant hook in src/app.ts", () => {
    const source = readSource(APP_SOURCE_URL);
    const guardIndex = source.indexOf('addHook("onRequest", buildInternalAuthMiddleware(');
    const tenantIndex = source.indexOf('addHook("onRequest", analyticsTenantContextHandler)');

    if (guardIndex === -1 || tenantIndex === -1) {
      throw new Error(
        `src/app.ts does not register both hooks as onRequest (guard found: ${String(guardIndex !== -1)}, tenant found: ${String(tenantIndex !== -1)}). Either the wiring changed phase or the locator did -- fix whichever is wrong, do not delete the assertion.`
      );
    }

    expect(guardIndex).toBeLessThan(tenantIndex);
  });
});

describe("analytics-service /health exemption", () => {
  let app: ReturnType<typeof buildAnalyticsServiceApp>;

  beforeEach(() => {
    app = buildAnalyticsServiceApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // AU23. The **only** case in this task that drives the shipped `buildAnalyticsServiceApp`, and
  // the only behavioural property of the production wiring that can go red while the guarded
  // scope holds no routes. `/health` is exempt *structurally* -- registered on the root instance,
  // outside the `app.register` callback -- rather than through an allowlist, so there is no list
  // to forget to update (billing's T-046 shape; usage-service's `public-routes.ts` is the other
  // shape and was not copied).
  //
  // Confirmed red by the mutation it exists for: moving the `/health` registration inside the
  // guarded scope turns this `401 {"code":"UNAUTHORIZED"}`.
  it("AU23 - leaves /health reachable with no secret and no tenant header", async () => {
    const response = await app.inject({ method: "GET", url: ANALYTICS_ROUTES.HEALTH });

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toMatchObject({ status: ANALYTICS_RESPONSES.STATUS_OK });
  });

  // The other half of the exemption: sending a valid secret and tenant must not *change* the
  // answer. That is a different property from AU23's, and it is the one AU23 cannot see, because
  // AU23 sends no headers at all and matches on `status` alone.
  //
  // **An earlier revision of this comment justified the case wrongly** -- it said that without
  // AU23b, a `/health` moved inside the scope "would still satisfy AU23 for a caller that
  // happened to authenticate". Measured, that mutation reddens **three** cases, AU23 among them:
  // `Tests 3 failed | 53 passed (56)` -- AU23, AU23b and `tests/smoke.test.ts`. So AU23 is not
  // blind to it and the case needed a different justification (Gate-4 NIT-1).
  //
  // The justification it has now is the mutation that reddens **this case alone**: making
  // `/health` vary its body by credential -- returning an extra `internal: <boolean>` field when
  // `X-Internal-Secret` is present -- gives `Tests 1 failed | 55 passed (56)`, AU23b only. AU23
  // stays green because `toMatchObject` on `status` does not see an added field. A `/health` that
  // quietly told an unauthenticated prober whether it had guessed the header name would be the
  // same class of oracle the guard's `{code}`-only body exists to avoid.
  it("AU23b - answers /health identically whether or not a valid secret is sent", async () => {
    const bare = await app.inject({ method: "GET", url: ANALYTICS_ROUTES.HEALTH });
    const withSecret = await app.inject({
      method: "GET",
      url: ANALYTICS_ROUTES.HEALTH,
      headers: {
        [ANALYTICS_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET,
        [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID
      }
    });

    expect(bare.statusCode).toBe(withSecret.statusCode);
    expect(bare.body).toBe(withSecret.body);
  });
});
