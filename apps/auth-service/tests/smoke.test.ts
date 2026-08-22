import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildAuthServiceApp } from "../src/app";
import {
  AUTH_RESPONSES,
  AUTH_ROUTES,
  AUTH_SERVICE_NAME
} from "../src/constants";

describe("auth-service", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildAuthServiceApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns healthy status", async () => {
    const response = await app.inject({ method: "GET", url: AUTH_ROUTES.HEALTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: AUTH_RESPONSES.STATUS_OK,
      service: AUTH_SERVICE_NAME
    });
  });
});
