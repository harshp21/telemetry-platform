import { InvoiceStatus } from "@prisma/client";
import { z } from "zod";
import { BILLING_INVOICE_LIST } from "../constants";

/**
 * Status filter for `GET /v1/billing/invoices`.
 *
 * Built from Prisma's generated `InvoiceStatus` enum rather than re-typed as
 * `z.enum(["DRAFT","FINALIZED","PAID"])`, matching `BILLING_METERING.INVOICE_STATUS_DRAFT`.
 * Two things follow. A schema rename becomes a compile error here instead of a runtime
 * mismatch; and an unknown value is refused at the edge rather than handed to Prisma, which
 * raises `PrismaClientValidationError` for an unknown enum member -- a shape
 * `registerGlobalErrorHandler` has no mapping for, so the client would get a `500` for its own
 * typo. `BU71` is the case.
 */
export const invoiceStatusSchema = z.nativeEnum(InvoiceStatus);

/**
 * Query contract for `GET /v1/billing/invoices`.
 *
 * `page` / `pageSize` are coerced from querystring strings and defaulted here, so every layer
 * below receives concrete numbers and performs no pagination arithmetic of its own.
 * `pageSize` above the maximum is rejected rather than clamped -- see `BILLING_INVOICE_LIST`.
 *
 * Shaped after `apps/usage-service/src/validators/usage-summary.validator.ts`; there is no
 * `.refine(...)` here because, unlike a date range, no two fields of this query constrain
 * each other.
 */
export const invoiceListQuerySchema = z.object({
  status: invoiceStatusSchema.optional(),
  page: z.coerce
    .number()
    .int()
    .min(BILLING_INVOICE_LIST.MIN_PAGE)
    .default(BILLING_INVOICE_LIST.DEFAULT_PAGE),
  pageSize: z.coerce
    .number()
    .int()
    .min(BILLING_INVOICE_LIST.MIN_PAGE_SIZE)
    .max(BILLING_INVOICE_LIST.MAX_PAGE_SIZE)
    .default(BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE)
});

export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;
