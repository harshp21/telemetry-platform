import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { EventRepository } from "../src/repositories/event.repository";
import { parseStreamMessage } from "../src/validators/stream-message.validator";
import { WORKER_EVENT_PROCESSING } from "../src/constants";

/**
 * Unit suite for T-040's `EventRepository` (slice S4).
 *
 * What a mock can prove here is the *shape* of the transaction: that there is exactly one, that
 * the RLS context is set as its first statement, and that nothing that leaves this class is a
 * `Prisma.Decimal`. What it cannot prove is that RLS then enforces anything — that needs a live
 * database and a `NOSUPERUSER NOBYPASSRLS` role, which is `event.processor.integration.test.ts`
 * (`.claude/rules/tenant-isolation.md`: never treat a passing RLS test as evidence unless it
 * runs as that role). Neither file stands in for the other.
 */

const TENANT_ID = "456793cd-6625-44f6-af63-142a86019e1a" as TenantId;
/** A second tenant, used only as a value the bound values must **not** contain. */
const OTHER_TENANT_ID = "d4101ff1-8a17-47f7-9765-73c73ccf0441";
const EVENT_ID = "7c05417c-4e79-461e-97d6-222ecd8fe913";
const PERSISTED_EVENT_ID = "3c9d8ee5-1b2a-4c3d-8e4f-5a6b7c8d9e0f";
const EVENT_TYPE = "api.request";
const UNIT = "request";
const IDEMPOTENCY_KEY = "idem_1";
const OCCURRED_AT_ISO = "2026-01-01T00:00:00.000Z";

/**
 * The quantity that makes the difference between a string bind and a number bind visible:
 * `12345678901.123456` bound as a JS `number` was stored as `12345678901.123460`, silently
 * (plan Appendix A/P-DEC).
 */
const QUANTITY_FULL_PRECISION = "12345678901.123456";

/**
 * The session setting `TenantScopedRepository.withTenant` writes, as a literal.
 *
 * There is no worker-service constant to import: worker's `base.repository.ts` hard-codes the
 * string, which is one of the six copies S-19 counts, and that file is explicitly outside this
 * task's diff. Written out here rather than imported from usage-service's
 * `DATABASE_SESSION_SETTINGS.TENANT_ID`, because importing another service's constant to
 * assert this one's SQL would make the assertion pass even if the two drifted apart — which is
 * exactly the drift S-19 is about.
 */
const TENANT_CONTEXT_SETTING = "app.tenant_id";

/** Call counts and positions, named so no bare numeral carries meaning in an assertion. */
const CALLS = {
  NONE: 0,
  ONCE: 1,
  TWICE: 2
} as const;

/** First element of a recorded call list. Separate from `CALLS` -- a position is not a count. */
const INDEX_FIRST = 0;

const streamFields = (overrides: Record<string, string> = {}): string[] =>
  Object.entries({
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID]: EVENT_ID,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: TENANT_ID,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_TYPE]: EVENT_TYPE,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY]: QUANTITY_FULL_PRECISION,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.UNIT]: UNIT,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT]: OCCURRED_AT_ISO,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.IDEMPOTENCY_KEY]: IDEMPOTENCY_KEY,
    ...overrides
  }).flat();

describe("EventRepository.upsertEventWithUsageLine", () => {
  /** Every call made on the transaction client, in order, so ordering is assertable. */
  let txCalls: string[];
  let queryRaw: ReturnType<typeof vi.fn>;
  let eventFindUnique: ReturnType<typeof vi.fn>;
  let eventUpsert: ReturnType<typeof vi.fn>;
  let usageLineUpsert: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;
  let repository: EventRepository;

  const silentLogger = {
    error: (): void => undefined,
    debug: (): void => undefined
  };

  /** Throws rather than returning undefined, so a missing call cannot pass vacuously. */
  const onlyCallArgs = (spy: ReturnType<typeof vi.fn>, name: string): unknown[] => {
    const call = spy.mock.calls[INDEX_FIRST];
    if (!call) {
      throw new Error(`${name} was never called`);
    }

    return call;
  };

  beforeEach(() => {
    txCalls = [];
    queryRaw = vi.fn(() => {
      txCalls.push("$queryRaw");

      return Promise.resolve([]);
    });
    eventFindUnique = vi.fn(() => {
      txCalls.push("event.findUnique");

      return Promise.resolve(null);
    });
    eventUpsert = vi.fn(() => {
      txCalls.push("event.upsert");

      return Promise.resolve({
        id: PERSISTED_EVENT_ID,
        // The ORM hands back a `Prisma.Decimal`, which is the thing that must not escape.
        quantity: new Prisma.Decimal(QUANTITY_FULL_PRECISION)
      });
    });
    usageLineUpsert = vi.fn(() => {
      txCalls.push("usageLine.upsert");

      return Promise.resolve({
        id: "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d",
        quantity: new Prisma.Decimal(QUANTITY_FULL_PRECISION)
      });
    });

    const tx = {
      $queryRaw: queryRaw,
      event: { findUnique: eventFindUnique, upsert: eventUpsert },
      usageLine: { upsert: usageLineUpsert }
    };
    transaction = vi.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx));

    repository = new EventRepository(
      { $transaction: transaction } as unknown as PrismaClient,
      TENANT_ID,
      silentLogger
    );
  });

  it("U47 - runs both writes in one transaction whose first statement sets the tenant context", async () => {
    await repository.upsertEventWithUsageLine(parseStreamMessage(streamFields()));

    // **One** transaction, not two. Two `withTenant` calls would leave an `Event` with no
    // `UsageLine` whenever the process died between them, and nothing repairs that.
    expect(transaction).toHaveBeenCalledTimes(CALLS.ONCE);

    // First, not merely present. No statement against a tenant-scoped table may precede the
    // RLS context — `.claude/rules/tenant-isolation.md` layer 4 — and "both happened" would
    // pass for an implementation that set it last.
    expect(txCalls[INDEX_FIRST]).toBe("$queryRaw");
    expect(txCalls).toEqual([
      "$queryRaw",
      "event.findUnique",
      "event.upsert",
      "usageLine.upsert"
    ]);

    const [templateStrings, boundTenantId] = onlyCallArgs(queryRaw, "$queryRaw");
    expect((templateStrings as string[]).join("")).toContain(TENANT_CONTEXT_SETTING);
    // The tenant id is **bound**, not interpolated, and it is the repository's own.
    expect(boundTenantId).toBe(TENANT_ID);
  });

  it("U49 - returns the quantity as a string, never as a Prisma.Decimal, and never another tenant's id", async () => {
    const result = await repository.upsertEventWithUsageLine(parseStreamMessage(streamFields()));

    // `Decimal(18,6)` exceeds IEEE-754 safe precision, so it is normalised to a string here and
    // only here — `CLAUDE.md` § Prisma: never let a `Prisma.Decimal` reach a JSON response.
    expect(result.quantity).toBe(QUANTITY_FULL_PRECISION);
    expect(typeof result.quantity).toBe("string");
    expect(result.quantity).not.toBeInstanceOf(Prisma.Decimal);
    expect(result.eventId).toBe(PERSISTED_EVENT_ID);
    // `findUnique` found nothing, so this call inserted.
    expect(result.created).toBe(true);

    // Every tenant id this repository puts in front of the database is its own. The negative
    // matters more than the positive: a `where` built from the parsed message rather than from
    // the bound context would still contain *a* tenant id and still look right.
    const bound = JSON.stringify([
      queryRaw.mock.calls,
      eventFindUnique.mock.calls,
      eventUpsert.mock.calls,
      usageLineUpsert.mock.calls
    ]);
    expect(bound).toContain(TENANT_ID);
    expect(bound).not.toContain(OTHER_TENANT_ID);
  });

  it("U51 - addresses the Event by (tenantId, idempotencyKey) and the UsageLine by eventId, both with the bound tenant", async () => {
    await repository.upsertEventWithUsageLine(parseStreamMessage(streamFields()));

    const [upsertArgs] = onlyCallArgs(eventUpsert, "event.upsert") as [
      {
        where: {
          tenantId: string;
          tenantId_idempotencyKey: { tenantId: string; idempotencyKey: string };
        };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }
    ];

    // Both halves of the predicate, and both tenant ids, come from `this.where(...)`. The
    // compound member is what the v1_6 migration added; without it, `where: { idempotencyKey }`
    // would address another tenant's row — and with it, that naive form does not compile
    // (`EventWhereUniqueInput` is `AtLeast<..., "id" | "tenantId_idempotencyKey">`).
    expect(upsertArgs.where.tenantId).toBe(TENANT_ID);
    expect(upsertArgs.where.tenantId_idempotencyKey).toEqual({
      tenantId: TENANT_ID,
      idempotencyKey: IDEMPOTENCY_KEY
    });

    // A replay must not rewrite the stored event. An `update` with any field in it would let a
    // redelivered entry mutate an audit record that billing may already have consumed.
    expect(upsertArgs.update).toEqual({});

    // The quantity reaches the ORM as the same string that was on the wire — not a number, and
    // not rounded on the way.
    expect(upsertArgs.create[WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY]).toBe(
      QUANTITY_FULL_PRECISION
    );
    expect(
      typeof upsertArgs.create[WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY]
    ).toBe("string");

    const [usageLineArgs] = onlyCallArgs(usageLineUpsert, "usageLine.upsert") as [
      { where: { tenantId: string; eventId: string }; create: Record<string, unknown> }
    ];
    // Keyed on the id the database actually returned, not on the id that arrived on the stream.
    // After the dedup TTL expires the producer republishes the same idempotency key under a
    // **new** `eventId`; keying the usage line on the wire value would then create a second
    // `UsageLine` for one `Event`.
    expect(usageLineArgs.where.eventId).toBe(PERSISTED_EVENT_ID);
    expect(usageLineArgs.where.tenantId).toBe(TENANT_ID);
    expect(usageLineArgs.create["eventId"]).toBe(PERSISTED_EVENT_ID);
    expect(usageLineArgs.create["tenantId"]).toBe(TENANT_ID);
  });

  it("U52 - reports a replay as not created, and still leaves the stored row untouched", async () => {
    eventFindUnique.mockImplementation(() => {
      txCalls.push("event.findUnique");

      return Promise.resolve({ id: PERSISTED_EVENT_ID });
    });

    const result = await repository.upsertEventWithUsageLine(parseStreamMessage(streamFields()));

    expect(result.created).toBe(false);
    expect(result.eventId).toBe(PERSISTED_EVENT_ID);
    // Still one transaction, still both upserts: the replay path is not a short-circuit that
    // skips the usage line. An `Event` whose `UsageLine` insert failed on a previous attempt is
    // repaired by the retry, which is the whole reason the second write is an upsert too.
    expect(transaction).toHaveBeenCalledTimes(CALLS.ONCE);
    expect(usageLineUpsert).toHaveBeenCalledTimes(CALLS.ONCE);
  });

  it("U58 - writes its own bound tenant, never the tenant id that travelled with the message", async () => {
    // The one case in the package where the repository's bound tenant and the payload's tenant
    // **disagree**. Every other fixture pairs them — `buildRepository(tenantAId)` with
    // `streamFields()`'s tenant A, `I15`'s B with B, `I18`'s unknown tenant with itself because
    // the processor derives the repository from `payload.tenantId` — so before this case the two
    // values were never distinguishable and nothing could observe which one was written.
    const payload = parseStreamMessage(
      streamFields({ [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: OTHER_TENANT_ID })
    );
    // The premise, asserted rather than assumed: the payload really does carry the other tenant.
    // Without this the case could pass because the override silently failed to apply.
    expect(payload.tenantId).toBe(OTHER_TENANT_ID);
    expect(payload.tenantId).not.toBe(TENANT_ID);

    await repository.upsertEventWithUsageLine(payload);

    // The mutation this exists for: drop `this.where(...)` from the `Event` `create` and write
    // `tenantId: payload.tenantId` instead. That edit typechecks clean and left the package
    // 126/126 green before this case existed -- measured, not supposed.
    //
    // Scope, corrected at the Gate-6 review (LOW-8): this case is **not** the only thing that
    // catches that edit -- `I21` catches it too, at the database, with `42501` from RLS's
    // `WITH CHECK` as `telemetry_app`, and the validator docstring says so. Two independent
    // guards, one in the call vector and one in PostgreSQL.
    //
    // This case **is** the only thing that catches a *second*, different edit, found at Gate 5:
    // `const tenantId = payload.tenantId` feeding the compound unique -- the tenant *read*
    // direction. All ten integration cases stay green on that one; only the whole-transaction
    // JSON negative below reddens. So that negative is load-bearing for two invariants, not
    // one. Do not narrow it to the `create` arguments. (That edit is also a correctness defect
    // in its own right: the predicate contradicts itself, so the idempotency lookup can never
    // hit -- but nothing else asserts that either.)
    const [upsertArgs] = onlyCallArgs(eventUpsert, "event.upsert") as [
      { create: Record<string, unknown>; where: { tenantId: string } }
    ];
    expect(upsertArgs.create[WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]).toBe(TENANT_ID);
    expect(upsertArgs.where.tenantId).toBe(TENANT_ID);

    const [usageLineArgs] = onlyCallArgs(usageLineUpsert, "usageLine.upsert") as [
      { create: Record<string, unknown> }
    ];
    expect(usageLineArgs.create[WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]).toBe(
      TENANT_ID
    );

    // The whole-transaction negative, which is only meaningful here: `U49` runs the same check
    // against a payload that never contained `OTHER_TENANT_ID`, so there it cannot fail. Here
    // the value is present in the input and must still reach the database nowhere.
    const bound = JSON.stringify([
      queryRaw.mock.calls,
      eventFindUnique.mock.calls,
      eventUpsert.mock.calls,
      usageLineUpsert.mock.calls
    ]);
    expect(bound).toContain(TENANT_ID);
    expect(bound).not.toContain(OTHER_TENANT_ID);
  });

  it("U53 - lets a transaction failure propagate, so the caller never acknowledges", async () => {
    const failure = new Error("insert or update on table \"Event\" violates foreign key constraint");
    usageLineUpsert.mockRejectedValue(failure);

    await expect(
      repository.upsertEventWithUsageLine(parseStreamMessage(streamFields()))
    ).rejects.toThrow(failure);
  });
});
