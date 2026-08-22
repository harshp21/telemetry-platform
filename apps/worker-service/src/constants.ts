import { INTERNAL_AUTH_HEADERS, INTERNAL_AUTH_RESPONSES } from "@telemetry/shared-types";

export const WORKER_SERVICE_NAME = "worker-service";

export const WORKER_ROUTES = {
  HEALTH: "/health",
  INTERNAL_WORKER_REPLAY: "/v1/internal/worker/replay"
} as const;

export const WORKER_HEADERS = {
  INTERNAL_SECRET: INTERNAL_AUTH_HEADERS.INTERNAL_SECRET
} as const;

export const WORKER_RESPONSES = {
  STATUS_OK: "ok",
  STATUS_ACCEPTED: "accepted",
  WORKFLOW_USAGE_REPLAY: "usage-replay",
  CODE_UNAUTHORIZED: INTERNAL_AUTH_RESPONSES.CODE_UNAUTHORIZED
} as const;

export const WORKER_RUNTIME = {
  DEFAULT_PORT: 3003,
  HOST: "0.0.0.0"
} as const;
