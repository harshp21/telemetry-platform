/**
 * Test-scoped constants for `stream.consumer.integration.test.ts`.
 *
 * Nothing that already exists in `src/` is re-typed here: the `XGROUP` tokens, the start id,
 * the already-exists prefix and the stream/group defaults are imported from `../src/constants`
 * by the suite itself (`.claude/rules/constants.md` applies to tests). What lives here is the
 * fixture vocabulary and the Redis command tokens the *test harness* issues but the service
 * does not (`XINFO`, `XREADGROUP`, `XADD`) -- those belong to T-039, and putting them in
 * `src/constants.ts` now would be declaring constants no production code reads (S-6's shape).
 *
 * Flat in `tests/`, matching `apps/usage-service/tests/integration.constants.ts`.
 */

/** Redis connection default, matching `tests/setup.ts:9`. */
export const INTEGRATION_REDIS_URL_FALLBACK = "redis://localhost:6379";

/**
 * The runner's per-case budget: `testTimeout` in `apps/worker-service/vitest.config.mjs`.
 *
 * Every wall-clock deadline in this package's suites has to sit **below** this, because a
 * deadline at or above it cannot fire — the runner kills the case first and reports
 * `Test timed out in 5000ms`, naming nothing, instead of the assertion written for the
 * regression. That has now been the same defect three times: `RUN_DEADLINE_MS` at 10 000
 * (Gate-4 Round 2), `BLOCK_MS_LONG` at 5 000 (Gate-5 QA F-3), and the pair of them summing to
 * 6 000 in `I12`, which neither per-constant fix looked at.
 *
 * Declared here rather than only in the config so the relationship is assertable. `U50`
 * (`tests/stream.consumer.unit.test.ts`) imports the config at runtime and pins
 * `config.test.testTimeout === CASE_BUDGET_MS`, so the two cannot drift silently: changing
 * one without the other turns that case red. Scope of that: it holds for the deadlines `U50`
 * enumerates. A deadline constant added later is not automatically covered — nothing in the
 * type system enumerates them — so add it to `U50` when you add it here.
 */
export const CASE_BUDGET_MS = 5_000;

export const INTEGRATION_REDIS = {
  /**
   * Redis logical database reserved for this suite.
   *
   * **Not 0**: index 0 holds the real `telemetry:events` with the two entries and zero
   * consumer groups that D1's argument rests on. A suite that bootstrapped against it would
   * create a group on the developer's actual stream and destroy the measurement.
   *
   * **Not 15**: `apps/usage-service/tests/integration.constants.ts:64` reserves 15
   * (`LOGICAL_DB_INDEX: 15`) and `apps/usage-service/tests/integration.fixtures.ts:204`
   * issues the `FLUSHDB` against it -- two files, cited separately because the reservation
   * and the destructive call do not live together there. `turbo.json` sets no
   * `--concurrency`, so package test tasks are not serialized; an actual collision was not
   * observed, but both suites would flush the same index if they ever overlapped.
   *
   * Verified empty before use (`redis-cli -n 14 DBSIZE` -> 0) and unused in CI, which starts
   * a fresh `redis:7-alpine`. This suite issues `FLUSHDB` against this index and never
   * `FLUSHALL`.
   */
  LOGICAL_DB_INDEX: 14,
  /**
   * `connectionName` for every client this suite opens, so a `CLIENT LIST` row can be
   * attributed to this suite rather than to whatever else is connected to the server.
   *
   * Needed because `CLIENT LIST` is **server-wide** and crosses logical databases: the
   * blocked-read detector `I12` waits on was satisfied by a connection parked on database 13
   * with nothing parked on 14 (Round 1, M-3). Measured, and the reason this works at all:
   * `duplicate()` inherits `connectionName`, so the read connection the subject opens for
   * itself carries this name without the subject knowing about it — one client built with
   * `{ connectionName }` and its duplicate both reported `name=t039-probe db=14` from
   * `CLIENT INFO`, and both rows appeared in `CLIENT LIST`.
   */
  CLIENT_NAME: "worker-integration-suite",
  /** Per-run key prefixes, so no two cases and no two runs share a stream or a group. */
  STREAM_NAME_PREFIX: "telemetry:events:t038:",
  CONSUMER_GROUP_PREFIX: "worker-group-t038-",
  /** Reader identity for the `XREADGROUP` probes. T-038 itself never sends a consumer name. */
  CONSUMER_NAME: "t038-reader"
} as const;

/** `XINFO`/`XREADGROUP`/`XADD` tokens the harness issues. Not production vocabulary. */
export const INTEGRATION_REDIS_COMMANDS = {
  XINFO_GROUPS: "GROUPS",
  XREADGROUP_GROUP: "GROUP",
  XREADGROUP_COUNT: "COUNT",
  XREADGROUP_STREAMS: "STREAMS",
  /** `>` — entries never delivered to any consumer in this group. */
  XREADGROUP_NEW_ENTRIES: ">",
  /** `*` — let Redis assign the entry id. */
  XADD_AUTO_ID: "*"
} as const;

/** `XINFO GROUPS` reply field names (Redis 7.0.15 flat array encoding). */
export const INTEGRATION_XINFO_FIELDS = {
  NAME: "name",
  PENDING: "pending",
  LAST_DELIVERED_ID: "last-delivered-id"
} as const;

/** `TYPE <key>` reply for a stream. */
export const INTEGRATION_KEY_TYPE_STREAM = "stream";

/** `EXISTS <key>` replies. */
export const INTEGRATION_KEY_EXISTS = {
  ABSENT: 0,
  PRESENT: 1
} as const;

/** Fixture entry payloads. One field is enough; the entry's id is what the cases assert on. */
export const INTEGRATION_FIXTURE = {
  FIELD_NAME: "eventId",
  VALUE_BEFORE_BOOTSTRAP: "t038-before-bootstrap",
  VALUE_AFTER_BOOTSTRAP: "t038-after-bootstrap",
  VALUE_FIRST: "t038-first",
  VALUE_SECOND: "t038-second"
} as const;

/** Small cardinalities, named so no bare numeral appears in an assertion. */
export const INTEGRATION_COUNTS = {
  NONE: 0,
  SINGLE: 1,
  PAIR: 2
} as const;

/**
 * Independent Redis connections `I6` opens to issue the bootstrap concurrently.
 *
 * 8, matching the count QA used for the throwaway probe this case replaces (`Promise.allSettled`
 * over 8 clients -> 8/8 fulfilled, exactly 1 group) and the count named in
 * `src/events/stream.consumer.ts`' `ensureConsumerGroup` docblock. Any N > 1 exercises the
 * shape; 8 is kept so the case and the two prior measurements are directly comparable.
 *
 * Each client is `quit()`-ed by the case itself. They never issue `FLUSHDB` -- that stays
 * routed through `flushReservedDb()` on the suite's own client.
 */
export const INTEGRATION_CONCURRENCY = {
  BOOTSTRAP_CLIENTS: 8
} as const;

/**
 * Step size for walking `XINFO GROUPS`' flat field/value reply, which is a stride rather than
 * a cardinality. Named separately from `INTEGRATION_COUNTS.PAIR` for the same reason the
 * neighbour does (`apps/usage-service/tests/integration.fixtures.ts:186`): the two happen to
 * share a value, and reusing the count constant reads as "two of something".
 */
export const INTEGRATION_FIELD_PAIR_STRIDE = 2;

/**
 * Fixture vocabulary for T-039's loop cases (`I7`-`I12`).
 *
 * Separate prefixes from the `t038` ones above, deliberately: the two sets of cases share a
 * logical database and a `FLUSHDB`, and a name that says which task created it is the
 * difference between reading a leftover key and guessing at one. The `t038` members are
 * untouched.
 */
export const INTEGRATION_LOOP_REDIS = {
  STREAM_NAME_PREFIX: "telemetry:events:t039:",
  CONSUMER_GROUP_PREFIX: "worker-group-t039-",
  /** The consumer identity the subject reads under. */
  CONSUMER_NAME: "t039-worker",
  /**
   * A second identity, used to seed the pending list `I10` makes the subject reclaim.
   *
   * Recovery is only meaningful against work owned by *another* consumer; seeding under the
   * subject's own name would leave entries it could reach with an ordinary read at `0`.
   *
   * Read by `I10` through `readNewEntryIds`' consumer-name parameter. Until Round 1 this
   * constant was declared and unread (L-2) and `I10` seeded under T-038's `"t038-reader"`,
   * which was materially valid — that is also a different consumer from the subject — but
   * attributed t039 fixture data to a t038 identity.
   */
  ABANDONED_CONSUMER_NAME: "t039-dead-worker"
} as const;

/**
 * Timings and cardinalities for the loop cases.
 *
 * Every block value is small except `BLOCK_MS_LONG`, which belongs to the one case whose
 * subject *is* elapsed time. Everything else asserts on state — `XPENDING`, `XINFO`, the ids
 * the handler saw — rather than on the clock, because a wall-clock assertion in CI is a
 * flake waiting to happen.
 */
export const INTEGRATION_LOOP = {
  /** `STREAM_BLOCK_MS` for the cases that must cycle quickly. */
  BLOCK_MS_SHORT: 20,
  /**
   * `STREAM_BLOCK_MS` for `I12`, whose subject is that `stop()` does not wait this out.
   *
   * **Must stay under vitest's 5 000 ms per-case budget**, for the same reason as
   * `RUN_DEADLINE_MS` above: if `stop()` regresses to waiting the block out, `I12` awaits
   * `run()` for the whole block, and a block *equal to* the budget means the runner kills the
   * case before `STOP_BUDGET_MS` can report anything. The regression would then surface as
   * `Test timed out in 5000ms`, naming nothing, instead of as the elapsed-time assertion
   * written for it.
   *
   * This was `5_000` — exactly the budget — and was found at Gate 5 (QA finding F-3), one file
   * over from the same defect fixed as M-6 at the Gate-4 Round-2 review. At 3 000 a regression
   * fails by assertion at ~3 s with ~2 s of runner headroom, while the passing path is
   * unaffected: a `disconnect()` during a long read was measured ending it in **205 ms**, which
   * is far inside `STOP_BUDGET_MS` either way, so the case's positive claim keeps its margin.
   */
  BLOCK_MS_LONG: 3_000,
  /**
   * Upper bound on `stop()` -> `run()` resolving, against `BLOCK_MS_LONG`.
   *
   * Deliberately loose. A `disconnect()` during a blocking read was measured ending it in
   * 205 ms (against a 5 000 ms block, before F-3 lowered `BLOCK_MS_LONG` to 3 000 — the
   * measurement is a property of `disconnect()`, not of the block length); the claim under
   * test is "does not wait the block out", so the bound is set at a fraction of the block
   * rather than near the measurement. A tight bound would turn a slow
   * CI runner into a failure about the wrong thing.
   */
  STOP_BUDGET_MS: 2_000,
  /** `STREAM_BATCH_SIZE` for the recovery case: smaller than the pending list it must walk. */
  BATCH_SIZE_SMALL: 2,
  /** Entries seeded under the abandoned consumer, chosen to straddle `BATCH_SIZE_SMALL`. */
  ABANDONED_ENTRY_COUNT: 5,
  /**
   * Pause after seeding, so the abandoned entries are idle for longer than the reclaim
   * threshold (`BLOCK_MS_SHORT` x `RECOVERY_IDLE_MULTIPLIER` = 40 ms). Three times the
   * threshold, so a slow tick cannot make the case assert the opposite of its subject.
   */
  IDLE_SETTLE_MS: 120,
  /**
   * Ceiling on how long a case will let the loop run before its predicate gives up.
   *
   * Every loop case stops on a *condition* (the entries it expected arrived), so this only
   * fires when the condition never will. It converts a hang into a legible assertion
   * failure, which is the difference between a red suite and a timed-out one.
   *
   * **Must stay under vitest's 5 000 ms per-case budget**, which nothing in this package
   * overrides (`grep -rn "testTimeout|hookTimeout" apps/worker-service` excluding
   * `node_modules`/`dist` -> no match; `vitest.config.mjs` sets only `include`, `setupFiles`
   * and `coverage`). A deadline above that budget cannot fire: the runner kills the case
   * first and reports `Test timed out in 5000ms`, naming nothing.
   *
   * This was `10_000` and therefore unreachable. Measured at the Gate-4 Round-2 review with
   * the recovery pagination mutated to a single page (`while` -> `if` at
   * `stream.consumer.ts:641`), which is the mutation the plan's S4 nominates for `I10`:
   * `I10` went red at **5009 ms** as `Test timed out in 5000ms` — the exact failure mode the
   * paragraph above claims to convert away. Mirrors `STOP_DEADLINE_MS` in
   * `stream.consumer.unit.test.ts`, which got the inequality right in the same round.
   *
   * 1 500 ms is ample: the whole integration file runs in ~450 ms, and the longest legitimate
   * wait is `I12`'s read parking, which is milliseconds.
   *
   * **Lowered from 3 000 at T-040/S1, and the reason is the sum rather than this constant.**
   * The Gate-6 note this paragraph replaces argued that being *equal to* `BLOCK_MS_LONG` was
   * safe because `I12` does not use `buildLoopHarness` — true, and beside the point. `I12`
   * spends **both**: it waits up to `RUN_DEADLINE_MS` for the read to park (:832) and then, if
   * `stop()` has regressed to waiting the block out, up to `BLOCK_MS_LONG` for `run()` to
   * resolve (:804). At 3 000 each that is 6 000 against a 5 000 `CASE_BUDGET_MS`, so the very
   * regression `I12` exists to name would have been reported as `Test timed out in 5000ms` —
   * the third instance of the defect two prior per-constant fixes each addressed one of.
   * Measured, not reasoned: `U50` asserted the sum and failed `expected 6000 to be less than
   * 5000` before this line changed.
   *
   * This constant is the one that moved, not `BLOCK_MS_LONG`, because `BLOCK_MS_LONG` is
   * pinned from below — `I12:845` asserts `STOP_BUDGET_MS < BLOCK_MS_LONG`, without which the
   * case passes vacuously (a block shorter than the budget returns on its own and proves
   * nothing about `stop()`). `RUN_DEADLINE_MS` has no such floor: its measured use is ~26 ms.
   */
  RUN_DEADLINE_MS: 1_500,
  /** Poll interval while waiting for an out-of-band condition (a re-created group, a parked read). */
  POLL_INTERVAL_MS: 10
} as const;

/** Harness-side Redis tokens for the loop cases. Not production vocabulary. */
export const INTEGRATION_LOOP_COMMANDS = {
  CLIENT: "CLIENT",
  CLIENT_LIST: "LIST",
  CLIENT_INFO: "INFO",
  /** Substring `CLIENT LIST` shows for a connection parked on a blocking read. */
  CLIENT_LIST_BLOCKED_READ: "cmd=xreadgroup",
  /** `CLIENT LIST` prints one connection per line, with fields separated by spaces. */
  CLIENT_LIST_ROW_SEPARATOR: "\n",
  /** Field prefixes on a `CLIENT LIST` / `CLIENT INFO` row. */
  CLIENT_NAME_FIELD_PREFIX: "name=",
  CLIENT_DB_FIELD_PREFIX: "db=",
  /** `XPENDING <key> <group> - + <count>` — the extended form, which returns entry ids. */
  XPENDING_MIN_ID: "-",
  XPENDING_MAX_ID: "+"
} as const;

/** Fixture payload values for the loop cases. */
export const INTEGRATION_LOOP_FIXTURE = {
  VALUE_DELIVERED: "t039-delivered",
  VALUE_SECOND_DELIVERED: "t039-delivered-2",
  VALUE_BACKLOG: "t039-backlog",
  VALUE_AFTER_GROUP: "t039-after-group",
  VALUE_ABANDONED: "t039-abandoned",
  VALUE_AFTER_RECREATE: "t039-after-recreate",
  VALUE_AFTER_TIMEOUT: "t039-after-timeout"
} as const;

/**
 * Fixture vocabulary for T-040's event-processor cases (`I13`-`I20`).
 *
 * Its own prefixes, for the reason `INTEGRATION_LOOP_REDIS` gives: these cases share logical
 * database 14 and one `FLUSHDB` with the `t038` and `t039` sets, and a key that says which task
 * created it is the difference between reading a leftover and guessing at one.
 */
export const INTEGRATION_PROCESSOR_REDIS = {
  STREAM_NAME_PREFIX: "telemetry:events:t040:",
  CONSUMER_GROUP_PREFIX: "worker-group-t040-",
  CONSUMER_NAME: "t040-worker"
} as const;

/**
 * Quantities chosen for what they do to `Decimal(18,6)`, not for readability.
 */
export const INTEGRATION_PROCESSOR_QUANTITY = {
  /**
   * Exact through a string bind, lossy through a JS `number` bind.
   *
   * Measured: bound as a `number` this was stored as `12345678901.123460` with **no error**
   * (plan Appendix A/P-DEC). It is the value `I20` reads back with `quantity::text`, because
   * comparing through the ORM's `Decimal` would hide a difference the column actually kept.
   */
  FULL_PRECISION: "12345678901.123456",
  /**
   * Thirteen integer digits, against a column that allows twelve (`18 - 6`).
   *
   * Raises PostgreSQL `22003` *at the second write*, which is what `I16` needs: a failure after
   * the `Event` row has been inserted, so that "zero rows of both kinds" is evidence of a
   * rollback rather than of an insert that never happened.
   */
  OVERFLOWS_COLUMN: "9999999999999.000000"
} as const;

/** Fixture event vocabulary. `metricKey` is asserted to equal `EVENT_TYPE` (D1). */
export const INTEGRATION_PROCESSOR_EVENT = {
  EVENT_TYPE: "api.request",
  UNIT: "request",
  SOURCE_ID_FIELD: "sourceId",
  SOURCE_ID_VALUE: "sdk-web",
  OCCURRED_AT_ISO: "2026-01-01T00:00:00.000Z",
  /** A syntactically valid UUID that is deliberately absent from `Tenant` (`Event_tenantId_fkey`). */
  UNKNOWN_TENANT_ID: "11111111-1111-4111-8111-111111111111"
} as const;

/** Small cardinalities, named so no bare numeral carries meaning in an assertion. */
export const INTEGRATION_PROCESSOR_COUNTS = {
  NONE: 0,
  SINGLE: 1,
  PAIR: 2
} as const;

/**
 * How many entries the `XPENDING <key> <group> - + <count>` probe asks for.
 *
 * A *page size for a read*, not a batch size for the consumer, and named separately for that
 * reason: reusing `INTEGRATION_LOOP.BATCH_SIZE_SMALL` here would read as "the consumer's batch"
 * and would silently change what the probe sees if that constant were ever retuned. Larger than
 * any case seeds, so "the pending list is empty" is never an artefact of the page ending.
 */
export const INTEGRATION_PROCESSOR_PENDING_PAGE_SIZE = 10;

/**
 * First element of a query result or a reply list.
 *
 * A *position*, declared separately from `INTEGRATION_PROCESSOR_COUNTS.NONE` even though they
 * share a value -- the reason `tests/stream.consumer.unit.test.ts` separates `INDEX` from
 * `CALLS`: a cardinality standing in for an offset reads wrong even when the numeral is right.
 */
export const INTEGRATION_PROCESSOR_INDEX_FIRST = 0;

/**
 * Session time zone `I22` pins on its own connection, and the query-string form that pins it.
 *
 * **Pinned rather than inherited.** `CLAUDE.md` § *Raw SQL and timestamps* records that CI's
 * `postgres:16-alpine` defaults `TimeZone` to `UTC`, where a correct and a broken raw-SQL
 * timestamp path are indistinguishable. Measured on this host, the developer server is not UTC
 * either — `pg_settings` reports `TimeZone|Asia/Kolkata|configuration file`. Neither ambient
 * value can be relied on, so the case brings its own.
 *
 * **`America/New_York`, and the choice is load-bearing rather than arbitrary.** It must differ
 * from *both* plausible ambient defaults, or the assertion that the pin took effect cannot
 * fail. Measured: with the zone set to `Asia/Kolkata` and the suffix mutated to the bare
 * `?timezone=` form — the one `CLAUDE.md` says is accepted and silently ignored — `I22` stayed
 * **green on this host**, because the ignored pin left the session on the server default, which
 * was the very zone being asserted. Under `America/New_York` that mutation reddens on a
 * `Asia/Kolkata` host and on a UTC one alike.
 *
 * **What the pin does and does not currently buy, stated as measured.** `I22`'s failure under
 * the discarded-offset mutation comes from the JavaScript side — `new Date(...)` resolving the
 * offset — and reproduces under any session zone, because the ORM binds an absolute instant
 * against a naive column. So the pin is **not** what makes the case catch today's mutation. It
 * is there so the case is already running somewhere a *future* raw-SQL cast could be caught,
 * which is the S-18 shape worker-service is exposed to by having no `TimeZone` pin in its
 * `withTenant` (S-19). Do not describe it as the thing that makes `I22` work.
 *
 * The `options=-c timezone=` form is used because the bare `?timezone=` is silently ignored.
 * Verified honoured through Prisma rather than assumed: a client opened with this form reported
 * `SHOW timezone` -> `UTC` when pinned to UTC, against the same server whose default is
 * `Asia/Kolkata`.
 */
export const INTEGRATION_PROCESSOR_SESSION_TIME_ZONE = {
  NON_UTC: "America/New_York",
  URL_SUFFIX: "?options=-c%20timezone%3DAmerica%2FNew_York",
  SHOW_TIMEZONE: "SHOW timezone"
} as const;

/**
 * Fixture vocabulary for T-041's retry/dead-letter cases (`I23`-`I27`).
 *
 * Its own prefixes, for the reason `INTEGRATION_LOOP_REDIS` and `INTEGRATION_PROCESSOR_REDIS`
 * give: these cases share logical database 14 and one guarded `FLUSHDB` with the `t038`, `t039`
 * and `t040` sets, and a key that says which task created it is the difference between reading
 * a leftover and guessing at one.
 *
 * **`DEAD_LETTER_STREAM_PREFIX` is not `telemetry:dead-letter`, and that is deliberate.** The
 * shipped default is what a developer's own worker would use; a suite that wrote to it would
 * leave records an operator could mistake for real dropped usage. Every case builds a per-run,
 * per-case name under this prefix, on database 14 only.
 */
export const INTEGRATION_DEAD_LETTER = {
  STREAM_NAME_PREFIX: "telemetry:events:t041:",
  CONSUMER_GROUP_PREFIX: "worker-group-t041-",
  DEAD_LETTER_STREAM_PREFIX: "telemetry:dead-letter:t041:",
  CONSUMER_NAME: "t041-worker",
  /** Consumer identity the abandoned-entry fixtures are seeded under. */
  ABANDONED_CONSUMER_NAME: "t041-dead-worker",
  /**
   * Retry budget the live cases run with.
   *
   * Equal to the shipped default of 3, unlike the unit suite's deliberately non-default 2.
   * Here that is the right choice rather than a lapse: `U63` already proves the threshold is
   * taken from the parsed environment, and these cases are about the number of *round trips to
   * a real server* the default budget costs. Each attempt waits out a cadence window, so a
   * larger budget would trade the thing under test for wall-clock time against
   * `RUN_DEADLINE_MS`.
   */
  MAX_RETRY_COUNT: 3,
  /** Fixture payload values, named so a leftover key says which case wrote it. */
  VALUE_RETRIED: "t041-retried",
  VALUE_POISON: "t041-poison",
  /**
   * A metadata key and value a customer might send, for `I27`'s S-31 negative.
   *
   * The **key** matters separately from the value: zod's `unrecognized_keys` issue carries the
   * offending key, so a diagnosis that read `issue.message` rather than `issue.code`/`path`
   * would put a customer-chosen key into the dead-letter record and into the log.
   */
  SENTINEL_METADATA_KEY: "SENTINEL-META-KEY-t041",
  SENTINEL_METADATA_VALUE: "SENTINEL-META-VALUE-t041",
  /** A `quantity` the parser rejects, carrying a sentinel so `I27` can look for it. */
  SENTINEL_QUANTITY: "SENTINEL-QUANTITY-t041"
} as const;

/**
 * Minimum delivery count `I23` requires from `XPENDING`'s fourth column.
 *
 * `2` -- one original delivery and one redelivery inside a single `run()`. Redis maintains this
 * per-entry counter itself, and it is the most direct evidence available that the entry came
 * back through the pending list rather than through a `>` read: measured on 7.0.15, a second
 * `XREADGROUP ... >` against the same group returned empty while `XPENDING` still reported the
 * entry, so `>` cannot be the source of a second delivery.
 */
export const INTEGRATION_REDELIVERY_MIN_COUNT = 2;

/** Position of the delivery count in an `XPENDING <key> <group> - + <n>` row. */
export const INTEGRATION_XPENDING_DELIVERY_COUNT_INDEX = 3;
