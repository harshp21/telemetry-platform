import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { ERROR_RESPONSES } from "@telemetry/shared-types";
import { buildAuthServiceApp } from "../src/app";
import {
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
const TEST_JWT_SECRET = "test-jwt-secret-value-with-at-least-32-characters";

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

describe("auth-service", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    registerMock.mockReset();
    loginMock.mockReset();
    refreshMock.mockReset();
    logoutMock.mockReset();
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
    expect(response.json()).toEqual({
      data: {
        accessToken: "access_token",
        refreshToken: "refresh_token",
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
      payload: {
        refreshToken: "refresh_token"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.OK);
    expect(response.json()).toEqual({
      data: {
        accessToken: "next_access_token",
        refreshToken: "next_refresh_token",
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
      payload: {
        refreshToken: "bad_refresh_token"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_REFRESH_TOKEN_INVALID,
      message: AUTH_MESSAGES.INVALID_REFRESH_TOKEN
    });
  });

  it("returns 400 for invalid refresh payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REFRESH}`,
      payload: {
        refreshToken: ""
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: ERROR_RESPONSES.CODE_VALIDATION_ERROR
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("logs out an authenticated user and returns 204", async () => {
    const accessToken = await createAccessTokenFixture();

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGOUT}`,
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.NO_CONTENT);
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
      code: AUTH_RESPONSES.CODE_UNAUTHORIZED,
      message: AUTH_MESSAGES.UNAUTHORIZED
    });
    expect(logoutMock).not.toHaveBeenCalled();
  });
});
