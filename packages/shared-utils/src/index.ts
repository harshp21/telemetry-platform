import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AppError, ERROR_RESPONSES } from "@telemetry/shared-types";
import { ZodError } from "zod";

export const packageName = "@telemetry/shared-utils";
export const packageDescription = "Shared utility helpers";

const isPrismaKnownError = (error: unknown): error is { code: string } => {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
};

export const generateIdempotencyKey = (
	tenantId: string,
	eventType: string,
	timestamp: string
): string => {
	return createHash("sha256")
		.update([tenantId, eventType, timestamp].join("|"))
		.digest("hex");
};

export const chunkArray = <T>(arr: T[], size: number): T[][] => {
	if (!Number.isInteger(size) || size <= 0) {
		throw new Error("size must be a positive integer");
	}

	const chunks: T[][] = [];
	for (let index = 0; index < arr.length; index += size) {
		chunks.push(arr.slice(index, index + size));
	}

	return chunks;
};

export const sleep = (ms: number): Promise<void> => {
	if (ms < 0) {
		return Promise.reject(new Error("ms must be non-negative"));
	}

	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
};

interface RetryWithBackoffOptions {
	maxAttempts: number;
	baseDelayMs: number;
}

export const retryWithBackoff = async <T>(
	fn: () => Promise<T>,
	opts: RetryWithBackoffOptions
): Promise<T> => {
	const { maxAttempts, baseDelayMs } = opts;

	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
		throw new Error("maxAttempts must be at least 1");
	}

	if (baseDelayMs < 0) {
		throw new Error("baseDelayMs must be non-negative");
	}

	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;

			if (attempt === maxAttempts) {
				break;
			}

			const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);
			const jitter = Math.floor(Math.random() * (baseDelayMs + 1));
			await sleep(exponentialDelay + jitter);
		}
	}

	throw lastError;
};

export const formatCurrency = (amountInCents: number, currency: string): string => {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency,
		currencyDisplay: "symbol"
	}).format(amountInCents / 100);
};

export const formatBytes = (bytes: number): string => {
	if (bytes < 0) {
		throw new Error("bytes must be non-negative");
	}

	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let value = bytes;
	let unitIndex = 0;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}

	const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Number(value.toFixed(1));
	return `${rounded} ${units[unitIndex]}`;
};

export const registerGlobalErrorHandler = (app: FastifyInstance): void => {
	app.setErrorHandler((error, request, reply) => {
		const isTest = process.env.NODE_ENV === "test";

		if (!isTest) {
			request.log.error({ err: error }, "Request error");
		}

		if (error instanceof ZodError) {
			return reply.status(400).send({
				code: ERROR_RESPONSES.CODE_VALIDATION_ERROR,
				issues: error.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message
				}))
			});
		}

		if (error instanceof AppError) {
			return reply.status(error.statusCode).send({
				code: error.code,
				message: error.message
			});
		}

		if (isPrismaKnownError(error) && error.code === "P2002") {
			return reply.status(409).send({ code: ERROR_RESPONSES.CODE_CONFLICT });
		}

		const isProd = process.env.NODE_ENV === "production";
		const message = error instanceof Error ? error.message : "Unknown error";

		return reply.status(500).send({
			code: ERROR_RESPONSES.CODE_INTERNAL_ERROR,
			...(isProd ? {} : { message })
		});
	});
};
