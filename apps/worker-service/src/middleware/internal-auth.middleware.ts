import type { FastifyReply, FastifyRequest } from "fastify";
import { WORKER_HEADERS, WORKER_RESPONSES } from "../constants";

export const buildInternalAuthMiddleware = (internalApiSecret: string) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const providedSecret = request.headers[WORKER_HEADERS.INTERNAL_SECRET];
    const normalizedSecret = Array.isArray(providedSecret) ? providedSecret[0] : providedSecret;

    if (normalizedSecret !== internalApiSecret) {
      reply.status(401).send({ code: WORKER_RESPONSES.CODE_UNAUTHORIZED });
    }
  };
};
