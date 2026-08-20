# Epic 10 — Observability

**Milestone**: v1-mvp (tracing + logging), v1 (metrics + dashboards)
**Depends on**: Epic 3 (shared-logger, shared-tracing packages complete)
**Note**: Tracing and logging tasks must be done **alongside** each service epic, not after. Wire them at the same time as the container setup (T-014).

---

## T-055 · OTel entrypoint injection (all services)

**Files**: `apps/{service}/src/index.ts` — all 6 services

**Story**: `initTracing(serviceName)` must be the **first executable line** in each service entrypoint — before Fastify import, before Prisma import, before anything else. OTel's auto-instrumentation patches Node.js modules at load time; importing Fastify first breaks HTTP span capture.

**Correct pattern**:
```ts
// This MUST be the first import — OTel patches modules at load time
import { initTracing } from "@telemetry/shared-tracing";
initTracing("auth-service");

import Fastify from "fastify";
import { prisma } from "@/lib/prisma";
// ... rest of setup
```

**Acceptance**:
- A request to `/health` produces a root span with `service.name = "{serviceName}"`
- Prisma queries appear as child spans within the HTTP span
- No OTel errors in startup logs

---

## T-056 · Replace generic Fastify logger with shared Pino instance (all services)

**Files**: `apps/{service}/src/index.ts` — all 6 services

**Story**: The current `Fastify({ logger: true })` uses Fastify's built-in logger. Replace with the shared Pino instance from `shared-logger` so that `traceId` is injected into every request log automatically.

**Before**:
```ts
const app = Fastify({ logger: true });
```

**After**:
```ts
import { createLogger } from "@telemetry/shared-logger";

const logger = createLogger("auth-service");
const app = Fastify({ loggerInstance: logger });
```

**Acceptance**:
- Every request log line contains `service`, `traceId`, `spanId`, and `level`
- Log output is valid JSON (not pretty-printed) in all environments

---

## T-057 · Prometheus metrics plugin (all services)

**Files**: `apps/{service}/src/plugins/metrics.plugin.ts`
**Milestone**: v1

**Story**: Expose `/metrics` on each service for Prometheus scraping. Use `prom-client` with default Node.js metrics plus custom platform metrics.

**Custom metrics**:
```ts
// HTTP request duration — applied via onResponse hook
const httpDuration = new Histogram({
  name: "telemetry_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code", "service"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

// Usage service only
const eventsIngested = new Counter({
  name: "telemetry_events_ingested_total",
  help: "Total events accepted by ingestion endpoint",
  labelNames: ["tenant_id", "event_type"],
});

// Worker service only
const consumerLag = new Gauge({
  name: "telemetry_stream_consumer_lag",
  help: "Approximate number of unprocessed messages in the stream",
  labelNames: ["stream", "group"],
});

// Worker service only
const deadLetterTotal = new Counter({
  name: "telemetry_dead_letter_total",
  help: "Total messages moved to dead-letter stream",
  labelNames: ["stream"],
});
```

**Port**: Expose `/metrics` on the same port as the service (gateway does not proxy this). Prometheus scrapes each service directly via Docker network.

---

## T-058 · Prometheus scrape config

**File**: `docker/prometheus/prometheus.yml`

**Story**: Add a scrape job for each service so Prometheus collects metrics from all of them.

```yaml
scrape_configs:
  - job_name: gateway
    static_configs:
      - targets: ["gateway:3100"]

  - job_name: auth-service
    static_configs:
      - targets: ["auth-service:3001"]

  - job_name: usage-service
    static_configs:
      - targets: ["usage-service:3002"]

  - job_name: worker-service
    static_configs:
      - targets: ["worker-service:3003"]

  - job_name: billing-service
    static_configs:
      - targets: ["billing-service:3004"]

  - job_name: analytics-service
    static_configs:
      - targets: ["analytics-service:3005"]
```

---

## T-059 · Grafana dashboard provisioning

**File**: `docker/grafana/provisioning/dashboards/platform.json`
**Milestone**: v1

**Panels to include**:

| Panel | Query | Type |
|---|---|---|
| Ingestion rate (req/s) | `rate(telemetry_http_request_duration_seconds_count{route="/v1/usage/events"}[1m])` | Time series |
| p99 ingestion latency | `histogram_quantile(0.99, rate(..._bucket[5m]))` | Time series |
| Consumer lag | `telemetry_stream_consumer_lag` | Gauge |
| Dead-letter count (24h) | `increase(telemetry_dead_letter_total[24h])` | Stat |
| Error rate per service | `rate(...{status_code=~"5.."}[5m])` | Time series |
| Active HTTP requests | Derived from histogram | Gauge |

**Acceptance**:
- `docker compose up` → Grafana at `localhost:3001` (Grafana port) shows pre-loaded dashboard without any manual steps
