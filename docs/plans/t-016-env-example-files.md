# T-016 Plan: .env.example Files (All Services + Root)

**Epic**: Epic 3 (Shared Service Infrastructure)  
**Task**: T-016 (.env.example files)  
**Dependency**: T-015 (Graceful Shutdown) ✅  
**Status**: Ready for Implementation

---

## Business Objective & User Impact

**Problem**: Services have no `.env.example` files documenting required environment variables. New developers don't know:
- Which variables are required vs optional
- What values to use for local development
- Which variables are sensitive (passwords, tokens, URLs)
- Service-specific vs shared infrastructure variables

**User Impact**:
- **Developers**: Onboarding is faster; clear checklist of env vars needed
- **Operations**: `.env.example` serves as documentation of all configurable parameters
- **CI/CD**: Template shows which vars must be set before deployment
- **Code Review**: Reviewers can verify env schema changes are reflected in examples

---

## Task Goal

Create comprehensive `.env.example` files for all 7 services + root workspace that document:
1. All environment variables (required and optional)
2. Safe example/default values for local development
3. Purpose/explanation of each variable
4. Markers for sensitive data (passwords, tokens, secrets)
5. Grouped by category (database, cache, auth, logging, etc.)

---

## Scope: Files to Create

**All 7 services** (app services + gateway + web):
| Service | File | Variables from Env |
|---------|------|-------------------|
| auth-service | `apps/auth-service/.env.example` | Read from `src/config/env.ts` |
| usage-service | `apps/usage-service/.env.example` | Read from `src/config/env.ts` |
| worker-service | `apps/worker-service/.env.example` | Read from `src/config/env.ts` |
| billing-service | `apps/billing-service/.env.example` | Read from `src/config/env.ts` |
| analytics-service | `apps/analytics-service/.env.example` | Read from `src/config/env.ts` |
| gateway | `apps/gateway/.env.example` | Read from `src/config/env.ts` |
| web | `apps/web/.env.example` | Read from frontend env if exists |

**Optional (if workspace-level vars exist)**:
| Location | File | Purpose |
|----------|------|---------|
| Root | `.env.example` | Workspace-level vars (if any) |

**No changes to**:
- `env.ts` or `env.schema.ts` files (env validation already complete)
- Docker Compose files (separate from env examples)
- Actual `.env` files (never commit secrets)

---

## Current State Analysis

**What exists now**:
- ✅ All services have `src/config/env.ts` with Zod schema validation
- ✅ T-014 container integration defined required env variables
- ✅ T-015 shutdown logging (no new env vars required)
- ❌ `.env.example` files: **mostly missing or incomplete**

**Known gaps** (per Task Planner analysis):
- Gateway's `.env.example` is missing: `JWT_SECRET`, service URLs, rate-limit settings
- Some services have auth-related variables (AUTH_COOKIE_*) used but not in env schema
- `INTERNAL_API_SECRET` used in some services but not documented
- No consistent formatting/grouping across services

---

## Variable Categories

Variables should be grouped into these categories in each `.env.example`:

### **1. Core Infrastructure**
- `NODE_ENV` — Environment (development, test, production)
- `PORT` — HTTP server port
- `HOST` — Bind address (localhost, 0.0.0.0)

### **2. Database (App Services Only)**
- `DATABASE_URL` — PostgreSQL connection string (psql://user:pass@host:port/db)

### **3. Cache (All Services)**
- `REDIS_URL` — Redis connection string (redis://host:port)

### **4. Observability**
- `OTEL_EXPORTER_OTLP_ENDPOINT` — OpenTelemetry collector endpoint
- `LOG_LEVEL` — Logging level (debug, info, warn, error)

### **5. Service Discovery (Gateway Only)**
- `AUTH_SERVICE_URL` — Auth service URL
- `USAGE_SERVICE_URL` — Usage service URL
- `BILLING_SERVICE_URL` — Billing service URL
- `ANALYTICS_SERVICE_URL` — Analytics service URL
- `WORKER_SERVICE_URL` — Worker service URL (if gateway routes to it)

### **6. Security (Auth Service Only)**
- `JWT_SECRET` — JWT signing secret (sensitive)
- `JWT_EXPIRES_IN` — JWT expiration (e.g., "1d", "7d")
- `SESSION_SECRET` — Session signing secret (sensitive)
- `AUTH_COOKIE_NAME` — Cookie name for session
- `AUTH_COOKIE_MAX_AGE_MS` — Cookie max age in ms

### **7. Rate Limiting (Gateway Only)**
- `RATE_LIMIT_MAX` — Max requests per window
- `RATE_LIMIT_WINDOW_MS` — Rate limit window in ms
- `INGESTION_RATE_LIMIT_MAX` — Ingestion API rate limit

### **8. Service-Specific (Worker Only)**
- `CONSUMER_GROUP_ID` — Kafka consumer group ID (if applicable)
- `STREAM_BUFFER_SIZE` — Stream processing buffer size

---

## Implementation Steps

### **Step 1: Auth Service**
**File**: `apps/auth-service/.env.example`

**Variables** (from env.ts schema):
```
# Auth Service Configuration

## Core
NODE_ENV=development
PORT=3000
HOST=0.0.0.0

## Database
DATABASE_URL=postgresql://user:password@localhost:5432/telemetry_auth

## Cache
REDIS_URL=redis://localhost:6379

## Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
LOG_LEVEL=debug

## Security (SENSITIVE - change in production)
JWT_SECRET=your-jwt-secret-at-least-32-chars-long-change-this
JWT_EXPIRES_IN=7d
SESSION_SECRET=your-session-secret-change-in-production
AUTH_COOKIE_NAME=session
AUTH_COOKIE_MAX_AGE_MS=604800000
```

**Key points**:
- Sensitive vars marked with comment "SENSITIVE - change in production"
- Example values are safe for local dev (localhost, simple secrets)
- All required vars from env.ts schema included
- Logical grouping by category

### **Step 2-6: Other App Services (Usage, Worker, Billing, Analytics)**
**Files**: `apps/{service}/src/config/env.ts` → `.env.example`

**Pattern** (same as Step 1):
```
# [Service] Configuration

## Core
NODE_ENV=development
PORT=300X
HOST=0.0.0.0

## Database
DATABASE_URL=postgresql://user:password@localhost:5432/telemetry_[service]

## Cache
REDIS_URL=redis://localhost:6379

## Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
LOG_LEVEL=debug
```

**Variations**:
- **Worker service**: Add CONSUMER_GROUP_ID, STREAM_BUFFER_SIZE if applicable
- **Usage service**: Standard app service vars only
- **Billing service**: Add any billing-specific env vars (payment processor, tax rates, etc.)
- **Analytics service**: Standard app service vars only

**Rationale**: All app services follow same core pattern; only add service-specific vars where needed.

### **Step 7: Gateway**
**File**: `apps/gateway/.env.example`

**Variables** (no Prisma; includes service URLs):
```
# Gateway Configuration

## Core
NODE_ENV=development
PORT=3100
HOST=0.0.0.0

## Cache (no Database for gateway)
REDIS_URL=redis://localhost:6379

## Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
LOG_LEVEL=debug

## Security (SENSITIVE)
JWT_SECRET=your-jwt-secret-at-least-32-chars-long-change-this

## Service Discovery (point to local services for dev)
AUTH_SERVICE_URL=http://localhost:3000
USAGE_SERVICE_URL=http://localhost:3001
BILLING_SERVICE_URL=http://localhost:3002
ANALYTICS_SERVICE_URL=http://localhost:3003
WORKER_SERVICE_URL=http://localhost:3004

## Rate Limiting
RATE_LIMIT_MAX=1000
RATE_LIMIT_WINDOW_MS=60000
INGESTION_RATE_LIMIT_MAX=5000
```

**Key points**:
- NO `DATABASE_URL` (gateway is stateless)
- Service URLs point to localhost for local dev
- Rate limit values are reasonable defaults

### **Step 8: Web Frontend (Optional)**
**File**: `apps/web/.env.example`

**Variables** (if Vite/frontend env vars exist):
```
# Web Frontend Configuration

# API Gateway endpoint (change for different environments)
VITE_API_URL=http://localhost:3100

# Feature flags or app-specific vars
VITE_APP_VERSION=0.1.0
```

**Rationale**: Frontend env vars are prefixed with VITE_ (Vite convention); document any public/safe vars (not secrets).

---

## Validation Strategy

| Step | What to Validate | Command/Check | Expected Outcome |
|------|-----------------|---|---|
| 1 | File exists for each service | `ls -la apps/*/\env.example` | 6+ files found |
| 2 | No actual secrets in examples | `grep -r "your-secret" apps/*/\env.example` | All marked as "SENSITIVE" or "change-this" |
| 3 | All schema vars documented | Compare `env.ts` schema keys vs `.env.example` | 100% coverage |
| 4 | No typos in var names | Run each service with example env | Services start without "Missing env var" errors |
| 5 | Consistent formatting | Spot-check 3 services | Similar structure, comments, grouping |
| 6 | README or docs referenced | Check if docs/development-setup.md mentions `.env.example` | Link/reference exists |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Missing or outdated variables** | Developers can't start services; confusion | Validate against env.ts schema; recheck every quarter when env changes |
| **Secrets in example files** | Accidental commit of real secrets | Mark all sensitive vars with comment; use placeholder values like "change-this" |
| **Inconsistent formatting** | Hard to read/maintain | Define template pattern (categories, comments); review all 7 files |
| **Gateway URLs wrong in examples** | Gateway can't reach services | Use localhost for dev; document prod values in runbook, not in .env.example |
| **Copy-paste errors across services** | Subtle bugs in one service spreads to others | Review pairwise: auth ↔ usage ↔ billing (similar), worker separately |

---

## Testing Strategy

**Manual validation** (per service):
```bash
# 1. Copy example to actual .env
cp apps/auth-service/.env.example apps/auth-service/.env

# 2. Start service (should load successfully)
cd apps/auth-service
pnpm dev

# 3. Verify no "Missing env var X" errors
# 4. Check logs show "Started on port 3000" or similar
# 5. Ctrl+C to stop
```

**Batch check** (all services):
```bash
# Verify all .env.example files exist
for dir in apps/auth-service apps/usage-service apps/billing-service apps/analytics-service apps/worker-service apps/gateway; do
  if [ ! -f "$dir/.env.example" ]; then
    echo "MISSING: $dir/.env.example"
  fi
done
```

---

## Acceptance Criteria

- [ ] `.env.example` file exists for all 7 services
- [ ] All required env vars from each service's `env.ts` are documented
- [ ] Example values are safe for local development (localhost, placeholder secrets)
- [ ] Sensitive vars are marked with comments ("SENSITIVE - change in production")
- [ ] Variables are grouped by category (Core, Database, Cache, Observability, Security, etc.)
- [ ] No actual secrets or real passwords in any `.env.example` file
- [ ] File can be copied to `.env` and service starts without "Missing env var" errors
- [ ] Formatting is consistent across all 7 files
- [ ] Comments explain the purpose of each variable (1-2 sentences)

---

## Pending Tasks & Follow-up

| Task | ID | Status | Notes |
|------|----|----|---|
| **Unit tests for shutdown handlers** | T-024b | Pending (pre-prod) | From T-015 QA gap |
| **Docker Compose .env update** | Future | Pending | Align docker-compose.yml with .env.example variables |
| **Env schema consolidation** | Future | Nice-to-have | If services share env vars, consolidate to shared-config package |
| **Production env docs** | Future | Pending | Separate runbook for prod env vars (secrets management strategy) |

---

## Stage Tracker

- Current stage: Task Planning (done)
- Previous stage: Epic Router (done)
- Next stage: Implementation
- Blocker reason: none
- Pending tasks snapshot:
  - T-016 Phase 1: Create .env.example for all 7 services (pending)
  - T-016 Phase 2: Validation (manual tests) (pending)
- Evidence: Plan file at `/home/admin1/personal-workspace/telemetry-platform/docs/plans/t-016-env-example-files.md`

---

## Ready for Implementation

**YES** — Plan is complete and ready for Task Implementer.

**Why**:
1. ✅ File paths are explicit (all 7 services + optional root)
2. ✅ Variables are sourced from existing env.ts schemas
3. ✅ Template pattern is defined (category grouping, comments, sensitivity markers)
4. ✅ Validation strategy is concrete (file checks, startup tests)
5. ✅ Risks are identified with mitigations
6. ✅ Acceptance criteria are measurable
7. ✅ No code changes required (documentation only)

---

**Plan file path**: `/home/admin1/personal-workspace/telemetry-platform/docs/plans/t-016-env-example-files.md`
