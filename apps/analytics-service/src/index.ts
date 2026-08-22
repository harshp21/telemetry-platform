import { initTracing } from "@telemetry/shared-tracing";
import { ANALYTICS_SERVICE_STARTUP } from "./startup.constants";

const loadLocalEnv = (): void => {
	if (typeof process.loadEnvFile === "function") {
		process.loadEnvFile();
	}
};

initTracing(ANALYTICS_SERVICE_STARTUP.SERVICE_NAME);

const start = async (): Promise<void> => {
	loadLocalEnv();
	const { buildAnalyticsServiceApp } = await import("./app");
	const app = buildAnalyticsServiceApp();
	const port = Number(process.env.PORT ?? ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: ANALYTICS_SERVICE_STARTUP.HOST });
};

void start();
