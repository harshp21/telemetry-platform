# Senior Review — S-4 Service-to-Service Auth for usage-service (+ M-2)

Review file: `docs/reviews/s-004-internal-service-auth.md`
Plan: `docs/plans/s-004-internal-service-auth.md`
Standard applied: `.claude/rules/review-standards.md` (Pre-QA + Final) + `docs/reviewer-checklist.md`
Scope reviewed: the S-4 slice of the working-tree diff against `d33c8d1` — 14 production files,
13 test files, 7 config/standards files, 3 new source/test files.

**Independence caveat, stated first.** This review was produced by the agent that wrote the
implementation, and `.claude/agents/enterprise-delivery.md` says to say so when a task warranted
the per-gate agents. **This one did** — it is a HIGH security gap on a cross-tenant read path. The
compensating measure taken was to re-derive every security-critical claim by *running* code
against the real `buildUsageServiceApp` / `buildGatewayApp` rather than reading the diff I just
wrote (see *What I verified by execution*). A self-review still cannot catch a blind spot it
shares with the implementation.

---

## Verdict

**CONDITIONAL — the gap is closed; three findings recorded, none blocking.**

S-4 and M-2 are both closed, and closed at the right layer: the secret check is an `onRequest`
hook registered ahead of tenant context, so an unauthenticated caller cannot cause tenant context
to exist at all — verified by running the real app, not by reading the registration order.
Findings M-1, L-1, L-2 below are residual; two of them are about *other* services and are recorded
in `known-gaps.md` as S-8 and S-9 rather than fixed here.

---

## Findings

### M-1 · MEDIUM — `/health?anything` requires the secret

`apps/usage-service/src/middleware/public-routes.ts:16` matches `request.url` exactly, so
`/health` is exempt but `/health?probe=1` is not. Verified by execution against the real app:

```
health, no headers            -> 200 {"status":"ok","service":"usage-service"}
health WITH query, no headers -> 401 {"code":"UNAUTHORIZED", ...}
```

This is inherited behaviour — the pre-existing tenant hook compared `request.url ===
USAGE_SERVICE_ROUTES.HEALTH` the same way — and it fails **closed**, which is the right direction
for a security guard. But it is a real operational trap: a health checker or load balancer that
appends a cache-buster would see the service as down.

**Verified not to bite today:** `docker/docker-compose.yml:14` builds the healthcheck URL as
`'http://127.0.0.1:' + process.env.PORT + '/health'` with no query, and
`apps/usage-service/tests/smoke.test.ts:27` fetches `${address.port}${USAGE_SERVICE_ROUTES.HEALTH}`.
Both are bare `/health`.

**Concrete fix (follow-up):** match on `request.routeOptions.url` (available from `onRequest` in
Fastify v5) instead of `request.url`, in `public-routes.ts` only — one line, and both hooks
inherit it because they share the predicate. Not done here because it changes the *existing*
tenant hook's exemption semantics as well, which is a behaviour change outside S-4's scope and
deserves its own red test.

### L-1 · LOW — billing / worker still ship the weaker guard (recorded as S-8)

`apps/billing-service/src/middleware/internal-auth.middleware.ts:9` and its byte-identical twin in
worker-service compare with `!==`, read `process.env.INTERNAL_API_SECRET` outside the env schema
(so `SECRET_MIN_LENGTH` is not enforced), and run at `preHandler` rather than `onRequest` with an
un-`return`ed `reply.send`. Full detail and fix direction: **S-8** in `.claude/rules/known-gaps.md`.

**Disposition: report, do not fix.** Out of scope per the assignment, and moving two other
services' startup contracts inside a usage-service security fix breaks the one-task-per-commit
rule. `docs/reviewer-checklist.md` §3 now carries a per-service compliance table so this is
visible at the next review rather than rediscovered.

### L-2 · LOW — analytics-service has no guard and no `INTERNAL_API_SECRET` (recorded as S-9)

`apps/analytics-service/src/app.ts` registers `/health` only, so there is no tenant data to reach
and this is genuinely LOW rather than a live hole. But the gateway proxies `/v1/analytics` to it
and now sends the secret there too. Recorded as **S-9**. **Disposition: report, do not fix.**

### NIT-1 · The gateway has two private copies of `isPublicRoute`

`apps/gateway/src/middleware/auth.middleware.ts:31` and
`apps/gateway/src/plugins/rate-limit.plugin.ts:33` each define their own. Pre-existing, unrelated
to this change (usage-service's new `public-routes.ts` is a third *service's* route set, not a
fourth copy of the gateway's). Flagged so it is not mistaken for something S-4 introduced.

### NIT-2 · Pre-existing magic literals in the two route test files

`usage-events.route.test.ts` still asserts bare `202` / `400` / `500` / `"BATCH_TOO_LARGE"` /
`"INTERNAL_ERROR"`, and the older half of `middleware.tenant-context.unit.test.ts` asserts bare
`200` / `401` / `"TENANT_CONTEXT_MISSING"`. `.claude/rules/constants.md` applies to tests, so these
are findings — but they predate this change (`git log -1` → `c26f370`, `7df3fbe`). **Every
assertion added by S-4 uses constants**; converting the neighbours would inflate the diff of a
security fix with unrelated churn.

---

## What I verified by execution

Claims re-derived by running code against the real app builders, not by reading the diff.

**1. Hook order inside the real `buildUsageServiceApp` — not just in the unit test's manual setup.**
Read back Fastify's own `onRequest` array after `ready()`:

```
USAGE onRequest hook order: [ '(anonymous)', 'usageTenantContextHandler' ]
```

The anonymous closure is the internal-auth handler (`buildUsageInternalAuthHandler` returns an
arrow function). Internal auth is first.

**2. Rejection genuinely happens *before* tenant work, on the real app.** A request with a hostile
tenant id *and* no secret:

```
no secret + colon tenant -> 401 {"code":"UNAUTHORIZED","message":"A valid X-Internal-Secret header is required"}
```

If the tenant hook ran first this would be `TENANT_CONTEXT_INVALID`. This is the assertion that
actually distinguishes the two orderings; a status-code check alone would not (both are 401).
Backed at route level by `expect(spy).not.toHaveBeenCalled()` on `usageService.getUsageSummary`
and on `deduplication.isNew` / `streamPublisher.publish`.

**3. The gateway really does deliver the header over the wire, and really does overwrite a forged
one.** Stood up a throwaway upstream that echoes what it received, pointed the gateway's
`USAGE_SERVICE_URL`/`AUTH_SERVICE_URL` at it, and injected a request to the **public**
`/v1/auth/login` route (no `authContext` — the early-return branch) while supplying a forged
`x-internal-secret`:

```
gateway -> upstream: 200 {"seenInternalSecret":"probe-internal-api-secret-at-least-32-chars","seenTenant":null}
```

The upstream saw the gateway's own secret, not `ATTACKER-SUPPLIED`, and saw no tenant header. This
is what justifies D-6 (inject unconditionally): under the conditional design that branch would
have forwarded the attacker's value verbatim. `@fastify/http-proxy`'s `rewriteRequestHeaders` is
confirmed to be on the real request path, not merely a callback the unit test can invoke.

**4. `/health` is reachable with no secret and no tenant on the real app** — `200`, above.

**5. UUID acceptance is what I claimed.** Probed the installed zod (3.25.76) directly rather than
trusting the plan: `tenant-1`, `tenant1`, `a:b` and a whitespace-padded UUID are rejected;
`prisma/seed.ts`'s non-v4 `11111111-1111-1111-1111-111111111111` and the route fixtures are
accepted. The seed id is pinned by its own test so a future tightening to strict v4 fails loudly
rather than silently breaking the dev fixture.

**6. `timingSafeEqual` cannot throw here.** Both operands are SHA-256 digests, always 32 bytes.
Exercised with a shorter candidate (`INTERNAL_SECRET.slice(0, -1)`) and an equal-length wrong
secret; both return 401 rather than a 500 from a thrown length error. Under the naive
`timingSafeEqual(Buffer.from(a), Buffer.from(b))` form that first case would have been a 500.

**7. The compose stack still starts.** Parsed `docker/docker-compose.yml` and resolved the YAML
anchors: usage-service, gateway, billing-service and worker-service all now receive a ≥32-char
`INTERNAL_API_SECRET`; auth-service and analytics-service correctly do not. The healthcheck URL is
bare `/health` (relevant to M-1).

**8. No other in-repo caller reaches usage-service directly.**
`grep -rn "usage/events\|usage/summary\|USAGE_SERVICE_URL"` over `apps` + `packages`, excluding
usage-service and gateway, returns nothing. The gateway is the only client that needed teaching to
send the header.

**9. The secret is not logged.** Fastify's default request serializer logs `method`/`url`/`host`/
`remoteAddress` only — confirmed in the suite's own log output — and the error path logs an
`AppError` whose message is a fixed string. No code path passes `INTERNAL_API_SECRET` or the
inbound header to a logger.

---

## What I could NOT verify

1. **That the deployed topology actually sets matching secrets.** The gate proves the code demands
   a secret; it cannot prove the operator gives the gateway and usage-service the *same* one. A
   mismatch is a hard, loud failure (every proxied request 401s) rather than a silent one, which is
   the right failure mode, but it is only caught at deploy time. The compose stack is the closest
   in-repo proof and it is not exercised outside CI's `docker compose up --wait` step, which I did
   not run locally.
2. **Timing-safety as an empirical property.** I verified the *construction* (fixed-width digests,
   no length branch, no `===` on the secret) by reading and exercising the code. I did not measure
   response-time distributions, which is the only thing that would prove the absence of a
   side channel end to end — and V8/libuv noise would likely swamp it at this scale anyway.
3. **Whether a real reverse proxy in front of usage-service could reintroduce a duplicate
   `x-internal-secret`.** Node collapses duplicate headers into a comma-joined string, which the
   guard rejects, and the array case is rejected outright; but I could not test every proxy that
   might sit in the path in production.
4. **auth-service's test count moved 126 → 127 during this session.**
   `apps/auth-service/tests/rls.integration.test.ts` was **not** modified at the start of my session
   and **is** modified now — a concurrent agent (S-3, by the content) edited it mid-run. I did not
   touch anything under `apps/auth-service`; `git diff --name-only -- apps/auth-service` lists only
   `.env.example`, `src/repositories/base.repository.ts`, `tests/rls.integration.test.ts` and
   `tests/setup.ts`, all from S-2 and S-3. The +1 is not mine, and I could not verify it further
   without reading another agent's in-flight work.

---

## Review priority order (per `.claude/rules/review-standards.md`)

**1. Tenant isolation and RLS.** The change strengthens layer 1 and adds a new layer 2. It does not
touch `TenantScopedRepository`, `withTenant`, or any policy. `rls.enforcement.integration.test.ts`
(S-2's standing proof) is unmodified and green — 7 tests, against a live `telemetry_app`
connection. The tenant id reaching `request.tenantId` is now provably a UUID, which is what makes
S-1's `dedup:<tenantId>:<key>` unambiguous. **Pass.**

**2. Injection risk in raw SQL.** No SQL touched. The tenant id feeding
`usage.repository.ts:116`'s `Prisma.sql` bound parameter is now narrower than before, never wider.
**Pass.**

**3. Correctness — boundaries, error contracts.** New contract: `401 UNAUTHORIZED` for a
missing *or* wrong secret (identical response for both — asserted by a dedicated test that
compares the two bodies with `toEqual`), `401 TENANT_CONTEXT_INVALID` for a present-but-malformed
tenant id, `401 TENANT_CONTEXT_MISSING` unchanged for absent/empty/whitespace. No existing status
code or error code changed. **Pass.**

**4. Clean code gate.** No new magic literals in production code — header names come from
`INTERNAL_AUTH_HEADERS` via `USAGE_SERVICE_HEADERS`/`GATEWAY_HEADERS`, codes and messages from
`INTERNAL_AUTH_RESPONSES`, the length bound from `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH`,
statuses from `USAGE_SERVICE_RESPONSES`. The min-length appears in two env schemas and is
therefore promoted to `packages/shared-types` rather than duplicated. Pre-existing literals in the
gateway's `guards.middleware.ts` (`x-tenant-id` etc.) were promoted while editing those exact
lines. Residual: NIT-2. **Pass with NIT.**

**5. Type safety.** No `any`, no new `unknown`. `GATEWAY_SPOOFABLE_HEADERS` is a `readonly` tuple of
literal types, so `delete request.headers[header]` stays typed. `providedSecret` is narrowed with
`typeof !== "string"` before use rather than cast. **Pass.**

**6. Production readiness.** Fails fast at module load with a message naming the field
(`Invalid environment configuration for INTERNAL_API_SECRET: ...`) — earlier and stricter than
billing/worker's post-container `.trim()` check. Rejection at `onRequest` means an unauthenticated
caller never gets its body parsed, so the guard is also a cheap DoS shield. Overhead per request is
two SHA-256 hashes of a ≤64-byte input — negligible next to the JSON parse it now precedes. No new
query paths, so no index implications. **Pass.**

**7. Test honesty.** The ordering claims rest on **negative spy assertions**
(`expect(getUsageSummary).not.toHaveBeenCalled()`), not on status codes, because a status code
alone cannot distinguish the two hook orders — both are 401. No test asserts a mock's own return
value. The `/health` exemption is asserted against the real `buildUsageServiceApp`, not a
hand-assembled Fastify instance. Every new test was confirmed red before the fix (below). **Pass.**

**8. Plan alignment and scope creep.** Deviations listed below; each is argued. **Pass.**

---

## Confirm-red — every new test failed before the fix

Run after the tests and the inert constants were in place, before any behaviour was implemented:

```
 Test Files  5 failed | 12 passed (17)
      Tests  30 failed | 139 passed (169)
```

The five red files were exactly the five carrying new or changed expectations:

| file | red because |
|---|---|
| `tests/middleware.internal-auth.unit.test.ts` | whole file failed to load — `registerUsageInternalAuthMiddleware` did not exist |
| `tests/env.schema.unit.test.ts` | 6 failed — `INTERNAL_API_SECRET` was not in `EnvSchema`, so absent/short/empty all parsed successfully and the module-load import resolved instead of throwing |
| `tests/middleware.tenant-context.unit.test.ts` | 7 failed — `tenant-1`, `a:b`, `<uuid>:x`, padded, truncated and non-hex tenant ids were all **accepted** (200), and the rejected value was attached to the request |
| `tests/usage-events.route.test.ts` | 7 failed — no guard existed, so the no-secret case returned 400/202 instead of 401 |
| `tests/usage-summary.route.test.ts` | 10 failed — including `expected 200 to be 401` on the unauthenticated read path, i.e. the S-4 vulnerability itself reproduced as a failing test |

The two most security-relevant reds, verbatim:

```
FAIL tests/usage-summary.route.test.ts > returns 401 UNAUTHORIZED and never queries when the internal secret is absent
AssertionError: expected 200 to be 401 // Object.is equality
```

```
FAIL tests/middleware.tenant-context.unit.test.ts > UUID validation (M-2) > rejects a value containing a colon with 401 TENANT_CONTEXT_INVALID
```

After implementation: **17 files, 179 tests, all passing** (baseline was 16 files / 148 tests).

---

## Compile-Time Validation — all 13 packages

```
pnpm typecheck ->  Tasks: 13 successful, 13 total   (0 cached)   Time: 18.19s
pnpm lint      ->  Tasks: 13 successful, 13 total   (0 cached)   Time: 32.667s
pnpm test      ->  Tasks: 13 successful, 13 total                Time: 17.761s
pnpm build     ->  Tasks: 13 successful, 13 total   (0 cached)   Time: 20.447s
```

Per-package test counts from the `pnpm test` run:

| package | tests | vs. baseline |
|---|---|---|
| `@telemetry/usage-service` | 17 files / **179** | 16 / 148 → **+31** |
| `@telemetry/gateway` | 8 files / **38** | 8 / 37 → **+1** |
| `@telemetry/auth-service` | 14 files / **127** | 126 → +1, **not mine** (see *What I could NOT verify* #4) |
| `@telemetry/worker-service` | 4 / 19 | unchanged |
| `@telemetry/billing-service` | 4 / 18 | unchanged |
| `@telemetry/analytics-service` | 4 / 18 | unchanged |
| `@telemetry/shared-types` | 1 / 7 | unchanged (assertions added to an existing test, no new `it`) |
| `shared-config` 4 · `shared-tracing` 2 · `shared-validation` 15 · `shared-logger` 4 · `shared-utils` 18 | | unchanged |

### Warning classification — proven, not asserted

`pnpm lint` reports **0 errors** and exactly **21 warnings**, matching the pre-change baseline
figure to the line:

```
@telemetry/usage-service:lint: ✖ 4 problems (0 errors, 4 warnings)
@telemetry/auth-service:lint:  ✖ 17 problems (0 errors, 17 warnings)
```

- usage-service's 4 are `no-unsafe-assignment` at `tests/ingestion.service.unit.test.ts:339,340,543,544`.
  `git log -1` on that file → `c26f370 feat(usage-service): implement T-031 event ingestion endpoint`.
  Those four lines read `timestamp: expect.any(Number)` / `eventId: expect.any(String)`; my only
  edits to that file were 20 replacements of the string `"tenant-1"` on `const tenantId = …` lines.
  Not mine.
- auth-service's 17 are in `tests/auth.service.unit.test.ts` (`d68e719`) and
  `tests/user.repository.unit.test.ts` (`e3d7556`). `git diff --name-only -- apps/auth-service`
  confirms I touched neither.

**No warning was introduced by this change, and none was waved through as pre-existing without a
`git log` behind it.**

---

## Deviations from the plan

1. **`INTERNAL_API_SECRET` goes through the Zod env schema, unlike billing/worker.** Planned as
   D-8 and carried out. The neighbouring services read `process.env` directly. The plan's rule is
   "mirror the neighbouring service" (`CLAUDE.md` §5), and this deliberately does not — because
   `docs/reviewer-checklist.md` §3 says *fail fast*, and a check that runs after the DI container is
   built is not fast enough. Recorded as a backport recommendation (S-8) rather than silently
   diverging.
2. **The gateway's identity headers were promoted to constants.** Not in the original file list.
   Justified: `.claude/rules/constants.md` is a required review gate, and I was editing those exact
   lines in both `guards.middleware.ts` and `proxy.plugin.ts`. Leaving three magic strings on lines
   I rewrote would be a finding against this change.
3. **`x-internal-secret` added to the gateway's strip list.** Not in the assignment. Justified: the
   header is now trusted downstream, which puts it in exactly the class
   `stripSpoofableIdentityHeaders` exists for. It is also belt-and-braces — the unconditional
   injection already overwrites it — so it costs nothing and closes the case where someone later
   makes the injection conditional again.
4. **Two new `known-gaps.md` entries (S-8, S-9) rather than a bare mention in the report.** The
   file's own preamble says to add a gap when it is accepted rather than fixed. Ids continue from
   S-7; nothing was renumbered, and S-4's id is now absent, which the preamble defines as "fixed".
5. **Downstream `"tenant-1"` / `"tenant1"` fixtures updated to UUIDs** in
   `events.controller.unit.test.ts` (9), `ingestion.service.unit.test.ts` (20) and
   `deduplication.service.unit.test.ts` (3). None of these flow through the middleware, so none
   *had* to change. Changed deliberately because a non-UUID tenant id is now an unreachable state,
   and a fixture asserting on an unreachable state teaches the next reader the wrong invariant.
   S-1's assertions were preserved verbatim apart from the value — including its literal
   wire-format pin, which now reads
   `expect(keyOfSetCall(0)).toBe("dedup:11111111-1111-4111-8111-111111111111:api.request:source1:1000")`,
   keeping the "no constant indirection" intent that S-1 wrote it for.

---

## What I left out, and why

- **No rate limit on the guard.** A brute-force attempt against `X-Internal-Secret` is currently
  unthrottled at usage-service (the gateway's rate limiter does not sit in front of a direct
  connection). With a ≥32-char secret compared in constant time this is not a practical attack, and
  adding a limiter would pull `@fastify/rate-limit` and a Redis dependency into the request path of
  a security fix. Noted, not fixed.
- **No secret rotation support.** Accepting two valid secrets during a rollover would make
  zero-downtime rotation possible. Out of scope; it is a platform concern spanning all four
  services that hold the secret.
- **No mTLS / signed internal tokens.** A shared secret cannot tell *which* internal service is
  calling. That is the checklist's chosen mechanism and what billing/worker already use;
  upgrading it is a platform-level decision, not a usage-service task.
- **`docs/development-setup.md` untouched.** Checked: it documents the database roles, not the env
  var inventory, so there was nothing to update. The three `.env.example` files carry the new var.

---

## Remaining risks and dispositions

| Risk | Sev | Disposition |
|---|---|---|
| `/health?query` requires the secret (M-1) | MEDIUM | **Accepted, follow-up.** Fails closed; compose healthcheck and smoke test both use bare `/health`, verified. Fix is one line in `public-routes.ts` but changes the pre-existing tenant hook too. |
| billing / worker keep the weaker guard (L-1) | LOW | **Accepted, reported.** `known-gaps.md` S-8 + checklist §3 table. |
| analytics-service has no guard (L-2) | LOW | **Accepted, reported.** `known-gaps.md` S-9. No tenant routes today. |
| Deployment must set matching secrets | MEDIUM | **Accepted.** Fails loudly, not silently. All in-repo configs updated and the compose YAML re-parsed to prove it. |
| Shared secret does not identify the caller | LOW | **Accepted.** Matches `docs/reviewer-checklist.md` §3 and the rest of the platform. |
| Self-review on a HIGH security change | MEDIUM | **Disclosed, not mitigated away.** Recommend an independent `senior-reviewer` pass before commit. |

---

## Registry updates

- `.claude/rules/known-gaps.md` — **S-4 removed** (fixed; the id is retired, never reused, per the
  file's preamble). **S-8** and **S-9** added.
- `.claude/rules/tenant-isolation.md` — the layer list is now **four** layers, naming
  `internal-auth.middleware` and the UUID requirement; the *Forbidden* list gains hook-ordering and
  non-UUID tenant ids; the gaps pointer now reads `(S-3, S-7, S-8, S-9)`.
- `docs/reviewer-checklist.md` §3 — two new rules (constant-time comparison; UUID tenant ids) plus a
  per-service compliance table.
- **M-2 from `docs/reviews/s-001-dedup-key-namespacing.md` is closed by this change.** S-1's review
  named the exact fix — "validate `X-Tenant-Id` as a UUID in `tenant-context.middleware.ts:26` using
  the existing `tenantIdSchema`" — and that is what was done (via `uuidSchema`, the same underlying
  `z.string().uuid()`; `tenantIdSchema` additionally brands the value, which `request.tenantId`'s
  `string` type does not need). M-2 was recorded only inside the S-1 review, not in
  `known-gaps.md`, so there was no open entry to retire.

---

## Sign-off

**CONDITIONAL — approved for commit**, with:

1. M-1 (`/health?query`) accepted as a follow-up, not a blocker.
2. S-8 and S-9 recorded, not fixed.
3. **A recommendation that an independent `senior-reviewer` pass runs before the commit**, given
   this is a HIGH security fix reviewed by its own author.

Acceptance criteria: all seven assignment requirements satisfied; all six required test scenarios
covered and confirmed red first; full root gate green across 13 packages with no new warnings; no
regression in the other 12 packages. Nothing staged, committed, pushed, or branched.
