import { describe, expect, it, vi, afterEach } from "vitest";
import { createContainer } from "../../src/config/container";
import { env, type ServiceEnv } from "../../src/config/env";
import { createLogger } from "@telemetry/shared-logger";
import type { TenantId } from "@telemetry/shared-types";
import { WORKER_DEAD_LETTER } from "../../src/constants";

/** A real Redis entry id, and a field list the parser rejects -- no database is reached. */
const ENTRY_ID = "1789101023800-0";
const MALFORMED_FIELDS = ["eventId", "not-a-uuid"];

/**
 * `HINCRBY`'s reply, chosen to sit **below** the retry budget so the wrapper rethrows.
 *
 * `1` is the first failure. Anything at or above `MAX_RETRY_COUNT` would take the dead-letter
 * branch, which resolves rather than rethrowing and issues an `XADD` -- a different case's
 * subject, and the shape that wrote to logical database 0 before every command was stubbed.
 */
const RETRY_COUNT_BELOW_BUDGET = 1;
/** `EXPIRE` replies `1` when the TTL was set. */
const EXPIRE_SET_REPLY = 1;
/** `HDEL`/`XACK` reply `0` when nothing matched -- these must not be called at all here. */
const NO_FIELD_REMOVED = 0;

describe("AppContainer (worker-service)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("createContainer() returns all required properties", () => {
    const container = createContainer("worker-service", env as ServiceEnv);

    expect(container).toBeDefined();
    expect(container.serviceName).toBe("worker-service");
    expect(container.env).toBeDefined();
    expect(container.logger).toBeDefined();
    expect(container.prisma).toBeDefined();
    expect(container.redis).toBeDefined();
    expect(container.eventRepositoryFactory).toBeDefined();
    expect(container.eventProcessor).toBeDefined();
    // T-041
    expect(container.deadLetterService).toBeDefined();
    expect(container.messageHandler).toBeDefined();
  });

  // T-041. The container is where the retry policy is composed, and composition is the only
  // thing this asserts -- `tests/dead-letter.service.unit.test.ts` owns what the policy does.
  //
  // Behaviour rather than an identity check: `expect(container.messageHandler).not.toBe(
  // container.eventProcessor.buildHandler())` would pass trivially, because `buildHandler()`
  // returns a fresh closure on every call. What distinguishes a wrapped handler from a raw one
  // is that the wrapped one talks to Redis *before* it delegates, so this drives it and watches
  // the client.
  //
  // **Every command the wrapper can issue is stubbed, and that is not defensiveness.** The first
  // revision of this case stubbed `hget` alone. `createContainer` builds a *real* `lazyConnect`
  // ioredis client against `REDIS_URL`, so the unstubbed `hincrby` on the failure path connected
  // for real and incremented `retries:telemetry:events` on **logical database 0** -- the
  // developer's live stream. Three runs later the counter reached the default budget of 3, the
  // dead-letter branch fired, and the case both failed (the wrapper resolves instead of
  // rethrowing at the threshold) and left two records in a `telemetry:dead-letter` stream on
  // db 0. Observed, and cleaned up by hand; `telemetry:events` itself was untouched
  // (`XLEN` 2, `last-generated-id` unchanged, no consumer groups). A stub that covers only the
  // happy path is how a unit test acquires a live side effect.
  it("createContainer() wraps the processor handler in the dead-letter retry policy", async () => {
    const container = createContainer("worker-service", env as ServiceEnv);
    const hget = vi
      .spyOn(container.redis, "hget")
      .mockResolvedValue(null as unknown as string | null);
    const hincrby = vi
      .spyOn(container.redis, "hincrby")
      .mockResolvedValue(RETRY_COUNT_BELOW_BUDGET);
    const expire = vi.spyOn(container.redis, "expire").mockResolvedValue(EXPIRE_SET_REPLY);
    const hdel = vi.spyOn(container.redis, "hdel").mockResolvedValue(NO_FIELD_REMOVED);
    const xadd = vi.spyOn(container.redis, "xadd").mockResolvedValue(null);
    const xack = vi.spyOn(container.redis, "xack").mockResolvedValue(NO_FIELD_REMOVED);

    expect(typeof container.messageHandler).toBe("function");

    // The parse fails, so nothing reaches Postgres; what matters is that the pre-check `HGET`
    // happened at all, which only the wrapper issues.
    await expect(container.messageHandler(ENTRY_ID, MALFORMED_FIELDS)).rejects.toThrow();

    expect(hget).toHaveBeenCalledTimes(1);
    // The key the service builds for itself: its own prefix plus the configured stream name,
    // never anything a caller passed. The entry id is the hash *field*.
    expect(hget).toHaveBeenCalledWith(
      `${WORKER_DEAD_LETTER.RETRY_KEY_PREFIX}${env.REDIS_STREAM_NAME}`,
      ENTRY_ID
    );
    // The failure was counted and rethrown, which is the retryable path -- so the composition
    // really is the retry policy and not some other wrapper that merely reads a key.
    expect(hincrby).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledTimes(1);
    // And below the budget nothing is recorded, acknowledged or cleared. These also pin that no
    // unstubbed command remains: a call here would be a call on the real client.
    expect(xadd).not.toHaveBeenCalled();
    expect(xack).not.toHaveBeenCalled();
    expect(hdel).not.toHaveBeenCalled();
  });

  it("U57 - registers the event repository as a factory, never as a singleton", () => {
    const container = createContainer("worker-service", env as ServiceEnv);
    const tenantA = "456793cd-6625-44f6-af63-142a86019e1a" as TenantId;
    const tenantB = "d4101ff1-8a17-47f7-9765-73c73ccf0441" as TenantId;

    // A function, not an instance. `.claude/rules/tenant-isolation.md`: `tenantId` is a
    // constructor argument, so a singleton pins one tenant process-wide -- and this worker
    // reads every tenant's events off a single stream.
    expect(typeof container.eventRepositoryFactory).toBe("function");

    const forA = container.eventRepositoryFactory(tenantA);
    const forB = container.eventRepositoryFactory(tenantB);
    expect(forA).not.toBe(forB);
    // Two calls for the *same* tenant are still two instances: the factory holds no cache, so
    // no instance outlives the message it was built for.
    expect(container.eventRepositoryFactory(tenantA)).not.toBe(forA);
  });

  it("createContainer() creates default logger when not provided", () => {
    const container = createContainer("worker-service", env as ServiceEnv);

    expect(container.logger).toBeDefined();
    expect(typeof container.logger.info).toBe("function");
    expect(typeof container.logger.error).toBe("function");
    expect(typeof container.logger.debug).toBe("function");
    expect(typeof container.logger.warn).toBe("function");
  });

  it("createContainer() uses provided logger when given", () => {
    const mockLogger = createLogger("worker-test");
    const container = createContainer("worker-service", env as ServiceEnv, mockLogger);

    expect(container.logger).toBe(mockLogger);
  });

  it("createContainer() attaches error listener to Redis client", () => {
    const container = createContainer("worker-service", env as ServiceEnv);

    // Verify Redis has error listeners (ioredis exposes listener count via _events)
    expect(container.redis.listenerCount("error")).toBeGreaterThan(0);
  });

  it("createContainer() configures Redis with expected connection options", () => {
    const container = createContainer("worker-service", env as ServiceEnv);
    const redisOptions = (container.redis as unknown as {
      options: {
        maxRetriesPerRequest: number;
        enableReadyCheck: boolean;
        lazyConnect: boolean;
      };
    }).options;

    expect(redisOptions.maxRetriesPerRequest).toBe(2);
    expect(redisOptions.enableReadyCheck).toBe(true);
    expect(redisOptions.lazyConnect).toBe(true);
  });

  it("createContainer() logs Redis connection errors with service context", () => {
    const mockLogger = createLogger("worker-test");
    const errorSpy = vi.spyOn(mockLogger, "error").mockImplementation(() => {
      return undefined;
    });
    const container = createContainer("worker-service", env as ServiceEnv, mockLogger);

    container.redis.emit("error", new Error("redis-boom"));

    expect(errorSpy).toHaveBeenCalledWith(
      { error: "redis-boom", service: "worker-service" },
      "Redis connection error"
    );
  });
});

