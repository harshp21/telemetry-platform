export interface AuthenticatedRequestContext {
	userId: string;
	tenantId: string;
	role: "OWNER" | "ADMIN" | "MEMBER";
	jti: string;
	expiresAt: number;
}

declare module "fastify" {
	interface FastifyRequest {
		auth?: AuthenticatedRequestContext;
	}
}

export {};
