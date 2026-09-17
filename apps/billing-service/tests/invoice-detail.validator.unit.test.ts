import { describe, expect, it } from "vitest";
import { invoiceDetailParamsSchema } from "../src/validators/invoice-detail.validator";
import { BILLING_INVOICE_DETAIL } from "../src/constants";

/**
 * Param contract for `GET /v1/billing/invoices/:id` (T-047 D4).
 *
 * A malformed id is `400 VALIDATION_ERROR`, not `404`. `Invoice.id` is `String @default(uuid())`,
 * so a non-UUID cannot be any tenant's invoice id and refusing it leaks nothing a `404` would
 * hide -- and "your request is malformed" is a different diagnosis from "that resource is not
 * here", which is what an operator reading the log needs. Consistent with T-046's validator,
 * which rejects an over-large `pageSize` rather than clamping it.
 */
const VALID_UUID_V4 = "11111111-2222-4333-8444-555555555555";
const NOT_A_UUID = "abc";
const EMPTY_STRING = "";
const UUID_WITH_LEADING_SPACE = ` ${VALID_UUID_V4}`;
const UUID_WITH_TRAILING_SPACE = `${VALID_UUID_V4} `;

/**
 * Six more forms for BU106, spelled out so the case pins what zod does rather than what it is
 * assumed to do. BU106 measures **ten** values in all: these six plus `VALID_UUID_V4` accepted,
 * and `UUID_WITH_LEADING_SPACE`, `EMPTY_STRING` and `NOT_A_UUID` rejected. (An earlier revision
 * of this line said "the nine forms"; re-counted mechanically off the two loop literals at the
 * Gate 3 rework -- 7 accepted, 3 rejected.)
 */
const UUID_V1 = "11111111-2222-1333-8444-555555555555";
const UUID_V7 = "11111111-2222-7333-8444-555555555555";
const UUID_VERSION_NIBBLE_ZERO = "11111111-2222-0333-8444-555555555555";
const UUID_INVALID_VARIANT_NIBBLE = "11111111-2222-4333-c444-555555555555";
const UUID_NIL = "00000000-0000-0000-0000-000000000000";
const UUID_UPPERCASE = "11111111-2222-4333-8444-55555555AAAA";

describe("invoiceDetailParamsSchema", () => {
  it("BU103 - a valid UUID parses to exactly { id }, unchanged", () => {
    const result = invoiceDetailParamsSchema.safeParse({ [BILLING_INVOICE_DETAIL.PARAM_ID]: VALID_UUID_V4 });

    expect(result.success).toBe(true);
    // Byte-identical, and exactly one key: no normalisation, no lower-casing, and nothing
    // else smuggled out of the params object into what the service receives.
    expect(result.success && result.data).toEqual({ [BILLING_INVOICE_DETAIL.PARAM_ID]: VALID_UUID_V4 });
    expect(result.success && Object.keys(result.data)).toEqual([BILLING_INVOICE_DETAIL.PARAM_ID]);
  });

  it("BU104 - a non-UUID is rejected, with the failure attributed to the id param", () => {
    const result = invoiceDetailParamsSchema.safeParse({ [BILLING_INVOICE_DETAIL.PARAM_ID]: NOT_A_UUID });

    expect(result.success).toBe(false);
    expect(
      result.success ? [] : result.error.errors.map((issue) => issue.path.join("."))
    ).toContain(BILLING_INVOICE_DETAIL.PARAM_ID);
  });

  it("BU105 - an empty id, a missing id and a padded id are all rejected -- no trimming, no normalisation", () => {
    const empty = invoiceDetailParamsSchema.safeParse({ [BILLING_INVOICE_DETAIL.PARAM_ID]: EMPTY_STRING });
    const missing = invoiceDetailParamsSchema.safeParse({});
    const leading = invoiceDetailParamsSchema.safeParse({
      [BILLING_INVOICE_DETAIL.PARAM_ID]: UUID_WITH_LEADING_SPACE
    });
    const trailing = invoiceDetailParamsSchema.safeParse({
      [BILLING_INVOICE_DETAIL.PARAM_ID]: UUID_WITH_TRAILING_SPACE
    });

    // Both padded forms, because a `.trim()` added later would make only one of them pass and
    // a one-sided case would not notice. Rejecting rather than trimming keeps the id the
    // client sent and the id the query runs identical.
    expect(empty.success).toBe(false);
    expect(missing.success).toBe(false);
    expect(leading.success).toBe(false);
    expect(trailing.success).toBe(false);
  });

  it("BU106 - the schema guarantees UUID shape, not version or variant -- measured, not assumed", () => {
    // `uuidSchema` is `z.string().uuid()` (`packages/shared-validation/src/index.ts`). Measured
    // at zod 3.25.76: it accepts a v1, a v7, a version nibble of `0`, an invalid variant nibble
    // of `c`, the nil UUID and an uppercase value. So a request carrying any of these reaches
    // the repository and simply matches no row -- a `404`, not a `400`.
    //
    // This case exists so that is a recorded property rather than an assumption. It is also
    // **not** new looseness: `tenantIdSchema` (`packages/shared-validation/src/index.ts:38`)
    // *derives* from `uuidSchema` (`:19`) through `.transform`, rather than being the same
    // schema, and accepts exactly the same set -- measured at the Gate 3 rework over 15 forms
    // (these seven accepts, plus version nibble `8` and variant nibble `f`, against leading space,
    // trailing space, empty, `abc`, braced and unhyphenated) with zero disagreements and an
    // identical parsed value on every accept. So `X-Tenant-Id` has accepted exactly these forms
    // since before this task. Do not "fix" it here -- tightening the shared schema changes every
    // service's tenant header in one edit.
    for (const accepted of [
      VALID_UUID_V4,
      UUID_V1,
      UUID_V7,
      UUID_VERSION_NIBBLE_ZERO,
      UUID_INVALID_VARIANT_NIBBLE,
      UUID_NIL,
      UUID_UPPERCASE
    ]) {
      expect(
        invoiceDetailParamsSchema.safeParse({ [BILLING_INVOICE_DETAIL.PARAM_ID]: accepted }).success
      ).toBe(true);
    }

    // And the negatives, so the case is not "everything parses".
    for (const rejected of [UUID_WITH_LEADING_SPACE, EMPTY_STRING, NOT_A_UUID]) {
      expect(
        invoiceDetailParamsSchema.safeParse({ [BILLING_INVOICE_DETAIL.PARAM_ID]: rejected }).success
      ).toBe(false);
    }
  });
});
