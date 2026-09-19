import {
  INTERNAL_AUTH_HEADERS,
  INTERNAL_AUTH_RESPONSES,
  TENANT_CONTEXT_HEADERS
} from "@telemetry/shared-types";
import { ANALYTICS_SERVICE_STARTUP } from "./startup.constants";

export const ANALYTICS_SERVICE_NAME = "analytics-service";

export const ANALYTICS_ROUTES = {
  HEALTH: "/health"
} as const;

/**
 * The two request headers analytics reads, both **derived** from `@telemetry/shared-types` and
 * neither re-typed here (S-9, mirroring `apps/billing-service/src/constants.ts`).
 *
 * `x-tenant-id` in particular: S-39 records that gateway's and usage-service's own constants
 * files still hold the literal, so there are three definitions of that wire string on the tree
 * and analytics deliberately does not become a fourth. Rewiring those two is S-39's own task.
 */
export const ANALYTICS_HEADERS = {
  INTERNAL_SECRET: INTERNAL_AUTH_HEADERS.INTERNAL_SECRET,
  TENANT_ID: TENANT_CONTEXT_HEADERS.TENANT_ID
} as const;

export const ANALYTICS_RESPONSES = {
  STATUS_OK: "ok",
  // The guard's rejection body is `{ code }` with no message, matching billing-service and
  // worker-service rather than usage-service's `{ code, message }` (plan decision D2). An
  // identical response for a *missing* and for a *wrong* secret does not tell an unauthenticated
  // caller whether it guessed the header name.
  CODE_UNAUTHORIZED: INTERNAL_AUTH_RESPONSES.CODE_UNAUTHORIZED,
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_UNAUTHORIZED: 401,
  // Tenant-context vocabulary, matching usage-service's and billing-service's codes, messages
  // and `401` status verbatim. Two codes rather than one: a header that was supplied but
  // malformed is a different diagnosis from one that was never sent, and whoever reads the log
  // needs to tell them apart. Both are only reachable after the caller has proved it is the
  // gateway, so neither leaks anything to an unauthenticated client.
  //
  // These carry a `message`, unlike the guard above, because they travel as `AppError`
  // subclasses through `registerGlobalErrorHandler`, which emits `{ code, message }`.
  CODE_TENANT_CONTEXT_MISSING: "TENANT_CONTEXT_MISSING",
  MESSAGE_TENANT_CONTEXT_MISSING: "X-Tenant-Id header is required",
  CODE_TENANT_CONTEXT_INVALID: "TENANT_CONTEXT_INVALID",
  MESSAGE_TENANT_CONTEXT_INVALID: "X-Tenant-Id header must be a valid UUID"
} as const;

export const ANALYTICS_RUNTIME = {
  // Derived rather than repeated (T-050). `src/index.ts` binds
  // `ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT`, and this module's copy is read by
  // `tests/smoke.test.ts:10` in `SMOKE_TARGET=external` mode -- two writers of one number is
  // how `src/config/env.ts` came to declare a third value that disagreed with both. `HOST` is
  // left duplicated against `startup.constants.ts:4` on billing's T-044 precedent: the two
  // agree, and it is not the divergence this task is about.
  DEFAULT_PORT: ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT,
  HOST: "0.0.0.0"
} as const;
