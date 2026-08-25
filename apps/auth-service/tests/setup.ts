// Vitest setup file - set up environment variables before tests run
process.env.NODE_ENV ??= "test";
process.env.PORT ??= "3001";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/telemetry";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://localhost:4318";
process.env.LOG_LEVEL ??= "silent";
process.env.JWT_SECRET ??= "test-jwt-secret-value-with-at-least-32-characters";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-value-with-at-least-32-chars";
process.env.JWT_ACCESS_TTL_SECONDS ??= "900";
process.env.JWT_REFRESH_TTL_SECONDS ??= "604800";
process.env.BCRYPT_ROUNDS ??= "12";
