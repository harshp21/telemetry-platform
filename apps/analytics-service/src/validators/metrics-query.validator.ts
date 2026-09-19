import { z } from "zod";
import { iso8601Schema } from "@telemetry/shared-validation";
import { ANALYTICS_GRANULARITY, ANALYTICS_METRICS } from "../constants";

/**
 * Granularity enum for `GET /v1/analytics/metrics`.
 *
 * The parsed value is the **sole key** used to look up a constant `Prisma.Sql` fragment in
 * `RollupRepository` -- a frozen map with zero interpolation -- so an unvalidated string can
 * never contribute SQL text. That is the whole reason this is a closed enum rather than a
 * `z.string()`, and `AM5` is the case that pins it.
 *
 * Lowercase, matching `usageSummaryGranularitySchema` in usage-service exactly. The uppercase
 * spelling belongs to `MetricRollup.granularity`'s Prisma enum and is **rejected** here (plan
 * decision D5): accepting both would make two endpoints over the same rows disagree about what
 * a granularity is called.
 */
export const analyticsGranularitySchema = z.enum([
  ANALYTICS_GRANULARITY.HOUR,
  ANALYTICS_GRANULARITY.DAY,
  ANALYTICS_GRANULARITY.WEEK
]);

export type AnalyticsGranularity = z.infer<typeof analyticsGranularitySchema>;

/**
 * Query contract for `GET /v1/analytics/metrics`.
 *
 * - `from` is inclusive, `to` is exclusive, both ISO-8601 and both permitted to carry an
 *   offset. They are **not** normalized here: `utcTimestampBound` in the repository is the one
 *   place an instant is resolved to UTC, and moving that here would put the responsibility
 *   somewhere no docblock describes.
 * - `page` / `pageSize` are coerced from querystring strings and defaulted here, so every
 *   downstream layer receives concrete numbers.
 * - Both are **rejected rather than clamped** when out of range, so a client cannot silently
 *   receive a different page than it asked for.
 *
 * `page` carries a maximum, which is the one place this schema diverges from the three
 * declarations S-40 records (plan decision D2). Without it `(page - 1) * pageSize` reaches the
 * raw `OFFSET` bind and PostgreSQL answers `22003 bigint out of range`, which Prisma surfaces
 * as `P2010` and the controller would turn into a `500`. See `ANALYTICS_METRICS.MAX_PAGE` for
 * why the ceiling is 10 000 rather than the largest arithmetically safe value.
 */
export const metricsQuerySchema = z
  .object({
    from: iso8601Schema,
    to: iso8601Schema,
    granularity: analyticsGranularitySchema,
    // Rejected when empty rather than treated as absent: under plan decision D3 the presence
    // of a metric filter is what decides whether a request may write the cache, so
    // `?metricKey=` must not quietly mean "every metric".
    metricKey: z.string().min(1).optional(),
    page: z.coerce
      .number()
      .int()
      .min(ANALYTICS_METRICS.MIN_PAGE)
      .max(ANALYTICS_METRICS.MAX_PAGE)
      .default(ANALYTICS_METRICS.DEFAULT_PAGE),
    pageSize: z.coerce
      .number()
      .int()
      .min(ANALYTICS_METRICS.MIN_PAGE_SIZE)
      .max(ANALYTICS_METRICS.MAX_PAGE_SIZE)
      .default(ANALYTICS_METRICS.DEFAULT_PAGE_SIZE)
  })
  .refine(({ from, to }) => new Date(from).getTime() < new Date(to).getTime(), {
    message: ANALYTICS_METRICS.MESSAGE_INVALID_RANGE,
    path: ["to"]
  });

export type MetricsQuery = z.infer<typeof metricsQuerySchema>;
