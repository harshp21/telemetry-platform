import { z } from "zod";
import { iso8601Schema } from "@telemetry/shared-validation";
import type { TenantId } from "@telemetry/shared-types";
import { WORKER_ENVELOPE_FIELD_NAMES, WORKER_EVENT_PROCESSING } from "../constants";

/**
 * The `Event` row a stream entry becomes.
 *
 * **There is deliberately no `tenantId` here.** The repository writes its own bound tenant id,
 * never a value that travelled with the message, so this type gives it nothing to write from.
 * That is the `.claude/rules/tenant-isolation.md` invariant expressed as a shape rather than as
 * a convention at one call site: with no field, a future `create: { ...payload.event }` cannot
 * reintroduce a caller-supplied tenant, because there is nothing to spread.
 *
 * Scope of that claim, stated as what was measured rather than as an impossibility. Two
 * separate edits, with two different outcomes, both performed:
 *
 * 1. Adding `tenantId: payload.tenantId` **inside** `this.where({...})` is a compile error —
 *    `TS2322, Type 'TenantId' is not assignable to type 'undefined'`, because `where()`'s
 *    parameter is constrained `{ tenantId?: never }`.
 * 2. Dropping `this.where(...)` from the `Event` `create` altogether and writing
 *    `create: { tenantId: payload.tenantId, ... }` **compiles clean**. So the shape is a
 *    guard against one edit, not against every edit, and it is not an impossibility claim.
 *
 * The second edit is caught by **`U58`** (`tests/event.repository.unit.test.ts`) and by
 * **`I21`** (`tests/event.processor.integration.test.ts`), and by nothing else. `U58` asserts
 * the `create` carries the repository's bound tenant while the payload carries a different one;
 * `I21` runs the same divergence against live PostgreSQL as `telemetry_app`, where RLS's
 * `WITH CHECK` rejects the write outright —
 * `42501, new row violates row-level security policy for table "Event"`.
 *
 * An earlier revision of this paragraph named `I19` as the case that fails. It does not, and
 * nothing did: the Gate-4 reviewer wrote edit 2 and the package stayed **126/126 green**,
 * reproduced here. The cause was that no fixture in the package built a repository for a tenant
 * other than the one its payload carried, so the two values were never distinguishable. `U58`
 * and `I21` exist to make them distinguishable and were both confirmed red against that edit
 * before it was reverted.
 *
 * `quantity` is a **string**, not a number, and not a `Prisma.Decimal`. See
 * `WORKER_EVENT_PROCESSING.QUANTITY_PATTERN` for the measurement behind that.
 */
export interface StreamEventRow {
  readonly eventId: string;
  readonly eventType: string;
  readonly quantity: string;
  readonly unit: string;
  readonly occurredAt: Date;
  readonly idempotencyKey: string;
  readonly metadata: Record<string, string> | null;
}

/**
 * The `UsageLine` row derived from the same entry.
 *
 * Derived **here**, in a pure function, rather than in the repository, so that the two Gate-2
 * decisions it encodes stay one expression each:
 *
 * - **D1** — `metricKey` is the bare `eventType`. `docs/epics/epic-7-worker-service.md` says
 *   `${eventType}.${unit}`; three shipped artifacts disagree with it (`prisma/seed.ts`'s
 *   `DEFAULT_METRICS`, `apps/usage-service/tests/integration.fixtures.ts`, and epic-8's
 *   per-`metricKey` `Meter` lookup), and against the live stream the epic's rule yields
 *   `"api.request.request"`, which matches no seeded `Meter` — so every `UsageLine` written
 *   would be unpriceable.
 * - **D2** — both bounds are the event instant. usage-service's summary endpoint buckets with
 *   `DATE_TRUNC(<granularity>, "periodStart")` and supports **hour**, so a calendar-day bucket
 *   written here would collapse every hour bucket to midnight — a behaviour regression in an
 *   endpoint this task does not own. Bucketing stays a query-time concern.
 *
 * No `tenantId`, for the same reason `StreamEventRow` has none.
 */
export interface StreamUsageLineRow {
  readonly metricKey: string;
  readonly quantity: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

/**
 * One stream entry, parsed.
 *
 * `tenantId` sits at the top level rather than inside either row because of what it is *for*:
 * it **selects** the repository from the container factory. The repository is then what writes
 * a tenant id, from its own constructor argument.
 */
export interface StreamEventPayload {
  readonly tenantId: TenantId;
  readonly event: StreamEventRow;
  readonly usageLine: StreamUsageLineRow;
}

/**
 * The envelope, validated.
 *
 * `tenantId` is a **UUID**, not merely a non-empty string — `.claude/rules/tenant-isolation.md`
 * layer 3, and `Tenant.id` is `String @default(uuid())`. The same rule is applied to the same
 * id arriving over HTTP by usage-service's `tenant-context.middleware`; this is the other route
 * in, and it gets the same check rather than trusting that the value came from a service.
 *
 * `quantity` stays a string through `.regex(...)` and is never `z.coerce.number()`.
 * `occurredAt` reuses `@telemetry/shared-validation`'s `iso8601Schema`, which is what the
 * producer validated the same field with, rather than a fourth copy of the rule.
 */
const envelopeSchema = z.object({
  [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_ID]: z.string().uuid(),
  [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.TENANT_ID]: z.string().uuid(),
  [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.EVENT_TYPE]: z.string().min(1),
  [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.QUANTITY]: z
    .string()
    .regex(WORKER_EVENT_PROCESSING.QUANTITY_PATTERN),
  [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.UNIT]: z.string().min(1),
  [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.OCCURRED_AT]: iso8601Schema,
  [WORKER_EVENT_PROCESSING.ENVELOPE_FIELD.IDEMPOTENCY_KEY]: z.string().min(1)
});

/**
 * `[k, v, k, v, ...]` -> `{ k: v }`.
 *
 * Throws on an odd length rather than dropping the dangling key, because the list is
 * positional: a parser that tolerated it would pair every subsequent key with the wrong
 * value and produce a plausible-looking event. `stream.consumer.ts`'s `parseEntry` refuses a
 * malformed entry for the same reason, one layer up.
 *
 * A later duplicate of the same key wins, which is `Object.fromEntries`' behaviour and is not
 * a decision this parser makes — Redis has never been observed to return a duplicate field.
 */
const foldFields = (fields: readonly string[]): Record<string, string> => {
  if (fields.length % WORKER_EVENT_PROCESSING.FIELD_PAIR_STRIDE !== 0) {
    throw new Error(WORKER_EVENT_PROCESSING.ERROR.ODD_FIELD_LIST);
  }

  const record: Record<string, string> = {};
  for (
    let index = 0;
    index < fields.length;
    index += WORKER_EVENT_PROCESSING.FIELD_PAIR_STRIDE
  ) {
    const key = fields[index];
    const value = fields[index + WORKER_EVENT_PROCESSING.FIELD_VALUE_OFFSET];
    // `noUncheckedIndexedAccess` makes both `string | undefined`. The length check above
    // means neither can actually be absent, so this narrowing is for the compiler rather
    // than for a reachable input — and it is a `continue` rather than a cast so that a
    // future change to the stride cannot turn it into a silent `undefined` in a column.
    if (key === undefined || value === undefined) {
      continue;
    }

    record[key] = value;
  }

  return record;
};

/**
 * Every field that is not part of the envelope, or `null` when there are none (D3).
 *
 * The producer does not publish a `metadata` object: it flattens `event.metadata` into sibling
 * top-level stream fields, skipping its own reserved set, and `XADD` stores every value as a
 * string. So this reconstructs the customer's metadata, with one loss that is stated rather
 * than hidden — the original JSON *types* are gone, because the wire has only strings.
 *
 * `null` rather than `{}` for the empty case: the column is `Json?`, and `{}` and "the customer
 * sent nothing" are different facts. The second entry on the live stream carries no metadata,
 * so this is the ordinary case and not a defensive one.
 */
const collectMetadata = (record: Record<string, string>): Record<string, string> | null => {
  const metadata: Record<string, string> = {};
  let found = false;
  for (const [key, value] of Object.entries(record)) {
    if (WORKER_ENVELOPE_FIELD_NAMES.has(key)) {
      continue;
    }

    metadata[key] = value;
    found = true;
  }

  return found ? metadata : null;
};

/**
 * One stream entry's flat field list -> the two rows it becomes.
 *
 * **Throwing is the contract, not a nuisance.** `StreamConsumer.dispatch` catches a handler
 * rejection, logs it against the entry id, and continues the batch without acknowledging — so
 * a message this function rejects stays in the group's pending list. Returning a partial
 * payload, or a default, would mean acknowledging something that was never understood.
 *
 * The consequence is worth naming because it is currently unbounded: a message that can never
 * parse is reclaimed and retried on every worker restart, indefinitely, until T-041 adds retry
 * accounting and a dead-letter destination. That is the epic's stated T-040 behaviour, not an
 * oversight.
 */
export const parseStreamMessage = (fields: readonly string[]): StreamEventPayload => {
  const record = foldFields(fields);
  const parsed = envelopeSchema.safeParse(record);
  if (!parsed.success) {
    throw new Error(WORKER_EVENT_PROCESSING.ERROR.INVALID_MESSAGE);
  }

  const envelope = parsed.data;
  // D-ORM: a `Date` for the ORM to bind. Worker's `withTenant` has no `TimeZone` pin (S-19),
  // so nothing in this service may put a timestamp into raw SQL — `CLAUDE.md` § *Raw SQL and
  // timestamps* has the measurement. `iso8601Schema` has already accepted it, so this is not
  // an `Invalid Date`.
  const occurredAt = new Date(envelope.occurredAt);

  return {
    tenantId: envelope.tenantId as TenantId,
    event: {
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      quantity: envelope.quantity,
      unit: envelope.unit,
      occurredAt,
      idempotencyKey: envelope.idempotencyKey,
      metadata: collectMetadata(record)
    },
    usageLine: {
      // D1 and D2, and the only two places either lives.
      metricKey: envelope.eventType,
      quantity: envelope.quantity,
      periodStart: occurredAt,
      periodEnd: occurredAt
    }
  };
};
