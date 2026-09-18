import { parseEnv } from "@telemetry/shared-config";
import { internalApiSecretSchema } from "@telemetry/shared-validation";
import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3100),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  JWT_SECRET: z.string().min(32),
  // Service-to-service auth: the gateway proves it is the caller to every upstream it proxies
  // to (S-4). Required with no default, for the same fail-fast reason as JWT_SECRET -- and
  // gateway is the *sender*, which is why its declaration could not stay the loose one: the
  // value parsed here is the value every upstream receives.
  // **Derived from one shared fragment, never re-declared** (S-8):
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
  INTERNAL_API_SECRET: internalApiSecretSchema,
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
