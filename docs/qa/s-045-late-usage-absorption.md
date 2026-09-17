# QA — S-45 · late-usage absorption (billing-service)

**Gate**: 5 (QA Tester) · **Tree**: `07ed02a` + S-45 uncommitted · **Verdict**: **PASS**

Independent validation. The plan and the Gate-4 review were read for *claims to test*, not as
evidence; every number below was re-derived here. `CLAUDE.md` forbids reading `docs/plans/` as
evidence of completion, and nothing in this report rests on it.

---

## 1. Verdict

**PASS.** The money path is correct against a live database under a real service, and it is
correct for the right reasons — proven by reproducing the original defect on the same harness and
watching the three load-bearing values diverge. No blocking defect. One **LOW** documentation
defect (D-1), in an authoritative file, and three coverage gaps recommended for
`.claude/rules/known-gaps.md`.

Release-ready.

---

## 2. Environment baseline — as specified, and it is S-20's live hypothesis

Checked **before** anything ran:

```
Tenant|2   Event|0   UsageLine|0   Invoice|0   InvoiceLineItem|0   Meter|0
User|2     RefreshToken|0
```

The two `Tenant` rows are the S-20 orphans, and this run **confirms S-20's mechanism rather than
merely matching a count**. Both carry `@auth-integration-<uuid>.test` owner e-mails and the two
uuids **differ** — `…-2b860f1d-…` and `…-a90cd587-…` — i.e. two prior runs each leaking one row,
which is exactly what S-20 predicts and not something a single leak could produce. Reported, not
cleaned up, per instruction.

Redis db 0 held one key at start (`telemetry:events`, `XLEN 2`) — pre-existing. After the mandated
gate it held two: a TTL'd `denylist:4aa9e3f1…` written by auth-service's suite (**S-22**, `TTL 845`
when observed). It self-expired; db 0 is back to `1` at the end. Reported rather than rounded to
green. dbs 13/14/15 were `0` throughout.

**Final state, re-counted after all work:** `Tenant 2` (the *same two ids*), the five tables `0`,
Redis db 0 back to `1`, `v1_7_worker_billing_enumerator` applied, all five `telemetry_*` roles
present. Working tree byte-identical to the start — `git diff | md5sum` =
`77f2c508382584cc0eb411ef71274aa2` before and after, 13 modified + 2 untracked, nothing staged,
committed or branched.

---

## 3. Gates — all 13 packages, `--force`, per package

`npx turbo run <task> --force` throughout (`pnpm build -- --force` does not forward the flag).
`Cached: 0 cached, 13 total` on every run, so nothing was replayed.

| Gate | Result |
|---|---|
| `typecheck` | **13 successful, 13 total**, 0 cached, 19.7s |
| `lint` | **13 successful, 13 total** — 0 errors, **14 warnings** |
| `build` | **13 successful, 13 total**, 0 cached, 22.1s |
| `test` | **13 successful, 13 total**, 0 cached |
| `pnpm test:smoke` | exit 0 — 6 services, 1 test each, all passed |

### Test totals per package — twelve report, `@telemetry/web` contributes 0

| Package | Files | Tests |
|---|---|---|
| `@telemetry/shared-types` | 1 | 8 |
| `@telemetry/shared-config` | 1 | 4 |
| `@telemetry/shared-validation` | 1 | 15 |
| `@telemetry/shared-tracing` | 1 | 2 |
| `@telemetry/shared-logger` | 1 | 4 |
| `@telemetry/shared-utils` | 1 | 18 |
| `@telemetry/analytics-service` | 4 | 18 |
| `@telemetry/gateway` | 8 | 38 |
| `@telemetry/usage-service` | 19 | 230 |
| `@telemetry/auth-service` | 15 | 166 |
| **`@telemetry/billing-service`** | **17** | **181** |
| `@telemetry/worker-service` | 17 | 234 |
| `@telemetry/web` | — | **0** (`vitest run --passWithNoTests`, no test files) |
| **Total** | | **918** |

Billing **181** and root **918** — both as briefed.

### The 14 lint warnings are pre-existing — proven, not asserted

Zero `no-unsafe-return` (`grep -c` on the lint log → `0`).

| Count | Rule | File | `git log -1` |
|---|---|---|---|
| 10 | `@typescript-eslint/no-misused-promises` | `apps/auth-service/tests/auth.service.unit.test.ts` | `d68e719` 2026-08-25 |
| 4 | `@typescript-eslint/no-unsafe-assignment` | `apps/usage-service/tests/ingestion.service.unit.test.ts` | `b0f6921` 2026-08-31 |

Neither file appears in `git status --porcelain` for this change, so neither can have been touched
by it. 10 @ `d68e719` and 4 @ `b0f6921`, exactly as briefed.

---

## 4. Priority 1 — the money path, driven for real

**Harness: the real billing-service as a real process**, `npx tsx src/index.ts` on port 3914,
`DATABASE_URL` = `telemetry_app` (`rolsuper = f, rolbypassrls = f`, verified in `pg_roles`), driven
over HTTP with `curl`. Fixtures seeded and asserted through `DIRECT_DATABASE_URL` (owner) with
`psql` — a different connection from the one under test. No vitest involved in §4; these are
independent probes, not a re-run of the suite.

### 4.1 The fix works, and it is not vacuous

Tenant `…45a1`, meter `api.request` @ `0.500000`, window `[2026-09-15, 2026-09-16)`.

| Step | Response | `Invoice.totalAmount` | line items | late row `billed` |
|---|---|---|---|---|
| seed 10 + 15 units, generate | `201` `absorbed:false` | `12.500000` | 1 | — |
| insert late row (4 units) **after** the invoice exists, generate | `200` `absorbed:true` | **`14.500000`** | **2** | **`true`** |

The rise is exactly `4 × 0.5 = 2.000000`. `invoice_count` stayed `1`.

**Non-vacuity, established by reproducing the defect on the same harness.** I restored `07ed02a`'s
early return into `billing.service.ts`, restarted the service, and re-ran the same scenario on a
fresh window:

```
generate 1 -> 201 {"data":{"invoiceId":"946fc40b-…","absorbed":false}}
generate 2 -> 200 {"data":{"invoiceId":"946fc40b-…","absorbed":false}}   <- late row present
total=3.000000   UL qa45-ul-d1 billed=true   UL qa45-ul-d2 billed=false   lineitems=1
```

The **status, the `invoiceId` and the invoice count are identical** to the fixed run — which is
precisely the vacuity S-45 warned about. Only `UsageLine.billed`, `Invoice.totalAmount` and the
line-item rows separate them, and those are what every assertion above is on.

**The suite catches it too.** With that same mutation on disk,
`billing.integration.test.ts` → `Tests 4 failed | 26 passed (30)`: `BI22`, `BI23`, `BI24`, `BI26`.
Mutation reverted; `md5sum` back to the pre-mutation value.

### 4.2 Absorb twice — append semantics, and what the invoice looks like

A second late arrival (7 units) into the same window:

```
total: 12.500000 -> 14.500000 -> 18.000000
InvoiceLineItem: api.request qty 25 amt 12.500000
                 api.request qty  4 amt  2.000000
                 api.request qty  7 amt  3.500000
lineitem_count=3   sum_amounts=18.000000   (equals the invoice total exactly)
unbilled=0
```

A fourth call with no new usage returned `200 absorbed:false` and changed nothing.

**What whoever renders it sees.** Three rows all keyed `api.request`, same `unitPrice`, different
quantities — one per tranche. That is D2 working as designed, and it is a faithful audit trail
rather than a defect. Two things make it low-risk *today*: nothing on the platform returns line
items at all (`INVOICE_HEADER_SELECT` excludes them structurally, and the T-046 list endpoint I
called returns only headers), and the amounts sum to the total exactly. The decision lands on
**T-047**, the first endpoint to return line items, and the repository docblock already carries
that forward reference. Confirmed rather than assumed.

### 4.3 Precision — and `{ increment }` proven to be SQL, not trusted

A `Decimal(18,6)` absorption: invoice seeded at `1234567.123456`, late row priced `0.000001`.

```
persisted=1234567.123457   expected=1234567.123457   match=true
```

**The `{ increment }` claim was verified behaviourally, not read off a query log**, because exact
arithmetic alone cannot distinguish SQL `numeric` from JavaScript `Prisma.Decimal` — both are
arbitrary-precision. The discriminator is a **lost update**:

1. owner connection: `BEGIN; UPDATE "Invoice" SET "totalAmount" = "totalAmount" + 100 …; pg_sleep(3); COMMIT;`
2. fire the absorb while the row is locked — it **blocked 2.1 s** (measured, `00.36` → `02.45`)
3. owner commits; absorb proceeds

```
final = 1234667.123459      (= 1234567.123457 + 100 + 0.000002)
```

A read-modify-write would have produced `1234567.123459`, silently discarding the concurrent
`+100`. It did not. So the addition is evaluated by PostgreSQL against the post-commit row —
D4 holds, **and so does its stronger claim that `increment` "does not race a concurrent
absorber"**, which nothing in the suite exercises.

**The served value is a string.** Raw body from `GET /v1/billing/invoices`:

```
"totalAmount":"18"   "totalAmount":"1234567.123457"
```

Quoted — so no `Prisma.Decimal` reached the wire (where `toJSON` would have hidden it), and full
`Decimal(18,6)` precision survives to the client. Note `18.000000` serialises as `"18"`:
`toAmountString` is `String(value ?? 0)` and drops trailing zeros by design. Pre-existing
normalisation, not introduced here, but worth knowing before a UI compares spellings.

### 4.4 The `409` path — nothing written

`FINALIZED` invoice seeded through the owner connection (no production path produces that status),
plus one unbilled late row:

```
409 {"code":"INVOICE_IMMUTABLE","message":"Invoice is not a draft and cannot absorb late usage (status FINALIZED)"}
total=50.000000 (unchanged)   lineitems=0   ul billed=false
```

Billing's `warn` line carried `invoiceId` and `currentStatus`, which is divergence E1 working as
designed — the epic puts them in the body, this service puts them in the log.

### 4.5 Atomicity, live — my own variant, harder than `BI27`

`BI27` flips a row **before** the call. I forced the competing write **inside** the absorb
transaction's window instead, using a row lock:

1. owner: `BEGIN; SELECT … FROM "Invoice" … FOR UPDATE; pg_sleep(2); UPDATE "UsageLine" SET billed=true WHERE id='…at1'; COMMIT;`
2. absorb fires, blocks on the locked invoice row
3. owner's flip commits mid-flight; absorb resumes, increments, nests the create, then
   `markUsageLinesBilled` sees 1 of 2

```
409 USAGE_LINES_CHANGED "… nothing was written (expected 2, marked 1)"
total=10.000000 (unchanged)   lineitems=0
UL …at1 billed=true   <- the concurrent writer's own commit, correctly NOT undone
UL …at2 billed=false  <- absorbable on the next attempt
```

**And the rolled-back writes provably executed**, rather than the code short-circuiting earlier.
PostgreSQL's tuple statistics count rolled-back writes, so re-running the race with
`pg_stat_user_tables` sampled either side:

```
InvoiceLineItem n_tup_ins  4251 -> 4252   (+1)
Invoice         n_tup_upd   194 ->  195   (+1)
committed state: total=10.000000, lineitems=0
```

The increment and the nested `create` physically ran and were undone. **AC2 is proven live.**

### 4.6 Concurrency — not in the suite, and it is safe

Four genuinely simultaneous `generate` calls against one invoice (`100.000000`, 20 units unbilled):

```
1 x 200 {"absorbed":true}
3 x 409 USAGE_LINES_CHANGED "… nothing was written (expected 2, marked 0)"

total=110.000000   lineitems=1 sum=10.000000   both rows billed
```

Exactly one absorption, no double-billing, no partial write. The invoice row lock serialises the
absorbers and the cross-chunk count assertion rejects the losers. Reported as a **verified
strength with no standing guard** (§7).

---

## 5. Priority 2 — the nightly job end to end

**Real** `runInvoiceGenerationJob`, **real** `BillingEnumerationRepository` (as
`telemetry_worker_app`), **real** `BillingClientService`, against the **real** billing-service on
3914, at a pinned `now = 2026-07-11T02:00:00.000Z`. Harness file created under
`apps/worker-service/`, used, and **deleted** — `git status` is clean of it.

| Pass | Summary | Per-tenant log | DB |
|---|---|---|---|
| 1 | `tenants:1 succeeded:1 failed:0` | `created:true` | invoice `10.000000`, row billed |
| late row inserted (8 units) | | | |
| 2 | `tenants:1 succeeded:1 failed:0` | `created:false` | **`14.000000`, 2 line items, late row billed** |

**The late usage is recovered end to end by the real job.** The enumeration lists the tenant again
because the late row is unbilled, and billing absorbs it.

### Is an absorption discoverable in practice?

**Yes — but only in billing-service's logs, and never in the job's summary.** Stated precisely:

- **Worker's summary is identical either way.** `{tenants:1, succeeded:1, failed:0}` on pass 1
  (creation) and pass 2 (absorption). An operator watching only the nightly summary sees nothing.
  This is Gate-2 decision 1 working as decided, and residual 1 records it.
- **Worker's per-tenant line carries `created:false`**, which within this job is a *near*-proxy for
  an absorption — the enumeration only lists tenants holding unbilled rows, so `created:false`
  means "had unbilled usage and an invoice already existed". It is a proxy, not a signal: it also
  covers the race where another writer billed the rows in between, and it does not say how much.
- **Billing's own log is the real signal, and it is `info`**, so it is emitted at the default
  `LOG_LEVEL`:

```
{"level":"info","service":"billing-service","tenantId":"…","invoiceId":"…","lines":1,
 "usageLines":1,"delta":"4","totalAmount":"14","msg":"Absorbed late usage into an existing invoice"}
```

  The no-op path logs at `debug`, so at `info` the *presence* of that line is a clean discriminator.

So: **discoverable, but only by correlating two services' log streams**, and invisible to anyone
watching the job. Not invisible in the strong sense; not surfaced where the operator is looking.
That is the accepted D5 residual, and I confirm it is accurately described rather than understated.

### Consumer contract — re-derived against a real response, not by reading the cast

Pass 2's job consumed a live `200 {"data":{"invoiceId":"…","absorbed":true}}` from the real
service through the real `BillingClientService` and reported `succeeded:1, failed:0` with
`created:false`. The added field is ignored and non-breaking — measured on the wire, not inferred
from `(await response.json()) as GenerateInvoiceResponseBody`.

### Residual 5 (LOW-3) confirmed live, and it is sharper than recorded

An unmetered late `metricKey` in an already-invoiced window:

```
422 {"code":"METER_NOT_FOUND","message":"No active meter for metric keys: unmetered.metric"}
invoice untouched (14.000000), row unbilled
job -> {"tenants":1,"succeeded":0,"failed":1}
     -> "billing-service rejected the invoice request: 422: METER_NOT_FOUND"
```

Residual 5 is accurate. Two consequences it does **not** state — see gap G-1.

---

## 6. Priority 3 — the rework's claims, re-performed

Every mutation applied to `src/` (or the test file), suites run, reverted, and the file
re-`md5sum`ed back to its pre-mutation value. All counts below are **mine**, on the shipped tree.

### 6.1 Both isolation mutations — confirmed at 28 / 2, second failure `BI27`

| Mutation | `billing.integration.test.ts` | `invoice.repository.unit.test.ts` |
|---|---|---|
| **B** · `invoiceId` param + line items via `tx.invoiceLineItem.create` | **28 passed / 2 failed** — `BI25`, `BI27`. **`BI24` green** | **`BU99` red**, 1 failed / 26 passed |
| **C** · `invoiceId` param, `findUniqueOrThrow`/`update` on `{ id }` | **28 passed / 2 failed** — `BI25`, `BI27`. **`BI24` green** | **`BU98` red**, 1 failed / 26 passed |

Both failures in each case are `BI25` and `BI27`, the two direct repository callers, failing to
type-match — not isolation outcomes. Matches the rework exactly, including that the pre-`BI27`
28/1 in the review is superseded.

### 6.2 `BI27`'s three value assertions each fail independently — all three re-performed

Atomicity removed (`markUsageLinesBilled`'s throw disabled) and `BI27`'s `rejects` assertion
relaxed to `resolves`, then each value assertion neutralised in turn:

| Pinned | Verbatim failure |
|---|---|
| 1 · total | `expected '16.5' to be '12.5'` |
| 2 · line-item count | `expected [ …, …, … ] to have a length of 2 but got 3` |
| 3 · `billed` | `expected true to be false` |

All three match the claim verbatim. Separately, with the atomicity mutation alone and the `rejects`
assertion **intact**, `BI27` fails at `promise resolved "{ …(2) }" instead of rejecting` — so the
case guards the throw *and* the three values.

### 6.3 MEDIUM-2's three counts — all three confirmed, package-wide

Package-wide runs (`pnpm --filter @telemetry/billing-service test`, 181 cases):

| Mutation | Result | Named cases |
|---|---|---|
| `{ increment }` → `{ set }` | **5 failed / 176 passed** | `BU98`, `BI22`, `BI24`, `BI25`, `BI26` |
| DRAFT guard deleted | **2 failed / 179 passed** | `BU100`, **`BI23`** |
| D6 routing → plain return | **2 failed / 179 passed** | `BU50`, `BU94` — **`BU94b` green** |

All three exact (the review's `175 passed` was against a 180-case suite; 181 now). The
`BI23`-reddens claim is the load-bearing one — it is the evidence the owner-connection `FINALIZED`
fixture drives the branch rather than passing on the status alone — and it holds.

### 6.4 S-46 — held to the authoritative-file bar

Re-derived on the shipped tree:

| S-46 claim | My result |
|---|---|
| **A** · remove the tenant predicate entirely | integration **30 / 0**; unit 4 failed / 23 passed, **all four `… is not a function`** — mechanical, exactly as the entry says |
| **D** · drop the tenant from the *write* only, call surface kept | integration **30 / 0**; **`BU98` red**, `expected { Object (id) } to deeply equal { …(1) }`, 1 failed / 26 passed |
| `BU98` catches D *because* it asserts the `where` object's shape | Confirmed — the failure is on the `where` object, and the integration outcome is unchanged |
| `relrowsecurity` = `t` for 8 tables, `f` for exactly `InvoiceLineItem` and `RefreshToken` | Exact match, all ten named tables |
| `telemetry_app` is `rolsuper = f, rolbypassrls = f` | Confirmed |
| 4 subclasses via `export class` filter, 9 unfiltered | Confirmed — `UsageRepository`, `EventRepository`, `MeterRepository`, `InvoiceRepository` |

**It does not overclaim.** Checked specifically: it explicitly declines "every tenant-scoped query
carries its predicate" ("it is not asserted"), and it labels the extension to the other five
RLS-enabled tables as inference from the policy shape rather than measurement, naming the three it
did measure. Both hold. The severity argument (LOW) and the "what would make it MEDIUM" list are
sound. The S-10 and S-28 distinctions are correct.

One defect in it — **D-1** below.

### 6.5 MEDIUM-4 — citations confirmed, including the ones nobody asked about

`docs/epics/epic-8-billing-service.md:140` is `## T-048 · Invoice immutability guard`. The heading
is where the citations say.

I also checked the second half of the requirement — that nothing else in the diff cites a *line*
inside a file the diff edits. The diff edits `epic-8`, inserting 13 lines at `:143`. The two other
live citations into that file are **before** the insert and therefore unshifted, and both still
resolve:

- `billing-invoices.route.test.ts:178` → `epic-8:92` = `pageSize?: number; // default 20, max 100` ✓
- `docs/plans/s-045-…:124` → `epic-8:113` = `## T-047 · Invoice detail — GET /v1/billing/invoices/:id` ✓

No stale citation remains.

### 6.6 Structural claims in the repository docblock

- `grep -c "^  async"` → **6**; `grep -cE "^  (private )?async"` → **7**. Both exact, and the six
  named methods match the list.
- **No method takes a bare `invoiceId`** — `grep -nE "^  (private )?async .*invoiceId"` returns
  nothing. The property the plan says is the checkable one does hold.
- The `invoice.delete` grep returns **exactly one line: the comment itself**, which the comment
  correctly names as its own self-match (the S-33 trap, handled).

---

## 7. Defects

### D-1 · `.claude/rules/known-gaps.md` § S-46 — the revert-verification checksum is stale and cannot be re-derived — **LOW**

S-46 offers a command as the evidence that each mutation was cleanly reverted:

> `find apps/billing-service/{src,tests} -name '*.ts' | sort | xargs md5sum | md5sum` back to
> `b66221646429f79536053b3a13210ee2` after each

**Reproduction** — on the shipped tree, *before* I applied any mutation:

```
$ find apps/billing-service/{src,tests} -name '*.ts' | sort | xargs md5sum | md5sum
bd2e4678666dd45ecca842ad6f65a78e  -
```

`bd2e…`, not `b662…`. I re-ran it after all my mutations were reverted and got `bd2e…` again, and
every individual file matched its pre-mutation `md5sum`, so **nothing leaked** — the shipped tree
is clean. The claim is simply stale relative to what shipped: S-46 was written at Gate 4, and the
LOW-1/LOW-2/LOW-3 fixes to `integration.constants.ts` and `constants.ts` landed afterwards and
changed the hash.

**Why it matters enough to file.** `CLAUDE.md` designates `.claude/rules/` authoritative and tells
agents to trust it without re-verification. A future agent re-running that command to confirm a
clean revert will get `bd2e…`, conclude a mutation leaked, and go hunting. It fails noisily rather
than silently, which is why it is LOW and not higher — but it is exactly the shape **S-33** already
records ("measured claims in comments go wrong inside the commit that changes them"), inside the
file that records it, and S-33's own fix direction names re-runnable commands as the target.

**Fix**: replace `b662…` with `bd2e…`, or drop the hash and say "each file re-`md5sum`ed to its
pre-mutation value", which does not go stale. One line.

**No other defect found.** Nothing blocking. No correctness, isolation, precision, atomicity or
contract defect was found in the production change.

---

## 8. Coverage gaps — recommended for `.claude/rules/known-gaps.md`

### G-1 · An unmetered late row is a permanent poison pill for its whole window — **not stated in residual 5**

Residual 5 records that a re-run can answer `422` and that worker counts `failed: 1`. Two
consequences it does not state, both measured here:

1. **It recurs every night, permanently.** The unbilled row keeps the tenant in the enumeration,
   so the job re-calls, gets `422`, and counts `failed: 1` again — for ever, until someone adds a
   meter or removes the row. It is not a one-off.
2. **It blocks otherwise-valid late usage in the same window.** Measured: with one unmetered row
   *and* one perfectly valid `api.request` late row (12 units, worth `6.000000`) in the same
   window, the call is `422` and **neither** is billed — total stayed `14.000000`, both rows
   `billed=false`. `readAndPrice` prices the whole set or refuses it, so one unpriceable row holds
   the rest hostage.

**This is not a regression** — before S-45 both rows were equally unbilled, just silently, so no
money moves the wrong way and the direction is loud-not-silent, which is D1's own argument. What
changes is that the *fix's benefit* is blocked for that window and a tenant can fail every night.
Worth recording so the first operator to see it does not read it as a new bug.

### G-2 · The concurrency safety of the absorb path has no standing guard

§4.6 shows four concurrent absorbers produce exactly one absorption and no double-billing, and
§4.3 shows `{ increment }` survives a concurrent `+100`. **Neither property is covered by any
test.** They rest on the invoice row lock plus the cross-chunk count assertion — both of which a
future refactor could weaken (e.g. moving the count assertion per-chunk, which `BU27b` guards, or
replacing `increment`, which `BU98` guards *as a shape*, not as an outcome). The same S-38
objection applies to writing it — a naive `Promise.all` case can pass by serialising — so this is
recorded rather than demanded. The form that would work: assert the *final total*, which is wrong
if any absorber double-counts, regardless of interleaving.

### G-3 · `{ increment }`'s SQL-vs-JavaScript property is pinned only by a shape assertion

`BU98` asserts `{ increment }` appears in the Prisma call. That is a shape, not the behaviour — a
read-modify-write that happened to be written as `increment` on a stale read would still pass, and
`BI25`'s exactness cannot tell the two apart because `Prisma.Decimal` is also arbitrary-precision.
The discriminator is the lost-update probe in §4.3, which needs a concurrent locked writer. Not
demanded (it is ~3 s of wall clock and needs two connections); recorded so the property is known to
be unguarded behaviourally.

### G-4 · The `absorbed` flag's own no-op/absorb distinction is not asserted end to end at the job layer

Covered at the route (`BU102`, `BI3`/`BI8`) and verified by me over real HTTP. No test asserts that
worker's real client tolerates the added field — that is probe H in the plan and my §5
re-derivation, neither of which is standing. Low value to add given the cast, but it is the one
cross-service contract this change touches.

---

## 9. Regression risk across the other 12 packages

**Low, and bounded by one consumer.**

- `grep` for `internal/billing/generate`, `GenerateInvoiceResponseBody` and `absorbed` across
  `apps/*/src` and `packages/*/src` (excluding `dist/`) finds **exactly one** external consumer:
  `apps/worker-service/src/services/billing-client.service.ts`. It reads
  `body?.data?.invoiceId ?? null` through a **cast**, not a schema, so `absorbed` is ignored —
  re-derived against a real response in §5, not read off the cast.
- **Gateway is unaffected.** It proxies `/v1/billing` (the customer-facing list endpoint), not
  `/v1/internal/billing`. The list endpoint's response shape is unchanged — I called it and the key
  set is identical.
- **No schema change, no migration, no new grant, no new role.** `v1_7` is still the head; all five
  `telemetry_*` roles present and untouched.
- The change is confined to `apps/billing-service/**` plus two docs. The other 11 packages have no
  code path into it.
- All 12 reporting packages green at their stated totals, `--force`, uncached.

The one behavioural change that reaches another service is residual 5's `422` (§5, G-1) — it flows
into worker's `failed` counter by design, and worker's code did not need to change to handle it.

---

## 10. What I exercised · what I could not, and why

**Exercised:** all four gates `--force` across 13 packages + smoke; the money path over real HTTP
against a real service on `telemetry_app` (absorb, absorb-twice, no-op, `409`, `422`); the S-45
defect reproduced on the same harness; `Decimal(18,6)` exactness and the wire type; `{ increment }`
proven SQL-side by lost-update; live atomicity with the failure forced *inside* the transaction,
plus tuple-statistics evidence the writes ran; 4-way concurrency; the real nightly job twice,
end to end, plus its `422` arm; both isolation mutations; all four S-46 mutations; all three
MEDIUM-2 counts; all three `BI27` assertions; every S-46 database and grep claim; the MEDIUM-4
citations and the two the brief did not name; the repository's structural docblock claims.

**Could not exercise, and why:**

- **A genuine `P2002` insert race (D6 / S-38).** Unchanged — S-38 is explicitly not closed, and its
  own warning is that the obvious `Promise.all` case passes by serialising. D6's arm has unit
  coverage only (`BU94`). I did not attempt it; my §4.6 concurrency probe exercises the *absorb*
  race, not the *insert* race, and must not be read as covering it.
- **Index coverage at volume (D7 / R7).** The tables are empty; no `EXPLAIN` at production volume
  was run. The plan and the docblock both decline to claim it, correctly, and I make no claim
  either.
- **S-10's line-item RLS.** Not fixed and not in scope; `"InvoiceLineItem"` still has
  `relrowsecurity = f` and zero policies (re-confirmed). The application route remains the entire
  tenant control on that write, which is what the code and comments say.
- **Multi-instance / pooled deployment.** Everything here ran against one billing-service process
  and one PostgreSQL. A connection pooler that loses the transaction-local `set_config` is S-46's
  named MEDIUM trigger and was not simulated.
- **`pnpm format:check`.** Not run — S-12 records that no revision of this repository has ever
  passed it and that CI does not run it.

---

## 11. Decisions for the user

### Q1 · D-1, the stale checksum in S-46 — fix now or record it?

| Option | What changes |
|---|---|
| **A · Fix it in this commit** *(recommended)* | One line in `.claude/rules/known-gaps.md`: `b662…` → `bd2e…`, or replace the hash with "each file re-`md5sum`ed to its pre-mutation value". **Changes the diff** (one line, docs only). No re-gate needed — no code touched. |
| B · Record it as its own known-gaps entry | Leaves a knowingly unre-derivable command in an authoritative file, which is the thing S-33 exists to stop. **No diff change.** |
| C · Leave it | Next agent re-runs it, gets `bd2e…`, hunts a leak that is not there. **No diff change.** |

**Recommended: A.** It is one line in a file the diff already edits, it is docs-only, and the wording
option ("re-`md5sum`ed to its pre-mutation value") cannot go stale again — which is S-33's actual fix
direction applied rather than restated.

### Q2 · G-1, the poison-pill amplification — record it, or leave residual 5 as is?

| Option | What changes |
|---|---|
| **A · Extend residual 5 with the two measured consequences** *(recommended)* | ~3 sentences in S-45's residual 5: it recurs nightly and permanently, and one unpriceable row blocks all other late usage in that window. Both measured in §5/G-1. **Changes the diff** (docs only). |
| B · Mint a new gap id | Heavier; the finding belongs to residual 5's subject, and this file's id-stability rule makes new ids expensive. **Changes the diff.** |
| C · Leave it | Residual 5 stays true but understated; the first operator to hit a permanently-failing tenant re-derives it. **No diff change.** |

**Recommended: A.** It is the same subject, already half-recorded, and the missing half is the part
with revenue consequence.

Both are **documentation only**. Neither blocks the commit, and neither affects the PASS.

### Q3 · G-2/G-3/G-4, the unguarded properties — do they get tests?

| Option | What changes |
|---|---|
| **A · Record all three in known-gaps, write none** *(recommended)* | Follows the S-21/S-38 precedent — a verified behaviour worth *knowing you do not guard*. **Docs only.** |
| B · Add a concurrency case for G-2 | One integration case asserting the final total after N concurrent absorbers. Must be confirmed red with the count assertion removed, or it is decoration. **Changes the diff** (~25 lines, adds wall clock). |
| C · Add G-2 and G-3 | B plus a locked-writer case; ~3 s of real wall clock and two connections, pushing against the per-case budget. **Changes the diff.** |

**Recommended: A.** All three properties are *verified correct today* in this report; what is
missing is regression protection, and S-45's scope is already at its edge. B is defensible if the
money invariant is judged to warrant a standing concurrency guard — that is a judgement call about
risk appetite, not a correctness question.

---

## 12. Release-readiness

**Ready.** The revenue defect S-45 describes is closed and demonstrably closed — the fix was driven
against a live database through a real service, and the defect was reproduced on the same harness to
prove the assertions are not vacuous. The money invariant (AC2) holds under a mid-transaction
failure, with tuple-statistics evidence that the rolled-back writes actually executed, and under
four-way concurrency. Precision is exact at the `Decimal(18,6)` boundary and the wire value is a
string. The `409` and `422` arms write nothing. All 13 packages pass all four gates uncached, with
exactly the 14 pre-existing lint warnings and zero `no-unsafe-return`. The only cross-service
contract change is additive and was re-derived against a real response.

One LOW documentation defect (D-1) and four coverage gaps, none blocking. Gate 6 and the CI
validation gate can proceed.

Database and Redis left as found; nothing staged, committed or branched.
