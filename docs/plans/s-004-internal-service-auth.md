# S-4 — Service-to-service auth for usage-service (+ M-2: UUID-validate `X-Tenant-Id`)

Task ids: **S-4** (`.claude/rules/known-gaps.md`, HIGH) and **M-2** (residual finding from
`docs/reviews/s-001-dedup-key-namespacing.md`).
Base: working tree on `main` at `d33c8d1`, with the uncommitted S-1 and S-2 fixes applied.
Agent: `enterprise-delivery` (plan + implement + self-review in one pass).

---

## Approval gate

`CLAUDE.md` and `.claude/agents/enterprise-delivery.md` forbid implementation without an
approved plan. **Gate 2 was authorized in-session by the user**, in the assignment message that
commissioned this task ("Run all stages in one pass … Gate 2 is authorized in-session; record it
in the plan"). Recorded here as the required written trace. No commit, stage, push, or branch is
authorized — the working tree is left for the user.

Independence caveat, stated up front: this is a **security** change reviewed by the agent that
implemented it. `.claude/agents/enterprise-delivery.md` says to say so when a task warranted the
per-gate agents. This one did. The compensating measures taken are listed in the review's
*What I verified* section (claims re-derived by running commands, not by recalling intent).

---

## 1. The gap, verified

### S-4 — no service-to-service auth

`apps/usage-service/src/middleware/tenant-context.middleware.ts:24-30` is the only thing standing
between a caller and a tenant's data:

```ts
const tenantId = request.headers[USAGE_SERVICE_HEADERS.TENANT_ID];

if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
  throw new TenantContextMissingError();
}

request.tenantId = tenantId;
```

Anything that can reach the service's port and set one header is that tenant. Verified by running
the existing route tests: they call `app.inject` with `x-tenant-id` and nothing else, and get
`202` / `200`.

`docs/reviewer-checklist.md` §3 requires `X-Internal-Secret` on internal endpoints and requires
services with internal-only routes to fail fast when `INTERNAL_API_SECRET` is missing.
usage-service does neither. `apps/billing-service` and `apps/worker-service` both already ship an
`internal-auth.middleware.ts`; usage-service is the outlier.

**Why it is not exploited today:** `apps/gateway/src/middleware/guards.middleware.ts:43-47`
deletes inbound `x-tenant-id` / `x-user-id` / `x-user-role`, and
`apps/gateway/src/plugins/proxy.plugin.ts:30-35` re-injects them from verified JWT context. That
mitigation holds *only* while the gateway is the sole network path. It is a deployment property,
not a code property, and nothing in the repo enforces it.

**Why now:** before T-035 the exposed surface was write-only (`POST /v1/usage/events`).
`GET /v1/usage/summary` (`apps/usage-service/src/routes/usage.routes.ts`) makes direct
reachability a cross-tenant **read**. Same hole, different impact class.

### M-2 — any non-empty string is accepted as a tenant id

S-1 now builds dedup keys as `` `${DEDUP_CONSTANTS.KEY_PREFIX}${tenantId}:${idempotencyKey}` ``
(`apps/usage-service/src/services/deduplication.service.ts:41`). With an unvalidated tenant id,
tenant `a` + key `b:x` and tenant `a:b` + key `x` both produce `dedup:a:b:x` — S-1's own
vulnerability in miniature. S-1's reviewer recorded this as M-2 and noted that S-1 and S-4 rest
on the *same* single point of failure (gateway-only ingress), so they are correctly fixed
together.

**Tenant id format, verified not assumed:** `prisma/schema.prisma:12` —
`id String @id @default(uuid())`. `packages/shared-validation/src/index.ts:19,38` already exports
`uuidSchema` / `tenantIdSchema` built on `z.string().uuid()`. Probed the installed zod (3.25.76)
directly:

| value | `z.string().uuid()` |
|---|---|
| `11111111-1111-4111-8111-111111111111` (route-test fixture) | accepted |
| `11111111-1111-1111-1111-111111111111` (`prisma/seed.ts:9` dev tenant) | accepted |
| `00000000-0000-0000-0000-000000000000` (nil) | accepted |
| `tenant-1`, `tenant1`, `a:b` | rejected |
| `"  <valid uuid>  "` | rejected |

So the check is strict enough to make a `:` unrepresentable in a tenant id, and loose enough not
to reject the dev seed's v1-shaped id. Both properties matter.

### Existing fixtures with non-UUID tenant ids — surveyed, not assumed

`grep -rn "tenant-1\|tenant1\|x-tenant-id"` across the workspace:

| file | value | flows through the middleware? |
|---|---|---|
| `apps/usage-service/tests/usage-events.route.test.ts:9` | UUID | **yes** — already valid |
| `apps/usage-service/tests/usage-summary.route.test.ts:11-12` | UUIDs | **yes** — already valid |
| `apps/usage-service/tests/middleware.tenant-context.unit.test.ts:8` | UUID | **yes** — already valid |
| `apps/usage-service/tests/usage.controller.unit.test.ts:13` | UUID | no (fake request object) |
| `apps/usage-service/tests/usage.repository.unit.test.ts:9-10` | UUIDs | no |
| `apps/usage-service/tests/usage.service.unit.test.ts:8` | UUID | no |
| `apps/usage-service/tests/events.controller.unit.test.ts` (×9) | `"tenant-1"` | no — controller called directly |
| `apps/usage-service/tests/ingestion.service.unit.test.ts` (×20) | `"tenant-1"` | no — service called directly |
| `apps/usage-service/tests/deduplication.service.unit.test.ts:7-8,144` | `"tenant1"`, `"tenant2"` | no — service called directly |
| `apps/gateway/tests/proxy.plugin.unit.test.ts:95` | `"tenant-1"` | no — gateway-side |

**Every fixture that actually crosses the validated boundary is already a UUID** (T-034 and T-031
chose UUIDs; `git log -1` confirms neither route test has been touched since). The `tenant-1` /
`tenant1` fixtures live in unit tests that construct a request object or call a service directly,
below the middleware, so UUID validation cannot break them.

**Decision — update them anyway, deliberately:** after this change a non-UUID tenant id is
unreachable at runtime, so a downstream unit test asserting on `"tenant-1"` is testing a state the
system can no longer be in. Leaving them is not a *failure*, it is a slowly rotting fixture that
teaches the next reader the wrong invariant. They are updated to UUID constants in the same
change. This is the opposite of weakening the validation to fit the fixtures, which is the
failure mode the assignment warns about.

Scope caveat: `deduplication.service.unit.test.ts` and `ingestion.service.unit.test.ts` are two of
the five files S-1 edited and are uncommitted. Edits here are additive to S-1's, never reverting
them; S-1's assertions are preserved verbatim apart from the fixture value.

---

## 2. Scope

### In scope
1. `INTERNAL_API_SECRET` in usage-service's Zod env schema — required, min length, fail fast.
2. An `onRequest` guard on usage-service enforcing `X-Internal-Secret`, skipping `/health`,
   using a timing-safe comparison.
3. The same env requirement on the gateway, and header injection in the gateway proxy.
4. UUID validation of `X-Tenant-Id` (M-2).
5. Constants for every new header name, error code, message, and status code.
6. `known-gaps.md`: remove S-4; record that M-2 is closed.
7. `docs/reviewer-checklist.md` §3: record per-service compliance.
8. Env examples, docker compose, CI env, test setup files kept consistent.

### Out of scope (reported, not fixed)
- **analytics-service** has no internal-secret guard and no `INTERNAL_API_SECRET`. It currently
  exposes only `/health` (`apps/analytics-service/src/app.ts`), so there is no tenant data to
  reach — but it is proxied at `/v1/analytics` and the gap becomes live the moment a route lands.
- **billing-service / worker-service** have a guard, but (a) it compares with `!==`, not
  timing-safe; (b) it reads `process.env.INTERNAL_API_SECRET` directly instead of the validated
  env schema, so no minimum length is enforced; (c) `reply.status(401).send(...)` is not
  `return`ed. Each is a separate finding for `known-gaps.md`, not a usage-service change.
- **auth-service** is intentionally public at `/v1/auth/register|login|refresh`.
- S-3, S-5, S-6, S-7 — untouched.
- Backporting the env-schema pattern to billing/worker (touches 2 services' startup contracts).

---

## 3. Design decisions

### D-1 · Guard placement: `onRequest`, registered **before** the tenant-context hook

Fastify runs `onRequest` hooks in registration order, so `app.ts` becomes:

```ts
registerGlobalErrorHandler(app);
registerUsageInternalAuthMiddleware(app, env.INTERNAL_API_SECRET);  // ← new, first
registerUsageTenantContextMiddleware(app);
```

Rationale, in order of weight:

1. **An unauthenticated caller must not reach tenant work at all.** If the tenant hook ran first,
   an anonymous request with a valid-looking `x-tenant-id` would have `request.tenantId`
   populated, logged, and traced before rejection. Tenant context is a privileged fact; deriving
   it for a caller that has not proved it may talk to the service is exactly the boundary
   inversion S-4 is about.
2. **Distinct failures must not be conflated.** "You are not the gateway" (401 `UNAUTHORIZED`) and
   "you are the gateway but sent a bad tenant" (401 `TENANT_CONTEXT_MISSING` /
   `TENANT_CONTEXT_INVALID`) are different operator signals. Ordering keeps them separable and
   makes the *first* failure the outer one.
3. **`onRequest`, not `preHandler`.** `onRequest` is the earliest hook in Fastify's lifecycle —
   before body parsing and validation. Rejecting there means an unauthenticated caller cannot make
   usage-service parse a 1 MB JSON body. billing/worker use `preHandler`; that is weaker, and is
   listed as an out-of-scope finding rather than copied.
4. **Global hook, not a route-group `register`.** billing/worker scope their guard to an
   encapsulated internal-route plugin. usage-service has no public routes other than `/health`,
   so a global hook with an explicit `/health` exemption fails *closed*: a route added tomorrow is
   protected by default. A route-group guard fails *open* for anything registered outside it.

The `/health` exemption is shared by both hooks through one predicate
(`src/middleware/public-routes.ts`) rather than duplicating the comparison, so the exempt set has
exactly one definition.

### D-2 · Timing-safe comparison — SHA-256 digests, not raw `timingSafeEqual`

`===` on a secret leaks its prefix: V8's string comparison returns at the first differing byte, so
response latency is a function of how many leading bytes the attacker guessed right. Against a
network-reachable endpoint with no rate limit of its own, that turns a 32-byte secret from a
2^256 search into a ~32×256 one, byte by byte.

`crypto.timingSafeEqual` is the fix, but it **throws** on unequal buffer lengths — so the naive
form needs a length check first, and that check is itself a fast, early-exit oracle for the
secret's length. So both sides are hashed to a fixed-width digest first:

```ts
const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
return timingSafeEqual(digest(provided), digest(expected));
```

Both digests are always 32 bytes, so `timingSafeEqual` never throws and the comparison time is
independent of both the length and the content of the candidate. SHA-256's collision resistance
makes digest equality equivalent to string equality here. (`crypto.timingSafeEqual` is
constant-time *for equal-length inputs* — the hash is what guarantees that precondition without
branching on the secret.)

### D-3 · One error for "missing" and "wrong"

Both produce `401` / `UNAUTHORIZED` / the same message. Distinguishing them tells an attacker
whether the header name is even right. Compare with the tenant errors, which *are* distinguished
(`TENANT_CONTEXT_MISSING` vs `TENANT_CONTEXT_INVALID`) — those are only reachable *after* the
caller has proved it is the gateway, so the operator value outweighs the (now internal) leak.

### D-4 · A malformed tenant id gets its own code

`TENANT_CONTEXT_INVALID`, 401. Reusing `TENANT_CONTEXT_MISSING` for a *present* header would make
the existing message ("X-Tenant-Id header is required") a lie. Additive: the missing / empty /
whitespace branch keeps its existing code, so no existing assertion changes.

### D-5 · Validate, do not sanitize

The middleware rejects a non-UUID rather than trimming or lowercasing it. Normalisation invites
the question "normalised to what?" at every later comparison; rejection makes the value that
reaches `request.tenantId` byte-identical to what the gateway signed off on. `z.string().uuid()`
rejects surrounding whitespace (probed above), which is the property that closes M-2.

### D-6 · The gateway injects the secret **unconditionally**

`rewriteRequestHeaders` currently early-returns the caller's own headers when there is no
`authContext` (public auth routes). Injecting only in the authenticated branch would leave one
path where a client-supplied `x-internal-secret` is forwarded verbatim to an upstream — a header
smuggling path that is inert today only because auth-service does not read that header. The secret
asserts *"this request came through the gateway"*, which is independent of whether a user identity
exists, so it is set on every proxied request and overwrites whatever the client sent.

Belt and braces: `x-internal-secret` is added to the gateway's
`stripSpoofableIdentityHeaders` list. It is the same class of header as `x-tenant-id` — trusted
downstream, therefore never accepted from outside.

### D-7 · Minimum secret length 32, as a shared constant

`docs/epics/epic-8-billing-service.md:46` specifies `z.string().min(32)`; the gateway's
`JWT_SECRET` already uses `.min(32)`. The value now appears in two env schemas, so per
`.claude/rules/constants.md` ("before adding a third copy of a literal, promote it") it goes into
`packages/shared-types` next to the existing `INTERNAL_AUTH_HEADERS` / `INTERNAL_AUTH_RESPONSES`.

Consequence, deliberately accepted: `.env.example`'s `INTERNAL_API_SECRET=dev-local-secret`
(16 chars) and compose's `test-internal-secret` (20 chars) are now too short and must be
lengthened. A fail-fast rule that the repo's own sample config violates is worse than no rule.

### D-8 · Env schema, not `process.env` at build time

Requirement 1 and `docs/reviewer-checklist.md` §3 both say fail fast at startup.
`apps/usage-service/src/config/env.ts` is evaluated at module load through
`parseEnv` (`packages/shared-config/src/index.ts`), which throws on the first invalid field. That
is strictly earlier and stricter than billing/worker's `process.env.INTERNAL_API_SECRET ?? ""`
plus a `.trim()` check after the container is built. Deviation from the neighbouring services is
intentional and is recorded as a backport recommendation rather than copied.

---

## 4. Files to change

### Production
| File | Change |
|---|---|
| `packages/shared-types/src/index.ts` | add `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH`, `INTERNAL_AUTH_RESPONSES.MESSAGE_UNAUTHORIZED` |
| `apps/usage-service/src/config/env.ts` | `INTERNAL_API_SECRET: z.string().min(32)` |
| `apps/usage-service/src/constants.ts` | `HEADERS.INTERNAL_SECRET`, `CODE_UNAUTHORIZED`, `MESSAGE_UNAUTHORIZED`, `CODE_TENANT_CONTEXT_INVALID`, `MESSAGE_TENANT_CONTEXT_INVALID` |
| `apps/usage-service/src/errors/index.ts` | `InternalAuthRequiredError`, `TenantContextInvalidError` |
| `apps/usage-service/src/middleware/public-routes.ts` | **new** — single definition of the auth-exempt route set |
| `apps/usage-service/src/middleware/internal-auth.middleware.ts` | **new** — the `onRequest` guard |
| `apps/usage-service/src/middleware/tenant-context.middleware.ts` | UUID validation; use the shared exemption predicate |
| `apps/usage-service/src/middleware/index.ts` | export the new registrar |
| `apps/usage-service/src/app.ts` | register internal auth **before** tenant context |
| `apps/gateway/src/config/env.ts` | `INTERNAL_API_SECRET: z.string().min(32)` |
| `apps/gateway/src/constants.ts` | `GATEWAY_HEADERS` — promote `x-tenant-id`/`x-user-id`/`x-user-role`/`x-request-id`/`x-internal-secret` out of the two files being edited |
| `apps/gateway/src/plugins/proxy.plugin.ts` | inject `x-internal-secret` unconditionally |
| `apps/gateway/src/middleware/guards.middleware.ts` | strip inbound `x-internal-secret`; use the new constants |
| `apps/gateway/src/app.ts` | pass `config.INTERNAL_API_SECRET` to the proxy registrar |

### Config / docs
`.env.example` · `apps/usage-service/.env.example` · `apps/gateway/.env.example` ·
`docker/docker-compose.yml` · `.github/workflows/ci.yml` · `.claude/rules/known-gaps.md` ·
`docs/reviewer-checklist.md`

### Tests (modified in place where one exists; no parallel files)
`apps/usage-service/tests/setup.ts` · `tests/env.schema.unit.test.ts` ·
`tests/middleware.tenant-context.unit.test.ts` · `tests/usage-events.route.test.ts` ·
`tests/usage-summary.route.test.ts` · `tests/events.controller.unit.test.ts` ·
`tests/ingestion.service.unit.test.ts` · `tests/deduplication.service.unit.test.ts` ·
`apps/gateway/tests/proxy.plugin.unit.test.ts` · `apps/gateway/tests/guards.middleware.unit.test.ts` ·
`apps/gateway/tests/config/container.unit.test.ts` · `apps/gateway/tests/smoke.test.ts` ·
`packages/shared-types/tests/unit.test.ts`

**New:** `apps/usage-service/tests/middleware.internal-auth.unit.test.ts` — there is no existing
internal-auth test to extend, and it mirrors the existing `middleware.tenant-context.unit.test.ts`
naming.

---

## 5. Test plan (pseudo-TDD — skeletons, confirm red, then implement)

Required scenarios, each mapped to where it lives:

| # | Scenario | File |
|---|---|---|
| 1 | valid `X-Internal-Secret` → request succeeds | `middleware.internal-auth.unit.test.ts`, `usage-events.route.test.ts`, `usage-summary.route.test.ts` |
| 2 | missing secret → 401 `UNAUTHORIZED` | `middleware.internal-auth.unit.test.ts` |
| 3 | wrong secret → 401 `UNAUTHORIZED` | `middleware.internal-auth.unit.test.ts` |
| 4 | **rejected before tenant context is established** | `middleware.internal-auth.unit.test.ts` — a request with *no* `x-tenant-id` and a *bad* secret must return `UNAUTHORIZED`, not `TENANT_CONTEXT_MISSING`; plus a route-level test asserting the controller/service spy was never called |
| 5 | `/health` reachable with no secret and no tenant | `middleware.internal-auth.unit.test.ts`, and already covered end-to-end by `smoke.test.ts` |
| 6 | non-UUID `X-Tenant-Id` → 401 `TENANT_CONTEXT_INVALID` | `middleware.tenant-context.unit.test.ts` (cases: `tenant-1`, `a:b` — the M-2 shape — and a padded UUID) |
| 7 | startup fails fast when `INTERNAL_API_SECRET` is absent | `env.schema.unit.test.ts` — schema-level (`safeParse` fails; too-short fails; boundary length passes) **and** module-level: `vi.resetModules()`, delete the var, `await import("../src/config/env")` rejects |
| 8 | gateway injects the secret on every proxied request, authenticated or not | `apps/gateway/tests/proxy.plugin.unit.test.ts` |
| 9 | gateway strips an inbound `x-internal-secret` | `apps/gateway/tests/guards.middleware.unit.test.ts` |

Test-honesty guards, per `.claude/rules/testing.md`:
- Scenario 4's route-level assertion is a **negative** on a spy (`expect(spy).not.toHaveBeenCalled()`),
  which is what actually proves ordering; a status-code assertion alone would pass even if the
  tenant hook ran first.
- No test asserts a mock's own return value.
- Every new literal (`401`, `UNAUTHORIZED`, header names) is imported from constants —
  `.claude/rules/constants.md` applies to tests.
- Confirm-red is run per file and recorded verbatim in the review before any implementation.

Regression guard: the whole usage-service suite must stay green at **148 + new**, with no
existing assertion deleted or relaxed. Baseline captured before touching anything:
`Test Files 16 passed (16) / Tests 148 passed (148)`.

---

## 6. Validation

Task-scoped first (`test -- <file>` does **not** filter):

```
pnpm --filter @telemetry/usage-service exec vitest run tests/middleware.internal-auth.unit.test.ts
pnpm --filter @telemetry/usage-service exec vitest run tests/middleware.tenant-context.unit.test.ts
pnpm --filter @telemetry/usage-service exec vitest run tests/env.schema.unit.test.ts
pnpm --filter @telemetry/usage-service exec vitest run tests/usage-events.route.test.ts
pnpm --filter @telemetry/usage-service exec vitest run tests/usage-summary.route.test.ts
pnpm --filter @telemetry/gateway exec vitest run tests/proxy.plugin.unit.test.ts
pnpm --filter @telemetry/usage-service test && pnpm --filter @telemetry/gateway test
pnpm --filter @telemetry/usage-service typecheck && pnpm --filter @telemetry/usage-service lint
```

Then the full root gate across all 13 packages: `pnpm build`, `pnpm test`, `pnpm lint`,
`pnpm typecheck`.

`apps/usage-service/tests/rls.enforcement.integration.test.ts` (new, from S-2) needs a live
Postgres and the `telemetry_app` role; it must stay green and must not be modified.

Pre-existing warnings to distinguish from anything introduced: 4 in
`apps/usage-service/tests/ingestion.service.unit.test.ts`, 17 in auth-service — proven with
`git log -1 <file>` in the review, not asserted.

---

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | `.min(32)` breaks a config that ships a shorter secret | Every in-repo sample (`.env.example`, compose, CI, test setups) is updated in this change; the full gate plus the compose smoke step is what proves it |
| R-2 | Rejecting a non-UUID tenant id breaks a real caller | Only the gateway calls this service, and it injects the JWT's `tenantId`, which is `Tenant.id` — `@default(uuid())`. Verified against `prisma/schema.prisma:12`, not assumed |
| R-3 | Editing test files S-1 left uncommitted | Edits are additive; S-1's assertions preserved verbatim except the fixture value. Diff reviewed against `git diff` before and after |
| R-4 | Fixture churn hides a real regression | The 148-test baseline is captured before any edit and re-checked after |
| R-5 | Gateway now holds a second shared secret | It already holds `JWT_SECRET`; the new value is validated by the same schema and never logged |
| R-6 | A shared secret is coarse auth — it does not identify *which* caller | Accepted; it is what §3 mandates and what billing/worker use. mTLS or signed internal tokens is a platform-level follow-up, recorded, not attempted here |
| R-7 | Self-review on a security change | Stated in the approval gate; compensating measures in the review |

---

## 8. Pending task checklist

- [x] Baseline captured (usage-service 148 / 16 files)
- [x] Plan written
- [x] Test skeletons written, confirmed **red** (5 files / 30 tests failing, 169 total)
- [x] Implementation
- [x] Task-scoped validation
- [x] Full root gate, 13 packages — build / test / lint / typecheck all green, 21 warnings, all
      pre-existing and proven so with `git log -1`
- [x] `known-gaps.md` S-4 removed, M-2 recorded closed, S-8 and S-9 added
- [x] Self-review written to `docs/reviews/s-004-internal-service-auth.md`
- [x] Report — **nothing committed, staged, pushed, or branched**
