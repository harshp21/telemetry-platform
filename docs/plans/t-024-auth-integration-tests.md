# T-024 Plan: Auth Service Integration Tests

## 1. Business objective and user impact
- Verify end-to-end auth lifecycle behavior against real infrastructure boundaries, not only mocked service/unit flows.
- Reduce regression risk before gateway/web integration by validating register, login, refresh, logout, and token-revocation behavior in realistic conditions.

## 2. Scope and non-goals

### In scope
- Add integration tests in `apps/auth-service/tests/auth.integration.test.ts`.
- Execute auth routes against real app wiring and real persistence (Prisma-backed DB, refresh-token storage/rotation).
- Cover token lifecycle success and failure cases listed in the epic.
- Reset relevant auth tables between tests to keep deterministic outcomes.

### Non-goals
- Full cross-service integration via gateway or other services.
- Performance/load testing.
- Broad refactoring of auth controllers/services unrelated to testability.
- Cookie-flow redesign (already handled in T-025A implementation).

## 3. Acceptance criteria
- Integration test file exists at `apps/auth-service/tests/auth.integration.test.ts`.
- Tests cover at minimum:
  - Register success and duplicate rejection.
  - Login success and wrong-password rejection.
  - Refresh success and revoked-token rejection.
  - Logout success and post-logout access-token rejection path.
  - JWT plugin rejects expired token.
  - JWT plugin rejects denylisted token/JTI.
- Tests use isolated test data and clean DB state between runs.
- Auth-service scoped validation passes:
  - `pnpm --filter @telemetry/auth-service test`
  - `pnpm --filter @telemetry/auth-service lint`
  - `pnpm --filter @telemetry/auth-service typecheck`

## 4. Technical implementation steps
1. Add integration-test scaffold:
   - create `apps/auth-service/tests/auth.integration.test.ts`.
   - initialize app from real `buildAuthServiceApp()`.
2. Test environment setup:
   - use dedicated test env values for JWT secrets and cookie config.
   - ensure required infra env vars are present for test execution.
3. DB lifecycle control:
   - add helper to truncate/reset `RefreshToken`, `User`, `Tenant` tables in safe order before each test.
4. Write auth-flow integration scenarios:
   - register/login/refresh/logout happy path.
   - invalid credentials / duplicate register / invalid refresh token.
5. Write revocation/JWT guard scenarios:
   - expired JWT on protected logout route.
   - denylisted token behavior after logout.
6. Stabilize assertions for cookie + bearer hybrid contract:
   - assert cookie-based refresh mechanics and response payload shape consistency.

## 5. Validation plan
- First run only auth-service tests to iterate quickly.
- Then run auth-service lint.
- Then run auth-service typecheck.
- Confirm existing smoke tests remain green alongside new integration tests.

## 6. Risks and mitigations
- Risk: flaky tests due to shared DB state.
  - Mitigation: deterministic truncation/reset before each case and unique test inputs.
- Risk: environment coupling (missing DB/Redis in local CI context).
  - Mitigation: explicit test env preconditions and clear failure messaging.
- Risk: overlap with current smoke tests causing duplicated brittle assertions.
  - Mitigation: keep smoke tests for mocked contract checks, integration tests for real persistence/token lifecycle.

## 7. Pending tasks with state
- [done] Create integration test file scaffold
- [done] Add DB reset helpers for auth tables
- [done] Add register/login integration scenarios
- [done] Add refresh/logout integration scenarios
- [done] Add JWT expired/denylist integration scenarios
- [done] Run auth-service test/lint/typecheck
- [done] Summarize outcomes and request commit approval

## 8. Approval gate
- Implementation starts only after explicit user approval.
