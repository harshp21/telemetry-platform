import { describe, expect, it } from "vitest";
import { buildUsageServiceApp } from "../src/app";
import { USAGE_SERVICE_NAME, USAGE_SERVICE_RESPONSES, USAGE_SERVICE_ROUTES, USAGE_SERVICE_RUNTIME } from "../src/constants";

describe("usage-service smoke", () => {
  it("returns healthy status", async () => {
    const useExternalTarget = process.env.SMOKE_TARGET === "external";

    if (useExternalTarget) {
      const response = await fetch(`http://127.0.0.1:${USAGE_SERVICE_RUNTIME.DEFAULT_PORT}${USAGE_SERVICE_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ status: USAGE_SERVICE_RESPONSES.STATUS_OK, service: USAGE_SERVICE_NAME });
      return;
    }

    const app = buildUsageServiceApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();

    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve usage-service listening address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${USAGE_SERVICE_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ status: USAGE_SERVICE_RESPONSES.STATUS_OK, service: USAGE_SERVICE_NAME });
    } finally {
      await app.close();
    }
  });
});
