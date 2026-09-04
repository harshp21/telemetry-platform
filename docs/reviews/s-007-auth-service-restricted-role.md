# Senior Review — S-7 · auth-service onto the restricted `telemetry_app` role

Reviewer: `senior-reviewer` (independent; did not write this code)
Base: `main` @ `b0f6921` · Reviewed: full uncommitted working tree + untracked
`prisma/migrations/v1_5_auth_tenant_resolvers/`, `docs/releases/`, `docs/plans/`
Plan: `docs/plans/s-007-auth-service-restricted-role.md`

## Verdict

**CONDITIONAL**

The change achieves its stated objective and I confirmed it against a live database:
`"User"` RLS now genuinely enforces on auth-service's own connection. Three HIGH findings
remain, and two of them rest on load-bearing claims made *inside the change* that I
disproved by execution — the necessity of `BYPASSRLS`, and the impossibility of a tenant
predicate at call sites 6 and 7. Neither is a functional regression; both are
least-privilege defects in a change whose entire purpose is least privilege.

No BLOCKER. Authentication is not broken — register, login, refresh, rotation and logout
all pass end-to-end against `telemetry_app` (151/151, run below).

---

## Findings

### HIGH-1 · `BYPASSRLS` on the definer role is not necessary — and the migration's own guard forbids the narrower alternative

`prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql:34-40` (role creation),
`:47-57` (attribute clamp), `:61-74` and `:137-148` (guards).

The migration's central design claim (`:14-19`) is that a `SECURITY DEFINER` function under
`FORCE ROW LEVEL SECURITY` *must* be owned by a `BYPASSRLS` role or it silently returns
`NULL`. The first half is right — `FORCE` removes the owner's exemption. The conclusion is
not. A definer role that is `NOSUPERUSER **NOBYPASSRLS** NOLOGIN`, plus one targeted
permissive policy per table, resolves the identical tenant id.

I ran this (whole thing inside a transaction, rolled back — nothing persisted):

```
CREATE ROLE rls_alt_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT SELECT ON TABLE "User" TO rls_alt_probe;
CREATE POLICY alt_probe_read ON "User" FOR SELECT TO rls_alt_probe USING (true);
-- definer function owned by rls_alt_probe, app.tenant_id cleared to ''
                variant                | resolved
---------------------------------------+----------
 NOBYPASSRLS definer + targeted policy | alt_t
```

Why this matters beyond purity: `BYPASSRLS` is a **role attribute**, not a table grant. It
applies to every table the role can ever reach. Today that is bounded by two `SELECT`
grants, but the bound is a convention, not a mechanism — any future `GRANT SELECT ... TO
telemetry_auth_definer` silently becomes an RLS bypass. A permissive policy is bounded by
construction.

The sharper problem is that the change does not merely *choose* `BYPASSRLS` — it **mandates**
it. The clamp at `:47-57` will `ALTER ROLE ... BYPASSRLS` an operator's deliberately
narrowed role back to bypassing, and the guards at `:61-74` and `:137-148` raise an
exception if it is `NOBYPASSRLS`. An operator who hardens this correctly cannot apply the
migration.

**Fix.** Either (a) switch to the policy-based definer:

```sql
CREATE ROLE telemetry_auth_definer NOLOGIN NOSUPERUSER NOBYPASSRLS ...;
CREATE POLICY user_auth_definer_read ON "User"
  FOR SELECT TO telemetry_auth_definer USING (true);
CREATE POLICY refreshtoken_auth_definer_read ON "RefreshToken"
  FOR SELECT TO telemetry_auth_definer USING (true);
```

and change both guards to assert `NOT rolsuper AND NOT rolcanlogin` plus the presence of
those two policies (drop the `rolbypassrls` requirement from `:52`, `:66`, `:141`); or
(b) keep `BYPASSRLS` and record the decision explicitly — in which case the guards should
still not *clamp* an operator's role, and the reasoning in `migration.sql:14-19` and
`.claude/rules/tenant-isolation.md` must stop asserting that `BYPASSRLS` is required, because
it is not.

The functional guard (§6) is unaffected either way and should be kept — it is the part that
actually proves resolution works.

### HIGH-2 · `EXECUTE` is granted to `telemetry_app`, so every service gets a cross-tenant email→tenant oracle

`prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql:123-124`.

`telemetry_app` is the single login role shared by all six services (`v1_4`). Granting
`EXECUTE` to it does not grant it to auth-service — it grants it to gateway, usage,
worker, billing and analytics as well. Those functions read past RLS by design.

Demonstrated live, two tenants seeded and removed afterwards:

```
-- connected as telemetry_app, app.tenant_id = tenant B
 users visible                                  |     1     <- RLS works, A's user hidden
 resolver leaks tenant A id to tenant B session | ..._tA    <- RLS bypassed via the function
 token-hash oracle  | leaked_tenant = ..._tA | miss = NULL
```

So the `"User"` RLS that this change correctly turns on is reachable around, from any
tenant's request context in any service, for anyone who can get arbitrary SQL onto the
`telemetry_app` connection. That is precisely the failure mode RLS exists to backstop.

On the refresh-token resolver specifically: it is **not** currently a meaningful token-hash
guessing oracle. `tokenHash` is a unique index over `randomBytes(32)`, so guessing is
infeasible, and `telemetry_app` can already read every `"RefreshToken"` row directly because
RLS is inert on that table (S-10, confirmed below) — the function tells an attacker nothing
they cannot already `SELECT`. **But that inverts the day S-10 is fixed:** the moment
`"RefreshToken"` gets `ENABLE ROW LEVEL SECURITY`, this grant becomes a live bypass of the
policy just added. Worth fixing before S-10, not after.

**Fix.** Give auth-service its own login role and scope the grant to it:

```sql
-- v1_5 (or a follow-up migration)
REVOKE EXECUTE ON FUNCTION public.auth_resolve_tenant_by_email(text) FROM telemetry_app;
REVOKE EXECUTE ON FUNCTION public.auth_resolve_tenant_by_refresh_token_hash(text) FROM telemetry_app;
GRANT EXECUTE ON FUNCTION public.auth_resolve_tenant_by_email(text) TO telemetry_auth_app;
GRANT EXECUTE ON FUNCTION public.auth_resolve_tenant_by_refresh_token_hash(text) TO telemetry_auth_app;
```

with `telemetry_auth_app` a `LOGIN NOSUPERUSER NOBYPASSRLS` role holding the same table
grants as `telemetry_app`, and auth-service's `DATABASE_URL` pointed at it
(`.env.example`, `tests/setup.ts`, `ci.yml`, compose). If that is judged too large for this
change, it must be filed — see *Recommended for known-gaps* below. Do not leave it
undocumented.

### HIGH-3 · Sites 6 and 7 carry no tenant predicate, and the stated reason is factually wrong

`apps/auth-service/src/repositories/user.repository.ts:402-406` (`rotateRefreshToken`) and
`:423-431` (`revokeActiveRefreshTokens`).

The author's position — reproduced at `:341-343` and in the plan — is that `"RefreshToken"`
has no `tenantId` column so no application-layer predicate is expressible. That is true of a
*scalar* predicate only. Prisma's `where` for both `update` and `updateMany` accepts the
`user` relation filter:

```
RefreshTokenWhereInput        ... user?: XOR<UserScalarRelationFilter, UserWhereInput>
RefreshTokenWhereUniqueInput  ... user?: XOR<UserScalarRelationFilter, UserWhereInput>
```
(`node_modules/.prisma/client/index.d.ts:13541`, `:13564`)

and it compiles to a real predicate. Emitted SQL, captured from a live no-op `updateMany`:

```sql
UPDATE "public"."RefreshToken" SET "revokedAt" = $1
WHERE ("public"."RefreshToken"."userId" = $2
   AND "public"."RefreshToken"."revokedAt" IS NULL
   AND EXISTS(SELECT "t0"."id" FROM "public"."User" AS "t0"
              WHERE ("t0"."tenantId" = $3 AND ("RefreshToken"."userId") = ("t0"."id"))))
```

This is not academic. `"RefreshToken"` has `relrowsecurity = false` (S-10, verified below),
so for these two writes the application predicate is the **only** tenant control available,
and it is absent. `withTenantContext` wraps them, but the wrapper provably cannot fail —
the migration-time equivalent of a test that passes vacuously.

Not exploitable today: `input.userId` and `input.tenantId` in logout both come from one
`jwtVerify`-checked token (`plugins/logout-auth.plugin.ts:56-57`), and
`currentRefreshTokenId` in rotation comes from `findRefreshTokenForRotation`, not from the
caller. Both are also globally-unique UUID primary keys, so a lookup by them cannot span
tenants. That is a genuine compensating control and I credit it — but it is defence by
argument, and `.claude/rules/tenant-isolation.md` asks for defence by predicate.

**Fix**, `user.repository.ts:423-431`:

```ts
await tx.refreshToken.updateMany({
    where: {
        userId: input.userId,
        revokedAt: null,
        user: { tenantId: input.tenantId }   // add
    },
    data: { revokedAt: new Date() }
});
```

and `:402-406` — either add `user: { tenantId: input.tenantId }` to the existing
`update` where (allowed alongside `id`), or move to `updateMany` and assert `count === 1`
so a cross-tenant id fails loudly rather than silently revoking nothing. Then correct
`:341-343` and the plan's §on site 7, and add the matching negative unit assertions.

### MEDIUM-1 · The documented managed-Postgres recovery path will fail

`docs/releases/s-007-auth-service-restricted-role.md:60-73`, against
`prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql:113-116`.

The release note tells an operator on RDS/Cloud SQL/Neon to create
`telemetry_auth_definer` out of band and re-run `migrate deploy`. The migration then reaches
`ALTER FUNCTION ... OWNER TO telemetry_auth_definer`, which requires the migration role to
be able to `SET ROLE` to the new owner. Simulated with a non-superuser migration role
(transaction rolled back):

```
ERROR:  must be able to SET ROLE "telemetry_auth_definer"
```

So the escape hatch for exactly the platform class where the migration is designed to fail
does not itself work. It fails loudly rather than silently, which is why this is MEDIUM.

**Fix.** Extend the out-of-band snippet at `:66-69`:

```sql
CREATE ROLE telemetry_auth_definer
  NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT telemetry_auth_definer TO <migration_role>;   -- required for ALTER FUNCTION ... OWNER TO
```

Also worth a sentence at `:57-59`: on RDS the attribute is not `BYPASSRLS` but
`GRANT rds_bypassrls TO telemetry_auth_definer`, and Cloud SQL/Neon differ again — the flat
`CREATE ROLE ... BYPASSRLS` will not work verbatim on any of the three platforms named.

### MEDIUM-2 · Third copy of the connection-string literals

`apps/auth-service/tests/auth.integration.test.ts:16-22` adds a third and fourth copy of
two literals that already exist in `tests/setup.ts` and `tests/rls.integration.test.ts`
(and, for the admin URL, `env.schema.unit.test.ts` and `token.service.unit.test.ts`).
`.claude/rules/constants.md` is explicit: *"before adding a third copy of a literal, promote
it"*, and it applies to tests.

**Fix.** Export both from one place — e.g. `apps/auth-service/tests/database-urls.ts`:

```ts
export const TEST_DATABASE_URLS = {
    APP: "postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry",
    ADMIN: "postgresql://postgres:postgres@localhost:5432/telemetry"
} as const;
```

and import it in `setup.ts`, `auth.integration.test.ts`, `rls.integration.test.ts`.

### MEDIUM-3 · Login and refresh gain database round-trips on the hottest path

`user.repository.ts:301-333`, `:355-392`.

Login was one `findUnique`. It is now: resolver `SELECT` (own round-trip, outside any
transaction) → `BEGIN` → `set_config` → `SELECT` → `COMMIT`, then a second transaction of
the same shape for `storeRefreshToken`. Roughly 1 → ~9 round-trips per login. Refresh is
similar.

Not a blocker — bcrypt at 10-12 rounds (50-300 ms) dominates by two orders of magnitude, and
that also means the *enumeration* profile is preserved (see "Correctness" below). But it is
a real latency and connection-pool change on the platform's busiest endpoint and I could not
find it quantified anywhere in the plan or release note.

**Disposition:** accept, but state it in the release note so it is not a surprise in
production metrics. If it ever matters, the resolver call can be folded into the same
transaction as the scoped read.

### LOW

1. `user.repository.ts:394-433` — `storeRefreshToken` carries the S-10 explanation at
   `:341-343`; `rotateRefreshToken` and `revokeActiveRefreshTokens` do not, though they have
   the same property. Add the same three-line comment, or lift it to the class doc.
2. `apps/auth-service/tests/rls.integration.test.ts:328-342` — only the **email** resolver
   has a behavioural "resolves with no tenant context" test. The token resolver gets shape
   and privilege assertions only. It is covered end-to-end by the refresh test in
   `auth.integration.test.ts`, so this is a symmetry gap, not a hole. Add the mirror case.
3. `apps/auth-service/tests/user.repository.unit.test.ts:113-115` — `$transaction` is mocked
   as `(cb) => cb(mockPrisma)`, so nothing asserts that `set_config` is issued **before** the
   model call. A repository that set the context last would pass every unit test. Integration
   catches it (login would return null), so LOW. Recording call order in a single array and
   asserting `set_config` is index 0 would close it.
4. `user.repository.ts:179` — `prisma as unknown as AuthPrismaClient`. The double cast is the
   right call at this boundary, but `CLAUDE.md` asks that the reason be explicit and the
   comment at `:127-132` explains the *type*, not the *cast*. One line: "the runtime client is
   the full `PrismaClient`; this narrows what the rest of the file may reach, at compile time
   only."
5. `user.repository.ts:226`, `:240` — `as TenantId | null` on a `$queryRaw` result with no
   runtime check. The functions are `RETURNS text` so the shape is guaranteed by the
   migration, but this is the "`$queryRaw` result assertion" the reviewer standards name. A
   `typeof === "string"` narrowing would remove the cast entirely.
6. `apps/auth-service/tests/rls.integration.test.ts:152` — the test named *"guards the whole
   suite"* does not guard anything; it is a peer test, and the suite runs on regardless of
   its result. The suite *does* fail loudly under a bypassing role (the zero-row assertions
   at `:178` and `:210` would fail), so the behaviour is right and only the name overpromises.
   Move the check into `beforeAll` and throw, or rename.
7. Pre-existing magic literals surviving the rewrite of `user.repository.ts`: `"FREE"` and
   `"UTC"` (`:269-270`), `"OWNER"` (`:281`), `"P2002"` (`:173`). Verified pre-existing —
   present at `b0f6921` (`git show b0f6921:...user.repository.ts` lines 151, 180-181, 193) —
   so **not counted against this change**, but the file was substantially rewritten and the
   constants gate is required. `AUTH_DATABASE` was added in this change and is the obvious
   home for `"P2002"`.
8. `apps/auth-service/tests/auth.integration.test.ts` — five bare `toBe(400)`. Verified
   pre-existing (5 occurrences at `b0f6921`, 5 now) and `AUTH_HTTP_STATUS` has no
   `BAD_REQUEST` member. Add `BAD_REQUEST: 400` at `src/constants.ts:26-31` and use it.

### NIT

`migration.sql:90`, `:104` — `SET search_path = pg_catalog, pg_temp` is exactly the pattern
the PostgreSQL documentation prescribes for `SECURITY DEFINER` (`pg_temp` last, so a
caller's temporary objects cannot shadow), and both bodies are fully schema-qualified
regardless. Correct as written; noted only because it looks alarming at a glance.

---

## What I verified, and how

**Live database** (`postgresql://postgres:postgres@localhost:5432/telemetry`, PG 16). See
*Database left as found* below.

- **Role attributes.** `pg_roles`: `telemetry_app` = `f/f/t` (super/bypassrls/canlogin),
  `telemetry_auth_definer` = `f/t/f`. No role memberships grant either to anything; as
  `telemetry_app`, `SET ROLE telemetry_auth_definer` → `ERROR: permission denied to set role`.
- **Definer privilege minimality.** `information_schema.role_table_grants`: the definer holds
  exactly `SELECT` on `"User"` and `"RefreshToken"`, plus `USAGE` on `public`. Nothing
  broader. Confirmed as claimed.
- **Function hardening.** `pg_proc`: both `prosecdef=t`, `provolatile=s` (STABLE),
  `proisstrict=t` (STRICT), `proconfig={"search_path=pg_catalog, pg_temp"}`, owner
  `telemetry_auth_definer`. `proacl` = `{telemetry_auth_definer=X/…, telemetry_app=X/…}` —
  **PUBLIC is absent**, so the `REVOKE` at `:120-121` is load-bearing and correctly ordered
  before the `GRANT`. Verified.
- **Both guards fail loudly under `NOBYPASSRLS`** — the specific claim I was asked to check
  myself. Ran §5 and §6 in isolation with the definer temporarily altered, transaction rolled
  back:
  - §5 → `ERROR: public.auth_resolve_tenant_by_email(text) must be SECURITY DEFINER and owned by a BYPASSRLS role, or it returns NULL silently.`
  - §6 → `ERROR: auth_resolve_tenant_by_email returned NULL with no tenant context; expected cf6a282f-…. The definer role cannot see past RLS.`
  Both genuine. The silent-NULL failure mode is caught. **Caveat:** the clamp at `:47-57`
  re-`ALTER`s the role to `BYPASSRLS` before §5 ever runs, so on the normal path §5 is
  unreachable — it only fires when the clamp cannot execute, in which case the `ALTER ROLE`
  itself raises first. Defence in depth, not the primary mechanism.
- **Idempotency.** Re-applied the full `migration.sql` via `psql`. Exit 0. Catalog state
  byte-identical before/after: same `proacl`, same owner, same `md5(prosrc)` for both
  functions, same role attributes, same row counts. The §6 probe rows are created and deleted
  inside one `DO` block, and a `RAISE` there rolls the whole block back, so a partial
  application leaves no debris. Confirmed as claimed.
- **`"User"` RLS now genuinely enforces for `telemetry_app`** — the point of S-7. Seeded two
  tenants as admin, then as `telemetry_app` with `app.tenant_id` = tenant B: 1 user visible,
  tenant A's user invisible. This is the objective, and it is met.
- **`"RefreshToken"` RLS is inert** — `pg_class`: `relrowsecurity=f`,
  `relforcerowsecurity=t`, zero policies. Live proof: as `telemetry_app` in tenant B's
  context, tenant A's `RefreshToken` row (id, userId, tokenHash) was fully readable. S-10 as
  filed is accurate. `"InvoiceLineItem"` has the identical shape.
- **The cross-tenant resolver leak** (HIGH-2) — reproduced live, output quoted above.
- **`BYPASSRLS` is avoidable** (HIGH-1) — reproduced live, output quoted above.
- **`ALTER FUNCTION ... OWNER TO` needs role membership** (MEDIUM-1) — reproduced live.
- **Migration is registered** — `_prisma_migrations` has `v1_5_auth_tenant_resolvers`,
  `applied_steps_count = 1`, applied via `prisma migrate deploy` (not by my psql re-run).

**Prisma / type layer**

- `AuthPrismaClient` (`user.repository.ts:133-136`) genuinely exposes only `$queryRaw` and
  `$transaction`. There is no model delegate on it, so `this.db.user.findFirst(...)` does not
  compile. I found **no** `eslint-disable`, `@ts-expect-error`, `@ts-ignore`, `as any`, or
  additional `as unknown` anywhere in `apps/auth-service/src` or `tests` — one grep over the
  whole diff and one over both trees, both clean. The single cast is at `:179`.
  **It does not hold at runtime** and the change does not claim it does: `this.db` is the
  real `PrismaClient` and `tx` inside `withTenantContext` is the real transaction client with
  every delegate on it. This is a compile-time guardrail. Accurate as documented at `:127-132`.
- Relation filters on `updateMany` / `update` — proven expressible (`.d.ts:13541`, `:13564`)
  and proven to emit a tenant predicate (SQL captured live). Basis for HIGH-3.

**Compile-time gate — actual output, all 13 packages**

| task | result |
|---|---|
| `pnpm build` | 13 successful / 13 · exit 0 |
| `pnpm typecheck` | 13 successful / 13 · exit 0 |
| `pnpm lint` | 13 successful / 13 · exit 0 · **0 errors, 14 warnings** |
| `pnpm test` | 13 successful / 13 · exit 0 |

Per-package tests: auth-service **151** (14 files), usage-service **179**, gateway **38**,
worker **19**, billing **18**, analytics **18**, shared-utils 18, shared-validation 15,
shared-types 7, shared-config 4, shared-logger 4, shared-tracing 2.
Every number the author claimed matches. auth-service is 127 → 151 (+24).

**Lint: the claimed 17 → 10 reduction is real, not a suppression.** All 10 remaining
warnings are `@typescript-eslint/no-misused-promises` in
`apps/auth-service/tests/auth.service.unit.test.ts` (lines 61, 86, 117, 144, 179, 204, 231,
262, 297, 323). That file is **not** in `git diff --name-only`, and `git log -1` puts its
last change at `d68e719` — before `b0f6921`. Pre-existing, proven. The 7 that disappeared
were in `user.repository.unit.test.ts`, removed by typing the mock (`MockDb`,
`SqlFragment`, and the `containing<T>()` helper at `:19`) rather than by suppressing.
usage-service's 4 warnings are likewise in an untouched file.

**Coverage.** Ran `pnpm --filter @telemetry/auth-service test:coverage` directly, since
`ci.yml` removed the `DATABASE_URL` override on that step. Exit 0.
All files **91.16 %** stmts / **86.45 %** branch / **94.64 %** funcs / **91.16 %** lines,
against thresholds of 80/75/80/80 in `vitest.config.mjs:25-30`. `src/constants.ts` 100 %,
`src/repositories` 94.93 %. Removing the override is safe.

**Test honesty — specifically hunted**

- **No short-circuits.** `git grep` over both integration suites: no `.skip`, no `return`
  guarded on an environment condition, no `isCurrentUserSuperuser`-style bail. The old S-3
  guards are gone and the inverted assertion is corrected
  (`rls.integration.test.ts:178-185` now expects **zero** rows, with a comment saying the old
  `>= 1` encoded the vulnerability as expected behaviour). The failure mode S-3 named is
  genuinely closed.
- **Helpers throw rather than pass vacuously.** `runRawQuery`
  (`user.repository.unit.test.ts:65-82`) throws `Unexpected raw query issued by
  UserRepository` on anything it does not recognise, so a renamed resolver or a dropped
  `set_config` surfaces as an error. `requireOnlyTenantContextValue` (`:84-92`) throws unless
  exactly one context statement was issued. Both correct.
- **The S-10 vacuity is genuinely closed.** `auth.integration.test.ts` logout test reads the
  rows back through the **admin** client and asserts
  `storedTokens.length > 0` *before* `every(t => t.revokedAt !== null)`. The length assertion
  is what stops it passing on an empty set. That is the right shape, and given
  `relrowsecurity=f` it is the only shape that proves anything.
- **The fixture-reset guard is real.** The test *"keeps the fixture reset scoped to this
  suite's own rows, and actually resets"* registers a user, asserts
  `count(email endsWith SUITE_EMAIL_DOMAIN) > 0`, calls `resetAuthState()`, then asserts
  `=== 0`. Both halves. A predicate that matched nothing would fail the first assertion. The
  author's claim checks out.
- **`rejects login for an unknown email with 401`** — the author is right that it passes
  unfixed; it passed before S-7 too. Its red counterpart is adequate and then some: every
  login-success path in the suite (`logs in successfully…`, `sets first registrant as
  OWNER`, `refreshes session token…`, `logs out…`) returns 401/500 without the resolvers,
  because that is exactly the S-7 symptom. The test's value is the narrower one its comment
  claims — that a NULL resolve degrades to 401 rather than surfacing as a 500 — and it does
  assert the full `{code, message}` body, not just the status.
- **No test asserts a mock's own return value.** The unit suite asserts call arguments
  (`toHaveBeenCalledWith`), recorded side effects (`tenantContextValues`,
  `resolverArguments`), and negative facts (`user.findFirst` **not** called and
  `tenantContextValues` empty when the tenant does not resolve, `:408-416`, `:489-498`).
  Those negative assertions are the strongest ones in the file.
- Gaps found: LOW-2 (token resolver lacks a behavioural test) and LOW-3 (`set_config`
  ordering unasserted at unit level).

**Correctness / regression**

- All five flows pass end-to-end against `telemetry_app`: register (incl. duplicate,
  case-insensitive duplicate), login (incl. wrong password, unknown email), refresh (incl.
  reuse-after-rotation, missing CSRF), logout (incl. denylisted access token, expired token).
- **Error contracts preserved.** Unknown email and wrong password both return
  `401 / CODE_INVALID_CREDENTIALS / INVALID_CREDENTIALS` — asserted as full bodies, not
  status alone. Duplicate registration still `409 / CODE_EMAIL_ALREADY_EXISTS`. Refresh reuse
  still `401 / CODE_REFRESH_TOKEN_INVALID`.
- **No new enumeration channel of practical significance.** `AuthService.login:82-84` still
  runs `compare()` against `AUTH_SECURITY.DUMMY_PASSWORD_HASH` on a miss, and
  `findUserForLogin:305-309` deliberately skips the second query rather than the bcrypt.
  bcrypt at 10-12 rounds is 50-300 ms; the saved round-trips are sub-millisecond on a local
  socket. *This one is reasoning, not measurement* — I did not run a timing harness. The
  mechanism is sound and the code comment is accurate.
- **`set_config(..., true)` is transaction-local everywhere.** Every call site goes through
  `withTenantContext` (`:204-214`), which issues it as the first statement inside
  `$transaction`. The two resolver calls (`:222`, `:236`) run outside any transaction and
  correctly need no context. No `set_config` with `is_local = false` anywhere in the diff.
- **Registration ordering is correct.** `tenantId` is generated client-side at `:261` and set
  as context before the `Tenant` insert, which is what `tenant_self_insert`
  (`"id" = current_setting('app.tenant_id', true)`) requires. Verified by the register test
  reading the row back through the admin connection.
- The predicates at `:313` (`email + tenantId`) and `:364` (`tokenHash + user.tenantId`) are
  tautological given that `email` is globally unique (`v1_1`) and `tokenHash` is unique — the
  resolved tenant can only be that row's tenant. Harmless defence in depth, correctly placed.
  Sites 6 and 7 are where a predicate would actually do work, and that is HIGH-3.

**Config / CI / docs**

- `ci.yml` — job-level `DATABASE_URL` is `telemetry_app`; both overrides removed cleanly;
  no dangling references to `AUTH_TEST_DATABASE_URL` anywhere outside a historical review
  doc. `RLS_PROBE_DATABASE_URL` is likewise fully removed — the only surviving mention is a
  comment in `rls.integration.test.ts:21` explaining why it is gone. Migration steps still
  precede every test step, so the documented ordering is enforced. Coverage verified above.
- `.env.example`, `tests/setup.ts`, `docker-compose.yml` — consistent, and the stale S-7
  warnings are gone rather than merely edited.
- `docker/postgres/init/01-app-role.sql` **not** mirroring v1_5: **the reasoning is sound.**
  The resolver bodies are `LANGUAGE sql`, which PostgreSQL parses at `CREATE` time, and no
  tables exist when a `docker-entrypoint-initdb.d` script runs — so the `CREATE FUNCTION`
  would fail outright, and creating only the role would leave an orphan. The consequence
  (auth's DB paths non-functional in compose) is genuinely pre-existing, since nothing in
  that stack runs migrations and the tables are absent too. Accept. *I did not bring up the
  compose stack to confirm the smoke suite still passes* — see below.
- `.claude/rules/known-gaps.md` — S-3 and S-7 correctly removed, S-10 correctly filed with
  live catalog evidence I independently reproduced. `.claude/rules/tenant-isolation.md`,
  `CLAUDE.md`, `base.repository.ts:50-58` all updated consistently. Documentation quality
  here is high.

**The `TenantScopedRepository` deviation (judged on merits, not on the author's framing)**

I accept it, with HIGH-3 as the caveat. The lifecycle argument is real and checkable:
`TenantScopedRepository` takes `tenantId` in its constructor, and `UserRepository` is a
default constructor argument of `AuthService` (`auth.service.ts:53`), instantiated once at
container-build time before any tenant exists. Extending the base class would require either
a per-request factory for a repository whose first job is to *discover* the tenant, or a
mutable `tenantId` field — worse than the deviation. `withTenantContext` issues the identical
`set_config(..., true)` as the first statement of the transaction.

On **site 7 (logout)**, which I was asked to judge independently: `tenantId` does cross a
method boundary from `AuthService.logout`, which is a weaker position than the other six
sites where the tenant is resolved in-repository. But it is not caller input in any
meaningful sense — `AuthenticatedRequestContext` is populated only by
`logout-auth.plugin.ts:57` from a `jwtVerify`-checked token signed with `JWT_SECRET`, and
`userId` and `tenantId` come from the *same* verified payload, so they cannot be mismatched
by an attacker. The rule's actual invariant ("the tenant id derives from verified context,
never from a caller-supplied value") holds. What does **not** hold at site 7 is the second
half of the rule — the explicit predicate — and that is HIGH-3, which is fixable and should
be fixed rather than argued away.

One inconsistency worth noting: `auth.service.ts:163-164` casts
`input.tenantId as TenantId` / `input.userId as UserId` because
`AuthenticatedRequestContext` (`plugins/index.ts:2-3`) types both as plain `string`. The
branded-type argument in the repository doc comment (`:200-201`) is therefore weaker at this
one call site than elsewhere — the brand is asserted, not carried. Narrowing
`AuthenticatedRequestContext` to `userId: UserId; tenantId: TenantId` would make the claim
true everywhere and costs two lines.

---

## What I could NOT verify, and why

1. **Behaviour on managed Postgres** (RDS / Cloud SQL / Neon). No such instance available. I
   verified the *mechanism* of the failure locally by simulating a non-superuser migration
   role, which is what produced MEDIUM-1, but the platform-specific role syntax
   (`rds_bypassrls` and equivalents) is untested.
2. **`pnpm test:smoke:compose`.** I did not bring up the Docker stack — building six images
   was out of proportion to the question. The author's claim that auth's DB paths were
   already non-functional in compose is consistent with the code I read (`app.ts:22`'s
   `/health` handler, and nothing in the stack running migrations), but it is inference,
   not execution.
3. **Timing-equivalence of the two-step login.** Argued from bcrypt cost dominating by ~2
   orders of magnitude, not measured. See "Correctness" above.
4. **Concurrent-registration race under the new transaction shape.** The `P2002` backstop at
   `:292-298` is unit-tested with a synthetic error, and `User_email_key` is a real unique
   index, so the mechanism is sound — but I did not run concurrent registrations against the
   live database.
5. **Behaviour when the resolvers are absent** (the deploy-order hazard the release note is
   built around). Dropping them from the live database to observe it was not a safe probe.
   The migration's §6 guard covers the inverse case, which I did test.

---

## Remaining risks and dispositions

| # | Risk | Disposition |
|---|---|---|
| 1 | Definer role holds `BYPASSRLS` where a policy would do, and the migration *mandates* it | **Fix (HIGH-1)** — or record the decision and stop asserting necessity |
| 2 | All six services can call the resolvers via shared `telemetry_app` | **Fix (HIGH-2)** — or file as a gap before S-10 lands |
| 3 | Sites 6/7 have no tenant predicate; `"RefreshToken"` RLS inert, so nothing else scopes them | **Fix (HIGH-3)** — the predicate is expressible; proven |
| 4 | Managed-Postgres recovery path fails at `ALTER FUNCTION ... OWNER TO` | **Fix (MEDIUM-1)** — one `GRANT` line in the release note |
| 5 | Two-step deploy: resolvers must exist before the connection flips | **Accept.** Release note is explicit and correct; CI enforces ordering; rollback lever 1 (repoint at admin) genuinely works — the new code paths are compatible with a superuser connection |
| 6 | `"RefreshToken"` / `"InvoiceLineItem"` cross-tenant readable by `telemetry_app` | **Accept for this change.** S-10 filed accurately and scoped out for good reason. Risk 3 makes it worse than the filing implies — note that in S-10 |
| 7 | Login/refresh round-trip cost | **Accept**, document (MEDIUM-3) |
| 8 | Compile-time-only client narrowing | **Accept.** Correct guardrail, honestly described; a cast can defeat it but every cast in the service is accounted for |

---

## Recommended for `.claude/rules/known-gaps.md`

1. **`.claude/rules/testing.md` contains a live inaccuracy** — confirmed. It states
   *"`*.integration.test.ts` … are excluded from the default vitest config and run via their
   own script and CI step."* They are not. `apps/auth-service/vitest.config.mjs:5` is
   `include: ["tests/**/*.test.ts"]`, and my `pnpm test` run executed
   `tests/auth.integration.test.ts` (17 tests) and `tests/rls.integration.test.ts` inside the
   default suite. Consequence: `pnpm test` requires a live Postgres for auth-service, which
   the rule tells a reader it does not. Fix the rule, or split the config to match it — but
   do not leave the two disagreeing.
2. **HIGH-2, if not fixed here** — `EXECUTE` on the pre-auth resolvers is held by the role
   shared by all six services; file with the live reproduction above and an explicit
   "close before S-10" note, since fixing S-10 converts it from redundant to load-bearing.
3. **HIGH-1, if deferred** — record that `BYPASSRLS` was chosen over a targeted policy, that
   it is not technically required, and that the guards currently clamp an operator's
   narrowed role back to bypassing.
4. **`AuthenticatedRequestContext` types `userId`/`tenantId` as plain `string`**
   (`plugins/index.ts:2-3`), forcing brand casts at `auth.service.ts:163-164`. Small, but it
   is the one place the branded-`TenantId` argument in
   `.claude/rules/tenant-isolation.md` is asserted rather than enforced.

---

## Database left as found

I probed the live instance. Everything is restored; verified by re-query at the end.

- **Read-only:** `pg_roles`, `pg_proc`, `pg_class`, `pg_policies`, `pg_auth_members`,
  `information_schema.role_table_grants`, `has_function_privilege`, `_prisma_migrations`;
  resolver calls as `telemetry_app`; a failed `SET ROLE`.
- **Rolled back (`BEGIN … ROLLBACK`, nothing committed):** the `NOBYPASSRLS`-definer +
  policy experiment (HIGH-1); both guard blocks run against a temporarily altered definer;
  the non-superuser `ALTER FUNCTION ... OWNER TO` experiment (MEDIUM-1). Post-check:
  `role_left=0, policy_left=0, fn_left=0`, and `telemetry_auth_definer` back to
  `rolbypassrls = t`.
- **Committed then reversed:** two probe tenants + two users + one refresh token, to
  demonstrate the cross-tenant leak (HIGH-2) and confirm S-10. All deleted; post-check
  `tenants=0, users=0, tokens=0`.
- **Re-ran `migration.sql` in full** (idempotency test). Catalog state byte-identical
  before/after — same ACLs, same owner, same `md5(prosrc)`, same role attributes. Applied via
  `psql`, so `_prisma_migrations` was not touched.
- **Final state:** `telemetry_app` `f/f/t`, `telemetry_auth_definer` `f/t/f`, both functions
  present with unchanged owner and ACL, all tables empty, zero stray `%probe%` objects.
- **Working tree:** unmodified apart from this review file. No source, test, migration or
  config file was edited.
