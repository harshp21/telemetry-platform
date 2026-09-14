import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { ServiceEnv } from "./env";
import { prisma } from "../lib/prisma";
import RedisClient from "ioredis";
import { createLogger } from "@telemetry/shared-logger";
import { EventRepository } from "../repositories/event.repository";
import {
  EventProcessorService,
  type EventRepositoryFactory
} from "../services/event-processor.service";

export interface AppContainer {
  readonly serviceName: string;
  readonly env: ServiceEnv;
  readonly logger: Logger;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  /**
   * Tenant-scoped, therefore a **factory** and never a singleton
   * (`.claude/rules/tenant-isolation.md`). `EventRepository` takes its `tenantId` as a
   * constructor argument, so one shared instance would pin whichever tenant's event this
   * worker happened to see first, for the life of the process, across every other tenant's
   * events on the same stream.
   */
  readonly eventRepositoryFactory: EventRepositoryFactory;
  readonly eventProcessor: EventProcessorService;
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
  // Per message, not per process -- see the interface member above.
  const eventRepositoryFactory: EventRepositoryFactory = (tenantId) =>
    new EventRepository(prisma, tenantId, containerLogger);
  // Handed `redisClient`, i.e. the container's connection, deliberately: `StreamConsumer.run()`
  // parks a private `duplicate()` on a blocking `XREADGROUP`, and an `XACK` queued behind that
  // read waits the block out (an unrelated `PING` during a `BLOCK 2000` came back after
  // 2 080 ms). The processor must not be given the loop's connection.
  const eventProcessor = new EventProcessorService(
    redisClient,
    containerLogger,
    env,
    eventRepositoryFactory
  );

  return {
    serviceName,
    env,
    logger: containerLogger,
    prisma,
    redis: redisClient,
    eventRepositoryFactory,
    eventProcessor
  };
};
