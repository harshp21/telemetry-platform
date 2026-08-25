// Vitest setup file - set up environment variables before tests run
process.env.NODE_ENV ??= "test";
process.env.PORT ??= "3002";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/telemetry";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://localhost:4318";
process.env.LOG_LEVEL ??= "silent";
