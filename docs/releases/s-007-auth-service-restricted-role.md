# Release note — S-7 · auth-service moves onto a restricted database role

Applies to the change that adds `prisma/migrations/v1_5_auth_tenant_resolvers` and flips
auth-service's `DATABASE_URL`. Plan: `docs/plans/s-007-auth-service-restricted-role.md`.

**This is a two-step deploy. The migration and the connection-string change must not ship as
one step.** If auth-service starts on the new role before the resolvers exist, nobody can log
in or register.

---

## What changed

`prisma/migrations/v1_5_auth_tenant_resolvers` creates **two roles** and two functions.

- `telemetry_auth_definer` — `NOLOGIN NOSUPERUSER NOBYPASSRLS`, holding `SELECT` on `"User"`
  and `"RefreshToken"` and nothing else. It owns:
  - `public.auth_resolve_tenant_by_email(text) RETURNS text`
  - `public.auth_resolve_tenant_by_refresh_token_hash(text) RETURNS text`

  Both `SECURITY DEFINER`, `STABLE`, `STRICT`, with a pinned `search_path`, and both return the
  **tenant id only** — never a password hash.

  It reads past the `"User"` tenant policy through two targeted policies the migration also
  creates — `user_auth_definer_read` and `refreshtoken_auth_definer_read`, both `FOR SELECT`,
  both scoped `TO telemetry_auth_definer` — **not** through the `BYPASSRLS` role attribute.
  `BYPASSRLS` would apply to every table the role could ever reach; a policy is bounded by
  mechanism rather than by the convention that nobody adds another `GRANT`.

- `telemetry_auth_app` — `LOGIN NOSUPERUSER NOBYPASSRLS`, owner of no table. **`EXECUTE` on both
  resolvers is granted to this role alone**, and revoked from `PUBLIC` and from `telemetry_app`.

  That is why the role exists. `telemetry_app` is shared by gateway, usage, worker, billing and
  analytics; granting it `EXECUTE` would give all five an e-mail → tenant oracle that reads
  straight past the `"User"` policy this change exists to make enforce.

  Its table privileges are **narrower** than `telemetry_app`'s: DML on `"Tenant"`, `"User"` and
  `"RefreshToken"` only — the three tables auth-service touches — with no
  `ALTER DEFAULT PRIVILEGES`, so a future table has to be granted deliberately. `telemetry_app`
  holds DML on all ten tables because five services share it; copying that would have handed
  auth-service cross-tenant write access to `"InvoiceLineItem"`, where RLS is inert (S-10).

  **Provisioning consequence:** if you create this role out of band, grant those three tables and
  no more. A wider grant is both converged and rejected: the migration revokes everything outside
  the three, and its guard then fails if anything is left — reading `pg_class`/`pg_attribute`
  rather than `information_schema`, so the check works for a non-superuser migration role and
  catches column-level grants too.

auth-service's runtime `DATABASE_URL` becomes `telemetry_auth_app`. PostgreSQL RLS now enforces
on `"User"` and `"Tenant"` for auth-service too.

---

## This migration was revised after first being applied

`v1_5` was edited in place rather than superseded, twice, while it existed only on one
developer's machine: once to replace the definer role's `BYPASSRLS` attribute with two targeted
policies, and once to narrow `telemetry_auth_app`'s table grants and drop an ineffective
`ALTER DEFAULT PRIVILEGES` line. A forward migration could not have fixed the first of those —
`v1_5` asserted `BYPASSRLS` in its own guards, so it would have stayed unappliable on any platform
where that attribute is unavailable, which no later migration can repair.

**If any environment applied an earlier revision**, `prisma migrate deploy` will refuse with
"the migration … was modified after it was applied" rather than doing anything silently. To
recover: compare the live catalog against sections 7 and 8 of the migration file (role attributes,
function ownership and ACLs, both definer policies, the three table grants), re-run the file by
hand as the owner if anything is missing, then
`prisma migrate resolve --applied v1_5_auth_tenant_resolvers` to re-record the checksum.

Re-run it in a single transaction, so a partial application cannot leave auth-service unable to
log anyone in:

```bash
psql "$DIRECT_DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
  -f prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql
```

`prisma migrate deploy` already wraps the file this way. Every block is individually idempotent and
the two convergence steps (the policy creates in section 3, and the grant-then-revoke in section 4)
are ordered so that no intermediate state removes access — but `--single-transaction` makes that
guarantee independent of the ordering, which is the point.

Migrations are forward-only from here. This note exists because the exception was taken
deliberately and an operator hitting the checksum error deserves to find it written down.

---

## Deploy order

1. **Apply `v1_5` as the owner.** Prisma reads `DIRECT_DATABASE_URL` as `directUrl`, so
   `migrate deploy` runs as the admin/owner role:

   ```bash
   pnpm --filter @telemetry/auth-service exec prisma migrate deploy \
     --schema=../../prisma/schema.prisma
   ```

2. **Verify the resolvers, connected as `telemetry_auth_app`.** This step is not optional: a
   definer that cannot see past the policies makes the resolvers return `NULL` *silently*,
   which reproduces the exact bug this change fixes.

   ```bash
   psql "$AUTH_DATABASE_URL" -c \
     "SELECT public.auth_resolve_tenant_by_email('<an address that exists>');"
   ```

   Expect the account's tenant id. A `NULL` for an address you know exists means stop and
   check that both policies are present:

   ```sql
   SELECT tablename, policyname, cmd, roles FROM pg_policies
   WHERE policyname IN ('user_auth_definer_read', 'refreshtoken_auth_definer_read');
   ```

3. **Only then roll auth-service's `DATABASE_URL`** to the `telemetry_auth_app` connection
   string.

The migration will not let step 1 succeed in a broken state. It fails loudly if either role has
the wrong attributes; if a function is not `SECURITY DEFINER` or is owned by the wrong role; if
`PUBLIC` or `telemetry_app` holds `EXECUTE` on *any* `SECURITY DEFINER` function in `public`, not
just these two; if `telemetry_auth_app` lacks `EXECUTE` on these two or holds table privileges
outside its three; if either definer policy is missing, or if `"User"` or `"RefreshToken"` carries
an unexpected policy; or if a live end-to-end resolution with no tenant context comes back
`NULL`.

CI already enforces this ordering — "Apply Prisma Migrations" runs before every test step.

---

## Managed Postgres

`CREATE ROLE` requires `CREATEROLE` or superuser. RDS, Cloud SQL and Neon migration roles
usually have `CREATEROLE`, in which case the migration applies unchanged — dropping the
`BYPASSRLS` requirement is what makes that true, since `CREATE ROLE … BYPASSRLS` requires
superuser and is simply unavailable on all three.

If the migration role cannot create roles at all, provision both out of band:

```sql
CREATE ROLE telemetry_auth_definer
  NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE telemetry_auth_app
  LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD '<a real secret>';

-- Required: ALTER FUNCTION ... OWNER TO needs the migration role to be a *member* of the
-- new owner. Without this the migration fails with
--   ERROR: must be able to SET ROLE "telemetry_auth_definer"
GRANT telemetry_auth_definer TO <migration_role>;
```

then re-run `migrate deploy`. Every block in the migration is guarded and idempotent, so a
re-run after out-of-band provisioning completes cleanly.

The `GRANT … TO <migration_role>` line is safe precisely because the definer is `NOBYPASSRLS`:
membership confers two `SELECT` grants and two `SELECT` policies, not a blanket RLS exemption.

---

## Rollback

Two independent levers, in this order:

1. **Config only, no code deploy.** Point auth-service's `DATABASE_URL` back at the admin
   role. Everything works immediately: the new code paths are strictly compatible with a
   superuser connection — `set_config` is harmless and the resolvers still resolve (a superuser
   can execute them regardless of the grant). This is the fast lever and needs no rebuild.
2. **Revert the application commit.** Do **not** revert `v1_5` with a `DROP`. Migrations are
   forward-only; leaving the roles, policies and functions in place is harmless (the functions
   are `REVOKE`d from `PUBLIC` and from `telemetry_app`, the definer is `NOLOGIN`, and both
   policies are scoped to that `NOLOGIN` role), and dropping them would break any instance
   still running the new code.

The artifacts `v1_5` leaves in the database are the two roles, the two policies, the two
functions, and **one `pg_default_acl` row** (`defaclnamespace = 0`, `defaclobjtype = 'f'`) — the
last of which is easy to overlook because it belongs to no schema. If you ever need the old
behaviour back:

```sql
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;   -- removes the row
```

---

## Latency: login and refresh gain round-trips

Worth knowing before it shows up in dashboards. Login was a single `findUnique`. It is now a
resolver `SELECT` outside any transaction, then `BEGIN` → `set_config` → `SELECT` → `COMMIT`,
then a second transaction of the same shape for `storeRefreshToken` — roughly 1 → ~9 round-trips
per login. Refresh is the same shape.

Accepted deliberately: bcrypt at 10–12 rounds is 50–300 ms and dominates by two orders of
magnitude, so end-to-end latency is effectively unchanged and the login *enumeration* profile
is preserved (`AuthService.login` still compares against `AUTH_SECURITY.DUMMY_PASSWORD_HASH` on
a miss). It is a real change in connection-pool usage on the busiest endpoint, though. If it
ever matters, the resolver call can be folded into the same transaction as the scoped read.

---

## Adding another `SECURITY DEFINER` function later

Revoke `EXECUTE` from `PUBLIC` explicitly, in the same migration that creates it, and grant it to
`telemetry_auth_app` rather than `telemetry_app`.

`v1_5` sets a **database-scoped** default privilege —
`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` — so a function created by the
migration role no longer gets `PUBLIC` `EXECUTE` at all. **Write it without `IN SCHEMA`**: the
schema-scoped form is accepted and does nothing, because a schema-scoped default ACL is merged
with `acldefault()`, which already contains `=X` for `PUBLIC`. Verified both ways on PG 16.13.

The default is recorded per creating role, so it does not cover a function created by some other
role at a psql prompt. That residual is **S-11** in `.claude/rules/known-gaps.md`, and two guards
catch it: the migration's own loop over every `SECURITY DEFINER` function in `public`, and the
standing assertion in `apps/auth-service/tests/rls.integration.test.ts` that none of them is
reachable by `PUBLIC` or `telemetry_app`, which runs on every `pnpm test`.

### It also applies database-wide — read this before installing an extension

Because the statement has no `IN SCHEMA`, the entry is recorded at `defaclnamespace = 0`: it
covers **every** function the migration role creates, in every schema of this database, not only
`SECURITY DEFINER` functions and not only `public`. That is deliberate — a schema-scoped entry
cannot subtract `PUBLIC`'s `EXECUTE` at all — but it has a consequence worth knowing before you
meet it:

```sql
CREATE EXTENSION pgcrypto;   -- run as the migration role
```

produces `crypt`, `armor`, `dearmor` … as `{owner=X/owner}`, so `telemetry_app` cannot call them
and the five services sharing that role fail at runtime with
`ERROR 42501: permission denied for function crypt`. It fails closed, and it stays silent until
something actually calls the function.

After installing an extension (or creating any function the services need), grant explicitly:

```sql
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "public" TO telemetry_app;
-- or, better, name the functions the services actually call
```

---

## Known limitation carried forward

`"RefreshToken"` has RLS `FORCE`d but never `ENABLE`d, so it has no *active* policy and is
readable and writable across tenants by any holder of an application-role credential. Filed as
**S-10** in `.claude/rules/known-gaps.md`; deliberately not fixed in the same change that flips
the connection role.

Two things make closing it a migration rather than a code change: every `"RefreshToken"` query
in `UserRepository` is already inside tenant context and carries a `user: { tenantId }` relation
predicate where a `where` clause exists at all, and `v1_5` already creates the
`refreshtoken_auth_definer_read` policy that the resolver's owner will need the moment RLS is
enabled there.
