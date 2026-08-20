# Epic 11 — Frontend Dashboard

**Milestone**: v1-mvp (auth + shell), v1 (all three feature pages)
**Depends on**: Epic 4 (auth endpoints), Epic 6 (usage API), Epic 8 (billing API), Epic 9 (analytics API)

---

## Pre-coding decisions required

| Question | Decision needed |
|---|---|
| Q5 — Refresh token | Cookie or body? Determines how frontend stores and sends the token |
| Q11 — Dashboard scope | Confirm the 3 pages: Usage, Billing, Analytics |

---

## T-060 · API client

**File**: `apps/web/src/lib/api.ts`
**Milestone**: v1-mvp

**Story**: Typed `fetch` wrapper. Injects `Authorization` header automatically. Handles `401` by attempting one silent refresh before retrying the original request.

```ts
async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAccessToken()}`,
      ...options?.headers,
    },
  });

  if (response.status === 401) {
    // attempt silent token refresh — if it fails, redirect to login
    const refreshed = await attemptTokenRefresh();
    if (!refreshed) {
      redirectToLogin();
      throw new Error("Session expired");
    }
    return apiFetch(path, options);  // retry once with new token
  }

  if (!response.ok) {
    const error = await response.json();
    throw new ApiError(response.status, error.code, error);
  }

  return response.json() as Promise<T>;
}
```

**`ApiError` class**: Carries `status`, `code`, and raw response for use in error boundaries and toast messages.

---

## T-061 · Auth context + login page

**Files**: `src/features/auth/`, `src/routes/router.tsx`
**Milestone**: v1-mvp

**Auth context** (`src/features/auth/AuthContext.tsx`):
```ts
interface AuthContextValue {
  user: { userId: string; tenantId: string; role: string } | null;
  accessToken: string | null;    // in-memory only, never localStorage
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  isLoading: boolean;
}
```

Token storage:
- Access token: React state / context (in-memory) — survives page interactions, lost on tab close
- Refresh token: `HttpOnly` cookie (set by server) or state (per Q5 decision)
- On page reload: attempt silent refresh on app mount to restore session

**Login page** (`src/features/auth/LoginPage.tsx`):
- React Hook Form + Zod schema validation
- Show field-level errors inline
- Show server error (e.g. `INVALID_CREDENTIALS`) as a form-level message
- Redirect to `/` on success

**Protected route wrapper** (`src/features/auth/ProtectedRoute.tsx`):
- Redirects unauthenticated users to `/login`
- Shows a loading state while silent refresh is in progress (prevents flash of login page)

---

## T-062 · Dashboard page

**File**: `src/features/dashboard/DashboardPage.tsx`
**Milestone**: v1

**Data**: TanStack Query → `GET /v1/analytics/metrics?granularity=day&from={30daysAgo}&to={today}`

**Layout**:
- Three stat cards at top: **Total Events** (last 30d), **Current Period Spend** (from latest DRAFT invoice), **Active Metrics** (distinct `metricKey` count)
- `AreaChart` (Recharts) below: usage trend by day, stacked by `metricKey`
- Loading skeleton while data fetches — not a spinner

**TanStack Query config**:
```ts
useQuery({
  queryKey: ["dashboard-metrics", dateRange],
  queryFn: () => apiFetch("/v1/analytics/metrics?..."),
  staleTime: 5 * 60 * 1000,  // 5 min — dashboard data doesn't need real-time refresh
})
```

---

## T-063 · Usage page

**File**: `src/features/usage/UsagePage.tsx`
**Milestone**: v1

**Controls**:
- Date range picker (shadcn `Calendar` + `Popover` pattern) — defaults to last 30 days
- Granularity toggle: `hour | day | week` (shadcn `ToggleGroup`)
- Optional metric key filter (shadcn `Select` populated from distinct keys in response)

**Chart**: Recharts `BarChart` — grouped bars by `metricKey`, X-axis is time bucket, Y-axis is `totalQuantity`.

**TanStack Query config**:
```ts
useQuery({
  queryKey: ["usage-summary", { from, to, granularity, metricKey }],
  queryFn: () => apiFetch("/v1/usage/summary?..."),
  placeholderData: keepPreviousData,  // chart doesn't flash on filter change
})
```

---

## T-064 · Billing page

**File**: `src/features/billing/BillingPage.tsx`
**Milestone**: v1

**Invoice table**:
- Columns: Period, Total Amount, Status, Created At, Actions
- Status badge colors: `DRAFT=yellow`, `FINALIZED=blue`, `PAID=green`
- Click row → open `InvoiceDetailSheet` (shadcn `Sheet`) showing line items

**Invoice detail sheet** (`InvoiceDetailSheet.tsx`):
- Fetches `GET /v1/billing/invoices/:id` on open
- Table of line items: Metric, Quantity, Unit Price, Amount
- Total row at bottom
- "Download CSV" button → `GET /v1/analytics/export?...` with matching period filters, triggers browser download

**Download implementation**:
```ts
const downloadCsv = async (invoice: InvoiceHeader) => {
  const response = await fetch(`/v1/analytics/export?from=${invoice.periodStart}&to=${invoice.periodEnd}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `invoice-${invoice.id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};
```

---

## T-065 · Global error handling

**Files**: `src/components/ErrorBoundary.tsx`, `src/components/Toaster.tsx`
**Milestone**: v1-mvp

**React ErrorBoundary**: Wraps all routes. Displays a "Something went wrong" fallback with a retry button. Logs error to console in development.

**Toast system**:
- Simple queue: `useToastStore` (Zustand or React context)
- TanStack Query global `onError` callback: `queryClient.setDefaultOptions({ queries: { onError: toastError } })`
- `ApiError` with `code` shows a human-readable message: `RATE_LIMIT_EXCEEDED` → "Too many requests — please slow down"

**Error code → message map** (`src/lib/errorMessages.ts`):
```ts
const messages: Record<string, string> = {
  TOKEN_EXPIRED: "Your session has expired. Please log in again.",
  RATE_LIMIT_EXCEEDED: "Too many requests. Please wait a moment.",
  INVOICE_IMMUTABLE: "This invoice has been finalized and cannot be changed.",
  INTERNAL_ERROR: "Something went wrong. Please try again.",
};
```
