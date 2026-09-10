---
name: ship
description: Gated delivery pipeline for the telemetry-platform monorepo. Runs a T-xxx epic task through the gates in CLAUDE.md — pick task, plan, implement, review, QA, final review, CI, commit — via the epic-router, task-planner, task-implementer, senior-reviewer and qa-tester agents. Every transition between gates stops for the user's go-ahead; the plan and the commit are the two they decide substantively. A planner that hits a blocking ambiguity halts and returns the question rather than assuming. Invoke with no argument to have the router propose the next task. Use when asked to ship, deliver, or pick up a task.
---

# /ship — gated delivery pipeline

Runs a change end-to-end for **telemetry-platform** (pnpm + turbo monorepo · 13 packages ·
TypeScript · Fastify · Prisma · PostgreSQL + RLS · Redis Streams · Vitest). Each gate is owned
by a subagent in `.claude/agents/`; the human owns every transition between them, and
decides substantively at Gate 2 (the plan) and Gate 8 (the commit).

This platform is multi-tenant and security-sensitive — the gates are strict.

## Usage
- `/ship` — **no argument**: run Gate 0 only. The router proposes the next task and stops; the
  user confirms before Gate 1. Do not chain into planning on your own.

**A blocking question mid-gate stops the gate.** Subagents cannot prompt the user, so an agent
that hits an ambiguity it must not guess at halts and returns the question. Relay it, get the
answer, and resume that agent with its context intact rather than starting a fresh one.
- `/ship T-036` — task mode; reads the spec from `docs/epics/epic-N-*.md`, artifacts keyed
  by task id. Skips Gate 0 — the user has already chosen.
- `/ship <free-text>` — local mode; artifacts keyed by a short slug. Skips Gate 0.

Argument matching `T-\d+` → task mode; absent → router mode; else local mode.

## The gates

| # | Gate | Owner | Artifact |
|---|------|-------|----------|
| 0 | **Pick task** (no-arg only) | `epic-router` (read-only) | none — reports, then stops |
| 1 | **Plan** | `task-planner` (read-only) | `docs/plans/<slug>.md` |
| 2 | **Plan approval** | user | — |
| 3 | **Implement** | `task-implementer` | code + tests |
| 4 | **Review (pre-QA)** | `senior-reviewer` (read-only) | `docs/reviews/<slug>.md` |
| 5 | **QA** | `qa-tester` | `docs/qa/<slug>.md` |
| 6 | **Review (final)** | `senior-reviewer` (read-only) | appended verdict |
| 7 | **CI validation** | full root gate | verbatim output |
| 8 | **Commit approval** | user | one atomic commit |

**Every transition needs the user's go-ahead — not just 2 and 8.** After each gate, report
what it produced and **stop**. Do not launch the next gate, and do not chain a rework round,
without being told to continue. Gate 2 and Gate 8 are the two where the user is deciding
something substantive; the rest are checkpoints where they may redirect, reorder, skip a gate,
or stop — and cannot if the next agent is already running.

Skipping a gate is the user's call to make explicitly. If you think one is not worth running
— Gate 5 on a change with no production code, say — propose it and give the reason. Never
skip silently.

Gate 4 `CHANGES REQUESTED` → back to 3. Gate 5 `FAIL` → back to 3.

**Repeat rounds.** Re-reviews append to the same `docs/reviews/<slug>.md` under a
`## Round N` heading — do not create `-final`, `-final-2`, `-final-3` files. A reviewer never
edits an earlier round's text: it is that round's record, and correcting it in place hides that
the change once claimed something false.

**When to stop looping.** Depth is fine — four rounds that each find something new is the
pipeline working. Escalate to the user when two consecutive rounds raise the **same finding
class**, which means the loop is not converging. Say what recurred and what you would need to
break the tie; do not open a third round on it.

## Rules every gate obeys
- **Never start a gate without being told to.** Gate 3 without an approved plan is the one that
matters most, but the rule is general: report, stop, wait.
- **Never commit, push, or branch.** Gate 8 is the user's. One atomic commit per task,
  including the plan and review artifacts, matching the existing `feat(<service>): … (T-xxx)`
  message style.
- Follow `CLAUDE.md`, `.claude/rules/`, `docs/coding-standards.md`,
  `docs/task-implementer-workflow.md`, and `docs/reviewer-checklist.md`.
- Never bypass tenant isolation. Never interpolate user input into SQL.
- Report failures verbatim. Distinguish pre-existing warnings from newly introduced ones and
  prove the distinction.
- Gates 4-6 run the workspace gate with `--force`. turbo caches, so a plain re-run replays the
  implementer's output and verifies nothing about the revision under review.
- Every claim a gate *adds* — comment, rule-file edit, plan disposition, commit message — is in
  scope for the next gate to verify. Prose ships unverified unless someone checks it.

## Performance guidance
- Keep each gate scoped to the impacted service; avoid repo-wide exploration unless risk
  demands it.
- Carry artifacts forward between gates (plan path, review findings, QA defects) so nothing
  is rediscovered.
- Aggregate findings into one implementer↔reviewer loop per batch.
- Run the full gate once per implementation cycle, after changes stabilize.

## Artifacts
`docs/plans/` · `docs/reviews/` · `docs/qa/` · `docs/releases/` (when a change needs an ordered
deploy, a migration applied before a config flip, or a documented rollback lever)

A plan in `docs/plans/` marks a task **started**, not finished — Gate 1 writes it before any code
exists. Nothing downstream may read it as evidence of completion.
