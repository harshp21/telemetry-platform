import { initTracing } from "@telemetry/shared-tracing";

initTracing("usage-service");

const start = async (): Promise<void> => {
	const { buildUsageServiceApp } = await import("./app");
	const app = buildUsageServiceApp();
  const port = Number(process.env.PORT ?? 3002);
  await app.listen({ port, host: "0.0.0.0" });
};

void start();
