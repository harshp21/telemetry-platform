import { PrismaClient } from "@prisma/client";
import RedisClient from "ioredis";
import {
  INTEGRATION_ADMIN_DATABASE_URL_FALLBACK,
  INTEGRATION_FIXTURE,
  INTEGRATION_ID_PREFIX
} from "./integration.constants";

/**
 * Fixture harness for `usage.integration.test.ts`.
 *
 * Two connections, and the suite is explicit about which one it is talking to: the service
 * under test uses `DATABASE_URL` (`telemetry_app`, `NOSUPERUSER`/`NOBYPASSRLS`), while
 * everything in this file uses `DIRECT_DATABASE_URL` (the owner). A suite that seeded and
 * asserted through the same restricted connection would prove nothing — that was S-3.
 */
const REQUIRED_TABLES = ["Tenant", "Event", "UsageLine"] as const;

const MIGRATE_COMMAND =
  "pnpm --filter @telemetry/auth-service exec prisma migrate deploy --schema=../../prisma/schema.prisma";

export interface UsageLineSpec {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly metricKey: string;
  readonly quantity: string;
  readonly periodStart: string;
  readonly periodEnd?: string;
}

export interface FixtureRowCounts {
  readonly tenants: number;
  readonly events: number;
  readonly usageLines: number;
}

export interface StreamEntry {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Every statement below runs on `DIRECT_DATABASE_URL` — the owner connection.
 *
 * That role is `rolsuper`/`rolbypassrls` and owns the tables, which is the *only* reason
 * seeding two tenants in one call works: `tenant_self_insert`'s `WITH CHECK` is
 * `id = current_setting('app.tenant_id', true)`, one value per transaction, so as
 * `telemetry_app` a cross-tenant seed is impossible regardless of error handling. Seeding
 * success here is therefore **not** evidence that the policies permit it (the S-2 lesson).
 *
 * The reset needs the same connection for a different reason: as `telemetry_app` an unscoped
 * `DELETE`/`UPDATE`/`SELECT` is filtered by the policy's `USING` clause and silently affects
 * zero rows, so a reset issued on the service connection would report success while deleting
 * nothing. Observed as `telemetry_app`, inside `BEGIN … ROLLBACK`:
 *   `INSERT INTO "Tenant" …` with no context -> ERROR: new row violates row-level security policy
 *   `DELETE FROM "Tenant"` with no context   -> DELETE 0
 */
export class UsageFixtures {
  private readonly client: PrismaClient;
  private seedSequence = 0;

  constructor(
    private readonly runId: string,
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
				AND table_name IN (${REQUIRED_TABLES[0]}, ${REQUIRED_TABLES[1]}, ${REQUIRED_TABLES[2]})
		`;

    if (rows[0]?.present !== REQUIRED_TABLES.length) {
      throw new Error(
        `Expected tables ${REQUIRED_TABLES.join(", ")} in the target database. Run: ${MIGRATE_COMMAND}`
      );
    }
  }

  /**
   * Seeds `Tenant` -> one `Event` -> one `UsageLine` per spec.
   *
   * One `Event` per `UsageLine` is forced by the schema: `UsageLine.eventId` is `@unique`,
   * so lines cannot share an event. `Event.idempotencyKey` is globally `@unique`, hence the
   * per-run suffix.
   */
  async seedUsageLines(specs: readonly UsageLineSpec[]): Promise<void> {
    const tenantNames = new Map<string, string>();
    for (const spec of specs) {
      tenantNames.set(spec.tenantId, spec.tenantName);
    }

    for (const [id, name] of tenantNames) {
      await this.client.tenant.upsert({ where: { id }, update: {}, create: { id, name } });
    }

    for (const spec of specs) {
      this.seedSequence += 1;
      const suffix = `${this.runId}-${this.seedSequence}`;
      const eventId = `${INTEGRATION_ID_PREFIX}event-${suffix}`;

      await this.client.event.create({
        data: {
          id: eventId,
          tenantId: spec.tenantId,
          idempotencyKey: `${INTEGRATION_ID_PREFIX}seed-${suffix}`,
          eventType: spec.metricKey,
          quantity: spec.quantity,
          // `Event.unit` is NOT NULL and the summary path never reads it, so the suite's one
          // unit constant covers every seed.
          unit: INTEGRATION_FIXTURE.EVENT_UNIT,
          occurredAt: new Date(spec.periodStart)
        }
      });

      await this.client.usageLine.create({
        data: {
          id: `${INTEGRATION_ID_PREFIX}line-${suffix}`,
          tenantId: spec.tenantId,
          eventId,
          metricKey: spec.metricKey,
          quantity: spec.quantity,
          periodStart: new Date(spec.periodStart),
          periodEnd: new Date(spec.periodEnd ?? spec.periodStart)
        }
      });
    }
  }

  /** Reverse FK order, and always scoped to this run's tenant ids — never a bare deleteMany. */
  async resetUsageState(tenantIds: readonly string[]): Promise<void> {
    const ids = [...tenantIds];

    await this.client.usageLine.deleteMany({ where: { tenantId: { in: ids } } });
    await this.client.event.deleteMany({ where: { tenantId: { in: ids } } });
    await this.client.tenant.deleteMany({ where: { id: { in: ids } } });
  }

  async countRows(tenantIds: readonly string[]): Promise<FixtureRowCounts> {
    const ids = [...tenantIds];

    const [tenants, events, usageLines] = await Promise.all([
      this.client.tenant.count({ where: { id: { in: ids } } }),
      this.client.event.count({ where: { tenantId: { in: ids } } }),
      this.client.usageLine.count({ where: { tenantId: { in: ids } } })
    ]);

    return { tenants, events, usageLines };
  }

  /**
   * Asserts the reset actually reset, for this run's tenant ids only.
   *
   * Scoped rather than global on purpose: vitest runs test files in parallel processes, and
   * `rls.enforcement.integration.test.ts` legitimately holds its own `UsageLine` rows for
   * other tenants while this suite runs. A global "no foreign rows" check would flake
   * against a sibling suite instead of catching a broken reset.
   */
  async assertRunStateEmpty(tenantIds: readonly string[]): Promise<void> {
    const counts = await this.countRows(tenantIds);

    if (counts.tenants !== 0 || counts.events !== 0 || counts.usageLines !== 0) {
      throw new Error(
        `Fixture reset left rows behind (tenants=${counts.tenants}, events=${counts.events}, usageLines=${counts.usageLines}). ` +
          "Is DIRECT_DATABASE_URL pointing at the owner role? As telemetry_app an unscoped DELETE affects zero rows and raises nothing."
      );
    }
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }
}

/** `XRANGE` returns fields as a flat `[key, value, key, value, …]` array. */
const FIELD_PAIR_STRIDE = 2;

/** `EXISTS` returns the number of keys found. */
const REDIS_KEY_PRESENT = 1;

/**
 * Redis harness on the suite's own logical database.
 *
 * `FLUSHDB`, never `FLUSHALL`: the local Redis is shared, and db0/db6 hold unrelated work.
 */
export class IntegrationRedis {
  private readonly client: RedisClient;

  constructor(url: string) {
    this.client = new RedisClient(url);
  }

  async flushIsolatedDb(): Promise<void> {
    await this.client.flushdb();
  }

  /**
   * Reads the whole stream back with `XRANGE <name> - +`.
   *
   * Reading the entries rather than calling `XLEN` is deliberate: it is what lets A1 assert
   * *which* events landed, so the case cannot pass on a count alone.
   */
  async readStreamEntries(streamName: string): Promise<StreamEntry[]> {
    const raw = await this.client.xrange(streamName, "-", "+");

    return raw.map(([id, flat]) => {
      const fields: Record<string, string> = {};

      for (let index = 0; index + 1 < flat.length; index += FIELD_PAIR_STRIDE) {
        const key = flat[index];
        const value = flat[index + 1];

        if (key !== undefined && value !== undefined) {
          fields[key] = value;
        }
      }

      return { id, fields };
    });
  }

  async keyExists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === REDIS_KEY_PRESENT;
  }

  async quit(): Promise<void> {
    await this.client.quit();
  }
}
