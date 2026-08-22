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
		create(args: TenantCreateArgs): Promise<{ id: string }>;
	};
	user: {
		create(args: UserCreateArgs): Promise<{ id: string }>;
	};
}

interface AuthPrismaClient {
	user: {
		findFirst(args: UserFindFirstArgs): Promise<{ id: string } | null>;
	};
	$transaction<T>(fn: (tx: AuthPrismaTxClient) => Promise<T>): Promise<T>;
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
	constructor(private readonly db: AuthPrismaClient = prisma as unknown as AuthPrismaClient) {}

	findByEmail(email: string): Promise<{ id: UserId } | null> {
		return this.db.user.findFirst({
			where: { email },
			select: { id: true }
		}) as Promise<{ id: UserId } | null>;
	}

	async createUserWithTenant(input: CreateUserWithTenantInput): Promise<RegisterResult> {
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
					email: input.email,
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
