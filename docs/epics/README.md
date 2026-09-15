# Epics Index

Implementation sequence based on architectural dependencies and open decision gates.

---

## Decision gates

| Decision | Required before |
|---|---|
| Q1 — Event payload shape (**decided**: envelope + required `version` + additive-only evolution in v1) | Epic 2, Epic 6 |
| Q6 — Multi-tenancy scope (**decided**: repository tenant scoping + immediate PostgreSQL RLS) | Epic 2 |
| Q7 — API versioning (`/v1/`) (**decided**: URI major versioning for external APIs) | Epic 5, Epic 6 |
| Q5 — Refresh token delivery | Epic 4 |
| Q8 — External vs internal API consumers (**decided**: external only via gateway; internal routes private + `X-Internal-Secret`) | Epic 6 |
| Q9 — Worker concurrency (**decided**: horizontal-ready, single instance locally) | Epic 7 |
| Q10 — DLQ retry policy (**decided**: `MAX_RETRY_COUNT` 3, `DEAD_LETTER_STREAM` `telemetry:dead-letter`, no retry delay, alerting counter deferred to T-057) | Epic 7 |
| Q2 — Pricing model (**decided**: flat only for v1 — `amount = summedQuantity x unitPrice`; `Meter.tierJson` unread; tiered deferred pending a graduated-vs-volume ruling) | Epic 8 |
| Q3 — UTC aggregation timezone | Epic 9 |
| Q11 — Dashboard scope | Epic 11 |

### Day 1 decision notes

#### Q1 — Event payload shape

- Decision: Use a versioned event envelope with strict required fields and typed payload.
- Required envelope fields: `eventId`, `tenantId`, `eventType`, `occurredAt`, `receivedAt`, `source`, `idempotencyKey`, `version`, `payload`.
- Evolution rule (v1): additive-only changes in `payload`; no breaking removals/renames.
- Why now: protects replay, idempotency, and contract governance while keeping ingestion simple.
- Revisit trigger: multiple producer SDKs, frequent breaking changes, or cross-language schema generation needs.

#### Q10 — DLQ retry policy

- Decision: 3 retries, then a Redis stream `telemetry:dead-letter`, with **no retry delay**.
- Retry storage: `HINCRBY retries:{streamName} {messageId} 1`, with a key-level TTL. The count
  is checked before processing, so an entry arriving with an exhausted budget is dead-lettered
  without being processed again.
- **"No retry delay" means no timer, not no spacing.** Nothing sleeps, schedules or backs off.
  The attempts are spaced by a threshold that already existed —
  `STREAM_BLOCK_MS x RECOVERY_IDLE_MULTIPLIER`, the minimum idle time `XAUTOCLAIM` needs before
  it will reclaim an entry — because T-041 also gives the read loop a reclaim cadence. That one
  threshold now does double duty: peer safety and retry spacing. At the shipped defaults three
  attempts span roughly 20–30 seconds.
- Alerting: the specified Prometheus counter `telemetry_dead_letter_total` is **deferred to
  T-057**. `prom-client` is in no `package.json` in this workspace, so there is no metrics
  substrate to add it to. Until then the operational lever is `XLEN telemetry:dead-letter`, and
  the dead-letter stream is unwatched — a known, stated hole.
- The dead-letter record carries the **whole original field list**, not just the entry id:
  measured on Redis 7.0.15, a pending entry's payload can be evicted by `MAXLEN` while its id
  stays in the pending list, so an id-only record is unreplayable.
- Implemented by T-041 (`docs/plans/t-041-retry-tracking-dead-letter.md`).
- Revisit trigger: a dead-letter stream that accumulates during normal operation, which would
  mean the budget is too small for the platform's real failure durations.

#### Q2 — Pricing model

- Decision: **flat rate only for v1.** A line item's amount is `summedQuantity x unitPrice`,
  where `unitPrice` comes from the `Meter` active as of `periodStart`.
- `Meter.tierJson` (`prisma/schema.prisma:113`) stays `null` and unread: no Zod schema for it,
  no tier evaluation, no tier tests. `docs/epics/epic-8-billing-service.md`'s step 7 reads
  "flat: `quantity x unitPrice`; tiered: evaluate `tierJson`" — only the first arm is in scope.
- **Tiered is deferred, not forgotten, and the reason is a product decision rather than an
  implementation one.** *Graduated* and *volume* tiering give different totals for the same
  input and the same tier table: graduated charges each band's rate on the quantity falling in
  that band, volume charges the whole quantity at the band the total lands in. `tierJson`
  records neither, so a later implementer reading the column cannot recover which was intended.
  That has to be answered before code, not during it.
- Per-meter `Meter.currency` versus the single `Invoice.currency` column: a period whose
  matched meters disagree on currency is **rejected** (`422 METER_CURRENCY_CONFLICT`) rather
  than resolved by picking one, because any choice would be silently wrong. Likewise a
  `metricKey` with unbilled usage and no active meter is `422 METER_NOT_FOUND` — an invoice
  that silently omits a metric is money missing from a document that looks complete.
- Implemented by T-045 (`docs/plans/t-045-internal-metering-endpoint.md`).
- Revisit trigger: the first customer contract that prices by band, or any `Meter` row written
  with a non-null `tierJson`.

#### Q6 — Multi-tenancy scope

- Decision: Enforce tenant scoping in repositories and enable PostgreSQL RLS immediately.
- Enforcement rules:
        - every read/write query must include `tenantId` context;
        - no trusted raw `tenantId` from client payloads;
        - privileged cross-tenant operations remain explicit and isolated.
- Why now: senior-level safety baseline with reduced blast radius for data leaks.
- Revisit trigger: only if RLS cost/operational complexity blocks throughput targets.

#### Q7 — API versioning

- Decision: External APIs use URI major versioning under `/v1`.
- Internal APIs may remain unversioned while private but must stay behind internal auth.
- Breaking changes require a new major path (`/v2`), additive fields remain non-breaking.
- Why now: clear consumer contracts and low operational overhead.
- Revisit trigger: if consumer-specific behavior requires content negotiation.

#### Q8 — Internal vs external boundary

- Decision: all external traffic enters only through `gateway`; internal endpoints are private.
- Internal endpoints require `X-Internal-Secret` and must not be publicly proxied.
- Health endpoints remain unauthenticated for operability checks.
- Why now: clear trust boundaries and reduced accidental exposure risk.
- Revisit trigger: service mesh/mTLS rollout or external partner access requirements.

---

## Epics

| Epic | File | Milestone | Depends on |
|---|---|---|---|
| 1 — Shared Foundation | [epic-1-shared-foundation.md](./epic-1-shared-foundation.md) | v1-mvp | Nothing — start here |
| 2 — Database Schema | [epic-2-database.md](./epic-2-database.md) | v1-mvp | Epic 1, Q1, Q6 |
| 3 — Shared Service Infra | [epic-3-shared-service-infra.md](./epic-3-shared-service-infra.md) | v1-mvp | Epic 1, Epic 2 |
| 4 — Auth Service | [epic-4-auth-service.md](./epic-4-auth-service.md) | v1-mvp | Epic 3, Q5 |
| 5 — Gateway | [epic-5-gateway.md](./epic-5-gateway.md) | v1-mvp | Epic 3, Epic 4 |
| 6 — Usage Service | [epic-6-usage-service.md](./epic-6-usage-service.md) | v1-mvp | Epic 3, Q1, Q8 |
| 7 — Worker Service | [epic-7-worker-service.md](./epic-7-worker-service.md) | v1-mvp | Epic 3, Epic 6, Q10 |
| 8 — Billing Service | [epic-8-billing-service.md](./epic-8-billing-service.md) | v1 | Epic 3, Epic 7, Q2 |
| 9 — Analytics Service | [epic-9-analytics-service.md](./epic-9-analytics-service.md) | v1 | Epic 3, Q3 |
| 10 — Observability | [epic-10-observability.md](./epic-10-observability.md) | v1-mvp + v1 | Wire during each service epic |
| 11 — Frontend | [epic-11-frontend.md](./epic-11-frontend.md) | v1-mvp + v1 | Epic 4, 6, 8, 9 |
| 12 — Testing | [epic-12-testing.md](./epic-12-testing.md) | v1-mvp + v1 | Write alongside each epic |
| 13 — Security | [epic-13-security.md](./epic-13-security.md) | v1-mvp + v1 | Apply during each epic |

---

## Critical path to first working demo (v1-mvp)

```
Q1 + Q6 + Q7 decided
        ↓
Epic 1 — Shared packages
        ↓
Epic 2 — Prisma schema + seed
        ↓
Epic 3 — Shared service infra (container, singleton, graceful shutdown, .env.example)
        ↓           ↓
Epic 4 — Auth    Epic 6 — Usage ingestion
        ↓           ↓
Epic 5 — Gateway wires it together
        ↓
[First end-to-end: register → login → POST /v1/usage/events → event in Redis Streams]
        ↓
Epic 7 — Worker (event → UsageLine in DB)
        ↓
[Second milestone: full ingest pipeline working]
```

After critical path: Epic 8 → Epic 9 → Epic 11 → v1 complete.

## V1 scale envelope

Apply these constraints while implementing all epics and plans:

- Average API traffic target: ~1,000 requests/sec.
- Peak API traffic target: 5,000 requests/sec.
- Peak usage event target: 5,000 events/sec.
- Maximum events per ingestion request: 100.
- Maximum event payload size: 10 KB.
- Dashboard freshness target: 1-5 seconds.
- API availability target: 99.9%.
- Deployment model: single-region, single PostgreSQL cluster, asynchronous processing.

For details and assumptions, see the Scale constraints section in `docs/architecture-overview.md`.

---

## Story count by epic

| Epic | Stories | Milestone |
|---|---|---|
| 1 — Shared Foundation | 6 | v1-mvp |
| 2 — Database | 5 | v1-mvp |
| 3 — Shared Infra | 5 | v1-mvp |
| 4 — Auth Service | 8 | v1-mvp |
| 5 — Gateway | 5 | v1-mvp |
| 6 — Usage Service | 7 | v1-mvp + v1 |
| 7 — Worker Service | 7 | v1-mvp + v1 |
| 8 — Billing Service | 6 | v1 |
| 9 — Analytics Service | 5 | v1 |
| 10 — Observability | 5 | v1-mvp + v1 |
| 11 — Frontend | 6 | v1-mvp + v1 |
| 12 — Testing | 4 | v1-mvp + v1 |
| 13 — Security | 4 | v1-mvp + v1 |
| **Total** | **73** | |
