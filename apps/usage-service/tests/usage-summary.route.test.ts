import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUsageServiceApp } from "../src/app";
import {
  USAGE_SERVICE_HEADERS,
  USAGE_SERVICE_RESPONSES,
  USAGE_SERVICE_ROUTES,
  USAGE_SUMMARY_CONSTANTS,
  USAGE_SUMMARY_GRANULARITY
} from "../src/constants";

const TENANT_ID_A = "11111111-1111-4111-8111-111111111111";
const TENANT_ID_B = "22222222-2222-4222-8222-222222222222";

const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-01-08T00:00:00.000Z";

const summaryUrl = (params: Record<string, string> = {}): string => {
  const search = new URLSearchParams({
    from: FROM,
    to: TO,
    granularity: USAGE_SUMMARY_GRANULARITY.DAY,
    ...params
  });
  return `${USAGE_SERVICE_ROUTES.USAGE_SUMMARY}?${search.toString()}`;
};

const emptyPage = {
  items: [],
  total: 0,
  page: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE,
  pageSize: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE_SIZE
};

describe(`GET ${USAGE_SERVICE_ROUTES.USAGE_SUMMARY}`, () => {
  let app: ReturnType<typeof buildUsageServiceApp>;

  beforeEach(() => {
    app = buildUsageServiceApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 with the data wrapper and pagination metadata", async () => {
    const page = {
      items: [
        {
          metricKey: "api.request",
          bucketStart: "2026-01-01T00:00:00.000Z",
          bucketEnd: "2026-01-02T00:00:00.000Z",
          totalQuantity: "10.5"
        }
      ],
      total: 1,
      page: 1,
      pageSize: 20
    };
    vi.spyOn(app.container.usageService, "getUsageSummary").mockResolvedValueOnce(page);

    const response = await app.inject({
      method: "GET",
      url: summaryUrl(),
      headers: { [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_A }
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toEqual({ data: page });
  });

  it("uses page=1 and pageSize=20 when pagination params are omitted", async () => {
    const spy = vi
      .spyOn(app.container.usageService, "getUsageSummary")
      .mockResolvedValueOnce(emptyPage);

    const response = await app.inject({
      method: "GET",
      url: summaryUrl(),
      headers: { [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_A }
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_OK);
    expect(spy).toHaveBeenCalledWith(
      TENANT_ID_A,
      expect.objectContaining({
        page: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE,
        pageSize: USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE_SIZE
      })
    );
  });

  it("rejects pageSize greater than 100 with a validation error", async () => {
    const spy = vi
      .spyOn(app.container.usageService, "getUsageSummary")
      .mockResolvedValue(emptyPage);

    const response = await app.inject({
      method: "GET",
      url: summaryUrl({ pageSize: String(USAGE_SUMMARY_CONSTANTS.MAX_PAGE_SIZE + 1) }),
      headers: { [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_A }
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an unsupported granularity with a validation error", async () => {
    const spy = vi
      .spyOn(app.container.usageService, "getUsageSummary")
      .mockResolvedValue(emptyPage);

    const response = await app.inject({
      method: "GET",
      url: summaryUrl({ granularity: "month" }),
      headers: { [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_A }
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_BAD_REQUEST);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_VALIDATION_ERROR
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns items: [] and total: 0 when the range has no data", async () => {
    vi.spyOn(app.container.usageService, "getUsageSummary").mockResolvedValueOnce(emptyPage);

    const response = await app.inject({
      method: "GET",
      url: summaryUrl(),
      headers: { [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_A }
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_OK);
    expect(response.json()).toMatchObject({ data: { items: [], total: 0 } });
  });

  it("scopes the query to the tenant supplied in the tenant header", async () => {
    const spy = vi
      .spyOn(app.container.usageService, "getUsageSummary")
      .mockResolvedValueOnce(emptyPage);

    await app.inject({
      method: "GET",
      url: summaryUrl(),
      headers: { [USAGE_SERVICE_HEADERS.TENANT_ID]: TENANT_ID_B }
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(TENANT_ID_B, expect.any(Object));
    expect(spy).not.toHaveBeenCalledWith(TENANT_ID_A, expect.any(Object));
  });

  it("returns 401 when the tenant header is missing", async () => {
    const response = await app.inject({
      method: "GET",
      url: summaryUrl()
    });

    expect(response.statusCode).toBe(USAGE_SERVICE_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
    expect(response.json()).toMatchObject({
      code: USAGE_SERVICE_RESPONSES.CODE_TENANT_CONTEXT_MISSING
    });
  });
});
