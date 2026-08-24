import type { FastifyReply, FastifyRequest } from "fastify";
import { errors as JoseErrors, jwtVerify } from "jose";
import {
	ExpiredTokenError,
	InvalidTokenError,
	MissingOrMalformedTokenError,
	RevokedTokenError
} from "../errors";
import { TokenDenylistService } from "../services/token-denylist.service";
import type { AuthenticatedRequestContext } from "./index";

interface AccessJwtPayload {
	sub?: string;
	tenantId?: string;
	role?: "OWNER" | "ADMIN" | "MEMBER";
	jti?: string;
	exp?: number;
}

let denylistService: TokenDenylistService | undefined;

const getDenylistService = (): TokenDenylistService => {
	denylistService ??= new TokenDenylistService();

	return denylistService;
};

const getJwtSecretKey = (): Uint8Array => {
	const jwtSecret = process.env.JWT_SECRET;
	if (!jwtSecret) {
		throw new InvalidTokenError();
	}

	return new TextEncoder().encode(jwtSecret);
};

const extractBearerToken = (authorizationHeader: string | undefined): string => {
	if (!authorizationHeader) {
		throw new MissingOrMalformedTokenError();
	}

	const [scheme, token] = authorizationHeader.split(" ");
	if (scheme !== "Bearer" || !token) {
		throw new MissingOrMalformedTokenError();
	}

	return token;
};

const toAuthenticatedContext = (payload: AccessJwtPayload): AuthenticatedRequestContext => {
	if (!payload.sub || !payload.tenantId || !payload.role || !payload.jti || !payload.exp) {
		throw new InvalidTokenError();
	}

	return {
		userId: payload.sub,
		tenantId: payload.tenantId,
		role: payload.role,
		jti: payload.jti,
		expiresAt: payload.exp
	};
};

const normalizeJwtError = (error: unknown): never => {
	if (error instanceof JoseErrors.JWTExpired) {
		throw new ExpiredTokenError();
	}

	throw new InvalidTokenError();
};

const verifyAccessToken = async (token: string): Promise<AccessJwtPayload> => {
	try {
		const verified = await jwtVerify<AccessJwtPayload>(token, getJwtSecretKey());

		return verified.payload;
	} catch (error: unknown) {
		normalizeJwtError(error);
		throw new InvalidTokenError();
	}
};

export const requireJwtAuth = async (
	request: FastifyRequest,
	_reply: FastifyReply
): Promise<void> => {
	void _reply;
	const token = extractBearerToken(request.headers.authorization);
	const verifiedPayload = await verifyAccessToken(token);

	const authContext = toAuthenticatedContext(verifiedPayload);
	const isDenylisted = await getDenylistService().isTokenJtiDenylisted(authContext.jti);
	if (isDenylisted) {
		throw new RevokedTokenError();
	}

	request.auth = authContext;
};
