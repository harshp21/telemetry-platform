import { PrismaClient } from "@prisma/client";
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

  async readLineItems(tenantIds: readonly string[]) {
    return this.client.invoiceLineItem.findMany({
      where: { invoice: { tenantId: { in: [...tenantIds] } } },
      orderBy: { metricKey: "asc" },
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
