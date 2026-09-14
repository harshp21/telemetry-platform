import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
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
        "src/jobs/**",
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
