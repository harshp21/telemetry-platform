import type { Logger } from "pino";
import type { PaginatedResult, TenantId } from "@telemetry/shared-types";
import type { InvoiceDetail, InvoiceHeader } from "../repositories/invoice.repository";
import type { InvoiceDetailParams } from "../validators/invoice-detail.validator";
import { InvoiceNotFoundError } from "../errors";
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

  /**
   * One invoice of the requesting tenant, with its line items (T-047).
   *
   * The repository comes from the injected factory, bound to the tenant the middleware
   * validated -- never constructed here, because `tenantId` is a constructor argument of
   * `TenantScopedRepository` and a singleton would pin one tenant process-wide
   * (`.claude/rules/tenant-isolation.md`). The invoice id is caller-supplied; the tenant is
   * not. That asymmetry is the whole design: the id selects a row *within* a scope the caller
   * does not choose.
   *
   * **`null` becomes `InvoiceNotFoundError`, and that is the only mapping this layer makes.**
   * The repository answers `null` for an unknown id and for another tenant's id alike -- its
   * read carries the tenant predicate and runs under an RLS context, so a foreign row is
   * neither returned nor counted -- so one error for both is what the data supports, not a
   * simplification. Telling them apart would need a second, unscoped read: a cross-tenant
   * existence oracle, which is exactly what the epic's own "do not leak existence" asks to
   * avoid. Any other repository failure propagates unchanged; `BillingController` owns the
   * mapping to a status.
   */
  async getInvoice(tenantId: TenantId, params: InvoiceDetailParams): Promise<InvoiceDetail> {
    const repository = this.createInvoiceRepository(tenantId);

    const invoice = await repository.findDetailById(params.id);

    if (invoice === null) {
      throw new InvoiceNotFoundError();
    }

    this.logger.debug(
      { tenantId, invoiceId: invoice.id, lineItems: invoice.lineItems.length },
      "Invoice detail read"
    );

    return invoice;
  }
}
