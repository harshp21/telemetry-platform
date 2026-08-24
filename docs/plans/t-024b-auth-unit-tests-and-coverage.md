# T-024B Plan: Auth Service Unit Tests and Coverage Gate

## 1. Business objective and user impact
- Improve confidence in security-sensitive auth internals with fast, isolated unit tests.
- Prevent silent test-quality regression by enforcing service-level coverage thresholds in repeatable local/CI runs.

## 2. Scope and non-goals

### In scope
- Add or extend unit-focused tests for auth internals:
  - `services/token.service.ts`
  - `utils/session-cookie.ts`
  - `plugins/jwt.plugin.ts`
- Keep auth integration tests as-is; this task complements them.
- Enforce auth-service coverage thresholds through Vitest coverage config and scripts.

### Non-goals
- Rewriting already stable integration scenarios from T-024.
- Cross-service coverage rollout beyond auth-service in this slice.
- Behavior changes in production auth endpoints unless a bug is discovered by tests.

## 3. Acceptance criteria
- Unit tests exist for token generation/hash behavior and edge cases.
- Unit tests exist for session cookie parsing/serialization and CSRF validation matrix.
- Unit tests exist for JWT plugin failure modes (missing/malformed/expired/revoked/invalid).
- Auth-service coverage command is available and enforces thresholds:
  - statements >= 80
  - lines >= 80
  - functions >= 80
  - branches >= 75
- Auth-service scoped checks pass:
  - `pnpm --filter @telemetry/auth-service test`
  - `pnpm --filter @telemetry/auth-service test:coverage`
  - `pnpm --filter @telemetry/auth-service lint`
  - `pnpm --filter @telemetry/auth-service typecheck`

## 4. Technical implementation steps
1. Add unit test files for token service, session-cookie utils, and jwt plugin behavior.
2. Use isolated doubles/mocks for denylist and request header cases where needed.
3. Keep assertions contract-focused and deterministic (no timing-flaky expectations).
4. Run coverage and tighten only where thresholds fail.

## 5. Risks and mitigations
- Risk: overlap with smoke/integration tests causes redundancy and maintenance drag.
  - Mitigation: keep unit tests focused on branch-level internal behavior not already proven by route-level integration tests.
- Risk: environment leakage in unit tests.
  - Mitigation: isolate and restore env vars in test setup/teardown.

## 6. Pending tasks with state
- [done] Add token service unit tests
- [done] Add session-cookie unit tests
- [done] Add jwt plugin unit tests
- [done] Run auth-service coverage and verify thresholds
- [done] Run lint and typecheck
- [done] Summarize results and request commit approval

## 7. Approval gate
- Implementation starts only after explicit user approval.
