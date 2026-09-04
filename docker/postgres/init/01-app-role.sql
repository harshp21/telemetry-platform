-- Bootstraps the two least-privilege application roles in a fresh Postgres container:
-- telemetry_app (shared by five services) and telemetry_auth_app (auth-service only).
--
-- Why this exists as well as prisma/migrations/v1_4_app_role_non_superuser:
-- nothing in docker/docker-compose.yml runs `prisma migrate deploy`, so a compose stack
-- would otherwise start services pointed at a role that does not exist and every
-- healthcheck would fail. The migration remains the source of truth for any environment
-- where migrations DO run; this script makes the container self-sufficient.
--
-- Runs only when the postgres_data volume is empty (docker-entrypoint-initdb.d semantics).
-- After changing this file: `docker compose -f docker/docker-compose.yml down -v`.
--
-- Kept deliberately in sync with the migration. Both are idempotent; whichever runs first
-- wins and the other is a no-op.
--
-- PARTIALLY mirrored: prisma/migrations/v1_5_auth_tenant_resolvers also creates
-- `telemetry_auth_definer` and the two SECURITY DEFINER resolvers it owns. Those are NOT
-- created here -- the resolver bodies are `LANGUAGE sql`, which PostgreSQL parses at CREATE
-- time, and no tables exist when an init script runs; creating the definer role alone would
-- leave an orphan owning nothing. `telemetry_auth_app` *is* created here, because it is an
-- ordinary LOGIN role and auth-service cannot even start without a role to connect as.
--
-- Consequence: in a compose stack auth-service's database paths do not work -- the resolvers
-- are absent. They did not work before either, since nothing here runs migrations and the
-- tables are absent too, and `/health`, the only thing `pnpm test:smoke:compose` exercises,
-- does not touch the database.

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telemetry_app') THEN
		CREATE ROLE telemetry_app
			LOGIN
			NOSUPERUSER
			NOBYPASSRLS
			NOCREATEDB
			NOCREATEROLE
			NOREPLICATION
			PASSWORD 'telemetry_app_local_dev';
	END IF;
END
$$;

DO $$
BEGIN
	EXECUTE format(
		'GRANT CONNECT ON DATABASE %I TO telemetry_app',
		current_database()
	);
END
$$;

GRANT USAGE ON SCHEMA "public" TO telemetry_app;

-- No tables exist yet in a fresh container; these cover the case where the volume already
-- has a schema, and the ALTER DEFAULT PRIVILEGES below covers everything created later.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO telemetry_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO telemetry_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO telemetry_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
	GRANT USAGE, SELECT ON SEQUENCES TO telemetry_app;

-- auth-service's own role. Table privileges are deliberately NOT mirrored: the migration grants
-- DML on exactly "Tenant", "User" and "RefreshToken", which cannot be expressed here because no
-- table exists when an init script runs, and a blanket ALTER DEFAULT PRIVILEGES would hand this
-- role the whole schema -- the opposite of what the migration does. So this creates the role and
-- lets it connect, and nothing more; the migration remains the source of truth for its
-- privileges. Nothing in this stack runs migrations, so auth's database paths do not work here
-- either way (see the header).
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telemetry_auth_app') THEN
		CREATE ROLE telemetry_auth_app
			LOGIN
			NOSUPERUSER
			NOBYPASSRLS
			NOCREATEDB
			NOCREATEROLE
			NOREPLICATION
			PASSWORD 'telemetry_auth_app_local_dev';
	END IF;
END
$$;

DO $$
BEGIN
	EXECUTE format(
		'GRANT CONNECT ON DATABASE %I TO telemetry_auth_app',
		current_database()
	);
END
$$;

GRANT USAGE ON SCHEMA "public" TO telemetry_auth_app;
