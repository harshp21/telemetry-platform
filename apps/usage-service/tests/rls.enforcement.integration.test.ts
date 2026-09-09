import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { DATABASE_SESSION_SETTINGS } from "../src/constants";

/**
 * Proves that PostgreSQL Row-Level Security is *actually enforcing* — the acceptance
 * criterion for S-2 (`.claude/rules/known-gaps.md`).
 *
 * Every assertion below runs a raw `SELECT ... FROM "UsageLine"` with **no application
 * `WHERE tenantId` predicate**, so the only thing that can restrict the result set is the
 * database. If the connection role were a superuser or held BYPASSRLS — the S-2 state —
 * these queries would return every tenant's rows and the suite would fail.
 *
 * Deliberately does NOT skip when the environment is wrong (that is the S-3 anti-pattern:
 * a guard that fires precisely when the bug is present). If the runtime role is not
 * NOSUPERUSER/NOBYPASSRLS, the suite fails loudly.
 *
 * Requires a live Postgres with migrations applied:
 *   DATABASE_URL        -> telemetry_app (runtime, least privilege) — the role under test
 *   DIRECT_DATABASE_URL -> admin/owner   (migrations)               — seeds the fixtures,
 *                          because seeding is itself subject to RLS as the app role
 */

const SEEDED_QUANTITY_A = "11.500000";
const SEEDED_QUANTITY_B = "22.500000";
const ADMIN_URL_FALLBACK = "postgresql://postgres:postgres@localhost:5432/telemetry";

interface RoleAttributes {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
}

interface UsageLineRow {
  readonly id: string;
  readonly tenantId: string;
  readonly quantity: unknown;
}

const requireEnv = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;

  if (!value) {
    throw new Error(`${name} must be set for the RLS enforcement integration test`);
  }

  return value;
};

describe("PostgreSQL RLS enforcement on UsageLine (integration)", () => {
  const suiteId = randomUUID();
  const tenantAId = `rls-a-${suiteId}`;
  const tenantBId = `rls-b-${suiteId}`;
  const eventAId = `rls-ev-a-${suiteId}`;
  const eventBId = `rls-ev-b-${suiteId}`;
  // "UsageLine"."eventId" is UNIQUE, so the cross-tenant INSERT probe needs its own event;
  // otherwise a unique-constraint violation would masquerade as an RLS rejection.
  const eventBSpareId = `rls-ev-b-spare-${suiteId}`;
  const usageLineAId = `rls-ul-a-${suiteId}`;
  const usageLineBId = `rls-ul-b-${suiteId}`;

  let admin: PrismaClient;
  let app: PrismaClient;
  let appRole: RoleAttributes | undefined;

  beforeAll(async () => {
    admin = new PrismaClient({
      datasourceUrl: requireEnv("DIRECT_DATABASE_URL", ADMIN_URL_FALLBACK)
    });
    app = new PrismaClient({ datasourceUrl: requireEnv("DATABASE_URL") });

    const roles = await app.$queryRaw<RoleAttributes[]>`
			SELECT r.rolname, r.rolsuper, r.rolbypassrls
			FROM pg_roles r
			WHERE r.rolname = current_user
		`;
    appRole = roles[0];

    const now = new Date();

    await admin.tenant.createMany({
      data: [
        { id: tenantAId, name: "RLS Probe A" },
        { id: tenantBId, name: "RLS Probe B" }
      ]
    });
    await admin.event.createMany({
      data: [
        {
          id: eventAId,
          tenantId: tenantAId,
          idempotencyKey: `rls-key-a-${suiteId}`,
          eventType: "api.request",
          quantity: SEEDED_QUANTITY_A,
          unit: "request",
          occurredAt: now
        },
        {
          id: eventBId,
          tenantId: tenantBId,
          idempotencyKey: `rls-key-b-${suiteId}`,
          eventType: "api.request",
          quantity: SEEDED_QUANTITY_B,
          unit: "request",
          occurredAt: now
        },
        {
          id: eventBSpareId,
          tenantId: tenantBId,
          idempotencyKey: `rls-key-b-spare-${suiteId}`,
          eventType: "api.request",
          quantity: SEEDED_QUANTITY_B,
          unit: "request",
          occurredAt: now
        }
      ]
    });
    await admin.usageLine.createMany({
      data: [
        {
          id: usageLineAId,
          tenantId: tenantAId,
          eventId: eventAId,
          metricKey: "api.calls",
          quantity: SEEDED_QUANTITY_A,
          periodStart: now,
          periodEnd: now
        },
        {
          id: usageLineBId,
          tenantId: tenantBId,
          eventId: eventBId,
          metricKey: "api.calls",
          quantity: SEEDED_QUANTITY_B,
          periodStart: now,
          periodEnd: now
        }
      ]
    });
  });

  afterAll(async () => {
    if (admin) {
      await admin.usageLine.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
      await admin.event.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
      await admin.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
      await admin.$disconnect();
    }

    if (app) {
      await app.$disconnect();
    }
  });

  it("connects at runtime as a NOSUPERUSER, NOBYPASSRLS role", () => {
    expect(appRole, "DATABASE_URL did not resolve to a known role").toBeDefined();
    expect(appRole?.rolsuper, `role ${appRole?.rolname} is a superuser; RLS cannot enforce`).toBe(
      false
    );
    expect(
      appRole?.rolbypassrls,
      `role ${appRole?.rolname} holds BYPASSRLS; RLS cannot enforce`
    ).toBe(false);
  });

  it("seeded both tenants' rows through the admin role (fixture is not vacuous)", async () => {
    const rows = await admin.$queryRaw<UsageLineRow[]>`
			SELECT "id", "tenantId", "quantity" FROM "UsageLine"
			WHERE "tenantId" IN (${tenantAId}, ${tenantBId})
		`;

    expect(rows.map((row) => row.id).sort()).toEqual([usageLineAId, usageLineBId].sort());
  });

  it("returns zero rows for an unscoped SELECT with no tenant context", async () => {
    const rows = await app.$queryRaw<UsageLineRow[]>`SELECT * FROM "UsageLine"`;

    expect(rows).toHaveLength(0);
  });

  it("returns only tenant A's rows when app.tenant_id is tenant A", async () => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config(${DATABASE_SESSION_SETTINGS.TENANT_ID}, ${tenantAId}, true)`;
      return tx.$queryRaw<UsageLineRow[]>`SELECT * FROM "UsageLine"`;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(usageLineAId);
    expect(rows[0]?.tenantId).toBe(tenantAId);
  });

  it("returns only tenant B's rows when app.tenant_id is tenant B", async () => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config(${DATABASE_SESSION_SETTINGS.TENANT_ID}, ${tenantBId}, true)`;
      return tx.$queryRaw<UsageLineRow[]>`SELECT * FROM "UsageLine"`;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(usageLineBId);
    expect(rows[0]?.tenantId).toBe(tenantBId);
  });

  it("cannot write a row belonging to another tenant", async () => {
    await expect(
      app.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config(${DATABASE_SESSION_SETTINGS.TENANT_ID}, ${tenantAId}, true)`;
        return tx.$executeRaw`
					INSERT INTO "UsageLine"
						("id", "tenantId", "eventId", "metricKey", "quantity", "periodStart", "periodEnd")
					VALUES
						(${`rls-ul-evil-${suiteId}`}, ${tenantBId}, ${eventBSpareId}, 'api.calls', 1, NOW(), NOW())
				`;
      })
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot update another tenant's row even with an explicit id predicate", async () => {
    const affected = await app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config(${DATABASE_SESSION_SETTINGS.TENANT_ID}, ${tenantAId}, true)`;
      return tx.$executeRaw`UPDATE "UsageLine" SET "billed" = true WHERE "id" = ${usageLineBId}`;
    });

    expect(affected).toBe(0);
  });
});
