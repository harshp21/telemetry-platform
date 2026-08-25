# Project Guidelines

## Workflow
- Work one epic task at a time.
- Keep changes scoped to a single completed slice.
- Show a detailed execution plan before making substantive changes.
- Create or update a plan file in `docs/plans/` before requesting implementation approval.
- Keep a visible pending-task list and update it as work progresses.
- Ask for approval before starting implementation after presenting the plan.
- **NO commits until all gates pass** (implementation, reviews, QA, CI validation all complete).
- Ask for approval before final commit/push after all gates are satisfied.
- Preferred agent flow: Epic Router → Task Planner → Task Implementer → Senior Reviewer (pre-QA) → QA Tester → Senior Reviewer (final) → CI Validation Gate → Commit Approval.

## Token Discipline
- Read the smallest local surface that can prove or disprove the current hypothesis.
- Prefer owning files, nearest tests, and direct call sites over broad repo exploration.
- During plan approval, provide detailed scope, steps, validations, risks, and pending tasks.
- Do not restate unchanged plans or long summaries.
- Use concise outputs with findings first, then risks, then next action.

## Commit & CI Best Practices
- **Commit timing**: Stage all changes during implementation but DO NOT commit until all review/QA gates pass AND CI validation succeeds.
- **One commit per task**: Each completed task should result in a single, atomic commit (not incremental commits during review cycles).
- **CI validation gate**: Before final commit approval, run: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck` across all 13 packages.
- **If CI fails**: Request fixes, apply them to staged (uncommitted) changes, re-validate CI, then commit.
- **Rollback safety**: Uncommitted changes can be discarded if any gate requests major revisions; no need to revert commits.

## Engineering Standards
- Use strict TypeScript with explicit types.
- Avoid deprecated APIs.
- Avoid `any` and avoid `unknown` unless the boundary justifies it and the reason is explicit.
- Reuse service constants instead of magic literals.
- Fix root causes rather than patching symptoms.

## Implementation Methodology: Pseudo-TDD
- **Task Implementer workflow** (T-019 onwards): Pseudo-Test-Driven Development (TDD)
  1. Write test file with ALL scenarios (from plan) BEFORE implementing code
  2. Implement code to pass tests (controller → service → repository)
  3. Refactor only AFTER all tests pass (tests protect against regression)
  4. Run validations: typecheck, lint, tests
- **Benefits**: Guaranteed test coverage, safe refactoring, clear contract definition, edge case discovery
- **See**: [docs/task-implementer-workflow.md](../docs/task-implementer-workflow.md) for detailed TDD pattern and examples

## Validation
- Run the narrowest useful validation immediately after the first substantive edit.
- Prefer task-scoped lint, typecheck, tests, or schema validation over broad repo commands.
- For Prisma changes, keep schema and migration files aligned.

## References
- See [docs/contributing-guide.md](../docs/contributing-guide.md) for task hygiene.
- See [docs/coding-standards.md](../docs/coding-standards.md) for code conventions.
- See [docs/folder-structure.md](../docs/folder-structure.md) for repo ownership.
- See [docs/task-implementer-workflow.md](../docs/task-implementer-workflow.md) for TDD implementation pattern (T-019+).