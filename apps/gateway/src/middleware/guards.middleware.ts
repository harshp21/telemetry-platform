import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { GATEWAY_GUARDS, GATEWAY_RESPONSES } from "../constants";

const WRITE_METHODS = new Set<string>(["POST", "PUT", "PATCH"]);

const getFirstHeaderValue = (
  value: string | string[] | undefined
): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
};

const getContentLength = (request: FastifyRequest): number | null => {
  const header = getFirstHeaderValue(request.headers["content-length"]);

  if (!header) {
    return null;
  }

  const parsed = Number(header);
  return Number.isFinite(parsed) ? parsed : null;
};

const isWriteMethod = (method: string): boolean => {
  return WRITE_METHODS.has(method.toUpperCase());
};

const isJsonContentType = (request: FastifyRequest): boolean => {
  const header = getFirstHeaderValue(request.headers["content-type"]);

  if (!header) {
    return false;
  }

  const mediaType = header.split(";")[0]?.trim().toLowerCase();
  return mediaType === GATEWAY_GUARDS.JSON_CONTENT_TYPE;
};

const stripSpoofableIdentityHeaders = (request: FastifyRequest): void => {
  delete request.headers["x-tenant-id"];
  delete request.headers["x-user-id"];
  delete request.headers["x-user-role"];
};

const ensureRequestId = (request: FastifyRequest): void => {
  if (!request.headers["x-request-id"]) {
    request.headers["x-request-id"] = randomUUID();
  }
};

export const gatewayRequestGuardsPreHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const contentLength = getContentLength(request);

  if (
    contentLength !== null &&
    contentLength > GATEWAY_GUARDS.MAX_CONTENT_LENGTH_BYTES
  ) {
    reply.status(413).send({ code: GATEWAY_RESPONSES.CODE_PAYLOAD_TOO_LARGE });
    return;
  }

  if (isWriteMethod(request.method) && !isJsonContentType(request)) {
    reply.status(415).send({ code: GATEWAY_RESPONSES.CODE_UNSUPPORTED_MEDIA_TYPE });
    return;
  }

  stripSpoofableIdentityHeaders(request);
  ensureRequestId(request);
};