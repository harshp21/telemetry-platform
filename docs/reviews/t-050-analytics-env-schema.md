# Senior Review — T-050 · Analytics service env schema

## Round 1

**Gate 4 (pre-QA).** Base `493e699`; nothing committed or staged.
**Verdict: CONDITIONAL** — two LOW fixes, both one-line edits to text (no source or test
change). No BLOCKER, HIGH or MEDIUM finding. The security posture is unchanged by this diff:
it touches no query, no middleware, no role and no raw SQL.

**Rules revision read from disk, not from the injected copy.** `.claude/rules/known-gaps.md`
on disk is `493e699` plus this diff: **3 624 lines**, running **S-5 … S-55**, with **S-8
absent** (deleted by `493e699`; confirmed with `git show HEAD:.claude/rules/known-gaps.md |
grep -c '^## S-8 '` → `0`, and present at `HEAD~1`). The copy injected into this session ended
at **S-39** and **still contained S-8** — S-24's twenty-fifth firing this session, and this
review is written against the `cat`ed text throughout.

---

## Findings

### LOW-1 · The same measured fact is stated weakly twice and as an unqualified universal once

`apps/analytics-service/tests/env.schema.unit.test.ts:265` reads:

> `artifacts, nothing reads the parsed `env.PORT`, and analytics' smoke test listens on port`

That is the strong form. The two other places in the diff that state the same fact both use the
measured form, correctly:

- `apps/analytics-service/src/config/env.ts:7` — "**No read of the parsed `env.PORT` was
  found** under `apps/<service>/src` or `packages/<pkg>/src`".
- `.claude/rules/known-gaps.md`, S-55 finding 3 — "No *statically spelled* read of the parsed
  value exists under those two search roots. It does **not** exclude a computed property name,
  a spread … or a read from outside those roots."

The plan is explicit that the weak form is the one that belongs in code
(`docs/plans/t-050-analytics-env-schema.md:305-307`: "The weaker, true statement is what
belongs in the code comment"). The test file is code, and it carries the stronger claim.

It is load-bearing, not decorative: that sentence is the justification for *not* pinning the
two test fixtures (`apps/analytics-service/tests/setup.ts:3`,
`apps/gateway/tests/env.schema.unit.test.ts:66`). If the parsed value were read somewhere, the
not-pinning decision would be wrong.

**Fix:** at `tests/env.schema.unit.test.ts:265`, change `nothing reads the parsed `env.PORT``
to `no read of the parsed `env.PORT` was found under `apps/*/src` or `packages/*/src``.

### LOW-2 · The plan's `git grep -n "3005"` count is stale by exactly one, and the extra line is the diff's own

`docs/plans/t-050-analytics-env-schema.md:258` reads:

> `git grep -n "3005"` over the whole repository returns **14 lines** (P3).

Re-derived on the delivered tree: **15**. The fifteenth is
`.claude/rules/known-gaps.md:3571` — the S-55 table row `| analytics | derives (`:21`) |
derives (`:20`) | `3005` (`:3`) | **1** | n/a — T-050 |`, which slice 4 added. Confirmed it is
diff-added: `git show HEAD:.claude/rules/known-gaps.md | grep -c "3005"` → `0`.

This is the **S-33 self-match**, inside the commit that handles the identical pattern correctly
twenty lines away: S-55 finding 3 says of its own grep "this grep matches its own subject — the
self-match sub-pattern S-33 names, and the reason the count moved from 10 to 12 inside T-050's
own commit. Count the binds, not the lines." The `3005` count got no such treatment.

The *classification* beneath it (5 deploy sites / 6 numbers, 2 source constants, 2 test
fixtures, 5 prose) is correct and unaffected — it sums to 14 and is a complete account of
everything outside `.claude/rules/`.

Related, same passage: "**Source constants (2):** `src/constants.ts:12`, `src/startup.constants.ts:3`"
is the **pre-fix** tree. On the delivered tree `src/constants.ts` holds no `3005` at all (it
derives, at `:20`). §5.1 is a problem statement and reads correctly as one, but it presents
`git grep` in the present tense without saying which tree.

**Fix:** at `:258`, either "returns **15 lines** — 14 outside `.claude/rules/`, plus S-55's own
table row (S-33 self-match)", or "returned **14 lines** on the pre-fix tree". Either discharges
it; the first is preferable because it is re-runnable.

### NIT-1 · The plan's approval-gate section is stale against its own checklist

`docs/plans/t-050-analytics-env-schema.md:583` still reads "**Stopping here for approval. No
production code and no tests have been written.**", while §11 marks every slice `[done]`. Same
residual shape S-32 records for epic-7: correct text below, wrong text above, and a reader
landing on `:583` first. **Fix:** add "— superseded at Gate 3; see §11" to `:583`, or move §12
under a `Gate 2 (historical)` heading.

### NIT-2 · The gateway field-count correction splits a sentence

`:344` still reads "gateway's `EnvSchema` has **13** fields, not six … and" and the correction
block (`:347-354`) is inserted *between* that clause and its continuation at `:355` ("its
*suite* asserts **only** `INTERNAL_API_SECRET`"). Keeping the wrong numeral visible with the
correction adjacent is the right call per S-33 and I am not asking for it to be deleted — but
the interpolation makes the host sentence unparseable. **Fix:** move the block quote to after
`:358`, so the original sentence closes before the correction begins.

### NIT-3 · The S-19 citation-rot note records one of the two that rotted

`:188` names `invoice.repository.ts:94` → `:367` only. The plan's own P8 (`:738-753`) shows
`event.repository.ts:64` → `:73` as well. Re-derived both:

```
apps/billing-service/src/repositories/invoice.repository.ts:367:export class InvoiceRepository extends TenantScopedRepository {
apps/worker-service/src/repositories/event.repository.ts:73:export class EventRepository extends TenantScopedRepository {
```

The "third time the column has rotted" claim at `:190` checks out for the invoice citation
(S-19 records `:87` → `:92` → `:94`, now `:367`). **Fix:** add the second citation to `:188`,
or say "both citations in S-19's table have moved (`:367`, `:73`)".

### NIT-4 · `COMPOSE_ANALYTICS_SERVICE_KEY` is a third copy of `"analytics-service"` — disposition: keep

`tests/env.schema.unit.test.ts:125` declares `const COMPOSE_ANALYTICS_SERVICE_KEY =
"analytics-service"`, while `src/constants.ts:3` (`ANALYTICS_SERVICE_NAME`) and
`src/startup.constants.ts:2` (`SERVICE_NAME`) already hold that string — the latter two
pre-existing at HEAD.

**Disposition: keep as written, no change requested.** `apps/billing-service/tests/env.schema.unit.test.ts:84`
is byte-for-byte the same shape (`COMPOSE_BILLING_SERVICE_KEY = "billing-service"` alongside an
importable `BILLING_SERVICE_NAME`), so this mirrors the precedent the plan committed to. More
substantively, a compose YAML service key and a service's identity constant are different
domains that happen to agree; coupling them would encode an invariant nobody has decided.
Recorded so the clean-code gate is visibly discharged rather than skipped.

### Observation · "cannot pass silently" at `:323` is bounded by its regex

The AC3b exhaustiveness comment (`:319-323`) says adding a consumer without adding it to
`COMPOSE_ANALYTICS_CONSUMER_SERVICE_KEYS` "cannot pass silently". Measured: it does redden (see
M7b below). The bound is the pattern `/^ +ANALYTICS_SERVICE_URL:/gm` — a consumer added with a
different YAML spelling (inline mapping, `env_file`, an anchor) would not match and would pass.
Not worth a fix; noted so the universal is read at its measured strength.

---

## Priority 1 — the toothless guard, re-performed

**The case is genuinely toothless for the internal property, and the file says so where a
reader meets it.**

Mutation **M2** — `apps/analytics-service/src/startup.constants.ts:3` `DEFAULT_PORT: 3005` →
`9999`, applied alone, restored by file copy:

```
× ... > pins DEFAULT_PORT to the port every deploy artifact publishes
  → expected '3005' to be '9999'
  Tests  1 failed | 11 passed (12)
```

`defaults PORT to the port index.ts binds` stayed **green**. Both of its assertions became
9999-vs-9999, exactly as disclosed. This reproduces T-044's Gate-5 finding on this service.

The disclosure is in the right place and at the right strength.
`tests/env.schema.unit.test.ts:198-203` sits directly above the case, says "**AC2, the second
assertion**, no longer guards the number and must not be read as if it did", and cites the
mutation that establishes it (billing's Gate 5). It scopes the claim to the *second assertion*
rather than to the case — which is correct, and I tested the distinction:

Mutation **M8** — both files restored to their HEAD content (the genuine unfixed tree):

```
× ... > defaults PORT to the port index.ts binds
  → expected 3000 to be 3005 // Object.is equality
  Tests  1 failed | 11 passed (12)
```

So the case as a whole retains teeth against an `env.ts` regression; only the second assertion
is inert. The comment's exact wording covers this.

**The "regains teeth only if someone reintroduces a literal *and* gives it a different value"
clause is also true**, tested both ways (mutation **M6**, `src/constants.ts:20`):

| `ANALYTICS_RUNTIME.DEFAULT_PORT` | result |
|---|---|
| `ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT` (shipped) | `12 passed (12)` |
| literal `3005` (same value) | `12 passed (12)` — still inert |
| literal `3000` (different value) | `Tests 1 failed \| 11 passed (12)`, `expected 3000 to be 3005` |

### Does the artifact pin cover the gap? Yes — four of the seven mutations re-run

Each applied alone, restored by file copy, re-run with
`pnpm --filter @telemetry/analytics-service exec vitest run tests/env.schema.unit.test.ts`:

| # | Mutation | Result |
|---|---|---|
| M2 | `startup.constants.ts:3` → 9999 | `1 failed \| 11 passed (12)`, `expected '3005' to be '9999'` |
| M3 | **zero-match** — `apps/analytics-service/.env.example` `PORT=3005` line deleted | `1 failed \| 11 passed (12)`, `Error: Expected exactly one PORT= line in apps/analytics-service/.env.example; found 0. The artifact moved or was reformatted -- fix the locator, do not delete the assertion.` |
| M4 | `apps/gateway/.env.example:24` → 9999 | `1 failed \| 11 passed (12)`, `expected '9999' to be '3005'` |
| M5 | `docker/docker-compose.yml:132` → `"9999:3005"` | `1 failed \| 11 passed (12)`, `expected '9999' to be '3005'` |
| M7b | `ANALYTICS_SERVICE_URL` added to worker-service's compose block | `1 failed \| 11 passed (12)`, `expected [ Array(2) ] to have a length of 1 but got 2` |

Every one reddened the **artifact case alone**, at the count and with the message the file
claims. The zero-match case (M3) confirms `extractSoleMatch` throws rather than passing on an
empty match set — the property `.claude/rules/testing.md` requires and the one the whole design
rests on.

Incidental, and in the change's favour: an earlier attempt (**M7a**) added the second
`ANALYTICS_SERVICE_URL` inside gateway's *own* block. That was caught by the block-scoped
locator (`Expected exactly one ANALYTICS_SERVICE_URL in docker-compose.yml gateway environment;
found 2`) rather than by AC3b, so the two guards are independent rather than redundant.

### Ruling on the strength of "unrepresentable internally, pinned externally"

**No sentence claims more than was measured.** The diff nowhere uses "unrepresentable",
"cannot diverge" or "single source of truth" about the port. The strongest formulation is
`tests/env.schema.unit.test.ts:200-201` — "both sides are one expression and the line **cannot
fail while that derivation stands**" — which is a universal carrying (a) its own qualifier, (b)
a cited mutation, and (c) a named escape condition. It satisfies the *Universals Must Cite
Their Mutation* gate, and I reproduced it independently rather than taking it on the citation.
The scope paragraph at `:258-260` ("seven single-artifact mutations against this one suite on
this tree … not a claim that every possible reformatting of these artifacts reddens") is
correctly weak.

The one overstatement in the diff is LOW-1, and it is about a *different* claim.

---

## Priority 2 — the three plan corrections, verified

**1 · Gateway's `EnvSchema` has 14 fields.** Re-derived with `Object.keys(EnvSchema.shape)`
through a throwaway vitest probe (removed afterwards):

```
GWCOUNT= 14 ["NODE_ENV","PORT","REDIS_URL","OTEL_EXPORTER_OTLP_ENDPOINT","LOG_LEVEL",
"JWT_SECRET","INTERNAL_API_SECRET","AUTH_SERVICE_URL","USAGE_SERVICE_URL",
"BILLING_SERVICE_URL","ANALYTICS_SERVICE_URL","RATE_LIMIT_MAX","RATE_LIMIT_WINDOW_MS",
"INGESTION_RATE_LIMIT_MAX"]
```

The plan's own enumeration (4 service URLs + 3 rate limits + 7 others) sums to 14, so the
numeral was wrong and the prose right — exactly as the correction block states. The two
supporting measurements in the same paragraph also re-derive: `loadEnv` at
`apps/gateway/src/config/env.ts:41`, and `grep -n "PORT" apps/gateway/tests/env.schema.unit.test.ts`
matches **one** line, `:59`, which is `OTEL_EXPORTER_OTLP_ENDPOINT`. Recorded as a correction
rather than silently edited, per S-33. **Correct.** (See NIT-2 on placement.)

**2 · `grep -rn "3005" apps/analytics-service/src` returns 2.** Re-derived:

```
apps/analytics-service/src/startup.constants.ts:3:  DEFAULT_PORT: 3005,
apps/analytics-service/src/config/env.ts:13:  // 3005.
```

One executable occurrence, one prose line in `env.ts`'s own docblock. The comparison to
billing holds: `grep -rn "3004" apps/billing-service/src` returns **3** — one executable
(`startup.constants.ts:3`) and **two** comment lines (`constants.ts:286`, `config/env.ts:11`).
So analytics ends one comment line lighter than billing, which is what the plan says. **Correct.**

**3 · S-55's correction to the plan's D1 bullet — all four services re-derived.** From
`grep -n "PORT:" apps/*/src/config/env.ts | grep -v EXPORTER`,
`grep -n "DEFAULT_PORT" apps/*/src/startup.constants.ts` and
`grep -rn "DEFAULT_PORT" apps/*/src/constants.ts`:

| Service | `config/env.ts` | `constants.ts` | `startup.constants.ts` | literals | agree? |
|---|---|---|---|---|---|
| analytics | derives `:21` | derives `:20` | `3005` `:3` | 1 | n/a (T-050) |
| billing | derives `:12` | derives `:290` | `3004` `:3` | 1 | n/a (T-044) |
| auth | derives from `AUTH_RUNTIME` `:11` | `3001` `:157` | `3001` `:3` | 2 | yes |
| worker | derives `:12` | `3003` `:44` | `3003` `:3` | 2 | yes |
| gateway | `3100` `:7` | `3100` `:72` | `3100` `:3` | 3 | yes |
| usage | `3000` `:8` | `3002` `:102` | `3002` `:3` | 3 | **no** |

Every cell matches S-55's table, line number for line number. **Gateway writes it three times
and auth two** — the plan's D1 bullet had them reversed, and **worker was omitted**, so it is
**four** services holding unlinked literals, not two. The correction is right and the entry
carries it. Auth's row is correctly flagged as a different *direction* of derivation
(`env.ts` → `constants.ts` rather than → `startup.constants.ts`) and as a divergence, not a
defect — its two literals do agree.

---

## Priority 3 — S-55 at the authoritative-file bar

I found **no false claim** in S-55. Each of its three findings was re-derived by command.

**Finding 1 — usage-service.** `apps/usage-service/src/config/env.ts:8` is
`.default(3000)`. `git grep -n "3002"` puts it at the five non-test sites carrying six numbers
the entry lists, at the exact line numbers cited (`.env.example:6`, `docker-compose.yml:92`,
`:95`, `:187`, `apps/gateway/.env.example:22`), plus `src/constants.ts:102`,
`src/startup.constants.ts:3` and `tests/setup.ts:3`. `apps/usage-service/src/index.ts:56` binds
`Number(process.env.PORT ?? USAGE_SERVICE_STARTUP.DEFAULT_PORT)`. The fix-direction warning
about usage's own fixture is correct:
`apps/usage-service/tests/env.schema.unit.test.ts:25` is `PORT: "3000"` — the wrong default
written a second time.

**Finding 2 — the six-row table.** Every row verified above. The claim "**every value in the
four rows above agrees with itself**" holds per row; only usage's disagrees.

**Finding 3 — the greps, and the self-match.** Re-derived:

- `grep -rn "env\.PORT\|\.PORT\b"` over `apps/*/src` and `packages/*/src`, `--include='*.ts'`,
  `dist/` filtered → **12** lines: six binds (analytics `:56`, auth `:56`, billing `:56`,
  usage `:56`, gateway `:55`, worker `:276`) and six comment lines, two each in analytics',
  billing's and worker's `config/env.ts`. Line numbers exact.
- Against `HEAD` (via `git archive`), the same grep → **10**. So the "moved from 10 to 12
  inside T-050's own commit" claim is **measured true**, and the two extra lines are the
  comment this diff added to analytics' `env.ts`.
- `grep -rnE "\[[[:space:]]*[\"']PORT[\"'][[:space:]]*\]"` → nothing, exit 1.
- `grep -ci "nothing.*reads the parsed\|no read of the parsed" apps/*/src/config/env.ts` →
  `1` for analytics, billing, worker; `0` for auth, gateway, usage. Exact.

**Ruling on the self-match: handled correctly.** The entry names the pattern (S-33), explains
*why* its own subject matches its own grep, and tells the reader the durable instruction —
"Count the binds, not the lines." That is the right remedy: it makes the claim re-derivable
without depending on a numeral that the next comment edit will move.

**One thing I checked that S-55 did not claim, and it passes.** A negative grep is only
evidence if the pattern works. I built a positive control
(`const a = env["PORT"]; const b = env[ 'PORT' ];`) and ran **both** spellings against it —
S-55's ERE form *and* the plan's BRE `\s` form at `:297`. Both matched both lines. So the empty
result on the real tree is a real negative, not a broken regex.

**The scope caveat is present and correctly weak** — "It does **not** exclude a computed
property name, a spread of the whole `env` object …, or a read from outside those roots. Stated
as measured rather than as 'nothing reads it'." Corroborated independently:
`apps/analytics-service/src/config/container.ts` takes the whole `ServiceEnv` and reads only
`env.REDIS_URL` (`:22` — the sole `env.` reference in the file).

---

## Priority 4 — verify, don't accept

**The one confirmed red — reproduced twice.** Against the genuine unfixed source (both
`src/config/env.ts` and `src/constants.ts` restored to HEAD content):

```
× analytics-service env schema > core infrastructure configuration > defaults PORT to the port index.ts binds
  → expected 3000 to be 3005 // Object.is equality
Tests  1 failed | 11 passed (12)
```

Identical under the narrower mutation (env.ts alone). **No sentence in the diff overstates the
red count.** I read every red/green claim in the plan and the test:

- `tests/env.schema.unit.test.ts:21-25`: "exactly **one** assertion was red on the unfixed tree
  … Every other case passed before the source changed. They are regression guards … what
  [testing.md] forbids is claiming they went red." Precise, and precise in the harder way —
  *one assertion*, not one case, which is the correct unit given the second assertion was
  3005-vs-3005 on the unfixed tree too.
- Plan `:434-438`: "'18 → N tests, 1 confirmed red' is the truthful sentence, not 'the new
  suite was confirmed red'." Written into the plan as an instruction.
- Plan `:567`: verbatim split `Tests  1 failed | 11 passed (12)`. Matches.
- Plan `:575-576`: "**one** case confirmed red; the other 11 green from the start, each
  labelled in the file." Matches; each of the eleven carries a `Green from the start` label.

**`startup.constants.ts` stays side-effect-free.** `grep -c "^import" apps/*/src/startup.constants.ts`
→ `0` for **all six** services (auth, gateway, usage, analytics, worker, billing). The
derivation direction is *into* `env.ts` and `constants.ts` and never out, so the tracing
ordering is preserved.

**`index.ts` was not touched and `env.PORT` was not wired in.** `git diff --stat` lists three
files; `apps/analytics-service/src/index.ts` is not among them. The file still imports exactly
two modules (`@telemetry/shared-tracing`, `./startup.constants`), calls `initTracing(...)` at
`:18`, reaches `./app` through `await import("./app")` at `:22`, and binds
`Number(process.env.PORT ?? ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT)` at `:56`.

**P5 re-run on my own fixture**, four `.mjs` files, Node **v22.22.2** (confirmed with
`node --version`). Output reproduced byte-for-byte:

```
A. static import of the heavy module (proposed wiring):
  [heavy module body evaluated]
  [initTracing(analytics-service) called]
  [after initTracing] heavy = 1
B. dynamic import after initTracing (index.ts as it stands):
  [initTracing(analytics-service) called]
  [heavy module body evaluated]
  [after initTracing] heavy = 1
```

**The scope caveat survives, in both places it needs to.** Plan `:330-333` and P5 `:706-707`:
"plain ESM on one Node version, one static and one dynamic import … not a claim about tsx,
about bundlers, or about which spans would be lost." S-55 finding 3's fix direction carries the
same caveat. Nothing anywhere upgrades it.

**Constants gate.** The new suite writes **no** bare `3005`: every reference is
`ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT`, including the fractional-port fixture, which is built
as `` `${String(...DEFAULT_PORT)}${FRACTIONAL_PORT_SUFFIX}` `` specifically to avoid a second
spelling of the number. Defaults are named (`DEFAULT_NODE_ENV`, `DEFAULT_LOG_LEVEL`,
`UNKNOWN_NODE_ENV`), invalid ports are a keyed object with the measured rejection reason on
each, and the compose keys are named constants. No HTTP status or route literal appears. The
base-env DSN/URL literals match billing's suite exactly. Only NIT-4 above, disposition keep.

**Q3, S-9, S-19, S-53, S-54.** Each mentioned once in the plan's non-goals with its reason and
the task it belongs to; none touched. Spot-checked the two claims that could have been wrong:
`apps/analytics-service/src/middleware/index.ts` is literally `export {};` (so S-9 has no guard
to feed and a declared secret would be inert — the exact shape `493e699` spent a commit
unpicking), and `grep -rn "3005\|analytics" docker/prometheus` → no match, exit 1. S-53's and
S-54's titles on disk match what the plan says they are.

**Ruling on leaving S-19 alone: correct, no action.** Its citations have rotted again
(`invoice.repository.ts:94` → `:367`, `event.repository.ts:64` → `:73`, re-derived above), but
the entry is explicitly dated ("Line numbers are as of the T-045 tree") and explicitly
self-immunizing ("Re-run the grep rather than trusting the column"), so it is *stale*, not
*false*. Editing another service's gap entry inside an analytics env-schema commit is the
one-task-per-commit objection S-19 itself records. The plan notes the drift in passing, which
is the right amount of attention. See NIT-3 for the one-citation-of-two incompleteness.

---

## Compile-time gate — actual output, all 13 packages

Run with `--force` on the restored tree (`npx turbo run <task> --force`), after all mutations
were reverted and the tree confirmed byte-identical by `cmp` on every file I touched.

| Task | Result | Cache |
|---|---|---|
| `typecheck` | **13 successful, 13 total** | `0 cached, 13 total` |
| `lint` | **13 successful, 13 total** | `0 cached, 13 total` |
| `build` | **13 successful, 13 total** | `0 cached, 13 total` |
| `test` | **13 successful, 13 total** | `0 cached, 13 total` |

`0 cached` on every task confirms the gate was re-run, not reprinted.

**Per-package test totals, and the root derived by me:**

| Package | Tests |
|---|---|
| analytics-service | **30** |
| auth-service | 166 |
| billing-service | 231 |
| gateway | 50 |
| shared-config | 4 |
| shared-logger | 4 |
| shared-tracing | 2 |
| shared-types | 8 |
| shared-utils | 26 |
| shared-validation | 30 |
| usage-service | 238 |
| worker-service | 251 |
| web | — (`vitest run --passWithNoTests`, no cases) |
| **Root** | **1040** |

Summed independently from the log rather than taken from the implementer's report: **1040**,
matching the claim. Analytics baseline re-measured by removing the new file and re-running:
**18 passed (18)** → **30** with it, so 1028 → 1040 is exact.

`pnpm test:smoke` (no `--force`, which is not a turbo task here): **6 services, 7 tests, all
passing**, exit 0.

**Lint warnings: 14, every one pre-existing, proven.**

| Count | Rule | File | `git log -1` |
|---|---|---|---|
| 10 | `@typescript-eslint/no-misused-promises` | `apps/auth-service/tests/auth.service.unit.test.ts` | `d68e719` Tue Aug 25 2026 |
| 4 | `@typescript-eslint/no-unsafe-assignment` | `apps/usage-service/tests/ingestion.service.unit.test.ts` | `b0f6921` Mon Aug 31 2026 |

`grep -c "no-unsafe-return"` over the gate log → **0**, as expected. Neither file appears in
`git status --porcelain`, so neither is attributable to this change. **No warning is newly
introduced and none is waved through as pre-existing without proof.** 0 errors across all four
tasks.

---

## What I verified

- Rules text read from disk (`cat`/`sed`), not the injected copy; revision stated above.
- Both source diffs and the whole 12-case test file read in full.
- The confirmed red, twice, including once against genuine HEAD source for both files.
- Six mutations re-performed (M2, M3, M4, M5, M6, M7a/M7b, M8), each applied alone and restored
  by file copy — never `git checkout`, `git restore` or `git stash`.
- Gateway's 14 `EnvSchema` fields by `Object.keys(EnvSchema.shape)` at runtime.
- All six services' port declarations, at the line numbers S-55 cites.
- The 10 → 12 grep movement, by running the grep against a `git archive` of HEAD.
- Both dynamic-index grep spellings against a positive control before trusting the negative.
- The P5 ESM ordering on my own fixture, Node v22.22.2.
- `startup.constants.ts` import-free for all six services.
- epic-9's snippet: six fields, same names, same order, PORT default 3005 — so "the only field
  that diverged was PORT" is exact.
- All six deploy-artifact sites and both deliberately-unpinned fixtures.
- Full gate `--force` × 4 tasks × 13 packages, plus smoke, plus warning provenance.
- End state: `Tenant` = 2; `Event`, `UsageLine`, `Invoice`, `InvoiceLineItem`, `RefreshToken`
  all **0**. `v1_7` not rolled back, no role dropped, Postgres and Redis left running.

## What I could not verify, and why

- **The two mutations I did not re-run** — "compose gateway `ANALYTICS_SERVICE_URL` → 9999" and
  "analytics `.env.example` PORT → 9999". Both are the same locator shape as M4/M5, which I did
  run and which behaved as the table says. Taken as **corroborated by analogy, not measured**.
- **Any runtime behaviour of the port.** Nothing in this diff or this review starts analytics
  on 3005 or proxies a request to it. The pin is a text-comparison guard; that the process
  *binds* 3005 is established by reading `index.ts:56`, not by observing a socket.
- **Whether the six comment lines stay accurate.** LOW-2's whole point is that a comment count
  moves inside the commit that edits it; nothing mechanical enforces any of the numerals in
  S-55 or the test docstring. S-33's proposed checker would catch the command-backed ones.
- **`docker compose up`.** Not run — it would build 7 images and bind host ports. The compose
  assertions are textual, which is what the case claims to be.
- **Redis db 0 sits at `DBSIZE` 3.** Unchanged by me; it is auth-service's TTL'd denylist
  residue from the mandated `pnpm test` run, which S-22 documents as pre-existing. I wrote
  nothing to db 0.

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| A future edit reintroduces a literal in `constants.ts` **with the same value** and AC2 stays inert | **Accepted, documented.** Measured (M6). The artifact case pins the number against five files the constant cannot reach into; `ANALYTICS_RUNTIME.DEFAULT_PORT` itself is then only reachable via `smoke.test.ts:10` in `SMOKE_TARGET=external` mode. No fix requested. |
| A consumer added to compose in a YAML form the regex misses | **Accepted.** Bounded by `/^ +ANALYTICS_SERVICE_URL:/gm`; today's file uses one form throughout. Noted in Observation above. |
| usage-service's identical 3000-vs-3002 divergence remains | **Recorded, not fixed** — S-55 finding 1. Correct call: fixing it here puts another service's startup contract in an analytics commit. |
| Four services still hold 2–3 unlinked port literals | **Recorded** — S-55 finding 2. One task, not six opportunistic edits. |
| S-19's line citations rotted a third/fourth time | **Leave.** Entry is dated and self-immunizing. NIT-3 asks only that the plan's note name both. |
| S-9 (no internal auth on analytics) still open | **Correct to leave.** No guard exists to feed and no tenant-scoped route lands until T-051, which S-9's own fix direction names as the moment to add it. |
| S-24 fired again on this review's own inputs | **No new gap needed** — S-24 covers it. Recorded here as the twenty-fifth sighting, with the working practice followed (`cat` from disk, revision stated). |

No gap discovered during this review is out of scope and unrecorded; S-55 already covers the
residue, and LOW-1/LOW-2 are in-diff text fixes rather than gaps.

---

## Verdict

**CONDITIONAL.**

Required before commit — both are one-line text edits; neither touches source, tests or
behaviour, so the gate does not need re-running for them:

1. **LOW-1** — `apps/analytics-service/tests/env.schema.unit.test.ts:265`: replace
   `nothing reads the parsed `env.PORT`` with `no read of the parsed `env.PORT` was found under
   `apps/*/src` or `packages/*/src``, matching `src/config/env.ts:7` and S-55.
2. **LOW-2** — `docs/plans/t-050-analytics-env-schema.md:258`: correct `returns **14 lines**`
   to `returns **15 lines** — 14 outside `.claude/rules/`, plus S-55's own table row (S-33
   self-match)`, or re-date it to the pre-fix tree.

NIT-1 through NIT-4 are optional and may be declined without a further round.

The engineering is sound and unusually well evidenced. The change fixes a real declaration/
deployment contradiction, does it by derivation rather than by copying the number, disclosed
the guard it renders inert instead of letting a reviewer find it, and backed the replacement
guard with mutations that each reddened it alone. S-55 re-derived clean at the authoritative-
file bar — 100% of its command-backed claims reproduced, including the line numbers.
