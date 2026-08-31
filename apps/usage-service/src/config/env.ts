import { parseEnv } from "@telemetry/shared-config";
import { INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
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
  // Redis Streams configuration
  REDIS_STREAM_NAME: z.string().default("telemetry:events"),
  STREAM_MAX_LEN: z.coerce.number().int().positive().default(100_000),
  INGEST_BATCH_MAX: z.coerce.number().int().min(1).max(100).default(100)
});

export type ServiceEnv = z.infer<typeof EnvSchema>;

export const env = parseEnv(EnvSchema, process.env);
