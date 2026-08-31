# T-035 Implementation Plan: Usage Summary Endpoint

Plan file path: docs/plans/t-035-usage-summary-endpoint.md

## 1) Business Context

### Objective
Deliver a tenant-safe Usage Summary API endpoint that lets product and operations consumers query aggregated usage for reporting, internal dashboards, and billing-adjacent visibility without exposing raw events.

### User impact
- Tenant admins can query usage totals over a time range and granularity (hour/day/week).
- API consumers can page through grouped usage summaries deterministically.
- Empty result sets are handled as successful responses, improving client UX and reducing special-case logic.
- Strict tenant scoping prevents cross-tenant leakage, which is a security and trust requirement.

## 2) Scope And Non-Goals

### In scope
- GET /v1/usage/summary.
- Controller -> Service -> Repository flow in usage-service.
- Tenant-scoped aggregation over usage data.
- Query params: from, to, granularity, optional metricKey, page, pageSize.
- Pagination defaults and limits (default page=1, pageSize=20, max pageSize=100).
- Empty-result behavior returning items: [], total: 0.

### Out of scope
- Worker ingestion/processing logic.
- Billing/analytics/dashboard epic work beyond this endpoint.
- Broad service hardening or refactors.
- T-036 full integration suite.

## 3) Files To Change (Expected)

### Existing files likely modified
- [apps/usage-service/src/constants.ts](apps/usage-service/src/constants.ts)
- [apps/usage-service/src/config/container.ts](apps/usage-service/src/config/container.ts)
- [apps/usage-service/src/app.ts](apps/usage-service/src/app.ts)
- [apps/usage-service/src/routes/index.ts](apps/usage-service/src/routes/index.ts)
- [apps/usage-service/src/controllers/index.ts](apps/usage-service/src/controllers/index.ts)
- [apps/usage-service/src/services/index.ts](apps/usage-service/src/services/index.ts)
- [apps/usage-service/src/repositories/index.ts](apps/usage-service/src/repositories/index.ts)

### Expected new usage-service files
- src/validators/usage-summary.validator.ts
- src/repositories/usage.repository.ts
- src/services/usage.service.ts
- src/controllers/usage.controller.ts
- src/routes/usage.routes.ts
- tests/usage.repository.unit.test.ts
- tests/usage.service.unit.test.ts
- tests/usage.controller.unit.test.ts
- tests/usage-summary.route.test.ts

## 4) Step-By-Step Implementation Plan (Smallest Safe Slices)

### Controlling code path
Request enters [apps/usage-service/src/app.ts](apps/usage-service/src/app.ts), tenant is attached by [apps/usage-service/src/middleware/tenant-context.middleware.ts](apps/usage-service/src/middleware/tenant-context.middleware.ts), route handler dispatches to controller, controller validates query and calls service, service applies pagination/rules and calls repository, repository runs tenant-scoped aggregation using Prisma transaction context.

### Local hypothesis (falsifiable)
If the repository enforces tenant scoping via the existing tenant-scoped repository pattern and only allows validated granularity values mapped to fixed SQL expressions, then GET /v1/usage/summary can return correct bucketed aggregates with no cross-tenant leakage and predictable pagination.

This is falsified if:
- Results include rows from another tenant,
- Bucket boundaries are wrong for day/hour/week,
- Pagination metadata does not match actual grouped row counts.

### Implementation slices

1. Define query/response contract first (tests-first setup).
- Add validator schema for from/to/granularity/metricKey/page/pageSize.
- Enforce from < to, granularity enum hour|day|week, page min 1, pageSize min 1 max 100.
- Set defaults in parsing layer: page=1, pageSize=20.
- Add usage-summary constants for defaults and limits in [apps/usage-service/src/constants.ts](apps/usage-service/src/constants.ts).

2. Add repository tests before implementation.
- Create repository unit tests that assert:
  - tenant-scoped filtering is always applied,
  - optional metricKey filter behavior,
  - grouping by metricKey + bucket,
  - total grouped rows count behavior for pagination,
  - empty result returns zero rows/total,
  - granularity mapping chooses expected SQL bucket function.
- Mock Prisma transaction behavior and raw query calls.

3. Implement repository aggregation.
- Create usage repository extending tenant-scoped base from [apps/usage-service/src/repositories/base.repository.ts](apps/usage-service/src/repositories/base.repository.ts).
- Implement single read method with inputs: tenantId context, from, to, granularity, metricKey?, page, pageSize.
- Use withTenant transaction wrapper to preserve RLS context.
- Use safe, fixed granularity mapping (hour/day/week) for DATE_TRUNC expression.
- Return normalized rows: metricKey, bucketStart, bucketEnd, totalQuantity plus total count for pagination.
- Ensure decimal values are serialized consistently for API output shape.

4. Add service tests before implementation.
- Cover orchestration and guardrails:
  - default pagination application,
  - pageSize clamp/rejection according to validator policy,
  - empty-result passthrough behavior,
  - repository error propagation/normalization.

5. Implement usage service.
- Service method accepts tenantId + validated query.
- Applies/relies on validated defaults and builds PaginatedResult response.
- Returns stable shape for empty and non-empty data.

6. Add controller tests before implementation.
- Validate HTTP behavior:
  - valid query returns 200 with data payload,
  - invalid from/to/granularity/page/pageSize returns 400 VALIDATION_ERROR,
  - missing tenant context behavior aligns with middleware/global handling,
  - repository/service errors normalize to internal error contract.

7. Implement controller + route.
- Create usage summary controller and route registration.
- Register GET /v1/usage/summary constant and route.
- Wire route in app and route index flow similarly to existing events route pattern in [apps/usage-service/src/routes/events.routes.ts](apps/usage-service/src/routes/events.routes.ts).

8. Wire DI container and barrel exports.
- Register repository + service + controller in [apps/usage-service/src/config/container.ts](apps/usage-service/src/config/container.ts).
- Update export indexes for controllers/services/repositories/routes.

9. Add route-level integration-style test (scoped, not full T-036).
- Use app.inject pattern like [apps/usage-service/tests/usage-events.route.test.ts](apps/usage-service/tests/usage-events.route.test.ts).
- Stub repository/service calls to assert endpoint contract, pagination defaults, and empty data behavior from HTTP boundary.

10. Final pass and narrow validations first, then full gates.

## 5) Test Plan (Unit + Integration)

### Unit tests
- Validator unit behavior via controller tests:
  - invalid date formats,
  - from >= to,
  - unsupported granularity,
  - page/pageSize bounds.
- Repository unit tests:
  - tenant isolation and query constraints,
  - bucket aggregation correctness per granularity,
  - metricKey filtering,
  - total count with pagination.
- Service unit tests:
  - default pagination values,
  - result mapping into PaginatedResult shape,
  - empty result behavior.
- Controller unit tests:
  - 200 success payload,
  - 400 validation errors,
  - 500 internal error normalization.

### Route-level integration (task-scoped)
- New usage-summary route test with app.inject:
  - success query returns expected data wrapper and metadata fields,
  - omitted page/pageSize uses defaults 1/20,
  - pageSize > 100 rejected as validation error,
  - no data returns items: [], total: 0.

### Explicit acceptance coverage mapping
- Tenant scope guaranteed: repository + route tests.
- Granularity behavior (day boundaries UTC expectation): repository tests.
- Optional metricKey filter: repository + controller tests.
- Pagination default/limit: validator + controller + route tests.
- Empty range behavior: service + route tests.

## 6) Validation Commands

### Task-scoped first (fail fast)
1. pnpm --filter @telemetry/usage-service test -- usage.repository.unit.test.ts
2. pnpm --filter @telemetry/usage-service test -- usage.service.unit.test.ts
3. pnpm --filter @telemetry/usage-service test -- usage.controller.unit.test.ts
4. pnpm --filter @telemetry/usage-service test -- usage-summary.route.test.ts
5. pnpm --filter @telemetry/usage-service test
6. pnpm --filter @telemetry/usage-service lint
7. pnpm --filter @telemetry/usage-service typecheck

### Full gate commands (pre-commit gate)
1. pnpm build
2. pnpm test
3. pnpm lint
4. pnpm typecheck

## 7) Risks And Mitigations

- Risk: SQL granularity handling could become injection-prone if interpolated unsafely.
- Mitigation: map only validated enum values to fixed SQL fragments; no direct user string interpolation.

- Risk: incorrect bucket boundary semantics (especially week/day timezone assumptions).
- Mitigation: enforce UTC expectation in tests and document week boundary behavior aligned with DATE_TRUNC semantics.

- Risk: pagination total mismatch when counting grouped rows.
- Mitigation: implement and test total as grouped-result count, not raw row count.

- Risk: decimal quantity conversion inconsistencies in API response.
- Mitigation: normalize totalQuantity format in one layer (repository/service) and assert in tests.

- Risk: tenant leakage through missing where clause.
- Mitigation: use existing tenant-scoped base repository transaction wrapper and explicit tenant filter in all aggregate queries.

## 8) Pending Task Checklist

- [done] Confirm epic scope and boundaries for T-035.
- [done] Identify controlling code path and dependency injection points.
- [done] Create T-035 validator + constants for pagination/granularity.
- [done] Write repository unit tests (first).
- [done] Implement usage repository aggregation and tenant-scoped query.
- [done] Write service unit tests (first).
- [done] Implement usage summary service.
- [done] Write controller unit tests (first).
- [done] Implement usage summary controller + route registration.
- [done] Wire container and export indexes.
- [done] Add route-level integration-style test for summary endpoint.
- [done] Run usage-service scoped test/lint/typecheck.
- [done] Run full gate commands build/test/lint/typecheck.
- [done] Prepare implementation handoff evidence and request next-stage review.

## 9) Approval Gate Statement

Implementation must not start until explicit user approval of this plan.
After approval, execution proceeds to Task Implementer stage with tests-first slices and task-scoped validations before any full-gate run.

## 10) Implementation Notes (T-035)

### Aggregation source
Summaries aggregate the persisted `UsageLine` model (`tenantId`, `metricKey`, `quantity DECIMAL(18,6)`,
`periodStart`). It is the only tenant-scoped model that carries `metricKey`, which the query contract
groups and filters on.

### Range and bucket semantics
- `from` is inclusive, `to` is exclusive (`"periodStart" >= from AND "periodStart" < to`).
- `periodStart` is `TIMESTAMP(3)` without time zone and Prisma persists UTC, so `DATE_TRUNC` produces
  UTC bucket boundaries with no `AT TIME ZONE` conversion. Week buckets follow Postgres ISO-8601
  semantics: they start on Monday 00:00:00 UTC.
- `bucketEnd` is the exclusive end of the bucket (`bucketStart + INTERVAL '1 <granularity>'`).

### Injection safety
`granularity` is validated against the `hour|day|week` enum and used only as a key into a frozen map of
constant `Prisma.sql` fragments. Every caller-supplied value (tenantId, from, to, metricKey, pageSize,
offset) is a bound parameter; no user string is ever interpolated into SQL text.

### Decimal normalization
`SUM("quantity")` is converted to a plain string in exactly one place — the repository's row mapper —
because `DECIMAL(18,6)` exceeds IEEE-754 safe precision. No `Prisma.Decimal` instance reaches the
service, controller, or JSON response.

### Deviations from the plan
- Tenant-scoped repositories are per-request by nature, so the container registers a
  `usageRepositoryFactory: (tenantId) => UsageRepository` (plus the singleton service and controller)
  rather than a repository singleton. `UsageService` depends on the factory.
- The route-level test stubs `container.usageService.getUsageSummary` (the plan allowed stubbing either
  repository or service) so the HTTP contract, validation, and pagination defaults are exercised without
  a live database. Full DB-backed integration coverage remains T-036.
