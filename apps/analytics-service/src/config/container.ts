import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { TenantId } from "@telemetry/shared-types";
import type { ServiceEnv } from "./env";
import { prisma } from "../lib/prisma";
import RedisClient from "ioredis";
import { createLogger } from "@telemetry/shared-logger";
import { RollupRepository } from "../repositories/rollup.repository";
import { AnalyticsService, type RollupRepositoryFactory } from "../services/analytics.service";
import { AnalyticsController } from "../controllers/analytics.controller";

export interface AppContainer {
  readonly serviceName: string;
  readonly env: ServiceEnv;
  readonly logger: Logger;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  /**
   * **A factory, never a singleton.** `RollupRepository` takes its `tenantId` as a constructor
   * argument, so a single shared instance would pin one tenant process-wide
   * (`.claude/rules/tenant-isolation.md` § *Required*). T-051 makes analytics the first service
   * here to hold a tenant-scoped repository at all.
   */
  readonly rollupRepositoryFactory: RollupRepositoryFactory;
  readonly analyticsService: AnalyticsService;
  readonly analyticsController: AnalyticsController;
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

  const rollupRepositoryFactory: RollupRepositoryFactory = (tenantId: TenantId) =>
    new RollupRepository(prisma, tenantId, containerLogger);

  // Reuses the same per-request factory rather than constructing its own, so there is one
  // definition of how a tenant-scoped repository is built.
  const analyticsService = new AnalyticsService(rollupRepositoryFactory, containerLogger);
  const analyticsController = new AnalyticsController(analyticsService, containerLogger);

  return {
    serviceName,
    env,
    logger: containerLogger,
    prisma,
    redis: redisClient,
    rollupRepositoryFactory,
    analyticsService,
    analyticsController
  };
};
