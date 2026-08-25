import { describe, expect, it } from "vitest";
import { AUTH_TOKENS, AUTH_VALIDATION } from "../src/constants";
import { EnvSchema } from "../src/config/env";

const buildBaseEnv = (): Record<string, string> => ({
  NODE_ENV: "test",
  PORT: "3001",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/telemetry",
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "silent",
  JWT_SECRET: "test-jwt-secret-value-with-at-least-32-characters",
  JWT_REFRESH_SECRET: "test-refresh-secret-value-with-at-least-32-chars",
  JWT_ACCESS_TTL_SECONDS: String(AUTH_TOKENS.ACCESS_TTL_SECONDS_DEFAULT),
  JWT_REFRESH_TTL_SECONDS: String(AUTH_TOKENS.REFRESH_TTL_SECONDS_DEFAULT),
  BCRYPT_ROUNDS: String(AUTH_VALIDATION.BCRYPT_DEFAULT_ROUNDS)
});

describe("auth env schema", () => {
  it("validates all required base variables are present", () => {
    // Missing DATABASE_URL should fail
    const parsedMissingDb = EnvSchema.safeParse({
      ...buildBaseEnv(),
      DATABASE_URL: undefined
    });

    expect(parsedMissingDb.success).toBe(false);
  });

  it("rejects JWT_SECRET less than 32 characters", () => {
    const parsed = EnvSchema.safeParse({
      ...buildBaseEnv(),
      JWT_SECRET: "short-secret"
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts JWT_SECRET exactly 32 characters", () => {
    // Create exactly 32 character secret
    const secret32 = "a".repeat(32);

    const parsed = EnvSchema.safeParse({
      ...buildBaseEnv(),
      JWT_SECRET: secret32
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.JWT_SECRET).toBe(secret32);
    }
  });

  it("rejects JWT_REFRESH_SECRET less than 32 characters", () => {
    const parsed = EnvSchema.safeParse({
      ...buildBaseEnv(),
      JWT_REFRESH_SECRET: "too-short"
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts JWT_REFRESH_SECRET exactly 32 characters", () => {
    const secret32 = "b".repeat(32);

    const parsed = EnvSchema.safeParse({
      ...buildBaseEnv(),
      JWT_REFRESH_SECRET: secret32
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.JWT_REFRESH_SECRET).toBe(secret32);
    }
  });

  it("rejects BCRYPT_ROUNDS outside configured range", () => {
    // Below minimum (9)
    const parsedBelowMin = EnvSchema.safeParse({
      ...buildBaseEnv(),
      BCRYPT_ROUNDS: "9"
    });

    expect(parsedBelowMin.success).toBe(false);

    // Above maximum (15)
    const parsedAboveMax = EnvSchema.safeParse({
      ...buildBaseEnv(),
      BCRYPT_ROUNDS: "15"
    });

    expect(parsedAboveMax.success).toBe(false);
  });

  it("accepts BCRYPT_ROUNDS at configured boundaries", () => {
    // Minimum (10)
    const parsedMin = EnvSchema.safeParse({
      ...buildBaseEnv(),
      BCRYPT_ROUNDS: String(AUTH_VALIDATION.BCRYPT_MIN_ROUNDS)
    });

    expect(parsedMin.success).toBe(true);
    if (parsedMin.success) {
      expect(parsedMin.data.BCRYPT_ROUNDS).toBe(AUTH_VALIDATION.BCRYPT_MIN_ROUNDS);
    }

    // Default (12)
    const parsedDefault = EnvSchema.safeParse({
      ...buildBaseEnv(),
      BCRYPT_ROUNDS: String(AUTH_VALIDATION.BCRYPT_DEFAULT_ROUNDS)
    });

    expect(parsedDefault.success).toBe(true);
    if (parsedDefault.success) {
      expect(parsedDefault.data.BCRYPT_ROUNDS).toBe(AUTH_VALIDATION.BCRYPT_DEFAULT_ROUNDS);
    }

    // Maximum (14)
    const parsedMax = EnvSchema.safeParse({
      ...buildBaseEnv(),
      BCRYPT_ROUNDS: String(AUTH_VALIDATION.BCRYPT_MAX_ROUNDS)
    });

    expect(parsedMax.success).toBe(true);
    if (parsedMax.success) {
      expect(parsedMax.data.BCRYPT_ROUNDS).toBe(AUTH_VALIDATION.BCRYPT_MAX_ROUNDS);
    }
  });

  it("accepts access token ttl at configured max", () => {
    const parsed = EnvSchema.safeParse({
      ...buildBaseEnv(),
      JWT_ACCESS_TTL_SECONDS: String(AUTH_TOKENS.ACCESS_TTL_SECONDS_MAX)
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.JWT_ACCESS_TTL_SECONDS).toBe(AUTH_TOKENS.ACCESS_TTL_SECONDS_MAX);
    }
  });

  it("rejects access token ttl above configured max", () => {
    const parsed = EnvSchema.safeParse({
      ...buildBaseEnv(),
      JWT_ACCESS_TTL_SECONDS: String(AUTH_TOKENS.ACCESS_TTL_SECONDS_MAX + 1)
    });

    expect(parsed.success).toBe(false);
  });

  it("coerces numeric environment variables from strings", () => {
    const parsed = EnvSchema.safeParse({
      ...buildBaseEnv(),
      PORT: "3001",
      BCRYPT_ROUNDS: "12",
      JWT_ACCESS_TTL_SECONDS: "900"
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(typeof parsed.data.PORT).toBe("number");
      expect(parsed.data.PORT).toBe(3001);
      expect(typeof parsed.data.BCRYPT_ROUNDS).toBe("number");
      expect(parsed.data.BCRYPT_ROUNDS).toBe(12);
      expect(typeof parsed.data.JWT_ACCESS_TTL_SECONDS).toBe("number");
      expect(parsed.data.JWT_ACCESS_TTL_SECONDS).toBe(900);
    }
  });

  it("applies default values when environment variables are omitted", () => {
    // Omit NODE_ENV to test default
    const baseEnv = buildBaseEnv();
    const { NODE_ENV: _removed, ...envWithoutDefaults } = baseEnv;

    const parsed = EnvSchema.safeParse({
      ...envWithoutDefaults
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.NODE_ENV).toBe("development");
    }
  });

  it("applies PORT default when omitted", () => {
    const baseEnv = buildBaseEnv();
    const { PORT: _removed, ...envWithoutPort } = baseEnv;

    const parsed = EnvSchema.safeParse({
      ...envWithoutPort
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.PORT).toBe(3001);
    }
  });

  it("applies BCRYPT_ROUNDS default when omitted", () => {
    const baseEnv = buildBaseEnv();
    const { BCRYPT_ROUNDS: _removed, ...envWithoutRounds } = baseEnv;

    const parsed = EnvSchema.safeParse({
      ...envWithoutRounds
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.BCRYPT_ROUNDS).toBe(AUTH_VALIDATION.BCRYPT_DEFAULT_ROUNDS);
    }
  });

  it("applies JWT_ACCESS_TTL_SECONDS default when omitted", () => {
    const baseEnv = buildBaseEnv();
    const { JWT_ACCESS_TTL_SECONDS: _removed, ...envWithoutAccessTtl } = baseEnv;

    const parsed = EnvSchema.safeParse({
      ...envWithoutAccessTtl
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.JWT_ACCESS_TTL_SECONDS).toBe(AUTH_TOKENS.ACCESS_TTL_SECONDS_DEFAULT);
    }
  });

  it("applies JWT_REFRESH_TTL_SECONDS default when omitted", () => {
    const baseEnv = buildBaseEnv();
    const { JWT_REFRESH_TTL_SECONDS: _removed, ...envWithoutRefreshTtl } = baseEnv;

    const parsed = EnvSchema.safeParse({
      ...envWithoutRefreshTtl
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.JWT_REFRESH_TTL_SECONDS).toBe(AUTH_TOKENS.REFRESH_TTL_SECONDS_DEFAULT);
    }
  });

  it("rejects invalid NODE_ENV enum values", () => {
    const parsed = EnvSchema.safeParse({
      ...buildBaseEnv(),
      NODE_ENV: "staging"
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts JWT_SECRET longer than 32 characters", () => {
    const secret64 = "a".repeat(64);

    const parsed = EnvSchema.safeParse({
      ...buildBaseEnv(),
      JWT_SECRET: secret64
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.JWT_SECRET).toBe(secret64);
    }
  });

  it("rejects zero or negative JWT_ACCESS_TTL_SECONDS", () => {
    // Zero
    const parsedZero = EnvSchema.safeParse({
      ...buildBaseEnv(),
      JWT_ACCESS_TTL_SECONDS: "0"
    });

    expect(parsedZero.success).toBe(false);

    // Negative
    const parsedNegative = EnvSchema.safeParse({
      ...buildBaseEnv(),
      JWT_ACCESS_TTL_SECONDS: "-1"
    });

    expect(parsedNegative.success).toBe(false);
  });

  it("rejects missing REDIS_URL", () => {
    const parsed = EnvSchema.safeParse({
      ...buildBaseEnv(),
      REDIS_URL: undefined
    });

    expect(parsed.success).toBe(false);
  });
});
