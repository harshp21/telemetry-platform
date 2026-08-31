import { Prisma } from "@prisma/client";
import { TenantScopedRepository } from "./base.repository";
import type { UsageSummaryGranularity } from "../validators/usage-summary.validator";
import { USAGE_SUMMARY_GRANULARITY } from "../constants";

export interface UsageSummaryQueryInput {
  /** Inclusive lower bound, ISO-8601. */
  readonly from: string;
  /** Exclusive upper bound, ISO-8601. */
  readonly to: string;
  readonly granularity: UsageSummaryGranularity;
  readonly metricKey?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface UsageSummaryRow {
  readonly metricKey: string;
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly totalQuantity: string;
}

export interface UsageSummaryAggregate {
  readonly rows: UsageSummaryRow[];
  /** Number of GROUPED rows in the range, not the number of underlying usage lines. */
  readonly total: number;
}

interface RawUsageSummaryRow {
  metricKey: string;
  bucketStart: Date | string;
  bucketEnd: Date | string;
  totalQuantity: Prisma.Decimal | string | number;
}

interface RawGroupedCountRow {
  total: number;
}

/**
 * Fixed SQL bucket fragments, keyed by the validated granularity enum.
 *
 * Every fragment is a constant template with zero interpolation, so a caller-supplied
 * granularity can only ever select a fragment — it can never contribute SQL text.
 *
 * `periodStart` is `TIMESTAMP(3)` (without time zone) and Prisma persists UTC, so
 * `DATE_TRUNC` yields UTC bucket boundaries with no `AT TIME ZONE` conversion.
 * Week buckets therefore follow Postgres ISO-8601 semantics: they start on Monday
 * 00:00:00 UTC.
 */
const GRANULARITY_SQL: Readonly<
  Record<UsageSummaryGranularity, { readonly bucketStart: Prisma.Sql; readonly bucketEnd: Prisma.Sql }>
> = {
  [USAGE_SUMMARY_GRANULARITY.HOUR]: {
    bucketStart: Prisma.sql`DATE_TRUNC('hour', "periodStart")`,
    bucketEnd: Prisma.sql`DATE_TRUNC('hour', "periodStart") + INTERVAL '1 hour'`
  },
  [USAGE_SUMMARY_GRANULARITY.DAY]: {
    bucketStart: Prisma.sql`DATE_TRUNC('day', "periodStart")`,
    bucketEnd: Prisma.sql`DATE_TRUNC('day', "periodStart") + INTERVAL '1 day'`
  },
  [USAGE_SUMMARY_GRANULARITY.WEEK]: {
    bucketStart: Prisma.sql`DATE_TRUNC('week', "periodStart")`,
    bucketEnd: Prisma.sql`DATE_TRUNC('week', "periodStart") + INTERVAL '1 week'`
  }
};

const toIsoString = (value: Date | string): string => new Date(value).toISOString();

/** Decimal(18,6) exceeds IEEE-754 safe precision, so quantities cross the API as strings. */
const toQuantityString = (value: Prisma.Decimal | string | number): string => String(value);

/**
 * Tenant-scoped aggregation over persisted usage lines.
 *
 * Both the grouped-row count and the paginated page run inside a single
 * `withTenant` transaction (which activates the Postgres RLS context) and each
 * carries an explicit `tenantId` predicate as a second, application-level guard.
 */
export class UsageRepository extends TenantScopedRepository {
  async aggregateSummary(input: UsageSummaryQueryInput): Promise<UsageSummaryAggregate> {
    const bucket = GRANULARITY_SQL[input.granularity];
    const filters = this.buildFilters(input);
    const offset = (input.page - 1) * input.pageSize;

    return this.withTenant(async (tx) => {
      const countRows = await tx.$queryRaw<RawGroupedCountRow[]>(
        Prisma.sql`SELECT COUNT(*)::int AS "total" FROM (SELECT 1 FROM "UsageLine" ${filters} GROUP BY "metricKey", ${bucket.bucketStart}) AS "grouped"`
      );

      const pageRows = await tx.$queryRaw<RawUsageSummaryRow[]>(
        Prisma.sql`SELECT "metricKey" AS "metricKey", ${bucket.bucketStart} AS "bucketStart", ${bucket.bucketEnd} AS "bucketEnd", SUM("quantity") AS "totalQuantity" FROM "UsageLine" ${filters} GROUP BY "metricKey", ${bucket.bucketStart}, ${bucket.bucketEnd} ORDER BY ${bucket.bucketStart} ASC, "metricKey" ASC LIMIT ${input.pageSize} OFFSET ${offset}`
      );

      return {
        rows: pageRows.map((row) => ({
          metricKey: row.metricKey,
          bucketStart: toIsoString(row.bucketStart),
          bucketEnd: toIsoString(row.bucketEnd),
          totalQuantity: toQuantityString(row.totalQuantity)
        })),
        total: countRows[0]?.total ?? 0
      };
    });
  }

  private buildFilters(input: UsageSummaryQueryInput): Prisma.Sql {
    // Derived through the base helper so the tenant predicate can only ever be
    // the repository's own tenant, never a caller-supplied value.
    const { tenantId } = this.where({});
    const metricKeyFilter = input.metricKey
      ? Prisma.sql`AND "metricKey" = ${input.metricKey}`
      : Prisma.empty;

    return Prisma.sql`WHERE "tenantId" = ${tenantId} AND "periodStart" >= ${new Date(input.from)} AND "periodStart" < ${new Date(input.to)} ${metricKeyFilter}`;
  }
}
