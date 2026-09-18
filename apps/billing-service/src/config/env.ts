import { parseEnv } from "@telemetry/shared-config";
import { internalApiSecretSchema } from "@telemetry/shared-validation";
import { z } from "zod";
import { BILLING_SERVICE_STARTUP } from "../startup.constants";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Nothing reads the parsed `env.PORT`: `src/index.ts` binds
  // `process.env.PORT ?? BILLING_SERVICE_STARTUP.DEFAULT_PORT` directly. Defaulting from the same
  // constant keeps the declaration honest about the port the service actually binds -- it read
  // 3000 until T-044, while the service, the compose image and the gateway all used 3004.
  PORT: z.coerce.number().int().positive().default(BILLING_SERVICE_STARTUP.DEFAULT_PORT),
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
  INTERNAL_API_SECRET: internalApiSecretSchema
});

export type ServiceEnv = z.infer<typeof EnvSchema>;

export const env = parseEnv(EnvSchema, process.env);
