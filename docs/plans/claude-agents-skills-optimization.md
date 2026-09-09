# Plan — optimize `.claude/` agents and skills, and add an epic router

Task: local (no `T-xxx`) · Planner gate · Base: `1b872b3`
Scope: `.claude/agents/`, `.claude/skills/ship/`, `CLAUDE.md` pipeline references.

---

## Approval gate

**Stopped for approval. Nothing under `.claude/` has been modified.**

Three decisions in §6 need answering first; two of them change what gets written.

---

## 1. What the survey found

Read every file under `.claude/` (12 files, 777 lines) plus the parallel `.github/agents/` set,
`docs/epics/README.md`, and one epic file for task structure.

### F-1 · `CLAUDE.md` names a pipeline stage that has no agent

`CLAUDE.md` (Workflow → "The delivery pipeline") states:

    Epic Router → Task Planner → Task Implementer → Senior Reviewer (pre-QA)
      → QA Tester → Senior Reviewer (final) → CI Validation Gate → Commit Approval

and then: *"Each stage is owned by an agent in `.claude/agents/`."* There is no
`.claude/agents/epic-router.md`. `/ship`'s gate table starts at Gate 1 `task-planner`. So the
authoritative file describes an eight-stage pipeline whose first stage does not exist, and the
skill silently starts at stage two.

A Copilot-flavoured router does exist — `.github/agents/epic-router.agent.md`, 38 lines — so the
intent was there and the Claude port was never made.

### F-2 · Task state cannot be read; it has to be derived, and the obvious derivation is wrong

Epic files declare tasks as `## T-0xx · Title` headings with **no status field**. Completion is
only inferable from evidence:

- commit subjects (`git log --oneline --all | grep -oE "T-[0-9]+"`), and
- artifacts in `docs/plans/`, `docs/reviews/`, `docs/qa/`.

**I ran the derivation before proposing it, and it disproved the first version of §3.** Declared
set: 75 ids (73 under the naive pattern — see §9). Evidence set as first drafted (commits + `docs/plans/` + `docs/reviews/` + `docs/qa/`):
37. Three failures in the output:

1. **A plan is not completion.** `T-036` (usage-service integration tests) has
   `docs/plans/t-036-usage-service-integration-tests.md` and **zero** commits
   (`git log --all | grep -c T-036` → `0`). Counting `docs/plans/` as evidence reported the single
   most obvious next task as done. Gate 1 produces a plan; that is the *start* of a task.
2. **Early work carries no task id at all.** `T-001`…`T-005` appear in **zero** commit subjects
   (`grep -cE "T-00[1-5]"` → `0`), yet `shared-config`, `shared-logger`, `shared-tracing`,
   `shared-types` and `shared-validation` all exist, build and test green. Commit-subject evidence
   alone under-reports everything predating the convention.
3. **Evidence exists for undeclared ids.** `T-074` is in the evidence set and no epic declares it.

So a set difference is the wrong shape. The router needs **three signals per task** — declared,
committed, artifact-present — and must classify rather than subtract:

| committed | plan/review | code present | state |
|---|---|---|---|
| yes | any | any | `done` |
| no | yes | no | `planned, not implemented` ← T-036 |
| no | no | yes | `done before the id convention` ← T-001…T-005 |
| no | no | no | `pending` |

and report anything that does not fit as an ambiguity for the user, not a guess.

### F-3 · `senior-reviewer.md:20-22` cites a gap that no longer exists

> Check the DB layer too — and remember a superuser connection makes RLS inert regardless of
> `FORCE ROW LEVEL SECURITY` (`known-gaps.md` S-2).

S-2 was fixed in `b0f6921` and removed from `known-gaps.md`, which now holds S-5, S-6, S-8, S-9,
S-10, S-11, S-12, S-13. The *fact* is still true and worth stating; the citation is dangling. This
is the same defect class the S-7 rounds kept surfacing, in the file that is supposed to catch it.

### F-4 · A re-run of the gate is not independent verification, because turbo caches

`qa-tester.md:18` and `senior-reviewer.md:54-58` both require running the full 13-package gate.
Neither says `--force`. When the reviewer runs `pnpm test` after the implementer just ran it,
turbo returns cached results — the output looks like a green verification and establishes nothing
about the reviewed revision. The round-4 S-7 reviewer noticed this and re-ran with `--force`
unprompted; nothing in the agent definitions asks for it.

### F-5 · No agent is told to verify the change's own prose

Every one of the four S-7 review rounds found a false load-bearing claim, and none of them was a
code defect:

| Round | False claim | Where it lived |
|---|---|---|
| 1 | `BYPASSRLS` is required for the definer | migration comment + `tenant-isolation.md` |
| 2 | `logout-auth.plugin.ts` is *the* JWT trust boundary | `plugins/index.ts` comment |
| 3 | no `ALTER DEFAULT PRIVILEGES` can remove `PUBLIC`'s `EXECUTE` | migration + 2 rule files |
| 4 | the parity assertion catches drift in either direction | `constants.ts` comment |

`senior-reviewer.md:35-41` ("Verify, don't infer") covers the reviewer's *own* assertions. Nothing
asks it to verify the assertions **the change makes** — comments, rule-file edits, plan
dispositions. The four rounds caught them because the orchestrator explicitly asked each time,
which makes the outcome depend on prompt phrasing rather than on the agent definition.

The common shape is narrow-probe generalisation: one observation ("`BYPASSRLS` worked", "widening
the key type errored", four probes that were all `IN SCHEMA`) written up as a general mechanism.

### F-6 · Two divergent copies of the same pipeline

Five agents exist in both `.claude/agents/` and `.github/agents/`, plus `.github/` has the
router, `agent-stage-tracking.instructions.md`, and a 263-line
`enterprise-delivery-flow.instructions.md`. `enterprise-delivery` is 64 lines on the Claude side
and 107 on the Copilot side. Two sources of truth for one pipeline is how F-1 and F-3 happened.
**Scope decision D-2 below.**

### F-7 · `/ship`'s smaller gaps

- Artifacts line lists `docs/plans/` · `docs/reviews/` · `docs/qa/` — `docs/releases/` now exists
  and carried the S-7 deploy procedure.
- No rule for repeat review rounds. S-7 needed four; the artifacts grew ad hoc as
  `-final`, `-final-2`, `-final-3`. Naming should be defined, and there should be a point at
  which looping escalates to the user instead of continuing.
- Gate 4/5 loop-backs are defined; nothing bounds them.

---

## 2. Files to change

| File | Change |
|---|---|
| `.claude/agents/epic-router.md` | **new** — Gate 0 |
| `.claude/agents/senior-reviewer.md` | F-3 citation, F-4 `--force`, F-5 verify-the-change's-claims |
| `.claude/agents/qa-tester.md` | F-4 `--force` |
| `.claude/agents/task-implementer.md` | F-5 — a claim about platform semantics must cite the command that established it |
| `.claude/agents/task-planner.md` | F-5 — same rule for plan assertions; F-2 note on task-state evidence |
| `.claude/agents/enterprise-delivery.md` | F-5 self-review addition; point at the router for stage 0 |
| `.claude/skills/ship/SKILL.md` | Gate 0 row, no-argument mode, F-7 items |
| `CLAUDE.md` | make the pipeline sentence true — name `epic-router`, and `docs/releases/` in artifacts |

No production code, no tests, no migrations. This is configuration and documentation only.

---

## 3. The epic router — proposed contract

`.claude/agents/epic-router.md`, tools `Read, Grep, Glob, Bash` (no `Write` — it reports, it does
not create artifacts), model opus.

**Method**

1. Read `docs/epics/README.md` for dependency order and decision gates.
2. Build the **declared set** with `T-[0-9]+[A-Z]?` — the bare pattern truncates `T-024B` and
   `T-025A`.
3. Classify each declared id on three independent signals, per the table in F-2 — **committed**
   (`git log --oneline --all`), **planned** (`docs/plans/`, `docs/reviews/`, `docs/qa/`), and
   **code present** (the files or package its epic section names). A plan alone is
   `planned, not implemented`, never `done`.
4. Candidates = everything not `done`, in epic dependency order, filtered by unresolved decision
   gates. Prefer a `planned, not implemented` task over a `pending` one — the plan is sunk work
   and may already have been approved.
5. Cross-check the candidate's own prerequisites named in its epic section.
6. Report; **do not** start Gate 1.

**Reports** — active epic · counts per state · candidate task id and title · its state and why it
is next · unresolved decision gates blocking it · ambiguities it refuses to resolve · the open
items in `known-gaps.md` that touch the same service.

Applied to the repo as it stands today, this yields **T-036 · Usage service integration tests**
(epic 6, `planned, not implemented` — plan exists, no commit), with `S-8` in `known-gaps.md`
flagged as the higher-severity alternative if the user prefers to close gaps over advancing epics.

**Refuses to** pick a task whose decision gate is unresolved, or infer completion from a
non-contiguous id range (F-2).

---

## 4. The F-5 addition, concretely

To `senior-reviewer.md`, a new priority-order entry above "Plan alignment":

> **Claims the change itself makes.** Treat every assertion added by the diff — code comments,
> `.claude/rules/` edits, plan dispositions, commit-message claims — as a finding candidate, not
> as context. Re-derive the load-bearing ones by execution. A false claim in `CLAUDE.md` or
> `.claude/rules/` is **HIGH**: those files are designated authoritative and future agents are
> instructed to trust them without re-verification.
>
> Be most suspicious of universals — "X is required", "this is the only …", "no Y can …". Ask
> what would have to be true for the claim to be false, and test *that*. A claim established by
> probes that varied only one dimension is not established.

To `task-implementer.md` and `task-planner.md`, symmetrical:

> A comment or rule-file sentence asserting platform, database, or library semantics must name
> the command that established it, and must have been tested in more than one form before being
> written as general. If you have not run it, write what you observed, not what you concluded.

## 5. Validation

`.claude/` and `.md` only — no build, test, lint or typecheck surface. Validation is:

- Every `file:line` and gap id cited in the new text resolves (`grep` each one).
- The pipeline in `CLAUDE.md`, `/ship`'s gate table, and the agent files agree on stage names.
- The router's derivation commands run and produce the sets §3 claims (run them).
- No agent references a gap id absent from `known-gaps.md`.

## 6. Decisions needed before implementation

- **D-1 · Router autonomy.** Report-and-stop (recommended — choosing what to work on is a human
  call, and F-2 means the derivation is genuinely ambiguous), or auto-hand-off into Gate 1?
- **D-2 · `.github/` scope.** Leave it untouched and note the drift (recommended — unifying two
  agent sets is its own task with its own review), unify now, or delete the Copilot set?
- **D-3 · Loop bound.** Should `/ship` escalate to the user after N review→implement cycles?
  Recommended: yes, N = 2 on the same finding class, because S-7 ran four and each round's
  findings were genuinely new — the rule should catch *repetition*, not depth.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Longer agent definitions cost context on every invocation | F-5 text is ~8 lines per agent; net growth ~60 lines across six files. The router replaces ad-hoc "which task is next" exploration, which costs more. |
| The router's evidence heuristic mis-reports a done task as pending | It reports ambiguity instead of resolving it (F-2), and stops for confirmation under D-1-recommended. |
| Encoding S-7's lessons over-fits to one task | All five additions are general (verify claims, `--force`, cite the command). None mentions S-7 except the S-3/S-2 historical notes already present. |

## 8. Pending checklist

- [done] D-1 report-and-stop · D-2 leave `.github/` and file the drift · D-3 escalate on repetition
- [done] `epic-router.md` written; derivation commands verified against the repo
- [done] F-3 citation corrected — S-2 replaced with the mechanism plus "confirm with `pg_roles`"
- [done] F-4 `--force` in reviewer, QA, enterprise-delivery and the skill
- [done] F-5 added to reviewer (as a required priority-order entry), implementer, planner,
  enterprise-delivery
- [done] `/ship` Gate 0, no-arg mode, `docs/releases/`, round naming, loop bound
- [done] `CLAUDE.md` pipeline sentence made true; plans marked as "started, not finished"
- [done] S-14 filed for the `.github/` drift (D-2)
- [done] §5 validation run — results below

## 9. Validation results

**Gap-id citations.** Every `S-nn` cited in `.claude/` resolves to a live entry in
`known-gaps.md`, except two that are now explicitly marked historical: `S-3` in
`senior-reviewer.md` (already marked) and `S-7` in `tenant-isolation.md` (marked in this change —
it read as live). The dangling `S-2` from F-3 is gone.

**Stage names agree.** `CLAUDE.md`'s pipeline, `/ship`'s gate table and `.claude/agents/` now
name the same five agents, and every agent the skill names has a file. Before this change,
`epic-router` was named by `CLAUDE.md` and had none.

**Router derivation.** Run against the repo: 75 declared ids, and the three-signal
classification correctly separates `T-036` (`planned, not implemented` — plan, zero commits) from
`T-001`…`T-005` (`done before the id convention` — no commit id, packages exist and pass) and
flags `T-074` as evidenced but undeclared. The first draft of the method got `T-036` wrong, which
is why it changed.

**The `--force` claim, tested rather than asserted:**

```
pnpm typecheck            → Tasks: 13 successful · Cached: 13 cached · 57ms  >>> FULL TURBO
pnpm typecheck --force    → Tasks: 13 successful · Cached:  0 cached · 14.192s
```

A plain re-run does no work at all. This is why F-4 is a defect and not a style preference.
Note for honesty: some `13/13` gate results reported during S-7 were likely cache replays for the
same reason — though the round-4 reviewer re-ran with `--force` independently and got the same
numbers, so those specific results stand.

**Self-check on this change's own prose.** Applying F-5 to itself caught one defect before
commit: S-14 asserted `enterprise-delivery.md` was "68 lines" when this change had already made
it 81. Replaced with structural evidence that does not rot. This is the fourth-and-a-half instance
of the same failure mode and the first caught by the rule written to catch it.

## 10. Not done, deliberately

- `.github/agents/` and `.github/instructions/` untouched (D-2) — filed as **S-14**.
- No `docs/qa/` artifact: this change has no build, test, lint or typecheck surface, so there is
  nothing for Gate 5 to validate that §9 does not already cover.
- The loop-bound rule is written into `/ship` but cannot be exercised until a task actually
  loops.
