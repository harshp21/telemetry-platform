import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { TenantId, UserId } from "@telemetry/shared-types";

/**
 * Proves PostgreSQL Row-Level Security actually blocks cross-tenant reads of `Event`.
 *
 * Every assertion runs `event.findMany()` with **no application `where: { tenantId }`
 * predicate**, so the only thing that can restrict the result set is the database.
 *
 * Two connections, deliberately:
 *   - `admin`  (DIRECT_DATABASE_URL)      seeds and cleans up. Seeding is itself subject to
 *                                         RLS as a restricted role, so it cannot be done
 *                                         through the connection under test.
 *   - `probe`  (RLS_PROBE_DATABASE_URL)   the role under test — NOSUPERUSER, NOBYPASSRLS.
 *
 * The probe role is used rather than auth-service's own `DATABASE_URL` because auth-service
 * still runs as the admin role: its login path queries `User` before a tenant is known and
 * registration inserts a `Tenant` before one exists, neither of which survives RLS. That is
 * tracked as S-7 in `.claude/rules/known-gaps.md`. The policies themselves are correct and
 * provable today, which is what this suite establishes.
 *
 * This suite does **not** skip when the environment is wrong. A guard that fires precisely
 * when the bug is present is an inverted signal, not a safety net — that was S-3, and these
 * assertions sat green and vacuous behind one for exactly that reason. If the probe role is
 * a superuser or holds BYPASSRLS, the suite fails loudly.
 */

const APP_TENANT_ID_SETTING = "app.tenant_id";
const ADMIN_URL_FALLBACK = "postgresql://postgres:postgres@localhost:5432/telemetry";
const PROBE_URL_FALLBACK =
	"postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry";

interface RoleAttributes {
	readonly rolname: string;
	readonly rolsuper: boolean;
	readonly rolbypassrls: boolean;
}

const requireEnv = (name: string, fallback: string): string =>
	process.env[name] ?? fallback;

describe("Postgres RLS enforcement on Event (integration)", () => {
	const suiteId = randomUUID();
	const tenant1Id = `t_rls_1_${suiteId}` as TenantId;
	const tenant2Id = `t_rls_2_${suiteId}` as TenantId;

	let admin: PrismaClient;
	let probe: PrismaClient;
	let probeRole: RoleAttributes | undefined;
	let event1Id: string;

	beforeAll(async () => {
		admin = new PrismaClient({
			datasourceUrl: requireEnv("DIRECT_DATABASE_URL", ADMIN_URL_FALLBACK),
			log: ["error"]
		});
		probe = new PrismaClient({
			datasourceUrl: requireEnv("RLS_PROBE_DATABASE_URL", PROBE_URL_FALLBACK),
			log: ["error"]
		});

		const roles = await probe.$queryRaw<RoleAttributes[]>`
			SELECT r.rolname, r.rolsuper, r.rolbypassrls
			FROM pg_roles r
			WHERE r.rolname = current_user
		`;
		probeRole = roles[0];

		// Seed through the admin connection: as the probe role these inserts are themselves
		// subject to the policies under test.
		await admin.tenant.create({
			data: { id: tenant1Id, name: "RLS Test Tenant 1" }
		});
		await admin.tenant.create({
			data: { id: tenant2Id, name: "RLS Test Tenant 2" }
		});
		await admin.user.create({
			data: {
				id: `u_rls_1_${suiteId}` as UserId,
				tenantId: tenant1Id,
				firstName: "Rls",
				lastName: "User",
				email: `rls-${suiteId}@example.com`,
				passwordHash: "hash1",
				role: "OWNER"
			}
		});
		const event1 = await admin.event.create({
			data: {
				tenantId: tenant1Id,
				idempotencyKey: `idem-${suiteId}`,
				eventType: "api.request",
				quantity: 1,
				unit: "request",
				occurredAt: new Date()
			}
		});
		event1Id = event1.id;
	});

	afterAll(async () => {
		try {
			await admin.event.deleteMany({
				where: { tenantId: { in: [tenant1Id, tenant2Id] } }
			});
			await admin.user.deleteMany({
				where: { tenantId: { in: [tenant1Id, tenant2Id] } }
			});
			await admin.tenant.deleteMany({ where: { id: { in: [tenant1Id, tenant2Id] } } });
		} catch {
			// ignore cleanup errors
		}
		await admin.$disconnect();
		await probe.$disconnect();
	});

	it("runs as a role that cannot bypass RLS (guards the whole suite)", () => {
		expect(probeRole, "probe role could not be resolved").toBeDefined();
		expect(probeRole?.rolsuper, `${probeRole?.rolname} is a superuser`).toBe(false);
		expect(probeRole?.rolbypassrls, `${probeRole?.rolname} holds BYPASSRLS`).toBe(false);
	});

	it("with tenant1 context, reads only tenant1 events", async () => {
		const events = await probe.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT set_config(${APP_TENANT_ID_SETTING}, ${tenant1Id}, true)`;
			return tx.event.findMany();
		});

		expect(events).toHaveLength(1);
		expect(events[0]?.id).toBe(event1Id);
		expect(events[0]?.tenantId).toBe(tenant1Id);
	});

	it("with tenant2 context, reads zero events (RLS blocks tenant1 rows)", async () => {
		const events = await probe.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT set_config(${APP_TENANT_ID_SETTING}, ${tenant2Id}, true)`;
			return tx.event.findMany();
		});

		expect(events).toHaveLength(0);
	});

	it("without tenant context, reads zero rows", async () => {
		// Previously asserted `>= 1` — i.e. it encoded the S-2 vulnerability (a connection
		// that bypasses RLS sees everything) as expected behaviour. With RLS actually
		// enforcing, an unscoped query must return nothing.
		const events = await probe.event.findMany();

		expect(events).toHaveLength(0);
	});

	it("has RLS enabled and FORCEd on Event, with the tenant isolation policy present", async () => {
		const [table] = await probe.$queryRaw<
			{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]
		>`
			SELECT c.relrowsecurity, c.relforcerowsecurity
			FROM pg_class c
			WHERE c.relname = 'Event'
		`;

		expect(table?.relrowsecurity, "RLS is not ENABLEd on Event").toBe(true);
		expect(table?.relforcerowsecurity, "RLS is not FORCEd on Event").toBe(true);

		const policies = await probe.$queryRaw<{ policyname: string }[]>`
			SELECT policyname FROM pg_policies WHERE tablename = 'Event'
		`;

		expect(policies.map((p) => p.policyname)).toContain("event_tenant_isolation");
	});
});
