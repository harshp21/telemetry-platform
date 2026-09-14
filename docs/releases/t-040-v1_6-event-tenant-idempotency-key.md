# Release note — T-040 · `v1_6_event_tenant_idempotency_key`

**Migration:** `prisma/migrations/v1_6_event_tenant_idempotency_key/migration.sql`
**Ships with:** T-040 (worker-service event → `UsageLine` processor)
**Forward-only. There is no down migration, and this repository has no mechanism for one.**

---

## What it does

Two statements:

```sql
DROP INDEX IF EXISTS "Event_idempotencyKey_key";
CREATE UNIQUE INDEX "Event_tenantId_idempotencyKey_key" ON "Event"("tenantId", "idempotencyKey");
```

It replaces a **globally** unique index on `Event."idempotencyKey"` with one scoped to
`("tenantId", "idempotencyKey")`.

## Why it is required rather than tidy-up

The idempotency key that travels on the Redis stream is tenant-less by construction:
`DeduplicationService` owns the tenant segment of the dedup keyspace (S-1), so the key
usage-service publishes is whatever the customer sent, or
`<eventType>:<sourceId ?? "unknown">:<occurredAt>`. Two tenants collide easily — `"unknown"` is
the default `sourceId`.

Under the **global** unique, measured as `telemetry_app` (`NOSUPERUSER`, `NOBYPASSRLS`) with
tenant A holding the key and tenant B replaying it, every shape an upsert can compile to fails,
and two of them fail worse than an error:

| Shape | Result under the global unique |
|---|---|
| read-then-write (**what Prisma 6.19.3 actually emits**) | `SELECT` returns 0 rows — RLS hides A's row — then `INSERT` → `duplicate key value violates unique constraint "Event_idempotencyKey_key"` |
| `ON CONFLICT DO NOTHING` | `INSERT 0 0`, **transaction still alive and would commit** — the worker acknowledges a message it never stored |
| `ON CONFLICT DO UPDATE` | `new row violates row-level security policy (USING expression) for table "Event"` |

Under T-040's no-acknowledgement-on-throw contract, rows 1 and 3 are a **cross-tenant poison
message**: tenant A's traffic permanently blocks tenant B's event, retried forever. Row 2 loses
the event silently. With the compound index all three return `INSERT 0 1`, and same-tenant replay
still collapses to one row.

Re-derived independently at Gate 0, Gate 1, Gate 3, Gate 4 and Gate 5 — the last of those on a
direct `telemetry_app` login rather than `SET LOCAL ROLE`.

## Deploy ordering

**Apply the migration before starting a worker-service instance that carries T-040.** The
processor's upsert targets `tenantId_idempotencyKey`, which does not exist until this runs; a
worker started first fails its first message and does not acknowledge it, so nothing is lost, but
it makes no progress.

There is no config flip and no feature flag. Migrations run as the owner through
`DIRECT_DATABASE_URL`; never point a running service at it.

Apply order: **migrate, then deploy.** Gateway, auth, usage, billing and analytics are unaffected
— no other package queries `Event` at all.

## Blast radius

- **`Event` held 0 rows when this was written**, so there is no backfill and no possibility of the
  new index failing on existing duplicates. **Re-check that before applying to an environment that
  has traffic** — see the rollback section, because a populated `Event` table is the case where
  this note matters.
- The old object is an **index**, not a constraint (`pg_constraint` confirms), so `DROP INDEX` is
  the correct and sufficient statement. This mirrors `v1_1`'s shape.
- No application code queried `Event` by `idempotencyKey`, so dropping the global unique broke no
  caller.

## Rollback lever, stated honestly

**There is no down migration.** To reverse this by hand:

```sql
DROP INDEX IF EXISTS "Event_tenantId_idempotencyKey_key";
CREATE UNIQUE INDEX "Event_idempotencyKey_key" ON "Event"("idempotencyKey");
```

**The second statement can fail**, and that is the whole reason this note exists. Once a
post-T-040 worker has run, `Event` may legitimately hold two rows sharing an `idempotencyKey`
across different tenants — exactly what this migration exists to permit. Recreating the global
unique over that data raises
`could not create unique index "Event_idempotencyKey_key" … Key (idempotencyKey)=(…) is duplicated`.

So the rollback is **not** unconditional. Before attempting it:

```sql
SELECT "idempotencyKey", count(*) FROM "Event" GROUP BY 1 HAVING count(*) > 1;
```

If that returns rows, the reverse migration cannot be applied without deciding which tenant's
event to delete — a data-loss decision, not a schema one. Roll back the *application* instead and
leave the index in place: a pre-T-040 worker writes no `Event` rows at all, so the compound index
is inert for it.

## Verification after applying

```bash
pnpm prisma migrate status            # clean, no pending
```
```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'Event';
-- expect Event_tenantId_idempotencyKey_key, and no Event_idempotencyKey_key
```

`prisma migrate diff` against the schema should report nothing about `Event`. Note that on this
repository it currently reports a pre-existing `User.firstName`/`lastName` default drift unrelated
to this change — that is **S-30**, not a failed apply.
