import { hash } from "bcryptjs";
import type { TenantId, UserId } from "@telemetry/shared-types";
import { AUTH_VALIDATION } from "../constants";
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

const resolveBcryptRounds = (): number => {
	const parsed = Number.parseInt(
		process.env.BCRYPT_ROUNDS ?? String(AUTH_VALIDATION.BCRYPT_DEFAULT_ROUNDS),
		10
	);

	if (
		Number.isInteger(parsed) &&
		parsed >= AUTH_VALIDATION.BCRYPT_MIN_ROUNDS &&
		parsed <= AUTH_VALIDATION.BCRYPT_MAX_ROUNDS
	) {
		return parsed;
	}

	return AUTH_VALIDATION.BCRYPT_DEFAULT_ROUNDS;
};

export class AuthService {
	private readonly userRepository: UserRepository;

	constructor(userRepository = new UserRepository()) {
		this.userRepository = userRepository;
	}

	async register(input: RegisterInput): Promise<RegisterResult> {
		const passwordHash = await hash(input.password, resolveBcryptRounds());
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
