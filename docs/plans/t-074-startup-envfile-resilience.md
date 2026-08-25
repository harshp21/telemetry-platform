# T-074 Plan: Startup Env-File Resilience

## 1. Business objective and user impact
1. Prevent container startup failures when no local .env file is present, while preserving fail-fast behavior for real configuration or filesystem issues.
2. Improve deployment reliability across all runtime services by removing a known non-production-safe assumption (local file presence).
3. Preserve developer and operator trust: benign missing-file conditions should not crash startup, but unexpected load failures must still surface and fail.

## 2. Task goal
1. Implement resilient startup env loading across six services so ENOENT from process.loadEnvFile is ignored, but all non-ENOENT errors still propagate and fail startup.
2. Deliver this via pseudo-TDD: tests first, implementation second, refactor third, then targeted validation.

## 3. Strict scope and non-goals

### In scope
1. Startup env loading behavior in each service index entrypoint.
2. Unit tests in existing index graceful-shutdown test suites for env-loading behavior.
3. No behavioral changes to startup order besides env-load error handling branch.

### Out of scope
1. Env schema changes, .env.example changes, or Docker Compose changes.
2. Refactoring startup bootstrapping into shared package utilities.
3. Changes to app builders, routing, business logic, or observability setup.
4. CI workflow edits beyond task-scoped validation execution.

## 4. Owning files

### Runtime entrypoints
1. apps/auth-service/src/index.ts
2. apps/usage-service/src/index.ts
3. apps/worker-service/src/index.ts
4. apps/billing-service/src/index.ts
5. apps/analytics-service/src/index.ts
6. apps/gateway/src/index.ts

### Test suites
1. apps/auth-service/tests/index.graceful-shutdown.unit.test.ts
2. apps/usage-service/tests/index.graceful-shutdown.unit.test.ts
3. apps/worker-service/tests/index.graceful-shutdown.unit.test.ts
4. apps/billing-service/tests/index.graceful-shutdown.unit.test.ts
5. apps/analytics-service/tests/index.graceful-shutdown.unit.test.ts
6. apps/gateway/tests/index.graceful-shutdown.unit.test.ts

## 5. Controlling code path and local hypothesis
1. Service startup in each index file:
- loadLocalEnv invocation
- dynamic app import/build
- listen call
2. Current failure point:
- process.loadEnvFile throws and aborts before app boot when .env is absent in container runtime.
3. Hypothesis:
- If loadLocalEnv catches and suppresses only ENOENT from process.loadEnvFile, startup succeeds in no-.env containers while preserving failure semantics for all unexpected env-load errors.
4. Falsification signal:
- ENOENT still aborts startup, or non-ENOENT no longer fails startup.

## 6. Exact implementation steps (Pseudo-TDD)
1. Write tests first in all six index unit test files:
- Add scenario: when process.loadEnvFile throws ENOENT-style error, importing index still proceeds to app build/listen.
- Add scenario: when process.loadEnvFile throws non-ENOENT error, startup fails and app build/listen is not reached.
- Keep existing graceful shutdown tests unchanged except shared setup extension needed for loadEnvFile error injection.
2. Run fail-fast targeted tests before implementation:
- Execute per-service index unit tests and confirm new scenarios fail with current behavior.
3. Implement minimal runtime changes in six index files:
- Wrap process.loadEnvFile call in try/catch within loadLocalEnv.
- Suppress only errors where error code equals ENOENT.
- Rethrow all other errors.
- Preserve function signature, startup sequence, and existing shutdown wiring.
4. Re-run the same targeted test files:
- Confirm new env-loading scenarios pass and no graceful-shutdown regressions occur.
5. Refactor pass:
- Keep code duplication minimal and readable within each service file.
- Do not introduce shared cross-package helper in this task.
6. Run task-scoped quality checks.
7. Run repo-level CI gate commands only after task-scoped checks are green.

## 7. Validation plan
1. pnpm --filter @telemetry/auth-service exec vitest run tests/index.graceful-shutdown.unit.test.ts
2. pnpm --filter @telemetry/usage-service exec vitest run tests/index.graceful-shutdown.unit.test.ts
3. pnpm --filter @telemetry/worker-service exec vitest run tests/index.graceful-shutdown.unit.test.ts
4. pnpm --filter @telemetry/billing-service exec vitest run tests/index.graceful-shutdown.unit.test.ts
5. pnpm --filter @telemetry/analytics-service exec vitest run tests/index.graceful-shutdown.unit.test.ts
6. pnpm --filter @telemetry/gateway exec vitest run tests/index.graceful-shutdown.unit.test.ts
7. pnpm --filter @telemetry/auth-service lint && pnpm --filter @telemetry/auth-service typecheck
8. pnpm --filter @telemetry/usage-service lint && pnpm --filter @telemetry/usage-service typecheck
9. pnpm --filter @telemetry/worker-service lint && pnpm --filter @telemetry/worker-service typecheck
10. pnpm --filter @telemetry/billing-service lint && pnpm --filter @telemetry/billing-service typecheck
11. pnpm --filter @telemetry/analytics-service lint && pnpm --filter @telemetry/analytics-service typecheck
12. pnpm --filter @telemetry/gateway lint && pnpm --filter @telemetry/gateway typecheck
13. pnpm build
14. pnpm test
15. pnpm lint
16. pnpm typecheck

## 8. Risks and mitigations
1. Risk: over-broad catch could hide real startup faults.
- Mitigation: strict error-code gate; rethrow everything except ENOENT.
2. Risk: Node error shape variance may omit code in some thrown values.
- Mitigation: typed narrowing and default rethrow path when code is absent or not ENOENT.
3. Risk: false-positive tests due to import timing/microtask behavior.
- Mitigation: reuse existing flushAsyncWork pattern and assert both build/listen invocation and failure-path behavior.
4. Risk: inconsistent behavior across services due to copy edits.
- Mitigation: identical test scenarios and parallel targeted runs across all six services.

## 9. Pending tasks with states
1. T-074-01 Add ENOENT and non-ENOENT startup tests in six index test files: done
2. T-074-02 Execute red-phase targeted tests and capture failing evidence: done
3. T-074-03 Implement ENOENT-only suppression in six index entrypoints: done
4. T-074-04 Execute green-phase targeted tests and verify no regressions: done
5. T-074-05 Run touched-package lint and typecheck: done
6. T-074-06 Run workspace CI validation gate commands: done
7. T-074-07 Update plan with implementation evidence and stage handoff artifacts: done
8. T-074-08 Pre-QA review: done (approved, scope conflict resolved by reverting out-of-scope CI changes)
9. T-074-09 QA review: done (approved, sufficient coverage)
10. T-074-10 Senior final review: done (approved, no findings)

## 10. Implementation evidence summary
- **Test coverage**: 6 services × 2 new scenarios = 12 unit test cases (all passing)
- **Code changes**: 6 index.ts files with ENOENT-safe env loading (try/catch + code check)
- **Validation**: All workspace gates pass (build, test, lint, typecheck)
- **Risk mitigation**: Type-safe error narrowing, no behavioral changes outside env-load branch

## 11. Known external issues (out-of-scope)
- Pre-existing Dockerfile issue: missing `prisma generate` step (discovered during integration testing, blocks runtime validation but does not affect unit/static validation)
- Pre-existing CI workflow: baseline restored to avoid scope creep (T-071 changes deferred)

## 12. Approval boundary
1. Implementation starts only after explicit user approval of this plan. ✅ Approved
2. Commit/push remains blocked until implementation, review, QA, and CI validation gates are complete. ✅ All gates complete
3. Ready for final commit approval after scope reconciliation. ✅ Scope reconciled (out-of-scope changes reverted)
