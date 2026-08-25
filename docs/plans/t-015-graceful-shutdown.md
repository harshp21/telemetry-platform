# T-015 Plan: Graceful Shutdown (All Services)

**Epic**: Epic 3 (Shared Service Infrastructure)  
**Task**: T-015 (Graceful Shutdown)  
**Dependency**: T-014 (App Container Expansion) ✅  
**Status**: Ready for Implementation

---

## Business Objective & User Impact

**Problem**: Services currently have no graceful shutdown handlers. When Kubernetes/Docker sends `SIGTERM`:
- Processes exit immediately without closing connections
- In-flight HTTP requests are terminated mid-processing, causing data loss
- Database transactions are left open, triggering "unclosed handle" warnings
- Redis connections are abandoned, exhausting connection pools
- Worker service stream consumer loop abruptly stops, losing unacked messages

**User Impact**:
- **Operators**: Graceful rolling updates in Kubernetes; clean logs with shutdown lifecycle
- **Reliability**: No data loss during deployments; in-flight work completes before exit
- **Observability**: Shutdown lifecycle logged with timestamps and status codes

---

## Task Goal

Implement graceful `SIGTERM`/`SIGINT` signal handlers in all 6 services (auth, usage, worker, billing, analytics, gateway) that:

1. Intercept termination signals before process exit
2. Close HTTP server and drain in-flight requests
3. Disconnect Prisma (app services only; gateway omits)
4. Disconnect Redis
5. Log shutdown lifecycle with signal type, timestamps, and status
6. Exit cleanly with code 0
7. (Worker service only) Prepare `shuttingDown` flag for future stream consumer loop (T-039)

---

## Scope: Files to Modify

**All 6 services**, file pattern: `apps/{service}/src/index.ts`

| Service | Files | Variations |
|---------|-------|-----------|
| auth-service | `src/index.ts` | Disconnect Prisma + Redis |
| usage-service | `src/index.ts` | Disconnect Prisma + Redis |
| worker-service | `src/index.ts` | **Export `shuttingDown` flag** + Disconnect Prisma + Redis |
| billing-service | `src/index.ts` | Disconnect Prisma + Redis |
| analytics-service | `src/index.ts` | Disconnect Prisma + Redis |
| gateway | `src/index.ts` | **Omit Prisma** — Redis only |

**No changes to**:
- `app.ts` files (keep existing `onClose` hooks for Redis cleanup; shutdown handler will provide explicit disconnect)
- Routes, middleware, or plugin files
- Container or env configuration

---

## Implementation Strategy

Each service's `index.ts` will:

1. Capture the app instance from `buildXxxServiceApp()`
2. Create async `shutdown(signal: string)` function that:
   - Logs "Shutting down" with signal type
   - Calls `await app.close()` (drains HTTP in-flight requests)
   - Calls `await container.prisma.$disconnect()` (app services only)
   - Calls `container.redis.disconnect()` (all services)
   - Logs "Shutdown complete"
   - Exits with code 0 (or 1 on error)
3. Register handlers: `process.on("SIGTERM", ...)` and `process.on("SIGINT", ...)`
4. Worker service only: Export module-level `let shuttingDown = false` and set to `true` in shutdown

### Pseudo-code Pattern (Auth Service)

```typescript
// At top of file (worker service only)
export let shuttingDown = false;

async function start() {
  const container = createContainer("auth-service", env as ServiceEnv);
  const app = buildAuthServiceApp(container);
  
  const shutdown = async (signal: string): Promise<void> => {
    if (isWorker) shuttingDown = true; // worker-service only
    container.logger.info({ signal }, "Shutting down gracefully");
    try {
      await app.close();
      await container.prisma.$disconnect(); // omit for gateway
      container.redis.disconnect();
      container.logger.info("Shutdown complete");
      process.exit(0);
    } catch (error) {
      container.logger.error({ error, signal }, "Error during shutdown");
      process.exit(1);
    }
  };
  
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  
  await app.listen({ port: container.env.PORT, host: "0.0.0.0" });
}
```

---

## Detailed Implementation Steps

### Step 1–6: App Services (Auth, Usage, Billing, Analytics)
**Files**: `apps/{auth|usage|billing|analytics}-service/src/index.ts`

**Changes**:
1. Wrap `buildXxxServiceApp()` and signal registration in the `start()` function
2. Add `shutdown()` function that:
   - Sets `shuttingDown = true` (worker-service only)
   - Logs signal type
   - Closes app, prisma, redis
   - Exits with appropriate code
3. Register SIGTERM/SIGINT handlers after `app.listen()`

**Key Implementation Details**:
- `container` must be in scope (defined before shutdown function)
- `app` must be captured from `buildXxxServiceApp()` call
- Error handling: catch and exit with code 1
- Logging uses `container.logger` with structured context

---

### Step 7: Worker Service (with `shuttingDown` flag)
**File**: `apps/worker-service/src/index.ts`

**Additions** (in addition to Steps 1–6 pattern):
```typescript
export let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  shuttingDown = true; // Signal loop to stop
  container.logger.info({ signal }, "Shutting down gracefully");
  // ... rest of shutdown
};
```

**Why export at module level?**
- Future T-039 (stream consumer loop) will check `shuttingDown` in loop condition
- Must be accessible before any async functions

---

### Step 8: Gateway Service (Omit Prisma)
**File**: `apps/gateway/src/index.ts`

**Exception**: Remove `await container.prisma.$disconnect()` from shutdown handler

**Shutdown for gateway**:
```typescript
const shutdown = async (signal: string): Promise<void> => {
  container.logger.info({ signal }, "Shutting down gracefully");
  try {
    await app.close();
    container.redis.disconnect();
    container.logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    container.logger.error({ error, signal }, "Error during shutdown");
    process.exit(1);
  }
};
```

---

## Validation Strategy

| Check | Command | Expected | Pass? |
|-------|---------|----------|-------|
| **TypeCheck all 6 services** | `pnpm typecheck` | 0 errors on all 13 packages | ✅ |
| **Auth service shutdown handler** | Verify `shutdown()` and `process.on()` registered | No type errors | ✅ |
| **Worker `shuttingDown` flag export** | Verify module-level export and set in shutdown | No type errors | ✅ |
| **Gateway omits Prisma** | Verify no `container.prisma` in gateway shutdown | No type errors | ✅ |
| **Manual signal test (optional)** | `pnpm dev -F auth-service` then `kill -TERM <pid>` | "Shutting down" log, clean exit, no warnings | ⚠️ |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| In-flight requests timeout before close completes | Rely on orchestrator's `terminationGracePeriodSeconds` (k8s 30s default); document in logs |
| Prisma disconnect blocks shutdown | Prisma v4+ sub-second; timeout wrapper if needed (future optimization) |
| `redis.disconnect()` called twice (onClose hook + shutdown) | Idempotent; safe; acceptable; provides redundancy |
| Worker `shuttingDown` flag not used yet (T-039) | Document as T-039 preparation; mark with TODO if desired |
| Gateway accidentally includes Prisma | Code review + typecheck catches interface errors |

---

## Acceptance Criteria

- [ ] All 6 services have graceful shutdown in `src/index.ts`
- [ ] Shutdown sequence: `app.close()` → `prisma.$disconnect()` (app services) → `redis.disconnect()` → exit
- [ ] Both `SIGTERM` and `SIGINT` handled
- [ ] Logs: "Shutting down gracefully" (with signal) + "Shutdown complete"
- [ ] Error during shutdown caught, logged, exits with code 1
- [ ] Gateway omits Prisma disconnect
- [ ] Worker service exports `shuttingDown` flag and sets it in shutdown
- [ ] `pnpm typecheck` passes (all 13 packages, 0 errors)
- [ ] Manual signal test shows clean exit without warnings (optional but recommended)

---

## Pending Tasks & Follow-up

| Task | ID | Status | Notes |
|------|----|----|---|
| Unit tests for shutdown | T-024b | Pending | Test signal handler registration + resource cleanup |
| .env.example documentation | T-016 | Blocked | Depends on T-015 completion |
| Stream consumer loop with shuttingDown | T-039 | Pending | Will import `shuttingDown` from worker-service |

---

## Stage Tracker

- Current stage: Task Planning (done)
- Previous stage: Epic Router (done)
- Next stage: Implementation
- Blocker reason: none
- Pending tasks snapshot:
  - T-015 Phase 1: Implement shutdown handlers (Steps 1–8, pending)
  - T-015 Phase 2: Typecheck validation (pending)
  - T-016 follow-up: env.example documentation (blocked on T-015 completion)
- Evidence: Plan file at `/home/admin1/personal-workspace/telemetry-platform/docs/plans/t-015-graceful-shutdown.md`
