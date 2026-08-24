import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AUTH_COOKIES } from "../constants";
import { CsrfValidationError, InvalidRefreshTokenError } from "../errors";

interface SessionCookieConfig {
	refreshCookieName: string;
	csrfCookieName: string;
	csrfHeaderName: string;
	cookiePath: string;
	sameSite: "Strict" | "Lax" | "None";
	secure: boolean;
	domain?: string;
}

const parseSameSite = (value: string | undefined): "Strict" | "Lax" | "None" => {
	if (value === "Strict" || value === "Lax" || value === "None") {
		return value;
	}

	return AUTH_COOKIES.SAME_SITE_DEFAULT;
};

const getSessionCookieConfig = (): SessionCookieConfig => {
	const nodeEnv = process.env.NODE_ENV;
	const secureByDefault = nodeEnv === "production";
	const secureOverride = process.env.AUTH_COOKIE_SECURE;

	return {
		refreshCookieName:
			process.env.AUTH_REFRESH_COOKIE_NAME ?? AUTH_COOKIES.REFRESH_COOKIE_NAME_DEFAULT,
		csrfCookieName: process.env.AUTH_CSRF_COOKIE_NAME ?? AUTH_COOKIES.CSRF_COOKIE_NAME_DEFAULT,
		csrfHeaderName:
			process.env.AUTH_CSRF_HEADER_NAME ?? AUTH_COOKIES.CSRF_HEADER_NAME_DEFAULT,
		cookiePath: process.env.AUTH_COOKIE_PATH ?? AUTH_COOKIES.COOKIE_PATH_DEFAULT,
		sameSite: parseSameSite(process.env.AUTH_COOKIE_SAME_SITE),
		secure: secureOverride ? secureOverride === "true" : secureByDefault,
		domain: process.env.AUTH_COOKIE_DOMAIN
	};
};

const parseCookies = (cookieHeader: string | undefined): Record<string, string> => {
	if (!cookieHeader) {
		return {};
	}

	return cookieHeader
		.split(";")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.reduce<Record<string, string>>((cookies, entry) => {
			const separatorIndex = entry.indexOf("=");
			if (separatorIndex <= 0) {
				return cookies;
			}

			const key = entry.slice(0, separatorIndex).trim();
			const value = entry.slice(separatorIndex + 1).trim();
			cookies[key] = decodeURIComponent(value);

			return cookies;
		}, {});
};

const serializeCookie = (
	name: string,
	value: string,
	options: {
		path: string;
		sameSite: "Strict" | "Lax" | "None";
		secure: boolean;
		httpOnly: boolean;
		maxAgeSeconds?: number;
		domain?: string;
	}
): string => {
	const cookieParts: string[] = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`];

	if (typeof options.maxAgeSeconds === "number") {
		cookieParts.push(`Max-Age=${options.maxAgeSeconds}`);
	}
	if (options.httpOnly) {
		cookieParts.push("HttpOnly");
	}
	if (options.secure) {
		cookieParts.push("Secure");
	}
	cookieParts.push(`SameSite=${options.sameSite}`);
	if (options.domain) {
		cookieParts.push(`Domain=${options.domain}`);
	}

	return cookieParts.join("; ");
};

const appendSetCookieHeader = (reply: FastifyReply, cookieValue: string): void => {
	const existing = reply.getHeader("Set-Cookie");
	if (!existing) {
		reply.header("Set-Cookie", cookieValue);
		return;
	}

	if (Array.isArray(existing)) {
		reply.header("Set-Cookie", [...existing.map(String), cookieValue]);
		return;
	}

	reply.header("Set-Cookie", [String(existing), cookieValue]);
};

const getCsrfTokenFromCookie = (request: FastifyRequest): string | undefined => {
	const config = getSessionCookieConfig();
	const cookies = parseCookies(request.headers.cookie);

	return cookies[config.csrfCookieName];
};

const getCsrfTokenFromHeader = (request: FastifyRequest): string | undefined => {
	const config = getSessionCookieConfig();
	const headerValue = request.headers[config.csrfHeaderName.toLowerCase()];

	if (typeof headerValue === "string") {
		return headerValue;
	}

	if (Array.isArray(headerValue)) {
		return headerValue[0];
	}

	return undefined;
};

export const setSessionCookies = (
	reply: FastifyReply,
	refreshToken: string,
	refreshMaxAgeSeconds: number
): void => {
	const config = getSessionCookieConfig();
	const csrfToken = randomBytes(24).toString("hex");

	appendSetCookieHeader(
		reply,
		serializeCookie(config.refreshCookieName, refreshToken, {
			path: config.cookiePath,
			sameSite: config.sameSite,
			secure: config.secure,
			httpOnly: true,
			maxAgeSeconds: refreshMaxAgeSeconds,
			domain: config.domain
		})
	);
	appendSetCookieHeader(
		reply,
		serializeCookie(config.csrfCookieName, csrfToken, {
			path: config.cookiePath,
			sameSite: config.sameSite,
			secure: config.secure,
			httpOnly: false,
			maxAgeSeconds: refreshMaxAgeSeconds,
			domain: config.domain
		})
	);
};

export const clearSessionCookies = (reply: FastifyReply): void => {
	const config = getSessionCookieConfig();

	appendSetCookieHeader(
		reply,
		serializeCookie(config.refreshCookieName, "", {
			path: config.cookiePath,
			sameSite: config.sameSite,
			secure: config.secure,
			httpOnly: true,
			maxAgeSeconds: AUTH_COOKIES.CLEAR_COOKIE_MAX_AGE_SECONDS,
			domain: config.domain
		})
	);
	appendSetCookieHeader(
		reply,
		serializeCookie(config.csrfCookieName, "", {
			path: config.cookiePath,
			sameSite: config.sameSite,
			secure: config.secure,
			httpOnly: false,
			maxAgeSeconds: AUTH_COOKIES.CLEAR_COOKIE_MAX_AGE_SECONDS,
			domain: config.domain
		})
	);
};

export const getRefreshTokenFromCookie = (request: FastifyRequest): string => {
	const config = getSessionCookieConfig();
	const cookies = parseCookies(request.headers.cookie);
	const refreshToken = cookies[config.refreshCookieName];

	if (!refreshToken) {
		throw new InvalidRefreshTokenError();
	}

	return refreshToken;
};

export const validateCsrfToken = (request: FastifyRequest): void => {
	const csrfTokenFromCookie = getCsrfTokenFromCookie(request);
	const csrfTokenFromHeader = getCsrfTokenFromHeader(request);

	if (!csrfTokenFromCookie || !csrfTokenFromHeader || csrfTokenFromCookie !== csrfTokenFromHeader) {
		throw new CsrfValidationError();
	}
};
