# T-031: Event Ingestion Endpoint — Execution Plan

**Date**: 2026-08-26  
**Task ID**: T-031  
**Task Name**: Event Ingestion Endpoint — `POST /v1/usage/events`  
**Epic**: Epic 6 (Usage Service)  
**Status**: Ready for Implementation Approval  

---

## Business Objective

Enable telemetry event ingestion through a scalable, idempotent endpoint that accepts batches of usage events (API requests, billing events, etc.) with per-tenant isolation, deduplicates via Redis, and publishes to streams for downstream analytics and billing consumption.

### User Impact
- **Platform users** submit telemetry batches via `POST /v1/usage/events`
- **Analytics service** consumes deduplicated events from Redis Streams
- **Billing service** processes deduplicated usage events for invoice generation
- **Idempotency guarantees** prevent double-charging and duplicate metrics

---

## Scope Boundary

### Files to Create (6)
1. `apps/usage-service/src/controllers/events.controller.ts` — HTTP handler
2. `apps/usage-service/src/services/ingestion.service.ts` — Business logic & orchestration
3. `apps/usage-service/src/routes/events.routes.ts` — Fastify route registration
4. `apps/usage-service/src/validators/events.validator.ts` — Zod schemas
5. `apps/usage-service/tests/events.controller.unit.test.ts` — Controller tests (6–8 scenarios)
6. `apps/usage-service/tests/ingestion.service.unit.test.ts` — Service tests (10–12 scenarios)

### Files to Modify (2)
- `apps/usage-service/src/app.ts` — Remove inline route, register via routes file
- `apps/usage-service/src/config/container.ts` — Add IngestionService & EventsController to AppContainer

---

## Acceptance Criteria (Complete Coverage)

### Controller (HTTP Interface)
- ✅ AC #1: Route registered at `POST /v1/usage/events`
- ✅ AC #2: Accepts `X-Tenant-Id` header (via T-034 middleware)
- ✅ AC #3: Accepts JSON body with event array: `{ events: EventPayload[] }`
- ✅ AC #4: Validates batch size (1–100 events per request, default limit)
- ✅ AC #5: Returns `202 Accepted` with response: `{ data: { accepted, duplicate, rejected } }`

### Service (Business Logic)
- ✅ AC #6: Payload validation (per-event structure: eventType, quantity, unit, occurredAt, idempotencyKey, metadata)
- ✅ AC #7: Quantity validation (1–100 per event)
- ✅ AC #8: Timestamp validation (occurredAt must be within ±5min of server clock)
- ✅ AC #9: Idempotency key generation (if missing: `${tenantId}:${eventType}:${sourceId}:${occurredAt}`)
- ✅ AC #10: Deduplication check via T-032 DeduplicationService
- ✅ AC #11: Stream publishing via T-033 StreamPublisher with normalized envelope

### Error Handling
- ✅ AC #12: `400 VALIDATION_ERROR` for malformed payload
- ✅ AC #13: `400 BATCH_TOO_LARGE` for >100 events
- ✅ AC #14: `400 FUTURE_CLOCK_SKEW` for occurredAt > now + 5min
- ✅ AC #15: `500` if Redis deduplication or stream publish fails (upstream retry)

### Testing
- ✅ AC #16: Controller tests (6–8): happy path, batch size validation, timestamp validation, error responses
- ✅ AC #17: Service tests (10–12): payload parsing, quantity limits, idempotency key generation, dedup check, stream publish
- ✅ AC #18: CI gates pass (lint, typecheck, build, test across 13 packages)

---

## Implementation Strategy: Pseudo-TDD

**Phase 1: Write ALL tests BEFORE code** (2–3 hours)
- Controller tests (6–8 scenarios)
- Service tests (10–12 scenarios)
- Use mocks for DeduplicationService, StreamPublisher, Logger

**Phase 2: Implement code to pass tests** (1–2 hours)
- Validators (Zod schemas)
- IngestionService (business logic)
- EventsController (HTTP handler)
- Route registration
- Container setup

**Phase 3: Refactor + Validate** (1 hour)
- Run all tests (expect 16–20 passing)
- Lint, typecheck, build, test full workspace
- Verify no regressions (T-034, T-032, T-033 still passing)

---

## Test Scenarios

### Controller Tests (6–8)
1. **Happy Path (Single Event)**
   - Input: 1 new event
   - Expected: 202 { data: { accepted: 1, duplicate: 0, rejected: 0 } }

2. **Happy Path (Batch)**
   - Input: 10 events (5 new, 3 duplicate, 2 invalid)
   - Expected: 202 { data: { accepted: 5, duplicate: 3, rejected: 2 } }

3. **Validation Error: Malformed eventType**
   - Input: { events: [{ eventType: null, ... }] }
   - Expected: 400 VALIDATION_ERROR

4. **Validation Error: Quantity Out of Range**
   - Input: { events: [{ quantity: 0 }, { quantity: 101 }] }
   - Expected: 400 VALIDATION_ERROR

5. **Validation Error: Batch Too Large**
   - Input: { events: [...101 events...] }
   - Expected: 400 BATCH_TOO_LARGE

6. **Validation Error: Future Timestamp**
   - Input: { events: [{ occurredAt: now + 10min }] }
   - Expected: 400 FUTURE_CLOCK_SKEW

7. **Error: Deduplication Service Fails**
   - Mock deduplication.isNew() to throw Error
   - Expected: 500 INTERNAL_ERROR, log error

8. **Error: Stream Publisher Fails**
   - Mock streamPublisher.publish() to throw Error
   - Expected: 500 INTERNAL_ERROR, log error

### Service Tests (10–12)
1. **Ingest Single New Event**
   - Expected: { accepted: 1, duplicate: 0, rejected: 0 }
   - Verify deduplication.isNew() called with correct key
   - Verify streamPublisher.publish() called with correct envelope

2. **Ingest Duplicate Event**
   - Mock deduplication.isNew() to return false
   - Expected: { duplicate: 1, accepted: 0, rejected: 0 }
   - Verify streamPublisher NOT called

3. **Payload Validation Failure (Required Field Missing)**
   - Input: { events: [{ eventType: "test" }] } (missing quantity, unit, occurredAt)
   - Expected: { rejected: 1, accepted: 0, duplicate: 0 }
   - Verify error logged with validation details

4. **Quantity Validation (Out of Range)**
   - Input: { events: [{ quantity: 0 }, { quantity: 101 }] }
   - Expected: { rejected: 2, accepted: 0, duplicate: 0 }

5. **Timestamp Validation (Too Far in Future)**
   - Input: { events: [{ occurredAt: now + 600s (10min) }] }
   - Expected: { rejected: 1, accepted: 0, duplicate: 0 }

6. **Timestamp Validation (Within Tolerance)**
   - Input: { events: [{ occurredAt: now + 299s (< 5min) }] }
   - Expected: { accepted: 1, duplicate: 0, rejected: 0 }

7. **Idempotency Key Generation (Missing Key)**
   - Input: { events: [{ idempotencyKey: undefined }] }
   - Expected: Generated key with format `tenant:type:source:timestamp`
   - Verify deduplication.isNew() called with generated key

8. **Idempotency Key Generation (Provided Key)**
   - Input: { events: [{ idempotencyKey: "custom-key" }] }
   - Expected: deduplication.isNew() called with custom key

9. **Stream Publishing Envelope Format**
   - Verify published event includes:
     - tenantId, eventId (generated), eventType, quantity, unit, occurredAt, metadata
     - timestamp (server time), idempotencyKey, sourceId

10. **Deduplication Service Error (Rethrow)**
    - Mock deduplication.isNew() to throw Error
    - Expected: Service rethrows error (fail-closed)
    - Verify error logged with context

11. **Stream Publisher Error (Rethrow)**
    - Mock streamPublisher.publish() to throw Error
    - Expected: Service rethrows error (fail-closed)
    - Verify error logged with context

12. **Empty Batch Handling**
    - Input: { events: [] }
    - Expected: { accepted: 0, duplicate: 0, rejected: 0 }
    - No service calls (dedup, publish)

13. **Concurrent Calls (Mixed New/Duplicate)**
    - Input: 3 calls with same idempotencyKey
    - Mock deduplication.isNew() to return: true (call 1), false (call 2), false (call 3)
    - Expected: accepted: 1 (call 1), duplicate: 1 (call 2), duplicate: 1 (call 3)

14. **Logging: Debug Event Processing**
    - Verify logger.debug() called for each event processed
    - Include key, tenantId, eventType, quantity in log context

15. **Logging: Error Handling**
    - Verify logger.error() called on validation error
    - Include error details, event context in log

---

## Dependencies (All Satisfied)

| Dependency | Status | Evidence |
|---|---|---|
| T-028 (Gateway Rate Limiting) | ✅ Committed | Commit 2c20b41 |
| T-030 (Usage Service Env Schema) | ✅ Committed | Commit 30ad908 |
| T-032 (Deduplication Service) | ✅ Committed | Commit 4616c75 |
| T-033 (Stream Publisher) | ✅ Committed | Commit 4616c75 |
| T-034 (Tenant Context Middleware) | ✅ Committed | Commit 7df3fbe |

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Idempotency key collision (tenant + type + source + timestamp) | LOW | Server-generated key with tenant prefix + event metadata; 24h TTL ensures cleanup |
| Clock skew tolerance too strict (5min) | LOW | Configurable via env var; matches typical NTP accuracy |
| Stream publisher fails; events dropped | MEDIUM | Fail-closed design (rethrow); caller handles retry; prefer loss over duplication |
| Deduplication false negatives | LOW | Redis SET NX is atomic; TTL covers event lifetime; tests verify concurrent calls |
| Memory pressure: 100 events/batch | LOW | Batch size limit (100) + MAXLEN trimming (100k) + TTL cleanup |
| Tenant isolation bypass | LOW | Idempotency key includes tenant prefix; dedup key-space is per-tenant |

---

## Validation Gates

**Task-Scoped Validation**:
- ✅ Controller tests: 6–8 passing
- ✅ Service tests: 10–12 passing
- ✅ Total: 16–20 new tests
- ✅ Lint: usage-service only
- ✅ Typecheck: usage-service only
- ✅ Build: usage-service only

**Pre-QA Gate**:
- ✅ Full workspace lint (13 packages)
- ✅ Full workspace typecheck (13 packages)
- ✅ Full workspace build (13 packages)
- ✅ Full workspace test (all 55+ existing + 16–20 new, 0 regressions)

**QA Gate**:
- ✅ Test coverage analysis (100% of acceptance criteria covered)
- ✅ Error case coverage (all 400/500 codes tested)

**Senior Review (Pre-QA)**:
- ✅ No magic strings/numbers (use constants)
- ✅ No `any`/`unknown` (strict types)
- ✅ Clean code practices (DRY, single responsibility)
- ✅ Error handling completeness
- ✅ Production readiness (logging, observability)

**Senior Review (Final)**:
- ✅ Acceptance criteria 100% verified
- ✅ No regressions (existing tests still passing)
- ✅ Release readiness confirmed

---

## Next Action

1. **User Approval** of this plan ← You are here
2. **Task Implementer**: Execute Pseudo-TDD (write tests, implement code, validate)
3. **Senior Reviewer (Pre-QA)**: Compile-time validation + clean code review
4. **QA Tester**: Test coverage analysis + post-QA enhancements
5. **Senior Reviewer (Final)**: Acceptance criteria verification + sign-off
6. **Commit Approval Gate**: Review risks, pending tasks, approve commit
7. **Push to Main**

---

## Summary

**Scope**: 1 endpoint, 2 new services (controller + ingestion), 2 validators, 2 test files, 1 route file  
**Complexity**: MEDIUM (6 files created, 2 modified, 16–20 tests, multiple validation layers)  
**Effort**: 3–4 hours (single-slice delivery)  
**Dependencies**: All satisfied (T-028, T-030, T-032, T-033, T-034)  
**Deliverables**: 
- ✅ POST /v1/usage/events endpoint 
- ✅ Full orchestration (validation → dedup → publish)
- ✅ 16–20 comprehensive tests
- ✅ Error handling (400/500 codes)
- ✅ Logging & observability

**Risk Level**: LOW (all dependencies committed; isolated changes; fail-closed pattern)  
**Release Readiness**: MEDIUM (depends on QA approval; requires 0 regressions)
