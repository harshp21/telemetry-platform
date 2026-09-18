import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
import { internalApiSecretSchema } from "@telemetry/shared-validation";
import { EnvSchema } from "../src/config/env";


/**
 * One code point above the top of `INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN`'s range.
 *
 * Chosen as a *boundary* rather than picked from deep inside the rejected space: a pattern that
 * was accidentally one character too wide would still reject U+200B, and this case would pass
 * while the rule it guards was wrong. The exhaustive character-class table -- U+001F, U+007F,
 * U+00AD, U+200B, U+0085, U+034F -- lives once, in
 * `packages/shared-validation/tests/unit.test.ts`, against the fragment itself; what each service
 * asserts is that its own field **is** that fragment, plus this one end-to-end rejection proving
 * the field is reached through the whole-object parse.
 */
const PRINTABLE_ASCII_RANGE_END = 0x7e;
const JUST_ABOVE_PRINTABLE_ASCII = String.fromCharCode(PRINTABLE_ASCII_RANGE_END + 1);

const VALID_INTERNAL_API_SECRET = "s-004-base-internal-secret-at-least-32-chars";

const buildBaseEnv = (): Record<string, string> => ({
  NODE_ENV: "test",
  PORT: "3000",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/telemetry",
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "silent",
  INTERNAL_API_SECRET: VALID_INTERNAL_API_SECRET
});

describe("usage service env schema", () => {
  describe("redis stream configuration", () => {
    it("loads REDIS_STREAM_NAME with default 'telemetry:events'", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_STREAM_NAME).toBe("telemetry:events");
      }
    });

    it("loads REDIS_STREAM_NAME from env var override", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        REDIS_STREAM_NAME: "custom:stream:name"
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_STREAM_NAME).toBe("custom:stream:name");
      }
    });

    it("loads STREAM_MAX_LEN as positive integer with default 100,000", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.STREAM_MAX_LEN).toBe(100_000);
      }
    });

    it("coerces STREAM_MAX_LEN from string to number", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        STREAM_MAX_LEN: "50000"
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.STREAM_MAX_LEN).toBe(50_000);
        expect(typeof parsed.data.STREAM_MAX_LEN).toBe("number");
      }
    });

    it("rejects STREAM_MAX_LEN <= 0", () => {
      // Test with 0
      const parsedZero = EnvSchema.safeParse({
        ...buildBaseEnv(),
        STREAM_MAX_LEN: "0"
      });

      expect(parsedZero.success).toBe(false);

      // Test with negative
      const parsedNegative = EnvSchema.safeParse({
        ...buildBaseEnv(),
        STREAM_MAX_LEN: "-100"
      });

      expect(parsedNegative.success).toBe(false);
    });

    it("loads INGEST_BATCH_MAX with default 100", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.INGEST_BATCH_MAX).toBe(100);
      }
    });

    it("rejects INGEST_BATCH_MAX < 1 or > 100", () => {
      // Test with 0
      const parsedZero = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INGEST_BATCH_MAX: "0"
      });

      expect(parsedZero.success).toBe(false);

      // Test with > 100
      const parsedAboveMax = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INGEST_BATCH_MAX: "101"
      });

      expect(parsedAboveMax.success).toBe(false);
    });

    it("accepts INGEST_BATCH_MAX at boundaries (1 and 100)", () => {
      // Test with 1 (minimum)
      const parsedMin = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INGEST_BATCH_MAX: "1"
      });

      expect(parsedMin.success).toBe(true);

      if (parsedMin.success) {
        expect(parsedMin.data.INGEST_BATCH_MAX).toBe(1);
      }

      // Test with 100 (maximum)
      const parsedMax = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INGEST_BATCH_MAX: "100"
      });

      expect(parsedMax.success).toBe(true);

      if (parsedMax.success) {
        expect(parsedMax.data.INGEST_BATCH_MAX).toBe(100);
      }
    });
  });

  // S-4: docs/reviewer-checklist.md section 3 requires a service with internal-only routes to
  // fail fast when INTERNAL_API_SECRET is missing. `parseEnv` throws at module load, so the
  // process never reaches `app.listen`.
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

    it("rejects an env with no INTERNAL_API_SECRET", () => {
      const { INTERNAL_API_SECRET: _omitted, ...withoutSecret } = buildBaseEnv();
      void _omitted;

      const parsed = EnvSchema.safeParse(withoutSecret);

      expect(parsed.success).toBe(false);

      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.path[0] === "INTERNAL_API_SECRET")).toBe(
          true
        );
      }
    });

    it("rejects an INTERNAL_API_SECRET shorter than the shared minimum", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INTERNAL_API_SECRET: "x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1)
      });

      expect(parsed.success).toBe(false);
    });

    it("rejects an empty INTERNAL_API_SECRET", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INTERNAL_API_SECRET: ""
      });

      expect(parsed.success).toBe(false);
    });

    it("accepts an INTERNAL_API_SECRET exactly at the shared minimum length", () => {
      const atMinimum = "x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INTERNAL_API_SECRET: atMinimum
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.INTERNAL_API_SECRET).toBe(atMinimum);
      }
    });

    it("fails fast at module load when INTERNAL_API_SECRET is absent", async () => {
      vi.resetModules();
      delete process.env.INTERNAL_API_SECRET;

      await expect(import("../src/config/env")).rejects.toThrow(/INTERNAL_API_SECRET/);
    });

    it("loads at module load when INTERNAL_API_SECRET is present", async () => {
      vi.resetModules();
      process.env.INTERNAL_API_SECRET = VALID_INTERNAL_API_SECRET;

      const loaded = (await import("../src/config/env")) as { env: { INTERNAL_API_SECRET: string } };

      expect(loaded.env.INTERNAL_API_SECRET).toBe(VALID_INTERNAL_API_SECRET);
    });
  });

  // S-8. usage-service and gateway declared this field as a bare
  // `.min(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)` while worker-service and billing-service
  // declared it as `.trim().min(...)`. That is not a style difference: both HTTP clients in this
  // stack strip leading and trailing SP/HTAB from a header value in transit, so one stray space
  // in a platform-wide `INTERNAL_API_SECRET` made the two trimming services answer `200` and this
  // one answer `401` for the same configuration -- ingestion down, billing up, nothing in the
  // logs naming it. Re-derived end-to-end over a real socket against the real guard factories
  // before this change was written:
  //   gateway sends padded -> usage   (untrimmed expected): 401
  //   gateway sends padded -> billing (trimmed   expected): 200
  // with an unpadded secret giving 200 to both.
  //
  // All four services now derive the field from one fragment, so the cases below are mostly
  // *derivation* rather than behaviour: the behaviour table lives once, beside the fragment.
  describe("INTERNAL_API_SECRET derives from the shared fragment", () => {
    // The strongest single assertion in this block, and the one that transfers the fragment's
    // whole input table here by construction. Repointing this service's declaration back to
    // `z.string().min(...)` -- the exact pre-S-8 defect -- reddens this line, because the shape
    // no longer holds the shared object.
    it("declares INTERNAL_API_SECRET as internalApiSecretSchema itself", () => {
      expect(EnvSchema.shape.INTERNAL_API_SECRET).toBe(internalApiSecretSchema);
    });

    // Self-check on the boundary constant, so the derivation cannot quietly point at a code point
    // the pattern accepts and turn the rejection cases below into tautologies.
    it("pins the printable-ASCII boundary the rejection cases are built from", () => {
      expect(
        INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN.test(String.fromCharCode(PRINTABLE_ASCII_RANGE_END))
      ).toBe(true);
      expect(INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN.test(JUST_ABOVE_PRINTABLE_ASCII)).toBe(false);
    });

    it("rejects an INTERNAL_API_SECRET carrying a character just outside printable ASCII", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INTERNAL_API_SECRET: `${VALID_INTERNAL_API_SECRET}${JUST_ABOVE_PRINTABLE_ASCII}`
      });

      expect(parsed.success).toBe(false);

      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) => issue.path[0] === "INTERNAL_API_SECRET")
        ).toBe(true);
      }
    });

    // The two values this service accepted before S-8. `.min()` measures the padded length, so
    // 32 spaces parsed to 32 spaces and a 31-character core padded to 35 parsed to 35.
    it("rejects an all-whitespace INTERNAL_API_SECRET at the minimum length", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        INTERNAL_API_SECRET: " ".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH)
      });

      expect(parsed.success).toBe(false);
    });

    it("rejects an INTERNAL_API_SECRET that reaches the minimum only by its padding", () => {
      const paddedShortSecret = `  ${"x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1)}  `;

      expect(paddedShortSecret.length).toBeGreaterThan(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);
      expect(
        EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: paddedShortSecret }).success
      ).toBe(false);
    });

    // `.trim()` transforms the parsed value, and that value is what the guard compares against
    // the inbound header. Asserted on the schema's output rather than through `app.inject`, which
    // bypasses the HTTP parser and does not strip.
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

    // The non-obvious half of the rule: U+0020 is *inside* `SECRET_PATTERN` and the pattern is
    // applied after the trim, so edge whitespace goes and internal spaces stay. A passphrase-style
    // secret keeps working -- and internal spaces were measured transmissible and uncollapsed over
    // a real socket, so this is a shape an operator can actually deploy.
    it("accepts an INTERNAL_API_SECRET with internal spaces", () => {
      const passphrase = `${VALID_INTERNAL_API_SECRET.slice(0, 20)} ${VALID_INTERNAL_API_SECRET.slice(20)}`;

      expect(passphrase.length).toBeGreaterThan(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);

      const parsed = EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: passphrase });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.INTERNAL_API_SECRET).toBe(passphrase);
      }
    });

    // No env suite in this repository asserted a zod *rejection message* before S-8 -- the shared
    // `expectIssueOn` helpers check only `success === false` and the issue path. That blindness is
    // why the check order was invisible: `.trim().min().regex()` and `.trim().regex().min()` agree
    // on every verdict and disagree only on which message an all-whitespace secret produces. This
    // case pins the order by asserting the *class* of two rejections, so a reordering that keeps
    // the verdicts reddens here. It lives in this suite rather than in all four because the
    // ordering is a property of the one fragment.
    it("distinguishes the length rejection from the printable-ASCII rejection by message", () => {
      const messageFor = (secret: string): string => {
        const parsed = EnvSchema.safeParse({ ...buildBaseEnv(), INTERNAL_API_SECRET: secret });

        if (parsed.success) {
          throw new Error(
            `Expected ${JSON.stringify(secret)} to be rejected, but the env parsed cleanly.`
          );
        }

        const issue = parsed.error.issues.find((candidate) => candidate.path[0] === "INTERNAL_API_SECRET");

        if (issue === undefined) {
          throw new Error(
            "The parse failed but reported no INTERNAL_API_SECRET issue; the locator is looking at the wrong field."
          );
        }

        return issue.message;
      };

      const lengthMessage = messageFor("x".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1));
      const patternMessage = messageFor(
        `${VALID_INTERNAL_API_SECRET}${JUST_ABOVE_PRINTABLE_ASCII}`
      );

      // An all-whitespace secret is rejected by the *length* rule, not the pattern rule. That is
      // the chosen order, and it is what preserves the message this service already produced.
      expect(messageFor(" ".repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH))).toBe(lengthMessage);
      expect(patternMessage).toBe(INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN_MESSAGE);
      expect(patternMessage).not.toBe(lengthMessage);
    });
  });
});
