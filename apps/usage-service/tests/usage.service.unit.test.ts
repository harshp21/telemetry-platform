import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { UsageService } from "../src/services/usage.service";
import type { UsageRepository } from "../src/repositories/usage.repository";
import type { UsageSummaryQuery } from "../src/validators/usage-summary.validator";
import { USAGE_SUMMARY_CONSTANTS, USAGE_SUMMARY_GRANULARITY } from "../src/constants";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

const query: UsageSummaryQuery = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-08T00:00:00.000Z",
  granularity: USAGE_SUMMARY_GRANULARITY.DAY,
  page: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE,
  pageSize: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE_SIZE
};

describe("UsageService.getUsageSummary", () => {
  let aggregateSummary: ReturnType<typeof vi.fn>;
  let createRepository: ReturnType<typeof vi.fn>;
  let logger: Partial<Record<keyof Logger, ReturnType<typeof vi.fn>>>;
  let service: UsageService;

  beforeEach(() => {
    aggregateSummary = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    createRepository = vi.fn(
      () => ({ aggregateSummary }) as unknown as UsageRepository
    );
    logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    service = new UsageService(
      createRepository as unknown as (tenantId: string) => UsageRepository,
      logger as unknown as Logger
    );
  });

  it("creates a repository scoped to the requesting tenant", async () => {
    await service.getUsageSummary(TENANT_ID, query);

    expect(createRepository).toHaveBeenCalledTimes(1);
    expect(createRepository).toHaveBeenCalledWith(TENANT_ID);
  });

  it("passes the validated query through to the repository", async () => {
    await service.getUsageSummary(TENANT_ID, { ...query, page: 2, pageSize: 50 });

    expect(aggregateSummary).toHaveBeenCalledWith({
      from: query.from,
      to: query.to,
      granularity: USAGE_SUMMARY_GRANULARITY.DAY,
      metricKey: undefined,
      page: 2,
      pageSize: 50
    });
  });

  it("passes the optional metricKey filter through to the repository", async () => {
    await service.getUsageSummary(TENANT_ID, { ...query, metricKey: "api.request" });

    expect(aggregateSummary).toHaveBeenCalledWith(
      expect.objectContaining({ metricKey: "api.request" })
    );
  });

  it("returns a PaginatedResult with items, total, page and pageSize", async () => {
    aggregateSummary.mockResolvedValueOnce({
      rows: [
        {
          metricKey: "api.request",
          bucketStart: "2026-01-01T00:00:00.000Z",
          bucketEnd: "2026-01-02T00:00:00.000Z",
          totalQuantity: "10.5"
        }
      ],
      total: 1
    });

    const result = await service.getUsageSummary(TENANT_ID, query);

    expect(result).toEqual({
      items: [
        {
          metricKey: "api.request",
          bucketStart: "2026-01-01T00:00:00.000Z",
          bucketEnd: "2026-01-02T00:00:00.000Z",
          totalQuantity: "10.5"
        }
      ],
      total: 1,
      page: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE,
      pageSize: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE_SIZE
    });
  });

  it("echoes the requested page and pageSize in the result", async () => {
    aggregateSummary.mockResolvedValueOnce({ rows: [], total: 120 });

    const result = await service.getUsageSummary(TENANT_ID, {
      ...query,
      page: 4,
      pageSize: 100
    });

    expect(result.page).toBe(4);
    expect(result.pageSize).toBe(100);
    expect(result.total).toBe(120);
  });

  it("returns items: [] and total: 0 for an empty range", async () => {
    aggregateSummary.mockResolvedValueOnce({ rows: [], total: 0 });

    const result = await service.getUsageSummary(TENANT_ID, query);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("keeps totalQuantity as a string in the returned items", async () => {
    aggregateSummary.mockResolvedValueOnce({
      rows: [
        {
          metricKey: "api.request",
          bucketStart: "2026-01-01T00:00:00.000Z",
          bucketEnd: "2026-01-02T00:00:00.000Z",
          totalQuantity: "12.5"
        }
      ],
      total: 1
    });

    const result = await service.getUsageSummary(TENANT_ID, query);

    expect(typeof result.items[0]?.totalQuantity).toBe("string");
  });

  it("propagates repository errors to the caller", async () => {
    aggregateSummary.mockRejectedValueOnce(new Error("aggregate failed"));

    await expect(service.getUsageSummary(TENANT_ID, query)).rejects.toThrow("aggregate failed");
  });
});
