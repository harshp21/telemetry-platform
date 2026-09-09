import { Prisma } from "@prisma/client";
import { TenantScopedRepository } from "./base.repository";
import type { UsageSummaryGranularity } from "../validators/usage-summary.validator";
import { DATABASE_SQL, USAGE_SUMMARY_GRANULARITY } from "../constants";

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
 * `DATE_TRUNC` yields UTC bucket boundaries with no `AT TIME ZONE` conversion — measured
 * under four session zones, all returning the same instant. Week buckets therefore follow
 * Postgres ISO-8601 semantics: they start on Monday 00:00:00 UTC.
 *
 * The output side is safe; only the range predicate was not (S-18), and the two must not be
 * confused. `AT TIME ZONE 'UTC'` applied to this COLUMN would produce a `timestamptz` and
 * shift every boundary by the server offset. Applied to a bound PARAMETER it is correct and
 * equivalent to the `::timestamp(3)` cast in `utcTimestampBound`. Fix the bound, never the
 * column.
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

/**
 * Cast applied to every timestamp bound in this repository's raw SQL.
 *
 * Module-level binding, built once at import from `DATABASE_SQL.UTC_NAIVE_TIMESTAMP_CAST`. It
 * never derives from caller input, which is the one case `Prisma.raw` is permitted for (see
 * "Raw SQL" in CLAUDE.md); the same shape as
 * `apps/auth-service/src/repositories/user.repository.ts`'s `RESOLVER_FUNCTIONS`. (`const`
 * pins the binding, not the object `Prisma.raw` returns — nothing here mutates it.)
 *
 * **Deliberately not exported.** The fragment on its own is half of a fix: applied to an
 * un-normalized request string it discards the offset rather than converting it, so it is
 * wrong in every session zone including UTC. Keeping it module-private makes the fragment
 * un-importable, which raises the cost of that mistake from one `import` to typing the cast
 * out by hand — it does not make the shape unwritable, because the cast is only SQL text.
 */
const UTC_NAIVE_TIMESTAMP_CAST = Prisma.raw(DATABASE_SQL.UTC_NAIVE_TIMESTAMP_CAST);

/**
 * The only shape allowed to compare an instant against a naive timestamp column here.
 *
 * `"UsageLine"."periodStart"` is `timestamp(3) without time zone`, and Prisma binds a JS
 * `Date` in `$queryRaw` as `timestamptz` (measured: `SELECT pg_typeof(${new Date(...)})`
 * returns `timestamp with time zone`). Comparing the two resolves through the database
 * SESSION time zone, so `>= ${new Date(input.from)}` returns different rows on different
 * servers — `{r2,r3,r4,r5}` under `UTC` but `{r4,r5,r6}` under `Asia/Kolkata` for the same
 * request (S-18). Prisma's ORM path does not have this problem — `where: { gte, lt }` was
 * measured UTC-stable across four session zones, inside and outside `$transaction`. Why it
 * differs is inferred, not measured: the logged parameter form suggests the engine resolves
 * the bound against the column type it has from the schema. Either way the *behaviour* is
 * established, and `$queryRaw` does not share it, so the bound must say what it means.
 *
 * Two steps, and both are load-bearing:
 *
 * 1. `new Date(iso).toISOString()` resolves the instant **in JavaScript**. `from`/`to` are
 *    validated by `iso8601Schema` (`z.string().datetime({ offset: true })`), so a caller may
 *    legally send `2026-01-01T00:00:00+05:30`. Casting that string directly would be wrong:
 *    PostgreSQL's text -> timestamp cast DISCARDS the offset rather than converting it
 *    (measured: `'2026-01-01T00:00:00.000+05:30'::timestamp(3)` -> `2026-01-01 00:00:00`),
 *    which would trade a session-dependent bug for an offset-dependent one.
 * 2. `::timestamp(3)` makes the bound naive, so the comparison is UTC-to-UTC and the session
 *    zone cannot enter it.
 *
 * Keeping both in one function is what bounds the blast radius, and the guarantee is exactly
 * this: the cast fragment is not importable outside this module — that much is
 * compiler-enforced (`TS2459`) — and `utcTimestampBound` is the only in-module path to it.
 * The half-fixed *shape* is still writable anywhere, here or in another file, because the
 * cast is only SQL text: `${iso}::timestamp(3)` needs no import. The rule "every timestamp
 * bound goes through `utcTimestampBound`" is carried by review, not by the type system.
 *
 * Omitting the cast entirely does not fail silently, so it is the safe mistake. Prisma binds
 * an ISO string as `text` (measured: `SELECT pg_typeof(${iso})::text` -> `text`), and an
 * uncast bound string raises `42883`, surfaced by Prisma as `P2010` with
 * `meta.code = "42883"`. The message names the operands in the order they appear in the SQL,
 * so for this predicate — column on the left — it reads
 * `operator does not exist: timestamp without time zone >= text`. Measured in four forms:
 * `$queryRaw` with the column left and with the bound left (which reverses the message to
 * `text <= timestamp without time zone`), and the same two through `psql`, once as
 * `'…'::text` and once as `PREPARE p(text)`. Note an *unquoted* SQL literal does not error —
 * it is `unknown`-typed and coerces — so the loudness depends on the bind being `text`.
 */
const utcTimestampBound = (isoInstant: string): Prisma.Sql =>
  Prisma.sql`${new Date(isoInstant).toISOString()}${UTC_NAIVE_TIMESTAMP_CAST}`;

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

    // Half-open `[from, to)` in UTC. Both bounds go through `utcTimestampBound`, never as a
    // JS Date — see that helper for why a Date here is a cross-server correctness bug.
    return Prisma.sql`WHERE "tenantId" = ${tenantId} AND "periodStart" >= ${utcTimestampBound(input.from)} AND "periodStart" < ${utcTimestampBound(input.to)} ${metricKeyFilter}`;
  }
}
