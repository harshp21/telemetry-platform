/**
 * The connection strings the auth-service test suites use, in one place.
 *
 * Three roles, and every suite has to be explicit about which one it is talking to — a test
 * that seeds and asserts through the same restricted connection proves nothing (that was S-3).
 *
 * These are local/CI defaults only, matching `apps/auth-service/.env.example`,
 * `docker/docker-compose.yml` and `.github/workflows/ci.yml`. Environment variables win where
 * they are set; nothing here is a deployment credential.
 */
export const TEST_DATABASE_URLS = {
	/**
	 * auth-service's own runtime role: `NOSUPERUSER`, `NOBYPASSRLS`, owner of no table, and
	 * the only role granted `EXECUTE` on the pre-authentication resolvers
	 * (`prisma/migrations/v1_5_auth_tenant_resolvers`). This is the connection under test.
	 */
	AUTH_APP: "postgresql://telemetry_auth_app:telemetry_auth_app_local_dev@localhost:5432/telemetry",
	/**
	 * The role the other five services share. auth-service must **not** use it, and it must
	 * not be able to call the resolvers — asserted in `rls.integration.test.ts`.
	 */
	SHARED_APP: "postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry",
	/**
	 * Owner connection: Prisma `directUrl` for migrations, and integration fixtures that RLS
	 * would otherwise block. Never a runtime connection.
	 */
	ADMIN: "postgresql://postgres:postgres@localhost:5432/telemetry"
} as const;
