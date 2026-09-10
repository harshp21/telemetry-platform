# CLAUDE.md — Telemetry Platform

Guidance for Claude Code sessions in this repository. Read before making changes.

This file and `.claude/` are the authoritative standards for Claude Code. Supporting detail
lives in `docs/`.

---

## Project Overview

A multi-tenant SaaS telemetry/usage-metering platform. pnpm workspace + turbo monorepo,
**13 packages**, TypeScript throughout (strict), ESM.

- **7 apps**: `gateway`, `auth-service`, `usage-service`, `worker-service`,
  `billing-service`, `analytics-service`, `web`
- **7 shared packages**: `sdk`, `shared-config`, `shared-logger`, `shared-tracing`,
  `shared-types`, `shared-utils`, `shared-validation`
- **Stack**: Fastify · Prisma (single root `prisma/schema.prisma`) · PostgreSQL + RLS ·
  Redis Streams · Zod · Vitest · OpenTelemetry
- **Layered architecture**: Routes → Controllers → Services → Repositories
- **Tenant isolation is three layers**: gateway strips and re-injects `X-Tenant-Id` from
  verified JWT context → `tenant-context.middleware` → tenant-scoped repository +
  PostgreSQL RLS

---

## Important Commands

```bash
pnpm install

pnpm dev                 # turbo run dev --parallel
pnpm build               # turbo run build          (13 packages)
pnpm test                # turbo run test           (13 packages)
pnpm lint                # turbo run lint
pnpm typecheck           # turbo run typecheck
pnpm format:check        # prettier --check .

# Scope to one package (always prefer this while iterating)
pnpm --filter @telemetry/<service> test
pnpm --filter @telemetry/<service> lint
pnpm --filter @telemetry/<service> typecheck
pnpm --filter @telemetry/<service> build

pnpm test:smoke          # smoke suites across the 6 services
```

**Note:** `pnpm --filter <pkg> test -- <file>` does **not** filter to that file — vitest runs
the whole package suite. Use `pnpm --filter <pkg> exec vitest run <file>` to actually scope it.

---

## Workflow

- Work **one epic task at a time**; keep changes scoped to a single completed slice.
- Show a detailed execution plan before substantive changes.
- Create or update a plan file in `docs/plans/` before requesting implementation approval.
- Keep a visible pending-task list and update it as work progresses.
- **Ask for approval at every stage transition**, not only before implementation. Report what
  the stage produced, then stop. The user may redirect, reorder or skip a stage — and cannot
  once the next one is running.
- **Planning questions get asked during planning.** If different readings of an ambiguity would
  produce materially different plans, stop and ask before writing the plan around one of them.
  A decision list at the end of a finished plan is too late: the plan already assumed an
  answer.
- **NO commits until all gates pass** — implementation, reviews, QA, CI validation.
- Ask for approval before the final commit/push once all gates are satisfied.

### The delivery pipeline

    Epic Router → Task Planner → Task Implementer → Senior Reviewer (pre-QA)
      → QA Tester → Senior Reviewer (final) → CI Validation Gate → Commit Approval

Each stage is owned by an agent in `.claude/agents/` — `epic-router`, `task-planner`,
`task-implementer`, `senior-reviewer` (both review gates) and `qa-tester`. Run it with
**`/ship <task-id>`**, or **`/ship`** with no argument to have `epic-router` derive and propose
the next task and stop for confirmation.

Two hard rules:

1. **No implementation without an approved plan.** Every task gets a `docs/plans/<task>.md`
   ending in an approval gate statement. The user approves before any code is written.
2. **No commits until all gates pass.** Stage during implementation; one atomic commit per
   task, and only when the user says so.

Artifacts: `docs/plans/` · `docs/reviews/` · `docs/qa/` · `docs/releases/` (ordered deploys,
rollback levers). A plan marks a task **started**, not finished — Gate 1 writes it before any
code exists, so nothing may read `docs/plans/` as evidence of completion.

---

## Engineering Standards

- Strict TypeScript with explicit types. Avoid deprecated APIs.
- Avoid `any`; avoid `unknown` unless the boundary justifies it and the reason is explicit.
- Reuse service constants instead of magic literals.
- Fix root causes rather than patching symptoms.
- Thin controllers; service and repository layers; Zod validation for inputs and environment;
  dependency injection via the container.

## Implementation Methodology — Pseudo-TDD

From T-019 onwards, every epic task:

1. Write the test file with **all** scenarios from the plan **before** implementing.
2. Implement to pass the tests: controller → service → repository.
3. Refactor only **after** all tests pass.
4. Validate: typecheck, lint, tests.

Full pattern and worked examples: `docs/task-implementer-workflow.md`.

## Validation

- Run the narrowest useful validation immediately after the first substantive edit.
- Prefer task-scoped lint/typecheck/test over broad repo commands while iterating.
- For Prisma changes, keep schema and migration files aligned.
- **CI validation gate** before commit approval: `pnpm build`, `pnpm test`, `pnpm lint`,
  `pnpm typecheck` across all 13 packages.

## Commit & CI

- Stage all changes during implementation; **do not commit** until review/QA gates pass and
  CI validation succeeds.
- **One atomic commit per task** — not incremental commits during review cycles.
- If CI fails: fix on the staged (uncommitted) changes, re-validate, then commit.
- Uncommitted work can be discarded if a gate requests major revisions — no commit reverts.

## Token Discipline

- Read the smallest local surface that can prove or disprove the current hypothesis.
- Prefer owning files, nearest tests, and direct call sites over broad repo exploration.
- At plan approval, give detailed scope, steps, validations, risks, and pending tasks.
- Do not restate unchanged plans or long summaries.
- Concise output: findings first, then risks, then next action.

---

## Standards Reference

| Concern | File |
|---|---|
| Reviewer standards, clean-code gate | `.claude/rules/review-standards.md` |
| Tenant isolation invariants | `.claude/rules/tenant-isolation.md` |
| **Open security & correctness gaps** | `.claude/rules/known-gaps.md` |
| Constants / no magic literals | `.claude/rules/constants.md` |
| Testing bar | `.claude/rules/testing.md` |
| Commit rules | `.claude/rules/git-commit.md` |
| Pseudo-TDD workflow detail | `docs/task-implementer-workflow.md` |
| Code conventions | `docs/coding-standards.md` |
| Service review checklist | `docs/reviewer-checklist.md` |
| Repo ownership / layout | `docs/folder-structure.md` |
| Task hygiene | `docs/contributing-guide.md` |
| Per-epic task specs | `docs/epics/epic-N-*.md` |

---

## Areas Where Extra Caution Is Needed

### Tenant isolation
Every tenant-scoped query goes through `TenantScopedRepository` (`withTenant`, which issues
`set_config('app.tenant_id', …, true)`) **and** carries an explicit `tenantId` predicate.
The tenant id derives from the repository's own bound context — never from a caller-supplied
value. Never write a query that omits the tenant filter; never bypass the middleware.

Tenant-scoped repositories are **per-request by construction** (`tenantId` is a constructor
argument). Register them in the container as a *factory*, never a singleton — a singleton
pins one tenant process-wide.

RLS **is** enforcing: services connect as `telemetry_app` (`NOSUPERUSER`, `NOBYPASSRLS`,
owns no table), created by `prisma/migrations/v1_4_app_role_non_superuser`. Note that
`FORCE ROW LEVEL SECURITY` is *not* what does this — it only removes the table owner's
exemption and does nothing to a superuser. Migrations run separately as the owner through
`DIRECT_DATABASE_URL` (Prisma `directUrl`); never point a running service at it.

auth-service connects as `telemetry_auth_app` — a second least-privilege role holding **less**
than `telemetry_app`: DML on `"Tenant"`, `"User"` and `"RefreshToken"` only, and no default
grant, so a future table must be granted deliberately. It exists so that `EXECUTE` on its two
pre-auth resolvers can be granted to auth-service alone. Those lookups — login, the
duplicate-email check, refresh rotation — go through narrow `SECURITY DEFINER` functions
(`prisma/migrations/v1_5_auth_tenant_resolvers`) that return the **tenant id only**; the
credentials come back through an ordinary policy-enforced read. The functions' owner is
`NOBYPASSRLS` and reads past the tenant policy through two targeted `FOR SELECT` policies, not
through a role attribute. Do not treat a passing RLS test as evidence unless it runs as a
`NOSUPERUSER NOBYPASSRLS` role. Full detail: `.claude/rules/tenant-isolation.md`.

### Raw SQL
Raw queries use `Prisma.sql` tagged templates. Anything caller-supplied must be a bound
parameter. Enum-like SQL variation (e.g. `DATE_TRUNC` granularity) must be a key lookup into
a frozen map of constant `Prisma.sql` fragments — never string interpolation, never
`Prisma.raw` on user input.

#### Raw SQL and timestamps (S-18)

**Never bind a JS `Date` into `$queryRaw` to compare against a timestamp column.** Normalize
to UTC in JS and cast: `${new Date(iso).toISOString()}::timestamp(3)`. Or use the ORM.

Each claim below with the command that established it, each tested in more than one form.

- **A bound JS `Date` is `timestamptz`.** `SELECT pg_typeof(${new Date(...)})::text` →
  `timestamp with time zone`; a bound ISO string → `text`; the same string cast →
  `timestamp without time zone`. Compared against a naive column the comparison then resolves
  through the **session** `TimeZone`, not UTC. Six `UsageLine` rows, one window
  (`2026-01-01Z` → `2026-02-01Z`), one predicate, four session zones via
  `options=-c timezone=…`: `UTC` → `{r2,r3,r4,r5}`, `Asia/Kolkata` → `{r4,r5,r6}`,
  `America/New_York` → `{r1,r2,r3,r4}`, `Asia/Kathmandu` (+05:45) → `{r4,r5,r6}`.
- **Prisma's ORM path is safe** — `where: { periodStart: { gte, lt } }` returned
  `{r2,r3,r4,r5}` under all four zones, both inside and outside `$transaction`, and the query
  log shows the bound already UTC-normalized (`"2026-01-01 00:00:00 UTC"`). That behaviour is
  what was measured, and it is what the guidance rests on. *Why* it differs from `$queryRaw`
  is **inference, not measurement**: the logged parameter form suggests the engine resolves
  the bound against the column type it has from the schema. Do not restate the mechanism as
  fact. Prefer the ORM for date ranges; where raw SQL is required, coerce the bound explicitly.
- **A text → `timestamp` cast discards an offset, it does not convert it.** Under
  `TimeZone='Asia/Kolkata'`: `'…T00:00:00.000Z'::timestamp(3)`, `'…+05:30'::timestamp(3)` and
  `'…-08:00'::timestamp(3)` all render `2026-01-01 00:00:00` — three different instants, one
  value. Offsets are legal input (`iso8601Schema` is `z.string().datetime({ offset: true })`),
  so casting the raw request string trades a session-dependent bug for an offset-dependent
  one that no `Z`-only fixture catches. `new Date(x).toISOString()` **first**, then cast.
- **Omitting the cast fails loudly, so it is the safe mistake**: Prisma binds an ISO string as
  `text` (`SELECT pg_typeof(${iso})::text` → `text`), and an uncast bound string raises
  `42883`, surfaced by Prisma as `P2010` with `meta.code = "42883"`. The message names the
  operands **in the order they appear in the SQL**, so for a `"periodStart" >= $1` predicate it
  reads `operator does not exist: timestamp without time zone >= text`; write the bound on the
  left and the same error reads `text <= timestamp without time zone`. Measured in four forms:
  `$queryRaw` in both operand orders, and `psql` with `'…'::text` and with `PREPARE p(text)`.
  Caveat: an *unquoted* SQL literal does **not** error — it is `unknown`-typed and coerces — so
  the loudness comes from the bind being `text`, not from the cast being absent.
- **All 20 application timestamp columns are naive** — `timestamp(3) without time zone`, no
  `@db.Timestamptz` anywhere in `prisma/schema.prisma` (`information_schema.columns` over
  `table_schema='public'`; the only `timestamptz` columns belong to `_prisma_migrations`). So
  this applies to every one of them. **Equality fails worse than a range**: same rows,
  `WHERE "periodStart" = $1` with a bound `Date` matched the right row under `UTC`, **no row**
  under `Asia/Kolkata`, and **the wrong row** under `America/New_York` — which matters for
  `Invoice @@unique([tenantId, periodStart, periodEnd])` and `Meter`'s `activeFrom` key.
- **The output side is fine, and must be left alone.** `DATE_TRUNC` over a naive column
  returned the same instant under every zone tested. `AT TIME ZONE 'UTC'` on a bound
  *parameter* is correct and equivalent to the cast; on the *column* it produces a
  `timestamptz` and shifts every bucket boundary by the server offset. Fix the bound.
- **CI cannot catch any of this.** `postgres:16-alpine` defaults `TimeZone` to `UTC`
  (`docker exec … psql -Atc "show timezone"` → `UTC`, source `configuration file`), where the
  broken and correct predicates are identical. A regression test must pin its own non-UTC
  session or it asserts nothing. Use `options=-c timezone=…`; a bare `?timezone=…` is accepted
  and silently ignored.

usage-service additionally pins `set_config('TimeZone','UTC',true)` inside `withTenant`
(`apps/usage-service/src/repositories/base.repository.ts`) as a second layer. It covers
queries **inside** `withTenant` only, and only in that service — the other four copies of
`TenantScopedRepository` do not have it.

### Constants
No magic strings or numbers in controllers, routes, middleware, or entrypoints — route
paths, header names, HTTP status codes, error codes and messages, service names all live in
`constants.ts` or a service-local constants module. This is a **required review gate**, not
a style preference. See `.claude/rules/constants.md`.

### Startup ordering
`index.ts` stays a thin entrypoint; wiring lives in `app.ts`. Tracing initializes first —
keep startup constants in a side-effect-free `startup.constants.ts` so nothing heavy is
imported before `initTracing(...)`.

### Prisma
One schema at `prisma/schema.prisma` for the whole monorepo. Schema and migrations stay
aligned; migrations are forward-only. Decimal columns (`Decimal(18,6)`) exceed IEEE-754 safe
precision — normalize to string in exactly one layer and never let `Prisma.Decimal` reach a
JSON response.

---

## Instructions for AI Coding Agents

1. **Read the task's plan and epic spec first.** Epic specs are shorthand and are sometimes
   wrong about the implementation — verify against the code before writing assertions.
2. **Tests before code** for epic tasks.
3. **Run the narrowest useful validation** right after the first substantive edit; full gate
   only once changes stabilize.
4. **Never commit, push, or branch** unless the user explicitly asks.
5. **Preserve existing architecture** — mirror the neighbouring service's naming, error
   shapes, DI registration, and test style rather than introducing new patterns.
6. **Distinguish pre-existing warnings from ones you introduced**, and prove it with
   `git diff --name-only` / `git log -1 <file>`.
7. **Report failures honestly** — verbatim output, not summaries that round up to green.
8. **When in doubt, ask.** This system has multi-tenant security implications.
