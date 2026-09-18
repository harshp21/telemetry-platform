import { parseEnv } from "@telemetry/shared-config";
import { z } from "zod";
import { ANALYTICS_SERVICE_STARTUP } from "../startup.constants";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // No read of the parsed `env.PORT` was found under `apps/<service>/src` or
  // `packages/<pkg>/src`: `src/index.ts` binds
  // `process.env.PORT ?? ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT` directly, as all six services
  // do. Defaulting from the same constant keeps the declaration honest about the port the
  // service actually binds -- it read 3000 until T-050, while the `.env.example`, the compose
  // environment, the published port mapping and gateway's address for this service all used
  // 3005.
  //
  // Imported from `../startup.constants` rather than `../constants` deliberately, mirroring
  // billing (T-044): `startup.constants.ts` is the one module `index.ts` loads before
  // `initTracing(...)`, and it must stay import-free. Do **not** wire the parsed value into
  // `index.ts` -- a static import of this module there hoists zod and
  // `@telemetry/shared-config` ahead of `initTracing`, which is what the dynamic
  // `await import("./app")` exists to avoid.
  PORT: z.coerce.number().int().positive().default(ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
  LOG_LEVEL: z.string().default("info")
});

export type ServiceEnv = z.infer<typeof EnvSchema>;

export const env = parseEnv(EnvSchema, process.env);
