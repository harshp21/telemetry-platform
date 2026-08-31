# Senior Reviewer — Pre-QA Gate: T-035 Usage Summary Endpoint

Reviewer: Senior Reviewer (pre-QA)
Date: 2026-08-31
Branch: `main` (uncommitted working tree)
Scope: `apps/usage-service` — GET `/v1/usage/summary`

---

## Verdict

**APPROVED FOR COMMIT**

No BLOCKER and no correctness defect found. Tenant isolation, SQL-injection safety, the
pagination contract, and the Decimal/UTC normalization are all implemented correctly and are
genuinely covered by the new tests. All four compile-time gates pass task-scoped and across all
13 workspace packages with zero errors.

Findings below are 1 HIGH (pre-existing architectural exposure that this diff is the first *read*
endpoint to sit behind — explicitly **not** a T-035 regression), plus MEDIUM/LOW/NIT hygiene items.
None of them gate the commit. Dispositions are stated per finding.

---

## Findings

### HIGH-1 — usage-service trusts `X-Tenant-Id` with no service-to-service authentication
`apps/usage-service/src/middleware/tenant-context.middleware.ts:24-30` (pre-existing, T-034)
consumed by `apps/usage-service/src/routes/usage.routes.ts:15`

**Problem.** The only thing standing between a caller and another tenant's aggregated usage is the
`X-Tenant-Id` request header. The trust model holds *only* because the gateway strips any inbound
`x-tenant-id` (`apps/gateway/src/middleware/guards.middleware.ts:44`) and re-injects it from the
verified JWT auth context (`apps/gateway/src/plugins/proxy.plugin.ts:32`). usage-service itself
performs **no** `X-Internal-Secret` check, which `docs/reviewer-checklist.md` §3 requires for
internal endpoints. Anything with direct network reachability to usage-service:3002 can read any
tenant's usage by setting one header.

Until T-035, the exposed surface was write-only (`POST /v1/usage/events` — you could forge a
tenant's events but not read them). T-035 is the first endpoint that turns direct reachability into
**cross-tenant data exfiltration**. The vulnerability is inherited, but its impact class changes here.

**Fix (follow-up task, not this commit).** Add an internal-secret guard to usage-service mirroring
the checklist rule: an `onRequest` hook that compares `X-Internal-Secret` against `INTERNAL_API_SECRET`
(fail-fast at startup if the env var is absent), skipped for `/health`; have the gateway proxy inject
the header alongside `x-tenant-id` in `proxy.plugin.ts:32`.

**Disposition.** ACCEPTED for this commit. Pre-existing from T-034/T-031, out of T-035 scope,
and mitigated in the deployed topology by gateway-only ingress. Recommend raising a security task
in Epic 13 and referencing it from the epic-6 notes.

---

### MEDIUM-1 — Zod-issue formatting duplicated verbatim between controllers
`apps/usage-service/src/controllers/usage.controller.ts:31-33`
duplicates `apps/usage-service/src/controllers/events.controller.ts:38-40`

**Problem.** Identical logic (`errors.map(e => \`${e.path.join(".")}: ${e.message}\`).join("; ")`),
including both magic separators `"."` and `"; "`, now exists in two controllers. DRY violation
under the Clean Code gate; the separators are magic strings in both copies.

**Fix.** Extract to a shared helper, e.g. `apps/usage-service/src/errors/format-zod-issues.ts`:

```ts
const ISSUE_SEPARATORS = { PATH: ".", ISSUE: "; " } as const;
export const formatZodIssues = (error: ZodError): string =>
  error.errors.map((i) => `${i.path.join(ISSUE_SEPARATORS.PATH)}: ${i.message}`)
    .join(ISSUE_SEPARATORS.ISSUE);
```

then call it from `usage.controller.ts:31` and `events.controller.ts:38`.

**Disposition.** Recommended, non-blocking. Touching `events.controller.ts` widens the T-035
diff beyond its slice; fine to defer to a small hygiene task.

---

### MEDIUM-2 — New constants duplicate values that already exist in shared packages
`apps/usage-service/src/constants.ts:22-24, 45-52`
`apps/usage-service/src/validators/usage-summary.validator.ts:39-49`

**Problem.** `docs/reviewer-checklist.md` §1 says "prefer shared package constants when the same
value appears across services." Four new duplicates:

| New definition | Already defined at |
|---|---|
| `constants.ts:22` `CODE_INTERNAL_ERROR: "INTERNAL_ERROR"` | `packages/shared-types/src/index.ts:85` `ERROR_RESPONSES.CODE_INTERNAL_ERROR`, **and** `validators/events.validator.ts:14` `INGESTION_CONSTANTS.ERROR_CODES.INTERNAL_ERROR` — this is now the *third* copy |
| `constants.ts:23` `MESSAGE_INTERNAL_ERROR: "Internal server error"` | inline at `controllers/events.controller.ts:124` |
| `constants.ts:24` `MESSAGE_TENANT_CONTEXT_REQUIRED: "Missing tenantId from context"` | inline at `controllers/events.controller.ts:69` |
| `constants.ts:51` `MESSAGE_INVALID_RANGE: "from must be earlier than to"` | `packages/shared-validation/src/index.ts:34` (inside `dateRangeSchema`) |
| `usage-summary.validator.ts:39-44` page/pageSize `min 1 / max 100` | `packages/shared-validation/src/index.ts:23-26` `paginationSchema` |

Note the direction of travel is *positive*: T-035 correctly introduced named constants where
events.controller used bare literals. The residual problem is that the literals now exist in two
places instead of one because `events.controller.ts` was not migrated.

**Fix.** (a) Point `constants.ts:22` at `ERROR_RESPONSES.CODE_INTERNAL_ERROR` rather than
re-declaring the string. (b) Export the range message from `@telemetry/shared-validation` (e.g.
`DATE_RANGE_MESSAGES.INVALID_RANGE`) and import it at `usage-summary.validator.ts:47`. (c) Follow-up:
migrate `events.controller.ts:69,124` onto the new `USAGE_SERVICE_RESPONSES` constants.

**Disposition.** Recommended, non-blocking. `paginationSchema` cannot be reused directly here —
it has no `.default()` and `dateRangeSchema` is a `ZodEffects` that will not `.merge()` — so
re-declaring the *schemas* is justified; only the shared *literals* should be pulled in.

---

### MEDIUM-3 — No upper bound on date range or page number
`apps/usage-service/src/validators/usage-summary.validator.ts:28-49`

**Problem.** The schema constrains `pageSize` but not the width of `[from, to)` nor `page`. A single
authenticated tenant can request `from=1970-01-01&to=2100-01-01&granularity=hour` — `LIMIT`/`OFFSET`
bound only the rows *returned*; the `GROUP BY` and the `COUNT(*)` subquery
(`usage.repository.ts:89`) still aggregate every matching `UsageLine` row in the range, twice.
Likewise `page=1000000000` produces `OFFSET 19999999980`, which Postgres must scan and discard.
Both queries run inside one transaction, so they hold it open for the duration.

**Fix.** Add a bounded-range refine to the schema and a `MAX_PAGE`:

```ts
// constants.ts
MAX_RANGE_DAYS: 366,
MAX_PAGE: 10_000,
MESSAGE_RANGE_TOO_LARGE: "Requested range exceeds the maximum of 366 days",
```
then a second `.refine()` at `usage-summary.validator.ts:49` asserting
`new Date(to).getTime() - new Date(from).getTime() <= MAX_RANGE_DAYS * 86_400_000`,
and `.max(USAGE_SUMMARY_CONSTANTS.MAX_PAGE)` on `page` at line 34-38.

**Disposition.** ACCEPTED for v1. Gateway rate limiting (T-028) blunts the abuse case and the
index (see "What was verified") keeps the range scan sane at realistic volumes. Recommend adding the
guard before the endpoint is exposed to untrusted clients.

---

### MEDIUM-4 — `TenantId` brand is discarded at the container boundary
`apps/usage-service/src/config/container.ts:59` — `new UsageRepository(prisma, tenantId as TenantId, containerLogger)`
`apps/usage-service/src/services/usage.service.ts:12` — `(tenantId: string) => UsageRepository`

**Problem.** `TenantScopedRepository` (`base.repository.ts:65`) takes a branded `TenantId`
specifically so an arbitrary string cannot be used as a tenant scope. The factory signature types
the parameter as bare `string` and the container launders it back with an unchecked `as TenantId`.
That is exactly the boundary violation the brand exists to prevent, and
`.github/copilot-instructions.md:31` calls out unsafe casts. Root cause is upstream:
`apps/usage-service/src/types.ts:3` declares `tenantId: string` while
`docs/epics/epic-6-usage-service.md:152-156` specifies `tenantId: TenantId`.

**Fix.** Narrow at the one place the value actually enters the system — the middleware. In
`middleware/tenant-context.middleware.ts:30` validate with
`tenantIdSchema` (`packages/shared-validation/src/index.ts:38`) and assign the branded result;
change `types.ts:3` to `tenantId: TenantId`; then `UsageRepositoryFactory` becomes
`(tenantId: TenantId) => UsageRepository` and the cast at `container.ts:59` disappears.

**Disposition.** ACCEPTED for this commit — the pre-existing `string` augmentation from T-034
makes the cast locally unavoidable, and the fix belongs in a T-034 follow-up. Note that this also
means the endpoint currently accepts a non-UUID tenant header; it is safe (the value is a bound
parameter and RLS rejects non-matching rows) but it is not validated.

---

### LOW-1 — Unreachable tenant-context branch in the controller
`apps/usage-service/src/controllers/usage.controller.ts:38-45`

**Problem.** The global `onRequest` hook throws `TenantContextMissingError` (401,
`TENANT_CONTEXT_MISSING`) for every non-`/health` URL before any handler runs, so `request.tenantId`
is always populated here. The branch is dead in production and, if it *were* reachable, would return
a different contract (400 `VALIDATION_ERROR`) than the middleware's 401 for the same condition. The
controller unit test at `tests/usage.controller.unit.test.ts:188-198` passes only because it
constructs a request object the middleware could never produce, so it asserts a contract the HTTP
boundary does not have — meanwhile `tests/usage-summary.route.test.ts:157-167` correctly asserts 401.

**Fix.** Either delete lines 38-45 and read `const tenantId = request.tenantId;` directly, or keep
the defence-in-depth check but make it consistent by throwing `new TenantContextMissingError()`
(from `../errors`) so the global handler produces the same 401/`TENANT_CONTEXT_MISSING` as the
middleware. Update the unit test's expectation accordingly.

**Disposition.** Non-blocking. It mirrors the existing `events.controller.ts:65-71` pattern, so it
is at least internally consistent with the service. Prefer the "throw `TenantContextMissingError`"
variant if it is touched.

---

### LOW-2 — Magic numbers in the new tests
`apps/usage-service/tests/usage.controller.unit.test.ts:202,208` — literal `403`
`apps/usage-service/tests/usage.controller.unit.test.ts:65-66` — literal `page: 1, pageSize: 20`
`apps/usage-service/tests/usage-summary.route.test.ts:56-57` — literal `page: 1, pageSize: 20`

**Problem.** The Clean Code gate applies to tests. These three sites hard-code values that already
have constants imported *in the same file*.

**Fix.** `403` → `USAGE_SERVICE_RESPONSES.HTTP_STATUS_FORBIDDEN`;
`page: 1, pageSize: 20` → `USAGE_SUMMARY_CONSTANTS.DEFAULT_PAGE` / `.DEFAULT_PAGE_SIZE`.
The rest of both files already does this correctly, which is why these stand out.

**Disposition.** Recommended. Three one-line edits; safe to fold into this commit or a follow-up.

---

### LOW-3 — Raw SQL identifiers repeated across two queries
`apps/usage-service/src/repositories/usage.repository.ts:89,93,116`

**Problem.** `"UsageLine"`, `"metricKey"`, `"periodStart"`, `"quantity"`, `"tenantId"` appear as
inline string literals across three template sites. If a column is renamed in
`prisma/schema.prisma`, nothing fails at compile time — only at runtime, and the unit tests assert
against the same literals so they would not catch a schema drift either.

**Fix (optional).** Hoist to a service-local map, e.g. in `usage.repository.ts`:
```ts
const USAGE_LINE_SQL = {
  TABLE: Prisma.sql`"UsageLine"`,
  METRIC_KEY: Prisma.sql`"metricKey"`,
  PERIOD_START: Prisma.sql`"periodStart"`,
  QUANTITY: Prisma.sql`"quantity"`,
  TENANT_ID: Prisma.sql`"tenantId"`
} as const;
```

**Disposition.** ACCEPTED as-is. Raw SQL inherently carries identifiers; fragmenting the query
into a dozen interpolations arguably harms readability more than the duplication costs. Noting it
only because the Clean Code gate requires the magic-string sweep to be explicit.

---

### NIT-1 — `RawUsageSummaryRow` / `RawGroupedCountRow` are unchecked assertions
`apps/usage-service/src/repositories/usage.repository.ts:30-39`, applied at `:88` and `:92`

`$queryRaw<T[]>` performs no runtime validation, so these interfaces are promises, not proofs.
Mitigating factors, all verified: the union types are honestly wide (`Date | string`,
`Prisma.Decimal | string | number`) rather than optimistic; both normalizers
(`:69 toIsoString`, `:72 toQuantityString`) accept the whole union; and `:103`
(`countRows[0]?.total ?? 0`) guards the empty-array case. This is about as disciplined as
`$queryRaw` gets without a Zod parse on the result. No action required.

### NIT-2 — `String(Prisma.Decimal)` can emit exponential notation
`apps/usage-service/src/repositories/usage.repository.ts:72`

`Decimal.prototype.toString()` switches to exponential form at exponent ≥ 21. Reaching that requires
a per-bucket `SUM` above 1e21 over `DECIMAL(18,6)` rows. Not realistic; flagging only for the record.
If ever a concern, `value.toFixed()` on the Decimal branch would force plain notation.

### NIT-3 — Trailing zeros are dropped in `totalQuantity`
`DECIMAL(18,6)` value `12.500000` serializes as `"12.5"`
(asserted at `tests/usage.repository.unit.test.ts:242`). Correct numerically and stable; just be
aware the API does not preserve scale, in case a billing consumer later expects fixed 6-dp strings.

---

## What was verified

### 1. Tenant isolation — PASS
- `UsageSummaryQueryInput` (`usage.repository.ts:6-15`) has **no** `tenantId` field. A caller-supplied
  tenant is structurally unrepresentable, not merely unused.
- The tenant predicate is derived at `usage.repository.ts:111` via `this.where({})`, i.e. from
  `TenantScopedRepository`'s constructor-bound `this.tenantId` (`base.repository.ts:85`). There is no
  other path to the predicate.
- `filters` (`:116`) is built once and spliced into **both** the count query (`:89`) and the page
  query (`:93`); neither query can be issued without it. `tenantId` is bound as `$1` in both —
  asserted at `tests/usage.repository.unit.test.ts:98-107`, which additionally asserts the *other*
  tenant's id appears in neither values array.
- Both queries execute inside one `this.withTenant(...)` (`:87`), which issues
  `SELECT set_config('app.tenant_id', $1, true)` before the callback (`base.repository.ts:95`),
  activating RLS for the transaction. Ordering asserted at `tests/usage.repository.unit.test.ts:89-96`.
- The DB layer genuinely backs this up: `prisma/migrations/v1_0_initial_tenant_usage_rls/migration.sql:157`
  enables RLS on `"UsageLine"`, `:166` and `v1_2_force_row_level_security/migration.sql:9` FORCE it
  (so it applies to the table owner too), and `:179` defines
  `usage_line_tenant_isolation ... USING ("tenantId" = current_setting('app.tenant_id', true))`.
  Two independent layers, both confirmed present.
- **Middleware bypass:** `registerUsageTenantContextMiddleware` (`app.ts:21`) installs a root-instance
  `onRequest` hook (`tenant-context.middleware.ts:43`) that runs for every route regardless of
  registration order, including the route registered at `app.ts:42`. The single skip is an exact
  match on `request.url === "/health"` (`:20`) — since `request.url` includes the querystring,
  `/v1/usage/summary?...` cannot equal it under any input. No bypass. `tests/usage-summary.route.test.ts:157-167`
  confirms 401 `TENANT_CONTEXT_MISSING` at the HTTP boundary with no header.
- Compared against the ingestion path: same middleware, same registration shape
  (`routes/events.routes.ts:15` vs `routes/usage.routes.ts:15`). Consistent.
- See HIGH-1 for the one real caveat, which is upstream of this diff.

### 2. SQL injection — PASS
- `GRANULARITY_SQL` (`usage.repository.ts:52-67`) is a `Readonly<Record<UsageSummaryGranularity, ...>>`
  whose six values are `Prisma.sql` templates with **zero** interpolation slots. Granularity is used
  only as `GRANULARITY_SQL[input.granularity]` (`:83`) — a key lookup. It can select a fragment; it
  can never contribute SQL text.
- The key type is derived from the Zod enum (`usage-summary.validator.ts:11-15`), which is itself
  built from `USAGE_SUMMARY_GRANULARITY` (`constants.ts:39-43`) — single source of truth, no
  duplicate enum to drift. An unvalidated string cannot type-check into `aggregateSummary`, and at
  runtime the controller `safeParse`s before the value moves (`usage.controller.ts:27`).
- Every caller-supplied value is a bound parameter: `tenantId` `$1`, `from` `$2`, `to` `$3`,
  `metricKey` `$4` (`:112-116`), `pageSize` and `offset` (`:93`). Absent `metricKey` yields
  `Prisma.empty` (`:114`), not string concatenation.
- Nested-`Sql` splicing and parameter renumbering verified empirically, not assumed: the tests assert
  the rendered `.text` (`"tenantId" = $1`, `"metricKey" = $4`) and `.values` contents, and pass.
- `tests/usage.repository.unit.test.ts:168-175` iterates all three granularities and asserts the
  granularity string appears in neither query's `values` array — i.e. it is not a parameter *and*
  not interpolated.
- No `Prisma.raw` anywhere in the diff (grepped).

### 3. Contract correctness — PASS
- **UTC buckets.** `periodStart` is `DateTime` → `TIMESTAMP(3)` without time zone
  (`prisma/schema.prisma:89`) and Prisma persists UTC, so bare `DATE_TRUNC` yields UTC boundaries.
  No `AT TIME ZONE` anywhere — asserted negatively at `tests/usage.repository.unit.test.ts:177-184`,
  which is the right assertion since an added conversion would silently shift boundaries per server
  locale. `granularity=day` → midnight UTC, satisfying the epic's acceptance criterion. Week buckets
  are Postgres ISO-8601 (Monday 00:00 UTC), documented at `usage.repository.ts:47-50`.
- **`bucketEnd` consistency.** Each `bucketEnd` fragment is literally its own `bucketStart` fragment
  `+ INTERVAL '1 <unit>'` (`:57,61,65`), so the two can never diverge. `timestamp + interval` is pure
  arithmetic with no DST adjustment (the column is timezone-less), so `bucketEnd` is exactly the
  exclusive end of the bucket for all three granularities. Asserted at `tests:186-200`.
- **`total` = grouped-row count — confirmed identical cardinality.** The count query groups by
  `("metricKey", DATE_TRUNC(g, periodStart))`; the page query groups by
  `("metricKey", DATE_TRUNC(g, periodStart), DATE_TRUNC(g, periodStart) + INTERVAL '1 g')`. The third
  expression is a *deterministic function of the second* — a constant interval added to it — so it
  introduces no additional distinct combinations. The group counts are provably equal, not merely
  equal in practice. The extra `GROUP BY` term exists only to make `bucketEnd` selectable without an
  aggregate wrapper. This was the specific concern raised for review; it is sound.
- **`COUNT(*)::int`.** The explicit `::int` cast (`:89`) matters: an uncast `COUNT(*)` returns
  `bigint`, which Prisma decodes to a JS `BigInt` that `JSON.stringify` throws on. Correctly handled.
- **`LIMIT`/`OFFSET`.** `offset = (page - 1) * pageSize` (`:85`), 1-based. `page=3, pageSize=25` →
  `OFFSET 50` — asserted at `tests:215-222`.
- **Deterministic `ORDER BY`.** `ORDER BY DATE_TRUNC(...) ASC, "metricKey" ASC` (`:93`) sorts by the
  full grouping key, which is unique per output row. No ties are possible, so pagination cannot
  duplicate or skip rows between pages. Asserted verbatim at `tests:224-230`.
- **`from` inclusive / `to` exclusive.** `"periodStart" >= $2 AND "periodStart" < $3` (`:116`),
  asserted at `tests:109-116`. Adjacent ranges tile without double-counting.
- **Decimal → string in exactly one layer.** `toQuantityString` (`:72`) is called only at `:101`, in
  the repository row mapper. `UsageSummaryRow.totalQuantity` is typed `string` (`:21`), the service
  passes rows through untouched (`usage.service.ts:55`), and the controller sends the service's
  object as-is (`usage.controller.ts:49`). No `Prisma.Decimal` can reach JSON. Asserted at
  `tests/usage.repository.unit.test.ts:232-244` (including `not.toBeInstanceOf(Prisma.Decimal)`)
  and re-asserted at the service layer (`tests/usage.service.unit.test.ts:117-133`).
- **Empty range.** `COUNT(*)` over an empty grouped subquery still returns one row `{total: 0}`, and
  `:103` guards with `countRows[0]?.total ?? 0` for the impossible-empty case. Verified end-to-end at
  `tests/usage-summary.route.test.ts:128-139` → `200 {data: {items: [], total: 0}}`, matching the
  epic's acceptance criterion (empty range is a success, not an error).
- **Defaults and limits.** `page=1`/`pageSize=20` defaulted in the validator
  (`usage-summary.validator.ts:34-44`) so every downstream layer receives concrete numbers; verified
  through the HTTP boundary at `tests/usage-summary.route.test.ts:71-90`. `pageSize=101` → 400
  `VALIDATION_ERROR` (`tests/usage-summary.route.test.ts:92-108`). Note the deliberate and correct
  choice to **reject** rather than clamp (`usage-summary.validator.ts:25-26`) — a clamp would
  silently return a different page size than requested and corrupt client-side pagination math.
- **Response envelope.** `{ data: PaginatedResult<T> }` at `usage.controller.ts:49`; the service's
  return shape (`usage.service.ts:54-59`) matches `packages/shared-types/src/index.ts:51-56` field
  for field.

### 4. Clean code gate — PASS with findings
- Route path: constant (`constants.ts:6`, used at `usage.routes.ts:15`). No hard-coded path.
- Header name: constant (`constants.ts:10`), used in tests via `USAGE_SERVICE_HEADERS.TENANT_ID`.
- HTTP status codes in new **source**: all from `USAGE_SERVICE_RESPONSES` — `:29,40,49,67` in the
  controller. Zero bare numeric statuses in the new source files (contrast `events.controller.ts:54,66,76,121`,
  which still uses literals — pre-existing, untouched).
- Error codes and messages: all from constants (`:30,41,42,68,69`).
- Pagination numbers: all from `USAGE_SUMMARY_CONSTANTS` (`usage-summary.validator.ts:37,38,42,43,44`).
- Granularity strings: single-sourced at `constants.ts:39-43`, consumed by both the validator and
  the repository's fragment map — **no duplicate enum**, which was the main DRY risk in this design.
- Violations found: MEDIUM-1 (duplicated formatter), MEDIUM-2 (cross-package literal duplication),
  LOW-2 (magic numbers in tests), LOW-3 (SQL identifiers). All dispositioned above.

### 5. Type safety — PASS with notes
- No `any` in any new source or test file (grepped; the 4 `no-unsafe-assignment` warnings in the
  package are in a file this diff does not touch — see below).
- Strict `tsc --noEmit` clean.
- Two unchecked assertions, both at the `$queryRaw` boundary — NIT-1, with the mitigations
  enumerated there. One `as TenantId` in the container — MEDIUM-4.
- `Readonly<Record<...>>` on `GRANULARITY_SQL` and `readonly` on every interface field is the right
  posture for a security-sensitive lookup table.

### 6. Production readiness — PASS with notes
- **Error contract.** Controller handles validation (400), `AppError` (own status/code), and
  unexpected (500 + logged) — `usage.controller.ts:26-71`. This composes correctly with the global
  handler (`packages/shared-utils/src/index.ts:112-148`): `AppError` produces the same
  `{code, message}` shape either way, and `TenantContextMissingError` thrown from the middleware
  reaches the global handler as a 401. One shape divergence: the global handler renders `ZodError` as
  `{code, issues[]}` while the controller renders `{code, message: string}` — the controller catches
  validation itself so the two never both apply to this route, and the chosen shape matches
  `events.controller.ts`. Consistent within the service; noted for API-doc accuracy.
- **Middleware ordering** (`app.ts:20-21`): global error handler registered, then the tenant hook,
  then routes at `:39,42`. Root-instance `onRequest` hooks run before every handler regardless of
  relative registration order. Correct.
- **Index coverage — the specific production risk raised for this review.** There is **no**
  `(tenantId, periodStart, metricKey)` index, as suspected. However `prisma/schema.prisma:94`
  defines `@@index([tenantId, periodStart, periodEnd])`, whose leading two columns exactly match the
  query's driving predicate (`tenantId = $1 AND periodStart >= $2 AND periodStart < $3`). Postgres
  will use it as an index range scan; the third column simply goes unused. **There is no table scan
  per summary request.** The residual cost is that the optional `metricKey` filter and the
  `GROUP BY`/sort are not index-covered, so Postgres does a HashAggregate over the range-scanned
  rows — proportional to range width, not table size. Adequate for v1. If summary latency becomes an
  issue, the targeted improvement is `@@index([tenantId, metricKey, periodStart])` for the
  metricKey-filtered variant. Combine this with MEDIUM-3 (unbounded range) when prioritizing.
- **Two sequential queries per request.** Both run inside one `$transaction` (`:88`, `:92`), so they
  are consistent with each other (no torn count/page across a concurrent write) at the cost of one
  extra round trip and a slightly longer-held transaction. The right trade for a paginated aggregate.
  A `COUNT(*) OVER ()` window in the page query would halve the round trips but would break the
  `total`-vs-`LIMIT` semantics; the current split is correct.
- **Logging.** Debug on success with `{tenantId, granularity, page, pageSize, total}`
  (`usage.service.ts:43-52`); error on unexpected failure with `{error, path}`
  (`usage.controller.ts:59-65`); transaction start/commit/rollback from the base repository
  (`base.repository.ts:93,98,101`). No PII, no query values dumped. Adequate. Gap: no observability
  on *slow* queries — with MEDIUM-3 unfixed there is nothing that would surface an expensive range
  scan other than the Fastify request-time log.

### 7. Test coverage alignment — PASS (47 new tests, no tautologies found)
Distribution: repository 20, controller 12, service 8, route 7 = 47. All pass.

- **Repository tests are the strong point** and notably not tautological: they assert on the
  *rendered SQL text and bound-value arrays* (`.text` / `.values` of the captured `Prisma.Sql`), not
  on the mock's return value. The Prisma double (`tests:51-62`) resolves `$queryRaw` in call order
  [set_config, count, page], and `sqlAt` (`:64-70`) throws rather than silently passing when an
  expected call is missing — so a regression that dropped a query would fail, not pass vacuously.
  Every test name I checked matches what its body actually proves.
- **Genuinely behavioural assertions** worth calling out: the negative tenant assertion
  (`:105-106`), the negative `AT TIME ZONE` assertion (`:183`), the negative granularity-as-parameter
  loop (`:168-175`), and the `not.toBeInstanceOf(Prisma.Decimal)` check (`:243`). These test the
  *absence* of failure modes, which is what a security-sensitive raw-SQL layer needs.
- **Error paths covered** at every layer: repository (`:268-277` DB error propagates), service
  (`tests/usage.service.unit.test.ts:135-139` repository error propagates), controller
  (`tests/usage.controller.unit.test.ts:200-213` AppError normalized, `:215-228` unexpected → 500 +
  logger asserted).
- **Validation matrix** complete against the plan: bad `from` format, `from >= to`, bad granularity,
  `page` < min, `pageSize` < min, `pageSize` > max — `tests/usage.controller.unit.test.ts:106-186`.
  Several correctly also assert `getUsageSummary` was *not* called, proving short-circuit rather than
  just response shape.
- **Route tests** exercise the real app via `app.inject` with per-test `beforeEach`/`afterEach`
  lifecycle (`tests/usage-summary.route.test.ts:37-43`), per `docs/reviewer-checklist.md` §4.
  Includes a tenant-scoping assertion (`:141-155`) that checks the service was called with tenant B
  **and not** tenant A.
- **Weak spot:** `tests/usage.controller.unit.test.ts:188-198` asserts a contract the HTTP boundary
  cannot produce — see LOW-1.
- **Untested implemented logic:** none found. Every branch in the four new source files is reached,
  including `Prisma.empty` (`:118-123`), the `?? 0` count guard (`:262-266`), and all three
  granularity fragments.
- **Coverage the unit suite cannot give** — deliberately deferred to T-036, correctly per the plan:
  actual Postgres `DATE_TRUNC` output, actual RLS enforcement, actual `SUM` over real rows, actual
  `Prisma.Decimal` decoding from `$queryRaw`, and real index/plan behaviour.

### 8. Plan alignment / scope creep — PASS
Files changed match `docs/plans/t-035-usage-summary-endpoint.md` §3 exactly — nine new files, eight
modified, nothing extra. No unrelated refactors. Assessing the three stated deviations:

- **(a) Repository registered as a factory, not a singleton** — **CORRECT, and the singleton would
  have been a bug.** `TenantScopedRepository` binds `tenantId` in its constructor
  (`base.repository.ts:65`); a container-level singleton would pin one tenant for the process
  lifetime and serve every tenant's request from the first tenant's scope. The factory
  (`container.ts:58-59`) is the only sound wiring. Accept.
- **(b) Route test stubs the service, not the repository** — acceptable and explicitly permitted by
  plan §4 step 9 ("Stub repository/service calls"). It exercises routing, the middleware chain,
  validation, defaults, and the response envelope, which is the stated purpose. Stubbing the
  repository instead would have added a Prisma double without covering anything the repository unit
  tests do not already cover more precisely. Accept.
- **(c) Aggregation reads `UsageLine` rather than `Event`** — **this is not a deviation at all.**
  `docs/epics/epic-6-usage-service.md:180` specifies verbatim: *"Query `UsageLine` grouped by
  `metricKey` and time bucket (using `DATE_TRUNC` in Prisma raw query or computed bucket)."*
  The implementation matches the epic exactly; only the plan document was vague. It is also the only
  defensible choice on the schema: `Event` (`prisma/schema.prisma:64-80`) has `eventType`, not
  `metricKey`, so it cannot satisfy the `metricKey` grouping/filtering the query contract requires.
  I also considered `MetricRollup` (`:147-158`), which carries `metricKey` + a `Granularity` enum +
  `bucketStart` and superficially looks purpose-built for this — but it is pre-aggregated at fixed
  granularities and is Epic 9/10 territory; aggregating `UsageLine` on demand is both more accurate
  and correctly scoped for v1. **The implementer's most-suspect deviation is the one that is
  unambiguously right.** Accept, and recommend correcting the plan's §10 wording so it is not
  recorded as a deviation.

---

## Compile-time validation results (verbatim)

### Task-scoped — all four PASS

```
> @telemetry/usage-service@0.1.0 lint /home/admin1/personal-workspace/telemetry-platform/apps/usage-service
> eslint .

/home/admin1/personal-workspace/telemetry-platform/apps/usage-service/tests/ingestion.service.unit.test.ts
  329:6  warning  Unsafe assignment of an `any` value  @typescript-eslint/no-unsafe-assignment
  330:6  warning  Unsafe assignment of an `any` value  @typescript-eslint/no-unsafe-assignment
  533:6  warning  Unsafe assignment of an `any` value  @typescript-eslint/no-unsafe-assignment
  534:6  warning  Unsafe assignment of an `any` value  @typescript-eslint/no-unsafe-assignment

✖ 4 problems (0 errors, 4 warnings)

===LINT_EXIT:0===

> @telemetry/usage-service@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

===TYPECHECK_EXIT:0===

> @telemetry/usage-service@0.1.0 test
> vitest run

 ✓ tests/usage.service.unit.test.ts (8 tests) 24ms
 ✓ tests/stream.publisher.unit.test.ts (9 tests) 30ms
 ✓ tests/deduplication.service.unit.test.ts (10 tests) 29ms
 ✓ tests/usage.repository.unit.test.ts (20 tests) 47ms
 ✓ tests/index.graceful-shutdown.unit.test.ts (7 tests) 149ms
 ✓ tests/usage.controller.unit.test.ts (12 tests) 29ms
 ✓ tests/ingestion.service.unit.test.ts (18 tests) 29ms
 ✓ tests/events.controller.unit.test.ts (10 tests) 64ms
 ✓ tests/middleware.tenant-context.unit.test.ts (7 tests) 164ms
 ✓ tests/env.schema.unit.test.ts (8 tests) 8ms
 ✓ tests/config/prisma.singleton.unit.test.ts (4 tests) 36ms
 ✓ tests/config/container.unit.test.ts (6 tests) 13ms
 ✓ tests/smoke.test.ts (1 test) 57ms
 ✓ tests/usage-summary.route.test.ts (7 tests) 117ms
 ✓ tests/usage-events.route.test.ts (5 tests) 127ms

 Test Files  15 passed (15)
      Tests  132 passed (132)
   Duration  1.26s

===TEST_EXIT:0===

> @telemetry/usage-service@0.1.0 build
> tsc -p tsconfig.json

===BUILD_EXIT:0===
```

### Full workspace — all 13 packages PASS on all four gates

```
===FULL_LINT_EXIT:0===       Tasks: 13 successful, 13 total
===FULL_TYPECHECK_EXIT:0===  Tasks: 13 successful, 13 total
===FULL_BUILD_EXIT:0===      Tasks: 13 successful, 13 total
===FULL_TEST_EXIT:0===       Tasks: 13 successful, 13 total
```

Per-package test totals from the full run:

| Package | Test files | Tests |
|---|---|---|
| @telemetry/shared-types | 1 | 7 |
| @telemetry/shared-logger | 1 | 4 |
| @telemetry/shared-config | 1 | 4 |
| @telemetry/shared-validation | 1 | 15 |
| @telemetry/shared-tracing | 1 | 2 |
| @telemetry/shared-utils | 1 | 18 |
| @telemetry/worker-service | 4 | 19 |
| @telemetry/billing-service | 4 | 18 |
| @telemetry/analytics-service | 4 | 18 |
| @telemetry/gateway | 8 | 37 |
| @telemetry/usage-service | 15 | 132 |
| @telemetry/auth-service | 14 | 126 |
| (13th package: shared config/tooling target — lint/typecheck/build only) | — | — |

**Zero errors. 21 warnings total, all pre-existing and all outside this diff — verified, not assumed:**
- 4 in `apps/usage-service/tests/ingestion.service.unit.test.ts:329,330,533,534`
  (`no-unsafe-assignment`). Confirmed pre-existing two ways: the file does not appear in
  `git diff --name-only` (which lists only the 8 modified `src/` files) and is not untracked;
  and `git log --oneline -1 -- apps/usage-service/tests/ingestion.service.unit.test.ts` returns
  `c26f370 feat(usage-service): implement T-031 event ingestion endpoint` — last modified by T-031.
- 17 in `apps/auth-service` (10 × `no-misused-promises`, 7 × `no-unsafe-assignment`). auth-service is
  untouched by this diff entirely.

**Classification: pre-existing, NOT T-035 findings.** The T-035 diff introduces zero new lint
warnings.

**Note on `Error: load failure` lines in the test output** (worker/billing/auth/analytics/gateway/usage):
these are stderr writes from intentional negative-path graceful-shutdown tests
(e.g. `tests/index.graceful-shutdown.unit.test.ts:126` "fails startup when loadEnvFile throws
non-ENOENT"). Every suite reports `passed`; these are not failures.

---

## What could NOT be verified

Everything below requires a live Postgres and is correctly deferred to T-036:

1. **Actual `DATE_TRUNC` output.** UTC bucket correctness is verified by construction (timezone-less
   column + no `AT TIME ZONE`) and by negative assertion, but no test observes a real truncated
   timestamp from Postgres. The week-starts-Monday claim in particular rests on documented Postgres
   semantics, not on an executed query.
2. **Actual RLS enforcement.** The policy and the `set_config` call are both verified to exist and to
   be wired; that the policy actually blocks a cross-tenant row at runtime is untested. The
   application-layer `WHERE "tenantId" = $1` would mask an RLS misconfiguration, so a
   defence-in-depth test (query with RLS active and the app predicate deliberately absent) is the
   only way to prove layer 2 independently. Recommend adding it to T-036.
3. **`Prisma.Decimal` decoding from `$queryRaw`.** Tests inject `new Prisma.Decimal(...)` into the
   mock; that Prisma actually returns a `Decimal` (not a string or a float) for `SUM(numeric)` in a
   raw query is assumed, not observed. If it returned a JS number, `String()` would still produce a
   string but with float precision loss — the exact failure mode the string normalization exists to
   prevent, and it would pass every current test. Worth one explicit T-036 assertion.
4. **`COUNT(*)::int` decoding to `number`.** Same class of assumption; the mock supplies `{total: 3}`.
5. **Count/page cardinality equality against real data.** Proven by reasoning above (functional
   dependence of `bucketEnd` on `bucketStart`); not executed.
6. **Query plan / index usage.** No `EXPLAIN` was run. The index-coverage conclusion is read off
   `prisma/schema.prisma:94` and standard B-tree leading-column semantics.
7. **End-to-end data flow.** `UsageLine` is currently written by **no code in this repository** — a
   repo-wide grep for `usageLine`/`UsageLine` in `apps/` and `packages/` returns only this diff's own
   raw SQL. Until the worker service (Epic 7) materializes `UsageLine` rows from ingested `Event`s,
   this endpoint will return `{items: [], total: 0}` for every query against real data. **This is
   expected and correct, not a defect** — the epic specifies `UsageLine` as the source
   (`epic-6-usage-service.md:180`) and T-036 seeds it directly
   (`epic-6-usage-service.md:213` "Summary query with seeded `UsageLine` data"). Flagging it so QA
   does not spend a cycle chasing empty responses against a live stack, and so the epic sequencing
   risk is on the record.

---

## Remaining risks and dispositions

| # | Risk | Severity | Disposition |
|---|---|---|---|
| 1 | Direct network access to usage-service bypasses all auth; `X-Tenant-Id` alone grants tenant read (HIGH-1) | HIGH | **Accepted** — pre-existing from T-034, mitigated by gateway-only ingress (`guards.middleware.ts:44` strips, `proxy.plugin.ts:32` injects). Raise an Epic 13 follow-up for `X-Internal-Secret`. Not a T-035 regression, but T-035 is the first read path so impact class changes. |
| 2 | Unbounded date range / page enables expensive aggregate scans (MEDIUM-3) | MEDIUM | **Accepted for v1** — gateway rate limiting mitigates; index covers the range predicate. Add `MAX_RANGE_DAYS` + `MAX_PAGE` before untrusted exposure. |
| 3 | `$queryRaw` result types are unchecked assertions (NIT-1) | LOW | **Accepted** — union types are honestly wide, normalizers handle every member, empty-array guarded. T-036 will observe real shapes. |
| 4 | `TenantId` brand laundered via `as TenantId` (MEDIUM-4) | MEDIUM | **Accepted** — locally unavoidable given `types.ts:3`. Fix belongs in a T-034 follow-up that brands `request.tenantId` at the middleware. Consequence today: the tenant header is not UUID-validated (safe, but unvalidated). |
| 5 | Literal duplication across constants/shared packages/controllers (MEDIUM-1, MEDIUM-2) | MEDIUM | **Recommended, non-blocking** — net direction is an improvement; residual duplication is because `events.controller.ts` was not migrated, which is out of slice. |
| 6 | Magic numbers in three test sites (LOW-2) | LOW | **Recommended** — three one-line edits, safe to fold into this commit. |
| 7 | Unreachable/inconsistent tenant branch in controller (LOW-1) | LOW | **Accepted** — mirrors `events.controller.ts`. Prefer throwing `TenantContextMissingError` if touched. |
| 8 | `UsageLine` has no writer until Epic 7 | INFO | **Expected** — per epic design; T-036 seeds directly. Communicate to QA so live-stack empty responses are not misread as a defect. |
| 9 | No `EXPLAIN`-verified query plan | LOW | **Accepted** — `@@index([tenantId, periodStart, periodEnd])` covers the driving predicate by leading columns. Revisit with `@@index([tenantId, metricKey, periodStart])` if the filtered variant proves slow. |
| 10 | RLS never independently exercised (app-layer predicate would mask a misconfiguration) | MEDIUM | **Deferred to T-036** — recommend an explicit defence-in-depth test there. |

### Regression assessment
No existing behaviour modified. All changes to existing files are additive: one route registration
(`app.ts:41-42`), additive container fields (`container.ts`), additive constants (`constants.ts`),
and barrel exports. The barrel files previously exported `export {}` and now export real symbols —
no existing import path changes meaning. All 132 usage-service tests and all 13 packages pass. No
breaking changes.

### Recommendation
Proceed to **QA Tester**. Optionally fold LOW-2 (three magic numbers in tests) into this commit;
everything else is a follow-up. Correct plan §10 so the `UsageLine` choice is recorded as
epic-conformant rather than as a deviation.
