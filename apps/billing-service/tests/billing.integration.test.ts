import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { buildBillingServiceApp } from "../src/app";
import { env } from "../src/config/env";
import { BillingService } from "../src/services/billing.service";
import { InvoiceRepository } from "../src/repositories/invoice.repository";
import { MeterRepository } from "../src/repositories/meter.repository";
import { UsageLinesChangedError } from "../src/errors";
import {
  BILLING_HEADERS,
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

describe("POST /v1/internal/billing/generate (integration)", () => {
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
    // Both halves matter: `beforeEach`-only cleanup leaves the last test's rows behind for good.
    await fixtures.reset(SUITE_TENANT_IDS);
    await fixtures.assertRunStateEmpty(SUITE_TENANT_IDS);
    await app.close();
    await fixtures.disconnect();
  });

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
    expect(response.json()).toEqual({ data: { invoiceId: null } });
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
    // The response envelope carries only the invoice id (D3), so there is no amount in it to
    // leak -- asserted by exact key set rather than assumed, because a future field would
    // change that and a `toMatchObject` would not notice.
    const body = response.json() as { data: { invoiceId: string } };
    expect(Object.keys(body)).toEqual(["data"]);
    expect(Object.keys(body.data)).toEqual(["invoiceId"]);
    expect(typeof body.data.invoiceId).toBe("string");

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
