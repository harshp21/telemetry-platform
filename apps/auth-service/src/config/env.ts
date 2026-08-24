import { parseEnv } from "@telemetry/shared-config";
import { z } from "zod";
import { AUTH_TOKENS } from "../constants";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(AUTH_TOKENS.ACCESS_TTL_SECONDS_MAX)
    .default(AUTH_TOKENS.ACCESS_TTL_SECONDS_DEFAULT),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12)
});

export type ServiceEnv = z.infer<typeof EnvSchema>;

export const env = parseEnv(EnvSchema, process.env);
