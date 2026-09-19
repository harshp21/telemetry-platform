import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
import { internalApiSecretSchema } from "@telemetry/shared-validation";
import { EnvSchema } from "../src/config/env";
import { ANALYTICS_RUNTIME } from "../src/constants";
import { ANALYTICS_SERVICE_STARTUP } from "../src/startup.constants";

/**
 * T-050. analytics-service was the only one of the six services with no env-schema suite, and
 * the only field that diverged from the epic was `PORT`: the declaration defaulted to 3000
 * while six numbers across five deploy artifacts said 3005. Modelled on
 * `apps/billing-service/tests/env.schema.unit.test.ts`, which is the same task for billing
 * (T-044, the same 3000-vs-3004 divergence) and the same module shape -- both parse at module
 * load. Gateway's suite is not the model: its schema has **14** fields, it parses lazily
 * through `loadEnv()`, and it has no PORT case at all. All three measured --
 * `Object.keys(EnvSchema.shape).length` is 14 (T-050's plan says 13 while its own enumeration,
 * four service URLs plus three rate limits plus seven others, sums to 14); `loadEnv` is
 * declared at `apps/gateway/src/config/env.ts:41`; and `grep -n "PORT" apps/gateway/tests/env.schema.unit.test.ts`
 * matches one line, which is `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * **S-9 extended this file** with the `internal service auth configuration` block at the end and
 * with `INTERNAL_API_SECRET` in `buildBaseEnv` and `EXPECTED_ENV_FIELDS`. That block's red/green
 * split is recorded on the block itself; it is a different one from T-050's below, because the
 * field did not exist at all before S-9.
 *
 * Red/green split at Gate 3, stated because most of this file is a guard being added rather
 * than a regression test for the bug: exactly **one** assertion was red on the unfixed tree --
 * `defaults PORT to the port index.ts binds`, where the parsed default was 3000 against the
 * startup constant's 3005. Every other case passed before the source changed. They are
 * regression guards for behaviour that has never been broken, which `.claude/rules/testing.md`
 * permits; what it forbids is claiming they went red.
 */

/**
 * A secret this suite owns, distinct from the one `tests/setup.ts` supplies, so that a case
 * asserting on a parsed value cannot pass because it happened to match the ambient environment.
 * 46 printable-ASCII characters, above `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH`.
 */
const VALID_INTERNAL_API_SECRET = "s-009-analytics-internal-secret-at-least-32ch";

/**
 * The top of `INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN`'s accepted range, and the code point one
 * above it. A *boundary* rather than a character from deep inside the rejected space: a pattern
 * one character too wide would still reject U+200B, so a case built on that would pass while the
 * rule it guards was wrong. `apps/billing-service/tests/env.schema.unit.test.ts` carries the same
 * pair for the same reason; the exhaustive character table lives once, against the fragment
 * itself, in `packages/shared-validation/tests/unit.test.ts`.
 */
const PRINTABLE_ASCII_RANGE_END = 0x7e;
const JUST_ABOVE_PRINTABLE_ASCII = String.fromCharCode(PRINTABLE_ASCII_RANGE_END + 1);

/**
 * The four fields the schema requires with no default -- three until S-9 added
 * `INTERNAL_API_SECRET`, which `internalApiSecretSchema` declares with no default either.
 */
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
 * passes for the wrong reason (`.claude/rules/testing.md`). Billing's comment at
 * `tests/env.schema.unit.test.ts:47-51` is the precedent.
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

/** Defaults the schema declares, named so no bare literal stands in for them below. */
const DEFAULT_NODE_ENV = "development";
const DEFAULT_LOG_LEVEL = "info";
/** Outside the declared enum. Measured rejection message: `Invalid enum value. Expected ...`. */
const UNKNOWN_NODE_ENV = "staging";

/**
 * Appended to the valid port to make a float without writing one. `3005.5` as a literal would
 * be a second spelling of the port number, which `.claude/rules/constants.md` forbids in tests
 * as well as in source.
 */
const FRACTIONAL_PORT_SUFFIX = ".5";

/**
 * Values `z.coerce.number().int().positive()` rejects, with the measured reason each is
 * rejected for. Keyed rather than a bare array so a failure names the shape that failed.
 */
const INVALID_PORT_VALUES = {
  // `Number must be greater than 0`
  ZERO: "0",
  // `Number must be greater than 0`
  NEGATIVE: "-1",
  // `Expected integer, received float`
  FRACTIONAL: `${String(ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT)}${FRACTIONAL_PORT_SUFFIX}`,
  // `Number must be greater than 0` -- `z.coerce` sends "" through `Number("")`, which is 0,
  // so an empty PORT fails on the positivity rule rather than on a type rule.
  EMPTY: "",
  // `Expected number, received nan`
  NON_NUMERIC: "abc"
} as const;

/**
 * The field set epic-9 documents, in declaration order. A **name** census, with the limit
 * S-51 records: it notifies that the set changed and does not assert the new field is sound,
 * and the obvious response to it going red -- append the name -- discharges it. It is here to
 * make a silent addition or removal impossible to land unnoticed, not to vet one.
 *
 * `DIRECT_DATABASE_URL` is deliberately absent: `tests/setup.ts` sets it and no service
 * declares it in any env schema, because it is a Prisma `directUrl` and integration-fixture
 * concern and `.claude/rules/tenant-isolation.md` forbids pointing a running service at it.
 */
const EXPECTED_ENV_FIELDS = [
  "NODE_ENV",
  "PORT",
  "DATABASE_URL",
  "REDIS_URL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "LOG_LEVEL",
  "INTERNAL_API_SECRET"
] as const;

/**
 * The deploy artifacts the service port has to agree with, resolved from this file rather than
 * from `process.cwd()` so the case does not depend on where vitest was invoked.
 */
const ANALYTICS_ENV_EXAMPLE_URL = new URL("../.env.example", import.meta.url);
const GATEWAY_ENV_EXAMPLE_URL = new URL("../../gateway/.env.example", import.meta.url);
const DOCKER_COMPOSE_URL = new URL("../../../docker/docker-compose.yml", import.meta.url);
/**
 * A third spelling of `"analytics-service"` -- `src/constants.ts:3` (`ANALYTICS_SERVICE_NAME`)
 * and `src/startup.constants.ts:2` (`SERVICE_NAME`) already hold it, both pre-existing at
 * `493e699`. **Kept as a local literal deliberately** (Gate-4 NIT-4, disposition: keep).
 * `apps/billing-service/tests/env.schema.unit.test.ts:84` is the same shape
 * (`COMPOSE_BILLING_SERVICE_KEY`) alongside an importable `BILLING_SERVICE_NAME`, so this
 * mirrors the precedent this suite is modelled on; and a compose YAML service key is a
 * different domain from the service's own identity string. They agree today, and importing one
 * for the other would encode an invariant nobody has decided -- renaming the compose key would
 * then silently rename the service, or fail to.
 */
const COMPOSE_ANALYTICS_SERVICE_KEY = "analytics-service";

/**
 * The compose services holding an `ANALYTICS_SERVICE_URL`, i.e. *other* services' view of
 * analytics' port. One today -- gateway, which proxies `/v1/analytics`. Billing's equivalent
 * list went from one to two at T-042, and the file-scoped locator throwing is how that was
 * discovered, so add a service here when it gains the variable. The locator throws rather than
 * skipping when a named block has none, so a service listed here and later stripped of it
 * fails loudly instead of dropping out of the assertion.
 */
const COMPOSE_ANALYTICS_CONSUMER_SERVICE_KEYS = ["gateway"] as const;

/**
 * Locators that **throw** when they match anything other than exactly once.
 *
 * This is the whole reason the artifact case exists. A regex that silently matches nothing
 * turns a deploy-artifact guard into a test that cannot fail. If an artifact is reformatted
 * this must go red on the locator rather than pass on an empty match set
 * (`.claude/rules/testing.md`: a helper that locates something must throw when it is missing).
 */
const extractSoleMatch = (
  source: string,
  pattern: RegExp,
  description: string
): RegExpMatchArray => {
  const matches = [...source.matchAll(pattern)];
  const [soleMatch] = matches;

  // `soleMatch === undefined` is redundant with the count under `noUncheckedIndexedAccess`
  // rather than a second condition: it is what narrows the type, and it keeps the throw the
  // single exit for "did not find exactly one".
  if (matches.length !== 1 || soleMatch === undefined) {
    throw new Error(
      `Expected exactly one ${description}; found ${String(matches.length)}. The artifact moved or was reformatted -- fix the locator, do not delete the assertion.`
    );
  }

  return soleMatch;
};

/**
 * The lines of one compose service's block: everything after `  <name>:` up to the next key at
 * column 0 or 2. Scoping matters -- `PORT:` appears in every service's `environment`, so a
 * whole-file search would pick up several and `extractSoleMatch` would (correctly) throw.
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

describe("analytics-service env schema", () => {
  describe("core infrastructure configuration", () => {
    // Control. Without it every rejection case below could be passing because the fixture is
    // malformed for an unrelated reason rather than because the omitted field is required.
    it("parses the base fixture", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);
    });

    // AC1 -- **the one case that was red before the fix.** `buildBaseEnv()` supplies no PORT,
    // so this exercises the declared default. On the unfixed tree it parsed to 3000 against
    // `ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT`'s 3005.
    //
    // AC2, the second assertion, no longer guards the number and must not be read as if it
    // did. Since slice 3 `ANALYTICS_RUNTIME.DEFAULT_PORT` **is**
    // `ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT` by derivation, so both sides are one expression
    // and the line cannot fail while that derivation stands -- billing measured exactly this at
    // its Gate 5 by setting its startup constant to 9999, under which its equivalent case
    // stayed green and only the deploy-artifact case went red. It regains teeth only if
    // someone reintroduces a literal here *and* gives it a different value. The number itself
    // is pinned by the case below.
    it("defaults PORT to the port index.ts binds", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.PORT).toBe(ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT);
      }

      expect(ANALYTICS_RUNTIME.DEFAULT_PORT).toBe(ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT);
    });

    // AC3 + AC3b. **Green from the start** -- every artifact already said 3005 and the expected
    // value derives from the startup constant, which also says 3005. This is a guard being
    // added, not a regression test for T-050's bug. It is worth adding because the pairing that
    // actually breaks a deployment is service port vs published port, and nothing in this
    // repository checked analytics' before now.
    //
    // Six numbers across five sites, chosen rather than defaulted:
    //   - analytics' `.env.example` PORT and compose's `environment.PORT` are what the process
    //     binds;
    //   - compose's `"3005:3005"` mapping is what a caller outside the container reaches, and
    //     is the one that fails silently -- the container starts, the in-container health check
    //     passes, and nothing on the host can reach it;
    //   - `ANALYTICS_SERVICE_URL` in each of its homes: compose's gateway block and
    //     `apps/gateway/.env.example`. Those are another service's configuration, which is a
    //     different kind of coupling, but the same failure: move analytics' port, redeploy, and
    //     every proxied `/v1/analytics` request 502s. Billing's Gate 6 (M-1) caught its gateway
    //     `.env.example` copy missing from the equivalent set -- mutating it to 9999 left both
    //     packages fully green, so nothing anywhere noticed.
    //
    // **Its teeth are measured, not assumed** -- this case is green on arrival, so "it guards
    // six numbers" would otherwise be an untested claim. Seven mutations at Gate 3, each applied
    // alone, restored by file copy, and re-run with
    // `pnpm --filter @telemetry/analytics-service exec vitest run tests/env.schema.unit.test.ts`.
    // Every one produced `Tests  1 failed | 11 passed (12)`, and the one failure was this case:
    //
    //   gateway `.env.example` URL -> 9999          expected '9999' to be '3005'
    //   compose published port -> "9999:3005"       expected '9999' to be '3005'
    //   compose gateway URL -> 9999                 expected '9999' to be '3005'
    //   analytics `.env.example` PORT -> 9999       expected '9999' to be '3005'
    //   `startup.constants.ts` DEFAULT_PORT -> 9999 expected '3005' to be '9999'
    //   a second compose consumer block added       expected [Array(2)] to have a length of 1
    //   analytics `.env.example` PORT line deleted  Expected exactly one PORT= line ...; found 0
    //
    // The fifth row is the one worth reading twice. With the startup constant at 9999 the case
    // above (`defaults PORT to the port index.ts binds`) stayed **green** -- its parsed default
    // derives from that same constant and so does `ANALYTICS_RUNTIME.DEFAULT_PORT`, so both of
    // its assertions compared 9999 with 9999. That is billing's Gate-5 measurement reproduced on
    // this service, and it is why AC2 is documented above as toothless. The last row is the
    // throwing locator doing its job rather than passing on an empty match set.
    //
    // Scope: seven single-artifact mutations against this one suite on this tree. It shows each
    // pinned site is reachable by the assertions; it is not a claim that every possible
    // reformatting of these artifacts reddens.
    //
    // Deliberately **not** pinned, so the next reader does not rediscover it: the same number
    // is written at `apps/analytics-service/tests/setup.ts` and at
    // `apps/gateway/tests/env.schema.unit.test.ts`. Those are test fixtures rather than deploy
    // artifacts, no statically spelled read of the parsed `env.PORT` was found under
    // `apps/<service>/src` or `packages/<pkg>/src`, and analytics' smoke test listens on port
    // 0 except in `SMOKE_TARGET=external` mode. Mutating either breaks no deployment, which is
    // the line this case draws -- billing drew the same one at T-044. The occurrences under
    // `docs/epics` are prose and are out of scope for the same reason.
    //
    // That `env.PORT` clause is deliberately the measured form and not "nothing reads it" --
    // the same strength `src/config/env.ts:7` and S-55 finding 3 carry -- because it is the
    // whole justification for leaving those two fixtures unpinned, so it has to be true rather
    // than merely likely. Re-derived at the Gate-3 rework with
    // `grep -rn --include='*.ts' -E 'env\.PORT|\.PORT\b'` over the two roots (13 directories
    // on this tree, `apps/web/src` among them), `dist` filtered: 12 lines, none of them a read
    // of the parsed value. Six are the `process.env.PORT ?? <SERVICE>_STARTUP.DEFAULT_PORT`
    // binds, one per service `index.ts`, and six are comment lines documenting this deadness,
    // two each in analytics', billing's and worker's `config/env.ts`. Count the binds: the
    // comment half moves whenever one of those three docblocks is edited, which is how this
    // figure went 10 -> 12 inside T-050's own commit (S-33). This file sits outside both roots,
    // and the note you are reading added matching lines to it without moving the figure: the
    // roots grep returned 12 before this rework's edit and 12 after, while `grep -cE` on this
    // file alone went 5 -> 8. The bracket-index spelling -- `env["PORT"]` and its single-quoted
    // form -- is absent over the same roots, and that pattern was run against a positive
    // control first, so the empty result is a real negative rather than a broken regex.
    // What none of it excludes: a computed property name, a spread of the whole `env` object
    // into something that later indexes it, or a read from outside those two roots.
    it("pins DEFAULT_PORT to the port every deploy artifact publishes", () => {
      const expectedPort = String(ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT);
      const envExample = readFileSync(ANALYTICS_ENV_EXAMPLE_URL, "utf8");
      const gatewayEnvExample = readFileSync(GATEWAY_ENV_EXAMPLE_URL, "utf8");
      const compose = readFileSync(DOCKER_COMPOSE_URL, "utf8");
      const analyticsBlock = extractComposeServiceBlock(compose, COMPOSE_ANALYTICS_SERVICE_KEY);

      const [, envExamplePort] = extractSoleMatch(
        envExample,
        /^PORT=(\d+)$/gm,
        "PORT= line in apps/analytics-service/.env.example"
      );
      const [, composeEnvPort] = extractSoleMatch(
        analyticsBlock,
        /^ +PORT: "(\d+)"$/gm,
        'PORT: "..." entry in docker-compose.yml analytics-service environment'
      );
      const [, publishedPort, containerPort] = extractSoleMatch(
        analyticsBlock,
        /^ +- "(\d+):(\d+)"$/gm,
        "published port mapping in docker-compose.yml analytics-service ports"
      );
      const composeUpstreamPorts = COMPOSE_ANALYTICS_CONSUMER_SERVICE_KEYS.map((serviceKey) => {
        const [, port] = extractSoleMatch(
          extractComposeServiceBlock(compose, serviceKey),
          /^ +ANALYTICS_SERVICE_URL: https?:\/\/[^:/\s]+:(\d+)$/gm,
          `ANALYTICS_SERVICE_URL in docker-compose.yml ${serviceKey} environment`
        );

        return port;
      });
      // Host-agnostic where compose's is not: compose addresses analytics by its service name
      // and this file by `localhost`, and only the port is this case's business. Gateway's
      // `.env.example` holds exactly one `ANALYTICS_SERVICE_URL` and exactly one `3005`
      // (checked with `grep -c`), so unlike compose -- where `PORT: "` appears in every service
      // block -- it needs no block scoping.
      const [, gatewayEnvExamplePort] = extractSoleMatch(
        gatewayEnvExample,
        /^ANALYTICS_SERVICE_URL=https?:\/\/[^:/\s]+:(\d+)$/gm,
        "ANALYTICS_SERVICE_URL line in apps/gateway/.env.example"
      );

      expect(envExamplePort).toBe(expectedPort);
      expect(composeEnvPort).toBe(expectedPort);
      expect(containerPort).toBe(expectedPort);
      expect(publishedPort).toBe(expectedPort);
      for (const upstreamPort of composeUpstreamPorts) {
        expect(upstreamPort).toBe(expectedPort);
      }
      expect(gatewayEnvExamplePort).toBe(expectedPort);
      // AC3b -- exhaustiveness, which the per-block loop above does not give. That loop checks
      // only the services named in `COMPOSE_ANALYTICS_CONSUMER_SERVICE_KEYS`; a *second*
      // consumer added to compose with a wrong port would satisfy every assertion above. This
      // line reddens instead, so adding a consumer without adding it to the constant cannot
      // pass silently.
      expect(compose.match(/^ +ANALYTICS_SERVICE_URL:/gm) ?? []).toHaveLength(
        COMPOSE_ANALYTICS_CONSUMER_SERVICE_KEYS.length
      );
    });

    // AC4. Green from the start -- `z.coerce` has always done this; it had no coverage.
    it("coerces a numeric PORT", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        PORT: String(ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT)
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.PORT).toBe(ANALYTICS_SERVICE_STARTUP.DEFAULT_PORT);
        expect(typeof parsed.data.PORT).toBe("number");
      }
    });

    // AC4. Green from the start. Each value is asserted to raise an issue **on PORT**, not
    // merely to fail, so a fixture that broke for an unrelated reason would not satisfy it.
    it("rejects a PORT that is not a positive integer", () => {
      for (const invalidPort of Object.values(INVALID_PORT_VALUES)) {
        expectIssueOn(EnvSchema.safeParse({ ...buildBaseEnv(), PORT: invalidPort }), "PORT");
      }
    });

    // AC7. Green from the start -- regression guards for the three fields with no default.
    it("rejects an env with no DATABASE_URL", () => {
      expectIssueOn(EnvSchema.safeParse(buildEnvWithout("DATABASE_URL")), "DATABASE_URL");
    });

    // AC7
    it("rejects an env with no REDIS_URL", () => {
      expectIssueOn(EnvSchema.safeParse(buildEnvWithout("REDIS_URL")), "REDIS_URL");
    });

    // AC7
    it("rejects an env with no OTEL_EXPORTER_OTLP_ENDPOINT", () => {
      expectIssueOn(
        EnvSchema.safeParse(buildEnvWithout("OTEL_EXPORTER_OTLP_ENDPOINT")),
        "OTEL_EXPORTER_OTLP_ENDPOINT"
      );
    });
  });

  describe("runtime mode and logging configuration", () => {
    // AC5. Green from the start.
    it("defaults NODE_ENV to development", () => {
      const parsed = EnvSchema.safeParse(buildEnvWithout("NODE_ENV"));

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.NODE_ENV).toBe(DEFAULT_NODE_ENV);
      }
    });

    // AC5. Green from the start.
    it("rejects an unknown NODE_ENV", () => {
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), NODE_ENV: UNKNOWN_NODE_ENV }),
        "NODE_ENV"
      );
    });

    // AC6. Green from the start.
    it("defaults LOG_LEVEL to info", () => {
      const parsed = EnvSchema.safeParse(buildEnvWithout("LOG_LEVEL"));

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.LOG_LEVEL).toBe(DEFAULT_LOG_LEVEL);
      }
    });
  });

  describe("schema shape", () => {
    // AC8 / AU2. Green from the start at T-050 with six names; **red at S-9's Gate 3** with the
    // seventh, which is the point of a census. Order is asserted as well as membership because
    // the epic's snippet declares the first six in this order and a reordering is the cheapest
    // way for a reviewer's diff of the two to stop being readable. `INTERNAL_API_SECRET` is
    // appended rather than inserted, matching its position in `src/config/env.ts` and the three
    // other services that declare it last.
    //
    // The S-51 limit noted on `EXPECTED_ENV_FIELDS` applies with full force here: this case
    // notified that the set changed and said nothing about whether the new field is sound. What
    // vets the field is the identity assertion below, not this line.
    it("declares exactly the seven documented fields", () => {
      expect(Object.keys(EnvSchema.shape)).toEqual([...EXPECTED_ENV_FIELDS]);
    });
  });

  /**
   * S-9 slice 1. Until this task analytics-service was the only one of the six services with no
   * `INTERNAL_API_SECRET` at all -- `grep -n "INTERNAL_API_SECRET" apps/analytics-service/src/config/env.ts`
   * returned nothing on `1220051`, while gateway, usage, billing and worker all declared it.
   *
   * **Every case in this block was red before the field existed**, measured at Gate 3 by running
   * this file against the unchanged `src/config/env.ts`: `Tests 8 failed | 11 passed (19)` -- the
   * seven here plus `declares exactly the seven documented fields` above. Each failed for the
   * reason that matters rather than incidentally: an undeclared key is *stripped* by `z.object`,
   * so all four rejection cases parsed successfully, the identity case compared `undefined`
   * against the fragment, the module-load case resolved instead of rejecting, and its control
   * read `undefined`.
   */
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

    // AU1 -- the strongest single assertion in this file, and the one that transfers the
    // fragment's whole input table to this service by construction. It is what stops analytics
    // becoming a fifth strictness: repointing this declaration at a locally written
    // `z.string().trim().min(32).regex(...)` reddens this line **even with an identical
    // spelling**, because it compares object identity rather than behaviour. The other four
    // services that declare the field assert exactly this (`apps/gateway/tests/env.schema.unit.test.ts`,
    // `apps/usage-service/tests/env.schema.unit.test.ts`,
    // `apps/billing-service/tests/env.schema.unit.test.ts`,
    // `apps/worker-service/tests/env.schema.unit.test.ts`), so analytics is the fifth.
    //
    // What it does not establish: that the fragment's rule is *right*. That is asserted once,
    // against the fragment, in `packages/shared-validation/tests/unit.test.ts`.
    it("declares INTERNAL_API_SECRET as internalApiSecretSchema itself", () => {
      expect(EnvSchema.shape.INTERNAL_API_SECRET).toBe(internalApiSecretSchema);
    });

    // AU3. The field has no default, so an env without it does not parse and the service does
    // not start -- which is the direction §9 R1 of the plan calls loud and cheap to fix.
    it("rejects an env with no INTERNAL_API_SECRET", () => {
      expectIssueOn(
        EnvSchema.safeParse(buildEnvWithout("INTERNAL_API_SECRET")),
        "INTERNAL_API_SECRET"
      );
    });

    // AU4. The boundary comes from the shared constant, never written as 32, so a change to
    // `INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH` moves this case with the schema.
    it("rejects an INTERNAL_API_SECRET one character below the shared minimum", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          INTERNAL_API_SECRET: "x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1)
        }),
        "INTERNAL_API_SECRET"
      );
    });

    // AU5. The case that distinguishes the fragment's `.trim().min(...)` order from both of its
    // neighbours: `.min(32)` alone parses 32 spaces verbatim, `.min(32).trim()` parses them to
    // `""`, and only `.trim().min(32)` raises an issue. Analytics does not own that order -- the
    // fragment does -- but this is the end-to-end proof that the whole-object parse reaches it.
    it("rejects an all-whitespace INTERNAL_API_SECRET at the minimum length", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          INTERNAL_API_SECRET: " ".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)
        }),
        "INTERNAL_API_SECRET"
      );
    });

    // AU6. The printable-ASCII rule, the part `.trim().min(...)` never gave: `.trim()` strips the
    // ECMAScript WhiteSpace + LineTerminator set and nothing else, so a secret of invisible `Cf`
    // characters used to parse cleanly and authenticate. The first assertion is a self-check on
    // the boundary, so the rejection below cannot become a tautology by pointing at a code point
    // the pattern happens to accept.
    it("rejects an INTERNAL_API_SECRET carrying a character just outside printable ASCII", () => {
      expect(
        INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN.test(String.fromCharCode(PRINTABLE_ASCII_RANGE_END))
      ).toBe(true);
      expect(INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN.test(JUST_ABOVE_PRINTABLE_ASCII)).toBe(false);

      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          INTERNAL_API_SECRET: `${VALID_INTERNAL_API_SECRET}${JUST_ABOVE_PRINTABLE_ASCII}`
        }),
        "INTERNAL_API_SECRET"
      );
    });

    // AU24 -- **not in the plan's §7 table**, added at Gate 3 because that table's AC1 row says
    // the four cases above refuse a bad secret "at module load" and they do not: they call
    // `safeParse` directly. This is the one that drives `parseEnv` through a real import, which
    // is what makes "a misconfigured analytics-service never reaches `app.listen`" a measured
    // statement rather than a reading of the source. Billing's suite carries the same pair.
    it("fails fast at module load when INTERNAL_API_SECRET is absent", async () => {
      vi.resetModules();
      delete process.env.INTERNAL_API_SECRET;

      await expect(import("../src/config/env")).rejects.toThrow(/INTERNAL_API_SECRET/);
    });

    // AU24, second half. The control: without it, a module that threw for any reason at all --
    // or one whose import was simply broken -- would satisfy the case above.
    it("loads at module load when INTERNAL_API_SECRET is present", async () => {
      vi.resetModules();
      process.env.INTERNAL_API_SECRET = VALID_INTERNAL_API_SECRET;

      const loaded = (await import("../src/config/env")) as { env: { INTERNAL_API_SECRET: string } };

      expect(loaded.env.INTERNAL_API_SECRET).toBe(VALID_INTERNAL_API_SECRET);
    });
  });
});
