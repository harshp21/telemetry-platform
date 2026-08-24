# T-067 Plan: Database Migration CI Drift Check

## 1. Business objective and user impact
- Prevent schema drift by failing CI when Prisma schema changes are not reflected in migrations.
- Catch migration hygiene issues before merge/deploy rather than during runtime.

## 2. Scope and non-goals

### In scope
- Update CI workflow to run Prisma migration status verification in a deterministic step.
- Ensure check runs against CI Postgres service with explicit schema path.
- Keep existing auth coverage and repo validation flow intact.

### Non-goals
- Editing Prisma schema or generating new migration files.
- Changing migration naming/history in this task.
- Refactoring unrelated CI jobs.

## 3. Acceptance criteria
- CI contains a migration drift check step that runs after install and before broad validation.
- Step fails when migrations are pending or schema/migration state is inconsistent.
- Existing CI tasks remain functional:
  - auth coverage
  - lint
  - typecheck
  - tests
  - build

## 4. Technical implementation steps
1. Add a dedicated CI step in `.github/workflows/ci.yml` for migration status.
2. Run Prisma migration commands from a package that has Prisma CLI available.
3. Use explicit `--schema=./prisma/schema.prisma` path for both deploy and status.
4. Preserve current database env and service lifecycle assumptions.
5. Validate workflow syntax and run targeted repo checks where feasible.

## 5. Validation plan
- Local YAML sanity check by reviewing workflow structure.
- Run narrow validation command(s) touching workflow-related assumptions.
- Confirm no unintended changes outside CI workflow.

## 6. Risks and mitigations
- Risk: introducing redundant or conflicting migration steps.
  - Mitigation: keep one clear migration-deploy step and one explicit status-check step.
- Risk: path/context mismatch for Prisma CLI in CI.
  - Mitigation: use same command pattern as existing working Prisma step with explicit schema path.
- Risk: increased CI runtime.
  - Mitigation: keep check lightweight and colocated near install/setup.

## 7. Pending tasks with state
- [done] Add migration status check step to CI workflow
- [done] Verify CI workflow ordering and command correctness
- [done] Run targeted validations
- [done] Summarize outcomes and request commit approval

## 8. Approval gate
- Implementation starts only after explicit user approval.
