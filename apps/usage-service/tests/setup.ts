// Vitest setup file - set up environment variables before tests run
process.env.NODE_ENV ??= "test";
process.env.PORT ??= "3002";
// Runtime role: NOSUPERUSER / NOBYPASSRLS, so RLS enforces (see rls.enforcement.integration.test.ts).
process.env.DATABASE_URL ??=
  "postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry";
// Admin/owner role: seeds fixtures that RLS would otherwise block for the runtime role.
process.env.DIRECT_DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/telemetry";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://localhost:4318";
process.env.LOG_LEVEL ??= "silent";
// Service-to-service auth (S-4). Required by the env schema, so every suite that imports
// src/config/env -- directly or through src/app -- needs it set before module load.
// Must satisfy INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH (32).
process.env.INTERNAL_API_SECRET ??= "test-internal-api-secret-at-least-32-chars";
