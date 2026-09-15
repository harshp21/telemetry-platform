import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { TenantId } from "@telemetry/shared-types";
import { MeterRepository } from "../src/repositories/meter.repository";

const TENANT_ID = "11111111-1111-4111-8111-111111111111" as TenantId;
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";

const AS_OF = new Date("2026-01-01T00:00:00.000Z");
const METRIC_API = "api.request";
const METRIC_STORAGE = "storage.gb";
const CURRENCY_USD = "USD";

/**
 * The PostgreSQL session setting `withTenant` writes, spelled out rather than imported.
 *
 * It is a literal in `src/repositories/base.repository.ts` too -- S-19 counts six executable
 * copies of this string across the five `TenantScopedRepository` implementations and asks for a
 * shared constant. Promoting it is S-19's own task, across all five services; deriving this
 * expectation from the production side in the meantime would make the assertion move with the
 * code and stop testing the wire format it exists to pin.
 */
const TENANT_SETTING_NAME = "app.tenant_id";
/** `is_local = true` -- the setting must not outlive the transaction on a pooled connection. */
const TRANSACTION_LOCAL_ARGUMENT = ", true)";

const testLogger = () => ({ error: vi.fn(), debug: vi.fn() });

interface MeterRow {
  metricKey: string;
  unitPrice: Prisma.Decimal;
  currency: string;
}

const meterRow = (metricKey: string, unitPrice: string, currency = CURRENCY_USD): MeterRow => ({
  metricKey,
  unitPrice: new Prisma.Decimal(unitPrice),
  currency
});

/**
 * Prisma double whose `$transaction` runs the callback immediately with a transaction client.
 *
 * `$queryRaw` answers `withTenant`'s `set_config` statement; `meter.findMany` serves the rows
 * under test and records the argument tree the repository built.
 */
const createPrismaMock = (rows: MeterRow[]) => {
  const queryRaw = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
  const findMany = vi.fn(async (..._args: unknown[]) => rows);
  const tx = { $queryRaw: queryRaw, meter: { findMany } };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx))
  } as unknown as PrismaClient;

  return { prisma, queryRaw, findMany, transaction: prisma.$transaction as ReturnType<typeof vi.fn> };
};

/** Throws rather than passing vacuously when the repository issued no query at all. */
const findManyArgs = (findMany: ReturnType<typeof vi.fn>): Record<string, unknown> => {
  const call = findMany.mock.calls[0];
  if (!call) {
    throw new Error("Expected meter.findMany to have been called");
  }
  return call[0] as Record<string, unknown>;
};

const buildRepository = (rows: MeterRow[]) => {
  const mock = createPrismaMock(rows);
  const repository = new MeterRepository(mock.prisma, TENANT_ID, testLogger());
  return { ...mock, repository };
};

describe("MeterRepository.findActiveAsOf", () => {
  it("BU9 - normalises unitPrice to a string and never returns a Prisma.Decimal", async () => {
    const { repository } = buildRepository([meterRow(METRIC_API, "0.010000")]);

    const meters = await repository.findActiveAsOf([METRIC_API], AS_OF);

    expect(meters).toEqual([
      { metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_USD }
    ]);
    expect(meters[0]?.unitPrice).not.toBeInstanceOf(Prisma.Decimal);
    expect(typeof meters[0]?.unitPrice).toBe("string");
  });

  it("BU10 - reads inside withTenant, setting the transaction-local tenant context first", async () => {
    const { repository, transaction, queryRaw } = buildRepository([meterRow(METRIC_API, "1.000000")]);

    await repository.findActiveAsOf([METRIC_API], AS_OF);

    expect(transaction).toHaveBeenCalledTimes(1);
    const setConfig = queryRaw.mock.calls[0];
    if (!setConfig) {
      throw new Error("Expected withTenant to issue a set_config statement");
    }
    expect(String(setConfig[0])).toContain(TENANT_SETTING_NAME);
    expect(String(setConfig[0])).toContain(TRANSACTION_LOCAL_ARGUMENT);
    expect(setConfig).toContain(TENANT_ID);
  });

  it("BU11 - the where object carries the bound tenant id", async () => {
    const { repository, findMany } = buildRepository([meterRow(METRIC_API, "1.000000")]);

    await repository.findActiveAsOf([METRIC_API], AS_OF);

    expect(findManyArgs(findMany).where).toMatchObject({ tenantId: TENANT_ID });
  });

  it("BU12 - no tenant id other than the bound one appears anywhere in the query", async () => {
    const { repository, findMany } = buildRepository([meterRow(METRIC_API, "1.000000")]);

    await repository.findActiveAsOf([METRIC_API], AS_OF);

    const serialized = JSON.stringify(findManyArgs(findMany));
    expect(serialized).toContain(TENANT_ID);
    expect(serialized).not.toContain(OTHER_TENANT_ID);
  });

  it("BU13 - selects meters in force at asOf: activeFrom on or before, activeTo open or later", async () => {
    const { repository, findMany } = buildRepository([meterRow(METRIC_API, "1.000000")]);

    await repository.findActiveAsOf([METRIC_API, METRIC_STORAGE], AS_OF);

    expect(findManyArgs(findMany).where).toMatchObject({
      metricKey: { in: [METRIC_API, METRIC_STORAGE] },
      activeFrom: { lte: AS_OF },
      OR: [{ activeTo: null }, { activeTo: { gt: AS_OF } }]
    });
  });

  it("BU14 - the most recent activeFrom wins when a key has several in-force meters", async () => {
    // The repository orders by activeFrom descending, so the first row per key is the newest
    // rate card. Two rows for one key is the rate-change case, not a data defect.
    const { repository, findMany } = buildRepository([
      meterRow(METRIC_API, "0.020000"),
      meterRow(METRIC_API, "0.010000")
    ]);

    const meters = await repository.findActiveAsOf([METRIC_API], AS_OF);

    expect(findManyArgs(findMany).orderBy).toEqual({ activeFrom: "desc" });
    expect(meters).toEqual([{ metricKey: METRIC_API, unitPrice: "0.02", currency: CURRENCY_USD }]);
  });

  it("BU15 - returns one entry per matched key and an empty list when nothing is in force", async () => {
    const matched = buildRepository([
      meterRow(METRIC_API, "0.010000"),
      meterRow(METRIC_STORAGE, "0.500000", "EUR")
    ]);
    const unmatched = buildRepository([]);

    await expect(
      matched.repository.findActiveAsOf([METRIC_API, METRIC_STORAGE], AS_OF)
    ).resolves.toEqual([
      { metricKey: METRIC_API, unitPrice: "0.01", currency: CURRENCY_USD },
      { metricKey: METRIC_STORAGE, unitPrice: "0.5", currency: "EUR" }
    ]);
    await expect(unmatched.repository.findActiveAsOf([METRIC_API], AS_OF)).resolves.toEqual([]);
  });
});
