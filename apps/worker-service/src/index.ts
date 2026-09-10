import { initTracing } from "@telemetry/shared-tracing";
import { WORKER_SERVICE_STARTUP } from "./startup.constants";

type EnvLoadError = Error & { code?: string };

const loadLocalEnv = (): void => {
	if (typeof process.loadEnvFile === "function") {
		try {
			process.loadEnvFile();
		} catch (error) {
			if ((error as EnvLoadError).code !== "ENOENT") {
				throw error;
			}
		}
	}
};

initTracing(WORKER_SERVICE_STARTUP.SERVICE_NAME);

// Exported for T-039 (stream consumer loop) to signal graceful shutdown.
// Stream consumer should check this flag in its loop condition.
export let shuttingDown = false;

const start = async (): Promise<void> => {
	loadLocalEnv();
	const { buildWorkerServiceApp } = await import("./app");
	// Dynamically imported alongside `./app`, not statically at the top of this file:
	// `stream.consumer.ts` pulls in `./constants`, which pulls in `@telemetry/shared-types`.
	// Only `startup.constants.ts` may load before `initTracing(...)`.
	const { StreamConsumer } = await import("./events/stream.consumer");
	const app = buildWorkerServiceApp();
	const container = app.container;
	let isShuttingDown = false;

	const shutdown = async (signal: string): Promise<void> => {
		shuttingDown = true;
		container.logger.info({ signal }, "Shutting down gracefully");
		try {
			await app.close();
			await container.prisma.$disconnect();
			container.redis.disconnect();
			container.logger.info("Shutdown complete");
			process.exit(0);
		} catch (error) {
			container.logger.error({ error, signal }, "Error during shutdown");
			process.exit(1);
		}
	};

	process.on("SIGTERM", () => {
		if (!isShuttingDown) {
			isShuttingDown = true;
			void shutdown("SIGTERM");
		}
	});
	process.on("SIGINT", () => {
		if (!isShuttingDown) {
			isShuttingDown = true;
			void shutdown("SIGINT");
		}
	});

	// T-038. Bootstrap the consumer group *before* binding the listener: a worker answering
	// `/health` while its group does not exist reports healthy and consumes nothing. Placed
	// after the signal handlers so a SIGTERM arriving during the Redis round-trip is still
	// handled. `tests/index.graceful-shutdown.unit.test.ts` asserts the ordering by
	// invocation order, not by two independent call checks.
	//
	// Fail-closed (D3): anything other than an already-exists reply propagates out of
	// `start()` into the `.catch` below, which exits non-zero. This is a startup behaviour
	// change -- a worker can no longer start without a reachable Redis. Against a port
	// nothing listens on, the container's client options rejected in ~160 ms with
	// `MaxRetriesPerRequestError`, so the failure is fast rather than a hang.
	const streamConsumer = new StreamConsumer(container.redis, container.logger, container.env);
	await streamConsumer.ensureConsumerGroup();

	const port = Number(process.env.PORT ?? WORKER_SERVICE_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: WORKER_SERVICE_STARTUP.HOST });
};

void start().catch((error) => {
	console.error(error);
	process.exit(1);
});
