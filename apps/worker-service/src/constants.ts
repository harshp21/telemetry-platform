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
