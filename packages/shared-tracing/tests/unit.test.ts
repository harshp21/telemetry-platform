import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addSpanProcessorMock = vi.fn();
const registerProviderMock = vi.fn();
const registerInstrumentationsMock = vi.fn();
const otlpExporterCtorMock = vi.fn((options: unknown) => ({ options }));
const batchSpanProcessorCtorMock = vi.fn((exporter: unknown) => ({ exporter }));
const fastifyInstrumentationCtorMock = vi.fn(() => ({ name: "fastify" }));
const prismaInstrumentationCtorMock = vi.fn(() => ({ name: "prisma" }));
const ioRedisInstrumentationCtorMock = vi.fn(() => ({ name: "ioredis" }));

vi.mock("@opentelemetry/resources", () => ({
  Resource: class {
    constructor(attributes: Record<string, string>) {
      void attributes;
    }
  }
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  SemanticResourceAttributes: {
    SERVICE_NAME: "service.name"
  }
}));

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: class {
    public readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }

    addSpanProcessor(processor: unknown): void {
      addSpanProcessorMock(processor);
    }

    register(): void {
      registerProviderMock();
    }
  }
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
    constructor(options: unknown) {
      otlpExporterCtorMock(options);
    }
  }
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: class {
    constructor(exporter: unknown) {
      batchSpanProcessorCtorMock(exporter);
    }
  }
}));

vi.mock("@opentelemetry/instrumentation", () => ({
  registerInstrumentations: (options: unknown) => {
    registerInstrumentationsMock(options);
  }
}));

vi.mock("@opentelemetry/instrumentation-fastify", () => ({
  FastifyInstrumentation: class {
    constructor() {
      fastifyInstrumentationCtorMock();
    }
  }
}));

vi.mock("@opentelemetry/instrumentation-ioredis", () => ({
  IORedisInstrumentation: class {
    constructor() {
      ioRedisInstrumentationCtorMock();
    }
  }
}));

vi.mock("@prisma/instrumentation", () => ({
  PrismaInstrumentation: class {
    constructor() {
      prismaInstrumentationCtorMock();
    }
  }
}));

describe("initTracing", () => {
  beforeEach(() => {
    addSpanProcessorMock.mockReset();
    registerProviderMock.mockReset();
    registerInstrumentationsMock.mockReset();
    otlpExporterCtorMock.mockReset();
    batchSpanProcessorCtorMock.mockReset();
    fastifyInstrumentationCtorMock.mockReset();
    prismaInstrumentationCtorMock.mockReset();
    ioRedisInstrumentationCtorMock.mockReset();
  });

  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.resetModules();
  });

  it("no-ops when OTEL endpoint is missing", async () => {
    const { initTracing } = await import("../src/index");

    expect(() => initTracing("usage-service")).not.toThrow();
    expect(registerInstrumentationsMock).not.toHaveBeenCalled();
    expect(registerProviderMock).not.toHaveBeenCalled();
  });

  it("initializes tracing exactly once when endpoint is configured", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318/v1/traces";
    const { initTracing } = await import("../src/index");

    initTracing("usage-service");
    initTracing("usage-service");

    expect(otlpExporterCtorMock).toHaveBeenCalledTimes(1);
    expect(batchSpanProcessorCtorMock).toHaveBeenCalledTimes(1);
    expect(addSpanProcessorMock).toHaveBeenCalledTimes(1);
    expect(registerProviderMock).toHaveBeenCalledTimes(1);
    expect(registerInstrumentationsMock).toHaveBeenCalledTimes(1);
    expect(fastifyInstrumentationCtorMock).toHaveBeenCalledTimes(1);
    expect(prismaInstrumentationCtorMock).toHaveBeenCalledTimes(1);
    expect(ioRedisInstrumentationCtorMock).toHaveBeenCalledTimes(1);
  });
});
