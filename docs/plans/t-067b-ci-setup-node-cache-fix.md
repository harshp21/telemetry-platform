# T-067B Plan: CI Setup-Node Cache Fix

## 1. Business objective and user impact
- Unblock GitHub Actions by removing the `setup-node` pnpm cache coupling that fails before Corepack-based pnpm activation can run.
- Allow the CI workflow to progress into install, Prisma, and test stages.

## 2. Scope and non-goals

### In scope
- Update `.github/workflows/ci.yml` to remove `cache: pnpm` from `actions/setup-node`.
- Keep the Corepack activation step and all downstream CI commands unchanged.

### Non-goals
- Reworking caching strategy beyond this unblock.
- Changing package versions, Prisma commands, or validation stages.

## 3. Acceptance criteria
- `Setup Node` no longer depends on pnpm caching.
- Workflow YAML remains valid.
- Corepack activation remains the next step after Node setup.

## 4. Technical implementation steps
1. Remove `cache: pnpm` from `actions/setup-node@v4`.
2. Validate the workflow file parses as YAML.
3. Review the diff to confirm no unintended CI changes.

## 5. Validation plan
- Parse `.github/workflows/ci.yml` as YAML.
- Review targeted workflow diff.

## 6. Risks and mitigations
- Risk: losing pnpm cache efficiency.
  - Mitigation: restore caching later with a setup sequence compatible with Corepack.
- Risk: hidden downstream CI failures after unblocking setup.
  - Mitigation: let GitHub Actions rerun and observe the next failing stage, if any.

## 7. Pending tasks with state
- [done] Remove pnpm cache from setup-node
- [done] Validate workflow YAML parses successfully
- [done] Review targeted diff and request commit approval

## 8. Approval gate
- Implementation approved by explicit follow-up user request after CI failure diagnosis.
