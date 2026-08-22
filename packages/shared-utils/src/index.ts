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
	occurredAt: string,
	source: string
): string => {
	return createHash("sha256")
		.update([tenantId, eventType, occurredAt, source].join("|"))
		.digest("hex");
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
