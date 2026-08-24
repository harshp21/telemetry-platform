import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AUTH_HTTP_STATUS, AUTH_VALIDATION } from "../constants";
import { UnauthorizedError } from "../errors";
import { AuthService } from "../services/auth.service";

const registerRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(AUTH_VALIDATION.PASSWORD_MIN_LENGTH),
	tenantName: z.string().trim().min(1)
});

const loginRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(AUTH_VALIDATION.PASSWORD_MIN_LENGTH)
});

const refreshRequestSchema = z.object({
	refreshToken: z.string().min(1)
});

type RegisterRequestBody = z.infer<typeof registerRequestSchema>;
type LoginRequestBody = z.infer<typeof loginRequestSchema>;
type RefreshRequestBody = z.infer<typeof refreshRequestSchema>;
export type { LoginRequestBody, RefreshRequestBody, RegisterRequestBody };

const authService = new AuthService();

export const registerHandler = async (
	request: FastifyRequest<{ Body: RegisterRequestBody }>,
	reply: FastifyReply
): Promise<FastifyReply> => {
	const input = registerRequestSchema.parse(request.body);
	const data = await authService.register(input);

	return reply.status(AUTH_HTTP_STATUS.CREATED).send({ data });
};

export const loginHandler = async (
	request: FastifyRequest<{ Body: LoginRequestBody }>,
	reply: FastifyReply
): Promise<FastifyReply> => {
	const input = loginRequestSchema.parse(request.body);
	const data = await authService.login(input);

	return reply.status(AUTH_HTTP_STATUS.OK).send({ data });
};

export const refreshHandler = async (
	request: FastifyRequest<{ Body: RefreshRequestBody }>,
	reply: FastifyReply
): Promise<FastifyReply> => {
	const input = refreshRequestSchema.parse(request.body);
	const data = await authService.refresh(input);

	return reply.status(AUTH_HTTP_STATUS.OK).send({ data });
};

export const logoutHandler = async (
	request: FastifyRequest,
	reply: FastifyReply
): Promise<FastifyReply> => {
	if (!request.auth) {
		throw new UnauthorizedError();
	}

	await authService.logout(request.auth);

	return reply.status(AUTH_HTTP_STATUS.NO_CONTENT).send();
};
