import { PassThrough } from "node:stream";
import { trace, type Span } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/index";

interface ParsedLogLine {
  service?: string;
  level?: string;
  traceId?: string;
  spanId?: string;
}

const parseLogLines = (chunks: string[]): ParsedLogLine[] => {
  const lines = chunks
    .join("")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  return lines.map((line) => {
    const parsed: unknown = JSON.parse(line);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Expected pino log line to be a JSON object");
    }

    const candidate = parsed as {
      service?: unknown;
      level?: unknown;
      traceId?: unknown;
      spanId?: unknown;
    };

    return {
      service: typeof candidate.service === "string" ? candidate.service : undefined,
      level: typeof candidate.level === "string" ? candidate.level : undefined,
      traceId: typeof candidate.traceId === "string" ? candidate.traceId : undefined,
      spanId: typeof candidate.spanId === "string" ? candidate.spanId : undefined
    };
  });
};

describe("createLogger", () => {
  afterEach(() => {
    delete process.env.LOG_LEVEL;
    vi.restoreAllMocks();
  });

  it("emits valid JSON to stdout with service on every line", () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString("utf8"));
    });

    const logger = createLogger("gateway", stream);

    logger.info({ route: "/health" }, "health ok");
    logger.warn({ route: "/health" }, "health slow");

    const lines = parseLogLines(chunks);

    expect(lines.length).toBe(2);
    expect(lines[0]?.service).toBe("gateway");
    expect(lines[1]?.service).toBe("gateway");
    expect(lines[0]?.level).toBe("info");
    expect(lines[1]?.level).toBe("warn");
  });

  it("injects traceId and spanId when an active span exists", () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString("utf8"));
    });

    const logger = createLogger("auth-service", stream);

    const span: Pick<Span, "spanContext"> = {
      spanContext: () => ({
        traceId: "1234567890abcdef1234567890abcdef",
        spanId: "1234567890abcdef",
        traceFlags: 1
      })
    };

    vi.spyOn(trace, "getActiveSpan").mockReturnValue(span as Span);
    logger.info("inside span");

    const lines = parseLogLines(chunks);

    expect(lines[0]?.traceId).toBe("1234567890abcdef1234567890abcdef");
    expect(lines[0]?.spanId).toBe("1234567890abcdef");
  });

  it("defaults to info and allows LOG_LEVEL override", () => {
    const defaultStream = new PassThrough();
    const defaultChunks: string[] = [];
    defaultStream.on("data", (chunk: Buffer) => {
      defaultChunks.push(chunk.toString("utf8"));
    });

    const defaultLogger = createLogger("usage-service", defaultStream);
    defaultLogger.debug("hidden debug");
    defaultLogger.info("visible info");

    const defaultLines = parseLogLines(defaultChunks);

    expect(defaultLines.length).toBe(1);
    expect(defaultLines[0]?.level).toBe("info");

    process.env.LOG_LEVEL = "debug";
    const debugStream = new PassThrough();
    const debugChunks: string[] = [];
    debugStream.on("data", (chunk: Buffer) => {
      debugChunks.push(chunk.toString("utf8"));
    });

    const debugLogger = createLogger("usage-service", debugStream);
    debugLogger.debug("visible debug");

    const debugLines = parseLogLines(debugChunks);

    expect(debugLines.length).toBe(1);
    expect(debugLines[0]?.level).toBe("debug");
  });

  it("falls back to info when LOG_LEVEL is blank and omits trace fields without span", () => {
    process.env.LOG_LEVEL = "   ";

    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString("utf8"));
    });

    const logger = createLogger("analytics-service", stream);
    logger.debug("debug hidden");
    logger.info("info shown");

    const lines = parseLogLines(chunks);

    expect(lines.length).toBe(1);
    expect(lines[0]?.level).toBe("info");
    expect(lines[0]?.traceId).toBeUndefined();
    expect(lines[0]?.spanId).toBeUndefined();
  });
});
