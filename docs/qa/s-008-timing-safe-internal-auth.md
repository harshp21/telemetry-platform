# QA report — S-8: timing-safe internal-auth guards, and one declaration of `INTERNAL_API_SECRET`

**Gate 5 · independent QA · verdict: PASS** — with two MEDIUM documentation defects that are
worth fixing before commit but do not block, one decision for the user (D-1, below), and four
LOW/NIT items.

Base `2cdb140`; S-8 uncommitted, **30 `git status` entries** at start and at finish.
Tree integrity re-verified by checksum after every mutation I made (§8).

---

## 0 · Which revision of `known-gaps.md` I read

**From disk**, per the standing instruction — `md5 9afb6429d9d66f1b6868704616814dbc`, **3397
lines**, entries **S-5 → S-53**, with **S-8 absent** (the file goes S-6 → S-9) and **S-53
present**.

The copy injected into my context ended at **S-39** and **still contained S-8**. That is
**S-24 firing again — the twenty-third time this session**. Every S-8 quotation in this report
is from `git show 2cdb140:.claude/rules/known-gaps.md` lines 39–168; every current-state
quotation is from the on-disk file above.

## 1 · Environment baseline and drift

| | At start | After full gate + smoke + all probes |
|---|---|---|
| `Tenant` | **2** | **2** |
| `User` | 2 | 2 |
| `Event` / `UsageLine` / `Invoice` / `InvoiceLineItem` / `Meter` | **0 / 0 / 0 / 0 / 0** | **0 / 0 / 0 / 0 / 0** |
| `RefreshToken` / `MetricRollup` | 0 / 0 | 0 / 0 |
| Redis **db 0** `DBSIZE` | **2** | **2** |
| Redis db 13 / 14 / 15 | 0 / 0 / 0 | 0 / 0 / 0 |

**No drift.** `v1_7` still applied (1 row in `_prisma_migrations`); all five roles intact
(`telemetry_app`, `telemetry_auth_app`, `telemetry_auth_definer`, `telemetry_worker_app`,
`telemetry_worker_definer`). Nothing was written to Redis db 0. Postgres and Redis left running.

Worth recording because S-20 predicts otherwise: a fully-passing run leaked nothing, so the two
`Tenant` rows are still the two pre-existing orphans and not three.

## 2 · Gates — all 13 packages, `--force`, 0 cached

`npx turbo run typecheck --force` · `lint --force` · `build --force` · `test --force`
(`pnpm build -- --force` does not forward the flag, so `npx turbo` was used throughout).

| Gate | Result |
|---|---|
| typecheck | **13 successful, 13 total · 0 cached** |
| lint | **13 successful, 13 total · 0 cached** · 14 warnings, 0 errors |
| build | **13 successful, 13 total · 0 cached** |
| test | **13 successful, 13 total · 0 cached** |

### Per-package test totals

| Package | Files | Tests |
|---|---|---|
| @telemetry/analytics-service | 4 | **18** |
| @telemetry/auth-service | 15 | **166** |
| @telemetry/billing-service | 20 | **231** |
| @telemetry/gateway | 9 | **50** |
| @telemetry/shared-config | 1 | **4** |
| @telemetry/shared-logger | 1 | **4** |
| @telemetry/shared-tracing | 1 | **2** |
| @telemetry/shared-types | 1 | **8** |
| @telemetry/shared-utils | 1 | **26** |
| @telemetry/shared-validation | 1 | **30** |
| @telemetry/usage-service | 19 | **238** |
| @telemetry/worker-service | 18 | **251** |
| @telemetry/web | — | no test output (no-op script) |
| **Total** | **91** | **1028** |

**1028 matches the stated root total exactly.** No failures, no skips. The three `failed`
string matches in the log are `Tenant-scoped transaction failed and was rolled back` — expected
log lines from billing's deliberate-rollback cases, not test failures.

`pnpm test:smoke` — **6 suites, 7 tests, all pass** (gateway 2, auth 1, usage 1, billing 1,
analytics 1, worker 1).

### Lint warnings — the split, and its provenance

**14 warnings, and the split is 10 / 4 as you stated, not what Gate 4 recorded.**

| Count | Rule | File |
|---|---|---|
| **10** | `@typescript-eslint/no-misused-promises` | `apps/auth-service/tests/auth.service.unit.test.ts` (`:61, :86, :117, :144, :179, :204, :231, :262, :297, :323`) |
| **4** | `@typescript-eslint/no-unsafe-assignment` | `apps/usage-service/tests/ingestion.service.unit.test.ts` (`:339, :340, :543, :544`) |

`no-unsafe-return`: **0 occurrences** in the whole log.

Provenance, derived as required:

```
$ git log -1 --format="%h %ad %s" --date=short -- apps/auth-service/tests/auth.service.unit.test.ts
d68e719 2026-08-25 test(services): expand coverage for singleton, container, and shutdown flows
$ git log -1 --format="%h %ad %s" --date=short -- apps/usage-service/tests/ingestion.service.unit.test.ts
b0f6921 2026-08-31 fix(security): close tenant-isolation gaps S-1 through S-4
```

Neither file appears in `git diff HEAD --numstat`. **All 14 are pre-existing**; this change
introduces none.

---

## 3 · Priority 1 — does the change close what it claims?

### 3.1 The outage — reproduced against `2cdb140`, then confirmed closed

Old declarations read with `git show` (no tracked file modified):

| Service | Declaration at `2cdb140` |
|---|---|
| gateway `src/config/env.ts:14` | `z.string().min(SECRET_MIN_LENGTH)` |
| usage `src/config/env.ts:15` | `z.string().min(SECRET_MIN_LENGTH)` |
| worker `src/config/env.ts:52` | `z.string().trim().min(SECRET_MIN_LENGTH)` |
| billing `src/config/env.ts:50` | `z.string().trim().min(SECRET_MIN_LENGTH)` |

Two rules across four schemas — exactly as S-8's deleted text (lines 39–168) describes.

I stood up the two real upstreams behind a **real gateway registering the real
`@fastify/http-proxy` with `proxy.plugin.ts`'s `rewriteRequestHeaders` shape**, each service
holding the value **its own old schema** produces, and each comparing the way its own old guard
compared (usage: the SHA-256 `secretsMatch` it already had; billing: `Array.isArray(...)` +
`!==`, verbatim from `git show`). One deployed value, `"  " + "a"×32 + "  "`:

```
DEPLOYED value       : "  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  " len 36
  parsed by gateway : success=true  len=36     <- untrimmed
  parsed by usage   : success=true  len=36     <- untrimmed
  parsed by worker  : success=true  len=32     <- trimmed
  parsed by billing : success=true  len=32     <- trimmed

Header AS SENT by gateway    : "  aaaa…aaaa  " len 36
Header AS RECEIVED upstream  : "aaaa…aaaa"     len 32
edge whitespace stripped in transit: true

--- gateway -> upstream, through the real proxy ---
  gateway sends padded -> usage   : 401
  gateway sends padded -> billing : 200
```

**Reproduced exactly as claimed**, including the mechanism: the gateway holds and sends the
padded 36-character value, transit strips the edge whitespace to 32, usage compares against its
own padded 36 and fails, billing compares against its trimmed 32 and succeeds. Ingestion down,
billing up, one stray space.

On the shipped tree all four services derive from **one object**
(`grep -n 'INTERNAL_API_SECRET:' apps/*/src/config/env.ts` → four hits, all
`internalApiSecretSchema`), so they cannot disagree by construction. Driving the **real env
modules** of all four with the same value: all four boot and all four hold `"a"×32`.

### 3.2 S-8, item by item against its deleted text — every item closed

| S-8 item (text at `2cdb140`) | Status | How I established it |
|---|---|---|
| 1 · `!==`, not a timing-safe comparison, in billing and worker | **CLOSED** | All three guards read `secretsMatch(providedSecret, …)` imported from `@telemetry/shared-utils`. `BU135`/`W8` shape-assert the absence of `!== internalApiSecret`; re-performed red (§5.3) |
| 2 · usage-service's and gateway's untrimmed `.min()` | **CLOSED** | Both now `internalApiSecretSchema`. Driven live: 32 spaces and a 31-core-padded-to-35 both **refuse to boot** on all four (§3.3) |
| 2b · usage-service's missing blank-secret guard in `app.ts` | **CLOSED, and moot** | `apps/usage-service/src/app.ts:27` passes `env.INTERNAL_API_SECRET` — the fragment-parsed value — and usage-service accepts **no** unvalidated override, so there is no path a blank value can take |
| 2c · reword the misleading usage docblock ("validated non-empty…") | **CLOSED** | `internal-auth.middleware.ts:20-27` rewords it and explains why, as S-8 required |
| 3 · `preHandler`, not `onRequest`; `reply.send(...)` not returned | **CLOSED** | Both registrations promoted; both guards `return reply…`. Collapse verified live and under revert (§5.1) |
| 4 · billing takes the first value of a duplicated header | **CLOSED** | billing now `typeof providedSecret !== "string"` → reject, identical to usage and worker |
| 5 · the literal `401` instead of `HTTP_STATUS_UNAUTHORIZED` | **CLOSED** | Both use the constant; `BU136` asserts `not.toContain("reply.status(401)")` |
| 6 · addendum — `.trim()` leaves U+200B, U+2060, U+180E, U+200C, U+00AD as 32-char secrets | **CLOSED** | All five, plus U+0085 and U+00FF, now **rejected at startup** by `SECRET_PATTERN` (§4.1) |
| 7 · "share one timing-safe comparison helper rather than three copies" | **CLOSED** | One `secretsMatch` in `@telemetry/shared-utils`; three importers |
| 8 · "all four secret schemas declare the field identically" | **CLOSED** | One object; each service asserts identity with it (§5.4) |

**The deletion of S-8 is not premature.** Every item is closed, and the two `.claude/rules/`
entries that survive cite it explicitly as retired.

### 3.3 The boot-break — driven, per service, per class

Driven against the **real source env modules** via `tsx` (the `dist` copies are not
self-resolving; gateway also had to be driven through `loadEnv()` because it parses lazily).

| Value | gateway | usage | worker | billing |
|---|---|---|---|---|
| 32 spaces (all-whitespace) | REFUSE | REFUSE | REFUSE | REFUSE |
| 31 characters | REFUSE | REFUSE | REFUSE | REFUSE |
| 32 × U+00AD (non-ASCII) | REFUSE | REFUSE | REFUSE | REFUSE |
| unset / empty | REFUSE | REFUSE | REFUSE | REFUSE |
| valid 32 ASCII | boot | boot | boot | boot |
| `"  " + valid32 + "  "` | boot | boot | boot | boot |
| ASCII with **internal spaces** | boot | boot | boot | boot |

**All four now agree on every class** — the convergence the change exists for.

**The newly-breaking delta**, old rule vs new, per service — this is the operational risk the
change adds:

| Deployed value | Newly refuses to start |
|---|---|
| 32 spaces · 32 tabs · 31-core padded to 35 · 32 × U+00A0 | gateway, usage *(worker and billing already refused)* |
| 32 × U+00AD · 32 × U+0085 · 32 × U+00FF · 32 × U+200B · ASCII + one U+00AD | **all four** |
| **ASCII with an internal TAB** | **all four** — see **F-2** |
| padded-but-valid (the outage value) · internal spaces · plain 32 | none — still boots |

**The error text is byte-identical to the release note.** `diff` of live stdout against
`docs/releases/s-008-timing-safe-internal-auth.md:56` and `:63` returns nothing:

```
Invalid environment configuration for INTERNAL_API_SECRET: String must contain at least 32 character(s)
Invalid environment configuration for INTERNAL_API_SECRET: must contain only printable ASCII characters (U+0020-U+007E)
```

The message names the **variable** and the **rule**. It does **not** name a **remedy** — see
**F-7**. The release note's §2 claim that gateway parses lazily while the other three parse at
module load is **correct**, and I confirmed it independently (`loadEnv()` at
`apps/gateway/src/config/env.ts:41`, called from `app.ts:17`).

### 3.4 All configured sites still pass

I validated **30 sites** against the shipped fragment. **29 pass.** The single failure is the
documented pre-existing one:

```
FAIL  [doc] docs/epics/epic-3-shared-service-infra.md:172  len=25
      -> String must contain at least 32 character(s)
by category: deploy 10/10  setup 3/3  test-constants 16/16  doc 0/1
```

The 10 deployment artifacts are the five `.env.example` files, the four
`docker/docker-compose.yml` service blocks and `.github/workflows/ci.yml`. The 3 are
`apps/{usage,worker,billing}-service/tests/setup.ts`. The 16 test-constant sites carry **15
distinct values** (gateway's `app.hooks.unit:41` and `smoke:23` share one), which is where the
"15" in the hand-off comes from. See **F-3** for a counting defect in the plan's own inventory.

### 3.5 Internal spaces stay legal — confirmed by transit, not only by schema

Through the real proxy to a real upstream:

```
internal single SPACE   transit=true  status=200  newRule=ACCEPT
internal double SPACE   transit=true  status=200  newRule=ACCEPT
internal TAB            transit=true  status=200  newRule=REJECT   <- F-2
```

---

## 4 · Priority 2 — attacking the guard

### 4.1 The latin-1 boundary — re-performed

Re-performed independently against the **real billing guard** (`buildInternalAuthMiddleware`,
imported from source) behind the **real `@fastify/http-proxy`**, each secret the character ×32:

| char | trim leaves | transit byte-identical | real proxy status | new rule |
|---|---|---|---|---|
| **U+0085** | true | **true** | **200** | REJECT |
| **U+00AD** | true | **true** | **200** | REJECT |
| **U+00FF** | true | **true** | **200** | REJECT |
| U+034F | true | never arrived | 500 | REJECT |
| U+180E | true | never arrived | 500 | REJECT |
| U+200B | true | never arrived | 500 | REJECT |
| U+200C | true | never arrived | 500 | REJECT |
| U+200D | true | never arrived | 500 | REJECT |
| U+2060 | true | never arrived | 500 | REJECT |
| U+0100 | true | never arrived | 500 | REJECT |

**The three that authenticate are confirmed: U+0085, U+00AD and U+00FF each arrive
byte-identical and return `200`.** U+00FF is not merely a boundary marker — it authenticates
like the other two, which is what S-8's addendum got wrong three times and what the shipped
docblock now states correctly. **All ten are rejected at startup** by `SECRET_PATTERN`.

### 4.2 Trying to get past the new rule

**The core invariant holds under randomized attack.** 400 random printable-ASCII candidates of
length 32–200, each accepted by the fragment, each sent as its *parsed* value through the real
proxy:

```
accepted by fragment : 400
round-trip mismatches: 0
non-200 statuses     : 0
```

So **for any value the fragment accepts, the parsed output survives transit byte-identically**
and all four services agree. That closes the outage class by construction, not by convention.
The attack I expected to work — a value whose ECMAScript `trim()` strips more than HTTP's
OWS-stripping does, e.g. `NBSP + "a"×32 + NBSP` — **does not work**, because every service
sends and compares the *parsed* (already-trimmed) value, not the raw one. Verified: that value
parses to `"a"×32`, round-trips, and returns `200`.

**One case does get past the rule and behave badly — F-4.** The fragment has no maximum length:

```
8 KB  printable ascii   fragment=ACCEPT len=8192    status=200  round-trips=true
16 KB printable ascii   fragment=ACCEPT len=16384   status=431  round-trips=false
64 KB printable ascii   fragment=ACCEPT len=65536   status=431  round-trips=false
```

**A secret an operator would reasonably deploy and that now fails — F-2:** a passphrase
containing an internal TAB. It transits byte-identically, authenticated `200` before this
change, and is now refused at startup by all four services — while the docblock justifying the
rule cites internal TAB as evidence that internal whitespace is legal.

### 4.3 The phase promotion

Against **both real apps**, unauthenticated (no `X-Internal-Secret`), shipped tree:

| Request | billing `/v1/internal/billing/generate` | worker `/v1/internal/worker/replay` |
|---|---|---|
| valid JSON body | `401 {"code":"UNAUTHORIZED"}` | `401 {"code":"UNAUTHORIZED"}` |
| schema-invalid JSON | `401` | `401` |
| **malformed JSON** | `401` | `401` |
| **no content-type** | `401` | `401` |
| `text/plain` body | `401` | `401` |
| no body at all | `401` | `401` |
| *authenticated* + malformed JSON | `500` (parser now reachable) | `500` |

**Every row collapses to `401` with a byte-identical body.** The authenticated control still
reaches the parser, which proves the guard — not the parser — is what moved.

Under the deliberate revert to `preHandler` (mutation applied, measured, restored byte-identical):

| Request | billing | worker |
|---|---|---|
| malformed JSON | **`500 INTERNAL_ERROR`** `"Body is not valid JSON but content-type is set to 'application/json'"` | same |
| no content-type | **`500 INTERNAL_ERROR`** `"Unsupported Media Type"` | same |
| everything else | `401` | `401` |

So the pre-change leak is real and reproducible, and the fix genuinely closes it. **But billing
exhibits three distinguishable states under the revert, not two — see F-1.**

**Route ordering is intact.** billing's internal scope registers the guard and
`registerInternalBillingRoutes` and **no** tenant-context hook (T-045's contract), so the
promotion cannot disturb hook order there. The tenant-facing scope
(`apps/billing-service/src/app.ts:114-116`) still registers `internalAuth` **then**
`billingTenantContextHandler`, both `onRequest` — the order
`.claude/rules/tenant-isolation.md` § *Forbidden* requires. Unchanged by this diff; billing
231/231 green.

### 4.4 The constant-time claim — I assert none, and here is what I measured

**I do not assert, and do not endorse, any constant-time property for `secretsMatch`.** The
change is scrupulous about this: `packages/shared-utils/src/index.ts:40` says in bold that the
property **"is not established by any test, and should not be claimed from a green suite"**,
and `packages/shared-utils/tests/unit.test.ts:247-252` and both new guard suites say the same.
That is the right standard and it is met.

For completeness, I measured what the change is *for* (20 000 warm iterations, then 200 000
timed):

```
same-length candidates, differing FIRST vs LAST byte
  differs at first byte  2.1017 us
  differs at last byte   2.1707 us      <- the byte-position oracle is gone
```

That is the property `!==` lacked, and it holds. Separately, cost is **linear in the
candidate's length** (32 chars → 2.87 µs; 64 KB → 40.3 µs; 1 MB → 636.6 µs), because the
SHA-256 `update` is. This is **not** a secret-recovery channel — the candidate's length is
attacker-supplied, and what hashing removes is the oracle on the *expected* secret's length,
which is the one the docblock is about. It is recorded as **F-5** only because the docblock's
opening line is an unqualified universal.

**No reader could reasonably infer a *tested* constant-time guarantee** from the shipped text:
every one of the four places that mentions timing explicitly disclaims test evidence.

---

## 5 · Priority 3 — the rework's claims, none of which a gate had seen

### 5.1 HIGH-1's fix — verified, byte-identical

The rework took route **(a)**: the sentence is now in the plan at
`docs/plans/s-008-timing-safe-internal-auth.md:75`, unwrapped, and both redirects
(`.claude/rules/known-gaps.md:1832` and `:2444`) now resolve.

```
$ git show 2cdb140:.claude/rules/known-gaps.md | sed -n '41,42p' | paste -sd' ' -   > src-joined
$ sed -n '75p' docs/plans/s-008-...md | sed 's/^> //'                               > plan-unwrapped
$ diff src-joined plan-unwrapped
(no output)
$ md5sum src-joined plan-unwrapped
3a1cbbb156b5ce521c053ef41947bd3d  src-joined
3a1cbbb156b5ce521c053ef41947bd3d  plan-unwrapped
```

**Byte-identical to the two `2cdb140` source lines joined by a single space.** The quoted
substring occurs exactly once in the plan (`grep -cF` → 1), and the plan explains the
unwrapping and why at `:72-80` — including that a single-line grep matched nothing *in the
original file either*, which is the point. HIGH-1 is discharged.

### 5.2 Six modified test files, zero deletions, all six pass unchanged

`git diff HEAD --numstat` → **`83 0`, `69 0`, `158 0`, `81 0`, `74 0`, `203 0`** — six files,
**zero deleted lines in every one**. Confirmed.

I re-derived **all six** (not just the two asked for) by writing the `2cdb140` version back
over each path, running it **against the shipped source**, then restoring from copy:

| `2cdb140` test file | Result vs shipped source |
|---|---|
| `apps/usage-service/tests/env.schema.unit.test.ts` | **14 / 14** |
| `apps/worker-service/tests/env.schema.unit.test.ts` | **43 / 43** |
| `apps/billing-service/tests/env.schema.unit.test.ts` | **17 / 17** |
| `apps/billing-service/tests/internal-billing.route.test.ts` | **10 / 10** |
| `packages/shared-utils/tests/unit.test.ts` | **18 / 18** |
| `packages/shared-validation/tests/unit.test.ts` | **15 / 15** |

Matches the claimed set `{14, 43, 17, 10, 18, 15}` exactly. All six restored byte-identical
(`md5sum` diff clean). This is genuine backward-compatibility evidence: the shipped source
satisfies every assertion the pre-change suites made.

### 5.3 LOW-2 — re-performed

Mutation: join the two comment lines at
`apps/billing-service/src/middleware/internal-auth.middleware.ts:20-21` onto one line. No
executable character touched — verified by diffing the files with all comment lines stripped
(**empty diff**).

```
this file        : Tests  1 failed | 11 passed (12)   <- byte-matches the documented claim
whole package    : Tests  1 failed | 230 passed (231)
the one red case : BU135 - routes the comparison through the shared timing-safe helper
```

**Confirmed: the reflow reddens `BU135` alone**, in the file and package-wide. Restored;
`md5sum -c` OK; 12/12 green again. The documented trade-off is accurate — this is a
false-*positive* risk only, and a real `!==` regression cannot slip past.

### 5.4 The anti-drift guard is real, not tautological

This is the mechanism that stops the four schemas re-diverging, so I attacked it directly.
Mutation on `apps/gateway/src/config/env.ts`: replace `internalApiSecretSchema` with a
**behaviourally identical** local copy — same constants, same order, same message.

```
× gateway env schema > INTERNAL_API_SECRET derives from the shared fragment
  > declares INTERNAL_API_SECRET as internalApiSecretSchema itself
AssertionError: expected ZodString{ …(26) } to be ZodString{ …(26) } // Object.is equality
Tests  1 failed | 11 passed (12)
```

**It reddens even though behaviour is unchanged** — which is exactly right, and is why a
verdict-equality table would have been the tautology here and an identity assertion is not. All
four services carry it (`usage:254`, `billing:536`, `gateway:122`,
`worker:940` via `innerType()`). Restored; 12/12 green.

The reviewer's deviation ruling #4 ("G1a placed per-service as an identity assertion — accept,
and it is stronger") is correct; I reached it independently.

### 5.5 The undici finding — verified, including the outbound path

Three client shapes, **only two carrying a code**:

```
node:http            -> TypeError            code=ERR_INVALID_CHAR
undici 7.29.0 request() -> InvalidArgumentError code=UND_ERR_INVALID_ARG  msg "invalid x-internal-secret header"
global fetch         -> TypeError            code=undefined
                        "Cannot convert argument to a ByteString because the character at index 0 has a value of 8203…"
```

**The proxy's outbound path is measured, not inferred.** Dumping the error inside
`replyOptions.onError`:

```
constructor: FastifyError
code       : FST_REPLY_FROM_INTERNAL_SERVER_ERROR
message    : invalid x-internal-secret header          <- undici's InvalidArgumentError message verbatim
stack top  : @fastify/reply-from@12.6.4/index.js:208
             @fastify/reply-from@12.6.4/lib/request.js:204
gateway status: 500
```

So `@fastify/http-proxy` reaches undici's `request()`, and the `500` carries undici's message.
Confirmed. (One NIT: the plan's table writes `node:http -> Error`; the constructor is
`TypeError`. See **F-6**.)

### 5.6 S-53 — re-derived at the authoritative-file bar

Every load-bearing claim re-measured on this host:

- `docs/epics/epic-9-analytics-service.md:59` does write
  `DATE_TRUNC('day', period_start AT TIME ZONE 'UTC')`. Confirmed.
- The bucket table, re-run live with `options=-c timezone=…`:

  | Session `TimeZone` | `AT TIME ZONE 'UTC'` on the column | bare column |
  |---|---|---|
  | `UTC` | `2026-01-01 00:00:00+00` | `2026-01-01 00:00:00` |
  | `Asia/Kolkata` | `2026-01-01 00:00:00+05:30` | `2026-01-01 00:00:00` |
  | `America/New_York` | **`2025-12-31 00:00:00-05`** | `2026-01-01 00:00:00` |

  **The previous-day bucket reproduces.** Read-only; evaluates literals; no table touched.
- `grep -c "@@map\|@map" prisma/schema.prisma` → **0**. No `usage_lines` table exists
  (`information_schema.tables` → 0); the real columns are `metricKey`, `periodStart`,
  `periodEnd`, `tenantId`, `billed`. Both snake_case claims hold.
- `grep -c TimeZone apps/analytics-service/src/repositories/base.repository.ts` → **0**, so the
  predicate half of the entry holds too (S-19).

**S-53 is sound**, correctly scoped ("three session zones, one value, this host's PostgreSQL
16"), and the two findings beyond the plan are both verified.

### 5.7 The other two authoritative-file edits

`.claude/rules/tenant-isolation.md` — every claim it adds is one I verified independently:
three guards, all `onRequest`, all `secretsMatch`; `/health` exempt by allowlist in usage and
structurally in the other two; non-string rejected; the `preHandler` measurement; four services
deriving from one object; S-8 removed from the read-list and S-9 retained.

`docs/reviewer-checklist.md` — all four rewritten rows check out
(`ls apps/*/src/middleware/internal-auth.middleware.ts` → **3**;
`grep -rln INTERNAL_API_SECRET apps/*/src/config/env.ts` → **4**).

---

## 6 · Defects

### F-1 · MEDIUM · billing's guard docblock says "Two distinguishable states"; three are measurable

**Location:** `apps/billing-service/src/middleware/internal-auth.middleware.ts:51` and
`apps/billing-service/src/app.ts:67`.

Both say *"Two distinguishable states for a caller holding no secret."* and enumerate only the
valid/schema-invalid `401` and the malformed-JSON `500`. Worker's parallel docblock
(`apps/worker-service/src/middleware/internal-auth.middleware.ts:44`,
`apps/worker-service/src/app.ts:65`) says **"Three"** and names the third: a body with no
content-type → `500 INTERNAL_ERROR "Unsupported Media Type"`.

**Reproduction** — revert billing's internal scope to `preHandler` and inject with no secret:

```
perl -0pi -e 's/internalRoutes\.addHook\("onRequest", internalAuth\);/internalRoutes.addHook("preHandler", internalAuth);/' apps/billing-service/src/app.ts
# then app.inject POST /v1/internal/billing/generate with no x-internal-secret:
  malformed JSON  -> 500 {"code":"INTERNAL_ERROR","message":"Body is not valid JSON but content-type…"}
  no content-type -> 500 {"code":"INTERNAL_ERROR","message":"Unsupported Media Type"}
  everything else -> 401
```

billing behaves **identically to worker** — three states, not two. The two sibling comments
describe the same mechanism and disagree on the count; the omitted row is exactly the one
worker names. Same shape as S-33. The undercount is in the conservative direction (the fix
closes all three regardless), but it is a measured claim beside security-relevant code that is
wrong, which `.claude/rules/review-standards.md` § *Claims the Change Makes* puts at MEDIUM.

**Fix:** change "Two" to "Three" in both billing locations and add the `"Unsupported Media
Type"` row, matching worker's wording. Comment-only — but note it will trip `BU135`'s text
assertion only if it touches the `!==` line, which it does not.

### F-2 · MEDIUM · The `SECRET_PATTERN` docblock cites internal TAB as proof that internal whitespace is legal; the shipped rule rejects it

**Location:** `packages/shared-types/src/index.ts`, the `SECRET_PATTERN` docblock:

> `\x20` (SPACE) is deliberately **inside** the range. […] measured over a real socket at
> fastify 5.10.0, an internal single space, an internal double space **and an internal TAB** all
> arrive byte-identical and uncollapsed, **so internal whitespace is transmissible and is a legal
> secret.**

**The measurement is right and the conclusion is wrong for one of its three members.**
Reproduction, through the real proxy to a real upstream:

```
internal single SPACE   transit=true  status=200  newRule=ACCEPT
internal double SPACE   transit=true  status=200  newRule=ACCEPT
internal TAB            transit=true  status=200  newRule=REJECT
```

TAB is `\x09`, outside `[\x20-\x7E]`, so an ASCII secret containing an internal TAB is
**newly refused at startup by all four services** — a class that booted on all four before this
change. The comment that explains the rule tells an operator hitting that boot-break that
internal whitespace is fine.

The release note is **not** affected: §1 says "Internal **spaces** are legal" and "what is now
rejected is … any non-printable or non-ASCII character", both accurate. The defect is confined
to the code docblock, which is the copy a future maintainer reads.

This also raises a genuine question about intended behaviour — see **D-1**.

**Fix (documentation only):** narrow the sentence to *"an internal single space and an internal
double space arrive byte-identical and uncollapsed, so internal **spaces** are transmissible and
are a legal secret; an internal TAB also transmits but is deliberately excluded by this pattern"*
— or change the rule, per D-1.

### F-3 · LOW · The plan's configured-secret inventory undercounts, because its stated grep cannot match a `const` declaration

**Location:** `docs/plans/s-008-timing-safe-internal-auth.md:580-602` (§5) and `:1305-1320` (A10),
both of which total **20 sites** ("Test literals and constants — 7 sites").

The stated pattern is `grep -rn "INTERNAL_API_SECRET[:=]"`. A character class immediately after
the name cannot match `const VALID_INTERNAL_API_SECRET = "…"` (space before `=`), nor any
constant named something else. Re-running it and diffing against a declaration-shaped grep:

```
$ grep -rnE '(const|let)\s+\w*SECRET\w*\s*=\s*"' apps/*/tests packages/*/tests | grep -vE 'INTERNAL_API_SECRET[:=]'
  -> 13 value-bearing secret constants the plan's pattern cannot see
     incl. gateway/tests/env.schema.unit.test.ts:35, packages/shared-utils/tests/unit.test.ts:259,
     billing+worker tests/internal-auth.middleware.unit.test.ts (all three added by THIS diff)
```

**The conclusion is unaffected** — I validated all 13 and every one passes. Three of the missed
sites are files this change itself created, so the inventory could not have been complete as
written. Note also that the hand-off's "29" and the plan's "20" and my 30 differ by whether you
count sites or distinct values; the plan should say which. S-33 family.

**Fix:** re-run with `INTERNAL_API_SECRET\s*[:=]` plus a declaration-shaped pattern, and state
sites-vs-distinct-values explicitly.

### F-4 · LOW · The shared fragment has no maximum length, so one bad class still fails at request time rather than at startup

**Location:** `packages/shared-validation/src/index.ts`, `internalApiSecretSchema`.

```
8 KB  printable ascii   fragment=ACCEPT  status=200  round-trips=true
16 KB printable ascii   fragment=ACCEPT  status=431  round-trips=false
64 KB printable ascii   fragment=ACCEPT  status=431  round-trips=false
```

A 16 KB printable-ASCII secret passes the new rule, the service starts, and then **every
proxied request fails `431 Request Header Fields Too Large`** — the upstream never sees the
header. That is precisely the failure shape (a service that looks healthy and rejects
everything) the change's own release note §4 says it is retiring.

**Not a regression** — the old `.min(32)` had no ceiling either — and not a plausible
deployment. Recorded because the change's stated premise is "one declaration of what a valid
secret is", and the declaration is silent on the one dimension that still fails late.

**Fix direction:** add `.max(…)` to the fragment (Node's default `maxHeaderSize` is 16 384
bytes, so anything comfortably under it works), or record it as accepted in
`.claude/rules/known-gaps.md`.

### F-5 · LOW · `secretsMatch`'s opening line is an unqualified universal that the body then disclaims

**Location:** `packages/shared-utils/src/index.ts:24` — *"Constant-time equality for two secrets
of unknown length."*

Line 40 of the same docblock disclaims test evidence in bold, which is exactly right. But the
heading is a universal of the kind `.claude/rules/review-standards.md` § *Universals Must Cite
Their Mutation* asks to cite a mutation or be weakened. Measured:

```
same length, first-vs-last differing byte : 2.1017 us vs 2.1707 us   <- indistinguishable, good
candidate length 32 / 1 KB / 64 KB / 1 MB : 2.87 / 3.20 / 40.34 / 636.59 us   <- linear
```

`secretsMatch` is constant-time **in content at fixed length** and linear in the candidate's
length. The body's own sentence is careful — it scopes the property to *"the comparison"*, i.e.
`timingSafeEqual`, which is accurate — so nothing is false. The heading is simply broader than
anything established. **Not a security problem**: the candidate's length is attacker-supplied,
and the oracle hashing removes is on the *expected* secret's length.

**Fix:** *"Length-independent-precondition equality for two secrets, comparing fixed-width
digests"*, or add "(of the comparison step; the digest step is linear in input length)".

### F-6 · NIT · The plan's client-shape table writes `Error` where the constructor is `TypeError`

**Location:** `docs/plans/s-008-timing-safe-internal-auth.md:1200`, `node:http -> Error  code
ERR_INVALID_CHAR`. Measured constructor is **`TypeError`**. The adjacent rows name
`InvalidArgumentError` and `TypeError`, so the column is constructor names and this row is
inconsistent. `TypeError` *is* an `Error`, so nothing is false; the release note does not repeat
it.

### F-7 · NIT · The startup error names the variable and the rule but not the remedy

Measured on all four services. An operator paged at 03:00 gets
`… must contain only printable ASCII characters (U+0020-U+007E)` and no pointer to the fix. The
remedy (`openssl rand -base64 48 | tr -d '\n'`, rolled to all four) exists only in
`docs/releases/s-008-timing-safe-internal-auth.md` §3, which they have to know to look for.
Mitigated by the release note being unusually good. Optional.

### F-8 · Observation · The `buildXApp({ internalApiSecret })` override bypasses the fragment entirely

`apps/billing-service/tests/smoke.test.ts:18` and `apps/worker-service/tests/smoke.test.ts:18`
both build with `internalApiSecret: "test-secret"` — 11 characters, which the fragment rejects.
Both `app.ts` files guard only **blank** (`if (!internalApiSecret.trim()) throw
InternalApiSecretMissingError`), not short or non-ASCII. This is **documented** in both guard
docblocks ("`app.ts` also accepts an explicit unvalidated override, which the smoke suite
uses"), so it is honest and intentional, and usage-service has no such path at all. Recorded so
that "one declaration of what a valid secret is" is not read as covering every entry point.

### F-9 · Observation · Stale build output under `packages/shared-validation/dist/`

The `rootDir: "." → "../.."` change moves emission to `dist/packages/shared-validation/src/`,
leaving the pre-change `dist/src/index.js` (no `internalApiSecretSchema`) behind. `dist` is
gitignored and every package resolves through `main: "src/index.ts"`, so no consumer reaches
either, and a clean checkout is unaffected. The reviewer already ruled on the `rootDir` change
(deviation #2) and `shared-utils` has carried `rootDir: "../.."` since `e9d2c1a`, so this is
precedent-following. Noted only because S-17 already records stale `dist` declarations in
`shared-utils` as a source of confusion, and this makes two packages with that shape.

---

## 7 · Decision for the user

### D-1 · Should an internal TAB be a legal `INTERNAL_API_SECRET`?

`SECRET_PATTERN` is `/^[\x20-\x7E]+$/`, so TAB (`\x09`) is excluded. An ASCII secret containing
an internal TAB booted on all four services before this change, transits byte-identically, and
authenticated `200` — and now refuses to start everywhere. The docblock that justifies the rule
cites internal TAB as evidence that internal whitespace is legal (**F-2**), so the code and its
own justification disagree.

| Option | What changes | Diff impact |
|---|---|---|
| **A · Keep the rule, fix the comment** | Narrow the docblock sentence to "internal **spaces**", and note TAB transmits but is deliberately excluded | **Comment only.** No behaviour change, no test change |
| **B · Keep the rule, fix the comment, and call out TAB in the release note** | As A, plus a line in §1 of the release note naming internal TAB as a value that will newly refuse to start | Comment + release note. No behaviour change |
| **C · Admit TAB into the pattern** | `/^[\x09\x20-\x7E]+$/` (or `[\x20-\x7E\t]`) so the rule matches RFC 9110's `field-value`, which permits HTAB | Changes the fragment, its message, and needs a new accept case in the shared-validation suite plus the four env suites' tables |

**Recommendation: B.** The rule as shipped is the safer one — a TAB inside a secret is
invisible in every config UI and every `echo`, and it is the kind of value that produces exactly
the silent split S-8 exists to end. The behaviour is right; only the comment over-promises. B
costs one more line than A and closes the operator-facing half, which matters because this is
the one newly-breaking class that hits **all four** services and is **not** invisible-character
garbage — it is a secret somebody may have deliberately typed.

**A and B change no code and no test. C changes the diff** and would need its own coverage.

---

## 8 · What I exercised, and how the tree was protected

Every mutation below was made on a **copy-backed** file, measured, then restored by `cp` and
verified by checksum. **No `git checkout --`, `git restore` or `git stash` was used on any
tracked file.** `git status --porcelain | wc -l` was **30 before and 30 after**, and the final
checksums of all five touched files match their pre-mutation values.

| Mutation | Purpose | Result | Restored |
|---|---|---|---|
| `onRequest` → `preHandler`, billing + worker `app.ts` | Prove the phase promotion is load-bearing | 3 distinguishable states reappear on both | md5 match |
| Rewrap guard docblock, billing middleware | Re-perform LOW-2 | `1 failed \| 11 passed (12)`; `BU135` alone | `md5sum -c` OK |
| Inline a behaviourally-identical schema copy, gateway `env.ts` | Prove the anti-drift assertion is not tautological | 1 failed, identity case only | `md5sum -c` OK |
| Six `2cdb140` test files written over their paths | Prove backward compatibility | 14/43/17/10/18/15, all pass | all six md5 match |

Also exercised: full 13-package gate with `--force` (0 cached on every task); `pnpm test:smoke`;
the outage reproduction through a real `@fastify/http-proxy`; the latin-1 probe through the real
billing guard; a 400-candidate randomized round-trip sweep; live boot-drives of all four real
env modules across seven value classes; live PostgreSQL `DATE_TRUNC` re-derivation for S-53;
byte-comparison of the release note's error strings against live stdout.

## 9 · What I could not validate, and why

- **Any real deployment's secret.** The 29-site inventory covers this repository only. The
  release note says so itself and supplies an operator check; I verified that check's logic
  matches the shipped fragment but could not run it against production.
- **The constant-time property itself.** Not measurable to a defensible standard in this
  environment, and the change correctly declines to claim it. My timing numbers (§4.4) are
  indicative, taken on a shared host, and should not be quoted as a guarantee in either
  direction.
- **Any transport other than the two probed.** All transit results are `node:http`, undici
  7.29.0 and Node 22.22.2's global `fetch`, through fastify 5.10.0 and
  `@fastify/http-proxy` 11.6.1 configured as `proxy.plugin.ts` configures it. **No browser,
  forward proxy, load balancer, service mesh or managed ingress was in the path of anything
  here**, and any of those could normalize a header differently. The change's own scope notes
  say this; I am repeating it because F-2's and §4.2's conclusions depend on it.
- **`set-cookie`'s array-valued path.** The duplicated-header arm is unreachable through both
  transports I tried; the documented array-valued exception was not probed, matching the
  change's own stated scope.
- **A real rolling deploy.** The release note's claim that mixed versions interoperate for a
  valid secret follows from the schemas and the round-trip sweep, but no two-version deployment
  was actually run.
- **`.github/workflows/ci.yml` end to end.** I validated the secret it sets, not a CI run.
- **`pnpm format:check`.** Not run; S-12 records that it cannot pass on any revision.

## 10 · Regression risk across the 13 packages

The public API of all three changed shared packages is **purely additive** — `git diff HEAD`
shows only two deleted lines in their sources, both reformatting
(`SECRET_MIN_LENGTH: 32` gaining a comma, and the `createHash` import gaining
`timingSafeEqual`). No export removed, no signature changed.

| Surface | Risk | Evidence |
|---|---|---|
| `@telemetry/shared-types` (+`SECRET_PATTERN`, `SECRET_PATTERN_MESSAGE`) | **None** | Additive; 8/8 green; consumed by all 6 services |
| `@telemetry/shared-utils` (+`secretsMatch`) | **None** | Additive; 26/26; six consumers all green |
| `@telemetry/shared-validation` (+fragment, +`@telemetry/shared-types` dep) | **Low** | No dependency cycle (`shared-types` has no `dependencies`); six consumers green; `rootDir` change reaches no consumer (F-9) |
| gateway / usage / worker / billing env schemas | **Low, intended** | The boot-break is the change; delta table in §3.3; all 29 configured sites pass |
| billing + worker hook phase | **None observed** | billing 231/231, worker 251/251; tenant-facing ordering unchanged and re-asserted |
| auth-service, analytics-service, web, shared-config, shared-logger, shared-tracing | **None** | Untouched by the diff; 166/166, 18/18, —, 4/4, 4/4, 2/2 |

**Breaking-change assessment:** the only breaking change is deliberate and operational — a
service whose deployed `INTERNAL_API_SECRET` fails the new rule will not start. It is
documented, the error is byte-accurate, and the failure is at startup rather than in traffic,
with the single exception in **F-4**. Rollback is unconditional (no migration, no schema change,
no persisted state), which I confirmed by inspection of the diff: nothing under `prisma/`
changed.

**Recommended for `.claude/rules/known-gaps.md`:** **F-4** (no maximum length) and, if D-1
resolves to A or B, a short note that internal TAB is excluded by design — both are out of scope
for a fix here.

---

## Verdict

# PASS

S-8 is fully closed, item by item, against its deleted text; the outage it describes reproduces
on `2cdb140` and is gone on the shipped tree; the boot-break is real, bounded, accurately
documented and byte-identical to its release note; the anti-drift guard reddens under a
behaviourally-identical mutation; all 13 packages are green with `--force` and 0 cached, 1028
tests, plus 7 smoke tests; and the environment is exactly as I found it.

**F-1 and F-2 are MEDIUM and should be fixed before commit** — both are comment-only edits, and
`.claude/rules/review-standards.md` treats a false measured claim beside security code at that
severity. Neither affects behaviour, which is why they do not fail the gate. **D-1 needs a
user answer**, though options A and B change no code.
