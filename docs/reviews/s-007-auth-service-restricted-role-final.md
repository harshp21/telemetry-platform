# Senior Review (FINAL / Gate 6) — S-7 · auth-service onto a restricted DB role

Reviewer: `senior-reviewer` (independent; did not write this code, did not write the previous review)
Base: `b0f6921` · Head: `caaed99` (single commit, unpushed, on `main`) · Working tree clean
Baseline artifact: `docs/reviews/s-007-auth-service-restricted-role.md` (previous revision — left unedited)
Claimed dispositions: `docs/plans/s-007-auth-service-restricted-role.md` §14

## Verdict

**CONDITIONAL**

All three HIGH findings from the previous review are genuinely fixed, and I confirmed each by
execution rather than by reading §14: the definer role is `NOBYPASSRLS` and resolves through two
targeted policies (`pg_roles`, `pg_policies`, live resolver calls); `EXECUTE` is held by
`telemetry_auth_app` alone and `telemetry_app` is denied at the database
(`ERROR: permission denied for function auth_resolve_tenant_by_email`); the `user: { tenantId }`
relation filters emit a real `EXISTS (… "t0"."tenantId" = $3 …)` predicate and a cross-tenant id
raises `P2025`. All 13 packages are green (build/typecheck/lint/test), auth-service 156/156, and
the 14 remaining lint warnings are proven pre-existing.

One **new HIGH** is a false, load-bearing claim introduced *by this round*: the branded-context
change documents `logout-auth.plugin.ts` as the JWT trust boundary where the brands are applied,
and that file is **dead code** — nothing imports `requireLogoutAuth`, the logout route uses
`requireJwtAuth`, and the coverage run reports the file at 0% (lines 1–64). The dead plugin also
omits the denylist check the live guard performs. This is the same class of defect the previous
round was pulled up on, in a different file.

No BLOCKER. Authentication is not broken; the database objects match the migration file exactly.

---

## Findings

### HIGH-1 · The branded-context change documents a dead, weaker plugin as *the* JWT trust boundary

`apps/auth-service/src/plugins/index.ts:4-9` · `apps/auth-service/src/plugins/logout-auth.plugin.ts:43-46`

`plugins/index.ts:6-7` states the brand "is applied once, at the trust boundary where the JWT is
verified (`logout-auth.plugin.ts`)". `logout-auth.plugin.ts:43` states "The one place the brands
are applied." Both are false, and in two independent ways.

1. **There are two producers, not one.** `jwt.plugin.ts:58-64` applies the same two casts. §14
   itself says "applied once at each JWT trust boundary (`jwt.plugin.ts`,
   `logout-auth.plugin.ts`)" — so the in-file comment contradicts the plan.
2. **`logout-auth.plugin.ts` is dead code.** Verified three ways:
   - `grep -rn "requireLogoutAuth\|logout-auth" apps/auth-service/src apps/auth-service/tests`
     returns only the definition itself and the prose reference in `plugins/index.ts:7`. No
     importer exists anywhere in the repo.
   - `apps/auth-service/src/routes/index.ts:7,28` — `/logout` is registered with
     `preHandler: [requireJwtAuth]`, from `jwt.plugin.ts`.
   - `pnpm --filter @telemetry/auth-service test:coverage` reports
     `logout-auth.plugin.ts | 0 | 0 | 0 | 0 | 1-64` while every logout integration test passes.
     It is never loaded.

   `git log -- apps/auth-service/src/plugins/logout-auth.plugin.ts` shows two commits: `77a6d8e`
   (T-021, where it was introduced already unwired) and `caaed99` (this change).

The consequence is not cosmetic. `requireJwtAuth` verifies the signature **and** consults the
denylist (`jwt.plugin.ts:96-100`, `RevokedTokenError`). `requireLogoutAuth`
(`logout-auth.plugin.ts:56-64`) verifies only the signature. So the file this change nominates as
the canonical trust boundary is the one that would accept a revoked access token if it were ever
wired up — and a maintainer who trusts `plugins/index.ts:6-7` will edit it believing they have
changed the live auth path.

§14's "Typechecking found the second boundary, which is the point" is therefore inverted:
typechecking found dead code, and the change then blessed it in a doc comment.

**Fix.** Two lines of prose plus, preferably, a deletion:

- `plugins/index.ts:6-7` → name the live boundary:
  `… at the trust boundary where the JWT is verified (jwt.plugin.ts, requireJwtAuth), rather than …`
- Delete `apps/auth-service/src/plugins/logout-auth.plugin.ts`. It has no importer, no test, and
  no coverage, and it is strictly weaker than the guard that replaced it. If it is kept instead,
  replace `:43-46` with a statement that the module is not registered, and add the denylist
  check so the two guards cannot diverge.

If deletion is judged out of scope for a DB-role change, say so and file it — do not leave the
comment asserting the opposite of the wiring.

### MEDIUM-1 · Nothing removes PostgreSQL's default `EXECUTE TO PUBLIC` for functions, so the next resolver is world-executable by default

`prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql:181-184`, `:241-249`

The two-role split is airtight **for these two functions only**, and it is airtight by explicit
`REVOKE`, not by mechanism. Verified live:

```
pg_default_acl:
 postgres | public | r | {telemetry_app=arwd/postgres,telemetry_auth_app=arwd/postgres}
 postgres | public | S | {telemetry_app=rU/postgres,telemetry_auth_app=rU/postgres}
```

There is no `f` (functions) row. `ALTER DEFAULT PRIVILEGES` at `:181-184` covers `TABLES` and
`SEQUENCES` only, so a function created by the migration owner still gets `EXECUTE` granted to
`PUBLIC` at creation — and `telemetry_app` is in `PUBLIC`. I confirmed the mechanism is live by
`GRANT EXECUTE … TO PUBLIC` inside a rolled-back transaction:
`has_function_privilege('public', …)` flipped `f → t`.

Today the hole is closed by `:241-242`. The catalog guard at `:257-260` loops over a hard-coded
two-element array, so a `v1_6` adding `auth_resolve_tenant_by_api_key(text)` and forgetting the
`REVOKE` would be silently callable by gateway, usage, worker, billing and analytics — the exact
failure the previous review's HIGH-2 described, re-introduced by omission rather than by grant.

**Fix.** One statement in `v1_5` (or a `v1_6`), after `:184`:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```

Verified safe against the live schema: `public` contains exactly the two resolvers
(`pg_proc` joined to `pg_namespace`), and Prisma creates no functions.

### MEDIUM-2 · `DROP POLICY IF EXISTS` + `CREATE POLICY` is a destructive window, and no guard asserts the *absence* of extra policies

`prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql:107-117`, guard at `:290-310`

Two separate problems from the same construction.

**(a) The destructive window.** The file carries no transaction of its own. Under
`prisma migrate deploy` the file is executed inside one, so the `DROP`/`CREATE` pair is atomic —
that part I am asserting from Prisma's documented behaviour, **not** from execution, because
`v1_5` is already applied and I could not add a migration to observe it. But the release note's
own managed-Postgres recovery path (`docs/releases/s-007-auth-service-restricted-role.md:89-105`)
tells an operator to provision roles by hand and re-run, and `:58` already has them reaching for
`psql`. Applied by `psql -f` with no `BEGIN`, a failure anywhere after `:107` leaves `"User"`
without `user_auth_definer_read` — at which point every resolver returns `NULL` and **every login
returns 401**, silently. That is precisely the failure mode `:15-18` of this same file warns
about.

**(b) No guard on extras.** `:290-310` asserts the two policies are *present*. Nothing asserts
that `"User"` carries no *other* permissive policy. A later migration that renames
`user_auth_definer_read` leaves the old one behind: a `PERMISSIVE … USING (true)` policy on
`"User"`, which ORs with `user_tenant_isolation`. I confirmed the OR semantics against the live
catalog — `user_tenant_isolation` is `PERMISSIVE / ALL / {public}` and `user_auth_definer_read` is
`PERMISSIVE / SELECT / {telemetry_auth_definer}`; membership in the definer role therefore yields
unrestricted `SELECT`. An unbounded policy set is the same class of risk that D-2 was reversed to
avoid.

**Fix.** Replace `:107-117` with a non-destructive create, so idempotency does not require a
window:

```sql
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_policies
		WHERE schemaname = 'public' AND tablename = 'User'
		  AND policyname = 'user_auth_definer_read'
	) THEN
		CREATE POLICY "user_auth_definer_read" ON "User"
			FOR SELECT TO telemetry_auth_definer USING (true);
	END IF;
END
$$;
```

and extend the guard at `:290` to assert the exact set:

```sql
IF EXISTS (
	SELECT 1 FROM pg_policies
	WHERE schemaname = 'public' AND tablename = 'User'
	  AND policyname NOT IN ('user_tenant_isolation', 'user_auth_definer_read')
) THEN
	RAISE EXCEPTION 'Unexpected policy on "User"; a permissive policy here can widen tenant reach.';
END IF;
```

### MEDIUM-3 · `telemetry_auth_app` gets DML on all ten tables; auth-service touches three

`prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql:178`, `:181-182`

Verified from `information_schema.role_table_grants`: `telemetry_auth_app` holds
`SELECT, INSERT, UPDATE, DELETE` on `Event`, `ExportAudit`, `Invoice`, `InvoiceLineItem`, `Meter`,
`MetricRollup`, `RefreshToken`, `Tenant`, `UsageLine`, `User` — identical to `telemetry_app`.
auth-service reads or writes only `"Tenant"`, `"User"` and `"RefreshToken"`.

This is deliberate and honestly documented ("Identical table privileges to telemetry_app",
`:119`), and RLS still constrains rows on the eight tables where it is `ENABLE`d. The exception
matters: `InvoiceLineItem` has `relrowsecurity = false` (verified — same shape as `"RefreshToken"`,
S-10), so the new role gets **cross-tenant write access** to a table auth-service has no business
in. A change whose entire purpose is least privilege created a fresh role and then gave it the
superset.

**Disposition:** accept for this change *if* it is recorded, since the marginal risk over the
pre-existing `telemetry_app` grant is zero and narrowing needs per-table maintenance. Either
narrow to the three tables (dropping `ALTER DEFAULT PRIVILEGES … ON TABLES` for this role in the
process), or add a sentence to the release note and a line to `known-gaps.md`. Do not leave it
implicit — "least-privilege role" in `apps/auth-service/.env.example:9` reads narrower than it is.

### MEDIUM-4 · The in-place rewrite of an already-applied migration is defensible, but the release note is silent about it

`prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql` (whole file) ·
`docs/releases/s-007-auth-service-restricted-role.md`

I verified the account in §14 rather than taking it:

```
migration_name             | started_at        | finished_at       | applied_steps_count | has_logs
v1_5_auth_tenant_resolvers | 2026-09-04 11:17… | 2026-09-04 11:17… |          0          |    t
```

`applied_steps_count = 0`, `finished_at = started_at`, non-null `logs` — the signature of
`prisma migrate resolve --applied`, not of `migrate deploy`. The stored checksum
(`45bc4d8b74e7…f6ca`) equals `sha256sum` of the current file, and `prisma migrate status` reports
"Database schema is up to date!".

Crucially, the history row is *not* what I relied on. I re-applied the file **twice** inside a
rolled-back transaction and diffed a catalog snapshot (function owner, `proacl`, `md5(prosrc)`,
policy names/cmd/roles, role attributes, row counts) before, during and after: byte-identical in
all three. So the live database genuinely matches the file regardless of how the row was
recorded, and the file is idempotent (`exit 0` on the second application).

**On the merits I accept the decision.** A forward `v1_6` could only have *retracted* an assertion
`v1_5` still made, leaving `v1_5` itself unappliable on any platform where
`CREATE ROLE … BYPASSRLS` is unavailable — which no later migration can repair. That is a worse
outcome than editing a file that had reached exactly one developer's machine.

What I **cannot** verify is the premise: that `v1_5` was never applied anywhere else. I have one
local instance and no other DSN. If it had been, `migrate deploy` would fail loudly on the
checksum, not silently — which is why this is MEDIUM and not HIGH.

**Fix.** Add a short paragraph to the release note: v1_5 was revised after being applied to a
local database; any environment that applied the earlier revision will get a
"migration file has been modified" error from `migrate deploy`, and the resolution is to compare
the catalog against §7/§8 of the file and `migrate resolve --applied` once satisfied. One
paragraph, and it is the only record an operator will ever read.

### LOW

1. **`migration.sql:79-92` is unreachable on every path.** The definer attribute guard requires
   `NOT rolbypassrls AND NOT rolsuper AND NOT rolcanlogin`; the clamp immediately above at
   `:65-73` fires on the exact complement, `(rolsuper OR rolcanlogin OR rolbypassrls)`. So either
   the clamp succeeds and the guard cannot fire, or the `ALTER ROLE` raises first. Verified by
   running the guard's predicate against a temporarily `BYPASSRLS` definer (rolled back): it does
   fire when reached. This mirrors `v1_4:41-63` exactly, so it is a consistent house pattern —
   report only so nobody counts it as the mechanism. Keep it; the *effective* guards are §7 and
   §8, both of which I proved fire.

2. **`migration.sql:99-101` — `NOLOGIN` is not what makes the policies unreachable.** The comment
   says the policies "are unreachable from telemetry_app or telemetry_auth_app — neither is a
   member of the definer role, and it is NOLOGIN so nothing can connect as it." A policy `TO
   <role>` applies through **membership**, not through login, so the `NOLOGIN` half is a
   non-sequitur; only the membership half carries weight, and nothing in the migration asserts
   it directly. Verified live: `pg_auth_members` grants `telemetry_auth_definer` to nobody, and
   `SET ROLE telemetry_auth_definer` from both app roles fails with
   `ERROR: permission denied to set role`. Also verified that the escalation path *is* caught
   incidentally — `GRANT telemetry_auth_definer TO telemetry_app` inside a rolled-back
   transaction made guard §7 raise
   (`telemetry_app must not hold EXECUTE on public.auth_resolve_tenant_by_email(text)`), because
   `has_function_privilege` follows membership. That is a good property; the comment should claim
   it instead of the `NOLOGIN` one.

3. **`migration.sql:355-359` cannot fail today.** The functional guard's token-resolver branch is
   blind: with `relrowsecurity = false` on `"RefreshToken"` the resolver resolves whether or not
   `refreshtoken_auth_definer_read` exists. Verified by dropping that policy inside a rolled-back
   transaction — §8 stayed green while §7 raised. Not a hole (the catalog guard covers presence);
   note it so §8 is not read as proof of the `"RefreshToken"` policy.

4. **`AuthRole` is asserted, not validated, at both JWT boundaries.** `jwt.plugin.ts:60-64` and
   `logout-auth.plugin.ts:46-51` assign `payload.role` from an unchecked
   `jwtVerify<AccessJwtPayload>` shape assertion, so a token carrying `role: "SUPERADMIN"` reaches
   `AuthenticatedRequestContext` typed as `AuthRole`. Verified pre-existing — identical at
   `b0f6921` (`git show b0f6921:apps/auth-service/src/plugins/jwt.plugin.ts`), so **not counted
   against this change** — but `AUTH_ROLES` now exists, so the check is one line:
   `if (!Object.values(AUTH_ROLES).includes(payload.role)) throw new InvalidTokenError();`

5. **Nothing in the repo proves the relation filter *does* anything.** `user.repository.unit.test.ts:556-560`
   and `:632-637` assert the argument object reaches a mock; no test attempts a cross-tenant
   `"RefreshToken"` write against a real database. I verified by execution that Prisma 6.19.3
   emits
   `… AND EXISTS(SELECT "t0"."id" FROM "public"."User" AS "t0" WHERE ("t0"."tenantId" = $3 AND …))`
   for both `update` and `updateMany`, and that a mismatched tenant yields `P2025` / `count: 0`
   respectively. A Prisma upgrade that stopped honouring relation filters in `update.where` would
   be caught by no test here. **Fix:** one integration assertion — seed two tenants, call
   `rotateRefreshToken` with the wrong `tenantId`, assert it rejects.

6. **Test-scoped magic literals survive in the two rewritten test files.** `"OWNER"`
   (`user.repository.unit.test.ts:253,412,424,434,498,510`; `rls.integration.test.ts:131,143`),
   `"FREE"` / `"UTC"` (`user.repository.unit.test.ts:265-266`), `"P2002"` (`:345`), and the policy
   names `"event_tenant_isolation"` / `"user_tenant_isolation"` (`rls.integration.test.ts:265,284`)
   while `AUTH_DATABASE.DEFINER_USER_READ_POLICY` sits beside them. Proven pre-existing in kind —
   `git show b0f6921:apps/auth-service/tests/user.repository.unit.test.ts` has them at lines
   51-52, 60, 190, 198, 217-218, 231-232, 350, and `rls.integration.test.ts` at line 87 — so **not
   counted against the change**. Noted because this commit created `AUTH_ROLES`,
   `AUTH_TENANT_DEFAULTS` and `AUTH_DATABASE.UNIQUE_VIOLATION_CODE` and rewrote both files
   wholesale without using them there. `src/` is clean: `grep '"OWNER"\|"FREE"\|"UTC"\|"P2002"'`
   over `apps/auth-service/src` returns only `constants.ts`.

7. **The `AuthRole` promotion undercounts and stops at `src`.** §14 says the union "was written out
   in seven places". `git grep '"OWNER" | "ADMIN" | "MEMBER"' b0f6921` returns **eleven** — nine in
   `src` (including four in `user.repository.ts`) and two in `tests/jwt.plugin.unit.test.ts:33,112`.
   The nine `src` copies are gone; the two test copies remain and are one import away from
   `AuthRole`. `.claude/rules/constants.md` covers tests explicitly.

8. **`.claude/agents/senior-reviewer.md:48` now cites a removed gap.** It reads "(`known-gaps.md`
   S-3 is a live example)"; this commit deletes S-3 from `known-gaps.md`. `git log -1` puts that
   agent file at `d33c8d1`, before `b0f6921`, so the dangling reference was *created* by this
   commit's deletion. (Line 22's `S-2` citation was already dangling — S-2 went in `b0f6921`.
   Pre-existing.) **Fix:** point line 48 at `docs/reviews/s-007-…` and the
   `rls.integration.test.ts` `beforeAll` pattern, or mark it "historically S-3".

9. **`.claude/rules/testing.md:24-25` over-quantifies.** "every package's `vitest.config.mjs` is
   `include: ["tests/**/*.test.ts"]`" — only 5 of 13 packages have a `vitest.config.mjs`
   (`analytics-service`, `auth-service`, `billing-service`, `usage-service`, `worker-service`);
   `gateway`, `web`, `sdk` and the six shared packages have none and use vitest defaults. The
   substantive claim is correct and I confirmed it: `pnpm test` ran
   `tests/auth.integration.test.ts` and `tests/rls.integration.test.ts` inside the default suite.
   Note also that `auth-service/vitest.config.mjs` *does* have an `exclude`, but under
   `coverage`, not `test` — worth a clause so a reader does not think the rule is contradicted.

10. **`rls.integration.test.ts:74` — `requireEnv` requires nothing.** It is
    `process.env[name] ?? fallback`. Rename to `envOrDefault`; a helper named `require*` that
    silently defaults is the shape the testing rule warns about.

11. **`rls.integration.test.ts` never asserts *which* restricted role it is talking to.** The
    `beforeAll` guard checks only `rolsuper || rolbypassrls`. Verified: running the file with
    `DATABASE_URL` pointed at `telemetry_app` leaves **14 of 18 tests green** — only the four
    resolver-call tests fail, and they fail on `permission denied`, not on a role assertion.
    **Fix:** add `expect(appRole?.rolname).toBe(AUTH_DATABASE.AUTH_APP_ROLE)` to the `beforeAll`
    or to the `runs as a role that cannot bypass RLS` test.

12. **`docs/development-setup.md:56` documents only `telemetry_app`'s local password.**
    `telemetry_auth_app_local_dev` is hard-coded in `migration.sql:138`, `01-app-role.sql`,
    `docker-compose.yml` and `tests/database-urls.ts:17`, and the new section at `:41-56` never
    states it.

13. **Five `AUTH_DATABASE` members are test-only.** `DEFINER_ROLE`, `DEFINER_USER_READ_POLICY`,
    `DEFINER_REFRESH_TOKEN_READ_POLICY`, `AUTH_APP_ROLE`, `SHARED_APP_ROLE` are referenced
    exclusively by `tests/rls.integration.test.ts`; production code uses only
    `TENANT_CONTEXT_SETTING`, the two `*_FN` names and `UNIQUE_VIOLATION_CODE`. Defensible as
    documentation of the DB contract in one place, and it keeps the test literal-free — noted, not
    a request to move them.

### NIT

- **The `beforeAll` throw reports as "18 skipped".** Under a superuser `DATABASE_URL` the suite
  correctly dies with
  `DATABASE_URL connects as postgres, which is a superuser or holds BYPASSRLS. RLS cannot be proven through it.`
  and exits 1 — but vitest's summary line reads `Tests 18 skipped (18)`, cosmetically identical to
  the S-3 signature the comment at `:26-29` disowns. Behaviour is right; only the summary misleads.
  A one-line note in the file header would close the loop.
- **`migration.sql:279` errors if `v1_5` is applied without `v1_4`** —
  `has_function_privilege('telemetry_app', …)` raises `role "telemetry_app" does not exist`.
  Unreachable under Prisma's ordered application.
- **`pnpm format:check` fails, repo-wide and pre-existing.** 250 files flagged, of which only 22
  are touched here; untouched `apps/gateway/src/app.ts` and `apps/usage-service/src/constants.ts`
  are flagged too. Cause is `.prettierrc` (`tabWidth: 2`, no `useTabs`) against a tab-indented
  codebase. There is **no format step in `.github/workflows/ci.yml`**, so this is outside the
  gate. Not counted against the change; recommend a separate commit that either sets
  `"useTabs": true` or drops the script.

---

## Scope creep — judged item by item

| Landed but not requested | Verdict |
|---|---|
| `AuthRole` promotion across 5 `src` files | **Justified.** It removes nine literal copies of the union and stops `AUTH_ROLES` becoming a tenth sitting next to the constant. Type-only, zero behaviour change, fully covered by `pnpm typecheck` (13/13). Doing it separately would have meant landing a constants gate violation on purpose. |
| Root `.env.example:5-8` note | **Justified.** Without it the root example implies auth-service uses `telemetry_app`, which is now false. Four lines. |
| `base.repository.ts:48-60` doc rewrite | **Required, not creep.** The old text asserted "auth-service still connects as the admin role … for THIS service the DB layer below is not currently enforcing", which this change makes false. Leaving it would have been the overclaim I was asked to hunt. |
| `.claude/rules/testing.md` rewrite | **In scope** — it was the previous review's *Recommended #1*, and the old text was factually wrong. See LOW-9 for the residual imprecision. |
| Editing `v1_5` in place rather than adding `v1_6` | **Accepted on merits** — see MEDIUM-4 for the reasoning and the one documentation requirement. |
| `docs/reviews/…` in the same commit | Matches `.claude/rules/git-commit.md`. Fine. |

---

## What I verified, and how

### Live PostgreSQL 16.13 (`postgresql://postgres:postgres@127.0.0.1:5432/telemetry`)

- **Role attributes** — `pg_roles`: `telemetry_app` `f/f/t`, `telemetry_auth_app` `f/f/t`,
  `telemetry_auth_definer` `f/f/f` (super / bypassrls / canlogin). Matches §14 exactly, including
  the D-2 reversal.
- **No memberships** — `pg_auth_members` contains only `pg_monitor` and two unrelated legacy
  grants to `postgres`. Nothing is a member of `telemetry_auth_definer`. `SET ROLE
  telemetry_auth_definer` fails from both `telemetry_app` and `telemetry_auth_app`.
- **The definer's whole privilege set** — `information_schema.role_table_grants`: exactly `SELECT`
  on `"User"` and `"RefreshToken"`, plus `USAGE` on `public`. Strictly narrower than the
  `BYPASSRLS` shape it replaced (two tables, one command, one role — versus every table, every
  command). Equivalent in *reach for the resolvers*: both policies are `PERMISSIVE … USING (true)`
  and OR with `user_tenant_isolation`, which I confirmed against `pg_policies`.
- **Function hardening** — `pg_proc`: both `prosecdef = t`, `provolatile = s`, `proisstrict = t`,
  `proconfig = {"search_path=pg_catalog, pg_temp"}`, owner `telemetry_auth_definer`,
  `proacl = {telemetry_auth_definer=X/…, telemetry_auth_app=X/…}` — `PUBLIC` and `telemetry_app`
  both absent.
- **The two-role split, from the client side** — as `telemetry_app`:
  `ERROR: permission denied for function auth_resolve_tenant_by_email`, `SET ROLE` denied,
  `SELECT count(*) FROM "User"` → 0. As `telemetry_auth_app`: resolver callable, unscoped
  `"User"` → 0 rows, `_prisma_migrations` → `permission denied`. HIGH-2 from the previous review is
  closed at the database, not just in prose.
- **`_prisma_migrations` is revoked** — `relacl = {postgres=arwdDxt/postgres}`; neither app role
  appears.
- **Guard §7 fails loudly on every state it claims to catch.** Each break applied inside
  `BEGIN … ROLLBACK`:

  | Broken state | Guard output |
  |---|---|
  | `DROP POLICY user_auth_definer_read ON "User"` | `Policy user_auth_definer_read is missing on "User"; without it the resolvers return NULL silently.` |
  | `DROP POLICY refreshtoken_auth_definer_read` | `Policy refreshtoken_auth_definer_read is missing on "RefreshToken"; refresh rotation would break the moment RLS is ENABLEd there (S-10).` |
  | `GRANT telemetry_auth_definer TO telemetry_app` | `telemetry_app must not hold EXECUTE on …` |
  | `REVOKE EXECUTE … FROM telemetry_auth_app` | `telemetry_auth_app must hold EXECUTE on …` |
  | `ALTER FUNCTION … OWNER TO postgres` | `… must be SECURITY DEFINER and owned by telemetry_auth_definer.` |
  | `ALTER FUNCTION … SECURITY INVOKER` | `… must be SECURITY DEFINER and owned by telemetry_auth_definer.` |

- **Guard §8 (functional) catches the silent-NULL case.** Dropping `user_auth_definer_read` →
  `auth_resolve_tenant_by_email returned NULL with no tenant context; expected 9e3c5f10-…`. It
  does **not** catch a missing `"RefreshToken"` policy (LOW-3).
- **`has_function_privilege('public', …)` is meaningful, not vacuous.** `pg_roles` has no row
  named `public`, so I checked both directions: it returns `f` today and flipped to `t` under a
  rolled-back `GRANT EXECUTE … TO PUBLIC`. Both the migration guard at `:275` and the test at
  `rls.integration.test.ts:353` are therefore live assertions.
- **Idempotency, re-derived.** `BEGIN; \i migration.sql; \i migration.sql;` → exit 0. Catalog
  snapshot (owner, `proacl`, `md5(prosrc)`, policy name/cmd/roles, role attributes, row counts)
  byte-identical before the transaction, after two applications inside it, and after `ROLLBACK`.
- **Migration history** — `applied_steps_count = 0`, `finished_at = started_at`, non-null `logs`
  (i.e. `migrate resolve --applied`); stored checksum equals `sha256sum` of the file;
  `prisma migrate status` → "Database schema is up to date!".
- **S-10 as filed is still accurate** — `pg_class`: `"RefreshToken"` `relrowsecurity = f`,
  `relforcerowsecurity = t`, sole policy `refreshtoken_auth_definer_read` (inert);
  `"InvoiceLineItem"` `f/t` with none. Both app roles hold full DML on both.
- **No stray objects** — zero `%probe%` roles, all tables at 0 rows, working tree clean.

### Prisma / TypeScript

- **HIGH-3's fix is real, and typed as required.** Emitted SQL captured with query logging:
  ```
  UPDATE "public"."RefreshToken" SET "revokedAt" = $1
  WHERE ("public"."RefreshToken"."id" = $2
     AND EXISTS(SELECT "t0"."id" FROM "public"."User" AS "t0"
                WHERE ("t0"."tenantId" = $3 AND ("public"."RefreshToken"."userId") = ("t0"."id") AND "t0"."id" IS NOT NULL)))
  ```
  Correct tenant → row updated; wrong tenant → `P2025`; `updateMany` with the wrong tenant →
  `count: 0`; `findFirst` → `null`. All rows created and deleted; post-check `tenants left = 0`.
- **The predicate is enforced by the compiler, not by convention.** I removed the three
  `user: { tenantId }` call sites from a scratch copy (types untouched) and ran `tsc --noEmit`:
  three `TS2741 Property 'user' is missing …` errors at `user.repository.ts:390`, `:434`, `:459`.
  §14's "the interface types make it **required** rather than optional" holds.
- **`storeRefreshToken`'s exception is genuine.** `refreshToken.create` takes `data` only; there is
  no `where` to attach a predicate to. The comment at `:366-369` now says exactly that, and no
  longer repeats the withdrawn "no `tenantId` column so no predicate is expressible" claim.
- **Injection.** Rendered both raw templates: `SELECT public.auth_resolve_tenant_by_email(?) AS "tenantId"`
  with `values = ["x' OR 1=1 --"]`, and `SELECT set_config(?, ?, true)` with
  `values = ["app.tenant_id", "t' ; drop"]`. Identifiers come from frozen module constants
  (`Prisma.raw` over `AUTH_DATABASE.*_FN`); every value is bound. No `Prisma.raw` on anything
  caller-derived anywhere in the diff.
- **`asTenantId` removed the cast.** `user.repository.ts:192-193` narrows on
  `typeof value === "string" && value.length > 0`; the `as TenantId | null` assertions the previous
  review flagged at `:226`/`:240` are gone. Only one cast remains in the file — the documented
  double cast at `:202`, whose comment now explains the *cast* and not just the type.
- **`DIRECT_DATABASE_URL` is not needed at runtime**, despite being added to
  `apps/auth-service/.env.example`. Verified: `new PrismaClient()` with `DIRECT_DATABASE_URL`
  unset queries successfully as `telemetry_auth_app`. `EnvSchema` correctly does not require it.

### Test honesty — hunted specifically

- **The `set_config`-first instrumentation is not vacuous. Reproduced red.** I copied the package
  to a scratch tree and mutated the real `withTenantContext`:
  - `set_config` moved **last** → 6 failures, each
    `a table was queried before set_config('app.tenant_id', …) was issued: expected 1|2 to be +0`.
  - `set_config` **removed entirely** → 6 failures (the helper throws
    `Repository issued no tenant-context statement at all`).
  - relation predicates removed → 5 failures.
  - both mutations together → **9** failures. §14 claims 8; the difference is which sites the
    author removed (I also dropped the `findRefreshTokenForRotation` filter). The claim
    "confirmed red first" reproduces; the exact count is mutation-dependent.
  `modelCallsBeforeTenantContext ??= countModelCalls()` records at the first context statement and
  `expectTenantContextSetFirst()` **throws** if none was issued, so neither the ordering nor the
  presence can pass vacuously.
- **The `beforeAll` throw is load-bearing.** With `DATABASE_URL` = superuser the suite dies in
  `beforeAll` and the run exits 1 — it does not skip past. With `DATABASE_URL` = `telemetry_app`
  four tests fail on `permission denied`. With `DATABASE_URL` = `telemetry_app`, the *auth*
  integration suite fails 11 of 17. No `.skip`, no environment-conditional `return`, anywhere in
  either integration file.
- **`runRawQuery` still throws** on unrecognised SQL (`user.repository.unit.test.ts:102`), and
  `requireOnlyTenantContextValue` throws unless exactly one context statement was issued (`:120-128`).
- **The S-10 non-tautology is preserved.** The logout test reads rows back through the **admin**
  client and asserts `storedTokens.length > 0` before `every(revokedAt !== null)`
  (`auth.integration.test.ts:494-500`). The register test likewise reads `Tenant` and `User` back
  through the owner connection (`:555-568`), so the echoed tenant id is checked against what the
  database stored.
- **The fixture-reset test proves both halves** (`:307-326`): `> 0` before `resetAuthState()`,
  `=== 0` after. A predicate matching nothing would fail the first assertion.
- **No test asserts a mock's own return value in a way that matters.** The closest cases —
  `findUserForLogin` returning a transform of the mocked row, and the two "returns null" tests —
  assert the repository's field mapping and its null-guard branches, not the stub. The load-bearing
  assertions are negative: `user.findFirst` **not** called and `tenantContextValues` empty when the
  tenant does not resolve (`:452-453`, `:535-536`), and
  `expect(JSON.stringify(where)).not.toContain(OTHER_TENANT_ID)` (`:637`).
- **Gap:** LOW-5 — nothing tests that the relation filter has an effect at the Prisma boundary.

### Compile-time gate — actual output, all 13 packages

| Task | Result |
|---|---|
| `pnpm typecheck` | **13 successful / 13**, exit 0 |
| `pnpm build` | **13 successful / 13**, exit 0 |
| `pnpm lint` | **13 successful / 13**, exit 0 — **0 errors, 14 warnings** |
| `pnpm test` | **13 successful / 13**, exit 0 |
| `pnpm format:check` | **exit 1** — 250 files, repo-wide, pre-existing, not in CI (see NIT) |

Per-package tests: auth-service **156** (14 files), usage-service **179**, gateway **38**,
worker-service **19**, billing-service **18**, analytics-service **18**, shared-utils 18,
shared-validation 15, shared-types 7, shared-config 4, shared-logger 4, shared-tracing 2.
Every number in §14 matches, including 151 → 156.

**All 14 lint warnings are pre-existing, proven:**
`apps/auth-service/tests/auth.service.unit.test.ts` (10 × `no-misused-promises`) — not in
`git diff --name-only b0f6921..caaed99`, `git log -1` → `d68e719` (2026-08-25), before `b0f6921`.
`apps/usage-service/tests/ingestion.service.unit.test.ts` (4 × `no-unsafe-assignment`) — not in the
diff, `git log -1` → `b0f6921`. Neither is counted against this change, and no new warning was
waved through as pre-existing (0 warnings in any file this commit touches).

**Coverage**, run the way CI does (`DATABASE_URL` = `telemetry_auth_app`,
`pnpm --filter @telemetry/auth-service test:coverage`): **91.37 %** stmts / **86.62 %** branch /
**94.73 %** funcs / **91.37 %** lines against thresholds 80/75/80/80. `src/constants.ts` 100 %,
`src/repositories` 95.08 %. `src/plugins/logout-auth.plugin.ts` **0 %** — the evidence for HIGH-1.

### Config / CI / docs

- `turbo.json` has **no** `env` passthrough on `test`/`lint`/`build`/`typecheck`, so the CI comment
  at `ci.yml:23-29` is accurate: those tasks take their connection strings from each package's
  `tests/setup.ts`, which defaults to `TEST_DATABASE_URLS.AUTH_APP`. Confirmed by running
  `pnpm test` with no DB env vars set.
- `AUTH_TEST_DATABASE_URL` and `RLS_PROBE_DATABASE_URL` are fully gone; the only surviving mention
  is the explanatory comment at `rls.integration.test.ts:22`.
- MEDIUM-2 of the previous review is fixed: `tests/database-urls.ts` is the single source and five
  suites import it (`setup.ts`, `auth.integration`, `rls.integration`, `env.schema.unit`,
  `token.service.unit`). No connection-string literal remains outside it.
- MEDIUM-1 of the previous review is fixed: `docs/releases/…:98-101` now carries
  `GRANT telemetry_auth_definer TO <migration_role>` with the exact error it prevents, and the
  wrong `BYPASSRLS` platform advice is gone (correctly — the attribute is no longer used).
- MEDIUM-3 of the previous review is fixed by documentation, as proposed
  (`docs/releases/…:128-139`).
- **Docs checked claim-by-claim against *this* revision, and true:** `CLAUDE.md:165-172`
  (auth-service on `telemetry_auth_app`, same table privileges, `NOBYPASSRLS` definer + two
  policies); `.claude/rules/tenant-isolation.md:65-97` (all three "safe" properties are in fact
  asserted by both the migration and the test suite — I checked each);
  `known-gaps.md` S-10 (verified against `pg_class`, `pg_policies` and both roles' grants);
  `docs/development-setup.md:41-56`; `apps/auth-service/.env.example`; root `.env.example`;
  `docker/postgres/init/01-app-role.sql` (its "resolvers are `LANGUAGE sql`, parsed at `CREATE`
  time, and no tables exist in an init script" reasoning is sound). **Untrue:** the two comments in
  HIGH-1, plus LOW-2, LOW-7 and LOW-9.

---

## What I could NOT verify, and why

1. **That `v1_5` was never applied outside one local dev database** — the premise of the in-place
   edit (MEDIUM-4). One instance available, no other DSNs. The failure mode if it were applied
   elsewhere is loud (`migrate deploy` checksum error), not silent.
2. **Managed Postgres (RDS / Cloud SQL / Neon)** — no instance. The migration's claim at `:24-26`
   that dropping `BYPASSRLS` keeps it appliable is *plausible* (`CREATE ROLE … BYPASSRLS` does
   require superuser; PG16 grants a `CREATEROLE` creator `ADMIN OPTION` on roles it creates, which
   is what `ALTER FUNCTION … OWNER TO` needs) but that is **reasoning, not execution**, and
   platform-specific role syntax is untested.
3. **That Prisma Migrate wraps a migration file in a single transaction** — the basis for saying
   the `DROP POLICY`/`CREATE POLICY` window at `:107-117` is atomic under `migrate deploy`.
   `v1_5` is already applied and I would have had to add a migration to observe it. Documented
   behaviour, asserted as reasoning; MEDIUM-2's recommended fix removes the dependency entirely.
4. **`pnpm test:smoke:compose`** — did not bring the Docker stack up; six image builds is out of
   proportion. The claim that auth's DB paths were already non-functional in compose is consistent
   with the code (`/health` only, nothing runs migrations, no tables) but is inference.
5. **Timing/enumeration equivalence of the two-step login** — argued from bcrypt cost, not
   measured. `AuthService.login` still compares against `AUTH_SECURITY.DUMMY_PASSWORD_HASH` on a
   miss and `findUserForLogin:330-334` skips only the second query, so the mechanism is intact.
6. **Concurrent registration under the new transaction shape** — the `P2002` backstop is unit-tested
   with a synthetic error and `User_email_key` is a real unique index, but I did not run concurrent
   registrations.
7. **`${{ env.AUTH_DATABASE_URL }}` resolving in the step-level `env:` of `ci.yml:98`** — valid per
   the GitHub Actions context table, but not executed here.

---

## Remaining risks and dispositions

| # | Risk | Disposition |
|---|---|---|
| 1 | `plugins/index.ts` / `logout-auth.plugin.ts` name a dead, denylist-less plugin as the JWT trust boundary | **Fix (HIGH-1)** — correct the comment; delete the dead file or file it |
| 2 | No default-privilege revoke for `FUNCTIONS`; the next resolver is `PUBLIC`-executable by default | **Fix (MEDIUM-1)** — one `ALTER DEFAULT PRIVILEGES` line |
| 3 | `DROP POLICY` + `CREATE POLICY` window; no guard on unexpected policies | **Fix (MEDIUM-2)** — non-destructive create + exact-set guard |
| 4 | `telemetry_auth_app` holds DML on all ten tables, incl. RLS-inert `InvoiceLineItem` | **Accept + record (MEDIUM-3)** — narrow, or state it in the release note and `known-gaps.md` |
| 5 | `v1_5` edited in place after being applied once | **Accept on merits; document (MEDIUM-4)** — one paragraph in the release note |
| 6 | Relation filter's effect is untested at the Prisma boundary | **Accept for now (LOW-5)** — one integration assertion recommended |
| 7 | `AuthRole` asserted from an unchecked JWT payload | **Accept** — pre-existing, proven; one-line fix now available |
| 8 | Two-step deploy (resolvers before the connection flip) | **Accept.** Release note is explicit; CI orders migrations before every test step; rollback lever 1 works — a superuser bypasses both the ACL and RLS, and the definer's policies remain satisfied |
| 9 | `"RefreshToken"` / `"InvoiceLineItem"` cross-tenant readable and writable | **Accept.** S-10 filed accurately; `v1_5` pre-creates the policy the fix will need |
| 10 | Compile-time-only client narrowing (`AuthPrismaClient`) | **Accept.** Correct guardrail, honestly described at `:136-141`; a Prisma-side change to `update.where` semantics would fail loudly (`PrismaClientValidationError`), not silently |
| 11 | `pnpm format:check` red repo-wide | **Accept, out of scope.** Pre-existing, proven, no CI step; separate commit |

---

## Recommended for `.claude/rules/known-gaps.md`

Only if the corresponding finding is not fixed here.

1. **`apps/auth-service/src/plugins/logout-auth.plugin.ts` is unreachable dead code with a weaker
   guard than the live one** (HIGH-1) — no importer; `/logout` uses `requireJwtAuth`; 0 % coverage;
   it verifies the JWT signature but never consults the token denylist, so wiring it would
   reintroduce revoked-token acceptance. File with the coverage line and the `routes/index.ts:28`
   reference.
2. **PostgreSQL's default `EXECUTE TO PUBLIC` is never revoked for functions in `public`**
   (MEDIUM-1) — `pg_default_acl` has `r` and `S` entries only, so every future `SECURITY DEFINER`
   resolver is world-executable until someone remembers an explicit `REVOKE`. Note the interaction:
   this is HIGH-2 of the previous review, re-openable by omission.
3. **`telemetry_auth_app` holds DML on all ten tables** (MEDIUM-3), including `"InvoiceLineItem"`
   where RLS is inert — cross-tenant write access for a service that touches three tables. Cross-
   reference S-10.
4. **`.prettierrc` disagrees with the codebase's indentation** — `pnpm format:check` fails on 250
   files and no CI step runs it, so `CLAUDE.md`'s command list advertises a gate that cannot pass.
   Fix the config or drop the script.

---

## Database left as found

I probed the live instance; everything is restored, verified by re-query at the end.

- **Read-only:** `pg_roles`, `pg_auth_members`, `pg_proc`, `pg_class`, `pg_policies`,
  `pg_default_acl`, `pg_namespace`, `pg_database`, `information_schema.role_table_grants`,
  `has_function_privilege`, `_prisma_migrations`; resolver calls and `SET ROLE` attempts as both
  app roles; `prisma migrate status`.
- **Rolled back (`BEGIN … ROLLBACK`, nothing committed):** `GRANT EXECUTE … TO PUBLIC`
  (non-vacuity of the `has_function_privilege('public', …)` check); six broken-state runs of
  guard §7; three runs of guard §8; the definer-attribute guard against a temporarily `BYPASSRLS`
  definer; two full re-applications of `migration.sql`.
- **Committed then reversed:** two probe tenants, one user and one refresh token, to capture the
  emitted `update` / `updateMany` / `findFirst` SQL and the `P2025` behaviour. All deleted;
  post-check `tenants left = 0`.
- **Final state re-queried:** `telemetry_app` `f/f/t`, `telemetry_auth_app` `f/f/t`,
  `telemetry_auth_definer` `f/f/f`; both policies present, `SELECT`, `{telemetry_auth_definer}`;
  both functions owned by the definer with unchanged `proacl`; `Tenant`/`User`/`RefreshToken`/`Event`
  all 0 rows; zero `%probe%` roles; `_prisma_migrations` untouched.
- **Working tree:** `git status --porcelain` empty apart from this review file. No source, test,
  migration or config file was edited. Scratch copies used for the mutation testing live under the
  session scratchpad and outside the repository; the two temporary files I created outside the
  scratchpad were removed.

---

## Gate

**CONDITIONAL** — required before commit:

1. **HIGH-1** — correct `plugins/index.ts:6-7` to name `jwt.plugin.ts`, and either delete
   `logout-auth.plugin.ts` or replace its `:43-46` comment and add the denylist check. If deletion
   is deferred, file it per *Recommended #1*.
2. **MEDIUM-1** — add `ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`,
   or file it per *Recommended #2*.
3. **MEDIUM-2** — make the policy creation non-destructive and add the exact-set guard.
4. **MEDIUM-4** — one paragraph in the release note about the in-place revision of `v1_5`.
5. **MEDIUM-3** — either narrow `telemetry_auth_app`'s table grants or record the choice.

LOW and NIT items are recommendations, not gates. Re-review needed only for items 1–3, which touch
the migration and the auth path.
