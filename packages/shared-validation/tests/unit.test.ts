import { describe, expect, it } from "vitest";
import { INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
import {
  dateRangeSchema,
  eventTypeSchema,
  internalApiSecretSchema,
  paginationSchema,
  TelemetryEventEnvelopeSchema,
  tenantIdSchema,
  UsageEventsBatchSchema
} from "../src/index";

/**
 * Characters that `String.prototype.trim()` does **not** strip, named rather than written inline
 * so the cases read as classes instead of as escape sequences. Each was measured against
 * `z.string().trim().min(SECRET_MIN_LENGTH)` -- the declaration all four services carried before
 * this fragment existed, or in usage-service's and gateway's case an even weaker one -- and each
 * was **accepted** there as a 32-character secret. That is the hole `SECRET_PATTERN` closes.
 *
 * They are not one Unicode category: U+00AD and U+200B are `Cf`, U+0085 is `Cc`, U+034F is `Mn`.
 * `trim()` strips the ECMAScript `WhiteSpace` + `LineTerminator` set and nothing else, whatever
 * category the remainder falls in -- which is why "not made of invisible characters" is not a
 * property the trim gives and has to be stated as a pattern instead.
 */
const SOFT_HYPHEN = "\u00AD";
const ZERO_WIDTH_SPACE = "\u200B";
const NEXT_LINE = "\u0085";
const COMBINING_GRAPHEME_JOINER = "\u034F";

/** The two ends of the accepted range, so the boundary is asserted rather than assumed. */
const LOWEST_PRINTABLE_ASCII = "\u0020";
const HIGHEST_PRINTABLE_ASCII = "\u007E";

/**
 * The two code points immediately outside that range -- US (U+001F) below and DEL (U+007F)
 * above. These are the inputs that separate the shipped pattern from one that is a single
 * character too wide at either end, which the `Cf`/`Cc` cases above would not notice.
 */
const JUST_BELOW_PRINTABLE_ASCII = "\u001F";
const JUST_ABOVE_PRINTABLE_ASCII = "\u007F";

/** A printable-ASCII filler with no whitespace in it, for building values of a chosen length. */
const FILLER = "x";

const repeatToMinimum = (unit: string): string =>
  unit.repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);

/**
 * The message zod itself produces for the length rule, read from a value that can only fail that
 * rule. Captured rather than written out: hard-coding zod's wording would make these cases fail
 * on a zod upgrade that reworded it, and the property under test is *which rule rejected the
 * value*, not how zod phrases it.
 *
 * Throws rather than returning a placeholder if the control value is somehow accepted -- a helper
 * that yields a string nothing can match would turn the ordering cases below into assertions that
 * pass for the wrong reason (`.claude/rules/testing.md`).
 */
const lengthRuleMessage = (): string => {
  const tooShort = FILLER.repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1);
  const parsed = internalApiSecretSchema.safeParse(tooShort);

  if (parsed.success) {
    throw new Error(
      `A ${tooShort.length}-character printable-ASCII secret was accepted; the length rule is not being reached, so these cases cannot tell the two rules apart.`
    );
  }

  const [firstIssue] = parsed.error.issues;

  if (firstIssue === undefined) {
    throw new Error("A failed parse reported no issues; the control cannot supply a message.");
  }

  return firstIssue.message;
};

const firstIssueMessage = (value: string): string => {
  const parsed = internalApiSecretSchema.safeParse(value);

  if (parsed.success) {
    throw new Error(`Expected ${JSON.stringify(value)} to be rejected, but it parsed.`);
  }

  const [firstIssue] = parsed.error.issues;

  if (firstIssue === undefined) {
    throw new Error("A failed parse reported no issues.");
  }

  return firstIssue.message;
};

describe("shared-validation schemas", () => {
  const baseEnvelope = {
    eventId: "f29f20c2-c0ba-41fc-8e84-b6e11318dbaa",
    tenantId: "0f1b6f57-8a59-4ee6-9293-e1e6df7bf444",
    occurredAt: "2026-01-01T00:00:00Z",
    receivedAt: "2026-01-01T00:00:01Z",
    source: "sdk-web",
    idempotencyKey: "idem_1",
    version: 1
  };

  it("coerces pagination query strings", () => {
    const parsed = paginationSchema.parse({ page: "2", pageSize: "25" });

    expect(parsed).toEqual({ page: 2, pageSize: 25 });
  });

  it("rejects date ranges where from is not earlier than to", () => {
    const parsed = dateRangeSchema.safeParse({
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-01T00:00:00Z"
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts valid date range when from is earlier than to", () => {
    const parsed = dateRangeSchema.safeParse({
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z"
    });

    expect(parsed.success).toBe(true);
  });

  it("validates event type naming convention", () => {
    expect(eventTypeSchema.safeParse("billing.invoice_generated").success).toBe(true);
    expect(eventTypeSchema.safeParse("Bad Event Type").success).toBe(false);
  });

  it("validates tenant IDs as UUID", () => {
    expect(tenantIdSchema.safeParse("0f1b6f57-8a59-4ee6-9293-e1e6df7bf444").success).toBe(true);
    expect(tenantIdSchema.safeParse("tenant_1").success).toBe(false);
  });

  it("accepts a valid telemetry event envelope", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      eventType: "api.request",
      payload: {
        quantity: 42,
        unit: "request",
        occurredAt: "2026-01-01T00:00:00Z"
      }
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts a valid billing.invoice_generated event envelope", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      eventType: "billing.invoice_generated",
      source: "billing-service",
      payload: {
        invoiceId: "inv_123",
        amountCents: 1500,
        currency: "USD",
        periodStart: "2026-01-01T00:00:00Z",
        periodEnd: "2026-02-01T00:00:00Z"
      }
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects known mapped event type with invalid payload shape", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      eventType: "billing.invoice_generated",
      source: "billing-service",
      payload: {
        invoiceId: "inv_123",
        amountCents: -1,
        currency: "usd",
        periodStart: "2026-01-01T00:00:00Z",
        periodEnd: "2026-02-01T00:00:00Z"
      }
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects batch payload without events", () => {
    const parsed = UsageEventsBatchSchema.safeParse({ events: [] });

    expect(parsed.success).toBe(false);
  });

  it("rejects batch payload over max event count", () => {
    const event = {
      ...baseEnvelope,
      eventType: "unknown.event",
      payload: { key: "value" }
    };

    const parsed = UsageEventsBatchSchema.safeParse({
      events: Array.from({ length: 101 }, () => event)
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects event payload over 10KB", () => {
    const parsed = UsageEventsBatchSchema.safeParse({
      events: [
        {
          ...baseEnvelope,
          eventType: "unknown.event",
          payload: {
            oversized: "x".repeat(11 * 1024)
          }
        }
      ]
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts unknown event type with generic JSON payload", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      eventType: "custom.event",
      payload: {
        nested: {
          count: 2,
          labels: ["a", "b"],
          nullable: null
        }
      }
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects known event type when routed through generic event branch", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      eventType: "api.request",
      payload: {
        nested: true
      }
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects non-finite numbers in generic JSON payload", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      eventType: "custom.event",
      payload: {
        value: Number.POSITIVE_INFINITY
      }
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects event with missing required fields", () => {
    const parsed = TelemetryEventEnvelopeSchema.safeParse({
      eventId: "f29f20c2-c0ba-41fc-8e84-b6e11318dbaa",
      payload: {}
    });

    expect(parsed.success).toBe(false);
  });
});

/**
 * `internalApiSecretSchema` -- the single declaration of `INTERNAL_API_SECRET` that gateway,
 * usage-service, worker-service and billing-service all derive their env field from (S-8).
 *
 * The four used to declare it separately and had drifted into two different rules, which is not
 * a tidiness problem: because both HTTP clients in this stack strip leading and trailing SP/HTAB
 * from a header value in transit, a whitespace-padded deployed secret made the trimming services
 * answer `200` and the untrimmed ones answer `401` for the same configuration. The cases here
 * are the behaviour of the one fragment; each service's suite asserts that its own field *is*
 * this object.
 */
describe("internalApiSecretSchema", () => {
  it("accepts a printable-ASCII secret exactly at the shared minimum length", () => {
    const atMinimum = FILLER.repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);
    const parsed = internalApiSecretSchema.safeParse(atMinimum);

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data).toBe(atMinimum);
    }
  });

  it("rejects a secret one character below the shared minimum", () => {
    expect(
      internalApiSecretSchema.safeParse(
        FILLER.repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1)
      ).success
    ).toBe(false);
  });

  it("rejects an empty secret", () => {
    expect(internalApiSecretSchema.safeParse("").success).toBe(false);
  });

  it("strips surrounding whitespace and accepts what is left", () => {
    const core = FILLER.repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);
    const parsed = internalApiSecretSchema.safeParse(`  ${core}\t`);

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data).toBe(core);
    }
  });

  // The value usage-service and gateway accepted before this fragment: `.min()` measures the
  // padded length, so 32 spaces parsed cleanly and reached the guard as a 32-space secret.
  it("rejects an all-whitespace secret at the minimum length", () => {
    expect(internalApiSecretSchema.safeParse(repeatToMinimum(LOWEST_PRINTABLE_ASCII)).success).toBe(
      false
    );
  });

  // The case that separates `.trim().min(...)` from `.min(...).trim()`: a non-blank value whose
  // trimmed core is one character short. A suite asserting only the trimmed *output* cannot tell
  // those two orderings apart, which is why this input is here as well as the blank one.
  it("rejects a secret that reaches the minimum only by its padding", () => {
    const paddedShort = `  ${FILLER.repeat(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH - 1)}  `;

    expect(paddedShort.length).toBeGreaterThan(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);
    expect(internalApiSecretSchema.safeParse(paddedShort).success).toBe(false);
  });

  it("accepts internal spaces, so a passphrase-style secret still parses", () => {
    const passphrase = [FILLER.repeat(10), FILLER.repeat(10), FILLER.repeat(12)].join(
      LOWEST_PRINTABLE_ASCII
    );

    expect(passphrase.length).toBeGreaterThan(INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH);

    const parsed = internalApiSecretSchema.safeParse(passphrase);

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data).toBe(passphrase);
      expect(parsed.data).toContain(LOWEST_PRINTABLE_ASCII);
    }
  });

  it("accepts both ends of the printable-ASCII range", () => {
    const spanningBoundaries = `${HIGHEST_PRINTABLE_ASCII}${FILLER.repeat(
      INTERNAL_AUTH_CONSTANTS.SECRET_MIN_LENGTH
    )}${HIGHEST_PRINTABLE_ASCII}`;

    expect(internalApiSecretSchema.safeParse(spanningBoundaries).success).toBe(true);
    // U+0020 is inside the pattern *and* stripped by the trim, so it is legal internally and
    // removed at the edges. Both halves are asserted above; this pins that the pattern itself
    // does not exclude it.
    expect(INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN.test(LOWEST_PRINTABLE_ASCII)).toBe(true);
    expect(INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN.test(HIGHEST_PRINTABLE_ASCII)).toBe(true);
  });

  it.each([
    ["U+001F UNIT SEPARATOR, one below the range", JUST_BELOW_PRINTABLE_ASCII],
    ["U+007F DELETE, one above the range", JUST_ABOVE_PRINTABLE_ASCII],
    ["U+00AD SOFT HYPHEN", SOFT_HYPHEN],
    ["U+200B ZERO WIDTH SPACE", ZERO_WIDTH_SPACE],
    ["U+0085 NEXT LINE", NEXT_LINE],
    ["U+034F COMBINING GRAPHEME JOINER", COMBINING_GRAPHEME_JOINER]
  ])("rejects a secret made of %s", (_name, character) => {
    const parsed = internalApiSecretSchema.safeParse(repeatToMinimum(character));

    expect(parsed.success).toBe(false);
  });

  // The order of the checks is load-bearing and invisible to a suite that asserts only verdicts:
  // `.trim().min().regex()` and `.trim().regex().min()` agree on every accept/reject decision and
  // differ on which message an all-whitespace secret produces. This pins the chosen order by
  // asserting the *class* of each rejection, so a reordering that keeps the verdicts reddens here
  // instead of shipping a message change nobody sees.
  it("reports the length rule for a whitespace-only secret and the pattern rule for a non-ASCII one", () => {
    expect(firstIssueMessage(repeatToMinimum(LOWEST_PRINTABLE_ASCII))).toBe(lengthRuleMessage());
    expect(firstIssueMessage(repeatToMinimum(ZERO_WIDTH_SPACE))).toBe(
      INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN_MESSAGE
    );
    expect(INTERNAL_AUTH_CONSTANTS.SECRET_PATTERN_MESSAGE).not.toBe(lengthRuleMessage());
  });
});
