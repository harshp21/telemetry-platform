# Day 1 Status

Date: 2026-08-22
Target: Senior Backend Engineer

## Decisions finalized

1. Event payload shape
- Use a versioned envelope with required fields: `eventId`, `tenantId`, `eventType`, `occurredAt`, `receivedAt`, `source`, `idempotencyKey`, `version`, `payload`.
- v1 evolution rule: additive-only payload changes.

2. Multi-tenancy scope
- Tenant scoping required at repository boundary.
- PostgreSQL RLS enabled from first database iteration.

3. API versioning strategy
- External APIs use URI major versioning under `/v1`.
- Breaking changes require a new major path.

4. Internal vs external boundary
- External access only through gateway.
- Internal routes are private and protected by `X-Internal-Secret`.

## Documentation updated

- `docs/epics/README.md`: decision gates marked as decided with implementation notes.
- `docs/architecture-overview.md`: Day 1 architecture decision section added.

## Baseline validation run

1. Dependencies
- `pnpm install`: pass (already up to date).

2. Quality gates
- `pnpm lint`: pass
- `pnpm typecheck`: pass
- `pnpm test`: pass
- `pnpm build`: pass

3. Infrastructure startup
- `docker compose -f docker/docker-compose.yml up -d`: blocked
- Reason: Docker daemon is not running/accessible in this environment.

4. Service startup checks
- Standalone runtime checks confirm services can start individually (validated on multiple services via `pnpm run dev` / `pnpm exec tsx src/index.ts`).
- Full monorepo `pnpm dev` is not stable in this environment due execution-context issues (sandbox/PATH/IPC behavior around `tsx watch`).

## Top 3 technical risks

1. Environment mismatch risk
- Local execution environment currently prevents Docker-based infra bring-up and reliable orchestrated watch-mode startup.

2. Runtime build artifact risk
- Built JS output uses `@/` alias imports, so direct `node dist/...` runtime checks are not portable without resolver support.

3. Delivery sequencing risk
- RLS from day 1 is a stronger safety baseline, but can add migration and query-complexity overhead if not introduced with tests and helper abstractions.

## Day 2 plan

1. Environment unblock
- Ensure Docker daemon is running and compose stack is healthy.
- Re-run infra startup and verify postgres/redis readiness.

2. Database + tenancy implementation
- Implement initial Prisma schema with tenant-aware models.
- Add RLS policies and migration scripts.
- Add tests for repository-level tenant scoping + RLS enforcement.

3. Usage ingestion contract
- Implement v1 event schema validation and idempotency key generation path.
- Add contract tests for valid/invalid events and version handling.

4. Gateway boundary
- Wire `/v1` route prefixes for external API.
- Add internal route auth middleware using `X-Internal-Secret`.
