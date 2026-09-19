// Vitest setup file - set up environment variables before tests run
process.env.NODE_ENV ??= "test";
process.env.PORT ??= "3005";
// Runtime role: NOSUPERUSER / NOBYPASSRLS, so any test that reaches a live database
// exercises RLS the way production does. Do not point this at the admin role.
process.env.DATABASE_URL ??=
  "postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry";
process.env.DIRECT_DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/telemetry";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://localhost:4318";
process.env.LOG_LEVEL ??= "silent";
// S-9. `src/config/env.ts` parses at module load and this field has no default, so without this
// line every suite that imports `src/app.ts` or `src/config/env.ts` fails at *import*. The same
// 45-character value billing-service and worker-service use, rather than a third spelling: it is
// printable ASCII and above `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH`. Turbo runs tests under
// strict env mode, so this file -- not CI's job-level variable -- is what feeds `pnpm test`.
process.env.INTERNAL_API_SECRET ??= "test-internal-api-secret-change-in-production";
