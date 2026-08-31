# Rule — Testing

## Method
Epic tasks use pseudo-TDD — `docs/task-implementer-workflow.md`. Skeletons → bodies →
**confirm red** → implement → refactor on green. A test that never failed proves nothing.

## Quality bar
- Assert **behaviour**, not a mock's own return value. A test that stubs a call and then
  asserts the stub's value is tautological and will be flagged.
- Helpers that locate a call (e.g. "the nth query") must **throw** when it is missing rather
  than passing vacuously.
- Negative assertions carry the most weight for security invariants: *no other tenant in the
  bound values*, *granularity absent from the parameter list*, *not an instance of
  `Prisma.Decimal`*.
- Cover the success path **plus** at least one negative path for every auth/validation branch.
- Prefer `app.inject` route tests over placeholder smoke tests.
- `beforeEach`/`afterEach` app lifecycle per file — no cross-test coupling.

## Scoping
`pnpm --filter <pkg> test -- <file>` does **not** filter — vitest runs the whole package suite.
Use `pnpm --filter <pkg> exec vitest run <file>`.

## Integration tests
`*.integration.test.ts` need real Postgres and Redis. They are excluded from the default
vitest config and run via their own script and CI step — separate from `pnpm test`, but never
silently outside the gate.

## Before handoff
Task-scoped lint/typecheck/test/build, then the full root gate across all 13 packages.
Distinguish pre-existing warnings from newly introduced ones and prove it with
`git diff --name-only` / `git log -1 <file>`.
