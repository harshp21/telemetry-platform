import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AUTH_HTTP_STATUS, AUTH_VALIDATION } from "../constants";
import { UnauthorizedError } from "../errors";
import { AuthService } from "../services/auth.service";
import {
	clearSessionCookies,
	getRefreshTokenFromCookie,
	setSessionCookies,
	validateCsrfToken
} from "../utils/session-cookie";

const registerRequestSchema = z.object({
	firstName: z.string().trim().min(1),
	lastName: z.string().trim().min(1),
	email: z.string().email(),
	password: z.string().min(AUTH_VALIDATION.PASSWORD_MIN_LENGTH),
	tenantName: z.string().trim().min(1)
});

const loginRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(AUTH_VALIDATION.PASSWORD_MIN_LENGTH)
});

type RegisterRequestBody = z.infer<typeof registerRequestSchema>;
type LoginRequestBody = z.infer<typeof loginRequestSchema>;
export type { LoginRequestBody, RegisterRequestBody };

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
	setSessionCookies(reply, data.refreshToken, data.expiresInSeconds);
	const { refreshToken: _refreshToken, ...responseData } = data;
	void _refreshToken;

	return reply.status(AUTH_HTTP_STATUS.OK).send({ data: responseData });
};

export const refreshHandler = async (
	request: FastifyRequest,
	reply: FastifyReply
): Promise<FastifyReply> => {
	const refreshToken = getRefreshTokenFromCookie(request);
	validateCsrfToken(request);
	const data = await authService.refresh({ refreshToken });
	setSessionCookies(reply, data.refreshToken, data.expiresInSeconds);
	const { refreshToken: _refreshToken, ...responseData } = data;
	void _refreshToken;

	return reply.status(AUTH_HTTP_STATUS.OK).send({ data: responseData });
};

export const logoutHandler = async (
	request: FastifyRequest,
	reply: FastifyReply
): Promise<FastifyReply> => {
	if (!request.auth) {
		throw new UnauthorizedError();
	}

	validateCsrfToken(request);

	await authService.logout(request.auth);
	clearSessionCookies(reply);

	return reply.status(AUTH_HTTP_STATUS.NO_CONTENT).send();
};
