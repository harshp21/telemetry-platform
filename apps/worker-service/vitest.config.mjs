import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // **The process time zone, pinned non-UTC deliberately (T-042, answering Gate 5's F-1).**
    //
    // `getPreviousDayRange` (`src/jobs/invoice-generation.job.ts`) must compute the previous
    // *UTC* calendar day. The wrong form -- `new Date(y, m, d)`, which is local midnight --
    // produces the correct answer when the process zone is UTC and a shifted one everywhere
    // else, so `J1`-`J5` can distinguish the two implementations **only** when the runner's zone
    // is not UTC. Nothing pinned it before this line: the suite inherited the ambient zone, and
    // Gate-5 QA measured that mutation at `6 failed | 5 passed (11)` on this UTC+5:30 host
    // against `11 passed (11)` under `TZ=UTC` -- their numbers, on the 11-case pre-`J12` file,
    // not re-derived here because removing this pin to reproduce them would also redden `J12`.
    // What *was* re-derived here is the half that matters: under this pin the same mutation is
    // `Tests 6 failed | 6 passed (12)` -- `J1`-`J6` -- identically with `TZ` unset and with an
    // outer `TZ=UTC`. `grep -n "TZ\|timezone" .github/workflows/ci.yml` returns
    // nothing and neither did `tests/setup.ts`, so on a UTC runner the guard was inert on
    // exactly the machine that gates the repository. That is the S-21 shape.
    // `tests/integration.constants.ts` already solves the same problem for the *session* zone by
    // pinning `options=-c timezone=...` on its connections; this is the JavaScript half.
    //
    // `J12` asserts this pin is in effect, reading this file at runtime as `U50` reads
    // `testTimeout`, so deleting the line fails loudly instead of quietly restoring the inert
    // state.
    //
    // **Why `Asia/Kathmandu` specifically**, rather than any non-UTC zone:
    // - +05:45 is neither a whole hour nor a half hour from UTC, so an implementation that
    //   happened to agree with the right answer modulo an hour, or modulo half an hour, still
    //   differs here. That is margin, not a demonstrated property: no mutation in this suite
    //   exercises that class, which is why `J12` deliberately does not assert it.
    //   `CLAUDE.md`'s S-18 record carries this zone as one of its four probe zones and notes the
    //   `+05:45` offset; it does not state this rationale, which is mine.
    // - No DST, so the offset does not depend on which instant a case picks. Measured on Node
    //   22.22.2: `Asia/Kathmandu` reports `-345` for all twelve months of 2026, where
    //   `America/New_York` reports `300` and `240`.
    // - Different from this host's ambient zone (`Asia/Calcutta`, `-330`) **and** from both
    //   session-zone pins in `tests/integration.constants.ts` (`Asia/Kolkata` for the
    //   enumeration suite, `America/New_York` for the processor suite). So a case cannot pass
    //   because the process zone happened to equal the connection zone, and a pin that silently
    //   stopped being applied changes observable behaviour *here*, not only on CI -- which is
    //   the failure this whole block exists to stop repeating one level up.
    //
    // The two layers are independent, and `I-TZ1` is what establishes it rather than a separate
    // probe: `options=-c timezone=` is per-connection, and that case reads `SHOW timezone` off
    // both of its connections and asserts `UTC` and `Asia/Kolkata` before comparing anything.
    // It passes under this pin, so the process zone does not reach the session zone.
    //
    // One caveat for anyone asserting on the zone *name*: Node 22.22.2's
    // `Intl.DateTimeFormat().resolvedOptions().timeZone` reports the alias `Asia/Katmandu` for
    // this value. `J12` asserts the offset.
    env: {
      TZ: "Asia/Kathmandu"
    },
    // Declared rather than inherited (T-040/S1). vitest's default is already 5 000 ms, so this
    // changes no behaviour — what it changes is that the budget every deadline in this
    // package is sized against is now *stated* in one place instead of being a property of the
    // runner that three separate comments had to assert from memory. Two prior fixes lowered a
    // deadline that had silently exceeded it (`RUN_DEADLINE_MS` 10 000 -> 3 000 at a Gate-4
    // review, `BLOCK_MS_LONG` 5 000 -> 3 000 at a Gate-5 QA finding).
    //
    // Kept in step with `tests/integration.constants.ts`' `CASE_BUDGET_MS` by `U50`, which
    // imports this file at runtime and compares the two. Changing this number without
    // changing that constant turns the suite red.
    testTimeout: 5_000,
    // Test *files* run one at a time (T-040). Not a performance knob and not caution: this
    // package now has **two** live-Redis suites, and worker-service's reservation is one
    // logical database for the whole service (index 14, `INTEGRATION_REDIS.LOGICAL_DB_INDEX`),
    // not one per file. Both suites issue `FLUSHDB` against it in `afterEach`/`afterAll`, so
    // under vitest's default per-file parallelism one suite's teardown deletes the other's
    // stream mid-case. The case that dies is **usually** T-039's `I8`, with
    // `NOGROUP No such key 'telemetry:events:t039:<pid>-<ts>-N'` -- but not always, and the
    // exception is the dangerous one. In 14 parallel runs at the Gate-6 review, 10 failed and
    // the tenth was **`I9`**, not `I8`:
    //
    //   I9 - neither the loop nor recovery ever delivers the pre-group backlog
    //   AssertionError: expected [] to deeply equal [ '1789368476068-2' ]
    //
    // No `NOGROUP`, no key named: the same collision producing a **silently wrong result**
    // instead of a loud error. Do not diagnose this by looking for `NOGROUP` -- a reader who
    // does will take that `I9` failure for a T-039 loop bug. An earlier revision of this
    // comment said `I8` dies "always" with `NOGROUP`; four observers had seen only that shape
    // across ~24 runs, which is how a signature gets written up as a universal.
    //
    // **The collision is structural; the failure rate is not, and the two should not be
    // confused.** The mechanism fires whenever the two files overlap in wall-clock time, which
    // is scheduling- and load-dependent. Observed rates, each with the setting commented out
    // and the package otherwise unchanged:
    //
    //   Gate 3, first encounter            1 of 3 runs failed
    //   Gate 3 rework, 10 consecutive runs 3 of 10 failed   (green runs 1.87-1.99 s)
    //   Gate-4 reviewer, 5 consecutive     5 of 5 failed
    //   Gate-5 QA, 6 consecutive           3 of 6 failed
    //   Gate-6 reviewer, 14 consecutive    10 of 14 failed  (one of them the `I9` shape)
    //
    // So no single rate is the truth and this comment does not claim one. What is reproducible
    // is the *cause*, and that `stream.consumer.integration.test.ts` run alone is 12/12 green.
    // Note the cause is **not** verifiable from the failure text alone: the `I9` shape above
    // names no stream key. An earlier revision claimed the text names the key "every time".
    //
    // **The cost, which is real and was previously unstated:** serializing the files takes the
    // package from ~1.9 s to ~5.2 s, about 2.6x. Measured over 5 runs each on this host:
    // serial 5.07/5.07/5.14/5.17/5.20/5.24 s, parallel (green runs) 1.87-1.99 s. The Gate-4
    // reviewer measured the same ratio at 4.7-4.9 s against 1.6-2.0 s. It also serializes the
    // nine unit files, which have no Redis dependency at all and gain nothing from it.
    //
    // Paid anyway. The alternative is to stop flushing and delete per-run keys by prefix in
    // both files, which S-22 argues against: the guarded `FLUSHDB` is the chokepoint that
    // keeps a suite from ever touching database 0, and per-prefix deletion still races on
    // `afterAll`. vitest 2.1.9 offers no per-file grouping primitive that would let only the
    // two integration files serialize, so a narrower fix would mean a second vitest project
    // and a `pnpm test` script change. Serializing keeps the S-22 shape and makes the "one
    // reserved logical database per service" convention hold by mechanism rather than by
    // nobody having added a second suite yet.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      all: true,
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/startup.constants.ts",
        "src/config/container.ts",
        "src/events/**",
        // `"src/jobs/**"` was removed here at T-042 (decision D4), which put the first
        // production code in that directory. S-25 part 1 exists because `src/events/**` is
        // excluded -- `stream.consumer.ts` alone is 1262 of `src/`'s 4756 lines, the largest
        // single file and the largest excluded glob -- and three untested branches in
        // it were found by a reviewer reading a diff rather than by a threshold. Repeating that
        // with the nightly billing trigger is the specific mistake that entry warns about.
        // `src/queues/**`, added by the same task, is deliberately **not** listed either.
        //
        // `src/events/**` stays excluded and S-25 stays open on that half: lifting it changes
        // what these thresholds mean for the whole service and needs the file measured first,
        // which belongs with epic-12's coverage task.
        "src/middleware/**",
        "src/models/**",
        "src/telemetry/**",
        "src/types/**"
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75
      }
    }
  }
});
