import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jwtVerify } from "jose";

const applyEnv = (): void => {
  process.env.NODE_ENV = "test";
  process.env.PORT = "3001";
  process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/telemetry";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
  process.env.LOG_LEVEL = "silent";
  process.env.JWT_SECRET = "test-jwt-secret-value-with-at-least-32-characters";
  process.env.JWT_REFRESH_SECRET = "test-refresh-secret-value-with-at-least-32-chars";
  process.env.JWT_ACCESS_TTL_SECONDS = "900";
  process.env.JWT_REFRESH_TTL_SECONDS = "604800";
  process.env.BCRYPT_ROUNDS = "10";
};

describe("token.service unit", () => {
  beforeEach(() => {
    vi.resetModules();
    applyEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hashRefreshToken is deterministic", async () => {
    const { TokenService } = await import("../src/services/token.service");
    const service = new TokenService();

    const a = service.hashRefreshToken("refresh-token-value");
    const b = service.hashRefreshToken("refresh-token-value");

    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("createAccessToken returns token with expected claims and ttl", async () => {
    const { TokenService } = await import("../src/services/token.service");
    const service = new TokenService();

    const result = await service.createAccessToken({
      userId: "user_1",
      tenantId: "tenant_1",
      role: "OWNER"
    });

    expect(result.expiresInSeconds).toBe(900);

    const secretKey = new TextEncoder().encode(process.env.JWT_SECRET);
    const verified = await jwtVerify(result.accessToken, secretKey);

    expect(verified.payload.sub).toBe("user_1");
    expect(verified.payload.tenantId).toBe("tenant_1");
    expect(verified.payload.role).toBe("OWNER");
    expect(typeof verified.payload.jti).toBe("string");
    expect((verified.payload.jti as string).length).toBeGreaterThan(0);
    expect((verified.payload.exp ?? 0) - (verified.payload.iat ?? 0)).toBe(900);
  });

  it("createRefreshToken sets hash and expiry based on ttl", async () => {
    const { TokenService } = await import("../src/services/token.service");
    const service = new TokenService();
    const now = Date.now();

    const result = service.createRefreshToken();

    expect(result.refreshToken).toHaveLength(64);
    expect(result.refreshTokenHash).toBe(service.hashRefreshToken(result.refreshToken));

    const diffSeconds = Math.round((result.expiresAt.getTime() - now) / 1000);
    expect(diffSeconds).toBeGreaterThanOrEqual(604798);
    expect(diffSeconds).toBeLessThanOrEqual(604802);
  });
});
