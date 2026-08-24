# T-027 Plan: Gateway JWT Authentication Hook

## 1. Business objective and user impact
- Enforce authentication at gateway before forwarding protected requests to internal services.
- Ensure tenant/user context headers are derived from verified tokens, not client-supplied values.

## 2. Scope and non-goals

### In scope
- Add gateway auth middleware that verifies Authorization Bearer tokens with JWT secret.
- Skip auth for public routes:
  - GET /health
  - GET /v1/health
  - POST /v1/auth/register
  - POST /v1/auth/login
  - POST /v1/auth/refresh
- On successful verification, inject request headers for upstream forwarding:
  - X-Tenant-Id
  - X-User-Id
  - X-User-Role
- Return 401 for missing/malformed/invalid/expired tokens before proxying.
- Add focused tests for public-route bypass and protected-route enforcement.

### Non-goals
- Redis denylist checks (stays in auth-service domain per epic note).
- Rate limiting behavior (T-028).
- Request guard hardening and header stripping (T-029).
- Changes to auth-service token issuance.

## 3. Acceptance criteria
- Protected /v1/* non-public routes reject unauthenticated requests with 401.
- Public auth + health routes remain accessible without Bearer token.
- Verified token claims are forwarded as X-Tenant-Id, X-User-Id, X-User-Role headers.
- Scoped gateway lint/typecheck/test pass.

## 4. Technical implementation steps
1. Create middleware module for gateway JWT auth pre-handler.
2. Parse and validate Authorization header format.
3. Verify HS256 token using jose jwtVerify and JWT_SECRET.
4. Attach verified auth context to request object (typed) for header injection.
5. Update proxy plugin registration to rewrite request headers using verified context.
6. Register auth middleware in app flow so it executes before protected proxy handling.
7. Add tests for:
   - public route bypass
   - missing token -> 401
   - malformed token -> 401
   - valid token on protected route -> proxy forwarding path reached

## 5. Validation plan
- pnpm --filter @telemetry/gateway lint
- pnpm --filter @telemetry/gateway typecheck
- pnpm --filter @telemetry/gateway test

## 6. Risks and mitigations
- Risk: auth middleware may inadvertently block public routes.
  - Mitigation: explicit allowlist test coverage for health/register/login/refresh.
- Risk: token claim mapping mismatch (sub/tenantId/role) across services.
  - Mitigation: keep claim contract aligned with auth-service token payload and test mapping behavior.
- Risk: middleware ordering with proxy plugin registration may bypass checks.
  - Mitigation: attach middleware as global pre-handler and validate with protected-path tests.

## 7. Pending tasks with state
- [done] Confirm T-026 commit/push completion
- [done] Inspect current gateway middleware/auth surface
- [done] Implement JWT auth middleware with public-route bypass
- [done] Inject verified tenant/user headers into proxied upstream requests
- [done] Add/update targeted gateway tests for auth enforcement behavior
- [done] Run scoped gateway validation commands
- [pending] Summarize outcomes and request commit approval

## 8. Approval gate
- Implementation approved and applied; awaiting user approval for commit/push.
