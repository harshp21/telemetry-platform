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

/**
 * `XREADGROUP` / `XAUTOCLAIM` tokens and timings for the read loop (T-039).
 *
 * A **sibling** of `WORKER_STREAM_CONSTANTS`, not a member of it, and deliberately so for two
 * reasons. The first is the one `WORKER_CONSUMER_GROUP_BOOTSTRAP`'s docblock gives: every
 * member of that object feeds `src/config/env.ts`, and none of these does — they are read only
 * by `src/events/stream.consumer.ts`. The second is S-23: its fix direction names
 * `src/constants.ts:38-44`, the `WORKER_STREAM_CONSTANTS` docblock whose "never reaches the
 * fallback" sentence is stale for `REDIS_STREAM_NAME=""`. Putting these members there would
 * make an S-23 fix and this task collide on the same lines; as a sibling they are disjoint.
 *
 * Every value below was measured against Redis 7.0.15 through ioredis 5.11.1 on logical
 * database 14 while implementing T-039 — re-run for this change rather than inherited from
 * the plan. The transcripts are in `docs/plans/t-039-stream-consumer-loop.md` Appendix A;
 * the re-measured figures are quoted inline.
 */
export const WORKER_STREAM_READ = {
  /**
   * `XREADGROUP` subcommand and option tokens. Typed as literals so ioredis resolves the
   * `GROUP/COUNT/BLOCK/STREAMS` overload
   * (`ioredis/built/utils/RedisCommander.d.ts`, the 10-argument signature).
   */
  SUBCOMMAND_GROUP: "GROUP",
  OPTION_COUNT: "COUNT",
  OPTION_BLOCK: "BLOCK",
  OPTION_STREAMS: "STREAMS",
  /**
   * `>` — deliver only entries never handed to any consumer in this group.
   *
   * Observed with the three other start positions this task had reason to try, on one
   * fixture stream: `>` returned the undelivered entries; an explicit `0` returned *this
   * consumer's own pending list* and, once everything was acknowledged, the non-null empty
   * tuple `[[stream, []]]`; and a group whose cursor had been moved with `XGROUP SETID … 0`
   * then returned the pre-group backlog to `>`. The loop wants only the first of those.
   */
  NEW_ENTRIES_ONLY: ">",
  /**
   * Positional indices into the two replies this consumer parses, named rather than written
   * as bare numerals (Round 1, L-4). These are protocol positions with names, and this
   * repository already names a positional `2` as `INTEGRATION_FIELD_PAIR_STRIDE`.
   *
   * `XREADGROUP` nests per stream: `[[streamName, [[id, fields], ...]], ...]`, so the entry
   * list is the second element of each per-stream tuple. `XAUTOCLAIM` replies
   * `[nextCursor, entries, deletedIds]` on Redis 7.0.15 — the third element is read by
   * nobody here and deliberately has no constant, because naming it would imply this code
   * consults it.
   */
  READ_REPLY_ENTRIES_INDEX: 1,
  CLAIM_REPLY_CURSOR_INDEX: 0,
  CLAIM_REPLY_ENTRIES_INDEX: 1,
  /**
   * `0-0`, in both of the roles `XAUTOCLAIM` gives it: the cursor a scan **starts** at, and
   * the cursor Redis **returns** when the scan is complete.
   *
   * One constant for one literal, documented as serving both roles, rather than two names —
   * `.claude/rules/constants.md`'s DRY clause treats a value duplicated under two names as a
   * finding. Observed over a 5-entry pending list at `COUNT 2`: cursors came back
   * `1789101023808-1`, `1789101023808-3`, then `0-0`.
   */
  PENDING_START_ID: "0-0",
  /**
   * Idle threshold for reclaiming abandoned work, as a multiple of `STREAM_BLOCK_MS`.
   *
   * The epic's `blockMs * 2`. A multiplier rather than a second millisecond constant, so the
   * threshold cannot drift away from the block duration when an operator changes it: a
   * threshold below the block window would let a worker reclaim entries from a live peer that
   * is merely parked on its read.
   *
   * The filter was observed to work in both directions on a freshly-delivered entry:
   * `XAUTOCLAIM … 60000 0-0` returned `["0-0",[],[]]`, and `XAUTOCLAIM … 0 0-0` on the same
   * entry returned it.
   */
  RECOVERY_IDLE_MULTIPLIER: 2,
  /**
   * Liveness bound on the recovery pagination loop, **not** a capacity decision.
   *
   * `XAUTOCLAIM` is paginated and the loop's exit condition is a cursor value the server
   * chooses; a server that never returned `PENDING_START_ID` would spin forever and the
   * worker would never start reading. This caps that at a finite number of round trips. At
   * the default `STREAM_BATCH_SIZE` of 10 it admits 10 000 entries per startup, and a
   * truncated scan is logged at warn level and retried on the next restart — the same
   * best-effort stance the rest of recovery takes.
   */
  RECOVERY_MAX_PAGES: 1_000,
  /**
   * Pause after an unclassified read failure, before the next attempt.
   *
   * Not a retry policy — the loop retries forever either way — but a rate limit on a failing
   * one. Measured against a port nothing listens on with the container's own client options
   * (`maxRetriesPerRequest: 2`): rejections came back in 153 ms and then 603 ms, so an
   * unpaced loop logs at roughly 6 errors a second. T-041 owns real retry accounting.
   */
  ERROR_BACKOFF_MS: 1_000,
  /**
   * Prefix of the reply that means the group, or the stream key, is gone — the one read
   * failure the loop can repair by itself, by re-running `ensureConsumerGroup()`.
   *
   * Matched with `startsWith`, not `includes`, for the reason
   * `WORKER_CONSUMER_GROUP_BOOTSTRAP.ALREADY_EXISTS_ERROR_PREFIX` records: the group name is
   * operator-supplied and appears *inside* the reply text, so a group named after another
   * reply's prefix would satisfy `includes`.
   *
   * Scope, stated as measured rather than as a rule: the two replies observed here — a
   * missing group and a missing key — are both
   * `NOGROUP No such key '<key>' or consumer group '<group>' in XREADGROUP with GROUP option`,
   * and they satisfy `startsWith` and `includes` alike. No `XREADGROUP` reply is known here
   * to make the two predicates disagree, so this is prophylaxis, not a fix for an observed
   * disagreement. Note the single reply text covers both causes, which is why the repair is
   * the same for both: re-create the group, with `MKSTREAM` re-creating the key if needed.
   */
  MISSING_GROUP_ERROR_PREFIX: "NOGROUP",
  /**
   * Log messages this file's consumer writes that more than one non-test site needs to name.
   *
   * Only `HANDLER_FAILED` is here, and the narrowness is deliberate rather than an oversight.
   * `StreamConsumer` writes **sixteen** log calls; fifteen of those messages are named by
   * exactly one production site and one test-local constant, which is two copies and below the
   * threshold
   * `.claude/rules/constants.md` sets. `HANDLER_FAILED` reached a **third** copy when T-040's
   * `I18` asserted it from a second test file, and the rule asks for promotion before the third
   * copy — so this member exists because that line crossed the threshold, not because log
   * messages are being promoted as a class.
   *
   * **`tests/stream.consumer.unit.test.ts`'s `LOG_MESSAGE.HANDLER_FAILED` deliberately does
   * NOT import this**, and must not be changed to. That object is a restatement of the
   * subject's log text *as the thing under test*: `U29` asserts the exact wording, and an
   * assertion sourced from the same constant the subject writes would hold no matter what
   * either said. That is the rule the file's own docstring states for the observed Redis reply
   * texts, applied to the same situation. `I18` is different and does import this: its subject
   * is that a failed entry stays pending and the failure is attributed to its entry id, and the
   * message is a selector for the right log line rather than the claim being made.
   */
  LOG: {
    /** `dispatch`, per-entry handler failure. */
    HANDLER_FAILED: "Stream entry handler failed"
  },
  /**
   * The rejection an in-flight blocking read produces when its connection is disconnected —
   * i.e. what `stop()` causes, and the one read failure that is a normal shutdown rather than
   * a fault.
   *
   * Observed: `disconnect()` issued 200 ms into a `BLOCK 5000` read rejected that read after
   * 205 ms with a plain `Error` whose message is exactly this string (`quit()` on the same
   * fixture instead waited the block out, 4 813 ms — which is why shutdown disconnects).
   *
   * Compared with `===`, not `startsWith`: this is a complete ioredis-generated message, not
   * a server reply prefix. It is matched **only** in combination with a shutdown having been
   * requested — see `StreamConsumer`'s read-error classification, and `U28`, which pins that
   * the same text outside shutdown stays an error.
   */
  CONNECTION_CLOSED_ERROR_MESSAGE: "Connection is closed."
} as const;

/**
 * Event-processing vocabulary (T-040): the stream envelope, the derivation rules, and the log
 * and error messages the processor writes.
 *
 * A **sibling** of `WORKER_STREAM_READ` for the same reason that object is a sibling of
 * `WORKER_STREAM_CONSTANTS`: nothing here feeds `src/config/env.ts`, and none of it is
 * operator-overridable. These are the shape of the message on the wire and the decisions this
 * task made about what to write from it.
 *
 * **The envelope is the wire format, not the specified one.** `docs/epics/README.md` records
 * Q1 as decided with required fields `eventId, tenantId, eventType, occurredAt, receivedAt,
 * source, idempotencyKey, version, payload`. The producer publishes none of `receivedAt`,
 * `source`, `version` or `payload`, and does publish `quantity`, `unit` and `timestamp`.
 * Measured with `XRANGE telemetry:events` while planning, against both entries on the live
 * stream, and confirmed against `apps/usage-service/src/services/ingestion.service.ts`'s
 * `publishEvent` literal. Divergence reported at Gate 3; the parser reads what is written.
 */
export const WORKER_EVENT_PROCESSING = {
  /**
   * The fields the producer treats as the envelope, i.e. everything it will **not** flatten
   * metadata into.
   *
   * A copy of usage-service's `RESERVED_STREAM_FIELDS`
   * (`apps/usage-service/src/services/ingestion.service.ts`), and deliberately a copy rather
   * than an import: that set is a module-private `const` in another service's service layer
   * with no `export` keyword, and importing across two services' internals to share it would
   * couple the consumer's parse to the producer's implementation detail.
   *
   * **Nothing asserts that the two sets agree, and this copy is therefore unguarded.** Stated
   * as measured: the two sets match today — both are the same **eight** names, in the same
   * order (`eventId, tenantId, eventType, quantity, unit, occurredAt, idempotencyKey,
   * timestamp`), compared programmatically against the producer's declaration rather than by
   * eye. But `grep -rn "RESERVED_STREAM_FIELDS" apps packages --include=*.ts` (excluding
   * `dist/`) returns **five** lines: the producer's declaration, the producer's single use, and
   * three *prose comments* — the two in this docblock (the sentence above naming the constant,
   * and this sentence, which contains the grep pattern and so matches itself) and the
   * `stream-message.validator.unit.test.ts` docstring. Counted, after the Gate-5 review found
   * the earlier figure of four short by exactly the self-match.
   * No test references it. `U41` pins **this** constant against **this** parser, which is a
   * different property: it asserts that a field named here reaches neither a column nor
   * `metadata`, and it stays green no matter what the producer's set contains.
   *
   * The drift is directional and the exposed direction is a producer-side *addition*: a field
   * added there and not here lands in every event's customer-facing `metadata` blob with `U41`
   * green. Q1's `receivedAt`, `source` and `version` are the named pending candidates. Filed
   * as **S-27**; the reason for not importing stays sound, so the fix is promotion rather than
   * a manufactured import.
   *
   * `.claude/rules/constants.md` asks for promotion before the third copy: this is the second,
   * and the shared home when a third appears is `@telemetry/shared-types`, alongside
   * `EVENT_STREAM_CONSTANTS`.
   *
   * `PRODUCER_TIMESTAMP` is the one member with no column behind it. It is `Date.now()` at
   * publish time, which is bookkeeping about the *transport*, not about the event — the
   * event's own instant is `occurredAt`. It is listed here so that it is excluded from
   * metadata; it is absent from `StreamEventPayload` so that it cannot be persisted.
   */
  ENVELOPE_FIELD: {
    EVENT_ID: "eventId",
    TENANT_ID: "tenantId",
    EVENT_TYPE: "eventType",
    QUANTITY: "quantity",
    UNIT: "unit",
    OCCURRED_AT: "occurredAt",
    IDEMPOTENCY_KEY: "idempotencyKey",
    PRODUCER_TIMESTAMP: "timestamp"
  },
  /**
   * Step size for walking the flat `[key, value, key, value, ...]` field list `XREADGROUP`
   * returns.
   *
   * A stride, not a cardinality — named separately for the reason
   * `INTEGRATION_FIELD_PAIR_STRIDE` gives in `tests/integration.constants.ts`.
   */
  FIELD_PAIR_STRIDE: 2,
  /**
   * Offset from a key's position to its value's, within the same flat field list.
   *
   * Named separately from `FIELD_PAIR_STRIDE` although both describe the same pairing: one is
   * how far to step to reach the next *pair*, the other how far to reach *this pair's value*.
   * They are different quantities that happen to be adjacent, and `INDEX` vs `CALLS` in
   * `tests/stream.consumer.unit.test.ts` is the same distinction one layer up.
   */
  FIELD_VALUE_OFFSET: 1,
  /**
   * What a `quantity` on the wire may look like.
   *
   * `Event.quantity` and `UsageLine.quantity` are `Decimal(18,6)`, which exceeds IEEE-754
   * safe precision, so the value crosses this boundary as a **string** and is never
   * converted. Measured (plan Appendix A/P-DEC): `12345678901.123456` bound as a JS `number`
   * was stored as `12345678901.123460` with no error at all, while the same value bound as a
   * string or a `Prisma.Decimal` was stored exactly.
   *
   * Scope of the pattern, stated as what it accepts rather than as a general decimal rule: an
   * optional leading `-`, then digits, then optionally a `.` and more digits. It therefore
   * rejects exponent notation (`1e6`), a bare `.5`, a trailing `1.`, and `NaN`/`Infinity`.
   * Exponent notation is rejected rather than supported because nothing produces it —
   * usage-service publishes `String(event.quantity)` over a value its own validator has
   * already constrained to an integer — and accepting a form no test covers is how a
   * precision rule acquires an untested arm.
   *
   * The sign is permitted although nothing sends one today: the column accepts it, and the
   * producer owns the business rule about what a legal quantity is. This boundary owns
   * precision, not policy.
   */
  QUANTITY_PATTERN: /^-?\d+(\.\d+)?$/,
  ERROR: {
    /**
     * A field list whose length is odd, so its last key has no value.
     *
     * Distinguished from `INVALID_MESSAGE` because it is a *framing* failure rather than a
     * content one: folding an odd list anyway would pair every key from the defect onward
     * with the following key's value, which is the quiet mis-parse
     * `stream.consumer.ts`'s `parseEntry` refuses for the same reason.
     */
    ODD_FIELD_LIST: "Stream entry field list has an odd length",
    /** Any envelope field that is absent, empty, or not the shape its column needs. */
    INVALID_MESSAGE: "Stream entry is not a valid usage event"
  },
  LOG: {
    PROCESSED: "Processed stream entry into an event and usage line",
    ACK_FAILED: "Failed to acknowledge a processed stream entry"
  }
} as const;

/**
 * The envelope field names as a lookup, for "is this field metadata?".
 *
 * Derived from `WORKER_EVENT_PROCESSING.ENVELOPE_FIELD` rather than written out a second time,
 * so a field added there cannot be left out of the exclusion set — which would put it in every
 * event's customer-facing `metadata` blob.
 */
export const WORKER_ENVELOPE_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.values(WORKER_EVENT_PROCESSING.ENVELOPE_FIELD)
);
