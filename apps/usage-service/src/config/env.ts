import { parseEnv } from "@telemetry/shared-config";
import { EVENT_STREAM_CONSTANTS } from "@telemetry/shared-types";
import { internalApiSecretSchema } from "@telemetry/shared-validation";
import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
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
  // Do not re-inline the rule here even with an identical spelling -- each service's env suite
  // asserts this field **is** the shared object, so a local copy reddens rather than drifting.
  // Required with no default: `parseEnv` throws at module load, so a service that cannot
  // authenticate its callers never reaches `app.listen`. `docs/reviewer-checklist.md` section 3.
  INTERNAL_API_SECRET: internalApiSecretSchema,
  // Redis Streams configuration. This default -- not `STREAM_CONSTANTS.DEFAULT_STREAM_NAME` --
  // is the value `StreamPublisher` actually XADDs to: `stream.publisher.ts:35-36` resolves
  // `env.REDIS_STREAM_NAME || STREAM_CONSTANTS.DEFAULT_STREAM_NAME`, and because this default
  // always applies the right-hand fallback is unreachable. Both now come from the same shared
  // constant, so which one wins no longer changes the answer.
  REDIS_STREAM_NAME: z.string().default(EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM),
  STREAM_MAX_LEN: z.coerce.number().int().positive().default(100_000),
  INGEST_BATCH_MAX: z.coerce.number().int().min(1).max(100).default(100)
});

export type ServiceEnv = z.infer<typeof EnvSchema>;

export const env = parseEnv(EnvSchema, process.env);
