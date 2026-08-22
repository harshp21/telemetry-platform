import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthService } from "../services/auth.service";

const registerRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
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

	return reply.status(201).send({ data });
};
