# Epic 6 — Usage Service

**Milestone**: v1-mvp (ingestion), v1 (query endpoints)
**Depends on**: Epic 1, Epic 2, Epic 3
**Blocks**: Epic 7 (Worker consumes from the stream this service publishes)

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q1 — Event payload | `EventPayload` shape must be final before T-031 |
| Q8 — API consumers | External SDK or internal dashboard only? Affects idempotency key ownership |

---

## T-030 · Usage service env schema

**File**: `apps/usage-service/src/config/env.ts`

**Story**: Extend the generic env schema with usage-service-specific variables.

```ts
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3002),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  REDIS_STREAM_NAME: z.string().default("telemetry:events"),
  STREAM_MAX_LEN: z.coerce.number().int().positive().default(100_000),
  INGEST_BATCH_MAX: z.coerce.number().int().min(1).max(1000).default(100),
});
```

---

## T-031 · Event ingestion — `POST /v1/usage/events`

**Files**: `controllers/events.controller.ts`, `services/ingestion.service.ts`

**Auth**: Requires JWT — `tenantId` injected from `X-Tenant-Id` header (set by gateway), never from client body.

**Request body**:
```ts
{
  events: Array<{
    eventType: string;          // e.g. "api.request", "storage.write"
    quantity: number;           // positive, up to 6 decimal places
    unit: string;               // e.g. "requests", "bytes"
    occurredAt: string;         // ISO8601 — validated to not be more than 24h in the future
    idempotencyKey?: string;    // client-supplied; server generates one if absent
    metadata?: Record<string, unknown>;
  }>
}
```

**Validation**:
- Batch size: `1 ≤ events.length ≤ INGEST_BATCH_MAX` — `400` if exceeded
- `occurredAt` must not be more than 24h in the future (clock skew tolerance)
- `quantity` must be positive and finite

**Logic**:
1. For each event: generate `idempotencyKey` via `generateIdempotencyKey(tenantId, eventType, occurredAt)` if not client-supplied
2. Run deduplication check (T-032)
3. Publish accepted events to Redis Streams (T-033)
4. Return `202 { data: { accepted: number; duplicate: number; rejected: number } }`

**Error responses**:
- `400 { code: 'VALIDATION_ERROR', issues: [...] }`
- `400 { code: 'BATCH_TOO_LARGE', max: number }`

---

## T-032 · Idempotency deduplication

**File**: `apps/usage-service/src/services/deduplication.service.ts`

**Story**: Prevent double-counting events on client retries. Uses Redis SET NX with a 24h TTL — an event seen a second time within 24h is silently acknowledged as a duplicate, not rejected.

**Implementation**:
```ts
// returns true if this is a new event, false if duplicate
async isNew(idempotencyKey: string): Promise<boolean> {
  const result = await redis.set(
    `dupe:${idempotencyKey}`,
    "1",
    "NX",
    "EX",
    86_400
  );
  return result === "OK";
}
```

**Acceptance**:
- Same `idempotencyKey` submitted twice within 24h: first returns `accepted`, second returns `duplicate`
- Different `idempotencyKey` for same event data: both accepted (dedup is key-based, not content-based)
- Redis failure does not block ingestion — log the error, treat as new event (fail open on dedup)

---

## T-033 · Redis Streams publisher

**File**: `apps/usage-service/src/events/stream.publisher.ts`

**Story**: Publish validated, deduplicated events to Redis Streams for the Worker to consume. Uses `MAXLEN ~` (approximate trimming) to cap stream length without blocking the write path.

**Implementation**:
```ts
await redis.xadd(
  streamName,
  "MAXLEN", "~", maxLen,
  "*",                       // broker-assigned ID
  "tenantId", tenantId,
  "payload", JSON.stringify(event),   // nested JSON as a single field
  "publishedAt", new Date().toISOString()
);
```

**Acceptance**:
- Each call to `publish(event)` adds exactly one entry to the stream
- Stream does not grow unbounded — `MAXLEN ~` keeps it at approximately `STREAM_MAX_LEN`
- Publish failure throws — caller (ingestion service) handles and returns `500`

---

## T-034 · Tenant context middleware

**File**: `apps/usage-service/src/middleware/index.ts`

**Story**: Extract and validate the `X-Tenant-Id` header injected by the gateway. Attach it to the request as a typed `TenantId`. All subsequent handlers use `req.tenantId` — never `req.headers['x-tenant-id']` directly.

```ts
// enforces tenant context is always present on authenticated routes
export const tenantContextMiddleware: preHandlerHookHandler = (req, reply, done) => {
  const tenantId = req.headers["x-tenant-id"] as string | undefined;
  if (!tenantId) {
    return reply.status(401).send({ code: "TENANT_CONTEXT_MISSING" });
  }
  req.tenantId = tenantId as TenantId;
  done();
};
```

**Type augmentation**:
```ts
declare module "fastify" {
  interface FastifyRequest {
    tenantId: TenantId;
  }
}
```

---

## T-035 · Usage summary — `GET /v1/usage/summary`

**Files**: `controllers/usage.controller.ts`, `services/usage.service.ts`, `repositories/usage.repository.ts`
**Milestone**: v1

**Query params**:
```ts
{
  from: string;                        // ISO8601
  to: string;                          // ISO8601
  granularity: "hour" | "day" | "week";
  metricKey?: string;                  // filter to a specific metric
  page?: number;                       // default 1
  pageSize?: number;                   // default 20, max 100
}
```

**Logic**: Query `UsageLine` grouped by `metricKey` and time bucket (using `DATE_TRUNC` in Prisma raw query or computed bucket). All queries filtered by `tenantId`. Return `PaginatedResult<{ metricKey, bucketStart, bucketEnd, totalQuantity }>`.

**Acceptance**:
- Response is always tenant-scoped — no cross-tenant data leakage possible
- `granularity=day` bucket boundaries are midnight UTC (Q3 decision placeholder — adjust when Q3 is answered)
- Empty date ranges return `{ items: [], total: 0 }` not an error

---

## T-036 · Usage service integration tests

**File**: `apps/usage-service/tests/usage.integration.test.ts`
**Milestone**: v1

**Test cases**:
- Ingest batch of 5 events → `202 { accepted: 5, duplicate: 0 }`
- Ingest same batch again → `202 { accepted: 0, duplicate: 5 }`
- Ingest batch exceeding `INGEST_BATCH_MAX` → `400 BATCH_TOO_LARGE`
- `occurredAt` more than 24h in the future → `400 VALIDATION_ERROR`
- Summary query with seeded `UsageLine` data → correct totals per bucket
- Summary query with `metricKey` filter → only matching metric returned
- Summary with no data → `{ items: [], total: 0 }`
