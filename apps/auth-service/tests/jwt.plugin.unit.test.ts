import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SignJWT } from "jose";
import {
  ExpiredTokenError,
  InvalidTokenError,
  MissingOrMalformedTokenError,
  RevokedTokenError
} from "../src/errors";

const isTokenJtiDenylistedMock = vi.fn();

vi.mock("../src/services/token-denylist.service", () => {
  return {
    TokenDenylistService: class {
      isTokenJtiDenylisted = isTokenJtiDenylistedMock;
    }
  };
});

import { requireJwtAuth } from "../src/plugins/jwt.plugin";

const createRequest = (authorization?: string): FastifyRequest => {
  return {
    headers: authorization ? { authorization } : {}
  } as unknown as FastifyRequest;
};

const createAccessToken = async (
  secret: string,
  payload: {
    tenantId?: string;
    role?: "OWNER" | "ADMIN" | "MEMBER";
    jti?: string;
  },
  expiration: string
): Promise<string> => {
  const secretKey = new TextEncoder().encode(secret);

  return new SignJWT({
    ...(payload.tenantId ? { tenantId: payload.tenantId } : {}),
    ...(payload.role ? { role: payload.role } : {}),
    ...(payload.jti ? { jti: payload.jti } : {})
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user_1")
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(secretKey);
};

describe("jwt.plugin unit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    isTokenJtiDenylistedMock.mockReset();
    isTokenJtiDenylistedMock.mockResolvedValue(false);
    process.env.JWT_SECRET = "test-jwt-secret-value-with-at-least-32-characters";
  });

  it("throws MissingOrMalformedTokenError when authorization header is missing", async () => {
    const request = createRequest();

    await expect(requireJwtAuth(request, {} as FastifyReply)).rejects.toBeInstanceOf(
      MissingOrMalformedTokenError
    );
  });

  it("throws MissingOrMalformedTokenError for malformed scheme", async () => {
    const request = createRequest("Basic abc");

    await expect(requireJwtAuth(request, {} as FastifyReply)).rejects.toBeInstanceOf(
      MissingOrMalformedTokenError
    );
  });

  it("throws ExpiredTokenError for expired token", async () => {
    const token = await createAccessToken(
      process.env.JWT_SECRET as string,
      { tenantId: "tenant_1", role: "OWNER", jti: "jti_1" },
      "-1s"
    );
    const request = createRequest(`Bearer ${token}`);

    await expect(requireJwtAuth(request, {} as FastifyReply)).rejects.toBeInstanceOf(
      ExpiredTokenError
    );
  });

  it("throws InvalidTokenError when required claims are missing", async () => {
    const token = await createAccessToken(
      process.env.JWT_SECRET as string,
      { role: "OWNER", jti: "jti_1" },
      "15m"
    );
    const request = createRequest(`Bearer ${token}`);

    await expect(requireJwtAuth(request, {} as FastifyReply)).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it("sets request.auth for valid token and non-denylisted jti", async () => {
    const token = await createAccessToken(
      process.env.JWT_SECRET as string,
      { tenantId: "tenant_1", role: "OWNER", jti: "jti_valid" },
      "15m"
    );
    const request = createRequest(`Bearer ${token}`) as FastifyRequest & {
      auth?: {
        userId: string;
        tenantId: string;
        role: "OWNER" | "ADMIN" | "MEMBER";
        jti: string;
        expiresAt: number;
      };
    };

    await requireJwtAuth(request, {} as FastifyReply);

    expect(isTokenJtiDenylistedMock).toHaveBeenCalledWith("jti_valid");
    expect(request.auth).toBeDefined();
    expect(request.auth?.userId).toBe("user_1");
    expect(request.auth?.tenantId).toBe("tenant_1");
    expect(request.auth?.role).toBe("OWNER");
    expect(request.auth?.jti).toBe("jti_valid");
    expect(typeof request.auth?.expiresAt).toBe("number");
  });

  it("throws RevokedTokenError when jti is denylisted", async () => {
    isTokenJtiDenylistedMock.mockResolvedValueOnce(true);

    const token = await createAccessToken(
      process.env.JWT_SECRET as string,
      { tenantId: "tenant_1", role: "OWNER", jti: "jti_revoked" },
      "15m"
    );
    const request = createRequest(`Bearer ${token}`);

    await expect(requireJwtAuth(request, {} as FastifyReply)).rejects.toBeInstanceOf(
      RevokedTokenError
    );
  });
});
