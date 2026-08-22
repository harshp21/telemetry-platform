# Project Guidelines

## Workflow
- Work one epic task at a time.
- Keep changes scoped to a single completed slice.
- Show a detailed execution plan before making substantive changes.
- Keep a visible pending-task list and update it as work progresses.
- Ask for approval before starting implementation after presenting the plan.
- Ask for approval before any commit or push.
- Prefer the agent flow: Enterprise Delivery -> Epic Router -> Task Planner -> Task Implementer -> QA Tester -> Senior Reviewer.

## Token Discipline
- Read the smallest local surface that can prove or disprove the current hypothesis.
- Prefer owning files, nearest tests, and direct call sites over broad repo exploration.
- During plan approval, provide detailed scope, steps, validations, risks, and pending tasks.
- Do not restate unchanged plans or long summaries.
- Use concise outputs with findings first, then risks, then next action.

## Engineering Standards
- Use strict TypeScript with explicit types.
- Avoid deprecated APIs.
- Avoid `any` and avoid `unknown` unless the boundary justifies it and the reason is explicit.
- Reuse service constants instead of magic literals.
- Fix root causes rather than patching symptoms.

## Validation
- Run the narrowest useful validation immediately after the first substantive edit.
- Prefer task-scoped lint, typecheck, tests, or schema validation over broad repo commands.
- For Prisma changes, keep schema and migration files aligned.

## References
- See [docs/contributing-guide.md](../docs/contributing-guide.md) for task hygiene.
- See [docs/coding-standards.md](../docs/coding-standards.md) for code conventions.
- See [docs/folder-structure.md](../docs/folder-structure.md) for repo ownership.