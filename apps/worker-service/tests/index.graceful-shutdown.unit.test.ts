import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_STREAM_CONSTANTS } from "../src/constants";

type SignalName = "SIGTERM" | "SIGINT";
type SignalHandler = () => void;
type WorkerIndexModule = {
  shuttingDown: boolean;
};
type EnvLoadError = Error & { code?: string };

/** Reply `XGROUP CREATE ... MKSTREAM` returns on success (observed on Redis 7.0.15). */
const XGROUP_OK_REPLY = "OK";

/**
 * `XAUTOCLAIM`'s three-element reply with nothing to reclaim, as observed on Redis 7.0.15:
 * `[cursor, entries, deletedIds]` with the cursor already at the terminal `0-0`.
 *
 * Written out rather than imported from `WORKER_STREAM_READ.PENDING_START_ID` on purpose —
 * this is a *reply* the fake server gives, and a fake that echoed the implementation's own
 * constant back at it would keep agreeing with the implementation after the constant changed.
 */
const XAUTOCLAIM_EMPTY_REPLY = ["0-0", [], []];

/**
 * The rejection ioredis produced when the container's own client options
 * (`maxRetriesPerRequest: 2`, `enableReadyCheck: true`, `lazyConnect: true`) were pointed at
 * a port nothing listens on: `MaxRetriesPerRequestError`, after ~160 ms. Reproduced here as a
 * plain `Error` with the same message, which is all `ensureConsumerGroup` inspects.
 */
const UNREACHABLE_REDIS_ERROR = new Error(
  'Reached the max retries per request limit (which is 2). Refer to "maxRetriesPerRequest" option for details.'
);

describe("graceful shutdown (worker-service)", () => {
  let signalHandlers: Partial<Record<SignalName, SignalHandler>>;
  let exitCodes: Array<number | undefined>;

  /**
   * Waits until `start()` has settled — it has either bound the listener or exited.
   *
   * This replaces a helper that awaited two already-resolved promises. That was enough
   * microtask drainage for a `start()` whose only suspension point was
   * `await import("./app")`; T-038 adds a second dynamic import and an awaited
   * `ensureConsumerGroup()`, and with the old helper this suite fails **deterministically** —
   * the *same* nine of ten cases, every run.
   *
   * The mechanism, and why no larger number fixes it: a dynamic import's first evaluation
   * completes on a **macrotask** turn, and a chain of `await Promise.resolve()` never yields
   * to the macrotask queue at any length. Measured against this revision by restoring the old
   * helper at four turn counts, five runs each — 20 runs, all identical:
   *
   *   2 turns  -> Tests  9 failed | 1 passed (10)   x5
   *   5 turns  -> Tests  9 failed | 1 passed (10)   x5
   *   10 turns -> Tests  9 failed | 1 passed (10)   x5
   *   20 turns -> Tests  9 failed | 1 passed (10)   x5
   *
   * The identity of the nine was compared across three runs and is byte-identical. The single
   * case that passes is `fails startup when loadEnvFile throws non-ENOENT`, which rejects
   * before the first dynamic import and so never needs the macrotask turn. Hence a condition,
   * not a count.
   *
   * An earlier revision of this comment called the old behaviour flaky and said raising the
   * turn count changed which cases failed. That does not reproduce and was wrong; the
   * conclusion it supported is unchanged.
   *
   * Not a weakened assertion: the conditions are the two exits `start()` has, so nothing is
   * waited past. The negative cases still assert `buildApp`/`appListen` were never called —
   * they simply now do so after `start()` has demonstrably finished rather than hoping it had.
   *
   * The mutation that would falsify "not weakened": move `loadLocalEnv()` in `src/index.ts`
   * to after `buildWorkerServiceApp()`, so `buildApp` *is* called on the negative path.
   * Observed — `× fails startup when loadEnvFile throws non-ENOENT / expected "spy" to not be
   * called at all, but actually been called 1 times`, `Tests 1 failed | 9 passed (10)`. The
   * negative assertion is live, not short-circuited by the wait.
   */
  const waitForStartupToSettle = async (
    appListen: ReturnType<typeof vi.fn>
  ): Promise<void> => {
    await vi.waitFor(() => {
      if (appListen.mock.calls.length === 0 && exitCodes.length === 0) {
        throw new Error("start() has neither bound the listener nor called process.exit");
      }
    });
  };

  /** Waits until the shutdown path has reached its `process.exit`. */
  const waitForProcessExit = async (): Promise<void> => {
    await vi.waitFor(() => {
      if (exitCodes.length === 0) {
        throw new Error("process.exit was not called");
      }
    });
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    signalHandlers = {};
    exitCodes = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const setupIndexModule = async (options?: {
    closeError?: Error;
    loadEnvFileError?: EnvLoadError;
    xgroupError?: unknown;
  }): Promise<{
    moduleUnderTest: WorkerIndexModule;
    logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    appClose: ReturnType<typeof vi.fn>;
    appListen: ReturnType<typeof vi.fn>;
    prismaDisconnect: ReturnType<typeof vi.fn>;
    redisDisconnect: ReturnType<typeof vi.fn>;
    redisXgroup: ReturnType<typeof vi.fn>;
    redisDuplicate: ReturnType<typeof vi.fn>;
    readXreadgroup: ReturnType<typeof vi.fn>;
    readXautoclaim: ReturnType<typeof vi.fn>;
    readDisconnect: ReturnType<typeof vi.fn>;
    buildApp: ReturnType<typeof vi.fn>;
  }> => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };
    const prismaDisconnect = vi.fn().mockResolvedValue(undefined);
    const redisDisconnect = vi.fn();
    const appClose = options?.closeError
      ? vi.fn().mockRejectedValue(options.closeError)
      : vi.fn().mockResolvedValue(undefined);
    const appListen = vi.fn().mockResolvedValue(undefined);
    // T-038: `start()` bootstraps the consumer group before `app.listen`, so the fake
    // container now needs an `xgroup` and an `env`. Stubbed on the shared container object
    // rather than at the call site so T-039/T-040 extend one place (plan R4).
    const redisXgroup =
      options && "xgroupError" in options
        ? vi.fn().mockRejectedValue(options.xgroupError)
        : vi.fn().mockResolvedValue(XGROUP_OK_REPLY);

    // T-039: `start()` now also opens a read connection, reclaims, and starts the loop.
    // Extended on the same shared container object the plan's R4 shape put the `xgroup` stub
    // on, so T-040 has one place to extend rather than four call sites.
    //
    // The read never settles. That is not laziness about the fixture, it is the state the
    // loop is *in* for all of a healthy worker's life: parked on a blocking `XREADGROUP`. It
    // also means the only thing that can disconnect the read connection is `stop()` (`U31`).
    //
    // What makes "the listener bound while the first read was still outstanding" observable
    // is `appListen` plus this promise never resolving: `U25` asserts the read was *issued*
    // before `listen` was called and that `listen` was nonetheless called, and the read
    // cannot have completed in between because nothing here can complete it. An earlier
    // revision of this comment credited a `readSettled` flag instead. That flag was
    // initialised `false` and its only other assignment also wrote `false`, so
    // `expect(firstReadSettled()).toBe(false)` could not fail under any implementation —
    // Round 1, M-2. Measured before deleting it: with the first read changed to resolve
    // immediately (`mockResolvedValueOnce(null)`), the flag still reported `false` and the
    // suite still reported 12 passed, so it did not observe settlement at all.
    const readXreadgroup = vi.fn(() => new Promise(() => undefined));
    const readXautoclaim = vi.fn().mockResolvedValue(XAUTOCLAIM_EMPTY_REPLY);
    const readDisconnect = vi.fn();
    const redisDuplicate = vi.fn(() => ({
      xreadgroup: readXreadgroup,
      xautoclaim: readXautoclaim,
      disconnect: readDisconnect
    }));

    const app = {
      container: {
        logger,
        env: {
          REDIS_STREAM_NAME: WORKER_STREAM_CONSTANTS.DEFAULT_STREAM_NAME,
          REDIS_CONSUMER_GROUP: WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_GROUP,
          REDIS_CONSUMER_NAME: WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_NAME,
          STREAM_BLOCK_MS: WORKER_STREAM_CONSTANTS.DEFAULT_BLOCK_MS,
          STREAM_BATCH_SIZE: WORKER_STREAM_CONSTANTS.DEFAULT_BATCH_SIZE
        },
        prisma: { $disconnect: prismaDisconnect },
        redis: {
          disconnect: redisDisconnect,
          xgroup: redisXgroup,
          duplicate: redisDuplicate
        }
      },
      close: appClose,
      listen: appListen
    };

    const buildApp = vi.fn(() => app);

    vi.doMock("@telemetry/shared-tracing", () => ({
      initTracing: vi.fn()
    }));
    vi.doMock("../src/app", () => ({
      buildWorkerServiceApp: buildApp
    }));

    vi.spyOn(process, "on").mockImplementation(
      ((event: string, handler: SignalHandler) => {
        if ((event === "SIGTERM" || event === "SIGINT") && typeof handler === "function") {
          signalHandlers[event] = handler;
        }
        return process;
      }) as unknown as typeof process.on
    );

    vi.spyOn(process, "exit").mockImplementation(
      ((code?: number) => {
        exitCodes.push(code);
        return undefined as never;
      }) as unknown as typeof process.exit
    );

    if (typeof process.loadEnvFile === "function") {
      vi.spyOn(process, "loadEnvFile").mockImplementation(() => {
        if (options?.loadEnvFileError) {
          throw options.loadEnvFileError;
        }

        return undefined;
      });
    }

    const moduleUnderTest = await import("../src/index");
    await waitForStartupToSettle(appListen);

    return {
      moduleUnderTest,
      logger,
      appClose,
      appListen,
      prismaDisconnect,
      redisDisconnect,
      redisXgroup,
      redisDuplicate,
      readXreadgroup,
      readXautoclaim,
      readDisconnect,
      buildApp
    };
  };

  /** Waits until the loop has issued its first read, so ordering assertions are not races. */
  const waitForFirstRead = async (
    readXreadgroup: ReturnType<typeof vi.fn>
  ): Promise<void> => {
    await vi.waitFor(() => {
      if (readXreadgroup.mock.calls.length === 0) {
        throw new Error("the consumer loop never issued a read");
      }
    });
  };

  it("registers SIGTERM and SIGINT handlers on startup", async () => {
    const context = await setupIndexModule();

    expect(context.buildApp).toHaveBeenCalledTimes(1);
    expect(context.appListen).toHaveBeenCalledTimes(1);
    expect(signalHandlers.SIGTERM).toBeTypeOf("function");
    expect(signalHandlers.SIGINT).toBeTypeOf("function");
  });

  it("continues startup when loadEnvFile throws ENOENT", async () => {
    const envLoadError = Object.assign(new Error("missing .env"), { code: "ENOENT" }) as EnvLoadError;
    const context = await setupIndexModule({ loadEnvFileError: envLoadError });

    expect(context.buildApp).toHaveBeenCalledTimes(1);
    expect(context.appListen).toHaveBeenCalledTimes(1);
  });

  it("fails startup when loadEnvFile throws non-ENOENT", async () => {
    const envLoadError = Object.assign(new Error("load failure"), { code: "EACCES" }) as EnvLoadError;
    const context = await setupIndexModule({ loadEnvFileError: envLoadError });

    expect(context.buildApp).not.toHaveBeenCalled();
    expect(context.appListen).not.toHaveBeenCalled();
    expect(exitCodes).toContain(1);
  });

  it("handles SIGTERM with full shutdown sequence and exit code 0", async () => {
    const context = await setupIndexModule();

    signalHandlers.SIGTERM?.();
    await waitForProcessExit();

    expect(context.logger.info).toHaveBeenCalledWith(
      { signal: "SIGTERM" },
      "Shutting down gracefully"
    );
    expect(context.appClose).toHaveBeenCalledTimes(1);
    expect(context.prismaDisconnect).toHaveBeenCalledTimes(1);
    expect(context.redisDisconnect).toHaveBeenCalledTimes(1);
    expect(context.logger.info).toHaveBeenCalledWith("Shutdown complete");
    expect(exitCodes).toContain(0);
  });

  it("handles SIGINT with full shutdown sequence and exit code 0", async () => {
    const context = await setupIndexModule();

    signalHandlers.SIGINT?.();
    await waitForProcessExit();

    expect(context.logger.info).toHaveBeenCalledWith(
      { signal: "SIGINT" },
      "Shutting down gracefully"
    );
    expect(context.appClose).toHaveBeenCalledTimes(1);
    expect(context.prismaDisconnect).toHaveBeenCalledTimes(1);
    expect(context.redisDisconnect).toHaveBeenCalledTimes(1);
    expect(exitCodes).toContain(0);
  });

  it("sets exported shuttingDown flag when shutdown starts", async () => {
    const context = await setupIndexModule();

    expect(context.moduleUnderTest.shuttingDown).toBe(false);

    signalHandlers.SIGTERM?.();
    await waitForProcessExit();

    expect(context.moduleUnderTest.shuttingDown).toBe(true);
  });

  it("ignores duplicate signals while shutdown is in progress", async () => {
    const context = await setupIndexModule();

    signalHandlers.SIGTERM?.();
    signalHandlers.SIGTERM?.();
    signalHandlers.SIGINT?.();
    await waitForProcessExit();

    expect(context.appClose).toHaveBeenCalledTimes(1);
    expect(context.prismaDisconnect).toHaveBeenCalledTimes(1);
    expect(context.redisDisconnect).toHaveBeenCalledTimes(1);
    expect(exitCodes.filter((code) => code === 0)).toHaveLength(1);
  });

  it("U7 - bootstraps the consumer group before the HTTP listener binds", async () => {
    const context = await setupIndexModule();

    expect(context.redisXgroup).toHaveBeenCalledTimes(1);
    expect(context.appListen).toHaveBeenCalledTimes(1);
    // Call-order, not two independent `toHaveBeenCalled()`s: a worker that binds `/health`
    // before its group exists reports healthy while consuming nothing. Verified to be a real
    // constraint by moving the `ensureConsumerGroup()` call in `src/index.ts` to after
    // `await app.listen(...)` and watching this line go red, then reverting.
    const xgroupOrder = context.redisXgroup.mock.invocationCallOrder[0];
    const listenOrder = context.appListen.mock.invocationCallOrder[0];
    expect(xgroupOrder).toBeDefined();
    expect(listenOrder).toBeDefined();
    expect(xgroupOrder).toBeLessThan(listenOrder as number);
  });

  it("U25 - reclaims and starts the loop before the listener binds, without delaying it", async () => {
    const context = await setupIndexModule();
    await waitForFirstRead(context.readXreadgroup);

    // Bootstrap -> recovery -> loop: ordering by invocation order, not by three independent
    // `toHaveBeenCalled()`s, which would pass in any order.
    const xgroupOrder = context.redisXgroup.mock.invocationCallOrder[0];
    const claimOrder = context.readXautoclaim.mock.invocationCallOrder[0];
    const listenOrder = context.appListen.mock.invocationCallOrder[0];
    expect(xgroupOrder).toBeDefined();
    expect(claimOrder).toBeDefined();
    expect(listenOrder).toBeDefined();
    expect(xgroupOrder).toBeLessThan(claimOrder as number);
    // Recovery is under way before `/health` can answer. A worker that bound the listener
    // first would report healthy while abandoned work sat unclaimed.
    expect(claimOrder).toBeLessThan(listenOrder as number);

    // ...and the loop does not *delay* the listener. `appListen` having been called at all is
    // the detector: the first read never settles, so if `run()` were awaited instead of
    // `void`-ed, `listen` would never be reached — the mutation the Round-1 review re-ran,
    // which reddens ten cases in this file including this one.
    expect(context.appListen).toHaveBeenCalledTimes(1);
    expect(context.readXreadgroup).toHaveBeenCalledTimes(1);
    // The full startup chain, in one ordered claim rather than four independent
    // `toHaveBeenCalled()`s: bootstrap -> recovery -> listen -> first read.
    //
    // This last pair **records a measured order rather than detecting a defect**, and is
    // labelled that way on purpose: of the two mutations available here, `await run()`
    // reddens `listenOrder`'s `toBeDefined()` and starting the loop after `listen` reddens
    // `claimOrder < listenOrder` above (61 ms, clean), so nothing reaches this line first. It
    // is here because the order was surprising — the first read lands *after* `listen`, not
    // before — and the previous revision of this case asserted the opposite through a flag
    // that could not fail.
    //
    // `listen` before the first *read* is measured, not assumed, and it is deterministic
    // rather than a race: `void run()` runs synchronously as far as `duplicate()` and the
    // first `XAUTOCLAIM` — hence `claimOrder < listenOrder` above — and then suspends on that
    // round trip, so `start()` reaches `app.listen(...)` while the read is still a microtask
    // away. Observed here as xgroup/xautoclaim/listen/read = adjacent invocation orders with
    // the read last. This is what replaced the `firstReadSettled()` flag deleted for M-2,
    // which was constant-`false` and therefore could not fail.
    const readOrder = context.readXreadgroup.mock.invocationCallOrder[0];
    expect(readOrder).toBeDefined();
    expect(listenOrder).toBeLessThan(readOrder as number);
    // The read is on the duplicate, never on the container's connection (D1-B).
    expect(context.redisDuplicate).toHaveBeenCalledTimes(1);
  });

  it("U31 - stops the consumer loop before closing the app", async () => {
    const context = await setupIndexModule();
    await waitForFirstRead(context.readXreadgroup);

    signalHandlers.SIGTERM?.();
    await waitForProcessExit();

    // Order, and the reason it matters, measured: `app.close()` fires the `onClose` hook that
    // calls `quit()`, and `quit()` waited out an in-flight `BLOCK 5000` read for 4 813 ms,
    // while the `disconnect()` that `stop()` issues ended the same read in 205 ms. Closing
    // first would add up to `STREAM_BLOCK_MS` to every shutdown.
    const stopOrder = context.readDisconnect.mock.invocationCallOrder[0];
    const closeOrder = context.appClose.mock.invocationCallOrder[0];
    expect(stopOrder).toBeDefined();
    expect(closeOrder).toBeDefined();
    expect(stopOrder).toBeLessThan(closeOrder as number);
    expect(exitCodes).toContain(0);
  });

  it("U8 - fails closed and never binds the listener when Redis is unreachable", async () => {
    const context = await setupIndexModule({ xgroupError: UNREACHABLE_REDIS_ERROR });

    expect(context.redisXgroup).toHaveBeenCalledTimes(1);
    expect(context.appListen).not.toHaveBeenCalled();
    expect(exitCodes).toContain(1);
  });

  it("logs error and exits with code 1 when close fails", async () => {
    const closeError = new Error("close failed");
    const context = await setupIndexModule({ closeError });

    signalHandlers.SIGTERM?.();
    await waitForProcessExit();

    expect(context.appClose).toHaveBeenCalledTimes(1);
    expect(context.prismaDisconnect).not.toHaveBeenCalled();
    expect(context.redisDisconnect).not.toHaveBeenCalled();
    expect(context.logger.error).toHaveBeenCalledWith(
      { error: closeError, signal: "SIGTERM" },
      "Error during shutdown"
    );
    expect(exitCodes).toContain(1);
  });
});
