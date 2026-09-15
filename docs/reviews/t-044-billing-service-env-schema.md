# Review — T-044 · Billing service env schema

Base `961d222` (T-043). Reviewed revision: the uncommitted working tree.
Reviewer: Senior Reviewer, Gate 4 (pre-QA). Read-only — no fix in this document was applied.

---

## Round 1

**Verdict: CONDITIONAL.**

The security substance is correct and was re-derived by execution, not accepted. S-8 item 2 was
live on the base commit and the fix inverts it. The required fixes below are three text
corrections — two in `.claude/rules/known-gaps.md`, one word in `apps/billing-service/src/config/env.ts`.
No code change is required and no test change is required.

---

### Findings

#### M-1 · MEDIUM — the rewritten S-8 entry miscounts in two directions

`.claude/rules/known-gaps.md:39` and `:47-48`.

**(a) The new title overcounts the guards.** The heading now reads
`## S-8 · the four internal-auth guards still diverge`. There are **three** internal-auth guards,
not four:

```
$ ls apps/*/src/middleware/internal-auth.middleware.ts
apps/billing-service/src/middleware/internal-auth.middleware.ts
apps/usage-service/src/middleware/internal-auth.middleware.ts
apps/worker-service/src/middleware/internal-auth.middleware.ts
```

Four is the count of *secret schema declarations*, which is a different set:

```
$ grep -ln "INTERNAL_API_SECRET" apps/*/src/config/env.ts
apps/billing-service/src/config/env.ts
apps/gateway/src/config/env.ts
apps/usage-service/src/config/env.ts
apps/worker-service/src/config/env.ts
```

The gateway is in the second set and not the first, and the repo's own authoritative table says
so: `docs/reviewer-checklist.md:28` gives gateway's guard cell as `n/a — it is the caller; injects
the header on every proxied request`. The retitle was justified on the grounds that the old title
asserted the opposite of what is now true — that reasoning is sound, and the grep backing it is
correct (`grep -rn "weaker than usage-service"` over `*.md`/`*.ts` excluding `node_modules`
returns nothing, exit 1 — re-run and confirmed). The replacement is simply wrong about the count.

**(b) Item 2's bolded summary undercounts the schemas.** `:47-48` reads
`what remains is usage-service's untrimmed `.min()``, and the parenthetical at `:44` says
`what is left of item 2 is **usage-service's**`. The entry's own body four lines later
(`:60-61`) says `apps/usage-service/src/config/env.ts:15` **and**
`apps/gateway/src/config/env.ts:14`, and the fix direction at `:87-88` names both. So the summary
line contradicts the body it introduces.

**Concrete fix.** At `:39` use a heading that does not assert a guard count, e.g.
`## S-8 · internal-auth guards and secret schemas still diverge — **MEDIUM, open**`, or state both
numbers: `three internal-auth guards, four secret schemas`. At `:44` and `:47-48` change
`usage-service's` to `usage-service's and gateway's`. At `:88` the phrase
`so all four services end up identical` should read `so all four *declarations* end up identical`
— the four services will still not be identical after that edit (usage-service alone has no
blank-secret guard in `app.ts` and alone has the timing-safe comparison), which the entry itself
documents at `:64-66`.

**Why MEDIUM and not HIGH.** The review standard rates a false claim in `.claude/rules/` as HIGH,
and the severity of a claim takes the severity of its subject. This claim asserts no protection
exists and causes no reader to skip a check; its cost is a future S-8 fixer looking for a gateway
guard that was never there, which is a wasted round rather than a hole. Recording the judgement
explicitly so it can be overridden.

#### L-1 · LOW — `env.ts:40-41` says U+00A0 "survived the wire intact"; it did so on one of the two client stacks

`apps/billing-service/src/config/env.ts:40-41`.

I re-ran all eight cases the comment cites — fastify 5.10.0 server on an ephemeral port, clients
undici 7.29.0 (resolved from `node_modules/.pnpm/undici@7.29.0`) and a raw `net.Socket`, four
padding forms:

```
undici exact core   arrived="<32 core>"                       ===CORE:true
undici SP-padded    arrived="<32 core>"                       ===CORE:true
undici HTAB-padded  arrived="<32 core>"                       ===CORE:true
undici NBSP-padded  arrived="<U+00A0><32 core><U+00A0>"       ===CORE:false
socket exact core   arrived="<32 core>"                       ===CORE:true
socket SP-padded    arrived="<32 core>"                       ===CORE:true
socket HTAB-padded  arrived="<32 core>"                       ===CORE:true
socket NBSP-padded  arrived="<U+00C2><U+00A0><32 core>…"      ===CORE:false
```

SP and HTAB stripping reproduces in all four cases, so that half of the claim holds. The U+00A0
case arrives **byte-identical over undici** but **mojibaked over the raw socket** — the UTF-8
bytes decoded as latin-1, giving `U+00C2 U+00A0`. "Intact" is therefore true of one stack and
false of the other. The load-bearing conclusion — *no longer matches a trimmed configured secret,
which is a 401 rather than a silent acceptance* — is **true in both** (`===CORE:false` for both),
so this is precision, not correctness.

Note the `.env.example:28` wording, which says `survives the wire` without `intact`, is accurate
as written; only `env.ts` adds the word.

**Concrete fix.** At `env.ts:41` replace `survived the wire intact` with
`survived the wire (byte-identical over undici; as latin-1-decoded UTF-8 over a raw socket) and
matched a trimmed configured secret in neither case`.

#### L-2 · LOW — known-gaps calls usage-service's comment "not true"; it is true literally and misleading in effect

`.claude/rules/known-gaps.md:66-68` says of
`apps/usage-service/src/middleware/internal-auth.middleware.ts:37-38` — which reads
`Validated non-empty and at least \`INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH\` long by the env
schema at module load` — that `the non-empty half is not true of an all-whitespace value`.

Measured against usage-service's real schema field (`EnvSchema.shape.INTERNAL_API_SECRET.safeParse`,
zod 3.25.76 — confirmed as the version all four services resolve):

```
usage     32 spaces              success=true  parsedLen=32
usage     32 tabs                success=true  parsedLen=32
usage     31-core padded to 35   success=true  parsedLen=35
usage     bare 31 chars          success=false
gateway   (identical results on all four inputs)
```

A 32-space string has length 32, so it *is* non-empty in the literal sense; `.min(32)` does
guarantee non-emptiness. What fails is the guarantee a security reader takes from the sentence —
"not blank" — which the schema does not provide. The recommendation the entry drives (add
`.trim()`, correct the comment) is right either way, so this is wording.

**Concrete fix.** At `:67-68` replace `the non-empty half is not true of an all-whitespace value`
with `"non-empty" will be read as "not blank"; \`.min(32)\` alone accepts 32 spaces (measured:
parses, length 32), so the guarantee a reader takes from that sentence is not the one the schema
provides`.

**On the decision not to edit usage-service's file:** correct, and I would have flagged the
opposite. D1-A scoped this task to billing; editing a comment in the live ingestion service's
auth middleware inside a billing env task is the move S-8 has twice declined, and recording it in
the gap entry is what keeps it from evaporating. `git status` confirms the file is untouched.

#### L-3 · LOW — `401` is now defined twice in billing-service

`apps/billing-service/src/constants.ts:24` adds `HTTP_STATUS_UNAUTHORIZED: 401` while
`apps/billing-service/src/middleware/internal-auth.middleware.ts:10` still writes the literal
`401`. `.claude/rules/constants.md` names duplicate definitions across modules as a finding.

**Disposition: accept as deliberate.** It is byte-for-byte the shape T-037 landed for worker
(`apps/worker-service/src/constants.ts:40` + `apps/worker-service/src/middleware/internal-auth.middleware.ts:10`,
both verified), the constants block says so at `constants.ts:19-22`, and `known-gaps.md:96-99`
names the adoption as S-8 item 3's work. Both new constants are genuinely used — `HTTP_STATUS_OK`
and `HTTP_STATUS_UNAUTHORIZED` at `tests/env.schema.unit.test.ts:252`, `:264`, `:303`, `:311` —
so neither is dead. See Decision 2 if you would rather close it now.

#### NIT-1 — duplicate `DEFAULT_PORT` / `HOST`, now pinned

`apps/billing-service/src/constants.ts:28-29` (`BILLING_RUNTIME`) and
`src/startup.constants.ts:3-4` (`BILLING_SERVICE_STARTUP`) both hold `3004` / `"0.0.0.0"` (plan
finding F7, left open). `BILLING_RUNTIME` is not dead — `tests/smoke.test.ts:10` uses it.

Worth recording as an improvement rather than a defect: `tests/env.schema.unit.test.ts:71`
(`expect(BILLING_RUNTIME.DEFAULT_PORT).toBe(BILLING_SERVICE_STARTUP.DEFAULT_PORT)`) now pins the
two copies together, so the duplication can no longer drift silently. Accept.

#### NIT-2 — `.env.example:23` reads as if the guard protects *against* in-cluster callers

`Guards billing's internal route group … against in-cluster callers and the published 3004 port
mapping`. The guard's purpose is to reject callers that did not come through the gateway; being
in-cluster is the threat's *location*, not its definition. Suggest
`against callers that did not come through the gateway — reachable in-cluster and through the
published 3004 port mapping`. Cosmetic.

---

### The ruling asked for: is the extra test right, and does the suite distinguish the orderings?

**Yes to both, and the test should stay — but the framing in the handoff is stronger than what
the artifacts claim, and the artifacts are the accurate ones.**

Measured by mutating `apps/billing-service/src/config/env.ts:46` against the real suite (file
restored and verified byte-identical after each run):

| Declaration at `env.ts:46` | Result |
|---|---|
| `z.string().trim().min(SECRET_MIN_LENGTH)` (shipped) | **16 passed (16)** |
| `z.string().min(SECRET_MIN_LENGTH)` | **3 failed \| 13 passed** — `rejects an all-whitespace …`, `rejects an INTERNAL_API_SECRET that reaches the minimum only by its padding`, `strips surrounding whitespace …` |
| `z.string().min(SECRET_MIN_LENGTH).trim()` | **2 failed \| 14 passed** — the first two of those three |

That is the `known-gaps.md:90-94` table and the `env.ts:25-34` comment, reproduced exactly. **The
suite does genuinely distinguish all three orderings.**

One correction to the handoff, not to the change. The brief states that *"the plan's AC3/AC4 pair
does not distinguish them."* That is false as stated: **AC4** (`strips surrounding whitespace …`)
does not distinguish them, but **AC3** (`rejects an all-whitespace INTERNAL_API_SECRET at the
minimum length`) is red under **both** wrong orderings — 32 spaces pass `.min(32)` and then trim
to `""`, so `safeParse` succeeds and `expectIssueOn` fails. AC3 alone would have caught
`.min().trim()`.

So the extra test is **not** needed to tell the orderings apart. It earns its place for a
different and better reason, and — this is the point — that is exactly the reason the implementer
wrote down, at `tests/env.schema.unit.test.ts:154-157`:

> A padded core one character short of the minimum is the input that `.min(...).trim()` accepts
> and `.trim().min(...)` rejects, so the two orderings differ here on a *non-blank* value that
> `app.ts`'s `!internalApiSecret.trim()` guard would let through.

Verified directly on zod 3.25.76:

```
min(32).trim()   32 spaces              OK -> ""                          (len 0)
min(32).trim()   31-core padded to 35   OK -> "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" (len 31)
```

AC3's failure mode under the wrong ordering is a **blank** secret, which `app.ts:44`'s
`!internalApiSecret.trim()` guard catches. The extra test's failure mode is a **live 31-character
secret** that reaches `buildInternalAuthMiddleware`. Those are different severities, and only the
second one is silent. The test covers the only uncaught case.

**Ruling: keep the test. The escalation was correct, the code comments describing it are accurate,
and no artifact needs editing on this point.** The comment at `env.ts:31-34` ("that case alone
would not have caught the wrong one", referring to `strips surrounding whitespace …`) is precisely
scoped and true.

---

### What I verified by execution

**S-8 item 2 was live on `961d222`, re-derived rather than inherited.** Reverted `app.ts` and
`config/env.ts` to the base commit via `git show` and built the app under `tsx`:

```
BASE: 5-char secret 'short' -> 200 {"status":"accepted","workflow":"billing-generation"}
BASE: wrong secret          -> 401 {"code":"UNAUTHORIZED"}
```

**The fix inverts it, before the DI container is built.** On the reviewed tree, importing
`src/app.ts` throws during module evaluation — so `createContainer` never runs:

```
short      -> Invalid environment configuration for INTERNAL_API_SECRET: String must contain at least 32 character(s)
33 spaces  -> Invalid environment configuration for INTERNAL_API_SECRET: String must contain at least 32 character(s)
missing    -> Invalid environment configuration for INTERNAL_API_SECRET: Required
```

The first two match the message quoted at `known-gaps.md:58` verbatim.

**AC8 is a real discriminator.** Reverting **only** `apps/billing-service/src/app.ts` to `961d222`
and leaving the new schema in place:

```
× app.ts reads the parsed secret, not process.env > authenticates with the parsed secret after
  process.env.INTERNAL_API_SECRET is mutated
  → expected 401 to be 200
Tests  1 failed | 15 passed (16)
```

Exactly one test red, with the failure message the implementer reported. H3 confirmed.

**Pseudo-TDD redness confirmed.** The new suite against the **full** base source (`app.ts`,
`config/env.ts`, `constants.ts` all at `961d222`): `Tests 12 failed | 4 passed (16)` — matching
the plan's `docs/plans/t-044-billing-service-env-schema.md` checklist claim of
"16 cases, first run 12 failed / 4 passed".

**The still-open half of S-8, measured against the real schemas** (not a reconstruction) — all
four numbers in `known-gaps.md:61-64` reproduce, and billing's inverted result confirms the fix:

| Input | usage | gateway | billing (fixed) |
|---|---|---|---|
| 32 spaces | ok, len 32 | ok, len 32 | rejected |
| 32 tabs | ok, len 32 | ok, len 32 | rejected |
| 31-core padded to 35 | ok, len 35 | ok, len 35 | rejected |
| bare 31 chars | rejected | rejected | rejected |
| bare 32 chars | ok | ok | ok |

**Other claims in the diff, each re-derived:**

- `usage-service` has no blank-secret guard: `grep -n "InternalApiSecretMissing\|trim()\|throw"
  apps/usage-service/src/app.ts` → no match; no such error class exists in
  `apps/usage-service/src/`. worker-service does throw (`app.ts:44-45`). Claim TRUE.
- `app.ts:26-27` "the one remaining path by which a secret shorter than SECRET_MIN_LENGTH can
  reach the middleware" — `buildInternalAuthMiddleware` has exactly one call site in `src/`
  (`app.ts:57`); the env arm is guaranteed ≥32 after trim. Universal holds.
- `app.ts:27-28` "not operator-reachable" — `src/index.ts:23` is `buildBillingServiceApp()` with
  no arguments. TRUE.
- `env.ts:8-9` "Nothing reads the parsed `env.PORT`" — the only `.PORT` read in `src/` is
  `process.env.PORT` at `index.ts:56`. TRUE.
- `env.ts:11` "the service, the compose image and the gateway all used 3004" —
  `startup.constants.ts:3`, `docker/docker-compose.yml:111` and `:114`,
  `apps/gateway/.env.example:23`. TRUE.
- `env.ts:43-45` "`app.inject` does not strip" — measured: SP- and HTAB-padded headers arrive
  **unstripped** through `app.inject` on fastify 5.10.0, unlike both real transports. TRUE, and
  it justifies AC4 asserting the schema output rather than an injected request.
- `.env.example:23-24` "The gateway proxies `/v1/billing` to the same prefix upstream, so it does
  not reach that route today" — `GATEWAY_PROXY_PREFIXES.BILLING` is `/v1/billing`
  (`apps/gateway/src/constants.ts:36`) and `proxy.plugin.ts:27` is `rewritePrefix: prefix`;
  billing's only guarded route is `/v1/internal/billing/generate`. TRUE.
- `docs/reviewer-checklist.md:30` billing → `yes (env schema, T-044)` — the column is "Fails fast
  on missing secret", and a missing secret throws `Required` at module load. TRUE. The other two
  cells correctly still cite S-8.
- Every `file:line` the diff adds was re-derived: `worker/src/app.ts:27`,
  `billing/src/app.ts:29`, `worker/src/constants.ts:39-40`, `billing/src/constants.ts:23-24`,
  `usage/src/config/env.ts:15`, `gateway/src/config/env.ts:14`, `usage/src/app.ts:27`,
  `usage/src/middleware/internal-auth.middleware.ts:37-38`,
  `billing/src/middleware/internal-auth.middleware.ts:9` and `:10`. **All exact.**
- The title-grep claim: `grep -rn "weaker than usage-service"` over `*.md`/`*.ts` excluding
  `node_modules` → exit 1, no matches. TRUE. (Historical reviews quote the *old checklist row*,
  e.g. `docs/reviews/t-037-worker-service-env-schema.md:167`; those are records of a past state
  and correctly left alone.)

**Nothing that boots today stops booting.** Every checked-in supply path, trimmed length measured:

```
 37  apps/billing-service/.env.example:30    dev-local-secret-change-in-production
 45  apps/billing-service/tests/setup.ts:12  test-internal-api-secret-change-in-production
 45  .github/workflows/ci.yml:34             ci-internal-api-secret-with-at-least-32-chars
 45  docker/docker-compose.yml:112           ci-internal-api-secret-with-at-least-32-chars
 11  apps/billing-service/tests/smoke.test.ts:18  "test-secret"  (build-option path, D2-A)
```

No untracked `apps/billing-service/.env` exists on this host. `docker-compose.yml`'s billing block
sets `PORT: "3004"` and the 45-character secret. The 11-character smoke secret goes through the
`options` arm, which bypasses the schema by design — and `pnpm test:smoke` passes, confirming
D2-A is intact.

**Scope discipline.** `git status --porcelain` lists six modified and two new files and none of
`apps/billing-service/src/middleware/internal-auth.middleware.ts`,
`apps/usage-service/src/config/env.ts`, `apps/billing-service/tests/smoke.test.ts`. No repository
file is touched — confirmed both by `git status` and by
`grep -c TimeZone apps/billing-service/src/repositories/base.repository.ts` → `0`, i.e. billing is
still one of S-19's un-pinned copies. **S-19/S-18 are correctly handed forward to T-045/T-046**,
which will filter `Invoice.periodStart`/`periodEnd` in a service that never received S-18's fix.

**Test honesty.** `buildEnvWithout` (`:31-41`) **throws** when the key is already absent, which is
the required shape. `expectIssueOn` (`:43-54`) looks like a short-circuit but is not: the early
`return` is preceded by `expect(parsed.success).toBe(false)`, which throws first, so the `if` is a
TypeScript narrowing device that is unreachable at runtime on the failing path — I confirmed it
reports failures rather than swallowing them in every mutation run above. It also asserts
`issue.path[0] === fieldName`, so a failure on a *different* field cannot satisfy it. AC8 (`:240`)
and AC9 (`:292`) each assert their fixture differs from the parsed secret before relying on the
difference, so neither can pass vacuously. No test asserts a mock's own return value; there are no
mocks. No skips, no conditional returns on a bug-present condition.

**Compile-time gate, all forced, 0 cached on every task:**

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` |
| lint | `pnpm lint --force` | `13 successful, 13 total` · `0 cached` · 0 errors, **14 warnings** |
| build | `npx turbo run build --force` | `13 successful, 13 total` · `0 cached` |
| test | `pnpm test --force` | `13 successful, 13 total` · `0 cached` |
| smoke | `pnpm test:smoke` | 6 suites, 7 tests, all passed |

Per-package test totals: billing **5 files / 34 tests** (baseline 4 / 18 — the reported count is
exact), usage 19 / 230, auth 15 / 164, worker 12 / 180, gateway 8 / 38, analytics 4 / 18,
shared-utils 1 / 18, shared-validation 1 / 15, shared-types 1 / 8, shared-config 1 / 4,
shared-logger 1 / 4, shared-tracing 1 / 2. All passing.

**The 14 warnings are pre-existing — proved, not asserted:**

| Count | File | `git log -1` | In this diff? |
|---|---|---|---|
| 10 `no-misused-promises` | `apps/auth-service/tests/auth.service.unit.test.ts` | `d68e719` (2026-08-25) | no |
| 4 `no-unsafe-assignment` | `apps/usage-service/tests/ingestion.service.unit.test.ts` | `b0f6921` (2026-08-31) | no |

Both files are absent from `git status --porcelain`. Zero `no-unsafe-return`. No new warning was
introduced by this change, and none of the 14 is counted against it.

**Environment left as found, with one honest exception.** The ingest stream is untouched:
`XLEN telemetry:events` was 2 before and 2 after, `XINFO GROUPS` empty throughout, and
`XINFO STREAM` reports `length 2` at the end. Nothing was destroyed and I issued no write.

Redis db 0's `DBSIZE` did move, 3 → 2, and I am reporting it rather than rounding it to green.
The two pre-existing TTL'd `denylist:*` keys expired during the review, and the mandated
`pnpm test --force` run wrote a new one — `denylist:1b0e0ff60befa11140b1f9030b7e0515`, `TTL 498`
at the time of writing. **That is S-22 reproducing itself:** auth-service's suite hard-codes
`redis://localhost:6379` (`apps/auth-service/tests/auth.integration.test.ts:34`), which resolves
to db 0, so the full-workspace test gate cannot be run without writing there. It self-expires and
nothing in this change caused or worsened it — but it does mean "do not write to Redis db 0" and
"run `pnpm test --force`" are not both satisfiable on this repository today, which is worth
knowing before the next gate. No new gap entry needed; S-22 already says exactly this.

Postgres before and after:
`Event` 0, `UsageLine` 0, `Tenant` 2, `User` 2 (the `Tenant`/`User` rows are S-20's known leak).
Working tree restored byte-identically: the final `git diff --stat` is character-for-character the
one captured before any probe (`6 files changed, 118 insertions(+), 22 deletions(-)`), and after
one mis-restore of `constants.ts` during the redness experiment the reconstruction was proved
exact by git's own content hash (`index ed31d05..373d7b9`, matching the pre-probe post-image).

---

### What I could not verify, and why

- **Header handling by any client or proxy other than undici 7.29.0 and a raw `net.Socket`, or
  any server other than fastify 5.10.0 on this host.** nginx, Envoy and cloud load balancers are
  untested. Both comments scope themselves correctly ("Nothing was measured about other clients
  or proxies") and I am not asking for more; noting it as a real residual behind R1.
- **That a built billing container starts with the new required variable.** I verified
  `docker/docker-compose.yml:112` declares a 45-character secret and that `PORT: "3004"` matches
  the new default, but did not build or run the image.
- **An operator's untracked local `.env`.** This is the one supply path that can still carry a
  sub-32 secret and it is outside the repository. It is why the `.env.example` comment is part of
  this change; nothing more can be done from here.
- **Coverage thresholds.** `vitest run` was used throughout; billing's 80/80/80/75 thresholds in
  `vitest.config.mjs` were not exercised. Not part of the stated gate.
- **`pnpm format:check`** — not run, per S-12.
- **The claim that S-8's remaining items 1 and 3 are unchanged in behaviour.** I read both
  middleware files and confirmed they are textually untouched, but I did not measure timing
  leakage or hook ordering; that is S-8's own work.
- Turbo reports 13 tasks for each gate; 12 packages emitted vitest output, so one workspace
  package's `test` task produces none. Pre-existing and not investigated.

---

### Decisions for the user

**Decision 1 — how to correct the S-8 heading (M-1a).** Required either way; this chooses wording.

- **A (recommended)** — `## S-8 · internal-auth guards and secret schemas still diverge — **MEDIUM, open**`.
  Drops the count entirely, so it cannot go stale again as services are fixed one at a time.
- **B** — `## S-8 · three internal-auth guards, four secret schemas, still diverging`. More
  informative today; needs editing again when S-9 adds analytics' guard.
- **C** — revert to a billing/worker-shaped title. Rejected: that is the assertion the retitle
  correctly removed, since item 2 no longer applies to either.

**Recommendation: A** — the entry's body already carries the precise counts with `file:line`, so
the heading does not need to. All three options change only `.claude/rules/known-gaps.md:39`; none
touches code or tests.

**Decision 2 — adopt `HTTP_STATUS_UNAUTHORIZED` in billing's middleware now, or leave it to S-8
(L-3)?** *This one changes the diff.*

- **A (recommended)** — leave it. `internal-auth.middleware.ts` stays on the do-not-touch list,
  matching T-037's worker precedent exactly and keeping the commit to one task. The duplicate
  `401` stays for one more task and `known-gaps.md:96-99` already names it.
- **B** — change `reply.status(401)` to `reply.status(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED)`
  at `apps/billing-service/src/middleware/internal-auth.middleware.ts:10`. One behaviour-neutral
  line that closes the DRY finding now; but it opens the file the plan's §5 lists as untouched,
  and leaves worker's identical literal unaddressed, so the services diverge in a *new* way until
  S-8 lands.

**Recommendation: A.** The value of B is real but small, and asymmetric divergence between billing
and worker is precisely the class of drift S-19 and S-14 exist to record. If you take B, worker
should get the same line in the same commit — which makes it a two-service change inside a billing
task, i.e. the thing S-8 has twice declined.

---

### Required for CONDITIONAL → approval

1. `.claude/rules/known-gaps.md:39` — retitle per Decision 1 (M-1a).
2. `.claude/rules/known-gaps.md:44`, `:47-48`, `:88` — add gateway to the item-2 summary and
   narrow "all four services end up identical" to "all four declarations" (M-1b).
3. `apps/billing-service/src/config/env.ts:41` — drop or qualify "intact" (L-1).
4. Optionally, `.claude/rules/known-gaps.md:67-68` — reword the "non-empty" characterization
   (L-2), and `.env.example:23` (NIT-2).

None of these requires re-running the gate: items 1, 2 and 4 touch markdown only, and item 3 is a
comment. A re-run of `pnpm --filter @telemetry/billing-service lint typecheck` after item 3 is
sufficient.

---

### Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| An operator with an untracked `.env` carrying a sub-32 or NBSP-padded secret sees billing stop starting, or start and 401 every gateway call. | **Accept.** Fails closed and loudly, documented at `.env.example:20-29`. This is the intended consequence of closing S-8 item 2. |
| usage-service and gateway keep the untrimmed `.min()`; billing and worker trim. Four declarations, two strictnesses. | **Accept, recorded.** Correctly scoped out by D1-A and now carried in S-8 with measured numbers. Fails closed in every direction I traced: a padded configured secret on the untrimmed side never matches a wire-stripped inbound header. |
| billing's `base.repository.ts` has no `TimeZone` pin (S-19) and T-045/T-046 will filter `Invoice.periodStart`/`periodEnd`. | **Handed forward, correctly.** T-044 touches no repository and binds no timestamp. Already recorded in S-19; the plan names it at §3. No new gap entry needed. |
| S-8 items 1 and 3 remain open for billing and worker — timing-unsafe `!==`, `preHandler` rather than `onRequest`, un-`return`ed `reply.send`. | **Unchanged and correctly out of scope.** Still accurately described in the entry. |
| The `internalApiSecret` build option remains unvalidated (D2-A). | **Accept.** Not operator-reachable, now pinned by `tests/env.schema.unit.test.ts:289-315` with an explicit comment saying it is the one remaining short-secret path. |

**No new `known-gaps.md` entry is recommended.** Every gap this change surfaced — the untrimmed
usage/gateway schemas, the misleading usage-service comment, the duplicate `401`, billing's
missing `TimeZone` pin — already has a home in S-8 or S-19, and the diff files each of them there.
That accounting is the strongest part of this change.

---

## Round 2 — final

Gate 6 (post-QA) on the uncommitted working tree, base `961d222`. Read-only; nothing in this
section was applied. Every `file:line` below was re-derived in this round — the tree moved
between rounds and two Round-1 anchors went stale (L-1 below).

**Verdict: CONDITIONAL.** One HIGH and one MEDIUM, both *claims* rather than behaviour. The
shipped `apps/billing-service/src/**` diff is unchanged from the revision QA passed on substance
and I re-confirmed it by execution; the Q-1 remediation is a genuine improvement on what it
replaced. What blocks is a false mechanism in `.claude/rules/known-gaps.md` and a universal in
the new test's own title that a one-line mutation refutes.

---

### Findings

#### H-1 · HIGH — the ZWSP addendum's mechanism sentence is false, in an authoritative file

`.claude/rules/known-gaps.md:108-109`:

> `String.prototype.trim` strips Unicode `White_Space` (`Zs` and friends); it
> does **not** strip format characters (`Cf`).

Both halves are wrong as stated. Measured on node v22.22.2 (`/\p{Cf}/u`, `/\p{Zs}/u`,
`/\p{White_Space}/u`, and `.repeat(3).trim().length === 0`), then re-checked against billing's
**real** schema field (`EnvSchema.shape.INTERNAL_API_SECRET.safeParse`, zod 3.25.76):

| Char | `Cf` | `Zs` | `White_Space` | `trim()` removes | billing schema, 32 of them |
|---|---|---|---|---|---|
| U+200B ZWSP | **yes** | no | no | **no** | **ACCEPT**, len 32 |
| U+2060 word joiner | **yes** | no | no | **no** | **ACCEPT**, len 32 |
| U+180E | **yes** | no | no | **no** | **ACCEPT**, len 32 |
| **U+FEFF ZWNBSP** | **yes** | no | **no** | **YES** | **REJECT** — `String must contain at least 32 character(s)` |
| U+00A0 NBSP | no | yes | yes | yes | REJECT |
| U+0020, U+3000 | no | yes | yes | yes | REJECT |

U+FEFF is a `Cf` character that `trim()` **does** strip, which refutes "it does not strip `Cf`"
directly. And U+FEFF is **not** in Unicode `White_Space` (removed in Unicode 4.0.1) yet is still
trimmed, which refutes "strips Unicode `White_Space`". The real rule is the *ECMAScript*
`WhiteSpace` + `LineTerminator` set: every `Zs`, plus TAB/VT/FF/CR/LF/LS/PS, **plus U+FEFF** —
and nothing else. This is the "probes that varied one dimension" pattern from
`review-standards.md`: U+200B was tested, the one `Cf` character that would have refuted the
generalisation was not.

The load-bearing conclusion is **TRUE** and I reproduced it on both services: 32 × U+200B is
accepted by billing (`.trim().min(32)`, len 32) and by worker (full `EnvSchema.safeParse`, len 32
— worker's schema is a `ZodEffects` with no `.shape`, so it has to be parsed whole). "The guard
`.trim()` adds is 'not made of spaces', not 'not made of invisible characters'" stands, as does
"worker-service has the identical form and the identical gap".

**Why HIGH.** `.claude/rules/` is designated authoritative and other agents are instructed not to
re-verify it. The concrete cost is not hypothetical: whoever closes S-8 items 1-3 is told by this
entry to "decide the normalisation once", and a normaliser written from "strip `Cf`" would strip
U+FEFF (already handled), keep U+00A0 (already handled), and is built on a character class that
does not describe what `trim()` does.

**Concrete fix**, `.claude/rules/known-gaps.md:108-109` — replace the two sentences with:

> `String.prototype.trim` strips the *ECMAScript* `WhiteSpace` + `LineTerminator` set — every
> `Zs`, plus TAB/VT/FF/CR/LF/LS/PS and U+FEFF — which is neither Unicode's `White_Space`
> property (that excludes U+FEFF) nor "all whitespace-looking characters". Measured on
> node v22.22.2 against billing's real schema field: 32 × U+00A0, 32 × U+FEFF and 32 spaces are
> all **rejected**; 32 × U+200B, 32 × U+2060 and 32 × U+180E — all `Cf`, none in
> `White_Space` — are all **accepted** at length 32.

#### M-1 · MEDIUM — `pins DEFAULT_PORT to the port every deploy artifact publishes` does not pin every one

`apps/billing-service/tests/env.schema.unit.test.ts:151` (title) and `:141` ("Four sites, chosen
rather than defaulted").

`apps/gateway/.env.example:23` is `BILLING_SERVICE_URL=http://localhost:3004`. It is not in the
locator set. **Refuting mutation, run:** set it to `:9999` →
`pnpm --filter @telemetry/billing-service exec vitest run tests/env.schema.unit.test.ts` →
`Tests 17 passed (17)`, and `pnpm --filter @telemetry/gateway exec vitest run` →
`Tests 38 passed (38)`. Nothing in the repository notices. (`grep -rn BILLING_SERVICE_URL` over
`apps`/`packages` `*.ts` confirms: gateway's three test fixtures hard-code
`http://billing-service:3002` / `http://127.0.0.1:4103` and assert nothing about the real port.)

This is the *same* coupling the comment at `:146-150` argues for including compose's
`BILLING_SERVICE_URL` on — "one service's view of another … move billing's port, redeploy, and
every proxied `/v1/billing` request 502s". Gateway's `.env.example` is the local-development
instance of exactly that, and billing's own `.env.example` is already in the set, so "example
files don't count" is not available as a distinction.

**Ruling on the question asked.** Including compose's `BILLING_SERVICE_URL` is **right** — keep
it. The failure class is identical and silent, and the file is already parsed. But taking that
argument means `apps/gateway/.env.example:23` belongs in the set too; the current set is the
argument applied to one of the two files that carry it.

**Concrete fix (preferred)** — add a fifth locator at
`apps/billing-service/tests/env.schema.unit.test.ts:172`:

```ts
const GATEWAY_ENV_EXAMPLE_URL = new URL("../../gateway/.env.example", import.meta.url);
// …
const [, gatewayEnvExamplePort] = extractSoleMatch(
  readFileSync(GATEWAY_ENV_EXAMPLE_URL, "utf8"),
  /^BILLING_SERVICE_URL=http:\/\/localhost:(\d+)$/gm,
  "BILLING_SERVICE_URL in apps/gateway/.env.example"
);
expect(gatewayEnvExamplePort).toBe(expectedPort);
```

**Alternative fix** — leave the set at four and retitle to
`pins DEFAULT_PORT to the ports the compose stack and .env.example publish`, dropping the
universal. See Decision 1.

#### L-1 · LOW — `known-gaps.md:138` cites `apps/billing-service/src/constants.ts:23-24`; the constants are at `:25-26`

Re-derived: `grep -n "HTTP_STATUS_OK\|HTTP_STATUS_UNAUTHORIZED" apps/billing-service/src/constants.ts`
→ `25:  HTTP_STATUS_OK: 200` / `26:  HTTP_STATUS_UNAUTHORIZED: 401`. Lines 23-24 are the third and
fourth lines of the comment block that describes them. The paired worker citation at `:137`
(`apps/worker-service/src/constants.ts:39-40`) **is** exact — verified the same way.

This anchor was exact at Round 1 and went stale when the `constants.ts` comment block grew by two
lines during the Round-1 remediation. It is the mechanical failure mode the whole task is about,
one level up.

**Concrete fix.** `.claude/rules/known-gaps.md:138` — `constants.ts:23-24` → `constants.ts:25-26`.

#### L-2 · LOW — `config/env.ts:41-42` reports a raw-socket byte form that is a property of the probe, not of the transport

`apps/billing-service/src/config/env.ts:41-42`:

> an inbound header padded with U+00A0 survived undici byte-identical — over a raw `net.Socket`
> it arrived as U+00C2 U+00A0

Round 1 measured `U+00C2 U+00A0`; QA measured `U+00A0` and said it could not resolve which probe
models a real client. **Settled by measurement this round** — fastify 5.10.0, one server, one
header value, the only variable being how the probe writes the request bytes:

```
raw socket write=utf8    arrived cp: 00c2 00a0 …  len=51  matchesTrimmedCore=false
raw socket write=latin1  arrived cp: 00a0 0074 …  len=49  matchesTrimmedCore=false
undici                   arrived cp: 00a0 0074 …  len=49  matchesTrimmedCore=false
undici SP-padded         len=47                          matchesTrimmedCore=true
```

Both earlier results are correct; they differ only in the probe's write encoding, which is not a
property of any client billing will actually face. The load-bearing conclusion
(`matchesTrimmedCore=false` → 401, never silent acceptance) holds under **all three**, and SP
stripping reproduces. So this is precision in a security-relevant comment, not correctness.

**Concrete fix.** `env.ts:41-42` — replace `over a raw \`net.Socket\` it arrived as U+00C2 U+00A0`
with `over a raw \`net.Socket\` the arrival form depends on how the probe encodes the request
bytes (UTF-8 write → U+00C2 U+00A0, latin-1 write → U+00A0); in every form measured it did not
equal the trimmed configured secret`.

#### NIT-1 — `.env.example:23` still carries Round 1's NIT-2 wording

`apps/billing-service/.env.example:22-23` still reads `Guards billing's internal route group --
POST /v1/internal/billing/generate today -- against in-cluster callers and the published 3004
port mapping`. Round 1 marked this optional and QA recorded it as Q-3. Still unapplied.
Disposition below.

#### NIT-2 — the addendum is wedged between a colon and the table it introduces

`.claude/rules/known-gaps.md:104-105` ends `…measured against billing's real schema at Gate 3 of
T-044 by mutating the declaration and re-running \`apps/billing-service/tests/env.schema.unit.test.ts\`:`
— and the table that colon introduces is at `:123-127`, with the 15-line ZWSP addendum
(`:107-121`) in between. A reader follows the colon into the addendum. Move the addendum below
the table's trailing note at `:129-131`.

---

### The rulings asked for

#### 1. Is the new guard stronger than the one I removed? **Yes, strictly. Nothing the old assertion caught is now uncovered.**

Measured, four mutations, tree restored and md5-verified after each:

| Mutation | Result |
|---|---|
| `startup.constants.ts:3` → `9999` | `Tests 1 failed \| 34 passed (35)` — **only** `pins DEFAULT_PORT to the port every deploy artifact publishes`, failing at `:178` with `expected '3004' to be '9999'`. `defaults PORT to the port index.ts binds` stayed **green**. |
| `.env.example` `PORT=` renamed (locator matches **0**) | red, `Expected exactly one PORT= line in apps/billing-service/.env.example; found 0. The artifact moved or was reformatted -- fix the locator, do not delete the assertion.` |
| duplicate `PORT: "3004"` in billing's compose block (locator matches **2**) | red, same helper, `… found 2` |
| compose `BILLING_SERVICE_URL` → `:9999` | red, `expected '9999' to be '3004'` |

So: the old assertion is confirmed **inert** from the other side (it stayed green while the
service bound 9999), the new one is confirmed **live**, and both loudness directions of the
regex helper throw with a named message rather than passing on an empty match set. The
compose-scoping rationale at `:93-94` also checks out — `grep -c 'PORT: "' docker/docker-compose.yml`
→ **6**, so an unscoped search would hit `extractSoleMatch`'s `found 6` throw.

What the old assertion caught was "two independent literals disagree". With the derivation in
place that state is only reachable by re-literalising `BILLING_RUNTIME.DEFAULT_PORT`, and the
surviving assertion at `:133` still catches it **when the value differs** — measured: literal
`3000` with the now-unused import removed → `expected 3000 to be 3004`, 1 failed | 16 passed. A
re-literalised `3004` passes, exactly as the shipped comment at `:116-123` says. I checked the
implementer's own correction of itself and it is right: `pnpm --filter @telemetry/billing-service
typecheck` is **clean** under a re-literalised `3004`, so "a type error rather than a test
failure" would indeed have been false. One thing the comment does not claim and could: the naive
form of that mutation *is* caught, by **lint** rather than by the type system —
`@typescript-eslint/no-unused-vars` errors on the orphaned `BILLING_SERVICE_STARTUP` import
(`1 problem (1 error, 0 warnings)`). Only a mutation that also deletes the import gets through.

**Net: positive.** The old guard coupled two in-process constants; the new one couples the
constant to the artifacts a deploy actually reads, which no revision of this repository has ever
checked. Residual: the fifth artifact in M-1.

#### 2. Release readiness, and what the new hard requirement means for an operator

**Acceptance criteria.** All eleven AC rows in the plan are covered by a case that goes red under
mutation; QA proved eight by mutation and I re-proved AC6, AC7 and AC7b independently. AC6
re-derived at module load under `tsx`, five inputs, this round:

```
(unset)     REFUSED: Invalid environment configuration for INTERNAL_API_SECRET: Required
5 chars     REFUSED: … String must contain at least 32 character(s)
33 spaces   REFUSED: … String must contain at least 32 character(s)
31 chars    REFUSED: … String must contain at least 32 character(s)
32 chars    BOOT OK len=32
```

**Breaking change for operators — real, narrow, fails closed and loudly.** A missing or sub-32
`INTERNAL_API_SECRET` now aborts at module load, before the DI container exists, naming the
field. Every checked-in supply path already satisfies it: compose `:93,:112,:149,:172` (45),
`.github/workflows/ci.yml:34` (45), `apps/billing-service/.env.example:30` (37),
`apps/billing-service/tests/setup.ts:12` (45). The only sub-32 values are two test build-option
overrides (`tests/smoke.test.ts:18`, 11 chars; `tests/env.schema.unit.test.ts:401`, 24 chars),
both through the unvalidated `options` arm by decision D2-A.

The live residual is the untracked repo-root `./.env`, which carries a **16-character**
`INTERNAL_API_SECRET`. **I closed QA's open question about it:** `process.loadEnvFile()` does
**not** override an already-set variable — measured on node v22.22.2, `FOO=from_shell` +
`.env` containing `FOO=from_file` → `from_shell`; unset → `from_file`. So that file bites only
when billing is started from the repo root *and* nothing exported the variable. It is already
fatal for usage-service and gateway (`.min(32)`) and worker (`.trim().min(32)`), so billing is
joining three services, not breaking new ground.

**Operator guidance the change should be read as giving:** anyone whose environment sets a short
secret today gets a start-up abort naming `INTERNAL_API_SECRET`, not a degraded service — and
before T-044 that same environment ran billing with an *unenforced* secret that authenticated
callers (`INTERNAL_API_SECRET=short` returned `200` on `961d222`, reproduced at Round 1). The
remediation is to lengthen the secret to ≥32 characters **on every service at once**, because the
gateway signs proxied requests with its own copy; a 16→45 change on billing alone makes billing
401 every gateway call. That coupling is not stated anywhere in the diff and would be worth one
line in `.env.example`. Not a blocker.

**Regressions across the other 12 packages: none.** Nothing imports `@telemetry/billing-service`
(the only cross-package references are the `test:smoke` runner strings in the root
`package.json`). `docs/reviewer-checklist.md:30` and `.claude/rules/known-gaps.md` are the only
files touched outside `apps/billing-service`, both prose. All 13 packages green on all four
forced gates plus smoke, below.

#### 3. Coverage and test honesty — can any of the 17 new cases pass while measuring nothing?

17 cases, all in `tests/env.schema.unit.test.ts` (billing 4 files / 18 tests → **5 / 35**; the
`+17` in the brief is exact). The counts in the trail are consistent once read in order:
`docs/plans/…:356` records `5 files / 34 tests` at the Gate-3 checkpoint and `:368` updates it to
`5 files / 35 tests` after the Gate-5 case was added; Round 1 above reports 34 because that is
what the revision it reviewed had. Nothing stale — checked because a drifting count is exactly
what this task is about.

- **The regex case is the obvious candidate and it is not vacuous** — three independent
  mutations turn it red (table above), and `extractSoleMatch` throws on both `0` and `2`
  matches with a named message. `extractComposeServiceBlock` throws on a missing service key.
  The `soleMatch === undefined` branch at `:82` is a `noUncheckedIndexedAccess` narrowing device,
  not a second condition — `tsconfig.base.json:8` confirms the flag is on.
- **One assertion inside one case is currently inert, and says so.** `:133`
  (`expect(BILLING_RUNTIME.DEFAULT_PORT).toBe(BILLING_SERVICE_STARTUP.DEFAULT_PORT)`) cannot fail
  while the derivation stands. The comment at `:116-123` states this, names the mutation that
  established it, and correctly scopes when it regains teeth. The case's *other* assertion
  (`:130`) is live. Honest, and the right way to leave it.
- `buildEnvWithout` throws on a drifted fixture; `expectIssueOn` asserts failure **before** its
  narrowing `return` and pins `issue.path[0]`; AC8 and AC9 each assert their fixture differs from
  the parsed secret before relying on the difference; no mocks anywhere, no skips, no conditional
  return on a bug-present condition. Re-read this round, unchanged from Round 1's assessment.
- **No short-circuit of the S-3 shape.** Nothing in the file returns or skips on a condition that
  is true exactly when the bug is present.

#### 4. Dispositions

| Item | Disposition |
|---|---|
| **S-8 item 1** (`!==`, not timing-safe) — billing + worker | **Open, correctly untouched.** `apps/billing-service/src/middleware/internal-auth.middleware.ts:9` is byte-unchanged. I did not measure timing leakage; that is S-8's own work. |
| **S-8 item 2** | **Closed for billing**, re-proved at module load this round. Remaining half (usage `:15`, gateway `:14`, both untrimmed `.min(32)`) accurately described. |
| **S-8 item 3** (`preHandler`, un-`return`ed `reply.send`, literal `401`) | **Open, correctly untouched.** Round-1 Decision 2 = A was taken; `internal-auth.middleware.ts:10` still writes `401` while `constants.ts:26` defines `HTTP_STATUS_UNAUTHORIZED`. Both new constants are used (`tests/env.schema.unit.test.ts:363`, `:375`, `:414`, `:422`), so neither is dead. Accept — matches worker's T-037 precedent exactly. |
| **ZWSP addendum** | **Keep the addendum; fix its mechanism sentence (H-1).** Filing it under S-8 rather than as a new id is right — it is a property of the declaration S-8 is about, and worker shares it. Severity LOW and "fails closed" are both sound: the caller must reproduce the invisible bytes, so the failure mode is a service that refuses everyone. |
| **Round 1 M-1(a)** heading | **Applied and correct.** `known-gaps.md:39` now states both numbers; re-derived — 3 guards (`ls apps/*/src/middleware/internal-auth.middleware.ts`), 4 schemas (`grep -ln INTERNAL_API_SECRET apps/*/src/config/env.ts`). Note it will need editing again when S-9 gives analytics a guard; that was option B's known cost. |
| **Round 1 M-1(b)** — Q-2 | **Both missed sites now fixed, verified.** `:62-63` reads `usage-service's **and gateway's** untrimmed \`.min()\``; `:99-101` reads `so all **four secret schemas** declare the field identically. Note that is *schemas*, not services`, and the entry now explains *why* gateway is in one count and not the other. |
| **Round 1 L-1** | **Applied, and it introduced L-2.** Qualification is right; the byte-level detail it added is probe-dependent. |
| **Round 1 L-2** | **Applied and correct.** `known-gaps.md` now says the usage-service comment "is not false on its own words — it is misleading". |
| **Round 1 L-3** (duplicate `401`) | **Accept, unchanged.** Decision 2 = A. |
| **Round 1 NIT-1** | **Superseded by the Q-1 remediation**, which is strictly better than either the duplication or the naive collapse. |
| **Round 1 NIT-2 / QA Q-3** | **Still open** (NIT-1 above). Cosmetic; take it or close it explicitly rather than letting it ride to a third gate. |
| **S-19** — billing's `base.repository.ts` has no `TimeZone` pin | **Handed forward to T-045/T-046, unchanged.** `grep -c TimeZone apps/billing-service/src/repositories/base.repository.ts` → `0`. T-044 touches no repository. |
| **S-22** — `pnpm test --force` writes to Redis db 0 | **Reproduced, reported, not caused by this change.** Details below. |
| **New `known-gaps.md` entry** | **None recommended.** Everything this round surfaced belongs to S-8 (H-1, the ZWSP mechanism) or is a fix inside this diff (M-1, L-1, L-2). |

#### 5. Scope discipline — verified, unchanged

`git diff --name-only HEAD` is six files: `.claude/rules/known-gaps.md`,
`apps/billing-service/{.env.example,src/app.ts,src/config/env.ts,src/constants.ts}`,
`docs/reviewer-checklist.md`; plus four untracked (`tests/env.schema.unit.test.ts` and the three
`docs/` artifacts). Checked individually and **unchanged**:
`apps/billing-service/src/middleware/internal-auth.middleware.ts`,
`apps/usage-service/src/config/env.ts`, `apps/billing-service/tests/smoke.test.ts`,
`apps/billing-service/src/startup.constants.ts`, `apps/worker-service/src/config/env.ts`,
`apps/gateway/src/config/env.ts`. The new `HTTP_STATUS_*` constants are deliberately not adopted
by the middleware — correct, and recorded in both `constants.ts:21-24` and S-8.

---

### Compile-time gate — my own forced run, all four tasks, `0 cached`

`pnpm build -- --force` does not forward the flag, so `npx turbo run <task> --force` was used.
Every task line reads `cache bypass, force executing`.

| Task | Command | Result |
|---|---|---|
| typecheck | `npx turbo run typecheck --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` · exit 0 |
| lint | `npx turbo run lint --force` | `13 successful, 13 total` · `0 cached` · **0 errors, 14 warnings** · exit 0 |
| build | `npx turbo run build --force` | `13 successful, 13 total` · `0 cached` · exit 0 |
| test | `npx turbo run test --force` | `13 successful, 13 total` · `0 cached` · exit 0 |
| smoke | `pnpm test:smoke` | 6 suites, 7 tests, all passed · exit 0 |

Per-package tests: billing **5 / 35**, usage 19 / 230, auth 15 / 164, worker 12 / 180,
gateway 8 / 38, analytics 4 / 18, shared-utils 1 / 18, shared-validation 1 / 15,
shared-types 1 / 8, shared-config 1 / 4, shared-logger 1 / 4, shared-tracing 1 / 2, web (no test
files). 13/13 packages, all passing.

**14 warnings, all pre-existing — proved, not asserted. Zero `no-unsafe-return`**
(`grep -c no-unsafe-return` on the lint log → `0`):

| Count | Rule | File | `git log -1` | In `git diff --name-only HEAD`? |
|---|---|---|---|---|
| 10 | `@typescript-eslint/no-misused-promises` | `apps/auth-service/tests/auth.service.unit.test.ts` | `d68e719` 2026-08-25 | no |
| 4 | `@typescript-eslint/no-unsafe-assignment` | `apps/usage-service/tests/ingestion.service.unit.test.ts` | `b0f6921` 2026-08-31 | no |

Matches the expectation in the brief exactly. No new warning introduced; none of the 14 counted
against this change.

---

### What I verified by execution this round

- The four port-guard mutations and the two locator-loudness directions (table under Ruling 1),
  each with the tree restored and md5-verified.
- The re-literalisation pair: `3004` → 17/17 green and `typecheck` clean; `3000` with the import
  removed → `expected 3000 to be 3004`. Lint catches the import-left form.
- `apps/gateway/.env.example:23` → `9999`: billing 17/17 green, gateway 38/38 green (M-1).
- The ZWSP/`Cf` matrix on node v22.22.2 plus billing's and worker's real schemas (H-1).
- The NBSP wire behaviour on fastify 5.10.0 across three transports and two write encodings (L-2).
- Module-load refusal for unset / 5 / 33-space / 31 / 32-character secrets under `tsx`.
- `process.loadEnvFile()` does not override an already-set variable (closes a QA open question).
- Every `file:line` the diff adds or cites, re-derived: `known-gaps.md`'s guard/schema counts,
  `apps/usage-service/src/config/env.ts:15`, `apps/gateway/src/config/env.ts:14`,
  `apps/worker-service/src/config/env.ts:33`, `apps/billing-service/src/config/env.ts:48`,
  `apps/worker-service/src/app.ts:27`, `apps/billing-service/src/app.ts:29`,
  `apps/usage-service/src/app.ts:27`,
  `apps/usage-service/src/middleware/internal-auth.middleware.ts:37-38`,
  `apps/billing-service/src/middleware/internal-auth.middleware.ts:9` and `:10`,
  `apps/worker-service/src/constants.ts:39-40`, `docs/reviewer-checklist.md:28` and `:30`,
  `docker/docker-compose.yml:111`, `:112`, `:114`, `:175`, `apps/billing-service/.env.example:6`.
  **All exact except `apps/billing-service/src/constants.ts:23-24`** → L-1. (The `:113` anchor
  mentioned in the Gate-6 handoff does not appear in any committed artifact —
  `grep -rn "compose.yml:113" docs/` returns nothing; Round 1 as written says `:111` and `:114`,
  which are correct. Nothing to fix there.)
- Scope discipline, by per-file `git diff --name-only` membership.

### What I could not verify, and why

- **Docker Compose was not brought up.** The `3004:3004` mapping, the 45-character compose
  secret and the container's `tsx` entrypoint were read statically. This is the one path where
  M-1's uncovered artifact and the port-mapping guard would actually manifest. Same limit QA hit.
- **The test comment at `:143-145`** ("the container still starts, the health check still passes
  inside, and nothing on the host can reach it") is **reasoning, not measurement** — it follows
  from how compose publishes ports, but I did not boot the stack to see it. Reported as such
  rather than endorsed.
- **Timing-leak behaviour of S-8 item 1** — read, not measured.
- **Any client or proxy other than undici 7.29.0 and a raw `net.Socket`, any server other than
  fastify 5.10.0 on this host.** nginx, Envoy, cloud LBs untested. Both comments scope themselves
  correctly.
- **An operator's own untracked `.env` other than the repo-root one on this host.** Outside the
  repository; `.env.example` is the only lever the change has.
- **Coverage thresholds** — `vitest run` throughout; billing's 80/80/80/75 not exercised. Not
  part of the stated gate.
- **`pnpm format:check`** — not run, per S-12.
- Turbo reports 13 tasks per gate; 12 packages emit vitest output (`web` has no test files).
  Pre-existing, not investigated.

### Environment

**Postgres:** `Event` 0, `UsageLine` 0, `Invoice` 0 before and after; `Tenant` 2, `User` 2 (S-20
residue, unchanged). **Redis stream untouched:** `XLEN telemetry:events` 2 → **2**,
`entries-added` 2 → **2**, `groups` 0 → **0**, `last-generated-id` `1788171536033-0` → unchanged.

`DBSIZE` moved 4 → 5. **That is S-22, reported rather than rounded to green:** the mandated
`turbo run test --force` runs auth-service's integration suite, which hard-codes
`redis://localhost:6379` (`apps/auth-service/tests/auth.integration.test.ts:34`) with no logical
database, so it wrote one TTL'd `denylist:*` key to db 0. It self-expires; no `FLUSHDB` was
issued; nothing was destroyed. "Do not write to Redis db 0" and "run the full forced gate" remain
jointly unsatisfiable on this repository, exactly as S-22 records. Both services left running.

**Working tree restored byte-identical.** `git ls-files -co --exclude-standard | xargs md5sum`
over 456 files is identical before and after all probes, and `git status --porcelain` matches
character-for-character (6 modified, 4 untracked). `git diff --stat HEAD` is unchanged at
`6 files changed, 161 insertions(+), 23 deletions(-)`. Nothing staged, nothing committed.

---

### Decisions for the user

**Decision 1 — M-1: how to close the "every deploy artifact" gap.** *A changes the diff; B is a
one-line rename; C changes nothing.*

- **A (recommended)** — add the fifth locator for `apps/gateway/.env.example:23`. Makes the title
  true, and applies the implementer's own stated reason (`:146-150`) consistently to both files
  that carry billing's port. Cost: ~8 lines in one test file, plus a billing-scoped re-run.
- **B** — keep four locators and retitle to drop the universal, e.g.
  `pins DEFAULT_PORT to the ports the compose stack and .env.example publish`, and adjust the
  `:141` comment to say which artifact is deliberately out. Honest, cheaper, leaves a real
  artifact able to drift silently.
- **C** — accept as-is and record the gateway `.env.example` coupling in `known-gaps.md`.
  Rejected as the default: the whole point of this remediation was that an inert guard is worse
  than an absent one, and a title claiming "every" is the same class of error one level up.

**Recommendation: A.** It is the option that makes the artifact set match the argument already
written down for it, and the mutation that refutes the current title takes one `sed`.

**Decision 2 — NIT-1 / QA Q-3: the `.env.example:23` wording.** *Comment-only either way; neither
changes behaviour.*

- **A (recommended)** — apply Round 1's suggested wording now, so it stops being carried forward:
  `against callers that did not come through the gateway — reachable in-cluster and through the
  published 3004 port mapping`.
- **B** — close it explicitly as "won't fix" so it does not reappear at a fourth gate.

**Recommendation: A.** One line, and it removes the reading that the guard exists to block
in-cluster callers as a category.

---

### Required for CONDITIONAL → approval

1. `.claude/rules/known-gaps.md:108-109` — replace the `White_Space`/`Cf` mechanism with the
   measured form (H-1). **Required.**
2. `apps/billing-service/tests/env.schema.unit.test.ts:151` (and `:141`) — Decision 1, A or B.
   **Required** (one of the two).
3. `.claude/rules/known-gaps.md:138` — `constants.ts:23-24` → `:25-26` (L-1). **Required.**
4. `apps/billing-service/src/config/env.ts:41-42` — qualify the raw-socket byte form (L-2).
   **Required.**
5. `apps/billing-service/.env.example:22-23` (NIT-1) and `.claude/rules/known-gaps.md:107-121`
   ordering (NIT-2) — optional; Decision 2.

Items 1, 3 and 5-partial are markdown only. Item 4 is a comment. Item 2 under option B is a test
title; under option A it is a test edit needing
`pnpm --filter @telemetry/billing-service lint typecheck test` (~40 s). **No full 13-package
re-gate is required** for any of them: none touches `src/config/env.ts`'s or `src/app.ts`'s
behaviour, and the gate results above stand.

### Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| An operator with a sub-32 or NBSP-padded secret sees billing refuse to start. | **Accept.** Intended; fails closed and names the field. Documented at `.env.example:20-29`. Worth adding that the secret must be rotated on all services together. |
| A 32 × U+200B secret is accepted by billing's and worker's schemas. | **Accept, recorded under S-8** once H-1's mechanism sentence is corrected. Fails closed. |
| usage-service and gateway keep the untrimmed `.min()`. | **Accept, recorded.** Correctly scoped out by D1-A; S-8 now carries measured numbers for all four declarations. |
| `apps/gateway/.env.example:23` can drift silently. | **Decision 1.** Measured, not inferred. |
| S-8 items 1 and 3 remain open for billing and worker. | **Unchanged, correctly out of scope.** |
| The S-8 title asserts "three" guards and will go stale when S-9 gives analytics one. | **Accept.** Known cost of the chosen heading; the body carries the derivation. |
| billing's `base.repository.ts` has no S-18 `TimeZone` pin (S-19) and T-045/T-046 will filter `Invoice.periodStart`/`periodEnd`. | **Handed forward, correctly.** No new entry needed. |
| The `internalApiSecret` build option remains unvalidated (D2-A). | **Accept.** Not operator-reachable; pinned by `tests/env.schema.unit.test.ts:386-426`. |

**CONDITIONAL** — required fixes 1-4 above, then Gate 3 for the edits and a billing-scoped re-run.
