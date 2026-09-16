import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import { BillingController } from "../src/controllers/billing.controller";
import type { InvoiceService } from "../src/services/invoice.service";
import { TenantNotFoundError } from "../src/errors";
import { BILLING_INVOICE_LIST, BILLING_RESPONSES, BILLING_ROUTES } from "../src/constants";

/**
 * `BillingController.listInvoices` -- the three error branches, plus the success control.
 *
 * Added at T-046's Gate 3 rework (review MEDIUM-4, decision D-B). Mirrors
 * `internal.controller.unit.test.ts` in structure, helper names and id scheme: the sibling
 * controller has BU51-BU60 here, and this one had nothing.
 *
 * **Redness, honestly.** The controller already shipped, so three of these four cases were green
 * on their first run and one was not: `BU89` failed with
 * `AssertionError: expected "spy" to be called with arguments: [ 400 ]` because the helper gave
 * `tenantId` a *default parameter*, and JavaScript re-applies a default when the caller passes
 * `undefined` explicitly -- so the "no tenant context" fixture carried a tenant. That was a
 * defect in the test, not in the controller, and it is the reason `buildRequest` now takes an
 * optional parameter with no default. For the other three, "confirm red" was done the only way
 * it can be for a test-only addition: by mutating each branch out of `billing.controller.ts` in
 * turn and checking that exactly the case naming it goes red. Results are recorded on each
 * case. A case that stays green under the deletion of the code it claims to cover is asserting
 * nothing, which is the failure mode `.claude/rules/known-gaps.md` S-21 records at suite
 * level.
 *
 * Why unit rather than route cases: the `!tenantId` branch is **unreachable through the real
 * app**. `billingTenantContextHandler` is an `onRequest` hook on the same scope, so a request
 * that reaches the handler always carries a tenant, and one that does not is rejected with
 * `401` before the controller runs. The branch exists because `FastifyRequest.tenantId` is
 * declared optional (`src/types/index.ts`), i.e. it is a type-required guard, and a unit test
 * is the only level at which it can be exercised at all. That is review option B2's stated
 * limitation and the reason B1 was chosen.
 */

const TENANT_ID = "11111111-1111-4111-8111-111111111111" as TenantId;

const emptyPage = {
  items: [],
  total: 0,
  page: BILLING_INVOICE_LIST.DEFAULT_PAGE,
  pageSize: BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE
} as const;

// `tenantId` is spread in rather than defaulted, because a default parameter is re-applied when
// the caller passes `undefined` explicitly -- which would have made the BU89 fixture carry a
// tenant after all. Caught by BU89 going red on its first run; see the file docblock.
const buildRequest = (query: unknown, tenantId?: TenantId): FastifyRequest =>
  ({ query, tenantId, url: BILLING_ROUTES.INVOICES }) as unknown as FastifyRequest;

const buildTenantRequest = (query: unknown): FastifyRequest => buildRequest(query, TENANT_ID);

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

describe("BillingController.listInvoices", () => {
  let listInvoices: ReturnType<typeof vi.fn>;
  let logger: { error: ReturnType<typeof vi.fn> };
  let controller: BillingController;
  let reply: FastifyReply;

  beforeEach(() => {
    listInvoices = vi.fn(async () => emptyPage);
    logger = { error: vi.fn() };
    controller = new BillingController(
      { listInvoices } as unknown as InvoiceService,
      logger as unknown as Logger
    );
    reply = buildReply();
  });

  it("BU88 - answers 200 { data } and hands the parsed query to the service", async () => {
    // The control for BU89. Without it, BU89's 400 could come from the guard never being
    // reached rather than from the guard firing, and the pair would not discriminate.
    await controller.listInvoices(buildTenantRequest({}), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_OK);
    expect(sentBody(reply)).toEqual({ data: emptyPage });
    // Defaults applied by the validator, not by the controller and not by the caller.
    expect(listInvoices).toHaveBeenCalledWith(TENANT_ID, {
      page: BILLING_INVOICE_LIST.DEFAULT_PAGE,
      pageSize: BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE
    });
  });

  it("BU89 - answers 400 VALIDATION_ERROR when the request carries no tenant context", async () => {
    // `billing.controller.ts` `if (!tenantId)`. Mutation run at the Gate 3 rework: deleting
    // that branch turns this case red (`AssertionError: expected 400, received 200`) and
    // leaves BU88, BU90 and BU91 green.
    await controller.listInvoices(buildRequest({}), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(sentBody(reply)).toEqual({
      code: BILLING_RESPONSES.CODE_VALIDATION_ERROR,
      message: BILLING_RESPONSES.MESSAGE_TENANT_CONTEXT_REQUIRED
    });
    // The negative half carries the weight: the guard exists so that a repository is never
    // constructed against an absent tenant (`.claude/rules/tenant-isolation.md` -- the tenant
    // id is a constructor argument, so `undefined` would bind a repository to no tenant at
    // all). Asserting only the status would not observe that.
    expect(listInvoices).not.toHaveBeenCalled();
  });

  it("BU90 - surfaces an AppError with its own status, code and message", async () => {
    // `billing.controller.ts` `error instanceof AppError`. Mirrors BU57. `TenantNotFoundError`
    // is used because its 404/TENANT_NOT_FOUND is distinct from both of the controller's own
    // statuses (400, 500), so the case cannot pass by coincidence with either other branch.
    listInvoices.mockRejectedValueOnce(new TenantNotFoundError());

    await controller.listInvoices(buildTenantRequest({}), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_NOT_FOUND);
    const body = sentBody(reply) as { code: string; message: string };
    expect(body.code).toBe(BILLING_RESPONSES.CODE_TENANT_NOT_FOUND);
    expect(body.message).toBe(BILLING_RESPONSES.MESSAGE_TENANT_NOT_FOUND);
    // It travels the AppError arm, so nothing is logged as an unexpected failure and the
    // 500 body is never reached.
    expect(reply.status).not.toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_INTERNAL_ERROR);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("BU91 - answers 500 for an unexpected failure, logging it and leaking nothing", async () => {
    // The contract of this branch is what it does *not* say. Mirrors BU59.
    const secret = "connect ECONNREFUSED 127.0.0.1:5432";
    listInvoices.mockRejectedValueOnce(new Error(secret));

    await controller.listInvoices(buildTenantRequest({}), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_INTERNAL_ERROR);
    // Exact equality, not `toContain`: the body must be these two fields and nothing else, so
    // an added `error`/`stack`/`detail` field would fail here rather than slip through.
    expect(sentBody(reply)).toEqual({
      code: BILLING_RESPONSES.CODE_INTERNAL_ERROR,
      message: BILLING_RESPONSES.MESSAGE_INTERNAL_ERROR
    });
    expect(JSON.stringify(sentBody(reply))).not.toContain(secret);
    // Nothing is lost, either -- the detail goes to the log, not to the wire.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls[0])).toContain(secret);
  });
});
