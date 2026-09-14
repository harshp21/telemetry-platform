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
import { DeadLetterService } from "../services/dead-letter.service";
// Type-only, so nothing from `src/events/**` is loaded here. `src/index.ts` dynamically imports
// `./events/stream.consumer` *after* `initTracing(...)` on purpose; a value import at this depth
// would pull that module into the graph ahead of it.
import type { StreamMessageHandler } from "../events/stream.consumer";

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
  /**
   * Retry accounting and the dead-letter write (T-041).
   *
   * A singleton, and correctly so, unlike `eventRepositoryFactory` above: it binds no tenant.
   * Its state is one stream name and one retry budget, both from the parsed environment, and
   * the counter it maintains is keyed by Redis entry id on a stream that is cross-tenant by
   * design. There is nothing here for a shared instance to pin.
   */
  readonly deadLetterService: DeadLetterService;
  /**
   * The handler `src/index.ts` hands `StreamConsumer` -- the processor's, wrapped in the retry
   * policy.
   *
   * Composed **here** rather than in `index.ts` so that the entrypoint stays a wiring file with
   * no policy in it, and so that the composition is assertable without booting a worker. `U69`
   * is what stops it being bypassed: an `index.ts` that passed
   * `container.eventProcessor.buildHandler()` instead would leave every `DeadLetterService`
   * unit case green and the feature connected to nothing.
   */
  readonly messageHandler: StreamMessageHandler;
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

  // Handed `redisClient` for the same reason the processor is: `StreamConsumer.run()` parks a
  // private `duplicate()` on a blocking `XREADGROUP`, and a command queued behind that read
  // waits it out (an unrelated `PING` during a `BLOCK 2000` came back after 2 080 ms -- T-039's
  // measurement, inherited and not re-run here). The retry pre-check runs on *every* delivered
  // entry, so putting it on the loop's connection would add a block window to the happy path.
  const deadLetterService = new DeadLetterService(redisClient, containerLogger, env);
  // The order of composition is the contract: the retry policy is on the **outside**, so it
  // sees the processor's failure and can decide whether to rethrow it or end it. Wrapping the
  // other way round is not expressible -- `wrap` takes the inner handler and returns the outer
  // one -- which is the point of the decorator shape (decision A).
  const messageHandler = deadLetterService.wrap(eventProcessor.buildHandler());

  return {
    serviceName,
    env,
    logger: containerLogger,
    prisma,
    redis: redisClient,
    eventRepositoryFactory,
    eventProcessor,
    deadLetterService,
    messageHandler
  };
};
