import { hash } from "bcryptjs";
import type { TenantId, UserId } from "@telemetry/shared-types";
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
	const parsed = Number.parseInt(process.env.BCRYPT_ROUNDS ?? "12", 10);

	if (Number.isInteger(parsed) && parsed >= 10 && parsed <= 14) {
		return parsed;
	}

	return 12;
};

export class AuthService {
	private readonly userRepository: UserRepository;

	constructor(userRepository = new UserRepository()) {
		this.userRepository = userRepository;
	}

	async register(input: RegisterInput): Promise<RegisterResult> {
		const existingUser = await this.userRepository.findByEmail(input.email);

		if (existingUser) {
			throw new EmailAlreadyExistsError();
		}

		const passwordHash = await hash(input.password, resolveBcryptRounds());

		return this.userRepository.createUserWithTenant({
			email: input.email,
			passwordHash,
			tenantName: input.tenantName
		});
	}
}
