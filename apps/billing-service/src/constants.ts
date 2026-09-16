import { InvoiceStatus, Prisma } from "@prisma/client";
import {
  ERROR_RESPONSES,
  INTERNAL_AUTH_HEADERS,
  INTERNAL_AUTH_RESPONSES,
  TENANT_CONTEXT_HEADERS
} from "@telemetry/shared-types";

import { BILLING_SERVICE_STARTUP } from "./startup.constants";

export const BILLING_SERVICE_NAME = "billing-service";

export const BILLING_ROUTES = {
  HEALTH: "/health",
  INTERNAL_BILLING_GENERATE: "/v1/internal/billing/generate",
  INVOICES: "/v1/billing/invoices"
} as const;

export const BILLING_HEADERS = {
  INTERNAL_SECRET: INTERNAL_AUTH_HEADERS.INTERNAL_SECRET,
  // Derived, never re-typed. The same string is still a literal in gateway's and
  // usage-service's own constants files; promoting those two is a separate edit to two other
  // services and is deliberately not folded in here.
  TENANT_ID: TENANT_CONTEXT_HEADERS.TENANT_ID
} as const;

export const BILLING_RESPONSES = {
  STATUS_OK: "ok",
  CODE_UNAUTHORIZED: INTERNAL_AUTH_RESPONSES.CODE_UNAUTHORIZED,
  // Named to match worker-service's `WORKER_RESPONSES.HTTP_STATUS_*` and usage-service's
  // `USAGE_SERVICE_RESPONSES.HTTP_STATUS_*`. `middleware/internal-auth.middleware.ts` still
  // writes a literal 401; that file is left untouched here because it is S-8 item 3's, and
  // these are the constants S-8 should adopt when it lands.
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_CREATED: 201,
  HTTP_STATUS_BAD_REQUEST: 400,
  HTTP_STATUS_UNAUTHORIZED: 401,
  HTTP_STATUS_NOT_FOUND: 404,
  HTTP_STATUS_CONFLICT: 409,
  HTTP_STATUS_UNPROCESSABLE_ENTITY: 422,
  HTTP_STATUS_INTERNAL_ERROR: 500,
  CODE_VALIDATION_ERROR: ERROR_RESPONSES.CODE_VALIDATION_ERROR,
  CODE_INTERNAL_ERROR: ERROR_RESPONSES.CODE_INTERNAL_ERROR,
  MESSAGE_INTERNAL_ERROR: "Internal server error",
  // Tenant-context vocabulary (T-046), matching usage-service's codes, messages and 401
  // status verbatim -- `apps/usage-service/src/constants.ts` USAGE_SERVICE_RESPONSES. Two
  // codes rather than one: a header that was supplied but malformed is a different diagnosis
  // from one that was never sent, and whoever reads the log needs to tell them apart. Both are
  // only reachable after the caller has proved it is the gateway, so neither leaks anything to
  // an unauthenticated client.
  CODE_TENANT_CONTEXT_MISSING: "TENANT_CONTEXT_MISSING",
  MESSAGE_TENANT_CONTEXT_MISSING: "X-Tenant-Id header is required",
  CODE_TENANT_CONTEXT_INVALID: "TENANT_CONTEXT_INVALID",
  MESSAGE_TENANT_CONTEXT_INVALID: "X-Tenant-Id header must be a valid UUID",
  /** The controller's guard for a request that reached it with no tenant on it at all. */
  MESSAGE_TENANT_CONTEXT_REQUIRED: "Missing tenantId from context",
  CODE_TENANT_NOT_FOUND: "TENANT_NOT_FOUND",
  MESSAGE_TENANT_NOT_FOUND: "Tenant not found",
  // D1: a metricKey with unbilled usage and no active meter fails the whole request rather
  // than being skipped. 422 rather than 404 because the request is well-formed and the tenant
  // exists -- what is missing is rate-card data the caller cannot supply on this endpoint.
  CODE_METER_NOT_FOUND: "METER_NOT_FOUND",
  MESSAGE_METER_NOT_FOUND: "No active meter for metric keys",
  // D1's currency sibling. `Invoice.currency` is one column, so a period whose meters
  // disagree has no correct single answer -- picking one would be silently wrong.
  CODE_METER_CURRENCY_CONFLICT: "METER_CURRENCY_CONFLICT",
  MESSAGE_METER_CURRENCY_CONFLICT: "Active meters disagree on currency for this period",
  // Raised inside the write transaction when the billed `updateMany` touches fewer rows than
  // were priced, which means another writer moved them between the read and the write. It is
  // a detector, not a lock: throwing rolls the invoice and its line items back with it.
  CODE_USAGE_LINES_CHANGED: "USAGE_LINES_CHANGED",
  MESSAGE_USAGE_LINES_CHANGED:
    "Usage lines changed between pricing and invoicing; no invoice was created"
} as const;

/**
 * Prisma error codes this service discriminates on.
 *
 * `UNIQUE_VIOLATION_CODE` is the real idempotency serializer for invoice generation. The
 * existence check and the insert run in different transactions, so two concurrent identical
 * requests are not serialised by the check -- `Invoice @@unique([tenantId, periodStart,
 * periodEnd])` is what stops the second insert, and the loser sees this code.
 *
 * **`meta.target` is `null` on the connection this service uses, and the controlling variable
 * is the connection role.** That is why `createDraftInvoice` re-reads by period rather than
 * inspecting `meta`. Measured by varying one dimension at a time against a real duplicate
 * `Invoice` insert (@prisma/client 6.19.3, PostgreSQL 16.13, rows deleted and re-counted):
 *
 * | Connection | Shape | `meta.target` |
 * |---|---|---|
 * | owner (`DIRECT_DATABASE_URL`) | plain create | `["tenantId","periodStart","periodEnd"]` |
 * | owner | `$transaction` + `set_config` | `["tenantId","periodStart","periodEnd"]` |
 * | owner | plain create, nested `lineItems` | `["tenantId","periodStart","periodEnd"]` |
 * | owner | session `set_config`, no transaction | `["tenantId","periodStart","periodEnd"]` |
 * | `telemetry_app` | `$transaction` + `set_config` | **`null`** |
 * | `telemetry_app` | session `set_config`, no transaction | **`null`** |
 *
 * The pairs differ only in the role, at both transaction states, so it is neither the
 * transaction, nor `set_config`, nor the nested create, nor the number of unique constraints.
 * (Mechanism **not** established -- why the restricted role loses the field was not determined,
 * and nothing here should be read as explaining it.)
 *
 * **Why this note is worth its length:** the fixtures seed through `DIRECT_DATABASE_URL`, so
 * anyone debugging this path will see a *populated* `target`, conclude the comment is stale, and
 * "simplify" the re-read into a `meta.target` branch -- which then silently stops working under
 * `telemetry_app`, i.e. in production, on the path the epic calls idempotent. The unit double
 * seeds `meta: { target: null }`, so no test would catch that. Do not reintroduce a
 * `meta.target` branch on the strength of an owner-connection observation.
 *
 * One more thing the next debugger will hit: as `telemetry_app` with **no** tenant context the
 * insert is not a `P2002` at all -- the RLS `WITH CHECK` on `"Invoice"` rejects it first, and
 * Prisma surfaces that as a `PrismaClientUnknownRequestError` with no `code`.
 */
export const BILLING_DATABASE = {
  UNIQUE_VIOLATION_CODE: "P2002"
} as const;

/**
 * Metering vocabulary for `POST /v1/internal/billing/generate`.
 *
 * `INVOICE_STATUS_DRAFT` is derived from Prisma's generated `InvoiceStatus` enum rather than
 * re-typed as `"DRAFT"`, so a schema rename is a compile error here instead of a silent
 * mismatch. There is deliberately no `DEFAULT_CURRENCY`: the invoice's currency always comes
 * from the matched meters, and D1 rejects a period whose meters disagree, so no fallback value
 * is reachable -- see `BillingService`. (Scope of that claim: this task writes `Invoice.currency`
 * in exactly one place, `InvoiceRepository.createDraftInvoice`, from a value the service derived
 * from a non-empty meter list. `Invoice.currency` also carries a database-level `@default("USD")`
 * which nothing in this task relies on.)
 */
export const BILLING_METERING = {
  INVOICE_STATUS_DRAFT: InvoiceStatus.DRAFT,
  MESSAGE_INVALID_PERIOD: "periodStart must be earlier than periodEnd",
  /**
   * How many `UsageLine` ids the billed update addresses per statement.
   *
   * **Not a tuning knob -- a correctness bound.** Prisma 6.19.3 expands `id: { in: [...] }` into
   * an inline `IN ($4,$5,…)` with one bind variable per id, not `= ANY($1)`, and PostgreSQL's
   * extended protocol caps a prepared statement at 32 767 binds. Measured against
   * `usageLine.updateMany` on this tree, as `telemetry_app`, matching zero rows so nothing was
   * written (`UsageLine` re-counted at 0 afterwards):
   *
   * ```
   *  32763 -> OK count=0
   *  32764 -> OK count=0
   *  32765 -> P2035 too many bind variables in prepared statement, expected maximum of 32767
   *  32766 -> P2035
   * ```
   *
   * The id budget is 32 764 rather than 32 767 because the same statement also binds the tenant
   * predicate, the `billed: false` filter and the `billed: true` value. That is arithmetic, and
   * it was checked rather than inferred: at 32 765 ids the error reports `received 32768`, and
   * dropping the `billed: false` filter moves the failure to 32 766 ids — still `received
   * 32768`. So each bound value costs exactly one id slot.
   *
   * Unchunked, a tenant with more than 32 764 unbilled lines in one period could **never** be
   * invoiced: `P2035` is not `P2002`, so it is re-thrown as an opaque `500`, identically on
   * every retry. It failed closed -- the throw is inside `withTenant`, so nothing was billed --
   * but it was unrecoverable without a code change, and one `UsageLine` per event makes 32 764
   * an ordinary month.
   *
   * **Why 1 000, stated as what it is.** It is *not* a safety margin: by the arithmetic above a
   * 5 000 chunk would need ~27 000 further bound values in the same statement before it came
   * near the ceiling, so 1 000 and 5 000 are both far out of danger and it would be wrong to
   * claim otherwise. The deciding reason is testability — a smaller chunk makes a *real*
   * multi-chunk success affordable as a standing integration case, which is what makes the
   * chunking proven rather than asserted. Measured: 1 001 `Event` + `UsageLine` pairs seed in
   * 166 ms, where a 5 000 chunk would need 10 001 rows for the same case. The price is round
   * trips inside an already-open transaction: a tenant at the old 32 764 ceiling takes 33
   * statements instead of 7. `BI11` is the multi-chunk success case; `BI12` drives 32 765 ids,
   * one past the old ceiling, straight through the repository.
   */
  BILLED_UPDATE_CHUNK_SIZE: 1000
} as const;

/**
 * Query contract and sort order for `GET /v1/billing/invoices` (T-046).
 *
 * The pagination bounds are the epic's numbers and are deliberately identical to
 * usage-service's `USAGE_SUMMARY_CONSTANTS`, so the two paged endpoints on the platform do not
 * disagree about what `pageSize=100` means. `pageSize` past the maximum is **rejected**, not
 * clamped: silently serving a different page size than the client asked for makes the client's
 * own offset arithmetic wrong.
 *
 * **The `id` tie-break is correctness, not tidiness.** `Invoice @@unique([tenantId,
 * periodStart, periodEnd])` makes `periodStart` near-unique per tenant but not unique -- two
 * invoices may share a `periodStart` with different `periodEnd`s. Offset pagination over a
 * non-total order lets such rows swap between pages, which silently skips one row and repeats
 * another. `BI16` asserts the union of two pages has no duplicate id and covers the full set;
 * that case is what this second sort key exists for.
 *
 * Field names come from Prisma's generated `InvoiceScalarFieldEnum` and the direction from its
 * `SortOrder`, so a schema rename is a compile error here rather than a runtime surprise --
 * the same discipline as `BILLING_METERING.INVOICE_STATUS_DRAFT`.
 */
export const BILLING_INVOICE_LIST = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MIN_PAGE: 1,
  MIN_PAGE_SIZE: 1,
  MAX_PAGE_SIZE: 100,
  SORT_FIELD_PERIOD_START: Prisma.InvoiceScalarFieldEnum.periodStart,
  SORT_FIELD_ID: Prisma.InvoiceScalarFieldEnum.id,
  SORT_DIRECTION_DESC: Prisma.SortOrder.desc
} as const;

export const BILLING_RUNTIME = {
  // Derived, not repeated. `startup.constants.ts` is the side-effect-free module `index.ts`
  // reads before `initTracing(...)` (`.claude/rules/constants.md`), so it owns the value and
  // this file imports it -- never the other way round, which would drag this module's
  // `@telemetry/shared-types` import into the pre-tracing path.
  //
  // Both objects existed at `961d222` with `3004` written twice, and both copies are live:
  // `index.ts` and `config/env.ts` read the startup one, `tests/smoke.test.ts` reads this one.
  // Pre-existing duplication, not introduced by T-044; collapsed here because T-044's own
  // change made `env.ts` a third reader of the same number (Gate-4 NIT).
  DEFAULT_PORT: BILLING_SERVICE_STARTUP.DEFAULT_PORT,
  HOST: "0.0.0.0"
} as const;
