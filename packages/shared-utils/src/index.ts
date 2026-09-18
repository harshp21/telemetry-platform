import { createHash, timingSafeEqual } from "node:crypto";
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

/**
 * Equality for two secrets of unknown length, compared as fixed-width SHA-256 digests through
 * `crypto.timingSafeEqual`.
 *
 * The heading deliberately describes the *construction* and not a timing property. It read
 * "Constant-time equality for two secrets of unknown length" until the Gate-5 rework, which is an
 * unqualified universal of the kind `.claude/rules/review-standards.md` § *Universals Must Cite
 * Their Mutation* asks to weaken to what was measured (QA F-5). The paragraph in bold below is the
 * accurate statement and is unchanged: nothing here establishes a constant-time property, and a
 * green suite is not evidence of one. The narrowing is to the heading only, so that the first line
 * a reader sees agrees with the last.
 *
 * `===` on strings short-circuits at the first differing byte, so response latency leaks how
 * many leading bytes a guess got right -- enough to recover a secret byte by byte from a
 * network-reachable endpoint.
 *
 * `crypto.timingSafeEqual` fixes that but *throws* on unequal buffer lengths, and guarding it
 * with a length check reintroduces an early-exit oracle for the secret's length. Hashing both
 * sides to a fixed-width SHA-256 digest first removes the precondition without branching on the
 * secret: both digests are always 32 bytes, so the comparison never throws and the width it
 * operates on does not vary with the candidate's length or content. SHA-256's collision resistance
 * makes digest equality equivalent to string equality here.
 *
 * **The digest step is not width-independent, and the heading used to imply otherwise.** Wall
 * clock over this function, 20 000 iterations per length after a 50 000-iteration warm-up on this
 * host: 32 bytes 2.68 us, 1 KiB 3.42 us, 64 KiB 40.74 us, 1 MiB 638.94 us. The candidate's length
 * is attacker-supplied, so that is not a channel on the *expected* secret -- which is the oracle
 * the fixed-width digest removes, and it is the one the paragraph above is about. Same-length
 * candidates differing at their first versus their last byte measured 2.6830 us and 2.7000 us over
 * 200 000 iterations each. Those are indicative numbers from a shared host and are recorded to
 * bound the heading, not as a guarantee in either direction.
 *
 * Promoted here from usage-service at S-8, unedited. It is the comparison all three
 * `internal-auth.middleware.ts` guards use; billing's and worker's each wrote `!==` until then.
 *
 * **The constant-time property is not established by any test**, and should not be claimed from
 * a green suite. A timing assertion over this function is not reliably measurable in a vitest
 * process on a shared runner. What `packages/shared-utils/tests/unit.test.ts` establishes is
 * behavioural equivalence with the `!==` it replaced, plus that unequal lengths return `false`
 * rather than throwing. The security property rests on `crypto.timingSafeEqual`'s documented
 * contract and on the fixed-width-digest argument above.
 */
export const secretsMatch = (provided: string, expected: string): boolean => {
	const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

	return timingSafeEqual(digest(provided), digest(expected));
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
