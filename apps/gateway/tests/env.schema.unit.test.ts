import { describe, expect, it } from "vitest";
import { INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
import { internalApiSecretSchema } from "@telemetry/shared-validation";
import { EnvSchema } from "../src/config/env";

/**
 * gateway's env schema, and specifically its `INTERNAL_API_SECRET` declaration (S-8).
 *
 * **This file is new because gateway had no env suite at all.** It is one of the four services
 * that declare `INTERNAL_API_SECRET`, and it is the one that *sends* the header rather than
 * checking it -- `docs/reviewer-checklist.md` is explicit that gateway is the caller, which is
 * why it has a schema and no `internal-auth.middleware.ts`. Being the sender is exactly why its
 * declaration could not be left the unpinned one: the value gateway parses is the value every
 * upstream receives, so a rule gateway applies more loosely than its upstreams is a
 * platform-wide authentication split rather than a local leniency.
 *
 * That split was live before this change, and was measured rather than argued. gateway and
 * usage-service declared the field as a bare `.min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)`;
 * worker-service and billing-service declared it as `.trim().min(...)`. Both HTTP clients in this
 * stack strip leading and trailing SP/HTAB from an outbound header value in transit, so with one
 * stray space in a platform-wide `INTERNAL_API_SECRET` gateway forwarded the padded value, the
 * receiving parser stripped it, and the two trimming services matched while usage-service did
 * not. Re-derived over a real socket against the real guard factories:
 *
 *     gateway sends padded -> usage   (untrimmed expected): 401
 *     gateway sends padded -> billing (trimmed   expected): 200
 *
 * with an unpadded secret answering 200 to both.
 *
 * Unlike the other three services, gateway parses **lazily** -- `loadEnv()` in
 * `src/config/env.ts` rather than a module-load `parseEnv`. So these cases need no module-reload
 * dance, and this package still needs no `tests/setup.ts`.
 */

const VALID_INTERNAL_API_SECRET = "s-008-gateway-internal-secret-at-least-32-chars";
const VALID_JWT_SECRET = "s-008-gateway-jwt-secret-at-least-32-chars";

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

const buildBaseEnv = (): Record<string, string> => ({
  NODE_ENV: "test",
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "silent",
  JWT_SECRET: VALID_JWT_SECRET,
  INTERNAL_API_SECRET: VALID_INTERNAL_API_SECRET,
  AUTH_SERVICE_URL: "http://localhost:3001",
  USAGE_SERVICE_URL: "http://localhost:3002",
  BILLING_SERVICE_URL: "http://localhost:3004",
  ANALYTICS_SERVICE_URL: "http://localhost:3005"
});

/**
 * Throws rather than returning the fixture unchanged when the key is already absent: a helper
 * that silently no-ops turns "rejects an env with no X" into "accepts the base env", which passes
 * for the wrong reason (`.claude/rules/testing.md`). Copied in shape from billing's suite.
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

describe("gateway env schema", () => {
  // The control. Without it every rejection case below could be passing because the fixture is
  // malformed for an unrelated reason rather than because of the field under test.
  it("accepts the base env", () => {
    expect(EnvSchema.safeParse(buildBaseEnv()).success).toBe(true);
  });

  // Self-check on the boundary constant above, so the derivation cannot quietly point at a code
  // point the pattern accepts and turn every rejection case below into a tautology.
  it("pins the printable-ASCII boundary the rejection cases are built from", () => {
    expect(
      INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN.test(
        String.fromCharCode(PRINTABLE_ASCII_RANGE_END)
      )
    ).toBe(true);
    expect(INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN.test(JUST_ABOVE_PRINTABLE_ASCII)).toBe(false);
  });

  describe("INTERNAL_API_SECRET derives from the shared fragment", () => {
    // The strongest single assertion here, and the one that transfers the fragment's whole input
    // table to this service by construction. Repointing this declaration back to
    // `z.string().min(...)` -- the exact pre-S-8 defect -- reddens this line.
    it("declares INTERNAL_API_SECRET as internalApiSecretSchema itself", () => {
      expect(EnvSchema.shape.INTERNAL_API_SECRET).toBe(internalApiSecretSchema);
    });

    it("rejects an env with no INTERNAL_API_SECRET", () => {
      expectIssueOn(
        EnvSchema.safeParse(buildEnvWithout("INTERNAL_API_SECRET")),
        "INTERNAL_API_SECRET"
      );
    });

    it("rejects an INTERNAL_API_SECRET one character below the shared minimum", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          INTERNAL_API_SECRET: "x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1)
        }),
        "INTERNAL_API_SECRET"
      );
    });

    it("rejects an empty INTERNAL_API_SECRET", () => {
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: "" }),
        "INTERNAL_API_SECRET"
      );
    });

    it("rejects an INTERNAL_API_SECRET carrying a character just outside printable ASCII", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          INTERNAL_API_SECRET: `${VALID_INTERNAL_API_SECRET}${JUST_ABOVE_PRINTABLE_ASCII}`
        }),
        "INTERNAL_API_SECRET"
      );
    });

    // The two values gateway accepted before S-8. `.min()` measures the padded length, so 32
    // spaces parsed to 32 spaces and a 31-character core padded to 35 parsed to 35 -- and the
    // padded value is what gateway then put on the wire.
    it("rejects an all-whitespace INTERNAL_API_SECRET at the minimum length", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          INTERNAL_API_SECRET: " ".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)
        }),
        "INTERNAL_API_SECRET"
      );
    });

    it("rejects an INTERNAL_API_SECRET that reaches the minimum only by its padding", () => {
      const paddedShortSecret = `  ${"x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1)}  `;

      expect(paddedShortSecret.length).toBeGreaterThan(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: paddedShortSecret }),
        "INTERNAL_API_SECRET"
      );
    });

    // Asserted on the schema's output, not through a request: the receiving HTTP parser strips
    // edge SP and HTAB itself, so a padded value observed arriving stripped would prove nothing
    // about the schema. This is the transform gateway applies *before* forwarding.
    it("strips surrounding whitespace from an otherwise valid INTERNAL_API_SECRET", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INTERNAL_API_SECRET: `  ${VALID_INTERNAL_API_SECRET}\t`
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.INTERNAL_API_SECRET).toBe(VALID_INTERNAL_API_SECRET);
      }
    });

    it("accepts an INTERNAL_API_SECRET exactly at the shared minimum length", () => {
      const atMinimum = "x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);
      const parsed = EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: atMinimum });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.INTERNAL_API_SECRET).toBe(atMinimum);
      }
    });

    // The non-obvious half of the rule: U+0020 is *inside* `SECRET_PATTERN`, and the pattern runs
    // after the trim, so edge whitespace goes and internal spaces stay. Measured transmissible and
    // uncollapsed over a real socket, so a passphrase-style secret is deployable.
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
