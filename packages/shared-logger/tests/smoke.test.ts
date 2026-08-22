import { PassThrough } from "node:stream";
import { trace, type Span } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/index";

type LogLine = Record<string, unknown>;

describe("createLogger", () => {
  afterEach(() => {
    delete process.env.LOG_LEVEL;
    vi.restoreAllMocks();
  });

  it("emits valid JSON to stdout with service on every line", () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk) => {
      chunks.push(chunk.toString("utf8"));
    });

    const logger = createLogger("gateway", stream);

    logger.info({ route: "/health" }, "health ok");
    logger.warn({ route: "/health" }, "health slow");

    const lines = chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LogLine);

    expect(lines.length).toBe(2);
    expect(lines[0]?.service).toBe("gateway");
    expect(lines[1]?.service).toBe("gateway");
    expect(lines[0]?.level).toBe("info");
    expect(lines[1]?.level).toBe("warn");
  });

  it("injects traceId and spanId when an active span exists", () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk) => {
      chunks.push(chunk.toString("utf8"));
    });

    const logger = createLogger("auth-service", stream);

    const span = {
      spanContext: () => ({
        traceId: "1234567890abcdef1234567890abcdef",
        spanId: "1234567890abcdef",
        traceFlags: 1
      })
    } as unknown as Span;

    vi.spyOn(trace, "getActiveSpan").mockReturnValue(span);
    logger.info("inside span");

    const lines = chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LogLine);

    expect(lines[0]?.traceId).toBe("1234567890abcdef1234567890abcdef");
    expect(lines[0]?.spanId).toBe("1234567890abcdef");
  });

  it("defaults to info and allows LOG_LEVEL override", () => {
    const defaultStream = new PassThrough();
    const defaultChunks: string[] = [];
    defaultStream.on("data", (chunk) => {
      defaultChunks.push(chunk.toString("utf8"));
    });

    const defaultLogger = createLogger("usage-service", defaultStream);
    defaultLogger.debug("hidden debug");
    defaultLogger.info("visible info");

    const defaultLines = defaultChunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LogLine);

    expect(defaultLines.length).toBe(1);
    expect(defaultLines[0]?.level).toBe("info");

    process.env.LOG_LEVEL = "debug";
    const debugStream = new PassThrough();
    const debugChunks: string[] = [];
    debugStream.on("data", (chunk) => {
      debugChunks.push(chunk.toString("utf8"));
    });

    const debugLogger = createLogger("usage-service", debugStream);
    debugLogger.debug("visible debug");

    const debugLines = debugChunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LogLine);

    expect(debugLines.length).toBe(1);
    expect(debugLines[0]?.level).toBe("debug");
  });
});
