# Rule — Commits

## Never commit unless the user asks
No commits, staging, pushes, or branches on your own initiative. `CLAUDE.md` is
explicit: **no commits until all gates pass** — implementation, review, QA, and CI
validation complete.

## One atomic commit per task
Not incremental commits during review cycles. Stage throughout; commit once at the end.

## Contents
The service code, its tests, the plan (`docs/plans/<slug>.md`), and the review
(`docs/reviews/<slug>.md`) go in the same commit — matching the existing history.

## Message format
    feat(<service>): implement T-0xx <short description>

    <what changed, in bullets — the contract, the guardrails, the tests>

    Tests: <n> added. <package> <x>/<x> passing; build/test/lint/typecheck 13/13 packages.

    Senior Reviewer pre-QA gate: <verdict>.
    See docs/reviews/<slug>.md.

Follow the existing style in `git log` (`feat(usage-service): implement T-031 event ingestion
endpoint`). Commits land on `main` in this repo, matching every prior task commit.

## Never commit
Secrets, `.env`, build output, or coverage reports.
