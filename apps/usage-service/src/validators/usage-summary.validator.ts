import { z } from "zod";
import { iso8601Schema } from "@telemetry/shared-validation";
import { USAGE_SUMMARY_CONSTANTS, USAGE_SUMMARY_GRANULARITY } from "../constants";

/**
 * Granularity enum for GET /v1/usage/summary.
 *
 * The parsed value is the sole key used to look up a hard-coded SQL bucket
 * fragment in the repository; unvalidated strings never reach the SQL layer.
 */
export const usageSummaryGranularitySchema = z.enum([
  USAGE_SUMMARY_GRANULARITY.HOUR,
  USAGE_SUMMARY_GRANULARITY.DAY,
  USAGE_SUMMARY_GRANULARITY.WEEK
]);

export type UsageSummaryGranularity = z.infer<typeof usageSummaryGranularitySchema>;

/**
 * Query contract for GET /v1/usage/summary.
 *
 * - `from` is inclusive, `to` is exclusive, both ISO-8601 with offset.
 * - `page` / `pageSize` are coerced from querystring strings and defaulted here,
 *   so every downstream layer receives concrete numbers.
 * - `pageSize` above the maximum is rejected, not clamped, so clients cannot
 *   silently receive a different page size than they asked for.
 */
export const usageSummaryQuerySchema = z
  .object({
    from: iso8601Schema,
    to: iso8601Schema,
    granularity: usageSummaryGranularitySchema,
    metricKey: z.string().min(1).optional(),
    page: z.coerce
      .number()
      .int()
      .min(USAGE_SUMMARY_CONSTANTS.MIN_PAGE)
      .default(USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE),
    pageSize: z.coerce
      .number()
      .int()
      .min(USAGE_SUMMARY_CONSTANTS.MIN_PAGE_SIZE)
      .max(USAGE_SUMMARY_CONSTANTS.MAX_PAGE_SIZE)
      .default(USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE_SIZE)
  })
  .refine(({ from, to }) => new Date(from).getTime() < new Date(to).getTime(), {
    message: USAGE_SUMMARY_CONSTANTS.MESSAGE_INVALID_RANGE,
    path: ["to"]
  });

export type UsageSummaryQuery = z.infer<typeof usageSummaryQuerySchema>;
