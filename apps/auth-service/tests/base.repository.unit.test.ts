import { describe, expect, it, vi } from "vitest";
import type { PrismaClient, Prisma } from "@prisma/client";
import { TenantScopedRepository } from "../src/repositories/base.repository";
import type { TenantId } from "@telemetry/shared-types";

class TestRepository extends TenantScopedRepository {
	callWhere<T extends Record<string, unknown>>(conditions: T) {
		return this.where(conditions as T & { tenantId?: never });
	}
	callWithTenant<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
		return this.withTenant(fn);
	}
}

const mockPrisma = {} as unknown as PrismaClient;
const tenantId = "tenant-abc-123" as TenantId;
const mockLogger = {
	error: vi.fn(),
	debug: vi.fn(),
};

describe("TenantScopedRepository.where()", () => {
	const repo = new TestRepository(mockPrisma, tenantId, mockLogger);

	it("merges tenantId into empty conditions", () => {
		expect(repo.callWhere({})).toEqual({ tenantId });
	});

	it("merges tenantId into non-empty conditions", () => {
		expect(repo.callWhere({ eventType: "api.request", billed: false })).toEqual({
			eventType: "api.request",
			billed: false,
			tenantId,
		});
	});

	it("tenantId from where() matches constructor tenantId", () => {
		const result = repo.callWhere({ foo: "bar" });
		expect(result.tenantId).toBe(tenantId);
	});

	it("constructor tenantId always wins — caller cannot inject a different tenantId", () => {
		// spread order: conditions first, then tenantId — caller cannot override it
		const injected = "injected-tenant" as TenantId;
		const result = repo.callWhere({ status: "active", tenantId: injected } as Record<string, unknown>);
		expect(result.tenantId).toBe(tenantId);
	});
});

describe("TenantScopedRepository.withTenant()", () => {
	it("sets app.tenant_id via set_config before calling the callback", async () => {
		const queryRawMock = vi.fn().mockResolvedValue([]);
		const mockTx = { $queryRaw: queryRawMock } as unknown as Prisma.TransactionClient;
		const mockPrismaWithTx = {
			$transaction: vi.fn((fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(mockTx)),
		} as unknown as PrismaClient;
		const testLogger = { error: vi.fn(), debug: vi.fn() };

		const repo = new TestRepository(mockPrismaWithTx, tenantId, testLogger);
		const result = await repo.callWithTenant(async () => "ok");

		expect(mockPrismaWithTx.$transaction).toHaveBeenCalledOnce();
		expect(queryRawMock).toHaveBeenCalledOnce();
		expect(testLogger.debug).toHaveBeenCalledTimes(2); // start + commit
		expect(result).toBe("ok");
	});

	it("returns the value produced by the callback", async () => {
		const mockTx = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as Prisma.TransactionClient;
		const mockPrismaWithTx = {
			$transaction: vi.fn((fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(mockTx)),
		} as unknown as PrismaClient;
		const testLogger = { error: vi.fn(), debug: vi.fn() };

		const repo = new TestRepository(mockPrismaWithTx, tenantId, testLogger);
		const result = await repo.callWithTenant(async () => ({ id: "row-1" }));
		expect(result).toEqual({ id: "row-1" });
	});

	it("logs transaction errors with tenant context and re-throws", async () => {
		const testError = new Error("Query failed");
		const mockPrismaWithError = {
			$transaction: vi.fn().mockRejectedValue(testError),
		} as unknown as PrismaClient;
		const testLogger = { error: vi.fn(), debug: vi.fn() };

		const repo = new TestRepository(mockPrismaWithError, tenantId, testLogger);

		await expect(repo.callWithTenant(async () => "ok")).rejects.toThrow("Query failed");
		expect(testLogger.error).toHaveBeenCalledOnce();
		// Verify tenant context is included in error log
		const errorCall = (testLogger.error as any).mock.calls[0];
		expect(errorCall[0]).toMatchObject({ operation: "transaction_rollback" });
	});
});
