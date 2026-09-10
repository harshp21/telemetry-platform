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

    const app = {
      container: {
        logger,
        env: {
          REDIS_STREAM_NAME: WORKER_STREAM_CONSTANTS.DEFAULT_STREAM_NAME,
          REDIS_CONSUMER_GROUP: WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_GROUP
        },
        prisma: { $disconnect: prismaDisconnect },
        redis: { disconnect: redisDisconnect, xgroup: redisXgroup }
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
      buildApp
    };
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
