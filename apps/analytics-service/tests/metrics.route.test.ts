import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import Fastify from "fastify";
import { buildAnalyticsServiceApp } from "../src/app";
import { registerAnalyticsRoutes } from "../src/routes/analytics.routes";
import { ForbiddenError } from "../src/errors";
import { env } from "../src/config/env";
import type { AnalyticsService } from "../src/services/analytics.service";
import {
  ANALYTICS_GRANULARITY,
  ANALYTICS_HEADERS,
  ANALYTICS_METRICS,
  ANALYTICS_RESPONSES,
  ANALYTICS_ROUTES
} from "../src/constants";

/**
 * Route-level contract for `GET /v1/analytics/metrics` (T-051, slice 5).
 *
 * **This file is the discharge of S-9** and it is the highest-value suite in the task.
 * analytics-service's internal-auth guard and tenant-context hook have been installed on an
 * `app.register` scope that, until now, held no routes -- and a scope with no routes never runs
 * its hooks. Registering this route anywhere other than *inside* that callback does not produce
 * a `404` somebody notices: measured against the real `buildAnalyticsServiceApp()` at
 * fastify 5.10.0 / Node v22.22.2, **one probe route per placement**, a sibling scope, a prefixed
 * sibling scope and the root instance are all reachable with neither hook running, and a bare
 * probe handler there answers **`200` with no credentials at all, and runs**.
 *
 * The *real* route in those placements answers `500` -- or `400` for a request with no
 * querystring -- and does **not** run, because `AnalyticsController` refuses on the absent
 * `request.tenantId`. That is a second layer the probe handler did not have. Identical in the
 * first layer, different in what follows.
 *
 * **Two cases, one per layer.** `AM20` goes red when the registration moves out, on its *status*
 * assertion (`expected 500 to be 401`) -- an earlier revision of this docblock claimed it failed
 * on `expect(getMetricsRollup).not.toHaveBeenCalled()` instead, which is measurably wrong on
 * this tree because the controller already stopped the request. That assertion is kept and is
 * the guard that matters if the controller layer is ever weakened.
 * `AM22c` is the controller layer's own case, added at Gate 4 (MEDIUM-2) after coverage showed
 * the branch three docblocks lean on had no test at all.
 * `apps/billing-service/tests/billing-invoices.route.test.ts` `BU78` is `AM20`'s shape.
 *
 * The service layer is stubbed on the real container, so these cases are about wiring: hook
 * phase and order, scope encapsulation, status mapping and the response envelope. The app
 * touches neither Postgres nor Redis -- the container's ioredis client is `lazyConnect`,
 * nothing calls `connect()`, and every reachable handler is intercepted before a query.
 *
 * **Read a green run here at the strength it holds (S-59).** These cases establish that the
 * route sits behind the guard. They establish nothing about the guard's comparison being
 * timing-safe: `AU15` in `internal-auth.middleware.unit.test.ts` stays green while that guard
 * compares with `===`, which restores the byte-prefix short-circuit S-8 removed elsewhere.
 * That is S-59's, not this task's.
 */

const TENANT_ID = "0450a5e0-0000-4000-8000-0000000000aa";
const TENANT_ID_NOT_A_UUID = "not-a-uuid";
const WRONG_SECRET = "wrong-internal-api-secret-wrong-internal-api-secret";
/** Message carried by the `AppError` in `AM22e`; its text is the thing under assertion. */
const APP_ERROR_MESSAGE = "analytics metrics are not available for this tenant";

const FROM = "2026-03-01T00:00:00.000Z";
const TO = "2026-03-04T00:00:00.000Z";
const VALID_QUERY = `?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&granularity=${ANALYTICS_GRANULARITY.DAY}`;

const PAGE = {
  items: [
    {
      metricKey: "api.request",
      bucketStart: FROM,
      bucketEnd: "2026-03-02T00:00:00.000Z",
      totalQuantity: "10.5"
    }
  ],
  total: 1,
  page: ANALYTICS_METRICS.DEFAULT_PAGE,
  pageSize: ANALYTICS_METRICS.DEFAULT_PAGE_SIZE
};

const credentials = {
  [ANALYTICS_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET,
  [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID
};

describe(`GET ${ANALYTICS_ROUTES.METRICS}`, () => {
  let app: ReturnType<typeof buildAnalyticsServiceApp>;
  let getMetricsRollup: MockInstance<AnalyticsService["getMetricsRollup"]>;

  beforeEach(() => {
    app = buildAnalyticsServiceApp();
    getMetricsRollup = vi
      .spyOn(app.container.analyticsService, "getMetricsRollup")
      .mockResolvedValue(PAGE);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  const get = (headers: Record<string, string>, query = VALID_QUERY) =>
    app.inject({ method: "GET", url: `${ANALYTICS_ROUTES.METRICS}${query}`, headers });

  it("AM20 - rejects a request with no X-Internal-Secret with 401 and never reaches the service", async () => {
    const response = await get({ [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID });

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toMatchObject({ code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED });
    // **The observable form of "the route is inside the guarded scope" (S-9).**
    //
    // State what the mutation actually produced, not what it was predicted to produce. Moving
    // `registerAnalyticsRoutes` out of the `app.register` callback in `src/app.ts` and onto the
    // root instance was measured at Gate 3 to answer
    // `500 {"code":"INTERNAL_ERROR"}` with `getMetricsRollup` called **0** times -- not the
    // `200`-with-data the epic's four-placement probe predicted, and not a `404` either. This
    // case goes red on the *status* assertion above (`expected 500 to be 401`), and the
    // assertion below passes under that mutation.
    //
    // It is kept, and it is not decoration. What absorbs the escaped route today is
    // `AnalyticsController`'s own tenant guard: outside the scope no tenant-context hook runs,
    // `request.tenantId` is undefined, and the controller refuses before delegating. That is a
    // second layer, not the first. Delete it -- or widen the controller to tolerate a missing
    // tenant -- and this assertion becomes the only thing between a misplaced route and an
    // unauthenticated read of one customer's data. `apps/billing-service/tests/
    // billing-invoices.route.test.ts` `BU78` is the same shape for the same reason.
    expect(getMetricsRollup).not.toHaveBeenCalled();
  });

  it("AM20b - rejects a wrong X-Internal-Secret identically, and never reaches the service", async () => {
    const response = await get({
      [ANALYTICS_HEADERS.INTERNAL_SECRET]: WRONG_SECRET,
      [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID
    });

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    // Byte-identical to the missing-secret body: telling the two apart tells an
    // unauthenticated caller whether it guessed the header name.
    expect(response.json()).toEqual({ code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED });
    expect(getMetricsRollup).not.toHaveBeenCalled();
  });

  it("AM23 - runs internal-auth before tenant context, observed by which code a doubly-invalid request gets", async () => {
    // A request that fails *both* checks is the only shape that observes the order: a request
    // failing only the secret answers 401 UNAUTHORIZED under either hook order, so a
    // status-only assertion is vacuous here. Swapping the two `addHook` calls in `src/app.ts`
    // turns this into TENANT_CONTEXT_MISSING -- tenant context derived for a caller that has
    // not proved it is the gateway, the ordering `.claude/rules/tenant-isolation.md`
    // § *Forbidden* names.
    const neither = await get({});

    expect(neither.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(neither.json()).toEqual({ code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED });
    expect(neither.json()).not.toMatchObject({
      code: ANALYTICS_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });

    // Same request with a malformed rather than absent tenant, so the swap is caught whichever
    // tenant-context branch the mutation happens to take.
    const badSecretBadTenant = await get({
      [ANALYTICS_HEADERS.INTERNAL_SECRET]: WRONG_SECRET,
      [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID_NOT_A_UUID
    });
    expect(badSecretBadTenant.json()).toEqual({ code: ANALYTICS_RESPONSES.CODE_UNAUTHORIZED });

    // And once the caller has proved itself, the tenant check still runs -- so the guard is
    // ordered ahead of it, not instead of it.
    const authedBadTenant = await get({
      [ANALYTICS_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET,
      [ANALYTICS_HEADERS.TENANT_ID]: TENANT_ID_NOT_A_UUID
    });
    expect(authedBadTenant.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(authedBadTenant.json()).toMatchObject({
      code: ANALYTICS_RESPONSES.CODE_TENANT_CONTEXT_INVALID
    });
    expect(getMetricsRollup).not.toHaveBeenCalled();
  });

  it("AM23b - rejects a valid secret with no X-Tenant-Id, and never reaches the service", async () => {
    const response = await get({
      [ANALYTICS_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET
    });

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toMatchObject({
      code: ANALYTICS_RESPONSES.CODE_TENANT_CONTEXT_MISSING,
      message: ANALYTICS_RESPONSES.MESSAGE_TENANT_CONTEXT_MISSING
    });
    expect(getMetricsRollup).not.toHaveBeenCalled();
  });

  it("AM21 - answers 200 with { data: PaginatedResult } and passes the parsed query through", async () => {
    const response = await get(credentials);

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toEqual({ data: PAGE });
    expect(getMetricsRollup).toHaveBeenCalledTimes(1);
    expect(getMetricsRollup).toHaveBeenCalledWith(TENANT_ID, {
      from: FROM,
      to: TO,
      granularity: ANALYTICS_GRANULARITY.DAY,
      page: ANALYTICS_METRICS.DEFAULT_PAGE,
      pageSize: ANALYTICS_METRICS.DEFAULT_PAGE_SIZE
    });
  });

  it("AM21b - forwards metricKey, page and pageSize when supplied", async () => {
    const metricKey = "storage.write";
    await get(
      credentials,
      `${VALID_QUERY}&metricKey=${encodeURIComponent(metricKey)}&page=2&pageSize=5`
    );

    expect(getMetricsRollup).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ metricKey, page: 2, pageSize: 5 })
    );
  });

  it("AM22 - answers 400 VALIDATION_ERROR for an invalid query and never reaches the service", async () => {
    for (const badQuery of [
      "",
      `?from=${encodeURIComponent(FROM)}&granularity=${ANALYTICS_GRANULARITY.DAY}`,
      `?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&granularity=month`,
      `?from=${encodeURIComponent(TO)}&to=${encodeURIComponent(FROM)}&granularity=${ANALYTICS_GRANULARITY.DAY}`,
      `${VALID_QUERY}&page=${ANALYTICS_METRICS.MAX_PAGE + 1}`,
      `${VALID_QUERY}&pageSize=${ANALYTICS_METRICS.MAX_PAGE_SIZE + 1}`
    ]) {
      const response = await get(credentials, badQuery);

      expect(response.statusCode, `query=${badQuery}`).toBe(
        ANALYTICS_RESPONSES.HTTP_STATUS_BAD_REQUEST
      );
      const body = response.json<{ code: string; message: string }>();
      expect(body).toMatchObject({ code: ANALYTICS_RESPONSES.CODE_VALIDATION_ERROR });
      // The joined zod issues, so the client learns which field it got wrong.
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(0);
    }

    expect(getMetricsRollup).not.toHaveBeenCalled();
  });

  it("AM22b - answers 500 with a bare code, leaking no error text, when the service throws", async () => {
    // The repository issues raw SQL, and a Prisma `P2010` message carries the rendered query
    // tree and the tenant id -- S-40 measured exactly that on billing. Catching in the
    // controller rather than letting `registerGlobalErrorHandler` answer is what keeps it out
    // of the response body: that handler sends `error.message` whenever `NODE_ENV` is not
    // `production`, which includes every developer machine.
    getMetricsRollup.mockRejectedValueOnce(
      new Error('Raw query failed. Code: `22003`. Message: `ERROR: bigint out of range`')
    );

    const response = await get(credentials);

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_INTERNAL_ERROR);
    expect(response.json()).toEqual({ code: ANALYTICS_RESPONSES.CODE_INTERNAL_ERROR });
    expect(response.json()).not.toHaveProperty("message");
    expect(response.body).not.toContain("bigint");
  });

  it("AM22c - answers 500 with a bare code and never reaches the service when tenant context is absent", async () => {
    // **The second security layer, converted from prose into a guard** (Gate-4 MEDIUM-2).
    //
    // Three docblocks -- `src/app.ts`, `src/routes/analytics.routes.ts` and `AM20` above -- lean
    // on this branch to explain why a route registered outside the guarded scope serves no data.
    // Until this case it had no test at all: coverage named `analytics.controller.ts` lines
    // `66-74` uncovered, and those lines *are* the branch.
    //
    // Reproduced structurally rather than asserted about: the real `registerAnalyticsRoutes` and
    // the real controller are mounted on a bare Fastify instance carrying **neither** hook, which
    // is exactly the shape a misplaced registration produces. No tenant-context hook runs, so
    // `request.tenantId` is undefined when the handler is entered.
    const escaped = Fastify();
    registerAnalyticsRoutes(escaped, app.container.analyticsController);
    await escaped.ready();

    const response = await escaped.inject({
      method: "GET",
      url: `${ANALYTICS_ROUTES.METRICS}${VALID_QUERY}`,
      headers: {}
    });

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_INTERNAL_ERROR);
    // A bare code: the body must not say *why*, because on this path the caller is by
    // construction unauthenticated.
    expect(response.json()).toEqual({ code: ANALYTICS_RESPONSES.CODE_INTERNAL_ERROR });
    expect(response.json()).not.toHaveProperty("message");
    // **The load-bearing half, and the mutation that establishes it.** Deleting the guard at
    // `analytics.controller.ts` (the `if (!tenantId)` branch) and re-running this exact
    // composition was measured at Gate-4 rework to give:
    //
    //   status=200  serviceCalled=1  tenantArg=undefined
    //   body={"data":{"items":[{"metricKey":"CUSTOMER-DATA",...}],"total":1,...}}
    //
    // -- a `200` carrying the service's payload to a caller who sent no credentials, with the
    // tenant argument `undefined`. So this is not a defensive nicety: it is the only thing
    // between a misplaced registration and an unauthenticated read. Scoped run under the same
    // mutation: `Tests 1 failed | 11 passed (12)`, this case alone, `expected 200 to be 500`.
    //
    // Why `undefined` would not simply fail loudly downstream: a repository built with it binds
    // `set_config('app.tenant_id', NULL)`, and under RLS `"tenantId" = NULL` is `NULL` for every
    // row -- silently empty results rather than an error.
    expect(getMetricsRollup).not.toHaveBeenCalled();

    await escaped.close();
  });

  it("AM22d - answers 400 VALIDATION_ERROR before the tenant check, which is a small disclosure on a misplaced route", async () => {
    // NIT-2. The `500` above is **conditional on a valid querystring**: validation runs before
    // the tenant check, so the same escaped route answers `400` to a request with no query --
    // and the message names the required parameters to an unauthenticated caller, confirming the
    // endpoint exists and naming its contract.
    //
    // No tenant data escapes either way (the service is never called), and the ordering is
    // correct for a route in its proper place, where the caller has already proved itself. This
    // case exists so that "misplaced ⇒ 500" is never read as unconditional.
    const escaped = Fastify();
    registerAnalyticsRoutes(escaped, app.container.analyticsController);
    await escaped.ready();

    const response = await escaped.inject({
      method: "GET",
      url: ANALYTICS_ROUTES.METRICS,
      headers: {}
    });

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(response.json<{ code: string }>().code).toBe(ANALYTICS_RESPONSES.CODE_VALIDATION_ERROR);
    expect(getMetricsRollup).not.toHaveBeenCalled();

    await escaped.close();
  });

  it("AM22e - maps an AppError to its own status, code and message, unlike an unexpected error", async () => {
    // The controller's other uncovered branch (Gate-4 MEDIUM-2; coverage named lines `81-83`).
    // It is the **only** path on which analytics sends an error `message` derived from a thrown
    // error, so it is the one place the bare-`{code}` rule of `AM22b` does not apply -- an
    // `AppError` is deliberately constructed by this platform and its message is safe to return.
    //
    // Status and code are asserted from the error's own fields rather than from literals, so the
    // case pins "they come from the error" rather than "they happen to be 403".
    const appError = new ForbiddenError(APP_ERROR_MESSAGE);
    getMetricsRollup.mockRejectedValueOnce(appError);

    const response = await get(credentials);

    expect(response.statusCode).toBe(appError.statusCode);
    expect(response.json()).toEqual({ code: appError.code, message: appError.message });
    // The discriminator against AM22b, which pins the opposite for a non-AppError.
    expect(response.json()).toHaveProperty("message");
    expect(response.json<{ code: string }>().code).not.toBe(
      ANALYTICS_RESPONSES.CODE_INTERNAL_ERROR
    );
  });

  it("AM23c - leaves /health answering 200 with no credentials", async () => {
    // AC12. `/health` is registered on the root instance, structurally outside the guarded
    // scope; `AU23` is the standing case for that and this one re-checks it now that a route
    // exists inside the scope, because a scope with routes runs its hooks where an empty one
    // did not.
    const response = await app.inject({ method: "GET", url: ANALYTICS_ROUTES.HEALTH });

    expect(response.statusCode).toBe(ANALYTICS_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toMatchObject({ status: ANALYTICS_RESPONSES.STATUS_OK });
  });
});
