import { PrismaClient } from "@prisma/client";
import type { InvoiceStatus } from "@prisma/client";
import { BILLING_INVOICE_DETAIL } from "../src/constants";
import {
  INTEGRATION_ADMIN_DATABASE_URL_FALLBACK,
  INTEGRATION_FIXTURE,
  INTEGRATION_ID_PREFIX
} from "./integration.constants";

/**
 * Fixture harness for `billing.integration.test.ts`.
 *
 * Two connections, and the suite is explicit about which one it is talking to: the service
 * under test uses `DATABASE_URL` (`telemetry_app`, `NOSUPERUSER`/`NOBYPASSRLS`), while
 * everything in this file uses `DIRECT_DATABASE_URL` (the owner). A suite that seeded and
 * asserted through the same restricted connection would prove nothing.
 *
 * The owner connection is also the only way to seed the fractional and high-precision
 * quantities BI8 needs: usage-service's ingest validator is
 * `z.number().int().min(1).max(100)` (S-17), so nothing on the platform's HTTP surface can
 * express them.
 */
const REQUIRED_TABLES = ["Tenant", "Meter", "UsageLine", "Invoice", "InvoiceLineItem"] as const;

const MIGRATE_COMMAND =
  "pnpm --filter @telemetry/auth-service exec prisma migrate deploy --schema=../../prisma/schema.prisma";

export interface UsageLineSpec {
  readonly tenantId: string;
  readonly metricKey: string;
  readonly quantity: string;
  readonly periodStart: string;
  readonly billed?: boolean;
}

export interface MeterSpec {
  readonly tenantId: string;
  readonly metricKey: string;
  readonly unitPrice: string;
  readonly currency?: string;
  readonly activeFrom?: string;
  readonly activeTo?: string | null;
}

/**
 * One seeded invoice header for the T-046 list cases.
 *
 * Seeded through the owner connection because the platform's own write path cannot produce
 * these rows: `InvoiceRepository.createDraftInvoice` writes `DRAFT` only
 * (`BILLING_METERING.INVOICE_STATUS_DRAFT`) and never sets `finalizedAt`, so a `FINALIZED` or
 * `PAID` invoice with a non-null `finalizedAt` has no HTTP spelling today. The status filter
 * and the nullable-timestamp case need both.
 *
 * `createdAt` is settable so a case can pin it rather than inherit `now()`.
 */
export interface InvoiceSpec {
  readonly tenantId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: InvoiceStatus;
  readonly totalAmount: string;
  readonly currency?: string;
  readonly createdAt?: string;
  readonly finalizedAt?: string | null;
  /** T-047: line items, written through the nested `create` -- see `InvoiceLineItemSpec`. */
  readonly lineItems?: readonly InvoiceLineItemSpec[];
  /**
   * An explicit invoice id, overriding this helper's readable `<prefix>invoice-<n>` default.
   *
   * Needed by every case that feeds the id back into a URL: `GET /v1/billing/invoices/:id`
   * validates the param as a UUID, and the readable default is not one -- measured, the T-047
   * cases answered `400` before this existed. Production ids always are UUIDs
   * (`Invoice.id` is `String @default(uuid())`), so the readable default was only ever legal
   * because no endpoint had taken an invoice id as input.
   */
  readonly id?: string;
}

/**
 * One seeded `InvoiceLineItem` (T-047).
 *
 * Written through Prisma's **nested** `create` on the parent invoice, never as a bare
 * `invoiceLineItem.create` keyed by an `invoiceId` the caller supplies. That is the same
 * routing property the production repository holds (S-10: `"InvoiceLineItem"` has
 * `relrowsecurity = f` and zero policies, so the parent relation is its only tenant control),
 * and keeping the fixture on it means no helper here can be copied into `src/` and become the
 * cross-tenant read `BI30` exists to catch.
 *
 * `id` is settable so a case can make the `id asc` tie-break decidable rather than an accident
 * of insertion order -- `BI31` seeds two rows sharing a `metricKey` and needs to know which is
 * which. Omitted, Prisma generates a uuid.
 */
export interface InvoiceLineItemSpec {
  readonly metricKey: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly amount: string;
  readonly id?: string;
}

export interface FixtureRowCounts {
  readonly tenants: number;
  readonly meters: number;
  readonly usageLines: number;
  readonly invoices: number;
  readonly lineItems: number;
  readonly events: number;
}

/**
 * Every statement below runs on `DIRECT_DATABASE_URL` -- the owner connection.
 *
 * The reset needs that connection for a reason worth stating: as `telemetry_app` an unscoped
 * `DELETE` is filtered by the policy's `USING` clause and silently affects zero rows, so a
 * reset issued on the service connection would report success while deleting nothing.
 */
export class BillingFixtures {
  private readonly client: PrismaClient;
  private seedSequence = 0;

  constructor(
    adminDatabaseUrl: string = process.env.DIRECT_DATABASE_URL ??
      INTEGRATION_ADMIN_DATABASE_URL_FALLBACK
  ) {
    this.client = new PrismaClient({ datasourceUrl: adminDatabaseUrl });
  }

  get admin(): PrismaClient {
    return this.client;
  }

  /** Fail-fast preflight: names the migrate command instead of emitting a wall of P2021. */
  async assertSchemaReady(): Promise<void> {
    const rows = await this.client.$queryRaw<{ present: number }[]>`
      SELECT COUNT(*)::int AS "present"
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (${REQUIRED_TABLES[0]}, ${REQUIRED_TABLES[1]}, ${REQUIRED_TABLES[2]}, ${REQUIRED_TABLES[3]}, ${REQUIRED_TABLES[4]})
    `;

    if (rows[0]?.present !== REQUIRED_TABLES.length) {
      throw new Error(
        `Expected tables ${REQUIRED_TABLES.join(", ")} in the target database. Run: ${MIGRATE_COMMAND}`
      );
    }
  }

  async seedTenants(tenantIds: readonly string[]): Promise<void> {
    for (const id of tenantIds) {
      await this.client.tenant.upsert({
        where: { id },
        update: {},
        create: { id, name: INTEGRATION_FIXTURE.TENANT_NAME }
      });
    }
  }

  async seedMeters(specs: readonly MeterSpec[]): Promise<void> {
    for (const spec of specs) {
      this.seedSequence += 1;
      await this.client.meter.create({
        data: {
          id: `${INTEGRATION_ID_PREFIX}meter-${this.seedSequence}`,
          tenantId: spec.tenantId,
          metricKey: spec.metricKey,
          unitPrice: spec.unitPrice,
          currency: spec.currency ?? INTEGRATION_FIXTURE.CURRENCY_USD,
          activeFrom: new Date(spec.activeFrom ?? INTEGRATION_FIXTURE.METER_ACTIVE_FROM),
          activeTo: spec.activeTo === undefined || spec.activeTo === null
            ? null
            : new Date(spec.activeTo)
        }
      });
    }
  }

  /**
   * Seeds one `Event` per `UsageLine`, which the schema forces: `UsageLine.eventId` is
   * `@unique`, so lines cannot share an event.
   *
   * `periodStart === periodEnd === occurredAt`, matching what worker-service writes
   * (`apps/worker-service/src/validators/stream-message.validator.ts`): a `UsageLine` period is
   * a point instant, not an interval, which is why the billing window is half-open.
   */
  async seedUsageLines(specs: readonly UsageLineSpec[]): Promise<string[]> {
    const ids: string[] = [];

    for (const spec of specs) {
      this.seedSequence += 1;
      const suffix = String(this.seedSequence);
      const eventId = `${INTEGRATION_ID_PREFIX}event-${suffix}`;
      const usageLineId = `${INTEGRATION_ID_PREFIX}line-${suffix}`;
      const instant = new Date(spec.periodStart);

      await this.client.event.create({
        data: {
          id: eventId,
          tenantId: spec.tenantId,
          idempotencyKey: `${INTEGRATION_ID_PREFIX}key-${suffix}`,
          eventType: spec.metricKey,
          quantity: spec.quantity,
          unit: INTEGRATION_FIXTURE.EVENT_UNIT,
          occurredAt: instant
        }
      });

      await this.client.usageLine.create({
        data: {
          id: usageLineId,
          tenantId: spec.tenantId,
          eventId,
          metricKey: spec.metricKey,
          quantity: spec.quantity,
          periodStart: instant,
          periodEnd: instant,
          billed: spec.billed ?? false
        }
      });

      ids.push(usageLineId);
    }

    return ids;
  }

  /**
   * Bulk seed for the chunking cases, through `createMany` in seed-sized batches.
   *
   * The batching here is the fixture's own, for the same reason the repository chunks: an
   * `Event` row binds eight columns, so a single `createMany` of a few thousand rows would hit
   * the 32 767-bind ceiling in the *seed* and obscure the thing under test. Measured: 1 001
   * `Event` + `UsageLine` pairs seed in ~166 ms, which is what makes BI11 affordable as a
   * standing case rather than a manual one.
   */
  async seedBulkUsageLines(
    tenantId: string,
    metricKey: string,
    quantity: string,
    periodStart: string,
    count: number
  ): Promise<void> {
    const instant = new Date(periodStart);
    const batch = 500;

    for (let offset = 0; offset < count; offset += batch) {
      const indexes = Array.from(
        { length: Math.min(batch, count - offset) },
        (_, k) => offset + k
      );
      this.seedSequence += 1;
      const run = this.seedSequence;

      await this.client.event.createMany({
        data: indexes.map((n) => ({
          id: `${INTEGRATION_ID_PREFIX}bulk-event-${run}-${n}`,
          tenantId,
          idempotencyKey: `${INTEGRATION_ID_PREFIX}bulk-key-${run}-${n}`,
          eventType: metricKey,
          quantity,
          unit: INTEGRATION_FIXTURE.EVENT_UNIT,
          occurredAt: instant
        }))
      });

      await this.client.usageLine.createMany({
        data: indexes.map((n) => ({
          id: `${INTEGRATION_ID_PREFIX}bulk-line-${run}-${n}`,
          tenantId,
          eventId: `${INTEGRATION_ID_PREFIX}bulk-event-${run}-${n}`,
          metricKey,
          quantity,
          periodStart: instant,
          periodEnd: instant
        }))
      });
    }
  }

  /**
   * Seeds invoice headers -- and, since T-047, their line items -- returning the invoice ids in
   * the order given.
   *
   * Line items are optional: the T-046 list cases still seed none, because `"InvoiceLineItem"`
   * has no enforcing RLS (S-10) and rows a case never reads are a cross-tenant surface for
   * nothing. Where they are seeded they go through the **nested** `create`, so this helper
   * never issues a write keyed by a bare `invoiceId`.
   */
  async seedInvoices(specs: readonly InvoiceSpec[]): Promise<string[]> {
    const ids: string[] = [];

    for (const spec of specs) {
      this.seedSequence += 1;
      const id = spec.id ?? `${INTEGRATION_ID_PREFIX}invoice-${this.seedSequence}`;

      await this.client.invoice.create({
        data: {
          id,
          tenantId: spec.tenantId,
          periodStart: new Date(spec.periodStart),
          periodEnd: new Date(spec.periodEnd),
          status: spec.status,
          totalAmount: spec.totalAmount,
          currency: spec.currency ?? INTEGRATION_FIXTURE.CURRENCY_USD,
          ...(spec.createdAt === undefined ? {} : { createdAt: new Date(spec.createdAt) }),
          finalizedAt:
            spec.finalizedAt === undefined || spec.finalizedAt === null
              ? null
              : new Date(spec.finalizedAt),
          ...(spec.lineItems === undefined || spec.lineItems.length === 0
            ? {}
            : {
                lineItems: {
                  create: spec.lineItems.map((item) => ({
                    ...(item.id === undefined ? {} : { id: item.id }),
                    metricKey: item.metricKey,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                    amount: item.amount
                  }))
                }
              })
        }
      });

      ids.push(id);
    }

    return ids;
  }

  async countUsageLines(tenantIds: readonly string[], billed: boolean): Promise<number> {
    return this.client.usageLine.count({
      where: { tenantId: { in: [...tenantIds] }, billed }
    });
  }

  async readUsageLines(tenantIds: readonly string[]) {
    return this.client.usageLine.findMany({
      where: { tenantId: { in: [...tenantIds] } },
      orderBy: { id: "asc" },
      select: { id: true, metricKey: true, billed: true, quantity: true }
    });
  }

  async readInvoices(tenantIds: readonly string[]) {
    return this.client.invoice.findMany({
      where: { tenantId: { in: [...tenantIds] } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        tenantId: true,
        status: true,
        currency: true,
        totalAmount: true,
        periodStart: true,
        periodEnd: true
      }
    });
  }

  /**
   * Line items for the suite's tenants, through the owner connection.
   *
   * **Two sort keys since T-047**, and the second one is not decoration: `metricKey` is not
   * unique within an invoice (`absorbLateUsage` appends a tranche rather than merging it), so
   * `metricKey` alone is a partial order and two rows sharing a key came back in whatever
   * order the heap held them. That is the same defect `BILLING_INVOICE_DETAIL`'s sort exists
   * to fix on the response side; a fixture reader used as a cross-check must not be the looser
   * of the two.
   *
   * **No existing caller's expectation moves, measured rather than reasoned about.** Reverting
   * this to the pre-T-047 `orderBy: { metricKey: "asc" }` and running
   * `billing.integration.test.ts` three times gave `Tests 36 passed (36)` each time (T-047
   * Gate 3 rework; the Gate 4 reviewer measured the same three runs independently; Gate 5's QA
   * measured them a third time). Scope: that one file, on this host, three runs -- not a proof
   * that no future caller can be disturbed.
   *
   * Read that the right way round: **no case goes red when the `id` tie-break is removed**, so it
   * is unfalsifiable today and must not be deleted on the evidence that deleting it is green --
   * the S-28 hazard, recorded here rather than in a gap entry because here is where a deleter
   * reads (T-047 Gate 5, observation O-1).
   *
   * The reason is *not* that callers count, filter or sort first -- an earlier revision of this
   * docblock said so and it is false: `BI1` (`billing.integration.test.ts:194-195`), `BI8`
   * (`:498-499`) and `BI13` (`:580-587`) all index `lineItems[0]`/`[1]` positionally. They are
   * undisturbed because each of their fixtures gives every row a **distinct `metricKey`**, so
   * `metricKey asc` was already a total order for them. The tie-break matters only where one
   * invoice carries two rows under one key, which is `BI31`'s fixture and no other.
   *
   * Sort field and direction come from `BILLING_INVOICE_DETAIL`, the same constants the
   * production sort uses, so a schema rename is a compile error here too.
   */
  async readLineItems(tenantIds: readonly string[]) {
    return this.client.invoiceLineItem.findMany({
      where: { invoice: { tenantId: { in: [...tenantIds] } } },
      orderBy: [
        { [BILLING_INVOICE_DETAIL.SORT_FIELD_METRIC_KEY]: BILLING_INVOICE_DETAIL.SORT_DIRECTION_ASC },
        { [BILLING_INVOICE_DETAIL.SORT_FIELD_ID]: BILLING_INVOICE_DETAIL.SORT_DIRECTION_ASC }
      ],
      select: { id: true, invoiceId: true, metricKey: true, quantity: true, unitPrice: true, amount: true }
    });
  }

  /** Reverse FK order, always scoped to this suite's tenant ids -- never a bare deleteMany. */
  async reset(tenantIds: readonly string[]): Promise<void> {
    const ids = [...tenantIds];

    await this.client.invoiceLineItem.deleteMany({
      where: { invoice: { tenantId: { in: ids } } }
    });
    await this.client.invoice.deleteMany({ where: { tenantId: { in: ids } } });
    await this.client.usageLine.deleteMany({ where: { tenantId: { in: ids } } });
    await this.client.event.deleteMany({ where: { tenantId: { in: ids } } });
    await this.client.meter.deleteMany({ where: { tenantId: { in: ids } } });
    await this.client.tenant.deleteMany({ where: { id: { in: ids } } });
  }

  async countRows(tenantIds: readonly string[]): Promise<FixtureRowCounts> {
    const ids = [...tenantIds];

    const [tenants, meters, usageLines, invoices, lineItems, events] = await Promise.all([
      this.client.tenant.count({ where: { id: { in: ids } } }),
      this.client.meter.count({ where: { tenantId: { in: ids } } }),
      this.client.usageLine.count({ where: { tenantId: { in: ids } } }),
      this.client.invoice.count({ where: { tenantId: { in: ids } } }),
      this.client.invoiceLineItem.count({ where: { invoice: { tenantId: { in: ids } } } }),
      this.client.event.count({ where: { tenantId: { in: ids } } })
    ]);

    return { tenants, meters, usageLines, invoices, lineItems, events };
  }

  /**
   * Asserts the reset actually reset, for this run's tenant ids only.
   *
   * Scoped rather than global: vitest runs test files in parallel processes, and a sibling
   * suite may legitimately hold rows for other tenants while this one runs.
   */
  async assertRunStateEmpty(tenantIds: readonly string[]): Promise<void> {
    const counts = await this.countRows(tenantIds);
    const leftover = Object.entries(counts).filter(([, value]) => value !== 0);

    if (leftover.length > 0) {
      throw new Error(
        `Fixture reset left rows behind (${leftover.map(([k, v]) => `${k}=${v}`).join(", ")}). ` +
          "Is DIRECT_DATABASE_URL pointing at the owner role? As telemetry_app an unscoped DELETE affects zero rows and raises nothing."
      );
    }
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }
}
