# T-026 Plan: Gateway HTTP Proxy Route Registration

## 1. Business objective and user impact
- Make gateway the real external entry point by proxying versioned API paths to internal services.
- Ensure clients can call unified gateway routes instead of service-specific internal URLs.

## 2. Scope and non-goals

### In scope
- Add HTTP proxy plugin wiring in gateway for:
  - /v1/auth/* -> AUTH_SERVICE_URL
  - /v1/usage/* -> USAGE_SERVICE_URL
  - /v1/billing/* -> BILLING_SERVICE_URL
  - /v1/analytics/* -> ANALYTICS_SERVICE_URL
- Add or update constants needed for stable route-prefix and upstream naming.
- Register proxy plugin(s) from app bootstrap while preserving existing health routes.
- Add focused tests that verify proxy registrations at gateway route level.

### Non-goals
- JWT verification logic or header injection behavior (T-027).
- Rate limiting behavior (T-028).
- Request guard middleware (T-029).
- Changes to downstream services.

## 3. Acceptance criteria
- Gateway registers proxy routes for all 4 /v1/* service groups.
- Existing /health and /v1/health continue to return 200.
- Gateway builds and tests pass with proxy plugin installed.
- Tests assert expected route registration and non-regression for health endpoints.

## 4. Technical implementation steps
1. Add dependency for Fastify proxy plugin if absent.
2. Create a proxy plugin module at apps/gateway/src/plugins/proxy.plugin.ts that registers 4 upstream proxies from env.
3. Update app composition in apps/gateway/src/app.ts to register proxy plugin after health routes.
4. Add constants for proxy prefixes/upstream mapping where helpful to avoid magic literals.
5. Extend gateway tests to verify proxy route presence and existing health behavior.

## 5. Validation plan
- pnpm --filter @telemetry/gateway lint
- pnpm --filter @telemetry/gateway typecheck
- pnpm --filter @telemetry/gateway test

## 6. Risks and mitigations
- Risk: proxy registration may require env vars during tests and fail if unset.
  - Mitigation: set deterministic test env vars in test setup or plugin defaults only in test context.
- Risk: wildcard proxy paths may overlap with existing routes.
  - Mitigation: keep explicit health routes registered first and test both health endpoints remain unaffected.
- Risk: dependency version mismatch with Fastify v5.
  - Mitigation: install plugin version compatible with current Fastify major and validate via typecheck.

## 7. Pending tasks with state
- [done] Confirm T-025 commit/push completion
- [done] Identify next task from Epic 5 (T-026)
- [done] Inspect gateway codebase current routing/plugin state
- [done] Implement proxy route registration for 4 upstream services
- [done] Add/update targeted gateway tests for proxy route wiring
- [done] Run scoped gateway validation commands
- [pending] Summarize outcomes and request commit approval

## 8. Approval gate
- Implementation approved and applied; awaiting user approval for commit/push.
