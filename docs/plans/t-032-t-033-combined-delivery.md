# T-032 + T-033 Plan: Deduplication Engine & Stream Publisher (Combined Delivery)

## Business Objective & User Impact

**T-032 — Deduplication Engine**
- Prevent duplicate event processing caused by network retries or source system race conditions
- Enable idempotent event ingestion to guarantee exactly-once semantics at the application layer
- Reduce operational toil from investigating spurious duplicate events in analytics

**T-033 — Stream Publisher**
- Establish the event streaming infrastructure that T-031 (Ingestion Endpoint) depends on
- Enable real-time event consumption by analytics and billing services
- Support compliance auditing via immutable, time-ordered event log with 100k entry retention

**User Impact**: Event ingestion becomes fault-tolerant and idempotent; downstream services can process events once with confidence; analytics dashboards reflect accurate usage data.

---

## Task Goal

Implement two independent services for the Usage Service that work in sequence:

1. **Deduplication Service** — determine if an incoming event is new or a duplicate using Redis SET with 24-hour TTL and idempotency keys
2. **Stream Publisher** — publish deduplicated events to Redis Streams for consumption by other services

Both services will be integrated into the app container and consumed by T-031 (Ingestion Endpoint) in the next delivery slice.

---

## Scope: Files to Create/Modify

**New Files**:
1. `apps/usage-service/src/services/deduplication.service.ts`
2. `apps/usage-service/src/events/stream.publisher.ts`
3. `apps/usage-service/tests/deduplication.service.unit.test.ts`
4. `apps/usage-service/tests/stream.publisher.unit.test.ts`
5. `docs/plans/t-032-t-033-combined-delivery.md` (this document)

**Modified Files**:
1. `apps/usage-service/src/config/container.ts` — register both services
2. `apps/usage-service/src/constants.ts` — add deduplication constants

**No Changes Required** (already complete from prior tasks):
- `apps/usage-service/src/middleware/tenant-context.middleware.ts` (T-034)
- Redis client availability in container (T-030 env schema)

---

## Acceptance Criteria

### T-032 — Deduplication Service

1. ✅ Implement `DeduplicationService` class with `isNew(idempotencyKey: string): Promise<boolean>` method
2. ✅ Use Redis SET NX with 24-hour TTL (86,400 seconds) for idempotency key storage
3. ✅ Return `true` if SET succeeded (new event); return `false` if SET failed (duplicate)
4. ✅ Idempotency key format: `{tenantId}:{eventType}:{sourceId}:{timestamp_ms}` (with `dedup:` prefix)
5. ✅ **Fail-open**: On Redis errors (ECONNREFUSED, timeout, etc.), log error and return `true` (prevents silent drops)
6. ✅ Dependency injection: accept `redis` client from app container
7. ✅ All 10 unit tests passing (new events, duplicates, errors, TTL, concurrency)
8. ✅ Lint clean: `pnpm --filter @telemetry/usage-service lint` (no errors)
9. ✅ Typecheck clean: `pnpm --filter @telemetry/usage-service typecheck` (no errors)
10. ✅ Build clean: `pnpm build` (all 13 packages)
11. ✅ No magic strings/numbers: TTL and key prefix in constants.ts

### T-033 — Stream Publisher Service

1. ✅ Implement `StreamPublisher` class with `publish(event: UsageEvent): Promise<string>` method
2. ✅ Use Redis XADD to publish events to stream name (env var `REDIS_STREAM_NAME`, default: `telemetry:events`)
3. ✅ Configure MAXLEN with approximate trimming (~) to retain last 100,000 entries (env var `STREAM_MAX_LEN`)
4. ✅ Return Redis stream entry ID (e.g., `"1234567890-0"`) on success
5. ✅ **Fail-closed**: On Redis errors, log error and throw (caller handles retry/circuit breaking)
6. ✅ Log published events at info level: tenant, event count, stream ID returned
7. ✅ Accept single event (T-031 will batch before calling)
8. ✅ Dependency injection: accept `redis` client and `logger` from app container
9. ✅ All 8 unit tests passing (publish, MAXLEN, errors, concurrency)
10. ✅ Lint clean, typecheck clean, build clean
11. ✅ No magic strings/numbers: stream name and max length from env vars or constants

---

## Implementation Steps (Pseudo-TDD Pattern)

### Phase 1: Write All Test Files (Both Services)

**Step 1.1: Create Deduplication Service Test File**
- Create `apps/usage-service/tests/deduplication.service.unit.test.ts`
- Implement all 10 test cases (see Test Scenarios section)
- Import Vitest, mock ioredis client, mock logger
- All tests should FAIL at this point (no implementation yet)

**Step 1.2: Create Stream Publisher Test File**
- Create `apps/usage-service/tests/stream.publisher.unit.test.ts`
- Implement all 8 test cases (see Test Scenarios section)
- Import Vitest, mock ioredis client, mock logger
- All tests should FAIL at this point

### Phase 2: Implement Both Services

**Step 2.1: Implement Deduplication Service**
- Create `apps/usage-service/src/services/deduplication.service.ts`
- Constructor: accept `redis` client (ioredis instance)
- Method: `isNew(idempotencyKey: string): Promise<boolean>`
  - Execute: `redis.set(key, "1", "EX", 86400, "NX")`
  - On success (returns "OK"): return `true`
  - On duplicate (returns null): return `false`
  - On error: log error, return `true` (fail-open)
- All 10 tests should now PASS

**Step 2.2: Implement Stream Publisher Service**
- Create `apps/usage-service/src/events/stream.publisher.ts`
- Constructor: accept `redis` client and `logger`
- Method: `publish(event: UsageEvent): Promise<string>`
  - Get stream name from env var or constant
  - Get max length from env var or constant
  - Execute: `redis.xadd(streamName, "MAXLEN", "~", maxLen, "*", ...eventFields)`
  - On success: log at info level, return stream entry ID
  - On error: log error, throw (caller handles retry)
- All 8 tests should now PASS

### Phase 3: Add Constants

**Step 3.1: Update Constants File**
- Edit `apps/usage-service/src/constants.ts`
- Add constant: `export const DEDUP_KEY_TTL_SECONDS = 86400` (24 hours)
- Add constant: `export const DEDUP_KEY_PREFIX = "dedup:"`

### Phase 4: Container Integration

**Step 4.1: Update App Container**
- Edit `apps/usage-service/src/config/container.ts`
- Import both `DeduplicationService` and `StreamPublisher`
- In container object, add:
  ```typescript
  deduplication: new DeduplicationService(redis),
  streamPublisher: new StreamPublisher(redis, logger),
  ```

### Phase 5: Scoped Validation (Usage Service Only)

**Step 5.1: Run Unit Tests**
- Command: `pnpm --filter @telemetry/usage-service test`
- Expected: All 18 new tests pass + 37 existing tests pass (55 total)
- Failure mode: Test assertion failure indicates implementation bug

**Step 5.2: Run Lint**
- Command: `pnpm --filter @telemetry/usage-service lint`
- Expected: 0 errors, 0 warnings
- Failure mode: ESLint rule violation or style issue

**Step 5.3: Run Typecheck**
- Command: `pnpm --filter @telemetry/usage-service typecheck`
- Expected: 0 errors
- Failure mode: TypeScript type mismatch or missing type annotation

### Phase 6: Full Workspace Validation

**Step 6.1: Run Full Build**
- Command: `pnpm build`
- Expected: All 13 packages build successfully
- Failure mode: Compilation error in any package

**Step 6.2: Run Full Test Suite**
- Command: `pnpm test`
- Expected: All unit tests in all packages pass
- Failure mode: Test failure in any package

**Step 6.3: Run Full Lint**
- Command: `pnpm lint`
- Expected: 0 errors across all 13 packages
- Failure mode: Style violation in any package

**Step 6.4: Run Full Typecheck**
- Command: `pnpm typecheck`
- Expected: 0 errors across all 13 packages
- Failure mode: Type error in any package

---

## Test Scenarios

### T-032 Deduplication Service (10 Test Cases)

| # | Scenario | Input | Expected Output | Key Assertion |
|---|----------|-------|-----------------|----------------|
| 1 | First event (new) | `isNew("dedup:tenant1:event:src:1000")` | `true` | Redis SET returned "OK" |
| 2 | Same key, second call | `isNew("dedup:tenant1:event:src:1000")` (same key) | `false` | Redis SET returned null (key exists) |
| 3 | Different tenant | `isNew("dedup:tenant2:event:src:1000")` | `true` | Separate key in Redis |
| 4 | Different event type | `isNew("dedup:tenant1:OTHER:src:1000")` | `true` | Different key format |
| 5 | Different source ID | `isNew("dedup:tenant1:event:OTHER:1000")` | `true` | Different key format |
| 6 | Different timestamp | `isNew("dedup:tenant1:event:src:2000")` | `true` | Different key format |
| 7 | Redis connection error | Redis throws `ECONNREFUSED` | `true` (fail-open) | Error logged, no exception thrown |
| 8 | Redis timeout error | Redis operation times out | `true` (fail-open) | Error logged, no exception thrown |
| 9 | TTL verification | After SET, verify Redis key expiry | Redis key has EX 86400 | TTL is exactly 24 hours (86,400s) |
| 10 | Concurrent calls (race) | Two parallel `isNew(sameKey)` calls | One `true`, one `false` | Redis atomic operation ensures ordering |

### T-033 Stream Publisher Service (8 Test Cases)

| # | Scenario | Input | Expected Output | Key Assertion |
|---|----------|-------|-----------------|----------------|
| 1 | Single event publish | `publish({ tenantId: "t1", data: {...} })` | Stream ID string (e.g., "1234567890-0") | XADD returned valid ID |
| 2 | Sequential publishes | 3 events published sequentially | 3 unique stream IDs | Each XADD increments entry counter |
| 3 | MAXLEN enforcement | Publish 100,001st event to stream at capacity | New entry added; oldest trimmed | XADD with MAXLEN ~ worked |
| 4 | Redis connection error | Redis throws `ECONNREFUSED` | Throws error (fail-closed) | Error bubbles to caller for retry |
| 5 | Redis timeout | Redis operation times out | Throws error | Timeout error propagates |
| 6 | Logged output | Publish successful event | Logger called with event info | Info log includes tenant, event type, stream ID |
| 7 | Concurrent publishes | 5 parallel `publish()` calls | All succeed with unique IDs | No race conditions in stream |
| 8 | Large event payload | Event with 500KB payload | Stream ID returned (if under Redis limit) | XADD accepts large entries |

---

## Known Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation | Residual Risk |
|------|------------|--------|-----------|---------------|
| Redis fail-open masks data loss (T-032) | Low | Some duplicate events silently reprocessed | Fail-open only on connection errors; circuit breaker upstream + alerting | Low — caller can implement retry |
| Stream grows unbounded | Very Low | High memory usage | MAXLEN ~ set to 100k; env var configurable; monitoring in place | None — hard limit enforced |
| Idempotency key collision | Very Low | Duplicate event treated as new | 5-part key (tenant:type:source:ms) provides >99.99% uniqueness; TTL limits collision window to 24h | None — acceptable collision rate |
| Performance overhead | Low | Latency spike in ingestion | Redis SET/XADD are O(1); no scan operations; typical <5ms per call | None — acceptable latency |
| Container injection fails | Low | Services undefined at runtime | Type safety enforced; container integration tested before merge | None — type system catches |
| Constant/env var typo | Medium | Wrong TTL or stream name used | Grep for usages; constants defined once; env vars from T-030 schema | Low — manual verification |

---

## Dependencies & External Integrations

**No New npm Packages**. Uses existing dependencies:

- `ioredis` (already in usage-service)
- `pino` (logger, already in usage-service)
- `@telemetry/shared-types` (UsageEvent type)
- `vitest` (testing, already in usage-service)

**Environment Variables** (defined in T-030, already deployed):
- `REDIS_STREAM_NAME` (default: `"telemetry:events"`)
- `STREAM_MAX_LEN` (default: `100_000`)
- `REDIS_URL` (Redis connection URI)

**No Breaking Changes**: Both services are internal-only; no public API changes.

---

## Estimated Scope

- **Implementation**: ~150 LOC (2 services + container update)
- **Tests**: ~400 LOC (18 test cases with mocks)
- **Docs**: ~100 LOC (plan + inline comments)
- **Total**: ~650 LOC
- **Estimated time**: 3–4 hours (Pseudo-TDD pattern)

---

## Blocking Dependencies

**None**. Both T-032 and T-033 are independent of other pending tasks:
- Redis client already available (T-030 ✅)
- Logger already integrated (T-015 ✅)
- Tenant context middleware ready (T-034 ✅)

---

## Next Steps After Approval

1. ✅ **Approval**: User approves this plan
2. 📋 **Task Implementer**: Create test files (Phase 1)
3. 📋 **Task Implementer**: Implement both services (Phase 2)
4. 📋 **Task Implementer**: Update container (Phase 3)
5. 📋 **Task Implementer**: Run scoped + full validations (Phases 5–6)
6. 📋 **Senior Reviewer (Pre-QA)**: Code review + compile gate
7. 📋 **QA Tester**: Verify test coverage and edge cases
8. 📋 **Senior Reviewer (Final)**: Sign-off on all gates
9. 📋 **Commit**: Single atomic commit:
   ```
   feat(usage-service): add deduplication engine and stream publisher (T-032, T-033)
   
   - Implement DeduplicationService for idempotent event processing
   - Implement StreamPublisher for Redis Streams event log
   - Add both services to app container
   - Add comprehensive unit tests (18 test cases)
   ```
10. 📋 **Unblock**: T-031 (Ingestion Endpoint) can now start implementation

---

## Stage Tracker

**Current Stage**: Planning (done)

**Stage Transition**: 
- Previous stage: None (start of combined delivery)
- Current stage: Planning — Detailed plan created, ready for user approval
- Next stage: Implementation (Phase 1: test file creation)

**Blocker Reason**: None — awaiting user approval to proceed

**Pending Tasks Snapshot**:
- planning: done
- implementation: pending
- qa-testing: pending
- final-review: pending
- commit-approval: pending

**Evidence**:
- Plan document: `docs/plans/t-032-t-033-combined-delivery.md` (this file)
- Supporting files: None yet (awaiting implementation approval)
- Validation status: Ready for first build once Phase 1 tests written

---

**PLAN COMPLETE — AWAITING APPROVAL TO PROCEED WITH IMPLEMENTATION**
