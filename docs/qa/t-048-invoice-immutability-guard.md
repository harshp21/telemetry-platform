# T-048 · Invoice immutability guard — QA Tester (Gate 5)

**Verdict: PASS**, with two LOW text corrections required before commit (F-2, F-3) and one
finding recommended for `.claude/rules/known-gaps.md` (F-1b).

- **Base**: `a87d952`, T-048 uncommitted, **11** `git status` entries at start and at end.
- **Scope**: independent validation. I wrote no production code and no permanent test. Every
  mutation below was reverted and the tree proven restored (§ *Tree integrity*).
- **Gate**: full workspace, `--force`, run **twice** — once before any probe, once after the
  tree was restored. Identical both times.

---

## Rules revision actually read

`.claude/rules/known-gaps.md` read **from disk** with `md5sum`/`grep`/`sed`, not from context:

- **3 313 lines**, md5 `85a60bf3a8db9476030acfd185ab3f76`, working-tree (modified) on top of
  `a87d952`, running to **S-50**.
- `grep -oE '^## S-[0-9]+'` returns S-5 … S-50 with S-7, S-18, S-31 retired.

**The copy injected into this session's context ended at S-39.** It could not see S-40, S-46,
S-48, S-49 or S-50 — five of which this task edits. **S-24, seventeenth sighting.** Every
citation in this report was re-read against disk.

---

## Environment baseline

Captured **before** the first gate run and re-checked at the end.

| Subject | Start | End | Note |
|---|---|---|---|
| `Tenant` | **2** | **2** | S-20 residue, untouched |
| `Event` / `UsageLine` / `Invoice` / `InvoiceLineItem` / `Meter` | **0** | **0** | every fixture removed |
| Redis db 0 `DBSIZE` | **2** | **2** | `telemetry:events` + one TTL'd `denylist:*` |
| `git status` entries | 11 | 11 | same eleven paths |
| `git worktree list` | 1 (main) | 1 (main) | Round 2's NIT-1 `base-wt` is gone |

**No drift to report.** The baseline matched the stated expectation exactly.

Redis db 0 rose 2 → 3 during the gate and fell back to 2: TTL'd `denylist:<jti>` keys written by
auth-service's integration suite, self-expiring. That is **S-22**, attributable and not T-048's.
I wrote nothing to db 0, rolled back no migration, dropped no role and created no trigger. All
five roles intact and `NOSUPERUSER NOBYPASSRLS`; `v1_7` present.

---

## Gate — all 13 packages, `--force`, nothing cached

`pnpm build --force` does not forward the flag, so build was run as `npx turbo run build --force`.

| Task | Command | Result |
|---|---|---|
| typecheck | `npx turbo run typecheck --force` | **13 successful, 13 total · 0 cached** |
| lint | `npx turbo run lint --force` | **13 successful, 13 total · 0 cached** · 14 warnings, 0 errors |
| build | `npx turbo run build --force` | **13 successful, 13 total · 0 cached** |
| test | `npx turbo run test --force` | **13 successful, 13 total · 0 cached** |

**Per-package test totals** — twelve report, `@telemetry/web` contributes 0:

| Package | Files | Tests |
|---|---|---|
| `@telemetry/shared-types` | 1 | 8 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/usage-service` | 19 | 230 |
| **`@telemetry/billing-service`** | **19** | **213** |
| `@telemetry/auth-service` | 15 | 166 |
| `@telemetry/worker-service` | 17 | 234 |
| `@telemetry/web` | — | 0 |
| **Total** | 88 | **950** |

Billing **213** and root **950** as stated. `pnpm test:smoke` — 6 suites, 7 tests, all passing.
**Worker's `I24` did not flake** on either full run, so no per-package re-run was needed.

**The 14 lint warnings are pre-existing, and I derived the provenance rather than accepting it:**

- 10 × `@typescript-eslint/no-misused-promises` — `apps/auth-service/tests/auth.service.unit.test.ts`,
  last touched `d68e719` (2026-08-25).
- 4 × `@typescript-eslint/no-unsafe-assignment` — `apps/usage-service/tests/ingestion.service.unit.test.ts`,
  last touched `b0f6921` (2026-08-31).
- **Zero `no-unsafe-return`**, as expected.
- `git diff --name-only` confirms **neither file is in the T-048 diff**.

---

## Priority 1 — writing a `FINALIZED` invoice past the guard

### 1a · The behavioural half — the guard holds

Four cases of my own, against the real repository and a live database, seeded through
`DIRECT_DATABASE_URL` and asserted through `telemetry_app`. All four passed.

| Case | What it drove | Result |
|---|---|---|
| **QA1** | `POST /v1/internal/billing/generate` against a `FINALIZED` invoice | `409` · `INVOICE_IMMUTABLE` · body `Invoice is not a draft and cannot be modified (status FINALIZED)` |
| **QA2** | `InvoiceRepository.absorbLateUsage` directly | `InvoiceImmutableError`, transaction logged as rolled back |
| **QA3** | the `PAID` sibling over HTTP | `409` · `INVOICE_IMMUTABLE` |
| **QA4** | five repeated attempts | `409` every time, no state drift |

In every case, read back afterwards: **total unchanged**, `status` unchanged, **zero line
items**, and the late `UsageLine` still `billed = false`. The refusal is transactional end to
end — the `transaction_rollback` log line fires and nothing partial is observable.

### 1b · The adversarial half — I got past both censuses

I constructed four evasions the review had not. Each was applied, measured, and reverted.

| Probe | Form | `tsc` | `BU125` | `BU126` |
|---|---|---|---|---|
| **E1** | import alias — `import type { FullTransactionClient as Widened }`, then `as unknown as Widened` inside an existing method | **0** | **green** | **green** |
| **E2** | **type annotation** — `const full: FullTransactionClient = tx as never;` | **0** | **green** | **green** |
| **E3** | E2 inside a **non-`async`** private accessor, a second doorway beside the seam | **0** | **green** | **green** — whole census file **37/37** |
| **E4b** | E3 plus a public `finalizeInvoice` writing `status: "FINALIZED"`, with the new name added to `EXPECTED_PUBLIC_ASYNC_METHODS` | **0** | **green** | **green** — whole package **213/213**, lint clean |

E1 and E2 each show **2 red cases — `BU16` and `BU17`**, and those are *not* guards firing: the
failure text is `TypeError: tx.invoice.updateMany is not a function` from a behavioural double
that does not mock the method. That is the same collateral the Round-2 `reinterpret<T>`
measurement recorded. A developer adding a real feature fixes the mock and the redness goes away.

**Runtime proof that this is not a compile-time curiosity.** With E3's doorway wired to a writer
that restates an already-issued invoice, against the live database as `telemetry_app`:

```
QA5 before:        FINALIZED 7
QA5 rows updated:  1
QA5 after:         FINALIZED 99999
```

A `FINALIZED` invoice's total went **7 → 99999**, through code that typechecks at 0 diagnostics,
passes lint, and leaves the whole billing package at 213/213.

**How this bears on the verdict.** It does **not** exceed the task's declared guarantee. The
shipped hedge predicts it almost exactly — `invoice.repository.ts`'s `invoiceDelegate` docblock
says *"a tripwire over an enumerated set, not a proof … A fifth spelling would still be missed"*,
and the `BU125` declaration docblock names *"a new alias, a helper that launders the type, a
`satisfies` form"*. E1 is literally "a new alias". So the documentation is honest and I did not
find an overclaim in it. What I found is **one datum no document carries** — F-1b below.

### 1c · The censuses, verified by construction

**`BU125`'s four cast targets** — each inserted alone into an existing method body:

| Cast target | Caught by `BU125`? |
|---|---|
| `tx as unknown as FullTransactionClient` | **yes** |
| `tx as unknown as PrismaClient` | **yes** |
| `tx.invoice as unknown as Prisma.InvoiceDelegate` | **yes** |
| `tx as any` | **yes** |

**`BU125`'s helper throws rather than passing vacuously** (`.claude/rules/testing.md`). Renaming
`invoiceDelegate` gives `Error: Expected to find private invoiceDelegate( in
repositories/invoice.repository.ts` — a loud failure, not a silent zero.

**`BU126`'s third list fires loudly.** Adding `protected async probeProtected()` produces
`expected [] to deeply equal [ "protected async probeProtected" ]` — the member is *named with
its modifier*, not dropped. This is Round 1's HIGH-1 genuinely closed.

---

## Priority 2 — the type-level census

**Re-derived from the generated client**, not from the alias, with `ts.createProgram` over
`apps/billing-service/tsconfig.json` and `checker.getPropertiesOfType`:

| Type | Members | Index signatures |
|---|---|---|
| `PrismaClient["invoice"]` | **18** | `[symbol]` |
| `FullTransactionClient["invoice"]` | **18** | `[symbol]` |
| `TransactionClient["invoice"]` (narrowed) | **9** | `[symbol]` |

The nine that survive are exactly `aggregate, count, fields, findFirst, findFirstOrThrow,
findMany, findUnique, findUniqueOrThrow, groupBy`. **18 and 9 both confirmed.**

**Mutated both ways**, whole package `tsc --noEmit`:

| Mutation | Result |
|---|---|
| add `"probeFutureWrite"` to `InvoiceWriteMethod` | `error TS2344: Type 'false' does not satisfy the constraint 'true'` |
| delete `"groupBy"` from `InvoiceReadMethod` | `error TS2344: Type 'false' does not satisfy the constraint 'true'` |

Both land on the `InvoiceDelegateSurfaceCensus` declaration (`base.repository.ts:92`); the line
number shifts ±1 with the edit, which is the edit's own doing.

**The bare-`keyof` claim is true and load-bearing.** Replacing
`Extract<keyof FullTransactionClient["invoice"], string>` with a bare `keyof` gives the same
`TS2344` **on the unmutated tree** — the generated `InvoiceDelegate` declares
`[K: symbol]: { types: ... }` at `.prisma/client/index.d.ts:8972`, which I confirmed is the
**exact** line. `Extract` is what makes the census work, and the docblock's account of why is
correct.

### Ruling — is `base.repository.ts` the right home?

**Right today, wrong long-term, and the diff handles it correctly.** The census constrains
`FullTransactionClient["invoice"]`, which is declared in that file, so co-locating the assertion
with the type it guards is correct — moving it to `tests/` would put a `tsc`-time guard where
`vitest` runs, and `BU125`/`BU126` already cover what source text can cover.

The cost is real and is S-19's: billing's copy is now a **fourth variant** of a five-copy class.
Re-derived — `md5sum apps/*/src/repositories/base.repository.ts`:

- billing `eebd37628f6e20e17fa5e7140221c47b`, **262 lines** (was `13a533a2…`, 111)
- analytics and worker `13a533a2e2c2dcc1ff9db28fb5c7a1fd`, 111 each — still byte-identical
- auth `8b12b7d596af50a038f5a79c1361b8a5`, 118 · usage `d2e8d92fd494fb779f4dea7238273b4a`, 124

S-19 is edited in this diff, states the new digest rather than predicting it, and correctly
**stays open**. The subclass table correctly gains no row. I confirm all of that.

**Forward obligation to record when S-19's unification lands:** the narrowed set is
**billing-specific** — only billing narrows `invoice`. A shared `@telemetry/shared-db` cannot
carry this `TransactionClient` as-is, and the census must be re-derived per service rather than
moved wholesale. That is not in S-19 today.

---

## Priority 3 — the rework's claims

Every one of these reproduced.

**Citation form.** `grep -c "invoice.repository.ts:[0-9]" .claude/rules/known-gaps.md` → **0**.
At `a87d952` the same grep returned **4** (four lines carrying eight citations). Three spot-checks
by running the entry's own command:

| Entry | Its command | Resolves |
|---|---|---|
| S-19 | `grep -rn "extends TenantScopedRepository" apps/*/src` \| `export class` | `export class InvoiceRepository` at `:355` — symbol cited, not the number |
| S-40 | `grep -n "skip: (query.page - 1) * query.pageSize"` | `:814` |
| S-48 | `grep -n "markUsageLinesBilled"` | declaration at `:563` |
| S-49 | `grep -rn "invoiceLineItem\." apps/*/src --include=*.ts` | exactly **5** comments — `:679`, `:694`, `:696` in `absorbLateUsage`'s docblock, `:855`, `:881` in `findDetailById`'s. The **3 + 2** attribution is correct |

S-19's three line-numbered subclass rows (`usage.repository.ts:150`, `event.repository.ts:73`,
`meter.repository.ts:35`) are each **exact**.

**The counts.**

| Figure | Claimed | Measured |
|---|---|---|
| working-tree total | 19 | **19** ✓ |
| comments | 10 | **10** ✓ |
| declarations / reads / DDL | 9 | **9** ✓ |
| **assignments** | **zero** | **zero** ✓ |
| `a87d952` total | 14 | **14** ✓ |
| added / removed | six / one | **does not reproduce — F-2** |

I classified all 19 lines individually rather than trusting the split. The ten comments and the
nine declarations/reads/DDL are exact, and **zero assignments** holds: nothing in `src/` or
`prisma/` writes `Invoice.status` or `finalizedAt`. `invoice.repository.ts:829` and `:919` assign
`finalizedAt` into a *response object*, which is a read.

**Stability.** Re-running the grep after my own session's edits-to-nothing returns 19 every time.
That specific claim holds — but see F-5 for what it is worth.

**MEDIUM-3 — six sites in five files.** All six carry the `src/`-and-`prisma/` scope:
epic `:234`, `errors/index.ts:132-133`, `invoice.repository.ts:504`,
`billing.integration.test.ts:818`, and the two the review never listed —
`integration.constants.ts:233` (`FINALIZED_TOTAL`) and `:249` (`PAID_TOTAL`). **No "anywhere"
universal survives as a live claim.** Four occurrences of the word remain
(`integration.constants.ts:238`, epic `:246`, `billing.integration.test.ts:822` and `:890`) and
every one is an explicitly-labelled quotation of the superseded wording it refutes.

**The `seedInvoices` grep.** `grep -rEn "status: InvoiceStatus\.(FINALIZED|PAID)"
apps/billing-service/tests` → **17**. The BRE spelling (same pattern, no `-E`) → **0**, so the
recorded trap reproduces. Of the 17, **six** are in `billing.integration.test.ts` at **five**
`seedInvoices` call sites (`:848`, `:909`, `:1319`+`:1327` in one call, `:1420`, `:1469`); the
other 11 are query filters and in-memory doubles across four files and write nothing. Exact.

**The RLS execution.** As `telemetry_app`, with `rolsuper = f` and `rolbypassrls = f` read from
`pg_roles` **on the probing connection**, inside one `ROLLBACK`ed transaction after
`set_config('app.tenant_id', <A>, true)`:

| Statement | Rows |
|---|---|
| cross-tenant `UPDATE "Invoice" … WHERE "tenantId" = <B>` | **0** |
| same-tenant `UPDATE … WHERE "tenantId" = <A>` | **1** |
| blanket `UPDATE "Invoice" SET status = 'FINALIZED'` — no `WHERE` | **1, not 2** |

All three reproduce. And the blanket statement **succeeded** in setting `FINALIZED` on the
tenant's own row, which is the point: **RLS bounds the tenant dimension and not the status
dimension**, so the raw route bypasses the status seam and not tenant isolation. Probe rows
deleted, counts re-checked.

**The mutation totals** — Round 2 did not re-run these this round, reasoning that nothing the
text-only rework touched affects them. **I checked that reasoning by re-running both**, whole
package:

| Mutation | Claimed | Measured | Named set |
|---|---|---|---|
| M1 — delete the `DRAFT` guard | `5 failed \| 208 passed (213)` | **identical** | BI23, BI34, BU100, BU123, BU124 — exact |
| M2 — invert `!==` to `===` | `14 failed \| 199 passed (213)` | **identical** | BI22–BI27, BI34, BU98–BU101, BU123, BU124, BU127 — exact, all 14 |

**The reasoning was sound.** Both totals and both named sets reproduce on the shipped tree.

**Step A** reproduced faithfully against the `a87d952` repository files with the wholesale
`Omit`: **11 errors — 7 × `TS2339`, 2 × `TS2345`, 2 × `TS7006`.** Composition of the seven
measured line by line, which is F-3.

---

## Acceptance criteria

Each walked against the plan's §7.4 mapping and checked for non-vacuity.

| AC | Proven by | Would it fail if the behaviour broke? |
|---|---|---|
| **AC1** — non-`DRAFT` refuses with `409 INVOICE_IMMUTABLE`, nothing written | BU123, BU124, BI23, BI34 | **Yes** — M1 reddens exactly BI23/BI34/BU100/BU123/BU124 |
| **AC2** — enforcement at the repository, not the controller | BU123/BU124 assert at the repository; BU102b shows the controller only surfaces it | **Yes** — my QA2 drove the repository directly and got the refusal |
| **AC3** — "no code path can accidentally modify a finalized invoice" | BU125 + the P-G1/P-G2 transcript, stated in the honest form | **Partly, and correctly scoped** — the naive bypass is `TS2339`; the enumerated casts are caught (verified, four for four); a non-enumerated widening is not (F-1) and the docs say so |
| **AC4** — `DRAFT` invoices remain mutable | BU127, BI22, BI25 | **Yes** — M2 (inverting the guard) reddens all of them |
| **AC5** — T-049's "update `FINALIZED` → `409`" | BI23 (`FINALIZED`), BI34 (`PAID`) | **Yes** — both red under M1 |

**No tautological test found.** The two census cases read `src/` off disk rather than echoing a
mock, and both were shown to fail loudly on a missing subject. BU123 asserts *what the seam
judged* (the `where` shape, the two selected columns, the absence of the other tenant id), not
merely that an error was thrown. BU127 asserts read-before-write ordering via
`invocationCallOrder`, which a refuse-everything seam could not satisfy.

**One honest limit, which the diff states repeatedly and I confirm:** none of these cases proves
*production* behaviour. Nothing in `src/` or `prisma/` can produce a non-`DRAFT` status, so every
case seeds it through the owner connection or a double. The change says so in six places.

---

## Defects

### F-1 · The censuses are evaded by a widening carried in a type annotation — **MEDIUM, within the declared guarantee**

`apps/billing-service/src/repositories/base.repository.ts` (`TransactionClient` docblock) ·
`apps/billing-service/src/repositories/invoice.repository.ts` (`invoiceDelegate` docblock) ·
`apps/billing-service/tests/invoice.repository.unit.test.ts` (`FULL_DELEGATE_CAST_PATTERNS`)

**Reproduction.** In any existing method of `InvoiceRepository`:

```ts
const full: FullTransactionClient = tx as never;
await full.invoice.updateMany({ where: {}, data: { status: "FINALIZED" } });
```

`pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json` → **0 errors**.
`BU125` and `BU126` both **green**. Put the same two lines in a **non-`async`** private accessor
and the whole census file is **37/37**; add a public writer that calls it and add its name to
`EXPECTED_PUBLIC_ASYNC_METHODS`, and the whole package is **213/213** with lint clean. Driven
against the live database, it took a `FINALIZED` invoice's total from 7 to 99999.

`BU125` matches only `as [unknown as] {FullTransactionClient | PrismaClient | Prisma.*Delegate |
any}`. Here the widening is in the **annotation** and the cast goes to `never`, which no pattern
names.

**Disposition: not a documentation defect, and not a blocker.** The shipped hedges predict this
("a tripwire over an enumerated set, not a proof"; "a fifth spelling would still be missed"; "a
new alias"). The guarantee was declared weak and it is weak in exactly the declared way. Recorded
so the next reader has the measurement rather than the prediction.

### F-1b · `BU126` censuses member *names*, not guardedness — the natural fix discharges it — **recommend for `known-gaps.md`**

The half of F-1 that **no document discusses**. When a developer adds a writer, `BU126` goes red
with `expected [Array(7)] to deeply equal [Array(8)]`. The obvious, correct-looking response —
add the new method's name to `EXPECTED_PUBLIC_ASYNC_METHODS` — is a one-line edit that makes the
census green again **without the new writer having gone through the seam**. Measured: package
213/213 with an unguarded `finalizeInvoice` present and its name listed.

So `BU126` is a *notification* that the member set changed, not a guard that the member set is
safe. That is inherent to a name census and is not fixable inside T-048; what is missing is the
sentence saying so, next to the list, so the next person to append a name knows what they are
discharging.

### F-2 · "six comment lines added and one removed" does not reproduce under any consistent rule — **LOW**

`apps/billing-service/src/errors/index.ts` (the *"T-048 added six comment lines and removed
one"* sentence) · `apps/billing-service/src/repositories/invoice.repository.ts`
(`draftInvoiceWriter` docblock, same sentence) · plan §12.5 and §13.2

**Reproduction.** Per-file match counts, `a87d952` (via `git archive`, no worktree registered)
against the working tree:

| File | a87d952 | now | delta |
|---|---|---|---|
| `src/constants.ts` | 0 | 1 | **+1** |
| `src/errors/index.ts` | 3 | 3 | **0** |
| `src/repositories/base.repository.ts` | 0 | 1 | **+1** |
| `src/repositories/invoice.repository.ts` | 5 | 8 | **+3** |
| others (validator, schema, migration) | 6 | 6 | 0 |

Two accountings are self-consistent and **neither is "six / one"**:

- **5 added, 0 removed** (14 + 5 = 19) — counting the two `errors/index.ts` lines that were
  *reworded in place* as neither added nor removed.
- **7 added, 2 removed** (14 + 7 − 2 = 19) — `comm` over normalised text, counting each reword
  as one removal plus one addition.

"Six / one" counts **one** of the two reworded `errors/index.ts` lines as add-plus-remove and the
other as neither. All three arithmetics land on 19, which is why it survived.

**Everything load-bearing is correct** — 19, 10 comments, 9 declarations/reads/DDL, and **zero
assignments** all reproduce exactly, hand-checked across all 19 lines. This is the fourth
derivation of the added/removed split and the fourth time it has been wrong.

**Concrete fix:** drop the split and keep *"19 matching lines, 10 comments, 9 declarations, reads
and DDL, **zero assignments**; 14 on `a87d952`"*. The split has never survived a re-derivation and
nothing rests on it.

### F-3 · The plan says all seven `TS2339` in step A were legitimate reads; two were the writers — **LOW**

`docs/plans/t-048-invoice-immutability-guard.md:100`, `:250`, `:395`, `:590`
(the shipped docblock at `apps/billing-service/src/repositories/base.repository.ts:145-148`
is **correct** and disagrees with the plan)

**Reproduction.** Restore the two repository files to `a87d952`, add `| "invoice"` to
`TransactionClient`'s `Omit`, run `tsc --noEmit -p tsconfig.json`. **11 errors: 7 × `TS2339`,
2 × `TS2345`, 2 × `TS7006`** — the totals are exact. The seven `TS2339` sites:

| Line | Statement | Kind |
|---|---|---|
| `:336` | `tx.invoice.findUnique(` | read |
| `:445` | `tx.invoice.create(` | **writer** |
| `:595` | `tx.invoice.findUniqueOrThrow(` | read |
| `:604` | `tx.invoice.update(` | **writer** |
| `:654` | `tx.invoice.findMany(` | read |
| `:662` | `tx.invoice.count(` | read |
| `:740` | `tx.invoice.findFirst(` | read |

**Five reads and two writers**, exactly as `base.repository.ts:146` says. The plan's "7 × TS2339
on legitimate reads" overstates the collateral damage of the wholesale `Omit` — it broke five
things it should not have and two it should. The conclusion (not viable) is unaffected, but the
plan ships in the same commit, and `base.repository.ts` and the plan currently contradict each
other in four places.

**Concrete fix:** make the plan's four sites read *"7 × `TS2339`, five of them legitimate reads
and two the writers"*, matching the docblock.

### F-4 · `BI23`'s "this test's own fixture block below" does not survive extraction, and fails silently — **LOW** (Priority-4 question: settled, **no**)

`apps/billing-service/tests/billing.integration.test.ts:822` (BI23's comment) and `:890`
(BI34's docblock, *"six … all in this file"*)

**Reproduction.** Rewire BI23's own `seedInvoices([...])` block to a parameterised helper
(`seedStatusInvoice(InvoiceStatus.FINALIZED, …)`), which is an ordinary refactor. The documented
grep `grep -rEn "status: InvoiceStatus\.(FINALIZED|PAID)" apps/billing-service/tests` goes
**17 → 16**, and the `seedInvoices` figure would drop from six to five — while the number of
tests that seed a non-`DRAFT` status is **unchanged**.

So the count does not self-correct on re-derivation: it **under-reports**, silently, and the
phrase "this test's own fixture block below" becomes false. The grep is a census of a *literal
spelling*, not of the writes.

### F-5 · The self-match stability property is incidental to the current wording — **LOW, informational**

Priority-4 question: **yes**, future wording can reintroduce it, trivially.

**Reproduction.** Add one ordinary sentence mentioning `FINALIZED` to any existing docblock the
grep reads: the count goes **19 → 20**. Reverted, it returns to 19.

The claim *"the corrected sentences were written so that re-running the grep does not change the
count"* is true **of those sentences**, and is a property of their phrasing, not a structural
guard. Nothing stops the next edit from reintroducing the self-match. This is the argument for
F-2's fix direction: keep "zero assignments", drop the arithmetic.

---

## Coverage gaps

1. **The seam's read is not locking.** `draftInvoiceWriter` does
   `findUniqueOrThrow` then `update` in one transaction with no `FOR UPDATE`. Under Prisma's
   default isolation, two concurrent callers could both read `DRAFT` and both write. **Latent
   only** — nothing on the platform can finalize an invoice, so the interleaving is unreachable
   today. Sibling of **S-38**, which records the same shape for `createDraftInvoice`'s `P2002`
   path. **Recommend for `.claude/rules/known-gaps.md`**, to be settled by whichever task builds
   invoice finalization. Not in scope here.
2. **No concurrency case at all** over the refusal path. Consistent with S-38's reasoning that a
   naive `Promise.all` test can pass vacuously; recorded rather than demanded.
3. **`createDraftInvoice` is outside the status guard by design (D5)** and no test asserts that
   it *stays* outside for the stated reason. `BU126` makes the exception visible; nothing pins
   the rationale. Acceptable — the property asserted is the narrower true one.
4. **No boundary case on a fourth `InvoiceStatus`.** `BU124` handles this well: it asserts the
   non-`DRAFT` set the schema declares today and goes red when a migration adds to it. Good
   design; no gap.
5. **`InvoiceLineItem` remains without RLS (S-10)**; `BI9`/`BI32` still stand as markers and the
   seam correctly does not touch that delegate. Unchanged by T-048, as scoped.

---

## Regression risk across the other 12 packages

**None found.** The change is confined to `apps/billing-service` plus three records.

- `base.repository.ts` is billing's **own copy**; the other four services' copies are
  byte-unchanged, confirmed by `md5sum` (analytics and worker still identical at `13a533a2…`).
- `TransactionClient` and `FullTransactionClient` are not exported outside billing:
  no package imports them.
- `markUsageLinesBilled`'s parameter narrowed to `Omit<Prisma.TransactionClient, "invoice">` is
  private and has two in-file call sites.
- `MESSAGE_INVOICE_IMMUTABLE` reworded — no test asserted the old string; the three cases that
  assert the message assert `toContain(InvoiceStatus.FINALIZED|PAID)`, which the `(status …)`
  suffix preserves. Verified: all 213 green.
- The other 11 test-bearing packages ran at their pre-change totals: usage 230, worker 234, auth
  166, gateway 38, analytics 18, six shared packages 51 combined.

No breaking change to any published surface. No migration, no trigger, no policy, no role change.

---

## Tree integrity

Every probe was reverted and the result **proven**, not assumed.

- Final `git diff --stat` is **byte-identical** to the capture I took before touching anything:
  9 files, **1284 insertions, 82 deletions**, with per-file figures 333 / 19 / 34 / 153 / 222 /
  79 / 24 / 415 / 87.
- `apps/billing-service/src/repositories/invoice.repository.ts` md5
  `1669fb73b08894ea46cd7491a83f2e3e`; `base.repository.ts` md5
  `eebd37628f6e20e17fa5e7140221c47b`, which independently matches the digest S-19 records.
- `git status --porcelain` → the same **11** paths. No file staged, committed or branched. No
  worktree registered (`git worktree list` → main only).
- The full gate was re-run **after** restoration and is identical to the pre-probe run.

**One process disclosure, because it bears on how much weight to give the above.** Partway
through the evasion probes I reverted a file with `git checkout --`, which restores the
*committed* version and therefore discarded T-048's uncommitted work in that file. I caught it
on the next command. Four files were recovered from scratchpad copies taken before mutation;
three (`src/constants.ts`, `src/errors/index.ts`, `tests/integration.constants.ts`) had no
backup and were reconstructed by re-applying the unified diff I had captured at the start of this
session, each verified with `git apply --check` before applying and each landing on its exact
original diffstat (19, 34, 24). The byte-level evidence above is what establishes the tree is
correct; I am flagging it rather than relying on the numbers alone, because a reviewer should
know the file contents passed through a reconstruction. **If Gate 6 wants belt and braces, the
cheap check is `git diff` on those three files against the implementer's own copy.**

---

## What I could not validate, and why

- **Production behaviour of the guard.** Unreachable by construction: nothing in `src/` or
  `prisma/` writes a non-`DRAFT` status. Every case, mine included, seeds the state through the
  owner connection or a double. The change states this in six places and I confirm all six.
- **Whether a fifth, sixth or nth cast spelling exists.** I found four evasions; I cannot
  enumerate the space. The census is a tripwire over a list and I can only report that the list
  is smaller than the space, which the docs already say.
- **`this.prisma`, the `prisma` module singleton, and `tx.$executeRaw`.** Recorded in S-48's
  route table with figures; I did not re-run them, having spent the budget on evasions the
  review had *not* measured. S-48 stays open and correctly says so.
- **The `.github/agents/` copy of the pipeline** (S-14) — out of scope and not drivable here.
- **Behaviour under a non-UTC session zone for the seam.** Billing's base copy has no `TimeZone`
  pin (S-19) and the seam takes no timestamp argument, so there is nothing to measure; the
  exposure is the *next* raw timestamp predicate, which this task does not add. ORM only, as D7
  requires — confirmed, no `$queryRaw` in the diff.

---

## Decision for the user

**F-1b needs your answer, and it changes the diff only in option B or C.**

> `BU126` tells you the member set changed; it does not tell you the new member is guarded. The
> fix a developer reaches for when it goes red — adding the name to
> `EXPECTED_PUBLIC_ASYNC_METHODS` — silently discharges it. Measured: package 213/213 with an
> unguarded `finalizeInvoice` in the file and its name on the list. What should T-048 do?

- **A · Record it and ship** — add F-1b to `.claude/rules/known-gaps.md` as a new entry (next
  free id is **S-51**), and leave the code alone. *Diff: one `known-gaps.md` entry.*
- **B · Record it and add one sentence** — same, plus a comment above
  `EXPECTED_PUBLIC_ASYNC_METHODS` saying that appending a name asserts the member has been
  reviewed against the seam. *Diff: one entry plus ~3 lines of comment in a test file. No
  behaviour change; the gate re-proves it.*
- **C · Make the census structural** — have `BU126` additionally assert that every public async
  member's body either reaches `draftInvoiceWriter` or is named on an explicit exemption list
  (`createDraftInvoice`, the reads). *Diff: real new test logic, a second exemption list to keep
  current, and it re-opens the D5 exception. Not a small change.*

**My recommendation: B.** A is honest but leaves the trap where someone will step in it; C buys a
stronger guard than the task's declared scope ("visible, not impossible") and would be new
structural work inside a task that is already at its Gate-5 boundary. B costs three lines, puts
the warning where the person editing the list will read it, and keeps the guarantee statement
truthful. **A and B are the ones that do not change behaviour; C does and should be its own
task.**

**F-2 and F-3 are text corrections, not decisions** — they should be made before commit, and
Gate 6 should verify them by re-running the greps rather than reading them. F-4 and F-5 are
recorded for whoever next edits those comments; neither needs action now.

---

## Release-readiness call

**PASS.** The full gate is green across all 13 packages under `--force` on two independent runs,
billing at 213 and the root at 950. Every acceptance criterion is carried by at least one case
that goes red when the behaviour breaks — proven, not assumed, by M1 and M2 reproducing their
exact named failure sets. The guard holds against every route I could reach through the service:
`409 INVOICE_IMMUTABLE`, nothing written, for both `FINALIZED` and `PAID`, transactionally and
repeatably. Tenant isolation is unaffected and I re-executed the RLS measurement rather than
reading it off the policy text. The type-level census is real: 18 and 9 re-derived from the
generated client, both mutation directions produce `TS2344`, and the `Extract` that makes it work
is load-bearing and measured.

The bypass I constructed is a genuine limit of the guarantee, and it is a limit the change
**already declares in its own words**. I found no overclaim in any shipped sentence — which,
given that Round 1 and Round 2 each found one, is the most meaningful thing this gate can report.
What remains are two count corrections and one gap worth recording, none of which touches
behaviour, a test outcome, or a security property.

Environment returned to baseline: `Tenant` 2, the five tables at 0, Redis db 0 at 2, eleven
`git status` entries, nothing staged, committed or branched.
