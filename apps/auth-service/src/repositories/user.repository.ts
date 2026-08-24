/* eslint-disable no-unused-vars */
import type { TenantId, UserId } from "@telemetry/shared-types";
import { prisma } from "../lib/prisma";

interface UserFindFirstArgs {
	where: { email: string };
	select: { id: true };
}

interface UserFindUniqueLoginArgs {
	where: { email: string };
	select: {
		id: true;
		tenantId: true;
		passwordHash: true;
		role: true;
	};
}

interface RefreshTokenCreateArgs {
	data: {
		userId: string;
		tokenHash: string;
		expiresAt: Date;
	};
}

interface RefreshTokenFindUniqueArgs {
	where: { tokenHash: string };
	select: {
		id: true;
		expiresAt: true;
		revokedAt: true;
		user: {
			select: {
				id: true;
				tenantId: true;
				role: true;
			};
		};
	};
}

interface RefreshTokenUpdateArgs {
	where: { id: string };
	data: { revokedAt: Date };
	select?: { id: true };
}

interface RefreshTokenUpdateManyArgs {
	where: {
		userId: string;
		revokedAt: null;
	};
	data: { revokedAt: Date };
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
	refreshToken: {
		create: (args: RefreshTokenCreateArgs) => Promise<{ id: string }>;
		update: (args: RefreshTokenUpdateArgs) => Promise<{ id: string }>;
		updateMany: (args: RefreshTokenUpdateManyArgs) => Promise<{ count: number }>;
	};
}

interface AuthPrismaClient {
	user: {
		findFirst: (args: UserFindFirstArgs) => Promise<{ id: string } | null>;
		findUnique: (args: UserFindUniqueLoginArgs) => Promise<{
			id: string;
			tenantId: string;
			passwordHash: string;
			role: "OWNER" | "ADMIN" | "MEMBER";
		} | null>;
	};
	refreshToken: {
		create: (args: RefreshTokenCreateArgs) => Promise<{ id: string }>;
		findUnique: (args: RefreshTokenFindUniqueArgs) => Promise<{
			id: string;
			expiresAt: Date;
			revokedAt: Date | null;
			user: {
				id: string;
				tenantId: string;
				role: "OWNER" | "ADMIN" | "MEMBER";
			};
		} | null>;
		updateMany: (args: RefreshTokenUpdateManyArgs) => Promise<{ count: number }>;
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

interface LoginUser {
	userId: UserId;
	tenantId: TenantId;
	passwordHash: string;
	role: "OWNER" | "ADMIN" | "MEMBER";
}

interface RefreshTokenRecord {
	refreshTokenId: string;
	userId: UserId;
	tenantId: TenantId;
	role: "OWNER" | "ADMIN" | "MEMBER";
	expiresAt: Date;
	revokedAt: Date | null;
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

	async findUserForLogin(email: string): Promise<LoginUser | null> {
		const normalizedEmail = email.trim().toLowerCase();
		const user = await this.db.user.findUnique({
			where: { email: normalizedEmail },
			select: {
				id: true,
				tenantId: true,
				passwordHash: true,
				role: true
			}
		});

		if (!user) {
			return null;
		}

		return {
			userId: user.id as UserId,
			tenantId: user.tenantId as TenantId,
			passwordHash: user.passwordHash,
			role: user.role
		};
	}

	async storeRefreshToken(input: {
		userId: UserId;
		refreshTokenHash: string;
		expiresAt: Date;
	}): Promise<void> {
		await this.db.refreshToken.create({
			data: {
				userId: input.userId,
				tokenHash: input.refreshTokenHash,
				expiresAt: input.expiresAt
			}
		});
	}

	async findRefreshTokenForRotation(tokenHash: string): Promise<RefreshTokenRecord | null> {
		const refreshToken = await this.db.refreshToken.findUnique({
			where: { tokenHash },
			select: {
				id: true,
				expiresAt: true,
				revokedAt: true,
				user: {
					select: {
						id: true,
						tenantId: true,
						role: true
					}
				}
			}
		});

		if (!refreshToken) {
			return null;
		}

		return {
			refreshTokenId: refreshToken.id,
			userId: refreshToken.user.id as UserId,
			tenantId: refreshToken.user.tenantId as TenantId,
			role: refreshToken.user.role,
			expiresAt: refreshToken.expiresAt,
			revokedAt: refreshToken.revokedAt
		};
	}

	async rotateRefreshToken(input: {
		currentRefreshTokenId: string;
		userId: UserId;
		newRefreshTokenHash: string;
		newExpiresAt: Date;
	}): Promise<void> {
		await this.db.$transaction(async (tx) => {
			await tx.refreshToken.update({
				where: { id: input.currentRefreshTokenId },
				data: { revokedAt: new Date() },
				select: { id: true }
			});

			await tx.refreshToken.create({
				data: {
					userId: input.userId,
					tokenHash: input.newRefreshTokenHash,
					expiresAt: input.newExpiresAt
				}
			});
		});
	}

	async revokeActiveRefreshTokens(userId: UserId): Promise<void> {
		await this.db.refreshToken.updateMany({
			where: {
				userId,
				revokedAt: null
			},
			data: {
				revokedAt: new Date()
			}
		});
	}
}
