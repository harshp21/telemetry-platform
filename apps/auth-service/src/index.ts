import { initTracing } from "@telemetry/shared-tracing";

initTracing("auth-service");

const start = async (): Promise<void> => {
	const { buildAuthServiceApp } = await import("./app");
	const app = buildAuthServiceApp();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
};

void start();
