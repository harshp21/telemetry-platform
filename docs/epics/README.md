# Epics Index

Implementation sequence based on architectural dependencies and open decision gates.

---

## Decision gates

| Decision | Required before |
|---|---|
| Q1 — Event payload shape | Epic 2, Epic 6 |
| Q6 — Multi-tenancy scope | Epic 2 |
| Q7 — API versioning (`/v1/`) | Epic 5, Epic 6 |
| Q5 — Refresh token delivery | Epic 4 |
| Q8 — External vs internal API consumers | Epic 6 |
| Q9 — Worker concurrency (**decided**: horizontal-ready, single instance locally) | Epic 7 |
| Q10 — DLQ retry policy | Epic 7 |
| Q2 — Pricing model | Epic 8 |
| Q3 — UTC aggregation timezone | Epic 9 |
| Q11 — Dashboard scope | Epic 11 |

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
