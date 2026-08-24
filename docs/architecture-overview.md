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

## Scale constraints

The v1 architecture is designed as a production-oriented, single-region, multi-tenant SaaS platform.
The scale targets are intentionally chosen to demonstrate high-throughput ingestion, asynchronous processing,
reliable billing, and near-real-time analytics without introducing infrastructure complexity that is not
justified for the initial system.

### V1 capacity targets

| Metric | Target |
|---|---:|
| Peak API requests | 5,000 requests/sec |
| Average API requests | ~1,000 requests/sec |
| Peak usage events | 5,000 events/sec |
| Daily usage events | ~86 million |
| Maximum events per request | 100 |
| Maximum event payload | 10 KB |
| Dashboard freshness | 1-5 seconds |
| API availability | 99.9% |
| Raw event retention | 30 days |
| Aggregated usage retention | 12 months |
| Deployment model | Single region |
| Database model | Single PostgreSQL cluster |
| Processing model | Asynchronous |
| Delivery guarantee | At-least-once |
| Billing processing | Idempotent |
| Tenant isolation | Required |

### Traffic assumptions

The system is designed around:

- Approximately 1,000 requests/sec average traffic.
- Up to 5,000 requests/sec during traffic spikes.
- Usage events buffered through Redis Streams before database persistence.
- Events processed asynchronously in batches.
- API services remaining stateless and horizontally scalable.
- No synchronous PostgreSQL write dependency for every incoming usage event.
- Dashboard APIs reading pre-aggregated usage data for frequently accessed metrics.
- Raw event partitioning by event timestamp.
- Redis used for rate limiting, quota checks, caching, and event buffering.

### Database constraints

PostgreSQL is the primary transactional database for v1.

The system assumes:

- One PostgreSQL cluster.
- Partitioned `usage_events` table.
- PgBouncer for connection pooling.
- Batch inserts from workers.
- Appropriate indexes for tenant and time-based queries.
- Aggregate tables for frequently accessed usage metrics.
- Read replicas may be introduced when read traffic becomes a bottleneck.

Database sharding is intentionally out of scope for v1.

### Worker constraints

Workers consume events from Redis Streams using consumer groups.
The worker architecture must support horizontal scaling.

```text
Redis Stream
	|
	v
Consumer Group
	|
  +--+--+
  |  |  |
  v  v  v
 W1 W2 W3
```
