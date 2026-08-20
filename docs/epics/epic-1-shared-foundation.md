# Epic 1 — Shared Foundation

**Milestone**: v1-mvp
**Depends on**: Nothing — start here
**Blocks**: All other epics

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q1 — Event payload shape | Lock field names + types before shared-types |
| Q6 — Multi-tenancy | Single membership or multi-tenant per user? |
| Q7 — API versioning | `/v1/` prefix on all external routes? |

---

## T-001 · `shared-config`: env parser factory

**File**: `packages/shared-config/src/index.ts`

**Story**: Each service already has its own `EnvSchema` stub in `config/env.ts`. Create a generic `parseEnv<T extends ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv): z.infer<T>` factory that validates and returns typed config or throws on startup with the missing field name clearly stated.

**Acceptance**:
- Calling `parseEnv` with a missing required key throws with the field name in the message
- All 6 services migrate to calling `parseEnv(EnvSchema, process.env)` in their `config/env.ts`
- Returns a frozen object (immutable config)

**Dependencies**: None

---

## T-002 · `shared-logger`: Pino logger factory

**File**: `packages/shared-logger/src/index.ts`

**Story**: Expose `createLogger(serviceName: string): Logger` returning a Pino instance with structured JSON output, `service` field on every line, `level` from env, and `traceId`/`spanId` injected from the active OTel context when available.

**Acceptance**:
- Logger emits valid JSON to stdout
- `service` field present on every log line
- `traceId` appears in log output when an OTel span is active
- `level` defaults to `info`, overridable via `LOG_LEVEL` env

**Dependencies**: T-003 (OTel context needed for trace injection)

---

## T-003 · `shared-tracing`: OTel SDK bootstrap

**File**: `packages/shared-tracing/src/index.ts`

**Story**: Expose `initTracing(serviceName: string): void`. Must configure `NodeTracerProvider` with OTLP HTTP exporter pointed at `OTEL_EXPORTER_OTLP_ENDPOINT`. Must register auto-instrumentations for Fastify, Prisma, and `ioredis`. Must be called as the **first line** in every service `src/index.ts` before any other import.

**Acceptance**:
- Calling `initTracing` before Fastify produces spans in OTLP-compatible format
- Spans include `service.name` resource attribute
- No-ops gracefully if `OTEL_EXPORTER_OTLP_ENDPOINT` is not set (dev convenience)

**Dependencies**: None

---

## T-004 · `shared-types`: domain contracts

**File**: `packages/shared-types/src/index.ts`

**Story**: Define the canonical TypeScript contracts shared across all services. These must be locked before any service implementation begins. Branded types prevent raw strings being passed where domain IDs are expected.

**Types to define**:
```ts
// Branded ID types
type TenantId = string & { readonly __brand: 'TenantId' }
type UserId = string & { readonly __brand: 'UserId' }
type EventId = string & { readonly __brand: 'EventId' }
type InvoiceId = string & { readonly __brand: 'InvoiceId' }

// Canonical inbound event shape — frozen after Q1 decision
interface EventPayload {
  eventType: string
  quantity: number
  unit: string
  occurredAt: string        // ISO8601 — decision: client-supplied or server-stamped?
  idempotencyKey?: string   // decision: optional client key or always server-generated?
  metadata?: Record<string, unknown>
}

// API response wrappers
interface ApiResponse<T> { data: T; meta?: Record<string, unknown> }
interface PaginatedResult<T> { items: T[]; total: number; page: number; pageSize: number }
interface PaginationMeta { page: number; pageSize: number; total: number }

// Shared param shapes
interface PaginationParams { page: number; pageSize: number }
interface DateRangeParams { from: string; to: string }
```

**Acceptance**:
- TypeScript rejects assigning a raw `string` to `TenantId` without an explicit cast
- `EventPayload` matches the Q1 decision exactly — no fields added without updating this type

**Dependencies**: Q1 and Q6 must be answered before this is considered final

---

## T-005 · `shared-validation`: reusable Zod schema fragments

**File**: `packages/shared-validation/src/index.ts`

**Story**: Export composable Zod schemas that services import and `.merge()` or `.extend()`. Prevents each service from redefining the same validation logic independently.

**Schemas to export**:
```ts
uuidSchema          // z.string().uuid()
iso8601Schema       // z.string().datetime({ offset: true })
paginationSchema    // { page: z.coerce.number().min(1), pageSize: z.coerce.number().min(1).max(100) }
dateRangeSchema     // { from: iso8601Schema, to: iso8601Schema } + refinement: from < to
tenantIdSchema      // uuidSchema branded
eventTypeSchema     // z.string().min(1).max(64).regex(/^[a-z0-9_.]+$/)
```

**Acceptance**:
- `dateRangeSchema` rejects payloads where `from >= to`
- `paginationSchema` coerces query string numbers correctly
- Unit tests cover all edge cases

**Dependencies**: T-004

---

## T-006 · `shared-utils`: pure utility helpers

**File**: `packages/shared-utils/src/index.ts`

**Story**: Pure, side-effect-free utility functions shared across services. No external dependencies beyond Node.js built-ins.

**Functions**:
```ts
generateIdempotencyKey(tenantId: string, eventType: string, timestamp: string): string
// deterministic SHA-256 hex of concatenated inputs — same inputs always produce same key

chunkArray<T>(arr: T[], size: number): T[][]
// splits array into chunks of `size`

sleep(ms: number): Promise<void>
// resolves after ms milliseconds

retryWithBackoff<T>(fn: () => Promise<T>, opts: { maxAttempts: number; baseDelayMs: number }): Promise<T>
// exponential backoff with jitter

formatCurrency(amountInCents: number, currency: string): string
// e.g. formatCurrency(1999, 'USD') → '$19.99'

formatBytes(bytes: number): string
// e.g. formatBytes(1048576) → '1 MB'
```

**Acceptance**:
- `generateIdempotencyKey` is deterministic — identical inputs produce identical output across calls
- `retryWithBackoff` throws the last error after all attempts are exhausted
- 100% branch coverage in unit tests

**Dependencies**: None
