import { describe, expect, it } from "vitest";
import { InvoiceStatus } from "@prisma/client";
import { invoiceListQuerySchema } from "../src/validators/invoice-list.validator";
import { BILLING_INVOICE_LIST } from "../src/constants";

/** Querystrings arrive as strings, so every numeric case is written the way Fastify hands it over. */
const UNKNOWN_STATUS = "BOGUS";
const PAGE_ZERO = "0";
const PAGE_TWO = "2";

describe("invoiceListQuerySchema", () => {
  it("BU71 - rejects an unknown status before Prisma ever sees it", () => {
    const result = invoiceListQuerySchema.safeParse({ status: UNKNOWN_STATUS });

    // Prisma rejects an unknown enum member with `PrismaClientValidationError`, which
    // `registerGlobalErrorHandler` has no mapping for -- so without this the caller gets a 500
    // for a client mistake. The validator is what makes it a 400.
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.errors.map((issue) => issue.path.join("."))).toContain(
      "status"
    );
  });

  it("BU72 - applies the default page and pageSize when neither is supplied", () => {
    const result = invoiceListQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({
      page: BILLING_INVOICE_LIST.DEFAULT_PAGE,
      pageSize: BILLING_INVOICE_LIST.DEFAULT_PAGE_SIZE
    });
  });

  it("BU73 - accepts the pageSize maximum and rejects one past it, and rejects page 0", () => {
    const atMax = invoiceListQuerySchema.safeParse({
      pageSize: String(BILLING_INVOICE_LIST.MAX_PAGE_SIZE)
    });
    const pastMax = invoiceListQuerySchema.safeParse({
      pageSize: String(BILLING_INVOICE_LIST.MAX_PAGE_SIZE + 1)
    });
    const belowMinPage = invoiceListQuerySchema.safeParse({ page: PAGE_ZERO });
    const belowMinPageSize = invoiceListQuerySchema.safeParse({
      pageSize: String(BILLING_INVOICE_LIST.MIN_PAGE_SIZE - 1)
    });

    // Both sides of the boundary, because a `.max()` off by one passes a one-sided test.
    expect(atMax.success).toBe(true);
    expect(atMax.success && atMax.data.pageSize).toBe(BILLING_INVOICE_LIST.MAX_PAGE_SIZE);
    // Rejected, not clamped: a client must never silently receive a different page size than
    // the one it asked for.
    expect(pastMax.success).toBe(false);
    expect(belowMinPage.success).toBe(false);
    expect(belowMinPageSize.success).toBe(false);
  });

  it("BU76 - coerces querystring strings to numbers and leaves status absent when omitted", () => {
    const withStatus = invoiceListQuerySchema.safeParse({
      status: InvoiceStatus.FINALIZED,
      page: PAGE_TWO,
      pageSize: String(BILLING_INVOICE_LIST.MAX_PAGE_SIZE)
    });
    const withoutStatus = invoiceListQuerySchema.safeParse({});

    expect(withStatus.success).toBe(true);
    expect(withStatus.success && typeof withStatus.data.page).toBe("number");
    expect(withStatus.success && typeof withStatus.data.pageSize).toBe("number");
    expect(withStatus.success && withStatus.data.status).toBe(InvoiceStatus.FINALIZED);
    // `undefined`, not a sentinel: the repository omits the predicate entirely on this shape.
    expect(withoutStatus.success && withoutStatus.data.status).toBeUndefined();
  });
});
