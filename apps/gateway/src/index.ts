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
	const port = Number(process.env.PORT ?? GATEWAY_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: GATEWAY_STARTUP.HOST });
};

void start();
