# S-7 — Move auth-service onto the restricted `telemetry_app` DB role

Task: **S-7** (`.claude/rules/known-gaps.md`) · Planner gate (Gate 1 of `/ship`)
Base: `main` @ `b0f6921` · Plan author: task-planner (read-only; no source touched)

---

## Approval gate

**Stopped for approval. No production code or tests were written.**

Implementation will be carried out by a **separate `task-implementer` agent** and reviewed by a
**separate `senior-reviewer` agent** (pre-QA and final). This plan is not self-reviewed and not
self-implemented.

Nine decisions are listed in §9 and must be answered before Gate 3 starts. Two of them (D-2
ownership of the `SECURITY DEFINER` functions, and D-9 who may `EXECUTE` them) change the
security posture and cannot be deferred to implementation.

---

## 1. Business context

Every service except auth-service connects as `telemetry_app`
(`NOSUPERUSER NOBYPASSRLS`, owns no table), which is the only thing that makes the PostgreSQL
RLS policies in `v1_0`/`v1_2` actually enforce. auth-service still connects as `postgres` — a
superuser — so for the one service that owns the `"User"` and `"Tenant"` tables' entire
lifecycle, the database layer is inert and the app-layer `tenantId` predicate is the *only*
protection.

**User impact if this regresses: nobody can log in or register.** This is the single highest
blast-radius change in the platform. §8 states what makes it safe to land.

**Objective:** auth-service runs as `telemetry_app` with register / login / refresh / logout
all working, and cross-tenant reads of `"User"` blocked by the database rather than by
application code alone.

---

## 2. The gap, re-verified against the code and a live database

All findings below were reproduced on the local PostgreSQL 16.13 instance at
`127.0.0.1:5432/telemetry`, which has all five migrations applied
(`v1_0` … `v1_4`, latest `2026-08-31 15:19:28+05:30`) and both roles present:

```
rolname        | rolsuper | rolbypassrls | rolcanlogin
postgres       | t        | t            | t
telemetry_app  | f        | f            | t
```

### 2.1 The failure baseline is exactly as recorded

```
$ DATABASE_URL=postgresql://telemetry_app:…@localhost:5432/telemetry \
  AUTH_TEST_DATABASE_URL=postgresql://telemetry_app:…@localhost:5432/telemetry \
  DIRECT_DATABASE_URL=postgresql://postgres:…@localhost:5432/telemetry \
  pnpm --filter @telemetry/auth-service exec vitest run tests/auth.integration.test.ts

  Tests  9 failed | 6 passed (15)
```

Registration returns `500`; every test that needs a registered user cascades. The 6 that pass
are the pure Zod-validation `400` cases, which never reach the database. This is the number
S-7 records, and it is still the number today.

### 2.2 Which tables have RLS actually enabled

Live `pg_class` on the running database:

| table | `relrowsecurity` | `relforcerowsecurity` | policy present |
|---|---|---|---|
| `Tenant` | **t** | t | 4 (`tenant_self_select/insert/update/delete`) |
| `User` | **t** | t | `user_tenant_isolation` |
| `RefreshToken` | **f** | t | **none** |
| `Event`, `UsageLine`, `Meter`, `Invoice`, `MetricRollup`, `ExportAudit` | t | t | yes |
| `InvoiceLineItem` | **f** | t | none |

**The S-2 reviewer's note is confirmed.** `v1_0_initial_tenant_usage_rls/migration.sql` omits
`"RefreshToken"` (and `"InvoiceLineItem"`) from its `ENABLE ROW LEVEL SECURITY` block and
never writes a policy for it; `v1_2_force_row_level_security` then `FORCE`s it. `FORCE`
without `ENABLE` is a no-op — `relrowsecurity` is `false`, so no policy is consulted and there
is no policy to consult anyway.

**Consequence for this task, which cuts both ways:**

- *It helps.* `storeRefreshToken`, `rotateRefreshToken` and `revokeActiveRefreshTokens` all
  work unchanged as `telemetry_app`. Verified: `INSERT` into `"RefreshToken"` with no tenant
  context succeeded, and `UPDATE "RefreshToken" SET "revokedAt" = now() WHERE "userId" = …`
  with no tenant context reported `UPDATE 1`.
- *It is a hole.* `"RefreshToken"` is readable and writable across every tenant by any holder
  of the `telemetry_app` credential. It is not in scope here (§3) and is filed as a new gap.

### 2.3 The three pre-tenant paths (the brief named two)

Probes as `telemetry_app`, no tenant context set:

```sql
SELECT count(*) FROM "User" WHERE email='…';                              -- 0   (login, dup-check)
SELECT id,"userId" FROM "RefreshToken" WHERE "tokenHash"='hash1';         -- 1 row (fine)
SELECT rt.id,u.id,u."tenantId" FROM "RefreshToken" rt
  JOIN "User" u ON u.id=rt."userId" WHERE rt."tokenHash"='hash1';         -- 0   (refresh)
UPDATE "RefreshToken" SET "revokedAt"=now() WHERE "userId"='…';           -- UPDATE 1 (logout OK)
SELECT count(*) FROM "Tenant" WHERE id='…';                              -- 0
```

So **refresh is a third pre-tenant path**, not a footnote to login. The `"RefreshToken"` row
itself is reachable, but the joined `"User"` row — which is where `tenantId` and `role` live —
is not. The refresh token is *not* a JWT (`token.service.ts:52`,
`randomBytes(32).toString("hex")`), so the tenant cannot be recovered from the token itself.
`known-gaps.md` already lists this under "Fix direction" as one of "the three pre-tenant
lookups"; the brief's framing of "two root causes" undercounts it.

**Logout is safe.** `AuthService.logout` (`auth.service.ts:152`) denylists the `jti` in Redis
and calls `revokeActiveRefreshTokens(userId)`, which only touches `"RefreshToken"`. It works
today on the restricted role. It should still be wrapped (§4, D-5) so it does not silently
become a no-op the day `"RefreshToken"` gets RLS.

---

## 3. Verdict on the three preliminary claims

### Claim 1 — "Registration may need no migration at all" · **CONFIRMED**

`tenant_self_insert` is at
`prisma/migrations/v1_0_initial_tenant_usage_rls/migration.sql:173`, exactly as quoted, and
checks `"id"` — not a `tenantId` column. `Tenant.id` is `String @default(uuid())` in
`prisma/schema.prisma:12`, and the generated DDL is a bare `"id" TEXT NOT NULL` with **no SQL
default** — Prisma Client generates the UUID client-side today, so moving generation one step
earlier costs nothing.

Verified end-to-end as `telemetry_app`, one transaction, no migration, no bypass:

```sql
BEGIN;
SELECT set_config('app.tenant_id','1111…','true');
INSERT INTO "Tenant"(…)       VALUES ('1111…', …);   -- INSERT 0 1
INSERT INTO "User"(…)         VALUES (…,'1111…', …); -- INSERT 0 1
INSERT INTO "RefreshToken"(…) VALUES (…);            -- INSERT 0 1
COMMIT;
```

The `User` insert satisfies `user_tenant_isolation`'s `WITH CHECK` because the context is
already set. The `User_tenantId_fkey` referential check is not a problem: the parent row is
visible in the same transaction, and PostgreSQL runs RI checks outside row security regardless.

Two consequences the brief did not anticipate:

1. **The duplicate-email pre-check at `user.repository.ts:166` becomes a silent no-op.**
   `this.db.user.findFirst({ where: { email } })` returns `null` for every e-mail under RLS.
   Registration would still reject duplicates — the `User_email_key` unique index is a
   referential-integrity check and fires regardless of RLS, producing `P2002`, which
   `isUniqueConstraintError` already catches at `user.repository.ts:196` and turns into
   `null` → `EmailAlreadyExistsError` → `409`. So the tests would stay green while a
   deliberate check quietly stopped checking. That is precisely the class of defect S-3
   existed to punish. It must be fixed, not left to pass by accident.
2. Registration therefore still needs *one* thing beyond the transaction: a working
   pre-tenant e-mail lookup. That is the same function login needs (D-8).

### Claim 2 — "Login needs one narrow `SECURITY DEFINER` function" · **CONFIRMED, with a correction that matters**

The premise holds: `prisma/migrations/v1_1_user_email_global_unique/migration.sql` replaces
the composite index with `CREATE UNIQUE INDEX "User_email_key" ON "User"("email")`, so
e-mail → `tenantId` is a single-row, index-backed lookup.

**The correction: it is not enough for the function to be owned by the table owner.** Because
`v1_2` sets `FORCE ROW LEVEL SECURITY` on `"User"`, the owner is subject to its own policies.
A `SECURITY DEFINER` function only sees the rows if its owner is a **superuser or holds
`BYPASSRLS`**. Proved on the live database with two otherwise identical functions:

| function | owner | result calling as `telemetry_app` |
|---|---|---|
| `s7_probe_a` | `postgres` (superuser) | `11111111-…` ✅ |
| `s7_probe_b` | `NOSUPERUSER NOBYPASSRLS` role with `SELECT` on `"User"` | **`NULL`** ❌ |
| `s7_probe_c` | `NOSUPERUSER BYPASSRLS NOLOGIN` role with `SELECT` on `"User"` | `11111111-…` ✅ |

`s7_probe_b` returns `NULL` **silently** — no error. Getting the ownership wrong reproduces
S-7's exact failure mode (login says "no such user") from inside the fix. This is the sharpest
edge in the task and the reason D-2 is a gate decision.

All probe objects (`s7_probe_a`..`d`, roles `s7_probe_definer` / `s7_probe_bypass`) and the
probe rows were dropped; the database was left as found (verified: zero matching `pg_proc`,
`pg_roles`, `Tenant` rows).

Assessment of the three sub-questions asked:

- **Is the two-step read acceptable?** It takes login from 1 round trip to 4
  (`BEGIN` → `set_config(… resolver(email) …)` → scoped `SELECT` → `COMMIT`). Login is not a
  per-request hot path — it happens once per session and is already dominated by
  `bcrypt.compare` at `BCRYPT_ROUNDS` 10–12, which is tens of milliseconds. Three extra
  sub-millisecond round trips on a local socket are noise against that. Accept it; but see
  D-3 for the one-step alternative and what it costs.
- **Does returning the tenant id alone leak anything?** It is an e-mail-existence oracle
  *for holders of the database credential*, not for HTTP clients — the login endpoint's
  response is unchanged and still runs `bcrypt.compare` against
  `AUTH_SECURITY.DUMMY_PASSWORD_HASH` on the miss path (`auth.service.ts:81`), so the
  external timing/response profile is untouched. The real widening is that
  `telemetry_app` is shared by **all six services**, so a compromised
  analytics-service could enumerate `email → tenantId`. That is D-9, and it is a genuine
  decision, not a formality.
- **Is `SECURITY DEFINER` correctly hardened?** The proposed and verified form is
  `LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp`,
  fully schema-qualifying `public."User"` in the body, `text` argument, `text` return,
  `REVOKE ALL … FROM PUBLIC` then `GRANT EXECUTE … TO telemetry_app`. `STRICT` means a
  `NULL` argument short-circuits without touching the table. Note that `v1_4` grants default
  privileges on *tables and sequences only* — PostgreSQL still grants `EXECUTE` on new
  functions to `PUBLIC` by default, so the `REVOKE` is load-bearing, not decorative.

### Claim 3 — "The blast radius is one file" · **CONFIRMED for production code; the count of 7 is exact; but one premise is wrong**

`grep -n "this\.db\."` on `apps/auth-service/src/repositories/user.repository.ts` returns
exactly seven sites. No other file in `apps/auth-service/src` reaches the database: the only
other `prisma` references are the singleton definition (`src/lib/prisma.ts`), the DI container
holding it (`src/config/container.ts:41`), and `container.prisma.$disconnect()` in the
shutdown hook (`src/index.ts:31`). `TokenDenylistService` is Redis-only.

**The wrong premise:** `UserRepository` does **not** extend `TenantScopedRepository`, so
`withTenant()` is not "a wrapper auth-service already has" in any callable sense. It is a
`protected` method on an abstract class (`base.repository.ts:94`) whose constructor takes
`tenantId` as a required argument — deliberately, because tenant-scoped repositories are
per-request by construction. `UserRepository` is constructed **before** a tenant is known
(`auth.service.ts:53`, a default constructor argument) and is a de-facto singleton. It cannot
extend `TenantScopedRepository` without inverting its lifecycle. See D-7.

#### The seven call sites

| # | `file:line` | call | classification |
|---|---|---|---|
| 1 | `user.repository.ts:166` | `this.db.user.findFirst({ where: { email } })` — duplicate-email pre-check | **pre-tenant** → replace with the e-mail resolver (D-8). Silently returns `null` under RLS. |
| 2 | `user.repository.ts:176` | `this.db.$transaction` — registration (`tx.tenant.create` :177, `tx.user.create` :186) | **pre-tenant, but self-solving** → generate the tenant UUID app-side, `set_config` as the first statement in the transaction, pass `id` explicitly to `tenant.create`. No migration. |
| 3 | `user.repository.ts:216` | `this.db.user.findUnique({ where: { email } })` — `findUserForLogin` | **pre-tenant** → resolver returns `tenantId`; then `set_config`; then the scoped read for `id`/`passwordHash`/`role`. |
| 4 | `user.repository.ts:243` | `this.db.refreshToken.create` — `storeRefreshToken` | **wrappable.** Tenant is known at the call site (`auth.service.ts:96`) but is not currently passed; the signature must gain `tenantId`. Works unwrapped today only because `"RefreshToken"` has no RLS. |
| 5 | `user.repository.ts:253` | `this.db.refreshToken.findUnique` with the `user` relation — `findRefreshTokenForRotation` | **pre-tenant** (third case) → token-hash resolver returns `tenantId`; then `set_config`; then the scoped read. |
| 6 | `user.repository.ts:289` | `this.db.$transaction` — `rotateRefreshToken` (`update` :290, `create` :296) | **wrappable.** Tenant known from #5; signature must gain `tenantId`. |
| 7 | `user.repository.ts:307` | `this.db.refreshToken.updateMany` — `revokeActiveRefreshTokens` | **wrappable.** Tenant is in the verified JWT (`AuthenticatedRequestContext.tenantId`, `plugins/index.ts`) and is available at `auth.service.ts:155`; signature must gain `tenantId`. |

So: **three pre-tenant** (1, 3, 5) — of which one is solved by a resolver reused from another
(1 reuses 3's) — **one pre-tenant that needs no help** (2), and **three wrappable** (4, 6, 7).
Two resolver functions total, not three.

---

## 4. Design decisions

### D-1 · Registration: app-side UUID + `set_config` inside the transaction. No migration.

Generate with `randomUUID()` from `node:crypto` (v4, matching Prisma's `@default(uuid())` and
satisfying `tenant-context.middleware`'s UUID requirement downstream). Verified in §3.
**Rejected:** a `tenant_bootstrap_insert` policy allowing an unconditional `INSERT` on
`"Tenant"` — it would let any tenant create tenants, which is S-2 by another route, and
`known-gaps.md` explicitly forecloses it.

### D-2 · The `SECURITY DEFINER` functions are owned by a dedicated `NOSUPERUSER BYPASSRLS NOLOGIN` role — **not** by `postgres`, **not** by the table owner

Recommended: `telemetry_auth_definer`, created in the new migration, `NOLOGIN` (nobody can
connect as it), granted `SELECT` on `"User"` and `"RefreshToken"` **and nothing else**, and
owning only the two functions. Verified working (`s7_probe_c`/`s7_probe_d`).

- **Rejected — own it as `postgres`.** Works (`s7_probe_a`), but every statement in the
  function body then executes with superuser rights. A future edit to the function body is a
  superuser edit. Unnecessary when a two-privilege role suffices.
- **Rejected — own it as the table owner without `BYPASSRLS`.** Does not work
  (`s7_probe_b` → `NULL`), because `v1_2` sets `FORCE ROW LEVEL SECURITY`. Silent failure.
- **Deployment consequence:** `CREATE ROLE … BYPASSRLS` requires superuser. `v1_4` already
  sets the precedent of a guarded `DO $$` block that `RAISE EXCEPTION`s rather than leaving a
  half-provisioned role; the new migration must do the same, and must **fail loudly** if the
  definer role ends up without `BYPASSRLS`. On a managed platform where the migration role is
  not a true superuser, this migration will fail and the role must be provisioned out of
  band — that is a release-note item, not something to paper over.

### D-3 · The resolvers return `tenantId` only; credentials come back through the RLS-scoped read

Signatures (exact SQL to be written by the implementer):

```
public.auth_resolve_tenant_by_email(p_email text)        RETURNS text
public.auth_resolve_tenant_by_refresh_token_hash(p_hash text) RETURNS text
```

Both `LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp`,
bodies fully schema-qualified, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO telemetry_app`.

- **Rejected — one function returning `(id, tenantId, passwordHash, role)`.** One round trip
  instead of four, and honestly *not much* weaker: an attacker holding the `telemetry_app`
  credential can, under either design, learn a hash for an e-mail they already know (resolve
  the tenant, set the context, read the user). The reason to prefer the narrow version is
  narrower: the `passwordHash` never crosses the `BYPASSRLS` boundary, so the function stays
  safe to grant more widely than the credential read would be, and the credential read stays
  a normal policy-enforced query that an audit of `"User"` access will see. Neither design
  permits a bulk dump of `"User"`, which is the property that matters most and which the
  status quo does not have.
- **Rejected — recover the tenant from the refresh token itself.** `createRefreshToken`
  (`token.service.ts:52`) mints opaque `randomBytes(32)`, not a JWT. Changing it to a JWT
  would invalidate every live refresh token on deploy.
- **Rejected — denormalize `tenantId` onto `"RefreshToken"`.** It would remove the need for
  the second resolver and would let `"RefreshToken"` get real RLS. It is the better long-term
  shape. It is also a schema change with a backfill on the highest-risk path in the platform,
  bundled into a change that already flips the connection role. Not in the same commit.
  Filed as S-10 (§7).

### D-4 · `set_config` on a miss is safe, but the code must short-circuit anyway

`SELECT set_config('app.tenant_id', <NULL>, true)` sets the GUC to the **empty string**, not
`NULL` — verified. `current_setting('app.tenant_id', true)` then returns `''`, the policy
`"tenantId" = ''` matches nothing, and a scoped read returns zero rows. So a miss degrades
correctly rather than dangerously. Even so, the repository must return `null` on an
unresolved tenant without issuing the second query, and `AuthService.login` must keep running
`compare` against `AUTH_SECURITY.DUMMY_PASSWORD_HASH` on that path (`auth.service.ts:81`) so
the response timing does not become an enumeration oracle.

### D-5 · Wrap sites 4, 6 and 7 even though they pass today

They pass only because `"RefreshToken"` RLS is inert (§2.2). Leaving them unwrapped means the
day S-10 is fixed, logout and rotation silently stop working. Wrapping them now costs three
signature changes and makes S-10 a one-migration task.

### D-6 · Do **not** enable RLS on `"RefreshToken"` in this task

Enabling it requires the denormalized `tenantId` (D-3) or a policy joining `"User"`, plus a
policy, plus a backfill — inside the change that flips the auth connection role. Out of scope,
filed as S-10.

### D-7 · `UserRepository` does not extend `TenantScopedRepository`; it gets a local per-call tenant helper

`TenantScopedRepository`'s contract is that `tenantId` is a **constructor** argument bound
per request, and the tenant-isolation rule requires the id to come from `this.where({})` and
never from a caller-supplied field. auth-service is the one place where the tenant is
*discovered* rather than *supplied*, and the repository outlives any single tenant.

Recommended shape: a `private async withResolvedTenant<T>(tenantId, fn)` on `UserRepository`
that opens `this.db.$transaction`, issues
`SELECT set_config('app.tenant_id', ${tenantId}, true)` as the first statement, and runs `fn`
— the same three lines as `base.repository.ts:94`, with the id passed per call. Every scoped
query inside still carries its explicit `tenantId` predicate (belt and braces).

The reviewer will read this as a deviation from the tenant-isolation rule. It is one, and it
is deliberate: the invariant "the tenant id never comes from caller input" is preserved,
because the id comes from a database lookup keyed on a credential, never from a request field.
**The plan should not try to hide this — it should be argued in the PR description.**
- **Rejected — make `UserRepository` per-request via a container factory.** It has no tenant
  at construction time for register and login; a factory would have to be called with a
  tenant that does not exist yet.
- **Rejected — duplicate `withTenant` into a second base class.** Two copies of the security
  primitive is worse than one justified local helper.

### D-8 · The duplicate-email pre-check calls `auth_resolve_tenant_by_email`

Site 1 becomes "resolve the tenant for this e-mail; if non-null, the e-mail is taken". Same
semantics as today, works under RLS, and reuses the function login already needs. The `P2002`
catch at `user.repository.ts:196` stays as the race-condition backstop.
- **Rejected — delete the pre-check and rely on `P2002` alone.** It would work, but it makes
  every duplicate registration allocate and roll back a tenant row, and it removes an explicit
  check in favour of an incidental one.

### D-9 · Who gets `EXECUTE`? — **user decision**

- **(a) `GRANT EXECUTE … TO telemetry_app`** (simplest, recommended for this task). All six
  services share that credential, so all six gain an `email → tenantId` and
  `tokenHash → tenantId` oracle. No password hashes, no bulk enumeration (each call needs an
  exact e-mail or an exact token hash), no HTTP-visible change.
- **(b) a dedicated `telemetry_auth` login role** for auth-service, `NOSUPERUSER NOBYPASSRLS`
  like `telemetry_app`, with the same table DML plus `EXECUTE` on the two functions. Strictly
  tighter. Costs: a third connection string, a third role in `v1_4`'s pattern, in
  `docker/postgres/init/01-app-role.sql`, in compose, in CI, in `.env.example`, and in
  `tests/setup.ts` — and it means auth-service's RLS proof no longer shares a role with the
  standing `usage-service` proof.

Recommendation: **(a) now, (b) filed as a follow-up gap if the reviewer wants it.** Escalated
rather than decided, because it is a security-posture choice.

---

## 5. Files to change

### New

- `prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql` — the definer role, the two
  functions, `REVOKE`/`GRANT`, and a guarded loud failure if the definer role lacks
  `BYPASSRLS`. Modelled on `v1_4_app_role_non_superuser/migration.sql`'s `DO $$` idempotency
  and its `RAISE EXCEPTION` guard.

### Production

- `apps/auth-service/src/repositories/user.repository.ts` — the only production file with
  behaviour changes. All seven sites per §3. Also: `AuthPrismaClient` /
  `AuthPrismaTxClient` (`:74`–`:112`) need `$queryRaw` on the transaction client, an `id`
  field on `TenantCreateArgs` (`:57`), and the narrowed login-read arg type.
- `apps/auth-service/src/services/auth.service.ts` — thread `tenantId` into
  `storeRefreshToken` (`:96`), `rotateRefreshToken` (`:127`) and
  `revokeActiveRefreshTokens` (`:155`). No control-flow change.
- `apps/auth-service/src/repositories/base.repository.ts:50-56` — the doc comment stating
  auth-service is not enforcing is now false.

### Config / infrastructure

- `apps/auth-service/.env.example` — `DATABASE_URL` → `telemetry_app`; delete the ten-line
  S-7 caveat (`:9`–`:18`); add `DIRECT_DATABASE_URL` with the same "never point a running
  service at it" note the root `.env.example` carries.
- `.env.example` — already correct (`telemetry_app` + `DIRECT_DATABASE_URL`). **No change.**
  The brief's premise that it "still carries the admin URL" is wrong: line 4 is
  `telemetry_app`, and the admin URL on line 8 is `DIRECT_DATABASE_URL`, which is correct.
- `docker/docker-compose.yml:57-60` — drop the auth-service `DATABASE_URL` override so it
  inherits `x-common-app-env`. Note in the comment that the compose stack runs no migrations
  (`docker/postgres/init/01-app-role.sql` header says so), so the resolver functions do not
  exist there and neither do the tables; auth's DB paths are non-functional in compose either
  way. `/health` — the only thing `pnpm test:smoke:compose` exercises (`app.ts:22`) — does
  not touch the database, so the compose smoke gate is unaffected.
- `docker/postgres/init/01-app-role.sql` — optionally create `telemetry_auth_definer` for
  parity with `v1_4`. The **functions** cannot go here: `LANGUAGE sql` bodies are parsed at
  `CREATE`, and no tables exist when init scripts run.
- `.github/workflows/ci.yml` — see §6.

### Tests (modified in place; no parallel files)

- `apps/auth-service/tests/setup.ts:5-8` — `DATABASE_URL` default → `telemetry_app`; delete
  the S-7 comment; keep `DIRECT_DATABASE_URL` (admin); **delete `RLS_PROBE_DATABASE_URL`**.
- `apps/auth-service/tests/rls.integration.test.ts` — replace the probe client with
  auth-service's own `DATABASE_URL`, delete the `PROBE_URL_FALLBACK` constant and the
  `RLS_PROBE_DATABASE_URL` read (`:16`, `:60`), rewrite the header comment (`:18`–`:22`)
  which explains why the probe exists. Keep the "runs as a role that cannot bypass RLS" guard
  test verbatim — it now guards auth-service's real connection, which is the whole point.
  Extend it to assert isolation on **`"User"`**, not only `"Event"`.
- `apps/auth-service/tests/auth.integration.test.ts` — `TEST_ENV.DATABASE_URL` (`:16`–`:18`)
  drops `AUTH_TEST_DATABASE_URL` and reads `process.env.DATABASE_URL` (set by `setup.ts`,
  which runs before the test module) with a `telemetry_app` literal fallback. `resetAuthState`
  (`:116`) must move to a separate admin `PrismaClient` on `DIRECT_DATABASE_URL` — as
  `telemetry_app`, `user.deleteMany()` and `tenant.deleteMany()` delete **zero rows and raise
  no error**, so the fixture reset would silently stop resetting. Mirror the two-client
  pattern already in `rls.integration.test.ts:54-62`. Add register/login/refresh/logout
  cases per §6.
- `apps/auth-service/tests/user.repository.unit.test.ts` (429 lines) — every
  `mockPrisma.user.findFirst` stub (14 occurrences) is now the resolver call; the mock client
  shape gains `$queryRaw`. Substantial but mechanical.

### Documentation

- `.claude/rules/known-gaps.md` — remove the S-7 section (`:68`–`:99`). **Also remove the
  S-3 section (`:17`–`:41`), which is stale**: `rls.integration.test.ts` at `b0f6921` already
  seeds through `DIRECT_DATABASE_URL`, has no `isCurrentUserSuperuser` guards, asserts
  `toHaveLength(0)` for the unscoped read, and fails rather than skips on a bypassing role —
  i.e. every element of S-3's stated fix direction has landed, in the commit titled
  "close tenant-isolation gaps S-1 through S-4", but the gap entry was never deleted. Add
  S-10 (§7). Ids are never renumbered, so the gaps at 3 and 7 stay gaps.
- `CLAUDE.md:159-168` — delete the "Known gap: auth-service still connects as the admin role"
  paragraph.
- `.claude/rules/tenant-isolation.md:64-68` — delete the "auth-service is the exception"
  paragraph; update the `(S-3, S-7, S-8, S-9)` list.
- `docs/development-setup.md` — mention the new migration in the bootstrap order if it
  documents one.

---

## 6. CI: what it takes to remove the override

Current state, verified in `.github/workflows/ci.yml`:

- Job-level `DATABASE_URL` = `telemetry_app` (`:16`), `DIRECT_DATABASE_URL` = admin (`:19`),
  `AUTH_TEST_DATABASE_URL` = admin (`:22`).
- The **Auth Coverage** step (`:88`) overrides `DATABASE_URL` back to admin, with a comment
  saying to remove it "when S-3 and S-7 land". S-3 has landed (§5). S-7 is this task.
- The workflow's own note (`:24`–`:31`) is correct and load-bearing: `turbo.json` declares no
  `env` on the `test` task, so turbo's strict env mode means job-level vars **do not reach**
  `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm build`. Those steps take their values
  from each package's `tests/setup.ts` literals. Only the Prisma steps and Auth Coverage — the
  ones that bypass turbo — see the job env.

Changes:

1. Delete the `env: DATABASE_URL:` block on **Auth Coverage** (`:88`–`:90`) and its comment.
   The job-level `telemetry_app` URL then reaches it, and `setup.ts`'s `??=` leaves it alone.
2. Delete the job-level `AUTH_TEST_DATABASE_URL` (`:20`–`:22`) once
   `auth.integration.test.ts` stops reading it.
3. Nothing else. The migration is applied by **Apply Prisma Migrations** (`:75`), which runs
   before every test step and uses `directUrl` → the admin role, so `v1_5` and its
   `CREATE ROLE` land before anything connects as `telemetry_app`.

What it takes to pass: `pnpm --filter @telemetry/auth-service test:coverage` must be green
with `DATABASE_URL` = `telemetry_app` — i.e. slices 1–5 complete. Note that auth-service's
`vitest.config.mjs` includes `tests/**/*.test.ts` with no integration exclusion, so both
integration files also run inside the **Unit Tests** step (`pnpm test`) using the `setup.ts`
literals. Both paths must be correct; there is no configuration in which the integration
suites are skipped. (This contradicts `.claude/rules/testing.md`'s claim that
`*.integration.test.ts` are "excluded from the default vitest config" — true for no package
checked here. Worth a separate correction; not in scope.)

---

## 7. New gap to file

> **S-10 · `"RefreshToken"` has RLS `FORCE`d but never `ENABLE`d — policies are inert — MEDIUM, open**
>
> `v1_0_initial_tenant_usage_rls/migration.sql` omits `"RefreshToken"` from its
> `ENABLE ROW LEVEL SECURITY` block and writes no policy for it; `v1_2` then `FORCE`s it,
> which is a no-op without `ENABLE`. Live `pg_class`: `relrowsecurity = false`,
> `relforcerowsecurity = true`, zero policies. Any holder of the `telemetry_app` credential
> can read, insert and revoke refresh tokens for every tenant. `"InvoiceLineItem"` has the
> same shape (no `tenantId` column of its own; it would need a policy joining `"Invoice"`).
> Fixing it needs a `tenantId` column on `"RefreshToken"` with a backfill, or a policy joining
> `"User"` — and every `"RefreshToken"` query wrapped in tenant context, which S-7 does. Not
> folded into S-7: that change already flips the connection role for login and registration.

---

## 8. Implementation slices — smallest safe first

Each slice states its controlling code path and a falsifiable local hypothesis.

### Slice 1 — the migration, alone

`prisma/migrations/v1_5_auth_tenant_resolvers/migration.sql`: definer role, two functions,
revoke/grant, loud guard. Nothing else changes; auth-service still connects as admin.

*Controlling path:* `prisma migrate deploy` via `directUrl`.
*Hypothesis:* after `migrate deploy`, connecting as `telemetry_app` and calling
`auth_resolve_tenant_by_email('<known>')` returns that user's `tenantId`, and calling it as a
role without the grant raises `42883`/permission-denied.
**Falsified if** the function returns `NULL` for a known e-mail — which means the owner does
not hold `BYPASSRLS` (D-2). Do not proceed past this slice until it is true; every later
slice fails silently otherwise.

### Slice 2 — registration transaction

Site 2 (+ `TenantCreateArgs.id`). Still on the admin role.

*Controlling path:* `UserRepository.createUserWithTenantIfEmailAvailable` → `$transaction`.
*Hypothesis:* the transaction's first statement is `set_config('app.tenant_id', …, true)` with
the same UUID passed to `tenant.create({ data: { id } })`, and the endpoint still returns
`201` with that id echoed as `data.tenantId`.
**Falsified if** the returned `tenantId` differs from the generated UUID.

### Slice 3 — login

Sites 1 and 3: resolver + `set_config` + scoped read; short-circuit on an unresolved tenant
with the dummy-hash compare preserved.

*Controlling path:* `AuthService.login` → `findUserForLogin`.
*Hypothesis:* against `telemetry_app`, a correct password returns `200` with
`user.role === "OWNER"`, and a wrong password returns `401 INVALID_CREDENTIALS` — not "no such
user" and not `500`.
**Falsified if** login succeeds only when `DATABASE_URL` is the admin role.

### Slice 4 — refresh

Site 5 (resolver + scoped read) and site 6 (wrap).

*Controlling path:* `AuthService.refresh` → `findRefreshTokenForRotation` →
`rotateRefreshToken`.
*Hypothesis:* against `telemetry_app`, one refresh returns `200` and the immediately reused
cookie returns `401 REFRESH_TOKEN_INVALID` — proving both the read and the revoke landed.
**Falsified if** the second call also returns `200` (rotation's `revokedAt` update was
swallowed) or the first returns `401`.

### Slice 5 — logout and store

Sites 4 and 7: thread `tenantId`, wrap.

*Controlling path:* `AuthService.logout` → `revokeActiveRefreshTokens`.
*Hypothesis:* logout returns `204`, the refresh cookie is cleared with `Max-Age=0`, reusing
the access token returns `401 TOKEN_REVOKED`, and — read back through an **admin** client —
the user's `"RefreshToken"` rows all have a non-null `revokedAt`.
**Falsified if** the admin read-back shows `revokedAt IS NULL`. This is the slice most likely
to pass vacuously, because `"RefreshToken"` has no RLS: a wrapper that never fires still works.
The admin read-back is what makes the assertion non-tautological.

### Slice 6 — flip the connection role

`tests/setup.ts`, `auth.integration.test.ts` (including the admin fixture client),
`.env.example`, `docker-compose.yml`, `ci.yml`.

*Hypothesis:* `pnpm --filter @telemetry/auth-service test` is green with **no** env overrides
at all, on the `setup.ts` defaults.
**Falsified if** it needs `AUTH_TEST_DATABASE_URL` to pass.

### Slice 7 — `rls.integration.test.ts` drops the probe role

Assert through auth-service's own `DATABASE_URL`; keep the bypass guard; add `"User"`
isolation.

*Hypothesis:* the suite passes with `RLS_PROBE_DATABASE_URL` **unset and undefined anywhere
in the repo**, and the guard test fails if `DATABASE_URL` is pointed at `postgres`.
**Falsified if** the guard test still passes when `DATABASE_URL` is the admin role — then it
is asserting nothing, which was S-3.

### Slice 8 — documentation

`known-gaps.md` (remove S-7 and stale S-3, add S-10), `CLAUDE.md`, `tenant-isolation.md`,
`base.repository.ts` doc comment, `development-setup.md`.

---

## 9. Test plan and acceptance-coverage mapping

Pseudo-TDD per `.claude/rules/testing.md`: skeletons → bodies → **confirm red against
`telemetry_app`** → implement → refactor on green. The current red state is already known and
reproducible (§2.1: `9 failed | 6 passed`), which is an unusually good starting point — the
implementer should re-run it before touching anything and record the output verbatim.

| AC | Proven by |
|---|---|
| **AC-1** Register succeeds as `telemetry_app` | `auth.integration.test.ts` — "registers a new user with valid input and returns 201" and "sets first registrant as OWNER role" (both currently `500`) |
| **AC-2** Duplicate e-mail still `409 EMAIL_ALREADY_EXISTS`, case-insensitively | the two existing duplicate tests + a **new** unit test asserting the resolver is called and `tenant.create` is **not**, so the pre-check is proved live rather than passing via `P2002` |
| **AC-3** Login succeeds; wrong password `401 INVALID_CREDENTIALS` | "logs in successfully with cookie session and rejects wrong password" |
| **AC-4** Unknown e-mail returns `401`, not `500`, and still runs the dummy-hash compare | **new** integration case + a unit test asserting `compare` is called with `AUTH_SECURITY.DUMMY_PASSWORD_HASH` when the resolver returns `null` |
| **AC-5** Refresh rotates; reuse of the old token `401 REFRESH_TOKEN_INVALID` | "refreshes session token with valid cookie and csrf, and rejects revoked token reuse" |
| **AC-6** Logout `204`, cookie cleared, access token denylisted | "logs out with valid cookie and csrf, then rejects the same access token" |
| **AC-7** Logout actually revokes in the DB | **new** assertion reading `"RefreshToken"` back through the admin client (see Slice 5 — the non-tautological half) |
| **AC-8** Cross-tenant `"User"` isolation is enforced by the database | **new** case in `rls.integration.test.ts`: seed two tenants with one user each through admin; with tenant-1 context, `user.findMany()` with **no** application predicate returns only tenant-1's user; with tenant-2 context, zero; with no context, zero |
| **AC-9** The asserting role cannot bypass RLS | existing "runs as a role that cannot bypass RLS" guard, now pointed at `DATABASE_URL` |
| **AC-10** The resolvers are not executable by `PUBLIC` | **new** case: `has_function_privilege('public', 'public.auth_resolve_tenant_by_email(text)', 'EXECUTE')` is `false`, and `true` for `telemetry_app` |
| **AC-11** The resolvers leak nothing beyond the tenant id | **new** case asserting the return type is a single `text` (`pg_proc.prorettype`), and that `telemetry_app` still reads **zero** rows from `"User"` with no context |
| **AC-12** No env override is needed anywhere | Slice 6's hypothesis; plus `grep -r RLS_PROBE_DATABASE_URL` / `AUTH_TEST_DATABASE_URL` returns nothing outside `docs/` |

### What can and cannot be automated here

**Can be, and must be** — a working PostgreSQL 16.13 with both roles is live at
`127.0.0.1:5432/telemetry` and was used for every probe in this plan:

- everything in the table above, including the SQL-level assertions (AC-10, AC-11), which are
  plain `$queryRaw` against `pg_proc` / `pg_authid`;
- the full register → login → refresh → logout sequence through `app.inject`;
- the red-state reproduction before implementation.

**Cannot be, in this environment:**

- **Managed-Postgres provisioning.** `CREATE ROLE … BYPASSRLS` requires superuser. The local
  `postgres` role is one; RDS/Cloud SQL/Neon migration roles typically are not. Whether
  `v1_5` applies on the real target is unverifiable from here and is a release-note item.
- **The compose stack's behaviour with a schema.** `docker/docker-compose.yml` runs no
  migrations, so the resolver functions cannot exist there. Only `/health` is exercised
  (`test:smoke:compose`), and it does not touch the database (`app.ts:22`), so the compose
  gate is unaffected — but "auth works in compose" is not something any gate proves, before
  or after this change.
- **Concurrent-suite interference.** `auth.integration.test.ts`'s `resetAuthState` does an
  unqualified `deleteMany()` on all three tables. Once it is pointed at the admin client it
  will, as it does today, delete rows that `rls.integration.test.ts` seeded if the two files
  run in parallel workers. This race exists at `b0f6921`; it is not introduced here. The
  implementer should narrow the reset to a suite-scoped predicate while touching the file, and
  the reviewer should confirm it did not simply move.

---

## 10. Validation commands

Task-scoped, in order:

```bash
# the red baseline, recorded verbatim before any edit
DATABASE_URL=postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry \
DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/telemetry \
  pnpm --filter @telemetry/auth-service exec vitest run tests/auth.integration.test.ts

# after slice 1 only
pnpm --filter @telemetry/auth-service exec prisma migrate deploy --schema=../../prisma/schema.prisma
pnpm --filter @telemetry/auth-service exec prisma migrate status --schema=../../prisma/schema.prisma
PGPASSWORD=telemetry_app_local_dev psql -h 127.0.0.1 -U telemetry_app -d telemetry \
  -c "SELECT public.auth_resolve_tenant_by_email('<known-address>');"

# per slice
pnpm --filter @telemetry/auth-service exec vitest run tests/user.repository.unit.test.ts
pnpm --filter @telemetry/auth-service exec vitest run tests/auth.integration.test.ts
pnpm --filter @telemetry/auth-service exec vitest run tests/rls.integration.test.ts

# slice 6 acceptance: no overrides at all
pnpm --filter @telemetry/auth-service test
pnpm --filter @telemetry/auth-service typecheck
pnpm --filter @telemetry/auth-service lint

# negative control for AC-9 — this MUST fail
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/telemetry \
  pnpm --filter @telemetry/auth-service exec vitest run tests/rls.integration.test.ts
```

Full gate before commit approval:

```bash
pnpm build && pnpm test && pnpm lint && pnpm typecheck
pnpm --filter @telemetry/usage-service exec vitest run tests/rls.enforcement.integration.test.ts
docker compose -f docker/docker-compose.yml up -d --build --wait && pnpm test:smoke:compose
```

---

## 11. Risks, mitigations, rollback, deploy ordering

| Risk | Likelihood | Mitigation |
|---|---|---|
| **The definer role lacks `BYPASSRLS` and the resolvers silently return `NULL`** — reproduces S-7 from inside the fix | Medium (it is the non-obvious part) | `v1_5` `RAISE EXCEPTION`s if the role lacks it, mirroring `v1_4`'s guard. Slice 1's hypothesis is a hard stop. AC-11 asserts a real lookup. |
| Migration cannot apply on managed Postgres (no superuser) | Medium in production, N/A locally | Release note: provision `telemetry_auth_definer` out of band, then re-run. Guarded `DO $$` blocks make the migration idempotent. |
| **Deploy ordering** — auth-service starts on `telemetry_app` before `v1_5` is applied | High if unmanaged | **The functions must exist before auth-service starts on the restricted role.** CI already enforces this (Apply Prisma Migrations at `ci.yml:75` precedes every test step). For a real deploy the order is: `migrate deploy` (admin) → verify the resolvers → *then* roll the auth-service `DATABASE_URL`. These are two separate deploy steps, not one. |
| Duplicate-email check passes vacuously via `P2002` | High if not tested for | AC-2's unit test asserts the resolver is consulted and `tenant.create` is not reached. |
| Logout/rotation wrappers pass vacuously (no RLS on `"RefreshToken"`) | High | AC-7 reads the rows back through an **admin** client rather than trusting the `204`. |
| `resetAuthState` silently stops resetting under `telemetry_app` | Certain if missed | Explicit in Slice 6; the admin fixture client is mandatory, not optional. |
| Login latency regresses | Low | 1 → 4 round trips, against a `bcrypt` compare that dominates. If it matters, D-3's one-step alternative is a two-line change. |
| Unit-test churn (14 `findFirst` stubs) hides a real behaviour change | Medium | The integration suite is the real gate; the unit suite must not be the only thing re-greened. |

**Rollback.** Two independent levers, in this order:

1. **Config-only, no deploy of code:** point auth-service's `DATABASE_URL` back at the admin
   role. Everything works again immediately — the new code paths are strictly compatible with
   a superuser connection (`set_config` is harmless, the resolvers still resolve). This is the
   fast lever and it needs no rebuild.
2. **Revert the commit.** `v1_5` is forward-only and must **not** be reverted with a `DROP` —
   leaving the role and the two functions in place is harmless (they are `REVOKE`d from
   `PUBLIC` and the definer role is `NOLOGIN`), and dropping them would break any instance
   still running the new code.

**What makes it safe to land:** the failure mode is loud in exactly one place (the migration
guard) and covered by a non-vacuous assertion everywhere else; the red baseline is already
reproducible so "it went green" is a real signal; the rollback is a config flip that requires
no code deploy; and CI runs the whole auth surface against the restricted role with no
override, so a regression cannot merge quietly.

---

## 12. Pending task checklist

- [done] Answer the decisions in §9 / D-2 and D-9 — answered by the user before Gate 3
- [done] Slice 1 — `v1_5_auth_tenant_resolvers` migration + hypothesis check
- [done] Slice 2 — registration transaction
- [done] Slice 3 — login (resolver + scoped read)
- [done] Slice 4 — refresh (resolver + scoped read + wrapped rotation)
- [done] Slice 5 — logout / store-token wrapping, with admin read-back assertion
- [done] Slice 6 — flip `DATABASE_URL`; admin fixture client; CI override removal
- [done] Slice 7 — `rls.integration.test.ts` drops `RLS_PROBE_DATABASE_URL`; adds `"User"` isolation
- [done] Slice 8 — docs: remove S-7, remove stale S-3, add S-10, update `CLAUDE.md`,
      `tenant-isolation.md`, `base.repository.ts`, `development-setup.md`, and add the
      release note `docs/releases/s-007-auth-service-restricted-role.md`
- [done] Task-scoped validation, then the full 13-package gate
- [ ] Senior Reviewer (pre-QA) → QA Tester → Senior Reviewer (final) → CI gate → commit approval

---

## 13. Decisions the user must make before Gate 3

1. **D-2 — definer ownership.** Dedicated `telemetry_auth_definer`
   (`NOSUPERUSER BYPASSRLS NOLOGIN`, recommended), or own the functions as `postgres`?
   Table-owner-without-`BYPASSRLS` is not an option — it fails silently (§3, `s7_probe_b`).
2. **D-9 — who may `EXECUTE`.** `telemetry_app`, shared by all six services (recommended for
   this task), or a dedicated `telemetry_auth` login role for auth-service only?
3. **D-3 — resolver breadth.** Return `tenantId` only and take four round trips
   (recommended), or return `(id, tenantId, passwordHash, role)` in one call?
4. **D-6 / S-10 — scope.** Confirm `"RefreshToken"` RLS stays out of this task and is filed
   as a new gap rather than fixed here.
5. **Stale S-3.** Confirm the S-3 entry in `known-gaps.md` should be deleted as part of this
   task's documentation slice — it describes a state that `b0f6921` already fixed, and
   `ci.yml:94` still cites it as a reason for an override.
6. **D-7 — architectural deviation.** Confirm that `UserRepository` gets a local
   per-call tenant helper rather than extending `TenantScopedRepository`, and that this is
   argued openly in the PR rather than smoothed over for the reviewer.
7. **Release note.** Confirm a deploy note is required covering: apply `v1_5` first, verify
   the resolvers, then flip `DATABASE_URL`; and that managed-Postgres targets may need
   the definer role provisioned out of band.

---

## 14. Remediation round — answers to the review, and what changed

Added after the Senior Reviewer's **CONDITIONAL** verdict
(`docs/reviews/s-007-auth-service-restricted-role.md`). D-2 and D-9 in §13 were answered
**against** the recommendations above; §§1–13 record what was planned, this section records
what shipped. Where the two disagree, this section is correct.

The review remains as written — it is the reviewer's artifact, not a document to retro-edit.
**Everything below needs re-review before commit.**

### D-2 reversed — the definer role is `NOBYPASSRLS` (HIGH-1)

§3's claim that a `SECURITY DEFINER` owner *must* hold `BYPASSRLS` under
`FORCE ROW LEVEL SECURITY` is **wrong**, and the reviewer disproved it by execution. A
`NOSUPERUSER NOBYPASSRLS NOLOGIN` owner plus one targeted permissive policy per table resolves
the identical tenant id.

`v1_5` now creates `telemetry_auth_definer` as `NOBYPASSRLS` and adds
`user_auth_definer_read` / `refreshtoken_auth_definer_read` — `FOR SELECT`, `USING (true)`,
scoped `TO telemetry_auth_definer`. The guards assert *those* rather than the role attribute,
and no longer clamp an operator's deliberately narrowed role back to bypassing.

Two consequences beyond least privilege:

- `BYPASSRLS` is a role attribute, so it would have covered every table the role could ever
  reach — bounded only by the convention that nobody adds another `GRANT`.
- `CREATE ROLE … BYPASSRLS` requires **superuser**, so the previous shape could never be
  applied on RDS, Cloud SQL or Neon at all. The policy shape needs only `CREATEROLE`.

**Landed in `v1_5` itself rather than as a forward `v1_6`.** Migrations are forward-only, but
`v1_5` had never been applied outside one local dev database and a later migration could only
have *undone* an assertion `v1_5` still made — leaving it unappliable on managed Postgres, which
no later migration can repair. The local history row was re-recorded
(`DELETE FROM _prisma_migrations WHERE migration_name = 'v1_5_auth_tenant_resolvers'`, then
`prisma migrate resolve --applied v1_5_auth_tenant_resolvers`); `migrate status` is clean and CI
builds a fresh database every run.

### D-9 reversed — auth-service gets its own login role (HIGH-2)

`EXECUTE` on the resolvers was granted to `telemetry_app`, which is the role **all six services
share**. The reviewer reproduced the result live: from any tenant's request context, in any
service, the e-mail resolver returns another tenant's id — around the `"User"` policy this task
exists to make enforce.

`v1_5` now creates `telemetry_auth_app` (`LOGIN NOSUPERUSER NOBYPASSRLS`, same table privileges
as `telemetry_app`), grants `EXECUTE` to it alone, and revokes from both `PUBLIC` and
`telemetry_app`. Touched: `.env.example`, `tests/setup.ts` (via the new
`tests/database-urls.ts`), `ci.yml`, `docker-compose.yml`, `docker/postgres/init/01-app-role.sql`
and the release note.

Worth fixing now rather than after S-10: while `"RefreshToken"` RLS is inert the token resolver
tells an attacker nothing they could not already `SELECT`, but enabling RLS there inverts that
and turns the grant into a live policy bypass.

### Sites 6 and 7 now carry a tenant predicate (HIGH-3)

The claim that `"RefreshToken"` admits no application-layer predicate was **wrong** for
anything with a `where`: Prisma's `user` relation filter is accepted on both
`RefreshTokenWhereUniqueInput` and `RefreshTokenWhereInput` and compiles to a real
`EXISTS (SELECT … FROM "User" WHERE "tenantId" = $n …)`.

`rotateRefreshToken` and `revokeActiveRefreshTokens` now pass `user: { tenantId }`, and the
interface types make it **required** rather than optional. `storeRefreshToken` is the one
genuine exception — an INSERT has no `where` — and its comment now says that instead.

### Also fixed in this round

| Finding | Disposition |
|---|---|
| MEDIUM-1 · managed-Postgres recovery path fails at `ALTER FUNCTION … OWNER TO` | Fixed. Release note now includes `GRANT telemetry_auth_definer TO <migration_role>` and drops the wrong `BYPASSRLS` platform advice, which no longer applies. |
| MEDIUM-2 · third and fourth copy of the connection-string literals | Fixed. `apps/auth-service/tests/database-urls.ts` is the single source; five suites import it. |
| MEDIUM-3 · login/refresh round-trips unquantified | Fixed by documentation, as the reviewer proposed — release note, "Latency" section. Behaviour unchanged. |
| LOW-1 · S-10 comment only on `storeRefreshToken` | Fixed, and corrected: the other two now carry predicates, so the shared claim was wrong. |
| LOW-2 · token resolver had no behavioural test | Fixed. `rls.integration.test.ts` seeds a refresh token and asserts both the hit and the miss with no tenant context. |
| LOW-3 · nothing asserted `set_config` runs *first* | Fixed. The unit mock records how many model calls had happened when the context was set; `expectTenantContextSetFirst()` asserts zero and throws if no context statement was issued at all. Confirmed red against a repository that sets the context last. |
| LOW-4 · double cast unexplained | Fixed. `user.repository.ts` constructor comment states why it is sound. |
| LOW-5 · `as TenantId \| null` on a `$queryRaw` result | Fixed. `asTenantId()` narrows on `typeof === "string"`; the cast is gone. |
| LOW-6 · "guards the whole suite" guarded nothing | Fixed. `beforeAll` throws on a superuser/`BYPASSRLS` role; the test now records the property rather than claiming to protect the file. |
| LOW-7 · pre-existing magic literals in the rewritten file | Fixed. `AUTH_DATABASE.UNIQUE_VIOLATION_CODE`, `AUTH_ROLES`, `AUTH_TENANT_DEFAULTS`. |
| LOW-8 · five bare `toBe(400)` | Fixed. `AUTH_HTTP_STATUS.BAD_REQUEST`. |
| NIT · `SET search_path` looks alarming | No change — reviewer confirmed it is the documented pattern. |
| Recommended #1 · `.claude/rules/testing.md` is factually wrong | Fixed. Integration suites **do** run inside `pnpm test`; the rule now says so and explains why two also get their own CI step. |
| Recommended #4 · `AuthenticatedRequestContext` typed both ids as `string` | Fixed. Branded to `UserId` / `TenantId`; the brands are applied once at each JWT trust boundary (`jwt.plugin.ts`, `logout-auth.plugin.ts`) and the casts in `auth.service.ts` are gone. Typechecking found the second boundary, which is the point. |

One extra, not in the review: the role union `"OWNER" | "ADMIN" | "MEMBER"` was written out in
seven places. Introducing `AUTH_ROLES` for LOW-7 would have made that an eighth copy sitting
next to the constant, so it is now `AuthRole`, derived from `AUTH_ROLES` in `constants.ts`.

### Verification

- Local PostgreSQL 16: `v1_5` applied clean and re-applied byte-idempotent. `pg_roles`:
  `telemetry_app` `f/f/t`, `telemetry_auth_app` `f/f/t`, `telemetry_auth_definer` `f/f/f`.
  Both definer policies present and `SELECT`-scoped. `has_function_privilege`: `PUBLIC` **no**,
  `telemetry_app` **no**, `telemetry_auth_app` **yes**.
- The migration's functional guard passes with the `NOBYPASSRLS` definer — the live proof that
  the policy shape resolves.
- auth-service **156/156** (was 151), including register / login / refresh / logout end-to-end
  against `telemetry_auth_app`. Every new unit assertion confirmed red first: 8 failures against
  a repository with the predicates removed and the context set last.
- auth-service lint: 0 errors, 10 warnings — all `no-misused-promises` in
  `tests/auth.service.unit.test.ts`, untouched here and pre-existing since before `b0f6921`.

### Still open

- **S-10** (`"RefreshToken"` RLS never `ENABLE`d) — unchanged in scope, and `v1_5` now
  pre-creates the policy its resolver will need.
- No new gaps were accepted in this round: every HIGH and MEDIUM was fixed rather than filed.

---

## 15. Second remediation round — answers to the final review

Added after the Gate 6 review (`docs/reviews/s-007-auth-service-restricted-role-final.md`), which
confirmed all three HIGHs from §14 fixed **by execution** and raised one new HIGH plus four
MEDIUMs. That review is also left unedited. Where §§1–14 disagree with this section, this section
is correct.

### HIGH-1 — the branded-context change blessed dead code

`plugins/index.ts` and `logout-auth.plugin.ts` both named `logout-auth.plugin.ts` as *the* JWT
trust boundary. It is not a boundary at all: nothing imports `requireLogoutAuth`, `/logout` is
registered with `requireJwtAuth` (`routes/index.ts:28`), and coverage reported the file at 0%. It
also verified the signature **without** consulting the token denylist that the live guard checks,
so wiring it up would have reintroduced revoked-token acceptance.

Confirmed independently before acting: the only reference to the module anywhere in the repo was
the doc comment this change added. The file was already unwired at `b0f6921` (introduced by
`77a6d8e`); what this change contributed was documentation asserting it mattered.

**Deleted**, rather than commented around, and `plugins/index.ts` now names `requireJwtAuth` — the
only producer — with a note on what a second producer would have to do. §14's "typechecking found
the second boundary, which is the point" was inverted, and is corrected here rather than left to
stand.

While there: the role claim is now *validated* against `AUTH_ROLES` rather than shape-asserted
(review LOW-4), so a signed token carrying `role: "SUPERADMIN"` is rejected instead of reaching
`AuthenticatedRequestContext` typed as `AuthRole`.

### MEDIUM-1 — the recommended fix does not work; the invariant is enforced another way

The review asked for `ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE EXECUTE ON FUNCTIONS FROM
PUBLIC`. **That statement is accepted and has no effect.** Disproved four ways on PostgreSQL
16.13 — with and without `FOR ROLE`, inside one transaction and across separate sessions, and with
an explicit `pg_default_acl` row of `{postgres=X/postgres}` materialised first: a function created
afterwards still comes out `proacl = NULL` with `has_function_privilege('public', …) = true`.

It was written, tested, and removed rather than shipped as protection that provides none — the
same failure mode both reviews were pulled up on, and it would have been a third instance.

The concern is real, so it is enforced where it can be:

- The migration's catalog guard now loops **every** `prosecdef` function in `public`, not a
  hard-coded list of two, raising if `PUBLIC` or `telemetry_app` can execute any of them.
- `rls.integration.test.ts` asserts the same invariant, plus the exact set of definer functions,
  on every `pnpm test` — so a later migration that adds a resolver and forgets the `REVOKE` fails
  CI rather than shipping. The apply-time guard alone could not catch that.
- Filed as **S-11**, with the disproof, so the next person does not try the same statement.

### MEDIUM-2 — destructive window and unbounded policy set

`DROP POLICY IF EXISTS` + `CREATE POLICY` replaced with a conditional create, so idempotency no
longer depends on the file running inside a transaction — which matters because the release note's
own recovery path has an operator re-running it through `psql`, where a failure between the two
statements would leave `"User"` without the policy and **every login returning 401, silently**.

The guard now also asserts the *exact* policy set on `"User"` and `"RefreshToken"`, not merely
presence. Permissive policies OR together, so one stray `USING (true)` left behind by a rename
would widen tenant reach — the same unbounded-set risk that D-2 was reversed to avoid.

### MEDIUM-3 — narrowed, not merely recorded

`telemetry_auth_app` held DML on all ten tables, copied from `telemetry_app`. It now holds DML on
`"Tenant"`, `"User"` and `"RefreshToken"` — the three tables auth-service touches — with **no**
`ALTER DEFAULT PRIVILEGES`, so a future table must be granted deliberately. The migration
`REVOKE`s first so re-application converges rather than merely not failing: an earlier revision
granted the superset, and a `GRANT` cannot take that back.

This closes a real hole rather than a stylistic one: RLS is inert on `"InvoiceLineItem"` (S-10), so
the blanket grant was cross-tenant **write** access for a service with no business there.

Consequences handled: the compose init script no longer mirrors table privileges for this role (it
cannot — no tables exist when it runs, and a blanket default would be the opposite of the
migration's intent); `rls.integration.test.ts` moved its three `"Event"` data assertions to
`"Tenant"`, a table auth-service actually owns, since the role can no longer read `"Event"` at
all; and a new test asserts the grant set *is* those three and that `"Event"` is rejected.

### MEDIUM-4 — the in-place revision is now written down

The release note has a section on it: why a forward migration could not have fixed the `BYPASSRLS`
assertion, what error an environment that applied an earlier revision will see
(`migrate deploy` refuses on the checksum — loudly), and the recovery steps. It is the only record
an operator will read.

### LOW and NIT

| Item | Disposition |
|---|---|
| LOW-1 · unreachable definer-attribute guard | No change — reviewer's own advice was to keep it; the effective guards are sections 7 and 8. |
| LOW-2 · `NOLOGIN` was a non-sequitur | Fixed. The comment now claims **membership**, and states that `has_function_privilege` following membership is what makes the guard catch an escalation. |
| LOW-3 · the functional guard's token branch cannot fail today | Fixed by comment — noted inline so section 8 is not read as proof of the `"RefreshToken"` policy. |
| LOW-4 · `AuthRole` asserted, not validated | Fixed (see HIGH-1). Pre-existing, but `AUTH_ROLES` now exists so the check is one line. |
| LOW-5 · nothing proved the relation filter *does* anything | Fixed. New `tests/user.repository.integration.test.ts` drives the real repository against a real database: correct tenant revokes; wrong tenant raises `P2025` / matches zero rows and the row stays active. Confirmed red — 2 of 4 fail with the predicates removed. |
| LOW-6 · magic literals survived in the two rewritten test files | Fixed. `AUTH_ROLES.OWNER`, `AUTH_TENANT_DEFAULTS`, `AUTH_DATABASE.UNIQUE_VIOLATION_CODE`; the v1_0/v1_2 policy names are a named constant in the suite that asserts them, not in `AUTH_DATABASE` — they are not auth's contract. |
| LOW-7 · the promotion undercounted and stopped at `src` | Fixed. `jwt.plugin.unit.test.ts` imports `AuthRole`; no copy of the union remains anywhere. |
| LOW-8 · `senior-reviewer.md` cited a gap this commit deleted | Fixed — points at the review and the `beforeAll` pattern, marked "historically S-3". |
| LOW-9 · `testing.md` over-quantified | Fixed. Five packages have a config; the others use vitest defaults, which also collect integration suites. Notes that auth's `exclude` is under `coverage`, not `test`. |
| LOW-10 · `requireEnv` required nothing | Fixed — `envOrDefault`. |
| LOW-11 · the suite never asserted *which* role | Fixed. `beforeAll` throws unless `current_user` is `telemetry_auth_app`; pointed at `telemetry_app` it previously left 14 of 18 green. |
| LOW-12 · second local password undocumented | Fixed in `docs/development-setup.md`. |
| LOW-13 · five test-only `AUTH_DATABASE` members | No change — reviewer judged it defensible; it keeps the suite literal-free. |
| NIT · a `beforeAll` throw renders as "18 skipped" | Fixed by a note in the file header: the difference from the S-3 signature is the exit code and the thrown message. |
| NIT · guard errors if `v1_5` runs without `v1_4` | No change — unreachable under Prisma's ordered application. |
| NIT · `pnpm format:check` red repo-wide | Filed as **S-12**, not fixed. Reformatting 250 files would bury every real diff; there is no CI step, so nothing is blocked. |

### Verification

- `v1_5` applied and re-applied clean; local history re-recorded a second time
  (`prisma migrate status` → up to date). Final catalog: `telemetry_auth_definer` `f/f/f`, both
  policies `SELECT` and definer-scoped, `telemetry_auth_app` granted on exactly
  `RefreshToken, Tenant, User`, zero `pg_default_acl` function rows, `telemetry_app` unable to
  execute either resolver.
- auth-service **162/162** across 15 files (was 156/14). Both new negative paths confirmed red
  before the fix.
- 13/13 packages green on build, typecheck, lint and test; 14 lint warnings, unchanged and
  pre-existing.

### Still open

- **S-10** — `"RefreshToken"` RLS never `ENABLE`d. Unchanged in scope.
- **S-11** — new `SECURITY DEFINER` functions are `PUBLIC`-executable by default and no default
  privilege prevents it; mitigated by an apply-time guard and a standing test, not by a default.
- **S-12** — `pnpm format:check` cannot pass.

---

## 16. Third remediation round — answers to the second final review

Added after `docs/reviews/s-007-auth-service-restricted-role-final-2.md` (**CONDITIONAL**), which
confirmed round 2's HIGH and all four of its MEDIUMs fixed by execution, reproduced its
"confirmed red — 2 of 4" claim exactly, and then found that the round-3 pattern had recurred: a
false load-bearing claim in prose. It was right, and this one was mine twice over — it was used to
reject a correct recommendation *and* to file a gap as irreducible.

### HIGH-1 — my `ALTER DEFAULT PRIVILEGES` claim was wrong

§15 MEDIUM-1 stated that `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` has
no effect on PG 16.13, and used that to reject the previous reviewer's recommendation and to file
S-11 as mitigable only by a guard and a test.

**True only of the `IN SCHEMA` form I tested.** Omit the clause and it works. Re-verified here
before changing anything:

```
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;   -- no IN SCHEMA
CREATE FUNCTION public.zz_verify(...) SECURITY DEFINER ...;
        proacl         | public_exec | shared_exec | auth_exec
 {postgres=X/postgres} | f           | f           | f
```

The mechanism, as the reviewer characterised it: a schema-scoped `pg_default_acl` row is *merged*
with `acldefault()`, which already contains `=X` for `PUBLIC`, so a schema-scoped revoke can never
subtract it — no row is even created. The database-scoped entry replaces the default instead.

My test matrix was too narrow in exactly the direction that mattered: four variants, all of them
schema-scoped. Four negative results felt like proof and were not.

**Fixed:** the statement is now in the migration, in its working form, with a comment saying why
the `IN SCHEMA` variant must not be "tidied" back in. Verified live — a `SECURITY DEFINER` function
created afterwards comes out `{postgres=X/postgres}` with neither app role able to execute it.
S-11 is rewritten to the *true* residual (the default is per creating role, so a function created
by some other role is still world-executable) and downgraded MEDIUM → LOW. The false sentence is
gone from `tenant-isolation.md`, the release note, the migration and the test comment.

### HIGH-2 — three docs still described the pre-narrowing role

`CLAUDE.md`, `apps/auth-service/.env.example` and `docs/development-setup.md` still said
"same/identical table privileges as `telemetry_app`" — contradicted by `tenant-isolation.md`, the
migration and the release note **inside the same commit**. Round 2 narrowed the grants and updated
four files out of seven. All three now say it holds *less*, and name the three tables.

The reviewer's point about why this one bites: the release note tells an operator provisioning by
hand to grant three tables and no more, while `development-setup.md` told them the privileges were
identical to `telemetry_app`'s.

### MEDIUM-1 — the grant guard was vacuous where it was promised

`information_schema.role_table_grants` shows only rows whose grantor or grantee is a *currently
enabled role*, so the guard returned nothing for a non-superuser migration role — which is exactly
the managed deployment the migration's own header describes. Reproduced before fixing: with
`GRANT SELECT ON "Event" TO telemetry_auth_app` planted, the old predicate saw `0` as
`zz_migrator` and the new one sees `1`.

Now reads `pg_class.relacl` and `pg_attribute.attacl` via `aclexplode`, which also closes the
column-grant blind spot. The standing test in `rls.integration.test.ts` was carrying the same
predicate and got the same treatment, plus a column-grant assertion.

### MEDIUM-2 — "membership escalation is caught" was false for `telemetry_auth_app`

The comment claimed `has_function_privilege` following membership made the guard catch a definer
grant. True for `telemetry_app`; **false for `telemetry_auth_app`**, which holds `EXECUTE`
legitimately, so nothing fired — and the reviewer demonstrated the consequence: granted the definer
to auth's own role and read both tenants' users with no tenant context.

Section 7 now asserts `pg_has_role` for **both** application roles, which also covers transitive
grants. Verified by planting each grant and running the whole file: both raise, with the message
naming the `USING (true)` policy as the reason. The migration role's own membership is still
allowed — `ALTER FUNCTION … OWNER TO` needs it.

### MEDIUM-3 — the role validation had no test

The `isAuthRole` branch round 2 added was untested; deleting it left 162/162 green, and the
coverage report in §15 already showed `jwt.plugin.ts … 66-67` uncovered. Two tests added — an
unknown role value and an absent role claim — and the helper widened to `AuthRole | string` so the
case is expressible. Confirmed red: both fail with the branch removed.

### MEDIUM-4 — the `REVOKE`→`GRANT` window

Round 2 closed this shape for policies and left it open for grants. Restructured the same way:
grant the three tables **first**, then revoke only the complement with a `DO` loop over `pg_class`,
so no intermediate state leaves auth-service without table access. The release note additionally
prescribes `--single-transaction` for a manual re-run, which makes the guarantee independent of
statement order.

### MEDIUM-5 — `AUTH_ROLES` could drift from the schema

`AUTH_ROLES` restates `enum Role`, and round 2's new validation *rejects* anything not in it — so
adding `VIEWER` to the schema would have rejected legitimate tokens at the JWT boundary with
nothing objecting at compile time. Added a type-only parity assertion in `constants.ts`
(`Record<PrismaRole, AuthRole>`); confirmed it bites by widening the key type, which produces
`TS2741`. `import type` only, so the startup-ordering rule is unaffected. `Plan`/`TIMEZONE` left as
the reviewer allowed.

### LOW and NIT

| Item | Disposition |
|---|---|
| LOW-1 · header said "18 skipped", file has 20 tests | Fixed — the count is gone rather than corrected, so it cannot go stale again. |
| LOW-2 · `"OWNER"` still a literal in three touched test files | Fixed — `AUTH_ROLES.OWNER` in `jwt.plugin.unit.test.ts`, `auth.integration.test.ts`, `token.service.unit.test.ts`. §15's "no copy remains" was about the *type*; the reviewer was right that the rule covers values. |
| LOW-3 · `P2025` local while `P2002` is in `AUTH_DATABASE` | Fixed — `AUTH_DATABASE.RECORD_NOT_FOUND_CODE`. |
| LOW-4 · standing grant test carried MEDIUM-1's blind spots | Fixed with MEDIUM-1: catalog ACLs, column grants, and a `pg_has_role` membership assertion. |
| LOW-5 · "all six services" vs five | Fixed — two places in the migration. |
| LOW-6 · 157-character merged line | Fixed. |
| NIT-1 · the comment fixed only `role` but read as general | Fixed by comment: `role` is the only claim narrowed by value; the other four are presence-checked. Validating all five is out of scope. |
| NIT-2 · surviving `Event` catalog assertion | Accepted, as the reviewer judged. |
| Recommended · `prisma/seed.ts` targets a non-existent compound unique | Verified (`seed.ts:36` uses `tenantId_email`; the schema declares `@@unique` only on `Meter`, `Invoice`, `MetricRollup`) and filed as **S-13**. Out of scope here. |

### Verification

- Migration applies clean and re-applies idempotent; local history re-recorded a third time,
  `migrate status` up to date. `telemetry_auth_app` reachable tables (via `aclexplode`, not the
  view): `RefreshToken, Tenant, User`. A new `SECURITY DEFINER` function is no longer
  `PUBLIC`-executable. Both membership guards raise when planted; nothing left behind
  (`pg_auth_members` for the definer: 0, `zz_migrator`: absent).
- Every probe ran in `BEGIN … ROLLBACK` except the migration itself.
- auth-service **164/164** across 15 files. Both new negative paths confirmed red first.
- 13/13 packages on build, typecheck, lint, test.

### Still open

S-5, S-6, S-8, S-9, S-10, S-11 (rewritten, LOW), S-12, S-13.

---

## 17. Fourth remediation round — answers to the third final review

Added after `docs/reviews/s-007-auth-service-restricted-role-final-3.md` (**CONDITIONAL**, 2 HIGH,
1 MEDIUM, 2 LOW, 5 NIT). It confirmed the PostgreSQL semantics in §16 are all correct — the
database-scoped default privilege, the `IN SCHEMA` trap, the merge mechanism, all four section-7
guards firing, the grant-before-revoke convergence — and re-derived every gate number exactly. The
defects it found are elsewhere.

### HIGH-1 — the parity assertion was half a guard

§16 MEDIUM-5 claimed the new `Record<PrismaRole, AuthRole>` assertion fails "in either direction".
It does not. Verified before changing anything:

| Drift | `tsc` |
|---|---|
| Schema gains `VIEWER`, `AUTH_ROLES` does not | `TS2741` — caught |
| `AUTH_ROLES` gains `SUPERADMIN`, schema does not | **compiles clean** |

Excess-property checking applies only to fresh object literals; `AUTH_ROLES` is a named `const` and
`AuthRole` is derived *from* it, so the value type widens along with the extra key. §16 verified
direction A by widening the key type and generalised from one observation — the same shape of
error as §15's four schema-scoped `ALTER DEFAULT PRIVILEGES` probes.

The missed direction is the one that matters: `jwt.plugin.ts` gates on `Object.values(AUTH_ROLES)`,
so a role added there but not to the schema is a role the JWT boundary starts **accepting**.

**Fixed** with a second assertion, `Record<AuthRole, PrismaRole>`. Both directions now verified by
execution: direction A `TS2741`, direction B `TS2322`, clean when they agree. The comment states
why one is not a tidier form of the other, so neither gets deleted as redundant.

### HIGH-2 — the retracted claim survived in the standing test

§16 HIGH-1 said the false `ALTER DEFAULT PRIVILEGES` sentence was "gone from `tenant-isolation.md`,
the release note, the migration and the test comment". Four of five sites. The comment in
`rls.integration.test.ts` still asserted that no default privilege can suppress `PUBLIC`'s
`EXECUTE` — contradicted by the migration in the same commit, and by the review that had just
disproved it. A false claim about having removed a false claim.

**Fixed**, and swept: no instance of the retracted wording survives outside the review and plan
artifacts, which are deliberately historical.

### MEDIUM-1 — the default privilege's blast radius was documented nowhere

The statement is correct, but with no `IN SCHEMA` it records `defaclnamespace = 0` and therefore
covers every function the migration role creates in *any* schema — not just `SECURITY DEFINER`
functions, not just `public`. The reviewer measured the consequence: `CREATE EXTENSION pgcrypto`
afterwards yields `crypt`, `armor`, `dearmor` as `{owner=X/owner}`, and the five services sharing
`telemetry_app` fail with `42501 permission denied for function` — fail-closed, but silent until a
query runs, and cross-service from a migration whose stated scope is two auth resolvers.

Kept, and documented as the reviewer recommended: a release-note section for the operator with the
explicit `GRANT EXECUTE ON ALL FUNCTIONS` remedy, the `pg_default_acl` row named as a fourth
rollback artifact with the statement that removes it, and S-11 extended to carry both residuals —
under-restriction (per creating role) and over-restriction (database-wide) — since one statement
produces both. Re-scoping it would reintroduce §16's HIGH-1.

### LOW and NIT

| Item | Disposition |
|---|---|
| LOW-1 · §16 recorded the 157-char line as fixed; it was byte-identical, and round 3 added two more | Fixed — `development-setup.md`, `CLAUDE.md`, `migration.sql`. The two remaining >100-char lines outside string literals are a shell command and a pre-existing line at `b0f6921`, both proven. The disposition in §16 was simply wrong. |
| LOW-2 · `:224` read as though no table default privileges are issued, 28 lines above two that are | Fixed — the comment now says "no default *grant*", and states that the two revokes converge a hand-made schema-scoped grant only and are inert against a database-scoped one, per section 6. |
| NIT-1 · `base.repository.ts` kept the superset framing the other three files were corrected for | Fixed — same role attributes, *narrower* table privileges. |
| NIT-2 · §16 over-described the `telemetry_app` membership guard | Correct: both planted grants raise, but `telemetry_app` raises at the earlier `has_function_privilege` check, so the new `pg_has_role` branch for it is unreachable-first — the definer owns the functions, so any member has `EXECUTE`. Kept as defence in depth; the description is corrected here. |
| NIT-3 · guards and revoke loop omitted `relkind` `'m'` and `'f'` | Fixed in all three places. Speculative today (`public` holds only `relkind = 'r'`), but a materialized view would have been neither revoked nor caught. |
| NIT-4 · the standing test's column predicate is stricter than the migration's | Accepted. §16's "same predicate" was loose; the test covers all of `public` including the three permitted tables, which is the stricter and better default. |
| NIT-5 · `role?: AuthRole \| string` collapses to `string` | Accepted. Every other call site in the file now passes `AUTH_ROLES.OWNER`, so nothing is weakened in practice. |

### Verification

- Migration re-applies clean and idempotent; local history re-recorded a fourth time,
  `migrate status` up to date.
- Both parity directions confirmed by `tsc`; the corrected test comment and all doc edits are prose.
- auth-service **164/164** across 15 files; 13/13 packages on build, typecheck, lint, test.

### Still open

S-5, S-6, S-8, S-9, S-10, S-11 (both residuals, LOW), S-12, S-13.

### On the review loop

Four rounds, four false load-bearing claims, all of them mine, and all the same failure: stating a
general mechanism from a narrow observation. `BYPASSRLS` was "required" on the strength of one
probe shape; the trust boundary was "the one place" without checking the wiring; the default
privilege "could not work" after four probes that were all schema-scoped; the parity assertion
caught "either direction" after testing one. The code has been verified every round and has held
up; the sentences about it are where every defect has been.

The reviewer's judgement is that the security property needs no further rework and that a fifth
substantive pass would tell no one anything new. The remaining risk is concentrated in prose, which
no gate covers — which is the argument for the standing assertions added along the way
(`rls.integration.test.ts`'s definer-function invariant, the parity assertions, the migration's own
guards) being the durable answer rather than another review.
