import type { Logger } from "pino";
import type Redis from "ioredis";
import type { ServiceEnv } from "./env";
import RedisClient from "ioredis";
import { createLogger } from "@telemetry/shared-logger";

export interface AppContainer {
  readonly serviceName: string;
  readonly env: ServiceEnv;
  readonly logger: Logger;
  readonly redis: Redis;
}

export const createContainer = (
  serviceName: string,
  env: ServiceEnv,
  logger?: Logger
): AppContainer => {
  const redisClient = new RedisClient(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true
  });

  return {
    serviceName,
    env,
    logger: logger ?? createLogger(serviceName),
    redis: redisClient
  };
};
