import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import { GATEWAY_PUBLIC_ROUTES } from "../constants";

export interface GatewayAuthContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: string;
}

declare module "fastify" {
  interface FastifyRequest {
    authContext?: GatewayAuthContext;
  }
}

const PUBLIC_ROUTE_KEYS = new Set<string>([
  ...GATEWAY_PUBLIC_ROUTES.map((route) => `${route.method} ${route.path}`)
]);

const getPathname = (url: string): string => {
  const queryIndex = url.indexOf("?");

  if (queryIndex === -1) {
    return url;
  }

  return url.slice(0, queryIndex);
};

const isPublicRoute = (request: FastifyRequest): boolean => {
  const pathname = getPathname(request.url);
  return PUBLIC_ROUTE_KEYS.has(`${request.method.toUpperCase()} ${pathname}`);
};

const unauthorized = (reply: FastifyReply, code: string): FastifyReply => {
  return reply.status(401).send({ code });
};

const isTokenExpiredError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return (error as { code?: string }).code === "ERR_JWT_EXPIRED";
};

const getJwtSecret = (): Uint8Array => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("Missing required gateway environment variable: JWT_SECRET");
  }

  return new TextEncoder().encode(secret);
};

const getAuthContextFromPayload = (payload: Record<string, unknown>): GatewayAuthContext | null => {
  const userId = payload.sub;
  const tenantId = payload.tenantId;
  const role = payload.role;

  if (typeof userId !== "string" || typeof tenantId !== "string" || typeof role !== "string") {
    return null;
  }

  return { userId, tenantId, role };
};

export const gatewayJwtAuthPreHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  if (isPublicRoute(request)) {
    return;
  }

  const authorizationHeader = request.headers.authorization;

  if (!authorizationHeader) {
    unauthorized(reply, "TOKEN_MISSING");
    return;
  }

  const [scheme, token] = authorizationHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    unauthorized(reply, "TOKEN_INVALID");
    return;
  }

  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), { algorithms: ["HS256"] });
    const authContext = getAuthContextFromPayload(payload as Record<string, unknown>);

    if (!authContext) {
      unauthorized(reply, "TOKEN_INVALID");
      return;
    }

    request.authContext = authContext;
  } catch (error: unknown) {
    if (isTokenExpiredError(error)) {
      unauthorized(reply, "TOKEN_EXPIRED");
      return;
    }

    unauthorized(reply, "TOKEN_INVALID");
  }
};
