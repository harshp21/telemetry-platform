# T-067A Plan: CI pnpm Setup Fix

## 1. Business objective and user impact
- Restore GitHub Actions CI by replacing the failing pnpm setup action with a deterministic Corepack-based pnpm activation flow.
- Unblock all downstream CI checks that are currently skipped before install.

## 2. Scope and non-goals

### In scope
- Update `.github/workflows/ci.yml` to remove the failing pnpm action step.
- Add a shell step that enables and activates the pinned pnpm version via Corepack.
- Preserve the existing Node version and downstream CI command sequence.

### Non-goals
- Changing package manager version.
- Refactoring unrelated CI steps.
- Changing test, lint, build, or Prisma commands.

## 3. Acceptance criteria
- CI no longer depends on `pnpm/action-setup@v4`.
- Workflow activates pnpm 10.0.0 through Corepack.
- Local command validation confirms the setup sequence resolves `pnpm --version` as expected.

## 4. Technical implementation steps
1. Remove `Setup pnpm` action step from CI.
2. Add `Enable pnpm via Corepack` shell step after Node setup.
3. Keep downstream install and validation steps unchanged.
4. Validate the new setup commands locally.

## 5. Validation plan
- Local command validation:
  - `corepack enable`
  - `corepack prepare pnpm@10.0.0 --activate`
  - `pnpm --version`
- Review workflow ordering and resulting git diff.

## 6. Risks and mitigations
- Risk: CI shell environment differs from local behavior.
  - Mitigation: use Node-bundled Corepack with the repo-pinned pnpm version.
- Risk: PATH/activation ordering issue.
  - Mitigation: place Corepack activation immediately after Node setup and before install.

## 7. Pending tasks with state
- [done] Replace pnpm action setup with Corepack activation
- [done] Validate setup commands locally
- [done] Summarize outcomes and request commit approval

## 8. Approval gate
- Implementation approved by follow-up user request after CI failure diagnosis.
