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
| Q3 — UTC aggregation timezone (**decided**: fixed UTC for every tenant; `Tenant.timezone` is not an aggregation input) | Epic 9 — T-051, T-052, T-053 only |
| Q11 — Dashboard scope (**decided**: three pages — Usage, Billing, Analytics; no others in v1) | Epic 11 |

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

#### Q3 — UTC aggregation timezone

- Decision: **fixed UTC for every tenant.** Every analytics bucket boundary is a UTC boundary.
  There is no per-tenant timezone, no per-request `timezone` query parameter, and no plan for
  one in v1.
- Bucket expressions use a **bare `DATE_TRUNC(<unit>, "<column>")` on the naive column** with no
  `AT TIME ZONE` conversion. `AT TIME ZONE 'UTC'` applied to the *column* is the defect
  `CLAUDE.md` § *Raw SQL and timestamps* names; applied to a bound *parameter* it is correct.
  Fix the bound, never the column. (This was recorded as S-53 in `.claude/rules/known-gaps.md`
  while `epic-9-analytics-service.md`'s rollup snippet still wrote the column form. T-051
  corrected the snippet and S-53 is retired; the record is
  `docs/plans/t-051-analytics-metrics-rollup.md`.)
- **`Tenant.timezone` is not an aggregation input.** It stays in the schema and keeps its
  writers; nothing reads it, and nothing in Epic 9 may start. Recorded at the column in
  `prisma/schema.prisma` as well as here, because that is where a reader of the column looks.

**Why now, each point re-derived by command rather than inherited.**

- **Every application timestamp column is naive, so there is no stored offset to aggregate by.**
  `information_schema.columns` over `table_schema='public'` returns **20** columns of
  `timestamp without time zone`, all precision 3, and **3** of `timestamp with time zone` — and
  all three of those are `_prisma_migrations.started_at`, `.finished_at`, `.rolled_back_at`.
  `grep -n "Timestamptz" prisma/schema.prisma` returns no match (exit 1), so no model asks for
  one. A per-tenant zone would have to be applied at read time to a value that carries no offset.
- **usage-service already ships this answer, deliberately.** The `GRANULARITY_SQL` map in
  `apps/usage-service/src/repositories/usage.repository.ts` buckets `hour`/`day`/`week` with bare
  `DATE_TRUNC(<unit>, "periodStart")`, and its docblock states the reasoning. Deciding Q3 any
  other way would make analytics disagree with the usage-summary endpoint on what a "day" is,
  for the same underlying rows.
- **`Tenant.timezone` has writers and no readers, and every writer hard-codes `"UTC"`.**
  `grep -rn "timezone" apps/*/src packages/*/src prisma --include=*.ts --include=*.prisma`
  (excluding `dist`) returns six lines: the column at `prisma/schema.prisma:15`
  (`@default("UTC")`); three writers — `apps/auth-service/src/repositories/user.repository.ts:295`
  writing `AUTH_TENANT_DEFAULTS.TIMEZONE`, which is `"UTC"` at
  `apps/auth-service/src/constants.ts:138`, and `prisma/seed.ts:23` and `:30` writing the
  literal `"UTC"`; one optional parameter type at `user.repository.ts:85` that no caller ever
  supplies; and one **unrelated** line, `apps/worker-service/src/queues/invoice-generation.queue.ts:172`,
  which is BullMQ's cron timezone (`WORKER_INVOICE_JOB.TIMEZONE`) and has nothing to do with the
  column. A search for a read — property access, destructure, or a Prisma `select`/`include`
  naming the field — returns nothing. Live values agree: `SELECT id, timezone FROM "Tenant"`
  returns 2 rows, both `UTC`.
- **The rollup cache key has no timezone column, so a later change is not migratable.**
  `MetricRollup @@unique([tenantId, metricKey, granularity, bucketStart])` — live as
  `MetricRollup_tenantId_metricKey_granularity_bucketStart_key` in `pg_indexes` — and the model
  has seven columns, none of them a timezone. A cached row's `bucketStart` would therefore mean
  something different under any per-tenant or per-request option, with nothing in the key to say
  which. Reversing this decision later is a recomputation of every cached row, not a migration.

**Scope: Q3 gates the bucket-computing tasks only — T-051, T-052, T-053 — not all of Epic 9.**
The evidence is that **T-050 shipped under the unresolved gate**, at `0aa19c1`
(`fix(analytics-service): derive the env schema's PORT default from the startup constant (T-050)`),
which is `HEAD` and the commit at which Q3 still carried no `decided` marker. T-050 is the env
schema and touches no timestamp path.

**Which file is authoritative, because the two disagreed.** This README's dependency table gave
Epic 9 as depending on `Epic 3, Q3` — the whole epic — while
`docs/epics/epic-9-analytics-service.md:4`'s own **Depends on** line reads
`Epic 2 (UsageLine, MetricRollup models), Epic 3` and does not mention Q3 at all. **This README is
authoritative**, per S-15's fix direction that it be "the single authority it claims to be"; the
epic file carries a forward pointer to this section rather than a second copy of the ruling.

- Implemented by: **T-051**, the first task to build on it. It also made the correction to
  `docs/epics/epic-9-analytics-service.md`'s rollup snippet that S-53 was open for, so that id
  is retired. The projection is a bare `DATE_TRUNC(<unit>, "periodStart")` on the naive column
  and `AI7` in `apps/analytics-service/tests/analytics.timezone.integration.test.ts` pins it
  across four session zones — going red under the column form in three of them, and **green
  under `UTC`**, which is why a suite that used CI's ambient session would assert nothing here.
- Revisit trigger: the first customer requirement for billing or reporting boundaries in a local
  zone. Note the cost is not the query — it is recomputing every cached `MetricRollup` row,
  because the unique key carries no column recording which zone a bucket was computed in.

#### Q3a — What "incomplete rollup data" means (T-051's D0-A)

Recorded here because nothing else records it, and because T-052 and T-053 read the same table.
`epic-9-analytics-service.md` § *T-051* says only *"If rollup data is incomplete (missing
buckets), fall back to aggregating directly from `UsageLine`"*, which does not say whether a
partial cache is **topped up** or **discarded**.

- Decision: **discarded.** Any absent bucket invalidates the whole cached range and the entire
  `[from, to)` window is re-aggregated from `"UsageLine"`. Confirmed by the user at Gate 0 of
  T-051; until that task it existed only in conversation.
- Mechanism: enumerate the **calendar** buckets spanning `[from, to)` and compare cardinality
  against `COUNT(DISTINCT "bucketStart")` in `"MetricRollup"`. Both counts come from the same
  frozen granularity fragments, so the two cannot disagree about where a boundary falls — which
  matters most at `week`, where the bucket containing `from` is PostgreSQL's ISO Monday.
- Rejected alternative: comparing against the buckets that *have* usage. Self-defeating —
  establishing that set requires reading `"UsageLine"`, which is the read the cache exists to
  avoid.
- Two riders T-051 added, both measured rather than reasoned:
  - **A `metricKey`-filtered request never writes the cache.** `COUNT(DISTINCT "bucketStart")`
    is blind to the metric dimension, so a cache written by a filtered request would make a
    later *unfiltered* range look complete while omitting another metric. Measured with both
    layers of that guard removed: the unfiltered request returned `['api.request']` where the
    truth is `['api.request', 'storage.write']`. A filtered request may still *read* the cache,
    because its coverage count carries the same filter.
  - **A range whose bounds are not on bucket boundaries never touches the cache in either
    direction.** An unaligned bound leaves part of a bucket outside the request: reading then
    over-reports it, and writing stores a partial total later readers would trust. Measured —
    true total for one day bucket `12.500000`, value an unaligned `06:00` request would have
    cached `2.000000`.
- Known cost, filed as **S-61**: a bucket with genuinely zero usage produces no rollup row, so
  any range containing an idle bucket can never satisfy the equality and falls back forever.
  Correctness-first and accepted; closing it needs a completeness marker on the table, i.e. a
  migration.

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

#### Q11 — Dashboard scope

- Decision: **three pages — Usage, Billing, Analytics.** Nothing else ships in the v1 dashboard.
- Each page is backed by an API that already exists, with one exception recorded below: Usage by
  usage-service's summary endpoint, Billing by `GET /v1/billing/invoices` and
  `/v1/billing/invoices/:id` (T-046, T-047), Analytics by nothing yet.
- **The Analytics page has no endpoint behind it today.** `GET /v1/analytics/metrics` is T-051,
  which is unstarted at the time of this ruling. Confirming the page does not create the API, and
  T-063 must not be read as unblocked by this entry alone.
- Why now: it was the last gate carrying no `decided` marker, and it blocks six tasks
  (T-060–T-065) — the whole of Epic 11 and the largest single block of pending work. Confirming
  the page set costs nothing and does not commit anyone to building it next.
- **What this does not settle.** `docs/epics/epic-11-frontend.md:13` lists **Q5** as a second
  pre-coding gate for Epic 11, while this README's gate table scopes Q5 to Epic 4 only. The two
  files disagree about Q5's reach, which is one of the six defects S-15 records; Q5 itself reads
  unresolved here although `640e53d` and `bdb6bcf` shipped a hybrid cookie + CSRF model. Settling
  Q11 therefore clears one of the two gates epic-11 names, not both. Whoever resolves Q5 should
  reconcile its `Required before` column at the same time.
- State of the code at this ruling, so nobody reads the decision as progress: `apps/web` is a bare
  Vite scaffold — six source files (`App.tsx`, `main.tsx`, `routes/router.tsx`, `lib/utils.ts`,
  `styles/index.css`, `vite-env.d.ts`), no API client, no auth context, no pages.
- Revisit trigger: a customer requirement for a fourth page, or for splitting any of the three.

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
| 9 — Analytics Service | [epic-9-analytics-service.md](./epic-9-analytics-service.md) | v1 | Epic 3; Q3 gates T-051, T-052, T-053 only |
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
