# Senior Review — S-45 · late-usage absorption (billing-service)

## Round 1

**Gate 4 (pre-QA).** Base `07ed02a`, nothing staged or committed. Read-only: every mutation below
was reverted and the tree proven byte-identical (`md5sum` over all
`apps/billing-service/{src,tests}/**/*.ts` = `b66221646429f79536053b3a13210ee2` before the first
mutation and after the last). `git status --porcelain` is identical to the start of the review.

**Verdict: CONDITIONAL.** No blocker. Tenant isolation, injection, atomicity, precision,
chunking and the red-before-green claims all re-derived by execution and all hold. The required
fixes are four claim-accuracy defects — three of them refuted by re-running the mutation the
claim itself names — plus one coverage gap and one decision for the user (a gap id).

Rules read from disk at review time (`cat`, per S-24): `.claude/rules/review-standards.md`,
`known-gaps.md` (ends at **S-45**, the entry this change edits), `tenant-isolation.md`,
`constants.md`, `testing.md`, `git-commit.md`, `CLAUDE.md`.

---

## Findings

### MEDIUM-1 · `invoice.repository.ts:463-465` — "Neither is a guard against reintroducing the parameter" is refuted by the mutation it names

The absorb docblock reads:

> `BU99` pins that call shape and `BI24` pins the outcome … **Neither is a guard against
> reintroducing the parameter**, and that was measured rather than assumed: adding `invoiceId`
> and addressing the line items by it leaves `BI24` green …

The second half is true. The first half is false, and the change's own mutation refutes it. The
implementer measured the *integration* suite only; the repository unit suite goes red.

Re-performed, both mutations, both reverted:

| Mutation | Integration suite | `invoice.repository.unit.test.ts` |
|---|---|---|
| **B** — add `invoiceId: string` to `AbsorbLateUsageInput`, write line items with `tx.invoiceLineItem.create({ data: { invoiceId: input.invoiceId, … } })`, service passes `existingInvoiceId` | **28 passed / 1 failed**, the failure `BI25` (calls the repository directly, no longer type-matches) — `BI24` green, exactly as claimed | **1 failed / 26 passed** — **`BU99` red** |
| **C** — add `invoiceId: string`, keep the nested `create`, address `findUniqueOrThrow` and `update` by `{ id: input.invoiceId }` | 28 passed / 1 failed (`BI25` again), `BI24` green | **1 failed / 26 passed** — **`BU98` red**, `AssertionError: expected { id: undefined } to deeply equal { …(1) }`, the expected object being `tenantId_periodStart_periodEnd` |

So both realistic forms of "reintroduce the parameter and use it" are caught by a named unit
case. What is *not* caught is a parameter that is declared and never used, which is a no-op.
`BU98` is not mentioned anywhere in the passage, and it is the case that catches the dangerous
form — a foreign invoice named at the call site.

**Fix** — replace `invoice.repository.ts:463-465` with the measured statement, naming both cases
and both mutations:

> `BU98` pins the address (compound unique with the bound tenant) and `BU99` pins the line-item
> route (nested create, never `tx.invoiceLineItem.create`); `BI24` pins the outcome against a
> live database. Measured: adding an `invoiceId` parameter and addressing the line items by it
> reddens `BU99` (integration 28/29 green, `BI24` among them); adding it and addressing the
> *invoice* by it reddens `BU98`. What no behavioural case can catch is the **tenant predicate**
> itself — dropping it entirely is 29/29 green, because the read runs inside `withTenant` and
> `"Invoice"` RLS is enabled, so an untenanted predicate still sees only the bound tenant's row.

The same correction is needed at the two places that repeat the incomplete list:
- `apps/billing-service/tests/billing.integration.test.ts:894` — "checkable by grep plus `BU99`'s
  call-shape assertion" → add `BU98`.
- `.claude/rules/known-gaps.md:2232` — "guarded by grep and by `BU99`'s call-shape assertion, not
  by a behavioural test" → add `BU98`, and note that both *are* tests; the property they do not
  cover is the tenant predicate, not the parameter. This one is in a file `CLAUDE.md` designates
  authoritative, so it is the one that matters most.

### MEDIUM-2 · `docs/plans/s-045-late-usage-absorption.md:738-739` — both "reddens only" claims are wrong

`.claude/rules/review-standards.md` § *Universals Must Cite Their Mutation* applies directly.
Re-performed against the **whole** billing package (`pnpm --filter @telemetry/billing-service
test`), each reverted:

| Claim | Measured |
|---|---|
| "`{ increment }` → `{ set }` reddens **only** `BU98`" | **5 failed / 175 passed (180)** — `BU98`, `BI22`, `BI24`, `BI25`, `BI26` |
| "deleting the DRAFT guard reddens **only** `BU100`" | **2 failed / 178 passed (180)** — `BU100` **and `BI23`** |

Both understate the coverage, which is the safe direction, but "only" is a universal and it is
false. The second one matters for a different reason: it is the evidence that `BI23`'s
owner-connection `FINALIZED` fixture genuinely exercises the branch rather than passing on the
status alone — that is worth stating, not losing.

**Fix** — at `:738-739`, replace with the package-wide counts above, and add to `BI23`'s comment
(`billing.integration.test.ts:815`) that deleting the guard reddens it, which is what makes the
fixture non-vacuous.

The third mutation in the same list **is** correct as written: replacing D6's routing with a
plain return gives `2 failed / 178 passed` — `BU94` and `BU50` red, `BU94b` green. Confirmed.

### MEDIUM-3 · `invoice.repository.unit.test.ts:585` — "BI23 asserts the live rollback" is false, and nothing asserts it

`BU101`'s closing comment:

> The throw escapes the `$transaction` callback, which is what a real transaction turns into a
> rollback of the increment and the appended line items (**BI23 asserts the live rollback on the
> refusal path**; this pins that the repository raises rather than logs).

`BI23` is the `FINALIZED` refusal. `BU100` at `invoice.repository.unit.test.ts:539-541` asserts
the opposite property explicitly — "the refusal must **precede** the update and the billed flags,
not undo them". There is nothing to roll back on that path, so `BI23` cannot assert a rollback.

**No shipped test asserts that a mid-transaction throw in `absorbLateUsage` rolls back the
`{ increment }` and the appended line items.** `BI10` does it for `createDraftInvoice`; the absorb
path has no equivalent. Plan §7 maps AC2 to `BU100`, `BU101`, `BI23` — all three of which are
either doubles or pre-write refusals.

**The behaviour is correct.** Verified here on a live `telemetry_app` connection: with two
`usageLineIds` of which one exists, so `markUsageLinesBilled` throws at step 4 *after* the update
and the nested insert have run —

```
PROBE ERROR: UsageLinesChangedError … (expected 2, marked 1)
PROBE TOTAL AFTER: 100          (unchanged from the seeded 100.000000)
PROBE LINE ITEMS AFTER: 0
PROBE USAGELINE billed AFTER: false
```

**Fix** — two parts, and they are separable:
1. Correct the comment at `:585`: `BI23` asserts that the refusal writes nothing *because it
   precedes the writes*; the live rollback of a partial absorb is **untested**.
2. Either add the integration case (a `BI27` mirroring `BI10`: pre-bill one priced row through
   the owner connection, call `absorbLateUsage`, assert total unchanged / zero new line items /
   `billed` still false — the probe above is the whole test), or record the gap. See decision
   **D-B** below.

### MEDIUM-4 · Four `epic-8:158` citations are stale, broken by this diff's own edit

The change inserts a 13-line forward-reference block at `docs/epics/epic-8-billing-service.md:143-155`.
The line it cites moved with it: `**Error response**: 409 { code: 'INVOICE_IMMUTABLE', … }` was
`:158` at `HEAD` and is `:171` on this tree (`:158` is now blank). Re-derived with
`sed -n '158p'` and `sed -n '171p'` against both revisions.

Four added citations are now wrong:

- `apps/billing-service/src/constants.ts:76`
- `apps/billing-service/src/errors/index.ts:143`
- `apps/billing-service/src/repositories/invoice.repository.ts:495`
- `apps/billing-service/tests/internal.controller.unit.test.ts:144`

`invoice.repository.ts:492`'s `epic-8-billing-service.md:140` is **correct** (`## T-048 · Invoice
immutability guard`, unmoved). Plan `:138` and `:704` carry the same stale `:158`; plan `:712`'s
`epic-8:150` now points at prose inside the new block (the snippet's `findById(id, tenantId)` is
at `:161`) — that one was already imprecise at `HEAD`, where `:150` was the `FINALIZED` check.

This is S-33 exactly, inside a change that cites S-33 twice.

**Fix** — retarget all four to `:171` (or, better, cite the section heading `epic-8:140 · T-048`
rather than a line inside a file this change is editing, which is what makes the citation stable).

### LOW-1 · `integration.constants.ts` — three constants added and never used, one describing a case that does not exist

`grep -c "INTEGRATION_LATE_USAGE\.<key>"` across `apps/billing-service/tests/*.ts`:

| `integration.constants.ts` | Uses |
|---|---|
| `:208 INSTANT_SECOND` | **0** |
| `:211 EXPECTED_DELTA_API` | **0** |
| `:219 TENANT_B_EXPECTED_TOTAL` | **0** |

`INSTANT_SECOND`'s docblock says *"A second late instant, for the case that absorbs twice."*
**No case absorbs twice.** `BI26` seeds one late row and absorbs once. The comment describes a
test that was planned and not written, and a reader will go looking for it.

**Fix** — delete all three, or write the double-absorption case `INSTANT_SECOND` was added for.
Same family as S-6 (dead config) and S-17 (a specified-and-dead helper), which is why it is worth
a line rather than a shrug.

### LOW-2 · `constants.ts:73` — `MESSAGE_USAGE_LINES_CHANGED` says "no invoice was created" on a path that creates nothing

`markUsageLinesBilled` is now shared by `createDraftInvoice` and `absorbLateUsage`, so an absorb
that loses the count race surfaces as:

```
Usage lines changed between pricing and invoicing; no invoice was created (expected 2, marked 1)
```

— measured, verbatim, from the live probe in MEDIUM-3. On the absorb path no invoice was created
*or* modified; the existing invoice was left alone. The message misdescribes the case an operator
is reading it for.

**Fix** — either broaden the message ("…; nothing was written") or give the absorb path its own
message constant beside `MESSAGE_INVOICE_IMMUTABLE`. Broadening is the smaller change and keeps
one code.

### LOW-3 · A re-run of an already-invoiced period can now answer `422`, and nothing records that

Before this change, `findByPeriod !== null` returned `200` unconditionally. Now the unbilled read
and **both D1 refusals** run first (`billing.service.ts:124-136`), so a re-run can throw
`MeterNotFoundError` or `MeterCurrencyConflictError` — `422` (`errors/index.ts:79`, `:90`).
`BU97` pins this deliberately and it is the right behaviour (D1 consistency; a loud refusal beats
a silent skip). `apps/worker-service/src/services/billing-client.service.ts:108-120` throws on any
status that is not `200`/`201`, so that tenant is counted `failed: 1` by the nightly job.

The plan's R5 records the *refusal* being preserved across branches; neither the plan nor the
service docblock records the operational consequence — that an idempotent re-run, previously
always `200`, can now fail the nightly job for a tenant whose late row carries an unmetered
`metricKey`. It is not a defect; it is an unstated contract change to the one caller.

**Fix** — one sentence in `billing.service.ts`'s ordering docblock (the `:70-104` block that
already explains the branch), and one in known-gaps S-45's residual list.

### NIT · known-gaps S-45 cites `docs/plans/` as the record of what shipped

`.claude/rules/known-gaps.md:2192` — "Closed by the billing-service change planned in
`docs/plans/s-045-late-usage-absorption.md`". `CLAUDE.md` is explicit that a plan marks a task
*started* and that nothing may read `docs/plans/` as evidence of completion. Cite the review or
the commit instead; the plan reference is fine as *context* but should not carry "closed by".

---

## What I verified, by execution

### Priority 1 — the isolation argument

**Both mutations re-performed, and the implementer's account of *why* is correct.** Nothing else
is carrying it. Probed directly as `telemetry_app` (`pg_roles`: `rolsuper = f`,
`rolbypassrls = f` — confirmed, not assumed), two invoices sharing one period:

```
ctx = tenant B, untenanted predicate  -> probe-inv-b          (only B's row)
ctx = tenant A                        -> probe-inv-a
no tenant context                     -> (none)
```

So an untenanted `findFirst` inside `withTenant` cannot reach another tenant's invoice, and no
behavioural case can distinguish the application predicate from the RLS policy. That is belt and
braces working, and it is exactly why `BI24` stays green under a mutation that removes one of the
two belts.

**The S-10 exposure this change lives with — confirmed live, not inherited:**

```
relrowsecurity = f, relforcerowsecurity = t, 0 policies, no tenantId column   ("InvoiceLineItem")
ctx = B: UPDATE "Invoice" … WHERE id = <tenant A's invoice>   -> UPDATE 0      (RLS holds)
ctx = B: INSERT INTO "InvoiceLineItem" … invoiceId = <A's>    -> INSERT 0 1    (RLS does not)
```

**No comment anywhere claims RLS protects that write.** Checked every `InvoiceLineItem` mention in
`apps/billing-service/{src,tests}`: `invoice.repository.ts:449-451` states the measurement and then
says *"do not read this as 'RLS protects the line-item write': it does not"*;
`billing.integration.test.ts:863-868`, `invoice.repository.unit.test.ts:321`, `:511`,
`integration.fixtures.ts:247` and `BI9` all say the same. Requirement satisfied.

**The emitted SQL, captured from the real repository against the real database** (Prisma query log,
`telemetry_app` connection):

```
SELECT "Invoice"."id", "Invoice"."status"::text FROM "Invoice"
  WHERE "tenantId" = $1 AND "periodStart" = $2 AND "periodEnd" = $3 LIMIT $4
UPDATE "Invoice" SET "totalAmount" = ("Invoice"."totalAmount" + $1)
  WHERE "tenantId" = $2 AND "periodStart" = $3 AND "periodEnd" = $4 RETURNING …
INSERT INTO "InvoiceLineItem" ("id","invoiceId","metricKey","quantity","unitPrice","amount")
  VALUES ($1,$2,$3,$4,$5,$6)                       ||  invoiceId bound to the resolved invoice
```

The `UPDATE` carries the tenant in its own `WHERE`; the `INSERT` carries none. The docblock's
description of the asymmetry is accurate statement for statement.

**Is the honesty consistent everywhere?** Mostly. The `BI24` comment
(`billing.integration.test.ts:874-896`), the known-gaps residual 4, plan §4.3's Gate-3
disposition and §11's S7 entry all state the mutation result and refuse to claim
unrepresentability — good. The one place that overstates is the repository docblock, and it
overstates in the direction of *too few* guards (MEDIUM-1), which is unusual and worth saying:
the author was leaning away from the overclaim and went one step past the measurement.

**Ruling on the gap id.** It should be minted, and it is broader than S-45's residual makes it
look — see decision **D-A**. Shape: it is S-28's (a defence-in-depth tenant predicate whose
removal no behavioural test can fail, kept deliberately) crossed with S-21's (two independent
guards, either sufficient, so the suite cannot isolate one). **S-10 does not cover it** — S-10 is
`"InvoiceLineItem"` RLS being *inert*; this is `"Invoice"` RLS being *enabled* and therefore
masking the application predicate. Different table, opposite direction. And it cannot be folded
into S-28, whose title is scoped to `UsageLine`/`upsertEventWithUsageLine` — the same objection
this file records for keeping S-32 out of S-29.

### Priority 2 — did the fix fix it, and can the tests tell

**`BI22` red-before-green, both halves, re-performed.** Defect reinstated at
`billing.service.ts:127` (early return before `absorbOrLeave`), reverted after:

- Half 1: `AssertionError: expected false to be true` at `billing.integration.test.ts:795:49` —
  the late row's `billed`. Verbatim match.
- Half 2, with the `billed` assertion temporarily pinned to `false` so execution continues:
  `AssertionError: expected '12.5' to be '14.5'`. Verbatim match.

**The `BI22` reordering matters, and masks nothing.** Measured by moving the envelope assertions
above the two database ones and re-running against the reinstated defect: the failure moves from
`:795` (the `billed` read-back) to `:798` (`body.data.absorbed`). Both orderings report the *same
message* — `expected false to be true` — so only the line number distinguishes them, which is
worth knowing if anyone re-derives this. In the green case every assertion runs either way;
nothing is skipped. The shipped order is correct and the reasoning behind it is sound.

**`BU36`'s negative half is genuinely unweakened.** The case was inverted from
`expect(sumUnbilledByMetricKey).not.toHaveBeenCalled()` to
`expect(sumUnbilledByMetricKey).toHaveBeenCalledWith(PERIOD_START, PERIOD_END)`. The
`createDraftInvoice` negative — "a period that already has an invoice must never insert a second
one" — survives byte-identical: `expect(existing.createDraftInvoice).not.toHaveBeenCalled()`. The
third original negative (`findActiveAsOf` not called) had to go, because the hoisted pipeline now
calls it; the comment names the one that survived rather than implying all did. Honest.

**`BU35`** now asserts the invariant across both arms of the branch (`created` false on each),
with the arms' own behaviour in `BU92`/`BU93`. Correct split.

**The three isolation mutations** — results in MEDIUM-2 above. Two of the three "only" claims are
wrong; the D6 one is right.

**Test honesty spot checks, all passing:** `firstArg`
(`invoice.repository.unit.test.ts:161-167`), `absorbInput` (`billing.service.unit.test.ts`),
`lineById` and `invoiceFor` (`billing.integration.test.ts:725-745`) all **throw** when the thing
they look for is absent, rather than returning `undefined`. No short-circuit `return`/`skip` in
any new case. No case asserts a mock's own return value: `BU92` asserts the *input* the service
built, `BU98`/`BU99` assert the Prisma call shape, `BI22`–`BI26` assert database rows read back
through the owner connection. `BU102b` asserts the error body as an exact **key set**
(`["code","message"]`), so an extra field cannot appear unnoticed; `BI3`/`BI8`'s envelope key-set
assertion was widened to `["absorbed","invoiceId"]` and is still exact.

### Priority 3

**Atomicity — verified live, and the failure path is the safe one.** See MEDIUM-3 for the probe
output. All four steps are inside one `withTenant` transaction
(`invoice.repository.ts:507-541`): resolve, refuse, `update` with nested `create`, chunked billed
update. `BU98` additionally asserts `transaction` was called once and that the *first* `queryRaw`
in it carries the tenant setting name and the tenant id — i.e. the RLS context is still statement
one, which `.claude/rules/tenant-isolation.md` requires. Coverage of the rollback itself is the
gap in MEDIUM-3, not the behaviour.

**`{ increment }` compiles to SQL addition, and the precision claim holds.** From the query log
above: `SET "totalAmount" = ("Invoice"."totalAmount" + $1)` — no read-modify-write, no race.
Persisted `1234567.123456 + 0.000001` → **`1234567.123457`**, and the repository returned
`totalAmount` as a `string` (`typeof === "string"`, not a `Prisma.Decimal`). `BI25`'s assertions
sit on the repository return value and on the database row, never on a response body — correct
per the BU75/BI18 precedent, and necessarily so: the envelope carries no amount at all.

**The implementer's self-correction is right, and the replacement comment is accurate.**
`integration.constants.ts:228-243` says the precision pair does *not* refute a JavaScript
addition. Re-derived: `String(Number("1234567.123456") + Number("0.000001"))` is
`"1234567.123457"` — the same string. The comment's alternative example is also correct:
`String(Number("123456789012.123456") + Number("0.000001"))` is `"123456789012.12346"`, six
digits short. And what it says `BI25` pins — exact survival at the `Decimal(18,6)` boundary and no
`Prisma.Decimal` escaping the repository — is what `BI25` actually asserts. This one is right.

**Chunking.** The extraction to `markUsageLinesBilled` (`invoice.repository.ts:344-363`) is
logic-identical to `HEAD`'s inline loop (`git show HEAD:…` lines 322-344 — same `CHUNK_SIZE`
stride, same `this.where({ id: { in }, billed: false })`, same cross-chunk sum, same
`UsageLinesChangedError`). All seven named cases green **by name**, verified from a verbose
reporter run: `BU24`, `BU24b`, `BU26`, `BU27`, `BU27b`, `BI11`, `BI12`. `BU101` drives
`BILLED_UPDATE_CHUNK_SIZE + 1` ids through the *absorb* path, asserts two `updateMany` calls whose
flattened id sets equal the whole input in order, and asserts the short-count throw carries
`expected = chunk + 1`, `actual = chunk` — the sum spans the whole set, not a chunk.

**The `409 INVOICE_IMMUTABLE` branch.** Unreachable in production today: `createDraftInvoice`
writes `BILLING_METERING.INVOICE_STATUS_DRAFT` and is the only statement that sets
`Invoice.status`. `BI23` seeds `FINALIZED` through the owner connection and **genuinely exercises
the branch** — deleting the guard reddens it (MEDIUM-2). Both the test comment
(`billing.integration.test.ts:816-820`) and `errors/index.ts:129-136` say it is the only thing
standing behind the branch until T-048, and `errors/index.ts:135-136` correctly declines to claim
the status is unrepresentable ("the fixtures reach it, which is exactly how `BI23` works").
**Reusing T-048's declared `INVOICE_IMMUTABLE` is the right call** — one code for one condition
beats two, the forward reference in `epic-8:143-155` makes T-048's author meet the decision at
plan time, and the divergence from the epic's `{ code, invoiceId, currentStatus }` body is
recorded rather than silently conformed to, with both values going to the log line (`BU96` asserts
the log line actually carries them, so they are not dead fields).

**S-38 stays open, correctly.** `.claude/rules/known-gaps.md:1673-1683` adds the second-consumer
paragraph, says "**unit coverage only**", names `BU94`/`BU94b`, and states the vacuity trap applies
to both paths. `grep` finds no claim of closure in any comment, the plan, or known-gaps. D6's
service comment (`billing.service.ts:165-175`) repeats it. Correct.

**D7's honesty holds everywhere I checked** — `billing.service.ts:95-98`,
`known-gaps.md` S-45's closing paragraph, plan R7 all say "index candidates" and explicitly
**not** index coverage, naming the empty tables and the absent `EXPLAIN`. Both indexes exist
verbatim: `UsageLine_tenantId_periodStart_periodEnd_idx` and `UsageLine_tenantId_billed_idx`
(`pg_indexes`). **Is it enough?** Yes for this gate — the honesty is consistent and the cost is
one grouped read per tenant per re-run. The disposition should be to accept and hand the
volume measurement to whichever task first loads `UsageLine`; the unrecorded part is LOW-3, not
the index question.

**`absorbed: boolean` and the consumer contract.** `internal.controller.ts:56` sends
`{ data: { invoiceId, absorbed } }`; the status still derives from `created` alone, and `BU102`
asserts `absorbed: true` does **not** move the status to `201` (negative assertion on
`HTTP_STATUS_CREATED`). On worker's side, `billing-client.service.ts:134-136` **casts**
(`(await response.json()) as GenerateInvoiceResponseBody`) — no Zod, no strict schema — and
`:122-125` derives `created` from the HTTP status and reads `body?.data?.invoiceId ?? null`. An
extra key cannot change either. `grep -rn "absorbed" apps/worker-service --include=*.ts` returns
nothing, and no worker test asserts the key set of billing's `data`. worker-service is 234/234
green. **Stated precisely: this is established by reading the client and by the worker suite
being green, not by driving worker against a real billing response carrying `absorbed`** — that
end-to-end probe was not run (see *What I could not verify*).

---

## Compile-time gate — all 13 packages, `--force`

`pnpm typecheck --force` · `pnpm lint --force` · `npx turbo run build --force` · `pnpm test --force`.
Every task: `Tasks: 13 successful, 13 total`. No cache replay — `cache bypass, force executing`
on every package.

| Package | Test files | Tests |
|---|---|---|
| `@telemetry/shared-types` | 1 | 8 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/usage-service` | 19 | 230 |
| **`@telemetry/billing-service`** | **17** | **180** |
| `@telemetry/auth-service` | 15 | 166 |
| `@telemetry/worker-service` | 17 | 234 |
| `@telemetry/web` | 0 | 0 (`--passWithNoTests`) |
| **Root (derived)** | **86** | **917** |

Twelve packages report; `@telemetry/web` contributes 0. **917** matches the claimed 899 → 917, and
billing's **180** matches 162 → 180. `pnpm test:smoke` — 6/6 suites pass.

**Lint: 14 warnings, 0 errors, all pre-existing, proven.**

| File | Warnings | Rule | `git log -1` | In this diff? |
|---|---|---|---|---|
| `apps/auth-service/tests/auth.service.unit.test.ts` | 10 | `no-misused-promises` | `d68e719` (2026-08-25) | no |
| `apps/usage-service/tests/ingestion.service.unit.test.ts` | 4 | `no-unsafe-assignment` | `b0f6921` (2026-08-31) | no |

`git diff --name-only HEAD` contains neither file. `grep -c "no-unsafe-return"` over the gate log
→ **0**. Matches the implementer's account exactly. Nothing new introduced, nothing pre-existing
waved through.

**Environment left as found.** `Tenant` 2, `Event`/`UsageLine`/`Invoice`/`InvoiceLineItem`/`Meter`
all 0 — re-counted after every probe and after the full gate. **No orphan `Tenant` appeared**;
`auth.integration.test.ts`'s last case is a negative one, so S-20's leak did not fire this run.
Postgres and Redis left running; `v1_7` not touched; no role altered; every seeded row inserted
through `DIRECT_DATABASE_URL` and deleted by explicit id.

**S-22 fired during the mandated gate, reported rather than rounded to green.** Redis db 0 held
3 keys before and after, but one `denylist:*` key **changed** (`…99ed96d3…` → `…02af053a…`), so
auth-service's suite did write TTL'd keys into the database that holds `telemetry:events`. The
count is unchanged only because an earlier key expired in the interval. Not caused by this change;
this is the standing S-22 hazard, observed.

---

## What I could not verify, and why

- **Index behaviour at production volume (D7).** The tables are empty; an `EXPLAIN` here measures
  nothing. The change says so in all three places it discusses the cost, which is the right
  answer. Unverified by construction, not by omission.
- **worker driven against a real billing response carrying `absorbed`.** I read
  `billing-client.service.ts` and confirmed the cast and the status-derived `created`; I did not
  stand up worker against a live billing-service. The conclusion rests on code reading plus the
  green worker suite — labelled as inference, per the review standard.
- **The `P2002` lost race against a real connection (S-38).** Unit coverage only, by design; the
  vacuity trap S-38 records makes the obvious test worse than the gap. Not attempted.
- **`markUsageLinesBilled` at the real bind ceiling through the absorb path.** `BU101` drives
  `CHUNK_SIZE + 1` against doubles and `BI12` drives the ceiling through `createDraftInvoice`; I
  did not push 32 765 ids through `absorbLateUsage` against live Postgres. The helper is shared
  and byte-identical, so the risk is nil; stated as reasoning, not measurement.
- **Whether `BI24` could be made to catch a genuinely foreign `invoiceId`.** Constructing that
  needs the service to obtain another tenant's invoice id, which `findByPeriod` plus `"Invoice"`
  RLS both prevent. I did not build a contrived harness for it; the two mutations already
  establish that `BI24` cannot distinguish the layers.

---

## Decisions for the user

### D-A · Does the isolation finding get its own gap id, and at what scope?

**One sentence:** the application-layer tenant predicate on any RLS-enabled table cannot be
proven present by any behavioural test in this repository — `BI24` stays green with it removed —
and the implementer declined to mint an id for that, calling it the reviewer's call.

| Option | What it means | Diff impact |
|---|---|---|
| **1. Mint a new id, scoped platform-wide** *(recommended)* | A new `S-46`: "belt-and-braces makes the application tenant predicate behaviourally untestable on every RLS-enabled table", citing billing's measurement as the worked example and naming `BU98`/`BU99` as the *structural* guards that do exist. S-45's residual 4 becomes a two-line cross-reference. | Changes the diff — `known-gaps.md` gains an entry and S-45's residual 4 shrinks. |
| 2. Mint a new id, scoped to billing only | Same entry, narrowed to `absorbLateUsage`. Cheaper to write; the generalisation is lost and the next service rediscovers it. | Changes the diff, smaller. |
| 3. No new id — leave it as S-45 residual 4 | Ships as written. The finding lives inside an entry titled "largely closed", where a reader looking for tenant-isolation gaps will not find it. | No diff change. |

**Recommendation: option 1.** S-10 does not cover this (different table, opposite direction:
S-10 is RLS being *inert*, this is RLS being *enabled* and masking the predicate). It cannot be
folded into S-28, whose title is scoped to `UsageLine` — the same objection this file already
records for keeping S-32 out of S-29. And it is general: every `TenantScopedRepository` subclass
on an RLS-enabled table has it, so recording it once is worth more than recording it per service.

### D-B · The absorb path's live-rollback case (MEDIUM-3) — write it or record it?

**One sentence:** no test asserts that a mid-transaction throw in `absorbLateUsage` rolls back the
`{ increment }` and the appended line items; I verified the behaviour by hand and it is correct.

| Option | What it means | Diff impact |
|---|---|---|
| **1. Write `BI27` now** *(recommended)* | Mirror `BI10`: pre-bill one priced row through the owner connection, call generate, assert total unchanged / no new line item / `billed` still false. The probe in MEDIUM-3 is the whole test; ~25 lines, no new production code, and it must be confirmed red with `markUsageLinesBilled`'s throw removed. | Changes the diff — one integration case. |
| 2. Record it as a gap and ship | Add it to `known-gaps.md` beside S-38, with the probe output as the evidence that the behaviour is currently right. | Changes the diff — a known-gaps entry. |
| 3. Fix only the false comment at `:585` | Cheapest. Leaves AC2's strongest claim resting on doubles. | Smallest diff change. |

**Recommendation: option 1.** AC2 is a *money* invariant — "a partial absorb marking rows billed
without their lines is worse than the defect" is the plan's own framing — and it is the one
acceptance criterion with no live coverage. `BI10` already establishes the pattern, so this is
cheap and low-risk. The comment fix at `:585` is required under all three options.

---

## Required fixes for `APPROVED FOR COMMIT`

1. **MEDIUM-1** — correct `invoice.repository.ts:463-465`, `billing.integration.test.ts:894` and
   `.claude/rules/known-gaps.md:2232` to name `BU98` and state the measured result (BU99 red under
   the line-item mutation, BU98 red under the invoice-addressing mutation; the tenant predicate is
   what no behavioural case catches).
2. **MEDIUM-2** — correct both "reddens only" claims at
   `docs/plans/s-045-late-usage-absorption.md:738-739` to the package-wide counts (5 and 2), and
   add the `BI23`-reddens note to `billing.integration.test.ts:815`.
3. **MEDIUM-3** — correct `invoice.repository.unit.test.ts:585`; then D-B.
4. **MEDIUM-4** — retarget the four stale `epic-8:158` citations and the two in the plan.
5. **LOW-1** — delete the three unused constants, or write the case `INSTANT_SECOND` names.
6. **LOW-2** — broaden `MESSAGE_USAGE_LINES_CHANGED`, or give the absorb path its own message.
7. **LOW-3** — one sentence on the `422`-on-re-run consequence in `billing.service.ts`'s ordering
   docblock and in known-gaps S-45.
8. **D-A** — the user's answer, applied.

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| `"InvoiceLineItem"` RLS inert; the application route is the entire tenant control on the line-item write (S-10) | **Accepted, unchanged by this task.** Re-measured live here. `BI9` remains the marker; the docblock refuses to claim RLS protects it. S-10 stays open. |
| The tenant predicate on `absorbLateUsage`'s resolution is behaviourally untestable | **Keep the predicate.** `.claude/rules/tenant-isolation.md` requires it and the property must survive a future schema or policy change. D-A records it. |
| `P2002` lost race has no real-connection test, now with two consumers (S-38) | **Accepted.** Correctly recorded and explicitly not closed. |
| Absorb rollback untested live (AC2) | **Open — D-B.** Behaviour verified by hand at this gate; nothing stands behind that verification once this session ends, which is the S-38 pattern repeating. |
| `TenantScopedRepository` is five copies and billing's has no `TimeZone` pin (S-19) | **Accepted.** This task adds no `$queryRaw` and every date predicate is ORM; the emitted bounds are already UTC-normalised (`"2026-09-15 00:00:00 UTC"`, measured). S-19 stays open. |
| D7's extra read is unmeasured at volume | **Accepted**, honestly stated in all three places. Hand the `EXPLAIN` to the first task that loads `UsageLine`. |
| `409 INVOICE_IMMUTABLE` unreachable in production; one fixture behind it | **Accepted.** `BI23` genuinely exercises it (measured), says so, and T-048 has a forward reference. |
| Worker's log still cannot distinguish an absorption from a no-op | **Accepted** (Gate-2 answer); recorded as S-45 residual 1; T-057 owns metrics. |
| S-22 — auth-service writes to Redis db 0 during the mandated gate | **Pre-existing, observed this run** (a `denylist:*` key changed). Not this change's to fix. |

---

## Round 2

**Gate 6 (final, post-QA).** Base `07ed02a`, nothing staged or committed. Read-only: every mutation
below was reverted and the tree proven byte-identical. `git status --porcelain` is identical to the
start of this round, and `find apps/billing-service/{src,tests} -name '*.ts' | sort | xargs md5sum |
md5sum` returns `bd2e4678666dd45ecca842ad6f65a78e` before the first mutation and after the last.

**Verdict: CONDITIONAL.** No blocker, and no defect in the production change. The G-1 tiebreak goes
to the rework: QA's "recurs nightly and permanently" is refuted by execution, the corrected wording
in `known-gaps.md` is supported, and the blocking and recovery halves both reproduce on my own
pinned instants. Three required fixes, all documentation: one reachability argument in
`.claude/rules/` whose reasoning my probe refutes, one dead constant introduced by the previous
rework, and four package counts that went stale by exactly one when `BI27` landed.

Rules read from disk at review time (`cat`/`sed`, per S-24): `.claude/rules/review-standards.md`,
`known-gaps.md` (ends at **S-46**, which this change mints), `tenant-isolation.md`, `constants.md`,
`testing.md`, `git-commit.md`, `CLAUDE.md`.

**Scope confirmation, run first because the brief depends on it.** The exact command S-46 quotes
returns `bd2e4678666dd45ecca842ad6f65a78e` on this tree — 55 `.ts` files, no non-`.ts` files under
either directory. So no billing source or test byte moved since the revision QA tested, including
comments. This round's changes are confined to `.md`. The brief is reviewing what it thinks it is.

---

## Findings

### MEDIUM-1 · `.claude/rules/known-gaps.md:2276-2278` — the BullMQ non-claim's reasoning is a non-sequitur, and the path is reachable

The residual-5 scope sentence reads:

> A whole-job BullMQ retry re-runs the *same* window, but the job only rejects when the
> enumeration itself failed — which happens before any tenant call — **so** that retry was not
> observed to reach this arm and was not probed further.

The premise is correct and I re-derived it: the only `throw` in `runInvoiceGenerationJob` is in the
enumeration `catch` (`apps/worker-service/src/jobs/invoice-generation.job.ts:129-135`); a per-tenant
failure increments `failed` and the job resolves. So a `422` does not *trigger* a retry. **That is
not the same proposition as the retry not *encountering* the `422`, and the "so" asserts the second
from the first.** The conclusion is hedged ("not observed", "not probed further"), so it is not a
false claim under the *Universals* gate — but it is the one thing in this entry that was reasoned
rather than measured, and the reasoning does not hold.

**Measured.** A real BullMQ `Queue`/`Worker` at `WORKER_INVOICE_JOB.ATTEMPTS` = 3 and
`BACKOFF_TYPE` = `exponential` (delay shortened to 300 ms so the probe terminates; the delay is
irrelevant to reachability), Redis **db 14**, driving the real `runInvoiceGenerationJob` with an
enumeration that throws once and then delegates to the real `BillingEnumerationRepository`:

```
ATTEMPTS constant = 3 BACKOFF_TYPE = exponential
RESULTS ["attempt=2 SUMMARY={\"tenants\":1,\"succeeded\":0,\"failed\":1}"]
```

Attempt 1 rejected on the enumeration; BullMQ retried; **attempt 2 reached the poisoned tenant and
produced a second `failed: 1` for the same window, in the same night.** And the window cannot roll
out from under the retry — `getPreviousDayRange` at the three instants a 60 s exponential backoff
over three attempts can reach:

```
2026-07-13T02:00:00.000Z -> [2026-07-12T00:00:00.000Z, 2026-07-13T00:00:00.000Z)
2026-07-13T02:01:00.000Z -> [2026-07-12T00:00:00.000Z, 2026-07-13T00:00:00.000Z)
2026-07-13T02:03:00.000Z -> [2026-07-12T00:00:00.000Z, 2026-07-13T00:00:00.000Z)
```

`apps/worker-service/src/index.ts:266-272` passes no `now` into the closure, so each attempt takes
`new Date()` at attempt time — which is why the window is stable rather than re-derived.

So the bolded operator-facing summary at `:2265` — "**What an operator sees is one night's
`failed: 1`, and then nothing further**" — understates by up to `ATTEMPTS`. Not a money or
isolation defect; an alarm-count defect, in the noisier direction.

**Fix** — replace `:2276-2278` with what was measured:

> Scope of all of this: worker's nightly path, where `now` advances, **and where the enumeration
> succeeds**. A whole-job BullMQ retry re-runs the *same* window: the closure at
> `apps/worker-service/src/index.ts:266-272` passes no `now`, and `getPreviousDayRange` returns the
> same window at 02:00, 02:01 and 02:03, so the 60 s exponential backoff over `ATTEMPTS` = 3 cannot
> roll it. A per-tenant `422` does **not** cause that retry — the only `throw` in
> `runInvoiceGenerationJob` is the enumeration `catch` (`invoice-generation.job.ts:129-135`) — but a
> retry raised for any other reason does reach this arm. Measured with a real BullMQ
> `Queue`/`Worker` on db 14, an enumeration failing once: attempt 2 reported
> `{tenants: 1, succeeded: 0, failed: 1}` on the same window. So one poisoned window can announce
> itself up to `ATTEMPTS` times in one night, and still never again after it.

And soften `:2265` from "one night's `failed: 1`, and then nothing further" to "one night's
failures, and then nothing further" — the plural is the whole correction.

### LOW-1 · `apps/billing-service/tests/integration.constants.ts:265` — `ROLLBACK_LINE_AMOUNT` is declared and never used

Round 1's LOW-1 was three dead constants in this file. The fix for MEDIUM-3 (`BI27`) resolved all
three — `EXPECTED_DELTA_API` deleted, `INSTANT_SECOND` now consumed at
`billing.integration.test.ts:1105` with its misleading docblock corrected in place,
`TENANT_B_EXPECTED_TOTAL` renamed and consumed at `:957` — **and introduced a fourth.**

Every key of `INTEGRATION_LATE_USAGE` counted against
`grep -c "INTEGRATION_LATE_USAGE\.<key>\b" apps/billing-service/tests/*.ts`:

| Key | Uses |
|---|---|
| `INSTANT` | 1 |
| `INSTANT_SECOND` | 1 |
| `LATE_QUANTITY_API` | 3 |
| `EXPECTED_TOTAL_AFTER_ABSORB` | 2 |
| `EXPECTED_LINE_ITEMS_AFTER_ABSORB` | 1 |
| `TENANT_B_QUANTITY_API` | 1 |
| `TENANT_B_EXPECTED_TOTAL_AFTER_ABSORB` | 1 |
| `FINALIZED_TOTAL` | 2 |
| `SEED_TOTAL_PRECISE` | 1 |
| `EXPECTED_TOTAL_PRECISE_AFTER_ABSORB` | 2 |
| `EXPECTED_DELTA_PRECISE` | 2 |
| `ROLLBACK_DELTA` | 2 |
| **`ROLLBACK_LINE_AMOUNT`** | **0** |
| `ROLLBACK_LINE_QUANTITY` | 1 |

`grep -rn "ROLLBACK_LINE_AMOUNT" apps/ docs/ .claude/` returns three lines: the declaration and two
`apps/billing-service/dist/` copies of the same file (build output, untracked). No source or test
reference. Its docblock — *"Each of BI27's two late rows: 200 x 0.01."* — describes an assertion
`BI27` does not make: `BI27` asserts the line-item **count** against `lineItemsBefore.length`, never
a per-line amount.

Neither gate could have caught it: Round 1 predates `BI27`, and QA's only LOW was D-1.

**Fix** — delete `integration.constants.ts:264-265` (the docblock and the key), or add the per-line
amount assertion it describes to `BI27`. Deleting is the smaller change; `.claude/rules/constants.md`
and Round 1's own LOW-1 both point that way.

### LOW-2 · Four package counts went stale by exactly one when `BI27` landed — including one in a source-tree comment

MEDIUM-2's correction was measured on a 180-case package. `BI27` then took it to 181, and the
passed-counts were not re-derived. Re-measured here, each mutation applied to `src/`, the **whole**
package run (`pnpm --filter @telemetry/billing-service test`), each reverted:

| Site | Claims | Measured on the shipped tree |
|---|---|---|
| `docs/plans/s-045-late-usage-absorption.md:748` | "180 cases" | **181** |
| `docs/plans/s-045-late-usage-absorption.md:751` | `{ increment }`→`{ set }`: "5 failed / 175 passed" | **5 failed \| 176 passed (181)** |
| `docs/plans/s-045-late-usage-absorption.md:752` | DRAFT guard deleted: "2 failed / 178 passed" | **2 failed \| 179 passed (181)** |
| `apps/billing-service/tests/billing.integration.test.ts:823-824` | "measured package-wide, 2 failed / 178 passed" | **2 failed \| 179 passed (181)** |

**The named red sets are all exactly right** — `{ increment }`→`{ set }` reddens precisely `BU98`,
`BI22`, `BI24`, `BI25`, `BI26`; the DRAFT-guard deletion reddens precisely `BU100` and `BI23`. Only
the denominators moved, and in the harmless direction.

This is S-33's shape inside a change that cites S-33 twice, and the `billing.integration.test.ts`
instance is the one that matters: it is a `apps/*/src`-adjacent comment carrying a re-runnable claim
and a numeral, which is the exact target S-33's fix direction names.

**Fix** — update the three plan sites and `billing.integration.test.ts:824` to `179 passed` /
`176 passed` / `181 cases`. Cheaper and more durable: drop the passed-count and keep the red set and
the total, e.g. "reddens `BU100` and `BI23`, measured package-wide (2 failed of 181)".

### NIT-1 · `known-gaps.md:2530-2532` — "it records no constant" is true of the procedure and false of the paragraph, and `b662…` is not re-derivable

D-1 is otherwise well discharged (ruling below). Two wording residuals:

- `:2531-2532` — "A pre-versus-post comparison rather than a recorded digest, deliberately: **it
  records no constant**, so there is nothing for a later commit to invalidate." The *procedure*
  records no constant; the paragraph then records two (`b662…` and `bd2e…`). Say "the procedure
  records no constant".
- `b66221646429f79536053b3a13210ee2` describes an uncommitted intermediate tree that no longer
  exists, so a reader who tries to re-run it fails and cannot tell whether it was ever right. Add
  six words: "not re-derivable — that tree was never committed".

**Fix** — both at `:2530-2540`, one sentence each.

### NIT-2 · No `docs/releases/` note, and the recovery procedure lives only in an agent-facing file

`ls docs/releases/` shows `s-007-…`, `t-040-…`, `t-042-…`. S-45 has none. It ships no migration, so
a deploy-ordering note may not be owed — but it does ship an operator-facing behaviour change with a
**manual recovery procedure**, and the only place that procedure is written down is
`.claude/rules/known-gaps.md` residual 5, which `CLAUDE.md` scopes to Claude Code sessions.

An operator holding a nightly `failed: 1` with `422 METER_NOT_FOUND` currently has to learn from an
agent-instruction file that (a) the alarm will not repeat for that window, (b) adding the meter is
not sufficient, and (c) recovery requires `POST /v1/internal/billing/generate` naming the original
`periodStart`/`periodEnd`. Named under Priority 4 as the thing no artifact tells an operator.

**Fix** — see decision **D-C**.

---

## Priority 1 — the G-1 adjudication, re-derived on my own instants

**Ruling: the rework is correct and QA's G-1 item 1 is wrong. `known-gaps.md`'s current wording
states no more than is supported, with the one exception at MEDIUM-1.**

Fixture seeded through `DIRECT_DATABASE_URL` as the owner, a UUID tenant
(`aa0e6f11-0000-4000-8000-000000000001`), an invoice of `10.000000` for
`[2026-07-10, 2026-07-11)` with one line item, an `api.request` meter at `0.500000`, and **two**
late rows in that window — one `r2g6.unmetered` (3 units, no meter) and one perfectly priceable
`api.request` (12 units, worth `6.000000`). The **real** billing-service as a real process on
`telemetry_app` (port 3914), driven by the **real** `runInvoiceGenerationJob` over the **real**
`BillingEnumerationRepository` as `telemetry_worker_app` and the **real** `BillingClientService`.
All fixtures removed afterwards; the five tables back to `0` and `Tenant` back to `2`.

### 1. "Recurs every night, permanently" — refuted. Four nights, not three.

```
NOW=2026-07-11T02:00:00.000Z WINDOW=[2026-07-10,2026-07-11) SUMMARY={"tenants":1,"succeeded":0,"failed":1}
      -> "billing-service rejected the invoice request: 422: METER_NOT_FOUND"
NOW=2026-07-12T02:00:00.000Z WINDOW=[2026-07-11,2026-07-12) SUMMARY={"tenants":0,"succeeded":0,"failed":0}
NOW=2026-07-13T02:00:00.000Z WINDOW=[2026-07-12,2026-07-13) SUMMARY={"tenants":0,"succeeded":0,"failed":0}
NOW=2026-07-14T02:00:00.000Z WINDOW=[2026-07-13,2026-07-14) SUMMARY={"tenants":0,"succeeded":0,"failed":0}
```

The poisoned rows never leave `[2026-07-10, 2026-07-11)`, and `getPreviousDayRange` never returns
that window again. **The alarm fires once and stops.** I added a fourth night the rework did not
run; it changes nothing.

### 2. The persisting-*cause* case — confirmed, and it is the correct qualification

Unmetered rows seeded into `[07-12, 07-13)` and `[07-13, 07-14)`, each with its own existing invoice
so the absorb branch is the one taken:

```
NOW=2026-07-13T02:00Z WINDOW=[2026-07-12,2026-07-13) {"tenants":1,"succeeded":0,"failed":1}  422 METER_NOT_FOUND
NOW=2026-07-14T02:00Z WINDOW=[2026-07-13,2026-07-14) {"tenants":1,"succeeded":0,"failed":1}  422 METER_NOT_FOUND
NOW=2026-07-15T02:00Z WINDOW=[2026-07-14,2026-07-15) {"tenants":0,"succeeded":0,"failed":0}
```

One failure per **new** window; the already-failed window is never revisited. The distinction the
rework draws — a persisting *cause* versus a persisting *row* — is the real mechanism, and QA's
version collapses the two.

### 3. The blocking half, which both accounts agree on — confirmed

After the `422`, read back through the owner connection:

```
Invoice   r2g6-inv-1 | 10.000000 | DRAFT          (unchanged)
LineItems 1 row, sum 10.000000                    (unchanged)
UsageLine r2g6-ul-p | api.request     | 12.000000 | billed = f
UsageLine r2g6-ul-u | r2g6.unmetered  |  3.000000 | billed = f
```

The perfectly priceable `api.request` row — `6.000000` of real, unblocked revenue — stays unbilled
because a *different* row in the same window has no meter. `readAndPrice` prices the whole set or
refuses it. **One unpriceable row holds the rest of that window's late usage hostage.** Confirmed.

### 4. The recovery claim — confirmed, both halves, and it is the sharpest operator consequence here

Adding the missing `Meter` and re-running the nightly job on later nights:

```
NOW=2026-07-12T02:00Z {"tenants":0,"succeeded":0,"failed":0}
NOW=2026-07-13T02:00Z {"tenants":0,"succeeded":0,"failed":0}
```

**The meter alone recovers nothing.** The enumeration is window-scoped and takes no view of meters,
so a priceable unbilled row left in a past window is invisible to every future run. An out-of-band
call naming the original window:

```
POST /v1/internal/billing/generate {"periodStart":"2026-07-10T00:00:00.000Z","periodEnd":"2026-07-11T00:00:00.000Z"}
-> 200 {"data":{"invoiceId":"r2g6-inv-1","absorbed":true}}

Invoice 10.000000 -> 19.000000
LineItems: api.request 20 @ 0.500000 = 10.000000
           api.request 12 @ 0.500000 =  6.000000
           r2g6.unmetered 3 @ 1.000000 = 3.000000
UsageLine r2g6-ul-p billed = t   r2g6-ul-u billed = t
```

Identical in shape and in every figure to the rework's account. Recovery needs the meter **and** the
out-of-band call. Confirmed.

### 5. The explicit non-claim — the one place the rework is wrong. See **MEDIUM-1**.

**Neither account is wholly right, and that is the tiebreak's outcome on this one point.** QA is
wrong that the failure recurs nightly and permanently. The rework is right about that, right about
the blocking half, right about recovery — and wrong in the argument it gives for setting the BullMQ
path aside. The path is reachable, and reaching it multiplies the one-night alarm by up to
`ATTEMPTS`.

---

## Priority 2 — the rest of the rework

### D-1 / S-46's revert-verification — adequately discharged

**Does the new wording actually resist going stale? Yes, for the part that carries the argument.**
"Every touched file re-`md5sum`ed to the value it held immediately before that mutation" is a
*procedure*: it names no digest, so no later commit can invalidate it, and it is strictly stronger
than a whole-tree constant because it localises which file failed to revert. That is the right fix
for QA's D-1 and it is what S-33's fix direction asks for.

**Is keeping the `b662…`/`bd2e…` history right? Yes.** It is the evidence for *why* the procedure
changed, and deleting it would leave the paragraph asserting a preference with no case behind it.
Two wording residuals at NIT-1.

**The worked example is currently correct, verified by running the exact quoted command** —
`find apps/billing-service/{src,tests} -name '*.ts' | sort | xargs md5sum | md5sum` →
`bd2e4678666dd45ecca842ad6f65a78e`, 55 files, no non-`.ts` files in either directory so the glob is
not silently narrowing. `b662…` I could **not** verify and cannot: it describes an uncommitted
intermediate tree.

### S-45 residuals 6, 7, 8 — placement correct, and each records its trigger

**Placement.** The argument at `known-gaps.md:2325-2331` is right, and it is the same objection this
file already records for keeping S-32 out of S-29. S-46's title is scoped to *an integration test
over an RLS-enabled table cannot isolate the application-layer tenant predicate*. Residual 6 is the
absorb transaction's concurrency, 7 its arithmetic, 8 its response field. **None is about tenant
isolation or RLS**, and filing them under S-46 would make that title false. Filing them under S-45,
whose subject is this change, is correct.

**Do they record what would make a case worth writing?** All three do, explicitly, which is the
S-21/S-38 bar:

| Residual | Trigger recorded |
|---|---|
| 6 (concurrency) | "**Worth writing when** the locking or the placement of the count assertion changes" — plus the form that would work (assert the *final total*) and S-38's vacuity warning |
| 7 (`{ increment }` as SQL) | "**Worth writing when** anything replaces `increment` or moves the update out of the transaction" — plus the discriminator (a lost update under a locked writer) and the ~3 s / second-connection cost |
| 8 (`absorbed` end to end) | "**Worth writing when** worker starts *reading* `absorbed`" — and the reason not to write it now: "while the consumer ignores it, a test would pin the cast rather than the contract" |

Residual 6's `BU27b` citation is verbatim-correct: `invoice.repository.unit.test.ts:411` reads
`BU27b - sums the counts across chunks before comparing, never per chunk`.

### Citation accuracy — all five spot-checked against the file, plus eight more

The rework says it verified every case id against its real title. Re-derived:

| Id | Location | Title as shipped |
|---|---|---|
| `BU27b` | `invoice.repository.unit.test.ts:411` | sums the counts across chunks before comparing, never per chunk |
| `BU98` | `invoice.repository.unit.test.ts:471` | addresses the invoice by the compound unique with the bound tenant, and raises the total with increment |
| `BU99` | `invoice.repository.unit.test.ts:508` | appends line items through the nested create on that update, never tx.invoiceLineItem.create |
| `BU100` | `invoice.repository.unit.test.ts:529` | refuses a non-DRAFT invoice with InvoiceImmutableError before any write |
| `BU102` | `internal.controller.unit.test.ts:125` | carries absorbed into the envelope at 200, without moving the status to 201 |
| `BU94b` | `billing.service.unit.test.ts:492` | a lost race whose rows the winner already billed reports absorbed false and writes nothing |
| `BI3` | `billing.integration.test.ts:270` | no usage answers 200 with a null invoice id and writes nothing |
| `BI8` | `billing.integration.test.ts:444` | fractional and high-precision quantities price exactly, and no Decimal escapes the repository |
| `BI22`/`BI23`/`BI24`/`BI25`/`BI27` | `:767` / `:815` / `:862` / `:980` / `:1083` | all match their cited use |

**The specific `BI3`/`BI8` check the brief asked for — they do assert `absorbed`, not merely
mention it:**

- `billing.integration.test.ts:278` — `expect(response.json()).toEqual({ data: { invoiceId: null,
  absorbed: false } })`. A full `toEqual`, so the key set including `absorbed` is pinned exactly.
- `billing.integration.test.ts:487-489` — `expect(Object.keys(body.data).sort()).toEqual(
  ["absorbed", "invoiceId"])`, then `typeof` on both. Exact key set.

Residual 8's "`BI3` and `BI8`, which both pin the response envelope's key set including `absorbed`"
is accurate. QA's citation was not repeated unchecked.

### S-20 — left alone correctly

`known-gaps.md:614-617` records the **mechanism**, not a count: "Both users' emails carry
`@auth-integration-<uuid>.test` domains, and **the two uuids differ** — `…-2b860f1d-…` and
`…-a90cd587-…`. That is two prior runs each leaving one orphan behind." Re-read from disk.

Re-measured live after the full gate — the two live `User` rows are
`…@auth-integration-a90cd587-6593-4406-8063-bc667823f823.test` and
`…@auth-integration-2b860f1d-7221-45f9-98f6-540748d0f2d4.test`. Both uuids match the entry's record
byte for byte, and the count is still 2. Nothing to correct.

---

## Priority 3 — Round 1's four MEDIUMs, re-performed on the tested revision

Every mutation applied to `src/` (or the test file), the relevant suites run, then reverted and the
file `md5sum`-checked back to its pre-mutation value (`md5sum -c` → `OK` for both source files after
every round).

### MEDIUM-1 — both mutations, both counts, confirmed

| Mutation | `billing.integration.test.ts` | `invoice.repository.unit.test.ts` |
|---|---|---|
| **B** · `invoiceId` param + line items via `tx.invoiceLineItem.create` | **28 passed / 2 failed** — `BI25`, `BI27`. **`BI24` green** | **`BU99` red**, 1 failed / 26 passed |
| **C** · `invoiceId` param, `findUniqueOrThrow`/`update` on `{ id }` | **28 passed / 2 failed** — `BI25`, `BI27`. **`BI24` green** | **`BU98` red**, `AssertionError: expected { id: undefined } to deeply equal { …(1) }` |

Both failures in each row are the two direct repository callers failing to type-match, not isolation
outcomes. The `BU98` message is a verbatim match to the recorded string. **The corrected claim is
accurate at all three sites**: `invoice.repository.ts:468-483` (the docblock, now naming both cases
and both mutations), `billing.integration.test.ts:900`, `known-gaps.md:2236` (residual 4). Round 1's
false "neither is a guard" is gone.

### MEDIUM-2 — all three mutations, whole package

| Mutation | Red set | Count |
|---|---|---|
| `{ increment }` → `{ set }` | `BU98`, `BI22`, `BI24`, `BI25`, `BI26` | **5 failed \| 176 passed (181)** |
| DRAFT guard deleted | `BU100`, `BI23` | **2 failed \| 179 passed (181)** |
| D6 routing → plain return | `BU94`, `BU50`; **`BU94b` green** | 2 failed \| 179 passed (181) |

Red sets exactly as claimed in all three. `BI23` does genuinely drive the branch — deleting the
guard reddens it, so the owner-connection `FINALIZED` fixture is load-bearing rather than passing on
the status alone. Passed-counts stale by one: **LOW-2**.

### MEDIUM-3 / `BI27` — the live rollback case, all three assertions confirmed to fail independently

The mutation is the real defect: capture `markUsageLinesBilled`'s throw inside the `withTenant`
callback and re-throw it after the transaction commits, so the error still surfaces and the
rollback does not happen. `BI27` goes red, and suppressing each assertion in turn moves the failure
to the next:

| Assertion | Failure |
|---|---|
| 1 · invoice total | `AssertionError: expected '16.5' to be '12.5'` — the increment committed |
| 2 · line-item count | `expected [ { …(6) }, { …(6) }, { …(6) } ] to have a length of 2 but got 3` — the nested create committed |
| 3 · `billed` flag | `expected true to be false` — the flag the transaction set survived |

All three fail independently, as claimed. `BI27` also correctly asserts the *fourth* property that
distinguishes a rollback from a wipe — the row the **concurrent writer** billed stays billed
(`billing.integration.test.ts:1146`), because that write was outside the transaction. This is a
genuine live guard, not decoration, and it closes Round 1's D-B on option 1.

Two Round-1 LOWs fell out of the same rework and are confirmed fixed: `constants.ts:79-80` now reads
`"Usage lines changed between pricing and invoicing; nothing was written"` (LOW-2 — I saw it
verbatim in the mutation output above), and `billing.service.ts:95-101` carries the `422`-on-re-run
consequence with worker's `failed: 1` named (LOW-3).

### MEDIUM-4 — the heading is where they say

`sed -n '140p' docs/epics/epic-8-billing-service.md` → `## T-048 · Invoice immutability guard`.
All four citations now target the **heading**, not a line inside a file this diff edits:

- `apps/billing-service/src/constants.ts:83` — "§ *T-048* (heading at `:140`)"
- `apps/billing-service/src/errors/index.ts:143` — "(`epic-8` § *T-048*, heading `:140`)"
- `apps/billing-service/src/repositories/invoice.repository.ts:516` — "`…epic-8-billing-service.md:140`"
- `apps/billing-service/tests/internal.controller.unit.test.ts:144-145` — "§ *T-048*, heading `:140`"

Three further epic-8 citations in the change spot-checked and all correct: `:113` = `## T-047 ·
Invoice detail`, `:65` = the step-2 idempotent line, `:92` = the `pageSize` comment. The moved
**Error response** line is at `:171` as Round 1 derived, and nothing cites `:158` any more.

### S-46 held to the authoritative-file bar — no overclaim found

| Claim | Re-derived |
|---|---|
| Mutation A's four unit reds are **mechanical** | **Confirmed.** Integration **30 passed / 0 failed**; unit 4 failed / 23 passed, every one `TypeError: tx.invoice.findFirstOrThrow is not a function` (the Prisma double has no `findFirst*`). Not evidence of coverage, exactly as labelled. |
| Mutation D **is** caught by `BU98` | **Confirmed.** Read stays on the compound unique, `update` on `{ id: existing.id }`: integration **30 passed / 0 failed**, unit `BU98` red, `AssertionError: expected { Object (id) } to deeply equal { …(1) }` — verbatim match. The Prisma call surface is unchanged, so the red is a real assertion failure. |
| `BU98` catches it only because it asserts the `where` shape | **Confirmed**, and S-46 says so in those words, pairing it with S-28's `U51` as the same category. |
| Eight of ten application tables RLS-enabled; `f` for exactly `InvoiceLineItem` and `RefreshToken` | **Confirmed** from live `pg_class`: `t` for `Event`, `ExportAudit`, `Invoice`, `Meter`, `MetricRollup`, `Tenant`, `UsageLine`, `User`; `f` for exactly those two, which are S-10's. |
| Unfiltered grep 9 lines, `export class` filter leaves 4 | **Confirmed** — 9 and 4. |

**What S-46 deliberately does not claim, and correctly does not:** it says "measured on `Invoice`,
`UsageLine` and `Event`" and labels the other five tables as inference from the policy shape; and at
`:2670-2672` it explicitly refuses the universal — "*every query carries its predicate* is exactly
the claim this entry says you cannot get from the tests; it is not asserted." That is the
*Universals* gate satisfied by declining the universal rather than by defending one. No overclaim.

---

## Compile-time gate — all 13 packages, `--force`

`pnpm typecheck --force` · `pnpm lint --force` · `npx turbo run build --force` · `pnpm test --force`
· `pnpm test:smoke`. Every task: `Tasks: 13 successful, 13 total` / `Cached: 0 cached, 13 total` —
**no cache replay on any of the four**, which is the point of `--force`.

| Package | Test files | Tests |
|---|---|---|
| `@telemetry/shared-types` | 1 | 8 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/usage-service` | 19 | 230 |
| **`@telemetry/billing-service`** | **17** | **181** |
| `@telemetry/auth-service` | 15 | 166 |
| `@telemetry/worker-service` | 17 | 234 |
| `@telemetry/web` | 0 | 0 (`vitest run --passWithNoTests`) |
| **Root (derived by me, not read off)** | **86** | **918** |

Twelve packages report; `@telemetry/web` contributes 0. Billing **181** and root **918** match the
brief. `pnpm test:smoke` — **6 suites, 6 files, 7 cases, all pass** (one suite carries 2 cases).

**Lint: 14 warnings, 0 errors, all pre-existing, proven.**

| File | Warnings | Rule | `git log -1` | In `git diff --name-only HEAD`? |
|---|---|---|---|---|
| `apps/auth-service/tests/auth.service.unit.test.ts` | 10 | `no-misused-promises` | `d68e719` (2026-08-25) | **no** |
| `apps/usage-service/tests/ingestion.service.unit.test.ts` | 4 | `no-unsafe-assignment` | `b0f6921` (2026-08-31) | **no** |

`grep -c "no-unsafe-return"` over the gate log → **0**. Both files predate this change by weeks and
neither is in the diff. Nothing new introduced; nothing pre-existing waved through.

**Environment left as found.** `Tenant` **2**; `Event`, `UsageLine`, `Invoice`, `InvoiceLineItem`,
`Meter` all **0** — re-counted after the full gate and again after every probe. **No orphan `Tenant`
appeared.** Every seeded row inserted through `DIRECT_DATABASE_URL` and deleted by explicit id or
`r2g6-` prefix. `git status --porcelain` identical to the start; both harness files
(`apps/worker-service/r2g6-harness.ts`, `r2g6-bull.ts`) created, used and deleted; billing's
checksum back to `bd2e4678666dd45ecca842ad6f65a78e`. Postgres and Redis left running; `v1_7`
untouched; no role altered. BullMQ probe confined to Redis **db 14** and obliterated afterwards.

**S-22 fired during the mandated gate, reported rather than rounded to green.** Redis db 0 went from
**1 key** (`telemetry:events`) to **2** — a new `denylist:d489b3a638f0e931eddef6062ceddad1` written
by auth-service's suite into the database that holds the live ingest stream. TTL'd and harmless;
this is the standing S-22 hazard, observed, not caused by this change.

---

## Priority 4 — final-review scope

**Test coverage alignment.** Every acceptance criterion now has live coverage. AC2 — the money
invariant, and the one criterion Round 1 found resting entirely on doubles — is closed by `BI27`,
which I confirmed red under the no-rollback mutation with all three assertions failing
independently. No orphaned production code: `absorbLateUsage`, `absorbOrLeave`, the D6 routing, the
DRAFT guard and the `{ increment }` are each pinned by at least one named case that goes red when
they are removed, all re-measured above. The three genuinely unguarded properties are recorded as
residuals 6-8 with their triggers, not left implicit.

**Release readiness.** All of S-45's acceptance criteria are satisfied. No regressions in the other
twelve packages — 918/918 green with `--force`, so no cached result was reused.

**Breaking-change assessment across the other 12 packages.** The only cross-service surface is the
`absorbed` key added to `POST /v1/internal/billing/generate`'s `200`/`201` envelope.

- `grep -rn "absorbed" apps/*/src packages/*/src --include=*.ts` outside billing-service →
  **no match**. There is no consumer.
- worker's client is the only caller. `billing-client.service.ts:108-127`: it throws on any status
  that is not `200`/`201` (re-read — the status check and the throw are there, which is what
  residual 5 asserts), derives `created` from the **status alone**, and reads
  `body?.data?.invoiceId ?? null` through a bare `as GenerateInvoiceResponseBody` cast with no Zod
  and no `strict()`. An added key is structurally unreachable by either derivation.
- I drove the real `BillingClientService` against real billing responses on the **failure** path
  (the `422`) during the G-1 probe. The **success-with-`absorbed`** path I exercised by `curl`, not
  through the client — QA drove that one through the real client and reported `succeeded: 1,
  failed: 0` with `created: false`. I am relying on QA's measurement for that leg, plus my own code
  reading; I did not re-run it.

**Non-breaking.** The added field is ignored by construction and by measurement.

**What an operator must know that no artifact currently says.** Three things, and they are the
subject of **NIT-2** and decision **D-C**:

1. A `422 METER_NOT_FOUND` from the nightly job fires **once for that window and never again** — so
   an absent alarm is not evidence the problem cleared. (In `known-gaps.md` only.)
2. One unpriceable row **blocks every other late row in the same window**, including fully
   priceable revenue. (In `known-gaps.md` only.)
3. Recovery requires the missing `Meter` **and** an out-of-band
   `POST /v1/internal/billing/generate` naming the original `periodStart`/`periodEnd`; the nightly
   job will never revisit that window. (In `known-gaps.md` only.)

Plus, after MEDIUM-1: the alarm can fire up to `ATTEMPTS` times in the one night it does fire, so
three `failed: 1` lines are one incident, not three.

---

## What I could not verify, and why

- **Whether `b66221646429f79536053b3a13210ee2` was ever correct.** It describes an uncommitted
  intermediate tree that no longer exists. I verified `bd2e…` by running the exact quoted command;
  `b662…` is unfalsifiable from here, which is itself the argument for NIT-1's second half.
- **worker's real client against a live billing `200 {"absorbed":true}`.** I drove the real client
  against the real service on the `422` path only. The success leg rests on QA's measurement plus my
  reading of `billing-client.service.ts:108-127`. Labelled as inference-plus-inherited-measurement,
  not as something I ran.
- **Index behaviour at production volume (D7).** The tables are empty; an `EXPLAIN` here measures
  nothing. Unverified by construction, and the change says so in all three places it discusses the
  cost.
- **The `P2002` lost race against a real connection (S-38).** Unit coverage only, by design. S-38's
  vacuity trap makes the obvious test worse than the recorded gap. Not attempted.
- **The other five RLS-enabled tables in S-46's platform-wide claim.** I re-derived the table list
  and the subclass count; I did not repeat the masking probe beyond the three tables S-46 itself
  names as measured. The entry labels the rest as inference, so this is a confirmed scope, not a
  gap.
- **The real 60 s / 120 s BullMQ backoff.** My reachability probe used a 300 ms delay. The delay
  affects *when* the retry lands, not *whether* it reaches the arm, and I established separately by
  execution that `getPreviousDayRange` returns the same window across the whole real backoff span.
  The shortening is stated so nobody re-derives it and finds a different number.

---

## Decisions for the user

### D-C · Does S-45 get a `docs/releases/` note, or is `known-gaps.md` enough?

**One sentence:** the three operator-facing facts above — the alarm fires once, one bad row blocks a
whole window, and recovery needs a manual call naming the original window — are written down only in
`.claude/rules/known-gaps.md`, which `CLAUDE.md` scopes to Claude Code sessions, and S-45 ships no
migration so no release note is strictly owed.

| Option | What it means | Diff impact |
|---|---|---|
| **A · Add `docs/releases/s-045-late-usage-absorption.md`** *(recommended)* | ~15 lines: the `200`→`422` behaviour change on re-run, the once-only alarm, the blocking property, and the exact recovery `curl` with its `periodStart`/`periodEnd`. No rollback lever needed — there is no migration and the change is forward-compatible. | **Changes the diff** (one new doc). |
| B · Add three sentences to the epic's T-046/T-048 section instead | Cheaper, keeps it near the contract. But `docs/epics/` is already recorded as an unreliable manifest (S-15) and has three open divergence entries (S-29, S-32, S-35). | **Changes the diff**, smaller. |
| C · Leave it in `known-gaps.md` | Ships as written. The first operator to hit a `422` re-derives the recovery procedure from an agent-instruction file, or does not find it. | No diff change. |

**Recommendation: A.** The three prior tasks with operator-visible consequences each got one
(`s-007`, `t-040`, `t-042`), and the recovery procedure is the first thing on this platform that an
operator must perform *by hand* to avoid losing billable revenue. `known-gaps.md`'s own framing —
"the first operator to see it does not read it as a new bug" — is an argument for putting it where
an operator looks. This option changes the diff; B and C are preference.

---

## Required fixes for `APPROVED FOR COMMIT`

1. **MEDIUM-1** — rewrite `.claude/rules/known-gaps.md:2276-2278` with the measured BullMQ
   reachability (real `Queue`/`Worker`, enumeration failing once, attempt 2 →
   `{tenants:1,succeeded:0,failed:1}` on the same window; `getPreviousDayRange` stable across the
   backoff span), and pluralise `:2265` to "one night's failures".
2. **LOW-1** — delete `apps/billing-service/tests/integration.constants.ts:264-265`
   (`ROLLBACK_LINE_AMOUNT`, 0 uses), or add the per-line amount assertion its docblock describes to
   `BI27`.
3. **LOW-2** — correct the four stale package counts:
   `docs/plans/s-045-late-usage-absorption.md:748` (`180` → `181`), `:751` (`175` → `176`), `:752`
   (`178` → `179`), and `apps/billing-service/tests/billing.integration.test.ts:824`
   (`178` → `179`). Preferred: drop the passed-count and keep the red set plus the total.
4. **NIT-1** — `known-gaps.md:2531-2532`, say "the *procedure* records no constant"; and mark
   `b662…` not re-derivable because that tree was never committed.
5. **D-C** — the user's answer, applied.

Nothing here touches production code. With 1-4 applied and D-C answered, this is safe to commit as
one atomic commit per `.claude/rules/git-commit.md`.

## Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| One unpriceable late row blocks every other late row in its window, and the alarm fires once | **Accepted, and correct behaviour** (D1: refuse loudly rather than bill partially). Measured at this gate. Recorded in S-45 residual 5; **the operator-facing half is D-C.** |
| The nightly `failed: 1` can fire up to `ATTEMPTS` times for one window | **Open — MEDIUM-1.** Measured here for the first time. Noise, not money. |
| A poisoned window is never revisited, so recovery is manual and window-scoped | **Accepted.** Correctly recorded; automating it would be new production behaviour with its own failure modes. Belongs in its own task if it is ever wanted. |
| `"InvoiceLineItem"` RLS inert; the application route is the entire tenant control on the line-item write (S-10) | **Accepted, unchanged by this task.** Re-measured at Round 1. Every comment that touches it declines to claim RLS protects it. S-10 stays open. |
| The application tenant predicate is behaviourally untestable on any RLS-enabled table (S-46) | **Keep the predicate.** S-46 minted, scoped correctly, and re-derived clean at this gate (mutations A and D). |
| Absorb-path concurrency, `{ increment }`-as-SQL, and the `absorbed` end-to-end contract are unguarded (residuals 6-8) | **Accepted on the user's Gate-5 decision**, S-21/S-38 precedent. Each records its trigger; placement under S-45 rather than S-46 is correct. |
| `P2002` lost race has no real-connection test, now with two consumers (S-38) | **Accepted.** Correctly recorded and explicitly not closed. |
| `TenantScopedRepository` is five copies and billing's has no `TimeZone` pin (S-19) | **Accepted.** This task adds no `$queryRaw`; every date predicate is ORM. S-19 stays open. |
| D7's extra grouped read per re-run is unmeasured at volume | **Accepted**, honestly stated in all three places. Hand the `EXPLAIN` to the first task that loads `UsageLine`. |
| `409 INVOICE_IMMUTABLE` unreachable in production; one owner-connection fixture behind it | **Accepted.** `BI23` genuinely drives it — re-measured (deleting the guard reddens it) — and T-048 has a forward reference at a citation that no longer rots. |
| S-22 — auth-service wrote a `denylist:*` key to Redis db 0 during the mandated gate | **Pre-existing, observed this run** (db 0: 1 key → 2). Not this change's to fix. |
| Stale measured counts in comments and plans (S-33) | **Open — LOW-2.** Fourth recurrence this session; S-33's mechanical-checker fix direction would have caught all four of these, since each carries a re-runnable command beside a numeral. |

**Verdict: CONDITIONAL.**
