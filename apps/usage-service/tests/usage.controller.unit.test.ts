import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { FastifyReply, FastifyRequest } from "fastify";
import { UsageController } from "../src/controllers/usage.controller";
import type { UsageService } from "../src/services/usage.service";
import { AppError } from "../src/errors";
import {
  USAGE_SERVICE_RESPONSES,
  USAGE_SUMMARY_CONSTANTS,
  USAGE_SUMMARY_GRANULARITY
} from "../src/constants";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

const validQuery = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-08T00:00:00.000Z",
  granularity: USAGE_SUMMARY_GRANULARITY.DAY
};

const emptyResult = {
  items: [],
  total: 0,
  page: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE,
  pageSize: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE_SIZE
};

const buildRequest = (query: Record<string, unknown>): FastifyRequest =>
  ({ query, tenantId: TENANT_ID, url: "/v1/usage/summary" }) as unknown as FastifyRequest;

const buildRequestWithoutTenant = (query: Record<string, unknown>): FastifyRequest =>
  ({ query, url: "/v1/usage/summary" }) as unknown as FastifyRequest;

const buildReply = (): FastifyReply =>
  ({
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis()
  }) as unknown as FastifyReply;

describe("UsageController.handle", () => {
  let getUsageSummary: ReturnType<typeof vi.fn>;
  let logger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
  let controller: UsageController;

  beforeEach(() => {
    getUsageSummary = vi.fn().mockResolvedValue(emptyResult);
    logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    controller = new UsageController(
      { getUsageSummary } as unknown as UsageService,
      logger as unknown as Logger
    );
  });

  it("returns 200 with the usage summary payload", async () => {
    const payload = {
      items: [
        {
          metricKey: "api.request",
          bucketStart: "2026-01-01T00:00:00.000Z",
          bucketEnd: "2026-01-02T00:00:00.000Z",
          totalQuantity: "10.5"
        }
      ],
      total: 1,
      page: 1,
      pageSize: 20
    };
    getUsageSummary.mockResolvedValueOnce(payload);
    const reply = buildReply();

    await controller.handle(buildRequest(validQuery), reply);

    expect(reply.status).toHaveBeenCalledWith(USAGE_SERVICE_RESPONSES.HTTP_STATUS_OK);
    expect(reply.send).toHaveBeenCalledWith({ data: payload });
    expect(getUsageSummary).toHaveBeenCalledWith(TENANT_ID, expect.any(Object));
  });

  it("applies default page and pageSize when they are omitted", async () => {
    const reply = buildReply();

    await controller.handle(buildRequest(validQuery), reply);

    expect(getUsageSummary).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        page: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE,
        pageSize: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE_SIZE
      })
    );
  });

  it("forwards the optional metricKey filter to the service", async () => {
    const reply = buildReply();

    await controller.handle(
      buildRequest({ ...validQuery, metricKey: "api.request" }),
      reply
    );

    expect(getUsageSummary).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ metricKey: "api.request" })
    );
  });

  it("returns 400 VALIDATION_ERROR for an invalid from format", async () => {
    const reply = buildReply();

    await controller.handle(buildRequest({ ...validQuery, from: "01-01-2026" }), reply);

    expect(reply.status).toHaveBeenCalledWith(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR })
    );
    expect(getUsageSummary).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR when from is not earlier than to", async () => {
    const reply = buildReply();

    await controller.handle(
      buildRequest({
        ...validQuery,
        from: "2026-01-08T00:00:00.000Z",
        to: "2026-01-08T00:00:00.000Z"
      }),
      reply
    );

    expect(reply.status).toHaveBeenCalledWith(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR })
    );
  });

  it("returns 400 VALIDATION_ERROR for an unsupported granularity", async () => {
    const reply = buildReply();

    await controller.handle(buildRequest({ ...validQuery, granularity: "month" }), reply);

    expect(reply.status).toHaveBeenCalledWith(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR })
    );
    expect(getUsageSummary).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR for page below the minimum", async () => {
    const reply = buildReply();

    await controller.handle(buildRequest({ ...validQuery, page: "0" }), reply);

    expect(reply.status).toHaveBeenCalledWith(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR })
    );
  });

  it("returns 400 VALIDATION_ERROR for pageSize below the minimum", async () => {
    const reply = buildReply();

    await controller.handle(buildRequest({ ...validQuery, pageSize: "0" }), reply);

    expect(reply.status).toHaveBeenCalledWith(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR })
    );
  });

  it("returns 400 VALIDATION_ERROR for pageSize above the maximum", async () => {
    const reply = buildReply();

    await controller.handle(
      buildRequest({
        ...validQuery,
        pageSize: String(USAGE_SUMMARY_CONSTANTS.MAX_PAGE_SIZE + 1)
      }),
      reply
    );

    expect(reply.status).toHaveBeenCalledWith(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR })
    );
    expect(getUsageSummary).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR when tenant context is missing", async () => {
    const reply = buildReply();

    await controller.handle(buildRequestWithoutTenant(validQuery), reply);

    expect(reply.status).toHaveBeenCalledWith(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR })
    );
    expect(getUsageSummary).not.toHaveBeenCalled();
  });

  it("normalizes AppError failures to their status code and error code", async () => {
    getUsageSummary.mockRejectedValueOnce(
      new AppError(USAGE_SERVICE_RESPONSES.CODE_TENANT_MISMATCH, 403, "tenant mismatch")
    );
    const reply = buildReply();

    await controller.handle(buildRequest(validQuery), reply);

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      code: USAGE_SERVICE_RESPONSES.CODE_TENANT_MISMATCH,
      message: "tenant mismatch"
    });
  });

  it("returns 500 INTERNAL_ERROR for unexpected service failures", async () => {
    getUsageSummary.mockRejectedValueOnce(new Error("database offline"));
    const reply = buildReply();

    await controller.handle(buildRequest(validQuery), reply);

    expect(reply.status).toHaveBeenCalledWith(
      USAGE_SERVICE_RESPONSES.HTTP_STATUS_INTERNAL_ERROR
    );
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: USAGE_SERVICE_RESPONSES.CODE_INTERNAL_ERROR })
    );
    expect(logger.error).toHaveBeenCalled();
  });
});
