import { describe, expect, it } from "vitest";
import { EnvSchema } from "../src/config/env";

const buildBaseEnv = (): Record<string, string> => ({
  NODE_ENV: "test",
  PORT: "3000",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/telemetry",
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "silent"
});

describe("usage service env schema", () => {
  describe("redis stream configuration", () => {
    it("loads REDIS_STREAM_NAME with default 'telemetry:events'", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_STREAM_NAME).toBe("telemetry:events");
      }
    });

    it("loads REDIS_STREAM_NAME from env var override", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        REDIS_STREAM_NAME: "custom:stream:name"
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_STREAM_NAME).toBe("custom:stream:name");
      }
    });

    it("loads STREAM_MAX_LEN as positive integer with default 100,000", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.STREAM_MAX_LEN).toBe(100_000);
      }
    });

    it("coerces STREAM_MAX_LEN from string to number", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        STREAM_MAX_LEN: "50000"
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.STREAM_MAX_LEN).toBe(50_000);
        expect(typeof parsed.data.STREAM_MAX_LEN).toBe("number");
      }
    });

    it("rejects STREAM_MAX_LEN <= 0", () => {
      // Test with 0
      const parsedZero = EnvSchema.safeParse({
        ...buildBaseEnv(),
        STREAM_MAX_LEN: "0"
      });

      expect(parsedZero.success).toBe(false);

      // Test with negative
      const parsedNegative = EnvSchema.safeParse({
        ...buildBaseEnv(),
        STREAM_MAX_LEN: "-100"
      });

      expect(parsedNegative.success).toBe(false);
    });

    it("loads INGEST_BATCH_MAX with default 100", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.INGEST_BATCH_MAX).toBe(100);
      }
    });

    it("rejects INGEST_BATCH_MAX < 1 or > 100", () => {
      // Test with 0
      const parsedZero = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INGEST_BATCH_MAX: "0"
      });

      expect(parsedZero.success).toBe(false);

      // Test with > 100
      const parsedAboveMax = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INGEST_BATCH_MAX: "101"
      });

      expect(parsedAboveMax.success).toBe(false);
    });

    it("accepts INGEST_BATCH_MAX at boundaries (1 and 100)", () => {
      // Test with 1 (minimum)
      const parsedMin = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INGEST_BATCH_MAX: "1"
      });

      expect(parsedMin.success).toBe(true);

      if (parsedMin.success) {
        expect(parsedMin.data.INGEST_BATCH_MAX).toBe(1);
      }

      // Test with 100 (maximum)
      const parsedMax = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INGEST_BATCH_MAX: "100"
      });

      expect(parsedMax.success).toBe(true);

      if (parsedMax.success) {
        expect(parsedMax.data.INGEST_BATCH_MAX).toBe(100);
      }
    });
  });
});
