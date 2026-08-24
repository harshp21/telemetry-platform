import type { FastifyInstance } from "fastify";
import { AUTH_ROUTES } from "../constants";
import type {
	LoginRequestBody,
	RefreshRequestBody,
	RegisterRequestBody
} from "../controllers/auth.controller";
import { requireJwtAuth } from "../plugins/jwt.plugin";

export const registerAuthRoutes = async (app: FastifyInstance): Promise<void> => {
	app.post<{ Body: RegisterRequestBody }>(AUTH_ROUTES.REGISTER, async (request, reply) => {
		const { registerHandler } = await import("../controllers/auth.controller");

		return registerHandler(request, reply);
	});

	app.post<{ Body: LoginRequestBody }>(AUTH_ROUTES.LOGIN, async (request, reply) => {
		const { loginHandler } = await import("../controllers/auth.controller");

		return loginHandler(request, reply);
	});

	app.post<{ Body: RefreshRequestBody }>(AUTH_ROUTES.REFRESH, async (request, reply) => {
		const { refreshHandler } = await import("../controllers/auth.controller");

		return refreshHandler(request, reply);
	});

	app.post(AUTH_ROUTES.LOGOUT, { preHandler: [requireJwtAuth] }, async (request, reply) => {
		const { logoutHandler } = await import("../controllers/auth.controller");

		return logoutHandler(request, reply);
	});
};
