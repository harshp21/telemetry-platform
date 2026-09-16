# T-046 · Invoice list — `GET /v1/billing/invoices` — Senior Review

**Service**: billing-service · **Plan**: `docs/plans/t-046-invoice-list-endpoint.md`
**Base**: `ed670b3` (T-045) · nothing committed or staged at review time.

---

## Round 1 — pre-QA (Gate 4)

**Verdict: CONDITIONAL.** Tenant isolation, injection surface, the hook-ordering contract, the
`Decimal`/`Date` boundary and the encapsulated scope all re-derived by execution and all hold.
Every required fix below is a *claim-accuracy* or *test-coverage* item; none changes behaviour,
and none is a security defect. Two of them need a choice from you (§ Decisions).

### Findings

#### MEDIUM-1 · A self-verifying count in the tenant-isolation docblock is now wrong

`apps/billing-service/src/repositories/invoice.repository.ts:154` states, of the class docblock's
third invariant: *"checkable, and checked: `grep -n "^  async" invoice.repository.ts` lists **four**
signatures and none has one"*.

Re-ran that exact command on the reviewed tree — it lists **five**:

```
181:  async tenantExists(   197:  async findByPeriod(   221:  async sumUnbilledByMetricKey(
262:  async createDraftInvoice(   355:  async listInvoices(
```

T-046 added the fifth and did not update the count. The *substance* survives (I checked all five:
none takes a bare `invoiceId`, none takes a `tenantId`), but the line invites the reader to run a
command that now contradicts it, in the one docblock that carries this repository's tenant-isolation
argument. The text is pre-existing (`git diff` does not touch it) — but T-046 is what falsified it,
so it is this task's to correct.

**Fix**: `invoice.repository.ts:154` — `lists four signatures` → `lists five signatures`.

#### MEDIUM-2 · "cannot be implemented against that constraint" is refuted by the compiler

`apps/billing-service/src/repositories/invoice.repository.ts:70-72`:
*"The epic's declared `findById(id, tenantId)` and `update(id, tenantId, data)` signatures **cannot
be implemented** against that constraint."* Same wording in the plan at
`docs/plans/t-046-invoice-list-endpoint.md:363` (*"which `where`'s `{ tenantId?: never }` constraint
now rejects"*).

Measured with two probes (temporary file, both removed; `pnpm --filter @telemetry/billing-service
typecheck`):

- **Probe A** — a subclass declaring `async findById(id: string, tenantId: TenantId)` that calls
  `this.where({ id })` and ignores the parameter: **compiles, zero errors.** The signature is
  implementable; TypeScript has no objection to an unused parameter.
- **Probe B** — the same method calling `this.where({ id, tenantId })`:
  `error TS2322: Type 'TenantId' is not assignable to type 'undefined'.`

So the constraint rejects *feeding the parameter into `where`*, not *declaring* it — and the error
code is **TS2322**, not the TS2345 this diff's other type claim cites. The practical guidance
("identifiers in, tenant from context") is right; the universal is not, and it is the kind that
T-047/T-048's author will act on.

**Fix**: `invoice.repository.ts:70-72` and `docs/plans/…:363` — say what was measured, e.g.
*"the epic's signatures compile; what `where<T extends { tenantId?: never }>` rejects is passing
that parameter into `this.where(...)` (TS2322). Declaring it and discarding it is legal, which is
why this is a convention the shape enforces at the call site, not a type-level impossibility."*

#### MEDIUM-3 · The `id` tie-break's *behavioural* case does not catch its removal (S-21 shape)

`apps/billing-service/tests/invoice.repository.unit.test.ts:524` claims *"BI16 is the case that
observes the consequence; this pins the mechanism."*

**Mutation run**: deleted `{ [SORT_FIELD_ID]: desc }` from `INVOICE_LIST_ORDER_BY`
(`invoice.repository.ts:110`), full billing suite:

```
× InvoiceRepository.listInvoices > BU74c — expected [ { periodStart: 'desc' } ] to deeply equal [ { periodStart: 'desc' }, …(1) ]
  Test Files  1 failed | 15 passed (16)      Tests  1 failed | 156 passed (157)
```

**BI16 stayed green.** With three rows (two sharing `JAN_START`) on PostgreSQL 16, the sort is
stable enough in practice that the page-union assertion never separates. So the tie-break is pinned
**only** by BU74c's structural `orderBy` assertion, not by the behavioural case the comment names.
This is exactly `.claude/rules/known-gaps.md` S-21: a guard whose regression suite exercises a
different guard. The protection is not absent — BU74c does go red — but the recorded rationale is
false, and the next person to "simplify" the unit assertion will believe BI16 has them covered.

The hedged wording in the BI16 body (`billing.integration.test.ts`, *"may land on both pages or on
neither"*) is defensible; the unhedged sentence at `invoice.repository.unit.test.ts:524` is not.

**Fix**: see Decision D-A.

#### MEDIUM-4 · `BillingController` has no unit test; three error branches are unexercised

`apps/billing-service/src/controllers/billing.controller.ts` has no `*.controller.unit.test.ts`,
and no test in the package reaches:

- `:44-49` — the `if (!tenantId)` guard → `400` + `MESSAGE_TENANT_CONTEXT_REQUIRED`
  (`grep -rn MESSAGE_TENANT_CONTEXT_REQUIRED apps/billing-service --include=*.ts` returns the
  constant, the `dist` copy and the one call site — no test).
- `:56-61` — `error instanceof AppError` → the error's own status/code.
- `:66-76` — the 500 branch, which is the *"says nothing about the failure"* contract.

The service's own precedent is explicit: `tests/internal.controller.unit.test.ts` covers precisely
these for the sibling controller (BU57 "surfaces an AppError with its own status, code and message",
BU59 "answers 500 for an unexpected failure, logging it and leaking nothing"). `.claude/rules/
testing.md` asks for error paths to be tested; T-046's controller is the outlier.

Mitigation, measured rather than assumed: mutation B (routes moved outside the scope) showed the
`!tenantId` branch *does* fire — the unguarded route answered `400`, not the `200` the plan
predicted — so the branch works. It is untested, not broken.

**Fix**: see Decision D-B.

#### LOW-1 · "forced rather than stylistic" is true only under its own premise

`apps/billing-service/src/app.ts:72`: *"**Both hooks are `onRequest`, and that is forced rather than
stylistic.**"*

Re-derived at fastify 5.10.0 (standalone probe, seven configurations; hook names pushed to a shared
array, guard reproduced as billing's un-`return`ed `reply.status(401).send(...)`):

| Config | request | run order |
|---|---|---|
| auth `preHandler`, tenant `onRequest`, auth registered first | valid tenant, no secret | `["tenant","auth"]` |
| same, tenant registered first | valid tenant, no secret | `["tenant","auth"]` |
| **both `onRequest`, auth first** (shipped) | no headers | `["auth"]` |
| both `onRequest`, auth first | good secret, no tenant | `["auth","tenant"]` |
| both `onRequest`, auth first | fully valid | `["auth","tenant","handler"]` |
| both `onRequest`, **tenant first** | no headers | `["tenant"]` |
| **both `preHandler`, auth first** | no headers / good secret / valid | `["auth"]` / `["auth","tenant"]` / `["auth","tenant","handler"]` |
| auth `onRequest`, tenant `preHandler` | no headers | `["auth"]` |

Everything the diff needs is confirmed: the forbidden `["tenant","auth"]` order occurs in **both**
registration orders when the phases are crossed that way, and the shipped pairing short-circuits at
the guard (`["auth"]`, handler never called). The overstatement is only that `onRequest` is not the
*unique* correct answer — both-`preHandler` and auth-`onRequest`/tenant-`preHandler` also order
correctly. What is forced is: *given* tenant-context is `onRequest` (mirroring usage-service), the
guard must be too. The middleware docblock
(`apps/billing-service/src/middleware/tenant-context.middleware.ts:10-16`) states that conditional
correctly; `app.ts:72`'s summary drops it.

**Fix**: `app.ts:72` — "forced rather than stylistic" → "forced, given this scope's tenant-context
hook is `onRequest` (the usage-service shape)".

#### LOW-2 · The `@throws` clause names a branch duplicate headers do not take, and it has no test

`apps/billing-service/src/middleware/tenant-context.middleware.ts:33`:
*"@throws TenantContextMissingError — header absent, blank, or **not a single string value**"*.

Measured (fastify 5.10.0 / Node 22.22.2): two `x-tenant-id` headers arrive as one comma-joined
**string** —

```
duplicate x-tenant-id -> {"t":"string","v":"0450a5e0-…-aa,0450a5e0-…-bb"}
```

so the `typeof header !== "string"` arm is not what rejects a smuggled second header; the joined
value fails `tenantIdSchema` and answers `401 TENANT_CONTEXT_INVALID`. **The outcome is safe** —
rejection either way, and the first value is never silently preferred — but the documented
mechanism is wrong and no case pins the behaviour. Header smuggling is exactly the shape a tenant
header should have a test for.

**Fix**: add `BU77d` to `tests/tenant-context.middleware.unit.test.ts` injecting
`{ [BILLING_HEADERS.TENANT_ID]: [uuidA, uuidB] }` and asserting `401 TENANT_CONTEXT_INVALID`
(**not** that either uuid reached `request.tenantId`), and correct `:33` to
"header absent or blank; a duplicated header joins to a comma-separated string and is rejected as
invalid instead".

#### LOW-3 · `pageSize > 100` and `page < 1` are rejected only at schema level in tests

AC3 maps to BU72/BU73/BI16. BU73 proves the schema rejects `pageSize = MAX + 1`, `pageSize = 0` and
`page = 0`; BI16 only ever sends `pageSize` 1 and 2. **No route or integration case asserts
`GET /v1/billing/invoices?pageSize=101` → `400 VALIDATION_ERROR`.** The controller's 400 path is
exercised (BU81, unknown status), so the wiring is covered; the pagination bound is not covered
end-to-end.

Also worth recording against the brief: the epic (`docs/epics/epic-8-billing-service.md:92`) says
only `// default 20, max 100`. It does **not** say reject-vs-clamp. So "rejected, not clamped" is
the plan's choice (D-level, documented at `constants.ts` `BILLING_INVOICE_LIST` and in the
validator), not an epic requirement — and the plan's §8 divergence table does not list the
ambiguity. Not a divergence, but the epic is not the authority the plan implies here.

**Fix**: one extra assertion in BU81 or BI16: `pageSize=101` → `400` + `CODE_VALIDATION_ERROR`.

#### LOW-4 · The plan's record of its own slice-3 mutation is not reproducible as written

`docs/plans/t-046-invoice-list-endpoint.md:564`: *"bypassing `withTenant` turned **BI17** red
(`expected +0 to be 3`) **and BU74/BU74b/BU74c/BU74d red**"*.

With the mutation confined to `listInvoices` (line 360, `this.withTenant(` → `this.prisma.$transaction(`):

```
× BU74 — expected 'undefined' to contain 'app.tenant_id'
× BI14 / BI15 / BI16 / BI17 / BI18 — BI17: expected +0 to be 3
  Tests  6 failed | 151 passed (157)
```

**BU74b, BU74c and BU74d stay green** — they assert `where`, `orderBy`/`skip`/`take` and the
transaction count, none of which the bypass changes. The four-case result is only reproducible with
a repository-**wide** replacement, which I also ran by accident: it additionally reddens T-045's
BI1–BI13 with `404`, a collateral effect the record does not mention. The load-bearing half — BI17
red at **zero rows, not a leak** — reproduces exactly.

Same class, smaller: `:559` says the hook swap turns "**BU79 red, and only BU79**". On the shipped
tree it reddens **BU79 and BI20** (BI20 was written later, in slice 5). Both records under-state
breadth, which is the safe direction, but the plan is committed alongside the code.

**Fix**: correct `:559` and `:564` to the shipped-tree results.

#### NIT-1 · Test fixture vocabulary duplicated across three files

`.claude/rules/constants.md` applies to tests. The "not a UUID" tenant fixture is declared three
times with two different values — `billing-invoices.route.test.ts:16` (`"abc"`),
`tenant-context.middleware.unit.test.ts:9` (`"abc"`), `integration.constants.ts:182`
(`"not-a-uuid"`) — and `QUERY_KEY_STATUS` twice (`billing-invoices.route.test.ts:21`,
`integration.constants.ts:179`). Third copy is the promotion threshold the rule names; this is the
third. Low value to fix now, but it is the S-19/S-39 shape in miniature.

#### NIT-2 · `invoice.repository.ts:365` — `(query.page - 1) * query.pageSize`

Bare `1` where `BILLING_INVOICE_LIST.MIN_PAGE` is the same value and already imported. I would
**leave it**: it is offset arithmetic, not a bound, and substituting the constant would make it
read worse. Recorded because the clean-code gate requires a disposition, not because it should
change.

---

### Clean-code gate (required) — dispositions

| Item | Result |
|---|---|
| Magic strings in production code | **Pass.** Route path, header name, both error codes, both messages, the controller's three status codes and the internal-error body all resolve to `BILLING_ROUTES` / `BILLING_HEADERS` / `BILLING_RESPONSES`. `header.trim() === ""` is the only literal in the new middleware and mirrors usage-service. |
| Magic numbers | **Pass.** `BILLING_INVOICE_LIST` holds all five pagination bounds; sort fields/direction come from `Prisma.InvoiceScalarFieldEnum` / `Prisma.SortOrder` (verified at runtime: `periodStart`, `id`, `desc`). One bare `1` — NIT-2, disposition *leave*. |
| Error codes/messages in constants | **Pass.** `CODE_TENANT_CONTEXT_MISSING` / `_INVALID` and their messages are byte-identical to `USAGE_SERVICE_RESPONSES`' (checked), and both errors carry `HTTP_STATUS_UNAUTHORIZED`, not a literal `401`. The literal `401` at `middleware/internal-auth.middleware.ts:10` is **pre-existing and out of scope** — S-8 item 3 — and `constants.ts:30-33` says so. |
| DRY | **One pass, one nit.** `BILLING_INVOICE_LIST` duplicates usage-service's five `USAGE_SUMMARY_CONSTANTS` values — that is the *second* copy, and `.claude/rules/constants.md` sets the threshold at the third, so keeping it local is the rule applied correctly, not broken. The `x-tenant-id` promotion (third copy) is the same rule, applied the other way. Test-side duplication is NIT-1. |

### Compile-time gate (all 13 packages, `--force`, 0 cached on every task)

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | `13 successful, 13 total` · `0 cached` · 0 errors |
| lint | `pnpm lint --force` | `13 successful, 13 total` · `0 cached` · **0 errors, 14 warnings** |
| build | `npx turbo run build --force` | `13 successful, 13 total` · `0 cached` |
| test | `pnpm test --force` | `13 successful, 13 total` · `0 cached` · **838 passed, 0 failed** |
| smoke | `pnpm test:smoke` | 6 suites, 7 tests, all pass |

**Root total measured, itemised** (the brief flags this number as having been wrong once):
shared-validation 15 · shared-tracing 2 · shared-types 8 · shared-config 4 · shared-logger 4 ·
shared-utils 18 · analytics 18 · gateway 38 · usage 230 · **billing 157** · auth 164 · worker 180
= **838**. The 13th package, `@telemetry/web`, runs `vitest run --passWithNoTests` and contributes
0. 838 = 806 baseline + 32, and billing 157 = 125 + 32; the 806/125 baselines are the figures
`docs/reviews/t-045-internal-metering-endpoint.md:285` and `:635` record. Test files 16 (12 + 4 new).

**Warnings are pre-existing — proved, not asserted.** All 14 are in two files, neither of which
appears in `git diff --name-only`:
`apps/auth-service/tests/auth.service.unit.test.ts` (10 × `no-misused-promises`) — `git log -1` →
`d68e719 2026-08-25`; `apps/usage-service/tests/ingestion.service.unit.test.ts`
(4 × `no-unsafe-assignment`) — `git log -1` → `b0f6921 2026-08-31`.
`grep -c no-unsafe-return` over the whole lint log → **0**. No new warning anywhere.

### What I verified by execution

**Tenant isolation, hook order (priority 1)**
- Hook phase/order re-derived independently at fastify 5.10.0 — table under LOW-1. The forbidden
  `["tenant","auth"]` reproduces in **both** registration orders with the phases crossed; the
  shipped both-`onRequest` pairing short-circuits at the guard with the handler never invoked.
- **Mutation: swap the two `addHook` calls** (`app.ts:87-88`) → `BU79` and `BI20` red, 155 passed.
  The hooks being same-phase means registration order *is* the contract, which is why a case
  observing the *code* rather than the shared `401` is required — BU79 does that correctly.
- **Mutation: UUID check → assign the raw header** (`tenant-context.middleware.ts:46-51`) →
  `BU77b`, `BU79`, `BI19` red, 154 passed.
- Middleware validates without normalising: `tenantIdSchema` is `uuidSchema.transform(v => v as
  TenantId)` (`packages/shared-validation/src/index.ts:19,38`) — BU77c pins the byte-identical
  round trip, which matters because RLS compares `Tenant.id` byte-for-byte.
- Query input cannot carry a tenant: `ListInvoicesQuery` has no `tenantId`, and `listInvoices`
  *reconstructs* the filter from `query.status` alone (`invoice.repository.ts:356-358`), so even a
  structurally-typed extra property cannot reach `where`. Stronger than the type constraint alone.

**Encapsulated scope (priority 2)**
- **Mutation: `registerBillingRoutes` moved outside `app.register`** → `BU78, BU79, BU80, BU81,
  BU82` (the five route cases) **plus** `BI14–BI21` (eight integration cases) red; 13 failed / 144
  passed. The implementer's "BU78 plus four others" is the route-level count and is accurate; the
  integration half is additional. Note the unguarded route answers **400**, not the `200` the plan
  predicted — the controller's own `!tenantId` guard catches it — and BU78's
  `expect(listInvoices).not.toHaveBeenCalled()` is what makes the case sound regardless.
- `/health` and `POST /v1/internal/billing/generate` genuinely unaffected: BU83 asserts both on the
  real app, and all 10 of T-045's `internal-billing.route.test.ts` cases plus BI0–BI13 stay green
  under every mutation above. Confirmed structurally too — the new hooks are added inside a second
  `app.register` callback (`app.ts:86-91`), the internal scope is a separate callback
  (`:58-67`), and `/health` is on the root (`:50`). No allowlist to forget.

**The `Decimal` leak an HTTP test cannot see (priority 3)**
- **Mutation: delete the whole normalisation block** (`invoice.repository.ts:369-378` → return raw
  rows) → **`BU75` and `BI18` red** (`expected 'object' to be 'string'`), **`BI14` and `BU82`
  green**; 2 failed / 155 passed. Both halves reperformed: the green half is the finding — the wire
  body is byte-identical because `Prisma.Decimal` defines `toJSON`, so the catching assertions must
  and do sit below the HTTP boundary.
- Precision fixture change (deviation 2) is **correct and the plan's original value was not**:
  `String(Number("1234567.123456"))` → `"1234567.123456"` (lossless, proves nothing on a read);
  `String(Number("123456789012.123456"))` → `"123456789012.12346"`. Both measured. The new value is
  18 significant digits, the full `Decimal(18,6)` width.

**`where` / `withTenant` split, and whether it is honestly described**
- **Mutation: remove `this.where({})`** → `BU74`/`BU74b` red (`expected {} to deeply equal
  { Object (tenantId) }`), **all 24 integration cases green** — RLS alone carries it.
- **Mutation: bypass `withTenant`** (confined to `listInvoices`) → **`BI17` red with
  `expected +0 to be 3`** — zero rows, not a leak — plus BI14/15/16/18 and BU74's `set_config`
  assertion.
- **Judgement: honestly described, and the split is the right one.** BI17 cannot discriminate the
  two guards (one direction yields zero rows, the other yields nothing at all), and the diff says
  so rather than implying BI17 proves both. BU74's `expect(String(queryRaw.mock.calls[0]?.[0]))
  .toContain(TENANT_SETTING_NAME)` is what covers the RLS layer, and `firstArg`
  (`invoice.repository.unit.test.ts:131-137`) **throws** when the call is missing rather than
  passing vacuously. The one place this discipline slips is MEDIUM-3, a different guard.

**D4's `id` tie-break** — pinned, but only structurally. See MEDIUM-3 for the measurement.

**Database layer**
- Live `pg_class`: `Invoice | t | t` with policy `invoice_tenant_isolation | ALL |
  ("tenantId" = current_setting('app.tenant_id'::text, true))`. `InvoiceLineItem | f | t` with
  **no policy**, and `information_schema.columns` confirms it has no `tenantId`
  (`amount id invoiceId metricKey quantity unitPrice`). So **S-10 does not bite T-046** — headers
  only, `Invoice`'s own RLS is enabled — and the `INVOICE_HEADER_SELECT` docblock
  (`invoice.repository.ts:92-100`) hands it to T-047 with a true statement. Confirmed.
- **S-19 does not bite either.** `grep -rn "TIME_ZONE\|TimeZone" apps/billing-service/src` finds
  one comment in `meter.repository.ts:28` and no `set_config('TimeZone',…)`; `listInvoices` binds
  **no** timestamp — `tenantId` + optional `status` predicates, `orderBy`, `skip`/`take` only, and
  the three `Date`s are outputs. Confirmed. Incidental evidence the read path is zone-stable: this
  host runs `TimeZone = Asia/Kolkata` (per that same comment) and BI14 asserts
  `periodStart === "2026-03-01T00:00:00.000Z"` exactly, green here and on CI's UTC.
- `Invoice` indexes: `Invoice_pkey`, `Invoice_tenantId_periodStart_periodEnd_key`,
  `Invoice_tenantId_status_idx` — matching `@@unique([tenantId, periodStart, periodEnd])` and
  `@@index([tenantId, status])` in `prisma/schema.prisma`. The repository docblock's refusal to
  claim index coverage (`invoice.repository.ts:347-351`) is the right strength.

**Type safety** — `TS2345` claim in `src/types/index.ts:136-142` confirmed by making the edit:
passing a plain `string` to `InvoiceRepositoryFactory` gives
`error TS2345: Argument of type 'string' is not assignable to parameter of type 'TenantId'`, while
`as TenantId` compiles clean. **The weakened framing is the right strength** — "checked constraint,
not an unrepresentable state" is precisely what was measured, and it is worth more than
"unrepresentable" would have been. Endorsed as written. The augmentation-conflict risk (R7) is also
clear: `grep -rn "usage-service" apps/billing-service/src apps/billing-service/package.json` returns
**comments only**, no import and no dependency, so billing's `tenantId?: TenantId` and
usage-service's `tenantId: string` are never in one program today.

**Epic vs code** — the epic's `InvoiceHeader` field list is **accurate**, re-checked field by field
against `model Invoice` (`prisma/schema.prisma`): all eight present, `finalizedAt DateTime?` the
only nullable one, `totalAmount Decimal @db.Decimal(18,6)`. The non-divergence is preserved. The
T-048 divergence is real but mis-stated — MEDIUM-2. The D6 epic edit (`epic-8:13-14`) matches
`docs/epics/README.md:18-19`, verified by reading both.

**Gateway path** — `GATEWAY_PROXY_PREFIXES.BILLING = "/v1/billing"` (`gateway/src/constants.ts:35`),
**not** in `GATEWAY_PUBLIC_ROUTES` (`:50-56`, health ×2 + auth ×3 only) so a Bearer token is
required upstream; `x-tenant-id` is in `GATEWAY_SPOOFABLE_HEADERS` and deleted at
`guards.middleware.ts:52-56`; re-injected from `authContext` at `proxy.plugin.ts:47`, with
`x-internal-secret` set unconditionally at `:34-37`. All four citations re-derived.

**S-39 (`known-gaps.md`) — held to the HIGH bar, and it passes.** Reproduced the entry's grep
verbatim, line numbers included: `apps/gateway/src/constants.ts:14`,
`apps/usage-service/src/constants.ts:16`, `packages/shared-types/src/index.ts:93`, all three
`"x-tenant-id"`. Verified the producer/consumer framing rather than taking it: gateway *writes* it
(`proxy.plugin.ts:47`), usage-service *reads* it
(`usage-service/src/middleware/tenant-context.middleware.ts:35`). Verified billing adds no literal
of its own (`BILLING_HEADERS.TENANT_ID = TENANT_CONTEXT_HEADERS.TENANT_ID`). **Leaving the two
legacy copies was the right call** — rewiring them puts two other services in a billing feature
diff, which is the precedent that kept S-8 out of S-4 and S-22 out of T-038; the promotion itself
could not wait because the rule's threshold is the third copy and this was it. Severity LOW is
right: the failure mode is loud (every proxied request loses tenant context), not silent.

### What I could not verify, and why

- **Index behaviour at production volume.** `EXPLAIN` on a table this size chooses a Seq Scan; the
  diff says exactly that and claims nothing more. Not verifiable here — needs a seeded volume test.
  Correctly dispositioned as R6 in the plan.
- **Concurrency of `findMany` + `count`.** BU74d asserts one `$transaction` and one call each; that
  the pair is *isolated from* a concurrent insert is reasoning from PostgreSQL's snapshot
  semantics, not something I executed. Labelled as inference.
- **Multi-worker / sharded vitest.** Billing's integration suite uses fixed tenant ids
  (`INTEGRATION_TENANT.A`/`.B`) and cleans in `beforeEach` + `afterEach` + `afterAll` with
  `assertRunStateEmpty` — the S-20 lesson applied — but I ran it single-worker only, as configured.
- **Whether BI16 would discriminate the tie-break at larger row counts.** I measured only the
  shipped three-row fixture (green). I did not search for a row count at which it flips; that is
  why MEDIUM-3 recommends pinning rather than tuning the fixture.
- **Fastify versions other than 5.10.0, and hook phases other than `onRequest`/`preHandler`.**

### Environment

- **Database left exactly as found**: `Tenant=2`; `Event`, `UsageLine`, `Invoice`,
  `InvoiceLineItem`, `Meter` all **0**. Re-counted after every mutation run and once more at the
  end. Postgres and Redis left running; neither stopped.
- **Redis db 0**: `DBSIZE` 3 before and after, with 2 TTL'd `denylist:*` keys present throughout —
  written by auth-service's suites during the mandated `pnpm test` run. **This is S-22 and is
  unavoidable while it is open; reporting it rather than rounding to green.** My own probes opened
  no Redis connection.
- **Tree restored byte-identical.** Every mutated file was restored from a pre-mutation copy and
  `diff`ed to zero (`app.ts`, `invoice.repository.ts`, `tenant-context.middleware.ts`); two
  temporary typecheck probe files were created under `apps/billing-service/src/` and removed;
  `git status --porcelain` returns the same 29 entries as at review start, and a final clean
  `pnpm --filter @telemetry/billing-service test` is **16 files / 157 tests, 0 failures**.

### Deviations from the plan — rulings

| # | Deviation | Ruling |
|---|---|---|
| 1 | BU74/BU75 moved from the service test to the repository test | **Correct.** The repository is the only layer that builds a `where` object and the only one that sees a `Prisma.Decimal`; asserting either on a stubbed service would have been a mock echoing itself. The service test earns its keep differently — BU85's `JSON.stringify(calls).not.toContain(OTHER_TENANT_ID)` is a real negative assertion. |
| 2 | BI18's precision fixture changed | **Correct, and the reasoning is right.** Both values measured; the plan's original is lossless through a double and would have proved nothing on a read round trip. |
| 3 | `x-tenant-id` promoted to `@telemetry/shared-types` | **Correct**, and correctly scoped — see the S-39 paragraph above. |
| 4 | Integration lifecycle hoisted to file level | **Correct and necessary.** A per-`describe` `afterAll` closing the app would have left the second block with a closed instance. Reset semantics are unchanged (`beforeEach` + `afterEach` + `afterAll` + `assertRunStateEmpty`, fixed tenant ids), which is the S-20-safe shape; the diff says so accurately. |
| 5 | BU79 reshaped because the plan's suggestion was vacuous | **Correct, and the best judgement call in the diff.** I reproduced the premise: a request failing only the secret check answers `401 UNAUTHORIZED` under both hook orders, so the plan's suggested assertion could not have failed. The shipped case sends a request failing *both* checks and asserts the code — which is what went red under the swap mutation. |

Scope creep: none found. The extra files (middleware, validator, routes, repository method,
container and types edits) are the epic's incomplete file list, flagged in the plan's §8 row 4 —
not creep.

### Decisions for you

**D-A · How to close MEDIUM-3 (the tie-break's behavioural coverage).**
*One sentence:* the comment says BI16 catches a dropped `id` tie-break, and measurement says only
BU74c does — do we correct the claim or add the coverage?

| Option | What changes |
|---|---|
| **A1 · Correct the comment only (recommended)** | One line at `invoice.repository.unit.test.ts:524`: BU74c is the case that notices; BI16 asserts the *consequence-free* property (union = full set) but does not discriminate at three rows. **Diff: 1 line.** The guard stays pinned. |
| A2 · Make BI16 discriminating as well | Widen the fixture until `periodStart`-only ordering actually reorders between pages, then pin it. **Diff: fixture + assertions**, and the row count that flips it is a planner detail that may not be stable across PostgreSQL versions — so the new case could become flaky, which is worse than the honest comment. |
| A3 · Both | A1 now, A2 filed as a follow-up. |

**Recommendation: A1.** The protection exists; only the description is wrong, and A2 risks trading
a false comment for a flaky test. If you pick A3, the follow-up belongs in `known-gaps.md` next to
S-21, which is the same pattern.

**D-B · How to close MEDIUM-4 (untested controller error branches).**

| Option | What changes |
|---|---|
| **B1 · New `tests/billing.controller.unit.test.ts` (recommended)** | Three cases mirroring BU57/BU59/`!tenantId`, using `internal.controller.unit.test.ts` as the template. **Diff: 1 new file, ~3 tests.** Matches the service's existing structure exactly. |
| B2 · Extend `billing-invoices.route.test.ts` instead | Stub `invoiceService.listInvoices` to reject with an `AppError` and with a plain `Error`; the `!tenantId` branch cannot be reached through the real app (the hook always sets it), so it would stay untested. **Diff: ~2 tests, no new file, one branch still uncovered.** |
| B3 · Accept as-is | The branches are defensive and were shown to work under mutation. **Diff: none.** Leaves billing's two controllers with different coverage bars. |

**Recommendation: B1.** It is the cheapest option that covers all three branches and it is the
pattern the service already established one task ago.

Both decisions change the diff. D-A's A1 and D-B's B3 are the only options that do not add tests.

### Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| S-10 — `InvoiceLineItem` RLS inert | **Confirmed, does not reach T-046** (headers only). Handed to T-047 in three places, all now verified accurate. Stays open. |
| S-19 — no `TimeZone` pin in billing's `base.repository.ts` | **Confirmed, does not reach T-046** (no timestamp bound). Stays open. |
| S-8 — billing's guard is `!==`, and bypasses the env schema | **Correctly not folded in (D2).** The same guard is now on an externally-routed path, which raises its priority without changing its exposure — the gateway overwrites `x-internal-secret` on every path, so the timing oracle still needs direct port access. Recommend S-8 be sequenced before any further tenant-facing billing route. |
| S-39 — two legacy `x-tenant-id` literals | Filed, verified accurate, LOW. No action in this task. |
| S-22 — auth-service tests write `denylist:*` to Redis db 0 | Observed again during this gate (db 0 `DBSIZE` 3, 2 TTL'd keys). Unchanged by T-046. |
| T-048's epic signatures | Real divergence, reported, **not** implemented — correct. Wording fixed by MEDIUM-2. |
| `BILLING_INVOICE_LIST` duplicates `USAGE_SUMMARY_CONSTANTS`' five values | Second copy; per `.claude/rules/constants.md` the threshold is the third. **Watch item**: the next paged endpoint on any service should promote all five to `@telemetry/shared-types` rather than add a third copy. Not a finding today. |

### Gate

**CONDITIONAL.** Required before commit: **MEDIUM-1**, **MEDIUM-2**, **MEDIUM-3** (per D-A),
**MEDIUM-4** (per D-B), and **LOW-1**, **LOW-2**, **LOW-4** — all one-to-three-line edits except
the tests in D-B. **LOW-3** and both NITs are optional; state a disposition either way.

No re-run of the full gate is needed for the documentation-only fixes, but the billing package
suite must be re-run after D-B lands, and the root gate re-run once with `--force` before commit.

---

## Round 2 — final review (Gate 6)

**Verdict: CHANGES REQUESTED.** The production code is ready and I am not asking for a line of it
to change. What blocks is the same claim that has now been wrong at four consecutive gates, and
that this round put into `.claude/rules/known-gaps.md` — the file `CLAUDE.md` designates
authoritative and instructs other agents to trust without re-verification. I ran the mutation on a
byte-identical tree with a byte-identical mutation (md5s below) and got the **opposite** of the
run table that S-41 and the test comment now record.

Everything else in the rework verified. `pnpm test --force` is **843/843 across 13 packages**,
billing **17 files / 162 tests**, lint 14 pre-existing warnings and 0 errors.

### Findings

#### HIGH-1 · S-41's run table does not reproduce, and its two rows invert under re-measurement

`.claude/rules/known-gaps.md:1706-1707`, and the same table at
`apps/billing-service/tests/invoice.repository.unit.test.ts:535-538`:

| `"Invoice"` before the run | S-41 records | **I measured** |
|---|---|---|
| 0 unrelated rows | BI16 **green 4/4** | BI16 **red 3/3** |
| 129 rows owned by another tenant | BI16 **red 4/4** | BI16 **green, green, red, red, red, red, red** (7 runs) |

This is not a different tree and not a different mutation. Before mutating, `md5sum` on
`apps/billing-service/src/repositories/invoice.repository.ts` gave
`16bd43d8332283249ebf4c8112824ce3` — **the exact pre-mutation md5 S-41 records at `:1704`**.
After deleting line 129 and the trailing comma on line 128 the file was
`714ae8a019a1a4281b6b3fe3dd1a508e` — **the exact mutated md5 S-41 records**. Every run below
re-checked that md5 first.

```
state A · Invoice 0 rows · reltuples=0 relpages=0
  A1 Tests 2 failed | 160 passed (162)   BU74c + BI16
  A2 Tests 2 failed | 160 passed (162)   BU74c + BI16
  A3 Tests 2 failed | 160 passed (162)   BU74c + BI16
  BI16 failure identical each time: tests/billing.integration.test.ts:953, expected 2 to be 3

state B · Invoice 129 unrelated rows
  B1 reltuples=3   relpages=1 -> Tests 1 failed | 161 passed (162)   BU74c only   (BI16 GREEN)
  B2 reltuples=3   relpages=1 -> Tests 1 failed | 161 passed (162)   BU74c only   (BI16 GREEN)
  B3 reltuples=129 relpages=3 -> Tests 2 failed | 160 passed (162)   BU74c + BI16 (BI16 RED)
  B4..B7 reltuples=129/130 relpages=3 -> Tests 2 failed | 160 passed (162)  (BI16 RED ×4)
```

BI16 flipped from green to red between B2 and B3 **with nothing touched** — no schema change, no
fixture change, no row inserted or deleted between those two runs. The only thing that moved was
`pg_class.reltuples` 3 → 129, i.e. an autoanalyze that ran on its own.

**The controlling variable is the planner statistics, not the row count — and that is measured,
not inferred.** I isolated it by producing the green outcome in the state S-41 calls red-free:

```
state C · Invoice 0 rows, but reltuples=3 relpages=3
  (3 throwaway rows inserted, ANALYZE "Invoice", then those 3 rows deleted without re-analyzing)
  C1 Tests 1 failed | 161 passed (162)   BU74c only   (BI16 GREEN)
  C2 Tests 1 failed | 161 passed (162)   BU74c only   (BI16 GREEN)
  C3 Tests 1 failed | 161 passed (162)   BU74c only   (BI16 GREEN)
```

State A and state C hold **the same zero rows**. The only difference is `pg_class`. A is red 3/3
and C is green 3/3. So `"Invoice" holding 0 unrelated rows` and
`"Invoice" holding 129 rows belonging to another tenant` are not the variable the table says they
are; they are two values of a *correlate* that happened to line up once.

Both the totals S-41 quotes are correct **as totals for each outcome** — green is
`Tests 1 failed | 161 passed (162)`, red is `Tests 2 failed | 160 passed (162)`, exactly as
recorded. What does not survive is the mapping of each to a database state.

**Severity.** `.claude/rules/review-standards.md` § *Claims the Change Makes*: a false claim in
`.claude/rules/` is HIGH, because other agents are told to trust it. The concrete harm is the
`### Consequences to act on` block at `known-gaps.md:1759-1769`, which tells T-047 that a green
BI16 is not evidence — true — but does so through a table that would have T-047 conclude their
green run is explained by an empty table, when on this host an empty table is the state in which
BI16 is *red*.

**Fix — and it is a rewrite, not a substitution.** Delete the two-row table at `:1706-1707` and
the matching block at `invoice.repository.unit.test.ts:535-538`. Replace with what survives
re-running: *the mutation reddens BU74c unconditionally; BI16's `pageSize=1` walk (`:945-954`)
reddens sometimes and stays green sometimes, on a byte-identical tree and a byte-identical
mutation, with the outcome tracking `pg_class.reltuples`/`relpages` for `"Invoice"` — which
autovacuum changes without anyone asking. Measured 0-rows-red-3/3, 0-rows-green-3/3 under
different statistics, 129-rows-green-2/2 then red-5/5 across a single autoanalyze.* See D-C for
the decision this needs.

#### HIGH-2 · S-41's mechanism explains the outcome with a plan dichotomy that does not exist per state

`.claude/rules/known-gaps.md:1720-1752` (and `invoice.repository.unit.test.ts:553-571`) presents
two plans and assigns one to each outcome: `Index Scan Backward using
"Invoice_tenantId_periodStart_periodEnd_key"` ⇒ total order ⇒ BI16 green; `Sort → Seq Scan` ⇒ no
total order ⇒ BI16 can catch it. `:1768` then generalises: *"Which plan gets chosen is a property
of `"Invoice"`'s statistics"*.

Measured against the fixture's own shape (three rows for one tenant, two sharing `periodStart`
with different `periodEnd`, plus 129 rows for a second tenant), in **one** database state, as the
owner and again as `telemetry_app` inside `set_config('app.tenant_id', …, true)`:

```
OFFSET 0 -> Limit -> Index Scan Backward using "Invoice_tenantId_periodStart_periodEnd_key"
OFFSET 1 -> Limit -> Sort (Sort Key: "periodStart" DESC) -> Seq Scan
OFFSET 2 -> Limit -> Sort (Sort Key: "periodStart" DESC) -> Seq Scan
```

Both plans, same state, same statistics, same logical query — the planner picks per `OFFSET`,
because `LIMIT 1 OFFSET 0` has a startup-cost advantage the later offsets do not. BI16's walk
issues exactly these three queries. So "which plan gets chosen" is **not** a property of the state
that can be green or red as a whole, and the green/red dichotomy built on it is not supported.

Two corroborating measurements, both of which the texts get right and neither of which rescues the
mechanism:

- **"Sorting is necessary, not sufficient" is confirmed.** A `psql` walk at `OFFSET` 0/1/2 under
  the `Sort → Seq Scan` plan returned three distinct ids, twice (once at `reltuples=0`, once at
  `reltuples=3` after an explicit `ANALYZE`). The comment at `invoice.repository.unit.test.ts:564-566`
  states this at exactly the right strength and does not upgrade it.
- **The `Index Scan Backward` plan is real** — `pg_indexes` gives the index as
  `CREATE UNIQUE INDEX "Invoice_tenantId_periodStart_periodEnd_key" ON public."Invoice" USING
  btree ("tenantId", "periodStart", "periodEnd")`, byte-identical to `known-gaps.md:1742-1744`,
  and the sort key is a prefix of it. The prefix argument is sound; what is unsound is treating it
  as the explanation of a whole run's outcome.

**Fix**: at `known-gaps.md:1720-1752` and `invoice.repository.unit.test.ts:553-571`, either drop
the mechanism section entirely (recommended — see D-C) or reduce it to the prefix observation plus
the measured fact that the plan is chosen **per query**, so a single walk can mix both plans and
neither plan labels a run.

#### MEDIUM-1 · The comment's closing sentence blends the 20-run series it just disclaimed

`apps/billing-service/tests/invoice.repository.unit.test.ts:575`: *"The conditional above is what
**28 runs** support."*

28 = the 8 instrumented runs + the 20 exploratory ones. The comment itself disclaims the 20 two
sentences earlier (`:549-551`, *"An earlier, less instrumented series of 20 runs … split 14 green /
6 red"*), and `known-gaps.md:1715-1718` explains why it cannot be leaned on: BU74c's individual
outcome was recorded in only 14 of the 20. A series that split 14/6 does not support a clean
two-state conditional at all — it is the evidence *against* one. S-41's own text handles this
correctly and does not blend; the comment does.

**Fix**: `invoice.repository.unit.test.ts:575` — cite the series that can be defended, or (better,
given HIGH-1) delete the sentence with the rest of the run table.

#### MEDIUM-2 · S-40 discredits a QA measurement that reproduces on the first value beyond its own sweep

`.claude/rules/known-gaps.md:1613-1618`: *"T-046's QA report quotes a third text again —
`Unable to fit value 2e+307 … for field 'skip'` — which **did not reproduce here for any `page`
value tried**."*

It reproduces. Live, against a billing-service process I started on port 3107 (`telemetry_app`
DSN, Redis db 12, valid secret and tenant):

```
?page=1e306 -> 500   log: Unable to fit value 2e+307 into a 64-bit signed integer for field `skip`
?page=1e307 -> 500   log: Argument `skip` is missing.
?page=1e308 -> 500   log: Argument `skip` is missing.
```

`(1e306 - 1) * 20 = 2e307`. S-40's own probe table (`:1596-1606`) jumps from `1e18` to
`9223372036854775807` to `1e400`, skipping the entire `1e19`–`1e307` band in which QA's value sits,
so the sentence is literally true of that sweep and misleading about QA's record.

Graded MEDIUM rather than HIGH because the sentence is hedged ("for any value tried") rather than
false, and because the point it is making — *the message is value-dependent, reproduce the fault
and not the string* — is correct and my measurement strengthens it: I observed **four** distinct
messages (`2e+307`, `20000000000000000000`, `100000000000000000000`, `184467440737095500000`,
plus `` Argument `skip` is missing. ``). But it is in an authoritative file and it reads as a
correction of another gate's honesty.

**Fix**: `known-gaps.md:1613-1618` — replace "did not reproduce here for any `page` value tried"
with the measurement: `page=1e306` produces exactly QA's text; the numeral is
`(page - 1) * pageSize`, which is why it is value-dependent. Keep the "reproduce the fault, not the
string" guidance — it is the right lesson and it is now better evidenced.

#### LOW-1 · LOW-1's own fix reached `app.ts` and not the sibling docblock, which now contradicts it

`apps/billing-service/src/middleware/tenant-context.middleware.ts:10`:
*"**`onRequest`, not `preHandler`, and that is forced rather than chosen.**"*

`apps/billing-service/src/app.ts:83-87` — rewritten this round for exactly this — now says the
opposite: *"both-`preHandler` (auth first) and auth-`onRequest`/tenant-`preHandler` also order
correctly. So the choice among the three correct pairings is stylistic."*

Re-derived independently at fastify 5.10.0 / Node 22.22.2, standalone probe, guard reproduced as
billing's un-`return`ed `reply.status(401).send(...)`:

```
onRequest/onRequest   auth first    [auth]          401   <- shipped
onRequest/onRequest   tenant first  [tenant,auth]   401
preHandler/preHandler auth first    [auth]          401   <- also correct
onRequest/preHandler  auth first    [auth]          401   <- also correct
preHandler/onRequest  auth first    [tenant,auth]   401   <- the forbidden order
preHandler/onRequest  tenant first  [tenant,auth]   401   <- forbidden in both registration orders
```

`app.ts` is right and the middleware docblock's bolded sentence is the un-conditioned universal
LOW-1 asked to be removed. The docblock's *body* argues the correct conditional (given this hook is
`onRequest`, the guard must be too), so only the headline is wrong — but it is the sentence a
reader takes away, and this is the S-33 "fix landed in one copy" shape inside the commit that made
the other copy correct.

**Fix**: `tenant-context.middleware.ts:10` — "`onRequest`, not `preHandler`, and that is forced
**given billing's internal-auth guard shares this scope**: at fastify 5.10.0 an `onRequest` hook
runs before a `preHandler` one in both registration orders, so this hook and the guard must sit in
the same phase with the guard first. Both-`preHandler` would also be correct; see `app.ts`."

#### LOW-2 · `TENANT_CONTEXT_HEADERS`' docblock states a universal auth-service refutes

`packages/shared-types/src/index.ts:79-80`: *"the **only source of tenant identity a downstream
service may read**."*

`grep -rn "x-tenant-id\|X-Tenant-Id" apps/auth-service/src --include=*.ts` returns nothing.
auth-service discovers the tenant from a credential through the `SECURITY DEFINER` resolvers, which
`.claude/rules/tenant-isolation.md` § *auth-service's pre-tenant path* documents as "the one
deliberate deviation". The sentence is in a **shared package** every service imports, so it is read
by the service it is false about.

**Fix**: `packages/shared-types/src/index.ts:79-80` — "the source of tenant identity for services
that receive it from the gateway. auth-service is the exception: it *discovers* the tenant from a
credential and reads no tenant header (`.claude/rules/tenant-isolation.md`)."

#### LOW-3 · Three of QA's five defects have no recorded disposition anywhere

Gate 5 returned FAIL with F-1 … F-5. F-1 became the MEDIUM-3 rework and S-41; F-2 became S-40.
**F-3, F-4 and F-5 appear nowhere on the tree** — `grep -n "F-3\|F-4\|F-5" docs/plans/t-046-*.md`
returns nothing, and `known-gaps.md` contains no entry for either. `CLAUDE.md` is explicit that
`docs/plans/` is not a record of completion and the epic files are not a manifest (S-15), so three
QA findings currently survive only inside `docs/qa/`, which no later task is directed to read.

My rulings on the three, all **correctly not fixed here**:

- **F-3 · `totalAmount` is not fixed-scale.** `toAmountString` (`invoice.repository.ts:161`) is
  `String(value ?? 0)`, so a stored `10.500000` serves as `"10.5"`. Not a defect — the contract is
  `string` and no precision is lost — but T-047 inherits the same helper for the detail endpoint
  and a UI will inherit the shape. Worth the one sentence QA asked for, in `invoice.repository.ts`
  above `toAmountString`. Does not block.
- **F-4 · `?status[]=DRAFT` returns an unfiltered `200`.** Confirmed at code level rather than
  live (the service was already stopped): fastify's default parser produces the key `"status[]"`,
  and `invoiceListQuerySchema` is a non-strict `z.object`, which strips unknown keys — so no
  `status` reaches the repository. No leak; the result is a superset the caller is entitled to.
  Correctly deferred. Would be closed by `.strict()`, which is a contract change and should not be
  made inside a rework.
- **F-5 · `401` on a registered path, `404` on an unregistered one.** A structural property of
  the (correct) `app.register` encapsulation, not a T-046 defect, and billing is not directly
  exposed. Correctly deferred; it is platform-wide rather than billing-specific, which is an
  argument for a `known-gaps` line rather than a code change.

**Fix**: one short paragraph in `docs/plans/t-046-invoice-list-endpoint.md` § Gate-5 dispositions
recording F-3/F-4/F-5 and the rulings, or a single combined `known-gaps` entry. Cheapest is the
plan paragraph; the durable place is `known-gaps.md`.

#### NIT-1 · Round 1's NIT-1 is now the ninth copy of one tenant fixture

`grep -rn "11111111-1111-4111-8111-111111111111" apps/billing-service/tests` returns **8 files**,
two of them added by T-046 (`billing.controller.unit.test.ts:39`, `invoice.service.unit.test.ts:11`).
The plan's disposition (file, do not fold — a shared home means a new test-constants module,
because the unit files deliberately avoid importing `integration.constants.ts` and its live DSNs)
is the right call and I endorse it. Recorded only so the count is on the record: it is the
service-wide convention, not a T-046 regression.

### What the rework got right, re-derived rather than accepted

- **MEDIUM-1.** `grep -n "^  async" invoice.repository.ts` → **five** (`:204 :220 :244 :285 :378`),
  matching the corrected text at `:173`. The added clause *"every `invoiceId` in the file is a
  local binding, a returned field or a comment — never a parameter"* also holds: `grep -n invoiceId`
  returns `:140` (interface field), `:289` (local `const`), `:299` (comment), `:339`/`:358`
  (returned fields). No parameter.
- **MEDIUM-2.** All three probes re-run against a temporary subclass under
  `pnpm --filter @telemetry/billing-service typecheck`. **A**: `findById(id, _tenantId)` calling
  `this.where({ id })` — compiles, exit 0. **C**: the same building `where: { id, tenantId }` by
  hand — compiles, exit 0. **B**: `this.where({ id, tenantId })` —
  `error TS2322: Type 'TenantId' is not assignable to type 'undefined'.` The base constraint is
  `where<T extends { tenantId?: never } & Record<string, unknown>>`
  (`base.repository.ts:85`). The docblock's replacement wording — a convention the call-site shape
  supports, not a type-level impossibility — is exactly what the compiler says. Probe file removed;
  `git status` count unchanged.
- **MEDIUM-4.** `billing.controller.unit.test.ts` BU88–BU91 read correctly. `sentBody` (`:62-69`)
  **throws** when `send` was never called rather than returning `undefined`, so no case can pass
  vacuously. BU89 asserts the negative that carries the weight
  (`expect(listInvoices).not.toHaveBeenCalled()`), not just the status. BU91's leaks-nothing
  contract is exact equality plus `JSON.stringify(body).not.toContain(secret)` **and** the positive
  half (`logger.error` called once, containing it) — so it pins both directions. The docblock's
  disclosure that BU89 was red on its first run for a *test* defect (a default parameter re-applied
  on explicit `undefined`) is the honest form and is worth more than a "confirmed red" assertion.
- **LOW-1** (`app.ts:72-87`), **LOW-2** (`tenant-context.middleware.ts:33-48` + BU77d at
  `tenant-context.middleware.unit.test.ts:94`, asserting both the `,` and `, ` separators and that
  neither uuid reaches the body), **LOW-3** (`billing-invoices.route.test.ts:173-179`, `pageSize=101`
  at route level, with the reject-not-clamp choice recorded as the plan's and not the epic's) —
  all present and all as described.
- **The plan's MEDIUM-3 entry** (`docs/plans/t-046-invoice-list-endpoint.md:632-659`) does record
  both outcomes and does disclose that the previous entry carried the **pre-rework** 16-files /
  157-tests totals onto a 17/162 tree — verbatim, at `:653-657`. The brief asked whether the totals
  it now quotes are the ones the mutation produces: **they are, per outcome** (green ⇒
  `1 failed | 161 passed (162)`, red ⇒ `2 failed | 160 passed (162)`); it is the state each is
  attributed to that HIGH-1 refutes. The entry is also honest about the `EXPLAIN` gap — *"the plan
  **inside** the suite's own connection was not captured, so it is not established by direct
  observation of the running case"* — and S-41 repeats it under `### Not established` at
  `known-gaps.md:1794-1795`. **Both texts disclose the gap; neither papers over it.** That is a
  real improvement on the prior two rounds and it is why HIGH-1 is about the table and not about
  concealment.
- **S-41's honesty items.** The `pg_indexes` row (`:1742-1744`) is byte-identical to live output.
  The S-21 kinship at `:1771-1777` is accurate: S-21 on disk *is* "two independent guards … either
  alone is sufficient … leaves that suite 17/17 green", and calling the kinship weaker than it
  looks is correct. The self-disclosed limitation at `:1779-1785` — that `"Invoice"` was `ANALYZE`d
  with **no pre-probe `pg_class` baseline** — is exactly the variable HIGH-1 turned out to be
  about; I *did* capture that baseline before touching anything (`reltuples=0 relpages=1`,
  `last_autoanalyze 2026-09-16 08:59`), which is how the isolation in state C was possible.
- **S-41's grep sweep**, re-run verbatim: `grep -rln "pageSize" apps/*/tests --include=*.test.ts`
  → **12** files; `grep -rn "new Set(" apps/*/tests` outside billing → **5** hits (two in
  `stream.publisher.unit.test.ts`, one in `usage.integration.test.ts`, two in worker-service), none
  a page walk; `grep -rn "orderBy" apps/*/src` → **3** sites (`meter.repository.ts:51`,
  `invoice.repository.ts:255`, `:387`); one raw `ORDER BY … LIMIT/OFFSET`, usage-service's grouped
  summary at `usage.repository.ts:162`. Every number holds, and the entry's "looks like, because
  that is a grep over test shapes" hedge is the right strength.
- **S-40's measured claims, all of them.** Re-derived live on a real process, row for row: the
  three declarations (`invoice-list.validator.ts:31`, `usage-summary.validator.ts:34`,
  `shared-validation/src/index.ts:24`), `grep -rn "MAX_PAGE\b"` → no match (exit 1),
  `paginationSchema` → 3 lines with no production consumer, the offsets at
  `invoice.repository.ts:388` and `usage.repository.ts:154`/`:162`, the constants at
  `billing/constants.ts:198,200` and `usage/constants.ts:59,61`. Live responses matched **exactly**,
  including `?page=1e18&pageSize=1` → `200` and `?page=1e18&pageSize=100` → `500` (so the threshold
  really does move with `pageSize`, in both directions), `?page=9223372036854775807` → `500`,
  `1e400`/`Infinity`/`NaN`/`-1` → `400` with the quoted messages. The `500` body is **59 bytes**,
  `{"code":"INTERNAL_ERROR","message":"Internal server error"}` — no error text, no query, no
  tenant id. The error class claim holds by `instanceof`, not off the message: a direct
  `invoice.findMany({ skip: 2e19 })` and `({ skip: Infinity })` through `@prisma/client` both give
  `e instanceof Prisma.PrismaClientValidationError === true`. `"Unexpected error in invoice list
  controller"` in the log confirms the `500` is written by the controller's own arm
  (`billing.controller.ts:72-74`), not by `registerGlobalErrorHandler`. Unauthenticated → `401
  UNAUTHORIZED`; secret without tenant → `401 TENANT_CONTEXT_MISSING`; both guards run first.
  **And the usage-service limit is stated, not implied** — `known-gaps.md:1633` reads "usage-service's
  HTTP behaviour was **not** driven. What follows is the bind itself", which is the correct
  qualification. Only MEDIUM-2 above is wrong in this entry.
- **`known-gaps.md` is purely additive.** `git diff -U0` gives one hunk, `@@ -1497,0 +1498,313 @@`,
  zero deleted lines — so no pre-existing entry was silently edited.

### The spine, ruled on

The brief asked me to re-derive whether BI16 catches a dropped `id` tie-break, in both database
states, and to judge whether the final text states no more than is supported.

**It states more than is supported.** Not by exaggeration — by naming the wrong variable. The
sequence is now: Round 1 measured green once and generalised; QA measured red seven times and
generalised; the rework measured eight runs across two row counts and generalised to a
*conditional*; I measured thirteen runs and the conditional inverts. Each gate varied one dimension
and wrote up a mechanism. `.claude/rules/review-standards.md` § *Universals Must Cite Their
Mutation* names exactly this: *"probes that varied one dimension, written up as a general
mechanism."*

The rework is a genuine improvement — it is the first version to say the outcome is not
unconditional, it cites its md5s (which is how I could prove I ran the same thing), and it discloses
the `EXPLAIN` gap instead of hiding it. But a conditional whose condition is wrong is still a claim
that will be believed, and it is now in the file agents are told not to re-verify.

**Should the task ship with the claim having been wrong four times?** Yes — but not with a fifth
attempt at the mechanism. My judgement: the *code* is correct, tested and unchanged since Gate 4;
nothing about the endpoint's behaviour is in doubt. The right move is to stop asserting **why** and
record only what is reproducible: BU74c is the guard that holds unconditionally; BI16's walk
reddens sometimes; the outcome varies with planner statistics that move on their own; do not read
a green BI16 as evidence. That is a *smaller* claim than the one on the tree, and it is the one
that has survived every gate so far.

### Compile-time gate — all 13 packages, `--force`, 0 cached on every task

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | `13 successful, 13 total` · `0 cached, 13 total` · 20.8s · exit 0 |
| lint | `pnpm lint --force` | `13 successful, 13 total` · `0 cached, 13 total` · **0 errors, 14 warnings** · exit 0 |
| build | `npx turbo run build --force` | `13 successful, 13 total` · `0 cached, 13 total` · 22.7s · exit 0 |
| test | `pnpm test --force` | `13 successful, 13 total` · `0 cached, 13 total` · exit 0 |
| smoke | `pnpm test:smoke` | 6 suites, 7 tests, all pass |

**Per-package test totals, measured, not headline:**

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
| `@telemetry/web` | — | 0 (`vitest run --passWithNoTests`) |
| **Total** | **81** | **843** |

843 matches the number the brief carried forward and QA measured. Billing 17/162 confirms the two
rework additions (BU88–BU91 and BU77d) over Round 1's 157.

**All 14 lint warnings are pre-existing — proved.** Two files, neither in `git status --porcelain`:
`apps/auth-service/tests/auth.service.unit.test.ts` (10 × `no-misused-promises`), `git log -1` →
`d68e719 2026-08-25`; `apps/usage-service/tests/ingestion.service.unit.test.ts`
(4 × `no-unsafe-assignment`), `git log -1` → `b0f6921 2026-08-31`. `grep -c no-unsafe-return` over
the whole lint log → **0**. No new warning anywhere.

### Release readiness

- **Acceptance criteria.** Re-read `docs/epics/epic-8-billing-service.md:81-110` against the code:
  the eight `InvoiceHeader` fields, `PaginatedResult`, `status?` / `page` / `pageSize` with
  `default 20, max 100`. All satisfied; QA walked all ten live and I did not re-drive them, relying
  on QA's live table plus the 162 green cases. The one thing the epic does **not** say is
  reject-vs-clamp for `pageSize > 100`, and the tests now record that reject is the plan's choice —
  correct.
- **Epic edit.** `docs/epics/epic-8-billing-service.md:13-14` (Q2 decided, Q3 scoped to Epic 9)
  matches `docs/epics/README.md:18-19` word for word. Verified by reading both.
- **Breaking-change assessment across the other 12 packages.** The only shared-package change is an
  **addition**: `TENANT_CONTEXT_HEADERS` at `packages/shared-types/src/index.ts:92`. No existing
  export is renamed, removed or retyped (`git diff` on that file is +18/-0). `grep -rn
  "TENANT_CONTEXT_HEADERS" apps packages --include=*.ts` excluding `dist/` → three lines: the
  declaration and billing's two (`constants.ts:6` import, `:24` derivation). No name collision, no
  consumer to break. The full `--force` gate across all 13 packages is the proof. Only the docblock
  is wrong (LOW-2).
- **Regressions in related services.** None. usage-service 230/230, gateway 38/38, auth 164/164,
  worker 180/180, all unchanged from the last recorded baselines.

### What I verified by execution

Tenant isolation and injection were fully re-derived at Round 1 and nothing in production changed
since; I re-checked the load-bearing pieces rather than repeating the whole sweep:

- `listInvoices` (`invoice.repository.ts:378-400`) runs inside `withTenant` and builds its `where`
  from `this.where({ status })` — the bound context — with `ListInvoicesQuery` carrying no
  `tenantId` field. No raw SQL, no bound timestamp, no interpolation: the only inputs that reach
  the database are a Prisma enum member, and two integers the validator has already bounded
  (`page` only on the lower side — S-40).
- The `{ tenantId?: never }` constraint behaves as the docblock now says (MEDIUM-2 probes above).
- Hook phase and order at fastify 5.10.0, six configurations, independently of Round 1 (LOW-1).
- The full mutation series for the tie-break, thirteen suite runs across three database states,
  with `md5sum` on the mutated file before every run and `pg_class` captured before every run.
- S-40's live behaviour end to end against a real billing-service process, plus the Prisma error
  class by `instanceof`.
- Every grep, count and `file:line` cited in S-40, S-41, the BU74c comment and the repository
  docblocks.

### What I could not verify, and why

- **The plan the suite's own connection actually used.** Same gap S-41 discloses: `auto_explain` is
  not loaded, so every plan I captured came from a separate `psql`/`prisma` session reproducing the
  fixture's shape. My HIGH-2 finding is therefore about what the planner does for that query shape
  in a given state — which is measured — not a direct observation of the running case.
- **Why state A (0 rows, `reltuples=0`) is red while state C (0 rows, `reltuples=3`) is green.**
  I isolated the variable; I did not establish the causal chain from statistics to the mixed-plan
  walk. HIGH-2's per-`OFFSET` plan split is the most likely link and is labelled as such.
- **F-4 live.** Confirmed by reading fastify's default parser behaviour and zod's non-strict
  `z.object`, plus QA's live measurement. I did not re-drive it.
- **AC1–AC10 end to end.** Relied on QA's live walk and the 162 green cases rather than re-driving
  the endpoint for each criterion.
- **Whether the rework's own 8-run series is reproducible on their machine state.** It is not
  reconstructible — that is the finding, not a limitation of my probing.
- **Index behaviour at production volume**, unchanged from Round 1: `EXPLAIN` on a table this size
  is not evidence about a large one, and the repository docblock correctly claims nothing.

### Environment

- **Database returned exactly as found.** `Event`, `UsageLine`, `Invoice`, `InvoiceLineItem`,
  `Meter` all **0**; `Tenant` **2**. Re-counted after every probe and once at the end. The two probe
  tenants (`…09e1`, `…09e2`) and all seeded invoices were removed **by explicit id / explicit
  tenantId**, never a bare `DELETE`. All seeding went through `DIRECT_DATABASE_URL` (the `postgres`
  owner role). Postgres and Redis left running; neither stopped.
- **`pg_class` for `"Invoice"` was captured before the first probe** — `reltuples=0 relpages=1`,
  `last_analyze 2026-09-15 19:26`, `last_autoanalyze 2026-09-16 08:59` — which is the baseline S-41
  says it did not have. It is **not** back to that exact value (`reltuples` and `relpages` are
  autovacuum-owned and moved during the mandated `pnpm test` run before I touched anything); no row
  contents differ.
- **Redis db 0** started at `DBSIZE 1` (`telemetry:events`), rose to **2** during the mandated
  `pnpm test --force` when auth-service's suite wrote a TTL'd `denylist:*` key, and is back to **1**
  now that the key expired. **That is S-22 and is unavoidable while it is open; reporting it rather
  than rounding to green.** My own probes used db 12 only (`DBSIZE 0` before and after) and wrote
  nothing to db 0.
- **Tree restored byte-identical.** `invoice.repository.ts` md5 back to
  `16bd43d8332283249ebf4c8112824ce3` and `diff` against the pre-mutation copy is empty. Three
  temporary probe files (`src/repositories/zz-review-probe.ts`, `zz-probe.mjs`, `zz-hook-probe.mjs`)
  created and removed. `git status --porcelain` returns the same **32** entries as at review start,
  and a final clean `pnpm --filter @telemetry/billing-service test` is **17 files / 162 tests,
  0 failures**.

### Decisions for you

**D-C · What may the tie-break's coverage note actually claim?** *One sentence:* the state→outcome
table in S-41 and in the BU74c comment inverts on re-measurement, and the variable turns out to be
planner statistics that autovacuum moves on its own — so what should replace it?

| Option | What changes |
|---|---|
| **C1 · Record the outcome, drop the mechanism (recommended)** | Delete the two-row table (`known-gaps.md:1706-1707`, `invoice.repository.unit.test.ts:535-538`) and the mechanism section (`:1720-1752`, `:553-571`). Keep: BU74c reddens unconditionally; BI16's walk reddens *sometimes* on a byte-identical tree and mutation; do not read a green BI16 as evidence; T-047 inherits this fixture. Add my three-state series as the evidence. **Diff: two text blocks, no code, no tests.** |
| C2 · Keep the mechanism, corrected to per-query plan choice | Rewrite `:1720-1752` around the measured `OFFSET 0` vs `OFFSET 1/2` plan split. **Diff: same two blocks, longer.** Risk: this is the fifth mechanism written for this claim and I established it from one state — a sixth gate may refute it too. |
| C3 · Make BI16 deterministic instead | Change the fixture so the sort key is not a prefix of a unique index (e.g. seed two rows sharing *both* `periodStart` and a non-unique discriminator), then assert. **Diff: fixture + BI16.** This is Round 1's rejected A2 with a better-understood lever; it would close the gap rather than document it, at the cost of a fixture change in a rework. |

**Recommendation: C1.** It is the only option whose claim I cannot imagine a sixth gate refuting,
because it asserts nothing about *why*. C2 and C3 change the diff more; C3 changes test behaviour
and would need its own red-first confirmation.

**D-D · Where do F-3, F-4 and F-5 get recorded?** *One sentence:* three QA findings currently exist
only in `docs/qa/`, which nothing directs a later task to read.

| Option | What changes |
|---|---|
| **D1 · One paragraph in the plan's Gate-5 section (recommended)** | Records all three with the rulings above. **Diff: ~8 lines of plan text.** Cheapest, and it travels in the same commit. |
| D2 · One combined `known-gaps.md` entry (S-42) | Durable and reachable by grep from any future task; F-3 in particular binds T-047. **Diff: one new entry.** More weight than three NITs arguably deserve. |
| D3 · D1 plus the one-sentence `toAmountString` docblock QA asked for | Adds `invoice.repository.ts:161`. **Diff: plan text + one comment line.** |

**Recommendation: D3.** F-3 is the only one of the three that another task inherits directly, and
one sentence beside the helper is where T-047 will actually see it.

Both decisions are text-only. Neither changes production behaviour, and neither needs the root gate
re-run — but the billing package suite should be re-run after any edit to
`invoice.repository.unit.test.ts`.

### Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| **S-41 as written will mislead T-047** | **Blocking (HIGH-1/HIGH-2).** Fix per D-C before commit. |
| **S-40's `2e+307` sentence discredits a correct QA measurement** | **Blocking (MEDIUM-2).** One-sentence fix at `known-gaps.md:1613-1618`. |
| BI16 is a non-deterministic guard and will stay one | **Accepted, documented.** No production consequence: BU74c holds unconditionally (13/13 runs here). C3 would close it; C1/C2 would not. |
| S-40 — unbounded `page` reaching a `500` on a customer-facing route | **Correctly filed, not fixed.** Fails closed, 59-byte body, needs an authenticated tenant-scoped caller. Fixing it means editing usage-service's validator inside a billing task. Verified accurate except MEDIUM-2. |
| S-10 — `InvoiceLineItem` RLS inert | Confirmed again: does not reach T-046 (headers only, `INVOICE_HEADER_SELECT` cannot `include`). Handed to T-047 accurately. Stays open. |
| S-19 — no `TimeZone` pin in billing's `base.repository.ts` | Confirmed: `listInvoices` binds no timestamp, uses the ORM only. Stays open. |
| S-8 — billing's internal-auth guard is `!==` and is now on an externally-routed path | Unchanged by this round. Still recommend sequencing S-8 before any further tenant-facing billing route. |
| S-22 — auth-service writes `denylist:*` to Redis db 0 | Observed again during the mandated gate (db 0 went 1 → 2, back to 1 on TTL expiry). Unchanged by T-046. |
| S-39 — two legacy `x-tenant-id` literals | Verified accurate at Round 1, unchanged. LOW. |
| F-3 / F-4 / F-5 with no durable record | **Non-blocking**, but resolve via D-D so they do not evaporate. |
| `TENANT_CONTEXT_HEADERS` docblock universal | Non-blocking (LOW-2); fix in the same pass as the others. |
| `tenant-context.middleware.ts:10` contradicts `app.ts:83-87` | Non-blocking (LOW-1); one sentence. |

### Gate

**CHANGES REQUESTED.** Required before commit:

1. **HIGH-1** — `known-gaps.md:1706-1707` and `invoice.repository.unit.test.ts:535-538`: the
   state→outcome table, per **D-C**.
2. **HIGH-2** — `known-gaps.md:1720-1752` and `invoice.repository.unit.test.ts:553-571`: the
   mechanism, per **D-C**.
3. **MEDIUM-1** — `invoice.repository.unit.test.ts:575`: drop or requalify "what 28 runs support".
4. **MEDIUM-2** — `known-gaps.md:1613-1618`: `page=1e306` reproduces QA's `2e+307` exactly.
5. **LOW-1** — `tenant-context.middleware.ts:10`: condition the "forced" claim.
6. **LOW-2** — `packages/shared-types/src/index.ts:79-80`: exclude auth-service from the universal.

**LOW-3** (D-D) is strongly recommended and not strictly blocking; **NIT-1** needs no action.

No production code change is required by any of the above, and none of them can change the 843/843
result — but `apps/billing-service/tests/invoice.repository.unit.test.ts` is edited by items 1–3, so
re-run `pnpm --filter @telemetry/billing-service test` after, and the root `--force` gate once
before commit.

---

## Round 3 — retrospective close-out of Round 2's conditions

**Verdict: `APPROVED FOR COMMIT` (retrospective).** All six of Round 2's required fixes are
discharged, and I re-derived the two load-bearing ones by execution rather than by reading the
diff. Three new findings, all **follow-up** — T-046 shipped as `5cb454a` and HEAD is `73e01ed`,
so nothing here is a blocker and none of it is a code defect.

**Revisions read.** `.claude/rules/known-gaps.md` at **HEAD (`73e01ed`)**, read from disk with
`cat`/`sed` — the copy injected into this session ends at **S-39**, an instance of **S-24**, so it
could not see S-40's or S-41's current text at all. `git diff 5cb454a 73e01ed -- .claude/rules/known-gaps.md`
shows T-042 appended S-42–S-45 after S-41 and changed exactly one sentence inside S-40
(`six` → `seven` for S-19's copy count), touching neither S-41 nor the passages Round 2 named. So
quoting HEAD and quoting `5cb454a` are the same text for every line below except that one.

---

### The six conditions — discharged

Verified by command on the shipped tree, not by reading the rework's account of itself.

| # | Round-2 condition | Status | How established |
|---|---|---|---|
| 1 | HIGH-1 — delete the state→outcome run table | **discharged** | `grep -ci` on `invoice.repository.unit.test.ts` returns **0** for each of `Tests 1 failed`, `Tests 2 failed`, `green 4/4`, `reltuples`, `relpages`, `129`, `md5` |
| 2 | HIGH-2 — delete the mechanism section | **discharged** | **0** for `EXPLAIN`, `Index Scan`, `Seq Scan`, `prefix`, `Sorting is necessary` |
| 3 | MEDIUM-1 — drop "what 28 runs support" | **discharged** | **0** for `28 runs` and for `20 runs` |
| 4 | MEDIUM-2 — S-40 concedes QA's `2e+307` | **discharged, re-measured** | below |
| 5 | LOW-1 — condition the "forced" claim at `tenant-context.middleware.ts:10` | **discharged, re-measured** | below |
| 6 | LOW-2 — exclude auth-service from the shared-types universal | **discharged** | `packages/shared-types/src/index.ts:83-91`; its own `grep -rn "x-tenant-id" apps/auth-service/src --include=*.ts` re-runs to nothing (exit 1) |
| LOW-3 (non-blocking) | record F-3/F-4/F-5 | **discharged, beyond the ask** | `docs/plans/t-046-invoice-list-endpoint.md:785-816` dispositions all three; the D3 `toAmountString` note landed too, at `invoice.repository.ts:155-165` |

**The deletions are deletions, not substitutions.** The surviving comment
(`apps/billing-service/tests/invoice.repository.unit.test.ts:521-544`) claims no mechanism. It
names the mutation and the case it reddens, says BI16's redness "is not reproducible", says "The
cause is **not established**, and this comment deliberately does not offer one", lists the three
refuted/unresolved observations explicitly *as* observations, and closes with the four superseded
characterisations. That is the right shape.

**The passage arguing against a behavioural case is gone, and BI16 was not weakened.** The only
surviving mention is its inverse at `:530-532` — *"A behavioural case exists — BI16 — and its
redness is not reproducible. **Do not delete it on the strength of a run in which it stayed
green.**"* BI16's walk block (`apps/billing-service/tests/billing.integration.test.ts:944-955`) is
intact: three single-row pages, `new Set(walked).size` and the sorted-id equality both still
asserted.

**S-41's title and body do state non-reproducibility with cause not established**
(`.claude/rules/known-gaps.md:1877`, `:1893-1934`), and it **kept its own disclosure** — the
`### This entry's own limitation` block at `:1965-1972` still records that the Gate-3 rework's
pre-probe `pg_class` baseline for `"Invoice"` was not captured. I re-derived the one live claim in
that section: `show shared_preload_libraries` → `""` and
`select count(*) from pg_available_extensions where name='auto_explain'` → `0`, on
PostgreSQL 16.13. S-41's `auto_explain` disclosure is true.

**The plan's MEDIUM-3 entry no longer records the dichotomy as fact.**
`docs/plans/t-046-invoice-list-endpoint.md:641-668` presents it as the second of two *superseded*
records — *"The second recorded a two-state dichotomy (0 rows ⇒ BI16 green, 129 unrelated rows ⇒
BI16 red) as fact; Gate 6 measured the opposite in both states"* — and keeps only the per-outcome
totals, which are the one numeric thing both series agree on.

#### MEDIUM-2 re-measured, not read

S-40 (`.claude/rules/known-gaps.md:1785-1806`) now says QA's observation **is correct** and that
its own sweep skipped the band. Both halves re-derive:

- The arithmetic, every row of S-40's four-forms block, in `node`: `(1e306-1)*20` → `2e+307`;
  `(1e307-1)*2` → `2e+307`; `(2e306-1)*10` → `2e+307`; `(1e306-1)*1` → `1e+306`;
  `(1e305-1)*20` → `1.9999999999999997e+306`; `(1e307-1)*20` and `(1e308-1)*20` → `Infinity`.
  Five values, five exact matches, including the two that explain the `` Argument `skip` is
  missing. `` rows.
- The message itself, straight through `@prisma/client` against this PostgreSQL:
  `invoice.findMany({ where, skip: 2e307, take: 20 })` →
  `PrismaClientValidationError | Unable to fit value 2e+307 into a 64-bit signed integer for field `skip``
  — QA's text **verbatim** — and `skip: Infinity` → `` Argument `skip` is missing. ``
  Done at the Prisma layer rather than over HTTP deliberately: it isolates the claim without
  starting a service or touching Redis, and the HTTP framing was already driven twice.

QA was right, and S-40 now says so at the right strength.

#### LOW-1 re-measured, not read

`apps/billing-service/src/middleware/tenant-context.middleware.ts:10-12` now reads
*"**`onRequest`, not `preHandler` — a choice, with one forced consequence.**"* and states the
conditional; `apps/billing-service/src/app.ts:74-87` states the same one. They agree.

I re-derived the ordering independently — standalone probe, fastify **5.10.0**, Node 22.22.2,
eight configurations (four phase pairings × two registration orders), guard reproduced as
billing's un-`return`ed `reply.status(401).send(...)`:

```
onRequest /onRequest   auth-first   -> [auth]          401   <- shipped
preHandler/preHandler  auth-first   -> [auth]          401
onRequest /preHandler  auth-first   -> [auth]          401
preHandler/onRequest   auth-first   -> [tenant,auth]   401   <- the forbidden order
onRequest /onRequest   tenant-first -> [tenant,auth]   401
preHandler/preHandler  tenant-first -> [tenant,auth]   401
onRequest /preHandler  tenant-first -> [auth]          401   <- not in Round 2's table
preHandler/onRequest   tenant-first -> [tenant,auth]   401   <- forbidden in both orders
```

Row 7 is one Round 2 did not run, and it is the row that actually establishes the docblock's
wording: an `onRequest` guard beats a `preHandler` tenant hook **even when the tenant hook is
registered first**, which is what "*whatever order they are registered in*" asserts. The crossed
pairing is forbidden in both registration orders, exactly as both texts now say. Both files are
accurate.

---

### Findings — all follow-up

#### MEDIUM-1 (R3) · S-39's reproduced grep output was falsified by the same commit that shipped it

`.claude/rules/known-gaps.md:1683-1688` presents a fenced block as verbatim command output:

```
$ grep -rn '"x-tenant-id"' apps/*/src packages/*/src --include=*.ts | grep -v dist
apps/gateway/src/constants.ts:14:  TENANT_ID: "x-tenant-id",
apps/usage-service/src/constants.ts:16:  TENANT_ID: "x-tenant-id",
packages/shared-types/src/index.ts:93:  TENANT_ID: "x-tenant-id"
```

Re-ran that exact command on the shipped tree. It returns **four** lines, and the shared-types
constant is at **`:104`**, not `:93`:

```
apps/gateway/src/constants.ts:14:  TENANT_ID: "x-tenant-id",
apps/usage-service/src/constants.ts:16:  TENANT_ID: "x-tenant-id",
packages/shared-types/src/index.ts:87: * `grep -rn "x-tenant-id" apps/auth-service/src --include=*.ts` returns nothing. See
packages/shared-types/src/index.ts:104:	TENANT_ID: "x-tenant-id"
```

**It was already wrong in the commit that shipped it**, not rotted by T-042:
`git show 5cb454a:packages/shared-types/src/index.ts | grep -n x-tenant-id` gives `87` and `104`
at `5cb454a` itself, identical to HEAD.

**The cause is Round 2's own LOW-2 fix.** That fix lengthened the `TENANT_CONTEXT_HEADERS`
docblock — pushing the constant from `:93` to `:104` — and added, at `:87`, a self-verifying grep
containing the literal `"x-tenant-id"`. So S-39's command now matches a comment inside the fix for
LOW-2, in the same commit, in the same file. This is **S-33**'s named sub-pattern —
*"a comment carrying its own verification command matches itself"* — occurring inside the
authoritative file, introduced by the rework that answered the review that created it.

**The conclusion survives and the evidence does not.** There are still three *definitions*: the
fourth match is prose. Graded MEDIUM rather than HIGH on that basis — the block is false as
reproduced output, but no claim drawn from it is wrong, and `x-tenant-id` itself is unchanged and
byte-identical in all three definitions (re-checked).

**Fix**: `.claude/rules/known-gaps.md:1683-1688` — replace the block with the four-line output,
cite `:104`, and add one clause naming the fourth line as this entry's own pattern matching a
docblock comment rather than a fourth definition. Fold it into whichever task closes S-39, or into
the next change that already owns `known-gaps.md`.

#### MEDIUM-2 (R3) · The surviving BU74c claim is a universal wider than the record that supports it

Three places, one of them authoritative:

- `.claude/rules/known-gaps.md:1900` — *"That has held in **every run at every gate**, in every
  database state any gate was in."*
- `apps/billing-service/tests/invoice.repository.unit.test.ts:528` — same sentence.
- `docs/plans/t-046-invoice-list-endpoint.md:645` — *"reddens **BU74c**, in every run at every
  gate"*.

This review's own committed Round-2 text refutes the quantifier. `docs/reviews/t-046-invoice-list-endpoint.md:597-599`
records that of the Gate-3 rework's exploratory series, *"BU74c's individual outcome was recorded
in only **14 of the 20**."* The passage that said so was deleted with the rest of the run tables
(correctly — it was part of the material Round 2 asked to go), and the universal it qualified was
kept. So six runs of this mutation have **no BU74c record at all**, and "every run" is asserted
over them.

The substance is well-evidenced and I am not disputing it: Gate 4 ran it once red, Gate 5's QA
recorded `Tests 2 failed | 160 passed (162)` *"with BU74c **and** BI16 named"* 7/7
(`docs/qa/t-046-invoice-list-endpoint.md:406-408`), and Gate 6 recorded 13/13. What is
over-claimed is the quantifier, in the entry whose entire thesis is that four gates were burned by
exactly this move.

Second, smaller: the trailing clause *"in every database state any gate was in"* is decorative to
the point of misleading. The **next sentence** says BU74c *"asserts the `orderBy` argument against
a Prisma mock and **never reaches the database**"* — so database state cannot be a variable for it,
and listing it as a dimension the claim survived reads as breadth of evidence where there is none.
`.claude/rules/review-standards.md` § *Universals Must Cite Their Mutation* is explicit that a
claim established by probes varying one dimension is not established by naming a second.

**Not verified by execution, and here is why.** Refuting or confirming it means applying the
tie-break mutation and running the suite, which requires editing a committed tree this review was
instructed not to modify — and the brief separately rules the mutation out of scope. This finding
therefore rests on **the record**, specifically this file's own committed Round-2 text, not on a
run of mine. Stated as reasoning, not measurement.

**Fix**: at all three sites, replace *"in every run at every gate, in every database state any
gate was in"* with what the record supports, e.g. *"in every run whose individual outcome was
recorded — 1 at Gate 4, 7 at Gate 5, 13 at Gate 6; a 20-run exploratory series at the Gate-3
rework recorded BU74c's outcome in only 14 of the 20"* and drop the database-state clause, since
the very next sentence explains why it cannot be a variable.

#### LOW-1 (R3) · The plan still carries the un-conditioned "forced" universal in the two places the rework did not reach

Round 1's LOW-1 fixed `app.ts`; Round 2's LOW-1 fixed `tenant-context.middleware.ts`. The plan has
**three** more instances and the rework corrected one:

- `docs/plans/t-046-invoice-list-endpoint.md:108` — heading, *"**Decided: `onRequest`, and it is
  forced.**"* **Mitigated**: the correction sits at `:122-131` in the same section and names the
  three correct pairings. This is S-32's residual shape — wrong text where the reader first meets
  it, correction below — but it is at least signposted within the section.
- `:826` — §11's approval-gate summary: *"**D3** `onRequest` for both hooks (**forced by
  measurement, not chosen**)"*. **Not mitigated.** Nothing near it conditions it, and this is the
  line a reader skimming "what was decided" lands on.
- `:846` — *"**D3** — `onRequest` hook phase? *Recommend yes, and it is forced by probe P8/P13.*"*
  **Not mitigated.**

My probe above shows the bare claim is false as stated: three of the four phase pairings order
correctly. LOW rather than higher because `docs/plans/` is explicitly *not* an authoritative record
(`CLAUDE.md`), and because the decision itself — both hooks `onRequest`, guard first — is correct
and unchanged.

**Fix**: `:826` → *"`onRequest` for both hooks — the pairing is a choice among three that order
correctly; what is forced, given tenant-context is `onRequest`, is that the guard is too and is
registered first"*. Same clause at `:846`. Follow-up only.

#### NIT-1 (R3) · The mandated gate wrote one key to Redis db 0

Disclosure against the brief's constraint, not a finding against T-046. `pnpm test --force`
leaves db 0 holding `denylist:b6814dd2e6e795c0e6d0a41e3a251b64` (TTL 815 s) beside the real
`telemetry:events` stream. That is **S-22** firing exactly as documented — auth-service's
integration suite hard-codes `redis://localhost:6379`, resolving to db 0 — and it is unavoidable
while running the gate this review was asked to run. Nothing was flushed, `telemetry:events`
survives, and the key self-expires. Unchanged by T-046; already recorded at Round 2. db 12/13/14/15
all at 0.

---

### On the process question the brief asked me to rule on

**Was the orchestrator's grep-and-diff verification adequate for what it claimed to cover?**
**Yes for the six conditions; no for their collateral effects — and that is demonstrated, not
hypothesised.**

Adequate for the six: every one discharges under my own re-derivation, including the two I
re-measured by execution (MEDIUM-2's Prisma error text, LOW-1's eight fastify configurations)
rather than by inspecting the diff. A grep for the deleted strings is in fact the *right*
instrument for HIGH-1, HIGH-2 and MEDIUM-1, because those three asked for deletions and a grep
returning 0 is a stronger check on a deletion than reading is.

Inadequate for the rest, concretely: **MEDIUM-1 (R3) is the thing that verification could not
see.** S-39's grep block sits in an *unchanged* hunk of a *changed* file, and was falsified by the
LOW-2 fix several hundred lines away in a different package. A diff-of-the-diff cannot surface
that; only re-running the *other* entries' commands can, which is what a reviewer does and what a
fix-confirmation pass does not. The cost was small here — a stale block whose conclusion still
holds — but the mechanism is general, and it is the second-order form of the very pattern S-33
catalogues.

**The commit message is an honest record.** Each of its three gate lines matches the artifact:

- *"pre-QA gate: CONDITIONAL, fixes applied"* — Round 1's verdict is `CONDITIONAL` (`:9`).
- *"QA gate: FAIL on one documentation defect, corrected"* — `docs/qa/…:14` is `# FAIL`, and `:23`
  and `:38` say the FAIL **is** F-1 and that *"Everything else is PASS. Findings F-2 to F-5 are
  LOW/NIT and none of them blocks."* F-1 is a claim-accuracy defect, so "one documentation defect"
  is accurate and not a rounding-up of five findings to one.
- *"final gate: CHANGES REQUESTED; fixes applied and verified by diff rather than a further review
  round"* — Round 2's verdict is `CHANGES REQUESTED` (`:467`), and the message **volunteers the
  weakness in its own verification** rather than implying a review it did not have. That sentence
  is the reason this round could be scoped at all.

Its counts also reconcile: *"37 added. billing-service 162/162"* — `it("` across
`apps/billing-service/tests` is **125** at `ed670b3` and **162** at `5cb454a`, and T-045's message
independently records `125`. 162 − 125 = 37.

---

### Compile-time gate — all 13 packages, `--force`, 0 cached on every task

Run at HEAD `73e01ed` on the committed tree. Every task reported `cache bypass, force executing`;
`Cached: 0 cached` on all four.

| Task | Result |
|---|---|
| `pnpm typecheck --force` | **13 successful, 13 total** · 0 cached · 13.0 s · exit 0 |
| `pnpm lint --force` | **13 successful, 13 total** · 0 cached · 29.5 s · exit 0 · **0 errors, 14 warnings** |
| `npx turbo run build --force` | **13 successful, 13 total** · 0 cached · 15.3 s · exit 0 |
| `pnpm test --force` | **13 successful, 13 total** · 0 cached · 19.1 s · exit 0 · **899 tests** |
| `pnpm test:smoke` | 6 services, 1 test each, all green |

**Per-package test totals — all 13 report, none skipped:**

| Package | Tests | | Package | Tests |
|---|---|---|---|---|
| `worker-service` | 234 | | `shared-utils` | 18 |
| `usage-service` | 230 | | `shared-validation` | 15 |
| `auth-service` | 166 | | `shared-types` | 8 |
| `billing-service` | **162** | | `shared-config` | 4 |
| `gateway` | 38 | | `shared-logger` | 4 |
| `analytics-service` | 18 | | `shared-tracing` | 2 |
| `web` | 0 (task runs, no cases) | | **Total** | **899** |

899 is the expected figure. billing-service is **162**, unchanged from what T-046 shipped.

**Lint: 14 warnings, every one proved pre-existing, 0 `no-unsafe-return`.**

| Rule | Count | File | `git log -1` |
|---|---|---|---|
| `@typescript-eslint/no-misused-promises` | 10 | `apps/auth-service/tests/auth.service.unit.test.ts` | `d68e719` · 2026-08-25 |
| `@typescript-eslint/no-unsafe-assignment` | 4 | `apps/usage-service/tests/ingestion.service.unit.test.ts` | `b0f6921` · 2026-08-31 |

Both dates precede `5cb454a`, and `git show --name-only 5cb454a` touches **neither** file — so
these cannot be T-046's. `grep -c no-unsafe-return` on the full lint output → **0**.

---

### Environment, and the state I left

- PostgreSQL **16.13**, host service, left running. Read-only throughout: `count`, `pg_available_extensions`,
  `show shared_preload_libraries`, and three `findMany` calls that raised `PrismaClientValidationError`
  before reaching the server. No write, no DDL, no `v1_7` rollback, no role dropped.
- **Row counts on exit**: `Event 0`, `UsageLine 0`, `Invoice 0`, `InvoiceLineItem 0`, `Meter 0`,
  `Tenant 2` — the required end state.
- Redis left running. I issued no write; the mandated `pnpm test` wrote one TTL'd `denylist:*` key
  to db 0 (NIT-1 above). db 12/13/14/15 at 0.
- Three temporary probe scripts were created inside `apps/billing-service/` so Node could resolve
  `@prisma/client` and `fastify`, and **all three were removed**. Verified with `git status --porcelain`
  after each.
- **Nothing committed, staged or branched.** `git status --porcelain` at close shows one entry —
  `M docs/reviews/t-042-invoice-generation-job.md` — which is **not mine**: it appeared between my
  first and second `git status` calls, is a `## Round 3` append to the *T-042* review by the
  orchestrating session running concurrently, and I did not touch it. My only write is this
  section. Round 1 and Round 2 above are unmodified.

### What I could not verify, and why

- **Whether BU74c reddens in the six unrecorded runs** (MEDIUM-2 R3). Needs the tie-break mutation,
  which means editing a committed tree I was told not to modify, and which the brief rules out of
  scope. The finding is reasoning from this file's own committed record, and is labelled so.
- **BI16's behaviour under the mutation.** Deliberately not re-opened, per the brief. I did not run
  it and I make no claim about it beyond confirming that the *text* now claims nothing beyond
  "not reproducible, cause not established" — which it does, at all three sites.
- **F-4 live** (`?status[]=DRAFT`). Confirmed at code level only: `invoiceListQuerySchema`
  (`src/validators/invoice-list.validator.ts`) has no `.strict()`. Not driven over HTTP; no service
  was started this round.
- **Whether `5cb454a` itself was green.** I ran the gate at HEAD, not at the shipped commit — a
  checkout would dirty the tree. 899 at HEAD is consistent with the message's 843 plus T-042, but I
  did not re-run 843.

### Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| S-39's grep block is stale, in `.claude/rules/` | **Follow-up (MEDIUM-1 R3).** Conclusion holds; fix the block in whichever task next owns `known-gaps.md`. |
| BU74c's "every run at every gate" universal | **Follow-up (MEDIUM-2 R3).** Substance sound, quantifier unsupported; three sites, one authoritative. |
| Plan's `:826`/`:846` "forced" universal | **Follow-up (LOW-1 R3).** Plan file only; decision itself correct. |
| BI16 remains a non-deterministic guard | **Accepted and now correctly documented.** S-41 says so and says the cause is unknown. BU74c is the guard. |
| S-40 — unbounded `page` reaches a `500` | **Correctly filed, not fixed.** Re-measured at the Prisma layer this round; S-40's account is accurate throughout. |
| S-39 — two legacy `x-tenant-id` literals | Still open and still accurate in substance. Re-checked: all three definitions byte-identical. |
| S-22 — auth-service writes to Redis db 0 | Observed again (NIT-1). Unchanged by T-046. |
| S-24 — stale `.claude/rules/` snapshot | **Fired again this session**: the injected `known-gaps.md` ended at S-39 and could not see S-40 or S-41. Recovered by `cat`. Third recorded sighting; worth adding to S-24's list. |
| F-3 / F-4 / F-5 | **Discharged** — plan `:785-816`, plus the `toAmountString` docblock note. |

**Recommend adding to `.claude/rules/known-gaps.md`, out of scope to fix here:** S-24 should gain
this third sighting, since its own text says the evidence base is "the two sightings" and a third
independent one bears on whether the working practice is holding.

### Gate

**`APPROVED FOR COMMIT` — retrospectively.** Round 2's six conditions are discharged; the two that
could be checked by measurement rather than by reading both re-derive exactly, including one
configuration Round 2 did not run. The record is now closed honestly: the change shipped against an
open verdict, the commit message said so in its own words, and the fixes hold.

The three findings above are **follow-up work**, not conditions. None is a code defect, none
touches tenant isolation, injection, correctness or the error contract, and the gate is green at
899/899 across 13 packages with 14 proved-pre-existing lint warnings and zero errors.

### Decisions for you

**R3-D1 · Where do the three follow-ups get fixed?** *One sentence:* MEDIUM-1 and MEDIUM-2 are wrong
text in `.claude/rules/known-gaps.md`, which `CLAUDE.md` designates authoritative — so leaving them
until "whenever" has a cost the LOW grading understates.

| Option | What changes |
|---|---|
| **A · Fold into the next task that already owns `known-gaps.md` (recommended)** | No new task. The next `/ship` corrects `:1683-1688`, `:1900`, `invoice.repository.unit.test.ts:528` and the plan's three lines as part of its own diff. **Diff: ~8 lines of text, no code, no tests.** Zero risk of a fifth mechanism being invented, because all three fixes are *narrowings*. |
| B · One small docs task now | Same diff, its own commit and its own review. Cleaner history; costs a full gate run for eight lines of prose. |
| C · Leave all three | Nothing changes. Accepts that an authoritative file carries one falsified command block and one unsupported universal, in the entry that exists because four gates were burned by unsupported universals. |

**Recommendation: A.** All three are subtractive, none can regress behaviour, and the gate is
already green. B is defensible if you want the correction traceable to its own commit; C is the
only option I would argue against, and only because of *which* file it is. **None of the three
changes the diff of any shipped code** — this is a preference about sequencing, not about content.

**R3-D2 · Does S-24 get this session's sighting appended?** *One sentence:* the injected
`.claude/rules/known-gaps.md` ended at S-39 again, which is a third data point for an entry that
currently says its whole evidence base is two.

| Option | What changes |
|---|---|
| **A · Append it (recommended)** | Two lines in S-24 recording the T-046 Round-3 sighting and that the recovery was again `cat`-from-disk. **Diff: 2 lines.** |
| B · Do not | S-24 keeps claiming two sightings when there are three, and the argument that the recovery depends on reviewer suspicion loses its third supporting case. |

**Recommendation: A**, folded into whichever change takes R3-D1. Preference, not a diff change.
