import { z } from "zod";
import { iso8601Schema, tenantIdSchema } from "@telemetry/shared-validation";
import { BILLING_METERING } from "../constants";

/**
 * Request contract for `POST /v1/internal/billing/generate`.
 *
 * `tenantId` arrives in the body rather than from a gateway header (D6): this endpoint is
 * internal-only and the caller is a scheduler naming a customer, not a customer. That does not
 * weaken `.claude/rules/tenant-isolation.md` -- the rule forbids a *repository* deriving its
 * tenant from a caller-supplied field, and none does. The parsed value is what *selects* the
 * repository from the container factory; every predicate inside comes from `this.where({})`.
 *
 * `tenantIdSchema` (`packages/shared-validation/src/index.ts`) is
 * `uuidSchema.transform(v => v as TenantId)`, so it enforces the UUID requirement the rule
 * states and hands back the branded type the repository constructor demands. A non-UUID
 * therefore cannot reach a `withTenant` call -- BU3 and BU4 assert the runtime half, and the
 * brand carries the compile-time half.
 *
 * Both instants require an explicit offset (`iso8601Schema` is
 * `z.string().datetime({ offset: true })`), and they are compared in UTC -- Q3's midnight-UTC
 * assumption, written down rather than inherited. This task introduces no local-midnight logic.
 */
export const generateInvoiceRequestSchema = z
  .object({
    tenantId: tenantIdSchema,
    periodStart: iso8601Schema,
    periodEnd: iso8601Schema
  })
  .refine(
    ({ periodStart, periodEnd }) =>
      new Date(periodStart).getTime() < new Date(periodEnd).getTime(),
    {
      message: BILLING_METERING.MESSAGE_INVALID_PERIOD,
      path: ["periodEnd"]
    }
  );

export type GenerateInvoiceRequest = z.infer<typeof generateInvoiceRequestSchema>;
