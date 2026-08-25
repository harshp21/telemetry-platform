import { initTracing } from "@telemetry/shared-tracing";
import { WORKER_SERVICE_STARTUP } from "./startup.constants";

const loadLocalEnv = (): void => {
	if (typeof process.loadEnvFile === "function") {
		process.loadEnvFile();
	}
};

initTracing(WORKER_SERVICE_STARTUP.SERVICE_NAME);

export let shuttingDown = false;

const start = async (): Promise<void> => {
	loadLocalEnv();
	const { buildWorkerServiceApp } = await import("./app");
	const app = buildWorkerServiceApp();
	const container = app.container;

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
		void shutdown("SIGTERM");
	});
	process.on("SIGINT", () => {
		void shutdown("SIGINT");
	});

	const port = Number(process.env.PORT ?? WORKER_SERVICE_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: WORKER_SERVICE_STARTUP.HOST });
};

void start();
