# T-034: Usage Service Tenant Context Middleware

**Plan Version**: 1.0  
**Created**: 2026-08-26  
**Task ID**: T-034  
**Epic**: Epic 6 — Usage Service  
**Effort**: S (~3 hours)

---

## Business Objective

Enable the Usage Service to enforce per-tenant isolation by extracting and validating the `X-Tenant-Id` header on all authenticated requests. This middleware ensures:
1. Tenant context is available throughout the request lifecycle
2. Unauthenticated requests without tenant ID are rejected early
3. Tenant ID is properly typed and available to handlers

This task is a **critical foundation** for T-031 (ingestion endpoint), T-032 (dedup), T-033 (stream publisher), and all downstream usage-service features.

---

## Task Goal

Create a Fastify middleware that extracts and validates the `X-Tenant-Id` header, augments the request with typed `tenantId: string`, and rejects requests without tenant context.

---

## Owning Files

| File | Current State | Change | Effort |
|------|---------------|--------|--------|
| [apps/usage-service/src/middleware/tenant-context.middleware.ts](apps/usage-service/src/middleware/tenant-context.middleware.ts) | **Does not exist** | Create new file with middleware implementation | 10 min |
| [apps/usage-service/src/middleware/index.ts](apps/usage-service/src/middleware/index.ts) | May not exist | Create/extend to export middleware | 2 min |
| [apps/usage-service/tests/middleware.tenant-context.unit.test.ts](apps/usage-service/tests/middleware.tenant-context.unit.test.ts) | **Does not exist** | Create unit test file with 5–6 test cases | 20 min |
| [apps/usage-service/src/app.ts](apps/usage-service/src/app.ts) | Exists; basic structure | Register middleware in onRequest hook chain | 3 min |

---

## Local Hypothesis

**Falsifiable statement**: We can implement per-tenant context extraction using a Fastify onRequest hook that validates the X-Tenant-Id header, augments the request type safely, and ensures all handlers have access to typed tenantId.

**Testing approach**: Pseudo-TDD (tests first) covering header extraction, validation failures, and type safety.

---

## Implementation Steps (Pseudo-TDD Pattern)

### Step 1: Write Tests FIRST (10 min)
**File**: [apps/usage-service/tests/middleware.tenant-context.unit.test.ts](apps/usage-service/tests/middleware.tenant-context.unit.test.ts)

Test scenarios:
```ts
describe("tenant context middleware", () => {
  it("extracts and attaches X-Tenant-Id header when present", () => {
    // Mock request with X-Tenant-Id: "tenant-123"
    // Verify request.tenantId === "tenant-123"
  });
  
  it("rejects request with missing X-Tenant-Id header", () => {
    // Mock request without header
    // Verify 401 TENANT_CONTEXT_MISSING response
  });
  
  it("rejects request with empty X-Tenant-Id header", () => {
    // Mock request with X-Tenant-Id: ""
    // Verify 401 TENANT_CONTEXT_MISSING response
  });
  
  it("preserves existing request properties", () => {
    // Verify method, url, etc. unchanged
  });
  
  it("handles header case-insensitivity", () => {
    // Test x-tenant-id and X-Tenant-Id
  });
  
  it("returns typed tenantId on request object", () => {
    // Verify type safety: request.tenantId: string
  });
});
```

---

### Step 2: Implement Middleware (10 min)
**File**: [apps/usage-service/src/middleware/tenant-context.middleware.ts](apps/usage-service/src/middleware/tenant-context.middleware.ts)

Pattern:
```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

declare global {
  namespace FastifyInstance {
    interface FastifyRequest {
      tenantId: string;
    }
  }
}

export const usageTenantContextHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const tenantId = request.headers["x-tenant-id"];
  
  if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
    reply.status(401).send({
      code: "TENANT_CONTEXT_MISSING",
      message: "X-Tenant-Id header is required"
    });
    return;
  }
  
  request.tenantId = tenantId;
};

export const registerUsageTenantContextMiddleware = (
  app: FastifyInstance
): void => {
  app.addHook("onRequest", usageTenantContextHandler);
};
```

---

### Step 3: Extend Middleware Index (2 min)
**File**: [apps/usage-service/src/middleware/index.ts](apps/usage-service/src/middleware/index.ts)

Export all middleware:
```ts
export { registerUsageTenantContextMiddleware } from "./tenant-context.middleware";
```

---

### Step 4: Register in App (3 min)
**File**: [apps/usage-service/src/app.ts](apps/usage-service/src/app.ts)

Add middleware registration before route handlers:
```ts
import { registerUsageTenantContextMiddleware } from "./middleware";

export const buildUsageApp = (): FastifyInstance => {
  const app = Fastify({ logger: true });
  
  registerGlobalErrorHandler(app);
  registerUsageTenantContextMiddleware(app); // Before routes
  
  // ... routes, handlers, etc.
  
  return app;
};
```

---

### Step 5: Task-Scoped Validation (5 min)

Run tests and checks scoped to usage-service:
```bash
pnpm --filter @telemetry/usage-service test -- tenant-context
pnpm --filter @telemetry/usage-service lint
pnpm --filter @telemetry/usage-service typecheck
```

**Expected Result**: All green ✓

---

### Step 6: Full Workspace Validation (10 min)

Ensure no regressions across all 13 packages:
```bash
pnpm build && pnpm test && pnpm lint && pnpm typecheck
```

**Expected Result**: All 13 packages pass; no failures

---

## Acceptance Criteria

| Criterion | How to Verify |
|-----------|---------------|
| X-Tenant-Id header extracted from request | Test: request.tenantId populated |
| Missing/empty header returns 401 TENANT_CONTEXT_MISSING | Test: error cases |
| Request properties preserved (method, url, etc.) | Test: verify unchanged |
| Type-safe: tenantId: string on FastifyRequest | TypeScript: strict typing, no `any` |
| Middleware registered in app.ts | Code inspection + startup test |
| All tests pass (5–6 test cases) | `pnpm --filter @telemetry/usage-service test` green |
| Full workspace validation passes | `pnpm build test lint typecheck` all 13 packages |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Header case sensitivity mismatch | Low | Logic error | Test both cases; use lowercase header lookup |
| Type augmentation conflicts with global types | Low | Compilation error | Use declaration merging pattern; verify typecheck |
| Middleware runs after auth (wrong order) | Low | Requests bypass tenant check | Call before routes; unit tests verify order |

---

## Stage Tracker

```
Current Stage:      Task Planning (in-progress)
Previous Stage:     Epic Router (complete)
Next Stage:         Task Implementer (pending user approval)
Blocker Reason:     None
Pending Tasks:      
  - T-034 Implementation
  - T-032 (Deduplication) — can start in parallel
  - T-033 (Stream Publisher) — can start in parallel
  - T-031 (Ingestion endpoint) — depends on T-034
```

---

## Implementation Methodology: Pseudo-TDD

1. Write tests first (before touching middleware.ts)
2. Implement middleware to pass tests
3. Validate: typecheck, lint, test, build
4. Commit

---

## Effort Breakdown

| Step | Time |
|------|------|
| Step 1 — Write tests | 10 min |
| Step 2 — Implement middleware | 10 min |
| Step 3 — Extend index | 2 min |
| Step 4 — Register in app.ts | 3 min |
| Step 5 — Task-scoped validation | 5 min |
| Step 6 — Full workspace validation | 10 min |
| **Total** | **~40 minutes** |

---

**Ready for Implementation Approval** ✅
