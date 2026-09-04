import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import type { TenantId, UserId } from "@telemetry/shared-types";
import { AUTH_DATABASE, AUTH_ROLES } from "../src/constants";
import { TEST_DATABASE_URLS } from "./database-urls";

/**
 * Proves PostgreSQL Row-Level Security actually blocks cross-tenant reads of `Tenant` and
 * `User` — the two tables auth-service owns the lifecycle of — **through auth-service's own
 * connection**, and that the pre-authentication tenant resolvers it depends on are narrow and
 * reachable by nothing else.
 *
 * Every isolation assertion runs `findMany()` with **no application `where: { tenantId }`
 * predicate**, so the only thing that can restrict the result set is the database.
 *
 * Two connections, deliberately:
 *   - `admin` (DIRECT_DATABASE_URL) seeds and cleans up. Seeding is itself subject to RLS as
 *     a restricted role, so it cannot be done through the connection under test.
 *   - `app`   (DATABASE_URL)        the connection under test — auth-service's own runtime
 *     role, `telemetry_auth_app`: NOSUPERUSER, NOBYPASSRLS, owner of no table.
 *
 * Until S-7 landed this suite used a separate `RLS_PROBE_DATABASE_URL` role, because
 * auth-service itself ran as the admin role and its own connection could prove nothing. It
 * now asserts through the connection the service actually uses, which is the point.
 *
 * This suite does **not** skip when the environment is wrong. A guard that fires precisely
 * when the bug is present is an inverted signal, not a safety net — that was S-3, and these
 * assertions sat green and vacuous behind one for exactly that reason. If the role under test
 * is a superuser or holds BYPASSRLS, or is not the role auth-service uses, `beforeAll` throws and
 * the whole file fails.
 *
 * One wrinkle worth knowing: vitest renders a `beforeAll` throw as `Tests N skipped (N)`, which
 * is cosmetically identical to the S-3 signature this comment disowns. The difference is the exit
 * code (1, not 0) and the thrown message above the summary. It is a hard failure, not a skip.
 */

/** Both resolvers take a single `text` argument; this completes their identity for the
 * `has_function_privilege` / `regprocedure` lookups below. */
const RESOLVER_ARGUMENT_TYPES = "(text)";
/** Any future date; the resolvers do not look at expiry, and nothing here consumes the token. */
const REFRESH_TOKEN_TTL_MS = 60 * 60 * 1000;
const RESOLVER_RETURN_TYPE = "text";
const EXECUTE_PRIVILEGE = "EXECUTE";
const PUBLIC_ROLE = "public";

interface RoleAttributes {
	readonly rolname: string;
	readonly rolsuper: boolean;
	readonly rolbypassrls: boolean;
	readonly rolcanlogin: boolean;
}

interface FunctionPrivilege {
	readonly public_can_execute: boolean;
	readonly auth_app_can_execute: boolean;
	readonly shared_app_can_execute: boolean;
}

interface PolicyRow {
	readonly policyname: string;
	readonly cmd: string;
	readonly roles: readonly string[];
}

interface FunctionShape {
	readonly result_type: string;
	readonly pronargs: number;
	readonly prosecdef: boolean;
	readonly owner: string;
}

/** Identifiers cannot be bound parameters; these are frozen module constants, never input. */
const EMAIL_RESOLVER_FRAGMENT = Prisma.raw(AUTH_DATABASE.RESOLVE_TENANT_BY_EMAIL_FN);
const TOKEN_RESOLVER_FRAGMENT = Prisma.raw(
	AUTH_DATABASE.RESOLVE_TENANT_BY_REFRESH_TOKEN_HASH_FN
);
const SELECT_COMMAND = "SELECT";
/**
 * The tenant-isolation policies from v1_0/v1_2. Named here rather than in `AUTH_DATABASE`:
 * they are not part of auth-service's own database contract, only of what this suite asserts.
 */
const TENANT_ISOLATION_POLICIES = {
	EVENT: "event_tenant_isolation",
	USER: "user_tenant_isolation"
} as const;

const envOrDefault = (name: string, fallback: string): string =>
	process.env[name] ?? fallback;

describe("Postgres RLS enforcement through auth-service's own connection (integration)", () => {
	const suiteId = randomUUID();
	const tenant1Id = `t_rls_1_${suiteId}` as TenantId;
	const tenant2Id = `t_rls_2_${suiteId}` as TenantId;
	const user1Email = `rls-1-${suiteId}@example.com`;
	const user2Email = `rls-2-${suiteId}@example.com`;
	const user1TokenHash = `rls-token-${suiteId}`;

	let admin: PrismaClient;
	let app: PrismaClient;
	let appRole: RoleAttributes | undefined;
	let user1Id: string;

	beforeAll(async () => {
		admin = new PrismaClient({
			datasourceUrl: envOrDefault("DIRECT_DATABASE_URL", TEST_DATABASE_URLS.ADMIN),
			log: ["error"]
		});
		app = new PrismaClient({
			datasourceUrl: envOrDefault("DATABASE_URL", TEST_DATABASE_URLS.AUTH_APP),
			log: ["error"]
		});

		const roles = await app.$queryRaw<RoleAttributes[]>`
			SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin
			FROM pg_roles r
			WHERE r.rolname = current_user
		`;
		appRole = roles[0];

		// Throwing here is the guard for the whole file: every zero-row assertion below is
		// vacuous under a role that can see everything anyway. A test would only report the
		// same fact once, alongside a suite of passes that proved nothing.
		if (!appRole) {
			throw new Error("Could not resolve the role under test from pg_roles");
		}
		if (appRole.rolsuper || appRole.rolbypassrls) {
			throw new Error(
				`DATABASE_URL connects as ${appRole.rolname}, which is a superuser or holds BYPASSRLS. RLS cannot be proven through it.`
			);
		}
		// Not merely "some restricted role". Pointed at telemetry_app this file would leave 14
		// of its assertions green and fail only on `permission denied` from the resolver calls,
		// which reads as a wiring problem rather than as the wrong role under test.
		if (appRole.rolname !== AUTH_DATABASE.AUTH_APP_ROLE) {
			throw new Error(
				`DATABASE_URL connects as ${appRole.rolname}; this suite must run as ${AUTH_DATABASE.AUTH_APP_ROLE}, the role auth-service actually uses.`
			);
		}

		// Seed through the admin connection: as the role under test these inserts are
		// themselves subject to the policies under test.
		await admin.tenant.create({ data: { id: tenant1Id, name: "RLS Test Tenant 1" } });
		await admin.tenant.create({ data: { id: tenant2Id, name: "RLS Test Tenant 2" } });
		const user1 = await admin.user.create({
			data: {
				id: `u_rls_1_${suiteId}` as UserId,
				tenantId: tenant1Id,
				firstName: "Rls",
				lastName: "One",
				email: user1Email,
				passwordHash: "hash1",
				role: AUTH_ROLES.OWNER
			}
		});
		user1Id = user1.id;
		await admin.user.create({
			data: {
				id: `u_rls_2_${suiteId}` as UserId,
				tenantId: tenant2Id,
				firstName: "Rls",
				lastName: "Two",
				email: user2Email,
				passwordHash: "hash2",
				role: AUTH_ROLES.OWNER
			}
		});
		await admin.refreshToken.create({
			data: {
				userId: user1Id,
				tokenHash: user1TokenHash,
				expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
			}
		});
	});

	afterAll(async () => {
		try {
			await admin.refreshToken.deleteMany({ where: { tokenHash: user1TokenHash } });
			await admin.user.deleteMany({
				where: { tenantId: { in: [tenant1Id, tenant2Id] } }
			});
			await admin.tenant.deleteMany({ where: { id: { in: [tenant1Id, tenant2Id] } } });
		} catch {
			// ignore cleanup errors
		}
		await admin.$disconnect();
		await app.$disconnect();
	});

	it("runs as a role that cannot bypass RLS", () => {
		// `beforeAll` already throws on a bypassing role, so this records the property under
		// test rather than protecting the suite.
		expect(appRole, "role under test could not be resolved").toBeDefined();
		expect(appRole?.rolsuper, `${appRole?.rolname} is a superuser`).toBe(false);
		expect(appRole?.rolbypassrls, `${appRole?.rolname} holds BYPASSRLS`).toBe(false);
	});

	it("with tenant1 context, reads only tenant1's own Tenant row", async () => {
		const tenants = await app.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT set_config(${AUTH_DATABASE.TENANT_CONTEXT_SETTING}, ${tenant1Id}, true)`;
			return tx.tenant.findMany();
		});

		expect(tenants.map((tenant) => tenant.id)).toEqual([tenant1Id]);
	});

	it("with tenant2 context, cannot see tenant1's Tenant row", async () => {
		const tenants = await app.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT set_config(${AUTH_DATABASE.TENANT_CONTEXT_SETTING}, ${tenant2Id}, true)`;
			return tx.tenant.findMany();
		});

		expect(tenants.map((tenant) => tenant.id)).toEqual([tenant2Id]);
		expect(tenants.map((tenant) => tenant.id)).not.toContain(tenant1Id);
	});

	it("without tenant context, reads zero rows", async () => {
		// The assertion that used to sit here asserted `>= 1` — it encoded the S-2
		// vulnerability (a connection that bypasses RLS sees everything) as expected
		// behaviour. With RLS actually enforcing, an unscoped query must return nothing.
		const tenants = await app.tenant.findMany();

		expect(tenants).toHaveLength(0);
	});

	it("holds no privileges on tables auth-service does not touch", async () => {
		// The counterpart to the migration's grant guard, asserted from the connection under
		// test. telemetry_app holds DML on all ten tables because five services share it;
		// this role has three. "InvoiceLineItem" is the one that matters most — RLS is inert
		// there (S-10), so a blanket grant would have meant cross-tenant write access.
		// Read from pg_class, not information_schema.role_table_grants: that view only shows
		// rows whose grantor or grantee is a currently enabled role, which makes the same
		// predicate vacuous for anyone else (it is why the migration's guard was rewritten).
		// `attacl` covers column-level grants, which the view misses for every role.
		const granted = await app.$queryRaw<{ relname: string }[]>`
			SELECT DISTINCT c.relname
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			CROSS JOIN LATERAL aclexplode(c.relacl) a
			WHERE n.nspname = 'public'
			  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
			  AND a.grantee = ${AUTH_DATABASE.AUTH_APP_ROLE}::regrole
			ORDER BY c.relname
		`;

		expect(granted.map((row) => row.relname)).toEqual([
			"RefreshToken",
			"Tenant",
			"User"
		]);

		const columnGrants = await app.$queryRaw<{ count: bigint }[]>`
			SELECT count(*) AS count
			FROM pg_attribute att
			JOIN pg_class c ON c.oid = att.attrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			CROSS JOIN LATERAL aclexplode(att.attacl) a
			WHERE n.nspname = 'public' AND a.grantee = ${AUTH_DATABASE.AUTH_APP_ROLE}::regrole
		`;

		expect(Number(columnGrants[0]?.count)).toBe(0);

		// Membership would route around both checks: the definer's policies are `USING (true)`
		// and apply through membership, so a member of it reads every tenant's "User" rows.
		const [membership] = await app.$queryRaw<{ can_assume_definer: boolean }[]>`
			SELECT pg_has_role(${AUTH_DATABASE.AUTH_APP_ROLE}, ${AUTH_DATABASE.DEFINER_ROLE}, 'USAGE') AS can_assume_definer
		`;

		expect(
			membership?.can_assume_definer,
			`${AUTH_DATABASE.AUTH_APP_ROLE} can assume ${AUTH_DATABASE.DEFINER_ROLE}`
		).toBe(false);

		await expect(app.event.findMany()).rejects.toThrow();
	});

	it("with tenant1 context, reads only tenant1 users", async () => {
		// The table auth-service owns the lifecycle of. Before S-7 landed, auth-service ran as
		// the admin role and this assertion could not be made against its own connection.
		const users = await app.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT set_config(${AUTH_DATABASE.TENANT_CONTEXT_SETTING}, ${tenant1Id}, true)`;
			return tx.user.findMany();
		});

		expect(users).toHaveLength(1);
		expect(users[0]?.id).toBe(user1Id);
		expect(users[0]?.email).toBe(user1Email);
	});

	it("with tenant2 context, cannot read tenant1's user", async () => {
		const users = await app.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT set_config(${AUTH_DATABASE.TENANT_CONTEXT_SETTING}, ${tenant2Id}, true)`;
			return tx.user.findMany();
		});

		expect(users.map((user) => user.email)).toEqual([user2Email]);
		expect(users.map((user) => user.tenantId)).not.toContain(tenant1Id);
	});

	it("without tenant context, reads zero users", async () => {
		const users = await app.user.findMany();

		expect(users).toHaveLength(0);
	});

	it("has RLS enabled and FORCEd on Event, with the tenant isolation policy present", async () => {
		const [table] = await app.$queryRaw<
			{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]
		>`
			SELECT c.relrowsecurity, c.relforcerowsecurity
			FROM pg_class c
			WHERE c.relname = 'Event'
		`;

		expect(table?.relrowsecurity, "RLS is not ENABLEd on Event").toBe(true);
		expect(table?.relforcerowsecurity, "RLS is not FORCEd on Event").toBe(true);

		const policies = await app.$queryRaw<{ policyname: string }[]>`
			SELECT policyname FROM pg_policies WHERE tablename = 'Event'
		`;

		expect(policies.map((p) => p.policyname)).toContain(TENANT_ISOLATION_POLICIES.EVENT);
	});

	it("has RLS enabled and FORCEd on User, with the tenant isolation policy present", async () => {
		const [table] = await app.$queryRaw<
			{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]
		>`
			SELECT c.relrowsecurity, c.relforcerowsecurity
			FROM pg_class c
			WHERE c.relname = 'User'
		`;

		expect(table?.relrowsecurity, "RLS is not ENABLEd on User").toBe(true);
		expect(table?.relforcerowsecurity, "RLS is not FORCEd on User").toBe(true);

		const policies = await app.$queryRaw<{ policyname: string }[]>`
			SELECT policyname FROM pg_policies WHERE tablename = 'User'
		`;

		expect(policies.map((p) => p.policyname)).toContain(TENANT_ISOLATION_POLICIES.USER);
	});

	describe("pre-authentication tenant resolvers (v1_5)", () => {
		const emailResolver = `${AUTH_DATABASE.RESOLVE_TENANT_BY_EMAIL_FN}${RESOLVER_ARGUMENT_TYPES}`;
		const tokenResolver = `${AUTH_DATABASE.RESOLVE_TENANT_BY_REFRESH_TOKEN_HASH_FN}${RESOLVER_ARGUMENT_TYPES}`;

		it("is owned by a role that cannot log in, cannot bypass RLS, and is SECURITY DEFINER", async () => {
			// The definer reads past the tenant policy through two targeted policies, NOT
			// through the BYPASSRLS role attribute. The distinction is the point: BYPASSRLS
			// applies to every table the role can ever reach, so it would be bounded only by
			// the convention that nobody adds another GRANT.
			const [definer] = await app.$queryRaw<RoleAttributes[]>`
				SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin
				FROM pg_roles r
				WHERE r.rolname = ${AUTH_DATABASE.DEFINER_ROLE}
			`;

			expect(definer, `${AUTH_DATABASE.DEFINER_ROLE} does not exist`).toBeDefined();
			expect(definer?.rolbypassrls, "definer role holds BYPASSRLS").toBe(false);
			expect(definer?.rolsuper, "definer role is a superuser").toBe(false);
			expect(definer?.rolcanlogin, "definer role can log in").toBe(false);

			for (const signature of [emailResolver, tokenResolver]) {
				const [shape] = await app.$queryRaw<FunctionShape[]>`
					SELECT pg_get_function_result(p.oid) AS result_type,
					       p.pronargs,
					       p.prosecdef,
					       r.rolname AS owner
					FROM pg_proc p
					JOIN pg_roles r ON r.oid = p.proowner
					WHERE p.oid = ${signature}::regprocedure
				`;

				expect(shape?.prosecdef, `${signature} is not SECURITY DEFINER`).toBe(true);
				expect(shape?.owner).toBe(AUTH_DATABASE.DEFINER_ROLE);
			}
		});

		it("returns a single text tenant id and nothing else", async () => {
			for (const signature of [emailResolver, tokenResolver]) {
				const [shape] = await app.$queryRaw<FunctionShape[]>`
					SELECT pg_get_function_result(p.oid) AS result_type,
					       p.pronargs,
					       p.prosecdef,
					       r.rolname AS owner
					FROM pg_proc p
					JOIN pg_roles r ON r.oid = p.proowner
					WHERE p.oid = ${signature}::regprocedure
				`;

				expect(shape?.result_type, `${signature} returns more than a tenant id`).toBe(
					RESOLVER_RETURN_TYPE
				);
				expect(shape?.pronargs).toBe(1);
			}
		});

		it("grants EXECUTE to auth-service's role alone — not to PUBLIC, not to the shared role", async () => {
			// v1_4's ALTER DEFAULT PRIVILEGES covers tables and sequences only; PostgreSQL
			// grants EXECUTE on a new function to PUBLIC by default, so the REVOKE in v1_5 is
			// load-bearing rather than decorative.
			//
			// The negative assertion on telemetry_app is the sharper one. That role is shared
			// by gateway, usage, worker, billing and analytics, and the resolvers read past
			// the "User" tenant policy — granting it there would hand every service an
			// e-mail -> tenant oracle around the isolation this suite proves above.
			for (const signature of [emailResolver, tokenResolver]) {
				const [privilege] = await app.$queryRaw<FunctionPrivilege[]>`
					SELECT has_function_privilege(${PUBLIC_ROLE}, ${signature}, ${EXECUTE_PRIVILEGE}) AS public_can_execute,
					       has_function_privilege(${AUTH_DATABASE.AUTH_APP_ROLE}, ${signature}, ${EXECUTE_PRIVILEGE}) AS auth_app_can_execute,
					       has_function_privilege(${AUTH_DATABASE.SHARED_APP_ROLE}, ${signature}, ${EXECUTE_PRIVILEGE}) AS shared_app_can_execute
				`;

				expect(privilege?.public_can_execute, `PUBLIC can execute ${signature}`).toBe(
					false
				);
				expect(
					privilege?.shared_app_can_execute,
					`${AUTH_DATABASE.SHARED_APP_ROLE} can execute ${signature}; every service shares that role`
				).toBe(false);
				expect(
					privilege?.auth_app_can_execute,
					`${AUTH_DATABASE.AUTH_APP_ROLE} cannot execute ${signature}`
				).toBe(true);
			}
		});

		it("reads past the tenant policy through two targeted SELECT policies, scoped to the definer role", async () => {
			// These are what replace BYPASSRLS. If either is missing the resolvers return NULL
			// silently, which is S-7 reproduced from inside the fix.
			const expectations = [
				{ table: "User", policy: AUTH_DATABASE.DEFINER_USER_READ_POLICY },
				{
					table: "RefreshToken",
					policy: AUTH_DATABASE.DEFINER_REFRESH_TOKEN_READ_POLICY
				}
			] as const;

			for (const { table, policy } of expectations) {
				const [row] = await app.$queryRaw<PolicyRow[]>`
					SELECT policyname, cmd, roles
					FROM pg_policies
					WHERE schemaname = 'public' AND tablename = ${table} AND policyname = ${policy}
				`;

				expect(row, `${policy} is missing on "${table}"`).toBeDefined();
				expect(row?.cmd, `${policy} is not SELECT-only`).toBe(SELECT_COMMAND);
				expect(row?.roles, `${policy} is not scoped to the definer role`).toEqual([
					AUTH_DATABASE.DEFINER_ROLE
				]);
			}
		});

		it("is the only SECURITY DEFINER function in the schema, and none is reachable by PUBLIC or the shared role", async () => {
			// This is the durable half of the guard. PostgreSQL grants EXECUTE on every new
			// function to PUBLIC, and `v1_5` removes that with a database-scoped
			// `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` — but only for
			// functions created by the role that ran the migration, so a function created by any
			// other role is still world-executable (S-11 in .claude/rules/known-gaps.md). The
			// migration guards the whole set at apply time; this asserts it on every `pnpm test`,
			// which is what catches a *later* migration adding a resolver without its own REVOKE.
			// `regprocedure` drops the schema when it is on the search_path, so the qualified
			// name is built explicitly to match the constants.
			const definerFunctions = await app.$queryRaw<
				{ signature: string; public_can_execute: boolean; shared_can_execute: boolean }[]
			>`
				SELECT n.nspname || '.' || p.proname AS signature,
				       has_function_privilege(${PUBLIC_ROLE}, p.oid, ${EXECUTE_PRIVILEGE}) AS public_can_execute,
				       has_function_privilege(${AUTH_DATABASE.SHARED_APP_ROLE}, p.oid, ${EXECUTE_PRIVILEGE}) AS shared_can_execute
				FROM pg_proc p
				JOIN pg_namespace n ON n.oid = p.pronamespace
				WHERE n.nspname = 'public' AND p.prosecdef
				ORDER BY signature
			`;

			expect(definerFunctions.map((row) => row.signature)).toEqual([
				AUTH_DATABASE.RESOLVE_TENANT_BY_EMAIL_FN,
				AUTH_DATABASE.RESOLVE_TENANT_BY_REFRESH_TOKEN_HASH_FN
			]);
			for (const row of definerFunctions) {
				expect(row.public_can_execute, `PUBLIC can execute ${row.signature}`).toBe(false);
				expect(
					row.shared_can_execute,
					`${AUTH_DATABASE.SHARED_APP_ROLE} can execute ${row.signature}`
				).toBe(false);
			}
		});

		it("resolves a known e-mail to its tenant with no tenant context set", async () => {
			const [row] = await app.$queryRaw<{ tenantId: string | null }[]>(
				Prisma.sql`SELECT ${EMAIL_RESOLVER_FRAGMENT}(${user1Email}) AS "tenantId"`
			);

			expect(row?.tenantId).toBe(tenant1Id);
		});

		it("resolves a known refresh-token hash to its tenant with no tenant context set", async () => {
			const [row] = await app.$queryRaw<{ tenantId: string | null }[]>(
				Prisma.sql`SELECT ${TOKEN_RESOLVER_FRAGMENT}(${user1TokenHash}) AS "tenantId"`
			);

			expect(row?.tenantId).toBe(tenant1Id);
		});

		it("returns NULL for a refresh-token hash that does not exist", async () => {
			const [row] = await app.$queryRaw<{ tenantId: string | null }[]>(
				Prisma.sql`SELECT ${TOKEN_RESOLVER_FRAGMENT}(${`missing-token-${suiteId}`}) AS "tenantId"`
			);

			expect(row?.tenantId).toBeNull();
		});

		it("returns NULL for an e-mail that does not exist", async () => {
			const [row] = await app.$queryRaw<{ tenantId: string | null }[]>(
				Prisma.sql`SELECT ${EMAIL_RESOLVER_FRAGMENT}(${`missing-${suiteId}@example.com`}) AS "tenantId"`
			);

			expect(row?.tenantId).toBeNull();
		});

		it("leaks no rows beyond the tenant id: the same role still reads zero users directly", async () => {
			const users = await app.user.findMany({ where: { email: user1Email } });

			expect(users).toHaveLength(0);
		});
	});
});
