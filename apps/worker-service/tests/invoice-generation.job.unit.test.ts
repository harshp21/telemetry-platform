import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import { WORKER_INVOICE_JOB } from "../src/constants";
import {
  getPreviousDayRange,
  runInvoiceGenerationJob,
  type InvoiceGenerationJobDeps
} from "../src/jobs/invoice-generation.job";
import { INTEGRATION_COUNTS } from "./integration.constants";

/**
 * Unit cases for the nightly invoice-generation job (T-042, S7).
 *
 * Two halves, and they fail differently:
 *
 * - `J1`-`J4` pin `getPreviousDayRange`, which is pure. The failure it guards against is a
 *   *silent* few-hours shift of the day boundary: usage lands on the wrong invoice, and because
 *   `UsageLine.billed` is set once, the error is not self-correcting.
 * - `J5`-`J8` pin the loop's failure isolation. The failure they guard against is a tenant being
 *   silently skipped, which is the most expensive outcome in this whole task -- revenue metered
 *   and never billed, with nothing raising an alarm because "no invoice" looks exactly like "no
 *   usage".
 */

const TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001" as TenantId;
const TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002" as TenantId;
const TENANT_C = "cccccccc-0000-4000-8000-000000000003" as TenantId;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const UTC_MIDNIGHT_SUFFIX = "T00:00:00.000Z";

/**
 * `vitest.config.mjs`, resolved from this file rather than named as a static import.
 *
 * A variable specifier, for the reason `stream.consumer.unit.test.ts` records against `U50`:
 * the config is outside this package's `tsconfig.json` `include` and has no declaration, so a
 * literal `import "../vitest.config.mjs"` is a `TS2307`.
 */
const VITEST_CONFIG_URL = new URL("../vitest.config.mjs", import.meta.url).href;

/** The zone name a pin must not be, and the offset a pinned zone must not produce. */
const UTC_TIME_ZONE = "UTC";
const UTC_OFFSET_MINUTES = 0;

/**
 * An arbitrary calendar date for `J12`'s offset probe.
 *
 * Any date would do under a zone with no DST, which is one of the reasons `vitest.config.mjs`
 * chose one; the fields are named rather than inlined so the `new Date(y, m, d)` call reads as
 * the local-midnight form it is deliberately exercising.
 */
const SAMPLE_LOCAL_MIDNIGHT = {
  YEAR: 2026,
  MONTH_INDEX: 2,
  DAY: 10
} as const;

/**
 * `test.env.TZ` out of the imported config, or a throw.
 *
 * Throws in every direction a vacuous pass could come from -- no default export, no `test`
 * block, no `env`, no `TZ`, or a non-string -- because without it, deleting the pin from
 * `vitest.config.mjs` would leave `J12` comparing `undefined` against an unset `process.env.TZ`
 * and reporting green, which is precisely the inert-guard shape F-1 was about
 * (`.claude/rules/testing.md`: a helper that locates a thing must throw when it is missing).
 */
const readConfiguredTimeZone = (configModule: unknown): string => {
  const exported = (configModule as { default?: unknown }).default;
  const testBlock = (exported as { test?: unknown } | undefined)?.test;
  const env = (testBlock as { env?: unknown } | undefined)?.env;
  const timeZone = (env as { TZ?: unknown } | undefined)?.TZ;
  if (typeof timeZone !== "string" || timeZone.length === 0) {
    throw new Error(
      `vitest.config.mjs declares no string test.env.TZ (got ${String(timeZone)})`
    );
  }

  return timeZone;
};

const buildLogger = (): Logger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }) as unknown as Logger;

interface Harness {
  readonly deps: InvoiceGenerationJobDeps;
  readonly generateInvoice: ReturnType<typeof vi.fn>;
  readonly listTenants: ReturnType<typeof vi.fn>;
  readonly logger: Logger;
}

const buildHarness = (
  tenants: TenantId[] | Error,
  generate?: (tenantId: TenantId) => Promise<unknown>
): Harness => {
  const listTenants = vi.fn(() =>
    tenants instanceof Error ? Promise.reject(tenants) : Promise.resolve(tenants)
  );
  const generateInvoice = vi.fn((tenantId: TenantId) =>
    generate ? generate(tenantId) : Promise.resolve({ created: true, invoiceId: "inv" })
  );
  const logger = buildLogger();

  return {
    listTenants,
    generateInvoice,
    logger,
    deps: {
      enumeration: {
        listTenantsWithUnbilledUsage: listTenants
      } as unknown as InvoiceGenerationJobDeps["enumeration"],
      billingClient: {
        generateInvoice
      } as unknown as InvoiceGenerationJobDeps["billingClient"],
      logger
    }
  };
};

/**
 * Locates the call made for one tenant, or throws.
 *
 * Throws rather than returning `undefined`, because the whole point of `J5` is that a *missing*
 * call is the defect -- a helper that returned `undefined` would let the assertion pass for
 * exactly the tenant that was skipped (`.claude/rules/testing.md`).
 */
const callForTenant = (
  generateInvoice: ReturnType<typeof vi.fn>,
  tenantId: TenantId
): unknown[] => {
  const calls = generateInvoice.mock.calls as unknown[][];
  const call = calls.find((args) => args[0] === tenantId);
  if (!call) {
    throw new Error(
      `billing was never called for ${tenantId}; calls were ${JSON.stringify(calls.map((args) => args[0]))}`
    );
  }

  return call;
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("getPreviousDayRange", () => {
  it("J1 - resolves the previous UTC calendar day from an instant in the middle of the day", () => {
    const range = getPreviousDayRange(new Date("2026-03-11T13:45:12.345Z"));

    expect(range).toEqual({
      periodStart: "2026-03-10T00:00:00.000Z",
      periodEnd: "2026-03-11T00:00:00.000Z"
    });
  });

  it("J2 - resolves the same day from one minute past UTC midnight", () => {
    // The instant the scheduler actually fires is 02:00 UTC, so this is the shape that matters
    // most; `J1` is the sanity case.
    const range = getPreviousDayRange(new Date("2026-03-11T00:01:00.000Z"));

    expect(range).toEqual({
      periodStart: "2026-03-10T00:00:00.000Z",
      periodEnd: "2026-03-11T00:00:00.000Z"
    });
  });

  it("J3 - resolves the previous day from one minute before UTC midnight", () => {
    const range = getPreviousDayRange(new Date("2026-03-10T23:59:00.000Z"));

    expect(range).toEqual({
      periodStart: "2026-03-09T00:00:00.000Z",
      periodEnd: "2026-03-10T00:00:00.000Z"
    });
  });

  it("J4 - rolls back across a month boundary, including a leap-year February", () => {
    // `Date.UTC(y, m, d - 1)` normalises a zero or negative day into the previous month; a
    // hand-rolled `d - 1` on the string would produce `2026-03-00`.
    expect(getPreviousDayRange(new Date("2026-03-01T02:00:00.000Z"))).toEqual({
      periodStart: "2026-02-28T00:00:00.000Z",
      periodEnd: "2026-03-01T00:00:00.000Z"
    });
    expect(getPreviousDayRange(new Date("2024-03-01T02:00:00.000Z"))).toEqual({
      periodStart: "2024-02-29T00:00:00.000Z",
      periodEnd: "2024-03-01T00:00:00.000Z"
    });
    expect(getPreviousDayRange(new Date("2026-01-01T02:00:00.000Z"))).toEqual({
      periodStart: "2025-12-31T00:00:00.000Z",
      periodEnd: "2026-01-01T00:00:00.000Z"
    });
  });

  it("J5 - returns keys named periodStart and periodEnd, exactly 24 hours apart, both UTC midnight", () => {
    const range = getPreviousDayRange(new Date("2026-03-11T13:45:12.345Z"));

    // **The key names are not decoration.** They are what
    // `apps/billing-service/src/validators/generate-invoice.validator.ts` requires; a helper
    // returning `{ from, to }` or `{ start, end }` would make the epic's
    // `{ tenantId, ...yesterday }` produce a `400 VALIDATION_ERROR` from a snippet that reads
    // correct. The epic never says what the helper returns.
    expect(Object.keys(range).sort()).toEqual(["periodEnd", "periodStart"]);
    // Both are UTC midnight. **This assertion only discriminates when the process zone is not
    // UTC, which is now pinned rather than inherited.** `new Date(y, m, d)` is local midnight,
    // so it agrees with `Date.UTC(y, m, d)` exactly when the runner's offset is zero -- and
    // until T-042's Gate-5 rework nothing pinned the zone, so this case was a real guard on a
    // developer's non-UTC machine and inert on CI. `vitest.config.mjs` now sets
    // `test.env.TZ = "Asia/Kathmandu"` (+05:45), under which the local form yields
    // `...T18:15:00.000Z` wherever the suite runs, and `J12` asserts that pin is in effect.
    // An earlier revision of this comment said "on CI, which runs UTC, ... no assertion can
    // tell them apart"; that was true of the tree it was written on and is what F-1 fixed.
    expect(range.periodStart.endsWith(UTC_MIDNIGHT_SUFFIX)).toBe(true);
    expect(range.periodEnd.endsWith(UTC_MIDNIGHT_SUFFIX)).toBe(true);
    expect(
      new Date(range.periodEnd).getTime() - new Date(range.periodStart).getTime()
    ).toBe(MILLISECONDS_PER_DAY);
  });

  it("J12 - the runner's process zone is pinned non-UTC, which is what makes J1-J5 discriminate", async () => {
    // **Why this case exists.** `J1`-`J5` compare `Date.UTC(...)` output against fixed ISO
    // strings. Under a UTC process zone the local-midnight mutation produces those same strings,
    // so all five pass against the defect they exist to catch -- measured by Gate-5 QA, on the
    // 11-case file that predates this case, as `6 failed | 5 passed (11)` on this UTC+5:30 host
    // and `11 passed (11)` under `TZ=UTC`, which is what an unpinned CI runner executes. The pin is the guard; this case is the guard
    // on the guard, so removing the pin fails here by name instead of quietly restoring five
    // inert assertions.
    //
    // Read out of `vitest.config.mjs` at runtime rather than compared against a literal, the
    // same shape `U50` uses for `testTimeout`: the claim is about the zone the runner *applies*,
    // not about a string copied into a test.
    const configModule: unknown = await import(VITEST_CONFIG_URL);
    const configuredTimeZone = readConfiguredTimeZone(configModule);

    // 1. The config declares a zone, and it is not UTC.
    expect(configuredTimeZone).not.toBe(UTC_TIME_ZONE);
    // 2. The runner actually applied it. Measured when this was written: the pin wins over an
    //    ambient `TZ` too -- `TZ=UTC pnpm --filter @telemetry/worker-service exec vitest run`
    //    still reported `process.env.TZ = "Asia/Kathmandu"` and offset `-345`.
    expect(process.env.TZ).toBe(configuredTimeZone);
    // 3. And the applied zone really moves `Date`. This is the property `J1`-`J5` depend on;
    //    (1) and (2) alone would pass against a zone string the ICU data does not know, which
    //    Node resolves to UTC rather than throwing.
    expect(new Date(SAMPLE_LOCAL_MIDNIGHT.YEAR, SAMPLE_LOCAL_MIDNIGHT.MONTH_INDEX,
      SAMPLE_LOCAL_MIDNIGHT.DAY).getTimezoneOffset()).not.toBe(UTC_OFFSET_MINUTES);

    // **Not asserted, deliberately.** `vitest.config.mjs` argues for a *sub-hour* offset
    // (+05:45) so that an hour-granularity or half-hour-granularity error is also caught. No
    // mutation in this suite demonstrates that class, so pinning `offset % 60 !== 0` here would
    // be a universal with no mutation behind it (`.claude/rules/review-standards.md`). The
    // zone choice is recorded in the config; this case asserts only the property `J1`-`J5`
    // actually rest on, which is that the offset is not zero.
  });
});

describe("runInvoiceGenerationJob", () => {
  it("J6 - calls billing once per enumerated tenant, with the resolved window", async () => {
    const harness = buildHarness([TENANT_A, TENANT_B]);
    const now = new Date("2026-03-11T02:00:00.000Z");

    const summary = await runInvoiceGenerationJob(harness.deps, now);

    expect(harness.listTenants).toHaveBeenCalledWith(
      "2026-03-10T00:00:00.000Z",
      "2026-03-11T00:00:00.000Z"
    );
    expect(callForTenant(harness.generateInvoice, TENANT_A)).toEqual([
      TENANT_A,
      "2026-03-10T00:00:00.000Z",
      "2026-03-11T00:00:00.000Z"
    ]);
    expect(callForTenant(harness.generateInvoice, TENANT_B)).toBeDefined();
    expect(summary).toMatchObject({
      tenants: INTEGRATION_COUNTS.PAIR,
      succeeded: INTEGRATION_COUNTS.PAIR,
      failed: INTEGRATION_COUNTS.NONE
    });
  });

  it("J7 - one tenant's failure does not stop the others", async () => {
    const failure = new Error("billing unavailable");
    const harness = buildHarness([TENANT_A, TENANT_B, TENANT_C], (tenantId) =>
      tenantId === TENANT_B
        ? Promise.reject(failure)
        : Promise.resolve({ created: true, invoiceId: "inv" })
    );

    const summary = await runInvoiceGenerationJob(harness.deps, new Date("2026-03-11T02:00:00.000Z"));

    // The first *and* the third, located by a helper that throws when the call is absent. A
    // `Promise.all` implementation would reject on B and never call C, and an implementation
    // that broke out of the loop would do the same -- both are the silently-skipped-tenant
    // failure in §1, and both fail here.
    expect(callForTenant(harness.generateInvoice, TENANT_A)).toBeDefined();
    expect(callForTenant(harness.generateInvoice, TENANT_C)).toBeDefined();
    expect(summary.failed).toBe(INTEGRATION_COUNTS.SINGLE);
    expect(summary.succeeded).toBe(INTEGRATION_COUNTS.PAIR);
  });

  it("J8 - resolves when a tenant fails, but rejects when the enumeration fails", async () => {
    const perTenant = buildHarness([TENANT_A], () => Promise.reject(new Error("nope")));

    // Resolving on a per-tenant failure is deliberate (D5): a BullMQ retry of the whole job
    // would re-call every tenant that already succeeded. That is safe, because the endpoint is
    // idempotent, but it is noise and it would mask a persistently failing tenant behind
    // repeated whole-job retries. The failed tenant is recovered by the next night's run, which
    // still sees its usage unbilled.
    await expect(
      runInvoiceGenerationJob(perTenant.deps, new Date("2026-03-11T02:00:00.000Z"))
    ).resolves.toMatchObject({ failed: INTEGRATION_COUNTS.SINGLE });

    // Rejecting when the *enumeration* fails is equally deliberate, and is the more important
    // half: the job does not know whom it skipped, so reporting success would be a lie that
    // costs revenue silently. This is the one condition under which a BullMQ retry is wanted.
    const enumerationFailure = new Error("connection terminated");
    const broken = buildHarness(enumerationFailure);
    await expect(
      runInvoiceGenerationJob(broken.deps, new Date("2026-03-11T02:00:00.000Z"))
    ).rejects.toBe(enumerationFailure);
    expect(broken.generateInvoice).not.toHaveBeenCalled();
  });

  it("J9 - logs one line per tenant carrying the tenant id, and never the response body", async () => {
    const harness = buildHarness([TENANT_A, TENANT_B], (tenantId) =>
      tenantId === TENANT_B
        ? Promise.reject(new Error("billing unavailable"))
        : Promise.resolve({ created: true, invoiceId: "inv-secret-value" })
    );

    await runInvoiceGenerationJob(harness.deps, new Date("2026-03-11T02:00:00.000Z"));

    const infoCalls = (harness.logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const errorCalls = (harness.logger.error as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const succeededLine = infoCalls.find(
      (args) => args[1] === WORKER_INVOICE_JOB.LOG.TENANT_SUCCEEDED
    );
    const failedLine = errorCalls.find((args) => args[1] === WORKER_INVOICE_JOB.LOG.TENANT_FAILED);

    // Located by message, and asserted to exist: a job that logged nothing per tenant would
    // otherwise pass every `toContain` below against `undefined`.
    expect(succeededLine, "no per-tenant success line was logged").toBeDefined();
    expect(failedLine, "no per-tenant failure line was logged").toBeDefined();
    expect(succeededLine?.[0]).toMatchObject({ tenantId: TENANT_A });
    expect(failedLine?.[0]).toMatchObject({ tenantId: TENANT_B });

    // Never the response body -- the same rule `EventProcessorService` follows. Scanned across
    // every level rather than one call's shape, so a body logged at `debug` would still fail.
    const everything = JSON.stringify([
      ...infoCalls,
      ...errorCalls,
      ...(harness.logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls,
      ...(harness.logger.debug as unknown as ReturnType<typeof vi.fn>).mock.calls
    ]);
    expect(everything).not.toContain("inv-secret-value");
  });

  it("J10 - an empty tenant list is a normal night, not a failure", async () => {
    const harness = buildHarness([]);

    const summary = await runInvoiceGenerationJob(
      harness.deps,
      new Date("2026-03-11T02:00:00.000Z")
    );

    expect(summary).toMatchObject({
      tenants: INTEGRATION_COUNTS.NONE,
      succeeded: INTEGRATION_COUNTS.NONE,
      failed: INTEGRATION_COUNTS.NONE
    });
    expect(harness.generateInvoice).not.toHaveBeenCalled();
  });

  it("J11 - calls billing sequentially, not concurrently", async () => {
    // Sequential is a decision, not an accident (D5): `Promise.all` rejects the whole batch on
    // the first failure -- which `J7` already forbids -- and also removes any bound on the
    // concurrent load this job puts on billing-service. Asserted by observing that no second
    // call starts before the first settles.
    let inFlight = 0;
    let maxInFlight = 0;
    const harness = buildHarness([TENANT_A, TENANT_B, TENANT_C], async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;

      return { created: true, invoiceId: "inv" };
    });

    await runInvoiceGenerationJob(harness.deps, new Date("2026-03-11T02:00:00.000Z"));

    expect(maxInFlight).toBe(INTEGRATION_COUNTS.SINGLE);
  });
});
