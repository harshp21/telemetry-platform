-- Pre-authentication tenant resolvers, so auth-service can connect as a least-privilege role
-- (S-7).
--
-- auth-service is the one service whose queries run *before* a tenant is known: login and
-- the duplicate-email check select "User" by e-mail, and refresh selects "RefreshToken"
-- joined to "User" by an opaque token hash. Under the v1_0 policies those all evaluate
-- `"tenantId" = current_setting('app.tenant_id', true)` with no context set, so they match
-- nothing and fail *silently* -- login reports "no such user" for every account.
--
-- The fix is two narrow SECURITY DEFINER lookups that return ONLY the tenant id. auth then
-- sets `app.tenant_id` and re-reads the row through the ordinary, policy-enforced path, so
-- the password hash never crosses the privileged boundary and every read of "User" is still
-- visible to an audit of policy-enforced access.
--
-- Ownership is the sharp edge. v1_2 sets FORCE ROW LEVEL SECURITY on "User", and FORCE
-- removes precisely the table owner's exemption -- so a SECURITY DEFINER function whose owner
-- has no way past the policies returns NULL with no error, reproducing the exact failure this
-- migration exists to fix, from inside the fix.
--
-- The way past the policies is a *targeted permissive policy*, not the BYPASSRLS role
-- attribute. BYPASSRLS is a role attribute: it applies to every table the role can ever
-- reach, so its blast radius is bounded only by the convention that nobody adds another
-- GRANT. `user_auth_definer_read` / `refreshtoken_auth_definer_read` below are bounded by
-- mechanism -- two tables, SELECT only, one role. It also keeps this migration appliable on
-- managed PostgreSQL (RDS, Cloud SQL, Neon), where `CREATE ROLE ... BYPASSRLS` is not
-- available to the migration role at all.
--
-- Two roles, and they are not interchangeable:
--   telemetry_auth_definer  NOLOGIN  -- owns the two functions; nobody connects as it
--   telemetry_auth_app      LOGIN    -- auth-service's runtime connection; the ONLY role
--                                       granted EXECUTE on the resolvers
-- `telemetry_app` (v1_4) is shared by the other five services, so granting it EXECUTE would hand
-- gateway, usage, worker, billing and analytics an e-mail -> tenant oracle that reads past
-- the "User" policy this migration exists to make enforce.
--
-- DEPLOYMENT: `CREATE ROLE` requires CREATEROLE or superuser. Prisma runs migrations as
-- `directUrl` -> DIRECT_DATABASE_URL, which is the owner/admin connection. If the migration
-- role cannot create roles, provision both roles out of band and re-run; every block here is
-- idempotent. `ALTER FUNCTION ... OWNER TO` additionally requires the migration role to be a
-- *member* of telemetry_auth_definer. See
-- docs/releases/s-007-auth-service-restricted-role.md.
--
-- ORDERING: these functions must exist BEFORE auth-service starts on telemetry_auth_app.
-- Apply this migration, verify the resolvers, and only then flip auth-service's DATABASE_URL.

-- 1. The definer role. NOLOGIN: nobody connects as it; it exists only to own two functions.
-- NOBYPASSRLS deliberately -- section 3 gives it exactly two read policies instead.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telemetry_auth_definer') THEN
		CREATE ROLE telemetry_auth_definer
			NOLOGIN
			NOSUPERUSER
			NOBYPASSRLS
			NOCREATEDB
			NOCREATEROLE
			NOREPLICATION;
	END IF;
END
$$;

-- Clamp the attributes, in case the role was provisioned elsewhere with the wrong ones, or
-- was created with BYPASSRLS by an earlier revision of this migration. Only issued when
-- actually needed: these require superuser or CREATEROLE.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_roles
		WHERE rolname = 'telemetry_auth_definer'
		  AND (rolsuper OR rolcanlogin OR rolbypassrls)
	) THEN
		ALTER ROLE telemetry_auth_definer NOLOGIN NOSUPERUSER NOBYPASSRLS;
	END IF;
END
$$;

-- Fail loudly rather than leaving a definer role that is more privileged than the two read
-- policies it is supposed to be limited to.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_roles
		WHERE rolname = 'telemetry_auth_definer'
		  AND NOT rolbypassrls
		  AND NOT rolsuper
		  AND NOT rolcanlogin
	) THEN
		RAISE EXCEPTION
			'Role telemetry_auth_definer must be NOLOGIN NOSUPERUSER NOBYPASSRLS; it reads past the tenant policies through user_auth_definer_read / refreshtoken_auth_definer_read, not through a role attribute.';
	END IF;
END
$$;

-- 2. The only privileges the definer role gets: read two tables.
GRANT USAGE ON SCHEMA "public" TO telemetry_auth_definer;
GRANT SELECT ON TABLE "User" TO telemetry_auth_definer;
GRANT SELECT ON TABLE "RefreshToken" TO telemetry_auth_definer;

-- 3. The two policies that let the resolver bodies see a row before a tenant is known. Scoped
-- `TO telemetry_auth_definer`, and a policy applies through role **membership** -- so what keeps
-- them unreachable from telemetry_app and telemetry_auth_app is that neither role is a member of
-- the definer (the definer being NOLOGIN is why nothing connects *as* it, which is a different
-- property). Membership is therefore the escalation path, and section 7 asserts directly that
-- neither application role can reach the definer -- `pg_has_role`, so a transitive grant counts
-- too. Do not weaken that guard: `USING (true)` applied through membership means every "User" row
-- in the platform, with no tenant context. FOR SELECT only, and the definer holds no
-- INSERT/UPDATE/DELETE grant either way.
--
-- "RefreshToken" has RLS FORCEd but never ENABLEd (S-10 in .claude/rules/known-gaps.md), so its
-- policy is inert today. It is created now so that enabling RLS on that table stays a
-- migration and does not silently break refresh rotation.
--
-- Created conditionally rather than DROP + CREATE. A drop-then-create pair is only atomic while
-- the file runs inside one transaction; `prisma migrate deploy` provides that, but the recovery
-- path in docs/releases/s-007-auth-service-restricted-role.md has an operator re-running this
-- file by hand through psql. A failure between the DROP and the CREATE would leave "User"
-- without the policy, at which point every resolver returns NULL and **every login returns 401**
-- -- silently, which is the exact failure mode this file exists to prevent.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_policies
		WHERE schemaname = 'public'
		  AND tablename = 'User'
		  AND policyname = 'user_auth_definer_read'
	) THEN
		CREATE POLICY "user_auth_definer_read" ON "User"
			FOR SELECT
			TO telemetry_auth_definer
			USING (true);
	END IF;
END
$$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_policies
		WHERE schemaname = 'public'
		  AND tablename = 'RefreshToken'
		  AND policyname = 'refreshtoken_auth_definer_read'
	) THEN
		CREATE POLICY "refreshtoken_auth_definer_read" ON "RefreshToken"
			FOR SELECT
			TO telemetry_auth_definer
			USING (true);
	END IF;
END
$$;

-- 4. auth-service's own runtime role. NOSUPERUSER, NOBYPASSRLS, owner of nothing, so the
-- policies enforce for it exactly as they do for every other service. It exists so that EXECUTE
-- on the resolvers can be granted to auth-service alone rather than to the role the other five
-- services share -- and, because it is a fresh role, so that its table privileges can be
-- narrower than telemetry_app's rather than a copy of them.
--
-- Password: as in v1_4, only set when this migration creates the role, and the value is the
-- documented local/CI default that .env.example and docker-compose ship. A real deployment
-- provisions the role out of band, or lets this run once and then rotates; because the role
-- already exists on a re-run, this never overwrites a real secret.
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
	IF EXISTS (
		SELECT 1 FROM pg_roles
		WHERE rolname = 'telemetry_auth_app' AND (rolsuper OR rolbypassrls)
	) THEN
		ALTER ROLE telemetry_auth_app NOSUPERUSER NOBYPASSRLS;
	END IF;
END
$$;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_roles
		WHERE rolname = 'telemetry_auth_app' AND (rolsuper OR rolbypassrls)
	) THEN
		RAISE EXCEPTION
			'Role telemetry_auth_app still has SUPERUSER or BYPASSRLS; RLS would not enforce for auth-service.';
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

-- Three tables, not ten. telemetry_app holds DML on every table in the schema because five
-- services share it; auth-service reads or writes only "Tenant", "User" and "RefreshToken", so
-- this role gets those and nothing else. That matters beyond tidiness: RLS is inert on
-- "InvoiceLineItem" and "RefreshToken" (S-10), so a blanket grant would have handed auth-service
-- cross-tenant write access to invoice line items it has no business in.
--
-- An earlier revision of this migration granted DML on ALL TABLES to this role, and a GRANT
-- cannot take that back, so re-application has to revoke to converge. Grant first and revoke only
-- the complement, rather than `REVOKE ALL ON ALL TABLES` followed by three GRANTs: the file is
-- atomic under `prisma migrate deploy`, but the recovery path in
-- docs/releases/s-007-auth-service-restricted-role.md has an operator running it through psql,
-- and a failure between a blanket revoke and the re-grant would leave auth-service with no table
-- access at all. Same reasoning as the policies in section 3.
--
-- No default *grant* for tables either -- a future table must be granted deliberately, which is
-- the whole point. The two `ALTER DEFAULT PRIVILEGES ... REVOKE` statements further down converge
-- a hand-made schema-scoped grant to this role and nothing else: per section 6, a schema-scoped
-- revoke cannot subtract from the built-in default, so they are inert against a database-scoped
-- grant. Deliberately no TRUNCATE/REFERENCES/TRIGGER, no CREATE on the schema, no ownership.
-- (The schema has no sequences; Prisma generates ids client-side.)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Tenant" TO telemetry_auth_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "User" TO telemetry_auth_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "RefreshToken" TO telemetry_auth_app;

DO $$
DECLARE
	v_relation text;
BEGIN
	FOR v_relation IN
		SELECT c.relname
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public'
		  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
		  AND c.relname NOT IN ('Tenant', 'User', 'RefreshToken')
	LOOP
		EXECUTE format(
			'REVOKE ALL ON TABLE public.%I FROM telemetry_auth_app',
			v_relation
		);
	END LOOP;
END
$$;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA "public" FROM telemetry_auth_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
	REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM telemetry_auth_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
	REVOKE USAGE, SELECT ON SEQUENCES FROM telemetry_auth_app;

-- 5. The resolvers. STRICT so a NULL argument short-circuits without touching the table;
-- STABLE because they only read; search_path pinned and every reference schema-qualified so
-- the body cannot be captured by a caller-controlled search_path.
CREATE OR REPLACE FUNCTION public.auth_resolve_tenant_by_email(p_email text)
RETURNS text
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
	SELECT u."tenantId"
	FROM public."User" u
	WHERE u."email" = p_email
	LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.auth_resolve_tenant_by_refresh_token_hash(p_token_hash text)
RETURNS text
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
	SELECT u."tenantId"
	FROM public."RefreshToken" rt
	JOIN public."User" u ON u."id" = rt."userId"
	WHERE rt."tokenHash" = p_token_hash
	LIMIT 1;
$fn$;

ALTER FUNCTION public.auth_resolve_tenant_by_email(text)
	OWNER TO telemetry_auth_definer;
ALTER FUNCTION public.auth_resolve_tenant_by_refresh_token_hash(text)
	OWNER TO telemetry_auth_definer;

-- 6. PostgreSQL grants EXECUTE on every new function to PUBLIC, and every application role is
-- in PUBLIC. Two layers deal with that.
--
-- First, a default: every function this role creates from here on excludes PUBLIC.
--
-- The `IN SCHEMA` clause must be OMITTED. A schema-scoped default ACL is *merged with*
-- `acldefault()`, which contains `=X` for PUBLIC, so `ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
-- REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` is accepted and does nothing at all -- no
-- `pg_default_acl` row, and a function created afterwards still comes out `proacl = NULL` with
-- PUBLIC holding EXECUTE. The database-scoped entry below *replaces* the built-in default instead:
-- verified on PG 16.13, a SECURITY DEFINER function created afterwards comes out
-- `{postgres=X/postgres}` with neither PUBLIC nor telemetry_app able to execute it.
--
-- The default is recorded per creating role, so it covers functions created by whoever runs
-- migrations -- not one created by hand as some other role. That residual is S-11 in
-- .claude/rules/known-gaps.md, and the guard in section 7 plus the standing assertion in
-- apps/auth-service/tests/rls.integration.test.ts are what catch it.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Second, explicitly for the two functions above: the default did not exist when CREATE FUNCTION
-- ran, and it does not cover a function created by another role either.
--
-- The REVOKE from telemetry_app is load-bearing for a different reason: an earlier revision of
-- this migration granted it, and a GRANT cannot take itself back.
REVOKE ALL ON FUNCTION public.auth_resolve_tenant_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_resolve_tenant_by_refresh_token_hash(text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.auth_resolve_tenant_by_email(text) FROM telemetry_app;
REVOKE ALL ON FUNCTION public.auth_resolve_tenant_by_refresh_token_hash(text) FROM telemetry_app;

GRANT EXECUTE ON FUNCTION public.auth_resolve_tenant_by_email(text) TO telemetry_auth_app;
GRANT EXECUTE ON FUNCTION public.auth_resolve_tenant_by_refresh_token_hash(text)
	TO telemetry_auth_app;

-- 7. Catalog guard: the resolvers are SECURITY DEFINER, owned by the narrow definer role,
-- reachable only by auth-service's own role, and the definer's read policies are in place.
DO $$
DECLARE
	v_name text;
BEGIN
	FOREACH v_name IN ARRAY ARRAY[
		'public.auth_resolve_tenant_by_email(text)',
		'public.auth_resolve_tenant_by_refresh_token_hash(text)'
	]
	LOOP
		IF NOT EXISTS (
			SELECT 1
			FROM pg_proc p
			JOIN pg_roles r ON r.oid = p.proowner
			WHERE p.oid = v_name::regprocedure
			  AND p.prosecdef
			  AND r.rolname = 'telemetry_auth_definer'
		) THEN
			RAISE EXCEPTION
				'% must be SECURITY DEFINER and owned by telemetry_auth_definer.',
				v_name;
		END IF;

		IF has_function_privilege('public', v_name, 'EXECUTE') THEN
			RAISE EXCEPTION 'PUBLIC must not hold EXECUTE on %.', v_name;
		END IF;

		IF has_function_privilege('telemetry_app', v_name, 'EXECUTE') THEN
			RAISE EXCEPTION
				'telemetry_app must not hold EXECUTE on % -- it is shared by every service, and the resolvers read past the "User" tenant policy.',
				v_name;
		END IF;

		IF NOT has_function_privilege('telemetry_auth_app', v_name, 'EXECUTE') THEN
			RAISE EXCEPTION 'telemetry_auth_app must hold EXECUTE on %.', v_name;
		END IF;
	END LOOP;

	IF NOT EXISTS (
		SELECT 1 FROM pg_policies
		WHERE schemaname = 'public'
		  AND tablename = 'User'
		  AND policyname = 'user_auth_definer_read'
		  AND 'telemetry_auth_definer' = ANY (roles)
	) THEN
		RAISE EXCEPTION
			'Policy user_auth_definer_read is missing on "User"; without it the resolvers return NULL silently.';
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_policies
		WHERE schemaname = 'public'
		  AND tablename = 'RefreshToken'
		  AND policyname = 'refreshtoken_auth_definer_read'
		  AND 'telemetry_auth_definer' = ANY (roles)
	) THEN
		RAISE EXCEPTION
			'Policy refreshtoken_auth_definer_read is missing on "RefreshToken"; refresh rotation would break the moment RLS is ENABLEd there (S-10).';
	END IF;

	-- Asserting the *exact* set, not just presence. Permissive policies OR together, so one
	-- stray `USING (true)` on "User" -- a rename that left the old policy behind, say -- widens
	-- tenant reach for anyone the stray policy names. An unbounded policy set is the same class
	-- of risk that choosing a policy over BYPASSRLS was meant to avoid.
	IF EXISTS (
		SELECT 1 FROM pg_policies
		WHERE schemaname = 'public'
		  AND tablename = 'User'
		  AND policyname NOT IN ('user_tenant_isolation', 'user_auth_definer_read')
	) THEN
		RAISE EXCEPTION
			'Unexpected policy on "User"; a permissive policy here can widen tenant reach beyond user_tenant_isolation.';
	END IF;

	IF EXISTS (
		SELECT 1 FROM pg_policies
		WHERE schemaname = 'public'
		  AND tablename = 'RefreshToken'
		  AND policyname <> 'refreshtoken_auth_definer_read'
	) THEN
		RAISE EXCEPTION
			'Unexpected policy on "RefreshToken"; see S-10 before adding one.';
	END IF;

	-- The same check as the loop above, but by mechanism rather than by name: any SECURITY
	-- DEFINER function in `public` reads with its owner's privileges, so none of them may be
	-- reachable by PUBLIC or by the shared application role. This is what catches a later
	-- migration that adds a resolver and forgets the REVOKE, which the hard-coded list cannot.
	FOR v_name IN
		SELECT p.oid::regprocedure::text
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'public' AND p.prosecdef
	LOOP
		IF has_function_privilege('public', v_name, 'EXECUTE') THEN
			RAISE EXCEPTION 'PUBLIC must not hold EXECUTE on SECURITY DEFINER function %.', v_name;
		END IF;

		IF has_function_privilege('telemetry_app', v_name, 'EXECUTE') THEN
			RAISE EXCEPTION
				'telemetry_app must not hold EXECUTE on SECURITY DEFINER function % -- it is shared by every service.',
				v_name;
		END IF;
	END LOOP;

	-- Neither application role may reach the definer. Its policies are `USING (true)` and apply
	-- through membership, so a member reads every tenant's "User" rows with no tenant context --
	-- and for telemetry_auth_app the EXECUTE checks above cannot notice, because it holds EXECUTE
	-- legitimately. `pg_has_role` counts transitive grants, so an intermediate role does not
	-- launder it. The migration role itself may be a member: `ALTER FUNCTION ... OWNER TO`
	-- requires that, and it is not an application connection.
	IF pg_has_role('telemetry_app', 'telemetry_auth_definer', 'USAGE') THEN
		RAISE EXCEPTION
			'telemetry_app can assume telemetry_auth_definer; user_auth_definer_read is USING (true) and applies through membership, so it would read every tenant''s "User" rows.';
	END IF;

	IF pg_has_role('telemetry_auth_app', 'telemetry_auth_definer', 'USAGE') THEN
		RAISE EXCEPTION
			'telemetry_auth_app can assume telemetry_auth_definer; user_auth_definer_read is USING (true) and applies through membership, so it would read every tenant''s "User" rows with no tenant context.';
	END IF;

	-- auth-service's role must hold DML on exactly the three tables it touches. A blanket grant
	-- would include "InvoiceLineItem", where RLS is inert (S-10) -- cross-tenant write access
	-- for a service that has no business there.
	--
	-- Read from pg_class/pg_attribute rather than information_schema.role_table_grants: that view
	-- shows only rows whose grantor or grantee is a *currently enabled role*, so on the managed
	-- deployment this file's header describes -- a non-superuser migration role -- it returns
	-- nothing and the check passes vacuously. The catalog is visible regardless of who asks.
	-- attacl covers column-level grants, which the view misses in every case.
	IF EXISTS (
		SELECT 1
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		CROSS JOIN LATERAL aclexplode(c.relacl) a
		WHERE n.nspname = 'public'
		  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
		  AND a.grantee = 'telemetry_auth_app'::regrole
		  AND c.relname NOT IN ('Tenant', 'User', 'RefreshToken')
	) THEN
		RAISE EXCEPTION
			'telemetry_auth_app holds table privileges outside "Tenant"/"User"/"RefreshToken"; auth-service touches only those three.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM pg_attribute att
		JOIN pg_class c ON c.oid = att.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		CROSS JOIN LATERAL aclexplode(att.attacl) a
		WHERE n.nspname = 'public'
		  AND a.grantee = 'telemetry_auth_app'::regrole
		  AND c.relname NOT IN ('Tenant', 'User', 'RefreshToken')
	) THEN
		RAISE EXCEPTION
			'telemetry_auth_app holds column privileges outside "Tenant"/"User"/"RefreshToken".';
	END IF;
END
$$;

-- 8. Functional guard: prove the resolvers actually resolve, with NO tenant context set.
-- The catalog guard above cannot prove this on its own -- a resolver that silently returns
-- NULL is indistinguishable from "no such user" at every later layer, which is the whole
-- defect. Rows are created and removed inside this migration's transaction; app.tenant_id
-- is set only so that the probe inserts and deletes also work for a non-superuser owner,
-- and is cleared before the resolvers are called so that the definer's read policies are the
-- only thing that can make them return a row. SECURITY DEFINER means the body runs as the
-- function owner regardless of who calls it, so no SET ROLE is needed here.
DO $$
DECLARE
	v_probe_id text := gen_random_uuid()::text;
	v_email text := 'v1-5-resolver-probe-' || v_probe_id || '@invalid';
	v_token_hash text := 'v1_5_resolver_probe_' || v_probe_id;
	v_by_email text;
	v_by_token text;
BEGIN
	PERFORM set_config('app.tenant_id', v_probe_id, true);

	INSERT INTO public."Tenant" ("id", "name")
		VALUES (v_probe_id, 'v1_5 resolver probe');
	INSERT INTO public."User"
		("id", "tenantId", "firstName", "lastName", "email", "passwordHash")
		VALUES (v_probe_id, v_probe_id, 'v1_5', 'probe', v_email, 'not-a-usable-hash');
	INSERT INTO public."RefreshToken" ("id", "userId", "tokenHash", "expiresAt")
		VALUES (v_probe_id, v_probe_id, v_token_hash, now());

	PERFORM set_config('app.tenant_id', '', true);
	v_by_email := public.auth_resolve_tenant_by_email(v_email);
	v_by_token := public.auth_resolve_tenant_by_refresh_token_hash(v_token_hash);
	PERFORM set_config('app.tenant_id', v_probe_id, true);

	DELETE FROM public."RefreshToken" WHERE "id" = v_probe_id;
	DELETE FROM public."User" WHERE "id" = v_probe_id;
	DELETE FROM public."Tenant" WHERE "id" = v_probe_id;

	IF v_by_email IS DISTINCT FROM v_probe_id THEN
		RAISE EXCEPTION
			'auth_resolve_tenant_by_email returned % with no tenant context; expected %. The definer role cannot see past RLS.',
			coalesce(v_by_email, 'NULL'), v_probe_id;
	END IF;

	IF v_by_token IS DISTINCT FROM v_probe_id THEN
		RAISE EXCEPTION
			'auth_resolve_tenant_by_refresh_token_hash returned % with no tenant context; expected %. The definer role cannot see past RLS.',
			coalesce(v_by_token, 'NULL'), v_probe_id;
	END IF;
END
$$;
