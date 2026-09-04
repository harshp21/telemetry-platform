import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { TenantId, UserId } from "@telemetry/shared-types";
import type { AuthRole } from "../constants";
import { AUTH_DATABASE, AUTH_ROLES, AUTH_TENANT_DEFAULTS } from "../constants";
import { prisma } from "../lib/prisma";

/**
 * The two identifiers below are the only non-parameterised parts of any SQL in this file.
 * They are frozen module constants that never derive from caller input, which is the one
 * case `Prisma.raw` is permitted for (see "Raw SQL" in CLAUDE.md). Every value — e-mail
 * address, token hash, tenant id — is a bound parameter.
 */
const RESOLVER_FUNCTIONS = Object.freeze({
	tenantByEmail: Prisma.raw(AUTH_DATABASE.RESOLVE_TENANT_BY_EMAIL_FN),
	tenantByRefreshTokenHash: Prisma.raw(
		AUTH_DATABASE.RESOLVE_TENANT_BY_REFRESH_TOKEN_HASH_FN
	)
});

interface TenantResolutionRow {
	tenantId: unknown;
}

interface UserFindFirstLoginArgs {
	where: { email: string; tenantId: string };
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

interface RefreshTokenFindFirstArgs {
	where: {
		tokenHash: string;
		user: { tenantId: string };
	};
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

/**
 * `"RefreshToken"` has no `tenantId` column, but Prisma's `user` relation filter is accepted
 * on both `RefreshTokenWhereUniqueInput` and `RefreshTokenWhereInput` and compiles to a real
 * `EXISTS (SELECT … FROM "User" WHERE "tenantId" = $n AND …)` predicate. `tenantId` is
 * therefore **required** here, not optional: it is the only tenant control these two writes
 * have while RLS is still inert on that table (S-10).
 */
interface RefreshTokenUpdateArgs {
	where: { id: string; user: { tenantId: string } };
	data: { revokedAt: Date };
	select?: { id: true };
}

interface RefreshTokenUpdateManyArgs {
	where: {
		userId: string;
		revokedAt: null;
		user: { tenantId: string };
	};
	data: { revokedAt: Date };
}

interface TenantCreateArgs {
	data: { id: string; name: string; plan?: string; timezone?: string };
	select: { id: true };
}

interface UserCreateArgs {
	data: {
		tenantId: string;
		firstName: string;
		lastName: string;
		email: string;
		passwordHash: string;
		role?: string;
	};
	select: { id: true };
}

/**
 * The transaction client. Every table access in this repository goes through it, because
 * every table access must happen inside a transaction that has already set `app.tenant_id`.
 */
interface AuthPrismaTxClient {
	tenant: {
		create: (args: TenantCreateArgs) => Promise<{ id: string }>;
	};
	user: {
		create: (args: UserCreateArgs) => Promise<{ id: string }>;
		findFirst: (args: UserFindFirstLoginArgs) => Promise<{
			id: string;
			tenantId: string;
			passwordHash: string;
			role: AuthRole;
		} | null>;
	};
	refreshToken: {
		create: (args: RefreshTokenCreateArgs) => Promise<{ id: string }>;
		findFirst: (args: RefreshTokenFindFirstArgs) => Promise<{
			id: string;
			expiresAt: Date;
			revokedAt: Date | null;
			user: {
				id: string;
				tenantId: string;
				role: AuthRole;
			};
		} | null>;
		update: (args: RefreshTokenUpdateArgs) => Promise<{ id: string }>;
		updateMany: (args: RefreshTokenUpdateManyArgs) => Promise<{ count: number }>;
	};
	$queryRaw: <T>(query: Prisma.Sql) => Promise<T>;
}

/**
 * The root client deliberately exposes **no** model delegates — only the two resolver calls
 * (`$queryRaw`) and `$transaction`. An unscoped `this.db.user.findFirst(...)` therefore does
 * not compile: the only way to reach a table from here is through `withTenantContext`, which
 * cannot be entered without a tenant id.
 */
interface AuthPrismaClient {
	$queryRaw: <T>(query: Prisma.Sql) => Promise<T>;
	$transaction: <T>(operation: (tx: AuthPrismaTxClient) => Promise<T>) => Promise<T>;
}

interface CreateUserWithTenantInput {
	firstName: string;
	lastName: string;
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
	role: AuthRole;
}

interface RefreshTokenRecord {
	refreshTokenId: string;
	userId: UserId;
	tenantId: TenantId;
	role: AuthRole;
	expiresAt: Date;
	revokedAt: Date | null;
}

const isUniqueConstraintError = (error: unknown): error is { code: string } => {
	if (typeof error !== "object" || error === null) {
		return false;
	}

	const maybeCode = (error as { code?: unknown }).code;
	return (
		typeof maybeCode === "string" && maybeCode === AUTH_DATABASE.UNIQUE_VIOLATION_CODE
	);
};

/**
 * Both resolvers are declared `RETURNS text`, so the shape is guaranteed by the migration --
 * but this is still a `$queryRaw` result, and narrowing it is cheaper than trusting a cast.
 * A missing row, a SQL `NULL` and an unexpected type all collapse to "unresolved".
 */
const asTenantId = (value: unknown): TenantId | null =>
	typeof value === "string" && value.length > 0 ? (value as TenantId) : null;

export class UserRepository {
	private readonly db: AuthPrismaClient;

	// The double cast is the boundary between the real client and the narrowed view above:
	// the runtime value *is* the full `PrismaClient`, and `AuthPrismaClient` only restricts
	// what the rest of this file is allowed to reach. Nothing is unsound at runtime; the two
	// types simply do not overlap structurally, because the narrow one omits members.
	constructor(db: AuthPrismaClient = prisma as unknown as AuthPrismaClient) {
		this.db = db;
	}

	/**
	 * Runs `fn` in a transaction whose first statement is
	 * `set_config('app.tenant_id', …, true)`, so the PostgreSQL RLS policies fire for every
	 * query inside it. Same three lines as `TenantScopedRepository.withTenant`.
	 *
	 * **Deliberate deviation from `.claude/rules/tenant-isolation.md`.** That rule requires
	 * tenant-scoped work to go through `TenantScopedRepository`, whose contract binds
	 * `tenantId` as a *constructor* argument — correct for every other repository, which the
	 * container builds per request from a tenant the gateway has already verified.
	 * auth-service is the one place where the tenant is *discovered* rather than supplied:
	 * `UserRepository` is constructed before any tenant exists (it is a default constructor
	 * argument of `AuthService`) and outlives every tenant it serves, so it cannot extend
	 * `TenantScopedRepository` without inverting its lifecycle.
	 *
	 * The invariant the rule protects is preserved. The tenant id is never taken from a
	 * caller-supplied request field: it comes from a `SECURITY DEFINER` resolver keyed on a
	 * credential (an e-mail address or a refresh-token hash), from a tenant this repository
	 * has just generated, or from the gateway-verified JWT context. Callers must pass it as a
	 * branded `TenantId`, so an arbitrary string does not type-check. Every query inside also
	 * carries its own explicit tenant predicate -- directly where the table has a `tenantId`
	 * column, and through the `user` relation filter on `"RefreshToken"`, which has none.
	 * The one exception is `storeRefreshToken`: an INSERT has no `where` to attach it to.
	 */
	private async withTenantContext<T>(
		tenantId: TenantId,
		fn: (tx: AuthPrismaTxClient) => Promise<T>
	): Promise<T> {
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw(
				Prisma.sql`SELECT set_config(${AUTH_DATABASE.TENANT_CONTEXT_SETTING}, ${tenantId}, true)`
			);
			return fn(tx);
		});
	}

	/**
	 * Pre-tenant lookup: which tenant owns this e-mail address? Returns the tenant id only —
	 * never credentials — so the password hash is always read back through the ordinary,
	 * policy-enforced path.
	 */
	private async resolveTenantIdByEmail(email: string): Promise<TenantId | null> {
		const rows = await this.db.$queryRaw<TenantResolutionRow[]>(
			Prisma.sql`SELECT ${RESOLVER_FUNCTIONS.tenantByEmail}(${email}) AS "tenantId"`
		);

		return asTenantId(rows[0]?.tenantId);
	}

	/**
	 * Pre-tenant lookup for rotation. The refresh token is opaque `randomBytes(32)`, not a
	 * JWT, so the tenant cannot be recovered from the token itself.
	 */
	private async resolveTenantIdByRefreshTokenHash(
		tokenHash: string
	): Promise<TenantId | null> {
		const rows = await this.db.$queryRaw<TenantResolutionRow[]>(
			Prisma.sql`SELECT ${RESOLVER_FUNCTIONS.tenantByRefreshTokenHash}(${tokenHash}) AS "tenantId"`
		);

		return asTenantId(rows[0]?.tenantId);
	}

	async createUserWithTenantIfEmailAvailable(
		input: CreateUserWithTenantInput
	): Promise<RegisterResult | null> {
		const normalizedEmail = input.email.trim().toLowerCase();

		// The duplicate-email pre-check. A direct `user.findFirst({ where: { email } })` here
		// returns null for every address under RLS — registration would still be rejected by
		// the User_email_key unique index (P2002, caught below), so the tests would stay green
		// while this deliberate check silently stopped checking.
		const existingTenantId = await this.resolveTenantIdByEmail(normalizedEmail);

		if (existingTenantId !== null) {
			return null;
		}

		// `tenant_self_insert` checks `"id" = current_setting('app.tenant_id', true)`, so the
		// id has to exist before the row does. Prisma's `@default(uuid())` generates it
		// client-side anyway; this moves that one step earlier.
		const tenantId = randomUUID() as TenantId;

		try {
			return await this.withTenantContext(tenantId, async (tx) => {
				const tenant = await tx.tenant.create({
					data: {
						id: tenantId,
						name: input.tenantName,
						plan: AUTH_TENANT_DEFAULTS.PLAN,
						timezone: AUTH_TENANT_DEFAULTS.TIMEZONE
					},
					select: { id: true }
				});

				const user = await tx.user.create({
					data: {
						tenantId: tenant.id,
						firstName: input.firstName,
						lastName: input.lastName,
						email: normalizedEmail,
						passwordHash: input.passwordHash,
						role: AUTH_ROLES.OWNER
					},
					select: { id: true }
				});

				return {
					userId: user.id as UserId,
					tenantId: tenant.id as TenantId
				};
			});
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				return null;
			}

			throw error;
		}
	}

	async findUserForLogin(email: string): Promise<LoginUser | null> {
		const normalizedEmail = email.trim().toLowerCase();
		const tenantId = await this.resolveTenantIdByEmail(normalizedEmail);

		if (tenantId === null) {
			// No second query on a miss. `AuthService.login` still runs the dummy-hash compare,
			// so the response profile is unchanged.
			return null;
		}

		const user = await this.withTenantContext(tenantId, (tx) =>
			tx.user.findFirst({
				where: { email: normalizedEmail, tenantId },
				select: {
					id: true,
					tenantId: true,
					passwordHash: true,
					role: true
				}
			})
		);

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
		tenantId: TenantId;
		userId: UserId;
		refreshTokenHash: string;
		expiresAt: Date;
	}): Promise<void> {
		// An INSERT has no `where`, so this is the one "RefreshToken" write with no
		// application-layer tenant predicate available -- the row is scoped by the `userId`
		// it carries. The tenant context is set anyway, so the day "RefreshToken" gets a real
		// policy (S-10) is a migration rather than a code change.
		await this.withTenantContext(input.tenantId, async (tx) => {
			await tx.refreshToken.create({
				data: {
					userId: input.userId,
					tokenHash: input.refreshTokenHash,
					expiresAt: input.expiresAt
				}
			});
		});
	}

	async findRefreshTokenForRotation(tokenHash: string): Promise<RefreshTokenRecord | null> {
		const tenantId = await this.resolveTenantIdByRefreshTokenHash(tokenHash);

		if (tenantId === null) {
			return null;
		}

		const refreshToken = await this.withTenantContext(tenantId, (tx) =>
			tx.refreshToken.findFirst({
				where: { tokenHash, user: { tenantId } },
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
			})
		);

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
		tenantId: TenantId;
		currentRefreshTokenId: string;
		userId: UserId;
		newRefreshTokenHash: string;
		newExpiresAt: Date;
	}): Promise<void> {
		await this.withTenantContext(input.tenantId, async (tx) => {
			// The `user` relation filter is the tenant predicate. `id` alone would be safe by
			// argument -- it is a globally unique UUID that this repository read back itself --
			// but RLS is still inert on "RefreshToken" (S-10), so without this the write has
			// no tenant control at all. A cross-tenant id now raises P2025 instead of silently
			// revoking nothing.
			await tx.refreshToken.update({
				where: {
					id: input.currentRefreshTokenId,
					user: { tenantId: input.tenantId }
				},
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

	async revokeActiveRefreshTokens(input: {
		tenantId: TenantId;
		userId: UserId;
	}): Promise<void> {
		await this.withTenantContext(input.tenantId, async (tx) => {
			// Same reasoning as `rotateRefreshToken`: the `user` relation filter is the only
			// tenant control this write has while "RefreshToken" carries no policy (S-10).
			await tx.refreshToken.updateMany({
				where: {
					userId: input.userId,
					revokedAt: null,
					user: { tenantId: input.tenantId }
				},
				data: {
					revokedAt: new Date()
				}
			});
		});
	}
}
