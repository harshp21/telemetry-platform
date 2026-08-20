# Epic 3 — Shared Service Infrastructure

**Milestone**: v1-mvp
**Depends on**: Epic 1, Epic 2
**Blocks**: Epics 4–9 (all services build on this)

**Note**: These tasks apply identically to all 5 backend services (auth, usage, worker, billing, analytics). Gateway is partial — no Prisma, no tenant scope.

---

## T-012 · Prisma client singleton

**Files**: `apps/{service}/src/lib/prisma.ts` (auth, usage, worker, billing, analytics)

**Story**: Prevent multiple `PrismaClient` instances being created during Fastify plugin re-registration or hot reload in development. Each service gets one singleton module.

**Implementation**:
```ts
import { PrismaClient } from "@prisma/client";

// prevents duplicate connections during development HMR
const globalForPrisma = globalThis as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ["error", "warn"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

**Acceptance**:
- Only one `PrismaClient` instance exists per process
- Logs errors and warnings, not queries in production

---

## T-013 · Tenant-scoped repository base

**Files**: `apps/{service}/src/repositories/base.repository.ts`

**Story**: Every DB query in every service must be scoped to a `tenantId`. A base class enforces this at the type level — raw `prisma.event.findMany()` calls are banned outside this layer. Retrofitting this after Epic 6+ would touch every repository method.

**Interface**:
```ts
export abstract class TenantScopedRepository {
  constructor(
    protected readonly prisma: PrismaClient,
    protected readonly tenantId: TenantId
  ) {}

  // subclasses call this.where({ ...extraConditions }) which auto-merges tenantId
  protected where<T extends Record<string, unknown>>(conditions: T) {
    return { ...conditions, tenantId: this.tenantId };
  }
}
```

**Acceptance**:
- TypeScript error if a subclass calls `this.prisma.event.findMany()` without going through `this.where()`
- No direct `prisma.*` calls in any controller or service — only through repository classes

---

## T-014 · App container expansion (all services)

**Files**: `apps/{service}/src/config/container.ts`

**Story**: Expand the current `AppContainer` stub from `{ serviceName }` to a fully typed dependency container. Register on Fastify via `fastify.decorate` so all route handlers access dependencies through `req.server.container`.

**Interface**:
```ts
export interface AppContainer {
  readonly serviceName: string;
  readonly env: ServiceEnv;       // parsed + validated via parseEnv()
  readonly logger: Logger;        // from shared-logger
  readonly prisma: PrismaClient;  // singleton — omit in gateway
  readonly redis: Redis;          // ioredis instance
}
```

**Fastify type augmentation** in each service:
```ts
declare module "fastify" {
  interface FastifyInstance {
    container: AppContainer;
  }
}
```

**Acceptance**:
- `req.server.container.prisma` is typed and accessible in all route handlers
- Gateway container omits `prisma` (gateway has no DB access)
- Container creation fails fast if any dependency connection fails

---

## T-015 · Graceful shutdown (all services)

**Files**: `apps/{service}/src/index.ts`

**Story**: Each service must handle `SIGTERM` and `SIGINT` cleanly: drain in-flight HTTP requests, close DB connections, disconnect Redis, then exit. Worker service has additional steps (stop stream consumer loop). Kubernetes/Docker stop signals require this.

**Pattern**:
```ts
const shutdown = async (signal: string): Promise<void> => {
  container.logger.info({ signal }, "Shutting down");
  await app.close();               // drains in-flight requests
  await container.prisma.$disconnect();
  container.redis.disconnect();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
```

**Worker extra step**: Set a `shuttingDown` flag before `app.close()` so the stream consumer loop exits cleanly after its current batch.

**Acceptance**:
- `kill -TERM <pid>` produces "Shutting down" log then clean exit — no unclosed handle warnings
- In-flight requests complete before connections close

---

## T-016 · `.env.example` files (all services + root)

**Files**: `apps/{service}/.env.example`, `.env.example`

**Story**: Every developer needs a complete list of required env vars on first clone. No one should be blocked on local setup due to missing documentation.

**Root `.env.example`**:
```env
NODE_ENV=development
DATABASE_URL=postgresql://postgres:postgres@localhost:6432/telemetry
REDIS_URL=redis://localhost:6379
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
LOG_LEVEL=info
```

**Auth-service additions**:
```env
PORT=3001
JWT_SECRET=change-me-in-production
JWT_REFRESH_SECRET=change-me-refresh-in-production
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_SECONDS=604800
BCRYPT_ROUNDS=12
```

**Usage-service additions**:
```env
PORT=3002
REDIS_STREAM_NAME=telemetry:events
STREAM_MAX_LEN=100000
INGEST_BATCH_MAX=100
```

**Worker-service additions**:
```env
PORT=3003
REDIS_STREAM_NAME=telemetry:events
REDIS_CONSUMER_GROUP=worker-group
REDIS_CONSUMER_NAME=worker-1
STREAM_BLOCK_MS=5000
STREAM_BATCH_SIZE=10
MAX_RETRY_COUNT=3
DEAD_LETTER_STREAM=telemetry:dead-letter
```

**Billing-service additions**:
```env
PORT=3004
INTERNAL_API_SECRET=change-me-internal-secret
```

**Analytics-service additions**:
```env
PORT=3005
```

**Gateway additions**:
```env
PORT=3100
AUTH_SERVICE_URL=http://localhost:3001
USAGE_SERVICE_URL=http://localhost:3002
BILLING_SERVICE_URL=http://localhost:3004
ANALYTICS_SERVICE_URL=http://localhost:3005
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000
JWT_SECRET=change-me-in-production
```

**Acceptance**:
- All variables match the Zod `EnvSchema` for that service exactly — no undocumented variables, no missing ones
