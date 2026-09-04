import type { TenantId, UserId } from "@telemetry/shared-types";
import type { AuthRole } from "../constants";

/**
 * The verified-token context. `userId` and `tenantId` are branded, so a plain `string` cannot
 * reach `UserRepository` through this object: the brand is applied at the JWT trust boundary --
 * `requireJwtAuth` in `jwt.plugin.ts`, the only producer, and the guard every authenticated
 * route registers -- rather than re-asserted with a cast at every call site. See
 * `.claude/rules/tenant-isolation.md`.
 *
 * If a second producer is ever added it must apply the brands in the same place and consult the
 * token denylist as `requireJwtAuth` does; a guard that verifies the signature alone accepts
 * revoked tokens. An unwired `requireLogoutAuth` did exactly that and was deleted rather than
 * left to be discovered and trusted.
 */
export interface AuthenticatedRequestContext {
	userId: UserId;
	tenantId: TenantId;
	role: AuthRole;
	jti: string;
	expiresAt: number;
}

declare module "fastify" {
	interface FastifyRequest {
		auth?: AuthenticatedRequestContext;
	}
}

export {};
