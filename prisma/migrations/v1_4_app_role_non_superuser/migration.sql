-- Create the least-privilege application role that the services connect as at runtime.
--
-- Why: RLS is inert when the connecting role is a superuser or holds BYPASSRLS.
-- FORCE ROW LEVEL SECURITY does NOT stop a superuser -- it only removes the *table
-- owner's* exemption. The only thing that makes the policies in v1_0/v1_2 actually
-- enforce is connecting as a role that is NOSUPERUSER, NOBYPASSRLS, and not the owner
-- of the tables. This migration creates exactly that role and grants it the DML it
-- needs -- and nothing more.
--
-- Bootstrap ordering: this migration must run as an admin/owner role (Prisma reads
-- `directUrl` -> DIRECT_DATABASE_URL for migrate), never as the role it creates. The
-- application connects with `url` -> DATABASE_URL as "telemetry_app". Keeping the two
-- separate is what lets the app role be a non-owner: ALTER DEFAULT PRIVILEGES below is
-- recorded FOR the executing (owner) role, so every table a later migration creates is
-- covered automatically.
--
-- Password: this migration only sets a password when it creates the role, and the value
-- is a documented local/CI default that is also what .env.example and docker-compose
-- ship. A real deployment provisions the role out of band (or lets this run once and
-- then rotates) -- because the role already exists, re-running this migration never
-- overwrites a real secret. No production credential is committed here.

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

-- Clamp the attributes that make RLS inert, in case the role was provisioned elsewhere
-- with the wrong ones. Only issued when actually needed: changing these requires
-- superuser, and on managed platforms the migration role may not have it.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_roles
		WHERE rolname = 'telemetry_app' AND (rolsuper OR rolbypassrls)
	) THEN
		ALTER ROLE telemetry_app NOSUPERUSER NOBYPASSRLS;
	END IF;
END
$$;

-- Fail the migration loudly rather than leaving a role that silently bypasses RLS.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_roles
		WHERE rolname = 'telemetry_app' AND (rolsuper OR rolbypassrls)
	) THEN
		RAISE EXCEPTION
			'Role telemetry_app still has SUPERUSER or BYPASSRLS; RLS would not enforce.';
	END IF;
END
$$;

-- CONNECT on whichever database this migration is being applied to (telemetry,
-- telemetry_test, ...), so the grant is not hard-coded to one database name.
DO $$
BEGIN
	EXECUTE format(
		'GRANT CONNECT ON DATABASE %I TO telemetry_app',
		current_database()
	);
END
$$;

GRANT USAGE ON SCHEMA "public" TO telemetry_app;

-- DML only: no CREATE on the schema, no ownership, no TRUNCATE/REFERENCES/TRIGGER.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO telemetry_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO telemetry_app;

-- Future tables/sequences created by the migration owner are covered automatically.
-- No FOR ROLE clause: the default is the executing role, which is the owner that
-- Prisma Migrate connects as.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO telemetry_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
	GRANT USAGE, SELECT ON SEQUENCES TO telemetry_app;

-- The migration history is not application data; the GRANT ON ALL TABLES above would
-- otherwise hand the app role write access to it. Guarded on existence so the file is also
-- applicable by hand, outside `prisma migrate deploy` (which always creates this table first).
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_tables
		WHERE schemaname = 'public' AND tablename = '_prisma_migrations'
	) THEN
		REVOKE ALL ON TABLE "_prisma_migrations" FROM telemetry_app;
	END IF;
END
$$;
