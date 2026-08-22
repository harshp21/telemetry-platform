import { afterEach, describe, expect, it, vi } from "vitest";

describe("initTracing", () => {
  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.resetModules();
  });

  it("no-ops when OTEL endpoint is missing", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const { initTracing } = await import("../src/index");

    expect(() => initTracing("usage-service")).not.toThrow();
  });

  it("is safe to call multiple times", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318/v1/traces";
    const { initTracing } = await import("../src/index");

    expect(() => initTracing("usage-service")).not.toThrow();
    expect(() => initTracing("usage-service")).not.toThrow();
  });
});
