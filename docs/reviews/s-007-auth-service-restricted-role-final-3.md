# Senior Review — S-7 · auth-service on a restricted DB role (Gate 6, round 4)

Revision under review: `c916968` (single unpushed commit on `main`, working tree clean).
Round delta: `git diff 6299845..c916968`. Full change: `git diff b0f6921..c916968`.
Reviewer: fourth pass; did not author the code or any prior review.
Environment: live PostgreSQL 16.13 (`postgresql://postgres@127.0.0.1:5432/telemetry`), Redis up.

**Verdict: CONDITIONAL** — 2 HIGH, 1 MEDIUM, 2 LOW, 5 NIT.

The security property holds and is confirmed by execution for the fourth time: `telemetry_auth_app`
is `NOSUPERUSER NOBYPASSRLS`, owns nothing, holds DML on exactly `"Tenant"`/`"User"`/
`"RefreshToken"`, RLS blocks unscoped reads through it, and the resolvers are reachable by that
role alone. Nothing in this review asks for a design change or a re-implementation.

Both HIGH findings are in the same family the previous three rounds found — a load-bearing claim
in prose that is not true of the code. One of them (**HIGH-2**) is a false claim *about having
deleted a false claim*: §16 HIGH-1 states the retracted `ALTER DEFAULT PRIVILEGES` sentence is gone
from four places; it is still present verbatim in the fifth. The other (**HIGH-1**) is a guard added
*this round* that works in one direction while its comment claims two — and the direction it misses
is the one that widens the accepted role set at the JWT boundary. Both are small, local fixes.

---

## Findings

### HIGH-1 · The `AUTH_ROLES` parity assertion catches drift in one direction only; the comment claims both

`apps/auth-service/src/constants.ts:100` (claim) and `:107` (assertion).

```ts
 * schema had gained. This assignment fails to compile if the two diverge in either direction:
...
const _roleParity: Record<PrismaRole, AuthRole> = AUTH_ROLES;
```

Verified by execution with the repo's own `tsc` (`pnpm exec tsc --noEmit --strict`), modelling
`Role` faithfully as the string-literal union the generated client produces
(`node_modules/.pnpm/@prisma+client@6.19.3.../.prisma/client/index.d.ts:86` —
`export type Role = (typeof Role)[keyof typeof Role]`):

| Drift | Result |
|---|---|
| Schema gains `VIEWER`; `AUTH_ROLES` unchanged | `error TS2741: Property 'VIEWER' is missing … but required in type 'Record<PrismaRole, AuthRole>'` — **caught** |
| `AUTH_ROLES` gains `SUPERADMIN`; schema unchanged | **compiles clean — not caught** |

The second direction is not caught because excess-property checking applies only to *fresh object
literals*; `AUTH_ROLES` is a named `const`, so the extra key is accepted, and `AuthRole` is derived
from `AUTH_ROLES` so the value type widens along with it. The assertion is self-satisfying in that
direction.

That is the direction with security consequence. `jwt.plugin.ts:69` gates the token's `role` claim
on `isAuthRole`, i.e. on `Object.values(AUTH_ROLES)`. A role added to `AUTH_ROLES` but not to the
schema is a role the JWT boundary starts *accepting* and the database cannot store — precisely the
widening the `isAuthRole` check was added to prevent. §16 MEDIUM-5 confirmed the guard "bites by
widening the key type", which is direction A only; the comment generalised from one test.

**Fix** — add the reverse assertion next to the existing one (verified to produce
`error TS2322: … Type '"SUPERADMIN"' is not assignable to type 'PrismaRole'` for direction B, and
to stay clean for direction A, so the pair covers both):

```ts
const _roleParity: Record<PrismaRole, AuthRole> = AUTH_ROLES;
const _roleParityReverse: Record<AuthRole, PrismaRole> = AUTH_ROLES;
void _roleParity;
void _roleParityReverse;
```

Alternatively keep one assertion and correct `:100` to name the single direction it covers. The
first option is preferable: the claim as written is the one a future maintainer will rely on.

**Disposition: fix.** One line plus a comment.

---

### HIGH-2 · The retracted `ALTER DEFAULT PRIVILEGES` claim survives verbatim in the standing test

`apps/auth-service/tests/rls.integration.test.ts:457-461`:

```
// This is the durable half of the guard. PostgreSQL grants EXECUTE on every new
// function to PUBLIC and no ALTER DEFAULT PRIVILEGES can suppress it for functions
// (verified against PG 16.13 — a new function still comes out `proacl = NULL`), so
// the migration's explicit REVOKEs are the only protection and a future resolver
// added without one would be world-executable.
```

Every clause after the first is false as of this revision:

1. "no `ALTER DEFAULT PRIVILEGES` can suppress it for functions" — disproved below, and disproved
   by `prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql:311` **inside the same commit**,
   which issues exactly that statement and whose comment at `:299-305` explains why it works.
2. "a new function still comes out `proacl = NULL`" — no longer true in this database.
3. "the migration's explicit REVOKEs are the only protection" — there are now two layers, which
   `:294-295` of the migration states in as many words ("Two layers deal with that").

`docs/plans/s-007-auth-service-restricted-role.md` §16 HIGH-1 asserts: *"The false sentence is gone
from `tenant-isolation.md`, the release note, the migration and the test comment."* Grep across the
repository for `ALTER DEFAULT PRIVILEGES|proacl|default privilege` (excluding `node_modules`,
`dist`, `docs/reviews/`) confirms this is the **only** surviving copy — `tenant-isolation.md:110`,
`known-gaps.md:121-137`, `migration.sql:294-311` and
`docs/releases/s-007-auth-service-restricted-role.md:196-206` are all correctly rewritten. The
round-3 fix reached four of five sites, and §16 claims five.

The delta confirms the comment was not touched: `git diff 6299845..c916968 --
apps/auth-service/tests/rls.integration.test.ts` changes only the `Tests 18 skipped` → `Tests N
skipped` line and the grants block.

Measured on the live database, in `BEGIN … ROLLBACK`:

```
-- database-scoped default present (as the applied migration left it)
CREATE FUNCTION public.zz_probe_a2() … SECURITY DEFINER …;
         proacl        | public_exec | app_exec | authapp_exec
 {postgres=X/postgres} | f           | f        | f

-- default removed, then re-added with IN SCHEMA "public"
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  → pg_default_acl: no row created
CREATE FUNCTION public.zz_probe_a1() … SECURITY DEFINER …;
 proacl | public_exec | app_exec
 (null) | t           | t
```

**Fix** — replace `:457-461` with the true statement, e.g.:

```
// This is the durable half of the guard. PostgreSQL grants EXECUTE on every new function to
// PUBLIC; v1_5 sets a database-scoped `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS
// FROM PUBLIC`, which removes that for functions created by the migration role — the same
// statement written `IN SCHEMA "public"` does nothing at all (S-11). The default is per
// creating role, so a resolver created by any other role is still world-executable; the
// migration guards that at apply time and this asserts it on every `pnpm test`.
```

**Disposition: fix.** The assertion itself is correct and passing; only the comment is wrong. Worth
noting the test comment is where the claim is most likely to be believed — it is the file a
maintainer opens when adding a resolver.

---

### MEDIUM-1 · The database-scoped default privilege has a database-wide blast radius that is documented nowhere

`prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql:311`.

The statement is correct and does what §16 claims. But `ALTER DEFAULT PRIVILEGES` with no
`IN SCHEMA` records `defaclnamespace = 0` — it applies to **every function the migration role
creates in every schema of this database, permanently**, not just to `SECURITY DEFINER` functions
in `public`. Confirmed live:

```
SELECT defaclrole::regrole, defaclnamespace, defaclobjtype, defaclacl FROM pg_default_acl;
   role   | defaclnamespace | defaclobjtype |       defaclacl
 postgres |               0 | f             | {postgres=X/postgres}     ← left by v1_5
```

Two consequences measured in `BEGIN … ROLLBACK`:

```
CREATE SCHEMA zz_other;
CREATE FUNCTION zz_other.zz_plain() …;      -- plain, non-definer, other schema
 → {postgres=X/postgres}, public_exec = f

CREATE EXTENSION pgcrypto SCHEMA public;
 proname | proacl                | telemetry_app can execute
 armor   | {postgres=X/postgres} | f
 crypt   | {postgres=X/postgres} | f
 dearmor | {postgres=X/postgres} | f
```

So the next `CREATE EXTENSION` run by the migration role in this database produces functions
`telemetry_app` cannot call, and the five services that share that role fail at runtime with
`ERROR 42501: permission denied for function crypt`. The direction is fail-closed, so this is an
operational regression risk rather than a security hole — but it is silent until a query runs, and
it is cross-service, from a migration whose stated scope is two auth resolvers.

Nothing discloses it. `docs/releases/s-007-auth-service-restricted-role.md:196-206` frames the
statement narrowly, under "Adding another `SECURITY DEFINER` function later". `known-gaps.md:129-131`
(S-11) documents only the *opposite* direction — a function created by another role is still
world-executable — and mentions "an extension installed later" as an example of that residual, not
of this one. The Rollback section at `:160-172` lists roles, policies and functions as the artifacts
left behind and does not mention the `pg_default_acl` row.

**Fix** — three sentences, no code change:

1. `docs/releases/s-007-auth-service-restricted-role.md`, after `:200`: note that the default is
   database-scoped and covers *all* functions the migration role creates in any schema, so a future
   `CREATE EXTENSION` needs an explicit `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA … TO telemetry_app`.
2. Same file, Rollback: name `pg_default_acl` (`defaclnamespace = 0`) as a fourth artifact, reversible
   with `ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC` (verified: restores
   `proacl = NULL` behaviour and removes the row).
3. `.claude/rules/known-gaps.md` S-11: add the over-restriction direction alongside the existing
   under-restriction one. **This belongs in `known-gaps.md` rather than being fixed here** — it is a
   consequence of the chosen mechanism, not a defect in it, and re-scoping the statement would
   reintroduce round 3's HIGH-1.

**Disposition: fix the documentation; keep the statement.** Recommend it be folded into S-11 rather
than given a new id — same statement, opposite residual.

---

### LOW-1 · §16 LOW-6's disposition is false, and the round-3 fix introduced two more over-length lines

Round 3 (`docs/reviews/s-007-auth-service-restricted-role-final-2.md:417-421`) flagged
`docs/development-setup.md:61` as a 157-character merged line. §16's table records it **"Fixed."**

It is not fixed. The line is now `docs/development-setup.md:63` (displaced two lines by the HIGH-2
prose fix above it) and is **byte-identical** to the flagged line at `6299845`:

```
`apps/auth-service/.env.example`; `telemetry_auth_definer` is `NOLOGIN` and has none). Real deployments provision the role out of band; because the migration
```

Meanwhile the round-3 fixes created two new merged lines of the same class:

- `CLAUDE.md:168` — 122 chars. Verified new: `git show 6299845:CLAUDE.md | awk 'length($0)>100'`
  returns nothing.
- `prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql:154` — 103 chars, from the LOW-5
  "other five services" edit. Verified new by the same method.

(The remaining >100-char lines in `migration.sql` are `RAISE EXCEPTION` string literals, which
cannot be wrapped without concatenation. Not counted.)

**Fix** — wrap all three; correct the §16 disposition.
**Disposition: fix; cosmetic.** Reported because the *disposition* is false, not because the wrap is
important.

---

### LOW-2 · `migration.sql:252-255` are permanent no-ops, and `:224` reads as though no table default privileges are issued at all

```sql
224: -- No ALTER DEFAULT PRIVILEGES for tables either -- a future table must be granted deliberately,
...
252: ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
253: 	REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM telemetry_auth_app;
254: ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
255: 	REVOKE USAGE, SELECT ON SEQUENCES FROM telemetry_auth_app;
```

By the very mechanism section 6 now documents, these cannot do what their placement suggests. I
confirmed the merge direction by execution: with the database-scoped default in place (PUBLIC
absent), adding `ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT EXECUTE ON FUNCTIONS TO PUBLIC`
created a `{=X/postgres}` row at `defaclnamespace = 2200` and a function made afterwards came out
`public_exec = t`. Schema-scoped entries are merged *on top of* the global entry (which falls back
to `acldefault()`); they can only add. A schema-scoped `REVOKE` can therefore only delete a
schema-scoped *grant* row, never subtract from the default.

No revision of `v1_5` ever created such a row for `telemetry_auth_app` — verified with
`git show 6299845:…/migration.sql` and `git show c916968:…/migration.sql`, both of which only ever
revoke. So `:252-255` converge exactly one scenario: a hand-made schema-scoped grant. They are
inert against the more likely hazard, a database-scoped grant to that role, which is worth stating
since the file now explains the distinction 50 lines further down.

Separately, `:224`'s "No ALTER DEFAULT PRIVILEGES for tables either" sits 28 lines above two
`ALTER DEFAULT PRIVILEGES … ON TABLES` statements. Contextually it means "no default *grant*", and
the same phrasing appears in `CLAUDE.md:167`, `tenant-isolation.md:105`,
`development-setup.md:50` and the release note `:39` — all defensible, all one reading away from
contradicting the file.

**Fix** — either delete `:252-255`, or amend `:224` along the lines of: *"No default **grant** for
tables — a future table must be granted deliberately. The two revokes below converge a hand-made
schema-scoped grant only; per section 6 a schema-scoped revoke cannot subtract from the built-in
default."*

**Disposition: fix (comment) or delete (statements); reviewer's preference is amending the comment.**

---

### NIT-1 · `base.repository.ts:55-56` keeps the superset framing three other files were just corrected for

```
 *   `telemetry_auth_app` (`prisma/migrations/v1_5_auth_tenant_resolvers/`), which has the
 *   same attributes and additionally holds EXECUTE on the two pre-auth tenant resolvers.
```

Not false — "attributes" is the right word for role attributes, and both roles are verified
`LOGIN NOSUPERUSER NOBYPASSRLS` and own no table. But "same … and additionally holds EXECUTE"
describes `telemetry_auth_app` as `telemetry_app` **plus** a grant, which is the framing round 3's
HIGH-2 corrected in `CLAUDE.md`, `.env.example` and `development-setup.md`. This file was touched by
the same commit (`git diff b0f6921..c916968 -- …/base.repository.ts`) and was not on that list.

**Fix:** "…which has the same role attributes, *narrower* table privileges — DML on `"Tenant"`,
`"User"` and `"RefreshToken"` only — and additionally holds EXECUTE on the two pre-auth resolvers."
**Disposition: fix; one line.**

### NIT-2 · §16 MEDIUM-2 over-describes what the `telemetry_app` membership guard does

§16 says both planted definer grants "raise, with the message naming the `USING (true)` policy as
the reason". Both do raise — verified by planting each in a rolled-back transaction and running
section 7 — but for `telemetry_app` the raise comes from the *earlier* `has_function_privilege`
check at `migration.sql:356`:

```
ERROR: telemetry_app must not hold EXECUTE on public.auth_resolve_tenant_by_email(text) -- it is
shared by every service, and the resolvers read past the "User" tenant policy.
```

Only the `telemetry_auth_app` case reaches the new message. The `pg_has_role('telemetry_app', …)`
branch at `:440` is therefore unreachable-first: the definer owns the functions, so any member of
it necessarily has EXECUTE. Harmless defence in depth, and correct to keep — but the plan describes
a behaviour the file does not have. **Disposition: accept the code; correct §16 if it is amended.**

### NIT-3 · The table guard and revoke loop omit `relkind` `'m'` and `'f'`

`migration.sql:240` and `:465`, and `rls.integration.test.ts:239`, all filter
`relkind IN ('r','p','v')`. `public` currently contains only `relkind = 'r'` (11 relations,
verified), so there is no live gap. A future materialized view or foreign table granted to
`telemetry_auth_app` would be neither revoked by the loop nor caught by the guard. The
column-grant guard at `:473-485` has no `relkind` filter and is correspondingly broader.
**Fix:** `relkind IN ('r','p','v','m','f')` in all three places. **Disposition: accept or fix;
speculative today.**

### NIT-4 · The standing test's column-grant predicate is stricter than the migration's

`rls.integration.test.ts:246-254` counts column grants to `telemetry_auth_app` across all of
`public`, including the three permitted tables; `migration.sql:473-485` excludes them. Both read
`0` today. The test being stricter is fine; noted only because §16 MEDIUM-1 describes the test as
carrying "the same predicate". **Disposition: accept.**

### NIT-5 · `role?: AuthRole | string` collapses to `string`

`jwt.plugin.unit.test.ts:35`. The union degrades to `string`, so a typo'd role literal elsewhere in
the file would type-check. Nothing is actually weakened — every other call site now passes
`AUTH_ROLES.OWNER` (LOW-2 from round 3, verified fixed in all three files). If tightening is wanted,
a separate `createTokenWithRawRole(secret, rawRole, expiration)` helper keeps `AuthRole` on the main
one. **Disposition: accept.**

---

## Round-3 items confirmed fixed

Each re-checked on this revision rather than taken from §16.

| §16 item | Status |
|---|---|
| HIGH-1 · `ALTER DEFAULT PRIVILEGES` claim | Statement present and working (`migration.sql:311`); both semantics verified live. **Prose fixed in 4 of 5 places — see HIGH-2.** |
| HIGH-2 · three docs described the pre-narrowing role | Fixed. `CLAUDE.md:165-167`, `.env.example:16-18`, `development-setup.md:47-51` all say **less** and name the three tables. Matches the live catalog: `telemetry_auth_app` holds `arwd` on `Tenant`/`User`/`RefreshToken` only; `telemetry_app` on all ten. |
| MEDIUM-1 · vacuous grant guard | Fixed. `aclexplode` over `relacl`/`attacl`. Planted `GRANT SELECT ON "Event"` → table guard raises; planted `GRANT SELECT ("id") ON "Event"` → column guard raises. No false positive on the baseline (`relacl IS NULL` rows drop out of the `CROSS JOIN LATERAL`; owner and `telemetry_app` entries have a different grantee). |
| MEDIUM-2 · membership escalation uncaught for `telemetry_auth_app` | Fixed. Planted `GRANT telemetry_auth_definer TO telemetry_auth_app` → raises with the `USING (true)` message. `GRANT telemetry_auth_definer TO postgres` (the migration role) → guard passes, as the release note requires. See NIT-2. |
| MEDIUM-3 · `isAuthRole` untested | Fixed. Two tests added and passing. Redness established by reading rather than by deletion — see "could not verify". |
| MEDIUM-4 · `REVOKE`→`GRANT` window | Fixed. Grants at `:227-229` precede the revoke loop at `:231-249`, so no statement order leaves the role without table access even under a bare `psql -f`. Convergence proven: planted DML on all 11 tables, ran `:227-255`, ended with exactly `RefreshToken`/`Tenant`/`User` × `DELETE,INSERT,SELECT,UPDATE`. |
| MEDIUM-5 · `AUTH_ROLES` drift | **Partially fixed — see HIGH-1.** |
| LOW-1 · hard-coded "18 skipped" | Fixed; count removed (`rls.integration.test.ts:33`). File now has 20 tests, so the generic wording is also correct. |
| LOW-2 · `"OWNER"` literals | Fixed in all three files. |
| LOW-3 · `P2025` local | Fixed; `AUTH_DATABASE.RECORD_NOT_FOUND_CODE` (`constants.ts:83`). |
| LOW-4 · standing grant test | Fixed; catalog ACLs, column grants, `pg_has_role`. |
| LOW-5 · "all six services" | Fixed in both places (`migration.sql:32`, `:153`). Introduced a 103-char line — LOW-1. |
| LOW-6 · 157-char line | **Not fixed — see LOW-1.** |
| NIT-1 · `AccessJwtPayload` shape assertion | Fixed by comment (`jwt.plugin.ts:57-59`), and the comment is accurate: `toAuthenticatedContext:65` presence-checks `sub`/`tenantId`/`jti`/`exp` and narrows only `role`. |

---

## Priority-order checks

**1 · Tenant isolation.** No finding.

Every table access in `UserRepository` runs inside `withTenantContext(tenantId, fn)`
(`user.repository.ts:229-243`), which issues `set_config(app.tenant_id, …, true)` as the
transaction's first statement, **and** carries an explicit predicate: `where: { email, tenantId }`
(`:338`), `where: { tokenHash, user: { tenantId } }` (`:390`), `where: { id, user: { tenantId } }`
(`:433-436`), `updateMany` with `user: { tenantId }` (`:459-463`). Belt and braces, as the rule
requires. `"RefreshToken"` has no `tenantId` column, so the relation filter is the only application
control there — consistent with S-10, and the filters are load-bearing rather than decorative.

Provenance of every `tenantId`, traced to source: a `SECURITY DEFINER` resolver keyed on a
credential (`:246-265`), a `randomUUID()` the repository just generated (`:286`), or
`request.auth` — set by `jwt.plugin.ts:118` from a signature-verified token and passed through
`auth.controller.ts:79` → `auth.service.ts:160-167`. No caller-supplied request field reaches a
tenant predicate. The `db` field is deliberately typed down to `$queryRaw` + `$transaction`
(`:107-137`), so an unscoped `this.db.user.findFirst(...)` does not compile — a structural control,
not a convention.

DB layer: `telemetry_auth_app` is `rolsuper = f`, `rolbypassrls = f`, owns no table (live
`pg_roles`/`pg_class`). `known-gaps.md` S-2 does not apply. `telemetry_auth_definer` is
`NOLOGIN NOSUPERUSER NOBYPASSRLS` and reads past the policies through two `FOR SELECT` policies
scoped to itself, not through a role attribute — which is what keeps the migration appliable where
`CREATE ROLE … BYPASSRLS` is unavailable. `pg_auth_members` for the definer: 0 rows.

**2 · Injection.** No finding. `Prisma.raw` appears only on frozen module constants
(`user.repository.ts:15-17` and `rls.integration.test.ts:74-77`, both from `AUTH_DATABASE`, which
is a literal `as const` object at `constants.ts:68-84` with no env input). Every caller-supplied
value is a bound parameter — e-mail and token hash go in as `${…}` in `Prisma.sql`. No enum-like
SQL variation in this change. In the migration, the one dynamic identifier path is
`format('%I', v_relation)` over `pg_class.relname` (`:243-246`), which is catalog-derived, not
caller input.

**3 · Correctness.** Beyond the findings above: `migration.sql` re-applies clean and idempotent —
I ran the entire file inside `BEGIN … ROLLBACK` and all of section 7's guards plus section 8's
functional probe passed, ending with exactly the three expected grants. `prisma migrate status`:
"Database schema is up to date!" Error contract: `RECORD_NOT_FOUND_CODE` is the documented signal
for a refresh-token write whose tenant predicate excludes the row, which is the right shape given
`"RefreshToken"` carries no `tenantId` column.

**4 · Clean code gate.** No magic literals introduced. `AUTH_DATABASE` and `AUTH_ROLES` carry every
role name, function name, policy name, setting name and error code; the test files import them
rather than restating them (`rls.integration.test.ts:5`, `jwt.plugin.unit.test.ts:5`).
`rls.integration.test.ts:40-45,78-86` keeps its own local constants for things that are properties
of the *suite* rather than of the service contract, with the reasoning stated at `:79-82` — correct
placement, not a DRY violation. Findings in this category: LOW-1 (line length), LOW-2 (dead
statements). No BLOCKER or HIGH.

**5 · Type safety.** `import type { Role as PrismaRole }` is type-only and erased; verified the
built output contains no `@prisma/client` require from `constants.ts`, so the
`initTracing`-before-heavy-imports rule at `CLAUDE.md` is unaffected. `const _roleParity` is a
runtime binding, but an alias to an existing frozen object with no side effect — the §16 claim is
about the *import*, and is correct as stated. `$queryRaw` result assertions in the integration test
are typed against declared interfaces (`:47-71`) rather than `any`. The `as TenantId` / `as UserId`
brands are applied at exactly one boundary (`jwt.plugin.ts:73-82`, `user.repository.ts:354`,
`:413`), with the reasoning documented.

**6 · Production readiness.** Two-step deploy is documented and CI enforces the ordering
(`ci.yml:79` applies migrations before every test step). The migration fails loudly rather than
silently in all the ways the release note claims — I confirmed by planting four separate violations.
The `pg_default_acl` blast radius is the one production-readiness gap (MEDIUM-1). Index coverage: no
new query paths; the resolvers select on `"User"."email"` (globally unique since `v1_1`) and
`"RefreshToken"."tokenHash"`.

**7 · Test honesty.** No finding, and the shapes here are better than the bar.

- No `.skip`, `skipIf`, `it.todo`, `if (!x) return` or CI-conditional anywhere in
  `apps/auth-service/tests/*.test.ts` — grepped. No short-circuits, so no inverted signals.
- `rls.integration.test.ts:104-139` is the S-3 replacement: `beforeAll` **throws** if the role
  cannot be resolved, is a superuser, holds `BYPASSRLS`, or is not `telemetry_auth_app`
  specifically. The `:132-134` comment explains why "some restricted role" is not good enough —
  pointed at `telemetry_app` the file would leave 14 assertions green. That is the right reasoning.
- `user.repository.unit.test.ts:102` throws on **any** unexpected raw query, so a new unscoped raw
  query fails the suite rather than slipping past. `:109-118` and `:120-128` throw when the
  tenant-context statement is absent or duplicated, rather than passing vacuously. Exactly the
  helper shape `.claude/rules/testing.md` requires.
- Assertions are behavioural, not mock echoes. The load-bearing ones are negative: zero rows without
  tenant context (`:224`, `:304`), `not.toContain(tenant1Id)` (`:215`, `:298`),
  `shared_app_can_execute → false` (`:419-422`), `can_assume_definer → false` (`:268-273`),
  and `await expect(app.event.findMany()).rejects.toThrow()` (`:275`) — which I saw produce a real
  `42501 permission denied for table Event` from the database.
- The two new `jwt.plugin` tests assert rejection of a *validly signed* token, which is the only
  version of that test worth having.

**8 · Plan alignment.** In scope. The one thing I would have expected to be flagged as scope creep
— rewriting `.claude/rules/testing.md`'s integration-test section — is justified: the old text said
integration suites are "excluded from the default vitest config", and that was simply false. I
verified the replacement claim in full. Five services have a `vitest.config.mjs` (`analytics`,
`auth`, `billing`, `usage`, `worker`); in all five the only `exclude` is nested under `coverage`,
never `test`; the other eight packages have no config at all. So `pnpm test` does require a live
database, and auth-service's three integration suites ran inside my `pnpm test` — which makes the
RLS proof part of the standing gate rather than an optional extra.

---

## What I verified by execution

Gates, all re-run with `--force` (no cache):

| Gate | Result |
|---|---|
| `pnpm typecheck` | **13/13 successful** |
| `pnpm build` | **13/13 successful**, 21.9s |
| `pnpm lint` | **13/13 successful** — 0 errors, 14 warnings |
| `pnpm test` | **13/13 successful** |
| `pnpm --filter @telemetry/auth-service typecheck` | exit 0 |
| `pnpm --filter @telemetry/auth-service test:coverage` | 15 files, 164 tests passed |

Per-package tests: gateway 38, auth-service **164 (15 files)**, usage-service 179 (17),
worker-service 19 (4), billing-service 18 (4), analytics-service 18 (4), shared-utils 18,
shared-validation 15, shared-types 7, shared-config 4, shared-logger 4, shared-tracing 2, web (no
test target output). Matches the claimed 164/164 across 15 files exactly.

Coverage: **95.52%** statements / 87.5% branch overall; `src/plugins` **92.59%** branch. Matches the
claim exactly.

Lint warnings — **14, all pre-existing, proven not inferred:**

- `apps/auth-service/tests/auth.service.unit.test.ts` × 10 (`no-misused-promises`)
- `apps/usage-service/tests/ingestion.service.unit.test.ts` × 4 (`no-unsafe-assignment`)

`git diff --name-only b0f6921..c916968` contains **neither file**. `git log -1` for them:
`d68e719 test(services): expand coverage…` and `b0f6921` (the base commit) respectively. Nothing
new introduced; nothing pre-existing counted against the change.

PostgreSQL semantics, all in `BEGIN … ROLLBACK`:

- Database-scoped `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` **works** — a
  `SECURITY DEFINER` function created afterwards is `{postgres=X/postgres}` with `PUBLIC`,
  `telemetry_app` and `telemetry_auth_app` all denied.
- The `IN SCHEMA "public"` form **does nothing** — accepted, creates no `pg_default_acl` row,
  function comes out `proacl = NULL` with `PUBLIC` holding EXECUTE.
- The mechanism comment at `migration.sql:299-305` is a **correct** characterisation, not a
  plausible story: I confirmed the merge direction independently by adding a schema-scoped
  `GRANT EXECUTE … TO PUBLIC` on top of the database-scoped revoke, which produced a
  `{=X/postgres}` row at `defaclnamespace = 2200` and restored `public_exec = t`. Schema entries add
  on top of the global entry (or `acldefault()` in its absence) and can never subtract.
- S-11's stated residual — recorded per creating role — is exactly right, no more and no less.
- All four section-7 guards fire when their violation is planted; the migration role's own definer
  membership is permitted.
- Section 4 converges 11 tables → 3 with the correct four privileges, grants before revokes.
- The whole migration re-applies clean and idempotent, guards and functional probe included.
- `docker/postgres/init/01-app-role.sql`'s `LANGUAGE sql` claim: a body referencing a missing table
  **fails at CREATE time** (`ERROR: relation "public.ZZ_NoSuchTable" does not exist`), while the
  `plpgsql` equivalent succeeds. Correct reasoning for omitting the resolvers from the init script.
- `'telemetry_auth_app'::regrole` is safe everywhere it appears: in the migration the role is
  created in section 4 before the section-7 guard plans the statement, and in the test the suite
  connects *as* that role.

Other claims checked against reality:

- Live ACLs: `telemetry_auth_app` → `arwd` on `RefreshToken`, `Tenant`, `User` and nothing else;
  `telemetry_app` → `arwd` on all ten application tables; `_prisma_migrations` grants neither. The
  revoke loop targets 8 relations **including `_prisma_migrations`**, as intended.
- **S-12** reproduced: `pnpm format:check` → "Code style issues found in **251** files", exit 1.
- **S-13** reproduced independently of grep: `prisma/seed.ts:34-40` upserts on
  `where: { tenantId_email: … }`, and the only `@@unique` declarations in `prisma/schema.prisma` are
  `Meter:110`, `Invoice:128`, `MetricRollup:157`. `User` has none. Accurate as filed, and correctly
  out of scope.
- `senior-reviewer.md:47-50`'s S-3 provenance: S-3 is absent from `known-gaps.md` (which runs S-5,
  S-6, S-8..S-13) and is discussed in the named review. Accurate.
- `prisma migrate status`: up to date.

**Database left exactly as found.** Re-checked at the end: `pg_default_acl` back to its original
three rows (`postgres/0/f`, `postgres/2200/r`, `postgres/2200/S`), `pg_auth_members` empty for the
telemetry roles, zero `zz%` relations, schemas or functions, `pg_extension` = `plpgsql` only, zero
probe rows in `"Tenant"`. Every experiment was wrapped in `BEGIN … ROLLBACK`; the only unwrapped
writes were the integration suites in `pnpm test`, which clean up through their own admin client
(verified: 0 leftovers).

## What I could not verify, and why

- **Managed Postgres behaviour.** The claim that reading `pg_class`/`pg_attribute` (rather than
  `information_schema.role_table_grants`) makes the guard work for a **non-superuser** migration
  role — the whole point of MEDIUM-1 in round 3 — I could only exercise as `postgres`. Catalog
  visibility is not role-dependent in PostgreSQL, so I believe it, but that is **reasoning, not
  execution**. Round 3 reports having reproduced it with a `zz_migrator` role; I did not re-create
  that role, to avoid leaving state behind.
- **Redness of the two new `jwt.plugin` tests.** Established by **reading**, not by deleting the
  branch: `toAuthenticatedContext` (`jwt.plugin.ts:65`) presence-checks `sub`/`tenantId`/`jti`/`exp`
  and **not** `role`, and `createAccessToken` always sets `sub` (`setSubject("user_1")`) and `exp`,
  so in both new tests every other guard passes and only `:69` can reject. Remove `:69-71` and both
  resolve — the denylist mock returns `false` by default — so both would fail their `rejects`
  assertion. Sound, but I did not execute it, because doing so means editing the source and this
  review is read-only.
- **`prisma generate` never having run.** I did not delete the generated client to test whether
  `import type { Role }` breaks a cold `pnpm typecheck`. CI generates at `ci.yml:86-88`, before
  lint/typecheck/test/build, and the root `pretest` covers `pnpm test`; `pnpm typecheck` alone has
  no such hook, but that is pre-existing — `usage-service` and `worker-service` already import
  `Prisma`/`PrismaClient`. `Role` is the first *schema-enum* dependency, which is a narrower version
  of the same existing requirement. Not a new class of risk.
- **The two-step deploy** (apply `v1_5`, verify resolvers as `telemetry_auth_app`, then roll
  `DATABASE_URL`) in a real multi-instance environment. Locally the end state is correct; the
  ordering hazard is a deployment property.
- **`relkind` `'m'`/`'f'` coverage** (NIT-3) is a reasoned gap — I did not create a materialized
  view to confirm the guard misses it, since none exists in the schema.

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| HIGH-1 · parity assertion half-works; comment claims both directions | **Fix before commit.** One added line; direction B is the security-relevant one. |
| HIGH-2 · retracted claim survives in the standing test comment | **Fix before commit.** Comment only; the assertion is correct. |
| MEDIUM-1 · database-wide default-privilege blast radius undisclosed | **Fix the docs before commit**; keep the statement. Fold into S-11 in `known-gaps.md` — do not let it evaporate. |
| LOW-1 · false LOW-6 disposition; two new long lines | Fix; cosmetic. |
| LOW-2 · dead schema-scoped revokes; `:224` comment | Fix the comment or delete the statements. |
| NIT-1..NIT-5 | NIT-1 fix (one line); NIT-2 correct §16 if amended; NIT-3..NIT-5 accept. |
| S-10 · `"RefreshToken"` RLS `FORCE`d, never `ENABLE`d | Accept as filed. Correctly out of scope; `v1_5` pre-creates the policy its closure needs, and the relation filters plus admin-client read-back in the logout test are the right interim shape. |
| S-11 · definer function created by another role is `PUBLIC`-executable | Accept as filed and now accurate. **Extend with MEDIUM-1's opposite residual.** |
| S-12 · `format:check` cannot pass (251 files) | Accept as filed. Reproduced. |
| S-13 · `seed.ts` compound unique | Accept as filed. Reproduced independently. Out of scope. |
| Latency: login 1 → ~9 round-trips | Accept. Reasoning at release note `:176-187` is sound — bcrypt dominates by two orders of magnitude, and the enumeration profile is preserved. |

---

## Gate

**CONDITIONAL.**

Required before commit: **HIGH-1**, **HIGH-2**, **MEDIUM-1** (documentation), and the `known-gaps.md`
amendment for MEDIUM-1. LOW-1, LOW-2 and NIT-1 are worth folding in while the files are open;
NIT-2..NIT-5 need nothing.

On the fourth-round question, plainly: the change's security property is sound and I confirmed it
independently — the restricted role is real, RLS enforces through it, the grants are exactly three
tables, the resolvers are reachable by one role, and the guards fail loudly when tampered with. The
code needs no rework. What is still wrong is one new guard that is half a guard (HIGH-1) and one
comment that a previous round reported deleting and did not (HIGH-2). Neither is a matter of taste
and neither was raised before: HIGH-1 is a defect in code added *this* round, and HIGH-2 is
demonstrable in three lines of grep. Once those two sentences and one table entry are corrected,
this should be approved without a fifth substantive pass — the remaining items are cosmetic and I
would not hold a commit for them on their own.

Recommend that the next reviewer verify **only** HIGH-1 (a two-file `tsc` check), HIGH-2 (read
`rls.integration.test.ts:457-461`) and the S-11 amendment. Re-verifying the database layer a fifth
time would tell no one anything new.
