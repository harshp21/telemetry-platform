import { initTracing } from "@telemetry/shared-tracing";

initTracing("gateway");

const start = async (): Promise<void> => {
	const { buildGatewayApp } = await import("./app");
	const app = buildGatewayApp();
  const port = Number(process.env.PORT ?? 3100);
  await app.listen({ port, host: "0.0.0.0" });
};

void start();
