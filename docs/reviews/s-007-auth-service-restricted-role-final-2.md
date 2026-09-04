# Senior Reviewer — S-7 · auth-service onto a restricted DB role (Gate 6, round 3)

**Base** `b0f6921` · **Head** `6299845` · single unpushed commit on `main`, working tree clean.
Reviewer wrote neither the code nor either previous review.

**Verdict: CONDITIONAL.** No BLOCKER. The mechanism shipped here is sound and I verified the
security property it exists to establish, by execution, against a live PostgreSQL 16.13. What
holds the gate is the third instance of the pattern the previous two rounds each found: a
**false load-bearing claim in prose**, this time repeated in six places including two `.claude/rules/`
files, one of which caused a correct reviewer recommendation to be rejected and a gap (**S-11**)
to be filed as irreducible when it is reducible with one line. Two further prose claims are false,
one apply-time guard passes vacuously in the deployment the migration itself documents, and one
newly added validation branch has no test.

---

## Findings

### HIGH-1 · The `ALTER DEFAULT PRIVILEGES` claim is false; S-11 is filed on the strength of it

**`prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql:270-273`** ·
**`.claude/rules/known-gaps.md:121`, `:127-131`** ·
**`.claude/rules/tenant-isolation.md:106-108`** ·
**`docs/releases/s-007-auth-service-restricted-role.md:181-185`** ·
**`apps/auth-service/tests/rls.integration.test.ts:427-430`** ·
`docs/plans/s-007-auth-service-restricted-role.md` §15 MEDIUM-1 · and the commit message.

The claim, in the migration's own words:

> There is no way to make that safe by default. `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON
> FUNCTIONS FROM PUBLIC` looks like the mechanism and is not: on PostgreSQL 16.13, with or without
> `FOR ROLE`, and whether or not an explicit `pg_default_acl` row exists, a newly-created function
> still comes out with `proacl = NULL` and PUBLIC holding EXECUTE.

**Refuted by execution.** The claim is true only of the `IN SCHEMA` form that was tested. The
**database-scoped** form — the same statement with the `IN SCHEMA "public"` clause omitted — works.
All probes below ran in `BEGIN … ROLLBACK`; nothing was committed.

| Form | `pg_default_acl` row | new function `proacl` | `has_function_privilege('public', …)` |
|---|---|---|---|
| none (baseline) | – | `NULL` | **`t`** |
| `IN SCHEMA "public" REVOKE EXECUTE … FROM PUBLIC` | none created | `NULL` | **`t`** |
| `FOR ROLE postgres IN SCHEMA "public" REVOKE …` | none created | `NULL` | **`t`** |
| `IN SCHEMA <fresh schema> REVOKE …` | none created | `NULL` | **`t`** |
| grant-then-revoke, `IN SCHEMA "public"` | `{telemetry_auth_app=X/postgres}` | `{=X/…,postgres=X/…,telemetry_auth_app=X/…}` | **`t`** |
| **`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`** (no `IN SCHEMA`) | `{postgres=X/postgres}`, `defaclnamespace = 0` | `{postgres=X/postgres}` | **`f`** |

Verbatim, the case that matters, a `SECURITY DEFINER` function created in `public` afterwards:

```
 case                  |        proacl         | public_exec | sharedapp_exec
-----------------------+-----------------------+-------------+----------------
 G2 global-only secdef | {postgres=X/postgres} | f           | f
```

The mechanism is now characterised: a `pg_default_acl` row is **merged with** the built-in
`acldefault()` (which contains `=X` for PUBLIC), so a schema-scoped revoke can never subtract
`=X`; the database-scoped entry replaces it. The one real residual is that the default is
per-creating-role — verified: with the default set `FOR ROLE postgres`, a function created by a
different role still came out `proacl = NULL`, `public_exec = t`; setting it `FOR ROLE` that role
too fixed it (`{zz_creator=X/zz_creator}`, `public_exec = f`).

**Why this is HIGH rather than a doc nit.** It is not a stray sentence. It is (a) the stated
justification for rejecting the previous reviewer's recommendation, (b) the stated justification
for filing **S-11** as a gap mitigated only by a guard and a test rather than by a default, and
(c) written into two `.claude/rules/` files that `CLAUDE.md` designates authoritative and that
future agents are instructed to trust without re-verification. Round 1 was pulled up for a false
`BYPASSRLS` claim, round 2 for a false trust-boundary claim; this is the same failure at the same
severity.

**Fix.**
1. `migration.sql` — add, in section 6, before the resolvers' explicit `REVOKE`s:
   ```sql
   -- Database-scoped, not IN SCHEMA: a schema-scoped default ACL is merged with acldefault(),
   -- which contains `=X` for PUBLIC, so it can never subtract it. Verified on PG 16.13.
   ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
   ```
   Keep the explicit per-function `REVOKE`s (they still cover functions created by a different
   role) and keep both guards.
2. Rewrite S-11 (`known-gaps.md:121-143`) to state the true residual: *a database-scoped default is
   now in force for the migration role; a function created by any other role is still
   `PUBLIC`-executable, and the guard plus the standing test are what catch that.* Retitle
   accordingly — the current title ("no default privilege can prevent it") is the false part.
3. Correct `tenant-isolation.md:106-108`, the release note `:181-185`, and the test comment
   `rls.integration.test.ts:427-430`.

Disposition: **fix before commit.** Item 1 is optional if the team prefers not to widen the
migration's scope, but items 2–3 are not — a rule file must not assert something disproved.

---

### HIGH-2 · Three docs still assert the pre-narrowing privilege set, contradicting the same commit

**`CLAUDE.md:165-166`** — "a second least-privilege role **with the same table privileges as
`telemetry_app`**"
**`apps/auth-service/.env.example:16-17`** — "Both roles are NOSUPERUSER NOBYPASSRLS with
**identical table privileges**; only the function grant differs."
**`docs/development-setup.md:47-49`** — "**Same table privileges as `telemetry_app`**; the
difference is that it alone holds `EXECUTE` on the resolvers."

All three are false as of this revision, and each is contradicted inside the same commit:
`.claude/rules/tenant-isolation.md:101` ("`telemetry_auth_app` also holds **less** than
`telemetry_app`, not the same"), `migration.sql:208-212`, the release note `:37-41`. Verified live
from the role's own connection:

```
telemetry_auth_app: RefreshToken t/t/t/t · Tenant t/t/t/t · User t/t/t/t
                    Event f · ExportAudit f · Invoice f · InvoiceLineItem f
                    Meter f · MetricRollup f · UsageLine f · _prisma_migrations f
$ SELECT count(*) FROM "Event";  →  ERROR: permission denied for table Event
telemetry_app: granted on 10 tables
```

These are the leftovers of round 2's own MEDIUM-3: the migration, the release note, the rule file
and the tests were updated; `CLAUDE.md`, the service `.env.example` and the setup guide were not.

**This has an operational edge, not just an accuracy one.** The release note's managed-Postgres
path (`:122-135`) has an operator provisioning `telemetry_auth_app` by hand, and warns "grant those
three tables and no more. A `GRANT … ON ALL TABLES` will be rejected". An operator who reads
`development-setup.md` or `.env.example` first will believe the privileges are identical to
`telemetry_app`'s and grant accordingly — and per MEDIUM-1 below, the guard that is supposed to
reject that passes vacuously for exactly the role such an operator is likely to be using.

**Fix.** In all three places, replace with: *"a second least-privilege role, holding **less** than
`telemetry_app`: DML on `"Tenant"`, `"User"` and `"RefreshToken"` only, and no
`ALTER DEFAULT PRIVILEGES`, so a future table must be granted deliberately. It exists so that
`EXECUTE` on the two pre-auth resolvers can be granted to auth-service alone."*
`CLAUDE.md` is the one that matters most — it is the file agents read first.

Disposition: **fix before commit.**

---

### MEDIUM-1 · The section-7 table-grant guard passes vacuously for a non-superuser migration role

**`prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql:400-409`**

`information_schema.role_table_grants` exposes only rows whose grantor or grantee is a *currently
enabled role*. Planted an offending grant and read the guard's own query from two roles:

```
GRANT SELECT ON TABLE "Event" TO telemetry_auth_app;
as superuser (postgres)                  → guard_sees = 1   (would RAISE)
as non-superuser zz_migrator (CREATEROLE)→ guard_sees = 0   (passes silently)
```

That is precisely the migration's own documented deployment (`:36-41`: "If the migration role
cannot create roles, provision both roles out of band"; the release note `:117-120`: RDS, Cloud SQL,
Neon migration roles "usually have `CREATEROLE`"). The release note `:43-45` and `:103-109` make
this guard an explicit promise to the operator; on managed Postgres it is decorative.

Two narrower blind spots in the same predicate, both confirmed:
- **Column-level grants are invisible.** `GRANT SELECT ("id","tenantId") ON "Event" TO
  telemetry_auth_app` → guard_sees `0`, while `has_column_privilege(…,'tenantId','SELECT')` is
  `t` and `information_schema.column_privileges` shows 2 rows.
- **Role membership is invisible.** `GRANT telemetry_app TO telemetry_auth_app` → guard_sees `0`,
  while `has_table_privilege('telemetry_auth_app','"Event"','SELECT')` becomes `t` — DML on all
  ten tables including the RLS-inert `"InvoiceLineItem"`, the exact hole MEDIUM-3 closed.

**Mitigating facts, in fairness.** The file's own `REVOKE ALL ON ALL TABLES … FROM
telemetry_auth_app` (`:219`) converges *both* table-level and column-level grants before the guard
runs — I confirmed `has_column_privilege` returns `f` after a re-run with a column grant planted.
So the guard is a belt over already-fastened braces for the blanket case, and no hole opens. Its
unique value is detection, and that is what is lost. I also confirmed the *other* section-7 guards
are **not** affected: `has_function_privilege` and `pg_policies` both return correct answers from a
non-superuser role, so the `prosecdef` loop (S-11's apply-time mitigation) and the policy
assertions are genuinely effective for any migration role.

**Fix** — replace `:400-409` with catalog ACL queries, which I verified return the right answer as
`zz_migrator`:

```sql
IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v')
      AND a.grantee = 'telemetry_auth_app'::regrole
      AND c.relname NOT IN ('Tenant','User','RefreshToken')
) THEN RAISE EXCEPTION '…'; END IF;

IF EXISTS (
    SELECT 1 FROM pg_attribute at
    JOIN pg_class c ON c.oid = at.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(at.attacl) a
    WHERE n.nspname = 'public' AND a.grantee = 'telemetry_auth_app'::regrole
      AND c.relname NOT IN ('Tenant','User','RefreshToken')
) THEN RAISE EXCEPTION '…'; END IF;
```

Also soften the release note's `:43-45` / `:103-109` promise, or keep it and make the guard true.
Disposition: **fix before commit** (the query swap is three lines and verified).

---

### MEDIUM-2 · "Granting the definer to an application role makes the guard raise" is false for `telemetry_auth_app`

**`migration.sql:100-105`** · **`.claude/rules/tenant-isolation.md:96-99`** · commit message.

> That escalation path is caught rather than merely absent: `has_function_privilege` follows
> membership, so granting the definer to an application role makes the guard in section 7 raise.

True for `telemetry_app` — verified, `has_function_privilege('telemetry_app', resolver, 'EXECUTE')`
flips to `t` and section 7 raises. **False for `telemetry_auth_app`**, which is the application role
an operator debugging a resolver permission error would actually be tempted to grant it to. Section
7 only checks `public` and `telemetry_app`, and the grant guard sees nothing.

The consequence is a full cross-tenant read, verified by execution (seeded two tenants, `SET LOCAL
ROLE telemetry_auth_app`, all inside `BEGIN … ROLLBACK`):

```
1 baseline scoped         | telemetry_auth_app | count = 1     ← RLS enforcing
2 baseline no ctx         | telemetry_auth_app | count = 0     ← RLS enforcing
GRANT telemetry_auth_definer TO telemetry_auth_app;
3 definer-member, no ctx  | telemetry_auth_app | all_users_visible = 2
3b rows                   | a@x.invalid, b@x.invalid           ← both tenants
```

`user_auth_definer_read` is `USING (true)` and applies through membership, so auth-service's own
role reads every `"User"` row in the platform with no tenant context, and nothing raises.

**Fix.** Add to section 7:
```sql
IF EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
    WHERE r.rolname = 'telemetry_auth_definer'
) THEN
    RAISE EXCEPTION
      'A role is a member of telemetry_auth_definer; user_auth_definer_read is USING (true) and applies through membership, so that role reads every tenant''s "User" rows.';
END IF;
```
(Verified: returns 0 today, and the mechanism is the one demonstrated above. Note this would also
fire on the release note's deliberate `GRANT telemetry_auth_definer TO <migration_role>` at
`:134` — either exclude the current migration role, or move that grant's justification into the
exception message.)
Then correct the two prose claims to say "membership is the escalation path, it is **not**
detected for `telemetry_auth_app` today" or make it detected.

Disposition: **fix before commit** — a false "this is enforced" claim about a `USING (true)` policy
is the highest-consequence kind in this file.

---

### MEDIUM-3 · The newly added `AuthRole` validation has no test

**`apps/auth-service/src/plugins/jwt.plugin.ts:57-58, 65-67`** ·
**`apps/auth-service/tests/jwt.plugin.unit.test.ts`**

Confirmed two independent ways.

*Mutation.* Deleted the `if (!isAuthRole(payload.role))` block, ran the suite, restored the file
(`git checkout --`, verified byte-identical, tree clean):

```
tests/jwt.plugin.unit.test.ts   6 passed (6)
full auth suite                 Test Files 15 passed (15) · Tests 162 passed (162)
```

*Coverage.* The very report §15 cites shows it:

```
  jwt.plugin.ts    |   91.17 |    88.88 |     100 |   91.17 | 34-35,66-67,86-87
```

`66-67` is `throw new InvalidTokenError()` inside the new branch. This is the same evidence shape
round 2 used for its own HIGH-1 (the dead plugin at 0%), available in the same artifact.

`jwt.plugin.unit.test.ts` had 6 `it(` at `b0f6921` and has 6 at head — zero tests were added for
the change. Both sub-cases are untested: an unknown role value, and an absent `role` claim (the
"required claims are missing" test omits `tenantId` and passes `role: "OWNER"`, so it never reaches
this branch). The absent-role case was untested before the change too; the unknown-value case is
new logic with no test, which `.claude/rules/testing.md` ("Cover the success path **plus** at least
one negative path for every auth/validation branch") and the review standards ("all error paths
tested") both require.

`createAccessToken` at `jwt.plugin.unit.test.ts:30-38` types `role?: AuthRole`, so the test cannot
express the case without a cast — that is why it is missing.

**Fix.** Widen the helper to `role?: string` and add two cases:
```ts
it("throws InvalidTokenError for a signed token carrying an unknown role", async () => {
  const token = await createAccessToken(process.env.JWT_SECRET as string,
    { tenantId: "tenant_1", role: "SUPERADMIN", jti: "jti_1" }, "15m");
  await expect(requireJwtAuth(createRequest(`Bearer ${token}`), {} as FastifyReply))
    .rejects.toBeInstanceOf(InvalidTokenError);
});

it("throws InvalidTokenError when the role claim is absent", async () => { … });
```
Disposition: **fix before commit.**

---

### MEDIUM-4 · The `REVOKE`→`GRANT` window §15 MEDIUM-2 closed for policies is still open for grants

**`migration.sql:219-228`** · **`docs/releases/s-007-auth-service-restricted-role.md:63-66`**

§15 MEDIUM-2 replaced `DROP POLICY` + `CREATE POLICY` with a conditional create, on the explicit
reasoning that "the recovery path in `docs/releases/…` has an operator re-running this file by hand
through `psql`. A failure between the DROP and the CREATE would leave `"User"` without the policy,
at which point every resolver returns NULL and **every login returns 401** — silently."

Lines 219-228 are the identical shape:

```sql
REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM telemetry_auth_app;   -- :219
...
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Tenant" TO telemetry_auth_app;  -- :226
```

In `psql` autocommit — the mode the recovery path at `:64-65` prescribes without qualification —
a failure between them leaves auth-service with **no** table privileges: every auth path returns
500 `permission denied`. Loud rather than silent, but an outage either way, and the mitigation
already chosen elsewhere in the same file was not applied here.

**Fix** (either):
- Release note `:64-65`: prescribe the transaction —
  `psql "$DIRECT_DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql`
  and say why (the REVOKE/GRANT pair at `:219-228` is not idempotent *mid-pair*). Cheapest, and
  makes the whole file atomic including any future pair.
- Or move `:219-224` to *after* `:226-228` and narrow it to `REVOKE ALL ON ALL TABLES … ` followed
  by re-grant — which does not help — so prefer restricting the revoke to the complement set with
  a `DO` loop over `pg_class`.

Disposition: **fix before commit** (option 1 is a one-line doc change).

---

### MEDIUM-5 · `AUTH_ROLES` and `AUTH_TENANT_DEFAULTS.PLAN` duplicate Prisma's generated enums — clean-code gate, with a real consequence

**`apps/auth-service/src/constants.ts:83-95`**

`prisma/schema.prisma:47-51` and `:26-30` already define these, and Prisma generates them:

```
Role: {"OWNER":"OWNER","ADMIN":"ADMIN","MEMBER":"MEMBER"}
Plan: {"FREE":"FREE","PRO":"PRO","ENTERPRISE":"ENTERPRISE"}
```

`prisma/seed.ts:2` already imports `Role` and `Plan` from `@prisma/client`. `.claude/rules/constants.md`
is explicit: "DRY: a definition duplicated between `constants.ts`, a validator, and a repository is a
finding" and "before adding a third copy of a literal, promote it." §14 correctly removed seven
copies of the *union type*, but replaced them with a hand-maintained copy of the *database enum*
rather than the generated one.

This is not stylistic. Add `VIEWER` to `enum Role` in the schema and the new `isAuthRole` check
(MEDIUM-3) will **reject legitimate tokens** for that role, at the JWT boundary, with
`InvalidTokenError` — with nothing in the type system objecting, because `AUTH_ROLES` is
`as const` and self-consistent. `AUTH_TENANT_DEFAULTS` has the milder version: `PLAN: "FREE"` and
`TIMEZONE: "UTC"` restate `@default(FREE)` / `@default("UTC")`, and are passed explicitly, so the
schema default is dead.

**Fix** — keep the constants, add a zero-runtime-cost parity assertion that breaks the build if the
schema drifts:
```ts
import type { Plan, Role } from "@prisma/client";
// Fails to compile if the schema gains a Role/Plan the service does not know about.
const _roleParity: Record<Role, AuthRole> = AUTH_ROLES;
const _planParity: Record<AUTH_TENANT_DEFAULTS["PLAN"], Plan[keyof Plan]> = { FREE: "FREE" };
```
(`import type` only — `constants.ts` is not on `index.ts`'s pre-`initTracing` import path, verified,
so this does not affect the startup-ordering rule.)
Disposition: **fix before commit** for the `Role` assertion; `Plan`/`TIMEZONE` acceptable as-is if
the parity assertion covers `Role`.

---

### LOW-1 · `rls.integration.test.ts` header says "18 skipped"; the file has 20 tests

**`apps/auth-service/tests/rls.integration.test.ts:33-35`**

Round 2 added two tests to this file and did not update the note added for round 1's NIT. Verified:
`grep -c "^\s*it("` → 20, and pointing the suite at the wrong role prints `Tests 20 skipped (20)`.
The rest of the note is correct — verified `vitest exit code = 1` and the thrown message
`DATABASE_URL connects as telemetry_app; this suite must run as telemetry_auth_app, …`.
**Fix:** `18` → `20`, or drop the count. Disposition: fix; trivial.

### LOW-2 · `"OWNER"` remains a bare literal in three touched test files while `AUTH_ROLES` is importable

`apps/auth-service/tests/jwt.plugin.unit.test.ts:80, 93, 106, 125, 135` ·
`apps/auth-service/tests/auth.integration.test.ts:289, 608` ·
`apps/auth-service/tests/token.service.unit.test.ts:47, 57`

§15 LOW-6/LOW-7 claim "no copy of the union remains anywhere" — the *type* is gone, the *value*
is not. `.claude/rules/constants.md` applies to tests verbatim: "a literal `403` … in a test file is
a finding when the constant is already importable." `jwt.plugin.unit.test.ts:4` already imports from
`../src/constants`. (`tests/smoke.test.ts:14,35` `toBe(200)` is untouched by this commit — verified
pre-existing, not counted.) **Fix:** `AUTH_ROLES.OWNER`. Disposition: fix; mechanical.

### LOW-3 · `P2025` placed locally while `P2002` lives in `AUTH_DATABASE`

`apps/auth-service/tests/user.repository.integration.test.ts:27` vs
`apps/auth-service/src/constants.ts:76-78`. §15 LOW-13 settled the convention as "Prisma error
codes live in `AUTH_DATABASE`, even test-only ones"; this new one breaks it.
**Fix:** `AUTH_DATABASE.RECORD_NOT_FOUND_CODE`. Disposition: fix or state the reversal.

### LOW-4 · The standing grant test carries MEDIUM-1's blind spots

`apps/auth-service/tests/rls.integration.test.ts:232-243` uses the same
`information_schema.role_table_grants` predicate. It is *not* vacuous here — the connection under
test **is** `telemetry_auth_app`, so the grantee is a currently enabled role — but it is still blind
to a column-level grant (`app.event.findMany()` selects all columns, so the
`rejects.toThrow()` at `:245` still passes) and to role membership. Since this is the assertion that
runs on every `pnpm test`, it is where the durable check belongs.
**Fix:** add `has_column_privilege` and a `pg_auth_members` assertion alongside. Disposition: fix
with MEDIUM-1 and MEDIUM-2, or file.

### LOW-5 · "all six services" vs "five"

`migration.sql:32` and `:151` say `telemetry_app` is "shared by all six services", then enumerate
five. Every other mention in the commit says five —
`src/constants.ts:64`, `tests/database-urls.ts:19`, `rls.integration.test.ts:229`, release note `:40`,
`known-gaps.md:143`, `.env.example:12`, `development-setup.md:49`, `tenant-isolation.md:92`,
`01-app-role.sql:2`. **Fix:** five. Disposition: fix; cosmetic.

### LOW-6 · Merged 157-character line

`docs/development-setup.md:61` — "…`telemetry_auth_definer` is `NOLOGIN` and has none). Real
deployments provision the role out of band;". The new paragraph was appended without re-wrapping.
**Fix:** wrap. Disposition: fix; cosmetic.

### NIT-1 · `AccessJwtPayload` still shape-asserts the other four claims

`jwt.plugin.ts:15-21, 61`. The doc comment at `:53-55` correctly names
`jwtVerify<AccessJwtPayload>` a shape assertion, then fixes only `role`. `sub`/`tenantId`/`jti`/`exp`
are still truthiness-checked, so `exp: "abc"` reaches `expiresAt: number` and
`AuthService.logout`'s `Math.max(1, input.expiresAt - …)` yields `NaN` as a denylist TTL.
Pre-existing and unreachable without `JWT_SECRET`, but the comment now over-promises.
Disposition: accept, or type the interface `Record<string, unknown>` and validate all five.

### NIT-2 · The surviving `Event` catalog assertion

`rls.integration.test.ts:277-294`. It still *works* — verified `pg_class` and `pg_policies` are
readable from `telemetry_auth_app`, and the suite is green — and it still proves v1_0/v1_2 did not
regress on `Event`. But it is now the only `Event` reference in an auth suite, asserting catalog
state for a table auth-service cannot read, which `usage-service`'s
`rls.enforcement.integration.test.ts` already proves *behaviourally*. Harmless duplication.
Disposition: accept.

---

## Answers to the specific questions asked

**2 · The `ALTER DEFAULT PRIVILEGES` claim.** **Settled by execution: the claim is wrong in its
general form.** See HIGH-1. The `IN SCHEMA` variant you tested is indeed a no-op, and I reproduced
that four ways including materialising a `pg_default_acl` row first. The variant you did not try —
omitting `IN SCHEMA` entirely, which scopes the default to the database rather than a schema — does
work: `proacl = {postgres=X/postgres}`, `has_function_privilege('public', …) = f`,
`has_function_privilege('telemetry_app', …) = f`. So S-11 as filed is wrong: a real default *is*
available, and the mitigation is weaker than it needed to be. The residual after fixing it is
narrower and different (per-creating-role), and worth recording.

**3 · Does auth-service touch only the three tables?** Yes, on every path I could reach. Verified:
`grep` for every Prisma model access under `apps/auth-service/src` returns only
`tenant.create`, `user.create`, `user.findFirst`, `refreshToken.{create,findFirst,update,updateMany}`
plus two `$queryRaw` resolver calls and `$queryRaw` `set_config`. `AuthPrismaClient`
(`user.repository.ts:150-155`) exposes **no** model delegates on the root client, so an unscoped
`this.db.user.findFirst(...)` does not compile — a genuinely good design choice. `/health`
(`app.ts:23-30`) does not touch the database. `index.ts` only calls `$disconnect`. `base.repository.ts`
is exported but never instantiated in auth-service. `prisma/seed.ts:7` builds its own client on
`DIRECT_DATABASE_URL`, so its `meter.upsert` is unaffected. `_prisma_migrations` needs no grant —
`schema.prisma:8` sets `directUrl`, so migrate runs as the owner. And the whole suite, including 21
end-to-end register/login/refresh/logout tests, passes against `telemetry_auth_app`.
The grant guard, however, does not catch what it claims — see MEDIUM-1 (column grants, membership,
and vacuous for a non-superuser migration role, all three confirmed).

**4 · The plugin deletion.** Clean. `grep -rn "logout-auth\|requireLogoutAuth\|LogoutJwtPayload"`
across the whole repo returns only historical references in the two prior reviews, the superseded
`plan §838`, and the explanatory sentence at `plugins/index.ts:13`. No source, test, coverage-config
(`vitest.config.mjs` names no plugin files), or CI reference. `request.auth =` has exactly one
assignment site, `jwt.plugin.ts:114`. The replacement comment at `plugins/index.ts:4-15` is true of
this revision: `requireJwtAuth` is the only producer, and `/logout` is the only authenticated route
(`routes/index.ts:28`), so "the guard every authenticated route registers" holds. In scope: yes —
round 2's HIGH-1 was that this change's own new comment blessed the file, so removing it is
remediation, not creep.

**5 · The `AuthRole` validation.** No error-contract change: both branches throw
`InvalidTokenError`, same as the single combined check before it. The presence check was **not**
weakened — `isAuthRole(undefined)` is `false`, so an absent `role` still throws; I read the moved
condition line by line and confirmed the only behavioural delta is that a signed token with a role
outside `{OWNER,ADMIN,MEMBER}` is now rejected instead of accepted. `InvalidTokenError` is the right
response (it is what every other malformed-claim case returns). Only reachable route is `/logout`,
and no legitimate token can carry another role, so regression risk is nil. **The negative path is
not tested** — see MEDIUM-3.

**6 · `Event` → `Tenant` data assertions.** Equivalent, arguably stronger, not a weakening. The
three swapped assertions (`:199-225`) exercise `Tenant`'s four `tenant_self_*` policies through
auth-service's own connection — a table it owns the lifecycle of — where the `Event` versions
exercised a table auth-service can no longer reach and which `usage-service`'s
`rls.enforcement.integration.test.ts` already covers behaviourally. `User` assertions
(`:248-275`) were kept. The surviving `Event` *catalog* assertion still functions (verified
`pg_class`/`pg_policies` are readable from the restricted role) and still proves v1_0/v1_2 did not
regress, but it is duplicative — NIT-2.

**7 · `user.repository.integration.test.ts`.** Genuinely load-bearing; the best test in the change.
- Cannot pass vacuously: `readTokenRevokedAt` (`:50-52`) **throws** `Fixture refresh token … is
  missing` rather than returning, so a lost fixture is an error not a pass.
- `beforeEach` (`:84-94`) deletes then recreates by a suite-unique `tokenHash`, so the reset is
  both scoped and real; `afterAll` cleans by tenant and user id.
- Would it survive Prisma silently dropping the relation filter? **Yes — reproduced.** Removed both
  `user: { tenantId }` filters from `user.repository.ts:433-436, 459-463` and ran:
  ```
  × rejects and revokes nothing when the tenant does not own the token
      AssertionError: promise resolved "undefined" instead of rejecting
  × revokes nothing when the tenant does not own the user
      AssertionError: expected 2026-09-07T09:24:00.926Z to be null
  Test Files 1 failed (1) · Tests 2 failed | 2 passed (4)
  full auth suite: Tests 6 failed | 156 passed (162)
  ```
  §15 LOW-5's "Confirmed red — 2 of 4 fail" is exactly reproducible. File restored, tree clean.
- Worth knowing: the negative cases also pass on the *admin* connection (21/21 with
  `DATABASE_URL=postgres`), which confirms the relation filter is doing the work rather than RLS —
  which is the test's stated purpose.

**8 · The migration, re-derived.**
- **Idempotency:** verified by execution, not by reading. Ran the committed file verbatim inside
  `BEGIN … ROLLBACK` against the already-migrated database — completed, `MIGRATION RAN TO
  COMPLETION`. This mattered: `_prisma_migrations` records `applied_steps_count = 0` for `v1_5`
  (`migrate resolve --applied`), so Prisma had never actually executed the final revision here.
- **Fresh database:** created a scratch DB, `prisma migrate deploy` applied v1_0→v1_5 clean, and the
  resulting catalog was exactly right (both resolvers `SECURITY DEFINER`, owner
  `telemetry_auth_definer`, `proacl = {telemetry_auth_definer=X/…,telemetry_auth_app=X/…}`, grants
  on exactly `RefreshToken, Tenant, User`). Scratch DB dropped.
- **Convergence:** planted `GRANT SELECT ON "Event" TO telemetry_auth_app` and re-ran the file — it
  completed rather than raising, because `:219`'s `REVOKE ALL` removes the plant first. That is the
  "converge rather than merely not fail" behaviour §15 MEDIUM-3 describes, confirmed. It also
  converges *column* grants (`has_column_privilege` → `f` after re-run), which I did not expect.
- **Guards fire:** planted a new PUBLIC-executable `SECURITY DEFINER` function and re-ran →
  `ERROR: PUBLIC must not hold EXECUTE on SECURITY DEFINER function zz_future_resolver(text).`
  The mechanism-based loop works.
- **The `regprocedure` loop (`:380-395`):** no defect. `p.oid::regprocedure::text` round-trips
  correctly in every case I could construct — renders unqualified under the default
  `"$user", public` search_path and *qualified* under `SET search_path = pg_catalog`, and
  `has_function_privilege(text, text, text)` resolved both forms. Overloads render distinctly
  (`zz_ov(text)` / `zz_ov(integer)`) and quoted identifiers survive (`"zz Weird Name"(text)`).
  `FOREACH … IN ARRAY` at `:297` and `FOR <scalar> IN SELECT` at `:380` are both valid PL/pgSQL and
  both executed.
- **Unreachable guard:** `:79-92` (definer attributes) is still unreachable after `:65-75` clamps
  them — §15 LOW-1 keeps it on the previous reviewer's advice; I agree, it costs nothing and
  documents the invariant.
- **Conditional `CREATE POLICY` blocks (`:117-147`):** correct, and the exact-set assertions at
  `:356-374` match the live catalog (`User`: `user_auth_definer_read`, `user_tenant_isolation`;
  `RefreshToken`: `refreshtoken_auth_definer_read` only).
- **Mid-file failure breaking login:** the policy window is closed, but the grant window at
  `:219-228` is open in the hand-re-run path — MEDIUM-4.
- **Stale cross-references after renumbering:** none. `:47`→section 3 ✓, `:104`→section 7 ✓,
  release note `:63`→sections 7 and 8 ✓, `known-gaps.md:136`→section 7 ✓. Only LOW-5's "six
  services" is off, and that is not a section reference.

**9 · Docs truth.** Three false load-bearing claims found: HIGH-1 (six places), HIGH-2 (three
places), MEDIUM-2 (two places plus the commit message). Everything else I checked is true of this
revision:
- `.claude/rules/testing.md:24-31` — verified. Five `vitest.config.mjs` files exist, all
  `include: ["tests/**/*.test.ts"]`, and every `exclude` is under `coverage`, not `test`. Integration
  suites do run in `pnpm test`. Also verified turbo's strict env mode: a shell
  `DATABASE_URL=<telemetry_app>` did **not** reach the test task (`turbo.json` declares no `env`
  for `test`), and auth's suite still ran as `telemetry_auth_app` — 162/162.
- `.claude/rules/known-gaps.md` S-10 — live catalog matches word for word:
  `RefreshToken relrowsecurity=f, relforcerowsecurity=t`, sole policy
  `refreshtoken_auth_definer_read`; `InvoiceLineItem f/t` with none.
- `.claude/rules/known-gaps.md` S-12 — `.prettierrc` has `tabWidth: 2` and no `useTabs`;
  `pnpm format:check` → "Code style issues found in **250** files", no format step in `ci.yml`.
- `.claude/agents/senior-reviewer.md:44-50` — S-3 is indeed absent from `known-gaps.md` and the
  `beforeAll` throw is present as described.
- `docs/releases/…:111` "Apply Prisma Migrations runs before every test step" — verified,
  `ci.yml:78` precedes `:90`, `:108`, `:113`.
- `docs/releases/…:149-152` rollback lever 1 ("the new code paths are strictly compatible with a
  superuser connection") — verified by running the two integration suites with
  `DATABASE_URL=postgresql://postgres:…`: 21/21 pass.
- `base.repository.ts:48-60` — "Five services connect as `telemetry_app`" ✓;
  the `UserRepository` note ✓.
- `rls.integration.test.ts:229` "telemetry_app holds DML on all ten tables" — exactly 10, verified.
- `auth.integration.test.ts:492-501` — the S-10 non-tautological admin read-back is preserved.
- `.env.example` (root), `01-app-role.sql`, `docker-compose.yml`, `ci.yml` — consistent; no stale
  `AUTH_TEST_DATABASE_URL` outside historical reviews and the superseded plan §§1-13;
  `${{ env.AUTH_DATABASE_URL }}` at `ci.yml:98` is valid in a step-level `env:`.

**10 · Scope of the round-2 additions.** All defensible; none is creep.
- *Plugin deletion* — in scope: round 2's HIGH-1 was that this change's own comment blessed the
  file. Deleting beats commenting around it.
- *Role validation* — round 2's LOW-4, and one line given `AUTH_ROLES` now exists. Correct call.
  But shipping new validation with no test (MEDIUM-3) is the cost of folding it in.
- *`Event` → `Tenant` swap* — forced by MEDIUM-3's narrowing, and an improvement.
- *New integration test file* — the strongest addition; round 2's LOW-5 asked for exactly this and
  it is genuinely load-bearing.
- *S-12* — correctly filed rather than fixed; reformatting 250 files inside a security change would
  have been the creep.

---

## Compile-time gate — actual output, all 13 packages

Task-scoped (`@telemetry/auth-service`): `typecheck` clean · `build` clean · `lint` 0 errors,
10 warnings · `test` **162 passed (162)** across 15 files · `test:coverage` **95.28 %** statements,
86.87 branches, 96.49 functions.

Full workspace:

```
pnpm build      → Tasks: 13 successful, 13 total
pnpm typecheck  → Tasks: 13 successful, 13 total
pnpm lint       → Tasks: 13 successful, 13 total   (0 errors, 14 warnings)
pnpm test       → Tasks: 13 successful, 13 total
```

Per-package test totals: auth-service 162/162 (15 files) · usage-service 179/179 (17) · gateway
38/38 (8) · worker-service 19/19 (4) · billing-service 18/18 (4) · analytics-service 18/18 (4) ·
shared-utils 18/18 · shared-validation 15/15 · shared-types 7/7 · shared-config 4/4 ·
shared-logger 4/4 · shared-tracing 2/2 · remaining package has no test suite (turbo counts it
successful).

**All 14 lint warnings are pre-existing and proven so:**
- `apps/auth-service/tests/auth.service.unit.test.ts` (10 × `no-misused-promises`) — not in
  `git diff b0f6921..6299845 --name-only`; `git log -1` → `d68e719`, an ancestor of `b0f6921`.
- `apps/usage-service/tests/ingestion.service.unit.test.ts` (4 × `no-unsafe-assignment`) — no
  usage-service file appears in the commit; `git log -1` → `b0f6921`, the base.

**No new warning was introduced.** `pnpm format:check` fails repo-wide (250 files) — pre-existing,
filed as S-12, no CI step; verified against the base as well.

Every number in the commit message checked out: 13/13 four ways, 162/162 across 15 files,
95.28 % statements, 14 pre-existing warnings, and `127 → 162` / "40 added, 5 removed" (counted
`it(`/`test(` declarations at both revisions: 127 and 162 including `tests/config/`).

---

## What I verified by execution

Database probes were read-only or wrapped in `BEGIN … ROLLBACK`; the two that had to commit
(`GRANT`/`REVOKE` of a role membership, and the scratch database) were reversed and re-verified.
**The database is byte-identical to how I found it** — re-checked `pg_roles`, `pg_proc.proacl`,
`pg_default_acl`, `pg_auth_members` (0 telemetry memberships), `pg_class.relacl` for `Event`,
`pg_policies`, row counts (0/0/0), and `pg_database`. The one pre-existing
`prisma_migrate_shadow_db_*` database has a directory mtime of 2026-06-29 and is not mine.

- Refuted HIGH-1 across six ALTER DEFAULT PRIVILEGES variants plus a `FOR ROLE`/creating-role matrix.
- RLS **is** enforcing for `telemetry_auth_app`: 1 row with tenant context, 0 without, on `"User"`.
- Full cross-tenant read via definer membership (MEDIUM-2), and that no guard fires.
- The section-7 grant guard's vacuous pass as a non-superuser, and that the *function* and *policy*
  guards are **not** affected.
- That the recommended replacement guards (`pg_class`/`aclexplode`, `pg_attribute`,
  `pg_auth_members`) return correct answers as a non-superuser.
- The committed migration file, re-applied and applied to a fresh database via `migrate deploy`.
- That the guards raise for a planted PUBLIC-executable `SECURITY DEFINER` function.
- `regprocedure` round-tripping under two search_paths, with overloads and quoted identifiers.
- Both mutation tests: relation filters removed → 6 failures (2 in the new integration file);
  role validation removed → **162/162 still green**.
- The `beforeAll` guard: wrong role → thrown message, `Tests 20 skipped (20)`, **exit code 1**.
- Turbo strict env stripping a shell `DATABASE_URL`.
- Rollback lever 1 (admin connection): 21/21.
- Index coverage for every new query path: `User_email_key`, `User_tenantId_idx`,
  `RefreshToken_tokenHash_key`, `RefreshToken_userId_idx`, both PKs — nothing missing.
- Commit hygiene: plan, both reviews and the release note are in the commit; no `.env`, `dist/`
  or `coverage/`.

## What I could not verify, and why

- **Managed PostgreSQL (RDS / Cloud SQL / Neon).** No such instance available. The claim that the
  migration applies with only `CREATEROLE` is *reasoned* from the statements used — I confirmed
  `CREATE ROLE … BYPASSRLS` is gone and simulated a `LOGIN CREATEROLE` non-superuser for the
  information_schema visibility test, but not a full apply as that role. MEDIUM-1 is the finding
  that follows from this being unverifiable in-house.
- **The two-step deploy and the checksum-refusal recovery path** (release note `:52-69`) — needs an
  environment that applied an earlier revision of `v1_5`. Reasoned only.
- **CI itself.** `ci.yml` was read and its step ordering verified statically; the workflow was not
  executed. `${{ env.AUTH_DATABASE_URL }}` in a step-level `env:` is per GitHub's documented
  contexts, not observed.
- **`docker compose` stack.** `test:smoke:compose` and `01-app-role.sql` on a fresh volume were not
  run; the init script was read and its stated limitation (no resolvers, no tables) is consistent
  with the compose file.
- **Concurrency.** No test covers two simultaneous registrations racing the duplicate-email
  pre-check; the `P2002` backstop is unit-tested with a mocked rejection only. Pre-existing.
- **`prisma/seed.ts`** references a `tenantId_email` compound unique that `schema.prisma:37` does
  not define (`email` is globally `@unique`). Untouched by this commit and not on any auth runtime
  path, so out of scope here — but it means the seed script is probably broken, and it is worth a
  separate look.

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| HIGH-1 · S-11 filed on a false premise; a real default privilege exists | **Fix** — correct S-11 and the five other copies; adding the database-scoped statement is recommended but optional |
| HIGH-2 · `CLAUDE.md` + two docs assert the pre-narrowing privilege set | **Fix** — three sentences |
| MEDIUM-1 · grant guard vacuous for a non-superuser migration role | **Fix** — swap to `pg_class`/`pg_attribute` (verified), soften the release note's promise |
| MEDIUM-2 · definer-membership escalation claimed enforced, is not | **Fix** — add the `pg_auth_members` guard and correct the prose |
| MEDIUM-3 · new role validation untested | **Fix** — two `it(` blocks |
| MEDIUM-4 · `REVOKE`→`GRANT` window in the hand-re-run path | **Fix** — prescribe `--single-transaction` |
| MEDIUM-5 · `AUTH_ROLES` duplicates the generated `Role` enum | **Fix** — one type-level parity assertion |
| LOW-1…LOW-6 | Fix; all mechanical |
| NIT-1, NIT-2 | Accept |
| S-10 · `"RefreshToken"` RLS never `ENABLE`d | Accept as filed. Correctly out of scope, and `v1_5` pre-creates the policy its closure needs. The relation filters are the only tenant control until then, and they are now proven load-bearing |
| S-12 · `format:check` | Accept as filed |

## Recommended additions to `.claude/rules/known-gaps.md`

1. **Rewrite S-11** per HIGH-1. As written it will stop the next engineer from applying a fix that
   works.
2. **New gap — the definer's `USING (true)` policies are reachable by role membership and
   undetected for `telemetry_auth_app`.** File this if MEDIUM-2's guard is not added in this commit.
   It is the only path by which auth-service's own role can read every tenant's users, and the
   platform currently documents it as enforced.
3. **New gap — `prisma/seed.ts` references a non-existent `tenantId_email` compound unique.** Out of
   scope for a DB-role change; should not evaporate.

---

## Gate

**CONDITIONAL.**

The engineering here is good and the security property is real: I confirmed by execution that RLS
now enforces for auth-service, that the definer resolves a tenant without `BYPASSRLS`, that the
shared role cannot call the resolvers, that the role is narrowed to three tables, that the relation
filters do real work, and that the migration applies clean to a fresh database. Round 2's four
MEDIUMs and its HIGH are genuinely fixed, and I reproduced its "confirmed red" claim for the
relation filters exactly.

What blocks approval is that the pattern the previous two rounds each caught recurred a third time,
and this instance is the most consequential of the three: a disproved-by-execution claim about
PostgreSQL semantics, written into two authoritative rule files, used to reject a correct
recommendation and to file a gap as irreducible. Fix HIGH-1, HIGH-2 and MEDIUM-1 through MEDIUM-5,
sweep LOW-1 through LOW-6, and this is ready — the code needs almost nothing; the prose needs to
stop claiming more than the code does.

Re-review needed on the prose and guard changes only. → **Gate 3.**
