# Epic 8 — Billing Service

**Milestone**: v1
**Depends on**: Epic 2 (Meter, Invoice models), Epic 3, Epic 7 (UsageLines produced by worker)
**Blocks**: Epic 11 (billing dashboard page)

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q2 — Pricing model (**decided**, see `docs/epics/README.md`) | Flat only for v1: `amount = summedQuantity x unitPrice`. `Meter.tierJson` is unread; tiered pricing is deferred pending a graduated-vs-volume ruling |
| Q3 — UTC aggregation | **Scoped to Epic 9 by `docs/epics/README.md`, not to Epic 8.** It remains open, and it does not block Epic 8's tasks: the billing endpoints bind no timestamp whose bucket boundary Q3 would decide. Where the boundary is actually chosen is `T-042` (`docs/epics/epic-7-worker-service.md`), the daily job that selects "the previous calendar day" |

---

## Billing model overview

```
UsageLine records (produced by worker)
         ↓
  Meter lookup (rate per metricKey)
         ↓
  Invoice (DRAFT) + InvoiceLineItems
         ↓
  Finalize (DRAFT → FINALIZED)
         ↓
  Payment processing hook (out of scope for v1)
```

---

## T-044 · Billing service env schema

**File**: `apps/billing-service/src/config/env.ts`

```ts
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3004),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  INTERNAL_API_SECRET: z.string().min(32),
});
```

---

## T-045 · Internal metering endpoint — `POST /v1/internal/billing/generate`

**Files**: `controllers/internal.controller.ts`, `services/billing.service.ts`, `repositories/invoice.repository.ts`, `repositories/meter.repository.ts`

**Auth**: Not JWT-authenticated. Validates `X-Internal-Secret` header matches `INTERNAL_API_SECRET` env var. Returns `401` if absent or mismatched. This endpoint must never be exposed through the gateway.

**Request body**:
```ts
{ tenantId: string; periodStart: string; periodEnd: string }
```

**Logic**:
1. Validate `tenantId` exists
2. Check no `Invoice` already exists for `(tenantId, periodStart, periodEnd)` — if exists, return `200 { invoiceId }` (idempotent)
3. Fetch unbilled `UsageLine` records for tenant within period (where `billed = false`)
4. If no usage lines: return `200 { invoiceId: null, message: 'No billable usage' }`
5. Group usage by `metricKey`, sum quantities
6. For each `metricKey`: look up active `Meter` rate as of `periodStart`
7. Calculate line item amounts (flat: `quantity × unitPrice`; tiered: evaluate `tierJson`)
8. Prisma transaction:
   - Create `Invoice` (status: `DRAFT`)
   - Create `InvoiceLineItem` for each metric
   - Mark all processed `UsageLine` records as `billed = true`
9. Return `201 { data: { invoiceId } }`

**Idempotency**: Safe to call twice for the same period — second call returns existing invoice without creating a duplicate.

---

## T-046 · Invoice list — `GET /v1/billing/invoices`

**Files**: `controllers/billing.controller.ts`, `services/invoice.service.ts`

**Auth**: JWT required. `tenantId` from `X-Tenant-Id` header.

**Query params**:
```ts
{
  status?: "DRAFT" | "FINALIZED" | "PAID";
  page?: number;    // default 1
  pageSize?: number; // default 20, max 100
}
```

**Response**: `PaginatedResult<InvoiceHeader>` where `InvoiceHeader` omits `lineItems`.

```ts
interface InvoiceHeader {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: InvoiceStatus;
  totalAmount: string;   // string to avoid float precision issues in JSON
  currency: string;
  createdAt: string;
  finalizedAt: string | null;
}
```

---

## T-047 · Invoice detail — `GET /v1/billing/invoices/:id`

**File**: `controllers/billing.controller.ts`

**Logic**:
1. Fetch `Invoice` by `id` with `lineItems` included
2. Verify `invoice.tenantId === req.tenantId` — return `404` if not found or belongs to another tenant (do not leak existence)
3. Return full invoice with line items

**Response**:
```ts
{
  data: {
    ...InvoiceHeader,
    lineItems: Array<{
      id: string;
      metricKey: string;
      quantity: string;
      unitPrice: string;
      amount: string;
    }>
  }
}
```

---

## T-048 · Invoice immutability guard

**File**: `apps/billing-service/src/repositories/invoice.repository.ts`

> **Forward reference (added by S-45, which shipped before this task).** `generate` already
> refuses a non-`DRAFT` invoice: when an invoice exists for the period and unbilled usage
> remains, `InvoiceRepository.absorbLateUsage` throws `InvoiceImmutableError` and writes
> nothing, surfaced as `409 INVOICE_IMMUTABLE`. That reuses **this section's** declared code
> name deliberately, so the platform ends with one code for "you may not mutate a non-`DRAFT`
> invoice" rather than two. T-048 **either adopts that behaviour or overrides it**, and must
> say which. Two things to check against the code before planning: the error body this service
> emits is `{ code, message }` and not the `{ code, invoiceId, currentStatus }` written below
> (the two values go to billing's log line); and the snippet's `findById(id, tenantId)` /
> `update({ where: { id } })` signatures are refused by this repository's shape — no method
> takes a bare `invoiceId` or a caller-supplied tenant, because `"InvoiceLineItem"` RLS is
> inert (S-10) and the application route is the only tenant control on that write.

**Story**: `FINALIZED` and `PAID` invoices must never be mutated. Enforce at the repository layer — not just controllers — so no code path can accidentally modify a finalized invoice.

```ts
async update(id: string, tenantId: TenantId, data: Partial<Invoice>): Promise<Invoice> {
  const existing = await this.findById(id, tenantId);

  if (existing.status === "FINALIZED" || existing.status === "PAID") {
    throw new InvoiceImmutableError(id, existing.status);
  }

  return this.prisma.invoice.update({ where: { id }, data });
}
```

**Error response**: `409 { code: 'INVOICE_IMMUTABLE', invoiceId, currentStatus }`

> **What T-048 actually shipped, and where the snippet above is wrong.** Added by T-048 itself,
> in the shape S-32 recommends. The snippet is kept because these files are a record of what was
> *specified*; read the code before quoting it.
>
> 1. **The behaviour was adopted, not overridden** (the block above asks which). A non-`DRAFT`
>    invoice refuses mutation with `409 INVOICE_IMMUTABLE` and nothing is written; the usage
>    stays `billed = false` and re-absorbable.
> 2. **No `update(id, tenantId, data)` method was added, and no method takes a bare `invoiceId`
>    or a tenant.** The guard is a private seam, `InvoiceRepository.draftInvoiceWriter(tx, key)`,
>    where `key` is built inside the repository from the compound unique
>    `tenantId_periodStart_periodEnd` with the tenant from `this.where({})`.
> 3. **Enforcement is structural, not just a check — and the census behind it counts forms, not
>    classes.** `withTenant` now hands its callback a `TransactionClient` whose `invoice` delegate
>    has had its nine write methods removed, so a bare `tx.invoice.update(...)` written outside
>    the seam is `TS2339`. **A writer that deliberately casts `tx` back to the full client still
>    compiles** — measured, 0 errors — and is caught instead by `BU125`, which asserts that the
>    cast forms it enumerates occur exactly once across `src/`. Round 1 of this task's review
>    measured the limit of that: the census originally matched the single spelling
>    `as unknown as FullTransactionClient`, and a writer casting the *delegate* instead — which
>    needs no `unknown` hop — passed typecheck, lint and 213/213. Round 2 widened `BU125` to four
>    enumerated cast targets and `BU126` to every access modifier, and re-ran that writer: red in
>    both, `Tests 2 failed | 211 passed (213)`. **A regex census catches the forms it enumerates
>    and nothing else**; a fifth spelling would be missed the same way. The guarantee is that a
>    bypass is *made visible in the forms we know how to spell*, not that it is impossible.
> 4. **The snippet's `this.prisma.invoice.update` is one of several routes none of that reaches**,
>    and it is among the worse ones: it runs outside `withTenant`, so no
>    `set_config('app.tenant_id', …)` has been issued at all. Measured — inserting it under the
>    full narrowing adds **zero** diagnostics. Two more were measured at Round 2 of the review,
>    each `pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json`, each
>    reverted:
>    - the `prisma` module singleton imported directly (`src/lib/prisma`, re-exported by
>      `src/config/container.ts`), from the **service** layer rather than the repository —
>      **0 diagnostics**, and invisible to `BU125` because it uses no cast: the census file stayed
>      at 37/37 and the package at 213/213;
>    - `tx.$executeRaw` inside `withTenant` — **0 diagnostics**. `FullTransactionClient`'s `Omit`
>      removes six `$`-methods and leaves **four**: `$executeRaw`, `$executeRawUnsafe`,
>      `$queryRaw`, `$queryRawUnsafe` (enumerated from the type with the TypeScript compiler API,
>      not read off the `Omit`). This one is inside the transaction, so the RLS context statement
>      has already run, and the tenant policy **does** bound the raw `UPDATE` — **executed** at
>      Gate 4 Round 2 and again at the Gate-3 rework that followed it, as `telemetry_app`
>      (`rolbypassrls = false`, read from `pg_roles` on that connection) under tenant A's context,
>      inside a `ROLLBACK`ed transaction: a cross-tenant raw `UPDATE` affected **0** rows, the
>      same statement against A's own invoice **1**, and a blanket no-`WHERE` `UPDATE` **1, not
>      2**. So what this route bypasses is the **status seam**, not tenant isolation. The figures
>      and the method are in **S-48**.
>
>    An earlier revision of this item said `this.prisma` was "the one route none of that reaches".
>    That was a universal refuted by two probes. All three are recorded in **S-48**, which stays
>    open.
> 5. **"Are refused by this repository's shape" (in the block above) is stronger than the code.**
>    Measured three ways: *declaring* `findById(id, tenantId)` compiles clean; only feeding it
>    into `this.where({ id, tenantId })` is `TS2322`; and building the predicate by hand as
>    `where: { id, tenantId }` compiles clean again. What refuses it is a convention plus one
>    compile error at one call site — now also `BU126`, which reddens on any `async` member
>    taking an `invoiceId` or `tenantId` parameter. Recorded as **S-50**.
> 6. **The error body stays `{ code, message }`**, as the block above already flags;
>    `invoiceId` and `currentStatus` remain fields on `InvoiceImmutableError` and go to
>    billing's log line. The message was reworded to *"Invoice is not a draft and cannot be
>    modified"* — it was absorption-specific and is now quoted from a general seam.
> 7. **No production writer reaches the guarded state.** Scope stated exactly, because the
>    grep behind this reads `apps/*/src`, `packages/*/src` and `prisma` and does **not** read
>    `tests/`: no statement in `src/` or `prisma/` sets `Invoice.status` other than
>    `createDraftInvoice`'s `DRAFT`. `tests/` **does** set it, and re-deriving which files do
>    (rather than trusting the two line numbers the review quoted) gives **six** database
>    writes of a non-DRAFT status, all in `billing.integration.test.ts`, all through
>    `integration.fixtures.ts`'s `seedInvoices`, which runs on `DIRECT_DATABASE_URL` -- the
>    owner connection. Command:
>    `grep -rn "status: InvoiceStatus\.\(FINALIZED\|PAID\)" apps/billing-service/tests`,
>    then filter to the `seedInvoices(...)` call sites; the other matches are query filters
>    and in-memory doubles, which write nothing. So every test of the branch seeds through the
>    owner connection (`BI23`, `BI34`) or a double (`BU123`, `BU124`), and **none of them
>    proves production behaviour**. The guard is unreached in production until an issuance
>    flow exists, and T-048 did not add one. An earlier revision of this item said *"No code
>    anywhere writes `FINALIZED` or `PAID`"*; `BI23`'s own fixture block — in the same file as
>    one of the sites that said so — refutes it (Gate-4 Round 2, MEDIUM-3). Cited by case id
>    rather than by distance, because the review's "33 lines below" was already a different
>    number by the time it was read.

---

## T-049 · Billing service integration tests

**File**: `apps/billing-service/tests/billing.integration.test.ts`

**Test cases**:
- Seed tenant + meter + usage lines → call generate → assert `Invoice` created with correct `totalAmount`
- Call generate twice for same period → second call returns same `invoiceId` (idempotent)
- No usage lines for period → `200 { invoiceId: null }`
- Invoice list filtered by `status=DRAFT` → only draft invoices returned
- Invoice detail for different tenant's invoice → `404` — **closed at T-047 by `BI30`, with
  `BI29` asserting the unknown-id and foreign-id responses are byte-identical**
- Attempt to update `FINALIZED` invoice → `409 INVOICE_IMMUTABLE` — **closed at T-048.** `BI23`
  carries the `FINALIZED` case (it predates T-048, shipped with S-45) and **`BI34` is the case
  that closes this line**, covering the `PAID` status this bullet's sibling paragraph names and
  that nothing had driven at any layer. Both seed through `DIRECT_DATABASE_URL`, because no code
  path writes a non-`DRAFT` status
- Missing `X-Internal-Secret` on internal endpoint → `401`
