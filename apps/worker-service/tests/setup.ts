// Vitest setup file - set up environment variables before tests run
process.env.NODE_ENV ??= "test";
process.env.PORT ??= "3003";
// Runtime role: NOSUPERUSER / NOBYPASSRLS, so any test that reaches a live database
// exercises RLS the way production does. Do not point this at the admin role.
process.env.DATABASE_URL ??=
  "postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry";
process.env.DIRECT_DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/telemetry";
// Logical database **14**, worker-service's reserved index -- not the bare
// `redis://localhost:6379`, which selects db 0 and holds the developer's live `telemetry:events`.
//
// This is a mechanism, not a convention, and it exists because the convention failed. The two
// integration suites already point themselves at 14 (`redisUrl.pathname = "/14"` in each), so the
// exposure was always *unit* tests -- which are not supposed to reach Redis at all.
// `createContainer` builds a real `lazyConnect` ioredis client from `REDIS_URL`, so any unit test
// that drives `container.messageHandler` without stubbing **every** command the handler issues
// sends the unstubbed one to a real server.
//
// Reproduced twice. During T-041's implementation, `tests/config/container.unit.test.ts` stubbed
// `hget` alone; the unstubbed `hincrby` on the failure path incremented
// `retries:telemetry:events` on db 0, and on the third run the counter reached the default retry
// budget and wrote two records to a `telemetry:dead-letter` stream on db 0 (cleaned up by hand;
// `telemetry:events` itself was untouched). The Gate-4 reviewer then removed one stub again and
// recorded the escaping `hincrby` under `redis-cli MONITOR`. Re-measured here after this change:
// with the `hincrby` stub removed and no `REDIS_URL` override, the key landed in db **14**.
//
// Why stubs alone cannot be the guard: `vi.spyOn` patches one *instance*, and each
// `createContainer()` returns a fresh client, so stubs cover only the test that installed them;
// and this package's `afterEach` is `clearAllMocks`, not `restoreAllMocks`. Enumerating the
// commands a service issues is a list that goes stale the moment the service issues a seventh.
process.env.REDIS_URL ??= "redis://localhost:6379/14";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://localhost:4318";
process.env.LOG_LEVEL ??= "silent";
process.env.INTERNAL_API_SECRET ??= "test-internal-api-secret-change-in-production";
