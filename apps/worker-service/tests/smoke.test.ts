import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildWorkerServiceApp } from "../src/app";
import {
  WORKER_HEADERS,
  WORKER_RESPONSES,
  WORKER_ROUTES,
  WORKER_SERVICE_NAME
} from "../src/constants";

describe("worker-service", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildWorkerServiceApp({ internalApiSecret: "test-secret" });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns healthy status", async () => {
    const response = await app.inject({ method: "GET", url: WORKER_ROUTES.HEALTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: WORKER_RESPONSES.STATUS_OK,
      service: WORKER_SERVICE_NAME
    });
  });

  it("rejects internal replay endpoint without secret", async () => {
    const response = await app.inject({
      method: "POST",
      url: WORKER_ROUTES.INTERNAL_WORKER_REPLAY
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: WORKER_RESPONSES.CODE_UNAUTHORIZED });
  });

  it("accepts internal replay endpoint with correct secret", async () => {
    const response = await app.inject({
      method: "POST",
      url: WORKER_ROUTES.INTERNAL_WORKER_REPLAY,
      headers: {
        [WORKER_HEADERS.INTERNAL_SECRET]: "test-secret"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: WORKER_RESPONSES.STATUS_ACCEPTED,
      workflow: WORKER_RESPONSES.WORKFLOW_USAGE_REPLAY
    });
  });
});
