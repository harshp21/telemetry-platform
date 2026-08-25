import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import { gatewayJwtAuthPreHandler } from "../src/middleware/auth.middleware";
import { GATEWAY_AUTH_ROUTES, GATEWAY_ROUTES } from "../src/constants";

vi.mock("jose", () => {
  return {
    jwtVerify: vi.fn()
  };
});

const jwtVerifyMock = vi.mocked(jwtVerify);

type ReplyRecorder = {
  readonly reply: FastifyReply;
  readonly statusSpy: ReturnType<typeof vi.fn>;
  readonly sendSpy: ReturnType<typeof vi.fn>;
};

const createReplyRecorder = (): ReplyRecorder => {
  const sendSpy = vi.fn();
  const statusSpy = vi.fn().mockImplementation((_statusCode: number) => {
    return {
      send: sendSpy
    };
  });

  return {
    reply: {
      status: statusSpy
    } as unknown as FastifyReply,
    statusSpy,
    sendSpy
  };
};

type RequestInput = {
  method: string;
  url: string;
  authorization?: string;
};

const createRequest = ({ method, url, authorization }: RequestInput): FastifyRequest => {
  const headers: Record<string, string> = {};

  if (authorization) {
    headers.authorization = authorization;
  }

  return {
    method,
    url,
    headers
  } as FastifyRequest;
};

describe("gateway jwt auth pre-handler", () => {
  const previousSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret-value-with-at-least-32-characters";
    jwtVerifyMock.mockReset();
  });

  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.JWT_SECRET;
      return;
    }

    process.env.JWT_SECRET = previousSecret;
  });

  it("bypasses auth for public routes", async () => {
    const publicRequests = [
      createRequest({ method: "GET", url: GATEWAY_ROUTES.HEALTH }),
      createRequest({ method: "GET", url: `${GATEWAY_ROUTES.V1_HEALTH}?probe=1` }),
      createRequest({ method: "POST", url: GATEWAY_AUTH_ROUTES.REGISTER }),
      createRequest({ method: "POST", url: GATEWAY_AUTH_ROUTES.LOGIN }),
      createRequest({ method: "POST", url: GATEWAY_AUTH_ROUTES.REFRESH })
    ];

    for (const request of publicRequests) {
      const { reply, statusSpy, sendSpy } = createReplyRecorder();
      await gatewayJwtAuthPreHandler(request, reply);
      expect(statusSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    }

    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it("returns TOKEN_MISSING when auth header is absent on protected routes", async () => {
    const request = createRequest({ method: "GET", url: "/v1/usage/events" });
    const { reply, statusSpy, sendSpy } = createReplyRecorder();

    await gatewayJwtAuthPreHandler(request, reply);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(sendSpy).toHaveBeenCalledWith({ code: "TOKEN_MISSING" });
  });

  it("returns TOKEN_INVALID when auth scheme is malformed", async () => {
    const request = createRequest({ method: "GET", url: "/v1/usage/events", authorization: "Basic abc" });
    const { reply, statusSpy, sendSpy } = createReplyRecorder();

    await gatewayJwtAuthPreHandler(request, reply);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(sendSpy).toHaveBeenCalledWith({ code: "TOKEN_INVALID" });
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it("returns TOKEN_EXPIRED for expired jwt verification errors", async () => {
    const request = createRequest({ method: "GET", url: "/v1/usage/events", authorization: "Bearer expired" });
    const { reply, statusSpy, sendSpy } = createReplyRecorder();
    const expiredError = Object.assign(new Error("expired"), { code: "ERR_JWT_EXPIRED" });
    jwtVerifyMock.mockRejectedValueOnce(expiredError);

    await gatewayJwtAuthPreHandler(request, reply);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(sendSpy).toHaveBeenCalledWith({ code: "TOKEN_EXPIRED" });
  });

  it("returns TOKEN_INVALID for invalid claims payload", async () => {
    const request = createRequest({ method: "GET", url: "/v1/usage/events", authorization: "Bearer token" });
    const { reply, statusSpy, sendSpy } = createReplyRecorder();
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "user-1", tenantId: "tenant-1" },
      protectedHeader: { alg: "HS256" }
    });

    await gatewayJwtAuthPreHandler(request, reply);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(sendSpy).toHaveBeenCalledWith({ code: "TOKEN_INVALID" });
  });

  it("sets auth context when token payload is valid", async () => {
    const request = createRequest({ method: "GET", url: "/v1/usage/events", authorization: "Bearer valid" });
    const { reply, statusSpy, sendSpy } = createReplyRecorder();
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { sub: "user-1", tenantId: "tenant-1", role: "admin" },
      protectedHeader: { alg: "HS256" }
    });

    await gatewayJwtAuthPreHandler(request, reply);

    expect(statusSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(jwtVerifyMock).toHaveBeenCalledWith("valid", expect.any(Uint8Array), {
      algorithms: ["HS256"]
    });
    expect(request.authContext).toEqual({ userId: "user-1", tenantId: "tenant-1", role: "admin" });
  });

  it("returns TOKEN_INVALID for non-expired jwt verification failures", async () => {
    const request = createRequest({ method: "GET", url: "/v1/usage/events", authorization: "Bearer invalid" });
    const { reply, statusSpy, sendSpy } = createReplyRecorder();
    jwtVerifyMock.mockRejectedValueOnce(new Error("invalid"));

    await gatewayJwtAuthPreHandler(request, reply);

    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(sendSpy).toHaveBeenCalledWith({ code: "TOKEN_INVALID" });
  });
});