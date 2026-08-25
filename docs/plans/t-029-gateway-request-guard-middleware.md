# T-029 Plan: Gateway Request Guard Middleware

## 1. Business objective and user impact
- Prevent malformed, oversized, or spoofed requests from reaching internal services, reducing abuse risk and noisy downstream failures.
- Preserve trust boundaries so tenant and user identity always come from verified JWT context, not client-controlled headers.
- Guarantee traceability by ensuring every request has a request id before auth, rate limiting, and proxying.

## 2. Scope and non-goals

### In scope
- Add global gateway request guard middleware for:
  - body size cap at 1 MB via Content-Length check
  - write-route Content-Type enforcement
  - identity-header stripping for client-supplied auth headers
  - request-id injection when missing
- Register guard middleware so it runs before JWT auth hook and before proxy handling.
- Add focused tests for guard behavior and compatibility with existing auth/proxy behavior.

### Non-goals
- No JWT verification logic changes in apps/gateway/src/middleware/auth.middleware.ts.
- No proxy upstream mapping changes in apps/gateway/src/plugins/proxy.plugin.ts.
- No rate-limit policy changes in apps/gateway/src/plugins/rate-limit.plugin.ts.
- No env schema/container changes.
- No downstream service changes.

## 3. Acceptance criteria
- Oversized request:
  - Content-Length greater than 1048576 returns 413 with { code: "PAYLOAD_TOO_LARGE" }.
- Unsupported media type:
  - POST/PUT/PATCH with missing or non-JSON Content-Type returns 415 with { code: "UNSUPPORTED_MEDIA_TYPE" }.
  - application/json and application/json with charset are accepted.
- Header stripping:
  - Incoming x-tenant-id, x-user-id, x-user-role are removed before JWT/proxy processing.
- Request id injection:
  - If x-request-id is absent, middleware injects a UUID.
  - If x-request-id is present, middleware preserves it.
- Compatibility:
  - Existing JWT and proxy behavior remains unchanged except sanitized headers and guaranteed request id.
- Gateway lint, typecheck, and tests pass.

## 4. Technical implementation steps (Pseudo-TDD)
1. Create tests first in new file apps/gateway/tests/guards.middleware.unit.test.ts covering all acceptance scenarios.
2. Add compatibility tests for existing auth/proxy behavior as needed in:
  - apps/gateway/tests/auth.middleware.unit.test.ts
  - apps/gateway/tests/proxy.plugin.unit.test.ts
3. Implement new middleware in apps/gateway/src/middleware/guards.middleware.ts with minimal logic:
  - payload size guard
  - content-type guard for write methods
  - strip spoofable identity headers
  - request-id injection
4. Wire middleware in apps/gateway/src/app.ts before gatewayJwtAuthPreHandler.
5. Re-run tests and static checks, then adjust only for failing assertions.

## 5. Validation plan
1. pnpm --filter @telemetry/gateway test -- tests/guards.middleware.unit.test.ts
2. pnpm --filter @telemetry/gateway test -- tests/auth.middleware.unit.test.ts tests/proxy.plugin.unit.test.ts
3. pnpm --filter @telemetry/gateway typecheck
4. pnpm --filter @telemetry/gateway lint
5. pnpm --filter @telemetry/gateway test

## 6. Risks and mitigations
- Risk: auth runs before guard due to hook ordering drift.
  - Mitigation: add ordering-sensitive tests via app bootstrap path.
- Risk: content-type matching too strict and rejects valid JSON variants.
  - Mitigation: accept application/json and application/json; charset=... and test both.
- Risk: header casing could bypass stripping.
  - Mitigation: rely on Fastify lowercase headers and test lowercase variants.
- Risk: request-id generation non-determinism in tests.
  - Mitigation: mock randomUUID for stable assertions.
- Risk: chunked requests without Content-Length are not covered by this slice.
  - Mitigation: keep as explicit non-goal and track follow-up if needed.

## 7. Pending tasks with state
- done: Confirm T-029 requirements and dependency readiness.
- done: Verify T-028 implementation exists and is validated in code/tests.
- done: Create T-029 plan artifact.
- done: Implement test-first guard middleware tests.
- done: Implement middleware and app wiring.
- done: Run scoped gateway validations.
- done: Senior Pre-QA review.
- done: QA review.
- done: Senior Final review.
- done: Stage 7 CI validation gate.
- pending: Commit approval gate.

## 8. Approval gate
Plan ready. Awaiting explicit user approval before implementation.
