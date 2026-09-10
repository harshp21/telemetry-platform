# Rule — Senior Reviewer Standards (Pre-QA & Final)

The gate a change must clear before it may be committed. Applied by the `senior-reviewer`
agent at Gates 4 and 6.

## Pre-QA Review Checklist

### Compile-Time Validation (REQUIRED GATE)
- Run task-scoped lint, typecheck, build — **no errors allowed**.
- Run full workspace lint, typecheck, build — **no blockers allowed**.
- **Pass `--force`.** turbo caches task results, so a plain re-run after the implementer's own
  run replays their cached output: `pnpm typecheck` reports `13 cached · FULL TURBO` in under a
  second and establishes nothing about the revision under review. `--force` is the difference
  between re-running the gate and reprinting it.
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

### Claims the Change Makes (REQUIRED GATE)
- Treat every assertion the diff **adds** as a finding candidate, not as context: code comments,
  `CLAUDE.md` and `.claude/rules/` edits, plan dispositions, release notes, commit message.
- Re-derive the load-bearing ones **by execution**. A false claim in `CLAUDE.md` or
  `.claude/rules/` is **HIGH** — those files are designated authoritative and other agents are
  instructed to trust them without re-verification. A false claim beside security-relevant code
  is at least MEDIUM; the next person to edit it will believe it.
- Be most suspicious of **universals**: "X is required", "the only place", "no Y can …",
  "catches both directions", "verified". For each, ask what would have to be true for it to be
  false and test *that*. A claim established by probes that varied only one dimension is not
  established.
- Check the change's account of itself: if a plan or commit message says a test was "confirmed
  red", or that a claim was removed from N places, verify the redness and the count.

### Universals Must Cite Their Mutation (REQUIRED GATE)

A claim of the form **"cannot"**, **"only"**, **"never"**, **"unreachable"**, **"impossible"**
or **"unrepresentable"** is a testable assertion. It must name the mutation that establishes
it — the edit you made, and the named test that went red — or it must be weakened to what was
actually measured.

This is not style. Every one of these shipped, was believed by its author, and was refuted by
running the thing it forbade:

| Claim | Refutation |
|---|---|
| the definer role *must* hold `BYPASSRLS` | a `NOBYPASSRLS` role with one targeted policy resolves the same tenant |
| `logout-auth.plugin.ts` is *the* JWT trust boundary | nothing imports it; `/logout` uses `requireJwtAuth` |
| *no* `ALTER DEFAULT PRIVILEGES` can remove `PUBLIC`'s `EXECUTE` | true only of the `IN SCHEMA` form; the database-scoped form works |
| the parity assertion catches drift in *either* direction | it caught one; the other compiled clean |
| the half-fixed cast shape *cannot* be composed outside the module | the cast is SQL text and needs no import |
| producer and consumer *cannot* drift in code | two edits diverged them with the whole gate green |

The pattern is always the same: probes that varied **one** dimension, written up as a general
mechanism. Four `IN SCHEMA` probes. One drift direction. Five header paddings that were all
SP or HTAB.

**So:** ask what would have to be true for the claim to be false, and test *that*. If the
refuting case is expensive to construct, say the claim is unverified rather than asserting it.
"Not importable outside this module (TS2459)" is worth more than "unrepresentable", because it
is true.

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
Security and correctness blockers before style nits. The *Claims the Change Makes* gate is not
in this list because it cuts across all of it — a false claim can be about tenant isolation,
precision, or a test's redness, and takes the severity of whatever it is about:

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
