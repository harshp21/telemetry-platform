---
name: ship
description: Gated delivery pipeline for the telemetry-platform monorepo. Runs a T-xxx epic task through the gates in CLAUDE.md — plan → human approval → implement → review → QA → final review → human commit approval — via the task-planner, task-implementer, senior-reviewer and qa-tester agents. Use when asked to ship, deliver, or pick up a task.
---

# /ship — gated delivery pipeline

Runs a change end-to-end for **telemetry-platform** (pnpm + turbo monorepo · 13 packages ·
TypeScript · Fastify · Prisma · PostgreSQL + RLS · Redis Streams · Vitest). Each gate is owned
by a subagent in `.claude/agents/`; the human owns the two approval gates.

This platform is multi-tenant and security-sensitive — the gates are strict.

## Usage
- `/ship T-036` — task mode; reads the spec from `docs/epics/epic-N-*.md`, artifacts keyed
  by task id.
- `/ship <free-text>` — local mode; artifacts keyed by a short slug.

Argument matching `T-\d+` → task mode, else local mode.

## The gates

| # | Gate | Owner | Artifact |
|---|------|-------|----------|
| 1 | **Plan** | `task-planner` (read-only) | `docs/plans/<slug>.md` |
| 2 | **Human approval — STOP** | user | — |
| 3 | **Implement** | `task-implementer` | code + tests |
| 4 | **Review (pre-QA)** | `senior-reviewer` (read-only) | `docs/reviews/<slug>.md` |
| 5 | **QA** | `qa-tester` | `docs/qa/<slug>.md` |
| 6 | **Review (final)** | `senior-reviewer` (read-only) | appended verdict |
| 7 | **CI validation** | full root gate | verbatim output |
| 8 | **Human commit approval — STOP** | user | one atomic commit |

Gate 4 `CHANGES REQUESTED` → back to 3. Gate 5 `FAIL` → back to 3.

## Rules every gate obeys
- **Never start Gate 3 without explicit approval of the plan at Gate 2.**
- **Never commit, push, or branch.** Gate 8 is the user's. One atomic commit per task,
  including the plan and review artifacts, matching the existing `feat(<service>): … (T-xxx)`
  message style.
- Follow `CLAUDE.md`, `.claude/rules/`, `docs/coding-standards.md`,
  `docs/task-implementer-workflow.md`, and `docs/reviewer-checklist.md`.
- Never bypass tenant isolation. Never interpolate user input into SQL.
- Report failures verbatim. Distinguish pre-existing warnings from newly introduced ones and
  prove the distinction.

## Performance guidance
- Keep each gate scoped to the impacted service; avoid repo-wide exploration unless risk
  demands it.
- Carry artifacts forward between gates (plan path, review findings, QA defects) so nothing
  is rediscovered.
- Aggregate findings into one implementer↔reviewer loop per batch.
- Run the full gate once per implementation cycle, after changes stabilize.

## Artifacts
`docs/plans/` · `docs/reviews/` · `docs/qa/`
