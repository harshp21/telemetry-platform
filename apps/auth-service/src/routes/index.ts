import type { FastifyInstance } from "fastify";
import { AUTH_ROUTES } from "../constants";
import type { LoginRequestBody, RegisterRequestBody } from "../controllers/auth.controller";

export const registerAuthRoutes = async (app: FastifyInstance): Promise<void> => {
	app.post<{ Body: RegisterRequestBody }>(AUTH_ROUTES.REGISTER, async (request, reply) => {
		const { registerHandler } = await import("../controllers/auth.controller");

		return registerHandler(request, reply);
	});

	app.post<{ Body: LoginRequestBody }>(AUTH_ROUTES.LOGIN, async (request, reply) => {
		const { loginHandler } = await import("../controllers/auth.controller");

		return loginHandler(request, reply);
	});
};
