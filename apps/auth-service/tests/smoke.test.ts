import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ERROR_RESPONSES } from "@telemetry/shared-types";
import { buildAuthServiceApp } from "../src/app";
import {
  AUTH_MESSAGES,
  AUTH_HTTP_STATUS,
  AUTH_RESPONSES,
  AUTH_ROUTES,
  AUTH_SERVICE_NAME
} from "../src/constants";
import { EmailAlreadyExistsError } from "../src/errors";

const registerMock = vi.fn();

vi.mock("../src/services/auth.service", () => {
  return {
    AuthService: class {
      register = registerMock;
    }
  };
});

describe("auth-service", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    registerMock.mockReset();
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

  it("registers a user and returns 201", async () => {
    registerMock.mockResolvedValueOnce({ userId: "user_1", tenantId: "tenant_1" });

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
      payload: {
        email: "owner@example.com",
        password: "StrongPass123",
        tenantName: "Acme Inc"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.CREATED);
    expect(response.json()).toEqual({
      data: {
        userId: "user_1",
        tenantId: "tenant_1"
      }
    });
  });

  it("returns 409 when email already exists", async () => {
    registerMock.mockRejectedValueOnce(new EmailAlreadyExistsError());

    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
      payload: {
        email: "owner@example.com",
        password: "StrongPass123",
        tenantName: "Acme Inc"
      }
    });

    expect(response.statusCode).toBe(AUTH_HTTP_STATUS.CONFLICT);
    expect(response.json()).toEqual({
      code: AUTH_RESPONSES.CODE_EMAIL_ALREADY_EXISTS,
      message: AUTH_MESSAGES.REGISTRATION_FAILED
    });
  });

  it("returns 400 for invalid register payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${AUTH_ROUTES.V1_AUTH}${AUTH_ROUTES.REGISTER}`,
      payload: {
        email: "bad-email",
        password: "short",
        tenantName: ""
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: ERROR_RESPONSES.CODE_VALIDATION_ERROR
    });
    expect(registerMock).not.toHaveBeenCalled();
  });
});
