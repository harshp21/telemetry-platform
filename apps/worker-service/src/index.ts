import Fastify from "fastify";
import { createContainer } from "@/config/container";

const serviceName = "worker-service";
const app = Fastify({ logger: true });
const container = createContainer(serviceName);

app.get("/health", async () => {
  return {
    status: "ok",
    service: container.serviceName
  };
});

const start = async (): Promise<void> => {
  const port = Number(process.env.PORT ?? 3003);
  await app.listen({ port, host: "0.0.0.0" });
};

void start();
