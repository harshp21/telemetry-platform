# T-019 Login Endpoint Plan

## Business objective and user impact

- Enable registered users to authenticate securely and obtain an access token for protected API usage.
- Reduce support friction by returning consistent error responses for invalid credentials.
- Establish the auth contract required by upcoming gateway and frontend milestones.

## Scope

- Implement `POST /v1/auth/login` in auth service.
- Validate request payload and return standardized validation errors.
- Verify credentials with timing-safe handling for unknown users.
- Issue access token and persist hashed refresh token with expiry.
- Add focused tests for success and invalid-credential paths.

## Non-goals

- Refresh endpoint implementation (`T-020`).
- Logout and denylist integration (`T-021`).
- JWT verification plugin for protected routes (`T-022`).

## Acceptance criteria

1. `POST /v1/auth/login` accepts `{ email, password }`.
2. Valid credentials return success response with access token payload.
3. Unknown email and wrong password return the same `401 INVALID_CREDENTIALS` surface.
4. Refresh token storage writes only hashed token data with valid expiry.
5. Tests cover success and invalid credential behaviors.

## Technical implementation steps

1. Confirm login contract and constants for response/error codes.
2. Add login request schema validation in controller.
3. Implement credential verification in service with dummy compare path for unknown users.
4. Add token issuance/persistence via auth service and token service.
5. Register login route under `/v1/auth` routing.
6. Add/update tests for success and 401 behavior parity.

## Likely files

- `apps/auth-service/src/controllers/auth.controller.ts`
- `apps/auth-service/src/services/auth.service.ts`
- `apps/auth-service/src/services/token.service.ts` (new or updated)
- `apps/auth-service/src/repositories/user.repository.ts`
- `apps/auth-service/src/routes/index.ts`
- `apps/auth-service/src/constants.ts`
- `apps/auth-service/tests/*` (task-focused tests)

## Validation plan

1. `pnpm --filter @telemetry/auth-service lint`
2. `pnpm --filter @telemetry/auth-service typecheck`
3. `pnpm --filter @telemetry/auth-service test`

## Risks and mitigations

- Risk: credential-path timing differences may leak account existence.
  - Mitigation: always execute compare path for unknown users via dummy hash.
- Risk: inconsistent error contract across controller/service.
  - Mitigation: use shared auth constants and unified error mapping.
- Risk: token persistence and response drift.
  - Mitigation: define response contract first and validate via tests.

## Pending tasks

- done: Route next valid epic task (`T-019`).
- pending: Confirm refresh-token delivery mode for login response.
- pending: Implement controller/service/repository updates for login.
- pending: Add/update tests for success and invalid-credential parity.
- pending: Run scoped auth-service validations.

## Approval gate

Implementation must not start until this plan is explicitly approved.