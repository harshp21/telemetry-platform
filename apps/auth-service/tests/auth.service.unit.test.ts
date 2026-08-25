import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/services/auth.service";
import { EmailAlreadyExistsError } from "../src/errors";
import * as bcryptjs from "bcryptjs";

vi.mock("bcryptjs");
vi.mock("../src/config/env", () => ({
	env: {
		BCRYPT_ROUNDS: 12,
		JWT_SECRET: "test-secret-32-chars-minimum--",
		JWT_REFRESH_SECRET: "test-refresh-secret-32-chars---",
		JWT_ACCESS_TTL_SECONDS: 900,
		JWT_REFRESH_TTL_SECONDS: 604800
	}
}));

describe("AuthService.register (unit)", () => {
	let authService: AuthService;
	let mockUserRepository: any;

	beforeEach(() => {
		vi.clearAllMocks();

		mockUserRepository = {
			createUserWithTenantIfEmailAvailable: vi.fn()
		};

		authService = new AuthService();
		// Inject mock repository
		(authService as any).userRepository = mockUserRepository;
	});

	describe("happy path", () => {
		it("should hash password with env.BCRYPT_ROUNDS", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			const mockHash = "hashed_password_value";
			vi.mocked(bcryptjs.hash).mockResolvedValue(mockHash as any);

			mockUserRepository.createUserWithTenantIfEmailAvailable.mockResolvedValue({
				userId: "user-123",
				tenantId: "tenant-456"
			});

			await authService.register(input);

			expect(bcryptjs.hash).toHaveBeenCalledWith(input.password, 12);
		});

		it("should call repository with normalized data", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			const mockHash = "hashed_password_value";
			vi.mocked(bcryptjs.hash).mockResolvedValue(mockHash as any);

			mockUserRepository.createUserWithTenantIfEmailAvailable.mockResolvedValue({
				userId: "user-123",
				tenantId: "tenant-456"
			});

			await authService.register(input);

			expect(mockUserRepository.createUserWithTenantIfEmailAvailable).toHaveBeenCalledWith({
				firstName: input.firstName,
				lastName: input.lastName,
				email: input.email,
				passwordHash: mockHash,
				tenantName: input.tenantName
			});
		});

		it("should return userId and tenantId on success", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			vi.mocked(bcryptjs.hash).mockResolvedValue("hashed_password_value" as any);

			const expected = {
				userId: "user-123",
				tenantId: "tenant-456"
			};

			mockUserRepository.createUserWithTenantIfEmailAvailable.mockResolvedValue(expected);

			const result = await authService.register(input);

			expect(result).toEqual(expected);
		});
	});

	describe("error handling", () => {
		it("should throw EmailAlreadyExistsError when repository returns null", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "existing@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			vi.mocked(bcryptjs.hash).mockResolvedValue("hashed_password_value" as any);

			mockUserRepository.createUserWithTenantIfEmailAvailable.mockResolvedValue(null);

			await expect(authService.register(input)).rejects.toThrow(
				EmailAlreadyExistsError
			);
		});

		it("should propagate bcrypt hashing errors", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			const bcryptError = new Error("Bcrypt error: rounds out of range");
			vi.mocked(bcryptjs.hash).mockRejectedValue(bcryptError);

			await expect(authService.register(input)).rejects.toThrow("Bcrypt error");
		});

		it("should propagate repository errors (other than null return)", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			vi.mocked(bcryptjs.hash).mockResolvedValue("hashed_password_value" as any);

			const dbError = new Error("Database connection timeout");
			mockUserRepository.createUserWithTenantIfEmailAvailable.mockRejectedValue(
				dbError
			);

			await expect(authService.register(input)).rejects.toThrow(
				"Database connection timeout"
			);
		});
	});

	describe("password hashing security", () => {
		it("should use bcryptjs.hash (not compare)", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			vi.mocked(bcryptjs.hash).mockResolvedValue("hashed_password_value" as any);

			mockUserRepository.createUserWithTenantIfEmailAvailable.mockResolvedValue({
				userId: "user-123",
				tenantId: "tenant-456"
			});

			await authService.register(input);

			expect(bcryptjs.hash).toHaveBeenCalled();
			expect(bcryptjs.compare).not.toHaveBeenCalled();
		});

		it("should not expose plain password after hashing", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			vi.mocked(bcryptjs.hash).mockResolvedValue("hashed_password_value" as any);

			mockUserRepository.createUserWithTenantIfEmailAvailable.mockResolvedValue({
				userId: "user-123",
				tenantId: "tenant-456"
			});

			const result = await authService.register(input);

			// Result should not contain plain password
			expect(result).not.toHaveProperty("password");
			expect(result).toEqual({
				userId: "user-123",
				tenantId: "tenant-456"
			});
		});

		it("should call hash with BCRYPT_ROUNDS from env (range 10-14)", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			vi.mocked(bcryptjs.hash).mockResolvedValue("hashed_password_value" as any);

			mockUserRepository.createUserWithTenantIfEmailAvailable.mockResolvedValue({
				userId: "user-123",
				tenantId: "tenant-456"
			});

			await authService.register(input);

			// Verify rounds is in valid range (env.BCRYPT_ROUNDS = 12)
			const [, rounds] = vi.mocked(bcryptjs.hash).mock.calls[0];
			expect(rounds).toBeGreaterThanOrEqual(10);
			expect(rounds).toBeLessThanOrEqual(14);
		});
	});

	describe("input validation", () => {
		it("should accept all required input fields", async () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			vi.mocked(bcryptjs.hash).mockResolvedValue("hashed_password_value" as any);

			mockUserRepository.createUserWithTenantIfEmailAvailable.mockResolvedValue({
				userId: "user-123",
				tenantId: "tenant-456"
			});

			const result = await authService.register(input);

			expect(result).toBeDefined();
		});

		it("should work with minimal valid input", async () => {
			const input = {
				firstName: "J",
				lastName: "D",
				email: "j@d.co",
				password: "12345678",
				tenantName: "A"
			};

			vi.mocked(bcryptjs.hash).mockResolvedValue("hashed_password_value" as any);

			mockUserRepository.createUserWithTenantIfEmailAvailable.mockResolvedValue({
				userId: "user-123",
				tenantId: "tenant-456"
			});

			const result = await authService.register(input);

			expect(result).toBeDefined();
		});
	});
});
