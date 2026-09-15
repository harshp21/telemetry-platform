import { parseEnv } from "@telemetry/shared-config";
import { INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
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
  // Service-to-service auth (S-8 item 2). Required with no default: `parseEnv` throws at module
  // load, which is strictly earlier than the app build where `app.ts` used to read
  // `process.env.INTERNAL_API_SECRET ?? ""`, so a billing-service that cannot authenticate its
  // callers never reaches `app.listen`. Before this declaration a five-character secret booted
  // cleanly and authenticated callers: measured on `961d222` through `app.inject`,
  // `INTERNAL_API_SECRET=short` returned 200 from POST /v1/internal/billing/generate. The same
  // value now fails at module load, naming the field.
  //
  // `.trim()` runs before `.min(...)`, so length is measured on the trimmed value, and the order
  // is load-bearing rather than stylistic. Measured against this schema on zod 3.25.76, with 32
  // spaces as the value: `.min(32)` alone parses it verbatim, `.min(32).trim()` parses it to
  // `""`, and only `.trim().min(32)` raises an issue; a 31-character core padded to 35 is
  // likewise accepted by `.min(32).trim()` and rejected by `.trim().min(32)`. The reorder was run
  // against this schema and two named tests in `tests/env.schema.unit.test.ts` went red under it
  // -- "rejects an all-whitespace INTERNAL_API_SECRET at the minimum length" and "rejects an
  // INTERNAL_API_SECRET that reaches the minimum only by its padding". "strips surrounding
  // whitespace from an otherwise valid INTERNAL_API_SECRET" stayed green under both orders, so
  // that case alone would not have caught the wrong one.
  //
  // The trim also transforms the parsed value, which is the string `buildInternalAuthMiddleware`
  // compares byte-for-byte against the inbound header, so it narrows what the middleware accepts.
  // Scope of what was measured for *this* service's transport (fastify 5.10.0 on this host,
  // undici 7.29.0 and a raw `net.Socket`, four padding forms): SP- and HTAB-padded header values
  // arrived already stripped, so the trim is a no-op for those; an inbound header padded with
  // U+00A0 survives the wire byte-identical under every transport measured -- fastify 5.10.0,
  // undici 7.29.0 and a raw `net.Socket`. (Two probes disagreed on the raw socket, one reporting
  // U+00C2 U+00A0 and one U+00A0; settled at Gate 6 as the *probe's* write encoding -- utf8
  // versus latin1 -- not a transport difference. The conclusion is the same either way.)
  // It therefore no longer matches a trimmed configured secret,
  // which is a 401 rather than a silent acceptance. Nothing was measured about other clients or
  // proxies. (`app.inject` does not strip -- it bypasses the HTTP
  // parser -- which is why the tests assert the schema's output rather than inferring the
  // transform from an injected request.)
  INTERNAL_API_SECRET: z.string().trim().min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)
});

export type ServiceEnv = z.infer<typeof EnvSchema>;

export const env = parseEnv(EnvSchema, process.env);
