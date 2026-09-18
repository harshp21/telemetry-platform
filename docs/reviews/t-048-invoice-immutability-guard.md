# T-048 · Invoice immutability guard — Senior Reviewer

## Round 1

**Gate 4, pre-QA.** Base `a87d952`, nothing committed or staged. Read-only: every mutation below
was reverted and the tree proven byte-identical (§ *Tree integrity*).

**Verdict: CHANGES REQUESTED.**

The engineering is right and the behaviour is right. The narrowing is well-chosen, the
delegate-level scope is justified by a measurement I reproduced exactly, and the four records
(S-19, S-48, S-50, the epic block) are more accurate than any previous round of this kind. The
diff is also scrupulous about *not* saying "impossible" or "unrepresentable" — I audited every
added line for those words and the hedging holds.

What fails is the layer underneath that hedge. The diff replaces "bypass is impossible" with
"bypass is **made visible**, and `BU125` is what makes it visible" — and states that as a
property, in six places, one of them `.claude/rules/`. I refuted it by execution: an unguarded
third writer that sets `status: "FINALIZED"` passes typecheck, lint and **213/213**. Two further
unguarded routes (`tx.$executeRaw`, the `prisma` module singleton) are declared unprobed by the
plan and are contradicted by an added universal in the epic. Given that this task exists
*because* a guard looked complete and was not, shipping a second completeness claim that a
20-minute probe refutes is the finding.

None of this is a defect in the shipped runtime behaviour. Everything below is about the strength
of the claims and the reach of the two census tests. The required fixes are small.

---

### Rules revision read

`.claude/rules/known-gaps.md` **read from disk**, not from context: **3 176 lines**, md5
`5d389f806dc78d99ebf1a7b263cd656a`, last written by `a87d952`, running to **S-50**
(`grep -n '^## S-'` → S-50 at `:3111`).

The copy injected into this session's context ended at **S-39**. It could not see S-40 through
S-50 — including S-46, S-47, S-48 and S-50, all four of which bear directly on this task, and
S-48, whose proposal this task implements. **S-24, fourteenth sighting.** Every citation in this
review was re-read with `grep`/`sed` against disk.

---

## Findings

### HIGH-1 · The "made visible by `BU125`" guarantee is a false universal — an unguarded `FINALIZED` writer passes the whole gate

`.claude/rules/known-gaps.md:2956` · `apps/billing-service/src/repositories/base.repository.ts:43`
· `apps/billing-service/src/repositories/invoice.repository.ts:315-318` and `:420` ·
`docs/epics/epic-8-billing-service.md:188`

The diff's honest-form statement is that a bypass "has to be spelled as a cast, which is greppable
and which `BU125` asserts occurs exactly once in `src/`" (`base.repository.ts:43`), and that
`BU125` "is what turns that into a red test rather than a silent second doorway"
(`invoice.repository.ts:420`). S-48's entry puts it as "the cast compiles, and the census is what
makes it visible" (`known-gaps.md:2956`).

**Measured refutation.** I inserted this third writer into `InvoiceRepository`:

```ts
protected async probeFinalizeEvasive(id: string): Promise<string> {
  return this.withTenant(async (tx) => {
    const row = await (tx.invoice as FullTransactionClient["invoice"]).update({
      where: { id },
      data: { status: "FINALIZED", finalizedAt: new Date() },
      select: { id: true }
    });
    return row.id;
  });
}
```

| Gate | Result with the writer present |
|---|---|
| `pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json` | **0 errors** |
| `pnpm --filter @telemetry/billing-service lint` | **0 findings** |
| `pnpm --filter @telemetry/billing-service test` | **`Test Files 19 passed (19)`, `Tests 213 passed (213)`** |

That is the same green the planning probe `probeFinalize` got at `a87d952` — the measurement the
whole task rests on — reproduced *after* the fix, with a bare id, no `this.where({})`, no status
check, writing the exact state the guard exists to forbid.

**Two independent gaps compose, and either alone is caught.** I isolated them:

| Variant | `BU125` | `BU126` | Suite |
|---|---|---|---|
| `as unknown as FullTransactionClient`, new public method (the diff's own P-G2) | **red** | **red** | `2 failed \| 211 passed (213)` |
| `as unknown as FullTransactionClient`, no new method | **red** | green | `1 failed \| 36 passed (37)` |
| delegate cast `tx.invoice as FullTransactionClient["invoice"]`, new **public** method | green | **red** | `1 failed \| 36 passed (37)` |
| delegate cast + **`protected async`** | green | green | **`213 passed (213)`** |

1. **`BU125`'s pattern is one spelling, not a class.**
   `apps/billing-service/tests/invoice.repository.unit.test.ts:1031` is
   `/as\s+unknown\s+as\s+FullTransactionClient/g`. Widening the *delegate* rather than the client
   — `tx.invoice as FullTransactionClient["invoice"]` — is a single cast, needs no `unknown`, and
   is not matched. It also compiles clean, which I verified separately.
2. **`BU126`'s census does not see `protected`.**
   `invoice.repository.unit.test.ts:1035` is `/^ {2}(private )?async ([A-Za-z0-9_]+)\(/gm`. A
   `protected async` member matches neither alternative, so it lands in **neither** the public list
   nor the private list, and both `toEqual`s pass. `public async`, `static async` and arrow-function
   class properties are outside it for the same reason.

**Concrete fix.** Either weaken the claim to what was measured, or widen the two patterns. My
recommendation is *both*, because they are cheap:

- `invoice.repository.unit.test.ts:1031` — match the class, not the spelling:
  `/\bas\s+(unknown\s+as\s+)?FullTransactionClient\b/g`, and keep the "exactly once, inside
  `invoiceDelegate`" assertion. (`FullTransactionClient` is exported solely for the seam, so any
  mention of it outside `base.repository.ts` and `invoiceDelegate` is the thing worth counting.)
- `invoice.repository.unit.test.ts:1035` — `/^ {2}(private |protected |public |static )?async ([A-Za-z0-9_]+)\(/gm`,
  with a third expected list (empty) for anything that is not `private`/public, so a new modifier
  reddens rather than disappearing.
- `base.repository.ts:43`, `invoice.repository.ts:315-318`, `:420`,
  `known-gaps.md:2956`, `epic:188` — restate as *"`BU125` counts the `FullTransactionClient`
  widenings it knows how to spell; it is a tripwire, not a proof"*, or cite the mutation that
  establishes the stronger form once the patterns are widened.

Graded **HIGH** because `known-gaps.md` is designated authoritative and `CLAUDE.md` instructs other
agents to trust it without re-verification (`review-standards.md` § *Claims the Change Makes*), and
because the refuted claim is the central guarantee of the task.

---

### HIGH-2 · "the one route none of that reaches" is false — two more unguarded routes, both measured

`docs/epics/epic-8-billing-service.md:190` · reinforced by `.claude/rules/known-gaps.md:3111`
(S-50's title: *"the route it actually writes is the one nothing guards"*)

The epic block the diff adds says, item 4: **"The snippet's `this.prisma.invoice.update` is the one
route none of that reaches"**. That is a universal, and the plan §3.2 explicitly flags two routes as
*declared but not probed*. I probed both.

**Route A — `tx.$executeRaw`, inside `withTenant`.** `FullTransactionClient`'s `Omit`
(`base.repository.ts:12`) removes `$connect | $disconnect | $on | $transaction | $use | $extends`.
`$executeRaw` and `$queryRaw` survive on the narrowed `TransactionClient`. This compiles with
**0 diagnostics**:

```ts
await tx.$executeRaw`UPDATE "Invoice" SET "status" = 'FINALIZED' WHERE "id" = ${id}`;
```

This one is worse than `this.prisma` in the way that matters least and better in the way that
matters most: it *is* inside the transaction, so `set_config('app.tenant_id', …)` has been issued
and RLS still bounds the tenant — but it bypasses the status seam entirely, and no document in the
diff mentions it.

**Route B — the `prisma` module singleton, from any layer.** `apps/billing-service/src/config/container.ts:5`
imports `{ prisma }` from `../lib/prisma` and re-exports it as `readonly prisma: PrismaClient`
(`:23`). A free function in the **service** layer:

```ts
import { prisma } from "../lib/prisma";
export const probeServiceLayerFinalize = async (id: string): Promise<void> => {
  await prisma.invoice.update({ where: { id }, data: { status: "FINALIZED", finalizedAt: new Date() } });
};
```

compiles with **0 diagnostics** and leaves `tests/invoice.repository.unit.test.ts` at **37/37**.
It is outside `withTenant`, so no `set_config` — the same hazard the diff correctly documents for
`this.prisma`, but reachable without touching the repository at all, and invisible to `BU125`'s
census because it uses no cast.

**Concrete fix.** `epic-8-billing-service.md:190` — replace *"is the one route none of that
reaches"* with *"is **one of three** routes none of that reaches: `this.prisma`, the `prisma`
singleton imported anywhere, and `tx.$executeRaw` / `tx.$queryRaw`, which the `Omit` does not
remove. All three measured at zero diagnostics."* Mirror the correction in S-50's title and body
(`known-gaps.md:3111`, `:3139-3143`) so the authoritative file does not carry the uniqueness
reading.

---

### MEDIUM-1 · `draftInvoiceWriter` returns an **unbound** delegate — the check binds to `key`, the capability does not

`apps/billing-service/src/repositories/invoice.repository.ts:303-305`, `:435`, `:469-483`

Class docblock property 4 (`:303-305`) states: *"every write to an invoice that already exists
additionally passes `draftInvoiceWriter`'s `DRAFT` check"*, and `:435` calls the method *"The
guarded doorway for every write to an invoice that **already exists**"*. Both read as though the
returned writer is scoped to the row that was checked. It is not: `draftInvoiceWriter` reads
`key`, and returns `FullTransactionClient["invoice"]` — the whole delegate.

**Measured.** Inside `absorbLateUsage`, immediately after the seam call:

```ts
const writer = await this.draftInvoiceWriter(tx, periodKey);
await writer.updateMany({ where: {}, data: { currency: "XXX" } });   // 0 diagnostics
```

compiles clean. A third in-class writer can obtain the capability by checking a row it knows is
`DRAFT` and then write every invoice in the tenant, including `FINALIZED` and `PAID` ones. RLS
still bounds the tenant; nothing bounds the status.

Severity is **MEDIUM** rather than HIGH because `draftInvoiceWriter` is `private` with two in-class
callers, so the reachable surface is the next writer in this one file — which is precisely the
person this task is written for.

**Concrete fix (either, not both):**
- Cheapest and honest: reword `:303-305` and `:435` to the true property — *"`draftInvoiceWriter`
  refuses when the row named by `key` is not `DRAFT`; the delegate it returns is not scoped to that
  row, so a caller must write through the same `key`"* — and note it as the seam's limit beside the
  P-G2 limit already recorded.
- Structural: have the seam perform the write rather than return a delegate, e.g.
  `draftInvoiceUpdate(tx, key, data)` returning the updated row, so the checked key and the written
  key are the same value by construction. This is the shape that would make property 4 literally
  true, and it also removes the need for `createDraftInvoice` and `absorbLateUsage` to hold a raw
  delegate at all. It re-opens D5's framing, so it is a decision, not a cleanup — see § *Decision*.

---

### LOW-1 · "3 added by T-048 itself" is 4 added and 1 removed — an S-33 instance inside the change that cites S-33

`apps/billing-service/src/errors/index.ts:137` · `apps/billing-service/src/repositories/invoice.repository.ts:460`

Both read *"17 lines, 8 of them comments (**3 added by T-048 itself**, the S-33 self-match)"*.

Re-derived. The grep
`grep -rn "FINALIZED\|PAID\|finalizedAt" apps/*/src packages/*/src prisma --include=*.ts --include=*.prisma --include=*.sql | grep -v dist`
returns **17** on the working tree and **14** on `a87d952` — both figures correct, and the
8-comments / 9-declarations-reads-DDL / **zero-assignments** classification is exact (I classified
all 17 by hand; no line is an assignment).

But the delta is **four added and one removed**, not three added:

| Added by T-048 | |
|---|---|
| `constants.ts:131` | `// the three cases that assert the message assert \`toContain(InvoiceStatus.FINALIZED)\`, which` |
| `errors/index.ts:142` | `* So \`BI23\` (\`FINALIZED\`) and \`BI34\` (\`PAID\`), both seeding through the owner connection, plus` |
| `invoice.repository.ts:456` | `* **No production path reaches the refusing branch today.** A grep for \`FINALIZED\`, \`PAID\`` |
| `invoice.repository.ts:457` | `* and \`finalizedAt\` across every service's \`src/\` and \`prisma/\` returns declarations, reads,` |

| Removed by T-048 | |
|---|---|
| `errors/index.ts:136` @ `a87d952` | `* appendix A.6). So until T-048 ships, \`BI23\` -- which seeds \`FINALIZED\` through the owner` |

14 − 1 + 4 = 17. The **net** is +3, which is presumably where the numeral came from, but the
sentence claims a count of *added comments*.

**Concrete fix:** at both sites, *"8 of them comments — T-048 added four and removed one, a net +3,
which is why the count moved"*.

Credit where due: the implementer's own correction in the same docblock — *"the plan's appendix A.6
recorded 12 and that figure does not reproduce"* — is **correct**; 12 does not reproduce and 14 does.

---

### LOW-2 · Both mutation totals in the hand-off do not reproduce; the named sets do

Reported at hand-off: M1 (delete the DRAFT guard) → `7 failed | 206 passed (213)`; M2 (invert it) →
"reddens 16". Re-performed on the shipped tree, each twice:

| Mutation | Reported | **Measured** | Named cases |
|---|---|---|---|
| M1 — delete `if (existing.status !== …) throw` (`invoice.repository.ts:478-480`) | `7 failed \| 206 passed (213)` | **`5 failed \| 208 passed (213)`** (stable over two runs) | BU100, BU123, BU124, BI23, BI34 — exactly the set reported |
| M2 — invert to `===` (`invoice.repository.ts:478`) | 16 | **14** | BI22-BI27, BI34, BU98-BU101, BU123, BU124, BU127 |

In-file, M1 gives `3 failed | 34 passed (37)` (BU100, BU123, BU124).

**The substantive claim survives and I rule it adequate.** All four cases that were green on arrival
— `BU123`, `BU124`, `BU127`, `BI34` — are reddened by M1 ∪ M2, so none is vacuous. Mutation-instead
of-red-first is the correct response here: the plan's S2 falsification criterion ("any new case
passes before S3-S5 land") *could not* be met, because S-45 had already shipped the refusal, and the
honest move was to say so rather than to weaken the cases until they failed. That is what the plan's
§10 did.

**Concrete fix:** correct the two numerals wherever the hand-off text is carried into the commit
message or a durable artifact. Neither numeral appears in the diff's own files — I grepped; the only
`206 passed` hits in the repo are T-047's — so this is a correction to the change's account of
itself, not to shipped text.

---

### LOW-3 · A measurement attached to the wrong mutation — "a second cast reddens `BU125` **and** `BU126`"

`apps/billing-service/src/repositories/invoice.repository.ts:318-320`

> *"run against both `tests/invoice.repository.unit.test.ts` alone and the whole package suite,
> adding a second cast reddens `BU125` and `BU126` in each (`Tests 2 failed | 211 passed (213)` for
> the package)."*

The package figure is **exact** — I reproduced `Tests 2 failed | 211 passed (213)`, and
`2 failed | 35 passed (37)` in-file. But the mutation that produced it was a *third writer*: a new
public `async` method **plus** a cast. `BU126`'s redness came from the new method, not from the cast.

Measured: a second cast with **no** new method (`void (tx as unknown as FullTransactionClient).invoice;`
inside `absorbLateUsage`) gives `1 failed | 36 passed (37)` — **`BU125` alone**.

This is precisely the second shape S-33 records ("a measurement attached to the wrong mutation"),
inside a docblock written in S-33's own style. S-48's parallel sentence at `known-gaps.md:2952-2956`
is **not** affected — it correctly names the mutation as "a third writer casting `tx` back".

**Concrete fix:** `:318-320` → *"adding a third writer that casts `tx` back reddens `BU125` and
`BU126`…; a second cast alone reddens `BU125` only (`1 failed | 36 passed (37)`)."*

---

### NIT-1 · The plan's epic citations rotted before Gate 3

`docs/plans/t-048-invoice-immutability-guard.md:281`, `:289`, `:544` cite the epic snippet at
`:155-163` and the error body at `:164`. At `a87d952` the snippet is `:159-169` and the error
response `:171`; on the working tree, `:159-168` and `:170`. The heading citation at `:3`
(`:140`) is correct, and S-50 and the epic block cite no line numbers, so nothing durable is
affected. Recorded only because S-19's own entry in this diff is about citation rot.

---

## What I verified

### Compile-time gate — all 13 packages, `--force`, nothing cached

| Task | Command | Result |
|---|---|---|
| typecheck | `npx turbo run typecheck --force` | **13 successful, 13 total · 0 cached** |
| lint | `npx turbo run lint --force` | **13 successful, 13 total · 0 cached** · 0 errors, **14 warnings** |
| build | `npx turbo run build --force` | **13 successful, 13 total · 0 cached** |
| test | `npx turbo run test --force` | **13 successful, 13 total · 0 cached** |
| smoke | `pnpm test:smoke` | 6 files, 7 tests, all passing |

`pnpm build -- --force` does not forward the flag; `npx turbo run build --force` was used, as the
brief directs.

**Per-package test totals, and the root derived from them:**

| Package | Files | Tests |
|---|---|---|
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-types` | 1 | 8 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/usage-service` | 19 | 230 |
| **`@telemetry/billing-service`** | **19** | **213** |
| `@telemetry/auth-service` | 15 | 166 |
| `@telemetry/worker-service` | 17 | 234 |
| `@telemetry/web` | — | 0 (`vitest run --passWithNoTests`) |
| **Root** | | **950** |

15+8+4+4+2+18+38+18+230+213+166+234 = **950**. Matches the expected 944 → 950 and billing's
207 → 213. Billing re-run on the restored tree: `19 passed (19)`, `213 passed (213)`.

**worker-service `I24` did not flake** on this run — 234/234 green under full parallel gate load, so
no second per-package run was needed.

**Lint warnings — 14, all pre-existing, provenance proven:**

| File | Count | Rule | `git log -1` |
|---|---|---|---|
| `apps/auth-service/tests/auth.service.unit.test.ts` | 10 | `@typescript-eslint/no-misused-promises` | `d68e719`, 2026-08-25 |
| `apps/usage-service/tests/ingestion.service.unit.test.ts` | 4 | `@typescript-eslint/no-unsafe-assignment` | `b0f6921`, 2026-08-31 |

`git diff --name-only` contains neither file. **Zero `no-unsafe-return`.** Zero warnings in
billing-service. Nothing introduced by this change. The two hashes the brief supplied are the ones I
measured; the prior review's two hashes were indeed wrong.

### The structural guarantee

- **P-G1 reproduces verbatim.** A naive `tx.invoice.update({ where: { id }, … })` in a new method
  gives exactly the diagnostic quoted at `base.repository.ts:40-42` and `invoice.repository.ts:309-310`:
  `src/repositories/invoice.repository.ts(752,36): error TS2339: Property 'update' does not exist on type 'Omit<InvoiceDelegate<DefaultArgs, PrismaClientOptions>, InvoiceWriteMethod>'.`
  Whole package (billing's `tsconfig.json` includes `tests/**`), and the workspace typecheck fails
  with it too.
- **P-G2 reproduces.** The deliberate `as unknown as FullTransactionClient` widening compiles with
  **0 errors**, and reddens `BU125` + `BU126` at both scopes: `2 failed | 35 passed (37)` in-file,
  `2 failed | 211 passed (213)` package — the exact figure the docblock quotes.
- **Step A reproduces exactly**, which is the measurement justifying D1a's ~12-line scope over
  S-48's two. Applying `| "invoice"` to the `a87d952` `TransactionClient`:
  **11 errors — 7 × `TS2339`, 2 × `TS2345`, 2 × `TS7006`**, and the `TS2339` lines are
  `:336`, `:445`, `:595`, `:604`, `:654`, `:662`, `:740` — i.e. **five reads** (`findUnique :336`,
  `findUniqueOrThrow :595`, `findMany :654`, `count :662`, `findFirst :740`) and **two writers**
  (`create :445`, `update :604`). S-48's self-correction — that an earlier revision saying "7 ×
  `TS2339` on legitimate reads" was "an overcount of two" — is **correct**, and so are all five
  quoted line numbers.
- **The strength audit passes.** I grepped every added line for `impossible`, `unrepresentable`,
  `cannot`, `never`, `the only`, `no code path`. Every occurrence beside the bypass claim is
  correctly hedged ("made visible, not impossible" at `base.repository.ts:42-43`,
  `invoice.repository.ts:315` and `:421`, `invoice.repository.unit.test.ts:1251`,
  `epic-8-billing-service.md:189`), and
  `known-gaps.md:2937-2938` explicitly instructs *"never as 'the unguarded write becomes
  unrepresentable'"*. The remaining universals are the two in HIGH-1/HIGH-2.

### The records

- **S-19.** All five `md5sum`s re-derived and **exact**: analytics and worker byte-identical at
  `13a533a2e2c2dcc1ff9db28fb5c7a1fd`/111 lines; billing now `d11a7dc0cacce7a3e07e539e7f3ceb1f`/**174**
  lines; auth `8b12b7d596af50a038f5a79c1361b8a5`/118; usage `d2e8d92fd494fb779f4dea7238273b4a`/124.
  The two rotted subclass citations are **correctly fixed**: `grep -rn "extends TenantScopedRepository" apps/*/src`
  filtered to `export class` gives `event.repository.ts:73` (was `:64`) and
  `invoice.repository.ts:333` (was `:94`), with `meter.repository.ts:35` and
  `usage.repository.ts:150` unchanged. "No row was added by T-048" is right — no new subclass.
  The other four base copies are untouched.
- **S-48** stays **open**, records the delegate-level form, the step-A reason the two-line figure did
  not transfer, that step E is unchanged, and that the `invoiceLineItem` half is untouched. All four
  verified. `BU125` added to what stands behind the property, as required.
- **S-50** is accurate. All three probes reproduce, each varying one dimension and each reverted:
  declaring `probeFindById(id: string, tenantId: TenantId)` **compiles clean**; feeding it into
  `this.where({ id, tenantId })` gives
  `TS2322: Type 'TenantId' is not assignable to type 'undefined'`; building the predicate by hand as
  `where: { id, tenantId }` **compiles clean**. And probe 3 reddens `BU126` at exactly the quoted
  `Tests 1 failed | 36 passed (37)`. (Probe 2 emits a second `TS2322` on the object as a whole that
  the entry does not quote — additive, not a correction.)
- **Epic block.** The forward-reference shape S-32 recommends; snippet retained; heading at `:140`
  and the "refused by this repository's shape" sentence at `:153` both confirmed. Item 4 is HIGH-2.
- **The grep classification** the implementer refused to inherit is correct in substance: 17 lines
  now, 14 at `a87d952`, 8 comments / 9 declarations-reads-DDL, **zero assignments**. I classified all
  17 individually. Only the "3 added" sub-count is wrong (LOW-1).

### Test honesty

- **`BU123` is not byte-equivalent to `BU100`, and the rewrite is justified.** Mutation M3 — widening
  the seam's `select` from `{ id: true, status: true }` to include `currency` — gives
  `1 failed | 36 passed (37)`: **`BU123` alone**, `BU100` green. So `BU123` genuinely pins *what the
  seam judged* (the row it read, the compound-unique address carrying the bound tenant, the exact two
  columns), which is the claim its comment makes.
- **The helpers throw rather than passing vacuously**, as `.claude/rules/testing.md` requires.
  `readSourceTree` (`invoice.repository.unit.test.ts:1082`) throws on an empty walk (`:1095`);
  `readSourceFile` (`:1101`) throws on a missing path (`:1104`); `balancedSliceAfter` (`:1115`)
  throws on a missing declaration (`:1123`), a missing opener (`:1127`) and an unbalanced slice
  (`:1142`); `asyncMembers` (`:1152`) throws on an unreadable name (`:1156`) and on zero members
  (`:1166`). The pre-existing `firstArg` (`:192`) throws when the call is absent (`:195`), and
  `BU127` throws rather than skipping when an invocation order is missing (`:1318`). None can pass by measuring
  nothing.
- **`BU126`'s order-sensitivity is documented**, at `:1058-1062`, with the reason ("a census that
  ignored it would also accept a list that had silently gained and lost a member in one edit") and
  the cost. That satisfies the brief's requirement; the *reach* of its regex is HIGH-1.
- **`BI34` and the owner-connection caveat.** Confirmed said in **six** places, not five:
  `invoice.repository.ts:464`, `errors/index.ts:143`, `integration.constants.ts:246`,
  `billing.integration.test.ts:873`, `invoice.repository.unit.test.ts:1173` (BU123 inline), and
  `epic-8-billing-service.md:207` (item 7). Each says these cases do not prove production behaviour.
- **S-46 respected.** No isolation case over `Invoice` was added. `BI34` asserts refusal and
  non-mutation only; its `readLineItems(SUITE_TENANT_IDS)` is a "nothing written" assertion across
  both tenants, not a tenant-separation assertion. Correct — one would have been green with the
  application predicate removed, because `invoice_tenant_isolation` supplies the same answer.

### Clean-code gate

**Pass, no findings.** Every string literal in the added test code is either a module-level named
constant (`SOURCE_FILE_EXTENSION`, `INVOICE_REPOSITORY_RELATIVE_PATH`, `WIDENING_ACCESSOR_DECLARATION`,
`PRIVATE_MEMBER_MARKER`, `BLOCK_OPEN`/`BLOCK_CLOSE`/`PAREN_OPEN`/`PAREN_CLOSE`,
`EXPECTED_WIDENING_COUNT`, the two expected-method lists, `FORBIDDEN_PARAMETER_NAMES`), a Node module
specifier, a `describe`/`it` title, or a throw message. `BI34` takes its status from
`InvoiceStatus.PAID`, its code from `BILLING_RESPONSES.CODE_INVOICE_IMMUTABLE`, its status code from
`BILLING_RESPONSES.HTTP_STATUS_CONFLICT`, and its fixture value from the new
`INTEGRATION_LATE_USAGE.PAID_TOTAL` — which is deliberately distinct from `FINALIZED_TOTAL`, with the
reason recorded (`integration.constants.ts:240-247`). No bare status codes, no repeated literals, no
duplicate definitions. **D6 verified**: `git grep "cannot absorb late usage" a87d952 -- apps/` returns
exactly one line, the constant declaration itself — **no test asserted the old string**, and no test
asserts the new one literally either; the three message assertions use
`toContain(InvoiceStatus.…)`, which the `(status …)` suffix preserves. All 213 pass.

### Type safety

`FullTransactionClient` and `TransactionClient` are exported deliberately and the one `as unknown as`
is confined to `invoiceDelegate` (`invoice.repository.ts:430-432`, declaration at `:430`). `markUsageLinesBilled`'s
parameter narrowing to `Omit<Prisma.TransactionClient, "invoice">`
(`invoice.repository.ts:510`) is the minimal change that clears step C's two `TS2345`. No `any`
introduced; `git diff` adds no `$queryRaw` result assertion. `InvoiceWriteMethod`
(`base.repository.ts:16-26`) lists nine methods; I did not enumerate Prisma 6.19.3's delegate surface
to confirm nine is exhaustive — see § *Not verified*.

### Environment discipline

- Postgres and Redis left running. `v1_7` not rolled back, no role dropped, no trigger created,
  nothing seeded (no probe needed a fixture).
- **Row counts before and after: `Event 0, UsageLine 0, Invoice 0, InvoiceLineItem 0, Meter 0,
  Tenant 2`** — unchanged, no orphan. The two `Tenant` rows are S-20 residue and were not touched.
- **Redis db 0 — S-22 fired during the mandated gate, reported rather than rounded to green.**
  `DBSIZE` went **3 → 4**, with `KEYS denylist:*` returning **3**, written by auth-service's
  integration suite (`auth.integration.test.ts:34` hard-codes `redis://localhost:6379`, resolving to
  db 0). TTL'd; by the end of the review `DBSIZE` had fallen to **2** as they expired. Nothing was
  destroyed and no suite issued `FLUSHDB`. Not caused by this change; it is S-22 behaving exactly as
  recorded.

### Tree integrity

Every mutation reverted from a pre-probe copy. Final state identical to the start:
`git status --porcelain` → the same 9 modified files and 1 untracked (`docs/plans/t-048-…md`);
`git diff --stat` → **9 files changed, 816 insertions(+), 56 deletions(-)**;
`base.repository.ts` `d11a7dc0cacce7a3e07e539e7f3ceb1f` (174 lines),
`invoice.repository.ts` `cd1aa13bd49159f8dccfd3c531f94ef2`,
`billing.service.ts` `f45049596468cb30f04b2b7d3e1ab5a2`. Billing suite green at 213/213 on the
restored tree.

---

## What I could not verify, and why

- **That `InvoiceWriteMethod`'s nine names are Prisma 6.19.3's complete write surface.** I did not
  enumerate the generated `InvoiceDelegate` type. A method omitted from that union stays available on
  the narrowed delegate and is a silent hole of the same class as HIGH-1. *This is reasoning, not
  measurement* — the nine look right, and `create`/`update` are the two that matter today. A cheap
  check would be a `BU`-case asserting the union is exactly the delegate's mutating members; I
  recommend it rather than requiring it.
- **Whether `BU125`/`BU126` reach the *other* four services.** They read only
  `apps/billing-service/src`. That is correct scope for this task, and S-19 owns the rest.
- **Anything about the finalize flow.** It does not exist; every assertion about the guarded state
  rests on owner-connection fixtures or doubles, which the diff says clearly in six places. I did not
  and could not test production reachability of `FINALIZED`/`PAID`.
- **The trigger probes (P-B/C/D/E) in plan §3.3.** Out of scope for Gate 4 and the brief forbids
  creating a trigger. I took them as reported; they informed a rejected option, so nothing shipped
  depends on them.
- **Whether `tx.$executeRaw` (HIGH-2, route A) would actually pass RLS at runtime.** I established
  only that it **compiles** with zero diagnostics. It is inside `withTenant`, so `set_config` has
  run and `invoice_tenant_isolation` should bound the tenant — *inferred from the policy text
  (`FOR ALL`, tenant term only, no `status` term), not executed*, because executing it would have
  required seeding an invoice.
- **The S-24 mechanism.** Observed again (context stopped at S-39, disk at S-50); not investigated,
  consistent with S-24's own instruction not to restate the cause as known.

---

## Decision for the user

**One question, because MEDIUM-1 has two legitimate answers and they produce different diffs.**

> `draftInvoiceWriter` checks the row named by `key` and then returns the *whole* invoice delegate,
> so the returned capability is not scoped to the row that was checked. Do we fix the claim, or fix
> the shape?

| Option | What changes | Diff impact |
|---|---|---|
| **A · Reword only** | `invoice.repository.ts:303-305` and `:435` restated to the true, narrower property; the seam keeps returning a delegate | **Comments only.** ~6 lines. No behaviour, no test change |
| **B · Make the seam perform the write** | `draftInvoiceWriter(tx, key)` → `draftInvoiceUpdate(tx, key, data)`, returning the updated row; `absorbLateUsage` passes its `data` through; `createDraftInvoice` keeps `invoiceDelegate` | **Production + tests.** `BU126`'s private-method list changes name; `BU127`'s read/write ordering assertion needs re-expressing; `BU98`/`BU99`/`BU100`/`BU101`/`BI22-27` must be re-read. Re-opens D5's framing |
| **C · Defer to a new gap id** | Record it as the seam's measured limit alongside the P-G2 limit, fix nothing now | Comments + one `known-gaps.md` entry |

**My recommendation: A**, and *not* B. The seam is `private` with two in-class callers, so the
realistic exposure is the next writer in this one file — and HIGH-1's fix (widening `BU126` to see
`protected`/`public`) already puts a tripwire on that writer. B is the structurally correct shape,
but it re-opens an approved decision (D5) and forces a re-read of eleven existing cases inside a
task whose other five findings are all comment corrections. If the finalize flow lands in a later
epic, B is the natural shape to adopt *then*, with the transition it exists to serve. **A is a
comment-only change; B changes the diff materially; C leaves a true statement unwritten in the two
docblocks a future writer reads first.**

The HIGH-1 and HIGH-2 fixes are **not** offered as a choice — those are corrections to claims I
refuted by execution, and the two regex widenings are two lines each.

---

## Remaining risks and dispositions

| # | Risk | Disposition |
|---|---|---|
| R1 | `BU125`/`BU126` are tripwires with known blind spots even after the HIGH-1 widening (a bypass in a *new file* under `src/` still shows up in `BU125`'s tree walk, but `$executeRaw` and the `prisma` singleton never will) | Accept, with the claims corrected. The honest framing is "countable, not closed" |
| R2 | `this.prisma`, the `prisma` singleton, and `tx.$executeRaw` remain unguarded | **Out of scope here.** S-48 correctly stays open for `this.prisma`; the other two should be added to it — see below |
| R3 | `InvoiceWriteMethod` may be incomplete against Prisma 6.19.3 | Not verified; recommend a census case. Related to S-49, which already tracks Prisma-upgrade invalidation of a billing assumption |
| R4 | The guard remains unreachable in production — nothing writes a non-`DRAFT` status | Accepted and documented six times over. Correct and honest. This is the task's headline caveat and the release note must carry it |
| R5 | Billing's `base.repository.ts` is now a fourth variant of five | S-19 updated with the new digest and the deliberate-divergence reason. Correct disposition |
| R6 | The unbound delegate (MEDIUM-1) | See § *Decision* |

### Recommended addition to `.claude/rules/known-gaps.md` — do not let this evaporate

Two routes found in this review are **out of scope to fix here** and are not recorded anywhere:

1. **`tx.$executeRaw` / `tx.$queryRaw` survive the narrowing.** `FullTransactionClient`'s `Omit`
   (`base.repository.ts:12`) removes six `$`-methods and not these two, so a raw invoice write
   *inside* `withTenant` compiles with zero diagnostics and is invisible to `BU125`. It is inside
   the transaction, so RLS still bounds the tenant — the status seam is what it bypasses.
2. **The `prisma` module singleton is importable from any layer** (`config/container.ts:5`, `:23`),
   which generalises S-48's step-E `this.prisma` hole beyond the repository class, and reaches it
   without a cast.

Both belong in **S-48**, which is already open and already about exactly this ("state the property
as *a `tx.invoice` write outside the seam becomes `TS2339`*, never as *the unguarded write becomes
unrepresentable*"). Adding them there rather than minting a new id keeps the record in one place and
matches this file's convention. HIGH-2's fix should carry them.

---

## Required for `APPROVED FOR COMMIT`

1. **HIGH-1** — widen `invoice.repository.unit.test.ts:1031` and `:1035` as specified, *or* weaken
   the five claim sites to what was measured. If widened, cite the mutation that establishes the
   stronger form (`review-standards.md` § *Universals Must Cite Their Mutation*).
2. **HIGH-2** — correct `epic-8-billing-service.md:190` and S-50's uniqueness reading
   (`known-gaps.md:3111`, `:3139-3143`); add the two routes to S-48.
3. **MEDIUM-1** — answer the decision above; apply A, B or C.
4. **LOW-1** — correct "3 added" at `errors/index.ts:137` and `invoice.repository.ts:460`.
5. **LOW-2** — correct the two mutation totals in the hand-off / commit message to
   `5 failed | 208 passed (213)` and 14.
6. **LOW-3** — re-attribute the mutation at `invoice.repository.ts:318-320`.

NIT-1 is optional.

**CHANGES REQUESTED → Gate 3.**

---

## Round 2

**Gate 4, pre-QA, re-review.** Base `a87d952`, 11 entries in `git status`, nothing committed or
staged. Read-only: every mutation below was reverted and the tree proven byte-identical
(§ *Tree integrity*).

**Verdict: CONDITIONAL.**

Round 1's two HIGHs are genuinely closed, and closed the hard way — by execution, not by
weakening the sentence until it was safe. I re-performed the evasive writer and it now reddens
both censuses independently; I re-derived the nine and the 18 from the generated client rather
than from the alias; I mutated the new type-level census in both directions; and I **executed**
the one thing both previous rounds only read off the policy text. Every security property this
task asserts holds under measurement.

What fails is narrower and, uncomfortably, is the same thing twice. Round 1's LOW-1 was "a
count in a comment went stale inside the commit that changed it". The fix for LOW-1 went stale
inside the commit that fixed it: the grep it re-derives now returns **19**, not 17, because the
rework added two more matching comment lines after re-deriving. And the citation-rot repairs —
eight `invoice.repository.ts` line numbers rewritten across four `known-gaps.md` entries
specifically *because* they had rotted — are **every one of them wrong by exactly +4**, because
a later edit in the same rework inserted four lines above them. S-49's own entry says "the line
numbers move whenever a docblock in that file grows, which it did twice inside one task"; it
then moved a third time, after that sentence was written.

None of this changes behaviour, a test, or a security property. All three findings are text
corrections. They are graded MEDIUM rather than LOW because they sit in `.claude/rules/` and in
`src/` docblocks, and because the diff's own account presents them as *re-derived*.

---

### Rules revision read

`.claude/rules/known-gaps.md` **read from disk with `cat`/`sed`**, not from context: **3 278
lines**, md5 `c170d1f5af5e0f695058dc9962f7c860`, working-tree (modified) on top of `a87d952`,
running to **S-50** (`grep -n '^## S-'` → S-50 at `:3205`).

The copy injected into this session's context ended at **S-39** — it could not see S-40 through
S-50, including S-46, S-48, S-49 and S-50, all four of which this task edits. **S-24, fifteenth
sighting.** Every citation below was re-read with `grep`/`sed` against disk.

---

## Findings

### MEDIUM-1 · Every citation-rot repair in `known-gaps.md` is itself stale, by exactly +4

`.claude/rules/known-gaps.md:521` (S-19) · `:1825` (S-40) · `:2886` (S-48 step C) · `:3188`
(S-49)

Eight `apps/billing-service/src/repositories/invoice.repository.ts` line citations were rewritten
by this diff as repairs. Re-derived with each entry's own prescribed command, on the tree that
ships:

| Entry | Cited | Command | **Measured** |
|---|---|---|---|
| S-19 subclass table | `:351` | `grep -rn "extends TenantScopedRepository" apps/*/src` \| `grep "export class"` | **`:355`** |
| S-40 `skip:` offset | `:806` | `grep -n "skip: (query.page - 1) \* query.pageSize"` | **`:810`** |
| S-48 step C, `markUsageLinesBilled` declaration | `:555` | `grep -n "markUsageLinesBilled"` | **`:559`** |
| S-49, five `invoiceLineItem.` comments | `:671`, `:686`, `:688`, `:847`, `:873` | `grep -rn "invoiceLineItem\." apps/*/src --include=*.ts` | **`:675`, `:690`, `:692`, `:851`, `:877`** |

**Uniformly +4.** The cause is visible in the diff: `git diff -U0` on that file shows a
`@@ -301,0 +307,44 @@` hunk — the MEDIUM-1 reword added to the class docblock's property 4 — and
four of its lines land above line 351. So the rework re-derived all eight, then made the
MEDIUM-1 edit, and shipped without re-running the greps. Every other S-19 figure in the same
bullet is **exact**: `eebd37628f6e20e17fa5e7140221c47b` / 262 lines for billing,
`13a533a2e2c2dcc1ff9db28fb5c7a1fd` / 111 for analytics and worker,
`8b12b7d596af50a038f5a79c1361b8a5` / 118 for auth, `d2e8d92fd494fb779f4dea7238273b4a` / 124 for
usage, `set_config` at billing `:249`, analytics/worker `:98`, auth `:105`, and the three
unmoved subclasses at `event.repository.ts:73`, `meter.repository.ts:35`,
`usage.repository.ts:150`. S-40's *historical* figure is also right — the statement really is at
`:658` on `a87d952`, confirmed with `git show`.

Graded MEDIUM, not HIGH: no conclusion rests on any of the eight, the symbols all exist, and two
of the four entries already tell the reader to cite by symbol rather than by line. Graded above
LOW because `CLAUDE.md` designates this file authoritative and instructs agents to trust it
without re-verification, and because the entire purpose of these particular edits was to stop
exactly this.

**Concrete fix:** add 4 to all eight, *after* the last edit to `invoice.repository.ts` and not
before — or take the better option and delete the line numbers, keeping the greps. S-49's entry
already says "five comments is the durable part"; S-48's already says "cite this one by method
and symbol". Follow that advice in S-19's subclass row and S-40's `skip:` row too. See
§ *Decision* — the same choice governs MEDIUM-2.

---

### MEDIUM-2 · The LOW-1 fix is stale on the tree that ships: the grep returns **19**, not 17, and T-048 added **six** comment lines, not four

`apps/billing-service/src/errors/index.ts:136-139` · `apps/billing-service/src/repositories/invoice.repository.ts:507-508`
· `docs/plans/t-048-invoice-immutability-guard.md:739-743`

All three read, in substance, *"**17** matching lines, 8 of them comments and 9 declarations,
reads and DDL. … On `a87d952` the same grep returned 14. T-048 **added four comment lines and
removed one**, a net +3."*

Re-derived with the documented command,
`grep -rn "FINALIZED\|PAID\|finalizedAt" apps/*/src packages/*/src prisma --include=*.ts --include=*.prisma --include=*.sql | grep -v dist`,
and the delta taken with `comm` against a detached worktree at `a87d952` (created, used, and
removed with `git worktree remove --force`):

| Figure | Claimed | **Measured** |
|---|---|---|
| working tree total | 17 | **19** |
| `a87d952` total | 14 | **14** ✓ |
| comments | 8 | **10** |
| declarations / reads / DDL | 9 | **9** ✓ |
| **assignments** | **zero** | **zero** ✓ |
| added by T-048 | four | **six** |
| removed by T-048 | one | **one** ✓ |

14 − 1 + 6 = 19. The six added are `constants.ts:131`, `errors/index.ts:145`,
`invoice.repository.ts:503`, `:504`, and — added by the **Round-2 rework itself, after Round 1's
LOW-1 was measured** — `base.repository.ts:122` (*"writing `status: \"FINALIZED\"`"*, in the
claim-correction paragraph) and `invoice.repository.ts:479` (*"`await writer.updateMany({ where:
{}, data: { status: \"FINALIZED\" } })`"*, in the MEDIUM-1 reword). The one removed is
`errors/index.ts:136` at `a87d952`.

So the fix for the S-33 self-match introduced two more self-matches. Round 1 measured 17 and
"four added"; both were correct **then**. The plan at `:741` additionally cites the four added
lines as `errors/index.ts:142`, `invoice.repository.ts:456` and `:457` — those are Round 1's
positions, now `:145`, `:503`, `:504`.

**The load-bearing half survives and I re-verified it by hand across all 19 lines: zero
assignments.** Nothing in `src/` or `prisma/` writes `Invoice.status` except
`createDraftInvoice`'s `DRAFT`.

**Concrete fix:** at `errors/index.ts:136-139` and `invoice.repository.ts:507-508`, either
re-derive to *"19 matching lines, 10 of them comments and 9 declarations, reads and DDL; 14 on
`a87d952`; T-048 added six comment lines and removed one"* — noting that writing that sentence
does not itself change the count, because it adds no new `FINALIZED`/`PAID`/`finalizedAt`
token — or drop the numerals entirely and keep *"zero assignments"*, which is the claim that
matters and the only one that has survived three derivations. See § *Decision*.

---

### MEDIUM-3 · "No code anywhere writes `FINALIZED` or `PAID`" is refuted 33 lines below one of the sites that says it

`docs/epics/epic-8-billing-service.md:227-228` · `apps/billing-service/src/errors/index.ts:134-135`
· `apps/billing-service/src/repositories/invoice.repository.ts:505-506` ·
`apps/billing-service/tests/billing.integration.test.ts:874-875`

Four sites **added by this diff** carry an unscoped universal:

- epic `:227` — *"**No production writer reaches the guarded state.** No code anywhere writes
  `FINALIZED` or `PAID`; `createDraftInvoice`'s `DRAFT` is the only status any statement sets."*
- `errors/index.ts:135` — *"and is the only statement that sets `Invoice.status` **at all**"*
- `invoice.repository.ts:505` — *"`createDraftInvoice`'s `DRAFT` is the only status any statement
  writes"*
- `billing.integration.test.ts:874` — *"because the platform cannot produce that status:
  `createDraftInvoice` … is the only statement **anywhere** that sets `Invoice.status`"*

Measured refutation, in the same repository:
`apps/billing-service/tests/billing.integration.test.ts:842` writes
`status: InvoiceStatus.FINALIZED` and `:893` writes `status: InvoiceStatus.PAID`, both through
the owner client. `:842` is **33 lines above** the `:875` sentence that says no such statement
exists anywhere. The grep that backs the claim is scoped to `apps/*/src`, `packages/*/src` and
`prisma` — it does not read `tests/` — so the evidence supports *"no writer in `src/`"* and the
sentence says *"anywhere"*.

The rework already knows this. The epic's item-7 **heading** was softened this round from
*"Nothing on this platform can reach the guarded state"* to *"No production writer reaches the
guarded state"* for precisely this reason (plan `:787-790`: "the fixtures reach it"), and
`errors/index.ts:150` says *"**not** as a claim the status is unrepresentable: the fixtures reach
it"*. The heading was fixed; the sentence directly under it was not, and the same unscoped form
is in two `src/` docblocks.

I also established it is not a database-level property either: as `telemetry_app`
(`rolsuper=false`, `rolbypassrls=false`, read from `pg_roles` on that connection), a raw
`UPDATE "Invoice" SET status='FINALIZED'` under tenant context succeeded on the tenant's own row
(§ *What I verified*).

**Concrete fix:** insert the scope at all four sites — *"no statement in `src/` or `prisma/` sets
`Invoice.status` other than `createDraftInvoice`'s `DRAFT`; the `BI23`/`BI34` fixtures set it
through the owner connection, which is why they exist"*. That is the true claim, it is what the
grep shows, and it is two words longer.

---

### LOW-1 · S-48's "7 unit failures" is placement-dependent and the entry does not name the placement

`.claude/rules/known-gaps.md:3031`

The route table's third column reads: *"Inside an existing method it is invisible to both
censuses — the **7** unit failures that variant produces are `TypeError: tx.$executeRaw is not a
function` from the test double, not a guard."*

Re-performed, `absorbLateUsage`'s existing body, two insertion points, whole package each time:

| Insertion point | Result |
|---|---|
| First statement of the `withTenant` callback, **before** `draftInvoiceWriter` | **`Tests 7 failed \| 206 passed (213)`** — BU98, BU99, BU100, BU101, BU123, BU124, BU127 |
| Immediately **after** the seam call | **`Tests 4 failed \| 209 passed (213)`** — BU98, BU99, BU101, BU127 |

Both compile at **0 diagnostics**, both leave `BU125` and `BU126` **green**, and in both the
failure text is exactly `TypeError: tx.$executeRaw is not a function`. So the entry's mechanism
claim and its conclusion — *invisible to both censuses; the redness is a test double, not a
guard* — are **correct and I confirm them**. Only the numeral is conditional on a placement the
entry does not state, which is S-33's own remedy applied to S-33's own file ("a quoted output
must name the exact mutation that produced it").

**Concrete fix:** `:3031` → *"the **7** unit failures that variant produces when inserted as the
first statement of the `withTenant` callback (**4** if inserted after the seam call) are
`TypeError: …`"*.

---

### NIT-1 · A registered git worktree was left behind by Gate 3 Round 2

`git worktree list` reports a second worktree at
`…/scratchpad/base-wt` (detached at `a87d952`), with `.git/worktrees/base-wt` created
2026-09-17 20:36 — before this session, and matching the plan's "a detached worktree at
`a87d952`" at `:739`. Harmless, outside the working tree, invisible to `git status`, and **not
this review's** (I created and removed my own). Recorded because it is repo state under `.git/`
that the task created and did not clean up: `git worktree remove --force <path>` closes it.

### NIT-2 · The modifier list is spelled twice in two regexes while two markers exist as constants

`apps/billing-service/tests/invoice.repository.unit.test.ts:1063` and `:1076`

`ASYNC_MEMBER_PATTERN` and `ASYNC_PROPERTY_PATTERN` each inline
`private|protected|public|static|readonly|override|abstract`, while `PRIVATE_MEMBER_MARKER`
(`:1078`) and `PUBLIC_MEMBER_MARKER` (`:1079`) exist as named constants used by the classifiers.
A modifier added to one regex and not the other reopens exactly the Round-1 hole. `.claude/rules/constants.md`'s
DRY clause applies. One `MEMBER_MODIFIERS` array joined into both patterns would do it. NIT
because both are correct today and I verified both catch their shape.

---

## What I verified

### Priority 1 — the bypass is caught, and each census stands alone

- **The Round-1 evasive writer re-performed verbatim** — `protected async probeFinalizeEvasive`,
  delegate-level cast `(tx.invoice as FullTransactionClient["invoice"])`, no `unknown` hop,
  writing `status: "FINALIZED", finalizedAt: new Date()`. It **typechecks at 0 errors** (so the
  cast still compiles — the honest half of the claim survives) and now reddens:
  `Tests 2 failed | 35 passed (37)` in the census file and **`Tests 2 failed | 211 passed (213)`**
  in the package — the exact figure quoted at `base.repository.ts:123-124`,
  `invoice.repository.ts:339` and `known-gaps.md`.
- **Each census reddens alone**, which was the specific thing to check:
  `vitest run tests/invoice.repository.unit.test.ts -t BU125` → `1 failed | 36 skipped (37)`,
  assertion `expected [ …(2) ] to deeply equal [ Array(1) ]`; `-t BU126` → `1 failed | 36 skipped
  (37)`, assertion `expected [ Array(1) ] to deeply equal []`. Neither depends on the other.
- **`BU126`'s third list fires on a member matching no branch.** The `-t BU126` failure above
  *is* the third-list assertion (`invoice.repository.unit.test.ts:1356-1360`) — the public and
  private `toEqual`s passed and the unclassified-modifier list caught the `protected` member and
  reported it by modifier text. That silent exclusion was half of Round 1's HIGH-1 and it is
  closed.
- **The async-property assertion reproduces to the character.** Adding
  `private probeArrowWriter = async (id: string): Promise<string> => { … }` typechecks at **0
  errors**, is absent from `asyncMembers` (both list assertions passed), and reddens exactly the
  `ASYNC_PROPERTY_PATTERN` assertion with
  `expected [ 'private probeArrowWriter = async' ] to deeply equal []` — verbatim the string
  quoted at `invoice.repository.unit.test.ts:1072`.

**I did get past the widened censuses, and it confirms the rework's hedge rather than refuting
it.** The diff states plainly that "a fifth spelling (a new alias, a helper that launders the
type, a `satisfies` form) would be missed the same way"
(`invoice.repository.unit.test.ts:1031-1032`). I built the laundering case it names:

```ts
const reinterpret = <T,>(value: unknown): T => value as T;
// …inside an existing method, so no new class member:
await reinterpret<FullTransactionClient["invoice"]>(tx.invoice).updateMany({ … });
```

No enumerated cast target follows an `as`; `FullTransactionClient` appears only as a type
argument. **0 diagnostics, 0 lint findings, `BU125` green, `BU126` green.** What caught it was
placement-dependent collateral from behavioural mocks (`BU16`/`BU17` when placed in
`tenantExists`; `BU98`/`BU99`/`BU127` when placed in `absorbLateUsage`) — the same "not a guard,
a test double" distinction the S-48 route table draws, and I confirm that distinction is
described correctly. So the census is a tripwire over an enumerated set, the diff says so in
six places, and the wording is accurate. **What I tried and what got through is recorded here so
the next reviewer need not re-derive it.**

### Priority 2 — the type-level census

- **The nine and the 18 re-derived from the generated client, not the alias.** `ts.createProgram`
  over `apps/billing-service/tsconfig.json`, `checker.getPropertiesOfType` on
  `Omit<PrismaClient, …>["invoice"]` → **18** string members:
  `aggregate, count, create, createMany, createManyAndReturn, delete, deleteMany, fields,
  findFirst, findFirstOrThrow, findMany, findUnique, findUniqueOrThrow, groupBy, update,
  updateMany, updateManyAndReturn, upsert`. The nine of `InvoiceWriteMethod` and the nine of
  `InvoiceReadMethod` partition that set exactly. Cross-checked textually against the generated
  `.prisma/client/index.d.ts` — 17 methods in the `InvoiceDelegate` body (`:8971`–`:9344`) plus
  `readonly fields: InvoiceFieldRefs` at `:9343`.
- **Mutated both ways**, `pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json`:
  adding an invented `"probeFutureWrite"` to `InvoiceWriteMethod` →
  `src/repositories/base.repository.ts(94,2): error TS2344: Type 'false' does not satisfy the constraint 'true'.`;
  deleting `"groupBy"` from `InvoiceReadMethod` → the same diagnostic at `(92,2)`. Both on the
  `InvoiceDelegateSurfaceCensus` declaration, both reverted, 0 errors either side.
- **`Extract<…, string>` is load-bearing, and the stated reason is exact.** Rewritten as a bare
  `keyof`, the census fails on the *current* Prisma:
  `base.repository.ts(93,2): error TS2344: Type 'false' does not satisfy the constraint 'true'.`
  The cause is the symbol index signature the docblock cites — `.prisma/client/index.d.ts:8972`
  reads `[K: symbol]: { types: Prisma.TypeMap<ExtArgs>['model']['Invoice'], meta: { name: 'Invoice' } }`,
  **exact line, exact shape**, and `checker.getIndexInfosOfType` on the delegate returns exactly
  one index info with key type `symbol`.
- **`base.repository.ts` is the right home, and S-19 is correctly updated.** The census is a type
  over `FullTransactionClient["invoice"]`, which is declared in that file; putting it anywhere
  else would export the alias for no other reason. The cost is that billing's copy is now
  `eebd37628f6e20e17fa5e7140221c47b` / **262 lines** against analytics' and worker's
  `13a533a2e2c2dcc1ff9db28fb5c7a1fd` / **111** — a fourth variant of five, which S-19's bullet now
  records with the digest, the line count, both intermediate digests, and the deliberate reason.
  That is the correct disposition: the unification is S-19's own task across five services, and
  doing it inside a billing guard is the move S-19 exists to describe. **Ruled: keep it where it
  is.**

### Priority 3 — HIGH-2's routes

- **The `Omit` leaves exactly four `$`-methods**, enumerated from the type with the compiler API
  rather than read off the `Omit`: **`$executeRaw`, `$executeRawUnsafe`, `$queryRaw`,
  `$queryRawUnsafe`**. Claim exact, at `base.repository.ts:137-139`, `known-gaps.md:3034-3036`
  and `epic:208-211`.
- **The third route re-performed** — see LOW-1. Compiles at 0 diagnostics in both placements;
  invisible to both censuses in both; the redness is `TypeError: tx.$executeRaw is not a function`
  from the double. The *distinction* is described correctly; only the count is placement-bound.
- **Folding both into S-48 rather than minting a new id is right, and I rule it correct.** S-48's
  subject is literally "the property this narrowing does and does not give you", its fix
  direction already says *"state the property as `a tx.invoice write outside the seam becomes
  TS2339`, never as `the unguarded write becomes unrepresentable`"*, and the route table now sits
  under that sentence. A new id would have split one property across two entries, and this file's
  id-stability rule makes that permanent. S-50 correctly keeps only the epic-wording half and
  points at S-48's table for the count.
- **`tx.$executeRaw` under RLS — now EXECUTED.** Both prior rounds read it off the policy text;
  the brief asked me to execute it if cheap, so I did. Seeded two tenants and two `DRAFT`
  invoices through `DIRECT_DATABASE_URL` (owner), then connected as **`telemetry_app`**, confirmed
  from `pg_roles` on that very connection that `rolsuper = false` and `rolbypassrls = false`, and
  inside one transaction with `set_config('app.tenant_id', <A>, true)`:

  | Raw statement, no application predicate | Rows |
  |---|---|
  | `UPDATE "Invoice" SET status='FINALIZED' WHERE id = <tenant **B**'s invoice>` | **0** |
  | `UPDATE "Invoice" SET status='FINALIZED' WHERE id = <tenant **A**'s own invoice>` | **1** |
  | `UPDATE "Invoice" SET currency='XXX'` — no `WHERE` at all | **1** (not 2) |

  `ROLLBACK`, then both seed rows deleted. The second row is what makes the first non-vacuous.
  **So the raw route is bounded by `invoice_tenant_isolation` at runtime, and what it bypasses is
  the status seam — exactly as the diff says.** The two sites that label this unexecuted
  (`known-gaps.md:3037`, `epic:212`) are therefore *conservative*, not wrong, and I found no
  third site that overstates it. Recommended, not required: cite this measurement there, since
  being more cautious than the evidence is only free until someone spends a round re-deriving it.

### Priority 4 — the rest

- **MEDIUM-1 (Round 1) verified and correctly dispositioned.**
  `await writer.updateMany({ where: {}, data: { currency: "XXX" } })` inserted immediately after
  the seam call in `absorbLateUsage` compiles at **0 diagnostics**; so does the exact form the
  docblock quotes, `{ where: {}, data: { status: "FINALIZED" } }`. The reword landed in **four**
  places, not three — `invoice.repository.ts:307-311` (class docblock property 4, *"what is bound
  to `key` is the check, not the capability"*), `:465` (the doorway sentence, narrowed from "every
  write" to "the two writers of an invoice that already exists"), `:475-488` (the new *"The limit,
  measured rather than reasoned about"* paragraph, which quotes the mutation and the command),
  and `:499-501`. The seam signature is **unchanged** at `:519-522` —
  `draftInvoiceWriter(tx, key): Promise<FullTransactionClient["invoice"]>`. Option A applied as
  decided; B not taken. Correct.
- **Both mutation totals re-performed on the shipped tree, whole package each.**

  | Mutation | Reported by the rework | **Measured** | Named set |
  |---|---|---|---|
  | M1 — delete the `DRAFT` guard (`invoice.repository.ts:528-530`) | `5 failed \| 208 passed (213)` | **`5 failed \| 208 passed (213)`** ✓ | BI23, BI34, BU100, BU123, BU124 — **exact** |
  | M2 — invert `!==` to `===` (`:528`) | `14 failed \| 199 passed (213)` | **`14 failed \| 199 passed (213)`** ✓ | BI22, BI23, BI24, BI25, BI26, BI27, BI34, BU98, BU99, BU100, BU101, BU123, BU124, BU127 — **exact, all 14** |

  Round 1's corrections to the hand-off's `7 | 206` and `16` are confirmed, and the plan at
  `:744-749` carries the corrected figures.
- **The seven claim sites.** All seven listed at plan `:773-783` were re-read on disk and none
  claims completeness: `base.repository.ts:7-10` ("catches the spellings it knows and no others"),
  `:113-125` ("A fifth spelling would still be missed"), `:126-139` ("one of several"),
  `invoice.repository.ts:320-339` (each mutation with the suite it was run against, and `BU126`'s
  redness attributed to the **new member** — Round 1's LOW-3, correctly fixed),
  `:439-453` ("a tripwire over an enumerated set, not a proof … earned by being wrong"),
  `known-gaps.md` S-48 ("Do not restate this as 'every bypass is caught'"), and epic items 3–4.
  The epic heading change is confirmed at `epic:227` — *"No production writer reaches the guarded
  state"*, softened from *"Nothing on this platform can reach the guarded state"*. **I grepped
  every added line** for `impossible`, `unrepresentable`, `cannot`, `never`, `the only`,
  `no code path`: every `impossible` and every `unrepresentable` occurs inside a negation or a
  quoted refutation of an earlier revision, as required. `cannot` does **not** fully meet that
  bar — it also occurs as a live claim at `epic:227`, `errors/index.ts:135`,
  `invoice.repository.ts:505` and `billing.integration.test.ts:874`. That is MEDIUM-3.
- **The S-24 bullet is accurate.** Four bullets (T-038 Gate 4, T-038 Gate 6, T-042 Gate 3, T-048
  Gate 3 Round 2), the last recording two occurrences — so "four bullets, five occurrences"
  reconciles, and the entry's refusal to guess the title's "twice" is the right call. The
  reconciliation paragraph added this round is the honest form.
- **The `BU126` prose census greps re-derived**, as `invoice.repository.ts:284-292` instructs:
  `grep -cE '^  async'` → **7**, `grep -cE '^  (private )?async'` → **9**, modifier-inclusive
  form → **9**. All three exact, and `EXPECTED_PUBLIC_ASYNC_METHODS` / `EXPECTED_PRIVATE_ASYNC_METHODS`
  match the file in declaration order.
- **LOW-1's classification half.** 9 declarations/reads/DDL and **zero assignments** both hold
  across all 19 lines, classified individually. Only the total and the comment count moved —
  MEDIUM-2.

### Compile-time gate — all 13 packages, `--force`, nothing cached

| Task | Command | Result |
|---|---|---|
| typecheck | `npx turbo run typecheck --force` | **13 successful, 13 total · 0 cached** |
| lint | `npx turbo run lint --force` | **13 successful, 13 total · 0 cached** · 0 errors, **14 warnings** |
| build | `npx turbo run build --force` | **13 successful, 13 total · 0 cached** |
| test | `npx turbo run test --force` | **13 successful, 13 total · 0 cached** |
| smoke | `pnpm test:smoke` | **6 files, 7 tests, all passing** (gateway 2; auth, usage, billing, analytics, worker 1 each) |

`pnpm build -- --force` does not forward the flag; `npx turbo run build --force` was used.

**Per-package test totals, root derived:**

| Package | Files | Tests |
|---|---|---|
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-types` | 1 | 8 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/usage-service` | 19 | 230 |
| **`@telemetry/billing-service`** | **19** | **213** |
| `@telemetry/auth-service` | 15 | 166 |
| `@telemetry/worker-service` | 17 | 234 |
| `@telemetry/web` | — | 0 (`vitest run --passWithNoTests`) |
| **Root** | | **950** |

15+8+4+4+2+18+38+18+230+213+166+234 = **950**. Billing **213**, matching the brief and adding no
test ids over Round 1.

**worker-service `I24` did not flake** — 234/234 under full parallel gate load, so no
single-package re-run was needed.

**Lint — 14 warnings, 0 errors, zero `no-unsafe-return`, all pre-existing and proven:**

| File | Count | Rule | `git log -1 -- <file>` |
|---|---|---|---|
| `apps/auth-service/tests/auth.service.unit.test.ts` | 10 | `@typescript-eslint/no-misused-promises` | **`d68e719`**, 2026-08-25 |
| `apps/usage-service/tests/ingestion.service.unit.test.ts` | 4 | `@typescript-eslint/no-unsafe-assignment` | **`b0f6921`**, 2026-08-31 |

`git diff --name-only` lists neither file. Zero warnings in billing-service. Nothing introduced.

### Tenant isolation, injection, type safety, clean code

- **Tenant isolation: no finding.** No new query path; `draftInvoiceWriter` reads through the
  narrowed delegate with a `key` built inside the repository from
  `tenantId_periodStart_periodEnd` with the tenant from `this.where({})`; `BU126` now asserts by
  parsing every `async` member's parameter list that no method takes `invoiceId` or `tenantId`.
  Live policy confirmed: `Invoice` has `relrowsecurity = t`, `relforcerowsecurity = t`, one policy
  `invoice_tenant_isolation`, `polcmd = '*'`, with both `USING` and `WITH CHECK` as
  `"tenantId" = current_setting('app.tenant_id', true)` — and I executed against it as a
  `NOSUPERUSER NOBYPASSRLS` role rather than reading it. `InvoiceLineItem` remains
  `relrowsecurity = f` (S-10), unchanged by this task.
- **Injection: no finding.** The diff adds no raw SQL. The one `$queryRaw` in billing's
  `base.repository.ts:249` is the unchanged `set_config` with a bound parameter.
- **Type safety.** The single `as unknown as FullTransactionClient` remains confined to
  `invoiceDelegate` (`invoice.repository.ts:461`) and `BU125` asserts it. The new census types are
  pure type-level; `AssertTrue`/`ExactlyEqual` introduce no runtime code and no `any`. No
  `$queryRaw` result assertion added.
- **Clean code: pass, two NITs.** Every added test literal is a named module constant
  (`SOURCE_FILE_EXTENSION`, `INVOICE_REPOSITORY_RELATIVE_PATH`, `WIDENING_PATTERN`,
  `FULL_DELEGATE_CAST_PATTERNS`, `EXPECTED_WIDENING_COUNT`, `ASYNC_MEMBER_PATTERN`,
  `ASYNC_PROPERTY_PATTERN`, `PRIVATE_MEMBER_MARKER`, `PUBLIC_MEMBER_MARKER`, the two expected-method
  lists, `WIDENING_ACCESSOR_DECLARATION`, `FORBIDDEN_PARAMETER_NAMES`, the four bracket constants),
  a Node module specifier, a `describe`/`it` title, or a throw message. The only added production
  literal is `MESSAGE_INVOICE_IMMUTABLE` in `constants.ts`, which is a constant. No bare status
  codes; no duplicate definitions. NIT-2 is the one DRY observation.
- **Test honesty: pass.** All census helpers still **throw** rather than passing vacuously —
  `readSourceTree` on an empty walk (`:1137`), `readSourceFile` on a missing path (`:1146`),
  `balancedSliceAfter` on a missing declaration (`:1165`), a missing opener (`:1169`) and an
  unbalanced slice (`:1185`), `asyncMembers` on an unreadable name (`:1207`) and on zero members
  (`:1217`). No new case short-circuits, skips, or asserts a mock's own return value. Every new
  assertion added this round was driven red by a mutation I performed.

### Environment discipline

- Postgres and Redis left **running**. `v1_7` not rolled back, no role created or dropped, no
  trigger created. Seeding went through the owner connection only.
- **Row counts, before and after: `Event 0, UsageLine 0, Invoice 0, InvoiceLineItem 0, Meter 0,
  Tenant 2`** — the two probe tenants and two probe invoices deleted, no orphan. The two `Tenant`
  rows are S-20 residue and were not touched.
- **Redis db 0 — S-22 fired and is reported, not rounded to green.** auth-service's integration
  suite runs inside the mandated `pnpm test` and hard-codes `redis://localhost:6379`
  (`auth.integration.test.ts:34`), resolving to db 0 alongside `telemetry:events`. `DBSIZE` read
  **2** immediately after the gate and **1** at the end, the difference being one TTL'd
  `denylist:*` key expiring during the review — the decay S-22 describes, not a deletion. **I
  did not capture a pre-gate baseline**, so I cannot state this run's delta — only that the
  mechanism is unchanged and that nothing I ran, and no suite in the gate, issued `FLUSHDB`.
  Not caused by this change.

### Tree integrity

Every mutation reverted from a pre-probe copy taken before any edit. `md5sum -c` against the
24-file baseline reports **all OK**. `git status --porcelain` → the same 11 entries;
`git diff --stat` → **9 files changed, 1178 insertions(+), 69 deletions(-)**, identical to the
start. `base.repository.ts` `eebd37628f6e20e17fa5e7140221c47b`,
`invoice.repository.ts` `c2e9fca3337dbb9b870ad5e999798e12`,
`invoice.repository.unit.test.ts` `0962c12ae25f515d33773ffa95d16526`,
`known-gaps.md` `c170d1f5af5e0f695058dc9962f7c860`. The temporary `a87d952` worktree I created
for the `comm` diff was removed and pruned; the pre-existing `base-wt` (NIT-1) was left alone.
The compiler-API probe file `src/__census_probe__.ts` was unlinked by the script that wrote it and
does not appear in `git status`.

---

## What I could not verify, and why

- **That no *fifth* cast spelling, member shape or laundering form escapes the censuses.** I
  refuted the general form by construction (a generic `reinterpret<T>` helper walks through at 0
  diagnostics with both censuses green) but I cannot enumerate the complement of a regex. The
  diff does not claim otherwise; this is recorded as the measured limit, not as a gap.
- **Production reachability of `FINALIZED`/`PAID`.** No issuance flow exists. Every assertion
  about the guarded state rests on owner-connection fixtures or doubles, which the diff says in
  six places. I confirmed the `src/`-scoped grep and that **zero** statements assign the column;
  I did not and could not test production behaviour.
- **Whether `InvoiceDelegateSurfaceCensus` would catch a Prisma upgrade *in practice*.** I mutated
  the unions and confirmed `TS2344` both ways, which is the property. I did not install a
  different Prisma version.
- **The S-24 mechanism.** Observed a fifteenth time (context to S-39, disk to S-50); not
  investigated, consistent with S-24's own instruction not to restate the cause as known.
- **Redis db 0's delta for this run**, as above — no pre-gate baseline was taken.
- **Gate-3 probes I did not repeat**: the step-A 11-error progression and the three S-50 probes
  were re-derived in Round 1 and found exact; I did not re-run them, since nothing in the rework
  touched the code they measure. Stated as inherited-from-Round-1, not as re-measured here.
- **`pnpm format:check`** was not run; S-12 records that it cannot pass on any revision of this
  repository and no CI step invokes it.

---

## Decision for the user

**One question, and it governs both MEDIUM-1 and MEDIUM-2, which have the same cause.** This task
has now spent two consecutive rounds on numerals that were correct when written and stale when
shipped, and the second round's corrections went stale the same way, inside the same commit.

> Do we re-derive the numbers a third time, or delete the ones nothing depends on?

| Option | What changes | Diff impact |
|---|---|---|
| **A · Re-derive once more, last** | Add 4 to the eight `invoice.repository.ts` citations; change 17→19, 8→10, "four added"→"six added" at the three sites. Do it as the **final** edit and re-run every grep afterwards | **Comments and `known-gaps.md` only.** ~14 lines. No behaviour, no test change. Risks a third recurrence if anything is touched after |
| **B · Delete the line numbers, keep the greps and the durable claims** | S-19's subclass row, S-40's `skip:` row, S-48's step C and S-49's five become symbol-and-grep citations with no `:NNN`; the three grep-count sites keep *"zero assignments"* and drop the totals | **Comments and `known-gaps.md` only.** ~14 lines. Structurally immune — there is no number left to rot. Loses the ability to jump straight to a line |
| **C · B for the line numbers, A for the counts** | Line citations become symbol-based (they have rotted 5–6 times each); the grep totals are re-derived once because 19/10/9/zero is genuinely informative | ~14 lines, same files. My pick |

**My recommendation: C.** The eight line numbers have now rotted in five recorded positions for
one unmoved declaration — S-49's entry says so itself and then rotted again — and each entry
already advises citing by symbol, so B is just following advice already written down. The grep
*counts* are different: "19 lines, 10 comments, 9 declarations, **zero assignments**" is an
argument, and the zero is the part that matters, so re-deriving it once (option A's half) is
worth the 4 lines. MEDIUM-3 is not part of this choice — adding the `src/`-and-`prisma/` scope to
four sentences is a correction, not a preference, and is required either way.

**None of the three options changes code, tests, or behaviour.** All three are edits to comments,
the epic block, and `known-gaps.md`.

---

## Remaining risks and dispositions

| # | Risk | Disposition |
|---|---|---|
| R1 | `BU125`/`BU126` are tripwires over enumerated forms; a laundering helper, a new alias or a `satisfies` form walks past both — **measured this round**, 0 diagnostics, both censuses green | **Accept.** Stated at measured strength in six places, and I confirmed the hedging holds. The honest framing "countable, not closed" is in the code |
| R2 | `this.prisma`, the `prisma` module singleton and `tx.$executeRaw` remain unguarded | **Out of scope here.** Correctly recorded in S-48's route table, which stays open. Folding into S-48 rather than a new id is ruled correct |
| R3 | `tx.$executeRaw` is bounded by RLS but not by the status seam | **Verified by execution this round** (0 cross-tenant rows, 1 same-tenant row, 1 on a blanket update). S-48 and the epic label it unexecuted — conservative and safe. Recommend citing the measurement |
| R4 | `InvoiceWriteMethod` may go stale on a Prisma upgrade | **Closed as far as silence goes.** `InvoiceDelegateSurfaceCensus` fails `tsc` in both directions, measured. It does not judge whether a *new* member mutates — correctly stated, and S-49 remains the standing entry |
| R5 | Billing's `base.repository.ts` is a fourth variant of five, now 262 lines against 111 | **Accept.** S-19 updated with digest, line count, both intermediate digests and the reason. Unification is S-19's own task across five services |
| R6 | The guard is unreachable in production — nothing writes a non-`DRAFT` status | **Accept and document.** Said in six places; the release note must carry it. MEDIUM-3 is about the *scope* of how it is said, not the fact |
| R7 | The unbound delegate returned by `draftInvoiceWriter` (Round 1 MEDIUM-1) | **Closed by option A as decided.** Reworded in four places with the mutation quoted; re-verified at 0 diagnostics. The structural reshape stays available if an issuance flow lands |
| R8 | Stale numerals recurring a third time | See § *Decision*. This is the only open decision |

### Recommended additions to `.claude/rules/known-gaps.md` — do not let these evaporate

Neither is in scope to fix here.

1. **A `.claude/rules/` citation that names a `file:line` in a file the same commit edits is
   structurally unsafe**, and this task is the third recorded instance (S-33 names the class;
   S-19 and S-49 each carry their own rotted-and-repaired history; MEDIUM-1 above makes it eight
   citations at once, all uniformly +4). S-33's fix direction already proposes a mechanical
   checker but scopes it to greps-and-counts in `apps/*/src` comments. **Extend S-33's fix
   direction** to cover `file:line` citations in `.claude/rules/*.md` pointing into files the
   same commit modifies: that check is trivially mechanical — resolve the line, confirm it
   contains the cited symbol — and it would have caught all eight.
2. **NIT-1's stray worktree** is a symptom worth one line in S-33 or a new hygiene note: Gate-3
   sessions that create `git worktree add` fixtures for `comm`/`diff` baselines should remove
   them, because `.git/worktrees/` survives `git status` and is invisible to every gate.

---

## Required for `APPROVED FOR COMMIT`

1. **MEDIUM-1** — resolve the eight `invoice.repository.ts` citations in `known-gaps.md:521`,
   `:1825`, `:2886`, `:3188` per the § *Decision* answer (all are +4 today).
2. **MEDIUM-2** — resolve the grep totals at `errors/index.ts:136-139`,
   `invoice.repository.ts:507-508` and `plan:739-743` per the same answer. Measured: **19 / 10
   comments / 9 declarations-reads-DDL / zero assignments; 14 on `a87d952`; six added, one
   removed.**
3. **MEDIUM-3** — scope the four universals at `epic:227-228`, `errors/index.ts:134-135`,
   `invoice.repository.ts:505-506` and `billing.integration.test.ts:874-875` to `src/` and
   `prisma/`, as the epic's own heading already is. Not a choice.
4. **LOW-1** — name the insertion point beside the "7 unit failures" figure at
   `known-gaps.md:3031` (7 before the seam call, 4 after).

NIT-1 and NIT-2 are optional. Recommended but not required: cite the executed RLS measurement at
`known-gaps.md:3037` and `epic:212` in place of "read off the policy definition, not executed".

**CONDITIONAL.** Everything above is an edit to a comment, the epic block, or `known-gaps.md`; no
production code, test, or behaviour changes. Re-run the four greps *after* the last edit, not
before — that ordering is the whole finding.

---

## Round 3

**Gate 6 — final senior review (post-QA).** Base `a87d952`, T-048 uncommitted, **12**
`git status` entries (QA's report is the twelfth). Read-only: every mutation below was backed
up by copy, reverted, and the tree proven byte-identical (§ *Tree integrity*). No
`git checkout --`, `git restore` or `git stash` was used on any tracked file.

**Verdict: CONDITIONAL** — 1 HIGH, 2 MEDIUM, 4 LOW. All required fixes are text-only. No
production code, no test logic, no behaviour, no migration, no role, no policy changes.

### Rules revision read

`.claude/rules/known-gaps.md` read **from disk**: **3 313 lines**, md5
`85a60bf3a8db9476030acfd185ab3f76`, working tree on top of `a87d952`, running to **S-50**.
**The copy injected into this session's context ended at S-39** — it could not see S-40, S-46,
S-48, S-49 or S-50, five of which this diff edits. **S-24, eighteenth sighting this session.**
Every citation below was re-derived against disk.

---

## Findings

### HIGH-1 · S-19 now contradicts itself: the diff corrected one byte-identical sentence and left the other, which its own command refutes

`.claude/rules/known-gaps.md:608-609`

```
reason is this entry: `md5sum apps/*/src/repositories/base.repository.ts` shows `analytics`,
`billing` and `worker` still byte-identical (`13a533a2e2c2dcc1ff9db28fb5c7a1fd`), and that identity
is the evidence this entry rests on.
```

**Refuted by running that exact command on the shipped tree:**

```
13a533a2e2c2dcc1ff9db28fb5c7a1fd  apps/analytics-service/src/repositories/base.repository.ts
8b12b7d596af50a038f5a79c1361b8a5  apps/auth-service/src/repositories/base.repository.ts
eebd37628f6e20e17fa5e7140221c47b  apps/billing-service/src/repositories/base.repository.ts   <-- 262 lines
d2e8d92fd494fb779f4dea7238273b4a  apps/usage-service/src/repositories/base.repository.ts
13a533a2e2c2dcc1ff9db28fb5c7a1fd  apps/worker-service/src/repositories/base.repository.ts
```

**T-048 is what made it false, and T-048 edited this entry.** At `a87d952` the file carried the
same claim twice — `:474` and `:573`. The diff rewrote `:474` into
*"`analytics` and `worker` are byte-identical … **`billing` was a third member of that set until
T-048 and is not any more**"* and added the fourth-variant bullet at `:482`. The second instance,
now at `:608-609`, was not touched (`git diff .claude/rules/known-gaps.md | grep "still
byte-identical"` → no output). The entry therefore states the correct digest at `:476` and the
superseded one 130 lines later.

**HIGH, not LOW, and the reason is the standard's, not mine.** `CLAUDE.md` designates
`.claude/rules/` authoritative and instructs agents to trust it **without re-verification**; the
review standard grades a false claim there HIGH. This one also presents itself as the evidence
base for a decision (T-042's) — *"that identity is the evidence this entry rests on"* — so a
reader is told to rely on it. It is the same defect class as Round 2's MEDIUM-1 (citation-rot
repairs that are themselves stale), recurring one paragraph below the repair.

**Concrete fix**, at `:608-611`:

- `analytics`, `billing` and `worker` still byte-identical → **`analytics` and `worker` still
  byte-identical**, and add *"billing left that set at T-048 — see the first bullet of this
  entry"*.
- `Editing one of the three` → **`Editing either of the two`**.
- `would create a fifth distinct variant` is **still correct** and should be left: the variants
  are now analytics/worker, auth, usage and billing, so editing worker makes a fifth. Verified —
  do not "fix" that numeral along with the others.

---

### MEDIUM-1 · Round 2's MEDIUM-3 has a seventh site, added by this diff, live and unqualified — in `tests/`, the exact scope the correction was about

`apps/billing-service/tests/invoice.repository.unit.test.ts:1240-1241` (inside `BU123`)

```
    // **This case does not prove production behaviour.** Nothing on the platform writes a
    // non-`DRAFT` status -- `createDraftInvoice` writes the `DRAFT` constant and is the only
    // statement that sets `Invoice.status` at all -- so the state exists here only because the
    // double is handed it.
```

**New in this diff** — `git diff apps/billing-service/tests/invoice.repository.unit.test.ts`
shows both lines as `+`, and `git show a87d952:… | grep -c BU123` → `0`.

MEDIUM-3 was reported fixed at six sites, and I confirm all six carry the `src/`-and-`prisma/`
scope (epic `:234`; `errors/index.ts:132`; `invoice.repository.ts:504`;
`billing.integration.test.ts:818`; `integration.constants.ts:233` and `:249`). This is a
**seventh**, and it is the unscoped form:

- *"Nothing on the platform writes a non-`DRAFT` status"* and *"the only statement that sets
  `Invoice.status` **at all**"* — both unbounded.
- **False as written.** `grep -rn "status: InvoiceStatus\.\(FINALIZED\|PAID\)"
  apps/billing-service/tests` → **17** lines, **6** of them database writes in
  `billing.integration.test.ts` (`:848`, `:909`, `:1319`, `:1327`, `:1420`, `:1469`, at five
  `seedInvoices` call sites). And the sentence's own case is refuted two lines below it: `BU123`
  hands `InvoiceStatus.FINALIZED` to a double.
- It escaped QA's sweep because that sweep searched the word **"anywhere"**; this instance spells
  the same universal **"at all"**. The remaining three "anywhere"/"at all" occurrences
  (`errors/index.ts:138`, `integration.constants.ts:238`,
  `billing.integration.test.ts:822`/`:890`) are all explicitly labelled quotations of the
  superseded wording — checked individually, and correct.

**Concrete fix:** make `:1240-1241` read *"Within `src/` and `prisma/`, `createDraftInvoice`
writes the `DRAFT` constant and no other statement sets `Invoice.status`; `tests/` does set it —
six times, all through `seedInvoices` on the owner connection — so the state exists here only
because the double is handed it."*

**This edit does not disturb the 19-count** (see LOW-1): the census grep reads
`apps/*/src packages/*/src prisma` and never `tests/`.

---

### MEDIUM-2 · QA F-3 upheld by execution — the plan's "7 × `TS2339` on legitimate reads" is 5 reads and 2 writers, and it contradicts the shipped docblock

`docs/plans/t-048-invoice-immutability-guard.md:100`, `:250`, `:395`, `:590`

**Re-derived independently of QA.** Both repository files restored to `a87d952` by
`git show … >` (never `git checkout`), `| "invoice"` added to `TransactionClient`'s `Omit`, then
`pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json`:

```
total: 11        7 × TS2339      2 × TS2345      2 × TS7006
336: const invoice  = await tx.invoice.findUnique({           read
445: const invoice  = await tx.invoice.create({               WRITER
595: const existing = await tx.invoice.findUniqueOrThrow({    read
604: const invoice  = await tx.invoice.update({               WRITER
654: const rows     = await tx.invoice.findMany({             read
662: const total    = await tx.invoice.count({ where });      read
740: const row      = await tx.invoice.findFirst({            read
```

**Five reads, two writers.** `base.repository.ts:145-148` says exactly that and is **correct**;
S-48's paragraph in `known-gaps.md` says exactly that and is **correct**; the plan is wrong in
four places, and the plan ships in the same commit. The conclusion (the wholesale `Omit` is not
viable) is unaffected — it broke five things it should not have, not seven.

**Concrete fix:** at all four plan sites, *"11 errors — 7 × `TS2339`, **five of them legitimate
reads and two the writers**, 2 × `TS2345`, 2 × `TS7006`"*.

---

### LOW-1 · QA F-2 upheld — "six added, one removed" reproduces under no consistent rule. Adopt QA's fix

`apps/billing-service/src/errors/index.ts:148` · `apps/billing-service/src/repositories/invoice.repository.ts:511` ·
plan §12.5 and §13.2

**Ruled on, after re-deriving both revisions myself** (`git archive a87d952 | tar -x` into the
scratchpad — no worktree registered):

| File | `a87d952` | working tree | delta |
|---|---|---|---|
| `src/constants.ts` | 0 | 1 | **+1** |
| `src/errors/index.ts` | 3 | 3 | **0** |
| `src/repositories/base.repository.ts` | 0 | 1 | **+1** |
| `src/repositories/invoice.repository.ts` | 5 | 8 | **+3** |
| validator / schema / migration | 6 | 6 | 0 |
| **total** | **14** | **19** | **+5** |

Per-file deltas give **5 added, 0 removed**. `comm` over normalised text gives **7 added, 2
removed** — `errors/index.ts` had three matching lines at base (`:132`, `:133`, `:136`) and has
three now (`:132`, `:133`, `:153`), of which two were reworded in place. "Six / one" counts one
of those two rewords as add-plus-remove and the other as neither. All three arithmetics reach 19,
which is why it survived four derivations. **QA's diagnosis is exact and its fix is right.**

**Everything load-bearing reproduces**, hand-classified across all 19 lines: **10 comments**
(`errors/index.ts:132,133,153`; `invoice.repository.ts:88,479,503,504`;
`base.repository.ts:122`; `invoice-list.validator.ts:9`; `constants.ts:131`) and **9
declarations, reads and DDL** (`invoice.repository.ts:101,197,829,919`;
`schema.prisma:131,141,142`; `v1_0/migration.sql:3,89`). **Zero assignments** — confirmed; `:829`
and `:919` assign `finalizedAt` into a *response object*, which is a read.

**Concrete fix (QA's):** drop the split at both `src/` sites and both plan sites; keep *"19
matching lines, 10 comments, 9 declarations, reads and DDL, **zero assignments**; 14 on
`a87d952`."*

**The trap that broke the last two derivations, pre-checked so it does not break this one:** the
two sentences to edit are `errors/index.ts:148` and `invoice.repository.ts:511`, and **neither
line matches the census grep** (verified — the matching lines in those files are `:132/:133/:153`
and `:88/:479/:503/:504/:829/:919`). So this fix leaves the count at 19 and **no re-derivation is
required after it**. State that in the edit rather than re-running and re-recording.

---

### LOW-2 · A brand-new `file:line` citation in `src/`, stale inside the commit that moved its target

`apps/billing-service/src/constants.ts:130`

```
// declaration and its single use at `errors/index.ts:156`. **No test asserted the string**;
```

- `grep -rn "MESSAGE_INVOICE_IMMUTABLE" apps/billing-service/src apps/billing-service/tests` puts
  the single use at **`errors/index.ts:176`**.
- It was `:156` at `a87d952` (`git show a87d952:apps/billing-service/src/errors/index.ts | grep -n`
  → `156`). T-048's own `errors/index.ts` hunk added 20 lines above it.
- The line is **added by this diff** (`+` in `git diff apps/billing-service/src/constants.ts`).

This is the precise defect the Round-2 rework spent a round eliminating from `known-gaps.md` —
`grep -c "invoice.repository.ts:[0-9]" .claude/rules/known-gaps.md` → **0**, verified — while
introducing a fresh one in `src/`. It is LOW because the same sentence carries the grep that
locates the target, so a reader recovers in one command.

**Concrete fix:** drop the line number. *"…this declaration and its single use in
`errors/index.ts` (`grep -n "MESSAGE_INVOICE_IMMUTABLE" apps/billing-service/src`)"* — the
symbol-plus-command form this task adopted everywhere else.

---

### LOW-3 · "`BU125` counts the cast **targets** it lists" — measured false for the listed target in the other assertion syntax

`apps/billing-service/src/repositories/base.repository.ts:116` ·
`apps/billing-service/src/repositories/invoice.repository.ts:323`

Both say the census counts the cast **targets** it lists. The guarded unit is a *(target,
`as`-syntax)* pair, and I varied the dimension no gate had varied — cast **syntax**, holding the
enumerated target fixed. Inserted after the seam call in `absorbLateUsage`:

```ts
const widened = <FullTransactionClient>(<unknown>tx);
void widened.invoice.updateMany;
```

| Check | Result |
|---|---|
| `pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json` | **0 errors** |
| `pnpm --filter @telemetry/billing-service lint` | **0 findings** |
| `vitest run tests/invoice.repository.unit.test.ts` | **37 passed (37)** — `BU125` and `BU126` both green |
| `grep -rn "FullTransactionClient>" apps/billing-service/src` | finds it — the listed target *is* spelled in `src/` |

Every `FULL_DELEGATE_CAST_PATTERNS` entry is anchored on `\bas\s+`, so the angle-bracket type
assertion is invisible to all four. **This is cheaper than any evasion found so far** — Round 1's
delegate cast, Round 2's `reinterpret<T>` and QA's E1/E2 all changed the target or moved the
widening into an annotation; this one writes the census's own identifier verbatim.

**It does not exceed the declared guarantee**, and I confirm QA's conclusion on that point: the
adjacent sentences — *"A regex census catches the forms it enumerates and nothing else"*
(`base.repository.ts:118`), *"A fifth spelling would still be missed"* (`:125`), and the test
docblock's *"the cast targets … **in the spellings we know how to write**"*
(`invoice.repository.unit.test.ts:1031`) — are all true of it. Only the two "targets it lists"
sentences read as target-scoped when the reach is narrower.

**Also verified against all four known forms**, as asked: *"it has to be spelled as a cast"*
(`:115`) survives — `reinterpret<T>` has `as T` in the helper, QA's E2 has `as never`, this one
is an angle-bracket assertion. No cast-free widening of `tx` was found.

**Concrete fix (choose one; both are text-only):**
- reword both sites to *"counts the cast targets it lists **when written with `as`**"*, or
- add a fifth pattern `/<\s*(?:FullTransactionClient|PrismaClient|Prisma\.[A-Za-z0-9_]+Delegate|any)\s*>/g`
  to `FULL_DELEGATE_CAST_PATTERNS` — which **is** a test-logic change, and the probe above is the
  case that proves it red.

I recommend the reword and recording the probe in S-48 beside E1/E2/`reinterpret<T>`, because the
pattern list is the thing this task has already widened twice and a third widening restates the
guarantee it already declares honestly.

---

### LOW-4 · QA F-1b — the property and the comment, as already decided

`apps/billing-service/tests/invoice.repository.unit.test.ts:1095-1103`
(`EXPECTED_PUBLIC_ASYNC_METHODS`)

Recorded with the user's decision, not re-opened. `BU126` censuses member **names**; when it goes
red at `expected [Array(7)] to deeply equal [Array(8)]`, adding the new name to the list is the
natural response and silently discharges the guard — QA measured package **213/213** with an
unguarded `finalizeInvoice` in the file and its name on the list.

**Required, per the user's decision (QA option B):** a new `known-gaps.md` entry recording the
property, **plus one comment above `EXPECTED_PUBLIC_ASYNC_METHODS`** saying that appending a name
asserts the member has been reviewed against `draftInvoiceWriter`. Next free id is **S-51**.

**Comment hazard, flagged because this task hit it twice:** a glob containing `*/` inside a block
comment terminates it (`TS1443`). The `EXPECTED_PUBLIC_ASYNC_METHODS` comment must not spell
`src/**/*.ts` or similar inside `/** … */`.

---

### QA F-4 and F-5 — ruled, no action now

- **F-4 upheld.** `grep -rn "status: InvoiceStatus\.\(FINALIZED\|PAID\)" apps/billing-service/tests`
  → **17**, six of them database writes at five `seedInvoices` sites. The figure is a census of a
  *literal spelling*: an ordinary extraction of BI23's fixture into a parameterised helper takes
  it to 16 and the `seedInvoices` figure from six to five while the number of tests seeding a
  non-`DRAFT` status is unchanged. It under-reports **silently**. Correctly left for whoever next
  edits those comments — fold it into S-51 if that entry is written anyway.
  *(The epic's shipped BRE spelling at `epic-8:244-245` does work — I ran it as written: **17**.
  QA's "trap" is the third spelling, an ERE pattern without `-E`, which returns **0**. All three
  measured here.)*
- **F-5 upheld, informational.** The 19-count's stability is a property of the current phrasing,
  not a structural guard — one ordinary new sentence mentioning `FINALIZED` in any `src/` docblock
  the grep reads takes it to 20. This is the argument *for* F-2's fix, and LOW-1 above pre-checks
  the two fix sites against it.

---

## What I verified

### Priority 1 — the tree passed through a reconstruction, and it reads faithful

QA disclosed a `git checkout --` on one file, four restores from pre-mutation copies, and
**three files reconstructed** from a session-start diff: `src/constants.ts`, `src/errors/index.ts`,
`tests/integration.constants.ts`. Checksums are not a proof of faithfulness, so I read them as
code and prose and audited them structurally:

- **`base.repository.ts` read end to end (262 lines).** The narrowing, both unions, the census
  alias and the `withTenant` body are complete and internally consistent. `fn(tx)` passes the full
  `Prisma.TransactionClient` into the narrowed parameter type, which is sound (wider → narrower).
  `FullTransactionClient`'s six-member `Omit` does match Prisma 6's `ITXClientDenyList`.
- **`invoice.repository.ts` diff read in full.** `draftInvoiceWriter` reads through the *narrowed*
  delegate (`findUniqueOrThrow`, which the narrowing leaves), throws before returning the writer,
  and returns `this.invoiceDelegate(tx)`. `absorbLateUsage`'s inline check is gone and its
  `tx.invoice.update` is now `writer.update` on the same `periodKey`. `createDraftInvoice` reaches
  the delegate directly (D5). No orphaned reference to the removed `existing` binding.
- **Every deletion in the three reconstructed files accounted for.** `git diff | grep "^-"` returns
  **3** lines in `constants.ts` (two comment lines plus the reworded message), **7** in
  `errors/index.ts` (all comment) and **5** in `integration.constants.ts` (all comment). **No code
  was lost in any of them.** Line counts moved 276→289, 182→202, 408→422 — all growth.
- Independent of QA: `git diff --stat` = **9 files, 1284 insertions, 82 deletions**;
  `invoice.repository.ts` md5 `1669fb73b08894ea46cd7491a83f2e3e`, `base.repository.ts`
  `eebd37628f6e20e17fa5e7140221c47b` — both matching QA's end-state figures and S-19's recorded
  digest.

**Nothing reads as damaged, truncated or subtly reverted.** The two defects I found in these files
(LOW-2's stale citation in `constants.ts`, and MEDIUM-1 in the unit test, which was *not*
reconstructed) are authorship defects, not reconstruction artefacts: both trace to `+` lines in the
diff that QA's capture also contains.

### Priority 2 — the guarantee, adversarially

- **QA's E2 re-performed**: `const fullE2: FullTransactionClient = tx as never;` → **0
  diagnostics**. Reproduces.
- **Two further widenings at 0 diagnostics**: `<FullTransactionClient>(<unknown>tx)` (LOW-3, new)
  and `tx as unknown as never` into an annotation.
- **Every hedge in the diff checked against all four known forms** (Round 1's `protected` +
  delegate cast, Round 2's `reinterpret<T>`, QA's E1/E2, and LOW-3's angle-bracket). Only the two
  "cast targets it lists" sentences read wider than the reach. **I found no overclaim that exceeds
  the declared guarantee** — QA's central conclusion holds, and LOW-3 is a precision defect inside
  it, not a refutation of it.
- **`BU125`'s subject verified**: the four enumerated patterns match **exactly one** line in
  `apps/billing-service/src` — `invoice.repository.ts:461`, inside `invoiceDelegate`.

### Priority 4 — the pre-QA checks, on the tested revision

- **Citation form.** `grep -c "invoice.repository.ts:[0-9]" .claude/rules/known-gaps.md` → **0**.
  **Four shipped commands run**, all locating what they claim: S-19's
  `grep -rn "extends TenantScopedRepository" apps/*/src | grep "export class"` → four subclasses
  (`meter :35`, `invoice :355`, `usage :150`, `worker event :73`); S-40's
  `grep -n "skip: (query.page - 1) * query.pageSize"` → `:814`; S-48's
  `grep -n "markUsageLinesBilled"` → declaration at `:563`; S-49's
  `grep -rn "invoiceLineItem\." apps/*/src --include=*.ts` → exactly **5** comment lines,
  `:679/:694/:696` in `absorbLateUsage` and `:855/:881` in `findDetailById`, the **3 + 2**
  attribution exact.
- **The count.** **19** re-derived from the shipped grep, **14** re-derived from a `git archive` of
  `a87d952`, 10 comments / 9 declarations-reads-DDL classified line by line, **zero assignments**.
  Stable on re-run. The split is LOW-1.
- **The type-level census, re-derived from the generated client** with `ts.createProgram` +
  `checker.getPropertiesOfType` (not read off the alias): `PrismaClient["invoice"]` **18**,
  `FullTransactionClient["invoice"]` **18**, `TransactionClient["invoice"]` **9** — exactly
  `aggregate, count, fields, findFirst, findFirstOrThrow, findMany, findUnique, findUniqueOrThrow,
  groupBy`, with a `symbol` index signature on all three. Both mutations give
  `error TS2344: Type 'false' does not satisfy the constraint 'true'` (add `"probeFutureWrite"` →
  `(94,2)`; delete `"groupBy"` → `(93,2)`), and a bare `keyof` gives the same `TS2344` **on the
  unmutated tree**. **Additionally verified, which QA did not re-run:** `FullTransactionClient`
  carries exactly **four** `$`-methods — `$executeRaw`, `$executeRawUnsafe`, `$queryRaw`,
  `$queryRawUnsafe` — enumerated from the type, confirming `base.repository.ts:137-139`.
- **The RLS execution, re-run rather than read.** Two `DRAFT` invoices seeded through the owner
  connection; one `psql` session as `telemetry_app` with `rolsuper = f` and `rolbypassrls = f`
  read from `pg_roles` **on that connection**, inside a single `ROLLBACK`ed transaction after
  `set_config('app.tenant_id', <A>, true)`:

  | Statement | Rows |
  |---|---|
  | cross-tenant `UPDATE … WHERE id = <B's invoice>` | **0** |
  | same-tenant `UPDATE … WHERE id = <A's invoice>` | **1** |
  | blanket `UPDATE "Invoice" SET currency='XXX'` — no `WHERE` | **1, not 2** |

  All three reproduce, and the same-tenant statement **did** reach `FINALIZED` — so the raw route
  bypasses the **status seam**, not tenant isolation, exactly as the three relabelled documents
  say. Rolled back; probe rows deleted; counts re-checked.
- **MEDIUM-3's six sites** all carry the `src/`-and-`prisma/` scope, including the two no review
  listed (`integration.constants.ts:233` and `:249`). The seventh is MEDIUM-1 above.
- **The mutation totals.** M1 (delete the `DRAFT` guard) re-run: `Tests 5 failed | 208 passed
  (213)`, failing set **BI23, BI34, BU100, BU123, BU124** — exact, derived from vitest's JSON
  reporter rather than read off the terminal.

### Priority 5 — final-review scope

- **Test coverage alignment.** Six new cases — `BI34`, `BU123`–`BU127` — taking billing 207 → 213.
  `BU125`/`BU126` read `src/` off disk and both helpers **throw** when their subject is missing
  rather than counting zero (QA measured the throw; the pattern is `.claude/rules/testing.md`'s).
  No tautological case found: `BU123` asserts *what the seam judged* (the `where` shape, the two
  selected columns, no foreign tenant id), not merely that an error was thrown; `BU127` asserts
  read-before-write ordering through `invocationCallOrder`. Error paths are covered for both
  non-`DRAFT` statuses the schema declares, and `BU124` reddens if a migration adds a third.
- **Acceptance criteria.** All five met. AC1/AC5 proven non-vacuous by M1's exact named set; AC4 by
  M2 (QA re-ran it and I accept that, having reproduced M1); AC2 by QA's direct-repository drive;
  AC3 stated at the honest strength and correctly scoped.
- **T-049's last case closes here — confirmed.** `docs/epics/epic-8-billing-service.md` now marks
  *"Attempt to update `FINALIZED` invoice → `409 INVOICE_IMMUTABLE`"* closed by `BI23` +
  **`BI34`**. `BI34` exists at `billing.integration.test.ts:895`, covers the `PAID` sibling that
  nothing had driven at any layer, and **goes red under M1**. The sibling bullet's T-047 claim also
  checks out: `BI29:1698` and `BI30:1739` exist.
- **Breaking-change assessment across the other 12 packages: none.** `FullTransactionClient` and
  `TransactionClient` are billing-local — nothing outside `apps/billing-service` imports them
  (`grep -rn "base.repository" apps/*/src packages/*/src` outside billing returns only the four
  other services' own `TenantScopedRepository` re-exports). The other four `base.repository.ts`
  copies are byte-unchanged. `markUsageLinesBilled`'s narrowed parameter is private with two
  in-file call sites. `MESSAGE_INVOICE_IMMUTABLE`'s reword is not asserted by any test. No
  migration, role, policy or trigger change. The other 11 test-bearing packages ran at their
  pre-change totals.
- **S-19 fourth variant.** Correctly recorded with the shipped digest and 262 lines; the subclass
  table correctly gains no row (billing's two subclasses already sat over billing's copy). The one
  defect is HIGH-1, which is the *other* sentence in the same entry.

### Compile-time gate — all 13 packages, `--force`, nothing cached

`pnpm build --force` does not forward the flag, so build ran as `npx turbo run build --force`.

| Task | Command | Result |
|---|---|---|
| typecheck | `npx turbo run typecheck --force` | **13 successful, 13 total · 0 cached** |
| lint | `npx turbo run lint --force` | **13 successful, 13 total · 0 cached** · 14 warnings, 0 errors |
| build | `npx turbo run build --force` | **13 successful, 13 total · 0 cached** |
| test | `npx turbo run test --force` | **13 successful, 13 total · 0 cached** |

**Per-package test totals, root derived by me** (twelve report; `@telemetry/web` contributes 0):

| Package | Files | Tests |
|---|---|---|
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-types` | 1 | 8 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/usage-service` | 19 | 230 |
| **`@telemetry/billing-service`** | **19** | **213** |
| `@telemetry/auth-service` | 15 | 166 |
| `@telemetry/worker-service` | 17 | 234 |
| `@telemetry/web` | — | 0 |
| **Derived total** | **88** | **950** |

4+8+4+2+15+18+38+18+230+213+166+234 = **950**. Billing **213** and root **950** as stated.
`pnpm test:smoke` — **6 suites, 7 tests**, all passing. **Worker's `I24` did not flake**, so no
per-package re-run was needed.

**The 14 lint warnings are pre-existing, proven by provenance:**

- 10 × `@typescript-eslint/no-misused-promises` — `apps/auth-service/tests/auth.service.unit.test.ts`,
  `git log -1` → `d68e719` (2026-08-25).
- 4 × `@typescript-eslint/no-unsafe-assignment` — `apps/usage-service/tests/ingestion.service.unit.test.ts`,
  `git log -1` → `b0f6921` (2026-08-31).
- **Zero `no-unsafe-return`.** Neither file appears in `git diff --name-only`.

### Clean-code gate

No new findings. Route paths, header names, status codes, error codes and messages all come from
`BILLING_RESPONSES` / `BILLING_METERING`; the seam compares against
`BILLING_METERING.INVOICE_STATUS_DRAFT` rather than a literal; the two new fixture totals are
named constants (`FINALIZED_TOTAL`, `PAID_TOTAL`) and deliberately distinct so a copy-paste of the
wrong status cannot satisfy the unchanged-total assertion. `EXPECTED_WIDENING_COUNT`,
`WIDENING_ACCESSOR_DECLARATION` and `FORBIDDEN_PARAMETER_NAMES` are constants rather than inline
literals in the census. Round 2's NIT-2 (the modifier list spelled twice in two regexes) is
unchanged and remains a NIT.

### Environment discipline

- Redis db 0 `DBSIZE` **1** before my first gate run, **2** after — an auth-service TTL'd
  `denylist:<jti>` key (S-22), self-expiring. **I wrote nothing to db 0.**
- `Tenant` **2** at start and at end; `Event` / `UsageLine` / `Invoice` / `InvoiceLineItem` /
  `Meter` all **0** at start and at end. My two probe invoices were seeded through the owner
  connection and deleted.
- Five `telemetry*` roles intact, all `NOSUPERUSER NOBYPASSRLS`. `v1_7_worker_billing_enumerator`
  present. **No migration rolled back, no role dropped, no trigger created** — `pg_trigger` on
  `"Invoice"` returns **0** non-internal triggers.

### Tree integrity

- `md5sum -c` against my pre-probe capture of **all 12** changed/untracked paths: **all OK**.
- `diff <(git diff) <pre-probe capture>` → **byte-identical**.
- `git diff --stat` → 9 files, **1284 insertions, 82 deletions**. `git status --porcelain` → the
  same **12** paths. Nothing staged, committed or branched. `git worktree list` → main only
  (Round 2's NIT-1 stays closed).

---

## What I could not verify, and why

- **Production behaviour of the guard.** Unreachable by construction — no statement in `src/` or
  `prisma/` writes a non-`DRAFT` status, so every case seeds through the owner connection or a
  double. The change says so in seven places; six are correctly scoped and the seventh is
  MEDIUM-1.
- **Whether a sixth, seventh or nth widening spelling exists.** I found one the four prior gates
  had not (LOW-3) by varying syntax rather than target. I cannot enumerate the space, and the
  finding that a fifth existed after two widenings is itself evidence the list is smaller than the
  space — which the docs say.
- **That QA's reconstruction is byte-faithful to the implementer's original.** The implementer's
  pre-QA copy no longer exists anywhere I can reach; there is no commit, stash or worktree to diff
  against. What I *can* say is stated in Priority 1: the diff is structurally complete, every
  deletion is an intended reword, no code was lost, and the two defects in those files trace to
  `+` lines rather than to damage. **This is the strongest available statement and it is not a
  proof.** If certainty is wanted, the implementer should diff their own scratch copy before
  commit.
- **QA's M2 mutation** (inverting the guard to `===`). I reproduced M1 with its exact named set
  and accepted M2 on QA's re-derivation rather than spending a third run on it. Labelled as
  accepted-on-report, not measured here.
- **The `prisma` module singleton and `tx.$executeRaw` routes** (S-48's table). Not re-run — I ran
  the RLS half, which is the load-bearing half, and spent the remaining budget on the widening
  probes. S-48 stays open and correctly says so.
- **`.github/agents/`** (S-14) — out of scope, not drivable here.

---

## Remaining risks and dispositions

| # | Risk | Disposition |
|---|---|---|
| R1 | `BU125`/`BU126` are tripwires over enumerated sets; at least five widening spellings now known to walk past them, one of them naming the census's own identifier | **Accept.** The declared guarantee is "visible, not impossible" and every shipped hedge is true of all five. LOW-3 tightens two sentences |
| R2 | `this.prisma`, the `prisma` module singleton and `tx.$executeRaw` reach the delegate with no cast at all | **Accept** — recorded in S-48, which stays open. RLS still bounds the tenant dimension on all three; only the status seam is bypassed |
| R3 | `InvoiceLineItem` still has no RLS (S-10) and the client's statement-suppression is load-bearing (S-49) | **Accept, unchanged by T-048.** `BI9`/`BI32` stand as markers; the seam does not touch that delegate |
| R4 | billing's `base.repository.ts` is now a **fourth** variant of a five-copy class | **Accept, recorded in S-19** with the shipped digest. Unification is S-19's own task, and the narrowed set is billing-specific — a shared `@telemetry/shared-db` cannot carry this `TransactionClient` as-is |
| R5 | The seam's read is `findUniqueOrThrow` → `update` in one transaction with **no `FOR UPDATE`** (`grep -rn "FOR UPDATE" apps/billing-service/src` → none), so two concurrent callers could both read `DRAFT` | **Latent only** — nothing on the platform can finalize an invoice, so the interleaving is unreachable today. Sibling of S-38. **Recommend a `known-gaps.md` entry** — see below |
| R6 | `BU126` notifies that the member set changed, not that the new member is guarded | **Decided by the user** — record + one comment (LOW-4) |
| R7 | The `seedInvoices` census counts a literal spelling and under-reports silently after a refactor (QA F-4) | **Accept**, fold into S-51 |

### Recommended additions to `.claude/rules/known-gaps.md` — do not let these evaporate

Two, both out of scope to *fix* here. Next free id is **S-51**.

1. **S-51 · `BU126` is a notification, not a guard** — QA's F-1b, per the user's decision. Include
   QA's measurement (package 213/213 with an unguarded `finalizeInvoice` present and its name on
   the list), LOW-3's angle-bracket probe alongside E1/E2/`reinterpret<T>` in S-48's table, and
   F-4's note that the `seedInvoices` figure is a spelling census.
2. **S-52 · the seam's read is not locking.** `draftInvoiceWriter` does `findUniqueOrThrow` then
   `update` in one transaction with no row lock and Prisma's default isolation. Unreachable today;
   to be settled by whichever task builds invoice finalization. The vacuity trap S-38 records
   applies verbatim — a naive `Promise.all` case passes whether or not the interleaving occurred.

---

## What no artifact says, and an operator or the next task needs to know

1. **Finalization does not exist, and this guard is the *only* thing waiting for it.** Nothing in
   `src/` or `prisma/` writes `FINALIZED` or `PAID`. Whoever builds issuance inherits three
   obligations that live only in scattered docblocks: route the write through
   `draftInvoiceWriter`; take a row lock (R5); and re-derive the 19-count, because their change
   will be the first to make the "zero assignments" half false.
2. **The seam returns an unbound delegate.** `draftInvoiceWriter` checks the row named by `key`
   and hands back the **whole** invoice delegate. A caller that then writes through a *different*
   key is unchecked and compiles clean. Round 1's MEDIUM-1 dispositioned this as a reword; it is
   recorded in the docblock but in **no** gap entry, so a reader who never opens
   `invoice.repository.ts` will not meet it.
3. **`this.prisma` is the route the epic's own T-048 snippet writes**, and the narrowing does not
   reach it. Anyone implementing from the epic snippet will produce an unguarded write that runs
   outside `withTenant` with no tenant context set at all. S-48 and the epic's correction block
   both say so — but the snippet is still above the correction.
4. **Nothing rolls back.** No migration, role, policy or trigger changed, so there is no
   deploy-order or rollback lever for this task beyond reverting the commit.

---

## Required for `APPROVED FOR COMMIT`

All text-only. None touches `src/` behaviour, test logic, the database or the build.

1. **HIGH-1** — `known-gaps.md:608-609`: `analytics`, ~~`billing`~~ and `worker`; `one of the
   three` → `either of the two`; leave `fifth distinct variant` alone.
2. **MEDIUM-1** — `invoice.repository.unit.test.ts:1240-1241`: scope the universal to `src/` and
   `prisma/` and name the six `tests/` writes, as the other six sites do.
3. **MEDIUM-2** — the plan at `:100`, `:250`, `:395`, `:590`: *"five of them legitimate reads and
   two the writers"*, matching `base.repository.ts:145-148`.
4. **LOW-1** — drop the added/removed split at `errors/index.ts:148`,
   `invoice.repository.ts:511` and plan §12.5/§13.2; keep 19 / 10 / 9 / **zero assignments** / 14.
   Neither `src/` site matches the census grep, so **no re-derivation is needed after this edit**.
5. **LOW-2** — `constants.ts:130`: drop `errors/index.ts:156`; cite the symbol plus the grep.
6. **LOW-3** — qualify `base.repository.ts:116` and `invoice.repository.ts:323` to "when written
   with `as`", *or* add the fifth pattern. Reword recommended.
7. **LOW-4** — the user's decision: one `known-gaps.md` entry (**S-51**) plus one comment above
   `EXPECTED_PUBLIC_ASYNC_METHODS`. Watch `TS1443` — no `*/` inside the block comment.
8. **Recommended, not required** — add **S-52** (R5, the non-locking seam read).

**Re-run after the edits:** `npx turbo run typecheck lint test --force` for the two `src/` comment
edits and the test-file edit (the census reads `src/` off disk, so a `src/` comment change *can*
move `BU125`). Nothing else needs re-running; the four greps are pre-checked above.

**Safe to commit once 1–7 land.** The behaviour is correct, transactional and tenant-scoped; the
structural guard does what it claims at the strength it claims; the gate is green across all 13
packages under `--force` on an uncached run; and no other package is affected. Every remaining
defect is a sentence.

**CONDITIONAL.**
