# T-020 Plan: Refresh Token Endpoint

> Historical note: refresh-token transport details in this task were later superseded by T-025A, which moved refresh handling to HttpOnly cookie flow.

## 1. Business objective and user impact
- Allow authenticated sessions to continue securely without forcing frequent logins by exchanging a valid refresh token for a new access token.
- Reduce security risk by rotating refresh tokens and invalidating old ones on every refresh.

## 2. Scope and non-goals

### In scope
- Implement `POST /v1/auth/refresh` endpoint.
- Validate incoming refresh token payload.
- Hash incoming refresh token and verify stored record status.
- Revoke old refresh token, mint new access/refresh token pair, persist new refresh hash.
- Return standardized unauthorized error for all invalid refresh scenarios.

### Non-goals
- Cookie and CSRF hardening details (later addressed in T-025A).
- Logout and token denylist logic (T-021).
- JWT verification middleware (T-022).
- Route protection expansion (T-023).

## 3. Acceptance criteria
- New route exists: `POST /v1/auth/refresh` under `/v1/auth`.
- Valid refresh token returns `200` with rotated session state and refreshed access-token response.
- Invalid, expired, revoked, or not-found refresh token returns `401` with single normalized error code.
- Old refresh token is revoked during successful rotation.
- Auth service scoped validation passes:
  - `pnpm --filter @telemetry/auth-service test`
  - `pnpm --filter @telemetry/auth-service lint`
  - `pnpm --filter @telemetry/auth-service typecheck`

## 4. Technical implementation steps
1. Constants and errors:
   - add refresh route constant and response/error constants in `constants.ts`.
   - add refresh-token invalid domain error in `errors/index.ts`.
2. Repository layer (`user.repository.ts` or dedicated refresh-token repository file):
   - find refresh token by hash with user and expiry/revocation fields.
   - revoke existing refresh token by id.
   - create/store new refresh token hash with expiry.
3. Service layer (`auth.service.ts` and/or `token.service.ts`):
   - add `refresh()` method that:
     - hashes incoming refresh token.
     - verifies record exists, not revoked, and not expired.
     - issues new access token from user context.
     - issues new refresh token and persists new hash.
     - revokes previous refresh token in same logical flow.
4. Controller layer (`auth.controller.ts`):
   - add request schema for refresh payload.
   - add `refreshHandler` and response mapping with `AUTH_HTTP_STATUS.OK`.
5. Routes (`routes/index.ts`):
   - register `POST /refresh` route.
6. Tests:
   - extend smoke tests for refresh success and unauthorized cases.
   - add/adjust unit coverage for refresh service logic if needed.

## 5. Validation plan
- Run auth-service tests after first substantive implementation slice.
- Run auth-service lint and typecheck after test stabilization.
- Confirm existing register/login behavior remains green.

## 6. Risks and mitigations
- Risk: refresh token rotation introduces inconsistent state if partially updated.
  - Mitigation: perform revoke + create flow in transaction or tightly ordered awaited operations with deterministic error handling.
- Risk: leakage of refresh-token existence through error variance.
  - Mitigation: one unified 401 error code/message for all refresh failures.
- Risk: time comparisons can be brittle.
  - Mitigation: compare against `new Date()` and cover boundary logic in tests.

## 7. Pending tasks with state
- [done] Add refresh constants and domain error
- [done] Add refresh repository methods
- [done] Add refresh service method
- [done] Add refresh controller and route
- [done] Add refresh tests (success + failure)
- [done] Run test/lint/typecheck and fix issues
- [in-progress] Summarize results and request commit approval

## 8. Approval gate
- Implementation starts only after explicit user approval.
