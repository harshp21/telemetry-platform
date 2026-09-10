import {
  EVENT_STREAM_CONSTANTS,
  INTERNAL_AUTH_HEADERS,
  INTERNAL_AUTH_RESPONSES
} from "@telemetry/shared-types";

export const WORKER_SERVICE_NAME = "worker-service";

export const WORKER_ROUTES = {
  HEALTH: "/health",
  INTERNAL_WORKER_REPLAY: "/v1/internal/worker/replay"
} as const;

export const WORKER_HEADERS = {
  INTERNAL_SECRET: INTERNAL_AUTH_HEADERS.INTERNAL_SECRET
} as const;

export const WORKER_RESPONSES = {
  STATUS_OK: "ok",
  STATUS_ACCEPTED: "accepted",
  WORKFLOW_USAGE_REPLAY: "usage-replay",
  CODE_UNAUTHORIZED: INTERNAL_AUTH_RESPONSES.CODE_UNAUTHORIZED,
  // Named to match usage-service's `USAGE_SERVICE_RESPONSES.HTTP_STATUS_*`.
  // `middleware/internal-auth.middleware.ts` still writes a literal 401; that file is left
  // untouched here because it is S-8's, and these are the constants S-8 should adopt.
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_UNAUTHORIZED: 401
} as const;

export const WORKER_RUNTIME = {
  DEFAULT_PORT: 3003,
  HOST: "0.0.0.0"
} as const;

/**
 * Redis Streams consumer configuration defaults (T-037).
 *
 * `DEFAULT_STREAM_NAME` is not a copy: it resolves
 * `EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM` from `@telemetry/shared-types`, which is also
 * what usage-service's producer default resolves. The value that decides where events are
 * written is `apps/usage-service/src/config/env.ts`'s `REDIS_STREAM_NAME` default -- its
 * `.default(...)` always applies, so `stream.publisher.ts:35-36`'s
 * `env.REDIS_STREAM_NAME || STREAM_CONSTANTS.DEFAULT_STREAM_NAME` never reaches the fallback.
 * Both that default and the fallback now come from the shared constant.
 *
 * Observed on the running instance while planning T-037:
 * `redis-cli --scan --pattern 'telemetry*'` returned exactly `telemetry:events`, and
 * `xinfo groups telemetry:events` returned nothing -- the stream exists and has never been
 * consumed. A consumer pointed at a different name would block on `XREADGROUP` forever and
 * report healthy, so `tests/env.schema.unit.test.ts` still pins the resolved default both
 * against the literal and against the shared constant.
 *
 * `BATCH_SIZE_MAX` is a deliberate operational ceiling chosen to mirror the batch cap
 * usage-service enforces (`INGESTION_CONSTANTS.BATCH_SIZE_MAX`,
 * `apps/usage-service/src/validators/events.validator.ts:6` -- same value as the S-6 dead
 * `INGEST_BATCH_MAX`), NOT a Redis protocol limit: `XREADGROUP COUNT` accepts larger values.
 * It is a policy choice about how much work one consumer iteration may claim.
 */
export const WORKER_STREAM_CONSTANTS = {
  DEFAULT_STREAM_NAME: EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM,
  DEFAULT_CONSUMER_GROUP: "worker-group",
  DEFAULT_CONSUMER_NAME: "worker-1",
  DEFAULT_BLOCK_MS: 5_000,
  DEFAULT_BATCH_SIZE: 10,
  BATCH_SIZE_MIN: 1,
  BATCH_SIZE_MAX: 100
} as const;

/**
 * `XGROUP CREATE` bootstrap tokens (T-038).
 *
 * A sibling of `WORKER_STREAM_CONSTANTS` rather than a member of it. The distinction is which
 * file consumes them: every one of that object's **seven** members feeds
 * `src/config/env.ts`'s schema -- five as a `.default(...)` (`DEFAULT_STREAM_NAME`,
 * `DEFAULT_CONSUMER_GROUP`, `DEFAULT_CONSUMER_NAME`, `DEFAULT_BLOCK_MS`,
 * `DEFAULT_BATCH_SIZE`) and two as the `.min()`/`.max()` bounds on `STREAM_BATCH_SIZE`
 * (`BATCH_SIZE_MIN`, `BATCH_SIZE_MAX`, `env.ts:52-53`). Counted:
 * `grep -c 'WORKER_STREAM_CONSTANTS\.' src/config/env.ts` -> 7, one per member. These four
 * feed no env field at all and are referenced only by `src/events/stream.consumer.ts` -- the
 * Redis subcommand spelling, and the start position T-038 chose. Keeping the two kinds in
 * one object would invite a future `REDIS_START_POSITION` env var, which is exactly the knob
 * D1 decided against.
 *
 * An earlier revision of this paragraph said "those five values are *env defaults* (each is a
 * `.default(...)`) ... these four are protocol and policy tokens that no operator may
 * override". Five of the seven are defaults, but `BATCH_SIZE_MIN`/`BATCH_SIZE_MAX` are
 * validation bounds rather than defaults, and no operator can override *those* either -- so
 * overridability was not the line it claimed to be, and the member count was wrong. Recorded
 * rather than silently replaced because the first Gate-4 pass cleared the wrong text
 * explicitly ("true of every member of both objects, which I checked one by one"); the
 * re-review caught it as LOW-2.
 *
 * All four exist because `.claude/rules/constants.md` is a required review gate and the
 * epic's snippet spells all four inline.
 *
 * Measured against the host Redis 7.0.15 via ioredis 5.11.1 while planning (probes P1-P10,
 * `docs/plans/t-038-consumer-group-bootstrap.md` Appendix A). Every claim below names the
 * command that produced it; none is inferred from documentation.
 */
export const WORKER_CONSUMER_GROUP_BOOTSTRAP = {
  /** `XGROUP` subcommand. Typed as the literal `"CREATE"` so the ioredis overload resolves. */
  SUBCOMMAND_CREATE: "CREATE",
  /**
   * Creates the stream key if it does not exist.
   *
   * Observed: `XGROUP CREATE probe:missing g1 $` (no `MKSTREAM`) replied
   * `ERR The XGROUP subcommand requires the key to exist...` and left `EXISTS probe:missing`
   * at 0; the same call with `MKSTREAM` replied `OK` and left `EXISTS` 1 / `TYPE` stream /
   * `XLEN` 0.
   */
  OPTION_MKSTREAM: "MKSTREAM",
  /**
   * Start position (D1). `$` = deliver only entries added after the group is created.
   *
   * Observed on a 2-entry stream: a group created at `$` reported `last-delivered-id` equal
   * to the last existing entry and `XREADGROUP >` returned nil, while a group created at `0`
   * on the same stream returned both entries. Observed on a key created by `MKSTREAM` in the
   * same call: `last-delivered-id` came back `0-0` -- on a stream that did not previously
   * exist, `$` skipped nothing.
   *
   * Chosen because the 2 entries currently on `telemetry:events` carry
   * `tenantId = 11111111-1111-4111-8111-111111111111`, which is absent from the `Tenant`
   * table. `Event.tenantId` has a foreign key to `Tenant(id)` (`Event_tenantId_fkey`), so
   * T-040's insert is rejected -- observed in a rolled-back transaction as
   * `ERROR: insert or update on table "Event" violates foreign key constraint
   * "Event_tenantId_fkey"`. The FK's *existence* is the reason, not its `ON DELETE RESTRICT`
   * action, which governs deletion of the parent `Tenant` row: temp children declared
   * `ON DELETE CASCADE`, `SET NULL` and `NO ACTION` were all observed to reject the same
   * missing-parent insert. T-041's dead-letter destination is deferred, so a message that
   * cannot be stored also cannot be drained.
   */
  START_ID_NEW_ENTRIES_ONLY: "$",
  /**
   * Prefix of the reply that means "this group already exists" -- the only error
   * `ensureConsumerGroup` swallows.
   *
   * Matched with `String.prototype.startsWith`, not `includes`. Observed reply text:
   * `"BUSYGROUP Consumer Group name already exists"`, surfaced by ioredis as a `ReplyError`
   * whose `code` property is `undefined`, so the message is the only discriminator available.
   *
   * Scope of the `startsWith`-over-`includes` choice, stated as measured: across the four
   * `XGROUP CREATE` error replies produced while planning (`ERR ...requires the key to
   * exist`, `WRONGTYPE ...`, `ERR Invalid stream ID ...`, and `BUSYGROUP ...`), the two
   * predicates agreed every time -- no `XGROUP CREATE` reply is known here to make them
   * disagree. They *were* observed to disagree on a different subcommand:
   * `XGROUP CREATECONSUMER probe:b BUSYGROUP c1` replied
   * `"NOGROUP No such consumer group 'BUSYGROUP' for key name 'probe:b'"`, for which
   * `includes` is true and `startsWith` is false. T-038 issues only `CREATE`, so this is
   * prophylaxis for T-039/T-041 -- which will issue other `XGROUP` subcommands against a
   * group name that is operator-supplied -- and not a fix for a live bug.
   */
  ALREADY_EXISTS_ERROR_PREFIX: "BUSYGROUP"
} as const;
