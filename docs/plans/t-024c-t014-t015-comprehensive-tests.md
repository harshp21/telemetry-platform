# T-024C Plan: Comprehensive Tests for T-014 and T-015

## 1. Business objective and user impact
- Close remaining completed-task test coverage gaps for infrastructure tasks T-014 and T-015.
- Increase confidence in startup dependency wiring and graceful shutdown behavior across all services.
- Ensure touched scope remains error-free with scoped validation before CI gate.

## 2. Scope and non-goals

### In scope
- Expand existing container unit tests for 6 services:
  - [apps/auth-service/tests/config/container.unit.test.ts](apps/auth-service/tests/config/container.unit.test.ts)
  - [apps/usage-service/tests/config/container.unit.test.ts](apps/usage-service/tests/config/container.unit.test.ts)
  - [apps/worker-service/tests/config/container.unit.test.ts](apps/worker-service/tests/config/container.unit.test.ts)
  - [apps/billing-service/tests/config/container.unit.test.ts](apps/billing-service/tests/config/container.unit.test.ts)
  - [apps/analytics-service/tests/config/container.unit.test.ts](apps/analytics-service/tests/config/container.unit.test.ts)
  - [apps/gateway/tests/config/container.unit.test.ts](apps/gateway/tests/config/container.unit.test.ts)
- Add new graceful shutdown unit tests for 6 services:
  - [apps/auth-service/tests/index.graceful-shutdown.unit.test.ts](apps/auth-service/tests/index.graceful-shutdown.unit.test.ts)
  - [apps/usage-service/tests/index.graceful-shutdown.unit.test.ts](apps/usage-service/tests/index.graceful-shutdown.unit.test.ts)
  - [apps/worker-service/tests/index.graceful-shutdown.unit.test.ts](apps/worker-service/tests/index.graceful-shutdown.unit.test.ts)
  - [apps/billing-service/tests/index.graceful-shutdown.unit.test.ts](apps/billing-service/tests/index.graceful-shutdown.unit.test.ts)
  - [apps/analytics-service/tests/index.graceful-shutdown.unit.test.ts](apps/analytics-service/tests/index.graceful-shutdown.unit.test.ts)
  - [apps/gateway/tests/index.graceful-shutdown.unit.test.ts](apps/gateway/tests/index.graceful-shutdown.unit.test.ts)

### Non-goals
- No production code changes unless tests reveal a real defect.
- No cross-service refactor of test helper abstractions in this slice.

## 3. Acceptance criteria
- Container tests validate Redis client options and error-listener behavior for all services.
- Container tests preserve service-specific behavior:
  - app services include prisma
  - gateway excludes prisma
- New graceful shutdown tests validate:
  1. SIGTERM and SIGINT handlers are registered
  2. first signal triggers shutdown sequence and success exit(0)
  3. duplicate signal during shutdown is ignored
  4. shutdown failure path logs error and exits with code 1
  5. worker sets exported shuttingDown flag to true
  6. gateway does not call prisma disconnect
- All touched services pass scoped test, lint, and typecheck.

## 4. Implementation steps
1. Enhance auth container unit tests with deeper assertions (Redis options + error handler behavior).
2. Add auth graceful shutdown unit test file as template.
3. Mirror container test enhancements and graceful shutdown tests to usage, worker, billing, analytics, gateway with only service-specific assertions changed.
4. Run scoped validations per service for touched files.
5. Prepare handoff artifacts for review stages.

## 5. Scoped validations
- Auth:
  - `pnpm --filter @telemetry/auth-service exec vitest run tests/config/container.unit.test.ts tests/index.graceful-shutdown.unit.test.ts`
  - `pnpm --filter @telemetry/auth-service typecheck`
  - `pnpm --filter @telemetry/auth-service lint`
- Usage:
  - `pnpm --filter @telemetry/usage-service exec vitest run tests/config/container.unit.test.ts tests/index.graceful-shutdown.unit.test.ts`
  - `pnpm --filter @telemetry/usage-service typecheck`
  - `pnpm --filter @telemetry/usage-service lint`
- Worker:
  - `pnpm --filter @telemetry/worker-service exec vitest run tests/config/container.unit.test.ts tests/index.graceful-shutdown.unit.test.ts`
  - `pnpm --filter @telemetry/worker-service typecheck`
  - `pnpm --filter @telemetry/worker-service lint`
- Billing:
  - `pnpm --filter @telemetry/billing-service exec vitest run tests/config/container.unit.test.ts tests/index.graceful-shutdown.unit.test.ts`
  - `pnpm --filter @telemetry/billing-service typecheck`
  - `pnpm --filter @telemetry/billing-service lint`
- Analytics:
  - `pnpm --filter @telemetry/analytics-service exec vitest run tests/config/container.unit.test.ts tests/index.graceful-shutdown.unit.test.ts`
  - `pnpm --filter @telemetry/analytics-service typecheck`
  - `pnpm --filter @telemetry/analytics-service lint`
- Gateway:
  - `pnpm --filter @telemetry/gateway exec vitest run tests/config/container.unit.test.ts tests/index.graceful-shutdown.unit.test.ts`
  - `pnpm --filter @telemetry/gateway typecheck`
  - `pnpm --filter @telemetry/gateway lint`

## 6. Risks and mitigations
- Risk: index.ts imports can trigger process side effects in tests.
  - Mitigation: isolate module imports, stub process.on and process.exit safely, reset modules per test.
- Risk: flakiness from shared global state.
  - Mitigation: strict beforeEach/afterEach cleanup of handlers and mocks.
- Risk: over-coupling tests to implementation details.
  - Mitigation: assert observable contract (registered handlers, call sequence, exit codes).

## 7. Pending tasks with state
- expand 6 container unit test files: done
- add 6 graceful shutdown unit test files: done
- run scoped vitest validations: done
- run scoped typecheck validations: done
- run scoped lint validations: done
- pre-QA review handoff: done
- QA review handoff: done
- final senior review handoff: done
- stage-7 CI gate: blocked
- stage-8 commit approval gate: blocked

## 8. Approval gate
Implementation starts only after explicit user approval.

Please approve Slice-3 implementation now:
- comprehensive test-only coverage for T-014 and T-015 across six services
- no production code changes unless tests expose a defect
- scoped validations across all touched services before review gates