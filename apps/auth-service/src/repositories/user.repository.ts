/* eslint-disable no-unused-vars */
import type { TenantId, UserId } from "@telemetry/shared-types";
import { prisma } from "../lib/prisma";

interface UserFindFirstArgs {
	where: { email: string };
	select: { id: true };
}

interface TenantCreateArgs {
	data: { name: string };
	select: { id: true };
}

interface UserCreateArgs {
	data: {
		tenantId: string;
		email: string;
		passwordHash: string;
	};
	select: { id: true };
}

interface AuthPrismaTxClient {
	tenant: {
		create: (args: TenantCreateArgs) => Promise<{ id: string }>;
	};
	user: {
		create: (args: UserCreateArgs) => Promise<{ id: string }>;
		findFirst: (args: UserFindFirstArgs) => Promise<{ id: string } | null>;
	};
}

interface AuthPrismaClient {
	user: {
		findFirst: (args: UserFindFirstArgs) => Promise<{ id: string } | null>;
	};
	$transaction: <T>(operation: (tx: AuthPrismaTxClient) => Promise<T>) => Promise<T>;
}

interface CreateUserWithTenantInput {
	email: string;
	passwordHash: string;
	tenantName: string;
}

interface RegisterResult {
	userId: UserId;
	tenantId: TenantId;
}

const isUniqueConstraintError = (error: unknown): error is { code: string } => {
	if (typeof error !== "object" || error === null) {
		return false;
	}

	const maybeCode = (error as { code?: unknown }).code;
	return typeof maybeCode === "string" && maybeCode === "P2002";
};

export class UserRepository {
	private readonly db: AuthPrismaClient;

	constructor(db: AuthPrismaClient = prisma as unknown as AuthPrismaClient) {
		this.db = db;
	}

	async createUserWithTenantIfEmailAvailable(
		input: CreateUserWithTenantInput
	): Promise<RegisterResult | null> {
		const normalizedEmail = input.email.trim().toLowerCase();

		const existing = await this.db.user.findFirst({
			where: { email: normalizedEmail },
			select: { id: true }
		});

		if (existing) {
			return null;
		}

		try {
			const created = await this.db.$transaction(async (tx) => {
				const tenant = await tx.tenant.create({
					data: {
						name: input.tenantName
					},
					select: { id: true }
				});

				const user = await tx.user.create({
					data: {
						tenantId: tenant.id,
						email: normalizedEmail,
						passwordHash: input.passwordHash
					},
					select: { id: true }
				});

				return {
					userId: user.id as UserId,
					tenantId: tenant.id as TenantId
				};
			});

			return created;
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				return null;
			}

			throw error;
		}
	}
}
