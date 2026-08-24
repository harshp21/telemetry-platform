# T-066 Plan: Shared Packages Unit Tests

## 1. Business objective and user impact
- Raise confidence in reusable cross-service libraries by replacing minimal smoke coverage with behavior-focused unit tests.
- Reduce regressions in core helpers, validation, config parsing, logging bootstrap, and tracing initialization.

## 2. Scope and non-goals

### In scope
- Add unit tests in:
  - `packages/shared-utils/tests`
  - `packages/shared-validation/tests`
  - `packages/shared-config/tests`
  - `packages/shared-logger/tests`
  - `packages/shared-tracing/tests`
- Keep tests deterministic and isolated from network/infra dependencies.
- Preserve public APIs and runtime behavior.

### Non-goals
- Refactoring package runtime code unless a bug is proven by tests.
- Cross-service integration tests.
- CI pipeline restructuring beyond what this task requires.

## 3. Acceptance criteria
- `shared-utils`: branch-complete tests for exported utilities and edge cases.
- `shared-validation`: valid/invalid/edge coverage for each exported schema.
- `shared-config`: env parsing throws with field context for missing/invalid required vars.
- `shared-logger`: logger factory tests validate service metadata wiring.
- `shared-tracing`: init behavior validated for endpoint-present and endpoint-absent flows.
- Task-scoped validations pass.

## 4. Technical implementation steps
1. Inventory each package exports and existing test baseline.
2. Replace smoke tests with focused unit suites per exported module.
3. Add table-driven cases for validation/config and edge branches for utils.
4. Validate package-by-package to keep failures localized.
5. Run final scoped lint/typecheck/tests for touched packages.

## 5. Validation plan
- `pnpm --filter @telemetry/shared-utils test`
- `pnpm --filter @telemetry/shared-validation test`
- `pnpm --filter @telemetry/shared-config test`
- `pnpm --filter @telemetry/shared-logger test`
- `pnpm --filter @telemetry/shared-tracing test`
- `pnpm --filter @telemetry/shared-utils lint && pnpm --filter @telemetry/shared-utils typecheck`
- `pnpm --filter @telemetry/shared-validation lint && pnpm --filter @telemetry/shared-validation typecheck`
- `pnpm --filter @telemetry/shared-config lint && pnpm --filter @telemetry/shared-config typecheck`
- `pnpm --filter @telemetry/shared-logger lint && pnpm --filter @telemetry/shared-logger typecheck`
- `pnpm --filter @telemetry/shared-tracing lint && pnpm --filter @telemetry/shared-tracing typecheck`

## 6. Risks and mitigations
- Risk: broad test scope creates noisy failures.
  - Mitigation: implement and validate package-by-package in a fixed order.
- Risk: brittle tests tied to implementation internals.
  - Mitigation: assert public contract behavior and observable outputs only.
- Risk: time drift from attempting all packages in one pass.
  - Mitigation: complete one package slice at a time while staying inside T-066.

## 7. Pending tasks with state
- [done] Shared-utils unit test suite
- [done] Shared-validation unit test suite
- [done] Shared-config unit test suite
- [done] Shared-logger functional unit tests
- [done] Shared-tracing functional unit tests
- [done] Run package-scoped validations
- [done] Summarize outcomes and request commit approval

## 8. Approval gate
- Implementation starts only after explicit user approval.
