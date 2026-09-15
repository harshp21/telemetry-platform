import { INTERNAL_AUTH_HEADERS, INTERNAL_AUTH_RESPONSES } from "@telemetry/shared-types";

import { BILLING_SERVICE_STARTUP } from "./startup.constants";

export const BILLING_SERVICE_NAME = "billing-service";

export const BILLING_ROUTES = {
  HEALTH: "/health",
  INTERNAL_BILLING_GENERATE: "/v1/internal/billing/generate"
} as const;

export const BILLING_HEADERS = {
  INTERNAL_SECRET: INTERNAL_AUTH_HEADERS.INTERNAL_SECRET
} as const;

export const BILLING_RESPONSES = {
  STATUS_OK: "ok",
  STATUS_ACCEPTED: "accepted",
  WORKFLOW_BILLING_GENERATION: "billing-generation",
  CODE_UNAUTHORIZED: INTERNAL_AUTH_RESPONSES.CODE_UNAUTHORIZED,
  // Named to match worker-service's `WORKER_RESPONSES.HTTP_STATUS_*` and usage-service's
  // `USAGE_SERVICE_RESPONSES.HTTP_STATUS_*`. `middleware/internal-auth.middleware.ts` still
  // writes a literal 401; that file is left untouched here because it is S-8 item 3's, and
  // these are the constants S-8 should adopt when it lands.
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_UNAUTHORIZED: 401
} as const;

export const BILLING_RUNTIME = {
  // Derived, not repeated. `startup.constants.ts` is the side-effect-free module `index.ts`
  // reads before `initTracing(...)` (`.claude/rules/constants.md`), so it owns the value and
  // this file imports it -- never the other way round, which would drag this module's
  // `@telemetry/shared-types` import into the pre-tracing path.
  //
  // Both objects existed at `961d222` with `3004` written twice, and both copies are live:
  // `index.ts` and `config/env.ts` read the startup one, `tests/smoke.test.ts` reads this one.
  // Pre-existing duplication, not introduced by T-044; collapsed here because T-044's own
  // change made `env.ts` a third reader of the same number (Gate-4 NIT).
  DEFAULT_PORT: BILLING_SERVICE_STARTUP.DEFAULT_PORT,
  HOST: "0.0.0.0"
} as const;
