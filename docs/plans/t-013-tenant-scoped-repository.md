# T-013 Plan: Tenant-Scoped Repository Base

## Business Objective

**Problem**: Without a shared base class, an engineer writing a new `EventRepository.findMany()` can silently query across all tenants, leaking SaaS customer data.

**Goal**: Establish `TenantScopedRepository` as the base class for all per-tenant DB access before Epics 4–9 write any service-specific repositories.

---

## Scope

**New files (5, all identical)**:
- `apps/auth-service/src/repositories/base.repository.ts`
- `apps/usage-service/src/repositories/base.repository.ts`
- `apps/worker-service/src/repositories/base.repository.ts`
- `apps/billing-service/src/repositories/base.repository.ts`
- `apps/analytics-service/src/repositories/base.repository.ts`

**Updated files (5 barrel stubs — additive)**:
- `apps/{service}/src/repositories/index.ts` — add re-export of `TenantScopedRepository`

**Files NOT modified**:
- `apps/auth-service/src/repositories/user.repository.ts` — pre-auth operations are inherently cross-tenant (no tenantId at login time); extending the base class would be architecturally incorrect
- Any controller, service, plugin, or route file

---

## Exact File Content (all 5 files identical)

```ts
import type { PrismaClient, Prisma } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";

export abstract class TenantScopedRepository {
  constructor(
    protected readonly prisma: PrismaClient,
    protected readonly tenantId: TenantId
  ) {}

  protected where<T extends { tenantId?: never } & Record<string, unknown>>(
    conditions: T
  ): Omit<T, "tenantId"> & { tenantId: TenantId } {
    return { ...conditions, tenantId: this.tenantId };
  }

  // Sets app.tenant_id for the duration of the transaction so Postgres RLS policies fire.
  protected async withTenant<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${this.tenantId}, true)`;
      return fn(tx);
    });
  }
}
```

**Design notes**:
- `import type` for both imports — zero runtime cost, no module side-effects
- `{ tenantId?: never }` constraint — compile error if caller tries to pass `tenantId`
- `Omit<T, "tenantId">` in return type — prevents type conflicts with the constraint
- `withTenant()` activates Postgres RLS by calling `set_config('app.tenant_id', tenantId, true)` at the start of each transaction
- `prisma` is `protected`, so subclasses can access it; compile-time enforcement via ESLint rule is Epic 12 scope

---

## Acceptance Criteria

1. All 5 `base.repository.ts` files exist with identical content
2. `PrismaClient` imported as `import type` (type-only)
3. `TenantId` imported from `@telemetry/shared-types`
4. `pnpm typecheck` passes all 13 packages
5. Each `repositories/index.ts` re-exports `TenantScopedRepository`
6. `where()` has `{ tenantId?: never }` constraint preventing caller injection
7. `withTenant()` calls `set_config('app.tenant_id', ...)` to activate Postgres RLS policies
8. `withTenant()` includes error handling with transaction lifecycle logging (start, commit, rollback)
9. Logger is injected via constructor with console fallback for early-stage development
10. 8 unit tests pass: 4 for `where()` + 4 for `withTenant()` (including error handling)
11. 4 RLS integration tests verify cross-tenant blocking behavior
12. No controller, service, or plugin file touched

---

## Implementation Steps

1. Create `base.repository.ts` in auth-service with exact content above (includes `where()` and `withTenant()`)
2. Update auth-service `repositories/index.ts` to export `TenantScopedRepository`
3. Repeat for usage-service, worker-service, billing-service, analytics-service
4. Add unit tests covering: `where()` merging, `where()` override-wins, `withTenant()` set_config call, `withTenant()` callback return
5. Run `pnpm typecheck` — expect 13 packages, 0 errors
6. Run `pnpm --filter auth-service test` — expect 6/6 base.repository tests pass
7. Grep verify: `grep -c "TenantScopedRepository" apps/*/src/repositories/base.repository.ts` → 5 matches

---

## RLS Activation via `withTenant()`

**Problem**: Even though Postgres RLS policies are enabled and defined (Q6 decision), they don't fire without `app.tenant_id` set in the session.

**Solution**: The `withTenant()` method wraps repository callbacks in a Prisma transaction and calls `set_config('app.tenant_id', tenantId, true)` at the start.

**Why `true`?** The third parameter `true` means "is_local = true" — the config is scoped to the transaction only. Without it, the setting would persist in the connection pool across unrelated queries.

**Usage pattern** (by service-specific repositories in Epics 4+):
```ts
class EventRepository extends TenantScopedRepository {
  async findByTenantAndType(eventType: string) {
    return this.withTenant(async (tx) => {
      return tx.event.findMany({
        where: this.where({ eventType }),
      });
    });
  }
}
```

Both layers now protect the query:
1. **App-layer**: `this.where({ eventType })` merges `tenantId` into the WHERE clause
2. **DB-layer**: Postgres RLS policy blocks any row where `row.tenantId != current_setting('app.tenant_id')`

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| `import type` incompatible with tsconfig `isolatedModules` | Low | Type-only import; confirmed safe pattern across project |
| `@prisma/client` not in service `package.json` | Low | Already used in `prisma.ts`; confirmed present |
| Barrel index.ts already exports something that conflicts | Low | Current content is `export {};` — safe to replace |
| `user.repository.ts` expected to extend base | Low | Design decision: pre-auth ops are cross-tenant; documented above |
| `withTenant()` not called in service repos (RLS silent bypass) | High | Documented in pattern; T-014+ services must use `withTenant()` for tenant-scoped queries; code review catch |
| `set_config` called on every transaction (performance) | Low | One query per transaction; negligible overhead; RLS enforcement worth the cost |
| `is_local = true` prevents connection pool edge cases | Very Low | Postgres-standard; configs don't leak across unrelated transactions |

---

## Pending Tasks After T-013

- **T-014**: App container expansion — registers prisma singleton + logger + redis into typed container; service-specific repositories will receive prisma from container
- **T-015**: Graceful shutdown — calls `prisma.$disconnect()` at shutdown
- **T-016**: `.env.example` files
