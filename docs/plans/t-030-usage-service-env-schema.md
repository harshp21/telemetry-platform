# T-030: Usage Service Environment Schema (Redis Streams Config)

**Plan Version**: 1.0  
**Created**: 2026-08-26  
**Task ID**: T-030  
**Epic**: Epic 6 — Usage Service  
**Effort**: XS (~30 minutes)

---

## Business Objective

Enable Usage Service to read and validate configuration for Redis Streams-based event ingestion pipeline. The service requires three environment variables to bootstrap the Redis Streams consumer and batch processing logic:
- Stream key (e.g., "telemetry:events")
- Maximum stream length (trimming threshold)
- Maximum batch size for event processing

This task is a **critical blocker** for downstream work (T-031 ingestion endpoint, T-032 deduplication, T-033 stream publisher) and represents the completion of Epic 6 pre-requisites.

---

## Task Goal

Extend `apps/usage-service/src/config/env.ts` with three new Zod-validated environment variables, update `.env.example` for reference, and create a comprehensive test suite validating all scenarios.

---

## Owning Files

| File | Current State | Change | Owner | Effort |
|------|---------------|--------|-------|--------|
| [apps/usage-service/src/config/env.ts](apps/usage-service/src/config/env.ts) | 14 lines; 6 shared vars | Add 3 new fields: REDIS_STREAM_NAME, STREAM_MAX_LEN, INGEST_BATCH_MAX with Zod schema + defaults | Implementer | 5 min |
| [apps/usage-service/tests/env.schema.unit.test.ts](apps/usage-service/tests/env.schema.unit.test.ts) | **Does not exist** | Create new test file with buildBaseEnv() helper + 8 test cases covering defaults, overrides, validation boundaries | Implementer | 10 min |
| [.env.example](.env.example) | 6 lines; minimal shared vars | Add 3 new commented lines documenting REDIS_STREAM_NAME, STREAM_MAX_LEN, INGEST_BATCH_MAX with descriptions | Implementer | 2 min |

---

## Local Hypothesis

**Falsifiable statement**: We can extend the usage-service env schema with three stream-specific variables using the same Zod pattern as auth-service, validate them with numeric coercion and boundary constraints, and ensure all tests pass without breaking existing shared configuration.

**Testing approach**: Pseudo-TDD pattern (tests first, then implementation) matches auth-service precedent and ensures coverage of all edge cases (defaults, type coercion, min/max violations).

---

## Implementation Steps (Pseudo-TDD Pattern)

### Step 1: Create Test File (10 min)
**File**: [apps/usage-service/tests/env.schema.unit.test.ts](apps/usage-service/tests/env.schema.unit.test.ts) (NEW)

**Pattern Reference**: [apps/auth-service/tests/env.schema.unit.test.ts](apps/auth-service/tests/env.schema.unit.test.ts)

**Test Structure** (8 test cases):
```ts
import { describe, expect, it } from "vitest";
import { EnvSchema } from "../src/config/env";

const buildBaseEnv = (): Record<string, string> => ({
  NODE_ENV: "test",
  PORT: "3000",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/telemetry",
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "silent"
});

describe("usage service env schema", () => {
  describe("redis stream configuration", () => {
    it("loads REDIS_STREAM_NAME with default 'telemetry:events'", () => { ... });
    it("loads REDIS_STREAM_NAME from env var override", () => { ... });
    it("loads STREAM_MAX_LEN as positive integer with default 100,000", () => { ... });
    it("coerces STREAM_MAX_LEN from string to number", () => { ... });
    it("rejects STREAM_MAX_LEN <= 0", () => { ... });
    it("loads INGEST_BATCH_MAX with default 100", () => { ... });
    it("rejects INGEST_BATCH_MAX < 1", () => { ... });
    it("rejects INGEST_BATCH_MAX > 100", () => { ... });
    it("accepts INGEST_BATCH_MAX at boundaries (1 and 100)", () => { ... });
  });
});
```

**Validation After Step 1**: Tests should run and FAIL (schema fields don't exist yet)
```bash
pnpm --filter @telemetry/usage-service test -- env.schema
# Expected: 8 test failures
```

---

### Step 2: Extend EnvSchema (5 min)
**File**: [apps/usage-service/src/config/env.ts](apps/usage-service/src/config/env.ts)

**Current state**:
```ts
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info")
});
```

**After implementation** (add 3 fields):
```ts
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  // Redis Streams configuration
  REDIS_STREAM_NAME: z.string().default("telemetry:events"),
  STREAM_MAX_LEN: z.coerce.number().int().positive().default(100_000),
  INGEST_BATCH_MAX: z.coerce.number().int().min(1).max(100).default(100)
});
```

**Validation After Step 2**: All tests should PASS
```bash
pnpm --filter @telemetry/usage-service test -- env.schema
# Expected: 8 passing tests
```

---

### Step 3: Update Documentation (2 min)
**File**: [.env.example](.env.example)

Add 3 new lines at end:
```env
# Usage Service — Redis Streams Configuration
REDIS_STREAM_NAME=telemetry:events          # Redis stream key for ingest events
STREAM_MAX_LEN=100000                       # Max entries in stream (auto-trimmed beyond this)
INGEST_BATCH_MAX=100                        # Max events per batch in ingestion pipeline (1–100)
```

**Validation After Step 3**: Manual verification that defaults match schema

---

### Step 4: Task-Scoped Validation (5 min)

Run tests and checks scoped to usage-service:
```bash
pnpm --filter @telemetry/usage-service test -- env.schema
pnpm --filter @telemetry/usage-service lint
pnpm --filter @telemetry/usage-service typecheck
```

**Expected Result**: All green ✓

---

### Step 5: Full Workspace Validation (10 min)

Ensure no regressions across all 13 packages:
```bash
pnpm build && pnpm test && pnpm lint && pnpm typecheck
```

**Expected Result**: All 4 commands succeed; all 13 packages pass

---

## Acceptance Criteria

| Criterion | How to Verify |
|-----------|---------------|
| REDIS_STREAM_NAME added with type string, default "telemetry:events" | Test: default + override checks; ServiceEnv type includes field |
| STREAM_MAX_LEN added with type number, positive int, default 100,000 | Test: coercion, rejection of ≤0, default check |
| INGEST_BATCH_MAX added with type number, range 1–100, default 100 | Test: boundary checks (1 ✓, 0 ✗, 101 ✗), default check |
| All fields exported in ServiceEnv type with correct types | TypeScript: no `any` types; strict typing |
| .env.example documented with new vars and comments | File: 3 new lines with descriptions |
| All usage-service tests pass | `pnpm --filter @telemetry/usage-service test` green |
| Full workspace validation passes (no regressions) | `pnpm build test lint typecheck` all pass |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Schema mismatch between env.ts defaults and .env.example | Low | Deployment confusion | Step 3 checklist explicitly matches defaults |
| Zod coercion edge cases | Low | Runtime surprise | Tests cover: "0", "-1", "101", "50000" |
| New fields break existing code | Very Low | Type errors | ServiceEnv only type export; no breakage |

---

## Stage Tracker

```
Current Stage:      Task Planning (in-progress)
Previous Stage:     Epic Router (complete)
Next Stage:         Task Implementer (pending user approval)
Blocker Reason:     None
Pending Tasks:      Implementation, review, commit
Evidence:           This plan file
```

---

## Implementation Methodology: Pseudo-TDD

1. **Write tests first** (before touching env.ts)
2. **Implement schema to pass tests**
3. **Validate**: typecheck, lint, test, build
4. **Commit** (one atomic commit)

---

**Ready for Implementation Approval** ✅
