import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  GATEWAY_GUARDS,
  GATEWAY_HEADERS,
  GATEWAY_RESPONSES,
  GATEWAY_SPOOFABLE_HEADERS
} from "../constants";

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

// Every header an upstream is entitled to trust is removed here and re-set by the gateway from
// its own verified state. `x-internal-secret` is in that set for the same reason the identity
// headers are: usage-service reads it as proof the request came through the gateway (S-4), so
// accepting one from outside would hand a caller exactly the claim the guard exists to check.
const stripSpoofableIdentityHeaders = (request: FastifyRequest): void => {
  for (const header of GATEWAY_SPOOFABLE_HEADERS) {
    delete request.headers[header];
  }
};

const ensureRequestId = (request: FastifyRequest): void => {
  if (!request.headers[GATEWAY_HEADERS.REQUEST_ID]) {
    request.headers[GATEWAY_HEADERS.REQUEST_ID] = randomUUID();
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