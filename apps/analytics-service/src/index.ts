import { initTracing } from "@telemetry/shared-tracing";

initTracing("analytics-service");

const start = async (): Promise<void> => {
	const { buildAnalyticsServiceApp } = await import("./app");
	const app = buildAnalyticsServiceApp();
  const port = Number(process.env.PORT ?? 3005);
  await app.listen({ port, host: "0.0.0.0" });
};

void start();
