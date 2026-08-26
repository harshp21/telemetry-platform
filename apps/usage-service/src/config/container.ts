import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { ServiceEnv } from "./env";
import { prisma } from "../lib/prisma";
import RedisClient from "ioredis";
import { createLogger } from "@telemetry/shared-logger";
import { DeduplicationService } from "../services/deduplication.service";
import { StreamPublisher } from "../events/stream.publisher";

export interface AppContainer {
  readonly serviceName: string;
  readonly env: ServiceEnv;
  readonly logger: Logger;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly deduplication: DeduplicationService;
  readonly streamPublisher: StreamPublisher;
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

  // Add error listener for connection failures
  redisClient.on("error", (err: Error) => {
    const defaultLogger = logger || createLogger(serviceName);
    defaultLogger.error(
      { error: err.message, service: serviceName },
      "Redis connection error"
    );
  });

  const containerLogger = logger ?? createLogger(serviceName);

  return {
    serviceName,
    env,
    logger: containerLogger,
    prisma,
    redis: redisClient,
    deduplication: new DeduplicationService(redisClient, containerLogger),
    streamPublisher: new StreamPublisher(redisClient, containerLogger, env)
  };
};
