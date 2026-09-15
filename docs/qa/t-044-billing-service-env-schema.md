# QA — T-044 · Billing service env schema

**Gate**: 5 (QA Tester)
**Base**: `961d222`. Change is the uncommitted working tree. Nothing staged, nothing committed.
**Verdict**: **FAIL** — narrow. The implementation is correct and every security-relevant
acceptance criterion is proven by mutation. The failure is three documentation/comment defects,
one of which is a Round-1 **required-for-approval** item reported as applied but only half
applied, plus one test-honesty regression introduced by the Round-1 NIT remediation. No
production code needs to change.

**Release readiness**: the shipped `apps/billing-service/src/**` diff is releasable as-is. Do not
commit until Q-1, Q-2 and Q-3 are dispositioned, because two of them are false claims in files
other agents are instructed to trust.

---

## 1. Full gates — my own `--force` run

`pnpm build -- --force` does not forward the flag, so `npx turbo run <task> --force` was used
throughout. Every task shows `cache bypass, force executing`; no `FULL TURBO` replay.

| Gate | Command | Result |
|---|---|---|
| typecheck | `npx turbo run typecheck --force` | `Tasks: 13 successful, 13 total` · 0 errors |
| lint | `npx turbo run lint --force` | `Tasks: 13 successful, 13 total` · **0 errors, 14 warnings** |
| build | `npx turbo run build --force` | `Tasks: 13 successful, 13 total` · 0 errors |
| test | `npx turbo run test --force` | `Tasks: 13 successful, 13 total` |
| smoke | `pnpm test:smoke` | exit 0 · 6 suites, 7 tests, all passing |

Per-package test counts from the forced run:

| Package | Files | Tests |
|---|---|---|
| `@telemetry/shared-types` | 1 | 8 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/analytics-service` | 4 | 18 |
| **`@telemetry/billing-service`** | **5** | **34** |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/usage-service` | 19 | 230 |
| `@telemetry/auth-service` | 15 | 164 |
| `@telemetry/worker-service` | 12 | 180 |
| `@telemetry/web` | — | (no test files) |

Billing **4 files / 18 tests → 5 files / 34 tests** confirms the stated baseline delta exactly
(16 added).

### Warnings — pre-existence proven

14 warnings, 0 errors, **zero `no-unsafe-return`** — matching the expectation.

```
apps/auth-service/tests/auth.service.unit.test.ts    10 × @typescript-eslint/no-misused-promises
apps/usage-service/tests/ingestion.service.unit.test.ts  4 × @typescript-eslint/no-unsafe-assignment
```

```
$ git log -1 --format="%h %ad" --date=short -- apps/auth-service/tests/auth.service.unit.test.ts
d68e719 2026-08-25
$ git log -1 --format="%h %ad" --date=short -- apps/usage-service/tests/ingestion.service.unit.test.ts
b0f6921 2026-08-31
$ git diff --name-only 961d222 | grep -E "auth.service.unit|ingestion.service.unit"
(no output)
```

Neither file is in the T-044 diff. 10 @ `d68e719`, 4 @ `b0f6921` — pre-existing, confirmed.

**Note on the package count.** `npx turbo ls` reports **13 packages**, and there is no
`packages/sdk` on disk. `CLAUDE.md` lists `sdk` among "7 shared packages", which with 7 apps
would be 14. The `13` figure is right and the list is stale by one entry. Pre-existing, unrelated
to T-044; noted only so a future gate does not go looking for a fourteenth package.

---

## 2. The load-bearing check — `.trim()` before `.min()`

### 2a. Re-derived independently against zod 3.25.76 (repo-resolved)

Probe run from inside `apps/billing-service` so it resolved the same zod the service does:

```
trim().min()   | 32 spaces              | REJECT: String must contain at least 32 character(s)
trim().min()   | 32 tabs                | REJECT
trim().min()   | 31-core padded to 35   | REJECT
trim().min()   | 31 chars bare          | REJECT
trim().min()   | 32 chars bare          | OK   -> len 32
trim().min()   | padded valid           | OK   -> len 32
min()          | 32 spaces              | OK   -> len 32  "          "
min()          | 32 tabs                | OK   -> len 32
min()          | 31-core padded to 35   | OK   -> len 35
min()          | 32 chars bare          | OK   -> len 32
min()          | padded valid           | OK   -> len 36   <-- untrimmed output
min().trim()   | 32 spaces              | OK   -> len 0   ""
min().trim()   | 31-core padded to 35   | OK   -> len 31   <-- LIVE 31-char secret
min().trim()   | 32 chars bare          | OK   -> len 32
min().trim()   | padded valid           | OK   -> len 32
zod version: 3.25.76
```

Confirms the three-way distinction exactly as `src/config/env.ts:25-34` and
`.claude/rules/known-gaps.md:101-104` state it, including the dangerous row: `.min(32).trim()`
reads as a fix, passes the "strips surrounding whitespace" case, and admits a **live
31-character** secret.

### 2b. Re-derived against the shipped suite — Round 1's table reproduced

Mutated `apps/billing-service/src/config/env.ts:48` and ran
`pnpm --filter @telemetry/billing-service exec vitest run tests/env.schema.unit.test.ts`.
File restored from a checksum-verified backup after each run.

| Declaration at `env.ts:48` | Result | Named failures |
|---|---|---|
| `z.string().trim().min(SECRET_MIN_LENGTH)` (shipped) | **16 passed (16)** | none |
| `z.string().min(SECRET_MIN_LENGTH)` | **3 failed \| 13 passed** | `rejects an all-whitespace …`, `rejects an INTERNAL_API_SECRET that reaches the minimum only by its padding`, `strips surrounding whitespace …` |
| `z.string().min(SECRET_MIN_LENGTH).trim()` | **2 failed \| 14 passed** | the first two of those three |

Identical to Round 1's table. **The suite genuinely distinguishes all three orderings.**

### 2c. Correction 1 — verified

The briefing's earlier claim that AC3/AC4 could not distinguish the orderings is **false**, and
the Round-1 correction is **right**. Measured: under `.min(32).trim()` the failing set is
`{rejects an all-whitespace …, rejects an … minimum only by its padding}` — **AC3 is in it**.
32 spaces pass `.min(32)`, trim to `""`, `safeParse` succeeds, and `expectIssueOn`'s
`expect(parsed.success).toBe(false)` fails. AC3 alone is red under **both** wrong orderings.

So the extra test is **not** needed to tell the orderings apart. The reasoning written at
`tests/env.schema.unit.test.ts:154-157` — that it earns its place because AC3's failure mode is a
*blank* secret that `app.ts:44`'s `!internalApiSecret.trim()` catches anyway, whereas its own
failure mode is a live 31-character secret that reaches `buildInternalAuthMiddleware` — **holds**,
and 2a's `min().trim() | 31-core padded to 35 -> len 31` is the direct evidence. Only the second
is silent. The comment is accurately scoped; nothing needs editing on this point.

---

## 3. Is there any remaining path to a short, blank or padded secret?

Traced every assignment and every use, `src` and `tests`:

```
apps/billing-service/src/app.ts:14   internalApiSecret?: string;                                  (option type)
apps/billing-service/src/app.ts:29   const internalApiSecret = options.internalApiSecret ?? env.INTERNAL_API_SECRET;
apps/billing-service/src/app.ts:44   if (!internalApiSecret.trim()) { throw ... }
apps/billing-service/src/app.ts:57   const internalAuth = buildInternalAuthMiddleware(internalApiSecret);
```

`:29` is the **only** assignment and `:57` the **only** consumer. Two arms:

1. **`env.INTERNAL_API_SECRET`** — validated at module load, which is strictly earlier than the
   app build. Cannot be blank, short, or whitespace-padded.
2. **`options.internalApiSecret`** — unvalidated by decision D2-A. Blank and whitespace-only are
   caught by `:44` (`InternalApiSecretMissingError`); **short-but-non-blank is not**.

**So yes: the option arm is the one remaining path, and it is pinned** —
`tests/env.schema.unit.test.ts:275-282` (blank/whitespace throws) and `:289-315` (a short
override still wins), both with comments naming it as the remaining path. Both were confirmed
non-vacuous by mutation (§5, M7 and M8).

Not operator-reachable: `apps/billing-service/src/index.ts:23` calls `buildBillingServiceApp()`
with no arguments — verified by reading the file.

**One correction to the accounting.** The plan's Gate-1 measurement and the briefing both name
`tests/smoke.test.ts:18`'s 11-character `"test-secret"` as *the* sub-32 value in the tree. That is
now stale by one: T-044's own suite adds a **24-character** override at
`tests/env.schema.unit.test.ts:290` (`"explicit-override-secret"`). Both are test-only and neither
is a defect, but "the only sub-32 value" should read "the only two, both in tests". The comment at
`app.ts:27` is unaffected — it is a claim about the *path*, not about call-site count, and it is
true.

### Coverage gap found: `.trim()` does not strip zero-width space

`String.prototype.trim` strips Unicode `WhiteSpace`, which is category `Zs` plus a few — it does
**not** include U+200B ZERO WIDTH SPACE (category `Cf`). Measured against the shipped declaration:

```
32 NBSP (U+00A0)         raw=32 -> REJECT
NBSP-padded 31-core      raw=35 -> REJECT
32 newlines              raw=32 -> REJECT
32 EM SPACE (U+2003)     raw=32 -> REJECT
32 ZWSP (U+200B)         raw=32 -> ACCEPT parsed len 32     <-- gap
```

A secret of 32 zero-width spaces passes the schema and reaches the middleware as a 32-character
invisible value. Severity **LOW**: it requires an operator to paste 32 ZWSPs, it fails closed at
the wire (a caller must still match it byte-for-byte), and `.env.example`'s "Paste plain text"
line is the mitigation already present. It is **not** billing-specific — worker-service's
`.trim().min()` has the same residual, and usage/gateway have a strictly larger hole. Recommended
for `.claude/rules/known-gaps.md` as an addendum to S-8's fix direction rather than a T-044 fix
(see §9).

---

## 4. Correction 2 — the S-8 counts

Both counts verified by command.

```
$ find apps -path '*/src/middleware/internal-auth.middleware.ts' -not -path '*/node_modules/*' -not -path '*/dist/*'
apps/billing-service/src/middleware/internal-auth.middleware.ts
apps/usage-service/src/middleware/internal-auth.middleware.ts
apps/worker-service/src/middleware/internal-auth.middleware.ts        --> 3 guards

$ grep -n "INTERNAL_API_SECRET" apps/*/src/config/env.ts       (declaration lines only)
apps/billing-service/src/config/env.ts:48  z.string().trim().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)
apps/usage-service/src/config/env.ts:15    z.string().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)
apps/gateway/src/config/env.ts:14          z.string().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)
apps/worker-service/src/config/env.ts:33   z.string().trim().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)
                                                                      --> 4 schemas, 2 strictnesses
```

**Three guards, four schemas.** The retitle at `.claude/rules/known-gaps.md:39` states both
numbers and is correct. `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH = 32`
(`packages/shared-types/src/index.ts:93`), so billing's shipped declaration is the epic's
`min(32)` plus a trim — strictly stronger, never weaker.

---

## 5. Acceptance criteria — every one proven by a test that goes red

Each AC was checked by mutating the implementation and confirming the named test fails, then
restoring from a checksum-verified backup. Eight mutations, all reverted.

| AC | Behaviour | Mutation | Result |
|---|---|---|---|
| AC1 | field required, no default | — (covered by M1/M2 class; `buildEnvWithout` throws if the key is absent, so it cannot pass vacuously) | asserted |
| AC2 | rejects empty and one below minimum | boundary probe §2a | asserted |
| AC3 | rejects `SECRET_MIN_LENGTH` whitespace | **M1**, **M2** | **red under both wrong orderings** |
| AC3b | rejects padded-to-minimum short core | **M1**, **M2** | **red under both** |
| AC4 | padded valid parses trimmed | **M1** | **red** (`.min()` returns len 36) |
| AC5 | accepts exactly at the shared minimum | §2a | asserted, constant imported not literal |
| AC6 | module load fails fast / loads | live boot §6 | **proven at runtime** |
| AC7 | `PORT` defaults to the bound port | **M4** (`default(3000)`) → `expected 3000 to be 3004` | **red** — but see **Q-1** |
| AC8 | `app.ts` reads the parsed value | **M3** (revert `:29` to `process.env … ?? ""`) → `expected 401 to be 200` | **red** — the single test that separates a fix from a comment |
| AC9 | explicit option still wins | **M8** (drop the options arm) | **red** (2 tests) |
| AC10 | blank option still throws | **M7** (`if (false)`) | **red** |
| AC11 | other fields still reject when missing | `buildEnvWithout` throws on a drifted fixture | non-vacuous by construction |

Verbatim, the two that matter most:

```
##### M3: app.ts reverted to process.env read (the S-8 defect) #####
  const internalApiSecret = options.internalApiSecret ?? process.env.INTERNAL_API_SECRET ?? "";
   × ... > authenticates with the parsed secret after process.env.INTERNAL_API_SECRET is mutated
     → expected 401 to be 200 // Object.is equality
      Tests  1 failed | 15 passed (16)

##### M7: remove the blank-secret guard (AC10) #####
   × ... > rejects a blank internalApiSecret option
      Tests  1 failed | 33 passed (34)
```

**Additional NIT-1 mutation.** `BILLING_RUNTIME.DEFAULT_PORT` decoupled back to a stale literal
`3000` (M5) → `expected 3000 to be 3004`. So `tests/env.schema.unit.test.ts:71` does pin the
constants file to the startup file. That is a real guard; the problem is a different one — Q-1.

---

## 6. Functional smoke — the service was actually run

`node dist/src/index.js` is **not** a supported entrypoint: the emitted ESM carries extensionless
relative imports (`Cannot find module '…/dist/src/startup.constants'`). Pre-existing and
repo-wide — `apps/worker-service/dist/src/index.js:2` has the identical shape — and irrelevant,
because the container runs `CMD ["sh","-lc","pnpm --filter @telemetry/${SERVICE_NAME} exec tsx
src/index.ts"]` (`Dockerfile:20`) and `package.json` has a `dev` script but no `start`. Re-run
under `tsx`, which is the shipped path, against live Postgres and Redis:

| `INTERNAL_API_SECRET` | raw len | Boot | `/health` | POST correct | POST wrong | POST no header |
|---|---|---|---|---|---|---|
| valid | 46 | **booted** | 200 | **200** | 401 | 401 |
| `short` | 5 | **refused** | — | — | — | — |
| 33 spaces | 33 | **refused** | — | — | — | — |
| 31 `x` | 31 | **refused** | — | — | — | — |
| 32 `x` (boundary) | 32 | **booted** | 200 | **200** | 401 | 401 |
| valid, SP-padded | 50 | **booted** | 200 | **200** | 401 | 401 |

Refusal message, verbatim and identical in all three failing cases:

```
Error: Invalid environment configuration for INTERNAL_API_SECRET: String must contain at least 32 character(s)
```

The field is named, as the `.env.example` comment promises. Success body:
`{"status":"accepted","workflow":"billing-generation"}`. All six processes were stopped; no
listener on 3991-3996 remains; Postgres and Redis left running.

### Wire behaviour — L-1's scoped claim, re-measured on a third client

Fastify 5.10.0 server, header `x-internal-secret` padded four ways, two client stacks, bytes
shown as hex:

```
--- undici (global fetch) ---
SP    sent=[20 61…6a 20]        seen=[61…6a]           stripped
HTAB  sent=[09 61…6a 09]        seen=[61…6a]           stripped
NBSP  sent=[c2 a0 61…6a c2 a0]  seen=[c2 a0 …c2 a0]    identical=true
--- raw net.Socket ---
SP / HTAB: stripped.  NBSP: identical=true.
```

`curl` (§6 table, "valid, SP-padded" row) agrees: the padded and trimmed headers both returned
200, i.e. curl's padding was stripped too — a third independent corroboration.

**SP/HTAB stripping and NBSP survival under undici are confirmed.** JS `trim()` *does* strip
U+00A0, so a NBSP-padded configured secret trims while a NBSP-padded inbound header does not —
mismatch, 401, never silent acceptance. The comment's conclusion holds.

One divergence from Round 1, reported rather than smoothed over: my raw-socket NBSP case arrived
as `U+00A0`, **not** the `U+00C2 U+00A0` Round 1 reported. The difference is the probe's write
encoding (`latin1` here vs. presumably default utf8 there), which changes the bytes on the wire.
I did not resolve which probe models a real third-party client better. The shipped comment is
scoped to "the client billing actually has in front of it" and is therefore correct under either
result — if anything it is conservative. **Unresolved, and it does not affect the verdict.**

---

## 7. Defects

### Q-1 · MEDIUM — `tests/env.schema.unit.test.ts:71` is now tautological, and its comment at `:58-61` is false

`apps/billing-service/tests/env.schema.unit.test.ts:58-71`.

The comment claims the test asserts

> that billing's two independent copies of that port (finding F7) have not drifted apart.

They are **no longer two independent copies**. The Round-1 NIT remediation made
`apps/billing-service/src/constants.ts:39` read
`DEFAULT_PORT: BILLING_SERVICE_STARTUP.DEFAULT_PORT`, so both sides of both assertions —
`parsed.data.PORT` at `:68` and `BILLING_RUNTIME.DEFAULT_PORT` at `:71` — now resolve to the same
expression. Drift between them is unrepresentable, so the assertion cannot fail.

**Reproduction (M6).** Change the single remaining source-of-truth literal:

```
$ sed -i 's/  DEFAULT_PORT: 3004,/  DEFAULT_PORT: 9999,/' apps/billing-service/src/startup.constants.ts
$ pnpm --filter @telemetry/billing-service exec vitest run tests/
 Test Files  5 passed (5)
      Tests  34 passed (34)
```

**The whole billing suite stays green with the service bound to the wrong port.** Meanwhile
`docker/docker-compose.yml:111` (`PORT: "3004"`), `:114` (`"3004:3004"`),
`apps/gateway/.env.example:23` (`http://localhost:3004`) and `apps/billing-service/.env.example:6`
still say 3004. Billing would listen on 9999, compose would map 3004, and the failure would
surface at deploy rather than in CI.

Before the NIT remediation this assertion was a genuine guard, because the two constants were
independent literals — M5 confirms it still catches decoupling in the *other* direction. The
remediation traded a live drift guard for DRY without saying so. **worker-service still has both
literals** (`src/startup.constants.ts:3` and `src/constants.ts:44`, both `3003`), so
`apps/worker-service/tests/env.schema.unit.test.ts:622` — the line billing's was copied from — is
still a real guard. Billing is now weaker than its template, which is the drift class S-19 and
S-14 exist to record.

This is a coverage regression and a false comment, not a behavioural defect. Nothing is
mis-bound today. **See the decision in §8.**

### Q-2 · MEDIUM — Round-1 required item 2 is only half applied; `.claude/rules/known-gaps.md:99` carries a false claim

Round 1's *Required for CONDITIONAL → approval* item 2 reads:

> `.claude/rules/known-gaps.md:44`, `:47-48`, `:88` — add gateway to the item-2 summary and
> narrow "all four services end up identical" to "all four declarations" (M-1b).

Applied: `:48` now reads `what is left of item 2 is **usage-service's and gateway's**`. ✓

**Not applied**, current text:

```
:62  2. **~~The secret bypasses the env schema~~ — closed for billing and worker; what remains is
:63     usage-service's untrimmed `.min()`.**
```

The bolded item-2 summary still names usage-service alone, contradicting its own body ten lines
later, which names `apps/usage-service/src/config/env.ts:15` **and**
`apps/gateway/src/config/env.ts:14`. This is exactly M-1(b) as written.

```
:98  **Fix direction:** add `.trim()` before `.min(...)` in usage-service's and gateway's
:99  `EnvSchema`, so all four services end up identical.
```

`so all four services end up identical` is **false**, and the entry refutes it in its own body:
usage-service alone has the timing-safe `secretsMatch` comparison and alone lacks a blank-secret
guard in `app.ts`; gateway has no guard at all because it is the caller. Adding `.trim()` makes
the four **declarations** identical and leaves the services as divergent as they are today.

`.claude/rules/` is designated authoritative and other agents are instructed to trust it without
re-verification, which is why `review-standards.md` rates a false claim there HIGH by default.
Round 1 downgraded the M-1 family to MEDIUM with stated reasoning (the claim asserts no protection
and skips no check; its cost is a wasted round), and I adopt that judgement. But it was listed as
required, was reported to this gate as applied, and is not.

**Fix:** `:63` → `usage-service's and gateway's untrimmed `.min()``; `:99` → `so all four
*declarations* end up identical`.

### Q-3 · LOW — `.env.example:23` NIT-2 not applied

`apps/billing-service/.env.example:23` still reads
`against in-cluster callers and the published 3004 port mapping`. Round 1 listed this as
*optional* (item 4) with suggested wording
`against callers that did not come through the gateway — reachable in-cluster and through the
published 3004 port mapping`. Cosmetic; recorded for completeness, not a blocker on its own.

### Verified correct — what Round 1 asked for that **was** applied

- **M-1(a)** — `known-gaps.md:39` retitled to state both numbers; §4 confirms 3 and 4 by command.
- **L-1** — `src/config/env.ts:40-42` now scopes "intact" to "the client billing actually has in
  front of it, not for every transport". §6 corroborates the undici result on a third client.
- **L-2** — `known-gaps.md` now says the usage-service comment "is not false on its own words —
  it is misleading, because the property a reader takes from it is *not blank*". Correct: a
  32-space string is literally non-empty. I confirmed `.min(32).safeParse(" ".repeat(32))`
  succeeds with length 32 against the real declaration.
- **NIT-1 import direction** — `apps/billing-service/src/startup.constants.ts` has **zero
  imports** (side-effect-free); `constants.ts:3` imports it, never the reverse. `index.ts` imports
  only `@telemetry/shared-tracing` and `./startup.constants` before `initTracing(...)` at `:18`.
  No cycle, no heavy module on the pre-tracing path. Correct as claimed.
- **`3004` literals** — exactly **one** left in billing TypeScript source:
  `src/startup.constants.ts:3`. The remaining occurrences are `.env.example:6` (an env value),
  `tests/setup.ts:3` (`process.env.PORT ??= "3004"`, **pre-existing at `961d222`**, verified with
  `git show`) and three prose comments.
- **Gateway-reachability claim** in `.env.example:23-24` — verified.
  `GATEWAY_PROXY_PREFIXES.BILLING = "/v1/billing"` (`apps/gateway/src/constants.ts:36`) with
  `rewritePrefix: prefix` (`proxy.plugin.ts:27`), against billing's
  `INTERNAL_BILLING_GENERATE = "/v1/internal/billing/generate"`
  (`apps/billing-service/src/constants.ts:9`). Different prefix; the internal route is not
  reachable through the gateway proxy today. Matches epic-8's "must never be exposed through the
  gateway".

---

## 8. Decision for the user

### The port drift guard — Q-1. *(Options A and C change the diff; B is a comment-only edit.)*

**Question:** billing's `PORT` assertion no longer pins the number `3004` to anything independent,
because the NIT remediation made `BILLING_RUNTIME.DEFAULT_PORT` derive from
`BILLING_SERVICE_STARTUP.DEFAULT_PORT`. How should that be closed?

| | What changes | Effect |
|---|---|---|
| **A — revert NIT-1** | `constants.ts:39` back to `DEFAULT_PORT: 3004` | Restores the drift guard verbatim and matches worker-service, which still has both literals. Reintroduces the duplication the Gate-4 NIT objected to, and re-opens plan finding F7. |
| **B — keep the derivation, fix the comment only** | `tests/env.schema.unit.test.ts:58-61`: drop "two independent copies … have not drifted apart"; say it asserts the schema default equals the startup constant, and that nothing pins the number itself | Smallest edit. Honest. Leaves M6 green — a wrong `3004` still ships silently. |
| **C — keep the derivation, add an independent pin (recommended)** | B, plus one assertion in `tests/env.schema.unit.test.ts` tying `BILLING_SERVICE_STARTUP.DEFAULT_PORT` to a source that does **not** derive from it — `apps/billing-service/.env.example:6`'s `PORT=3004` or `docker/docker-compose.yml:114`'s mapping | Keeps DRY **and** restores the guard, and covers more than A did: A only pinned two in-process constants to each other, never to the compose mapping that actually has to agree. Costs one file read in a unit test. |
| **D — accept and record** | Add Q-1 to `.claude/rules/known-gaps.md` as an S-8/S-19-class drift note; no code or test change | Cheapest. The number is stable and nobody is proposing to change it. Defers the risk to whoever does. |

**Recommendation: C**, with **B as the floor**. The false comment at `:58-61` has to go under any
option — it asserts a property the diff removed, and `review-standards.md` treats a wrong comment
beside code as a finding in its own right. C is preferred over A because the constant pair was
never the interesting drift: the pairing that actually breaks a deploy is service-port versus
compose-port, and neither A nor the pre-T-044 tree ever checked that.

**What each answer changes about the work:** A and C reopen Gate 3 for a code/test edit and a
billing-scoped re-run (`lint typecheck test`, ~40s). B and D are a comment and a markdown edit
respectively and need no re-run beyond billing lint. None of them touches the shipped
`src/config/env.ts` or `src/app.ts` behaviour, so §2, §3, §5 and §6 stand under all four.

---

## 9. Recommended for `.claude/rules/known-gaps.md`

Out of scope for T-044; recorded so it is not lost.

1. **`.trim()` does not strip U+200B ZWSP** (§3). A 32-ZWSP `INTERNAL_API_SECRET` is accepted by
   billing's and worker's schemas. LOW, fails closed. Best folded into S-8's fix direction as a
   note when usage-service and gateway get their `.trim()` — the point being that `.trim()` closes
   the `Zs` class and not the `Cf` class, so "whitespace-proof" is an overclaim.
2. **Q-1 itself**, if decision D is taken above.

No other new gap is warranted. Everything else this change surfaced already has a home in S-8
(the untrimmed usage/gateway schemas, the misleading usage-service comment, the duplicate `401`)
or S-19 (billing's missing `TimeZone` pin, correctly handed forward to T-045/T-046), and the diff
files each of them there. That accounting is the strongest part of this change and I found no
error in it beyond Q-2.

---

## 10. Regression risk across the other 12 packages

**Nothing that boots today stops booting.** Every checked-in supply path measured directly:

| Path | Length | Trimmed length | Boots after T-044 |
|---|---|---|---|
| `docker/docker-compose.yml:93,112,149,172` | 45 | 45 | yes |
| `.github/workflows/ci.yml:34` | 45 | 45 | yes |
| `apps/billing-service/.env.example:20` | 37 | 37 | yes |
| `apps/billing-service/tests/setup.ts:12` | 45 | 45 | yes |
| `tests/smoke.test.ts:18` build option | 11 | 11 | yes — bypasses the schema (D2-A) |
| `tests/env.schema.unit.test.ts:290` build option | 24 | 24 | yes — same arm |

**The residual is live on this host and worth stating.** There is an untracked `./.env` at the
repo root carrying a **16-character** `INTERNAL_API_SECRET`. `index.ts:21` calls
`loadLocalEnv()` → `process.loadEnvFile()` with no argument, which resolves `.env` against
`process.cwd()`, so it is reachable only when billing is started from the repo root — not via
`pnpm dev`, `pnpm --filter … dev`, or the container, all of which run with the package directory
as cwd. And it changes nothing in practice: usage-service and gateway already enforce
`.min(32)`, worker enforces `.trim().min(32)` since T-037, so that `.env` was already unbootable
for three of the four services before T-044. Billing is joining them, not breaking new ground.
This is the residual the plan named at Slice 3 and the reviewer accepted; I am confirming it is
real and bounded.

**Blast radius outside billing: none.** No package imports `@telemetry/billing-service` —
the only cross-package references are the `test:smoke` / `test:smoke:compose` runner strings in
the root `package.json`. The two new constants (`HTTP_STATUS_OK`, `HTTP_STATUS_UNAUTHORIZED`)
are additive and both are used (`tests/env.schema.unit.test.ts:252, :264, :303, :311`) — neither
is dead. The four suites neighbouring the change stayed green for the right reasons: all 34
billing tests passed on the restored tree, and the four independent mutations in §5 each turned
exactly the expected named tests red, so nothing is short-circuiting.

### Scope discipline — verified

```
apps/billing-service/src/middleware/internal-auth.middleware.ts  UNCHANGED
apps/usage-service/src/config/env.ts                             UNCHANGED
apps/billing-service/tests/smoke.test.ts                         UNCHANGED
apps/billing-service/src/startup.constants.ts                    UNCHANGED
apps/billing-service/src/errors/index.ts                         UNCHANGED
apps/worker-service/src/config/env.ts                            UNCHANGED
apps/gateway/src/config/env.ts                                   UNCHANGED
```

The middleware deliberately does not adopt the new `HTTP_STATUS_*` constants — it still writes the
literal `401` at `internal-auth.middleware.ts:10`. That is S-8 item 3's, by decision, recorded at
`constants.ts:19-22` and in `known-gaps.md`. Correct as scoped.

---

## 11. Test honesty — sampled

| Concern | Finding |
|---|---|
| `buildEnvWithout` no-op | **Safe.** Throws `"buildBaseEnv() has no "X" key to omit; the fixture drifted."` when the key is absent, per `.claude/rules/testing.md`. |
| `expectIssueOn` passing vacuously | **Safe.** `expect(parsed.success).toBe(false)` throws first; the `if (parsed.success) return` is type narrowing that is unreachable at runtime. |
| AC8 asserting a mock | **Real.** Builds a real Fastify app and drives it with `app.inject`; M3 turns it red with the exact S-8 defect. |
| AC10 passing on the wrong error | **Safe.** `toThrow(InternalApiSecretMissingError)` is type-matched; M7 turns it red. |
| AC9 passing without the options arm | **Real.** M8 turns it and AC10 red. |
| AC5 hard-coding 32 | **Safe.** Imports `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH`; grep found no literal `32`, `200`, `401`, `3004` or `3000` in executable positions — the only matches are prose comments. |
| Cross-test coupling | **Safe.** Both `describe` blocks save/restore `process.env.INTERNAL_API_SECRET` in `afterEach`, the module-load block also calls `vi.resetModules()`, and every app is closed in a `finally`. |
| **AC7** | **Tautological — Q-1.** The one case in the file that can pass while measuring nothing. |

15 of 16 new cases are non-vacuous and mutation-confirmed where mutation applies.

---

## 12. What I exercised, and what I could not

**Exercised:** all four gates with `--force` across 13 packages; `pnpm test:smoke`; eight
implementation mutations with per-case red/green; an independent zod-3.25.76 ordering probe; a
Unicode-whitespace boundary sweep; six live `tsx` boots of billing-service driven over HTTP
against real Postgres and Redis, covering the 31/32-character boundary in both directions; a
two-client, four-padding header-wire probe; the gateway proxy-prefix reachability claim; the
constants/import-direction claims; and the full supply-path census including the untracked root
`.env`.

**Could not exercise:**

- **Docker Compose.** `docker/docker-compose.yml` was not brought up — the briefing scoped the
  environment to host Postgres and Redis and instructed me not to disturb them. The compose
  secret (45 chars) and the `3004:3004` mapping were read and measured statically, not booted.
  This is the one path where Q-1's silent-port-drift consequence would actually manifest.
- **`pnpm format:check`** — not run. S-12: it cannot pass on any revision of this repo.
- **The raw-socket NBSP discrepancy** (§6) — I established that the result depends on the probe's
  write encoding but did not determine which encoding models a real third-party client. The
  shipped comment is correct under either result, so I stopped there rather than spend the round.
- **Whether `process.loadEnvFile()` overrides an already-set `process.env` var.** Relevant only to
  the root-`.env` residual, which is bounded for other reasons (§10). Not measured; stated as
  unmeasured rather than assumed.
- **A `.min(32)` mutation of usage-service or gateway.** Both are explicitly out of scope under
  D1-A; I read their declarations and measured their strictness against the shipped schema, but
  did not mutate another service's startup contract.

---

## 13. Environment integrity

**Redis db 0 — the real stream is untouched.**

| | Before | After full `turbo run test --force` + smoke |
|---|---|---|
| `XLEN telemetry:events` | 2 | **2** |
| `entries-added` | 2 | **2** |
| `groups` | 0 | **0** |
| `last-generated-id` | `1788171536033-0` | **`1788171536033-0`** |
| `max-deleted-entry-id` | `0-0` | **`0-0`** |
| `DBSIZE` | 2 | **3** |

The `DBSIZE` increase is **S-22, reported rather than rounded to green**: auth-service's
integration suite wrote one TTL'd key to db 0, `denylist:5679cf9d9efbd5a8b84c198d61e1e5b6`
(`TTL 837`), alongside the pre-existing `denylist:1b0e0ff60befa11140b1f9030b7e0515` (`TTL 90`)
from an earlier run. Both self-expire. This is unavoidable when running the mandated full gate —
auth-service hard-codes `redis://localhost:6379` at `tests/auth.integration.test.ts:34` with no
logical database selected. Nothing was destroyed and no `FLUSHDB` was issued against db 0.

**Postgres:** `Event` 0, `UsageLine` 0, `Invoice` 0 — unchanged. `Tenant` 2, which is the
pre-existing S-20 fixture residue, not new. Both services left running.

**Working tree restored byte-identical.** All eight mutations reverted from checksum-verified
backups; both HTTP probe scripts and the zod probe deleted.

```
$ git ls-files -co --exclude-standard | grep -v node_modules | sort | xargs md5sum > after.md5
$ diff before.md5 after.md5
IDENTICAL: 455 files, byte-for-byte unchanged
```

`git status --short` matches the state at the start of this gate exactly: 6 modified, 3
untracked. **Nothing staged. Nothing committed.**

---

## 14. Verdict

**FAIL** → Gate 3.

The change does what it claims. S-8 item 2 is closed for billing-service, proven by live boot:
`INTERNAL_API_SECRET=short` returned `200` on `961d222` and now refuses to start with the field
named. The `.trim()`/`.min()` ordering is correct, and the suite distinguishes all three orderings
— reproduced independently, not inherited. Both briefed corrections check out. All 13 packages are
green on all four forced gates, smoke included, with 14 warnings all proven pre-existing.

What fails the gate is small and entirely in prose and test assertions:

1. **Q-2** — a Round-1 **required-for-approval** item reported to this gate as applied, applied at
   one of its three sites, leaving a self-contradicting summary at `known-gaps.md:63` and a false
   claim at `:99` in a file other agents are told to trust without checking.
2. **Q-1** — the Round-1 NIT remediation silently traded away a live drift guard and left behind a
   comment asserting the property it removed. Measured: the billing suite is 34/34 green with the
   service bound to port 9999.

Both are cheap. Q-2 is two markdown lines. Q-1 needs a decision (§8) and, at minimum, a corrected
comment. Neither requires touching `src/config/env.ts` or `src/app.ts`, so §2, §3, §5, §6 and §10
carry forward unchanged and the returning revision needs only a billing-scoped re-run plus a
markdown diff — not a full re-gate.
