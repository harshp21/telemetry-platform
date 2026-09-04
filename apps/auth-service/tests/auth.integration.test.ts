import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import {
  AUTH_COOKIES,
  AUTH_ROLES,
  AUTH_HTTP_STATUS,
  AUTH_MESSAGES,
  AUTH_RESPONSES,
  AUTH_ROUTES
} from "../src/constants";
import { TEST_DATABASE_URLS } from "./database-urls";

// The service under test connects as telemetry_auth_app (NOSUPERUSER, NOBYPASSRLS), so every
// assertion below is made against a connection on which RLS is actually enforcing.
//
// Fixtures are read and reset through the owner connection instead. As the runtime role,
// `user.deleteMany()` and `tenant.deleteMany()` delete zero rows and raise no error, so a
// reset issued through the service's own client would silently stop resetting -- and a
// revocation assertion made through it would pass without proving anything.

// Every address this suite creates lives under a domain unique to this run, so the fixture
// reset can be scoped to rows this file owns instead of truncating tables that
// rls.integration.test.ts may be using in a parallel worker.
const SUITE_ID = randomUUID();
const SUITE_EMAIL_DOMAIN = `@auth-integration-${SUITE_ID}.test`;

const TEST_ENV = {
  NODE_ENV: "test",
  PORT: "3001",
  DATABASE_URL: process.env.DATABASE_URL ?? TEST_DATABASE_URLS.AUTH_APP,
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
  let admin: PrismaClient | undefined;

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
    const users = await getAdmin().user.findMany({
      where: { email: { endsWith: SUITE_EMAIL_DOMAIN } },
      select: { id: true, tenantId: true }
    });
    const userIds = users.map((user) => user.id);
    const tenantIds = users.map((user) => user.tenantId);

    await getAdmin().refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await getAdmin().user.deleteMany({ where: { id: { in: userIds } } });
    await getAdmin().tenant.deleteMany({ where: { id: { in: tenantIds } } });
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

  const getAdmin = (): PrismaClient => {
    if (!admin) {
      throw new Error("Admin Prisma client is not initialized");
    }

    return admin;
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

    admin = new PrismaClient({
      datasourceUrl: process.env.DIRECT_DATABASE_URL ?? TEST_DATABASE_URLS.ADMIN,
      log: ["error"]
    });

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

    if (admin) {
      await admin.$disconnect();
    }

    const globalRedis = (globalThis as { authRedis?: RedisClientWithDisconnect }).authRedis;
    globalRedis?.disconnect?.();
    (globalThis as { authRedis?: RedisClientWithDisconnect }).authRedis = undefined;
  });

  it("registers a user and rejects duplicate email", async () => {
    const email = `owner-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;

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
    const email = `owner-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;
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
    expect(loginBody.data.user.role).toBe(AUTH_ROLES.OWNER);

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

  it("keeps the fixture reset scoped to this suite's own rows, and actually resets", async () => {
    // The reset no longer truncates the tables; it deletes only rows whose e-mail ends with
    // this run's domain. That predicate is itself capable of silently matching nothing --
    // every test uses a random address, so a reset that deleted zero rows would leave the
    // suite green. Prove both halves: the predicate finds what this suite creates, and the
    // reset removes it.
    const email = `reset-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;
    await registerUser(email);

    const beforeReset = await getAdmin().user.count({
      where: { email: { endsWith: SUITE_EMAIL_DOMAIN } }
    });
    expect(beforeReset).toBeGreaterThan(0);

    await resetAuthState();

    const afterReset = await getAdmin().user.count({
      where: { email: { endsWith: SUITE_EMAIL_DOMAIN } }
    });
    expect(afterReset).toBe(0);
  });

  it("rejects login for an unknown email with 401, not 500", async () => {
    // The pre-tenant e-mail resolver returns NULL for an address that does not exist. That
    // must degrade to the ordinary invalid-credentials answer -- same code, same message as a
    // wrong password -- and must not surface as a database error.
    const response: InjectResponse = await getApp().inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.LOGIN}`,
      payload: {
        email: `unknown-${randomUUID()}${SUITE_EMAIL_DOMAIN}`,
        password: "StrongPass123"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.UNAUTHORIZED);
    expect(parseJsonBody<{ code: string; message: string }>(response)).toEqual({
      code: AUTH_RESPONSES.CODE_INVALID_CREDENTIALS,
      message: AUTH_MESSAGES.INVALID_CREDENTIALS
    });
  });

  it("refreshes session token with valid cookie and csrf, and rejects revoked token reuse", async () => {
    const email = `owner-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;
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
    const email = `owner-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;
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
    const email = `owner-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;
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
        user: { userId: string };
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

    // Non-tautological half. "RefreshToken" has RLS FORCEd but never ENABLEd (S-10), so a
    // tenant-context wrapper that never fires still returns 204 -- the HTTP response proves
    // nothing about the database. Read the rows back through the owner connection instead.
    const storedTokens = await getAdmin().refreshToken.findMany({
      where: { userId: loginBody.data.user.userId },
      select: { revokedAt: true }
    });

    expect(storedTokens.length).toBeGreaterThan(0);
    expect(storedTokens.every((token) => token.revokedAt !== null)).toBe(true);
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
      const email = `valid-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;

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

      // The tenant id is generated application-side and set as `app.tenant_id` before the
      // INSERT, because `tenant_self_insert` checks the id being written against the context.
      // Reading the row back through the owner connection proves the echoed id is the id the
      // database actually stored, not one the response invented.
      const storedTenant = await getAdmin().tenant.findUnique({
        where: { id: body.data.tenantId },
        select: { id: true }
      });
      const storedUser = await getAdmin().user.findUnique({
        where: { id: body.data.userId },
        select: { tenantId: true }
      });

      expect(storedTenant?.id).toBe(body.data.tenantId);
      expect(storedUser?.tenantId).toBe(body.data.tenantId);
    });

    it("sets first registrant as OWNER role", async () => {
      const email = `owner-role-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;

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
      expect(loginBody.data.user.role).toBe(AUTH_ROLES.OWNER);
    });

    it("rejects duplicate email with 409 and EMAIL_ALREADY_EXISTS code", async () => {
      const email = `duplicate-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;

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
      const email = `caseinsensitive-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;

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

      expect(response.statusCode).toBe(AUTH_HTTP_STATUS.BAD_REQUEST);
    });

    it("rejects password shorter than 8 characters with 400", async () => {
      const email = `shortpass-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;

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

      expect(response.statusCode).toBe(AUTH_HTTP_STATUS.BAD_REQUEST);
    });

    it("rejects empty firstName with 400", async () => {
      const email = `emptyname-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;

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

      expect(response.statusCode).toBe(AUTH_HTTP_STATUS.BAD_REQUEST);
    });

    it("rejects empty lastName with 400", async () => {
      const email = `emptylast-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;

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

      expect(response.statusCode).toBe(AUTH_HTTP_STATUS.BAD_REQUEST);
    });

    it("rejects missing required field with 400", async () => {
      const email = `missing-${randomUUID()}${SUITE_EMAIL_DOMAIN}`;

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

      expect(response.statusCode).toBe(AUTH_HTTP_STATUS.BAD_REQUEST);
    });
  });
});
