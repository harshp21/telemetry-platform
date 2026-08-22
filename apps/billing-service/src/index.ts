import { initTracing } from "@telemetry/shared-tracing";

initTracing("billing-service");

const start = async (): Promise<void> => {
	const { buildBillingServiceApp } = await import("./app");
	const app = buildBillingServiceApp();
  const port = Number(process.env.PORT ?? 3004);
  await app.listen({ port, host: "0.0.0.0" });
};

void start();
