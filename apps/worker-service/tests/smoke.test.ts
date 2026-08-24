import { describe, expect, it } from "vitest";
import { buildWorkerServiceApp } from "../src/app";
import { WORKER_RESPONSES, WORKER_ROUTES, WORKER_RUNTIME, WORKER_SERVICE_NAME } from "../src/constants";

describe("worker-service smoke", () => {
  it("returns healthy status", async () => {
    const useExternalTarget = process.env.SMOKE_TARGET === "external";

    if (useExternalTarget) {
      const response = await fetch(`http://127.0.0.1:${WORKER_RUNTIME.DEFAULT_PORT}${WORKER_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ status: WORKER_RESPONSES.STATUS_OK, service: WORKER_SERVICE_NAME });
      return;
    }

    const app = buildWorkerServiceApp({ internalApiSecret: "test-secret" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();

    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve worker-service listening address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${WORKER_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ status: WORKER_RESPONSES.STATUS_OK, service: WORKER_SERVICE_NAME });
    } finally {
      await app.close();
    }
  });
});
