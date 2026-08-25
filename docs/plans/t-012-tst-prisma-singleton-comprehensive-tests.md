# T-012-TST Plan: Prisma Singleton Comprehensive Tests

## 1. Business objective and user impact
- Close the completed-task coverage gap for T-012 with deterministic tests.
- Reduce regressions in singleton behavior that can cause connection churn during reload cycles.
- Keep this slice test-only to avoid production behavior changes.

## 2. Scope and non-goals

### In scope
- Add singleton unit tests for these existing modules:
  - [apps/auth-service/src/lib/prisma.ts](apps/auth-service/src/lib/prisma.ts)
  - [apps/usage-service/src/lib/prisma.ts](apps/usage-service/src/lib/prisma.ts)
  - [apps/worker-service/src/lib/prisma.ts](apps/worker-service/src/lib/prisma.ts)
  - [apps/billing-service/src/lib/prisma.ts](apps/billing-service/src/lib/prisma.ts)
  - [apps/analytics-service/src/lib/prisma.ts](apps/analytics-service/src/lib/prisma.ts)
- Create one new test file per service under tests/config.
- Run scoped tests, typecheck, and lint for touched services.

### Non-goals
- No edits to production runtime singleton code.
- No cross-service refactors or shared harness extraction.
- No broad workspace CI gate in this slice.

## 3. Acceptance criteria
- Five new unit test files exist, one per Prisma-backed service.
- Each file verifies all scenarios:
  1. constructor called with log levels error and warn
  2. pre-seeded global singleton is reused without new constructor call
  3. non-production imports cache instance on globalThis
  4. production imports do not cache on globalThis
- Scoped validation passes for touched services:
  - targeted vitest for each new file
  - typecheck for each touched service
  - lint for each new file
- No production code files changed.

## 4. Implementation steps
1. Implement auth template test file:
   - [apps/auth-service/tests/config/prisma.singleton.unit.test.ts](apps/auth-service/tests/config/prisma.singleton.unit.test.ts)
2. Validate auth file immediately (test + typecheck + lint).
3. Mirror same test logic for usage, worker, billing, analytics service test files.
4. Run targeted vitest for each new file.
5. Run typecheck for each touched service.
6. Run lint on each new file.
7. Prepare review handoff with changed-files and validation evidence.

## 5. Risks and mitigations
- Risk: global state leakage across tests.
  - Mitigation: explicit cleanup of global singleton and module resets between cases.
- Risk: module cache masking singleton behavior.
  - Mitigation: isolate import path behavior with per-test reset sequence.
- Risk: over-scoping edits.
  - Mitigation: constrain changes to five new test files only.

## 6. Pending tasks with state
- auth template singleton test file: done
- usage singleton test file: done
- worker singleton test file: done
- billing singleton test file: done
- analytics singleton test file: done
- scoped vitest validations: done
- scoped typecheck validations: done
- scoped lint validations: done
- pre-QA review handoff: done

## 7. Approval gate
Implementation starts only after explicit user approval.

Please approve Slice-2 now:
- add five singleton test files (test-only edits)
- run scoped validations for touched services
- keep T-014/T-015 comprehensive test backfill for Slice-3