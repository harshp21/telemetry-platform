import { initTracing } from "@telemetry/shared-tracing";
import { GATEWAY_STARTUP } from "./startup.constants";

const loadLocalEnv = (): void => {
	if (typeof process.loadEnvFile === "function") {
		process.loadEnvFile();
	}
};

initTracing(GATEWAY_STARTUP.SERVICE_NAME);

const start = async (): Promise<void> => {
	loadLocalEnv();
	const { buildGatewayApp } = await import("./app");
	const app = buildGatewayApp();
	const container = app.container;
	let isShuttingDown = false;

	const shutdown = async (signal: string): Promise<void> => {
		container.logger.info({ signal }, "Shutting down gracefully");
		try {
			await app.close();
			// Redis disconnect: quit() called via app.close() → onClose hook;
			// disconnect() here ensures immediate cleanup even if quit() fails.
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

	const port = Number(process.env.PORT ?? GATEWAY_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: GATEWAY_STARTUP.HOST });
};

void start();
