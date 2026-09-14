import { Prisma } from "@prisma/client";
import { TenantScopedRepository } from "./base.repository";
import type { StreamEventPayload } from "../validators/stream-message.validator";

/**
 * What one processed stream entry left behind.
 *
 * `quantity` is a **string**. `Event.quantity` and `UsageLine.quantity` are `Decimal(18,6)`,
 * which exceeds IEEE-754 safe precision, and `CLAUDE.md` § Prisma requires normalising to
 * string in exactly one layer — that layer is this repository's return mapping, and nothing
 * above it ever sees a `Prisma.Decimal`.
 *
 * `created` distinguishes a first write from a replay. It is not decoration: a worker that
 * reclaims its pending list on every restart will reprocess entries routinely, and a log line
 * that cannot tell "stored" from "already stored" makes a redelivery storm look like traffic.
 */
export interface PersistedUsageEvent {
  readonly eventId: string;
  readonly quantity: string;
  readonly created: boolean;
}

/**
 * Writes one stream entry's `Event` and `UsageLine`, in one transaction, for one tenant.
 *
 * ## Why one repository rather than the two the epic names
 *
 * `docs/epics/epic-7-worker-service.md` lists `repositories/event.repository.ts` **and**
 * `repositories/usage-line.repository.ts`, and in the same breath requires the "entire
 * operation" to run in one Prisma transaction. On this codebase those conflict.
 * `TenantScopedRepository.withTenant` opens the transaction and hands `tx` to a callback, and
 * `TransactionClient` is module-private — declared without `export` in all five copies of
 * `base.repository.ts`. So two repositories are either two transactions (a crash between them
 * leaves an `Event` with no `UsageLine`, which nothing repairs) or one exported type, which
 * means editing `base.repository.ts` in one service alone — the thing S-19 says not to do.
 * Gate 2 decided one repository (D4-A); the epic's two-file list is reported as a divergence.
 *
 * ## Timestamps go through the ORM, and that is a decision (G0-2 / D-ORM)
 *
 * **No `$queryRaw` in this class binds a `Date`, and none should be added.** worker-service's
 * `withTenant` issues only `set_config('app.tenant_id', …, true)`; it does **not** carry
 * usage-service's `set_config('TimeZone','UTC',true)` pin (S-19 — `grep -c TIME_ZONE` is 1 for
 * usage-service and 0 for the other four). So a raw timestamp predicate written here inherits
 * S-18 exactly: a bound JS `Date` is `timestamptz`, and against these naive
 * `timestamp(3) without time zone` columns the comparison resolves through the *session* zone.
 * `CLAUDE.md` § *Raw SQL and timestamps* has the measurements. The ORM path was measured safe
 * under four session zones, and the query log shows `occurredAt` bound already UTC-normalised.
 *
 * Stated as a decision rather than as a guarantee: nothing in the type system stops a future
 * `$queryRaw` in this service, and this plan does not claim a test that would catch one. The
 * check is `grep -rn '\$queryRaw' apps/worker-service/src` returning only `base.repository.ts`'s
 * `set_config`, and it is a review check.
 *
 * ## What idempotency does and does not buy
 *
 * Prisma 6.19.3 compiles `upsert` to read-then-write, **not** `ON CONFLICT`, inside an
 * interactive transaction — observed with `log: ["query"]` across four upserts, none of which
 * emitted an `ON CONFLICT` clause. Read-then-write is not atomic against a concurrent writer:
 * two workers on the same key both find nothing and both insert, and the loser gets Prisma
 * `P2002` (its `meta.target` renders as `(not available)`, so a handler cannot discriminate on
 * it). That is **self-healing rather than handled**: the loser throws, the caller does not
 * acknowledge, and the retry's read finds the committed row. Bounding those retries is T-041's.
 */
export class EventRepository extends TenantScopedRepository {
  /**
   * Upserts the `Event` and its `UsageLine` together.
   *
   * Both `where` clauses go through `this.where(...)`, so the tenant predicate can only ever be
   * this repository's own bound tenant. The parsed message's tenant id is what *selected* this
   * repository from the container factory; it is never what gets written. `StreamEventPayload`
   * enforces that from the other side by having no `tenantId` on either row.
   *
   * The emitted SQL carries both guards, belt and braces (`.claude/rules/tenant-isolation.md`):
   * the `Event` lookup becomes
   * `WHERE (("tenantId" = $1 AND "idempotencyKey" = $2) AND "tenantId" = $3)` and the
   * `UsageLine` lookup `WHERE ("eventId" = $1 AND "tenantId" = $2)`, on top of the RLS policy
   * `("tenantId" = current_setting('app.tenant_id', true))` that `withTenant` activates.
   *
   * **Two honest limits.**
   *
   * 1. The read-back Prisma issues after an `INSERT` is `WHERE "id" = $1` with no tenant
   *    predicate. RLS covers it and it reads a row this same transaction just wrote, but the
   *    "explicit predicate on every query" property holds for the queries this method writes,
   *    not for every statement Prisma emits on its behalf.
   * 2. The tenant predicate on the **`UsageLine` lookup** is belt-and-braces with no reachable
   *    exploit behind it, and no integration case can prove otherwise. The plan predicted that
   *    replacing `this.where({ eventId })` with a bare `{ eventId }` would turn the
   *    cross-tenant case red. Measured: it does not, and cannot. `UsageLine.eventId` is
   *    globally `@unique` and is always an `Event.id`, which is a global primary key — so
   *    addressing another tenant's `UsageLine` would require this tenant to hold an `Event`
   *    with that id, which the primary key forbids. The mutation is caught by `U51`, which
   *    asserts the *shape* of the `where` object, and by nothing else. Kept because
   *    `.claude/rules/tenant-isolation.md` requires an explicit predicate on every
   *    tenant-scoped query and because the property should survive a future schema in which
   *    `eventId` is not globally unique — not because a test proves it load-bearing today.
   *    Filed as **S-28** so that "removing it is green" is never read as "removing it is safe".
   *
   * The `Event` lookup is different and is load-bearing: `I15` is red without the compound
   * unique the v1_6 migration added, because two tenants genuinely do share idempotency keys.
   *
   * @throws whatever the transaction throws, unchanged. That is the contract the caller needs:
   *   an entry whose transaction did not commit must not be acknowledged.
   */
  async upsertEventWithUsageLine(payload: StreamEventPayload): Promise<PersistedUsageEvent> {
    // Derived through the base helper, so the tenant id in the compound unique is the
    // repository's own and not a value that travelled with the message.
    const { tenantId } = this.where({});

    return this.withTenant(async (tx) => {
      // One extra indexed lookup per message, spent deliberately. `upsert` alone cannot report
      // whether it inserted, and the shapes that infer it are all wrong in the case that
      // matters: comparing the returned id against the wire `eventId` reports a redelivered
      // entry — the commonest replay — as a fresh insert, because that row was created with
      // exactly that id. Prisma compiles the upsert below to its own read-then-write anyway, so
      // this is one additional `SELECT` on a unique index inside a transaction that already
      // exists, in exchange for replay being observable rather than guessed at.
      const existing = await tx.event.findUnique({
        where: this.where({
          tenantId_idempotencyKey: {
            tenantId,
            idempotencyKey: payload.event.idempotencyKey
          }
        }),
        select: { id: true }
      });

      const event = await tx.event.upsert({
        where: this.where({
          tenantId_idempotencyKey: {
            tenantId,
            idempotencyKey: payload.event.idempotencyKey
          }
        }),
        create: this.where({
          // The stream's `eventId` becomes the row's primary key, so an `Event` is traceable
          // back to the entry that produced it without a second column.
          id: payload.event.eventId,
          idempotencyKey: payload.event.idempotencyKey,
          eventType: payload.event.eventType,
          quantity: payload.event.quantity,
          unit: payload.event.unit,
          occurredAt: payload.event.occurredAt,
          // `Prisma.DbNull` is SQL `NULL`; `Prisma.JsonNull` would store the JSON literal
          // `null`, which is a different value and would read back as a present-but-null blob.
          metadata: payload.event.metadata ?? Prisma.DbNull
        }),
        // A replay must not rewrite the audit record. Billing may already have priced the
        // `UsageLine` derived from it, and `Event` is the evidence for that.
        update: {},
        select: { id: true, quantity: true }
      });

      const usageLine = await tx.usageLine.upsert({
        // Keyed on the id the database returned, not on `payload.event.eventId`. Once the
        // producer's 24 h dedup window expires, the same idempotency key is republished under a
        // fresh `eventId`; keying on the wire value would then attach a second `UsageLine` to
        // one `Event`, which `UsageLine.eventId`'s `@unique` would reject as a hard failure.
        where: this.where({ eventId: event.id }),
        create: this.where({
          eventId: event.id,
          metricKey: payload.usageLine.metricKey,
          quantity: payload.usageLine.quantity,
          periodStart: payload.usageLine.periodStart,
          periodEnd: payload.usageLine.periodEnd
        }),
        update: {},
        select: { quantity: true }
      });

      return {
        eventId: event.id,
        // Normalised here, and only here. `String(...)` over a `Prisma.Decimal` yields the
        // column's exact stored value; the `usageLine` read is what proves the two rows agree.
        quantity: String(usageLine.quantity ?? event.quantity),
        created: existing === null
      };
    });
  }
}
