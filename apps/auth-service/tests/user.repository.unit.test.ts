import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantId, UserId } from "@telemetry/shared-types";
import { AUTH_DATABASE, AUTH_ROLES, AUTH_TENANT_DEFAULTS } from "../src/constants";
import { UserRepository } from "../src/repositories/user.repository";

type RepositoryDb = ConstructorParameters<typeof UserRepository>[0];
type TransactionCallback = (tx: unknown) => unknown;

/** Shape of a `Prisma.sql` fragment, which is what the repository hands to `$queryRaw`. */
interface SqlFragment {
	readonly sql: string;
	readonly values: readonly unknown[];
}

/**
 * `expect.objectContaining` is typed `any`, which makes every call site an unsafe assignment.
 * This keeps the assertions type-checked.
 */
const containing = <T extends object>(shape: T): T => expect.objectContaining(shape) as T;

const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TENANT_ID = "tenant-123" as TenantId;
const OTHER_TENANT_ID = "tenant-existing" as TenantId;
const USER_ID = "user-456" as UserId;
const REFRESH_TOKEN_ID = "refresh-789";
const TOKEN_HASH = "token-hash-value";

interface ResolverResults {
	byEmail: string | null;
	byRefreshTokenHash: string | null;
}

interface MockDb {
	user: {
		findFirst: ReturnType<typeof vi.fn>;
		create: ReturnType<typeof vi.fn>;
	};
	tenant: {
		create: ReturnType<typeof vi.fn>;
	};
	refreshToken: {
		create: ReturnType<typeof vi.fn>;
		findFirst: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		updateMany: ReturnType<typeof vi.fn>;
	};
	$queryRaw: ReturnType<typeof vi.fn>;
	$transaction: ReturnType<typeof vi.fn>;
}

describe("UserRepository (unit)", () => {
	let userRepository: UserRepository;
	let mockPrisma: MockDb;
	let resolverResults: ResolverResults;
	/** Every `set_config('app.tenant_id', …)` value the repository issued, in order. */
	let tenantContextValues: string[];
	/** Every argument the repository passed to a resolver function, in order. */
	let resolverArguments: { byEmail: unknown[]; byRefreshTokenHash: unknown[] };
	/**
	 * How many model-delegate calls had already been issued when the repository set the
	 * tenant context. `$transaction` is mocked as `(cb) => cb(mockPrisma)`, so without this a
	 * repository that called `set_config` *last* would pass every assertion in this file —
	 * and would read with no RLS context in production.
	 */
	let modelCallsBeforeTenantContext: number | undefined;

	/**
	 * Fails loudly on SQL the repository is not expected to issue, so a renamed resolver or a
	 * dropped tenant-context statement surfaces as an error rather than as a vacuous pass.
	 */
	/** Total calls across every model delegate on the mock. */
	const countModelCalls = (): number =>
		[
			mockPrisma.user.findFirst,
			mockPrisma.user.create,
			mockPrisma.tenant.create,
			mockPrisma.refreshToken.create,
			mockPrisma.refreshToken.findFirst,
			mockPrisma.refreshToken.update,
			mockPrisma.refreshToken.updateMany
		].reduce((total, mock) => total + mock.mock.calls.length, 0);

	const runRawQuery = (query: SqlFragment): unknown[] => {
		if (query.values[0] === AUTH_DATABASE.TENANT_CONTEXT_SETTING) {
			tenantContextValues.push(String(query.values[1]));
			modelCallsBeforeTenantContext ??= countModelCalls();
			return [{ set_config: query.values[1] }];
		}

		if (query.sql.includes(AUTH_DATABASE.RESOLVE_TENANT_BY_EMAIL_FN)) {
			resolverArguments.byEmail.push(query.values[0]);
			return [{ tenantId: resolverResults.byEmail }];
		}

		if (query.sql.includes(AUTH_DATABASE.RESOLVE_TENANT_BY_REFRESH_TOKEN_HASH_FN)) {
			resolverArguments.byRefreshTokenHash.push(query.values[0]);
			return [{ tenantId: resolverResults.byRefreshTokenHash }];
		}

		throw new Error(`Unexpected raw query issued by UserRepository: ${query.sql}`);
	};

	/**
	 * The tenant context must be the transaction's *first* statement. Fails loudly if the
	 * repository never set it at all, rather than passing vacuously.
	 */
	const expectTenantContextSetFirst = (): void => {
		if (modelCallsBeforeTenantContext === undefined) {
			throw new Error("Repository issued no tenant-context statement at all");
		}

		expect(
			modelCallsBeforeTenantContext,
			"a table was queried before set_config('app.tenant_id', …) was issued"
		).toBe(0);
	};

	const requireOnlyTenantContextValue = (): string => {
		if (tenantContextValues.length !== 1) {
			throw new Error(
				`Expected exactly one tenant-context statement, saw ${tenantContextValues.length}`
			);
		}

		return tenantContextValues[0] as string;
	};

	beforeEach(() => {
		vi.clearAllMocks();

		resolverResults = { byEmail: null, byRefreshTokenHash: null };
		tenantContextValues = [];
		resolverArguments = { byEmail: [], byRefreshTokenHash: [] };
		modelCallsBeforeTenantContext = undefined;

		mockPrisma = {
			user: {
				findFirst: vi.fn(),
				create: vi.fn()
			},
			tenant: {
				create: vi.fn()
			},
			refreshToken: {
				create: vi.fn(),
				findFirst: vi.fn(),
				update: vi.fn(),
				updateMany: vi.fn()
			},
			$queryRaw: vi.fn((query: SqlFragment) => Promise.resolve(runRawQuery(query))),
			$transaction: vi.fn((callback: TransactionCallback) => callback(mockPrisma))
		};

		userRepository = new UserRepository(mockPrisma as unknown as RepositoryDb);
	});

	describe("createUserWithTenantIfEmailAvailable — happy path", () => {
		const input = {
			firstName: "John",
			lastName: "Doe",
			email: "john@test.com",
			passwordHash: "hashed_password",
			tenantName: "Acme Inc"
		};

		beforeEach(() => {
			mockPrisma.tenant.create.mockImplementation(
				(args: { data: { id: string } }) => Promise.resolve({ id: args.data.id })
			);
			mockPrisma.user.create.mockResolvedValue({ id: USER_ID });
		});

		it("should create tenant and user atomically", async () => {
			const result = await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(result?.userId).toBe(USER_ID);
			expect(result?.tenantId).toMatch(UUID_V4_PATTERN);
			expect(mockPrisma.user.create).toHaveBeenCalledWith(
				containing({
					data: containing({
						firstName: "John",
						lastName: "Doe"
					})
				})
			);
		});

		it("should use Prisma transaction for atomicity", async () => {
			await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(mockPrisma.$transaction).toHaveBeenCalled();
		});

		it("should set tenant context to the application-generated tenant id before inserting", async () => {
			const result = await userRepository.createUserWithTenantIfEmailAvailable(input);

			// Registration is the one pre-tenant write: the RLS policy `tenant_self_insert`
			// checks "id" = current_setting('app.tenant_id'), so the id must be generated
			// application-side and set as context *before* the INSERT.
			expect(requireOnlyTenantContextValue()).toBe(result?.tenantId);
			expectTenantContextSetFirst();
			expect(mockPrisma.tenant.create).toHaveBeenCalledWith(
				containing({
					data: containing({ id: result?.tenantId })
				})
			);
			expect(mockPrisma.user.create).toHaveBeenCalledWith(
				containing({
					data: containing({ tenantId: result?.tenantId })
				})
			);
		});

		it("should generate a UUID tenant id, as tenant-context.middleware requires downstream", async () => {
			const result = await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(result?.tenantId).toMatch(UUID_V4_PATTERN);
		});

		it("should normalize email to lowercase before storage", async () => {
			await userRepository.createUserWithTenantIfEmailAvailable({
				...input,
				email: "JOHN@TEST.COM"
			});

			expect(mockPrisma.user.create).toHaveBeenCalledWith(
				containing({
					data: containing({ email: "john@test.com" })
				})
			);
		});

		it("should trim email before normalization", async () => {
			await userRepository.createUserWithTenantIfEmailAvailable({
				...input,
				email: "  john@test.com  "
			});

			expect(mockPrisma.user.create).toHaveBeenCalledWith(
				containing({
					data: containing({ email: "john@test.com" })
				})
			);
		});

		it("should set first user role to OWNER", async () => {
			await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(mockPrisma.user.create).toHaveBeenCalledWith(
				containing({
					data: containing({ role: AUTH_ROLES.OWNER })
				})
			);
		});

		it("should create tenant with name, plan=FREE, timezone=UTC", async () => {
			await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(mockPrisma.tenant.create).toHaveBeenCalledWith(
				containing({
					data: containing({
						name: "Acme Inc",
						plan: AUTH_TENANT_DEFAULTS.PLAN,
						timezone: AUTH_TENANT_DEFAULTS.TIMEZONE
					})
				})
			);
		});

		it("should store passwordHash, not plain password", async () => {
			await userRepository.createUserWithTenantIfEmailAvailable({
				...input,
				passwordHash: "hashed_password_value"
			});

			expect(mockPrisma.user.create).toHaveBeenCalledWith(
				containing({
					data: containing({ passwordHash: "hashed_password_value" })
				})
			);
		});
	});

	describe("createUserWithTenantIfEmailAvailable — duplicate email detection", () => {
		const input = {
			firstName: "John",
			lastName: "Doe",
			email: "existing@test.com",
			passwordHash: "hashed_password",
			tenantName: "Acme Inc"
		};

		it("should return null if email already exists", async () => {
			resolverResults.byEmail = OTHER_TENANT_ID;

			const result = await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(result).toBeNull();
		});

		it("should detect duplicate email case-insensitively", async () => {
			resolverResults.byEmail = OTHER_TENANT_ID;

			const result = await userRepository.createUserWithTenantIfEmailAvailable({
				...input,
				email: "EXISTING@TEST.COM"
			});

			expect(result).toBeNull();
			expect(resolverArguments.byEmail).toEqual(["existing@test.com"]);
		});

		it("should reject the duplicate through the resolver, not through the P2002 backstop", async () => {
			// The pre-check must be live under RLS. If it silently returned null the
			// registration would still be rejected — by the User_email_key unique index via
			// P2002 — and every duplicate-email test would stay green while the deliberate
			// check did nothing. Asserting that no tenant is ever allocated is what
			// distinguishes the two.
			resolverResults.byEmail = OTHER_TENANT_ID;

			await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(resolverArguments.byEmail).toEqual(["existing@test.com"]);
			expect(mockPrisma.$transaction).not.toHaveBeenCalled();
			expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
			expect(mockPrisma.user.create).not.toHaveBeenCalled();
			expect(tenantContextValues).toEqual([]);
		});
	});

	describe("createUserWithTenantIfEmailAvailable — error handling", () => {
		const input = {
			firstName: "John",
			lastName: "Doe",
			email: "john@test.com",
			passwordHash: "hashed_password",
			tenantName: "Acme Inc"
		};

		it("should handle P2002 unique constraint error (race condition)", async () => {
			mockPrisma.$transaction.mockImplementation((_callback: TransactionCallback) => {
				throw {
					code: AUTH_DATABASE.UNIQUE_VIOLATION_CODE,
					meta: { target: ["email"] }
				};
			});

			const result = await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(result).toBeNull();
		});

		it("should propagate non-P2002 errors", async () => {
			const dbError = new Error("Database connection timeout");
			mockPrisma.$transaction.mockRejectedValue(dbError);

			await expect(
				userRepository.createUserWithTenantIfEmailAvailable(input)
			).rejects.toThrow("Database connection timeout");
		});

		it("should propagate error from the tenant resolver", async () => {
			const dbError = new Error("Prisma error: function does not exist");
			mockPrisma.$queryRaw.mockRejectedValue(dbError);

			await expect(
				userRepository.createUserWithTenantIfEmailAvailable(input)
			).rejects.toThrow("Prisma error: function does not exist");
		});
	});

	describe("createUserWithTenantIfEmailAvailable — transaction rollback", () => {
		it("should rollback if user creation fails after tenant creation", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.$transaction.mockImplementation((callback: TransactionCallback) => {
				const tx = {
					$queryRaw: vi.fn((query: SqlFragment) => Promise.resolve(runRawQuery(query))),
					tenant: {
						create: vi.fn().mockResolvedValue({ id: TENANT_ID })
					},
					user: {
						create: vi.fn().mockRejectedValue(new Error("User creation failed"))
					}
				};
				return callback(tx);
			});

			await expect(
				userRepository.createUserWithTenantIfEmailAvailable(input)
			).rejects.toThrow("User creation failed");

			expect(mockPrisma.$transaction).toHaveBeenCalled();
		});
	});

	describe("findUserForLogin", () => {
		it("should resolve the tenant, set it as context, and read the user through the scoped query", async () => {
			resolverResults.byEmail = TENANT_ID;
			mockPrisma.user.findFirst.mockResolvedValue({
				id: USER_ID,
				tenantId: TENANT_ID,
				passwordHash: "stored-hash",
				role: AUTH_ROLES.OWNER
			});

			const result = await userRepository.findUserForLogin("  JOHN@test.com ");

			expect(resolverArguments.byEmail).toEqual(["john@test.com"]);
			expect(requireOnlyTenantContextValue()).toBe(TENANT_ID);
			expectTenantContextSetFirst();
			expect(result).toEqual({
				userId: USER_ID,
				tenantId: TENANT_ID,
				passwordHash: "stored-hash",
				role: AUTH_ROLES.OWNER
			});
		});

		it("should carry an explicit tenantId predicate on the scoped read", async () => {
			resolverResults.byEmail = TENANT_ID;
			mockPrisma.user.findFirst.mockResolvedValue({
				id: USER_ID,
				tenantId: TENANT_ID,
				passwordHash: "stored-hash",
				role: AUTH_ROLES.OWNER
			});

			await userRepository.findUserForLogin("john@test.com");

			expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
				containing({
					where: { email: "john@test.com", tenantId: TENANT_ID }
				})
			);
		});

		it("should return null and issue no scoped read when the tenant does not resolve", async () => {
			resolverResults.byEmail = null;

			const result = await userRepository.findUserForLogin("nobody@test.com");

			expect(result).toBeNull();
			expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
			expect(tenantContextValues).toEqual([]);
		});

		it("should return null when the tenant resolves but the scoped read finds nothing", async () => {
			resolverResults.byEmail = TENANT_ID;
			mockPrisma.user.findFirst.mockResolvedValue(null);

			const result = await userRepository.findUserForLogin("john@test.com");

			expect(result).toBeNull();
		});
	});

	describe("storeRefreshToken", () => {
		it("should set the caller's tenant context before inserting the token", async () => {
			mockPrisma.refreshToken.create.mockResolvedValue({ id: REFRESH_TOKEN_ID });

			await userRepository.storeRefreshToken({
				tenantId: TENANT_ID,
				userId: USER_ID,
				refreshTokenHash: TOKEN_HASH,
				expiresAt: new Date()
			});

			expect(requireOnlyTenantContextValue()).toBe(TENANT_ID);
			expectTenantContextSetFirst();
			expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith(
				containing({
					data: containing({
						userId: USER_ID,
						tokenHash: TOKEN_HASH
					})
				})
			);
		});
	});

	describe("findRefreshTokenForRotation", () => {
		it("should resolve the tenant from the token hash and read the row under that context", async () => {
			resolverResults.byRefreshTokenHash = TENANT_ID;
			const expiresAt = new Date();
			mockPrisma.refreshToken.findFirst.mockResolvedValue({
				id: REFRESH_TOKEN_ID,
				expiresAt,
				revokedAt: null,
				user: { id: USER_ID, tenantId: TENANT_ID, role: AUTH_ROLES.OWNER }
			});

			const result = await userRepository.findRefreshTokenForRotation(TOKEN_HASH);

			expect(resolverArguments.byRefreshTokenHash).toEqual([TOKEN_HASH]);
			expect(requireOnlyTenantContextValue()).toBe(TENANT_ID);
			expectTenantContextSetFirst();
			expect(result).toEqual({
				refreshTokenId: REFRESH_TOKEN_ID,
				userId: USER_ID,
				tenantId: TENANT_ID,
				role: AUTH_ROLES.OWNER,
				expiresAt,
				revokedAt: null
			});
		});

		it("should scope the read to the resolved tenant through the user relation", async () => {
			resolverResults.byRefreshTokenHash = TENANT_ID;
			mockPrisma.refreshToken.findFirst.mockResolvedValue(null);

			await userRepository.findRefreshTokenForRotation(TOKEN_HASH);

			expect(mockPrisma.refreshToken.findFirst).toHaveBeenCalledWith(
				containing({
					where: { tokenHash: TOKEN_HASH, user: { tenantId: TENANT_ID } }
				})
			);
		});

		it("should return null and issue no scoped read for an unknown token hash", async () => {
			resolverResults.byRefreshTokenHash = null;

			const result = await userRepository.findRefreshTokenForRotation("unknown-hash");

			expect(result).toBeNull();
			expect(mockPrisma.refreshToken.findFirst).not.toHaveBeenCalled();
			expect(tenantContextValues).toEqual([]);
		});
	});

	describe("rotateRefreshToken", () => {
		it("should revoke the current token and store the new one under the caller's tenant context", async () => {
			mockPrisma.refreshToken.update.mockResolvedValue({ id: REFRESH_TOKEN_ID });
			mockPrisma.refreshToken.create.mockResolvedValue({ id: "refresh-next" });
			const newExpiresAt = new Date();

			await userRepository.rotateRefreshToken({
				tenantId: TENANT_ID,
				currentRefreshTokenId: REFRESH_TOKEN_ID,
				userId: USER_ID,
				newRefreshTokenHash: "next-hash",
				newExpiresAt
			});

			expect(requireOnlyTenantContextValue()).toBe(TENANT_ID);
			expectTenantContextSetFirst();
			expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith(
				containing({
					where: { id: REFRESH_TOKEN_ID, user: { tenantId: TENANT_ID } }
				})
			);
			expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith(
				containing({
					data: containing({
						userId: USER_ID,
						tokenHash: "next-hash",
						expiresAt: newExpiresAt
					})
				})
			);
		});

		it("scopes the revocation to the caller's tenant through the user relation", async () => {
			// "RefreshToken" has no tenantId column and RLS is still inert on it (S-10), so
			// this relation filter is the only tenant control the write has. Asserted as an
			// exact object: an extra or missing key here is a security change, not a style one.
			mockPrisma.refreshToken.update.mockResolvedValue({ id: REFRESH_TOKEN_ID });
			mockPrisma.refreshToken.create.mockResolvedValue({ id: "refresh-next" });

			await userRepository.rotateRefreshToken({
				tenantId: TENANT_ID,
				currentRefreshTokenId: REFRESH_TOKEN_ID,
				userId: USER_ID,
				newRefreshTokenHash: "next-hash",
				newExpiresAt: new Date()
			});

			const [updateArgs] = mockPrisma.refreshToken.update.mock.calls[0] as [
				{ where: Record<string, unknown> }
			];

			expect(updateArgs.where).toEqual({
				id: REFRESH_TOKEN_ID,
				user: { tenantId: TENANT_ID }
			});
		});
	});

	describe("revokeActiveRefreshTokens", () => {
		it("should revoke only the user's active tokens under the caller's tenant context", async () => {
			mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

			await userRepository.revokeActiveRefreshTokens({
				tenantId: TENANT_ID,
				userId: USER_ID
			});

			expect(requireOnlyTenantContextValue()).toBe(TENANT_ID);
			expectTenantContextSetFirst();
			expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
				containing({
					where: {
						userId: USER_ID,
						revokedAt: null,
						user: { tenantId: TENANT_ID }
					}
				})
			);
		});

		it("carries the tenant predicate and nothing wider, and never another tenant's id", async () => {
			mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

			await userRepository.revokeActiveRefreshTokens({
				tenantId: TENANT_ID,
				userId: USER_ID
			});

			const [updateManyArgs] = mockPrisma.refreshToken.updateMany.mock.calls[0] as [
				{ where: Record<string, unknown> }
			];

			expect(updateManyArgs.where).toEqual({
				userId: USER_ID,
				revokedAt: null,
				user: { tenantId: TENANT_ID }
			});
			expect(JSON.stringify(updateManyArgs.where)).not.toContain(OTHER_TENANT_ID);
		});
	});
});
