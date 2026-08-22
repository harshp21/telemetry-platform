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
		create: (...params: [TenantCreateArgs]) => Promise<{ id: string }>;
	};
	user: {
		create: (...params: [UserCreateArgs]) => Promise<{ id: string }>;
		findFirst: (...params: [UserFindFirstArgs]) => Promise<{ id: string } | null>;
	};
}

interface AuthPrismaClient {
	user: {
		findFirst: (...params: [UserFindFirstArgs]) => Promise<{ id: string } | null>;
	};
	$transaction: <T>(...params: [(tx: AuthPrismaTxClient) => Promise<T>]) => Promise<T>;
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

export class UserRepository {
	private readonly db: AuthPrismaClient;

	constructor(db: AuthPrismaClient = prisma as unknown as AuthPrismaClient) {
		this.db = db;
	}

	async createUserWithTenantIfEmailAvailable(
		input: CreateUserWithTenantInput
	): Promise<RegisterResult | null> {
		const normalizedEmail = input.email.trim().toLowerCase();

		const created = await this.db.$transaction(async (tx) => {
			const existing = await tx.user.findFirst({
				where: { email: normalizedEmail },
				select: { id: true }
			});

			if (existing) {
				return null;
			}

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
	}
}
