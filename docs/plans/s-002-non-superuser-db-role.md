# S-2 — Run the application as a non-superuser database role

**Gap:** `.claude/rules/known-gaps.md` § S-2 (HIGH)
**Owner:** enterprise-delivery (plan + implement + self-review in one pass)
**Status:** implemented, self-reviewed — see `docs/reviews/s-002-non-superuser-db-role.md`

## Approval gate

**Gate 2 (plan approval) was authorized in-session by the user**, who granted full scope up
front: "create the role and grants **and** flip the connection strings in `.env.example`, the
five `apps/*/.env.example` files, and `.github/workflows/ci.yml`." Recorded here per
`.claude/agents/enterprise-delivery.md`, which permits an explicit in-session authorization in
place of a separate approval round. No commit, stage, push or branch was performed.

Because this is a security-critical change reviewed by its own author, an independent
`senior-reviewer` pass is recommended before commit.

---

## 1. The gap, verified

Not taken on trust. Against the live `telemetry` database:

```
$ psql -h localhost -U postgres -d telemetry \
    -c "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user;"
 rolname  | rolsuper | rolbypassrls
----------+----------+--------------
 postgres | t        | t
(1 row)
```

`FORCE ROW LEVEL SECURITY` does not help. Postgres applies RLS to a role unless that role is
a superuser, holds `BYPASSRLS`, or owns the table; `FORCE` removes only the third exemption.
`DATABASE_URL` hits the first two. Every policy in `prisma/migrations/v1_0_*` and
`v1_2_*` is therefore inert, and the app-layer `WHERE tenantId` predicate is the only thing
separating tenants.

Two committed comments assert the opposite and are wrong:
`apps/usage-service/src/repositories/base.repository.ts:52` and
`prisma/migrations/v1_2_force_row_level_security/migration.sql:2`. The same false line turned
out to exist in **five** `base.repository.ts` files, not one — see §7.

## 2. The bootstrap-ordering problem

Prisma applies migrations **as the connecting user**. If `DATABASE_URL` becomes the restricted
role then:

- the migration that creates that role would have to run as the role it is creating;
- the restricted role would need `CREATE ROLE`, defeating the point;
- the restricted role would end up owning every table a future migration creates, and an owner
  is exempt from RLS unless `FORCE` is set on that table — a trap that reintroduces S-2 for any
  table someone forgets to `FORCE`.

### Decision: two connection strings, split by Prisma's native `directUrl`

| Env var | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `telemetry_app` — `NOSUPERUSER`, `NOBYPASSRLS`, owns nothing | every service at runtime; Prisma Client `url` |
| `DIRECT_DATABASE_URL` | admin/owner (`postgres` locally) | Prisma `directUrl`: `migrate deploy`, `migrate status`; plus fixtures/seeding that RLS would block |

`prisma/schema.prisma` gains one line:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_DATABASE_URL")
}
```

Why this and not the alternatives considered:

- *One URL, role created out of band (ops runbook).* Rejected: nothing then guarantees the
  grants track new tables, and a fresh clone silently has no role.
- *Migrations run as the app role with `CREATEROLE`.* Rejected: it would have to own the
  tables, which is the exemption we are trying to remove.
- *A separate migration runner package with its own schema file.* Rejected: the repo already
  has exactly one `prisma/schema.prisma` (CLAUDE.md § Prisma) and `directUrl` is the
  first-class Prisma answer to this exact split.

### Verified against the tooling before relying on it

`pnpm prisma:generate:auth` copies `prisma/schema.prisma` to `apps/auth-service/schema.ci.prisma`,
generates from that copy so the client resolves through auth-service's own pnpm links, then
deletes the copy. It runs as `pretest`, so it must not start requiring database env vars.
Confirmed it does not:

```
$ env -u DIRECT_DATABASE_URL -u DATABASE_URL pnpm prisma:generate:auth
✔ Generated Prisma Client (v6.19.3) ... in 105ms
```

Also confirmed `PrismaClient` at runtime ignores an unset `directUrl` (so no service needs the
admin credential in its environment), and that `migrate deploy` uses `directUrl` exclusively —
it bootstrapped the role from scratch with `DATABASE_URL` pointing at a role that did not yet
exist. Evidence in the review.

## 3. Answers to the four questions

- **Who runs migrations?** The admin/owner role, via `DIRECT_DATABASE_URL`. Unchanged commands.
- **Who runs at runtime?** `telemetry_app`, via `DATABASE_URL`. It cannot create roles, owns no
  table, and holds only `SELECT/INSERT/UPDATE/DELETE`.
- **Fresh clone?** `docker compose up` (init script creates the role) or a local Postgres plus
  `prisma migrate deploy` with `DIRECT_DATABASE_URL` set (migration creates the role). Either
  path ends with the role present and the documented local password, which is what
  `.env.example` ships. Documented in `docs/development-setup.md`.
- **CI?** Job env carries both URLs. `prisma migrate deploy` bootstraps the role as the owner
  before anything else runs. A new `Verify RLS Is Enforcing` step runs the enforcement suite
  against `DATABASE_URL` and fails if that role is a superuser or holds `BYPASSRLS`.

## 4. The migration

`prisma/migrations/v1_4_app_role_non_superuser/migration.sql`, matching the `v1_N_` convention.
Idempotent throughout:

1. `CREATE ROLE telemetry_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
   NOREPLICATION PASSWORD '…'` — only when the role is absent.
2. `ALTER ROLE … NOSUPERUSER NOBYPASSRLS` — only when a pre-existing role has the wrong
   attributes. Guarded because those attributes require superuser to change, and a managed
   platform's migration role may not have it; issuing it unconditionally would fail migrations
   on RDS-style clusters for no benefit.
3. A `RAISE EXCEPTION` guard: if the role still has `rolsuper` or `rolbypassrls`, the migration
   **fails**. Better a red migration than a green one that leaves RLS inert.
4. `GRANT CONNECT` on `current_database()` via `format(… %I …)`, so the grant is not hard-coded
   to one database name (`telemetry` vs `telemetry_test`).
5. `GRANT USAGE ON SCHEMA public`; `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES`;
   `GRANT USAGE, SELECT ON ALL SEQUENCES`. No `CREATE`, no `TRUNCATE`, no ownership.
6. `ALTER DEFAULT PRIVILEGES IN SCHEMA public` for tables and sequences, with **no** `FOR ROLE`
   clause so it is recorded for the executing owner — the role Prisma Migrate connects as —
   and therefore covers every table a future migration creates.
7. `REVOKE ALL ON TABLE "_prisma_migrations"` — migration history is not application data, and
   step 5 would otherwise hand the app role write access to it.

### Password handling

No production secret is committed. The migration sets a password **only when it creates the
role**, and the value is a documented local/CI default (`telemetry_app_local_dev`) that matches
what `.env.example`, the compose file and CI ship. A real deployment provisions
`telemetry_app` out of band with a managed secret; because the role then already exists, this
migration never touches its password on any subsequent run. The alternative — reading a GUC or
a `psql` variable — does not work through Prisma Migrate, which applies plain SQL with no
variable substitution.

## 5. Docker Compose

`docker/docker-compose.yml` runs **no** migrations — CI applies migrations to the *host*
Postgres and then brings up a separate compose Postgres with an empty volume. Relying on the
migration there would leave the role absent, every service unable to authenticate, every
healthcheck failing, and `docker compose --wait` (and so CI) failing.

Decision: add `docker/postgres/init/01-app-role.sql`, mounted read-only at
`/docker-entrypoint-initdb.d`. The migration stays as the source of truth wherever migrations
actually run; both are idempotent, so whichever runs first wins. Init scripts only execute on
an empty data volume, so `down -v` is required after editing — documented in the file and in
`docs/development-setup.md`.

## 6. Connection strings flipped

- `.env.example` — `DATABASE_URL` → `telemetry_app`; adds `DIRECT_DATABASE_URL`.
- `apps/{usage,worker,billing,analytics}-service/.env.example` → `telemetry_app`.
- `apps/auth-service/.env.example` → **deliberately left on the admin role.** See §8.
- `.github/workflows/ci.yml` — both URLs at job level, plus `AUTH_TEST_DATABASE_URL`.
- `docker/docker-compose.yml` — shared `x-common-app-env` → `telemetry_app`; auth-service
  overrides back to admin.
- `apps/{usage,worker,billing,analytics}-service/tests/setup.ts` defaults → `telemetry_app`,
  plus a `DIRECT_DATABASE_URL` default. Without this a future live-DB test in those packages
  would silently connect as a superuser and re-create S-2 inside the test suite.
- `prisma/seed.ts` → `DIRECT_DATABASE_URL`; it creates tenants before any tenant context
  exists and is blocked by the `"Tenant"` `WITH CHECK` policy as the app role.

## 7. Comment corrections

The false claim "RLS policies use FORCE RLS to prevent superuser bypass" exists at line 51 of
`base.repository.ts` in **all five** services with one (usage, worker, billing, analytics,
auth), not only the one named in the gap. All five are corrected; leaving four copies of a
security falsehood in place would be a review finding in its own right. The auth-service copy
gets a different, weaker wording because of §8. `v1_2_force_row_level_security/migration.sql`
gets an in-place `CORRECTION` note.

Editing an already-applied migration changes its checksum. Verified that this is safe with
Prisma 6.19: `migrate status` and `migrate deploy` against a database holding the old checksum
both report clean (evidence in the review).

Two further files asserted the same now-stale claim and are corrected: `CLAUDE.md`
§ "Tenant isolation" and `.claude/rules/tenant-isolation.md` § "Known gaps".

## 8. Deviation from the authorized scope: auth-service stays on the admin role

The authorization covered all five `apps/*/.env.example`. Four were flipped. auth-service was
not, because flipping it **breaks login and registration outright** — verified, not predicted:

```
$ AUTH_TEST_DATABASE_URL=postgresql://telemetry_app:…@localhost:5432/telemetry_s2_scratch \
    pnpm --filter @telemetry/auth-service exec vitest run tests/auth.integration.test.ts
 Tests  9 failed | 6 passed (15)
```

`apps/auth-service/src/repositories/user.repository.ts` queries **before a tenant is known**:
`findUserForLogin` and the duplicate-e-mail check select `"User"` by e-mail with no tenant
context (policy matches nothing → every login returns "no such user"), and registration INSERTs
a `"Tenant"` before any tenant exists (`ERROR: new row violates row-level security policy for
table "Tenant"`).

The three ways to close this are (a) grant the role `BYPASSRLS`, (b) add a policy that lets any
role read every user, or (c) move the pre-tenant lookups behind `SECURITY DEFINER` functions
and generate the tenant id application-side for registration. (a) and (b) are S-2 by another
name and are excluded by the brief's "do not weaken or remove any RLS policy". (c) is correct
but is a substantial rewrite of auth-service's data access plus its unit-test doubles, with its
own security surface — a separate task deserving an independent reviewer.

So: four services enforce RLS today; auth-service is recorded as **S-7** in
`.claude/rules/known-gaps.md` with the fix direction, and every place that pins it to the admin
role carries a pointer to S-7.

## 9. Proving enforcement

`apps/usage-service/tests/rls.enforcement.integration.test.ts` — new, automated, seven cases.
Every assertion issues a raw `SELECT … FROM "UsageLine"` with **no application `WHERE`
clause**, so only the database can restrict the result.

Deliberately **does not skip** when the environment is wrong — that is the S-3 anti-pattern. It
asserts `rolsuper = false` and `rolbypassrls = false` and fails otherwise. It seeds through
`DIRECT_DATABASE_URL` (the app role cannot create the fixture) and asserts through
`DATABASE_URL`, and it first asserts the fixture is visible to the admin role so that "zero
rows" cannot pass vacuously.

Wired into CI as a dedicated `Verify RLS Is Enforcing` step, deliberately outside turbo so the
job-level roles are the ones under test.

## 10. Out of scope

- **S-3** (`rls.integration.test.ts`). Not modified. Its behaviour under the new role is
  reported in the review and its `known-gaps.md` entry rewritten with what was observed.
- **S-4** (`X-Internal-Secret`), **S-5**, **S-6** — untouched.
- `apps/usage-service/src/services/**` and `tests/{ingestion,deduplication}*` — another agent
  was editing these for S-1 throughout. No conflict arose: the S-2 change needed none of them.
- `.env` (untracked, gitignored) — left for the user to update by hand.

## 11. Risks

| Risk | Disposition |
|---|---|
| Existing deployments have no `telemetry_app` and no `DIRECT_DATABASE_URL` | Migration creates the role; deploy must set `DIRECT_DATABASE_URL` before `migrate deploy`. Release note required. |
| A future migration creates a table before `ALTER DEFAULT PRIVILEGES` applies | Cannot happen: default privileges are already recorded for the owner, and apply to anything created afterwards. Verified in `pg_default_acl`. |
| A future table gets RLS `ENABLE`d with no policy | Default-deny for the app role — loud failure, not a silent leak. Acceptable. |
| Managed Postgres where the migration role is not a true superuser | `ALTER ROLE … NOBYPASSRLS` is only issued when needed; the `RAISE EXCEPTION` guard fails loudly rather than proceeding unsafely. |
| Turbo strict env mode hides job-level `DATABASE_URL` from `pnpm test` | Found during validation; documented in `ci.yml`. Suites take the correct roles from their `tests/setup.ts` defaults. |
