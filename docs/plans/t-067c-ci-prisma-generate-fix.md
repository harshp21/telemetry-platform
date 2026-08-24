# T-067C Plan: CI Prisma Client Generate Fix

## 1. Business objective and user impact
- Unblock the auth coverage step in CI by ensuring Prisma build scripts are allowed during fresh installs.
- Remove reliance on a follow-up `prisma generate` workaround that fails under the current workspace layout.

## 2. Scope and non-goals

### In scope
- Update root `package.json` so pnpm allows Prisma build scripts during install.
- Remove the temporary explicit `prisma generate` step from `.github/workflows/ci.yml`.
- Keep existing migration and coverage commands otherwise unchanged.

### Non-goals
- Changing Prisma schema or migrations.
- Refactoring auth tests or app code.
- Reworking package-manager build script policy.

## 3. Acceptance criteria
- Fresh-install reproduction confirms `@prisma/client` exports `PrismaClient` after install.
- CI no longer depends on the explicit `prisma generate` workaround.
- Existing Prisma migrate and auth coverage commands remain valid.

## 4. Technical implementation steps
1. Add a root `pnpm.onlyBuiltDependencies` allowlist for Prisma packages.
2. Remove the explicit `Prisma Generate Client` CI step.
3. Validate in a clean install repro that `require('@prisma/client').PrismaClient` becomes available after install.

## 5. Validation plan
- Clean-copy install repro without existing node_modules.
- Verify `@prisma/client` exports `PrismaClient` after install.
- Review targeted workflow and package diff.

## 6. Risks and mitigations
- Risk: allowing Prisma build scripts is broader than a one-off generate command.
  - Mitigation: restrict the allowlist to the minimal Prisma packages only.
- Risk: hidden follow-up build script gaps for other packages.
  - Mitigation: keep the change scoped and review CI again after rerun.

## 7. Pending tasks with state
- [done] Allow Prisma build scripts during pnpm install
- [done] Remove explicit Prisma generate CI step
- [done] Validate fresh-install Prisma client availability after install
- [done] Summarize outcomes and request commit approval

## 8. Approval gate
- Implementation follows from user-requested CI failure debugging and confirmed root cause reproduction.
