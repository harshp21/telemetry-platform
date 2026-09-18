import { parseEnv } from "@telemetry/shared-config";
import { internalApiSecretSchema } from "@telemetry/shared-validation";
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
  // billing-service's base URL, for the nightly invoice job's call into
  // `POST /v1/internal/billing/generate` (T-042). `z.string().url()` and no default, matching
  // gateway's declaration at `apps/gateway/src/config/env.ts:17` -- gateway is the only other
  // service that holds this field, and it declares it the same way. Required rather than
  // optional: `parseEnv` throws at module load, so a worker that cannot reach billing never
  // reaches `app.listen` rather than discovering it at 02:00.
  //
  // `.url()` rather than `.min(1)` because this value is concatenated with a path constant, so a
  // relative or malformed value builds a URL `fetch` rejects at the first nightly run and at no
  // earlier moment.
  //
  // **Scope of `.url()`, measured rather than assumed** (zod 3.25.76): it delegates to
  // `new URL(...)` and therefore accepts *any* scheme -- `"billing-service:3004"` parses, with
  // protocol `billing-service:`, while `"not a url"`, `"/v1/internal"` and `""` are rejected. So
  // this guards against truncation, not against a wrong scheme. Not tightened to `^https?:`
  // here: `apps/gateway/src/config/env.ts:17` declares the same field name as a bare `.url()`,
  // and one service enforcing a stricter rule than the other on the same operator-supplied value
  // is the divergence S-23 and S-39 are about. Pinned in `tests/env.schema.unit.test.ts`.
  BILLING_SERVICE_URL: z.string().url(),
  LOG_LEVEL: z.string().default("info"),
  // Service-to-service auth. **Derived from one shared fragment, never re-declared** (S-8):
  // `internalApiSecretSchema` in `@telemetry/shared-validation` is the single definition of what
  // a valid `INTERNAL_API_SECRET` is -- trimmed, at least
  // `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` long, printable ASCII only. Four services used to
  // write this rule out separately and two of them had drifted, which is not a tidiness problem:
  // both HTTP clients in this stack strip leading and trailing SP/HTAB from a header value in
  // transit, so one stray space in a platform-wide secret made the two trimming services answer
  // `200` and the two untrimmed ones answer `401` for the same configuration. Re-derived over a
  // real socket against the real guard factories at S-8:
  //     gateway sends padded -> usage   (untrimmed expected): 401
  //     gateway sends padded -> billing (trimmed   expected): 200
  //
  // What the fragment adds over the `.trim().min(...)` this service used to declare is the
  // printable-ASCII rule. The trim was never a guard against invisible characters -- it strips
  // the ECMAScript WhiteSpace + LineTerminator set and nothing else -- so a secret of 32 x U+00AD
  // parsed cleanly here, transmitted intact, and authenticated `200` through the real proxy.
  //
  // Do not re-inline the rule here even with an identical spelling -- this service's env suite
  // asserts this field **is** the shared object, so a local copy reddens rather than drifting.
  // Required with no default: `parseEnv` throws at module load, so a service that cannot
  // authenticate its callers never reaches `app.listen`.
  INTERNAL_API_SECRET: internalApiSecretSchema,
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
