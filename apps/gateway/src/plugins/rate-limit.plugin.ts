import fastifyRateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Redis from "ioredis";
import {
  GATEWAY_PUBLIC_ROUTES,
  GATEWAY_RESPONSES,
  GATEWAY_USAGE_ROUTES
} from "../constants";

export interface GatewayRateLimitConfig {
  readonly redis?: Redis;
  readonly redisUrl: string;
  readonly nodeEnv: string;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly ingestionRateLimitMax: number;
}

const PUBLIC_ROUTE_KEYS = new Set<string>(
  GATEWAY_PUBLIC_ROUTES.map((route) => `${route.method} ${route.path}`)
);

const getPathname = (url: string): string => {
  const queryIndex = url.indexOf("?");

  if (queryIndex === -1) {
    return url;
  }

  return url.slice(0, queryIndex);
};

const isPublicRoute = (request: FastifyRequest): boolean => {
  return PUBLIC_ROUTE_KEYS.has(`${request.method.toUpperCase()} ${getPathname(request.url)}`);
};

const isIngestionRoute = (request: FastifyRequest): boolean => {
  return getPathname(request.url) === GATEWAY_USAGE_ROUTES.EVENTS;
};

export const registerGatewayRateLimit = (
  app: FastifyInstance,
  config: GatewayRateLimitConfig
): void => {
  // Use passed Redis client (from container) if available;
  // only create new client if not provided (for backward compatibility).
  const redisClient =
    config.nodeEnv === "test"
      ? undefined
      : config.redis ?? new Redis(config.redisUrl, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          lazyConnect: true
        });

  // Only manage lifecycle for clients we created (not container-managed).
  if (redisClient && !config.redis) {
    app.addHook("onClose", async () => {
      await redisClient.quit();
    });
  }

  app.register(fastifyRateLimit, {
    global: true,
    hook: "onRequest",
    skipOnError: true,
    redis: redisClient,
    keyGenerator: (request: FastifyRequest) => request.authContext?.tenantId ?? `ip:${request.ip}`,
    allowList: (request: FastifyRequest) => isPublicRoute(request),
    max: (request: FastifyRequest) =>
      isIngestionRoute(request) ? config.ingestionRateLimitMax : config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    addHeaders: {
      "retry-after": true
    },
    errorResponseBuilder: (_request, context) => {
      const retryAfterSeconds = Math.max(1, Math.ceil(Number(context.after) / 1000));

      return {
        code: GATEWAY_RESPONSES.CODE_RATE_LIMIT_EXCEEDED,
        retryAfter: retryAfterSeconds,
        limit: context.max,
        current: context.max + 1
      };
    }
  });
};