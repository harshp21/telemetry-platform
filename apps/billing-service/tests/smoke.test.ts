import { describe, expect, it } from "vitest";
import { buildBillingServiceApp } from "../src/app";
import { BILLING_RESPONSES, BILLING_ROUTES, BILLING_RUNTIME, BILLING_SERVICE_NAME } from "../src/constants";

describe("billing-service smoke", () => {
  it("returns healthy status", async () => {
    const useExternalTarget = process.env.SMOKE_TARGET === "external";

    if (useExternalTarget) {
      const response = await fetch(`http://127.0.0.1:${BILLING_RUNTIME.DEFAULT_PORT}${BILLING_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ status: BILLING_RESPONSES.STATUS_OK, service: BILLING_SERVICE_NAME });
      return;
    }

    const app = buildBillingServiceApp({ internalApiSecret: "test-secret" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();

    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve billing-service listening address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${BILLING_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ status: BILLING_RESPONSES.STATUS_OK, service: BILLING_SERVICE_NAME });
    } finally {
      await app.close();
    }
  });
});
