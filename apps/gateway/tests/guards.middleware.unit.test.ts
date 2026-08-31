import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { gatewayRequestGuardsPreHandler } from "../src/middleware/guards.middleware";
import { GATEWAY_HEADERS, GATEWAY_SPOOFABLE_HEADERS } from "../src/constants";

vi.mock("node:crypto", () => {
  return {
    randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000000")
  };
});

const randomUUIDMock = vi.mocked(randomUUID);

type ReplyRecorder = {
  readonly reply: FastifyReply;
  readonly statusSpy: ReturnType<typeof vi.fn>;
  readonly sendSpy: ReturnType<typeof vi.fn>;
};

const createReplyRecorder = (): ReplyRecorder => {
  const sendSpy = vi.fn();
  const statusSpy = vi.fn().mockImplementation((_statusCode: number) => {
    return {
      send: sendSpy
    };
  });

  return {
    reply: {
      status: statusSpy
    } as unknown as FastifyReply,
    statusSpy,
    sendSpy
  };
};

type RequestInput = {
  method: string;
  headers?: Record<string, string>;
};

const createRequest = ({ method, headers }: RequestInput): FastifyRequest => {
  return {
    method,
    headers: {
      ...(headers ?? {})
    }
  } as unknown as FastifyRequest;
};

describe("gateway request guards pre-handler", () => {
  beforeEach(() => {
    randomUUIDMock.mockReset();
    randomUUIDMock.mockReturnValue("00000000-0000-4000-8000-000000000000");
  });

  it("returns 413 when content-length exceeds 1MB", async () => {
    const request = createRequest({
      method: "POST",
      headers: {
        "content-length": "1048577",
        "content-type": "application/json"
      }
    });
    const { reply, statusSpy, sendSpy } = createReplyRecorder();

    await gatewayRequestGuardsPreHandler(request, reply);

    expect(statusSpy).toHaveBeenCalledWith(413);
    expect(sendSpy).toHaveBeenCalledWith({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("allows content-length exactly at 1MB", async () => {
    const request = createRequest({
      method: "POST",
      headers: {
        "content-length": "1048576",
        "content-type": "application/json"
      }
    });
    const { reply, statusSpy, sendSpy } = createReplyRecorder();

    await gatewayRequestGuardsPreHandler(request, reply);

    expect(statusSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("returns 415 for write methods without content-type", async () => {
    const request = createRequest({ method: "POST" });
    const { reply, statusSpy, sendSpy } = createReplyRecorder();

    await gatewayRequestGuardsPreHandler(request, reply);

    expect(statusSpy).toHaveBeenCalledWith(415);
    expect(sendSpy).toHaveBeenCalledWith({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("returns 415 for write methods with non-json content-type", async () => {
    const request = createRequest({
      method: "PATCH",
      headers: {
        "content-type": "text/plain"
      }
    });
    const { reply, statusSpy, sendSpy } = createReplyRecorder();

    await gatewayRequestGuardsPreHandler(request, reply);

    expect(statusSpy).toHaveBeenCalledWith(415);
    expect(sendSpy).toHaveBeenCalledWith({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("accepts application/json and application/json with charset on write methods", async () => {
    const exactJsonRequest = createRequest({
      method: "PUT",
      headers: {
        "content-type": "application/json"
      }
    });
    const charsetJsonRequest = createRequest({
      method: "PATCH",
      headers: {
        "content-type": "application/json; charset=utf-8"
      }
    });

    const first = createReplyRecorder();
    const second = createReplyRecorder();

    await gatewayRequestGuardsPreHandler(exactJsonRequest, first.reply);
    await gatewayRequestGuardsPreHandler(charsetJsonRequest, second.reply);

    expect(first.statusSpy).not.toHaveBeenCalled();
    expect(first.sendSpy).not.toHaveBeenCalled();
    expect(second.statusSpy).not.toHaveBeenCalled();
    expect(second.sendSpy).not.toHaveBeenCalled();
  });

  it("does not enforce json content-type for non-write methods", async () => {
    const request = createRequest({
      method: "GET",
      headers: {
        "content-type": "text/plain"
      }
    });
    const { reply, statusSpy, sendSpy } = createReplyRecorder();

    await gatewayRequestGuardsPreHandler(request, reply);

    expect(statusSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("strips spoofable identity headers", async () => {
    const request = createRequest({
      method: "GET",
      headers: {
        [GATEWAY_HEADERS.TENANT_ID]: "spoofed-tenant",
        [GATEWAY_HEADERS.USER_ID]: "spoofed-user",
        [GATEWAY_HEADERS.USER_ROLE]: "spoofed-role",
        // S-4: usage-service treats this as proof the request came through the gateway, so it
        // is exactly as spoofable as the identity headers and must never survive ingress.
        [GATEWAY_HEADERS.INTERNAL_SECRET]: "spoofed-internal-secret"
      }
    });
    const { reply } = createReplyRecorder();

    await gatewayRequestGuardsPreHandler(request, reply);

    for (const header of GATEWAY_SPOOFABLE_HEADERS) {
      expect(request.headers[header]).toBeUndefined();
    }
    // Named explicitly too, so a header silently dropped from the set above still fails here.
    expect(request.headers[GATEWAY_HEADERS.TENANT_ID]).toBeUndefined();
    expect(request.headers[GATEWAY_HEADERS.USER_ID]).toBeUndefined();
    expect(request.headers[GATEWAY_HEADERS.USER_ROLE]).toBeUndefined();
    expect(request.headers[GATEWAY_HEADERS.INTERNAL_SECRET]).toBeUndefined();
  });

  it("injects x-request-id when missing", async () => {
    const request = createRequest({ method: "GET" });
    const { reply } = createReplyRecorder();

    await gatewayRequestGuardsPreHandler(request, reply);

    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
    expect(request.headers["x-request-id"]).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("preserves existing x-request-id", async () => {
    const request = createRequest({
      method: "GET",
      headers: {
        "x-request-id": "existing-request-id"
      }
    });
    const { reply } = createReplyRecorder();

    await gatewayRequestGuardsPreHandler(request, reply);

    expect(randomUUIDMock).not.toHaveBeenCalled();
    expect(request.headers["x-request-id"]).toBe("existing-request-id");
  });
});