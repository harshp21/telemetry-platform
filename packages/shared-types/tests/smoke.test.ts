import { describe, expect, it } from "vitest";
import {
  type EventPayload,
  AppError,
  ERROR_RESPONSES,
  INTERNAL_AUTH_HEADERS,
  INTERNAL_AUTH_RESPONSES,
  type TenantId
} from "../src";

describe("shared-types", () => {
  it("exposes shared internal auth constants", () => {
    expect(INTERNAL_AUTH_HEADERS.INTERNAL_SECRET).toBe("x-internal-secret");
    expect(INTERNAL_AUTH_RESPONSES.CODE_UNAUTHORIZED).toBe("UNAUTHORIZED");
  });

  it("models application errors with stable code and status", () => {
    const error = new AppError(ERROR_RESPONSES.CODE_CONFLICT, 409, "duplicate record");

    expect(error.code).toBe(ERROR_RESPONSES.CODE_CONFLICT);
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe("duplicate record");
  });

  it("enforces branded IDs through explicit cast", () => {
    // @ts-expect-error raw string must not be assignable without explicit cast
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const invalidTenantId: TenantId = "tenant_1";

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const tenantId = "tenant_1" as TenantId;
    void invalidTenantId;
    expect(tenantId).toBe("tenant_1");
  });

  it("supports canonical event payload contract", () => {
    const payload: EventPayload = {
      eventType: "api.request",
      quantity: 1,
      unit: "request",
      occurredAt: "2026-01-01T00:00:00Z",
      metadata: { source: "sdk-web" }
    };

    expect(payload.eventType).toBe("api.request");
    expect(payload.quantity).toBe(1);
  });
});
