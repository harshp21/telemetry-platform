import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SignalName = "SIGTERM" | "SIGINT";
type SignalHandler = () => void;
type EnvLoadError = Error & { code?: string };

const flushAsyncWork = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("graceful shutdown (billing-service)", () => {
  let signalHandlers: Partial<Record<SignalName, SignalHandler>>;
  let exitCodes: Array<number | undefined>;

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
  }): Promise<{
    logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    appClose: ReturnType<typeof vi.fn>;
    appListen: ReturnType<typeof vi.fn>;
    prismaDisconnect: ReturnType<typeof vi.fn>;
    redisDisconnect: ReturnType<typeof vi.fn>;
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

    const app = {
      container: {
        logger,
        prisma: { $disconnect: prismaDisconnect },
        redis: { disconnect: redisDisconnect }
      },
      close: appClose,
      listen: appListen
    };

    const buildApp = vi.fn(() => app);

    vi.doMock("@telemetry/shared-tracing", () => ({
      initTracing: vi.fn()
    }));
    vi.doMock("../src/app", () => ({
      buildBillingServiceApp: buildApp
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

    await import("../src/index");
    await flushAsyncWork();

    return {
      logger,
      appClose,
      appListen,
      prismaDisconnect,
      redisDisconnect,
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
    await flushAsyncWork();

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
    await flushAsyncWork();

    expect(context.logger.info).toHaveBeenCalledWith(
      { signal: "SIGINT" },
      "Shutting down gracefully"
    );
    expect(context.appClose).toHaveBeenCalledTimes(1);
    expect(context.prismaDisconnect).toHaveBeenCalledTimes(1);
    expect(context.redisDisconnect).toHaveBeenCalledTimes(1);
    expect(exitCodes).toContain(0);
  });

  it("ignores duplicate signals while shutdown is in progress", async () => {
    const context = await setupIndexModule();

    signalHandlers.SIGTERM?.();
    signalHandlers.SIGTERM?.();
    signalHandlers.SIGINT?.();
    await flushAsyncWork();

    expect(context.appClose).toHaveBeenCalledTimes(1);
    expect(context.prismaDisconnect).toHaveBeenCalledTimes(1);
    expect(context.redisDisconnect).toHaveBeenCalledTimes(1);
    expect(exitCodes.filter((code) => code === 0)).toHaveLength(1);
  });

  it("logs error and exits with code 1 when close fails", async () => {
    const closeError = new Error("close failed");
    const context = await setupIndexModule({ closeError });

    signalHandlers.SIGTERM?.();
    await flushAsyncWork();

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
