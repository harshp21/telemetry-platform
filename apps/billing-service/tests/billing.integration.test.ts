import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InvoiceStatus, Prisma, PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { buildBillingServiceApp } from "../src/app";
import { env } from "../src/config/env";
import { BillingService } from "../src/services/billing.service";
import { InvoiceRepository } from "../src/repositories/invoice.repository";
import { MeterRepository } from "../src/repositories/meter.repository";
import { UsageLinesChangedError } from "../src/errors";
import {
  BILLING_HEADERS,
  BILLING_INVOICE_LIST,
  BILLING_METERING,
  BILLING_RESPONSES,
  BILLING_ROUTES
} from "../src/constants";
import { BillingFixtures } from "./integration.fixtures";
import {
  INTEGRATION_APP_DATABASE_URL_FALLBACK,
  INTEGRATION_DATABASE_ROLE,
  INTEGRATION_FIXTURE,
  INTEGRATION_ID_PREFIX,
  INTEGRATION_INVOICE_LIST,
  INTEGRATION_LATE_USAGE,
  INTEGRATION_SESSION_TIME_ZONE,
  INTEGRATION_TENANT
} from "./integration.constants";

/**
 * End-to-end invoice generation against live PostgreSQL.
 *
 * Seeded through `DIRECT_DATABASE_URL` (the owner) and asserted through `DATABASE_URL`
 * (`telemetry_app`, `NOSUPERUSER NOBYPASSRLS`), so RLS is enforcing for everything the service
 * does -- `.claude/rules/tenant-isolation.md` requires that a passing RLS test not be seeded by
 * the connection it is testing. The role is asserted, not assumed (BI0).
 *
 * Fixtures are torn down in **both** `afterEach` and `afterAll`, under a stable collectable
 * prefix. S-20 is the worked example of what `beforeEach`-only cleanup plus a run-unique filter
 * costs: residue that no later run can ever collect. Billing starts clean rather than
 * inheriting that.
 */
const TENANT_A = INTEGRATION_TENANT.A as TenantId;
const TENANT_B = INTEGRATION_TENANT.B as TenantId;
const SUITE_TENANT_IDS = [TENANT_A, TENANT_B] as const;

const appDatabaseUrl = (): string =>
  process.env.DATABASE_URL ?? INTEGRATION_APP_DATABASE_URL_FALLBACK;

/**
 * Appends a session-zone pin to a connection URL. `options=-c timezone=…` is the spelling
 * measured to work at Prisma 6.19.3; a bare `?timezone=…` is accepted and silently ignored.
 */
const withSessionTimeZone = (url: string, timeZone: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set(
    "options",
    `${INTEGRATION_SESSION_TIME_ZONE.OPTION_PREFIX}${timeZone}`
  );
  return parsed.toString();
};

const fixtures = new BillingFixtures();
let app: ReturnType<typeof buildBillingServiceApp>;

const generate = async (
  body: Record<string, unknown>,
  headers: Record<string, string> = {
    [BILLING_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET
  }
) =>
  app.inject({
    method: "POST",
    url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
    headers,
    payload: body
  });

/**
 * Normalises a Decimal-valued column or a fixture literal to one canonical string.
 *
 * Needed because the two spellings differ for the same value: a meter seeded as `"0.010000"`
 * comes back through the repository's `String(...)` normaliser as `"0.01"` -- trailing zeros
 * dropped, which is D8's shipped convention, not a rounding. Comparing the spellings would
 * fail on a correct result; comparing `Prisma.Decimal` values is exact and compares what the
 * assertion is actually about.
 */
const asDecimalString = (value: unknown): string =>
  new Prisma.Decimal(String(value)).toString();

const periodBody = (tenantId: string) => ({
  tenantId,
  periodStart: INTEGRATION_FIXTURE.PERIOD_START,
  periodEnd: INTEGRATION_FIXTURE.PERIOD_END
});

/** The two-metric fixture BI1, BI2, BI7 and BI9 share. */
const seedTwoMetricPeriod = async (): Promise<void> => {
  await fixtures.seedTenants(SUITE_TENANT_IDS);
  await fixtures.seedMeters([
    {
      tenantId: TENANT_A,
      metricKey: INTEGRATION_FIXTURE.METRIC_API,
      unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_API
    },
    {
      tenantId: TENANT_A,
      metricKey: INTEGRATION_FIXTURE.METRIC_STORAGE,
      unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_STORAGE
    }
  ]);
  await fixtures.seedUsageLines([
    {
      tenantId: TENANT_A,
      metricKey: INTEGRATION_FIXTURE.METRIC_API,
      quantity: INTEGRATION_FIXTURE.QUANTITY_API,
      periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_EARLY
    },
    {
      tenantId: TENANT_A,
      metricKey: INTEGRATION_FIXTURE.METRIC_STORAGE,
      quantity: INTEGRATION_FIXTURE.QUANTITY_STORAGE,
      periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_LATE
    }
  ]);
};

/**
 * File-level lifecycle, shared by every `describe` below.
 *
 * Hoisted out of the T-045 block by T-046 so the two suites share one app instance and one
 * owner connection: a per-`describe` `afterAll` would close the app and disconnect the fixture
 * client before the next block ran. The reset semantics are unchanged -- still `beforeEach`
 * *and* `afterEach` *and* `afterAll`, still scoped to this run's fixed tenant ids.
 *
 * Both halves matter: `beforeEach`-only cleanup leaves the last test's rows behind for good
 * (S-20 is the worked example), and a run-unique filter could never collect them.
 */
beforeAll(async () => {
  await fixtures.assertSchemaReady();
  app = buildBillingServiceApp();
});

beforeEach(async () => {
  await fixtures.reset(SUITE_TENANT_IDS);
});

afterEach(async () => {
  await fixtures.reset(SUITE_TENANT_IDS);
});

afterAll(async () => {
  await fixtures.reset(SUITE_TENANT_IDS);
  await fixtures.assertRunStateEmpty(SUITE_TENANT_IDS);
  await app.close();
  await fixtures.disconnect();
});

describe("POST /v1/internal/billing/generate (integration)", () => {
  it("BI0 - the service connection is the least-privilege role, so RLS is enforcing", async () => {
    const rows = await app.container.prisma.$queryRaw<
      { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`;

    expect(rows[0]?.current_user).toBe(INTEGRATION_DATABASE_ROLE.APP);
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it("BI1 - prices unbilled usage, writes a DRAFT invoice with one line per metric, and marks the lines billed", async () => {
    await seedTwoMetricPeriod();

    const response = await generate(periodBody(TENANT_A));

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_CREATED);
    const invoiceId = (response.json() as { data: { invoiceId: string } }).data.invoiceId;
    expect(invoiceId).toEqual(expect.any(String));

    const invoices = await fixtures.readInvoices(SUITE_TENANT_IDS);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.id).toBe(invoiceId);
    expect(invoices[0]?.tenantId).toBe(TENANT_A);
    expect(invoices[0]?.status).toBe(BILLING_METERING.INVOICE_STATUS_DRAFT);
    expect(invoices[0]?.currency).toBe(INTEGRATION_FIXTURE.CURRENCY_USD);
    expect(String(invoices[0]?.totalAmount)).toBe(INTEGRATION_FIXTURE.EXPECTED_TOTAL);

    const lineItems = await fixtures.readLineItems(SUITE_TENANT_IDS);
    expect(lineItems).toHaveLength(2);
    expect(lineItems.map((item) => item.metricKey)).toEqual([
      INTEGRATION_FIXTURE.METRIC_API,
      INTEGRATION_FIXTURE.METRIC_STORAGE
    ]);
    expect(lineItems.every((item) => item.invoiceId === invoiceId)).toBe(true);
    expect(String(lineItems[0]?.amount)).toBe(INTEGRATION_FIXTURE.EXPECTED_AMOUNT_API);
    expect(String(lineItems[1]?.amount)).toBe(INTEGRATION_FIXTURE.EXPECTED_AMOUNT_STORAGE);

    const usageLines = await fixtures.readUsageLines(SUITE_TENANT_IDS);
    expect(usageLines).toHaveLength(2);
    expect(usageLines.every((line) => line.billed)).toBe(true);
  });

  it("BI1b - considers only unbilled lines inside the half-open [periodStart, periodEnd) window", async () => {
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    await fixtures.seedMeters([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_API
      }
    ]);
    await fixtures.seedUsageLines([
      // In window, unbilled -- the only line that should be priced.
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        quantity: INTEGRATION_FIXTURE.QUANTITY_API,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_EARLY
      },
      // In window but already billed.
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        quantity: INTEGRATION_FIXTURE.QUANTITY_API,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_LATE,
        billed: true
      },
      // Exactly at the exclusive upper bound: a closed bound would let this instant fall into
      // two consecutive invoices, arbitrated only by whichever ran first.
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        quantity: INTEGRATION_FIXTURE.QUANTITY_API,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_AT_PERIOD_END
      },
      // Before the inclusive lower bound.
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        quantity: INTEGRATION_FIXTURE.QUANTITY_API,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_BEFORE_PERIOD
      }
    ]);

    const response = await generate(periodBody(TENANT_A));

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_CREATED);
    const invoices = await fixtures.readInvoices(SUITE_TENANT_IDS);
    expect(String(invoices[0]?.totalAmount)).toBe(INTEGRATION_FIXTURE.EXPECTED_AMOUNT_API);

    const lines = await fixtures.readUsageLines(SUITE_TENANT_IDS);
    const billedInstants = lines.filter((line) => line.billed);
    // Two: the one just priced, and the one seeded already billed. The boundary line and the
    // pre-period line must still be unbilled.
    expect(billedInstants).toHaveLength(2);
    expect(lines.filter((line) => !line.billed)).toHaveLength(2);
  });

  it("BI2 - a second call returns the same invoice id with 200 and creates no duplicate", async () => {
    await seedTwoMetricPeriod();

    const first = await generate(periodBody(TENANT_A));
    const second = await generate(periodBody(TENANT_A));

    expect(first.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_CREATED);
    expect(second.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(second.json()).toEqual(first.json());
    expect(await fixtures.readInvoices(SUITE_TENANT_IDS)).toHaveLength(1);
    expect(await fixtures.readLineItems(SUITE_TENANT_IDS)).toHaveLength(2);
  });

  it("BI3 - no usage answers 200 with a null invoice id and writes nothing", async () => {
    await fixtures.seedTenants(SUITE_TENANT_IDS);

    const response = await generate(periodBody(TENANT_A));

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    // `absorbed: false` added at S-45: nothing existed to absorb into, which is a different
    // outcome from an absorption that added nothing, and both are `200`.
    expect(response.json()).toEqual({ data: { invoiceId: null, absorbed: false } });
    expect(await fixtures.readInvoices(SUITE_TENANT_IDS)).toHaveLength(0);
  });

  it("BI3b - an unknown tenant answers 404 TENANT_NOT_FOUND and writes nothing", async () => {
    const response = await generate(periodBody(TENANT_A));

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_NOT_FOUND);
    expect(response.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_TENANT_NOT_FOUND });
    expect(await fixtures.readInvoices(SUITE_TENANT_IDS)).toHaveLength(0);
  });

  it("BI4 - a metric with usage but no meter refuses the whole request and bills nothing", async () => {
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    await fixtures.seedMeters([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_API
      }
    ]);
    await fixtures.seedUsageLines([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        quantity: INTEGRATION_FIXTURE.QUANTITY_API,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_EARLY
      },
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_UNMETERED,
        quantity: INTEGRATION_FIXTURE.QUANTITY_STORAGE,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_LATE
      }
    ]);

    const response = await generate(periodBody(TENANT_A));

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNPROCESSABLE_ENTITY);
    const body = response.json() as { code: string; message: string };
    expect(body.code).toBe(BILLING_RESPONSES.CODE_METER_NOT_FOUND);
    expect(body.message).toContain(INTEGRATION_FIXTURE.METRIC_UNMETERED);

    // The negative half is the point: the metered metric must not be invoiced on its own, and
    // no line may be marked billed. An invoice that silently omits a metric is money missing
    // from a document that looks complete.
    expect(await fixtures.readInvoices(SUITE_TENANT_IDS)).toHaveLength(0);
    expect(await fixtures.readLineItems(SUITE_TENANT_IDS)).toHaveLength(0);
    const lines = await fixtures.readUsageLines(SUITE_TENANT_IDS);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => !line.billed)).toBe(true);
  });

  it("BI5 - meters disagreeing on currency refuse the request and write nothing", async () => {
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    await fixtures.seedMeters([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_API,
        currency: INTEGRATION_FIXTURE.CURRENCY_USD
      },
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_STORAGE,
        unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_STORAGE,
        currency: INTEGRATION_FIXTURE.CURRENCY_EUR
      }
    ]);
    await fixtures.seedUsageLines([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        quantity: INTEGRATION_FIXTURE.QUANTITY_API,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_EARLY
      },
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_STORAGE,
        quantity: INTEGRATION_FIXTURE.QUANTITY_STORAGE,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_LATE
      }
    ]);

    const response = await generate(periodBody(TENANT_A));

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNPROCESSABLE_ENTITY);
    expect(response.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_METER_CURRENCY_CONFLICT
    });
    expect(await fixtures.readInvoices(SUITE_TENANT_IDS)).toHaveLength(0);
    const lines = await fixtures.readUsageLines(SUITE_TENANT_IDS);
    expect(lines.every((line) => !line.billed)).toBe(true);
  });

  it("BI6 - a missing and a wrong internal secret are both 401 with identical bodies", async () => {
    await seedTwoMetricPeriod();

    const missing = await generate(periodBody(TENANT_A), {});
    const wrong = await generate(periodBody(TENANT_A), {
      [BILLING_HEADERS.INTERNAL_SECRET]: "not-the-secret"
    });

    expect(missing.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(wrong.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    // Deliberately indistinguishable: telling the two apart tells an unauthenticated caller
    // whether it even guessed the header name.
    expect(wrong.body).toBe(missing.body);
    expect(await fixtures.readInvoices(SUITE_TENANT_IDS)).toHaveLength(0);
  });

  it("BI7 - the period predicates resolve in UTC on a session pinned to a non-UTC zone", async () => {
    // The zone is pinned in this test's own connection string because CI's PostgreSQL is UTC,
    // where the correct bound and the session-dependent one return the same rows -- an
    // unpinned suite asserts nothing here. Measured at Gate 1 across four zones: the ORM
    // `findUnique` on the compound unique found its row in all four, while `$queryRaw`
    // equality with a bound JS `Date` found it in exactly one (UTC). So this case goes red on
    // a raw-SQL `findByPeriod` and green on the ORM one, *on this machine* -- the failure
    // signal lives on the developer's box, not in CI, which is the reverse of the usual
    // asymmetry. Do not "fix" a local failure here by pinning the session to UTC.
    await seedTwoMetricPeriod();

    const pinned = new PrismaClient({
      datasourceUrl: withSessionTimeZone(
        appDatabaseUrl(),
        INTEGRATION_SESSION_TIME_ZONE.AHEAD_OF_UTC
      )
    });

    try {
      const zone = await pinned.$queryRaw<
        { timeZone: string }[]
      >`SELECT current_setting('TimeZone') AS "timeZone"`;
      expect(zone[0]?.timeZone).toBe(INTEGRATION_SESSION_TIME_ZONE.AHEAD_OF_UTC);

      const service = new BillingService(
        (tenantId) => new MeterRepository(pinned, tenantId),
        (tenantId) => new InvoiceRepository(pinned, tenantId),
        app.container.logger
      );

      const first = await service.generateInvoice({
        tenantId: TENANT_A,
        periodStart: INTEGRATION_FIXTURE.PERIOD_START,
        periodEnd: INTEGRATION_FIXTURE.PERIOD_END
      });
      const second = await service.generateInvoice({
        tenantId: TENANT_A,
        periodStart: INTEGRATION_FIXTURE.PERIOD_START,
        periodEnd: INTEGRATION_FIXTURE.PERIOD_END
      });

      expect(first.created).toBe(true);
      expect(first.invoiceId).not.toBeNull();
      // The idempotent hit is what the existence check is for. Under a raw-SQL equality with a
      // bound Date this session misses the row, the second call falls through to the insert,
      // and the unique constraint turns it into a P2002 re-read -- so the *status* is what
      // moves, not just the row count.
      expect(second.created).toBe(false);
      expect(second.invoiceId).toBe(first.invoiceId);
      expect(await fixtures.readInvoices(SUITE_TENANT_IDS)).toHaveLength(1);
    } finally {
      await pinned.$disconnect();
    }
  });

  it("BI8 - fractional and high-precision quantities price exactly, and no Decimal escapes the repository", async () => {
    // Seeded through the owner connection because nothing on the platform's HTTP surface can
    // express these values: usage-service's ingest validator is `z.number().int().min(1).max(100)`
    // (S-17), so `0.5` and `1234567.123456` are both unreachable through ingestion.
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    await fixtures.seedMeters([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_PRECISE
      }
    ]);
    await fixtures.seedUsageLines([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        quantity: INTEGRATION_FIXTURE.QUANTITY_PRECISE,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_EARLY
      }
    ]);

    const unbilled = await new InvoiceRepository(
      app.container.prisma,
      TENANT_A
    ).sumUnbilledByMetricKey(
      new Date(INTEGRATION_FIXTURE.PERIOD_START),
      new Date(INTEGRATION_FIXTURE.PERIOD_END)
    );

    // `JSON.stringify` of a `Prisma.Decimal` silently yields a string, so a leak would not look
    // wrong in a response body. The type has to be asserted, at the one layer that normalises.
    expect(typeof unbilled.totals[0]?.totalQuantity).toBe("string");
    expect(unbilled.totals[0]?.totalQuantity).toBe(INTEGRATION_FIXTURE.QUANTITY_PRECISE);

    const response = await generate(periodBody(TENANT_A));

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_CREATED);
    // The response envelope carries the invoice id and the `absorbed` flag and nothing else, so
    // there is no amount in it to leak -- asserted by exact key set rather than assumed,
    // because a future field would change that and a `toMatchObject` would not notice. The key
    // set is what S-45 widened, deliberately: `absorbed` is a boolean and carries no money.
    const body = response.json() as { data: { invoiceId: string; absorbed: boolean } };
    expect(Object.keys(body)).toEqual(["data"]);
    expect(Object.keys(body.data).sort()).toEqual(["absorbed", "invoiceId"]);
    expect(typeof body.data.invoiceId).toBe("string");
    expect(typeof body.data.absorbed).toBe("boolean");

    const invoices = await fixtures.readInvoices(SUITE_TENANT_IDS);
    // 1234567.123456 x 0.000001 = 1.234567123456, stored into Decimal(18,6) as 1.234567.
    // In IEEE-754 the product is 1.2345671234559998, which rounds to the same six places here
    // but is already wrong in the twelfth -- the column hides the drift, it does not prevent it.
    expect(String(invoices[0]?.totalAmount)).toBe(INTEGRATION_FIXTURE.EXPECTED_PRECISE_AMOUNT);
    const lineItems = await fixtures.readLineItems(SUITE_TENANT_IDS);
    expect(String(lineItems[0]?.quantity)).toBe(INTEGRATION_FIXTURE.QUANTITY_PRECISE);
    expect(String(lineItems[0]?.unitPrice)).toBe(INTEGRATION_FIXTURE.UNIT_PRICE_PRECISE);
  });

  it("BI13 - prices against the meter in force at periodStart, not a superseded, future or expired one", async () => {
    // Meter selection decides what a customer is charged, and until now only unit `where`-shape
    // assertions stood behind it. This case asserts the *priced result* instead, so it proves
    // the database agrees with the predicate rather than restating it.
    //
    // The window is half-open `[activeFrom, activeTo)` -- `activeFrom` inclusive, `activeTo`
    // exclusive. The plan writes the predicate but never names that asymmetry in words, so it
    // is stated here: it is what makes consecutive rate cards tile. `api.request`'s superseded
    // meter ends at exactly the instant the current one begins, and exactly one of them is in
    // force at that instant, by construction rather than by tie-break.
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    await fixtures.seedMeters([
      // api.request -- the rate change lands exactly on periodStart.
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.METER_SUPERSEDED_UNIT_PRICE,
        activeFrom: INTEGRATION_FIXTURE.METER_ACTIVE_FROM,
        // Expires at the exclusive edge: `activeTo > asOf` is false at asOf === periodStart.
        activeTo: INTEGRATION_FIXTURE.PERIOD_START
      },
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_API,
        // Begins at the inclusive edge: `activeFrom <= asOf` is true at asOf === periodStart.
        activeFrom: INTEGRATION_FIXTURE.PERIOD_START,
        activeTo: null
      },
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.METER_FUTURE_UNIT_PRICE,
        // Inside the billing period but after periodStart: selection is as-of the period's
        // start, so a mid-period rate change does not apply to that period.
        activeFrom: INTEGRATION_FIXTURE.METER_FUTURE_ACTIVE_FROM,
        activeTo: null
      },
      // storage.gb -- an expired meter with a LATER activeFrom than the correct one, which is
      // the only shape that can outrank it in `orderBy activeFrom desc`.
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_STORAGE,
        unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_STORAGE,
        activeFrom: INTEGRATION_FIXTURE.METER_ACTIVE_FROM,
        activeTo: null
      },
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_STORAGE,
        unitPrice: INTEGRATION_FIXTURE.METER_EXPIRED_PROMO_UNIT_PRICE,
        activeFrom: INTEGRATION_FIXTURE.METER_PROMO_ACTIVE_FROM,
        activeTo: INTEGRATION_FIXTURE.METER_PROMO_ACTIVE_TO
      }
    ]);
    await fixtures.seedUsageLines([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        quantity: INTEGRATION_FIXTURE.QUANTITY_API,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_EARLY
      },
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_STORAGE,
        quantity: INTEGRATION_FIXTURE.QUANTITY_STORAGE,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_LATE
      }
    ]);

    const response = await generate(periodBody(TENANT_A));

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_CREATED);

    // The unit price on each line names which meter was chosen -- the assertion that would pass
    // on a total alone is not enough, because two wrong picks could sum to the right number.
    const lineItems = await fixtures.readLineItems(SUITE_TENANT_IDS);
    expect(lineItems).toHaveLength(2);
    expect(asDecimalString(lineItems[0]?.unitPrice)).toBe(
      asDecimalString(INTEGRATION_FIXTURE.UNIT_PRICE_API)
    );
    expect(asDecimalString(lineItems[1]?.unitPrice)).toBe(
      asDecimalString(INTEGRATION_FIXTURE.UNIT_PRICE_STORAGE)
    );
    expect(String(lineItems[0]?.amount)).toBe(INTEGRATION_FIXTURE.EXPECTED_AMOUNT_API);
    expect(String(lineItems[1]?.amount)).toBe(INTEGRATION_FIXTURE.EXPECTED_AMOUNT_STORAGE);

    // Named negatively too, so a future reader sees which rates were on the table and rejected.
    const pricedRates = lineItems.map((item) => asDecimalString(item.unitPrice));
    expect(pricedRates).not.toContain(
      asDecimalString(INTEGRATION_FIXTURE.METER_SUPERSEDED_UNIT_PRICE)
    );
    expect(pricedRates).not.toContain(
      asDecimalString(INTEGRATION_FIXTURE.METER_FUTURE_UNIT_PRICE)
    );
    expect(pricedRates).not.toContain(
      asDecimalString(INTEGRATION_FIXTURE.METER_EXPIRED_PROMO_UNIT_PRICE)
    );

    const invoices = await fixtures.readInvoices(SUITE_TENANT_IDS);
    expect(String(invoices[0]?.totalAmount)).toBe(INTEGRATION_FIXTURE.EXPECTED_TOTAL);
  });

  it("BI9 - S-10 marker: a second tenant's context hides the Invoice but not its InvoiceLineItem", async () => {
    await seedTwoMetricPeriod();
    const response = await generate(periodBody(TENANT_A));
    const invoiceId = (response.json() as { data: { invoiceId: string } }).data.invoiceId;

    const rows = await app.container.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${TENANT_B}, true)`;
      const invoices = await tx.$queryRaw<
        { count: bigint }[]
      >`SELECT COUNT(*) AS count FROM "Invoice" WHERE "id" = ${invoiceId}`;
      const lineItems = await tx.$queryRaw<
        { count: bigint }[]
      >`SELECT COUNT(*) AS count FROM "InvoiceLineItem" WHERE "invoiceId" = ${invoiceId}`;
      return { invoices: Number(invoices[0]?.count ?? 0), lineItems: Number(lineItems[0]?.count ?? 0) };
    });

    // This asserts the gap **as it is today**, not the behaviour we want. `"InvoiceLineItem"`
    // has `relrowsecurity = f` with no policy and no `tenantId` column of its own (S-10), so
    // its only tenant control is the application-layer join through `"Invoice"` -- which is why
    // `InvoiceRepository` exposes no method taking a bare `invoiceId`, and why line items are
    // written only through the nested create. T-045 ships the platform's first rows into that
    // table. When S-10 is fixed this expectation goes red -- the line-item count under the
    // other tenant becomes 0: change it deliberately, and delete this comment with it.
    const actualLineItems = await fixtures.readLineItems(SUITE_TENANT_IDS);
    expect(actualLineItems.length).toBeGreaterThan(0);
    expect(rows.invoices).toBe(0);
    expect(rows.lineItems).toBe(actualLineItems.length);
  });

  it("BI11 - invoices a period whose billed update spans several chunks", async () => {
    // The chunking's end-to-end proof, against real rows. One past twice the chunk, so the
    // update issues three statements and the last is partial. Unchunked this case still passes
    // -- 2 001 ids is well under the 32 764 bind ceiling -- so it is the *success* half of the
    // fix, and BI12 is the half that fails without it.
    const lineCount = BILLING_METERING.BILLED_UPDATE_CHUNK_SIZE * 2 + 1;
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    await fixtures.seedMeters([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.BULK_UNIT_PRICE
      }
    ]);
    await fixtures.seedBulkUsageLines(
      TENANT_A,
      INTEGRATION_FIXTURE.METRIC_API,
      INTEGRATION_FIXTURE.BULK_QUANTITY,
      INTEGRATION_FIXTURE.USAGE_INSTANT_EARLY,
      lineCount
    );

    const response = await generate(periodBody(TENANT_A));

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_CREATED);
    const invoices = await fixtures.readInvoices(SUITE_TENANT_IDS);
    expect(invoices).toHaveLength(1);
    // 2001 x 0.001 = 2.001, exact at Decimal(18,6).
    expect(String(invoices[0]?.totalAmount)).toBe("2.001");

    // Every line billed, none missed at a chunk boundary -- which is the failure a chunking bug
    // would actually produce, and it would otherwise be invisible in the total.
    expect(await fixtures.countUsageLines(SUITE_TENANT_IDS, true)).toBe(lineCount);
    expect(await fixtures.countUsageLines(SUITE_TENANT_IDS, false)).toBe(0);
  });

  it("BI12 - drives one id past the measured bind ceiling without raising P2035", async () => {
    // 32 765 ids: unchunked this raises `P2035` ("too many bind variables … maximum of 32767"),
    // which is not `P2002`, so it re-throws to an opaque 500 that no retry can clear. Chunked,
    // the statement never approaches the ceiling and the call reaches the count assertion
    // instead -- a `UsageLinesChangedError`, because only the seeded ids exist.
    //
    // Deliberately not seeding 32 765 real rows: the bind count is per *parameter*, not per
    // matched row, so a mostly-non-existent id list exercises the identical limit at a fraction
    // of the cost. What this case cannot show is a *successful* invoice above the old ceiling;
    // BI11 covers multi-chunk success, at a size that is affordable to seed.
    await seedTwoMetricPeriod();
    const repository = new InvoiceRepository(app.container.prisma, TENANT_A);
    const unbilled = await repository.sumUnbilledByMetricKey(
      new Date(INTEGRATION_FIXTURE.PERIOD_START),
      new Date(INTEGRATION_FIXTURE.PERIOD_END)
    );
    const paddedIds = [
      ...unbilled.usageLineIds,
      ...Array.from(
        { length: INTEGRATION_FIXTURE.IDS_ONE_PAST_BIND_CEILING - unbilled.usageLineIds.length },
        (_, i) => `${INTEGRATION_ID_PREFIX}absent-${i}`
      )
    ];
    expect(paddedIds).toHaveLength(INTEGRATION_FIXTURE.IDS_ONE_PAST_BIND_CEILING);

    const error = await repository
      .createDraftInvoice({
        periodStart: new Date(INTEGRATION_FIXTURE.PERIOD_START),
        periodEnd: new Date(INTEGRATION_FIXTURE.PERIOD_END),
        currency: INTEGRATION_FIXTURE.CURRENCY_USD,
        totalAmount: INTEGRATION_FIXTURE.EXPECTED_TOTAL,
        lineItems: unbilled.totals.map((total) => ({
          metricKey: total.metricKey,
          quantity: total.totalQuantity,
          unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_API,
          amount: INTEGRATION_FIXTURE.EXPECTED_AMOUNT_API
        })),
        usageLineIds: paddedIds
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UsageLinesChangedError);
    expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as UsageLinesChangedError).expected).toBe(
      INTEGRATION_FIXTURE.IDS_ONE_PAST_BIND_CEILING
    );
    expect((error as UsageLinesChangedError).actual).toBe(unbilled.usageLineIds.length);
    // Rolled back: the transaction that got as far as the assertion wrote nothing.
    expect(await fixtures.readInvoices(SUITE_TENANT_IDS)).toHaveLength(0);
    expect(await fixtures.countUsageLines(SUITE_TENANT_IDS, true)).toBe(0);
  });

  /**
   * Locates one seeded usage line by id, throwing rather than passing vacuously when the row
   * is not there (`.claude/rules/testing.md`). A `find` that returns `undefined` would make
   * every assertion below it read `undefined` and quietly satisfy a `not.toBe(true)`.
   */
  const lineById = async (usageLineId: string) => {
    const row = (await fixtures.readUsageLines(SUITE_TENANT_IDS)).find(
      (line) => line.id === usageLineId
    );
    if (row === undefined) {
      throw new Error(`Expected usage line ${usageLineId} to exist`);
    }
    return row;
  };

  /** The one seeded invoice for a tenant, or a throw. Same reason as `lineById`. */
  const invoiceFor = async (tenantId: string) => {
    const row = (await fixtures.readInvoices(SUITE_TENANT_IDS)).find(
      (invoice) => invoice.tenantId === tenantId
    );
    if (row === undefined) {
      throw new Error(`Expected an invoice for tenant ${tenantId}`);
    }
    return row;
  };

  /** Seeds one late `api.request` row into the already-invoiced window. */
  const seedLateApiLine = async (
    tenantId: string,
    quantity: string = INTEGRATION_LATE_USAGE.LATE_QUANTITY_API,
    instant: string = INTEGRATION_LATE_USAGE.INSTANT
  ): Promise<string> => {
    const [id] = await fixtures.seedUsageLines([
      {
        tenantId,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        quantity,
        periodStart: instant
      }
    ]);
    if (id === undefined) {
      throw new Error("Expected the late usage line to be seeded");
    }
    return id;
  };

  it("BI22 - usage landing after the period's invoice exists is absorbed into that invoice", async () => {
    // **The S-45 case.** The shipped ordering returns at `findByPeriod` before
    // `sumUnbilledByMetricKey` runs, so a row that arrives in a window whose invoice already
    // exists is never enumerated again: it stays `billed = false` for good, the nightly job
    // reads a different window the next night, and every observable an operator has says the
    // run succeeded.
    //
    // **Four things that would make this case vacuous, all measured at Gate 1 as identical with
    // and without the defect**: the status (`200` either way), the returned `invoiceId` (the
    // same id either way), the job summary, and the invoice *count*. The load-bearing
    // assertions are therefore `UsageLine.billed` and `Invoice.totalAmount`, read back from the
    // database through the owner connection.
    await seedTwoMetricPeriod();

    const first = await generate(periodBody(TENANT_A));
    expect(first.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_CREATED);
    const invoiceId = (first.json() as { data: { invoiceId: string } }).data.invoiceId;

    // **The fixture order is forced.** Seeding this row before the first call would let that
    // call bill it, and the ordering under test would never run (plan section 4.1).
    const lateLineId = await seedLateApiLine(TENANT_A);
    expect((await lineById(lateLineId)).billed).toBe(false);

    const second = await generate(periodBody(TENANT_A));

    // **The two assertions the defect cannot satisfy, asserted first on purpose.** Against the
    // unfixed code these read `billed = false` and `12.5`; the `absorbed` flag below is new, so
    // it is red either way and would short-circuit the run before the money was ever checked.
    expect((await lineById(lateLineId)).billed).toBe(true);
    expect(asDecimalString((await invoiceFor(TENANT_A)).totalAmount)).toBe(
      asDecimalString(INTEGRATION_LATE_USAGE.EXPECTED_TOTAL_AFTER_ABSORB)
    );

    expect(second.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    const body = second.json() as { data: { invoiceId: string; absorbed: boolean } };
    expect(body.data.invoiceId).toBe(invoiceId);
    expect(body.data.absorbed).toBe(true);

    // Still one invoice: an absorption raises the existing document, it does not write a
    // supplementary one -- which the live unique index would refuse in any case (D1, probe A).
    expect(await fixtures.readInvoices(SUITE_TENANT_IDS)).toHaveLength(1);

    // Appended, never merged (D2): the late `api.request` tranche is its own row.
    const lineItems = await fixtures.readLineItems(SUITE_TENANT_IDS);
    expect(lineItems).toHaveLength(INTEGRATION_LATE_USAGE.EXPECTED_LINE_ITEMS_AFTER_ABSORB);
    expect(lineItems.every((item) => item.invoiceId === invoiceId)).toBe(true);
  });

  it("BI23 - a non-DRAFT invoice refuses the absorption with 409 INVOICE_IMMUTABLE and writes nothing", async () => {
    // The invoice is seeded `FINALIZED` **through the owner connection** because the platform
    // cannot produce that status: `createDraftInvoice` writes `DRAFT` and is the only statement
    // anywhere that sets `Invoice.status`. So until T-048 ships, this case is the only thing
    // standing behind the `INVOICE_IMMUTABLE` branch -- it is not redundant with a production
    // path, it is the production path's stand-in.
    //
    // The fixture is **not** passing on the status alone: deleting the DRAFT guard from
    // `absorbLateUsage` reddens this case as well as `BU100`, and nothing else -- measured
    // package-wide, 2 failed of 181. That is what makes the owner-connection seed load-bearing
    // rather than decoration. The red *set* is the durable half; the passed-count that used to
    // be written here went stale the moment `BI27` landed (S-33's shape), so re-run the
    // mutation rather than adjusting the numeral.
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    await fixtures.seedMeters([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_API
      }
    ]);
    await fixtures.seedInvoices([
      {
        tenantId: TENANT_A,
        periodStart: INTEGRATION_FIXTURE.PERIOD_START,
        periodEnd: INTEGRATION_FIXTURE.PERIOD_END,
        status: InvoiceStatus.FINALIZED,
        totalAmount: INTEGRATION_LATE_USAGE.FINALIZED_TOTAL
      }
    ]);
    const lateLineId = await seedLateApiLine(TENANT_A);

    const response = await generate(periodBody(TENANT_A));

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_CONFLICT);
    const body = response.json() as { code: string; message: string };
    expect(body.code).toBe(BILLING_RESPONSES.CODE_INVOICE_IMMUTABLE);
    // The status is named in the message rather than in a top-level field, because every error
    // this service emits is `{ code, message }` (plan divergence E1).
    expect(body.message).toContain(InvoiceStatus.FINALIZED);

    // Nothing written, all three halves: no line item, no change to the total, no billed flag.
    expect(await fixtures.readLineItems(SUITE_TENANT_IDS)).toHaveLength(0);
    expect(asDecimalString((await invoiceFor(TENANT_A)).totalAmount)).toBe(
      asDecimalString(INTEGRATION_LATE_USAGE.FINALIZED_TOTAL)
    );
    expect((await lineById(lateLineId)).billed).toBe(false);
  });

  it("BI24 - absorbing for one tenant leaves the other tenant's invoice, line items and late row untouched", async () => {
    // **The isolation case, and the fixture is deliberately the hard one**: *both* tenants hold
    // an invoice for the *same* period, and both have a late unbilled row. A shape where only
    // one tenant had an invoice could not distinguish a correct absorb from one that resolved
    // the invoice without a tenant predicate, because the wrong row would not exist.
    //
    // This matters here more than it would elsewhere: `"InvoiceLineItem"` has
    // `relrowsecurity = f`, zero policies and no `tenantId` column (S-10). Measured at Gate 1
    // as `telemetry_app` under another tenant's context, `UPDATE "Invoice"` matched 0 rows but
    // an `INSERT` into `"InvoiceLineItem"` against a foreign `invoiceId` **succeeded**. So the
    // application route -- no `invoiceId` parameter, compound-unique resolution, nested create
    // -- is the entire control on that write.
    //
    // **What this case does and does not guard, measured rather than assumed.** S-45's plan
    // predicted that giving `absorbLateUsage` an `invoiceId` parameter and addressing the line
    // items by it would redden this case. **It does not**, and two mutations were run at Gate 3
    // on this fixture to establish it:
    //
    // - *the parameter mutation* (add `invoiceId: string`, insert line items with
    //   `tx.invoiceLineItem.create({ data: { invoiceId: input.invoiceId, … } })`, service
    //   passes its own `existingInvoiceId`): **28 passed, 1 failed**, and the one failure was
    //   BI25, which calls the repository directly and no longer type-matched. BI24 green.
    // - *the tenant-predicate mutation* (resolve the invoice with
    //   `findFirst({ where: { periodStart, periodEnd } })` -- no tenant at all -- and address
    //   the line items by whatever it found): **29 passed, 0 failed**. BI24 green.
    //
    // The second one is the interesting result and the reason is the database, not the suite:
    // the read runs inside `withTenant`, and `"Invoice"` RLS **is** enabled, so an untenanted
    // predicate still only sees the bound tenant's row. Probed directly, two invoices sharing
    // one period: under tenant B's context an untenanted `findFirst` returned `…-inv-b` and an
    // untenanted `findMany` returned exactly `["…-inv-b"]`; with no tenant context at all the
    // same `findMany` returned `[]`. Belt and braces working as designed -- and it means no
    // behavioural case here can distinguish the application predicate from the RLS policy.
    //
    // So: **this case pins the outcome** (one tenant's absorption writes nothing of another
    // tenant's) and it is worth having. What it is *not* is a guard against reintroducing a
    // caller-supplied `invoiceId` -- but two named unit cases are, and both were measured
    // against the unit suite as well as this one: adding the parameter and addressing the line
    // items by it reddens `BU99`, adding it and addressing the *invoice* by it reddens `BU98`,
    // and this case stays green under both (integration 28/2 either way, the failures being
    // `BI25` and `BI27`, which call the repository directly). What no behavioural case catches
    // is the **tenant predicate**: removing it from the resolution entirely is 30/0 here, because
    // `"Invoice"` RLS answers identically. Recorded as S-46; same family as S-28, which records
    // a tenant predicate whose removal is green for a schema reason and is kept anyway.
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    await fixtures.seedMeters([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_API
      },
      {
        tenantId: TENANT_B,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_API
      }
    ]);
    await fixtures.seedUsageLines([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        quantity: INTEGRATION_FIXTURE.QUANTITY_API,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_EARLY
      },
      {
        tenantId: TENANT_B,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        quantity: INTEGRATION_LATE_USAGE.TENANT_B_QUANTITY_API,
        periodStart: INTEGRATION_FIXTURE.USAGE_INSTANT_EARLY
      }
    ]);

    // Both tenants invoice the same period, then both receive a late row.
    expect((await generate(periodBody(TENANT_A))).statusCode).toBe(
      BILLING_RESPONSES.HTTP_STATUS_CREATED
    );
    expect((await generate(periodBody(TENANT_B))).statusCode).toBe(
      BILLING_RESPONSES.HTTP_STATUS_CREATED
    );
    const lateForA = await seedLateApiLine(TENANT_A);
    const lateForB = await seedLateApiLine(TENANT_B);

    const invoiceA = await invoiceFor(TENANT_A);
    const invoiceB = await invoiceFor(TENANT_B);
    const lineItemsForA = (await fixtures.readLineItems(SUITE_TENANT_IDS)).filter(
      (item) => item.invoiceId === invoiceA.id
    );

    // Only tenant B absorbs.
    const response = await generate(periodBody(TENANT_B));
    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect((response.json() as { data: { absorbed: boolean } }).data.absorbed).toBe(true);

    // B's own side moved, so the case is not passing because nothing happened at all.
    expect(asDecimalString((await invoiceFor(TENANT_B)).totalAmount)).toBe(
      asDecimalString(INTEGRATION_LATE_USAGE.TENANT_B_EXPECTED_TOTAL_AFTER_ABSORB)
    );
    expect((await lineById(lateForB)).billed).toBe(true);

    // **A's side is untouched, in all three places an absorption writes.**
    expect(asDecimalString((await invoiceFor(TENANT_A)).totalAmount)).toBe(
      asDecimalString(INTEGRATION_FIXTURE.EXPECTED_AMOUNT_API)
    );
    const lineItemsForAAfter = (await fixtures.readLineItems(SUITE_TENANT_IDS)).filter(
      (item) => item.invoiceId === invoiceA.id
    );
    expect(lineItemsForAAfter).toHaveLength(lineItemsForA.length);
    expect((await lineById(lateForA)).billed).toBe(false);

    // And no line item of B's landed on A's invoice, nor the reverse -- the negative that a
    // count alone would not catch if one row moved each way.
    const allLineItems = await fixtures.readLineItems(SUITE_TENANT_IDS);
    expect(allLineItems.filter((item) => item.invoiceId === invoiceB.id)).toHaveLength(2);
    expect(new Set(allLineItems.map((item) => item.invoiceId))).toEqual(
      new Set([invoiceA.id, invoiceB.id])
    );
  });

  it("BI25 - Decimal(18,6) survives an absorption exactly, asserted below the HTTP boundary", async () => {
    // Asserted on the repository's **return value** and on the database row, never on a
    // response body: `Prisma.Decimal` defines `toJSON`, so a leaked Decimal serialises to the
    // right-looking string and a route-level assertion passes either way (the BU75/BI18
    // precedent). The response envelope carries no amount at all, so it could not catch this.
    //
    // The invoice is seeded at the full `Decimal(18,6)` width through the owner connection and
    // the absorbed delta is one unit in the last place.
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    await fixtures.seedMeters([
      {
        tenantId: TENANT_A,
        metricKey: INTEGRATION_FIXTURE.METRIC_API,
        unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_PRECISE
      }
    ]);
    await fixtures.seedInvoices([
      {
        tenantId: TENANT_A,
        periodStart: INTEGRATION_FIXTURE.PERIOD_START,
        periodEnd: INTEGRATION_FIXTURE.PERIOD_END,
        status: InvoiceStatus.DRAFT,
        totalAmount: INTEGRATION_LATE_USAGE.SEED_TOTAL_PRECISE
      }
    ]);
    const lateLineId = await seedLateApiLine(TENANT_A, INTEGRATION_FIXTURE.BULK_QUANTITY);

    const repository = new InvoiceRepository(app.container.prisma, TENANT_A);
    const result = await repository.absorbLateUsage({
      periodStart: new Date(INTEGRATION_FIXTURE.PERIOD_START),
      periodEnd: new Date(INTEGRATION_FIXTURE.PERIOD_END),
      totalAmountDelta: INTEGRATION_LATE_USAGE.EXPECTED_DELTA_PRECISE,
      lineItems: [
        {
          metricKey: INTEGRATION_FIXTURE.METRIC_API,
          quantity: INTEGRATION_FIXTURE.BULK_QUANTITY,
          unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_PRECISE,
          amount: INTEGRATION_LATE_USAGE.EXPECTED_DELTA_PRECISE
        }
      ],
      usageLineIds: [lateLineId]
    });

    // Below HTTP: the repository's own return value, typed and valued.
    expect(typeof result.totalAmount).toBe("string");
    expect(result.totalAmount).not.toBeInstanceOf(Prisma.Decimal);
    expect(asDecimalString(result.totalAmount)).toBe(
      asDecimalString(INTEGRATION_LATE_USAGE.EXPECTED_TOTAL_PRECISE_AFTER_ABSORB)
    );

    // And the persisted row, which is what the addition actually happened to. The arithmetic is
    // a SQL `numeric` addition on the column (`{ increment }`), not a read-modify-write.
    expect(asDecimalString((await invoiceFor(TENANT_A)).totalAmount)).toBe(
      asDecimalString(INTEGRATION_LATE_USAGE.EXPECTED_TOTAL_PRECISE_AFTER_ABSORB)
    );
    expect((await lineById(lateLineId)).billed).toBe(true);
  });

  it("BI26 - absorbing a metric the invoice already carries appends a second line item, never merging", async () => {
    // D2: append, never merge. Each absorption records one tranche, which is a faithful audit
    // trail -- and merging would need a read of a table with no index on `invoiceId` at all
    // (`"InvoiceLineItem"` has a primary-key index and nothing else, measured at Gate 1).
    //
    // **T-047 inherits this**: `GET /v1/billing/invoices/:id` is the first thing on the platform
    // to return line items, and it has to decide whether two tranches of one `metricKey` render
    // as two lines or are grouped for display.
    await seedTwoMetricPeriod();
    await generate(periodBody(TENANT_A));
    await seedLateApiLine(TENANT_A);

    const response = await generate(periodBody(TENANT_A));
    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);

    const lineItems = await fixtures.readLineItems(SUITE_TENANT_IDS);
    const apiLines = lineItems.filter(
      (item) => item.metricKey === INTEGRATION_FIXTURE.METRIC_API
    );
    expect(apiLines).toHaveLength(2);
    // Two tranches, same rate, different quantities -- not one row rewritten.
    expect(apiLines.map((item) => asDecimalString(item.quantity)).sort()).toEqual(
      [
        asDecimalString(INTEGRATION_FIXTURE.QUANTITY_API),
        asDecimalString(INTEGRATION_LATE_USAGE.LATE_QUANTITY_API)
      ].sort()
    );
    for (const item of apiLines) {
      expect(asDecimalString(item.unitPrice)).toBe(
        asDecimalString(INTEGRATION_FIXTURE.UNIT_PRICE_API)
      );
    }

    // The line amounts sum to the invoice total, which is what makes the appended row an
    // accounting record rather than a duplicate.
    const summed = lineItems.reduce(
      (running, item) => running.add(new Prisma.Decimal(String(item.amount))),
      new Prisma.Decimal(0)
    );
    expect(summed.toString()).toBe(
      asDecimalString(INTEGRATION_LATE_USAGE.EXPECTED_TOTAL_AFTER_ABSORB)
    );
    expect(asDecimalString((await invoiceFor(TENANT_A)).totalAmount)).toBe(summed.toString());
  });

  it("BI27 - a mid-absorb failure rolls back the increment, the appended line items and the billed flags", async () => {
    // **AC2's money invariant, against a real transaction.** Steps 3 and 4 of `absorbLateUsage`
    // both write: the `update` raises the total and nests the line-item `create`, then
    // `markUsageLinesBilled` flags the rows. A partial absorb -- rows marked billed without
    // their charges, or charges added without the rows being marked -- would destroy the only
    // record that the money was owed, which is worse than the gap this task closes. Nothing
    // asserted that live until this case: `BU100` and `BU101` are doubles, and `BI23` refuses
    // **before** any write, so it has nothing to roll back (it was miscredited with this in an
    // earlier revision of `BU101`'s comment).
    //
    // The failure is induced the way `BI10` induces it on the create path, because it is the
    // real race rather than a contrived throw: a concurrent writer bills one of the two priced
    // rows through the **owner** connection, between the read and the write. The count
    // assertion then sees 1 of 2 and raises at step 4, after the increment and the nested
    // create have already run in the same transaction.
    await seedTwoMetricPeriod();
    await generate(periodBody(TENANT_A));

    const lateFirst = await seedLateApiLine(TENANT_A);
    const lateSecond = await seedLateApiLine(
      TENANT_A,
      INTEGRATION_LATE_USAGE.LATE_QUANTITY_API,
      INTEGRATION_LATE_USAGE.INSTANT_SECOND
    );
    const lineItemsBefore = await fixtures.readLineItems(SUITE_TENANT_IDS);

    await fixtures.admin.usageLine.update({
      where: { id: lateFirst },
      data: { billed: true }
    });

    const repository = new InvoiceRepository(app.container.prisma, TENANT_A);
    await expect(
      repository.absorbLateUsage({
        periodStart: new Date(INTEGRATION_FIXTURE.PERIOD_START),
        periodEnd: new Date(INTEGRATION_FIXTURE.PERIOD_END),
        totalAmountDelta: INTEGRATION_LATE_USAGE.ROLLBACK_DELTA,
        lineItems: [
          {
            metricKey: INTEGRATION_FIXTURE.METRIC_API,
            quantity: INTEGRATION_LATE_USAGE.ROLLBACK_LINE_QUANTITY,
            unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_API,
            amount: INTEGRATION_LATE_USAGE.ROLLBACK_DELTA
          }
        ],
        usageLineIds: [lateFirst, lateSecond]
      })
    ).rejects.toBeInstanceOf(UsageLinesChangedError);

    // **The three values, read back through the owner connection.** Rolled back by PostgreSQL,
    // not merely raised -- each of these is a separate write that the transaction undid.
    //
    // 1. the total is the pre-absorb figure, not that figure plus `ROLLBACK_DELTA`;
    expect(asDecimalString((await invoiceFor(TENANT_A)).totalAmount)).toBe(
      asDecimalString(INTEGRATION_FIXTURE.EXPECTED_TOTAL)
    );
    // 2. no line item was appended -- asserted against the count taken before the call, so it
    //    fails whether the nested create survived or the invoice lost rows;
    expect(await fixtures.readLineItems(SUITE_TENANT_IDS)).toHaveLength(lineItemsBefore.length);
    // 3. the row the transaction itself marked is unbilled again, so the next run will still
    //    find it. The row the *concurrent writer* billed stays billed: that write was outside
    //    this transaction and must not be undone by it.
    expect((await lineById(lateSecond)).billed).toBe(false);
    expect((await lineById(lateFirst)).billed).toBe(true);
  });

  it("BI10 - a short billed count rolls the invoice and its line items back", async () => {
    await seedTwoMetricPeriod();
    const repository = new InvoiceRepository(app.container.prisma, TENANT_A);
    const unbilled = await repository.sumUnbilledByMetricKey(
      new Date(INTEGRATION_FIXTURE.PERIOD_START),
      new Date(INTEGRATION_FIXTURE.PERIOD_END)
    );

    // A concurrent writer, simulated by billing one of the priced lines through the owner
    // connection between the read and the write. This is the case the count assertion exists to
    // *detect*: one long transaction would have serialised against it and told nobody.
    const [firstLineId] = unbilled.usageLineIds;
    await fixtures.admin.usageLine.update({
      where: { id: firstLineId },
      data: { billed: true }
    });

    await expect(
      repository.createDraftInvoice({
        periodStart: new Date(INTEGRATION_FIXTURE.PERIOD_START),
        periodEnd: new Date(INTEGRATION_FIXTURE.PERIOD_END),
        currency: INTEGRATION_FIXTURE.CURRENCY_USD,
        totalAmount: INTEGRATION_FIXTURE.EXPECTED_TOTAL,
        lineItems: unbilled.totals.map((total) => ({
          metricKey: total.metricKey,
          quantity: total.totalQuantity,
          unitPrice: INTEGRATION_FIXTURE.UNIT_PRICE_API,
          amount: INTEGRATION_FIXTURE.EXPECTED_AMOUNT_API
        })),
        usageLineIds: unbilled.usageLineIds
      })
    ).rejects.toBeInstanceOf(UsageLinesChangedError);

    // Rolled back for real, by PostgreSQL, not merely raised: no invoice and no line item
    // survive, and the line that was still unbilled stays unbilled.
    expect(await fixtures.readInvoices(SUITE_TENANT_IDS)).toHaveLength(0);
    expect(await fixtures.readLineItems(SUITE_TENANT_IDS)).toHaveLength(0);
    const lines = await fixtures.readUsageLines(SUITE_TENANT_IDS);
    expect(lines.filter((line) => line.billed)).toHaveLength(1);
  });
});

/**
 * `GET /v1/billing/invoices` against live PostgreSQL (T-046).
 *
 * Same two-connection discipline as the block above: rows are seeded through
 * `DIRECT_DATABASE_URL` (the owner) and every assertion reads back through the service, which
 * connects as `telemetry_app` -- `NOSUPERUSER NOBYPASSRLS`, asserted by BI0. BI17 therefore
 * asserts against rows the requesting tenant could not have created and could not have read
 * without the policy failing.
 *
 * The `FINALIZED` and `PAID` fixtures exist only because the platform cannot produce them:
 * `createDraftInvoice` writes `DRAFT` and never sets `finalizedAt`, so the status filter and
 * the nullable-timestamp case have no HTTP spelling to seed through.
 */
describe(`GET ${BILLING_ROUTES.INVOICES} (integration)`, () => {
  const listHeaders = (
    tenantId: string = TENANT_A,
    secret: string = env.INTERNAL_API_SECRET
  ): Record<string, string> => ({
    [BILLING_HEADERS.INTERNAL_SECRET]: secret,
    [BILLING_HEADERS.TENANT_ID]: tenantId
  });

  const list = async (headers: Record<string, string>, query = "") =>
    app.inject({
      method: "GET",
      url: `${BILLING_ROUTES.INVOICES}${query}`,
      headers
    });

  interface ListBody {
    readonly data: {
      readonly items: Record<string, unknown>[];
      readonly total: number;
      readonly page: number;
      readonly pageSize: number;
    };
  }

  const bodyOf = (response: Awaited<ReturnType<typeof list>>): ListBody =>
    response.json() as ListBody;

  /** Three periods for tenant A, one for tenant B, seeded newest-last so order is observable. */
  const seedThreePeriods = async (): Promise<void> => {
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    await fixtures.seedInvoices([
      {
        tenantId: TENANT_A,
        periodStart: INTEGRATION_INVOICE_LIST.JAN_START,
        periodEnd: INTEGRATION_INVOICE_LIST.JAN_END,
        status: BILLING_METERING.INVOICE_STATUS_DRAFT,
        totalAmount: INTEGRATION_INVOICE_LIST.TOTAL_JAN
      },
      {
        tenantId: TENANT_A,
        periodStart: INTEGRATION_INVOICE_LIST.FEB_START,
        periodEnd: INTEGRATION_INVOICE_LIST.FEB_END,
        status: InvoiceStatus.FINALIZED,
        totalAmount: INTEGRATION_INVOICE_LIST.TOTAL_FEB,
        finalizedAt: INTEGRATION_INVOICE_LIST.FINALIZED_AT
      },
      {
        tenantId: TENANT_A,
        periodStart: INTEGRATION_INVOICE_LIST.MAR_START,
        periodEnd: INTEGRATION_INVOICE_LIST.MAR_END,
        status: InvoiceStatus.PAID,
        totalAmount: INTEGRATION_INVOICE_LIST.TOTAL_MAR,
        finalizedAt: INTEGRATION_INVOICE_LIST.FINALIZED_AT
      }
    ]);
  };

  it("BI14 - lists the tenant's invoice headers newest period first, as the eight declared fields", async () => {
    await seedThreePeriods();

    const response = await list(listHeaders());

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    const { data } = bodyOf(response);
    expect(data.total).toBe(INTEGRATION_INVOICE_LIST.SEEDED_COUNT);
    expect(data.page).toBe(BILLING_INVOICE_LIST.DEFAULT_PAGE);
    expect(data.pageSize).toBe(BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE);

    // D4: newest period first, not insertion order and not `createdAt` order -- all three rows
    // were inserted oldest-period-first, so an unsorted read would return the reverse of this.
    expect(data.items.map((item) => item.periodStart)).toEqual([
      INTEGRATION_INVOICE_LIST.MAR_START,
      INTEGRATION_INVOICE_LIST.FEB_START,
      INTEGRATION_INVOICE_LIST.JAN_START
    ]);
    expect(data.items.map((item) => item.status)).toEqual([
      InvoiceStatus.PAID,
      InvoiceStatus.FINALIZED,
      BILLING_METERING.INVOICE_STATUS_DRAFT
    ]);

    // Exactly the eight `InvoiceHeader` fields. `lineItems` is T-047's, and `tenantId` is not
    // echoed back.
    for (const item of data.items) {
      expect(Object.keys(item).sort()).toEqual([
        "createdAt",
        "currency",
        "finalizedAt",
        "id",
        "periodEnd",
        "periodStart",
        "status",
        "totalAmount"
      ]);
    }

    // ISO strings, and `finalizedAt` null for the DRAFT row rather than "" or absent.
    const [paid, , draft] = data.items;
    expect(paid?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(paid?.finalizedAt).toBe(INTEGRATION_INVOICE_LIST.FINALIZED_AT);
    expect(draft?.finalizedAt).toBeNull();
  });

  it("BI15 - status filters the page and the total together, not just the page", async () => {
    await seedThreePeriods();

    const response = await list(
      listHeaders(),
      `?${INTEGRATION_INVOICE_LIST.QUERY_KEY_STATUS}=${InvoiceStatus.FINALIZED}`
    );

    const { data } = bodyOf(response);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]?.status).toBe(InvoiceStatus.FINALIZED);
    // `total` is 1, not 3: a count that ignored the filter would page correctly and then lie
    // about how many pages exist.
    expect(data.total).toBe(1);
  });

  it("BI16 - paging covers every row exactly once, even when two invoices share a periodStart", async () => {
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    const seededIds = await fixtures.seedInvoices([
      {
        tenantId: TENANT_A,
        periodStart: INTEGRATION_INVOICE_LIST.JAN_START,
        periodEnd: INTEGRATION_INVOICE_LIST.JAN_END,
        status: BILLING_METERING.INVOICE_STATUS_DRAFT,
        totalAmount: INTEGRATION_INVOICE_LIST.TOTAL_JAN
      },
      {
        // Same `periodStart`, different `periodEnd` -- legal under
        // `@@unique([tenantId, periodStart, periodEnd])`, and the exact shape that makes a
        // `periodStart`-only sort non-deterministic across two LIMIT/OFFSET queries.
        tenantId: TENANT_A,
        periodStart: INTEGRATION_INVOICE_LIST.JAN_START,
        periodEnd: INTEGRATION_INVOICE_LIST.JAN_END_ALTERNATE,
        status: BILLING_METERING.INVOICE_STATUS_DRAFT,
        totalAmount: INTEGRATION_INVOICE_LIST.TOTAL_JAN_ALTERNATE
      },
      {
        tenantId: TENANT_A,
        periodStart: INTEGRATION_INVOICE_LIST.FEB_START,
        periodEnd: INTEGRATION_INVOICE_LIST.FEB_END,
        status: InvoiceStatus.FINALIZED,
        totalAmount: INTEGRATION_INVOICE_LIST.TOTAL_FEB,
        finalizedAt: INTEGRATION_INVOICE_LIST.FINALIZED_AT
      }
    ]);

    const pageQuery = (pageNumber: number, pageSize: number) =>
      `?${INTEGRATION_INVOICE_LIST.QUERY_KEY_PAGE}=${pageNumber}` +
      `&${INTEGRATION_INVOICE_LIST.QUERY_KEY_PAGE_SIZE}=${pageSize}`;

    const first = bodyOf(
      await list(listHeaders(), pageQuery(1, INTEGRATION_INVOICE_LIST.PAGE_SIZE_TWO))
    );
    const second = bodyOf(
      await list(listHeaders(), pageQuery(2, INTEGRATION_INVOICE_LIST.PAGE_SIZE_TWO))
    );

    expect(first.data.items).toHaveLength(INTEGRATION_INVOICE_LIST.PAGE_SIZE_TWO);
    expect(first.data.total).toBe(seededIds.length);
    expect(second.data.items).toHaveLength(seededIds.length - INTEGRATION_INVOICE_LIST.PAGE_SIZE_TWO);
    expect(second.data.total).toBe(seededIds.length);

    // The assertion D4 exists for: the union of the pages is the whole set with no id repeated
    // and none missing. Without the `id` tie-break the two JAN rows may land on both pages or
    // on neither, and a status-and-length assertion alone would not notice.
    const union = [...first.data.items, ...second.data.items].map((item) => item.id as string);
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual([...seededIds].sort());

    // Walked one row at a time as well, which multiplies the chances for a boundary to move.
    const walked: string[] = [];
    for (let pageNumber = 1; pageNumber <= seededIds.length; pageNumber += 1) {
      const singlePage = bodyOf(
        await list(listHeaders(), pageQuery(pageNumber, INTEGRATION_INVOICE_LIST.PAGE_SIZE_ONE))
      );
      expect(singlePage.data.items).toHaveLength(INTEGRATION_INVOICE_LIST.PAGE_SIZE_ONE);
      walked.push(singlePage.data.items[0]?.id as string);
    }
    expect(new Set(walked).size).toBe(seededIds.length);
    expect([...walked].sort()).toEqual([...seededIds].sort());
  });

  it("BI17 - a second tenant's invoice never appears, read as telemetry_app with a real RLS context", async () => {
    await seedThreePeriods();
    const [tenantBInvoiceId] = await fixtures.seedInvoices([
      {
        tenantId: TENANT_B,
        periodStart: INTEGRATION_INVOICE_LIST.MAR_START,
        periodEnd: INTEGRATION_INVOICE_LIST.MAR_END,
        status: InvoiceStatus.PAID,
        totalAmount: INTEGRATION_INVOICE_LIST.TOTAL_TENANT_B
      }
    ]);

    const asA = bodyOf(await list(listHeaders(TENANT_A)));
    const asB = bodyOf(await list(listHeaders(TENANT_B)));

    // Asserted against a row tenant A could not have created: it was seeded through the owner
    // connection for the other tenant, so seeing it would be a real leak rather than a fixture
    // artefact.
    expect(asA.data.items.map((item) => item.id)).not.toContain(tenantBInvoiceId);
    expect(asA.data.total).toBe(INTEGRATION_INVOICE_LIST.SEEDED_COUNT);
    expect(JSON.stringify(asA.data)).not.toContain(INTEGRATION_INVOICE_LIST.TOTAL_TENANT_B);

    // And the row is genuinely there for its own tenant, so the absence above is isolation and
    // not an empty table.
    expect(asB.data.items.map((item) => item.id)).toEqual([tenantBInvoiceId]);
    expect(asB.data.total).toBe(1);
  });

  it("BI18 - Decimal(18,6) survives the round trip exactly, and no Prisma.Decimal leaves the repository", async () => {
    await fixtures.seedTenants(SUITE_TENANT_IDS);
    await fixtures.seedInvoices([
      {
        tenantId: TENANT_A,
        periodStart: INTEGRATION_INVOICE_LIST.JAN_START,
        periodEnd: INTEGRATION_INVOICE_LIST.JAN_END,
        status: BILLING_METERING.INVOICE_STATUS_DRAFT,
        totalAmount: INTEGRATION_INVOICE_LIST.TOTAL_PRECISE
      }
    ]);

    const { data } = bodyOf(await list(listHeaders()));
    expect(data.items[0]?.totalAmount).toBe(INTEGRATION_INVOICE_LIST.TOTAL_PRECISE);

    // The decisive assertion, and it has to be below HTTP. Measured at Gate 1 with no
    // normalisation layer at all: `Prisma.Decimal` defines `toJSON`, so the wire body carries
    // the same `"1234567.123456"` either way and `typeof` on the parsed value is `"string"`.
    // The line above therefore cannot tell a normalised value from a leaked one; this one can.
    const repository = app.container.invoiceRepositoryFactory(TENANT_A);
    const { items } = await repository.listInvoices({
      page: BILLING_INVOICE_LIST.DEFAULT_PAGE,
      pageSize: BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE
    });

    expect(items).toHaveLength(1);
    expect(typeof items[0]?.totalAmount).toBe("string");
    expect(items[0]?.totalAmount).not.toBeInstanceOf(Prisma.Decimal);
    expect(items[0]?.totalAmount).toBe(INTEGRATION_INVOICE_LIST.TOTAL_PRECISE);
    expect(items[0]?.periodStart).not.toBeInstanceOf(Date);
    expect(items[0]?.createdAt).not.toBeInstanceOf(Date);
    // The precision assertion, stated as what was measured: 18 significant digits do not fit
    // a double, and `String(Number(...))` on this value degrades it to
    // `TOTAL_PRECISE_AFTER_FLOAT_ROUND_TRIP`. So an implementation that let the column become
    // a JS number at any point cannot produce the string above -- it would produce this one.
    expect(String(Number(INTEGRATION_INVOICE_LIST.TOTAL_PRECISE))).toBe(
      INTEGRATION_INVOICE_LIST.TOTAL_PRECISE_AFTER_FLOAT_ROUND_TRIP
    );
    expect(items[0]?.totalAmount).not.toBe(
      INTEGRATION_INVOICE_LIST.TOTAL_PRECISE_AFTER_FLOAT_ROUND_TRIP
    );
    expect(asDecimalString(items[0]?.totalAmount)).toBe(
      asDecimalString(INTEGRATION_INVOICE_LIST.TOTAL_PRECISE)
    );
  });

  it("BI19 - a missing and a malformed X-Tenant-Id are both 401, with distinct codes", async () => {
    await seedThreePeriods();

    const missing = await list({
      [BILLING_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET
    });
    const malformed = await list(listHeaders(INTEGRATION_INVOICE_LIST.TENANT_ID_NOT_A_UUID));

    expect(missing.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(missing.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });
    expect(malformed.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(malformed.json()).toMatchObject({
      code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_INVALID
    });
    // Non-empty is not good enough: a tenant id containing `:` would make another service's
    // `<prefix>:<tenantId>:<key>` derivation ambiguous.
    expect(malformed.json()).not.toMatchObject({
      code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });
  });

  it("BI20 - a missing or wrong X-Internal-Secret is 401 before any tenant context is derived", async () => {
    await seedThreePeriods();

    const noSecret = await list({ [BILLING_HEADERS.TENANT_ID]: TENANT_A });
    const wrongSecret = await list(
      listHeaders(TENANT_A, INTEGRATION_INVOICE_LIST.WRONG_INTERNAL_SECRET)
    );
    // Neither header at all: the shape that observes hook *order* rather than just the status,
    // because both hooks answer 401 and only the code says which one ran.
    const neither = await list({});

    for (const response of [noSecret, wrongSecret, neither]) {
      expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      expect(response.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
    }
    expect(neither.json()).not.toMatchObject({
      code: BILLING_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });
  });

  it("BI21 - a tenant with no invoices is an empty 200, never a 404", async () => {
    await seedThreePeriods();

    const response = await list(listHeaders(TENANT_B));

    expect(response.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_OK);
    const { data } = bodyOf(response);
    expect(data.items).toEqual([]);
    expect(data.total).toBe(INTEGRATION_INVOICE_LIST.EXPECTED_EMPTY_TOTAL);
    // The tenant id arrives from a gateway-verified JWT, so "no rows" says nothing about
    // whether the tenant exists -- and answering 404 would make this an existence oracle.
    expect(response.statusCode).not.toBe(BILLING_RESPONSES.HTTP_STATUS_NOT_FOUND);
  });
});
