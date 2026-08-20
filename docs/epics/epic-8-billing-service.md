# Epic 8 — Billing Service

**Milestone**: v1
**Depends on**: Epic 2 (Meter, Invoice models), Epic 3, Epic 7 (UsageLines produced by worker)
**Blocks**: Epic 11 (billing dashboard page)

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q2 — Pricing model | Flat rate, tiered volume, or per-seat? Defines how `Meter.tierJson` is structured |
| Q3 — UTC aggregation | Billing period boundaries (midnight UTC assumed until Q3 is answered) |

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

---

## T-049 · Billing service integration tests

**File**: `apps/billing-service/tests/billing.integration.test.ts`

**Test cases**:
- Seed tenant + meter + usage lines → call generate → assert `Invoice` created with correct `totalAmount`
- Call generate twice for same period → second call returns same `invoiceId` (idempotent)
- No usage lines for period → `200 { invoiceId: null }`
- Invoice list filtered by `status=DRAFT` → only draft invoices returned
- Invoice detail for different tenant's invoice → `404`
- Attempt to update `FINALIZED` invoice → `409 INVOICE_IMMUTABLE`
- Missing `X-Internal-Secret` on internal endpoint → `401`
