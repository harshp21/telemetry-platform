import { describe, expect, it } from "vitest";
import { generateInvoiceRequestSchema } from "../src/validators/generate-invoice.validator";
import { BILLING_METERING } from "../src/constants";

/**
 * Request contract for POST /v1/internal/billing/generate (T-045, AC2).
 *
 * The schema is the only thing standing between an internal caller's body and a
 * `TenantScopedRepository` constructor: `tenantIdSchema` both enforces the UUID requirement
 * `.claude/rules/tenant-isolation.md` states and produces the branded `TenantId` the
 * constructor's type demands, so an arbitrary string cannot reach `withTenant`.
 */
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const PERIOD_START = "2026-01-01T00:00:00.000Z";
const PERIOD_END = "2026-02-01T00:00:00.000Z";

const validBody = {
  tenantId: TENANT_ID,
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END
} as const;

const issuePaths = (result: ReturnType<typeof generateInvoiceRequestSchema.safeParse>): string[] => {
  if (result.success) {
    throw new Error("Expected the schema to reject this body, but it parsed successfully");
  }
  return result.error.errors.map((issue) => issue.path.join("."));
};

describe("generateInvoiceRequestSchema", () => {
  it("BU1 - accepts a well-formed body and preserves every field", () => {
    const result = generateInvoiceRequestSchema.safeParse(validBody);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({
      tenantId: TENANT_ID,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END
    });
  });

  it("BU2 - accepts a period expressed with a non-Z UTC offset", () => {
    const result = generateInvoiceRequestSchema.safeParse({
      ...validBody,
      periodStart: "2026-01-01T05:30:00+05:30",
      periodEnd: "2026-02-01T05:30:00+05:30"
    });

    expect(result.success).toBe(true);
  });

  it("BU3 - rejects a tenantId that is not a UUID", () => {
    const result = generateInvoiceRequestSchema.safeParse({
      ...validBody,
      tenantId: "not-a-uuid"
    });

    expect(issuePaths(result)).toContain("tenantId");
  });

  it("BU4 - rejects a missing tenantId", () => {
    const { periodStart, periodEnd } = validBody;

    expect(issuePaths(generateInvoiceRequestSchema.safeParse({ periodStart, periodEnd }))).toContain(
      "tenantId"
    );
  });

  it("BU5 - rejects a periodStart that is not an ISO-8601 instant", () => {
    const result = generateInvoiceRequestSchema.safeParse({
      ...validBody,
      periodStart: "2026-01-01"
    });

    expect(issuePaths(result)).toContain("periodStart");
  });

  it("BU6 - rejects a periodEnd equal to periodStart", () => {
    const result = generateInvoiceRequestSchema.safeParse({
      ...validBody,
      periodEnd: PERIOD_START
    });

    expect(issuePaths(result)).toContain("periodEnd");
    expect(result.success).toBe(false);
    expect(!result.success && result.error.errors[0]?.message).toBe(
      BILLING_METERING.MESSAGE_INVALID_PERIOD
    );
  });

  it("BU7 - rejects a periodEnd earlier than periodStart", () => {
    const result = generateInvoiceRequestSchema.safeParse({
      tenantId: TENANT_ID,
      periodStart: PERIOD_END,
      periodEnd: PERIOD_START
    });

    expect(issuePaths(result)).toContain("periodEnd");
  });

  it("BU8 - rejects a timestamp carrying no timezone designator", () => {
    // `iso8601Schema` is `z.string().datetime({ offset: true })`. A naive local timestamp is
    // what would make the period boundary depend on whoever parsed it, which is the S-18
    // class of defect at the HTTP edge rather than at the SQL one.
    const result = generateInvoiceRequestSchema.safeParse({
      ...validBody,
      periodEnd: "2026-02-01T00:00:00.000"
    });

    expect(issuePaths(result)).toContain("periodEnd");
  });
});
