# T-047 · Invoice detail (`GET /v1/billing/invoices/:id`) — QA Tester

**Gate 5.** Base `21497bd`, T-047 uncommitted. Read-only with respect to the diff: every mutation
below was reverted and the billing tree re-checksummed byte-identical (`md5sum -c`, 58/58 `OK`,
0 mismatches) after each. Nothing staged, committed or branched.

**Rules revision read from disk, not from the injected copy.** `.claude/rules/known-gaps.md`:
**2866 lines**, `md5sum 9dfd5461315f42e90961adb24c568363`, **41 `## S-` headings running S-5 …
S-48**, including the **S-47** and **S-48** this diff adds. The copy injected into this QA session
was stale again — a further sighting of **S-24**, consistent with the ninth the brief reports.
Every gap cited below was re-read from the file on disk with `sed -n`.

---

## Verdict

# PASS

The endpoint is correct and its security property is real rather than asserted. I reproduced the
cross-tenant leak the design exists to avoid, attacked the shipped route across 20 vectors and
could not make it yield another tenant's data, and confirmed by mutation that the two guards
which stop it (`BU109`, `BI30`) both go red when the leak is reintroduced — with the full body
tenant B would have received captured verbatim.

Three defects, all **documentation counts inside artifacts that ship in this commit**, none
affecting behaviour, none blocking on their own. One (**F-1**) sits in `.claude/rules/`, which
`CLAUDE.md` designates authoritative, so it is graded above the others. A decision on whether they
are fixed before commit is at the end.

Gates: **13/13 packages** green on typecheck, lint, build and test, all with `--force`; **944**
root tests, **207** billing; `pnpm test:smoke` 6 suites / 7 cases. 14 lint warnings, all
pre-existing and proved so from `git log`; **zero** `no-unsafe-return`.

---

## Defects

### F-1 · `.claude/rules/known-gaps.md` S-47 undercounts the diff by one — MEDIUM

`.claude/rules/known-gaps.md:2764` (S-47, item 1):

> … alongside the controller handler — **3 new files and 12 changed**.

Measured on the shipped tree:

```
$ git status --porcelain apps/billing-service | grep -c '^??'   ->  3
$ git status --porcelain apps/billing-service | grep -c '^ M'   -> 13
```

**3 new is right; 12 changed is 13.** The missing file is
`apps/billing-service/tests/billing.controller.unit.test.ts` — the file the review's **M-2**
required and the Gate-3 rework added. `13 - 1 = 12` exactly, so the count was taken before M-2
landed and not re-derived afterwards. The review itself states the pre-M-2 figure
(`docs/reviews/t-047-invoice-detail-endpoint.md`, M-2: "`git status --porcelain` lists 12 modified
billing files; that is not one of them"), which is where the 12 comes from and why it is now
wrong.

Graded MEDIUM rather than HIGH: `.claude/rules/review-standards.md` § *Claims the Change Makes*
grades a false claim in `.claude/rules/` as HIGH, but that grading is for claims that mislead
about behaviour, and this one is a file count in a task description with no security or
correctness consequence. Graded above LOW because it is in a designated-authoritative file, was
introduced by this diff, and is precisely the **S-33** failure mode the same diff catalogues —
a count invalidated by the commit that ships it.

**Reproduction:** the two `git status` commands above, from the repository root.

### F-2 · S-48's step-B line citation has drifted by seven lines — LOW

`.claude/rules/known-gaps.md:2828` (S-48, step B) cites
`invoice.repository.ts(733,16): error TS2339`.

Re-derived, performing steps A and B exactly as the entry specifies
(`pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json`):

```
src/repositories/invoice.repository.ts(467,41): error TS2345: Argument of type 'TransactionClient' is not assignable …
src/repositories/invoice.repository.ts(626,39): error TS2345: Argument of type 'TransactionClient' is not assignable …
src/repositories/invoice.repository.ts(740,16): error TS2339: Property 'invoiceLineItem' does not exist on type 'TransactionClient'.
```

The two `TS2345` at `:467` and `:626` match the entry exactly, as does `markUsageLinesBilled`'s
parameter at `:407` for step C. Only the `TS2339` line differs: **740, not 733**. The file above
`:467` is unchanged, so the drift is below it — consistent with `findDetailById`'s docblock having
grown after the measurement was taken (the rework added the S-48 pointer to that docblock).

Substance is unaffected — the error code, the property name and the type are all right. Recorded
because S-48 is in an authoritative file and a reader who jumps to `:733` lands in the docblock
rather than on the re-route.

**Reproduction:** insert `await tx.invoiceLineItem.findMany({ where: { invoiceId: id } });` as the
first statement of `findDetailById`'s `withTenant` callback, add `| "invoiceLineItem"` to
`TransactionClient`'s `Omit` at `apps/billing-service/src/repositories/base.repository.ts:4-7`,
then run the `tsc` above.

### F-3 · The plan's M-1 row quotes a package total from before M-2 — LOW

`docs/plans/t-047-invoice-detail-endpoint.md:454` (§12, M-1 row):

> **Whole package:** `9 failed | 196 passed (205)` across 2 files, adding BI28–BI31 and BI33.

Re-performed on the shipped tree — the detail route re-registered with `app.get(...)` on the root
instance instead of `scope.get(...)` — `pnpm --filter @telemetry/billing-service exec vitest run`:

```
 Test Files  2 failed | 17 passed (19)
      Tests  9 failed | 198 passed (207)
```

**9 failed and 2 files are correct**; the totals are the **pre-M-2** package size. The same table's
**M-3** row correctly reports `26 failed | 181 passed (207)`, which I also re-performed and
confirmed exactly (6 files). So one row of the table was re-measured after `BU121`/`BU122` landed
and the other was not — and §12's own "Counts after the rework" section states billing moves
205 → 207, which contradicts the M-1 row three paragraphs above it.

The red set I measured is `BU115`, `BU116`, `BU117`, `BU119` (route file) and `BI28`, `BI29`,
`BI30`, `BI31`, `BI33` (integration) — the nine the brief states, and the nine the row's own prose
describes. Only the arithmetic is stale. The plan ships in the commit
(`.claude/rules/git-commit.md` § *Contents*).

---

## Priority 1 — the isolation boundary on a table with no RLS

**Which harness:** a **real billing-service** built by `buildBillingServiceApp()` against **live
PostgreSQL**, driven through `app.inject`, connecting as `telemetry_app`. Fixtures were seeded
through `DIRECT_DATABASE_URL` (owner) and never read through it. No running service was pointed at
the direct URL.

### The database confirms it does not stop the read

```
$ psql -Atc "select relname, relrowsecurity, relforcerowsecurity, (policies) from pg_class …"
Invoice|t|t|1
InvoiceLineItem|f|t|0        <- RLS never ENABLEd, zero policies (S-10)
Meter|t|t|1
Tenant|t|t|4
UsageLine|t|t|2
```

### The leak, reproduced

As `telemetry_app` (`rolsuper=f, rolbypassrls=f`, read from `pg_roles` on the same connection),
inside a transaction with `set_config('app.tenant_id', <tenant B>, true)` — exactly what
`withTenant` issues — asking about tenant A's invoice:

| Probe | Query | Result |
|---|---|---|
| P1a | `invoice.findFirst({ id: A_INV, tenantId: B })` | `null` |
| P1b | `invoice.findFirst({ id: A_INV })` — **predicate removed** | `null` |
| **P1c** | **`invoiceLineItem.findMany({ where: { invoiceId: A_INV } })`** | **A's 3 line items, with `metricKey`, `quantity`, `unitPrice`, `amount` and `invoiceId`** |
| **P1e** | **`invoiceLineItem.count({})` — no filter at all** | **4 — every tenant's rows** |
| P1f | `invoice.count({})` — the RLS-enabled parent | 1 — B's own only |
| P1d | `invoiceLineItem.findMany({ invoiceId: A_INV, invoice: { tenantId: B } })` | `[]` |

P1c returned, verbatim:

```
[{"metricKey":"storage.write","amount":"0.625","unitPrice":"0.25","invoiceId":"a1a1a1a1-…-00000000000a"},
 {"metricKey":"api.request","amount":"15","unitPrice":"5","invoiceId":"a1a1a1a1-…-00000000000a"},
 {"metricKey":"api.request","amount":"10.1","unitPrice":"1","invoiceId":"a1a1a1a1-…-00000000000a"}]
```

P1b and P1f together are the point: the parent table's RLS is doing real work and the child
table's is absent. **The application route is the entire tenant control on `InvoiceLineItem`.**
This independently re-derives the plan's §3.1 and S-47 item 3; S-46 applies to the `Invoice`
lookup (P1a ≡ P1b, so deleting the predicate is invisible behaviourally — keep it, and `BU107` is
the shape case that stands in for it).

### The attack on the shipped endpoint — 20 vectors, none yielded data

Tenant A holds one invoice with three line items; tenant B holds its own. Every request below asks
for **A's** invoice unless stated. Assertions are on the **body**, never the status alone.

| # | Vector | Status | Body |
|---|---|---|---|
| A1 | A asks for A's invoice (control) | `200` | full invoice, 9 keys, 3 lines |
| **A2** | **B asks for A's invoice** | `404` | `{"code":"INVOICE_NOT_FOUND","message":"Invoice not found"}` |
| A3 | A asks for an unknown UUID | `404` | byte-identical to A2 |
| A4 | nil UUID `00000000-0000-0000-0000-000000000000` | `404` | identical |
| A5 | malformed `:id` (`not-a-uuid`) | `400` | `{"code":"VALIDATION_ERROR","message":"id: Invalid uuid"}` |
| A6 | duplicated `x-tenant-id: [A, B]` | `401` | `TENANT_CONTEXT_INVALID` — fastify joins to `"A, B"`, which fails the UUID check |
| A7 | duplicated `x-tenant-id: [B, A]` | `401` | identical to A6 — **no first-value arm**, unlike billing's internal-auth guard (S-8 item 4) |
| A8 | header name uppercased `X-TENANT-ID: B` | `404` | identical — HTTP case-insensitivity gives no bypass |
| A9 | A asks for its **own** id, uppercased | `404` | identical (see O-3) |
| A10 | no `x-tenant-id` | `401` | `TENANT_CONTEXT_MISSING` |
| A11 | no `x-internal-secret` | `401` | `{"code":"UNAUTHORIZED"}` — before tenant context is derived |
| A12 | wrong `x-internal-secret` | `401` | `{"code":"UNAUTHORIZED"}` |
| A13a–d | id + `%20`, `'`, `%00`, `..%2f..%2finvoices%2f…` as B | `400` | `VALIDATION_ERROR` |
| A13e | id + `?x=1` as B | `404` | identical to A2 — querystring split before the param |
| A14 | `x-tenant-id` set to A's **invoice** id | `404` | identical |
| A15 | B asks for B's own invoice (control that B works) | `200` | B's invoice only |

**Not one vector produced another tenant's data.** A11/A12 confirm the hook order holds for the new
route: an unauthenticated caller is refused with `UNAUTHORIZED` before any tenant context exists.

### The 404 is not an existence oracle

Compared programmatically, not by eye:

```
status equal:                    true
body bytes equal:                true
content-length equal:            true   (58 both)
headers (minus date) equal:      true
  connection: keep-alive|content-length: 58|content-type: application/json; charset=utf-8
```

And, stronger than the bodies — the **work is identical**, so there is nothing for a timing
attack to measure. Prisma query log captured inside the transaction:

| Case | Result | Total statements | `"InvoiceLineItem"` statements |
|---|---|---|---|
| A asks for A's invoice | the invoice | 5 | **1** |
| **B asks for A's invoice** | `null` | **4** | **0** |
| **A asks for an unknown UUID** | `null` | **4** | **0** |

The foreign and unknown cases issue the same four statements and skip the line-item read entirely,
because Prisma omits the second statement when the tenant-filtered parent read matches nothing.
This re-derives rows 1, 2 and 4 of the plan's §3.3 table on the shipped method.

I did **not** run a statistical timing study; the claim above is structural (identical statement
count and shape), which is the stronger evidence and the one that survives a noisy host.

### `tenantId` and `invoiceId` never reach the wire

Audited against the **real 200 body**, by raw string scan rather than by reading the `select`:

```
top-level data keys: ["createdAt","currency","finalizedAt","id","lineItems","periodEnd","periodStart","status","totalAmount"]
body contains "tenantId":  false
body contains "invoiceId": false
body contains tenant A's uuid: false
lineItem keys (all 3): ["amount","id","metricKey","quantity","unitPrice"]
```

Eight header fields plus `lineItems`; five line-item fields. No `include` anywhere in the emitted
shape.

### Both guards are falsifiable — the leak reintroduced, end to end

Two mutations, each reverted:

1. **Re-route keeping the null early-return** (`tx.invoiceLineItem.findMany({ where: { invoiceId: id } })`,
   header still tenant-filtered): typechecks clean, and reddens
   **`BU108`, `BU109`, `BU110`, `BU111`** — `4 failed | 203 passed (207)`. `BU109` fails with
   `expected "spy" to not be called at all, but actually been called 1 times`. `BI30` stays
   **green**, correctly: with the early return intact the foreign request still answers `404`.
2. **The leaking re-route** the case is documented against (answer with whatever the line-item read
   found when the header is null): `BI29` and `BI30` both fail `expected 200 to be 404`, and the
   body tenant B actually received was:

```json
{"data":{"id":"a1a1a1a1-…-00000000000a","periodStart":"1970-01-01T00:00:00.000Z",…,
 "lineItems":[{"id":"…a1","metricKey":"api.request","quantity":"10","unitPrice":"1","amount":"10.1"},
              {"id":"…a2","metricKey":"api.request","quantity":"3","unitPrice":"5","amount":"15"},
              {"id":"…a3","metricKey":"storage.write","quantity":"2.5","unitPrice":"0.25","amount":"0.625"}]}}
```

All three of tenant A's lines, with metric keys, quantities, unit prices and amounts. `BI30`'s
inline account of both variants and their distinct failure modes (`expected 500 to be 404` for the
naive spread, `expected 200 to be 404` for the leaking one) is accurate; my variant 1 is a third
form it does not claim to cover, and the unit file catches it.

**So the isolation property is tested, not tautological, at two layers.**

---

## Priority 2 — the contract, driven for real

### Precision — `Decimal(18,6)` survives byte-exact

Fixture chosen so the float round trip is lossy (`String(Number(x)) !== x`), per the §3.5 trap:

| Field | Stored | On the wire | `typeof` | Byte-equal |
|---|---|---|---|---|
| `totalAmount` | `123456789012.345678` | `"123456789012.345678"` | string | **yes** |
| `precision.a` `quantity` | `999999999999.999999` | `"999999999999.999999"` | string | **yes** |
| `precision.a` `unitPrice` | `0.000001` | `"0.000001"` | string | **yes** |
| `precision.a` `amount` | `123456789012.345678` | `"123456789012.345678"` | string | **yes** |

`Number(amount)` round-trips to `123456789012.34567` — one digit lost — so the fixture does
discriminate, and the served value is the full-width one.

**Below HTTP**, asserted on the repository return rather than the response (because
`Prisma.Decimal` defines `toJSON` and a route-level `typeof === "string"` passes either way):

```
totalAmount            typeof string | instanceof Prisma.Decimal false
precision.a / .b       quantity, unitPrice, amount: all string, all instanceof Prisma.Decimal false
periodStart/createdAt  typeof string | instanceof Date false   | finalizedAt null
```

I also confirmed the trap is live on this tree: a `this.prisma.invoice.findFirst` issued **outside**
`withTenant` returns `null` — `"Invoice"` RLS refuses it with no tenant context — which is a
pleasing second-order result, and the reason S-48's step E matters is that the **child** table
would not refuse the equivalent.

**AC5 satisfied.** See **O-2** for the trailing-zero contract note.

### The repeated `metricKey` — driven through `createDraftInvoice` + `absorbLateUsage`

Not hand-seeded. One tenant, one period, the two shipped writers, then the shipped endpoint:

```
createDraftInvoice -> {"invoiceId":"a897616a-…","created":true}
absorbLateUsage    -> {"invoiceId":"a897616a-…","totalAmount":"25"}

GET /v1/billing/invoices/a897616a-…  -> 200, totalAmount "25", 2 lines
   api.request  id=6c77f953-…  qty=10  unitPrice=1  amount=10
   api.request  id=c4aa8ba8-…  qty=3   unitPrice=5  amount=15

distinct metricKeys: 1 | rows: 2 | distinct unitPrices: 2
metricKey asc holds: true | id asc holds within api.request: true
sum of line amounts: 25 | invoice totalAmount: 25 | equal: true
```

**D1 confirmed** (one JSON line per stored row — and the two tranches genuinely carry different
unit prices, so D1's rejection of a merged line is sound: a merged row would have no correct
`unitPrice`). **D2 confirmed** on the real shape.

### Ordering is stable across updates, and the `orderBy` is load-bearing

Three line items seeded in an order agreeing with **neither** sort (`storage.write` first, then the
dearer `api.request`, then the cheaper). Endpoint order compared against the raw heap order after
each `UPDATE`:

| After | Endpoint (`metricKey asc, id asc`) | Raw heap, **no** `ORDER BY` |
|---|---|---|
| seed | `api.request/a1, api.request/a2, storage.write/a3` | `storage.write/a3, api.request/a2, api.request/a1` |
| `UPDATE` a1 | **unchanged** | `storage.write/a3, api.request/a2, api.request/a1` |
| `UPDATE` a3 | **unchanged** | `api.request/a2, api.request/a1, storage.write/a3` |
| `UPDATE` both | **unchanged** | `api.request/a2, api.request/a1, storage.write/a3` |

`ORDER STABLE across 3 update rounds: true`. The heap order visibly reshuffled while the response
did not, which both re-derives the plan's probe P3 mechanism and shows the sort is doing work
rather than agreeing with an accident. **AC7 satisfied.**

### The `400` path and `BU106`'s UUID acceptance

`BU106`'s claim re-measured against the real `uuidSchema` (zod 3.25.76), 13 forms:

| Accepted (7) | Rejected (6) |
|---|---|
| v4, **v1**, **v7**, **version nibble `0`**, **invalid variant `c`**, **nil UUID**, **uppercase** | leading space, trailing space, empty, `abc`, braced, unhyphenated |

`tenantIdSchema` agreed on **all 13**, with identical parsed values on every accept — **0
disagreements**, confirming L-2's corrected "derives from, and accepts the same set" wording.

**Is the endpoint's behaviour on those sane?** Yes, with one wrinkle.

- The **nil UUID** reaches the repository and matches nothing → `404`, byte-identical to every
  other `404` (measured, A4). Correct: it is well-formed, so `400` would be the wrong diagnosis,
  and it leaks nothing.
- **v1 / v7 / nibble `0` / variant `c`** are all well-formed shapes that cannot be any invoice id
  here (`Invoice.id` is `@default(uuid())`, v4) → `404`. Correct and harmless.
- **Uppercase** is the wrinkle — see **O-3**. Accepted by the schema, then missed by the
  case-sensitive column comparison, so a tenant asking for its *own* invoice in uppercase gets
  `404`. Not a leak; a usability quirk, and pre-existing platform behaviour rather than something
  T-047 introduced.

**AC3 satisfied.** Malformed params are refused at `400` before any repository is constructed —
confirmed at the route level (`BU118`, and A5/A13 above).

---

## Priority 3 — the rework's claims, none previously seen by any gate

| Claim | Where | Re-performed? | Result |
|---|---|---|---|
| `BU122` reddens on the 500-leak mutation | plan §12 M-2; `billing.controller.unit.test.ts` BU122 comment | **yes** | **Confirmed exactly.** Adding `detail: error.message` to `getInvoice`'s 500 body gives `Tests 1 failed \| 5 passed (6)`, `BU122` alone, `AssertionError: expected { code: 'INTERNAL_ERROR', …(2) } to deeply equal { code: 'INTERNAL_ERROR', …(1) }` — the deep-equal catches it where a status assertion would not. The 500 leaks nothing. |
| M-1's mutation reddens 9 cases across 2 files | brief; plan §12 M-1 | **yes** | **9 across 2 confirmed**; totals stale — see **F-3**. Failure modes verified as `expected 400 to be 401` ×2, `expected 400 to be 200` ×2, `expected 400 to be 404` ×2, plus three `TypeError`/undefined. **So M-1's corrected comment is right: the unguarded route answers 400, not 200, and carries no invoice** — `billing.controller.ts`'s own `!tenantId` guard catches it first. |
| M-3's mutation reddens 26 across 6 files | plan §12 M-3 | **yes** | **Exact match**, including the total: `Test Files 6 failed \| 13 passed (19)`, `Tests 26 failed \| 181 passed (207)`. |
| **S-48 step E** — `this.prisma.invoiceLineItem.findMany(...)` compiles clean with both narrowings | `known-gaps.md` S-48 | **yes** | **Confirmed, 0 diagnostics.** This is the load-bearing limit and it holds, so the entry is right to say "a `tx` re-route becomes `TS2339`" and never "unrepresentable". Worth restating why that route is worse: it runs outside the transaction, so **no** `set_config('app.tenant_id', …)` has been issued, and P1c above shows the child table has no policy to fall back on. |
| S-48 steps A–D | `known-gaps.md` S-48 | **yes** | A compiles clean ✓. B gives the `TS2339` **plus** `TS2345` at `:467` and `:626` ✓ (line number drift — **F-2**). C clears both `TS2345`, leaving only the intended `TS2339` ✓ (`markUsageLinesBilled`'s param at `:407` ✓). D — the two narrowings alone — typechecks clean with `Tests 207 passed (207)` ✓. **So S-48's proposed fix is verified non-breaking.** |
| **S-47** — four epic divergences | `known-gaps.md` S-47 | **yes** | All four verified against `docs/epics/epic-8-billing-service.md`: `:115` is `**File**: controllers/billing.controller.ts` ✓; `:118` carries no tenant predicate ✓; `:119`'s `invoice.tenantId === req.tenantId` is dead code ✓ (my P1a/P1b re-derivation: the foreign row never arrives) **and** would require selecting `tenantId`, which `INVOICE_HEADER_SELECT` excludes ✓; `:122-136` is silent on ordering and on a repeated `metricKey` ✓, and the five line-item fields sit at `:128-132` exactly as D5's corrected citation says ✓. S-47's "what the epic gets right" is also right — `BI29` does assert deep-equality, not merely two `404`s. **One count is wrong — F-1.** |
| **The fixture change** — no existing expectation moved | `integration.fixtures.ts` `readLineItems` docblock | **yes** | **Confirmed independently.** Reverting the `id` tie-break to the pre-T-047 `orderBy: { metricKey: "asc" }` and running `billing.integration.test.ts` gave `Tests 36 passed (36)` on **3 of 3** runs. The docblock's *reason* is also right — `BI1`, `BI8` and `BI13` do index positionally, and are undisturbed because each of their fixtures gives every row a distinct `metricKey`. See **O-1**. |
| No other task's assertions shifted | whole diff | **yes** | Across all five modified test files: **0** removed `it(` lines and **0** removed `expect(` lines (`git diff -U0 tests/ \| grep '^-.*expect('` → none). 16 cases added in modified files + 10 in the two new files = **26**, which reconciles 181 → 207 exactly. `seedInvoices` does **not** mint UUIDs by default — it keeps the readable `<prefix>invoice-<n>` id and adds an *optional* `spec.id` override, which is why T-046's callers are untouched. |

---

## Gates — all with `--force`, all 13 packages

`pnpm build -- --force` does not forward the flag, so `npx turbo run build --force` was used, and
the same form for the other three. Every run reported `Cached: 0 cached, 13 total`, so nothing was
replayed.

**typecheck** — `13 successful, 13 total`, 0 errors.
**lint** — `13 successful, 13 total`, 0 errors, **14 warnings**.
**build** — `13 successful, 13 total`, 0 errors.
**test** — `13 successful, 13 total`. Run twice (before and after all mutations); identical both times.

| Package | Test files | Tests |
|---|---|---|
| `@telemetry/worker-service` | 17 | 234 |
| `@telemetry/usage-service` | 19 | 230 |
| **`@telemetry/billing-service`** | **19** | **207** |
| `@telemetry/auth-service` | 15 | 166 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-types` | 1 | 8 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/web` | — | **0** (no test suite; the task is a no-op build check) |
| **Total** | **88** | **944** |

Twelve packages report; `@telemetry/web` contributes 0 — as the brief states. (`packages/sdk` is a
directory with no `package.json` name and is **not** a workspace member, which is why 14
directories yield 13 packages.)

**`pnpm test:smoke`** — 6 suites, `Test Files 1 passed (1)` each, **7 cases** total (2+1+1+1+1+1), exit 0.

### Lint warnings — pre-existence derived, not cited

The brief warns a prior gate got these hashes wrong, so I derived them rather than reproducing
anyone's:

| File | Warnings | `git log -1 --format='%h %ad' --date=short` | In the working diff? |
|---|---|---|---|
| `apps/auth-service/tests/auth.service.unit.test.ts` | 10 × `no-misused-promises` | **`d68e719`, 2026-08-25** | no (`git status --porcelain` → empty) |
| `apps/usage-service/tests/ingestion.service.unit.test.ts` | 4 × `no-unsafe-assignment` | **`b0f6921`, 2026-08-31** | no |

**14 total, both files untouched by this diff, and `no-unsafe-return` count across the whole run is
0.** These match the plan §12's correction and not the review's two hashes; the plan is right.

### Coverage — M-2's gap is closed

`pnpm --filter @telemetry/billing-service exec vitest run --coverage`, `All files 99.28 stmts /
93.71 branches / 100 funcs`, against thresholds of 80 / 75:

```
 src/controllers        |   100 | 91.89 | 100 |   100 |
  billing.controller.ts |   100 | 91.66 | 100 |   100 | 67,131
 src/services           | 99.05 | 97.43 | 100 | 99.05 |
  invoice.service.ts    |   100 |   100 | 100 |   100 |
 src/validators         |   100 |   100 | 100 |   100 |
```

`billing.controller.ts` was `91.39` lines with `110-115,129-130` uncovered when the review measured
it; both ranges are now covered by `BU121`/`BU122`. `invoice.service.ts` and the new validator are
at 100/100.

---

## Acceptance criteria

The epic states no numbered ACs; these are the plan's derived eight. Each was checked for a test
that goes **red when the behaviour breaks**, not merely one that exists.

| AC | Proven by | Falsifiability |
|---|---|---|
| AC1 · own invoice + line items, `200` | `BU117`, `BI28` | both redden under M-1's scope mutation; `BI28` also drives real rows |
| AC2 · unknown and foreign are indistinguishable `404`s | `BU113`, **`BI29`**, `BI30` | `BI29` is a **deep-equal**, so a differing `message` fails it; both redden under the leaking re-route. Independently re-verified byte-for-byte *and* by statement count |
| AC3 · malformed id → `400` before any repository | `BU104`, `BU105`, `BU118`, `BI32` | `BU118` asserts `getInvoice` never called |
| AC4 · internal-auth then tenant-context, both `onRequest` | `BU115`, `BU116`, `BU120` | `BU115` reddens under M-1; **`BU116` is the only one that observes hook *order*** (a doubly-invalid request answers `UNAUTHORIZED`, not `TENANT_CONTEXT_MISSING`) — I reproduced this live as A11/A12 |
| AC5 · no `Prisma.Decimal`, no `Date` escapes | `BU111`, **`BI33`** | `BI33` asserts **below HTTP**, which is the only level that can see it; re-derived above |
| AC6 · `tenantId`/`invoiceId` never on the wire | `BU108`, `BU119` | `BU108` reddens under the re-route; confirmed against a **real body** by raw string scan |
| AC7 · repeated `metricKey`, deterministic order | `BU110`, **`BI31`** | driven through `createDraftInvoice` + `absorbLateUsage`; order stable across 3 `UPDATE` rounds while heap order moved |
| AC8 · line items reachable only via the `Invoice` relation | **`BU109`**, `BI30` | **the strongest case in the diff** — `BU109` reddens on *any* `tx.invoiceLineItem` touch, `BI30` on the leaking form, and I captured the leaked body |

**No tautological tests found.** `BU109` in particular asserts an absence (`not.toHaveBeenCalled`)
that a real mutation violates, which is the shape `.claude/rules/testing.md` asks for. The
repository unit file's `firstArg(...)` helper throws when the call is missing, so the shape cases
cannot pass vacuously — checked by reading it.

---

## Observations — not defects, recorded for the record

**O-1 · The `readLineItems` tie-break is currently unfalsifiable.** Reverting it leaves 36/36 green
over 3 runs (I measured). It is a correct defensive change, and its docblock says so honestly and
scopes the claim ("not a proof that no future caller can be disturbed"). Recorded so nobody deletes
it later on the evidence that deleting it is green — the same hazard S-28 exists for.

**O-2 · Trailing zeros are dropped on the wire, and no test pins that.** `String()` on a
`Prisma.Decimal` normalises: stored `10.500000` serves as `"10.5"`, `4.000000` as `"4"`,
`42.000000` as `"42"`. Numerically lossless, and **identical to `totalAmount`'s pre-existing
T-046 behaviour**, so it is a platform convention rather than something T-047 introduced. But the
wire form is not the stored form, and `BI33`'s fixture is a full-width value that does not
exercise the trailing-zero case. A client that string-compares against a stored value will be
surprised. Worth one sentence in the response contract; not worth a code change.

**O-3 · An uppercase UUID is accepted by the validator and then missed by the column.** Measured
(A9): tenant A asking for **its own** invoice with the id uppercased gets `404`. `uuidSchema`
guarantees shape and not case, and PostgreSQL text comparison is case-sensitive. Not a leak — the
`404` is the same byte-identical body — and **pre-existing**: `tenantIdSchema` is the same
acceptance set, so an uppercased `X-Tenant-Id` has always produced platform-wide misses. Candidate
for `.claude/rules/known-gaps.md` if anyone wants the shared schema to lower-case, which is a
platform decision and not this task's.

**O-4 · S-22 fired during the mandated gate.** `pnpm test` wrote **3** TTL'd `denylist:*` keys into
**Redis db 0**, alongside the production `telemetry:events` stream (2 entries, no TTL). Reported
rather than cleaned, per the brief: `redis-cli -n 0 DBSIZE` went 4 → 2 during the session as they
expired on their own (TTLs observed at 845 s, 221 s, 146 s). `telemetry:events` was not touched.
This is exactly the latent hazard S-22 records, observed live.

**O-5 · `InvoiceLineItem` still has exactly one index.**
`CREATE UNIQUE INDEX "InvoiceLineItem_pkey" … (id)` — nothing on `invoiceId`. At the row counts
this environment holds, a `Seq Scan` is the correct plan and proves nothing about volume. The plan
carries this as risk R3 with the measurement that would settle it. Unchanged and not a T-047
defect; flagged so it is not forgotten when invoices accumulate.

---

## Regression risk across the other 12 packages

**Low.** The diff is confined to `apps/billing-service` plus `.claude/rules/known-gaps.md`, and
touches no shared package, no Prisma schema, no migration.

- **No shared-package surface changed.** `packages/shared-validation`'s `uuidSchema` is *consumed*
  by the new validator, not modified — `git status` shows no `packages/` file in the diff. Its 15
  tests are green and its behaviour was independently re-measured above.
- **No schema or migration change.** `prisma/schema.prisma` is not in the diff; `v1_7` remains the
  head migration and is applied. So worker, usage, auth and analytics see an unchanged database
  contract.
- **The new route is registered inside the existing guarded scope**, not on the root instance.
  `BU120` and `BU83` both assert that `/health` and `POST /v1/internal/billing/generate` still
  answer without a tenant header — and M-3's mutation shows what it costs if that ever moves
  (26 cases across 6 files). Gateway proxies `/v1/billing` to this service and is unaffected: the
  header contract (`x-tenant-id`, `x-internal-secret`) is unchanged.
- **`integration.fixtures.ts` is shared within billing only.** `seedInvoices` gained an *optional*
  `id` and *optional* `lineItems`; the readable default id is preserved, so T-046's and S-45's
  cases are byte-unchanged in behaviour — confirmed by 0 removed assertions and by the 3× 36/36
  tie-break revert.
- **`BILLING_ROUTES.INVOICES` is now derived from a shared `INVOICES_PATH` const** rather than
  written inline. Value-identical (`/v1/billing/invoices`), and T-046's route tests are green.
- All 11 other packages' suites are at their expected totals, twice.

**One forward-looking risk, already recorded:** `findDetailById`'s safety rests on
`@prisma/client` 6.19.3 emitting **two** statements for a nested relation select and skipping the
second when the parent matches nothing. That is a client behaviour, not a schema guarantee, and
`"InvoiceLineItem"` has no policy behind it. A Prisma major bump or enabling `relationJoins` must
re-measure the four rows in the method's docblock **before** landing. The docblock says exactly
this and scopes it correctly. `BU109` cannot catch that class of change, because the call surface
would not move — which the docblock also says.

---

## What I could not validate, and why

- **Timing as a side channel on the `404`.** I established the *structural* equality (identical
  statement count and query shape, byte-identical bodies and headers) but ran **no statistical
  timing study**. A host-level measurement here would be dominated by noise and would not
  generalise to production hardware. Stated as structural, not as "no timing difference exists".
- **The gateway → billing path end to end.** I exercised billing directly via `app.inject`. I did
  **not** stand up the gateway and drive a real proxied request with JWT-derived headers, so the
  gateway's strip-and-re-inject of `x-tenant-id` for this **new** route path is unverified by me.
  It is path-prefix based (`GATEWAY_PROXY_PREFIXES`) and the new route is under the existing
  `/v1/billing` prefix, so no gateway change was needed — but that is reasoning, not measurement.
- **Concurrency on the read path.** No concurrent-reader test was run. The endpoint is a
  single-statement read inside a transaction with no writes, so there is no interleaving to
  serialise; I judged a concurrency probe to have no failure mode to find here. (Contrast S-38,
  which is about the *write* path and remains open.)
- **`S-10` itself is not closed and was not expected to be.** `InvoiceLineItem` RLS stays inert.
  `BI9` and the new `BI32` are the standing markers that turn red when it is fixed. I verified the
  `pg_class`/`pg_policy` state but did not attempt the migration.
- **Volume behaviour of the missing `invoiceId` index (O-5).** Measured at ≤ 3 rows only, where a
  `Seq Scan` is correct. No conclusion drawn about scale.
- **`@telemetry/web` contributes no test evidence.** It builds (13/13) and has no suite, so the
  "944 green" figure says nothing about it. Unchanged by this diff.

---

## Environment hygiene

Every fixture I created was removed and the baseline re-counted at the end:

| Table | Baseline at start | At end |
|---|---|---|
| `Tenant` | **2** | **2** |
| `Event` | 0 | 0 |
| `UsageLine` | 0 | 0 |
| `Invoice` | 0 | 0 |
| `InvoiceLineItem` | 0 | 0 |
| `Meter` | 0 | 0 |

The two surviving tenants are the **S-20 residue** and were left untouched — both are `Acme Inc`
with users under `@auth-integration-<uuid>.test` domains carrying **two different** uuids
(`…a90cd587…` and `…2b860f1d…`), exactly the two-prior-runs signature S-20 records. **No drift from
the stated baseline was found.**

- 5 `telemetry*` roles intact; `v1_7_worker_billing_enumerator` applied. Nothing rolled back, no
  role dropped.
- All seeding went through `DIRECT_DATABASE_URL`; no running service was pointed at it.
- Redis: db 0 not written by me (my probe app used db 15, which ends at `DBSIZE 0`);
  `telemetry:events` intact at `XLEN 2`. The db-0 residue is the gate's own — see **O-4**.
- Postgres and Redis left running.
- Billing tree re-checksummed after every mutation: **58/58 `OK`, 0 mismatches**.
- `git status --porcelain` at the end is byte-for-byte the T-047 set it was at the start.
  Nothing staged, committed or branched.

---

## Decision for the user

### Do the three stale-count corrections land before the commit?

All three are text-only. None changes behaviour, none moves a test count, and the gate does not
catch any of them.

| Option | What changes | Cost |
|---|---|---|
| **A · Fix all three now** | `.claude/rules/known-gaps.md:2764` `12 → 13`; `:2828` `733 → 740`; `docs/plans/…:454` `196 passed (205) → 198 passed (207)` | three one-token edits; re-run lint only |
| **B · Fix only F-1** | just the `.claude/rules/` count | one edit; leaves a stale line number and a stale plan figure in the commit |
| **C · Ship as-is, record as a known gap** | no diff change; a new entry noting the three | no edit now; adds a 42nd gap entry about three typos |

**Recommended: A.** It is three tokens. More to the point, **S-33 — which this very diff cites and
which S-47/S-48 are written in the style of — exists because counts go stale inside the commit that
invalidates them**, and all three of these are that exact failure: F-1 and F-3 were both made wrong
by M-2's own rework, and F-2 by the docblock the rework grew. Shipping them would put three fresh
instances into the file that catalogues the pattern. C is the weakest option: it spends a permanent
gap id on something a `sed` fixes.

**Only A and B change the diff; C does not.** None of the three changes any code, so whichever is
chosen, the 13/13 gate result and the 944/207 totals above still stand — they were measured on the
tree as it is now.

---

## Release readiness

**Ready**, subject to the decision above and to the Gate-6 final review.

The security property this endpoint exists to get right — that a table with no RLS is protected
entirely by the application route — is the strongest-evidenced part of the change. It is guarded at
two layers, both of which I broke deliberately and watched go red, and the response contract
(eight header fields plus five line-item fields, no `tenantId`, no `invoiceId`, full `Decimal(18,6)`
width, deterministic order, a `404` that is not an oracle in body, headers or statement count) holds
against every vector I could construct.

**PASS.**
