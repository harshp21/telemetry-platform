import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { TenantId } from "@telemetry/shared-types";
import type { ServiceEnv } from "./env";
import { prisma } from "../lib/prisma";
import RedisClient from "ioredis";
import { createLogger } from "@telemetry/shared-logger";
import { DeduplicationService } from "../services/deduplication.service";
import { StreamPublisher } from "../events/stream.publisher";
import { IngestionService } from "../services/ingestion.service";
import { UsageService, type UsageRepositoryFactory } from "../services/usage.service";
import { UsageRepository } from "../repositories/usage.repository";
import { EventsController } from "../controllers/events.controller";
import { UsageController } from "../controllers/usage.controller";

export interface AppContainer {
  readonly serviceName: string;
  readonly env: ServiceEnv;
  readonly logger: Logger;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly deduplication: DeduplicationService;
  readonly streamPublisher: StreamPublisher;
  readonly ingestionService: IngestionService;
  readonly usageRepositoryFactory: UsageRepositoryFactory;
  readonly usageService: UsageService;
  readonly eventsController: EventsController;
  readonly usageController: UsageController;
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
  const deduplication = new DeduplicationService(redisClient, containerLogger);
  const streamPublisher = new StreamPublisher(redisClient, containerLogger, env);
  const ingestionService = new IngestionService(deduplication, streamPublisher, containerLogger);
  const eventsController = new EventsController(ingestionService, containerLogger);
  // Tenant-scoped repositories are per-request, so the container exposes a factory.
  const usageRepositoryFactory: UsageRepositoryFactory = (tenantId) =>
    new UsageRepository(prisma, tenantId as TenantId, containerLogger);
  const usageService = new UsageService(usageRepositoryFactory, containerLogger);
  const usageController = new UsageController(usageService, containerLogger);

  return {
    serviceName,
    env,
    logger: containerLogger,
    prisma,
    redis: redisClient,
    deduplication,
    streamPublisher,
    ingestionService,
    usageRepositoryFactory,
    usageService,
    eventsController,
    usageController
  };
};
