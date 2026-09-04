import type { FastifyReply, FastifyRequest } from "fastify";
import { errors as JoseErrors, jwtVerify } from "jose";
import type { TenantId, UserId } from "@telemetry/shared-types";
import type { AuthRole } from "../constants";
import { AUTH_ROLES } from "../constants";
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
	role?: AuthRole;
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

/**
 * `jwtVerify<AccessJwtPayload>` is a *shape assertion*, not validation — a signed token carrying
 * `role: "SUPERADMIN"` would otherwise reach `AuthenticatedRequestContext` typed as `AuthRole`.
 *
 * `role` is the only claim narrowed by value. `sub`, `tenantId`, `jti` and `exp` are checked for
 * presence only, so a token with `exp: "abc"` still reaches `expiresAt: number` — pre-existing,
 * and unreachable without `JWT_SECRET`, but do not read the presence check as validation.
 */
const isAuthRole = (value: unknown): value is AuthRole =>
	(Object.values(AUTH_ROLES) as unknown[]).includes(value);

const toAuthenticatedContext = (payload: AccessJwtPayload): AuthenticatedRequestContext => {
	if (!payload.sub || !payload.tenantId || !payload.jti || !payload.exp) {
		throw new InvalidTokenError();
	}

	if (!isAuthRole(payload.role)) {
		throw new InvalidTokenError();
	}

	// The brands are applied here, at the only trust boundary: the caller has already verified
	// the signature against JWT_SECRET, so both ids come from one server-signed payload and
	// cannot be mismatched. Downstream layers take `UserId` / `TenantId` and need no cast.
	return {
		userId: payload.sub as UserId,
		tenantId: payload.tenantId as TenantId,
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
