import { describe, expect, it } from "vitest";
import { buildAuthServiceApp } from "../src/app";
import { AUTH_RESPONSES, AUTH_ROUTES, AUTH_SERVICE_NAME } from "../src/constants";
import { AUTH_STARTUP } from "../src/startup.constants";

describe("auth-service smoke", () => {
  it("returns healthy status", async () => {
    const useExternalTarget = process.env.SMOKE_TARGET === "external";

    if (useExternalTarget) {
      const response = await fetch(`http://127.0.0.1:${AUTH_STARTUP.DEFAULT_PORT}${AUTH_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: AUTH_RESPONSES.STATUS_OK,
        service: AUTH_SERVICE_NAME
      });
      return;
    }

    const app = buildAuthServiceApp();
    await app.listen({ port: 0, host: "127.0.0.1" });

    const address = app.server.address();

    if (!address || typeof address === "string") {
      throw new Error("Unable to resolve auth-service listening address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${AUTH_ROUTES.HEALTH}`);
      const body = (await response.json()) as { status: string; service: string };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: AUTH_RESPONSES.STATUS_OK,
        service: AUTH_SERVICE_NAME
      });
    } finally {
      await app.close();
    }
  });
});
