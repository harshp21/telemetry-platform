import { compare, hash } from "bcryptjs";
import type { TenantId, UserId } from "@telemetry/shared-types";
import { AUTH_SECURITY, AUTH_VALIDATION } from "../constants";
import { env } from "../config/env";
import { EmailAlreadyExistsError, InvalidCredentialsError } from "../errors";
import { UserRepository } from "../repositories/user.repository";
import { TokenService } from "./token.service";

interface RegisterInput {
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

interface LoginResult {
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
	private readonly tokenService: TokenService;

	constructor(userRepository = new UserRepository(), tokenService = new TokenService()) {
		this.userRepository = userRepository;
		this.tokenService = tokenService;
	}

	async register(input: RegisterInput): Promise<RegisterResult> {
		const bcryptRounds = env.BCRYPT_ROUNDS ?? AUTH_VALIDATION.BCRYPT_DEFAULT_ROUNDS;
		const passwordHash = await hash(input.password, bcryptRounds);
		const created = await this.userRepository.createUserWithTenantIfEmailAvailable({
			email: input.email,
			passwordHash,
			tenantName: input.tenantName
		});

		if (!created) {
			throw new EmailAlreadyExistsError();
		}

		return created;
	}

	async login(input: LoginInput): Promise<LoginResult> {
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
}
