import { parseEnv } from "@telemetry/shared-config";
import { z } from "zod";
import {
  AUTH_TOKENS,
  AUTH_VALIDATION,
  AUTH_RUNTIME
} from "../constants";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(AUTH_RUNTIME.DEFAULT_PORT),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_ACCESS_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(AUTH_TOKENS.ACCESS_TTL_SECONDS_MAX)
    .default(AUTH_TOKENS.ACCESS_TTL_SECONDS_DEFAULT),
  JWT_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(AUTH_TOKENS.REFRESH_TTL_SECONDS_DEFAULT),
  BCRYPT_ROUNDS: z.coerce
    .number()
    .int()
    .min(AUTH_VALIDATION.BCRYPT_MIN_ROUNDS)
    .max(AUTH_VALIDATION.BCRYPT_MAX_ROUNDS)
    .default(AUTH_VALIDATION.BCRYPT_DEFAULT_ROUNDS)
});

export type ServiceEnv = z.infer<typeof EnvSchema>;

export const env = parseEnv(EnvSchema, process.env) as Readonly<ServiceEnv>;
