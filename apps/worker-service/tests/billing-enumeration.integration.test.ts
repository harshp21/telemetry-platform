import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { WORKER_DATABASE } from "../src/constants";
import { BillingEnumerationRepository } from "../src/repositories/billing-enumeration.repository";
import {
  INTEGRATION_COUNTS,
  INTEGRATION_ENUMERATION,
  INTEGRATION_ENUMERATION_CATALOG,
  INTEGRATION_ENUMERATION_SESSION_TIME_ZONE
} from "./integration.constants";

/**
 * Live PostgreSQL suite for T-042's cross-tenant enumeration exception (slices S1, S2, S5).
 *
 * **Postgres only.** This suite opens no Redis connection, so none of this package's
 * logical-database machinery applies to it.
 *
 * **Four connections, and the distinction is the whole point.**
 *
 * - `worker` runs on `DATABASE_URL`, which `tests/setup.ts` points at `telemetry_worker_app` --
 *   `NOSUPERUSER`, `NOBYPASSRLS`, owner of no table. This is the connection under test, and
 *   `beforeAll` **throws** if it is anything else. `.claude/rules/tenant-isolation.md`: a
 *   passing RLS test is not evidence unless it runs as that kind of role. Without the guard,
 *   `I-E1` -- the zero-row negative that the entire "bounded by mechanism" claim rests on --
 *   would pass under a superuser while enforcing nothing.
 * - `admin` runs on `DIRECT_DATABASE_URL` (the owner) and seeds every fixture, because as the
 *   role under test the inserts are themselves subject to the policies under test.
 * - `pinnedUtc` and `pinnedNonUtc` are two further `telemetry_worker_app` connections whose
 *   session `TimeZone` is forced to `UTC` and `Asia/Kolkata` respectively (`I-TZ1`).
 *
 * **What the mutations established, stated as measured.** Four mutations were applied to the
 * live catalog with the function body from
 * `prisma/migrations/v1_7_worker_billing_enumerator/migration.sql`, and the suite re-run against
 * each. `M1` and `M4` were **re-run at the Gate-3 rework against this 14-case suite**; the totals
 * below are from that run. (The first version of this docstring recorded them as `(12)` from an
 * earlier revision of the file and named three failing cases for `M4` where there are four --
 * S-33's shape, a measured claim going stale inside the change that moved it. Corrected here by
 * re-running, not by editing the numbers.)
 *
 * - *M1* -- parameters redeclared `timestamp(3)` and the body's `::timestamp(3)` casts removed,
 *   the caller still binding ISO strings. `Tests 8 failed | 6 passed (14)`: `R1`-`R5`, `R11`,
 *   `R12` and `I-TZ1`, every one of them
 *   `Raw query failed. Code: '42883'. Message: ERROR: function
 *   public.worker_resolve_tenants_with_unbilled_usage(text, text) does not exist`. Loud, and it
 *   takes out both repository cases as well as the raw ones.
 * - *M2* -- the same signature, with the call site binding a JS `Date`. **This did not produce
 *   the silent shift the plan predicted.** Prisma binds a `Date` as `timestamptz`
 *   (`SELECT pg_typeof(${new Date(...)})::text` -> `timestamp with time zone`), and PostgreSQL
 *   does not implicitly cast `timestamptz` to `timestamp` during *function overload
 *   resolution*, so the call fails to resolve: `42883`,
 *   `function ...(timestamp with time zone, timestamp with time zone) does not exist`. The
 *   plan's prediction came from `PREPARE p(timestamptz) AS SELECT $1::timestamp(3)`, where the
 *   cast is written explicitly and therefore happens; a function argument is a different
 *   resolution path. Measured, not reasoned about, and recorded because it narrows a claim in
 *   `CLAUDE.md` § *Raw SQL and timestamps* rather than contradicting it.
 * - *M3* -- the shipped `text` signature with the caller binding a `Date`: also `42883`, against
 *   the real signature. So on this resolver **every** wrong bound form measured is loud. That
 *   is a property of the `text` declaration, and it is what `R5` pins.
 * - *M4* -- the shipped signature, body casting the bound to `::timestamptz` instead of
 *   `::timestamp(3)`. This is the one wrong form that is **silent**: a naive column compared
 *   against a `timestamptz` is coerced through the session zone. `Tests 4 failed | 10 passed
 *   (14)`, no error raised, the answer simply wrong -- `R1`, `R2`, `R11` and `I-TZ1`. Under the
 *   two pinned arms the `UTC` side returned the correct `{A, B}` and the `Asia/Kolkata` side
 *   returned `{A, D, E}`.
 *
 *   **And the run that makes `I-TZ1` worth its wall clock**, re-performed at the rework: the same
 *   M4 mutation with `DATABASE_URL` carrying `?options=-c%20timezone%3DUTC`, which is what CI's
 *   `postgres:16-alpine` gives every connection. `Tests 1 failed | 13 passed (14)` --
 *   **`I-TZ1` alone**. `R1`, `R2` and `R11` all pass on a UTC server under the defect they
 *   otherwise catch, so without `I-TZ1` this suite would ship the M4 bug green on the host that
 *   runs the gate. That is the S-21 failure mode, avoided rather than described.
 *
 *   The catalog was restored from the migration's own definition after each mutation and verified
 *   identical by `md5(pg_get_functiondef || proacl || owner)` = `80df483aaaef1200a4f86885961b1859`
 *   (this host; the digest is a before/after comparator, not a portable constant).
 *
 * **So `I-TZ1`'s value is narrower than "it catches the timezone bug", and is stated as what it
 * is.** `R1` already catches M4 *on a server whose default zone is not UTC* -- this development
 * host's session zone is `Asia/Kolkata`, checked with `show timezone`. What `I-TZ1` adds is that
 * the same defect is caught on a server whose default **is** UTC -- CI's `postgres:16-alpine` --
 * where `R1`, `R2` and `R11` all pass, measured above. That is why both of its arms are pinned rather than
 * one: a one-armed version would have been decoration on exactly the host that runs the gate,
 * which is the S-21 failure mode.
 *
 * **Fixture hygiene (S-20).** Rows are deleted by explicit id in `afterAll`, *and* a sweep by
 * the **stable** `Tenant.name` prefix runs in both `beforeAll` and `afterAll` so that an
 * earlier run's residue is collectable. S-20 is the entry about a suite whose per-run-unique
 * filter could not match anything it had previously left behind.
 */

const ADMIN_URL_FALLBACK = "postgresql://postgres:postgres@localhost:5432/telemetry";

const requireEnv = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`${name} must be set for the T-042 billing-enumeration integration test`);
  }

  return value;
};

interface RoleAttributes {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
}

interface TenantIdRow {
  readonly tenantId: string;
}

interface FunctionCatalogRow {
  readonly result_type: string;
  readonly arguments: string;
  readonly argument_count: number;
  readonly is_security_definer: boolean;
  readonly owner: string;
}

interface ExecutePrivilegeRow {
  readonly public_can_execute: boolean;
  readonly shared_can_execute: boolean;
  readonly worker_can_execute: boolean;
}

interface MembershipRow {
  readonly shared_is_member: boolean;
  readonly worker_is_member: boolean;
}

interface GrantedRelationRow {
  readonly relname: string;
}

interface PolicyRow {
  readonly policyname: string;
  readonly cmd: string;
  readonly roles: string[];
}

interface TimeZoneRow {
  readonly TimeZone: string;
}

/**
 * The resolver's qualified name as a SQL fragment.
 *
 * `Prisma.raw` on a **frozen constant**, never on anything caller-supplied
 * (`CLAUDE.md` § *Raw SQL*). Both period bounds below are bound parameters.
 */
const RESOLVER_FRAGMENT = Prisma.raw(WORKER_DATABASE.UNBILLED_TENANTS_FN);

const suiteRunId = randomUUID();
const tenantName = (label: string): string =>
  [INTEGRATION_ENUMERATION.TENANT_NAME_PREFIX, suiteRunId, label].join(
    INTEGRATION_ENUMERATION.TENANT_NAME_SEPARATOR
  );

/** The five fixture tenants. See `INTEGRATION_ENUMERATION`'s table for why each exists. */
const tenantAId = randomUUID();
const tenantBId = randomUUID();
const tenantCId = randomUUID();
const tenantDId = randomUUID();
const tenantEId = randomUUID();

interface SeedRow {
  readonly tenantId: string;
  readonly label: string;
  readonly periodStartIso: string;
  readonly billed: boolean;
}

const SEED_ROWS: readonly SeedRow[] = [
  { tenantId: tenantAId, label: "a1", periodStartIso: INTEGRATION_ENUMERATION.ROW_A1_ISO, billed: false },
  { tenantId: tenantAId, label: "a2", periodStartIso: INTEGRATION_ENUMERATION.ROW_A2_ISO, billed: false },
  { tenantId: tenantBId, label: "b", periodStartIso: INTEGRATION_ENUMERATION.ROW_B_ISO, billed: false },
  { tenantId: tenantCId, label: "c", periodStartIso: INTEGRATION_ENUMERATION.ROW_C_ISO, billed: true },
  { tenantId: tenantDId, label: "d", periodStartIso: INTEGRATION_ENUMERATION.ROW_D_ISO, billed: false },
  { tenantId: tenantEId, label: "e", periodStartIso: INTEGRATION_ENUMERATION.ROW_E_ISO, billed: false }
];

const TENANT_IDS = [tenantAId, tenantBId, tenantCId, tenantDId, tenantEId] as const;

/** `{A, B}` -- the only two tenants with unbilled usage inside `[WINDOW_START, WINDOW_END)`. */
const EXPECTED_TENANTS = [tenantAId, tenantBId].slice().sort();

let admin: PrismaClient;
let worker: PrismaClient;
let pinnedUtc: PrismaClient;
let pinnedNonUtc: PrismaClient;

/**
 * Builds a DSN with the session `TimeZone` forced.
 *
 * The base is taken up to any existing `?`, so that overriding `DATABASE_URL` with an
 * already-parameterised DSN (which is how the CI server default was simulated at Gate 3)
 * produces one `options` parameter rather than two. Every caller asserts `SHOW timezone`
 * afterwards, so a DSN this mangled would fail loudly rather than silently reuse the default.
 */
const withSessionTimeZone = (dsn: string, suffix: string): string =>
  `${dsn.split("?")[0] ?? dsn}${suffix}`;

const enumerate = async (
  client: PrismaClient,
  periodStart: string,
  periodEnd: string
): Promise<string[]> => {
  const rows = await client.$queryRaw<TenantIdRow[]>(
    Prisma.sql`SELECT t AS "tenantId" FROM ${RESOLVER_FRAGMENT}(${periodStart}, ${periodEnd}) AS t`
  );

  return rows.map((row) => row.tenantId).sort();
};

/**
 * Deletes this suite's rows.
 *
 * Driven from `Tenant.name LIKE '<stable prefix>%'` rather than from the in-memory id list, so
 * a *previous* run's orphans are collected too (S-20). Children first: `UsageLine.eventId`
 * references `Event`, which references `Tenant`.
 */
const sweepFixtures = async (): Promise<void> => {
  const orphans = await admin.tenant.findMany({
    where: { name: { startsWith: INTEGRATION_ENUMERATION.TENANT_NAME_PREFIX } },
    select: { id: true }
  });
  const ids = orphans.map((row) => row.id);
  if (ids.length === INTEGRATION_COUNTS.NONE) {
    return;
  }

  await admin.usageLine.deleteMany({ where: { tenantId: { in: ids } } });
  await admin.event.deleteMany({ where: { tenantId: { in: ids } } });
  await admin.tenant.deleteMany({ where: { id: { in: ids } } });
};

beforeAll(async () => {
  admin = new PrismaClient({
    datasourceUrl: requireEnv("DIRECT_DATABASE_URL", ADMIN_URL_FALLBACK),
    log: ["error"]
  });
  worker = new PrismaClient({ datasourceUrl: requireEnv("DATABASE_URL"), log: ["error"] });
  pinnedUtc = new PrismaClient({
    datasourceUrl: withSessionTimeZone(
      requireEnv("DATABASE_URL"),
      INTEGRATION_ENUMERATION_SESSION_TIME_ZONE.UTC_URL_SUFFIX
    ),
    log: ["error"]
  });
  pinnedNonUtc = new PrismaClient({
    datasourceUrl: withSessionTimeZone(
      requireEnv("DATABASE_URL"),
      INTEGRATION_ENUMERATION_SESSION_TIME_ZONE.NON_UTC_URL_SUFFIX
    ),
    log: ["error"]
  });

  // The guard for the whole file. Every zero-row and every grant assertion below is vacuous
  // under a superuser or a BYPASSRLS role, and reads as a wiring problem rather than as the
  // wrong role under test if only the attributes are checked -- so the *name* is pinned too,
  // exactly as `apps/auth-service/tests/rls.integration.test.ts` pins `telemetry_auth_app`.
  const roles = await worker.$queryRaw<RoleAttributes[]>`
    SELECT r.rolname, r.rolsuper, r.rolbypassrls
    FROM pg_roles r WHERE r.rolname = current_user
  `;
  const role = roles[0];
  if (!role) {
    throw new Error("Could not resolve the role under test from pg_roles");
  }
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `DATABASE_URL connects as ${role.rolname}, which is a superuser or holds BYPASSRLS. The enumeration bound cannot be proven through it.`
    );
  }
  if (role.rolname !== WORKER_DATABASE.WORKER_APP_ROLE) {
    throw new Error(
      `DATABASE_URL connects as ${role.rolname}; this suite must run as ${WORKER_DATABASE.WORKER_APP_ROLE}, the role worker-service actually uses.`
    );
  }

  await sweepFixtures();

  for (const [index, tenantId] of TENANT_IDS.entries()) {
    await admin.tenant.create({ data: { id: tenantId, name: tenantName(String(index)) } });
  }
  for (const row of SEED_ROWS) {
    const eventId = randomUUID();
    const occurredAt = new Date(row.periodStartIso);
    await admin.event.create({
      data: {
        id: eventId,
        tenantId: row.tenantId,
        idempotencyKey: `${INTEGRATION_ENUMERATION.TENANT_NAME_PREFIX}-${suiteRunId}-${row.label}`,
        eventType: INTEGRATION_ENUMERATION.EVENT_TYPE,
        quantity: INTEGRATION_ENUMERATION.QUANTITY,
        unit: INTEGRATION_ENUMERATION.EVENT_UNIT,
        occurredAt
      }
    });
    await admin.usageLine.create({
      data: {
        tenantId: row.tenantId,
        eventId,
        metricKey: INTEGRATION_ENUMERATION.METRIC_KEY,
        quantity: INTEGRATION_ENUMERATION.QUANTITY,
        periodStart: occurredAt,
        periodEnd: occurredAt,
        billed: row.billed
      }
    });
  }
});

afterAll(async () => {
  // In `afterAll` as well as by explicit id, and by the stable prefix: S-20 records that
  // `beforeEach`-only cleanup leaves whatever the last case created, permanently.
  if (admin) {
    await sweepFixtures();
    await admin.$disconnect();
  }
  await worker?.$disconnect();
  await pinnedUtc?.$disconnect();
  await pinnedNonUtc?.$disconnect();
});

describe("T-042 cross-tenant enumeration resolver (integration)", () => {
  it("R1 - returns exactly the tenants with unbilled usage inside the window", async () => {
    const tenants = await enumerate(
      worker,
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );

    expect(tenants).toEqual(EXPECTED_TENANTS);
    // Negative, spelled out rather than implied by the equality: tenant C's only row in the
    // window is `billed = true`, so a resolver that dropped the `billed = false` predicate
    // would re-invoice usage that has already been billed.
    expect(tenants).not.toContain(tenantCId);
  });

  it("R2 - excludes a row whose periodStart equals the window's end (half-open interval)", async () => {
    const tenants = await enumerate(
      worker,
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );

    // Tenant D's only row sits exactly on `WINDOW_END`. `<` rather than `<=` is what keeps one
    // day's usage off two consecutive invoices; `UsageLine.billed` is set once, so that error
    // would not be self-correcting.
    expect(tenants).not.toContain(tenantDId);
    // The matching inclusive lower bound: tenant B's only row sits exactly on `WINDOW_START`.
    expect(tenants).toContain(tenantBId);
  });

  it("R3 - returns a tenant once even when it has several unbilled rows", async () => {
    const rows = await worker.$queryRaw<TenantIdRow[]>(
      Prisma.sql`SELECT t AS "tenantId" FROM ${RESOLVER_FRAGMENT}(${INTEGRATION_ENUMERATION.WINDOW_START_ISO}, ${INTEGRATION_ENUMERATION.WINDOW_END_ISO}) AS t`
    );

    // Tenant A has two unbilled rows in the window. Without `DISTINCT` the job would call
    // billing twice for it -- harmless, because the endpoint is idempotent, but it is the
    // resolver's job not to hand the loop duplicates.
    expect(rows.filter((row) => row.tenantId === tenantAId)).toHaveLength(
      INTEGRATION_COUNTS.SINGLE
    );
  });

  it("R4 - returns an empty set for a window with no unbilled usage, rather than an error", async () => {
    const tenants = await enumerate(
      worker,
      INTEGRATION_ENUMERATION.EMPTY_WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.EMPTY_WINDOW_END_ISO
    );

    expect(tenants).toEqual([]);
  });

  it("R5 - returns tenant ids only: SETOF text, two text parameters, SECURITY DEFINER, owned by the definer role", async () => {
    const [row] = await worker.$queryRaw<FunctionCatalogRow[]>`
      SELECT pg_get_function_result(p.oid) AS result_type,
             pg_get_function_arguments(p.oid) AS arguments,
             p.pronargs::int AS argument_count,
             p.prosecdef AS is_security_definer,
             r.rolname AS owner
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname || '.' || p.proname = ${WORKER_DATABASE.UNBILLED_TENANTS_FN}
    `;

    expect(row, `${WORKER_DATABASE.UNBILLED_TENANTS_FN} does not exist`).toBeDefined();
    // The narrowness of the exception, asserted so that widening it goes red. A resolver that
    // returned quantities, `UsageLine` ids or periods would be a different exception from the
    // one that was reviewed.
    expect(row?.result_type).toBe(INTEGRATION_ENUMERATION_CATALOG.EXPECTED_RESULT_TYPE);
    expect(row?.argument_count).toBe(INTEGRATION_ENUMERATION_CATALOG.EXPECTED_ARGUMENT_COUNT);
    // `text`, not `timestamp(3)`. Declaring the parameters as timestamps does not protect the
    // window: the coercion happens in the *caller's* session before the body runs, so a bound
    // `Date` silently slides the day boundary by the session offset. This is the catalog-level
    // guard for that; `I-TZ1` is the behavioural one.
    expect(row?.arguments).toBe(INTEGRATION_ENUMERATION_CATALOG.EXPECTED_ARGUMENTS);
    expect(row?.is_security_definer).toBe(true);
    expect(row?.owner).toBe(WORKER_DATABASE.DEFINER_ROLE);
  });

  it("R6/R7 - EXECUTE is held by the worker role alone: not PUBLIC, not the shared role", async () => {
    const [row] = await worker.$queryRaw<ExecutePrivilegeRow[]>`
      SELECT has_function_privilege(${INTEGRATION_ENUMERATION_CATALOG.PUBLIC_ROLE}, p.oid, ${INTEGRATION_ENUMERATION_CATALOG.EXECUTE_PRIVILEGE}) AS public_can_execute,
             has_function_privilege(${WORKER_DATABASE.SHARED_APP_ROLE}, p.oid, ${INTEGRATION_ENUMERATION_CATALOG.EXECUTE_PRIVILEGE}) AS shared_can_execute,
             has_function_privilege(${WORKER_DATABASE.WORKER_APP_ROLE}, p.oid, ${INTEGRATION_ENUMERATION_CATALOG.EXECUTE_PRIVILEGE}) AS worker_can_execute
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname || '.' || p.proname = ${WORKER_DATABASE.UNBILLED_TENANTS_FN}
    `;

    expect(row, `${WORKER_DATABASE.UNBILLED_TENANTS_FN} does not exist`).toBeDefined();
    // PostgreSQL grants EXECUTE on every new function to PUBLIC and every application role is
    // in PUBLIC (S-11).
    expect(row?.public_can_execute).toBe(false);
    // The reason this task created a fourth role rather than granting the resolver to the
    // existing one: `telemetry_app` is shared by gateway, usage, billing and analytics, and
    // this function reads past the `"UsageLine"` tenant policy.
    expect(row?.shared_can_execute).toBe(false);
    expect(row?.worker_can_execute).toBe(true);
  });

  it("R8 - neither application role is a member of the definer role", async () => {
    const [row] = await worker.$queryRaw<MembershipRow[]>`
      SELECT pg_has_role(${WORKER_DATABASE.SHARED_APP_ROLE}, ${WORKER_DATABASE.DEFINER_ROLE}, ${INTEGRATION_ENUMERATION_CATALOG.MEMBERSHIP_PRIVILEGE}) AS shared_is_member,
             pg_has_role(${WORKER_DATABASE.WORKER_APP_ROLE}, ${WORKER_DATABASE.DEFINER_ROLE}, ${INTEGRATION_ENUMERATION_CATALOG.MEMBERSHIP_PRIVILEGE}) AS worker_is_member
    `;

    // Membership is the escalation path, and it is asserted *directly* because for the role
    // that holds EXECUTE legitimately the privilege checks above cannot notice. The definer's
    // policy is `USING (true)`, and a policy applies through role membership -- so a member
    // reads every tenant's `"UsageLine"` rows with no tenant context and no resolver call.
    expect(row?.shared_is_member).toBe(false);
    expect(row?.worker_is_member).toBe(false);
  });

  it("R9 - the worker role holds no table or column privilege outside the two tables it writes", async () => {
    // Read from `pg_class`/`pg_attribute`, not `information_schema.role_table_grants`: that view
    // shows only rows whose grantor or grantee is a currently enabled role, so under a
    // non-superuser it can return nothing and pass vacuously (`v1_5` records the same).
    const tables = await worker.$queryRaw<GrantedRelationRow[]>`
      SELECT DISTINCT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND a.grantee = ${WORKER_DATABASE.WORKER_APP_ROLE}::regrole
      ORDER BY c.relname
    `;
    const columns = await worker.$queryRaw<GrantedRelationRow[]>`
      SELECT DISTINCT c.relname
      FROM pg_attribute att
      JOIN pg_class c ON c.oid = att.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(att.attacl) a
      WHERE n.nspname = 'public'
        AND a.grantee = ${WORKER_DATABASE.WORKER_APP_ROLE}::regrole
      ORDER BY c.relname
    `;

    // No blanket `ALTER DEFAULT PRIVILEGES ... GRANT`, so a future table has to be granted
    // deliberately. `.claude/rules/tenant-isolation.md` records what copying `telemetry_app`'s
    // blanket grant cost the equivalent auth role: `"InvoiceLineItem"`, where RLS is inert.
    expect(tables.map((row) => row.relname)).toEqual([...WORKER_DATABASE.GRANTED_TABLES]);
    expect(columns).toEqual([]);
  });

  it("R10 - the definer's read policy on \"UsageLine\" is SELECT-only and scoped to the definer role", async () => {
    const [row] = await worker.$queryRaw<PolicyRow[]>`
      SELECT policyname, cmd, roles
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'UsageLine'
        AND policyname = ${WORKER_DATABASE.DEFINER_USAGE_LINE_READ_POLICY}
    `;

    expect(
      row,
      `${WORKER_DATABASE.DEFINER_USAGE_LINE_READ_POLICY} is missing; without it the resolver returns no rows, silently`
    ).toBeDefined();
    expect(row?.cmd).toBe(INTEGRATION_ENUMERATION_CATALOG.SELECT_COMMAND);
    expect(row?.roles).toEqual([WORKER_DATABASE.DEFINER_ROLE]);
  });

  it("I-E1 - as the worker role, a direct read of \"UsageLine\" with no tenant context returns nothing", async () => {
    // **The negative that carries the most weight.** The whole claim of decision A2 is that the
    // cross-tenant read is bounded by mechanism rather than by nobody misusing it: the definer's
    // `USING (true)` policy is scoped `TO telemetry_worker_definer` and this role is not a
    // member of it (R8), so the resolver's `SETOF text` is the only cross-tenant read it has
    // **in a single statement with no tenant context set**. That qualifier is the whole claim,
    // and it is what this case measures.
    //
    // It is *not* "no cross-tenant read". Measured at the Gate-3 rework, as this same role:
    // enumerate the ids through the resolver, then `set_config('app.tenant_id', <an id>, true)`
    // and the role reads that tenant's `"UsageLine"` and `"Event"` rows and `UPDATE`s them
    // (`UPDATE 1`). That capability is **unchanged from `telemetry_app`**, which returned the
    // same rows and the same `UPDATE 1` given the same id and got `permission denied for
    // function` on the resolver. What A2 bought is that the ids no longer have to be known --
    // see the "What this exception widens" section of
    // `src/repositories/billing-enumeration.repository.ts`.
    //
    // This runs on the plain connection with no `set_config`, so `app.tenant_id` is unset and
    // `"tenantId" = current_setting(...)` is NULL -- not true -- for every row.
    const rows = await worker.$queryRaw<TenantIdRow[]>`
      SELECT "tenantId" FROM "UsageLine"
    `;

    expect(rows).toEqual([]);
  });

  it("I-E2 - the same read *with* tenant context returns that tenant's rows, so I-E1's zero is RLS and not an empty table", async () => {
    // Without this, `I-E1` is satisfied by a missing grant, an empty table or a failed seed just
    // as well as by the policy. This is what makes it a measurement.
    const rows = await worker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config(${WORKER_DATABASE.TENANT_CONTEXT_SETTING}, ${tenantAId}, true)`;

      return tx.$queryRaw<TenantIdRow[]>`SELECT "tenantId" FROM "UsageLine"`;
    });

    expect(rows).toHaveLength(INTEGRATION_COUNTS.PAIR);
    expect(rows.every((row) => row.tenantId === tenantAId)).toBe(true);
  });

  it("R11 - the repository returns the same tenants against a live database as the raw call", async () => {
    // The repository is unit-tested against a double for the *shape* of its statement (E1-E4).
    // This is the other half: the real class, the real connection, the real role. Without it
    // nothing proves that the frozen `Prisma.raw` fragment and the two bound parameters compose
    // into a statement PostgreSQL accepts -- a double records whatever it is handed.
    const repository = new BillingEnumerationRepository(worker);

    const tenants = await repository.listTenantsWithUnbilledUsage(
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );

    expect([...tenants].sort()).toEqual(EXPECTED_TENANTS);
  });

  it("R12 - the repository returns an empty list for a window with no unbilled usage", async () => {
    const repository = new BillingEnumerationRepository(worker);

    await expect(
      repository.listTenantsWithUnbilledUsage(
        INTEGRATION_ENUMERATION.EMPTY_WINDOW_START_ISO,
        INTEGRATION_ENUMERATION.EMPTY_WINDOW_END_ISO
      )
    ).resolves.toEqual([]);
  });

  it("I-TZ1 - the same window resolves to the same tenants under UTC and under a non-UTC session", async () => {
    // **Both arms are pinned.** A case that pinned one connection and left the other on the
    // server's default asserts a different property on every host, and on a UTC server -- which
    // is what CI runs -- asserts nothing at all. See
    // `INTEGRATION_ENUMERATION_SESSION_TIME_ZONE`'s docblock for the mutation that established
    // this, and S-21 for the entry about a regression suite that stayed green with its own fix
    // reverted.
    //
    // Each pin is asserted rather than hoped for: `CLAUDE.md` records that a bare `?timezone=`
    // in the DSN is accepted and **silently ignored**, which would leave both arms on the same
    // session and make the comparison vacuous.
    const [utcZone] = await pinnedUtc.$queryRaw<TimeZoneRow[]>(
      Prisma.raw(INTEGRATION_ENUMERATION_SESSION_TIME_ZONE.SHOW_TIMEZONE)
    );
    const [nonUtcZone] = await pinnedNonUtc.$queryRaw<TimeZoneRow[]>(
      Prisma.raw(INTEGRATION_ENUMERATION_SESSION_TIME_ZONE.SHOW_TIMEZONE)
    );
    expect(utcZone?.TimeZone).toBe(INTEGRATION_ENUMERATION_SESSION_TIME_ZONE.UTC);
    expect(nonUtcZone?.TimeZone).toBe(INTEGRATION_ENUMERATION_SESSION_TIME_ZONE.NON_UTC);
    expect(utcZone?.TimeZone).not.toBe(nonUtcZone?.TimeZone);

    const underUtc = await enumerate(
      pinnedUtc,
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );
    const underNonUtc = await enumerate(
      pinnedNonUtc,
      INTEGRATION_ENUMERATION.WINDOW_START_ISO,
      INTEGRATION_ENUMERATION.WINDOW_END_ISO
    );

    expect(underNonUtc).toEqual(underUtc);
    // Also pinned against the literal expected set, not only against the other connection: two
    // sessions that shifted by the same offset would still satisfy the equality above.
    expect(underUtc).toEqual(EXPECTED_TENANTS);
  });
});
