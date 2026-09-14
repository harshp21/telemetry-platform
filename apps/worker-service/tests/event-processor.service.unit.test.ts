import { beforeEach, describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import type { Logger } from "pino";
import type { ServiceEnv } from "../src/config/env";
import type { TenantId } from "@telemetry/shared-types";
import { EventProcessorService } from "../src/services/event-processor.service";
import type { EventRepository } from "../src/repositories/event.repository";
import { WORKER_EVENT_PROCESSING } from "../src/constants";

/**
 * Unit suite for T-040's `EventProcessorService` (slice S5).
 *
 * Three properties live here and nowhere else, because each is about *ordering* or *identity*
 * rather than about a stored row:
 *
 * - the `XACK` happens strictly after the repository's promise resolves (`U43`);
 * - it is sent on the container's connection, not the loop's blocking one (`U44`);
 * - no log line ever carries a stream field value (`U45`).
 *
 * A live-Redis suite can see that a successful entry stopped being pending, but it cannot see
 * *when* the acknowledgement was issued relative to the commit, which is the whole contract.
 */

const TENANT_ID = "456793cd-6625-44f6-af63-142a86019e1a";
const OTHER_TENANT_ID = "d4101ff1-8a17-47f7-9765-73c73ccf0441";
const EVENT_ID = "7c05417c-4e79-461e-97d6-222ecd8fe913";
const PERSISTED_EVENT_ID = "3c9d8ee5-1b2a-4c3d-8e4f-5a6b7c8d9e0f";
const EVENT_TYPE = "api.request";
const UNIT = "request";
const IDEMPOTENCY_KEY = "idem_1";
const OCCURRED_AT_ISO = "2026-01-01T00:00:00.000Z";
const QUANTITY = "12345678901.123456";
const ENTRY_ID = "1787746970722-0";
const SECOND_ENTRY_ID = "1788171536033-0";

/** Flattened customer metadata — the thing that must never reach a log line. */
const SOURCE_ID_FIELD = "sourceId";
const SOURCE_ID_VALUE = "sdk-web";

/** Stream/group identity, differing from the shipped defaults so a default cannot pass. */
const OVERRIDE = {
  STREAM_NAME: "telemetry:events:t040-unit",
  CONSUMER_GROUP: "worker-group-t040-unit"
} as const;

/** Call counts and positions, named so no bare numeral carries meaning in an assertion. */
const CALLS = {
  NONE: 0,
  ONCE: 1,
  TWICE: 2
} as const;

/** First element of a recorded call list. Separate from `CALLS` -- a position is not a count. */
const INDEX_FIRST = 0;

const REPOSITORY_FAILURE = "insert or update on table \"Event\" violates foreign key constraint";

const streamFields = (overrides: Record<string, string> = {}): string[] =>
  Object.entries({
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID]: EVENT_ID,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: TENANT_ID,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_TYPE]: EVENT_TYPE,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY]: QUANTITY,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.UNIT]: UNIT,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT]: OCCURRED_AT_ISO,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.IDEMPOTENCY_KEY]: IDEMPOTENCY_KEY,
    [SOURCE_ID_FIELD]: SOURCE_ID_VALUE,
    ...overrides
  }).flat();

describe("EventProcessorService", () => {
  /** Every externally-visible step, in order, so `U43` asserts sequence and not co-occurrence. */
  let steps: string[];
  let upsert: ReturnType<typeof vi.fn>;
  let factory: ReturnType<typeof vi.fn>;
  let containerXack: ReturnType<typeof vi.fn>;
  let readConnectionXack: ReturnType<typeof vi.fn>;
  let mockRedis: { xack: ReturnType<typeof vi.fn>; duplicate: ReturnType<typeof vi.fn> };
  let mockLogger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
  let builtRepositories: unknown[];

  const env = {
    REDIS_STREAM_NAME: OVERRIDE.STREAM_NAME,
    REDIS_CONSUMER_GROUP: OVERRIDE.CONSUMER_GROUP
  } as ServiceEnv;

  const buildProcessor = (): EventProcessorService =>
    new EventProcessorService(
      mockRedis as unknown as Redis,
      mockLogger as unknown as Logger,
      env,
      factory as unknown as (tenantId: TenantId) => EventRepository
    );

  /**
   * Every argument list passed to every logger method.
   *
   * Throws in both directions a vacuous pass could come from — a missing mock method, and a
   * subject that logged nothing at all. Same shape as the consumer suite's `allLogCalls`.
   */
  const allLogCalls = (): unknown[][] => {
    const methods = [mockLogger.info, mockLogger.warn, mockLogger.error, mockLogger.debug];
    const calls = methods.flatMap((method) => {
      if (!method) {
        throw new Error("the logger mock is missing a method the redaction check needs");
      }

      return method.mock.calls;
    });
    if (calls.length === CALLS.NONE) {
      throw new Error("the subject wrote no log line at all, so nothing was checked");
    }

    return calls;
  };

  beforeEach(() => {
    steps = [];
    builtRepositories = [];
    upsert = vi.fn(() => {
      steps.push("upsert");

      return Promise.resolve({
        eventId: PERSISTED_EVENT_ID,
        quantity: QUANTITY,
        created: true
      });
    });
    factory = vi.fn(() => {
      const repository = { upsertEventWithUsageLine: upsert };
      builtRepositories.push(repository);

      return repository;
    });
    containerXack = vi.fn(() => {
      steps.push("xack");

      return Promise.resolve(1);
    });
    readConnectionXack = vi.fn(() => Promise.resolve(1));
    mockRedis = {
      xack: containerXack,
      // Present so that "the ack did not go to the loop's connection" is an assertion about a
      // spy that exists, rather than about a method that was never there to call.
      duplicate: vi.fn(() => ({ xack: readConnectionXack }))
    };
    mockLogger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  });

  it("U43 - acknowledges strictly after the transaction resolves, never before", async () => {
    // The repository resolves on a later turn, so "before" and "after" are distinguishable. A
    // synchronously-resolved stub would let an implementation that acked first still record the
    // same two steps in the same order for the wrong reason.
    upsert.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            steps.push("upsert");
            resolve({ eventId: PERSISTED_EVENT_ID, quantity: QUANTITY, created: true });
          }, 0);
        })
    );

    await buildProcessor().buildHandler()(ENTRY_ID, streamFields());

    // Ordering, not "both happened". The mutation this exists for is moving the `xack` above
    // the `await` on the repository: that leaves both calls present and only the order wrong,
    // and an acknowledged entry whose write then fails is unrecoverable data loss.
    expect(steps).toEqual(["upsert", "xack"]);
    expect(containerXack).toHaveBeenCalledWith(
      OVERRIDE.STREAM_NAME,
      OVERRIDE.CONSUMER_GROUP,
      ENTRY_ID
    );
  });

  it("U44 - acknowledges on the container's connection, not the loop's blocking one", async () => {
    await buildProcessor().buildHandler()(ENTRY_ID, streamFields());

    expect(containerXack).toHaveBeenCalledTimes(CALLS.ONCE);
    // `run()` parks its own `duplicate()` on a blocking `XREADGROUP`. An ack queued behind that
    // read waits the block out — measured on a shared connection, an unrelated `PING` issued
    // during a `BLOCK 2000` came back after 2 080 ms.
    expect(readConnectionXack).not.toHaveBeenCalled();
    expect(mockRedis.duplicate).not.toHaveBeenCalled();
  });

  it("U45 - logs the entry and event ids and never a stream field value", async () => {
    await buildProcessor().buildHandler()(ENTRY_ID, streamFields());

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: ENTRY_ID, eventId: PERSISTED_EVENT_ID }),
      WORKER_EVENT_PROCESSING.LOG.PROCESSED
    );

    // Across *every* logger method, not just the one the happy path uses: this service has no
    // redaction layer, and the fields carry a tenant id and customer-shaped metadata.
    const serialised = JSON.stringify(allLogCalls());
    expect(serialised).not.toContain(SOURCE_ID_VALUE);
    expect(serialised).not.toContain(TENANT_ID);
    expect(serialised).not.toContain(IDEMPOTENCY_KEY);
    expect(serialised).not.toContain(QUANTITY);
    // The positive half, so the negatives above are not passing because nothing was logged.
    expect(serialised).toContain(ENTRY_ID);
  });

  it("U48 - builds a repository per message from the parsed tenant id, never reusing one across tenants", async () => {
    const handler = buildProcessor().buildHandler();

    await handler(ENTRY_ID, streamFields());
    await handler(
      SECOND_ENTRY_ID,
      streamFields({ [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: OTHER_TENANT_ID })
    );

    // A factory, never a singleton (`.claude/rules/tenant-isolation.md`): a singleton pins one
    // tenant process-wide, and this worker sees every tenant's events on one stream.
    expect(factory).toHaveBeenCalledTimes(CALLS.TWICE);
    expect(factory).toHaveBeenNthCalledWith(CALLS.ONCE, TENANT_ID);
    expect(factory).toHaveBeenNthCalledWith(CALLS.TWICE, OTHER_TENANT_ID);
    // Two distinct instances, not one reconfigured: `tenantId` is a constructor argument, so a
    // reused instance would write the first tenant's id for the second tenant's event.
    expect(builtRepositories[INDEX_FIRST]).not.toBe(builtRepositories[INDEX_FIRST + CALLS.ONCE]);
  });

  it("U54 - does not acknowledge when the transaction throws, and lets the rejection reach the loop", async () => {
    upsert.mockRejectedValue(new Error(REPOSITORY_FAILURE));

    await expect(
      buildProcessor().buildHandler()(ENTRY_ID, streamFields())
    ).rejects.toThrow(REPOSITORY_FAILURE);

    // The contract T-039's D2-A left open. `dispatch` catches this, logs against the entry id
    // and continues; the entry stays in the pending list because nothing acknowledged it.
    expect(containerXack).not.toHaveBeenCalled();
  });

  it("U55 - does not acknowledge, and does not reach the database, when the message cannot be parsed", async () => {
    await expect(
      buildProcessor().buildHandler()(ENTRY_ID, [
        WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID,
        "not-a-uuid"
      ])
    ).rejects.toThrow(WORKER_EVENT_PROCESSING.ERROR.INVALID_MESSAGE);

    // The parse happens before a repository is built, so an unparseable entry never selects a
    // tenant and never opens a transaction.
    expect(factory).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(containerXack).not.toHaveBeenCalled();
  });

  it("U56 - a failed acknowledgement is logged and rethrown rather than reported as success", async () => {
    const ackFailure = new Error("Connection is closed.");
    containerXack.mockRejectedValue(ackFailure);

    await expect(
      buildProcessor().buildHandler()(ENTRY_ID, streamFields())
    ).rejects.toThrow(ackFailure);

    // The write committed and the ack did not, so the entry is still pending and will be
    // redelivered — which the idempotent upsert absorbs. Swallowing this would instead report a
    // clean success for an entry that is going to come back, with no line saying why.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: ENTRY_ID }),
      WORKER_EVENT_PROCESSING.LOG.ACK_FAILED
    );
    expect(upsert).toHaveBeenCalledTimes(CALLS.ONCE);
  });
});
