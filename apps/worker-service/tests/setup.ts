// Vitest setup file - set up environment variables before tests run
process.env.NODE_ENV ??= "test";
process.env.PORT ??= "3003";
// Runtime role: NOSUPERUSER / NOBYPASSRLS, so any test that reaches a live database
// exercises RLS the way production does. Do not point this at the admin role.
//
// **`telemetry_worker_app`, not `telemetry_app`, since T-042.** worker-service has a role of
// its own because it is the one service that must read *across* tenants -- to answer "which
// tenants had unbilled usage yesterday" -- and `prisma/migrations/v1_7_worker_billing_enumerator`
// grants `EXECUTE` on that one `SECURITY DEFINER` resolver to this role **alone**, revoked from
// `PUBLIC` and from the `telemetry_app` the other five services share. Pointing this at
// `telemetry_app` would leave `billing-enumeration.integration.test.ts` failing on `permission
// denied` for the resolver, which reads as a wiring problem rather than as the wrong role under
// test -- so that suite pins `current_user` by name and throws.
//
// This is also what makes `pnpm test` exercise the real role: turbo runs in strict env mode, so
// the job-level variables in `.github/workflows/ci.yml` do **not** reach the test step.
//
// The role's table grants are deliberately narrower than `telemetry_app`'s -- DML on `"Event"`
// and `"UsageLine"` only, with no blanket default grant -- so this line also puts every other
// worker-service suite on the least-privilege connection the service actually uses.
process.env.DATABASE_URL ??=
  "postgresql://telemetry_worker_app:telemetry_worker_app_local_dev@localhost:5432/telemetry";
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
// billing-service base URL for the nightly invoice job (T-042). Required by the env schema with
// no default, so every suite that builds the container or imports `src/config/env` needs it set.
process.env.BILLING_SERVICE_URL ??= "http://localhost:3004";
