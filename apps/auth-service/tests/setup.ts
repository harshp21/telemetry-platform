// Vitest setup file - set up environment variables before tests run
import { TEST_DATABASE_URLS } from "./database-urls";

process.env.NODE_ENV ??= "test";
process.env.PORT ??= "3001";
// auth-service's own least-privilege role: NOSUPERUSER, NOBYPASSRLS, owner of no table, and
// the only role that may EXECUTE the pre-authentication resolvers created by
// prisma/migrations/v1_5_auth_tenant_resolvers -- which must be applied first. This is what
// makes the RLS policies enforce for auth-service, and what the integration suites assert
// through.
process.env.DATABASE_URL ??= TEST_DATABASE_URLS.AUTH_APP;
process.env.DIRECT_DATABASE_URL ??= TEST_DATABASE_URLS.ADMIN;
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://localhost:4318";
process.env.LOG_LEVEL ??= "silent";
process.env.JWT_SECRET ??= "test-jwt-secret-value-with-at-least-32-characters";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-value-with-at-least-32-chars";
process.env.JWT_ACCESS_TTL_SECONDS ??= "900";
process.env.JWT_REFRESH_TTL_SECONDS ??= "604800";
process.env.BCRYPT_ROUNDS ??= "12";
