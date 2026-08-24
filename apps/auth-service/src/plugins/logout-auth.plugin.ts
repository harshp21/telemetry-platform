import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import { UnauthorizedError } from "../errors";
import type { AuthenticatedRequestContext } from "./index";

const getJwtSecretKey = (): Uint8Array => {
	const jwtSecret = process.env.JWT_SECRET;
	if (!jwtSecret) {
		throw new UnauthorizedError();
	}

	return new TextEncoder().encode(jwtSecret);
};

interface LogoutJwtPayload {
	sub?: string;
	tenantId?: string;
	role?: "OWNER" | "ADMIN" | "MEMBER";
	jti?: string;
	exp?: number;
}

const extractBearerToken = (authorizationHeader: string | undefined): string => {
	if (!authorizationHeader) {
		throw new UnauthorizedError();
	}

	const [scheme, token] = authorizationHeader.split(" ");
	if (scheme !== "Bearer" || !token) {
		throw new UnauthorizedError();
	}

	return token;
};

const toAuthenticatedContext = (payload: LogoutJwtPayload): AuthenticatedRequestContext => {
	if (!payload.sub || !payload.tenantId || !payload.role || !payload.jti || !payload.exp) {
		throw new UnauthorizedError();
	}

	return {
		userId: payload.sub,
		tenantId: payload.tenantId,
		role: payload.role,
		jti: payload.jti,
		expiresAt: payload.exp
	};
};

export const requireLogoutAuth = async (
	request: FastifyRequest,
	_reply: FastifyReply
): Promise<void> => {
	void _reply;
	const token = extractBearerToken(request.headers.authorization);
	const verified = await jwtVerify<LogoutJwtPayload>(token, getJwtSecretKey());
	request.auth = toAuthenticatedContext(verified.payload);
};
