import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { ServiceEnv } from "./env";
import { prisma } from "../lib/prisma";
import RedisClient from "ioredis";
import { createLogger } from "@telemetry/shared-logger";
import { MeterRepository } from "../repositories/meter.repository";
import { InvoiceRepository } from "../repositories/invoice.repository";
import {
  BillingService,
  type InvoiceRepositoryFactory,
  type MeterRepositoryFactory
} from "../services/billing.service";
import { InternalController } from "../controllers/internal.controller";

export interface AppContainer {
  readonly serviceName: string;
  readonly env: ServiceEnv;
  readonly logger: Logger;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly meterRepositoryFactory: MeterRepositoryFactory;
  readonly invoiceRepositoryFactory: InvoiceRepositoryFactory;
  readonly billingService: BillingService;
  readonly internalController: InternalController;
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
  // Tenant-scoped repositories are per-request by construction -- `tenantId` is a constructor
  // argument -- so both are exposed as factories. A singleton would pin one tenant
  // process-wide (`.claude/rules/tenant-isolation.md`), and BU63 asserts two calls with
  // different tenants are different instances.
  const meterRepositoryFactory: MeterRepositoryFactory = (tenantId) =>
    new MeterRepository(prisma, tenantId, containerLogger);
  const invoiceRepositoryFactory: InvoiceRepositoryFactory = (tenantId) =>
    new InvoiceRepository(prisma, tenantId, containerLogger);
  const billingService = new BillingService(
    meterRepositoryFactory,
    invoiceRepositoryFactory,
    containerLogger
  );
  const internalController = new InternalController(billingService, containerLogger);

  return {
    serviceName,
    env,
    logger: containerLogger,
    prisma,
    redis: redisClient,
    meterRepositoryFactory,
    invoiceRepositoryFactory,
    billingService,
    internalController
  };
};
