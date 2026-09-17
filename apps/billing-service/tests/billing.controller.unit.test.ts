import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { TenantId } from "@telemetry/shared-types";
import { BillingController } from "../src/controllers/billing.controller";
import type { InvoiceService } from "../src/services/invoice.service";
import { TenantNotFoundError } from "../src/errors";
import {
  BILLING_INVOICE_DETAIL,
  BILLING_INVOICE_LIST,
  BILLING_RESPONSES,
  BILLING_ROUTES
} from "../src/constants";

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

/**
 * `BillingController.getInvoice` -- the two branches `BI29`/`BI30` cannot reach.
 *
 * Added at T-047's Gate 3 rework (review M-2). The asymmetry was the finding: T-046 wrote
 * `BU89`/`BU91` for `listInvoices`' `!tenantId` and non-`AppError` arms, and T-047 shipped the
 * same two arms on `getInvoice` with nothing on them -- coverage named `110-115, 129-130`.
 * These two mirror `BU89` and `BU91` case for case, including the negative assertions, which
 * are the half that carries the weight.
 *
 * **Redness, honestly.** Both cases were **green on their first run**: the controller already
 * shipped, so this is a test-only addition and "confirm red" can only be done by mutation.
 * Results are recorded on each case, measured against this file alone and then against the
 * whole billing package.
 *
 * `BU122` doubles as `BU121`'s control. Both fixtures carry the same valid `:id`, so `BU121`'s
 * 400 cannot be the *validator* rejecting the param -- `BU122` reaches the service with it and
 * asserts the arguments. The 200 body itself belongs to `BU117` (route) and `BU113` (service);
 * nothing here re-asserts it.
 */

const INVOICE_ID = "33333333-3333-4333-8333-333333333333";

// The detail handler reads `request.params`, not `request.query`. Same no-default discipline as
// `buildRequest` above, and for the same reason: a default parameter is re-applied when the
// caller passes `undefined` explicitly, which is how BU89's fixture once carried a tenant.
const buildDetailRequest = (params: unknown, tenantId?: TenantId): FastifyRequest =>
  ({
    params,
    tenantId,
    url: `${BILLING_ROUTES.INVOICES}/${INVOICE_ID}`
  }) as unknown as FastifyRequest;

/** Keyed by the same constant the route path and the validator derive from. */
const validParams = () => ({ [BILLING_INVOICE_DETAIL.PARAM_ID]: INVOICE_ID });

describe("BillingController.getInvoice", () => {
  let getInvoice: ReturnType<typeof vi.fn>;
  let logger: { error: ReturnType<typeof vi.fn> };
  let controller: BillingController;
  let reply: FastifyReply;

  beforeEach(() => {
    // No default resolution: BU121 asserts the service is never reached and BU122 overrides it,
    // so a fixture invoice here would be a value no case reads.
    getInvoice = vi.fn();
    logger = { error: vi.fn() };
    controller = new BillingController(
      { getInvoice } as unknown as InvoiceService,
      logger as unknown as Logger
    );
    reply = buildReply();
  });

  it("BU121 - answers 400 VALIDATION_ERROR when the request carries no tenant context", async () => {
    // `billing.controller.ts` `if (!tenantId)` inside `getInvoice`. Green on its first run --
    // the branch already shipped -- so redness was established by mutation at the Gate 3
    // rework: replacing that block with a bare `const tenantId = request.tenantId` and running
    // **this file** gives `1 failed | 5 passed (6)`, `expected "spy" to be called with
    // arguments: [ 400 ]`; the **whole billing package** under the same mutation gives
    // `1 failed | 206 passed (207)`. This case alone, at both scopes.
    await controller.getInvoice(buildDetailRequest(validParams()), reply);

    expect(reply.status).toHaveBeenCalledWith(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    // Exact equality discriminates this 400 from the *validator's* 400, which travels the same
    // status with a `path: message` string instead.
    expect(sentBody(reply)).toEqual({
      code: BILLING_RESPONSES.CODE_VALIDATION_ERROR,
      message: BILLING_RESPONSES.MESSAGE_TENANT_CONTEXT_REQUIRED
    });
    // The half that carries the weight, as in BU89: the guard exists so that no repository is
    // ever constructed against an absent tenant (`.claude/rules/tenant-isolation.md` -- the
    // tenant id is a constructor argument, so `undefined` would bind a repository to no tenant
    // at all). On this endpoint that repository would read `"InvoiceLineItem"`, which has no
    // RLS policy at all (S-10), so the application predicate is the entire control.
    expect(getInvoice).not.toHaveBeenCalled();
  });

  it("BU122 - answers 500 for an unexpected failure, logging it and leaking nothing", async () => {
    // The contract of this branch is what it does *not* say. Mirrors BU91. Production-reachable
    // on this path: any repository or connection failure that is not an `AppError` lands here,
    // where `InvoiceNotFoundError` and `TenantNotFoundError` travel the arm above it.
    //
    // Two mutations at the Gate 3 rework, both against **the whole billing package** unless
    // stated: deleting the `logger.error(...)` + 500 tail of `getInvoice`'s catch gives
    // `1 failed | 206 passed (207)`, `expected "spy" to be called with arguments: [ 500 ]`,
    // this case alone. And -- because a status assertion would not notice -- adding
    // `detail: error.message` to that 500 body reddens this case on the deep-equal
    // (`expected { code: 'INTERNAL_ERROR', …(2) } to deeply equal { code: 'INTERNAL_ERROR',
    // …(1) }`, measured against this file, `1 failed | 5 passed (6)`). So the "leaks nothing"
    // half is load-bearing, not decoration.
    const secret = "connect ECONNREFUSED 127.0.0.1:5432";
    getInvoice.mockRejectedValueOnce(new Error(secret));

    await controller.getInvoice(buildDetailRequest(validParams(), TENANT_ID), reply);

    // The control half of BU121: the same params fixture reaches the service, with the bound
    // tenant and the parsed id, so BU121's 400 is the tenant guard and not a rejected param.
    expect(getInvoice).toHaveBeenCalledWith(TENANT_ID, {
      [BILLING_INVOICE_DETAIL.PARAM_ID]: INVOICE_ID
    });

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
