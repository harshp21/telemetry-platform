# T-068 Plan: Auth Access Token TTL Guardrail

## 1. Business objective and user impact
- Enforce a hard upper bound for access token lifetime to reduce impact of token theft.
- Keep short-lived access tokens aligned with security posture regardless of runtime env misconfiguration.

## 2. Scope and non-goals

### In scope
- Add max constraint to `JWT_ACCESS_TTL_SECONDS` in `apps/auth-service/src/config/env.ts`.
- Reuse auth constants for max value instead of magic literals.
- Add focused unit tests for schema acceptance/rejection around the max bound.

### Non-goals
- Changing refresh token TTL behavior.
- Changing token payload format.
- Changing cookie/session flow.

## 3. Acceptance criteria
- `JWT_ACCESS_TTL_SECONDS` rejects values above security cap.
- Existing default value remains valid.
- Auth-service lint/typecheck/test pass.

## 4. Technical implementation steps
1. Add max TTL constant in auth constants module.
2. Apply `.max(...)` bound in auth env schema.
3. Add/extend unit tests to validate schema behavior for valid and invalid TTL values.
4. Run scoped auth-service validations.

## 5. Validation plan
- `pnpm --filter @telemetry/auth-service lint`
- `pnpm --filter @telemetry/auth-service typecheck`
- `pnpm --filter @telemetry/auth-service test`

## 6. Risks and mitigations
- Risk: Existing deploy env with too-high access TTL starts failing boot.
  - Mitigation: intentional fail-fast; default remains within allowed bounds.

## 7. Pending tasks with state
- [done] Identify files and current TTL configuration
- [done] Add max access TTL constant and env schema cap
- [done] Add schema validation unit tests
- [done] Run scoped auth-service validation commands
- [in-progress] Summarize outcomes and request commit approval

## 8. Approval gate
- Implementation and scoped validation complete; pending commit approval.
