import { parseEnv } from "@telemetry/shared-config";
import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3100),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  JWT_SECRET: z.string().min(32),
  AUTH_SERVICE_URL: z.string().url(),
  USAGE_SERVICE_URL: z.string().url(),
  BILLING_SERVICE_URL: z.string().url(),
  ANALYTICS_SERVICE_URL: z.string().url(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(1000),
  INGESTION_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5000)
});

export type ServiceEnv = z.infer<typeof EnvSchema>;

export const loadEnv = (): ServiceEnv => {
  return parseEnv(EnvSchema, process.env) as ServiceEnv;
};
