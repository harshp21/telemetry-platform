import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AUTH_COOKIES } from "../src/constants";
import { CsrfValidationError, InvalidRefreshTokenError } from "../src/errors";
import {
  clearSessionCookies,
  getRefreshTokenFromCookie,
  setSessionCookies,
  validateCsrfToken
} from "../src/utils/session-cookie";

interface ReplyDouble {
  headers: Record<string, string | string[] | undefined>;
  getHeader: FastifyReply["getHeader"];
  header: FastifyReply["header"];
}

const createReplyDouble = (): ReplyDouble => {
  const headers: Record<string, string | string[] | undefined> = {};
  let reply: ReplyDouble;

  reply = {
    headers,
    getHeader: (name: string) => headers[name],
    header: (name: string, value: string | string[]) => {
      headers[name] = value;
      return reply as unknown as FastifyReply;
    }
  };

  return reply;
};

const createRequestDouble = (cookie?: string, csrfHeader?: string): FastifyRequest => {
  const headers: Record<string, string> = {};

  if (cookie) {
    headers.cookie = cookie;
  }
  if (csrfHeader) {
    headers[AUTH_COOKIES.CSRF_HEADER_NAME_DEFAULT] = csrfHeader;
  }

  return {
    headers
  } as unknown as FastifyRequest;
};

describe("session-cookie utils unit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.NODE_ENV = "test";
    process.env.AUTH_COOKIE_SECURE = "false";
    process.env.AUTH_COOKIE_SAME_SITE = "Lax";
    delete process.env.AUTH_COOKIE_DOMAIN;
    delete process.env.AUTH_REFRESH_COOKIE_NAME;
    delete process.env.AUTH_CSRF_COOKIE_NAME;
    delete process.env.AUTH_CSRF_HEADER_NAME;
    delete process.env.AUTH_COOKIE_PATH;
  });

  it("setSessionCookies appends refresh and csrf cookies", () => {
    const reply = createReplyDouble();

    setSessionCookies(reply as unknown as FastifyReply, "refresh_abc", 900);

    const setCookie = reply.headers["Set-Cookie"];
    expect(Array.isArray(setCookie)).toBe(true);
    const values = setCookie as string[];

    expect(values).toHaveLength(2);
    expect(values[0]).toContain(`${AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT}=refresh_abc`);
    expect(values[0]).toContain("HttpOnly");
    expect(values[0]).toContain("Max-Age=900");
    expect(values[1]).toContain(`${AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT}=`);
    expect(values[1]).toContain("Max-Age=900");
    expect(values[1]).not.toContain("HttpOnly");
  });

  it("clearSessionCookies sets both cookies with Max-Age=0", () => {
    const reply = createReplyDouble();

    clearSessionCookies(reply as unknown as FastifyReply);

    const setCookie = reply.headers["Set-Cookie"];
    expect(Array.isArray(setCookie)).toBe(true);
    const values = setCookie as string[];

    expect(values).toHaveLength(2);
    expect(values[0]).toContain(`${AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT}=`);
    expect(values[0]).toContain("Max-Age=0");
    expect(values[1]).toContain(`${AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT}=`);
    expect(values[1]).toContain("Max-Age=0");
  });

  it("getRefreshTokenFromCookie reads refresh token and throws when missing", () => {
    const request = createRequestDouble(`${AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT}=refresh_123`);

    expect(getRefreshTokenFromCookie(request)).toBe("refresh_123");

    const missingRequest = createRequestDouble();
    expect(() => getRefreshTokenFromCookie(missingRequest)).toThrow(InvalidRefreshTokenError);
  });

  it("validateCsrfToken accepts matching cookie/header and rejects mismatch", () => {
    const validRequest = createRequestDouble(
      `${AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT}=csrf_123`,
      "csrf_123"
    );

    expect(() => validateCsrfToken(validRequest)).not.toThrow();

    const mismatchedRequest = createRequestDouble(
      `${AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT}=csrf_cookie`,
      "csrf_header"
    );
    expect(() => validateCsrfToken(mismatchedRequest)).toThrow(CsrfValidationError);

    const missingHeaderRequest = createRequestDouble(
      `${AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT}=csrf_cookie`
    );
    expect(() => validateCsrfToken(missingHeaderRequest)).toThrow(CsrfValidationError);
  });
});
