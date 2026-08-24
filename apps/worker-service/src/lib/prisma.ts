import * as PrismaClientModule from "@prisma/client";

type PrismaClientCtor = new (config?: any) => {
  $disconnect: () => Promise<void>;
};

type PrismaModuleShape = {
  PrismaClient?: PrismaClientCtor;
};

const prismaClientExport = (PrismaClientModule as PrismaModuleShape).PrismaClient;

if (!prismaClientExport) {
  throw new Error("PrismaClient export is unavailable. Run Prisma generate before startup.");
}

const PrismaClient = prismaClientExport;

const globalForPrisma = globalThis as { prisma?: InstanceType<PrismaClientCtor> };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ["error", "warn"] });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
