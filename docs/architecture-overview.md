# Architecture Overview

This platform uses a modular monorepo with independent deployable backend services and shared internal packages.

## Services

- gateway: API edge, routing, and request orchestration
- auth-service: Identity and access management
- usage-service: Usage ingestion and normalization
- worker-service: Async jobs and event processing
- billing-service: Metering, rating, and invoice orchestration
- analytics-service: Aggregation and analytical APIs
- web: React dashboard

## Shared Packages

- shared-config
- shared-types
- shared-utils
- shared-validation
- shared-logger
- shared-tracing

## Day 1 Architecture Decisions

### Event contract

- Use a versioned envelope for all telemetry events.
- Required fields: `eventId`, `tenantId`, `eventType`, `occurredAt`, `receivedAt`, `source`, `idempotencyKey`, `version`, `payload`.
- Contract evolution for v1 is additive-only.

### Multi-tenancy and data isolation

- Enforce tenant scoping at repository boundaries.
- Enable PostgreSQL Row Level Security (RLS) from the first database iteration.
- Never trust raw `tenantId` from external callers without auth-context validation.

### API versioning

- External APIs are exposed under `/v1` path-based major versioning.
- Breaking API changes require a new major path.

### Internal/external boundary

- External clients call only through `gateway`.
- Internal service routes are private and protected with `X-Internal-Secret`.
- Internal endpoints are not publicly proxied by default.
