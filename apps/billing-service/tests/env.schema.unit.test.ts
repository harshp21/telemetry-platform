import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
import { internalApiSecretSchema } from "@telemetry/shared-validation";
import { buildBillingServiceApp } from "../src/app";
import { InternalApiSecretMissingError } from "../src/errors";
import { EnvSchema, env } from "../src/config/env";
import {
  BILLING_HEADERS,
  BILLING_RESPONSES,
  BILLING_ROUTES,
  BILLING_RUNTIME
} from "../src/constants";
import { BILLING_SERVICE_STARTUP } from "../src/startup.constants";


/**
 * The top of `INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN`'s accepted range, and the code point one
 * above it.
 *
 * A *boundary* rather than a character picked from deep inside the rejected space: a pattern that
 * was accidentally one character too wide would still reject U+200B, so a case built on that
 * would pass while the rule it guards was wrong. Written as a char code and derived with `+ 1`
 * rather than as an escape, so the relationship is stated in the source and no invisible
 * character lives in this file.
 *
 * The exhaustive character-class table -- U+001F, U+007F, U+00AD, U+200B, U+0085, U+034F -- lives
 * once, in `packages/shared-validation/tests/unit.test.ts`, against the fragment itself. What
 * each service asserts is that its own field **is** that fragment, plus this one end-to-end
 * rejection proving the field is reached through the whole-object parse.
 */
const PRINTABLE_ASCII_RANGE_END = 0x7e;
const JUST_ABOVE_PRINTABLE_ASCII = String.fromCharCode(PRINTABLE_ASCII_RANGE_END + 1);

const VALID_INTERNAL_API_SECRET = "t-044-billing-internal-secret-at-least-32-chars";
const OTHER_VALID_INTERNAL_API_SECRET = "t-044-billing-other-secret-at-least-32-chars";

const buildBaseEnv = (): Record<string, string> => ({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry",
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "silent",
  INTERNAL_API_SECRET: VALID_INTERNAL_API_SECRET
});

/**
 * Throws rather than returning the fixture unchanged when the key is already absent: a helper
 * that silently no-ops turns "rejects an env with no X" into "accepts the base env", which
 * passes for the wrong reason (`.claude/rules/testing.md`).
 */
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

/**
 * The deploy artifacts the service port has to agree with, resolved from this file rather than
 * from `process.cwd()` so the case does not depend on where vitest was invoked.
 */
const BILLING_ENV_EXAMPLE_URL = new URL("../.env.example", import.meta.url);
const GATEWAY_ENV_EXAMPLE_URL = new URL("../../gateway/.env.example", import.meta.url);
const DOCKER_COMPOSE_URL = new URL("../../../docker/docker-compose.yml", import.meta.url);
const COMPOSE_BILLING_SERVICE_KEY = "billing-service";
/**
 * The compose services that hold a `BILLING_SERVICE_URL`, i.e. *other* services' view of
 * billing's port.
 *
 * Two since T-042, which gave worker-service one so its nightly invoice job can reach
 * `POST /v1/internal/billing/generate`. Before that there was exactly one and the locator below
 * was file-scoped; the second copy made that locator throw
 * `Expected exactly one BILLING_SERVICE_URL in docker-compose.yml; found 2`, which is the helper
 * working as designed -- its message says to fix the locator, not the assertion. Scoping it per
 * service block is the fix, and pinning **both** is strictly stronger than pinning one: a drift
 * in worker's copy would 502 every nightly billing call exactly as a drift in gateway's would
 * 502 every proxied request, and nothing else would notice either.
 *
 * Add a service here when it gains a `BILLING_SERVICE_URL`. The locator throws rather than
 * skipping if a named block has none, so a service listed here and later stripped of the
 * variable fails loudly rather than silently dropping out of the assertion.
 */
const COMPOSE_BILLING_CONSUMER_SERVICE_KEYS = ["gateway", "worker-service"] as const;

/**
 * Locators that **throw** when they match anything other than exactly once.
 *
 * This is the whole reason the case exists. A regex that silently matches nothing turns a
 * deploy-artifact guard into a test that cannot fail -- the same failure mode as the
 * constant-vs-constant assertion this replaced, which compared two expressions that had become
 * one. If an artifact is reformatted, this must go red on the locator rather than pass on an
 * empty match set (`.claude/rules/testing.md`: a helper that locates something must throw when
 * it is missing).
 */
const extractSoleMatch = (source: string, pattern: RegExp, description: string): RegExpMatchArray => {
  const matches = [...source.matchAll(pattern)];
  const [soleMatch] = matches;

  // `soleMatch === undefined` is redundant with the count under `noUncheckedIndexedAccess`
  // rather than a second condition: it is what narrows the type, and it keeps the throw the
  // single exit for "did not find exactly one".
  if (matches.length !== 1 || soleMatch === undefined) {
    throw new Error(
      `Expected exactly one ${description}; found ${matches.length}. The artifact moved or was reformatted -- fix the locator, do not delete the assertion.`
    );
  }

  return soleMatch;
};

/**
 * The lines of one compose service's block: everything after `  <name>:` up to the next key at
 * column 0 or 2. Scoping matters -- `PORT:` appears in every service's `environment`, so a
 * whole-file search would pick up six of them and `extractSoleMatch` would (correctly) throw.
 */
const extractComposeServiceBlock = (compose: string, serviceName: string): string => {
  const lines = compose.split("\n");
  const startIndex = lines.indexOf(`  ${serviceName}:`);

  if (startIndex === -1) {
    throw new Error(`docker-compose.yml has no "  ${serviceName}:" service key.`);
  }

  const remainder = lines.slice(startIndex + 1);
  const endOffset = remainder.findIndex((line) => /^ {0,2}\S/.test(line));

  return (endOffset === -1 ? remainder : remainder.slice(0, endOffset)).join("\n");
};

describe("billing-service env schema", () => {
  describe("core infrastructure configuration", () => {
    // AC7. Nothing reads the parsed `env.PORT`: `src/index.ts` binds
    // `process.env.PORT ?? BILLING_SERVICE_STARTUP.DEFAULT_PORT` directly. This asserts the
    // declaration agrees with the port the service actually binds.
    //
    // The second assertion no longer guards the number, and must not be read as if it did.
    // `BILLING_RUNTIME.DEFAULT_PORT` is now `BILLING_SERVICE_STARTUP.DEFAULT_PORT` by
    // derivation (Gate-4 NIT on finding F7), so while that derivation stands both sides are one
    // expression and the line cannot fail: measured at Gate 5 by setting the startup constant to
    // 9999, under which this test stayed green and only the deploy-artifact case below went red.
    // It regains teeth only if someone reintroduces a literal here *and* gives it a different
    // value -- a literal that happens to agree would pass, and nothing in the type system
    // prevents either. The number itself is pinned by the case below.
    it("defaults PORT to the port index.ts binds", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.PORT).toBe(BILLING_SERVICE_STARTUP.DEFAULT_PORT);
      }

      expect(BILLING_RUNTIME.DEFAULT_PORT).toBe(BILLING_SERVICE_STARTUP.DEFAULT_PORT);
    });

    // AC7b (Gate-5 QA option C). Reads the real deploy artifacts at test time, because the
    // pairing that actually breaks a deployment is *service port vs published port*, and no
    // revision of this repository has ever checked it -- not the two-literal assertion above,
    // and not the tree before T-044.
    //
    // Five sites, chosen rather than defaulted:
    //   - billing's `.env.example` `PORT` and compose's `environment.PORT` are what the process
    //     binds;
    //   - compose's `"3004:3004"` mapping is what a caller outside the container reaches, and
    //     is the one that fails silently -- the container still starts, the health check still
    //     passes inside, and nothing on the host can reach it;
    //   - `BILLING_SERVICE_URL` in each of its homes: `apps/gateway/.env.example`, and compose,
    //     where T-042 took it from one service block to **two** by giving worker-service the
    //     nightly invoice job's billing address. Both compose copies are pinned, per block --
    //     the locator was file-scoped until that second copy made it throw.
    //     These are another service's configuration, which is a different *kind* of coupling
    //     (one service's view of another) but the same failure: move billing's port, redeploy,
    //     and every proxied `/v1/billing` request 502s. Gate 6 (M-1) caught the gateway
    //     `.env.example` copy missing from this set -- mutating it to 9999 left billing 17/17
    //     and gateway 38/38 green, so nothing anywhere noticed.
    //
    // Deliberately **not** pinned, so the next reader does not have to rediscover it: the same
    // number is written a sixth time at `apps/billing-service/tests/setup.ts` (`PORT ??=`). It
    // is a test fixture rather than a deploy artifact and no code reads it -- nothing reads the
    // parsed `env.PORT` at all (see the case above), and `tests/smoke.test.ts` listens on port
    // 0. Mutating it does not break a deployment, which is the line this case draws. The
    // occurrences in `docs/epics/**` and in comments are prose and are out of scope for the
    // same reason.
    it("pins DEFAULT_PORT to the port every deploy artifact publishes", () => {
      const expectedPort = String(BILLING_SERVICE_STARTUP.DEFAULT_PORT);
      const envExample = readFileSync(BILLING_ENV_EXAMPLE_URL, "utf8");
      const gatewayEnvExample = readFileSync(GATEWAY_ENV_EXAMPLE_URL, "utf8");
      const compose = readFileSync(DOCKER_COMPOSE_URL, "utf8");
      const billingBlock = extractComposeServiceBlock(compose, COMPOSE_BILLING_SERVICE_KEY);

      const [, envExamplePort] = extractSoleMatch(
        envExample,
        /^PORT=(\d+)$/gm,
        "PORT= line in apps/billing-service/.env.example"
      );
      const [, composeEnvPort] = extractSoleMatch(
        billingBlock,
        /^ +PORT: "(\d+)"$/gm,
        'PORT: "..." entry in docker-compose.yml billing-service environment'
      );
      const [, publishedPort, containerPort] = extractSoleMatch(
        billingBlock,
        /^ +- "(\d+):(\d+)"$/gm,
        "published port mapping in docker-compose.yml billing-service ports"
      );
      const composeUpstreamPorts = COMPOSE_BILLING_CONSUMER_SERVICE_KEYS.map((serviceKey) => {
        const [, port] = extractSoleMatch(
          extractComposeServiceBlock(compose, serviceKey),
          /^ +BILLING_SERVICE_URL: http:\/\/billing-service:(\d+)$/gm,
          `BILLING_SERVICE_URL in docker-compose.yml ${serviceKey} environment`
        );

        return port;
      });
      // Host-agnostic where compose's is not: compose addresses billing by its service name and
      // this file by `localhost`, and only the port is this case's business. Gateway's
      // `.env.example` holds exactly one `BILLING_SERVICE_URL` and one `3004` (checked), so
      // unlike compose -- where `PORT: "` appears six times -- it needs no block scoping.
      const [, gatewayEnvExamplePort] = extractSoleMatch(
        gatewayEnvExample,
        /^BILLING_SERVICE_URL=https?:\/\/[^:/\s]+:(\d+)$/gm,
        "BILLING_SERVICE_URL line in apps/gateway/.env.example"
      );

      expect(envExamplePort).toBe(expectedPort);
      expect(composeEnvPort).toBe(expectedPort);
      expect(containerPort).toBe(expectedPort);
      expect(publishedPort).toBe(expectedPort);
      for (const upstreamPort of composeUpstreamPorts) {
        expect(upstreamPort).toBe(expectedPort);
      }
      expect(gatewayEnvExamplePort).toBe(expectedPort);
      // **Exhaustiveness, which the per-block loop above does not give.** That loop checks the
      // two services named in `COMPOSE_BILLING_CONSUMER_SERVICE_KEYS`; a *third* consumer added
      // to compose with a wrong port would satisfy every assertion above. Before T-042 this file
      // ran one file-scoped `extractSoleMatch` over the whole compose file, which threw the
      // moment a second `BILLING_SERVICE_URL` appeared -- and that is exactly how T-042
      // discovered it had to add one. The per-block form is strictly better for the services it
      // names; this line puts back the property that was traded away, so adding a consumer to
      // compose without adding it to the constant reddens here rather than passing silently.
      expect(compose.match(/^ +BILLING_SERVICE_URL:/gm) ?? []).toHaveLength(
        COMPOSE_BILLING_CONSUMER_SERVICE_KEYS.length
      );
    });

    // AC11
    it("rejects an env with no DATABASE_URL", () => {
      expectIssueOn(EnvSchema.safeParse(buildEnvWithout("DATABASE_URL")), "DATABASE_URL");
    });

    // AC11
    it("rejects an env with no REDIS_URL", () => {
      expectIssueOn(EnvSchema.safeParse(buildEnvWithout("REDIS_URL")), "REDIS_URL");
    });

    // AC11
    it("rejects an env with no OTEL_EXPORTER_OTLP_ENDPOINT", () => {
      expectIssueOn(
        EnvSchema.safeParse(buildEnvWithout("OTEL_EXPORTER_OTLP_ENDPOINT")),
        "OTEL_EXPORTER_OTLP_ENDPOINT"
      );
    });
  });

  // S-8 item 2 for billing-service: before T-044 the shared minimum length was unenforced here
  // because `INTERNAL_API_SECRET` was never declared in the schema at all -- `app.ts` read
  // `process.env.INTERNAL_API_SECRET ?? ""` at app-build time, so a five-character secret booted
  // cleanly and authenticated callers. `parseEnv` throws at module load, which is strictly
  // earlier than the app build, so a billing-service that cannot authenticate its callers now
  // never reaches `app.listen`.
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

    // AC1
    it("rejects an env with no INTERNAL_API_SECRET", () => {
      expectIssueOn(
        EnvSchema.safeParse(buildEnvWithout("INTERNAL_API_SECRET")),
        "INTERNAL_API_SECRET"
      );
    });

    // AC2
    it("rejects an INTERNAL_API_SECRET one character below the shared minimum", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          INTERNAL_API_SECRET: "x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1)
        }),
        "INTERNAL_API_SECRET"
      );
    });

    // AC2
    it("rejects an empty INTERNAL_API_SECRET", () => {
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: "" }),
        "INTERNAL_API_SECRET"
      );
    });

    // AC3. This is the case that distinguishes `.trim().min(...)` from both of its neighbours,
    // and it is the reason the order in `src/config/env.ts` is not cosmetic. Measured on
    // zod 3.25.76 against this schema, 32 spaces as the value: `.min(32)` alone parses it
    // verbatim; `.min(32).trim()` parses it to `""`; only `.trim().min(32)` raises an issue.
    // Both of the accepting orders hand `app.ts` a secret that its own blank guard then has to
    // catch -- or, with a 31-character core padded to 35, does not catch at all.
    it("rejects an all-whitespace INTERNAL_API_SECRET at the minimum length", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          INTERNAL_API_SECRET: " ".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)
        }),
        "INTERNAL_API_SECRET"
      );
    });

    // AC3, second half. A padded core one character short of the minimum is the input that
    // `.min(...).trim()` accepts and `.trim().min(...)` rejects, so the two orderings differ
    // here on a *non-blank* value that `app.ts`'s `!internalApiSecret.trim()` guard would let
    // through.
    it("rejects an INTERNAL_API_SECRET that reaches the minimum only by its padding", () => {
      const paddedShortSecret = `  ${"x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1)}  `;

      expect(paddedShortSecret.length).toBeGreaterThan(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);

      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: paddedShortSecret }),
        "INTERNAL_API_SECRET"
      );
    });

    // AC4. `.trim()` transforms the parsed value, and that value is what
    // `buildInternalAuthMiddleware` compares against the inbound header. Pinned so the transform
    // is a stated contract rather than a side effect of the length check. Asserted on the
    // schema's output rather than through `app.inject`, which bypasses the HTTP parser.
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

    // AC5. The boundary is the shared constant, imported rather than written as 32, so a change
    // to `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` moves the test with the schema.
    it("accepts an INTERNAL_API_SECRET exactly at the shared minimum length", () => {
      const atMinimum = "x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);
      const parsed = EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: atMinimum });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.INTERNAL_API_SECRET).toBe(atMinimum);
      }
    });

    // AC6
    it("fails fast at module load when INTERNAL_API_SECRET is absent", async () => {
      vi.resetModules();
      delete process.env.INTERNAL_API_SECRET;

      await expect(import("../src/config/env")).rejects.toThrow(/INTERNAL_API_SECRET/);
    });

    // AC6
    it("loads at module load when INTERNAL_API_SECRET is present", async () => {
      vi.resetModules();
      process.env.INTERNAL_API_SECRET = VALID_INTERNAL_API_SECRET;

      const loaded = (await import("../src/config/env")) as { env: { INTERNAL_API_SECRET: string } };

      expect(loaded.env.INTERNAL_API_SECRET).toBe(VALID_INTERNAL_API_SECRET);
    });
  });

  // The declaration above is only worth anything if `app.ts` reads it. These build a real
  // Fastify instance but touch neither Postgres nor Redis: the container's ioredis client is
  // `lazyConnect` (`src/config/container.ts`), nothing calls `connect()`, and `app.inject` needs
  // no socket.
  describe("app.ts reads the parsed secret, not process.env", () => {
    const previousSecret = process.env.INTERNAL_API_SECRET;

    afterEach(() => {
      if (previousSecret === undefined) {
        delete process.env.INTERNAL_API_SECRET;
      } else {
        process.env.INTERNAL_API_SECRET = previousSecret;
      }
    });

    // AC8. The one test that separates a real fix from a comment. Before T-044 the assertions
    // held in the inverse: `app.ts` read `process.env` at app-build time, so the mutated value
    // was the one that authenticated and the parsed one was rejected.
    it("authenticates with the parsed secret after process.env.INTERNAL_API_SECRET is mutated", async () => {
      // The schema was parsed and frozen at module load with the value tests/setup.ts supplied.
      const parsedSecret = env.INTERNAL_API_SECRET;

      expect(parsedSecret).not.toBe(OTHER_VALID_INTERNAL_API_SECRET);
      process.env.INTERNAL_API_SECRET = OTHER_VALID_INTERNAL_API_SECRET;

      const app = buildBillingServiceApp();

      try {
        const accepted = await app.inject({
          method: "POST",
          url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
          headers: { [BILLING_HEADERS.INTERNAL_SECRET]: parsedSecret }
        });

        // T-045 replaced the stub handler with the real one, so an authenticated request with
        // no body now reaches the controller and fails validation. Updated rather than relaxed:
        // the subject of this case is *which secret authenticates*, and a 400 proves the
        // request got past the guard exactly as the stub's 200 did. The `not.toBe(401)` states
        // that directly, so a future handler change cannot make this pass on a rejection.
        expect(accepted.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
        expect(accepted.statusCode).not.toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
        expect(accepted.json()).toMatchObject({
          code: BILLING_RESPONSES.CODE_VALIDATION_ERROR
        });

        const rejected = await app.inject({
          method: "POST",
          url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
          headers: { [BILLING_HEADERS.INTERNAL_SECRET]: OTHER_VALID_INTERNAL_API_SECRET }
        });

        expect(rejected.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
        expect(rejected.json()).toMatchObject({ code: BILLING_RESPONSES.CODE_UNAUTHORIZED });
      } finally {
        await app.close();
      }
    });

    // AC10. `app.ts`'s blank-secret guard (`InternalApiSecretMissingError`) was implemented and
    // referenced by no billing test (finding F8). With `INTERNAL_API_SECRET` trimmed in the
    // schema the env arm can no longer produce a blank value, so this option is the remaining
    // way in -- `??` does not fall back for `""`.
    it("rejects a blank internalApiSecret option", () => {
      expect(() => buildBillingServiceApp({ internalApiSecret: "   " })).toThrow(
        InternalApiSecretMissingError
      );
      expect(() => buildBillingServiceApp({ internalApiSecret: "" })).toThrow(
        InternalApiSecretMissingError
      );
    });

    // AC9. Deliberately preserved by T-044 (D2-A): `tests/smoke.test.ts` passes an 11-character
    // override, and the override still wins over the parsed value. Pinned here because it is the
    // one path by which a secret shorter than INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH can
    // still reach the middleware -- it is not operator-reachable (`src/index.ts` calls
    // `buildBillingServiceApp()` with no arguments), and it stays open under S-8.
    it("still lets an explicit internalApiSecret option override the parsed value", async () => {
      const overrideSecret = "explicit-override-secret";

      expect(overrideSecret).not.toBe(env.INTERNAL_API_SECRET);

      const app = buildBillingServiceApp({ internalApiSecret: overrideSecret });

      try {
        const accepted = await app.inject({
          method: "POST",
          url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
          headers: { [BILLING_HEADERS.INTERNAL_SECRET]: overrideSecret }
        });

        // Same T-045 update as the case above: past the guard, then rejected by the schema.
        expect(accepted.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_BAD_REQUEST);
        expect(accepted.statusCode).not.toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);

        const rejected = await app.inject({
          method: "POST",
          url: BILLING_ROUTES.INTERNAL_BILLING_GENERATE,
          headers: { [BILLING_HEADERS.INTERNAL_SECRET]: env.INTERNAL_API_SECRET }
        });

        expect(rejected.statusCode).toBe(BILLING_RESPONSES.HTTP_STATUS_UNAUTHORIZED);
      } finally {
        await app.close();
      }
    });
  });

  // S-8. All four services that declare `INTERNAL_API_SECRET` now derive the field from one
  // fragment in `@telemetry/shared-validation`, rather than each writing the rule out. They used
  // to write it out and had drifted into two rules: billing-service and worker-service trimmed,
  // gateway and usage-service did not. Because both HTTP clients in this stack strip leading and
  // trailing SP/HTAB from a header value in transit, one stray space in a platform-wide secret
  // made this service answer `200` while usage-service answered `401` for the same configuration
  // -- measured end-to-end over a real socket against the real guard factories before this change
  // was written. The behaviour table for the fragment lives beside the fragment; what this block
  // asserts is the derivation, plus one rejection driven through the whole-object parse.
  //
  // Every pre-existing case in this file is untouched and unchanged. That is a measured property
  // rather than a hope: the chosen check order -- trim, then length, then pattern -- preserves
  // every verdict *and* every message the shipped `.trim().min(...)` produced, so the six secret
  // cases above still pass on the same inputs for the same reasons.
  describe("INTERNAL_API_SECRET derives from the shared fragment", () => {
    // The strongest single assertion here, and the one that transfers the fragment's whole input
    // table to this service by construction. Repointing this declaration back to a locally
    // written `z.string().trim().min(...)` reddens this line even though every verdict would be
    // unchanged -- which is the point, because a local copy is how the four diverged before.
    it("declares INTERNAL_API_SECRET as internalApiSecretSchema itself", () => {
      expect(EnvSchema.shape.INTERNAL_API_SECRET).toBe(internalApiSecretSchema);
    });

    // Self-check on the boundary constant, so the derivation cannot quietly point at a code point
    // the pattern accepts and turn the rejection below into a tautology.
    it("pins the printable-ASCII boundary the rejection case is built from", () => {
      expect(
        INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN.test(String.fromCharCode(PRINTABLE_ASCII_RANGE_END))
      ).toBe(true);
      expect(INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN.test(JUST_ABOVE_PRINTABLE_ASCII)).toBe(false);
    });

    // Red before the repoint: `.trim().min(...)` accepted every non-ASCII secret measured,
    // including 32 x U+00AD, which transmits intact and authenticates. The trim was never a guard
    // against invisible characters -- it strips the ECMAScript WhiteSpace set and nothing else.
    it("rejects an INTERNAL_API_SECRET carrying a character just outside printable ASCII", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          INTERNAL_API_SECRET: `${VALID_INTERNAL_API_SECRET}${JUST_ABOVE_PRINTABLE_ASCII}`
        }),
        "INTERNAL_API_SECRET"
      );
    });

    // The non-obvious half of the rule: U+0020 is *inside* `SECRET_PATTERN`, and the pattern runs
    // after the trim, so edge whitespace goes and internal spaces stay. Excluding U+0020 would
    // have been the more obvious rule and would have broken a passphrase-style secret silently.
    it("accepts an INTERNAL_API_SECRET with internal spaces", () => {
      const passphrase = `${VALID_INTERNAL_API_SECRET.slice(0, 20)} ${VALID_INTERNAL_API_SECRET.slice(20)}`;

      expect(passphrase.length).toBeGreaterThan(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);

      const parsed = EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: passphrase });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.INTERNAL_API_SECRET).toBe(passphrase);
      }
    });
  });
});
