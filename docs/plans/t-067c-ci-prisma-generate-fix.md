# T-067C Plan: CI Prisma Client Generate Fix (Auth Coverage)

## 1. Business objective and user impact
- Unblock the auth coverage step in CI by guaranteeing Prisma Client generation occurs in a package context where `@prisma/client` is resolvable.
- Prevent CI-only failures where auth integration tests fail with missing `.prisma/client/default` during fresh installs.

## 2. Scope and non-goals

### In scope
- Add a deterministic Prisma generate step in `.github/workflows/ci.yml` before auth coverage.
- Generate from an auth-service-local schema copy so Prisma resolves `@prisma/client` from `apps/auth-service`.
- Keep existing migrate deploy/status and coverage commands unchanged.

### Non-goals
- Changing Prisma schema or migrations.
- Refactoring auth tests or app code.
- Reworking workspace dependency topology.

## 3. Acceptance criteria
- Clean-clone CI-sequence reproduction passes `test:coverage` for `@telemetry/auth-service`.
- Prisma generate step succeeds without attempting auto-install in the wrong workspace root context.
- Existing migrate deploy/status and coverage commands remain valid.

## 4. Technical implementation steps
1. Insert a CI step after migration checks that:
  - copies `prisma/schema.prisma` to `apps/auth-service/schema.ci.prisma`
  - runs `pnpm --filter @telemetry/auth-service exec prisma generate --schema=./schema.ci.prisma`
2. Keep existing auth coverage command unchanged.
3. Validate in clean-clone repro and targeted local run.

## 5. Validation plan
- Clean-clone repro with CI-like env vars, install, migrations, generate step, and auth coverage.
- Confirm generated output targets the shared pnpm store path for `@prisma/client` and coverage passes.
- Review workflow diff only.

## 6. Risks and mitigations
- Risk: temporary schema copy could be brittle if file paths change.
  - Mitigation: keep copy path explicit and colocated with auth-service command context.
- Risk: stale copied schema could linger in CI workspace.
  - Mitigation: recreate it each run before generate.

## 7. Pending tasks with state
- [done] Reproduce failing auth coverage in clean clone
- [done] Prove deterministic generate strategy from auth-service-local schema copy
- [done] Patch `.github/workflows/ci.yml` with validated generate step
- [done] Run targeted local validation for generate command path
- [done] Attempt auth coverage validation (blocked locally by missing Postgres at localhost:5432)
- [pending] Summarize results and request commit approval

## 8. Approval gate
- Implementation approved and applied; awaiting user approval for commit/push.
