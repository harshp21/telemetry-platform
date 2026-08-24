# T-028 Plan: Gateway Rate Limiting Plugin

## 1. Business objective and user impact
- Protect gateway and downstream services from burst traffic and abuse.
- Enforce fair per-tenant throttling after auth so one tenant cannot degrade others.
- Return consistent retry metadata for clients to back off safely.

## 2. Scope and non-goals

### In scope
- Add gateway rate limiting plugin at `apps/gateway/src/plugins/rate-limit.plugin.ts`.
- Register `@fastify/rate-limit` using Redis store backed by existing `ioredis` client.
- Apply two policy tiers:
  - Ingestion route (`/v1/usage/events`) uses `INGESTION_RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`.
  - All other protected routes use `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`.
- Key limits per tenant using verified auth context (`request.authContext.tenantId`) when present.
- Return `429` payload with `code`, `retryAfter`, `limit`, and `current` and include `Retry-After` response header.
- Add/extend gateway tests for tier selection and 429 response contract.

### Non-goals
- Changing JWT verification behavior (already handled in T-027).
- Introducing IP-based fallback policy tuning beyond safe defaults.
- Adding distributed analytics/metrics dashboards for rate-limit events.

## 3. Acceptance criteria
- Requests crossing configured quota receive `429` with:
  - `code: RATE_LIMIT_EXCEEDED`
  - `retryAfter` in seconds
  - `limit` and `current` counters
- `Retry-After` header is present on throttled responses.
- Ingestion route limit is stricter than general route limit and enforced independently.
- Tenant keying uses verified auth context (not client-supplied spoofable headers).
- Configuration remains env-driven so deployments can tune limits to support v1 targets (~1,000 avg req/s and 5,000 peak req/s) without code changes.
- Gateway lint, typecheck, and targeted tests pass.

## 4. Technical implementation steps
1. Add constants for rate-limit response code and ingestion path matcher in `apps/gateway/src/constants.ts`.
2. Create `apps/gateway/src/plugins/rate-limit.plugin.ts`:
   - Build Redis client from `REDIS_URL`.
   - Register `@fastify/rate-limit` with custom `keyGenerator` that prefers `request.authContext?.tenantId`.
   - Implement route-based `max` selection for ingestion path vs general routes.
   - Implement custom error response and `Retry-After` header mapping.
3. Wire plugin in `apps/gateway/src/app.ts` before proxy routes.
4. Extend `apps/gateway/tests/smoke.test.ts` with focused cases:
   - throttles after limit on non-ingestion route;
   - applies stricter threshold on ingestion route;
   - validates body/headers contract on 429.
5. Ensure Redis client lifecycle is safe in tests and app shutdown.

## 5. Validation plan
- `pnpm --filter @telemetry/gateway lint`
- `pnpm --filter @telemetry/gateway typecheck`
- `pnpm --filter @telemetry/gateway test`

## 6. Risks and mitigations
- Risk: flakey tests due to external Redis dependency.
  - Mitigation: use deterministic in-test Redis mock/stub where possible, or isolate test paths that do not require real Redis I/O.
- Risk: accidental throttling of health/public routes.
  - Mitigation: explicitly bypass public health/auth routes in policy logic.
- Risk: default limits are too low for v1 throughput targets.
  - Mitigation: keep limits environment-configurable and document production tuning values per environment.
- Risk: tenant key fallback could collapse to shared bucket when auth missing.
  - Mitigation: keep auth-required routes behind JWT pre-handler; use explicit fallback key for truly public routes.

## 7. Pending tasks with state
- [done] Confirm next valid task via epic ordering and dependency gates
- [done] Inspect current gateway auth/proxy wiring and env surface
- [pending] Implement rate-limit plugin and constants updates
- [pending] Register plugin in app bootstrap
- [pending] Add gateway tests for throttling behavior and 429 contract
- [pending] Run scoped gateway validations
- [pending] Summarize outcomes and request commit approval

## 8. Approval gate
- Plan ready. Awaiting explicit user approval before implementation.
