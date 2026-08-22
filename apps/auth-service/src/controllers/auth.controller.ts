import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AUTH_HTTP_STATUS, AUTH_VALIDATION } from "../constants";
import { AuthService } from "../services/auth.service";

const registerRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(AUTH_VALIDATION.PASSWORD_MIN_LENGTH),
	tenantName: z.string().trim().min(1)
});

type RegisterRequestBody = z.infer<typeof registerRequestSchema>;
export type { RegisterRequestBody };

const authService = new AuthService();

export const registerHandler = async (
	request: FastifyRequest<{ Body: RegisterRequestBody }>,
	reply: FastifyReply
): Promise<FastifyReply> => {
	const input = registerRequestSchema.parse(request.body);
	const data = await authService.register(input);

	return reply.status(AUTH_HTTP_STATUS.CREATED).send({ data });
};
