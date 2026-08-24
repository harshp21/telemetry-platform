# Epic 12 — Testing & Quality Gates

**Milestone**: v1-mvp (unit + migration), v1 (integration + load)
**Depends on**: Each service epic — write tests alongside each service, not after

---

## T-066 · Unit tests: shared packages

**Files**: `packages/shared-*/tests/`
**Milestone**: v1-mvp

**Coverage targets**:

| Package | What to test | Target |
|---|---|---|
| `shared-utils` | All functions, all branches | 100% branch |
| `shared-validation` | Each schema: valid + invalid + edge cases | 100% branch |
| `shared-config` | `parseEnv` throws with field name on missing required var | 100% branch |
| `shared-logger` | Logger factory returns Pino instance with correct `service` field | Functional |
| `shared-tracing` | `initTracing` does not throw; no-ops if OTLP endpoint absent | Functional |

**Key test cases for `shared-utils`**:
```ts
// generateIdempotencyKey — determinism
expect(generateIdempotencyKey("t1", "api.request", "2026-01-01T00:00:00Z"))
  .toBe(generateIdempotencyKey("t1", "api.request", "2026-01-01T00:00:00Z"));

// retryWithBackoff — throws after max attempts
await expect(retryWithBackoff(() => Promise.reject(new Error("fail")), { maxAttempts: 3, baseDelayMs: 1 }))
  .rejects.toThrow("fail");

// chunkArray — handles empty array
expect(chunkArray([], 5)).toEqual([]);
```

---

## T-067 · Database migration CI check

**File**: `.github/workflows/ci.yml`
**Milestone**: v1-mvp

**Story**: Catch schema drift between the Prisma schema file and generated migrations before it reaches production.

**CI step**:
```yaml
- name: Check migration status
  run: |
    docker compose -f docker/docker-compose.yml up -d postgres
    sleep 5
    pnpm prisma migrate deploy
    pnpm prisma migrate status
  env:
    DATABASE_URL: postgresql://postgres:postgres@localhost:5432/telemetry_test
```

**Fail condition**: `prisma migrate status` exits non-zero (pending migrations detected = schema was edited without running `migrate dev`).

---

## T-068 · Smoke tests: all services against Docker Compose

**Files**: `apps/{service}/tests/smoke.test.ts`
**Milestone**: v1

**Story**: Expand the existing stub `smoke.test.ts` in each service. Start the full Docker Compose stack in CI and hit `/health` against each service's real port.

**Pattern**:
```ts
describe("smoke", () => {
  it("health check returns ok", async () => {
    const response = await fetch(`http://localhost:${port}/health`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", service: serviceName });
  });
});
```

**CI setup**:
```yaml
- name: Start services
  run: docker compose up -d --wait
- name: Run smoke tests
  run: pnpm test:smoke
```

---

## T-069 · k6 load test: ingestion path

**File**: `k6/ingestion.js`
**Milestone**: v1

**Story**: Validate the ingestion pipeline holds up under sustained load. Tests the full path: gateway → usage-service → Redis Streams.

**Test parameters**:
```js
export const options = {
  scenarios: {
    sustained: {
      executor: "constant-arrival-rate",
      rate: 500,          // 500 req/s
      timeUnit: "1s",
      duration: "60s",
      preAllocatedVUs: 50,
    },
  },
  thresholds: {
    http_req_duration: ["p(99)<200"],   // p99 < 200ms
    http_req_failed: ["rate<0.001"],    // error rate < 0.1%
  },
};
```

**Payload**: Batch of 10 events per request (`quantity` random 1–1000, `eventType` one of 5 types).

**Post-run assertions** (manual or scripted):
- Dead-letter stream length = 0
- No `UsageLine` records with `billed = false` older than 60s (worker kept up)

---

## T-070 · Service coverage thresholds and CI gate (auth-service first)

**Files**:
- `apps/auth-service/vitest.config.mjs`
- `apps/auth-service/package.json`
- `.github/workflows/ci.yml`

**Story**: Ensure service-level coverage is measurable and enforced in CI starting with auth-service, then replicate pattern to other services.

**Auth-service thresholds**:
- statements >= 80
- lines >= 80
- functions >= 80
- branches >= 75

**CI expectations**:
- start required infra dependencies for auth tests
- apply Prisma migrations before auth coverage run
- fail the workflow if auth coverage thresholds are not met
