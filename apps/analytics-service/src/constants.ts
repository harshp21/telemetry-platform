import { ANALYTICS_SERVICE_STARTUP } from "./startup.constants";

export const ANALYTICS_SERVICE_NAME = "analytics-service";

export const ANALYTICS_ROUTES = {
  HEALTH: "/health"
} as const;

export const ANALYTICS_RESPONSES = {
  STATUS_OK: "ok"
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
