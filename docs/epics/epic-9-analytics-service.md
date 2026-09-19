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
> S-9, which this task discharged, and S-53, which recorded the separate defects in the
> `$queryRaw` snippet below, are both retired — T-051 closed them and the snippet is corrected
> in place, with the original's five defects enumerated under it.

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
  "metricKey",
  DATE_TRUNC('day', "periodStart") AS "bucketStart",
  SUM("quantity") AS "totalQuantity"
FROM "UsageLine"
WHERE "tenantId" = $1
  AND "periodStart" >= $2::timestamp(3)
  AND "periodStart" <  $3::timestamp(3)
GROUP BY "metricKey", DATE_TRUNC('day', "periodStart")
ORDER BY DATE_TRUNC('day', "periodStart") ASC, "metricKey" ASC
```

> **Corrected by T-051, the task S-53 assigned the fix to (that id is now retired).** The
> snippet above is not
> what was originally specified. Five things were wrong with the original and each is recorded
> here rather than silently overwritten, because the epic files are a record of what was
> specified (S-32's precedent). What shipped is
> `apps/analytics-service/src/repositories/rollup.repository.ts`.
>
> 1. **`DATE_TRUNC('day', period_start AT TIME ZONE 'UTC')` applied the conversion to the
>    column.** On a naive `timestamp(3)` column that produces a `timestamptz` and shifts every
>    bucket boundary by the **server** offset — the defect `CLAUDE.md` § *Raw SQL and timestamps*
>    named, and which **S-53** recorded until T-051 closed it. Measured on the real `"UsageLine"`
>    table across four session
>    zones: a `2026-03-01 03:00` row buckets as `2026-03-01` under `UTC`, `Asia/Kolkata` and
>    `Asia/Kathmandu`, and as **`2026-02-28`** under `America/New_York`. Per Q3 (decided: fixed
>    UTC for every tenant) the correct form is a bare `DATE_TRUNC` on the naive column. `AI7` in
>    `apps/analytics-service/tests/analytics.timezone.integration.test.ts` pins it and goes red
>    under the original form in three of four zones — **not under `UTC`**, which is why CI's
>    `postgres:16-alpine` default cannot catch it and why that suite pins its own session zone.
> 2. **Every identifier was snake_case and nothing in this database is.**
>    `grep -n "@@map\|@map" prisma/schema.prisma` returns nothing, so Prisma emits model and
>    field names verbatim as quoted identifiers: `"UsageLine"`, `"metricKey"`, `"periodStart"`,
>    `"tenantId"`. Unquoted `usage_lines` folds to lower case and matches nothing, so this half
>    **raised** rather than returning wrong rows — the loud failure, and a copy-and-fix nuisance
>    rather than a hazard.
> 3. **The range predicate was S-18.** A bound JS `Date` compared against a naive column resolves
>    through the database session zone. Both bounds are normalized in JS
>    (`new Date(iso).toISOString()`) and cast `::timestamp(3)`; `AI8` is the guard, and because
>    analytics deliberately has **no** `set_config('TimeZone','UTC',true)` pin in its
>    `base.repository.ts` (S-19), reverting that normalization alone goes red here where the
>    equivalent revert leaves usage-service's own suite green (S-21).
> 4. **`AND period_end <= $3` was the wrong column and the wrong bound.** The window is half-open
>    `[from, to)` on `"periodStart"`, matching `GET /v1/usage/summary`; `periodEnd <= to` would
>    make the two endpoints disagree about which rows a range contains.
> 5. **`AND billed = true` was dropped**, on the user's Gate-2 ruling for T-051. Measured: with
>    the filter, a seeded `5.250000` unbilled row vanishes from the result while sitting in the
>    database, so a dashboard reports "nothing" for a day that had usage. `billed` is written
>    `false` at ingestion and flipped later by the nightly invoice job, so the filter would also
>    guarantee every cached bucket goes stale exactly once. "How much did I use" and "how much
>    have I been billed for" are different questions and
>    `GET /v1/billing/invoices/:id` already answers the second. `AI4b` goes red if it returns.
>
> **The Files line above and the placement blockquote are unchanged and remain correct.** Two
> further things the section does not say, filled by T-051's plan: `MetricRollup` has **no
> `bucketEnd` column**, so both tiers derive it from one frozen granularity map rather than a
> migration; and "incomplete" is defined as `cachedBuckets == expectedBuckets` over calendar
> buckets, with any shortfall discarding the whole cache rather than topping it up. The cost of
> that definition is filed as **S-61**.

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
