-- Cross-tenant unbilled-usage enumeration, so worker-service's nightly invoice job can name the
-- tenants billing-service has to invoice (T-042).
--
-- billing-service can already generate an invoice *for a tenant you name*. Nothing names any
-- tenants, and nothing on the platform can: answering "which tenants had unbilled usage
-- yesterday" means reading across every tenant at once, which is exactly what the v1_0 policies
-- forbid. Measured on this database as `telemetry_app` with no tenant context,
-- `SELECT DISTINCT "tenantId" FROM "UsageLine" WHERE billed = false` returns **zero rows**, and
-- so does `SELECT count(*) FROM "Tenant"` -- `current_setting('app.tenant_id', true)` is NULL
-- when unset, so `"tenantId" = NULL` is NULL, not true, for every row. The exception this file
-- adds does not document an existing hole; there is no hole, and one has to be built.
--
-- The shape is v1_5's, for v1_5's reasons. One narrow SECURITY DEFINER lookup returning the
-- **tenant ids only** -- SETOF text, never a quantity and never a UsageLine id -- owned by a
-- NOLOGIN role that reads past the tenant policy through a *targeted permissive policy* rather
-- than through the BYPASSRLS role attribute. BYPASSRLS is a role attribute: it applies to every
-- table the role can ever reach, so its blast radius is bounded only by the convention that
-- nobody adds another GRANT. `usageline_worker_definer_read` below is bounded by mechanism --
-- one table, SELECT only, one role. It also keeps this migration appliable on managed
-- PostgreSQL (RDS, Cloud SQL, Neon), where `CREATE ROLE ... BYPASSRLS` is not available to the
-- migration role at all.
--
-- Two roles, and they are not interchangeable:
--   telemetry_worker_definer  NOLOGIN  -- owns the resolver; nobody connects as it
--   telemetry_worker_app      LOGIN    -- worker-service's runtime connection; the ONLY role
--                                         granted EXECUTE on the resolver
-- `telemetry_app` (v1_4) is shared by gateway, usage-, billing- and analytics-service, so
-- granting it EXECUTE would hand all four an enumerate-every-tenant oracle that reads past the
-- "UsageLine" policy this migration exists to keep enforcing. That separation is the whole
-- reason worker-service gets a fourth role rather than a fourth grant.
--
-- STATE THE WIDENING PRECISELY, because the next resolver will be argued against this one.
-- What the grantee gains is NOT "can read another tenant's rows" -- any application role can
-- already do that for a tenant whose id it holds, which is what set_config('app.tenant_id', ...)
-- is for and how every service reaches the tenant it serves. Measured as telemetry_worker_app:
-- with no tenant context a direct SELECT on "UsageLine" returns 0 rows; the resolver returns
-- every tenant id; with app.tenant_id set to one of those ids the role reads that tenant's
-- "UsageLine" and "Event" rows and UPDATEs them -- identically to telemetry_app given the same
-- id, which in the same session got `permission denied for function` on the resolver itself.
-- So the grant converts "read or write a tenant you can already name" into "enumerate every
-- tenant with unbilled usage, then do that". The ids no longer have to be known. That is the
-- widening being accepted here, and it is recorded as .claude/rules/known-gaps.md S-43.
--
-- `telemetry_worker_app`'s own table privileges are enumerated, not copied. worker-service
-- writes exactly "Event" and "UsageLine", through `EventRepository.upsertEventWithUsageLine`,
-- so it gets SELECT/INSERT/UPDATE on those two and nothing else -- no DELETE (it deletes
-- nothing), and **no** `ALTER DEFAULT PRIVILEGES ... GRANT`, so a future table has to be granted
-- deliberately. A copy of `telemetry_app`'s blanket grant would have included "InvoiceLineItem",
-- where RLS is inert (S-10); .claude/rules/tenant-isolation.md records that exact mistake being
-- avoided for telemetry_auth_app, and it is avoided here for the same reason.
--
-- **No grant on "Tenant"**, despite "Event"'s foreign key to it. Measured on PG 16.13 against a
-- throwaway role holding these two tables and nothing else, inside a rolled-back transaction:
-- `SELECT count(*) FROM "Tenant"` raised `permission denied for table Tenant`, while
-- `INSERT INTO "Event"` referencing a real "Tenant" row succeeded; and an INSERT naming a tenant
-- id that does not exist -- with app.tenant_id set to that same id, so the RLS check could not be
-- what rejected it -- failed with `violates foreign key constraint "Event_tenantId_fkey"`.
-- Referential integrity is therefore enforced in both directions without the calling role
-- holding any privilege on the referenced table.
--
-- DEPLOYMENT: `CREATE ROLE` requires CREATEROLE or superuser. Prisma runs migrations as
-- `directUrl` -> DIRECT_DATABASE_URL, the owner/admin connection. If the migration role cannot
-- create roles, provision both roles out of band and re-run; every block here is idempotent.
-- `ALTER FUNCTION ... OWNER TO` additionally requires the migration role to be a *member* of
-- telemetry_worker_definer. See docs/releases/t-042-worker-billing-enumerator.md.
--
-- ORDERING: this migration must be applied and verified BEFORE worker-service's DATABASE_URL is
-- flipped to telemetry_worker_app. The flip must never precede the grant -- a worker pointed at
-- a role that does not exist fails to connect, and one pointed at a role that exists without the
-- grants fails on `permission denied` on its first write.

-- 1. The definer role. NOLOGIN: nobody connects as it; it exists only to own one function.
-- NOBYPASSRLS deliberately -- section 3 gives it exactly one read policy instead.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telemetry_worker_definer') THEN
		CREATE ROLE telemetry_worker_definer
			NOLOGIN
			NOSUPERUSER
			NOBYPASSRLS
			NOCREATEDB
			NOCREATEROLE
			NOREPLICATION;
	END IF;
END
$$;

-- Clamp the attributes, in case the role was provisioned elsewhere with the wrong ones. Only
-- issued when actually needed: these require superuser or CREATEROLE.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_roles
		WHERE rolname = 'telemetry_worker_definer'
		  AND (rolsuper OR rolcanlogin OR rolbypassrls)
	) THEN
		ALTER ROLE telemetry_worker_definer NOLOGIN NOSUPERUSER NOBYPASSRLS;
	END IF;
END
$$;

-- Fail loudly rather than leaving a definer role that is more privileged than the single read
-- policy it is supposed to be limited to.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_roles
		WHERE rolname = 'telemetry_worker_definer'
		  AND NOT rolbypassrls
		  AND NOT rolsuper
		  AND NOT rolcanlogin
	) THEN
		RAISE EXCEPTION
			'Role telemetry_worker_definer must be NOLOGIN NOSUPERUSER NOBYPASSRLS; it reads past the tenant policy through usageline_worker_definer_read, not through a role attribute.';
	END IF;
END
$$;

-- 2. The only privileges the definer role gets: read one table.
GRANT USAGE ON SCHEMA "public" TO telemetry_worker_definer;
GRANT SELECT ON TABLE "UsageLine" TO telemetry_worker_definer;

-- Converge a definer role that was granted more than one table by an earlier revision or by
-- hand. A GRANT cannot take itself back, so re-application has to revoke the complement. Written
-- as a loop over the complement rather than `REVOKE ALL ON ALL TABLES` followed by one GRANT,
-- for the reason section 3 gives about atomicity under a hand-applied re-run.
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
		  AND c.relname <> 'UsageLine'
	LOOP
		EXECUTE format(
			'REVOKE ALL ON TABLE public.%I FROM telemetry_worker_definer',
			v_relation
		);
	END LOOP;
END
$$;

-- 3. The policy that lets the resolver body see rows before -- in fact, without -- any tenant
-- being known. Scoped `TO telemetry_worker_definer`, and a policy applies through role
-- **membership**, so what keeps it unreachable from telemetry_app and telemetry_worker_app is
-- that neither role is a member of the definer (the definer being NOLOGIN is why nothing
-- connects *as* it, which is a different property). Membership is therefore the escalation path,
-- and section 7 asserts directly that neither application role can reach the definer --
-- `pg_has_role`, so a transitive grant counts too. Do not weaken that guard: `USING (true)`
-- applied through membership means every "UsageLine" row on the platform, with no tenant
-- context. FOR SELECT only, and the definer holds no INSERT/UPDATE/DELETE grant either way.
--
-- "UsageLine" already carries `usage_line_tenant_isolation` (v1_0), which is permissive and
-- applies to PUBLIC. Permissive policies OR together, which is what makes this additive rather
-- than a replacement: for every other role the tenant predicate is still the only thing that can
-- return a row.
--
-- Created conditionally rather than DROP + CREATE. A drop-then-create pair is only atomic while
-- the file runs inside one transaction; `prisma migrate deploy` provides that, but the recovery
-- path in docs/releases/t-042-worker-billing-enumerator.md has an operator re-running this file
-- by hand through psql. A failure between the DROP and the CREATE would leave the resolver
-- returning an empty set -- **silently**, which reads downstream as "no tenant had usage
-- yesterday" and bills nobody. That is the expensive failure this whole task is shaped around.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_policies
		WHERE schemaname = 'public'
		  AND tablename = 'UsageLine'
		  AND policyname = 'usageline_worker_definer_read'
	) THEN
		CREATE POLICY "usageline_worker_definer_read" ON "UsageLine"
			FOR SELECT
			TO telemetry_worker_definer
			USING (true);
	END IF;
END
$$;

-- 4. worker-service's own runtime role. NOSUPERUSER, NOBYPASSRLS, owner of nothing, so the
-- policies enforce for it exactly as they do for every other service.
--
-- Password: as in v1_4 and v1_5, only set when this migration creates the role, and the value is
-- the documented local/CI default that .env.example and docker-compose ship. A real deployment
-- provisions the role out of band, or lets this run once and then rotates; because the role
-- already exists on a re-run, this never overwrites a real secret.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telemetry_worker_app') THEN
		CREATE ROLE telemetry_worker_app
			LOGIN
			NOSUPERUSER
			NOBYPASSRLS
			NOCREATEDB
			NOCREATEROLE
			NOREPLICATION
			PASSWORD 'telemetry_worker_app_local_dev';
	END IF;
END
$$;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_roles
		WHERE rolname = 'telemetry_worker_app' AND (rolsuper OR rolbypassrls)
	) THEN
		ALTER ROLE telemetry_worker_app NOSUPERUSER NOBYPASSRLS;
	END IF;
END
$$;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_roles
		WHERE rolname = 'telemetry_worker_app' AND (rolsuper OR rolbypassrls)
	) THEN
		RAISE EXCEPTION
			'Role telemetry_worker_app still has SUPERUSER or BYPASSRLS; RLS would not enforce for worker-service, and the narrow resolver exception would be pointless.';
	END IF;
END
$$;

DO $$
BEGIN
	EXECUTE format(
		'GRANT CONNECT ON DATABASE %I TO telemetry_worker_app',
		current_database()
	);
END
$$;

GRANT USAGE ON SCHEMA "public" TO telemetry_worker_app;

-- 5. Two tables, not ten. See the header for the measurement behind the absent "Tenant" grant.
-- No DELETE: `EventRepository` issues a findUnique and two upserts and nothing else.
GRANT SELECT, INSERT, UPDATE ON TABLE "Event" TO telemetry_worker_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "UsageLine" TO telemetry_worker_app;

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
		  AND c.relname NOT IN ('Event', 'UsageLine')
	LOOP
		EXECUTE format(
			'REVOKE ALL ON TABLE public.%I FROM telemetry_worker_app',
			v_relation
		);
	END LOOP;
END
$$;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA "public" FROM telemetry_worker_app;

-- No default *grant* for tables, which is the point of the two tables above. These two
-- statements converge a hand-made schema-scoped grant to this role and nothing else: per
-- section 6, a schema-scoped default ACL is merged with `acldefault()` and so cannot subtract
-- from a built-in default -- but it can subtract from an explicit schema-scoped grant, which is
-- the case they exist for. Deliberately no TRUNCATE/REFERENCES/TRIGGER, no CREATE on the schema,
-- no ownership. (The schema has no sequences; Prisma generates ids client-side.)
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
	REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM telemetry_worker_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
	REVOKE USAGE, SELECT ON SEQUENCES FROM telemetry_worker_app;

-- 6. The resolver.
--
-- **`text` parameters, cast in the body, and this is the load-bearing detail of the whole file.**
-- Declaring them `timestamp(3)` does not protect the day boundary: the coercion happens in the
-- *caller's* session, before the body runs. Measured on this host across three session zones
-- with `PREPARE p(timestamptz) AS SELECT $1::timestamp(3)` -- which is what a bound JS Date
-- meeting a naive timestamp parameter does -- given '2026-09-15T00:00:00.000Z':
--
--   UTC               -> 2026-09-15 00:00:00
--   Asia/Kolkata      -> 2026-09-15 05:30:00
--   America/New_York  -> 2026-09-14 20:00:00
--
-- while the same input through `PREPARE q(text) AS SELECT $1::timestamp(3)` returned
-- 2026-09-15 00:00:00 under all three. The caller therefore binds
-- `new Date(iso).toISOString()` strings and this body does the cast. All 20 application
-- timestamp columns are `timestamp(3) without time zone` (CLAUDE.md), so there is no
-- timestamptz anywhere for the comparison to resolve through.
--
-- SETOF text and nothing wider: the narrower the return, the smaller the exception. STRICT so a
-- NULL bound short-circuits without touching the table; STABLE because it only reads;
-- search_path pinned and every reference schema-qualified so the body cannot be captured by a
-- caller-controlled search_path.
--
-- Half-open `[start, end)`, matching billing-service's own
-- `InvoiceRepository.sumUnbilledByMetricKey`, which selects
-- `billed: false, periodStart: { gte, lt }`. The two predicates are deliberately identical: a
-- tenant this function names is exactly a tenant for which that query finds rows. Filtering on
-- `periodStart` alone is correct because worker writes
-- `periodStart === periodEnd === occurredAt` (`src/validators/stream-message.validator.ts`), so
-- a UsageLine's period is an instant rather than a span.
CREATE OR REPLACE FUNCTION public.worker_resolve_tenants_with_unbilled_usage(
	p_period_start text,
	p_period_end text
)
RETURNS SETOF text
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
	SELECT DISTINCT ul."tenantId"
	FROM public."UsageLine" ul
	WHERE ul."billed" = false
	  AND ul."periodStart" >= p_period_start::timestamp(3)
	  AND ul."periodStart" < p_period_end::timestamp(3);
$fn$;

ALTER FUNCTION public.worker_resolve_tenants_with_unbilled_usage(text, text)
	OWNER TO telemetry_worker_definer;

-- PostgreSQL grants EXECUTE on every new function to PUBLIC, and every application role is in
-- PUBLIC. v1_5 already installed the **database-scoped**
-- `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, which covers functions
-- created by the migration role, and it is deliberately **not** repeated here: the entry is
-- recorded per creating role and v1_5's is the same role.
--
-- Do **not** "tidy" that statement, there or here, by adding `IN SCHEMA "public"`. A
-- schema-scoped default ACL is *merged with* `acldefault()`, which contains `=X` for PUBLIC, so
-- the schema-scoped form is accepted and does nothing at all -- no pg_default_acl row, and a
-- function created afterwards is still world-executable. That trap is S-11 and it cost a review
-- round.
--
-- The explicit revokes below are written anyway, exactly as v1_5 does: the default does not
-- cover a function created by any other role, and the REVOKE from telemetry_app is load-bearing
-- independently -- if a later revision ever grants it, a GRANT cannot take itself back.
REVOKE ALL ON FUNCTION public.worker_resolve_tenants_with_unbilled_usage(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.worker_resolve_tenants_with_unbilled_usage(text, text)
	FROM telemetry_app;
REVOKE ALL ON FUNCTION public.worker_resolve_tenants_with_unbilled_usage(text, text)
	FROM telemetry_auth_app;

GRANT EXECUTE ON FUNCTION public.worker_resolve_tenants_with_unbilled_usage(text, text)
	TO telemetry_worker_app;

-- 7. Catalog guard: the resolver is SECURITY DEFINER, owned by the narrow definer role,
-- reachable only by worker-service's own role, and the definer's read policy is in place.
DO $$
DECLARE
	v_name text := 'public.worker_resolve_tenants_with_unbilled_usage(text,text)';
	v_other text;
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_proc p
		JOIN pg_roles r ON r.oid = p.proowner
		WHERE p.oid = v_name::regprocedure
		  AND p.prosecdef
		  AND r.rolname = 'telemetry_worker_definer'
	) THEN
		RAISE EXCEPTION '% must be SECURITY DEFINER and owned by telemetry_worker_definer.', v_name;
	END IF;

	-- The narrowness of the exception, asserted rather than trusted to review: tenant ids only.
	-- A widened return type is a different exception from the one this file documents.
	IF NOT EXISTS (
		SELECT 1 FROM pg_proc p
		WHERE p.oid = v_name::regprocedure
		  AND pg_get_function_result(p.oid) = 'SETOF text'
		  AND pg_get_function_arguments(p.oid) = 'p_period_start text, p_period_end text'
	) THEN
		RAISE EXCEPTION
			'% must return SETOF text and take two text parameters. Timestamp parameters would be coerced in the caller''s session, sliding the day boundary by the session offset; a wider return type would widen the cross-tenant exception.',
			v_name;
	END IF;

	IF has_function_privilege('public', v_name, 'EXECUTE') THEN
		RAISE EXCEPTION 'PUBLIC must not hold EXECUTE on %.', v_name;
	END IF;

	IF has_function_privilege('telemetry_app', v_name, 'EXECUTE') THEN
		RAISE EXCEPTION
			'telemetry_app must not hold EXECUTE on % -- it is shared by gateway, usage-, billing- and analytics-service, and this function enumerates every tenant with unbilled usage.',
			v_name;
	END IF;

	IF NOT has_function_privilege('telemetry_worker_app', v_name, 'EXECUTE') THEN
		RAISE EXCEPTION 'telemetry_worker_app must hold EXECUTE on %.', v_name;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_policies
		WHERE schemaname = 'public'
		  AND tablename = 'UsageLine'
		  AND policyname = 'usageline_worker_definer_read'
		  AND cmd = 'SELECT'
		  AND 'telemetry_worker_definer' = ANY (roles)
	) THEN
		RAISE EXCEPTION
			'Policy usageline_worker_definer_read is missing, is not SELECT-only, or is not scoped to telemetry_worker_definer; without it the resolver returns an empty set silently and nobody is invoiced.';
	END IF;

	-- Asserting the *exact* set, not just presence. Permissive policies OR together, so one
	-- stray `USING (true)` on "UsageLine" -- a rename that left the old policy behind, say --
	-- widens tenant reach for anyone the stray policy names.
	IF EXISTS (
		SELECT 1 FROM pg_policies
		WHERE schemaname = 'public'
		  AND tablename = 'UsageLine'
		  AND policyname NOT IN ('usage_line_tenant_isolation', 'usageline_worker_definer_read')
	) THEN
		RAISE EXCEPTION
			'Unexpected policy on "UsageLine"; a permissive policy here can widen tenant reach beyond usage_line_tenant_isolation.';
	END IF;

	-- The same check as above but by mechanism rather than by name, mirroring v1_5 section 7:
	-- any SECURITY DEFINER function in `public` reads with its owner's privileges, so none may be
	-- reachable by PUBLIC or by the shared application role. This is what catches a later
	-- migration that adds a resolver and forgets the REVOKE.
	FOR v_other IN
		SELECT p.oid::regprocedure::text
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'public' AND p.prosecdef
	LOOP
		IF has_function_privilege('public', v_other, 'EXECUTE') THEN
			RAISE EXCEPTION 'PUBLIC must not hold EXECUTE on SECURITY DEFINER function %.', v_other;
		END IF;

		IF has_function_privilege('telemetry_app', v_other, 'EXECUTE') THEN
			RAISE EXCEPTION
				'telemetry_app must not hold EXECUTE on SECURITY DEFINER function % -- it is shared by five services.',
				v_other;
		END IF;
	END LOOP;

	-- Neither application role may reach the definer. Its policy is `USING (true)` and applies
	-- through membership, so a member reads every tenant's "UsageLine" rows with no tenant
	-- context and without calling the resolver at all -- and for telemetry_worker_app the EXECUTE
	-- checks above cannot notice, because it holds EXECUTE legitimately. `pg_has_role` counts
	-- transitive grants, so an intermediate role does not launder it. The migration role itself
	-- may be a member: `ALTER FUNCTION ... OWNER TO` requires that, and it is not an application
	-- connection.
	IF pg_has_role('telemetry_app', 'telemetry_worker_definer', 'USAGE') THEN
		RAISE EXCEPTION
			'telemetry_app can assume telemetry_worker_definer; usageline_worker_definer_read is USING (true) and applies through membership, so it would read every tenant''s "UsageLine" rows.';
	END IF;

	IF pg_has_role('telemetry_worker_app', 'telemetry_worker_definer', 'USAGE') THEN
		RAISE EXCEPTION
			'telemetry_worker_app can assume telemetry_worker_definer; usageline_worker_definer_read is USING (true) and applies through membership, so it would read every tenant''s "UsageLine" rows directly, bypassing the SETOF text bound the resolver exists to impose.';
	END IF;

	IF pg_has_role('telemetry_auth_app', 'telemetry_worker_definer', 'USAGE') THEN
		RAISE EXCEPTION
			'telemetry_auth_app can assume telemetry_worker_definer.';
	END IF;

	-- worker-service's role must hold DML on exactly the two tables it writes. Read from
	-- pg_class/pg_attribute rather than information_schema.role_table_grants: that view shows
	-- only rows whose grantor or grantee is a *currently enabled role*, so on the managed
	-- deployment this file's header describes -- a non-superuser migration role -- it returns
	-- nothing and the check passes vacuously. attacl covers column-level grants, which the view
	-- misses in every case.
	IF EXISTS (
		SELECT 1
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		CROSS JOIN LATERAL aclexplode(c.relacl) a
		WHERE n.nspname = 'public'
		  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
		  AND a.grantee = 'telemetry_worker_app'::regrole
		  AND c.relname NOT IN ('Event', 'UsageLine')
	) THEN
		RAISE EXCEPTION
			'telemetry_worker_app holds table privileges outside "Event"/"UsageLine"; worker-service writes only those two.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM pg_attribute att
		JOIN pg_class c ON c.oid = att.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		CROSS JOIN LATERAL aclexplode(att.attacl) a
		WHERE n.nspname = 'public'
		  AND a.grantee = 'telemetry_worker_app'::regrole
		  AND c.relname NOT IN ('Event', 'UsageLine')
	) THEN
		RAISE EXCEPTION
			'telemetry_worker_app holds column privileges outside "Event"/"UsageLine".';
	END IF;

	-- The definer must not have collected table privileges beyond the one it reads.
	IF EXISTS (
		SELECT 1
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		CROSS JOIN LATERAL aclexplode(c.relacl) a
		WHERE n.nspname = 'public'
		  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
		  AND a.grantee = 'telemetry_worker_definer'::regrole
		  AND c.relname <> 'UsageLine'
	) THEN
		RAISE EXCEPTION
			'telemetry_worker_definer holds table privileges outside "UsageLine"; it owns a SECURITY DEFINER function, so every grant it holds is reachable through that function''s body.';
	END IF;
END
$$;

-- 8. Functional guard: prove the resolver actually resolves, with NO tenant context set.
--
-- The catalog guard above cannot prove this on its own. A definer whose owner has no way past
-- the policies returns an **empty set with no error**, which is indistinguishable downstream
-- from "no tenant had unbilled usage yesterday" -- so the nightly job would bill nobody and
-- nothing would raise an alarm, because no invoice looks exactly like no usage. That is the
-- v1_5-class failure, reproduced from inside its own fix, and this block is what catches it.
--
-- Rows are created and removed inside this migration's transaction. app.tenant_id is set only so
-- that the probe inserts and deletes also work for a non-superuser owner, and is cleared before
-- the resolver is called so that the definer's read policy is the only thing that can make it
-- return a row. SECURITY DEFINER means the body runs as the function owner regardless of who
-- calls it, so no SET ROLE is needed here.
--
-- The negative half matters as much as the positive: a resolver that ignored `billed` or the
-- window would return the probe tenant for both calls, and only the first assertion would
-- notice.
DO $$
DECLARE
	v_probe_id text := gen_random_uuid()::text;
	v_event_id text := gen_random_uuid()::text;
	v_billed_event_id text := gen_random_uuid()::text;
	v_start timestamp(3) := timestamp '2000-01-02 00:00:00';
	v_at timestamp(3) := timestamp '2000-01-02 06:00:00';
	v_end timestamp(3) := timestamp '2000-01-03 00:00:00';
	v_unbilled text[];
	v_outside text[];
BEGIN
	PERFORM set_config('app.tenant_id', v_probe_id, true);

	INSERT INTO public."Tenant" ("id", "name") VALUES (v_probe_id, 'v1_7 enumerator probe');
	INSERT INTO public."Event"
		("id", "tenantId", "idempotencyKey", "eventType", "quantity", "unit", "occurredAt")
		VALUES (v_event_id, v_probe_id, 'v1_7-probe-' || v_probe_id, 'v1_7.probe', 1, 'probe', v_at);
	INSERT INTO public."UsageLine"
		("id", "tenantId", "eventId", "metricKey", "quantity", "periodStart", "periodEnd", "billed")
		VALUES (gen_random_uuid()::text, v_probe_id, v_event_id, 'v1_7.probe', 1, v_at, v_at, false);
	-- A second, already-billed row for the same tenant in the same window, so that the negative
	-- assertion below cannot be satisfied by the tenant simply having no rows at all.
	INSERT INTO public."Event"
		("id", "tenantId", "idempotencyKey", "eventType", "quantity", "unit", "occurredAt")
		VALUES (v_billed_event_id, v_probe_id, 'v1_7-probe-billed-' || v_probe_id, 'v1_7.probe', 1, 'probe', v_at);
	INSERT INTO public."UsageLine"
		("id", "tenantId", "eventId", "metricKey", "quantity", "periodStart", "periodEnd", "billed")
		VALUES (gen_random_uuid()::text, v_probe_id, v_billed_event_id, 'v1_7.probe', 1, v_at, v_at, true);

	PERFORM set_config('app.tenant_id', '', true);
	SELECT array_agg(t) INTO v_unbilled
	FROM public.worker_resolve_tenants_with_unbilled_usage(
		v_start::text, v_end::text
	) AS t;
	SELECT array_agg(t) INTO v_outside
	FROM public.worker_resolve_tenants_with_unbilled_usage(
		v_end::text, (v_end + interval '1 day')::text
	) AS t;
	PERFORM set_config('app.tenant_id', v_probe_id, true);

	DELETE FROM public."UsageLine" WHERE "tenantId" = v_probe_id;
	DELETE FROM public."Event" WHERE "tenantId" = v_probe_id;
	DELETE FROM public."Tenant" WHERE "id" = v_probe_id;

	IF v_unbilled IS DISTINCT FROM ARRAY[v_probe_id] THEN
		RAISE EXCEPTION
			'worker_resolve_tenants_with_unbilled_usage returned % with no tenant context; expected exactly {%}. The definer role cannot see past RLS, or the DISTINCT was lost.',
			coalesce(v_unbilled::text, 'NULL'), v_probe_id;
	END IF;

	IF v_outside IS NOT NULL THEN
		RAISE EXCEPTION
			'worker_resolve_tenants_with_unbilled_usage returned % for a window containing none of the probe rows; the half-open [start, end) interval is not being applied.',
			v_outside::text;
	END IF;
END
$$;
