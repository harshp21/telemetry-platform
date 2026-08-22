import { initTracing } from "@telemetry/shared-tracing";
import { BILLING_SERVICE_STARTUP } from "./startup.constants";

initTracing(BILLING_SERVICE_STARTUP.SERVICE_NAME);

const start = async (): Promise<void> => {
	const { buildBillingServiceApp } = await import("./app");
	const app = buildBillingServiceApp();
	const port = Number(process.env.PORT ?? BILLING_SERVICE_STARTUP.DEFAULT_PORT);
	await app.listen({ port, host: BILLING_SERVICE_STARTUP.HOST });
};

void start();
