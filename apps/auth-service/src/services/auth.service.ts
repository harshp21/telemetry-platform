import { compare, hash } from "bcryptjs";
import type { TenantId, UserId } from "@telemetry/shared-types";
import { AUTH_SECURITY, AUTH_VALIDATION } from "../constants";
import { env } from "../config/env";
import {
	EmailAlreadyExistsError,
	InvalidCredentialsError,
	InvalidRefreshTokenError
} from "../errors";
import type { AuthenticatedRequestContext } from "../plugins";
import { UserRepository } from "../repositories/user.repository";
import { TokenDenylistService } from "./token-denylist.service";
import { TokenService } from "./token.service";

interface RegisterInput {
	firstName: string;
	lastName: string;
	email: string;
	password: string;
	tenantName: string;
}

interface RegisterResult {
	userId: UserId;
	tenantId: TenantId;
}

interface LoginInput {
	email: string;
	password: string;
}

interface RefreshInput {
	refreshToken: string;
}

interface AuthSessionResult {
	accessToken: string;
	refreshToken: string;
	tokenType: "Bearer";
	expiresInSeconds: number;
	user: {
		userId: UserId;
		tenantId: TenantId;
		role: "OWNER" | "ADMIN" | "MEMBER";
	};
}

export class AuthService {
	private readonly userRepository: UserRepository;
	private readonly tokenDenylistService: TokenDenylistService;
	private readonly tokenService: TokenService;

	constructor(
		userRepository = new UserRepository(),
		tokenService = new TokenService(),
		tokenDenylistService = new TokenDenylistService()
	) {
		this.userRepository = userRepository;
		this.tokenService = tokenService;
		this.tokenDenylistService = tokenDenylistService;
	}

	async register(input: RegisterInput): Promise<RegisterResult> {
		const bcryptRounds = env.BCRYPT_ROUNDS ?? AUTH_VALIDATION.BCRYPT_DEFAULT_ROUNDS;
		const passwordHash = await hash(input.password, bcryptRounds);
		const created = await this.userRepository.createUserWithTenantIfEmailAvailable({
			firstName: input.firstName,
			lastName: input.lastName,
			email: input.email,
			passwordHash,
			tenantName: input.tenantName
		});

		if (!created) {
			throw new EmailAlreadyExistsError();
		}

		return created;
	}

	async login(input: LoginInput): Promise<AuthSessionResult> {
		const user = await this.userRepository.findUserForLogin(input.email);
		const passwordHashForCheck = user?.passwordHash ?? AUTH_SECURITY.DUMMY_PASSWORD_HASH;
		const passwordMatches = await compare(input.password, passwordHashForCheck);

		if (!user || !passwordMatches) {
			throw new InvalidCredentialsError();
		}

		const accessTokenResult = await this.tokenService.createAccessToken({
			userId: user.userId,
			tenantId: user.tenantId,
			role: user.role
		});
		const refreshTokenResult = this.tokenService.createRefreshToken();

		await this.userRepository.storeRefreshToken({
			userId: user.userId,
			refreshTokenHash: refreshTokenResult.refreshTokenHash,
			expiresAt: refreshTokenResult.expiresAt
		});

		return {
			accessToken: accessTokenResult.accessToken,
			refreshToken: refreshTokenResult.refreshToken,
			tokenType: "Bearer",
			expiresInSeconds: accessTokenResult.expiresInSeconds,
			user: {
				userId: user.userId,
				tenantId: user.tenantId,
				role: user.role
			}
		};
	}

	async refresh(input: RefreshInput): Promise<AuthSessionResult> {
		const refreshTokenHash = this.tokenService.hashRefreshToken(input.refreshToken);
		const currentRefreshToken =
			await this.userRepository.findRefreshTokenForRotation(refreshTokenHash);

		if (
			!currentRefreshToken ||
			currentRefreshToken.revokedAt !== null ||
			currentRefreshToken.expiresAt.getTime() <= Date.now()
		) {
			throw new InvalidRefreshTokenError();
		}

		const accessTokenResult = await this.tokenService.createAccessToken({
			userId: currentRefreshToken.userId,
			tenantId: currentRefreshToken.tenantId,
			role: currentRefreshToken.role
		});
		const newRefreshTokenResult = this.tokenService.createRefreshToken();

		await this.userRepository.rotateRefreshToken({
			currentRefreshTokenId: currentRefreshToken.refreshTokenId,
			userId: currentRefreshToken.userId,
			newRefreshTokenHash: newRefreshTokenResult.refreshTokenHash,
			newExpiresAt: newRefreshTokenResult.expiresAt
		});

		return {
			accessToken: accessTokenResult.accessToken,
			refreshToken: newRefreshTokenResult.refreshToken,
			tokenType: "Bearer",
			expiresInSeconds: accessTokenResult.expiresInSeconds,
			user: {
				userId: currentRefreshToken.userId,
				tenantId: currentRefreshToken.tenantId,
				role: currentRefreshToken.role
			}
		};
	}

	async logout(input: AuthenticatedRequestContext): Promise<void> {
		const ttlSeconds = Math.max(1, input.expiresAt - Math.floor(Date.now() / 1000));

		await this.tokenDenylistService.denylistTokenJti(input.jti, ttlSeconds);
		await this.userRepository.revokeActiveRefreshTokens(input.userId as UserId);
	}
}
