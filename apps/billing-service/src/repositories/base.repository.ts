import type { PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";

/**
 * The transaction client Prisma actually hands a `$transaction` callback.
 *
 * Exported so that `InvoiceRepository` can widen back to it in **exactly one** accessor, which
 * `BU125` counts. Nothing else in `src/` should name it -- and note what that counting is worth:
 * `BU125` matches an enumerated list of cast forms, so it catches the spellings it knows and no
 * others. S-48 carries the measurement and the routes no source census reaches.
 */
export type FullTransactionClient = Omit<
	PrismaClient,
	"$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Every mutating member `InvoiceDelegate` declares at `@prisma/client` 6.19.3.
 *
 * **Derived from the generated client, not from memory.** Round 1 of T-048's review flagged the
 * nine names as reasoning rather than measurement, so they were re-derived twice:
 *
 * 1. `ts.createProgram` over `apps/billing-service/tsconfig.json` with
 *    `checker.getPropertiesOfType(PrismaClient["invoice"])` -> **18** members. Removing the nine
 *    below leaves `keyof TransactionClient["invoice"]` at exactly **9**: `aggregate`, `count`,
 *    `fields`, `findFirst`, `findFirstOrThrow`, `findMany`, `findUnique`, `findUniqueOrThrow`,
 *    `groupBy`.
 * 2. The generated `.prisma/client/index.d.ts` argument types, read member by member. Six of the
 *    nine carry a `data` member (`create`, `createMany`, `createManyAndReturn`, `update`,
 *    `updateMany`, `updateManyAndReturn`); `upsert` carries `create` and `update` payload
 *    members instead; `delete` and `deleteMany` mutate by address and carry no payload. None of
 *    the residual nine carries `data`, `create` or `update` -- their members are `select`,
 *    `omit`, `include`, `where`, `cursor`, `take`, `skip`, `distinct`, `by`, `having` -- and
 *    `fields` is a `readonly ...FieldRefs` property rather than a method.
 *
 * So nine is the complete mutating set **at this version**, which is the strength of the claim:
 * a Prisma upgrade that adds a tenth is what `InvoiceDelegateSurfaceCensus` below exists to stop
 * from landing silently (S-49 is the standing entry for that class of drift).
 */
type InvoiceWriteMethod =
	| "create"
	| "createMany"
	| "createManyAndReturn"
	| "update"
	| "updateMany"
	| "updateManyAndReturn"
	| "upsert"
	| "delete"
	| "deleteMany";

/** The nine members the narrowing deliberately leaves in place, same version, same derivation. */
type InvoiceReadMethod =
	| "aggregate"
	| "count"
	| "fields"
	| "findFirst"
	| "findFirstOrThrow"
	| "findMany"
	| "findUnique"
	| "findUniqueOrThrow"
	| "groupBy";

type ExactlyEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

/**
 * The two unions above, asserted against the delegate the installed Prisma actually generates.
 *
 * `BU125` and `BU126` read source text, so neither can see a change that arrives through
 * `node_modules`. This one is a type, so `pnpm typecheck` is the thing that runs it: if an
 * upgrade adds, removes or renames a delegate member, `ExactlyEqual` resolves to `false` and
 * this alias fails its `extends true` constraint.
 *
 * **Mutation, both directions, run at Gate 3 Round 2 with
 * `pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json`:** adding an
 * invented `"probeFutureWrite"` to `InvoiceWriteMethod` gives
 * `error TS2344: Type 'false' does not satisfy the constraint 'true'` on the
 * `InvoiceDelegateSurfaceCensus` declaration below, and deleting `"groupBy"` from
 * `InvoiceReadMethod` gives the same diagnostic on the same declaration. Both reverted, and the
 * package typechecks at 0 errors either side of them.
 *
 * **`Extract<..., string>` is load-bearing and was measured, not assumed.** Written as a bare
 * `keyof`, this alias fails on the *current* Prisma: the generated `InvoiceDelegate` declares a
 * symbol index signature (`.prisma/client/index.d.ts:8972`, `[K: symbol]: { types: ... }`), so
 * `keyof` yields `symbol` alongside the 18 string members and the equality is `false` against
 * any list of names. The first form of this census was written without it and failed exactly
 * that way.
 *
 * It says nothing about whether a *new* member mutates -- that is a judgement the next reader
 * has to make. What it removes is the silence.
 */
export type InvoiceDelegateSurfaceCensus = AssertTrue<
	ExactlyEqual<
		Extract<keyof FullTransactionClient["invoice"], string>,
		InvoiceWriteMethod | InvoiceReadMethod
	>
>;

/**
 * What `withTenant` hands its callback: the full client with **`tx.invoice`'s write methods
 * removed**, so every write to an `Invoice` has to come from `InvoiceRepository`'s guarded
 * seam (T-048).
 *
 * ## What this does and does not give you, at exactly the strength it was measured
 *
 * Measured with `pnpm --filter @telemetry/billing-service exec tsc --noEmit -p tsconfig.json`,
 * which includes `tests/**` as well as `src/**`, so the figures below are the whole package:
 *
 * - A bare `tx.invoice.update(...)` written anywhere outside the seam is
 *   `error TS2339: Property 'update' does not exist on type
 *   'Omit<InvoiceDelegate<DefaultArgs, PrismaClientOptions>, InvoiceWriteMethod>'` (probe
 *   P-G1). That is the naive bypass, and it stops compiling.
 * - A writer that deliberately widens `tx` back to `FullTransactionClient` **compiles clean, 0
 *   errors** (probe P-G2). So the guarantee is that a bypass is **made visible in the forms the
 *   census enumerates**, not that it is impossible: it has to be spelled as a cast, and `BU125`
 *   counts the **`as`-form spellings** of the cast targets it lists -- `FullTransactionClient`,
 *   `PrismaClient`, a `Prisma` model delegate and `any`, each with an optional `unknown` hop --
 *   across `src/`. **It counts spellings, not targets**: all four patterns are anchored on
 *   `\bas\s+`, so the *same* target written as an angle-bracket type assertion is invisible to
 *   every one of them. Measured at Gate-3 Round 4 by inserting an angle-bracket assertion of
 *   `tx` through `unknown` to this file's own exported full-client type, after the seam call in
 *   `absorbLateUsage`, and taking the widened delegate's `updateMany`: **0 tsc diagnostics, 0
 *   lint findings, census file 37/37 green**, while `grep -rn "FullTransactionClient>"
 *   apps/billing-service/src` finds it. An earlier revision of this sentence said the census
 *   counts the cast *targets* it lists, which that probe refutes for the target it names first.
 *   **A regex census catches the forms it enumerates and nothing else.** T-048's Gate-4 review
 *   established that by execution: with `BU125` matching a single spelling and `BU126`'s member
 *   pattern recognising only `private`, a `protected` writer casting the *delegate* rather than
 *   the client passed typecheck (0), lint (0) and the whole package (**213 passed (213)**) while
 *   writing `status: "FINALIZED"`. Both patterns were widened at Gate 3 Round 2 and that writer
 *   now reddens `BU125` and `BU126` -- `2 failed | 35 passed (37)` in the census file,
 *   `2 failed | 211 passed (213)` in the package, and each case red on its own under
 *   `vitest -t`. A fifth spelling would still be missed.
 * - **`this.prisma` is not reached by any of this, and it is the worse route.** Inserting
 *   `this.prisma.invoice.update(...)` into a repository method with this narrowing in place
 *   added **zero** diagnostics -- the error count stayed where it was. `TenantScopedRepository`
 *   holds `protected readonly prisma: PrismaClient`, and a write through it runs *outside* the
 *   transaction, so no `set_config('app.tenant_id', ...)` has been issued at all. That is the
 *   route `docs/epics/epic-8-billing-service.md` § *T-048*'s own snippet writes. Recorded as
 *   S-48, which stays open.
 * - **Two further routes were measured at Gate 4 and are recorded in S-48's route table**, so
 *   `this.prisma` is *one of several* things this does not reach rather than the only one: the
 *   `prisma` module singleton imported from any layer (0 diagnostics, and invisible to `BU125`
 *   because it needs no cast), and `tx.$executeRaw` inside `withTenant` (0 diagnostics). The
 *   `Omit` above removes six `$`-methods and leaves **four** -- `$executeRaw`,
 *   `$executeRawUnsafe`, `$queryRaw`, `$queryRawUnsafe` -- enumerated from the type with the
 *   TypeScript compiler API rather than read off the `Omit`.
 *
 * ## Why the write methods and not the whole delegate
 *
 * S-48 proposed adding `"invoiceLineItem"` to the `Omit` above, which works there because
 * nothing reads that delegate. The same shape applied to `"invoice"` does **not** transfer:
 * measured, it gives 11 errors -- 7 x `TS2339`, of which **five are legitimate reads**
 * (`findUnique`, `findUniqueOrThrow`, `findMany`, `count`, `findFirst`) and two are the
 * writers -- plus 2 x `TS2345` and 2 x `TS7006`. Narrowing the delegate instead leaves all
 * five reads compiling and isolates exactly the two writers.
 *
 * ## Scope
 *
 * **billing-service only.** `S-19` records that this file is one of five near-copies; the other
 * four are deliberately untouched, so billing's copy is now a fourth distinct variant. Do not
 * propagate this by hand -- the unification is S-19's own task.
 */
export type TransactionClient = Omit<FullTransactionClient, "invoice"> & {
	invoice: Omit<FullTransactionClient["invoice"], InvoiceWriteMethod>;
};

interface Logger {
	error(obj: unknown, msg: string): void;
	debug(obj: unknown, msg: string): void;
}

/**
 * Abstract base class for all tenant-scoped repositories.
 *
 * Enforces multi-tenant data isolation via two layers:
 *
 * 1. **Application layer** — `where()` helper merges `tenantId` into all query conditions.
 *    Prevents accidental cross-tenant queries; caught at query time.
 *
 * 2. **Database layer** — `withTenant()` calls `set_config('app.tenant_id', tenantId)`,
 *    activating Postgres Row-Level Security (RLS) policies.
 *    Prevents data leaks even if application code is compromised.
 *
 * ## Usage Pattern
 *
 * ```ts
 * class EventRepository extends TenantScopedRepository {
 *   async findByType(eventType: string) {
 *     return this.withTenant(async (tx) => {
 *       return tx.event.findMany({
 *         where: this.where({ eventType }),
 *       });
 *     });
 *   }
 * }
 *
 * // In a route handler:
 * const repo = new EventRepository(prisma, req.auth.tenantId, logger);
 * const events = await repo.findByType("api.request");
 * // App layer: where() ensures WHERE tenantId = req.auth.tenantId
 * // DB layer: RLS policy blocks any row where row.tenantId != app.tenant_id
 * // Error layer: transaction failures logged with tenant context
 * ```
 *
 * ## Security Properties
 *
 * - ✅ `where()` compile-error if caller tries to pass `tenantId` (via `{ tenantId?: never }` constraint)
 * - ✅ `withTenant()` scopes RLS context to transaction only (`is_local = true`)
 * - ✅ RLS actually enforces because the runtime role (`telemetry_app`) is
 *   NOSUPERUSER, NOBYPASSRLS and owns no tables. `FORCE ROW LEVEL SECURITY` alone would
 *   NOT stop a superuser — it only removes the *table owner's* exemption. See
 *   `prisma/migrations/v1_4_app_role_non_superuser/migration.sql`.
 * - ✅ Transaction errors logged with tenant context for observability
 * - ✅ Two-layer defense: app + DB isolation
 *
 * ## Non-Goals
 *
 * - Compile-time enforcement of `withTenant()` wrapper — code review catch
 * - Auto-wrapping of all queries — developer responsibility
 */
export abstract class TenantScopedRepository {
	protected readonly logger: Logger;

	constructor(
		protected readonly prisma: PrismaClient,
		protected readonly tenantId: TenantId,
		logger?: Logger
	) {
		this.logger =
			logger ||
			{
				error: (obj: unknown, msg: string) => {
					const context = typeof obj === "object" && obj !== null ? obj : { error: obj };
					console.error({ ...context, tenantId }, msg);
				},
				debug: (obj: unknown, msg: string) => {
					const context = typeof obj === "object" && obj !== null ? obj : { data: obj };
					console.warn({ ...context, tenantId }, msg);
				},
			};
	}

	protected where<T extends { tenantId?: never } & Record<string, unknown>>(
		conditions: T
	): Omit<T, "tenantId"> & { tenantId: TenantId } {
		return { ...conditions, tenantId: this.tenantId };
	}

	// Sets app.tenant_id for the duration of the transaction so Postgres RLS policies fire.
	protected async withTenant<T>(
		fn: (tx: TransactionClient) => Promise<T>
	): Promise<T> {
		try {
			this.logger.debug({ operation: "transaction_start" }, "Starting tenant-scoped transaction");
			const result = await this.prisma.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT set_config('app.tenant_id', ${this.tenantId}, true)`;
				return fn(tx);
			});
			this.logger.debug({ operation: "transaction_commit" }, "Tenant-scoped transaction committed");
			return result;
		} catch (err) {
			this.logger.error(
				{ operation: "transaction_rollback", error: err instanceof Error ? err.message : String(err) },
				"Tenant-scoped transaction failed and was rolled back"
			);
			throw err;
		}
	}
}
