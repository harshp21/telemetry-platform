import { initTracing } from "@telemetry/shared-tracing";
import { AUTH_STARTUP } from "./startup.constants";

const loadLocalEnv = (): void => {
	if (typeof process.loadEnvFile === "function") {
		process.loadEnvFile();
	}
};

initTracing(AUTH_STARTUP.SERVICE_NAME);

const start = async (): Promise<void> => {
	loadLocalEnv();
	const { buildAuthServiceApp } = await import("./app");
	const app = buildAuthServiceApp();
	const port = Number(process.env.PORT ?? AUTH_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: AUTH_STARTUP.HOST });
};

void start();
