import { parseEnv } from "@telemetry/shared-config";
import { INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
import { z } from "zod";
import { WORKER_STREAM_CONSTANTS } from "../constants";
import { WORKER_SERVICE_STARTUP } from "../startup.constants";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Nothing in this repo reads the parsed `env.PORT`: `src/index.ts` binds
  // `process.env.PORT ?? WORKER_SERVICE_STARTUP.DEFAULT_PORT` directly. Defaulting from the same
  // constant keeps the declaration honest about the port the service actually binds.
  PORT: z.coerce.number().int().positive().default(WORKER_SERVICE_STARTUP.DEFAULT_PORT),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  // Service-to-service auth (S-8 item 2). Required with no default: `parseEnv` throws at module
  // load, so a worker-service that cannot authenticate its callers never reaches `app.listen`,
  // and the shared 32-character minimum is enforced before the DI container is built.
  // `.trim()` runs before `.min(...)`, so length is measured on the trimmed value: a secret of
  // SECRET_MIN_LENGTH spaces is rejected here rather than parsing and emptying later. It also
  // transforms the parsed value, which is the string `buildInternalAuthMiddleware` compares
  // against the inbound header. Probed against a real Fastify server on a socket: header
  // values sent with leading spaces, trailing spaces, both, and surrounding tabs all arrived
  // stripped -- over a raw socket and over `fetch` alike. SP and HTAB are the only OWS the
  // HTTP parser removes; VT and FF are rejected as 400. Whitespace that `String.trim()` removes
  // but HTTP does not -- U+00A0 in particular -- survives the wire intact, so the trim does
  // narrow what the middleware accepts rather than being a no-op. Fail-closed either way.
  // (`app.inject` does *not*
  // strip; it bypasses the HTTP parser. That is why the test asserts the schema's output
  // rather than inferring the transform from an injected request.)
  // Both halves are pinned in `tests/env.schema.unit.test.ts`.
  INTERNAL_API_SECRET: z.string().trim().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH),
  // Redis Streams consumer configuration (T-037). Nothing reads these yet: they will be read by
  // T-038's `XGROUP CREATE` and T-039's `XREADGROUP`. See `WORKER_STREAM_CONSTANTS` for why the
  // stream-name default is load-bearing and why the batch-size ceiling is a policy choice
  // rather than a protocol limit. Deliberately not `.trim()`ed, unlike the secret above:
  // usage-service's producer does not trim `REDIS_STREAM_NAME` either, and trimming one side
  // only would turn a padded override into exactly the producer/consumer divergence these
  // defaults exist to prevent.
  REDIS_STREAM_NAME: z.string().min(1).default(WORKER_STREAM_CONSTANTS.DEFAULT_STREAM_NAME),
  REDIS_CONSUMER_GROUP: z.string().min(1).default(WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_GROUP),
  REDIS_CONSUMER_NAME: z.string().min(1).default(WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_NAME),
  STREAM_BLOCK_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(WORKER_STREAM_CONSTANTS.DEFAULT_BLOCK_MS),
  STREAM_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(WORKER_STREAM_CONSTANTS.BATCH_SIZE_MIN)
    .max(WORKER_STREAM_CONSTANTS.BATCH_SIZE_MAX)
    .default(WORKER_STREAM_CONSTANTS.DEFAULT_BATCH_SIZE),
  // Dead-letter configuration (T-041, Q10). Read by `DeadLetterService`, which the container
  // wraps around the processor's handler. `.int()` is load-bearing rather than tidiness:
  // `z.coerce.number()` accepts "2.5", and a fractional budget makes the `>= MAX_RETRY_COUNT`
  // threshold comparison mean something nobody chose.
  MAX_RETRY_COUNT: z.coerce
    .number()
    .int()
    .min(WORKER_STREAM_CONSTANTS.MAX_RETRY_COUNT_MIN)
    .max(WORKER_STREAM_CONSTANTS.MAX_RETRY_COUNT_MAX)
    .default(WORKER_STREAM_CONSTANTS.DEFAULT_MAX_RETRY_COUNT),
  // `.min(1)`, matching the three stream-name fields above and **not** matching
  // usage-service's `REDIS_STREAM_NAME`, which has no `.min(1)` and parses `""` (S-23). An
  // empty destination would make `XADD "" ...` write to a key nothing can find.
  //
  // Deliberately not `.trim()`ed, for the reason the comment above gives about the other
  // stream names: trimming one side of a name that operators set per service recreates the
  // divergence the shared defaults exist to prevent. `.trim()` stays on
  // `INTERNAL_API_SECRET` only.
  DEAD_LETTER_STREAM: z
    .string()
    .min(1)
    .default(WORKER_STREAM_CONSTANTS.DEFAULT_DEAD_LETTER_STREAM)
})
  // Cross-field, so it cannot live on either field: zod's per-field refinements see only the
  // value they are attached to. `.superRefine` on the object is the only place both names exist
  // at once, and it runs after both fields have parsed and defaulted -- which matters, because
  // the collision an operator is most likely to create is between an explicit
  // `DEAD_LETTER_STREAM` and the *default* `REDIS_STREAM_NAME`.
  //
  // Startup, not runtime: `parseEnv` throws at module load, so a worker configured to republish
  // its own dead letters never reaches `app.listen`. The `path` names `DEAD_LETTER_STREAM`
  // because that is the field an operator should change -- `REDIS_STREAM_NAME` has to match
  // usage-service's producer and is not free to move.
  .superRefine((parsed, ctx) => {
    if (parsed.DEAD_LETTER_STREAM === parsed.REDIS_STREAM_NAME) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        // `satisfies` rather than a bare literal: renaming the field is already a type error at
        // the comparison above, but would be silent here, leaving the issue naming a field that
        // no longer exists (Gate-4 Round-2 R2-4).
        path: ["DEAD_LETTER_STREAM" satisfies keyof typeof parsed],
        message: WORKER_STREAM_CONSTANTS.DEAD_LETTER_STREAM_COLLISION
      });
    }
  });

export type ServiceEnv = z.infer<typeof EnvSchema>;

export const env = parseEnv(EnvSchema, process.env);
