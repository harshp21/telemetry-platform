# Review — T-045 · Internal metering endpoint (`POST /v1/internal/billing/generate`)

**Gate 4 — Senior Reviewer, pre-QA.** Base `7f359db`; subject is the uncommitted working tree.
Read-only: every mutation below was applied, measured, and reverted; the tree was verified
byte-identical afterwards (429 tracked `.ts`/`.md`/`.sql`/`.json`/`.mjs` files under
`apps/ packages/ prisma/ docs/ .claude/`, `md5sum` diff empty, `git status --porcelain` diff empty).

---

## Round 1

**Verdict: CONDITIONAL** — two MEDIUM fixes required before commit (M-1, M-2), plus one decision
to return to the user (D-A). Nothing in tenant isolation, injection, or the clean-code gate blocks.

---

### Findings

#### MEDIUM-1 · `createDraftInvoice` hard-fails above 32 764 usage lines, and the ceiling is measured

`apps/billing-service/src/repositories/invoice.repository.ts:210-213`

```ts
const marked = await tx.usageLine.updateMany({
  where: this.where({ id: { in: [...input.usageLineIds] }, billed: false }),
  data: { billed: true }
});
```

`sumUnbilledByMetricKey` (`:156`) does `findMany({ where, select: { id: true } })` with no `take`,
so `usageLineIds` is every unbilled `UsageLine` in the period. Prisma expands `id: { in: [...] }`
into an inline `IN ($4,$5,…)` with **one bind variable per id** — not `= ANY($1)`. Measured on this
tree (@prisma/client 6.19.3, PG 16.13, against `telemetry_app`, matching zero rows so nothing was
written; `UsageLine` re-counted at 0 after):

| ids | result |
|---|---|
| 10 | SQL 198 chars |
| 1 000 | SQL 5 066 chars |
| 20 000 | SQL 129 070 chars |
| **32 764** | **OK** |
| **32 765** | **`P2035` — `too many bind variables in prepared statement, expected maximum of 32767, received 32768`** |
| 65 000 / 70 000 | `P2035` |

So a tenant with more than 32 764 unbilled `UsageLine` rows in one period can never be invoiced:
`P2035` is not `P2002`, `isUniqueConstraintError` (`:51-58`) returns `false`, the error is
re-thrown, and `InternalController.generate` (`:140-143`) answers `500 INTERNAL_ERROR` with a body
that says nothing. Every retry fails identically. At one `UsageLine` per event — which is what
worker-service writes — 32 764 events in a billing period is an ordinary tenant, not an extreme one.

It **fails closed**: the throw is inside `withTenant`'s `$transaction`, so the invoice and its line
items roll back and no `UsageLine` is marked billed. That part is reasoning from the code path
(I did not seed 32 765 rows to execute it end to end), not measurement — the 32 764/32 765 boundary
itself is measured.

R5 in the plan anticipates a `Decimal(18,6)` overflow and records it; this bound is closer and was
not considered. Note also that `sumUnbilledByMetricKey` holds every id in process memory
regardless of the update.

**Fix:** chunk the update inside the same transaction and compare the summed count against
`expectedCount`, so the count assertion's semantics are unchanged:

```ts
const CHUNK = BILLING_METERING.BILLED_UPDATE_CHUNK_SIZE; // e.g. 5_000, in constants.ts
let markedCount = 0;
for (let i = 0; i < input.usageLineIds.length; i += CHUNK) {
  const { count } = await tx.usageLine.updateMany({
    where: this.where({ id: { in: input.usageLineIds.slice(i, i + CHUNK) }, billed: false }),
    data: { billed: true }
  });
  markedCount += count;
}
if (markedCount !== expectedCount) throw new UsageLinesChangedError(expectedCount, markedCount);
```

Add a unit case asserting `updateMany` is called `ceil(n / CHUNK)` times for `n > CHUNK` and that
the counts are summed before the comparison. If chunking is judged out of scope for T-045, the
ceiling must at least be written into `.claude/rules/known-gaps.md` with the measured number —
do not let it evaporate.

---

#### MEDIUM-2 · The `P2002 meta.target` claim is under-scoped in exactly the dimension that controls it

`apps/billing-service/src/constants.ts:62-67` states:

> Measured at Gate 1 on @prisma/client 6.19.3: the raised error's `meta.target` was `null` …
> (Scope: one unique constraint, one Prisma version — read it as "the field carried no
> information here", not as a law about Prisma.)

Repeated at `apps/billing-service/src/repositories/invoice.repository.ts:228-230`
("The raised error's `meta.target` was `null` when measured") and in the plan's D2/R1.

The *shipped behaviour* is right — on the production path `target` **is** `null`, so the re-read is
necessary and `isUniqueConstraintError` correctly keys on `code` alone. But the scope note names
two dimensions that do not matter and omits the one that does. Varied one dimension at a time
against a real duplicate `Invoice` insert, all rows deleted and re-counted afterwards:

| # | Connection | Shape | `meta` |
|---|---|---|---|
| A | owner | plain `create` | `{"modelName":"Invoice","target":["tenantId","periodStart","periodEnd"]}` |
| B | owner | `$transaction` + `set_config` | `…"target":["tenantId","periodStart","periodEnd"]` |
| C | owner | `$transaction`, no `set_config` | `…"target":["tenantId","periodStart","periodEnd"]` |
| D | owner | plain `create`, nested `lineItems` | `…"target":["tenantId","periodStart","periodEnd"]` |
| E | `telemetry_app` | `$transaction` + `set_config` | **`{"modelName":"Invoice","target":null}`** |

B versus E differ only in the connection role, and that is what flips the field. Transaction,
`set_config`, and the nested create are all irrelevant. (Mechanism not established — I did not
determine *why* the restricted role loses it, and the review should not assert one.)

Why this matters rather than being pedantry: the next person to debug this path will almost
certainly do it through `DIRECT_DATABASE_URL`, because that is the connection the fixtures use.
They will see a populated `target`, conclude the comment is stale, and "simplify"
`createDraftInvoice` to discriminate on `meta.target` — which then silently stops working under
`telemetry_app`, i.e. in production, on the path the epic calls idempotent. The test double at
`invoice.repository.unit.test.ts:116-124` seeds `meta: { target: null }`, so nothing in the suite
would notice.

**Fix:** replace the parenthetical at `constants.ts:66-67` with the measured dimension, e.g.
*"Scope: measured on the `telemetry_app` connection, where `target` is `null`. On the owner
connection the same violation returns `target: ["tenantId","periodStart","periodEnd"]` — the
connection role is the variable, not the constraint count or the Prisma version. Do not reintroduce
a `meta.target` branch on the strength of an owner-connection observation."* Mirror the correction
at `invoice.repository.ts:228-230` and in the plan's D2 "Universal, and here is its mutation"
paragraph, which currently offers "add a second unique constraint" as the refuting edit — the
cheaper refuting edit is "run it as the owner", and it refutes.

---

#### MEDIUM-3 · The plan's S6 refuting-mutation claim is false on this host and was not corrected

`docs/plans/t-045-internal-metering-endpoint.md:551`

> **BI7** must go red while **BI2** (UTC-default session) stays green.

Re-performed the exact mutation — `InvoiceRepository.findByPeriod` rewritten as `$queryRaw` with
bound JS `Date`s against `"Invoice"`:

```
× BI2 - a second call returns the same invoice id with 200 and creates no duplicate
× BI7 - the period predicates resolve in UTC on a session pinned to a non-UTC zone
  Tests  2 failed | 11 passed (13)
```

**BI2 also goes red here.** The parenthetical "(UTC-default session)" is wrong about this machine:
`show timezone` → `Asia/Kolkata`, source `configuration file`. BI2 runs on the ambient session, and
the ambient session is not UTC. The asymmetry the plan describes holds on a UTC server (CI), not on
this one.

The Gate-3 checklist at `:665` records *"BI7 confirmed red under the raw-SQL mutation before it is
believed"* and nothing about BI2, and no correction appears anywhere in the plan file
(`grep -n "BI2"` returns four hits, none of them a correction). If this was reported verbally at
handoff, it did not reach the artifact, and the plan is part of the commit.

The **second half** of the claim does hold, and I verified it: with the same raw-SQL defect present
and `INTEGRATION_SESSION_TIME_ZONE.AHEAD_OF_UTC` changed from `"Asia/Kolkata"` to `"UTC"`, BI7
passes (`1 passed | 12 skipped`). So BI7's own pin is load-bearing and the guard is real — the
`known-gaps.md` wording of this (`.claude/rules/known-gaps.md:487-492`) is accurate.

**Fix:** amend `:551` to what was measured — *"BI7 must go red. On a UTC server BI2 stays green and
BI7 is the only signal; on a non-UTC server (this host, `Asia/Kolkata`) BI2 goes red as well,
because it runs on the ambient session. BI7's own pin is what makes the case a guard rather than a
restatement of the server default — verified by re-pinning it to UTC under the same defect, where
it passes."*

---

#### LOW-1 · `known-gaps.md` S-19 table cites a line that is five lines off

`.claude/rules/known-gaps.md:481` — `apps/billing-service/src/repositories/invoice.repository.ts:87`.
`grep -rn "extends TenantScopedRepository" apps/*/src` puts the class declaration at **`:92`**;
`:87` lands in the middle of the class docstring. The other three rows are exact
(`usage.repository.ts:150`, `event.repository.ts:64`, `meter.repository.ts:35`), and the
load-bearing claims are all true — nine matches total, four real subclasses, three services,
billing over an unpinned copy (`grep -c TimeZone` → `0` for billing's `base.repository.ts`).
Correct `:87` → `:92`. `known-gaps.md` is designated authoritative, so citations in it get held to
the same bar as the prose.

#### LOW-2 · `UsageLinesChangedError` is a `500`

`apps/billing-service/src/errors/index.ts:68-78` maps it to
`BILLING_RESPONSES.HTTP_STATUS_INTERNAL_ERROR`. A concurrent writer is not a server fault; a `500`
pages an operator for a condition whose correct response is "retry". `409 CONFLICT` is the
conventional mapping and `registerGlobalErrorHandler` already uses `409` for `P2002`
(`packages/shared-utils/src/index.ts`), so a `409` here would be consistent rather than novel. The
plan never states the status choice — D2 discusses the assertion, not its HTTP surface. Flagged as
LOW rather than MEDIUM because the behaviour (rollback, nothing billed) is correct either way.
Offered as decision **D-B** below.

#### LOW-3 · Redundant second meter lookup

`apps/billing-service/src/services/billing.service.ts:125` calls
`this.meterFor(firstTotal.metricKey, metersByKey).currency` after `priceLine` (`:149`) has already
resolved the same meter for the same key. `currencies[0]` at `:107` is the identical value and is
already computed. Not a bug — the batch check at `:102-105` guarantees the lookup succeeds — but it
re-derives a value one line above its use and reads as a third guard when it is not one.

#### NIT-1 · `"not-the-secret"` duplicated

`apps/billing-service/tests/internal-billing.route.test.ts:101` and
`apps/billing-service/tests/billing.integration.test.ts:350`. `.claude/rules/constants.md` applies
to tests; a third copy would be the threshold. Promote to `integration.constants.ts` or leave and
note it.

#### NIT-2 · `errors/index.ts` reformats seven pre-existing lines from tabs to spaces

`git show 7f359db:apps/billing-service/src/errors/index.ts | grep -Pc '^\t'` → `7`; the working
copy → `0`. The rewritten block is `InternalApiSecretMissingError`, which the change legitimately
touches (literal `500` → `BILLING_RESPONSES.HTTP_STATUS_INTERNAL_ERROR`), and the result matches
the rest of billing's `src/` (only `base.repository.ts` and `index.ts` still use tabs). So this is
convergent, not gratuitous — but S-12 says do not reformat as a side effect, and it is worth one
line in the commit message rather than a silent diff.

#### NIT-3 · No integration case pins the *lower* bound's inclusivity

`BI1b` seeds a line exactly at `periodEnd` and one before `periodStart`, but none exactly **at**
`periodStart`. Measured: mutating `gte` → `gt` in `sumUnbilledByMetricKey` reddens **only** `BU21`
(the unit-level `where`-shape assertion); mutating `lt` → `lte` reddens `BU21` **and** `BI1b`. BU21
is a real shape assertion, not vacuous, so this is coverage symmetry rather than a hole. Adding a
fifth fixture line at `USAGE_INSTANT_AT_PERIOD_START` would make BI1b catch both directions.

#### NIT-4 · `MeterCurrencyConflictError` message order is database-dependent

`errors/index.ts:51-59` joins `currencies` in the order `findActiveAsOf` returned the meters, which
follows `orderBy: { activeFrom: "desc" }` and is otherwise unspecified. The error text can differ
run to run for the same data. Sorting before joining would make the message stable.

---

### Decisions to return

#### D-A · Should billing refuse a soft-deleted tenant? *(you asked me to rule on this — I rule "as shipped is right", with one caveat)*

`InvoiceRepository.tenantExists` (`invoice.repository.ts:102-109`) counts `Tenant` by id with no
`deletedAt` predicate, so a soft-deleted tenant is treated as existing and is invoiced normally.

What I verified: `Tenant.deletedAt` exists (`prisma/schema.prisma:17`) and **nothing on the
platform ever writes it** — `grep -rn "deletedAt" apps packages prisma --include=*.ts
--include=*.prisma` (excluding `dist/`) returns exactly three lines: the schema column, a
`deletedAt: null` in `prisma/seed.ts:24` (a script that cannot run, S-13), and the comment under
review. The RLS policy is `tenant_self_select USING (id = current_setting('app.tenant_id', true))`
— no `deletedAt` term either, so the database does not have an opinion.

| Option | What changes |
|---|---|
| **A — keep plain existence** *(recommended, and what is shipped)* | Nothing. The docstring at `:98-100` already records the choice as deliberate. |
| B — refuse a soft-deleted tenant (`404`) | One predicate (`where: { id: tenantId, deletedAt: null }`) + one integration case seeding `deletedAt`. **Changes the diff.** |
| C — invoice it, but log a warning | Two lines in `BillingService`; no contract change. Preference, not correctness. |

**Recommendation: A.** Inventing a billing-time soft-delete policy with no writer, no product
decision, and no other consumer is exactly the kind of silent resolution `CLAUDE.md` tells agents
to refuse; and the *safe* default here is arguably A anyway — refusing to invoice a
recently-deleted tenant loses revenue for usage already incurred, which is D1's own argument
pointed at a different target. **Caveat:** this belongs in `docs/epics/README.md` as an open
question rather than only in a repository docstring, because the moment anything writes
`deletedAt` — an account-closure flow in Epic 4 or 11 — billing's behaviour becomes a contract
nobody chose. Recommend a one-line entry in `.claude/rules/known-gaps.md` under a new id:
*"`Tenant.deletedAt` has no writer and no reader; billing (`tenantExists`) treats a soft-deleted
tenant as live. Decide the policy before the first writer lands."*

#### D-B · `USAGE_LINES_CHANGED` — `500` or `409`?

| Option | What changes |
|---|---|
| **A — `409 CONFLICT`** *(recommended)* | `errors/index.ts:75` status constant, `BU26`/`BU27` unchanged (they assert the error type, not the status), one new controller/route case. **Changes the diff, ~4 lines.** |
| B — keep `500` | Nothing. |

**Recommendation: A** — the condition is a lost race, is retryable, and is caused by another
client, not by the server. `409` is already this repo's code for "a concurrent writer got there
first" (`registerGlobalErrorHandler`'s `P2002` mapping). Keeping `500` means every benign
scheduler collision pages someone. This is a contract decision, not a preference, because T-046's
caller will branch on it.

---

### What I verified (by execution)

**Compile-time gate, all with `--force`, 13/13 packages:**

| Task | Result |
|---|---|
| `npx turbo run typecheck --force` | `Tasks: 13 successful, 13 total · Cached: 0 cached, 13 total` — 0 errors |
| `npx turbo run lint --force` | `13 successful, 13 total` — 0 errors, **14 warnings** |
| `npx turbo run build --force` | `13 successful, 13 total` |
| `npx turbo run test --force` | `13 successful, 13 total` — **805 tests, 0 failures** (this row read *820* when written, which nothing reproduces. **The tree Gate 4 reviewed totalled 800** — non-billing is 681 and billing was 119, per the itemised list below. It became 805 after MEDIUM-1's rework and **806** after BI13. The 805 first written here was itself measured on a tree this gate never saw; corrected at Gate 5 QA-3, then qualified at Gate 6 R2-NIT-1) |
| `pnpm test:smoke` | 6 suites, 7 tests, all pass, exit 0 |

Per-package test counts (full, untruncated output): `shared-config` 4 · `shared-types` 8 ·
`shared-tracing` 2 · `shared-logger` 4 · `shared-validation` 15 · `shared-utils` 18 ·
`analytics-service` 18 · `gateway` 38 · `usage-service` 230 · **`billing-service` 12 files / 119
tests** · `auth-service` 164 · `worker-service` 180 · `web` `--passWithNoTests`. Billing at
`7f359db` was 5 files / 35 tests, so **+7 files / +84 tests**, matching the handoff.

**Warnings — all 14 pre-existing, proven, zero `no-unsafe-return`:**
10 × `no-misused-promises` in `apps/auth-service/tests/auth.service.unit.test.ts`
(`git log -1` → `d68e719`) and 4 × `no-unsafe-assignment` in
`apps/usage-service/tests/ingestion.service.unit.test.ts` (`git log -1` → `b0f6921`). Neither file
appears in `git diff --name-only`. No new warning of any kind.

**Tenant isolation — all three `InvoiceLineItem` commitments hold, and I tried to write the bug.**

Independently re-derived the gap at the DB layer as `telemetry_app` (`rolsuper = f`,
`rolbypassrls = f`), inside one transaction, rolled back, counts re-checked at `2|0|0` after:

```
Invoice          relrowsecurity=t  relforcerowsecurity=t  policy invoice_tenant_isolation (cmd *)
InvoiceLineItem  relrowsecurity=f  relforcerowsecurity=t  no policy

as tenant A: INSERT Invoice(tenantId=B)     -> ERROR: new row violates row-level security policy
switch app.tenant_id -> B:
  B_sees_A_invoice                  = 0
  B_sees_A_lineitem                 = 1
  B_wrote_lineitem_onto_A_invoice   = 1     <- INSERT succeeds
  B_updated_A_lineitem              = 1     <- UPDATE succeeds
  B_deleted_A_lineitem_remaining    = 0     <- DELETE succeeds
```

So `"InvoiceLineItem"` is fully readable *and writable* cross-tenant by any holder of the
`telemetry_app` credential, and `"Invoice"`'s `WITH CHECK` is the only thing stopping the invoice
itself. That is exactly what BI9 asserts and what the repository docstring claims; the mitigation
is therefore load-bearing, and I confirmed all three parts of it:

1. **Nested create only.** `grep -rn "invoiceLineItem\." apps packages --include=*.ts` (excluding
   `dist/`) matches **nothing outside `apps/billing-service/tests/`** — no production caller in the
   workspace. The only write is `lineItems: { create: [...] }` at `invoice.repository.ts:198-205`,
   inside the `withTenant` that creates the invoice, whose `tenantId` comes from
   `...this.where({})` at `:190`.
2. **No method takes a bare `invoiceId`.** `grep -n "^  async" invoice.repository.ts` → exactly
   four (`:102`, `:118`, `:142`, `:183`), none with an `invoiceId` or a `tenantId` parameter;
   `CreateDraftInvoiceInput` (`:30-37`) has neither field. I could not construct a path that
   reaches a line item by an `invoiceId` not scoped through an `Invoice` the bound tenant owns —
   there is no read path at all, and the sole write path derives the id from the `create` in the
   same statement.
3. **BI9 pins the gap as-is** (`billing.integration.test.ts:471-498`), asserts `rows.invoices === 0`
   and `rows.lineItems === actualLineItems.length`, and carries the "when S-10 is fixed this goes
   red" comment. It performs the `set_config` switch itself against rows this repository wrote.

`TenantScopedRepository.where` is `<T extends { tenantId?: never }>` (`base.repository.ts:85`), so
a `tenantId` in a query input is a compile error, not a convention. Both repositories are container
**factories** (`config/container.ts:52-56`), asserted by BU63.

**ORM-only commitment.** `grep -rn '\$queryRaw|\$executeRaw|Prisma\.raw|\$queryRawUnsafe|
\$executeRawUnsafe' apps/billing-service/src` returns exactly one executable hit —
`base.repository.ts:98`'s `set_config` — plus two comment lines. Confirmed.

**Injection.** No caller-supplied value reaches SQL text. The only tagged template in the service's
own code is `set_config('app.tenant_id', ${this.tenantId}, true)` with `tenantId` bound and branded
`TenantId`; everything else is ORM argument trees. No `Prisma.raw`, no enum-into-SQL variation, no
`$queryRawUnsafe`.

**Mutation table — 8 mutations applied, run, reverted:**

| # | Mutation | Red |
|---|---|---|
| M1 | `findByPeriod` → `$queryRaw` with bound `Date` | **BI2 + BI7** (plan said BI2 stays green — MEDIUM-3) |
| M1b | M1 + BI7's pin changed to `UTC` | BI7 **green** (confirms the pin is the guard) |
| M2 | `this.where({…})` → bare object literal in `MeterRepository` | BU11, BU12 |
| M3 | `updateMany` keyed on the range predicate instead of ids | BU24 |
| M4 | short count logged instead of thrown | BU26, BU27, **BI10** |
| M5 | `registerInternalBillingRoutes` moved outside the `app.register` scope | BU61, BU62, BU64 |
| M6 | batch missing-meter check removed, `meterFor` left in place | **BU40b only** (1 of 34) |
| M7 | `gte` → `gt` on the lower bound | BU21 only |
| M8 | `lt` → `lte` on the upper bound | BU21, BI1b |

**BU40b is genuine and is the find of the round.** M6 reddens exactly one case out of 34, and it is
BU40b. BU40 stays green because `meterFor` raises the same `MeterNotFoundError([storage.gb])` for
the first key it cannot resolve; BU41 stays green because it only asserts `createDraftInvoice` was
not called. The distinctive behaviour — naming *every* unpriceable key — was genuinely unpinned
before BU40b existed, and the comment at `billing.service.unit.test.ts:232-236` describes the
mutation accurately.

**BI10 is a real rollback, not a restatement of BU26.** M4 (throw → log) reddens BI10 against live
PostgreSQL, and BI10's setup bills one of the priced lines through the owner connection between the
read and the write — a genuine concurrent writer, not a mocked count. Its assertions are
post-rollback row reads through the admin client, so they cannot pass tautologically.

**The two T-044 tests were strengthened, not weakened.**
`apps/billing-service/tests/env.schema.unit.test.ts:385-393` and `:441-443` now assert
`400` + `CODE_VALIDATION_ERROR` + an explicit `not.toBe(HTTP_STATUS_UNAUTHORIZED)`. The `rejected`
half of both cases still asserts `401` and is untouched. The subject of both cases — *which secret
authenticates* — is preserved, and the `not.toBe(401)` makes a future handler change unable to pass
them on a rejection. Approved as written.

**BI8's adaptation is the right resolution.** The plan wanted
`typeof body.data…totalAmount === "string"`, which D3's envelope makes impossible — there is no
amount in the response to type-check. What shipped instead
(`billing.integration.test.ts:456-468`) asserts the exact key set
(`Object.keys(body)` → `["data"]`, `Object.keys(body.data)` → `["invoiceId"]`) plus the persisted
6-dp value and `typeof unbilled.totals[0].totalQuantity === "string"` at the normalising layer.
That is strictly stronger than the plan's version for the property that matters — a `toMatchObject`
would not notice a future field, and the exact key set will. It also asserts the Decimal property
at the one layer that can leak it. Accept.

**Decimal.** One normalisation layer (`invoice.repository.ts:61`, `meter.repository.ts:60`), both
`String(...)`; arithmetic in `Prisma.Decimal` (`billing.service.ts:117-120`, `:150`). BU47 and BI8
assert `not.toBeInstanceOf(Prisma.Decimal)` and `typeof === "string"` explicitly, which is the
right shape given that `JSON.stringify` of a `Prisma.Decimal` silently yields a string.

**`created` on the `P2002` path.** Verified by reading and by BU29/BU50: the catch returns
`{ invoiceId: existing, created: false }` and the controller maps `created` to `201`/`200`
(`internal.controller.ts:116-122`). A lost race reports `200`, not `201`. The addition of `created`
beyond the plan is correct and necessary — without it the plan's D3 mapping would be wrong on
exactly the path D2 exists to handle.

**No `DEFAULT_CURRENCY` — the reasoning holds.** Traced: `firstTotal` is defined (the `undefined`
branch returns at `:90-93`); the batch check at `:102-105` throws unless every `metricKey` resolved,
so `metersByKey` contains `firstTotal.metricKey` and `meterFor` at `:125` cannot raise there;
`meters` is therefore non-empty and `currencies.length >= 1`. No input reaches a fallback. The
constants docstring's own caveat — that `Invoice.currency` carries a database `@default("USD")`
nothing relies on — is accurate (`prisma/schema.prisma:130`). The plan's file table at `:305` still
lists `DEFAULT_CURRENCY` as a planned constant; that is a documented, justified deviation, not an
omission.

**Epic-8 E4 confirmed.** No repository method takes a `tenantId`, and `CreateDraftInvoiceInput` has
no such field, so T-048's epic signature `update(id, tenantId, data)`
(`epic-8-billing-service.md:147`) is unnecessary in the file T-048 inherits. `where`'s
`{ tenantId?: never }` constraint makes reintroducing it a compile error at the call site.

**Docs slices.**
*Q2* — `docs/epics/README.md:18` now carries the `**decided**` marker and a Day-1 notes subsection
shaped like Q10's. Q5 is still unmarked at `:14`, so the plan's supporting claim is true as stated.
*S-19* — `grep -rn "extends TenantScopedRepository" apps/*/src` returns **9 lines, 4 real
subclasses, 3 services**, exactly as the new table says; `grep -c TimeZone` on billing's
`base.repository.ts` → `0`, confirming billing is unpinned. The known-gaps prose about BI7
(`:487-492`) is accurate — I reproduced both halves. Only the `:87` citation is wrong (LOW-1).

**Gateway reachability.** `GATEWAY_PROXY_PREFIXES` (`apps/gateway/src/constants.ts:33-38`) has no
`/v1/internal` entry, and `registerProxyRoute` sets `rewritePrefix: prefix`
(`apps/gateway/src/plugins/proxy.plugin.ts:27`) — path structure unchanged — so
`/v1/billing/…` cannot be folded into `/v1/internal/billing/generate` upstream. The endpoint is not
externally reachable.

**S-8.** Items 1 and 3 remain open for billing by decision (D7) and the guard behaves as claimed:
M5 shows that removing the scoping is the mistake that would publish the endpoint, and BU61/BU62/
BU64 catch it. `internal-auth.middleware.ts:10` still writes the literal `401` — pre-existing,
untouched by this diff, and the new `BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED` constant is now
there for S-8 to adopt. Correct call not to fold it in.

**Clean-code gate.** No magic strings or numbers in the six new source files: the only string
literals are log messages (matching `usage.controller.ts` precedent), ORM field names and sort
directions. Every status, code and message is a constant; `INVOICE_STATUS_DRAFT` derives from
Prisma's generated `InvoiceStatus` enum rather than a re-typed `"DRAFT"`. Error codes live in
`constants.ts`. Test-side: all numeric statuses go through `BILLING_RESPONSES.*`; the only bare
status literals are in test *titles* and in `smoke.test.ts` (pre-existing, untouched). `"app.tenant_id"`
is written as a literal in two test files with an explicit S-19 justification — acceptable, and the
right call while S-19 is open. Disposition: **pass**, with NIT-1.

**Environment left as found.** `Tenant` 2 · `Event` 0 · `UsageLine` 0 · `Invoice` 0 ·
`InvoiceLineItem` 0 · `Meter` 0, re-counted after every probe and at the end. Postgres and Redis
left running. Tree byte-identical.

---

### What I could not verify, and why

- **The `P2035` ceiling end to end.** I measured the 32 764/32 765 boundary directly against
  `usageLine.updateMany`, but did not seed 32 765 `UsageLine` rows and drive a real
  `POST /generate`. That the failure rolls back and surfaces as `500` is read off the code path
  (`isUniqueConstraintError` keys on `code`, `P2035 !== P2002`, the throw is inside `$transaction`),
  not executed.
- **Why `meta.target` is `null` under `telemetry_app`.** Isolated the dimension by one-at-a-time
  variation; did not establish the mechanism. Stated as measurement only.
- **Behaviour on a UTC PostgreSQL server.** This host is pinned to `Asia/Kolkata` by its
  configuration file. The CI-side claim (BI2 green, BI7 red under the raw-SQL defect) is inference
  from the one-zone result plus the M1b UTC-pin result, not a CI run.
- **Performance at scale.** The plan's R6 `EXPLAIN` was taken over a 0-row table with
  `enable_seqscan=off`; I did not improve on that, and I agree it is not evidence. The
  four-transaction-per-request shape (`tenantExists`, `findByPeriod`, `sumUnbilled`,
  `findActiveAsOf`, `createDraft` — five round trips) is noted, not measured.
- **Concurrency.** BI10 simulates a concurrent writer serially through a second connection. No
  genuinely parallel two-caller race was executed, so the `P2002` re-read path is proven by unit
  double (BU29/BU30) and by reading, not by a live race.
- **The Copilot mirror.** Per S-14, `.github/agents/` may have diverged; out of scope here and not
  checked.

---

### Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| `InvoiceLineItem` RLS inert; T-045 ships the first rows into it | **Accepted** (plan R2, user-confirmed). Mitigation verified working. BI9 pins it. S-10 stays open. |
| `P2035` above 32 764 usage lines | **MEDIUM-1 — fix or record in `known-gaps.md` before commit.** |
| S-19: billing runs over a third unpinned `TenantScopedRepository` copy | **Accepted**, ORM-only commitment verified, S-19 text updated (modulo LOW-1). |
| S-8 items 1 and 3 open on a route whose `401` is now load-bearing | **Accepted** (D7). `bodyParsed = 1` cost now applies to a real schema; recorded. |
| R6 index coverage on the unbilled fetch | **Accepted**, correctly caveated as not-evidence-at-scale. |
| Redis db 0 pollution | **S-22, not caused by this change.** Observed during the mandated `pnpm test --force`: db 0 `DBSIZE` went 3 → 5, two new TTL'd `denylist:*` keys written by auth-service's integration suite; 4 remaining at the end as TTLs expire. Reported rather than rounded to green. Billing writes nothing to Redis (D9), verified — the container's client is `lazyConnect` and nothing calls `connect()`. |
| `Tenant.deletedAt` has no writer, no reader, and no decided policy | **Recommend a new `known-gaps.md` entry** (see D-A). Out of scope to decide here. |

---

### Required before commit

1. **MEDIUM-1** — chunk the billed `updateMany`, or record the measured 32 764 ceiling in
   `.claude/rules/known-gaps.md` with the `P2035` code and the fix direction.
2. **MEDIUM-2** — correct the `meta.target` scope note at `apps/billing-service/src/constants.ts:66-67`,
   `apps/billing-service/src/repositories/invoice.repository.ts:228-230`, and the plan's D2 to name
   the connection role as the controlling dimension.
3. **MEDIUM-3** — correct `docs/plans/t-045-internal-metering-endpoint.md:551` to the measured
   result (BI2 also red on a non-UTC server).
4. **LOW-1** — `.claude/rules/known-gaps.md:481`, `invoice.repository.ts:87` → `:92`.
5. **D-A and D-B** — returned to the user; D-B changes the diff if answered A.

LOW-2/3 and NIT-1…4 are dispositioned above and do not block.

**Verdict: CONDITIONAL.**

---

## Round 2 — final

**Gate 6 — Senior Reviewer, post-QA.** Base `7f359db`; subject is the uncommitted working tree
(30 entries: 12 modified, 18 untracked). Read-only: every mutation below was applied, run and
reverted, and the tree was verified byte-identical afterwards (474 files under `git ls-files` plus
the untracked set, `md5sum` diff empty, `git status --porcelain` back to 30 entries).

**Verdict: CONDITIONAL** — three one-line documentation fixes required, all in files the commit
already touches, none of them a code change and none requiring the gate to be re-run. Nothing in
tenant isolation, injection, correctness, the clean-code gate, type safety or test honesty blocks.
Round 1's MEDIUM-1/2/3 and LOW-1 are all resolved and re-verified below.

---

### Round 1 dispositions, re-checked on the tested revision

| Round 1 | Status on this tree |
|---|---|
| **MEDIUM-1** — `P2035` above 32 764 usage lines | **Fixed.** Chunked at `invoice.repository.ts:222-230` via `BILLING_METERING.BILLED_UPDATE_CHUNK_SIZE` (`constants.ts:152`). The count assertion is summed across chunks and compared against the whole id set (`:232`), not per chunk. `BI11` proves multi-chunk success against real rows; `BI12` drives 32 765 ids and asserts both `toBeInstanceOf(UsageLinesChangedError)` **and** `not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)` — so a `P2035` fails it rather than passing as "some error". Non-vacuous. |
| **MEDIUM-2** — `meta.target` scope | **Fixed.** `constants.ts:66-82` now carries the six-row table varying connection role against transaction state, states the controlling variable is the role, and explicitly says the mechanism was **not** established. That last sentence is the part that makes it honest. |
| **MEDIUM-3** — plan's S6 refuting-mutation claim | **Fixed**, and corrected again by QA-1 at `docs/plans/…:521-528`. |
| **LOW-1** — S-19 cites `invoice.repository.ts:87` | **Fixed and now exact.** See the S-19 row below. |
| **LOW-2** — `USAGE_LINES_CHANGED` was `500` | **Adopted (D-B option A).** `errors/index.ts:81` is `BILLING_RESPONSES.HTTP_STATUS_CONFLICT`; the rationale is recorded at `:68-72`. |
| **LOW-3** — redundant second meter lookup | **Addressed by documentation, correctly.** `billing.service.ts:125-128` now states it is a typing device under `noUncheckedIndexedAccess` and **not** a third guard. Re-derived: the call is at `:129`, `currencies` at `:107`. No code change needed. |
| **NIT-1** — `"not-the-secret"` duplicated | **Still two copies** — `internal-billing.route.test.ts:101` and `billing.integration.test.ts:363` (Round 1 cited `:350`; BI13's insertion moved it). Below the promotion threshold. **Pass.** |
| **NIT-2** — tabs→spaces in `errors/index.ts` | Unchanged; convergent with the rest of billing `src/`. Worth one line in the commit message. **Pass.** |
| **NIT-3** — usage window's lower bound untested at integration level | **Still open, re-measured — see R2-LOW-4.** |
| **NIT-4** — `MeterCurrencyConflictError` message order | Unchanged. **Pass**, cosmetic. |

---

### Findings

#### R2-LOW-1 · `known-gaps.md:67` cites a billing line that **this change itself** moved

`.claude/rules/known-gaps.md:67` cites `apps/billing-service/src/app.ts:29` for "reads the parsed
value". Measured:

```
git show 7f359db:apps/billing-service/src/app.ts | grep -n "const internalApiSecret"  -> 29
grep -n "const internalApiSecret" apps/billing-service/src/app.ts                     -> 26
```

The citation was exact at `7f359db`. T-045's own `app.ts` edit — collapsing the five-line
`import { … } from "./constants";` into one and adding the `registerInternalBillingRoutes`
import, net −3 lines — moved it to `:26`. The commit edits `known-gaps.md` and did not re-derive
this. The *substance* is still true (billing does read the parsed value), so this is a citation,
not a false claim.

**Fix:** `.claude/rules/known-gaps.md:67` — `apps/billing-service/src/app.ts:29` → `:26`.

#### R2-LOW-2 · `known-gaps.md:148` cites a constants range this change split apart

`.claude/rules/known-gaps.md:148` cites `apps/billing-service/src/constants.ts:25-26` for
`HTTP_STATUS_OK` / `HTTP_STATUS_UNAUTHORIZED`. Exact at `7f359db`
(`git show 7f359db:…/constants.ts | sed -n '25,26p'` → those two lines, contiguous). On this tree
T-045 inserted `HTTP_STATUS_CREATED`, `HTTP_STATUS_BAD_REQUEST`, `HTTP_STATUS_NOT_FOUND`,
`HTTP_STATUS_CONFLICT`, `HTTP_STATUS_UNPROCESSABLE_ENTITY` and `HTTP_STATUS_INTERNAL_ERROR`
between and after them, so they are now at **`:28`** and **`:31`** and are **no longer
contiguous** — the range form is wrong twice over.

**Fix:** `.claude/rules/known-gaps.md:148` — `constants.ts:25-26` → `constants.ts:28` and `:31`
(two citations, not a range).

Taken together with R2-LOW-1: the task added a *regenerating grep* for the S-19 citations it
introduced, and that worked — but it did not re-derive the pre-existing citations its own source
edits invalidated. Both are in the S-8 entry of the same file the commit is editing. Round 1
graded this exact class (LOW-1) as LOW, and I am grading consistently rather than escalating to
the "false claim in an authoritative file is HIGH" rule, because in both cases the claim is true
and only the line pointer is stale.

#### R2-LOW-3 · The plan identified a fourth S-8 divergence, said it should be recorded, and it was not

`docs/plans/t-045-internal-metering-endpoint.md` §10 closes with a **fourth S-8 divergence** and
says, verbatim, that it is "not currently listed in `known-gaps.md`" and to "Report it as a
divergence worth listing under S-8". Verified the divergence is real:

- `apps/billing-service/src/middleware/internal-auth.middleware.ts:7` —
  `Array.isArray(providedSecret) ? providedSecret[0] : providedSecret`, i.e. picks the first of a
  duplicated header.
- `apps/usage-service/src/middleware/internal-auth.middleware.ts:50` — `typeof !== "string"` is
  rejected outright, with the smuggling rationale in the comment at `:48-49`.

Verified it was **not** recorded: `sed -n '/## S-8 /,/^## S-9/p' .claude/rules/known-gaps.md`
contains no `Array.isArray`, `duplicated header` or `smuggling`. S-8 still enumerates three items.

The plan is right that this is **not** a vulnerability — its probe H1 measured that a duplicated
`x-internal-secret` arrives joined as a string over both a raw `node:http` socket and
`app.inject`, so the `provided[0]` arm is unreachable through HTTP at fastify 5.10.0 / Node
22.22.2, and the joined value fails into a `401`. That scoping is exactly right and should be
carried across verbatim. But a finding whose stated disposition is "record it" and which is then
not recorded has evaporated, which is the failure mode `known-gaps.md`'s own preamble exists to
prevent.

**Fix:** add it as S-8 item 4 in `.claude/rules/known-gaps.md`, carrying the H1 scope sentence
(this header, fastify 5.10.0, Node 22.22.2, two transports; nothing measured about other headers
or versions) so nobody later reads it as a live hole.

#### R2-LOW-4 · The idempotent `P2002` path has no standing integration coverage

`createDraftInvoice`'s catch branch (`invoice.repository.ts:240-259`) — the real idempotency
serializer, and the thing the epic calls out — is exercised by exactly one test, `BU29`
(`invoice.repository.unit.test.ts:383`), against a **fabricated** `PrismaClientKnownRequestError`.
No integration case forces a real concurrent unique violation: the 16 `BI*` cases are listed at
`billing.integration.test.ts:146…704`, and `BI2`/`BI7` reach idempotency through the
`findByPeriod` early return at `billing.service.ts:75-81`, which is a *different* branch.

Corroborating measurement: the mandated `pnpm test --force` run produced **zero**
`billing-service … prisma:error` lines (`grep -c` on the gate log), confirming nothing standing
drives a real `P2002` on the `telemetry_app` connection.

This matters more than a generic coverage note because of `constants.ts:66-82`: that whole careful
note exists precisely because the real-connection behaviour (`meta.target = null`) differs from
the owner-connection behaviour, and the unit double hard-codes `meta: { target: null }`. So the
one path whose behaviour is role-dependent is covered only where the role is simulated. QA
exercised it for real — 4 rounds at 2 and 4 concurrent callers, always one `201` and the rest
`200` — but a QA probe is not a standing regression test.

Not a defect, and QA's result is good evidence the logic is right. Returned as decision **D-D**
below rather than a required fix, because the obvious test can pass vacuously and that needs
deciding, not just doing.

#### R2-LOW-5 · NIT-3 is still open, and I re-measured it across the whole suite

Mutating `sumUnbilledByMetricKey`'s lower bound at `invoice.repository.ts:147`
(`gte: periodStart` → `gt: periodStart`) and running the **full** 125-test billing suite:

```
× InvoiceRepository.sumUnbilledByMetricKey > BU21 - filters on the bound tenant, billed=false
  and a half-open [start, end) range
Tests  1 failed | 124 passed (125)
```

**BU21 alone** — no integration case notices. BI13 did *not* close this, and the plan is correct
to say so at `docs/plans/…:432-434`: BI13 pins the **meter** window
(`meter.repository.ts:48-49`), which is a different predicate. BU21 is a genuine `where`-shape
assertion, not vacuous, so this remains coverage *asymmetry* rather than a hole — `BI1b`
(`billing.integration.test.ts:188`) seeds a line at `periodEnd` and one before `periodStart` but
none exactly **at** `periodStart`. One extra fixture line closes it. **Disposition: accepted,
carry forward** — it does not block, and it is now stated in the plan rather than only in a
review.

#### R2-NIT-1 · Round 1's corrected gate headline is a post-fix number sitting in a Gate-4 table

I am flagging this against my own Round 1, not against the implementer. QA-3 replaced the
headline `820` with `805`. The arithmetic does not close at Gate 4: non-billing packages measure
**681** on this tree (2+4+8+15+4+18 shared = 51; analytics 18 + gateway 38 + usage 230 + auth 164
+ worker 180 = 630), and Round 1's own itemised list has billing at **119**, which totals **800**,
not 805 — as Round 1's parenthetical itself admits. 805 is the total *after* the MEDIUM-1 chunking
work added `BI11`, `BI12` and the unit cases around them (681 + 124), and **806** after BI13
(681 + 125). So the Gate-4 table now reports a figure measured on a tree Gate 4 never reviewed.

Harmless to the verdict, but it is the third numeric correction on this task, and the lesson is
the one `known-gaps.md`'s own "a count you cannot re-run is not evidence" section already states:
a corrected number needs its provenance *and its tree*. **Fix (optional):** in the Round 1 gate
table, mark 805 as "measured post-MEDIUM-1, see Round 2" rather than as a Gate-4 measurement.

---

### The `invoice.repository.ts` citation, and whether the grep is the right durable fix

**The four S-19 rows are exact.** Re-derived:

```
apps/billing-service/src/repositories/meter.repository.ts:35    export class MeterRepository
apps/billing-service/src/repositories/invoice.repository.ts:94  export class InvoiceRepository
apps/usage-service/src/repositories/usage.repository.ts:150     export class UsageRepository
apps/worker-service/src/repositories/event.repository.ts:64     export class EventRepository
```

All four match `.claude/rules/known-gaps.md:478-481` exactly, including the `:94` that rotted
three times. The unfiltered grep returns **9** lines and the other **5** are the docstring
`EventRepository` example in each base file — also exactly as the entry states.

**Is the regenerating grep the right durable fix? Partly — it is the right *interim* recipe and
the wrong thing to call durable.** The entry specifies
`grep -rn "extends TenantScopedRepository" apps/*/src` "filtered to lines beginning
`export class`". Measured blind spots — fed these four shapes through that exact filter, only the
last survives:

```
export abstract class AbstractRepo extends TenantScopedRepository {   <- missed
class PrivateRepo extends TenantScopedRepository {                    <- missed
export class SecondLevel extends InvoiceRepository {                  <- missed (transitive)
export class Normal extends TenantScopedRepository {                  <- found
```

So three of four real-subclass shapes are invisible to it, and a future subclass in any of them
would silently keep the count at four. Two concrete improvements, in order of value:

1. **Now, one line:** replace the filter with
   `grep -rnE "^[[:space:]]*(export[[:space:]]+)?(abstract[[:space:]]+)?class[[:space:]]+[A-Za-z0-9_]+[[:space:]]+extends[[:space:]]+TenantScopedRepository" apps/*/src`.
   Verified a safe drop-in: it returns **the same four rows and no docstring examples** on this
   tree (the examples begin ` * class`, so the `^[[:space:]]*class` anchor excludes them), while
   additionally catching `export abstract class` and non-exported `class`. It still cannot see a
   transitive subclass — say so in the entry rather than leaving it implied.
2. **Durably:** S-19's own fix direction. A single `@telemetry/shared-db` makes the count
   unnecessary, because there is one implementation to be right about. A grep that has to be
   re-run by a human who remembers to re-run it is a convention, not a mechanism — which is the
   same thing S-19 says about the five copies it tracks.

**Disposition: accept the grep, recommend the regex widening as a NIT**, and do not describe it in
the entry as durable.

---

### What I verified, by execution

**Compile-time gate — all four with `--force`, 13/13 packages, `Cached: 0 cached` on every one:**

| Task | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck --force` | `Tasks: 13 successful, 13 total` · `Cached: 0 cached, 13 total` · 12.174s · **0 errors** |
| lint | `pnpm lint --force` | `13 successful, 13 total` · `0 cached` · 28.354s · **0 errors, 14 warnings** |
| build | `npx turbo run build --force` | `13 successful, 13 total` · `0 cached` · 22.161s |
| test | `pnpm test --force` | `13 successful, 13 total` · `0 cached` · 21.779s · **806 tests, 0 failures** |
| smoke | `pnpm test:smoke` | **6 suites, 7 tests**, all pass, exit 0 |

**Root total measured: 806.** Summed from the untruncated per-package output, not from a headline:

`shared-tracing` 2 · `shared-config` 4 · `shared-types` 8 · `shared-validation` 15 ·
`shared-logger` 4 · `shared-utils` 18 · `analytics-service` 18 · `gateway` 38 ·
`usage-service` 230 · **`billing-service` 12 files / 125 tests** · `auth-service` 164 ·
`worker-service` 180 · `web` `--passWithNoTests` (13th package).
51 + 18 + 38 + 230 + 125 + 164 + 180 = **806**. Matches the handoff.

Billing per file, summing to 125: `billing.integration` 16 · `billing.service.unit` 21 ·
`config/container.unit` 6 · `config/prisma.singleton.unit` 4 · `env.schema.unit` 17 ·
`generate-invoice.validator.unit` 8 · `index.graceful-shutdown.unit` 7 ·
`internal-billing.route` 10 · `internal.controller.unit` 11 · `invoice.repository.unit` 17 ·
`meter.repository.unit` 7 · `smoke` 1. Base was 5 files / 35 (container 6 + prisma.singleton 4 +
env.schema 17 + graceful-shutdown 7 + smoke 1), so **+7 files / +90 tests**.

**Warnings — 14, all pre-existing, proven, and zero `no-unsafe-return`:**

- 10 × `@typescript-eslint/no-misused-promises` in
  `apps/auth-service/tests/auth.service.unit.test.ts` — `git log -1` → **`d68e719`** (2026-08-25).
- 4 × `@typescript-eslint/no-unsafe-assignment` in
  `apps/usage-service/tests/ingestion.service.unit.test.ts` — `git log -1` → **`b0f6921`**
  (2026-08-31).
- Neither file appears in `git status --porcelain`. **`billing-service` emits zero warnings**
  (`grep -c "billing-service:lint.*warning"` → `0`). No new warning of any kind, in any package.

**Two stderr artefacts in the test log that are not failures**, checked rather than assumed:

- `Error: load failure` in analytics/billing/auth/gateway/usage — the deliberately-thrown fixture
  in each service's `index.graceful-shutdown.unit.test.ts` case *"fails startup when loadEnvFile
  throws non-ENOENT"*, printed to stderr by a passing test.
- `prisma:error … 42501 permission denied for table Event` under auth-service — the **asserted**
  rejection at `apps/auth-service/tests/rls.integration.test.ts:275`
  (`await expect(app.event.findMany()).rejects.toThrow()`), i.e. the least-privilege proof
  working. Pre-existing, auth-service untouched by this change.

**Mutations applied, run and reverted — 5, all reproducing or refuting a stated claim:**

| # | Mutation | Claimed | Measured |
|---|---|---|---|
| R1 | `meter.repository.ts:48` `lte` → `lt` | BI13 red, `expected 422 to be 201` | **BI13 alone**, `AssertionError: expected 422 to be 201` — verbatim |
| R2 | `meter.repository.ts:49` `activeTo` clause deleted | BI13 red, `expected '0.07' to be '0.5'` | **BI13 alone**, `AssertionError: expected '0.07' to be '0.5'` — verbatim |
| R3 | `invoice.repository.ts:147` `gte` → `gt` | plan: BU21 alone | **BU21 alone**, across the full 125 |
| R4 | `findByPeriod` → `$queryRaw` with bound `Date`s | S-19: "turns **BI7** red" | **BI2 + BI7** red. BI7 is the correct one to name — see below |
| R5 | R4 **+** `INTEGRATION_SESSION_TIME_ZONE.AHEAD_OF_UTC` `"Asia/Kolkata"` → `"UTC"` | S-19: BI7 "stays green" | **BI7 green**, BI2 alone red |

R4/R5 together settle the S-19 paragraph's load-bearing claim, and it is **stronger than it
reads**: naming only BI7 is right, not an omission. BI2 reddens under R4 only because *this
host's* PostgreSQL session is `Asia/Kolkata`; on CI (UTC) it would pass under the same defect.
BI7 pins its own zone in its own connection string, so it is the case that reddens on any server —
and R5 proves the pin is what does the work, because removing it makes BI7 green against the exact
same defect. That is a guard, not a restatement of the host default, and the entry says so
correctly.

**BI13 and the boundary asymmetry — the reasoning checks out.** The half-open
`[activeFrom, activeTo)` claim at `docs/plans/…:413-427` is sound and the fixture is built to
match: `storage.gb`'s expired promo has `activeFrom` `2025-07-01` against the live meter's
`2025-01-01` (`integration.constants.ts:105` vs `:85`), so it *is* the only shape that can outrank
the live meter under `orderBy activeFrom desc` — which is exactly why R2 flips the price to
`0.07`. The `api.request` triple tiles at `periodStart`: the superseded meter's `activeTo` equals
the live meter's `activeFrom`, so at that instant `activeTo > asOf` is false for one and
`activeFrom <= asOf` is true for the other — one in force by construction, not by tie-break, which
is what the plan claims. It correctly distinguishes itself from NIT-3, verified independently by
R3.

**The `asDecimalString` self-correction is a strengthening, not a loosening.** Two checks:

1. R2 still reddens through the helper (`expected '0.07' to be '0.5'`), so its discriminating
   power on a wrong meter is intact.
2. Probed directly at `Decimal(18,6)` resolution: it collapses **only** trailing-zero spelling
   (`0.010000`≡`0.01`, `0.500000`≡`0.5`) and preserves every value distinction tested, including
   the least significant digit at 18 significant figures
   (`123456789012.123456` vs `…457` → not equal; `0.000001` vs `0.000002` → not equal).

The one thing it stops asserting is the literal spelling — and that is still pinned elsewhere, at
`meter.repository.unit.test.ts:143` (`unitPrice: "0.02"`, an exact `String(...)` output) and
`:83-84` (`not.toBeInstanceOf(Prisma.Decimal)` + `typeof === "string"`). Nothing was lost.

**QA-2 re-verified independently — the thing you could not check.** Queried `pg_policy` directly
(`psql "$DATABASE_URL"`, password supplied through the URL rather than a prompt, which is why your
route hung):

```
tenant_self_delete  d  (id = current_setting('app.tenant_id'::text, true))
tenant_self_insert  a  WITH CHECK (id = current_setting('app.tenant_id'::text, true))
tenant_self_select  r  (id = current_setting('app.tenant_id'::text, true))
tenant_self_update  w  USING + WITH CHECK, same expression
```

**Four** policies, exactly the four S-37 now names, and **none carries a `deletedAt` term** — so
S-37's conclusion is unchanged, as the corrected entry says. One pedantic note, not a finding:
the entry says all four are "keyed on `(id = current_setting(…))`"; for `tenant_self_insert` that
expression lives in `WITH CHECK`, not `USING`, because an INSERT policy has no `USING`. The claim
is substantively right.

**S-37's other measured claim holds.** `grep -rn "deletedAt" apps packages prisma --include=*.ts
--include=*.prisma` excluding `dist/` returns **exactly three** lines:
`prisma/schema.prisma:17`, `prisma/seed.ts:24`, and the `tenantExists` docstring (now
`invoice.repository.ts:100`). Nothing writes the column.

**Q2's epic entry checks out.** `prisma/schema.prisma:113` is `tierJson Json?` — exact — and
`grep -rn "tierJson"` returns only that line and the `billing.service.ts:51` comment saying it is
unread. Genuinely unread.

**D3's citations are all exact:** epic `:65` (`200 { invoiceId }`), `:67`
(`200 { invoiceId: null, message: … }`), `:75` (`201 { data: { invoiceId } }`);
`apps/usage-service/src/controllers/usage.controller.ts:49`; `packages/shared-types/src/index.ts:46`
(`export interface ApiResponse<T>`). The epic really does contradict itself three ways and the
wrapped form really is the repo's convention.

**The repository docstring's own self-check holds.** `grep -n "^  async"
apps/billing-service/src/repositories/invoice.repository.ts` → exactly **four**, at `:104`,
`:120`, `:144`, `:185`, and none takes an `invoiceId` or a `tenantId` parameter. (Round 1 cited
`:102/:118/:142/:183`; the docstring edit shifted them by two.)

**Tenant isolation, re-checked on this revision.** `BI0` (`billing.integration.test.ts:146`)
asserts the connection through `pg_roles` — `current_user = telemetry_app`, `rolsuper = false`,
`rolbypassrls = false` — so the suite's RLS results are not a superuser's. Both repositories are
container **factories** (`config/container.ts:54-57`), asserted by `BU63`. No production magic
literal in any new source file (scanned all six for bare status codes, bare `"UPPER_SNAKE"`
strings and two-digit-plus numerics — zero hits). The two dead stub constants `STATUS_ACCEPTED`
and `WORKFLOW_BILLING_GENERATION` were **removed** rather than left dangling
(`git show 7f359db:…/constants.ts` had them at `:18-19`; `grep -r` across `src/` and `tests/`
now returns nothing).

**Test honesty.** `firstArg` (`invoice.repository.unit.test.ts:118-124`) **throws** when the call
is absent — the shape `.claude/rules/testing.md` requires. `BU62`
(`internal-billing.route.test.ts:66`) asserts the *behaviour* — `expect(generateInvoice).not.toHaveBeenCalled()`
— rather than the status alone, which is what makes the controller docstring's "the handler does
not run" claim a measurement instead of an inspection. No `.skip`, no `.only`, no conditional
early return in any billing test: the only two `return;` hits are `smoke.test.ts:15` and
`env.schema.unit.test.ts:51`, and the latter is a **type-narrowing** return that sits *after*
`expect(parsed.success).toBe(false)` — the assertion fails first when the bug is present, so it is
not the S-3 inverted-signal shape.

**Database invariants held throughout.** Counted before the mutations, between them and after the
final revert: `Tenant` **2**, and `Event` / `UsageLine` / `Invoice` / `InvoiceLineItem` / `Meter`
all **0**. Billing's fixtures clean up completely. (The two `Tenant` and two `User` rows are
S-20's known auth-fixture residue from prior runs, unchanged by anything here — and unchanged by
the mandated gate, because that suite's last case is a negative one, exactly as S-20 predicts.)

**Redis, reported rather than rounded to green.** Db 0 ends at `DBSIZE 4`: `telemetry:events`
**intact**, plus **3** `denylist:*` keys with TTLs 166–426 s, written by auth-service's logout
tests during the mandated `pnpm test --force`. This is **S-22** exactly as documented,
self-expiring, and unavoidable while auth-service's suite pins `redis://localhost:6379`. No
`FLUSHDB` was issued against db 0 by me or by the suite.

---

### Release readiness

**Breaking-change assessment across the other 12 packages: none.** `git status --porcelain` shows
source changes confined to `apps/billing-service/`; the only other files touched are
`.claude/rules/known-gaps.md` and `docs/epics/README.md`. No shared package changed, so no
consumer can be affected by construction. The full 13-package gate is green with `Cached: 0` on
all four tasks, which is the positive half of the same statement.

**What an existing caller experiences.** At `7f359db` the endpoint was a stub:
`POST /v1/internal/billing/generate` returned `200 { status: "accepted", workflow:
"billing-generation" }` for **any** body, including none, and created nothing. This change makes
it a real writing endpoint, and it is breaking in three ways at once:

1. **The body is now mandatory and validated.** A caller sending nothing gets
   `400 VALIDATION_ERROR` where it used to get `200`.
2. **The success envelope changed shape entirely** — `{ status, workflow }` → `{ data: { invoiceId } }`.
3. **The status code is now meaningful** — `201` on create, `200` on an idempotent hit or no
   billable usage, plus `404` / `409` / `422` / `500`.

In-repo blast radius is **zero**: `grep -rn "internal/billing/generate\|INTERNAL_BILLING_GENERATE"`
across `apps packages k6 postman docker scripts` finds no production caller — only billing's own
tests, its `.env.example` comment and its own docstrings. It is also not reachable through the
gateway: `GATEWAY_PROXY_PREFIXES.BILLING` is `/v1/billing` (`apps/gateway/src/constants.ts:36`),
which does not cover `/v1/internal/billing/*`, matching the epic's "must never be exposed through
the gateway". Any caller that exists is an out-of-repo scheduler, and it must be updated in step.

**What an operator needs to know, and it is sharper than the handoff states.** The first real call
returns `422 METER_NOT_FOUND` — `Meter` is at **0 rows** and `findActiveAsOf` refuses rather than
defaulting (D1, correctly). But the documented way to fix that does not work, and the reason is
worse than S-13 alone:

- `prisma/seed.ts` is the **only** `Meter` writer in the repository (`prisma/seed.ts:57`).
- It dies before reaching it. The `user.upsert` at `prisma/seed.ts:34-52` keys on
  `where: { tenantId_email: { … } }`, and that compound unique **does not exist** — `grep -n
  "@@unique" prisma/schema.prisma` returns four, on `Event` (`:85`), `Meter` (`:117`), `Invoice`
  (`:135`) and `MetricRollup` (`:164`); `User` has none. That is S-13.
- The meter block at `:57` is therefore **unreachable**, and its own compound unique
  (`tenantId_metricKey_activeFrom`) *is* valid — so someone who fixes only the line S-13 names
  gets working meter seeding, but nothing tells them the meter block was the reason to care.

So the operator-facing statement is: **billing generates nothing until `Meter` rows are seeded,
and the repository currently has no working path to seed them.** Returned as decision **D-C**.

**No new environment variables.** `apps/billing-service/.env.example` is untouched by this change
and already documents `INTERNAL_API_SECRET` thoroughly. Deployment needs no config change.

**Index coverage** (reasoning, not measured — `EXPLAIN` on empty tables plans a seq scan, and the
row-count mandate forbids seeding to fix that). `findByPeriod` rides
`Invoice @@unique([tenantId, periodStart, periodEnd])`; `findActiveAsOf` rides
`Meter @@unique([tenantId, metricKey, activeFrom])`; `tenantExists` is the PK; the chunked
`updateMany` is keyed on `id`. Only `sumUnbilledByMetricKey` has no exact index — its predicate is
`tenantId = ? AND billed = false AND periodStart >= ? AND periodStart < ?`, and `UsageLine`
offers `@@index([tenantId, periodStart, periodEnd])` and `@@index([tenantId, billed])`, either of
which serves with a residual filter. Adequate; a `(tenantId, billed, periodStart)` index would be
the exact fit if this path ever gets slow. **Pre-existing schema, not changed here** — recorded
for a future task, not against this one.

**Acceptance criteria: 18/18 satisfied.** AC1–AC18 at `docs/plans/…` each name their cases, and
the whole named set passes (billing 125/125). Spot-verified by execution rather than by reading
the table: AC8 and the meter-window boundary via R1/R2; AC13 via `BI12`'s rollback assertion;
AC16 via `BI0` plus the `this.where({})` shape; AC17 via `container.ts:54-57` and `BU63`; AC18 via
`BI9`, which QA independently proved is a real marker by *closing* S-10 with live DDL and watching
it — and only it — go red.

---

### Decisions to return

#### D-C · How should the "no `Meter` rows anywhere, and the seeder is dead" fact be handed to the operator?

The endpoint is correct but inert on every existing deployment until meters exist, and the only
seeder in the repo cannot run.

| Option | What changes |
|---|---|
| **A — one paragraph in the commit message, plus an S-13 cross-reference in `known-gaps.md`** *(recommended)* | No code, no new file. S-13 gains one sentence: "this also blocks the only `Meter` seeding path, which T-045's endpoint now requires — the meter block at `seed.ts:57` is unreachable behind the broken upsert at `:36`." |
| B — add `docs/releases/t-045-internal-metering-endpoint.md` | A new artifact. Matches `CLAUDE.md`'s `docs/releases/` convention, but both existing notes (`s-007-…`, `t-040-…`) accompany **migrations**, and this task has none — so it would set a new precedent for non-migration tasks. |
| C — fix `prisma/seed.ts:36` (`tenantId_email` → `email`) in this commit | **Changes the diff.** Closes S-13 and makes seeding work. But it is an unrelated file in a one-task-per-commit repo, and S-13 explicitly says the rest of the file needs checking against the current schema too — that is its own task. |

**Recommendation: A.** It is the smallest thing that stops the fact evaporating, and it puts the
note where the next person to touch seeding will actually look. B is defensible if you want the
`docs/releases/` habit to generalise — that is a process preference, not a correctness question.
**C changes the diff and I would decline it**: it is exactly the opportunistic cross-task fix the
repo's own rules keep refusing, and S-13 has been deliberately deferred twice already.

#### D-D · Should the real-connection `P2002` race get a standing integration test? (R2-LOW-4)

QA proved the behaviour by hand — 4 rounds, 2 and 4 concurrent callers, always one `201` and the
rest `200`, same invoice id, no `409`, no `500` — but nothing standing exercises it.

| Option | What changes |
|---|---|
| **A — record it in `known-gaps.md` and move on** *(recommended)* | Nothing in the code. A new entry, or a line under S-19's neighbours, naming `invoice.repository.ts:240-259` as unit-covered only, and citing QA's 4-round result as the evidence that exists. |
| B — add a `Promise.all` concurrency case to `billing.integration.test.ts` | **Changes the diff.** Must assert that the `P2002` branch was actually taken — otherwise two callers can serialise, both take the `findByPeriod` early return, and the test passes green having exercised nothing. That assertion is the hard part: it needs either a spy on the catch or a deterministic barrier, neither of which is a two-line addition. |
| C — do nothing | The gap is real and QA's evidence is not in the repository. |

**Recommendation: A.** B is the *right* test and I would support it as its own small task, but a
concurrency test that can pass vacuously is worse than no test — it converts an acknowledged gap
into a false green, which is the specific failure mode this repo's testing rule and S-3's history
are about. Writing it properly is not in scope for a change that is otherwise finished. **A does
not change the diff; B does.** C is not acceptable because the gap would then exist only in this
review.

---

### What I could not verify, and why

- **The Gate-4 tree.** Round 1's billing=119 and the claim that 805 is a post-MEDIUM-1 figure rest
  on arithmetic against measurements I *can* make (non-billing = 681, current billing = 125), not
  on re-running Gate 4 — that tree no longer exists. Labelled as reconciliation, not measurement.
- **`EXPLAIN` plans for the new query paths.** All five tables are at 0 rows by mandate, so any
  plan I could produce would be a seq scan and would say nothing about behaviour at volume. The
  index analysis above is reasoning from the schema.
- **The `P2002` catch under a real concurrent race.** I did not reproduce QA's concurrency probe;
  doing so writes `Invoice` rows and I was required to leave the table at 0. I rely on QA's
  measurement, and R2-LOW-4 is precisely the observation that the repository does not.
- **CI's behaviour.** Everything here ran on this host, whose PostgreSQL session is
  `Asia/Kolkata`. R5 establishes that BI7 is zone-pinned and therefore CI-safe, but I did not run
  the suite under a UTC server to confirm the full 806 passes there.
- **S-11's residual and the wider S-8 remediation** — out of scope; untouched by this change.
- **The Copilot agent set (S-14).** Not exercised; this change does not touch `.github/agents/`.

---

### Remaining risks and dispositions

| Risk | Disposition |
|---|---|
| **S-10** — `InvoiceLineItem` RLS inert; this task ships the platform's first rows into it | **Accepted and actively pinned.** `BI9` asserts the gap as-is and QA proved it is a real marker by closing S-10 with live DDL and watching BI9 — and only BI9 — go red, write path green. The mitigation (nested create only, no method taking a bare `invoiceId`, verified four `async` signatures) is load-bearing and intact. |
| **S-19** — billing is a third unpinned `TenantScopedRepository` copy, now with **two** of the four subclasses | **Accepted.** ORM-only commitment verified by R4/R5 on billing's own tables. Table and line numbers exact. Recommend the regex widening (above) as a NIT. |
| **S-37** — `Tenant.deletedAt` has no writer, and billing has made its absence a contract | **Accepted as filed**, correctly scoped, QA-2's four-policy correction independently confirmed. Its fix direction (record in `docs/epics/README.md` before the first writer) is the right one. |
| **S-8 items 1 and 3** — `!==` not timing-safe (`internal-auth.middleware.ts:9`), `preHandler` not `onRequest`, un-`return`ed `reply.send`, literal `401` at `:10` | **Correctly deferred, and explicitly.** `constants.ts:24-26` names the literal as S-8's and says the constants are there for S-8 to adopt. Item 2 is already closed for billing by T-044. `BU62` makes the short-circuit a measurement rather than an inspection. Changing three services' auth middleware inside a billing feature is the one-task-per-commit objection. |
| **S-8 item 4** (`Array.isArray` → `provided[0]`) | **R2-LOW-3 — record it. Not a vulnerability**; carry probe H1's scope sentence with it. |
| **NIT-3 / R2-LOW-5** — usage window's lower bound has no integration case | **Accepted, carried forward**, now stated in the plan. One fixture line at `USAGE_INSTANT_AT_PERIOD_START` closes it whenever someone is next in that file. |
| **R2-LOW-4** — `P2002` catch unit-covered only | **Decision D-D.** |
| **S-22** — 3 TTL'd `denylist:*` keys in Redis db 0 | Reported, not rounded to green. Self-expiring, `telemetry:events` intact, no `FLUSHDB`. Unavoidable while auth-service pins db 0. |
| **S-13** — `prisma/seed.ts` cannot run, and it blocks the only `Meter` seeding path | **Newly consequential because of this task. Decision D-C.** |

---

### Required before commit

1. **R2-LOW-1** — `.claude/rules/known-gaps.md:67`: `apps/billing-service/src/app.ts:29` → `:26`.
2. **R2-LOW-2** — `.claude/rules/known-gaps.md:148`: `apps/billing-service/src/constants.ts:25-26`
   → `constants.ts:28` and `:31` (two citations; they are no longer contiguous).
3. **R2-LOW-3** — add the fourth S-8 divergence to `.claude/rules/known-gaps.md` as item 4, with
   probe H1's scope sentence, as `docs/plans/…` §10 itself recommends.
4. **D-C and D-D** — returned to the user. D-C option C and D-D option B change the diff; the
   recommended answers (A and A) do not.

All three fixes are documentation-only, in files the commit already stages. **No code change, and
the 13-package gate does not need re-running** — I verified it green on this exact tree.

R2-LOW-4, R2-LOW-5 and R2-NIT-1 are dispositioned above and do not block. The S-19 regex widening
is a NIT and does not block.

**Verdict: CONDITIONAL.** The implementation is sound: every Round 1 finding is resolved, both of
BI13's claimed mutations reproduce verbatim, the S-19 timezone claim is confirmed in both
directions, tenant isolation holds under a verified `NOSUPERUSER NOBYPASSRLS` connection, and the
gate is 13/13 green with 806 tests and no new warnings. What remains is three lines of
citation and record-keeping hygiene in an authoritative file the commit is already editing.
