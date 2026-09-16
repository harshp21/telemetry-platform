# T-046 · Invoice list — `GET /v1/billing/invoices` — QA (Gate 5)

**Service**: billing-service · **Plan**: `docs/plans/t-046-invoice-list-endpoint.md` ·
**Pre-QA review**: `docs/reviews/t-046-invoice-list-endpoint.md` § Round 1 (`CONDITIONAL`)
**Base**: `ed670b3` (T-045) · T-046 uncommitted, 31 entries in `git status --porcelain`,
unchanged at QA start and QA end.
**Host**: PostgreSQL 16 (`TimeZone = Asia/Kolkata`), Redis 7, Node 22.22.2, pnpm 10.0.0,
fastify 5.10.0, vitest 2.1.9, zod 3.25.76.

---

## Verdict

# FAIL

**One finding, and it is not in the code.** The route itself is correct: I drove it end to end
against a live billing-service process and a live PostgreSQL as `telemetry_app`, and every
acceptance criterion holds — auth ordering, UUID tenant validation, cross-tenant isolation under
90 concurrent interleaved requests, byte-exact `Decimal(18,6)`, pagination arithmetic, the
empty-tenant `200`, and `/health` and `POST /v1/internal/billing/generate` unaffected. All four
gates pass 13/13 with `--force` and 0 cached.

The FAIL is **F-1**: the rework that answered Gate 4's `MEDIUM-3` replaced one false claim with
another. `apps/billing-service/tests/invoice.repository.unit.test.ts:525-530` now asserts that
BU74c is *"the only thing that pins the tie-break"* and that *"**BI16 stayed green**"* under the
mutation. On this host the mutation reddens **BU74c and BI16**, in **7 of 7 runs** across three
configurations. The plan's matching checklist entry (`:632-638`) records the result of that
"re-run" using the **pre-rework** test totals (16 files / 157 tests) on a tree that has 17 files
and 162 tests — so the re-run it claims to have performed cannot have been performed on the tree
that is about to be committed.

This is the `.claude/rules/review-standards.md` § *Universals Must Cite Their Mutation* gate and
the S-33 shape: a universal, believed by its author, refuted by running the thing it forbade.
The fix is a comment correction and a checklist correction — **no code change, no test change,
and the coverage is stronger than the comment claims, not weaker**. It is cheap to close, and it
is the one thing Gate 4 made its `CONDITIONAL` conditional on.

Everything else is PASS. Findings F-2 to F-5 are LOW/NIT and none of them blocks.

---

## 1 · Full gate — measured per package, not headline

`npx turbo run <task> --force` for each of the four, run from a clean tree before any probe.

| Task | Tasks | Cached | Result |
|---|---|---|---|
| `typecheck` | 13 successful, 13 total | **0 cached, 13 total** | 0 errors, exit 0 |
| `lint` | 13 successful, 13 total | **0 cached, 13 total** | **0 errors, 14 warnings**, exit 0 |
| `build` | 13 successful, 13 total | **0 cached, 13 total** | exit 0 |
| `test` | 13 successful, 13 total | **0 cached, 13 total** | exit 0 |

**Per-package test totals I measured** (not a headline; the brief flags a wrong root total as
having shipped in this sequence before):

| Package | Files | Tests |
|---|---|---|
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/shared-types` | 1 | 8 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/usage-service` | 19 | 230 |
| **`@telemetry/billing-service`** | **17** | **162** |
| `@telemetry/auth-service` | 15 | 164 |
| `@telemetry/worker-service` | 12 | 180 |
| `@telemetry/web` | — | 0 (`vitest run --passWithNoTests`, "No test files found, exiting with code 0") |
| **Total** | **81** | **843** |

843 = 838 (the figure at Gate 4) + 5, and billing 162 = 157 + 5, matching the rework's
BU88–BU91 + BU77d. Billing at **17 files / 162 tests** matches the brief.

`pnpm test:smoke` — 6 suites, **7 tests** (gateway 2, auth 1, usage 1, billing 1, analytics 1,
worker 1), all pass, exit 0.

**Warnings proved pre-existing, not asserted.** All 14 sit in two files:
`apps/auth-service/tests/auth.service.unit.test.ts` (10 × `no-misused-promises`) and
`apps/usage-service/tests/ingestion.service.unit.test.ts` (4 × `no-unsafe-assignment`). Neither
appears in `git diff --name-only`; `git log -1` gives `d68e719 2026-08-25` and
`b0f6921 2026-08-31` respectively, both before base `ed670b3`. `grep -c no-unsafe-return` over
the whole lint log → **0**. Matches the brief's expectation exactly (10 @ `d68e719`, 4 @
`b0f6921`).

**One caveat about how I ran `test`.** I used `npx turbo run test --force` directly, which
bypasses the root `pretest` hook (`prisma:generate:auth`). The auth client was already generated
from earlier runs and auth-service passed 164/164, so nothing was skipped in effect — but this
run does **not** re-prove that `pretest` works. Gate 7's CI run does.

---

## 2 · Live-stack exercise (priority 1) — what I actually drove

Booted the real service — `npx tsx src/index.ts`, `PORT=3104`,
`DATABASE_URL` as **`telemetry_app`** (`NOSUPERUSER NOBYPASSRLS`, so RLS enforces),
`REDIS_URL=redis://localhost:6379/12` (deliberately **not** db 0),
`INTERNAL_API_SECRET=qa-t046-live-probe-secret-0123456789` — and drove it with `curl` and a raw
`net.Socket`. Fixtures seeded through the owner connection (`postgres`), because RLS blocks
seeding otherwise.

| Probe | Result |
|---|---|
| no headers at all | `401 {"code":"UNAUTHORIZED"}` |
| `x-tenant-id` only, no secret | `401 UNAUTHORIZED` |
| wrong secret + valid tenant | `401 UNAUTHORIZED` |
| good secret, no tenant header | `401 TENANT_CONTEXT_MISSING` |
| good secret, blank tenant header | `401 TENANT_CONTEXT_MISSING` |
| good secret, `x-tenant-id: abc` | `401 TENANT_CONTEXT_INVALID` |
| good secret, `x-tenant-id: tenant:a` | `401 TENANT_CONTEXT_INVALID` |
| good secret, **valid tenant owning no invoices** | `200 {"data":{"items":[],"total":0,"page":1,"pageSize":20}}` |
| good secret, valid UUID that is **not a tenant at all** | same `200` empty page — no existence oracle |
| good secret, populated tenant | `200`, 7 headers, correct order and fields |

**Hook order is observable live, not only in the suite.** A request with *neither* header
answers `UNAUTHORIZED`, never `TENANT_CONTEXT_MISSING` — internal-auth runs first, so tenant
context is never derived for a caller that has not proved it is the gateway
(`.claude/rules/tenant-isolation.md` § *Forbidden*).

**`/health` and the internal route are structurally outside the new scope — confirmed live:**

| Probe | Result |
|---|---|
| `GET /health`, no headers | `200 {"status":"ok","service":"billing-service"}` |
| `GET /health` with a junk `x-tenant-id` | `200` — the hook does not reach it |
| `POST /v1/internal/billing/generate`, no secret | `401 UNAUTHORIZED` (its own `preHandler` guard) |
| `POST /v1/internal/billing/generate`, secret, **no tenant header** | `400 VALIDATION_ERROR` — the new tenant hook did **not** leak into that scope |
| `POST /v1/internal/billing/generate`, secret, valid body | `200 {"data":{"invoiceId":null}}`, T-045 contract intact |

`Invoice` row count was unchanged by that generate call (no unbilled usage), so T-045's write
path is unaffected as well as its auth path.

---

## 3 · Cross-tenant reachability (priority 2)

Two tenants seeded through the owner connection with deliberately distinctive data (tenant B on
`EUR` with `999999.999999` and `888888.888888`, so a leak would be unmistakable), then read back
as `telemetry_app` with a real RLS context.

Every attempt below returned **only the requesting tenant's rows**, with no tenant-B id, amount
or currency anywhere in the body:

- `?tenantId=<B>`, `?tenant_id=<B>`, `?where[tenantId]=<B>` — all ignored, tenant A's page returned.
- Duplicated `x-tenant-id` in both orders (A-then-B and B-then-A) — `401 TENANT_CONTEXT_INVALID`,
  **neither** uuid echoed in the body.
- `status=DRAFT`, `status=DRAFT&status=PAID` (→ `400`, "received array"), `status[]=DRAFT`,
  `status=`, `status=DRAFT' OR 1=1--` (→ `400`, the injection string reflected only in the
  validation message, never reaching SQL).
- Full page walks at `pageSize` 1, 2, 3, 7, 10 and 100 as tenant A across a 127-row fixture —
  zero tenant-B ids collected.
- Tenant B's own walk returned exactly its 2 rows and zero tenant-A rows.

**Response body never carries `tenantId` or `lineItems`.** Confirmed on the wire: every item has
exactly the eight `InvoiceHeader` keys. This is the explicit `INVOICE_HEADER_SELECT`
(`invoice.repository.ts:116-125`) doing it, not a post-hoc `delete`.

**Concurrency.** 90 requests fired in parallel — 30 each for tenant A (127 rows), tenant B
(2 rows) and a third tenant with 0 rows — interleaved against one process. Result, aggregated:
`30 × A/total=127/only-A-ids`, `30 × B/total=2/only-B-ids`, `30 × C/total=0`. No response
carried another tenant's rows and no total was crossed. The per-request repository **factory**
(`container.ts` `invoiceRepositoryFactory`) holds under concurrency; a singleton would have
pinned one tenant and this probe would have shown it.

**Database layer, re-read live rather than quoted:**
`pg_class` → `Invoice | t | t`, `InvoiceLineItem | f | t`, `Tenant | t | t`, `UsageLine | t | t`.
`pg_policies` → `Invoice | invoice_tenant_isolation | ALL | ("tenantId" = current_setting('app.tenant_id', true))`
and **no row for `InvoiceLineItem`**.

---

## 4 · Precision on the wire (priority 3)

Seeded `totalAmount = 123456789012.123456` (18 significant digits, the full `Decimal(18,6)`
width) through the owner connection and read it back over real HTTP:

```
"totalAmount": "123456789012.123456"
```

Byte-exact, and `typeof` on the parsed value is `string`. `String(Number("123456789012.123456"))`
is `"123456789012.12346"`, so an implementation that let the column become a JS number at any
point could not have produced that string. The fixture change recorded as plan deviation 2 is
correct and load-bearing.

The trap the plan records is real and I re-confirmed its consequence rather than its cause:
because `Prisma.Decimal` defines `toJSON`, an HTTP-level assertion cannot see a `Decimal` leak,
which is why BU75/BI18 assert below the boundary — BI18 calls
`app.container.invoiceRepositoryFactory(...)` directly and asserts
`not.toBeInstanceOf(Prisma.Decimal)` and `not.toBeInstanceOf(Date)`. That is the right level.

**One observation, not a defect** — see F-3: the served string is *not* fixed-scale.
`10.500000` serves as `"10.5"` and `4.000000` as `"4"`.

---

## 5 · Pagination arithmetic (priority 4), and whether a real fixture can discriminate the tie-break

Live, against 7 invoices of which **three share `periodStart = 2026-04-01`**:

- `pageSize=1` walk over 7 pages: `aaaa0007, aaaa0006, aaaa0005, aaaa0004, aaaa0003, aaaa0002,
  aaaa0001` — `periodStart DESC` with `id DESC` breaking the three-way tie, exactly as D4 says.
- `pageSize=2`: pages of 2,2,2 then a **last partial page of 1**; `pageSize=3`: 3,3,1.
- Union across all pages at `pageSize=2`: each of the 7 ids exactly once, none missing, none
  repeated.
- `page=4&pageSize=3` (past the end): `200`, `items: []`, `total: 7` — `total` stays the size of
  the filtered set, not of the page.
- `total`/`page`/`pageSize` consistency held on every response, including filtered
  (`status=FINALIZED` → `total` 1, not 7).

**The brief's question — can a real multi-page fixture distinguish the `id` tie-break where
BU74c can only pin it structurally? Yes, and the shipped BI16 already does.** This is F-1.

What I measured, with the tie-break deleted from `INVOICE_LIST_ORDER_BY`:

| Configuration | Result |
|---|---|
| whole billing suite, `Invoice` holding 129 unrelated rows | `Test Files 2 failed \| 15 passed (17)` · `Tests 2 failed \| 160 passed (162)` — **BU74c and BI16** |
| `vitest run tests/billing.integration.test.ts` ×3, 129 unrelated rows present | `Tests 1 failed \| 23 passed (24)` each time — **BI16** |
| `vitest run tests/billing.integration.test.ts` ×3, `Invoice` otherwise **empty** | `Tests 1 failed \| 23 passed (24)` each time — **BI16** |

7 of 7. Table contents were **not** the controlling variable — I tested that specifically.

The failure is precise and always in the same place:

```
AssertionError: expected 2 to be 3 // Object.is equality
  ❯ tests/billing.integration.test.ts:953
       expect(new Set(walked).size).toBe(seededIds.length);
```

That is the **single-row walk**, not the page-union. BI16's union assertions at
`billing.integration.test.ts:941-942` (`pageSize=2`, two pages) **do** stay green under the
mutation — so the review's and the comment's specific statement about the *union* is right. What
is wrong is the conclusion drawn from it about BI16 as a whole, because BI16 contains a second,
stronger block the union analysis never looked at.

I also separately established, live against the running service with the tie-break deleted, that
a **larger** fixture does not help the union form either: 120 rows sharing one `periodStart`,
walked at `pageSize` 10 and 7, three runs each — 0 duplicated ids, all 127 collected, every time.
The mechanism is visible in the plan:

```
EXPLAIN ... ORDER BY "periodStart" DESC LIMIT 10 OFFSET 50
  Limit -> Sort (Sort Key: "periodStart" DESC) -> Seq Scan on "Invoice"
```

A full scan plus a full sort of an unchanging heap is reproducible run to run, so two `LIMIT
n OFFSET k` queries agree. What breaks it is `pageSize=1`, where the `LIMIT 1` plan differs and
the tie order moves — which is exactly what the walk block exercises and the union block does
not. So the honest statement is **not** "BI16 cannot discriminate"; it is "the union half cannot,
and the walk half can and does".

---

## 6 · Verification of the Gate-4 rework

Each item re-derived independently, by execution.

### MEDIUM-1 — **verified accurate**

`grep -n "^  async" invoice.repository.ts` run from the file's own directory lists **five**:
`tenantExists` (:204), `findByPeriod` (:220), `sumUnbilledByMetricKey` (:244),
`createDraftInvoice` (:285), `listInvoices` (:378). Exactly the five names the docblock writes.
None takes a `tenantId` and none takes a bare `invoiceId`. `grep -n invoiceId` returns 7 lines
and every one is accounted for by the corrected wording: `:140` returned field, `:172`/`:174`
comment, `:289` local binding, `:299` comment, `:339`/`:358` returned field — **never a
parameter**. Both the numeral and the substance check out.

### MEDIUM-2 — **verified, and the weakened wording is the right strength**

Three temporary subclasses of `TenantScopedRepository` under
`pnpm --filter @telemetry/billing-service typecheck`, probe file removed afterwards:

| Probe | Body | My result |
|---|---|---|
| A | `findById(id: string, _tenantId: TenantId)` calling `this.where({ id })` | **compiles, exit 0** |
| B | the same calling `this.where({ id, tenantId })` | `src/repositories/qa-probe.ts(7,89): error TS2322: Type 'TenantId' is not assignable to type 'undefined'.` |
| C | the same building `where: { id, tenantId }` by hand, never touching `this.where` | **compiles, exit 0** |

Probe C — the load-bearing one, and the reason the universal had to go — reproduces. TS2322, not
TS2345, as the docblock now says. *"A convention the call-site shape supports, not a type-level
impossibility"* is precisely what is measured.

### MEDIUM-3 — **does NOT reproduce. This is F-1.** See §5.

### MEDIUM-4 — **verified, including the 500 case re-performed**

`tests/billing.controller.unit.test.ts` (BU88–BU91) exists and is not tautological: BU89 carries
the negative `expect(listInvoices).not.toHaveBeenCalled()`, BU90 uses `TenantNotFoundError`
(404/`TENANT_NOT_FOUND`, distinct from both of the controller's own statuses), BU91 asserts the
body by **exact equality** plus `not.toContain(secret)` plus the detail *present in the log*.

I re-performed the 500 binding, as asked. Mutation: `billing.controller.ts:74`,
`message: BILLING_RESPONSES.MESSAGE_INTERNAL_ERROR` →
`message: error instanceof Error ? error.message : String(error)`. Whole billing suite:

```
× BillingController.listInvoices > BU91 - answers 500 for an unexpected failure, logging it and leaking nothing
  Test Files  1 failed | 16 passed (17)      Tests  1 failed | 161 passed (162)
```

**Exactly one case red, and it is the one that names the branch.** The "leaks nothing" contract
is asserted by exact-equality on a two-field body, so an added `error`/`stack`/`detail` field
would fail rather than slip through — which is what the mutation demonstrates.

I also hit this branch **for real** over HTTP (F-2): a `500` from a genuine
`PrismaClientValidationError` returned `{"code":"INTERNAL_ERROR","message":"Internal server
error"}` and nothing else, while the underlying Prisma error — including the full query tree and
the tenant id — went to the log. The unit contract and the live behaviour agree.

### LOW-2 — **verified over a real socket, and the transport claim is exactly right**

Instrumented probe returning `typeof`, the value and `Array.isArray` (probe file created inside
the package to resolve `fastify`, then removed):

```
real socket, 2 X-Tenant-Id lines : {"t":"string","v":"<A>, <B>","arr":false}
app.inject, array value          : {"t":"string","v":"<A>,<B>","arr":false}
app.inject, pre-joined string    : {"t":"string","v":"<A>,<B>","arr":false}
```

The separator **is** transport-dependent (`", "` over a socket, `","` through `app.inject`), and
every form is `typeof === "string"`, never an array — so the middleware's
`typeof header !== "string"` arm is reached by an *absent* header, and `tenantIdSchema` is what
rejects a duplicate. Both separators are asserted by BU77d, correctly.

Driven through the real service over a raw socket, all four duplicate forms (2 header lines,
3 header lines, comma-joined, comma-space-joined) answered `401 TENANT_CONTEXT_INVALID` with
**neither uuid** present in the body. `set-cookie` was not probed and I agree it does not matter
here: it is not the header under test, nothing in this path reads it, and the property that
matters — no value preferred over another — is established for the header that is.

### LOW-4 — **spot-checked the hook swap, reproduces verbatim**

Mutation: swap the two `addHook` calls at `app.ts:97-98`. Whole billing suite:

```
× GET /v1/billing/invoices > BU79 - runs internal-auth before tenant context ...
× GET /v1/billing/invoices (integration) > BI20 - a missing or wrong X-Internal-Secret is 401 before any tenant context is derived
  Test Files  2 failed | 15 passed (17)      Tests  2 failed | 160 passed (162)
```

Identical to the corrected record in the plan's LOW-4 table, down to the totals. The corrected
record is accurate.

I did not re-run the `withTenant`-bypass record; it is the second half of LOW-4 and the brief
asked for one spot-check. Recorded as unverified in §10.

---

## 7 · Defects

### F-1 · MEDIUM · The MEDIUM-3 rework's central claim is false on this host, and the plan records a re-run that cannot have happened on the shipped tree

**Where.**
- `apps/billing-service/tests/invoice.repository.unit.test.ts:525` — *"**This assertion is the
  only thing that pins the tie-break, and it pins it structurally, not behaviourally.**"*
- `apps/billing-service/tests/invoice.repository.unit.test.ts:530` — *"**BI16 stayed green.**"*
- `apps/billing-service/tests/invoice.repository.unit.test.ts:533-541` — *"No behavioural case
  was written, deliberately. To make BI16 discriminate, its fixture would have to reach a row
  count at which …"* — the premise of which is that BI16 does not discriminate today.
- `docs/plans/t-046-invoice-list-endpoint.md:632-638` — the checklist entry recording the re-run.

**Reproduction.**

```bash
cd /home/admin1/personal-workspace/telemetry-platform
# delete `{ [BILLING_INVOICE_LIST.SORT_FIELD_ID]: ... }` (line 129) from INVOICE_LIST_ORDER_BY
# in apps/billing-service/src/repositories/invoice.repository.ts
pnpm --filter @telemetry/billing-service test
```

Observed, 7 of 7 runs across whole-suite and integration-only, with and without unrelated rows
in `"Invoice"`:

```
× InvoiceRepository.listInvoices > BU74c - pages with skip/take and sorts periodStart desc then id desc
× GET /v1/billing/invoices (integration) > BI16 - paging covers every row exactly once, even when two invoices share a periodStart
    → AssertionError: expected 2 to be 3   at tests/billing.integration.test.ts:953
  Test Files  2 failed | 15 passed (17)      Tests  2 failed | 160 passed (162)
```

**Why it matters, and why it is MEDIUM rather than LOW.** The coverage is *better* than the
comment claims, so nothing is at risk today. What is at risk is the next edit: the comment tells
a reader that BI16 does not notice, and the paragraph at `:533-541` argues at length that a
behavioural case would be a test that "can pass for the wrong reason". A reader who believes that
may delete or weaken the walk block at `:944-954` — the only assertion that actually catches a
dropped tie-break behaviourally — on the strength of a sentence that is false. That is the
`.claude/rules/review-standards.md` § *Universals Must Cite Their Mutation* failure mode verbatim,
and the S-33 shape: *"ask what would have to be true for the claim to be false, and test that"*.

**The likely mechanism, stated as inference and not as measurement.** The plan's slice-5
description of BI16 (`:512-513`) specifies only the `pageSize=2` union, with no single-row walk.
The walk block was added during implementation. Gate 4's measurement (`BI16 stayed green`,
16 files / 157 tests) is consistent with a tree whose BI16 was union-only or whose fixture
differed. The rework then recorded the *same* 16/157 totals as the result of a fresh re-run on a
tree that has 17 files and 162 tests — so what was recorded is the reviewer's earlier number, not
a new measurement. I cannot reconstruct their tree, so I state only what I measured and what the
totals show.

**Fix — no code change.** Correct `:525-541` to say what was measured: BU74c pins the `orderBy`
structurally; BI16's **union** half (`billing.integration.test.ts:941-942`) does not
discriminate at `pageSize=2`, and its **single-row walk** (`:945-954`) does — measured red at
`:953` with `expected 2 to be 3`, 7/7, whole-suite and scoped, with and without unrelated rows in
the table. Then correct the plan's `:632-638` totals to `Test Files 2 failed | 15 passed (17)` /
`Tests 2 failed | 160 passed (162)`, with BU74c **and** BI16 named.

*(A decision on how to close this is offered in §11, because one option changes the diff more
than the others.)*

### F-2 · LOW · `page` has no upper bound, so a query parameter reaches a `500`

**Where.** `apps/billing-service/src/validators/invoice-list.validator.ts:31-35` — `page` is
`z.coerce.number().int().min(MIN_PAGE).default(DEFAULT_PAGE)` with no `.max(...)`, while
`pageSize` (`:36-41`) has both bounds. `apps/billing-service/src/repositories/invoice.repository.ts:388`
then computes `skip: (query.page - 1) * query.pageSize`.

**Reproduction**, live against the running service:

```
GET /v1/billing/invoices?page=1e17  -> 200 {"data":{"items":[],"total":7,"page":100000000000000000,"pageSize":20}}
GET /v1/billing/invoices?page=1e18  -> 500 {"code":"INTERNAL_ERROR","message":"Internal server error"}
GET /v1/billing/invoices?page=1e308 -> 500 (same body)
```

Server log:
`Unable to fit value 2e+307 into a 64-bit signed integer for field 'skip'` →
`PrismaClientValidationError`, which `registerGlobalErrorHandler` has no mapping for. The
threshold is where `(page - 1) * pageSize` exceeds `2^63`, so it moves with `pageSize`.

**It fails safely.** The response body is exactly the two-field internal-error shape, the
transaction rolled back cleanly (`"Tenant-scoped transaction failed and was rolled back"`), no
tenant data is disclosed, and this is only reachable by an authenticated, tenant-scoped caller.
`page=1e400`, `page=Infinity` and `page=NaN` are all correctly `400`.

**Not introduced by T-046, and this matters for the disposition.** usage-service has the
identical shape — `apps/usage-service/src/validators/usage-summary.validator.ts:34-38`, `page`
with `.min()` and no `.max()`, feeding
`apps/usage-service/src/repositories/usage.repository.ts:154` `const offset = (input.page - 1) *
input.pageSize;` into a raw `OFFSET ${offset}` bind. `grep -rn "MAX_PAGE\b" apps/*/src` returns
nothing on any service. T-046 mirrored the established precedent faithfully, which is what
`CLAUDE.md` instruction 5 asks for. I did **not** drive usage-service live, so its behaviour is a
code-level observation, not a measurement.

**Recommended for `.claude/rules/known-gaps.md`** rather than fixed here — fixing it means
adding a `MAX_PAGE` to two services' constants and validators inside a billing feature task,
which is the one-task-per-commit objection that kept S-8 out of S-4 and S-19 out of S-18.

### F-3 · NIT · The served `totalAmount` is not fixed-scale

`toAmountString` (`invoice.repository.ts:161`) is `String(value ?? 0)`, and
`String(new Prisma.Decimal("10.500000"))` is `"10.5"`. Live: a stored `10.500000` serves as
`"10.5"` and `4.000000` as `"4"`, while `123456789012.123456` serves in full.

Not a defect — the contract is `totalAmount: string` and precision is preserved exactly — but a
client that string-compares an amount across two sources, or renders it without formatting, will
see a varying number of decimal places. If a fixed `Decimal(18,6)` presentation is wanted, that
is a contract decision, and it should be made before a UI depends on the current shape.
Worth one sentence in the `toAmountString` docblock either way.

### F-4 · NIT · An array-shaped `status` parameter is silently ignored rather than rejected

`GET /v1/billing/invoices?status[]=DRAFT` → `200` with the **unfiltered** list, because Fastify's
querystring parser produces the key `"status[]"`, which the schema does not know and does not
reject. Contrast `?status=DRAFT&status=PAID`, which arrives as an array under the right key and
is correctly `400 VALIDATION_ERROR` ("received array").

No leak, no wrong tenant, and the result is a superset the caller is entitled to see — so this is
cosmetic. Recorded because a client that believes it filtered and did not is a support ticket,
and because no case covers it.

### F-5 · NIT · Unauthenticated callers can distinguish a registered path from an unregistered one

Live, with no headers at all: `GET /v1/billing/invoices` → `401`, `GET /v1/billing/nope` → `404`
with Fastify's default body (`{"message":"Route GET:/v1/billing/nope not found","error":"Not
Found","statusCode":404}`). Encapsulation means the guard only runs for routes *inside* the
scope, so an unmatched path never reaches it.

Structural consequence of the (correct) `app.register` design, not a T-046 defect, and billing is
not directly exposed — the gateway requires a Bearer token for `/v1/billing/*`
(`GATEWAY_PROXY_PREFIXES.BILLING`, absent from `GATEWAY_PUBLIC_ROUTES`). Recorded so it is a
known property rather than a surprise.

---

## 8 · Acceptance criteria — walked, and each one checked against a test that would go red

The plan's §6 mapping, verified rather than accepted. "Live" means I also drove it end to end.

| AC | Proven by | Verdict |
|---|---|---|
| AC1 `200 { data: PaginatedResult<InvoiceHeader> }` | BU80, BI14 — **live** | PASS |
| AC2 `status` filters; unknown is `400` | BU71, BU81, BI15 — **live**, incl. `BOGUS`, empty and an injection string | PASS |
| AC3 defaults 1/20; `pageSize>100` → `400`; `<1` → `400` | BU72, BU73, BU81 (route level, the LOW-3 addition), BI16 — **live** at 0, 1, 100, 101 | PASS (see F-2 for the `page` upper end) |
| AC4 exactly eight fields, no `lineItems` | BU82, BI14 — **live**, `Object.keys().sort()` equality | PASS |
| AC5 `totalAmount` string, `Decimal` never leaves the repository | BU75, BU82, BI18 — **live**, byte-exact at 18 significant digits | PASS |
| AC6 ISO dates, `finalizedAt` ISO or `null` | BU76, BI14 — **live**, `null` preserved for `DRAFT` | PASS |
| AC7 another tenant's invoices never returned | BU74, BU85, BI17 — **live**, 90 concurrent interleaved requests | PASS |
| AC8 missing/blank tenant → `401 TENANT_CONTEXT_MISSING` | BU77a, BI19 — **live** | PASS |
| AC9 non-UUID tenant → `401 TENANT_CONTEXT_INVALID`, incl. duplicated header | BU77b, BU77d, BI19 — **live over a raw socket** | PASS |
| AC10 missing/wrong secret → `401`, route inside the scope | BU78, BI20 — **live**; swap mutation reddens BU79+BI20 | PASS |
| AC11 internal-auth before tenant context | BU79 — **live**, distinguished by error *code* not status | PASS |
| AC12 `/health` and the internal route unaffected | BU83 + all of T-045's BU54–BU70 and BI0–BI13 green — **live** | PASS |
| AC13 empty result is `200`, not `404` | BU84, BI21 — **live**, for a real tenant and for a UUID that is no tenant | PASS |

**No tautological test found.** Spot-checked the shapes most at risk: BU74's helper `firstArg`
(`invoice.repository.unit.test.ts:131-137`) **throws** when the call is missing rather than
passing vacuously, per `.claude/rules/testing.md`; BU74/BU85 carry negative assertions
(`JSON.stringify(...).not.toContain(OTHER_TENANT_ID)`) rather than only positive ones; BU74b
asserts the unfiltered `where` at **key level** so `{ tenantId, status: undefined }` cannot pass
as `{ tenantId }`; BU79 asserts the *code* because both hook orders share the `401`; BU91 uses
exact equality on the body. BI17 asserts against a row the requesting tenant could not have
created (seeded for the other tenant through the owner connection), which is the standard
`.claude/rules/tenant-isolation.md` asks for.

---

## 9 · Coverage gaps (no test today; none of them blocks)

1. **`page` upper bound** — F-2. No case sends a `page` that overflows `skip`. Both the `400` for
   `1e400`/`Infinity`/`NaN` and the `500` for `1e18` are untested.
2. **The array-shaped `status` key** — F-4. `?status[]=DRAFT` is uncovered.
3. **`page=` / `pageSize=` present but empty** — both answer `400` ("must be greater than or
   equal to 1") rather than falling back to the default, because `z.coerce.number()("")` is `0`.
   Defensible, undocumented, untested.
4. **The real `PrismaClientValidationError` → `500` path** — BU91 covers it with a stubbed
   rejection; nothing standing drives it through a real Prisma failure. F-2 is the cheapest
   vehicle if someone wants one.
5. **Index behaviour at volume** — unchanged from Gate 4. At 127 rows `EXPLAIN` chooses
   `Seq Scan + Sort`; the repository docblock (`:347-351`) correctly refuses to claim index
   coverage. Whether `Invoice_tenantId_status_idx` is used at production volume is still
   unmeasured, and correctly dispositioned as R6.
6. **Sharded / multi-worker vitest** — billing's integration suite uses fixed tenant ids and
   cleans in `beforeEach` + `afterEach` + `afterAll` with `assertRunStateEmpty` (the S-20-safe
   shape), but I ran it single-worker only, as configured.

---

## 10 · Regression risk across the other 12 packages

**None found.**

- **Breaking-change assessment.** The only file T-046 touches outside billing-service is
  `packages/shared-types/src/index.ts`, and the change is **additive**:
  `TENANT_CONTEXT_HEADERS.TENANT_ID = "x-tenant-id"`, a new export. No existing export is
  renamed, removed or retyped. `shared-types` 8/8 green; every consumer package green with
  `--force` and 0 cached. Gateway (38), usage (230), auth (164), worker (180), analytics (18)
  all unchanged from their Gate-4 figures.
- **billing-service internals.** T-045's contract is intact: BU54–BU70 and BI0–BI13 green in
  every run including under all four mutations, and I drove `POST /v1/internal/billing/generate`
  live with and without the secret and with and without a tenant header — the new hooks do not
  reach it. `/health` likewise.
- **No schema or migration change.** `prisma/schema.prisma` untouched; no new migration.
- **The `FastifyRequest.tenantId` augmentation.** billing declares `tenantId?: TenantId`,
  usage-service declares `tenantId: string`. Re-checked: nothing imports across the two packages
  (`grep -rn "usage-service" apps/billing-service/src apps/billing-service/package.json` →
  comments only, no import, no dependency), and both packages typecheck clean. R7 stands as a
  watch item, not a live conflict.

### The three gaps the brief asked me to rule on

- **S-10 — does not bite T-046. Confirmed, and I re-read the database rather than quoting.**
  `pg_class`: `Invoice | relrowsecurity=t | relforcerowsecurity=t`, with policy
  `invoice_tenant_isolation | ALL | ("tenantId" = current_setting('app.tenant_id', true))`.
  `InvoiceLineItem | relrowsecurity=f`, **no policy at all**. T-046 returns headers only — the
  explicit `INVOICE_HEADER_SELECT` cannot reach `lineItems` — so the list path has both layers.
  **Handed forward to T-047**, which includes `lineItems` and where a cross-tenant `404` test
  would pass on the application predicate alone with nothing behind it. The handoff is recorded
  accurately in three places (plan §3, `invoice.repository.ts:92-100`, and invariant 3's docblock).
- **S-19 — does not bite. Confirmed.** `listInvoices` binds **no timestamp**: `where` is
  `tenantId` plus optional `status`, then `orderBy`/`skip`/`take`, and the three dates are
  outputs only. No `$queryRaw` anywhere in the method. billing's `base.repository.ts` has no
  `set_config('TimeZone', …)` pin and T-046 correctly does not add one. Incidental live evidence
  that the read path is zone-stable: this host runs `TimeZone = Asia/Kolkata` and the live
  service returned `"periodStart":"2026-01-01T00:00:00.000Z"` byte-exact.
- **S-39 — accurate as filed. Confirmed.** The entry's grep reproduces verbatim, line numbers
  included: `apps/gateway/src/constants.ts:14`, `apps/usage-service/src/constants.ts:16`,
  `packages/shared-types/src/index.ts:93`, all three `"x-tenant-id"`. billing adds **no** literal
  of its own — `apps/billing-service/src/constants.ts:24` is
  `TENANT_ID: TENANT_CONTEXT_HEADERS.TENANT_ID`. Three definitions of one wire string, one
  canonical and two legacy, exactly as the entry says.

---

## 11 · What I could not validate, and why

- **Whether Gate 4's and the rework's "BI16 stayed green" was ever true.** I cannot reconstruct
  the tree they measured. I can only report that it does not reproduce here, 7/7, and that the
  totals recorded for the "re-run" belong to a tree with 5 fewer tests than the one being
  committed. §7 F-1 states the mechanism as inference and labels it as such.
- **The `withTenant`-bypass half of LOW-4.** I spot-checked the hook swap (reproduces verbatim)
  and did not re-run the bypass. Unverified by me; verified by Gate 4.
- **usage-service's behaviour under an overflowing `page`.** F-2's usage-service half is read
  from the code, not driven. The billing half is measured.
- **Index use at production volume.** `EXPLAIN` at 127 rows is a `Seq Scan`; nothing here says
  anything about 10^6 rows. R6.
- **`findMany` + `count` isolation from a concurrent insert.** BU74d proves one `$transaction`
  and one call each, and my 90-request concurrency probe found no crossed tenant — but I did not
  drive a write concurrent with a read, so "the page and the total describe the same row set
  under concurrent insert" remains reasoning from PostgreSQL snapshot semantics, not a
  measurement.
- **Fastify versions other than 5.10.0, and `set-cookie` as an array-valued header.** Out of
  scope and, for `set-cookie`, not relevant to this path — see §6 LOW-2.
- **The gateway → billing hop end to end.** I drove billing directly on port 3104. The gateway's
  header handling is re-derived from source (`proxy.plugin.ts:34-37` and `:45-50`,
  `guards.middleware.ts:52-56`), not exercised, because booting the full proxy chain is beyond
  this gate's scope. Gate 7's compose smoke is where that belongs.
- **`pnpm test`'s `pretest` hook.** I invoked turbo directly; see §1.

---

## 12 · Environment

- **Database left exactly as found.** `Tenant = 2`; `Event`, `UsageLine`, `Invoice`,
  `InvoiceLineItem`, `Meter` all **0**; `User = 2`. Baseline re-counted at QA start and again at
  the end. Every fixture I seeded (9 invoices, then 120 more, plus one temporary tenant) was
  seeded through `DIRECT_DATABASE_URL` (the owner) and deleted by explicit id.
- **The running service was pointed at `telemetry_app`**, never at the owner connection.
- **Redis.** db 0 `DBSIZE` was **2** at QA start (`telemetry:events` plus one TTL'd
  `denylist:*` key), **2** immediately after the mandated `pnpm test` — with a *different*
  `denylist:*` hash, because the first key expired and the gate wrote a new one — and **1** at
  the end of the session, once that second key also expired. So the only residue is
  `telemetry:events`, which was there before I started. **The `denylist:*` writes are S-22 and
  are unavoidable while it is open; reporting them rather than rounding to green.** My own probes
  used db 12 (left at 0); db 13, 14 and 15 all 0. Nothing was flushed.
- **Postgres and Redis left running.** Neither was stopped. `pg_isready` OK, `redis-cli ping` →
  `PONG`.
- **Tree restored byte-identical.** Four mutations were applied and reverted from pre-mutation
  copies, each verified by `md5sum`:
  `app.ts` `a0c531cf6827b57cdc083f7f0fff8548`,
  `billing.controller.ts` `c253c2c84a7624507dcc9a2080ffb107`,
  `invoice.repository.ts` `16bd43d8332283249ebf4c8112824ce3`.
  Two temporary probe files (`src/repositories/qa-probe.ts`, `sep-qa-probe.mjs`) were created
  inside the package and removed; `find apps packages -name "qa-probe*" -o -name "sep-qa-probe*"`
  returns nothing. `git status --porcelain` returns the same **31** entries as at QA start.
  Final clean `pnpm --filter @telemetry/billing-service test` → **17 files / 162 tests, 0
  failures**.
- **Nothing committed, staged or branched.** The only file this gate wrote is this report.

---

## 13 · Decision for you

**How should F-1 be closed?** FAIL loops back to Gate 3, and the three options differ in how much
of the diff they touch.

| Option | What changes |
|---|---|
| **A · Correct the two claims to what was measured (recommended)** | Rewrite `invoice.repository.unit.test.ts:525-541` to say: BU74c pins the `orderBy` structurally; BI16's **union** half (`:941-942`) does not discriminate; BI16's **single-row walk** (`:945-954`) **does**, measured red at `:953` (`expected 2 to be 3`), 7/7, whole-suite and scoped, with and without unrelated rows. Correct the plan's `:632-638` to `Test Files 2 failed \| 15 passed (17)` / `Tests 2 failed \| 160 passed (162)`, naming BU74c **and** BI16. **Diff: ~12 lines of comment and plan. No code, no test.** |
| B · A, plus file the discrepancy in `known-gaps.md` | Everything in A, plus a short entry next to S-21 and S-33 recording that a mutation result was carried forward across a rework without re-measurement, and that the pre-rework test totals are how it was caught. **Diff: A + ~15 lines in `.claude/rules/known-gaps.md`.** |
| C · Accept the comment as environment-specific and annotate rather than rewrite | Leave the structure, add "measured on the Gate-4 host; on the QA host the mutation also reddens BI16" . **Diff: ~3 lines.** Cheapest, and I would not take it: it leaves the universal *"the only thing that pins the tie-break"* standing, and that sentence is the one that would license deleting the walk block. |

**Recommendation: A.** It is the smallest change that makes every sentence true, and it turns a
discouraging note into an accurate account of which half of BI16 does the work — which is
information the T-047 author needs, because they inherit this repository and this fixture shape.
B is worth it only if you think the carry-forward pattern will recur; the S-33 entry arguably
already covers it, which is why I did not fold it in by default.

All three change the diff. A and B are substantively different from C; A and B differ only in
whether the process lesson is recorded outside the plan.

**Second, smaller decision — where does F-2 (`page` has no upper bound) go?**

| Option | What changes |
|---|---|
| **A · File in `.claude/rules/known-gaps.md` as its own entry (recommended)** | Records the measurement, names both services, and leaves the fix to a task that owns both validators. **Diff: ~20 lines of `known-gaps.md`, no code.** |
| B · Fix it in T-046 | Add `MAX_PAGE` to `BILLING_INVOICE_LIST` and `.max(...)` to the validator, plus a case. **Diff: ~6 lines + 1 test** — but it leaves usage-service divergent, so the platform now has two strictnesses for `page`, which is the S-23 shape. |
| C · Fix both services | Closes it properly and puts usage-service's constants and validator in a billing feature commit, which is the one-task-per-commit objection that kept S-8 out of S-4. **Diff: 2 services, ~12 lines + 2 tests.** |

**Recommendation: A.** It fails closed, it leaks nothing, and it is a faithful mirror of an
existing platform pattern — fixing one side of a two-service pattern inside a feature task is
what this repo has repeatedly declined to do.

---

## Gate

**FAIL** — back to Gate 3 for F-1 (documentation only; §13 decision 1). F-2 to F-5 are LOW/NIT
and do not block. On re-submission the billing package suite should be re-run; the root gate does
not need re-running for a comment-only change, but Gate 7 will re-run it before commit anyway.

**Release readiness.** The endpoint itself is release-ready. Tenant isolation holds at both
layers and was exercised live as a `NOSUPERUSER NOBYPASSRLS` role against rows the requesting
tenant could not have created; precision, pagination, error contracts and scope encapsulation all
behave as specified; no regression reaches any of the other 12 packages. The only thing standing
between this and a commit is ~12 lines of prose that currently say something I measured to be
false.
