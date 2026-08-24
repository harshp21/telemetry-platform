import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { ERROR_RESPONSES } from "@telemetry/shared-types";
import { buildAuthServiceApp } from "../src/app";
import {
  AUTH_COOKIES,
  AUTH_MESSAGES,
  AUTH_HTTP_STATUS,
  AUTH_RESPONSES,
  AUTH_ROUTES,
  AUTH_SERVICE_NAME
} from "../src/constants";
import {
  EmailAlreadyExistsError,
  InvalidCredentialsError,
  InvalidRefreshTokenError
} from "../src/errors";

const registerMock = vi.fn();
const loginMock = vi.fn();
const refreshMock = vi.fn();
const logoutMock = vi.fn();
const isTokenJtiDenylistedMock = vi.fn();
const TEST_JWT_SECRET = "test-jwt-secret-value-with-at-least-32-characters";
const TEST_CSRF_TOKEN = "csrf-token-fixture";

const createAccessTokenFixture = async (): Promise<string> => {
  const secretKey = new TextEncoder().encode(TEST_JWT_SECRET);

  return new SignJWT({
    tenantId: "tenant_1",
    role: "OWNER"
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user_1")
    .setJti("logout_jti_1")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(secretKey);
};

const createExpiredAccessTokenFixture = async (): Promise<string> => {
  const secretKey = new TextEncoder().encode(TEST_JWT_SECRET);

  return new SignJWT({
    tenantId: "tenant_1",
    role: "OWNER"
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user_1")
    .setJti("expired_jti_1")
    .setIssuedAt()
    .setExpirationTime("-1s")
    .sign(secretKey);
};

const createInvalidSignatureTokenFixture = async (): Promise<string> => {
  const wrongSecretKey = new TextEncoder().encode("different-secret-value-with-at-least-32");

  return new SignJWT({
    tenantId: "tenant_1",
    role: "OWNER"
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user_1")
    .setJti("invalid_signature_jti_1")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(wrongSecretKey);
};

vi.mock("../src/services/auth.service", () => {
  return {
    AuthService: class {
      register = registerMock;
      login = loginMock;
      refresh = refreshMock;
      logout = logoutMock;
    }
  };
});

vi.mock("../src/services/token-denylist.service", () => {
  return {
    TokenDenylistService: class {
      isTokenJtiDenylisted = isTokenJtiDenylistedMock;
    }
  };
});

describe("auth-service", () => {
  let app: FastifyInstance;

  const extractSetCookies = (response: Awaited<ReturnType<FastifyInstance["inject"]>>): string[] => {
    const setCookieHeader = response.headers["set-cookie"];
    if (!setCookieHeader) {
      return [];
    }

    return Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  };

  const buildSessionCookieHeader = (refreshToken: string, csrfToken = TEST_CSRF_TOKEN): string => {
    return `${AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT}=${refreshToken}; ${AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT}=${csrfToken}`;
  };

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.AUTH_COOKIE_SECURE = "false";
    process.env.AUTH_COOKIE_SAME_SITE = "Lax";
    registerMock.mockReset();
    loginMock.mockReset();
    refreshMock.mockReset();
    logoutMock.mockReset();
    isTokenJtiDenylistedMock.mockReset();
    isTokenJtiDenylistedMock.mockResolvedValue(false);
    app = buildAuthServiceApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns healthy status", async () => {
    const response = await app.inject({ method: "GET", url: AUTH_ROUTES.HEALTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: AUTH_RESPONSES.STATUS_OK,
      service: AUTH_SERVICE_NAME
    });
  });

  it("registers a user and returns 201", async () => {
    registerMock.mockResolvedValueOnce({ userId: "user_1", tenantId: "tenant_1" });

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
      payload: {
        email: "owner@example.com",
        password: "StrongPass123",
        tenantName: "Acme Inc"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.CREATED);
    expect(response.json()).toEqual({
      data: {
        userId: "user_1",
        tenantId: "tenant_1"
      }
    });
  });

  it("returns 409 when email already exists", async () => {
    registerMock.mockRejectedValueOnce(new EmailAlreadyExistsError());

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
      payload: {
        email: "owner@example.com",
        password: "StrongPass123",
        tenantName: "Acme Inc"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.CONFLICT);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_EMAIL_ALREADY_EXISTS,
      message: AUTH_MESSAGES.REGISTRATION_FAILED
    });
  });

  it("returns 400 for invalid register payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
      payload: {
        email: "bad-email",
        password: "short",
        tenantName: ""
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: ERROR_RESPONSES.CODE_VALIDATION_ERROR
    });
    expect(registerMock).not.toHaveBeenCalled();
  });

  it("logs in a user and returns 200", async () => {
    loginMock.mockResolvedValueOnce({
      accessToken: "access_token",
      refreshToken: "refresh_token",
      tokenType: "Bearer",
      expiresInSeconds: 900,
      user: {
        userId: "user_1",
        tenantId: "tenant_1",
        role: "OWNER"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGIN}`,
      payload: {
        email: "owner@example.com",
        password: "StrongPass123"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.OK);
    const setCookies = extractSetCookies(response);
    const refreshCookie = setCookies.find((cookie) =>
      cookie.startsWith(`${AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT}=`)
    );
    const csrfCookie = setCookies.find((cookie) =>
      cookie.startsWith(`${AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT}=`)
    );
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toContain("HttpOnly");
    expect(csrfCookie).toBeDefined();
    expect(response.json()).toEqual({
      data: {
        accessToken: "access_token",
        tokenType: "Bearer",
        expiresInSeconds: 900,
        user: {
          userId: "user_1",
          tenantId: "tenant_1",
          role: "OWNER"
        }
      }
    });
  });

  it("returns 401 when credentials are invalid", async () => {
    loginMock.mockRejectedValueOnce(new InvalidCredentialsError());

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGIN}`,
      payload: {
        email: "owner@example.com",
        password: "WrongPass123"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_INVALID_CREDENTIALS,
      message: AUTH_MESSAGES.INVALID_CREDENTIALS
    });
  });

  it("returns 400 for invalid login payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGIN}`,
      payload: {
        email: "bad-email",
        password: "short"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: ERROR_RESPONSES.CODE_VALIDATION_ERROR
    });
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("refreshes tokens and returns 200", async () => {
    refreshMock.mockResolvedValueOnce({
      accessToken: "next_access_token",
      refreshToken: "next_refresh_token",
      tokenType: "Bearer",
      expiresInSeconds: 900,
      user: {
        userId: "user_1",
        tenantId: "tenant_1",
        role: "OWNER"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REFRESH}`,
      headers: {
        cookie: buildSessionCookieHeader("refresh_token"),
        [AUTH_COOKIES.CSRF_HEADER_NAME_DEFAULT]: TEST_CSRF_TOKEN
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.OK);
    expect(refreshMock).toHaveBeenCalledWith({ refreshToken: "refresh_token" });
    const setCookies = extractSetCookies(response);
    const refreshCookie = setCookies.find((cookie) =>
      cookie.startsWith(`${AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT}=`)
    );
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toContain(`${AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT}=next_refresh_token`);
    expect(response.json()).toEqual({
      data: {
        accessToken: "next_access_token",
        tokenType: "Bearer",
        expiresInSeconds: 900,
        user: {
          userId: "user_1",
          tenantId: "tenant_1",
          role: "OWNER"
        }
      }
    });
  });

  it("returns 401 when refresh token is invalid", async () => {
    refreshMock.mockRejectedValueOnce(new InvalidRefreshTokenError());

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REFRESH}`,
      headers: {
        cookie: buildSessionCookieHeader("bad_refresh_token"),
        [AUTH_COOKIES.CSRF_HEADER_NAME_DEFAULT]: TEST_CSRF_TOKEN
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_REFRESH_TOKEN_INVALID,
      message: AUTH_MESSAGES.INVALID_REFRESH_TOKEN
    });
  });

  it("returns 401 for missing refresh-token cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REFRESH}`,
      headers: {
        [AUTH_COOKIES.CSRF_HEADER_NAME_DEFAULT]: TEST_CSRF_TOKEN
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_REFRESH_TOKEN_INVALID,
      message: AUTH_MESSAGES.INVALID_REFRESH_TOKEN
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("returns 401 when refresh CSRF token is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REFRESH}`,
      headers: {
        cookie: buildSessionCookieHeader("refresh_token")
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_CSRF_INVALID,
      message: AUTH_MESSAGES.CSRF_INVALID
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("logs out an authenticated user and returns 204", async () => {
    const accessToken = await createAccessTokenFixture();

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGOUT}`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        cookie: buildSessionCookieHeader("refresh_token"),
        [AUTH_COOKIES.CSRF_HEADER_NAME_DEFAULT]: TEST_CSRF_TOKEN
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.NO_CONTENT);
    const setCookies = extractSetCookies(response);
    const refreshCookie = setCookies.find((cookie) =>
      cookie.startsWith(`${AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT}=`)
    );
    const csrfCookie = setCookies.find((cookie) =>
      cookie.startsWith(`${AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT}=`)
    );
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toContain("Max-Age=0");
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).toContain("Max-Age=0");
    expect(response.body).toBe("");
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(logoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        tenantId: "tenant_1",
        role: "OWNER",
        jti: "logout_jti_1"
      })
    );
  });

  it("returns 401 when logout request is missing authorization", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGOUT}`
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_TOKEN_MISSING,
      message: AUTH_MESSAGES.TOKEN_MISSING
    });
    expect(logoutMock).not.toHaveBeenCalled();
  });

  it("returns 401 when logout CSRF token is invalid", async () => {
    const accessToken = await createAccessTokenFixture();

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGOUT}`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        cookie: buildSessionCookieHeader("refresh_token", "csrf-cookie-token"),
        [AUTH_COOKIES.CSRF_HEADER_NAME_DEFAULT]: "csrf-header-token"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_CSRF_INVALID,
      message: AUTH_MESSAGES.CSRF_INVALID
    });
    expect(logoutMock).not.toHaveBeenCalled();
  });

  it("returns 401 when logout authorization header is malformed", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGOUT}`,
      headers: {
        authorization: "Basic malformed"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_TOKEN_MISSING,
      message: AUTH_MESSAGES.TOKEN_MISSING
    });
    expect(logoutMock).not.toHaveBeenCalled();
  });

  it("returns 401 when logout token is expired", async () => {
    const expiredToken = await createExpiredAccessTokenFixture();

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGOUT}`,
      headers: {
        authorization: `Bearer ${expiredToken}`
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_TOKEN_EXPIRED,
      message: AUTH_MESSAGES.TOKEN_EXPIRED
    });
    expect(logoutMock).not.toHaveBeenCalled();
  });

  it("returns 401 when logout token signature is invalid", async () => {
    const invalidSignatureToken = await createInvalidSignatureTokenFixture();

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGOUT}`,
      headers: {
        authorization: `Bearer ${invalidSignatureToken}`
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_TOKEN_INVALID,
      message: AUTH_MESSAGES.TOKEN_INVALID
    });
    expect(logoutMock).not.toHaveBeenCalled();
  });

  it("returns 401 when logout token has been denylisted", async () => {
    isTokenJtiDenylistedMock.mockResolvedValueOnce(true);
    const accessToken = await createAccessTokenFixture();

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGOUT}`,
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_TOKEN_REVOKED,
      message: AUTH_MESSAGES.TOKEN_REVOKED
    });
    expect(logoutMock).not.toHaveBeenCalled();
  });
});
