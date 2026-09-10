import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENT_STREAM_CONSTANTS, INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
import { buildWorkerServiceApp } from "../src/app";
import { InternalApiSecretMissingError } from "../src/errors";
import { EnvSchema, env } from "../src/config/env";
import {
  WORKER_HEADERS,
  WORKER_RESPONSES,
  WORKER_ROUTES,
  WORKER_RUNTIME,
  WORKER_STREAM_CONSTANTS
} from "../src/constants";
import { WORKER_SERVICE_STARTUP } from "../src/startup.constants";

const VALID_INTERNAL_API_SECRET = "t-037-worker-internal-secret-at-least-32-chars";
const OTHER_VALID_INTERNAL_API_SECRET = "t-037-worker-other-secret-at-least-32-chars";

const buildBaseEnv = (): Record<string, string> => ({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry",
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "silent",
  INTERNAL_API_SECRET: VALID_INTERNAL_API_SECRET
});

const buildEnvWithout = (omittedKey: string): Record<string, string> => {
  const baseEnv = buildBaseEnv();

  if (!(omittedKey in baseEnv)) {
    throw new Error(`buildBaseEnv() has no "${omittedKey}" key to omit; the fixture drifted.`);
  }

  delete baseEnv[omittedKey];

  return baseEnv;
};

const expectIssueOn = (
  parsed: ReturnType<typeof EnvSchema.safeParse>,
  fieldName: string
): void => {
  expect(parsed.success).toBe(false);

  if (parsed.success) {
    return;
  }

  expect(parsed.error.issues.some((issue) => issue.path[0] === fieldName)).toBe(true);
};

describe("worker-service env schema", () => {
  describe("redis stream configuration", () => {
    // AC1. Asserted against the literal on purpose: if this were written against
    // WORKER_STREAM_CONSTANTS.DEFAULT_STREAM_NAME it would still pass after someone edited the
    // constant to a name the producer does not write.
    it("defaults REDIS_STREAM_NAME to 'telemetry:events'", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_STREAM_NAME).toBe("telemetry:events");
      }
    });

    // AC1b, reduced. D4 was flipped: `telemetry:events` now has one definition,
    // `EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM`, and usage-service's producer resolves the
    // same constant -- so worker's earlier cross-package import of usage-service's own constant
    // no longer has a divergence to detect. What remains detectable, and what this asserts, is
    // worker re-pinning its default to a literal while the shared value moves on: this fails,
    // and the AC1 literal above does not.
    it("defaults REDIS_STREAM_NAME to the shared usage-events stream key", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_STREAM_NAME).toBe(EVENT_STREAM_CONSTANTS.USAGE_EVENTS_STREAM);
      }
    });

    // AC2
    it("honours a REDIS_STREAM_NAME override", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        REDIS_STREAM_NAME: "custom:stream:name"
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_STREAM_NAME).toBe("custom:stream:name");
      }
    });

    // AC3
    it("defaults REDIS_CONSUMER_GROUP to the worker consumer group", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_CONSUMER_GROUP).toBe(
          WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_GROUP
        );
      }
    });

    // AC3
    it("honours a REDIS_CONSUMER_GROUP override", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        REDIS_CONSUMER_GROUP: "replay-group"
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_CONSUMER_GROUP).toBe("replay-group");
      }
    });

    // AC3
    it("defaults REDIS_CONSUMER_NAME to the worker consumer name", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_CONSUMER_NAME).toBe(
          WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_NAME
        );
      }
    });

    // AC3
    it("honours a REDIS_CONSUMER_NAME override", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        REDIS_CONSUMER_NAME: "worker-7"
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_CONSUMER_NAME).toBe("worker-7");
      }
    });

    // AC4
    it("defaults STREAM_BLOCK_MS to the worker block interval", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.STREAM_BLOCK_MS).toBe(WORKER_STREAM_CONSTANTS.DEFAULT_BLOCK_MS);
      }
    });

    // AC4
    it("coerces STREAM_BLOCK_MS from string to number", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        STREAM_BLOCK_MS: "250"
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.STREAM_BLOCK_MS).toBe(250);
        expect(typeof parsed.data.STREAM_BLOCK_MS).toBe("number");
      }
    });

    // AC4
    it("rejects a STREAM_BLOCK_MS of zero or below", () => {
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), STREAM_BLOCK_MS: "0" }),
        "STREAM_BLOCK_MS"
      );
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), STREAM_BLOCK_MS: "-1" }),
        "STREAM_BLOCK_MS"
      );
    });

    // AC5
    it("defaults STREAM_BATCH_SIZE to the worker batch size and coerces an override from string", () => {
      const parsedDefault = EnvSchema.safeParse(buildBaseEnv());

      expect(parsedDefault.success).toBe(true);

      if (parsedDefault.success) {
        expect(parsedDefault.data.STREAM_BATCH_SIZE).toBe(
          WORKER_STREAM_CONSTANTS.DEFAULT_BATCH_SIZE
        );
      }

      const parsedOverride = EnvSchema.safeParse({ ...buildBaseEnv(), STREAM_BATCH_SIZE: "25" });

      expect(parsedOverride.success).toBe(true);

      if (parsedOverride.success) {
        expect(parsedOverride.data.STREAM_BATCH_SIZE).toBe(25);
        expect(typeof parsedOverride.data.STREAM_BATCH_SIZE).toBe("number");
      }
    });

    // AC5. The ceiling is an operational policy choice mirroring usage-service's
    // INGEST_BATCH_MAX -- not a Redis protocol limit. XREADGROUP COUNT accepts larger values.
    it("accepts STREAM_BATCH_SIZE at both configured bounds", () => {
      const parsedMin = EnvSchema.safeParse({
        ...buildBaseEnv(),
        STREAM_BATCH_SIZE: String(WORKER_STREAM_CONSTANTS.BATCH_SIZE_MIN)
      });

      expect(parsedMin.success).toBe(true);

      if (parsedMin.success) {
        expect(parsedMin.data.STREAM_BATCH_SIZE).toBe(WORKER_STREAM_CONSTANTS.BATCH_SIZE_MIN);
      }

      const parsedMax = EnvSchema.safeParse({
        ...buildBaseEnv(),
        STREAM_BATCH_SIZE: String(WORKER_STREAM_CONSTANTS.BATCH_SIZE_MAX)
      });

      expect(parsedMax.success).toBe(true);

      if (parsedMax.success) {
        expect(parsedMax.data.STREAM_BATCH_SIZE).toBe(WORKER_STREAM_CONSTANTS.BATCH_SIZE_MAX);
      }
    });

    // AC5
    it("rejects a STREAM_BATCH_SIZE outside the configured bounds", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          STREAM_BATCH_SIZE: String(WORKER_STREAM_CONSTANTS.BATCH_SIZE_MIN - 1)
        }),
        "STREAM_BATCH_SIZE"
      );
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          STREAM_BATCH_SIZE: String(WORKER_STREAM_CONSTANTS.BATCH_SIZE_MAX + 1)
        }),
        "STREAM_BATCH_SIZE"
      );
    });

    // AC6
    it("rejects a fractional STREAM_BATCH_SIZE", () => {
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), STREAM_BATCH_SIZE: "2.5" }),
        "STREAM_BATCH_SIZE"
      );
    });

    // AC13 (L-2 from the Gate 4 review). The three `.min(1)` guards were implemented but
    // untested -- the reviewer deleted all three at once and the suite stayed 26/26 green.
    // REDIS_STREAM_NAME carries the most weight: worker has no `||` fallback the way
    // `apps/usage-service/src/events/stream.publisher.ts:35-36` does, so a blank value would
    // reach XREADGROUP in T-039 as an empty key name.
    it("rejects a blank REDIS_STREAM_NAME, REDIS_CONSUMER_GROUP or REDIS_CONSUMER_NAME", () => {
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), REDIS_STREAM_NAME: "" }),
        "REDIS_STREAM_NAME"
      );
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), REDIS_CONSUMER_GROUP: "" }),
        "REDIS_CONSUMER_GROUP"
      );
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), REDIS_CONSUMER_NAME: "" }),
        "REDIS_CONSUMER_NAME"
      );
    });
  });

  describe("core infrastructure configuration", () => {
    // AC7. `env.PORT` is read by nothing in this repo -- `apps/worker-service/src/index.ts:59`
    // binds `process.env.PORT ?? WORKER_SERVICE_STARTUP.DEFAULT_PORT` directly. This asserts the
    // declaration agrees with the port the service actually binds, and that worker's two
    // independent copies of that port have not drifted apart.
    it("defaults PORT to the port index.ts binds", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.PORT).toBe(WORKER_SERVICE_STARTUP.DEFAULT_PORT);
      }

      expect(WORKER_RUNTIME.DEFAULT_PORT).toBe(WORKER_SERVICE_STARTUP.DEFAULT_PORT);
    });

    // AC8
    it("rejects an env with no DATABASE_URL", () => {
      expectIssueOn(EnvSchema.safeParse(buildEnvWithout("DATABASE_URL")), "DATABASE_URL");
    });

    // AC8
    it("rejects an env with no REDIS_URL", () => {
      expectIssueOn(EnvSchema.safeParse(buildEnvWithout("REDIS_URL")), "REDIS_URL");
    });

    // AC8
    it("rejects an env with no OTEL_EXPORTER_OTLP_ENDPOINT", () => {
      expectIssueOn(
        EnvSchema.safeParse(buildEnvWithout("OTEL_EXPORTER_OTLP_ENDPOINT")),
        "OTEL_EXPORTER_OTLP_ENDPOINT"
      );
    });
  });

  // S-8 item 2 for worker-service: the shared minimum length was previously unenforced because
  // `INTERNAL_API_SECRET` was never declared in the schema. `parseEnv` throws at module load,
  // so a worker that cannot authenticate its callers never reaches `app.listen`.
  describe("internal service auth configuration", () => {
    const previousSecret = process.env.INTERNAL_API_SECRET;

    afterEach(() => {
      if (previousSecret === undefined) {
        delete process.env.INTERNAL_API_SECRET;
      } else {
        process.env.INTERNAL_API_SECRET = previousSecret;
      }
      vi.resetModules();
    });

    // AC9
    it("rejects an env with no INTERNAL_API_SECRET", () => {
      expectIssueOn(
        EnvSchema.safeParse(buildEnvWithout("INTERNAL_API_SECRET")),
        "INTERNAL_API_SECRET"
      );
    });

    // AC10
    it("rejects an INTERNAL_API_SECRET one character below the shared minimum", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          INTERNAL_API_SECRET: "x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1)
        }),
        "INTERNAL_API_SECRET"
      );
    });

    // AC10
    it("rejects an empty INTERNAL_API_SECRET", () => {
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: "" }),
        "INTERNAL_API_SECRET"
      );
    });

    // AC10. `.min()` measures length and does not trim, so before this rework a secret of
    // SECRET_MIN_LENGTH spaces parsed cleanly and then trimmed to empty inside `app.ts`.
    // Observed with `EnvSchema.safeParse({ ...base, INTERNAL_API_SECRET: " ".repeat(32) })`:
    // `success` was `true` and `parsed.data.INTERNAL_API_SECRET.trim()` was `""`.
    // `z.string().trim().min(...)` is what turns that into a parse failure.
    it("rejects an all-whitespace INTERNAL_API_SECRET at the minimum length", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          INTERNAL_API_SECRET: " ".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)
        }),
        "INTERNAL_API_SECRET"
      );
    });

    // AC10. `.trim()` transforms the parsed value, and that value is what
    // `buildInternalAuthMiddleware` compares byte-for-byte against the inbound header. Pinned
    // so the transform is a stated contract rather than a side effect of the length check.
    it("strips surrounding whitespace from an otherwise valid INTERNAL_API_SECRET", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INTERNAL_API_SECRET: `  ${VALID_INTERNAL_API_SECRET}  `
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.INTERNAL_API_SECRET).toBe(VALID_INTERNAL_API_SECRET);
      }
    });

    // AC10
    it("accepts an INTERNAL_API_SECRET exactly at the shared minimum length", () => {
      const atMinimum = "x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);
      const parsed = EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: atMinimum });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.INTERNAL_API_SECRET).toBe(atMinimum);
      }
    });

    // AC11
    it("fails fast at module load when INTERNAL_API_SECRET is absent", async () => {
      vi.resetModules();
      delete process.env.INTERNAL_API_SECRET;

      await expect(import("../src/config/env")).rejects.toThrow(/INTERNAL_API_SECRET/);
    });

    // AC11
    it("loads at module load when INTERNAL_API_SECRET is present", async () => {
      vi.resetModules();
      process.env.INTERNAL_API_SECRET = VALID_INTERNAL_API_SECRET;

      const loaded = (await import("../src/config/env")) as { env: { INTERNAL_API_SECRET: string } };

      expect(loaded.env.INTERNAL_API_SECRET).toBe(VALID_INTERNAL_API_SECRET);
    });
  });

  // AC12. The declaration above is only worth anything if app.ts reads it. These build a real
  // Fastify instance but touch neither Postgres nor Redis: the container's ioredis client is
  // `lazyConnect`, nothing calls `connect()`, and `app.inject` needs no socket.
  describe("app.ts reads the parsed secret, not process.env", () => {
    const previousSecret = process.env.INTERNAL_API_SECRET;

    afterEach(() => {
      if (previousSecret === undefined) {
        delete process.env.INTERNAL_API_SECRET;
      } else {
        process.env.INTERNAL_API_SECRET = previousSecret;
      }
    });

    it("authenticates with the parsed secret after process.env.INTERNAL_API_SECRET is mutated", async () => {
      // The schema was parsed and frozen at module load with the value tests/setup.ts supplied.
      const parsedSecret = env.INTERNAL_API_SECRET;

      expect(parsedSecret).not.toBe(OTHER_VALID_INTERNAL_API_SECRET);
      process.env.INTERNAL_API_SECRET = OTHER_VALID_INTERNAL_API_SECRET;

      const app = buildWorkerServiceApp();

      try {
        const accepted = await app.inject({
          method: "POST",
          url: WORKER_ROUTES.INTERNAL_WORKER_REPLAY,
          headers: { [WORKER_HEADERS.INTERNAL_SECRET]: parsedSecret }
        });

        expect(accepted.statusCode).toBe(WORKER_RESPONSES.HTTP_STATUS_OK);
        expect(accepted.json()).toMatchObject({
          status: WORKER_RESPONSES.STATUS_ACCEPTED,
          workflow: WORKER_RESPONSES.WORKFLOW_USAGE_REPLAY
        });

        const rejected = await app.inject({
          method: "POST",
          url: WORKER_ROUTES.INTERNAL_WORKER_REPLAY,
          headers: { [WORKER_HEADERS.INTERNAL_SECRET]: OTHER_VALID_INTERNAL_API_SECRET }
        });

        expect(rejected.statusCode).toBe(WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
        expect(rejected.json()).toMatchObject({ code: WORKER_RESPONSES.CODE_UNAUTHORIZED });
      } finally {
        await app.close();
      }
    });

    // AC14. `app.ts`'s blank-secret guard was implemented and never exercised. With
    // `INTERNAL_API_SECRET` now `.trim()`ed in the schema, the env path can no longer produce a
    // blank value, so this option is the only way in -- `?? ` does not fall back for `""`.
    it("rejects a blank internalApiSecret option", () => {
      expect(() => buildWorkerServiceApp({ internalApiSecret: "   " })).toThrow(
        InternalApiSecretMissingError
      );
      expect(() => buildWorkerServiceApp({ internalApiSecret: "" })).toThrow(
        InternalApiSecretMissingError
      );
    });

    // Deliberately preserved by T-037: tests/smoke.test.ts passes an 11-character override, and
    // the override still wins over the parsed value. Pinned here because it is the one path by
    // which a secret shorter than INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH can still reach the
    // middleware -- see the report's note on S-8.
    it("still lets an explicit internalApiSecret option override the parsed value", async () => {
      const overrideSecret = "explicit-override-secret";

      expect(overrideSecret).not.toBe(env.INTERNAL_API_SECRET);

      const app = buildWorkerServiceApp({ internalApiSecret: overrideSecret });

      try {
        const accepted = await app.inject({
          method: "POST",
          url: WORKER_ROUTES.INTERNAL_WORKER_REPLAY,
          headers: { [WORKER_HEADERS.INTERNAL_SECRET]: overrideSecret }
        });

        expect(accepted.statusCode).toBe(WORKER_RESPONSES.HTTP_STATUS_OK);

        const rejected = await app.inject({
          method: "POST",
          url: WORKER_ROUTES.INTERNAL_WORKER_REPLAY,
          headers: { [WORKER_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET }
        });

        expect(rejected.statusCode).toBe(WORKER_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      } finally {
        await app.close();
      }
    });
  });
});
