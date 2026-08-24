import { describe, expect, it } from "vitest";
import { buildAnalyticsServiceApp } from "../src/app";
import { ANALYTICS_RESPONSES, ANALYTICS_ROUTES, ANALYTICS_RUNTIME, ANALYTICS_SERVICE_NAME } from "../src/constants";

describe("analytics-service smoke", () => {
  it("returns healthy status", async () => {
    const useExternalTarget = process.env.SMOKE_TARGET === "external";

    if (useExternalTarget) {
      const response = await fetch(`http://127.0.0.1:${ANALYTICS_RUNTIME.DEFAULT_PORT}${ANALYTICS_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ status: ANALYTICS_RESPONSES.STATUS_OK, service: ANALYTICS_SERVICE_NAME });
      return;
    }

    const app = buildAnalyticsServiceApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();

    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve analytics-service listening address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${ANALYTICS_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ status: ANALYTICS_RESPONSES.STATUS_OK, service: ANALYTICS_SERVICE_NAME });
    } finally {
      await app.close();
    }
  });
});
