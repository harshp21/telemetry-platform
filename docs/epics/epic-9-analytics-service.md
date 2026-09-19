# Epic 9 — Analytics Service

**Milestone**: v1
**Depends on**: Epic 2 (UsageLine, MetricRollup models), Epic 3, and Q3 for T-051/T-052/T-053
(this line previously omitted Q3 while README.md's dependency table applied it to the whole
epic; README.md is authoritative and both now read as the scoped form)
**Blocks**: Epic 11 (dashboard + usage pages consume these APIs)

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q3 — UTC aggregation | **Decided: fixed UTC for every tenant.** Bare `DATE_TRUNC` on the naive column, no `AT TIME ZONE`; `Tenant.timezone` is not an aggregation input. The ruling and its evidence live in [README.md](./README.md) § *Q3 — UTC aggregation timezone*, which is authoritative — this table is a pointer, not a second copy. Gates T-051, T-052 and T-053 only; T-050 shipped before it was decided. |

---

## T-050 · Analytics service env schema

**File**: `apps/analytics-service/src/config/env.ts`

```ts
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3005),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
});
```

---

## T-051 · Metrics rollup — `GET /v1/analytics/metrics`

**Files**: `controllers/analytics.controller.ts`, `services/analytics.service.ts`, `repositories/rollup.repository.ts`, **`src/app.ts`**

> **Register the route *inside* the existing `app.register` scope in `src/app.ts`.** S-9 fitted
> analytics' internal-auth guard and tenant-context hook into that scope and left it holding no
> routes, so this task's route is the first thing behind them. The Files line above named three
> files and not `src/app.ts` until S-9's Gate-4 review (LOW-4); a route registered anywhere else is
> unauthenticated and untenanted, and **nothing on this tree would notice**.
>
> Measured, four placements against that scope, fastify 5.10.0 / Node v22.22.2 — the wrong
> placement is not a 404 somebody spots, it is a working `200` with the guard skipped:
>
> ```
> route inside the guarded scope      GET /v1/analytics/metrics -> 200  hooksRan=["auth","tenant"]
> route in a sibling scope            GET /v1/analytics/metrics -> 200  hooksRan=[]
> route on the root instance          GET /v1/analytics/metrics -> 200  hooksRan=[]
> route in a sibling scope, prefixed  GET /v1/analytics/metrics -> 200  hooksRan=[]
> ```
>
> Pair it with a case that fails when the registration moves out of the callback —
> `apps/billing-service/tests/billing-invoices.route.test.ts` `BU78` is the shape: assert the
> service method was **never called**, not merely that the status was 401. See
> `.claude/rules/known-gaps.md` S-9, which this task discharges, and S-53 for the separate
> defects in the `$queryRaw` snippet below.

**Query params**:
```ts
{
  metricKey?: string;
  granularity: "hour" | "day" | "week";
  from: string;    // ISO8601
  to: string;      // ISO8601
  page?: number;
  pageSize?: number;
}
```

**Logic (two-tier)**:
1. Query `MetricRollup` for the requested range + granularity
2. If rollup data is incomplete (missing buckets), fall back to aggregating directly from `UsageLine` using `DATE_TRUNC` SQL
3. Cache the on-demand result into `MetricRollup` for future requests (upsert)

**On-demand aggregation SQL** (via Prisma `$queryRaw`):
```sql
SELECT
  metric_key,
  DATE_TRUNC('day', period_start AT TIME ZONE 'UTC') AS bucket_start,
  SUM(quantity) AS total_quantity
FROM usage_lines
WHERE tenant_id = $1
  AND period_start >= $2
  AND period_end <= $3
  AND billed = true   -- only finalized usage
GROUP BY metric_key, bucket_start
ORDER BY bucket_start ASC
```

**Response**:
```ts
PaginatedResult<{
  metricKey: string;
  bucketStart: string;
  bucketEnd: string;
  totalQuantity: string;  // string to preserve Decimal precision
}>
```

---

## T-052 · Top events — `GET /v1/analytics/events/top`

**File**: `controllers/analytics.controller.ts`

**Query params**:
```ts
{
  from: string;
  to: string;
  limit?: number;  // default 10, max 50
}
```

**Logic**: Query `UsageLine` grouped by `metricKey`, ordered by `SUM(quantity) DESC`, limited to `limit`. Tenant-scoped.

**Response**:
```ts
{
  data: Array<{
    metricKey: string;
    totalQuantity: string;
    eventCount: number;
  }>
}
```

---

## T-053 · CSV export — `GET /v1/analytics/export`

**Files**: `controllers/analytics.controller.ts`, `services/export.service.ts`

**Query params**: Same as metrics rollup (from, to, granularity, metricKey).

**Story**: Stream the response to avoid loading all rows into memory. Use cursor-based pagination through `UsageLine` records. Write `ExportAudit` before streaming begins so the audit record exists even if the client disconnects mid-stream.

**Implementation**:
```ts
// Set streaming headers before any data is written
reply.raw.writeHead(200, {
  "Content-Type": "text/csv",
  "Content-Disposition": `attachment; filename="export-${Date.now()}.csv"`,
  "Transfer-Encoding": "chunked",
});

// Write audit record first
await exportAuditRepository.create({ tenantId, userId, filters, exportedAt: new Date() });

// Write CSV header
reply.raw.write("metricKey,quantity,unit,occurredAt,periodStart,periodEnd\n");

// Stream rows via cursor
let cursor: string | undefined;
do {
  const batch = await usageLineRepository.findPage({ tenantId, cursor, ...filters });
  for (const row of batch.items) {
    reply.raw.write(`${row.metricKey},${row.quantity},${row.unit},...\n`);
  }
  cursor = batch.nextCursor;
} while (cursor);

reply.raw.end();
```

**Acceptance**:
- 100k row export does not exceed 50 MB memory usage
- `ExportAudit` record is written before streaming starts
- Client disconnecting mid-stream does not cause an uncaught error

---

## T-054 · Analytics service integration tests

**File**: `apps/analytics-service/tests/analytics.integration.test.ts`

**Test cases**:
- Seed `UsageLine` rows across 7 days → metrics rollup returns correct daily totals
- Rollup with pre-populated `MetricRollup` → uses cached data (verify no `UsageLine` query via query logging)
- Top events with seeded data → returns correct ranking order
- CSV export → line count matches seeded row count, header row present
- All endpoints tenant-scoped → seeded data from different tenant not returned
