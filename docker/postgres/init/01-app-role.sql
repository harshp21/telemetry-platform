-- Bootstraps the least-privilege application role in a fresh Postgres container.
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
