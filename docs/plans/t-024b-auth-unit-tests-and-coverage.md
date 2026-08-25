# T-024B Plan: Auth Unit Test Stabilization and Coverage Backfill

## 1. Business objective and user impact
- Restore a zero-error baseline in auth unit tests so quality gates are reliable.
- Complete comprehensive tests for completed tasks through phased, single-slice delivery.
- Keep regressions out of completed infrastructure and auth foundations.

## 2. Delivery model and scope boundary

This request is executed as phased slices because Enterprise Delivery allows one task slice at a time.

### Slice-1 (current approval request): T-024B stabilization
In scope:
- Fix the compile error in [apps/auth-service/tests/auth.service.unit.test.ts](apps/auth-service/tests/auth.service.unit.test.ts#L232).
- Run minimal auth-scoped validation to prove zero errors for this slice.

Out of scope:
- New broad tests for completed infra tasks.
- Cross-service refactors.

### Slice-2 (next): T-012-TST proposed
In scope:
- Add comprehensive singleton tests for completed T-012 across Prisma-backed services.

### Slice-3 (next): T-014-T015-TST proposed
In scope:
- Add comprehensive tests for completed T-014 (container wiring) and T-015 (graceful shutdown).

## 3. Slice-1 acceptance criteria
- The compile error at [apps/auth-service/tests/auth.service.unit.test.ts](apps/auth-service/tests/auth.service.unit.test.ts#L232) is fixed.
- Auth-service typecheck passes.
- Modified unit test file passes lint.
- Target unit file executes successfully.
- No functional behavior changes beyond type-safe assertion handling.

## 4. Slice-1 technical plan (exact steps)
1. Confirm current diagnostic in [apps/auth-service/tests/auth.service.unit.test.ts](apps/auth-service/tests/auth.service.unit.test.ts#L232).
2. Apply minimal local assertion fix to avoid destructuring a possibly undefined tuple from mocked calls.
3. Preserve test intent: still validate bcrypt rounds are numeric and within expected range.
4. Run scoped validations:
   - `pnpm --filter @telemetry/auth-service typecheck`
   - `pnpm --filter @telemetry/auth-service exec vitest run tests/auth.service.unit.test.ts`
   - `pnpm --filter @telemetry/auth-service exec eslint tests/auth.service.unit.test.ts`
5. Prepare handoff artifacts for pre-QA review.

## 5. Risks and mitigations
- Risk: additional strict typing errors in the same file.
  - Mitigation: keep fixes local to the same test file and rerun the same scoped validations.
- Risk: accidental behavior change while fixing typing.
  - Mitigation: do not change production code paths; adjust assertion mechanics only.
- Risk: validation scope creep.
  - Mitigation: use only the three scoped validation commands for Slice-1.

## 6. Pending tasks with state
- slice-1 baseline diagnostic confirmation: done
- slice-1 compile-fix implementation: done
- slice-1 scoped validations: done
- slice-1 pre-QA review handoff: done
- slice-2 T-012 singleton comprehensive tests: pending
- slice-3 T-014 and T-015 comprehensive tests: pending
- stage-7 full CI gate: pending
- stage-8 commit approval gate: blocked

## 7. Approval gate
Implementation starts only after explicit user approval.

Please approve Slice-2 implementation now:
- Add comprehensive singleton tests for completed T-012 across Prisma-backed services.
- Run scoped validations for touched services.
- Keep T-014 and T-015 backfill work for Slice-3.
