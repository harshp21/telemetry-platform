# Self-review — S-2 · Non-superuser database role

**Plan:** `docs/plans/s-002-non-superuser-db-role.md`
**Reviewer:** enterprise-delivery (author of the change — see *Independence* below)
**Verdict:** `CONDITIONAL` — one HIGH follow-up (S-7) and one MEDIUM (S-3) must be dispositioned
by the user before commit. No blocker in the code as written.

## Independence

`.claude/agents/enterprise-delivery.md` says to flag when a task warranted independent eyes.
**This one does.** It changes the credentials every service uses to reach the database, and it
was planned, implemented and reviewed by one agent. Recommend a `senior-reviewer` pass on
`prisma/migrations/v1_4_app_role_non_superuser/migration.sql`,
`apps/usage-service/tests/rls.enforcement.integration.test.ts` and the auth-service deviation
before commit.

---

## 1. Acceptance criterion — does RLS actually enforce?

### Automated

`apps/usage-service/tests/rls.enforcement.integration.test.ts`, 7 cases, wired into CI as
`Verify RLS Is Enforcing`.

Confirmed red before the fix — same file, same assertions, only `DATABASE_URL` changed back to
the superuser (i.e. the S-2 state):

```
$ DATABASE_URL="postgresql://postgres:postgres@localhost:5432/telemetry" \
  pnpm --filter @telemetry/usage-service exec vitest run tests/rls.enforcement.integration.test.ts

 × connects at runtime as a NOSUPERUSER, NOBYPASSRLS role
   AssertionError: role postgres is a superuser; RLS cannot enforce: expected true to be false
 × returns zero rows for an unscoped SELECT with no tenant context
   AssertionError: expected [ { …(9) }, { …(9) } ] to have a length of +0 but got 2
 × returns only tenant A's rows when app.tenant_id is tenant A
   AssertionError: expected [ { …(9) }, { …(9) } ] to have a length of 1 but got 2
 × returns only tenant B's rows when app.tenant_id is tenant B
   AssertionError: expected [ { …(9) }, { …(9) } ] to have a length of 1 but got 2
 × cannot write a row belonging to another tenant
   AssertionError: promise resolved "1" instead of rejecting
 × cannot update another tenant's row even with an explicit id predicate
   AssertionError: expected 1 to be +0 // Object.is equality

 Test Files  1 failed (1)
      Tests  6 failed | 1 passed (7)
```

Green as `telemetry_app`:

```
$ pnpm --filter @telemetry/usage-service exec vitest run tests/rls.enforcement.integration.test.ts
 ✓ tests/rls.enforcement.integration.test.ts (7 tests) 269ms
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

### Manual, verbatim

Against a database bootstrapped **from nothing** — no role, no schema — by
`prisma migrate deploy` alone, then seeded through the admin connection:

```
$ PGPASSWORD=telemetry_app_local_dev psql -h localhost -U telemetry_app -d telemetry_s2_scratch

 current_user  | rolsuper | rolbypassrls
---------------+----------+--------------
 telemetry_app | f        | f
(1 row)

-- raw SELECT, no application WHERE clause, no tenant context
 id | tenantId | eventId | metricKey | quantity | periodStart | periodEnd | processedAt | billed
----+----------+---------+-----------+----------+-------------+-----------+-------------+--------
(0 rows)

BEGIN
 set_config
------------
 t_alpha
(1 row)

  id   | tenantId | metricKey | quantity
-------+----------+-----------+-----------
 ul_a1 | t_alpha  | api.calls | 10.000000
(1 row)

COMMIT
BEGIN
 set_config
------------
 t_beta
(1 row)

  id   | tenantId | metricKey | quantity
-------+----------+-----------+-----------
 ul_b1 | t_beta   | api.calls | 99.000000
(1 row)

COMMIT
```

Write side, same session:

```
--- cross-tenant write attempt (alpha context, beta row) ---
UPDATE 0
--- insert into another tenant while scoped to alpha ---
ERROR:  new row violates row-level security policy for table "UsageLine"
```

And through Prisma Client itself, not just `psql` — with `DIRECT_DATABASE_URL` unset, proving a
runtime service needs no admin credential:

```
connected as: [{"u":"telemetry_app","su":"off"}]
UsageLine rows with no tenant context: 0
UsageLine rows scoped to t_alpha: [{"id":"ul_a1","tenantId":"t_alpha"}]
```

Two rows existed in both cases (asserted through the admin connection first), so "0 rows" is a
real result, not an empty table.

## 2. Bootstrap ordering — verified, not assumed

The role was dropped and a database created empty, then:

```
$ DATABASE_URL="postgresql://telemetry_app:…@localhost:5432/telemetry_s2_scratch" \
  DIRECT_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/telemetry_s2_scratch" \
  pnpm --filter @telemetry/auth-service exec prisma migrate deploy --schema=../../prisma/schema.prisma

Applying migration `v1_0_initial_tenant_usage_rls`
…
Applying migration `v1_4_app_role_non_superuser`
All migrations have been successfully applied.
```

`DATABASE_URL` named a role that did not exist and the run still succeeded — `migrate deploy`
uses `directUrl` exclusively. That is the whole answer to the ordering trap.

Grants after that run:

```
   table_name    |            privs
-----------------+-----------------------------
 Event           | DELETE,INSERT,SELECT,UPDATE
 ExportAudit     | DELETE,INSERT,SELECT,UPDATE
 Invoice         | DELETE,INSERT,SELECT,UPDATE
 InvoiceLineItem | DELETE,INSERT,SELECT,UPDATE
 Meter           | DELETE,INSERT,SELECT,UPDATE
 MetricRollup    | DELETE,INSERT,SELECT,UPDATE
 RefreshToken    | DELETE,INSERT,SELECT,UPDATE
 Tenant          | DELETE,INSERT,SELECT,UPDATE
 UsageLine       | DELETE,INSERT,SELECT,UPDATE
 User            | DELETE,INSERT,SELECT,UPDATE
(10 rows)

 defaclobjtype |           defaclacl
---------------+-------------------------------
 r             | {telemetry_app=arwd/postgres}
 S             | {telemetry_app=rU/postgres}
```

`_prisma_migrations` is absent from that list — the explicit `REVOKE` works. No `CREATE`,
no `TRUNCATE`, no `REFERENCES`, no `TRIGGER`, no ownership. Re-applying the migration file by
hand a second time succeeds unchanged (idempotent), and `rolsuper/rolbypassrls` stay `false/false`.

## 3. Things I went looking for

**Does editing an applied migration break `migrate deploy`?** `v1_2`'s comment was corrected,
which changes its checksum (`c1f5e9…` stored vs `c9cdc3…` on disk). Tested against a database
holding the old checksum: both `migrate status` ("Database schema is up to date!") and
`migrate deploy` ("No pending migrations to apply.") exit 0. Prisma 6.19 does not re-verify
checksums of already-applied migrations on `deploy`. Safe — but worth knowing it is a *version*
property, not a guarantee.

**Does `directUrl` break `prisma generate`?** It runs as `pretest`, so a new required env var
would break every test run. Verified with both vars unset: generates fine. Also verified
`PrismaClient` construction and querying with `DIRECT_DATABASE_URL` unset.

**Is the "cannot write another tenant's row" case testing what it claims?** Initially no. The
first run failed with `Key ("eventId")=(…) already exists` — `"UsageLine"."eventId"` is UNIQUE,
so a unique-constraint violation was masquerading as an RLS rejection, and the
`.rejects.toThrow(/row-level security/i)` matcher caught it. Fixed by seeding a third event
that no usage line references. This is exactly the class of tautological pass the review
standards call out; it was only caught because the red run was actually read.

**Can the "0 rows" assertions pass vacuously?** A separate case asserts the two fixture rows
*are* visible through the admin connection first, so an empty table would fail the suite before
reaching the RLS assertions.

**Does the test skip when the environment is wrong?** No — deliberately. It asserts
`rolsuper === false` and `rolbypassrls === false` and fails otherwise. That is the inverse of
S-3's guard.

**Every other call path into the changed code.** `TenantScopedRepository` has exactly one
concrete subclass in `src/`, `UsageRepository`, and both of its queries run inside `withTenant`
with an explicit `tenantId` predicate. The other four `base.repository.ts` copies have no
subclasses yet. Only doc comments changed in all five; no behaviour.

**Anything reaching the database outside `withTenant`?** `prisma/seed.ts` did — it upserts a
tenant with no tenant context. Repointed at `DIRECT_DATABASE_URL`. It is wired to no npm script,
so this was found by reading, not by a failure.

**Turbo strict env mode.** Found by accident and worth flagging: `DATABASE_URL` set in CI's job
`env:` does **not** reach `pnpm test` / `lint` / `typecheck` / `build`, because turbo 2 filters
task environments to declared vars. Proved with a probe test that printed
`DATABASE_URL= postgresql://postgres:postgres@…` under turbo while the shell had the app role.
The suites therefore take their roles from each package's `tests/setup.ts` defaults, which have
been set to the correct pair. Documented inline in `ci.yml`. Not changed in `turbo.json`:
declaring it there would make `pnpm test` run `rls.integration.test.ts` as `telemetry_app`,
which fails for the S-3 reasons below.

## 4. Findings

### HIGH — S-7 · auth-service still connects as the admin role · *accepted, recorded, not fixed*

Deviation from the authorized scope. Flipping `apps/auth-service/.env.example` breaks login and
registration; verified rather than predicted:

```
$ AUTH_TEST_DATABASE_URL="postgresql://telemetry_app:…@localhost:5432/telemetry_s2_scratch" \
  pnpm --filter @telemetry/auth-service exec vitest run tests/auth.integration.test.ts
 Test Files  1 failed (1)
      Tests  9 failed | 6 passed (15)
```

Root cause, at the database:

```
--- auth pre-auth lookup: find user by email, no tenant context ---
 users_visible
---------------
             0
(1 row)

--- auth register: create tenant with no tenant context ---
ERROR:  new row violates row-level security policy for table "Tenant"
```

`user.repository.ts` queries before a tenant is known. The only fixes that do not weaken a
policy are `SECURITY DEFINER` lookup functions plus app-side tenant-id generation for
registration — a separate task. Recorded as **S-7** in `known-gaps.md`; every pin to the admin
role (`.env.example`, compose, CI's `AUTH_TEST_DATABASE_URL` and Auth Coverage step,
`tests/setup.ts`, auth's `base.repository.ts` doc block) cites it.

**Disposition required from the user:** accept S-7 as a recorded gap, or hold this change until
the auth rewrite lands with it.

### MEDIUM — S-3 · `rls.integration.test.ts` now fails, and one of its assertions asserts the bug

Not modified — S-3 is its own task. Both behaviours were measured.

Run unmodified as `telemetry_app`, its `beforeAll` seeds through the same client it asserts
with, so nothing executes at all:

```
$ DATABASE_URL="postgresql://telemetry_app:…@localhost:5432/telemetry" \
  pnpm --filter @telemetry/auth-service exec vitest run tests/rls.integration.test.ts

PrismaClientUnknownRequestError:
Invalid `prisma.tenant.create()` invocation in .../tests/rls.integration.test.ts:30:34
PostgresError { code: "42501", message: "new row violates row-level security policy for table \"Tenant\"" }

 Test Files  1 failed (1)
      Tests  4 skipped (4)
```

With the fixture seeded through an admin client instead (probed out of tree, not committed),
the three `if (isCurrentUserSuperuser) return;` assertions execute for the first time:

```
 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)

 × without set_config, query sees all rows (no RLS enforcement)
   AssertionError: expected 0 to be greater than or equal to 1
   tests/rls.integration.test.ts:120  expect(events.length).toBeGreaterThanOrEqual(1);
```

So: **lines 78 and 96 — the two real isolation assertions — pass.** RLS genuinely enforces.
**Line 110 fails, and it should:** `expect(events.length).toBeGreaterThanOrEqual(1)` for an
unscoped query is an assertion that RLS is *not* enforcing. It encodes S-2 as expected
behaviour. Under a correct setup it must expect zero.

CI would go red on this. `.github/workflows/ci.yml`'s Auth Coverage step therefore pins
`DATABASE_URL` to the admin role — **not** to hide the failure, but because that step *is*
auth-service's suite and auth-service is documented as still running on the admin role (S-7).
The override carries a comment naming S-3 and S-7 and saying to remove it when they land.
Verified: with the override the step passes 126/126 at 90.01% lines; without it, it fails
`1 failed | 13 passed` on `rls.integration.test.ts`.

**Disposition required from the user:** accept the step-scoped override, or take the CI failure
as the signal to fix S-3 now.

### LOW — the false comment existed in five files, not one · *fixed*

`base.repository.ts:51` in usage, worker, billing, analytics **and** auth. All five corrected.
The gap named only usage-service.

### NIT — `.env` not updated · *left for the user*

Gitignored and untracked. Local `pnpm dev` still connects as `postgres` until the user updates
it by hand. Deliberate: not an agent's file to rewrite.

### Noted, not a finding — `RefreshToken` and `InvoiceLineItem` have no active RLS

`v1_2` issues `FORCE ROW LEVEL SECURITY` on both, but `v1_0` never issued `ENABLE` for either,
so `relrowsecurity` is false and `FORCE` does nothing. Neither carries a `tenantId` column
(they reach a tenant through `"User"` / `"Invoice"`), so this is not a leak introduced here and
it is not S-2. Out of scope, but a reviewer should know it: adding a policy to either without
`ENABLE` would be silently inert.

## 5. Clean-code gate

- No magic strings introduced in `src/`. The new test hoists `APP_TENANT_ID_SETTING`,
  `SEEDED_QUANTITY_*` and `ADMIN_URL_FALLBACK` to module constants.
- Raw SQL in the new test uses `$queryRaw` tagged templates with bound parameters throughout;
  no `$queryRawUnsafe`, no interpolation, no `Prisma.raw`.
- No duplicate definitions. `docker/postgres/init/01-app-role.sql` intentionally restates the
  migration's role/grant block — the two run in environments that cannot see each other, and
  both files say so. Flagged as accepted duplication rather than silent drift.
- No `any`; explicit interfaces (`RoleAttributes`, `UsageLineRow`) at the raw-SQL boundary.
  `quantity` is typed `unknown` because it is a `Decimal(18,6)` that nothing asserts on.

## 6. Validation — all 13 packages

```
$ pnpm build
 Tasks:    13 successful, 13 total

$ pnpm typecheck
 Tasks:    13 successful, 13 total

$ pnpm lint
@telemetry/auth-service:lint:  ✖ 17 problems (0 errors, 17 warnings)
@telemetry/usage-service:lint: ✖ 4 problems (0 errors, 4 warnings)
 Tasks:    13 successful, 13 total

$ pnpm test
@telemetry/shared-types:test:        Tests  7 passed (7)
@telemetry/shared-config:test:       Tests  4 passed (4)
@telemetry/shared-tracing:test:      Tests  2 passed (2)
@telemetry/shared-validation:test:   Tests  15 passed (15)
@telemetry/shared-logger:test:       Tests  4 passed (4)
@telemetry/shared-utils:test:        Tests  18 passed (18)
@telemetry/gateway:test:             Tests  37 passed (37)
@telemetry/worker-service:test:      Tests  19 passed (19)
@telemetry/billing-service:test:     Tests  18 passed (18)
@telemetry/analytics-service:test:   Tests  18 passed (18)
@telemetry/usage-service:test:       Tests  148 passed (148)
@telemetry/auth-service:test:        Tests  126 passed (126)
 Tasks:    13 successful, 13 total
```

**Zero lint errors. Zero new warnings.**

`pnpm format:check` fails on 244 files repo-wide and is **not** a CI step; the repo does not
follow its own `.prettierrc` (`trailingComma: "all"` vs. the no-trailing-comma style every
file actually uses). The new test file and the touched `tests/setup.ts` files match their
neighbours' style rather than prettier's, and `prisma/seed.ts` was deliberately left with a
4-line diff rather than reformatted.

- 4 usage-service warnings: all `no-unsafe-assignment` at `tests/ingestion.service.unit.test.ts`
  339, 340, 543, 544. `git log -1` on that file → `c26f370 feat(usage-service): implement T-031
  event ingestion endpoint`. Pre-existing, and that file is another agent's active workspace.
- 17 auth-service warnings: `no-misused-promises` / `no-unsafe-assignment` in existing test
  files, untouched here.
- `eslint tests/rls.enforcement.integration.test.ts` on its own: exit 0, no output.

**Simulated CI sequence** against the real database, in workflow order:

```
### Apply Prisma Migrations ###      -> No pending migrations to apply.
### Check Prisma Migration Status ###-> Database schema is up to date!
### Auth Coverage (step override) ###-> Test Files 14 passed (14) | Tests 126 passed (126)
                                        All files | 90.01 % Stmts
### Verify RLS Is Enforcing ###      -> Test Files 1 passed (1) | Tests 7 passed (7)
```

**Compose, fresh container** (`docker compose -p telemetry-s2-check up -d postgres` on an empty
volume, no migrations run at any point):

```
    rolname    | rolsuper | rolbypassrls | rolcanlogin
---------------+----------+--------------+-------------
 telemetry_app | f        | f            | t

 defaclobjtype |           defaclacl
---------------+-------------------------------
 r             | {telemetry_app=arwd/postgres}
 S             | {telemetry_app=rU/postgres}

$ psql -U telemetry_app -d telemetry -tAc "select current_user, current_setting('is_superuser')"
telemetry_app|off
```

**Migrations from scratch:** applied cleanly to an empty database twice (once with the role
absent, once with it present), and the migration file re-applied by hand a third time without
error.

## 7. What I could not verify

- **The full compose stack under `--wait`.** Only the `postgres` service was brought up; the
  six application images were not rebuilt. The role, its login and its default privileges are
  proven; that the services then start healthy against it is inferred from their `/health`
  routes not touching the database (they pass today against a compose database with no schema
  at all).
- **Managed-Postgres behaviour** (RDS/Cloud SQL, where the migration role is not a true
  superuser). The `ALTER ROLE … NOBYPASSRLS` clamp is guarded to fire only when needed and the
  `RAISE EXCEPTION` guard fails loudly rather than proceeding, but this was not exercised on a
  real managed cluster.
- **Whether Prisma will keep tolerating an edited applied-migration checksum.** True on 6.19.3;
  not a documented guarantee.
- **Any production deployment's rollout.** `DIRECT_DATABASE_URL` must be set wherever
  `migrate deploy` runs before this ships, and `telemetry_app`'s real password provisioned. No
  deployment manifests exist in this repo to update.

## 8. Sign-off

`CONDITIONAL`. The change is correct and proven as written; two dispositions are the user's:
S-7 (auth-service stays on the admin role) and S-3 (the CI step override vs. fixing the test).
Nothing was committed, staged, pushed, or branched.
