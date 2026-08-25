---
description: "Enterprise Delivery workflow with 8 stages including CI validation and end-of-gates commits. Use for multi-task epics requiring strict quality gates."
---

# Enterprise Delivery Workflow (8 Stages)

## Overview
Complete workflow for implementing epic tasks with quality gates, CI validation, and atomic commits. Changes are staged but **NOT committed** until all gates pass (CI validation + final approval).

---

## Stage Definitions

### **1. Epic Routing**
- **Owner**: Epic Router agent
- **Entry**: No active task selected
- **Exit**: Task ID selected with dependencies checked
- **Handoff**: Selected task ID + scope boundary + gating notes
- **No commits needed**

### **2. Task Planning**
- **Owner**: Task Planner agent
- **Entry**: Task ID from Epic Routing
- **Exit**: Detailed plan written to `docs/plans/<task-id>-<slug>.md`
- **Handoff**: Plan file path + implementation approval request
- **No commits needed**

### **3. Implementation**
- **Owner**: Task Implementer agent
- **Entry**: Explicit user approval of plan
- **Exit**: Code changes complete, task-scoped validations run
- **Key Rule**: Stage changes but DO NOT commit (git add, no git commit)
- **Handoff**: Changed files list + validation output
- **Commits**: ❌ DO NOT COMMIT YET

### **4. Senior Reviewer (Pre-QA)**
- **Owner**: Senior Reviewer agent
- **Entry**: Implementation complete
- **Exit**: Findings-first review, required fixes applied or deferred
- **If issues found**: Apply fixes to staged (uncommitted) changes, re-review
- **Handoff**: Prioritized findings + disposition
- **Commits**: ❌ DO NOT COMMIT YET

### **5. QA Tester**
- **Owner**: QA Tester agent
- **Entry**: Senior Pre-QA Review complete
- **Exit**: Test coverage review with findings
- **Handoff**: QA findings + coverage decision
- **Commits**: ❌ DO NOT COMMIT YET

### **6. Senior Reviewer (Final)**
- **Owner**: Senior Reviewer agent
- **Entry**: QA review complete
- **Exit**: Final sign-off on tested revision
- **Handoff**: Final approval + severity disposition
- **Commits**: ❌ DO NOT COMMIT YET

### **7. CI Validation Gate** ⭐ NEW
- **Owner**: Enterprise Delivery
- **Entry**: All reviews complete, staged changes ready
- **Exit**: CI suite passes (build, test, lint, typecheck)
- **Commands**:
  ```bash
  pnpm build      # Compile all packages
  pnpm test       # Run full test suite
  pnpm lint       # ESLint check
  pnpm typecheck  # TypeScript validation (all 13 packages)
  ```
- **If CI fails**: 
  - Request fixes from Task Implementer
  - Apply fixes to staged changes (NO NEW COMMITS)
  - Re-run CI validation
  - Loop until CI passes
- **Handoff**: CI validation output (all commands passed)
- **Commits**: ❌ DO NOT COMMIT YET

### **8. Commit Approval Gate**
- **Owner**: Enterprise Delivery
- **Entry**: Stages 1-7 complete and passing
- **Exit**: Explicit user approval received
- **Then execute**:
  ```bash
  git add -A
  git commit -m "feat(epic-X): T-YYY task description"
  git push
  ```
- **Handoff**: Commit hash + merged to main
- **Commits**: ✅ COMMIT AND PUSH (one commit per task)

---

## Flow Diagram

```
1. Epic Routing (select task)
   ↓
2. Task Planning (write plan)
   ↓
3. Plan Approval Gate (USER approves plan)
   ↓
4. Implementation (stage changes, NO COMMIT)
   ↓
5. Senior Reviewer Pre-QA (findings + fixes)
   ↓
6. QA Tester (coverage review)
   ↓
7. Senior Reviewer Final (sign-off)
   ↓
8. CI Validation Gate (pnpm build/test/lint/typecheck)
   ├─ If FAIL: Fix → Re-validate CI (loop)
   └─ If PASS: Continue
   ↓
9. Commit Approval Gate (USER approves merge)
   ↓
10. COMMIT & PUSH (one atomic commit)
   ↓
11. Next task
```

---

## Key Benefits

| Benefit | Why It Matters |
|---------|----------------|
| **One commit per task** | Clean git history; atomic changes; easy to trace/revert |
| **CI validation gated** | Catch broken builds before they merge to main |
| **Rollback safety** | Uncommitted changes discarded if review rejects; no revert commits needed |
| **No "fix-up" commits** | All corrections happen before any commit |
| **Shared context** | Staged changes available to all reviewers throughout review cycle |
| **Production safety** | Nothing merges to main unless CI passes + all reviews approved |

---

## Implementation Rules

### During Task Implementation
```bash
# Make changes
# Run task-scoped validation (typecheck, lint, tests for that service)

# Stage ALL changes (don't commit yet!)
git add -A

# Keep working directory clean for next reviewer
# BUT do not run: git commit
```

### During Review Cycles
```bash
# If reviewer requests fixes:
# 1. Apply fixes to already-staged changes
# 2. Stage new fixes: git add -A
# 3. DO NOT commit
# 4. Hand off to next reviewer/validator

# All changes stay staged until end-of-gates
```

### At CI Validation
```bash
# Before commit approval, run full CI:
pnpm build
pnpm test
pnpm lint
pnpm typecheck

# If any fails:
# - Get fixes from Task Implementer
# - Apply to staged changes
# - Re-run CI validation
# - Loop until all pass
```

### At Commit Approval
```bash
# After user approves:
git add -A  # Ensure all staged
git commit -m "feat(epic-X): T-YYY task title

Task description, acceptance criteria met, validation evidence."
git push

# One commit per task, merged to main
```

---

## Stage Tracker Template (Use in Every Update)

```
- Stage Tracker:
  - Current stage: <stage-name> (<state: pending | in-progress | blocked | done>)
  - Previous stage: <name or none>
  - Next stage: <name>
  - Blocker reason: <none or concise reason>
  - Pending tasks snapshot: <item: state, item: state>
  - Evidence: <plan path | changed files | validation output | review findings>
```

---

## Handling Failures

### If CI Fails at Gate 7
1. Identify failing command (build, test, lint, or typecheck)
2. Request fixes from Task Implementer (or owner)
3. Apply fixes to staged changes (git add -A, no git commit)
4. Re-run full CI validation
5. Continue loop until all commands pass
6. Proceed to Commit Approval Gate

### If Review Rejects at Any Gate (1-6)
1. Document findings with severity
2. Request fixes from Task Implementer
3. Apply fixes to staged changes (git add -A, no git commit)
4. Re-submit to reviewer
5. Continue loop until approval
6. Proceed to CI Validation Gate

### If Commit Approval Blocks
1. Address blocker from user
2. Apply changes to staged area if needed
3. Get explicit re-approval
4. Commit and push

---

## Checklist Before Commit

Before proceeding to Commit Approval Gate, verify:

- [ ] All reviews complete (pre-QA, QA, final sign-off)
- [ ] All required fixes applied to staged changes
- [ ] `git status` shows only expected changes (no accidental files)
- [ ] CI validation: `pnpm build` ✅ passes
- [ ] CI validation: `pnpm test` ✅ passes
- [ ] CI validation: `pnpm lint` ✅ passes
- [ ] CI validation: `pnpm typecheck` ✅ passes (all 13 packages)
- [ ] Commit message follows: `feat(epic-X): T-YYY short description`
- [ ] Plan file in `docs/plans/` saved with outcomes
- [ ] User approval obtained for final commit

---

## Glossary

| Term | Definition |
|------|-----------|
| **Staged changes** | `git add -A` run, but `git commit` not run; changes available for next stage |
| **Uncommitted** | Changes staged but not committed; can be discarded without revert commits |
| **Atomic commit** | One commit per task; entire task delivered in one git commit |
| **CI Suite** | Full build, test, lint, and typecheck across all 13 packages |
| **Gate** | Quality checkpoint (review, QA, CI, approval) that must pass before proceeding |
| **Handoff artifact** | Output from one stage consumed as input to next stage |

---

## References

- [agent-stage-tracking.instructions.md](./agent-stage-tracking.instructions.md) — Stage tracking standard for all updates
- [../.github/copilot-instructions.md](../.github/copilot-instructions.md) — Project-wide guidelines
- [../docs/contributing-guide.md](../docs/contributing-guide.md) — Contribution standards
