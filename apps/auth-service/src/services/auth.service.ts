import { hash } from "bcryptjs";
import type { TenantId, UserId } from "@telemetry/shared-types";
import { AUTH_VALIDATION } from "../constants";
import { env } from "../config/env";
import { EmailAlreadyExistsError } from "../errors";
import { UserRepository } from "../repositories/user.repository";

interface RegisterInput {
	email: string;
	password: string;
	tenantName: string;
}

interface RegisterResult {
	userId: UserId;
	tenantId: TenantId;
}

export class AuthService {
	private readonly userRepository: UserRepository;

	constructor(userRepository = new UserRepository()) {
		this.userRepository = userRepository;
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
}
