import { z } from "zod";
import { uuidSchema } from "@telemetry/shared-validation";
import { BILLING_INVOICE_DETAIL } from "../constants";

/**
 * Path-param contract for `GET /v1/billing/invoices/:id` (T-047 D4).
 *
 * A malformed id is `400 VALIDATION_ERROR`, not `404`. `Invoice.id` is `String @default(uuid())`,
 * so a non-UUID cannot be any tenant's invoice id and refusing it leaks nothing a `404` would
 * conceal -- while "your request is malformed" and "that resource is not here" are different
 * diagnoses for whoever reads the log. This is the same reject-rather-than-accommodate stance
 * `invoice-list.validator.ts` takes on an over-large `pageSize`.
 *
 * The key is `BILLING_INVOICE_DETAIL.PARAM_ID`, the same constant `BILLING_ROUTES.INVOICE_DETAIL`
 * derives the path from, so the name Fastify binds and the name parsed here cannot drift.
 *
 * **`uuidSchema` guarantees shape, not version -- measured, not assumed.** `z.string().uuid()`
 * at zod 3.25.76 accepts a v1, a v7, a version nibble of `0`, an invalid variant nibble of `c`,
 * the nil UUID and an uppercase value; it rejects an empty string, a padded one and a non-UUID.
 * So the nil UUID reaches the repository and matches nothing, which is a `404`. `BU106` pins
 * that list rather than trusting it.
 *
 * Note this is not new looseness. `tenantIdSchema` (`packages/shared-validation/src/index.ts:38`)
 * is not the *same* schema as `uuidSchema` (`:19`) -- it **derives** from it,
 * `uuidSchema.transform(value => value as TenantId)` -- but it accepts exactly the same set:
 * measured at the Gate 3 rework over 15 forms (the seven `BU106` accepts, plus version nibble
 * `8` and variant nibble `f`, against leading space, trailing space, empty, `abc`, braced and
 * unhyphenated), zero disagreements, and the parsed value identical for all nine accepts --
 * the transform brands the type and changes no value. So `X-Tenant-Id` has behaved this way
 * since before this task, and tightening it belongs with the shared schema, not here.
 */
export const invoiceDetailParamsSchema = z.object({
  [BILLING_INVOICE_DETAIL.PARAM_ID]: uuidSchema
});

export type InvoiceDetailParams = z.infer<typeof invoiceDetailParamsSchema>;
