# T-012 Plan: Prisma Client Singleton

## Business Objective & User Impact

**Problem**: During development with Fastify hot reload or plugin re-registration cycles, multiple `PrismaClient` instances can be created, leading to:
- Connection pool exhaustion
- Memory leaks
- Unpredictable behavior during development

**User Impact**: Developers working locally can iterate confidently without connection issues. Services scale predictably from dev to production.

---

## Task Goal

Implement a consistent Prisma singleton pattern across all 5 backend services (auth-service, usage-service, worker-service, billing-service, analytics-service) that:
1. Prevents duplicate `PrismaClient` instances during module re-evaluation
2. Configures logging to show errors and warnings only (not queries in production)
3. Respects NODE_ENV to cache the singleton only in non-production

---

## Scope: Files to Modify

**5 files, all identical implementation**:
- `apps/auth-service/src/lib/prisma.ts`
- `apps/usage-service/src/lib/prisma.ts`
- `apps/worker-service/src/lib/prisma.ts`
- `apps/billing-service/src/lib/prisma.ts`
- `apps/analytics-service/src/lib/prisma.ts`

**Current State**: All 5 files exist but are **incomplete** — missing the logging config `{ log: ["error", "warn"] }` required by the acceptance criteria.

---

## Acceptance Criteria

1. ✅ Exactly one `PrismaClient` instance exists per process (singleton via globalThis)
2. ✅ Logging configured to `["error", "warn"]` (production-safe — no query spam)
3. ✅ Singleton is cached on `globalThis.prisma` **only** when `NODE_ENV !== "production"`
4. ✅ No TypeScript errors or type ambiguity in any service
5. ✅ All 5 services use identical pattern (consistency for maintainability)

---

## Local Hypothesis

**Hypothesis**: The existing files have the core singleton mechanism but are missing the logging configuration passed to the `PrismaClient` constructor. Updating all 5 files to include `{ log: ["error", "warn"] }` in the constructor and aligning implementation will complete the pattern as specified in Epic 3.

**Falsifiable test**: Run `tsc --noEmit` on each service and verify no type errors; inspect the Prisma connection logs to confirm only errors and warnings appear (not `query` events).

---

## Implementation Steps

### Step 1: Review Current Implementation (Read-only)
- Inspect each of the 5 `prisma.ts` files to confirm they all have identical structure
- Note: All 5 are missing the logging config in the constructor

**Why this step**: Confirms our hypothesis and ensures we update consistently.

### Step 2: Update Auth Service
- Modify `apps/auth-service/src/lib/prisma.ts`
- Change constructor call from `new PrismaClient()` to `new PrismaClient({ log: ["error", "warn"] })`
- Simplify defensive type checking: keep it readable but remove unnecessary complexity if any

**Pattern to apply**:
```typescript
export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ["error", "warn"] });
```

### Step 3: Update Usage Service
- Apply identical change to `apps/usage-service/src/lib/prisma.ts`

### Step 4: Update Worker Service
- Apply identical change to `apps/worker-service/src/lib/prisma.ts`

### Step 5: Update Billing Service
- Apply identical change to `apps/billing-service/src/lib/prisma.ts`

### Step 6: Update Analytics Service
- Apply identical change to `apps/analytics-service/src/lib/prisma.ts`

### Step 7: Validate TypeScript Across All Services
- Run `pnpm typecheck` from workspace root to verify all 5 services have no type errors
- Spot-check that the `prisma` export is correctly typed as `PrismaClient`

### Step 8: Verify Singleton Behavior (Code Review)
- Confirm all 5 files have identical logic flow:
  1. Type-safe Prisma import
  2. globalThis cast with optional `prisma?` property
  3. Singleton instantiation with `log: ["error", "warn"]`
  4. NODE_ENV check to gate globalThis caching

---

## Step-Level Validations

| Step | Validation Command | Expected Output | Failure Mode |
|------|-------------------|-----------------|--------------|
| 1 | `grep -l "new PrismaClient()" apps/*/src/lib/prisma.ts` | All 5 files listed | One or more already has logging config |
| 2–6 | After each file edit: `pnpm typecheck` | No errors | Type mismatch in constructor or export |
| 7 | `pnpm typecheck` (full workspace) | No errors in any service | Type regression in dependent code (controllers, repositories) |
| 8 | `grep "log: \[\"error\", \"warn\"\]" apps/*/src/lib/prisma.ts` | 5 matches (one per file) | Missing or inconsistent logging config |

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Typo in logging config** | High | Double-check literal: `["error", "warn"]` — grep after each edit to confirm exact string |
| **Inconsistent impl across services** | High | Apply identical diff to all 5 files; use find+replace rather than manual edits |
| **NODE_ENV check inverted** | High | Verify logic: cache ONLY when `NODE_ENV !== "production"` (not equals); review before commit |
| **PrismaClient type import breaks** | Medium | Run full typecheck; existing import structure is proven; low risk if copying unchanged |
| **Logging config causes side effects** | Low | `["error", "warn"]` is standard Prisma config; will not introduce new behaviors |
| **Missed services** | Medium | All 5 services must be updated or some will have inconsistent behavior; validate all 5 before merge |

---

## Pending Tasks After T-012

- **T-013**: Tenant-scoped repository base — depends on `prisma` singleton being available in container
- **T-014**: App container expansion — will register singleton `prisma` from these modules
- **T-015**: Graceful shutdown — will call `prisma.$disconnect()` on exit
- **T-016**: `.env.example` files — documents required env vars; not blocked by T-012

---

## Acceptance Criteria Mapping

| Criterion | Implementation Step | Validation |
|-----------|-------------------|-----------|
| One instance per process | Steps 2–6 (globalThis cache) | Run in REPL: import twice, verify identical object |
| Errors/warnings logged | Steps 2–6 (log config) | Grep for `"error", "warn"` in all 5 files |
| NODE_ENV check | Steps 2–6 (singleton gate) | Code review: `NODE_ENV !== "production"` logic |
| No type errors | Step 7 | `pnpm typecheck` returns clean |
| Consistency | Step 8 | All 5 files pass identical grep patterns |

