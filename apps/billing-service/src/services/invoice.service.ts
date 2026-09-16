import type { Logger } from "pino";
import type { PaginatedResult, TenantId } from "@telemetry/shared-types";
import type { InvoiceHeader } from "../repositories/invoice.repository";
import type { InvoiceRepositoryFactory } from "./billing.service";
import type { InvoiceListQuery } from "../validators/invoice-list.validator";

/**
 * Read side of billing: one page of a tenant's invoice headers.
 *
 * Mirrors `apps/usage-service/src/services/usage.service.ts` -- resolve a tenant-scoped
 * repository from the injected factory, delegate, and wrap the result in the shared pagination
 * envelope. The factory is injected rather than the repository because `tenantId` is a
 * constructor argument of `TenantScopedRepository`: a singleton would pin one tenant
 * process-wide (`.claude/rules/tenant-isolation.md`).
 *
 * **No pagination arithmetic happens here.** The validator has already applied the defaults
 * and the bounds, and the repository turns `page`/`pageSize` into `skip`/`take`. This layer
 * echoes the effective values back so the client can see what it was actually served;
 * computing `skip` here as well would page twice as far.
 *
 * Repository failures propagate unchanged -- `BillingController` owns the mapping to a status.
 */
export class InvoiceService {
  constructor(
    private readonly createInvoiceRepository: InvoiceRepositoryFactory,
    private readonly logger: Logger
  ) {}

  async listInvoices(
    tenantId: TenantId,
    query: InvoiceListQuery
  ): Promise<PaginatedResult<InvoiceHeader>> {
    const repository = this.createInvoiceRepository(tenantId);

    const { items, total } = await repository.listInvoices({
      status: query.status,
      page: query.page,
      pageSize: query.pageSize
    });

    this.logger.debug(
      { tenantId, status: query.status, page: query.page, pageSize: query.pageSize, total },
      "Invoice list read"
    );

    return {
      items: [...items],
      total,
      page: query.page,
      pageSize: query.pageSize
    };
  }
}
