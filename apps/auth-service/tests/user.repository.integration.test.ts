import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { TenantId, UserId } from "@telemetry/shared-types";
import { AUTH_DATABASE, AUTH_ROLES } from "../src/constants";
import { UserRepository } from "../src/repositories/user.repository";
import { TEST_DATABASE_URLS } from "./database-urls";

/**
 * Proves the `user: { tenantId }` relation filter on the two `"RefreshToken"` writes actually
 * scopes them, against a real database.
 *
 * The unit suite asserts the argument object reaches Prisma; that is necessary but not
 * sufficient. `"RefreshToken"` has no `tenantId` column and its RLS is inert (S-10), so the
 * relation filter is the *only* tenant control these writes have — and whether it becomes a real
 * predicate is a fact about Prisma's query compiler, not about our call site. A Prisma upgrade
 * that stopped honouring relation filters in `update.where` would be caught by nothing else here.
 *
 * Two connections: `admin` seeds and reads back (RLS would block it on the runtime role), `app`
 * is auth-service's own role and the one the repository runs on.
 */

type RepositoryDb = ConstructorParameters<typeof UserRepository>[0];

const REFRESH_TOKEN_TTL_MS = 60 * 60 * 1000;

const envOrDefault = (name: string, fallback: string): string =>
	process.env[name] ?? fallback;

describe("UserRepository refresh-token writes are tenant-scoped (integration)", () => {
	const suiteId = randomUUID();
	const tenantAId = `t_repo_a_${suiteId}` as TenantId;
	const tenantBId = `t_repo_b_${suiteId}` as TenantId;
	const userAId = `u_repo_a_${suiteId}` as UserId;
	const tokenHash = `repo-token-${suiteId}`;

	let admin: PrismaClient;
	let app: PrismaClient;
	let repository: UserRepository;
	let refreshTokenId: string;

	const readTokenRevokedAt = async (): Promise<Date | null | undefined> => {
		const row = await admin.refreshToken.findFirst({
			where: { tokenHash },
			select: { revokedAt: true }
		});

		if (!row) {
			throw new Error(`Fixture refresh token ${tokenHash} is missing`);
		}

		return row.revokedAt;
	};

	beforeAll(async () => {
		admin = new PrismaClient({
			datasourceUrl: envOrDefault("DIRECT_DATABASE_URL", TEST_DATABASE_URLS.ADMIN),
			log: ["error"]
		});
		// No `log: ["error"]` on this one: two of the four tests below *expect* a failed
		// update, and Prisma would print the P2025 as though something had gone wrong.
		app = new PrismaClient({
			datasourceUrl: envOrDefault("DATABASE_URL", TEST_DATABASE_URLS.AUTH_APP)
		});
		repository = new UserRepository(app as unknown as RepositoryDb);

		await admin.tenant.create({ data: { id: tenantAId, name: "Repo Tenant A" } });
		await admin.tenant.create({ data: { id: tenantBId, name: "Repo Tenant B" } });
		await admin.user.create({
			data: {
				id: userAId,
				tenantId: tenantAId,
				firstName: "Repo",
				lastName: "A",
				email: `repo-a-${suiteId}@example.com`,
				passwordHash: "hash-a",
				role: AUTH_ROLES.OWNER
			}
		});
	});

	beforeEach(async () => {
		await admin.refreshToken.deleteMany({ where: { tokenHash } });
		const token = await admin.refreshToken.create({
			data: {
				userId: userAId,
				tokenHash,
				expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
			}
		});
		refreshTokenId = token.id;
	});

	afterAll(async () => {
		try {
			await admin.refreshToken.deleteMany({ where: { userId: userAId } });
			await admin.user.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
			await admin.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
		} catch {
			// ignore cleanup errors
		}
		await admin.$disconnect();
		await app.$disconnect();
	});

	describe("rotateRefreshToken", () => {
		it("revokes the current token when the tenant matches", async () => {
			await repository.rotateRefreshToken({
				tenantId: tenantAId,
				currentRefreshTokenId: refreshTokenId,
				userId: userAId,
				newRefreshTokenHash: `next-${suiteId}`,
				newExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
			});

			expect(await readTokenRevokedAt()).not.toBeNull();
		});

		it("rejects and revokes nothing when the tenant does not own the token", async () => {
			// tenantB's context against tenantA's token id. Nothing else stops this: the id is
			// a valid primary key and RLS is inert on the table.
			await expect(
				repository.rotateRefreshToken({
					tenantId: tenantBId,
					currentRefreshTokenId: refreshTokenId,
					userId: userAId,
					newRefreshTokenHash: `cross-${suiteId}`,
					newExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
				})
			).rejects.toMatchObject({ code: AUTH_DATABASE.RECORD_NOT_FOUND_CODE });

			expect(await readTokenRevokedAt()).toBeNull();
		});
	});

	describe("revokeActiveRefreshTokens", () => {
		it("revokes the user's active tokens when the tenant matches", async () => {
			await repository.revokeActiveRefreshTokens({
				tenantId: tenantAId,
				userId: userAId
			});

			expect(await readTokenRevokedAt()).not.toBeNull();
		});

		it("revokes nothing when the tenant does not own the user", async () => {
			// `updateMany` matches zero rows rather than raising, so the proof is the row itself.
			await repository.revokeActiveRefreshTokens({
				tenantId: tenantBId,
				userId: userAId
			});

			expect(await readTokenRevokedAt()).toBeNull();
		});
	});
});
