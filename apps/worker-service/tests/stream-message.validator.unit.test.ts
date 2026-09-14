import { describe, expect, it } from "vitest";
import { WORKER_EVENT_PROCESSING } from "../src/constants";
import { parseStreamMessage } from "../src/validators/stream-message.validator";

/**
 * Unit suite for T-040's stream-message parser (slice S3).
 *
 * The parser is the one place the four Gate-2 decisions are expressed — D1 (`metricKey` is the
 * bare `eventType`), D2 (both period bounds are the event instant), D3 (every non-envelope
 * field becomes string metadata) — so these cases are where those decisions are pinned. The
 * repository below it is a writer with no derivation in it, which is what keeps a change of
 * mind about D1 or D2 a one-expression change (plan §9 R9).
 *
 * The wire format is what the producer actually publishes, not the envelope
 * `docs/epics/README.md` Q1 records. Measured on the live stream while planning (plan §4 F5):
 * entry `1787746970722-0` carries `eventId, tenantId, eventType, quantity, unit, occurredAt,
 * idempotencyKey, timestamp` plus a flattened `sourceId` — no `receivedAt`, no `source`, no
 * `version`, no `payload`. `apps/usage-service/src/services/ingestion.service.ts`'s
 * `publishEvent` literal and its `RESERVED_STREAM_FIELDS` set are the producer side of the
 * same shape.
 *
 * Every field name and error message comes from `WORKER_EVENT_PROCESSING`
 * (`.claude/rules/constants.md` applies to tests). What is written out literally is fixture
 * vocabulary — the values a customer might send — because those are inputs, not contract.
 */

/** A real `Tenant.id` shape: `Tenant.id` is `String @default(uuid())`. */
const TENANT_ID = "456793cd-6625-44f6-af63-142a86019e1a";
const EVENT_ID = "7c05417c-4e79-461e-97d6-222ecd8fe913";
const EVENT_TYPE = "api.request";
const UNIT = "request";
const IDEMPOTENCY_KEY = "idem_1";
/** The producer's bookkeeping field: `Date.now()` at publish time, as a string. */
const PRODUCER_TIMESTAMP = "1787746970722";

/**
 * A quantity that loses digits if it is ever read as a JS number.
 *
 * `12345678901.123456` bound as a `number` was stored as `12345678901.123460` with **no
 * error** (plan Appendix A/P-DEC). The parser's contract is that it never converts, so this
 * value has to survive as the identical string.
 */
const QUANTITY_FULL_PRECISION = "12345678901.123456";

const OCCURRED_AT_ISO = "2026-01-01T00:00:00.000Z";

/**
 * The same instant as `OCCURRED_AT_ISO`, written with offsets instead of `Z`.
 *
 * Legal input, not a hypothetical: `iso8601Schema` is `z.string().datetime({ offset: true })`
 * and the producer publishes `occurredAt` as the raw request string, offset and all
 * (`apps/usage-service/src/services/ingestion.service.ts`'s `publishEvent` literal). Every
 * other fixture in this change is `Z`-only, and `CLAUDE.md` § *Raw SQL and timestamps* names
 * `Z`-only fixtures as the specific thing that catches no offset defect.
 *
 * Both signs, because they fail differently: a parser that discarded the offset rather than
 * resolving it would read `+05:30` as five and a half hours *late* and `-05:00` as five hours
 * *early*, and a single-sign fixture cannot tell "discarded" from "applied backwards".
 */
const OCCURRED_AT_OFFSET_POSITIVE = "2026-01-01T05:30:00.000+05:30";
const OCCURRED_AT_OFFSET_NEGATIVE = "2025-12-31T19:00:00.000-05:00";

/**
 * What `docs/epics/epic-7-worker-service.md`'s `${eventType}.${unit}` rule would produce.
 *
 * Against the two entries on the live stream this is literally `"api.request.request"`, which
 * matches no `Meter` any seed or fixture creates — so D1 chose the bare `eventType` and this
 * constant exists to be asserted *against*.
 */
const EPIC_METRIC_KEY_FORM = `${EVENT_TYPE}.${UNIT}`;

/**
 * Sentinel strings for `U60`, the S-31 negative.
 *
 * The point of a sentinel is that it can appear in the thrown message by exactly one route --
 * the parser copying a *value* into it -- so its absence is evidence rather than luck. Each is
 * distinctive enough that a substring search cannot match it by accident, and they are seeded
 * into the envelope fields a customer controls plus one metadata **key** and its value.
 *
 * The metadata key is not decoration. Measured on this schema (plan §4 F9, re-measured at
 * Gate 3 against the real `envelopeSchema` rather than a copy): making the schema `.strict()`
 * produces an `unrecognized_keys` issue carrying the offending key in `issue.keys` and in
 * `issue.message`. The parser projects each issue to `code` and `path` only, and an
 * `unrecognized_keys` issue's `path` is empty, so no key reaches the message -- but that is a
 * property of the projection, and `U60` is what holds it there.
 */
const SENTINEL = {
  EVENT_ID: "SENTINEL-EVENT-ID-8f2a",
  TENANT_ID: "SENTINEL-TENANT-ID-4b7c",
  QUANTITY: "SENTINEL-QUANTITY-1d9e",
  IDEMPOTENCY_KEY: "SENTINEL-IDEMPOTENCY-6c3f",
  OCCURRED_AT: "SENTINEL-OCCURRED-AT-2e5b",
  METADATA_KEY: "SENTINEL-META-KEY-7a1d",
  METADATA_VALUE: "SENTINEL-META-VALUE-0b4c"
} as const;

/**
 * Zod issue codes this parser's failures produce, as **observed** on zod 3.25.76.
 *
 * Written out rather than imported from zod, for the reason the neighbouring suite gives about
 * observed Redis reply texts: these are the library's vocabulary and the thing under test is
 * that the parser surfaces them. Sourcing them from the same expression the implementation
 * evaluates would make `U59` hold whatever either said.
 */
const ZOD_ISSUE_CODE = {
  /** A field that is absent entirely. */
  INVALID_TYPE: "invalid_type",
  /** A present field that fails `.uuid()`, `.regex(...)` or `.datetime(...)`. */
  INVALID_STRING: "invalid_string"
} as const;

/** Captures the message of whatever `parseStreamMessage` throws, or fails loudly. */
const messageThrownBy = (fields: string[]): string => {
  try {
    parseStreamMessage(fields);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new Error(`parseStreamMessage threw a non-Error: ${String(error)}`, {
        cause: error
      });
    }

    return error.message;
  }

  throw new Error("parseStreamMessage did not throw, so there is no message to inspect");
};

/** Flattened metadata: sibling top-level fields, every value a string after `XADD`. */
const METADATA_FIELD = {
  SOURCE_ID: "sourceId",
  REGION: "region"
} as const;
const METADATA_VALUE = {
  SOURCE_ID: "sdk-web",
  /** A value that *looks* numeric. `XADD` stored it as a string and it stays one (D3). */
  REGION: "42"
} as const;

/** The envelope as the producer writes it, as a flat `[k, v, k, v, ...]` list. */
const envelopeFields = (overrides: Record<string, string> = {}): string[] => {
  const record: Record<string, string> = {
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID]: EVENT_ID,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: TENANT_ID,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_TYPE]: EVENT_TYPE,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY]: QUANTITY_FULL_PRECISION,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.UNIT]: UNIT,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT]: OCCURRED_AT_ISO,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.IDEMPOTENCY_KEY]: IDEMPOTENCY_KEY,
    [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.PRODUCER_TIMESTAMP]: PRODUCER_TIMESTAMP,
    ...overrides
  };

  return Object.entries(record).flat();
};

/** The same list with one envelope field removed entirely. */
const envelopeFieldsWithout = (omitted: string): string[] => {
  const flat = envelopeFields();
  const result: string[] = [];
  for (let index = 0; index < flat.length; index += WORKER_EVENT_PROCESSING.FIELD_PAIR_STRIDE) {
    if (flat[index] !== omitted) {
      result.push(...flat.slice(index, index + WORKER_EVENT_PROCESSING.FIELD_PAIR_STRIDE));
    }
  }

  return result;
};

describe("parseStreamMessage", () => {
  it("U40 - deserialises the envelope into a typed payload, deriving metricKey and the period bounds", () => {
    const payload = parseStreamMessage(envelopeFields());

    expect(payload.tenantId).toBe(TENANT_ID);
    expect(payload.event.eventId).toBe(EVENT_ID);
    expect(payload.event.eventType).toBe(EVENT_TYPE);
    expect(payload.event.unit).toBe(UNIT);
    expect(payload.event.idempotencyKey).toBe(IDEMPOTENCY_KEY);

    // D-DEC. The stream carries the quantity as a string and it stays one all the way to the
    // bind: `Number("12345678901.123456")` silently stores `...123460`. Both the type and the
    // exact digits, because `toBe` on a number would also pass for a lossy round trip.
    expect(payload.event.quantity).toBe(QUANTITY_FULL_PRECISION);
    expect(typeof payload.event.quantity).toBe("string");
    expect(payload.usageLine.quantity).toBe(QUANTITY_FULL_PRECISION);

    // D-ORM. A `Date` for the ORM to bind, not a raw string spliced into SQL.
    expect(payload.event.occurredAt).toBeInstanceOf(Date);
    expect(payload.event.occurredAt.toISOString()).toBe(OCCURRED_AT_ISO);

    // D1: `metricKey` is the bare `eventType`. The epic's `${eventType}.${unit}` would make
    // this `"api.request.request"`, which matches no `Meter` that `prisma/seed.ts` or
    // usage-service's fixtures seed — every `UsageLine` would be unpriceable.
    expect(payload.usageLine.metricKey).toBe(EVENT_TYPE);
    // The rejected alternative, written out. `not.toContain(UNIT)` is *not* the negative to
    // write here and was the first thing tried: `"request"` is already a substring of
    // `"api.request"`, so that assertion fails against the correct implementation.
    expect(payload.usageLine.metricKey).not.toBe(EPIC_METRIC_KEY_FORM);

    // D2: both bounds are the event instant. A calendar-day bucket here would collapse
    // `granularity=hour` in usage-service's already-shipped summary endpoint to one midnight
    // bucket per day.
    expect(payload.usageLine.periodStart.toISOString()).toBe(OCCURRED_AT_ISO);
    expect(payload.usageLine.periodEnd.toISOString()).toBe(OCCURRED_AT_ISO);

    // The tenant id is on the payload only so the processor can *select* a repository with it.
    // The row the repository writes has no tenant field at all, so a caller-supplied tenant id
    // cannot be written even by mistake — the repository writes its own bound context.
    // (`tenantId` is absent from the type; this asserts the runtime object matches.)
    expect(Object.keys(payload.event)).not.toContain(
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID
    );
    expect(Object.keys(payload.usageLine)).not.toContain(
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID
    );

    // An offset-bearing `occurredAt` resolves to the same instant as the `Z` form, on all three
    // values D2 derives from it. Measured rather than assumed: `new Date(...)` resolves the
    // offset, so what reaches the ORM is an absolute instant and not a wall-clock string.
    //
    // This matters here specifically because D2 makes `periodStart` and `periodEnd` the event
    // instant. usage-service's summary endpoint buckets on `periodStart`, so an offset read as
    // a wall clock writes the wrong bucket — `2026-01-01T05:30:00+05:30` misread would land on
    // 1 January 05:30 instead of midnight, which for `granularity=hour` is a different row that
    // only a backfill could repair.
    for (const offsetForm of [OCCURRED_AT_OFFSET_POSITIVE, OCCURRED_AT_OFFSET_NEGATIVE]) {
      const offsetPayload = parseStreamMessage(
        envelopeFields({ [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT]: offsetForm })
      );
      expect(offsetPayload.event.occurredAt.toISOString(), offsetForm).toBe(OCCURRED_AT_ISO);
      expect(offsetPayload.usageLine.periodStart.toISOString(), offsetForm).toBe(
        OCCURRED_AT_ISO
      );
      expect(offsetPayload.usageLine.periodEnd.toISOString(), offsetForm).toBe(OCCURRED_AT_ISO);
      // Instant equality, not string equality: `getTime()` is what a bucket boundary is
      // computed from, and two `Date`s can render the same ISO string only by agreeing here.
      expect(offsetPayload.event.occurredAt.getTime(), offsetForm).toBe(
        payload.event.occurredAt.getTime()
      );
    }
  });

  it("U41 - collects every non-envelope field into metadata as strings, and null when there are none", () => {
    const withMetadata = parseStreamMessage(
      envelopeFields({
        [METADATA_FIELD.SOURCE_ID]: METADATA_VALUE.SOURCE_ID,
        [METADATA_FIELD.REGION]: METADATA_VALUE.REGION
      })
    );

    // D3. The narrow reading (`metadata = null` always) discards `sourceId` permanently: the
    // stream entry is the only copy and it is trimmed at `MAXLEN ~ 100000`.
    expect(withMetadata.event.metadata).toEqual({
      [METADATA_FIELD.SOURCE_ID]: METADATA_VALUE.SOURCE_ID,
      [METADATA_FIELD.REGION]: METADATA_VALUE.REGION
    });
    // Types are not recoverable and the parser does not pretend otherwise: `XADD` stored
    // every value as a string, so a metadata value that looks numeric stays a string.
    expect(withMetadata.event.metadata?.[METADATA_FIELD.REGION]).toBe(METADATA_VALUE.REGION);
    expect(typeof withMetadata.event.metadata?.[METADATA_FIELD.REGION]).toBe("string");

    // The producer's own bookkeeping field is in the envelope set, so it is neither persisted
    // as a column nor swept into metadata. Without this, `timestamp` would land in the
    // customer-facing metadata blob of every single event.
    expect(withMetadata.event.metadata).not.toHaveProperty(
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.PRODUCER_TIMESTAMP
    );
    expect(withMetadata.event.metadata).not.toHaveProperty(
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID
    );

    // `null`, not `{}`: the column is `Json?`, and the second entry on the live stream carries
    // no metadata at all, so this branch is real data rather than a defensive case.
    expect(parseStreamMessage(envelopeFields()).event.metadata).toBeNull();
  });

  it("U42 - throws on an odd-length field list, a missing envelope field, a non-UUID tenant, and a non-numeric quantity", () => {
    // A field list with a dangling key. Positional `[k, v, k, v, ...]` means a lone trailing
    // element cannot be paired, and folding it anyway would silently pair every key with the
    // wrong value from there on.
    expect(() =>
      parseStreamMessage([...envelopeFields(), METADATA_FIELD.SOURCE_ID])
    ).toThrowError(WORKER_EVENT_PROCESSING.ERROR.ODD_FIELD_LIST);

    // Each envelope field the two rows need, checked one at a time rather than as a single
    // representative: a schema that dropped `.min(1)` from one field would still pass a test
    // that only omitted another.
    for (const field of [
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID,
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID,
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_TYPE,
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY,
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.UNIT,
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT,
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.IDEMPOTENCY_KEY
    ]) {
      expect(() => parseStreamMessage(envelopeFieldsWithout(field)), field).toThrowError(
        WORKER_EVENT_PROCESSING.ERROR.INVALID_MESSAGE
      );
    }

    // `.claude/rules/tenant-isolation.md` layer 3: any non-empty string is not good enough.
    // A tenant id containing `:` would make usage-service's `dedup:<tenantId>:<rawKey>`
    // ambiguous, and this is the same id arriving by a different route.
    for (const notAUuid of ["not-a-uuid", "", `${TENANT_ID}:suffix`, TENANT_ID.slice(1)]) {
      expect(() =>
        parseStreamMessage(
          envelopeFields({ [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: notAUuid })
        ),
        notAUuid
      ).toThrowError(WORKER_EVENT_PROCESSING.ERROR.INVALID_MESSAGE);
    }

    // Rejected here rather than at the bind. Prisma does reject a non-numeric string, as a
    // client-side `PrismaClientValidationError` (plan Appendix A/E4) — but it rejects it
    // *inside the transaction*, after `set_config` has run, and with a message about a Prisma
    // input type rather than about the message that arrived.
    for (const notADecimal of ["not-a-number", "", "1.2.3", "NaN", "Infinity", "1e6"]) {
      expect(() =>
        parseStreamMessage(
          envelopeFields({ [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY]: notADecimal })
        ),
        notADecimal
      ).toThrowError(WORKER_EVENT_PROCESSING.ERROR.INVALID_MESSAGE);
    }

    // `occurredAt` is bound as a `Date`, so an unparseable instant must not reach the ORM as
    // an `Invalid Date` — which would be written as `NULL`/rejected far from its cause.
    for (const notAnInstant of ["yesterday", "2026-13-01T00:00:00.000Z", ""]) {
      expect(() =>
        parseStreamMessage(
          envelopeFields({ [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT]: notAnInstant })
        ),
        notAnInstant
      ).toThrowError(WORKER_EVENT_PROCESSING.ERROR.INVALID_MESSAGE);
    }

    // The whole point of throwing: `dispatch` catches it, logs against the entry id, and does
    // not acknowledge — so a message the parser rejects stays in the pending list rather than
    // being silently dropped. Asserted as a property of the throw, not of `dispatch`.
    expect(() => parseStreamMessage([])).toThrowError(
      WORKER_EVENT_PROCESSING.ERROR.INVALID_MESSAGE
    );
  });

  it("U59 - names every broken field by zod code and path, and the odd list by its length", () => {
    // One absent field. `invalid_type` is what zod reports for a missing key, and the path is
    // the field name — which is the whole diagnostic value: before T-041 the operator saw
    // "Stream entry is not a valid usage event" and nothing else.
    const missingEventId = messageThrownBy(
      envelopeFieldsWithout(WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID)
    );
    expect(missingEventId).toContain(WORKER_EVENT_PROCESSING.ERROR.INVALID_MESSAGE);
    expect(missingEventId).toContain(ZOD_ISSUE_CODE.INVALID_TYPE);
    expect(missingEventId).toContain(WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID);

    // A present field that fails its refinement reports a different code, so the two failure
    // kinds are distinguishable from the message alone.
    const badTenant = messageThrownBy(
      envelopeFields({ [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: "not-a-uuid" })
    );
    expect(badTenant).toContain(ZOD_ISSUE_CODE.INVALID_STRING);
    expect(badTenant).toContain(WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID);
    // ...and does *not* name a field that was fine. Without this half the case would pass for
    // an implementation that appended every declared field name unconditionally.
    expect(badTenant).not.toContain(WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.UNIT);

    // Every broken field, not just the first: an operator fixing one field at a time from a
    // one-field message pays a redeploy per field.
    const severalBroken = messageThrownBy(
      envelopeFields({
        [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: "not-a-uuid",
        [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY]: "not-a-number",
        [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT]: "yesterday"
      })
    );
    for (const field of [
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID,
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY,
      WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT
    ]) {
      expect(severalBroken, field).toContain(field);
    }

    // The framing failure gets a **count**, not a value. The list is customer data; its length
    // is not, and the length is what tells an operator whether a key or a value went missing.
    const oddFields = [...envelopeFields(), METADATA_FIELD.SOURCE_ID];
    const oddMessage = messageThrownBy(oddFields);
    expect(oddMessage).toContain(WORKER_EVENT_PROCESSING.ERROR.ODD_FIELD_LIST);
    expect(oddMessage).toContain(String(oddFields.length));

    // `U42` asserts the base texts with `toThrowError(<string>)`, which is a **substring**
    // match on vitest 2.1.9 — re-measured rather than taken from the docs, by the probe in the
    // plan's Appendix A and by `U42` itself still passing beside this case. That is what lets
    // the detail ride on the same message without splitting the contract in two.
    expect(missingEventId.startsWith(WORKER_EVENT_PROCESSING.ERROR.INVALID_MESSAGE)).toBe(true);
    expect(oddMessage.startsWith(WORKER_EVENT_PROCESSING.ERROR.ODD_FIELD_LIST)).toBe(true);
  });

  it("U60 - no field value and no metadata key reaches the thrown message (S-31)", () => {
    // Every customer-controlled field carries a sentinel, and every one of them is invalid, so
    // each produces an issue. A parser that put the offending *value* in the message — the
    // obvious way to make a diagnostic helpful — puts customer data into a log line in a
    // service with no redaction layer.
    const fields = envelopeFields({
      [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID]: SENTINEL.EVENT_ID,
      [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: SENTINEL.TENANT_ID,
      [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY]: SENTINEL.QUANTITY,
      [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.IDEMPOTENCY_KEY]: SENTINEL.IDEMPOTENCY_KEY,
      [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT]: SENTINEL.OCCURRED_AT,
      // A metadata key *and* value the customer chose. The key matters separately from the
      // value: zod's `unrecognized_keys` issue carries a key in `issue.keys` and in
      // `issue.message`, so a projection that included either would leak it.
      [SENTINEL.METADATA_KEY]: SENTINEL.METADATA_VALUE
    });

    const message = messageThrownBy(fields);

    for (const sentinel of Object.values(SENTINEL)) {
      expect(message, sentinel).not.toContain(sentinel);
    }

    // Not a vacuous pass: the message did carry the diagnosis it is supposed to carry, so the
    // absences above are about *what* was included rather than about nothing being included.
    expect(message).toContain(WORKER_EVENT_PROCESSING.ERROR.INVALID_MESSAGE);
    expect(message).toContain(WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID);
    expect(message).toContain(WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID);

    // And the odd-length branch, which has no zod issues to project and so takes its own
    // path through the same rule.
    const oddMessage = messageThrownBy([...fields, SENTINEL.METADATA_KEY]);
    for (const sentinel of Object.values(SENTINEL)) {
      expect(oddMessage, sentinel).not.toContain(sentinel);
    }
    expect(oddMessage).toContain(WORKER_EVENT_PROCESSING.ERROR.ODD_FIELD_LIST);
  });
});
