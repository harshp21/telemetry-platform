# T-070 Slice 1 Plan: Completed-Task TDD Compliance Audit Through T-024D

## 1. Business objective and user impact
- Ensure completed auth and infra slices through T-024D have auditable pseudo-TDD compliance evidence before any further coverage-gate tightening.
- Reduce regression risk by identifying missing or weak test evidence in completed slices, especially on negative paths and deterministic assertions.
- Produce a single evidence-based gap list so follow-up remediation can be executed in small, low-risk slices.

## 2. Scope and non-goals

### In scope
- Audit completed task-plan and test artifacts through T-024D boundary:
  - T-019, T-020, T-021, T-022, T-024, T-024B, T-024C, T-024D
- Include supporting completed-task coverage context:
  - T-012-TST, T-014, T-015 backfill evidence
- Evaluate four compliance dimensions:
  1. test-before-code evidence where available
  2. acceptance-scenario coverage
  3. negative-path coverage
  4. deterministic assertions
- Produce a prioritized compliance-gap backlog.

### Non-goals
- No app code edits.
- No test file edits.
- No CI workflow edits.
- No coverage-threshold changes.
- No audit expansion beyond T-024D boundary in this slice.

## 3. Acceptance criteria
1. A single audit artifact is produced for completed tasks through T-024D.
2. The artifact includes a per-task compliance matrix for T-019, T-020, T-021, T-022, T-024, T-024B, T-024C, T-024D.
3. Each row is scored on:
  1. test-before-code evidence where available
  2. acceptance-scenario coverage
  3. negative-path coverage
  4. deterministic assertions
4. Every non-compliant or unproven item is listed with severity and a smallest follow-up slice recommendation.
5. Artifact gaps vs compliance failures are clearly separated.
6. Evidence citations point to concrete plan and test files.
7. No code/test files are modified in this slice.

## 4. Step-by-step implementation plan
1. Confirm boundary and artifact inventory through T-024D.
2. Define explicit scoring rubric (pass or partial or fail) for each TDD criterion.
3. Perform plan-to-test trace mapping per in-scope task.
4. Evaluate negative-path completeness per task.
5. Evaluate deterministic assertion quality and flake risk.
6. Classify test-before-code traceability as proven, inferred, or insufficient evidence.
7. Build prioritized gap list with smallest remediation slices.
8. Publish audit result and request approval before remediation implementation.

## 5. Validation and evidence approach
- Guidance anchors:
  - [docs/epics/epic-12-testing.md](docs/epics/epic-12-testing.md)
  - [docs/task-implementer-workflow.md](docs/task-implementer-workflow.md)
- Plan evidence set:
  - [docs/plans/t-019-login-endpoint.md](docs/plans/t-019-login-endpoint.md)
  - [docs/plans/t-020-token-refresh.md](docs/plans/t-020-token-refresh.md)
  - [docs/plans/t-021-logout-endpoint.md](docs/plans/t-021-logout-endpoint.md)
  - [docs/plans/t-022-jwt-verification-plugin.md](docs/plans/t-022-jwt-verification-plugin.md)
  - [docs/plans/t-024-auth-integration-tests.md](docs/plans/t-024-auth-integration-tests.md)
  - [docs/plans/t-024b-auth-unit-tests-and-coverage.md](docs/plans/t-024b-auth-unit-tests-and-coverage.md)
  - [docs/plans/t-024c-t014-t015-comprehensive-tests.md](docs/plans/t-024c-t014-t015-comprehensive-tests.md)
  - [docs/plans/t-024d-auth-prisma-register-repository-fix.md](docs/plans/t-024d-auth-prisma-register-repository-fix.md)
  - [docs/plans/t-012-tst-prisma-singleton-comprehensive-tests.md](docs/plans/t-012-tst-prisma-singleton-comprehensive-tests.md)
- Test evidence set:
  - [apps/auth-service/tests/auth.integration.test.ts](apps/auth-service/tests/auth.integration.test.ts)
  - [apps/auth-service/tests/auth.service.unit.test.ts](apps/auth-service/tests/auth.service.unit.test.ts)
  - [apps/auth-service/tests/auth.controller.unit.test.ts](apps/auth-service/tests/auth.controller.unit.test.ts)
  - [apps/auth-service/tests/jwt.plugin.unit.test.ts](apps/auth-service/tests/jwt.plugin.unit.test.ts)
  - [apps/auth-service/tests/token.service.unit.test.ts](apps/auth-service/tests/token.service.unit.test.ts)
  - [apps/auth-service/tests/user.repository.unit.test.ts](apps/auth-service/tests/user.repository.unit.test.ts)
  - [apps/auth-service/tests/base.repository.unit.test.ts](apps/auth-service/tests/base.repository.unit.test.ts)
  - [apps/auth-service/tests/config/prisma.singleton.unit.test.ts](apps/auth-service/tests/config/prisma.singleton.unit.test.ts)
  - [apps/auth-service/tests/config/container.unit.test.ts](apps/auth-service/tests/config/container.unit.test.ts)
  - [apps/auth-service/tests/index.graceful-shutdown.unit.test.ts](apps/auth-service/tests/index.graceful-shutdown.unit.test.ts)
  - [apps/auth-service/tests/rls.integration.test.ts](apps/auth-service/tests/rls.integration.test.ts)
  - [apps/usage-service/tests/config/container.unit.test.ts](apps/usage-service/tests/config/container.unit.test.ts)
  - [apps/worker-service/tests/config/container.unit.test.ts](apps/worker-service/tests/config/container.unit.test.ts)
  - [apps/billing-service/tests/config/container.unit.test.ts](apps/billing-service/tests/config/container.unit.test.ts)
  - [apps/analytics-service/tests/config/container.unit.test.ts](apps/analytics-service/tests/config/container.unit.test.ts)
  - [apps/gateway/tests/config/container.unit.test.ts](apps/gateway/tests/config/container.unit.test.ts)
  - [apps/usage-service/tests/index.graceful-shutdown.unit.test.ts](apps/usage-service/tests/index.graceful-shutdown.unit.test.ts)
  - [apps/worker-service/tests/index.graceful-shutdown.unit.test.ts](apps/worker-service/tests/index.graceful-shutdown.unit.test.ts)
  - [apps/billing-service/tests/index.graceful-shutdown.unit.test.ts](apps/billing-service/tests/index.graceful-shutdown.unit.test.ts)
  - [apps/analytics-service/tests/index.graceful-shutdown.unit.test.ts](apps/analytics-service/tests/index.graceful-shutdown.unit.test.ts)
  - [apps/gateway/tests/index.graceful-shutdown.unit.test.ts](apps/gateway/tests/index.graceful-shutdown.unit.test.ts)

## 6. Risks and mitigations
- Risk: historical tasks may lack direct chronology proof for test-first ordering.
  - Mitigation: classify as proven, inferred, or insufficient evidence instead of forcing false failures.
- Risk: scope creep beyond T-024D.
  - Mitigation: enforce hard boundary; record out-of-bound notes separately.
- Risk: ambiguous acceptance wording in older plans.
  - Mitigation: map conservatively and mark ambiguity as documentation debt.
- Risk: subjective scoring.
  - Mitigation: use explicit rubric and file-cited evidence only.

## 7. Pending tasks with state
- define rubric and scoring legend: done
- complete artifact inventory through T-024D: done
- execute per-task plan-to-test mapping: done
- complete negative-path and determinism review: done
- publish compliance matrix and prioritized gap list: done
- request approval for remediation slices: pending

## 8. Approval gate
Implementation starts only after explicit approval.

This slice executes audit and reporting only. Any test/code remediation will be proposed as a separate follow-up slice and require a fresh approval gate.

## 9. Audit execution result

### 9.1 Scoring rubric used
- test-before-code evidence:
  - pass: plan and commit trail explicitly show tests created before or together with implementation and reviewed in gate flow.
  - partial: likely compliant but direct chronology proof is not explicit.
  - fail: no credible test-first evidence and missing compensating review evidence.
- acceptance-scenario coverage:
  - pass: planned acceptance scenarios map to concrete tests.
  - partial: at least one planned scenario is indirect or weakly mapped.
  - fail: one or more planned core scenarios missing.
- negative-path coverage:
  - pass: invalid, unauthorized, revoked, duplicate, or failure paths are explicitly tested.
  - partial: negative paths exist but miss a key branch.
  - fail: mostly happy-path only.
- deterministic assertions:
  - pass: assertions validate stable contract outcomes, not timing-dependent side effects.
  - partial: mostly deterministic with a few brittle patterns.
  - fail: flaky or timing-coupled assertions dominate.

### 9.2 Compliance matrix (completed tasks through T-024D)

| Task | Test-before-code evidence | Acceptance coverage | Negative-path coverage | Deterministic assertions | Overall |
|---|---|---|---|---|---|
| T-019 | partial | pass | pass | pass | compliant with traceability gap |
| T-020 | partial | pass | pass | pass | compliant with traceability gap |
| T-021 | partial | pass | pass | pass | compliant with traceability gap |
| T-022 | partial | pass | pass | pass | compliant with traceability gap |
| T-024 | partial | pass | pass | pass | compliant with traceability gap |
| T-024B | partial | pass | pass | pass | compliant, tracker stale |
| T-024C | partial | pass | pass | pass | compliant with traceability gap |
| T-024D | partial | pass | pass | pass | compliant with traceability gap |

### 9.2.1 Compact scenario-to-test trace

| Task | Planned scenario | Evidence test case |
|---|---|---|
| T-019 | login success and invalid-credential parity | [apps/auth-service/tests/auth.integration.test.ts](apps/auth-service/tests/auth.integration.test.ts#L228) |
| T-020 | refresh rotation and revoked-token rejection | [apps/auth-service/tests/auth.integration.test.ts](apps/auth-service/tests/auth.integration.test.ts#L285) |
| T-021 | logout success and token rejection after logout | [apps/auth-service/tests/auth.integration.test.ts](apps/auth-service/tests/auth.integration.test.ts#L372) |
| T-022 | missing, malformed, expired, revoked token handling | [apps/auth-service/tests/jwt.plugin.unit.test.ts](apps/auth-service/tests/jwt.plugin.unit.test.ts#L60) |
| T-024 | register, login, refresh, logout, expired-token integration | [apps/auth-service/tests/auth.integration.test.ts](apps/auth-service/tests/auth.integration.test.ts#L187) |
| T-024B | register-service/repository unit branch coverage | [apps/auth-service/tests/auth.service.unit.test.ts](apps/auth-service/tests/auth.service.unit.test.ts) |
| T-024C | infra container and graceful-shutdown negative paths | [apps/gateway/tests/index.graceful-shutdown.unit.test.ts](apps/gateway/tests/index.graceful-shutdown.unit.test.ts#L150) |
| T-024D | register persistence contract and regression guard | [apps/auth-service/tests/user.repository.unit.test.ts](apps/auth-service/tests/user.repository.unit.test.ts#L67) |

### 9.3 Evidence summary
- core auth flow and negative-path coverage:
  - [apps/auth-service/tests/auth.integration.test.ts](apps/auth-service/tests/auth.integration.test.ts)
  - [apps/auth-service/tests/auth.service.unit.test.ts](apps/auth-service/tests/auth.service.unit.test.ts)
  - [apps/auth-service/tests/jwt.plugin.unit.test.ts](apps/auth-service/tests/jwt.plugin.unit.test.ts)
  - [apps/auth-service/tests/user.repository.unit.test.ts](apps/auth-service/tests/user.repository.unit.test.ts)
- infra backfill coverage for completed tasks:
  - [apps/auth-service/tests/config/prisma.singleton.unit.test.ts](apps/auth-service/tests/config/prisma.singleton.unit.test.ts)
  - [apps/usage-service/tests/config/container.unit.test.ts](apps/usage-service/tests/config/container.unit.test.ts)
  - [apps/gateway/tests/index.graceful-shutdown.unit.test.ts](apps/gateway/tests/index.graceful-shutdown.unit.test.ts)
- plan-state evidence:
  - [docs/plans/t-020-token-refresh.md](docs/plans/t-020-token-refresh.md)
  - [docs/plans/t-021-logout-endpoint.md](docs/plans/t-021-logout-endpoint.md)
  - [docs/plans/t-022-jwt-verification-plugin.md](docs/plans/t-022-jwt-verification-plugin.md)
  - [docs/plans/t-024-auth-integration-tests.md](docs/plans/t-024-auth-integration-tests.md)
  - [docs/plans/t-024b-auth-unit-tests-and-coverage.md](docs/plans/t-024b-auth-unit-tests-and-coverage.md)
  - [docs/plans/t-024c-t014-t015-comprehensive-tests.md](docs/plans/t-024c-t014-t015-comprehensive-tests.md)
  - [docs/plans/t-024d-auth-prisma-register-repository-fix.md](docs/plans/t-024d-auth-prisma-register-repository-fix.md)

## 10. Gap list and follow-up recommendations

### 10.1 Gaps found
- gap-1 (medium): traceability evidence for strict test-before-code ordering is partial for historical tasks T-019 through T-024D (including T-024B and T-024C).
  - impact: compliance cannot be claimed as fully proven; currently inferred from tests plus review flow.
- gap-2 (low): stale or ambiguous plan status markers remain in some completed slices.
  - impacted files:
    - [docs/plans/t-024b-auth-unit-tests-and-coverage.md](docs/plans/t-024b-auth-unit-tests-and-coverage.md)
    - [docs/plans/t-024c-t014-t015-comprehensive-tests.md](docs/plans/t-024c-t014-t015-comprehensive-tests.md)
    - [docs/plans/t-024d-auth-prisma-register-repository-fix.md](docs/plans/t-024d-auth-prisma-register-repository-fix.md)
  - note: T-024B is confirmed stale; T-024C and T-024D need normalization to reflect post-push final state.
- gap-3 (low): auth test lint warnings remain non-blocking but reduce strict quality posture.
  - impacted files:
    - [apps/auth-service/tests/auth.service.unit.test.ts](apps/auth-service/tests/auth.service.unit.test.ts)
    - [apps/auth-service/tests/user.repository.unit.test.ts](apps/auth-service/tests/user.repository.unit.test.ts)

### 10.2 Recommended remediation sequence
1. T-070 Slice 2 (docs-only): normalize stale plan task states for completed slices.
2. T-070 Slice 3 (test hygiene): remove remaining auth test lint warnings with no behavior change.
3. T-070 Slice 4 (traceability hardening): add explicit retrospective evidence section per completed task to mark test-first proof as proven or inferred.

### 10.3 Audit conclusion
- Completed implemented tasks through T-024D are functionally test-compliant for acceptance, negative-path, and deterministic assertions.
- Full strict pseudo-TDD compliance is partial due to historical traceability gaps, not missing core tests.
- After Slice 2 and Slice 3 remediation, task sequencing can continue cleanly from the next epic task.

## 11. Addendum: Implemented Tasks Outside T-024D Boundary

This addendum captures user-requested consideration of implemented tasks with plan artifacts that are outside the original T-024D audit boundary.

### 11.1 Tasks evaluated
- T-025
- T-025A
- T-026
- T-027
- T-068

### 11.2 Evidence anchors
- Plan artifacts:
  - [docs/plans/t-025-gateway-env-schema.md](docs/plans/t-025-gateway-env-schema.md)
  - [docs/plans/t-025a-auth-cookie-refresh-flow.md](docs/plans/t-025a-auth-cookie-refresh-flow.md)
  - [docs/plans/t-026-gateway-http-proxy-routes.md](docs/plans/t-026-gateway-http-proxy-routes.md)
  - [docs/plans/t-027-gateway-jwt-auth-hook.md](docs/plans/t-027-gateway-jwt-auth-hook.md)
  - [docs/plans/t-068-auth-access-ttl-guardrail.md](docs/plans/t-068-auth-access-ttl-guardrail.md)
- Implementation commits:
  - c799181 gateway: align env schema with edge-service config
  - 640e53d feat(auth-service): implement T-025A cookie refresh and CSRF flow
  - 9d1fa1a gateway: register v1 proxy routes for service upstreams
  - c58866a feat(gateway): enforce JWT auth before proxy routing
  - b9ccf7e feat(auth): enforce access token TTL max guardrail
- Test evidence:
  - [apps/auth-service/tests/auth.integration.test.ts](apps/auth-service/tests/auth.integration.test.ts)
  - [apps/auth-service/tests/session-cookie.unit.test.ts](apps/auth-service/tests/session-cookie.unit.test.ts)
  - [apps/auth-service/tests/env.schema.unit.test.ts](apps/auth-service/tests/env.schema.unit.test.ts)
  - [apps/gateway/tests/config/container.unit.test.ts](apps/gateway/tests/config/container.unit.test.ts)
  - [apps/gateway/tests/smoke.test.ts](apps/gateway/tests/smoke.test.ts)
  - [apps/gateway/tests/proxy.plugin.unit.test.ts](apps/gateway/tests/proxy.plugin.unit.test.ts)
  - [apps/gateway/tests/auth.middleware.unit.test.ts](apps/gateway/tests/auth.middleware.unit.test.ts)

### 11.3 Updated compliance verdict (after Slice 2A)

| Task | Test-before-code evidence | Acceptance coverage | Negative-path coverage | Deterministic assertions | Overall |
|---|---|---|---|---|---|
| T-025 | partial | pass | partial | pass | mostly compliant; route-level behavior out of scope |
| T-025A | partial | pass | pass | pass | compliant with traceability gap |
| T-026 | partial | pass | pass | pass | compliant with traceability gap |
| T-027 | partial | pass | pass | pass | compliant with traceability gap |
| T-068 | partial | pass | pass | pass | compliant with traceability gap |

### 11.4 Additional gaps surfaced
- gap-4 (resolved): explicit task-level assertion evidence now exists for T-026 and T-027 in gateway tests.
  - evidence: [apps/gateway/tests/proxy.plugin.unit.test.ts](apps/gateway/tests/proxy.plugin.unit.test.ts) and [apps/gateway/tests/auth.middleware.unit.test.ts](apps/gateway/tests/auth.middleware.unit.test.ts).
- gap-5 (low): several post-implementation plans still end at "summarize/request approval" markers, which weakens auditable closure even when commits exist.

### 11.5 Recommended follow-up
1. Normalize stale "pending summary" markers in T-025/T-026/T-027/T-068 plans after evidence reconciliation.