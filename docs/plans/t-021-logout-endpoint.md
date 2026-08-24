# T-021 Plan: Logout Endpoint

## 1. Business objective and user impact
- Let authenticated users explicitly terminate their session.
- Reduce token replay risk by revoking active refresh tokens and denylisting the current access-token identifier for its remaining lifetime.

## 2. Scope and non-goals

### In scope
- Implement `POST /v1/auth/logout`.
- Revoke active refresh tokens for the authenticated user.
- Denylist the current access-token `jti` in Redis for the remaining token lifetime.
- Return `204 No Content` on success.

### Non-goals
- Full JWT verification middleware design and public/protected route expansion beyond the minimum required to support logout.
- Cookie-based refresh-token clearing behavior.
- Broader auth plugin architecture refactors.

## 3. Acceptance criteria
- `POST /v1/auth/logout` exists under `/v1/auth`.
- Request requires authenticated user context and token metadata needed for denylisting.
- Logout stores `denylist:{jti}` in Redis with remaining TTL.
- Logout revokes all active refresh tokens for the current `userId`.
- Successful logout returns `204`.
- Auth-service scoped validation passes:
  - `pnpm --filter @telemetry/auth-service test`
  - `pnpm --filter @telemetry/auth-service lint`
  - `pnpm --filter @telemetry/auth-service typecheck`

## 4. Technical implementation steps
1. Establish the smallest auth context needed for logout:
   - add request typing for authenticated user/token metadata.
   - add a minimal pre-handler or plugin slice needed to supply `userId`, `tenantId`, `role`, `jti`, and token expiry context for logout only.
2. Add infrastructure boundary for Redis:
   - create a small Redis client abstraction in auth-service.
   - add method to write `denylist:{jti}` with expiry seconds.
3. Extend repository layer:
   - add method to revoke all active refresh tokens for a given `userId`.
4. Extend service layer:
   - add `logout()` method that denylists current `jti` and revokes active refresh tokens.
5. Extend controller/routes:
   - add `logoutHandler`.
   - register `POST /logout` with the required auth pre-handler.
6. Add task-scoped tests:
   - success path returns `204` and invokes revoke/denylist behavior.
   - unauthorized/missing-auth path returns `401`.

## 5. Validation plan
- First focused validation after implementation starts: auth-service tests.
- Then auth-service lint and typecheck.
- Confirm existing register/login/refresh paths remain green.

## 6. Risks and mitigations
- Risk: implementing logout before full JWT plugin can create throwaway auth plumbing.
  - Mitigation: keep logout auth pre-handler minimal and aligned with the forthcoming T-022 plugin contract.
- Risk: incorrect TTL on denylist key can let revoked access tokens outlive logout protection.
  - Mitigation: compute TTL from verified token expiry and clamp to positive values only.
- Risk: revoking all refresh tokens could affect multi-device behavior.
  - Mitigation: follow epic requirement explicitly for current task and keep behavior documented.

## 7. Pending tasks with state
- [done] Add minimal authenticated request context for logout
- [done] Add Redis denylist boundary
- [done] Add refresh-token bulk revoke method
- [done] Add logout service/controller/route
- [done] Add logout tests
- [done] Run auth-service test/lint/typecheck
- [in-progress] Summarize outcomes and request commit approval

## 8. Approval gate
- Implementation starts only after explicit user approval.
