import { initTracing } from "@telemetry/shared-tracing";
import { WORKER_SERVICE_STARTUP } from "./startup.constants";

const loadLocalEnv = (): void => {
	if (typeof process.loadEnvFile === "function") {
		process.loadEnvFile();
	}
};

initTracing(WORKER_SERVICE_STARTUP.SERVICE_NAME);

const start = async (): Promise<void> => {
	loadLocalEnv();
	const { buildWorkerServiceApp } = await import("./app");
	const app = buildWorkerServiceApp();
	const port = Number(process.env.PORT ?? WORKER_SERVICE_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: WORKER_SERVICE_STARTUP.HOST });
};

void start();
