import { afterEach, describe, expect, it, vi } from "vitest";
import { hostname } from "node:os";
import { EVENT_STREAM_CONSTANTS, INTERNAL_AUTH_CONSTANTS } from "@telemetry/shared-types";
import { internalApiSecretSchema } from "@telemetry/shared-validation";
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

/**
 * The instance-unique consumer name T-043 makes the default (D1/B), derived here from
 * `node:os` and `process.pid` **directly** rather than by calling the subject's builder.
 *
 * Calling the implementation would keep agreeing with the implementation after the
 * implementation changed -- the objection `index.graceful-shutdown.unit.test.ts`'s
 * `XAUTOCLAIM_EMPTY_REPLY` docblock already states for a fake echoing a production constant.
 * The separator is written out as a literal for the same reason the `'telemetry:events'`
 * default above is: the exact shape of the name is the thing under test, so sourcing it from the
 * subject would make the assertion hold whatever the subject said. In this case the point is
 * moot as well as sound — the separator is a **module-local** `CONSUMER_NAME_SEGMENT_SEPARATOR`
 * in `src/constants.ts` with no `export`, so this file could not have imported it. An earlier
 * revision of this docblock named it `WORKER_STREAM_CONSTANTS.CONSUMER_NAME_SEGMENT_SEPARATOR`,
 * which is not a member that exists (Gate-4 LOW-5).
 *
 * Scope of what this establishes, stated as measured rather than as a rule: the name is unique
 * **per process on one host**, because `process.pid` is. It says nothing about two hosts whose
 * `hostname()` collides -- see the `.env.example` note, which still asks an operator to make the
 * name unique per instance.
 */
const EXPECTED_DEFAULT_CONSUMER_NAME = `${hostname()}-${process.pid}`;


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

const VALID_INTERNAL_API_SECRET = "t-037-worker-internal-secret-at-least-32-chars";
const OTHER_VALID_INTERNAL_API_SECRET = "t-037-worker-other-secret-at-least-32-chars";

/** A well-formed absolute URL, matching the value `docker/docker-compose.yml` sets. */
const VALID_BILLING_SERVICE_URL = "http://billing-service:3004";

const buildBaseEnv = (): Record<string, string> => ({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://telemetry_app:telemetry_app_local_dev@localhost:5432/telemetry",
  REDIS_URL: "redis://localhost:6379",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  LOG_LEVEL: "silent",
  INTERNAL_API_SECRET: VALID_INTERNAL_API_SECRET,
  // T-042: required with no default, so every fixture built from this needs it. Present here
  // rather than defaulted in the schema deliberately -- a default would be a guess at another
  // service's address, and the failure mode of guessing wrong is a nightly job that quietly
  // invoices nobody.
  BILLING_SERVICE_URL: VALID_BILLING_SERVICE_URL
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

    // AC3, rewritten at T-043 (slice 3, decision D1/B).
    //
    // **Deliberately not a weakened assertion, and not a re-pointing of an existing one.** It
    // read `toBe(WORKER_STREAM_CONSTANTS.DEFAULT_CONSUMER_NAME)`, which is the constant the
    // schema's `.default(...)` is sourced from -- so it held no matter what that constant said,
    // including the shared `"worker-1"` that made the P11 race possible. This asserts the
    // *shape* instead, derived independently of `src/`.
    it("defaults REDIS_CONSUMER_NAME to <hostname>-<pid>, unique per process on this host", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_CONSUMER_NAME).toBe(EXPECTED_DEFAULT_CONSUMER_NAME);
      }
    });

    // AC3 / AC8. The override still wins, and is provably a different value from the default --
    // without the second assertion a schema that ignored the override entirely would pass here
    // on any host whose derived name happened to be the fixture.
    it("honours a REDIS_CONSUMER_NAME override", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        REDIS_CONSUMER_NAME: "worker-7"
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.REDIS_CONSUMER_NAME).toBe("worker-7");
        expect(parsed.data.REDIS_CONSUMER_NAME).not.toBe(EXPECTED_DEFAULT_CONSUMER_NAME);
      }
    });

    // AC8 (T-043, D1/B). The consumer-identity invariant, stated as three separate claims so
    // that the one that broke is the one that reports.
    //
    // **Why this is not covered by the default case above.** That case compares the parsed
    // default with one computed expression. If the *shape* of the name changed -- the pid
    // segment dropped, say -- and this file's expression were changed to match, the case would
    // stay green while the platform lost the property. This one names the property: the pid is
    // in there, the hostname is in there, and the shared `"worker-1"` that made P11 possible is
    // not.
    //
    // **The mutations that establish each claim, with the assertion that actually reported.**
    // Both were run at Gate 3, and the ordering below is what they forced. Assertions in a case
    // short-circuit, so only the first failing one names anything:
    //
    //   `DEFAULT_CONSUMER_NAME: "worker-1"` -> `expected 'worker-1' not to be 'worker-1'`
    //   `DEFAULT_CONSUMER_NAME: hostname()`  -> `expected 'linuxconfig' to contain '<pid>'`
    //
    // The `not.toBe("worker-1")` line was written **third** and was dead weight there: a name
    // that already contained this pid and this hostname cannot also equal `"worker-1"`, so it
    // could never be the reporting assertion. Measured -- under the `"worker-1"` mutation the
    // case failed at `toContain(String(process.pid))` and that line never executed. Moved first,
    // which is the discipline `U72` states in this same file.
    //
    // What neither mutation establishes is uniqueness across hosts: two hosts reporting the same
    // `hostname()` derive the same name, which is why `.env.example` still asks an operator to
    // make the name unique per instance.
    it("U85 - the default consumer name carries this process's pid and this host's name", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        // First, so that a revert to the shared name reports *that* rather than a missing pid.
        // Written as a literal rather than as a retired constant, because the claim is that
        // *this specific shared name* is gone: two replicas under one name share one
        // `XINFO CONSUMERS` row, and a shutdown guard reading it cannot tell its own pending
        // entries from a live peer's (probe P11 -- the guard read `pending 0`, the peer read an
        // entry a moment later, and the delete destroyed it).
        expect(parsed.data.REDIS_CONSUMER_NAME).not.toBe("worker-1");
        expect(parsed.data.REDIS_CONSUMER_NAME).toContain(String(process.pid));
        expect(parsed.data.REDIS_CONSUMER_NAME).toContain(hostname());
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

  // T-041 (AC1). Q10's two settled values: `MAX_RETRY_COUNT` 3 and `DEAD_LETTER_STREAM`
  // `telemetry:dead-letter`. Its own describe block rather than an extension of the one above,
  // matching how `WORKER_DEAD_LETTER` is a sibling of `WORKER_STREAM_READ` in `src/constants.ts`:
  // these fields configure failure handling, not the read loop.
  describe("dead-letter configuration", () => {
    // AC1. Default asserted against the constant and the *literal* alike, for the reason the
    // REDIS_STREAM_NAME pair above gives: an assertion sourced only from the constant the schema
    // reads stays green after someone edits the constant.
    it("defaults MAX_RETRY_COUNT to 3 and coerces an override from string", () => {
      const parsedDefault = EnvSchema.safeParse(buildBaseEnv());

      expect(parsedDefault.success).toBe(true);

      if (parsedDefault.success) {
        expect(parsedDefault.data.MAX_RETRY_COUNT).toBe(
          WORKER_STREAM_CONSTANTS.DEFAULT_MAX_RETRY_COUNT
        );
        expect(parsedDefault.data.MAX_RETRY_COUNT).toBe(3);
      }

      const parsedOverride = EnvSchema.safeParse({ ...buildBaseEnv(), MAX_RETRY_COUNT: "5" });

      expect(parsedOverride.success).toBe(true);

      if (parsedOverride.success) {
        expect(parsedOverride.data.MAX_RETRY_COUNT).toBe(5);
        expect(typeof parsedOverride.data.MAX_RETRY_COUNT).toBe("number");
      }
    });

    // AC1. Both bounds accepted, both one-past rejected -- the shape the STREAM_BATCH_SIZE pair
    // above uses. An operator raising the budget to the cap buys roughly two minutes of retrying
    // at the default block interval (plan R1); a value of 0 would dead-letter on first failure.
    it("accepts MAX_RETRY_COUNT at both configured bounds", () => {
      for (const bound of [
        WORKER_STREAM_CONSTANTS.MAX_RETRY_COUNT_MIN,
        WORKER_STREAM_CONSTANTS.MAX_RETRY_COUNT_MAX
      ]) {
        const parsed = EnvSchema.safeParse({
          ...buildBaseEnv(),
          MAX_RETRY_COUNT: String(bound)
        });

        expect(parsed.success, String(bound)).toBe(true);

        if (parsed.success) {
          // `typeof` as well as the value: zod strips an undeclared key rather than
          // rejecting it, so before the field existed `parsed.data.MAX_RETRY_COUNT` was
          // `undefined` and `toBe(undefined)` passed. This case was confirmed red only after
          // the type assertion was added.
          expect(typeof parsed.data.MAX_RETRY_COUNT, String(bound)).toBe("number");
          expect(parsed.data.MAX_RETRY_COUNT).toBe(bound);
        }
      }
    });

    // AC1
    it("rejects a MAX_RETRY_COUNT outside the configured bounds", () => {
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          MAX_RETRY_COUNT: String(WORKER_STREAM_CONSTANTS.MAX_RETRY_COUNT_MIN - 1)
        }),
        "MAX_RETRY_COUNT"
      );
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          MAX_RETRY_COUNT: String(WORKER_STREAM_CONSTANTS.MAX_RETRY_COUNT_MAX + 1)
        }),
        "MAX_RETRY_COUNT"
      );
    });

    // AC1, and the one case in this block that does **not** compute its input from the
    // constant it is testing.
    //
    // **Carries a `U` id although this file otherwise cites ACs** -- the plan's F11 records that
    // convention. The departure is deliberate: this case's subject is a `DeadLetterService`
    // invariant that happens to be enforced by the schema, and it is cited from that service's
    // `readRetryCount` docstring, which needs a stable name to point at. It lives here rather
    // than in `tests/dead-letter.service.unit.test.ts` because the assertion is about
    // `EnvSchema`, and moving it there would mean a second copy of `buildBaseEnv`.
    //
    // **Why the bounds case below cannot cover this.** It asserts
    // `String(MAX_RETRY_COUNT_MIN - 1)` is rejected, so its input moves with the constant.
    // Measured, both ways: at `MAX_RETRY_COUNT_MIN: 1` the computed input is `"0"` and is
    // rejected; set the constant to `0` and the computed input becomes `"-1"` -- still rejected,
    // so that case stays green -- while `MAX_RETRY_COUNT=0` starts **parsing successfully**.
    // The Gate-6 reviewer made exactly that edit and the package stayed 156/156 green;
    // reproduced here before this case was written.
    //
    // **What the floor protects, which is why the numeral alone is the weaker assertion.**
    // `DeadLetterService.readRetryCount` coerces a non-numeric stored counter to `0` rather than
    // leaving it `NaN`. That coercion is inert at every legal budget -- measured at Gate 5:
    // driving `wrap()` over a corrupt counter with the coercion present and with a bare
    // `return parsed` produced byte-identical command sequences and outcomes. It stops being
    // inert at exactly one value. At `maxRetryCount === 0`, `0 >= 0` is true while `NaN >= 0` is
    // false, so the coercion becomes the difference between dead-lettering on arrival and
    // processing the entry -- measured: with the coercion `cmds=[hget,xadd,xack,hdel]` and
    // `inner` never ran; without it `cmds=[hget]` and `inner` ran once. `MAX_RETRY_COUNT_MIN: 1`
    // is the only thing keeping that configuration unreachable, and until this case nothing
    // pinned it.
    it("U72 - pins the retry floor at 1, so MAX_RETRY_COUNT=0 cannot be configured", () => {
      // **The property first, deliberately.** Both halves redden when the floor drops, but only
      // one of them can report it: assertions in a case short-circuit, so whichever runs first
      // names the failure. Measured -- with the numeral assertion above this one, lowering the
      // constant failed at `expected +0 to be 1`, and the property below never executed. Ordered
      // this way the same edit fails at `expected true to be false` on a `safeParse` of
      // `MAX_RETRY_COUNT=0`, which says what actually broke rather than that a numeral moved.
      //
      // A **literal** `0`, never `String(MAX_RETRY_COUNT_MIN - 1)`: an input derived from the
      // constant under test cannot detect the constant changing.
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), MAX_RETRY_COUNT: "0" }),
        "MAX_RETRY_COUNT"
      );

      // The numeral, against the literal rather than against itself. Second because it is the
      // weaker claim -- it pins what the floor *is*, where the line above pins what the floor
      // *does*.
      expect(WORKER_STREAM_CONSTANTS.MAX_RETRY_COUNT_MIN).toBe(1);

      // Anti-vacuity: the floor itself still parses, so this rejects the value below the floor
      // rather than the field. The both-bounds case above covers this too; asserted here so
      // that lowering the floor cannot be made to look correct by this case alone.
      const atFloor = EnvSchema.safeParse({
        ...buildBaseEnv(),
        MAX_RETRY_COUNT: String(WORKER_STREAM_CONSTANTS.MAX_RETRY_COUNT_MIN)
      });
      expect(atFloor.success).toBe(true);
    });

    // AC1. `z.coerce.number()` accepts `"2.5"` happily; `.int()` is what refuses it. Without
    // this, a fractional budget would make the `>=` threshold comparison meaningless.
    it("rejects a fractional MAX_RETRY_COUNT", () => {
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), MAX_RETRY_COUNT: "2.5" }),
        "MAX_RETRY_COUNT"
      );
    });

    // AC1
    it("defaults DEAD_LETTER_STREAM to 'telemetry:dead-letter'", () => {
      const parsed = EnvSchema.safeParse(buildBaseEnv());

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.DEAD_LETTER_STREAM).toBe(
          WORKER_STREAM_CONSTANTS.DEFAULT_DEAD_LETTER_STREAM
        );
        expect(parsed.data.DEAD_LETTER_STREAM).toBe("telemetry:dead-letter");
        // Never the stream the worker *reads*: a dead letter written back onto the source
        // stream would be re-delivered, re-fail, and dead-letter itself forever.
        expect(parsed.data.DEAD_LETTER_STREAM).not.toBe(parsed.data.REDIS_STREAM_NAME);
      }
    });

    // AC1
    it("honours a DEAD_LETTER_STREAM override", () => {
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        DEAD_LETTER_STREAM: "telemetry:dead-letter:replay"
      });

      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.DEAD_LETTER_STREAM).toBe("telemetry:dead-letter:replay");
      }
    });

    // AC1, and S-23's lesson applied in the service that has the guard: usage-service's
    // `REDIS_STREAM_NAME` lacks `.min(1)` and parses `""`, which is the divergence that entry
    // records. `XADD ""` would write to a stream key nobody can find. Deliberately **not**
    // `.trim()`ed -- `src/config/env.ts` records why the stream-name fields are untrimmed, and
    // this is a stream name.
    it("rejects a blank DEAD_LETTER_STREAM", () => {
      expectIssueOn(
        EnvSchema.safeParse({ ...buildBaseEnv(), DEAD_LETTER_STREAM: "" }),
        "DEAD_LETTER_STREAM"
      );
    });

    // AC1, cross-field. The two defaults differ, which the case above pins -- but that says
    // nothing about an *operator* who sets both. Before this guard existed the schema accepted
    // it and the worker started.
    //
    // The failure is self-amplifying rather than merely wrong: each dead-lettered entry is
    // `XADD`ed onto the stream the worker reads; its fields are `originalId`/`streamName`/...,
    // not an envelope, so it fails to parse; three failures later it dead-letters *itself*,
    // adding another entry. One new entry per three failures, indefinitely. Reasoned from the
    // code paths and not run as a live loop -- what is measured here is that the schema now
    // refuses the configuration.
    //
    // The invariant was stated in three comments (`WORKER_STREAM_CONSTANTS`'s
    // `DEFAULT_DEAD_LETTER_STREAM` docblock, `.env.example`, and the default-inequality
    // assertion above) and enforced nowhere. That is the shape S-6 and S-23 were filed for: a
    // rule an operator can violate with a clean startup.
    it("rejects a DEAD_LETTER_STREAM equal to REDIS_STREAM_NAME", () => {
      const collidingName = "telemetry:events:collision";

      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          REDIS_STREAM_NAME: collidingName,
          DEAD_LETTER_STREAM: collidingName
        }),
        "DEAD_LETTER_STREAM"
      );

      // Also when the collision is against the *defaults* rather than an explicit override --
      // an operator who sets only `DEAD_LETTER_STREAM` to the shipped stream name.
      expectIssueOn(
        EnvSchema.safeParse({
          ...buildBaseEnv(),
          DEAD_LETTER_STREAM: WORKER_STREAM_CONSTANTS.DEFAULT_STREAM_NAME
        }),
        "DEAD_LETTER_STREAM"
      );

      // And the message is the constant, not an ad-hoc string, so the operator-facing text has
      // one definition. Asserted on the issue rather than only on the failure, because a
      // refinement that fired for the wrong reason would satisfy `expectIssueOn` alone.
      const parsed = EnvSchema.safeParse({
        ...buildBaseEnv(),
        REDIS_STREAM_NAME: collidingName,
        DEAD_LETTER_STREAM: collidingName
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some(
            (issue) => issue.message === WORKER_STREAM_CONSTANTS.DEAD_LETTER_STREAM_COLLISION
          )
        ).toBe(true);
      }

      // Anti-vacuity: two *different* names still parse, so the refinement rejects the
      // collision rather than the field.
      const distinct = EnvSchema.safeParse({
        ...buildBaseEnv(),
        REDIS_STREAM_NAME: collidingName,
        DEAD_LETTER_STREAM: `${collidingName}:dlq`
      });
      expect(distinct.success).toBe(true);
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

    // T-042. Required with no default: `parseEnv` throws at module load, so a worker that has
    // no billing address fails to start rather than discovering it at 02:00, on a path with no
    // alarm behind it.
    it("rejects an env with no BILLING_SERVICE_URL", () => {
      expectIssueOn(
        EnvSchema.safeParse(buildEnvWithout("BILLING_SERVICE_URL")),
        "BILLING_SERVICE_URL"
      );
    });

    // `.url()` rather than `.min(1)`: this value is concatenated with a path constant, so a
    // relative or malformed value would build a URL `fetch` rejects at the first nightly run and
    // at no earlier moment.
    //
    // **What `.url()` does not give, measured rather than assumed.** On zod 3.25.76 it delegates
    // to `new URL(...)`, which accepts *any* scheme -- so `"billing-service:3004"` parses, as a
    // URL whose protocol is `billing-service:`. Written here as an accepted value rather than an
    // omitted one, because a reader who sees only the rejected list will take the field for
    // http-only. The three genuinely-rejected forms are the ones an operator is likely to
    // produce by truncation.
    //
    // Not tightened to `^https?:` deliberately: `apps/gateway/src/config/env.ts` declares the
    // same field name as a bare `.url()`, and one service enforcing a stricter rule than the
    // other on the same operator-supplied value is exactly the producer/consumer divergence S-23
    // and S-39 are about. If it is worth tightening it is worth tightening in one shared
    // fragment, which is its own task.
    it("rejects the malformed BILLING_SERVICE_URL forms, but accepts any scheme", () => {
      for (const invalid of ["not a url", "/v1/internal", ""]) {
        expectIssueOn(
          EnvSchema.safeParse({ ...buildBaseEnv(), BILLING_SERVICE_URL: invalid }),
          "BILLING_SERVICE_URL"
        );
      }

      const anyScheme = EnvSchema.safeParse({
        ...buildBaseEnv(),
        BILLING_SERVICE_URL: "billing-service:3004"
      });
      expect(anyScheme.success).toBe(true);
    });

    it("accepts the compose and local forms of BILLING_SERVICE_URL", () => {
      for (const valid of [VALID_BILLING_SERVICE_URL, "http://localhost:3004", "https://billing.internal"]) {
        const parsed = EnvSchema.safeParse({ ...buildBaseEnv(), BILLING_SERVICE_URL: valid });

        expect(parsed.success, `${valid} was rejected`).toBe(true);
        if (parsed.success) {
          expect(parsed.data.BILLING_SERVICE_URL).toBe(valid);
        }
      }
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

  // S-8. All four services that declare `INTERNAL_API_SECRET` now derive the field from one
  // fragment in `@telemetry/shared-validation`, rather than each writing the rule out. They used
  // to write it out and had drifted into two rules: worker-service and billing-service trimmed,
  // gateway and usage-service did not. Because both HTTP clients in this stack strip leading and
  // trailing SP/HTAB from a header value in transit, one stray space in a platform-wide secret
  // made this service and billing answer `200` while usage-service answered `401` -- measured
  // end-to-end over a real socket against the real guard factories before this change was
  // written. The behaviour table for the fragment lives beside the fragment; what this block
  // asserts is the derivation, plus one rejection driven through the whole-object parse.
  describe("INTERNAL_API_SECRET derives from the shared fragment", () => {
    // **worker's `EnvSchema` is a `ZodEffects`, not a `ZodObject`** -- `.superRefine(...)` at
    // `src/config/env.ts` wraps it -- so it has no `.shape` (S-23 records this trap, and
    // measured `"shape" in EnvSchema` as `false`). The other three suites reach the field with
    // `EnvSchema.shape.INTERNAL_API_SECRET`; here it has to be `innerType()` first. A helper
    // copied from billing's suite would read `undefined.INTERNAL_API_SECRET` and throw rather
    // than assert nothing, which is the right direction to fail in -- but the point of writing
    // it out is that the reader should not have to discover that.
    it("declares INTERNAL_API_SECRET as internalApiSecretSchema itself", () => {
      expect(EnvSchema.innerType().shape.INTERNAL_API_SECRET).toBe(internalApiSecretSchema);
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
