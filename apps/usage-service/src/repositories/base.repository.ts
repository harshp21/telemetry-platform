import type { PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";

type TransactionClient = Omit<
	PrismaClient,
	"$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

interface Logger {
	error(obj: unknown, msg: string): void;
	debug(obj: unknown, msg: string): void;
}

/**
 * Abstract base class for all tenant-scoped repositories.
 *
 * Enforces multi-tenant data isolation via two layers:
 *
 * 1. **Application layer** — `where()` helper merges `tenantId` into all query conditions.
 *    Prevents accidental cross-tenant queries; caught at query time.
 *
 * 2. **Database layer** — `withTenant()` calls `set_config('app.tenant_id', tenantId)`,
 *    activating Postgres Row-Level Security (RLS) policies.
 *    Prevents data leaks even if application code is compromised.
 *
 * ## Usage Pattern
 *
 * ```ts
 * class EventRepository extends TenantScopedRepository {
 *   async findByType(eventType: string) {
 *     return this.withTenant(async (tx) => {
 *       return tx.event.findMany({
 *         where: this.where({ eventType }),
 *       });
 *     });
 *   }
 * }
 *
 * // In a route handler:
 * const repo = new EventRepository(prisma, req.auth.tenantId, logger);
 * const events = await repo.findByType("api.request");
 * // App layer: where() ensures WHERE tenantId = req.auth.tenantId
 * // DB layer: RLS policy blocks any row where row.tenantId != app.tenant_id
 * // Error layer: transaction failures logged with tenant context
 * ```
 *
 * ## Security Properties
 *
 * - ✅ `where()` compile-error if caller tries to pass `tenantId` (via `{ tenantId?: never }` constraint)
 * - ✅ `withTenant()` scopes RLS context to transaction only (`is_local = true`)
 * - ✅ RLS policies use FORCE RLS to prevent superuser bypass
 * - ✅ Transaction errors logged with tenant context for observability
 * - ✅ Two-layer defense: app + DB isolation
 *
 * ## Non-Goals
 *
 * - Compile-time enforcement of `withTenant()` wrapper — code review catch
 * - Auto-wrapping of all queries — developer responsibility
 */
export abstract class TenantScopedRepository {
	protected readonly logger: Logger;

	constructor(
		protected readonly prisma: PrismaClient,
		protected readonly tenantId: TenantId,
		logger?: Logger
	) {
		this.logger =
			logger ||
			{
				error: (obj: unknown, msg: string) => {
					const context = typeof obj === "object" && obj !== null ? obj : { error: obj };
					console.error({ ...context, tenantId }, msg);
				},
				debug: (obj: unknown, msg: string) => {
					const context = typeof obj === "object" && obj !== null ? obj : { data: obj };
					console.warn({ ...context, tenantId }, msg);
				},
			};
	}

	protected where<T extends { tenantId?: never } & Record<string, unknown>>(
		conditions: T
	): Omit<T, "tenantId"> & { tenantId: TenantId } {
		return { ...conditions, tenantId: this.tenantId };
	}

	// Sets app.tenant_id for the duration of the transaction so Postgres RLS policies fire.
	protected async withTenant<T>(
		fn: (tx: TransactionClient) => Promise<T>
	): Promise<T> {
		try {
			this.logger.debug({ operation: "transaction_start" }, "Starting tenant-scoped transaction");
			const result = await this.prisma.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT set_config('app.tenant_id', ${this.tenantId}, true)`;
				return fn(tx);
			});
			this.logger.debug({ operation: "transaction_commit" }, "Tenant-scoped transaction committed");
			return result;
		} catch (err) {
			this.logger.error(
				{ operation: "transaction_rollback", error: err instanceof Error ? err.message : String(err) },
				"Tenant-scoped transaction failed and was rolled back"
			);
			throw err;
		}
	}
}
