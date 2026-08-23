import { createHash, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { env } from "../config/env";
import { AUTH_TOKENS } from "../constants";

interface AccessTokenInput {
	userId: string;
	tenantId: string;
	role: "OWNER" | "ADMIN" | "MEMBER";
}

interface AccessTokenResult {
	accessToken: string;
	expiresInSeconds: number;
}

interface RefreshTokenResult {
	refreshToken: string;
	refreshTokenHash: string;
	expiresAt: Date;
}

const jwtSecretKey = new TextEncoder().encode(env.JWT_SECRET);

export class TokenService {
	async createAccessToken(input: AccessTokenInput): Promise<AccessTokenResult> {
		const accessTtlSeconds = env.JWT_ACCESS_TTL_SECONDS ?? AUTH_TOKENS.ACCESS_TTL_SECONDS_DEFAULT;

		const accessToken = await new SignJWT({
			sub: input.userId,
			tenantId: input.tenantId,
			role: input.role,
			jti: randomBytes(16).toString("hex")
		})
			.setProtectedHeader({ alg: "HS256" })
			.setIssuedAt()
			.setExpirationTime(`${accessTtlSeconds}s`)
			.sign(jwtSecretKey);

		return {
			accessToken,
			expiresInSeconds: accessTtlSeconds
		};
	}

	createRefreshToken(): RefreshTokenResult {
		const refreshTtlSeconds =
			env.JWT_REFRESH_TTL_SECONDS ?? AUTH_TOKENS.REFRESH_TTL_SECONDS_DEFAULT;
		const refreshToken = randomBytes(32).toString("hex");
		const refreshTokenHash = createHash("sha256").update(refreshToken).digest("hex");
		const expiresAt = new Date(Date.now() + refreshTtlSeconds * 1000);

		return {
			refreshToken,
			refreshTokenHash,
			expiresAt
		};
	}
}
