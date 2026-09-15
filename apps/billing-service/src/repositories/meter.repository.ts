import { TenantScopedRepository } from "./base.repository";

/**
 * A rate-card entry in force for one metric key, with its price already normalised.
 *
 * `unitPrice` is a string, not a `number` and not a `Prisma.Decimal`. `Meter.unitPrice` is
 * `Decimal(18,6)`, which exceeds IEEE-754 safe precision, and D8 puts the one normalisation
 * layer here -- `String(...)`, matching `apps/worker-service/src/repositories/event.repository.ts`
 * and `apps/usage-service/src/repositories/usage.repository.ts`. The service reads it back into
 * a `Prisma.Decimal` for the arithmetic; nothing above this line ever holds a Decimal instance.
 */
export interface ActiveMeter {
  readonly metricKey: string;
  readonly unitPrice: string;
  readonly currency: string;
}

/**
 * Tenant-scoped reads over the rate card.
 *
 * The tenant predicate comes from `this.where({})` -- the repository's own bound context --
 * and `findActiveAsOf` has no `tenantId` parameter through which a caller could supply one
 * (`.claude/rules/tenant-isolation.md`: "query-input types must not even have a `tenantId`
 * field"). The read runs inside `withTenant`, so the RLS policy on `"Meter"` is active as well;
 * belt and braces, neither alone.
 *
 * Every date predicate goes through the Prisma ORM, never `$queryRaw`. That is measured rather
 * than stylistic: on this host PostgreSQL runs `TimeZone = Asia/Kolkata` while CI runs `UTC`,
 * and all 20 application timestamp columns are `timestamp(3) without time zone`. A bound JS
 * `Date` in raw SQL is a `timestamptz` and resolves through the *session* zone -- Gate 1
 * measured an ORM `findUnique` finding its row under all four of `UTC`, `Asia/Kolkata`,
 * `America/New_York` and `Asia/Kathmandu`, and the equivalent `$queryRaw` equality finding it
 * under `UTC` only. See `CLAUDE.md` § *Raw SQL and timestamps* (S-18).
 */
export class MeterRepository extends TenantScopedRepository {
  /**
   * The meters in force at `asOf` for the given keys, at most one per key.
   *
   * "In force" is `activeFrom <= asOf` and `activeTo` either open or strictly later, so a meter
   * whose `activeTo` falls exactly on `asOf` has already expired. Where a tenant has several
   * in-force rows for one key -- the rate-change case -- the newest `activeFrom` wins.
   */
  async findActiveAsOf(metricKeys: readonly string[], asOf: Date): Promise<ActiveMeter[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx.meter.findMany({
        where: this.where({
          metricKey: { in: [...metricKeys] },
          activeFrom: { lte: asOf },
          OR: [{ activeTo: null }, { activeTo: { gt: asOf } }]
        }),
        orderBy: { activeFrom: "desc" },
        select: { metricKey: true, unitPrice: true, currency: true }
      });

      const newestByKey = new Map<string, ActiveMeter>();
      for (const row of rows) {
        if (!newestByKey.has(row.metricKey)) {
          newestByKey.set(row.metricKey, {
            metricKey: row.metricKey,
            unitPrice: String(row.unitPrice),
            currency: row.currency
          });
        }
      }

      return [...newestByKey.values()];
    });
  }
}
