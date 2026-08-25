import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AUTH_VALIDATION } from "../src/constants";

// Test the Zod schema validation at the controller layer
const registerRequestSchema = z.object({
	firstName: z.string().trim().min(1),
	lastName: z.string().trim().min(1),
	email: z.string().email(),
	password: z.string().min(AUTH_VALIDATION.PASSWORD_MIN_LENGTH),
	tenantName: z.string().trim().min(1)
});

describe("registerRequestSchema (controller validation)", () => {
	describe("happy path", () => {
		it("should accept valid input with all fields", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).not.toThrow();
		});

		it("should parse and return data on success", () => {
			const input = {
				firstName: "Jane",
				lastName: "Smith",
				email: "jane@test.com",
				password: "AnotherPass456",
				tenantName: "TechCorp"
			};

			const result = registerRequestSchema.parse(input);

			expect(result).toEqual({
				firstName: "Jane",
				lastName: "Smith",
				email: "jane@test.com",
				password: "AnotherPass456",
				tenantName: "TechCorp"
			});
		});

		it("should trim whitespace from firstName", () => {
			const input = {
				firstName: "  John  ",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			const result = registerRequestSchema.parse(input);

			expect(result.firstName).toBe("John");
		});

		it("should trim whitespace from lastName", () => {
			const input = {
				firstName: "John",
				lastName: "  Doe  ",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			const result = registerRequestSchema.parse(input);

			expect(result.lastName).toBe("Doe");
		});

		it("should trim whitespace from tenantName", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "  Acme Inc  "
			};

			const result = registerRequestSchema.parse(input);

			expect(result.tenantName).toBe("Acme Inc");
		});

		it("should accept minimal valid input (1-char fields)", () => {
			const input = {
				firstName: "J",
				lastName: "D",
				email: "j@d.co",
				password: "12345678",
				tenantName: "A"
			};

			expect(() => registerRequestSchema.parse(input)).not.toThrow();
		});
	});

	describe("validation errors - firstName", () => {
		it("should reject missing firstName", () => {
			const input = {
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should reject empty firstName", () => {
			const input = {
				firstName: "",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should reject firstName with only whitespace", () => {
			const input = {
				firstName: "   ",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});
	});

	describe("validation errors - lastName", () => {
		it("should reject missing lastName", () => {
			const input = {
				firstName: "John",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should reject empty lastName", () => {
			const input = {
				firstName: "John",
				lastName: "",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should reject lastName with only whitespace", () => {
			const input = {
				firstName: "John",
				lastName: "   ",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});
	});

	describe("validation errors - email", () => {
		it("should reject missing email", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should reject invalid email format (no @)", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "not-an-email",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should reject invalid email format (no domain)", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should reject invalid email format (no local part)", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "@test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should accept valid email with subdomain", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@mail.test.com",
				password: "SecurePass123",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).not.toThrow();
		});
	});

	describe("validation errors - password", () => {
		it("should reject missing password", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should reject password < 8 chars", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "short",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should reject empty password", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should accept password exactly 8 chars", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "12345678",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).not.toThrow();
		});

		it("should accept long password", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "VeryLongPasswordWith1234567890!@#",
				tenantName: "Acme Inc"
			};

			expect(() => registerRequestSchema.parse(input)).not.toThrow();
		});
	});

	describe("validation errors - tenantName", () => {
		it("should reject missing tenantName", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123"
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should reject empty tenantName", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: ""
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});

		it("should reject tenantName with only whitespace", () => {
			const input = {
				firstName: "John",
				lastName: "Doe",
				email: "john@test.com",
				password: "SecurePass123",
				tenantName: "   "
			};

			expect(() => registerRequestSchema.parse(input)).toThrow();
		});
	});
});

