import type { PrismaClient, Prisma } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";

export abstract class TenantScopedRepository {
	constructor(
		protected readonly prisma: PrismaClient,
		protected readonly tenantId: TenantId
	) {}

	protected where<T extends { tenantId?: never } & Record<string, unknown>>(
		conditions: T
	): Omit<T, "tenantId"> & { tenantId: TenantId } {
		return { ...conditions, tenantId: this.tenantId };
	}

	// Sets app.tenant_id for the duration of the transaction so Postgres RLS policies fire.
	protected async withTenant<T>(
		fn: (tx: Prisma.TransactionClient) => Promise<T>
	): Promise<T> {
		return this.prisma.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT set_config('app.tenant_id', ${this.tenantId}, true)`;
			return fn(tx);
		});
	}
}
