# QA — T-045 · Internal metering endpoint (`POST /v1/internal/billing/generate`)

**Gate 5 — QA Tester.** Base `7f359db`; subject is the uncommitted working tree (29 entries in
`git status --porcelain`: 12 modified, 17 untracked).

# Verdict: **PASS**

No defect in shipped behaviour. All 18 acceptance criteria are pinned by at least one test that
I drove red by mutating the implementation. Three documentation findings (one LOW in the plan,
one LOW in `known-gaps.md`, one stale count in the review) and four coverage observations are
recorded below; none blocks the commit, and two are returned as choices in the last section.

Every mutation below was applied, run, and reverted. Afterwards: **430 tracked
`.ts`/`.mts`/`.md`/`.sql`/`.json`/`.mjs` files under `apps/ packages/ prisma/ docs/ .claude/`
byte-identical by `md5sum`, and `git status --porcelain` identical to the pre-QA snapshot.**

---

## 1. Full gates — my own `--force` run

Run on the unmutated tree at the start of the session, and `test` re-run on the reverted tree at
the end. Identical both times.

| Task | Result |
|---|---|
| `npx turbo run typecheck --force` | `13 successful, 13 total · 0 cached, 13 total` — 0 errors |
| `npx turbo run lint --force` | `13 successful, 13 total · 0 cached` — **0 errors, 14 warnings** |
| `npx turbo run build --force` | `13 successful, 13 total · 0 cached` — 0 errors |
| `npx turbo run test --force` | `13 successful, 13 total · 0 cached` — **805 tests, 0 failures** |
| `pnpm test:smoke` | 6 suites, 7 tests, exit 0 |

Per-package, untruncated: `shared-types` 8 · `shared-config` 4 · `shared-tracing` 2 ·
`shared-validation` 15 · `shared-logger` 4 · `shared-utils` 18 · `gateway` 38 ·
`analytics-service` 18 · `usage-service` 230 · **`billing-service` 12 files / 124** ·
`auth-service` 164 · `worker-service` 180 · `web` `--passWithNoTests`. **Sum = 805**, counted
twice on two separate runs.

**The review's headline figure of 820 is wrong and should be corrected before commit** — the
review ships in the commit. Its own itemised list sums to 800 at `billing-service` 119; 805 is
that plus the 5 cases added in rework (BU24b, BU27b, BU58b, BI11, BI12). Billing at `7f359db`
was 5 files / 35 tests, so this task is **+7 files / +89 tests**.

**Warnings — all 14 pre-existing, proven, zero `no-unsafe-return`:**

- 10 × `@typescript-eslint/no-misused-promises` in
  `apps/auth-service/tests/auth.service.unit.test.ts` — `git log -1` → `d68e719`.
- 4 × `@typescript-eslint/no-unsafe-assignment` in
  `apps/usage-service/tests/ingestion.service.unit.test.ts` — `git log -1` → `b0f6921`.

Neither file appears in `git diff --name-only HEAD` or in `git ls-files --others
--exclude-standard`. No new warning of any kind, and no `no-unsafe-return` anywhere in the
13-package output.

---

## 2. Tenant isolation, and `InvoiceLineItem` above all

### 2a. The gap, re-derived independently

Connected as `telemetry_app` (`rolsuper = f`, `rolbypassrls = f`, asserted in the same session),
inside one transaction, rolled back, counts re-checked afterwards:

```
role:telemetry_app super:false bypassrls:false
rls:Invoice          enabled=true   forced=true    policy invoice_tenant_isolation (ALL)
rls:InvoiceLineItem  enabled=false  forced=true    no policy
rls:Meter            enabled=true   forced=true
rls:Tenant           enabled=true   forced=true    4 policies (select/insert/update/delete)
rls:UsageLine        enabled=true   forced=true
InvoiceLineItem columns: id,invoiceId,metricKey,quantity,unitPrice,amount   <- no tenantId
```

Then, with an `Invoice` + `InvoiceLineItem` written under tenant A and `app.tenant_id` switched
to tenant B:

```
as_B_sees_A_invoice               :: 0
as_B_sees_A_lineitem              :: 1
as_B_updated_A_lineitem_rows      :: 1   <- UPDATE succeeds
as_B_inserted_onto_A_invoice_rows :: 1   <- INSERT succeeds
as_B_deleted_A_lineitems_rows     :: 2   <- DELETE succeeds
post_rollback_A_lineitems         :: 1
```

So `"InvoiceLineItem"` is fully readable **and writable** cross-tenant by any holder of the
`telemetry_app` credential, while `"Invoice"` is contained. S-10's second half is live and T-045
ships the platform's first rows into it. The application-layer join through `"Invoice"` is the
only tenant control, exactly as the plan's §3b says.

### 2b. The three commitments — re-derived, not accepted

1. **Nested create only.** `grep -rn "invoiceLineItem\|InvoiceLineItem" apps packages
   --include=*.ts` excluding `dist/` and billing's own `tests/` returns **seven** lines, and
   **none is a production call**: two type re-exports, one interface declaration, one field
   declaration, one parameter type, and two comments (one of them auth-service's RLS test
   comment). The only write in the workspace is `lineItems: { create: [...] }` at
   `apps/billing-service/src/repositories/invoice.repository.ts:200-207`, inside the
   `withTenant` that creates the invoice, whose `tenantId` comes from `...this.where({})` at
   `:192`.
2. **No method takes a bare `invoiceId`.** Four `async` methods (`:104`, `:120`, `:144`,
   `:185`); none has an `invoiceId` or `tenantId` parameter, and `CreateDraftInvoiceInput`
   (`:30-37`) has neither field. Every `invoiceId` occurrence in billing `src/` is a returned
   field, a local, or a comment. There is **no read path to a line item at all**.
3. **BI9 pins the gap as-is — and I proved the marker works.** I simulated closing S-10 by
   applying, against the live database, `CREATE POLICY qa045_tmp_ili ON "InvoiceLineItem" USING
   (EXISTS (SELECT 1 FROM "Invoice" i WHERE i.id = "InvoiceLineItem"."invoiceId" AND
   i."tenantId" = current_setting('app.tenant_id', true)))` plus `ENABLE ROW LEVEL SECURITY`:

   ```
   × BI9 - S-10 marker: a second tenant's context hides the Invoice but not its InvoiceLineItem
     → expected +0 to be 2 // Object.is equality
     Tests  1 failed | 14 passed (15)
   ```

   BI9 is the **only** case that reddens; BI1, BI8, BI11 and the write path all stay green,
   which is a useful forward-compatibility signal for whoever lands S-10. Reverted with
   `DISABLE ROW LEVEL SECURITY` + `DROP POLICY`; `pg_class` re-read as
   `relrowsecurity = false, relforcerowsecurity = true`, `pg_policies` count 0 — identical to
   baseline.

### 2c. I tried to break it through the public surface

Driven against the real app via `app.inject` with the valid `X-Internal-Secret`, with two
tenants holding usage in the same period, seeded through the owner connection:

```
A_status 201 {"data":{"invoiceId":"6fb40caf-…"}}
A_lineitem_qty 20  amount 0.2                     <- A's two lines only; B's two not included
B_lines_billed_after_A_generate [{"billed":false},{"billed":false}]
invoices [{"t":"A","amt":"0.2"}]
B_status 201 …  B_got_A_invoice_id false          <- separate invoice, no id leak
A_extrakeys_status 200 …                          <- usageLineIds/invoiceId in the body: stripped, no effect
badTenant ["…aa","…bb"]     -> 400 tenantId: Expected string, received array
badTenant {"tenantId":"…aa"} -> 400 tenantId: Expected string, received object
badTenant "…aa OR 1=1"       -> 400 tenantId: Invalid uuid
badTenant "…aa'"             -> 400 tenantId: Invalid uuid
badTenant null               -> 400 tenantId: Expected string, received null
```

And a cross-tenant **rate-card** probe the suite does not cover: tenant A with usage for
`api.request` and **no meter of its own**, while tenant B holds an active meter for the same key:

```
A_with_only_B_meter -> 422 {"code":"METER_NOT_FOUND","message":"No active meter for metric keys: api.request"}
invoices_after = 0   A_lines_billed = 0
```

**I could not reach a line item belonging to another tenant through any public surface, and I
could not get another tenant's data into an invoice.** The only surface is this one route, it
returns an invoice id and nothing else, and the zod object strips unknown keys before the parsed
value selects the repository factory.

### 2d. ORM-only and injection

`grep -rnE '\$queryRaw|\$executeRaw|Prisma\.raw|Unsafe' apps/billing-service/src` returns
**exactly one executable hit** — `base.repository.ts:98`'s
`` tx.$queryRaw`SELECT set_config('app.tenant_id', ${this.tenantId}, true)` `` — plus two
comment lines. `tenantId` is bound and branded. No caller-supplied value reaches SQL text
anywhere in the service.

---

## 3. The chunked `updateMany`

### 3a. Ceiling re-derived from scratch

Against `usageLine.updateMany` as `telemetry_app`, matching zero rows so nothing was written
(`UsageLine` re-counted at 0 after):

```
withBilled 32763 -> OK count=0
withBilled 32764 -> OK count=0
withBilled 32765 -> P2035: too many bind variables in prepared statement, expected maximum of 32767
withBilled 32766 -> P2035
noBilled   32764 -> OK count=0
noBilled   32765 -> OK count=0
noBilled   32766 -> P2035
noBilled   32767 -> P2035
```

Both halves of `BILLING_METERING.BILLED_UPDATE_CHUNK_SIZE`'s docblock reproduce exactly: the
32 764/32 765 boundary, **and** the arithmetic claim that dropping the `billed: false` filter
moves the failure one id later (to 32 766). The docblock is accurate as written.

### 3b. The property that must survive — verified by mutation

| # | Mutation | Result |
|---|---|---|
| M-B | `updateMany` keyed on the range predicate instead of the captured ids | **BU24** red (+ BU23, BU24b, BU25 collaterally) — `4 failed \| 13 passed (17)` |
| M-C | **per-chunk** comparison substituted for the summed one (`if (marked.count !== chunk.length) throw`) | **BU27b red, and only BU27b** — `1 failed \| 16 passed (17)` |
| M-H | `BILLED_UPDATE_CHUNK_SIZE` → `100000`, i.e. effectively unchunked | **BI12 red** with the literal pre-fix failure: `Assertion violation on the database: 'too many bind variables in prepared statement, expected maximum of 32767, received 32768'` |

M-C is the one the brief singled out, and it answers cleanly: **a per-chunk comparison is
caught, by exactly one case, and that case is BU27b.** Without BU27b the weaker guard would ship
green — BU24 and BU26 both stay green under M-C.

### 3c. BI11 / BI12 split — honest and sufficient, with one caveat

BI12's own comment states what it cannot show ("Deliberately not seeding 32 765 real rows … What
this case cannot show is a *successful* invoice above the old ceiling"), and that is true: it
pads with absent ids, reaches the count assertion, and asserts
`UsageLinesChangedError` **and** `not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)` —
which is precisely the assertion that distinguishes "reached the guard" from "hit `P2035`". BI11
covers multi-chunk success at 2 001 real rows across three statements with a partial last chunk,
and asserts `countUsageLines(billed=true) === 2001` **and** `countUsageLines(billed=false) === 0`,
so a chunk-boundary miss cannot hide in the total.

The split is honest and I judge it sufficient. **Caveat worth recording:** BI11's fixture size is
derived from the production constant (`BILLED_UPDATE_CHUNK_SIZE * 2 + 1`), so a future change to
the chunk size silently rescales the seed — at `100000` in M-H it tried to seed 200 001 rows and
failed on time rather than on the property. That is a deliberate coupling documented in the
constants file; it is correct for the values in play and only a hazard if someone raises the
chunk by two orders of magnitude.

---

## 4. The `409` path and the `P2002` re-read

The reviewer recorded "no genuinely parallel two-caller race was executed". I executed it — four
rounds against the real HTTP surface, 20 seeded usage lines each, callers fired with
`Promise.all`:

```
round 1 callers=2 statuses=[200,201] ids=[ebea24b7…,ebea24b7…] invoices=1 lineItems=1 billed=20 unbilled=0
round 2 callers=2 statuses=[200,201] ids=[9ef09968…,9ef09968…] invoices=1 lineItems=1 billed=20 unbilled=0
round 3 callers=4 statuses=[201,200,200,200] ids=[455f3ad1…×4] invoices=1 lineItems=1 billed=20 unbilled=0
round 4 callers=4 statuses=[200,201,200,200] ids=[0afce0be…×4] invoices=1 lineItems=1 billed=20 unbilled=0
```

Exactly one `201`, the rest `200`, all returning the **same** invoice id; one invoice, one line
item, every usage line billed, none left unbilled, and no `409` or `500` on any round. The
`P2002` catch-and-re-read is now proven live, not only by the unit double.

That run also **independently corroborates MEDIUM-2's corrected scope**: on the `telemetry_app`
connection Prisma logged `Unique constraint failed on the (not available)` — the "(not
available)" is `meta.target` being `null`, rendered. The comment at
`invoice.repository.ts:245-249` and `constants.ts:66-90` is accurate about the dimension that
controls it.

`UsageLinesChangedError` is `409` (`errors/index.ts:81`), pinned by BU58b, which asserts both
`toHaveBeenCalledWith(HTTP_STATUS_CONFLICT)` **and**
`not.toHaveBeenCalledWith(HTTP_STATUS_INTERNAL_ERROR)`, both counts in the message, and
`logger.error` not called. It cannot pass on the old `500`.

---

## 5. Acceptance criteria — all 18, each driven red

Every row below is a mutation I applied to the **implementation**, ran, and reverted. "Red"
names the cases that failed.

| AC | Mutation applied | Red |
|---|---|---|
| AC1 `401` | `registerInternalBillingRoutes` moved outside the `app.register` scope | BU61, BU62, BU64, **BI6** |
| AC2 `400` | `.refine(periodStart < periodEnd)` → `true` | BU6, BU7, BU67 |
| AC3 `404` | `tenantExists()` check deleted | BU33, BU34, **BI3b** |
| AC4 idempotent `200` | idempotent early `return` deleted | BU35, BU36, **BI2, BI7** |
| AC5 `[start,end)` + `billed=false` | `billed: false` dropped from the predicate | BU21, **BI1b** |
| AC5b | `gte`→`gt` (lower) / `lt`→`lte` (upper) | BU21 / BU21 + **BI1b** |
| AC6 no usage → `null` | no-billable-usage early `return` deleted | BU37, **BI3** |
| AC7 grouped + summed | `_sum: { quantity: true }` → `_count` | **11 integration cases** |
| AC8 meter as of `periodStart` | `activeTo gt`→`gte`; `activeFrom lte`→`lt`; `orderBy desc`→`asc` | BU13 / BU13 / BU14 |
| AC9 flat pricing | `Prisma.Decimal.mul` → float multiply | BU45 |
| AC10 `422 METER_NOT_FOUND` | batch check removed **only** | **BU40b, and nothing else** (1 of 21) |
| AC10b | batch check removed **and** `meterFor`'s throw neutered | BU40, BU40b, BU41, **BI4** |
| AC11 `422` currency | currency-conflict check disabled | BU42, **BI5** |
| AC12 one transaction | `updateMany` keyed on range not ids | BU23, BU24, BU24b, BU25 |
| AC13 concurrent rollback | per-chunk comparison; short count logged not thrown | BU27b; BU26/BU27 + **BI10** |
| AC14 `201` vs `200` | always `201`, ignoring `result.created` | BU55, BU56, BU66, **BI2, BI3** |
| AC15 no `Prisma.Decimal` | `String()` normalisation dropped in each repository | BU20 + **BI8**; BU9, BU14, BU15 |
| AC16 tenant predicate | `this.where({…})` → bare object literal | BU11, BU12 |
| AC17 factories | factories replaced with shared singletons | BU63 + **9 integration cases** |
| AC18 S-10 marker | RLS enabled + joining policy on `InvoiceLineItem` (live DDL, reverted) | **BI9 only** |

**No tautological test found in the sample I inspected.** Both mock harnesses route assertions
through helpers that *throw* when the query under assertion was never issued
(`firstArg`/`draftInput`/`sentBody`), BU12 pairs its negative with a positive
(`toContain(TENANT_ID)`) so absence cannot pass it, and the integration suite reads back through
the **owner** client after asserting through the service's least-privilege one. The closest thing
to an echo is BU31, which asserts the happy-path return value the double supplies — it is the
smoke case for a path BI1 proves against live PostgreSQL, so it is redundant rather than
misleading.

---

## 6. Findings

### QA-1 · LOW — the plan states a refuting mutation that does not refute

`docs/plans/t-045-internal-metering-endpoint.md` §7 S4:

> **Refuting mutation 4**: move the meter check to after `createDraftInvoice`; **BU41** ("does
> not call `createDraftInvoice` when a metric has no meter") goes red.

Performed exactly that edit — batch check removed from before the write and re-inserted after
it, `meterFor` untouched:

```
× BU40b - names every unpriceable key, not just the first one it prices
  Tests  1 failed | 20 passed (21)
```

**BU41 stays green**, because `meterFor` inside `priceLine` (`billing.service.ts:153`) raises
before `createDraftInvoice` is reached at `:122`. The plan's pending-task checklist records
`[done] S4 — … refuting mutations run for BU41, BU36`; BU36's mutation does redden BU36
(verified — AC4 row above), BU41's does not redden BU41.

The *property* is covered: removing **both** guards reddens BU40, BU40b, BU41 and BI4 (AC10b
above), so Hypothesis 4 ("no `UsageLine` is marked billed on any D1 path") is genuinely pinned.
What is wrong is the plan's account of which edit establishes it — and the plan ships in the
commit, under a rule (`.claude/rules/review-standards.md` § *Universals Must Cite Their
Mutation*) that this task otherwise observes scrupulously. Correct the sentence to name the
mutation that works, or weaken it to what was measured.

### QA-2 · LOW — `known-gaps.md` S-37 enumerates three `"Tenant"` policies; there are four

`.claude/rules/known-gaps.md`, S-37:

> `pg_policy` on `"Tenant"` gives `tenant_self_select`, `tenant_self_update` and
> `tenant_self_delete` as `(id = current_setting('app.tenant_id', true))`, with no `deletedAt`
> term.

Measured:

```
tenant_self_delete | DELETE | using=(id = current_setting('app.tenant_id'::text, true)) | check=-
tenant_self_insert | INSERT | using=-                                                   | check=(id = current_setting('app.tenant_id'::text, true))
tenant_self_select | SELECT | using=(id = current_setting('app.tenant_id'::text, true))  | check=-
tenant_self_update | UPDATE | using=(id = current_setting('app.tenant_id'::text, true))  | check=(id = current_setting('app.tenant_id'::text, true))
```

`tenant_self_insert` is omitted. **The load-bearing conclusion is unaffected** — I checked, and
the INSERT policy has no `deletedAt` term either, so "the database has no opinion" holds. This is
an incomplete enumeration in a file `CLAUDE.md` designates authoritative and instructs other
agents to trust without re-verification. Add the fourth policy, or reword so the list is not read
as exhaustive.

S-37's other claims verify exactly: the `deletedAt` grep returns precisely the three lines
stated, in the files stated. The ruling is stated as a **decision** with its reasoning
(D1's revenue-safety argument pointed at soft deletes), not as an oversight, and it carries a
revisit trigger and a measured fix cost. It meets the bar.

### QA-3 · LOW — the review's test-count headline is stale and ships in the commit

`docs/reviews/t-045-internal-metering-endpoint.md` records `820 tests, 0 failures` and
`billing-service 12 files / 119 tests`. Measured on two independent `--force` runs: **805** and
**124**. The review is committed alongside the plan, so the number is part of the record.

### QA-4 · Informational — meter boundary and rate-change semantics have no live case

`MeterRepository`'s docstring makes three behavioural claims: `activeTo` exactly at `asOf` has
expired; `activeFrom` exactly at `asOf` is in force; the newest `activeFrom` wins on a rate
change. All three are pinned **only** by unit-level *shape* assertions against a mocked
`findMany` (BU13, BU14) — which are real, not vacuous (mutating each reddens), but assert the
query the code builds rather than what PostgreSQL returns. In particular BU14's mock returns rows
in a fixed order regardless of the `orderBy` it was handed, so "newest wins" is proven as
"asks for `desc` **and** takes the first per key", not end to end.

I exercised all three against live PostgreSQL and **all three behave as documented**:

```
meter_activeTo_eq_periodStart   -> 422 METER_NOT_FOUND     (expired, as documented)
meter_activeFrom_eq_periodStart -> 201                     (in force, as documented)
rate_change (old 0.010000 from 2025-01-01, new 0.990000 from 2026-06-01)
                                -> 201  unitPrice used = 0.99  amount = 9.9
```

So this is a missing regression case, not a defect. Recommend one integration case seeding a
rate change and a boundary meter — or an entry in `.claude/rules/known-gaps.md` if it is judged
out of scope here.

### QA-5 · Informational — the lower bound's inclusivity has no behavioural case

Confirms the reviewer's NIT-3, unfixed in the rework. Measured: `gte`→`gt` reddens **only BU21**;
`lt`→`lte` reddens **BU21 and BI1b**. `BI1b` seeds a line exactly at `periodEnd` and one before
`periodStart`, but none exactly **at** `periodStart`. BU21 is a genuine shape assertion so AC5 is
pinned; the asymmetry is coverage symmetry, and one more fixture line at
`USAGE_INSTANT_AT_PERIOD_START` closes it.

### QA-6 · Informational — the `409` never traverses a real Fastify reply

`BU58b` is controller-level against a reply double; `BI10` and `BI12` call the repository
directly. No standing case sends a `USAGE_LINES_CHANGED` through `app.inject`. The
`AppError → status/code` arm itself is proven through the real route by BU68 (a `422`), so the
residual risk is that the `409` specifically is never exercised end to end. Low.

### QA-7 · Informational — a benign caught `P2002` is logged at `prisma:error`

On every losing caller of the idempotent race, Prisma emits a multi-line `prisma:error` block
with a source excerpt for an error the repository **catches and handles**, on a path that returns
`200`:

```
prisma:error
Invalid `tx.invoice.create()` invocation in .../invoice.repository.ts:190:42
Unique constraint failed on the (not available)
```

Nothing is wrong functionally — I confirmed the outcome is a correct `200` with the existing
invoice id. The cost is operational: a scheduler collision, which D2 treats as expected, will
look like an error in the logs. Worth one line in the release note or a `log: ["warn"]` decision
in a later task; out of scope here.

---

## 7. What I exercised

- Four `--force` gates and `pnpm test:smoke`, 13/13 packages, 0 cached on every task.
- 20 distinct mutations of the implementation, each applied, run and reverted (§5 table plus
  M-A/M-B/M-C/M-D/M-E/M-E2/M-F/M-G/M-H).
- Live DB-layer re-derivation of the `InvoiceLineItem` gap as `telemetry_app` — SELECT, INSERT,
  UPDATE and DELETE cross-tenant, all four succeeding, rolled back.
- Live DDL simulation of S-10 being closed, confirming BI9 is the single case that reddens, then
  reverted and `pg_class`/`pg_policies` re-read.
- The `P2035` bind ceiling re-derived at four sizes with and without the `billed: false` filter.
- Attack attempts through the public surface: cross-tenant usage bleed, cross-tenant meter
  pricing, invoice-id leakage, unknown-body-key injection (`usageLineIds`, `invoiceId`), and five
  malformed `tenantId` shapes including quote and `OR 1=1` injections.
- A genuinely parallel race, 4 rounds at 2 and 4 concurrent callers.
- Meter `activeFrom`/`activeTo` boundaries and the rate-change pick, live.
- Breaking-change scan across the other 12 packages.
- Regression check on the two modified T-044 tests.

## 8. What I could not exercise, and why

- **Behaviour on a UTC PostgreSQL server.** This host is `TimeZone = Asia/Kolkata` from
  `/etc/postgresql/16/main/postgresql.conf`. I confirmed the *measured* half of the plan's
  corrected claim — under the raw-SQL `findByPeriod` defect, **BI2 and BI7 both go red here**
  (`Tests 2 failed | 13 passed (15)`) — and I confirmed the half that makes BI7 a guard rather
  than a restatement: with the same defect and `INTEGRATION_SESSION_TIME_ZONE.AHEAD_OF_UTC`
  changed to `"UTC"`, **BI7 passes** (`1 passed | 14 skipped`). The CI-side claim (BI2 green,
  BI7 the only signal) remains inference from those two results, not a CI run. The plan and
  `known-gaps.md` both state it that way; I did not improve on it.
- **A successful invoice above the old 32 764 ceiling.** BI12 proves the limit is reached and
  cleared without `P2035`; BI11 proves multi-chunk success at 2 001 rows. Neither seeds 32 765
  real rows, and neither did I.
- **Why `meta.target` is `null` under `telemetry_app`.** Corroborated the fact three ways; did
  not establish the mechanism, and the code's comments correctly decline to.
- **Performance at scale.** R6's `EXPLAIN` was taken over a 0-row table with `enable_seqscan=off`
  and is not evidence; I did not improve on it. The five-round-trip shape per request
  (`tenantExists`, `findByPeriod`, `sumUnbilled`, `findActiveAsOf`, `createDraft`) is noted, not
  measured.
- **`Decimal(18,6)` overflow (plan R5).** Not exercised; accepted as a known bound.
- **The Copilot mirror** (`.github/agents/`, S-14). Out of scope, not checked.

## 9. Environment left as found

| | Before | After |
|---|---|---|
| `Tenant` | 2 | **2** |
| `Event` / `UsageLine` / `Invoice` / `InvoiceLineItem` / `Meter` | 0 | **0** |
| `InvoiceLineItem` `relrowsecurity` / `relforcerowsecurity` | `f` / `t` | **`f` / `t`** |
| `pg_policies` on `InvoiceLineItem` | 0 | **0** |
| Working tree (430 files, `md5sum`) | — | **byte-identical** |
| `git status --porcelain` | 29 entries | **29 entries, identical** |

Counts re-read after every probe and after every mutation batch. Postgres and Redis left
running; neither was stopped. The bind-ceiling probe used **padded absent ids against zero
matching rows**, so it wrote nothing — no rollback or delete was needed, and `UsageLine` was
re-counted at 0 immediately after. Every seeded probe deleted its own rows by explicit tenant id
and re-counted.

**Redis db 0 — S-22, reported rather than rounded to green.** Baseline `DBSIZE` 6 (five TTL'd
`denylist:*` keys from earlier sessions plus `telemetry:events`). The mandated
`npx turbo run test --force` took it to **7** — one new `denylist:*` key written by
auth-service's integration suite to db 0, which is S-22 and unavoidable under the required gate.
By session end TTLs had taken db 0 to **2** (`denylist:064f5425…` and `telemetry:events`).
**Nothing was flushed, and `telemetry:events` is intact.** Billing writes nothing to Redis: the
container's client is `lazyConnect` and no code path calls `connect()` — confirmed by running
every billing suite with no change to db 0.

## 10. Regression and breaking-change assessment — other 12 packages

- **No package imports `@telemetry/billing-service`** (`grep` over `apps packages` for the
  specifier, excluding billing's own tree: zero hits). No shared package was touched
  (`git status --porcelain packages/` empty); no dependency changed
  (`git diff apps/billing-service/package.json` empty).
- **Removed constants are dead.** `BILLING_RESPONSES.STATUS_ACCEPTED` and
  `WORKFLOW_BILLING_GENERATION` have no remaining referent; the surviving `STATUS_ACCEPTED`
  matches belong to usage-service's and worker-service's own constants modules.
- **Gateway reachability unchanged.** `GATEWAY_PROXY_PREFIXES` still has exactly four entries
  (`/v1/auth`, `/v1/usage`, `/v1/billing`, `/v1/analytics`), `registerProxyRoute` is called
  exactly four times, and `rewritePrefix: prefix` preserves path structure
  (`proxy.plugin.ts:27`). There is no `/v1/internal` prefix and no catch-all, so the endpoint is
  not externally reachable.
- **T-044's env schema still behaves.** The two modified cases were **strengthened, not
  weakened**: both now assert `400` + `CODE_VALIDATION_ERROR` **and**
  `not.toBe(HTTP_STATUS_UNAUTHORIZED)`, and the `rejected` half of each still asserts `401` and
  is untouched by the diff. The subject of both — *which secret authenticates* — is preserved,
  and neither can pass on a rejection. All 20 env-schema cases green.
- **Neighbouring suites are green for the right reasons, not short-circuiting.** Every other
  package's count is unchanged from the reviewer's per-package list (`shared-*` 51, `gateway` 38,
  `analytics` 18, `usage` 230, `auth` 164, `worker` 180) and `0 cached, 13 total` on every
  `--force` run, so nothing was replayed.
- `internal-auth.middleware.ts`'s literal `401` is pre-existing (`git log -1` → `0c85c50`,
  T-073) and untouched by this diff — S-8 item 1 and item 3 remain open by decision D7, as
  declared.

## 11. Release-readiness call

**Ready to proceed to Gate 6.** The endpoint is correct on every path I could construct,
including a real concurrent race; tenant isolation holds through the only public surface it has;
the `InvoiceLineItem` mitigation is load-bearing and its marker is proven to fire the day S-10
closes; the chunking fix is real and the property the rework was for (summed, not per-chunk) is
pinned by exactly one case that I confirmed is the one.

The three residual risks are unchanged and correctly dispositioned: **S-10** (accepted,
user-confirmed, mitigated, marked), **S-19** (billing is a third unpinned `TenantScopedRepository`
copy — mitigated by the verified ORM-only commitment), and **S-8 items 1 and 3** (open by D7).
QA-1 and QA-3 are corrections to artifacts that ship inside the commit and are cheap to make
before it; QA-2 is the same in a file `CLAUDE.md` designates authoritative. None requires a
return to Gate 3.

---

## 12. Decisions returned

### D-QA-1 · The plan asserts a refuting mutation that does not refute (QA-1). Fix it, or ship it?

| Option | What changes | Diff? |
|---|---|---|
| **A — correct the sentence to the measured result** *(recommended)* | One paragraph in `docs/plans/…:S4`: BU41 does **not** redden under "move the check after the write" because `meterFor` throws first; the mutation that reddens BU41 is removing the batch check **and** neutering `meterFor`. Fix the checklist line that claims BU41's mutation was run. | Docs only |
| B — correct it and add the missing pin | A, plus a unit case that reddens when `meterFor`'s throw alone is removed, so each guard has a case that fails when *it alone* goes | Docs + 1 test |
| C — ship as-is, file under `known-gaps.md` | Nothing now; one entry recording that S4's stated mutation is inaccurate | Docs only |

**Recommendation: A.** The behaviour is already covered — I drove BU40, BU40b, BU41 and BI4 red
together — so B buys a sharper mutation table, not safety. C is wrong here for the same reason
S-21 exists: a plan that names a mutation it did not run is the exact failure mode
`.claude/rules/review-standards.md` added the *Universals Must Cite Their Mutation* gate to stop,
and this plan is otherwise a model of it. A is ~4 lines and preserves that.

### D-QA-2 · Meter boundary and rate-change behaviour has no live case (QA-4). Add one, or record it?

| Option | What changes | Diff? |
|---|---|---|
| **A — add one integration case** *(recommended)* | One `BI`-numbered case seeding a rate change (two in-force meters, newest wins) and a meter whose `activeTo` falls exactly on `periodStart`. I have already measured all three behaviours correct, so the case pins shipped behaviour rather than changing it. ~35 lines of test, no source change. | Tests only |
| B — record it in `.claude/rules/known-gaps.md` | One entry: AC8's semantics are pinned by unit shape assertions only; a live rate-change regression would pass. | Docs only |
| C — accept as-is | Nothing. BU13/BU14 do redden under mutation, so AC8 is not unpinned — it is pinned one layer up from where the money is. | Nothing |

**Recommendation: A.** This is the one place where a silent regression would produce a wrong
*invoice amount* rather than a loud failure — `orderBy` flipped to `asc` on a tenant with a rate
change bills the old rate and the invoice still balances, which is D1's own "money quietly
missing" argument. BU14 catches the `orderBy` change today, so this is defence in depth rather
than a hole, and it is the cheapest of the three coverage observations to close. B and C are both
defensible; C changes nothing about the diff and A adds tests only — neither alters shipped
behaviour, so this is a coverage-appetite call rather than a correctness one.

*(QA-3 — the review's `820` → `805` — I am treating as a straightforward correction rather than
a choice. QA-2's fourth `"Tenant"` policy likewise. Both are one-line edits to artifacts that
ship in the commit.)*
