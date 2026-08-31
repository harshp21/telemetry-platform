# Rule — Known Security & Correctness Gaps

Open issues found during review that are **not yet fixed**. Check this list before working in
the affected area: do not reintroduce these patterns, do not assume the protection they
describe is active, and do not treat a passing test in these areas as evidence without
reading why it passes.

Update this file when an item is fixed (remove it) or when a new gap is accepted rather than
fixed (add it, with the reasoning).

---

## S-1 · Client idempotency keys are unprefixed and untenanted — **HIGH, open**

`apps/usage-service/src/services/ingestion.service.ts:111-113`

```ts
const idempotencyKey =
  event.idempotencyKey ||
  `${tenantId}:${event.eventType}:${...sourceId}:${event.occurredAt}`;
```

The **fallback** is tenant-scoped; a **client-supplied** `idempotencyKey` is not. It reaches
`redis.set(key, "1", "EX", 86400, "NX")` raw — no `dedup:` prefix, no tenant namespace.
`DEDUP_CONSTANTS.KEY_PREFIX` (`constants.ts:60`) is defined and used nowhere in `src/`.

**Impact:** tenant A sends `idempotencyKey: "abc"`; tenant B sends `"abc"` within the 24h TTL
→ `SET NX` fails → B's event is silently counted `duplicate` and dropped. An attacker holding
any tenant's credentials can pre-poison arbitrary keys and suppress another tenant's events
for the TTL window. Usage events drive billing, so this is cross-tenant suppression of
billable usage — silent, and indistinguishable from normal dedup in logs.

Secondary: with no prefix, a caller-supplied key can collide with the platform keyspace
(e.g. `telemetry:events`, the stream name in `STREAM_CONSTANTS`), which can leave a string at
a key the stream later needs (`WRONGTYPE`).

**Fix direction:** namespace every dedup key as `${KEY_PREFIX}${tenantId}:${key}` in one
helper used by both branches, so a client key can never be a top-level key and can never
cross a tenant boundary. Changing the key format resets in-flight dedup state — a deploy
consideration, not a correctness one.

---

## S-2 · RLS is inert — the app connects as a superuser — **HIGH, open**

`DATABASE_URL` connects as `postgres`, which is `rolsuper = t, rolbypassrls = t` (verify with
`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`).

**`FORCE ROW LEVEL SECURITY` does not stop superusers** — it only removes the *table owner's*
exemption. Every RLS policy in `prisma/migrations/**` is therefore bypassed in practice, and
the app-layer `WHERE tenantId` predicate is what is actually protecting tenant data.

Two files assert the opposite and are wrong: `base.repository.ts:52` and
`v1_2_force_row_level_security/migration.sql:2`.

**Fix direction:** run the application as a non-superuser role without `BYPASSRLS`.

---

## S-3 · The tests that would catch S-2 disable themselves — **HIGH, open**

`apps/auth-service/tests/rls.integration.test.ts:78, 96, 109` — all three substantive
assertions begin `if (isCurrentUserSuperuser) return;`.

The guard fires **precisely when** S-2 is present, so the suite reports green while asserting
nothing. This is an inverted signal, not a coverage gap.

**Fix direction:** run RLS assertions through a dedicated `NOSUPERUSER NOBYPASSRLS` probe
role and **fail** if that role cannot be created, rather than skipping.

---

## S-4 · usage-service has no service-to-service auth — **HIGH, open**

`apps/usage-service/src/middleware/tenant-context.middleware.ts:24-30` trusts `X-Tenant-Id`
with no `X-Internal-Secret` check, which `docs/reviewer-checklist.md` §3 requires.

Safe only because the gateway strips inbound `x-tenant-id` / `x-user-id` / `x-user-role` and
re-injects them from verified JWT context
(`apps/gateway/src/middleware/guards.middleware.ts:43-47`) — i.e. it holds only while the
gateway is the sole network path to the service.

T-035 raised the stakes: before it, the exposed surface was write-only; `GET /v1/usage/summary`
makes direct reachability a cross-tenant **read** path.

**Fix direction:** `INTERNAL_API_SECRET`-backed `onRequest` guard (skipping `/health`), with
the header injected by the gateway proxy; fail fast at startup if the secret is missing.

---

## S-5 · Clock-skew window is symmetric — backfill impossible — **MEDIUM, open**

`events.validator.ts:9` sets `CLOCK_SKEW_TOLERANCE_SECONDS: 5 * 60`, and the controller
applies it with `Math.abs`, so events more than 5 minutes **old** are rejected with
`FUTURE_CLOCK_SKEW`. Historical import or replay is impossible by construction, and the error
code misdescribes the past-timestamp case.

Note `docs/epics/epic-6-usage-service.md` describes this as "more than 24h in the future →
`400 VALIDATION_ERROR`", which matches neither the window nor the code. The only 24h constant
in the service is the dedup TTL.

---

## S-6 · `INGEST_BATCH_MAX` is dead config — **LOW, open**

`apps/usage-service/src/config/env.ts:14` defines and validates `INGEST_BATCH_MAX`; no
production code reads it. The enforced cap is a hard-coded `BATCH_SIZE_MAX: 100` in
`events.validator.ts:6`. Operators setting the env var get no effect and no warning.
