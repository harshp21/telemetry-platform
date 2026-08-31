# S-1 Implementation Plan: Dedup Key Namespacing (Cross-Tenant Event Suppression)

Plan file path: docs/plans/s-001-dedup-key-namespacing.md

Severity: **HIGH** · Class: cross-tenant security · Source: `.claude/rules/known-gaps.md` § S-1

## 1) Business Context

### Objective
Close a cross-tenant security defect in usage-service deduplication. Every Redis dedup key must
be namespaced by the platform dedup prefix **and** the authenticated tenant, so that a
client-supplied `idempotencyKey` can never (a) collide with another tenant's dedup state, nor
(b) become a top-level key in the platform keyspace.

### The defect

`apps/usage-service/src/services/ingestion.service.ts:111-113`

```ts
const idempotencyKey =
  event.idempotencyKey ||
  `${tenantId}:${event.eventType}:${event.metadata?.sourceId || "unknown"}:${event.occurredAt}`;
```

The **derived fallback** is tenant-scoped. The **client-supplied** branch is not. Either way the
string reaches `redis.set(key, "1", "EX", 86400, "NX")` in
`apps/usage-service/src/services/deduplication.service.ts:33-39` with no `dedup:` prefix and no
tenant namespace. `DEDUP_CONSTANTS.KEY_PREFIX` (`apps/usage-service/src/constants.ts:60`) is
defined and referenced nowhere in `src/`.

### User / business impact
- **Cross-tenant suppression of billable usage.** Tenant A posts `idempotencyKey: "abc"`. Within
  the 24h TTL, tenant B posts `"abc"`. `SET NX` returns `null`, so B's event is counted
  `duplicate` and dropped. Usage events drive billing, so this is silent revenue loss for the
  victim tenant.
- **Attacker-triggerable.** Anyone holding *any* tenant's credentials can pre-poison a dictionary
  of likely keys (sequential ids, order numbers, UUIDs harvested elsewhere) and suppress another
  tenant's ingestion for the TTL window.
- **Undetectable in logs.** The suppressed event is indistinguishable from a legitimate duplicate
  — same counter, same debug line.
- **Platform keyspace collision (secondary).** With no prefix, a client key of `telemetry:events`
  (`STREAM_CONSTANTS.DEFAULT_STREAM_NAME`) plants a Redis *string* at the key the stream
  publisher needs to be a *stream*, yielding `WRONGTYPE` on subsequent `XADD`.

### Why now
T-035 shipped `GET /v1/usage/summary`, which reads the aggregated result of this ingestion path.
Suppressed events are now visible as missing revenue in a customer-facing surface, not just in
internal counters.

## 2) Scope And Non-Goals

### In scope
- Move dedup key construction **into** `DeduplicationService`, so the service owns its keyspace.
- Namespace every key as `${DEDUP_CONSTANTS.KEY_PREFIX}${tenantId}:${rawKey}` in exactly one
  helper, covering both the client-supplied and derived-fallback branches.
- Update the `DeduplicationService` docstring contract (it currently instructs callers to pass a
  "full key including prefix" — the opposite of the new contract).
- Bound the length of a client-supplied `idempotencyKey` at the validator boundary.
- Update every existing test that asserts the old key shape; add regression coverage.
- Remove S-1 from `.claude/rules/known-gaps.md` (that file tracks **open** gaps only).

### Out of scope / non-goals
- **S-4** (no service-to-service auth on usage-service). Related — the gateway is what guarantees
  `X-Tenant-Id` is trustworthy — but a separate gap with its own fix direction.
- **S-2 / S-3** (RLS inert under a superuser role). Different layer, different fix.
- **S-5** (symmetric clock-skew window). Untouched.
- Validating `X-Tenant-Id` as a UUID in `tenant-context.middleware.ts`. Discussed under Risks
  (R-4) as a defense-in-depth follow-up; changing middleware validation is a separate contract
  change with its own blast radius.
- Any migration of in-flight Redis dedup state (see R-1).
- Changing the wire contract of `POST /v1/usage/events` beyond the key length bound.

## 3) Files To Change (Expected)

### Production code
- `apps/usage-service/src/services/deduplication.service.ts` — own the key construction; new
  `isNew(tenantId, key)` signature; private `buildKey`; corrected docstring contract.
- `apps/usage-service/src/services/ingestion.service.ts` — pass `tenantId` and the **raw** key
  (client-supplied or derived) as separate arguments; stop pre-building a Redis key.
- `apps/usage-service/src/validators/events.validator.ts` — add
  `INGESTION_CONSTANTS.IDEMPOTENCY_KEY_MAX_LENGTH` and apply it to `eventPayloadSchema`.

### Tests (modified in place — no parallel files)
- `apps/usage-service/tests/deduplication.service.unit.test.ts`
- `apps/usage-service/tests/ingestion.service.unit.test.ts`

### Deliberately unchanged
- `apps/usage-service/src/constants.ts` — `DEDUP_CONSTANTS.KEY_PREFIX` already exists with the
  right value; the bug is that nothing used it. No new constant needed there.
- `apps/usage-service/src/config/container.ts` — DI wiring is unaffected;
  `DeduplicationService` keeps the same constructor.
- `apps/usage-service/tests/usage-events.route.test.ts` — stubs `isNew` wholesale via
  `vi.spyOn(...).mockResolvedValueOnce(true)` and asserts only call count, so it is
  signature-agnostic. Verified, not assumed.

## 4) Step-By-Step Implementation Plan (Smallest Safe Slices)

### Controlling code path

    POST /v1/usage/events
      -> tenant-context.middleware        (attaches request.tenantId from X-Tenant-Id)
      -> EventsController.handle          (Zod validation, clock skew, tenant extraction)
      -> IngestionService.ingestEvents(tenantId, events)
           -> per event: choose client key OR derive fallback     <-- S-1 lives here
           -> DeduplicationService.isNew(key)                     <-- and lands here
                -> redis.set(key, "1", "EX", 86400, "NX")         <-- unprefixed, untenanted
           -> StreamPublisher.publish(...)

### Design decision — where the helper lives

Two candidates were weighed.

**(A) Build the key in `IngestionService`, keep `isNew(fullKey)`.**
Smallest diff. But it only *fixes the current call site*. The vulnerable shape —
`isNew("attacker-controlled-string")` — stays perfectly representable and perfectly type-correct.
Any future caller (the worker-service consumer, a replay/backfill job, a second ingestion path)
reintroduces the exact bug with code that compiles, passes review-by-eye, and looks identical to
the fixed code. The invariant would live in a comment, not in the type system.

**(B) Build the key inside `DeduplicationService`, signature `isNew(tenantId, key)`.** ← chosen

The service owns its own keyspace. Callers *cannot* pass a pre-built key, because there is no
parameter that accepts one — a caller must supply a tenant id, and every key that reaches Redis is
prefixed and tenant-namespaced by construction. This converts the defect from *fixed at one call
site* into *unrepresentable*, which is the standard this repo already applies to tenant scoping
elsewhere: `.claude/rules/tenant-isolation.md` requires that a tenant id derive from the
repository's own bound context and that "query-input types must not even have a `tenantId` field."
Same principle, one layer over.

Cost of (B): a breaking signature change on a public service method, and the existing docstring
("Full key including prefix") inverts. Both are handled in this plan; the blast radius is two
production files and two test files, all inside usage-service. Accepted.

Rejected variant of (B): a module-level exported `buildDedupKey()` helper that `IngestionService`
calls. That is (A) wearing (B)'s clothes — it centralizes the *string format* but leaves
`isNew(fullKey)` accepting anything, so the unsafe shape survives.

### Design decision — should a client-supplied key be validated?

**Length: yes.** Add `INGESTION_CONSTANTS.IDEMPOTENCY_KEY_MAX_LENGTH = 200` and enforce it in
`eventPayloadSchema`. `idempotencyKey` is currently `z.string().min(1).optional()` — unbounded.
Once it becomes part of a Redis key held for 24h, an unbounded field is a memory-amplification
vector: 100 events per batch x an arbitrarily large key x sustained batches, all pinned for the
full TTL. A bound is the actual resource control, and 200 comfortably fits UUIDs, ULIDs, hex
digests, and typical `<source>-<id>` composites. It belongs in `INGESTION_CONSTANTS` beside the
other request-input bounds (`BATCH_SIZE_MAX`, `QUANTITY_MAX`), not in `DEDUP_CONSTANTS`, which
holds Redis-side storage concerns.

**Charset: no.** Deliberate, on three grounds:
1. **There is no injection channel to close.** ioredis encodes commands as RESP arrays of
   length-prefixed bulk strings. A key containing `\r\n`, `\0`, spaces, or `:` cannot break out
   of its argument — Redis keys are binary-safe by design. This is not SQL; there is no parser to
   confuse.
2. **The two real risks are already closed by namespacing.** Cross-tenant collision is closed by
   the `tenantId` segment; platform-keyspace collision is closed by the `dedup:` prefix. A charset
   filter adds nothing on top of either.
3. **It would break working clients for no gain.** Legitimate keys today are base64, URLs, JSON
   digests, `order:1234` composites. Rejecting `:` or `/` would 400 traffic that is currently
   correct, and would be a genuine breaking change with no security justification behind it.

The one residual the charset question *would* touch — segment ambiguity, where a tenant id
containing `:` could let one tenant's `dedup:` key alias another's — is a property of the
**tenant id**, not the client key, and is tracked as R-4 below.

### Implementation slices

1. **Red first — regression tests before any production edit.**
   - `deduplication.service.unit.test.ts`: add a `key namespacing` describe block asserting
     the same raw key under two tenants yields two different Redis keys; every written key
     starts with `DEDUP_CONSTANTS.KEY_PREFIX`; a client key equal to
     `STREAM_CONSTANTS.DEFAULT_STREAM_NAME` cannot produce that top-level key.
   - `ingestion.service.unit.test.ts`: assert `isNew` is called with `(tenantId, rawKey)` for
     both the client-supplied and derived-fallback branches.
   - Run and **confirm failure**. Record the output. A test that never failed proves nothing
     (`.claude/rules/testing.md`).

2. **Implement `DeduplicationService`.**
   - `isNew(tenantId: string, idempotencyKey: string): Promise<boolean>`.
   - `private buildKey(tenantId, idempotencyKey)` returning
     `` `${DEDUP_CONSTANTS.KEY_PREFIX}${tenantId}:${idempotencyKey}` ``.
   - Single construction site; `isNew` never touches the raw key again.
   - Rewrite the docstring: the caller passes the tenant id and a **raw** key; the service owns
     prefixing and namespacing. Delete the "Full key including prefix" instruction.
   - Log the **namespaced** key on the fail-open path so operators can grep what was actually
     written; keep fail-open semantics byte-for-byte otherwise.

3. **Implement `IngestionService`.**
   - Rename the local to `dedupKey` and keep the same branch logic (client key, else derived
     fallback). Drop `tenantId` from the derived fallback — the service now adds it, and leaving
     it would double the segment.
   - Call `this.deduplication.isNew(tenantId, dedupKey)`.
   - `publishEvent.idempotencyKey` keeps carrying the **raw** key, not the namespaced one. The
     stream payload already has a separate `tenantId` field; publishing the Redis key shape would
     leak internal storage layout into the event contract and change what worker-service reads.

4. **Add the length bound.**
   - `INGESTION_CONSTANTS.IDEMPOTENCY_KEY_MAX_LENGTH: 200`.
   - `idempotencyKey: z.string().min(1).max(INGESTION_CONSTANTS.IDEMPOTENCY_KEY_MAX_LENGTH).optional()`.

5. **Update existing tests that assert the old shape (do not weaken).**
   - `deduplication.service.unit.test.ts`: every `isNew(key)` becomes `isNew(tenantId, key)`, and
     every `expect(mockRedis.set).toHaveBeenCalledWith(...)` asserts the **namespaced** key built
     from `DEDUP_CONSTANTS.KEY_PREFIX` rather than a hand-written `"dedup:..."` literal. The
     existing "different tenant / event type / source / timestamp produce different keys" cases
     are strengthened, not softened: they gain an assertion on the actual key string, which they
     never had.
   - `ingestion.service.unit.test.ts:264` and `:294` — the two cases that assert the `isNew`
     argument — become two-argument assertions.

6. **Confirm green, then validate.** Task-scoped file, package suite, lint, typecheck, build,
   then the full root gate.

7. **Update `.claude/rules/known-gaps.md`** — delete the S-1 section (the file is for *open*
   gaps), and fix the cross-reference in `.claude/rules/tenant-isolation.md`, which names
   client-supplied dedup keys in its "Known gaps" paragraph and points at "S-1 through S-4".

### Local hypothesis (falsifiable)

*If* every Redis dedup key is constructed inside `DeduplicationService` as
`${KEY_PREFIX}${tenantId}:${rawKey}`, and `isNew` accepts no parameter capable of expressing a
pre-built key, *then* no client-supplied `idempotencyKey` can produce a key that another tenant
can also produce, nor a key that collides with the platform keyspace — while accepted / duplicate
/ rejected counting and fail-open-on-Redis-error remain byte-for-byte unchanged.

This is **falsified** if any of the following hold after implementation:
- Two different `tenantId` values with the same raw key produce the same string in the
  `redis.set` call.
- Any `redis.set` first argument does not start with `DEDUP_CONSTANTS.KEY_PREFIX`.
- A raw key of `telemetry:events` produces the literal Redis key `telemetry:events`.
- The derived-fallback path stops being tenant-distinguishing.
- Any of the 132 pre-existing usage-service tests fails, or the ingestion counters change.

## 5) Test Plan

### New tests — `tests/deduplication.service.unit.test.ts`
| # | Test | Asserts |
|---|---|---|
| N1 | same raw key, two tenants -> two different Redis keys | **the regression test for S-1**; both `set` calls captured and compared; must fail pre-fix |
| N2 | every written key begins with `DEDUP_CONSTANTS.KEY_PREFIX` | prefix invariant across client + derived shapes |
| N3 | raw key `telemetry:events` cannot yield that top-level key | platform-keyspace collision (`WRONGTYPE`) |
| N4 | derived-fallback shape stays tenant-scoped and prefixed | fallback branch not regressed |
| N5 | tenant is a distinct segment, not concatenated | key equals the exact expected composite |

### New tests — `tests/ingestion.service.unit.test.ts`
| # | Test | Asserts |
|---|---|---|
| N6 | client-supplied key -> `isNew(tenantId, rawKey)`, raw key not pre-namespaced | ingestion passes components, not a built key |
| N7 | same client key, two tenants -> two different `(tenantId, key)` pairs | end-to-end shape of the regression |
| N8 | derived fallback -> `isNew(tenantId, derivedKey)` without a doubled tenant segment | no `tenant:tenant:` duplication |
| N9 | published stream event keeps the **raw** `idempotencyKey` | storage layout does not leak into the event contract |

### Modified tests (updated, not weakened)
- All 10 existing `DeduplicationService` cases move to the two-argument call and assert the
  namespaced key built from the constant. Net assertion count increases.
- `ingestion.service.unit.test.ts` "should generate idempotency key when missing" and "should use
  provided idempotency key" assert both arguments.

### Regression guard
All **132** currently-passing usage-service tests must still pass. Counters
(`accepted`/`duplicate`/`rejected`), fail-open-on-Redis-error, rethrow-on-publish-failure, TTL of
86400, metadata flattening, and reserved-field protection are all untouched behaviour.

### Explicit acceptance coverage mapping
| Acceptance criterion | Covered by |
|---|---|
| AC-1 Client key from tenant A cannot suppress tenant B | N1, N7 |
| AC-2 Every Redis dedup key carries `DEDUP_CONSTANTS.KEY_PREFIX` | N2, N5, all modified dedup tests |
| AC-3 Derived fallback still works and is still tenant-scoped | N4, N8 |
| AC-4 Client key cannot become a platform top-level key | N3 |
| AC-5 Existing dedup/ingestion behaviour unchanged | full 132-test suite; N9 |
| AC-6 `KEY_PREFIX` is actually used in `src/` | N2 + `grep -rn KEY_PREFIX src/` |
| AC-7 Client key length is bounded | validator schema + package suite |

## 6) Validation Commands

### Task-scoped first (fail fast)
```bash
pnpm --filter @telemetry/usage-service exec vitest run tests/deduplication.service.unit.test.ts
pnpm --filter @telemetry/usage-service exec vitest run tests/ingestion.service.unit.test.ts
pnpm --filter @telemetry/usage-service test
pnpm --filter @telemetry/usage-service lint
pnpm --filter @telemetry/usage-service typecheck
pnpm --filter @telemetry/usage-service build
```
Note: `pnpm --filter <pkg> test -- <file>` does **not** filter — vitest runs the whole package
suite. `exec vitest run <file>` is the form that actually scopes (`CLAUDE.md`, `.claude/rules/testing.md`).

### Full gate (all 13 packages)
```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```
Known pre-existing warnings to classify, not to claim credit for: 4 in
`apps/usage-service/tests/ingestion.service.unit.test.ts` and 17 in auth-service. Prove
pre-existence with `git diff --name-only` / `git log -1 <file>`.

## 7) Risks And Mitigations

- **R-1 — Changing the key format resets in-flight dedup state.** Every key written before deploy
  lives under the old shape; post-deploy lookups miss. For up to 24h (the TTL), a genuine
  client retry of an event ingested just before the cutover is re-accepted, i.e. double-counted.
  *Mitigation:* this is a deploy consideration, not a correctness one, and it is strictly the
  safe direction — the failure mode is counting a real event twice, not silently dropping another
  tenant's billable event. Deploy during a low-ingest window if double-count matters; no
  migration is written, since re-keying 24h of ephemeral state costs more than it saves.

- **R-2 — Breaking signature change on a public service method.** `isNew` gains a parameter.
  *Mitigation:* every caller is enumerated by `grep -rn "\.isNew(" apps/ packages/ --include=*.ts`
  (excluding `dist/`) before and after; TypeScript strict mode makes a missed caller a compile
  error, not a runtime one. Verified surface: `ingestion.service.ts` (production) plus two test
  files. The review re-runs this grep as an independent check.

- **R-3 — Doubled tenant segment in the fallback.** The old derived fallback starts with
  `${tenantId}:`; if it were left as-is while the service also prepends the tenant, keys become
  `dedup:t1:t1:api.request:...`. Harmless but sloppy and it changes the fallback's shape twice.
  *Mitigation:* drop `tenantId` from the fallback template; N8 asserts the absence of the
  doubled segment explicitly rather than just matching a prefix.

- **R-4 — Segment ambiguity if a tenant id may contain `:`.** `dedup:${tenantId}:${key}` is only
  unambiguous while tenant ids cannot contain the separator. `tenant-context.middleware.ts:26`
  accepts *any* non-empty string. In production the gateway re-injects `X-Tenant-Id` from verified
  JWT context (a UUID), so this is not reachable today — but it rests on the same gateway-only
  assumption as S-4.
  *Mitigation:* out of scope to fix here (it is a middleware contract change); recorded as an
  explicit residual risk in the review with the concrete follow-up — validate `X-Tenant-Id` as a
  UUID in `tenant-context.middleware.ts`, which closes it for free.

- **R-5 — The length bound rejects a client that is working today.** Any existing integration
  sending an `idempotencyKey` longer than 200 chars starts receiving 400 `VALIDATION_ERROR`.
  *Mitigation:* 200 is well above every realistic key format (UUID 36, ULID 26, SHA-256 hex 64);
  the bound is enforced at the validator so the rejection is explicit and debuggable rather than
  a silent truncation. Documented as a contract change in the review.

- **R-6 — The fix is asserted only against a mocked Redis.** Unit tests prove the *string handed
  to* `redis.set`, not Redis's own behaviour.
  *Mitigation:* the string is exactly the security-relevant artifact — `SET NX` collision
  semantics are Redis's contract, not ours. Real-Redis coverage belongs to T-036's integration
  suite; noted as "could not verify" in the review rather than papered over.

## 8) Pending Task Checklist

- [done] Read `CLAUDE.md`, `.claude/rules/*`, and the S-1 entry.
- [done] Establish the baseline (132 tests passing).
- [done] Write the plan (this file).
- [done] Enumerate every `isNew` caller (R-2).
- [done] Write failing regression tests N1-N9; **confirm red**.
- [done] Implement `DeduplicationService.isNew(tenantId, key)` + `buildKey` + docstring contract.
- [done] Implement `IngestionService` raw-key passing; drop the doubled tenant segment.
- [done] Add `IDEMPOTENCY_KEY_MAX_LENGTH` and apply it in `eventPayloadSchema`.
- [done] Update the 10 existing dedup tests and the 2 ingestion argument assertions.
- [done] Confirm green; 132 + new tests passing.
- [done] Task-scoped lint / typecheck / build.
- [done] Full root gate across 13 packages; classify pre-existing warnings with proof.
- [done] Senior Reviewer pass -> `docs/reviews/s-001-dedup-key-namespacing.md`.
- [done] Remove S-1 from `.claude/rules/known-gaps.md`; fix the `tenant-isolation.md` cross-reference.
- [done] Leave the working tree uncommitted for the user.

## 9) Approval Gate

`CLAUDE.md` requires explicit user approval of this plan before implementation begins.

**Status: AUTHORIZED IN-SESSION.** The user explicitly authorized planning, implementation, and
review to run in a single pass for this security fix, waiving only the interactive stop at this
gate. Every other rule stands unchanged — in particular `.claude/rules/git-commit.md`: **no
commit, no staging, no push, no branch.** The working tree is left for the user, who retains the
final commit decision.
