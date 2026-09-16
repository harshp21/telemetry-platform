import { Prisma, type PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { WORKER_DATABASE } from "../constants";

/**
 * The resolver's qualified name as a SQL fragment.
 *
 * `Prisma.raw` is applied to a **frozen constant and to nothing else** — `CLAUDE.md` § *Raw
 * SQL* forbids `Prisma.raw` on anything caller-supplied. Built once at module scope so there is
 * exactly one place in this service where the resolver's name becomes SQL text.
 */
const RESOLVER_FRAGMENT = Prisma.raw(WORKER_DATABASE.UNBILLED_TENANTS_FN);

/**
 * Enumerates the tenants with unbilled usage in a period — the one query on the platform that is
 * *designed* to read across tenants, and the one query in worker-service that does not run inside
 * `withTenant`.
 *
 * ## Why this is not a `TenantScopedRepository`, and why that is not a rule violation
 *
 * `TenantScopedRepository` binds `tenantId` as a **constructor argument**. That contract is the
 * right one for every other repository in this service, and it is exactly the wrong one here:
 * this is the one place on the platform where the tenant set is *discovered* rather than
 * supplied, so there is no tenant to bind at construction time. This is the same deviation
 * `.claude/rules/tenant-isolation.md` records for auth-service's `UserRepository`, for the same
 * structural reason — the repository exists before any tenant is known.
 *
 * It is registered in the container as a **singleton**, not a factory. The factory rule exists
 * so that a tenant-scoped repository cannot pin one tenant process-wide; this one binds no
 * tenant at all, so there is nothing for a shared instance to pin. `DeadLetterService` is
 * registered as a singleton on the same reasoning.
 *
 * ## What actually bounds the exception
 *
 * Three mechanisms and one convention, labelled as such, because the difference matters:
 *
 * 1. **The database grants this service's role nothing else.** `telemetry_worker_app` holds
 *    `EXECUTE` on this one function plus DML on `"Event"` and `"UsageLine"`, and it is not a
 *    member of `telemetry_worker_definer`, so the definer's `USING (true)` policy is not
 *    reachable from it. Measured, not asserted: `I-E1` in
 *    `tests/billing-enumeration.integration.test.ts` issues `SELECT "tenantId" FROM "UsageLine"`
 *    as this role with no tenant context and gets **zero rows**, while `I-E2` gets that
 *    tenant's rows with the context set — so the zero is the policy, not an empty table.
 *    **Stated as what it measures:** no cross-tenant read *in a single statement with no tenant
 *    context set*. It is not "no cross-tenant read" — see the next section. This is still the
 *    strongest of the four; the rest are weaker.
 * 2. **The function returns `SETOF text`.** There is nothing else to read out of it — no
 *    quantity, no `UsageLine` id, no period. `R5` pins the catalog return type, so widening it
 *    goes red.
 * 3. **This class's public surface is one method returning `TenantId[]`.**
 * 4. *Convention only*: nothing in the type system stops a second method being added here, or a
 *    second resolver being granted to this role. The review check is
 *
 *    ```
 *    grep -rn 'worker_resolve' apps/worker-service/src | grep -vE ':[0-9]+: *\*'
 *    ```
 *
 *    and on the shipped tree it returns exactly **one** line — `src/constants.ts`'s
 *    `UNBILLED_TENANTS_FN` declaration. Anything else is a second site naming the resolver.
 *    Note `RESOLVER_FRAGMENT` at the top of this file does **not** match: it names the constant,
 *    not the resolver.
 *
 *    The comment filter is the point, not decoration. Without it the grep also matches this
 *    docblock's own prose — including the line carrying the pattern, which matches itself — so
 *    any count of the unfiltered form is falsified by editing this comment. An earlier revision
 *    of item 4 described an output the command does not produce, and the first draft of *this*
 *    replacement quoted a count that its own surrounding edit had already made stale. That is
 *    S-33's shape twice in one file; the filtered form is what makes the check re-runnable.
 *
 * ## What this exception widens, and what it does not
 *
 * Not "worker-service can now read other tenants' rows". `telemetry_worker_app` could always do
 * that for any tenant **whose id it holds** — that is what `set_config('app.tenant_id', …)` does,
 * and it is how every service on this platform reaches the tenant it is serving. Re-measured at
 * the Gate-3 rework against two tenants seeded through `DIRECT_DATABASE_URL` and removed
 * afterwards, as `telemetry_worker_app`:
 *
 * 1. no tenant context, `SELECT id, "tenantId" FROM "UsageLine"` → **0 rows**;
 * 2. `SELECT * FROM public.worker_resolve_tenants_with_unbilled_usage(…)` → **both** tenant ids;
 * 3. `BEGIN; SELECT set_config('app.tenant_id', '<an id from step 2>', true);` then
 *    `SELECT … FROM "UsageLine"` → that tenant's row, `… FROM "Event"` → that tenant's row,
 *    `UPDATE "UsageLine" SET billed = true WHERE "tenantId" = '<that id>'` → `UPDATE 1`;
 *    `ROLLBACK`.
 *
 * Step 3 is **unchanged from `telemetry_app`**: the same statements, given the same id, returned
 * the same row and the same `UPDATE 1` as `telemetry_app` in the same session — while
 * `telemetry_app` calling the resolver got `permission denied for function
 * worker_resolve_tenants_with_unbilled_usage`. So what the exception buys is step 2 and only step
 * 2: the ids **no longer have to be known**. It converts "read or write any tenant whose id you
 * already hold" into "enumerate every tenant with unbilled usage, and then do that". That is the
 * widening decision A2 accepted, and it is why `EXECUTE` is granted to this role alone rather
 * than to the `telemetry_app` the other four services share.
 *
 * ## Timestamps
 *
 * Both bounds are **already-normalised ISO strings** and are **bound parameters**. The resolver
 * declares them `text` and casts inside its own body, which is what keeps the day boundary
 * independent of the caller's session zone — a `timestamp` parameter would be coerced in the
 * caller's session, before the body runs. The mistake is loud rather than silent here, measured
 * against this signature rather than inferred from a built-in stand-in: binding a JS `Date`
 * gives Prisma `P2010` with `meta.code = "42883"` and the message
 * `function public.worker_resolve_tenants_with_unbilled_usage(timestamp with time zone,
 * timestamp with time zone) does not exist`. Scope of that claim: this function, PostgreSQL
 * 16.13, Prisma 6.19.3, both bounds bound as `Date`.
 *
 * Note this does **not** contradict `EventRepository`'s rule that no `$queryRaw` in this
 * service may bind a `Date` — it is that rule, obeyed. worker's `withTenant` carries no
 * `TimeZone` pin (S-19), and this call runs outside `withTenant` in any case, so the pin would
 * not have covered it even if it existed.
 */
export class BillingEnumerationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The tenants holding at least one unbilled `UsageLine` in `[periodStart, periodEnd)`.
   *
   * The half-open interval and the `billed = false` predicate are the resolver's, and they are
   * deliberately identical to billing-service's own
   * `InvoiceRepository.sumUnbilledByMetricKey` — `billed: false, periodStart: { gte, lt }`. A
   * tenant this method names is exactly a tenant for which that query finds rows.
   *
   * **Scoped deliberately, because the obvious stronger reading is false (S-45).** An earlier
   * revision of this paragraph concluded "so an enumeration that is right cannot produce a
   * `200 { invoiceId: null }` for lack of usage". That sentence is literally true and invites
   * "enumerated ⇒ billed", which is not: billing returns at step 2 when an invoice already
   * exists for the period, *before* `sumUnbilledByMetricKey` runs at all
   * (`apps/billing-service/src/services/billing.service.ts:75-82`). Measured — one row inserted
   * unbilled into an already-invoiced window is enumerated here, answered `200` with the
   * existing invoice id, and left `billed = false` permanently, with the job reporting
   * `succeeded: 1, failed: 0`. What this method guarantees is that the *usage* exists; whether
   * billing prices it is billing's ordering, and S-45 is the open record of that.
   *
   * @param periodStart Inclusive lower bound, an ISO-8601 instant in UTC
   *   (`new Date(x).toISOString()`). Not a `Date` — see the class docblock.
   * @param periodEnd Exclusive upper bound, same form.
   *
   * **The `TenantId` brand is asserted here, not earned.** `row.tenantId as TenantId` casts a
   * `$queryRaw` result with no UUID check, so a malformed `"UsageLine"."tenantId"` would be
   * carried as a `TenantId` by this one call. Left as a cast deliberately, for two reasons rather
   * than one: it is what every other database-sourced mint on the platform does
   * (`apps/auth-service/src/repositories/user.repository.ts:314`, `:354`, `:413`), and the value
   * originates from a column with a foreign key to `"Tenant"."id"`, not from a request. The
   * `.claude/rules/tenant-isolation.md` prohibition is on accepting a *caller-supplied* id that
   * is not a UUID, which this is not.
   *
   * What the exposure actually is, stated rather than assumed away: billing-service validates
   * with `tenantIdSchema` (`uuidSchema.transform(...)`), so a malformed id returns `400`, is
   * counted in the summary's `failed`, and is logged per tenant. A log line, not a wrong write.
   * If this is ever tightened, tighten it as a parse that *skips and logs* rather than one that
   * throws — throwing turns one bad row into a night with no invoices for anybody.
   *
   * Errors propagate. Returning `[]` on failure would make a broken enumeration
   * indistinguishable from a night with no usage, and the job would then report success having
   * invoiced nobody — the one failure mode that raises no alarm, because "no invoice" looks
   * exactly like "no usage".
   */
  async listTenantsWithUnbilledUsage(
    periodStart: string,
    periodEnd: string
  ): Promise<TenantId[]> {
    const rows = await this.prisma.$queryRaw<{ tenantId: string }[]>(
      Prisma.sql`SELECT t AS "tenantId" FROM ${RESOLVER_FRAGMENT}(${periodStart}, ${periodEnd}) AS t`
    );

    return rows.map((row) => row.tenantId as TenantId);
  }
}
