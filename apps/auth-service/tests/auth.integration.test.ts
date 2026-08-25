import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import {
  AUTH_COOKIES,
  AUTH_HTTP_STATUS,
  AUTH_MESSAGES,
  AUTH_RESPONSES,
  AUTH_ROUTES
} from "../src/constants";

const TEST_ENV = {
  NODE_ENV: "test",
  PORT: "3001",
  DATABASE_URL:
    process.env.AUTH_TEST_DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/telemetry",
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "silent",
  JWT_SECRET: "test-jwt-secret-value-with-at-least-32-characters",
  JWT_REFRESH_SECRET: "test-refresh-secret-value-with-at-least-32-chars",
  JWT_ACCESS_TTL_SECONDS: "900",
  JWT_REFRESH_TTL_SECONDS: "604800",
  BCRYPT_ROUNDS: "10",
  AUTH_COOKIE_SECURE: "false",
  AUTH_COOKIE_SAME_SITE: "Lax"
} as const;

type CookieMap = Record<string, string>;

type RedisClientWithDisconnect = {
  disconnect?: () => void;
};

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

type BuildAuthServiceAppFn = () => FastifyInstance;

type PrismaClientLike = {
  refreshToken: {
    deleteMany: () => Promise<unknown>;
  };
  user: {
    deleteMany: () => Promise<unknown>;
  };
  tenant: {
    deleteMany: () => Promise<unknown>;
  };
  $disconnect: () => Promise<void>;
};

type AppModuleShape = {
  buildAuthServiceApp: BuildAuthServiceAppFn;
};

type PrismaModuleShape = {
  prisma: PrismaClientLike;
};

describe.sequential("auth-service integration", () => {
  let app: FastifyInstance | undefined;
  let buildAuthServiceApp: BuildAuthServiceAppFn;
  let prisma: PrismaClientLike | undefined;

  const applyTestEnv = (): void => {
    for (const [key, value] of Object.entries(TEST_ENV)) {
      process.env[key] = value;
    }
  };

  const extractSetCookies = (
    response: InjectResponse
  ): string[] => {
    const setCookieHeader = response.headers["set-cookie"];

    if (!setCookieHeader) {
      return [];
    }

    return Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  };

  const parseSetCookieValues = (setCookies: string[]): CookieMap => {
    return setCookies.reduce<CookieMap>((cookies, setCookie) => {
      const rawPair = setCookie.split(";")[0];
      if (!rawPair) {
        return cookies;
      }

      const separatorIndex = rawPair.indexOf("=");
      if (separatorIndex <= 0) {
        return cookies;
      }

      const name = rawPair.slice(0, separatorIndex).trim();
      const value = rawPair.slice(separatorIndex + 1).trim();
      cookies[name] = decodeURIComponent(value);

      return cookies;
    }, {});
  };

  const buildSessionCookieHeader = (cookieMap: CookieMap): string => {
    const refreshToken = cookieMap[AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT];
    const csrfToken = cookieMap[AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT];

    if (!refreshToken || !csrfToken) {
      throw new Error("Expected refresh and csrf cookies in response");
    }

    return `${AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT}=${refreshToken}; ${AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT}=${csrfToken}`;
  };

  const resetAuthState = async (): Promise<void> => {
    await getPrisma().refreshToken.deleteMany();
    await getPrisma().user.deleteMany();
    await getPrisma().tenant.deleteMany();
  };

  const parseJsonBody = <T>(response: InjectResponse): T => {
    return JSON.parse(response.body) as T;
  };

  const getApp = (): FastifyInstance => {
    if (!app) {
      throw new Error("App is not initialized");
    }

    return app;
  };

  const getPrisma = (): PrismaClientLike => {
    if (!prisma) {
      throw new Error("Prisma client is not initialized");
    }

    return prisma;
  };

  const registerUser = async (email: string): Promise<void> => {
    const response: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
      payload: {
        firstName: "Test",
        lastName: "User",
        email,
        password: "StrongPass123",
        tenantName: "Acme Inc"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.CREATED);
  };

  beforeAll(async () => {
    applyTestEnv();
    const appModule = (await import("../src/app")) as AppModuleShape;
    buildAuthServiceApp = appModule.buildAuthServiceApp;

    const prismaModule = (await import("../src/lib/prisma")) as PrismaModuleShape;
    prisma = prismaModule.prisma;

    app = buildAuthServiceApp();
  });

  beforeEach(async () => {
    await resetAuthState();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    if (prisma) {
      await prisma.$disconnect();
    }

    const globalRedis = (globalThis as { authRedis?: RedisClientWithDisconnect }).authRedis;
    globalRedis?.disconnect?.();
    (globalThis as { authRedis?: RedisClientWithDisconnect }).authRedis = undefined;
  });

  it("registers a user and rejects duplicate email", async () => {
    const email = `owner-${randomUUID()}@example.com`;

    const firstResponse: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
      payload: {
        firstName: "John",
        lastName: "Doe",
        email,
        password: "StrongPass123",
        tenantName: "Acme Inc"
      }
    });

    expect(firstResponse.statusCode).toBe(AUTH_HTTP_STATUS.CREATED);
    const firstBody = parseJsonBody<{ data: { userId: string; tenantId: string } }>(firstResponse);
    expect(typeof firstBody.data.userId).toBe("string");
    expect(firstBody.data.userId.length).toBeGreaterThan(0);
    expect(typeof firstBody.data.tenantId).toBe("string");
    expect(firstBody.data.tenantId.length).toBeGreaterThan(0);

    const duplicateResponse: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
      payload: {
        firstName: "Jane",
        lastName: "Smith",
        email,
        password: "StrongPass123",
        tenantName: "Acme Inc"
      }
    });

    expect(duplicateResponse.statusCode).toBe(AUTH_HTTP_STATUS.CONFLICT);
    expect(parseJsonBody<{ code: string; message: string }>(duplicateResponse)).toEqual({
      code: AUTH_RESPONSES.CODE_EMAIL_ALREADY_EXISTS,
      message: AUTH_MESSAGES.REGISTRATION_FAILED
    });
  });

  it("logs in successfully with cookie session and rejects wrong password", async () => {
    const email = `owner-${randomUUID()}@example.com`;
    await registerUser(email);

    const loginResponse: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGIN}`,
      payload: {
        email,
        password: "StrongPass123"
      }
    });

    expect(loginResponse.statusCode).toBe(AUTH_HTTP_STATUS.OK);
    const setCookies: string[] = extractSetCookies(loginResponse);
    const parsedCookies: CookieMap = parseSetCookieValues(setCookies);

    expect(parsedCookies[AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT]).toBeTruthy();
    expect(parsedCookies[AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT]).toBeTruthy();
    const loginBody = parseJsonBody<{
      data: {
        accessToken: string;
        tokenType: string;
        expiresInSeconds: number;
        user: {
          userId: string;
          tenantId: string;
          role: string;
        };
      };
    }>(loginResponse);
    expect(typeof loginBody.data.accessToken).toBe("string");
    expect(loginBody.data.accessToken.length).toBeGreaterThan(0);
    expect(loginBody.data.tokenType).toBe("Bearer");
    expect(loginBody.data.expiresInSeconds).toBe(900);
    expect(typeof loginBody.data.user.userId).toBe("string");
    expect(loginBody.data.user.userId.length).toBeGreaterThan(0);
    expect(typeof loginBody.data.user.tenantId).toBe("string");
    expect(loginBody.data.user.tenantId.length).toBeGreaterThan(0);
    expect(loginBody.data.user.role).toBe("OWNER");

    const wrongPasswordResponse: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGIN}`,
      payload: {
        email,
        password: "WrongPass123"
      }
    });

    expect(wrongPasswordResponse.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(parseJsonBody<{ code: string; message: string }>(wrongPasswordResponse)).toEqual({
      code: AUTH_RESPONSES.CODE_INVALID_CREDENTIALS,
      message: AUTH_MESSAGES.INVALID_CREDENTIALS
    });
  });

  it("refreshes session token with valid cookie and csrf, and rejects revoked token reuse", async () => {
    const email = `owner-${randomUUID()}@example.com`;
    await registerUser(email);

    const loginResponse: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGIN}`,
      payload: {
        email,
        password: "StrongPass123"
      }
    });

    const initialCookies: CookieMap = parseSetCookieValues(extractSetCookies(loginResponse));
    const csrfToken = initialCookies[AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT];
    if (!csrfToken) {
      throw new Error("Expected CSRF token cookie from login response");
    }

    const refreshResponse: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REFRESH}`,
      headers: {
        cookie: buildSessionCookieHeader(initialCookies),
        [AUTH_COOKIES.CSRF_HEADER_NAME_DEFAULT]: csrfToken
      }
    });

    expect(refreshResponse.statusCode).toBe(AUTH_HTTP_STATUS.OK);
    const refreshBody = parseJsonBody<{
      data: {
        accessToken: string;
        tokenType: string;
        expiresInSeconds: number;
      };
    }>(refreshResponse);
    expect(typeof refreshBody.data.accessToken).toBe("string");
    expect(refreshBody.data.accessToken.length).toBeGreaterThan(0);
    expect(refreshBody.data.tokenType).toBe("Bearer");
    expect(refreshBody.data.expiresInSeconds).toBe(900);

    const reusedRefreshResponse: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REFRESH}`,
      headers: {
        cookie: buildSessionCookieHeader(initialCookies),
        [AUTH_COOKIES.CSRF_HEADER_NAME_DEFAULT]: csrfToken
      }
    });

    expect(reusedRefreshResponse.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(parseJsonBody<{ code: string; message: string }>(reusedRefreshResponse)).toEqual({
      code: AUTH_RESPONSES.CODE_REFRESH_TOKEN_INVALID,
      message: AUTH_MESSAGES.INVALID_REFRESH_TOKEN
    });
  });

  it("rejects refresh request without csrf header", async () => {
    const email = `owner-${randomUUID()}@example.com`;
    await registerUser(email);

    const loginResponse: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGIN}`,
      payload: {
        email,
        password: "StrongPass123"
      }
    });

    const sessionCookies: CookieMap = parseSetCookieValues(extractSetCookies(loginResponse));

    const response: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REFRESH}`,
      headers: {
        cookie: buildSessionCookieHeader(sessionCookies)
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(parseJsonBody<{ code: string; message: string }>(response)).toEqual({
      code: AUTH_RESPONSES.CODE_CSRF_INVALID,
      message: AUTH_MESSAGES.CSRF_INVALID
    });
  });

  it("logs out with valid cookie and csrf, then rejects the same access token", async () => {
    const email = `owner-${randomUUID()}@example.com`;
    await registerUser(email);

    const loginResponse: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGIN}`,
      payload: {
        email,
        password: "StrongPass123"
      }
    });

    const loginBody = parseJsonBody<{
      data: {
        accessToken: string;
      };
    }>(loginResponse);
    const sessionCookies: CookieMap = parseSetCookieValues(extractSetCookies(loginResponse));
    const csrfToken = sessionCookies[AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT];
    if (!csrfToken) {
      throw new Error("Expected CSRF token cookie from login response");
    }

    const logoutResponse: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGOUT}`,
      headers: {
        authorization: `Bearer ${loginBody.data.accessToken}`,
        cookie: buildSessionCookieHeader(sessionCookies),
        [AUTH_COOKIES.CSRF_HEADER_NAME_DEFAULT]: csrfToken
      }
    });

    expect(logoutResponse.statusCode).toBe(AUTH_HTTP_STATUS.NO_CONTENT);
    const clearedCookies = extractSetCookies(logoutResponse);
    const clearedRefreshCookie = clearedCookies.find((cookie) =>
      cookie.startsWith(`${AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT}=`)
    );
    expect(clearedRefreshCookie).toContain("Max-Age=0");

    const reusedAccessTokenResponse: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGOUT}`,
      headers: {
        authorization: `Bearer ${loginBody.data.accessToken}`
      }
    });

    expect(reusedAccessTokenResponse.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(parseJsonBody<{ code: string; message: string }>(reusedAccessTokenResponse)).toEqual({
      code: AUTH_RESPONSES.CODE_TOKEN_REVOKED,
      message: AUTH_MESSAGES.TOKEN_REVOKED
    });
  });

  it("rejects expired access token with TOKEN_EXPIRED", async () => {
    const secretKey = new TextEncoder().encode(TEST_ENV.JWT_SECRET);
    const expiredToken = await new SignJWT({
      tenantId: "tenant_1",
      role: "MEMBER",
      jti: `expired-${randomUUID()}`
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user_1")
      .setIssuedAt()
      .setExpirationTime("-1s")
      .sign(secretKey);

    const response: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGOUT}`,
      headers: {
        authorization: `Bearer ${expiredToken}`
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(parseJsonBody<{ code: string; message: string }>(response)).toEqual({
      code: AUTH_RESPONSES.CODE_TOKEN_EXPIRED,
      message: AUTH_MESSAGES.TOKEN_EXPIRED
    });
  });

  describe("register endpoint (T-018)", () => {
    it("registers a new user with valid input and returns 201 with userId and tenantId", async () => {
      const email = `valid-${randomUUID()}@example.com`;

      const response: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
        payload: {
          firstName: "Alice",
          lastName: "Johnson",
          email,
          password: "ValidPassword123",
          tenantName: "Test Tenant"
        }
      });

      expect(response.statusCode).toBe(AUTH_HTTP_STATUS.CREATED);
      const body = parseJsonBody<{ data: { userId: string; tenantId: string } }>(response);
      expect(body.data.userId).toBeTruthy();
      expect(body.data.tenantId).toBeTruthy();
      expect(typeof body.data.userId).toBe("string");
      expect(typeof body.data.tenantId).toBe("string");
    });

    it("sets first registrant as OWNER role", async () => {
      const email = `owner-role-${randomUUID()}@example.com`;

      const registerResponse: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
        payload: {
          firstName: "Bob",
          lastName: "Smith",
          email,
          password: "ValidPassword123",
          tenantName: "Owner Test Tenant"
        }
      });

      expect(registerResponse.statusCode).toBe(AUTH_HTTP_STATUS.CREATED);

      const loginResponse: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGIN}`,
        payload: {
          email,
          password: "ValidPassword123"
        }
      });

      expect(loginResponse.statusCode).toBe(AUTH_HTTP_STATUS.OK);
      const loginBody = parseJsonBody<{
        data: {
          user: {
            userId: string;
            tenantId: string;
            role: string;
          };
        };
      }>(loginResponse);
      expect(loginBody.data.user.role).toBe("OWNER");
    });

    it("rejects duplicate email with 409 and EMAIL_ALREADY_EXISTS code", async () => {
      const email = `duplicate-${randomUUID()}@example.com`;

      const firstRegister: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
        payload: {
          firstName: "Carol",
          lastName: "White",
          email,
          password: "ValidPassword123",
          tenantName: "First Tenant"
        }
      });

      expect(firstRegister.statusCode).toBe(AUTH_HTTP_STATUS.CREATED);

      const secondRegister: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
        payload: {
          firstName: "David",
          lastName: "Brown",
          email,
          password: "AnotherPassword123",
          tenantName: "Second Tenant"
        }
      });

      expect(secondRegister.statusCode).toBe(AUTH_HTTP_STATUS.CONFLICT);
      const body = parseJsonBody<{ code: string; message: string }>(secondRegister);
      expect(body.code).toBe(AUTH_RESPONSES.CODE_EMAIL_ALREADY_EXISTS);
    });

    it("rejects duplicate email case-insensitively with 409", async () => {
      const email = `caseinsensitive-${randomUUID()}@example.com`;

      const firstRegister: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
        payload: {
          firstName: "Eve",
          lastName: "Green",
          email: email.toUpperCase(),
          password: "ValidPassword123",
          tenantName: "Case Tenant 1"
        }
      });

      expect(firstRegister.statusCode).toBe(AUTH_HTTP_STATUS.CREATED);

      const secondRegister: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
        payload: {
          firstName: "Frank",
          lastName: "Pink",
          email: email.toLowerCase(),
          password: "AnotherPassword123",
          tenantName: "Case Tenant 2"
        }
      });

      expect(secondRegister.statusCode).toBe(AUTH_HTTP_STATUS.CONFLICT);
    });

    it("rejects invalid email format with 400", async () => {
      const response: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
        payload: {
          firstName: "Grace",
          lastName: "Red",
          email: "not-an-email",
          password: "ValidPassword123",
          tenantName: "Invalid Email Tenant"
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it("rejects password shorter than 8 characters with 400", async () => {
      const email = `shortpass-${randomUUID()}@example.com`;

      const response: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
        payload: {
          firstName: "Henry",
          lastName: "Yellow",
          email,
          password: "Short1",
          tenantName: "Short Password Tenant"
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it("rejects empty firstName with 400", async () => {
      const email = `emptyname-${randomUUID()}@example.com`;

      const response: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
        payload: {
          firstName: "",
          lastName: "Blue",
          email,
          password: "ValidPassword123",
          tenantName: "Empty Name Tenant"
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it("rejects empty lastName with 400", async () => {
      const email = `emptylast-${randomUUID()}@example.com`;

      const response: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
        payload: {
          firstName: "Iris",
          lastName: "",
          email,
          password: "ValidPassword123",
          tenantName: "Empty Last Name Tenant"
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it("rejects missing required field with 400", async () => {
      const email = `missing-${randomUUID()}@example.com`;

      const response: InjectResponse = await getApp().inject({
        method: "POST",
        url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
        payload: {
          firstName: "Jack",
          email,
          password: "ValidPassword123",
          tenantName: "Missing Field Tenant"
          // lastName is missing
        }
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
