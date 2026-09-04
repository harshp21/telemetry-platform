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
`*.integration.test.ts` need real Postgres and Redis, **and they run inside `pnpm test`**. The
five services that have a `vitest.config.mjs` (`analytics`, `auth`, `billing`, `usage`, `worker`)
all set `include: ["tests/**/*.test.ts"]` with no `test.exclude` — the `exclude` in those files is
under `coverage`, which is a different thing — and the remaining packages have no config and use
vitest's defaults, which also collect them. So `pnpm test` requires a live database, and CI
applies migrations before any test step for exactly that reason.

Two suites additionally get their own CI step, deliberately, because they must run against the
job-level connection roles rather than each package's `tests/setup.ts` defaults (turbo's strict
env mode does not pass those through): `usage-service`'s `rls.enforcement.integration.test.ts`
and auth-service's coverage run. That is a *duplicate* of the `pnpm test` run under different
roles, not a replacement for it.

Do not describe these suites as excluded or opt-in. If that ever becomes true, change the
configs and this rule in the same commit.

## Before handoff
Task-scoped lint/typecheck/test/build, then the full root gate across all 13 packages.
Distinguish pre-existing warnings from newly introduced ones and prove it with
`git diff --name-only` / `git log -1 <file>`.
