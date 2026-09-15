import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { InternalController } from "../src/controllers/internal.controller";
import type { BillingService } from "../src/services/billing.service";
import {
  MeterNotFoundError,
  TenantNotFoundError,
  UsageLinesChangedError
} from "../src/errors";
import { BILLING_RESPONSES, BILLING_ROUTES } from "../src/constants";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";
const PERIOD_START = "2026-01-01T00:00:00.000Z";
const PERIOD_END = "2026-02-01T00:00:00.000Z";
const METRIC_STORAGE = "storage.gb";

const validBody = {
  tenantId: TENANT_ID,
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END
} as const;

const buildRequest = (body: unknown): FastifyRequest =>
  ({ body, url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE }) as unknown as FastifyRequest;

const buildReply = (): FastifyReply =>
  ({
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis()
  }) as unknown as FastifyReply;

const sentBody = (reply: FastifyReply): unknown => {
  const send = reply.send as unknown as ReturnType<typeof vi.fn>;
  const call = send.mock.calls[0];
  if (!call) {
    throw new Error("Expected the controller to have sent a response");
  }
  return call[0];
};

describe("InternalController.generate", () => {
  let generateInvoice: ReturnType<typeof vi.fn>;
  let logger: { error: ReturnType<typeof vi.fn> };
  let controller: InternalController;
  let reply: FastifyReply;

  beforeEach(() => {
    generateInvoice = vi.fn(async () => ({ invoiceId: INVOICE_ID, created: true }));
    logger = { error: vi.fn() };
    controller = new InternalController(
      { generateInvoice } as unknown as BillingService,
      logger as unknown as Logger
    );
    reply = buildReply();
  });

  it("BU51 - answers 400 VALIDATION_ERROR with the failing issues joined into the message", async () => {
    await controller.generate(buildRequest({ ...validBody, tenantId: "not-a-uuid" }), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    const body = sentBody(reply) as { code: string; message: string };
    expect(body.code).toBe(BILLING_RESPONSES.CODE_VALIDATION_ERROR);
    expect(body.message).toContain("tenantId");
  });

  it("BU52 - answers 400 when the request carries no body at all", async () => {
    await controller.generate(buildRequest(undefined), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect((sentBody(reply) as { code: string }).code).toBe(
      BILLING_RESPONSES.CODE_VALIDATION_ERROR
    );
  });

  it("BU53 - does not reach the service when validation fails", async () => {
    await controller.generate(buildRequest({ tenantId: TENANT_ID }), reply);

    expect(generateInvoice).not.toHaveBeenCalled();
  });

  it("BU54 - answers 201 { data: { invoiceId } } when an invoice was created", async () => {
    await controller.generate(buildRequest(validBody), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_CREATED);
    expect(sentBody(reply)).toEqual({ data: { invoiceId: INVOICE_ID } });
  });

  it("BU55 - answers 200 with the same envelope on an idempotent hit", async () => {
    generateInvoice.mockResolvedValueOnce({ invoiceId: INVOICE_ID, created: false });

    await controller.generate(buildRequest(validBody), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(sentBody(reply)).toEqual({ data: { invoiceId: INVOICE_ID } });
  });

  it("BU56 - answers 200 { data: { invoiceId: null } } when there is no billable usage", async () => {
    generateInvoice.mockResolvedValueOnce({ invoiceId: null, created: false });

    await controller.generate(buildRequest(validBody), reply);

    // One envelope on every success path (D3). The epic's `message: 'No billable usage'` is
    // dropped: `invoiceId === null` already distinguishes this case, and a `message` field in a
    // success body appears nowhere else in this repository.
    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(sentBody(reply)).toEqual({ data: { invoiceId: null } });
  });

  it("BU57 - surfaces an AppError with its own status, code and message", async () => {
    generateInvoice.mockRejectedValueOnce(new MeterNotFoundError([METRIC_STORAGE]));

    await controller.generate(buildRequest(validBody), reply);

    expect(reply.status).toHaveBeenCalledWith(
      BILLING_RESPONSES.HTTP_STATUS_UNPROCESSABLE_ENTITY
    );
    const body = sentBody(reply) as { code: string; message: string };
    expect(body.code).toBe(BILLING_RESPONSES.CODE_METER_NOT_FOUND);
    expect(body.message).toContain(METRIC_STORAGE);
  });

  it("BU58 - answers 404 TENANT_NOT_FOUND for an unknown tenant", async () => {
    generateInvoice.mockRejectedValueOnce(new TenantNotFoundError());

    await controller.generate(buildRequest(validBody), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_NOT_FOUND);
    expect((sentBody(reply) as { code: string }).code).toBe(
      BILLING_RESPONSES.CODE_TENANT_NOT_FOUND
    );
  });

  it("BU58b - answers 409 CONFLICT when usage lines changed under a concurrent writer", async () => {
    // A lost race is not a server fault: the write rolled back, nothing was billed, and the
    // caller's correct response is to retry. A 500 would page an operator for a condition the
    // system handled. 409 is already this repository's code for "a concurrent writer got there
    // first" -- `registerGlobalErrorHandler` maps `P2002` to it. T-046's caller branches on this.
    const expectedLines = 12;
    const markedLines = 11;
    generateInvoice.mockRejectedValueOnce(
      new UsageLinesChangedError(expectedLines, markedLines)
    );

    await controller.generate(buildRequest(validBody), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_CONFLICT);
    expect(reply.status).not.toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_INTERNAL_ERROR);
    const body = sentBody(reply) as { code: string; message: string };
    expect(body.code).toBe(BILLING_RESPONSES.CODE_USAGE_LINES_CHANGED);
    expect(body.message).toContain(String(expectedLines));
    expect(body.message).toContain(String(markedLines));
    // It travels the AppError arm, so nothing is logged as an unexpected failure.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("BU59 - answers 500 for an unexpected failure, logging it and leaking nothing", async () => {
    const secret = "connect ECONNREFUSED 127.0.0.1:5432";
    generateInvoice.mockRejectedValueOnce(new Error(secret));

    await controller.generate(buildRequest(validBody), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_INTERNAL_ERROR);
    expect(sentBody(reply)).toEqual({
      code: BILLING_RESPONSES.CODE_INTERNAL_ERROR,
      message: BILLING_RESPONSES.MESSAGE_INTERNAL_ERROR
    });
    expect(JSON.stringify(sentBody(reply))).not.toContain(secret);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("BU60 - hands the parsed body to the service, not the raw request body", async () => {
    // The parsed value is branded `TenantId` by `tenantIdSchema`, which is what the repository
    // constructor requires; the raw body is an arbitrary object.
    const raw = { ...validBody, unexpected: "ignored" };

    await controller.generate(buildRequest(raw), reply);

    expect(generateInvoice).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END
    });
  });
});
