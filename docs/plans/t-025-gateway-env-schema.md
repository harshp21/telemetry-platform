# T-025 Plan: Gateway Environment Schema Alignment

## 1. Business objective and user impact
- Align gateway runtime configuration with its true responsibilities (API edge/proxy only, no database dependency).
- Prevent startup/config errors caused by irrelevant or missing environment variables.

## 2. Scope and non-goals

### In scope
- Update `apps/gateway/src/config/env.ts` to use a gateway-specific schema.
- Remove `DATABASE_URL` from the required gateway env surface.
- Align default gateway `PORT` to `3100` (matches repository service-port convention).
- Add required upstream service URL and rate-limit env entries from Epic 5 task definition.

### Non-goals
- Implementing proxy routes (`T-026`).
- Implementing gateway JWT auth hook (`T-027`).
- Implementing rate-limit plugin behavior (`T-028`).
- Changing runtime wiring outside env parsing contract.

## 3. Acceptance criteria
- Gateway env schema excludes `DATABASE_URL`.
- `PORT` default is `3100`.
- Schema includes:
  - `AUTH_SERVICE_URL`, `USAGE_SERVICE_URL`, `BILLING_SERVICE_URL`, `ANALYTICS_SERVICE_URL` as URL strings.
  - `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `INGESTION_RATE_LIMIT_MAX` as positive integers with defaults.
- `pnpm --filter @telemetry/gateway lint`, `typecheck`, and `test` pass.

## 4. Technical implementation steps
1. Modify `apps/gateway/src/config/env.ts` schema fields and defaults.
2. Keep exported types/API shape stable (`ServiceEnv`, `env`).
3. Run scoped gateway validations.

## 5. Validation plan
- `pnpm --filter @telemetry/gateway lint`
- `pnpm --filter @telemetry/gateway typecheck`
- `pnpm --filter @telemetry/gateway test`

## 6. Risks and mitigations
- Risk: newly required service URL env vars could fail tests/startup where env is absent.
  - Mitigation: verify existing app/test boot path uses only env parser contract already satisfied in test context, and adjust only if truly required by current code path.
- Risk: implicit reliance on old default port value.
  - Mitigation: keep startup constants as source-of-truth and align env default to those conventions.

## 7. Pending tasks with state
- [done] Identify next logical task after T-067C completion
- [done] Inspect current gateway env schema implementation
- [done] Implement schema alignment in `apps/gateway/src/config/env.ts`
- [done] Run scoped gateway validation commands
- [pending] Summarize outcomes and request commit approval

## 8. Approval gate
- Implementation approved and applied; awaiting user approval for commit/push.
