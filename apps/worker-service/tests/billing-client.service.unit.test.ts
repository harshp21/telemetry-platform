import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { INTERNAL_AUTH_HEADERS } from "@telemetry/shared-types";
import type { TenantId } from "@telemetry/shared-types";
import type { ServiceEnv } from "../src/config/env";
import { WORKER_BILLING_CLIENT } from "../src/constants";
import { BillingClientService } from "../src/services/billing-client.service";
import { INTEGRATION_COUNTS, INTEGRATION_ENUMERATION } from "./integration.constants";

/**
 * Unit cases for the outbound call into billing-service (T-042, S6).
 *
 * `fetch` is stubbed on `globalThis`, so these assert the **request this service builds** --
 * URL, method, headers, body -- and the **reply handling**, without a second service running.
 * The real round trip belongs to QA.
 */

const BILLING_BASE_URL = "http://billing-service.test:3004";
const INTERNAL_SECRET = "unit-test-internal-secret-at-least-32-chars";
const TENANT_ID = "8c1b2a5e-0000-4000-8000-000000000001" as TenantId;

const env = {
  BILLING_SERVICE_URL: BILLING_BASE_URL,
  INTERNAL_API_SECRET: INTERNAL_SECRET
} as unknown as ServiceEnv;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
} as unknown as Logger;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { [WORKER_BILLING_CLIENT.HEADER_CONTENT_TYPE]: WORKER_BILLING_CLIENT.CONTENT_TYPE_JSON }
  });

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Returns the single recorded `fetch` call, or throws.
 *
 * Throws rather than returning `undefined`: a client that stopped issuing the request would
 * otherwise leave every assertion below passing against `undefined?.something`
 * (`.claude/rules/testing.md`).
 */
const onlyFetchCall = (fetchMock: ReturnType<typeof vi.fn>): FetchCall => {
  const calls = fetchMock.mock.calls;
  if (calls.length !== INTEGRATION_COUNTS.SINGLE) {
    throw new Error(`expected exactly one fetch call, saw ${String(calls.length)}`);
  }

  const [url, init] = calls[0] as [string, RequestInit];

  return { url, init };
};

const headerValue = (init: RequestInit, name: string): string | undefined =>
  (init.headers as Record<string, string> | undefined)?.[name];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("BillingClientService", () => {
  it("B1 - POSTs to BILLING_SERVICE_URL plus the generate path", async () => {
    fetchMock.mockResolvedValue(jsonResponse(WORKER_BILLING_CLIENT.HTTP_STATUS_CREATED, {}));
    const client = new BillingClientService(env, logger);

    await client.generateInvoice(
      TENANT_ID,
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );

    const { url, init } = onlyFetchCall(fetchMock);
    expect(url).toBe(`${BILLING_BASE_URL}${WORKER_BILLING_CLIENT.GENERATE_PATH}`);
    expect(init.method).toBe(WORKER_BILLING_CLIENT.METHOD_POST);
  });

  it("B2 - carries the shared internal-auth header and a JSON content type", async () => {
    fetchMock.mockResolvedValue(jsonResponse(WORKER_BILLING_CLIENT.HTTP_STATUS_CREATED, {}));
    const client = new BillingClientService(env, logger);

    await client.generateInvoice(
      TENANT_ID,
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );

    const { init } = onlyFetchCall(fetchMock);
    // The header name comes from `@telemetry/shared-types`, not from a local literal, and is
    // asserted against that package rather than against worker's own re-export -- so a local
    // constant that drifted from the shared one would be caught here.
    expect(headerValue(init, INTERNAL_AUTH_HEADERS.INTERNAL_SECRET)).toBe(INTERNAL_SECRET);
    expect(headerValue(init, WORKER_BILLING_CLIENT.HEADER_CONTENT_TYPE)).toBe(
      WORKER_BILLING_CLIENT.CONTENT_TYPE_JSON
    );
  });

  it("B3 - sends exactly { tenantId, periodStart, periodEnd }", async () => {
    fetchMock.mockResolvedValue(jsonResponse(WORKER_BILLING_CLIENT.HTTP_STATUS_CREATED, {}));
    const client = new BillingClientService(env, logger);

    await client.generateInvoice(
      TENANT_ID,
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );

    const { init } = onlyFetchCall(fetchMock);
    // Asserted against the *parsed* JSON, and against the exact key set rather than a superset.
    // These three names are what `generateInvoiceRequestSchema` in
    // `apps/billing-service/src/validators/generate-invoice.validator.ts` requires; a body with
    // `from`/`to` or `start`/`end` would draw a `400 VALIDATION_ERROR` from code that reads
    // correct. No import across the service boundary -- the real round trip is QA's.
    expect(JSON.parse(String(init.body))).toEqual({
      tenantId: TENANT_ID,
      periodStart: INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      periodEnd: INTEGRATION_ENUMERATION.WINDOW_END_ISO
    });
  });

  it("B4 - treats 201 and 200 as success and anything else as a failure carrying the status", async () => {
    const client = new BillingClientService(env, logger);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(WORKER_BILLING_CLIENT.HTTP_STATUS_CREATED, { data: { invoiceId: "inv-1" } })
    );
    await expect(
      client.generateInvoice(TENANT_ID, INTEGRATION_ENUMERATION.WINDOW_START_ISO, INTEGRATION_ENUMERATION.WINDOW_END_ISO)
    ).resolves.toMatchObject({ created: true });

    // `200` covers both "an invoice already exists for this period" and "this tenant had nothing
    // billable" (`{ data: { invoiceId: null } }`). Both are successes for this caller, which is
    // what makes an over-inclusive tenant list harmless -- the asymmetry decision D1 rests on.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(WORKER_BILLING_CLIENT.HTTP_STATUS_OK, { data: { invoiceId: null } })
    );
    await expect(
      client.generateInvoice(TENANT_ID, INTEGRATION_ENUMERATION.WINDOW_START_ISO, INTEGRATION_ENUMERATION.WINDOW_END_ISO)
    ).resolves.toMatchObject({ created: false });

    const badRequest = 400;
    fetchMock.mockResolvedValueOnce(jsonResponse(badRequest, { code: "VALIDATION_ERROR" }));
    await expect(
      client.generateInvoice(TENANT_ID, INTEGRATION_ENUMERATION.WINDOW_START_ISO, INTEGRATION_ENUMERATION.WINDOW_END_ISO)
    ).rejects.toThrow(String(badRequest));

    const serverError = 500;
    fetchMock.mockResolvedValueOnce(jsonResponse(serverError, {}));
    await expect(
      client.generateInvoice(TENANT_ID, INTEGRATION_ENUMERATION.WINDOW_START_ISO, INTEGRATION_ENUMERATION.WINDOW_END_ISO)
    ).rejects.toThrow(String(serverError));
  });

  it("B5 - surfaces a transport failure or timeout as a rejection, never as a silent success", async () => {
    const client = new BillingClientService(env, logger);
    const aborted = new DOMException("The operation was aborted.", "TimeoutError");
    fetchMock.mockRejectedValueOnce(aborted);

    // A hung billing-service must not look like a billed tenant. The job counts this one as
    // failed and moves to the next tenant (`J5`); what it must not do is count it as succeeded.
    await expect(
      client.generateInvoice(TENANT_ID, INTEGRATION_ENUMERATION.WINDOW_START_ISO, INTEGRATION_ENUMERATION.WINDOW_END_ISO)
    ).rejects.toThrow(WORKER_BILLING_CLIENT.ERROR.REQUEST_FAILED);
  });

  it("B6 - passes an abort signal, so a hung billing-service cannot wedge the nightly loop", async () => {
    fetchMock.mockResolvedValue(jsonResponse(WORKER_BILLING_CLIENT.HTTP_STATUS_OK, {}));
    const client = new BillingClientService(env, logger);

    await client.generateInvoice(
      TENANT_ID,
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );

    const { init } = onlyFetchCall(fetchMock);
    // `fetch` has no default timeout. The loop is sequential, so without this one unresponsive
    // tenant stalls every tenant after it, indefinitely. Asserting the signal is present is as
    // far as a unit case can go without burning `TIMEOUT_MS` of wall clock.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("B7 - does not log the response body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(WORKER_BILLING_CLIENT.HTTP_STATUS_CREATED, { data: { invoiceId: "inv-secret" } })
    );
    const client = new BillingClientService(env, logger);

    await client.generateInvoice(
      TENANT_ID,
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );

    // Same rule `EventProcessorService` follows about never logging payload fields. Asserted by
    // scanning every argument of every logger call for the secret-ish value, rather than by
    // asserting one call's shape -- a client that logged the body on a *different* level would
    // pass the narrower form.
    const everything = JSON.stringify([
      ...(logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as unknown as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.debug as unknown as ReturnType<typeof vi.fn>).mock.calls
    ]);
    expect(everything).not.toContain("inv-secret");
  });

  it("B9 - keeps the status when the reply body is not JSON", async () => {
    const badGateway = 502;
    // A proxy error page, not billing-service's own error envelope. The status is the part an
    // operator needs; a parse error that swallowed it would turn "billing is behind a broken
    // proxy" into "something went wrong".
    fetchMock.mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: badGateway }));
    const client = new BillingClientService(env, logger);

    await expect(
      client.generateInvoice(TENANT_ID, INTEGRATION_ENUMERATION.WINDOW_START_ISO, INTEGRATION_ENUMERATION.WINDOW_END_ISO)
    ).rejects.toThrow(String(badGateway));
  });

  it("B10 - treats a 200 with a non-JSON body as a success with no invoice id", async () => {
    fetchMock.mockResolvedValue(
      new Response("", { status: WORKER_BILLING_CLIENT.HTTP_STATUS_OK })
    );
    const client = new BillingClientService(env, logger);

    await expect(
      client.generateInvoice(TENANT_ID, INTEGRATION_ENUMERATION.WINDOW_START_ISO, INTEGRATION_ENUMERATION.WINDOW_END_ISO)
    ).resolves.toEqual({ created: false, invoiceId: null });
  });

  it("B8 - the generate path matches billing-service's own constant", async () => {
    // **The mechanism that replaces promoting this value to a shared package.** The literal is
    // the *second* copy on the platform and `.claude/rules/constants.md` asks for promotion
    // before the third, so it is not promoted here -- but "two copies kept in step by
    // convention" is exactly the shape S-39 and S-27 are about, so the agreement is checked by
    // a command rather than by review.
    //
    // Reading the other service's source off disk rather than importing it: an import would
    // couple this package's compile to billing-service's internals, which is the objection S-27
    // records. `apps/billing-service/tests/env.schema.unit.test.ts` already reads
    // `docker-compose.yml` and `apps/gateway/.env.example` the same way, so this is the house
    // pattern rather than a new one.
    const billingConstants = readFileSync(
      resolve(import.meta.dirname, "../../billing-service/src/constants.ts"),
      "utf8"
    );
    const match = /INTERNAL_BILLING_GENERATE:\s*"([^"]+)"/.exec(billingConstants);

    // Fail loudly if the declaration is not found at all: a renamed constant would otherwise
    // make this case pass vacuously, which is the failure mode this file's other helper guards
    // against.
    expect(match, "INTERNAL_BILLING_GENERATE not found in billing-service/src/constants.ts").not
      .toBeNull();
    expect(match?.[1]).toBe(WORKER_BILLING_CLIENT.GENERATE_PATH);
  });
});
