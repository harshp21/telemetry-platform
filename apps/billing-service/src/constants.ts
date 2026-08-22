import { INTERNAL_AUTH_HEADERS, INTERNAL_AUTH_RESPONSES } from "@telemetry/shared-types";

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
  CODE_UNAUTHORIZED: INTERNAL_AUTH_RESPONSES.CODE_UNAUTHORIZED
} as const;

export const BILLING_RUNTIME = {
  DEFAULT_PORT: 3004,
  HOST: "0.0.0.0"
} as const;
