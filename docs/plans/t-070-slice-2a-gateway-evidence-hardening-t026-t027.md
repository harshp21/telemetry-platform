# T-070 Slice 2A: Gateway Evidence Hardening for T-026 and T-027

## Scope
- Task ID: T-070 Slice 2A
- Objective: Close compliance evidence gaps for implemented tasks T-026 and T-027 by adding explicit deterministic tests only.
- In scope:
  - Add gateway test assertions for T-026 proxy registration matrix.
  - Add gateway test assertions for T-027 public-vs-protected auth route matrix.
  - Update T-070 audit artifact with closure evidence links and revised verdict.
- Out of scope:
  - No gateway runtime feature changes.
  - No auth policy changes.
  - No proxy behavior changes.
  - No downstream service changes.

## Business Context
T-070 Slice 1 addendum marked T-026 and T-027 as evidence-insufficient. This blocks a definitive task-by-task TDD compliance verdict for implemented tasks. This slice resolves that ambiguity with minimal risk by hardening tests and audit traceability only.

## Owning Files
- apps/gateway/tests/proxy.plugin.unit.test.ts
- apps/gateway/tests/auth.middleware.unit.test.ts
- apps/gateway/src/middleware/auth.middleware.ts (only if minimal test seam required)
- apps/gateway/src/plugins/proxy.plugin.ts (only if minimal test seam required)
- apps/gateway/src/app.ts (only if minimal test seam required)
- docs/plans/t-070-slice-1-completed-task-tdd-compliance-audit-through-t-024d.md

## Detailed Plan
1. Map acceptance criteria to explicit assertions
- Translate T-026 and T-027 requirements into an assertion checklist before code edits.
- Ensure each acceptance and negative path has at least one deterministic assertion.

2. Add T-026 proxy evidence assertions (tests first)
- Assert all four /v1 route groups are registered with expected upstream mappings.
- Assert exact registration count and deterministic mapping (prefix, rewritePrefix).
- Assert request header propagation behavior:
  - unauthenticated request does not inject auth headers
  - authenticated request injects x-tenant-id, x-user-id, x-user-role with exact values

3. Add T-027 auth matrix assertions (tests first)
- Public route bypass assertions:
  - GET /health
  - GET /v1/health
  - POST /v1/auth/register
  - POST /v1/auth/login
  - POST /v1/auth/refresh
- Protected route negative-path assertions:
  - missing Authorization -> 401 TOKEN_MISSING
  - malformed header/token -> 401 TOKEN_INVALID
  - expired token -> 401 TOKEN_EXPIRED
  - invalid claims payload -> 401 TOKEN_INVALID
- Protected route positive-path assertion:
  - valid token sets authContext with correct mapped values

4. Keep code changes minimal
- Prefer test-only edits.
- If production code seam is required, allow only non-behavioral observability seam and revalidate no behavior drift.

5. Update audit artifact
- Update T-070 addendum verdict for T-026/T-027 with direct evidence links.
- Preserve the original boundary notes while appending closure status.

## Validation Plan
1. Narrow targeted tests first
- pnpm --filter @telemetry/gateway test -- tests/proxy.plugin.unit.test.ts tests/auth.middleware.unit.test.ts

2. Full gateway validations
- pnpm --filter @telemetry/gateway test
- pnpm --filter @telemetry/gateway lint
- pnpm --filter @telemetry/gateway typecheck

3. Enterprise CI gate before commit approval
- pnpm build
- pnpm test
- pnpm lint
- pnpm typecheck

## Risks and Mitigations
- Risk: test assertions become integration/network dependent.
- Mitigation: keep deterministic contract-style unit tests with mocks only.

- Risk: evidence still considered indirect.
- Mitigation: assert exact matrix items from plan acceptance criteria and error contracts.

- Risk: accidental runtime behavior drift from test seam edits.
- Mitigation: test-first approach and full gateway validation after any seam exposure.

## Pending Tasks
- T-070-2A-01 Map evidence assertions from audit gap: done
- T-070-2A-02 Add T-026 proxy registration evidence tests: done
- T-070-2A-03 Add T-027 auth matrix evidence tests: done
- T-070-2A-04 Run targeted gateway tests: done
- T-070-2A-05 Run gateway lint + typecheck: done
- T-070-2A-06 Update T-070 audit addendum verdict: done
- T-070-2A-07 Senior Pre-QA review: done
- T-070-2A-08 QA review: done
- T-070-2A-09 Senior Final review: done
- T-070-2A-10 Stage 7 CI validation gate: done
- T-070-2A-11 Commit approval gate: pending

## Approval Gate
Implementation approved and completed for this slice.
No commit/push is allowed without explicit post-review approval.
