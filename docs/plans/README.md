# Plans Directory

This folder stores implementation plans that must be reviewed and approved before coding begins.

## Naming

- Use one file per task slice.
- File name format: `t-<task-id>-<short-slug>.md`
- Example: `t-019-login-endpoint.md`

## Minimum required sections

1. Business objective and user impact
2. Scope and non-goals
3. Acceptance criteria
4. Technical implementation steps
5. Validation plan
6. Risks and mitigations
7. Pending tasks with state
8. Approval gate

## Workflow

1. Create/update plan file in this folder.
2. Present plan for explicit approve/reject decision.
3. Start implementation only after approval.
4. Run Senior Reviewer pre-QA review and apply required fixes.
5. Run QA validation on the updated revision.
6. Run Senior Reviewer final sign-off on the exact tested revision.
7. Request explicit approval before commit/push.