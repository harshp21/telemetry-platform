---
description: "Use when executing or reviewing multi-stage agent workflows, including Enterprise Delivery and its subagents. Standardizes stage visibility, handoffs, and progress reporting for reviewers."
---
# Agent Stage Tracking Standard

Use this standard whenever an agent workflow spans more than one stage or involves a handoff.

## Required State Values
- `pending`
- `in-progress`
- `blocked`
- `done`

Do not invent alternate state labels.

## Required Stage Tracker Block
Include this block in every user-facing status update:

- Stage Tracker:
  - Current stage: `<stage-name> (<state>)`
  - Previous stage: `<stage-name | none>`
  - Next stage: `<stage-name | none>`
  - Blocker reason: `<none | concise blocker>`
  - Pending tasks snapshot: `<task: state, task: state>`
  - Evidence: `<plan path | changed files | validation output | review findings>`

## Handoff Requirements
When moving to the next stage, include:
- Stage exit criteria met: `yes` or `no`
- Handoff artifact: concise output consumed by the next stage
- Open risks carried forward: `none` or list

## Reviewer-Facing Summary Rule
At the end of each major update, include one concise summary line:
- `Current stage -> Next stage | Why not done yet: <reason or none>`

## Minimum Evidence by Stage
- Planning stages: plan path and pending-task list
- Implementation stage: changed files and validation commands/results
- QA stage: coverage findings and missing-test decision
- Review stage: findings-first summary with severity and disposition
- Approval stage: explicit approval request with remaining risks
