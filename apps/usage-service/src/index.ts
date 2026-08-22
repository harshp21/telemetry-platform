import { initTracing } from "@telemetry/shared-tracing";
import { USAGE_SERVICE_STARTUP } from "./startup.constants";

const loadLocalEnv = (): void => {
	if (typeof process.loadEnvFile === "function") {
		process.loadEnvFile();
	}
};

initTracing(USAGE_SERVICE_STARTUP.SERVICE_NAME);

const start = async (): Promise<void> => {
	loadLocalEnv();
	const { buildUsageServiceApp } = await import("./app");
	const app = buildUsageServiceApp();
	const port = Number(process.env.PORT ?? USAGE_SERVICE_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: USAGE_SERVICE_STARTUP.HOST });
};

void start();
