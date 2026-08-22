import { initTracing } from "@telemetry/shared-tracing";

initTracing("worker-service");

const start = async (): Promise<void> => {
	const { buildWorkerServiceApp } = await import("./app");
	const app = buildWorkerServiceApp();
  const port = Number(process.env.PORT ?? 3003);
  await app.listen({ port, host: "0.0.0.0" });
};

void start();
