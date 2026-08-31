import { createHash } from "node:crypto";
import { PrismaClient, Plan, Role } from "@prisma/client";

// Seeding creates tenants before any tenant context exists, so it must run through the
// admin/owner connection -- the runtime role (telemetry_app) is blocked by the RLS
// WITH CHECK on "Tenant". See .claude/rules/tenant-isolation.md.
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });

const DEV_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const DEV_OWNER_ID = "22222222-2222-2222-2222-222222222222";
const DEFAULT_METRICS = ["api.request", "storage.write", "storage.read"] as const;

const hashPassword = (value: string): string => {
  return createHash("sha256").update(value).digest("hex");
};

const seed = async (): Promise<void> => {
  await prisma.tenant.upsert({
    where: { id: DEV_TENANT_ID },
    update: {
      name: "Acme Corp",
      plan: Plan.PRO,
      timezone: "UTC",
      deletedAt: null
    },
    create: {
      id: DEV_TENANT_ID,
      name: "Acme Corp",
      plan: Plan.PRO,
      timezone: "UTC"
    }
  });

  await prisma.user.upsert({
    where: {
      tenantId_email: {
        tenantId: DEV_TENANT_ID,
        email: "admin@acme.local"
      }
    },
    update: {
      passwordHash: hashPassword("password123"),
      role: Role.OWNER
    },
    create: {
      id: DEV_OWNER_ID,
      tenantId: DEV_TENANT_ID,
      email: "admin@acme.local",
      passwordHash: hashPassword("password123"),
      role: Role.OWNER
    }
  });

  const activeFrom = new Date("2026-01-01T00:00:00.000Z");

  for (const metricKey of DEFAULT_METRICS) {
    await prisma.meter.upsert({
      where: {
        tenantId_metricKey_activeFrom: {
          tenantId: DEV_TENANT_ID,
          metricKey,
          activeFrom
        }
      },
      update: {
        unitPrice: "0.010000",
        currency: "USD",
        activeTo: null
      },
      create: {
        tenantId: DEV_TENANT_ID,
        metricKey,
        unitPrice: "0.010000",
        currency: "USD",
        activeFrom
      }
    });
  }
};

seed()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
