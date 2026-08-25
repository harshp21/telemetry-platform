import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserRepository } from "../src/repositories/user.repository";
import type { PrismaClient } from "@prisma/client";

describe("UserRepository.createUserWithTenantIfEmailAvailable (unit)", () => {
	let userRepository: UserRepository;
	let mockPrisma: any;

	beforeEach(() => {
		vi.clearAllMocks();

		mockPrisma = {
			user: {
				findFirst: vi.fn(),
				create: vi.fn()
			},
			tenant: {
				create: vi.fn()
			},
			$transaction: vi.fn((callback) => callback(mockPrisma))
		};

		userRepository = new UserRepository(mockPrisma as PrismaClient);
	});

	describe("happy path", () => {
		it("should create tenant and user atomically", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue(null);
			mockPrisma.tenant.create.mockResolvedValue({
				id: "tenant-123",
				name: "Acme Inc",
				plan: "FREE",
				timezone: "UTC"
			});
			mockPrisma.user.create.mockResolvedValue({
				id: "user-456",
				tenantId: "tenant-123",
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				role: "OWNER"
			});

			const result = await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(result).toEqual({
				userId: "user-456",
				tenantId: "tenant-123"
			});
		});

		it("should use Prisma transaction for atomicity", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue(null);
			mockPrisma.$transaction.mockImplementation((callback) =>
				callback(mockPrisma)
			);
			mockPrisma.tenant.create.mockResolvedValue({
				id: "tenant-123",
				name: "Acme Inc"
			});
			mockPrisma.user.create.mockResolvedValue({
				id: "user-456",
				tenantId: "tenant-123"
			});

			await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(mockPrisma.$transaction).toHaveBeenCalled();
		});

		it("should normalize email to lowercase before storage", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "JOHN@TEST.COM",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue(null);
			mockPrisma.tenant.create.mockResolvedValue({
				id: "tenant-123",
				name: "Acme Inc"
			});
			mockPrisma.user.create.mockResolvedValue({
				id: "user-456",
				tenantId: "tenant-123",
				email: "john@test.com"
			});

			const result = await userRepository.createUserWithTenantIfEmailAvailable(input);

			// Verify lowercase email was used
			expect(mockPrisma.user.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						email: "john@test.com"
					})
				})
			);
		});

		it("should trim email before normalization", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "  john@test.com  ",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue(null);
			mockPrisma.tenant.create.mockResolvedValue({
				id: "tenant-123",
				name: "Acme Inc"
			});
			mockPrisma.user.create.mockResolvedValue({
				id: "user-456",
				tenantId: "tenant-123",
				email: "john@test.com"
			});

			await userRepository.createUserWithTenantIfEmailAvailable(input);

			// Verify trimmed email was used
			expect(mockPrisma.user.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						email: "john@test.com"
					})
				})
			);
		});

		it("should set first user role to OWNER", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue(null);
			mockPrisma.tenant.create.mockResolvedValue({
				id: "tenant-123",
				name: "Acme Inc"
			});
			mockPrisma.user.create.mockResolvedValue({
				id: "user-456",
				tenantId: "tenant-123",
				role: "OWNER"
			});

			await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(mockPrisma.user.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						role: "OWNER"
					})
				})
			);
		});

		it("should create tenant with name, plan=FREE, timezone=UTC", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue(null);
			mockPrisma.tenant.create.mockResolvedValue({
				id: "tenant-123",
				name: "Acme Inc",
				plan: "FREE",
				timezone: "UTC"
			});
			mockPrisma.user.create.mockResolvedValue({
				id: "user-456",
				tenantId: "tenant-123"
			});

			await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(mockPrisma.tenant.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						name: "Acme Inc",
						plan: "FREE",
						timezone: "UTC"
					})
				})
			);
		});

		it("should store passwordHash, not plain password", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				passwordHash: "hashed_password_value",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue(null);
			mockPrisma.tenant.create.mockResolvedValue({
				id: "tenant-123",
				name: "Acme Inc"
			});
			mockPrisma.user.create.mockResolvedValue({
				id: "user-456",
				tenantId: "tenant-123",
				passwordHash: "hashed_password_value"
			});

			await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(mockPrisma.user.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						passwordHash: "hashed_password_value"
					})
				})
			);
		});
	});

	describe("duplicate email detection", () => {
		it("should return null if email already exists", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "existing@test.com",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue({
				id: "existing-user",
				email: "existing@test.com"
			});

			const result = await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(result).toBeNull();
		});

		it("should detect duplicate email case-insensitively", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "EXISTING@TEST.COM",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue({
				id: "existing-user",
				email: "existing@test.com"
			});

			const result = await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(result).toBeNull();
			expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						email: "existing@test.com"
					})
				})
			);
		});

		it("should not call tenant/user create if email exists", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "existing@test.com",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue({
				id: "existing-user",
				email: "existing@test.com"
			});

			await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(mockPrisma.$transaction).not.toHaveBeenCalled();
			expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
		});
	});

	describe("error handling", () => {
		it("should handle P2002 unique constraint error (race condition)", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue(null);
			mockPrisma.$transaction.mockImplementation((callback) => {
				throw {
					code: "P2002",
					meta: { target: ["email"] }
				};
			});

			const result = await userRepository.createUserWithTenantIfEmailAvailable(input);

			expect(result).toBeNull();
		});

		it("should propagate non-P2002 errors", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue(null);
			const dbError = new Error("Database connection timeout");
			mockPrisma.$transaction.mockRejectedValue(dbError);

			await expect(
				userRepository.createUserWithTenantIfEmailAvailable(input)
			).rejects.toThrow("Database connection timeout");
		});

		it("should propagate error from findFirst", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			const dbError = new Error("Prisma error: table not found");
			mockPrisma.user.findFirst.mockRejectedValue(dbError);

			await expect(
				userRepository.createUserWithTenantIfEmailAvailable(input)
			).rejects.toThrow("Prisma error: table not found");
		});
	});

	describe("transaction rollback", () => {
		it("should rollback if user creation fails after tenant creation", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				passwordHash: "hashed_password",
				tenantName: "Acme Inc"
			};

			mockPrisma.user.findFirst.mockResolvedValue(null);
			mockPrisma.$transaction.mockImplementation((callback) => {
				const tx = {
					tenant: {
						create: vi.fn().mockResolvedValue({ id: "tenant-123" })
					},
					user: {
						create: vi
							.fn()
							.mockRejectedValue(new Error("User creation failed"))
					}
				};
				return callback(tx);
			});

			await expect(
				userRepository.createUserWithTenantIfEmailAvailable(input)
			).rejects.toThrow("User creation failed");

			// Verify transaction was attempted (Prisma handles rollback automatically)
			expect(mockPrisma.$transaction).toHaveBeenCalled();
		});
	});
});
