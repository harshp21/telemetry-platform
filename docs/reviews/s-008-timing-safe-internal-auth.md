# Senior Review — S-8 · Timing-safe internal-auth guards, and one declaration of `INTERNAL_API_SECRET`

## Round 1

**Gate 4 — pre-QA.** Base `2cdb140`, nothing committed or staged. Read-only: no fix in this
document was applied.

**Verdict: CONDITIONAL.** One HIGH must be fixed before commit (a redirect in
`.claude/rules/known-gaps.md` that does not resolve). Everything else is LOW or a
disposition. The security substance of the change is sound and I re-derived it by execution
rather than reading.

### Which revision of `known-gaps.md` I read

From **disk**: `md5 9afb6429d9d66f1b6868704616814dbc`, **3397 lines**, entries **S-5 … S-53**,
**no S-8** (`grep '^## S-'` goes S-5, S-6, S-9 — the deletion is real).

The copy injected into this session's context ended at **S-39 and still contained S-8**. That
is **S-24 firing again** — stale by 14 ids, including the S-53 that this very diff adds. Every
citation below was re-read with `cat`/`sed` from disk, and the pre-change text from
`git show 2cdb140:.claude/rules/known-gaps.md`.

---

## Findings

### HIGH-1 · Two redirects in `.claude/rules/known-gaps.md` claim a quotation lives somewhere it does not

`.claude/rules/known-gaps.md:1832` and `:2444` both read:

> it is quoted verbatim in `docs/plans/s-008-timing-safe-internal-auth.md`, which is the record.

referring to S-8's deferral sentence, *"changing two other services' startup contracts inside a
usage-service security fix breaks the one-task-per-commit rule."*

**Measured — the claim is false:**

```
$ grep -n "changing two other services' startup contracts inside a" docs/plans/s-008-timing-safe-internal-auth.md
  (no match)
$ grep -n "one-task-per-commit" docs/plans/s-008-timing-safe-internal-auth.md
  66:  ...one-task-per-commit rule, because closing it means editing three services' middleware...
  77:  The one-task-per-commit rule exists so a commit's blast radius is reviewable...
$ grep -rln "changing two other services. startup contracts inside a" . --include=*.md   # excl. node_modules
  .claude/rules/known-gaps.md          <- only the two citing passages themselves
```

The sentence originates at `git show 2cdb140:.claude/rules/known-gaps.md`, **line 42** (inside
the deleted S-8). After this change it survives **nowhere except inside the two sentences that
quote it**, each of which points at a file that does not contain it. Both passages were
*rewritten by this diff* — they are new claims, not inherited ones.

This is HIGH by `.claude/rules/review-standards.md` § *Claims the Change Makes*: `CLAUDE.md`
designates `.claude/rules/` authoritative and instructs agents to trust it without
re-verification. An agent following either redirect finds nothing and cannot tell whether the
quotation was accurate.

**Required fix — either one, both are two lines:**

- **(a)** add the quoted sentence to `docs/plans/s-008-timing-safe-internal-auth.md` (an
  appendix subsection quoting S-8's deferral preamble as it stood at `2cdb140`), making the
  existing redirect true; **or**
- **(b)** change both redirects to name the revision that does carry it, e.g. *"it is quoted
  verbatim in S-8 as it stood at `2cdb140`; read it with
  `git show 2cdb140:.claude/rules/known-gaps.md`"*.

(b) is the smaller change and the more honest one — the plan's R6 position is that historical
artifacts are not rewritten, and git is already the record.

### MEDIUM-1 · The hand-off's per-file test decomposition is wrong in all four rows

Claimed at Gate 3: post-repoint totals are pre-existing + new — **16+6=22, 45+2=47, 19+2=21,
7+5=12**.

**Measured.** I ran each `2cdb140` test file **verbatim against the shipped source** (copied in
under a temporary name, run, removed; `git status` clean afterwards):

| File | claimed | measured pre-existing | measured new | total |
|---|---|---|---|---|
| `apps/usage-service/tests/env.schema.unit.test.ts` | 16+6 | **14** | **8** | 22 ✓ |
| `apps/worker-service/tests/env.schema.unit.test.ts` | 45+2 | **43** | **4** | 47 ✓ |
| `apps/billing-service/tests/env.schema.unit.test.ts` | 19+2 | **17** | **4** | 21 ✓ |
| `apps/billing-service/tests/internal-billing.route.test.ts` | 7+5 | **10** | **2** | 12 ✓ |

The **totals are all correct**; every decomposition is wrong. This is the S-33 shape exactly —
a measured count that goes wrong inside the commit that changes it.

**Mitigating, and it matters:** the substantive property is verified *more strongly* than
claimed. `git diff HEAD -- 'apps/**/tests/*.ts' 'packages/**/tests/*.ts' | grep '^-'` returns
**zero deleted lines** across every modified test file, no test title was removed or renamed,
and all four baseline files pass **unchanged** against the shipped source (14/14, 43/43, 17/17,
10/10). Nothing was edited to make anything pass.

**Disposition:** the numbers are not in any committed artifact (I grepped the plan, release
note, `known-gaps.md`, `tenant-isolation.md` and `reviewer-checklist.md` — not found), so the
repository is not poisoned. **Required:** do not carry the decomposition into the commit
message. If a per-file count is wanted there, use the measured column above.

### LOW-1 · The release note's "20 characters" is attached to the wrong measurement

`docs/releases/s-008-timing-safe-internal-auth.md:117-118` — *"Measured across 20 characters,
two HTTP clients and the real `@fastify/http-proxy`"* — then lists **10** (three at/below
U+00FF, seven above).

Two different probes are being conflated. **Measured:** the 20-character set is the
`String.prototype.trim()` probe (12 stripped / 8 residue, re-derived below); the transit +
proxy probe covered **10** code points. Reword to *"Measured across 20 characters for the trim
rule and 10 through the real proxy"*, or drop the number.

### LOW-2 · `BU135`'s negative assertion is sensitive to docblock reflow

`apps/billing-service/tests/internal-auth.middleware.unit.test.ts` — `BU135` does
`expect(source).not.toContain("!== internalApiSecret")` against the whole file text.

The guard's own docblock currently contains the phrase *split across two comment lines*
(`internal-auth.middleware.ts:20-21`: `` It was `normalizedSecret !== `` / `` internalApiSecret ``).
Rewrapping that comment — no production change at all — would join them and redden `BU135`.
The same applies to worker's equivalent.

The case is **not** decorative: I confirmed it reddens on the real mutation (below). This is a
false-positive risk, not a false-negative. **Fix:** strip block comments before asserting, or
scope the assertion to the text after `export const buildInternalAuthMiddleware`.

### NIT-1 · `apps/gateway/src/config/env.ts:12-19` has two lead-in sentences

The retained *"Required with no default, for the same fail-fast reason as `JWT_SECRET`. Gateway
is the sender…"* is immediately followed by the shared block's own *"Service-to-service auth.
**Derived from one shared fragment…**"*. Merge the two; the gateway-specific sender point is
worth keeping, the duplicate framing is not.

---

## What I verified, by execution

### Compile-time gate — all 13 packages, `--force`, 0 cached

| Task | Command | Result |
|---|---|---|
| typecheck | `npx turbo run typecheck --force` | **13 successful, 0 cached**, 11.5 s |
| lint | `npx turbo run lint --force` | **13 successful, 0 cached**, 29.1 s |
| build | `npx turbo run build --force` | **13 successful, 0 cached**, 17.6 s |
| test | `npx turbo run test --force` | **13 successful, 0 cached**, 25.6 s |
| smoke | `pnpm test:smoke` | **6 suites, 7 cases, all pass** |

**Per-package test totals, and the root derived by me** (not taken from the hand-off):

```
analytics-service 18   auth-service 166   billing-service 231   gateway 50
shared-config 4        shared-logger 4    shared-tracing 2      shared-types 8
shared-utils 26        shared-validation 30                     usage-service 238
worker-service 251     web 0 (no cases)
                                                        ---- SUM = 1028
```

**1028 confirmed**, matching the implementer. No skipped, failed or todo cases anywhere. Worker
did **not** flake (`I24` green; 251/251 on three separate runs during mutation testing).

**Lint warnings: 14, all pre-existing, proven.** 10 in
`apps/auth-service/tests/auth.service.unit.test.ts` (`no-misused-promises` ×8,
`no-unsafe-assignment` ×2) and 4 in `apps/usage-service/tests/ingestion.service.unit.test.ts`.
Provenance: `git log -1 -- <file>` → **`d68e719`** and **`b0f6921`** respectively; neither file
appears in `git diff --name-only HEAD`. **Zero `no-unsafe-return`.** Zero errors.

### Priority 1 — the justification

**The outage reproduces exactly**, over a real `node:http` socket against the **real** billing
guard factory, with the two pre-S-8 declarations parsing the same deployed value:

```
usage parses  : "  aaaa…aaaa  " len 36      (z.string().min(32))
billing parses: "aaaa…aaaa"     len 32      (z.string().trim().min(32))

gateway sends padded -> usage   (untrimmed expected): 401
gateway sends padded -> billing (trimmed   expected): 200
CONTROL, clean secret ->  usage: 200   billing: 200
```

The mechanism is confirmed independently — **both** clients strip edge SP/HTAB in transit, and
internal whitespace survives uncollapsed (which is what makes D1.4's inclusion of U+0020 in
`SECRET_PATTERN` correct rather than sloppy):

| sent | `node:http` received | `fetch`/undici received |
|---|---|---|
| `"  SECRETVALUE"` / `"SECRETVALUE  "` / `"  SECRETVALUE  "` | `"SECRETVALUE"` | `"SECRETVALUE"` |
| `"\tSECRETVALUE\t"` | `"SECRETVALUE"` | `"SECRETVALUE"` |
| `"abc def"` / `"abc  def"` / `"abc\tdef"` | unchanged | unchanged |

**S-8 is genuinely closed, item by item**, checked against `git show 2cdb140:…`:

| S-8 item | Status | Evidence |
|---|---|---|
| 1 · `!==` not timing-safe | **closed** | no `!==` secret compare in any of the three guards; all three `import { secretsMatch } from "@telemetry/shared-utils"`; `grep "const secretsMatch\|timingSafeEqual" apps/*/src` → none |
| 2 · untrimmed `.min()` in usage + gateway | **closed** | all four `config/env.ts` are `INTERNAL_API_SECRET: internalApiSecretSchema`; no `SECRET_MIN_LENGTH` in executable code anywhere in `apps/*/src` |
| 3 · `preHandler`, un-returned reply | **closed** | `billing/src/app.ts:76` and `worker/src/app.ts:71` both `onRequest`; both guards `return reply.status(...).send(...)` |
| 4 · literal `401`; `provided[0]` divergence | **closed** | `HTTP_STATUS_UNAUTHORIZED` in both; all three reject any non-string identically |

The usage-service docblock S-8 required reworded **is** reworded
(`usage-service/src/middleware/internal-auth.middleware.ts:20-28`), and states *why* the old
wording misled rather than just replacing it.

**The six redirected citations** — `known-gaps.md:649, 706, 1657, 1828-1832, 2440-2444, 3333` —
all resolve and all read as *closed*, not live. `grep -rn "S-8\b" .claude/` shows no passage
treating the gap as open; `CLAUDE.md` and `docs/reviewer-checklist.md` carry none.
**Except the two verbatim-quote redirects — HIGH-1.**

### Priority 2 — the claims the change adds

**The latin-1 boundary, re-performed through the real `@fastify/http-proxy`** (gateway plugin
injecting the secret exactly as `proxy.plugin.ts` does, upstream running the real billing guard):

| character | `trim()` strips | upstream got == sent | real proxy |
|---|---|---|---|
| **U+0085** | no | **YES byte-identical** | **200** |
| **U+00AD** | no | **YES byte-identical** | **200** |
| **U+00FF** (boundary) | no | **YES byte-identical** | **200** |
| U+0100 (boundary) | no | never arrived | **500** |
| U+034F, U+180E, U+200B, U+200C, U+200D, U+2060 | no | never arrived | **500** |

So the two that authenticate do authenticate — **"fails closed" was false in that direction**,
which is the security-relevant half, and the refutation stands. The boundary is where claimed.

**The `trim()` residue set, re-derived over the 20 probed characters:**

```
STRIPPED (12): U+0020 U+0009 U+000A U+000B U+000C U+000D U+00A0 U+2000 U+2028 U+2029 U+3000 U+FEFF
RESIDUE  (8):  U+0085 U+00AD U+034F U+180E U+200B U+200C U+200D U+2060
```

12/8 exactly as claimed, and the residue membership matches character for character.
**U+FEFF is stripped** — the implementer's correction of its own draft is right, and no
surviving text in the shipped tree calls U+FEFF residue (`grep -rn FEFF` over `apps`,
`packages`, `docs/releases`, `.claude`, excluding `dist` → **no match**).

**The phase matrix, re-performed against the real billing route**, at both phases:

| unauthenticated body | `preHandler` (pre-S-8) | `onRequest` (shipped) |
|---|---|---|
| valid JSON | `401 {"code":"UNAUTHORIZED"}` | `401` |
| schema-invalid | `401` | `401` |
| **malformed JSON** | **`500 {"code":"INTERNAL_ERROR","message":"Body is not valid JSON but content-type is set to 'application/json'"}`** | `401` |
| **no content-type** | **`500 {"code":"INTERNAL_ERROR","message":"Unsupported Media Type"}`** | `401` |

The plan's predicted `400 FST_ERR_VALIDATION` row **does not occur** — billing validates in the
controller — and the implementer's correction is right. The real leak is *worse* than predicted:
a `500` handing an unauthenticated caller the parser's internal diagnostic. Promotion collapses
**every** row to `401`. `R8` is genuinely discharged: worker's case is not vacuous (see below).

**The three falsification mutations — each guard fails when *it alone* is reverted** (the S-21
property). Each applied to the real source, full package suite run, then restored and
`md5sum -c` verified:

| mutation | reddens | everything else |
|---|---|---|
| `secretsMatch(...)` → `providedSecret !== internalApiSecret` | **`BU135` only** | 230/231 green |
| non-string guard → `Array.isArray(p) ? p[0] : p` | **`BU137` only** | 230/231 green |
| both internal scopes → `preHandler` | **`BU71` + `W12` only** | billing 230/231, worker 250/251 |

Exactly two cases for the phase revert, "and nothing else" — confirmed across both packages.
Note the first two mutations leave 230 cases green, which is the honest point the guard's own
docblock makes: behaviour cannot distinguish them, so the shape assertion is doing the work.

**`BU71` is not satisfiable by "401 to everything"** — `BU72` is its paired control: an
*authenticated* caller sending malformed JSON must still get a non-`401` diagnosis. Correct
anti-vacuity construction.

**D6, re-measured on both transports:**

```
RAW SOCKET  -> {"type":"string","value":"good, evil"}
APP.INJECT  -> {"type":"string","value":"good,evil"}
```

Both `string`, never array, different separators — the implementer's self-correction is right,
and `BU137` reaches the `Array` branch by direct invocation with a control alongside. The
docblock scopes the claim correctly to *this header, these two transports, fastify 5.10.0*,
explicitly calls it *"a divergence … rather than a demonstrated exploit"*, and names `set-cookie`
as unprobed. **Not upgraded to an exploit anywhere.**

### Priority 3

**G1a's identity assertion — I rule the inversion correct, and it is falsifiable.** Putting the
cross-service table in `shared-validation`'s suite would have a leaf package's tests import four
apps; the per-service `EnvSchema.shape.X === internalApiSecretSchema` avoids that and is
strictly stronger. Falsified by mutation: I replaced gateway's field with a **byte-identical**
local re-declaration (`z.string().trim().min(SECRET_MIN_LENGTH).regex(SECRET_PATTERN, SECRET_PATTERN_MESSAGE)`):

```
× gateway env schema > … > declares INTERNAL_API_SECRET as internalApiSecretSchema itself
Tests  1 failed | 11 passed (12)
```

Exactly one case red; the other **11 stayed green** — which is the whole argument for identity
over a behavioural table, since a behavioural table cannot see this drift. Restored, md5 match,
12/12.

**Worker's `ZodEffects` handling — verified by construction and by execution.**
`"shape" in EnvSchema` → **`false`**; `EnvSchema.shape` → **`undefined`**;
`EnvSchema.innerType().shape.INTERNAL_API_SECRET === internalApiSecretSchema` → **`true`**. The
assertion cannot pass vacuously: `expect(undefined).toBe(schema)` fails, and a copied `.shape`
helper would *throw* on property access. The comment says exactly this.

**S3's no-op control confirmed.** `apps/usage-service/tests/middleware.internal-auth.unit.test.ts`
is **not in the diff at all** (absent from `git status`), and passes **10/10** against the
refactored guard. That is the strongest available form of the control — the byte-identical
pre-existing suite against the new code.

**The message pin is derived, not hard-coded, and throws rather than passing vacuously.**
`packages/shared-validation/tests/unit.test.ts:58` — `lengthRuleMessage()` parses a control
value and **throws** if it is accepted or reports no issue. Six-row table re-derived against the
shipped fragment:

| input | verdict | `issues[0].message` |
|---|---|---|
| valid 32 ASCII | OK | parsed len 32 |
| 31 chars | REJECT | `String must contain at least 32 character(s)` |
| 32 spaces | REJECT (2 issues) | `String must contain at least 32 character(s)` |
| 31-core padded to 35 | REJECT | `String must contain at least 32 character(s)` |
| 32 × U+00AD / U+200B | REJECT | `must contain only printable ASCII characters (U+0020-U+007E)` |
| `"   <valid>   "` / internal spaces | OK | parsed len 32 |

Every prior message preserved; the new message appears only for the new class; `parseEnv`
reports `issues[0]`, so the two-issue cases surface the length message — which is exactly what
release note §2 says.

**The inventory's substance holds.** Every distinct configured secret in the repository passes
the new rule — the five `.env.example` values, the four `docker-compose` blocks, `ci.yml`, the
three `tests/setup.ts` defaults and all the test constants: **12 distinct values PASS**. The
sole FAIL is `docs/epics/epic-3-shared-service-infra.md:172`
(`change-me-internal-secret`, 25 chars), rejected on the **length** rule — which all four
services already enforced at `2cdb140`, so it is genuinely pre-existing and not caused by this
change.

**S-53 held to the authoritative-file bar — every claim re-derived:**

- `docs/epics/epic-9-analytics-service.md:59` writes exactly
  `DATE_TRUNC('day', period_start AT TIME ZONE 'UTC') AS bucket_start` ✓
- the live table reproduces **row for row** on PostgreSQL **16.13** via `DIRECT_DATABASE_URL`,
  `options=-c timezone=…`, literals only, no table touched:
  `UTC` → `2026-01-01 00:00:00+00`, `Asia/Kolkata` → `2026-01-01 00:00:00+05:30`,
  **`America/New_York` → `2025-12-31 00:00:00-05`**, bare column `2026-01-01 00:00:00` in all three ✓
- `grep "@@map\|@map" prisma/schema.prisma` → **nothing**; real columns are `metricKey`,
  `periodStart`, `periodEnd`, `tenantId`, `billed` ✓
- `apps/analytics-service/src/repositories/base.repository.ts` has `set_config('app.tenant_id', …)`
  and **no `TimeZone` pin** — the S-19 citation is accurate ✓
- the `$2`/`$3` predicate claim matches the snippet's `period_start >= $2 AND period_end <= $3` ✓
- scope is stated (three zones, one value, `day` only; DST and other granularities named as
  unmeasured) ✓

**The release note is accurate against the shipped messages.** Both error strings reproduce
verbatim; the "all three length classes produce the length message" claim is confirmed by the
two-issue ordering above; *"gateway parses lazily inside `loadEnv()`"* matches
`apps/gateway/src/config/env.ts`; *"only one message is printed"* matches
`packages/shared-config/src/index.ts:10-13` reporting `issues[0]`. The pre-deploy `node -e`
one-liner implements the same three rules in the same order.

**Doc edits are accurate.** `docs/reviewer-checklist.md`'s compliance table now matches what I
measured (billing `onRequest` on both scopes — `app.ts:76` internal, `:116` tenant-facing;
worker `onRequest` on its internal scope; `/health` outside every guarded `app.register`).
`.claude/rules/tenant-isolation.md`'s layer-2 rewrite matches the code, and the hook order at
`billing/src/app.ts:116-117` is internal-auth **before** tenant-context, which is what
§ *Forbidden* requires.

**Clean-code gate: pass.** No magic status codes, error codes, `32`, or header-name literals in
executable code in any new or modified test file — the only textual hits are inside comments
transcribing measured output. Constants imported throughout
(`INTERNAL_AUTH_CONSTANTS`, `BILLING_/WORKER_RESPONSES`, `*_HEADERS`, `*_ROUTES`).

**Test honesty: pass.** `readMiddlewareSource()` **throws** when the file is empty rather than
asserting vacuously. `lengthRuleMessage()` throws on an accepted control. `BU72` is `BU71`'s
anti-vacuity pair. `secretsMatch` cases assert behaviour against the real function, not a mock,
and cover the full G2a table including empty-vs-empty (`secretsMatch("","")` → `true`, measured).
`/health` reachable with no secret is asserted in all three services (`W7`, `BU134`, and
usage's equivalent).

**No regression on the blank-secret path.** `InternalApiSecretMissingError` is intact at
`apps/billing-service/src/app.ts:47` and `apps/worker-service/src/app.ts:45`, both **untouched**
by this diff. usage-service has no `options` override arm at all
(`app.ts:27` passes `env.INTERNAL_API_SECRET` directly), and its schema now rejects blank, so
the S-8 concern about usage's missing blank guard is closed by the schema rather than left open.

### Deviations — rulings

| # | Deviation | Ruling |
|---|---|---|
| 1 | D1.1 — fragment in `shared-validation`, not `shared-types` | **Accept.** Premise verified: `grep "^import" packages/shared-types/src/index.ts` → nothing, `dependencies` → `{}`. The leaf property is preserved. Flagged in the plan with silence-means-accept; correct call |
| 2 | `shared-validation/package.json` + `tsconfig.json` `rootDir` → `../..` | **Accept.** Mirrors `packages/shared-utils/tsconfig.json`, which has had `rootDir: "../.."` since `e9d2c1a` (pre-existing, verified at `2cdb140`). Packages resolve via `main: "src/index.ts"`, so the `dist` layout change reaches no consumer. Build green |
| 3 | `docs/reviewer-checklist.md` edited outside the plan's file list | **Accept.** The table says "keep this table honest"; leaving it would have shipped three false rows. Not editing it would itself have been a finding |
| 4 | G1a placed per-service as an identity assertion | **Accept, and it is stronger.** Falsified by mutation above |
| 5 | Phase matrix corrected `400 FST_ERR_VALIDATION` → `500 INTERNAL_ERROR` | **Accept.** Re-performed; the plan's prediction was wrong and the correction is right |
| 6 | G7/D6 corrected; direct-invocation case added | **Accept.** Re-measured; the correction is right and properly scoped |
| 7 | R8 discharged by measurement rather than a fixture route | **Accept.** `W12` reddens under the phase revert, so worker's case is demonstrably not vacuous |

---

## What I could NOT verify, and why

- **The constant-time property.** I **assert and endorse nothing** about it. No test in this
  change claims it, and I confirmed no file overclaims: `grep` for
  `proves constant|constant-time.*verified|timing.*asserted` across `apps`, `packages`,
  `docs/releases` and `.claude` → **no match**. The non-proof is stated where a reader could
  infer one — `packages/shared-utils/src/index.ts:40` (*"The constant-time property is not
  established by any test"*) and `packages/shared-utils/tests/unit.test.ts:250`. A green suite is
  not evidence here and this review does not treat it as any.
- **The exact "29 sites / 20 distinct values" inventory count.** The counting convention is not
  stated, and my own derivation gives 30 sites / 15 distinct under a looser regex. The
  *substantive* claim — every configured value passes, one pre-existing docs failure — **is**
  verified. Treat the count itself as unverified.
- **Anything outside `node:http` and `undici`.** No browser, forward proxy, load balancer or
  managed ingress was in the path of any probe. The change declares this correctly
  (`packages/shared-types/src/index.ts:145-147`) and I did not extend it.
- **`set-cookie`'s array-valued path.** Not probed, by me or by the change; correctly declared.
- **Code points outside the 20 + 2 boundary characters measured.** Not probed.
- **S-24's mechanism.** I observed the 22nd sighting and re-read from disk; I did not
  investigate the cause, and nothing here establishes it.
- **Production `INTERNAL_API_SECRET` values.** Nothing in the repository can see them; this is
  R1 and the release note is the only mitigation.

## Environment left as found

`git status --porcelain` identical to session start — same 24 modified files, same 5 untracked,
`24 files changed, 1129 insertions(+), 245 deletions(-)`. Every mutation was backed up **by
copy** and restored with `md5sum -c` passing; **no `git checkout --`, `git restore` or
`git stash` was used on any tracked file**. No stray probe files remain.

Redis **db 0**: baseline `DBSIZE` **2** before my first gate run, **1** after. I wrote nothing
to it directly. The decrease is an *expiry*, not a deletion — the surviving key is
`telemetry:events` (`TTL -1`, the real ingest stream, intact); what went was a TTL-bearing
`denylist:<jti>` key left in db 0 by an **earlier** session's auth-service run. This is **S-22**
behaving exactly as recorded: `apps/auth-service/tests/auth.integration.test.ts:34` hard-codes
`redis://localhost:6379` with no logical database, so *any* `pnpm test` — including the mandated
13-package gate — writes denylist keys into db 0 alongside the event stream. Unavoidable while
running the required gate; nothing was lost, and S-22 remains correctly open. Postgres: `Event`/`UsageLine`/`Invoice`/`InvoiceLineItem`/`Meter` = **0**, `Tenant` = **2**.
All five `telemetry*` roles present and `NOSUPERUSER NOBYPASSRLS`; `v1_7_worker_billing_enumerator`
still the head migration. Nothing rolled back, no role dropped; the only Postgres probe evaluated
literals through `DIRECT_DATABASE_URL`.

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| **R1** — a production secret fails the stricter rule and a service refuses to start | **Accepted, by design.** Fails loudly at module load naming the variable and the constraint; release note §1 gives a runnable pre-deploy check and §3 the remedy. No silent-corruption mode exists in this change |
| A future edit reintroduces `!==` | Covered by `BU135`/worker equivalent — **verified red under the real mutation**. Subject to LOW-2's reflow brittleness |
| A future edit returns a guard to `preHandler` | Covered by `BU71`/`W12` — **verified red**, and only those two |
| A service re-declares the schema locally | Covered by the four identity assertions — **verified red on a byte-identical re-declaration** |
| **S-9** — analytics-service has no guard and no `INTERNAL_API_SECRET` | **Correctly left open.** `tenant-isolation.md` now states it explicitly rather than by implication. The guard belongs with T-051's first tenant-scoped route |
| **S-23**, **S-39**, **S-12** | Correctly left open per D4; S-23's fix is now a repoint rather than a design and is the natural next task |
| **S-53** | Newly filed, LOW, open; every claim re-derived above. Correctly records-only — no epic file edited |
| Historical `S-8` citations in `docs/plans/` and `docs/reviews/` now dangle | **Accepted** per plan R6; `CLAUDE.md` makes those the historical record and they are not rewritten. Only `.claude/rules/` was redirected — which is where **HIGH-1** applies |

## Required before commit

1. **HIGH-1** — fix the two redirects at `.claude/rules/known-gaps.md:1832` and `:2444`.
2. **MEDIUM-1** — do not carry the per-file test decomposition into the commit message; use the
   measured column, or omit it.
3. **LOW-1** — reword the release note's "20 characters" at `:117-118`.

LOW-2 and NIT-1 are recommended, not required.

**Verdict: CONDITIONAL.** Re-review needed only on the three required items; no re-run of the
gate is required for (2) or (3), and (1) touches no code.

---

## Round 2

**Gate 6 — final review, post-QA.** Base `2cdb140`, nothing committed or staged, `git status
--porcelain` = **31** entries. Read-only: no fix in this document was applied. Round 1 above is
untouched; `docs/qa/s-008-timing-safe-internal-auth.md` is untouched.

**Verdict: CONDITIONAL.** Two MEDIUMs must be fixed before commit. Both are text-only — one
docblock sentence and one release-note paragraph — and neither needs a gate re-run. The security
substance is sound: S-8 is closed item by item, I re-derived the outage and every corrected
claim by execution, and the 13-package gate is green with `--force` and 0 cached.

### Which revision of `known-gaps.md` I read

From **disk**: `md5 f55a81a551756fea7094e110e7d69b40`, **3501 lines**, entries **S-5 … S-54**,
**no S-8** — `grep '^## S-'` goes S-5, S-6, S-9, so the deletion is real. S-53 at `:3331`, S-54
at `:3401`.

The copy injected into this session's context ended at **S-39 and still contained S-8** — stale
by 15 ids, including both entries this diff adds. **That is S-24 firing again.** Every citation
below was re-read with `sed`/`grep` from disk, and pre-change text from
`git show 2cdb140:.claude/rules/known-gaps.md`.

---

## Findings

### MEDIUM-1 · `packages/shared-validation/src/index.ts:74-76` — the F-8 fix states **four** callers; its own grep returns **eight**

Added by *this round* in response to QA F-8, so no gate has seen it. The docblock reads:

> There are **four** callers that pass the option, not the two the smoke suites account for --
> `grep -rn "buildBillingServiceApp(\|buildWorkerServiceApp(" --include=*.ts apps`, filtered to
> calls with an argument, returns [billing `smoke.test.ts:18`, worker `smoke.test.ts:18`,
> billing `env.schema.unit.test.ts:490`, worker `env.schema.unit.test.ts:898`]

**Measured — I ran the docblock's own command on the tree under review:**

```
$ grep -rn "buildBillingServiceApp(\|buildWorkerServiceApp(" --include=*.ts apps | grep -v dist/ \
    | grep -vE 'buildBillingServiceApp\(\)|buildWorkerServiceApp\(\)|= \(|export const'
apps/worker-service/tests/smoke.test.ts:18            { internalApiSecret: "test-secret" }
apps/worker-service/tests/env.schema.unit.test.ts:881  { internalApiSecret: "   " }      <- omitted
apps/worker-service/tests/env.schema.unit.test.ts:884  { internalApiSecret: "" }         <- omitted
apps/worker-service/tests/env.schema.unit.test.ts:898  { internalApiSecret: overrideSecret }
apps/billing-service/tests/smoke.test.ts:18           { internalApiSecret: "test-secret" }
apps/billing-service/tests/env.schema.unit.test.ts:472 { internalApiSecret: "   " }      <- omitted
apps/billing-service/tests/env.schema.unit.test.ts:475 { internalApiSecret: "" }         <- omitted
apps/billing-service/tests/env.schema.unit.test.ts:490 { internalApiSecret: overrideSecret }
COUNT of calls with an argument: 8
```

The four omitted are the blank-guard cases (`expect(() => buildXApp({ internalApiSecret: "   " }))
.toThrow(...)`). A *differently worded* claim would be true — four callers **successfully
construct an app** through the bypass, the other four throw — but the sentence as written asserts
what the grep returns, and the grep returns eight. This is the S-33 shape, in a paragraph whose
whole purpose is to widen the reader's estimate of the bypass surface, so the undercount runs in
the unsafe direction for its own argument. It sits in a shared package's docblock beside the
security-relevant fragment, which `.claude/rules/review-standards.md` § *Claims the Change Makes*
puts at MEDIUM.

**Required fix**, one sentence:

> There are **eight** calls that pass the option, not the two the smoke suites account for.
> `grep -rn "buildBillingServiceApp(\|buildWorkerServiceApp(" --include=*.ts apps`, filtered to
> calls with an argument, returns eight: billing and worker `smoke.test.ts:18` (both passing the
> 11-character `"test-secret"` this fragment would refuse), billing `env.schema.unit.test.ts:490`
> and worker `:898` (which build successfully with an override), and billing `:472`/`:475` and
> worker `:881`/`:884`, which pass `"   "` and `""` to drive the blank guard and therefore throw.
> **Four of the eight construct an app through the bypass.**

### MEDIUM-2 · `docs/releases/s-008-timing-safe-internal-auth.md` §5 — "redeployed in any order" is false for exactly the secret this change exists to fix, and §4 already says so

§5 reads:

> For a secret that is valid under the new rule, old and new code behave identically in both
> directions: the new services accept what the old ones accepted, and **the old services accept
> what the new ones send. Mixed versions interoperate and the services may be redeployed in any
> order.**

A **whitespace-padded** secret *is* valid under the new rule — the trim runs first, so
`internalApiSecretSchema.safeParse("  " + 32 chars + "  ").success` is `true` (measured). The
scope clause therefore does not exclude it, and for that class the claim is false.

**Measured, over a real `node:http` socket against the real billing guard factory**, deployed
value `"  " + "a"×32 + "  "`:

```
valid under the NEW rule?  true
old sender transmits : "  aaaa…aaaa  "     (z.string().min(32), gateway at 2cdb140)
new sender transmits : "aaaa…aaaa"          (internalApiSecretSchema)

  OLD gateway  ->  OLD service  :  401     <- the pre-existing S-8 outage
  OLD gateway  ->  NEW service  :  200
  NEW gateway  ->  OLD service  :  401     <- refutes "the old services accept what the new ones send"
  NEW gateway  ->  NEW service  :  200
```

So an operator whose deployed secret carries stray padding, reading §5 for deploy ordering and
updating gateway first, re-creates the S-8 outage on every service not yet updated. §4 gives the
correct guidance — *"The fix is complete only once all four services carry the change… Redeploy
all four."* — but it is in the "what this fixes" section, and §5 is the one headed
*Compatibility and rollback*. The two sections contradict each other and the wrong one is where
an operator looks for ordering.

This is the § *Universals Must Cite Their Mutation* pattern: the claim was established on
already-clean secrets, and the refuting case is the padded value the whole change is about.

**Required fix** — narrow §5 and cross-reference §4:

> For a secret that is **already trimmed** and valid under the new rule, old and new code behave
> identically in both directions and the services may be redeployed in any order.
> **If your deployed value carries leading or trailing whitespace this does not hold**, even
> though the new rule accepts it: a new gateway transmits the *trimmed* value while an old
> usage-service still compares against the *padded* one. Measured — OLD→OLD `401`, OLD→NEW `200`,
> **NEW→OLD `401`**, NEW→NEW `200`. Strip the padding from the deployed value first (§1's check
> prints `NOTE: has surrounding whitespace`), or redeploy all four together as §4 requires.

See also the decision at the end of this round, which is about whether §1's check should escalate
that `NOTE` to a blocking step.

### LOW-1 · The plan's §5.6 inventory greps report **95**/**115**; on the tree under review they return **97**/**118**

`docs/plans/s-008-timing-safe-internal-auth.md` §5.6 states the bare pattern returns 95 lines and
the `\s*` pattern 115. Measured now, same exclusions (`node_modules`, `dist`, `.git`):

```
grep -rn  "INTERNAL_API_SECRET[:=]"    .   -> 97    (plan says 95)
grep -rnE "INTERNAL_API_SECRET\s*[:=]" .   -> 118   (plan says 115)
```

The cause is the S-33 sub-pattern the repo already names — **the artifacts quoting the count are
inside the search scope**. Measured contribution of the S-8 documents themselves: plan 9/11, QA
3/4, review 1/2, release note 2/2, `known-gaps.md` 1/1 = **16 bare / 20 with-`\s`**. Every edit
this rework made to those files moved the number it was reporting.

**The conclusion is unaffected and I verified it independently.** Parsing all 30 enumerated sites
against the shipped fragment: **30 sites checked, 29 PASS**, one FAIL —
`docs/epics/epic-3-shared-service-infra.md:172` (`change-me-internal-secret`, 25 characters), which
already fails today's `.min(32)` and is therefore pre-existing. That reproduces QA's independent
29. (My extractor also flagged `apps/gateway/tests/config/container.unit.test.ts:14`; that is my
extractor's limit, not a failure — the value is `"test-internal-secret-" + "x".repeat(32)` = 53
printable-ASCII characters and it passes. The plan already labels it "built by concatenation".)
F-3's two named blind spots both reproduce: `grep -cE 'INTERNAL_API_SECRET\s*[:=]'` returns **0**
on all three `tests/setup.ts` files, which use `??=`.

**Fix:** either drop the two raw line counts (they cannot be stable while the documents quoting
them are in scope), or state the exclusion — e.g. *"…excluding `docs/**` and `.claude/**`, which
contain this entry"* — and re-measure under it.

### LOW-2 · F-9 is described as "folded into S-17", and nothing was folded anywhere

The plan's Gate-5 disposition says the stale `packages/shared-validation/dist/` is accepted with
*"no new id … because S-17 already records exactly this shape for `shared-utils`"*, and that
*"whoever acts on S-17's `dist` paragraph should sweep both packages."*

**Measured:** `grep -n 'shared-validation' .claude/rules/known-gaps.md` returns lines 256, 281,
1693, 1702, 1836, 3414, 3486 — all S-16, S-40 and S-54 material. **None is about `dist`.** S-17's
own paragraph (`:316-321`) still names only `packages/shared-utils/dist/**/*.d.ts`. So the
sweep-both-packages instruction exists **only** in `docs/plans/`, which `CLAUDE.md` is explicit
nothing may read as a record — the same defect S-44 is an open entry about.

The technical disposition is right and I re-derived it: `packages/shared-validation/dist/src/index.js`
exists (dated 15:00, pre-change) with `grep -c internalApiSecretSchema` → **0**; the new emit at
`dist/packages/shared-validation/src/index.js` has **1**; all three shared packages' `main` is
`src/index.ts`; and `git check-ignore` confirms `.gitignore:4:dist`. Nothing is reachable.

**Fix:** add one sentence to S-17's `dist` aside — *"`packages/shared-validation` acquired the
same shape at S-8 when its `rootDir` moved to `../..`; sweep both."* Keeping the observation only
in the plan is what the repo already has an id for.

### LOW-3 · Round 1's lint breakdown mis-attributes auth-service's ten warnings

Round 1 above records the 14 pre-existing warnings as *"10 in `apps/auth-service/tests/auth.service.unit.test.ts`
(`no-misused-promises` ×8, `no-unsafe-assignment` ×2)"*. **Measured on this run: all ten are
`no-misused-promises`** (lines 61, 86, 117, 144, 179, 204, 231, 262, 297, 323); the four
`no-unsafe-assignment` are all in `apps/usage-service/tests/ingestion.service.unit.test.ts`
(339, 340, 543, 544). Totals, files, provenance and the pre-existing classification are all
correct — only the rule split is wrong.

Recorded here rather than corrected, because Round 1 is not to be edited. It is in
`docs/reviews/`, not an authoritative file, and nothing downstream cites it. **No action
required**; do not carry the ×8/×2 split into the commit message.

### NIT-1 · Plan appendix: `global fetch … cause null`

`docs/plans/…:1343` records `Node 22.22.2 global fetch -> TypeError  code undefined  cause null`.
Re-derived on this host: the constructor is `TypeError` and `code` is `undefined` (both correct),
but `e.cause` is **absent** (`typeof e.cause === "undefined"`), not `null`. Scope of my probe:
Node 22 on this host, the `http.request`/`fetch` header-validation path with an above-U+00FF byte,
no listener. The load-bearing half of F-6 — that the constructor is `TypeError`, not `Error` — is
confirmed: `node:http -> TypeError code ERR_INVALID_CHAR`. I could not re-derive the `undici`
`request()` row from the repository root (`MODULE_NOT_FOUND`); that row is unverified by me, not
refuted.

### Observation · the local `.env` cannot boot any service, and already could not

Root `.env:6` is `INTERNAL_API_SECRET=dev-local-secret` — 16 characters. It fails the new rule and
**equally fails today's `.min(32)`**, so this is pre-existing and not caused by the change. It is
gitignored (`git check-ignore` → `.gitignore:6`), `docker/docker-compose.yml` uses no `env_file`,
and I found no `dotenv` loader in any service's `config/env.ts` or `index.ts`. Mentioned only so
that a developer who hits the new error locally does not read it as a regression.

---

## Priority 1 — the "no production behaviour changed this round" claim

**I could not establish it mechanically, and no artifact in this repository can.** Stated plainly
because an unverifiable "text only" is worth knowing about before commit.

What I looked for and did not find:

- **A pre-round build artifact.** All `dist/` output is dated 18:08–18:13, *after* the last rework
  edit at 18:07:16. The one exception, `packages/shared-validation/dist/src/index.js` at 15:00, is
  the stale pre-`rootDir` emit (F-9) and contains none of the new code.
- **A git pre-image.** 29 loose objects were created today; I resolved every one with
  `git rev-list --objects 2cdb140` and **all belong to the HEAD commit** (e.g.
  `635c99ee… apps/billing-service/src/repositories/base.repository.ts`). `git reflog` shows no
  intermediate, `git stash list` is empty, nothing is staged.

**What I established instead, and it is stronger than the claim it replaces.**

**(a) The complete non-comment delta of all seven files, mechanically.** I compiled both
`git show 2cdb140:<file>` and the worktree copy with the repo's own
`tsc 5.9.3 --removeComments` and diffed the emitted JS. That is an authoritative comment stripper,
not a regex. The **entire** production delta across the seven round-2 files is:

| file | non-comment change |
|---|---|
| billing `internal-auth.middleware.ts` | `+import { secretsMatch }`; `normalizedSecret = Array.isArray(…)` and `!== internalApiSecret` removed; `typeof providedSecret !== "string" \|\| !secretsMatch(...)` added; `return reply.status(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED)` replaces un-returned `reply.status(401)` |
| billing `app.ts` | `preHandler` → `onRequest` (one line) |
| worker `internal-auth.middleware.ts` | identical to billing's, with `WORKER_RESPONSES` |
| worker `app.ts` | `preHandler` → `onRequest` (one line) |
| `shared-types/src/index.ts` | `+SECRET_PATTERN`, `+SECRET_PATTERN_MESSAGE` (and a comma) |
| `shared-utils/src/index.ts` | `+timingSafeEqual` import, `+secretsMatch` |
| `shared-validation/src/index.ts` | `+internalApiSecretSchema` |

Nothing else. I closed `tsc`'s one blind spot — it erases type-only declarations — by grepping the
raw diffs of the same seven files for changed `interface`/`type`/`declare` lines: none beyond what
is already visible above.

**(b) A pre-round-2 artifact independently attests that same delta.** Round 1 was written at
16:50, before the rework began at 17:51, and it records this production shape by execution: all
three guards importing `secretsMatch` with no local `timingSafeEqual` copy; `billing/src/app.ts`
and `worker/src/app.ts` both `onRequest`; both guards `return reply.status(...)`;
`HTTP_STATUS_UNAUTHORIZED` in both; all three rejecting any non-string. That covers every line of
the delta for the four app files, and Round 1's measured schema table and `secretsMatch` behaviour
pin the semantics of the other three. The shipped delta matches that pre-rework account line for
line.

**(c) mtime corroborates the file set exactly, and rules out test changes outright.** Exactly ten
files postdate the QA report (17:46:50): the seven source files (17:51:21 – 18:07:16), the release
note, the plan and `known-gaps.md`. **No test file is among them** — the newest test file in the
whole change is `apps/billing-service/tests/internal-billing.route.test.ts` at 16:15, and the three
new untracked test files are 16:06 and 17:12. So *"no test logic and no test name changed this
round"* is established; mtime is weaker than a pre-image (an edit that restored mtime would defeat
it) but it agrees with (a) and (b).

**Conclusion.** "Text only" is **corroborated, not proven**. What is proven is the thing that
matters more: the total production delta on the tree that will be committed is seven small hunks,
enumerated above, and it is byte-for-byte the design that Round 1 verified by mutation and QA
verified by drive — so QA's PASS transfers to this tree by measurement rather than by assertion.
I additionally re-performed the load-bearing behavioural measurements myself (below), which makes
the transfer independent of both.

---

## Priority 2 — does S-8 stay closed, and is the boundary described honestly?

### The outage and its fix — re-derived

Over a real `node:http` socket against the real billing guard factory, with the two `2cdb140`
declarations parsing one deployed value:

```
deployed            : "  aaaa…aaaa  "
usage/gateway parses: "  aaaa…aaaa  "  len 36     (z.string().min(32))
worker/billing      : "aaaa…aaaa"      len 32     (z.string().trim().min(32))
header as received by the upstream: "aaaa…aaaa"   (edges stripped in transit)

gateway sends padded -> untrimmed-expecting service : 401
gateway sends padded -> trimmed-expecting   service : 200
CONTROL, clean secret                               : 200 / 200
AFTER FIX, all four parse to "aaaa…aaaa"            : 200
```

### S-8 closed item by item, against `git show 2cdb140:.claude/rules/known-gaps.md` (lines 39-168)

| S-8 item | Status | How I established it |
|---|---|---|
| 1 · `!==`, not timing-safe | **closed** | No `!==` secret comparison in any guard; every remaining `!==` hit is a comment or the `typeof … !== "string"` type guard. All three `import { secretsMatch } from "@telemetry/shared-utils"`. `grep -rn 'timingSafeEqual\|const secretsMatch' apps/*/src` → **none** — one definition, in `shared-utils` |
| 2 · untrimmed `.min()` in usage + gateway | **closed** | All four `config/env.ts` are `INTERNAL_API_SECRET: internalApiSecretSchema`. `SECRET_MIN_LENGTH` no longer appears in executable service code. Measured: 32 spaces and a 31-core-padded-to-35 both now **reject** where `.min(32)` accepted them |
| 2-addendum · the `Cf` residue hole | **closed** | The five characters S-8 measured as *"accepted as a 32-character secret"* — U+200B, U+2060, U+180E, U+200C, U+00AD — all **REJECT** under the new rule, and the twelve it listed as stripped still reject. Re-derived character by character |
| 2 · usage's misleading docblock | **closed** | `apps/usage-service/src/middleware/internal-auth.middleware.ts:20-28` is reworded and explains *why* "non-empty" misled, which is what S-8's own text demanded |
| 3 · `preHandler`, un-returned reply | **closed** | `billing/src/app.ts:80` and `worker/src/app.ts:74` both `onRequest`; both guards `return reply.status(...).send(...)` |
| 4 · literal `401`; `provided[0]` divergence | **closed** | `HTTP_STATUS_UNAUTHORIZED` in both; `Array.isArray(provided) ? provided[0]` gone from both; all three reject any non-string identically |

**The deletion of S-8 is justified.** Every item is closed by measurement, not by reading.

### F-2's TAB correction — re-derived, and the sweep is complete

```
                       new fragment | old .min(32) | old .trim().min(32)
internal TAB (33 ch)      reject    |   ACCEPT     |   ACCEPT
internal single space     ACCEPT    |   ACCEPT     |   ACCEPT
internal double space     ACCEPT    |   ACCEPT     |   ACCEPT

TAB secret over a real node:http socket, 16th byte 0x09:
  sent     : 61 61 … 61 09 61 … 61
  received : 61 61 … 61 09 61 … 61      byte-identical: true    status: 200
```

So TAB **transits byte-identically, authenticates `200`, and was accepted by both pre-S-8
declarations** — the newly-rejected class, exactly as F-2 corrected it. The four sites all now say
internal **spaces**:

- `packages/shared-types/src/index.ts:126-147` — `SECRET_PATTERN`'s docblock narrows the space
  claim and adds a *"TAB is a different case and this rule refuses it"* paragraph that names the
  measurement, the two pre-S-8 declarations and decision D-1, and says outright that an earlier
  revision cited TAB as evidence for the opposite (QA F-2).
- `docs/releases/…` §1 — names internal TAB as newly-refused, with the remedy for that class.
- plan §D1.4 (`:280-289`) and appendix A6 (`:1406-1408`) — both now label the `09` row *"a transit
  result, not a verdict"* and *"evidence for the newly-breaking class, not against it"*.

I swept for a fifth site: every other `internal TAB`/`HTAB` mention in `apps`, `packages`, `docs`
and `.claude` is either about **edge** SP/HTAB stripping in transit (accurate and unrelated) or is
in a prior task's review. **No surviving text claims internal TAB is legal.**

I also drove the release note's §1 operator script verbatim: it prints
`FAIL: contains non-printable or non-ASCII: U+0009` for the TAB case, which is precisely what §1
promises it will name.

### F-1's state count — revert re-performed on **both** services

Backed up both `app.ts` **by copy**, applied the `preHandler` revert, drove six request shapes at
each service's real internal route with no credential, restored by copy and verified with
`md5sum -c` (both `OK`). No `git checkout --`, `git restore` or `git stash` was used.

```
SHIPPED (onRequest)                    billing            worker
  all six shapes                    -> 401 (1 state)   -> 401 (1 state)

REVERTED (preHandler)                  billing            worker
  valid JSON / schema-invalid /
  text/plain / no body              -> 401             -> 401
  malformed JSON                    -> 500 "Body is not valid JSON but content-type is set to
                                            'application/json'"
  no content-type                   -> 500 "Unsupported Media Type"
  DISTINGUISHABLE STATES               3                  3
```

**Three on both, identically, with identical 401 membership.** The four corrected sites — billing
`internal-auth.middleware.ts:47-55` and `app.ts:69`, worker `internal-auth.middleware.ts:42-50`
and `app.ts:65` — all say **three**, all carry the `"Unsupported Media Type"` row, and all now
describe one measurement. The named regression cases hold too: under the revert the full suites
gave `billing 1 failed | 230 passed` (**`BU71` only**) and `worker 1 failed | 250 passed`
(**`W12` only**), which is exactly what the two `app.ts` comments claim.

---

## Priority 3 — the new entries at the authoritative-file bar

### S-54 — re-derived, and **I rule that refusing to state a threshold is correct**

```
node http.maxHeaderSize = 16384
fragment accepts "a".repeat(16384) : true
fragment accepts "a".repeat(65536) : true

len=    32  status=200  upstreamSaw=len 32     identical=true
len=  8192  status=200  upstreamSaw=len 8192   identical=true
len= 12288  status=200  upstreamSaw=len 12288  identical=true
len= 16384  status=431  upstreamSaw=NOTHING

grid (transport outcome per secret length x sibling-header size):
filler=    0   …  12288:reached  15360:reached  16384:431  32768:ECONNRESET
filler= 1024   …  12288:reached  15360:431      16000:ECONNRESET  16384:431  32768:ECONNRESET
filler= 4096   …  12288:431      15360:ECONNRESET  16000:431  16384:ECONNRESET  32768:431
```

Every `431` and `ECONNRESET` cell reproduces S-54's grid **exactly**, cell for cell, on all three
rows. (My cells below the threshold read `401` rather than `200` only because my upstream expected
a different secret; the transport outcome is what the entry claims and it matches.) Both
refinements hold: **12 288 alone reaches the server and the same value beside a 4 KiB sibling
returns `431`**, so the budget is the whole header block; and the failure is sometimes
`ECONNRESET` rather than `431`.

**Ruling: refusing to state a threshold is right, and the entry should not be asked to give one.**
The grid is not monotone in either dimension on my run either — at `filler=4096`, `12288→431`,
`15360→ECONNRESET`, `16000→431`, `16384→ECONNRESET` — which is the same non-monotonicity the
entry's bisection caveat describes, from an independent run. A single number from one host would
be a false universal of exactly the kind `.claude/rules/review-standards.md` forbids, and the
entry's `.max()` discussion correctly frames the number as a judgement rather than a measurement.

### The weakening of QA's wording — **correct, and required**

QA §10 wrote *"the failure is at startup rather than in traffic, **with the single exception in
F-4**"*. S-54 weakens this to *"the only class QA found"*, states the search (400 random
printable-ASCII candidates of length 32–200, `round-trip mismatches: 0`, `non-200 statuses: 0`),
and notes the band *"tops out at 200, so it could not have found this one"*.

**The weakening is correct.** QA's "single exception" is a universal resting on a sweep that, by
its own length band, could not reach the class it was being cited to bound — probes varying one
dimension written up as a general result, which is the § *Universals Must Cite Their Mutation*
pattern verbatim. Endorsing the original wording would have shipped a false universal into an
authoritative file.

**I extended the search in the dimension the sweep only sampled, and found no second class.** All
**95** printable ASCII code points, each embedded mid-secret in a 41-character value, driven
through the real guard over a real socket: **95 checked, 0 anomalies** — every one accepted by the
fragment, round-tripped byte-identically, `200`. And the length band the 400-candidate sweep never
reached: `200, 400, 800, 1600, 3200, 6400` all `200` with byte-identical round-trip. That
strengthens the entry without turning it into an exhaustiveness claim, which is the right place to
leave it: the length × header-block dimension is host- and topology-dependent and cannot be closed
from here.

### S-53 — every claim re-derived independently

- `docs/epics/epic-9-analytics-service.md:59` is verbatim
  `DATE_TRUNC('day', period_start AT TIME ZONE 'UTC') AS bucket_start` ✓
- Live PostgreSQL 16 through `DIRECT_DATABASE_URL`, `options=-c timezone=…`, **literals only, no
  table touched** — the three-zone table reproduces row for row, including
  **`America/New_York` → `2025-12-31 00:00:00-05`** against a bare-column `2026-01-01 00:00:00`
  stable in all three ✓
- `grep -c '@@map\|@map' prisma/schema.prisma` → **0**; real `UsageLine` columns from
  `information_schema` are `id tenantId eventId metricKey quantity periodStart periodEnd
  processedAt billed`; no `usage_lines` table exists (count 0) ✓
- `apps/analytics-service/src/repositories/base.repository.ts` — `grep -c TimeZone` → **0**, so the
  S-19 citation is accurate ✓

Scope is stated in the entry (three zones, one value, `day` only) and matches what is measurable.

---

## Priority 4

- **F-3 — verified.** The union and the arithmetic hold: **33 sites − 2 `WRONG_SECRET` header
  fixtures − 1 `VALID_JWT_SECRET` = 30 configured sites**, of which **29 pass** and the single
  failure is the pre-existing `docs/epics/epic-3-shared-service-infra.md:172`. Reproduced
  independently (see LOW-1 for the one stale figure and for my own parse of all 30). Both blind
  spots reproduce: the space-before-`=` shape, and `??=`, which `grep -cE
  'INTERNAL_API_SECRET\s*[:=]'` scores **0** on all three `tests/setup.ts` files.
- **F-5 — verified; I assert and endorse no constant-time claim.** The heading is now
  *"Equality for two secrets of unknown length, compared as fixed-width SHA-256 digests through
  `crypto.timingSafeEqual`"* — construction, not property. The timing figures are labelled
  *"indicative numbers from a shared host … not as a guarantee in either direction."* All four
  disclaimer sites are intact: `packages/shared-utils/src/index.ts:31` and `:58`,
  `packages/shared-utils/tests/unit.test.ts:250`, and the parallel sentence in **both**
  `internal-auth.middleware.unit.test.ts` files (`:29` worker, `:34` billing). A repo-wide sweep
  for `constant-time`/`constant time` across `apps`, `packages`, `docs/releases` and `.claude`
  returns **five** lines and **every one is a disclaimer**. Nothing in the diff invites the
  inference. **This review establishes nothing about timing behaviour and does not treat the green
  suite as evidence of any.**
- **F-7 — the byte-identity holds; I re-verified it myself.** I generated both messages by driving
  the *real* fragment (a 31-character control and a 32×U+00AD control, each formatted through
  `parseEnv`'s template) and byte-compared against release note lines 71 and 78: **`diff` empty,
  `md5 3b82b5ffcea74ed3fb658e0ce71b2b88` on both sides.** The other two reasons check out —
  `packages/shared-config/src/index.ts:10-13` reports `issues[0]` only, and the length message is
  zod's default while `SECRET_PATTERN_MESSAGE` is ours.
  **One qualification on the reasoning, not the decision:** "only half the message is ours" is
  weaker than stated, because zod's `.min(n, message)` takes a custom message — the asymmetry is a
  choice, not a constraint. The decision to decline still stands on reasons (2) and (3); the
  reason (1) wording should not be carried forward as if the asymmetry were forced.
- **F-8 — count refuted: see MEDIUM-1.** The framing is otherwise right and properly hedged:
  *"That is the reach as measured on this tree, not a claim that no future caller can be
  non-test."* I confirmed the rest — neither `src/index.ts` passes the option
  (`billing:23`, `worker:52` both call with no arguments), and usage-service and gateway declare no
  such parameter.
- **F-6 — correction verified.** `node:http` → **`TypeError`**, `code ERR_INVALID_CHAR`. See NIT-1
  for the one sub-field I measured differently and the one row I could not reach.
- **F-9 — technically right, but see LOW-2** on the "folded into S-17" framing.

---

## Priority 5 — final-review scope

### Compile-time gate — all 13 packages, `--force`, 0 cached

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | **13 successful, 0 cached**, 11.6 s |
| lint | `pnpm lint --force` | **13 successful, 0 cached**, 31.5 s |
| build | `npx turbo run build --force` | **13 successful, 0 cached**, 21.6 s |
| test | `npx turbo run test --force` | **13 successful, 0 cached**, 16.2 s |
| smoke | `pnpm test:smoke` | **6 suites, 7 cases, all pass** |

**Per-package test totals, and the root derived by me** — not taken from any hand-off:

```
shared-types 8    shared-tracing 2   shared-config 4    shared-logger 4
shared-validation 30   shared-utils 26   analytics-service 18   gateway 50
usage-service 238   auth-service 166   billing-service 231   worker-service 251
web 0 (no cases)
8+2+4+4+30+26+18+50+238+166+231+251 = 1028
```

**Root = 1028**, matching Round 1 and QA. Zero failed, zero skipped, zero todo. Worker did not
flake (251/251 on the gate run and on two further full runs during the revert probes).

**Lint: 0 errors, 14 warnings, all pre-existing and proven.**

| File | Warnings | Provenance (`git log -1 -- <file>`) | In this diff? |
|---|---|---|---|
| `apps/auth-service/tests/auth.service.unit.test.ts` | **10 × `no-misused-promises`** (61, 86, 117, 144, 179, 204, 231, 262, 297, 323) | `d68e719`, 2026-08-25 | **no** |
| `apps/usage-service/tests/ingestion.service.unit.test.ts` | **4 × `no-unsafe-assignment`** (339, 340, 543, 544) | `b0f6921`, 2026-08-31 | **no** |

Neither file appears in `git status --porcelain`. **Zero `no-unsafe-return`** anywhere in the log
(`grep -c` → 0). No warning in this change's own files.

### Test coverage alignment

No test file changed this round, so Round 1's and QA's coverage findings carry. Checked against the
seven-hunk production delta: every hunk has a case, and each has a **named failing mutation** —
`secretsMatch` routing (`BU135` + worker sibling), the non-string guard (`BU137`), the phase
(`BU71`/`W12`, both re-derived by me this round), the four schema identity assertions, and the
fragment's own input table. Test-honesty spot checks re-confirmed: `readMiddlewareSource()`
**throws** on an empty file rather than asserting vacuously; `BU72` is `BU71`'s anti-vacuity
control. LOW-2 from Round 1 was answered by **documenting** the reflow brittleness rather than
tightening the assertion (`internal-auth.middleware.unit.test.ts:60-74`), which states the
direction of the risk correctly — a false positive is possible, a false negative is not.

### Release readiness and breaking-change assessment across the 13 packages

- **Breaking change, deliberate and operational:** a service whose deployed `INTERNAL_API_SECRET`
  fails the stricter rule will not start. It fails at module load (or at `loadEnv()` for gateway —
  verified: `apps/gateway/src/config/env.ts:41-42` vs `export const env = parseEnv(...)` at
  usage `:41`, worker `:127`, billing `:43`), so it never appears healthy. Every value configured
  in the repository passes (29/30; the one failure is pre-existing docs).
- **Wire-visible changes:** two internal routes now answer `401` where an unauthenticated caller
  previously got a `500` naming the body parser — strictly less information. A duplicated header is
  rejected by all three rather than having its first value taken by two.
- **The other nine packages:** `auth-service`, `analytics-service`, `web`, `shared-config`,
  `shared-logger`, `shared-tracing` are untouched by the diff; `shared-types`, `shared-utils` and
  `shared-validation` gain additive exports only (no existing export changed — the comment-stripped
  emit diff above is the proof). No migration, no schema change, no persisted state; rollback is
  redeploying the previous image.
- **Release note, end to end:** accurate on everything I checked except §5 (**MEDIUM-2**). §1's
  operator script is correct — I extracted it verbatim and drove it against every class it claims:
  not-set, 31 chars, 32 spaces, 31-core-padded-to-35, padded-valid, internal TAB, internal spaces,
  32×U+00AD, 32×U+200B, U+00FF-inside. It reports each correctly and names the offending code
  points, including `U+0009` for TAB exactly as §1 promises. The two error strings are
  byte-identical to the runtime (md5 match). "the five `.env.example` files" is right — exactly
  five carry the variable.
- **`.claude/rules/tenant-isolation.md`'s layer-2 rewrite is accurate**, including its `/health`
  universal, which I tested rather than read: driven on both services with **no** secret and with a
  **wrong** secret, `/health` returns `200` in all four cases, so the structural exemption holds.
  Hook order at `billing/src/app.ts:120-121` is internal-auth **before** tenant-context, which is
  what § *Forbidden* requires. S-9's retention is accurate: `apps/analytics-service/src/middleware/`
  contains only `index.ts` and its `config/env.ts` has **0** occurrences of `INTERNAL_API_SECRET`.
- **`docs/reviewer-checklist.md`'s compliance table** now matches what I measured on all four rows.

### What an operator must know that no artifact says

Two things, both feeding the decision below:

1. **A padded-but-valid secret makes the rolling deploy order load-bearing** — MEDIUM-2. §4 says
   "redeploy all four"; §5 says "any order". The measured answer is that gateway-first re-creates
   the outage on the not-yet-updated services.
2. **The §1 check's `NOTE: has surrounding whitespace` is not currently actionable.** It prints
   alongside `OK`, so an operator reads it as cosmetic. It is in fact the signal that (1) applies
   to them.

---

## Decision for the user

### D-2 · Should §1's whitespace `NOTE` become a blocking pre-deploy step?

**The question.** §1's check prints `NOTE: has surrounding whitespace, which will be stripped`
next to `OK` for a padded secret. That padded secret is exactly the value for which old and new
services disagree about what to transmit (measured: NEW gateway → OLD service = `401`). Should the
release note tell the operator to strip the padding **before** deploying, rather than noting it in
passing?

| Option | What it changes | Diff impact |
|---|---|---|
| **A · Fix §5's wording only** (the MEDIUM-2 required fix) | §5 stops claiming "any order" and points at §4 | Release note prose only. **Required regardless** |
| **B · A, plus make the `NOTE` an explicit pre-deploy step** — "if you see this NOTE, re-issue the secret without the padding first; then the deploy order is free" | Turns a cosmetic line into an action, and makes the ordering hazard disappear rather than be managed | Release note prose only. No code, no test |
| **C · A, plus make the script exit non-zero on padding** | An operator running it in a pipeline is stopped rather than informed | Changes the script's contract in §1; a reader who has already scripted against exit 0 is affected |

**Recommendation: B.** It costs one sentence, no code and no test, and it removes the hazard at
its source instead of asking the operator to sequence around it — a secret with no padding
interoperates in any order, which is what §5 wanted to be able to say. **C** is defensible but
changes a published check's exit contract for a value the new rule deliberately accepts, which
would be a fourth strictness in a change whose whole subject is that four rules had drifted.

**A and B change only the release note. C changes what the script does.** All three leave the
code, the tests and the gate untouched.

---

## What I verified, and what I could not

**Verified by execution this round:** the complete comment-stripped production delta of all seven
round-2 files; the S-8 outage on `2cdb140` schemas and its closure; every S-8 item including the
addendum's five-character `Cf` residue; TAB transit, authentication and dual pre-S-8 acceptance;
the F-1 revert on both services with the full-suite blast radius (`BU71`, `W12`, nothing else);
the four F-1 sites and all F-2 sites; S-54's grid, boot-acceptance and `maxHeaderSize`; S-53's live
three-zone table and schema claims; the 30/29 inventory by parsing every site against the shipped
fragment; the byte-identity of both operator-facing messages; the release note's §1 script against
ten classes; the `/health` structural exemption on both services; gateway's lazy parse; the
13-package gate with `--force` and 0 cached, root 1028; the lint provenance; and HIGH-1's fix —
the deferral sentence at `docs/plans/…:77` is **byte-identical** to `2cdb140`'s S-8 lines 41-42.

**Could not verify, and why:**

- **That this round changed no production line.** No pre-image exists anywhere (no pre-rework
  build, no git object, no backup). Corroborated three independent ways above; **not proven**.
- **The constant-time property.** I assert and endorse nothing about it. No test claims it and no
  file overclaims it — measured by sweep.
- **`undici`'s `request()` refusal row** in the plan's appendix — not resolvable from the
  repository root in my probe. Unverified, not refuted.
- **Anything outside `node:http` and this host.** No browser, forward proxy, load balancer or
  managed ingress was in any path. The change declares this limit correctly and I did not extend
  it. S-54's grid in particular is one host, one Node build.
- **`set-cookie`'s array-valued path.** Not probed, by me or the change; correctly declared.
- **Production `INTERNAL_API_SECRET` values.** Nothing in the repository can see them. This is R1
  and the release note is the only mitigation — which is why MEDIUM-2 matters.
- **S-24's mechanism.** I observed the sighting and re-read from disk; I did not investigate the
  cause.

## Environment left as found

`git status --porcelain` = **31** entries, identical to session start. Both `app.ts` files were
backed up **by copy** before the revert and restored by copy, with `md5sum -c` passing on both. No
`git checkout --`, `git restore` or `git stash` was used on any tracked file. Every probe file was
written under a `zz_gate6_*` name inside a `tests/` directory and deleted immediately; no stray
file remains.

**Postgres:** `Tenant` = **2**, `User` = **2**, `Event`/`UsageLine`/`Invoice`/`InvoiceLineItem`/
`Meter` = **0**. All five `telemetry*` roles present, every one `NOSUPERUSER NOBYPASSRLS`.
`v1_7_worker_billing_enumerator` still the head migration — nothing rolled back, no role dropped.
The only Postgres probe evaluated literals through `DIRECT_DATABASE_URL`.

**Redis db 0:** `DBSIZE` **3** at session start (`telemetry:events` plus two `denylist:<jti>`
keys), **1** at the end. I wrote nothing to db 0. The decrease is **expiry, not deletion** — the
survivor is `telemetry:events`, the real ingest stream, intact; the two TTL-bearing `denylist:*`
keys were left there by earlier auth-service runs. New `denylist:*` keys appearing during the
mandated gate are **S-22**, behaving exactly as recorded: `apps/auth-service/tests/auth.integration.test.ts:34`
hard-codes `redis://localhost:6379` with no logical database, so any `pnpm test` writes there.
Unavoidable while running the required gate; nothing was lost and S-22 remains correctly open.

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| **MEDIUM-1** — false caller count in a shared package docblock | **Must fix.** One sentence; no code, no gate re-run |
| **MEDIUM-2** — §5's deploy-ordering claim is false for a padded secret | **Must fix.** Prose; see decision D-2 for whether to go further than the minimum |
| **R1** — a production secret fails the stricter rule and a service refuses to start | **Accepted, by design.** Fails loudly at module load naming the variable and the constraint; §1 gives a runnable check I re-derived, §3 the remedy. No silent-corruption mode exists |
| A future edit reintroduces `!==`, or returns a guard to `preHandler` | Covered by `BU135`/worker sibling and `BU71`/`W12` — **all re-verified red this round under the real mutations**, with the blast radius measured as exactly one case each |
| A service re-declares the schema locally | Covered by the four identity assertions; Round 1 falsified them on a byte-identical re-declaration |
| **S-9** — analytics-service has no guard and no `INTERNAL_API_SECRET` | **Correctly left open**, and now stated explicitly rather than by implication in `tenant-isolation.md`. Re-confirmed on this tree |
| **S-54** — no maximum length | **Correctly filed, LOW.** Grid re-derived; the refusal to name a threshold is the right call |
| **S-53** | Correctly filed, LOW; every claim re-derived |
| **S-17** should gain one sentence about `shared-validation/dist` | **LOW-2**, recommended not required |
| **S-12**, **S-23**, **S-39** | Correctly left open per D4 |
| Historical `S-8` citations in `docs/plans/` and `docs/reviews/` now dangle | **Accepted** per plan R6; only `.claude/rules/` was redirected, and HIGH-1's fix makes those redirects resolve — verified byte-identical |

## Required before commit

1. **MEDIUM-1** — correct the caller count at `packages/shared-validation/src/index.ts:74-76`
   (four → eight, with the four-of-eight-construct distinction).
2. **MEDIUM-2** — correct `docs/releases/s-008-timing-safe-internal-auth.md` §5's
   "any order"/"old services accept what the new ones send" claim, and cross-reference §4.
3. **Do not carry** the per-file test decomposition (Round 1 MEDIUM-1) or Round 1's ×8/×2 lint
   split (LOW-3 above) into the commit message.

LOW-1, LOW-2 and NIT-1 are recommended, not required. **Answer D-2** before the release note is
finalised — option A is the required minimum and B is one further sentence.

**Verdict: CONDITIONAL.** Both required fixes are text-only. No re-run of the 13-package gate is
needed for either; a re-read of the two edited passages is sufficient.
