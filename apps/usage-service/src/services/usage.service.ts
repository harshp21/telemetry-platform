import type { Logger } from "pino";
import type { PaginatedResult } from "@telemetry/shared-types";
import type { UsageRepository, UsageSummaryRow } from "../repositories/usage.repository";
import type { UsageSummaryQuery } from "../validators/usage-summary.validator";

export type UsageSummaryItem = UsageSummaryRow;

/**
 * Builds a repository bound to a single tenant. Tenant-scoped repositories are
 * per-request by design, so the container injects a factory instead of a singleton.
 */
export type UsageRepositoryFactory = (tenantId: string) => UsageRepository;

/**
 * Orchestrates usage summary reads: resolves a tenant-scoped repository, delegates
 * the aggregation, and wraps the result in the shared pagination envelope.
 *
 * Pagination defaults are already applied by the validator, so this layer only
 * echoes the effective page/pageSize back to the caller. Repository failures are
 * propagated unchanged and normalized by the controller.
 */
export class UsageService {
  constructor(
    private readonly createUsageRepository: UsageRepositoryFactory,
    private readonly logger: Logger
  ) {}

  async getUsageSummary(
    tenantId: string,
    query: UsageSummaryQuery
  ): Promise<PaginatedResult<UsageSummaryItem>> {
    const repository = this.createUsageRepository(tenantId);

    const { rows, total } = await repository.aggregateSummary({
      from: query.from,
      to: query.to,
      granularity: query.granularity,
      metricKey: query.metricKey,
      page: query.page,
      pageSize: query.pageSize
    });

    this.logger.debug(
      {
        tenantId,
        granularity: query.granularity,
        page: query.page,
        pageSize: query.pageSize,
        total
      },
      "Usage summary aggregated"
    );

    return {
      items: rows,
      total,
      page: query.page,
      pageSize: query.pageSize
    };
  }
}
