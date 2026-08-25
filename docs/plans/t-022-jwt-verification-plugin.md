# T-022 Plan: JWT Verification Fastify Plugin

## 1. Business objective and user impact
- Provide a reusable, consistent authentication mechanism for protected auth routes.
- Ensure revoked, invalid, malformed, or expired access tokens are rejected uniformly across service instances.

## 2. Scope and non-goals

### In scope
- Implement reusable JWT verification plugin/pre-handler for auth-service protected routes.
- Verify bearer token structure and JWT signature.
- Reject revoked tokens by checking Redis denylist using `jti`.
- Attach authenticated user context to the request in a reusable shape.
- Replace the logout-specific auth guard with the shared JWT verification plugin.

### Non-goals
- Broad authorization policy system beyond request authentication.
- Route protection changes outside the current auth-service slice beyond wiring the shared plugin where already needed.
- Integration-test expansion task (reserved for T-024).

## 3. Acceptance criteria
- A reusable JWT verification plugin exists at `apps/auth-service/src/plugins/jwt.plugin.ts`.
- Missing or malformed `Authorization` header returns `401` with normalized token error code.
- Invalid signature returns `401`.
- Expired token returns `401`.
- Denylisted `jti` returns `401` with token-revoked code.
- Verified token attaches request auth/user context for downstream handlers.
- Logout route uses the shared JWT plugin instead of a logout-only auth pre-handler.
- Auth-service scoped validation passes:
  - `pnpm --filter @telemetry/auth-service test`
  - `pnpm --filter @telemetry/auth-service lint`
  - `pnpm --filter @telemetry/auth-service typecheck`

## 4. Technical implementation steps
1. Extend constants/errors:
   - add token error response codes/messages for missing, invalid, expired, revoked.
2. Generalize auth request context:
   - keep a shared authenticated request shape in `plugins/index.ts`.
3. Implement `jwt.plugin.ts`:
   - extract bearer token.
   - verify with `jose.jwtVerify` using `JWT_SECRET`.
   - check Redis denylist key for `jti`.
   - distinguish invalid/expired/revoked cases.
   - attach authenticated user context to request.
4. Update Redis denylist service:
   - add read/check method for denylist key existence.
5. Route wiring:
   - replace logout-only pre-handler with shared JWT plugin.
6. Tests:
   - extend smoke coverage for missing token, malformed token, expired token, and denylisted token behavior on logout route.

## 5. Validation plan
- First focused validation: auth-service tests.
- Then auth-service lint and typecheck.
- Confirm existing register/login/refresh/logout behaviors remain green.

## 6. Risks and mitigations
- Risk: introducing shared plugin breaks current logout path.
  - Mitigation: replace the current logout guard only after the new plugin covers the same request context contract.
- Risk: token error cases collapse into one generic unauthorized response unexpectedly.
  - Mitigation: define explicit token failure codes and test each scenario.
- Risk: Redis lookup dependency can make all protected requests fail hard on connectivity issues.
  - Mitigation: keep failure handling explicit and testable; do not silently skip revocation checks.

## 7. Pending tasks with state
- [done] Add token verification constants and errors
- [done] Implement shared JWT plugin
- [done] Add denylist read/check method
- [done] Replace logout-only pre-handler usage
- [done] Add JWT plugin route tests
- [done] Run auth-service test/lint/typecheck
- [in-progress] Summarize outcomes and request commit approval

## 8. Approval gate
- Senior Reviewer pre-QA review completed and required fixes integrated.
- QA validation completed on the updated revision.
- Senior Reviewer final sign-off completed on the tested revision.
- Awaiting explicit user approval for commit/push.
