# T-071 Plan: CI Determinism and Readiness Hardening

## 1. Business objective and user impact
- Objective: harden CI so it behaves deterministically and fails only on real regressions, not timing races.
- User impact:
  - Developers get stable pass/fail signals on pull requests.
  - Reviewer confidence improves because flaky smoke failures are reduced.
  - Release throughput improves by reducing rerun/retry noise and manual triage.
- Business impact:
  - Lower CI waste and faster merge cycles.
  - Better production readiness signal because service startup dependencies are explicitly gated.

## 2. Strict scope and non-goals

### In scope
- Modify only .github/workflows/ci.yml.
- Change pnpm install to lockfile-enforced mode.
- Add Redis container health-check configuration and service readiness gate behavior via GitHub Actions services options.
- Keep current smoke command exactly as-is and wrap it with bounded retry logic in the workflow step.

### Out of scope
- Any application or test code changes.
- Any command changes inside the smoke script itself in package.json.
- Docker Compose file changes.
- Refactoring job structure, matrix expansion, or unrelated CI optimizations.

## 3. Task goal
- Deliver a single CI workflow hardening slice that addresses all three diagnosed issues:
  - nondeterministic dependency installation
  - missing Redis readiness gate
  - startup-race-prone smoke execution
- Preserve current CI job intent and command order wherever possible.

## 4. Owning files
- Primary and only edit target:
  - .github/workflows/ci.yml
- Reference-only context:
  - package.json (smoke command immutability requirement)

## 5. Controlling code path and local hypothesis
- Controlling path:
  - .github/workflows/ci.yml job ci, services and steps sequence from Install through Run Smoke Tests.
- Falsifiable local hypothesis:
  - If install is lockfile-strict, Redis has an explicit health probe gate, and smoke execution is retried with bounded attempts and fixed backoff, then intermittent CI failures caused by dependency drift and startup timing races will drop materially without changing smoke test logic.
- Falsification signal:
  - CI still exhibits similar intermittent smoke failures after these changes across several runs.

## 6. Exact implementation steps
1. Enforce deterministic dependency installation
- In .github/workflows/ci.yml, update the Install step from non-frozen mode to frozen lockfile mode.
- Expected net effect: dependency graph must match lockfile exactly in CI.

2. Add Redis health-check options
- In .github/workflows/ci.yml, extend the redis service definition with Docker health options:
  - health command using redis ping
  - interval
  - timeout
  - retries
- Keep existing Redis image and port mapping unchanged.
- Expected net effect: CI job waits for healthy Redis service before dependent steps proceed.

3. Add bounded retry wrapper around smoke step
- Keep smoke command string exactly unchanged: pnpm test:smoke:compose.
- Replace one-shot Run Smoke Tests step body with a shell loop wrapper in .github/workflows/ci.yml:
  - fixed max attempts, 3
  - fixed sleep between attempts, 15 seconds
  - immediate success exit on first pass
  - final hard failure after max attempts exhausted
  - clear logging per attempt
- Expected net effect: transient startup races can self-heal while preserving hard-fail behavior for real defects.

4. Preserve existing pipeline semantics
- Do not reorder unrelated quality gates unless required for readiness hardening correctness.
- Keep all existing commands and step purposes intact outside this task scope.

## 7. Step-level validation plan
1. Workflow syntax sanity
- Validate YAML structure and indentation for .github/workflows/ci.yml.
- Fail-fast criterion: malformed workflow.

2. Determinism check
- Verify Install step now uses frozen lockfile mode in .github/workflows/ci.yml.
- Fail-fast criterion: non-frozen mode still present.

3. Redis readiness gate check
- Verify redis service now has health-check options in .github/workflows/ci.yml.
- Fail-fast criterion: missing health options.

4. Smoke retry wrapper correctness
- Verify smoke command string remains exactly unchanged while step logic now retries with explicit attempt bound.
- Fail-fast criterion: smoke command altered or retry loop unbounded.

5. CI observation pass
- On PR or branch run, inspect CI logs for:
  - locked install behavior
  - redis health gate messages
  - retry attempt logs only when needed
- Success criterion: workflow passes without nondeterministic startup failures in normal conditions and still fails clearly for real test failures.

## 8. Risks and mitigations
- Risk: frozen lockfile may fail immediately if lockfile is stale.
- Mitigation: intended behavior; update lockfile in a separate, explicit dependency-change task rather than weakening CI determinism.

- Risk: Redis health probe may be too strict or too lenient.
- Mitigation: start with conservative timeout/retry values aligned with existing Postgres gate style in .github/workflows/ci.yml, then tune only if logs justify.

- Risk: retry wrapper may mask real failures.
- Mitigation: bounded retries only, no command mutation, and final non-zero exit after max attempts.

- Risk: increased CI runtime on flaky starts.
- Mitigation: small retry cap and fixed short sleep to limit worst-case runtime growth.

## 9. Pending tasks with states
- T-071-01 Update install step to frozen lockfile: done
- T-071-02 Add Redis health-check options: done
- T-071-03 Add bounded smoke retry wrapper with unchanged smoke command: done
- T-071-04 Validate workflow syntax and targeted diff review: done
- T-071-05 Observe CI run evidence and capture outcomes: pending
- T-071-06 Request implementation approval checkpoint: done

## 10. Approval boundary
- Implementation starts only after explicit user approval of this plan.
- Commit/push remains gated by downstream review and CI stages.
