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
