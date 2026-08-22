import * as PrismaClientModule from "@prisma/client";

type PrismaClientCtor = new (options?: { log?: ("error" | "warn")[] }) => {
  $disconnect: () => Promise<void>;
};

const { PrismaClient } = PrismaClientModule as unknown as {
  PrismaClient: PrismaClientCtor;
};

const globalForPrisma = globalThis as { prisma?: InstanceType<PrismaClientCtor> };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({
    log: ["error", "warn"]
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
