import { parseEnv } from "@telemetry/shared-config";
import { EVENT_STREAM_CONSTANTS, INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  // Service-to-service auth (S-4). Required with no default: `parseEnv` throws at module load,
  // so a usage-service that cannot authenticate its callers never reaches `app.listen`.
  // `docs/reviewer-checklist.md` section 3.
  INTERNAL_API_SECRET: z.string().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH),
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
