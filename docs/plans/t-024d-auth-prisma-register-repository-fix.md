# T-024D Plan: Auth Prisma Register Repository Fix

## 1. Business objective and user impact
- Unblock Stage-7 CI by fixing the auth integration runtime failure that returns 500 during register/login setup.
- Restore expected registration behavior so downstream auth flows are testable and reliable.
- Keep this as a minimal, root-cause correction in the auth repository layer.

## 2. Scope and non-goals

### In scope
- Primary fix in [apps/auth-service/src/repositories/user.repository.ts](apps/auth-service/src/repositories/user.repository.ts).
- Directly coupled test updates only if required:
  - [apps/auth-service/tests/user.repository.unit.test.ts](apps/auth-service/tests/user.repository.unit.test.ts)
  - [apps/auth-service/tests/auth.integration.test.ts](apps/auth-service/tests/auth.integration.test.ts)

### Non-goals
- No Prisma schema/migration edits by default.
- No cross-service changes.
- No refactor outside the failing register persistence contract.

## 3. Acceptance criteria
- Register integration paths no longer fail with Prisma unknown-argument error.
- Auth integration scenarios that currently fail with 500 due to this mismatch return expected status codes.
- Repository create payload aligns with runtime Prisma client contract.
- Auth-scoped `test`, `lint`, and `typecheck` pass.
- Stage-7 CI gate passes: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`.

## 4. Implementation steps
1. Reproduce failure in auth integration tests to confirm baseline.
2. Inspect and minimally correct the create payload in [apps/auth-service/src/repositories/user.repository.ts](apps/auth-service/src/repositories/user.repository.ts#L186).
3. Preserve existing behavior for tenant creation, email uniqueness handling, and role assignment.
4. Adjust directly coupled tests only if the corrected payload requires expectation updates.
5. Re-run targeted auth integration and repository unit tests.
6. Run auth-scoped lint/typecheck.
7. Re-run Stage-7 full CI gate commands.

## 5. Validations
- Auth scoped:
  - `pnpm --filter @telemetry/auth-service exec vitest run tests/auth.integration.test.ts`
  - `pnpm --filter @telemetry/auth-service exec vitest run tests/user.repository.unit.test.ts`
  - `pnpm --filter @telemetry/auth-service lint`
  - `pnpm --filter @telemetry/auth-service typecheck`
- Stage-7 full CI:
  - `pnpm build`
  - `pnpm test`
  - `pnpm lint`
  - `pnpm typecheck`

## 6. Risks and mitigations
- Risk: payload edit fixes symptom but not root cause.
  - Mitigation: tie fix to exact failing runtime error site and verify integration behavior end-to-end.
- Risk: hidden dependency on generated Prisma client state.
  - Mitigation: if repository-only fix does not resolve error, capture evidence and open explicit schema/client alignment follow-up.
- Risk: scope creep.
  - Mitigation: keep edits constrained to repository path and directly coupled tests.

## 7. Pending tasks with state
- T-024D.1 reproduce baseline failure: done
- T-024D.2 apply repository payload correction: done
- T-024D.3 adjust coupled tests if required: done
- T-024D.4 run auth-scoped validations: done
- T-024D.5 pre-QA review handoff: done
- T-024D.6 QA review handoff: done
- T-024D.7 final senior review handoff: done
- T-024D.8 stage-7 CI rerun: done
- T-024D.9 stage-8 commit approval gate: pending

## 8. Approval gate
Implementation starts only after explicit user approval for T-024D.