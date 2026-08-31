# Senior Review — S-1 Dedup Key Namespacing

Review file path: docs/reviews/s-001-dedup-key-namespacing.md
Plan: `docs/plans/s-001-dedup-key-namespacing.md`
Standard applied: `.claude/rules/review-standards.md` (Pre-QA) + `docs/reviewer-checklist.md`
Scope reviewed: working-tree diff against `d33c8d1`, 5 code files (3 src + 2 tests), plus 2
standards-file edits (`known-gaps.md`, `tenant-isolation.md`). Verified that no commit between
`c26f370` and `d33c8d1` touched any of the 5 code files, so this diff has a clean base.

---

## Verdict

**CONDITIONAL — approved for commit with two follow-ups recorded, neither blocking.**

The vulnerability is closed and closed in the right place: the unsafe shape is now
*unrepresentable* rather than fixed-at-one-call-site. Two findings below (M-1, M-2) are
residual risks that the change does not create and does not fully close; both are argued, not
waved through. No BLOCKER, no HIGH.

Note on independence: this review was produced by the same agent that wrote the implementation.
That is a real weakness in the signal — a self-review cannot catch a blind spot it shares with
the implementation. The compensating measure taken was to re-derive the call-path inventory from
`grep` over the whole workspace rather than from memory of what was edited (see *What I
verified*, item 2). Findings M-1 and M-2 are both faults in my own diff.

---

## Findings

### M-1 · MEDIUM — `idempotencyKey` is now bounded in one of two schema definitions

`apps/usage-service/src/validators/events.validator.ts:32-36` bounds the key at 200 chars.
But `packages/shared-validation/src/index.ts:67` (`apiRequestPayloadSchema`) and
`packages/shared-validation/src/index.ts:87` (`baseEnvelopeSchema`) both still declare
`idempotencyKey: z.string().min(1)` — unbounded.

This is exactly the DRY violation `.claude/rules/constants.md` names: "a definition duplicated
between `constants.ts`, a validator, and a repository is a finding." I added a bound to one copy
and left the other two.

**Mitigating fact, verified not assumed:** usage-service does not use the shared schemas on this
path. `grep -rn "shared-validation" apps/usage-service/src` returns only `iso8601Schema` imports
(`events.validator.ts:2`, `usage-summary.validator.ts:2`). The ingestion path validates through
the service-local `eventPayloadSchema` only, so the bound *is* enforced everywhere it currently
matters. The finding is about the trap left for the next person, not a live hole.

**Concrete fix (follow-up, not this change):** promote the bound to a shared constant and apply
it in all three places —
`packages/shared-validation/src/index.ts:67,87` → `.max(IDEMPOTENCY_KEY_MAX_LENGTH)`, sourced
from a shared constant, per `.claude/rules/constants.md` ("before adding a third copy of a
literal, promote it"). I did not do it here because it touches a package consumed by 6 other
services and would widen a security fix into a cross-package contract change — but that is a
scope judgement, and a reviewer is entitled to disagree with it.

### M-2 · MEDIUM — key segments are ambiguous if a tenant id can contain `:`

`apps/usage-service/src/services/deduplication.service.ts:41`

```ts
return `${DEDUP_CONSTANTS.KEY_PREFIX}${tenantId}:${idempotencyKey}`;
```

Concatenation with a `:` separator is only unambiguous while `tenantId` cannot contain `:`.
`apps/usage-service/src/middleware/tenant-context.middleware.ts:26` accepts **any** non-empty
string as the tenant id — there is no UUID check:

```ts
if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
```

So in principle tenant `"a"` with key `"b:x"` and tenant `"a:b"` with key `"x"` both yield
`dedup:a:b:x`. That is the original vulnerability in miniature.

**Why it is not reachable today, and why that is not fully reassuring:** the gateway strips
inbound `x-tenant-id` and re-injects it from verified JWT context
(`apps/gateway/src/middleware/guards.middleware.ts:43-47`), and the JWT `tenantId` is a UUID —
no colons. But that is *the same assumption S-4 is open on*: it holds only while the gateway is
the sole network path to usage-service. S-1 and S-4 therefore share a single point of failure,
which is worth stating plainly rather than treating each as independently mitigated.

**Concrete fix (follow-up):** validate `X-Tenant-Id` as a UUID in
`tenant-context.middleware.ts:26` using the existing `tenantIdSchema` from
`@telemetry/shared-validation` (`packages/shared-validation/src/index.ts`). That closes M-2
completely and for free, and it is a prerequisite the S-4 fix will want anyway. Out of scope
here: it changes the middleware's rejection contract and needs its own tests, and the plan
declared it out of scope (§2, R-4) rather than discovering it late.

An alternative — length-prefixing the tenant segment — was considered and rejected: it makes
keys unreadable in `redis-cli`, and it solves at the storage layer a problem that belongs at the
validation layer.

### L-1 · LOW — the fix is proven against a mocked Redis only

All new assertions inspect the arguments handed to a `vi.fn()` standing in for `redis.set`.
No test exercises real `SET NX` semantics.

**Disposition: accept.** The security-relevant artifact genuinely *is* the key string — whether
two different strings collide under `SET NX` is Redis's contract, not this codebase's. Real-Redis
coverage belongs to the T-036 integration suite
(`docs/plans/t-036-usage-service-integration-tests.md`), which should add a two-tenant
same-`idempotencyKey` case against a live Redis. Recorded here so it is not silently forgotten.

### L-2 · LOW — `denylist:` prefix in auth-service is the same pattern, un-namespaced

`apps/auth-service/src/services/token-denylist.service.ts:40,44`

```ts
await this.redis.set(`denylist:${jti}`, "1", "EX", ttlSeconds);
```

An inline magic string rather than a constant (`.claude/rules/constants.md`), and the same
"caller-adjacent key construction" shape S-1 was about.

**Disposition: not a security bug, out of scope.** `jti` is a server-generated unique token id,
not client-supplied, so there is no cross-tenant collision path — unlike `idempotencyKey`. The
constants violation is real but pre-existing and in a different service; folding it into a
usage-service security fix would violate the one-task-per-commit rule. Flagged for a future
cleanup task.

### NIT-1 · The stream payload still carries the raw key

`apps/usage-service/src/services/ingestion.service.ts:143` publishes `idempotencyKey` as the raw
client value, not the namespaced Redis key.

**Disposition: correct as written, asserted deliberately.** The stream event already carries a
separate `tenantId` field, so no information is lost, and publishing the Redis key shape would
leak internal storage layout into the event contract that worker-service consumes. Pinned by the
test "should publish the raw idempotency key, not the Redis key shape"
(`tests/ingestion.service.unit.test.ts:661`). Noted because it is a deliberate choice that looks
like an omission.

---

## Review priority order (per `.claude/rules/review-standards.md`)

**1. Tenant isolation and RLS.** The change strengthens it. Every dedup key now carries the
tenant as a distinct segment, built at a single site the caller cannot bypass. This mirrors the
rule the repo already applies to repositories — the tenant derives from bound context, and
"query-input types must not even have a `tenantId` field" — one layer over. `isNew` has no
parameter that can express a pre-built key, so the class of bug is closed, not the instance.
Residual: M-2. **Pass.**

**2. Injection risk in raw SQL.** No SQL touched. Redis keys are not an injection surface: ioredis
encodes commands as RESP arrays of length-prefixed bulk strings, so a key containing `\r\n`,
`\0`, or `:` cannot break out of its argument. This is why the plan declined charset validation,
and I still agree with that reasoning after re-checking it. **N/A, verified not merely assumed.**

**3. Correctness — boundaries and error contracts.** Fail-open on Redis error preserved
byte-for-byte (`deduplication.service.ts:76-88`), including the `true` return and the log shape;
the only change is that the logged `key` is now the namespaced key, which is strictly more useful
to an operator (it is greppable against what Redis actually holds). "OK" → new, `null` →
duplicate, unexpected → new: all unchanged, and the unexpected-response branch — previously
untested — now has a test. `accepted`/`duplicate`/`rejected` accounting untouched. **Pass.**

**4. Clean code gate.** `DEDUP_CONSTANTS.KEY_PREFIX` goes from dead constant to the sole source
of the prefix. Two magic literals removed that the task did not ask about: `"unknown"` →
`INGESTION_CONSTANTS.UNKNOWN_SOURCE_ID`, and the repeated `86400` in tests →
`DEDUP_CONSTANTS.KEY_TTL_SECONDS` (with `expect(DEDUP_CONSTANTS.KEY_TTL_SECONDS).toBe(86400)`
retained as the anchor, so the constant's *value* is still pinned and the test cannot drift with
a mistaken constant change). One DRY violation remains: M-1. **Pass with M-1.**

**5. Type safety.** No `any` introduced in production code. The signature change is caught by
`tsc --noEmit` at every call site — a missed caller is a compile error, not a runtime one, which
is the property that makes design (B) safe to land. **Pass.**

**6. Production readiness.** Deploy note (plan R-1): the key format change orphans all existing
`dedup:`-less keys, so for up to the 24h TTL a genuine client retry spanning the cutover is
re-accepted and double-counted. This is the safe direction of failure — counting a real event
twice beats silently dropping another tenant's billable event — and no migration is written
because re-keying 24h of ephemeral state costs more than it saves. **Operator-visible; must be
in the commit message.**

**7. Test honesty.** Checked specifically for tests that echo their own mocks. The dedup tests
assert the *key string constructed by the implementation*, which the mock does not supply — the
mock only returns `"OK"`/`null`. `keyOfSetCall()`
(`tests/deduplication.service.unit.test.ts:31-39`) **throws** when the call is absent, per
`.claude/rules/testing.md`, so a missing `redis.set` fails loudly rather than passing vacuously.
The `namespacedKey()` helper does duplicate the implementation's format, which would be
tautological alone — this is why the test "should build the key as `<prefix><tenantId>:<rawKey>`
(format pinned literally)" (`:139`) asserts the bare literal
`"dedup:tenant1:api.request:source1:1000"` with no constant indirection. Negative assertions are
present and carry the weight: `keyA` does not contain tenant B, the raw key is never a key on its
own, the derived key does not contain the tenant or the prefix. **Pass.**

**8. Plan alignment and scope creep.** Implementation matches the plan. Three additions beyond the
literal instruction, each declared: the `UNKNOWN_SOURCE_ID` constant, the TTL-constant cleanup in
tests, and the `tenant-isolation.md` invariant. See *Deviations*. **Pass.**

---

## Compile-Time Validation — all 13 packages

| Gate | Result |
|---|---|
| `pnpm build` | **13 successful, 13 total** |
| `pnpm test` | **13 successful, 13 total** |
| `pnpm lint` | **13 successful, 13 total** — 0 errors, 21 warnings (all pre-existing) |
| `pnpm typecheck` | **13 successful, 13 total** |

usage-service package: **141 tests / 15 files passed** (baseline 132 → +9; every one of the 132
pre-existing tests still passes).

### Warning classification — proven, not asserted

| Warnings | Location | Status | Proof |
|---|---|---|---|
| 4 | `apps/usage-service/tests/ingestion.service.unit.test.ts:339,340,543,544` | **pre-existing** | All four are `expect.any(Number)` / `expect.any(String)` inside `expect.objectContaining`. `git show HEAD:<file> \| grep -c 'expect\.any('` → **4**; working tree → **4**; `git diff \| grep '^+' \| grep -c 'expect\.any('` → **0**. The diff adds zero; the line numbers moved only because the file grew. |
| 17 | `apps/auth-service/tests/{auth.service,user.repository}.unit.test.ts` | **pre-existing** | auth-service is not in `git diff --name-only`; untouched by this change. |

**New warnings introduced by this change: 0. New errors: 0.**

One stderr trace appears during `pnpm test` (`Error: load failure ... code: 'EACCES'`). It comes
from the pre-existing test `index.graceful-shutdown.unit.test.ts` > "fails startup when
loadEnvFile throws non-ENOENT", which mocks that error deliberately; the test passes. That file
is not in the diff.

---

## What I verified

1. **The regression test genuinely failed before the fix.** Run against unmodified production
   code: `AssertionError: expected 'tenant1' to be 'dedup:tenant1:abc'` —
   14 failed / 2 passed of 16. Pre-fix, the string reaching `redis.set` was `"tenant1"`, i.e. the
   old single-argument signature silently consumed the tenant id and *discarded the key entirely*
   — a vivid demonstration that the old shape carried no tenant namespace at all. Post-fix: 141/141.
2. **No other call path into `DeduplicationService` was missed.** This was the specific thing I
   was asked to check hardest, so I did it three ways rather than by recall:
   - `grep -rn "\.isNew(" apps/ packages/ --include=*.ts` (excluding `dist/`) → one production
     caller, `ingestion.service.ts:119`; two test files.
   - `grep -rn "Dedup\|deduplication"` across the workspace → the class is constructed in exactly
     one place, `config/container.ts:53`, and exposed via `services/index.ts:1`. No second
     instantiation, no worker-service or billing-service import.
   - `grep -rn "\.set(\|redis\."` over all non-test `src/` → usage-service has exactly **one**
     `redis.set` (`deduplication.service.ts:61`) and one `xadd`
     (`stream.publisher.ts:70`). There is no second dedup writer anywhere in the service.
   The change therefore covers 100% of the dedup keyspace, not merely the reported call site.
3. **`KEY_PREFIX` is now live.** Previously `grep -rn KEY_PREFIX src/` → 1 hit (the definition).
   Now → definition plus `deduplication.service.ts:41`.
4. **The route test is signature-agnostic**, as the plan predicted — `usage-events.route.test.ts:23`
   stubs `isNew` wholesale and asserts only call count, so it needed no edit and still passes.
5. **No commit, no staging, no branch.** `git diff --cached --name-only` → empty;
   `git status --short` shows 5 modified files plus untracked docs. Working tree left for the user.

## What I could NOT verify

1. **Real Redis behaviour.** No live `SET NX` was exercised (L-1). Unit tests prove the key
   string, not Redis's collision semantics.
2. **The end-to-end attack, executed.** I did not stand up gateway + usage-service + Redis and
   fire two tenants' requests with a shared `idempotencyKey`. The proof here is at the unit
   boundary — the exact string handed to Redis — which is where the defect lived, but it is not
   the same as a demonstrated exploit-then-no-exploit.
3. **In-flight production dedup state.** No access to a running Redis, so the size of the
   cutover window (plan R-1) is reasoned about, not measured.
4. **Whether any existing client sends an `idempotencyKey` longer than 200 characters.** No
   production traffic sample was available. If one does, it will now receive
   `400 VALIDATION_ERROR`. This is the one behavioural risk to real clients in the change.
5. **That `tenantId` is always a UUID in practice** (M-2). I read the gateway's re-injection code
   but did not verify the JWT claim's format against a live token.

## Deviations from the plan

1. **Added `INGESTION_CONSTANTS.UNKNOWN_SOURCE_ID`.** The plan did not call for it. The derived
   fallback line was being edited anyway and contained a magic `"unknown"`;
   `.claude/rules/constants.md` is a required gate, and leaving a magic literal on a line I was
   already rewriting would be a finding against my own diff.
2. **Replaced repeated `86400` literals in the dedup tests with `DEDUP_CONSTANTS.KEY_TTL_SECONDS`.**
   The constants rule applies to tests explicitly. The literal is retained once, as
   `expect(DEDUP_CONSTANTS.KEY_TTL_SECONDS).toBe(86400)`, so TTL coverage is strengthened rather
   than made self-referential.
3. **Added one test the plan did not list** — "should treat an unexpected Redis response as a new
   event" (`tests/deduplication.service.unit.test.ts:337`). The `return true` fallback at
   `deduplication.service.ts:74` had no coverage at all. Untested branch on a file under
   security review.
4. **Added an invariant to `.claude/rules/tenant-isolation.md`** (Required + Forbidden). The plan
   only committed to fixing that file's stale cross-reference. Without a stated rule, the next
   service to add a Redis cache repeats S-1 — the fix should leave behind a standard, not just a
   patched file.

## Remaining risks and dispositions

| Risk | Severity | Disposition |
|---|---|---|
| Duplicate unbounded `idempotencyKey` in `shared-validation` (M-1) | MEDIUM | **Accepted, follow-up.** Not on the ingestion path; verified by grep. |
| Segment ambiguity if tenant id contains `:` (M-2) | MEDIUM | **Accepted, follow-up.** Not reachable while the gateway is the sole path — the same assumption S-4 rests on. Fix: UUID-validate `X-Tenant-Id`. |
| 24h dedup-state reset on deploy (R-1) | LOW | **Accepted.** Fails safe (double-count, not drop). Must appear in the commit message. |
| Clients sending keys >200 chars now get 400 (R-5) | LOW | **Accepted.** Explicit rejection beats silent truncation into a Redis key. |
| Mock-only proof (L-1) | LOW | **Accepted.** Route to closure: add the two-tenant case to T-036. |
| `denylist:` inline prefix in auth-service (L-2) | LOW | **Out of scope.** No cross-tenant path; separate cleanup task. |
| Self-review, not independent | — | **Disclosed.** Compensated by grep-derived call inventory; a second reviewer should re-run item 2 above. |

## Registry update

S-1 removed from `.claude/rules/known-gaps.md` (that file tracks **open** gaps only).
S-2 through S-6 **left un-renumbered** — deliberately. The ids are cited from
`.claude/agents/senior-reviewer.md:22,48`, and renumbering would silently repoint two live
references and invalidate every prior citation. A note was added to the file's preamble stating
that ids are stable, never reused, and that a missing id means "fixed", so the numbering gap
reads as intentional. `.claude/rules/tenant-isolation.md:36` updated from "S-1 through S-4" to
"S-2 through S-4", and its stale claim that client dedup keys allow cross-tenant suppression
removed.

---

## Sign-off

**CONDITIONAL — APPROVED FOR COMMIT.** The two MEDIUM findings are pre-existing residuals that
this change narrows rather than introduces, and both are recorded with concrete fixes above.
Nothing in the diff needs to change before commit.

Per `.claude/rules/git-commit.md`, the commit is the user's call and has not been made. When
made, it should carry the service code, both test files, this review, the plan, and the two
standards-file edits as one atomic commit — and it should mention the 24h dedup-state reset
(R-1) so whoever deploys it knows.
