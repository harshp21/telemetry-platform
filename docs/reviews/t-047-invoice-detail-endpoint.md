# T-047 · Invoice detail (`GET /v1/billing/invoices/:id`) — Senior Reviewer

## Round 1

**Gate 4 (pre-QA).** Base `21497bd`, nothing committed or staged. Read-only: every mutation below was
reverted and the tree re-checksummed byte-identical (`md5sum -c`, 17/17 `OK`).

**Rules revision read from disk, not from the injected copy.** `.claude/rules/known-gaps.md`:
2802 lines, `md5sum 39b3d07c0f19cfd2ab5cb09ac7f30d97`, headings **S-5 … S-47**, `git log -1` →
`21497bd`. The copy injected into this review session ended at **S-39** — it could not see S-40
through S-46, nor the S-47 this very diff adds. That is a **tenth sighting of S-24** this session
and the ninth in a row where the injected copy was stale. Every gap cited below was re-read from
the file on disk.

---

## Verdict

**CONDITIONAL.**

No BLOCKER and no HIGH. Tenant isolation is correct and, unusually for this table, *measured* rather
than asserted — the re-route leak was reproduced end-to-end as a real response body, and the Prisma
suppression the design rests on survived six dimensions the plan never varied. Four items must be
fixed before commit; three more are recommended.

**Required before commit:** M-1, M-2, L-1, L-2.
**Recommended:** L-3, L-4, L-5.
**Requires a user decision:** D-A (the type-level guarantee) and D-B (whether S-47 lands here) —
both shaped as choices at the end.

---

## Findings

### M-1 · A false claim in a comment beside the route-scoping security contract — MEDIUM

`apps/billing-service/tests/billing-invoice-detail.route.test.ts:100-102`:

```ts
// The observable form of "the route is inside the guarded scope". Moving the
// `scope.get(...)` out of `registerBillingRoutes` makes this a 200 carrying an invoice.
expect(getInvoice).not.toHaveBeenCalled();
```

**Measured, by performing exactly that mutation** — `scope.get(BILLING_ROUTES.INVOICE_DETAIL, …)`
deleted from `registerBillingRoutes` and re-registered as `app.get(...)` on the root instance:

```
× BU115 … → expected 400 to be 401
× BU116 … → expected 400 to be 401
× BU117 … → expected 400 to be 200
× BU119 … → TypeError: Cannot convert undefined or null to object
  Tests  4 failed | 2 passed (6)
```

It is **400**, not 200, and **no invoice is carried**. The reason is in this diff:
`apps/billing-service/src/controllers/billing.controller.ts:109-115` — without the tenant-context
hook `request.tenantId` is `undefined`, so the controller's own guard answers
`400 VALIDATION_ERROR / MESSAGE_TENANT_CONTEXT_REQUIRED` before the service is reached.

BU115 *does* redden, so the case is not decoration and the security property holds. What is wrong is
the stated failure mode, next to the assertion a future reader will use to decide whether the case
still earns its place — and it overstates the exposure, which is the direction that gets a guard
deleted as paranoid.

**Fix** (`billing-invoice-detail.route.test.ts:100-102`), replace with the measured form:

```ts
// The observable form of "the route is inside the guarded scope". Measured at Gate 4 by
// re-registering this route with `app.get(...)` on the root instance: BU115/BU116 fail
// `expected 400 to be 401`, BU117 `expected 400 to be 200`, BU119 throws. It is a 400 and
// not a 200 because `billing.controller.ts:109-115` catches the missing tenant context --
// so the leak this case guards against is "unauthenticated reachability", not "an invoice
// on the wire".
```

---

### M-2 · Two error paths of the new controller handler have no test — MEDIUM

`apps/billing-service/src/controllers/billing.controller.ts:109-115` (the `!tenantId` guard) and
`:120-140` (the non-`AppError` catch-all → `500 INTERNAL_ERROR` plus a log line) are **uncovered**.

Measured, `pnpm exec vitest run --coverage`:

```
src/controllers   |   94.32 |    86.11 |     100 |   94.32 |
  billing.controller.ts |  91.39 | 82.60 | 100 | 91.39 | 110-115,129-130
  internal.controller.ts|    100 | 92.30 | 100 |   100  | 68
```

Both uncovered ranges are inside `getInvoice`. The `AppError` arm (`:121-126`) *is* covered, by
BI29/BI30 end-to-end.

The asymmetry is the finding. T-046 wrote the counterparts for `listInvoices` —
`apps/billing-service/tests/billing.controller.unit.test.ts:101` (`BU89`, no tenant context → 400)
and `:137` (`BU91`, unexpected failure → 500, logged, leaking nothing) — and T-047 added none.
`billing.controller.unit.test.ts` does not appear in the diff at all
(`git status --porcelain` lists 12 modified billing files; that is not one of them).

The `500` path is production-reachable: any repository or connection failure that is not an
`AppError` lands there. `BU114` proves the *service* propagates it unchanged; nothing proves the
*controller* maps it to `500` rather than, say, letting it escape to Fastify's default handler.

Package thresholds (80 lines / 75 branches) still pass, so no gate catches this.

**Fix:** add two cases to `apps/billing-service/tests/billing.controller.unit.test.ts`, mirroring
`BU89` and `BU91` against `getInvoice` (next free ids are `BU121`, `BU122` — `BU120` is the highest
this task ships). Confirm each red first: deleting the `!tenantId` block and deleting the
`this.logger.error(...)`/`500` tail respectively.

---

### M-3 · "reddens `BU120` alone" is refuted — 26 cases redden — MEDIUM

The Gate-3 hand-off establishes `BU120`'s redness by moving the hooks to the root instance and states
the mutation reddens **`BU120` alone**. Re-performed: `billingApi.addHook(...)` → `app.addHook(...)`
with `registerBillingRoutes(app, …)`, then the whole billing package:

```
 Test Files  6 failed | 13 passed (19)
      Tests  26 failed | 179 passed (205)
```

The red set spans `billing.controller`/env-schema cases, `BU65`–`BU69`, `BU83`, `BU120`, the smoke
suite and 14 integration cases. `BU120` is among them, so its redness *is* established — the
**specificity** is not.

Related, and the reason this matters rather than being pedantry: `BU120`
(`billing-invoice-detail.route.test.ts:185`) asserts the same two properties as `BU83`
(`billing-invoices.route.test.ts`), against the same scope, and both routes are registered by the
same `registerBillingRoutes` call. I could not construct a mutation that reddens one without the
other. `BU120` is a cheap duplicate regression case, not a guard on the detail route specifically —
which is what the implementer's own "green whether or not the route exists" already said honestly.

**This claim is in no shipped file** — I grepped `docs/plans/t-047-invoice-detail-endpoint.md` and
every new/changed source and test file for it. So **no diff change is required**. The obligation is
that it must not enter the commit message, and the hand-off's phrasing should be corrected to
"reddens `BU120` among 26 cases across 6 files".

---

### L-1 · A false universal in the `readLineItems` docblock — LOW

`apps/billing-service/tests/integration.fixtures.ts:368-369`:

> "Every existing caller either counts rows, filters them, or sorts before asserting, so refining
> the order changes no case's expectation."

**Three counter-examples, all indexing the result positionally with no count, filter or sort:**

- `apps/billing-service/tests/billing.integration.test.ts:189` and `:194-195` — `BI1`
  (`lineItems.map(item => item.metricKey)).toEqual([...])`, then `lineItems[0]`, `lineItems[1]`)
- `:498-499` — `BI8` (`lineItems[0]?.quantity`, `lineItems[0]?.unitPrice`)
- `:580-587` — `BI13` (`lineItems[0]`, `lineItems[1]` for both `unitPrice` and `amount`)

They survive because their fixtures give each row a **distinct `metricKey`**, so `metricKey asc`
alone is already a total order for them — not because they count, filter or sort.

**The conclusion is nevertheless correct, and I measured it** rather than reasoning from the same
premise: reverting `:374` to the pre-T-047 `orderBy: { metricKey: "asc" }` and running
`tests/billing.integration.test.ts` three times gave `Tests 36 passed (36)` each time. So the fixture
change is safe; only the stated reason is false.

**Fix** (`integration.fixtures.ts:368-369`):

```
 * No existing caller's expectation moves: every caller that indexes positionally (BI1, BI8,
 * BI13) seeds rows with distinct `metricKey`s, so `metricKey asc` was already total for them.
 * Measured at T-047 Gate 4 -- reverting this to `{ metricKey: "asc" }` leaves
 * `billing.integration.test.ts` at 36/36 over three runs.
```

---

### L-2 · "`tenantIdSchema` is the same `uuidSchema`" is imprecise — LOW

`apps/billing-service/src/validators/invoice-detail.validator.ts:21-23` and the same sentence at
`apps/billing-service/tests/invoice-detail.validator.unit.test.ts:74-75`.

`packages/shared-validation/src/index.ts:19` is `export const uuidSchema = z.string().uuid();` and
`:38` is `export const tenantIdSchema = uuidSchema.transform(` — a derived schema, not the same one.
The cited line numbers are right; the word "same" is not.

The **substance holds**, measured at zod 3.25.76 over 15 forms — `uuidSchema` and
`uuidSchema.transform(...)` agree on every one:

| Accepted | Rejected |
|---|---|
| v4, v1, v7, version nibble `0`, version nibble `8`, variant nibble `c`, variant nibble `f`, nil UUID, uppercase | leading space, trailing space, empty, `abc`, braced, unhyphenated |

That is `BU106`'s list exactly, plus the two extra nibble forms I varied to check the "shape, not
version" claim was not established by probing one dimension. It survives.

**Ruling on the brief's question — pinning rather than tightening is correct.** `uuidSchema` is the
base of `tenantIdSchema` *and* `eventIdSchema`; tightening it would change `X-Tenant-Id` acceptance
for every service in one edit, which is a cross-service contract change and out of scope for a
billing read endpoint. The looseness is also harmless here: the nil UUID reaches the repository and
matches no row, which is the `404` the endpoint already documents. No new gap needed.

**Fix:** "`tenantIdSchema` derives from `uuidSchema` via `.transform`, so it accepts exactly the same
set — measured, 15 forms, identical".

---

### L-3 · Clean-code gate · DRY — the field-name lists reached three copies — LOW

`.claude/rules/constants.md`: "before adding a third copy of a literal, promote it", and it says the
rule applies to tests.

**Five line-item field names — three declarations:**
- `apps/billing-service/tests/integration.constants.ts:375` (`LINE_ITEM_FIELDS`)
- `apps/billing-service/tests/billing-invoice-detail.route.test.ts:46` (`LINE_ITEM_KEYS`)
- `apps/billing-service/tests/invoice.repository.unit.test.ts:908-914` (inline array)

**Nine detail-response keys — three declarations, all new in this diff:**
- `billing-invoice-detail.route.test.ts:35-45` (`RESPONSE_KEYS`)
- `invoice.repository.unit.test.ts:888-897` (inline)
- `billing.integration.test.ts:1594-1604` (inline)

**The counter-argument is partly right and I accept it:** deriving these from
`INVOICE_LINE_ITEM_SELECT` / `INVOICE_HEADER_SELECT` would make the assertion tautological — it would
compare a constant with itself. So **one** independent spelling is correct. Three is not; that is
duplication, and the deliberate-independence argument does not reach past the first copy.

**Fix:** keep the independent literals in `tests/integration.constants.ts` (add a
`DETAIL_RESPONSE_FIELDS` beside the existing `LINE_ITEM_FIELDS`) and import them in the route and
repository unit tests. Note in a comment that they are spelled out deliberately rather than derived
from the production `select`.

---

### L-4 · Clean-code gate · magic string in the fixture sort — LOW

`apps/billing-service/tests/integration.fixtures.ts:374`:

```ts
orderBy: [{ metricKey: "asc" }, { id: "asc" }],
```

`BILLING_INVOICE_DETAIL.SORT_FIELD_METRIC_KEY`, `SORT_FIELD_ID` and `SORT_DIRECTION_ASC` exist
(`apps/billing-service/src/constants.ts:34-39`) and the production path already uses them. The
`{ metricKey: "asc" }` half is pre-existing (T-046, `5cb454a`); the `{ id: "asc" }` half is new in
this diff. **Fix:** use the constants, so a schema rename is a compile error in the fixture too —
which is the whole argument the `BILLING_INVOICE_DETAIL` docblock makes for the production sort.

---

### L-5 · Two citation errors in the plan, which ships in the commit — LOW

`docs/plans/t-047-invoice-detail-endpoint.md:70`:

> "**Four** line-item fields: `id`, `metricKey`, `quantity`, `unitPrice`, `amount` (five, matching
> the epic at `:126-131`)."

- The count word contradicts its own list. It self-corrects in the parenthesis, which is worse than
  either alone — a reader scanning the bold text takes "four".
- The range is wrong. Re-derived: the five fields are `docs/epics/epic-8-billing-service.md:128-132`.
  `:126` is `...InvoiceHeader`, `:127` is `lineItems: Array<{`, and `:131` stops one line before
  `amount`.

`.claude/rules/git-commit.md` puts the plan in the same commit as the code, so this is a shipped
artifact. **Fix:** "Five line-item fields … matching the epic at `:128-132`."

---

### NIT-1 · `BI29` does not compare headers — no oracle exists, recorded because the brief asked

`BI29` (`billing.integration.test.ts:1637`) asserts equal `statusCode`, `toEqual` on the parsed JSON,
and `toBe` on the raw `payload`. It does **not** compare response headers.

Measured with a throwaway probe (since deleted): the unknown-id and foreign-id `404`s return

```
content-type: application/json; charset=utf-8
content-length: 58
connection: keep-alive
```

identical on both, differing only in `date`. No header-level existence oracle today, and
`content-length` is derived from the payload the case already pins byte-for-byte. **No change
required** — recorded so the next reader does not have to re-measure it.

---

## What I verified

### Priority 1 — tenant isolation on a table with no RLS

**The database state, re-derived.** `pg_roles`: `telemetry_app` is `rolsuper = f`,
`rolbypassrls = f`, and the connection actually used reports `current_user = telemetry_app`.
`pg_class`: `"Invoice"` `relrowsecurity = t / relforcerowsecurity = t`; `"InvoiceLineItem"`
`relrowsecurity = f / relforcerowsecurity = t`. `pg_policy`: one policy on `"Invoice"`
(`invoice_tenant_isolation`, `polcmd = *`), **zero** on `"InvoiceLineItem"`. That is S-10 exactly.

**The leak, reproduced as `telemetry_app` under tenant B's context against tenant A's invoice:**

| Probe | Query | Result |
|---|---|---|
| P1a | `invoice.findFirst({ id: A_INV, tenantId: B })` + nested `lineItems` | `null` |
| P1b | `invoice.findFirst({ id: A_INV })` — **predicate removed** | `null` |
| **P1c** | **`invoiceLineItem.findMany({ where: { invoiceId: A_INV } })`** | **`[{"metricKey":"api.request","amount":"10"},{"metricKey":"storage.gb","amount":"20"}]`** |
| P1d | `invoiceLineItem.findMany({ invoiceId: A_INV, invoice: { tenantId: B } })` | `[]` |
| **P1e** | **`invoiceLineItem.count({})` — no filter** | **3 — every tenant's rows** |
| P1f | `invoice.count({})` — no filter, same connection | **1** — only B's, so RLS is live on the parent |

P1e beside P1f is the whole gap in one line: the same unfiltered call is bounded on the parent and
unbounded on the child. The application route is the entire control, as the plan says.

**The repository exposes no method taking a bare `invoiceId` — re-derived, not trusted.**
`grep -cE "^  async" apps/billing-service/src/repositories/invoice.repository.ts` → **7**;
`grep -cE "^  (private )?async"` → **8**. Both numerals in the class docblock
(`invoice.repository.ts:277`, `:284`) are correct. The eight are `tenantExists`, `findByPeriod`,
`sumUnbilledByMetricKey`, `markUsageLinesBilled` (private), `createDraftInvoice`, `absorbLateUsage`,
`listInvoices`, `findDetailById`. Every `invoiceId` in the file is a result-interface field
(`:76` `AbsorbLateUsageResult`, `:234` `DraftInvoiceResult`), a local binding or a comment — never a
parameter. The docblock's claim survives.

**Ruling on the stance — "convention plus `BU109`, not a compiler guarantee" is the right strength
for what shipped, and a genuine guarantee is available and costs about three lines.** Measured:

`apps/billing-service/src/repositories/base.repository.ts:4-7` already declares
`type TransactionClient = Omit<PrismaClient, "$connect" | … | "$extends">`. Adding `| "invoiceLineItem"`
to that `Omit` turns the re-route into a compile error at the exact line:

```
src/repositories/invoice.repository.ts(733,16): error TS2339:
  Property 'invoiceLineItem' does not exist on type 'TransactionClient'.
```

Nothing in `src/` reads `tx.invoiceLineItem` today — the two writers go through Prisma's nested
`create` on `tx.invoice` — so the narrowing costs nothing behaviourally. It does **not** compile
clean unaided: two call sites pass the whole `tx` to `markUsageLinesBilled`, whose parameter is typed
`Prisma.TransactionClient` (`invoice.repository.ts:407`), producing `TS2345` at `:467` and `:626`.
Narrowing that one parameter to the local type clears both. So the complete change is one line in
`base.repository.ts` and one in `invoice.repository.ts` — and it converts "no method takes a bare
`invoiceId`" from a convention into `TS2339`, which is the strength `.claude/rules/review-standards.md`
§ *Universals Must Cite Their Mutation* asks for.

Why it is **not** a required fix here: `base.repository.ts` is one of S-19's five copies
(`md5sum` → `13a533a2e2c2dcc1ff9db28fb5c7a1fd`, the hash S-19 records for the analytics/billing/worker
triple). Editing it inside a billing read-endpoint task is the one-task-per-commit objection S-19
itself raises. See decision **D-A**.

**Comparison with S-45, which the brief asked for.** S-45's `absorbLateUsage` faced the mirror
question on the *write* side and answered it the same way: `BU99` pins the nested `create` route and
the docblock (`invoice.repository.ts:537-539`) records that `tx.invoiceLineItem.create({ data: {
invoiceId: … } })` reddens it — a test, not a type. T-047 is consistent with that precedent, and the
type-level option would close both at once, which is a further argument for doing it as its own task
rather than half of it here.

**The re-route mutation, both variants, re-performed.** The plan's §7 names one; the implementer
constructed a second. Both were run against the shipped suite:

| Variant | `BI30` | What actually happens |
|---|---|---|
| **Naive** (plan's) — second `tx.invoiceLineItem.findMany({ where: { invoiceId: id } })`, spread onto a possibly-null header, no early return | `expected 500 to be 404` | The line-item read *does* find A's rows, but normalising the absent header throws first. **A crash, not a leak.** |
| **Leaking** — same read, answer with what it found when the header is null | `expected 200 to be 404` | **A real leak.** |

The leaking variant's body, captured through `app.inject` as tenant B requesting tenant A's invoice:

```json
{"data":{"id":"0450a5e0-7777-4000-8000-00000000aaa1","periodStart":"","periodEnd":"","totalAmount":"0",
"createdAt":"","finalizedAt":null,"lineItems":[
 {"id":"…","metricKey":"api.request","quantity":"1000","unitPrice":"0.01","amount":"10"},
 {"id":"…","metricKey":"storage.gb","quantity":"5","unitPrice":"0.5","amount":"2.5"}]}}
```

Tenant B receives tenant A's metrics, quantities, unit prices and amounts. That is the exposure this
endpoint is one edit away from, and it is now measured rather than argued.

Full red set under the leaking variant: `BU108`, `BU109`, `BU110`, `BU111`, `BI29`, `BI30` —
`6 failed | 199 passed (205)`. So **`BI30`'s comment describes both variants correctly**, including
its claim that "`BI29` reddens too" and the quoted line-item body. I found nothing to correct in it.

**The predicate is not isolable (S-46) — confirmed, and the diff claims nothing stronger.** Deleting
the tenant predicate (`where: this.where({ id })` → `where: { id }`) and running the whole package:

```
× BU107 - the where is exactly { id, tenantId } with the bound tenant, inside withTenant
  Tests  1 failed | 204 passed (205)
```

Exactly one case, and it is the shape case. Every integration case stays green, because `"Invoice"`
RLS supplies the same `null`. The comments at `invoice.repository.unit.test.ts` (BU107),
`billing.integration.test.ts:1703-1708` (BI30) and S-47 item 3 all say precisely this. Nothing in the
diff claims the predicate is behaviourally isolable.

### Priority 2 — the Prisma mechanism

**The four rows, re-derived** against `@prisma/client` 6.19.3 (`node -e` on the resolved package) with
the query log captured inside `$transaction`, counting statements mentioning `"InvoiceLineItem"`:

| Context | `where` | Result | `InvoiceLineItem` statements |
|---|---|---|---|
| A | `{ id: A_INV, tenantId: A }` | the invoice | **1** |
| B | `{ id: A_INV, tenantId: B }` | `null` | **0** |
| B | `{ id: A_INV }`, predicate removed | `null` | **0** |
| A | `{ id: <unknown uuid>, tenantId: A }` | `null` | **0** |

`1, 0, 0, 0` — as claimed. The emitted statements for the own-tenant read:

```
0 BEGIN
1 SELECT set_config('app.tenant_id', $1, true)
2 SELECT "public"."Invoice"."id" FROM "public"."Invoice" WHERE ("public"."Invoice"."id" = $1 AND "public"."Invoice"."tenantId" = $2) LIMIT $3 OFFSET $4
3 SELECT "public"."InvoiceLineItem"."id", … FROM "public"."InvoiceLineItem" …
4 COMMIT
```

**I varied six dimensions the plan did not**, because a claim established by probes that varied one
dimension is not established. All six agree:

| Probe | `InvoiceLineItem` statements |
|---|---|
| `findFirst` + `include`, ctx = B, A's invoice | 0 |
| `findMany` + nested `select`, ctx = B, A's invoice | 0 |
| `findUnique` + nested `select`, ctx = B, A's invoice | 0 |
| `findMany` + nested `select`, ctx = B, **no `where` at all** | 0 |
| `findFirst` + `include`, ctx = A, own invoice | 1 |
| `findFirst` + nested `select`, ctx = A, unknown id | 0 |

The suppression is not an artefact of `findFirst`, of `select`-vs-`include`, or of a `where` being
present. (The `include` probes also confirm the `select`-not-`include` rationale: `include` returns
`tenantId` on the parent.)

**Ruling on the scoping — it is stated in the right places and at the right strength.** The
version-scope paragraph appears in the `findDetailById` docblock
(`apps/billing-service/src/repositories/invoice.repository.ts:711-718`) with the four-row table
inline, and the limit — "`BU109` catches a **code-level** re-route … it cannot catch a Prisma-level
plan change, because the call surface would not [change]" — appears **twice**: there and in
`BU109`'s own comment (`invoice.repository.unit.test.ts`). That is the right pair of places: the next
person to edit the query and the next person to trust the test. Confirmed: `@prisma/client` is
`6.19.3`; `prisma/schema.prisma` declares **no** `previewFeatures`, so `relationJoins` is off.

One thing I would add, not a blocker: nothing in the repository *mechanically* notices a Prisma bump.
The docblock says "re-measure before the upgrade lands" and depends on a human reading it. Candidate
for `known-gaps.md` — see **Out-of-scope gaps** below.

### Priority 3 — test honesty

**`BU109` is vacuously green against a stub — confirmed.** Replacing `findDetailById`'s body with
`return null` and running the repository unit file:

```
× BU107   × BU108   × BU110   × BU111
  Tests  4 failed | 28 passed (32)
```

`BU109` alone stays green. The implementer said so rather than rounding up, and it is true. Its
redness is established only by the re-route, which I confirmed above (red under the leaking variant).

**`BU120` is vacuously green — confirmed**, and see **M-3** for the refuted "alone".

**`BI29` is a genuine deep-equal, not two status assertions.** `billing.integration.test.ts:1672-1674`
asserts `unknown.json()` `toEqual` `foreign.json()` **and** `unknown.payload` `toBe`
`foreign.payload` — raw bytes, so key order and whitespace are pinned too — **and**
`not.toContain(tenantBInvoiceId)`. Headers: see NIT-1, no oracle.

**The sort discipline held.** `BI31`'s comment writes "red in **3 of 3** runs on this host … Do not
read '3 of 3' as 'always'", citing S-41. I re-ran the tie-break mutation (drop `id`, keep
`metricKey asc`) **five** further times: red 5/5. Eight of eight on this host, and the comment is
still right not to say "always". The sibling claim in the same comment — dropping `metricKey`
"red, and `BI28` red with it" — is also correct: measured `BU110`, `BI28`, `BI31`,
`3 failed | 202 passed (205)`. And "`BU110` … verified red under both" is correct: `BU110` reddens
under the `id`-drop as well. **No sibling claim in that block overreaches.**

**`Decimal` on the wire — both halves verified.**
- The catching assertions sit **below** HTTP: `BI33` (`billing.integration.test.ts:1862`) resolves
  `app.container.invoiceRepositoryFactory(TENANT_A)` and asserts `typeof … === "string"` plus
  `not.toBeInstanceOf(Prisma.Decimal)` on all three line-item Decimals, plus `not.toBeInstanceOf(Date)`
  on two timestamps. `BU111` does the same against the driver-shaped double. `BU119`'s route-level
  `typeof` assertion carries an inline caveat saying it cannot see a leak, pointing at `BI33`.
- The fixture **discriminates**. Measured: `String(new Prisma.Decimal("123456789012.123456"))` is
  `"123456789012.123456"`, while `String(Number("123456789012.123456"))` is `"123456789012.12346"` —
  six digits short. `BI33` asserts the degraded form explicitly and asserts the value is not it.
  The trailing-zero trap is real and avoided: `String(new Prisma.Decimal("10.000000"))` → `"10"`,
  `"1000.000000"` → `"1000"`, `"0.010000"` → `"0.01"`, `"0.500000"` → `"0.5"`. Every
  `EXPECTED_*` constant in `tests/integration.constants.ts` matches what I measured.

**Helpers throw rather than pass vacuously.** `BU107`/`BU108`/`BU110` locate the Prisma call through
`firstArg(mock.invoiceFindFirst, "invoice.findFirst")`, the existing helper that throws when the call
is missing. The mock wires `invoiceLineItem.findMany`/`findUnique`/`count` explicitly so that
`not.toHaveBeenCalled()` is asserted against a real spy rather than `undefined` — and the comment at
`invoice.repository.unit.test.ts:116-121` says exactly why. That is the right shape.

### Priority 4 — the rest

**The fixture change — no existing expectation moved.**
- `InvoiceSpec.id` (`integration.fixtures.ts:292`, `spec.id ?? \`${INTEGRATION_ID_PREFIX}invoice-${n}\``):
  no pre-existing caller passes `id`, so every T-046/S-45 fixture keeps its readable id and its
  sequence number. Verified by the 36/36 green integration file.
- `InvoiceSpec.lineItems`: spread-guarded (`=== undefined || length === 0 ? {} : …`), so callers that
  pass none emit byte-identical `create` args.
- `readLineItems` tie-break: measured, 36/36 over three runs with the tie-break reverted. See **L-1**
  for the false *reason* given.
- Teardown: the new line items are reached by the existing
  `invoice: { tenantId: { in: ids } }` delete. Post-suite counts came back clean (below).

**S-47 — every citation re-derived.** Against `docs/epics/epic-8-billing-service.md`:
`:115` is `**File**: \`controllers/billing.controller.ts\``; `:118` is "Fetch `Invoice` by `id` with
`lineItems` included"; `:119` is "Verify `invoice.tenantId === req.tenantId` — return `404` if not
found or belongs to another tenant (do not leak existence)"; `:122-136` is the response block. All
four line numbers are exact. Item 1's "3 new files and 12 changed" matches
`git status --porcelain` exactly (12 ` M`, 3 `??` under `apps/billing-service`). Item 2's
`BU108` assertion exists (`expect(args).not.toHaveProperty("include")`). Item 3's `BU75b` exists at
`invoice.repository.unit.test.ts:794`, and its RLS measurements match mine. Item 4's "two
`api.request` lines at different unit prices" is what `BI31` seeds and asserts.

**The "new id, not an extension" argument is correct.** S-29, S-32, S-35 and S-42 are each titled and
scoped to a *named section* of `docs/epics/epic-7-worker-service.md` (T-040, T-041, T-043, T-042
respectively — confirmed from the on-disk headings). Extending any of them to a different file would
falsify its own title, which is the objection S-32 records for not folding into S-29. The "five
sibling entries for two epic files" count is right: four in epic-7, this one in epic-8.

**What the epic gets right is recorded**, which is the part that keeps the entry honest: `:119`'s
"do not leak existence" is the correct requirement and the code exceeds it, and the `:122-136` field
list is exactly what shipped. I verified the five field names at `:128-132` against
`INVOICE_LINE_ITEM_SELECT` — identical.

**Constants gate.** No status-code, error-code or route literal in any new `src/` file — grep for
`\b(200|400|401|404|409|422|500)\b` across the five changed/new source files returns nothing outside
comments. The route path derives from one `INVOICES_PATH` and one `PARAM_ID`
(`constants.ts:41`, `:48`), and the validator keys off the same `PARAM_ID`
(`invoice-detail.validator.ts:26`). Sort fields come from `Prisma.InvoiceLineItemScalarFieldEnum` and
`Prisma.SortOrder` (`constants.ts:36-38`) — verified both enums exist and carry the six/two members
claimed. Remaining findings are test-side: **L-3**, **L-4**.

**The TDZ claim in `constants.ts:13-17` is true, and stronger than stated.** Moving
`BILLING_INVOICE_DETAIL` below `BILLING_ROUTES` produces `TS2448` **and** `TS2454` at compile time
and `ReferenceError: Cannot access 'BILLING_INVOICE_DETAIL' before initialization` at module load.
The comment says "a temporal-dead-zone error at module load"; it is also a compile error, so the
ordering is enforced twice over. No change needed.

**Coverage**, `pnpm exec vitest run --coverage`, against thresholds `lines/functions/statements 80`,
`branches 75`:

```
All files          |   98.32 |  92.40 |  100 |  98.32
 src/controllers   |   94.32 |  86.11 |  100 |  94.32
 src/repositories  |   99.33 |  92.42 |  100 |  99.33
 src/routes        |     100 |    100 |  100 |    100
 src/services      |   99.05 |  97.43 |  100 |  99.05
 src/validators    |     100 |    100 |  100 |    100
```

Exactly the figures reported. Per file: `invoice.service.ts` 100/100/100, `invoice.repository.ts`
99.13/95.91/100, `billing.controller.ts` 91.39/82.60/100 with uncovered `110-115, 129-130` — which
is **M-2**.

---

## Compile-time gate — run with `--force`, all 13 packages

`npx turbo run typecheck lint build test --force` → **`Tasks: 52 successful, 52 total`**, exit 0. Run
twice: once before any mutation, once on the restored tree after `md5sum -c` reported 17/17 `OK`.

| Package | typecheck | lint | build | tests |
|---|---|---|---|---|
| `@telemetry/shared-config` | ok | clean | ok | 4 |
| `@telemetry/shared-logger` | ok | clean | ok | 4 |
| `@telemetry/shared-tracing` | ok | clean | ok | 2 |
| `@telemetry/shared-types` | ok | clean | ok | 8 |
| `@telemetry/shared-utils` | ok | clean | ok | 18 |
| `@telemetry/shared-validation` | ok | clean | ok | 15 |
| `@telemetry/gateway` | ok | clean | ok | 38 |
| `@telemetry/auth-service` | ok | **10 warnings (pre-existing)** | ok | 166 |
| `@telemetry/usage-service` | ok | **4 warnings (pre-existing)** | ok | 230 |
| `@telemetry/billing-service` | ok | clean | ok | **205** |
| `@telemetry/worker-service` | ok | clean | ok | 234 |
| `@telemetry/analytics-service` | ok | clean | ok | 18 |
| `@telemetry/web` | ok | clean | ok | **0 (reports none)** |

**Root total, derived rather than copied:** 4+4+2+8+18+15+38+166+230+205+234+18 = **942**. Twelve
packages report; `@telemetry/web` contributes none. Billing **205** (181 + 24 = `BU103`–`BU120` (18)
+ `BI28`–`BI33` (6)). Both figures match the brief.

**14 lint warnings, 0 errors, and zero `no-unsafe-return` — pre-existence proved, not assumed:**

| Count | Rule | File | `git log -1 <file>` |
|---|---|---|---|
| 10 | `@typescript-eslint/no-misused-promises` | `apps/auth-service/tests/auth.service.unit.test.ts` | `1b872b3` (Sep 4) |
| 4 | `@typescript-eslint/no-unsafe-assignment` | `apps/usage-service/tests/ingestion.service.unit.test.ts` | `3588bf1` (Sep 9) |

Neither file appears in `git status --porcelain`, so neither is touched by this change. **Note a
discrepancy with the brief**, which attributed these to `d68e719` and `b0f6921`: on this tree
`git log -1` for the two warning-carrying files returns `1b872b3` and `3588bf1`. The conclusion —
pre-existing, not this change's — is unaffected and is established by the file list, not by which
commit last touched them.

`pnpm test:smoke`: **6/6 services green**, 7 tests (gateway carries 2, the other five 1 each), exit 0.

`pnpm format:check` deliberately not run — S-12, it cannot pass on any revision and no CI step
invokes it.

---

## Environment hygiene

- **Postgres and Redis left running.** Neither stopped.
- **Row counts before and after everything:** `Tenant 2 | Invoice 0 | InvoiceLineItem 0 | UsageLine 0
  | Event 0 | Meter 0`. The two `Tenant` rows are the S-20 residue (both named `Acme Inc`, uuids
  `d4101ff1-…` and `456793cd-…`) and were left alone. **No orphan appeared.**
- **All probe fixtures were seeded through `DIRECT_DATABASE_URL`** (owner) and read through
  `DATABASE_URL` (`telemetry_app`), deleted by explicit id, counts re-checked after each script.
- **`v1_7` not rolled back, no role dropped.** `_prisma_migrations` head is
  `v1_7_worker_billing_enumerator`; all five `telemetry_*` roles present.
- **Redis db 0 was not written by me**, but it *was* written by the mandated gate: `DBSIZE` went
  2 → 3, and the `denylist:*` keys rotated between observations (`b103bfa5…` → `fb701a14…`, with
  `80038e92…` persisting alongside `telemetry:events`). That is **S-22** — auth-service's integration
  suite hard-codes `redis://localhost:6379` with no logical database, so its TTL'd denylist keys land
  in db 0 beside the production event stream. Reported, not rounded to green, and not a defect in
  this change.
- **Tree restored byte-identical.** `md5sum -c` over all 17 changed/new files: 17 `OK`. `git status
  --porcelain` unchanged (12 ` M`, 5 `??`). `git diff --stat` still
  `13 files changed, 1289 insertions(+), 29 deletions(-)`. One throwaway probe test file and one
  header probe were created under `apps/billing-service/tests/` and deleted; both are gone.
  `src/routes/billing.routes.ts` was clobbered by a `git checkout --` during one revert and
  reconstructed from the captured diff — checksum re-verified as `4fad4489c57e1457d2e623b4fceced77`,
  matching the baseline.

---

## What I could not verify, and why

- **That the Prisma suppression holds under a future major bump or with `relationJoins` enabled.**
  The preview feature is not in `prisma/schema.prisma` and enabling it would regenerate the client
  workspace-wide — outside a read-only review. The docblock is correct to scope the claim to 6.19.3
  and to name the four-row re-verification; that scoping is the mitigation, and it is not a substitute
  for a mechanical check (see the out-of-scope gap below).
- **Behaviour at realistic volume.** `InvoiceLineItem` has one index (`InvoiceLineItem_pkey`) and no
  index on `invoiceId`; every measurement here was at 0–3 rows, where a `Seq Scan` is correct and
  says nothing. The plan's R3 records this honestly and declines to add an index without a
  measurement. I agree and did not attempt one — seeding realistic volume would leave residue this
  review is required not to leave.
- **Concurrency.** Nothing here writes, so there is no race to test; I did not attempt one.
- **That `BI32`'s expectation "goes red when S-10 is closed".** That is a forward claim about a
  migration that does not exist. Reasoning only, and it is plausible: closing S-10 makes the
  line-item count under tenant B's context 0 rather than 2.
- **Timing side-channels on the `404`.** Unknown-id and foreign-id both take the same single
  tenant-filtered read, so no difference is expected, but I did not measure latency distributions.

---

## Out-of-scope gaps — recommend recording in `.claude/rules/known-gaps.md`

Neither should be fixed inside T-047.

1. **Nothing mechanically notices a Prisma upgrade that would invalidate the
   `InvoiceLineItem` suppression.** The safety of the platform's only read of an RLS-less table rests
   on a client behaviour recorded in one docblock, with a human instructed to re-measure "before such
   an upgrade lands". `BU109` cannot see it — correctly stated in the diff. A candidate mechanism: a
   test that pins `@prisma/client`'s version and the four statement counts together, so bumping the
   dependency without re-measuring is red rather than silent. This is the same family as S-33's
   "make the number checkable".
2. **`TransactionClient` could make the bare-`invoiceId` read unrepresentable, and does not.**
   Measured above: one line in `base.repository.ts` plus one in `invoice.repository.ts:407` converts
   the convention into `TS2339`. It belongs with S-19 (five copies of `base.repository.ts`) rather
   than in a read-endpoint commit. Worth recording so it is not rediscovered at the next task that
   touches this table.

---

## Remaining risks and dispositions

| # | Risk | Disposition |
|---|---|---|
| R1 | A later method takes a bare `invoiceId` and leaks cross-tenant line items (P1c/P1e are live). | **Accepted, with a named upgrade path.** `BU109` catches the code-level re-route — verified red. The type-level close is measured and costs ~2 lines; see D-A. |
| R2 | A Prisma major bump or `relationJoins` changes the emitted plan. | **Accepted.** Scoped in the docblock and in `BU109`'s comment, with the exact four-row re-verification. Recommend the mechanical check above. |
| R3 | No index on `InvoiceLineItem.invoiceId`. | **Accepted.** Measured at 0 rows, which proves nothing; the plan says so. Settle with `EXPLAIN (ANALYZE)` at volume before adding one. |
| R4 | S-10 stays open — `InvoiceLineItem` RLS inert. | **Accepted, deliberately.** `BI9` and now `BI32` are the standing markers; closing S-10 turns both red on purpose. Out of scope for a read endpoint, per S-10's own fix direction. |
| R5 | `BU120` adds no discriminating power over `BU83`. | **Accept and keep** — cheap, and it fails loudly if the scope ever changes. Do not cite it as evidence specific to the detail route. |
| R6 | The `500` and `!tenantId` paths of `getInvoice` are untested. | **Not accepted — M-2.** |
| R7 | S-37 (`Tenant.deletedAt`): a soft-deleted tenant's invoice is readable through this endpoint. | **Accepted.** Nothing writes the column; inventing a policy inside a read endpoint is the silent resolution `CLAUDE.md` forbids. S-37 already records it. |
| R8 | S-22: the mandated gate writes TTL'd keys to Redis db 0. | **Reported, not fixed.** Pre-existing, auth-service's harness, out of scope. |

---

## Decisions for the user

### D-A · Should the bare-`invoiceId` read be made a compile error, and where?

Today it is prevented by convention plus `BU109`. I measured that omitting `"invoiceLineItem"` from
`TransactionClient` makes the re-route `TS2339` — a two-line change, no behaviour change.

| Option | What changes |
|---|---|
| **A · Ship T-047 as is; record the narrowing as a new `known-gaps` entry and fold it into the S-19 shared-`base.repository.ts` task.** | **No diff change.** One new entry in `.claude/rules/known-gaps.md`. |
| B · Narrow billing's `TransactionClient` inside T-047. | **Changes the diff**: `base.repository.ts:4-7` (+ `"invoiceLineItem"` to the `Omit`) and `invoice.repository.ts:407` (`markUsageLinesBilled`'s `tx` parameter). Adds a 14th changed file and edits one of S-19's five copies from a read-endpoint task. |
| C · Leave it as convention and record nothing. | **No diff change**, and the option evaporates. |

**Recommendation: A.** The property is genuinely worth making mechanical — this is the one table the
database does not protect — but `base.repository.ts` is S-19's shared surface, and the whole point of
S-19 is that changing one copy and not the other four is how these things go wrong. Recording it
costs nothing and keeps the measurement.

### D-B · Does `S-47` land in this commit?

The plan explicitly leaves this to the reviewer (`docs/plans/t-047-invoice-detail-endpoint.md:421`).
I re-derived all four of its citations and they are exact.

| Option | What changes |
|---|---|
| **A · Land S-47 in T-047's commit.** | **No diff change** — it is already written. Matches S-29/S-32/S-35/S-42, each of which landed inside its own task's commit. |
| B · Split it into a separate docs commit. | Two commits for one task, against `.claude/rules/git-commit.md`'s one-atomic-commit rule. |
| C · Drop it and correct the epic instead. | **Changes the diff**: revert the `known-gaps.md` hunk, edit `docs/epics/epic-8-billing-service.md:115/:118/:119/:122-136`. Turns a docs task into part of a feature commit — the thing S-15 and the four sibling entries exist to avoid. |

**Recommendation: A.** Precedent, no diff change, and the entry is accurate.

---

## Required fixes for a CONDITIONAL clear

1. **M-1** — `apps/billing-service/tests/billing-invoice-detail.route.test.ts:100-102`: replace "makes
   this a 200 carrying an invoice" with the measured outcome (400, four cases red, and why).
2. **M-2** — `apps/billing-service/tests/billing.controller.unit.test.ts`: add `BU121`/`BU122` for
   `getInvoice`'s `!tenantId` → 400 and non-`AppError` → 500 paths, mirroring `BU89`/`BU91`. Confirm
   each red before implementing, and quote the output.
3. **L-1** — `apps/billing-service/tests/integration.fixtures.ts:368-369`: replace the false universal
   with the measured statement (BI1/BI8/BI13 index positionally; their fixtures have distinct
   `metricKey`s; reverting the tie-break leaves 36/36 over three runs).
4. **L-2** — `apps/billing-service/src/validators/invoice-detail.validator.ts:21-23` and
   `tests/invoice-detail.validator.unit.test.ts:74-75`: "derives from `uuidSchema` via `.transform`,
   accepting exactly the same set".

**Recommended, not blocking:** L-3 (promote the two field-name lists to one copy each), L-4 (use the
sort constants in the fixture), L-5 (fix the plan's "Four"/`:126-131`).

**Also:** M-3 requires no diff change, but the "reddens `BU120` alone" phrasing must not appear in the
commit message.

Re-run the billing package and the full `--force` gate after the fixes; none of them should move a
test count, so `205` / `942` should hold.

---

## Round 2

**Gate 6 (final, post-QA).** Base `21497bd`, T-047 uncommitted. Read-only: every mutation below was
reverted and all 20 changed/new files re-checksummed byte-identical (`md5sum -c`, **20/20 `OK`,
0 mismatches**), with `git status --porcelain` and `git diff --stat` back to their starting values
(`14 M`, `6 ??`; `14 files changed, 1543 insertions(+), 31 deletions(-)`).

**Rules revision read from disk, not from the injected copy.** `.claude/rules/known-gaps.md`:
**2886 lines**, `md5sum b8dbb84d9e18b97b3c15d0c5d0ffbc5e`, headings **S-5 … S-48**, `git log -1`
→ `21497bd` with the working-tree hunk on top (`git diff --stat` → `144 insertions`). The copy
injected into *this* session ended at **S-39** — it could not see S-40 through S-46, nor the S-47
and S-48 this diff adds. That is the **eleventh sighting of S-24** and the tenth consecutive stale
one. Every gap cited below was re-read from the file on disk.

---

## Verdict

**CONDITIONAL.**

No BLOCKER and no HIGH. Round 1's two required corrections were both applied and both re-derive
exactly; the isolation stance is right and I reproduced the leak it guards against independently.
One MEDIUM must be fixed before commit — a false citation added by this diff in a production
docblock beside the route-scoping security contract, which the diff's **own** test comment
explicitly forbids.

**Required before commit:** M-4 (one clause, comment-only).
**Recommended, not blocking:** L-6, L-7.
**Recorded, no action:** NIT-2.

M-4 changes no code, no test and no count. Billing stays at **207** and root at **944** after it.

---

## Findings

### M-4 · The route docblock cites `BU120` as the detail-route scope guard; `BU120` passes under exactly that mutation — and the diff's own comment forbids the citation — MEDIUM

`apps/billing-service/src/routes/billing.routes.ts:12-13`, **added by this diff**:

```
 * `billing-invoices.route.test.ts` BU78 is what notices if it moves -- and, for the detail
 * route T-047 added, `billing-invoice-detail.route.test.ts` BU115 and BU120.
```

**Measured, by performing exactly the move the sentence describes** — `scope.get(BILLING_ROUTES
.INVOICE_DETAIL, …)` deleted from `registerBillingRoutes` and re-registered as `app.get(...)` on
the root instance — and running the detail route file with `--reporter=verbose`:

```
× BU115   × BU116   × BU117   ✓ BU118   × BU119   ✓ BU120
  Tests  4 failed | 2 passed (6)
```

`BU120` is one of the **two cases that stay green**. At package scope the same mutation gives
`Tests 9 failed | 198 passed (207)` across 2 files — `BU115`, `BU116`, `BU117`, `BU119`, `BI28`,
`BI29`, `BI30`, `BI31`, `BI33` — and `BU120` is not in the red set.

The contradiction is inside this diff. `apps/billing-service/tests/billing-invoice-detail.route.test.ts:207-208`,
also added by this diff, says:

```
    // should still assert it after the other suite is split, renamed or retired. Do not cite it
    // as a guard specific to `GET /v1/billing/invoices/:id` -- BU115 is that guard.
```

So the production docblock cites precisely what the test comment forbids, and the reason the test
comment gives is the reason my measurement confirms: `BU120` observes the **hook topology of one
app** (it reddens only under the hooks-to-root mutation, in a 26-case set), not the detail route's
registration site.

This is the M-1 class — a false claim next to the assertion a future reader uses to decide whether
a guard still earns its place — recurring in a production file after being corrected in a test file.
MEDIUM per `.claude/rules/review-standards.md` § *Claims the Change Makes*: a false claim beside
security-relevant code, and this docblock *is* the statement of the route-scoping security contract.

**Fix** (`apps/billing-service/src/routes/billing.routes.ts:12-13`) — drop `BU120` and state the
measurement:

```
 * `billing-invoices.route.test.ts` BU78 is what notices if it moves -- and, for the detail
 * route T-047 added, `billing-invoice-detail.route.test.ts` BU115. Measured at Gate 6 by
 * re-registering the detail route with `app.get(...)` on the root instance: BU115, BU116,
 * BU117 and BU119 redden (`4 failed | 2 passed (6)` in that file; `9 failed | 198 passed (207)`
 * package-wide, with BI28-BI31 and BI33). `BU120` stays **green** under that mutation -- it
 * observes one app's hook topology, not this route's registration site, and its own comment
 * says not to cite it here.
```

---

### L-6 · "an unauthenticated, untenanted read of every invoice on the network" is the overclaim M-1 corrected, surviving in the docblock this diff edits — LOW

`apps/billing-service/src/routes/billing.routes.ts:9-10`:

> "Registering these on the root instead would put an unauthenticated, untenanted read of every
> invoice on the network"

**Pre-existence proved, so this is not counted against the change.** `git show HEAD:apps/billing-service/src/routes/billing.routes.ts`
carries the sentence verbatim; `git diff` on the file shows the only docblock edit is the `BU78 …
BU115 and BU120` clause (M-4). The sentence is T-046's.

**It is nevertheless false in the same direction M-1 corrected, and I measured it on both routes'
behalf.** Under the root-registration mutation the detail route answers **400**
`{"code":"VALIDATION_ERROR","message":"Missing tenantId from context"}` — no invoice, no read —
because `apps/billing-service/src/controllers/billing.controller.ts:108-115`'s `if (!tenantId)`
guard fires before the service. The failure modes are `expected 400 to be 401` ×2 and
`expected 400 to be 200`, which is the exposure being "unauthenticated *reachability*", not "an
invoice on the wire".

Raised as LOW rather than waved through because the diff already edits lines 12-13 of this same
docblock, so correcting `:10` in the same breath costs one sentence and leaves the file's account
of its own security contract consistent with the corrected comment at
`billing-invoice-detail.route.test.ts:94-109`. If it is not corrected here it should be carried,
since it is the last uncorrected copy of a claim this task fixed twice.

**Fix** (`billing.routes.ts:9-10`): "Registering these on the root instead would put these reads on
the network without the internal-auth guard and without tenant context. The controller's own
`!tenantId` guard then answers `400` rather than serving an invoice — measured — so the exposure is
unauthenticated reachability, not a body on the wire."

---

### L-7 · `getInvoice`'s non-`Error` catch arm is an untested error path — LOW

`apps/billing-service/src/controllers/billing.controller.ts:131` — the `: String(error)` arm of
`error instanceof Error ? error.message : String(error)` — is the one uncovered branch this diff
adds. Coverage, re-run at Gate 6 (`pnpm --filter @telemetry/billing-service exec vitest run --coverage`):

```
 src/controllers        |   100 | 91.89 | 100 |   100 |
  billing.controller.ts |   100 | 91.66 | 100 |   100 | 67,131
```

**The rework's description of these two is accurate and I proved it.** `:67` is the identical arm
inside `listInvoices`: at `HEAD` that ternary sits at `:66` and `getInvoice` does not exist at all
(`git show HEAD:… | grep -c "getInvoice"` → 0), so `:67` is T-046's, pre-existing, and `:131` is
its twin introduced here. Branch coverage 91.66 against a threshold of 75, so no gate catches it.

`.claude/rules/review-standards.md` § *Final Review Checklist* asks for all error paths tested.
Disposition: **accept, not blocking.** It is a one-line addition
(`getInvoice.mockRejectedValueOnce("boom")` asserting the log carries `"boom"` and the body still
deep-equals `{ code, message }`), but covering the new twin while leaving T-046's identical arm
uncovered adds an asymmetry for no security gain. Recommend both be covered in one later change,
alongside the `BU91`/`BU122` pair.

---

### NIT-2 · S-48 under-claims: the `733 → 740` cause is measurable by reconstruction, and I measured it

`.claude/rules/known-gaps.md` S-48 says the drift's cause — `findDetailById`'s docblock growing by
seven lines at the Gate-4 rework — is "**inference, not measurement** — the intermediate revision
was never committed, so there is nothing to diff against."

The uncommitted revision is not the only route. Deleting exactly the seven-line S-48 pointer
paragraph from that docblock (`apps/billing-service/src/repositories/invoice.repository.ts:723-729`,
the `BU109 is also the *only* thing catching the re-route …` block plus its trailing blank comment
line) and re-applying steps A and B reproduces the Round-1 figure exactly:

```
invoice.repository.ts(467,41): error TS2345
invoice.repository.ts(626,39): error TS2345
invoice.repository.ts(733,16): error TS2339
```

`733`, with `:467` and `:626` unchanged — so the seven lines are that paragraph, established by
reconstruction rather than by diffing an absent revision.

**No change required, and the entry is not wrong.** Understating is the safe direction, and S-48's
load-bearing instruction ("cite by method and symbol, not `file(line,col)`") is unaffected. Recorded
because the entry invites the upgrade, and because the measurement is now on record if anyone wants
to make it.

---

## Priority 1 — the two Round-1 corrections, and the isolation stance

### Round 1's own arithmetic, re-derived

Both of Round 1's self-referential claims were wrong, and both corrections hold.

| Round 1 said | Measured at Gate 6 | Correct |
|---|---|---|
| M-1's scope mutation reddens **4** cases (one file run) | `4 failed \| 2 passed (6)` in that file; **`9 failed \| 198 passed (207)` across 2 files** package-wide | the rework and QA — **9 across 2** |
| "none of them should move a test count, so **205 / 942** should hold" | billing **207**, root **944** | the rework — its own M-2 required two new cases |

Round 1's M-1 figure was not false, it was **file-scoped and reported as if general** — the same
one-dimension failure `.claude/rules/review-standards.md` § *Universals Must Cite Their Mutation*
catalogues. The corrected comment at `billing-invoice-detail.route.test.ts:94-109` now states the
file scope explicitly (`running this file: Tests 4 failed | 2 passed (6)`) and quotes the four
failure modes; I reproduced all four verbatim — `expected 400 to be 401` ×2, `expected 400 to be 200`,
`TypeError: Cannot convert undefined or null to object` — and the `400` body it quotes.

### The isolation stance — ruled correct, and re-derived rather than trusted

**The database does not stop the read.** `pg_class` / `pg_policy`, re-queried:

```
Invoice          | relrowsecurity t | relforce t | policies 1
InvoiceLineItem  | relrowsecurity f | relforce t | policies 0      <- S-10
Tenant t/t/4 · UsageLine t/t/2 · Meter t/t/1
```

`pg_roles`: `telemetry_app` is `rolsuper = f`, `rolbypassrls = f`, and the connection I probed
through reported `current_user = telemetry_app` **on that same connection** — so the results below
are RLS as production sees it, not a superuser's.

**The leak, reproduced independently** (two tenants seeded through `DIRECT_DATABASE_URL`, read as
`telemetry_app` inside a transaction with `set_config('app.tenant_id', <B>, true)` — what `withTenant`
issues — asking about tenant A's invoice):

| Probe | Query | Result |
|---|---|---|
| P1a | `invoice.findFirst({ id: A_INV, tenantId: B })` | `null` |
| P1b | `invoice.findFirst({ id: A_INV })` — **predicate removed** | `null` |
| **P1c** | **`invoiceLineItem.findMany({ where: { invoiceId: A_INV } })`** | **`[{"metricKey":"api.request","amount":"10","invoiceId":"a1a1a1a1-…"},{"metricKey":"storage.gb","amount":"20","invoiceId":"a1a1a1a1-…"}]`** |
| **P1e** | **`invoiceLineItem.count({})` — no filter** | **3 — every tenant's rows** |
| P1f | `invoice.count({})` — no filter, same connection | **1** — only B's |
| P1d | `invoiceLineItem.findMany({ invoiceId: A_INV, invoice: { tenantId: B } })` | `[]` |

P1e beside P1f is the gap in one line: the same unfiltered call is bounded on the parent and
unbounded on the child. **The application route is the entire tenant control on `InvoiceLineItem`.**
P1a ≡ P1b is S-46 — deleting the `Invoice` predicate is behaviourally invisible, which is why
`BU107` is the shape case that stands in for it, and why it must not be deleted.

**The repository still exposes no method taking a bare `invoiceId` — re-derived.**
`grep -cE "^  async"` → **7**; `grep -cE "^  (private )?async"` → **8**. Both numerals in the class
docblock (`invoice.repository.ts:276-286`) are still correct. The eight are `tenantExists` (`:316`),
`findByPeriod` (`:332`), `sumUnbilledByMetricKey` (`:356`), `markUsageLinesBilled` (`:406`, private),
`createDraftInvoice` (`:442`), `absorbLateUsage` (`:584`), `listInvoices` (`:648`), `findDetailById`
(`:738`). Every `invoiceId` in the file is a result-interface field (`:76`, `:234`), a local binding
or a comment — never a parameter.

**Three attack vectors QA's twenty did not cover.** I chose the ones I judged most likely to have
been missed rather than repeating the list, and drove a **real** `buildBillingServiceApp()` against
live PostgreSQL as `telemetry_app` through `app.inject`:

| # | Vector | Result |
|---|---|---|
| V1 | **`HEAD` on the detail route** — Fastify auto-exposes it (`exposeHeadRoutes` default) | own `200 content-length 501`; **foreign `404 / 58` and unknown `404 / 58` identical**; unauthenticated `HEAD` → `401`. The auto-route is inside the guarded scope and is **not** an existence oracle |
| V2 | **duplicated `x-internal-secret`** — billing's `Array.isArray(provided) ? provided[0] : provided` arm (S-8 item 4) | `[good, evil]` → **401**, `[evil, good]` → **401**. The first-value arm yields no bypass on this route |
| V3 | **whitespace-padded `x-tenant-id`** — trailing space, leading space, trailing tab, and a padded **owning** tenant id | all **401 `TENANT_CONTEXT_INVALID`**; the padded owner leaks nothing (`leaks=false`). Fails closed |

Plus the control pair: foreign `404` and unknown `404` are **byte-identical in payload and
header-identical minus `date`**.

**The 404 is not an existence oracle — the statement-count half re-derived.** Query log captured
inside the transaction, counting statements naming `"InvoiceLineItem"`:

| Case | Result | Total statements | `InvoiceLineItem` |
|---|---|---|---|
| A asks for A's invoice | the invoice | **5** | **1** |
| B asks for A's invoice | `null` | **4** | **0** |
| A asks for an unknown uuid | `null` | **4** | **0** |
| B, predicate removed | `null` | **4** | **0** |

Foreign and unknown issue the *same four statements* and skip the line-item read entirely. QA's
figures re-derive exactly, and the work — not just the bytes — is identical.

**Container registration is a factory, not a singleton** (`src/config/container.ts:60`,
`(tenantId) => …`), as `.claude/rules/tenant-isolation.md` requires. The tenant reaches the
repository only as its constructor argument, from `request.tenantId`; `params.id` is the invoice
predicate and never the tenant.

---

## Priority 2 — the rework's claims, which no gate had read

### F-2's citation-form change — ruled correct

**The `TS2339` position genuinely is the mutation's own inserted line, and I demonstrated it rather
than inferring it.** I inserted the step-A re-route as line **740** (after `findDetailById`'s
`withTenant` at `:739`) and `tsc` reported `invoice.repository.ts(740,16): error TS2339`. Same line.
A citation of that position in an authoritative file would point at whatever happens to occupy it,
which is why citing by **error code, property, type and method** is the right form.

**The three kept as `line:col` all point at shipped code, and all three re-derive:**

| Citation | Re-derived | Points at |
|---|---|---|
| `TS2345` at `:467` | ✓ | `await this.markUsageLinesBilled(tx, input.usageLineIds);` |
| `TS2345` at `:626` | ✓ | same call, in `absorbLateUsage` |
| step C's `:407` | ✓ (`grep -n`) | `tx: Prisma.TransactionClient,` — the parameter narrowed |

So the split is right: shipped addresses keep `line:col`, the mutation's own address does not.
The `733 → 740` demotion to a worked example is also right — and see **NIT-2** on the attribution.

### S-48 steps A–E, all five re-derived

`pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json` after each edit:

| Step | Result |
|---|---|
| A · `tx.invoiceLineItem.findMany({ where: { invoiceId: id } })` at the top of `findDetailById`'s callback | **compiles clean** — the convention is not mechanical today |
| B · A + `\| "invoiceLineItem"` in `TransactionClient`'s `Omit` | `TS2339` at `(740,16)` **plus** `TS2345` at `:467` and `:626` |
| C · B + `markUsageLinesBilled`'s parameter narrowed | both `TS2345` clear; **only** the intended `TS2339` remains |
| D · the two narrowings alone | **typecheck clean, `Tests 207 passed (207)`** — the fix is verified non-breaking |
| **E** · both narrowings + `this.prisma.invoiceLineItem.findMany(…)` in the same method | **compiles clean, zero diagnostics** |

**Step E is the load-bearing one and it holds.** `TenantScopedRepository` holds a full
`PrismaClient`, so the narrowing binds `tx` and nothing else — and that route is strictly worse,
because it runs outside the transaction with no `set_config('app.tenant_id', …)` issued at all,
against a table my P1c shows has no policy to fall back on. S-48 is therefore correct to claim only
"a `tx` re-route becomes `TS2339`" and to forbid "unrepresentable". This is exactly the strength
`.claude/rules/review-standards.md` § *Universals Must Cite Their Mutation* asks for, and the entry
states the limit itself.

The S-19 cross-reference (`known-gaps.md:598-602`) is present and accurate. The design note — a
shared `@telemetry/shared-db` base cannot hard-code a per-service model name — is correctly labelled
"reasoning rather than measurement".

### F-1 and F-3, and the §12 audit spot-checked rather than the single row

**F-1.** `git status --porcelain apps/billing-service | grep -c '^??'` → **3**;
`… | grep -c '^ M'` → **13**. S-47 item 1 now reads 3/13. Correct.

**F-3 and the audit.** I re-ran three rows of §12 rather than the one QA corrected, at **package**
scope each time:

| Row | Claimed | Measured at Gate 6 |
|---|---|---|
| **M-1** (corrected) | `9 failed \| 198 passed (207)`, 2 files | **exact**, and the nine are `BU115`, `BU116`, `BU117`, `BU119`, `BI28`–`BI31`, `BI33` |
| **M-3** | `26 failed \| 181 passed (207)`, 6 files | **exact** — `Test Files 6 failed \| 13 passed (19)`; red set `BU65`–`BU69`, `BU83`, `BU120`, `BI1`, `BI1b`, `BI2`, `BI3`, `BI3b`, `BI4`, `BI5`, `BI7`–`BI13`, `BI22`–`BI27` |
| **M-2**, `!tenantId` row | `1 failed \| 206 passed (207)`, `BU121` alone | **exact** |

Three of three. `:454` was indeed the only stale total — the class F-3 identifies does not recur
elsewhere in the table.

**L-2's 15 forms re-measured against the real schemas** (zod 3.25.76, built
`@telemetry/shared-validation`): `forms=15 accepted=9 rejected=6 disagreements=0`, with an identical
parsed value on every accept. `packages/shared-validation/src/index.ts:19` is
`export const uuidSchema = z.string().uuid();` and `:38` is `export const tenantIdSchema = uuidSchema.transform(`
— so "derives from, accepts exactly the same set" is exact, and the L-2 correction is right in both
places it landed.

**L-5 re-derived.** `docs/epics/epic-8-billing-service.md:128-132` is exactly `id`, `metricKey`,
`quantity`, `unitPrice`, `amount`. `:126` is `...InvoiceHeader` and `:127` is `lineItems: Array<{`,
so Round 1's objection to `:126-131` was right and the plan's `:70` now reads "Five … `:128-132`".

**L-3 and L-4 landed.** One declaration each of the five line-item field names
(`tests/integration.constants.ts:389`) and the nine detail-response keys (`:397`), imported by the
route (`:39-40`), repository-unit (`:892`, `:905`) and integration (`:1594`, `:1604`) suites — three
copies each reduced to one. `integration.fixtures.ts:396-399` now uses
`BILLING_INVOICE_DETAIL.SORT_FIELD_*` / `SORT_DIRECTION_ASC`.

### O-1's disposition — ruled **correct**, against the precedents the brief names

The brief is right that S-28 and S-21 were both *filed*, so the question is real. I rule the
docblock the better home here, on a distinction both precedents support rather than contradict:

- **S-28** is filed because the hazard is a *schema* property — `UsageLine.eventId` is globally
  `@unique` — that a future migration can silently remove, at which point the dormant gap becomes
  live. Its audience is whoever changes the schema, who will never read `event.repository.ts`.
- **S-21** is filed because the hazard spans *two* guards in *two* files, and the entry's whole
  content is that removing either alone ships green. No single docblock is where that reader is.
- **O-1** is neither. The unfalsifiable thing is one `orderBy` array in one method, and the only way
  to trip it is to edit that method. The docblock at `integration.fixtures.ts:379-381` is literally
  where the deleter's cursor is.

The sentence shipped says the right thing and scopes it: "**no case goes red when the `id` tie-break
is removed**, so it is unfalsifiable today and must not be deleted on the evidence that deleting it
is green — the S-28 hazard". It names the precedent, which is what keeps the decision auditable
without spending an id.

**The attribution is accurate.** The docblock reads "(T-047 Gate 3 rework; the Gate 4 reviewer
measured the same three runs independently; Gate 5's QA measured them a third time)". Checked
against all three artifacts: the plan §12 L-1 row (`36 passed (36)` × 3), Round 1's L-1 (three runs,
`Tests 36 passed (36)` each), and the QA report's fixture row (`3 of 3 runs`). **Three gates, three
measurements, and it does not claim a fourth.** I did not re-run it and the docblock does not say I
did — which is the point of checking.

### O-2 and O-3 — both "predates this diff" claims verified

**O-2.** `git diff apps/billing-service/src/repositories/invoice.repository.ts` filtered to the
`toAmountString` docblock returns **no `+`/`-` line** — the only additions naming the helper are new
*call sites*. `git show HEAD:…` carries the full "**Not fixed-scale, and deliberately so**"
paragraph, including `String(new Prisma.Decimal("10.500000"))` → `"10.5"`, and it already says
"T-047 inherits this helper". So the trailing-zero contract is T-046's convention, recorded in
production code before this diff. Disposition correct.

**O-3.** `invoice-detail.validator.unit.test.ts` BU106's comment states all three things the plan
claims: that these forms "reach the repository and simply match no row -- a `404`, not a `400`";
that `tenantIdSchema` "has accepted exactly these forms since before this task"; and "Do not 'fix'
it here -- tightening the shared schema changes every service's tenant header in one edit." My V3
probe corroborates the fail-closed direction from the other side. Disposition correct; a gap id
would add nothing.

---

## Priority 3 — pre-QA checks repeated on the tested revision

### `BU121` / `BU122`

Both green on first run because the branches already shipped — stated honestly in both comments.
Redness re-established here:

- **`BU121`**: removing `getInvoice`'s `!tenantId` block → `Tests 1 failed | 206 passed (207)`,
  **`BU121` alone**.
- **`BU122`, the leak-specific mutation, re-performed as the brief requires.** Adding
  `detail: error instanceof Error ? error.message : String(error)` to `getInvoice`'s 500 body and
  running the controller unit file:

```
× BillingController.getInvoice > BU122 - answers 500 for an unexpected failure, logging it and leaking nothing
  → expected { code: 'INTERNAL_ERROR', …(2) } to deeply equal { code: 'INTERNAL_ERROR', …(1) }
  Tests  1 failed | 5 passed (6)
```

Byte-for-byte the output `BU122`'s comment quotes. The deep-equal is what catches it — a status
assertion would not — and the case also asserts the error string **is** in the log
(`JSON.stringify(logger.error.mock.calls[0])`) and **is not** in `JSON.stringify(sentBody(reply))`.
Both halves are real: `BU122` is not asserting a mock's own return value, and `BU121`'s
`expect(getInvoice).not.toHaveBeenCalled()` is asserted against a real `vi.fn()`.

`BU122` doubles as `BU121`'s control on the same params fixture, so `BU121`'s 400 is provably the
tenant guard and not a rejected param. That is the right shape.

**The two remaining uncovered branches** (`:67`, `:131`) are correctly described as pre-existing and
its twin — proved above under **L-7**, which is the only thing I would add.

### `BU120` — does it earn its place?

**Yes, kept — but its citation elsewhere does not (M-4).** The case costs two `app.inject` calls,
its comment records the real 26-case red set, corrects the earlier "BU120 alone" claim, states that
no mutation separates it from `BU83`, and explicitly forbids citing it as detail-route evidence.
That is an honest co-regression and each route suite should carry the property independently. The
defect is not `BU120`; it is `billing.routes.ts:12-13` doing exactly what `BU120`'s comment forbids.

### `BU109` and helper honesty

`firstArg(spy, label)` **throws** `Expected ${label} to have been called` when the call is missing,
so the shape cases cannot pass vacuously — read, not assumed. `BU109` asserts four real spies
(`invoiceLineItemFindMany`/`FindUnique`/`Count`/`Create`) rather than `undefined`, and its comment
scopes itself correctly to a **code-level** re-route, pointing at the docblock's four statement
counts for the Prisma-level class it cannot see. QA confirmed it reddens under the re-route
(`4 failed | 203 passed (207)`), so it is falsifiable, unlike the `readLineItems` tie-break.

### S-47 and S-48 at the authoritative-file bar

**S-47 — all four divergences and every supporting citation re-derived.**
`:115` is `**File**: \`controllers/billing.controller.ts\``; `:118` is "Fetch `Invoice` by `id` with
`lineItems` included" and carries no tenant predicate; `:119` is the
`invoice.tenantId === req.tenantId` line with "(do not leak existence)"; `:122-136` is the response
block, silent on ordering. Item 3's supporting claims hold: `INVOICE_HEADER_SELECT`
(`invoice.repository.ts`) has exactly eight fields and **no `tenantId`**, and `BU75b`
(`invoice.repository.unit.test.ts:795`) pins that — so the epic's comparison would require
reversing a T-046 decision, and my P1a/P1b show it could only ever see `true`. Item 2's `BU108`
assertion `expect(args).not.toHaveProperty("include")` exists at `:817` and `:900`.

**The "five sibling entries for two epic files" count is right**: S-29, S-32, S-35 and S-42 are each
titled and scoped to a named section of `docs/epics/epic-7-worker-service.md`, and S-47 is the one
in epic-8. The "new id, not an extension" argument therefore holds — extending any of the four would
falsify its own title.

**S-48** — steps A–E re-derived above; the entry's only weakness is that it under-claims (NIT-2).

### The 404, statement-count half

Confirmed above — foreign and unknown both issue **four** statements with **zero** naming
`"InvoiceLineItem"`, against five and one for the own-tenant read. Combined with byte-identical
payloads and headers, the `404` is not an oracle in body, header or work. I ran **no** statistical
timing study; the claim is structural, which is the evidence that survives a noisy host.

### Clean-code gate

| Check | Result | Disposition |
|---|---|---|
| Magic status codes in changed/new `src/` | **none** outside comments — grep for `\b(200\|201\|400\|401\|404\|409\|422\|500)\b` across all eight source files returns nothing | pass |
| Error codes / messages in constants | `InvoiceNotFoundError` takes `CODE_INVOICE_NOT_FOUND` / `HTTP_STATUS_NOT_FOUND` / `MESSAGE_INVOICE_NOT_FOUND` | pass |
| Route path / param single-spelling | `BILLING_ROUTES.INVOICE_DETAIL` derives from `INVOICES_PATH` + `BILLING_INVOICE_DETAIL.PARAM_ID`; the validator keys off the same constant | pass — **and the "cannot drift" universal holds**: renaming `PARAM_ID` to `"invoiceId"` produces `TS2339` at `invoice.service.ts(78,60)` plus four `TS2353` in the service unit file, so the path, the parsed key and the consumer move together or the build breaks |
| DRY on the field-name lists | three copies → one each (L-3) | fixed |
| Magic strings in the fixture sort | constants (L-4) | fixed |
| Sort fields from generated enums | `Prisma.InvoiceLineItemScalarFieldEnum` / `Prisma.SortOrder` | pass |

---

## Priority 4 — final-review scope

### Test coverage alignment

Billing **19 files / 207 tests**, all green, twice. Coverage `All files 99.28 stmts / 93.71 branches
/ 100 funcs` against thresholds 80/75. Every implemented path of the new surface has a case;
`src/validators` and `invoice.service.ts` are at 100/100. The only untested logic the diff adds is
`billing.controller.ts:131` (**L-7**). No orphaned code: `findDetailById`, `getInvoice` (service),
`getInvoice` (controller), `invoiceDetailParamsSchema` and `InvoiceNotFoundError` each have callers
and cases.

### Release readiness against the acceptance criteria

The epic states no numbered ACs for T-047; `docs/epics/epic-8-billing-service.md:113-136` is the
section, and the plan derives eight. QA mapped all eight to cases that go red when the behaviour
breaks, and I re-derived the three that carry the security weight: **AC2** (unknown ≡ foreign — body
bytes, headers *and* statement counts), **AC6** (`tenantId`/`invoiceId` never on the wire — the
`select` excludes both, `BU108` pins the absent `include`), **AC8** (line items reachable only via
the `Invoice` relation — `BU109` plus P1c showing what the alternative returns). The epic's `:119`
requirement "do not leak existence" is met more strictly than asked.

### Breaking-change assessment across the other 12 packages

**Low, and structurally bounded.** The diff touches `apps/billing-service`,
`.claude/rules/known-gaps.md` and three `docs/` files, and **nothing else** — verified:
`git status --porcelain` filtered to anything outside those three prefixes returns empty, and
`git status --porcelain prisma packages` returns **0 lines**. No shared package, no
`prisma/schema.prisma`, no migration. All 11 other packages are at their expected totals, twice, on
a `0 cached` run. The new route sits under the existing `/v1/billing` gateway proxy prefix and the
header contract is unchanged, so no gateway change was needed — gateway's 38 tests are green. I did
**not** drive a real proxied request through the gateway (see *could not verify*).

### T-049's residue — confirmed, one of two

`docs/epics/epic-8-billing-service.md:184-185`, re-read:

- `:184` "Invoice detail for different tenant's invoice → `404`" — **closed here**, by `BI30` (the
  refusal) with `BI29` (indistinguishable from an unknown id).
- `:185` "Attempt to update `FINALIZED` invoice → `409 INVOICE_IMMUTABLE`" — **not closed here, and
  it is T-048's.** `grep -rn "async update"` across `apps/billing-service/src` returns nothing; the
  existing `INVOICE_IMMUTABLE` code belongs to S-45's absorb path (`constants.ts:123` reads
  "Invoice is not a draft and **cannot absorb late usage**"), not to an update endpoint. T-047 adds
  nothing to it.

The plan's statement of this is exact.

### Is this safe to commit?

**Yes, once M-4 is fixed.** M-4 is comment-only and moves no count. Nothing else in the change
requires a code edit, the security property is measured at two layers rather than argued, and the
one table the database does not protect is protected by a route whose failure mode I reproduced end
to end.

### What no artifact currently says, and an operator or the next task needs

1. **`HEAD /v1/billing/invoices/:id` exists and is guarded.** Fastify's `exposeHeadRoutes` default
   auto-creates it; no plan, review or QA artifact mentions it. It is inside the guarded scope
   (unauthenticated `HEAD` → `401`) and is not an existence oracle (foreign and unknown both
   `404 / content-length 58`), but it is an unlisted route on the tenant-facing surface and the
   next person to enumerate this service's endpoints should know it is there. Recorded here rather
   than filed: it is correct today, and one sentence in a review is proportionate.
2. **`InvoiceLineItem` still has exactly one index** (`InvoiceLineItem_pkey` on `id`, re-queried) —
   nothing on `invoiceId`. Every measurement in all three gates was at ≤ 4 rows, where a `Seq Scan`
   is right and proves nothing. The plan carries it as R3. An operator watching this endpoint after
   invoices accumulate should expect this to be the first thing to need attention.
3. **S-10 stays open and `BI9`/`BI32` go red when it closes** — on purpose. Whoever writes that
   migration must expect two red cases and must not "fix" them by weakening the assertions.

---

## Compile-time gate — `--force`, all 13 packages

Run **twice**: once at session start on the pristine tree, once on the restored tree after every
mutation was reverted and `md5sum -c` reported 20/20 `OK`. Identical both times.

`npx turbo run typecheck lint build test --force` → **`Tasks: 52 successful, 52 total`**,
**`Cached: 0 cached, 52 total`**, exit 0. Nothing replayed.

| Package | typecheck | lint | build | Test files | Tests |
|---|---|---|---|---|---|
| `@telemetry/shared-config` | ok | clean | ok | 1 | 4 |
| `@telemetry/shared-logger` | ok | clean | ok | 1 | 4 |
| `@telemetry/shared-tracing` | ok | clean | ok | 1 | 2 |
| `@telemetry/shared-types` | ok | clean | ok | 1 | 8 |
| `@telemetry/shared-utils` | ok | clean | ok | 1 | 18 |
| `@telemetry/shared-validation` | ok | clean | ok | 1 | 15 |
| `@telemetry/gateway` | ok | clean | ok | 8 | 38 |
| `@telemetry/auth-service` | ok | **10 warnings (pre-existing)** | ok | 15 | 166 |
| `@telemetry/usage-service` | ok | **4 warnings (pre-existing)** | ok | 19 | 230 |
| **`@telemetry/billing-service`** | ok | clean | ok | **19** | **207** |
| `@telemetry/worker-service` | ok | clean | ok | 17 | 234 |
| `@telemetry/analytics-service` | ok | clean | ok | 4 | 18 |
| `@telemetry/web` | ok | clean | ok | — | **0** (no suite) |

**Root total, derived rather than copied:**
`4+4+2+8+18+15+38+166+230+207+234+18` = **944**. Twelve packages report; `@telemetry/web`
contributes none. Billing **207**. Both match the brief.

`pnpm test:smoke` — **6 suites, 7 cases** (gateway 2, the other five 1 each), exit 0.

**14 lint warnings, 0 errors, and zero `no-unsafe-return` — provenance derived here, not cited:**

| Count | Rule | File | `git log -1 -- <file>` | In the diff? |
|---|---|---|---|---|
| 10 | `@typescript-eslint/no-misused-promises` | `apps/auth-service/tests/auth.service.unit.test.ts` | **`d68e719`, 2026-08-25** | no |
| 4 | `@typescript-eslint/no-unsafe-assignment` | `apps/usage-service/tests/ingestion.service.unit.test.ts` | **`b0f6921`, 2026-08-31** | no |

`git status --porcelain apps/auth-service apps/usage-service` is **empty**, so neither file is
touched by this change. **The brief and the plan §12 correction are right; Round 1's `1b872b3` /
`3588bf1` were wrong** — an independent third derivation now agrees with the plan. Round 1's
conclusion (pre-existing) was unaffected, since it rests on the file list rather than the hashes.

`pnpm format:check` deliberately not run — S-12, it cannot pass on any revision and no CI step
invokes it.

---

## Environment hygiene

- **Postgres and Redis left running.** Neither stopped.
- **Row counts, start and end, identical:** `Tenant 2 | Invoice 0 | InvoiceLineItem 0 | UsageLine 0
  | Event 0 | Meter 0`. **No orphan appeared.** The two tenants are the S-20 residue and were left
  alone — both `Acme Inc`, ids `456793cd-…` and `d4101ff1-…`, with users under
  `@auth-integration-a90cd587-…` and `@auth-integration-2b860f1d-…` — two different uuids, the
  two-prior-runs signature S-20 records and the same pair QA reported.
- **All probe fixtures seeded through `DIRECT_DATABASE_URL`** (owner) and read through
  `DATABASE_URL` (`telemetry_app`); deleted by explicit id; counts re-checked after every script.
  No running service was pointed at the direct URL.
- **`v1_7` not rolled back, no role dropped.** `_prisma_migrations` head is
  `v1_7_worker_billing_enumerator`; all five `telemetry_*` roles present.
- **Redis db 0 was not written by me** (my probe app used db 15). It **was** written by the mandated
  gate: `DBSIZE` 2, holding `telemetry:events` plus a TTL'd `denylist:*` key. That is **S-22**
  firing again — auth-service's suite hard-codes `redis://localhost:6379` with no logical database.
  Reported, not cleaned, not rounded to green, and not a defect in this change.
- **Tree restored byte-identical.** `md5sum -c` over all 20 changed/new files: **20 `OK`, 0
  mismatches**, re-verified after each of the seven mutations. `git status --porcelain` unchanged
  (14 ` M`, 6 `??`); `git diff --stat` still `14 files changed, 1543 insertions(+), 31 deletions(-)`.
  Three throwaway probe scripts were created under `apps/billing-service/` and deleted;
  `find . -name "zz-*"` outside `node_modules` returns 0.
- **Nothing staged, committed or branched.**

**Mutations performed and reverted (seven):** the detail-route scope move (twice — package scope and
verbose per-case); the hooks-to-root move; `getInvoice`'s `!tenantId` block removed; `detail:` added
to `getInvoice`'s 500 body; S-48 steps A/B/C/D/E; the S-48 docblock paragraph deleted for NIT-2;
`PARAM_ID` renamed.

---

## What I could not verify, and why

- **That the Prisma suppression holds under a future major bump or with `relationJoins` enabled.**
  `@prisma/client` is **6.19.3** and `prisma/schema.prisma` declares no `previewFeatures` (both
  re-checked), so `relationJoins` is off. Enabling it would regenerate the client workspace-wide,
  which is outside a read-only review. The docblock's four-row re-verification is the mitigation and
  it is correctly scoped; it is not a mechanical check.
- **Behaviour at realistic volume.** Every measurement here was at ≤ 4 rows. No conclusion about
  the missing `invoiceId` index.
- **The gateway → billing path end to end.** I drove billing directly through `app.inject`. I did
  not stand up the gateway and issue a JWT-derived proxied request, so the strip-and-re-inject of
  `x-tenant-id` for this new path is unverified by me. The route is under the existing
  `/v1/billing` prefix and gateway's suite is green — that is reasoning plus a green suite, not a
  measurement.
- **Timing as a side channel.** Established structurally (identical statement counts, identical
  bytes and headers); no statistical timing study. Stated as structural, not as "no timing
  difference exists".
- **`set-cookie`-style array-valued headers** in the V2 duplicate-secret probe. I probed
  `x-internal-secret` only, through `app.inject` only — not over a raw socket, and not the
  documented array-valued exception. The finding is "no bypass on this header, this transport";
  S-8 item 4's wider scoping stands.
- **That `BI32`'s expectation goes red when S-10 closes.** A forward claim about a migration that
  does not exist. Reasoning only, and plausible.
- **`@telemetry/web` contributes no test evidence.** It builds and has no suite, so "944 green" says
  nothing about it. Unchanged by this diff.

---

## Remaining risks and dispositions

| # | Risk | Disposition |
|---|---|---|
| R1 | A later method takes a bare `invoiceId` and leaks cross-tenant line items — P1c/P1e are live. | **Accepted, with a named and now fully-measured upgrade path.** `BU109` catches the code-level re-route; S-48 records the two-line type-level close, verified non-breaking at step D, with its limit verified at step E. |
| R2 | A Prisma major bump or `relationJoins` changes the emitted plan. | **Accepted.** Scoped in the docblock and in `BU109`'s comment with the exact four-row re-verification. Still nothing mechanical — see out-of-scope gap 1. |
| R3 | No index on `InvoiceLineItem.invoiceId`. | **Accepted.** Re-confirmed: one index, the pkey. Settle with `EXPLAIN (ANALYZE)` at volume. |
| R4 | S-10 stays open — `InvoiceLineItem` RLS inert. | **Accepted, deliberately.** `BI9` and `BI32` are the standing markers and go red on purpose when it closes. |
| R5 | `BU120` adds no discriminating power over `BU83`. | **Accept and keep** — but **M-4**: it must stop being cited as the detail route's guard. |
| R6 | `getInvoice`'s non-`Error` catch arm untested. | **Accepted — L-7.** Cover it with T-046's identical twin, not alone. |
| R7 | S-37 (`Tenant.deletedAt`): a soft-deleted tenant's invoice is readable here. | **Accepted.** Nothing writes the column; S-37 records it. |
| R8 | S-22: the mandated gate writes TTL'd keys to Redis db 0. | **Reported, not fixed.** Pre-existing, auth-service's harness. |
| R9 | `billing.routes.ts:9-10` overstates the unscoped exposure. | **L-6 — pre-existing (T-046), recommended not required.** If not fixed here it should be carried; it is the last uncorrected copy of a claim this task fixed twice. |

---

## Out-of-scope gaps — recommend recording in `.claude/rules/known-gaps.md`

Neither should be fixed inside T-047. Round 1 recommended both; item 2 was answered by decision D-A
and is now **S-48**, so only the first remains open.

1. **Nothing mechanically notices a Prisma upgrade that would invalidate the `InvoiceLineItem`
   suppression.** The safety of the platform's only read of an RLS-less table rests on a client
   behaviour recorded in one docblock, with a human instructed to re-measure before an upgrade
   lands. `BU109` cannot see it — correctly stated in the diff, and re-confirmed here. A candidate
   mechanism: one test pinning `@prisma/client`'s version and the four statement counts together, so
   a dependency bump without a re-measure is red rather than silent. Same family as S-33's "make the
   number checkable", and the natural owner is whoever next touches this table. **Recommend filing
   as a new id** — it is not S-48 (that entry is about a *type-level* guard on the `tx` re-route,
   a different mechanism and a different failure) and not S-33 (which is about stale counts in
   comments, not about a dependency invalidating a measured behaviour).

---

## Decision for the user

### Does L-6 — the pre-existing overclaim in the route docblock — get fixed in this commit?

M-4 is required either way and touches lines 12-13 of that same docblock, so the file is already
open. The question is only whether the sentence two lines above it is corrected in the same edit.

| Option | What changes | Cost |
|---|---|---|
| **A · Fix M-4 and L-6 together** | `billing.routes.ts:9-10` and `:12-13`, one docblock, comment-only | one extra sentence; re-run lint |
| B · Fix M-4 only; leave L-6 | `billing.routes.ts:12-13` only | none now; the file's security-contract paragraph keeps a claim this task corrected twice elsewhere, two lines from a line it just edited |
| C · Fix M-4, and file L-6 as a known gap | `:12-13`, plus a new entry | spends a permanent id on one sentence |

**Recommended: A.** L-6 is genuinely T-046's — proved with `git show HEAD:…`, and it is not counted
against this change — but the one-task-per-commit objection that normally protects a pre-existing
line does not bite here: the edit is inside the docblock this diff is already rewriting, it is
comment-only, and it makes the file internally consistent with the corrected comment at
`billing-invoice-detail.route.test.ts:94-109`. C is the weakest: a gap id for one sentence in a file
the commit already touches is the trade S-33 warns against in the other direction.

**All three options change the diff** (A and B in code comments, C in `known-gaps.md`); none changes
behaviour, and billing stays at **207** / root **944** under any of them.

---

## Required fixes for a CONDITIONAL clear

1. **M-4** — `apps/billing-service/src/routes/billing.routes.ts:12-13`: remove `BU120` from the
   detail-route citation and state the measured red set. `BU120` passes under exactly the mutation
   the sentence claims it notices, and `billing-invoice-detail.route.test.ts:207-208` forbids the
   citation.

**Recommended, not blocking:** L-6 (the pre-existing overclaim two lines above, see the decision
above), L-7 (cover `billing.controller.ts:131` together with T-046's `:67`).

**Recorded, no action:** NIT-2 (S-48 under-claims; the `733 → 740` cause is measurable by
reconstruction and now is).

Re-run lint and the billing package after M-4; it is comment-only, so **207 / 944 must hold**, and
this time that arithmetic is not self-referential.
