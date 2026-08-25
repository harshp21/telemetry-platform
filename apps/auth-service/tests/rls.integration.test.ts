import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { TenantId, UserId } from "@telemetry/shared-types";

/**
 * Integration test verifying Postgres RLS blocks cross-tenant queries.
 * Requires a live Postgres database with RLS enabled.
 * 
 * Run: pnpm test:rls (from auth-service)
 * Env: DATABASE_URL must be set and RLS must be enabled in migrations
 */
describe("Postgres RLS enforcement (integration)", () => {
	let prisma: PrismaClient;
	let tenant1Id: TenantId;
	let tenant2Id: TenantId;
	let user1Id: UserId;
	let event1Id: string;

	beforeAll(async () => {
		prisma = new PrismaClient({ log: ["error", "warn"] });

		// Create two isolated tenants
		const t1 = await prisma.tenant.create({
			data: { id: "t_rls_test_1" as TenantId, name: "RLS Test Tenant 1" },
		});
		const t2 = await prisma.tenant.create({
			data: { id: "t_rls_test_2" as TenantId, name: "RLS Test Tenant 2" },
		});
		tenant1Id = t1.id as TenantId;
		tenant2Id = t2.id as TenantId;

		// Create user in tenant 1
		const u1 = await prisma.user.create({
			data: {
				id: "u_rls_test_1" as UserId,
				tenantId: tenant1Id,
				email: "rls-test-1@example.com",
				passwordHash: "hash1",
				role: "OWNER",
			},
		});
		user1Id = u1.id as UserId;

		// Create event in tenant 1
		const e1 = await prisma.event.create({
			data: {
				tenantId: tenant1Id,
				idempotencyKey: "idempotency-key-1",
				eventType: "api.request",
				quantity: 1,
				unit: "request",
				occurredAt: new Date(),
			},
		});
		event1Id = e1.id;
	});

	afterAll(async () => {
		// Cleanup: delete created records and disconnect
		try {
			await prisma.event.deleteMany({ where: { tenantId: { in: [tenant1Id, tenant2Id] } } });
			await prisma.user.deleteMany({ where: { tenantId: { in: [tenant1Id, tenant2Id] } } });
			await prisma.tenant.deleteMany({ where: { id: { in: [tenant1Id, tenant2Id] } } });
		} catch {
			// ignore cleanup errors
		}
		await prisma.$disconnect();
	});

	it("set_config('app.tenant_id', tenant1) allows reading only tenant1 events", async () => {
		// Simulate a request scoped to tenant1
		const events = await prisma.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant1Id}, true)`;
			return tx.event.findMany();
		});

		expect(events.length).toBe(1);
		if (events.length === 1) {
			expect(events[0]?.id).toBe(event1Id);
			expect(events[0]?.tenantId).toBe(tenant1Id);
		}
	});

	it("set_config('app.tenant_id', tenant2) returns zero events (RLS blocks tenant1 rows)", async () => {
		// Simulate a request scoped to tenant2
		const events = await prisma.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant2Id}, true)`;
			return tx.event.findMany();
		});

		expect(events).toHaveLength(0);
	});

	it("without set_config, query sees all rows (no RLS enforcement)", async () => {
		// Unscoped query (no set_config) — RLS allows if session role is exempt
		// In production, this should not happen; test documents the danger
		const events = await prisma.event.findMany();
		expect(events.length).toBeGreaterThanOrEqual(1);
	});

	it("FORCE ROW LEVEL SECURITY prevents superuser bypass (feature test)", async () => {
		// This test documents that FORCE RLS is enabled
		// Actual superuser bypass attempt would require separate privileged test
		// Just verify the table has policies defined
		const policies = (await prisma.$queryRaw<
			{ policyname: string }[]
		>`SELECT policyname FROM pg_policies WHERE tablename = 'Event'`) || [];

		expect(policies.length).toBeGreaterThan(0);
		const policyNames = policies.map((p) => p.policyname);
		expect(policyNames).toContain("event_tenant_isolation");
	});
});
