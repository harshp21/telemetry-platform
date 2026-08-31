import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
import { EnvSchema } from "../src/config/env";

const VALID_INTERNAL_API_SECRET = "s-004-base-internal-secret-at-least-32-chars";

const buildBaseEnv = (): Record<string, string> => ({
  NODE_ENV: "test",
  PORT: "3000",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/telemetry",
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "silent",
  INTERNAL_API_SECRET: VALID_INTERNAL_API_SECRET
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

  // S-4: docs/reviewer-checklist.md section 3 requires a service with internal-only routes to
  // fail fast when INTERNAL_API_SECRET is missing. `parseEnv` throws at module load, so the
  // process never reaches `app.listen`.
  describe("internal service auth configuration", () => {
    const previousSecret = process.env.INTERNAL_API_SECRET;

    afterEach(() => {
      if (previousSecret === undefined) {
        delete process.env.INTERNAL_API_SECRET;
      } else {
        process.env.INTERNAL_API_SECRET = previousSecret;
      }
      vi.resetModules();
    });

    it("rejects an env with no INTERNAL_API_SECRET", () => {
      const { INTERNAL_API_SECRET: _omitted, ...withoutSecret } = buildBaseEnv();
      void _omitted;

      const parsed = EnvSchema.safeParse(withoutSecret);

      expect(parsed.success).toBe(false);

      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.path[0] === "INTERNAL_API_SECRET")).toBe(
          true
        );
      }
    });

    it("rejects an INTERNAL_API_SECRET shorter than the shared minimum", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INTERNAL_API_SECRET: "x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1)
      });

      expect(parsed.success).toBe(false);
    });

    it("rejects an empty INTERNAL_API_SECRET", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INTERNAL_API_SECRET: ""
      });

      expect(parsed.success).toBe(false);
    });

    it("accepts an INTERNAL_API_SECRET exactly at the shared minimum length", () => {
      const atMinimum = "x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INTERNAL_API_SECRET: atMinimum
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.INTERNAL_API_SECRET).toBe(atMinimum);
      }
    });

    it("fails fast at module load when INTERNAL_API_SECRET is absent", async () => {
      vi.resetModules();
      delete process.env.INTERNAL_API_SECRET;

      await expect(import("../src/config/env")).rejects.toThrow(/INTERNAL_API_SECRET/);
    });

    it("loads at module load when INTERNAL_API_SECRET is present", async () => {
      vi.resetModules();
      process.env.INTERNAL_API_SECRET = VALID_INTERNAL_API_SECRET;

      const loaded = (await import("../src/config/env")) as { env: { INTERNAL_API_SECRET: string } };

      expect(loaded.env.INTERNAL_API_SECRET).toBe(VALID_INTERNAL_API_SECRET);
    });
  });
});
