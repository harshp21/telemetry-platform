import { initTracing } from "@telemetry/shared-tracing";
import { ANALYTICS_SERVICE_STARTUP } from "./startup.constants";

initTracing(ANALYTICS_SERVICE_STARTUP.SERVICE_NAME);

const start = async (): Promise<void> => {
	const { buildAnalyticsServiceApp } = await import("./app");
	const app = buildAnalyticsServiceApp();
	const port = Number(process.env.PORT ?? ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: ANALYTICS_SERVICE_STARTUP.HOST });
};

void start();
