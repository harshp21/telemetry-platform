# Rule — Senior Reviewer Standards (Pre-QA & Final)

The gate a change must clear before it may be committed. Applied by the `senior-reviewer`
agent at Gates 4 and 6.

## Pre-QA Review Checklist

### Compile-Time Validation (REQUIRED GATE)
- Run task-scoped lint, typecheck, build — **no errors allowed**.
- Run full workspace lint, typecheck, build — **no blockers allowed**.
- Report status for **all 13 packages** on every review.
- Classify pre-existing warnings as pre-existing and **prove it** with
  `git diff --name-only` / `git log -1 <file>`. Never let a pre-existing warning be counted
  against the change, and never let a new one be waved through as pre-existing.

### Clean Code Practices (REQUIRED GATE)
- **No magic strings** — literals must use constants.
- **No magic numbers** — status codes, retries, timeouts, limits from constants.
- **DRY** — no duplicate definitions across constants, validators, and repositories.
- All error codes and messages in `constants.ts` or a service-local constants module.
- Report findings-first: each violation as **BLOCKER / HIGH / MEDIUM / LOW / NIT** with an
  explicit disposition.

### Code Correctness
- Bug detection and regression-risk assessment.
- Type safety and boundary violations.
- Security vulnerabilities and injection risks.

### Production Readiness
- Error-handling contract verification.
- Middleware ordering and execution flow.
- Logging / observability adequacy.
- Performance overhead, including index coverage for new query paths.

## Final Review Checklist (Post-QA)
- **All Pre-QA checks**, repeated on the tested revision.
- **Test coverage alignment** — tests match implementation; no orphaned code, no untested
  logic; all error paths tested.
- **Release readiness** — acceptance criteria 100% satisfied; no regressions in related
  services; breaking-change assessment across the other 12 packages.
- **Approval gate** — explicit sign-off: `APPROVED FOR COMMIT`, or `CONDITIONAL` with the
  required fixes. List remaining risks and their dispositions.

## Review priority order
Security and correctness blockers before style nits:

1. Tenant isolation and RLS
2. Injection risk in raw SQL
3. Correctness — boundaries, precision, pagination maths, error contracts
4. Clean code gate
5. Type safety
6. Production readiness
7. Test honesty — do tests assert behaviour, or echo their own mocks?
8. Plan alignment and scope creep

## Conduct
Read-only. Report fixes with `file:line` and a concrete change; never apply them. Findings
first, no approval boilerplate. State what you verified **and what you could not verify, and
why**. A review that finds nothing is only useful if it can say precisely what was checked.
