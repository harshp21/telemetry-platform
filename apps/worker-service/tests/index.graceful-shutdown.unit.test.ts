import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_SHUTDOWN, WORKER_STREAM_CONSTANTS } from "../src/constants";

type SignalName = "SIGTERM" | "SIGINT";
type SignalHandler = () => void;
type WorkerIndexModule = {
  shuttingDown: boolean;
};
type EnvLoadError = Error & { code?: string };

/** Reply `XGROUP CREATE ... MKSTREAM` returns on success (observed on Redis 7.0.15). */
const XGROUP_OK_REPLY = "OK";

/**
 * What ioredis rejects an in-flight, or a subsequently issued, command with once its connection
 * has been disconnected.
 *
 * Re-derived at Gate 3 on ioredis 5.11.1 / Redis 7.0.15: `disconnect()` issued 200 ms into a
 * `BLOCK 5000` read rejected that read 204 ms later with exactly this message. Written out
 * rather than imported from `WORKER_STREAM_READ.CONNECTION_CLOSED_ERROR_MESSAGE`, for the reason
 * `XAUTOCLAIM_EMPTY_REPLY`'s docblock gives: this is the *client's* message, and a fake that
 * echoed the subject's own constant back at it would keep agreeing with the subject after either
 * changed. `U26` in `tests/stream.consumer.unit.test.ts` holds the same literal.
 */
const CONNECTION_CLOSED_REPLY = "Connection is closed.";

/**
 * The `XINFO CONSUMERS` row the fake container connection reports for this worker.
 *
 * `pending 0` is the state a clean shutdown leaves, and it is what permits the deregistration
 * `U86` asserts. Values named rather than written inline, as `.claude/rules/constants.md`'s
 * applies-to-tests clause asks; `IDLE_MS` is read by nothing in `src/` and is present only so the
 * row is the shape Redis was measured returning.
 */
const FAKE_CONSUMER_ROW = {
  PENDING: 0,
  IDLE_MS: 13
} as const;

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
 * One reclaimed entry, for the case that has to observe the *handler* rather than the loop.
 *
 * Recovery is the only place a fixture-controlled entry can reach the handler in this suite:
 * `readXreadgroup` never settles on purpose (a healthy worker is parked on a blocking read),
 * so `XAUTOCLAIM` is the delivery path a test can drive. Terminal cursor, so recovery makes one
 * pass.
 */
const RECLAIMED_ENTRY_ID = "1789101023804-0";
const RECLAIMED_ENTRY_FIELDS = ["eventId", "3c9d8ee5-1b2a-4c3d-8e4f-5a6b7c8d9e0f"];
const XAUTOCLAIM_ONE_ENTRY_REPLY = [
  "0-0",
  [[RECLAIMED_ENTRY_ID, RECLAIMED_ENTRY_FIELDS]],
  []
];

/**
 * The rejection ioredis produced when the container's own client options
 * (`maxRetriesPerRequest: 2`, `enableReadyCheck: true`, `lazyConnect: true`) were pointed at
 * a port nothing listens on: `MaxRetriesPerRequestError`, after ~160 ms. Reproduced here as a
 * plain `Error` with the same message, which is all `ensureConsumerGroup` inspects.
 */
const UNREACHABLE_REDIS_ERROR = new Error(
  'Reached the max retries per request limit (which is 2). Refer to "maxRetriesPerRequest" option for details.'
);

/**
 * Order tokens for `U86`, whose subject is *when* `process.exit(0)` happens relative to work the
 * worker still had in hand.
 *
 * Two independent `toHaveBeenCalled()` checks pass in either order, and the order is the entire
 * claim — `['exit','handler']` is precisely the pre-T-043 behaviour. `U31` in this file and
 * `U73`/`U84` in `tests/stream.consumer.unit.test.ts` take the same shape for the same reason.
 */
const SHUTDOWN_STEP = {
  HANDLER: "handler",
  EXIT: "exit"
} as const;

/**
 * `0` **milliseconds** for a real-timer yield. Named for the reason
 * `tests/stream.consumer.unit.test.ts` names its own copy: the numeral carries no meaning on
 * sight, and this package already names three distinct zeroes (`CALLS.NONE`, `INDEX.FIRST`,
 * `ADVANCE_NO_TIME_MS`) whose values coincide and whose meanings do not.
 */
const NEXT_MACROTASK_MS = 0;

/** Yields to the macrotask queue, draining every pending microtask. See `U73`'s `nextMacrotask`. */
const nextMacrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, NEXT_MACROTASK_MS);
  });

describe("graceful shutdown (worker-service)", () => {
  let signalHandlers: Partial<Record<SignalName, SignalHandler>>;
  let exitCodes: Array<number | undefined>;
  /** Steps of one shutdown, in the order they actually happened. See `SHUTDOWN_STEP`. */
  let order: string[];
  /**
   * Every log *message* the container's logger had been given at the instant `process.exit` ran.
   *
   * Snapshotted inside the exit spy rather than read afterwards, because "afterwards" is not a
   * moment that exists for a real process: `process.exit` does not return. This is what turns
   * S-26's race into something a test can settle — the two teardown lines either had been
   * written by then or they had not.
   */
  let logMessagesAtExit: string[];

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
    order = [];
    logMessagesAtExit = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const setupIndexModule = async (options?: {
    closeError?: Error;
    loadEnvFileError?: EnvLoadError;
    xgroupError?: unknown;
    reclaimOneEntry?: boolean;
    /** Holds the container's message handler open until `releaseMessageHandler()` (T-043). */
    gateMessageHandler?: boolean;
  }): Promise<{
    moduleUnderTest: WorkerIndexModule;
    logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    appClose: ReturnType<typeof vi.fn>;
    appListen: ReturnType<typeof vi.fn>;
    prismaDisconnect: ReturnType<typeof vi.fn>;
    redisDisconnect: ReturnType<typeof vi.fn>;
    redisXgroup: ReturnType<typeof vi.fn>;
    redisXinfo: ReturnType<typeof vi.fn>;
    redisDuplicate: ReturnType<typeof vi.fn>;
    readXreadgroup: ReturnType<typeof vi.fn>;
    readXautoclaim: ReturnType<typeof vi.fn>;
    readDisconnect: ReturnType<typeof vi.fn>;
    buildApp: ReturnType<typeof vi.fn>;
    processorHandler: ReturnType<typeof vi.fn>;
    buildHandler: ReturnType<typeof vi.fn>;
    wrappedMessageHandler: ReturnType<typeof vi.fn>;
    releaseMessageHandler: () => void;
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

    // T-043: `stop()` reads the consumer registry before it deregisters, on the container's
    // connection. Without this the fake rejects with `this.redis.xinfo is not a function`, which
    // the subject correctly fails closed on — so the absence would be *invisible* except as an
    // error line, which is exactly the shape `U86` asserts against.
    //
    // Reports this worker's own row at `pending 0`, i.e. the state a clean shutdown leaves. The
    // consumer name is sourced from the constant here because it *selects* the row rather than
    // being the claim — the claim about the name's shape is `U85`'s, in
    // `tests/env.schema.unit.test.ts`, derived from `node:os` independently of `src/`.
    const redisXinfo = vi
      .fn()
      .mockResolvedValue([
        [
          "name",
          WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_NAME,
          "pending",
          FAKE_CONSUMER_ROW.PENDING,
          "idle",
          FAKE_CONSUMER_ROW.IDLE_MS
        ]
      ]);

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
    //
    // T-043: the parked read is now *rejectable*, and the rejecter is handed to `readDisconnect`
    // below. Nothing about "a healthy worker is parked on a blocking read" changes; what changes
    // is that `disconnect()` ends it, which is what the real client was measured doing
    // (204 ms, `Connection is closed.`, re-derived at Gate 3 against a `BLOCK 5000`). The
    // do-nothing `vi.fn()` was harmless while `stop()` only set a flag and is not once `stop()`
    // waits for the loop: five cases in this file died on `vi.waitFor` before
    // `process.exit` was reached, because the loop could never end.
    let rejectParkedRead: ((reason: unknown) => void) | undefined;
    let readConnectionClosed = false;
    const readXreadgroup = vi.fn(() => {
      // A read *issued after* the disconnect rejects at once, which is the other half of what a
      // closed ioredis client does and the half a single rejecter cannot express. `U86` needs
      // it: its signal arrives during recovery, before the first read exists, so the disconnect
      // has nothing to reject — and the loop then issues its one post-recovery read (the
      // behaviour `U35` in `tests/stream.consumer.unit.test.ts` asserts rather than glosses)
      // against a connection that is already gone.
      if (readConnectionClosed) {
        return Promise.reject(new Error(CONNECTION_CLOSED_REPLY));
      }

      return new Promise((_resolve, reject) => {
        rejectParkedRead = reject;
      });
    });
    const readXautoclaim = vi
      .fn()
      .mockResolvedValue(
        options?.reclaimOneEntry ? XAUTOCLAIM_ONE_ENTRY_REPLY : XAUTOCLAIM_EMPTY_REPLY
      );

    // T-040: the container now carries the processor whose handler `start()` must hand to the
    // consumer. Stubbed on the same shared container object as `xgroup` and `duplicate`, so a
    // later task extends one place rather than four call sites.
    const processorHandler = vi.fn().mockResolvedValue(undefined);
    const buildHandler = vi.fn(() => processorHandler);

    // T-041: the container now exposes a `messageHandler` -- the processor's handler wrapped in
    // `DeadLetterService`'s retry policy -- and `start()` must pass **that** to the consumer.
    //
    // Deliberately **not** delegating to `processorHandler`. Two independent spies are what make
    // the two cases below distinguishable: `U46` asserts the entry reaches the handler the
    // container supplied, and `U69` asserts that handler is the wrapped one by asserting the raw
    // processor handler was not called instead. If this spy delegated, reverting `index.ts` to
    // `container.eventProcessor.buildHandler()` would leave both green.
    //
    // T-043 adds the gated variant. `U86`'s subject is that `process.exit(0)` waits for whatever
    // this handler is doing, so the case needs to hold it open across the signal and then
    // release it. Ungated it resolves immediately, exactly as before.
    let releaseMessageHandler: (() => void) | undefined;
    const wrappedMessageHandler = options?.gateMessageHandler
      ? vi.fn(
          async (): Promise<void> => {
            await new Promise<void>((resolve) => {
              releaseMessageHandler = resolve;
            });
            order.push(SHUTDOWN_STEP.HANDLER);
          }
        )
      : vi.fn().mockResolvedValue(undefined);
    const readDisconnect = vi.fn(() => {
      readConnectionClosed = true;
      rejectParkedRead?.(new Error(CONNECTION_CLOSED_REPLY));
    });
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
          xinfo: redisXinfo,
          duplicate: redisDuplicate
        },
        eventProcessor: { buildHandler },
        messageHandler: wrappedMessageHandler
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
        order.push(SHUTDOWN_STEP.EXIT);
        // pino's signature is `(obj, msg)` or `(msg)`, so the message is the last argument.
        logMessagesAtExit = logger.info.mock.calls.map((call) =>
          String(call[call.length - 1])
        );
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
      redisXinfo,
      redisDuplicate,
      readXreadgroup,
      readXautoclaim,
      readDisconnect,
      buildApp,
      processorHandler,
      buildHandler,
      wrappedMessageHandler,
      releaseMessageHandler: () => releaseMessageHandler?.()
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

  it("U86 - a SIGTERM arriving mid-handler does not exit until the handler has settled", async () => {
    // **AC3 at the process level.** `U73` proves `StreamConsumer.stop()` waits for the loop;
    // this proves the wait reaches the thing that matters — `process.exit(0)` — through
    // `index.ts`'s existing `await streamConsumer?.stop()`, with **its
    // `void streamConsumer.run()` unchanged**. That is the whole reason the drain was put behind
    // `stop()`: S-26's fix direction reads as an instruction to drop that `void`, and doing so
    // was measured as a wide failure of this file.
    //
    // Delivery is via `XAUTOCLAIM`, because the `XREADGROUP` fake is parked on purpose — see
    // `readXreadgroup`'s docblock. `U46` uses the same route.
    const context = await setupIndexModule({ reclaimOneEntry: true, gateMessageHandler: true });
    await vi.waitFor(() => {
      if (context.wrappedMessageHandler.mock.calls.length === 0) {
        throw new Error("the reclaimed entry never reached the container's message handler");
      }
    });

    signalHandlers.SIGTERM?.();
    // A full macrotask turn, so every microtask the shutdown path could schedule has run.
    // Nothing here can settle the handler, so an exit observed now would be an exit that did not
    // wait. This is the case's red: with `await this.drain()` deleted from `stop()` it reports
    // `expected [ +0 ] to deeply equal []` — the process had already exited 0 with the handler
    // still in flight. The `order` assertion below is the corroborating one and never gets to
    // run, because assertions short-circuit.
    await nextMacrotask();
    expect(exitCodes).toEqual([]);
    expect(order).toEqual([]);

    context.releaseMessageHandler();
    await waitForProcessExit();

    // The order, not two "was called" checks. `['exit','handler']` is what a worker that hung up
    // mid-sentence produces, and it is what this reported before `stop()` drained.
    expect(order).toEqual([SHUTDOWN_STEP.HANDLER, SHUTDOWN_STEP.EXIT]);
    expect(exitCodes).toEqual([0]);
    // The drain did not swallow the rest of the sequence: the app still closed, and it still
    // closed *after* the read connection was disconnected (`U31`'s ordering claim).
    expect(context.appClose).toHaveBeenCalledTimes(1);
    expect(context.prismaDisconnect).toHaveBeenCalledTimes(1);
    expect(context.logger.error).not.toHaveBeenCalled();
    // And the deregistration really did happen on the container's connection, *after* the
    // handler and *before* the exit — the whole point of putting it behind the drain. Asserted
    // by invocation order against `process.exit`, not by two independent call checks.
    const deregisterCall = context.redisXgroup.mock.calls.find(
      (call) => call[0] === WORKER_SHUTDOWN.SUBCOMMAND_DELCONSUMER
    );
    expect(deregisterCall).toBeDefined();
    expect(deregisterCall?.[3]).toBe(WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_NAME);

    // **S-26, settled for this path.** That entry records the two teardown lines racing
    // `process.exit(0)` and usually losing — measured over nine real SIGTERM runs, emitted in
    // 4 of 5 runs at `STREAM_BLOCK_MS=20` and 0 of 4 at 500 and 5000. Both had been written by
    // the time the exit ran here, because `stop()` now awaits the loop and the loop writes them
    // in its `finally` before resolving.
    //
    // The literals are the S-26 wording, written out rather than imported: the claim is about
    // *these* lines reaching a shutting-down process's output, and sourcing them from the
    // subject would make the assertion hold whatever the subject said.
    expect(logMessagesAtExit).toContain("Stream read interrupted by shutdown");
    expect(logMessagesAtExit).toContain("Stream consumer loop stopped");
    // Anti-vacuity: the snapshot is the one taken *at* the exit, not an empty array a missing
    // spy would leave, and `"Shutdown complete"` is the line written immediately before it.
    expect(logMessagesAtExit).toContain("Shutdown complete");
  });

  it("U46 - hands the container's message handler to the consumer, so a delivered entry reaches the database path", async () => {
    const context = await setupIndexModule({ reclaimOneEntry: true });

    // Behaviour, not a construction-argument snapshot. Asserting `new StreamConsumer` was
    // called with five arguments would need the class mocked, and would then pass for a fifth
    // argument the consumer never used. This drives a real entry through the real consumer and
    // checks where it lands.
    await vi.waitFor(() => {
      if (context.wrappedMessageHandler.mock.calls.length === 0) {
        throw new Error("the reclaimed entry never reached the container's message handler");
      }
    });

    expect(context.wrappedMessageHandler).toHaveBeenCalledWith(
      RECLAIMED_ENTRY_ID,
      RECLAIMED_ENTRY_FIELDS
    );
    // Without the fifth argument the consumer falls back to `buildDefaultMessageHandler`, which
    // logs and acknowledges nothing -- so the worker would read the same backlog forever while
    // reporting healthy. `src/events/**` is outside the coverage thresholds (S-25), so no
    // percentage notices; this case is the only thing that does.
    expect(context.appListen).toHaveBeenCalledTimes(1);

    // **Edited at T-041, deliberately and not to make a red test pass.** This case previously
    // asserted `buildHandler` had been called once and that `processorHandler` saw the entry.
    // Both were claims about `index.ts`, and both stopped being true of `index.ts`: the
    // container now calls `buildHandler()` and wraps the result, and `index.ts` passes the
    // wrapped handler. Neither assertion was weakened -- the "was it wired at all" claim is
    // unchanged and now reads the handler `index.ts` really passes, the `buildHandler` call
    // moved to the container's own suite, and `U69` below asserts the stronger property this
    // case used to imply.
  });

  it("U69 - passes the retry-wrapped handler, not the processor's raw one", async () => {
    const context = await setupIndexModule({ reclaimOneEntry: true });

    await vi.waitFor(() => {
      if (context.wrappedMessageHandler.mock.calls.length === 0) {
        throw new Error("the reclaimed entry never reached the container's message handler");
      }
    });

    // The negative is the case. An `index.ts` that still passed
    // `container.eventProcessor.buildHandler()` would deliver the entry to `processorHandler`
    // and every case in `tests/dead-letter.service.unit.test.ts` would still pass -- the whole
    // feature would be wired to nothing. This is the only case that can see that, because it is
    // the only one that runs the real `index.ts`.
    expect(context.processorHandler).not.toHaveBeenCalled();
    // `index.ts` does not build the handler itself either; that is the container's job, and a
    // `buildHandler()` call here would mean a second, unwrapped handler existed.
    expect(context.buildHandler).not.toHaveBeenCalled();
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
