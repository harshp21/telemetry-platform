import type { FastifyReply, FastifyRequest } from "fastify";
import { BILLING_HEADERS, BILLING_RESPONSES } from "../constants";

export const buildInternalAuthMiddleware = (internalApiSecret: string) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const providedSecret = request.headers[BILLING_HEADERS.INTERNAL_SECRET];
    const normalizedSecret = Array.isArray(providedSecret) ? providedSecret[0] : providedSecret;

    if (normalizedSecret !== internalApiSecret) {
      reply.status(401).send({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
    }
  };
};
