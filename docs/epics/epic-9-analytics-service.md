# Epic 9 — Analytics Service

**Milestone**: v1
**Depends on**: Epic 2 (UsageLine, MetricRollup models), Epic 3
**Blocks**: Epic 11 (dashboard + usage pages consume these APIs)

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q3 — UTC aggregation | Bucket boundary timezone — assumed UTC midnight until confirmed |

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

**Files**: `controllers/analytics.controller.ts`, `services/analytics.service.ts`, `repositories/rollup.repository.ts`

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
