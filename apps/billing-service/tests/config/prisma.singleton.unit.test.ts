import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type GlobalWithPrisma = typeof globalThis & { prisma?: unknown };

describe("Prisma singleton (billing-service)", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (globalThis as GlobalWithPrisma).prisma;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    delete (globalThis as GlobalWithPrisma).prisma;
    vi.doUnmock("@prisma/client");
    vi.resetModules();
  });

  it("creates PrismaClient with production-safe log levels", async () => {
    process.env.NODE_ENV = "test";
    const prismaInstance = { tag: "new-prisma" };
    const PrismaClientMock = vi.fn(() => prismaInstance);

    vi.doMock("@prisma/client", () => ({
      PrismaClient: PrismaClientMock
    }));

    const moduleUnderTest = await import("../../src/lib/prisma");

    expect(PrismaClientMock).toHaveBeenCalledTimes(1);
    expect(PrismaClientMock).toHaveBeenCalledWith({ log: ["error", "warn"] });
    expect(moduleUnderTest.prisma).toBe(prismaInstance);
  });

  it("reuses pre-seeded global singleton", async () => {
    process.env.NODE_ENV = "test";
    const seededInstance = { tag: "seeded-prisma" };
    const PrismaClientMock = vi.fn(() => ({ tag: "unused-new-instance" }));
    (globalThis as GlobalWithPrisma).prisma = seededInstance;

    vi.doMock("@prisma/client", () => ({
      PrismaClient: PrismaClientMock
    }));

    const moduleUnderTest = await import("../../src/lib/prisma");

    expect(PrismaClientMock).not.toHaveBeenCalled();
    expect(moduleUnderTest.prisma).toBe(seededInstance);
  });

  it("caches singleton on globalThis in non-production", async () => {
    process.env.NODE_ENV = "development";
    const prismaInstance = { tag: "dev-prisma" };
    const PrismaClientMock = vi.fn(() => prismaInstance);

    vi.doMock("@prisma/client", () => ({
      PrismaClient: PrismaClientMock
    }));

    const moduleUnderTest = await import("../../src/lib/prisma");

    expect(moduleUnderTest.prisma).toBe(prismaInstance);
    expect((globalThis as GlobalWithPrisma).prisma).toBe(prismaInstance);
  });

  it("does not cache singleton on globalThis in production", async () => {
    process.env.NODE_ENV = "production";
    const prismaInstance = { tag: "prod-prisma" };
    const PrismaClientMock = vi.fn(() => prismaInstance);

    vi.doMock("@prisma/client", () => ({
      PrismaClient: PrismaClientMock
    }));

    const moduleUnderTest = await import("../../src/lib/prisma");

    expect(moduleUnderTest.prisma).toBe(prismaInstance);
    expect((globalThis as GlobalWithPrisma).prisma).toBeUndefined();
  });
});