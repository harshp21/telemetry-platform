# T-014 Plan: App Container Expansion

**Epic**: Epic 3 (Shared Service Infrastructure)  
**Task**: T-014 (App Container Expansion)  
**Dependency**: T-012 (Prisma Singleton) ✅, T-013 (Tenant-Scoped Repository) ✅  
**Decision Gate**: Logger auto-wire via container — APPROVED  
**Status**: Ready for Implementation

---

## Business Objective & User Impact

**Problem**: Services have no unified access to runtime dependencies (logger, DB, cache). Each service independently creates loggers and Prisma clients inline, scattered across routes and plugins. This creates:
- No single source of configuration for dependency initialization
- Impediment to dependency injection in tests (can't mock container.logger, container.prisma)
- Friction for adding new dependencies (e.g., metrics client, external API clients)

**User Impact**: Services transition from ad-hoc dependency access to controlled DI via the app container. This unblocks:
- Test mocking and isolation (routes can request container from context, not create clients)
- Fastify-integrated dependency access (plugins and routes access `fastify.container.prisma`)
- Consistent logger injection across services
- Foundation for async initialization in Epic 4+

---

## Task Goal

Expand `AppContainer` from minimal stub `{ serviceName }` to full dependency container with wired properties:

**All 5 app services + gateway**:
- `serviceName: string`
- `env: ServiceEnv`
- `logger: Logger`
- `prisma: PrismaClient` (app services only; **gateway omits**)
- `redis: Redis`

Then register the container on Fastify via type-augmented `fastify.container` decoration so plugins and route handlers can access dependencies via `fastify.container.logger`, etc.

---

## Scope: Files to Modify

**Template service (auth-service)** — serves as the owning reference for all others:
- `apps/auth-service/src/config/container.ts` — interface + factory
- `apps/auth-service/src/config/fastify.d.ts` — Fastify module augmentation (new file)
- `apps/auth-service/src/app.ts` — wire + decorate

**Replicate pattern to 4 more app services** (identical implementation):
- `apps/usage-service/src/config/container.ts` + `fastify.d.ts` + `app.ts`
- `apps/worker-service/src/config/container.ts` + `fastify.d.ts` + `app.ts`
- `apps/billing-service/src/config/container.ts` + `fastify.d.ts` + `app.ts`
- `apps/analytics-service/src/config/container.ts` + `fastify.d.ts` + `app.ts`

**Gateway (special case — no Prisma)**:
- `apps/gateway/src/config/container.ts` + `fastify.d.ts` + `app.ts` (omit Prisma property)

**No changes to**:
- `index.ts` entry files (already load env and trace)
- `repositories/` (T-013 provides Logger injection pattern)
- Route files, controllers, services (integration proof happens in existing health endpoint)

---

## Owning Surface & Template Pattern

**Primary Template**: `apps/auth-service/src/config/container.ts` + `apps/auth-service/src/app.ts`

All other services follow the same pattern. Auth-service is the reference because:
- Most complete: has all dependencies (env, Prisma, Redis, Logger)
- Most tested: will validate all wiring patterns
- Others (usage, worker, billing, analytics) are identical copies
- Gateway is single variation (no Prisma, but same env/logger/redis wiring)

---

## Local Hypothesis

**Hypothesis**: AppContainer interface can be expanded to include all 5 properties with type-safe imports of `Logger` from shared-logger, `ServiceEnv` from each service's env.ts, and `PrismaClient` + `Redis` from external packages. Container factory function can wire all dependencies by:
1. Accepting `env: ServiceEnv` and optional `logger?: Logger` parameters
2. Using `prisma` from `./lib/prisma.ts` (T-012 singleton already provides this)
3. Creating fresh `Redis` instance from env.REDIS_URL
4. Returning container object with all properties

**Falsifiable test**: Run `pnpm typecheck` on all 6 services → 0 errors. Inspect auth-service app.ts health endpoint to confirm it can access `container.logger` without errors.

---

## Implementation Steps

### Step 1: Create Fastify Module Augmentation (auth-service)
- **File**: `apps/auth-service/src/config/fastify.d.ts` (new file)
- **Content**: 
  ```typescript
  import type { FastifyInstance } from "fastify";
  import type { AppContainer } from "./container";

  declare module "fastify" {
    interface FastifyInstance {
      container: AppContainer;
    }
  }
  ```
- **Purpose**: Teach TypeScript that fastify instance has `.container: AppContainer`

### Step 2: Expand AppContainer Interface (auth-service)
- **File**: `apps/auth-service/src/config/container.ts` (lines 1–4)
- **Add imports**:
  ```typescript
  import type { Logger } from "pino";
  import type { PrismaClient } from "@prisma/client";
  import type Redis from "ioredis";
  import type { ServiceEnv } from "./env";
  ```
- **Update interface**:
  ```typescript
  export interface AppContainer {
    readonly serviceName: string;
    readonly env: ServiceEnv;
    readonly logger: Logger;
    readonly prisma: PrismaClient;
    readonly redis: Redis;
  }
  ```

### Step 3: Update createContainer Factory (auth-service)
- **File**: `apps/auth-service/src/config/container.ts` (lines 6+)
- **Add imports**:
  ```typescript
  import { prisma } from "../lib/prisma";
  import Redis from "ioredis";
  import { createLogger } from "@telemetry/shared-logger";
  ```
- **Replace factory**:
  ```typescript
  export const createContainer = (
    serviceName: string,
    env: ServiceEnv,
    logger?: Logger
  ): AppContainer => {
    const redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true
    });

    return {
      serviceName,
      env,
      logger: logger ?? createLogger(serviceName),
      prisma,
      redis: redisClient
    };
  };
  ```

### Step 4: Update auth-service app.ts for Decoration
- **File**: `apps/auth-service/src/app.ts`
- **Add import**:
  ```typescript
  import { env } from "./config/env";
  import "./config/fastify"; // Module augmentation
  ```
- **Update buildAuthServiceApp function**:
  - Change `createContainer(AUTH_SERVICE_NAME)` to `createContainer(AUTH_SERVICE_NAME, env)`
  - Add `app.decorate("container", container)` after container creation
  - In health endpoint, access `app.container.logger` to prove wiring works

### Step 5–8: Apply Same Pattern to 4 Other App Services
- Repeat Steps 1–4 for:
  - `apps/usage-service/src/config/container.ts` + `fastify.d.ts` + `app.ts`
  - `apps/worker-service/src/config/container.ts` + `fastify.d.ts` + `app.ts`
  - `apps/billing-service/src/config/container.ts` + `fastify.d.ts` + `app.ts`
  - `apps/analytics-service/src/config/container.ts` + `fastify.d.ts` + `app.ts`
- **Variation**: Identical to auth-service (no special cases for other app services)

### Step 9: Gateway Variation (Omit Prisma)
- **File**: `apps/gateway/src/config/fastify.d.ts` (new file) — identical to other services
- **File**: `apps/gateway/src/config/container.ts`
  - Identical pattern to other services
  - **BUT**: `AppContainer` interface omits `prisma` property
  - No import of `@prisma/client` or `prisma` from lib
- **File**: `apps/gateway/src/app.ts`
  - Update `createContainer(GATEWAY_SERVICE_NAME)` to `createContainer(GATEWAY_SERVICE_NAME, env)`
  - Add `app.decorate("container", container)` after container creation
  - Access `app.container.logger` in health endpoint

### Step 10: Workspace Typecheck Validation
- **Command**: `pnpm typecheck`
- **Expected**: All 13 packages pass with 0 errors
- **Failure modes**:
  - If env.ts doesn't export ServiceEnv type → Fix: ensure all services have ServiceEnv export
  - If Logger doesn't resolve → Fix: verify `import type { Logger } from "pino"` is correct
  - If Redis type conflicts → Fix: use `import type Redis from "ioredis"` in interfaces, `import Redis` in factories

---

## Validation Strategy

| Step | Validation | Command/Check | Expected Outcome |
|------|-----------|---|---|
| 1 | Fastify module augmentation syntax | TypeScript parse | No syntax errors |
| 2 | AppContainer interface expands | `tsc --noEmit` on auth-service | Types resolve |
| 3 | Factory accepts env param | Build auth-service | No compile errors |
| 4 | Decoration works on Fastify | Inspect app.ts | `app.container.logger` accessible |
| 5–8 | Identical pattern on 4 services | `pnpm typecheck` all 5 | 0 errors per service |
| 9 | Gateway omits Prisma | `pnpm typecheck apps/gateway` | 0 errors, no Prisma property |
| 10 | Full workspace validation | `pnpm typecheck` (root) | All 13 packages pass |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Logger type conflict**: shared-logger exports pino.Logger; base.repository.ts defines local Logger interface | Type mismatch in container.logger assignment | Unify Logger type in Epic 12; for now, align imports to use consistent type |
| **Redis connection pooling**: Multiple services create independent Redis instances at startup, exhausting connection limits | Resource exhaustion in development | Use `lazyConnect: true` (already in code); test with `docker-compose up` Redis service; defer connection pooling to Epic 8 |
| **Prisma singleton not initialized**: If createContainer called before prisma.ts module loads | Runtime error accessing container.prisma | Ensure prisma.ts is imported early; verify T-012 Prisma singleton is already wired (it is) |
| **Tests mock container incorrectly**: Unit tests create fake containers without logger/redis | Type-safe mocking breaks | Leave container mocking as follow-up task (Epic 12); document test pattern in task notes |

---

## Pending Tasks & Follow-up Work

1. **Logger Type Unification** (minor, Epic 12 scope)
   - Consolidate Logger interface: remove from base.repository.ts, export from shared-logger
   - Update all imports
   - Status: Can proceed with local Logger definition for now; refactor later

2. **Rate-Limit Plugin Refactor** (minor, out of scope)
   - Gateway's rate-limit.plugin.ts currently accepts standalone config, not container
   - Update it to accept container and read `container.env.REDIS_URL`, etc.
   - Status: Can remain as-is during this task; refactor in next epic

3. **Container Mocking in Tests** (future Epic 12 task)
   - Services will need test utilities to create mock containers with `Partial<AppContainer>`
   - Document pattern in `docs/testing-guide.md` or test helper module

4. **Redis Connection Lifecycle** (future Epic 8 task)
   - Currently creates fresh Redis per service; may need pool or shared instance
   - Document teardown: ensure `container.redis.disconnect()` on Fastify shutdown hook

---

## Acceptance Criteria

- [ ] All 6 services have AppContainer interface with: `serviceName, env, logger, prisma (omit for gateway), redis`
- [ ] All 6 services have createContainer factory wiring all properties
- [ ] All 6 services have `fastify.d.ts` module augmentation
- [ ] All 6 services call `app.decorate('container', container)` in app.ts
- [ ] All 6 services' health endpoints access `container.logger` (proof of integration)
- [ ] `pnpm typecheck` passes all 13 packages with 0 errors
- [ ] Gateway explicitly does NOT include Prisma property
- [ ] No changes to any route handler, middleware, plugin, or repository file (integration only)

---

## Ready for Implementation

**YES** — Plan is complete and ready for Task Implementer.

**Why**:
1. ✅ Template surface identified (auth-service container.ts + app.ts)
2. ✅ Edit slices are independent and can be validated incrementally
3. ✅ Validation strategy is clear: typecheck after each service, then full workspace typecheck
4. ✅ Gateway variation is documented and isolated
5. ✅ Risks are named and mitigated
6. ✅ All 10 steps have specific file paths and expected outcomes
7. ✅ Pending tasks are listed for future work (not blockers)
