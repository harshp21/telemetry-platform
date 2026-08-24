import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_TOKENS } from "../src/constants";

const buildBaseEnv = (): Record<string, string> => ({
  NODE_ENV: "test",
  PORT: "3001",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/telemetry",
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "silent",
  JWT_SECRET: "test-jwt-secret-value-with-at-least-32-characters",
  JWT_REFRESH_SECRET: "test-refresh-secret-value-with-at-least-32-chars",
  JWT_REFRESH_TTL_SECONDS: "604800",
  BCRYPT_ROUNDS: "10"
});

describe("auth env schema", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("accepts access token ttl at configured max", async () => {
    Object.assign(process.env, {
      ...buildBaseEnv(),
      JWT_ACCESS_TTL_SECONDS: String(AUTH_TOKENS.ACCESS_TTL_SECONDS_MAX)
    });

    const { EnvSchema } = await import("../src/config/env");

    const parsed = EnvSchema.safeParse({
      ...buildBaseEnv(),
      JWT_ACCESS_TTL_SECONDS: String(AUTH_TOKENS.ACCESS_TTL_SECONDS_MAX)
    });

    expect(parsed.success).toBe(true);

    if (!parsed.success) {
      return;
    }

    expect(parsed.data.JWT_ACCESS_TTL_SECONDS).toBe(AUTH_TOKENS.ACCESS_TTL_SECONDS_MAX);
  });

  it("rejects access token ttl above configured max", async () => {
    Object.assign(process.env, {
      ...buildBaseEnv(),
      JWT_ACCESS_TTL_SECONDS: String(AUTH_TOKENS.ACCESS_TTL_SECONDS_MAX + 1)
    });

    await expect(import("../src/config/env")).rejects.toThrow(
      "Invalid environment configuration for JWT_ACCESS_TTL_SECONDS"
    );
  });
});
